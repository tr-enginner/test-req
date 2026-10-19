import { phase2Warning } from "../shared/phase2-tolerance"
import { existsSync, readFileSync } from "fs"
import { writeZip, type ZipEntry } from "./docx-zip"
import { formatTestRequirementsDocx } from "./test-requirements-docx-format"
import { sanitizeDocxTableAssetXml } from "./docx-table-xml-sanitize"
import type { TableAssetArtifact } from "./document-structure-artifact"

interface HardwareInterfaceModelTable {
  table_id?: string
  title?: string
  rows?: unknown
  table_asset?: TableAssetArtifact
}

interface HardwareInterfaceModelSubsection {
  title?: string
  input_flow?: unknown
  input_tables?: HardwareInterfaceModelTable[]
  output_flow?: unknown
  output_tables?: HardwareInterfaceModelTable[]
  source_refs?: unknown
}

interface HardwareInterfaceModelArtifact {
  model_version?: number
  chapter_title?: string
  section_title?: string
  interfaces?: GenericHardwareInterface[]
  blocks?: unknown
}

type GenericHardwareInterfaceTopic = HardwareInterfaceModelSubsection

interface GenericHardwareInterface {
  candidate_id?: string
  interface_id?: string
  interface_name?: string
  interface_kind?: string
  title?: string
  overview?: string
  source_refs?: unknown
  overview_tables?: HardwareInterfaceModelTable[]
  topics?: GenericHardwareInterfaceTopic[]
  input_flow?: unknown
  input_tables?: HardwareInterfaceModelTable[]
  output_flow?: unknown
  output_tables?: HardwareInterfaceModelTable[]
}

interface ResolvedTable {
  title: string
  tableAsset: TableAssetArtifact
}

interface ResolvedSubsection {
  title: string
  sourceRefs: string[]
  inputFlows: string[]
  outputFlows: string[]
  inputTables: ResolvedTable[]
  outputTables: ResolvedTable[]
}

interface ResolvedInterface {
  title: string
  interfaceId: string
  overview: string
  overviewTables: ResolvedTable[]
  inputFlows: string[]
  outputFlows: string[]
  inputTables: ResolvedTable[]
  outputTables: ResolvedTable[]
  subsections: ResolvedSubsection[]
}

const A4_WIDTH = 11906
const A4_HEIGHT = 16838
const PAGE_MARGIN = 1440
const CONTENT_WIDTH = A4_WIDTH - PAGE_MARGIN * 2
const HEADING_STYLE_1 = "Heading1"
const HEADING_STYLE_2 = "Heading2"
const HEADING_STYLE_3 = "Heading3"
const HEADING_STYLE_4 = "Heading4"

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function stringArrayOf(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim()
    return text ? [text] : []
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => stringArrayOf(item))
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function buildTextRuns(text: string): string {
  const parts = text.split(/\r?\n/)
  if (parts.length === 0) return "<w:r><w:t></w:t></w:r>"

  return parts
    .map((part, index) => {
      const escaped = escapeXml(part)
      const spaceAttr = /^[\s]|[\s]$/.test(part) ? ' xml:space="preserve"' : ""
      const run = `<w:r><w:t${spaceAttr}>${escaped}</w:t></w:r>`
      return index === 0 ? run : `<w:r><w:br/></w:r>${run}`
    })
    .join("")
}

function buildParagraph(
  text: string,
  options: {
    styleId?: string
    indentLeft?: number
    firstLineIndent?: number
    spacingBefore?: number
    spacingAfter?: number
    keepNext?: boolean
  } = {},
): string {
  const paragraphProps: string[] = []
  if (options.styleId) paragraphProps.push(`<w:pStyle w:val="${options.styleId}"/>`)
  if (typeof options.indentLeft === "number" || typeof options.firstLineIndent === "number") {
    const attributes: string[] = []
    if (typeof options.indentLeft === "number") attributes.push(`w:left="${options.indentLeft}"`)
    if (typeof options.firstLineIndent === "number") attributes.push(`w:firstLine="${options.firstLineIndent}"`)
    paragraphProps.push(`<w:ind ${attributes.join(" ")}/>`)
  }
  if (typeof options.spacingBefore === "number" || typeof options.spacingAfter === "number") {
    const before = typeof options.spacingBefore === "number" ? options.spacingBefore : 0
    const after = typeof options.spacingAfter === "number" ? options.spacingAfter : 0
    paragraphProps.push(`<w:spacing w:before="${before}" w:after="${after}"/>`)
  }
  if (options.keepNext) paragraphProps.push("<w:keepNext/>")

  const pPrXml = paragraphProps.length > 0 ? `<w:pPr>${paragraphProps.join("")}</w:pPr>` : ""
  return `<w:p>${pPrXml}${buildTextRuns(text)}</w:p>`
}

