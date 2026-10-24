#!/usr/bin/env node
'use strict';
/**
 * 极简 Chrome DevTools Protocol 客户端 —— 驱动本机 Chrome 抓取需要「过 WAF / 执行 JS」的站点。
 *
 * 为什么需要它：有些站点（如 Beautylish）用 AWS WAF 的 JS 挑战挡住一切非浏览器请求，
 * 纯 HTTP 抓取只能拿到 202 挑战页；另有站点商品由 JS 渲染。二者都必须真正跑一个浏览器。
 *
 * 依赖：**零 npm 包**。Node 18+ 内置 fetch，Node 22+ 内置全局 WebSocket（本项目在 Node 24 验证）。
 *
 * 用法：
 *   const { withChrome } = require('./lib-cdp.js');
 *   await withChrome(async (page) => {
 *     await page.goto('https://example.com/');
 *     console.log(await page.text());
 *     console.log(await page.eval('document.title'));
 *   });
 *
 * 安全与礼貌：
 *   - 用**独立临时 profile**，绝不影响用户正在使用的 Chrome；
 *   - 结束时会结束进程并删除 profile；
 *   - 覆盖 UA（无头 Chrome 默认 UA 带 HeadlessChrome，会被 WAF 识破）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl, { callTimeout = 120000 } = {}) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.callTimeout = callTimeout;
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('WebSocket 错误: ' + (e.message || 'unknown'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error('CDP ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) {
          try { h(msg); } catch { /* 监听器异常不影响主流程 */ }
        }
      }
    });
  }
  on(fn) { this.handlers.push(fn); return this; }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      // ⚠️ 超时定时器必须**在收到响应时清除**。
      // 之前只是 `setTimeout(...)` 而不 clearTimeout，导致每次 CDP 调用
      // 都留下一个 120 秒的待决定时器，把 Node 事件循环一直挂住——
      // 实测后果：每抓 1 件，进程就要多活 120 秒（墙钟 30 秒/件，
      // 而真正干活只有 6 秒）。这是本项目最隐蔽的一次性能 bug。
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 调用超时: ' + method));
        }
      }, this.callTimeout);
      const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 一个标签页的便捷封装 */
