#!/usr/bin/env node
'use strict';
/**
 * Beautylish 阶段三：把枚举 + 详情 + 译文组装成 beautylish-data.js
 *
 * 数据口径：
 *   - title 保留英文（Beautylish 是美国零售商，英文名即正品名）
 *   - brand 用中文（有对照表则译，否则保留原文）
 *   - type/categories 由 slug 推导品类
 *   - desc/detail/detailHtml 用中文译文；未抓到的商品退回英文原文
 *   - price 沿用源站价格（含 CN¥ 符号，为按出口地区显示的原价，不做换算）
 *
 * 用法：
 *   node scripts/beautylish-build.js
 *   node scripts/beautylish-build.js --skip-images   不动图片（仅重建数据）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LIST_FILE = path.join(DATA_DIR, 'beautylish-list.json');
const BUILD_INPUT_FILE = path.join(DATA_DIR, 'beautylish-build-input.json');
const CACHE_DIR = path.join(DATA_DIR, 'beautylish-cache');
/** 已下架商品清单（抓取阶段识别，构建时必须排除，否则会留下空壳卡片） */
const GONE_FILE = path.join(DATA_DIR, 'beautylish-gone.json');
const OUT_FILE = path.join(ROOT, 'beautylish-data.js');
const ASSET_DIR = path.join(ROOT, 'assets', 'beautylish');

const argv = process.argv.slice(2);
const SKIP_IMAGES = argv.includes('--skip-images');

// ---------------------------------------------------------------- 品牌中文名

const BRAND_ZH = {
  'ALBION': '澳尔滨', 'ALLIES OF SKIN': 'Allies of Skin', 'ANASTASIA BEVERLY HILLS': 'Anastasia Beverly Hills',
  'ANNA SUI': '安娜苏', 'ARMANI BEAUTY': '阿玛尼美妆', 'AUGUSTINUS BADER': 'Augustinus Bader',
  'BEAUTYBLENDER': 'Beautyblender', 'BENEFIT COSMETICS': '贝玲妃', 'BOBBI BROWN': '芭比波朗',
  'BUMBLE AND BUMBLE': 'Bumble and bumble', 'BY TERRY': 'By Terry', 'BYREDO': 'Byredo',
  'CHANTECAILLE': '香缇卡', 'CHARLOTTE TILBURY': 'Charlotte Tilbury', 'CHIKUHODO': '竹宝堂',
  'CLARINS': '娇韵诗', 'CLE DE PEAU BEAUTE': '肌肤之钥', 'CLINIQUE': '倩碧',
  'DIOR': '迪奥', 'DR. BARBARA STURM': 'Dr. Barbara Sturm', 'DR. DENNIS GROSS': 'Dr. Dennis Gross',
  'DRUNK ELEPHANT': '醉象', 'ELEMIS': '艾丽美', 'ESTEE LAUDER': '雅诗兰黛',
  'FENTY BEAUTY': 'Fenty Beauty', 'FRESH': '馥蕾诗', 'GOOD MOLECULES': 'Good Molecules',
  'GUCCI': '古驰', 'HOURGLASS': 'Hourglass', 'ILIA': 'Ilia', 'JO MALONE LONDON': '祖玛珑',
  'JEFFREE STAR COSMETICS': 'Jeffree Star', 'KIEHLS': '科颜氏', 'KITSCH': 'KITSCH',
  'KOYUDO': '晃佑堂', 'LANCOME': '兰蔻', 'LA MER': '海蓝之谜', 'LAURA MERCIER': '罗拉玛希',
  'MAC': '魅可', 'MAKE UP FOR EVER': '玫珂菲', 'MARC JACOBS BEAUTY': 'Marc Jacobs Beauty',
  'MILK MAKEUP': 'Milk Makeup', 'MOROCCANOIL': '摩洛哥油', 'MYKITCO': 'MyKitCo',
  'NARS': '纳斯', 'NATASHA DENONA': 'Natasha Denona', 'OLEHENRIKSEN': 'Ole Henriksen',
  'OLAPLEX': 'Olaplex', 'ORIBE': 'Oribe', 'PAT MCGRATH LABS': 'Pat McGrath Labs',
  'PAULA\'S CHOICE': '宝拉珍选', 'RMS BEAUTY': 'RMS Beauty', 'R+CO': 'R+Co',
  'SHISEIDO': '资生堂', 'SHU UEMURA': '植村秀', 'SISLEY PARIS': '希思黎',
  'SK-II': 'SK-II', 'SONIA G.': 'Sonia G.', 'SUNDAY RILEY': 'Sunday Riley',
  'SURRATT BEAUTY': 'Surratt Beauty', 'TATCHA': 'Tatcha', 'THE ORDINARY': 'The Ordinary',
  'TOM FORD': '汤姆福特', 'TOO FACED': 'Too Faced', 'UNITS': 'UNITS',
  'URBAN DECAY': '衰败城市', 'WESTMAN ATELIER': 'Westman Atelier', 'YSL': '圣罗兰',
  'YVES SAINT LAURENT': '圣罗兰', 'ZELENS': 'Zelens',
};