function extractStyleBlockMap(stylesXml: string): Map<string, string> {
  const blocks = new Map<string, string>()
  const styleRegex = /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<\/w:style>/g
  let match: RegExpExecArray | null
  while ((match = styleRegex.exec(stylesXml)) !== null) {
    const styleId = textOf(match[1])
    if (!styleId || blocks.has(styleId)) continue
    blocks.set(styleId, match[0])
  }
  return blocks
}

function readDxaAttribute(tagXml: string | undefined, attributeName: string): number | undefined {
  if (!tagXml) return undefined
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = tagXml.match(new RegExp(`${escapedName}="(\\d+)"`))
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function replaceDxaAttribute(tagXml: string, attributeName: string, value: number): string {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const replacement = `${attributeName}="${Math.max(1, Math.round(value))}"`
  return tagXml.replace(new RegExp(`${escapedName}="\\d+"`), replacement)
}

function scaleDxaTags(xml: string, tagName: string, attributeName: string, scale: number): string {
  return xml.replace(new RegExp(`<${tagName}\\b[^>]*${attributeName}="\\d+"[^>]*/>`, "g"), (tag) => {
    const width = readDxaAttribute(tag, attributeName)
    return width ? replaceDxaAttribute(tag, attributeName, width * scale) : tag
  })
}

function stripFloatingTableLayout(tableXml: string): string {
  return tableXml
    .replace(/<w:tblpPr\b[^>]*\/>/g, "")
    .replace(/<w:tblpPr\b[^>]*>[\s\S]*?<\/w:tblpPr>/g, "")
    .replace(/<w:tblOverlap\b[^>]*\/>/g, "")
    .replace(/<w:tblInd\b[^>]*\/>/g, "")
    .replace(/<w:tblInd\b[^>]*>[\s\S]*?<\/w:tblInd>/g, "")
}

function adaptClonedTableToTargetPage(tableXml: string): string {
  let adapted = stripFloatingTableLayout(tableXml)

  const tableWidthTag = adapted.match(/<w:tblW\b[^>]*\/>/)?.[0]
  const tableWidth = readDxaAttribute(tableWidthTag, "w:w")
  if (!tableWidth || tableWidth <= CONTENT_WIDTH) return adapted

  const scale = CONTENT_WIDTH / tableWidth
  adapted = adapted.replace(/<w:tblW\b[^>]*\/>/, (tag) => replaceDxaAttribute(tag, "w:w", CONTENT_WIDTH))
  adapted = scaleDxaTags(adapted, "w:gridCol", "w:w", scale)
  adapted = scaleDxaTags(adapted, "w:tcW", "w:w", scale)
  return adapted
}

function centerParagraphXml(paragraphXml: string): string {
  const paragraphProperties = paragraphXml.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/)?.[0]
  if (!paragraphProperties) {
    return paragraphXml.replace(/^(<w:p\b[^>]*>)/, '$1<w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>')
  }

  let centeredProperties = /<w:jc\b[^>]*\/?>(?:<\/w:jc>)?/.test(paragraphProperties)
    ? paragraphProperties.replace(/<w:jc\b[^>]*\/?>(?:<\/w:jc>)?/, '<w:jc w:val="center"/>')
    : paragraphProperties.replace(/^(<w:pPr\b[^>]*>)/, '$1<w:jc w:val="center"/>')
  centeredProperties = /<w:spacing\b[^>]*(?:\/>|>[\s\S]*?<\/w:spacing>)/.test(centeredProperties)
    ? centeredProperties.replace(/<w:spacing\b[^>]*(?:\/>|>[\s\S]*?<\/w:spacing>)/, '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>')
    : centeredProperties.replace(/^(<w:pPr\b[^>]*>)/, '$1<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>')
  return paragraphXml.replace(paragraphProperties, centeredProperties)
}

