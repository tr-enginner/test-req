import type { Chapter2DynamicTable, Chapter2SystemOverview } from "../schema/chapter2-system-overview"
import { writeZip, type ZipEntry } from "./docx-zip"
import { formatTestRequirementsDocx } from "./test-requirements-docx-format"

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;")
const run = (text: string, bold = false) => `<w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
const paragraph = (text: string, style?: string, indent = style === undefined, centered = false) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${indent ? '<w:ind w:firstLine="480"/>' : ""}${centered ? '<w:jc w:val="center"/>' : ""}<w:spacing w:after="100"/></w:pPr>${run(text)}</w:p>`
const cell = (text: string, width: number, header = false) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(text, header)}</w:p></w:tc>`
const borders = '<w:tblBorders><w:top w:val="single" w:sz="8"/><w:left w:val="single" w:sz="8"/><w:bottom w:val="single" w:sz="8"/><w:right w:val="single" w:sz="8"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>'

function alphabeticIndex(index: number): string {
  let value = index + 1
  let result = ""
  while (value > 0) {
    value--
    result = String.fromCharCode(97 + value % 26) + result
    value = Math.floor(value / 26)
  }
  return result
}

function table(columns: string[], rows: string[][]): string {
  const total = 8300
  const width = Math.floor(total / columns.length)
  const widths = columns.map((_, index) => index === columns.length - 1 ? total - width * (columns.length - 1) : width)
  const allRows = [columns, ...rows]
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>${borders}</w:tblPr><w:tblGrid>${widths.map((value) => `<w:gridCol w:w="${value}"/>`).join("")}</w:tblGrid>${allRows.map((row, rowIndex) => `<w:tr>${row.map((value, columnIndex) => cell(value, widths[columnIndex], rowIndex === 0)).join("")}</w:tr>`).join("")}</w:tbl>`
}

export function cleanChapter2TableTitle(value: string, fallback = "存储器及I/O使用说明"): string {
  const normalized = value
    .replace(/<\/?w:[A-Za-z][^>]*>/giu, "")
    .replace(/<\/?wt\b[^>]*>/giu, "")
    .replace(/\s+/gu, " ")
    .trim()
  if (!normalized) return fallback
  const sourceTableNumber = String.raw`(?:表格|附表|表)\s*(?:\d+|[A-Za-zＡ-Ｚａ-ｚ]+)(?:\s*[.．\-－—]\s*\d+)*`
  if (new RegExp(`^${sourceTableNumber}\\s*$`, "u").test(normalized)) return fallback
  return normalized.replace(
    new RegExp(`^${sourceTableNumber}(?:\\s*[：:、]\\s*|\\s+|(?=[A-Za-zＡ-Ｚａ-ｚ\\u4e00-\\u9fff]))`, "u"),
    "",
  ).trim() || fallback
}

function memoryTableBlocks(items: Chapter2DynamicTable[], firstNumber: number): { blocks: string[]; nextNumber: number } {
  const blocks: string[] = []
  let number = firstNumber
  for (const item of items) {
    const title = cleanChapter2TableTitle(item.title)
    blocks.push(paragraph(`表2-${number}  ${title}`, "TableTitle", false, true), table(item.columns, item.rows))
    number++
  }
  return { blocks, nextNumber: number }
}

export function formatChapter2Processor(processorType: string, processorFrequency: string): string {
  const type = processorType.trim()
  const frequency = processorFrequency.trim()
  if (type && frequency) return `CPU：${type}，主频：${frequency}`
  if (type) return `CPU：${type}`
  if (frequency) return `主频：${frequency}`
  return ""
}

export function formatChapter2MemorySummary(summary: string, tableCount: number): string {
  const text = summary.trim()
  if (tableCount <= 0) return text
  const separator = text && !/[。！？.!?]$/u.test(text) ? "。" : ""
  const tableReference = tableCount === 1 ? "表2-1" : `表2-1至表2-${tableCount}`
  return `${text}${separator}具体见${tableReference}。`
}

function documentXml(model: Chapter2SystemOverview): string {
  const memory = memoryTableBlocks(model.memory_io_tables, 1)
  const interruptRows = model.interrupts.map((item) => [item.interrupt_name, item.priority, item.frequency_or_random, item.trigger_mode, item.execution_function])
  const processor = formatChapter2Processor(model.processor_type, model.processor_frequency)
  const softwareLead = `${model.software_name_and_id}，等级为${model.software_level}，编程语言为${model.programming_language}，研制单位为${model.developer_unit_name}。`
  const development = [
    model.development_platform ? `软件开发平台为${model.development_platform}` : "",
    model.compilation_environment ? `编译环境为${model.compilation_environment}` : "",
  ].filter(Boolean).join("，")
  const blocks = [
    paragraph("2 系统概述", "Heading1"),
    paragraph("2.1 运行环境说明", "Heading2"),
    paragraph(model.system_relationship),
    paragraph(`a. ${processor}`),
    paragraph(`b. ${formatChapter2MemorySummary(model.memory_io_summary, model.memory_io_tables.length)}`),
    ...memory.blocks,
    paragraph("c. 中断使用情况如下表："),
    paragraph(`表2-${memory.nextNumber}  中断使用说明`, "TableTitle", false, true),
    table(["中断名称", "优先级", "周期（触发频率）/随机（频繁/偶发）", "触发方式", "执行功能"], interruptRows),
    paragraph("2.2 软件概述", "Heading2"),
    paragraph(softwareLead),
    paragraph("软件主要功能如下："),
    ...model.subsystem_and_software_functions.map((item, index) => paragraph(`${alphabeticIndex(index)}. ${item}${/[；。]$/.test(item) ? "" : "；"}`)),
    paragraph("2.3 开发环境概述", "Heading2"),
    paragraph(`${development}${development ? "。" : ""}`),
  ]
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + blocks.join("") + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr></w:body></w:document>'
}

const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:eastAsia="SimHei"/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:eastAsia="SimHei"/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableTitle"><w:name w:val="Table Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style></w:styles>'

export function renderChapter2SystemOverviewDocx(model: Chapter2SystemOverview): Buffer {
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>') },
    { path: "_rels/.rels", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { path: "word/document.xml", data: Buffer.from(documentXml(model), "utf-8") },
    { path: "word/styles.xml", data: Buffer.from(styles) },
    { path: "word/_rels/document.xml.rels", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
  ]
  return formatTestRequirementsDocx(writeZip(entries), { addPageNumbers: false })
}
