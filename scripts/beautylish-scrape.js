#!/usr/bin/env node
'use strict';
/**
 * Beautylish 阶段一抓取（只取英文原文，不做清洗/翻译）
 *
 * 为什么用 Chrome 而不是普通 HTTP：
 *   该站用 AWS WAF 的 JS 挑战挡住一切非浏览器请求（实测 36/36 请求返回 202 挑战页），
 *   且商品数据是服务端渲染进 HTML、区域按出口 IP 决定。必须真正跑一个浏览器。
 *   见 scripts/lib-cdp.js。
 *
 * 阶段：
 *   1a) 枚举：翻 /shop/browse?page=N，收集商品 slug（写 data/beautylish-list.json）
 *   1b) 详情：逐个打开 /p/<slug>，取 JSON-LD + 详情页字段（写 data/beautylish-en.json）
 *
 * 用法：
 *   node scripts/beautylish-scrape.js --list              只跑 1a（枚举，快）
 *   node scripts/beautylish-scrape.js --list --max-pages=5
 *   node scripts/beautylish-scrape.js --detail --limit=40 只抓前 40 个详情
 *   node scripts/beautylish-scrape.js --detail            全量详情
 *   node scripts/beautylish-scrape.js --detail --fresh    忽略详情缓存
 *
 * 产物：
 *   data/beautylish-list.json      枚举结果（slug + 列表页字段）
 *   data/beautylish-en.json        全量英文中间产物（翻译阶段唯一输入）
 *   data/beautylish-cache/*.html   详情页缓存（断点续跑，可删）
 *   assets/beautylish/*            商品图片
 */

const fs = require('fs');
const path = require('path');
const { withChrome, sleep } = require('./lib-cdp.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LIST_FILE = path.join(DATA_DIR, 'beautylish-list.json');
const EN_FILE = path.join(DATA_DIR, 'beautylish-en.json');
const CACHE_DIR = path.join(DATA_DIR, 'beautylish-cache');
const ASSET_REL = 'assets/beautylish';

const ORIGIN = 'https://www.beautylish.com';
const LIST_PATH = '/shop/browse';

/**
 * 导航时屏蔽的资源。
 *
 * ⚠️ 血泪教训：**不要屏蔽 CSS 与字体**。
 * 实测（scripts/_bl-final-test.js）：
 *   - 屏蔽 CSS/字体 → `.markdown_content` 长度为 0（正文没渲染），
 *     并且抓到的正文**字母 s 全部丢失**（s 占比 0.0000，正常应为 0.068）；
 *   - 不屏蔽 → 同一页面 4 次读取全部干净（s 占比 0.0679）。
 * 我因此误判过"站点返回损坏文本"，实际是屏蔽策略导致的降级渲染。
 *
 * 另外**不要屏蔽 awswaf** 域：WAF 挑战要用它换 token，
 * 屏蔽后会被判成挑战失败（实测连续多件"未就绪"）。
 *
 * 只屏蔽真正无关的东西：图片、媒体、统计与分析脚本。
 */
const BLOCKED_URLS = [
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.mp4', '*.webm',
  '*google-analytics*', '*googletagmanager*', '*googlesyndication*',
  '*doubleclick*', '*attn.tv*', '*attentive*',
  '*segment.io*', '*segment.com*', '*hotjar*', '*clarity.ms*',
];

const argv = process.argv.slice(2);
const argValue = (name) => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const FRESH = argv.includes('--fresh');
const DO_LIST = argv.includes('--list') || argv.includes('--all') || argv.length === 0;
const DO_DETAIL = argv.includes('--detail') || argv.includes('--all') || argv.length === 0;
const MAX_PAGES = Number(argValue('--max-pages') || 0) || 0;
const LIMIT = Number(argValue('--limit') || 0) || 0;
/** 起始偏移，配合 --limit 做「分批推进」（批间自动跳过已有缓存） */
const OFFSET = Number(argValue('--offset') || 0) || 0;
const NO_IMG = argv.includes('--no-images');
/**
 * 每次导航之间的间隔。AWS WAF 有速率限制，太快会被挡成空壳页。
 * 默认 1.1 秒（约 0.9 件/秒），既能稳定通过，也不至于太慢。
 */
const NAV_DELAY_MS = Number(argValue('--nav-delay') || 1100);

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
};
const readJsonIfExists = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