function centerAllTableCellParagraphs(tableXml: string): string {
  return tableXml.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (cellXml) => {
    let normalized = cellXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, centerParagraphXml)
    const cellProperties = normalized.match(/<w:tcPr\b[^>]*>[\s\S]*?<\/w:tcPr>/)?.[0]
    if (!cellProperties) return normalized.replace(/^(<w:tc\b[^>]*>)/, '$1<w:tcPr><w:vAlign w:val="center"/></w:tcPr>')
    const centeredProperties = /<w:vAlign\b[^>]*(?:\/>|>[\s\S]*?<\/w:vAlign>)/.test(cellProperties)
      ? cellProperties.replace(/<w:vAlign\b[^>]*(?:\/>|>[\s\S]*?<\/w:vAlign>)/, '<w:vAlign w:val="center"/>')
      : cellProperties.replace(/^(<w:tcPr\b[^>]*>)/, '$1<w:vAlign w:val="center"/>')
    normalized = normalized.replace(cellProperties, centeredProperties)
    return normalized
  })
}

function renderTableXml(table: ResolvedTable): string {
  const assetPath = textOf(table.tableAsset.path)
  if (!assetPath || !existsSync(assetPath)) {
    throw new Error(`Table ${table.title} must provide an existing table_asset.path.`)
  }

  const tableXml = sanitizeDocxTableAssetXml(readFileSync(assetPath, "utf-8"))
  if (!/<w:tbl\b/.test(tableXml)) {
    throw new Error(`Table asset is not a DOCX table XML file: ${assetPath}`)
  }

  const adapted = centerAllTableCellParagraphs(adaptClonedTableToTargetPage(tableXml))
  if (/<w:tblPr\b[^>]*>/.test(adapted)) {
    return adapted.replace(/<w:tblPr\b([^>]*)>/, '<w:tblPr$1><w:tblDescription w:val="matrix:preserve-source-formatting"/>')
  }
  return adapted.replace(/<w:tbl\b([^>]*)>/, '<w:tbl$1><w:tblPr><w:tblDescription w:val="matrix:preserve-source-formatting"/></w:tblPr>')
}

function normalizeTableDescription(title: string, fallbackDescription: string): string {
  // Some source captions are split across multiple Word runs. If an upstream
  // extractor leaks the run boundary markup into the title, remove only
  // WordprocessingML tags here so cached/raw artifacts remain renderable too.
  const normalized = title
    .replace(/<\/?w:[A-Za-z][^>]*>/giu, "")
    .replace(/<\/?wt\b[^>]*>/giu, "")
    .replace(/\s+/gu, " ")
    .trim()
  if (!normalized) return fallbackDescription

  // Source captions may use either chapter numbers (表 5.2-9) or appendix
  // numbers (表 A.1-1). Allow whitespace around every separator because
  // DOCX text extraction often introduces spaces inside the number.
  const sourceTableNumber = String.raw`(?:表格|附表|表)\s*(?:\d+|[A-Za-zＡ-Ｚａ-ｚ]+)(?:\s*[.．\-－—]\s*\d+)*`

  if (new RegExp(`^${sourceTableNumber}\\s*$`, "u").test(normalized)) {
    return fallbackDescription
  }

  const withoutSourceNumber = normalized.replace(
    new RegExp(`^${sourceTableNumber}(?:\\s*[：:、]\\s*|\\s+|(?=[A-Za-zＡ-Ｚａ-ｚ\\u4e00-\\u9fff]))`, "u"),
    "",
  ).trim()
  return withoutSourceNumber || fallbackDescription
}

function normalizeTable(
  table: HardwareInterfaceModelTable | undefined,
  fallbackIndex: number,
  fallbackDescription: string,
): ResolvedTable | null {
  const tableAsset = table?.table_asset
  if (!tableAsset) {
    phase2Warning(`跳过缺少资源的表格 ${textOf(table?.title)}`, 1)
    return null
  }

  const resolved = { title: normalizeTableDescription(textOf(table?.title), fallbackDescription), tableAsset }
  try { renderTableXml(resolved) } catch (error) { phase2Warning(String(error), 1); return null }
  return resolved
}

