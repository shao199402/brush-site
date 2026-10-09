#!/usr/bin/env node
'use strict';
/**
 * 把外部翻译结果回灌进译文缓存。
 *
 * 用途：没有可用的翻译 API key 时，用 `hakuho-translate.js --export-jobs=N` 导出待翻译分片，
 *       由外部（人或代理）逐片翻译，再用本脚本合并回 data/hakuho-zh-cache.json，
 *       最后 `hakuho-translate.js --offline` 只读缓存完成拼装。
 *
 * 目录约定：
 *   data/translate/jobs/job-001.json   { id, count, segments: [{ k, ja }] }
 *   data/translate/out/job-001.json    { "1": "中文", "2": "中文", ... }   （也接受数组形式）
 *
 * 用法：node scripts/hakuho-import-jobs.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JOBS_DIR = path.join(DATA_DIR, 'translate', 'jobs');
const OUT_DIR = path.join(DATA_DIR, 'translate', 'out');
const CACHE_FILE = path.join(DATA_DIR, 'hakuho-zh-cache.json');
const REPORT_FILE = path.join(DATA_DIR, 'translate', 'import-report.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  if (!fs.existsSync(JOBS_DIR)) {
    console.error('找不到 ' + path.relative(ROOT, JOBS_DIR) + '，请先运行：node scripts/hakuho-translate.js --export-jobs=200');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const jobFiles = fs.readdirSync(JOBS_DIR).filter((n) => /^job-\d+\.json$/.test(n)).sort();
  if (!jobFiles.length) {
    console.error('分片目录为空，请先导出分片。');
    process.exit(1);
  }

  const cache = fs.existsSync(CACHE_FILE) ? readJson(CACHE_FILE) : {};

  const report = {
    generatedAt: new Date().toISOString(),
    jobs: jobFiles.length,
    segments: 0,
    imported: 0,
    alreadyCached: 0,
    missing: 0,
    badOutFiles: [],
    incompleteJobs: [],
  };

  for (const jobName of jobFiles) {
    const job = readJson(path.join(JOBS_DIR, jobName));
    const segments = Array.isArray(job.segments) ? job.segments : [];
    report.segments += segments.length;

    const outPath = path.join(OUT_DIR, jobName);
    if (!fs.existsSync(outPath)) {
      report.incompleteJobs.push({ job: job.id || jobName, missing: segments.length, reason: '缺少译文文件' });
      report.missing += segments.length;
      continue;
    }

    let out;
    try {
      out = readJson(outPath);
    } catch (err) {
      report.badOutFiles.push({ job: job.id || jobName, error: err.message });
      report.missing += segments.length;
      continue;
    }

    // 允许 {"1":"..."} 或 ["...","..."] 两种形式
    const lookup = (k, index) => {
      if (Array.isArray(out)) return out[index];
      if (out && typeof out === 'object') return out[String(k)];
      return undefined;
    };

    let jobMissing = 0;
    segments.forEach((seg, index) => {
      const ja = String(seg.ja == null ? '' : seg.ja);
      const zhRaw = lookup(seg.k, index);
      const zh = typeof zhRaw === 'string' ? zhRaw.trim() : '';
      if (!ja) return;
      if (!zh) {
        jobMissing += 1;
        report.missing += 1;
        return;
      }
      if (cache[ja] === zh) report.alreadyCached += 1;
      else report.imported += 1;
      cache[ja] = zh;
    });

    if (jobMissing > 0) {
      report.incompleteJobs.push({ job: job.id || jobName, missing: jobMissing, reason: '部分段落无译文' });
    }
  }

  const tmp = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CACHE_FILE);
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('回灌完成');
  console.log('  分片数：' + report.jobs);
  console.log('  分片内段落总数：' + report.segments);
  console.log('  新导入：' + report.imported);
  console.log('  与缓存相同：' + report.alreadyCached);
  console.log('  缺译文：' + report.missing);
  console.log('  译文文件解析失败：' + report.badOutFiles.length);
  console.log('  缓存总条目：' + Object.keys(cache).length);
  console.log('  报告：' + path.relative(ROOT, REPORT_FILE));

  if (report.badOutFiles.length) {
    console.error('\n解析失败的译文文件：');
    for (const item of report.badOutFiles) console.error('  - ' + item.job + '：' + item.error);
  }
  if (report.incompleteJobs.length) {
    console.log('\n不完整的片段（需要补翻）：');
    for (const item of report.incompleteJobs.slice(0, 30)) {
      console.log('  - ' + item.job + '：缺 ' + item.missing + ' 段（' + item.reason + '）');
    }
    if (report.incompleteJobs.length > 30) console.log('  ... 其余 ' + (report.incompleteJobs.length - 30) + ' 个');
  }

  if (report.missing > 0) {
    console.log('\n还有 ' + report.missing + ' 段没有译文。补齐后重新运行本脚本，再执行：');
    console.log('  node scripts/hakuho-translate.js --offline');
  } else {
    console.log('\n全部段落就绪，下一步：node scripts/hakuho-translate.js --offline');
  }
}

try {
  main();
} catch (err) {
  console.error('回灌失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
}