// ---------------------------------------------------------------- 页面内取数脚本

/** 一页商品卡片（列表页字段） */
const CARD_EXPR = `(() => {
  const out = [];
  const seen = new Set();
  for (const li of document.querySelectorAll('ul.cardgrid > li')) {
    const a = li.querySelector('a[href^="/p/"]');
    if (!a) continue;
    const href = a.getAttribute('href');
    const slug = href.replace('/p/', '');
    if (seen.has(slug)) continue;
    seen.add(slug);
    const pic = li.querySelector('img');
    out.push({
      slug,
      brand: ((li.querySelector('.offerCard_title') || {}).innerText || '').trim(),
      name: ((li.querySelector('.offerCard_description') || {}).innerText || '').trim(),
      priceText: ((li.querySelector('.infoPrice_price') || {}).innerText || '').trim(),
      optionsText: ((li.querySelector('.offerCard_shadeTermMessage') || {}).innerText || '').trim(),
      callout: ((li.querySelector('.offerCard_calloutElement') || {}).innerText || '').trim(),
      ratingTitle: (() => {
        const t = li.querySelector('svg title');
        return t ? t.textContent.trim() : '';
      })(),
      img: pic ? (pic.getAttribute('data-original-src') || pic.getAttribute('src') || '') : ''
    });
  }
  return out;
})()`;

/** 详情页：优先用 JSON-LD，再补 DOM 字段 */
const DETAIL_EXPR = `(() => {
  const lds = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
    .filter(Boolean);
  const flat = [];
  const walk = (x) => {
    if (!x) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object') {
      if (x['@type']) flat.push(x);
      for (const k of Object.keys(x)) if (k !== '@context') walk(x[k]);
    }
  };
  lds.forEach(walk);
  const product = flat.find(x => x['@type'] === 'Product') || null;
  const offer = product && (Array.isArray(product.offers) ? product.offers[0] : product.offers) || null;

  // 面包屑：详情页第一个 /b/ 链接常是推荐位，真正的品牌在 h1 上方的分类链里
  const crumbs = [...document.querySelectorAll('nav a, [class*="breadcrumb" i] a')]
    .map(a => ({ t: a.innerText.trim(), h: a.getAttribute('href') || '' }))
    .filter(x => x.t && x.t.length < 60);

  // 详情区块：Product Description / Ingredients / Shipping & Returns / Reviews。
  //
  // 该站正文结构是（实测）：
  //   <h2>Product Description</h2>
  //   <div class="flex …">            ← 布局容器
  //     <div class="markdown_content">…正文…</div>   ← 正文在**孙子**层，不是标题的兄弟
  // 因此 nextElementSibling 取不到内容，要顺着找 .markdown_content。
  const sections = {};
  const headings = [...document.querySelectorAll('h2, h3')]
    .filter(h => { const t = (h.innerText || h.textContent || '').trim(); return t && t.length <= 60; });
  for (const h of headings) {
    const title = (h.innerText || h.textContent || '').trim();
    if (sections[title]) continue;
    let text = '';
    // 1) 标题之后的兄弟里向下找正文容器
    let node = h.nextElementSibling;
    let guard = 0;
    while (node && guard < 4 && !text) {
      const md = node.querySelector ? node.querySelector('.markdown_content') : null;
      if (md) text = md.textContent || '';
      else if (node.classList && /markdown_content/.test(node.className)) text = node.textContent || '';
      node = node.nextElementSibling;
      guard++;
    }
    // 2) 兜底：标题的父容器里找第一个 .markdown_content
    if (!text.trim() && h.parentElement) {
      const md = h.parentElement.querySelector('.markdown_content');
      if (md) text = md.textContent || '';
    }
    // 3) 再兜底：父容器文本去掉标题本身
    if (!text.trim() && h.parentElement) {
      text = (h.parentElement.textContent || '').replace(title, ' ');
    }
    text = String(text).replace(/\s+/g, ' ').trim();
    if (text) sections[title] = text.slice(0, 6000);
  }

  // 变体（规格/色号）
  const variants = [...document.querySelectorAll('[class*="swatch" i] a, [class*="variant" i] a, [class*="shade" i] button')]
    .map(e => (e.getAttribute && (e.getAttribute('title') || e.innerText || '')).trim())
    .filter(t => t && t.length < 60);

  return JSON.stringify({
    url: location.href,
    title: document.title,
    h1: (document.querySelector('h1') || {}).innerText || '',
    product,
    offer,
    // 该站 JSON-LD 的 description 就是「完整商品描述」，且是原子的
    // （不依赖 DOM 注水），是最可靠的描述来源。
    ldDescription: (product && product.description) || '',
    crumbs,
    sections,
    variants: [...new Set(variants)].slice(0, 60),
    bodyText: document.body.textContent.slice(0, 8000)
  });
})()`;

