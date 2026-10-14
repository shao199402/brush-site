// 从「用户级」环境变量读取翻译凭证后再执行目标脚本。
// 原因：DSH 每次 pwsh 都是新进程，不会自动继承用户级变量的当前值，
// 直接跑 takeda-translate.js 会拿到空 key（此前就因此误判过一次）。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function userEnv(name) {
  try {
    const out = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`],
      { encoding: 'utf8' }
    );
    return (out.stdout || '').trim();
  } catch {
    return '';
  }
}

const key = userEnv('TRANSLATE_API_KEY');
const base = userEnv('TRANSLATE_BASE_URL') || 'https://api.deepseek.com/v1';
const model = userEnv('TRANSLATE_MODEL') || 'deepseek-chat';

if (!key) {
  console.error('用户级 TRANSLATE_API_KEY 为空，未执行。');
  process.exit(1);
}

const target = process.argv[2];
const args = process.argv.slice(3);
if (!target) {
  console.error('用法: node <本脚本> <要执行的脚本名> [参数...]');
  process.exit(1);
}

console.log('[env] key=' + key.slice(0, 6) + '...(' + key.length + ' 字符)  base=' + base + '  model=' + model);
console.log('[run] node scripts/' + target + ' ' + args.join(' ') + '\n');

const r = spawnSync(process.execPath, [path.join(__dirname, target), ...args], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, TRANSLATE_API_KEY: key, TRANSLATE_BASE_URL: base, TRANSLATE_MODEL: model },
});
process.exit(r.status === null ? 1 : r.status);
