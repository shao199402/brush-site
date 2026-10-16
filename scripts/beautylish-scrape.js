#!/usr/bin/env node
'use strict';
/**
 * Beautylish 阶段一：枚举全站商品清单
 *
 * 站点结构（已实测）：
 *   - 列表页 https://www.beautylish.com/shop/browse?page=N，共 85 页
 *   - 每页约 32~38 个商品，商品链接形如 /p/<slug> 或 /s/<slug>
 *   - 商品名/品牌/价格在卡片里是纯文本，详情页 JSON-LD 更可靠
 *
 * 产物：data/beautylish-list.json
 *   { generatedAt, declaredTotal, fetchedPages, lastPage, count, items: [...] }
 *
 * 用法：
 *   node scripts/beautylish-scrape.js --list                 全量枚举
 *   node scripts/beautylish-scrape.js --list --max-pages=5   只抓前 5 页（调试）
 *   node scripts/beautylish-scrape.js --list --resume        跳过已有缓存页
 *
 * 注意：纯 HTTP 请求会被 AWS WAF 挡（403 / 202 挑战页），
 * 必须用真实 Chrome（CDP）访问——见 scripts/lib-cdp.js。
 */

const fs = require('fs');
const path = require('path');
const { withChrome, sleep } = require('./lib-cdp.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'beautylish-list-cache');
const OUT_FILE = path.join(DATA_DIR, 'beautylish-list.json');
const ORIGIN = 'https://www.beautylish.com';
const LIST_PATH = '/shop/browse';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const DO_LIST = argv.includes('--list') || argv.includes('--all') || argv.length === 0;
const MAX_PAGES = Number(argValue('--max-pages') || 0) || 0;
const RESUME = argv.includes('--resume');
const NAV_DELAY = Number(argValue('--nav-delay') || 2000);
const FRESH = argv.includes('--fresh');

/**
 * 屏蔽非必需资源以提速。
 *
 * ⚠️ **不要屏蔽 CSS 与字体**：实测会让 SPA 渲染降级，
 * 详情页正文会出现「所有字母 s 丢失」的坏文本。
 * 也不要屏蔽 awswaf 域（WAF 挑战要用它换 token）。
 */
const BLOCKED_URLS = [
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.mp4', '*.webm',
  '*google-analytics*', '*googletagmanager*', '*googlesyndication*',
  '*doubleclick*', '*attn.tv*', '*attentive*',
  '*segment.io*', '*segment.com*', '*hotjar*', '*clarity.ms*',
];

/** 从列表页抽取商品卡片 */
const CARD_EXPR = `(() => {
  const out = [];
  const seen = new Set();
  const anchors = [...document.querySelectorAll('a[href*="/p/"], a[href*="/s/"]')];
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/^\\/(?:p|s)\\/([a-z0-9][a-z0-9-]*)/i);
    if (!m) continue;
    const slug = m[1];
    if (seen.has(slug)) continue;

    // 往上找卡片容器，拿到品牌/名称/价格/规格
    let card = a;
    for (let i = 0; i < 4 && card.parentElement; i++) {
      card = card.parentElement;
      const t = (card.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t.length > 25) break;
    }
    const txt = (card.innerText || '').replace(/\\s+/g, ' ').trim();
    const img = card.querySelector('img');
    seen.add(slug);
    out.push({
      slug,
      text: txt.slice(0, 220),
      img: img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : ''
    });
  }
  const pager = [...document.querySelectorAll('a[href*="page="]')]
    .map((x) => (x.getAttribute('href') || '').match(/page=(\\d+)/))
    .filter(Boolean).map((x) => Number(x[1]));
  return JSON.stringify({
    url: location.href,
    cards: out,
    lastPage: pager.length ? Math.max(...pager) : 0,
    bodyHead: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200)
  });
})()`;

/** 从卡片文本里拆出品牌 / 名称 / 价格 / 规格 */
function parseCard(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  // 价格：CN¥123 / ¥123 / $12.00 / CN¥170 - CN¥1045
  const priceM = t.match(/(CN¥|¥|\$|US\$)\s?[\d,]+(?:\.\d+)?(?:\s*[-–~]\s*(?:CN¥|¥|\$)?\s?[\d,]+(?:\.\d+)?)?/);
  const priceText = priceM ? priceM[0].replace(/\s+/g, ' ').trim() : '';
  // 规格：如 "25 Shades Available" / "2 Sizes Available"
  const optM = t.match(/(\d+)\s+(Shades?|Sizes?|Colors?|Options?|Palettes?|Sets?|Scents?|Flavors?|Looks?|Editions?)\s+Available/i);
  const optionsText = optM ? optM[0].replace(/\s+/g, ' ').trim() : '';
  return { priceText, optionsText, raw: t };
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log('Beautylish 枚举 · 阶段一');
  const found = new Map();
  const pageReports = [];
  let lastPage = 85;

  await withChrome(async (page) => {
    await page.cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });

    const pages = MAX_PAGES ? Array.from({ length: MAX_PAGES }, (_, i) => i + 1) : null;
    const total = pages ? pages.length : lastPage;

    for (let p = 1; p <= total; p++) {
      const url = ORIGIN + LIST_PATH + (p === 1 ? '' : '?page=' + p);
      const cachePath = path.join(CACHE_DIR, 'page-' + p + '.json');

      let data = null;
      if (!FRESH && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100) {
        try { data = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { data = null; }
      }
      if (!data) {
        await page.goto(url, { wait: 0 });
        const ok = await page.waitFor(
          'document.querySelectorAll(\'a[href*="/p/"], a[href*="/s/"]\').length > 5',
          { timeout: 40000, interval: 700 }
        );
        await sleep(1200);
        if (!ok) {
          console.log('  第 ' + p + ' 页：未加载出商品（可能被限速），跳过');
          pageReports.push({ page: p, count: 0, error: 'no-cards' });
          await sleep(3000);
          continue;
        }
        const raw = await page.eval(CARD_EXPR);
        data = JSON.parse(raw);
        fs.writeFileSync(cachePath, JSON.stringify(data, null, 1), 'utf8');
      }

      if (data.lastPage) lastPage = Math.max(lastPage, data.lastPage);

      let added = 0;
      for (const c of data.cards || []) {
        if (found.has(c.slug)) continue;
        const parsed = parseCard(c.text);
        found.set(c.slug, {
          slug: c.slug,
          brand: '',
          name: '',
          priceText: parsed.priceText,
          optionsText: parsed.optionsText,
          cardText: parsed.raw,
          img: c.img || '',
          page: p,
        });
        added++;
      }
      pageReports.push({ page: p, count: (data.cards || []).length, added });

      if (p % 5 === 0 || p === total) {
        console.log('  进度 ' + p + '/' + total + '  累计商品 ' + found.size + '  最后一页编号 ' + lastPage);
      }
      if (!MAX_PAGES && p >= lastPage) break;
      await sleep(NAV_DELAY);
    }

    if (MAX_PAGES) { /* 调试模式不限页数 */ }
  }, { port: 9500 });

  const items = [...found.values()];
  const out = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    listPath: LIST_PATH,
    declaredTotal: items.length,
    fetchedPages: pageReports.filter((p) => p.count > 0).length,
    lastPage,
    count: items.length,
    items,
    pages: pageReports,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1), 'utf8');

  console.log('\n枚举完成');
  console.log('  商品: ' + items.length + ' 个');
  console.log('  页数: ' + out.fetchedPages + ' / ' + lastPage);
  console.log('  有价格的: ' + items.filter((x) => x.priceText).length);
  console.log('  有规格的: ' + items.filter((x) => x.optionsText).length);
  console.log('  写出: ' + path.relative(ROOT, OUT_FILE));
}

main().catch((e) => { console.error('枚举失败: ' + (e.stack || e)); process.exit(1); });