class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.responses = [];
  }
  /** 开始记录网络响应（返回结束函数，得到去重后的列表） */
  recordNetwork() {
    this.responses = [];
    this.cdp.on((m) => {
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        this.responses.push({
          url: r.url,
          status: r.status,
          ct: (r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '',
          requestId: m.params.requestId,
        });
      }
    });
    return () => {
      const seen = new Map();
      for (const r of this.responses) if (!seen.has(r.url)) seen.set(r.url, r);
      return [...seen.values()];
    };
  }
  /**
   * 导航到 url 并**等主框架**加载完成。
   *
   * 注意：Page.loadEventFired 会被**子框架（iframe）的加载也触发**，
   * 若不加过滤，导航刚发出就可能被判为"已完成"，此时拿到的还是 about:blank
   * 或 WAF 挑战页（实测因此出现大量误判失败）。
   * 这里用 Page.navigate 返回的 frameId 精确匹配主框架，不靠 parentId 推断。
   */
  async goto(url, { wait = 0, timeout = 45000 } = {}) {
    let loaded = false;
    let targetFrame = null;
    let fallbackTimer = null;
    const done = new Promise((resolve) => {
      const handler = (m) => {
        if (m.method === 'Page.frameStartedLoading') {
          if (targetFrame && m.params.frameId === targetFrame) loaded = false;
        } else if (m.method === 'Page.loadEventFired') {
          if (targetFrame) {
            // 事件已到，及时清掉兜底定时器，否则它会把事件循环多挂 45 秒
            if (fallbackTimer) clearTimeout(fallbackTimer);
            resolve();
          }
        }
      };
      this.cdp.on(handler);
      // 兜底：避免某些页面永不触发 load 事件而卡死
      fallbackTimer = setTimeout(() => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        resolve();
      }, timeout);
    });
    const nav = await this.cdp.send('Page.navigate', { url });
    targetFrame = nav && nav.frameId ? nav.frameId : null;
    if (!targetFrame) {
      // 理论上不会发生；保守退回"短暂等待"
      if (fallbackTimer) clearTimeout(fallbackTimer);
      await sleep(2500);
      if (wait) await sleep(wait);
      return;
    }
    await done;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (!loaded) {
      try { await this.waitFor('document.readyState === "complete"', { timeout: 10000 }); } catch { /* ignore */ }
    }
    if (wait) await sleep(wait);
  }
  /**
   * 执行页面表达式。**带上下文失效重试**。
   *
   * 为什么要重试：站点可能先返回 WAF 挑战页，挑战通过后由 JS 跳转到真实地址
   * （Beautylish 是 /p/<slug> → /s/<slug>），跳转会**替换执行上下文**，
   * 此时取值会拿到空结果或抛错。重试即可拿到新上下文里的真实 DOM。
   */
  async eval(expression, { awaitPromise = true, retries = 3 } = {}) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (r.exceptionDetails) {
          lastErr = new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
        } else {
          return (r.result || {}).value;
        }
      } catch (e) {
        lastErr = e;
      }
      await sleep(500 * (i + 1));
    }
    throw lastErr || new Error('eval 失败');
  }
  /** JSON.stringify 包装，避免手写转义 */
  async evalJson(expression) {
    const v = await this.eval('JSON.stringify(' + expression + ')');
    try { return JSON.parse(v || 'null'); } catch { return null; }
  }
  /**
   * 等页面里所有图片解码完成。截图前调用，避免拍到只有底色的空图位。
   * 注意 awaitPromise 必须透传给 eval，否则返回 Promise 会一直挂住。
   */
  async decodeImages(timeout = 15000) {
    try {
      await this.eval(
        'Promise.all([...document.images].map(function (i) { return i.decode ? i.decode().catch(function () { return null; }) : null; }))',
        { awaitPromise: true, retries: 0 }
      );
    } catch { /* 解码失败不影响继续 */ }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let pending = 0;
      try { pending = await this.eval('[...document.images].filter(function (i) { return !i.complete || !i.naturalWidth; }).length', { retries: 0 }); } catch { pending = 0; }
      if (!pending) return true;
      await sleep(400);
    }
    return false;
  }
  async html() { return await this.eval('document.documentElement.outerHTML'); }
  async title() { return await this.eval('document.title'); }
  async text() { return await this.eval('document.body.innerText'); }
  /**
   * 反复求值直到结果稳定，返回稳定后的值。
   *
   * 为什么需要：SPA（如 Beautylish 用 React）会在初次渲染后**替换 DOM**。
   * 只读一次会拿到中间态——实测抓到过整段文本里**所有字母 s 都缺失**的版本
   * （s 占比 0.0000，正常应约 0.068），而同一页面读两次取稳定值就是干净的。
   * 这类"看起来像解析 bug、其实是读得太早"的问题，用稳定性检查最省事。
   *
   * @param {string} expression 求值表达式
   * @param {object} opts stableTimes 连续几次相同才算稳定（默认 2）
   */
  async readStable(expression, { stableTimes = 2, timeout = 12000, interval = 500, minLength = 0 } = {}) {
    const t0 = Date.now();
    let prev = null;
    let same = 0;
    let last = null;
    while (Date.now() - t0 < timeout) {
      let v = null;
      try { v = await this.eval(expression, { retries: 0 }); } catch { v = prev; }
      const key = typeof v === 'string' ? v.length + '|' + v.slice(-40) : JSON.stringify(v === undefined ? null : v);
      last = v;
      if (key === prev && (typeof v !== 'string' || v.length >= minLength)) {
        same += 1;
        if (same >= stableTimes) return v;
      } else {
        same = 0;
      }
      prev = key;
      await sleep(interval);
    }
    return last;
  }
  /** 滚动到底，触发懒加载 */
  async scrollToEnd(times = 5, pause = 1000) {
    for (let i = 0; i < times; i++) {
      await this.eval('window.scrollTo(0, document.body.scrollHeight)');
      await sleep(pause);
    }
  }
  /** 等某个表达式变为真值 */
  async waitFor(expression, { timeout = 30000, interval = 500 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await this.eval('Boolean(' + expression + ')');
      if (v) return true;
      await sleep(interval);
    }
    return false;
  }
}

