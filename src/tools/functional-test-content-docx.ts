import { normalizeLocalTables } from "../shared/phase2-tolerance"
import { phase2Warning } from "../shared/phase2-tolerance"
import { writeZip, type ZipEntry } from "./docx-zip"
import { formatTestRequirementsDocx } from "./test-requirements-docx-format"
import { FIXED_FUNCTIONAL_TEST_REQUIREMENTS } from "./functional-test-requirements"
import { formatFunctionalFlowItems } from "./functional-flow-format"

interface FunctionalInitTable {
  table_id?: string
  table_no?: string
  title?: string
  columns?: string[]
  rows?: Array<Record<string, unknown>>
}

interface FunctionalInitItem {
  summary?: string
  input_flow?: string[]
  processing?: FunctionalOtherProcessingItem[]
  output_flow?: string[]
  tables?: FunctionalInitTable[]
}

interface FunctionalOtherProcessingItem {
  requirement_id?: string
  content?: string
  table_refs?: string[]
}

interface FunctionalOtherItem {
  summary?: string
  input_flow?: string[]
  processing?: FunctionalOtherProcessingItem[]
  output_flow?: string[]
  tables?: FunctionalInitTable[]
}

interface FunctionalTestContentNode {
  title_no?: string
  title?: string
  tr_code?: string
  source_ref?: string
  content_type?: "initialization" | "other" | null
  init_content?: FunctionalInitItem
  other_content?: FunctionalOtherItem
  children?: FunctionalTestContentNode[]
}

interface FunctionalTestContentArtifact {
  chapter_title_no?: string
  chapter_title?: string
  section_title_no?: string
  section_title?: string
  children?: FunctionalTestContentNode[]
}

const TABLE_COLUMNS = ["名称", "地址/寄存器地址", "初值", "初值含义"] as const
const TABLE_WIDTHS = [1800, 2000, 1200, 4026]
const CONTENT_FIRST_LINE_INDENT_TWIPS = 480

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function buildTextRuns(text: string, runProperties = ""): string {
  const parts = text.split(/\r?\n/)
  return parts.map((part, index) => {
    const escaped = escapeXml(part)
    const spaceAttr = /^[\s]|[\s]$/.test(part) ? ' xml:space="preserve"' : ""
    const rPr = runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ""
    const run = `<w:r>${rPr}<w:t${spaceAttr}>${escaped}</w:t></w:r>`
    return index === 0 ? run : `<w:r><w:br/></w:r>${run}`
  }).join("")
}

function buildParagraph(
  text: string,
  options: {
    styleId?: string
    spacingBefore?: number
    spacingAfter?: number
    firstLineIndent?: number
  } = {},
): string {
  const props: string[] = []
  if (options.styleId) props.push(`<w:pStyle w:val="${options.styleId}"/>`)
  if (typeof options.spacingBefore === "number" || typeof options.spacingAfter === "number") {
    props.push(`<w:spacing w:before="${options.spacingBefore ?? 0}" w:after="${options.spacingAfter ?? 0}"/>`)
  }
  if (typeof options.firstLineIndent === "number") {
    props.push(`<w:ind w:firstLine="${options.firstLineIndent}"/>`)
  }
  const pPr = props.length > 0 ? `<w:pPr>${props.join("")}</w:pPr>` : ""
  return `<w:p>${pPr}${buildTextRuns(text)}</w:p>`
}

function headingStyleForTitleNo(titleNo: string): string {
  const depth = titleNo.split(".").filter(Boolean).length
  if (depth <= 1) return "Heading1"
  if (depth === 2) return "Heading2"
  if (depth === 3) return "Heading3"
  if (depth === 4) return "Heading4"
  return "Heading5"
}

function buildFlowParagraphs(values: string[] | undefined): string[] {
  return formatFunctionalFlowItems(values).map((value) => buildParagraph(value, {
    spacingAfter: 80,
    firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
  }))
}

function buildCell(text: string, width: number, isHeader = false): string {
  const shading = isHeader ? '<w:shd w:fill="D9EAF7"/>' : ""
  const bold = isHeader ? "<w:b/>" : ""
  return [
    "<w:tc>",
    `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shading}</w:tcPr>`,
    `<w:p>${buildTextRuns(text, bold)}</w:p>`,
    "</w:tc>",
  ].join("")
}

