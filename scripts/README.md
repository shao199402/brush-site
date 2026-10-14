# 商品数据抓取/翻译管线

站内六个品牌模块都按「**先取全量日文，再统一翻译**」的两段式流程构建，杜绝「翻译前先清洗原文」造成的破坏。以下是品牌的对照关系，细节在各品牌小节。

## 品牌对照

| | 白凤堂 HAKUHO-DO | 竹田 TAKEDA | 熊永堂 NUMBER EIGHT | 永豊堂 Eihodo | 晃佑堂 KOYUDO | 竹宝堂 CHIKUHODO |
|---|---|---|---|---|---|---|
| 站点 | `hakuho-do.co.jp`（Shopify） | `takeda-brush-shop.com`（raku-uru） | `number-8.net`（EC-CUBE） | `eihodo.jp`（自研 PHP 商城） | `koyudo.co.jp`（MakeShop） | `chikuhodo.com`（静态站） |
| 商品数 | 1071 | 370 | 165 | **420**（随每周上新变动） | 278 | 316 |
| 数据来源 | 官方 `/products.json`，约 5 个请求 | 翻 `/item-list`（每页 100）再逐条抓 | `/products/list.php?disp_number=200` 一次拿全 | 39 个分类页翻页枚举后逐条抓 | `/view/category/all_items?page=N`（每页 40，共 7 页） | sitemap ∪ 分类页 ∪ 首页 的**并集**（sitemap 有 404 与漏项） |
| 阶段一 | `scripts/hakuho-scrape.js` → `data/hakuho-ja.json` | `scripts/takeda-scrape.js` → `data/takeda-ja.json` | `scripts/n8-scrape.js` → `data/n8-ja.json` | `scripts/eihodo-scrape.js` → `data/eihodo-ja.json` | `scripts/koyudo-scrape.js` → `data/koyudo-ja.json` | `scripts/chikuhodo-scrape.js` → `data/chikuhodo-ja.json` |
| 阶段二 | `scripts/hakuho-translate.js` → `catalog-data.js` | `scripts/takeda-translate.js` → `takeda-data.js` | `scripts/n8-translate.js` → `n8-data.js` | `scripts/eihodo-translate.js` → `eihodo-data.js` | `scripts/koyudo-translate.js` → `koyudo-data.js` | `scripts/chikuhodo-translate.js` → `chikuhodo-data.js` |
| 译文缓存 | `data/hakuho-zh-cache.json` | `data/takeda-zh-cache.json` | `data/n8-zh-cache.json` | `data/eihodo-zh-cache.json` | `data/koyudo-zh-cache.json` | `data/chikuhodo-zh-cache.json` |
| 人工覆盖 | `data/hakuho-zh-overrides.json` | `data/takeda-zh-overrides.json` | `data/n8-zh-overrides.json` | `data/eihodo-zh-overrides.json` | `data/koyudo-zh-overrides.json` | `data/chikuhodo-zh-overrides.json` |
| 页面 | `hakuho.html` | `takeda.html` | `n8.html` | `eihodo.html` | `koyudo.html` | `chikuhodo.html` |
| 图片 | `assets/products/` | `assets/takeda/` | `assets/n8/` | `assets/eihodo/` | `assets/koyudo/` | `assets/chikuhodo/` |
| 分片回灌 | `hakuho-import-jobs.js` | `... --brand=takeda` | `... --brand=n8` | `... --brand=eihodo` | `... --brand=koyudo` | `... --brand=chikuhodo` |
| 校验 | `hakuho-validate.js` | `... --brand=takeda` | `... --brand=n8` | `... --brand=eihodo` | `... --brand=koyudo` | `... --brand=chikuhodo` |

翻译接口凭证的取值统一走 `scripts/run-with-key.js <脚本> [参数]`（见下方竹田小节里的说明）。

六个品牌的校验现状（均为硬性错误 0、残留假名 0、孤儿图片 0）：白凤堂 1071、竹田 370、熊永堂 165、永豊堂 420、晃佑堂 278、竹宝堂 316。

---

# 白凤堂（HAKUHO-DO）

## 为什么需要它

`catalog-data.js` 里的旧文案是被破坏过的。旧流程在翻译前**剥离了平假名和片假名**，日文语法结构被摧毁，译文变成中日混合的残文：

```
官方原文：適度なコシと肌当たりの良さをあわせ持つ、人気のフィニッシング筆。
旧数据　：適度肌当良持、人気定妆筆。
```

其余数据损失：`丸平` 被译成「圆扁形」、`ドーム`（圆顶）整段丢失、规格表被压成一行、`24Kクリアコーティング真鍮/ゴールド` 丢掉后半截、多处商品缺图。

本管线按「**先取全量日文，再翻译**」两段式重建，杜绝这类破坏。

## 取值规则

| 字段 | 来源 |
|---|---|
| `title` | 详情页 `div.product-single__meta` 下 `h1.h2.product-single__title` 的内容 |
| `desc` | 详情页 `div.main_comment` 的内容（纯文本） |
| `detailHtml` | 详情页 `div.product-single__description-full.rte` 的内容，**HTML 结构逐字节不变** |
| `detail` | `detailHtml` 的纯文本版，供 `catalog.js` 的关键词搜索使用 |
| `type` / `price` / `image` / `images` / `handle` | 沿用原规则；`handle` 是价格同步的匹配键，不可改 |

