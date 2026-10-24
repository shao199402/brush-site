'use strict';
/**
 * Beautylish 价格抓取（走**列表页**，不需要逐件详情页）
 *
 * 为什么不用详情页：
 *   3044 件详情页 × 8 秒 ≈ 6.7 小时，且站点有 WAF 限速（实测连续抓 4.5 小时后
 *   速率从 7.6 秒/件恶化到 36 秒/件）。每晚零点跑一次根本不可行。
 *   而列表页共 85 页（每页 36 件），渲染后价格就在卡片文本里，
 *   85 × 8 秒 ≈ 11 分钟，完全可接受。
 *
 * 纯 HTTP 会被 WAF 挡（实测返回 HTTP 202 空响应），必须用浏览器渲染。
 */

const fs = require('fs');
const path = require('path');
const { withChrome, sleep } = require('./lib-cdp.js');
const { priceBeautylishCard } = require('./price-adapters.js');

const ROOT = path.resolve(__dirname, '..');
const LIST_FILE = path.join(ROOT, 'data', 'beautylish-list.json');

const BLOCKED = [
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.mp4', '*.webm',
  '*google-analytics*', '*googletagmanager*', '*googlesyndication*',
  '*doubleclick*', '*attn.tv*', '*attentive*', '*segment.io*', '*segment.com*',
  '*hotjar*', '*clarity.ms*',
];

/**
 * 在已渲染的列表页里抓「商品 slug → 价格」。
 * 列表页共 85 页，每页约 36 个商品；卡片文本里含价格（CN¥45）。
 */
const CARD_EXPR = `(() => {
  const out = [];
  const seen = new Set();
  // 优先按商品链接取；Beautylish 的商品卡片链接是 /p/<slug> 或 /s/<slug>
  for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/s/"]')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/^\\/(?:p|s)\\/([a-z0-9][a-z0-9-]*)/i);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    // 从最近的卡片容器里取整段文本（价格在卡片里）
    let node = a;
    let text = '';
    for (let d = 0; d < 6 && node; d++) {
      const t = (node.innerText || '').replace(/\\s+/g, ' ').trim();
      if (/CN¥\\s*[\\d,]/.test(t)) { text = t; break; }
      node = node.parentElement;
    }
    if (!text) continue;
    const key = slug + '|' + text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug, cardText: text.slice(0, 300) });
  }
  return JSON.stringify(out);
})()`;

/**
 * 抓全站列表页的价格。
 *
 * 策略（实测数据支撑）：
 *   · 列表页每页约 36 件、渲染约 6~8 秒。85 页即可覆盖全站 3095 件。
 *   · **站点按会话限速**：一个浏览器会话连续翻约 25 页后开始返回空卡片。
 *     实测 6 秒/页的间隔也只能到 25 页（第 30 页为空）。
 *   · 因此采用「**分批 + 换会话**」：每批翻若干页，一旦出现空页就
 *     丢弃整个浏览器、开新会话（新 WAF token）从下一批继续。
 *     这与抓详情时"被挡就重建会话"的思路一致，且已验证有效。
 *   · 详情页补价只在最后对少量缺口做（详情页受限更早，约 10 件后就拦）。
 *
 * 返回 { prices, listTotal, batches }
 */
