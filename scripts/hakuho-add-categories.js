#!/usr/bin/env node
'use strict';
/**
 * 白凤堂：补齐多维分类（categories 字段）
 *
 * 背景：白凤堂官网有 65 个 Shopify 集合，按三个维度组织：
 *   シリーズから選ぶ（系列）/ 用途から選ぶ（用途）/ 毛質から選ぶ（毛质）
 * 同一商品同时归属多个维度（实测 G系列 ∩ 粉刷 = 33 件，G系列 ∩ 灰松鼠 = 75 件）。
 * 而我们的 catalog-data.js 只有扁平的 type（10 个值），完全没有维度信息。
 *
 * 本脚本**不重新抓取商品**，只做增量补充：
 *   1) 读 /collections.json 拿 65 个集合
 *   2) 逐集合读 /collections/<handle>/products.json 拿成员商品
 *   3) 按维度归类，翻译成中文（站内是中文界面，搜索也该用中文命中）
 *   4) 把 categories 数组写回 catalog-data.js
 *
 * 用法：node scripts/hakuho-add-categories.js            （dry-run，只报告）
 *       node scripts/hakuho-add-categories.js --go       （真正写回）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'catalog-data.js');
const BACKUP_DIR = path.join(ROOT, 'data');
const GO = process.argv.includes('--go');

const BASE = 'https://hakuho-do.co.jp';
const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en;q=0.9',
};

/**
 * 三个维度的集合 handle 列表 —— 来自站点导航菜单的实测提取
 * （a.site-nav__link 13 个 → a.site-nav__dropdown-link 52 个）
 */
const DIM = {
  series: [
    's100-vermillion', 's100-black', '200', 'k', 'g', 'j', 'i',
    'ougi', 'kebo', 'kokutan', 'blacklogo', 'traditional',
    'kinokoandfan', 'onthego', 'retractable-lip', 'basics', 'selections', 'set',
  ],
  use: [
    'finishing', 'powder', 'blush', 'eyeshadow-eyelid', 'eyeshadow-crease',
    'eyeliner', 'highlighter', 'eyebrow', 'lip', 'foundation', 'concealer', 'other',
  ],
  hair: [
    'goat', 'bluesquirrel', 'kazansquirrel', 'pinesquirrel', 'canadiansquirrel',
    'weasel', 'kolinsky', 'tamage', 'horse', 'waterbadger', 'syntheticfiber',
  ],
};

/** 大类（product_type 层面）的集合 */
const MAIN = [
  'makeup-brushes', 'calligraphy-brushes', 'japanese-painting-brushes',
  'artist-brushes', 'professional-use', 'fudebako', 'tools',
  'cosmetics', 'cases', 'makeuptool', 'cleaning-brushes', 'kimono',
  'kebo-goldleaf', 'basics-selections', 'set',
  // 目的型（首页「目的から商品を探す」）
  'makeup', 'gift', 'draw-and-paint', 'store-and-onthego', 'for-professional-use',
];