`desc` 与 `detailHtml` 同源——`main_comment` 本身就是描述正文的第一段。

**已实测确认**：官方 `products.json` 里的 `body_html` 与详情页 `div.product-single__description-full` 的内容**逐字相同**（`--verify` 交叉核对，3/3 一致）。因此默认走 JSON 接口，1024 条商品只需约 5 个请求，且能一次拿全图片、价格、SKU、tags。

## 数据来源的选择（重要）

| 接口 | 数量 | 说明 |
|---|---|---|
| `/products.json`（全店） | **1070** | 旧 catalog 就是按这个建的，**默认使用** |
| `/collections/makeup-brushes/products.json` | 798 | 是全店的**子集**，少了日本画筆/洋画筆/雑貨/書筆等 272 条 |

用集合接口会平白丢掉 272 条商品，所以默认 `--feed=store`。

## 流程

```
官方数据
  │
  ├─ 阶段一  scripts/hakuho-scrape.js       只取日文，零翻译、零清洗
  │            ├─> data/hakuho-ja.json      全量日文中间产物（约 3.3 MB，可人工审阅）
  │            └─> assets/products/*.jpg    图片，已存在则跳过
  │
  ├─ 阶段二  scripts/hakuho-translate.js    日 -> 通顺简体中文
  │            ├─> catalog-data.js          保持 window.PRODUCTS = [...]; 格式
  │            ├─> data/hakuho-zh-cache.json    日→中 译文缓存（按日文原句去重）
  │            └─> data/hakuho-report.json      校验报告
  │
  └─ 校验    scripts/hakuho-validate.js     挡坏数据上线
```

「格式不变」的保证方式：脚本按标签把 HTML 切成 `[文本段, 标签段, 文本段, …]`，**只把文本段送去翻译**，再按原样拼回。HTML 标签、属性、空白、换行完全不经过翻译环节。

### 没有翻译 API key 时的替代路径

```bash
node scripts/hakuho-translate.js --export-jobs=250   # 导出待翻译分片
#   -> data/translate/jobs/job-001.json ... 交给任意翻译方
#   -> 译文写到 data/translate/out/job-001.json
node scripts/hakuho-import-jobs.js                   # 回灌进译文缓存
node scripts/hakuho-translate.js --offline           # 只读缓存完成拼装
```

## 怎么运行

### 方式 A：GitHub Actions（不需要本地终端）

1. 仓库 **Settings → Secrets and variables → Actions** 加 Secret `TRANSLATE_API_KEY`（可选 Variables：`TRANSLATE_BASE_URL`、`TRANSLATE_MODEL`）
2. **Actions → Rebuild Hakuho-do catalog (JA -> zh-CN) → Run workflow**
3. 首次建议：`verify = 3`、`limit = 20`、`translate = false`（零成本验证选择器）
4. 确认后：`limit` 留空、`translate = true` 跑全量

### 方式 B：本地（Node 20+）

```bash
node scripts/hakuho-scrape.js --verify=3 --verify-only   # 只核对选择器，不抓取
node scripts/hakuho-scrape.js --limit=20                 # 小批量试跑
node scripts/hakuho-scrape.js                            # 全量抓取（含图片）
node scripts/hakuho-translate.js --limit=20 --dry-run     # 验证拼装，不花钱
TRANSLATE_API_KEY=sk-xxx node scripts/hakuho-translate.js # 全量翻译并写回
node scripts/hakuho-validate.js
```

## 参数

**hakuho-scrape.js**

| 参数 | 说明 |
|---|---|
| `--feed=store` \| `--feed=collection` | 商品来源，默认 `store`（全店 1070 条） |
| `--source=json` \| `--source=html` | `json`（默认，快且不会漏图）；`html` 逐条抓详情页按 CSS 选择器解析 |
| `--verify=N` | 对前 N 条做 json ↔ 详情页交叉核对 |
| `--verify-only` | 只核对不抓取 |
| `--limit=N` / `--handles=a,b,c` | 限定范围 |
| `--no-images` | 不下载图片 |
| `--fresh` | 忽略已有中间产物，从头抓 |
| `--concurrency=N` | 并发数，默认 4 |

**hakuho-translate.js**

| 参数 | 说明 |
|---|---|
| `--offline` | 只用缓存+覆盖拼装，不调用接口（缺译文的位置保留日文） |
| `--export-jobs=N` | 导出待翻译分片后退出，不调用接口 |
| `--dry-run` | 用日文原文走通拼装与写回，验证脚本本身 |
| `--limit=N` / `--batch=N` / `--concurrency=N` / `--model=xxx` | 常用调参 |

## 人工覆盖译文（推荐用法）

共用文案（例如 S100 系列的系列介绍）会在几百条商品里重复，改一句就是几百条受益。为此有一个人工覆盖层：

- 文件：`data/hakuho-zh-overrides.json`
- 结构：`{ "日文原句": "定稿译文" }`
- 优先级高于机器译文；改完直接重跑 `node scripts/hakuho-translate.js --offline` 即可，**不需要重跑翻译**

当前已收录 13 条覆盖（S100 系列介绍、J 系列介绍、I 系列介绍、5 条笔杆规格说明等）。

## 术语表