// ---------------------------------------------------------------- 文本解析（Node 侧）
//
// 关键设计：**文本解析放在 Node 里做，不放页面里做**。
// 原因：该站是 SPA，正文有一段「缺字中间态」（所有字母 s 缺失）。
// 用 CDP 在页面里求值取文本时，会反复读到那个坏版本——即使改用
// readStable（稳定值）、或先验 DOM 再读，都仍然会踩到（实测失败几十次）。
// 改为「浏览器交出渲染后的 HTML → Node 解析」后，5 个时间点读到的
// 全部干净且一致（s 占比 0.0543）。此路已由 scripts/_bl-htmlpath.js 验证。

const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'wbr']);

/** 取某 class 元素的外层 HTML（标签栈配平） */
function outerHtmlByClass(html, tag, cls) {
  const openRe = new RegExp('<' + tag + '\\b[^>]*class=(?:"[^"]*\\b' + cls + '\\b[^"]*"|\'[^\']*\\b' + cls + '\\b[^\']*\')[^>]*>', 'i');
  const open = openRe.exec(html);
  if (!open) return null;
  const re = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '\\s*>', 'gi');
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].charAt(1) === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(open.index, re.lastIndex);
    } else depth += 1;
  }
  return html.slice(open.index);
}

/** 取某 class 元素的 inner HTML（第一个匹配） */
function innerHtmlByClass(html, tag, cls) {
  const outer = outerHtmlByClass(html, tag, cls);
  if (!outer) return null;
  const m = /^<[a-zA-Z][^>]*>/.exec(outer);
  if (!m) return null;
  return outer.slice(m[0].length, outer.length - (outer.match(/<\/[a-zA-Z]+\s*>$/) || [''])[0].length);
}

function decodeEntities(s) {
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z#0-9]+);/g, (x, n) => (ENT[n] !== undefined ? ENT[n] : x));
}