/** 集合标题 → 中文（站内是中文界面，中文才能被搜索命中） */
const ZH = {
  // 大类
  'makeup-brushes': '化妆刷', 'calligraphy-brushes': '书法笔',
  'japanese-painting-brushes': '日本画笔', 'artist-brushes': '西洋画笔·水彩',
  'professional-use': '工作笔', 'fudebako': '杂志《笔盒》', 'tools': '精选杂货',
  'cosmetics': '化妆品', 'cases': '收纳包与笔盒', 'makeuptool': '化妆工具',
  'cleaning-brushes': '清洁与佛坛用笔', 'kimono': '和服用笔',
  'kebo-goldleaf': '笔头与金箔用', 'basics-selections': 'Basics/Selections',
  'makeup': '化妆用', 'gift': '送礼', 'draw-and-paint': '书写·绘画·工作',
  'store-and-onthego': '收纳', 'for-professional-use': '保养',
  // 系列
  's100-vermillion': 'S100系列 朱轴', 's100-black': 'S100系列 黑轴',
  '200': '200系列', 'k': 'K系列', 'g': 'G系列', 'j': 'J系列', 'i': 'I系列',
  'ougi': '扇家族系列', 'kebo': '笔头家族系列', 'kokutan': '黑檀系列',
  'blacklogo': '黑标', 'traditional': '传统化妆刷',
  'kinokoandfan': '蘑菇笔·扇笔', 'onthego': '便携款',
  'retractable-lip': '便携唇刷', 'basics': '化妆刷 Basics',
  'selections': '化妆刷 Selections', 'set': '化妆刷套装',
  // 用途
  'finishing': '定妆', 'powder': '粉刷', 'blush': '腮红',
  'eyeshadow-eyelid': '眼影（打底）', 'eyeshadow-crease': '眼影（晕染）',
  'eyeliner': '眼线', 'highlighter': '高光', 'eyebrow': '眉刷',
  'lip': '唇刷', 'foundation': '粉底', 'concealer': '遮瑕', 'other': '其他用途',
  // 毛质
  'goat': '山羊毛', 'bluesquirrel': '灰松鼠毛', 'kazansquirrel': '喀山松鼠毛',
  'pinesquirrel': '松松鼠毛', 'canadiansquirrel': '加拿大松鼠毛',
  'weasel': '鼬毛', 'kolinsky': '科林斯基貂毛', 'tamage': '玉毛（猫毛）',
  'horse': '马毛', 'waterbadger': '水獭毛', 'syntheticfiber': '合成纤维',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      if (i < tries) await sleep(800 * i);
    }
  }
  throw new Error(last ? last.message : '未知错误');
}

