# 订单系统说明（Supabase）

## 架构

前端仍是**纯静态页面**（GitHub Pages），订单数据存 Supabase 的 Postgres。

```
浏览器（静态页）          Supabase
  购物车 localStorage  ──▶  RPC submit_order()  ──▶  orders 表
                                     │
                                     └─▶ 触发器 → pg_net → Resend → 管理员邮箱

固定人员 ──▶ admin.html（登录 Supabase Auth）──▶ 读 orders / 改状态 / 导出 CSV
```

| 环节 | 实现 |
|---|---|
| 购物车 | 浏览器 `localStorage`（键 `brush-cart-v1`） |
| 收货地址 | 浏览器 `localStorage`（键 `brush-addresses-v1`，最多 5 条） |
| 订单 | Supabase Postgres，表 `orders` |
| 下单入口 | 只有 RPC `submit_order()`，前端拿不到表的写权限 |
| 防刷 | 同一手机号 10 分钟最多 5 单（函数内判断） |
| 订单隔离 | RLS：匿名无任何策略，读订单返回空；管理员（指定邮箱）可读可改 |
| 邮件通知 | 插入触发器 + `pg_net` 调 Resend API |
| 后台 | `admin.html`，邮箱密码登录 |

## 涉及的文件

| 文件 | 作用 |
|---|---|
| `supabase/schema.sql` | 建表、RLS、下单函数（第一次部署跑这个） |
| `supabase/migration-02.sql` | 人民币列 + 邮件通知（第二次跑） |
| `cart.js` | 购物车、地址簿、汇率折算、提交 |
| `site-config.js` | Supabase 地址与公开密钥、服务商选择 |
| `admin.html` | 订单后台 |
| `docs/orders.md` | 本文档 |

---

## 一、人民币折算规则

购物车**统一按人民币显示合计**，汇率由业务指定（不是外汇牌价）：

| 品牌 | 原币 | 折算公式 | 系数 |
|---|---|---|---|
| 白凤堂 | 日元 | × 0.045 | 0.045 |
| 竹宝堂 | 日元 | × 0.045 | 0.045 |
| 竹田 | 日元 | × 0.045 | 0.045 |
| 永丰堂 | 日元 | × 0.045 | 0.045 |
| 熊永堂 | 日元 | × 0.045 × 1.2 | **0.054** |
| 晃佑堂 | 日元 | × 0.045 × 1.2 | **0.054** |
| Beautylish | 人民币 | × 1.2 | 1.2 |

实现在 `cart.js` 顶部的 `BRAND_RATE`。要调汇率，只改这张表即可。

换算结果会：
- 显示在每个购物车条目上（原价 → 折合人民币）
- 显示在合计处（红色大字）
- 写进订单（`items[].cny`、`total_cny`）
- 出现在邮件里

> 区间价（Beautylish 的 `CN¥45 - CN¥330`）取最低价参与计算。

---

## 二、新订单通知（**当前未启用**）

> 现状：功能已全部装好，但 `mail_api_key` 为空，所以**不会发任何邮件**。
> 订单照常入库，固定人员登录后台查看即可。以后想开，按下面步骤填个 key 就行。

### 原理

`orders` 表上的 `AFTER INSERT` 触发器 → `notify_new_order()` → `pg_net` 发 HTTP → Resend API → 管理员邮箱。
全部在数据库内完成，不需要任何额外服务器。

邮件内容：**下单人信息、订单号、金额（人民币合计 + 分币种小计）、商品清单、来源页、时间**。

### 需要邮件通知时的三种选择

| 方案 | 成本 | 需要什么 | 是否要常开机器 |
|---|---|---|---|
| **Resend**（代码已支持） | 免费 3000 封/月 | 域名 + DNS 验证 + API key | ❌ 数据库自己发 |
| **群机器人**（企业微信/钉钉/飞书） | 免费 | 建群 → 加机器人 → 拿 webhook | ❌ 数据库自己发 |
| **自写脚本 + 自己邮箱 SMTP** | 免费 | 邮箱 SMTP 授权码 | ✅ 需要一台常开机器 |

