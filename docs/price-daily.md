# 每日价格巡检

每晚 **00:00** 自动抓取 7 个模块的线上最新价格，与站点当前使用的数据对比，输出变动报告。
**只读不写**：不修改 `*-data.js`、不下载图片、不推送。

## 调度

> **重要：推送到 GitHub 不会让脚本运行。**
> GitHub Pages 只托管静态文件，不能执行任何脚本。
> 真正的执行者是**本机的 Windows 任务计划程序**——需要这台机器开机。

Windows 计划任务 `PriceDailyCheck`（每晚 00:00，**以 SYSTEM 账户运行**）：

```bat
schtasks /Query  /TN "PriceDailyCheck" /FO LIST /V   :: 查看（含上次结果）
schtasks /Run    /TN "PriceDailyCheck"               :: 手动触发一次（补跑用）
schtasks /Delete /TN "PriceDailyCheck" /F            :: 停用删除

:: 重新注册（必须用 SYSTEM，否则依赖用户登录）
schtasks /Create /SC DAILY /ST 00:00 /TN "PriceDailyCheck" ^
        /TR "H:\site-publish\scripts\price-daily.cmd" /RU SYSTEM /RL HIGHEST /F
```

**为什么用 SYSTEM 而不是当前用户**：当前用户模式下 `Logon Mode = Interactive only`，
**必须已登录才会跑**。实测 2026-10-19 零点那次就因会话问题被中断（返回 `-1073741510`）。
SYSTEM 是服务账户（`LogonType = ServiceAccount`），不需要用户登录，且有网络权限。

已开启的保护：

| 设置 | 值 | 作用 |
|---|---|---|
| StartWhenAvailable | True | 错过计划（关机/休眠）后开机补跑 |
| DisallowStartIfOnBatteries | False | 允许电池运行 |
| StopIfGoingOnBatteries | False | 切电池不中止 |
| MultipleInstances | IgnoreNew | 已有实例在跑时不重复启动 |
| ExecutionTimeLimit | 2 小时 | 防卡死（正常约 25 分钟） |

入口是 `scripts/price-daily.cmd`（纯 ASCII，避开 PowerShell 5.1 的编码坑；node 用绝对路径，
因为 SYSTEM 的 PATH 里通常没有 node）。

## 执行情况自检

```bat
node scripts/price-status.js            :: 最近 14 天有没有漏、哪天残缺
node scripts/price-status.js --days=30
```

输出示例：

```
2026-10-17  ✓  Beautylish 取价 2955/3095  变动 9   新增 1
2026-10-18  ⚠ 残缺  Beautylish 取价 2267/3095  变动 22  新增 1
2026-10-19  ✓  Beautylish 取价 3095/3095  变动 1   新增 1
```

它会同时打印计划任务的**上次结果**（非 0 就是被中断/失败）。漏跑时用
`schtasks /Run /TN "PriceDailyCheck"` 补一次。

## 仍无法 100% 保证的情况

| 情况 | 结果 |
|---|---|
| 机器整夜关机 | 开机后 `StartWhenAvailable` 会补跑一次（只能补最近一缺） |
| 断网 | 该天部分模块失败，报告里会标「取价失败」数量 |
| Beautylish 限速浮动 | 覆盖率可能低于 100%（实测 73% ~ 100% 之间），报告会标注 |
| 连续多天没开机 | 只会补跑一次，中间那些天没有报告 |

## 部署到另一台 Windows 服务器

服务器比个人桌面机可靠——它消除了「用户退出登录」和「下班关机」这两个最主要的
失败原因。但**把文件拷过去不会自动跑**，必须在服务器上注册计划任务。

### 需要拷贝的文件

```
scripts/price-daily.js        主调度
scripts/price-daily.cmd      计划任务入口（纯 ASCII）
scripts/price-adapters.js     各站取价适配器
scripts/price-beautylish.js   Beautylish 列表页取价
scripts/price-compare.js      对比与报告生成
scripts/price-status.js       执行情况自检
scripts/price-preflight.js    环境预检
scripts/lib-cdp.js            CDP 客户端（Beautylish 需要浏览器）
data/beautylish-list.json     枚举清单（3095 件，判断新增商品用）
data/beautylish-gone.json     已下架清单（过滤假"新增"用）
*-data.js（7 个）             各模块当前数据，作为对比基准
```

