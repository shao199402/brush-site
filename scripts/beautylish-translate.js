#!/usr/bin/env node
'use strict';
/**
 * Beautylish 阶段二：把英文内容翻成简体中文。
 *
 * 与其它品牌的差异（重要）：
 *   1) 源站是**英文**（美国零售商），不是日文；
 *   2) **商品名不翻译**——英文商品名就是正品名（用户确认口径）。
 *      只翻：商品描述、规格文案、品类名。
 *   3) 该站品类名由 slug 推导（typeSource='derived'），等建立准确分类映射后
 *      这里只需重跑即可。
 *
 * 产物：
 *   data/beautylish-zh-cache.json       英→中 译文缓存（按原文精确匹配）
 *   data/beautylish-zh-overrides.json   人工覆盖（优先级最高）
 *   data/beautylish-build-input.json    构建输入：{ categories, variantNotes, details }
 *   data/beautylish-report.json         翻译报告
 *
 * 用法：
 *   node scripts/run-with-key.js beautylish-translate.js --batch=40 --concurrency=3
 *   node scripts/beautylish-translate.js --offline     只用缓存+覆盖
 *   node scripts/beautylish-translate.js --dry-run     不调接口，检查待翻译量
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const EN_FILE = path.join(DATA_DIR, 'beautylish-en.json');
const LIST_FILE = path.join(DATA_DIR, 'beautylish-list.json');
const CACHE_FILE = path.join(DATA_DIR, 'beautylish-zh-cache.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'beautylish-zh-overrides.json');
const BUILD_INPUT = path.join(DATA_DIR, 'beautylish-build-input.json');
const REPORT_FILE = path.join(DATA_DIR, 'beautylish-report.json');

const argv = process.argv.slice(2);
const argValue = (name) => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const DRY_RUN = argv.includes('--dry-run');
const OFFLINE = argv.includes('--offline');
const BATCH = Math.max(1, Number(argValue('--batch') || 40));
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency') || 3));
const MAX_CHARS_PER_BATCH = Math.max(2000, Number(argValue('--max-chars') || 12000));
const BASE_URL = String(process.env.TRANSLATE_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const API_KEY = process.env.TRANSLATE_API_KEY || process.env.OPENAI_API_KEY || '';
const MODEL = String(argValue('--model') || process.env.TRANSLATE_MODEL || 'deepseek-chat');

// ---------------------------------------------------------------- 术语与提示词

/** 美妆英文 → 中文固定术语（保证同一概念全站一致） */
const GLOSSARY = [
  ['Powder Brush', '蜜粉刷'],
  ['Foundation Brush', '粉底刷'],
  ['Blush Brush', '腮红刷'],
  ['Cheek Brush', '腮红刷'],
  ['Highlight Brush', '高光刷'],
  ['Contour Brush', '修容刷'],
  ['Bronzer Brush', '古铜刷'],
  ['Eyeshadow Brush', '眼影刷'],
  ['Shadow Brush', '眼影刷'],
  ['Blending Brush', '晕染刷'],
  ['Eyeliner Brush', '眼线刷'],
  ['Brow Brush', '眉刷'],
  ['Lip Brush', '唇刷'],
  ['Concealer Brush', '遮瑕刷'],
  ['Fan Brush', '扇形刷'],
  ['Kabuki Brush', '歌舞伎刷'],
  ['Duo Fibre', '双纤维'],
  ['Synthetic', '合成纤维'],
  ['Goat Hair', '山羊毛'],
  ['Squirrel Hair', '松鼠毛'],
  ['Grey Squirrel', '灰松鼠毛'],
  ['Silver Fox', '银狐毛'],
  ['Blue Squirrel', '蓝松鼠毛'],
  ['Canadian Squirrel', '加拿大松鼠毛'],
  ['Weasel', '黄鼠狼毛'],
  ['Horse Hair', '马毛'],
  ['Pony Hair', '小马毛'],
  ['Sable', '貂毛'],
  ['Kolinsky', '科林斯基貂毛'],
  ['Saikoho', '粗光峰'],
  ['Sokoho', '细光峰'],
  ['Hair Length', '毛长'],
  ['Total Length', '全长'],
  ['Ferrule', '金属件'],
  ['Handle', '刷杆'],
  ['Bristles', '刷毛'],
  ['Dye-free', '无染色'],
  ['Cruelty-free', '无动物实验'],
  ['Vegan', '纯素'],
  ['Limited Edition', '限量版'],
  ['Shades Available', '种色号可选'],
  ['Sizes Available', '种规格可选'],
  ['Colors Available', '种颜色可选'],
  ['Options Available', '种规格可选'],
  ['Palettes Available', '种盘可选'],
  ['Sets Available', '种套装可选'],
  ['Scents Available', '种香型可选'],
  ['Flavors Available', '种口味可选'],
  ['Looks Available', '种妆效可选'],
  ['Editions Available', '种版本可选'],
  ['Out of Stock', '缺货'],
  ['Add to Bag', '加入购物袋'],
];

