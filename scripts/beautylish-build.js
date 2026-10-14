#!/usr/bin/env node
'use strict';
/**
 * Beautylish 数据构建：把枚举结果（data/beautylish-list.json）变成站内可用的
 * beautylish-data.js。
 *
 * 为什么单独一个脚本（而不是走「翻译脚本」那一套）：
 *   Beautylish 是**美国零售商**，商品名本身就是英文，不需要日→中翻译；
 *   要做的是「品牌名中文化 + 图片本地化 + 字段整形」。
 *
 * 字段映射：
 *   title        品牌名(中文) + 商品名(原文英文)   —— 该站商品名是英文，保留原文
 *   brand        品牌名(中文)                      —— 卡片显示品牌用
 *   type         品类（中文）                      —— 见下方说明
 *   price        原样透传，含货币符号（如 CN¥528）
 *   variantNote  规格文案（如 25 Shades Available），有才带
 *   image/images 本地图片（把 CDN 的 175×175 换成 350×350 再下载）
 *
 * 品类说明（重要）：
 *   枚举阶段**不含品类**，该站准确的品类需要翻各分类筛选页才能建立映射，
 *   而那一步需要过 WAF（当前被限速）。因此这里先用 **slug 关键词推导**，
 *   并在数据里标 `typeSource: 'derived'`，等建立准确映射后改为 'category'。
 *
 * 用法：
 *   node scripts/beautylish-build.js                构建数据（图片已存在则复用）
 *   node scripts/beautylish-build.js --skip-images  只生成数据，不下载图片
 *   node scripts/beautylish-build.js --limit=50     只处理前 50 件（试跑）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIST_FILE = path.join(ROOT, 'data', 'beautylish-list.json');
const BUILD_INPUT_FILE = path.join(ROOT, 'data', 'beautylish-build-input.json');
const OUT_FILE = path.join(ROOT, 'beautylish-data.js');
const ASSET_DIR = path.join(ROOT, 'assets', 'beautylish');
const ASSET_REL = 'assets/beautylish';

const argv = process.argv.slice(2);
const SKIP_IMAGES = argv.includes('--skip-images');
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0) || 0;
/**
 * 起始偏移，配合 --limit 做「分批构建」。
 * 用途：调度器逐批抓取，每批只需构建**本批区间**的商品，
 * 避免每批都重建全部 3025 件（既慢又占内存）。
 */
const OFFSET = Number((argv.find((a) => a.startsWith('--offset=')) || '').split('=')[1] || 0) || 0;

// ---------------------------------------------------------------- 品牌中文化