async function fetchBeautylishPrices(opts = {}) {
  const totalPages = opts.pages || 90;      // 要覆盖的总页数
  const navDelay = opts.navDelay || 4000;   // 页间隔
  const batchPages = opts.batchPages || 22; // 每批最多翻多少页就主动换会话
  const maxBatches = opts.maxBatches || 8;
  const prices = new Map();

  let listTotal = 0;
  let listItems = [];
  try {
    const j = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
    listTotal = j.count || 0;
    listItems = Array.isArray(j.items) ? j.items : [];
  } catch { /* 无清单 */ }

  const CARD_EXPR_LOCAL = CARD_EXPR;
  let nextPage = 1;
  let batches = 0;

  while (nextPage <= totalPages && batches < maxBatches) {
    batches++;
    let produced = 0;
    const startPage = nextPage;
    console.log('  [第 ' + batches + ' 批] 从第 ' + startPage + ' 页开始');

    await withChrome(async (page) => {
      await page.cdp.send('Network.setBlockedURLs', { urls: BLOCKED });
      let inBatch = 0;
      let emptyStreak = 0;
      while (nextPage <= totalPages && inBatch < batchPages) {
        const p = nextPage;
        if (inBatch > 0) await sleep(navDelay);
        try {
          await page.goto('https://www.beautylish.com/shop/browse?page=' + p, { wait: 3500 });
          await sleep(1200);
          const rawStr = await page.eval(CARD_EXPR_LOCAL);
          let rows = [];
          try { rows = JSON.parse(String(rawStr)); } catch { rows = []; }

          let added = 0;
          for (const r of rows) {
            const pv = priceBeautylishCard(r.cardText);
            if (!pv) continue;
            /**
             * 区间价（多个规格）**不参与价格对比**：
             * 卡片上显示 "CN¥45 - CN¥330" 是「最小规格~最大规格」的跨度，
             * 不是单一售价；拿它和本地某个具体规格的价格比会产生大量假变动。
             * 这里照样记录（isRange 标记），但对比环节会跳过。
             */
            if (!prices.has(r.slug)) {
              prices.set(r.slug, pv.isRange
                ? {
                  raw: 'CN¥' + pv.cnyMin + ' - CN¥' + pv.cnyMax,
                  cnyMin: pv.cnyMin,
                  cnyMax: pv.cnyMax,
                  isRange: true,
                  currency: 'CNY',
                  cardText: r.cardText.slice(0, 120),
                }
                : {
                  raw: 'CN¥' + pv.cny,
                  cny: pv.cny,
                  currency: 'CNY',
                  cardText: r.cardText.slice(0, 120),
                });
              added++;
            }
          }
          produced += added;
          if (opts.onPage) opts.onPage(p, added, prices.size, rows.length);

          if (rows.length === 0) {
            emptyStreak++;
            if (emptyStreak >= 2) {
              console.log('    第 ' + p + ' 页连续为空 → 换会话继续');
              nextPage = p;   // 不推进，下批从这页重试
              return;
            }
          } else {
            emptyStreak = 0;
            nextPage = p + 1;
          }
          inBatch++;
        } catch (e) {
          console.log('    第 ' + p + ' 页出错: ' + e.message.slice(0, 50));
          nextPage = p;   // 下批重试
          return;
        }
      }
    }, { port: 9910 + (batches % 5) });
    await sleep(2500);   // 让旧浏览器彻底退出再开新的

    if (produced === 0 && batches > 1) {
      console.log('  本批无产出，停止翻页');
      break;
    }
  }

  // ── 阶段 B：少量缺口走详情页（详情页受限更早，只补少量）──
  const detailLimit = opts.detailLimit == null ? 0 : opts.detailLimit;
  if (detailLimit > 0 && listItems.length) {
    const missing = [];
    for (const it of listItems) {
      const slug = String(it.slug || '').toLowerCase();
      if (!slug) continue;
      let found = false;
      for (const k of prices.keys()) {
        if (k === slug || k.startsWith(slug) || slug.startsWith(k)) { found = true; break; }
      }
      if (!found) missing.push(slug);
    }
    const todo = missing.slice(0, detailLimit);
    if (todo.length) {
      console.log('  阶段 B：' + todo.length + ' 件走详情页补价');
      const DETAIL_EXPR = `(() => {
        const out = { price: '', cur: '' };
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const walk = (x) => {
              if (!x) return;
              if (Array.isArray(x)) { x.forEach(walk); return; }
              if (typeof x === 'object') {
                if (x['@type'] === 'Product' && x.offers) {
                  const o = Array.isArray(x.offers) ? x.offers[0] : x.offers;
                  if (o && o.price != null) { out.price = String(o.price); out.cur = String(o.priceCurrency || ''); return; }
                }
                for (const k of Object.keys(x)) if (k !== '@context') walk(x[k]);
              }
            };
            walk(JSON.parse(s.textContent));
          } catch (e) { /* ignore */ }
        }
        return JSON.stringify(out);
      })()`;
      let ok = 0, fail = 0, done = 0;
      await withChrome(async (page) => {
        await page.cdp.send('Network.setBlockedURLs', { urls: BLOCKED });
        for (const slug of todo) {
          if (done > 0) await sleep(opts.detailDelay || 2500);
          try {
            await page.goto('https://www.beautylish.com/p/' + slug, { wait: 3000 });
            await sleep(1000);
            const j = JSON.parse(String(await page.eval(DETAIL_EXPR)));
            if (j.price && Number(j.price) > 0) {
              const n = Number(j.price);
              prices.set(slug, { raw: 'CN¥' + n, cny: n, currency: j.cur || 'CNY' });
              ok++;
            } else fail++;
          } catch { fail++; }
          done++;
          if (opts.onDetail && done % 10 === 0) opts.onDetail(done, todo.length, prices.size, ok, fail);
        }
      }, { port: 9918 });
      console.log('  详情补价：成功 ' + ok + '，失败 ' + fail);
    }
  }

  return { prices, listTotal, batches };
}

module.exports = { fetchBeautylishPrices };

// 直接运行 = 单独测 Beautylish 取价
if (require.main === module) {
  (async () => {
    console.log('Beautylish 列表页取价（最多 100 页）');
    const t0 = Date.now();
    const { prices, listTotal } = await fetchBeautylishPrices({
      onPage: (p, added, total) => {
        if (p % 5 === 0 || added < 0) {
          console.log('  第 ' + p + ' 页  +' + added + '  累计 ' + total + ' 件  (' + ((Date.now() - t0) / 1000).toFixed(0) + 's)');
        }
      },
    });
    console.log('\n完成：' + prices.size + ' 件有价格（清单共 ' + listTotal + ' 件）');
    console.log('用时 ' + ((Date.now() - t0) / 60000).toFixed(1) + ' 分钟');
    const sample = [...prices.entries()].slice(0, 5);
    console.log('样例:');
    sample.forEach(([s, v]) => console.log('  ' + s.slice(0, 40).padEnd(42) + v.raw));
  })().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
}
