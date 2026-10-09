#!/usr/bin/env node
'use strict';
/**
 * 白凤堂商品 —— 第二阶段：把 data/hakuho-ja.json 里的日文翻译成通顺简体中文，并写回 catalog-data.js。
 *
 * 核心保证：
 *   1) 「格式不要变」——本脚本先按标签把 HTML 切分成「标签段 / 文本段」，
 *      只把文本段送去翻译，再按原样拼回。HTML 标签、属性、空白、换行逐字节不变。
 *      （绝不会把整段 HTML 丢给模型改写，那样一定会破坏结构。）
 *   2) 译文通顺——固定术语表 + 面向中国大陆消费者的表达要求，不逐字硬译。
 *   3) 可断点续跑——译文按「日文原句」缓存到 data/hakuho-zh-cache.json，
 *      重复句（例如 S100 系列共用的「穂先の形状について」整段）只翻译一次。
 *
 * 翻译服务：任何 OpenAI 兼容的 /chat/completions 接口。
 *   TRANSLATE_API_KEY   必填（--dry-run 时可不填）
 *   TRANSLATE_BASE_URL  默认 https://api.openai.com/v1
 *   TRANSLATE_MODEL     默认 gpt-4o-mini
 *
 * 用法：
 *   node scripts/hakuho-translate.js --dry-run        # 不调接口，只验证拼装与写回逻辑
 *   node scripts/hakuho-translate.js --limit=5        # 只处理前 5 条
 *   node scripts/hakuho-translate.js                  # 全量
 *   node scripts/hakuho-translate.js --batch=80 --concurrency=4
 *
 * 产物：
 *   catalog-data.js            按第二阶段的字段规则重写（保持 window.PRODUCTS = [...]; 格式，
 *                              使抓取结果可被直接复用、比对与回滚）
 *   data/hakuho-zh-cache.json  日→中 译文缓存
 *   data/hakuho-report.json    校验报告（残留假名、空字段、缺图、失败清单）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JA_FILE = path.join(DATA_DIR, 'hakuho-ja.json');
const CACHE_FILE = path.join(DATA_DIR, 'hakuho-zh-cache.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'hakuho-zh-overrides.json');
const REPORT_FILE = path.join(DATA_DIR, 'hakuho-report.json');
const CATALOG_FILE = path.join(ROOT, 'catalog-data.js');

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
function argValue(name) {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const DRY_RUN = argValue('--dry-run') !== undefined;
const OFFLINE = argValue('--offline') !== undefined;
const EXPORT_JOBS = Number(argValue('--export-jobs') || 0);
const LIMIT = Number(argValue('--limit') || 0);
const BATCH = Math.max(1, Number(argValue('--batch') || 60));
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency') || 3));
const BASE_URL = String(process.env.TRANSLATE_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const API_KEY = process.env.TRANSLATE_API_KEY || process.env.OPENAI_API_KEY || '';
const MODEL = String(argValue('--model') || process.env.TRANSLATE_MODEL || 'gpt-4o-mini');

if (!DRY_RUN && !OFFLINE && !EXPORT_JOBS && !API_KEY) {
  // 这里不直接退出：译文缓存 + 人工覆盖可能已经覆盖全部段落，那样根本不需要调用接口。
  // 真正缺 key 且有段落待翻译时，才会在 main() 里报错。
  console.log('提示：未检测到 TRANSLATE_API_KEY，将只使用已有译文缓存与人工覆盖。');
}

// ---------------------------------------------------------------- 术语与提示词

const GLOSSARY = [
  ['フィニッシング', '定妆'],
  ['パウダー', '蜜粉'],
  ['チーク', '腮红'],
  ['アイシャドウ', '眼影'],
  ['アイライナー', '眼线'],
  ['ハイライト', '高光'],
  ['シェーディング', '阴影'],
  ['コンシーラー', '遮瑕'],
  ['リップ', '唇刷'],
  ['穂先', '笔尖'],
  ['毛丈', '毛长'],
  ['全長', '全长'],
  ['厚み', '厚度'],
  ['軸', '轴'],
  ['金具', '金属件'],
  ['真鍮', '黄铜'],
  ['ゴールド', '金色'],
  ['シルバー', '银色'],
  ['灰リス', '灰松鼠毛'],
  ['リス', '松鼠毛'],
  ['山羊', '山羊毛'],
  ['馬', '马毛'],
  ['イタチ', '黄鼠狼毛'],
  ['合成繊維', '合成纤维'],
  ['丸平', '圆平'],
  ['斜め', '斜角'],
  ['尖り', '尖头'],
  ['ドーム', '圆顶'],
  ['名入れ', '刻名'],
  ['化粧筆', '化妆刷'],
  ['熊野筆', '熊野笔'],
];

function buildSystemPrompt() {
  return [
    '你是资深化妆品本地化译者，负责把日本白凤堂（白鳳堂）化妆刷商品页的日文翻译成面向中国大陆消费者的简体中文。',
    '',
    '硬性要求：',
    '1. 译文必须通顺、自然、符合中文表达习惯。不要逐字硬译，不要保留日语文法，不要出现日语助词残余。',
    '2. 输入是一个 JSON 对象：键是序号，值是待翻译的日文。',
    '   你必须输出结构完全相同的 JSON 对象：键一个不多一个不少，值是对应的简体中文译文。',
    '3. 只输出这个 JSON 对象本身。不要输出解释、注释、markdown 代码块或任何多余字符。',
    '4. 保留原文中的数字、单位（如 mm）、型号编号（如 S100、J246、HD0001、HWM-WV）与颜色名。',
    '5. 若某段日文本身是专有名词或型号，可保留原文或音译，不要强行意译。',
    '6. 各条译文之间不要互相拼接，不要合并，不要拆分。',
    '',
    '固定术语（必须遵守）：',
    GLOSSARY.map(([ja, zh]) => ja + '=' + zh).join('、'),
    '',
    '示例：',
    '输入 {"1":"適度なコシと肌当たりの良さをあわせ持つ、人気のフィニッシング筆。"}',
    '输出 {"1":"兼具适度的弹性与亲肤感，是人气很高的定妆刷。"}',
  ].join('\n');
}

const SYSTEM_PROMPT = buildSystemPrompt();

/** 官方 product_type → 站内 type，仅用于「新增商品」；已有商品一律保留原 type。
 *  取值刻意对齐 catalog 里既有的分类写法（含旧数据遗留的空书名号「」），避免出现同义异写。 */
