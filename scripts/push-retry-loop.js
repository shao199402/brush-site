'use strict';
/**
 * 持续重试推送某个提交（应对 github.com:443 高断线率）
 * 用法：node scripts/push-retry-loop.js <ref> <分钟上限>
 */
const { spawnSync } = require('child_process');

const REF = process.argv[2] || 'main';
const MAX_MIN = Number(process.argv[3] || 40);
const ROOT = 'H:/site-publish';
const deadline = Date.now() + MAX_MIN * 60000;

const tok = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
const url = 'https://x-access-token:' + tok + '@github.com/shao199402/brush-site.git';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

(async () => {
  let ok = 0, connect = 0, attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const probe = git(['-c', 'credential.helper=', 'ls-remote', '--heads', url]);
    if (probe.code !== 0) { await sleep(2500); continue; }
    connect++;
    const head = probe.out.split('\n').filter(Boolean)[0] || '';
    const push = git(['-c', 'credential.helper=', '-c', 'http.postBuffer=524288000',
      'push', url, REF + ':refs/heads/' + REF]);
    if (push.code === 0) {
      console.log('[' + new Date().toISOString().slice(11, 19) + '] ✅ 推送成功（第 ' + attempts + ' 次尝试，第 ' + connect + ' 次连上）');
      console.log('   远端 main = ' + head.slice(0, 8) + ' → 本地 ' + git(['log', '--oneline', '-1']).out);
      process.exit(0);
    }
    ok++;
    await sleep(1500);
  }
  console.log('[' + new Date().toISOString().slice(11, 19) + '] 到时间上限仍未成功：尝试 ' + attempts + ' 次，连上 ' + connect + ' 次');
  process.exit(2);
})();
