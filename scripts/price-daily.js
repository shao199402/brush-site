#!/usr/bin/env node
'use strict';
/**
 * 每日价格巡检 —— 取各模块线上最新价格并与本地数据对比
 *
 * 用法：
 *   node scripts/price-daily.js                跑全部 7 个模块
 *   node scripts/price-daily.js --only=hakuho  只跑指定模块（逗号分隔）
 *   node scripts/price-daily.js --skip=beautylish
 *   node scripts/price-daily.js --dry-run      只跑不写报告
 *
 * 调度：由 Windows 计划任务 PriceDailyCheck 每晚 00:00 触发
 *       （见 scripts/price-daily.cmd）
 *
 * 设计要点：
 *   · **只读**：不修改任何 *-data.js、不下载图片、不推送。
 *   · 日本五个品牌走纯 HTTP（无需浏览器），并发受控，避免给人家站压力。
 *   · 白凤堂是 Shopify，一次 /products.json 拿全量（5 个请求 / 1070 件）。
 *   · Beautylish 需要浏览器渲染列表页（85 页），耗时约 12 分钟。
 *   · 任一模块失败都不影响其它模块，失败信息写进报告的「注意」段落。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'data', '_price-daily.log');

/**
 * 同时输出到控制台与日志文件。
 *
 * 为什么不靠 .cmd 里的 `>>` 重定向：命令行重定向可能写出 UTF-16LE，
 * 与 Node 的 UTF-8 输出混在一个文件里会变乱码（本工程在抓取日志上踩过）。
 * 由脚本自己按 UTF-8 追加最稳妥，也能保证时间戳一致。
 */
