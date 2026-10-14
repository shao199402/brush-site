#!/usr/bin/env node
'use strict';
/**
 * 永豊堂（Eihodo）商品 —— 第一阶段：只抓「纯日文」，零翻译、零文本清洗。
 *
 * 取值规则（用户给定）：
 *   商品名称        = 详情页 h2.style_title02 的内容
 *   列表页描述      = h3.style_title03 **之后**的文本，**到第一个超链接为止，不含超链接本身**
 *   点击详情描述    = 详情页 table.style_table02 的内容（HTML 原样保留，含原有属性/样式）
 *   价格            = table.style_table02 里 tr.price 的「￥15,400（税込）」→ 与晃佑堂同格式
 *   分类            = 按 si 遍历分类页取归属（商品可属多个分类，故保留数组）
 *
 * 站点是自研 PHP 商城：/sp/shopping/?si=<分类>&id=<商品>&p=<页>，无 JSON 接口。
 * 全站共 409 件商品 / 39 个分类页（已实测枚举完毕，8 个分类有翻页）。
 *
 * 用法：
 *   node scripts/eihodo-scrape.js --limit=6            小批量试跑
 *   node scripts/eihodo-scrape.js                      全量（409 条）
 *   node scripts/eihodo-scrape.js --ids=1713400652-990041
 *   node scripts/eihodo-scrape.js --no-images
 *   node scripts/eihodo-scrape.js --fresh
 *
 * 产物：
 *   data/eihodo-ja.json        全量日文中间产物（翻译阶段唯一输入）
 *   data/eihodo-cache/*.html   详情页缓存（断点续跑，可删）
 *   assets/eihodo/*           商品图片
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JA_FILE = path.join(DATA_DIR, 'eihodo-ja.json');
const HTML_CACHE_DIR = path.join(DATA_DIR, 'eihodo-cache');

const ORIGIN = 'https://www.eihodo.jp';
const LIST_PATH = '/sp/shopping/';
const MAX_PAGES = 60;

/**
 * 主分类优先级。
 * 这个站的分类是「按系列」+「按用途」的**多对多**结构（409 个 id 分布在 39 个分类页），
 * 且「今月のおすすめ」「厳選Special」这类是**营销位**而非品类，不能当分类用。
 * 因此主分类只从「有品类含义」的分类里按下面的顺序挑；挑不到才退回营销位名称。
 */
const SPECIFIC_FIRST = [
  'EI-Rシリーズ', 'EI-BKシリーズ', 'PSシリーズ', 'ＷＰシリーズ', 'ＲＥシリーズ',
  'BLシルバーフォックス', 'Ｇシリーズ', '携帯用シリーズ', 'リップブラシシリーズ',
  'Ｋシリーズ', '用途別カテゴリー', 'フォーミング洗顔ブラシ', 'オリジナル ブラシキャップ',
  'ケース類', 'エトセトラ', 'ブラシキャップ', '髪の毛が細かったり', 'ツヤ髪への第一歩',
  '髪に自然なボリューム感', '洋服ブラシ', 'ヘアブラシクリーナー', '薩摩つげぐし',
  '薩摩つげブラシ', '京都東寺のあぶらとり紙', '姉妹品あぶらとり紙', '大師筆',
  'つめきり', 'つめやすり', '耳かき', '毛抜き', '化粧ハサミ', 'ビューラー類',
  'スポンジ/パフ', '天然素材タオル', '雪繭シルクマッサージブラシ', 'メイクブラシギフトセット',
];

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
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1';

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

/** 取指定 class 的 <tag>，按开闭标签配平；返回 inner 与其在原文中的结束位置 */
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
      if (depth === 0) {
        return {
          inner: html.slice(start, m.index),
          outer: html.slice(open.index, tokenRe.lastIndex),
          end: tokenRe.lastIndex,
        };
      }
    } else {
      depth += 1;
    }
  }
  return { inner: html.slice(start), outer: html.slice(open.index), end: html.length };
}

// ---------------------------------------------------------------- 字段提取

/** h2.style_title02（名称） */
function extractName(html) {
  const hit = extractTagByClass(html, 'h2', 'style_title02');
  return hit ? stripTags(hit.inner) : null;
}

/**
 * 列表页描述：h3.style_title03 之后的内容，**在第一个超链接处截断**。
 *
 * 真实结构（以 id=1713400652-990041 为例）：
 *   <h3 class="style_title03">商品説明</h3>
 *   <p>…产品说明…<br />…<br /><br />ブラシキャップＳＷＳ－３
 *      <a href="...">（赤）</a>or<a href="...">（黒）</a>をお勧めいたします。</p>
 * 站方在描述尾部统一挂了模板化的推荐链接，按用户规则要**在这些链接之前截断**。
 */