合计约 15 MB（其中 `*-data.js` 占 14.7 MB）。

### 部署步骤

```bat
:: 1. 装 Node.js（>=18）和 Chrome（Beautylish 取价需要浏览器渲染）
:: 2. 把项目拷到服务器任意路径，例如 D:\apps\brush-site
:: 3. 跑一次环境预检
node D:\apps\brush-site\scripts\price-preflight.js

:: 4. 预检全过后注册计划任务（SYSTEM 账户，不需登录）
schtasks /Create /SC DAILY /ST 00:00 /TN "PriceDailyCheck" ^
        /TR "D:\apps\brush-site\scripts\price-daily.cmd" /RU SYSTEM /RL HIGHEST /F

:: 5. 开启错过补跑、允许电池、单实例
powershell -Command "$s=(Get-ScheduledTask -TaskName 'PriceDailyCheck').Settings; ^
  $s.StartWhenAvailable=$true; $s.DisallowStartIfOnBatteries=$false; ^
  $s.StopIfGoingOnBatteries=$false; $s.ExecutionTimeLimit='PT2H'; ^
  $s.MultipleInstances='IgnoreNew'; ^
  Set-ScheduledTask -TaskName 'PriceDailyCheck' -Settings $s"

:: 6. 立即试跑一次
schtasks /Run /TN "PriceDailyCheck"
```

路径无需修改：`price-daily.cmd` 用 `%~dp0` 自动推导项目根目录。

### ⚠ 最关键的风险：出口 IP 决定币种

**Beautylish 按访问来源 IP 决定地区与币种**（无法用 cookie/参数改）。
本地数据是人民币（`CN¥`）：

- 服务器出口在**中国区** → 抓回 `CN¥`，对比正确 ✅
- 服务器出口在**海外** → 抓回 `USD`，所有对比**全线错位** ❌

`price-preflight.js` 里有一项专门检测这个：实际抓一页列表，数 `CN¥` 与 `$`
出现的次数，并给出结论。部署到新机器时**务必先看这一项**。

若服务器只能放在海外，两种解法：
1. 让该机器走中国区出口（代理 / 部署到国内区域）
2. 修改对比逻辑，把 USD 按汇率换算后再比（需引入汇率源，且会有偏差）

### 我在本机做的实测（可作为基准）

```
预检结果: 通过 16   警告 0   失败 0
  Node 24.19.0
  Chrome C:\Program Files\Google\Chrome\Application\chrome.exe
  7 个站点全部可达（Beautylish 返回 202 = WAF 对纯 HTTP 的正常响应，需浏览器）
  币种: CN¥ 出现 70 次，$ 出现 0 次  → 与本地数据一致
```

### 搬运时容易踩的坑

