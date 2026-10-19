import { readZip, writeZip, type ZipEntry } from "./docx-zip"

const LATIN_FONT = "Times New Roman"
const EAST_ASIA_FONT = "SimSun"
const PRESERVE_SOURCE_TABLE_MARKER = "matrix:preserve-source-formatting"
const BODY_SIZE = "24" // 12 pt, 小四
const TABLE_SIZE = "21" // 10.5 pt, 五号
const HEADER_FOOTER_SIZE = "18" // 9 pt, 小五
const GRID_LINE_PITCH = "360" // 18 pt
const TABLE_LINE_PITCH = "240" // 单倍行距

const xmlEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function replaceOrAppend(container: string, tag: string, value: string): string {
  const expression = new RegExp(`<w:${tag}\\b[^>]*(?:/>|>[\\s\\S]*?</w:${tag}>)`, "g")
  if (expression.test(container)) return container.replace(expression, value)
  return container + value
}

function ensureProperties(xml: string, propertyTag: "pPr" | "rPr" | "tcPr" | "tblPr", update: (inner: string) => string): string {
  const expression = new RegExp(`<w:${propertyTag}\\b[^>]*>([\\s\\S]*?)</w:${propertyTag}>`)
  const match = xml.match(expression)
  if (match) return xml.replace(expression, `<w:${propertyTag}>${update(match[1])}</w:${propertyTag}>`)
  const ownerTag = propertyTag === "pPr" ? "p" : propertyTag === "rPr" ? "r" : propertyTag === "tcPr" ? "tc" : "tbl"
  return xml.replace(new RegExp(`<w:${ownerTag}\\b[^>]*>`), (opening) => `${opening}<w:${propertyTag}>${update("")}</w:${propertyTag}>`)
}

function formatRun(run: string, size: string, bold: boolean): string {
  return ensureProperties(run, "rPr", (inner) => {
    let result = inner
      .replace(/<w:rFonts\b[^>]*\/>/g, "")
      .replace(/<w:sz(?:Cs)?\b[^>]*\/>/g, "")
      .replace(/<w:b(?:Cs)?\b[^>]*\/>/g, "")
      .replace(/<w:b(?:Cs)?\b[^>]*>[\s\S]*?<\/w:b(?:Cs)?>/g, "")
    result += `<w:rFonts w:ascii="${LATIN_FONT}" w:hAnsi="${LATIN_FONT}" w:eastAsia="${EAST_ASIA_FONT}" w:cs="${LATIN_FONT}"/>`
    result += `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`
    if (bold) result += "<w:b/><w:bCs/>"
    return result
  })
}

function styleId(paragraph: string): string {
  return paragraph.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1] ?? ""
}

function paragraphText(paragraph: string): string {
  return [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, ""))
    .join("")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim()
}

function isHeading(paragraph: string): boolean {
  return /^(?:Matrix)?Heading\s*[1-9]$|^标题\s*[1-9]$|^Title$/i.test(styleId(paragraph))
}

function standardHeadingStyle(paragraph: string): string {
  const configured = styleId(paragraph).match(/(?:Matrix)?Heading\s*([1-9])|标题\s*([1-9])/i)
  if (configured) return `Heading${configured[1] ?? configured[2]}`
  const number = paragraphText(paragraph).match(/^(\d+(?:\.\d+)*)\b/)?.[1]
  return `Heading${Math.min(9, number ? number.split(".").length : 1)}`
}

function isCaption(paragraph: string): boolean {
  const style = styleId(paragraph)
  if (/caption|tabletitle|figuretitle|题注|表题|图题/i.test(style)) return true
  return /^(表|图)\s*[A-Za-z0-9一二三四五六七八九十.-]+(?:\s|　)/.test(paragraphText(paragraph))
}

