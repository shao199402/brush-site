#!/usr/bin/env node
'use strict';
/**
 * 通用「二级分类」补全器（按品牌配置驱动）
 *
 * 每个品牌给两份配置：
 *   · level1Of(product)    一级分类怎么取（通常是现有 type）
 *   · subCategories        二级分类的来源（站点分类页 URL + 名称 + 中文名）
 * 然后抓每个二级分类页的商品列表，建立 handle → 二级 的归属，
 * 写回 *-data.js 的 categories（扁平，供搜索）与 dimensions（结构化，供联动下拉）。
 *
 * 用法：
 *   node scripts/add-subcategories.js --brand=n8           dry-run
 *   node scripts/add-subcategories.js --brand=n8 --go      写回
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argVal = (n, d) => {
  const h = argv.find((a) => a.startsWith('--' + n + '='));
  return h ? h.split('=').slice(1).join('=') : d;
};
const BRAND = argVal('brand', '');
const GO = argv.includes('--go');

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en;q=0.9',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, tries = 3) {
  let last = '';
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(35000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      last = e.message;
      if (i < tries) await sleep(700 * i);
    }
  }
  throw new Error(last);
}

// ───────────────────────── 品牌配置 ─────────────────────────

const CONFIGS = {
  /**
   * 熊永堂 number-8.net
   * 站点结构（实测）：
   *   一级：化粧筆(1) / ツール(4) / セット(5) / 熊永堂(26) /
   *         Magnifica(27) / その他 熊野筆(6) / 用途別(7)
   *   二级：用途別(7) 下挂 11 个子类 —— 这是真实的二级分类
   */
  n8: {
    file: 'n8-data.js',
    label: '熊永堂',
    extractHandle: (href) => {
      const m = String(href).match(/product_id=(\d+)/);
      return m ? 'n8-' + m[1] : null;
    },
    /** 二级分类：用途別 的 11 个子类 */
    subs: [
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=14&pageno=' + p, name: '套装' },
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=15&pageno=' + p, name: '粉・面部刷' },
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=16&pageno=' + p, name: '腮红刷' },
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=23&pageno=' + p, name: '粉底・遮瑕刷' },
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=22&pageno=' + p, name: '高光刷' },
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=21&pageno=' + p, name: '防晒刷' },
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=20&pageno=' + p, name: '眼影刷' },
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=19&pageno=' + p, name: '眉刷' },
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=18&pageno=' + p, name: '唇刷' },
      { key: 'use', label: '用途', url: (p) => 'https://www.number-8.net/products/list.php?category_id=17&pageno=' + p, name: '便携刷' },
    ],
    maxPages: 10,
  },

  /**
   * 竹田 takeda-brush-shop.com
   * 站点有 30 个 categoryId（实测），其中「便携 / 套装 / 和刷毛」是可聚合的维度，
   * 逐件商品的用途已体现在现有 type 里（眼影刷/腮红刷/…），所以二级取这三类。
   */
  takeda: {
    file: 'takeda-data.js',
    label: '竹田',
    extractHandle: (href) => {
      const m = String(href).match(/item-detail\/(\d+)/);
      return m ? 'takeda-' + m[1] : null;
    },
    subs: [
      { key: 'form', label: '形态', ids: [99655, 103390], name: '套装' },
      { key: 'form', label: '形态', ids: [99801, 103129, 102314, 103136, 99800, 109392], name: '便携款' },
      { key: 'form', label: '形态', ids: [104323], name: '和刷毛' },
      { key: 'form', label: '形态', ids: [99725, 99726, 99727], name: '护肤用品' },
      { key: 'form', label: '形态', ids: [99724, 100569], name: '工具・其他' },
    ],
    urlFor: (sub, page) => 'https://takeda-brush-shop.com/item-list?categoryId=' + sub.ids[0] + '&pageIndex=' + (page - 1),
    /** 一个「二级」可能对应多个 categoryId，需要逐个抓再合并 */
    expandIds: true,
    idUrl: (id, page) => 'https://takeda-brush-shop.com/item-list?categoryId=' + id + '&pageIndex=' + (page - 1),
    maxPages: 12,
  },

  /**
   * 永丰堂 eihodo.jp
   * 站点按「系列」组织（si=…），系列就是天然的二级分类。
   * 现有 type 里混了运营位（每周更新推荐/严选特辑），系列信息反而是缺失的。
   */
  eihodo: {
    file: 'eihodo-data.js',
    label: '永丰堂',
    extractHandle: (href) => {
      const m = String(href).match(/[?&]id=(\d+-\d+)/);
      return m ? 'eihodo-' + m[1] : null;
    },
    subs: [
      { key: 'series', label: '系列', si: '1424678984-919257', name: 'RE 系列' },
      { key: 'series', label: '系列', si: '1424677563-532993', name: 'WP 系列' },
      { key: 'series', label: '系列', si: '1673930832-557645', name: 'EI-R 系列' },
      { key: 'series', label: '系列', si: '1674095145-288786', name: 'EI-BK 系列' },
      { key: 'series', label: '系列', si: '1749792781-478784', name: 'PS 系列' },
      { key: 'series', label: '系列', si: '1715644134-069735', name: 'BL 系列' },
      { key: 'series', label: '系列', si: '1459486152-549834', name: 'G 系列' },
      { key: 'series', label: '系列', si: '1424678288-611054', name: 'K 系列' },
      { key: 'series', label: '系列', si: '1424678508-534313', name: '携帯用系列' },
      { key: 'series', label: '系列', si: '1424680367-586707', name: '唇刷系列' },
      { key: 'series', label: '系列', si: '1410163967-574982', name: '洁面刷' },
      { key: 'series', label: '系列', si: '1424680608-339392', name: '其他系列' },
      { key: 'series', label: '系列', si: '1295922716-127697', name: '收纳盒' },
      { key: 'series', label: '系列', si: '1360289616-090835', name: '笔帽' },
    ],
    urlFor: (sub, page) => 'https://www.eihodo.jp/sp/shopping/?si=' + sub.si + (page > 1 ? '&p=' + page : ''),
    maxPages: 8,
  },
};

