#!/usr/bin/env node
'use strict';
/**
 * 为「type 已经足够细」的品牌补一级归并 + 二级
 *
 * 现状（实测）：
 *   · 晃佑堂：type 只有 1 种「晃佑堂商品」→ 完全废的，必须从标题推
 *   · 竹田  ：type 27 种（眼影刷/腮红刷…）→ 已是二级，缺一级
 *   · 竹宝堂：type 21 种（蜜粉刷/唇刷…）  → 已是二级，缺一级
 *   · 永丰堂：type 38 种，混了运营位（每周更新推荐/严选特辑）与工具 → 需归并
 *
 * 做法：
 *   level1      = 归并出的粗分类（5~7 组）
 *   dimensions.sub = 细分（现有 type，或从标题推断的用途）
 *   categories  = 追加细分值，便于搜索
 *
 * 用法：node scripts/add-level1.js --brand=takeda [--go]
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

// ───────────────────── 各品牌的一级归并表 ─────────────────────

const MAPS = {
  takeda: {
    file: 'takeda-data.js',
    label: '竹田',
    groups: {
      '套装': ['自选套装', '套装', '期间限定'],
      '面部刷': ['面部刷', '腮红刷', '高光刷', '粉底刷', '粉扑刷（蜜粉型）', '粉底/粉扑刷', '便携面部腮红刷', '鼻影刷', '修容刷'],
      '眼部刷': ['眼影刷', '眼影/遮瑕刷', '眼线刷', '眉刷', '螺旋刷', '便携眼影刷', '便携眉刷', '便携眼线刷', '局部彩妆刷', '便携局部刷', '晕染刷'],
      '唇刷': ['唇刷', '便携唇刷'],
      '护肤与清洁': ['洁面刷', '皂'],
      '其他': ['和刷毛', '其他'],
    },
  },
  chikuhodo: {
    file: 'chikuhodo-data.js',
    label: '竹宝堂',
    groups: {
      '面部刷': ['蜜粉刷', '腮红刷', '高光刷', '修容刷', '粉底刷', '遮瑕刷', '液体刷'],
      '眼部刷': ['眼影刷', '眼影眼线刷', '眼线刷', '眉刷', '螺旋眉刷', '晕染刷', '鼻影刷'],
      '唇刷': ['唇刷'],
      '套装与收纳': ['套装刷', '刷盒', '刷子＆梳子'],
      '其他': ['洁面起泡刷', '男士刷', '竹宝堂商品'],
    },
  },
  eihodo: {
    file: 'eihodo-data.js',
    label: '永丰堂',
    groups: {
      '化妆刷（系列）': ['RE 系列', 'WP 系列', 'EI-R 系列', 'EI-BK 系列', 'PS 系列', 'G 系列', 'K 系列',
        'BL 银狐毛系列', '便携系列', '唇刷系列', '大师笔', '按用途'],
      '发刷与梳': ['自然蓬松感发刷', '光泽发质按摩刷', '衣物刷', '发刷清洁器', '雪茧蚕丝按摩刷',
        '萨摩黄杨木梳', '萨摩黄杨木刷', '细软稀疏发质适用'],
      '美妆工具': ['刷盖', '原创刷盖', '海绵/粉扑', '睫毛夹类', '镊子', '化妆剪', '指甲剪', '指甲锉', '掏耳勺'],
      '收纳与礼盒': ['收纳盒类', '化妆刷礼盒套装'],
      '推荐与特辑': ['每周更新推荐', '严选特辑'],
      '其他': ['京都东寺吸油纸', '同系列吸油纸', '天然材质毛巾', '起泡洁面刷', '其他杂项'],
    },
  },
};

/** 晃佑堂没有分类，只能从标题推断用途 */
const KOYUDO_RULES = [
  // 顺序即优先级：越具体的规则放越前
  { re: /刻名/, sub: '刻名服务', level1: '其他' },
  { re: /清洗|洗剂|洗发露|保养/, sub: '清洗保养', level1: '护理' },
  { re: /包装|礼品|礼盒|ギフト/, sub: '包装礼盒', level1: '收纳与杂货' },
  { re: /化妆包|手提包|ポーチ|ケース|收纳|袋/, sub: '收纳包/笔盒', level1: '收纳与杂货' },
  { re: /调色盘|パレット|PAPERS|IRODORI|彩盘/, sub: '彩妆周边', level1: '其他' },
  { re: /蜜粉.*腮红|蜜粉＆腮红|蜜粉&腮红/, sub: '蜜粉・腮红刷', level1: '面部刷' },
  { re: /万能笔|万能刷/, sub: '多功能刷', level1: '面部刷' },
  { re: /蜜粉刷|パウダー/, sub: '蜜粉刷', level1: '面部刷' },
  { re: /粉底刷|ファンデ/, sub: '粉底刷', level1: '面部刷' },
  { re: /腮红刷|チーク/, sub: '腮红刷', level1: '面部刷' },
  { re: /高光刷|ハイライト/, sub: '高光刷', level1: '面部刷' },
  { re: /遮瑕|コンシーラー/, sub: '遮瑕刷', level1: '面部刷' },
  { re: /眼影|アイシャドウ/, sub: '眼影刷', level1: '眼部刷' },
  { re: /眼线|アイライナー|ライナー/, sub: '眼线刷', level1: '眼部刷' },
  { re: /眉|アイブロウ/, sub: '眉刷', level1: '眼部刷' },
  { re: /唇|リップ/, sub: '唇刷', level1: '唇刷' },
  { re: /洗顔|洁面|クレンジング/, sub: '洁面刷', level1: '护肤与清洁' },
  { re: /套装|セット/, sub: '套装', level1: '套装' },
  // 兜底：含「刷」的都算面部刷，避免大量落入「其他」
  { re: /刷|ブラシ/, sub: '其他刷具', level1: '面部刷' },
];

