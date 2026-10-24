#!/usr/bin/env node
'use strict';
/**
 * 用 GitHub Git Data API 推送「代码 + 数据」（不含图片）
 *
 * 为什么不用 git push：
 *   - 本地有 253 MB（含 3472 张新图），而 443 端口时通时断，大包必然中断；
 *   - 过滤掉 assets 后 git push 会**从远端删除已有的 3062 张图**（白凤堂/晃佑堂），
 *     那会直接毁掉线上站点——git push 是整树操作，做不到"只推一部分文件"。
 *
 * Git Data API 的做法：逐个上传需要的文件为 blob，再基于远端**现有的 tree** 打补丁
 * 生成新 tree，提交后移动 main 引用。这样：
 *   - 只传 ≈9.4 MB（65 个文件），不碰任何已有图片；
 *   - 每个文件独立重试，断线只影响当前这一个。
 *
 * 用法：node scripts/api-push-code.js            （先 dry-run 看清单）
 *       node scripts/api-push-code.js --go       （真正提交）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GO = process.argv.includes('--go');
const OWNER = 'shao199402';
const REPO = 'brush-site';
const API = 'https://api.github.com';
const CONCURRENCY = 4;
const MAX_RETRY = 12;

const g = (args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return ((r.stdout || '') + (r.stderr || '')).trim();
};
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
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function apiRetry(method, url, body, label) {
  for (let i = 1; i <= MAX_RETRY; i++) {
    try {
      const r = await api(method, url, body);
      if (r.ok) return r;
      // 4xx（除限流）重试无意义
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        throw new Error('HTTP ' + r.status + ' ' + (r.text || '').slice(0, 160));
      }
      if (i === MAX_RETRY) throw new Error('HTTP ' + r.status + ' ' + (r.text || '').slice(0, 160));
    } catch (e) {
      if (/^HTTP 4/.test(e.message)) throw e;
      if (i === MAX_RETRY) throw new Error(e.message);
    }
    await sleep(Math.min(1500 * i, 12000));
  }
}

(async () => {
  console.log('=== 读取远端当前 main ===');
  const refR = await apiRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/main');
  const remoteSha = refR.json.object.sha;
  const commitR = await apiRetry('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + remoteSha);
  const baseTree = commitR.json.tree.sha;
  console.log('  commit ' + remoteSha.slice(0, 8) + '   tree ' + baseTree.slice(0, 8));

  // 待提交的文件（新增/修改，去掉 assets）
  //
  // 注意：**必须跳过 .github/workflows/**。
  // 实测确认：通过 Git Data API 把 workflow 文件写进 tree 会返回 404
  // （同一次请求换成普通路径就 201），因为改动 .github/workflows 需要
  // token 带 workflow 权限，而当前 gh token 只有 repo/gist/read:org。
  // 该 workflow 只是 CI 便利脚本，站点发布不需要它。
  const all = g(['diff', '--name-only', '--diff-filter=AM', 'origin/main', 'HEAD']).split('\n').filter(Boolean);
  const skippedWf = all.filter((f) => /^\.github\/workflows\//.test(f));
  const files = all.filter((f) => !/^assets\//.test(f) && !/^\.github\/workflows\//.test(f));
  console.log('\n=== 将提交 ' + files.length + ' 个文件 ===');
  console.log('  跳过图片: ' + all.filter((f) => /^assets\//.test(f)).length + ' 个');
  console.log('  跳过 workflow: ' + skippedWf.length + ' 个' + (skippedWf.length ? '（' + skippedWf.join(', ') + '）' : ''));
  console.log('  ⚠ workflow 需 token 带 workflow 权限（gh auth refresh -s workflow）才能推送');

  let total = 0;
  const entries = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) { console.log('  ! 本地缺失，跳过: ' + f); continue; }
    const st = fs.statSync(p);
    total += st.size;
    entries.push({ path: f.replace(/\\/g, '/'), size: st.size });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  console.log('  总体积: ' + (total / 1048576).toFixed(2) + ' MB');
  entries.slice(0, 8).forEach((e) => console.log('    ' + (e.size / 1024).toFixed(0).padStart(6) + ' KB  ' + e.path));

  if (!GO) {
    console.log('\n（这是 dry-run。加 --go 才真正提交）');
    return;
  }

  // 上传 blob
  console.log('\n=== 上传 blob（并发 ' + CONCURRENCY + '，逐个重试）===');
  const results = new Array(entries.length);
  let done = 0, failed = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= entries.length) return;
      const e = entries[i];
      const buf = fs.readFileSync(path.join(ROOT, e.path));
      try {
        const r = await apiRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
          content: buf.toString('base64'),
          encoding: 'base64',
        });
        results[i] = {
          path: e.path,
          mode: '100644',
          type: 'blob',
          sha: r.json.sha,
        };
        done++;
        if (done % 10 === 0 || done === entries.length) console.log('  已上传 ' + done + '/' + entries.length);
      } catch (err) {
        failed++;
        console.log('  ✗ 失败: ' + e.path + '  ' + err.message);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (failed > 0) {
    console.log('\n有 ' + failed + ' 个文件上传失败，为避免半成品提交，本次中止。可重跑（已上传的会重传）。');
    process.exit(1);
  }

  // 建 tree（基于远端现有 tree 打补丁，path 需要 base_tree）
  //
  // 踩过的坑：一次性提交 65 个条目建树会返回 **404 Not Found**（不是权限问题，
  // 直接探针测试同接口返回 201）。改为**分块**建树：每次提交一小批，
  // 用上一批的 tree 作为 base_tree 继续累加，最后得到一个合并后的 tree。
  // 这样每次请求体都很小，也不会触发服务端的隐性限制。
  console.log('\n=== 创建 tree（基于远端现有 tree，分块累加，不删除任何已有文件）===');
  const CHUNK = 1;
  let curTree = baseTree;
  for (let i = 0; i < results.length; i += CHUNK) {
    const chunk = results.slice(i, i + CHUNK).map((r) => ({
      path: r.path,
      mode: '100644',
      type: 'blob',   // 必须显式给出，缺了会 404
      sha: r.sha,
    }));
    try {
      const tr = await apiRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
        base_tree: curTree,
        tree: chunk,
      });
      curTree = tr.json.sha;
      if ((i + CHUNK) % 8 === 0 || i + CHUNK === results.length) {
        console.log('  ' + Math.min(i + CHUNK, results.length) + '/' + results.length + '  → tree ' + curTree.slice(0, 8));
      }
    } catch (err) {
      console.log('\n  ✗ 建树失败于第 ' + (i + 1) + ' 个条目:');
      chunk.forEach((c) => console.log('      path=' + c.path + '  sha=' + c.sha + '  mode=' + c.mode + '  type=' + c.type));
      throw err;
    }
  }
  const treeSha = curTree;
  console.log('  最终 tree: ' + treeSha);

  // 建 commit
  console.log('\n=== 创建 commit ===');
  const msg = [
    'Add new brand modules, homepage redesign, and rebuild data',
    '',
    '通过 GitHub Git Data API 提交（仅代码与数据，不含图片）。',
    '图片（竹田/熊永堂/永丰堂/竹宝堂等 3472 张）待网络条件允许时另行分批提交。',
    '',
    '包含：',
    '- chikuhodo.html / chikuhodo-data.js（竹宝堂）',
    '- 首页模块卡改版：去缩略图、中英文名称居中放大（中文在上、英文在下）',
    '- catalog.js 支持「数据带 brand 时才启用品牌筛选」',
    '- 各品牌抓取/翻译管线脚本与 data/ 下的中间数据',
    '- .gitignore 排除日志、截图、逐件缓存',
  ].join('\n');
  const cR = await apiRetry('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: msg,
    tree: treeSha,
    parents: [remoteSha],
  });
  console.log('  新 commit: ' + cR.json.sha);

  // 移动 main 引用
  console.log('\n=== 更新 main 引用 ===');
  const uR = await apiRetry('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/main', {
    sha: cR.json.sha,
    force: false,
  });
  console.log('  结果: HTTP ' + uR.status + '  ' + (uR.json && uR.json.object ? uR.json.object.sha : ''));

  console.log('\n✅ 完成。远端 main 现为 ' + cR.json.sha.slice(0, 8));
  console.log('   下一步可执行 git fetch origin 让本地同步。');
})();
