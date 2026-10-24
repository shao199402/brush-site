'use strict';
/**
 * 给还缺「二级分类」下拉的页面插入控件（幂等）
 *
 * 插入的是带标签的 .catalog-field 结构，与白凤堂页一致：
 *   <label class="catalog-field" id="catalogDimWrap" hidden>
 *     <span class="catalog-field__label">二级分类</span>
 *     <select id="catalogDim" aria-label="按二级分类筛选"></select>
 *   </label>
 * 默认 hidden，由 catalog.js 的 renderDims() 在数据有 dimensions 时显示。
 */
const fs = require('fs');
const ROOT = 'H:/site-publish';
const FILES = ['hakuho.html', 'koyudo.html', 'takeda.html', 'n8.html', 'eihodo.html', 'chikuhodo.html', 'beautylish.html'];

const SNIPPET = [
  '          <label class="catalog-field" id="catalogDimWrap" hidden>',
  '            <span class="catalog-field__label">二级分类</span>',
  '            <select id="catalogDim" aria-label="按二级分类筛选"></select>',
  '          </label>',
].join('\n');

let added = 0, skipped = 0;
for (const f of FILES) {
  const p = ROOT + '/' + f;
  let t = fs.readFileSync(p, 'utf8');
  if (t.includes('id="catalogDim"')) { console.log('  = 已有 ' + f); skipped++; continue; }

  // 插在 catalogCount 那一行之前
  const idx = t.indexOf('id="catalogCount"');
  if (idx < 0) { console.log('  ✗ 找不到 catalogCount ' + f); continue; }
  const lineStart = t.lastIndexOf('\n', idx) + 1;
  t = t.slice(0, lineStart) + SNIPPET + '\n' + t.slice(lineStart);
  fs.writeFileSync(p, t, 'utf8');
  console.log('  ✅ 已插入 ' + f);
  added++;
}
console.log('\n插入 ' + added + ' 个，跳过 ' + skipped + ' 个');
