#!/usr/bin/env node
'use strict';
/**
 * 竹宝堂（CHIKUHODO）商品 —— 第二阶段：把 data/chikuhodo-ja.json 里的日文翻译成通顺简体中文，
 * 并写回 chikuhodo-data.js。
 *
 * 与其他品牌完全同一套机制（先取全量日文，再统一翻译），只是品牌、术语表与产物路径不同：
 *   1) 「格式不要变」——按标签把 HTML 切成「标签段 / 文本段」，只翻译文本段再原样拼回。
 *      HTML 标签、属性、空白、换行逐字节不变（table.style_table02 的原有属性也保留）。
 *   2) 译文通顺——固定术语表 + 面向中国大陆消费者的表达要求，不逐字硬译。
 *   3) 可断点续跑——译文按「日文原句」缓存到 data/chikuhodo-zh-cache.json，重复句只翻一次。
 *   4) 分类一并翻译（categoryJa -> type），站内「分类搜索」按中文分类工作。
 *
 * 翻译服务：任何 OpenAI 兼容的 /chat/completions 接口。
 *   TRANSLATE_API_KEY   必填（--dry-run 时可不填）
 *   TRANSLATE_BASE_URL  默认 https://api.openai.com/v1
 *   TRANSLATE_MODEL     默认 gpt-4o-mini
 *
 * 用法：
 *   node scripts/chikuhodo-translate.js --dry-run        # 不调接口，只验证拼装与写回逻辑
 *   node scripts/chikuhodo-translate.js --limit=5        # 只处理前 5 条
 *   node scripts/chikuhodo-translate.js                  # 全量
 *   node scripts/chikuhodo-translate.js --batch=60 --concurrency=3
 *
 * 产物：
 *   chikuhodo-data.js              window.PRODUCTS = [...]; 格式
 *   data/chikuhodo-zh-cache.json   日→中 译文缓存
 *   data/chikuhodo-report.json     校验报告（残留假名、空字段、缺图、失败清单）
 */

