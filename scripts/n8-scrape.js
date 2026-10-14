#!/usr/bin/env node
'use strict';
/**
 * 熊永堂 NUMBER EIGHT 商品 —— 第一阶段：只抓「纯日文」，零翻译、零文本清洗。
 *
 * 取值规则（用户给定）：
 *   商品名称        = 详情页 h2.detail_product_title[itemprop="name"] 的内容
 *   列表页描述      = 详情页 div.main_comment[itemprop="description"] 的内容
 *   点击详情描述    = 详情页 table.material-box 的内容（HTML 原样保留，含原有属性/样式）
 *   价格            = 详情页 #price02_default（或 itemprop="price"），显示格式与晃佑堂一致
 *   分类            = 列表页按 category_id 遍历取归属（详情页没有面包屑，
 *                     只有全站导航链接，无法反映该商品真实归属）
 *
 * 平台是 EC-CUBE：没有 products.json，列表页 /products/list.php?disp_number=N 一次可拿全量。
 *
 * 用法：
 *   node scripts/n8-scrape.js --limit=6        小批量试跑
 *   node scripts/n8-scrape.js                  全量（165 条）
 *   node scripts/n8-scrape.js --no-images      只抓文本
 *   node scripts/n8-scrape.js --ids=147        指定商品
 *   node scripts/n8-scrape.js --fresh          忽略缓存与中间产物
 *
 * 产物：
 *   data/n8-ja.json            全量日文中间产物（翻译阶段的唯一输入）
 *   data/n8-cache/*.html       详情页 HTML 缓存（断点续跑用，可删）
 *   assets/n8/*.{jpg,png}      商品图片
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JA_FILE = path.join(DATA_DIR, 'n8-ja.json');
const HTML_CACHE_DIR = path.join(DATA_DIR, 'n8-cache');
const IMG_DIR = path.join(ROOT, 'assets', 'n8');

const ORIGIN = 'https://www.number-8.net';
const LIST_PATH = '/products/list.php';
const PER_PAGE = 200; // 一次拿全 165 条
const MAX_PAGES = 10;

/** 主分类优先级：越靠前越"具体"，用于把多对多分类收敛成单一下拉值。
 *  化粧筆 出现在 162/165 件商品上，几乎无区分度，因此排在最后。 */
const TYPE_PRIORITY = ['Magnifica', '熊永堂', 'ツール', 'セット', 'その他 熊野筆', '用途別', '化粧筆'];

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

/**
 * 取指定 class 的 <tag> 的 inner HTML，按开闭标签配平。
 *
 * 注意：本站属性**单双引号混用**（实测 137 处双引号 + material-box 用单引号），
 * 所以属性值必须同时接受 ' 与 "，否则会漏掉 <table class='material-box'> 这种写法。
 */
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

/** h2.detail_product_title（名称） */
function extractName(html) {
  const hit = extractTagByClass(html, 'h2', 'detail_product_title');
  return hit ? stripTags(hit.inner) : null;
}

/** div.main_comment（列表页描述） */
function extractMainComment(html) {
  const hit = extractTagByClass(html, 'div', 'main_comment');
  return hit ? hit.inner.trim() : null;
}

/** table.material-box（点击详情描述；整段 HTML 原样保留，含原有属性与样式） */
function extractMaterialBox(html) {
  const hit = extractTagByClass(html, 'table', 'material-box');
  return hit ? hit.outer.trim() : null;
}

