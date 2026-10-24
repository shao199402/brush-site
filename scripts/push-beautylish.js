#!/usr/bin/env node
'use strict';
/**
 * 推送 Beautylish（07 模块）到 GitHub —— 走 Git Data API
 *
 * 为什么不用 git push：
 *   本地 origin/main 引用**已过期**（指向 7792587），而远程实际是 abf372e4。
 *   `git push` 是**整树操作**：推上去会用本地树覆盖远程树，把远程存在、
 *   本地没有的文件（例如 assets/hakuho/ 的 2367 张图）**全部删掉**。
 *   这个坑在本次工作中已经踩过一次（当时 3062 张线上图片被删，紧急回滚）。
 *
 * Git Data API 的做法：
 *   1) 读远程 main 的真实 commit → 取出它的 tree 作为 base_tree
 *   2) 把本次要更新的文件逐个上传为 blob
 *   3) 用 base_tree 打补丁生成新 tree（**不列举的文件原封不动**）
 *   4) 以远程 commit 为 parent 创建 commit，最后 PATCH ref
 *   全程只"新增/覆盖"指定的文件，绝不删除任何远程文件。
 *
 * 用法：
 *   node scripts/push-beautylish.js              dry-run（看清单与体积）
 *   node scripts/push-beautylish.js --go         真正推送
 *   node scripts/push-beautylish.js --go --only-code   只推代码/数据，跳过图片
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GO = process.argv.includes('--go');
const ONLY_CODE = process.argv.includes('--only-code');
const OWNER = 'shao199402';
const REPO = 'brush-site';
const API = 'https://api.github.com';
const STATE_FILE = path.join(ROOT, 'data', '_push-beautylish-state.json');
const CONCURRENCY = 4;
const MAX_RETRY = 12;

const TOKEN = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-push',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function apiRetry(method, url, body) {
  let last = '';
  for (let i = 1; i <= MAX_RETRY; i++) {
    try {
      const r = await api(method, url, body);
      if (r.ok) return r;
      last = 'HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 160);
      // 4xx（除限流）重试无意义
      if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new Error(last);
    } catch (e) {
      if (/^HTTP 4/.test(e.message)) throw e;
      last = e.message;
    }
    await sleep(Math.min(1500 * i, 12000));
  }
  throw new Error(last || '未知错误');
}

/** 本次要推送的文件 */
function collectFiles() {
  const out = [];

  // ① 代码与数据（小，优先推）
  const singles = [
    'index.html',
    'style.css',
    'catalog.js',
    'beautylish.html',
    'beautylish-data.js',
    '.gitignore',
    'scripts/lib-cdp.js',
    'scripts/beautylish-scrape.js',
    'scripts/beautylish-detail.js',
    'scripts/beautylish-translate.js',
    'scripts/beautylish-images.js',
    'scripts/beautylish-build.js',
    'scripts/beautylish-watch.js',
    'scripts/beautylish-status.js',
    'scripts/beautylish-run-all.js',
    'scripts/beautylish-supervise.js',
    'scripts/beautylish-supervise.cmd',
    'data/beautylish-list.json',
    'data/beautylish-gone.json',
  ];
  for (const f of singles) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push({ path: f, local: p });
  }

  // ② 图片（大，可跳过）
  if (!ONLY_CODE) {
    const dir = path.join(ROOT, 'assets', 'beautylish');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isFile()) out.push({ path: 'assets/beautylish/' + f, local: p });
      }
    }
  }
  return out;
}

