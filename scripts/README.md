# 白凤堂商品数据重建管线

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