function buildTable(table: FunctionalInitTable): string {
  const rows = Array.isArray(table.rows) ? table.rows : []
  const blocks: string[] = [
    "<w:tbl>",
    [
      "<w:tblPr>",
      '<w:tblW w:w="9026" w:type="dxa"/>',
      '<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>',
      "</w:tblPr>",
    ].join(""),
    `<w:tblGrid>${TABLE_WIDTHS.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`,
    "<w:tr>",
    ...TABLE_COLUMNS.map((column, index) => buildCell(column, TABLE_WIDTHS[index], true)),
    "</w:tr>",
  ]

  for (const row of rows) {
    blocks.push("<w:tr>")
    TABLE_COLUMNS.forEach((column, index) => {
      blocks.push(buildCell(textOf(row[column]), TABLE_WIDTHS[index]))
    })
    blocks.push("</w:tr>")
  }

  blocks.push("</w:tbl>")
  return blocks.join("")
}

function buildGenericTable(table: FunctionalInitTable): string {
  const columns = Array.isArray(table.columns) ? table.columns.map((column) => textOf(column)).filter(Boolean) : []
  const rows = Array.isArray(table.rows) ? table.rows : []
  const baseWidth = Math.floor(9026 / Math.max(columns.length, 1))
  const widths = columns.map((_, index) => index === columns.length - 1 ? 9026 - baseWidth * index : baseWidth)
  const blocks: string[] = [
    "<w:tbl>",
    [
      "<w:tblPr>",
      '<w:tblW w:w="9026" w:type="dxa"/>',
      '<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>',
      "</w:tblPr>",
    ].join(""),
    `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`,
    "<w:tr>",
    ...columns.map((column, index) => buildCell(column, widths[index], true)),
    "</w:tr>",
  ]
  for (const row of rows) {
    blocks.push("<w:tr>")
    columns.forEach((column, index) => blocks.push(buildCell(textOf(row[column]), widths[index])))
    blocks.push("</w:tr>")
  }
  blocks.push("</w:tbl>")
  return blocks.join("")
}

function buildInitializationContentBlocks(item: FunctionalInitItem, titleNo: string): string[] {
  item = normalizeLocalTables({ ...item, title_no: titleNo })
  const blocks: string[] = []
  const summary = textOf(item.summary)
  if (summary) {
    blocks.push(buildParagraph(summary, {
      spacingAfter: 120,
      firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
    }))
  }

  blocks.push(buildParagraph(`${titleNo}.1 输入流说明`, { styleId: headingStyleForTitleNo(`${titleNo}.1`), spacingBefore: 120, spacingAfter: 80 }))
  blocks.push(...buildFlowParagraphs(item.input_flow))

  blocks.push(buildParagraph(`${titleNo}.2 处理`, { styleId: headingStyleForTitleNo(`${titleNo}.2`), spacingBefore: 120, spacingAfter: 80 }))
  const tables = Array.isArray(item.tables) ? item.tables : []
  const tablesById = new Map(tables.map((table) => [textOf(table.table_id), table]))
  const renderedTables = new Set<unknown>()
  const attemptedTables = new Set<unknown>()
  for (const processingItem of Array.isArray(item.processing) ? item.processing : []) {
    blocks.push(buildParagraph(`${textOf(processingItem.requirement_id)}：${textOf(processingItem.content)}`, {
      spacingAfter: 80,
      firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
    }))
    for (const tableRef of Array.isArray(processingItem.table_refs) ? processingItem.table_refs : []) {
      const table = tablesById.get(textOf(tableRef))
      if (!table) continue
      const tableNo = textOf(table.table_no)
      if (renderedTables.has(table)) { blocks.push(buildParagraph(`具体初始化设置见${tableNo}。`, { spacingAfter: 80, firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS })); continue }
      if (attemptedTables.has(table)) continue
      attemptedTables.add(table)
      try {
        const xml = buildTable(table)
        blocks.push(buildParagraph(`具体初始化设置见${tableNo}。`, { spacingAfter: 80, firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS }))
        blocks.push(buildParagraph(`${tableNo} ${textOf(table.title)}`, { styleId: "TableTitle", spacingBefore: 120, spacingAfter: 80 }))
        blocks.push(xml)
        renderedTables.add(table)
      } catch (error) { phase2Warning(String(error), 1) }
    }
  }

  for (const table of tables) {
    if (attemptedTables.has(table)) continue
    attemptedTables.add(table)
    try {
      const xml = buildTable(table)
      blocks.push(buildParagraph(`${textOf(table.table_no)} ${textOf(table.title)}`, { styleId: "TableTitle" }), xml)
      renderedTables.add(table)
    } catch (error) { phase2Warning(String(error), 1) }
  }

  blocks.push(buildParagraph(`${titleNo}.3 输出流说明`, { styleId: headingStyleForTitleNo(`${titleNo}.3`), spacingBefore: 120, spacingAfter: 80 }))
  blocks.push(...buildFlowParagraphs(item.output_flow))

  blocks.push(buildParagraph(`${titleNo}.4 测试要求`, { styleId: headingStyleForTitleNo(`${titleNo}.4`), spacingBefore: 120, spacingAfter: 80 }))
  blocks.push(buildParagraph(`测试充分性要求：${FIXED_FUNCTIONAL_TEST_REQUIREMENTS.sufficiency}；`, {
    spacingAfter: 80,
    firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
  }))
  blocks.push(buildParagraph(`测试终止要求：${FIXED_FUNCTIONAL_TEST_REQUIREMENTS.termination}；`, {
    spacingAfter: 80,
    firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
  }))
  blocks.push(buildParagraph(`优先级：所有需求项为${FIXED_FUNCTIONAL_TEST_REQUIREMENTS.priority}。`, {
    spacingAfter: 120,
    firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
  }))

  return blocks
}

