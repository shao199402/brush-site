#!/usr/bin/env node
'use strict';
/**
 * Beautylish 抓取监督器（供 Windows 计划任务每 15 分钟调用一次）
 *
 * 为什么不用常驻守护进程：
 *   之前的 Node 守护脚本是**会话后台作业**，会话一重启它就随之消失——
 *   实测发生过「爬虫 + 守护同时死掉、白丢约 30 分钟」。
 *   改用计划任务：每次运行都是全新进程，不依赖会话存活。
 *
 * 每次运行做三件事：
 *   1) 抓取进程还在跑 → 直接退出（不做任何事）
 *   2) 抓取进程已死且未抓完 → 重新拉起（断点续跑，已缓存的秒过）
 *   3) 已经抓完 → 执行收尾：翻译 → 图片回填 → 构建（有完成标记则不重复执行）
 *
 * 用法（计划任务）：node scripts/beautylish-supervise.js
 * 手工查看：       node scripts/beautylish-supervise.js --status
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA, 'beautylish-cache');
const DONE_FILE = path.join(DATA, '_bl-finalized.json');
const DETAIL_LOG = path.join(DATA, '_bl-detail.log');
const SUP_LOG = path.join(DATA, '_bl-supervisor.log');

const argv = process.argv.slice(2);
const STATUS_ONLY = argv.includes('--status');

const TOTAL = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'beautylish-list.json'), 'utf8')).count || 0; } catch { return 0; }
})();

function log(msg) {
  const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + msg;
  console.log(line);
  /**
   * ⚠️ EBUSY 防护：这个日志文件同时被 appendFileSync（本函数）和
   * runStep 的 spawn（stdio 指向同一个文件）写入。Windows 上若两者撞在一起，
   * 打开文件会抛 EBUSY —— 实测这会让整个监督器进程**崩溃退出**，
   * 结果是抓取虽然完成了，收尾三步一步都没跑。
   * 因此这里必须包 try/catch，并且**只记内存中的 console**，
   * 不能因为写日志失败而中断主流程。
   */
  try { fs.appendFileSync(SUP_LOG, line + '\n', 'utf8'); } catch { /* 写不进去也不能崩 */ }
}

/** 同步小睡（不 spawn 子进程，避免额外开销） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const t = Date.now(); while (Date.now() - t < ms) { /* busy wait */ } }
}

/** 带重试的文件追加（runStep 打开日志文件时可能与 log() 争用 → EBUSY） */
function openLogFileRetry(file, tries = 6) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { return fs.openSync(file, 'a'); } catch (e) { lastErr = e; }
    sleepSync(150);
  }
  throw lastErr || new Error('无法打开日志文件');
}

function cacheCount() {
  try { return fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

/** 抓取进程是否存活（wmic 查命令行，避免误判其它 node 进程） */
function crawlAlive() {
  try {
    const r = spawnSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'CommandLine', '/format:list'],
      { encoding: 'utf8', timeout: 25000 });
    return /beautylish-detail\.js/.test(r.stdout || '');
  } catch { return false; }
}

function startCrawl() {
  const out = fs.openSync(DETAIL_LOG, 'a');
  /**
   * nav-delay=2500（而不是早先的 1200）
   *
   * 教训：以 1.2 秒的导航间隔连续抓了约 4.5 小时 / 1700+ 页面后，
   * 站点开始限速——商品页要 25 秒以上才渲染出正文，每件都耗满超时（29s），
   * 速率从 7.6 秒/件恶化到 36 秒/件。
   * 冷却 15 分钟后恢复（实测就绪等待回到 <1 秒）。
   * 因此改用更温和的 2.5 秒间隔：慢一些，但不容易再次触发限速，
   * 综合下来反而更快（不必反复等 25 秒超时 + 重建会话）。
   */
  const child = spawn(process.execPath,
    [path.join(ROOT, 'scripts', 'beautylish-detail.js'), '--detail', '--nav-delay=2500', '--breadth-first'],
    { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  log('已拉起抓取进程 pid=' + child.pid + '（nav-delay=2500，当前缓存 ' + cacheCount() + ' / ' + TOTAL + '）');
  return child.pid;
}

/** 抓取结束的标志：日志里出现「完成」或「成功 N，失败 M」 */
function crawlFinished() {
  try {
    const b = fs.readFileSync(DETAIL_LOG);
    const txt = (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe)
      ? b.toString('utf16le').replace(/\0/g, '')
      : b.toString('utf8');
    return /^\s*完成\s*$/m.test(txt) || /^\s*成功 \d+，失败 \d+/m.test(txt);
  } catch { return false; }
}

/** 收尾步骤（串行执行，避免互相抢资源） */
function runStep(label, args) {
  return new Promise((resolve) => {
    log('收尾：' + label + ' 开始');
    let out;
    try {
      out = openLogFileRetry(SUP_LOG);      // EBUSY 时重试，避免整个监督器崩溃
    } catch (e) {
      log('收尾：' + label + ' 无法打开日志文件：' + e.message);
      return resolve(-1);
    }
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', out, out] });
    child.on('close', (code) => {
      try { fs.closeSync(out); } catch { /* ignore */ }
      log('收尾：' + label + ' 结束（退出码 ' + code + '）');
      resolve(code);
    });
    child.on('error', (e) => {
      try { fs.closeSync(out); } catch { /* ignore */ }
      log('收尾：' + label + ' 启动失败：' + e.message);
      resolve(-1);
    });
  });
}

(async () => {
  const count = cacheCount();
  const alive = crawlAlive();

  if (STATUS_ONLY) {
    console.log('=== Beautylish 监督器状态 ===');
    console.log('  枚举总数: ' + TOTAL);
    console.log('  已缓存  : ' + count + ' (' + (TOTAL ? (count / TOTAL * 100).toFixed(1) : '?') + '%)');
    console.log('  抓取进程: ' + (alive ? '存活' : '不存活'));
    console.log('  已收尾  : ' + fs.existsSync(DONE_FILE));
    return;
  }

  // 已完成收尾 → 什么都不做
  if (fs.existsSync(DONE_FILE)) return;

  // 抓取进程活着 → 什么都不做（保持安静，避免日志噪音）
  if (alive) return;

  // 进程死了：判断是"抓完了"还是"中断了"
  if (crawlFinished()) {
    log('检测到抓取已结束（缓存 ' + count + ' / ' + TOTAL + '），开始收尾');
    await runStep('翻译', [path.join(ROOT, 'scripts', 'run-with-key.js'), 'beautylish-translate.js', '--batch=25', '--concurrency=3']);
    await runStep('图片回填', [path.join(ROOT, 'scripts', 'beautylish-images.js'), '--concurrency=6']);
    await runStep('构建', [path.join(ROOT, 'scripts', 'beautylish-build.js')]);
    fs.writeFileSync(DONE_FILE, JSON.stringify({
      finishedAt: new Date().toISOString(),
      cached: cacheCount(),
      total: TOTAL,
    }, null, 2), 'utf8');
    log('==== 收尾完成，已生成 beautylish-data.js ====');
    return;
  }

  // 中断了 → 重新拉起
  log('抓取进程不存活且未完成（' + count + ' / ' + TOTAL + '），重新拉起');
  startCrawl();
})();