/**
 * 启动 Chrome → 新建标签页 → 交给 fn(page) → 无论成败都收尾。
 * opts: { port, chromePath, userAgent, headless, windowSize, callTimeout }
 */
async function withChrome(fn, opts = {}) {
  const chromePath = opts.chromePath || DEFAULT_CHROME;
  const port = opts.port || (9300 + Math.floor(Math.random() * 600));
  const profile = path.join(os.tmpdir(), 'cdp-profile-' + process.pid + '-' + port);
  const headless = opts.headless !== false;

  if (!fs.existsSync(chromePath)) throw new Error('找不到 Chrome: ' + chromePath);

  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--window-size=' + (opts.windowSize || '1600,1000'),
    '--lang=en-US',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const proc = spawn(chromePath, args, { stdio: 'ignore' });
  const tSpawn = Date.now();

  let cdp = null;
  let page = null;
  try {
    // 等 DevTools 端点就绪
    const deadline = Date.now() + 30000;
    let version = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (r.ok) { version = await r.json(); break; }
      } catch { /* 还没起来 */ }
      await sleep(400);
    }
    if (!version) throw new Error('DevTools 端点未就绪（端口 ' + port + '）');

    const created = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = new CDP(created.webSocketDebuggerUrl, { callTimeout: opts.callTimeout || 120000 });
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    // 关键：无头 Chrome 默认 UA 含 HeadlessChrome，会被 WAF 识别
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: opts.userAgent || DEFAULT_UA,
      acceptLanguage: 'en-US,en;q=0.9',
      platform: 'Win32',
    });
    // 浏览器指纹补齐（部分 WAF 会看）
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }).catch(() => {});

    page = new Page(cdp);
    page.browserVersion = version.Browser;
    if (process.env.CDP_TIMING) {
      console.error('[cdp] 端口 ' + port + ' 就绪耗时 ' + (Date.now() - tSpawn) + 'ms');
    }
    /**
     * 第二个参数是会话对象，供需要**多标签页并发**的场景使用
     * （例如 Beautylish 详情页 6~8 秒/件，单页顺序抓太慢）。
     * 会话对象的 newPage() 会在同一浏览器里再开一个标签页。
     * 仍然由 withChrome 统一负责最后的清理——调用方不必自己关浏览器。
     */
    const session = {
      port,
      async newPage() {
        const created2 = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
        const cdp2 = new CDP(created2.webSocketDebuggerUrl, { callTimeout: opts.callTimeout || 120000 });
        await cdp2.ready;
        await cdp2.send('Page.enable');
        await cdp2.send('Runtime.enable');
        await cdp2.send('Network.enable');
        await cdp2.send('Network.setUserAgentOverride', {
          userAgent: opts.userAgent || DEFAULT_UA,
          acceptLanguage: 'en-US,en;q=0.9',
          platform: 'Win32',
        });
        await cdp2.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }).catch(() => { });
        if (opts.blockedUrls && opts.blockedUrls.length) {
          await cdp2.send('Network.setBlockedURLs', { urls: opts.blockedUrls }).catch(() => { });
        }
        const p2 = new Page(cdp2);
        p2.browserVersion = version.Browser;
        p2.close = async () => { try { cdp2.close(); } catch { /* ignore */ } };
        return p2;
      },
    };
    return await fn(page, session);
  } finally {
    const tClose = Date.now();
    if (cdp) cdp.close();
    try { proc.kill(); } catch { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    if (process.env.CDP_TIMING) {
      console.error('[cdp] 端口 ' + port + ' 清理耗时 ' + (Date.now() - tClose) + 'ms');
    }
  }
}