function formatParagraph(paragraph: string, role: "heading" | "caption" | "body" | "cover", size = BODY_SIZE, snapToGrid = role !== "cover", linePitch = GRID_LINE_PITCH): string {
  const align = role === "body" ? "both" : role === "heading" ? "left" : "center"
  const indent = role === "body" ? '<w:ind w:firstLineChars="200"/>' : '<w:ind w:left="0" w:right="0" w:firstLine="0"/>'
  const spacing = role === "heading"
    ? '<w:spacing w:before="0" w:after="0" w:line="720" w:lineRule="auto"/>'
    : role === "body" || role === "caption"
      ? `<w:spacing w:before="0" w:after="0" w:line="${linePitch}" w:lineRule="auto"/>`
      : '<w:spacing w:before="0" w:after="0"/>'
  let result = ensureProperties(paragraph, "pPr", (inner) => {
    let props = inner
    props = replaceOrAppend(props, "jc", `<w:jc w:val="${align}"/>`)
    props = replaceOrAppend(props, "ind", indent)
    props = replaceOrAppend(props, "spacing", spacing)
    props = replaceOrAppend(props, "snapToGrid", snapToGrid ? "<w:snapToGrid/>" : '<w:snapToGrid w:val="0"/>')
    if (role === "heading") props = replaceOrAppend(props, "pStyle", `<w:pStyle w:val="${standardHeadingStyle(paragraph)}"/>`)
    props = props.replace(/<w:keepNext\b[^>]*(?:\/>|>[\s\S]*?<\/w:keepNext>)/g, "")
    if (role === "heading" || role === "caption") props += "<w:keepNext/>"
    return props
  })
  result = result.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, (run) => formatRun(run, size, role === "heading"))
  return result
}

function dxaAttribute(xml: string, tag: string, attribute: string): number | undefined {
  const opening = xml.match(new RegExp(`<w:${tag}\\b[^>]*>`))?.[0]
  const value = opening?.match(new RegExp(`\\b${attribute}="(\\d+)"`))?.[1]
  return value === undefined ? undefined : Number(value)
}

function documentContentWidth(xml: string): number | undefined {
  const sections = [...xml.matchAll(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g)]
  const section = sections.at(-1)?.[0]
  if (!section) return undefined
  const pageWidth = dxaAttribute(section, "pgSz", "w:w")
  const left = dxaAttribute(section, "pgMar", "w:left") ?? 0
  const right = dxaAttribute(section, "pgMar", "w:right") ?? 0
  const gutter = dxaAttribute(section, "pgMar", "w:gutter") ?? 0
  if (!pageWidth || pageWidth <= left + right + gutter) return undefined
  return pageWidth - left - right - gutter
}

function expandTableToContentWidth(table: string, contentWidth?: number): string {
  if (!contentWidth) return table
  const gridWidths = [...table.matchAll(/<w:gridCol\b[^>]*w:w="(\d+)"[^>]*\/>/g)].map((match) => Number(match[1]))
  const gridWidth = gridWidths.reduce((sum, width) => sum + width, 0)
  const declaredWidth = table.match(/<w:tblW\b[^>]*w:w="(\d+)"[^>]*w:type="dxa"[^>]*\/>/)?.[1]
  const sourceWidth = gridWidth || (declaredWidth ? Number(declaredWidth) : 0)
  const scale = sourceWidth > 0 ? contentWidth / sourceWidth : 1
  let result = table.replace(/<w:tblW\b[^>]*\/>/, '<w:tblW w:w="5000" w:type="pct"/>')
  result = result.replace(/<w:tblInd\b[^>]*\/>/g, '<w:tblInd w:w="0" w:type="dxa"/>')
  if (!/<w:tblInd\b/.test(result)) {
    result = ensureProperties(result, "tblPr", (inner) => inner + '<w:tblInd w:w="0" w:type="dxa"/>')
  }
  if (sourceWidth > 0) {
    result = result.replace(/(<w:gridCol\b[^>]*w:w=")(\d+)("[^>]*\/>)/g, (_all, before: string, width: string, after: string) => `${before}${Math.round(Number(width) * scale)}${after}`)
    result = result.replace(/(<w:tcW\b[^>]*w:w=")(\d+)("[^>]*w:type="dxa"[^>]*\/>)/g, (_all, before: string, width: string, after: string) => `${before}${Math.round(Number(width) * scale)}${after}`)
  }
  return result
}

