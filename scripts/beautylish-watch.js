#!/usr/bin/env node
'use strict';
/**
 * Beautylish 详情抓取 · 守护 + 进度汇报
 *
 * 为什么用 Node 而不是 PowerShell：
 *   本机只有 PowerShell 5.1，且 .ps1 一旦不是「UTF-8 带 BOM」就会被按 ANSI 读，
 *   中文注释与字符串直接乱码、语法报错（这个坑在本项目里反复出现）。
 *   Node 读 UTF-8 无此问题，且子步骤本来就是 node 脚本。
 *
 * 职责：
 *   1) 每 reportMs 记录一次进度（默认 1 小时）
 *   2) 检测抓取进程；若在抓完前停掉，自动重启（断点续跑，不会白抓）
 *   3) 连续多轮无新增则判定为被限速，拉长等待
 *   4) 抓完后自动收尾：翻译（增量）→ 构建 beautylish-data.js
 *
 * 用法：
 *   node scripts/beautylish-watch.js               前台运行（适合用后台作业拉起）
 *   node scripts/beautylish-watch.js --interval=600   10 分钟汇报一次（调试）
 *   node scripts/beautylish-watch.js --stop        请求守护优雅退出
 *
 * 日志：data/_bl-monitor.log
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const LOG = path.join(DATA, '_bl-monitor.log');
const DETAIL_LOG = path.join(DATA, '_bl-detail.log');
const CACHE_DIR = path.join(DATA, 'beautylish-cache');
const STOP_FILE = path.join(DATA, '_bl-watch-stop');

/** 总件数从枚举结果动态读，避免写死后与实际不一致 */
const TOTAL = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'beautylish-list.json'), 'utf8'));
    return Number(j.count) || Number((j.items || []).length) || 0;
  } catch { return 0; }
})();

const argv = process.argv.slice(2);
const argVal = (n, d) => {
  const hit = argv.find((a) => a === n || a.startsWith(n + '='));
  if (!hit) return d;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const INTERVAL_MS = Number(argVal('--interval', 3600)) * 1000;
const POLL_MS = 20000;

if (argv.includes('--stop')) {
  fs.writeFileSync(STOP_FILE, new Date().toISOString(), 'utf8');
  console.log('已写入停止标记：' + STOP_FILE);
  process.exit(0);
}
if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);

function log(msg) {
  const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheCount() {
  try { return fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

/** 抓取进程是否存活（用 wmic 查命令行，避免误判其它 node 进程） */
function crawlAlive() {
  try {
    const r = spawnSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'CommandLine', '/format:list'],
      { encoding: 'utf8', timeout: 20000 });
    return /beautylish-detail\.js/.test(r.stdout || '');
  } catch { return false; }
}

function startCrawl() {
  log('启动详情抓取（断点续跑）');
  const out = fs.openSync(DETAIL_LOG, 'a');
  const err = fs.openSync(path.join(DATA, '_bl-detail.err.log'), 'a');
  const child = spawn(process.execPath,
    [path.join(ROOT, 'scripts', 'beautylish-detail.js'), '--detail', '--nav-delay=1200', '--breadth-first'],
    { cwd: ROOT, detached: true, stdio: ['ignore', out, err] });
  child.unref();
  log('已拉起抓取进程 pid=' + child.pid);
}

function crawlDone() {
  // 用 status 模块读取（自动处理 UTF-16LE —— Windows 重定向写出的是 UTF-16，
  // 之前用 UTF-8 读会全是乱码，导致误判"日志为空"）
  //
  // ⚠️ 关键：**必须确认抓取进程已经不在运行**，否则会误判。
  // 日志是**追写**的：若守护重启过抓取（或手工重启），上一轮留下的
  // "完成 / 成功 N，失败 M" 仍在文件里，只看标记会让守护在新一轮刚起步时
  // 就以为抓完了，直接跳到收尾——那样只会得到一个残缺的目录。
  try {
    if (crawlAlive()) return false;      // 进程还活着 → 一定没结束
    const { readLogSmart } = require('./beautylish-status.js');
    const txt = readLogSmart(DETAIL_LOG);
    return /^\s*完成\s*$/m.test(txt) || /^\s*成功 \d+，失败 \d+/m.test(txt);
  } catch { return false; }
}

/** 跑一个收尾步骤并等它结束 */
function runStep(label, args) {
  return new Promise((resolve) => {
    log('收尾步骤：' + label);
    const out = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', out, out] });
    child.on('close', (code) => { log(label + ' 结束（退出码 ' + code + '）'); resolve(code); });
    child.on('error', (e) => { log(label + ' 启动失败：' + e.message); resolve(-1); });
  });
}

(async () => {
  log('==== 守护启动（总计 ' + TOTAL + ' 件，汇报间隔 ' + (INTERVAL_MS / 60000) + ' 分钟）====');

  let lastReport = Date.now();
  let lastCount = cacheCount();
  let round = 0;
  let stallRounds = 0;

  while (true) {
    if (fs.existsSync(STOP_FILE)) { log('检测到停止标记，退出守护'); break; }

    const count = cacheCount();

    // 抓完 → 收尾
    if (count >= TOTAL || crawlDone()) {
      log('抓取完成：缓存 ' + count + ' / ' + TOTAL + '，开始收尾');
      await runStep('翻译', [path.join(ROOT, 'scripts', 'run-with-key.js'), 'beautylish-translate.js', '--batch=40', '--concurrency=3']);
      await runStep('图片回填', [path.join(ROOT, 'scripts', 'beautylish-images.js'), '--concurrency=6']);
      await runStep('构建', [path.join(ROOT, 'scripts', 'beautylish-build.js')]);
      log('==== 全部完成：缓存 ' + cacheCount() + ' 件，已生成 beautylish-data.js ====');
      break;
    }

    // 进程死了 → 重启
    if (!crawlAlive()) {
      log('抓取进程不存活（当前 ' + count + ' / ' + TOTAL + '），自动重启');
      startCrawl();
      await sleep(15000);
    }

    // 每小时汇报
    if (Date.now() - lastReport >= INTERVAL_MS) {
      round++;
      const delta = count - lastCount;
      const remain = TOTAL - count;
      let rateTxt, etaTxt;
      if (delta > 0) {
        const perMin = delta / (INTERVAL_MS / 60000);
        rateTxt = '本轮新增 ' + delta + ' 件';
        etaTxt = '预计还需约 ' + Math.round(remain / perMin) + ' 分钟';
        stallRounds = 0;
      } else {
        rateTxt = '本轮无新增（可能被限速）';
        etaTxt = '预计时间未知';
        stallRounds++;
      }
      log('【进度汇报 ' + round + '】缓存 ' + count + ' / ' + TOTAL
        + '（' + (count / TOTAL * 100).toFixed(1) + '%）  ' + rateTxt + '  ' + etaTxt
        + (crawlAlive() ? '  进程存活' : '  进程不存活'));

      // 长时间无进展：只记录告警，重启仍按上面的存活检测处理
      if (stallRounds >= 3) log('⚠ 连续 ' + stallRounds + ' 轮无新增，疑似被限速；进程仍存活则继续等待');

      lastReport = Date.now();
      lastCount = count;
    }

    await sleep(POLL_MS);
  }

  log('守护退出');
})();
