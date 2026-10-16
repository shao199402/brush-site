#!/usr/bin/env node
'use strict';
/**
 * Beautylish 模块总控：按顺序完成「抓取 → 翻译 → 图片回填 → 构建」
 *
 * 为什么要有这个脚本：
 *   抓取很慢（约 7.6 秒/件 × 3095 件 ≈ 6.5 小时）。若在抓取同时跑翻译/构建，
 *   会抢 CPU 与网络导致站点限速（实测速率从 7.6 秒/件恶化到 11 秒/件并出现卡顿）。
 *   所以收尾步骤应当**串行**执行，且只在抓取完成后做。
 *
 * 与 beautylish-watch.js 的区别：
 *   watch 是常驻守护（每小时汇报、进程死了自动重启、抓完自动收尾）；
 *   run-all 是「一次性跑完整条链」，适合手动收尾或抓取已完成后的重跑。
 *
 * 用法：
 *   node scripts/beautylish-run-all.js             抓取（跳过已缓存）→ 翻译 → 图片 → 构建
 *   node scripts/beautylish-run-all.js --skip-crawl  只做收尾三步
 *   node scripts/beautylish-run-all.js --build-only  只重建数据
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA, 'beautylish-cache');

const argv = process.argv.slice(2);
const SKIP_CRAWL = argv.includes('--skip-crawl');
const BUILD_ONLY = argv.includes('--build-only');

const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

function cacheCount() {
  try { return fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

function total() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'beautylish-list.json'), 'utf8')).count; } catch { return 0; }
}

function step(label, args) {
  log('开始：' + label);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) log('⚠ ' + label + ' 退出码 ' + r.status);
  else log('完成：' + label);
  return r.status;
}

(async () => {
  const T = total();
  log('目标商品数：' + T + '   当前缓存：' + cacheCount());

  if (!BUILD_ONLY && !SKIP_CRAWL) {
    if (cacheCount() < T) {
      step('抓取详情', [path.join(ROOT, 'scripts', 'beautylish-detail.js'),
        '--detail', '--nav-delay=1200', '--breadth-first']);
    } else {
      log('缓存已满，跳过抓取');
    }
  }

  if (!BUILD_ONLY) {
    step('翻译（增量）', [path.join(ROOT, 'scripts', 'run-with-key.js'),
      'beautylish-translate.js', '--batch=25', '--concurrency=3']);
    step('图片回填', [path.join(ROOT, 'scripts', 'beautylish-images.js'), '--concurrency=6']);
  }

  step('构建数据', [path.join(ROOT, 'scripts', 'beautylish-build.js')]);

  log('缓存：' + cacheCount() + ' / ' + T);
  log('全部步骤结束');
})();