固定在 `hakuho-translate.js` 的 `GLOSSARY`：`フィニッシング=定妆`、`パウダー=蜜粉`、`チーク=腮红`、`アイシャドウ=眼影`、`ハイライト=高光`、`穂先=笔尖`、`毛丈=毛长`、`全長=全长`、`厚み=厚度`、`金具=金属件`、`真鍮=黄铜`、`ゴールド=金色`、`灰リス=灰松鼠毛`、`合成繊維=合成纤维`、`丸平=圆平`、`斜め=斜角`、`尖り=尖头`、`ドーム=圆顶`、`名入れ=刻名`、`化粧筆=化妆刷` 等。

## 中文排版归一化

只作用于**译文文本节点**，绝不作用于 HTML 标签或属性（不会破坏 `style="color: rgb(255, 0, 0)"`）：

1. 日文中点 `・`／`·`／全角斜杠 `／` → 半角 `/`
2. 非千分位的半角逗号 → `，`
3. 汉字或右括号后的半角冒号 → `：`

另外会**移除 HTML 注释**：官方正文里存在被注释掉的废弃规格表和未翻译的日文备注，注释对用户不可见，保留只会留下死内容与日文残留。

## 校验会检查什么

- **硬性错误（挡 CI）**：文件无法解析、`handle` 缺失或重复、`title`/`type`/`price`/`handle` 为空、`images[]` 指向的图片文件不存在、`detailHtml` 标签不配对
- **警告**：`desc`/`detail` 为空（官方本身就无描述时属正常，例如「名入れオプション」的 `body_html` 就是 `<p></p>`）、无图片商品、未被引用的图片文件、疑似残留假名

假名检测**刻意排除** `・`（U+30FB，片假名中点）——它是标点不是假名，否则「马毛・合成纤维」会被误判。

## 与自动化的关系

每日价格同步（原 `.github/workflows/sync-prices.yml` 与 `scripts/sync-prices.js`）**已移除**，待重建统一的同步方案后再接回。

`catalog-data.js` 仍保持 `window.PRODUCTS = [...];` 格式，便于直接复用、比对与回滚。`handle` 是价格匹配键，重建时绝不可改。

## 注意事项

- **任何环节都不要剥离假名**。这是旧数据损坏的根因。阶段一刻意不做任何文本清洗。
- **图片只写磁盘上真实存在的路径**。拼装时会校验文件存在性，不存在就回退到原有图片，避免裂图。
- 现有商品若某次抓取失败，会**原样保留旧数据**并在报告里计入 `preserved`，不会写入半成品。
- 体积：`catalog-data.js` 2.24 MB，但 gzip 后 **201 KB**、brotli 后 **112 KB**（GitHub Pages 会压缩），无需为体积牺牲字段。
- 回滚：`catalog-data.js` 是单文件，`git checkout` 即可回到上一版。

---

# 竹田（TAKEDA）

## 取值规则

| 字段 | 来源 |
|---|---|
| `title` | 详情页 `h2.item-detail-name` 的内容 |
| `detailHtml` / `desc` | 详情页 `div.item-detail-txt1.wysiwyg-data` 的内容（HTML 保留，只做下述无效样式清洗） |
| `detail` | `detailHtml` 的纯文本版，供 `catalog.js` 关键词搜索 |
| `price` | 详情页 `span.item-detail-vari-price-num`，显示格式**与晃佑堂一致**：`15,400 日元（含税）` |
| `type` | 详情页 `div.item-detail-category`，经 `TYPE_MAP` 译为中文分类（27 类），供**分类搜索** |
| `image` / `images` | 详情页 `div.item-detail-thumb` 内的图片，最多 3 张，优先取 `_1200` 大图 |

## 与白凤堂的两处关键差异

**1. 没有 JSON 接口。** 只能翻商品列表页拿 `item-detail/{id}`，再逐条抓详情页（370 条 ≈ 374 个请求）。详情页 HTML 会缓存到 `data/takeda-cache/`，断点续跑不会重抓。

**2. 必须按容器取图。** 全页扫描 `<img>` 会把站标 `.../147/logo...` 和 UI 图标 `.../cms/.../icn-*.png` 当成商品图（实测抓到 1330 字节的 logo），所以必须先缩到 `div.item-detail-thumb` 范围内。

## 源站数据的无效样式清洗（重要）

竹田的商品详情是从外部编辑器粘贴来的，站方给几乎每个 `div` 都挂了一长串内联样式，而且**在 `font-family` 处被截断、连闭合引号都没有**：

```html
<div style="margin: 0px; padding: 0px; box-sizing: border-box; ... font-family: 游ゴシック, YuGothic,
```

实测一个商品 `item-detail-txt1` 共 15928 字节，其中 **12569 字节（79%）是这种样式**，单个商品最多带 12KB 样式。按 CSS 规范，这串声明里只有开头的 `margin`/`padding` 清零有效，后面的 `box-sizing`/`word-break`/`color` 等因缺少结尾分号会被解析器丢弃——**既冗余又本来就无意义**。

因此阶段一会删掉这一类样式的属性值本身（只匹配 `style="margin: 0px; padding: 0px;` 开头的），**不动标签、不动文本、不动其它属性**：

- 全量效果：`detailJaHtml` 总量 557,603 → 411,438 字节（省 26%）
- 纯文本经程序逐字比对**完全一致**，无内容丢失

## 用法

