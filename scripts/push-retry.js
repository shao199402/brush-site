#!/usr/bin/env node
'use strict';
/**
 * 推送重试助手（应对 github.com:443 时通时断）
 *
 * 实测本机出口到 github.com:443 极不稳定（连续 6 次探测里 4 次超时，
 * 每次卡 21 秒），而 22 端口稳定但账号未注册 SSH 公钥、注册公钥也要走 443。
 *
 * 现象与对策：
 *   - 每次失败几乎都是 "Failed to connect ... Timed out"（连不上，不是权限问题）；
 *   - 偶发 "Authentication failed" 其实是连接中断的次生报错（token 用 curl 验证过 200）；
 *   - git 在一次 push 内会保留已上传的对象，所以**反复重试可续传**。
 *
 * 用法：node scripts/push-retry.js [ref] [最大尝试次数]
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REF = process.argv[2] || 'main';
const MAX = Number(process.argv[3] || 40);

function git(args, extraEnv = {}) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...extraEnv },
  });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tok = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
if (!tok) { console.error('未能从 gh 取到 token，请先 gh auth login。'); process.exit(1); }
const URL_AUTH = 'https://x-access-token:' + tok + '@github.com/shao199402/brush-site.git';

(async () => {
  let connected = 0, failed = 0;

  for (let i = 1; i <= MAX; i++) {
    const t0 = Date.now();
    // 先探测连接（只读，很快）；成功才真正推送
    const probe = git(['-c', 'credential.helper=', 'ls-remote', '--heads', URL_AUTH]);

    if (probe.code !== 0) {
      failed++;
      const msg = probe.out.split('\n').filter(Boolean).slice(-1)[0] || '(无输出)';
      const short = /Timed out|Failed to connect/.test(msg) ? '连不上（443 不通）'
        : /Authentication failed/.test(msg) ? '认证被拒'
          : msg.slice(0, 70);
      console.log('[' + new Date().toISOString().slice(11, 19) + '] 第 ' + i + '/' + MAX
        + ' 次  探测失败: ' + short + '  (' + Math.round((Date.now() - t0) / 1000) + 's)');
      await sleep(3000);
      continue;
    }

    connected++;
    const remoteHead = probe.out.split('\n').filter(Boolean)[0] || '';
    console.log('[' + new Date().toISOString().slice(11, 19) + '] 第 ' + i + '/' + MAX
      + ' 次  连接成功，远端 main = ' + remoteHead.slice(0, 8) + '，开始推送…');

    const push = git(['-c', 'credential.helper=', '-c', 'http.postBuffer=524288000',
      '-c', 'http.version=HTTP/1.1', 'push', URL_AUTH, REF + ':refs/heads/' + REF]);
    const tail = push.out.split('\n').filter(Boolean).slice(-4).join(' | ');

    if (push.code === 0) {
      console.log('\n✅ 推送成功：' + tail);
      const local = git(['log', '--oneline', '-1']).out;
      console.log('   本地 HEAD: ' + local);
      process.exit(0);
    }
    console.log('           推送中断: ' + tail.slice(0, 120));
    await sleep(2000);
  }

  console.error('\n❌ ' + MAX + ' 次尝试后仍未成功（连接成功 ' + connected + ' 次，失败 ' + failed + ' 次）');
  console.error('   已上传的对象会保留，稍后重跑本脚本可续传。');
  process.exit(1);
})();
