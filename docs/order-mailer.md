# 本地订单邮件提醒

## 架构

```
客户在 GitHub Pages 下单
        ↓ 写入
   Supabase orders 表
        ↓ 你本机的脚本每 1 分钟查一次「未通知」订单
   本地 Node 脚本 → 你的邮箱 SMTP → 手机收信
        ↓ 发完把该单标记为已通知
```

静态页在 GitHub、数据库在 Supabase、**发信脚本在你本地电脑**，三者各自独立。

## 文件

| 文件 | 作用 |
|---|---|
| `scripts/order-mailer.js` | 主脚本（零依赖，自带极简 SMTP 客户端） |
| `scripts/order-mailer.cmd` | Windows 入口（计划任务调用它） |
| `data/mail-config.json` | 配置（含 SMTP 授权码，**已 gitignore**） |
| `data/order-mailer.log` | 运行日志（自动截断） |

## 一、配置（只做一次）

### 1. 拿 SMTP 授权码

**163 邮箱**：
1. 登录 mail.163.com
2. 设置 → POP3/SMTP/IMAP
3. 开启「SMTP 服务」
4. 生成**授权码**（16 位字符串）

> 注意：是授权码，**不是登录密码**。

QQ 邮箱同理：设置 → 账户 → 开启 SMTP → 生成授权码。

### 2. 填配置

编辑 `data/mail-config.json`：

```json
{
  "supabaseUrl": "https://xxx.supabase.co",
  "supabaseAnonKey": "sb_publishable_...",
  "adminEmail": "你的后台登录邮箱",
  "adminPassword": "你的后台密码",
  "smtpHost": "smtp.163.com",
  "smtpPort": 465,
  "smtpUser": "你的邮箱@163.com",
  "smtpPass": "16位授权码",
  "mailTo": "收件邮箱@163.com",
  "mailFrom": "你的邮箱@163.com"
}
```

> 脚本用后台账号密码登录 Supabase 读订单——匿名身份读不到任何订单（RLS 限制）。

### 3. 验证

```bat
rem 先看邮件长什么样（不发信）
node scripts\order-mailer.js --preview
rem 打开 data\_mail-preview.html

rem 发一封测试邮件
node scripts\order-mailer.js --test
```

收到测试邮件就说明配置正确。

## 二、日常运行

```bat
rem 看有哪些待通知订单（不发信、不标记）
node scripts\order-mailer.js --dry-run

rem 正常执行：查未通知 → 发信 → 标记
node scripts\order-mailer.js
```

### 注册计划任务（每 1 分钟）

管理员 PowerShell：

```powershell
schtasks /Create /TN "OrderMailNotifier" /SC MINUTE /MO 1 ^
  /TR "H:\site-publish\scripts\order-mailer.cmd" ^
  /RU SYSTEM /RL HIGHEST /F
```

> 用 `SYSTEM` 账号运行，不依赖你登录。和价格检查任务一样。

检查：

```powershell
schtasks /Query /TN "OrderMailNotifier" /V /FO LIST
```

删除：

```powershell
schtasks /Delete /TN "OrderMailNotifier" /F
```

## 三、关键设计

### 用数据库字段去重，不用本地状态文件

```sql
orders.notified_at  -- 为空 = 还没通知
```

脚本逻辑：查 `notified_at` 为空的 → 发信 → 写 `notified_at = now()`。

好处：
- 电脑关机期间的订单，开机后**自动补发**
- 重跑不会重复发
- 换一台机器跑也不会重复

### 为什么不做常驻进程

常驻 daemon 容易内存泄漏、挂了没人知道。这里做成「跑一次就退出」，计划任务每分钟调一次，单次 1–2 秒。

### 发信失败不标记

只有成功发出的订单才写 `notified_at`，失败的下一分钟自动重试。

### `.cmd` 必须纯 ASCII

cmd.exe 用 GBK 读批处理文件，文件里出现 UTF-8 中文会被当成命令执行并报错。所以 `order-mailer.cmd` 里全是英文注释。

## 四、邮件内容

- 主题：`【新订单】订单号 · 姓名 · 人民币金额`
- 正文：人民币合计（红色大字）、分币种小计、收货人/电话/地址/备注、商品清单（含一二级分类）
- 同时有纯文本版（部分手机客户端只显示纯文本）

旧订单（人民币折算上线前）没有 `total_cny`，会显示分币种小计并标注「未折算人民币」。

## 五、排查

| 现象 | 原因 |
|---|---|
| `配置缺少字段` | `mail-config.json` 没填全 |
| `Supabase 登录失败` | adminEmail / adminPassword 不对 |
| `AUTH LOGIN 失败` | `smtpPass` 填的是登录密码，要填**授权码** |
| 收不到信 | 看垃圾箱；163 首次可能拦截，加白名单 |
| `RCPT TO 失败` | 收件地址写错，或 163 限制只发给自己 |

日志：`data/order-mailer.log`
