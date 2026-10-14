#!/usr/bin/env node
'use strict';
/**
 * 竹田翻译 —— 无需 API key 的替代路径封装。
 *
 * 场景：本机没有可用的翻译接口凭证时，用「导出分片 → 外部翻译 → 回灌 → 离线拼装」这条
 * 完全不需要 key 的链路。本脚本把四步串起来，并在每一步前后打印状态。
 *
 * 用法：
 *   node scripts/takeda-no-key.js --export          导出待翻译分片（默认每片 200 段）
 *   node scripts/takeda-no-key.js --status          只报告还差多少段
 *   node scripts/takeda-no-key.js --import          把 data/takeda-translate/out/ 里的译文回灌
 *   node scripts/takeda-no-key.js --assemble        只读缓存+覆盖拼装出 takeda-data.js
 *   node scripts/takeda-no-key.js --all             导出 → （等你翻好）→ 回灌 → 拼装
 *
 * 分片格式（data/takeda-translate/jobs/job-001.json）：
 *   { "id": "job-001", "count": 200, "segments": [ { "k": 1, "ja": "日文原句" }, ... ] }
 * 译文格式（data/takeda-translate/out/job-001.json），两种都接受：
 *   { "1": "中文译文", "2": "中文译文", ... }
 *   [ "中文译文", "中文译文", ... ]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const JA_FILE = path.join(ROOT, 'data', 'takeda-ja.json');
const CACHE_FILE = path.join(ROOT, 'data', 'takeda-zh-cache.json');
const JOBS_DIR = path.join(ROOT, 'data', 'takeda-translate', 'jobs');
const OUT_DIR = path.join(ROOT, 'data', 'takeda-translate', 'out');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n, d) => {
  const hit = argv.find((a) => a === n || a.startsWith(n + '='));
  if (!hit) return d;
  const eq = hit.indexOf('=');
  return eq === -1 ? d : hit.slice(eq + 1);
};

const PER_JOB = Math.max(1, Number(val('--per-job', 200)));
const MODE = has('--export') ? 'export'
  : has('--import') ? 'import'
  : has('--assemble') ? 'assemble'
  : has('--all') ? 'all'
  : 'status';

function run(script, args) {
  console.log('\n$ node scripts/' + script + ' ' + args.join(' '));
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('命令失败（退出码 ' + r.status + '）');
    process.exit(r.status || 1);
  }
}

/** 统计还差多少段没译文（只读，不改任何文件） */
function status() {
  if (!fs.existsSync(JA_FILE)) {
    console.error('找不到 ' + path.relative(ROOT, JA_FILE) + '，请先运行 takeda-scrape.js');
    process.exit(1);
  }
  const store = JSON.parse(fs.readFileSync(JA_FILE, 'utf8'));
  const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  const overridesFile = path.join(ROOT, 'data', 'takeda-zh-overrides.json');
  const overrides = fs.existsSync(overridesFile) ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {};

  // 与 takeda-translate.js 相同的切分规则：HTML 切成 标签段/文本段，只统计文本段。
  //
  // 分类要特殊处理：translate 脚本对已由 TYPE_MAP 映射的分类**不会**送去翻译。
  // 判据是现成的产物 takeda-data.js —— 如果里面所有 type 都已是中文（不含假名），
  // 就说明这 27 个分类全部被 TYPE_MAP 覆盖，统计时应把它们排除；
  // 否则统计数会比真实待翻译量多出「分类数」那么多段（1344 vs 1317 就是这个差）。
  const catalogFile = path.join(ROOT, 'takeda-data.js');
  const KANA = /[\u3041-\u3096\u30a1-\u30fa\u30fc-\u30fe]/;
  let categoriesMappedByTypeMap = false;
  if (fs.existsSync(catalogFile)) {
    const m = fs.readFileSync(catalogFile, 'utf8').match(/^\s*window\.PRODUCTS\s*=\s*([\s\S]*?);\s*$/);
    if (m) {
      try {
        const arr = JSON.parse(m[1]);
        const types = arr.map((p) => String(p.type || '')).filter(Boolean);
        categoriesMappedByTypeMap = types.length > 0 && !types.some((t) => KANA.test(t));
      } catch {
        /* 产物不可解析时按「未映射」处理，统计偏多是安全方向 */
      }
    }
  }

  const coreOf = (t) => {
    const lead = (t.match(/^\s*/) || [''])[0];
    const tail = (t.match(/\s*$/) || [''])[0];
    return t.slice(lead.length, t.length - tail.length);
  };
  const unique = new Set();
  for (const p of store.products || []) {
    for (const key of ['detailJaHtml', 'descJaHtml']) {
      const html = p[key];
      if (!html) continue;
      html.split(/(<[^>]+>)/).forEach((part, i) => {
        if (i % 2 !== 0) return;
        const c = coreOf(part);
        if (c) unique.add(c);
      });
    }
    const t = String(p.titleJa || '').trim();
    if (t) unique.add(t);
    const cat = String(p.categoryJa || '').trim();
    if (cat && !categoriesMappedByTypeMap) unique.add(cat);
  }

  const have = [...unique].filter((k) => Object.prototype.hasOwnProperty.call(overrides, k) || cache[k]).length;
  const jobs = fs.existsSync(JOBS_DIR) ? fs.readdirSync(JOBS_DIR).filter((n) => /^job-\d+\.json$/.test(n)).length : 0;
  const outs = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter((n) => /^job-\d+\.json$/.test(n)).length : 0;

  console.log('商品数            : ' + (store.products || []).length);
  console.log('唯一待翻译文本段  : ' + unique.size);
  console.log('已有译文（缓存+覆盖）: ' + have);
  console.log('仍缺译文          : ' + (unique.size - have));
  console.log('已导出分片        : ' + jobs + ' 个  (' + path.relative(ROOT, JOBS_DIR) + ')');
  console.log('已提供译文文件    : ' + outs + ' 个  (' + path.relative(ROOT, OUT_DIR) + ')');
  if (unique.size - have > 0 && jobs === 0) {
    console.log('\n下一步：node scripts/takeda-no-key.js --export');
  } else if (unique.size - have > 0 && outs < jobs) {
    console.log('\n下一步：翻译 ' + path.relative(ROOT, JOBS_DIR) + ' 里的分片，把结果按同名文件写到 ' + path.relative(ROOT, OUT_DIR));
    console.log('然后：node scripts/takeda-no-key.js --import');
  } else if (unique.size - have === 0) {
    console.log('\n全部段落已有译文，下一步：node scripts/takeda-no-key.js --assemble');
  }
}

console.log('竹田翻译 · 无 key 路径（模式：' + MODE + '）');
if (MODE === 'status' || MODE === 'all') status();

if (MODE === 'export' || MODE === 'all') {
  run('takeda-translate.js', ['--export-jobs=' + PER_JOB]);
  console.log('\n请把 ' + path.relative(ROOT, JOBS_DIR) + ' 中的每个 job-XXX.json 翻译后，');
  console.log('按相同文件名写到 ' + path.relative(ROOT, OUT_DIR) + '（值可以是 {"1":"..."} 或数组）。');
}

if (MODE === 'import' || MODE === 'all') {
  run('hakuho-import-jobs.js', ['--brand=takeda']);
}

if (MODE === 'assemble' || MODE === 'all') {
  run('takeda-translate.js', ['--offline']);
  console.log('\n完成：takeda-data.js 已按缓存+覆盖拼装。');
}
