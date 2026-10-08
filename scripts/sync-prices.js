const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://hakuho-do.co.jp/products.json?limit=250';
const PAGE_LIMIT = 30;
const root = process.cwd();
const catalogPath = path.join(root, 'catalog-data.js');
const reportPath = path.join(root, 'price-changes.json');

function normalizeHandle(value) {
  return String(value || '').trim();
}

function formatYen(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '价格待确认';
  return '￥' + Math.round(n).toLocaleString('en-US') + ' 含税';
}

function priceFromShopifyProduct(product) {
  const prices = (product.variants || [])
    .map(v => Number(v.price))
    .filter(Number.isFinite);
  if (!prices.length) return '价格待确认';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatYen(min) : `${formatYen(min).replace(' 含税', '')}–${formatYen(max)}`;
}

function loadCatalog() {
  const text = fs.readFileSync(catalogPath, 'utf8');
  const match = text.match(/^\s*window\.PRODUCTS\s*=\s*([\s\S]*?);\s*$/);
  if (!match) throw new Error('catalog-data.js format not recognized');
  return JSON.parse(match[1]);
}

function saveCatalog(products) {
  fs.writeFileSync(catalogPath, 'window.PRODUCTS = ' + JSON.stringify(products, null, 2) + ';\n', 'utf8');
}

async function fetchPage(page) {
  const url = `${SOURCE_URL}&page=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; brush-site-price-sync/1.0)',
        'Accept': 'application/json',
        'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.5'
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllProducts() {
  const all = [];
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const data = await fetchPage(page);
    const list = data.products || [];
    all.push(...list);
    console.log(`fetched page ${page}: ${list.length}`);
    if (list.length < 250) break;
  }
  return all;
}

(async () => {
  const catalog = loadCatalog();
  const sourceProducts = await fetchAllProducts();
  const priceByHandle = new Map(
    sourceProducts
      .filter(p => normalizeHandle(p.handle))
      .map(p => [normalizeHandle(p.handle), priceFromShopifyProduct(p)])
  );

  const changes = [];
  for (const item of catalog) {
    const handle = normalizeHandle(item.handle);
    if (!handle || !priceByHandle.has(handle)) continue;
    const nextPrice = priceByHandle.get(handle);
    if (item.price !== nextPrice) {
      changes.push({
        handle,
        title: item.title || handle,
        oldPrice: item.price,
        newPrice: nextPrice
      });
      item.price = nextPrice;
    }
  }

  const report = {
    checkedAt: new Date().toISOString(),
    source: 'https://hakuho-do.co.jp/products.json',
    catalogProducts: catalog.length,
    sourceProducts: sourceProducts.length,
    changedCount: changes.length,
    changes
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (changes.length) {
    saveCatalog(catalog);
    console.log(`Updated ${changes.length} price(s).`);
  } else {
    console.log('No price changes.');
  }
})();