| 坑 | 说明 |
|---|---|
| **.cmd 里写中文注释会崩** | cmd.exe 按 GBK 读文件，UTF-8 中文注释的字节会被当成命令分隔符，导致「'XX' 不是内部或外部命令」。`price-daily.cmd` 必须保持**纯 ASCII**。 |
| 服务器没装 Chrome | Beautylish 那 3044 件会全部取不到价，其余 6 个模块仍能跑 |
| SYSTEM 的 PATH 没有 node | `.cmd` 里已按常见路径查找，若 node 装在非常规位置需自行加一条 |
| 时区不同 | 报告按**本地日期**命名，服务器时区若不是 UTC+8，文件名日期会与你这边的习惯不同 |
| 目录权限 | 任务以 SYSTEM 运行，`data\` 必须对 SYSTEM 可写（预检会测） |

## 产物

| 路径 | 内容 |
|---|---|
| `data/price-reports/<YYYY-MM-DD>.md` | 人类可读报告：涨价/降价表、新增商品、取价失败统计 |
| `data/price-snapshots/<YYYY-MM-DD>.json` | 同日机器可读快照（含完整价格表） |
| `data/price-snapshots/latest.json` | 最近一次的完整快照 |
| `data/_price-daily.log` | 逐日追加的运行日志（UTF-8） |

报告每天覆盖写入当天日期，历史日期保留。

## 手动用法

```bat
node scripts/price-daily.js                    :: 全部 7 个模块
node scripts/price-daily.js --only=hakuho      :: 只跑指定模块（逗号分隔）
node scripts/price-daily.js --skip=beautylish  :: 跳过指定模块
node scripts/price-daily.js --dry-run          :: 只跑不写报告
```

## 各模块取价方式（为什么快慢不同）

| 模块 | 方式 | 件数 | 实测耗时 |
|---|---|---|---|
| 白凤堂 | Shopify `/products.json` 全量接口 | 1070 | **约 5 秒** |
| 晃佑堂 | 逐件详情页 `data-id="makeshop-item-price"` | 278 | 约 20 秒 |
| 竹田 | 逐件详情页 `span.item-detail-vari-price-num` | 370 | 约 30 秒 |
| 熊永堂 | 逐件详情页 `#price02_default` | 165 | 约 30 秒 |
| 永丰堂 | 逐件详情页 `tr.price`（站慢） | 420 | 约 3 分钟 |
| 竹宝堂 | 逐件详情页 `class="price"` | 316 | 约 1 分钟 |
| Beautylish | 列表页卡片（分批换会话） | 3044 | **约 16 分钟** |

取价正则全部**搬自对应的 `*-scrape.js`**，不是重新发明——那些选择器是实测定下的
（例如晃佑堂全页匹配 `￥` 会把 UI 图标的价格混进来）。

## 几个实测踩过的坑

1. **白凤堂是 Shopify 站**，直接有 `/products.json`，不需要逐件抓。
2. **Beautylish 纯 HTTP 会被 WAF 挡**（返回 HTTP 202 空响应），必须用浏览器渲染。
3. **Beautylish 列表页连续请求约 20 页后开始返回空卡片**（限速信号）。
   因此策略是：列表页扫到 40 页封顶拿一批，剩余走详情页补；
   详情页单页 6~8 秒，开 **4 个标签页并发**压到 2~2.5 小时。
4. **Beautylish 列表页卡片价可能是区间**（CN¥45 - CN¥330 = 最小~最大规格）。
   直接取第一个数会得到大量假的「降价 60%」（实测 142 项假变动）。
   现在区间价会被标记并**跳过对比**，报告里单列「区间价跳过」数量。
5. **已下架商品仍出现在列表页**（带价格），但详情页跳转品牌页。
   这类不计入「新增」，报告里单独说明数量。
6. **永丰堂售罄商品没有价格行**（页面有 `soldout` 字样）。
   这类被单独统计成「售罄」，不算取价失败，否则报告里会混进一堆假失败。
7. **日志必须由 Node 写**。命令行重定向可能写出 UTF-16LE，与 Node 的
   UTF-8 输出混在一个文件里会变乱码。

## 归一化规则

各站原始格式不同，统一转成整数便于比较：

| 原始 | 归一化 |
|---|---|
| `￥25,190 含税`（白凤堂） | 25190 |
| `13,750 日元（含税）`（日本五站） | 13750 |
| `CN¥45`（Beautylish） | 45（人民币，不与日元混算） |

报告里同时保留原始显示文本，不做汇率换算。

## 对比基准

基准是**站点当前正在展示的数据**（`*-data.js`），不是上一份快照。
原因：快照是临时产物，某天网络失败会残缺；`*-data.js` 才是线上实际内容，
用户关心的是「线上展示的价格 vs 现在官网的价格」。

因此**报告只提示变动，不会自动更新数据**。如需更新：

```bat
:: 重新抓取该品牌（会覆盖 *-data.js）
node scripts/<brand>-scrape.js
node scripts/<brand>-translate.js
:: 然后按需推送（本任务不推送）
```