const TYPE_MAP = {
  '化粧筆': '化妆刷',
  '化粧筆セット': '化妆刷套装',
  '日本画筆': '日本画笔',
  '洋画筆　水彩': '西洋画笔 水彩',
  '洋画筆 水彩': '西洋画笔 水彩',
  'こだわり雑貨': '精选杂货',
  'しごと筆': '工作笔',
  '書筆': '书法笔',
  '雑誌「ふでばこ」': '杂志「」',
  '名入れ': '刻名',
  '筆': '化妆刷',
};

// ---------------------------------------------------------------- 基础工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 只匹配真正的假名。刻意排除 U+30FB「・」（片假名中点，属标点而非假名）与 U+30A0，
// 否则「马毛・合成纤维」这类正常中文会被误判为残留日文。
const KANA_RE = /[\u3041-\u3096\u30A1-\u30FA\u30FC-\u30FE]/;

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function decodeEntities(input) {
  return String(input)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function toPlainText(html, { keepSpanBoundary = false } = {}) {
  let s = String(html == null ? '' : html);
  if (keepSpanBoundary) s = s.replace(/<\/span\s*>/gi, '</span> ');
  s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|h[1-6]|tr|table)>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function normalizeDesc(text) {
  return String(text || '')
    .replace(/(毛质|毛材|素材)\s*[:：]\s*/g, '$1：')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 简体中文排版归一化。只作用于「译文文本节点」，绝不作用于 HTML 标签或属性，
 * 因此不会破坏 style="color: rgb(255, 0, 0)" 这类内联样式。
 *   1) 日文中点「・」/「·」/全角斜杠「／」统一成半角「/」
 *   2) 非千分位的半角逗号 → 全角「，」
 *   3) 汉字后的半角冒号 → 全角「：」
 */