const fs = require('fs');
const path = require('path');
const { tagBalance } = require('./lib-html.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JA_FILE = path.join(DATA_DIR, 'chikuhodo-ja.json');
const CACHE_FILE = path.join(DATA_DIR, 'chikuhodo-zh-cache.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'chikuhodo-zh-overrides.json');
const REPORT_FILE = path.join(DATA_DIR, 'chikuhodo-report.json');
const CATALOG_FILE = path.join(ROOT, 'chikuhodo-data.js');

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
  // 与白凤堂共用（保持一致，避免同一站点出现两种译法）
  ['フィニッシング', '定妆'],
  ['パウダー', '蜜粉'],
  ['チーク', '腮红'],
  ['アイシャドウ', '眼影'],
  ['アイライナー', '眼线'],
  ['ハイライト', '高光'],
  ['シェーディング', '阴影'],
  ['コンシーラー', '遮瑕'],
  ['リップ', '唇'],
  ['穂先', '笔尖'],
  ['毛丈', '毛长'],
  ['全長', '全长'],
  ['厚み', '厚度'],
  ['軸', '刷杆'],
  ['金具', '金属件'],
  ['真鍮', '黄铜'],
  ['ゴールド', '金色'],
  ['シルバー', '银色'],
  ['灰リス', '灰松鼠毛'],
  ['合成繊維', '合成纤维'],
  ['斜め', '斜角'],
  ['尖り', '尖头'],
  ['名入れ', '刻名'],
  ['熊野筆', '熊野笔'],
  ['化粧筆', '化妆刷'],
  // 竹宝堂专用：毛种
  ['シルバーフォックス', '银狐毛'],
  ['プレミアムシルバーフォックス', '顶级银狐毛'],
  ['カナダリス', '加拿大松鼠毛'],
  ['カザンリス', '喀山松鼠毛'],
  ['白松リス', '白松松鼠毛'],
  ['赤リス', '赤松鼠毛'],
  ['松リス', '松松鼠毛'],
  ['灰リス', '灰松鼠毛'],
  ['リス', '松鼠毛'],
  ['じゃ香', '麝香'],
  ['ジャコウ', '麝香毛'],
  ['イタチ', '黄鼠狼毛'],
  ['ヤギ', '山羊毛'],
  ['山羊', '山羊毛'],
  ['ウマ', '马毛'],
  ['馬毛', '马毛'],
  ['粗光峰', '粗光峰'],
  ['細光峰', '细光峰'],
  ['細微光峰', '细微光峰'],
  ['ナイロン', '尼龙'],
  // 竹宝堂专用：器具与类型
  ['水目桜', '水目樱木'],
  ['サクラ', '樱木'],
  ['黒壇', '黑檀'],
  ['春慶塗', '春庆漆'],
  ['蒔絵', '莳绘'],
  ['つげ', '黄杨木'],
  ['ブラシケース', '刷盒'],
  ['ケース', '盒'],
  ['ブラシキャップ', '刷盖'],
  ['携帯用', '便携'],
  ['限定', '限定'],
  ['数量限定', '数量限定'],
  ['セット', '套装'],
  ['毛質', '毛质'],
  ['毛材質', '毛材质'],
  ['金具幅', '金属件宽'],
  ['金具厚', '金属件厚'],
  ['商品コード', '商品编号'],
  ['品番', '编号'],
  ['価格', '价格'],
  ['形状', '形状'],
  ['税込', '含税'],
  ['エコ包装', '环保包装'],
  ['ギフトラッピング', '礼品包装'],
  ['熨斗', '礼签'],
];

/**
 * 源站分类 → 站内 type。
 *
 * 竹宝堂的分类体系就是站方商品页面包屑里的 **`cate_*` 用途分类**（实测 21 个），
 * 抓取阶段已把日文分类名写入 `typeJa` / `categoriesJa`，这里只负责译名。
 * 用「子串」匹配：站方个别分类名带「（商品一覧）」这类后缀。
 * 顺序即优先级，具体者在前。
 */
const TYPE_MAP = [
  ['セット（ギフト）ブラシ', '套装（礼盒）刷'],
  ['セットブラシ', '套装刷'],
  ['アイメイクセット', '眼妆套装'],
  ['アイシャドーブラシ', '眼影刷'],
  ['シャドーライナーブラシ', '眼影眼线刷'],
  ['ノーズシャドーブラシ', '鼻影刷'],
  ['アイブローブラシ', '眉刷'],
  ['アイライナーブラシ', '眼线刷'],
  ['リップブラシ', '唇刷'],
  ['チークブラシ', '腮红刷'],
  ['ハイライトブラシ', '高光刷'],
  ['パウダーブラシ', '蜜粉刷'],
  ['ファンデーションブラシ', '粉底刷'],
  ['コンシーラーブラシ', '遮瑕刷'],
  ['リキッドブラシ', '液体刷'],
  ['ブレンディングブラシ', '晕染刷'],
  ['カンターブラシ', '修容刷'],
  ['スクリューブラシ', '螺旋眉刷'],
  ['洗顔＆泡立てブラシ', '洁面起泡刷'],
  ['ブラシ＆コーム', '刷子＆梳子'],
  ['メンズブラシ', '男士刷'],
  ["Men's", '男士刷'],
  ['ケース', '刷盒'],
  ['ギフト', '礼盒'],
];

/** 按子串把源分类名译成中文；未命中返回 null（交给机器翻译兜底） */
function translateCategoryName(ja) {
  const s = String(ja || '');
  for (const [key, zh] of TYPE_MAP) if (s.includes(key)) return zh;
  return null;
}

function buildSystemPrompt() {
  return [
    '你是资深化妆品本地化译者，负责把日本竹宝堂（CHIKUHODO，广岛县熊野町的熊野笔/化妆刷制造商）官方在线商店商品页的日文翻译成面向中国大陆消费者的简体中文。',
    '',
    '硬性要求：',
    '1. 译文必须通顺、自然、符合中文表达习惯。不要逐字硬译，不要保留日语文法，不要出现日语助词残余。',
    '2. 输入是一个 JSON 对象：键是序号，值是待翻译的日文。',
    '   你必须输出结构完全相同的 JSON 对象：键一个不多一个不少，值是对应的简体中文译文。',
    '3. 只输出这个 JSON 对象本身。不要输出解释、注释、markdown 代码块或任何多余字符。',
    '4. 保留原文中的数字、单位（如 mm、g）、型号编号（如 FO-8、GL-8/GS-8、S-R-16、C-18）与颜色名。',
    '5. 若某段日文本身是专有名词或型号，可保留原文或音译，不要强行意译。',
    '6. 各条译文之间不要互相拼接，不要合并，不要拆分。',
    '',
    '固定术语（必须遵守）：',
    GLOSSARY.map(([ja, zh]) => ja + '=' + zh).join('、'),
    '',
    '示例：',
    '输入 {"1":"灰リスに匹敵する柔らかさ、山羊のようなコシの強さを併せ持つシルバーフォックスを使用。"}',
    '输出 {"1":"采用兼具媲美灰松鼠毛的柔软与山羊毛般挺度的银狐毛。"}',
  ].join('\n');
}

const SYSTEM_PROMPT = buildSystemPrompt();

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
  console.log('竹宝堂 CHIKUHODO 翻译 · 阶段二' + (DRY_RUN ? '（dry-run，不调用接口）' : ''));
  console.log('模型：' + (DRY_RUN ? '(跳过)' : MODEL + ' @ ' + BASE_URL));

  if (!fs.existsSync(JA_FILE)) {
    throw new Error('找不到 ' + path.relative(ROOT, JA_FILE) + '，请先运行 node scripts/chikuhodo-scrape.js');
  }
  const jaStore = JSON.parse(fs.readFileSync(JA_FILE, 'utf8'));
  let jaProducts = Array.isArray(jaStore.products) ? jaStore.products.slice() : [];
  if (!jaProducts.length) throw new Error('中间产物里没有商品，请先运行抓取脚本');
  jaProducts.sort((a, b) => String(a.handle).localeCompare(String(b.handle)));
  if (LIMIT > 0) jaProducts = jaProducts.slice(0, LIMIT);
  console.log('待翻译商品：' + jaProducts.length + ' 条');

  // 现有 chikuhodo-data.js：首次运行时不存在，此时按「全部是新增商品」处理。
  let existingProducts = [];
  if (fs.existsSync(CATALOG_FILE)) {
    const existingRaw = fs.readFileSync(CATALOG_FILE, 'utf8');
    const existingMatch = existingRaw.match(/^\s*window\.PRODUCTS\s*=\s*([\s\S]*?);\s*$/);
    if (!existingMatch) throw new Error(path.relative(ROOT, CATALOG_FILE) + ' 格式无法识别');
    existingProducts = JSON.parse(existingMatch[1]);
    console.log('现有 ' + path.relative(ROOT, CATALOG_FILE) + '：' + existingProducts.length + ' 条');
  } else {
    console.log('首次运行：' + path.relative(ROOT, CATALOG_FILE) + ' 尚不存在，全部按新增商品生成');
  }

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

    // 分类也走同一套翻译（缓存/人工覆盖都适用），用于 type 字段与站内分类搜索。
    // 抓取产物里用途分类的字段名是 typeJa（竹宝堂只有单一用途分类，见 chikuhodo-scrape.js）。
    const cat = String(ja.typeJa || ja.categoryJa || '').trim();
    item.categoryJa = cat;
    if (cat && !translateCategoryName(cat) && !uniqueCores.has(cat)) uniqueCores.add(cat);
    // 多分类的明细同样需要译文（供 categories 字段与搜索命中）
    for (const c of ja.categoriesJa || []) {
      const name = String(c || '').trim();
      if (name && !translateCategoryName(name) && !uniqueCores.has(name)) uniqueCores.add(name);
    }

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
    const jobDir = path.join(DATA_DIR, 'chikuhodo-translate', 'jobs');
    const outDir = path.join(DATA_DIR, 'chikuhodo-translate', 'out');
    fs.mkdirSync(jobDir, { recursive: true });
    // 同时建好译文回灌目录：否则外部翻译者无处可放结果（曾因此报 ENOENT）
    fs.mkdirSync(outDir, { recursive: true });
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
    console.log('译文回灌目录：' + path.relative(ROOT, outDir));
    console.log('回灌命令：node scripts/hakuho-import-jobs.js --brand=chikuhodo');
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
    unbalancedTags: [],
    scrapedHandles: jaProducts.map((p) => p.handle),
    stats,
  };

  // 4a) 现有商品按原顺序输出
  for (const old of existingProducts) {
    const item = prepared.find((it) => it.ja.handle === old.handle);
    if (!item) {
      products.push(old);
      report.preserved += 1;
      continue;
    }
    products.push(buildProduct(old, item, old.handle));
    report.translated += 1;
  }

  // 4b) 新增商品追加到末尾（竹宝堂首次运行时全部走这里）
  const existingHandles = new Set(existingProducts.map((p) => p.handle));
  for (const item of prepared) {
    if (existingHandles.has(item.ja.handle)) continue;
    const created = buildProduct(null, item, item.ja.handle);
    products.push(created);
    report.newProducts.push(item.ja.handle);
    report.translated += 1;
  }

  function buildProduct(old, item, handle) {
    const ja = item.ja;
    // 列表页描述：div.item_description（模板 A）或 article（模板 B），保留原有样式、含图片
    const descHtml = stripHtmlComments(item.descSegments ? translateHtmlSegments(item.descSegments) : '');
    // 点击详情：同一区块但**排除图片**（用户规则），保留原有样式
    const detailHtml = stripHtmlComments(item.segments ? translateHtmlSegments(item.segments) : '');
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

    // 分类：竹宝堂的分类体系就是站方的 cate_* 用途分类（抓取阶段写入 typeJa）。
    //   type       = 单一用途分类（中文），用于分类下拉筛选
    //   categories = 全部分类的中文列表，用于关键词搜索（保留以兼容站内搜索）
    //
    // 注意优先级：**先按源站的日文分类名翻译**，再退回旧数据。
    // 若把 `old.type` 放在前面，重跑时会把上一轮写入的（可能是日文的）type 原样保留，
    // 实测就因此留下过 `Men's（商品一覧）`。
    const catJa = item.categoryJa || '';
    const typeZh =
      translateCategoryName(catJa) ||
      (catJa ? translatePlain(catJa) : '') ||
      (old && old.type) ||
      '其他';
    const categoriesZh = (ja.categoriesJa || [])
      .map((c) => translateCategoryName(c) || (c ? translatePlain(c) : ''))
      .filter(Boolean);

    const product = {
      title: titleZh,
      type: typeZh,
      categories: categoriesZh.length ? categoriesZh : typeZh ? [typeZh] : [],
      price: ja.price && ja.price !== '价格待确认' ? ja.price : (old && old.price) || '价格待确认',
      image: images[0] || (old && old.image) || '',
      images,
      desc: descPlain,
      detail: detailPlain,
      detailHtml,
      handle,
    };

    // 校验：detailHtml/desc/detail 为空是合法情况（站方本来就没写描述，如 1682019），
    // 只当作提示，不算错误。
    for (const field of ['title', 'desc', 'detail', 'detailHtml']) {
      if (!String(product[field] || '').trim()) report.emptyFields.push(handle + '.' + field);
    }

    // 「不错版」自检：desc 与 detailHtml 的标签必须配平（详情弹窗直接 innerHTML 渲染）
    const unbalanced = [...tagBalance(String(product.desc || '')), ...tagBalance(String(product.detailHtml || ''))];
    if (unbalanced.length) report.unbalancedTags.push(handle + '：' + unbalanced.join(', '));
    // 残留日文自检：假名 + 只在日文语境里高频出现的汉字（如「覧」「込」）。
    // 只查假名会漏掉 `Men's（商品一覧）` 这类**纯汉字残留**——实测就漏报过。
    for (const field of ['title', 'desc', 'detail', 'type']) {
      const val = String(product[field] || '');
      const kana = KANA_RE.test(val);
      const jpKanji = /[覧込払渡価円髪顔頬軸房]/.test(val);
      if (kana || jpKanji) {
        report.kanaLeftovers.push({ handle, field, sample: val.slice(0, 60), kind: kana ? 'kana' : 'kanji' });
      }
    }
    return product;
  }

  report.total = products.length;

  // ---- 5) 写回 chikuhodo-data.js（固定格式 window.PRODUCTS = [...];）
  const header = 'window.PRODUCTS = ';
  const body = JSON.stringify(products, null, 2);
  const tmp = CATALOG_FILE + '.tmp';
  fs.writeFileSync(tmp, header + body + ';\n', 'utf8');
  fs.renameSync(tmp, CATALOG_FILE);

  writeJsonAtomic(REPORT_FILE, report);

  // ---- 6) 汇总
  console.log('\n完成。');
  console.log('  chikuhodo-data.js 商品总数：' + products.length);
  console.log('  本轮重译：' + report.translated + ' 条');
  console.log('  保留原数据：' + report.preserved + ' 条');
  console.log('  新增商品：' + report.newProducts.length + ' 条');
  console.log('  分类（type）分布：');
  const typeCount = {};
  for (const p of products) typeCount[p.type || '(空)'] = (typeCount[p.type || '(空)'] || 0) + 1;
  Object.entries(typeCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('    ' + String(v).padStart(4) + '  ' + k));
  console.log('  残留假名的字段：' + report.kanaLeftovers.length + ' 处');
  console.log('  空字段：' + report.emptyFields.length + ' 处');
  console.log('  标签不配平商品数（应为 0）：' + report.unbalancedTags.length);
  console.log('  无图片商品：' + report.missingImages.length + ' 条');
  console.log('  翻译统计：缓存命中 ' + stats.cacheHits + ' 段，人工覆盖 ' + overrideCount + ' 条，新译 ' + stats.translated + ' 段，接口错误 ' + stats.apiErrors + ' 次，漏译 ' + stats.missing + ' 段');
  console.log('  报告：' + path.relative(ROOT, REPORT_FILE));

  if (report.kanaLeftovers.length) {
    console.log('\n残留假名示例（前 10 条）：');
    for (const item of report.kanaLeftovers.slice(0, 10)) {
      console.log('  - ' + item.handle + '.' + item.field + '：' + item.sample);
    }
    console.log('  提示：重跑本脚本会复用缓存，需先删除 data/chikuhodo-zh-cache.json 中对应条目再重跑。');
  }
  if (stats.missing > 0) {
    console.log('\n有 ' + stats.missing + ' 段未返回译文，重新运行本脚本会自动补翻（结果已缓存的部分不会重复调用接口）。');
  }
}

main().catch((err) => {
  console.error('\n翻译失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
