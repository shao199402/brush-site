'use strict';
/**
 * 各品牌「取价」适配器
 *
 * 设计原则：
 *   1) 每个品牌的取价正则/选择器**原样搬自对应的 *-scrape.js**，
 *      不重新发明——那些选择器是实测定下来的（例如晃佑堂必须用
 *      `data-id="makeshop-item-price:N"`，全页抓 ￥ 会把 UI 图标的价格混进来）。
 *   2) 只取价格，不取描述/图片/分类，所以走**纯 HTTP**（无需浏览器），
 *      比完整抓取快一个数量级。
 *   3) 统一输出归一化数值 `yen`（日元整数），便于跨品牌比较；
 *      同时保留 `raw`（原始显示文本）用于报告展示。
 *
 * 价格归一化规则（各站原始格式不同）：
 *   白凤堂 Shopify : variants[0].price = "8800"（单位日元）
 *   晃佑堂/竹田/熊永堂/永丰堂/竹宝堂 : "13,750 日元（含税）"
 *   Beautylish     : "CN¥45"（人民币，不做汇率换算，独立比较）
 */

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en;q=0.9',
};

async function fetchText(url, { tries = 3, timeout = 30000 } = {}) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (i < tries) await new Promise((res) => setTimeout(res, 1200 * i));
    }
  }
  throw new Error(lastErr ? lastErr.message : '未知错误');
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
const decodeEntities = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