/** 品类名（slug 推导出的中文）已经就是中文，这里只兜底翻译意外出现的英文 */
const CATEGORY_ZH = {
  其他: '其他', 刷具: '刷具', 刷具清洁: '刷具清洁', 眼妆: '眼妆', 唇妆: '唇妆',
  底妆: '底妆', 腮红修容: '腮红修容', 彩妆盘: '彩妆盘', 洁面: '洁面', 精华: '精华',
  面霜乳液: '面霜乳液', 面膜: '面膜', 防晒: '防晒', 爽肤水: '爽肤水', 眼霜: '眼霜',
  精油: '精油', 洗发护发: '洗发护发', 造型: '造型', 香水: '香水', 身体护理: '身体护理',
  美甲: '美甲', 美容工具: '美容工具', 健康: '健康',
};

function buildSystemPrompt() {
  return [
    '你是资深美妆本地化译者，负责把美国美妆零售商 Beautylish 商品页的英文翻译成面向中国大陆消费者的简体中文。',
    '',
    '硬性要求：',
    '1. 译文必须通顺、自然、符合中文美妆行业表达习惯。不要逐字硬译。',
    '2. 输入是一个 JSON 对象：键是序号，值是待翻译的英文。',
    '   你必须输出结构完全相同的 JSON 对象：键一个不多一个不少，值是对应的简体中文译文。',
    '3. 只输出这个 JSON 对象本身。不要输出解释、注释、markdown 代码块或任何多余字符。',
    '4. 保留原文中的数字、单位（如 mm、g、ml、SPF）与成分名（如 Retinol、Vitamin C、Peptides）。',
    '5. 专有名词、品牌名、商品型号保留原文或通用音译，不要强行意译。',
    '6. 各条译文之间不要互相拼接，不要合并，不要拆分。',
    '7. 原文里若有 markdown 记号（如开头的 #####About），译文里不要保留这些记号。',
    '',
    '固定术语（必须遵守）：',
    GLOSSARY.map(([en, zh]) => en + '=' + zh).join('、'),
    '',
    '示例：',
    '输入 {"1":"Visibly smooth fine lines and wrinkles, and also brighten the appearance of dark circles with this moisturizing eye cream."}',
    '输出 {"1":"这款保湿眼霜能明显淡化细纹与皱纹，并提亮黑眼圈的外观。"}',
  ].join('\n');
}
const SYSTEM_PROMPT = buildSystemPrompt();

// ---------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonIfExists = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
};

async function callModel(payload, timeoutMs = 180000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
      body: JSON.stringify(payload),
      signal: c.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 300));
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

function parseModelJson(content) {
  const s = String(content || '').trim();
  try { return JSON.parse(s); } catch { /* 继续尝试 */ }
  const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(fenced); } catch { /* 继续尝试 */ }
  const a = fenced.indexOf('{');
  const b = fenced.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(fenced.slice(a, b + 1)); } catch { /* 放弃 */ } }
  return null;
}

async function translateBatch(strings, stats) {
  if (!strings.length) return {};
  if (DRY_RUN) { const o = {}; for (const s of strings) o[s] = s; return o; }

  const idToSource = {};
  strings.forEach((s, i) => { idToSource[String(i + 1)] = s; });
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
        ? response.choices[0].message.content : '';
      const parsed = parseModelJson(content);
      if (!parsed || typeof parsed !== 'object') throw new Error('返回内容不是合法 JSON');
      const out = {};
      for (const [id, source] of Object.entries(idToSource)) {
        const v = parsed[id];
        if (typeof v === 'string' && v.trim()) out[source] = v.trim();
      }
      const missing = strings.length - Object.keys(out).length;
      if (missing > 0) stats.missing += missing;
      return out;
    } catch (err) {
      stats.apiErrors += 1;
      if (attempt === 3) {
        console.warn('  ! 批次翻译失败（' + strings.length + ' 段）：' + err.message);
        return {};
      }
      await sleep(2000 * attempt);
    }
  }
  return {};
}

