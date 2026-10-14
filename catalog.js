/**
 * 商品目录前端逻辑（6 个品牌模块共用）
 *
 * 设计约定：**新增能力一律「数据里有才启用」**，保证老模块不受影响。
 *   - product.brand 存在      → 卡片与详情显示品牌；页面若带 #catalogBrand 则出现「按品牌筛选」
 *   - product.price 含货币符号 → 原样显示（如 CN¥528），不做任何换算
 *   - product.variantNote 存在 → 详情里显示规格说明（如 25 Shades Available）
 */
const state = { shown: 0, pageSize: 48, keyword: '', type: '全部', brand: '全部' };
const els = {
  grid: document.querySelector('#catalogGrid'),
  count: document.querySelector('#catalogCount'),
  search: document.querySelector('#catalogSearch'),
  type: document.querySelector('#catalogType'),
  brand: document.querySelector('#catalogBrand'),
  brandWrap: document.querySelector('#catalogBrandWrap'),
  more: document.querySelector('#loadMore'),
  modal: document.querySelector('#productModal'),
  modalBody: document.querySelector('#modalBody'),
  modalClose: document.querySelector('#modalClose'),
};
function normalize(text){ return String(text || '').toLowerCase().replace(/\s+/g, ''); }
function escapeHtml(text){ return String(text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
function productMatches(product){
  const q = normalize(state.keyword);
  const byType = state.type === '全部' || product.type === state.type;
  // 品牌筛选只在数据带 brand 时生效（老模块没有该字段，恒为「全部」）
  const byBrand = state.brand === '全部' || !product.brand || product.brand === state.brand;
  if (!q) return byType && byBrand;
  // categories 是可选字段（源站分类多对多时，type 只放主分类）。
  // brand / variantNote / sku 一并并入搜索范围。
  const categories = Array.isArray(product.categories) ? product.categories.join(' ') : '';
  const haystack = normalize([
    product.title, product.type, categories, product.brand, product.variantNote,
    product.sku, product.price, product.desc, product.detail,
  ].join(' '));
  return byType && byBrand && haystack.includes(q);
}
function filteredProducts(){ return (window.PRODUCTS || []).filter(productMatches); }
function renderTypes(){
  const types = Array.from(new Set((window.PRODUCTS || []).map(p => p.type || '商品'))).sort((a,b)=>a.localeCompare(b,'zh-Hans-CN'));
  els.type.innerHTML = ['全部', ...types].map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
}
/** 品牌下拉：仅当页面提供容器且数据里确有 brand 时才渲染（多品牌模块用） */
function renderBrands(){
  if (!els.brand) return;
  const brands = Array.from(new Set((window.PRODUCTS || []).map(p => p.brand).filter(Boolean)))
    .sort((a,b)=>a.localeCompare(b,'en'));
  if (!brands.length) { if (els.brandWrap) els.brandWrap.hidden = true; return; }
  els.brand.innerHTML = ['全部', ...brands]
    .map(b => `<option value="${escapeHtml(b)}">${b === '全部' ? '全部品牌' : escapeHtml(b)}</option>`).join('');
  if (els.brandWrap) els.brandWrap.hidden = false;
}
function card(product, index){
  const brandLine = product.brand ? `<p class="catalog-brand">${escapeHtml(product.brand)}</p>` : '';
  const variantLine = product.variantNote ? `<p class="catalog-variant">${escapeHtml(product.variantNote)}</p>` : '';
  return `<article class="catalog-card">
    <button class="catalog-image" type="button" data-index="${index}" aria-label="查看 ${escapeHtml(product.title)} 详情">
      <img loading="lazy" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" />
    </button>
    <div class="catalog-body">
      ${brandLine}
      <p class="catalog-type">${escapeHtml(product.type)}</p>
      <h3>${escapeHtml(product.title)}</h3>
      <p class="catalog-price">${escapeHtml(product.price)}</p>
      ${variantLine}
      <p class="catalog-desc">${escapeHtml(product.desc || '暂无简介')}</p>
      <button class="catalog-link" type="button" data-index="${index}">查看商品详情</button>
    </div>
  </article>`;
}
function render(reset=true){
  const list = filteredProducts();
  if (reset) state.shown = 0;
  const nextShown = Math.min(state.shown + state.pageSize, list.length);
  const visible = list.slice(0, nextShown);
  els.grid.innerHTML = visible.map(product => card(product, window.PRODUCTS.indexOf(product))).join('') || '<p class="empty">没有找到匹配商品。</p>';
  state.shown = nextShown;
  els.count.textContent = `共 ${list.length} 个商品，已显示 ${visible.length} 个`;
  els.more.hidden = state.shown >= list.length;
}
function openProduct(index){
  const product = window.PRODUCTS[index];
  if (!product) return;
  const images = (product.images && product.images.length ? product.images : [product.image]).filter(Boolean);
  const brandLine = product.brand ? `<p class="catalog-brand modal-brand">${escapeHtml(product.brand)}</p>` : '';
  const meta = [];
  if (product.variantNote) meta.push(product.variantNote);
  if (product.sku) meta.push('SKU ' + product.sku);
  const metaLine = meta.length ? `<p class="modal-meta">${escapeHtml(meta.join(' · '))}</p>` : '';
  els.modalBody.innerHTML = `<div class="modal-gallery">${images.map(src=>`<img src="${escapeHtml(src)}" alt="${escapeHtml(product.title)}" />`).join('')}</div>
    <div class="modal-info">
      ${brandLine}
      <p class="catalog-type">${escapeHtml(product.type)}</p>
      <h2>${escapeHtml(product.title)}</h2>
      <p class="catalog-price modal-price">${escapeHtml(product.price)}</p>
      ${metaLine}
      <div class="modal-detail">${product.detailHtml || escapeHtml(product.detail || product.desc || '暂无中文详情。').split('\n').map(line=>`<p>${line}</p>`).join('')}</div>
    </div>`;
  els.modal.removeAttribute('hidden');
  document.body.classList.add('modal-open');
  els.modalClose.focus();
}
function closeProduct(){ els.modal.setAttribute('hidden',''); document.body.classList.remove('modal-open'); }
els.search.addEventListener('input', e => { state.keyword = e.target.value; render(true); });
els.type.addEventListener('change', e => { state.type = e.target.value; render(true); });
if (els.brand) els.brand.addEventListener('change', e => { state.brand = e.target.value; render(true); });
els.more.addEventListener('click', () => render(false));
els.grid.addEventListener('click', e => { const btn = e.target.closest('[data-index]'); if (btn) openProduct(Number(btn.dataset.index)); });
els.modalClose.addEventListener('click', closeProduct);
els.modal.addEventListener('click', e => { if (e.target === els.modal) closeProduct(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape' && !els.modal.hasAttribute('hidden')) closeProduct(); });
renderTypes(); renderBrands(); render(true);