const _logStream = (() => {
  try {
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    return fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
  } catch { return null; }
})();
function logLine(s) {
  const line = String(s);
  console.log(line);
  if (_logStream) { try { _logStream.write(line + '\n'); } catch { /* ignore */ } }
}
const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const DRY = argv.includes('--dry-run');
const ONLY = argVal('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const SKIP = argVal('skip', '').split(',').map((s) => s.trim()).filter(Boolean);

const {
  BRANDS, fetchText, fetchHakuho,
} = require('./price-adapters.js');
const {
  compareBrand, persist, renderReport,
} = require('./price-compare.js');

/** 单站并发：同时只发 N 个请求，避免把人家服务器打崩 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 抓一个「按详情页取价」的品牌 */
async function fetchDetailBrand(key, b, opts = {}) {
  const local = require('./price-compare.js').loadLocalProducts(b.file) || [];
  /**
   * 并发与超时按站点调：永丰堂响应普遍较慢（实测单页 0.5~16 秒），
   * 并发给 6、超时给 30 秒、重试 2 次；其余站响应快，并发 5 足够。
   * 全量耗时实测：晃佑堂 26s / 竹田 40s / 熊永堂 36s / 竹宝堂 63s / 永丰堂 约 360s。
   */
  const concurrency = opts.concurrency || (key === 'eihodo' ? 6 : 5);
  const tries = opts.tries || (key === 'eihodo' ? 2 : 3);
  const timeout = opts.timeout || (key === 'eihodo' ? 30000 : 25000);
  const delayMs = opts.delayMs == null ? 80 : opts.delayMs;
  const online = new Map();
  const soldOut = [];
  const trulyFailed = [];
  let done = 0;

  await mapLimit(local, concurrency, async (x) => {
    const handle = String(x.handle || '');
    if (!handle) return;
    try {
      const html = await fetchText(b.urlOf(handle), { tries, timeout });
      /**
       * 优先用详细版解析：某些品牌的「无价格」其实是**售罄**
       * （永丰堂实测有售罄商品没有价格行）。混在失败里会污染报告，
       * 所以单独归到 soldOut 列表。
       */
      if (b.parseDetail) {
        const r = b.parseDetail(html);
        if (r.yen) {
          online.set(handle, { raw: r.yen.toLocaleString('en-US') + ' 日元（含税）', yen: r.yen, currency: 'JPY' });
        } else if (r.soldOut) {
          soldOut.push(handle);
        } else {
          trulyFailed.push({ handle, reason: '解析不到价格' });
        }
      } else {
        const n = b.parse(html);
        if (n) {
          online.set(handle, { raw: n.toLocaleString('en-US') + ' 日元（含税）', yen: n, currency: 'JPY' });
        } else {
          trulyFailed.push({ handle, reason: '解析不到价格' });
        }
      }
    } catch (e) {
      trulyFailed.push({ handle, reason: e.message.slice(0, 60) });
    }
    done++;
    if (opts.onProgress && done % 50 === 0) {
      opts.onProgress(done, local.length, trulyFailed.length, soldOut.length);
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  });

  return { online, soldOut, trulyFailed };
}

(async () => {
  const t0 = Date.now();

  /**
   * 单实例锁：防止计划任务与手动运行**同时跑**。
   *
   * 踩过的坑：零点计划任务与我手动测试撞在一起，
   *   ① 两个进程同时写同一个日志文件 → 日志行交错、无法阅读；
   *   ② 都写同一份报告/快照 → 后完成的覆盖先完成的，
   *      实测导致 Beautylish 只拿到 1760/3095 件的残缺结果覆盖了完整结果。
   * 用锁文件互斥；发现已有实例在跑就立即退出，不干扰对方。
   */
  const LOCK = path.join(ROOT, 'data', '_price-daily.lock');
  try {
    if (fs.existsSync(LOCK)) {
      const info = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      // 2 小时内的锁视为有效（本任务最长约 30 分钟，留足余量）
      const ageMin = (Date.now() - new Date(info.startedAt).getTime()) / 60000;
      if (ageMin < 120) {
        console.log('已有价格巡检在运行（pid ' + info.pid + '，开始于 ' + info.startedAt
          + '，' + ageMin.toFixed(0) + ' 分钟前），本次退出。');
        return;
      }
      console.log('发现过期锁（' + ageMin.toFixed(0) + ' 分钟前），继续运行。');
    }
    fs.writeFileSync(LOCK, JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch { /* 锁失败不阻塞主流程 */ }

  const releaseLock = () => {
    try {
      const info = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      if (info.pid === process.pid) fs.rmSync(LOCK, { force: true });
    } catch { /* ignore */ }
  };
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

  const meta = {
    generatedAt: new Date().toISOString(),
    warnings: [],
    brands: [],
  };

  let keys = Object.keys(BRANDS);
  if (ONLY.length) keys = keys.filter((k) => ONLY.includes(k));
  if (SKIP.length) keys = keys.filter((k) => !SKIP.includes(k));

  logLine('=== 每日价格巡检 ===');
  logLine('  时间: ' + meta.generatedAt.replace('T', ' ').slice(0, 19) + ' UTC');
  logLine('  模块: ' + keys.map((k) => BRANDS[k].label).join(' / '));
  if (DRY) logLine('  （dry-run：不写报告）');
  logLine('');

  const results = [];

  for (const key of keys) {
    const b = BRANDS[key];
    const bt = Date.now();
    logLine('── ' + b.label + '（' + b.file + '）');

    try {
      if (b.mode === 'shopify') {
        const online = await fetchHakuho();
        logLine('   Shopify 全量: ' + online.size + ' 件  (' + ((Date.now() - bt) / 1000).toFixed(1) + 's)');
        results.push(compareBrand(key, online, { fetchFailed: 0 }));
      } else if (b.mode === 'detail') {
        const { online, soldOut, trulyFailed } = await fetchDetailBrand(key, b, {
          onProgress: (done, total, fail, sold) => {
            logLine('   进度 ' + done + '/' + total + '（失败 ' + fail + '，售罄 ' + sold + '）');
          },
        });
        logLine('   详情页取价: ' + online.size + ' 件成功，售罄 ' + soldOut.length
          + '，失败 ' + trulyFailed.length + '  (' + ((Date.now() - bt) / 1000).toFixed(1) + 's)');
        if (trulyFailed.length) {
          logLine('   失败样例: ' + trulyFailed.slice(0, 3).map((f) => f.handle + '(' + f.reason + ')').join('  '));
        }
        const cr = compareBrand(key, online, { fetchFailed: trulyFailed.length });
        cr.soldOutCount = soldOut.length;
        if (soldOut.length) meta.warnings.push(b.label + '：' + soldOut.length + ' 件商品当前售罄（无价格）');
        if (trulyFailed.length) {
          meta.warnings.push(b.label + '：' + trulyFailed.length + ' 件取价失败'
            + '（多为站点响应超时；这类商品本次未参与价格对比，不代表价格没变）');
        }
        results.push(cr);
      } else if (b.mode === 'beautylish-list') {
        const { fetchBeautylishPrices } = require('./price-beautylish.js');
        const { prices, listTotal, batches } = await fetchBeautylishPrices({
          /**
           * 参数依据（实测数据）：
           *   · 站点**按会话限速**：一个浏览器会话连续翻约 25 页后开始返回
           *     空卡片。所以不能一次性翻满 85 页。
           *   · 因此分批翻页（每批 20 页），一出现空页就丢弃浏览器、换新会话
           *     （新 WAF token）从当前页继续。
           *   · 实测效果：90 页 / 6 批 / **16 分钟**拿到 3095/3095 件，100% 覆盖。
           *   · 详情页补价默认关闭：列表页已能全覆盖，而详情页受限更早
           *     （约 10 件后被拦），只在确有缺口时才按需开启。
           */
          pages: 90,
          navDelay: 3500,
          batchPages: 20,
          maxBatches: 6,
          detailLimit: 0,
          onPage: (p, added, total) => {
            if (added > 0 && p % 10 === 0) {
              logLine('   列表第 ' + p + ' 页，累计 ' + total + ' 件价格');
            }
          },
        });
        logLine('   取价合计: ' + prices.size + ' 件（清单 ' + listTotal + '）'
          + '，' + batches + ' 批，' + ((Date.now() - bt) / 60000).toFixed(1) + ' 分钟');
        if (prices.size < listTotal * 0.9) {
          meta.warnings.push(b.label + '：只取到 ' + prices.size + ' / ' + listTotal
            + ' 件价格，可能是限速或列表页结构变化，价格对比结果仅供参考。');
        }
        results.push(compareBrand(key, prices, { fetchFailed: 0 }));
      }
    } catch (e) {
      logLine('   ✗ 失败: ' + e.message);
      meta.warnings.push(b.label + ' 取价失败：' + e.message);
      results.push({
        key, label: b.label, currency: b.currency,
        error: e.message, localCount: 0, onlineCount: 0, matchedCount: 0,
        fetchFailed: 0, changes: [], added: [],
      });
    }
    logLine('');
  }

  meta.brands = results;
  const totalChanged = results.reduce((a, r) => a + (r.changes ? r.changes.length : 0), 0);
  const totalAdded = results.reduce((a, r) => a + (r.added ? r.added.length : 0), 0);

  logLine('=== 汇总 ===');
  for (const r of results) {
    if (r.error) { logLine('  ' + r.label.padEnd(12) + ' ✗ ' + r.error); continue; }
    logLine('  ' + r.label.padEnd(12)
      + ' 本地 ' + String(r.localCount).padStart(4)
      + '  线上 ' + String(r.onlineCount).padStart(4)
      + '  变动 ' + String(r.changes.length).padStart(3)
      + '  新增 ' + String(r.added.length).padStart(3)
      + '  取价失败 ' + String(r.fetchFailed).padStart(3));
  }
  logLine('');
  logLine('  合计：' + totalChanged + ' 项价格变动，' + totalAdded + ' 件新增商品');
  logLine('  总用时：' + ((Date.now() - t0) / 1000).toFixed(0) + ' 秒');

  if (!DRY) {
    const { snapFile, mdFile } = persist(meta, meta);
    logLine('');
    logLine('  快照：' + path.relative(ROOT, snapFile));
    logLine('  报告：' + path.relative(ROOT, mdFile));
  }

  // 有变动时把摘要打印出来，方便直接看日志
  if (totalChanged || totalAdded) {
    logLine('');
    logLine('=== 变动摘要 ===');
    for (const r of results) {
      if (!r.changes || !r.changes.length) continue;
      logLine('  【' + r.label + '】');
      for (const c of r.changes.slice(0, 10)) {
        const sign = c.delta > 0 ? '+' : '';
        logLine('    ' + String(c.title).slice(0, 34).padEnd(36)
          + c.oldRaw + ' → ' + c.newRaw + '  (' + sign + c.delta + ')');
      }
      if (r.changes.length > 10) logLine('    …另有 ' + (r.changes.length - 10) + ' 项');
    }
  }
})().catch((e) => {
  console.error('\n✗ 巡检失败: ' + e.message);
  process.exit(1);
});
