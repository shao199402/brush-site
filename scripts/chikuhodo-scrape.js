#!/usr/bin/env node
'use strict';
/**
 * 竹宝堂 CHIKUHODO 阶段一抓取（只取日文原文，不做任何清洗/翻译）
 *
 * 站点特征（实测，务必留意）：
 *   1. 静态 HTML 站，商品页 = https://www.chikuhodo.com/product/<slug>.html
 *   2. **商品名称在 <title> 里**：`名称：型号｜竹宝堂（…）`
 *      页面里的 h1 只有型号（如 `FO-8`），模板 B 的 h2.item_title 是 `型号：名称`；
 *      模板 A 的 `div.item_description > h2 > img[alt]` 也含名称，但实测不如 <title> 一致
 *      （会缺「（レッド）」这类后缀、或型号写错），且 case30 这类连 alt 图都没有。
 *   3. **两套模板**：
 *        A（单个刷子，约八成）：有 `div.item_description`，价格在其 `dd.price`
 *        B（套装/笔盒/系列）：**没有** `div.item_description`，价格在 `p.price`
 *   4. sitemap **不可靠**：含 3 个 404（kw/kw_c1/kw_c2）、漏掉首页在售新品
 *      （r_set13/15/16/18、kiwami、case37、set_br_g5、kw6）。
 *      因此枚举用 **sitemap ∪ 分类页 ∪ 首页链接 的并集**，再逐个验状态。
 *   5. 站点 HTML **标签配平良好**（实测 item_description 区块 59/59 配平），
 *      但仍统一用 lib-html.js 的 balanceFragment 兜底。
 *
 * 产物：
 *   data/chikuhodo-ja.json        全量日文中间产物（翻译阶段唯一输入）
 *   data/chikuhodo-cache/*.html   详情页缓存（断点续跑，可删）
 *   assets/chikuhodo/*            商品图片
 */

const fs = require('fs');
const path = require('path');
const { balanceFragment, tagBalance } = require('./lib-html.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JA_FILE = path.join(DATA_DIR, 'chikuhodo-ja.json');
const HTML_CACHE_DIR = path.join(DATA_DIR, 'chikuhodo-cache');
const ASSET_REL = 'assets/chikuhodo';

const ORIGIN = 'https://www.chikuhodo.com';
const PRODUCT_DIR = '/product/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 非商品页（系列总览 / 说明页 / 目录页），即使可访问也不算商品 */
const NON_PRODUCT = new Set([
  'index', 'catalog', 'gift', 'name', 'e_set_howto',
  'an', 'cl', 'fo', 'gl', 'gs', 'j', 'k', 'kz', 'mens', 'mk', 'premium',
  'ps', 'r', 'ren', 't', 'z', 'ze', 'kiwami',
]);

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
function argValue(name) {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}
const FRESH = argv.includes('--fresh');
const LIMIT = Number(argValue('--limit') || 0) || 0;
const IDS = (argValue('--ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
const NO_IMG = argv.includes('--no-images');
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency') || 3));

// ---------------------------------------------------------------- 工具

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#047': '/' };
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z#0-9]+);/g, (m, n) => (ENT[n] !== undefined ? ENT[n] : m));
}
function stripTags(html) {
  return decodeEntities(String(html == null ? '' : html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断点重试的 GET */
async function httpGet(url, { tries = 3, timeout = 30000 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9' }, signal: c.signal });
      clearTimeout(t);
      if (res.status === 404) return { status: 404, text: '' };
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); }
      else return { status: 200, text: await res.text() };
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
    }
    if (i < tries) await sleep(800 * i);
  }
  return { status: 0, text: '', error: lastErr && lastErr.message };
}

// ---------------------------------------------------------------- 结构提取

/** 取某 class 的元素的 inner（标签栈配平；用于结构规整的容器） */
function innerByClass(html, tag, cls) {
  const openRe = new RegExp('<' + tag + '\\b[^>]*class=(?:"[^"]*\\b' + cls + '\\b[^"]*"|\'[^\']*\\b' + cls + '\\b[^\']*\')[^>]*>', 'i');
  const open = openRe.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const re = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '\\s*>', 'gi');
  re.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].charAt(1) === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(start, m.index);
    } else depth += 1;
  }
  return html.slice(start);
}

