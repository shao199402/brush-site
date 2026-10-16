#!/usr/bin/env node
'use strict';
/**
 * Beautylish 阶段一（详情）：抓取商品详情
 *
 * ⚠️ 本脚本的核心设计来自一次失败的排查——**不要改回"在页面里求值取文本"**。
 *
 * 问题现象：抓到的正文里**所有字母 s 都消失**
 *   "Flora Drip Di pen er"（本应是 Dispenser）
 * 试过的无效方案：readStable（连续读稳定值）、先验 DOM 再读、
 *   把导航间隔拉长到 25 秒、长时间冷却——全部失败。
 * 根因：该站是 SPA，正文有一段「缺字中间态」；用 CDP 在页面内求值
 *   取文本时会反复读到那个中间态。
 * 解法：**让浏览器交出渲染后的 HTML，解析全部在 Node 里做**。
 *   实测同一页在 5 个时间点（0/5/12/20/30 秒）读到的 HTML
 *   解析结果完全一致且干净（s 占比 0.0543）。
 *
 * 另一个坑：**不要屏蔽 CSS 与字体**。屏蔽后 SPA 渲染会降级，
 * 正文直接变成空或出现缺字；也不要屏蔽 awswaf 域（WAF 挑战要靠它换 token）。
 *
 * 用法：
 *   node scripts/beautylish-scrape.js --detail --limit=20 --fresh
 *   node scripts/beautylish-scrape.js --detail              全量（跳过已缓存）
 *   node scripts/beautylish-scrape.js --detail --no-images  不下图
 *
 * 产物：data/beautylish-cache/<slug>.json（逐个落盘，可断点续跑）
 *       data/beautylish-en.json（收尾时一次性汇总）
 */

const fs = require('fs');
const path = require('path');
const { withChrome, withChromeReusable, sleep } = require('./lib-cdp.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LIST_FILE = path.join(DATA_DIR, 'beautylish-list.json');
const CACHE_DIR = path.join(DATA_DIR, 'beautylish-cache');
const OUT_FILE = path.join(DATA_DIR, 'beautylish-en.json');
/** 已下架商品清单（发现即追加，避免中断丢失） */
const GONE_FILE = path.join(DATA_DIR, 'beautylish-gone.json');
const ASSET_DIR = path.join(ROOT, 'assets', 'beautylish');
const ASSET_REL = 'assets/beautylish';
const ORIGIN = 'https://www.beautylish.com';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const DO_DETAIL = argv.includes('--detail') || argv.includes('--all') || argv.length === 0;
const LIMIT = Number(argValue('--limit') || 0) || 0;
const OFFSET = Number(argValue('--offset') || 0) || 0;
const FRESH = argv.includes('--fresh');
const NO_IMG = argv.includes('--no-images');
/** --timing：打印慢件的时间分解，用于定位性能问题 */
const TIMING = argv.includes('--timing');
const NAV_DELAY_MS = Number(argValue('--nav-delay') || 3000);

/**
 * 屏蔽非必需资源。**保留 CSS / 字体 / awswaf**（原因见文件头注释）。
 */
const BLOCKED_URLS = [
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.mp4', '*.webm',
  '*google-analytics*', '*googletagmanager*', '*googlesyndication*',
  '*doubleclick*', '*attn.tv*', '*attentive*',
  '*segment.io*', '*segment.com*', '*hotjar*', '*clarity.ms*',
];

// ---------------------------------------------------------------- Node 侧 HTML 解析
//
// 全部解析在这里做，不在页面里做（见文件头）。

const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'wbr']);

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

function innerHtmlByClass(html, tag, cls) {
  const outer = outerHtmlByClass(html, tag, cls);
  if (!outer) return null;
  const m = /^<[a-zA-Z][^>]*>/.exec(outer);
  if (!m) return null;
  const close = (outer.match(/<\/[a-zA-Z]+\s*>$/) || [''])[0];
  return outer.slice(m[0].length, outer.length - close.length);
}

