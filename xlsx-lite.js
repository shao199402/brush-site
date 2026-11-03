/**
 * xlsx-lite —— 零依赖的最小 XLSX 生成器
 * ═══════════════════════════════════════════════════════════════════
 * 为什么要自己写：
 *   后台是纯静态页面，不想引 SheetJS 那种几百 KB 的 CDN 依赖（离线/被墙就废）。
 *   而 Excel 的 .xlsx 本质是一个 ZIP，里面装几份 XML。用「不压缩存储」模式
 *   生成 ZIP 完全可行（Excel 接受），再加上基本的样式表就是一份正常人能打开的表格。
 *
 * 支持：
 *   · 多个工作表
 *   · 表头样式（底色、白字、加粗）、正文样式
 *   · 列宽、冻结首行、自动筛选
 *   · 数字/金额格式、自动换行
 *
 * 用法：
 *   const bytes = XlsxLite.build({
 *     sheets: [{
 *       name: '订单',
 *       columns: [{ header: '时间', width: 20 }, ...],
 *       rows: [['2026-10-27', ...], ...],
 *       moneyCols: [8],        // 需要千分位两位小数的列下标（0 起）
 *     }],
 *   });
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XlsxLite = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ───────── CRC32（ZIP 校验用）───────── */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const utf8 = (s) => {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return Buffer.from(s, 'utf8');
  };

  /* ───────── 最小 ZIP 写入器（store 模式，不压缩）───────── */
  function makeZip(files) {
    // files: [{ name, data: Uint8Array }]
    const chunks = [];
    const central = [];
    let offset = 0;

    const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

    for (const f of files) {
      const nameBytes = utf8(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      // 本地文件头
      const local = [
        0x50, 0x4B, 0x03, 0x04,      // signature
        ...u16(20),                  // version needed
        ...u16(0),                   // flags
        ...u16(0),                   // method = 0 (store)
        ...u16(0), ...u16(0),        // time, date
        ...u32(crc),
        ...u32(size), ...u32(size),  // compressed = uncompressed
        ...u16(nameBytes.length),
        ...u16(0),                   // extra len
      ];
      const localBytes = new Uint8Array(local.length + nameBytes.length + size);
      localBytes.set(local, 0);
      localBytes.set(nameBytes, local.length);
      localBytes.set(f.data, local.length + nameBytes.length);

      chunks.push(localBytes);

      // 中央目录项
      central.push([
        0x50, 0x4B, 0x01, 0x02,
        ...u16(20), ...u16(20),
        ...u16(0), ...u16(0),
        ...u16(0), ...u16(0),
        ...u32(crc), ...u32(size), ...u32(size),
        ...u16(nameBytes.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0),
        ...u32(offset),
        ...Array.from(nameBytes),
      ]);

      offset += localBytes.length;
    }

    const centralBytes = central.flat();
    const eocd = [
      0x50, 0x4B, 0x05, 0x06,
      ...u16(0), ...u16(0),
      ...u16(files.length), ...u16(files.length),
      ...u32(centralBytes.length), ...u32(offset),
      ...u16(0),
    ];

    const total = offset + centralBytes.length + eocd.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    out.set(new Uint8Array(centralBytes), p); p += centralBytes.length;
    out.set(new Uint8Array(eocd), p);
    return out;
  }

  /* ───────── XML 工具 ───────── */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // 去掉 XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  function colName(n) {            // 0 → A, 25 → Z, 26 → AA
    let s = '';
    n += 1;
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  /* ───────── 样式表 ─────────
   * 0: 默认
   * 1: 表头（深色底、白字、加粗、居中）
   * 2: 正文（自动换行、顶端对齐）
   * 3: 正文（自动换行 + 金额格式 ¥#,##0.00）
   * 4: 正文（居中，用于状态/数量）
   */
  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/>
  </numFmts>
  <fonts count="4">
    <font><sz val="11"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>
    <font><sz val="10"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="13"/><color rgb="FF17151A"/><name val="Microsoft YaHei"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF17151A"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF7F3EC"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFE0DACE"/></left>
      <right style="thin"><color rgb="FFE0DACE"/></right>
      <top style="thin"><color rgb="FFE0DACE"/></top>
      <bottom style="thin"><color rgb="FFE0DACE"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1">
      <alignment vertical="top" wrapText="1"/>
    </xf>
    <xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1">
      <alignment horizontal="right" vertical="top"/>
    </xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1">
      <alignment horizontal="center" vertical="top" wrapText="1"/>
    </xf>
    <!-- 5：合并单元格用，垂直居中（一个订单跨多行商品时看起来才不歪） -->
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1">
      <alignment vertical="center" wrapText="1"/>
    </xf>
  </cellXfs>
  <!-- 缺少这一段时 openpyxl 会警告 "no default style"，Excel 也可能提示需要修复 -->
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;

  /* ───────── 工作表 XML ───────── */
  function sheetXml(sheet) {
    const cols = sheet.columns || [];
    const rows = sheet.rows || [];
    const moneyCols = new Set(sheet.moneyCols || []);
    const centerCols = new Set(sheet.centerCols || []);
    const headerHeight = sheet.headerHeight || 30;

    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');

    /*
     * ⚠ 元素顺序必须按 OOXML 规范：
     *   sheetPr → dimension → sheetViews → sheetFormatPr → cols → sheetData
     *   把 <cols> 写到 <sheetViews> 之前，openpyxl 能读，但 Excel 打开会提示
     *   「发现不可读取的内容 / 需要修复」。
     */

    // 冻结首行（表头）
    parts.push('<sheetViews><sheetView workbookViewId="0" tabSelected="' + (sheet.selected ? 1 : 0) + '">'
      + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      + '</sheetView></sheetViews>');

    parts.push('<sheetFormatPr defaultRowHeight="20"/>');

    // 列宽
    if (cols.length) {
      parts.push('<cols>');
      cols.forEach((c, i) => {
        const w = c.width || 16;
        parts.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>');
      });
      parts.push('</cols>');
    }

    // 表头
    parts.push('<sheetData>');
    if (cols.length) {
      parts.push('<row r="1" ht="' + headerHeight + '" customHeight="1">');
      cols.forEach((c, i) => {
        parts.push('<c r="' + colName(i) + '1" t="inlineStr" s="1"><is><t>' + esc(c.header) + '</t></is></c>');
      });
      parts.push('</row>');
    }

    // 数据行
    const mergedCols = new Set(sheet.mergedCols || []);
    rows.forEach((row, ri) => {
      const r = ri + 2;
      parts.push('<row r="' + r + '">');
      row.forEach((val, ci) => {
        const ref = colName(ci) + r;
        // 合并列用居中对齐的样式，避免一个订单跨多行时文字贴在顶上
        const base = mergedCols.has(ci) ? 5 : 2;
        if (val === null || val === undefined || val === '') {
          parts.push('<c r="' + ref + '" s="' + base + '"/>');
          return;
        }
        if (typeof val === 'number' && Number.isFinite(val)) {
          const style = moneyCols.has(ci) ? 3 : (centerCols.has(ci) ? 4 : base);
          parts.push('<c r="' + ref + '" s="' + style + '"><v>' + val + '</v></c>');
        } else {
          const style = centerCols.has(ci) ? 4 : base;
          parts.push('<c r="' + ref + '" t="inlineStr" s="' + style + '"><is><t xml:space="preserve">' + esc(val) + '</t></is></c>');
        }
      });
      parts.push('</row>');
    });

    parts.push('</sheetData>');

    /*
     * 合并单元格：ref 形如 "A2:A4"。
     * 注意合并区域里只有首格有值，其余格必须是空的，
     * 否则 Excel 打开会提示「修复」。
     */
    const merges = sheet.merges || [];
    if (merges.length) {
      parts.push('<mergeCells count="' + merges.length + '">');
      merges.forEach((m) => parts.push('<mergeCell ref="' + m + '"/>'));
      parts.push('</mergeCells>');
    }

    // 自动筛选：有合并单元格时不加（筛选和合并同时用，Excel 行为很怪）
    if (sheet.autoFilter !== false && cols.length && rows.length && !merges.length) {
      const last = colName(cols.length - 1) + (rows.length + 1);
      parts.push('<autoFilter ref="A1:' + last + '"/>');
    }

    parts.push('</worksheet>');
    return parts.join('');
  }

  /* ───────── 主入口 ───────── */
  function build(opts) {
    const sheets = opts.sheets || [];
    if (!sheets.length) throw new Error('至少要有一个工作表');

    const files = [];

    // [Content_Types].xml
    const ct = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ];
    sheets.forEach((s, i) => {
      ct.push('<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    });
    ct.push('</Types>');
    files.push({ name: '[Content_Types].xml', data: utf8(ct.join('')) });

    // _rels/.rels
    files.push({
      name: '_rels/.rels',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>'),
    });

    // xl/workbook.xml
    const wbSheets = sheets.map((s, i) =>
      '<sheet name="' + esc(s.name || ('Sheet' + (i + 1))) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>');
    files.push({
      name: 'xl/workbook.xml',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets>' + wbSheets.join('') + '</sheets>'
        + '<workbookPr/>'
        + '</workbook>'),
    });

    // xl/_rels/workbook.xml.rels
    const wbRels = sheets.map((s, i) =>
      '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>');
    wbRels.push('<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + wbRels.join('') + '</Relationships>'),
    });

    // 样式
    files.push({ name: 'xl/styles.xml', data: utf8(STYLES_XML) });

    // 各工作表
    sheets.forEach((s, i) => {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(s)) });
    });

    return makeZip(files);
  }

  return { build, crc32, colName };
});