function normalizeZh(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/[\u30FB\u00B7\uFF0F]/g, '/');
  s = s.replace(/(\d),(?=\d)/g, '$1\u0001');
  s = s.replace(/,/g, '，');
  s = s.replace(/\u0001/g, ',');
  s = s.replace(/([\u4E00-\u9FFF\)）]) *: */g, '$1：');
  return s;
}

/**
 * 去掉 HTML 注释。注释对用户完全不可见，而其中往往是被注释掉的废弃规格表，
 * 或未翻译的日文备注（官方正文里确实存在）。保留它们只会留下死内容和日文残留。
 */
function stripHtmlComments(html) {
  return String(html == null ? '' : html).replace(/<!--[\s\S]*?-->/g, '');
}

// ------------------------------------------------- HTML 文本节点级翻译

/** 把 HTML 切成 [文本段, 标签段, 文本段, ...]，只翻译文本段。 */
function splitSegments(html) {
  return String(html).split(/(<[^>]+>)/);
}

function coreOf(text) {
  const lead = (text.match(/^\s*/) || [''])[0];
  const tail = (text.match(/\s*$/) || [''])[0];
  return { lead, tail, core: text.slice(lead.length, text.length - tail.length) };
}

// ---------------------------------------------------------------- 翻译接口

function parseModelJson(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试截取 */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* 放弃 */
    }
  }
  return null;
}