/** HTML 片段 → 纯文本 */
function htmlToText(frag) {
  return decodeEntities(String(frag || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 文本健康度：长英文里字母 s 占比应约 5%~8%；缺字版本为 0 */
function sRatioOf(text) {
  const L = (String(text).match(/[a-zA-Z]/g) || []).length;
  if (L < 60) return null;
  return (String(text).match(/s/g) || []).length / L;
}
function textLooksHealthy(text) {
  const r = sRatioOf(text);
  return r === null || r >= 0.015;
}

/**
 * 从**渲染后的 HTML 快照**解析详情（全部在 Node 侧做）。
 * 返回结构与原 CDP 版兼容：{ url, title, product, offer, ldDescription, sections, variants }
 */
function parseDetailHtml(html, slug) {
  const out = {
    slug,
    url: '',
    title: htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''),
    product: null,
    offer: null,
    ldDescription: '',
    sections: {},
    variants: [],
  };
  out.url = (html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i) || [])[1]
    || (ORIGIN + '/p/' + slug);

  // ---- JSON-LD：取 @type=Product 与它的 offer
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data = null;
    try { data = JSON.parse(decodeEntities(m[1])); } catch { continue; }
    const flat = [];
    const walk = (x) => {
      if (!x) return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (typeof x === 'object') {
        if (x['@type']) flat.push(x);
        for (const k of Object.keys(x)) if (k !== '@context') walk(x[k]);
      }
    };
    walk(data);
    const prod = flat.find((x) => x['@type'] === 'Product');
    if (prod && !out.product) {
      out.product = prod;
      out.offer = (Array.isArray(prod.offers) ? prod.offers[0] : prod.offers) || null;
      out.ldDescription = String(prod.description || '');
    }
  }

  // ---- 详情区块：<h2>标题</h2> 之后容器里的 .markdown_content
  const headings = [...html.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  for (let i = 0; i < headings.length; i++) {
    const title = htmlToText(headings[i][2]);
    if (!title || title.length > 60 || out.sections[title]) continue;
    // 右边界：下一个标题（或文档尾），在区间内找第一个 markdown_content
    const segStart = headings[i].index + headings[i][0].length;
    const segEnd = i + 1 < headings.length ? headings[i + 1].index : html.length;
    const seg = html.slice(segStart, segEnd);
    const md = innerHtmlByClass(seg, 'div', 'markdown_content');
    if (md === null) continue;
    const text = htmlToText(md);
    if (text) out.sections[title] = text.slice(0, 6000);
  }

  // ---- 变体（色号/规格）
  const variants = [];
  for (const m of html.matchAll(/<[^>]*class="[^"]*(?:swatch|variant|shade)[^"]*"[^>]*title="([^"]{1,60})"/gi)) {
    const t = decodeEntities(m[1]).trim();
    if (t) variants.push(t);
  }
  out.variants = [...new Set(variants)].slice(0, 60);
  return out;
}

// ---------------------------------------------------------------- 图片

function imageExt(url) {
  try {
    const m = new URL(url.startsWith('//') ? 'https:' + url : url).pathname.match(/\.([a-zA-Z0-9]+)$/);
    return (m ? m[1] : 'jpg').toLowerCase();
  } catch { return 'jpg'; }
}
function absImage(u) {
  if (!u) return '';
  let s = String(u).trim();
  if (s.startsWith('//')) s = 'https:' + s;
  else if (s.startsWith('/')) s = ORIGIN + s;
  return s.split('?')[0];
}
async function downloadImage(remote, absPath) {
  try { if (fs.existsSync(absPath) && fs.statSync(absPath).size > 1000) return 'exists'; } catch { /* ignore */ }
  try {
    const res = await fetch(remote, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: ORIGIN + '/' } });
    if (!res.ok) return 'http ' + res.status;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return 'too small';
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buf);
    return 'saved';
  } catch (e) { return 'err ' + e.message; }
}

// ---------------------------------------------------------------- 主流程