function formatTable(table: string, snapToGrid = true, contentWidth?: number): string {
  if (table.includes(PRESERVE_SOURCE_TABLE_MARKER)) return table
  table = expandTableToContentWidth(table, contentWidth)
  let result = ensureProperties(table, "tblPr", (inner) => {
    const borders = [
      '<w:top w:val="single" w:sz="12" w:color="000000"/>',
      '<w:left w:val="single" w:sz="12" w:color="000000"/>',
      '<w:bottom w:val="single" w:sz="12" w:color="000000"/>',
      '<w:right w:val="single" w:sz="12" w:color="000000"/>',
      '<w:insideH w:val="single" w:sz="4" w:color="000000"/>',
      '<w:insideV w:val="single" w:sz="4" w:color="000000"/>',
    ].join("")
    return inner.replace(/<w:tblBorders\b[^>]*>[\s\S]*?<\/w:tblBorders>/g, "") + `<w:tblBorders>${borders}</w:tblBorders>`
  })
  result = result.replace(/<w:trPr\b[^>]*>([\s\S]*?)<\/w:trPr>/g, (_all, inner: string) => {
    const cleaned = inner.replace(/<w:tblHeader\b[^>]*(?:\/>|>[\s\S]*?<\/w:tblHeader>)/g, "").replace(/<w:cantSplit\b[^>]*(?:\/>|>[\s\S]*?<\/w:cantSplit>)/g, "")
    return cleaned ? `<w:trPr>${cleaned}</w:trPr>` : ""
  })
  result = result.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (cell) => {
    let formatted = ensureProperties(cell, "tcPr", (inner) => {
      const noShading = inner.replace(/<w:shd\b[^>]*(?:\/>|>[\s\S]*?<\/w:shd>)/g, "")
      return replaceOrAppend(noShading, "vAlign", '<w:vAlign w:val="center"/>')
    })
    formatted = formatted.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
      let centered = formatParagraph(paragraph, "caption", TABLE_SIZE, snapToGrid, TABLE_LINE_PITCH)
      centered = ensureProperties(centered, "pPr", (inner) => inner.replace(/<w:keepNext\b[^>]*(?:\/>|>[\s\S]*?<\/w:keepNext>)/g, ""))
      return centered
    })
    return formatted
  })
  return result
}

function formatSectionProperties(xml: string): string {
  return xml.replace(/<w:sectPr\b([^>]*)>([\s\S]*?)<\/w:sectPr>/g, (_all, attrs: string, inner: string) => {
    const cleaned = inner.replace(/<w:docGrid\b[^>]*(?:\/>|>[\s\S]*?<\/w:docGrid>)/g, "")
    return `<w:sectPr${attrs}>${cleaned}<w:docGrid w:type="lines" w:linePitch="${GRID_LINE_PITCH}"/></w:sectPr>`
  })
}

function isHeaderOnlyTable(table: string): boolean {
  const rows = table.match(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g) ?? []
  if (rows.length !== 1) return false
  const text = paragraphText(rows[0])
  const cells = rows[0].match(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g) ?? []
  const everyCellBold = cells.length > 0 && cells.every((cell) => /<w:b\b/.test(cell))
  return /<w:tblHeader\b/.test(rows[0]) || (everyCellBold && /序号|测试需求|名称|文档名称|章节号|标题名称|中断名称/.test(text))
}

function emptyContentParagraph(): string {
  return formatParagraph(`<w:p><w:r><w:t>${xmlEscape("未识别到相关测试需求。")}</w:t></w:r></w:p>`, "body")
}

function matchingElementEnd(xml: string, start: number, tagName: "p" | "tbl" | "sectPr"): number {
  const tagPattern = new RegExp(`<\\/?w:${tagName}\\b[^>]*>`, "g")
  tagPattern.lastIndex = start
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(xml)) !== null) {
    const tag = match[0]
    if (tag.startsWith("</")) {
      depth -= 1
    } else if (!tag.endsWith("/>")) {
      depth += 1
    }
    if (depth === 0) return tagPattern.lastIndex
  }
  throw new Error(`Unbalanced <w:${tagName}> element in DOCX XML.`)
}

function topLevelContentElements(content: string): string[] {
  const elements: string[] = []
  const openingPattern = /<w:(p|tbl|sectPr)\b[^>]*>/g
  let cursor = 0
  while (cursor < content.length) {
    openingPattern.lastIndex = cursor
    const match = openingPattern.exec(content)
    if (!match) break
    const tagName = match[1] as "p" | "tbl" | "sectPr"
    const start = match.index
    const end = match[0].endsWith("/>") ? openingPattern.lastIndex : matchingElementEnd(content, start, tagName)
    elements.push(content.slice(start, end))
    cursor = end
  }
  return elements
}

function formatMainDocument(xml: string, cover: boolean): string {
  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)
  if (!bodyMatch) return xml
  let beforeFirstPageBreak = cover
  const contentWidth = documentContentWidth(xml)
  const tokens = topLevelContentElements(bodyMatch[1])
  const formatted = tokens.map((token) => {
    if (token.startsWith("<w:tbl")) return isHeaderOnlyTable(token) ? emptyContentParagraph() : formatTable(token, !beforeFirstPageBreak, beforeFirstPageBreak ? undefined : contentWidth)
    if (token.startsWith("<w:sectPr")) return token
    const hasPageBreak = /<w:br\b[^>]*w:type="page"/.test(token)
    const role = beforeFirstPageBreak ? "cover" : isHeading(token) ? "heading" : isCaption(token) ? "caption" : "body"
    const output = formatParagraph(token, role)
    if (hasPageBreak) beforeFirstPageBreak = false
    return output
  }).join("")
  return formatSectionProperties(xml.replace(bodyMatch[1], formatted))
}