/** 常见品牌的中文名（该站 104 个品牌，逐个对照；未收录的保留原文） */
const BRAND_ZH = {
  'KITSCH': 'KITSCH',
  'CHARLOTTE TILBURY': 'Charlotte Tilbury',
  'SONIA G.': 'Sonia G.',
  'CHIKUHODO': '竹宝堂',
  'HOURGLASS': 'Hourglass',
  'MYKITCO': 'MyKitCo',
  'JEFFREE STAR COSMETICS': 'Jeffree Star',
  'KOYUDO': '晃佑堂',
  'ANNA SUI': '安娜苏',
  'NATASHA DENONA': 'Natasha Denona',
  'CHANTECAILLE': '香缇卡',
  'GOOD MOLECULES': 'Good Molecules',
  'DR. BARBARA STURM': 'Dr. Barbara Sturm',
  'BY TERRY': 'By Terry',
  'UNITS': 'UNITS',
  'RMS BEAUTY': 'RMS Beauty',
  'SURRATT BEAUTY': 'Surratt Beauty',
  'R+CO': 'R+Co',
  'OMOROVICZA': 'Omorovicza',
  'RAE MORRIS': 'Rae Morris',
  'NUDESTIX': 'Nudestix',
  'PETER THOMAS ROTH': '彼得罗夫',
  'JOUER COSMETICS': 'Jouer',
  'KEVYN AUCOIN': 'Kevyn Aucoin',
  'DANESSA MYRICKS BEAUTY': 'Danessa Myricks',
  'ARTISAN&ARTIST': 'Artisan & Artist',
  'AUGUSTINUS BADER': 'Augustinus Bader',
  'BEAUTYBLENDER': 'beautyblender',
  'BRIOGEO': 'Briogeo',
  'CHRISTOPHE ROBIN': 'Christophe Robin',
  'ALBION': '澳尔滨',
  'ALLIES OF SKIN': 'Allies of Skin',
  'ANASTASIA BEVERLY HILLS': 'Anastasia Beverly Hills',
  'ARDELL': 'Ardell',
  'AURIC COSMETICS': 'Auric',
  'BASIS': 'BASIS',
  'BIOTECBEAUTY': 'BiotechBeauty',
  'BLACK GIRL SUNSCREEN': 'Black Girl Sunscreen',
  'BILLY B': 'Billy B',
  'CHEMIST CONFESSIONS': 'Chemist Confessions',
  'WAYNE GOSS': 'Wayne Goss',
  'VISEART': 'Viseart',
  'MARÍA CATALÁ BEAUTY': 'María Catalá',
  'HOURGLASS COSMETICS': 'Hourglass',
  'SUQQU': 'SUQQU',
  'SHISEIDO': '资生堂',
  'CLÉ DE PEAU BEAUTÉ': 'CPB 肌肤之钥',
  'LAURA MERCIER': '罗拉玛希',
  'BYREDO': 'Byredo',
  'DIPTYQUE': 'Diptyque',
  'FREDERIC MALLE': '馥马尔',
  'LE LABO': 'Le Labo',
  'SENSAI': 'SENSAI',
  'DECORTÉ': '黛珂',
  'THREE': 'THREE',
  'ADDICTION': 'ADDICTION',
  'RMK': 'RMK',
  'LUNASOL': 'LUNASOL',
  'KANEBO': '嘉娜宝',
  'POLA': 'POLA',
  'TATCHA': 'Tatcha',
  'WESTMAN ATELIER': 'Westman Atelier',
  'PAT MCGRATH LABS': 'Pat McGrath',
  'VICTORIA BECKHAM BEAUTY': 'Victoria Beckham Beauty',
  'RODIN OLIO LUSSO': 'Rodin',
  'LA MER': '海蓝之谜',
  'ESTÉE LAUDER': '雅诗兰黛',
  'BOBBI BROWN': '芭比波朗',
  'MAC': 'MAC',
  'NARS': 'NARS',
  'DIOR': '迪奥',
  'CHANEL': '香奈儿',
  'GUERLAIN': '娇兰',
  'YSL': '圣罗兰',
  'LANCÔME': '兰蔻',
  'CLARINS': '娇韵诗',
  'SISLEY': '希思黎',
  'SK-II': 'SK-II',
};

const brandZh = (en) => BRAND_ZH[String(en || '').trim().toUpperCase()] || String(en || '').trim();

// ---------------------------------------------------------------- 品类推导

/**
 * 由 slug 关键词推导品类。**这是权宜之计**：准确品类要翻该站分类筛选页建立映射，
 * 而那一步需要过 WAF。顺序即优先级（先匹配到的赢）。
 */
const CATEGORY_RULES = [
  ['刷具', /brush|blender|sponge|puff|applicator/],
  ['刷具清洁', /brush.?clean|cleanser.*brush/],
  ['眼妆', /\beye|eyeshadow|eyeliner|mascara|lash|brow|shadow/],
  ['唇妆', /\blip|lipstick|gloss|liner.*lip/],
  ['底妆', /foundation|concealer|powder|primer|bb.?cream|cc.?cream|tint/],
  ['腮红修容', /blush|bronzer|contour|highlight/],
  ['彩妆盘', /palette|\bkit\b|set/],
  ['洁面', /cleanser|cleansing|face.?wash|foam|micellar/],
  ['精华', /serum|essence|ampoule|booster/],
  ['面霜乳液', /cream|lotion|moisturi|emulsion/],
  ['面膜', /mask|patch|peel|sheet/],
  ['防晒', /sunscreen|spf|sun.?care/],
  ['爽肤水', /toner|mist|water/],
  ['眼霜', /eye.?cream|eye.?gel/],
  ['精油', /\boil\b/],
  ['洗发护发', /shampoo|conditioner|hair.?mask|scalp/],
  ['造型', /hair.?spray|styling|pomade|wax|serum.*hair/],
  ['香水', /perfume|fragrance|cologne|eau.?de/],
  ['身体护理', /body|hand|foot|bath|scrub/],
  ['美甲', /nail|polish/],
  ['美容工具', /tweezer|scissor|mirror|curler|tool|case|bag|pouch|comb/],
  ['健康', /supplement|vitamin|wellness/],
];