function decodeEntities(s) {
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z#0-9]+);/g, (x, n) => (ENT[n] !== undefined ? ENT[n] : x));
}

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

/** 从渲染后的 HTML 快照解析详情（全部在 Node 侧做） */
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
  const canon = (html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i) || [])[1];
  out.url = canon || (ORIGIN + '/p/' + slug);

  // JSON-LD：取 @type=Product 与 offer
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

  // 详情区块：<h2>标题</h2> 之后容器里的 .markdown_content
  const headings = [...html.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  for (let i = 0; i < headings.length; i++) {
    const title = htmlToText(headings[i][2]);
    if (!title || title.length > 60 || out.sections[title]) continue;
    const segStart = headings[i].index + headings[i][0].length;
    const segEnd = i + 1 < headings.length ? headings[i + 1].index : html.length;
    const seg = html.slice(segStart, segEnd);
    const md = innerHtmlByClass(seg, 'div', 'markdown_content');
    if (md === null) continue;
    const text = htmlToText(md);
    if (text) out.sections[title] = text.slice(0, 6000);
  }

  // 变体（色号/规格）
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
  const m = String(url).match(/\.(jpe?g|png|gif|webp|avif)(?:\?|$)/i);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  return 'jpg';
}

async function downloadImage(url, absPath) {
  if (fs.existsSync(absPath)) return 'exists';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: ORIGIN + '/' },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return 'fail';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return 'fail';
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buf);
    return 'saved';
  } catch { return 'fail'; }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!fs.existsSync(LIST_FILE)) {
    console.error('缺少枚举结果 ' + path.relative(ROOT, LIST_FILE));
    console.error('请先运行：node scripts/beautylish-scrape.js --list');
    process.exit(1);
  }
  const list = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!NO_IMG) fs.mkdirSync(ASSET_DIR, { recursive: true });

  console.log('Beautylish 详情 · 阶段一');
  console.log('枚举商品：' + list.items.length);

  const startIdx = Math.min(OFFSET, list.items.length);
  let items = (LIMIT || OFFSET)
    ? list.items.slice(startIdx, LIMIT ? startIdx + LIMIT : undefined)
    : list.items;

  /**
   * --breadth-first：把枚举顺序重排成「广度优先」。
   *
   * 为什么需要：Beautylish 的列表页是**按品牌分组**的，直接按枚举顺序抓，
   * 前 100 多件会全落在同一家（实测前 94 件都是 Good Molecules），
   * 于是构建出的目录里只有一个品牌，其余 3000 件全成了"其他品牌"。
   * 广度优先让**每个品牌先各出一件**，品牌维度尽快铺开；
   * 这对「边抓边看效果」与「中途被中断也想有可用结果」都更友好。
   *
   * 注意这只是**抓取顺序**，不改变最终数据集合。
   */
  if (argv.includes('--breadth-first')) {
    const groups = new Map();
    for (const it of items) {
      // 卡片文本形如 "BRAND Name CN¥45 3 Options Available"，
      // 取开头连续的全大写词作为品牌分组依据（仅用于排序，不进数据）
      const m = String(it.cardText || '').match(/^((?:[A-Z0-9][A-Z0-9&'’.\-]*\s+){0,3})/);
      const key = m ? m[1].trim() || '(未知)' : '(未知)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    // 轮转：每轮从每个品牌取一件
    const order = [];
    const buckets = [...groups.values()];
    const maxLen = Math.max(...buckets.map((b) => b.length));
    for (let i = 0; i < maxLen; i++) {
      for (const b of buckets) if (b[i]) order.push(b[i]);
    }
    console.log('广度优先重排：' + groups.size + ' 个品牌分组，' + order.length + ' 件');
    items = order;
  }

  console.log('本次处理：' + items.length + ' 个' + (OFFSET ? '（从第 ' + (startIdx + 1) + ' 个开始）' : ''));

  const tStart = Date.now();
  const results = [];
  const failures = [];
  /** 已下架商品（页面重定向到品牌页等），不参与重试、也不计入失败 */
  const goneItems = [];

  /**
   * 在**已有会话**里抓一件，返回 { rec, blocked, gone, timeout }。
   *
   * ⚠️ 两条关键经验（都来自实测）：
   *   1) 被挡时要在**全新会话**里重试——旧 WAF token 不会自己恢复。
   *      早先在失效会话里反复等（5→10→15s、冷却 60s），单件能拖到 146~620 秒。
   *      现在改为：判定被挡 → 外层丢弃会话、换新会话重试。
   *   2) 会话要跨件复用。每件新建+销毁约 0.9 秒，3095 件白花约 46 分钟。
   */
  const fetchOneInSession = async (page, pendingItem) => {
    /**
     * 硬超时保险：单件总时限，超时就判失败并丢弃会话。
     *
     * 为什么需要：实测出现过整个抓取进程**无声挂起 7 分钟以上**、
     * CPU 几乎不动的情况——某个 CDP 调用或页面等待卡住，
     * 而进程"活着"，守护脚本的存活检测也发现不了。
     * 用 Promise.race 包一层，最坏只是丢一件，不会让整轮停摆。
     */
    const HARD_TIMEOUT_MS = 90000;
    let hardTimer = null;
    const timeoutResult = new Promise((resolve) => {
      hardTimer = setTimeout(() => {
        console.log('    [硬超时] ' + pendingItem.slug + ' 超过 ' + (HARD_TIMEOUT_MS / 1000) + 's，放弃本件并重建会话');
        resolve({ rec: null, blocked: true, timeout: true });
      }, HARD_TIMEOUT_MS);
    });

    const work = (async () => {
      /**
       * ⚠️ 这里用 withChrome（**每件一个独立会话**），而不是复用会话。
       *
       * 原因（实测踩坑）：硬超时用的是 Promise.race。超时触发后，抛在身后的
       * 那次抓取仍在运行、并持有会话的 page。如果多件共用同一个 page，
       * 孤儿任务与下一件的抓取会互相干扰 → 整轮挂死
       * （实测：抓取进程活着但缓存 35 分钟零增长）。
       * 会话独立时，超时后整个浏览器被丢弃，孤儿任务随页面一起消失。
       *
       * 代价是每件多约 0.9 秒（建立+清理）。全量约多花 46 分钟，
       * 但换来的是**不会卡死**——这个取舍是值得的。
       */
      const r = await withChrome(async (page) => {
        await page.cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });
        let nextNavAt = 0;
        const pace = async () => {
          const w = nextNavAt - Date.now();
          if (w > 0) await sleep(w);
          nextNavAt = Date.now() + NAV_DELAY_MS;
        };

      // 单件：最多在同会话内试 2 次（首次 + 一次快速重载）
      for (let attempt = 1; attempt <= 2; attempt++) {
        await pace();
        const t0 = Date.now();
        await page.goto(ORIGIN + '/p/' + pendingItem.slug, { wait: 0 });

        /**
         * 重定向处理：`/p/<slug>` 可能被跳到两类页面。
         *
         *   A) `/s/<slug>-<变体>` —— **仍是商品页**（带具体色号/规格）。
         *      枚举只拿到了父 slug（如 /p/kitsch-flat-lay-claw-clips），
         *      实际商品在变体页（/s/kitsch-flat-lay-claw-clips-terracotta）。
         *      这类要**继续抓**，否则会白丢商品。
         *   B) `/b/<品牌>` 等 —— 商品确实已下架，页面没有正文，判为 gone。
         *
         * 注意这是**客户端路由跳转**，发生在 goto 返回之后（刚导航完
         * location.pathname 可能还是 /p/…），所以要轮询最多 3 秒；
         * 正常商品通常 <1 秒就出正文，这点等待不会明显拖慢。
         */
        let finalPath = '';
        for (let w = 0; w < 10; w++) {
          finalPath = await page.eval('location.pathname', { retries: 0 }).catch(() => '');
          if (finalPath && !/^\/p\//.test(String(finalPath))) break;
          const hasMd = await page.eval(
            'Boolean(document.querySelector(".markdown_content"))', { retries: 0 }
          ).catch(() => false);
          if (hasMd) break;
          await sleep(300);
        }
        if (finalPath && !/^\/p\//.test(String(finalPath))) {
          if (/^\/s\//.test(String(finalPath))) {
            // 变体页：仍是商品页，跟着跳过去继续抓
            if (TIMING) console.log('      [变体页] ' + pendingItem.slug + ' → ' + finalPath);
            await page.goto(ORIGIN + finalPath, { wait: 0 });
          } else {
            console.log('    [已下架] ' + pendingItem.slug + ' → 跳转到 ' + finalPath);
            return { rec: null, blocked: false, gone: true, redirectedTo: finalPath };
          }
        }

        const tNav = Date.now();
        /**
         * 就绪判定：`.markdown_content` 出现且**不是只有小标题**。
         *
         * 原先是「长度 > 40」。实测有一件商品
         * （kitsch-microfiber-face-towels）的正文区块只有 35 字符——
         * 正好是 "About Kitsch Microfiber Face Towels" 这个小标题本身，
         * 站点确实没有更多正文。于是就绪判定永远不成立，
         * 该件被重试 5 次后判失败（还会白等 5 × 25 秒）。
         *
         * 因此改为「**不处于缺字中间态**」：
         * 只要 markdown_content 存在，且文本不是明显的水合残缺态即可通过。
         * 判据：长度 >= 20，且 s 字母占比正常（水合中间态会丢字母 s）。
         * 这样「只有小标题」的页面能通过，而真正的残缺态仍会被拦下。
         */
        const ready = await page.waitFor(
          '(() => {'
          + ' const m=document.querySelector(".markdown_content");'
          + ' if(!m) return false;'
          + ' const t=(m.textContent||"").replace(/\\s+/g," ").trim();'
          + ' if(t.length < 20) return false;'
          + ' const letters=(t.match(/[A-Za-z]/g)||[]).length;'
          + ' const sCount=(t.match(/[sS]/g)||[]).length;'
          // 字母太少（纯标题/纯符号）不据以判残缺；字母够多时要求 s 占比正常
          + ' if(letters >= 60 && (sCount/letters) < 0.015) return false;'
          + ' return true;'
          + ' })()',
          { timeout: 25000, interval: 500 }
        );
        const tReady = Date.now();
        if (TIMING && (tNav - t0 > 6000 || tReady - tNav > 6000)) {
          console.log('      [计时] nav=' + (tNav - t0) + 'ms 就绪=' + (tReady - tNav) + 'ms  ' + pendingItem.slug);
        }
        if (!ready) {
          console.log('    [被挡] ' + pendingItem.slug + ' 正文未就绪（' + ((Date.now() - t0) / 1000).toFixed(0) + 's），需重建会话');
          return { rec: null, blocked: true };
        }
        await sleep(900);   // 渲染稳定窗口

        const html = await page.html();
        const rec = parseDetailHtml(html, pendingItem.slug);
        const mdText = htmlToText((rec.sections && rec.sections['Product Description']) || '');
        if (!textLooksHealthy(mdText)) {
          console.log('    [缺字] s 占比 ' + (sRatioOf(mdText) || 0).toFixed(4) + '，需重建会话');
          return { rec: null, blocked: true };
        }
        return { rec, blocked: false };
        }
        return { rec: null, blocked: true };
      }, { port: 9501 + (sessionIdx++ % 8) });
      return r;
    })();

    const settled = await Promise.race([work, timeoutResult]);
    if (hardTimer) clearTimeout(hardTimer);
    return settled;
  };

  // 外层循环：逐个商品处理
  //
  // ⚠️ 架构决策：**每件一个独立浏览器会话**（不用会话复用）。
  //
  // 复用会话能省约 0.9 秒/件（全量约 46 分钟），但实测会导致**整轮挂死**：
  // 硬超时用 Promise.race 实现，超时后抛在身后的抓取仍持有共享的 page，
  // 与下一件的抓取互相干扰，最终进程活着但缓存长时间零增长。
  // 会话独立时，超时后整个浏览器被丢弃，孤儿任务随页面一起消失。
  // 稳定性优先——选择每件新建会话。
  let sessionIdx = 0;
  let blockedTotal = 0;
  let degradedCount = 0;

  /** 抓单件（内部自建会话，超时后该会话被整体丢弃） */
  const keepAlive = async () => { /* 占位：不再需要显式会话管理 */ };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cachePath = path.join(CACHE_DIR, item.slug + '.json');
    let rec = null;
    const tItem = Date.now();
    if (TIMING) console.log('  [' + new Date().toISOString().slice(11, 19) + '] 开始第 ' + (i + 1) + ' 件: ' + item.slug);

    /**
     * 即时进度日志：每件都写一行「[item] 序号 slug」到 stdout。
     *
     * 为什么需要：原来只在每 20 件时输出进度，一旦卡住（实测发生过多次）
     * 就只能看到「进度 1720/3095」这种滞后信息，无法判断**卡在哪一件**。
     * 现在日志的最后一行就是正在处理（或刚处理完）的商品，
     * 排查时一眼可见。
     */
    if ((i + 1) % 1 === 0) {
      console.log('[item] ' + (i + 1) + '/' + items.length + ' ' + item.slug
        + (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 200 ? ' (cached)' : ''));
    }

    try {
      // 已缓存的直接复用
      if (!FRESH && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 200) {
        rec = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      } else {
        for (let round = 1; round <= 5; round++) {
          const tRound = Date.now();
          const r = await fetchOneInSession(null, item);
          if (TIMING) {
            console.log('      [计时] ' + new Date().toISOString().slice(11, 19) + ' 第' + round + '轮 '
              + (Date.now() - tRound) + 'ms  blocked=' + r.blocked + ' gone=' + r.gone);
          }
          if (r.rec) { rec = r.rec; break; }
          if (r.gone) { goneItems.push(item.slug); break; }
          // 被挡/超时：下一轮会用**全新会话**重试（新会话会拿新 token）
          blockedTotal++;
          await sleep(Math.min(2000 * round, 8000));
        }
        if (!rec && !goneItems.includes(item.slug)) {
          throw new Error('换 5 次会话仍未取到健康正文');
        }
        if (rec) {
          fs.writeFileSync(cachePath, JSON.stringify(rec, null, 1), 'utf8');
        } else {
          // 已下架：**立即追加写入清单**，而不是等抓取结束才汇总。
          // 原因：抓取可能被中断（实测发生过），若只在结尾写，
          // 中途发现的下架记录会丢失，下次重跑要重新探测一遍（每件约 3 秒）。
          try {
            let list = [];
            try { list = JSON.parse(fs.readFileSync(GONE_FILE, 'utf8')); } catch { list = []; }
            if (!list.includes(item.slug)) {
              list.push(item.slug);
              fs.writeFileSync(GONE_FILE, JSON.stringify(list, null, 1), 'utf8');
            }
          } catch { /* 写失败不影响主流程 */ }
          continue;
        }
      }

      if (TIMING && Date.now() - tItem > 12000) {
        console.log('      [计时] 本件端到端 ' + (Date.now() - tItem) + 'ms   ' + item.slug);
      }

      const prod = rec.product || {};
      const offer = rec.offer || {};
      const images = [];
      // 图片来自 JSON-LD（cloudfront）。列表页图片被屏蔽了，取不到。
      const rawImgs = Array.isArray(prod.image) ? prod.image : (prod.image ? [prod.image] : []);
      for (const u of rawImgs) {
        if (!/^https?:/i.test(u)) continue;
        let big = String(u);
        // 详情页常给缩略图尺寸，换成更大的
        big = big.replace(/p_\d+x\d+/, 'p_500x500');
        if (!images.includes(big)) images.push(big);
      }

      const saved = [];
      if (!NO_IMG && images.length) {
        const one = images[0];
        const rel = ASSET_REL + '/' + item.slug + '-1.' + imageExt(one);
        const st = await downloadImage(one, path.join(ROOT, rel.split('/').join(path.sep)));
        if (st === 'saved' || st === 'exists') saved.push(rel);
      }

      const brandName = prod.brand ? String(prod.brand.name || prod.brand) : '';
      results.push({
        slug: item.slug,
        title: String(prod.name || '').trim(),
        brand: brandName,
        price: offer.price != null ? String(offer.price) : '',
        priceCurrency: offer.priceCurrency || '',
        sku: prod.sku || '',
        gtin: prod.gtin || '',
        images: saved,
        imageUrls: images,
        ldDescription: rec.ldDescription || '',
        sectionsEn: rec.sections || {},
        variants: rec.variants || [],
        sourceUrl: rec.url || (ORIGIN + '/p/' + item.slug),
        card: { priceText: item.priceText || '', optionsText: item.optionsText || '', text: item.cardText || '' },
      });
    } catch (err) {
      failures.push({ slug: item.slug, error: err.message });
    }

    if ((i + 1) % 20 === 0 || i + 1 === items.length) {
      const rate = ((Date.now() - tStart) / (i + 1) / 1000).toFixed(1);
      const eta = Math.round((items.length - i - 1) * Number(rate) / 60);
      console.log('  进度 ' + (i + 1) + '/' + items.length
        + '（成功 ' + results.length + '，失败 ' + failures.length
        + '，被挡后重建会话 ' + blockedTotal + ' 次）'
        + '  ' + rate + 's/件  剩余约 ' + eta + ' 分钟');
    }
  }

  const store = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    sourceMode: 'beautylish-jsonld+html',
    note: '正文由「渲染后 HTML + Node 侧解析」得到，避免 SPA 缺字中间态',
    count: results.length,
    products: results,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 1), 'utf8');

  console.log('\n完成');
  console.log('  成功 ' + results.length + '，失败 ' + failures.length
    + (goneItems.length ? '，已下架 ' + goneItems.length : ''));
  console.log('  被挡后重建会话：' + blockedTotal + ' 次');
  if (goneItems.length) {
    // 记录下架清单，供构建阶段排除（避免页面上出现空壳商品）
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'beautylish-gone.json'), JSON.stringify(goneItems, null, 1), 'utf8');
      console.log('  已下架清单：' + path.relative(ROOT, path.join(DATA_DIR, 'beautylish-gone.json')));
    } catch { /* ignore */ }
  }
  console.log('  写出 ' + path.relative(ROOT, OUT_FILE));
  if (failures.length) {
    console.log('  失败清单（前 10）:');
    failures.slice(0, 10).forEach((f) => console.log('    ' + f.slug + '  ' + f.error));
  }
}

main().catch((e) => { console.error('抓取失败: ' + (e.stack || e)); process.exit(1); });

// 进程退出前打印生命周期时间线（定位"墙钟远大于内部计时"的问题）
if (process.env.CDP_TIMING) {
  const t0 = Date.now();
  process.on('exit', () => {
    console.error('[life] 进程已运行 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's（exit 事件）');
  });
  process.on('beforeExit', () => {
    console.error('[life] 事件循环已空，运行 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's（beforeExit）');
  });
}
