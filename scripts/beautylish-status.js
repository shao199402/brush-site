#!/usr/bin/env node
'use strict';
/**
 * 抓取状态检查（供守护脚本与人工排查用）
 *
 * 踩过的坑：进程用 `>` 重定向到文件时，Windows 上写出的是 **UTF-16LE**（带 ff fe BOM），
 * 用 UTF-8 读会全是乱码，导致误判"日志为空/任务卡死"。
 * 这里自动识别编码。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'data', '_bl-detail.log');
const CACHE = path.join(ROOT, 'data', 'beautylish-cache');
const TOTAL = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'beautylish-list.json'), 'utf8')).count; } catch { return 0; }
})();

/** 自动按 BOM 判断 UTF-16LE / UTF-8 */
function readLogSmart(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.toString('utf16le').replace(/\0/g, '');
    return b.toString('utf8');
  } catch { return ''; }
}

function count() {
  try { return fs.readdirSync(CACHE).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

function gaps() {
  try {
    const files = fs.readdirSync(CACHE).filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(CACHE, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    const g = [];
    for (let i = 1; i < files.length; i++) g.push({ gap: (files[i].t - files[i - 1].t) / 1000, after: files[i].f });
    return { files, g };
  } catch { return { files: [], g: [] }; }
}

if (require.main === module) {
  const n = count();
  const { files, g } = gaps();
  const now = Date.now();
  const lastWrite = files.length ? files[files.length - 1].t : 0;
  const stallMin = lastWrite ? (now - lastWrite) / 60000 : -1;

  const txt = readLogSmart(LOG);
  const progress = txt.split(/\r?\n/).filter((l) => /进度/.test(l)).slice(-2);
  const blocked = txt.split(/\r?\n/).filter((l) => /被挡|缺字/.test(l));
  // 结束判定要精确：不能只匹配"成功 N"，因为进度行里也含这个词
  const finished = /^\s*完成\s*$/m.test(txt) || /^\s*成功 \d+，失败 \d+/m.test(txt);

  const recent = g.slice(-50).map((x) => x.gap);
  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;

  console.log('=== Beautylish 抓取状态 ===');
  console.log('  进度        : ' + n + ' / ' + TOTAL + '  (' + (TOTAL ? (n / TOTAL * 100).toFixed(1) : '?') + '%)');
  console.log('  近期速率    : ' + avg.toFixed(1) + ' 秒/件');
  console.log('  停滞        : ' + (stallMin < 0 ? '无数据' : stallMin.toFixed(1) + ' 分钟'));
  console.log('  最大间隔    : ' + (g.length ? Math.max(...g.map((x) => x.gap)).toFixed(0) + ' 秒' : '-'));
  console.log('  卡顿(>60s)  : ' + g.filter((x) => x.gap > 60).length + ' 次');
  console.log('  预计剩余    : ' + (avg > 0 ? ((TOTAL - n) * avg / 3600).toFixed(1) + ' 小时' : '-'));
  console.log('  被挡/缺字   : ' + blocked.length + ' 次');
  console.log('  已结束      : ' + finished);
  if (progress.length) {
    console.log('  脚本自报    :');
    progress.forEach((l) => console.log('    ' + l.trim()));
  }
}

module.exports = { readLogSmart, count, gaps, TOTAL };
