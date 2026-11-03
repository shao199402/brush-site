/**
 * 站点运行时配置（可安全提交到仓库，不含密钥）
 *
 * ══════════════════════════════════════════════════════════════════
 * 下单走哪家服务，就填 orderProvider。
 * 不填时下单退化为「生成订单文本 + 自动复制」，客户手动发给客服。
 * ══════════════════════════════════════════════════════════════════
 *
 * ① Supabase —— 订单进 Postgres 数据库，后台可查/改状态/导出（推荐）
 *
 *    1) https://supabase.com 注册 → New project（免费版 500MB 够用）
 *    2) 左侧 SQL Editor → 把仓库里 supabase/schema.sql 整段粘贴 → Run
 *    3) 把 schema.sql 里的 admin@example.com 改成固定人员登录用的邮箱，
 *       并在 Authentication → Users 里添加这个用户（设置密码）
 *    4) 左侧 Settings → API，复制 Project URL 和 anon public key
 *    5) 填到下面：
 *
 *      orderProvider: 'supabase',
 *      supabaseUrl: 'https://xxxxxxxx.supabase.co',
 *      supabaseAnonKey: 'eyJhbGciOi...'   // anon public，设计上就是公开的
 *
 *    ⚠ 绝对不要把 service_role key 填到这里 —— 那个能绕过所有权限。
 *    前端只拿 anon key，读不到任何订单（RLS 不给 anon 任何策略）。
 *
 * ② Web3Forms —— 250 单/月免费，永久免费，不要信用卡
 *    https://web3forms.com  用固定人员的邮箱注册 → 拿 access key
 *      orderProvider: 'web3forms'
 *      orderAccessKey: '你的-access-key'
 *
 * ③ FormSubmit —— 完全免费、**不用注册**
 *      orderProvider: 'formsubmit'
 *      orderTo: '接收订单的邮箱@example.com'
 *    第一次提交后，该邮箱会收到激活邮件，点一下链接即可。
 *
 * ④ Formspree —— 50 单/月免费，保留 30 天提交记录
 *      orderProvider: 'formspree'
 *      orderEndpoint: 'https://formspree.io/f/xxxx'
 *
 * ⑤ Google Apps Script —— 完全免费，订单落进 Google 表格
 *      orderProvider: 'google'
 *      orderEndpoint: 'https://script.google.com/macros/s/xxxx/exec'
 *
 * ⑥ 其它任何接受 JSON POST 的地址
 *      orderProvider: 'custom'
 *      orderEndpoint: 'https://你的接口'
 *      orderAccessKey: '如果需要就填'
 */
window.SITE_CONFIG = {
  /** 'supabase' | 'web3forms' | 'formsubmit' | 'formspree' | 'google' | 'custom' */
  orderProvider: 'supabase',

  /* ── Supabase（orderProvider 为 'supabase' 时必填）── */
  supabaseUrl: 'https://dlfjzbkqevmtnzsluipl.supabase.co',
  supabaseAnonKey: 'sb_publishable_4DCIlPnWS1brJ89cyqdkcw_34-vwLv8',

  /* ── 其它服务商 ── */
  orderEndpoint: '',
  orderAccessKey: '',
  orderTo: '',

  /** 客服联系方式（下单成功页展示，选填） */
  contactWechat: '',
  contactEmail: '',
};