function normalizeGenericInterface(item: GenericHardwareInterface, index: number): ResolvedInterface {
  const interfaceName = textOf(item.interface_name) || `硬件接口${index + 1}`
  const interfaceId = textOf(item.interface_id)
  if (!interfaceId.startsWith("IF-") || /\s/.test(interfaceId)) {
    throw new Error(`Hardware interface ${index + 1} requires interface_id beginning with IF- and containing no whitespace.`)
  }
  const topics: ResolvedSubsection[] = (Array.isArray(item.topics) ? item.topics : []).map((topic, topicIndex) => {
    const topicTitle = textOf(topic.title) || `${interfaceName}专题${topicIndex + 1}`
    return {
      title: topicTitle,
      sourceRefs: stringArrayOf(topic.source_refs),
      inputFlows: stringArrayOf(topic.input_flow),
      outputFlows: stringArrayOf(topic.output_flow),
      inputTables: (Array.isArray(topic.input_tables) ? topic.input_tables : [])
        .map((table, tableIndex) => normalizeTable(table, tableIndex, `${topicTitle}输入数据表`))
        .filter((table): table is ResolvedTable => Boolean(table)),
      outputTables: (Array.isArray(topic.output_tables) ? topic.output_tables : [])
        .map((table, tableIndex) => normalizeTable(table, tableIndex, `${topicTitle}输出数据表`))
        .filter((table): table is ResolvedTable => Boolean(table)),
    }
  })
  return {
    title: textOf(item.title) || `${interfaceName}及相关数据流`,
    interfaceId,
    overview: textOf(item.overview),
    overviewTables: (Array.isArray(item.overview_tables) ? item.overview_tables : [])
      .map((table, tableIndex) => normalizeTable(table, tableIndex, `${interfaceName}概述数据表`))
      .filter((table): table is ResolvedTable => Boolean(table)),
    inputFlows: stringArrayOf(item.input_flow),
    outputFlows: stringArrayOf(item.output_flow),
    inputTables: (Array.isArray(item.input_tables) ? item.input_tables : []).map((table, tableIndex) => normalizeTable(table, tableIndex, `${interfaceName}输入数据表`)).filter((table): table is ResolvedTable => Boolean(table)),
    outputTables: (Array.isArray(item.output_tables) ? item.output_tables : []).map((table, tableIndex) => normalizeTable(table, tableIndex, `${interfaceName}输出数据表`)).filter((table): table is ResolvedTable => Boolean(table)),
    subsections: topics,
  }
}

function buildTableCaption(table: ResolvedTable, categoryIndex: number, tableNumber: { value: number; captions?: Map<string, string> }): string {
  const caption = `表3.1.${categoryIndex}-${tableNumber.value}  ${table.title}`
  tableNumber.value += 1
  return caption
}

function buildFlowGroup(flows: string[], tables: ResolvedTable[], categoryIndex: number, tableNumber: { value: number; captions?: Map<string, string> }): string {
  if (flows.length === 0 && tables.length === 0) return ""

  const blocks: string[] = []

  for (const flow of flows) {
    blocks.push(buildParagraph(flow, { styleId: "FlowText", spacingBefore: 0, spacingAfter: 40 }))
  }

  for (const table of tables) {
    const previous = tableNumber.captions?.get(table.tableAsset.path)
    if (previous) { blocks.push(buildParagraph(`详细格式见${previous}。`)); continue }
    try {
      const xml = renderTableXml(table)
      const number = `表3.1.${categoryIndex}-${tableNumber.value}`
      blocks.push(buildParagraph(buildTableCaption(table, categoryIndex, tableNumber), { styleId: "TableTitle", spacingBefore: 120, spacingAfter: 80 }), xml)
      tableNumber.captions?.set(table.tableAsset.path, number)
    } catch (error) { phase2Warning(String(error), 1) }
  }

  return blocks.join("")
}

