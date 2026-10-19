#!/usr/bin/env bun
/**
 * create-issue-report-template.ts
 *
 * Generates the initial templates/issue-report.docx template file.
 * This is a one-time script — the generated template can be customized in Word.
 *
 * The template contains placeholder markers like {{project_name}}, {{id}}, etc.
 * The issue-report-generator tool replaces these at runtime.
 *
 * Usage: bun scripts/create-issue-report-template.ts
 */

import { writeFileSync, mkdirSync, existsSync } from "fs"
import { dirname, join } from "path"
import { writeZip, type ZipEntry } from "../src/tools/docx-zip"

// ─── XML Building Blocks ───────────────────────────────────────────

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const WORD_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="SimSun" w:eastAsia="SimSun" w:hAnsi="SimSun"/>
        <w:sz w:val="21"/>
        <w:szCs w:val="21"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr>
      <w:jc w:val="center"/>
      <w:spacing w:before="240" w:after="240"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="SimHei" w:eastAsia="SimHei" w:hAnsi="SimHei"/>
      <w:b/>
      <w:sz w:val="36"/>
      <w:szCs w:val="36"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr>
      <w:spacing w:before="200" w:after="120"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="SimHei" w:eastAsia="SimHei" w:hAnsi="SimHei"/>
      <w:b/>
      <w:sz w:val="28"/>
      <w:szCs w:val="28"/>
    </w:rPr>
  </w:style>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:tblPr>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/>
      </w:tblBorders>
    </w:tblPr>
  </w:style>
</w:styles>`

// ─── XML Helpers ───────────────────────────────────────────────────

function escXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function para(text: string, opts?: {
  style?: string; bold?: boolean; fontSize?: number; center?: boolean
}): string {
  const pPrParts: string[] = []
  const rPrParts: string[] = []

  if (opts?.style) pPrParts.push(`<w:pStyle w:val="${opts.style}"/>`)
  if (opts?.center) pPrParts.push(`<w:jc w:val="center"/>`)
  if (opts?.bold) rPrParts.push(`<w:b/>`)
  if (opts?.fontSize) {
    rPrParts.push(`<w:sz w:val="${opts.fontSize}"/>`)
    rPrParts.push(`<w:szCs w:val="${opts.fontSize}"/>`)
  }

  const pPr = pPrParts.length > 0 ? `<w:pPr>${pPrParts.join("")}</w:pPr>` : ""
  const rPr = rPrParts.length > 0 ? `<w:rPr>${rPrParts.join("")}</w:rPr>` : ""

  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`
}

function cell(text: string, opts?: {
  width?: number; bold?: boolean; shading?: string; center?: boolean
}): string {
  const tcPrParts: string[] = []
  if (opts?.width) tcPrParts.push(`<w:tcW w:w="${opts.width}" w:type="dxa"/>`)
  if (opts?.shading) tcPrParts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${opts.shading}"/>`)
  tcPrParts.push(`<w:tcMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar>`)

  const tcPr = `<w:tcPr>${tcPrParts.join("")}</w:tcPr>`
  return `<w:tc>${tcPr}${para(text, { bold: opts?.bold, center: opts?.center })}</w:tc>`
}

function tr(cells: string[]): string {
  return `<w:tr>${cells.join("")}</w:tr>`
}

function tbl(columnWidths: number[], rows: string[]): string {
  const totalWidth = columnWidths.reduce((a, b) => a + b, 0)
  const gridCols = columnWidths.map(w => `<w:gridCol w:w="${w}"/>`).join("")
  return `<w:tbl>
<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblLook w:val="04A0"/></w:tblPr>
<w:tblGrid>${gridCols}</w:tblGrid>
${rows.join("\n")}
</w:tbl>`
}

// ─── Document Content ──────────────────────────────────────────────

