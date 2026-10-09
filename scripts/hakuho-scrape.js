#!/usr/bin/env node
'use strict';
/**
 * 白凤堂商品 —— 第一阶段：抓取「纯日文」，不做任何翻译、不做任何字符清洗。
 *
 * 需求来源：
 *   商品名称        = 详情页 div.product-single__meta 下 h1.product-single__title 的内容
 *   列表页商品描述  = 详情页 div.main_comment 的内容
 *   详情内容        = 详情页 div.product-single__description-full.rte 的内容（HTML 结构原样保留）
 *
 * 重要：本脚本绝不删除假名、绝不做任何 polish/replace 式的文本处理。
 *       旧的 catalog-data.js 就是因为在上游剥离了平假名/片假名，才导致
 *       「適度なコシと肌当たりの良さをあわせ持つ」变成「適度肌当良持」这类残文。
 *       这里只做「取原文」这一件事，翻译交给第二阶段。
 *
 * 两种数据来源（--source）：
 *   json （默认，推荐）：走 /collections/makeup-brushes/products.json。
 *        Shopify 主题里 product-single__description-full.rte 渲染的就是 body_html，
 *        所以两者内容一致；且 json 一次给全 title/body_html/全部图片/价格/sku/tags。
 *        1024 条商品约 5 个请求，稳定且不会漏图。
 *   html ：逐条抓商品详情页 HTML，严格用上面三个 CSS 选择器提取。
 *        1024 次整页请求（每页数百 KB），慢且更容易失败，但完全贴合选择器字面要求。
 *        两种模式都会同时抓 json，以便补齐图片/价格，并对可提取到的字段做交叉核对。
 *
 * 用法：
 *   node scripts/hakuho-scrape.js --verify=3          # 先核对 json 与 html 两种来源是否一致
 *   node scripts/hakuho-scrape.js --limit=20          # 小批量试跑
 *   node scripts/hakuho-scrape.js                     # 全量（默认 json 来源）
 *   node scripts/hakuho-scrape.js --source=html       # 严格按 CSS 选择器走整页解析
 *   node scripts/hakuho-scrape.js --no-images         # 不下载图片
 *   node scripts/hakuho-scrape.js --handles=hd0001,hd0003
 *   node scripts/hakuho-scrape.js --fresh             # 忽略已有中间产物，从头抓
 *
 * 产物：
 *   data/hakuho-ja.json   全量日文中间产物（翻译阶段的唯一输入）
 *   assets/products/*.jpg 商品图片（默认下载，已存在且大于 1KB 时跳过）
 *
 * 可断点续跑：已成功抓到的 handle 默认跳过，中断后重跑即可。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JA_FILE = path.join(DATA_DIR, 'hakuho-ja.json');
const CATALOG_FILE = path.join(ROOT, 'catalog-data.js');
const IMG_DIR = path.join(ROOT, 'assets', 'products');

const ORIGIN = 'https://hakuho-do.co.jp';
const COLLECTION_JSON = ORIGIN + '/collections/makeup-brushes/products.json';
const STORE_JSON = ORIGIN + '/products.json';
const PAGE_LIMIT = 30;
const PER_PAGE = 250;

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
function argValue(name) {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
const SOURCE = String(argValue('--source') || 'json').toLowerCase();
const FEED = String(argValue('--feed') || 'store').toLowerCase();
const LIMIT = Number(argValue('--limit') || 0);
const VERIFY = Number(argValue('--verify') || 0);
const VERIFY_ONLY = argValue('--verify-only') !== undefined;
const HANDLES = String(argValue('--handles') || '').split(',').map((s) => s.trim()).filter(Boolean);
const DO_IMAGES = argValue('--no-images') === undefined;
const FRESH = argValue('--fresh') !== undefined;
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency') || 4));

if (!['json', 'html'].includes(SOURCE)) {
  console.error('--source 只支持 json 或 html');
  process.exit(1);
}

// ---------------------------------------------------------------- 基础工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { tries = 4, timeout = 45000, expectJson = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; hakuho-catalog-builder/2.0)',
          Accept: expectJson ? 'application/json' : 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja-JP,ja;q=0.9',
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      const text = await res.text();
      if (!text || text.length < 20) throw new Error('响应过短（' + (text || '').length + ' 字节）');
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(800 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, { ...opts, expectJson: true });
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('JSON 解析失败：' + err.message);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function decodeEntities(input) {
  return String(input)
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
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 把 HTML 转成可读纯文本；keepSpanBoundary=true 时在 </span> 处补一个空格，
 *  使「毛質:山羊」与后文之间有分隔（desc 用）。 */
