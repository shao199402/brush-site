#!/usr/bin/env node
'use strict';
/**
 * Beautylish：抓「父级品类 tag」下的商品，得到真实的 一级分类
 *
 * 站点结构（实测）：/shop/browse?tag=<tag>&page=N，菜单 79 个 tag，层级为
 *   一级  Makeup / Skincare / Bath and Body / Hair / Fragrance /
 *         Brushes / Tools & Brushes / Wellness
 *   二级  Brows / Cheeks / Eyes / Lips / …（部分二级下还有三级 tag，如 eye-shadow）
 *
 * 我们数据里已有的 `type`（唇妆/眼妆/底妆/…）≈ 二级，所以本脚本只补一级：
 * 抓每个父级 tag 的商品 slug，写入 level1。
 *
 * 站点按会话限速（连续约 20 页后返回空），所以分批换会话。
 *
 * 用法：node scripts/beautylish-tags.js            dry-run
 *       node scripts/beautylish-tags.js --go       写回 beautylish-data.js
 */

const fs = require('fs');
const path = require('path');
const { withChrome, sleep } = require('./lib-cdp.js');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'beautylish-data.js');
const CACHE = path.join(ROOT, 'data', 'beautylish-tags.json');
const GO = process.argv.includes('--go');

const BLOCKED = [
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.mp4', '*.webm',
  '*google-analytics*', '*googletagmanager*', '*doubleclick*', '*attn.tv*',
  '*attentive*', '*segment.io*', '*segment.com*', '*hotjar*', '*clarity.ms*',
];

/** 一级 tag（父级）→ 中文名
 *
 * ⚠️ tag 值必须与站点真实值一致。实测两个易错点：
 *   · `fragrance` 无效 → 站点忽略该 tag、返回全站商品（正确值是 `fragrances`）
 *   · `brushes`   无效 → 同上（正确值是 `makeup-brushes`）
 * 脚本里另有 tagIsValid() 做兜底校验，防止这类「静默返回全站」把数据污染。
 */
const PARENTS = [
  ['makeup', '彩妆'],
  ['skincare', '护肤'],
  ['bath-and-body', '身体护理'],
  ['hair', '美发护发'],
  ['fragrances', '香水'],
  ['makeup-brushes', '化妆刷'],
  ['tools-brushes', '工具与配件'],
  ['wellness', '健康'],
];

const CARDS = `(() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/s/"]')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/^\\/(?:p|s)\\/([a-z0-9][a-z0-9-]*)/i);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return JSON.stringify(out);
})()`;

const PAGE_LIMIT = 18;      // 每个会话最多翻多少页
const MAX_PAGES = 120;      // 单个 tag 最多翻多少页
const SANITY_MAX = 1800;    // 单个 tag 超过这个量必然是无效 tag（返回了全站）

/**
 * 校验 tag 是否真的生效。
 *
 * 踩过的坑：`tag=fragrance` 是无效值（站点实际用的是 `fragrances`），
 * Beautylish 对无效 tag **不报错、直接返回全站商品**，于是「香水」抓出
 * 3131 件——比整个目录（3044）还多，并且把别的 tag 的商品也吞了进来。
 * 判断方法：拿该 tag 的第 1 页与「不带 tag 的默认列表第 1 页」比对，
 * 商品完全一致就说明 tag 被忽略了。
 */
async function tagIsValid(page, tag, baseline) {
  await page.goto('https://www.beautylish.com/shop/browse?tag=' + encodeURIComponent(tag) + '&page=1', { wait: 3500 });
  await sleep(1200);
  const arr = JSON.parse(String(await page.eval(CARDS)));
  if (!arr.length) return { ok: false, reason: '第1页无商品' };
  const same = arr.length === baseline.length && arr.every((s) => baseline.includes(s));
  if (same) return { ok: false, reason: '与默认列表第1页完全相同（tag 被忽略）' };
  return { ok: true, count: arr.length };
}

