#!/usr/bin/env node
'use strict';
/**
 * 晃佑堂（KOYUDO）商品 —— 第一阶段：只抓「纯日文」，零翻译、零文本清洗。
 *
 * 这是**重整现有模块**（不是新增）：产物仍是 koyudo-data.js 与 koyudo.html，
 * handle 仍是 koyudo-<12位商品号>（保持与既有数据一致）。
 *
 * 取值规则（用户给定，样例 https://www.koyudo.co.jp/view/item/000000000634?category_page_id=all_items）：
 *   商品名称      = 详情页 h2.c-detailitem__info-name 的内容
 *   列表页描述    = 详情页 div.c-detailitem__info-txt 的内容（HTML 原样保留，含原有样式）
 *   点击详情描述  = 详情页 div.c-detailitem__discripstion2 的内容（HTML 原样保留含原有样式），
 *                   **若其中含超链接则不显示**（整块置空）
 *   价格          = span[data-id="makeshop-item-price:1"] 的数值，格式保持不变：
 *                   「10,780 日元（含税）」
 *   分类          = 该站只有 all_items 单一分类页，无可保留的分类 taxonomy，
 *                   因此 type 沿用既有值「晃佑堂商品」，不破坏现有模块
 *
 * 站点是 MakeShop：翻页地址为 /view/category/all_items?page=N（每页 40），
 * 官网自己声明「全278件中」，实测 7 页取全 278 件。
 *
 * 用法：
 *   node scripts/koyudo-scrape.js --limit=6
 *   node scripts/koyudo-scrape.js                       全量 278 条
 *   node scripts/koyudo-scrape.js --no-images
 *   node scripts/koyudo-scrape.js --ids=000000000634
 *   node scripts/koyudo-scrape.js --fresh
 *
 * 产物：
 *   data/koyudo-ja.json         全量日文中间产物（翻译阶段唯一输入）
 *   data/koyudo-cache/*.html    详情页缓存（断点续跑，可删）
 *   assets/koyudo/*             商品图片
 */