```bash
node scripts/takeda-scrape.js --limit=6      # 小批量试跑
node scripts/takeda-scrape.js                # 全量 370 条（含图片）
node scripts/takeda-scrape.js --no-images    # 只抓文本
node scripts/takeda-scrape.js --ids=1964597 --fresh   # 指定商品重抓

TRANSLATE_API_KEY=sk-xxx node scripts/takeda-translate.js   # 全量翻译并写回 takeda-data.js
node scripts/takeda-translate.js --dry-run                  # 不调接口，验证拼装
node scripts/takeda-translate.js --offline                  # 只用缓存+覆盖拼装
node scripts/takeda-translate.js --export-jobs=250          # 导出分片交给外部翻译
node scripts/hakuho-import-jobs.js --brand=takeda           # 回灌分片译文
```

**没有 API key 时**（完全不需要凭证的替代路径，已实测跑通）：

```bash
node scripts/takeda-no-key.js --status     # 看还差多少段
node scripts/takeda-no-key.js --export     # 导出分片到 data/takeda-translate/jobs/
#   -> 逐片翻译后按同名文件写到 data/takeda-translate/out/（{"1":"..."} 或数组）
node scripts/takeda-no-key.js --import     # 回灌进译文缓存
node scripts/takeda-no-key.js --assemble   # 只读缓存+覆盖拼装
```

**校验**：`node scripts/hakuho-validate.js --brand=takeda`（报告写到 `data/takeda-validate.json`）。

**翻译凭证的坑**：DSH 里每条命令都是新进程，**不会继承用户级环境变量的当前值**。直接跑 `takeda-translate.js` 会拿到空 key，表现为 `401` 或 `api key: ****ined`（"undefined" 的尾巴）。用包装脚本规避：

```bash
node scripts/run-with-key.js takeda-translate.js --batch=60 --concurrency=3
```

### 实测结果（370 条全量）

- 抓取：370/370，failures 0，图片引用 895 张、磁盘缺失 0
- 翻译：唯一待翻译 1317 段，接口错误 0，漏译 0；使用 `deepseek-chat`
- 校验：硬性错误 0，`title`/`desc`/`detail` 残留假名 0，27 个分类全部译为中文
- **源站把有些句子用标签切开了**，例如 `…筆圧が</font><span>得られます</span>`：按「只翻文本段、标签原样」的规则，`得られます` 是孤立片段，模型无法单独成句。已用人工覆盖层修掉（见下）。

## 分类（type）映射

分类**不走机器翻译**，而是固定在 `takeda-translate.js` 的 `TYPE_MAP`，保证同一分类译法稳定、可直接用于分类搜索下拉。当前 27 类全覆盖：

`眼影刷`、`眼影/遮瑕刷`、`腮红刷`、`面部刷`、`粉底刷`、`粉底/粉扑刷`、`粉扑刷（蜜粉型）`、`高光刷`、`鼻影刷`、`眉刷`、`局部彩妆刷`、`唇刷`、`眼线刷`、`螺旋刷`、`和刷毛`、`洁面刷`、`皂`、`便携面部腮红刷`、`便携眼影刷`、`便携眉刷`、`便携局部刷`、`便携唇刷`、`便携眼线刷`、`套装`、`自选套装`、`期间限定`、`其他`

## 已知的官方数据问题

- `1682019`（簡易ブラシケース保護合皮シート付）站方**根本没写描述块**，页面上不存在 `item-detail-txt1`。这属于「官方本就没有描述」，管线留空并在报告里计入 `emptyFields`，不算抓取失败。
- 毛种术语（如 `ぱふブラシ` 与 `ぱふ`）按语境区分，术语表见 `takeda-translate.js` 的 `GLOSSARY`。

---

# 熊永堂（NUMBER EIGHT）

广岛熊野笔制造商熊永堂的官方网店，平台是 **EC-CUBE**，特色是大量**三丽鸥联名**商品（玉桂狗、库洛米、Hello Kitty、美乐蒂、帕恰狗等）。

## 取值规则

| 字段 | 来源 |
|---|---|
| `title` | 详情页 `h2.detail_product_title[itemprop="name"]` 的内容 |
| `desc` | 详情页 `div.main_comment[itemprop="description"]` 的内容（纯文本） |
| `detailHtml` / `detail` | 详情页 `table.material-box` 的内容，**HTML 与原有属性/结构原样保留** |
| `price` | 详情页 `#price02_default`（或 `itemprop="price"`），显示格式**与晃佑堂一致**：`5,720 日元（含税）` |
| `type` | 源站分类收敛后的**主分类**（见下） |
| `categories` | **全部适用分类**（中文），供关键词搜索与详情展示 |
| `image` / `images` | `div.photo` 主图 + `ul.photo_sub` 子图，按「去掉文件名末尾哈希」去重，最多 4 张 |

## 三个必须注意的实现细节

**1. 属性引号是单双混用的。** 全站 137 处 `class="..."` 用双引号，但 `table.material-box` 偏偏写成 `<table class='material-box'>` 用**单引号**。解析器必须同时接受 `'` 与 `"`，否则会漏掉规格表（我第一版就因此误判成「元素不存在」）。

**2. 分类是多对多，必须收敛。** 165 件商品里 **162 件同时属于多个分类**（最多 4 个），且 `化粧筆` 覆盖了 162/165 件、几乎没有区分度。因此：

- `type` = 按 `Magnifica > 熊永堂 > ツール > セット > その他 熊野筆 > 用途別 > 化粧筆` 优先级择一，得到 5 个有区分度的下拉项：**114 / 25 / 15 / 7 / 4**
- `categories` = 保留全部适用分类（中文），并已接入 `catalog.js` 的搜索范围，按任意一个分类词都能搜到

