#!/usr/bin/env node
'use strict';
/**
 * 竹田ブラシ製作所（Takeda Brush）商品 —— 第一阶段：只抓「纯日文」。
 *
 * 取值规则（用户给定）：
 *   商品名称 = 详情页 h2.item-detail-name 的内容
 *   详情描述 = 详情页 div.item-detail-txt1.wysiwyg-data 的内容（inner HTML，结构原样保留）
 *   价格     = 详情页 span.item-detail-vari-price-num，显示格式与晃佑堂一致
 *   分类     = 详情页 div.item-detail-category（用于站内「分类搜索」）
 *
 * 与白凤堂一致的原则：这一阶段**不做任何文本清洗、不删假名**，翻译全部留给第二阶段。
 *
 * 站点与白凤堂/晃佑堂不同：这是 raku-uru 商城，没有 products.json 接口，
 * 只能翻商品列表页（每页 100 条）拿 item id，再逐条抓详情页。
 *
 * 用法：
 *   node scripts/takeda-scrape.js --limit=6            # 小批量试跑
 *   node scripts/takeda-scrape.js                       # 全量（370 条）
 *   node scripts/takeda-scrape.js --no-images           # 只抓文本
 *   node scripts/takeda-scrape.js --fresh               # 忽略缓存与中间产物，从头抓
 *   node scripts/takeda-scrape.js --concurrency=3
 *
 * 产物：
 *   data/takeda-ja.json          全量日文中间产物（翻译阶段的唯一输入）
 *   data/takeda-cache/*.html     详情页 HTML 缓存（断点续跑用，可安全删除）
 *   assets/takeda/*.{jpg,png}    商品图片
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JA_FILE = path.join(DATA_DIR, 'takeda-ja.json');
const HTML_CACHE_DIR = path.join(DATA_DIR, 'takeda-cache');
const IMG_DIR = path.join(ROOT, 'assets', 'takeda');

const ORIGIN = 'https://takeda-brush-shop.com';
const LIST_URL = ORIGIN + '/item-list';
const PER_PAGE = 100;
const MAX_PAGES = 40;

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
const ONLY_IDS = String(argValue('--ids') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja-JP,ja;q=0.9',
        },
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
  return decodeEntities(String(html == null ? '' : html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 取指定 class 的 <tag> 的 inner HTML，按开闭标签配平。
 * 竹田的 div.item-detail-txt1 内部还有嵌套 div，正则截到第一个 </div> 会截断，
 * 所以必须真正配平。
 */