/** 商品名称：<title> 中「｜」之前、最后一个「：」之前的文本 */
function extractName(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!m) return { name: '', model: '', titleHead: '' };
  const titleHead = stripTags(m[1]).split('｜')[0].split('|')[0].trim();
  const i = titleHead.lastIndexOf('：');
  if (i === -1) return { name: titleHead, model: '', titleHead };
  return { name: titleHead.slice(0, i).trim(), model: titleHead.slice(i + 1).trim(), titleHead };
}

/**
 * 价格。站方价格载体有四种，全部要覆盖（实测漏掉 `td.price` 会让 23 个笔盒全部误判无价）：
 *   - 模板 A 单个刷子：`<dd class="price">3,850円 [税込]</dd>`（在 item_description 内）
 *   - 模板 B 套装    ：`<p class="price">69,080円 [税込]</p>`
 *   - 笔盒          ：`<td class="price">2,420円 [税込]</td>`（在规格表的最后一行）
 *   - 无 price 类的合集页：描述文字里直接写 `31,350円`
 * 输出与晃佑堂一致：`3,850 日元（含税）`。
 */
function extractPrice(html, descRaw) {
  const scope = [];
  const a = innerByClass(html, 'div', 'item_description');
  if (a) scope.push(a);
  scope.push(html);

  for (const src of scope) {
    for (const tag of ['dd', 'td', 'p', 'span', 'div']) {
      const re = new RegExp('<' + tag + '\\b[^>]*class="[^"]*\\bprice\\b[^"]*"[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
      const m = re.exec(src);
      if (!m) continue;
      const num = stripTags(m[1]).match(/([\d,]{3,})/);
      if (num) {
        const n = Number(num[1].replace(/,/g, ''));
        if (Number.isFinite(n) && n > 0) return n.toLocaleString('en-US') + ' 日元（含税）';
      }
    }
  }
  // 兜底：描述区文字里出现的第一个价格
  const plain = stripTags(descRaw || '');
  const m2 = plain.match(/([\d,]{3,})\s*円/);
  if (m2) {
    const n = Number(m2[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n.toLocaleString('en-US') + ' 日元（含税）';
  }
  return '价格待确认';
}

/** 去掉图片相关元素（保留文字与原样式） */
function removeImages(frag) {
  let s = String(frag || '');
  s = s.replace(/<ul\b[^>]*class="[^"]*sns_area[^"]*"[^>]*>[\s\S]*?<\/ul>/gi, '');   // 分享按钮整块
  s = s.replace(/<div\b[^>]*class="[^"]*icon_zoom[^"]*"[^>]*>[\s\S]*?<\/div>/gi, ''); // 放大镜
  s = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (m) => (/<img/i.test(m) ? '' : m));     // 纯图片链接
  s = s.replace(/<img\b[^>]*>/gi, '');                                              // 其余图片
  return s;
}

/**
 * 给 iframe 加 `loading="lazy"`。
 * `c2026a`/`c2026b` 这类合集页的描述里嵌了 10+ 个 YouTube 视频，
 * 详情弹窗用的是 innerHTML，不加 lazy 会在打开弹窗时一次性加载所有视频。
 */
function lazyIframes(html) {
  return String(html || '').replace(/<iframe\b[^>]*>/gi, (tag) => (
    /\bloading\s*=/i.test(tag) ? tag : tag.replace(/<iframe\b/i, '<iframe loading="lazy"')
  ));
}

/** 去掉「整段注释」与其内的 HTML 注释（避免留下 `<!-- SNS -->` 这类页脚标记） */
function stripComments(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/g, ''); // 兜底：未闭合的注释尾巴
}

/**
 * 描述区块。
 *   模板 A：div.item_description
 *   模板 B：无该容器，退回 article#item（同口径），并去掉头尾共用块
 * 返回 { raw, source }；raw 为 null 表示页面确实没有描述内容
 */
function extractDescBlock(html) {
  const a = innerByClass(html, 'div', 'item_description');
  if (a !== null) return { raw: a, source: 'item_description' };

  const artOpen = html.search(/<article[^>]*id="item"[^>]*>/i);
  if (artOpen === -1) return { raw: null, source: 'none' };
  const tagM = /<article\b[^>]*>/i.exec(html.slice(artOpen));
  const start = artOpen + tagM[0].length;
  const end = html.indexOf('</article>', start);
  let seg = html.slice(start, end === -1 ? html.length : end);
  // 去掉分享按钮
  seg = removeByClass(seg, 'ul', 'sns_area');
  // 去掉页面功能与共用区块（都不是商品描述）：
  //   bt_cart        购物车按钮
  //   review         顾客评价（含「お客様の声」、评分、评论正文）
  //   case_link      同系列关联导航
  //   chikuhodo_contact / oem_contact / no_name  联系方式、OEM 推广、无法刻名提示
  // 实测这些会把「加入购物车」「●顾客评价（1条）Y.S女士…★★★★★」混进描述里。
  for (const [tag, cls] of [
    ['p', 'bt_cart'], ['div', 'review'], ['section', 'case_link'],
    ['p', 'review_link'], ['p', 'btn'],
    ['div', 'chikuhodo_contact'], ['div', 'oem_contact'], ['div', 'no_name'],
  ]) {
    seg = removeByClass(seg, tag, cls);
  }
  // 价格由 price 字段承载，去掉避免重复
  seg = seg.replace(/<p\b[^>]*class="[^"]*price[^"]*"[^>]*>[\s\S]*?<\/p>/gi, '');
  // 名称由 title 字段承载（h1 只有型号或"系列名+套装名"）
  seg = seg.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '');
  if (!seg.trim()) return { raw: null, source: 'article-empty' };
  return { raw: seg, source: 'article' };
}