(async () => {
  const result = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const done = new Set(Object.keys(result));
  console.log('已有缓存 tag: ' + done.size + ' 个');

  for (const [tag, zh] of PARENTS) {
    if (done.has(tag)) { console.log('  = 跳过 ' + tag + '（已抓 ' + result[tag].length + ' 件）'); continue; }

    // 先校验 tag 有效性（用同一个浏览器会话取默认页作基线）
    let valid = null;
    await withChrome(async (p) => {
      await p.cdp.send('Network.setBlockedURLs', { urls: BLOCKED });
      await p.goto('https://www.beautylish.com/shop/browse', { wait: 4000 });
      await sleep(1500);
      const baseline = JSON.parse(String(await p.eval(CARDS)));
      console.log('    基线（默认列表第1页）' + baseline.length + ' 件');
      valid = await tagIsValid(p, tag, baseline);
    }, { port: 9948 });
    if (!valid.ok) {
      console.log('  ✗ 跳过 ' + zh + '（' + tag + '）：' + valid.reason);
      result[tag] = [];
      fs.writeFileSync(CACHE, JSON.stringify(result, null, 1), 'utf8');
      await sleep(1500);
      continue;
    }
    console.log('  ✓ ' + tag + ' 校验通过（第1页 ' + valid.count + ' 件）');

    const slugs = new Set();
    let page = 1, batches = 0;
    while (page <= MAX_PAGES && batches < 12) {
      batches++;
      const startPage = page;
      let produced = 0;
      await withChrome(async (p) => {
        await p.cdp.send('Network.setBlockedURLs', { urls: BLOCKED });
        let inBatch = 0, emptyStreak = 0;
        while (page <= MAX_PAGES && inBatch < PAGE_LIMIT) {
          const cur = page;
          try {
            await p.goto('https://www.beautylish.com/shop/browse?tag=' + encodeURIComponent(tag) + '&page=' + cur, { wait: 3500 });
            await sleep(1200);
            const arr = JSON.parse(String(await p.eval(CARDS)));
            let added = 0;
            for (const s of arr) if (!slugs.has(s)) { slugs.add(s); added++; }
            produced += added;
            if (arr.length === 0) {
              emptyStreak++;
              if (emptyStreak >= 2) return;   // 换会话
            } else {
              emptyStreak = 0;
              page = cur + 1;
            }
            inBatch++;
          } catch {
            return;   // 出错就换会话，下次从同一页重试
          }
        }
      }, { port: 9950 + (batches % 5) });
      await sleep(2000);
      if (produced === 0 && page > startPage) break;
      if (produced === 0 && page === startPage) break;
      console.log('    ' + tag + ' 第' + batches + '批：累计 ' + slugs.size + ' 件（到第 ' + page + ' 页）');
    }
    result[tag] = [...slugs];
    fs.writeFileSync(CACHE, JSON.stringify(result, null, 1), 'utf8');
    console.log('  ✅ ' + zh + '（' + tag + '）' + slugs.size + ' 件');
  }

  // 汇总：slug → 一级
  const slugToLevel1 = new Map();
  for (const [tag, zhName] of PARENTS) {
    for (const s of result[tag] || []) {
      if (!slugToLevel1.has(s)) slugToLevel1.set(s, new Set());
      slugToLevel1.get(s).add(zhName);
    }
  }
  console.log('\n有父级归属的商品: ' + slugToLevel1.size);

  if (!GO) { console.log('（dry-run。加 --go 写回）'); return; }

  // 写回数据
  const src = fs.readFileSync(DATA, 'utf8');
  const m = src.match(/window\.PRODUCTS\s*=\s*(\[[\s\S]*\])\s*;/);
  if (!m) throw new Error('beautylish-data.js 结构未识别');
  const products = JSON.parse(m[1]);

  let hit = 0;
  for (const p of products) {
    const slug = String(p.handle || '').replace(/^beautylish-/, '');
    let l1 = null;
    if (slugToLevel1.has(slug)) l1 = [...slugToLevel1.get(slug)];
    else {
      // 前缀匹配（本地 slug 可能带规格后缀）
      for (const [s, v] of slugToLevel1) {
        if (s.startsWith(slug) || slug.startsWith(s)) { l1 = [...v]; break; }
      }
    }
    if (l1 && l1.length) {
      p.level1 = l1[0];
      p.dimensions = { sub: p.type ? [p.type] : [] };
      hit++;
    } else {
      p.level1 = '其他';
      p.dimensions = { sub: p.type ? [p.type] : [] };
    }
  }
  console.log('有真实一级归属: ' + hit + ' / ' + products.length);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(ROOT, 'data', 'beautylish-data.js.bak-' + stamp), src, 'utf8');
  const out = src.slice(0, m.index) + 'window.PRODUCTS = ' + JSON.stringify(products, null, 1) + ';' + src.slice(m.index + m[0].length);
  fs.writeFileSync(DATA, out, 'utf8');
  console.log('已备份 bak-' + stamp + '，已写回 beautylish-data.js（' + (fs.statSync(DATA).size / 1048576).toFixed(1) + ' MB）');
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
