/**
 * 购物车与下单（纯前端，无数据库）
 * ═══════════════════════════════════════════════════════════════════
 * 数据存放：localStorage（键 brush-cart-v1），只存在用户自己的浏览器里。
 * 订单提交：POST 到第三方表单服务（Web3Forms / Formspree），固定人员
 *          在服务商后台查看订单列表，同时收到邮件通知。
 *          —— 这样不需要任何自建数据库或后端。
 *
 * 关键设计：**按币种分组**
 *   七个模块币种不同（白凤堂/竹田等是日元 ￥，Beautylish 是人民币 CN¥），
 *   日元和人民币直接相加没有意义，所以：
 *     · 购物车可以同时放不同币种的商品
 *     · 合计按币种分别计算、分别显示
 *     · 下单时把每个币种的小计分开列出
 *
 * 未配置表单服务时：退化为「生成订单文本 + 一键复制」，
 * 客户自己发微信/邮件给固定人员，同样能用。
 */
(function () {
  'use strict';

  const STORE_KEY = 'brush-cart-v1';
  const CFG = window.SITE_CONFIG || {};

  const CURRENCY_LABEL = { JPY: '日元', CNY: '人民币', OTHER: '' };
  const CURRENCY_SIGN = { JPY: '￥', CNY: 'CN¥', OTHER: '' };

  /**
   * 各品牌折算人民币的汇率（业务给定，不做实时汇率）
   *
   *   白凤堂 / 竹宝堂 / 竹田 / 永丰堂 ：日元 × 0.045
   *   熊永堂 / 晃佑堂               ：日元 × 0.045 × 1.2 = 0.054
   *   Beautylish                  ：人民币 × 1.2
   *
   * 注意：这是**含加价**的报价汇率，不是外汇牌价，
   * 所以不要拿它跟实时汇率对比。
   */
  const BRAND_RATE = {
    hakuho: 0.045,
    chikuhodo: 0.045,
    takeda: 0.045,
    eihodo: 0.045,
    n8: 0.054,
    koyudo: 0.054,
    beautylish: 1.2,
  };

  /** 取某个商品的人民币汇率：优先按页面（品牌），未知时按币种兜底 */
  function rateOf(page, currency) {
    if (page && BRAND_RATE[page] != null) return BRAND_RATE[page];
    if (currency === 'CNY') return 1.2;
    if (currency === 'JPY') return 0.045;
    return 1;
  }

  /** 单个条目折合人民币 */
  const cnyOf = (it) => (Number(it.amount) || 0) * rateOf(it.page, it.currency);

  /* ───────────────── 工具 ───────────────── */

  const fmt = (n) => Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const fmtCny = (n) => '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /**
   * 从商品价格字符串里解析出「币种 + 金额」。
   * 覆盖实际数据里出现过的写法：
   *   白凤堂   "￥25,190 含税"        → JPY 25190
   *   竹田     "1,100 日元（含税）"    → JPY 1100
   *   Beautylish "CN¥200"            → CNY 200
   *   Beautylish "CN¥45 - CN¥330"    → CNY 45（区间取最低价）
   */
  function parsePrice(raw) {
    const s = String(raw || '');
    let currency = 'OTHER';
    if (/CN\s*[¥元]|CNY|RMB|人民币/i.test(s)) currency = 'CNY';
    else if (/日元|JPY|円/i.test(s)) currency = 'JPY';
    else if (/[￥¥]/.test(s)) currency = 'JPY';   // 六个日本站点的默认写法
    const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    return { currency, amount: m ? Number(m[1]) : 0 };
  }

  function loadCart() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((i) => i && i.id && i.currency) : [];
    } catch { return []; }
  }

  function saveCart(items) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(items)); } catch { /* 隐私模式写入失败，忽略 */ }
  }

  let items = loadCart();

  /** 按币种汇总：[{currency, amount, count}] */
  function groupByCurrency() {
    const map = new Map();
    for (const it of items) {
      const g = map.get(it.currency) || { currency: it.currency, amount: 0, count: 0 };
      g.amount += (it.amount || 0) * (it.qty || 1);
      g.count += it.qty || 1;
      map.set(it.currency, g);
    }
    // 固定顺序：日元在前，人民币其次
    const order = { JPY: 0, CNY: 1, OTHER: 2 };
    return [...map.values()].sort((a, b) => (order[a.currency] ?? 9) - (order[b.currency] ?? 9));
  }

  const totalQty = () => items.reduce((s, i) => s + (i.qty || 1), 0);

  /** 全车折合人民币合计 */
  const totalCny = () => items.reduce((s, it) => s + cnyOf(it) * (it.qty || 1), 0);

  /* ───────────────── DOM ───────────────── */

  let els = null;

  function ensureDom() {
    if (els) return els;
    els = {
      overlay: document.querySelector('#cartOverlay'),
      drawer: document.querySelector('#cartDrawer'),
      body: document.querySelector('#cartBody'),
      foot: document.querySelector('#cartFoot'),
      count: document.querySelector('#cartBadge'),
      drawerCount: document.querySelector('#cartDrawerCount'),
      close: document.querySelector('#cartClose'),
      open: document.querySelectorAll('.js-cart-open'),
    };
    return els;
  }

  /* ───────────────── 渲染 ───────────────── */

  function renderBadge() {
    const e = ensureDom();
    const n = totalQty();
    if (e.count) {
      e.count.textContent = n;
      e.count.hidden = n === 0;
    }
    if (e.drawerCount) e.drawerCount.textContent = n;
  }

  function renderCartList() {
    const e = ensureDom();
    if (!e.body) return;

    if (!items.length) {
      e.body.innerHTML = '<p class="cart-empty">购物车还是空的。<br />在商品卡片或详情里点「加入购物车」。</p>';
      if (e.foot) e.foot.innerHTML = '';
      return;
    }

    const rows = items.map((it) => {
      const orig = (CURRENCY_SIGN[it.currency] || '') + fmt(it.amount * it.qty);
      const cny = fmtCny(cnyOf(it) * it.qty);
      const same = it.currency === 'CNY' && rateOf(it.page, it.currency) === 1;
      return `
      <div class="cart-item" data-id="${it.id}">
        <div class="cart-thumb"><img src="${it.image || ''}" alt="" loading="lazy" /></div>
        <div class="cart-item-main">
          <p class="cart-item-title">${it.title}</p>
          <p class="cart-item-price">${CURRENCY_SIGN[it.currency] || ''}${fmt(it.amount)}${same ? '' : ' → <b>' + fmtCny(cnyOf(it)) + '</b>'}</p>
          <div class="cart-qty">
            <button type="button" class="js-qty" data-delta="-1" aria-label="减少">−</button>
            <span>${it.qty}</span>
            <button type="button" class="js-qty" data-delta="1" aria-label="增加">+</button>
            <button type="button" class="js-remove" aria-label="删除">删除</button>
          </div>
        </div>
        <div class="cart-item-sum" title="原币 ${orig}">${cny}</div>
      </div>`;
    }).join('');

    const groups = groupByCurrency().map((g) => `
      <div class="cart-subtotal">
        <span>${CURRENCY_LABEL[g.currency] || g.currency}小计（${g.count} 件）</span>
        <strong>${CURRENCY_SIGN[g.currency] || ''}${fmt(g.amount)}</strong>
      </div>`).join('');

    const totalCny = items.reduce((s, it) => s + cnyOf(it) * it.qty, 0);

    e.body.innerHTML = rows
      + '<div class="cart-totals">' + groups
      + '<div class="cart-grand"><span>合计（人民币）</span><strong>' + fmtCny(totalCny) + '</strong></div>'
      + '<p class="cart-note">金额按站点公布汇率折算：白凤堂/竹宝堂/竹田/永丰堂 ×0.045，熊永堂/晃佑堂 ×0.054，Beautylish ×1.2。'
      + '最终以客服确认为准。</p>'
      + '</div>';

    if (e.foot) {
      e.foot.innerHTML = `
        <button type="button" class="btn cart-checkout js-cart-checkout">去下单</button>
        <button type="button" class="cart-clear js-cart-clear">清空购物车</button>`;
    }
  }

  /**
   * 收货地址簿 —— 存在**用户自己浏览器**里，不经过任何服务器。
   *
   * 目的：客户第二次下单不用重填。同一台设备/同一个浏览器有效；
   * 换设备或清除浏览器数据就没了（这是"无数据库"的必然代价）。
   *
   * 只保存收货信息，不保存订单内容；按「电话 + 地址」去重，
   * 最多留 MAX_ADDRESS 条，最近使用过的排最前。
   */
  const ADDR_KEY = 'brush-addresses-v1';
  const MAX_ADDRESS = 5;

  function loadAddressBook() {
    try {
      const raw = localStorage.getItem(ADDR_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((a) => a && a.address) : [];
    } catch { return []; }
  }

  function saveAddressBook(list) {
    try { localStorage.setItem(ADDR_KEY, JSON.stringify(list.slice(0, MAX_ADDRESS))); } catch { /* 忽略 */ }
  }

  /** 记录一条收货信息（按电话+地址去重，置顶） */
  function rememberCustomer(c) {
    if (!c || !c.address) return;
    const list = loadAddressBook();
    const key = (c.phone || '') + '|' + c.address;
    const rest = list.filter((a) => (a.phone || '') + '|' + a.address !== key);
    rest.unshift({ name: c.name || '', phone: c.phone || '', address: c.address, savedAt: Date.now() });
    saveAddressBook(rest);
  }

  function forgetAddresses() {
    try { localStorage.removeItem(ADDR_KEY); } catch { /* 忽略 */ }
  }

  /** 下单表单 */
  function renderCheckoutForm() {
    const e = ensureDom();
    if (!e.body) return;
    const groups = groupByCurrency();
    const summary = groups.map((g) =>
      `<div class="cart-subtotal"><span>${CURRENCY_LABEL[g.currency] || g.currency}</span><strong>${CURRENCY_SIGN[g.currency] || ''}${fmt(g.amount)}</strong></div>`
    ).join('');

    const book = loadAddressBook();
    const last = book[0] || null;
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    // 有历史地址时，给出下拉直达
    const picker = book.length
      ? `<div class="saved-addr">
           <label class="saved-addr-label">已保存的地址</label>
           <div class="saved-addr-row">
             <select id="savedAddrSelect">
               <option value="">选择一条自动填入…</option>
               ${book.map((a, i) => `<option value="${i}">${esc(a.name)} ${esc((a.phone || '').slice(-4))} · ${esc(a.address.slice(0, 14))}${a.address.length > 14 ? '…' : ''}</option>`).join('')}
             </select>
             <button type="button" class="js-forget-addr">清除</button>
           </div>
         </div>`
      : '';

    e.body.innerHTML = `
      <div class="checkout-summary">${summary}</div>
      ${picker}
      <form class="checkout-form" id="checkoutForm" novalidate>
        <label>收货人<input name="name" required placeholder="姓名" autocomplete="name" value="${esc(last?.name)}" /></label>
        <label>联系电话<input name="phone" required placeholder="手机号 / 微信" inputmode="tel" autocomplete="tel" value="${esc(last?.phone)}" /></label>
        <label>收货地址<textarea name="address" rows="2" required placeholder="省 / 市 / 区 / 详细地址" autocomplete="street-address">${esc(last?.address)}</textarea></label>
        <label>备注<textarea name="note" rows="2" placeholder="色号、刻字、发票等特殊要求（选填）"></textarea></label>
        <label class="remember-row"><input type="checkbox" name="remember" ${last ? 'checked' : 'checked'} /> 记住收货信息，下次自动填入（仅保存在本机浏览器）</label>
        <p class="checkout-tip">提交后由客服核对库存与运费，再与您联系确认付款方式。</p>
        <button type="submit" class="btn cart-checkout">提交订单</button>
        <button type="button" class="cart-back js-cart-back">返回购物车</button>
      </form>`;

    if (e.foot) e.foot.innerHTML = '';

    // 选择历史地址 → 填入表单
    const sel = e.body.querySelector('#savedAddrSelect');
    if (sel) {
      sel.addEventListener('change', () => {
        const idx = sel.value;
        if (idx === '') return;
        const a = loadAddressBook()[Number(idx)];
        if (!a) return;
        const f = e.body.querySelector('#checkoutForm');
        f.querySelector('[name=name]').value = a.name || '';
        f.querySelector('[name=phone]').value = a.phone || '';
        f.querySelector('[name=address]').value = a.address || '';
        sel.value = '';
      });
    }

    // 清除本机地址
    const forget = e.body.querySelector('.js-forget-addr');
    if (forget) {
      forget.addEventListener('click', () => {
        if (!confirm('清除这台设备上保存的收货地址？')) return;
        forgetAddresses();
        renderCheckoutForm();   // 重画，picker 消失、表单变空
      });
    }
  }

  /* ───────────────── 订单文本 ───────────────── */

  function buildOrderText(customer) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const orderNo = 'B' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
      + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());

    const lines = [];
    lines.push('【笔刷商品目录 · 订单】');
    lines.push('订单号：' + orderNo);
    lines.push('时间：' + now.toLocaleString('zh-CN'));
    lines.push('');
    lines.push('商品：');
    items.forEach((it, i) => {
      const cny = fmtCny(cnyOf(it) * it.qty);
      lines.push(`${i + 1}. [${it.brand || '—'}] ${it.title}`);
      lines.push(`   ${CURRENCY_SIGN[it.currency] || ''}${fmt(it.amount)} × ${it.qty} = ${CURRENCY_SIGN[it.currency] || ''}${fmt(it.amount * it.qty)}（折合 ${cny}）`);
    });
    lines.push('');
    lines.push('小计：');
    groupByCurrency().forEach((g) => {
      lines.push(`   ${CURRENCY_LABEL[g.currency] || g.currency}：${CURRENCY_SIGN[g.currency] || ''}${fmt(g.amount)}（${g.count} 件）`);
    });
    lines.push('   折合人民币合计：' + fmtCny(totalCny()));
    lines.push('');
    lines.push('收货信息：');
    lines.push('   收货人：' + (customer.name || ''));
    lines.push('   电话：' + (customer.phone || ''));
    lines.push('   地址：' + (customer.address || ''));
    if (customer.note) lines.push('   备注：' + customer.note);
    return { orderNo, text: lines.join('\n') };
  }

  /* ───────────────── 提交 ───────────────── */

  /**
   * 统一的订单字段（各家服务商字段名不同，由 sendToProvider 做映射）
   */
  function buildFields(orderNo, text, customer) {
    return {
      orderNo,
      text,
      name: customer.name || '',
      phone: customer.phone || '',
      address: customer.address || '',
      note: customer.note || '',
      itemsText: items.map((i) => `${i.brand || ''} | ${i.title} | ${i.amount} ${i.currency} x${i.qty}`).join('\n'),
      subtotals: groupByCurrency().map((g) => `${g.currency}: ${g.amount}`).join(' / '),
    };
  }

  /**
   * 按服务商提交。配置里 orderProvider 选一个：
   *
   *   'supabase'   订单进 Supabase（Postgres），后台可查、可改状态、可导出  ← 推荐
   *   'web3forms'  250 单/月免费，要注册，有后台提交列表
   *   'formspree'  50 单/月免费，要注册，有后台列表（保留 30 天）
   *   'formsubmit' 免费无上限，**不用注册**，只有邮件（首次需在邮箱点激活链接）
   *   'google'     Google Apps Script，完全免费，订单落进 Google 表格
   *   'custom'     其它任意接受 JSON POST 的地址
   *
   * 返回 true 表示已送达；抛错表示失败（调用方会退回复制模式）。
   */
  async function sendToProvider(orderNo, text, customer) {
    const f = buildFields(orderNo, text, customer);
    const provider = (CFG.orderProvider || '').toLowerCase();
    const key = CFG.orderAccessKey || '';
    const to = CFG.orderTo || '';
    const endpoint = CFG.orderEndpoint || '';

    /* ── Supabase ──
     * 不直接 INSERT 表（anon key 是公开的，直连会被刷单），
     * 而是调用数据库里的 submit_order() 函数：
     * 函数内部做必填校验 + 同一手机号 10 分钟最多 5 单的频率限制。
     * 前端只有 anon key，读不到任何订单（RLS 不给 anon 任何策略）。
     */
    if (provider === 'supabase') {
      const base = (CFG.supabaseUrl || '').replace(/\/+$/, '');
      const anon = CFG.supabaseAnonKey || '';
      if (!base || !anon) throw new Error('缺少 supabaseUrl / supabaseAnonKey');

      const pages = location.pathname.match(/([a-z0-9-]+)\.html?$/i);
      const payload = {
        order_no: orderNo,
        customer_name: f.name,
        customer_phone: f.phone,
        customer_address: f.address,
        customer_note: f.note,
        items: items.map((i) => ({
          brand: i.brand || '', title: i.title, amount: i.amount, currency: i.currency, qty: i.qty,
          page: i.page || '',                 // 后台据此跳回对应品牌的商品详情
          handle: i.handle || '',
          level1: i.level1 || '',             // 一级分类
          level2: i.l2 || '',                 // 二级分类
          cny: Math.round(cnyOf(i) * 100) / 100,
        })),
        subtotals: Object.fromEntries(groupByCurrency().map((g) => [g.currency, g.amount])),
        total_cny: Math.round(totalCny() * 100) / 100,
        order_text: text,
        source_page: pages ? pages[1] : '',
      };

      const res = await fetch(base + '/rest/v1/rpc/submit_order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anon,
          Authorization: 'Bearer ' + anon,
        },
        body: JSON.stringify({ payload }),
        /*
         * 必须带超时：之前没有超时，网络卡住时按钮会永远停在「提交中…」，
         * 客户既不知道成功也不知道失败。
         */
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error('Supabase HTTP ' + res.status + ' ' + detail.slice(0, 120));
      }
      const j = await res.json().catch(() => null);
      // 函数返回 { ok: bool, error?: string, order_no?: string }
      if (j && j.ok === false) {
        // 打上 rejected 标记：这是「服务器拒绝」，不是网络故障
        const e = new Error(j.error || '提交被拒绝');
        e.rejected = true;
        throw e;
      }
      return true;
    }

    if (provider === 'web3forms') {
      const url = endpoint || 'https://api.web3forms.com/submit';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: key,
          subject: '【新订单】' + orderNo,
          from_name: '笔刷商品目录',
          // 同时给「人看的字段」和「统一字段」，后台列表里能直接读到
          name: f.name,
          phone: f.phone,
          address: f.address,
          note: f.note,
          order_no: orderNo,
          order_text: text,
          items: f.itemsText,
          subtotals: f.subtotals,
          botcheck: false,
        }),
      });
      if (!res.ok) throw new Error('Web3Forms HTTP ' + res.status);
      return true;
    }

    if (provider === 'formspree') {
      const url = endpoint;
      if (!url) throw new Error('缺少 orderEndpoint');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: '【新订单】' + orderNo,
          name: f.name, phone: f.phone, address: f.address, note: f.note,
          order_no: orderNo, order_text: text, items: f.itemsText, subtotals: f.subtotals,
        }),
      });
      if (!res.ok) throw new Error('Formspree HTTP ' + res.status);
      return true;
    }

    if (provider === 'formsubmit') {
      // FormSubmit：地址就是你的邮箱，无需注册；首次提交会收到激活邮件
      const target = to ? encodeURIComponent(to) : '';
      if (!target) throw new Error('缺少 orderTo（接收订单的邮箱）');
      const res = await fetch('https://formsubmit.co/ajax/' + target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: '【新订单】' + orderNo,
          _template: 'table',
          _captcha: 'false',
          收货人: f.name,
          电话: f.phone,
          地址: f.address,
          备注: f.note,
          订单号: orderNo,
          订单内容: text,
        }),
      });
      if (!res.ok) throw new Error('FormSubmit HTTP ' + res.status);
      const j = await res.json().catch(() => ({}));
      // FormSubmit 首次会返回「请去邮箱确认」，这不算失败，提示用户即可
      if (j && j.success === 'false') throw new Error(j.message || 'FormSubmit 拒绝');
      return true;
    }

    if (provider === 'google') {
      /*
       * Google Apps Script Web App。
       * 用 no-cors 发简单请求（表单编码），避免预检被拦；
       * 响应是 opaque 的，读不到内容，所以只要 fetch 不抛错就当成功。
       */
      if (!endpoint) throw new Error('缺少 orderEndpoint（Apps Script 部署地址）');
      const body = new URLSearchParams({
        order_no: orderNo,
        order_text: text,
        name: f.name,
        phone: f.phone,
        address: f.address,
        note: f.note,
        items: f.itemsText,
        subtotals: f.subtotals,
      });
      await fetch(endpoint, { method: 'POST', mode: 'no-cors', body });
      return true;
    }

    if (provider === 'custom') {
      if (!endpoint) throw new Error('缺少 orderEndpoint');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: key || undefined,
          subject: '【新订单】' + orderNo,
          order_no: orderNo, order_text: text,
          name: f.name, phone: f.phone, address: f.address, note: f.note,
          items: f.itemsText, subtotals: f.subtotals,
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return true;
    }

    throw new Error('未配置表单服务');
  }

  async function submitOrder(customer) {
    const { orderNo, text } = buildOrderText(customer);

    // 未配置任何服务：走复制兜底
    const configured = !!(CFG.orderProvider
      && (CFG.orderEndpoint || CFG.orderTo || CFG.supabaseUrl));
    if (!configured) {
      await copyText(text);
      showResult(orderNo, text, false);
      return;
    }

    await sendToProvider(orderNo, text, customer);
    await copyText(text);          // 顺手复制一份，方便客户转存
    showResult(orderNo, text, true);
  }

  async function copyText(text) {
    /*
     * 剪贴板 API 在某些环境（无用户手势、无权限、headless）里会一直挂着不返回。
     * 之前直接 await，导致整个提交流程卡死在「提交中…」。
     * 这里加 1.5 秒上限，超时就退回复制备用方案，绝不让 UI 卡住。
     */
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1500)),
      ]);
      return true;
    } catch {
      // clipboard API 在非 https 或旧浏览器不可用，退回 textarea 方案
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch { return false; }
    }
  }

  /** 模块级 HTML 转义（局部作用域的 esc 不能跨函数用） */
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showResult(orderNo, text, submitted) {
    const e = ensureDom();
    e.body.innerHTML = `
      <div class="cart-done">
        <p class="cart-done-title">${submitted ? '订单已提交' : '订单已生成'}</p>
        <p class="cart-done-no">订单号：<strong>${orderNo}</strong></p>
        <p class="cart-done-tip">${submitted
          ? '我们已收到您的订单，客服核对后会与您联系确认。'
          : '订单内容已复制到剪贴板，请发送给客服确认。'}</p>
        <textarea class="cart-done-text" rows="10" readonly>${text.replace(/</g, '&lt;')}</textarea>
        <button type="button" class="btn cart-checkout js-copy-again">再次复制订单</button>
      </div>`;
    e.body.querySelector('.js-copy-again').addEventListener('click', () => copyText(text));
    if (e.foot) e.foot.innerHTML = '<button type="button" class="cart-clear js-cart-close-done">关闭</button>';

    // 提交成功后清空购物车
    if (submitted) { items = []; saveCart(items); renderBadge(); }
  }

  /**
   * 服务器明确拒绝时的提示。
   * 关键点：不假装成功、不清空购物车、把表单还回去让客户改完重提。
   *
   * ⚠ 注意不要用 esc()：那个是 renderCheckoutForm() 里的局部 const，
   *   在这里引用会抛 ReferenceError，界面会永远停在「提交中…」。
   *   所以这里用模块级的 escHtml()。
   */
  function showRejected(message, data, form) {
    const e = ensureDom();
    const { orderNo, text } = buildOrderText(data);
    e.body.innerHTML = `
      <div class="cart-done cart-rejected">
        <p class="cart-done-title">订单没有提交成功</p>
        <p class="cart-done-tip" style="color:#b3261e">${escHtml(message)}</p>
        <p class="cart-done-no">已生成订单号：<strong>${orderNo}</strong>（尚未入库）</p>
        <p class="cart-done-tip">请检查上面的信息后重新提交；也可以直接复制下面内容发给客服。</p>
        <textarea class="cart-done-text" rows="8" readonly>${text.replace(/</g, '&lt;')}</textarea>
        <button type="button" class="btn cart-checkout js-retry">返回修改并重试</button>
        <button type="button" class="btn cart-clear js-copy-again">复制订单内容</button>
      </div>`;
    e.body.querySelector('.js-copy-again').addEventListener('click', () => copyText(text));
    e.body.querySelector('.js-retry').addEventListener('click', () => {
      renderCheckoutForm();
      // 把刚填的内容放回去，别让客户重打一遍
      const f = e.body.querySelector('#checkoutForm');
      if (f) {
        f.querySelector('[name=name]').value = data.name || '';
        f.querySelector('[name=phone]').value = data.phone || '';
        f.querySelector('[name=address]').value = data.address || '';
        if (f.querySelector('[name=note]')) f.querySelector('[name=note]').value = data.note || '';
        f.querySelector('[name=address]').focus();
      }
    });
    if (e.foot) e.foot.innerHTML = '';
  }

  /* ───────────────── 交互 ───────────────── */

  function open() {
    const e = ensureDom();
    if (!e.drawer) return;
    renderCartList();
    e.drawer.hidden = false;
    if (e.overlay) e.overlay.hidden = false;
    document.body.classList.add('cart-open');
    renderBadge();
  }

  function close() {
    const e = ensureDom();
    if (!e.drawer) return;
    e.drawer.hidden = true;
    if (e.overlay) e.overlay.hidden = true;
    document.body.classList.remove('cart-open');
  }

  /** 加购：同一商品累加数量 */
  function add(product, pageId) {
    const { currency, amount } = parsePrice(product.price);
    if (!amount) return false;
    const id = pageId + '::' + (product.handle || product.title);
    const found = items.find((i) => i.id === id);
    if (found) found.qty += 1;
    else {
      /*
       * 记下一二级分类：订单里要能显示「一级 › 二级」，
       * 后台订单列表和商品弹窗都靠这两个字段。
       *   一级 = product.level1，没有就用 type
       *   二级 = dimensions 里的第一个值（系列/用途/毛质…视品牌而定）
       */
      const dims = product.dimensions && typeof product.dimensions === 'object' ? product.dimensions : null;
      let l2 = '';
      if (dims) {
        for (const k of Object.keys(dims)) {
          const v = dims[k];
          const first = Array.isArray(v) ? v[0] : v;
          if (first) { l2 = String(first); break; }
        }
      }
      items.push({
        id,
        page: pageId,              // 来源页（决定汇率，也用于后台跳回商品详情）
        handle: product.handle || '',
        title: product.title,
        brand: product.brand || pageId,
        level1: product.level1 || product.type || '',
        l2,
        amount,
        currency,
        priceRaw: product.price,
        image: product.image || '',
        qty: 1,
      });
    }
    saveCart(items);
    renderBadge();
    // 如果抽屉正开着，实时刷新列表，不用关了再开
    const d = document.querySelector('#cartDrawer');
    if (d && !d.hidden) renderCartList();
    return true;
  }

  /* ───────────────── 事件绑定 ───────────────── */

  function bind() {
    const e = ensureDom();

    document.addEventListener('click', (ev) => {
      const openBtn = ev.target.closest('.js-cart-open');
      if (openBtn) { ev.preventDefault(); open(); return; }
      if (ev.target.closest('#cartClose') || ev.target.closest('#cartOverlay') || ev.target.closest('.js-cart-close-done')) {
        close();
        return;
      }

      // 列表内操作
      const itemEl = ev.target.closest('.cart-item');
      if (itemEl) {
        const id = itemEl.dataset.id;
        const it = items.find((x) => x.id === id);
        if (!it) return;
        if (ev.target.closest('.js-qty')) {
          const delta = Number(ev.target.closest('.js-qty').dataset.delta);
          it.qty = Math.max(0, it.qty + delta);
          if (it.qty === 0) items = items.filter((x) => x.id !== id);
          saveCart(items);
          renderCartList();
          renderBadge();
        } else if (ev.target.closest('.js-remove')) {
          items = items.filter((x) => x.id !== id);
          saveCart(items);
          renderCartList();
          renderBadge();
        }
        return;
      }

      if (ev.target.closest('.js-cart-checkout')) { renderCheckoutForm(); return; }
      if (ev.target.closest('.js-cart-back')) { renderCartList(); return; }
      if (ev.target.closest('.js-cart-clear')) {
        items = [];
        saveCart(items);
        renderCartList();
        renderBadge();
        return;
      }
    });

    // 表单提交
    document.addEventListener('submit', async (ev) => {
      const form = ev.target.closest('#checkoutForm');
      if (!form) return;
      ev.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.name || !data.phone || !data.address) {
        form.querySelector('[name="name"]').reportValidity?.();
        return;
      }
      const btn = form.querySelector('[type=submit]');
      if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }

      /*
       * 记住收货信息：勾选框默认勾上。
       * 只写进本机 localStorage，不发往任何服务器；
       * 按「电话 + 地址」去重，最多留 5 条。
       */
      const wantsRemember = form.querySelector('[name=remember]');
      if (!wantsRemember || wantsRemember.checked) {
        rememberCustomer({ name: data.name, phone: data.phone, address: data.address });
      }

      try {
        await submitOrder(data);
      } catch (err) {
        /*
         * 区分两类失败，之前不区分导致严重问题：
         *   · 服务器明确拒绝（地址太短、频率限制、订单号重复…）
         *     → 必须把原因告诉客户，让 TA 改完重提；
         *       绝不能显示「订单已生成」——客户会以为下单成功，实际没进库。
         *   · 网络不通（DNS/断网/CORS）
         *     → 才退回复制订单文本，让客户手动发给客服。
         */
        if (err && err.rejected) {
          showRejected(err.message, data, form);
          return;
        }
        const { orderNo, text } = buildOrderText(data);
        await copyText(text);
        showResult(orderNo, text, false);
      }
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        const e2 = ensureDom();
        if (e2.drawer && !e2.drawer.hidden) close();
      }
    });
  }

  /* ───────────────── 对外接口 ───────────────── */

  window.Cart = {
    add,
    open,
    close,
    count: totalQty,
    items: () => items.slice(),
    clear: () => { items = []; saveCart(items); renderBadge(); renderCartList(); },
    /** 供 catalog.js 调用：解析价格（详情里要按币种显示） */
    parsePrice,
    CURRENCY_SIGN,
    /* 收货地址簿（本机） */
    addresses: () => loadAddressBook(),
    forgetAddresses: () => { forgetAddresses(); renderCartList(); },
  };

  /**
   * 初始化。
   * 脚本在页面靠后执行，但抽屉 DOM 在脚本之后，所以统一在 DOMContentLoaded 再取节点；
   * 并且**先把列表渲染一次**，这样任何时候打开都能立刻看到内容，
   * 而不是出现「面板空白、要再点一次才有东西」。
   */
  function init() {
    if (window.__cartInited) return;
    window.__cartInited = true;
    bind();
    renderBadge();
    renderCartList();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