/** 去掉整段 HTML 注释（含 `<!-- SNS -->` 这类页脚标记） */
function stripComments(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/g, ''); // 兜底：未闭合的注释尾巴
}

/** 取某 class 的元素的**外层** HTML（含开闭标签，标签栈配平） */
function outerByClass(html, tag, cls) {
  const openRe = new RegExp('<' + tag + '\\b[^>]*class=(?:"[^"]*\\b' + cls + '\\b[^"]*"|\'[^\']*\\b' + cls + '\\b[^\']*\')[^>]*>', 'i');
  const open = openRe.exec(html);
  if (!open) return null;
  const start = open.index;
  const re = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '\\s*>', 'gi');
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].charAt(1) === '/') {
      depth -= 1;
      if (depth === 0) return { html: html.slice(start, re.lastIndex), start, end: re.lastIndex };
    } else depth += 1;
  }
  return { html: html.slice(start), start, end: html.length };
}

/**
 * 反复删除某个 class 的元素（用标签栈取完整外层，**不能用非贪婪正则**：
 * `<div class="review">` 内层还有 `</div>`，正则配到第一个就会只删一半、留下残余，
 * 实测就因此把「●お客様の声（1件）」和评价正文漏进了描述）。
 */
function removeByClass(seg, tag, cls) {
  let out = String(seg);
  for (let guard = 0; guard < 50; guard++) {
    const hit = outerByClass(out, tag, cls);
    if (!hit) return out;
    out = out.slice(0, hit.start) + out.slice(hit.end);
  }
  return out;
}

/** 列表描述 desc：描述区块原文（含图片），保留原有样式 */
function buildDesc(block) {
  if (!block || block.raw == null) return { html: '', source: 'missing' };
  const out = lazyIframes(balanceFragment(stripComments(block.raw)).html.trim());
  return { html: out, source: out ? block.source : 'empty' };
}

/** 点击详情 detailHtml：描述区块排除图片后，保留原有样式 */
function buildDetail(block) {
  if (!block || block.raw == null) return { html: '', source: 'missing' };
  const out = lazyIframes(balanceFragment(stripComments(removeImages(block.raw))).html.trim());
  return { html: out, source: out ? block.source + '-noimg' : 'empty' };
}

/**
 * 分类：面包屑里的 `cate_*` 项（**用途分类**，即站方真正的分类体系）作为主分类，
 * 用于模块的分类下拉与分类搜索。
 *
 * 面包屑倒数第二项是**系列**（如 `gl.html` → GLシリーズ），粒度太细
 * （35+ 个系列，会让下拉框爆掉），因此只放进 `seriesJa` 备查，不进 categories。
 * 注意系列项要取**最后一个链接项**：套装页的末项可能指向同系列商品，
 * 而正数第二项才是系列总览页。
 */
