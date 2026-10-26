/**
 * 商品目录前端逻辑（7 个品牌模块共用）
 *
 * 设计约定：**新增能力一律「数据里有才启用」**，保证老模块不受影响。
 *   - product.brand 存在      → 卡片与详情显示品牌；页面若带 #catalogBrand 则出现「按品牌筛选」
 *   - product.price 含货币符号 → 原样显示（如 CN¥528），不做任何换算
 *   - product.variantNote 存在 → 详情里显示规格说明（如 25 Shades Available）
 *   - product.dimensions 存在 → 出现「按分类维度筛选」下拉（系列 / 用途 / 毛质）
 */
const state = { shown: 0, pageSize: 48, keyword: '', type: '全部', brand: '全部', dim: '全部', sort: 'default' };
const els = {
  grid: document.querySelector('#catalogGrid'),
  count: document.querySelector('#catalogCount'),
  search: document.querySelector('#catalogSearch'),
  tabs: document.querySelector('#catalogTabs'),     // 一级分类：横向标签页
  sort: document.querySelector('#catalogSort'),     // 排序
  brand: document.querySelector('#catalogBrand'),
  brandWrap: document.querySelector('#catalogBrandWrap'),
  dim: document.querySelector('#catalogDim'),       // 二级分类：横向筛选条
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
/**
 * 价格数字（用于排序与展示拆分）
 * 支持的写法："¥5,830 含税" / "CN¥200" / "CN¥45 - CN¥330" / "1,100 日元（含税）"
 * 取第一个数字作为排序依据（区间价取最低价，与电商习惯一致）。
 */
function priceValue(product){
  const m = String(product.price || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : Infinity;
}
/** 把价格拆成 {符号, 数值, 后缀}，便于电商式排版（符号小、数字大） */
function priceParts(product){
  const raw = String(product.price || '');
  const m = raw.match(/^([^\d]*?)([\d,]+(?:\.\d+)?)(.*)$/);
  if (!m) return { cur: '', amount: raw, suffix: '' };
  return { cur: m[1].trim(), amount: m[2], suffix: m[3].trim() };
}
function filteredProducts(){
  const list = (window.PRODUCTS || []).filter(productMatches);
  if (state.sort === 'price-asc') list.sort((a, b) => priceValue(a) - priceValue(b));
  else if (state.sort === 'price-desc') list.sort((a, b) => priceValue(b) - priceValue(a));
  return list;
}
/** 一级分类：横向标签页（电商常见的「全部 / 分类…」切换方式） */
function renderTypes(){
  if (!els.tabs) return;
  const types = Array.from(new Set((window.PRODUCTS || []).map(level1Of)));
  // 按商品数从多到少排，热门的排前面
  const counts = {};
  for (const p of (window.PRODUCTS || [])) {
    const t = level1Of(p);
    counts[t] = (counts[t] || 0) + 1;
  }
  types.sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b, 'zh-Hans-CN'));
  const items = ['全部', ...types];
  els.tabs.innerHTML = items.map((type) => {
    const active = state.type === type ? ' is-active' : '';
    const n = type === '全部' ? (window.PRODUCTS || []).length : (counts[type] || 0);
    return `<button class="tab${active}" type="button" role="tab" aria-selected="${state.type === type}" data-type="${escapeHtml(type)}">`
      + escapeHtml(type) + '<span class="tab-n">' + n + '</span></button>';
  }).join('');
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
   * 二级分类渲染成**横向可滑动的筛选条**（电商常见样式），而不是下拉。
   * 只有当一级下的二级值超过 1 个时才显示，避免「只有一个选项」的无效控件。
   * 每个 chip 后面带件数，让用户知道点进去有多少东西。
   */
  const chips = [];
  const keys = Object.keys(buckets);
  /*
   * 注意：「全部」上的数字必须是**商品数**，不是把各维度值加起来。
   * 一个商品同时有 系列+用途+毛质 三个值，累加会算出 2828 这种远超总数
   * （1071）的荒谬数字。所以单独统计「当前一级下、带任一维度值」的商品数。
   */
  let scopeCount = 0;
  for (const p of (window.PRODUCTS || [])) {
    if (state.type !== '全部' && level1Of(p) !== state.type) continue;
    if (dimValuesOf(p).length) scopeCount++;
  }
  for (const k of keys) {
    const entries = Array.from(buckets[k].entries()).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;
    // 单一维度时不显示维度名，多维度时用 data-dim 做视觉分组
    const multiDim = keys.filter((x) => buckets[x].size > 0).length > 1;
    const dimName = DIM_LABELS[k] || k;
    for (const [v, n] of entries) {
      const active = state.dim === v ? ' is-active' : '';
      chips.push(`<button class="chip${active}" type="button" data-dim="${escapeHtml(v)}" data-group="${escapeHtml(multiDim ? dimName : '')}">`
        + escapeHtml(v) + '<span class="chip-n">' + n + '</span></button>');
    }
  }

  if (!chips.length) {
    if (els.dimWrap) els.dimWrap.hidden = true;
    els.dim.innerHTML = '';
    state.dim = '全部';
    return;
  }

  const allActive = state.dim === '全部' ? ' is-active' : '';
  els.dim.innerHTML = `<button class="chip chip-all${allActive}" type="button" data-dim="全部">全部`
    + '<span class="chip-n">' + scopeCount + '</span></button>' + chips.join('');
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
/**
 * 商品卡片（电商风格）
 *
 * 与旧目录式的区别：
 *   · 图片占卡片主体（接近正方形），是视觉第一要素
 *   · 标题 2 行截断，不再放长简介（简介移到详情弹窗）
 *   · 价格用红橙色、数字放大、货币符号缩小 —— 电商通行的价格强调方式
 *   · 底部用小标签展示分类/材质，代替原来的灰色长文案
 *   · 整张卡片可点（article 上带 data-index），不只图片区
 */
function card(product, index){
  const p = priceParts(product);
  const brand = product.brand ? `<span class="card-brand">${escapeHtml(product.brand)}</span>` : '';

  // 分类标签：优先显示二级（更具体），最多两个，避免卡片过高
  const tags = [];
  const dims = product.dimensions && typeof product.dimensions === 'object' ? product.dimensions : null;
  if (dims) {
    const vals = [];
    for (const k of Object.keys(dims)) {
      const arr = Array.isArray(dims[k]) ? dims[k] : (dims[k] ? [dims[k]] : []);
      for (const v of arr) if (v) vals.push(v);
    }
    for (const v of vals.slice(0, 2)) tags.push(v);
  }
  if (!tags.length && product.type) tags.push(product.type);

  const tagHtml = tags.map((t) => `<span class="card-tag">${escapeHtml(t)}</span>`).join('');
  const flag = product.type ? `<span class="card-flag">${escapeHtml(product.type)}</span>` : '';

  return `<article class="catalog-card" data-index="${index}">
    <div class="card-media">
      <img loading="lazy" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" />
      ${flag}
    </div>
    <div class="card-info">
      ${brand}
      <h3 class="card-title">${escapeHtml(product.title)}</h3>
      <p class="card-price"><span class="cur">${escapeHtml(p.cur || '¥')}</span><strong>${escapeHtml(p.amount)}</strong><span class="tax">${escapeHtml(p.suffix)}</span></p>
      <div class="card-tags">${tagHtml}</div>
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
  els.count.textContent = list.length
    ? `共 ${list.length} 件商品${visible.length < list.length ? '，已显示 ' + visible.length + ' 件' : ''}`
    : '没有匹配的商品';
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
 * 一级分类切换（横向标签页）→ **重建二级筛选条**（联动）。
 * 二级只保留该一级下存在的子分类，件数也按该一级重新统计；
 * 若原先选的二级在新一级下不存在，renderDims() 会把它重置为「全部」。
 */
if (els.tabs) {
  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const next = btn.dataset.type || '全部';
    if (next === state.type) return;
    state.type = next;
    renderTypes();     // 更新选中态
    renderDims();      // 联动重建二级
    render(true);
  });
}
if (els.sort) els.sort.addEventListener('change', (e) => { state.sort = e.target.value; render(true); });
if (els.brand) els.brand.addEventListener('change', e => { state.brand = e.target.value; render(true); });
/**
 * 二级分类是筛选条（按钮）而不是下拉：
 * 点同一个 chip 再点一次可以取消，等于「全部」。
 */
if (els.dim) {
  els.dim.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const v = chip.dataset.dim || '全部';
    state.dim = (v === '全部' || v === state.dim) ? '全部' : v;
    renderDims();      // 更新选中态
    render(true);
  });
}
els.more.addEventListener('click', () => render(false));
els.grid.addEventListener('click', e => { const btn = e.target.closest('[data-index]'); if (btn) openProduct(Number(btn.dataset.index)); });
els.modalClose.addEventListener('click', closeProduct);
els.modal.addEventListener('click', e => { if (e.target === els.modal) closeProduct(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape' && !els.modal.hasAttribute('hidden')) closeProduct(); });
/**
 * 把顶栏实际高度写进 CSS 变量 --header-h。
 * 筛选工具栏是吸顶的，它的 top 必须等于顶栏高度，否则会钻到顶栏下面被遮一截。
 * 顶栏高度随断点变化（桌面一行约 108px，手机两行约 127px），写死任何一个都会错，
 * 所以运行时实测。
 */
function syncHeaderHeight(){
  const header = document.querySelector('.site-header');
  if (!header) return;
  const h = Math.round(header.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty('--header-h', h + 'px');
}
syncHeaderHeight();
window.addEventListener('resize', syncHeaderHeight);
if (typeof ResizeObserver === 'function') {
  const header = document.querySelector('.site-header');
  if (header) new ResizeObserver(syncHeaderHeight).observe(header);
}

/**
 * 筛选工具栏吸顶时加 .is-stuck（投影 + 手机上隐藏计数行，把高度让给商品）。
 * 判定方式：工具栏的视口位置已经贴到它的 sticky top 值。
 * sticky top 随断点不同（桌面=顶栏高，手机=0），所以从计算样式里读，不写死。
 */
function watchToolbarStuck(){
  const bar = document.querySelector('.catalog-toolbar');
  if (!bar) return;
  let raf = null;
  const check = () => {
    raf = null;
    const top = parseFloat(getComputedStyle(bar).top) || 0;
    bar.classList.toggle('is-stuck', bar.getBoundingClientRect().top <= top + 0.5);
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(check); };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', check);
  check();
}
watchToolbarStuck();

renderTypes(); renderBrands(); renderDims(); render(true);