function toPlainText(html, { keepSpanBoundary = false } = {}) {
  let s = String(html);
  if (keepSpanBoundary) s = s.replace(/<\/span\s*>/gi, '</span> ');
  s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|h[1-6]|tr|table)>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

// --------------------------------------------------- HTML 结构提取（按 CSS 选择器）

function classListOf(tagHtml) {
  const m = tagHtml.match(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (!m) return [];
  const raw = m[2] != null ? m[2] : m[3];
  return String(raw).split(/\s+/).filter(Boolean);
}

/** 从 from 位置起，找到与已开始的 <div> 配对的 </div>，返回其 '<' 的下标。 */
function findClosingDiv(html, from) {
  const re = /<div\b[^>]*>|<\/div\s*>/gi;
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (/^<\/div/i.test(m[0])) {
      depth -= 1;
      if (depth === 0) return m.index;
    } else {
      depth += 1;
    }
  }
  return -1;
}

/** 按 class 找第一个 div，返回 { outer, inner }。用深度配对，能正确处理嵌套 div。 */
function extractDiv(html, classToken) {
  const re = /<div\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!classListOf(m[0]).includes(classToken)) continue;
    const openEnd = m.index + m[0].length;
    const closeStart = findClosingDiv(html, openEnd);
    if (closeStart === -1) return null;
    return { outer: html.slice(m.index, closeStart + 6), inner: html.slice(openEnd, closeStart) };
  }
  return null;
}

/** h1.h2.product-single__title，优先在 div.product-single__meta 范围内查找。 */
function extractTitle(html) {
  const meta = extractDiv(html, 'product-single__meta');
  const scope = meta ? meta.inner : html;
  const re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  let m;
  let fallback = null;
  while ((m = re.exec(scope))) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const text = stripTags(m[1]);
    if (fallback === null && text) fallback = text;
    if (classListOf(tag).includes('product-single__title') && text) return text;
  }
  return fallback;
}

/** div.product-single__description-full.rte 的内容（inner HTML，结构原样）。 */
function extractDescriptionFull(html) {
  const hit = extractDiv(html, 'product-single__description-full');
  return hit ? hit.inner : null;
}

/** div.main_comment 的内容（inner HTML）。 */
function extractMainComment(html) {
  const hit = extractDiv(html, 'main_comment');
  return hit ? hit.inner : null;
}

// ---------------------------------------------------------------- 价格 / 图片

function formatYen(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '价格待确认';
  return '￥' + Math.round(n).toLocaleString('en-US') + ' 含税';
}

/** 价格格式化规则：`￥1,234 含税`；多档位时为 `￥1,000–￥2,000 含税`。站点内唯一权威格式。 */
function priceFromVariants(variants) {
  const prices = (variants || []).map((v) => Number(v.price)).filter(Number.isFinite);
  if (!prices.length) return '价格待确认';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatYen(min) : formatYen(min).replace(' 含税', '') + '–' + formatYen(max);
}

function imageExt(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-zA-Z0-9]+)$/);
    return (m ? m[1] : 'jpg').toLowerCase();
  } catch {
    return 'jpg';
  }
}