(async () => {
  // ① 读现有数据
  const src = fs.readFileSync(DATA_FILE, 'utf8');
  const m = src.match(/window\.PRODUCTS\s*=\s*(\[[\s\S]*\])\s*;/);
  if (!m) throw new Error('catalog-data.js 结构未识别');
  const products = JSON.parse(m[1]);
  console.log('现有商品: ' + products.length + ' 件');
  const byHandle = new Map(products.map((p) => [String(p.handle).toLowerCase(), p]));

  // ② 读集合清单
  console.log('\n读取集合清单…');
  const cj = await getJson(BASE + '/collections.json?limit=250&page=1');
  const collections = cj.collections || [];
  console.log('集合数: ' + collections.length);
  const titleOf = new Map(collections.map((c) => [c.handle, c.title]));

  // ③ 逐集合取成员
  const targets = collections.filter((c) =>
    DIM.series.includes(c.handle) || DIM.use.includes(c.handle) ||
    DIM.hair.includes(c.handle) || MAIN.includes(c.handle));
  console.log('需要抓成员的集合: ' + targets.length + ' 个（其余 ' + (collections.length - targets.length) + ' 个跳过）\n');

  const membership = new Map();   // handle → Set(collectionHandle)
  let done = 0;
  for (const c of targets) {
    let page = 1, fetched = 0;
    while (page <= 10) {
      let j;
      try {
        j = await getJson(BASE + '/collections/' + encodeURIComponent(c.handle) + '/products.json?limit=250&page=' + page);
      } catch (e) {
        console.log('  ✗ ' + c.handle + ' 第' + page + '页失败: ' + e.message);
        break;
      }
      const list = j.products || [];
      if (!list.length) break;
      for (const p of list) {
        const h = String(p.handle).toLowerCase();
        if (!membership.has(h)) membership.set(h, new Set());
        membership.get(h).add(c.handle);
      }
      fetched += list.length;
      if (list.length < 250) break;
      page++;
      await sleep(150);
    }
    done++;
    if (done % 10 === 0 || done === targets.length) {
      console.log('  进度 ' + done + '/' + targets.length + '（' + c.handle + ' ' + fetched + ' 件）');
    }
    await sleep(150);
  }

  console.log('\n有集合归属的商品: ' + membership.size + ' / ' + byHandle.size);

  // ④ 归类
  let withDim = 0, withSeries = 0, withUse = 0, withHair = 0, noMembership = 0;
  const stats = { series: {}, use: {}, hair: {} };

  for (const [handle, p] of byHandle) {
    const cols = membership.get(handle);
    /**
     * 无集合归属的商品（实测 3 件，多为刚上架还没归入集合的新品）
     * 也要给出数组，避免 categories 是 undefined —— 前端会做
     * `Array.isArray(product.categories)` 判断，undefined 会让它
     * 退化成只用 type 搜索，虽然没有错但语义不一致。
     */
    if (!cols) {
      noMembership++;
      p.categories = p.type ? [p.type] : [];
      p.dimensions = { series: [], use: [], hair: [] };
      continue;
    }
    const cats = [];
    /**
     * dimensions：**结构化的三维归属**，供前端做「按维度筛选」下拉框。
     * categories 是扁平数组（用于搜索），dimensions 保留了「值属于哪个维度」，
     * 否则前端无法知道「G系列」是系列、「粉刷」是用途——只能靠硬编码，
     * 那会把白凤堂的特殊规则污染到通用的 catalog.js 里。
     * 用数组是因为一个商品可能同属多个系列（如既在 G 系列又在套装里）。
     */
    const dims = { series: [], use: [], hair: [] };

    // 大类：优先用集合，退回现有 type（已是中文）
    const mainCol = MAIN.find((x) => cols.has(x));
    if (mainCol && ZH[mainCol]) cats.push(ZH[mainCol]);
    else if (p.type) cats.push(p.type);

    // 三个维度（可能各有多个）
    for (const dim of ['series', 'use', 'hair']) {
      const hit = DIM[dim].filter((x) => cols.has(x));
      for (const h of hit) {
        if (!ZH[h]) continue;
        if (!cats.includes(ZH[h])) cats.push(ZH[h]);
        if (!dims[dim].includes(ZH[h])) dims[dim].push(ZH[h]);
        stats[dim][ZH[h]] = (stats[dim][ZH[h]] || 0) + 1;
      }
      if (hit.length) { if (dim === 'series') withSeries++; else if (dim === 'use') withUse++; else withHair++; }
    }

    if (cats.length > (mainCol || p.type ? 1 : 0)) withDim++;
    p.categories = cats;
    p.dimensions = dims;
  }

  console.log('归类结果:');
  console.log('  有三维信息的商品: ' + withDim);
  console.log('    含系列: ' + withSeries);
  console.log('    含用途: ' + withUse);
  console.log('    含毛质: ' + withHair);
  console.log('  无集合归属（保持 type）: ' + noMembership);

  console.log('\n各维度取值分布:');
  for (const dim of ['series', 'use', 'hair']) {
    const entries = Object.entries(stats[dim]).sort((a, b) => b[1] - a[1]);
    console.log('  【' + dim + '】共 ' + entries.length + ' 种');
    entries.slice(0, 25).forEach(([k, n]) => console.log('    ' + String(n).padStart(4) + '  ' + k));
  }

  // ⑤ 样例
  console.log('\n分类样例（前 6 件）:');
  for (const [, p] of [...byHandle].slice(0, 6)) {
    console.log('  ' + String(p.title).slice(0, 30));
    console.log('     type=' + p.type + '   categories=' + JSON.stringify(p.categories));
  }

  if (!GO) {
    console.log('\n（dry-run。加 --go 才写回 catalog-data.js）');
    return;
  }

  // ⑥ 备份并写回
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(BACKUP_DIR, 'catalog-data.js.bak-' + stamp);
  fs.writeFileSync(backup, src, 'utf8');
  console.log('\n已备份: ' + path.relative(ROOT, backup));

  const header = src.slice(0, m.index);
  const footer = src.slice(m.index + m[0].length);
  const out = header + 'window.PRODUCTS = ' + JSON.stringify(products, null, 1) + ';' + footer;
  fs.writeFileSync(DATA_FILE, out, 'utf8');
  console.log('已写回: ' + path.relative(ROOT, DATA_FILE)
    + '（' + (fs.statSync(DATA_FILE).size / 1024).toFixed(0) + ' KB）');
})().catch((e) => { console.error('\n✗ 失败: ' + e.message); process.exit(1); });