function buildInterfaceContent(category: ResolvedInterface, categoryIndex: number): string {
  const blocks: string[] = []
  const tableNumber = { value: 1, captions: new Map<string, string>() }
  blocks.push(buildParagraph(`3.1.${categoryIndex} ${category.title}`, { styleId: HEADING_STYLE_3, keepNext: true }))

  const interfaceLine = category.overview ? `${category.interfaceId}: ${category.overview}` : category.interfaceId
  blocks.push(buildParagraph(interfaceLine, { styleId: "InterfaceId", spacingBefore: 0, spacingAfter: 120 }))

  for (const table of category.overviewTables) {
    const previous = tableNumber.captions?.get(table.tableAsset.path)
    if (previous) { blocks.push(buildParagraph(`详细格式见${previous}。`)); continue }
    try {
      const xml = renderTableXml(table)
      const number = `表3.1.${categoryIndex}-${tableNumber.value}`
      blocks.push(buildParagraph(buildTableCaption(table, categoryIndex, tableNumber), { styleId: "TableTitle", spacingBefore: 120, spacingAfter: 80 }), xml)
      tableNumber.captions?.set(table.tableAsset.path, number)
    } catch (error) { phase2Warning(String(error), 1) }
  }

  blocks.push(buildFlowGroup(category.inputFlows, category.inputTables, categoryIndex, tableNumber))
  blocks.push(buildFlowGroup(category.outputFlows, category.outputTables, categoryIndex, tableNumber))

  for (const [subsectionIndex, subsection] of category.subsections.entries()) {
    blocks.push(buildParagraph(`3.1.${categoryIndex}.${subsectionIndex + 1} ${subsection.title}`, { styleId: HEADING_STYLE_4, keepNext: true }))
    blocks.push(buildFlowGroup(subsection.inputFlows, subsection.inputTables, categoryIndex, tableNumber))
    blocks.push(buildFlowGroup(subsection.outputFlows, subsection.outputTables, categoryIndex, tableNumber))
  }

  return blocks.filter(Boolean).join("")
}

function buildDocumentXml(chapterTitle: string, sectionTitle: string, interfaces: ResolvedInterface[]): string {
  const blocks: string[] = [
    buildParagraph(`3 ${chapterTitle}`, { styleId: HEADING_STYLE_1, keepNext: true }),
    buildParagraph(`3.1 ${sectionTitle}`, { styleId: HEADING_STYLE_2, keepNext: true }),
  ]

  if (interfaces.length === 0) {
    blocks.push(buildParagraph("未识别到可展示的硬件接口内容。", { styleId: "BodyText" }))
  } else {
    for (const [index, item] of interfaces.entries()) {
      blocks.push(buildInterfaceContent(item, index + 1))
    }
  }

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:document",
    " xmlns:wpc=\"http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas\"",
    " xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\"",
    " xmlns:o=\"urn:schemas-microsoft-com:office:office\"",
    " xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"",
    " xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\"",
    " xmlns:v=\"urn:schemas-microsoft-com:vml\"",
    " xmlns:wp14=\"http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing\"",
    " xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\"",
    " xmlns:w10=\"urn:schemas-microsoft-com:office:word\"",
    " xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"",
    " xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\"",
    " xmlns:w15=\"http://schemas.microsoft.com/office/word/2012/wordml\"",
    " xmlns:wpg=\"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup\"",
    " xmlns:wpi=\"http://schemas.microsoft.com/office/word/2010/wordprocessingInk\"",
    " xmlns:wne=\"http://schemas.microsoft.com/office/word/2006/wordml\"",
    " xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\"",
    " mc:Ignorable=\"w14 w15 wp14\">",
    "<w:body>",
    blocks.join(""),
    `<w:sectPr><w:pgSz w:w="${A4_WIDTH}" w:h="${A4_HEIGHT}"/><w:pgMar w:top="${PAGE_MARGIN}" w:right="${PAGE_MARGIN}" w:bottom="${PAGE_MARGIN}" w:left="${PAGE_MARGIN}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`,
    "</w:body>",
    "</w:document>",
  ].join("")
}

function buildStylesXml(additionalStyleBlocks: string[] = []): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    "<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:eastAsia=\"SimSun\" w:cs=\"Calibri\"/><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:rPrDefault></w:docDefaults>",
    "<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/><w:pPr><w:spacing w:before=\"0\" w:after=\"120\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:eastAsia=\"SimSun\" w:cs=\"Calibri\"/><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:style>",
    "<w:style w:type=\"paragraph\" w:styleId=\"BodyText\"><w:name w:val=\"Body Text\"/><w:basedOn w:val=\"Normal\"/></w:style>",
    `<w:style w:type="paragraph" w:styleId="${HEADING_STYLE_1}"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="${HEADING_STYLE_2}"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="${HEADING_STYLE_3}"><w:name w:val="Heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="${HEADING_STYLE_4}"><w:name w:val="Heading 4"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`,
    "<w:style w:type=\"paragraph\" w:styleId=\"InterfaceId\"><w:name w:val=\"Interface ID\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:firstLine=\"360\"/><w:spacing w:before=\"0\" w:after=\"120\"/></w:pPr><w:rPr><w:sz w:val=\"24\"/><w:szCs w:val=\"24\"/></w:rPr></w:style>",
    "<w:style w:type=\"paragraph\" w:styleId=\"SectionLabel\"><w:name w:val=\"Section Label\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:before=\"80\" w:after=\"60\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:style>",
    "<w:style w:type=\"paragraph\" w:styleId=\"FlowText\"><w:name w:val=\"Flow Text\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:firstLine=\"360\"/><w:spacing w:before=\"0\" w:after=\"40\"/></w:pPr></w:style>",
    "<w:style w:type=\"paragraph\" w:styleId=\"TableTitle\"><w:name w:val=\"Table Title\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:jc w:val=\"center\"/><w:spacing w:before=\"120\" w:after=\"80\"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>",
    ...additionalStyleBlocks,
    "</w:styles>",
  ].join("")
}

