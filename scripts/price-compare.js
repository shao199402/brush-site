#!/usr/bin/env node
'use strict';
/**
 * 各模块价格变化对比引擎
 *
 * 职责（纯计算 + 报告，**不改动任何数据文件**）：
 *   1) 读取各模块当前的 *-data.js（作为「基准价」）
 *   2) 读取最新抓到的线上价格快照
 *   3) 逐件对比，产出：涨价 / 降价 / 新增商品 / 下架商品 / 取价失败
 *   4) 写成 JSON 快照 + 人类可读的 Markdown 报告
 *
 * 为什么「基准价」用 *-data.js 而不是上一份快照：
 *   快照是每天临时产物，可能因网络失败而残缺；*-data.js 才是站点正在展示的数据，
 *   用户关心的是「线上展示的价格 vs 现在官网的价格」。快照之间互比会在
 *   某天抓取失败时产生大量假变化。
 *
 * 归一化：
 *   日元各品牌统一成整数 yen；Beautylish 统一成整数 cny（两者不混算）。
 *   原始显示文本（如 "8,250 日元（含税）"、"CN¥45"）保留在 raw 字段里。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SNAP_DIR = path.join(DATA, 'price-snapshots');
const REPORT_DIR = path.join(DATA, 'price-reports');
const LATEST = path.join(SNAP_DIR, 'latest.json');

const { BRANDS } = require('./price-adapters.js');

/** 从 *-data.js 读商品数组 */
function loadLocalProducts(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf8');
  const m = txt.match(/window\.PRODUCTS\s*=\s*(\[[\s\S]*\])\s*;/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/**
 * 把价格显示文本归一化成数值。
 *   白凤堂      "￥25,190 含税"        → 25190
 *   晃佑堂等    "13,750 日元（含税）"   → 13750
 *   Beautylish  "CN¥45"               → 45
 */
function parsePriceNumeric(raw) {
  const s = String(raw == null ? '' : raw);
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Beautylish 的 handle 是 `beautylish-<枚举 slug>`，而列表页给出的 slug 可能
 * 带规格后缀（如 -15ml），因此按「前缀匹配」把线上价格对回本地 handle。
 * 做法：建一个本地前缀索引，取线上 slug 能匹配到的最长本地前缀。
 */
function buildBeautylishMatcher(localList) {
  const byPrefix = new Map();
  const handles = [];
  for (const x of localList) {
    const h = String(x.handle || '').replace(/^beautylish-/, '');
    if (!h) continue;
    handles.push(h);
    byPrefix.set(h, x);
  }
  return (slug) => {
    const s = String(slug || '').toLowerCase();
    if (byPrefix.has(s)) return byPrefix.get(s);
    // 线上 slug 更短 → 找以它开头的本地 handle
    // 线上 slug 更长 → 截断后找
    let best = null;
    for (const h of handles) {
      if (s.startsWith(h) || h.startsWith(s)) {
        if (!best || Math.min(h.length, s.length) > Math.min(best.length, s.length)) best = h;
      }
    }
    return best ? byPrefix.get(best) : null;
  };
}

/**
 * 对比一个品牌。
 * @param {string} key        品牌键
 * @param {Map}    online     slug/handle → { raw, yen|cny, ... }
 * @param {object} opts       { fetchFailed: number, totalTried: number }
 */
function compareBrand(key, online, opts = {}) {
  const b = BRANDS[key];
  const local = loadLocalProducts(b.file);
  if (!local) {
    return { key, label: b.label, error: '读不到 ' + b.file, changes: [] };
  }

  const isBeautylish = key === 'beautylish';
  const match = isBeautylish ? buildBeautylishMatcher(local) : null;

  const changed = [];      // 价格变动
  const matched = new Set();  // 已与线上对上的本地 handle
  let noOnlinePrice = 0;
  let rangeSkipped = 0;

  for (const x of local) {
    const handle = String(x.handle || '');
    let cur = null;

    if (isBeautylish) {
      const slug = handle.replace(/^beautylish-/, '');
      cur = online.get(slug) || null;
      if (!cur) {
        // 前缀匹配：遍历线上全部 key 找能对上的
        for (const [s, v] of online) {
          if (s.startsWith(slug) || slug.startsWith(s)) { cur = v; break; }
        }
      }
    } else {
      const h = key === 'hakuho' ? handle.toLowerCase() : handle;
      cur = online.get(h) || online.get(handle.toLowerCase()) || null;
    }

    if (!cur) { noOnlinePrice++; continue; }

    /**
     * 区间价跳过对比（Beautylish 常见）。
     * 列表卡片显示 "CN¥45 - CN¥330" 表示「最小规格~最大规格」的跨度，
     * 不是单一售价；本地数据存的是某个具体规格的价格。
     * 两者相比会得到「降价 60%」这类假结论（实测 142 项假变动几乎都源于此）。
     */
    if (cur.isRange) { rangeSkipped++; continue; }

    matched.add(handle);

    const oldRaw = x.price;
    const oldNum = parsePriceNumeric(oldRaw);
    const newNum = isBeautylish ? cur.cny : cur.yen;
    if (oldNum == null || newNum == null) continue;
    if (Math.abs(oldNum - newNum) < 0.005) continue;   // 价格未变

    changed.push({
      handle,
      title: x.title,
      oldRaw: String(oldRaw == null ? '' : oldRaw),
      newRaw: cur.raw,
      oldNum,
      newNum,
      delta: newNum - oldNum,
      pct: oldNum ? ((newNum - oldNum) / oldNum) * 100 : null,
      direction: newNum > oldNum ? 'up' : 'down',
    });
  }

  // 线上有、本地没有 → 新增商品
  //
  // ⚠️ 必须排除「已下架」商品：它们虽然仍出现在列表页（带价格），
  // 但详情页会 302 到品牌页、实际买不到。实测某次报告里 46 件"新增"
  // **全部**属于这一类，真正的 0 件，若不过滤会产生纯噪音。
  // 下架清单由抓取阶段产出（data/beautylish-gone.json）。
  const goneSet = (() => {
    try { return new Set(JSON.parse(fs.readFileSync(path.join(DATA, 'beautylish-gone.json'), 'utf8'))); } catch { return new Set(); }
  })();
  let goneReappeared = 0;
  const added = [];
  for (const [slug, v] of online) {
    if (goneSet.has(slug)) { goneReappeared++; continue; }
    const already = isBeautylish
      ? local.some((x) => {
        const h = String(x.handle || '').replace(/^beautylish-/, '');
        return h === slug || h.startsWith(slug) || slug.startsWith(h);
      })
      : local.some((x) => String(x.handle || '').toLowerCase() === String(slug).toLowerCase());
    if (!already) added.push({ slug, ...v });
  }

  return {
    key,
    label: b.label,
    currency: b.currency,
    localCount: local.length,
    onlineCount: online.size,
    matchedCount: matched.size,
    noOnlinePrice,
    rangeSkipped,
    fetchFailed: opts.fetchFailed || 0,
    changes: changed.sort((a, z) => Math.abs(z.pct || 0) - Math.abs(a.pct || 0)),
    added,
    goneReappeared,
  };
}

/** 生成 Markdown 报告 */
function renderReport(result, meta) {
  const L = [];
  const ts = meta.generatedAt;
  L.push('# 价格变动报告 · ' + ts.slice(0, 10));
  L.push('');
  L.push('生成时间：' + ts.replace('T', ' ').slice(0, 19) + ' UTC');
  L.push('');

  // 总览表
  L.push('## 总览');
  L.push('');
  L.push('| 模块 | 本地件数 | 线上件数 | 对上价格 | 价格变动 | 线上新增 | 取价失败 | 区间价跳过 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of result.brands) {
    if (r.error) {
      L.push('| ' + r.label + ' | — | — | — | — | — | ' + r.error + ' | — |');
      continue;
    }
    L.push('| ' + r.label + ' | ' + r.localCount + ' | ' + r.onlineCount + ' | ' + r.matchedCount
      + ' | **' + r.changes.length + '** | ' + r.added.length + ' | ' + r.fetchFailed
      + ' | ' + (r.rangeSkipped || 0) + ' |');
  }
  L.push('');
  const totalChanged = result.brands.reduce((a, r) => a + (r.changes ? r.changes.length : 0), 0);
  const totalAdded = result.brands.reduce((a, r) => a + (r.added ? r.added.length : 0), 0);
  const totalGoneReappeared = result.brands.reduce((a, r) => a + (r.goneReappeared || 0), 0);
  L.push('合计：**' + totalChanged + ' 项价格变动**，**' + totalAdded + ' 件新增商品**。');
  if (totalGoneReappeared) {
    L.push('');
    L.push('> 另有 ' + totalGoneReappeared + ' 件商品仍出现在站点列表页（带价格），'
      + '但详情页会跳转到品牌页——即已下架、实际买不到，因此**未计入新增**。');
  }
  L.push('');

  // 明细
  for (const r of result.brands) {
    if (r.error) continue;
    if (!r.changes.length && !r.added.length) {
      L.push('### ' + r.label + ' — 无变化');
      L.push('');
      continue;
    }
    L.push('### ' + r.label + '（' + r.changes.length + ' 项变动，' + r.added.length + ' 件新增）');
    L.push('');
    if (r.changes.length) {
      L.push('| 商品 | 原价 | 现价 | 变动 |');
      L.push('|---|---:|---:|---:|');
      for (const c of r.changes) {
        const sign = c.delta > 0 ? '+' : '';
        const pct = c.pct == null ? '' : ' (' + sign + c.pct.toFixed(1) + '%)';
        const arrow = c.direction === 'up' ? '↑' : '↓';
        L.push('| ' + String(c.title).replace(/\|/g, '/').slice(0, 46)
          + ' | ' + c.oldRaw + ' | ' + c.newRaw + ' | ' + arrow + ' ' + sign + c.delta + pct + ' |');
      }
      L.push('');
    }
    if (r.added.length) {
      L.push('**线上新增商品**（本地数据里还没有）：');
      L.push('');
      for (const a of r.added.slice(0, 40)) {
        L.push('- `' + a.slug + '`  ' + (a.raw || '') + (a.title ? '  ' + a.title : ''));
      }
      if (r.added.length > 40) L.push('- …另有 ' + (r.added.length - 40) + ' 件');
      L.push('');
    }
  }

  if (meta.warnings && meta.warnings.length) {
    L.push('## 注意');
    L.push('');
    meta.warnings.forEach((w) => L.push('- ' + w));
    L.push('');
  }
  return L.join('\n');
}

/** 保存快照与报告 */
function persist(result, meta) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  /**
   * 日期戳用**本地日期**，不能用 UTC。
   *
   * 踩过的坑：计划任务在本地 00:00 触发，而本机时区是 UTC+8，
   * 此刻 UTC 还是**前一天 16:00**。于是零点跑出来的报告被命名成前一天的
   * 文件，把当天已经跑好的报告**覆盖**掉（实测发生：10-18 零点的运行
   * 写进了 2026-10-17.md）。用本地日期才符合「每天一份报告」的直觉。
   */
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  const snapFile = path.join(SNAP_DIR, stamp + '.json');
  fs.writeFileSync(snapFile, JSON.stringify(result, null, 1), 'utf8');
  fs.writeFileSync(LATEST, JSON.stringify(result, null, 1), 'utf8');

  const md = renderReport(result, meta);
  const mdFile = path.join(REPORT_DIR, stamp + '.md');
  fs.writeFileSync(mdFile, md, 'utf8');

  return { snapFile, mdFile };
}

module.exports = {
  loadLocalProducts,
  parsePriceNumeric,
  compareBrand,
  renderReport,
  persist,
  SNAP_DIR,
  REPORT_DIR,
  LATEST,
};
