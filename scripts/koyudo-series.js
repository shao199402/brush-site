#!/usr/bin/env node
'use strict';
/**
 * 晃佑堂：把二级分类从「用途推断」改为**系列**（站点真实的组织方式）
 *
 * 背景（实测结论）：
 *   晃佑堂站点**没有分类体系** —— 无 sitemap、`/view/category/<id>` 全 404、
 *   `?cid=` / `?category_id=` 被忽略、`/items/` 只是 all_items 的外壳。
 *   全站唯一分类是「すべての商品」。
 *
 * 但它有明确的**系列**结构，编码在商品型号里：
 *   【BP010】蜜粉刷 ～高端系列～        型号前缀 BP + 标题里的「～…～」
 *   【FG-01】La Fuga del Gatto 蜜粉…
 *   【SF-PBMP】银狐毛〈银狐〉蜜粉刷S
 *
 * 所以二级 = 系列（型号前缀映射 + 标题 ～…～ 标注），一级 = 用途归并。
 *
 * 用法：node scripts/koyudo-series.js [--go]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'koyudo-data.js');
const GO = process.argv.includes('--go');

/** 型号前缀 → 系列名（43 个前缀，按实测标题归纳） */
const SERIES_BY_PREFIX = {
  BP: '高端系列', P: 'Premium系列',
  HC: 'H系列', H: 'H系列',
  ML: '便携唇刷系列', MLP: '移动唇刷系列', MC: '便携系列', MCH: '便携心形',
  A: 'Traditional系列', F: 'Flower系列', FG: 'La Fuga del Gatto 猫的赋格',
  SF: '银狐毛系列', SKL: '超级柯林斯基貂毛', WCSQ: '白加拿大松鼠毛', SBK: '细光峰歌舞伎',
  KSZ: '柿涩染 Kakishibuzome',
  YT: 'Yoshiki 天平', YR: 'Yoshiki Red', KR: '凛', PR: 'puritto', TM: 'つむぎ',
  FW: '花型洁面刷', HW: '爱心型洁面刷', HWM: '心形洁面刷', W: '洁面刷', WM: '洁面刷',
  CLB: '笔刷清洁', CA: '身体刷', FB: '花型身体刷', S: 'SOMELL GARDEN',
  CS: 'CS系列', C: 'C系列', CL: 'CL系列', FU: 'FU系列', V: 'V系列',
  KY: 'KY系列', YB: 'YB系列', KP: 'KP系列', NC: 'NC系列',
  WRP: '包装用品', POUC: '化妆包', CMB: '套装', ANM: '动物刷', HBK: '仙人掌',
  MACA: '马卡龙', NB: 'vivid',
};

/**
 * 全角转半角后取型号前缀
 *
 * 晃佑堂的型号有几种写法，必须都覆盖（实测）：
 *   【BP010】…           单段
 *   【PR-S-3】…          多段（PR-S-3）
 *   【MLP-V】…           多段
 *   KR-S-3【凛3支套装】    型号在前、名称在括号里
 *   JAPAN BLUE 熊野筆 …  无型号（返回空）
 * 早先只支持「以【开头 + 单段」，导致 PR/KR/YT/MLP 这些系列全被归到兜底类。
 */
function prefixOf(title) {
  const t = String(title || '')
    .replace(/[\uFF21-\uFF3A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // 形式 A：【PR-S-3】xxx
  let m = t.match(/^[【\[]([A-Za-z]{1,4})(?:[-_][A-Za-z0-9]+)*[】\]]/);
  if (m) return m[1].toUpperCase();
  // 形式 B：KR-S-3【xxx】（型号在最前，后面跟括号名称）
  m = t.match(/^([A-Za-z]{1,4})(?:[-_][A-Za-z0-9]+)*[【\[]/);
  if (m) return m[1].toUpperCase();
  // 形式 C：PR-S-3 xxx（型号在最前，空格分隔）
  m = t.match(/^([A-Za-z]{1,4})(?:[-_][A-Za-z0-9]+)+\s/);
  if (m) return m[1].toUpperCase();
  return '';
}

/** 标题里的 ～系列名～ */
function labelSeries(title) {
  const m = String(title || '').match(/[～~]([^～~]{1,20}?)[～~]/);
  return m ? m[1].trim() : '';
}

(async () => {
  const src = fs.readFileSync(DATA, 'utf8');
  const m = src.match(/window\.PRODUCTS\s*=\s*(\[[\s\S]*\])\s*;/);
  if (!m) throw new Error('koyudo-data.js 结构未识别');
  const products = JSON.parse(m[1]);
  console.log('=== 晃佑堂：' + products.length + ' 件 ===');

  let byLabel = 0, byPrefix = 0, fallback = 0;
  const dist = {};
  for (const p of products) {
    const pre = prefixOf(p.title);
    const lbl = labelSeries(p.title);
    let series = '';
    // 标题里的显式标注优先级最高（站方自己写的）
    if (lbl) { series = lbl; byLabel++; }
    else if (pre && SERIES_BY_PREFIX[pre]) { series = SERIES_BY_PREFIX[pre]; byPrefix++; }
    else {
      // 无前缀但标题里含常见字样
      const t = String(p.title);
      if (/套装|セット/.test(t)) series = '套装';
      else if (/包装|ギフト/.test(t)) series = '包装用品';
      else if (/化妆包|ポーチ|ケース|袋/.test(t)) series = '化妆包';
      else if (/IRODORI|PAPERS|调色盘/.test(t)) series = 'IRODORI';
      else { series = '其他'; fallback++; }
    }
    p.dimensions = { series: [series] };
    // categories 里同步系列名，便于搜索
    const cats = Array.isArray(p.categories) ? p.categories.filter((c) => c !== '晃佑堂商品') : [];
    if (!cats.includes(series)) cats.push(series);
    p.categories = cats;
    dist[series] = (dist[series] || 0) + 1;
  }

  console.log('系列来源: 标题标注 ' + byLabel + '，型号前缀 ' + byPrefix + '，兜底 ' + fallback);
  console.log('\n系列分布（' + Object.keys(dist).length + ' 种）:');
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('  ' + String(n).padStart(4) + '  ' + k));

  // 一级保持现有 level1（用途归并），确认存在
  const noL1 = products.filter((p) => !p.level1).length;
  console.log('\n没有 level1 的商品: ' + noL1);

  if (!GO) { console.log('\n（dry-run。加 --go 写回）'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(ROOT, 'data', 'koyudo-data.js.bak-' + stamp), src, 'utf8');
  const out = src.slice(0, m.index) + 'window.PRODUCTS = ' + JSON.stringify(products, null, 1) + ';' + src.slice(m.index + m[0].length);
  fs.writeFileSync(DATA, out, 'utf8');
  console.log('\n已备份 bak-' + stamp + '，已写回 koyudo-data.js');
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
