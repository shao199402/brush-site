#!/usr/bin/env node
'use strict';
/**
 * 推送「代码 + 数据」到 GitHub（不含图片），基于 Git Data API
 *
 * 为什么不用 git push：
 *   · 本地缺少 assets/ 下 3000+ 张图片（远端有、本地没有），
 *     git push 是整树操作，会把这些图片从远端**删除**，直接毁掉线上站点；
 *   · 443 端口时通时断，整包推送容易中断且失败后状态难恢复。
 *
 * Git Data API 的做法：
 *   1. 读取远端 main 的 tree（拿到每个文件的 blob sha）
 *   2. 本地用 `git hash-object` 同款算法算出每个文件的 blob sha
 *      → 只有 sha 不同（或远端没有）的文件才需要上传
 *   3. 逐个上传 blob，再基于远端现有 tree 打补丁（base_tree），
 *      因此不会删除任何远端已有文件
 *   4. 创建 commit 并移动 main 引用
 *
 * 排除：
 *   · assets/**            图片，另行走 api-push-images.js
 *   · .github/workflows/** 需要 token 的 workflow 权限，当前 token 没有
 *   · data/**              中间产物与缓存（.gitignore 已排除）
 *
 * 用法：node scripts/push-site.js            dry-run，只列清单
 *       node scripts/push-site.js --go       真正提交
 *       node scripts/push-site.js --go --allow-dup   连未变化的文件也重传
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'shao199402';
const REPO = 'brush-site';
const API = 'https://api.github.com';
const GO = process.argv.includes('--go');
const ALLOW_DUP = process.argv.includes('--allow-dup');
const CONCURRENCY = 3;
const MAX_RETRY = 12;
const TREE_CHUNK = 1;      // 实测：一次提交多条会 404，只能逐条累加

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
if (!TOKEN) { console.error('拿不到 gh token，请先 gh auth login'); process.exit(1); }

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

async function apiRetry(method, url, body, label) {
  let last = '';
  for (let i = 1; i <= MAX_RETRY; i++) {
    try {
      const r = await api(method, url, body);
      if (r.ok) return r;
      last = 'HTTP ' + r.status + ' ' + (r.text || '').slice(0, 200);
      // 4xx（限流除外）重试无意义
      if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 422) {
        throw new Error(last + (label ? '  [' + label + ']' : ''));
      }
    } catch (e) {
      last = e.message;
      if (/HTTP 4(?!29)/.test(e.message) && !/HTTP 422/.test(e.message)) throw e;
    }
    await sleep(Math.min(1500 * i, 15000));
  }
  throw new Error('重试 ' + MAX_RETRY + ' 次仍失败: ' + last + (label ? '  [' + label + ']' : ''));
}

/** git blob sha：sha1("blob <字节数>\0" + 内容) */
function gitBlobSha(buf) {
  const head = Buffer.from('blob ' + buf.length + '\0', 'utf8');
  return crypto.createHash('sha1').update(head).update(buf).digest('hex');
}

/** 需要同步的本地文件（相对路径，正斜杠） */
function collectLocalFiles() {
  const out = [];
  const SKIP_DIR = new Set(['.git', 'node_modules', 'assets', 'data', '.github']);
  const SKIP_EXT = new Set(['.log', '.tmp', '.bak', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.mp4']);
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') && ent.name !== '.gitignore') continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (SKIP_DIR.has(ent.name)) continue;
        walk(abs);
      } else {
        const ext = path.extname(ent.name).toLowerCase();
        if (SKIP_EXT.has(ext)) continue;
        out.push(rel);
      }
    }
  };
  walk(ROOT);
  return out.sort();
}

