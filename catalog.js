const state = {
  shown: 0,
  pageSize: 48,
  keyword: '',
  type: '全部',
};

const els = {
  grid: document.querySelector('#catalogGrid'),
  count: document.querySelector('#catalogCount'),
  search: document.querySelector('#catalogSearch'),
  type: document.querySelector('#catalogType'),
  more: document.querySelector('#loadMore'),
};

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function productMatches(product) {
  const q = normalize(state.keyword);
  const byType = state.type === '全部' || product.type === state.type;
  if (!q) return byType;
  const haystack = normalize([product.title, product.originalTitle, product.type, product.price, product.desc].join(' '));
  return byType && haystack.includes(q);
}

function filteredProducts() {
  return (window.PRODUCTS || []).filter(productMatches);
}

function renderTypes() {
  const types = Array.from(new Set((window.PRODUCTS || []).map(p => p.type || '商品'))).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  els.type.innerHTML = ['全部', ...types].map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
}

function card(product) {
  return `
    <article class="catalog-card">
      <a class="catalog-image" href="${escapeHtml(product.url)}" target="_blank" rel="noreferrer">
        <img loading="lazy" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" />
      </a>
      <div class="catalog-body">
        <p class="catalog-type">${escapeHtml(product.type)}</p>
        <h3>${escapeHtml(product.title)}</h3>
        <p class="catalog-price">${escapeHtml(product.price)}</p>
        <p class="catalog-desc">${escapeHtml(product.desc || '暂无简介')}</p>
        <a class="catalog-link" href="${escapeHtml(product.url)}" target="_blank" rel="noreferrer">查看官方页面</a>
      </div>
    </article>`;
}

function render(reset = true) {
  const list = filteredProducts();
  if (reset) state.shown = 0;
  const nextShown = Math.min(state.shown + state.pageSize, list.length);
  const visible = list.slice(0, nextShown);
  els.grid.innerHTML = visible.map(card).join('') || '<p class="empty">没有找到匹配商品。</p>';
  state.shown = nextShown;
  els.count.textContent = `共 ${list.length} 个商品，已显示 ${visible.length} 个`;
  els.more.hidden = state.shown >= list.length;
}

els.search.addEventListener('input', event => {
  state.keyword = event.target.value;
  render(true);
});

els.type.addEventListener('change', event => {
  state.type = event.target.value;
  render(true);
});

els.more.addEventListener('click', () => render(false));

renderTypes();
render(true);
