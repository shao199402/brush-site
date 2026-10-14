#!/usr/bin/env node
'use strict';
/**
 * 竹宝堂 CHIKUHODO 模块的逐条验收（对着用户给的四条规则 + 质量红线）。
 *
 * 用法：
 *   node scripts/chikuhodo-verify.js            # 规则与质量
 *   node scripts/chikuhodo-verify.js --site     # 额外检查本地站点可访问性
 *
 * 与 hakuho-validate.js 的分工：
 *   hakuho-validate.js     各品牌通用的完整性校验（字段齐不齐、假名、孤儿图）
 *   chikuhodo-verify.js    竹宝堂专有的规则符合性（名称取值、desc/detail 图片规则、
 *                          模板 A/B、价格格式、分类、页脚泄漏、iframe lazy）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { tagBalance } = require('./lib-html.js');

const ROOT = path.resolve(__dirname, '..');
const P = (f) => path.join(ROOT, f);
const KANA = /[\u3041-\u3096\u30a1-\u30fa\u30fc-\u30fe]/;
const CART = /カート|買い物|ショッピング/;
const REVIEW = /お客様の声|レビュー|口コミ/;
const CHECK_SITE = process.argv.includes('--site');

let fails = 0;
let passes = 0;
function ok(label, cond, detail) {
  if (cond) passes += 1;
  else fails += 1;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''));
}
const loadCatalog = (f) => {
  const src = fs.readFileSync(P(f), 'utf8');
  const m = src.match(/window\.PRODUCTS\s*=\s*(\[[\s\S]*\])\s*;?\s*$/);
  if (!m) throw new Error('无法解析 ' + f);
  return JSON.parse(m[1]);
};
const readJson = (f) => JSON.parse(fs.readFileSync(P(f), 'utf8'));

(async () => {
  const ja = readJson('data/chikuhodo-ja.json');
  const p = loadCatalog('chikuhodo-data.js');
  const report = fs.existsSync(P('data/chikuhodo-validate.json')) ? readJson('data/chikuhodo-validate.json') : { errors: [], orphanImages: 0 };
  const home = fs.readFileSync(P('index.html'), 'utf8');

  console.log('=== 规则一：首页新增竹宝堂模块 ===');
  ok('首页有竹宝堂模块卡（编号 06）', /module-number">06<\/span>/.test(home) && /chikuhodo\.html/.test(home));
  const heroImg = (home.match(/chikuhodo\.html"[\s\S]*?<img src="([^"]+)"/) || [])[1];
  ok('模块缩略图存在', Boolean(heroImg) && fs.existsSync(P(heroImg)), heroImg);
  ok('数据来源为 chikuhodo.com', ja.source === 'https://www.chikuhodo.com', ja.source);

  console.log('\n=== 规则二：取值规则 ===');
  ok('名称取自 <title>（已剔除站点名、非 h1、非 alt）',
    p.every((x) => x.title && !x.title.includes('｜') && !x.title.includes('竹宝堂') && !KANA.test(x.title)),
    '样例 ' + p.slice(0, 3).map((x) => x.title).join(' / '));
  const tmplA = ja.products.filter((x) => x.descSource === 'item_description').length;
  const tmplB = ja.products.filter((x) => x.descSource === 'article').length;
  ok('desc 取 div.item_description（模板 B 同口径退回 article）',
    tmplA + tmplB === ja.products.length, '模板A ' + tmplA + ' + 模板B ' + tmplB);
  ok('desc 保留图片与原有样式', ja.products.every((x) => /<img/i.test(x.descJaHtml) && /class=|style=/.test(x.descJaHtml)));
  ok('detail 排除图片（desc 区块内无 img）', ja.products.every((x) => !/<img/i.test(x.detailJaHtml)));
  ok('detailHtml 亦无 img', p.every((x) => !/<img/i.test(String(x.detailHtml))));
  ok('detailHtml 保留原有样式（class/style）', p.every((x) => /class=|style=/.test(String(x.detailHtml))));
  ok('价格格式与晃佑堂一致（N 日元（含税））',
    p.every((x) => x.price === '价格待确认' || /^[\d,]+ 日元（含税）$/.test(x.price)),
    (p.find((x) => x.price !== '价格待确认') || {}).price);

  console.log('\n=== 规则三：先抓日文再统一翻译 ===');
  ok('日文产物与中文产物件数一致', ja.products.length === p.length, ja.products.length + ' / ' + p.length);
  ok('无假名残留（title/type/desc/detail/categories）',
    p.every((x) => !KANA.test(String(x.title)) && !KANA.test(String(x.type)) && !KANA.test(String(x.desc))
      && !KANA.test(String(x.detail)) && (x.categories || []).every((c) => !KANA.test(String(c)))));
  ok('无空字段', p.every((x) => ['title', 'desc', 'detail', 'detailHtml'].every((f) => String(x[f] || '').trim())));
  ok('无日语汉字残留（如「覧」）', p.every((x) => !/[覧込払渡価円髪顔頬軸房]/.test(String(x.type) + String(x.title))));

  console.log('\n=== 规则四：分类搜索 ===');
  const types = [...new Set(p.map((x) => x.type))];
  ok('分类已保留（21 个用途分类）', types.length === 21, types.slice(0, 6).join('/') + ' …');
  ok('页面有分类下拉控件', fs.readFileSync(P('chikuhodo.html'), 'utf8').includes('catalogType'));
  ok('catalog.js 搜索覆盖 categories', /categories/.test(fs.readFileSync(P('catalog.js'), 'utf8')));
  ok('每件商品都有分类', p.every((x) => x.type && (x.categories || []).length));

  console.log('\n=== 质量红线 ===');
  ok('标签全部配平（不错版）', p.every((x) => !tagBalance(String(x.detailHtml)).length && !tagBalance(String(x.desc)).length));
  ok('无未闭合注释', p.every((x) => {
    const h = String(x.detailHtml);
    const i = h.lastIndexOf('<!--');
    return i === -1 || h.indexOf('-->', i) !== -1;
  }));
  ok('无购物车按钮泄漏', ja.products.every((x) => !CART.test(x.descJaHtml) && !CART.test(x.detailJaHtml)));
  ok('无顾客评价区泄漏', ja.products.every((x) => !REVIEW.test(x.descJaHtml) && !REVIEW.test(x.detailJaHtml)));
  ok('无 iframe 未加 lazy', p.every((x) => {
    const h = String(x.detailHtml);
    const all = (h.match(/<iframe\b/g) || []).length;
    const lazy = (h.match(/<iframe\b[^>]*loading=/g) || []).length;
    return all === lazy;
  }), (p.reduce((a, x) => a + (String(x.detailHtml).match(/<iframe/g) || []).length, 0)) + ' 个 iframe');
  ok('图片磁盘无缺失', p.reduce((a, x) => a + (x.images || []).filter((f) => !fs.existsSync(P(f))).length, 0) === 0,
    p.reduce((a, x) => a + x.images.length, 0) + ' 张');
  ok('无孤儿图片文件', report.orphanImages === 0);
  ok('校验器硬性错误 0', (report.errors || []).length === 0);

  console.log('\n=== 六品牌回归 ===');
  for (const b of ['hakuho', 'takeda', 'n8', 'eihodo', 'koyudo', 'chikuhodo']) {
    const cmd = b === 'hakuho' ? 'node scripts/hakuho-validate.js' : 'node scripts/hakuho-validate.js --brand=' + b;
    const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8' });
    const n = (out.match(/商品总数：(\d+)/) || [])[1];
    const kana = (out.match(/疑似残留假名字段：(\d+)/) || [])[1];
    const orph = (out.match(/未被引用的图片文件：(\d+)/) || [])[1];
    const err = (out.match(/硬性错误：(\d+)/) || [])[1];
    ok(b.padEnd(11) + ' 商品 ' + String(n).padStart(4) + ' | 假名 ' + kana + ' | 孤儿图 ' + orph + ' | 错误 ' + err,
      kana === '0' && orph === '0' && err === '0');
  }

  if (CHECK_SITE) {
    console.log('\n=== 站点可访问性 ===');
    for (const [u, l] of [['/', '首页'], ['/chikuhodo.html', '竹宝堂页'], ['/chikuhodo-data.js', '竹宝堂数据']]) {
      try {
        const r = await fetch('http://127.0.0.1:8080' + u);
        const b = Buffer.from(await r.arrayBuffer());
        console.log('  ' + String(r.status).padEnd(4) + String(Math.round(b.length / 1024) + 'KB').padEnd(9) + l);
        if (r.status !== 200) fails += 1;
        else passes += 1;
      } catch (e) {
        console.log('  ERR ' + l + ' ' + e.message);
        fails += 1;
      }
    }
  }

  console.log('\n=== 未推送确认 ===');
  const remote = execSync('git ls-tree -r --name-only origin/main', { cwd: ROOT, encoding: 'utf8' }).split('\n');
  ok('origin/main 无竹宝堂脚本/中间产物',
    !remote.some((f) => /chikuhodo/i.test(f) && !/^assets\/chikuhodo\//.test(f)),
    remote.filter((f) => /chikuhodo/i.test(f)).length + ' 个匹配');

  console.log('\n=== 结果：' + (fails === 0 ? '全部通过' : fails + ' 项失败') + '（PASS ' + passes + ' / FAIL ' + fails + '）===');
  console.log('商品 ' + p.length + ' | 分类 ' + types.length + ' | 图片 ' + p.reduce((a, x) => a + x.images.length, 0)
    + ' | chikuhodo-data.js ' + Math.round(fs.statSync(P('chikuhodo-data.js')).size / 1024) + ' KB');
  process.exit(fails === 0 ? 0 : 1);
})();