function formatHeaderFooter(xml: string): string {
  const rootMatch = xml.match(/^([\s\S]*?<w:(?:hdr|ftr)\b[^>]*>)([\s\S]*)(<\/w:(?:hdr|ftr)>\s*)$/)
  if (!rootMatch) return xml
  const formatted = topLevelContentElements(rootMatch[2]).map((element) =>
    element.startsWith("<w:tbl")
      ? formatTable(element, false)
      : formatParagraph(element, "caption", HEADER_FOOTER_SIZE, false)
  ).join("")
  return `${rootMatch[1]}${formatted}${rootMatch[3]}`
}

function footerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${LATIN_FONT}" w:hAnsi="${LATIN_FONT}" w:eastAsia="${EAST_ASIA_FONT}" w:cs="${LATIN_FONT}"/><w:sz w:val="${HEADER_FOOTER_SIZE}"/><w:szCs w:val="${HEADER_FOOTER_SIZE}"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`
}

function ensureFooter(entries: Map<string, Buffer>): void {
  const documentPath = "word/document.xml"
  let documentXml = entries.get(documentPath)?.toString("utf-8") ?? ""
  if (!/xmlns:r=/.test(documentXml)) {
    documentXml = documentXml.replace(/<w:document\b/, '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
  }
  let rels = entries.get("word/_rels/document.xml.rels")?.toString("utf-8")
    ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  const existingFooter = rels.match(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/footer"[^>]*Target="([^"]+)"/)
  let relationshipId: string
  if (existingFooter) {
    relationshipId = existingFooter[1]
  } else {
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]))
    relationshipId = `rId${Math.max(0, ...ids) + 1}`
    rels = rels.replace(/<\/Relationships>/, `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`)
    entries.set("word/_rels/document.xml.rels", Buffer.from(rels, "utf-8"))
    entries.set("word/footer1.xml", Buffer.from(footerXml(), "utf-8"))
  }
  documentXml = documentXml.replace(/<w:sectPr\b([^>]*)>([\s\S]*?)<\/w:sectPr>/g, (_all, attrs: string, inner: string) => {
    const cleaned = inner.replace(/<w:footerReference\b[^>]*w:type="default"[^>]*\/>/g, "")
    return `<w:sectPr${attrs}><w:footerReference w:type="default" r:id="${relationshipId}"/>${cleaned}</w:sectPr>`
  })
  entries.set(documentPath, Buffer.from(documentXml, "utf-8"))

  const typesPath = "[Content_Types].xml"
  let types = entries.get(typesPath)?.toString("utf-8") ?? ""
  if (!types.includes('PartName="/word/footer1.xml"')) {
    types = types.replace(/<\/Types>/, '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>')
    entries.set(typesPath, Buffer.from(types, "utf-8"))
  }
}

export interface TestRequirementsDocxFormatOptions {
  cover?: boolean
  addPageNumbers?: boolean
}

export function formatTestRequirementsDocx(buffer: Buffer, options: TestRequirementsDocxFormatOptions = {}): Buffer {
  const entries = readZip(buffer)
  const document = entries.get("word/document.xml")
  if (!document) throw new Error("DOCX is missing word/document.xml")
  entries.set("word/document.xml", Buffer.from(formatMainDocument(document.toString("utf-8"), options.cover === true), "utf-8"))
  for (const [path, data] of entries) {
    if (/^word\/(?:header|footer)\d+\.xml$/.test(path)) entries.set(path, Buffer.from(formatHeaderFooter(data.toString("utf-8")), "utf-8"))
  }
  if (options.addPageNumbers !== false) ensureFooter(entries)
  return writeZip([...entries].map(([path, data]) => ({ path, data } satisfies ZipEntry)))
}

export const TEST_REQUIREMENTS_DOCX_TOKENS = {
  font: EAST_ASIA_FONT,
  latinFont: LATIN_FONT,
  eastAsiaFont: EAST_ASIA_FONT,
  bodySizeHalfPoints: BODY_SIZE,
  tableSizeHalfPoints: TABLE_SIZE,
  headerFooterSizeHalfPoints: HEADER_FOOTER_SIZE,
} as const
