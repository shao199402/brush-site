#!/usr/bin/env node
'use strict';
/**
 * 价格巡检「执行情况自检」
 *
 * 为什么需要：计划任务**无法 100% 保证**每天跑成功——
 *   本机必须开机、必须已登录（Logon Mode=Interactive）、
 *   且可能被中断（实测 2026-10-19 零点的运行就返回了
 *   -1073741510 = STATUS_CONTROL_C_EXIT，当天没有报告）。
 * 与其假设它一定成功，不如能一眼看出「哪天缺了、哪天取价残缺」。
 *
 * 用法：
 *   node scripts/price-status.js          看最近 14 天
 *   node scripts/price-status.js --days=30
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'data', 'price-reports');
const SNAP_DIR = path.join(ROOT, 'data', 'price-snapshots');

const argv = process.argv.slice(2);
const argVal = (n, d) => {
  const h = argv.find((a) => a.startsWith('--' + n + '='));
  return h ? h.split('=').slice(1).join('=') : d;
};
const DAYS = Number(argVal('days', 14)) || 14;

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

function readReportSummary(stamp) {
  const p = path.join(REPORT_DIR, stamp + '.md');
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf8');
  // 从总览表里抓 Beautylish 行，判断取价是否残缺
  const blLine = txt.split(/\r?\n/).find((l) => /^\|\s*Beautylish/.test(l));
  let blOnline = null, blChanges = null;
  if (blLine) {
    const cells = blLine.split('|').map((s) => s.trim());
    // | Beautylish | 3044 | 2267 | 2006 | **22** | 0 | 0 | 240 |
    blOnline = Number(cells[3]) || null;
    blChanges = Number(String(cells[5] || '').replace(/[^\d]/g, '')) || 0;
  }
  const total = (txt.match(/合计：\*\*(\d+)\s*项价格变动\*\*，\*\*(\d+)\s*件新增商品\*\*/) || []);
  return {
    exists: true,
    bytes: fs.statSync(p).size,
    mtime: fs.statSync(p).mtime,
    blOnline,
    blChanges,
    totalChanged: total[1] ? Number(total[1]) : null,
    totalAdded: total[2] ? Number(total[2]) : null,
    isPartial: blOnline != null && blOnline < 2600,  // 清单 3095，低于 2600 视为明显残缺
  };
}

const today = new Date();
const rows = [];
let missing = 0, partial = 0;

for (let i = DAYS - 1; i >= 0; i--) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
  const stamp = fmt(d);
  const s = readReportSummary(stamp);
  const isToday = i === 0;
  if (!s) {
    if (!isToday) missing++;   // 今天可能还没到零点/还没跑，不算缺失
    rows.push({ stamp, status: isToday ? '今天（尚未生成）' : '缺失', s: null });
  } else {
    if (s.isPartial) partial++;
    rows.push({ stamp, status: 'OK', s });
  }
}

console.log('=== 价格巡检执行情况（最近 ' + DAYS + ' 天）===');
console.log('');
for (const r of rows) {
  if (!r.s) {
    console.log('  ' + r.stamp + '  ✗ ' + r.status);
    continue;
  }
  const s = r.s;
  const flag = s.isPartial ? '⚠ 残缺' : '✓';
  console.log('  ' + r.stamp + '  ' + flag
    + '  Beautylish 取价 ' + (s.blOnline == null ? '?' : s.blOnline) + '/3095'
    + '  变动 ' + (s.totalChanged == null ? '?' : s.totalChanged)
    + '  新增 ' + (s.totalAdded == null ? '?' : s.totalAdded)
    + '  报告 ' + (s.bytes / 1024).toFixed(1) + 'KB');
}

console.log('');
const okDays = rows.filter((r) => r.s && !r.s.isPartial).length;
const partialDays = rows.filter((r) => r.s && r.s.isPartial).length;
console.log('  完整可用: ' + okDays + ' 天');
console.log('  取价残缺: ' + partialDays + ' 天' + (partialDays ? '（Beautylish 限速导致，可重跑该天）' : ''));
console.log('  报告缺失: ' + missing + ' 天');

// 计划任务状态
try {
  const { spawnSync } = require('child_process');
  const r = spawnSync('schtasks', ['/Query', '/TN', 'PriceDailyCheck', '/FO', 'LIST', '/V'],
    { encoding: 'utf8', timeout: 20000 });
  const txt = r.stdout || '';
  const pick = (k) => {
    const m = txt.match(new RegExp(k + ':\\s*(.+)'));
    return m ? m[1].trim() : '?';
  };
  console.log('');
  console.log('=== 计划任务 ===');
  console.log('  下次运行: ' + pick('Next Run Time'));
  console.log('  上次运行: ' + pick('Last Run Time'));
  const lastResult = pick('Last Result');
  const okResult = lastResult === '0';
  console.log('  上次结果: ' + lastResult + (okResult ? '  ✓ 成功' : '  ✗ 非 0（进程被中断或失败）'));
  console.log('  登录模式: ' + pick('Logon Mode') + '（Interactive only 表示必须已登录才会跑）');
} catch { /* ignore */ }

console.log('');
console.log('提示：漏跑时可手动补一次 —— schtasks /Run /TN "PriceDailyCheck"');