**3. 分类归属只能从列表页取。** 详情页没有面包屑，只有全站导航链接，无法反映该商品真实归属。抓取脚本改为**按 `category_id` 遍历列表页**建立归属表（7 个分类，逐类翻页），可靠且省请求。

## 用法

```bash
node scripts/n8-scrape.js --ids=147      # 试抓你指定的商品
node scripts/n8-scrape.js                # 全量 165 条（含图片）
node scripts/n8-scrape.js --no-images
node scripts/run-with-key.js n8-translate.js --batch=60 --concurrency=3
node scripts/n8-translate.js --offline   # 只用缓存+覆盖拼装
node scripts/hakuho-validate.js --brand=n8
```

## 实测结果（165 条全量）

- 抓取：165/165，failures 0，图片引用 516 张、磁盘缺失 0
- 翻译：唯一待翻译 442 段，接口错误 0、漏译 0
- 校验：硬性错误 0，残留假名 **0 处**，无图片商品 0
- 4 条 `パンソーローズ` 系列名（机器译文把同系列一处译成「潘索玫瑰」、其余留原文，不一致）已在 `n8-zh-overrides.json` 统一为 `Pansy Rose`，共 5 条覆盖

## 已知的官方数据问题

- `n8-39`（クリアソープ 無着色・無香料，洁面皂）页面 `detailspecarea` 区块里**没有 `table.material-box`**，只有成分与尺寸的自由文本。属官方本就没有规格表，`detailHtml` 留空并计入报告，不算抓取失败。
- `product_id` 有 9 个缺口（12、18、38、40、43、48、49、50、131），是已下架商品，抓不到属正常。全站在售 165 件。

---

# 永豊堂（Eihodo）

大阪的熊野笔/化妆刷制造商，兼营京都东寺吸油纸、萨摩黄杨木梳、美妆刃具（关·匠之技）、发刷等。平台是**自研 PHP 商城**（`/sp/shopping/?si=<分类>&id=<商品>&p=<页>`）。

## 取值规则

| 字段 | 来源 |
|---|---|
| `title` | 详情页 `h2.style_title02` 的内容 |
| `desc` | `h3.style_title03`（内容为「商品説明」）**之后**的段落文字，**在第一个超链接处截断、不含超链接** |
| `detailHtml` / `detail` | **列表页描述（即 `desc` 的内容）＋ `table.style_table02`**，双方 **HTML 与原有属性原样保留** |
| `price` | `table.style_table02` 里 `tr.price` 的 `￥15,400（税込）`，显示格式**与晃佑堂一致** |
| `type` | 源站分类收敛后的主分类 |
| `categories` | 全部适用分类（中文），供搜索命中 |
| `image` / `images` | `product_img/<id>_N.jpg`（同图带/不带 `?r=` 查询串，已去重），最多 6 张 |

## 必须注意的实现细节

**1. 描述要在超链接处截断。** 站方在商品说明末尾统一挂了模板化的推荐链接：

```html
<h3 class="style_title03">商品説明</h3>
<p>…产品说明…<br /><br />ブラシキャップＳＷＳ－３
   <a href="…">（赤）</a>or<a href="…">（黒）</a>をお勧めいたします。</p>
```

按规则取到第一个 `<a>` 之前即止。实测 10/10 抽样商品都是这个模式，全量 420 件中 `desc` 含 `<a>` 的数量为 **0**，可作回归断言。

**1b. 点击详情是「跨区块重新组合」。** 规则要求 `detailHtml` = 列表页描述 ＋ 规格表，但实测 **420/420 件里 `table.style_table02` 都位于「商品説明」之前**（表格在「人気商品」标记后面）。因此产物顺序与源页相反——这是按规则的有意为之，不是抓错了位置。

拼接在**翻译阶段**完成（`eihodo-translate.js` 的 `buildProduct`）：抓取阶段把 `descJaHtml` 与 `detailJaHtml` 分别存好，翻译后按 `描述 + 表格` 合并。因为两边都保留了原有标签与属性，合并后需保证标签配平——已在翻译脚本里加**不配平自检**（输出报告，实测 420/420 为 0）。

**2. 翻页终止不能用「本页无新增 id」。** 同一商品会出现在多个分类页里，一页的商品可能与已收集的完全重复，用它判断会**提前终止并漏掉后面的页**（实测会少 11 件）。正确判据是站方的分页标记：

- 有下一页：`<li class="btn_next"><a href="./?si=…&p=N">`
- 无下一页：`<li class="btn_next">&nbsp;`
- 另外超出真实页数的 `p` 会返回「ただいま準備中のため…」占位页（无任何商品链接），也必须停

**3. 分类页枚举要带磁盘缓存。** 全量需翻 39 个分类页；`data/eihodo-list-cache/` 会缓存每一页，重复核对计数时不会反复打站方（也避免了被限流）。

## 用法

```bash
node scripts/eihodo-scrape.js --ids=1713400652-990041   # 试抓指定商品
node scripts/eihodo-scrape.js                           # 全量
node scripts/eihodo-scrape.js --no-images
node scripts/run-with-key.js eihodo-translate.js --batch=60 --concurrency=3
node scripts/eihodo-translate.js --offline              # 只用缓存+覆盖拼装
node scripts/hakuho-validate.js --brand=eihodo
```

