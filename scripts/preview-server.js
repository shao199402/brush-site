#!/usr/bin/env node
'use strict';
/**
 * 本地预览服务器（开发用）
 *
 * 为什么不用 python -m http.server：
 *   它不发任何缓存头，浏览器会把 style.css / *.js 缓存住，
 *   导致改了样式刷新页面却看不到变化（实测踩过：
 *   服务器返回的 CSS 已是新版 min-height:236px，而浏览器仍在用旧缓存）。
 *   这里显式发 Cache-Control: no-store，刷新即生效。
 *
 * 用法：node scripts/preview-server.js [端口] [绑定地址]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8080);
const HOST = process.argv[3] || '0.0.0.0';
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  // 目录穿越防护：解析后必须仍在 ROOT 之内
  const abs = path.resolve(ROOT, '.' + urlPath);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      // 关键：禁用缓存，改完刷新就能看到
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('预览服务已启动：http://127.0.0.1:' + PORT + '/   （已禁用缓存，刷新即生效）');
  console.log('根目录：' + ROOT);
});

server.on('error', (e) => {
  console.error('启动失败：' + e.message);
  process.exit(1);
});