> 说明：`pg_net` 只能发 HTTP 请求，SMTP 是 TCP 协议，所以数据库**无法**直接连邮件服务器。
> 想用自己的邮箱发信，必须在某台机器上跑一个脚本代为发送。

### 启用步骤（3 分钟）

1. 打开 <https://resend.com> 注册（免费 3000 封/月，100 封/天）
2. 左侧 **API Keys** → **Create API Key** → 复制 `re_...` 开头的 key
3. 左侧 **Domains** → 添加并验证你的域名（要能改 DNS）
   - 没有域名？测试期可以用 `onboarding@resend.dev` 作为发件人，
     但它**只能发到你注册 Resend 用的那个邮箱**，正式用必须有域名
4. 在 Supabase SQL Editor 里执行：

```sql
update public.app_settings set value = 're_你的key' where key = 'mail_api_key';
update public.app_settings set value = 'orders@你的域名.com' where key = 'mail_from';
-- 收件人默认跟随 admin_email，要单独改就执行：
-- update public.app_settings set value = '别人@example.com' where key = 'mail_to';
```

5. 在站点下测试单，检查邮箱是否收到

### 没配置时会怎样

`mail_api_key` 为空时，触发器**静默跳过**，订单照常入库，只是不发邮件。所以可以先上线、以后再补邮件。

### 发信失败会怎样

触发器里包了 `exception when others`，任何发信错误只记 `warning`，**绝不影响订单入库**。

### 排查

```sql
-- 看最近几次发信请求的结果
select id, status_code, content, created_at
  from net._http_response
 order by created_at desc limit 10;
```

- `status_code = 200`：成功
- `401`：API key 错
- `403` / `422`：发件域名没验证，或 from 与已验证域名不一致

---

## 三、后台（固定人员使用）

地址：`https://你的站点/admin.html`

- 登录：Supabase Auth 的邮箱 + 密码（在 Authentication → Users 里创建，记得勾 Auto Confirm）
- 权限：只有 `app_settings.admin_email` 里那个邮箱能看到订单
- 功能：
  - 订单列表（时间 / 订单号 / 收货信息 / **人民币金额** / 状态）
  - 按状态筛选、按订单号/姓名/电话/地址搜索
  - 状态下拉直接改（待确认 / 已付款 / 已发货 / 已完成 / 已取消）
  - **商品名可点击，弹窗显示商品详情**（图片、分类、价格、规格表）
  - 导出 CSV

### 商品弹窗怎么实现的

后台本身没有商品数据。点开某个商品时，才动态加载对应品牌的数据文件：

```
hakuho     → ./catalog-data.js
koyudo     → ./koyudo-data.js
takeda     → ./takeda-data.js
n8         → ./n8-data.js
eihodo     → ./eihodo-data.js
chikuhodo  → ./chikuhodo-data.js
beautylish → ./beautylish-data.js
```

订单里每个商品都存了 `page`（品牌）和 `handle`（商品标识），据此定位。

---

## 四、修改管理员邮箱

```sql
update public.app_settings set value = '新邮箱@example.com' where key = 'admin_email';
update public.app_settings set value = '新邮箱@example.com' where key = 'mail_to';
```

然后去 Authentication → Users 用新邮箱建账号（勾 Auto Confirm）。

---

## 五、免费额度与限制

| 项 | 额度 |
|---|---|
| Supabase 数据库 | 500 MB（订单表能存几十万单） |
| Supabase 免费项目 | ⚠️ **约 7 天无访问会被暂停**，需登录后台点 Restore |
| Resend | 3000 封/月，100 封/天 |

## 六、已知限制

1. **不含支付** —— 提交后由客服线下确认库存、运费、付款方式
2. **购物车不跨设备** —— localStorage 是本地的；订单本身在数据库，换设备也能被客服看到
3. **任何人都能提交订单** —— 靠手机号频率限制 + 人工核对兜底；如需更强防护可在数据库函数里加验证码校验
4. **汇率是固定系数** —— 不是实时汇率，改价改 `BRAND_RATE` 即可