function extractCategories(html) {
  const out = { type: '', categories: [], seriesJa: '' };
  const bp = html.search(/class="breadcrumb/i);
  const scope = bp === -1 ? html : html.slice(bp, bp + 3000);
  const items = [];
  for (const m of scope.matchAll(/<li[^>]*>[\s\S]*?<a\s+href="([^"]*)"[^>]*>[\s\S]*?<span[^>]*itemprop="title"[^>]*>([\s\S]*?)<\/span>/gi)) {
    const href = m[1].replace(/^\.\//, '');
    const name = stripTags(m[2]);
    if (!name || /^HOME$/i.test(name) || /^化粧筆$/.test(name)) continue;
    items.push({ href, name });
  }
  const cateItem = items.find((x) => /^cate_/.test(x.href));
  // 系列项：指向系列总览页（`gl.html` 这类，非 cate_、且在 NON_PRODUCT 名单里）
  const seriesItems = items.filter((x) => !/^cate_/.test(x.href) && NON_PRODUCT.has(x.href.replace(/\.html$/, '')));
  const series = seriesItems.length ? seriesItems[seriesItems.length - 1] : null;
  if (cateItem) {
    out.type = cateItem.name;
    out.categories = [cateItem.name];
  } else if (series) {
    out.type = series.name;
    out.categories = [series.name];
  }
  if (series) out.seriesJa = series.name;
  return out;
}

/**
 * 商品图片。
 *
 * 模板 A（单个刷子）的图在 `div.item_photo` / `div.item_photo_sp`
 * （`.item_photo_sp` 是移动端副本，换行时显示，所以两处都取）；
 * 模板 B（套装/笔盒）没有这些容器，商品图**只在描述区**（`p.set_photo`、
 * 或描述里的内容图），因此还要从描述区块里补充。
 *
 * 注意不能全页扫描：会把 logo、分享按钮、系列缩略图、规格图标一并当成商品图
 * （实测 fo_08 整页 30+ 张图，商品图只有 2 张）。
 */
function extractImages(html, descRaw) {
  const scopes = [];
  for (const [tag, cls] of [['div', 'item_photo'], ['div', 'item_photo_sp']]) {
    const inner = innerByClass(html, tag, cls);
    if (inner && /<img/i.test(inner)) scopes.push(inner);
  }
  // 模板 B 兜底：描述区里的图（套装内容图、套装明细图）
  if (descRaw && /<img/i.test(descRaw)) scopes.push(descRaw);
  if (!scopes.length) return [];

  const seen = new Set();
  const out = [];
  for (const scope of scopes) {
    for (const m of scope.matchAll(/<img[^>]+src=(?:"([^"]+)"|'([^']+)')/gi)) {
      let url = decodeEntities(m[1] || m[2]).split('?')[0].trim();
      if (!url) continue;
      if (url.startsWith('//')) url = 'https:' + url;
      else if (url.startsWith('/')) url = ORIGIN + url;
      else if (!/^https?:/i.test(url)) url = ORIGIN + PRODUCT_DIR + url.replace(/^\.\//, '');
      if (!/\.(jpe?g|png|gif|webp)$/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
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
  } catch { /* ignore */ }
  try {
    const res = await fetch(remote, { headers: { 'User-Agent': UA, Referer: ORIGIN + '/' } });
    if (!res.ok) return 'http ' + res.status;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return 'too small (' + buf.length + 'b)';
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buf);
    return 'saved';
  } catch (err) {
    return 'err ' + (err && err.message);
  }
}

// ---------------------------------------------------------------- 枚举

/** sitemap ∪ 分类页 ∪ 首页 的并集 */
async function collectSlugs() {
  const found = new Map(); // slug -> Set(来源)
  const add = (slug, src) => {
    if (!slug || !/^[a-z0-9_]+$/i.test(slug)) return;
    if (slug.startsWith('cate_') || slug.startsWith('material')) return;
    if (!found.has(slug)) found.set(slug, new Set());
    found.get(slug).add(src);
  };

  const sm = await httpGet(ORIGIN + '/sitemap.xml');
  if (sm.status === 200) {
    for (const m of sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const u = m[1];
      if (!/\/product\/[^/]+\.html$/.test(u) || /\/en\//.test(u)) continue;
      add(u.replace(/.*\/product\//, '').replace(/\.html$/, ''), 'sitemap');
    }
    console.log('[1/4] sitemap 给出 ' + found.size + ' 个候选');
  } else {
    console.log('[1/4] sitemap 不可用（' + sm.status + '），改由分类页枚举');
  }

  const home = await httpGet(ORIGIN + '/index.html');
  if (home.status === 200) {
    const before = found.size;
    for (const m of home.text.matchAll(/product\/([a-z0-9_]+)\.html/gi)) add(m[1], 'home');
    console.log('      首页补充 ' + (found.size - before) + ' 个（sitemap 漏项）');
  }

  const cateSlugs = [];
  if (sm.status === 200) {
    for (const m of sm.text.matchAll(/<loc>[^<]*\/product\/(cate_[^<.]+)\.html<\/loc>/g)) cateSlugs.push(m[1]);
  }
  let catAdded = 0;
  for (const cs of cateSlugs) {
    const r = await httpGet(ORIGIN + PRODUCT_DIR + cs + '.html');
    if (r.status !== 200) continue;
    const before = found.size;
    for (const m of r.text.matchAll(/href="(?:\.\/)?([a-z0-9_]+)\.html"/gi)) add(m[1], 'cate:' + cs);
    catAdded += found.size - before;
    await sleep(90);
  }
  console.log('      ' + cateSlugs.length + ' 个分类页补充 ' + catAdded + ' 个');
  return found;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log('竹宝堂 CHIKUHODO 抓取（只取日文原文）');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HTML_CACHE_DIR, { recursive: true });

  // 已有中间产物：命中则复用（--fresh 时忽略）
  const existingByHandle = new Map();
  if (!FRESH && fs.existsSync(JA_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(JA_FILE, 'utf8'));
      for (const p of prev.products || []) existingByHandle.set(p.handle, p);
      if (existingByHandle.size) console.log('  已有中间产物：' + existingByHandle.size + ' 条（命中则复用）');
    } catch { /* 忽略损坏的旧产物 */ }
  }

  let candidates;
  if (IDS.length) {
    candidates = new Map(IDS.map((s) => [s.replace(/^.*\/product\//, '').replace(/\.html$/, ''), new Set(['args'])]));
    console.log('[1/4] 由 --ids 指定 ' + candidates.size + ' 个候选');
  } else {
    candidates = await collectSlugs();
  }

  const ordered = [...candidates.keys()]
    .filter((s) => !NON_PRODUCT.has(s))
    .sort((a, b) => {
      // 系列页优先排在前面，便于及早发现模板问题
      const am = /_/.test(a) ? 1 : 0;
      const bm = /_/.test(b) ? 1 : 0;
      return am - bm || a.localeCompare(b);
    });
  const toFetch = LIMIT ? ordered.slice(0, LIMIT) : ordered;
  console.log('[2/4] 待抓取候选 ' + ordered.length + ' 个' + (LIMIT ? '（--limit=' + LIMIT + '，实际 ' + toFetch.length + '）' : ''));

  const results = [];
  const failures = [];
  const skipped = [];
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= toFetch.length) return;
      const slug = toFetch[i];
      const handle = 'chikuhodo-' + slug;
      const cachePath = path.join(HTML_CACHE_DIR, slug + '.html');
      try {
        let html = null;
        if (!FRESH && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1000) {
          html = fs.readFileSync(cachePath, 'utf8');
        } else {
          const r = await httpGet(ORIGIN + PRODUCT_DIR + slug + '.html');
          if (r.status !== 200) {
            failures.push({ id: slug, error: 'HTTP ' + r.status + (r.error ? ' ' + r.error : '') });
            done += 1;
            continue;
          }
          html = r.text;
          fs.writeFileSync(cachePath, html, 'utf8');
          await sleep(120);
        }

        const nm = extractName(html);
        if (!nm.name) {
          failures.push({ id: slug, error: '未能从 <title> 取到商品名称' });
          done += 1;
          continue;
        }

        const block = extractDescBlock(html);
        const desc = buildDesc(block);
        const detail = buildDetail(block);
        const cats = extractCategories(html);
        const price = extractPrice(html, block.raw);

        // 图片
        let images = [];
        if (!NO_IMG) {
          const urls = extractImages(html, block.raw);
          for (let n = 0; n < urls.length; n++) {
            const rel = ASSET_REL + '/' + slug + '-' + (n + 1) + '.' + imageExt(urls[n]);
            const status = await downloadImage(urls[n], path.join(ROOT, rel.split('/').join(path.sep)));
            if (status === 'saved' || status === 'exists') images.push(rel);
          }
        }

        // 页面没有任何可售内容（无描述、无价格、无图）视为非商品
        const sellable = Boolean(desc.html || detail.html || price !== '价格待确认' || images.length);
        if (!sellable) {
          skipped.push({ slug, reason: '无可售内容' });
          done += 1;
          continue;
        }

        results.push({
          handle,
          slug,
          titleJa: nm.name,
          modelJa: nm.model,
          titleHeadJa: nm.titleHead,
          descJaHtml: desc.html,
          detailJaHtml: detail.html,
          price,
          typeJa: cats.type || '竹宝堂商品',
          categoriesJa: cats.categories.length ? cats.categories : ['竹宝堂商品'],
          seriesJa: cats.seriesJa || '',
          images,
          descSource: desc.source,
          detailSource: detail.source,
          sources: [...(candidates.get(slug) || [])],
        });
      } catch (err) {
        failures.push({ id: slug, error: (err && err.message) || String(err) });
      }
      done += 1;
      if (done % 25 === 0) console.log('  进度 ' + done + '/' + toFetch.length + '（成功 ' + results.length + '，失败 ' + failures.length + '）');
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  results.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));

  // 分类清单（供分类搜索）
  const catSet = new Map();
  for (const p of results) {
    for (const c of p.categoriesJa) catSet.set(c, (catSet.get(c) || 0) + 1);
  }

  const store = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    sourceMode: 'chikuhodo-static',
    categories: [...catSet.keys()].sort((a, b) => catSet.get(b) - catSet.get(a)),
    countsByCategory: Object.fromEntries([...catSet.entries()].sort((a, b) => b[1] - a[1])),
    count: results.length,
    products: results,
    failures,
    skipped,
  };
  const tmp = JA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, JA_FILE);

  const noDesc = results.filter((p) => !p.descJaHtml).length;
  const noDetail = results.filter((p) => !p.detailJaHtml).length;
  const noPrice = results.filter((p) => p.price === '价格待确认').length;
  const noImg = results.filter((p) => !p.images.length).length;
  let unbalanced = 0;
  for (const p of results) {
    if (tagBalance(p.detailJaHtml).length || tagBalance(p.descJaHtml).length) unbalanced += 1;
  }
  const halfComment = (s) => {
    const t = String(s || '');
    const i = t.lastIndexOf('<!--');
    return i !== -1 && t.indexOf('-->', i) === -1;
  };
  const half = results.filter((p) => halfComment(p.descJaHtml) || halfComment(p.detailJaHtml)).length;
  const tally = (k) => {
    const o = {};
    for (const p of results) o[p[k] || '?'] = (o[p[k] || '?'] || 0) + 1;
    return o;
  };

  console.log('\n[3/4] 写出 ' + path.relative(ROOT, JA_FILE));
  console.log('  商品：' + results.length + ' 条；失败：' + failures.length + '；跳过（无可售内容）：' + skipped.length);
  console.log('  空列表描述：' + noDesc + '；空点击详情：' + noDetail + '；无价格：' + noPrice + '；无图片：' + noImg);
  console.log('  描述来源：' + JSON.stringify(tally('descSource')));
  console.log('  分类数：' + catSet.size + '  ' + JSON.stringify([...catSet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)));
  console.log('  标签不配平（应为 0）：' + unbalanced + '；含未闭合注释（应为 0）：' + half);

  console.log('\n[4/4] 名称/价格抽样');
  for (const p of results.slice(0, 6)) {
    console.log('  ' + p.slug.padEnd(12) + '「' + p.titleJa + '」 型号=' + (p.modelJa || '-') + '  价格=' + p.price + '  分类=' + JSON.stringify(p.categoriesJa));
  }
  if (failures.length) {
    console.log('\n失败清单：');
    failures.slice(0, 20).forEach((f) => console.log('  - ' + f.id + ' ' + f.error));
  }
  if (skipped.length) {
    console.log('\n跳过清单：');
    skipped.slice(0, 20).forEach((f) => console.log('  - ' + f.slug + ' ' + f.reason));
  }
}

main().catch((err) => {
  console.error('\n抓取失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
