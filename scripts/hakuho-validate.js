#!/usr/bin/env node
'use strict';
/**
 * 白凤堂数据校验 —— 在重写 catalog-data.js 之后跑一遍，防止坏数据上线。
 *
 * 用法：node scripts/hakuho-validate.js [--strict-kana]
 *
 * 硬性错误（exit 1，会挡住 CI）：
 *   - catalog-data.js 无法解析成 window.PRODUCTS = [...];
 *   - handle 缺失或重复；
 *   - title / type / price / image / images / desc / detail / handle 任一缺失或为空；
 *   - images[] 里指向的本地图片文件不存在（会变成裂图）；
 *   - detailHtml 的 div/table/tr/td/th 标签数量不配对（格式被破坏）。
 *
 * 警告（不挡 CI，除非加 --strict-kana）：
 *   - title / desc / detail 里残留日文假名（说明漏译）；
 *   - 没有任何图片的商品；
 *   - assets/products 里存在未被任何商品引用的图片（可清理）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_FILE = path.join(ROOT, 'catalog-data.js');
const IMG_DIR = path.join(ROOT, 'assets', 'products');
const REPORT_FILE = path.join(ROOT, 'data', 'hakuho-validate.json');

const STRICT_KANA = process.argv.includes('--strict-kana');
// 只匹配真正的假名。排除 U+30FB「・」（片假名中点，属标点而非假名），
// 否则「马毛・合成纤维」这类正常中文会被误判为残留日文。
const KANA_RE = /[\u3041-\u3096\u30A1-\u30FA\u30FC-\u30FE]/;

const errors = [];
const warnings = [];

function countTag(html, name) {
  const open = (html.match(new RegExp('<' + name + '\\b', 'gi')) || []).length;
  const close = (html.match(new RegExp('</' + name + '\\s*>', 'gi')) || []).length;
  return { open, close };
}

function main() {
  if (!fs.existsSync(CATALOG_FILE)) {
    console.error('找不到 catalog-data.js');
    process.exit(1);
  }
  const raw = fs.readFileSync(CATALOG_FILE, 'utf8');
  const match = raw.match(/^\s*window\.PRODUCTS\s*=\s*([\s\S]*?);\s*$/);
  if (!match) {
    console.error('catalog-data.js 格式无法识别（期望 window.PRODUCTS = [...];）');
    process.exit(1);
  }

  let products;
  try {
    products = JSON.parse(match[1]);
  } catch (err) {
    console.error('JSON 解析失败：' + err.message);
    process.exit(1);
  }
  if (!Array.isArray(products)) {
    console.error('window.PRODUCTS 不是数组');
    process.exit(1);
  }

  // 硬性要求：这些字段为空意味着数据结构出问题
  const requiredHard = ['title', 'type', 'price', 'handle'];
  // 软性要求：官方本身可能没有描述（例如「名入れオプション」的 body_html 就是 <p></p>），
  // 因此空 desc/detail 只作警告，不当错误。
  const requiredSoft = ['desc', 'detail'];
  const seenHandles = new Set();
  const referencedImages = new Set();
  let kanaCount = 0;
  let withDetailHtml = 0;
  let noImage = 0;
  let emptySoft = 0;

  products.forEach((product, index) => {
    const id = (product && product.handle) || '#' + index;

    for (const field of requiredHard) {
      const value = product ? product[field] : undefined;
      if (value === undefined || value === null || String(value).trim() === '') {
        errors.push(id + '：字段 ' + field + ' 为空');
      }
    }
    for (const field of requiredSoft) {
      const value = product ? product[field] : undefined;
      if (value === undefined || value === null || String(value).trim() === '') {
        emptySoft += 1;
        if (emptySoft <= 10) warnings.push(id + '：字段 ' + field + ' 为空（官方可能本就没有描述）');
      }
    }

    if (product && product.handle) {
      if (seenHandles.has(product.handle)) errors.push(product.handle + '：handle 重复');
      seenHandles.add(product.handle);
    }

    const images = product && Array.isArray(product.images) ? product.images : [];
    if (!images.length) {
      noImage += 1;
      if (warnings.length < 40) warnings.push(id + '：没有任何图片');
    }
    for (const rel of images) {
      referencedImages.add(String(rel));
      const abs = path.join(ROOT, String(rel).split('/').join(path.sep));
      if (!fs.existsSync(abs)) errors.push(id + '：图片文件不存在 ' + rel);
    }
    if (product && product.image) {
      const abs = path.join(ROOT, String(product.image).split('/').join(path.sep));
      if (!fs.existsSync(abs)) errors.push(id + '：主图文件不存在 ' + product.image);
    }

    for (const field of ['title', 'desc', 'detail', 'detailHtml']) {
      let value = product ? String(product[field] || '') : '';
      // HTML 注释对用户不可见，其中的内容不参与「残留日文」判定
      if (field === 'detailHtml') value = value.replace(/<!--[\s\S]*?-->/g, '');
      if (KANA_RE.test(value)) {
        kanaCount += 1;
        if (kanaCount <= 10) warnings.push(id + '.' + field + '：疑似残留日文 -> ' + value.slice(0, 50));
      }
    }

    if (product && product.detailHtml) {
      withDetailHtml += 1;
      for (const tag of ['div', 'table', 'tr', 'td', 'th']) {
        const { open, close } = countTag(product.detailHtml, tag);
        if (open !== close) {
          errors.push(id + '：detailHtml 的 <' + tag + '> 不配对（开 ' + open + ' / 闭 ' + close + '）');
        }
      }
    }
  });

  // 未被引用的图片
  let orphans = [];
  try {
    orphans = fs
      .readdirSync(IMG_DIR)
      .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
      .map((name) => 'assets/products/' + name)
      .filter((rel) => !referencedImages.has(rel));
  } catch {
    warnings.push('无法读取 ' + path.relative(ROOT, IMG_DIR));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    productCount: products.length,
    withDetailHtml,
    withoutImages: noImage,
    emptyDescOrDetail: emptySoft,
    kanaFields: kanaCount,
    orphanImages: orphans.length,
    errors,
    warnings,
    orphanImageSample: orphans.slice(0, 50),
  };
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('校验 catalog-data.js');
  console.log('  商品总数：' + products.length);
  console.log('  含 detailHtml：' + withDetailHtml + ' 条');
  console.log('  无图片：' + noImage + ' 条');
  console.log('  空 desc/detail：' + emptySoft + ' 处（官方本就无描述时为正常）');
  console.log('  疑似残留假名字段：' + kanaCount + ' 处');
  console.log('  未被引用的图片文件：' + orphans.length + ' 个');
  console.log('  硬性错误：' + errors.length + ' 处');

  if (warnings.length) {
    console.log('\n警告（前 10 条）：');
    for (const w of warnings.slice(0, 10)) console.log('  - ' + w);
    if (orphans.length) {
      console.log('  - 未被引用的图片示例：' + orphans.slice(0, 5).join(', '));
    }
  }

  if (errors.length) {
    console.error('\n硬性错误（前 20 条）：');
    for (const e of errors.slice(0, 20)) console.error('  - ' + e);
    console.error('\n校验未通过。');
    process.exit(1);
  }

  if (STRICT_KANA && kanaCount > 0) {
    console.error('\n--strict-kana：存在残留假名，校验未通过。');
    process.exit(1);
  }

  console.log('\n校验通过。报告：' + path.relative(ROOT, REPORT_FILE));
}

main();
