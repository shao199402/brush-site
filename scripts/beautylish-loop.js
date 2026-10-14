#!/usr/bin/env node
'use strict';
/**
 * Beautylish 第七模块 · 小批次调度器（方案甲）
 *
 * 为什么用 Node 而不是 PowerShell 脚本：
 *   - 本机只有 Windows PowerShell 5.1（没有 pwsh），且 UTF-8 无 BOM 的 .ps1
 *     会被按 ANSI 读、中文注释直接乱码（实测踩过）；
 *   - 所有子步骤本来就是 node 脚本，用 Node 编排最省事、跨平台、无编码坑。
 *
 * 每批流程：抓 200 件 → 翻译 → 重建数据
 * 目的：任何一次中断，手里都是「已翻译好的一版」，而不是半成品。
 *
 * 用法：
 *   node scripts/beautylish-loop.js               默认每批 200 件
 *   node scripts/beautylish-loop.js --batch=100
 *   node scripts/beautylish-loop.js --once        只跑一批就退出
 *   node scripts/beautylish-loop.js --status      只看进度，不干活
 *
 * 日志：data/_bl-loop.log
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'beautylish-cache');
const LOG_FILE = path.join(ROOT, 'data', '_bl-loop.log');
const PROGRESS_FILE = path.join(ROOT, 'data', '_bl-progress.json');
const TOTAL = 3025;

const argv = process.argv.slice(2);
const argValue = (name) => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const BATCH = Math.max(10, Number(argValue('--batch') || 200));
const NAV_DELAY = Number(argValue('--nav-delay') || 3000);
const ONCE = argv.includes('--once');
const STATUS_ONLY = argv.includes('--status');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch { /* ignore */ }
}

function cacheCount() {
  try {
    return fs.readdirSync(CACHE_DIR).filter((f) => /\.json$/.test(f)).length;
  } catch { return 0; }
}

/** 运行子步骤，输出直接追加到日志（不改动其行为） */
function run(cmd, args, label) {
  return new Promise((resolve) => {
    log('[运行] ' + label);
    const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on('close', (code) => {
      out.end();
      log('[结束] ' + label + '  退出码 ' + code);
      resolve(code);
    });
    child.on('error', (err) => {
      out.end();
      log('[错误] ' + label + '  ' + err.message);
      resolve(-1);
    });
  });
}

const NODE = process.execPath;

async function main() {
  let n = cacheCount();
  log('==== 调度器启动（每批 ' + BATCH + ' 件，总目标 ' + TOTAL + '）当前缓存 ' + n + ' 件 ====');

  if (STATUS_ONLY) {
    log('--status：仅查看进度，缓存 ' + n + ' / ' + TOTAL + '（' + (n / TOTAL * 100).toFixed(1) + '%）');
    return;
  }

  // 从上次进度继续。用持久化 offset 而不是「批号 × 批大小」——
  // 后者会反复扫过已缓存区间（实测一批 20 件全在缓存区、白跑一轮）。
  let offset = 0;
  try {
    const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    if (typeof p.offset === 'number' && p.offset >= 0) offset = p.offset;
  } catch { /* 首次运行 */ }
  log('从 offset=' + offset + ' 继续' + (offset ? '（上次进度）' : ''));

  let stall = 0;
  let round = 0;

  while (true) {
    n = cacheCount();
    if (n >= TOTAL) { log('全部完成：缓存 ' + n + ' 件'); break; }
    if (offset >= TOTAL) {
      log('偏移已到尾部（' + offset + '），回退到 0 重扫以补齐缺口');
      offset = 0;
    }

    round += 1;
    log('---- 第 ' + round + ' 轮开始：offset=' + offset + '（缓存 ' + n + ' 件）----');

    // 1) 抓取本批（命中缓存会秒过）
    await run(NODE, [
      path.join(ROOT, 'scripts', 'beautylish-scrape.js'),
      '--detail', '--limit=' + BATCH, '--offset=' + offset, '--nav-delay=' + NAV_DELAY,
    ], '抓取 offset=' + offset + ' limit=' + BATCH);

    // 2) 翻译（增量）
    await run(NODE, [
      path.join(ROOT, 'scripts', 'run-with-key.js'),
      'beautylish-translate.js', '--batch=40', '--concurrency=3',
    ], '翻译');

    // 3) 重建数据
    //    注意**不能**传 --offset：构建必须处理全部枚举商品，
    //    否则 beautylish-data.js 会只剩本批 200 件、丢掉其余。
    //    （未抓到的商品会以英文原文 + 已有图片正常输出，成本很低。）
    await run(NODE, [
      path.join(ROOT, 'scripts', 'beautylish-build.js'),
    ], '重建数据');

    const after = cacheCount();
    const gained = after - n;
    log('---- 第 ' + round + ' 轮结束：缓存 ' + n + ' -> ' + after + '（+' + gained + '）----');

    // 推进 offset；本批有新增说明这一区间还没抓完，推进一批；否则继续往前找
    offset += BATCH;
    try {
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ offset, updatedAt: new Date().toISOString(), cache: after }, null, 2), 'utf8');
    } catch { /* ignore */ }

    if (after >= TOTAL) { log('全部完成：缓存 ' + after + ' 件'); break; }

    if (gained <= 0) {
      stall += 1;
      if (stall >= 3) {
        log('连续 ' + stall + ' 轮无新增，等 5 分钟再继续（可能被限速）');
        await sleep(300000);
        stall = 0;
      }
    } else {
      stall = 0;
    }

    if (ONCE) { log('--once：跑完一轮即退出'); break; }
  }

  log('调度器退出，最终缓存 ' + cacheCount() + ' / ' + TOTAL);
}

main().catch((err) => {
  log('调度器异常：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