function extractTagByClass(html, tagName, className) {
  const openRe = new RegExp('<' + tagName + '\\b[^>]*class="[^"]*\\b' + className + '\\b[^"]*"[^>]*>', 'i');
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

/** h2.item-detail-name */
function extractName(html) {
  const hit = extractTagByClass(html, 'h2', 'item-detail-name');
  return hit ? stripTags(hit.inner) : null;
}

/** div.item-detail-txt1.wysiwyg-data */
function extractDetailHtml(html) {
  const hit = extractTagByClass(html, 'div', 'item-detail-txt1');
  if (!hit) return null;
  return sanitizeDetailHtml(hit.inner.trim());
}

/**
 * 去掉源站自己损坏的内联样式。
 *
 * 竹田的商品详情是从别处（Looks 系编辑器）粘贴来的，站方给几乎每个 div 都带上了
 * `style="margin: 0px; padding: 0px; box-sizing: border-box; ... font-family: 游ゴシック, ...`
 * 这一长串样式；而且在 font-family 处**属性被截断、连闭合引号都没有**。
 * 实测一个商品 15928 字节里有 12569 字节（79%）是这种样式，最大的一个商品光样式就有 12KB。
 *
 * 这些声明里只有开头的 margin/padding 清零是有效的，后面的 box-sizing / overflow-wrap /
 * word-break / color / background-color 等都以分号分隔但**缺少结尾分号**，
 * 按 CSS 规范会在解析时被丢弃。也就是说这串样式既冗余又本来就无意义。
 *
 * 只删这一种样式的属性值本身，不动标签、不动文本、不动别的属性：
 * 实测纯文本一字不差（长度与内容完全一致），只是不再携带那串无效样式。
 */
function sanitizeDetailHtml(html) {
  return String(html == null ? '' : html).replace(/\s+style="margin:\s*0px;\s*padding:\s*0px;[^"]*"/g, '');
}

/** div.item-detail-category（分类，用于站内分类搜索） */
function extractCategory(html) {
  const hit = extractTagByClass(html, 'div', 'item-detail-category');
  return hit ? stripTags(hit.inner) : null;
}

/** 价格：与晃佑堂显示格式一致 —— `15,400 日元（含税）` */
function extractPrice(html) {
  const hit = extractTagByClass(html, 'span', 'item-detail-vari-price-num');
  const raw = hit ? stripTags(hit.inner) : '';
  const m = raw.replace(/,/g, '').match(/(\d+)/);
  if (!m) return '价格待确认';
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return '价格待确认';
  return n.toLocaleString('en-US') + ' 日元（含税）';
}

/**
 * 图片：只取商品图容器内的图片。
 *
 * 详情页全页扫描会混进站标（/01/27002/147/logo...）与 UI 图标（/cms/.../icn-*.png），
 * 因此必须先缩到 div.item-detail-thumb（缩略图列表）里，再退化到 div.item-detail-photo-main。
 *
 * 同一张图会同时出现 _1200 与 _400 两种尺寸，按「去掉尺寸后缀的文件名」去重，优先 _1200。
 */
function extractImages(html) {
  let scope = null;
  for (const cls of ['item-detail-thumb', 'item-detail-photo-main']) {
    const hit = extractTagByClass(html, 'div', cls);
    if (hit && /<img/i.test(hit.inner)) {
      scope = hit.inner;
      break;
    }
  }
  if (!scope) return [];

  const found = new Map(); // key: 尺寸无关的文件名
  const re = /<img[^>]+src="([^"]+)"/gi;
  let m;
  while ((m = re.exec(scope))) {
    let url = decodeEntities(m[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.startsWith('/')) url = ORIGIN + url;
    if (!/^https?:\/\/image\.raku-uru\.jp\//i.test(url)) continue;
    if (/\/cms\//i.test(url) || /logo/i.test(url)) continue;
    const file = url.split('?')[0].split('/').pop();
    const key = file.replace(/_\d+(?=\.[a-zA-Z0-9]+$)/, '');
    const isBig = /_1200\./.test(file);
    const prev = found.get(key);
    if (!prev || (isBig && !prev.isBig)) found.set(key, { url, isBig });
  }
  return [...found.values()].slice(0, 4).map((v) => v.url);
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

// ---------------------------------------------------------------- 商品 id 枚举

/** 商品列表页：每页 100 条，标题行给出「显示件数：A～B/T」 */
async function fetchItemIds() {
  const ids = [];
  const seen = new Set();
  let total = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = LIST_URL + '?pageIndex=' + page + '&sortKind=3';
    const html = await fetchText(url);
    const pageIds = [...html.matchAll(/\/item-detail\/(\d+)/g)].map((m) => m[1]);
    if (page === 0) {
      const cnt = html.match(/表示件数[^0-9]*([\d,]+)\s*[～~]\s*([\d,]+)\s*\/\s*([\d,]+)/);
      if (cnt) total = Number(cnt[3].replace(/,/g, ''));
    }
    let added = 0;
    for (const id of pageIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      added += 1;
    }
    const expected = total === null ? PER_PAGE : Math.min(PER_PAGE, Math.max(0, total - page * PER_PAGE));
    console.log(
      '  列表页 ' + (page + 1) + '：解析 ' + new Set(pageIds).size + ' 条，新增 ' + added + ' 条' +
        (total !== null ? '（应约 ' + expected + ' 条）' : '')
    );
    if (added === 0) break;
    if (total !== null && ids.length >= total) break;
    await sleep(500);
  }
  return { ids, total };
}

// ---------------------------------------------------------------- 主流程

async function loadHtmlCached(id) {
  const file = path.join(HTML_CACHE_DIR, id + '.html');
  if (!FRESH && fs.existsSync(file) && fs.statSync(file).size > 2000) {
    return { html: fs.readFileSync(file, 'utf8'), cached: true };
  }
  const html = await fetchText(ORIGIN + '/item-detail/' + id);
  fs.mkdirSync(HTML_CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return { html, cached: false };
}

async function main() {
  console.log('竹田ブラシ製作所 抓取 · 阶段一（只取日文，不做任何清洗）');
  console.log('并发：' + CONCURRENCY + '；图片：' + (DO_IMAGES ? '下载' : '跳过'));

  let ids;
  if (ONLY_IDS.length) {
    ids = ONLY_IDS;
    console.log('按 --ids 指定 ' + ids.length + ' 条，跳过列表页枚举');
  } else {
    console.log('\n[1/3] 枚举商品 id（列表页每页 ' + PER_PAGE + ' 条）');
    const res = await fetchItemIds();
    ids = res.ids;
    console.log('  共枚举到 ' + ids.length + ' 条' + (res.total !== null ? '（列表页声明总数 ' + res.total + '）' : ''));
    if (res.total !== null && ids.length !== res.total) {
      console.warn('  ! 枚举数(' + ids.length + ') 与列表页声明总数(' + res.total + ') 不一致，请检查');
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
  if (existingByHandle.size) console.log('  已有中间产物：' + existingByHandle.size + ' 条（命中则复用，不会重抓）');

  const results = [];
  const failures = [];
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= ids.length) return;
      const id = ids[index];
      const handle = 'takeda-' + id;
      if (existingByHandle.has(handle)) {
        results.push(existingByHandle.get(handle));
        done += 1;
        continue;
      }
      try {
        const { html, cached } = await loadHtmlCached(id);
        const titleJa = extractName(html);
        // 站方对个别商品（如 1682019）根本没写描述块，页面上不存在 item-detail-txt1。
        // 这属于「官方本就没有描述」，不算抓取失败：留空并在报告里计数。
        const detailJaHtml = extractDetailHtml(html) || '';
        if (!titleJa) throw new Error('未能取到 h2.item-detail-name');
        const categoryJa = extractCategory(html);
        const price = extractPrice(html);

        const images = [];
        if (DO_IMAGES) {
          const urls = extractImages(html);
          for (let n = 0; n < urls.length; n++) {
            const rel = 'assets/takeda/' + id + '-' + (n + 1) + '.' + imageExt(urls[n]);
            const status = await downloadImage(urls[n], path.join(ROOT, rel.split('/').join(path.sep)));
            if (status === 'saved' || status === 'exists') images.push(rel);
          }
        }

        results.push({
          handle,
          itemId: id,
          url: ORIGIN + '/item-detail/' + id,
          titleJa,
          categoryJa: categoryJa || '',
          price,
          images,
          detailJaHtml,
          descJaHtml: detailJaHtml,
          scrapedAt: new Date().toISOString(),
        });
      } catch (err) {
        failures.push({ id, url: ORIGIN + '/item-detail/' + id, error: err.message });
        console.warn('  ! [' + id + '] ' + err.message);
      }
      done += 1;
      if (done % 10 === 0 || done === ids.length) {
        console.log('  进度 ' + done + '/' + ids.length + '（成功 ' + results.length + '，失败 ' + failures.length + '）');
      }
      await sleep(300);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));

  results.sort((a, b) => String(a.handle).localeCompare(String(b.handle)));

  console.log('\n[3/3] 写出中间产物');
  const store = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    sourceMode: 'raku-uru-item-detail',
    declaredTotal: null,
    count: results.length,
    products: results,
    failures,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = JA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, JA_FILE);

  const noCategory = results.filter((p) => !p.categoryJa).length;
  const noImages = results.filter((p) => !p.images.length).length;
  const noDetail = results.filter((p) => !p.detailJaHtml).length;
  console.log('  ' + path.relative(ROOT, JA_FILE) + '：' + results.length + ' 条');
  console.log(
    '  缺分类：' + noCategory + ' 条；缺描述（官方本就没有）：' + noDetail + ' 条；无图片：' + noImages + ' 条；失败：' + failures.length + ' 条'
  );
  if (failures.length) {
    console.log('\n失败清单：');
    failures.slice(0, 20).forEach((f) => console.log('  - ' + f.id + ' ' + f.error));
    console.log('  重跑本脚本会自动补抓失败项。');
  }
}

main().catch((err) => {
  console.error('\n抓取失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
