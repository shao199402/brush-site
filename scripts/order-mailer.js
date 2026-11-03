#!/usr/bin/env node
'use strict';
/**
 * 订单邮件提醒（本地运行，零依赖）
 * ═══════════════════════════════════════════════════════════════════
 * 架构：静态站在 GitHub Pages，数据库在 Supabase，这个脚本跑在你本地电脑上
 *
 *   客户下单 → Supabase orders 表 → 本脚本轮询「未通知」的订单
 *            → 用你的邮箱 SMTP 发信给自己 → 把该单标记为已通知
 *
 * 为什么不用常驻进程：
 *   常驻 daemon 容易内存泄漏、挂了没人知道。这里做成「跑一次就退出」，
 *   交给 Windows 计划任务每 1~2 分钟调一次。单次运行 1~2 秒。
 *
 * 去重靠数据库的 notified_at 字段，不是本地状态文件：
 *   电脑关机期间产生的订单，开机后会被补发；重跑也不会重复发。
 *
 * 用法：
 *   node scripts/order-mailer.js            正常执行（查未通知 → 发信 → 标记）
 *   node scripts/order-mailer.js --test     只发一封测试邮件，不碰数据库
 *   node scripts/order-mailer.js --dry-run  只看有哪些待通知订单，不发信、不标记
 *   node scripts/order-mailer.js --mark-all 把现有未通知订单全部标记为已通知（不推荐）
 *
 * 配置文件：data/mail-config.json（已 gitignore，不会进仓库）
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'mail-config.json');
const LOG_PATH = path.join(ROOT, 'data', 'order-mailer.log');

const args = process.argv.slice(2);
const FLAG = (n) => args.includes('--' + n);

/* ───────────────── 配置 ───────────────── */

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('缺少配置文件：' + path.relative(ROOT, CONFIG_PATH));
    console.error('请复制 data/mail-config.example.json 为 data/mail-config.json 并填写。');
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('配置文件不是合法 JSON：' + e.message);
    process.exit(2);
  }
  /*
   * 必填字段按模式区分：
   *   --dry-run / --mark-all 只读数据库，不需要 SMTP 配置，
   *   这样还没拿到邮箱授权码时也能先验证「读订单」这条链路。
   */
  const needDb = ['supabaseUrl', 'supabaseAnonKey', 'adminEmail', 'adminPassword'];
  const needSmtp = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'mailTo'];
  // --preview 只渲染文件不发送，也不需要 SMTP 凭据
  const need = (FLAG('dry-run') || FLAG('mark-all') || FLAG('preview'))
    ? needDb
    : needDb.concat(needSmtp);
  const missing = need.filter((k) => !cfg[k]);
  if (missing.length) {
    console.error('配置缺少字段：' + missing.join(', '));
    console.error('配置文件：' + path.relative(ROOT, CONFIG_PATH));
    process.exit(2);
  }
  cfg.mailFrom = cfg.mailFrom || cfg.smtpUser;
  return cfg;
}

/* ───────────────── 日志 ───────────────── */

function log(msg) {
  const line = '[' + new Date().toLocaleString('zh-CN') + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
    // 日志超过 1MB 就截断，避免无限增长
    const st = fs.statSync(LOG_PATH);
    if (st.size > 1024 * 1024) {
      const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n');
      fs.writeFileSync(LOG_PATH, lines.slice(-500).join('\n'), 'utf8');
    }
  } catch { /* 日志写不了不影响主流程 */ }
}

/* ───────────────── Supabase ───────────────── */