// ---------------------------------------------------------------- 主流程

(async () => {
  console.log('Beautylish 翻译 · 阶段二（英文 → 简体中文）' + (DRY_RUN ? '（dry-run）' : ''));
  console.log('模型：' + (DRY_RUN ? '(跳过)' : MODEL + ' @ ' + BASE_URL));

  // ---- 输入：详情缓存（增量记录，权威）+ 枚举（商品名/规格/品牌）
  //
  // 为什么不读 data/beautylish-en.json：那是**抓取结束时**才写、且每次运行会覆盖，
  // 长任务中途只会有上一轮的旧内容（实测缓存已 244 件而该文件只有 8 件）。
  // 缓存目录 data/beautylish-cache/*.json 才是逐件落盘的增量记录。
  const list = readJsonIfExists(LIST_FILE, null);
  if (!list || !list.items) {
    console.error('缺少枚举结果 ' + path.relative(ROOT, LIST_FILE));
    process.exit(1);
  }
  const CACHE_DIR = path.join(DATA_DIR, 'beautylish-cache');
  const cached = fs.existsSync(CACHE_DIR)
    ? fs.readdirSync(CACHE_DIR).filter((f) => /\.json$/.test(f)).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch { return null; }
    }).filter(Boolean)
    : [];
  const detailBySlug = new Map(cached.map((p) => [p.slug, p]));
  console.log('枚举商品：' + list.items.length + '   详情缓存：' + detailBySlug.size + ' 件');

  const cache = readJsonIfExists(CACHE_FILE, {});
  const overrides = readJsonIfExists(OVERRIDES_FILE, {});
  const lookup = (en_text) => overrides[en_text] ?? cache[en_text];
  const OVERRIDE_COUNT = Object.keys(overrides).length;

  // ---- 待翻译集合
  const need = new Set();

  // 1) 规格文案（如 "25 Shades Available"）
  for (const it of list.items) {
    const v = String(it.optionsText || '').trim();
    if (v && !lookup(v)) need.add(v);
  }
  // 2) 品类名（若出现英文，兜底；中文的直接用 CATEGORY_ZH）
  for (const c of Object.keys(CATEGORY_ZH)) { /* 中文键无需翻译 */ }

  // 3) 商品描述：优先 JSON-LD 的 description（干净），其次 Product Description 段落
  const cleanText = (s) => String(s || '')
    .replace(/#{2,}\s*About\s+/gi, '')
    .replace(/#{2,}\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  /**
   * 译前剥离「商品名前缀」。
   *
   * 该站 JSON-LD 的 description 经常以商品全名开头
   * （"Albion Flora Drip Dispenser Albion Flora Drip Dispenser is a pump…"），
   * 若直接送去翻译，译文会照搬这个重复前缀，显示成
   * 「Albion Flora Drip Dispenser 是一款…」——标题里已经有商品名了。
   * 因此**在翻译前**就把前缀去掉（放在译后清理是不可靠的：
   * 译文里是中文，无法用英文前缀匹配）。
   */
  const stripNamePrefix = (text, item) => {
    let t = String(text || '');
    const cands = [
      String((item && item.fullNameEn) || '').trim(),
      String((item && item.name) || '').trim(),
      item && item.brand && item.name ? String(item.brand) + ' ' + String(item.name) : '',
    ].filter(Boolean).sort((a, b) => b.length - a.length);
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const cand of cands) {
        const esc = cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('^\\s*' + esc + '\\b[\\s:：,.，、-]*', 'i');
        if (re.test(t)) { t = t.replace(re, ''); changed = true; }
      }
      if (!changed) break;
    }
    // 剥掉主语后常剩下孤立的系动词（"...Dispenser is a pump" → "is a pump"），
    // 直接翻译会得到「是一款…」。这里把系动词一并去掉。
    t = t.replace(/^\s*(?:is|are|was|were|it's|it is)\s+/i, '');
    // 若开头变成小写，恢复首字母大写
    t = t.replace(/^([a-z])/, (m) => m.toUpperCase());
    return t.trim();
  };

  const listBySlug = new Map(list.items.map((x) => [x.slug, x]));
  const detailTextOf = (rec) => {
    const item = listBySlug.get(rec.slug) || {};
    const ld = cleanText(rec.ldDescription);
    const raw = ld.length >= 40 ? ld : cleanText((rec.sectionsEn && rec.sectionsEn['Product Description']) || '');
    return stripNamePrefix(raw, item);
  };
  for (const p of detailBySlug.values()) {
    const t = detailTextOf(p);
    if (t && !lookup(t)) need.add(t);
  }

  const queue = [...need];
  const totalChars = queue.reduce((a, s) => a + s.length, 0);
  console.log('\n待翻译：' + queue.length + ' 段（约 ' + Math.round(totalChars / 1000) + ' 千字符；已缓存 ' + Object.keys(cache).length + ' 段，人工覆盖 ' + OVERRIDE_COUNT + ' 条）');

  const stats = { apiErrors: 0, missing: 0, translated: 0 };

  if (queue.length && !OFFLINE && !DRY_RUN) {
    if (!API_KEY) {
      console.error('\n缺少 TRANSLATE_API_KEY，无法翻译。请用：node scripts/run-with-key.js beautylish-translate.js');
      process.exit(1);
    }
    // 按字符数分批，避免超长请求
    const batches = [];
    let cur = [];
    let curLen = 0;
    for (const s of queue) {
      if (cur.length >= BATCH || (curLen + s.length > MAX_CHARS_PER_BATCH && cur.length)) {
        batches.push(cur); cur = []; curLen = 0;
      }
      cur.push(s); curLen += s.length;
    }
    if (cur.length) batches.push(cur);
    console.log('分 ' + batches.length + ' 批，并发 ' + CONCURRENCY);

    let done = 0;
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= batches.length) return;
        const got = await translateBatch(batches[i], stats);
        for (const [k, v] of Object.entries(got)) cache[k] = v;
        done++;
        stats.translated += Object.keys(got).length;
        if (done % 5 === 0 || done === batches.length) {
          writeJson(CACHE_FILE, cache);
          console.log('  批次 ' + done + '/' + batches.length + '（新增译文 ' + stats.translated + '，接口错误 ' + stats.apiErrors + '，漏译 ' + stats.missing + '）');
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    writeJson(CACHE_FILE, cache);
  } else if (queue.length && OFFLINE) {
    console.log('--offline：跳过接口调用，仅用已有缓存与覆盖拼装');
  }

  // ---- 组装构建输入
  const variantNotes = {};
  for (const it of list.items) {
    const v = String(it.optionsText || '').trim();
    if (v) variantNotes[v] = lookup(v) || v;
  }
  const details = {};
  for (const p of detailBySlug.values()) {
    const t = detailTextOf(p);
    if (t) details[p.slug] = lookup(t) || '';
  }
  const categories = { ...CATEGORY_ZH };

  writeJson(BUILD_INPUT, {
    generatedAt: new Date().toISOString(),
    sourceLang: 'en',
    note: '商品名不翻译（英文即正品名）；此处仅含描述/规格/品类的中文',
    categories,
    variantNotes,
    details,
    coverage: {
      enumerated: list.items.length,
      detailsCrawled: detailBySlug.size,
      detailTranslated: Object.values(details).filter(Boolean).length,
      variantNotes: Object.keys(variantNotes).length,
    },
  });

  // ---- 报告
  const stillMissing = queue.filter((s) => !lookup(s));
  const report = {
    generatedAt: new Date().toISOString(),
    model: DRY_RUN ? '(dry-run)' : MODEL,
    baseUrl: BASE_URL,
    queue: queue.length,
    queueChars: totalChars,
    translatedThisRun: stats.translated,
    cacheSize: Object.keys(cache).length,
    overrides: OVERRIDE_COUNT,
    apiErrors: stats.apiErrors,
    missing: stats.missing,
    stillMissing: stillMissing.length,
  };
  writeJson(REPORT_FILE, report);

  console.log('\n完成。');
  console.log('  本次新译：' + stats.translated + ' 段');
  console.log('  缓存累计：' + Object.keys(cache).length + ' 段（人工覆盖 ' + OVERRIDE_COUNT + ' 条）');
  console.log('  接口错误：' + stats.apiErrors + '   漏译：' + stats.missing + '   仍未译：' + stillMissing.length);
  console.log('  构建输入：' + path.relative(ROOT, BUILD_INPUT));
  console.log('  详情覆盖：' + Object.values(details).filter(Boolean).length + '/' + detailBySlug.size + ' 件已翻');
})().catch((err) => {
  console.error('翻译失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