/**
 * 可复用的浏览器会话：返回一个带着 page 的句柄，**由调用方决定何时关闭**。
 *
 * 为什么需要：`withChrome(fn)` 会在 fn 返回后销毁会话，所以"每件商品一个会话"
 * 意味着每件都要付「建立 0.44s + 清理 0.46s」≈ 0.9 秒。抓 3000 件就白花约 45 分钟。
 * 抓取这类「同一站点连续访问」的场景应当复用会话，只在**被 WAF 挡掉**或
 * 累计若干件之后才重建（重建会拿到新的挑战 token）。
 *
 * 用法：
 *   const s = await withChromeReusable({ port: 9501 });
 *   try { await s.page.goto(url); ... } finally { await s.close(); }
 */
async function withChromeReusable(opts = {}) {
  const chromePath = opts.chromePath || DEFAULT_CHROME;
  const port = opts.port || (9300 + Math.floor(Math.random() * 600));
  const profile = path.join(os.tmpdir(), 'cdp-profile-' + process.pid + '-' + port);
  const headless = opts.headless !== false;

  if (!fs.existsSync(chromePath)) throw new Error('找不到 Chrome: ' + chromePath);

  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--window-size=' + (opts.windowSize || '1600,1000'),
    '--lang=en-US',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const proc = spawn(chromePath, args, { stdio: 'ignore' });

  // 等 DevTools 端点就绪
  const deadline = Date.now() + 30000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (r.ok) { version = await r.json(); break; }
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  if (!version) {
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error('DevTools 端点未就绪（端口 ' + port + '）');
  }

  const created = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const cdp = new CDP(created.webSocketDebuggerUrl, { callTimeout: opts.callTimeout || 120000 });
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: opts.userAgent || DEFAULT_UA,
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'Win32',
  });
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }).catch(() => { });
  if (opts.blockedUrls && opts.blockedUrls.length) {
    await cdp.send('Network.setBlockedURLs', { urls: opts.blockedUrls }).catch(() => { });
  }

  const page = new Page(cdp);
  page.browserVersion = version.Browser;

  let closed = false;
  return {
    page,
    port,
    /**
     * 在同一浏览器里再开一个标签页。
     *
     * 为什么需要：某些站点单标签顺序抓太慢（Beautylish 详情页 6~8 秒/件，
     * 3000 件要 7 小时）。实测该站能容忍少量并发（4 个标签页稳定），
     * 因此提供这个方法来开并行标签页，多页同时抓，整体压到 1.5~2 小时。
     *
     * 用法：
     *   const tab2 = await session.newPage();
     *   ... 用完 tab2.close()（只关标签页，不影响浏览器）
     */
    async newPage() {
      const created2 = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
      const cdp2 = new CDP(created2.webSocketDebuggerUrl, { callTimeout: opts.callTimeout || 120000 });
      await cdp2.ready;
      await cdp2.send('Page.enable');
      await cdp2.send('Runtime.enable');
      await cdp2.send('Network.enable');
      await cdp2.send('Network.setUserAgentOverride', {
        userAgent: opts.userAgent || DEFAULT_UA,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Win32',
      });
      await cdp2.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }).catch(() => { });
      const p2 = new Page(cdp2);
      p2.browserVersion = version.Browser;
      // 只关标签页的连接，不动浏览器
      p2.close = async () => { try { cdp2.close(); } catch { /* ignore */ } };
      return p2;
    },
    async close() {
      if (closed) return;
      closed = true;
      try { cdp.close(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

module.exports = { withChrome, withChromeReusable, Page, CDP, sleep, DEFAULT_UA };