function derivedCategory(slug) {
  const s = String(slug || '').toLowerCase();
  for (const [zh, re] of CATEGORY_RULES) if (re.test(s)) return zh;
  return '其他';
}

// ---------------------------------------------------------------- 图片

/** 列表页给的是 175×175 缩略图；换尺寸参数即可取更大的图（同一 CDN 路径） */
function biggerImage(u) {
  if (!u) return '';
  let s = String(u).trim();
  if (s.startsWith('//')) s = 'https:' + s;
  return s.replace(/p_\d+x\d+\./, 'p_350x350.');
}

async function download(url, absPath) {
  try { if (fs.existsSync(absPath) && fs.statSync(absPath).size > 800) return 'exists'; } catch { /* ignore */ }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.beautylish.com/' } });
      if (!res.ok) { if (attempt === 3) return 'http ' + res.status; }
      else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 300) { if (attempt === 3) return 'too small'; }
        else {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, buf);
          return 'saved';
        }
      }
    } catch (e) { if (attempt === 3) return 'err ' + e.message; }
    await new Promise((r) => setTimeout(r, 600 * attempt));
  }
  return 'failed';
}

// ---------------------------------------------------------------- 主流程

(async () => {
  if (!fs.existsSync(LIST_FILE)) {
    console.error('缺少 ' + path.relative(ROOT, LIST_FILE) + '，请先跑：node scripts/beautylish-scrape.js --list');
    process.exit(1);
  }
  const list = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  let items = list.items;
  if (LIMIT || OFFSET) items = items.slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined);
  console.log('枚举输入：' + list.count + ' 件（本次处理 ' + items.length
    + (OFFSET ? '，从第 ' + (OFFSET + 1) + ' 件开始' : '') + '）');
  console.log('站点声明总数：' + list.declaredTotal + '，枚举页 ' + list.fetchedPages + '/' + list.lastPage);

  fs.mkdirSync(ASSET_DIR, { recursive: true });

  // 中文译文（beautylish-translate.js 产出）。没有也能构建，只是内容为英文。
  const buildInput = (() => {
    try { return JSON.parse(fs.readFileSync(BUILD_INPUT_FILE, 'utf8')); } catch { return {}; }
  })();
  const zhCount = Object.keys(buildInput.details || {}).length;
  console.log('中文译文：' + zhCount + ' 件详情、' + Object.keys(buildInput.variantNotes || {}).length + ' 条规格');

  // 详情样本（可选）：有则并入长描述
  const enPath = path.join(ROOT, 'data', 'beautylish-en.json');
  const detailBySlug = new Map();
  if (fs.existsSync(enPath)) {
    try {
      const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
      for (const p of en.products || []) detailBySlug.set(p.slug, p);
      if (detailBySlug.size) console.log('并入详情样本：' + detailBySlug.size + ' 件');
    } catch { /* 忽略损坏的样本 */ }
  }

  const products = [];
  const imgStats = { saved: 0, exists: 0, fail: 0 };
  let done = 0;

  for (const it of items) {
    const brandZhName = brandZh(it.brand);
    // 注意：it.name 是短名（如 "FLARUNÉ Bright Charger"），
    // it.fullNameEn 才是带品牌的（"Albion FLARUNÉ Bright Charger"）。
    // 用 fullName 会变成「澳尔滨 澳尔滨 …」，所以这里用短名。
    const title = brandZhName && it.name ? brandZhName + ' ' + it.name : (it.name || it.slug);

    // 图片
    let images = [];
    if (!SKIP_IMAGES) {
      const remote = biggerImage(it.img);
      if (remote) {
        const rel = ASSET_REL + '/' + it.slug + '-1.jpg';
        const st = await download(remote, path.join(ROOT, rel.split('/').join(path.sep)));
        if (st === 'saved') { images.push(rel); imgStats.saved++; }
        else if (st === 'exists') { images.push(rel); imgStats.exists++; }
        else imgStats.fail++;
      }
    } else {
      const rel = ASSET_REL + '/' + it.slug + '-1.jpg';
      if (fs.existsSync(path.join(ROOT, rel.split('/').join(path.sep)))) images.push(rel);
    }

    const detail = detailBySlug.get(it.slug);
    const sections = (detail && detail.sectionsEn) || {};
    // 描述优先级（实测教训）：
    //   1) JSON-LD 的 description —— **可靠**，原子字段，不受 DOM 注水影响；
    //   2) 渲染区 .markdown_content（sections）—— 内容更长，但该站在被限速/降级响应时
    //      会出现**字形丢失**（实测整段里的字母 s 全部消失："i an inten ive … erum"），
    //      因此只在没有 1) 时使用。
    const ldDesc = (detail && detail.ldDescription) || '';
    const mdDesc = sections['Product Description'] || '';
    const looksCorrupt = (text) => {
      const t = String(text || '');
      if (t.length < 80) return false;
      // 判据：正常英文里 s 占比约 4%~8%；若长文本里 s 极少，视为字形丢失
      const letters = (t.match(/[a-zA-Z]/g) || []).length;
      const sCount = (t.match(/s/g) || []).length;
      return letters > 60 && sCount / letters < 0.015;
    };
    const longDesc = ldDesc || mdDesc;
    const longDescCorrupt = looksCorrupt(longDesc);
    const category = derivedCategory(it.slug);

    // 中文译文（由 beautylish-translate.js 产出）：
    //   buildInput.details[slug]      → 中文长描述
    //   buildInput.variantNotes[英文]  → 中文规格文案
    // 有译文就用译文；没有则保留英文原文（抓取尚未覆盖到的商品）。
    const variantNoteEn = it.optionsText || '';
    const zhDetail = String((buildInput.details || {})[it.slug] || '').trim();
    const variantZh = variantNoteEn ? String((buildInput.variantNotes || {})[variantNoteEn] || '').trim() : '';

    // 清理源站文本里的 markdown 残留与小标题重复：
    //   - 短描述常以 "#####About XXX" 开头（源站把小标题写成 markdown）；
    //   - 描述常以商品全名开头（如 "Albion Flora Drip S and Dispenser Bundle Experience…"），
    //     而标题已含品牌与名称，这里要把重复的前缀去掉。
    const stripDuplicateName = (s) => {
      let t = String(s || '');
      const full = String((detail && detail.fullNameEn) || '').trim();
      const short = String(it.name || '').trim();
      for (const cand of [full, short]) {
        if (!cand) continue;
        const esc = cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp('^\\s*(?:' + esc + ')\\b[\\s:：-]*', 'i'), '');
      }
      return t;
    };
    const cleanText = (s) => stripDuplicateName(String(s || ''))
      .replace(/#{2,}\s*About\s+/gi, '')
      .replace(/#{2,}\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const shortDesc = cleanText(detail && detail.shortDescEn);
    const longClean = cleanText(longDesc);

    /**
     * 中文译文的收尾清理（译文本身没问题，是源文带的痕迹）：
     *   - 源文里常以商品全名开头（JSON-LD 的 description 就是这样），译文会照搬，
     *     而标题已含品牌与名称 → 去掉重复前缀；
     *   - 源文里有 markdown 链接（`[Flora Drip 160](https://…)`），
     *     译文保留了这个语法 → 转成纯文本或干净的超链接。
     */
    const cleanZh = (s) => {
      let t = String(s || '').replace(/\s+/g, ' ').trim();
      // 去掉重复的商品全名/短名前缀（英文原文形式出现在译文开头）
      const full = String((detail && detail.fullNameEn) || '').trim();
      const short = String(it.name || '').trim();
      for (const cand of [full, short]) {
        if (!cand) continue;
        const esc = cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp('^\\s*(?:' + esc + ')\\b[\\s:：-]*', 'i'), '');
      }
      // markdown 链接 → 纯文本（保留文字）+ 去掉行内的裸 URL
      t = t.replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/g, '$1');
      t = t.replace(/\((?:https?:\/\/)[^)]*\)/g, '');
      t = t.replace(/https?:\/\/\S+/g, '');
      return t.replace(/\s+/g, ' ').trim();
    };
    const zhDetailClean = cleanZh(zhDetail);

    // 展示用文案：有中文译文就用中文，否则退回英文原文
    const variantNote = variantZh || variantNoteEn;
    const descZh = zhDetailClean || shortDesc || longClean || brandZhName;
    const detailZh = zhDetailClean || longClean || variantNoteEn;

    products.push({
      title,
      type: category,
      categories: [category, brandZhName].filter(Boolean),
      brand: brandZhName,
      price: it.priceText || '价格待确认',
      variantNote,
      // desc 只放描述本身。规格由 variantNote 单独展示，
      // 否则卡片上会出现两遍同样的字（实测 821 件重复）。
      desc: descZh.slice(0, 300),
      detail: detailZh.slice(0, 1200),
      detailHtml: zhDetailClean
        ? '<p>' + zhDetailClean.replace(/</g, '&lt;').replace(/(?<=[。！？!?])\s*/g, '</p><p>') + '</p>'
        : (longClean && !longDescCorrupt
          ? '<p>' + longClean.replace(/</g, '&lt;').replace(/(?<=[.!?。])\s+/g, '</p><p>') + '</p>'
          : ''),
      // 中间产物字段：供排查与后续重译
      descLongEn: longClean.slice(0, 4000),
      descCorrupt: longDescCorrupt,
      translated: Boolean(zhDetail),
      sku: (detail && detail.sku) || '',
      image: images[0] || '',
      images,
      handle: 'beautylish-' + it.slug,
      typeSource: 'derived',
      sourceUrl: 'https://www.beautylish.com/p/' + it.slug,
    });

    done++;
    if (done % 100 === 0 || done === items.length) {
      console.log('  处理 ' + done + '/' + items.length + '（图 saved ' + imgStats.saved + '，exists ' + imgStats.exists + '，失败 ' + imgStats.fail + '）');
    }
  }

  const header = 'window.PRODUCTS = ';
  const tmp = OUT_FILE + '.tmp';
  fs.writeFileSync(tmp, header + JSON.stringify(products, null, 2) + ';\n', 'utf8');
  fs.renameSync(tmp, OUT_FILE);

  const noImg = products.filter((p) => !p.images.length).length;
  const noPrice = products.filter((p) => p.price === '价格待确认').length;
  const brands = new Set(products.map((p) => p.brand).filter(Boolean));
  const cats = new Map();
  for (const p of products) cats.set(p.type, (cats.get(p.type) || 0) + 1);

  console.log('\n写出 ' + path.relative(ROOT, OUT_FILE));
  console.log('  商品：' + products.length);
  console.log('  品牌：' + brands.size + ' 个');
  console.log('  品类（slug 推导，待建准确映射）：' + cats.size + ' 个');
  console.log('  ' + [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join('、'));
  console.log('  无图片：' + noImg + '；无价格：' + noPrice);
  console.log('  图片：saved ' + imgStats.saved + '，exists ' + imgStats.exists + '，失败 ' + imgStats.fail);
  console.log('  体积：' + Math.round(fs.statSync(OUT_FILE).size / 1024) + ' KB');
})().catch((err) => {
  console.error('构建失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