## 实测结果（420 条）

- 抓取：420/420，failures 0，图片引用 1148 张、磁盘缺失 0；缺分类/缺描述/缺规格表/无图 均为 0
- 翻译：唯一待翻译 2722 段，接口错误 0、漏译 0
- 校验：硬性错误 0，残留假名 **0 处**，无图片商品 0
- 2 处残留（`しっかり` 在同一句里出现多次、模型只翻了部分出现位置）已在 `eihodo-zh-overrides.json` 修正

## 商品数会变动（重要）

这站**每周五 20:00 上新**，且大量「数量限定」「今月のおすすめ」商品。实测同一天两次枚举：早前 94 个分类页 → **409 件**，稍后 56 个汇总页 → **420 件**（某分类由 7 页增至 8 页）。因此：

- **420 是当前实时值**，不是恒定值
- 若将来要定期同步，需按增量处理，不能假设数量固定

## 已知的官方数据问题

- **27 件商品页面上完全没有价格**（无 `￥`/「価格」、也无任何 price 元素），集中在吸油纸、萨摩黄杨木梳/刷、化妆棉、粉扑等。已逐页核实，属实缺价而非抓取失败；`price` 记 `价格待确认`，**不伪造数值**。
- 全部 420 件各只属于 1 个分类（与熊永堂的多对多不同），`categories` 数组仍保留以兼容站内搜索。

---

# 晃佑堂（KOYUDO）

广岛县熊野町的熊野笔/化妆刷制造商，平台是 **MakeShop**。**本品牌是重整既有模块**（`koyudo-data.js` 与 `koyudo.html` 沿用，handle 仍是 `koyudo-<12位商品号>`），目的是根治旧数据的损坏。

## 取值规则（用户更正后的版本）

| 字段 | 来源 |
|---|---|
| `title` | 详情页 `h2.c-detailitem__info-name` 的内容 |
| `desc` | `div.c-detailitem__info-txt` 中 **`<table>` 之前的纯文字部分**；**若无 table 则取价格之前**；**若既无 table 也无价格则整段取**。保留原有 style |
| `detailHtml` / `detail` | **A** = `info-txt` 中「价格及其以下」之前的部分（含 table）＋ **B** = `div.c-detailitem__discripstion2`（含 table 要显示、无 table 也保留原文 style）。**A 或 B 任一含超链接 / 「购物车」字样，则该段不显示** |
| `price` | `span[data-id="makeshop-item-price:1"]` 的数值，**格式保持不变**：`10,780 日元（含税）` |
| `type` | 该站只有 `all_items` 单一分类页，**无可保留的分类体系**，沿用既有值「晃佑堂商品」，不破坏现有模块 |
| `image` / `images` | `div.c-detailitem__img-l` 内的商品图（退回 `img-thumb`/`img`），按去查询串的 URL 去重 |

实测各分支数量（278 件）：

- `desc`：table 之前 **261**、整段 **15**、价格之前 **2**；3 件源站只有空 `<p></p>`＋table，切后确无文字
- `detailHtml`：**260 件有内容**；`info-txt` 段 whole 236 / 价格之前 18 / 因含链接跳过 26；`discripstion2` 段保留 85 / 无此元素 133 / 因链接跳过 31 / 因"カート"跳过 29

## 旧数据被根治的问题

旧数据是一次性脚本（已删除）产的，走第三方翻译接口 + 字符串替换，典型破坏：

| 旧译文 | 问题 | 新译文 |
|---|---|---|
| 「3本とも…」→ **三根拐杖的形状都很常见** | 把「刷子3支」误译成「拐杖」 | 三支刷型都采用通用形状 |
| 「軸」→ **每件家具都拥有独特的天然木纹** | 化妆刷**刷杆**误译成「家具」 | 刷杆 |
| `枿目樱木`、`印上收礼人的名字` | 中日混杂 / 错字 | 已修正 |
| 规格表塌陷：`容　量120ml（…）成　分…` | `<table>/<tr>/<td>` 全丢，读不出「哪项对应哪个值」 | **结构完整保留**（含 `cellpadding` 等原有属性） |
| 旧 `detailHtml` 取自**错误字段** | 634 的旧详情其实是列表描述内容，而非「套装内容详情」表格 | 现取自 `discripstion2`，字段正确 |

## 必须注意的实现细节

**1. 分页地址是 `/view/category/all_items?page=N`。** 官网自己声明「全278件中」，每页 40，共 7 页（末页 38）。`/items/?page=N` 是 404，别用错。

**2. 站方 HTML 不配平，不能用「数 div」找边界。** 实测整页 `<div>` 比 `</div>` 多一个；用配平法找元素边界会把后面的价格区、购物车按钮整段吞进来（实测 inner 从 610 字节涨到 5092 字节），导致详情页错版。

因此新增 `scripts/lib-html.js`，做法是：

- **边界**用站方自己的区块注释（`<!-- //.c-detailitem__info-txt -->`）或后续区块标记；`discripstion2` **没有**配对结束注释，靠它之后的 `<!-- c-detailitem -->` / 页脚截断
- **结果**用 `balanceFragment()`（标签栈扫描）修正为自配平片段：只补/删标签，**绝不改动文字与属性**，这样「保留原有样式」才成立
- 停止标记必须写成**完整注释**（含 `<!--` 与 `-->`），否则会匹配到注释内部子串、在尾部留下半个 `<!--`

