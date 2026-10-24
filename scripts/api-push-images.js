#!/usr/bin/env node
'use strict';
/**
 * 分批把图片推送到 GitHub（用 Git Data API）
 *
 * 为什么分批：
 *   图片共 3472 张、约 243 MB。443 端口时通时断，单个大请求必然中断。
 *   改成每批 N 张、每批一个独立 commit —— 断线只损失当前这一批，
 *   已完成的批次留在远端，重跑会自动跳过（支持断点续传）。
 *
 * 为什么用 API 而不是 git push：
 *   git push 是整树操作，无法"只推一部分文件"；且本地与远端的历史结构不同
 *   （远端有若干本地没有的图片）。API 可以只增量添加我们指定的文件，
 *   完全不碰远端已有内容。
 *
 * 用法：
 *   node scripts/api-push-images.js               每批 150 张（dry-run 看清单）
 *   node scripts/api-push-images.js --go          真正开始
 *   node scripts/api-push-images.js --go --batch=80
 *   node scripts/api-push-images.js --go --max-batches=3   只跑 3 批就停
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'shao199402';
const REPO = 'brush-site';
const API = 'https://api.github.com';
const STATE_FILE = path.join(ROOT, 'data', '_api-push-state.json');

const argv = process.argv.slice(2);
const GO = argv.includes('--go');
const argVal = (n, d) => {
  const hit = argv.find((a) => a === n || a.startsWith(n + '='));
  if (!hit) return d;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const BATCH = Number(argVal('--batch', 150));
const MAX_BATCHES = Number(argVal('--max-batches', 0)) || Infinity;
const CONCURRENCY = Number(argVal('--concurrency', 5));
const MAX_RETRY = 12;

const TOKEN = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body) {
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

async function callRetry(method, url, body, label) {
  let lastErr = '';
  for (let i = 1; i <= MAX_RETRY; i++) {
    try {
      const r = await call(method, url, body);
      if (r.ok) return r;
      lastErr = 'HTTP ' + r.status + ' ' + (r.text || '').slice(0, 140);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new Error(lastErr);
    } catch (e) {
      lastErr = e.message;
      if (/^HTTP 4/.test(e.message)) throw e;
    }
    await sleep(Math.min(1200 * i, 10000));
  }
  throw new Error(label + ' 重试 ' + MAX_RETRY + ' 次仍失败: ' + lastErr);
}

/** git 的 blob 哈希（判断文件是否真的变了，避免重复上传） */
function gitBlobSha(buf) {
  const header = Buffer.from('blob ' + buf.length + '\0', 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

/** 递归取远端整棵树 → Map<path, sha> */
async function remoteTreeMap(treeSha) {
  const map = new Map();
  const r = await callRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/' + treeSha + '?recursive=1', null, '读取远端树');
  for (const e of r.json.tree || []) {
    if (e.type === 'blob') map.set(e.path, e.sha);
  }
  return map;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { doneBatches: 0, uploaded: 0, lastCommit: null }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

(async () => {
  console.log('=== 读取远端 main ===');
  const refR = await callRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/main');
  let headSha = refR.json.object.sha;
  const commitR = await callRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + headSha);
  let baseTree = commitR.json.tree.sha;
  console.log('  commit ' + headSha.slice(0, 8) + '  tree ' + baseTree.slice(0, 8));

  console.log('\n=== 扫描本地图片 ===');
  const assetsDir = path.join(ROOT, 'assets');
  const local = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jpe?g|png|webp|gif|avif)$/i.test(e.name)) {
        local.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    }
  })(assetsDir);
  local.sort();
  console.log('  本地图片: ' + local.length + ' 张');

  const remote = await remoteTreeMap(baseTree);
  const remoteImgs = [...remote.keys()].filter((k) => k.startsWith('assets/'));
  console.log('  远端图片: ' + remoteImgs.length + ' 张');

  // 找出需要上传的：本地有但远端没有，或内容不同
  const todo = [];
  let totalBytes = 0;
  for (const rel of local) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const sha = gitBlobSha(buf);
    if (remote.get(rel) !== sha) {
      todo.push({ path: rel, sha, size: buf.length });
      totalBytes += buf.length;
    }
  }
  console.log('\n=== 待上传 ' + todo.length + ' 张，共 ' + (totalBytes / 1048576).toFixed(1) + ' MB ===');

  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  console.log('  每批 ' + BATCH + ' 张 → 共 ' + batches.length + ' 批');

  if (!todo.length) { console.log('\n远端已是最新，无需上传。'); return; }

  if (!GO) {
    console.log('\n（dry-run。加 --go 真正上传）');
    console.log('  前 8 张示例:');
    todo.slice(0, 8).forEach((t) => console.log('    ' + (t.size / 1024).toFixed(0).padStart(5) + ' KB  ' + t.path));
    return;
  }

  const state = loadState();
  console.log('\n=== 开始分批上传（并发 ' + CONCURRENCY + '）===');
  let doneBatches = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    if (doneBatches >= MAX_BATCHES) { console.log('\n达到 --max-batches 限制，停止。'); break; }

    const batch = batches[bi];
    const bytes = batch.reduce((a, b) => a + b.size, 0);
    const t0 = Date.now();
    console.log('\n--- 第 ' + (bi + 1) + '/' + batches.length + ' 批：' + batch.length + ' 张，' + (bytes / 1048576).toFixed(1) + ' MB ---');

    // 1) 上传本批 blob
    const entries = new Array(batch.length);
    let cursor = 0;
    let failed = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= batch.length) return;
        const item = batch[i];
        try {
          const buf = fs.readFileSync(path.join(ROOT, item.path));
          const r = await callRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs',
            { content: buf.toString('base64'), encoding: 'base64' }, '上传 ' + item.path);
          entries[i] = { path: item.path, mode: '100644', type: 'blob', sha: r.json.sha };
        } catch (err) {
          failed++;
          console.log('    ✗ ' + item.path + '  ' + err.message.slice(0, 90));
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (failed > 0) {
      console.log('  本批有 ' + failed + ' 张失败。为避免半成品提交，跳过本批（重跑会重试）。');
      continue;
    }

    // 2) 分块建树（每块 8 条，规避单请求 404）
    let curTree = baseTree;
    const CHUNK = 8;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const tr = await callRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees',
        { base_tree: curTree, tree: chunk }, '建树');
      curTree = tr.json.sha;
    }

    // 3) 提交
    const cR = await callRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
      message: 'Add product images (batch ' + (bi + 1) + '/' + batches.length + ')\n\n'
        + '本批 ' + batch.length + ' 张，' + (bytes / 1048576).toFixed(1) + ' MB。\n'
        + '通过 Git Data API 分批上传，避免单次大请求被网络中断。',
      tree: curTree,
      parents: [headSha],
    }, '建 commit');

    // 4) 移动引用
    const uR = await callRetry('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/main',
      { sha: cR.json.sha, force: false }, '更新引用');

    headSha = cR.json.sha;
    baseTree = curTree;
    doneBatches++;
    state.doneBatches = (state.doneBatches || 0) + 1;
    state.uploaded = (state.uploaded || 0) + batch.length;
    state.lastCommit = headSha;
    saveState(state);

    console.log('  ✅ 已提交 ' + headSha.slice(0, 8) + '  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
      + '  累计上传 ' + state.uploaded + ' 张');
  }

  console.log('\n=== 结束 ===');
  console.log('  远端 main: ' + headSha);
  console.log('  累计上传: ' + (state.uploaded || 0) + ' 张');
  console.log('  剩余: 重跑本脚本即可继续（会自动跳过已上传的）');
})();