(async () => {
  console.log('=== 读取远端 main ===');
  const refR = await apiRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/main');
  const remoteSha = refR.json.object.sha;
  const commitR = await apiRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + remoteSha);
  const baseTree = commitR.json.tree.sha;
  console.log('  commit ' + remoteSha.slice(0, 8) + '   tree ' + baseTree.slice(0, 8));

  console.log('\n=== 读取远端文件列表（recursive tree）===');
  const treeR = await apiRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/' + baseTree + '?recursive=1');
  const remoteFiles = new Map();
  for (const e of treeR.json.tree || []) {
    if (e.type === 'blob') remoteFiles.set(e.path, e.sha);
  }
  console.log('  远端文件数: ' + remoteFiles.size);
  console.log('  远端图片数: ' + [...remoteFiles.keys()].filter((p) => /^assets\//.test(p)).length);

  const local = collectLocalFiles();
  const toUpload = [];
  const identical = [];
  for (const rel of local) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const sha = gitBlobSha(buf);
    const remoteShaFile = remoteFiles.get(rel);
    if (remoteShaFile === sha && !ALLOW_DUP) {
      identical.push({ path: rel, size: buf.length });
    } else {
      toUpload.push({ path: rel, size: buf.length, sha, isNew: !remoteShaFile });
    }
  }

  const newFiles = toUpload.filter((f) => f.isNew);
  const changed = toUpload.filter((f) => !f.isNew);
  const totalBytes = toUpload.reduce((s, f) => s + f.size, 0);

  console.log('\n=== 推送计划 ===');
  console.log('  本地文件总数: ' + local.length);
  console.log('  未变化（跳过）: ' + identical.length);
  console.log('  新增: ' + newFiles.length);
  console.log('  修改: ' + changed.length);
  console.log('  需要上传体积: ' + (totalBytes / 1048576).toFixed(2) + ' MB');
  console.log('');
  console.log('  ── 新增 ──');
  newFiles.forEach((f) => console.log('    ' + (f.size / 1024).toFixed(0).padStart(7) + ' KB  ' + f.path));
  console.log('  ── 修改 ──');
  changed.forEach((f) => console.log('    ' + (f.size / 1024).toFixed(0).padStart(7) + ' KB  ' + f.path));

  if (!toUpload.length) { console.log('\n远端已是最新，无需推送。'); return; }
  if (!GO) { console.log('\n（dry-run。加 --go 才真正提交）'); return; }

  // ── 上传 blob ──
  console.log('\n=== 上传 blob（并发 ' + CONCURRENCY + '）===');
  const results = new Array(toUpload.length);
  let cursor = 0, done = 0, failed = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= toUpload.length) return;
      const f = toUpload[i];
      try {
        const buf = fs.readFileSync(path.join(ROOT, f.path));
        const r = await apiRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
          content: buf.toString('base64'),
          encoding: 'base64',
        }, f.path);
        results[i] = { path: f.path, mode: '100644', type: 'blob', sha: r.json.sha };
        done++;
        console.log('  [' + done + '/' + toUpload.length + '] ' + f.path);
      } catch (err) {
        failed++;
        console.log('  ✗ 失败: ' + f.path + '  ' + err.message);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (failed > 0) {
    console.log('\n有 ' + failed + ' 个文件上传失败，为避免半成品提交已中止。可重跑（会重新校验）。');
    process.exit(1);
  }

  // ── 建 tree（基于远端现有 tree，逐条累加，绝不删除已有文件）──
  console.log('\n=== 创建 tree（base_tree 打补丁，保留全部远端图片）===');
  let curTree = baseTree;
  for (let i = 0; i < results.length; i += TREE_CHUNK) {
    const chunk = results.slice(i, i + TREE_CHUNK).map((r) => ({
      path: r.path, mode: r.mode, type: r.type, sha: r.sha,
    }));
    const tr = await apiRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
      base_tree: curTree,
      tree: chunk,
    }, results[i].path);
    curTree = tr.json.sha;
    if ((i + 1) % 10 === 0 || i + 1 === results.length) {
      console.log('  ' + (i + 1) + '/' + results.length + '  → tree ' + curTree.slice(0, 8));
    }
  }
  console.log('  最终 tree: ' + curTree);

  // ── 建 commit ──
  const msg = [
    'Add second-level categories for all modules; improve mobile layout',
    '',
    '通过 GitHub Git Data API 提交（基于远端现有 tree 打补丁，不删除任何已有图片）。',
    '',
    '数据：',
    '- 七个模块统一新增 level1（一级分类）与 dimensions（二级分类）',
    '- 白凤堂：系列/用途/毛质 三维（40 项），来自 65 个 Shopify 集合',
    '- 晃佑堂：一级=用途，二级=系列（47 个型号系列）',
    '- 竹田/竹宝堂/永丰堂：一级=用途归并，二级=原有细分',
    '- 熊永堂：二级=站点「用途別」11 个子类',
    '- Beautylish：一级=站点 tag（8 组），二级=原有品类（20 种）',
    '',
    '前端：',
    '- catalog.js 支持 level1 与任意维度键，二级下拉随一级联动',
    '- 七个页面补「二级分类」下拉，工具栏标签化',
    '- 移动端适配：标题字号下限、hero 压缩、工具栏两列、输入框 16px 防缩放、',
    '  详情弹窗全屏 + 图库横滑、首页模块入口前置',
    '',
    '脚本：各级分类补全工具与 Beautylish tag 抓取（含无效 tag 校验）',
  ].join('\n');

  const cR = await apiRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: msg,
    tree: curTree,
    parents: [remoteSha],
  });
  console.log('\n=== 新 commit: ' + cR.json.sha + ' ===');

  const uR = await apiRetry('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/main', {
    sha: cR.json.sha,
    force: false,
  });
  console.log('  更新 main: HTTP ' + uR.status + '  →  ' + (uR.json && uR.json.object ? uR.json.object.sha.slice(0, 8) : ''));

  console.log('\n✅ 推送完成。远端 main = ' + cR.json.sha.slice(0, 8));
  console.log('   上传 ' + toUpload.length + ' 个文件（' + (totalBytes / 1048576).toFixed(2) + ' MB），未删除任何远端文件。');
})().catch((e) => { console.error('\n失败: ' + e.message); process.exit(1); });
