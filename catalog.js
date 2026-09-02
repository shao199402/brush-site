const state = { shown: 0, pageSize: 48, keyword: '', type: '全部' };
const els = {
  grid: document.querySelector('#catalogGrid'),
  count: document.querySelector('#catalogCount'),
  search: document.querySelector('#catalogSearch'),
  type: document.querySelector('#catalogType'),
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
  if (!q) return byType;
  const haystack = normalize([product.title, product.type, product.price, product.desc, product.detail].join(' '));
  return byType && haystack.includes(q);
}
function filteredProducts(){ return (window.PRODUCTS || []).filter(productMatches); }
function renderTypes(){
  const types = Array.from(new Set((window.PRODUCTS || []).map(p => p.type || '商品'))).sort((a,b)=>a.localeCompare(b,'zh-Hans-CN'));
  els.type.innerHTML = ['全部', ...types].map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
}
function card(product, index){
  return `<article class="catalog-card">
    <button class="catalog-image" type="button" data-index="${index}" aria-label="查看 ${escapeHtml(product.title)} 详情">
      <img loading="lazy" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" />
    </button>
    <div class="catalog-body">
      <p class="catalog-type">${escapeHtml(product.type)}</p>
      <h3>${escapeHtml(product.title)}</h3>
      <p class="catalog-price">${escapeHtml(product.price)}</p>
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
  els.modalBody.innerHTML = `<div class="modal-gallery">${images.map(src=>`<img src="${escapeHtml(src)}" alt="${escapeHtml(product.title)}" />`).join('')}</div>
    <div class="modal-info">
      <p class="catalog-type">${escapeHtml(product.type)}</p>
      <h2>${escapeHtml(product.title)}</h2>
      <p class="catalog-price modal-price">${escapeHtml(product.price)}</p>
      <div class="modal-detail">${escapeHtml(product.detail || product.desc || '暂无中文详情。').split('\n').map(line=>`<p>${line}</p>`).join('')}</div>
    </div>`;
  els.modal.removeAttribute('hidden');
  document.body.classList.add('modal-open');
  els.modalClose.focus();
}
function closeProduct(){ els.modal.setAttribute('hidden',''); document.body.classList.remove('modal-open'); }
els.search.addEventListener('input', e => { state.keyword = e.target.value; render(true); });
els.type.addEventListener('change', e => { state.type = e.target.value; render(true); });
els.more.addEventListener('click', () => render(false));
els.grid.addEventListener('click', e => { const btn = e.target.closest('[data-index]'); if (btn) openProduct(Number(btn.dataset.index)); });
els.modalClose.addEventListener('click', closeProduct);
els.modal.addEventListener('click', e => { if (e.target === els.modal) closeProduct(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape' && !els.modal.hasAttribute('hidden')) closeProduct(); });
renderTypes(); render(true);