async function supabaseLogin(cfg) {
  const res = await fetch(cfg.supabaseUrl.replace(/\/+$/, '') + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey },
    body: JSON.stringify({ email: cfg.adminEmail, password: cfg.adminPassword }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Supabase 登录失败：' + (j.error_description || j.msg || res.status));
  return j.access_token;
}

async function fetchUnnotified(cfg, token) {
  const url = cfg.supabaseUrl.replace(/\/+$/, '') +
    '/rest/v1/orders?select=*&notified_at=is.null&order=created_at.asc&limit=20';
  const res = await fetch(url, {
    headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('查询订单失败 HTTP ' + res.status + ' ' + text.slice(0, 200));
  const arr = JSON.parse(text);
  return Array.isArray(arr) ? arr : [];
}

async function markNotified(cfg, token, ids) {
  if (!ids.length) return;
  const url = cfg.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/orders?id=in.(' + ids.join(',') + ')';
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: cfg.supabaseAnonKey,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ notified_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('标记已通知失败 HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

/* ───────────────── 邮件内容 ───────────────── */

const CURRENCY_SIGN = { JPY: '￥', CNY: 'CN¥' };
const CURRENCY_LABEL = { JPY: '日元', CNY: '人民币' };
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function money(n) {
  return '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildMail(order) {
  const items = (order.items || []).map((i) => {
    const cat = [i.level1, i.level2].filter(Boolean).join(' › ');
    return '<li>' + esc(i.title) + ' ×' + esc(i.qty) +
      '（' + (CURRENCY_SIGN[i.currency] || '') + esc(i.amount) +
      (i.cny != null ? ' ≈ ' + money(i.cny * (i.qty || 1)) : '') + '）' +
      (cat ? '<span style="color:#8a6a3a;font-size:12px"> ［' + esc(cat) + '］</span>' : '') + '</li>';
  }).join('');

  const subs = Object.keys(order.subtotals || {})
    .map((c) => (CURRENCY_LABEL[c] || esc(c)) + ' ' + (CURRENCY_SIGN[c] || '') + Number(order.subtotals[c]).toLocaleString('zh-CN'))
    .join('　');

  /*
   * 主金额：优先用折算后的人民币总额。
   * 旧订单（人民币折算上线前）没有 total_cny，这种情况直接显示分币种小计，
   * 而不是显示一个刺眼的「—」。
   */
  const total = order.total_cny != null ? money(order.total_cny) : (subs || '—');
  const isLegacy = order.total_cny == null;

  const html = `
  <div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:560px">
    <h2 style="margin:0 0 4px;font-size:18px">新订单 ${esc(order.order_no)}</h2>
    <p style="margin:0 0 16px;color:#888;font-size:12px">
      ${new Date(order.created_at).toLocaleString('zh-CN')}　来源页 ${esc(order.source_page || '—')}
    </p>
    <p style="font-size:22px;color:#e03115;margin:0 0 16px"><b>${total}</b>
      ${(!isLegacy && subs) ? '<span style="font-size:12px;color:#888;margin-left:8px">' + subs + '</span>' : ''}
      ${isLegacy ? '<span style="font-size:12px;color:#888;margin-left:8px">（旧订单，未折算人民币）</span>' : ''}
    </p>
    <table style="border-collapse:collapse;font-size:14px;line-height:1.8">
      <tr><td style="color:#888;padding-right:12px">收货人</td><td><b>${esc(order.customer_name)}</b></td></tr>
      <tr><td style="color:#888;padding-right:12px">电话</td><td><b>${esc(order.customer_phone)}</b></td></tr>
      <tr><td style="color:#888;padding-right:12px">地址</td><td>${esc(order.customer_address)}</td></tr>
      ${order.customer_note ? '<tr><td style="color:#888;padding-right:12px">备注</td><td>' + esc(order.customer_note) + '</td></tr>' : ''}
    </table>
    <p style="margin:16px 0 4px;color:#888;font-size:13px">商品</p>
    <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.8">${items}</ul>
    <p style="margin-top:20px;padding-top:12px;border-top:1px solid #eee;color:#aaa;font-size:12px">
      登录后台处理：站点 /admin.html
    </p>
  </div>`;

  return {
    subject: '【新订单】' + order.order_no + ' · ' + (order.customer_name || '') + ' · ' + total,
    html,
    text: buildText(order),
  };
}

function buildText(order) {
  const lines = [];
  lines.push('新订单 ' + order.order_no);
  lines.push('时间：' + new Date(order.created_at).toLocaleString('zh-CN'));
  lines.push('金额：' + (order.total_cny != null ? money(order.total_cny) : '—'));
  lines.push('');
  lines.push('收货人：' + (order.customer_name || ''));
  lines.push('电话：' + (order.customer_phone || ''));
  lines.push('地址：' + (order.customer_address || ''));
  if (order.customer_note) lines.push('备注：' + order.customer_note);
  lines.push('');
  lines.push('商品：');
  (order.items || []).forEach((i, n) => {
    const cat = [i.level1, i.level2].filter(Boolean).join(' › ');
    lines.push('  ' + (n + 1) + '. ' + i.title + ' ×' + i.qty + '  ' + i.amount + i.currency + (cat ? '  ［' + cat + '］' : ''));
  });
  return lines.join('\r\n');
}

/* ───────────────── 极简 SMTP 客户端 ───────────────── */

/**
 * 只用 Node 内置 net/tls 实现，不装 nodemailer。
 * 支持：
 *   · 465 端口隐式 TLS（163/QQ 推荐）
 *   · 587/25 端口 STARTTLS
 *   · AUTH LOGIN
 */
function sendMail(cfg, mail) {
  return new Promise((resolve, reject) => {
    const port = Number(cfg.smtpPort);
    const implicitTLS = port === 465 || cfg.smtpTLS === 'implicit';
    const host = cfg.smtpHost;
    const user = cfg.smtpUser;
    const pass = cfg.smtpPass;

    const from = cfg.mailFrom || user;
    const to = Array.isArray(cfg.mailTo) ? cfg.mailTo : String(cfg.mailTo).split(',').map((s) => s.trim()).filter(Boolean);

    const boundary = '----dsh' + Date.now().toString(36);
    const msgIdDomain = String(from).split('@')[1] || 'localhost';

    const headers = [
      'From: =?UTF-8?B?' + Buffer.from(from, 'utf8').toString('base64') + '?= <' + from + '>',
      'To: ' + to.join(', '),
      'Subject: =?UTF-8?B?' + Buffer.from(mail.subject, 'utf8').toString('base64') + '?=',
      'Date: ' + new Date().toUTCString(),
      'Message-ID: <' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@' + msgIdDomain + '>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    ].join('\r\n');

    const body = [
      headers,
      '',
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(mail.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '--' + boundary,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(mail.html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '--' + boundary + '--',
      '',
    ].join('\r\n');

    let socket = implicitTLS
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });

    let buffer = '';
    let step = 0;
    let finished = false;

    const done = (err) => {
      if (finished) return;
      finished = true;
      try { socket.end(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(true);
    };

    const timeout = setTimeout(() => done(new Error('SMTP 超时（30 秒）')), 30000);
    const finish = (err) => { clearTimeout(timeout); done(err); };

    const expect = (code, name) => {
      const idx = buffer.indexOf('\r\n');
      if (idx < 0) return null;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const num = parseInt(line.slice(0, 3), 10);
      if (!Number.isFinite(num)) return null;
      // 多行响应：250-xxx 后面还有
      if (line[3] === '-') return null;
      return { num, line, name };
    };

    const send = (cmd) => socket.write(cmd + '\r\n');

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let r;
      while ((r = expect())) {
        const { num, line, name } = r;
        if (num >= 400) { finish(new Error(name + ' 失败：' + line)); return; }

        switch (step) {
          case 0:                                   // 服务端问候
            send('EHLO dsh-order-mailer');
            step = 1;
            break;
          case 1:                                   // EHLO 响应
            if (!implicitTLS && /STARTTLS/.test(buffer + line)) {
              send('STARTTLS');
              step = 2;
            } else {
              send('AUTH LOGIN');
              step = 3;
            }
            break;
          case 2:                                   // 升级 TLS
            socket = tls.connect({ socket, servername: host, rejectUnauthorized: false });
            socket.on('data', onData);
            socket.on('error', (e) => finish(e));
            send('EHLO dsh-order-mailer');
            step = 3;
            break;
          case 3:
            send(Buffer.from(user, 'utf8').toString('base64'));
            step = 4;
            break;
          case 4:
            send(Buffer.from(pass, 'utf8').toString('base64'));
            step = 5;
            break;
          case 5:
            send('MAIL FROM:<' + from + '>');
            step = 6;
            break;
          case 6:
            send('RCPT TO:<' + to[0] + '>');
            step = 7;
            break;
          case 7:
            send('DATA');
            step = 8;
            break;
          case 8:
            socket.write(body + '\r\n.\r\n');
            step = 9;
            break;
          case 9:
            send('QUIT');
            finish(null);
            return;
          default:
            break;
        }
      }
    };

    socket.on('data', onData);
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish(new Error('连接被关闭')));
  });
}

/* ───────────────── 主流程 ───────────────── */

(async () => {
  const cfg = loadConfig();

  if (FLAG('test')) {
    log('=== 测试模式：发一封测试邮件 ===');
    await sendMail(cfg, {
      subject: '【测试】订单提醒配置验证 ' + new Date().toLocaleString('zh-CN'),
      html: '<p>这是一封测试邮件。</p><p>如果你收到这封，说明本地发信脚本配置正确，之后每来新订单都会发到这里。</p>',
      text: '这是一封测试邮件。\n如果你收到这封，说明本地发信脚本配置正确。',
    });
    log('✅ 测试邮件已发送，请检查收件箱（含垃圾箱）');
    return;
  }

  const token = await supabaseLogin(cfg);

  if (FLAG('preview')) {
    // 把最近一条待通知订单的邮件渲染成 HTML 文件，方便先看效果再发
    const list0 = await fetchUnnotified(cfg, token);
    const sample = list0[0] || {
      order_no: 'PREVIEW-001', created_at: new Date().toISOString(),
      customer_name: '示例客户', customer_phone: '13800000000',
      customer_address: '示例省示例市示例区示例路 1 号', customer_note: '这是一封预览邮件',
      total_cny: 1187.55, subtotals: { JPY: 25190, CNY: 45 }, source_page: 'hakuho',
      items: [
        { title: '2026秋季套装', qty: 1, amount: 25190, currency: 'JPY', cny: 1133.55, level1: '化妆刷套装' },
        { title: 'Niacinamide Toner', qty: 2, amount: 45, currency: 'CNY', cny: 54, level1: '护肤', level2: '精华' },
      ],
    };
    const m = buildMail(sample);
    const out = path.join(ROOT, 'data', '_mail-preview.html');
    fs.writeFileSync(out, '<!doctype html><meta charset="utf-8"><title>邮件预览</title>'
      + '<body style="margin:0;padding:24px;background:#f6f3ee">'
      + '<div style="background:#fff;padding:24px;border-radius:8px;max-width:640px;margin:0 auto">'
      + '<p style="margin:0 0 16px;color:#999;font-size:12px">主题：' + m.subject + '</p>'
      + m.html + '</div></body>', 'utf8');
    log('已生成预览：' + path.relative(ROOT, out) + '（订单 ' + sample.order_no + '）');
    return;
  }

  if (FLAG('mark-all')) {
    const list = await fetchUnnotified(cfg, token);
    if (!list.length) { log('没有未通知的订单'); return; }
    await markNotified(cfg, token, list.map((o) => o.id));
    log('已把 ' + list.length + ' 条订单标记为已通知（未发信）');
    return;
  }

  const list = await fetchUnnotified(cfg, token);

  if (!list.length) {
    // 正常情况不打日志，避免每分钟刷屏
    if (FLAG('dry-run')) log('没有待通知的订单');
    return;
  }

  log('发现 ' + list.length + ' 条待通知订单');

  if (FLAG('dry-run')) {
    list.forEach((o) => log('  · ' + o.order_no + '  ' + (o.customer_name || '') + '  ' +
      (o.total_cny != null ? money(o.total_cny) : '—')));
    log('（dry-run：未发信、未标记）');
    return;
  }

  const okIds = [];
  let failed = 0;
  for (const o of list) {
    try {
      await sendMail(cfg, buildMail(o));
      okIds.push(o.id);
      log('  ✅ 已发送 ' + o.order_no);
    } catch (e) {
      failed++;
      log('  ❌ 发送失败 ' + o.order_no + '：' + e.message);
    }
    await new Promise((r) => setTimeout(r, 800));   // 避免触发邮箱频率限制
  }

  if (okIds.length) {
    await markNotified(cfg, token, okIds);
    log('已标记 ' + okIds.length + ' 条为已通知');
  }
  if (failed) {
    log('有 ' + failed + ' 条失败，下次运行会重试');
    process.exitCode = 1;
  }
})().catch((e) => {
  log('执行失败：' + e.message);
  process.exit(1);
});
