'use strict';
/**
 * 统一提升 7 个页面的静态资源版本号（用于刷新浏览器缓存）
 *
 * 用法：node scripts/bump-assets.js 20261024
 *       node scripts/bump-assets.js            （不传则自增末尾数字）
 *
 * ⚠ 历史教训：曾在 PowerShell 里用 `node -e "...replace(/(x)\?v=\d+/, '$1?v='+V)"`
 * 做替换，PowerShell 把 $1 当变量展开成空，文件名被整个吃掉
 * （src="./=20261022"），7 个页面全部加载失败。所以替换逻辑必须放在文件里。
 */
const fs = require('fs');
const FILES = ['hakuho.html', 'koyudo.html', 'takeda.html', 'n8.html', 'eihodo.html', 'chikuhodo.html', 'beautylish.html'];

const arg = process.argv[2];
let VER = arg;
if (!VER) {
  // 从现有版本号自增
  const h = fs.readFileSync(FILES[0], 'utf8');
  const m = h.match(/catalog\.js\?v=(\d+)/);
  VER = m ? String(Number(m[1]) + 1) : String(Date.now()).slice(0, 8);
}

for (const f of FILES) {
  let t = fs.readFileSync(f, 'utf8');
  t = t.replace(/(style\.css\?v=)\d+/, '$1' + VER)
       .replace(/(catalog\.js\?v=)\d+/, '$1' + VER)
       .replace(/(-data\.js\?v=)\d+/, '$1' + VER);
  fs.writeFileSync(f, t, 'utf8');
  const refs = [...t.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((x) => x[1]).filter((r) => /\.(css|js)$|\?v=/.test(r));
  console.log('  ' + f.padEnd(18) + JSON.stringify(refs));
}
console.log('版本 → ' + VER);
