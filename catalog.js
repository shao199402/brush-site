/**
 * 商品目录前端逻辑（7 个品牌模块共用）
 *
 * 设计约定：**新增能力一律「数据里有才启用」**，保证老模块不受影响。
 *   - product.brand 存在      → 卡片与详情显示品牌；页面若带 #catalogBrand 则出现「按品牌筛选」
 *   - product.price 含货币符号 → 原样显示（如 CN¥528），不做任何换算
 *   - product.variantNote 存在 → 详情里显示规格说明（如 25 Shades Available）
 *   - product.dimensions 存在 → 出现「按分类维度筛选」下拉（系列 / 用途 / 毛质）
 */
const state = { shown: 0, pageSize: 48, keyword: '', type: '全部', brand: '全部', dim: '全部' };
const els = {
  grid: document.querySelector('#catalogGrid'),
  count: document.querySelector('#catalogCount'),
  search: document.querySelector('#catalogSearch'),
  type: document.querySelector('#catalogType'),
  brand: document.querySelector('#catalogBrand'),
  brandWrap: document.querySelector('#catalogBrandWrap'),
  dim: document.querySelector('#catalogDim'),
  dimWrap: document.querySelector('#catalogDimWrap'),
  more: document.querySelector('#loadMore'),
  modal: document.querySelector('#productModal'),
  modalBody: document.querySelector('#modalBody'),
  modalClose: document.querySelector('#modalClose'),
};
function normalize(text){ return String(text || '').toLowerCase().replace(/\s+/g, ''); }
function escapeHtml(text){ return String(text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
/**
 * 一级分类（`level1`）与二级（`dimensions`）
 *
 * 背景：不同品牌的分类颗粒度差别很大。
 *   · 白凤堂：type 就是一级（化妆刷/日本画笔…），站点另有系列/用途/毛质三维 → 二级
 *   · 竹田 / 竹宝堂 / 永丰堂：type 本身已经是「二级」那么细（眼影刷/唇刷/…），
 *     缺的是更粗的一级 → 数据里额外给 `level1`
 *   · 熊永堂：type 是一级（熊野笔/套装…），站点「用途別」是二级
 *
 * 所以一级取值统一走 `product.level1 || product.type`，
 * 卡片上仍显示 `type`（保持信息量），二者可以不同。
 */
function level1Of(product){ return product.level1 || product.type || '商品'; }
/** 把 product.dimensions 拉平成一个值数组（所有维度） */
function dimValuesOf(product){
  const d = product && product.dimensions;
  if (!d || typeof d !== 'object') return [];
  const out = [];
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (Array.isArray(v)) { for (const x of v) if (x) out.push(x); }
    else if (v) out.push(v);
  }
  return out;
}
function productMatches(product){
  const q = normalize(state.keyword);
  const byType = state.type === '全部' || level1Of(product) === state.type;
  // 品牌筛选只在数据带 brand 时生效（老模块没有该字段，恒为「全部」）
  const byBrand = state.brand === '全部' || !product.brand || product.brand === state.brand;
  /*
   * 二级筛选：数据带 dimensions 才生效。
   * `state.dim || '全部'` 这句兜底很重要：把 select 的 value 设成一个
   * 不存在的选项时，浏览器的 value 会变成空字符串 ''，若不兜底，
   * 空值既不等于「全部」也不匹配任何 dimensions，结果就是「共 0 个商品」——
   * 明明什么都没筛却一件都不显示。
   */
  const dimSelected = state.dim || '全部';
  const byDim = dimSelected === '全部' || dimValuesOf(product).indexOf(dimSelected) !== -1;
  if (!q) return byType && byBrand && byDim;
  const categories = Array.isArray(product.categories) ? product.categories.join(' ') : '';
  const haystack = normalize([
    product.title, product.type, product.level1, categories, product.brand, product.variantNote,
    product.sku, product.price, product.desc, product.detail,
  ].join(' '));
  return byType && byBrand && byDim && haystack.includes(q);
}
function filteredProducts(){ return (window.PRODUCTS || []).filter(productMatches); }
function renderTypes(){
  const types = Array.from(new Set((window.PRODUCTS || []).map(level1Of))).sort((a,b)=>a.localeCompare(b,'zh-Hans-CN'));
  els.type.innerHTML = ['全部', ...types].map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
}
/**
 * 二级分类下拉（与一级「品类」**联动**）。
 *
 * 关键设计：二级是**一级的子集**，不是独立的筛选器。
 *   一级选「化妆刷」→ 二级只列出「化妆刷」内部存在的子分类；
 *   一级选「日本画笔」→ 二级换成日本画笔自己的子分类；
 *   一级选「刻名」这类没有子分类的 → 二级整个隐藏。
 * 每项后面的数字是**在该一级下**的商品数（不是全站数），
 * 这样用户不会点进一个空结果。
 *
 * 子分类按三个维度分组（系列 / 用途 / 毛质）——这是源站的组织方式，
 * 同一商品可同时属于三个维度，所以用 optgroup 分组而不是分成三个下拉：
 *     全部（化妆刷）
 *     ── 系列 ──
 *       化妆刷 Selections (70)
 *     ── 用途 ──
 *       眼影（晕染）(157)
 *     ── 毛质 ──
 *       灰松鼠毛 (163)
 *
 * 数据里没有 dimensions 时整个控件隐藏（其余 6 个品牌不受影响）。
 */
const DIM_LABELS = { series: '系列', use: '用途', hair: '毛质', form: '形态', sub: '分类' };
const DIM_KEYS = ['series', 'use', 'hair', 'form', 'sub'];

/** 统计某个一级分类下的二级（key=维度, value=Map(二级 → 件数)） */
function dimBucketsUnder(typeFilter){
  const buckets = {};
  for (const k of DIM_KEYS) buckets[k] = new Map();
  let any = false;
  for (const p of (window.PRODUCTS || [])) {
    // 一级匹配统一走 level1Of（level1 优先，回退 type）
    if (typeFilter !== '全部' && level1Of(p) !== typeFilter) continue;
    const d = p && p.dimensions;
    if (!d || typeof d !== 'object') continue;
    for (const k of Object.keys(d)) {
      const v = d[k];
      const list = Array.isArray(v) ? v : (v ? [v] : []);
      if (!buckets[k]) buckets[k] = new Map();
      for (const x of list) {
        if (!x) continue;
        buckets[k].set(x, (buckets[k].get(x) || 0) + 1);
        any = true;
      }
    }
  }
  return any ? buckets : null;
}

function renderDims(){
  if (!els.dim) return;
  const buckets = dimBucketsUnder(state.type);

  // 一级没有子分类（或该品牌无 dimensions 数据）→ 隐藏二级
  if (!buckets) {
    if (els.dimWrap) els.dimWrap.hidden = true;
    els.dim.innerHTML = '';
    state.dim = '全部';       // 二级被隐藏时不能残留旧的筛选条件
    return;
  }

  // 当前选中的二级值在新的一级下是否还存在？不存在就重置
  const valid = new Set();
  Object.keys(buckets).forEach(k => buckets[k].forEach((_n, v) => valid.add(v)));
  if (state.dim !== '全部' && !valid.has(state.dim)) state.dim = '全部';

  /*
   * 首项文案固定为「全部二级分类」，不再拼「（化妆刷）」这种作用域后缀。
   * 手机上二级下拉只有约 161px 宽，加后缀会被截成「全部二级分类（化妆…」；
   * 而作用域本来就由旁边的一级下拉显示，后缀纯属冗余。
   */
  const parts = ['<option value="全部">全部二级分类</option>'];
  const keys = Object.keys(buckets);
  for (const k of keys) {
    const entries = Array.from(buckets[k].entries()).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;
    parts.push('<optgroup label="' + escapeHtml(DIM_LABELS[k] || k) + '">');
    for (const [v, n] of entries) {
      parts.push('<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + ' (' + n + ')</option>');
    }
    parts.push('</optgroup>');
  }
  els.dim.innerHTML = parts.join('');
  els.dim.value = state.dim;   // 重建后恢复选中项
  if (els.dimWrap) els.dimWrap.hidden = false;
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
/**
 * 一级品类变化 → **重建二级下拉**（联动）。
 * 二级选项只保留该一级下存在的子分类，件数也按该一级重新统计；
 * 若原先选的二级在新一级下不存在，renderDims() 会把它重置为「全部」。
 */
els.type.addEventListener('change', e => {
  state.type = e.target.value;
  renderDims();
  render(true);
});
if (els.brand) els.brand.addEventListener('change', e => { state.brand = e.target.value; render(true); });
if (els.dim) els.dim.addEventListener('change', e => { state.dim = e.target.value || '全部'; render(true); });
els.more.addEventListener('click', () => render(false));
els.grid.addEventListener('click', e => { const btn = e.target.closest('[data-index]'); if (btn) openProduct(Number(btn.dataset.index)); });
els.modalClose.addEventListener('click', closeProduct);
els.modal.addEventListener('click', e => { if (e.target === els.modal) closeProduct(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape' && !els.modal.hasAttribute('hidden')) closeProduct(); });
renderTypes(); renderBrands(); renderDims(); render(true);