/** 官方 images[] 按 position 排序 → 本地路径 assets/products/{handle}-{n}.{ext} */
function buildImagePlan(handle, product) {
  const list = (product.images || [])
    .slice()
    .sort((a, b) => (a.position || 0) - (b.position || 0))
    .map((img) => img && img.src)
    .filter(Boolean);
  return list.map((src, i) => ({
    src,
    rel: 'assets/products/' + handle + '-' + (i + 1) + '.' + imageExt(src),
  }));
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
    const res = await fetch(remote, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; hakuho-catalog-builder/2.0)' },
      signal: controller.signal,
    });
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

// ---------------------------------------------------------------- 商品列表

async function fetchCollectionProducts(baseUrl, label) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const url = baseUrl + '?limit=' + PER_PAGE + '&page=' + page;
    let data;
    try {
      data = await fetchJson(url);
    } catch (err) {
      if (page === 1) throw new Error(label + ' 第 1 页抓取失败：' + err.message);
      console.warn('  ! ' + label + ' 第 ' + page + ' 页失败，停止翻页：' + err.message);
      break;
    }
    const list = (data && data.products) || [];
    for (const p of list) {
      if (p && p.handle && !seen.has(p.handle)) {
        seen.add(p.handle);
        all.push(p);
      }
    }
    if (list.length < PER_PAGE) break;
    await sleep(400);
  }
  return all;
}

