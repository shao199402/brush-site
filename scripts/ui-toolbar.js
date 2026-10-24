'use strict';
/**
 * 重构 7 个页面的筛选工具栏：给每个控件加可见标签，让「一级/二级」层级自解释
 *
 * 旧结构（无标签）：
 *   [搜索框] [一级▾] [二级▾] 共 154 个商品
 * 用户看不出后两个下拉是层级关系。
 *
 * 新结构（带标签，基线对齐）：
 *   搜索              一级品类          二级分类
 *   [搜索商品…]        [化妆刷 ▾]        [粉刷 (154) ▾]        共 154 个商品
 *
 * 幂等：已经带 .catalog-field 就跳过。
 */
const fs = require('fs');

const PAGES = [
  ['hakuho.html', true],
  ['koyudo.html', false],
  ['takeda.html', false],
  ['n8.html', false],
  ['eihodo.html', false],
  ['chikuhodo.html', false],
  ['beautylish.html', true],   // beautylish 有品牌下拉
];

const BRAND_PAGES = new Set(['beautylish.html']);

for (const [f, hasDim] of PAGES) {
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('catalog-field')) { console.log('  = 已是新结构 ' + f); continue; }

  // 取原有搜索框的 placeholder
  const ph = (t.match(/id="catalogSearch"[^>]*placeholder="([^"]*)"/) || [])[1]
    || '搜索商品…';
  // 取媒体查询无关的 aria-label 保持可访问性
  const searchAria = (t.match(/id="catalogSearch"[^>]*aria-label="([^"]*)"/) || [])[1] || '搜索商品';
  const typeAria = (t.match(/id="catalogType"[^>]*aria-label="([^"]*)"/) || [])[1] || '按品类筛选';
  const dimAria = (t.match(/id="catalogDim"[^>]*aria-label="([^"]*)"/) || [])[1] || '按二级分类筛选';

  const typeLabel = hasDim ? '一级品类' : '品类';

  const lines = [];
  lines.push('        <div class="catalog-tools" aria-label="商品筛选工具">');
  lines.push('          <label class="catalog-field catalog-field--search">');
  lines.push('            <span class="catalog-field__label">搜索</span>');
  lines.push('            <input id="catalogSearch" type="search" placeholder="' + ph + '" aria-label="' + searchAria + '" />');
  lines.push('          </label>');
  lines.push('          <label class="catalog-field">');
  lines.push('            <span class="catalog-field__label">' + typeLabel + '</span>');
  lines.push('            <select id="catalogType" aria-label="' + typeAria + '"></select>');
  lines.push('          </label>');
  if (BRAND_PAGES.has(f)) {
    lines.push('          <!-- 品牌：catalog.js 只在数据带 brand 字段时才显示 -->');
    lines.push('          <label class="catalog-field" id="catalogBrandWrap" hidden>');
    lines.push('            <span class="catalog-field__label">品牌</span>');
    lines.push('            <select id="catalogBrand" aria-label="按品牌筛选"></select>');
    lines.push('          </label>');
  }
  if (hasDim) {
    lines.push('          <label class="catalog-field" id="catalogDimWrap" hidden>');
    lines.push('            <span class="catalog-field__label">二级分类</span>');
    lines.push('            <select id="catalogDim" aria-label="' + dimAria + '"></select>');
    lines.push('          </label>');
  }
  lines.push('          <span id="catalogCount" class="catalog-count">正在载入商品…</span>');
  lines.push('        </div>');
  const newBlock = lines.join('\n');

  // 用「从 catalog-tools 开始到 catalogCount 所在行结束」替换
  const start = t.indexOf('<div class="catalog-tools"');
  if (start < 0) { console.log('  ✗ 找不到工具栏 ' + f); continue; }
  const countIdx = t.indexOf('id="catalogCount"', start);
  if (countIdx < 0) { console.log('  ✗ 找不到 catalogCount ' + f); continue; }
  const countLineEnd = t.indexOf('\n', countIdx);
  // 再往后一行是工具栏的 </div>
  const closeIdx = t.indexOf('</div>', countLineEnd);
  if (closeIdx < 0) { console.log('  ✗ 找不到工具栏结束 ' + f); continue; }
  const end = closeIdx + '</div>'.length;

  t = t.slice(0, start) + newBlock + t.slice(end);
  fs.writeFileSync(f, t, 'utf8');
  console.log('  ✅ 已重构 ' + f);
}

console.log('\n完成。');