async function enumerate(page, onProgress) {
  console.log('[1a] 枚举商品列表');
  await page.goto(ORIGIN + LIST_PATH, { wait: 10000 });
  const totalText = await page.eval(`(document.body.innerText.match(/Showing[^\\n]*/)||[''])[0]`);
  console.log('  ' + totalText);
  const pager = await page.evalJson(`(() => {
    const nums = [...document.querySelectorAll('a[href*="page="]')]
      .map(a => Number((a.getAttribute('href').match(/page=(\\d+)/) || [])[1])).filter(Boolean);
    return { max: nums.length ? Math.max(...nums) : 1 };
  })()`);
  const declared = Number((totalText.match(/of\s+([\d,]+)/) || [])[1] || 0);
  let lastPage = pager.max || 1;
  if (MAX_PAGES) lastPage = Math.min(lastPage, MAX_PAGES);
  console.log('  总页数: ' + pager.max + (MAX_PAGES ? '（按 --max-pages 限制为 ' + lastPage + '）' : '') + '；声明总数: ' + declared);

  const bySlug = new Map();
  for (let p = 1; p <= lastPage; p++) {
    const url = p === 1 ? ORIGIN + LIST_PATH : ORIGIN + LIST_PATH + '?page=' + p;
    if (p > 1) await page.goto(url, { wait: 6500 });
    const cards = await page.evalJson(CARD_EXPR);
    let added = 0;
    for (const c of cards || []) {
      if (!c || !c.slug) continue;
      if (!bySlug.has(c.slug)) { bySlug.set(c.slug, { ...c, listPage: p }); added++; }
    }
    onProgress && onProgress(p, lastPage, bySlug.size, added);
    if (p % 10 === 0 || p === lastPage) console.log('  页 ' + p + '/' + lastPage + '  累计唯一商品 ' + bySlug.size + '（本页新增 ' + added + '）');
    await sleep(350);
  }
  const list = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN + LIST_PATH,
    declaredTotal: declared,
    lastPage: pager.max,
    fetchedPages: lastPage,
    count: bySlug.size,
    items: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
  };
  writeJson(LIST_FILE, list);
  console.log('  写出 ' + path.relative(ROOT, LIST_FILE) + '：' + list.count + ' 个商品');
  return list;
}