**3. 半个 `<!--` 会被翻译阶段漏掉，必须源头清零。** 翻译脚本只移除**完整**注释（`<!--...-->`）；留下半个 `<!--` 时它不会被移除，产物里就会出现无闭合的注释碎片（实测曾出现 444 个 `<!--` 对 0 个 `-->`）。抓取脚本现在会在源头 `trimDanglingComment()`，并输出**未闭合注释自检**（应为 0）。

**4. 图片只取商品图容器。** 全页扫描会把 logo 与 28 个 UI 图标当商品图（实测 634 页共 31 张图，仅 2 张是商品图）。

## 用法

```bash
node scripts/koyudo-scrape.js --ids=000000000634      # 试抓指定商品
node scripts/koyudo-scrape.js                         # 全量 278 条
node scripts/koyudo-scrape.js --fresh                 # 忽略缓存；HTML 缓存命中时不打站方
node scripts/run-with-key.js koyudo-translate.js --batch=60 --concurrency=3
node scripts/koyudo-translate.js --offline            # 只用缓存+覆盖拼装
node scripts/hakuho-validate.js --brand=koyudo
```

## 实测结果（278 条）

- 抓取：278/278，failures 0；列表描述来源 261/15/2；点击详情来源见上
- 抓取期自检**全为 0**：价格泄漏、购物车泄漏、超链接泄漏、标签不配平、未闭合注释
- 翻译：1706 段，接口错误 0、漏译 0
- 校验：硬性错误 0，残留假名 0，孤儿图片 0
- 清理：删除 11 个旧命名残留图片（743 KB），新数据图片 901 张、磁盘缺失 0
- `koyudo-data.js` 629 KB（旧 591 KB，含更多真实结构）

## 关于源站的中文简体

站方用第三方翻译组件（shutto，`data-stt-changelang="zh-CN"`）**运行时注入**译文，`?lang=zh-CN` 之类的查询参数无效，静态抓不到中文正文。因此按管线的阶段二自行翻译；若将来要改用源站中文，需能执行其 JS 才拿得到。

## 校验器口径修正（本次顺带）

`hakuho-validate.js` 原先按「剥离尖括号」统计残留假名，会把标签**从中间截断**——例如 `<img alt="Premiumシリーズ" src=…>` 去掉 `<…>` 后，`alt="Premiumシリーズ"` 的假名会漏出来，把 8 件**仅 alt 含假名**的商品误报为残留。已改为用 `/<[^>]*>/` **整段剥离标签**（属性属不可见内容）。修正后五个品牌的残留假名均为 0。`detailHtml` 的 `alt` 属性仍原样保留日文——那是结构保真的前提，且 alt 对用户不可见。

---

# 竹宝堂（CHIKUHODO）

广岛县熊野町的熊野笔/化妆刷制造商（1960 年代起做 OEM），官网为**静态 HTML 站**，商品页形如 `https://www.chikuhodo.com/product/<slug>.html`。

## 商品名称：**从 `<title>` 取**（重点）

这个站的商品名**不在主体标签里**，而是做成了图片：

```html
<h1 class="title title_num">FO-8</h1>          <!-- 只有型号 -->
<div class="item_description">
  <h2><img src="…/item_shadowliner.png" alt="シャドーライナーブラシ" /></h2>   <!-- 名称在这个图的 alt 里 -->
```

三种取法实测对比：

| 取法 | 命中率 | 问题 |
|---|---|---|
| **`<title>`**（采用） | **59/59** | 无 |
| `h1.title_num` | 14/15 | 只有型号（`FO-8`），**不是名称** |
| `desc > h2 > img` 的 `alt` | 14/15 | `cl_01` 缺「（レッド）」、`e_01` 多「（細）」、`j_s02` 型号还写错（`J-G2`） |

而 `case30`、`c2026a` 这类**连 h1 和 alt 图都没有**，只有 `<title>` 完整。

**规则**：`<title>` 中第一个 `｜` 之前的部分，再按**最后一个 `：`** 切分 → 左为名称、右为型号。

```html
<title>シャドーライナーブラシ：FO-8｜竹宝堂（ちくほうどう）熊野筆・化粧筆・メイクブラシ</title>
        └──── 名称 ────┘ └型号┘ └────────── 站点名（丢弃）──────────┘
```

## 取值规则

| 字段 | 来源 |
|---|---|
| `title` | `<title>` 里 `｜` 之前、最后一个 `：` 之前的文本（见上） |
| `desc` | `div.item_description` 的内容，**含图片**、保留原有样式 |
| `detailHtml` / `detail` | **同一个区块但排除图片**，保留原有样式 |
| `price` | 见下方「价格载体有四种」；格式与晃佑堂一致：`3,850 日元（含税）` |
| `type` | 面包屑里的 **`cate_*` 用途分类**（21 个），用于分类下拉 |
| `categories` | 同上（供站内搜索） |
| `seriesJa` | 面包屑里的系列名（如 `FOシリーズ`），**仅备查不进下拉**：35+ 个系列粒度太细 |
| `image` / `images` | `div.item_photo` / `div.item_photo_sp`，模板 B 退回描述区，按去查询串的 URL 去重 |

## 必须注意的实现细节

**1. 有两套模板，描述容器不同。**