function extractDescHtml(html) {
  const h3 = extractTagByClass(html, 'h3', 'style_title03');
  if (!h3) return null;
  const after = html.slice(h3.end);
  const pMatch = /^\s*<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(after);
  if (!pMatch) return null;
  const inner = pMatch[1];
  const cut = inner.split(/<a\b/i)[0]; // 到第一个超链接为止，不含超链接
  return cut.replace(/\s+$/, '').trim();
}

/** table.style_table02（点击详情描述；整段 HTML 原样保留） */
function extractSpecTable(html) {
  const hit = extractTagByClass(html, 'table', 'style_table02');
  return hit ? hit.outer.trim() : null;
}

/**
 * 价格：table.style_table02 里 `<tr class="price"><th>価格</th><td>￥15,400（税込）</td></tr>`
 * 显示格式与晃佑堂一致 —— `15,400 日元（含税）`
 */
function extractPrice(html) {
  const tbl = extractTagByClass(html, 'table', 'style_table02');
  const scope = tbl ? tbl.inner : html;
  const m =
    scope.match(/<tr[^>]*class=(?:"[^"]*\bprice\b[^"]*"|'[^']*\bprice\b[^']*')[^>]*>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i) ||
    scope.match(/([￥¥]\s*[\d,]+)/);
  if (!m) return '价格待确认';
  const num = String(m[1]).replace(/[^\d]/g, '');
  const n = Number(num);
  if (!Number.isFinite(n) || !num) return '价格待确认';
  return n.toLocaleString('en-US') + ' 日元（含税）';
}

/** 图片：商品图目录 product_img/<id>_N.jpg（同图带/不带 ?r= 查询串，需去重） */
function extractImages(html, itemId) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<img[^>]+src=(?:"([^"]+)"|'([^']+)')/gi)) {
    let url = decodeEntities(m[1] || m[2]);
    const clean = url.split('?')[0];
    if (!/product_img\//i.test(clean)) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    if (clean.startsWith('//')) url = 'https:' + clean;
    else if (/^https?:/i.test(clean)) url = clean;
    else url = new URL(clean, ORIGIN + '/sp/shopping/').href;
    out.push(url);
  }
  return out.slice(0, 6);
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

// ---------------------------------------------------------------- 枚举与分类

/**
 * 翻页终止判断（实测的站方标记）：
 *   有下一页： <li class="btn_next"><a href="./?si=…&p=N">次へ</a>
 *   无下一页： <li class="btn_next">&nbsp;
 * 另外站方对超出真实页数的 p 会返回「ただいま準備中のため…」占位页，没有任何商品链接，也必须停。
 *
 * 注意：**不能**用「本页没有新增 id 就停」来判断——同一商品会出现在多个分类里，
 * 一页的商品可能与已收集的完全重复，那样会提前终止并漏掉后面的页（实测会少 11 件）。
 */
function hasNextPage(html) {
  return /<li[^>]*class=(?:"[^"]*btn_next[^"]*"|'[^']*btn_next[^']*')[^>]*>\s*<a\b/i.test(html);
}

const LIST_CACHE_DIR = path.join(DATA_DIR, 'eihodo-list-cache');

