#!/usr/bin/env node
'use strict';
/**
 * Beautylish 图片回填：从详情缓存里取出图片 URL 并下载到本地。
 *
 * 为什么单独做：
 *   详情抓取用 `--no-images` 跑，把图片 URL 记进缓存（imageUrls 字段），
 *   这样抓取只做「页面 → 数据」这一件事，速度最稳。
 *   图片走 CloudFront CDN，**不受 WAF 限速**，可以并发下载，
 *   并且能与详情抓取并行，不用串行等两趟。
 *
 * 用法：
 *   node scripts/beautylish-images.js               下载缺失的（可反复跑）
 *   node scripts/beautylish-images.js --concurrency=8
 *   node scripts/beautylish-images.js --limit=100   只处理 100 件（调试）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA, 'beautylish-cache');
const ASSET_DIR = path.join(ROOT, 'assets', 'beautylish');
const ASSET_REL = 'assets/beautylish';
const ORIGIN = 'https://www.beautylish.com';

const argv = process.argv.slice(2);
const argValue = (n, d) => {
  const hit = argv.find((a) => a === n || a.startsWith(n + '='));
  if (!hit) return d;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency', 6)));
const LIMIT = Number(argValue('--limit', 0)) || 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function imageExt(url) {
  const m = String(url).match(/\.(jpe?g|png|gif|webp|avif)(?:\?|$)/i);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  return 'jpg';
}

/** 把详情页给的小图 URL 换成大图（CloudFront 支持 p_500x500 这类规格） */
function bigger(url) {
  return String(url).replace(/p_\d+x\d+/, 'p_500x500');
}

async function download(url, absPath) {
  if (fs.existsSync(absPath) && fs.statSync(absPath).size > 200) return { st: 'exists', bytes: 0 };
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: ORIGIN + '/' },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return { st: 'http' + res.status, bytes: 0 };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return { st: 'tiny', bytes: 0 };
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buf);
    return { st: 'saved', bytes: buf.length };
  } catch (e) {
    return { st: 'err:' + (e.name || 'x'), bytes: 0 };
  }
}

(async () => {
  fs.mkdirSync(ASSET_DIR, { recursive: true });

  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
  console.log('=== Beautylish 图片回填 ===');
  console.log('  详情缓存: ' + files.length + ' 件');

  // 收集需要下载的（每个商品取第一张）
  //
  // 注意：图片 URL 来自缓存里的 **JSON-LD product.image**，
  // 不是 `imageUrls`（那是脚本输出字段，并未写进缓存）。
  const tasks = [];
  let noUrl = 0, already = 0;
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch { continue; }
    const prod = j.product || {};
    const raw = Array.isArray(prod.image) ? prod.image : (prod.image ? [prod.image] : []);
    const urls = raw.filter((u) => /^https?:/i.test(u));
    if (!urls.length) { noUrl++; continue; }
    const big = bigger(urls[0]);
    const rel = ASSET_REL + '/' + j.slug + '-1.' + imageExt(big);
    const abs = path.join(ROOT, rel.split('/').join(path.sep));
    if (fs.existsSync(abs) && fs.statSync(abs).size > 200) { already++; continue; }
    tasks.push({ slug: j.slug, url: big, abs, rel });
  }

  const todo = LIMIT ? tasks.slice(0, LIMIT) : tasks;
  console.log('  已有图片: ' + already + ' 件');
  console.log('  无图片 URL: ' + noUrl + ' 件');
  console.log('  待下载: ' + todo.length + ' 件（并发 ' + CONCURRENCY + '）');

  if (!todo.length) { console.log('\n无需下载。'); return; }

  let done = 0, saved = 0, bytes = 0;
  const failKinds = {};
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      const t = todo[i];
      const r = await download(t.url, t.abs);
      done++;
      if (r.st === 'saved') { saved++; bytes += r.bytes; }
      else if (r.st !== 'exists') failKinds[r.st] = (failKinds[r.st] || 0) + 1;
      if (done % 25 === 0 || done === todo.length) {
        console.log('  进度 ' + done + '/' + todo.length + '  新下载 ' + saved
          + '  体积 ' + (bytes / 1048576).toFixed(1) + ' MB');
      }
      await sleep(30);   // 轻微节流，避免瞬时并发过高
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log('\n完成');
  console.log('  新下载: ' + saved + ' 张，' + (bytes / 1048576).toFixed(1) + ' MB');
  console.log('  用时: ' + ((Date.now() - t0) / 1000).toFixed(0) + ' 秒');
  if (Object.keys(failKinds).length) {
    console.log('  失败分类: ' + JSON.stringify(failKinds));
  }
  const total = fs.readdirSync(ASSET_DIR).filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f)).length;
  console.log('  本地图片总数: ' + total);
})().catch((e) => { console.error('失败: ' + (e.stack || e)); process.exit(1); });