| | 模板 A（单个刷子，233 件） | 模板 B（套装/笔盒/合集，83 件） |
|---|---|---|
| 例子 | `fo_08` | `gs_set08`、`case18`、`c2026a` |
| 描述容器 | `div.item_description` | **没有**，退回 `article#item`（同口径） |
| 价格 | 容器内 `dd.price` | `p.price` / `td.price` |

模板 B 退回 `article` 时必须**剔掉页面功能与共用区块**，否则会把「加入购物车」「●顾客评价（1件）Y.S女士…★★★★★」混进描述里。要剔的 class：

```
sns_area（分享按钮）  bt_cart（购物车）  review（顾客评价）  case_link（同系列导航）
review_link  btn  chikuhodo_contact  oem_contact  no_name
```

**剔除必须用标签栈取完整外层，不能用非贪婪正则**：`<div class="review">` 内层还有 `</div>`，正则会配到第一个就只删一半、留下残余——实测因此漏进过 37 件。

**2. 价格载体有四种，全都要覆盖。** 只写 `dd.price` 会让 **23 个笔盒全部误判为无价**（它们用 `td.price`）。

| 载体 | 典型 | 例子 |
|---|---|---|
| `dd.price` | 模板 A 单个刷子 | `fo_08` → 3,850円 |
| `p.price` | 模板 B 套装 | `gs_set08` → 69,080円 |
| `td.price` | 笔盒（在规格表末行） | `case18` → 990円 |
| 描述文字 | 合集页（无 price 类） | —— |

**3. sitemap 不可靠，枚举必须用并集。** 实测：

- sitemap 含 **3 个 404**（`kw`、`kw_c1`、`kw_c2`——「極」系列旧地址，新地址是 `kiwami.html`，首页两种都链了）
- sitemap **漏掉在售新品**：`r_set13/15/16/18`（首页公告刚发售）、`kiwami`、`case37`、`set_br_g5`、`kw6`

因此 `chikuhodo-scrape.js` 用 **sitemap ∪ 43 个分类页 ∪ 首页链接** 的并集，再逐个验状态。

**4. 商品总览页 `/product/index.html` 是 JS 渲染的**，静态只有 1 个商品链接——不能拿它枚举。

**5. 关于源站官方简中：取不到。** `/sc/` 只有首页（`/sc/index.html` 可访问），**`/sc/product/*.html` 全部 404**，商品页没有中文版本。所以按管线的阶段二自行翻译。

## 用法

```bash
node scripts/chikuhodo-scrape.js --ids=fo_08,gs_set08      # 试抓指定商品
node scripts/chikuhodo-scrape.js                           # 全量（sitemap ∪ 分类页 ∪ 首页）
node scripts/chikuhodo-scrape.js --fresh                   # 忽略缓存；HTML 缓存命中时不打站方
node scripts/run-with-key.js chikuhodo-translate.js --batch=60 --concurrency=3
node scripts/chikuhodo-translate.js --offline              # 只用缓存+覆盖拼装
node scripts/hakuho-validate.js --brand=chikuhodo          # 通用完整性校验
node scripts/chikuhodo-verify.js --site                    # 竹宝堂专有规则验收（36 项）
```

`chikuhodo-verify.js` 与通用校验器的分工：`hakuho-validate.js` 查**各品牌通用**的完整性（字段齐不齐、假名、孤儿图）；`chikuhodo-verify.js` 查**本品牌专有规则**（名称取自 `<title>`、desc 含图 / detail 去图、模板 A/B 覆盖、价格格式、21 个分类、页脚泄漏、iframe lazy），并顺带跑六品牌回归。

## 实测结果（316 条）

- 枚举：325 个候选 → **316 件商品**；9 个 404（`case20`、`kw`、`fa_m`、`gsn_17`、`gsn_18`、`kw_c1`、`kw_c2`、`set_br_g4`、`set_br_g5`，属已下架但仍在 sitemap/分类页里的死链）
- 描述来源：`item_description` 233 件、`article` 83 件
- 抓取期自检**全为 0**：购物车泄漏、评价泄漏、标签不配平、未闭合注释、无图片
- `detailHtml` 含图 **0 件**（规则要求排除）；`descJaHtml` 含图 **316/316**（规则要求保留）
- 翻译：1873 段，接口错误 0、漏译 0
- 图片：696 张，磁盘缺失 0
- 1 件无价格：`c2026`（CHIKUHODO collection 2026）——页面上**没有 price 结构**，价格只写在图片 `alt` 里（`…：31,350円　限定300セット`），且它是两件套的合集页、没有单一价，故记 `价格待确认`，**不伪造、也不从 alt 取值**（alt 是日文，取来会把日文带进中文产物）
- `chikuhodo-data.js` 651 KB

## 分类（21 个用途分类）

`セットブラシ`60、`アイシャドーブラシ`47、`リップブラシ`43、`パウダーブラシ`33、`チークブラシ`30、`ケース`23、`アイブローブラシ`14、`シャドーライナーブラシ`9、`ファンデーションブラシ`9、`ハイライトブラシ`8、`洗顔＆泡立てブラシ`7、`リキッドブラシ`7、`Men's`6、`スクリューブラシ`5、`コンシーラーブラシ`4、`ブレンディングブラシ`3、`アイライナーブラシ`3、`ブラシ＆コーム`2、`ノーズシャドーブラシ`1、`カンターブラシ`1、无分类 1。