function brandZh(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const up = s.toUpperCase();
  if (BRAND_ZH[up]) return BRAND_ZH[up];
  // 标题式大小写：把全大写品牌名转成「首字母大写」
  if (s === up && /^[A-Z0-9 .&'+-]+$/.test(s)) {
    return s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
  }
  return s;
}

// ---------------------------------------------------------------- 品类推导

/**
 * 由 slug 推导品类。
 * 这是**临时方案**——站点按 tag 的真实分类需要访问分类筛选页才能建准映射，
 * 因此这里用关键词启发式，`typeSource` 标记为 'derived' 以便日后替换。
 */
const CATEGORY_RULES = [
  [/brush|blender|sponge|applicator|puff|curler|tweezer|scissor|mirror|tool/i, '美容工具'],
  [/palette/i, '彩妆盘'],
  [/lip|gloss|lipliner|lipstick|balm/i, '唇妆'],
  [/mascara|eyeliner|eyeshadow|brow|lash|eye-?pencil|kohl/i, '眼妆'],
  [/blush|bronzer|contour|highlight|cheek/i, '腮红修容'],
  [/foundation|concealer|primer|setting-?powder|powder|bb-?cream|cc-?cream|tint/i, '底妆'],
  [/cleanser|cleansing|face-?wash|micellar/i, '洁面'],
  [/serum|essence|ampoule|booster|retinol|peptide|niacinamide|vitamin-?c/i, '精华'],
  [/moistur|cream|emulsion|lotion|balm|oil/i, '面霜乳液'],
  [/mask|peel|exfoli|scrub/i, '面膜'],
  [/sunscreen|spf|sun-?care|uv/i, '防晒'],
  [/toner|mist|water/i, '爽肤水'],
  [/eye-?cream|eye-?gel|eye-?serum/i, '眼霜'],
  [/shampoo|conditioner|hair-?mask|hair-?oil|scalp|hair-?care/i, '洗发护发'],
  [/styler|styling|hairspray|curl|straighten/i, '造型'],
  [/fragrance|perfume|eau-?de|cologne|scent/i, '香水'],
  [/body|hand|foot|bath|shower|soap/i, '身体护理'],
  [/nail|manicure|pedicure|polish/i, '美甲'],
  [/supplement|vitamin-?gummy|collagen|wellness|sleep|probiotic/i, '健康'],
  [/perfume|solid/i, '香水'],
];

function derivedCategory(slug) {
  const s = String(slug || '');
  for (const [re, cat] of CATEGORY_RULES) if (re.test(s)) return cat;
  return '其他';
}

// ---------------------------------------------------------------- 图片

function biggerImage(url) {
  // 列表页给的是 p_175x175 之类的缩略图，换成更大尺寸
  return String(url || '').replace(/p_\d+x\d+/, 'p_350x350');
}

// ---------------------------------------------------------------- 主流程

function main() {
  console.log('Beautylish 构建 · 阶段三');

  if (!fs.existsSync(LIST_FILE)) { console.error('缺少 ' + path.relative(ROOT, LIST_FILE)); process.exit(1); }
  const list = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  const buildInput = (() => { try { return JSON.parse(fs.readFileSync(BUILD_INPUT_FILE, 'utf8')); } catch { return {}; } })();
  const zhDetails = buildInput.details || {};
  const zhVariants = buildInput.variantNotes || {};
  console.log('  枚举商品：' + list.items.length);
  console.log('  中文译文：' + Object.keys(zhDetails).length + ' 件详情、' + Object.keys(zhVariants).length + ' 条规格');

  // 详情缓存（增量记录；beautylish-en.json 是收尾才写，中途会缺）
  const detailBySlug = new Map();
  if (fs.existsSync(CACHE_DIR)) {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!/\.json$/.test(f)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
        if (rec && rec.slug) detailBySlug.set(rec.slug, rec);
      } catch { /* 跳过坏文件 */ }
    }
  }
  console.log('  详情缓存：' + detailBySlug.size + ' 件');

  /**
   * 权威品牌清单——从**已抓到详情**的商品里取 JSON-LD 的真实品牌名。
   * 用途：给尚未抓到详情的商品做品牌兜底匹配（卡片文本的品牌是全大写，
   * 直接正则只能截到第一个单词）。按长度倒序，保证"GOOD MOLECULES"
   * 先于"GOOD"被匹配到。
   */
  const knownBrands = [...new Set(
    [...detailBySlug.values()]
      .map((r) => (r.product && r.product.brand ? String(r.product.brand.name || r.product.brand) : '').trim())
      .filter((b) => b.length >= 2)
  )].sort((a, b) => b.length - a.length);
  console.log('  权威品牌清单：' + knownBrands.length + ' 个（用于未抓详情商品的兜底）');

  const products = [];
  let translatedCount = 0;

  /**
   * 已下架商品清单：必须从目录中排除。
   *
   * 为什么：这些 slug 在枚举时还存在于列表页，但商品页已 302 到品牌页
   * （抓取阶段识别并记入 beautylish-gone.json）。如果不排除，它们会以
   * **空壳卡片**的形式出现在目录里——没有图片、没有描述，点开也没有内容。
   * 实测有 51 件这样的空壳商品混在 3095 件里。
   */
  const goneSet = (() => {
    try { return new Set(JSON.parse(fs.readFileSync(GONE_FILE, 'utf8'))); } catch { return new Set(); }
  })();
  console.log('  已下架（排除）：' + goneSet.size + ' 件');

  let skippedGone = 0;
  for (const it of list.items) {
    if (goneSet.has(it.slug)) { skippedGone++; continue; }
    const rec = detailBySlug.get(it.slug) || null;
    const prod = (rec && rec.product) || {};
    const offer = (rec && rec.offer) || {};

    // 标题：优先 JSON-LD 的 name，其次卡片文本
    let title = String(prod.name || '').trim();
    if (!title) {
      // 卡片文本形如 "BRAND Name CN¥45 3 Options Available / 4505"
      let t = String(it.cardText || '').split(/CN¥|¥|\$/)[0].trim();
      const m = t.match(/^([A-Z0-9 .&'+-]{2,})\s+(.+)$/);
      if (m) t = m[2].trim();
      title = t || it.slug;
    }

    const brandRaw = String(prod.brand ? (prod.brand.name || prod.brand) : '').trim()
      || (String(it.cardText || '').match(/^([A-Z0-9 .&'+-]{2,}?)\s+(?=[A-Z][a-z])/) || [])[1]
      || '';
    // 兜底：用**已抓到的权威品牌名**做前缀匹配。
    // 卡片文本的品牌是全大写（"GOOD MOLECULES"），而 JSON-LD 是标题式（"Good Molecules"），
    // 直接正则只能截到第一个单词（→ "GOOD"），因此优先查权威清单。
    // 注意按长度倒序，避免 "GOOD" 抢在 "GOOD MOLECULES" 前面匹配。
    let brand = '';
    if (brandRaw) {
      brand = brandZh(brandRaw);
    } else {
      const up = String(it.cardText || '').toUpperCase();
      for (const known of knownBrands) {
        if (up.startsWith(known.toUpperCase() + ' ')) { brand = brandZh(known); break; }
      }
    }
    if (!brand) brand = '其他品牌';

    const category = derivedCategory(it.slug);
    const variantNoteEn = String(it.optionsText || '').trim();
    const variantNote = zhVariants[variantNoteEn] || variantNoteEn;

    const zhDetailRaw = String(zhDetails[it.slug] || '').trim();

    /**
     * 译后清理（译文本身没问题，是**源文带的痕迹**被翻了出来）：
     *
     * 源文正文常以 "About <商品名>" 开头（站点的正文小标题），译文就成了
     * 「关于 <品牌> <商品名> 使用这款…」——标题里已有品牌与商品名，这段重复很啰嗦。
     *
     * 不能用英文商品名去匹配：译者会把商品名**意译成中文**
     * （"关于 Good Molecules 紧致胜肽眼霜 …"），英文前缀根本匹配不上。
     * 因此改为「从『关于/About』开始，一直剥到正文起句词为止」——
     * 正文起句基本都以「使用/采用/这款/一款/以/为/既是/源自」等开头。
     */
    const zhDetail = (() => {
      let t = zhDetailRaw;
      const starters = '使用|采用|这款|一款|以|为|既是|源自|专为|适合|蕴含|富含|打造|带来|旨在|帮助|通过|结合|借助|凭借|能让|可让|赋予|提供|呈现|融合|含有';

      // 第一刀：「关于 … 起句词」，中间不含标点，避免吃掉正文
      t = t.replace(new RegExp('^\\s*(?:关于|關於|About)\\s*[^。，,.;；]{0,60}?\\s*(?=' + starters + ')', 'i'), '');

      /**
       * 第二刀：处理最常见残留「关于 X X 是…」——商品名被说了两遍
       *   （源文是 "About <Name> <Name> is a …"，译者也照译了两遍）。
       *
       * ⚠️ 这里不能用「去掉『关于』+ 后面固定 N 字」的写法：
       *    那样会切掉正文开头（实测出现 "% Azelaic Acid Treatment 滋润…"
       *    "Ière Étendu 捕捉…" "Detox 是一款…" 这类把商品名截断的坏结果）。
       * 正确做法是**只认真正的重复**：捕获一段文本，再找它自己紧接着再次出现，
       *    从第二次出现处截断。名称里包含数字/符号（10%、™、É）也能处理。
       */
      {
        const m = t.match(/^\s*(?:关于|關於|About)\s+([\s\S]{6,90}?)(?=\s)\1/);
        if (m) {
          // 保护：商品名基本是拉丁字母/数字，若"重复片段"里中文超过 6 字，
          // 说明匹配到的是正文本身的重复用词（如 "…超长管状…使用…"），
          // 不是商品名重复，此时不动，避免删掉正文开头。
          const cjk = (m[1].match(/[\u4e00-\u9fff]/g) || []).length;
          const tail = t.slice(m[0].length).replace(/^\s*[。，,.;；:：-]*\s*/, '');
          if (cjk <= 6 && tail.length >= 8) t = tail;
        }
      }

      // 第三刀：仍以「关于 X」开头但后面没有起句词时，只去掉「关于」二字
      t = t.replace(/^\s*(?:关于|關於|About)\s*[:：]?\s*/, '');

      /**
       * 第四刀：开头重复商品名（**半译**形态）。
       *   译者有时把品牌名留英文、商品名译成中文，于是开头成了
       *   "Good Molecules 马黛茶醒肤眼凝胶 用这款来自 Good Molecules 的舒缓眼凝胶…" ——
       *   商品名被说了两遍（一遍中文一遍英文），前面的去重逻辑认不出来。
       * 处理：若开头是「品牌名 + 中文短语」，且这句短语之后紧接着又出现同一品牌名，
       *       就把开头这段（品牌+中文短语）去掉，从后面的正文接起。
       */
      {
        const m = t.match(/^([A-Za-z][A-Za-z0-9&'’.\- ]{1,30})\s+([\u4e00-\u9fff][^，。；]{0,40}?)\s+(?=[\s\S]*\1)/);
        if (m) {
          const brand = m[1].trim();
          const rest = t.slice(m[0].length);
          // rest 里确实还有一次该品牌名，且剩余正文够长，才敢截
          if (rest.length >= 20 && rest.toUpperCase().includes(brand.toUpperCase())) {
            t = rest.replace(/^\s*[。，,.;；:：-]*\s*/, '');
          }
        }
      }

      // 仍然只剩「关于 X」而后面没有起句词时，整段去掉这个小标题
      t = t.replace(/^\s*(?:关于|關於|About)\s*[^。，,.;；]{0,60}?[。，,.;；]\s*/, '');

      // 开头的孤立系动词
      t = t.replace(/^\s*(?:是一款|是一个)\s*/, '一款');
      t = t.replace(/^\s*(?:是|为)\s*(?=[\u4e00-\u9fff])/, '');
      t = t.replace(/^([a-z])/, (m2) => m2.toUpperCase());
      return t.trim();
    })();
    if (zhDetail) translatedCount++;

    // 价格：JSON-LD 优先，其次卡片
    let price = '';
    if (offer.price != null) {
      const cur = offer.priceCurrency === 'CNY' ? 'CN¥' : (offer.priceCurrency || '');
      price = cur + offer.price;
    } else if (it.priceText) {
      price = it.priceText;
    }
    if (!price) price = '价格待确认';

    // 图片：由 scripts/beautylish-images.js 按固定命名下载到
    //   assets/beautylish/<slug>-1.<ext>
    // 详情缓存里存的是 **JSON-LD 的远程 URL**（product.image），
    // 并没有本地路径字段，所以这里按约定拼路径并确认文件真实存在。
    const images = [];
    {
      const prod2 = rec && rec.product ? rec.product : {};
      const raw = Array.isArray(prod2.image) ? prod2.image : (prod2.image ? [prod2.image] : []);
      const first = raw.find((u) => /^https?:/i.test(u)) || '';
      const ext = (String(first).match(/\.(jpe?g|png|gif|webp|avif)(?:\?|$)/i) || [])[1];
      if (ext) {
        const rel = 'assets/beautylish/' + it.slug + '-1.' + ext.toLowerCase().replace('jpeg', 'jpg');
        if (fs.existsSync(path.join(ROOT, rel.split('/').join(path.sep)))) images.push(rel);
      }
      // 兼容：若缓存里带了本地路径（早期版本），一并采用
      if (Array.isArray(rec && rec.images)) {
        for (const r of rec.images) if (r && !images.includes(r)) images.push(r);
      }
    }

    const descZh = zhDetail || variantNote || brand;
    products.push({
      title,
      type: category,
      categories: [category, brand].filter(Boolean),
      brand,
      price,
      variantNote,
      desc: descZh.slice(0, 300),
      // 详情正文上限放宽到 3000：Beautylish 的 Product Description 区块
      // 实测中位约 1024 字符、最长可达 3040，原来卡在 1200 会把长正文截断
      // （而这段完整正文才是商品页最有价值的内容）。
      detail: (zhDetail || variantNote).slice(0, 3000),
      detailHtml: zhDetail ? '<p>' + zhDetail.replace(/</g, '&lt;') + '</p>' : '',
      sku: prod.sku || '',
      image: images[0] || '',
      images,
      handle: 'beautylish-' + it.slug,
      typeSource: 'derived',
      translated: Boolean(zhDetail),
      sourceUrl: (rec && rec.url) || ('https://www.beautylish.com/p/' + it.slug),
    });
  }

  const js = '/* Beautylish 商品数据 · 由 scripts/beautylish-build.js 生成 */\n'
    + 'window.PRODUCTS = ' + JSON.stringify(products) + ';\n';
  fs.writeFileSync(OUT_FILE, js, 'utf8');

  const byType = {};
  for (const p of products) byType[p.type] = (byType[p.type] || 0) + 1;

  console.log('\n写出 ' + path.relative(ROOT, OUT_FILE));
  console.log('  商品：' + products.length);
  console.log('  品牌：' + new Set(products.map((p) => p.brand)).size + ' 个');
  console.log('  品类：' + Object.keys(byType).length + ' 个');
  console.log('  ' + Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join('、'));
  console.log('  已翻译详情：' + translatedCount + ' 件');
  console.log('  无图片：' + products.filter((p) => !p.image).length);
  console.log('  体积：' + (fs.statSync(OUT_FILE).size / 1024).toFixed(0) + ' KB');
}

main();