const fs = require('fs');
const path = require('path');
const { balanceFragment, regionUntilMarker, tagBalance } = require('./lib-html.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JA_FILE = path.join(DATA_DIR, 'koyudo-ja.json');
const HTML_CACHE_DIR = path.join(DATA_DIR, 'koyudo-cache');
const LIST_CACHE_DIR = path.join(DATA_DIR, 'koyudo-list-cache');

const ORIGIN = 'https://www.koyudo.co.jp';
const ALL_ITEMS = '/view/category/all_items';
const PER_PAGE = 40;
const MAX_PAGES = 30;
/** type 沿用既有值：该站没有可保留的分类体系 */
const TYPE_JA = '晃佑堂商品';

/**
 * 该商品「点击详情」区块的右边界候选。
 * discripstion2 **没有**配对的结束注释，只能靠它之后必然出现的站方区块注释/页脚截断。
 * 注意标记必须写成**完整注释**（含 `<!--` 与 `-->`），否则会匹配到注释内部的子串，
 * 导致结果尾部留下半个 `<!--`。
 */
const D2_STOP_MARKERS = [
  '<!-- c-detailitem -->',
  '<!-- レビュー -->',
  '<div class="l-footer',
  '<!-- //.c-detailitem__info -->',
];

/**
 * 去掉片段尾部未闭合的注释起始符。
 * 原因：`<!-- xxx -->` 这类标记若只截到内部，尾部会留半个 `<!--`；
 * 而翻译阶段会移除**完整**注释（`<!--...-->`），不会移除半个，
 * 于是产物里会出现无闭合的注释碎片（实测 444 个 `<!--` 对 0 个 `-->`）。
 * 丢掉 `<!--` 可能连带丢掉它前面未闭合标签的收尾，由 balanceFragment 负责补齐。
 */
function trimDanglingComment(seg) {
  const s = String(seg == null ? '' : seg);
  const i = s.lastIndexOf('<!--');
  if (i === -1) return s;
  return s.indexOf('-->', i) === -1 ? s.slice(0, i) : s;
}

/** 价格特征：出现即视为「价格及其以下」的起点 */
const PRICE_RE = /(価格\s*[:：]|￥|¥|c-detailitem__info-price|\d[\d,]*\s*円)/i;
/** 超链接 / 购物车字样：命中则该段不显示（用户规则，info-txt 与 discripstion2 两边都适用） */
const LINK_RE = /<a\b/i;
const CART_RE = /カート|買い物|ショッピング/;

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
function argValue(name) {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
const LIMIT = Number(argValue('--limit') || 0);
const DO_IMAGES = argValue('--no-images') === undefined;
const FRESH = argValue('--fresh') !== undefined;
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency') || 3));
const ONLY_IDS = String(argValue('--ids') || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- 基础工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchText(url, { tries = 4, timeout = 45000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja-JP,ja;q=0.9' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      const text = await res.text();
      if (!text || text.length < 200) throw new Error('响应过短（' + (text || '').length + ' 字节）');
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(700 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function decodeEntities(input) {
  return String(input == null ? '' : input)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html == null ? '' : html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 取指定 class 的 <tag> 的 inner HTML，按开闭标签配平（本站属性单双引号混用，两种都接受） */
function extractTagByClass(html, tagName, className) {
  const openRe = new RegExp(
    '<' + tagName + '\\b[^>]*class=(?:"[^"]*\\b' + className + '\\b[^"]*"|\'[^\']*\\b' + className + '\\b[^\']*\')[^>]*>',
    'i'
  );
  const open = openRe.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const tokenRe = new RegExp('<' + tagName + '\\b[^>]*>|</' + tagName + '\\s*>', 'gi');
  tokenRe.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tokenRe.exec(html))) {
    if (m[0].charAt(1) === '/') {
      depth -= 1;
      if (depth === 0) return { inner: html.slice(start, m.index), outer: html.slice(open.index, tokenRe.lastIndex) };
    } else {
      depth += 1;
    }
  }
  return { inner: html.slice(start), outer: html.slice(open.index) };
}

// ---------------------------------------------------------------- 字段提取

/** h2.c-detailitem__info-name */
function extractName(html) {
  const hit = extractTagByClass(html, 'h2', 'c-detailitem__info-name');
  return hit ? stripTags(hit.inner) : null;
}

/** div.c-detailitem__info-txt 的原文（以站方结束注释为右边界，并清掉尾部的半个注释） */
function infoTxtRaw(html) {
  const a = html.indexOf('class="c-detailitem__info-txt"');
  if (a === -1) return null;
  const start = html.indexOf('>', a);
  const b = html.indexOf('//.c-detailitem__info-txt', start + 1);
  return trimDanglingComment(html.slice(start + 1, b === -1 ? html.length : b));
}

/**
 * 列表页描述 desc（用户更正后的规则）：
 *   取 info-txt 中 **table 之前的纯文字部分**（含其原有 style 标签）；
 *   若无 table，则取**价格之前的**内容；
 *   若既无 table 也无价格，则**整段显示**。
 * 结果一律用 balanceFragment 修正成自配平片段，避免详情页错版。
 */
function buildDesc(raw) {
  if (raw == null) return { html: '', note: 'missing' };
  const tm = /<table\b[^>]*>/i.exec(raw);
  if (tm) return { html: balanceFragment(raw.slice(0, tm.index)).html.trim(), note: 'before-table' };
  const pm = PRICE_RE.exec(raw);
  if (pm) return { html: balanceFragment(raw.slice(0, pm.index)).html.trim(), note: 'before-price(no-table)' };
  return { html: balanceFragment(raw).html.trim(), note: 'whole(no-table-no-price)' };
}

/**
 * 点击详情 detailHtml（用户更正后的规则）：
 *   A = info-txt 中「价格及其以下」之前的部分（含 table；无价格则整段）
 *   B = div.c-detailitem__discripstion2 的内容（含 table 要显示；无 table 也保留原文 style）
 *   合并 A + B。
 *
 * 用户确认：**超链接 / 「购物车」字样两边都适用** —— A 或 B 命中则该段不显示。
 * 实测：info-txt 含链接 26 件、d2 含链接 31 件、d2 含"カート"等 50 件。
 */
function buildDetail(html, raw) {
  const parts = [];
  const notes = [];
  if (raw == null) notes.push('infoTxt-missing');
  else {
    const pm = PRICE_RE.exec(raw);
    const a = pm ? raw.slice(0, pm.index) : raw;
    if (!a.trim()) notes.push('infoTxt-empty');
    else if (LINK_RE.test(a)) notes.push('infoTxt-has-link->skip');
    else if (CART_RE.test(a)) notes.push('infoTxt-has-cart->skip');
    else {
      parts.push(balanceFragment(a).html.trim());
      notes.push(pm ? 'infoTxt-up-to-price' : 'infoTxt-whole');
    }
  }

  const d2Raw = regionUntilMarker(html, 'class="c-detailitem__discripstion2"', D2_STOP_MARKERS);
  const d2Clean = d2Raw === null ? null : trimDanglingComment(d2Raw);
  if (d2Clean === null) notes.push('d2-missing');
  else if (LINK_RE.test(d2Clean)) notes.push('d2-has-link->skip');
  else if (CART_RE.test(d2Clean)) notes.push('d2-has-cart->skip');
  else {
    const b = balanceFragment(d2Clean);
    if (b.html.trim()) {
      parts.push(b.html.trim());
      notes.push('d2-kept' + (/<table/i.test(d2Clean) ? '(table)' : ''));
    } else notes.push('d2-empty');
  }
  return { html: parts.filter(Boolean).join('\n'), notes: notes.join('+') };
}

/** 价格：span[data-id="makeshop-item-price:1"] → 保持既有显示格式 `10,780 日元（含税）` */
function extractPrice(html) {
  const m =
    html.match(/data-id=(?:"makeshop-item-price:1"|'makeshop-item-price:1')[^>]*>([\d,]+)</i) ||
    html.match(/data-id=(?:"makeshop-item-price:\d+"|'makeshop-item-price:\d+')[^>]*>([\d,]+)</i);
  if (!m) return '价格待确认';
  const n = Number(String(m[1]).replace(/,/g, ''));
  if (!Number.isFinite(n)) return '价格待确认';
  return n.toLocaleString('en-US') + ' 日元（含税）';
}

/**
 * 图片：只取商品图容器内（div.c-detailitem__img-l 优先，退回 img-thumb / img）。
 * 全页扫描会把 logo 与 28 个 UI 图标当成商品图（实测 634 页共 31 张图，仅 2 张是商品图）。
 * 同一张图会重复出现（大图与缩略图），按去掉查询串后的 URL 去重。
 */
function extractImages(html) {
  let scope = null;
  for (const cls of ['c-detailitem__img-l', 'c-detailitem__img-thumb', 'c-detailitem__img']) {
    const hit = extractTagByClass(html, 'div', cls);
    if (hit && /<img/i.test(hit.inner)) {
      scope = hit.inner;
      break;
    }
  }
  if (!scope) return [];
  const seen = new Set();
  const out = [];
  for (const m of scope.matchAll(/<img[^>]+src=(?:"([^"]+)"|'([^']+)')/gi)) {
    let url = decodeEntities(m[1] || m[2]).split('?')[0];
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = ORIGIN + url;
    if (!/makeshop-multi-images|itemimages|shopimages/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out.slice(0, 8);
}

function imageExt(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-zA-Z0-9]+)$/);
    return (m ? m[1] : 'jpg').toLowerCase();
  } catch {
    return 'jpg';
  }
}

async function downloadImage(remote, absPath) {
  try {
    if (fs.existsSync(absPath) && fs.statSync(absPath).size > 1000) return 'exists';
  } catch {
    /* ignore */
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(remote, { headers: { 'User-Agent': UA }, signal: controller.signal });
    if (!res.ok) return 'http ' + res.status;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return 'too small (' + buf.length + 'b)';
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buf);
    return 'saved';
  } catch (err) {
    return 'error ' + err.message;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 枚举

/** 分类列表页（带磁盘缓存），返回 { html, declared } */
async function fetchListPage(page, useCache = true) {
  const url = page === 1 ? ALL_ITEMS : ALL_ITEMS + '?page=' + page;
  const key = 'all_items_p' + page + '.html';
  const file = path.join(LIST_CACHE_DIR, key);
  if (useCache && !FRESH && fs.existsSync(file) && fs.statSync(file).size > 2000) {
    return fs.readFileSync(file, 'utf8');
  }
  const html = await fetchText(ORIGIN + url);
  fs.mkdirSync(LIST_CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return html;
}

/** 全站商品 id：官网声明「全N件中」，逐页翻到取满或空页 */
async function fetchAllIds() {
  const ids = new Set();
  let declared = null;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const html = await fetchListPage(p);
    if (p === 1) {
      const m = html.match(/全\s*([\d,]+)\s*件中/);
      declared = m ? Number(m[1].replace(/,/g, '')) : null;
      console.log('  官网声明总数：' + declared);
    }
    const found = [...html.matchAll(/view\/item\/(\d{12})/g)].map((x) => x[1]);
    let added = 0;
    for (const id of found) {
      if (!ids.has(id)) {
        ids.add(id);
        added += 1;
      }
    }
    console.log('  第 ' + p + ' 页：本页 ' + String(new Set(found).size).padStart(3) + '，新增 ' + String(added).padStart(3) + '，累计 ' + ids.size);
    if (found.length === 0 || added === 0) break;
    if (declared !== null && ids.size >= declared) break;
    await sleep(250);
  }
  return { ids: [...ids].sort(), declared };
}

// ---------------------------------------------------------------- 主流程

async function loadHtmlCached(id) {
  const file = path.join(HTML_CACHE_DIR, id + '.html');
  if (!FRESH && fs.existsSync(file) && fs.statSync(file).size > 2000) {
    return fs.readFileSync(file, 'utf8');
  }
  const html = await fetchText(ORIGIN + '/view/item/' + id + '?category_page_id=all_items');
  fs.mkdirSync(HTML_CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return html;
}

async function main() {
  console.log('晃佑堂 KOYUDO 抓取 · 阶段一（重整现有模块；只取日文，不做任何清洗）');
  console.log('并发：' + CONCURRENCY + '；图片：' + (DO_IMAGES ? '下载' : '跳过'));

  console.log('\n[1/3] 枚举商品 id');
  let ids;
  if (ONLY_IDS.length) {
    ids = ONLY_IDS;
    console.log('  按 --ids 指定 ' + ids.length + ' 条');
  } else {
    const res = await fetchAllIds();
    ids = res.ids;
    console.log('  唯一商品 id：' + ids.length + '（官网声明 ' + res.declared + '）');
    if (res.declared !== null && ids.length !== res.declared) {
      console.warn('  ! 与官网声明不一致，请检查分页');
    }
  }
  if (LIMIT > 0) ids = ids.slice(0, LIMIT);

  console.log('\n[2/3] 抓取详情页（' + ids.length + ' 条）');
  const existing = FRESH
    ? null
    : (() => {
        try {
          return JSON.parse(fs.readFileSync(JA_FILE, 'utf8'));
        } catch {
          return null;
        }
      })();
  const existingByHandle = new Map(
    existing && Array.isArray(existing.products) ? existing.products.map((p) => [p.handle, p]) : []
  );
  if (existingByHandle.size) console.log('  已有中间产物：' + existingByHandle.size + ' 条（命中则复用）');

  const results = [];
  const failures = [];
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= ids.length) return;
      const itemId = ids[index];
      const handle = 'koyudo-' + itemId;
      if (existingByHandle.has(handle)) {
        results.push(existingByHandle.get(handle));
        done += 1;
        continue;
      }
      try {
        const html = await loadHtmlCached(itemId);
        const titleJa = extractName(html);
        if (!titleJa) throw new Error('未能取到 h2.c-detailitem__info-name');
        const raw = infoTxtRaw(html);
        const desc = buildDesc(raw);
        const detail = buildDetail(html, raw);
        const descJaHtml = desc.html;
        const detailJaHtml = detail.html;
        const price = extractPrice(html);

        const images = [];
        if (DO_IMAGES) {
          const urls = extractImages(html);
          for (let n = 0; n < urls.length; n++) {
            const rel = 'assets/koyudo/' + itemId + '-' + (n + 1) + '.' + imageExt(urls[n]);
            const status = await downloadImage(urls[n], path.join(ROOT, rel.split('/').join(path.sep)));
            if (status === 'saved' || status === 'exists') images.push(rel);
          }
        }

        results.push({
          handle,
          itemId,
          url: ORIGIN + '/view/item/' + itemId + '?category_page_id=all_items',
          titleJa,
          categoriesJa: [TYPE_JA],
          categoryJa: TYPE_JA,
          price,
          images,
          descJaHtml,
          detailJaHtml,
          descSource: desc.note,
          detailSource: detail.notes,
          scrapedAt: new Date().toISOString(),
        });
      } catch (err) {
        failures.push({ id: itemId, error: err.message });
        console.warn('  ! [' + itemId + '] ' + err.message);
      }
      done += 1;
      if (done % 20 === 0 || done === ids.length) {
        console.log('  进度 ' + done + '/' + ids.length + '（成功 ' + results.length + '，失败 ' + failures.length + '）');
      }
      await sleep(200);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));
  results.sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));

  const store = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    sourceMode: 'makeshop-detail',
    declaredTotal: null,
    categories: [TYPE_JA],
    count: results.length,
    products: results,
    failures,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = JA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, JA_FILE);

  const noDesc = results.filter((p) => !p.descJaHtml).length;
  const noDetail = results.filter((p) => !p.detailJaHtml).length;
  const hasDetail = results.filter((p) => p.detailJaHtml).length;
  const noImg = results.filter((p) => !p.images.length).length;
  const tally = (key) => {
    const o = {};
    for (const p of results) o[p[key] || '?'] = (o[p[key] || '?'] || 0) + 1;
    return o;
  };

  console.log('\n[3/3] 写出');
  console.log('  ' + path.relative(ROOT, JA_FILE) + '：' + results.length + ' 条');
  console.log('  空列表描述：' + noDesc + '；空点击详情：' + noDetail + '（有内容 ' + hasDetail + '）；无图片：' + noImg + '；失败：' + failures.length);
  console.log('  列表描述来源：' + JSON.stringify(tally('descSource')));
  console.log('  点击详情来源：' + JSON.stringify(tally('detailSource')));

  // 违规泄漏自检（价格 / 购物车 / 超链接 都不应残留在 detailHtml）
  const leakPrice = results.filter((p) => /価格\s*[:：]|c-detailitem__info-price|data-id="makeshop-item-price/.test(p.detailJaHtml)).length;
  const leakCart = results.filter((p) => CART_RE.test(p.detailJaHtml)).length;
  const leakLink = results.filter((p) => LINK_RE.test(p.detailJaHtml)).length;
  console.log('  泄漏自检（应全为 0）— 价格 ' + leakPrice + ' / 购物车 ' + leakCart + ' / 超链接 ' + leakLink);

  // 标签配平自检
  let unbalanced = 0;
  for (const p of results) {
    if (tagBalance(p.detailJaHtml).length || tagBalance(p.descJaHtml).length) unbalanced++;
  }
  console.log('  标签不配平商品数（应为 0）：' + unbalanced);

  // 未闭合注释自检：翻译阶段只移除完整注释，半个 `<!--` 会留在产物里，必须源头清零
  const halfComment = (s) => {
    const t = String(s || '');
    const i = t.lastIndexOf('<!--');
    return i !== -1 && t.indexOf('-->', i) === -1;
  };
  const halfCount = results.filter((p) => halfComment(p.detailJaHtml) || halfComment(p.descJaHtml)).length;
  console.log('  含未闭合注释的商品数（应为 0）：' + halfCount);

  if (failures.length) {
    console.log('\n失败清单：');
    failures.slice(0, 20).forEach((f) => console.log('  - ' + f.id + ' ' + f.error));
  }
}

main().catch((err) => {
  console.error('\n抓取失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