// ───────────────────────── 主流程 ─────────────────────────

(async () => {
  const cfg = CONFIGS[BRAND];
  if (!cfg) {
    console.log('可用的品牌: ' + Object.keys(CONFIGS).join(', '));
    process.exit(1);
  }
  const dataPath = path.join(ROOT, cfg.file);
  const src = fs.readFileSync(dataPath, 'utf8');
  const m = src.match(/window\.PRODUCTS\s*=\s*(\[[\s\S]*\])\s*;/);
  if (!m) throw new Error(cfg.file + ' 结构未识别');
  const products = JSON.parse(m[1]);
  console.log('=== ' + cfg.label + '：' + products.length + ' 件 ===');

  const byHandle = new Map(products.map((p) => [String(p.handle).toLowerCase(), p]));

  // 抓每个二级分类的商品
  const membership = new Map();   // handle → Set(二级名)
  for (const sub of cfg.subs) {
    /** 一个二级可能对应多个 categoryId（如「便携款」跨 6 个 categoryId） */
    const ids = cfg.expandIds && sub.ids ? sub.ids : [null];
    const handlesAll = new Set();
    for (const id of ids) {
      for (let page = 1; page <= cfg.maxPages; page++) {
        const url = id != null ? cfg.idUrl(id, page) : (cfg.urlFor ? cfg.urlFor(sub, page) : sub.url(page));
        let html;
        try {
          html = await getText(url);
        } catch (e) {
          console.log('  ✗ ' + sub.name + ' 第' + page + '页失败: ' + e.message);
          break;
        }
        const handles = new Set();
        for (const a of html.matchAll(/href=(?:"([^"]+)"|'([^']+)')/gi)) {
          const h = cfg.extractHandle(a[1] || a[2]);
          if (h) handles.add(h.toLowerCase());
        }
        if (!handles.size) break;
        for (const h of handles) handlesAll.add(h);
        // 判断是否有下一页（不同站点参数名不同）
        const nextPage = page + 1;
        const hasNext = new RegExp('(?:pageno|pageIndex|&p)=(' + nextPage + '|' + (nextPage - 1) + ')\\b').test(html)
          || new RegExp('pageno=' + nextPage + '\\b').test(html);
        if (!hasNext) break;
        await sleep(250);
      }
    }
    for (const h of handlesAll) {
      if (!membership.has(h)) membership.set(h, new Set());
      membership.get(h).add(sub.name);
    }
    console.log('  ' + sub.name.padEnd(14) + ' ' + String(handlesAll.size).padStart(4) + ' 件');
  }

  console.log('\n有二级归属的商品: ' + membership.size + ' / ' + products.length);

  // 写回：categories 追加二级名；dimensions.use 保存二级
  let touched = 0;
  for (const [handle, p] of byHandle) {
    const subs = membership.get(handle);
    const dims = (p.dimensions && typeof p.dimensions === 'object') ? p.dimensions : {};
    if (subs && subs.size) {
      const list = [...subs].sort();
      dims.use = list;
      const cats = Array.isArray(p.categories) ? p.categories.slice() : [];
      for (const v of list) if (!cats.includes(v)) cats.push(v);
      p.categories = cats;
      p.dimensions = dims;
      touched++;
    } else {
      // 没有二级归属的也要有 dimensions 结构（空数组），便于前端统一处理
      p.dimensions = { use: dims.use || [] };
      if (!Array.isArray(p.categories)) p.categories = p.type ? [p.type] : [];
    }
  }

  console.log('写入二级归属的商品: ' + touched);

  // 统计
  const dist = {};
  products.forEach((p) => (p.dimensions && p.dimensions.use ? p.dimensions.use : []).forEach((v) => { dist[v] = (dist[v] || 0) + 1; }));
  console.log('\n二级分类分布:');
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('  ' + String(n).padStart(4) + '  ' + k));

  if (!GO) { console.log('\n（dry-run。加 --go 写回）'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(ROOT, 'data', cfg.file + '.bak-' + stamp);
  fs.writeFileSync(backup, src, 'utf8');
  const out = src.slice(0, m.index) + 'window.PRODUCTS = ' + JSON.stringify(products, null, 1) + ';' + src.slice(m.index + m[0].length);
  fs.writeFileSync(dataPath, out, 'utf8');
  console.log('\n已备份 ' + path.relative(ROOT, backup));
  console.log('已写回 ' + cfg.file + '（' + (fs.statSync(dataPath).size / 1024).toFixed(0) + ' KB）');
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