async function callModel(payload, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' ' + body.slice(0, 300));
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 翻译一批字符串，返回 { 原文: 译文 }。失败的条目不会出现在结果里。 */
async function translateBatch(strings, stats) {
  if (!strings.length) return {};
  if (DRY_RUN) {
    const passthrough = {};
    for (const s of strings) passthrough[s] = s;
    return passthrough;
  }

  const idToSource = {};
  strings.forEach((s, i) => {
    idToSource[String(i + 1)] = s;
  });

  const payload = {
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(idToSource) },
    ],
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await callModel(payload);
      const content = response && response.choices && response.choices[0] && response.choices[0].message
        ? response.choices[0].message.content
        : '';
      const parsed = parseModelJson(content);
      if (!parsed || typeof parsed !== 'object') throw new Error('返回内容不是合法 JSON');

      const out = {};
      for (const [id, source] of Object.entries(idToSource)) {
        const value = parsed[id];
        if (typeof value === 'string' && value.trim()) out[source] = value.trim();
      }
      const missing = strings.length - Object.keys(out).length;
      if (missing > 0) {
        stats.missing += missing;
      }
      return out;
    } catch (err) {
      stats.apiErrors += 1;
      if (attempt === 3) {
        console.warn('  ! 批次翻译失败（' + strings.length + ' 段）：' + err.message);
        return {};
      }
      await sleep(1500 * attempt);
    }
  }
  return {};
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log('白凤堂翻译 · 阶段二' + (DRY_RUN ? '（dry-run，不调用接口）' : ''));
  console.log('模型：' + (DRY_RUN ? '(跳过)' : MODEL + ' @ ' + BASE_URL));

  if (!fs.existsSync(JA_FILE)) {
    throw new Error('找不到 ' + path.relative(ROOT, JA_FILE) + '，请先运行 node scripts/hakuho-scrape.js');
  }
  const jaStore = JSON.parse(fs.readFileSync(JA_FILE, 'utf8'));
  let jaProducts = Array.isArray(jaStore.products) ? jaStore.products.slice() : [];
  if (!jaProducts.length) throw new Error('中间产物里没有商品，请先运行抓取脚本');
  jaProducts.sort((a, b) => String(a.handle).localeCompare(String(b.handle)));
  if (LIMIT > 0) jaProducts = jaProducts.slice(0, LIMIT);
  console.log('待翻译商品：' + jaProducts.length + ' 条');

  // 现有 catalog：保留顺序、保留 type，只替换 title/desc/detail/detailHtml
  const existingRaw = fs.readFileSync(CATALOG_FILE, 'utf8');
  const existingMatch = existingRaw.match(/^\s*window\.PRODUCTS\s*=\s*([\s\S]*?);\s*$/);
  if (!existingMatch) throw new Error('catalog-data.js 格式无法识别');
  const existingProducts = JSON.parse(existingMatch[1]);
  const existingByHandle = new Map(existingProducts.map((p) => [p.handle, p]));
  console.log('现有 catalog：' + existingProducts.length + ' 条');

  const cache = readJsonIfExists(CACHE_FILE, {});
  // 人工覆盖层：键为日文原句，值为定稿译文。优先级高于机器译文，
  // 用来精修共用句或修正个别翻译，无需重跑翻译接口。
  const overrides = readJsonIfExists(OVERRIDES_FILE, {});
  const overrideCount = Object.keys(overrides).length;
  if (overrideCount) console.log('已载入人工覆盖译文：' + overrideCount + ' 条');
  const hasOverride = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  const lookupZh = (key) => {
    if (hasOverride(key)) return overrides[key];
    const v = cache[key];
    return typeof v === 'string' && v ? v : null;
  };
  const stats = { apiErrors: 0, missing: 0, cacheHits: 0, overrides: overrideCount, translated: 0, batches: 0 };

  // ---- 1) 收集所有待翻译的文本节点（按日文原句去重）
  const uniqueCores = new Set();
  const prepared = [];

  for (const ja of jaProducts) {
    const item = { ja, segments: null, descSegments: null, titleJa: String(ja.titleJa || '').trim() };

    if (ja.detailJaHtml) {
      item.segments = splitSegments(ja.detailJaHtml);
      item.segments.forEach((part, i) => {
        if (i % 2 !== 0) return; // 标签段
        const { core } = coreOf(part);
        if (core && !uniqueCores.has(core)) {
          uniqueCores.add(core);
        }
      });
    } else {
      console.warn('  ! [' + ja.handle + '] 中间产物缺少 detailJaHtml，将保留原有数据');
    }

    if (ja.descJaHtml) {
      item.descSegments = splitSegments(ja.descJaHtml);
      item.descSegments.forEach((part, i) => {
        if (i % 2 !== 0) return;
        const { core } = coreOf(part);
        if (core && !uniqueCores.has(core)) {
          uniqueCores.add(core);
        }
      });
    }

    if (item.titleJa) uniqueCores.add(item.titleJa);

    prepared.push(item);
  }

  console.log('唯一待翻译文本段：' + uniqueCores.size + ' 段（已去重，系列共用文案只翻一次）');

  // ---- 2) 命中缓存
  const pending = [];
  for (const core of uniqueCores) {
    if (lookupZh(core)) {
      stats.cacheHits += 1;
    } else {
      pending.push(core);
    }
  }
  console.log('缓存命中：' + stats.cacheHits + ' 段；需要翻译：' + pending.length + ' 段');

  // ---- 2b) 导出待翻译分片（供外部翻译后回灌，不调用接口）
  if (EXPORT_JOBS > 0) {
    const jobDir = path.join(DATA_DIR, 'translate', 'jobs');
    fs.mkdirSync(jobDir, { recursive: true });
    for (const name of fs.readdirSync(jobDir)) {
      if (/^job-\d+\.json$/.test(name)) fs.unlinkSync(path.join(jobDir, name));
    }
    const jobs = [];
    for (let i = 0; i < pending.length; i += EXPORT_JOBS) jobs.push(pending.slice(i, i + EXPORT_JOBS));
    jobs.forEach((list, i) => {
      const id = 'job-' + String(i + 1).padStart(3, '0');
      const payload = { id, count: list.length, segments: list.map((ja, k) => ({ k: k + 1, ja })) };
      fs.writeFileSync(path.join(jobDir, id + '.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    });
    console.log('已导出 ' + jobs.length + ' 个分片（每片 ' + EXPORT_JOBS + ' 段，共 ' + pending.length + ' 段）');
    console.log('分片目录：' + path.relative(ROOT, jobDir));
    console.log('译文回灌目录：' + path.relative(ROOT, path.join(DATA_DIR, 'translate', 'out')));
    console.log('回灌命令：node scripts/hakuho-import-jobs.js');
    return;
  }

  // ---- 3) 批量翻译（带并发）
  if (!DRY_RUN && !OFFLINE && pending.length > 0 && !API_KEY) {
    throw new Error(
      '缺少 TRANSLATE_API_KEY（或 OPENAI_API_KEY），还有 ' + pending.length + ' 段需要翻译。\n' +
      '可选替代：--export-jobs=N 导出分片交给外部翻译；--offline 只用已有译文；--dry-run 只验证拼装。'
    );
  }
  if (OFFLINE) {
    if (pending.length) {
      console.warn('--offline：' + pending.length + ' 段没有可用译文，这些位置将保留日文原文。');
    }
  } else if (pending.length) {
    const batches = [];
    for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));
    console.log('共 ' + batches.length + ' 个批次，并发 ' + CONCURRENCY + '，每批 ' + BATCH + ' 段\n');

    let cursor = 0;
    let doneBatches = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= batches.length) return;
        const batch = batches[index];
        const result = await translateBatch(batch, stats);
        for (const [source, target] of Object.entries(result)) {
          cache[source] = target;
          stats.translated += 1;
        }
        doneBatches += 1;
        stats.batches += 1;
        if (doneBatches % 5 === 0 || doneBatches === batches.length) {
          writeJsonAtomic(CACHE_FILE, cache);
          console.log('  批次 ' + doneBatches + '/' + batches.length + '（累计译文 ' + stats.translated + ' 段）');
        }
        await sleep(200);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));
    writeJsonAtomic(CACHE_FILE, cache);
  }

  // ---- 4) 拼装回 HTML（结构不变）
  function translateHtmlSegments(segments) {
    return segments
      .map((part, i) => {
        if (i % 2 !== 0) return part; // 标签原样，绝不改标签与属性
        const { lead, tail, core } = coreOf(part);
        if (!core) return part;
        const translated = lookupZh(core);
        return lead + (translated ? normalizeZh(translated) : core) + tail;
      })
      .join('');
  }

  function translatePlain(text) {
    const key = String(text || '').trim();
    if (!key) return '';
    const translated = lookupZh(key);
    return translated ? normalizeZh(translated) : key;
  }

  const products = [];
  const report = {
    generatedAt: new Date().toISOString(),
    model: DRY_RUN ? null : MODEL,
    total: 0,
    translated: 0,
    preserved: 0,
    newProducts: [],
    kanaLeftovers: [],
    emptyFields: [],
    missingImages: [],
    scrapedHandles: jaProducts.map((p) => p.handle),
    stats,
  };

  // 4a) 现有商品按原顺序输出
  for (const old of existingProducts) {
    const item = prepared.find((it) => it.ja.handle === old.handle);
    if (!item || !item.ja.detailJaHtml) {
      products.push(old);
      report.preserved += 1;
      continue;
    }
    products.push(buildProduct(old, item, old.handle));
    report.translated += 1;
  }

  // 4b) 新增商品追加到末尾
  const existingHandles = new Set(existingProducts.map((p) => p.handle));
  for (const item of prepared) {
    if (existingHandles.has(item.ja.handle)) continue;
    if (!item.ja.detailJaHtml) continue;
    const created = buildProduct(null, item, item.ja.handle);
    products.push(created);
    report.newProducts.push(item.ja.handle);
    report.translated += 1;
  }

  function buildProduct(old, item, handle) {
    const ja = item.ja;
    const detailHtml = stripHtmlComments(item.segments ? translateHtmlSegments(item.segments) : '');
    const descHtml = stripHtmlComments(item.descSegments ? translateHtmlSegments(item.descSegments) : '');
    const titleZh = translatePlain(item.titleJa) || (old && old.title) || handle;

    const detailPlain = toPlainText(detailHtml);
    let descPlain = normalizeDesc(toPlainText(descHtml, { keepSpanBoundary: true }));
    if (!descPlain) descPlain = detailPlain.slice(0, 120);

    // 图片：只保留磁盘上真实存在的文件
    let images = (ja.images || []).filter((rel) => {
      try {
        return fs.statSync(path.join(ROOT, rel.split('/').join(path.sep))).size > 0;
      } catch {
        return false;
      }
    });
    if (!images.length && old && Array.isArray(old.images) && old.images.length) {
      images = old.images;
    }
    if (!images.length) report.missingImages.push(handle);

    const product = {
      title: titleZh,
      type: (old && old.type) || TYPE_MAP[ja.productTypeJa] || '化妆刷',
      price: ja.price && ja.price !== '价格待确认' ? ja.price : (old && old.price) || '价格待确认',
      image: images[0] || (old && old.image) || '',
      images,
      desc: descPlain,
      detail: detailPlain,
      detailHtml,
      handle,
    };

    // 校验
    for (const field of ['title', 'desc', 'detail', 'detailHtml']) {
      if (!String(product[field] || '').trim()) report.emptyFields.push(handle + '.' + field);
    }
    for (const field of ['title', 'desc', 'detail']) {
      if (KANA_RE.test(String(product[field] || ''))) {
        report.kanaLeftovers.push({ handle, field, sample: String(product[field]).slice(0, 60) });
      }
    }
    return product;
  }

  report.total = products.length;

  // ---- 5) 写回 catalog-data.js（固定格式 window.PRODUCTS = [...];）
  const header = 'window.PRODUCTS = ';
  const body = JSON.stringify(products, null, 2);
  const tmp = CATALOG_FILE + '.tmp';
  fs.writeFileSync(tmp, header + body + ';\n', 'utf8');
  fs.renameSync(tmp, CATALOG_FILE);

  writeJsonAtomic(REPORT_FILE, report);

  // ---- 6) 汇总
  console.log('\n完成。');
  console.log('  catalog-data.js 商品总数：' + products.length);
  console.log('  本轮按新规则重译：' + report.translated + ' 条');
  console.log('  保留原数据（未抓到日文）：' + report.preserved + ' 条');
  console.log('  新增商品：' + report.newProducts.length + ' 条' + (report.newProducts.length ? ' -> ' + report.newProducts.join(', ') : ''));
  console.log('  残留假名的字段：' + report.kanaLeftovers.length + ' 处');
  console.log('  空字段：' + report.emptyFields.length + ' 处');
  console.log('  无图片商品：' + report.missingImages.length + ' 条');
  console.log('  翻译统计：缓存命中 ' + stats.cacheHits + ' 段，人工覆盖 ' + overrideCount + ' 条，新译 ' + stats.translated + ' 段，接口错误 ' + stats.apiErrors + ' 次，漏译 ' + stats.missing + ' 段');
  console.log('  报告：' + path.relative(ROOT, REPORT_FILE));

  if (report.kanaLeftovers.length) {
    console.log('\n残留假名示例（前 10 条）：');
    for (const item of report.kanaLeftovers.slice(0, 10)) {
      console.log('  - ' + item.handle + '.' + item.field + '：' + item.sample);
    }
    console.log('  提示：重跑本脚本会复用缓存，需先删除 data/hakuho-zh-cache.json 中对应条目再重跑。');
  }
  if (stats.missing > 0) {
    console.log('\n有 ' + stats.missing + ' 段未返回译文，重新运行本脚本会自动补翻（结果已缓存的部分不会重复调用接口）。');
  }
}

main().catch((err) => {
  console.error('\n翻译失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