(async () => {
  console.log('=== 读取远端 main 的真实状态 ===');
  const refR = await apiRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/main');
  const remoteSha = refR.json.object.sha;
  const commitR = await apiRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + remoteSha);
  const baseTree = commitR.json.tree.sha;
  console.log('  远端 commit: ' + remoteSha.slice(0, 8));
  console.log('  base tree  : ' + baseTree.slice(0, 8));

  const files = collectFiles();
  let total = 0;
  for (const f of files) total += fs.statSync(f.local).size;
  console.log('\n=== 待推送 ' + files.length + ' 个文件，共 ' + (total / 1048576).toFixed(1) + ' MB ===');
  console.log('  代码/数据: ' + files.filter((f) => !f.path.startsWith('assets/')).length + ' 个');
  console.log('  图片      : ' + files.filter((f) => f.path.startsWith('assets/')).length + ' 个');
  files.slice(0, 6).forEach((f) => console.log('    ' + (fs.statSync(f.local).size / 1024).toFixed(0).padStart(7) + ' KB  ' + f.path));

  if (!GO) {
    console.log('\n（dry-run。加 --go 才真正推送）');
    return;
  }

  // 断点续传：已上传的 blob 记录在 state 里
  let state = { uploaded: {}, remoteSha: null, treeSha: null };
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || state; } catch { /* 首次 */ }
  if (state.remoteSha && state.remoteSha !== remoteSha) {
    console.log('\n⚠ 远端 main 已变化（' + String(state.remoteSha).slice(0, 8) + ' → ' + remoteSha.slice(0, 8) + '），重置续传状态');
    state = { uploaded: {}, remoteSha, treeSha: null };
  }
  state.remoteSha = remoteSha;

  console.log('\n=== 上传 blob（并发 ' + CONCURRENCY + '，断点续传）===');
  const results = new Array(files.length);
  let done = 0, failed = 0, skipped = 0;
  let cursor = 0;

  async function saveState() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), 'utf8'); } catch { /* ignore */ }
  }

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= files.length) return;
      const f = files[i];
      const cached = state.uploaded[f.path];
      if (cached) {
        results[i] = { path: f.path, mode: '100644', type: 'blob', sha: cached };
        skipped++;
        continue;
      }
      const buf = fs.readFileSync(f.local);
      try {
        const r = await apiRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
          content: buf.toString('base64'),
          encoding: 'base64',
        });
        results[i] = { path: f.path, mode: '100644', type: 'blob', sha: r.json.sha };
        state.uploaded[f.path] = r.json.sha;
        done++;
        if (done % 100 === 0) {
          console.log('  已上传 ' + done + '（续传跳过 ' + skipped + '）');
          await saveState();
        }
      } catch (err) {
        failed++;
        console.log('  ✗ 失败: ' + f.path + '  ' + err.message);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await saveState();

  if (failed > 0) {
    console.log('\n有 ' + failed + ' 个失败，为避免半成品提交，本次中止。重跑即可续传。');
    process.exit(1);
  }
  console.log('  全部就绪（新上传 ' + done + '，续传 ' + skipped + '）');

  // 建 tree：基于远端 base_tree 分块累加，不删除任何已有文件
  console.log('\n=== 创建 tree（base_tree = 远端现有 tree）===');
  const CHUNK = 8;
  let curTree = baseTree;
  for (let i = 0; i < results.length; i += CHUNK) {
    const chunk = results.slice(i, i + CHUNK).map((r) => ({
      path: r.path, mode: '100644', type: 'blob', sha: r.sha,
    }));
    const tr = await apiRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
      base_tree: curTree,
      tree: chunk,
    });
    curTree = tr.json.sha;
    if ((i + CHUNK) % 400 === 0 || i + CHUNK >= results.length) {
      console.log('  ' + Math.min(i + CHUNK, results.length) + '/' + results.length + '  → tree ' + curTree.slice(0, 8));
    }
    state.treeSha = curTree;
  }
  await saveState();
  console.log('  最终 tree: ' + curTree);

  console.log('\n=== 创建 commit ===');
  const msg = [
    'Rebuild Beautylish (module 07) with full catalog',
    '',
    '页面：beautylish.html（新增第七模块入口，首页 7 个模块卡片）',
    '数据：beautylish-data.js —— 3044 件商品，104 个品牌',
    '  · 翻译覆盖 3040/3044（99.9%），详情中位 346 字',
    '  · 图片覆盖 3040/3044（99.9%）',
    '  · 已排除 51 件下架商品（不留空壳卡片）',
    '',
    '管线：scripts/beautylish-*.js（枚举 / 详情 / 翻译 / 图片 / 构建 / 监督）',
    '  · 渲染后 HTML + Node 侧解析，避开 SPA 缺字中间态',
    '  · 90 秒单件硬超时 + 每件独立会话（避免共享页面导致整轮挂死）',
    '  · 下架检测与变体页跟随（/p/ → /b/ 判下架，→ /s/ 继续抓）',
    '  · Windows 计划任务监督器，独立于会话，中断自动续跑',
    '',
    '通过 GitHub Git Data API 提交，基于远端现有 tree，不删除任何已有文件。',
  ].join('\n');

  const cR = await apiRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: msg,
    tree: curTree,
    parents: [remoteSha],
  });
  const newSha = cR.json.sha;
  console.log('  新 commit: ' + newSha);

  console.log('\n=== 更新 main 引用 ===');
  const uR = await apiRetry('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/main', {
    sha: newSha,
    force: false,
  });
  console.log('  HTTP ' + uR.status + '  →  ' + (uR.json && uR.json.object ? uR.json.object.sha : ''));
  console.log('\n✅ 完成。远端 main 现在指向 ' + newSha.slice(0, 8));
  try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* ignore */ }
})().catch((e) => { console.error('\n✗ 失败: ' + e.message); process.exit(1); });