function buildOtherContentBlocks(item: FunctionalOtherItem, titleNo: string): string[] {
  item = normalizeLocalTables({ ...item, title_no: titleNo })
  const blocks: string[] = []
  const summary = textOf(item.summary)
  if (summary) {
    blocks.push(buildParagraph(summary, {
      spacingAfter: 120,
      firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
    }))
  }

  blocks.push(buildParagraph(`${titleNo}.1 输入流说明`, { styleId: headingStyleForTitleNo(`${titleNo}.1`), spacingBefore: 120, spacingAfter: 80 }))
  blocks.push(...buildFlowParagraphs(item.input_flow))

  blocks.push(buildParagraph(`${titleNo}.2 处理`, { styleId: headingStyleForTitleNo(`${titleNo}.2`), spacingBefore: 120, spacingAfter: 80 }))
  const tables = Array.isArray(item.tables) ? item.tables : []
  const tablesById = new Map(tables.map((table) => [textOf(table.table_id), table]))
  const renderedTables = new Set<unknown>()
  const attemptedTables = new Set<unknown>()
  for (const processingItem of Array.isArray(item.processing) ? item.processing : []) {
    blocks.push(buildParagraph(`${textOf(processingItem.requirement_id)}：${textOf(processingItem.content)}`, {
      spacingAfter: 80,
      firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
    }))
    for (const tableRef of Array.isArray(processingItem.table_refs) ? processingItem.table_refs : []) {
      const table = tablesById.get(textOf(tableRef))
      if (!table) continue
      const tableNo = textOf(table.table_no)
      if (renderedTables.has(table)) { blocks.push(buildParagraph(`详细格式见${tableNo}。`, { spacingAfter: 80, firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS })); continue }
      if (attemptedTables.has(table)) continue
      attemptedTables.add(table)
      try {
        const xml = buildGenericTable(table)
        blocks.push(buildParagraph(`详细格式见${tableNo}。`, { spacingAfter: 80, firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS }))
        blocks.push(buildParagraph(`${tableNo} ${textOf(table.title)}`, { styleId: "TableTitle", spacingBefore: 120, spacingAfter: 80 }))
        blocks.push(xml)
        renderedTables.add(table)
      } catch (error) { phase2Warning(String(error), 1) }
    }
  }

  for (const table of tables) {
    if (attemptedTables.has(table)) continue
    attemptedTables.add(table)
    try {
      const xml = buildGenericTable(table)
      blocks.push(buildParagraph(`${textOf(table.table_no)} ${textOf(table.title)}`, { styleId: "TableTitle" }), xml)
      renderedTables.add(table)
    } catch (error) { phase2Warning(String(error), 1) }
  }

  blocks.push(buildParagraph(`${titleNo}.3 输出流说明`, { styleId: headingStyleForTitleNo(`${titleNo}.3`), spacingBefore: 120, spacingAfter: 80 }))
  blocks.push(...buildFlowParagraphs(item.output_flow))

  blocks.push(buildParagraph(`${titleNo}.4 测试要求`, { styleId: headingStyleForTitleNo(`${titleNo}.4`), spacingBefore: 120, spacingAfter: 80 }))
  blocks.push(buildParagraph(`测试充分性要求：${FIXED_FUNCTIONAL_TEST_REQUIREMENTS.sufficiency}；`, {
    spacingAfter: 80,
    firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
  }))
  blocks.push(buildParagraph(`测试终止要求：${FIXED_FUNCTIONAL_TEST_REQUIREMENTS.termination}；`, {
    spacingAfter: 80,
    firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
  }))
  blocks.push(buildParagraph(`优先级：所有需求项为${FIXED_FUNCTIONAL_TEST_REQUIREMENTS.priority}。`, {
    spacingAfter: 120,
    firstLineIndent: CONTENT_FIRST_LINE_INDENT_TWIPS,
  }))

  return blocks
}

