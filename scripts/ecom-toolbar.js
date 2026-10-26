'use strict';
/**
 * 把 7 个页面的筛选工具栏改造成「电商商品墙」结构
 *
 * 旧结构：搜索框 + 两个下拉 + 计数（目录式）
 * 新结构（参考淘宝/京东）：
 *   ① 搜索行：搜索框 + 排序下拉
 *   ② 一级分类：横向可滑动的标签页（全部 / 化妆刷 / 日本画笔 …）
 *   ③ 二级分类：横向可滑动的筛选条（跟随一级联动）
 *   ④ 品牌（仅 Beautylish）：下拉
 *   ⑤ 底部计数
 *
 * 幂等：已含 .catalog-toolbar 就跳过。
 */
const fs = require('fs');

const PAGES = ['hakuho.html', 'koyudo.html', 'takeda.html', 'n8.html', 'eihodo.html', 'chikuhodo.html', 'beautylish.html'];
const BRAND_PAGES = new Set(['beautylish.html']);

for (const f of PAGES) {
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('catalog-toolbar')) { console.log('  = 已是新结构 ' + f); continue; }

  const start = t.indexOf('<div class="catalog-tools"');
  if (start < 0) { console.log('  ✗ 找不到工具栏 ' + f); continue; }
  // 深度扫描找到匹配的 </div>
  let depth = 0, end = -1;
  for (let i = start; i < t.length; i++) {
    if (t.startsWith('<div', i)) depth++;
    else if (t.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) { end = i + '</div>'.length; break; }
    }
  }
  if (end < 0) { console.log('  ✗ 找不到结束标签 ' + f); continue; }

  const old = t.slice(start, end);
  const ph = (old.match(/id="catalogSearch"[^>]*placeholder="([^"]*)"/) || [])[1] || '搜索商品…';

  const lines = [];
  lines.push('<div class="catalog-toolbar" aria-label="商品筛选">');
  lines.push('  <div class="toolbar-searchrow">');
  lines.push('    <input id="catalogSearch" type="search" placeholder="' + ph + '" aria-label="搜索商品" />');
  lines.push('    <select id="catalogSort" class="toolbar-sort" aria-label="排序方式">');
  lines.push('      <option value="default">综合排序</option>');
  lines.push('      <option value="price-asc">价格从低到高</option>');
  lines.push('      <option value="price-desc">价格从高到低</option>');
  lines.push('    </select>');
  lines.push('  </div>');
  lines.push('  <div class="toolbar-tabs" id="catalogTabs" role="tablist" aria-label="一级分类"></div>');
  if (BRAND_PAGES.has(f)) {
    lines.push('  <div class="toolbar-chips" id="catalogBrandWrap" hidden>');
    lines.push('    <span class="chips-label">品牌</span>');
    lines.push('    <select id="catalogBrand" class="chips-select" aria-label="按品牌筛选"></select>');
    lines.push('  </div>');
  }
  lines.push('  <div class="toolbar-chips" id="catalogDimWrap" hidden>');
  lines.push('    <span class="chips-label">二级分类</span>');
  lines.push('    <div class="chips-scroll" id="catalogDim"></div>');
  lines.push('  </div>');
  lines.push('  <div class="toolbar-meta"><span id="catalogCount">正在载入商品…</span></div>');
  lines.push('</div>');

  const block = lines.map((l) => '        ' + l).join('\n');
  t = t.slice(0, start) + block + t.slice(end);
  fs.writeFileSync(f, t, 'utf8');
  console.log('  ✅ 已改造 ' + f);
}
console.log('\n完成。');