function classifyKoyudo(title) {
  const t = String(title || '');
  for (const r of KOYUDO_RULES) if (r.re.test(t)) return { level1: r.level1, sub: r.sub };
  return { level1: '其他', sub: '其他刷具' };
}

// ───────────────────── 主流程 ─────────────────────

function loadData(file) {
  const p = path.join(ROOT, file);
  const src = fs.readFileSync(p, 'utf8');
  const m = src.match(/window\.PRODUCTS\s*=\s*(\[[\s\S]*\])\s*;/);
  if (!m) throw new Error(file + ' 结构未识别');
  return { p, src, m, products: JSON.parse(m[1]) };
}

function saveData(file, src, m, products) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(ROOT, 'data', file + '.bak-' + stamp), src, 'utf8');
  const out = src.slice(0, m.index) + 'window.PRODUCTS = ' + JSON.stringify(products, null, 1) + ';' + src.slice(m.index + m[0].length);
  fs.writeFileSync(path.join(ROOT, file), out, 'utf8');
  return stamp;
}

(async () => {
  if (BRAND === 'koyudo') {
    const { p, src, m, products } = loadData('koyudo-data.js');
    console.log('=== 晃佑堂：' + products.length + ' 件（从标题推断）===');
    const dist = {}, subDist = {};
    for (const prod of products) {
      const { level1, sub } = classifyKoyudo(prod.title);
      prod.level1 = level1;
      prod.dimensions = { sub: [sub] };
      const cats = Array.isArray(prod.categories) ? prod.categories.filter((c) => c !== '晃佑堂商品') : [];
      if (!cats.includes(sub)) cats.push(sub);
      prod.categories = cats;
      dist[level1] = (dist[level1] || 0) + 1;
      subDist[sub] = (subDist[sub] || 0) + 1;
    }
    console.log('一级分布:'); Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('  ' + String(n).padStart(4) + '  ' + k));
    console.log('二级分布:'); Object.entries(subDist).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('  ' + String(n).padStart(4) + '  ' + k));
    if (GO) { const s = saveData('koyudo-data.js', src, m, products); console.log('\n已备份 bak-' + s + '，已写回 koyudo-data.js'); }
    else console.log('\n（dry-run）');
    return;
  }

  const cfg = MAPS[BRAND];
  if (!cfg) { console.log('可用: koyudo, ' + Object.keys(MAPS).join(', ')); process.exit(1); }

  const { p, src, m, products } = loadData(cfg.file);
  console.log('=== ' + cfg.label + '：' + products.length + ' 件 ===');

  // type → level1
  const typeToLevel1 = new Map();
  for (const [g, types] of Object.entries(cfg.groups)) {
    for (const t of types) typeToLevel1.set(t, g);
  }

  let mapped = 0, unmapped = 0;
  const unmappedTypes = new Set();
  const dist = {}, subDist = {};
  for (const prod of products) {
    const t = prod.type || '';
    let g = typeToLevel1.get(t);
    if (!g) { g = '其他'; unmapped++; unmappedTypes.add(t); } else mapped++;
    prod.level1 = g;
    prod.dimensions = { sub: t ? [t] : [] };
    const cats = Array.isArray(prod.categories) ? prod.categories.slice() : [];
    if (t && !cats.includes(t)) cats.push(t);
    prod.categories = cats;
    dist[g] = (dist[g] || 0) + 1;
    if (t) subDist[t] = (subDist[t] || 0) + 1;
  }

  console.log('一级分布:');
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('  ' + String(n).padStart(4) + '  ' + k));
  console.log('\n映射: ' + mapped + ' 件  未映射(归入其他): ' + unmapped + ' 件');
  if (unmappedTypes.size) console.log('未映射的 type: ' + JSON.stringify([...unmappedTypes]));
  console.log('二级种类: ' + Object.keys(subDist).length);

  if (GO) { const s = saveData(cfg.file, src, m, products); console.log('\n已备份 bak-' + s + '，已写回 ' + cfg.file); }
  else console.log('\n（dry-run。加 --go 写回）');
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