function buildNodeBlocks(node: FunctionalTestContentNode): string[] {
  const titleNo = textOf(node.title_no)
  const children = Array.isArray(node.children) ? node.children : []
  const blocks: string[] = [
    buildParagraph(`${titleNo} ${textOf(node.title)}`, {
      styleId: headingStyleForTitleNo(titleNo),
      spacingBefore: 160,
      spacingAfter: 80,
    }),
  ]

  if (children.length > 0) {
    for (const child of children) blocks.push(...buildNodeBlocks(child))
    return blocks
  }

  if (node.content_type === "initialization" && node.init_content) {
    blocks.push(...buildInitializationContentBlocks(node.init_content, titleNo))
  } else if (node.content_type === "other" && node.other_content) {
    blocks.push(...buildOtherContentBlocks(node.other_content, titleNo))
  }

  return blocks
}

function buildDocumentXml(model: FunctionalTestContentArtifact): string {
  const chapterTitleNo = textOf(model.chapter_title_no) || "4"
  const chapterTitle = textOf(model.chapter_title) || "测试类型说明"
  const sectionTitleNo = textOf(model.section_title_no) || "4.1"
  const sectionTitle = textOf(model.section_title) || "功能测试"
  const blocks: string[] = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    "<w:body>",
    buildParagraph(`${chapterTitleNo} ${chapterTitle}`, { styleId: "Heading1", spacingAfter: 120 }),
    buildParagraph(`${sectionTitleNo} ${sectionTitle}`, { styleId: "Heading2", spacingAfter: 120 }),
  ]

  if (!model.children?.length) blocks.push(buildParagraph("内容未生成"))
  for (const child of Array.isArray(model.children) ? model.children : []) {
    blocks.push(...buildNodeBlocks(child))
  }

  blocks.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>')
  blocks.push("</w:body></w:document>")
  return blocks.join("")
}

function buildStylesXml(): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:sz w:val="30"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:sz w:val="28"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:sz w:val="26"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="Heading 4"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:sz w:val="24"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="Heading 5"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:sz w:val="22"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="TableTitle"><w:name w:val="Table Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="21"/></w:rPr></w:style>',
    "</w:styles>",
  ].join("")
}

export function renderFunctionalTestContentDocx(model: FunctionalTestContentArtifact): Buffer {
  const entries: ZipEntry[] = [
    {
      path: "[Content_Types].xml",
      data: Buffer.from([
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
        "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
        "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>",
        "<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>",
        "</Types>",
      ].join(""), "utf-8"),
    },
    {
      path: "_rels/.rels",
      data: Buffer.from([
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>",
        "</Relationships>",
      ].join(""), "utf-8"),
    },
    { path: "word/document.xml", data: Buffer.from(buildDocumentXml(model), "utf-8") },
    { path: "word/styles.xml", data: Buffer.from(buildStylesXml(), "utf-8") },
    {
      path: "word/_rels/document.xml.rels",
      data: Buffer.from([
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>",
        "</Relationships>",
      ].join(""), "utf-8"),
    },
  ]
  return formatTestRequirementsDocx(writeZip(entries), { addPageNumbers: false })
}