function buildProduct(rec, listItem) {
  const prod = rec.product || {};
  const offer = rec.offer || {};
  const brandLd = prod.brand && (prod.brand.name || prod.brand) || '';
  const priceText = listItem && listItem.priceText || '';
  // 价格：优先列表页文本（含区间，形如 "CN¥178 - CN¥180"），否则用 JSON-LD 的数值
  const cur = offer.priceCurrency || '';
  let price = priceText;
  if (!price && offer.price != null) {
    const sym = { CNY: 'CN¥', USD: '$', EUR: '€', GBP: '£' }[cur] || (cur ? cur + ' ' : '');
    price = sym + Number(offer.price).toLocaleString('en-US');
  }
  const images = [...new Set([absImage(prod.image), absImage(listItem && listItem.img)].filter(Boolean))];
  return {
    slug: rec.slug || (listItem && listItem.slug) || '',
    url: rec.url || '',
    brandEn: (listItem && listItem.brand) || brandLd || '',
    nameEn: (listItem && listItem.name) || '',
    fullNameEn: prod.name || '',
    priceText: price,
    priceCurrency: cur,
    priceValue: offer.price != null ? Number(offer.price) : null,
    optionsText: (listItem && listItem.optionsText) || '',
    ratingTitle: (listItem && listItem.ratingTitle) || '',
    sku: prod.sku || '',
    gtin: prod.gtin || '',
    shortDescEn: prod.description || '',
    sectionsEn: rec.sections || {},
    crumbs: (rec.crumbs || []).filter((c) => /^\/[bs]\//.test(c.h) || /^\/shop\//.test(c.h)),
    variants: rec.variants || [],
    images,
    titleEn: rec.title || '',
  };
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  if (DO_LIST) {
    const list = await withChrome((page) => enumerate(page));
    if (!DO_DETAIL) {
      console.log('\n完成（仅枚举）。下一步：node scripts/beautylish-scrape.js --detail');
      return;
    }
  }

  if (DO_DETAIL) {
    const list = readJsonIfExists(LIST_FILE, null);
    if (!list || !list.items || !list.items.length) {
      console.error('缺少枚举结果 ' + path.relative(ROOT, LIST_FILE) + '，请先跑 --list');
      process.exit(1);
    }
    // --offset + --limit 用于「分批推进」：外层调度器一批批跑，
    // 批内命中已有缓存的会秒过，所以实际推进量约等于本批未抓过的件数。
    const startIdx = Math.min(OFFSET, list.items.length);
    const items = (LIMIT || OFFSET)
      ? list.items.slice(startIdx, LIMIT ? startIdx + LIMIT : undefined)
      : list.items;
    console.log('\n[1b] 抓取详情：' + items.length + ' 个商品'
      + (OFFSET ? '（从第 ' + (startIdx + 1) + ' 件开始）' : ''));
    const tStart = Date.now();

    const out = await withChrome(async (page) => {
      // 屏蔽非必需资源（提速 14 倍，见 BLOCKED_URLS 注释）
      await page.cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });

      const results = [];
      const failures = [];
      let blockedCount = 0;
      let tokenRefreshes = 0;
      let degradedCount = 0;
      let lastTiming = null;
      const slowMs = [];
      let fetchMs = 0;   // 真实新增的累计耗时
      let fetched = 0;   // 真实新增件数

      /**
       * 判定「详情页正文已就绪且文本健康」。
       *
       * 该页面正文是**异步分步注水**的，而且中间存在一个**缺字状态**：
       * 这一阶段 .markdown_content 已有内容、但所有字母 s 都缺失
       * （"Flora Drip Di pen er" 应为 "Dispenser"），随后才被替换成完整文本。
       * 若只判「有文字」，readStable 会把这个缺字版本当成稳定值交出去。
       * 因此把**健康判据并进等待条件**：正文里 s 占比必须正常（英文约 5%~8%）。
       *
       * 另外不能用 awsWafCookie 判断挑战页（该脚本在正常页面上也存在）。
       */
      const READY_EXPR = '(() => {'
        + 'const ss=[...document.querySelectorAll(\'script[type="application/ld+json"]\')];'
        + 'let hasProduct=false;'
        + 'for (const s of ss) { try {'
        + 'const walk=(x)=>{if(!x)return false;if(Array.isArray(x))return x.some(walk);'
        + 'if(typeof x==="object"){if(x["@type"]==="Product")return true;'
        + 'return Object.keys(x).some(k=>k!=="@context"&&walk(x[k]))}return false};'
        + 'if (walk(JSON.parse(s.textContent))) { hasProduct=true; break; }'
        + '} catch(e){} }'
        + 'if (!hasProduct) return false;'
        + 'const mds=[...document.querySelectorAll(".markdown_content")];'
        + 'if (mds.length === 0) return false;'
        + 'const text = mds.map(m => m.textContent || "").join(" ");'
        + 'const len = text.replace(/\\s+/g, " ").trim().length;'
        + 'if (len <= 40) return false;'                       // 还没开始注水
        + 'const letters = (text.match(/[a-zA-Z]/g) || []).length;'
        + 'if (letters < 60) return true;'                     // 太短，不足以判定，视为可用
        + 'const sCount = (text.match(/s/g) || []).length;'
        + 'return (sCount / letters) >= 0.02;'                 // 缺字状态直接判未就绪
        + '})()';

      let consecutiveBlocked = 0;
      let nextNavAt = 0;

      /** 保持请求节奏 */
      const pace = async () => {
        const waitMs = nextNavAt - Date.now();
        if (waitMs > 0) await sleep(waitMs);
        nextNavAt = Date.now() + NAV_DELAY_MS;
      };

      /**
       * 等正文文本稳定：连续两次读取长度与末尾一致才认为填充完成。
       * 页面异步注水期间读走会拿到缺字文本（实测字母 s 全丢）。
       */
      const TEXT_LEN_EXPR = '(() => { const m=document.querySelector(".markdown_content"); return m ? (m.textContent||"").replace(/\\s+/g," ").length : 0; })()';
      const waitStableText = async (maxMs = 8000) => {
        const t0 = Date.now();
        let prev = -1;
        let same = 0;
        while (Date.now() - t0 < maxMs) {
          let len = 0;
          try { len = Number(await page.eval(TEXT_LEN_EXPR, { retries: 0 })) || 0; } catch { len = prev; }
          if (len > 40 && len === prev) {
            same += 1;
            if (same >= 2) return true;      // 连续三次一致（含本次）视为稳定
          } else {
            same = 0;
          }
          prev = len;
          await sleep(400);
        }
        return false;
      };

      /**
       * 打开商品页 → **取渲染后的 HTML** → 在 Node 里解析。
       *
       * 为什么不直接在页面里求值：见文件上方「文本解析（Node 侧）」注释。
       * 简言之：页面内求值会反复读到缺字中间态，Node 侧解析则稳定干净。
       * 不健康（s 占比过低）就重新加载重试。
       */
      const fetchProduct = async (slug) => {
        for (let attempt = 1; attempt <= 6; attempt++) {
          await pace();
          const tGoto = Date.now();
          await page.goto(ORIGIN + '/p/' + slug, { wait: 0 });
          const tReadyStart = Date.now();
          const ready = await page.waitFor(
            '(() => { const m=document.querySelector(".markdown_content"); return m && (m.textContent||"").trim().length>40 })()',
            { timeout: 25000, interval: 500 }
          );
          if (!ready) {
            consecutiveBlocked += 1;
            blockedCount += 1;
            if (slowMs.length < 12) slowMs.push({ slug, attempt, stage: 'ready超时', navMs: tReadyStart - tGoto, waitMs: Date.now() - tReadyStart });
            const backoff = Math.min(15000 * Math.pow(2, attempt - 1), 120000);
            // 冷却策略（按实测调优）：
            //   触发阈值从「连续 2 次」放宽到「连续 4 次」——实测 2 次太敏感，
            //   一次偶发慢加载就停 3 分钟，结果冷却占了 64% 的运行时间；
            //   冷却时长从 3 分钟降到 60 秒。
            //   放宽后单件耗时应从 84 秒降到 15~20 秒，全量约 12~17 小时。
            //   数据安全由「健康检查 + 6 次重试」保证，不会写入缺字文本。
            if (consecutiveBlocked >= 4) {
              tokenRefreshes += 1;
              const cooldown = 60000;
              console.log('    [冷却] 连续未就绪 ' + consecutiveBlocked + ' 次，暂停 1 分钟');
              await sleep(cooldown);
              await page.goto(ORIGIN + '/', { wait: 4000 });
              consecutiveBlocked = 0;
              attempt = 0;
            } else {
              await sleep(backoff);
            }
            continue;
          }
          await sleep(1500); // 给渲染一个稳定窗口

          const tParse = Date.now();
          const html = await page.html();
          const rec = parseDetailHtml(html, slug);
          const mdText = htmlToText(
            (rec.sections && rec.sections['Product Description']) || ''
          );
          lastTiming = {
            slug,
            attempt,
            gotoMs: tParse - tGoto,
            parseMs: Date.now() - tParse,
            htmlLen: html.length,
            mdLen: mdText.length,
          };
          if (!textLooksHealthy(mdText)) {
            degradedCount += 1;
            if (degradedCount <= 8) {
              console.log('    [缺字] 正文 s 占比 ' + (sRatioOf(mdText) || 0).toFixed(4) + '，重新加载（第 ' + attempt + ' 次）');
            }
            await sleep(Math.min(8000 * attempt, 45000));
            continue;
          }
          consecutiveBlocked = 0;
          return rec;
        }
        return null;
      };

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const cachePath = path.join(CACHE_DIR, item.slug + '.json');
        try {
          let rec = null;
          if (!FRESH && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 200) {
            rec = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          } else {
            // fetchProduct 内部已含「等就绪 → 取 HTML → Node 解析 → 健康检查 → 重试」
            const tItem = Date.now();
            rec = await fetchProduct(item.slug);
            const itemMs = Date.now() - tItem;
            fetchMs += itemMs;
            fetched += 1;
            if (itemMs > 20000 && slowMs.length < 20) {
              slowMs.push({ slug: item.slug, stage: '整体偏慢', itemMs, timing: lastTiming });
            }
            if (!rec) throw new Error('多次尝试仍未取到健康正文（含缺字/未就绪）');
            fs.writeFileSync(cachePath, JSON.stringify(rec, null, 1), 'utf8');
          }
          const prod = buildProduct(rec, item);

          // 图片：只下**一张**（详情页 JSON-LD 的原始大图），列表页 175×175 缩略图跳过。
          // 实测每张约 0.5~1.2 秒，是全流程第二大开销，能省则省。
          let images = [];
          if (!NO_IMG) {
            const src = prod.images.find((u) => /cloudfront\.net/.test(u) && !/p_\d+x\d+\./.test(u)) || prod.images[0];
            if (src) {
              const rel = ASSET_REL + '/' + item.slug + '-1.' + imageExt(src);
              const st = await downloadImage(src, path.join(ROOT, rel.split('/').join(path.sep)));
              if (st === 'saved' || st === 'exists') images.push(rel);
            }
          }
          prod.images = images;
          if (!prod.brandEn) failures.push({ slug: item.slug, error: '未能取到品牌' });
          results.push(prod);
        } catch (err) {
          failures.push({ slug: item.slug, error: (err && err.message) || String(err) });
        }
        if ((i + 1) % 25 === 0 || i + 1 === items.length) {
          // 速率只按**真实新增**耗时算（缓存命中是秒过的，计入会失真）
          const rate = (fetchMs / Math.max(fetched, 1) / 1000).toFixed(2);
          const remain = items.length - i - 1;
          const eta = Math.round(remain * Number(rate) / 60);
          console.log('  进度 ' + (i + 1) + '/' + items.length
            + '（成功 ' + results.length + '，失败 ' + failures.length
            + '，被限速 ' + blockedCount + '，冷却 ' + tokenRefreshes + '）'
            + '  新增 ' + fetched + ' 件  真实速率 ' + rate + 's/件  剩余约 ' + eta + ' 分钟');
        }
      }
      if (slowMs.length) {
        console.log('\n  [耗时诊断] 最慢的 ' + slowMs.length + ' 件：');
        slowMs.slice(0, 12).forEach((s) => {
          console.log('    ' + String(s.itemMs || s.waitMs || 0).padStart(6) + 'ms  [' + (s.stage || '') + ']  '
            + s.slug.slice(0, 46)
            + (s.timing ? '  nav=' + s.timing.gotoMs + 'ms parse=' + s.timing.parseMs + 'ms html=' + s.timing.htmlLen + ' md=' + s.timing.mdLen : '')
            + (s.navMs !== undefined ? '  nav=' + s.navMs + 'ms wait=' + s.waitMs + 'ms' : ''));
        });
      }
      return { results, failures, blockedCount, tokenRefreshes, degradedCount };
    });

    const store = {
      generatedAt: new Date().toISOString(),
      source: ORIGIN,
      sourceMode: 'beautylish-jsonld',
      declaredTotal: list.declaredTotal,
      count: out.results.length,
      products: out.results,
      failures: out.failures,
    };
    writeJson(EN_FILE, store);

    const noBrand = out.results.filter((p) => !p.brandEn).length;
    const noPrice = out.results.filter((p) => !p.priceText).length;
    const noImg = out.results.filter((p) => !p.images.length).length;
    const brands = new Set(out.results.map((p) => p.brandEn).filter(Boolean));
    console.log('\n[2/2] 写出 ' + path.relative(ROOT, EN_FILE));
    console.log('  商品：' + out.results.length + '；失败：' + out.failures.length);
    console.log('  无品牌：' + noBrand + '；无价格：' + noPrice + '；无图片：' + noImg);
    console.log('  品牌数：' + brands.size);
    if (out.failures.length) {
      console.log('\n失败清单（前 10）：');
      out.failures.slice(0, 10).forEach((f) => console.log('  - ' + f.slug + ' ' + f.error));
    }
  }
})().catch((err) => {
  console.error('\n抓取失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