function buildDocumentXml(): string {
  const body: string[] = []

  // Title
  body.push(para("软件测试问题报告单", { style: "Heading1" }))
  body.push(para(""))

  // Project info table
  body.push(tbl([2400, 6960], [
    tr([
      cell("项目名称", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{project_name}}", { width: 6960 }),
    ]),
    tr([
      cell("生成日期", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{date}}", { width: 6960 }),
    ]),
  ]))
  body.push(para(""))

  // Summary section
  body.push(para("缺陷统计摘要", { style: "Heading2" }))
  body.push(para(""))

  // Severity stats
  body.push(tbl([2340, 2340, 2340, 2340], [
    tr([
      cell("总计", { width: 2340, bold: true, shading: "D9E2F3", center: true }),
      cell("致命", { width: 2340, bold: true, shading: "F4CCCC", center: true }),
      cell("严重", { width: 2340, bold: true, shading: "FCE5CD", center: true }),
      cell("一般", { width: 2340, bold: true, shading: "D9EAD3", center: true }),
    ]),
    tr([
      cell("{{total}}", { width: 2340, center: true }),
      cell("{{by_severity_critical}}", { width: 2340, center: true }),
      cell("{{by_severity_major}}", { width: 2340, center: true }),
      cell("{{by_severity_minor}}", { width: 2340, center: true }),
    ]),
  ]))
  body.push(para(""))

  // Source stats
  body.push(tbl([1872, 1872, 1872, 1872, 1872], [
    tr([
      cell("静态分析", { width: 1872, bold: true, shading: "D9E2F3", center: true }),
      cell("代码审查", { width: 1872, bold: true, shading: "D9E2F3", center: true }),
      cell("单元测试", { width: 1872, bold: true, shading: "D9E2F3", center: true }),
      cell("确认测试", { width: 1872, bold: true, shading: "D9E2F3", center: true }),
      cell("中断审查", { width: 1872, bold: true, shading: "D9E2F3", center: true }),
    ]),
    tr([
      cell("{{by_source_static_analysis}}", { width: 1872, center: true }),
      cell("{{by_source_code_review}}", { width: 1872, center: true }),
      cell("{{by_source_unit_test}}", { width: 1872, center: true }),
      cell("{{by_source_confirmation_test}}", { width: 1872, center: true }),
      cell("{{by_source_interrupt_review}}", { width: 1872, center: true }),
    ]),
  ]))
  body.push(para(""))

  body.push(para("未关闭致命缺陷数: {{open_critical}}", { bold: true }))
  body.push(para(""))

  // Defect detail section
  body.push(para("缺陷明细", { style: "Heading2" }))
  body.push(para(""))

  // Defect detail table — key-value layout, one block per defect
  // The tool identifies rows containing {{id}} as the repeating block boundary
  body.push(tbl([2400, 6960], [
    tr([
      cell("序号", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{seq}}", { width: 6960 }),
    ]),
    tr([
      cell("缺陷编号", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{id}}", { width: 6960 }),
    ]),
    tr([
      cell("问题标题", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{title}}", { width: 6960 }),
    ]),
    tr([
      cell("严重程度", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{severity}}", { width: 6960 }),
    ]),
    tr([
      cell("缺陷类别", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{category}}", { width: 6960 }),
    ]),
    tr([
      cell("发现来源", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{source}}", { width: 6960 }),
    ]),
    tr([
      cell("定位信息", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{location}}", { width: 6960 }),
    ]),
    tr([
      cell("问题描述", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{description}}", { width: 6960 }),
    ]),
    tr([
      cell("相关规则", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{rule_id}}", { width: 6960 }),
    ]),
    tr([
      cell("关联需求", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{related_reqs}}", { width: 6960 }),
    ]),
    tr([
      cell("当前状态", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{status}}", { width: 6960 }),
    ]),
    tr([
      cell("发现人/工具", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{detected_by}}", { width: 6960 }),
    ]),
    tr([
      cell("发现日期", { width: 2400, bold: true, shading: "D9E2F3" }),
      cell("{{detected_date}}", { width: 6960 }),
    ]),
  ]))

  const sectPr = `<w:sectPr>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/>
</w:sectPr>`

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${body.join("\n")}
${sectPr}
</w:body>
</w:document>`
}

// ─── Main ──────────────────────────────────────────────────────────

const entries: ZipEntry[] = [
  { path: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf-8") },
  { path: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf-8") },
  { path: "word/_rels/document.xml.rels", data: Buffer.from(WORD_RELS, "utf-8") },
  { path: "word/document.xml", data: Buffer.from(buildDocumentXml(), "utf-8") },
  { path: "word/styles.xml", data: Buffer.from(STYLES, "utf-8") },
]

const zipBuffer = writeZip(entries)
const outputPath = join(import.meta.dir, "..", "templates", "issue-report.docx")
const outputDir = dirname(outputPath)
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
writeFileSync(outputPath, zipBuffer)

console.log(`Template created: templates/issue-report.docx (${zipBuffer.length} bytes)`)
