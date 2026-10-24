#!/usr/bin/env node
'use strict';
/**
 * 价格巡检「环境预检」—— 在把脚本搬到另一台 Windows 服务器之前/之后跑一次
 *
 * 为什么需要：本任务能在本机跑，不代表换台机器也能跑。实测坑：
 *   · Beautylish 的**币种由访问来源 IP 决定**（本机出口在中国 → CN¥）。
 *     若服务器在海外，价格会变成 USD，与本地 CNY 数据对比会全线错位
 *     （报告里那种 "USD24 → CN¥215" 的怪结果就是这么来的）。
 *   · Chrome 路径写死在 lib-cdp.js 里，服务器没装 Chrome 时抓不了 Beautylish。
 *   · SYSTEM 账户的 PATH 里通常没有 node。
 *
 * 用法：node scripts/price-preflight.js
 *       node scripts/price-preflight.js --skip-network   只查本地环境
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_NET = process.argv.includes('--skip-network');

let pass = 0, warn = 0, fail = 0;
const ok = (m) => { console.log('  ✅ ' + m); pass++; };
const wr = (m) => { console.log('  ⚠  ' + m); warn++; };
const ng = (m) => { console.log('  ❌ ' + m); fail++; };

(async () => {
  console.log('=== 价格巡检环境预检 ===');
  console.log('  目录: ' + ROOT);
  console.log('');

  // ① Node 版本
  console.log('【运行时】');
  const nodeVer = process.versions.node;
  const major = Number(nodeVer.split('.')[0]);
  if (major >= 18) ok('Node ' + nodeVer + '（>=18，有内置 fetch）');
  else ng('Node ' + nodeVer + ' 太旧，需要 >=18（内置 fetch）');
  console.log('     node 路径: ' + process.execPath);

  // ② 必要文件
  console.log('\n【文件】');
  const need = [
    'beautylish-data.js', 'beautylish-list.json',
    'catalog-data.js', 'koyudo-data.js', 'takeda-data.js',
    'n8-data.js', 'eihodo-data.js', 'chikuhodo-data.js',
    'scripts/price-daily.js', 'scripts/price-adapters.js',
    'scripts/price-compare.js', 'scripts/price-beautylish.js',
    'scripts/lib-cdp.js',
  ];
  let missFile = 0;
  for (const f of need) {
    const p = f.startsWith('scripts/') ? path.join(ROOT, f) : path.join(ROOT, 'data', f.startsWith('beautylish-list') ? f : f);
    const real = f === 'beautylish-list.json' ? path.join(ROOT, 'data', f) : (f.startsWith('scripts/') ? path.join(ROOT, f) : path.join(ROOT, f));
    if (!fs.existsSync(real)) { ng('缺少 ' + path.relative(ROOT, real)); missFile++; }
  }
  if (!missFile) ok(need.length + ' 个必要文件齐全');

  // ③ 写权限
  console.log('\n【写权限】');
  for (const d of ['data', 'data/price-reports', 'data/price-snapshots']) {
    const p = path.join(ROOT, d);
    try {
      fs.mkdirSync(p, { recursive: true });
      const probe = path.join(p, '.write-probe');
      fs.writeFileSync(probe, 'x');
      fs.rmSync(probe, { force: true });
      ok(d + ' 可写');
    } catch (e) {
      ng(d + ' 不可写: ' + e.message.slice(0, 60));
    }
  }

  // ④ Chrome（Beautylish 必须）
  console.log('\n【Chrome（抓 Beautylish 必需）】');
  const chromeCandidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  /** 默认探测路径（不含用户覆盖），用来判断是否需要设 CHROME_PATH */
  const CHROME_DEFAULTS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  let chromeFound = null;
  for (const c of chromeCandidates) {
    if (fs.existsSync(c)) { chromeFound = c; break; }
  }
  if (chromeFound) {
    ok('Chrome: ' + chromeFound);
    // lib-cdp.js 的默认值只认 Program Files 下的 chrome.exe；
    // 若命中别的（Edge / x86 / 自定义），必须用环境变量告诉它
    if (!CHROME_DEFAULTS.slice(0, 1).includes(chromeFound)) {
      wr('不是 lib-cdp.js 的默认路径，需设置环境变量 CHROME_PATH=' + chromeFound);
    }
  } else {
    ng('找不到 Chrome/Edge。Beautylish 的取价需要浏览器渲染，没有它这一块会失败。');
  }

  // ⑤ 时区与日期
  console.log('\n【时间】');
  const now = new Date();
  console.log('    当前本地时间: ' + now.toString());
  console.log('    UTC       : ' + now.toISOString());
  const offsetH = -now.getTimezoneOffset() / 60;
  console.log('    时区偏移  : UTC' + (offsetH >= 0 ? '+' : '') + offsetH);
  ok('报告按本地日期命名（' + now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    + '-' + String(now.getDate()).padStart(2, '0') + '.md）');

  if (SKIP_NET) {
    console.log('\n（已跳过网络检查）');
  } else {
    // ⑥ 各站可达性
    console.log('\n【站点可达性】');
    const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };
    const sites = [
      ['白凤堂', 'https://hakuho-do.co.jp/products.json?limit=1'],
      ['晃佑堂', 'https://www.koyudo.co.jp/view/category/all_items'],
      ['竹田', 'https://takeda-brush-shop.com/item-detail/1669764'],
      ['熊永堂', 'https://www.number-8.net/products/detail.php?product_id=10'],
      ['永丰堂', 'https://www.eihodo.jp/sp/shopping/?id=1295951096-149236'],
      ['竹宝堂', 'https://www.chikuhodo.com/product/an_01.html'],
      ['Beautylish', 'https://www.beautylish.com/shop/browse?page=1'],
    ];
    for (const [name, url] of sites) {
      try {
        const t0 = Date.now();
        const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
        const ms = Date.now() - t0;
        if (r.ok) ok(name + ' HTTP ' + r.status + '  ' + ms + 'ms');
        else if (r.status === 202) wr(name + ' HTTP 202（Beautylish 的 WAF 对纯 HTTP 的典型响应，需浏览器）');
        else wr(name + ' HTTP ' + r.status);
      } catch (e) {
        ng(name + ' 不可达: ' + e.message.slice(0, 50));
      }
    }

    // ⑦ 币种 —— 最容易踩的坑
    console.log('\n【Beautylish 币种（关键）】');
    console.log('    说明：Beautylish 按**访问来源 IP**决定地区与币种，无法用 cookie/参数改。');
    console.log('    本地数据是人民币（CN¥）。若这台机器的出口 IP 在海外，');
    console.log('    抓回来的会是 USD，所有对比都会错位。');
    try {
      const { withChrome, sleep } = require('./lib-cdp.js');
      await withChrome(async (page) => {
        await page.cdp.send('Network.setBlockedURLs', {
          urls: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.mp4', '*.webm'],
        });
        await page.goto('https://www.beautylish.com/shop/browse?page=1', { wait: 4000 });
        await sleep(1500);
        const txt = await page.eval('document.body.innerText.slice(0, 6000)');
        const cny = (String(txt).match(/CN¥\s*[\d,]+/g) || []).length;
        const usd = (String(txt).match(/\$\s*[\d,]+(?:\.\d+)?/g) || []).length;
        if (cny > 0 && cny >= usd) {
          ok('价格显示为人民币（CN¥ 出现 ' + cny + ' 次，USD ' + usd + ' 次）→ 与本地数据币种一致');
        } else if (usd > 0) {
          ng('价格显示为美元（$ 出现 ' + usd + ' 次，CN¥ ' + cny + ' 次）→ 与本地 CNY 数据不一致，比对会错位！');
          console.log('       解决：让这台机器的出口 IP 回到中国区，或修改 price-compare 的币种换算逻辑。');
        } else {
          wr('页面里没识别到价格（可能被 WAF 挡或渲染慢），cny=' + cny + ' usd=' + usd);
        }
      }, { port: 9960 });
    } catch (e) {
      ng('币种检测失败: ' + e.message.slice(0, 70));
    }
  }

  // ⑧ 计划任务
  console.log('\n【计划任务】');
  try {
    const r = spawnSync('schtasks', ['/Query', '/TN', 'PriceDailyCheck', '/FO', 'LIST', '/V'],
      { encoding: 'utf8', timeout: 20000 });
    const txt = r.stdout || '';
    if (/PriceDailyCheck/.test(txt)) {
      const pick = (k) => { const m = txt.match(new RegExp(k + ':\\s*(.+)')); return m ? m[1].trim() : '?'; };
      ok('已注册：下次 ' + pick('Next Run Time') + '，上次结果 ' + pick('Last Result')
        + '，账户 ' + pick('Run As User'));
      if (/Interactive only/i.test(txt)) {
        wr('登录模式为 Interactive only → 必须用户登录才跑。建议改用 /RU SYSTEM 注册。');
      }
    } else {
      wr('未找到计划任务 PriceDailyCheck（这台机器还没注册，或用了别的名字）');
    }
  } catch { wr('查不到计划任务（schtasks 不可用？）'); }

  // 汇总
  console.log('\n=== 结果 ===');
  console.log('  通过 ' + pass + '   警告 ' + warn + '   失败 ' + fail);
  if (fail === 0) {
    console.log('\n  ✅ 环境就绪，可以注册计划任务：');
    console.log('     schtasks /Create /SC DAILY /ST 00:00 /TN "PriceDailyCheck" ^');
    console.log('             /TR "<本目录>\\scripts\\price-daily.cmd" /RU SYSTEM /RL HIGHEST /F');
  } else {
    console.log('\n  ❌ 有 ' + fail + ' 项失败，先解决再做计划任务。');
    process.exitCode = 1;
  }
})().catch((e) => { console.error('预检异常: ' + e.message); process.exit(1); });