/** 取一页列表页（带磁盘缓存：同一 URL 只真正请求一次，便于反复核对计数而不打站方） */
async function fetchListPage(url) {
  const key = url.replace(/[^a-z0-9]+/gi, '_') + '.html';
  const file = path.join(LIST_CACHE_DIR, key);
  if (!FRESH && fs.existsSync(file) && fs.statSync(file).size > 2000) {
    return fs.readFileSync(file, 'utf8');
  }
  const html = await fetchText(ORIGIN + url);
  fs.mkdirSync(LIST_CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return html;
}

/** 分类页 si 列表 + 名称（取自首页导航） */
async function fetchCategories() {
  const html = await fetchListPage(LIST_PATH);
  const ids = [];
  const seen = new Set();
  let m;
  const idRe = /[?&]si=(\d+-\d+)[^'"]*['"]/gi;
  while ((m = idRe.exec(html))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  const nameById = new Map();
  const nameRe = /[?&]si=(\d+-\d+)[^'"]*['"][^>]*>([\s\S]{0,140}?)<\/a>/gi;
  let n;
  while ((n = nameRe.exec(html))) {
    const t = stripTags(n[2]);
    if (t && !nameById.has(n[1])) nameById.set(n[1], t);
  }
  return ids.map((id) => ({ id, name: nameById.get(id) || id }));
}

/** 遍历全部分类页：返回商品 id 列表 + 每个商品所属分类 */
async function enumerateAll(categories) {
  const owner = new Map();
  const allIds = new Set();
  let pages = 0;
  for (const c of categories) {
    const ids = new Set();
    let lastPage = 0;
    for (let p = 1; p <= MAX_PAGES; p++) {
      const html = await fetchListPage(LIST_PATH + '?si=' + c.id + (p > 1 ? '&p=' + p : ''));
      pages += 1;
      lastPage = p;
      const found = [...new Set([...html.matchAll(/[?&]id=(\d+-\d+)/g)].map((x) => x[1]))];
      for (const id of found) ids.add(id);
      if (found.length === 0 || !hasNextPage(html)) break;
      await sleep(150);
    }
    console.log(
      '  分类 ' + c.name.slice(0, 28).padEnd(30) + ' ' + String(lastPage).padStart(2) + ' 页  归属 ' + String(ids.size).padStart(4) + ' 件'
    );
    for (const id of ids) {
      if (!owner.has(id)) owner.set(id, []);
      if (!owner.get(id).includes(c.name)) owner.get(id).push(c.name);
    }
    for (const id of ids) allIds.add(id);
    await sleep(120);
  }
  console.log('  合计分类页：' + pages + ' 页');
  return { owner, ids: [...allIds].sort() };
}

/** 多对多分类 → 单一主分类（下拉用） */
function pickPrimaryType(names) {
  if (!names || !names.length) return '';
  for (const key of SPECIFIC_FIRST) {
    const hit = names.find((n) => n.includes(key));
    if (hit) return hit;
  }
  return names[0];
}

// ---------------------------------------------------------------- 主流程

async function loadHtmlCached(itemId) {
  const file = path.join(HTML_CACHE_DIR, itemId + '.html');
  if (!FRESH && fs.existsSync(file) && fs.statSync(file).size > 2000) {
    return fs.readFileSync(file, 'utf8');
  }
  const html = await fetchText(ORIGIN + LIST_PATH + '?id=' + itemId);
  fs.mkdirSync(HTML_CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return html;
}

async function main() {
  console.log('永豊堂 Eihodo 抓取 · 阶段一（只取日文，不做任何清洗）');
  console.log('并发：' + CONCURRENCY + '；图片：' + (DO_IMAGES ? '下载' : '跳过'));

  console.log('\n[1/2] 枚举分类与商品 id（一次遍历同时得到分类归属）');
  const categories = await fetchCategories();
  console.log('  分类页数：' + categories.length);
  const enumResult = ONLY_IDS.length ? { owner: new Map(), ids: [] } : await enumerateAll(categories);
  let ids = ONLY_IDS.length ? ONLY_IDS : enumResult.ids;
  const owner = enumResult.owner;
  console.log('  唯一商品 id：' + ids.length);
  if (LIMIT > 0) ids = ids.slice(0, LIMIT);

  console.log('\n[2/2] 抓取详情页（' + ids.length + ' 条）');
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
      const handle = 'eihodo-' + itemId;
      if (existingByHandle.has(handle)) {
        results.push(existingByHandle.get(handle));
        done += 1;
        continue;
      }
      try {
        const html = await loadHtmlCached(itemId);
        const titleJa = extractName(html);
        if (!titleJa) throw new Error('未能取到 h2.style_title02');
        const descJaHtml = extractDescHtml(html) || '';
        const detailJaHtml = extractSpecTable(html) || '';
        const price = extractPrice(html);

        const images = [];
        if (DO_IMAGES) {
          const urls = extractImages(html, itemId);
          for (let n = 0; n < urls.length; n++) {
            const rel = 'assets/eihodo/' + itemId + '-' + (n + 1) + '.' + imageExt(urls[n]);
            const status = await downloadImage(urls[n], path.join(ROOT, rel.split('/').join(path.sep)));
            if (status === 'saved' || status === 'exists') images.push(rel);
          }
        }

        const categoriesJa = owner.get(itemId) || [];
        results.push({
          handle,
          itemId,
          url: ORIGIN + LIST_PATH + '?id=' + itemId,
          titleJa,
          categoriesJa,
          categoryJa: pickPrimaryType(categoriesJa),
          price,
          images,
          descJaHtml,
          detailJaHtml,
          scrapedAt: new Date().toISOString(),
        });
      } catch (err) {
        failures.push({ id: itemId, error: err.message });
        console.warn('  ! [' + itemId + '] ' + err.message);
      }
      done += 1;
      if (done % 25 === 0 || done === ids.length) {
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
    sourceMode: 'eihodo-php-shop',
    categories: categories.map((c) => c.name),
    count: results.length,
    products: results,
    failures,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = JA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, JA_FILE);

  const noCat = results.filter((p) => !p.categoryJa).length;
  const noDesc = results.filter((p) => !p.descJaHtml).length;
  const noDetail = results.filter((p) => !p.detailJaHtml).length;
  const noImg = results.filter((p) => !p.images.length).length;
  console.log('\n  ' + path.relative(ROOT, JA_FILE) + '：' + results.length + ' 条');
  console.log('  缺分类：' + noCat + '；缺列表描述：' + noDesc + '；缺规格表：' + noDetail + '；无图片：' + noImg + '；失败：' + failures.length);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.slice(0, 20).forEach((f) => console.log('  - ' + f.id + ' ' + f.error));
  }
}

main().catch((err) => {
  console.error('\n抓取失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