function loadExistingHandles() {
  try {
    const text = fs.readFileSync(CATALOG_FILE, 'utf8');
    const m = text.match(/^\s*window\.PRODUCTS\s*=\s*([\s\S]*?);\s*$/);
    if (!m) return [];
    return JSON.parse(m[1]).map((p) => p && p.handle).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 主流程

async function verifySources(products) {
  console.log('\n== 交叉核对：json 的 body_html  vs  详情页 div.product-single__description-full ==');
  let same = 0;
  let diff = 0;
  for (const p of products.slice(0, VERIFY)) {
    const url = ORIGIN + '/products/' + p.handle;
    let html;
    try {
      html = await fetchText(url);
    } catch (err) {
      console.log('  [' + p.handle + '] 整页抓取失败：' + err.message);
      diff += 1;
      continue;
    }
    const htmlTitle = extractTitle(html);
    const htmlDesc = extractMainComment(html);
    const htmlDetail = extractDescriptionFull(html);

    const jsonTitle = String(p.title || '').trim();
    const jsonDetail = String(p.body_html || '');
    const jsonDesc = extractMainComment(jsonDetail);

    const problems = [];
    if (!htmlTitle) problems.push('未找到 h1.product-single__title');
    else if (htmlTitle !== jsonTitle) problems.push('标题不一致：「' + jsonTitle + '」vs「' + htmlTitle + '」');
    if (!htmlDesc) problems.push('未找到 div.main_comment');
    if (!htmlDetail) problems.push('未找到 div.product-single__description-full');

    let textMatch = null;
    if (htmlDetail) {
      const a = stripTags(htmlDetail);
      const b = stripTags(jsonDetail);
      textMatch = a === b;
      if (!textMatch) {
        problems.push('正文纯文本不一致（html ' + a.length + ' 字 / json ' + b.length + ' 字）');
      }
    }

    if (problems.length === 0) {
      same += 1;
      console.log('  [' + p.handle + '] 一致 ✓  （正文 ' + stripTags(jsonDetail).length + ' 字，结构 ' + (htmlDetail.length) + ' 字符）');
    } else {
      diff += 1;
      console.log('  [' + p.handle + '] 有差异 ✗\n      - ' + problems.join('\n      - '));
    }
    await sleep(500);
  }
  console.log('\n核对结果：一致 ' + same + ' 条，有差异 ' + diff + ' 条');
  if (diff === 0 && same > 0) {
    console.log('=> json 的 body_html 与详情页该 div 的内容等价，可安全使用 --source=json 全量抓取。');
  } else if (diff > 0) {
    console.log('=> 存在差异，请改用 --source=html 严格按选择器抓取。');
  }
  console.log('');
}

async function main() {
  console.log('白凤堂抓取 · 阶段一（纯日文提取）');
  console.log('数据来源模式：' + SOURCE + (DO_IMAGES ? ' （下载图片）' : ' （跳过图片）'));

  // 1) 取官方商品列表
  //    注意：/collections/makeup-brushes/products.json 只有 798 条，是全店 1070 条的子集；
  //    旧 catalog 是按全店建的（含日本画筆/洋画筆/雑貨/書筆等品类），所以默认走全店 feed。
  const primary = FEED === 'collection'
    ? { url: COLLECTION_JSON, label: '集合 makeup-brushes' }
    : { url: STORE_JSON, label: '全店' };
  const secondary = FEED === 'collection'
    ? { url: STORE_JSON, label: '全店' }
    : { url: COLLECTION_JSON, label: '集合 makeup-brushes' };

  let products = [];
  try {
    products = await fetchCollectionProducts(primary.url, primary.label);
  } catch (err) {
    console.warn(primary.label + ' 接口失败，回退到 ' + secondary.label + '：' + err.message);
  }
  if (!products.length) {
    products = await fetchCollectionProducts(secondary.url, secondary.label);
  }
  if (!products.length) throw new Error('未能取到任何官方商品，请检查网络');
  products.sort((a, b) => String(a.handle).localeCompare(String(b.handle)));
  console.log('官方商品数：' + products.length);

  if (VERIFY > 0) {
    await verifySources(products);
    if (VERIFY_ONLY) {
      console.log('--verify-only：核对完成，不执行抓取。\n');
      return;
    }
  }

  // 2) 与现有 catalog 对比
  const existingHandles = loadExistingHandles();
  const existingSet = new Set(existingHandles);
  const officialSet = new Set(products.map((p) => p.handle));
  const added = [...officialSet].filter((h) => !existingSet.has(h));
  const removed = existingHandles.filter((h) => !officialSet.has(h));
  console.log('现有 catalog：' + existingHandles.length + ' 条');
  console.log('官方新增（本地没有）：' + added.length + ' 条' + (added.length ? ' -> ' + added.join(', ') : ''));
  console.log('本地有、官方已无：' + removed.length + ' 条' + (removed.length ? ' -> ' + removed.join(', ') : ''));

  // 3) 载入已有中间产物（断点续跑）
  let store = { generatedAt: null, source: ORIGIN, sourceMode: SOURCE, products: [] };
  if (!FRESH && fs.existsSync(JA_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(JA_FILE, 'utf8'));
      if (prev && Array.isArray(prev.products)) {
        store = prev;
        console.log('已载入中间产物：' + prev.products.length + ' 条（可断点续跑）');
      }
    } catch (err) {
      console.warn('中间产物无法解析，将重建：' + err.message);
    }
  }
  const doneMap = new Map(store.products.map((p) => [p.handle, p]));

  // 4) 选出本轮要处理的商品
  let targets = products;
  if (HANDLES.length) {
    const want = new Set(HANDLES);
    targets = targets.filter((p) => want.has(p.handle));
  } else {
    targets = targets.filter((p) => !doneMap.has(p.handle) || !doneMap.get(p.handle).detailJaHtml);
  }
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  console.log('本轮待处理：' + targets.length + ' 条\n');
  if (!targets.length) {
    writeJsonAtomic(JA_FILE, { ...store, generatedAt: new Date().toISOString() });
    console.log('没有待处理商品，中间产物已是最新。');
    return;
  }

  const stats = { ok: 0, fallback: 0, failed: 0, images: { saved: 0, exists: 0, failed: 0 } };
  let cursor = 0;
  let finished = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= targets.length) return;
      const product = targets[index];
      const handle = product.handle;
      const record = {
        handle,
        url: ORIGIN + '/products/' + handle,
        titleJa: String(product.title || '').trim(),
        descJaHtml: null,
        detailJaHtml: null,
        price: priceFromVariants(product.variants),
        sku: (product.variants && product.variants[0] && product.variants[0].sku) || '',
        productTypeJa: String(product.product_type || ''),
        tags: Array.isArray(product.tags)
          ? product.tags
          : (typeof product.tags === 'string' && product.tags
              ? product.tags.split(',').map((s) => s.trim()).filter(Boolean)
              : []),
        sourceUpdatedAt: product.updated_at || '',
        imagePlan: buildImagePlan(handle, product),
        images: [],
        extractSource: SOURCE,
      };

      // json 侧：body_html 即 product-single__description-full.rte 的内容
      record.detailJaHtml = String(product.body_html || '');
      record.descJaHtml = extractMainComment(record.detailJaHtml);

      // html 侧：严格按 CSS 选择器提取
      if (SOURCE === 'html') {
        try {
          const html = await fetchText(record.url);
          const htmlTitle = extractTitle(html);
          const htmlDesc = extractMainComment(html);
          const htmlDetail = extractDescriptionFull(html);
          if (htmlTitle) record.titleJa = htmlTitle;
          if (htmlDetail) record.detailJaHtml = htmlDetail;
          if (htmlDesc) record.descJaHtml = htmlDesc;
          else if (htmlDetail) record.descJaHtml = extractMainComment(htmlDetail);
          if (!htmlDetail) {
            record.extractSource = 'json-fallback';
            stats.fallback += 1;
          }
        } catch (err) {
          record.extractSource = 'json-fallback';
          stats.fallback += 1;
          console.warn('  ! [' + handle + '] 整页抓取失败，回退 json：' + err.message);
        }
      } else if (!record.descJaHtml) {
        record.descJaHtml = String(product.body_html || '').split(/<table/i)[0] || '';
      }

      // 图片
      for (const plan of record.imagePlan) {
        record.images.push(plan.rel);
        if (!DO_IMAGES) continue;
        const abs = path.join(ROOT, plan.rel.split('/').join(path.sep));
        const result = await downloadImage(plan.src, abs);
        if (result === 'saved') stats.images.saved += 1;
        else if (result === 'exists') stats.images.exists += 1;
        else {
          stats.images.failed += 1;
          console.warn('  ! [' + handle + '] 图片下载失败 ' + plan.rel + '：' + result);
        }
        await sleep(120);
      }

      record.descJaPlain = toPlainText(record.descJaHtml || '', { keepSpanBoundary: true });
      doneMap.set(handle, record);
      stats.ok += 1;
      finished += 1;

      if (finished % 10 === 0 || finished === targets.length) {
        store.products = [...doneMap.values()];
        writeJsonAtomic(JA_FILE, { ...store, generatedAt: new Date().toISOString(), sourceMode: SOURCE });
        console.log('  进度 ' + finished + '/' + targets.length + '（已写入中间产物）');
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));

  store.products = [...doneMap.values()].sort((a, b) => String(a.handle).localeCompare(String(b.handle)));
  writeJsonAtomic(JA_FILE, {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    sourceMode: SOURCE,
    officialCount: products.length,
    count: store.products.length,
    newHandles: added,
    missingFromOfficial: removed,
    products: store.products,
  });

  console.log('\n完成。');
  console.log('  成功 ' + stats.ok + ' 条，回退 json ' + stats.fallback + ' 条');
  console.log('  图片：新下载 ' + stats.images.saved + '，已存在 ' + stats.images.exists + '，失败 ' + stats.images.failed);
  console.log('  中间产物：' + path.relative(ROOT, JA_FILE) + '（共 ' + store.products.length + ' 条日文）');
  console.log('\n下一步：node scripts/hakuho-translate.js');
}

main().catch((err) => {
  console.error('\n抓取失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