/** 价格：与晃佑堂显示格式一致 —— `5,720 日元（含税）` */
function extractPrice(html) {
  const m =
    html.match(/id=(?:"|')price02_default(?:"|')[^>]*>([\d,]+)</i) ||
    html.match(/itemprop=(?:"|')price(?:"|')[^>]*>([\d,]+)</i);
  if (!m) return '价格待确认';
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return '价格待确认';
  return n.toLocaleString('en-US') + ' 日元（含税）';
}

/**
 * 图片：主图 div.photo + 子图 ul.photo_sub。
 * 同一张图在页面里有两份：放大版 href（文件名哈希 A）与显示版 img src（哈希 B），
 * 按「去掉末尾哈希」的基名去重，优先保留放大版。
 */
function extractImages(html) {
  const found = new Map();
  const add = (u) => {
    let url = decodeEntities(u);
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.startsWith('/')) url = ORIGIN + url;
    if (!/\/upload\//i.test(url)) return;
    const file = url.split('?')[0].split('/').pop();
    const key = file.replace(/_[0-9a-f]{8,}(?=\.[a-zA-Z0-9]+$)/i, '');
    if (!found.has(key)) found.set(key, url); // 先出现的优先（主图/放大版在前）
  };
  for (const scope of ['photo', 'photo_sub']) {
    const hit = extractTagByClass(html, scope === 'photo' ? 'div' : 'ul', scope);
    if (!hit) continue;
    for (const m of hit.inner.matchAll(/href=(?:"|')([^"']+)(?:"|')/gi)) add(m[1]);
    for (const m of hit.inner.matchAll(/src=(?:"|')([^"']+)(?:"|')/gi)) add(m[1]);
  }
  return [...found.values()].slice(0, 4);
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

/** 分类一览：category_list.php 的 category_id 链接 */
async function fetchCategories() {
  const html = await fetchText(ORIGIN + '/products/category_list.php');
  const out = [];
  const seen = new Set();
  const re = /category_id=(\d+)[^'"]*['"][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = Number(m[1]);
    const name = stripTags(m[2]);
    if (id && name && !seen.has(id)) {
      seen.add(id);
      out.push({ id, name });
    }
  }
  return out;
}

/** 按分类翻列表页，得到 product_id -> 分类名数组 的归属表 */
async function fetchCategoryOwnership(categories) {
  const owner = new Map();
  let todo = 0;
  for (const c of categories) {
    const ids = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const html = await fetchText(
        ORIGIN + LIST_PATH + '?category_id=' + c.id + '&disp_number=' + PER_PAGE + '&pageno=' + page
      );
      const found = [...html.matchAll(/detail\.php\?product_id=(\d+)/g)].map((x) => x[1]);
      let added = 0;
      for (const id of found) {
        if (!ids.has(id)) {
          ids.add(id);
          added += 1;
        }
      }
      if (added === 0) break;
    }
    console.log('  分类 ' + String(c.id).padStart(3) + ' ' + c.name.padEnd(16) + ' 归属 ' + String(ids.size).padStart(4) + ' 件');
    for (const id of ids) {
      if (!owner.has(id)) owner.set(id, []);
      if (!owner.get(id).includes(c.name)) owner.get(id).push(c.name);
    }
    await sleep(300);
    void todo;
  }
  return owner;
}

/** 列表页商品 id（全站） */
async function fetchAllIds() {
  const ids = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchText(ORIGIN + LIST_PATH + '?disp_number=' + PER_PAGE + '&pageno=' + page);
    const found = [...html.matchAll(/detail\.php\?product_id=(\d+)/g)].map((x) => x[1]);
    let added = 0;
    for (const id of found) {
      if (!ids.has(id)) {
        ids.add(id);
        added += 1;
      }
    }
    console.log('  列表页 ' + page + '：解析 ' + new Set(found).size + ' 条，新增 ' + added + '，累计 ' + ids.size);
    if (added === 0) break;
    await sleep(300);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

/** 多对多分类收敛成单一主分类（下拉用），同时保留全部分类 */
function pickPrimaryType(names) {
  if (!names || !names.length) return '';
  for (const p of TYPE_PRIORITY) if (names.includes(p)) return p;
  return names[0];
}

// ---------------------------------------------------------------- 主流程

async function loadHtmlCached(id) {
  const file = path.join(HTML_CACHE_DIR, id + '.html');
  if (!FRESH && fs.existsSync(file) && fs.statSync(file).size > 2000) {
    return fs.readFileSync(file, 'utf8');
  }
  const html = await fetchText(ORIGIN + '/products/detail.php?product_id=' + id);
  fs.mkdirSync(HTML_CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return html;
}

async function main() {
  console.log('熊永堂 NUMBER EIGHT 抓取 · 阶段一（只取日文，不做任何清洗）');
  console.log('并发：' + CONCURRENCY + '；图片：' + (DO_IMAGES ? '下载' : '跳过'));

  // 1) 分类归属
  console.log('\n[1/3] 分类一览与归属');
  const categories = await fetchCategories();
  console.log('  分类数：' + categories.length + ' -> ' + categories.map((c) => c.name).join('、'));
  const owner = await fetchCategoryOwnership(categories);
  console.log('  归属表覆盖商品：' + owner.size);

  // 2) 商品 id
  console.log('\n[2/3] 枚举商品 id');
  let ids = ONLY_IDS.length ? ONLY_IDS : await fetchAllIds();
  console.log('  共 ' + ids.length + ' 条');
  if (LIMIT > 0) ids = ids.slice(0, LIMIT);

  // 3) 详情页
  console.log('\n[3/3] 抓取详情页（' + ids.length + ' 条）');
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
      const id = ids[index];
      const handle = 'n8-' + id;
      if (existingByHandle.has(handle)) {
        results.push(existingByHandle.get(handle));
        done += 1;
        continue;
      }
      try {
        const html = await loadHtmlCached(id);
        const titleJa = extractName(html);
        if (!titleJa) throw new Error('未能取到 h2.detail_product_title');
        const descJaHtml = extractMainComment(html) || '';
        const detailJaHtml = extractMaterialBox(html) || '';
        const price = extractPrice(html);

        const images = [];
        if (DO_IMAGES) {
          const urls = extractImages(html);
          for (let n = 0; n < urls.length; n++) {
            const rel = 'assets/n8/' + id + '-' + (n + 1) + '.' + imageExt(urls[n]);
            const status = await downloadImage(urls[n], path.join(ROOT, rel.split('/').join(path.sep)));
            if (status === 'saved' || status === 'exists') images.push(rel);
          }
        }

        const categoriesJa = owner.get(id) || [];
        results.push({
          handle,
          itemId: id,
          url: ORIGIN + '/products/detail.php?product_id=' + id,
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
        failures.push({ id, url: ORIGIN + '/products/detail.php?product_id=' + id, error: err.message });
        console.warn('  ! [' + id + '] ' + err.message);
      }
      done += 1;
      if (done % 20 === 0 || done === ids.length) {
        console.log('  进度 ' + done + '/' + ids.length + '（成功 ' + results.length + '，失败 ' + failures.length + '）');
      }
      await sleep(250);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));
  results.sort((a, b) => Number(a.itemId) - Number(b.itemId));

  // 写出
  const store = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    sourceMode: 'ec-cube-detail',
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
  console.log('  缺分类：' + noCat + '；缺列表描述：' + noDesc + '；缺 material-box 详情：' + noDetail + '；无图片：' + noImg + '；失败：' + failures.length);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.slice(0, 20).forEach((f) => console.log('  - ' + f.id + ' ' + f.error));
  }
}

main().catch((err) => {
  console.error('\n抓取失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