/** 从 HTML 里取指定 class 的标签内部（简化版，只用于取价） */
function innerByClass(html, tag, cls) {
  const re = new RegExp('<' + tag + '\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = re.exec(html);
  return m ? m[1] : '';
}

/** 把带逗号的数字串转成整数 */
function toInt(s) {
  const n = Number(String(s || '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ───────────────────────── 白凤堂（Shopify）─────────────────────────

/**
 * 白凤堂是 Shopify 站，直接走 /products.json 拿全量（每页上限 250）。
 * 这是所有品牌里唯一有完整商品 JSON 接口的，1070 件只需 5 个请求。
 */
async function fetchHakuho() {
  const out = new Map();
  for (let page = 1; page <= 30; page++) {
    const txt = await fetchText('https://hakuho-do.co.jp/products.json?limit=250&page=' + page);
    const j = JSON.parse(txt);
    if (!j.products || j.products.length === 0) break;
    for (const p of j.products) {
      const v = (p.variants && p.variants[0]) || {};
      const price = toInt(v.price);
      if (!price) continue;
      out.set(String(p.handle).toLowerCase(), {
        raw: price.toLocaleString('en-US') + ' 日元（含税）',
        yen: price,
        currency: 'JPY',
        title: p.title,
      });
    }
    if (j.products.length < 250) break;
  }
  return out;
}

// ───────────────────────── 晃佑堂（MakeShop）─────────────────────────

/**
 * 晃佑堂 price 取值：`data-id="makeshop-item-price:N"`。
 * （搬自 koyudo-scrape.js 的 extractPrice —— 全页匹配 ￥ 会抓到无关价格）
 */
const KOYUDO_PRICE_RE = [
  /data-id=(?:"makeshop-item-price:1"|'makeshop-item-price:1')[^>]*>([\d,]+)</i,
  /data-id=(?:"makeshop-item-price:\d+"|'makeshop-item-price:\d+')[^>]*>([\d,]+)</i,
];

function priceKoyudo(html) {
  for (const re of KOYUDO_PRICE_RE) {
    const m = html.match(re);
    if (m) { const n = toInt(m[1]); if (n) return n; }
  }
  return null;
}

// ───────────────────────── 竹田 ─────────────────────────

/** 竹田 price：`span.item-detail-vari-price-num`（搬自 takeda-scrape.js） */
function priceTakeda(html) {
  const inner = innerByClass(html, 'span', 'item-detail-vari-price-num');
  const m = stripTags(inner).replace(/,/g, '').match(/(\d+)/);
  return m ? toInt(m[1]) : null;
}

// ───────────────────────── 熊永堂 ─────────────────────────

/** 熊永堂 price：`#price02_default` 或 `itemprop="price"`（搬自 n8-scrape.js） */
function priceN8(html) {
  const m = html.match(/id=(?:"|')price02_default(?:"|')[^>]*>([\d,]+)</i)
    || html.match(/itemprop=(?:"|')price(?:"|')[^>]*>([\d,]+)</i);
  return m ? toInt(m[1]) : null;
}

// ───────────────────────── 永丰堂 ─────────────────────────

/**
 * 永丰堂 price：`table.style_table02` 里 `tr.price` 的第一个 `<td>`。
 * （搬自 eihodo-scrape.js；退路是全页第一个 ￥ 数字）
 *
 * ⚠️ 售罄商品**没有价格行**（页面出现 soldout 字样、`tr.price` 缺席）。
 * 实测 420 件里有 38 件取不到价，其中相当一部分是售罄而非解析错误。
 * 因此这里返回 { yen } 或 { soldOut: true }，让上层能把「售罄」与
 * 「真的抓取失败」区分开——否则报告里会混进一堆假失败。
 */
function priceEihodoDetail(html) {
  const tbl = innerByClass(html, 'table', 'style_table02');
  const scope = tbl || html;
  const m = scope.match(/<tr[^>]*class=(?:"[^"]*\bprice\b[^"]*"|'[^']*\bprice\b[^']*')[^>]*>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i)
    || scope.match(/([￥¥]\s*[\d,]+)/);
  if (m) {
    const n = toInt(m[1]);
    if (n) return { yen: n };
  }
  // 没有价格 → 看是否售罄
  if (/sold\s*out|soldout|売切|完売|在庫なし/i.test(html)) return { soldOut: true };
  return {};
}

/** 兼容旧接口：只返回价格数字 */
function priceEihodo(html) {
  const r = priceEihodoDetail(html);
  return r.yen || null;
}

// ───────────────────────── 竹宝堂 ─────────────────────────

/** 竹宝堂 price：优先 `div.item_description` 里的 `class="price"`，兜底全页（搬自 chikuhodo-scrape.js） */
function priceChikuhodo(html) {
  const scopes = [];
  const a = innerByClass(html, 'div', 'item_description');
  if (a) scopes.push(a);
  scopes.push(html);
  for (const src of scopes) {
    for (const tag of ['dd', 'td', 'p', 'span', 'div']) {
      const re = new RegExp('<' + tag + '\\b[^>]*class="[^"]*\\bprice\\b[^"]*"[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
      const m = re.exec(src);
      if (!m) continue;
      const num = stripTags(m[1]).match(/([\d,]{3,})/);
      if (num) { const n = toInt(num[1]); if (n) return n; }
    }
  }
  const plain = stripTags(html);
  const m2 = plain.match(/([\d,]{3,})\s*円/);
  return m2 ? toInt(m2[1]) : null;
}

// ───────────────────────── Beautylish（CNY）─────────────────────────

/**
 * Beautylish 的价格在**列表页卡片**里（纯 HTTP 会被 WAF 挡，需要浏览器）。
 *
 * ⚠️ 关键陷阱：卡片价格可能是**区间**，例如
 *     "GOOD MOLECULES Niacinamide Brightening Toner CN¥45 - CN¥330"
 *   这是「最小规格 ~ 最大规格」的价格跨度，不是该商品的单一售价。
 *   如果直接取第一个数（45），再和本地数据里某个具体规格的价格（如 110）比，
 *   会得出一堆假的"降价 60%"。实测 142 项"价格变动"绝大多数是这么来的。
 *
 * 因此这里返回：
 *   - 单一价格 → { cny: 45 }
 *   - 区间价格 → { cnyMin, cnyMax, isRange: true }（上层据此**跳过对比**）
 */
function priceBeautylishCard(cardText) {
  const s = String(cardText || '');
  // 先看是否区间："CN¥45 - CN¥330" / "CN¥45–CN¥330"
  const rng = s.match(/CN¥\s*([\d,]+(?:\.\d+)?)\s*[-–~]\s*CN¥\s*([\d,]+(?:\.\d+)?)/);
  if (rng) {
    const a = Number(String(rng[1]).replace(/,/g, ''));
    const b = Number(String(rng[2]).replace(/,/g, ''));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { cnyMin: Math.min(a, b), cnyMax: Math.max(a, b), isRange: true };
    }
  }
  const m = s.match(/CN¥\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(String(m[1]).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? { cny: n } : null;
}

// ───────────────────────── 汇总导出 ─────────────────────────

const BRANDS = {
  hakuho: {
    label: '白凤堂',
    currency: 'JPY',
    file: 'catalog-data.js',
    /** Shopify：整站一次拿全量 */
    mode: 'shopify',
    fetchAll: fetchHakuho,
  },
  koyudo: {
    label: '晃佑堂',
    currency: 'JPY',
    file: 'koyudo-data.js',
    mode: 'detail',
    urlOf: (handle) => 'https://www.koyudo.co.jp/view/item/' + handle.replace(/^koyudo-/, '') + '?category_page_id=all_items',
    parse: priceKoyudo,
  },
  takeda: {
    label: '竹田',
    currency: 'JPY',
    file: 'takeda-data.js',
    mode: 'detail',
    urlOf: (handle) => 'https://takeda-brush-shop.com/item-detail/' + handle.replace(/^takeda-/, ''),
    parse: priceTakeda,
  },
  n8: {
    label: '熊永堂',
    currency: 'JPY',
    file: 'n8-data.js',
    mode: 'detail',
    urlOf: (handle) => 'https://www.number-8.net/products/detail.php?product_id=' + handle.replace(/^n8-/, ''),
    parse: priceN8,
  },
  eihodo: {
    label: '永丰堂',
    currency: 'JPY',
    file: 'eihodo-data.js',
    mode: 'detail',
    /** handle 形如 eihodo-1295951096-149236，站点用 ?id=整个复合 ID */
    urlOf: (handle) => 'https://www.eihodo.jp/sp/shopping/?id=' + handle.replace(/^eihodo-/, ''),
    parse: priceEihodo,
    /** 详细版解析：能区分「售罄」与「解析失败」 */
    parseDetail: priceEihodoDetail,
  },
  chikuhodo: {
    label: '竹宝堂',
    currency: 'JPY',
    file: 'chikuhodo-data.js',
    mode: 'detail',
    urlOf: (handle) => 'https://www.chikuhodo.com/product/' + handle.replace(/^chikuhodo-/, '') + '.html',
    parse: priceChikuhodo,
  },
  beautylish: {
    label: 'Beautylish',
    currency: 'CNY',
    file: 'beautylish-data.js',
    mode: 'beautylish-list',
  },
};

module.exports = {
  BRANDS,
  fetchText,
  // 供测试与复用
  priceKoyudo, priceTakeda, priceN8, priceEihodo, priceEihodoDetail, priceChikuhodo, priceBeautylishCard,
  fetchHakuho,
};