function collectAdditionalStyleBlocks(interfaces: ResolvedInterface[]): string[] {
  const baseStyleIds = new Set(extractStyleBlockMap(buildStylesXml()).keys())
  const addedStyleIds = new Set<string>()
  const blocks: string[] = []

  const collectFromTables = (tables: ResolvedTable[]) => {
    for (const table of tables) {
      const stylesPath = textOf(table.tableAsset.styles_path)
      if (!stylesPath || !existsSync(stylesPath)) continue
      let styleBlocks: ReturnType<typeof extractStyleBlockMap>
      try { styleBlocks = extractStyleBlockMap(readFileSync(stylesPath, "utf-8")) }
      catch { phase2Warning(`表格样式不可读取，使用默认样式：${stylesPath}`); continue }
      for (const [styleId, styleBlock] of styleBlocks.entries()) {
        if (baseStyleIds.has(styleId) || addedStyleIds.has(styleId)) continue
        blocks.push(styleBlock)
        addedStyleIds.add(styleId)
      }
    }
  }

  for (const item of interfaces) {
    collectFromTables(item.overviewTables)
    collectFromTables(item.inputTables)
    collectFromTables(item.outputTables)
    for (const subsection of item.subsections) {
      collectFromTables(subsection.inputTables)
      collectFromTables(subsection.outputTables)
    }
  }

  return blocks
}

export function renderHardwareInterfaceDocx(model: HardwareInterfaceModelArtifact): Buffer {
  if (Number(model.model_version) !== 2) {
    throw new Error("hardware interface DOCX rendering requires model_version 2.")
  }
  if (!Array.isArray(model.interfaces)) {
    throw new Error("hardware interface DOCX rendering requires top-level interfaces array; legacy blocks are not supported.")
  }
  if (model.blocks !== undefined) {
    throw new Error("legacy hardware interface blocks are not supported.")
  }
  const chapterTitle = textOf(model.chapter_title) || "数据及接口需求"
  const sectionTitle = textOf(model.section_title) || "硬件接口"
  const occupied = new Set(model.interfaces.map(item => textOf(item.interface_id)))
  const interfaces = model.interfaces.map((item, index) => {
    let id = textOf(item.interface_id)
    if (!/^IF-\S+$/.test(id)) {
      id = `IF-RENDER-${index + 1}`
      while (occupied.has(id)) id += "-1"
      occupied.add(id)
      phase2Warning(`硬件接口标识已归一化为 ${id}`)
    }
    return normalizeGenericInterface({ ...item, interface_id: id }, index)
  })
  const documentXml = buildDocumentXml(chapterTitle, sectionTitle, interfaces)
  const stylesXml = buildStylesXml(collectAdditionalStyleBlocks(interfaces))

  const entries: ZipEntry[] = [
    {
      path: "[Content_Types].xml",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
          "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
          "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
          "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>",
          "<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>",
          "</Types>",
        ].join(""),
        "utf-8",
      ),
    },
    {
      path: "_rels/.rels",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
          "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>",
          "</Relationships>",
        ].join(""),
        "utf-8",
      ),
    },
    {
      path: "word/document.xml",
      data: Buffer.from(documentXml, "utf-8"),
    },
    {
      path: "word/styles.xml",
      data: Buffer.from(stylesXml, "utf-8"),
    },
    {
      path: "word/_rels/document.xml.rels",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
          "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>",
          "</Relationships>",
        ].join(""),
        "utf-8",
      ),
    },
  ]

  return formatTestRequirementsDocx(writeZip(entries), { addPageNumbers: false })
}
