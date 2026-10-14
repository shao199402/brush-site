#!/usr/bin/env node
'use strict';
/**
 * 极小的 HTML 片段工具 —— 供各品牌抓取脚本共用。
 *
 * 为什么不用正则切割：晃佑堂站方的 HTML **本身不配平**（整页 <div> 比 </div> 多一个），
 * 用「数 div 配平」找元素边界必然错，实测会把后面的价格区、购物车按钮整段吞进来，
 * 导致详情页错版。这里改为**跟踪标签栈**扫描：
 *   - 用站点自己的开始/结束注释做首选边界；
 *   - 用标签栈把结果修正成**自配平**的 HTML 片段（缺的闭合标签补上、多的闭合标签丢弃）。
 *
 * 关键约束：**只允许补/删标签，绝不改动文字与属性**，这样「保留原有样式」才成立。
 */

/** 这些标签不参与嵌套（自闭合或空元素） */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** 这些标签自动闭合，不能进栈（浏览器解析时视为自闭合） */
const AUTO_CLOSE = new Set(['br', 'hr', 'img', 'input', 'link', 'meta', 'wbr', 'source', 'track', 'area', 'base', 'col', 'embed', 'param']);

/**
 * 把一段 HTML 片段修正为自配平的片段：
 *   - 未闭合的开标签在末尾按栈逆序补齐；
 *   - 多余/不匹配的闭合标签被丢弃（不改动其周围文字）。
 * 返回 { html, added, dropped }
 */
function balanceFragment(fragment) {
  const src = String(fragment || '');
  const out = [];
  const stack = [];
  let added = 0;
  let dropped = 0;
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(src))) {
    out.push(src.slice(last, m.index));
    const raw = m[0];
    last = tagRe.lastIndex;
    if (raw.startsWith('<!--') || raw.startsWith('<![')) {
      out.push(raw);
      continue;
    }
    const name = (m[1] || '').toLowerCase();
    const isClose = raw.charAt(1) === '/';
    const selfClosed = /\/\s*>$/.test(raw);
    if (name === 'script' || name === 'style') {
      // 脚本/样式整体跳过，里面的 < > 不算标签
      const closeRe = new RegExp('</' + name + '\\s*>', 'i');
      const rest = src.slice(last);
      const cm = closeRe.exec(rest);
      if (cm) {
        out.push(rest.slice(0, cm.index + cm[0].length));
        last += cm.index + cm[0].length;
        tagRe.lastIndex = last;
      } else {
        out.push(rest);
        last = src.length;
      }
      continue;
    }
    if (AUTO_CLOSE.has(name) || selfClosed) {
      out.push(raw);
      continue;
    }
    if (!isClose) {
      stack.push(name);
      out.push(raw);
    } else {
      const idx = stack.lastIndexOf(name);
      if (idx === -1) {
        dropped += 1; // 多余的闭合标签，丢弃
      } else {
        // 先补上它内部未闭合的标签
        for (let i = stack.length - 1; i > idx; i--) {
          out.push('</' + stack[i] + '>');
          added += 1;
        }
        stack.length = idx;
        out.push(raw);
      }
    }
  }
  out.push(src.slice(last));
  for (let i = stack.length - 1; i >= 0; i--) {
    out.push('</' + stack[i] + '>');
    added += 1;
  }
  return { html: out.join(''), added, dropped };
}

/**
 * 取某个「开始注释/元素」到「结束注释」之间的内容，并修正为自配平片段。
 * openNeedle  例如 'class="c-detailitem__info-txt"'
 * closeNeedle 例如 '//.c-detailitem__info-txt'
 */
function regionBetween(html, openNeedle, closeNeedle) {
  const a = String(html).indexOf(openNeedle);
  if (a === -1) return null;
  const start = String(html).indexOf('>', a);
  if (start === -1) return null;
  const b = String(html).indexOf(closeNeedle, start + 1);
  if (b === -1) return null;
  return String(html).slice(start + 1, b);
}

/**
 * 从「含 openNeedle 的那个开标签」之后开始，取到 stopMarkers 中**最早出现**的那个为止。
 *
 * 用途：晃佑堂的 discripstion2 区块**没有**配对的结束注释，但它之后必然出现站方的
 * 区块注释（`<!-- c-detailitem -->` 等）或页脚，用这些做右边界，比数 div 可靠。
 */
function regionUntilMarker(html, openNeedle, stopMarkers) {
  const src = String(html);
  const a = src.indexOf(openNeedle);
  if (a === -1) return null;
  const start = src.indexOf('>', a);
  if (start === -1) return null;
  let end = src.length;
  for (const mk of stopMarkers || []) {
    const i = src.indexOf(mk, start + 1);
    if (i !== -1 && i < end) end = i;
  }
  let seg = src.slice(start + 1, end);
  // 停止标记常指向注释**内部**，于是结果尾部会留下半个注释起始符 `<!--`。
  // 必须把「未闭合的注释起始符及其后内容」整段丢掉：翻译脚本会移除完整注释
  // （<!--...-->），若留半个 `<!--` 它不会被移除，产物里就会出现无闭合的注释碎片。
  // 注意丢弃 `<!--` 可能同时丢掉它前面某个未闭合标签的收尾，因此返回时标记一下，
  // 由 balanceFragment 补齐。
  const lastOpen = seg.lastIndexOf('<!--');
  if (lastOpen !== -1 && seg.indexOf('-->', lastOpen) === -1) seg = seg.slice(0, lastOpen);
  return seg;
}

/** 统计标签是否配平（供校验） */
function tagBalance(fragment) {
  const tags = ['div', 'table', 'tbody', 'tr', 'td', 'th', 'p', 'span', 'strong', 'font', 'b', 'u', 'i',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const bad = [];
  for (const t of tags) {
    const open = (String(fragment).match(new RegExp('<' + t + '\\b', 'gi')) || []).length;
    const close = (String(fragment).match(new RegExp('</' + t + '\\s*>', 'gi')) || []).length;
    if (open !== close) bad.push(t + '(' + open + '/' + close + ')');
  }
  return bad;
}

module.exports = { balanceFragment, regionBetween, regionUntilMarker, tagBalance, VOID_TAGS, AUTO_CLOSE };
