import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, extname, join } from "path"
import { readZip } from "./docx-zip"
import {
  extractTopLevelBodyElements,
  resolveHeadings,
  type ParsedTable,
} from "./docx-heading-resolver"
import { sanitizeDocxTableAssetXml } from "./docx-table-xml-sanitize"
import { docxTableXmlToHtml } from "./docx-table-html"
import { hasWordXmlMarkup, sanitizePossibleWordXmlText } from "./word-xml-sanitize"

export interface TableAssetArtifact {
  kind: "docx_table_xml"
  path: string
  styles_path?: string
  source_path: string
  section_id: string
  section_title: string
}

export interface DocumentStructureSection {
  section_id: string
  source_ref: string
  title: string
  level: number
  section_path_ids: string[]
  section_path_titles: string[]
  text: string
  tables: Array<{
    table_id: string
    title: string
    table_html: string
    table_asset?: TableAssetArtifact
  }>
}

export interface DocumentStructureArtifact {
  file_path: string
  format: string
  total_sections: number
  warnings?: DocumentStructureWarning[]
  sections: DocumentStructureSection[]
}

export interface DocumentStructureWarning {
  code:
    | "duplicate_section_id_remapped"
    | "xml_title_sanitized"
    | "invalid_heading_text"
    | "missing_parent_reconstructed"
    | "path_mismatch_reconstructed"
  message: string
  original_section_id?: string
  assigned_section_id?: string
  title?: string
  occurrence_index: number
}

interface SegmentArtifactLike {
  file?: string
  format?: string
  toc?: Array<{
    segment_id?: string
    level?: number
    title?: string
    section_path_ids?: string[]
    section_path_titles?: string[]
  }>
  segments?: Array<{
    segment_id?: string
    level?: number
    title?: string
    text?: string
    section_path_ids?: string[]
    section_path_titles?: string[]
  }>
}

interface SectionTableDraft {
  title: string
  rows: string[][]
  table_xml?: string
}

interface ResolvedTableTitle {
  title: string
  explicit: boolean
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => textOf(item)).filter(Boolean)
    : []
}

const SEGMENT_CHUNK_ID_RE = /^(.*)__\d{2}$/u

function canonicalSectionIdForStructure(entry: { segment_id?: string; section_path_ids?: unknown }): string {
  const segmentId = textOf(entry.segment_id)
  const chunkMatch = segmentId.match(SEGMENT_CHUNK_ID_RE)
  if (!chunkMatch) return segmentId

  const pathIds = readStringArray(entry.section_path_ids)
  const leafPathId = pathIds[pathIds.length - 1]
  return leafPathId === chunkMatch[1] ? leafPathId : segmentId
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "")
}

function stripLeadingSectionPrefix(value: string): string {
  return value
    .trim()
    .replace(/^(?:第\s*[一二三四五六七八九十百零\d]+\s*[章节篇部分]\s*)/u, "")
    .replace(/^(?:附件|附录)\s*[A-Za-z0-9一二三四五六七八九十百零]+(?:\s*[（(][^）)]*[）)])?\s*/iu, "")
    .replace(/^[A-Za-z](?:\.\d+)+(?:[.、．]|\s)+/u, "")
    .replace(/^\d+(?:\.\d+)*(?:[.、．]|\s)+/u, "")
    .trim()
}

function normalizeComparableTitle(value: string): string {
  return normalizeTitle(stripLeadingSectionPrefix(value))
}

function normalizeTableRows(table: ParsedTable): string[][] {
  return table.rows
    .map((row) => row.cells.map((cell) => cell.paragraphs.map((paragraph) => paragraph.trim()).join("\n").trim()))
    .filter((row) => row.some((cell) => textOf(cell)))
}

interface SectionBodyDraft {
  tables: SectionTableDraft[]
  lines: string[]
}

const TABLE_POSITION_TOKEN = "\u0000MATRIX_TABLE_POSITION:"

function tablePositionToken(index: number): string {
  return `${TABLE_POSITION_TOKEN}${index}\u0000`
}

function materializeSectionText(lines: string[], fallbackText: string, tableIds: string[]): string {
  if (lines.length === 0) return replaceSectionTablesWithPlaceholders(fallbackText, tableIds)
  const text = lines.join("\n")
  let replaced = text
  for (const [index, tableId] of tableIds.entries()) {
    replaced = replaced.replace(tablePositionToken(index), `[表格：${tableId}]`)
  }
  return replaced.replace(/\n{3,}/g, "\n\n").trim()
}

function replaceSectionTablesWithPlaceholders(text: string, tableIds: string[]): string {
  if (tableIds.length === 0) return text.trim()
  const lines = text.split(/\r?\n/)
  const output: string[] = []
  let tableIndex = 0
  let htmlDepth = 0
  let inMarkdownTable = false

  const addPlaceholder = () => {
    if (tableIndex < tableIds.length) output.push(`[表格：${tableIds[tableIndex++]}]`)
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const opens = (line.match(/<table\b/gi) || []).length
    const closes = (line.match(/<\/table>/gi) || []).length
    if (htmlDepth > 0 || opens > 0) {
      if (htmlDepth === 0) addPlaceholder()
      htmlDepth += opens - closes
      continue
    }
    const markdownRow = /^\s*\|.*\|\s*$/.test(line)
    if (markdownRow) {
      if (!inMarkdownTable) addPlaceholder()
      inMarkdownTable = true
      continue
    }
    inMarkdownTable = false
    output.push(line)
  }
  while (tableIndex < tableIds.length) addPlaceholder()
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

function collapseWhitespace(value: string): string {
  return sanitizePossibleWordXmlText(value).replace(/\s+/g, " ").trim()
}

function paragraphBodyText(xml: string, extractedText: string): string {
  const text = collapseWhitespace(extractedText)
  if (text) return text
  return /<(?:w:drawing|w:pict|w:object)\b/i.test(xml) ? "[图片]" : ""
}

function sanitizeDetectedTableTitle(value: string): string {
  return collapseWhitespace(value)
    .replace(/^\s*\u7eed\u8868\s*/u, "")
    .replace(/\s*[\uFF08(]\s*\u7eed\s*[)\uFF09]\s*$/u, "")
    .trim()
}

function detectTableCaption(paragraphText: string): string | null {
  const candidate = collapseWhitespace(paragraphText)
  if (!candidate) return null

  const sanitized = sanitizeDetectedTableTitle(candidate)
  if (!sanitized) return null

  const prefixMatch = sanitized.match(
    /^(?:\u8868\u683c|\u9644\u8868|\u8868)\s*[A-Za-z0-9\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+(?:\s*[-.\uFF0E]\s*[A-Za-z0-9\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+)*(?:\s*[\uFF1A:])?\s*(.+)$/u,
  )
  if (prefixMatch && textOf(prefixMatch[1])) {
    return sanitized
  }

  const suffixMatch = sanitized.match(
    /^(.+?)[\uFF08(]\s*\u8868\s*[A-Za-z0-9\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+(?:\s*[-.\uFF0E]\s*[A-Za-z0-9\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+)*\s*[)\uFF09]\s*$/u,
  )
  if (suffixMatch && textOf(suffixMatch[1])) {
    return sanitized
  }

  return null
}

function extractTableCaptionsFromSectionText(sectionText: string): string[] {
  const captions: string[] = []
  const seen = new Set<string>()
  for (const rawLine of sectionText.split(/\r?\n/u)) {
    const visibleLine = rawLine.replace(/\\([.()\-])/g, "$1")
    const detected = detectTableCaption(visibleLine)
    if (!detected || seen.has(detected)) continue
    seen.add(detected)
    captions.push(detected)
  }
  return captions
}

function isContinuationParagraph(paragraphText: string): boolean {
  const candidate = collapseWhitespace(paragraphText)
  if (!candidate) return false
  return /^\u7eed\u8868/u.test(candidate) || /[\uFF08(]\s*\u7eed\s*[)\uFF09]/u.test(candidate)
}

function extractEmbeddedTableTitle(rows: string[][]): string | null {
  const firstRow = rows[0] || []
  const uniqueNonEmptyCells = Array.from(
    new Set(firstRow.map((cell) => collapseWhitespace(cell)).filter(Boolean)),
  )
  if (uniqueNonEmptyCells.length === 1 && firstRow.length === 1) {
    return uniqueNonEmptyCells[0]
  }
  return null
}

function tableColumnCount(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0)
}

function buildHeaderSignature(rows: string[][], rowCount = 2): string {
  return rows
    .slice(0, rowCount)
    .map((row) => row.map((cell) => normalizeComparableTitle(cell)).filter(Boolean).join("|"))
    .filter(Boolean)
    .join("||")
}

function extractFirstNonEmptyCell(row: string[]): string {
  return row.find((cell) => textOf(cell)) || ""
}

function extractFirstCellOrdinal(value: string): number | null {
  const match = collapseWhitespace(value).match(/^(\d+)(?:[.．、]|$)/u)
  return match ? Number.parseInt(match[1], 10) : null
}

function findLastNonEmptyRow(rows: string[][]): string[] | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index].some((cell) => textOf(cell))) {
      return rows[index]
    }
  }
  return null
}

function looksLikeContinuationTable(currentRows: string[][], previousRows: string[][]): boolean {
  if (!currentRows.length || !previousRows.length) return false

  const currentCols = tableColumnCount(currentRows)
  const previousCols = tableColumnCount(previousRows)
  if (currentCols === 0 || previousCols === 0 || currentCols !== previousCols) {
    return false
  }

  const currentHeaderSignature = buildHeaderSignature(currentRows)
  const previousHeaderSignature = buildHeaderSignature(previousRows)
  if (currentHeaderSignature && previousHeaderSignature && currentHeaderSignature === previousHeaderSignature) {
    return true
  }

  const previousLastRow = findLastNonEmptyRow(previousRows)
  const currentFirstRow = currentRows.find((row) => row.some((cell) => textOf(cell)))
  if (!previousLastRow || !currentFirstRow) return false

  const previousOrdinal = extractFirstCellOrdinal(extractFirstNonEmptyCell(previousLastRow))
  const currentOrdinal = extractFirstCellOrdinal(extractFirstNonEmptyCell(currentFirstRow))
  return previousOrdinal !== null && currentOrdinal !== null && currentOrdinal === previousOrdinal + 1
}

function resolveTableTitle(
  rows: string[][],
  index: number,
  recentParagraphs: string[],
  previousTable?: SectionTableDraft,
): ResolvedTableTitle {
  // A table caption must be the nearest non-empty paragraph before the table.
  // Looking farther back can cross intervening prose and attach an earlier
  // table's caption to the current table when the real caption contains a
  // field/revision construct that was not extracted as plain text.
  const nearestParagraph = recentParagraphs[recentParagraphs.length - 1]
  const detected = nearestParagraph ? detectTableCaption(nearestParagraph) : null
  if (detected) {
    return {
      title: detected,
      explicit: true,
    }
  }

  if (
    previousTable
    && (recentParagraphs.some((paragraph) => isContinuationParagraph(paragraph))
      || looksLikeContinuationTable(rows, previousTable.rows))
  ) {
    return {
      title: previousTable.title,
      explicit: false,
    }
  }

  if (previousTable && recentParagraphs.length === 0) {
    return {
      title: previousTable.title,
      explicit: false,
    }
  }

  const embeddedTitle = extractEmbeddedTableTitle(rows)
  if (embeddedTitle) {
    return {
      title: embeddedTitle,
      explicit: false,
    }
  }

  return {
    title: `\u8868\u683c${index + 1}`,
    explicit: false,
  }
}

function normalizeTable(
  table: ParsedTable,
  index: number,
  options: {
    table_xml?: string
    recent_paragraphs?: string[]
    previous_table?: SectionTableDraft
  } = {},
): SectionTableDraft {
  const rows = normalizeTableRows(table)
  const resolvedTitle = resolveTableTitle(
    rows,
    index,
    options.recent_paragraphs || [],
    options.previous_table,
  )
  return {
    title: resolvedTitle.title,
    rows,
    table_xml: textOf(options.table_xml),
  }
}

const EMBEDDED_OBJECT_TABLE_XML_RE = /<(?:o:OLEObject|w:object|w:drawing|w:pict|v:shape)\b|\bProgID="(?:Visio|Excel|PowerPoint|Word|Package)\b/i

function isEmbeddedObjectOnlyTable(table: SectionTableDraft): boolean {
  const xml = textOf(table.table_xml)
  return Boolean(xml && EMBEDDED_OBJECT_TABLE_XML_RE.test(xml) && table.rows.length === 0)
}

function hasUsableTablePayload(table: SectionTableDraft): boolean {
  if (isEmbeddedObjectOnlyTable(table)) return false
  return table.rows.length > 0 || Boolean(table.table_xml)
}

function titlesRoughlyMatch(left: string, right: string): boolean {
  const a = normalizeComparableTitle(left)
  const b = normalizeComparableTitle(right)
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}

function titlesStrictlyMatch(left: string, right: string): boolean {
  const a = normalizeComparableTitle(left)
  const b = normalizeComparableTitle(right)
  return Boolean(a && b && a === b)
}

function normalizeHeadingLabel(value: string): string {
  const normalized = textOf(value).replace(/[。．.]+$/u, "")
  if (!normalized) return ""
  if (/^\d+(?:\.\d+)*$/.test(normalized)) {
    return normalized
      .split(".")
      .map((part) => String(Number.parseInt(part, 10)))
      .join(".")
  }
  return normalized.toUpperCase()
}

function sectionLabelFromId(sectionId: string | undefined): string {
  const raw = textOf(sectionId)
  if (!raw) return ""
  const match = raw.match(/^[A-Z]+-(.+)$/i)
  const label = match ? match[1] : raw
  if (/^\d{3}$/.test(label)) {
    return String(Number.parseInt(label, 10))
  }
  return normalizeHeadingLabel(label)
}

function buildHeadingToSectionIndex(
  headings: Array<{ label: string; title: string }>,
  sections: Array<{ section_id?: string; title: string }>,
): Map<number, number> {
  const headingToSectionIndex = new Map<number, number>()
  const usedHeadingIndexes = new Set<number>()
  const mappedSectionIndexes = new Set<number>()

  for (const [sectionIndex, section] of sections.entries()) {
    const sectionLabel = sectionLabelFromId(section.section_id)
    if (!sectionLabel) continue

    const sameLabelIndexes = headings
      .map((heading, index) => ({ heading, index }))
      .filter(({ heading, index }) =>
        !usedHeadingIndexes.has(index) && normalizeHeadingLabel(heading.label) === sectionLabel
      )
    const exactTitleMatch = sameLabelIndexes.find(({ heading }) => titlesStrictlyMatch(section.title, heading.title))
    const headingIndex = exactTitleMatch?.index ?? sameLabelIndexes[0]?.index ?? -1
    if (headingIndex < 0) continue

    headingToSectionIndex.set(headingIndex, sectionIndex)
    usedHeadingIndexes.add(headingIndex)
    mappedSectionIndexes.add(sectionIndex)
  }

  for (const [sectionIndex, section] of sections.entries()) {
    if (mappedSectionIndexes.has(sectionIndex)) continue

    const headingIndex = headings.findIndex((heading, index) =>
      !usedHeadingIndexes.has(index) && titlesStrictlyMatch(section.title, heading.title)
    )
    if (headingIndex < 0) continue

    headingToSectionIndex.set(headingIndex, sectionIndex)
    usedHeadingIndexes.add(headingIndex)
    mappedSectionIndexes.add(sectionIndex)
  }

  for (const [sectionIndex] of sections.entries()) {
    if (mappedSectionIndexes.has(sectionIndex)) continue
    if (sectionIndex >= headings.length || usedHeadingIndexes.has(sectionIndex)) continue

    headingToSectionIndex.set(sectionIndex, sectionIndex)
    usedHeadingIndexes.add(sectionIndex)
    mappedSectionIndexes.add(sectionIndex)
  }

  return headingToSectionIndex
}

function buildHeadingToElementIndex(
  headings: Array<{ title: string }>,
  elements: Array<{
    tag: "p" | "tbl" | "sectPr"
    xml: string
    text?: string
    body_element_index: number
  }>,
): Map<number, number> {
  const headingIndexByElementIndex = new Map<number, number>()
  let nextHeadingIndex = 0

  for (const element of elements) {
    if (element.tag !== "p" || nextHeadingIndex >= headings.length) continue
    if (!isSectionMatchParagraphCandidate(element.xml, textOf(element.text))) continue

    const headingIndex = headings.findIndex((heading, index) =>
      index >= nextHeadingIndex && titlesStrictlyMatch(textOf(element.text), heading.title)
    )
    if (headingIndex < 0) continue

    headingIndexByElementIndex.set(element.body_element_index, headingIndex)
    nextHeadingIndex = headingIndex + 1
  }

  return headingIndexByElementIndex
}

function findSequentialSectionIndex(
  paragraphText: string,
  sections: Array<{ title: string }>,
  startIndex: number,
): number {
  for (let index = Math.max(0, startIndex); index < sections.length; index++) {
    if (titlesStrictlyMatch(paragraphText, sections[index].title)) return index
  }
  return -1
}

function isPreambleSection(section: { section_id?: string; title: string } | undefined): boolean {
  return textOf(section?.section_id).toUpperCase() === "SRS-PREAMBLE"
    || textOf(section?.title) === "文档前置内容"
    || textOf(section?.title).toLowerCase() === "preamble"
}

function buildDocxSectionTablesByHeading(
  docXml: string,
  numberingXml: string | undefined,
  stylesXml: string | undefined,
  sections: Array<{ section_id?: string; title: string }>,
): {
  headingsCount: number
  sections: SectionBodyDraft[]
} {
  const headings = resolveHeadings(docXml, numberingXml, stylesXml)
  if (headings.length === 0) {
    return {
      headingsCount: 0,
      sections: sections.map(() => ({ tables: [], lines: [] })),
    }
  }

  const elements = extractTopLevelBodyElements(docXml)
  const sectionDrafts = sections.map(() => ({ tables: [], lines: [] } as SectionBodyDraft))
  const headingToSectionIndex = buildHeadingToSectionIndex(headings, sections)
  const headingIndexByElementIndex = buildHeadingToElementIndex(headings, elements)

  let currentSectionIndex = isPreambleSection(sections[0]) ? 0 : -1
  let nextSectionIndex = currentSectionIndex === 0 ? 1 : 0
  let recentParagraphs: string[] = []

  for (const element of elements) {
    if (element.tag === "p") {
      const headingIndex = headingIndexByElementIndex.get(element.body_element_index)

      if (headingIndex !== undefined) {
        const mappedSectionIndex = headingToSectionIndex.get(headingIndex)
        if (mappedSectionIndex !== undefined) {
          currentSectionIndex = mappedSectionIndex
          nextSectionIndex = Math.max(nextSectionIndex, mappedSectionIndex + 1)
          recentParagraphs = []
          continue
        }
      }

      const paragraphText = paragraphBodyText(element.xml, textOf(element.text))
      if (paragraphText && isSectionMatchParagraphCandidate(element.xml, paragraphText)) {
        const matchedSectionIndex = findSequentialSectionIndex(paragraphText, sections, nextSectionIndex)
        if (matchedSectionIndex >= 0) {
          currentSectionIndex = matchedSectionIndex
          nextSectionIndex = matchedSectionIndex + 1
          recentParagraphs = []
          continue
        }
      }

      if (headingIndex !== undefined) {
        if (!isPreambleSection(sections[currentSectionIndex])) currentSectionIndex = -1
        recentParagraphs = []
        continue
      }

      if (currentSectionIndex >= 0 && paragraphText) {
        sectionDrafts[currentSectionIndex].lines.push(paragraphText)
        recentParagraphs.push(paragraphText)
        if (recentParagraphs.length > 4) recentParagraphs.shift()
      }
      continue
    }

    if (element.tag !== "tbl" || !element.table || currentSectionIndex < 0) continue

    const targetSection = sectionDrafts[currentSectionIndex]
    const targetTables = targetSection.tables
    const normalized = normalizeTable(element.table, targetTables.length, {
      table_xml: element.xml,
      recent_paragraphs: recentParagraphs,
      previous_table: targetTables[targetTables.length - 1],
    })
    recentParagraphs = []
    if (!hasUsableTablePayload(normalized)) continue
    targetTables.push(normalized)
    targetSection.lines.push(tablePositionToken(targetTables.length - 1))
  }

  return {
    headingsCount: headings.length,
    sections: sectionDrafts,
  }
}

function buildDocxSectionTablesBySequence(
  docXml: string,
  sections: Array<{ title: string }>,
): SectionBodyDraft[] {
  const sectionDrafts = sections.map(() => ({ tables: [], lines: [] } as SectionBodyDraft))
  const elements = extractTopLevelBodyElements(docXml)
  let currentSectionIndex = isPreambleSection(sections[0]) ? 0 : -1
  let nextSectionIndex = currentSectionIndex === 0 ? 1 : 0
  let recentParagraphs: string[] = []

  for (const element of elements) {
    if (element.tag === "p") {
      const paragraphText = paragraphBodyText(element.xml, textOf(element.text))
      const matchedSectionIndex = isSectionMatchParagraphCandidate(element.xml, paragraphText)
        ? findSequentialSectionIndex(paragraphText, sections, nextSectionIndex)
        : -1
      if (matchedSectionIndex >= 0) {
        currentSectionIndex = matchedSectionIndex
        nextSectionIndex = matchedSectionIndex + 1
        recentParagraphs = []
      } else if (currentSectionIndex >= 0 && paragraphText) {
        const normalizedParagraph = collapseWhitespace(paragraphText)
        sectionDrafts[currentSectionIndex].lines.push(normalizedParagraph)
        recentParagraphs.push(normalizedParagraph)
        if (recentParagraphs.length > 4) {
          recentParagraphs.shift()
        }
      }
      continue
    }

    if (element.tag !== "tbl" || !element.table) continue
    if (currentSectionIndex < 0) continue

    const targetSection = sectionDrafts[currentSectionIndex]
    const targetTables = targetSection.tables
    const normalized = normalizeTable(element.table, targetTables.length, {
      table_xml: element.xml,
      recent_paragraphs: recentParagraphs,
      previous_table: targetTables[targetTables.length - 1],
    })
    recentParagraphs = []
    if (!hasUsableTablePayload(normalized)) continue
    targetTables.push(normalized)
    targetSection.lines.push(tablePositionToken(targetTables.length - 1))
  }

  return sectionDrafts
}

function isSectionMatchParagraphCandidate(xml: string, text: string): boolean {
  if (!text) return false
  if (text.includes("<w:")) return false
  if (xml.includes("<w:instrText") || xml.includes("<w:fldChar")) return false
  return true
}

function buildDocxSectionTables(
  filePath: string,
  sections: Array<{ section_id?: string; title: string }>,
): SectionBodyDraft[] {
  const zipEntries = readZip(readFileSync(filePath))
  const docXml = zipEntries.get("word/document.xml")?.toString("utf-8")
  if (!docXml) return sections.map(() => ({ tables: [], lines: [] }))

  const numberingXml = zipEntries.get("word/numbering.xml")?.toString("utf-8")
  const stylesXml = zipEntries.get("word/styles.xml")?.toString("utf-8")
  const headingResult = buildDocxSectionTablesByHeading(docXml, numberingXml, stylesXml, sections)
  const fallbackSections = buildDocxSectionTablesBySequence(docXml, sections)
  if (headingResult.headingsCount === 0) return fallbackSections
  return sections.map((_, index) => {
    const headingSection = headingResult.sections[index] || { tables: [], lines: [] }
    const fallbackSection = fallbackSections[index] || { tables: [], lines: [] }
    return headingSection.tables.length > 0 || headingSection.lines.length > 0
      ? headingSection
      : fallbackSection
  })
}

interface BuildDocumentStructureOptions {
  table_assets_dir?: string
  table_id_prefix?: string
  source_ref_prefix?: string
}

function sanitizeAssetName(value: string): string {
  return value
    .replace(/::/g, "__")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "table"
}

function writeDocxStylesAsset(filePath: string, tableAssetsDir: string | undefined): string | undefined {
  if (!tableAssetsDir) return undefined
  const zipEntries = readZip(readFileSync(filePath))
  const stylesXml = zipEntries.get("word/styles.xml")?.toString("utf-8")
  if (!stylesXml) return undefined

  mkdirSync(tableAssetsDir, { recursive: true })
  const stylesPath = join(tableAssetsDir, "source-styles.xml")
  writeFileSync(stylesPath, stylesXml, "utf-8")
  return stylesPath
}

function writeTableAsset(
  tableAssetsDir: string | undefined,
  tableId: string,
  tableXml: string | undefined,
  stylesPath: string | undefined,
  source: {
    filePath: string
    sectionId: string
    sectionTitle: string
  },
): TableAssetArtifact | undefined {
  const xml = textOf(tableXml)
  if (!tableAssetsDir || !xml) return undefined

  mkdirSync(tableAssetsDir, { recursive: true })
  const assetPath = join(tableAssetsDir, `${sanitizeAssetName(tableId)}.xml`)
  writeFileSync(assetPath, sanitizeDocxTableAssetXml(xml), "utf-8")

  return {
    kind: "docx_table_xml",
    path: assetPath,
    ...(stylesPath ? { styles_path: stylesPath } : {}),
    source_path: source.filePath,
    section_id: source.sectionId,
    section_title: source.sectionTitle,
  }
}

export function buildDocumentStructureArtifact(
  filePath: string,
  extracted: SegmentArtifactLike,
  options: BuildDocumentStructureOptions = {},
): DocumentStructureArtifact {
  const format = textOf(extracted.format) || extname(filePath).replace(/^\./, "").toLowerCase() || "text"
  const segments = Array.isArray(extracted.segments) ? extracted.segments : []
  const segmentQueuesById = new Map<string, NonNullable<SegmentArtifactLike["segments"]>>()
  for (const segment of segments) {
    const rawSegmentId = textOf(segment.segment_id)
    if (!rawSegmentId) continue
    const queue = segmentQueuesById.get(rawSegmentId) || []
    queue.push(segment)
    segmentQueuesById.set(rawSegmentId, queue)
  }
  const toc = Array.isArray(extracted.toc) && extracted.toc.length > 0
    ? extracted.toc
    : segments.map((segment) => ({
      segment_id: segment.segment_id,
      title: segment.title,
      level: segment.level,
      section_path_ids: segment.section_path_ids,
      section_path_titles: segment.section_path_titles,
    }))

  const warnings: DocumentStructureWarning[] = []
  const usedSectionIds = new Set<string>()
  const reservedSectionIds = new Set(toc
    .map((entry) => canonicalSectionIdForStructure(entry) || textOf(entry.segment_id))
    .filter(Boolean))
  const firstTitleBySectionId = new Map<string, string>()
  const chunkSectionIndexByCanonicalId = new Map<string, number>()
  const activeHeadingStack: Array<{ section_id: string; title: string; level: number }> = []
  let fallbackSequence = 0
  const nextFallbackSectionId = (): string => {
    while (true) {
      fallbackSequence += 1
      const candidate = `SEG-${String(fallbackSequence).padStart(3, "0")}`
      if (usedSectionIds.has(candidate) || reservedSectionIds.has(candidate)) continue
      return candidate
    }
  }
  const baseSections: Array<{
    section_id: string
    title: string
    level: number
    section_path_ids: string[]
    section_path_titles: string[]
    text: string
  }> = []
  for (const [occurrenceIndex, entry] of toc.entries()) {
    const rawSegmentId = textOf(entry.segment_id)
    const canonicalSectionId = canonicalSectionIdForStructure(entry) || rawSegmentId
    const queuedSegments = segmentQueuesById.get(rawSegmentId) || []
    const segment = queuedSegments.shift()
    const segmentText = textOf(segment?.text)
    const rawTitle = textOf(entry.title) || textOf(segment?.title)
    const titleHadXml = hasWordXmlMarkup(rawTitle) || /&lt;\/?(?:w|v|o|mc|wp|a|r):/iu.test(rawTitle)
    const sanitizedTitle = textOf(sanitizePossibleWordXmlText(rawTitle))
    if (titleHadXml && sanitizedTitle) {
      warnings.push({
        code: "xml_title_sanitized",
        message: `Removed leaked Word XML markup from heading title at occurrence ${occurrenceIndex + 1}.`,
        original_section_id: canonicalSectionId || undefined,
        title: sanitizedTitle,
        occurrence_index: occurrenceIndex,
      })
    }

    const invalidTitle = !sanitizedTitle
    const title = sanitizedTitle || `Section ${occurrenceIndex + 1}`
    const level = typeof entry.level === "number" && entry.level >= 1 ? entry.level : 1
    const chunkMatch = rawSegmentId.match(SEGMENT_CHUNK_ID_RE)
    const isExplicitChunk = Boolean(chunkMatch && canonicalSectionId === chunkMatch?.[1])
    const existingChunkIndex = isExplicitChunk ? chunkSectionIndexByCanonicalId.get(canonicalSectionId) : undefined
    if (existingChunkIndex !== undefined && baseSections[existingChunkIndex]?.title === title) {
      const existingSection = baseSections[existingChunkIndex]
      existingSection.text = [existingSection.text, segmentText].filter(Boolean).join("\n")
      continue
    }

    let sectionId = invalidTitle || !canonicalSectionId ? nextFallbackSectionId() : canonicalSectionId
    if (invalidTitle) {
      warnings.push({
        code: "invalid_heading_text",
        message: `Heading title at occurrence ${occurrenceIndex + 1} was empty after sanitization; assigned ${sectionId}.`,
        original_section_id: canonicalSectionId || undefined,
        assigned_section_id: sectionId,
        title,
        occurrence_index: occurrenceIndex,
      })
    }
    if (usedSectionIds.has(sectionId)) {
      const originalSectionId = sectionId
      sectionId = nextFallbackSectionId()
      warnings.push({
        code: "duplicate_section_id_remapped",
        message: `Duplicate section id ${originalSectionId} for "${title}" conflicts with "${firstTitleBySectionId.get(originalSectionId) || "an earlier heading"}"; assigned ${sectionId}.`,
        original_section_id: originalSectionId,
        assigned_section_id: sectionId,
        title,
        occurrence_index: occurrenceIndex,
      })
    }

    usedSectionIds.add(sectionId)
    firstTitleBySectionId.set(sectionId, title)
    const rawPathIds = readStringArray(entry.section_path_ids)
      .map((id) => id.replace(SEGMENT_CHUNK_ID_RE, "$1"))
    const rawPathTitles = readStringArray(entry.section_path_titles)

    while (activeHeadingStack.length > 0 && activeHeadingStack[activeHeadingStack.length - 1].level >= level) {
      activeHeadingStack.pop()
    }
    const ancestorCount = Math.max(0, level - 1)
    const ancestorPathIds = rawPathIds.slice(0, ancestorCount)
    const ancestorPathTitles = rawPathTitles.slice(0, ancestorCount)
    for (const ancestor of activeHeadingStack) {
      const pathIndex = ancestor.level - 1
      if (pathIndex < 0 || pathIndex >= ancestorCount) continue
      ancestorPathIds[pathIndex] = ancestor.section_id
      ancestorPathTitles[pathIndex] = ancestor.title
    }
    const validAncestorIndexes = Array.from({ length: ancestorCount }, (_, index) => index)
      .filter((index) => Boolean(textOf(ancestorPathIds[index])))
    const sectionPathIds = validAncestorIndexes.map((index) => textOf(ancestorPathIds[index]))
    const sectionPathTitles = validAncestorIndexes.map((index) => textOf(ancestorPathTitles[index]) || `Section ${index + 1}`)
    sectionPathIds.push(sectionId)
    sectionPathTitles.push(title)

    const normalizedInputPath = rawPathIds.length > 0
      ? [...rawPathIds.slice(0, Math.max(0, rawPathIds.length - 1)), canonicalSectionId]
      : [canonicalSectionId]
    if (normalizedInputPath.filter(Boolean).join("/") !== sectionPathIds.join("/")) {
      warnings.push({
        code: activeHeadingStack.length < ancestorCount ? "missing_parent_reconstructed" : "path_mismatch_reconstructed",
        message: `Reconstructed heading path for "${title}" as ${sectionPathIds.join(" > ")}.`,
        original_section_id: canonicalSectionId || undefined,
        assigned_section_id: sectionId,
        title,
        occurrence_index: occurrenceIndex,
      })
    }
    baseSections.push({
      section_id: sectionId,
      title,
      level,
      section_path_ids: sectionPathIds,
      section_path_titles: sectionPathTitles,
      text: segmentText,
    })
    activeHeadingStack.push({ section_id: sectionId, title, level })
    if (isExplicitChunk) chunkSectionIndexByCanonicalId.set(canonicalSectionId, baseSections.length - 1)
  }

  const docxSections = format === "docx"
    ? buildDocxSectionTables(filePath, baseSections)
    : baseSections.map(() => ({ tables: [], lines: [] } as SectionBodyDraft))
  const stylesAssetPath = format === "docx" ? writeDocxStylesAsset(filePath, options.table_assets_dir) : undefined
  const sourceRefPrefix = textOf(options.source_ref_prefix) || textOf(options.table_id_prefix)

  return {
    file_path: filePath,
    format,
    total_sections: baseSections.length,
    ...(warnings.length > 0 ? { warnings } : {}),
    sections: baseSections.map((section, index) => {
      const textCaptions = extractTableCaptionsFromSectionText(section.text)
      const bodyDraft = docxSections[index] || { tables: [], lines: [] }
      const drafts = bodyDraft.tables
      const tableIds = drafts.map((_, tableIndex) => {
        const localTableId = `${section.section_id}::table-${tableIndex + 1}`
        return textOf(options.table_id_prefix) ? `${textOf(options.table_id_prefix)}::${localTableId}` : localTableId
      })
      return {
        ...section,
        text: materializeSectionText(bodyDraft.lines, section.text, tableIds),
        source_ref: sourceRefPrefix ? `${sourceRefPrefix}::${section.section_id}` : section.section_id,
        tables: drafts.map((table, tableIndex) => {
          const localTableId = `${section.section_id}::table-${tableIndex + 1}`
          const tableId = textOf(options.table_id_prefix)
            ? `${textOf(options.table_id_prefix)}::${localTableId}`
            : localTableId
          const title = /^表格\d+$/u.test(table.title)
            ? textCaptions[tableIndex] || table.title
            : table.title
          return {
            table_id: tableId,
            title,
            table_html: docxTableXmlToHtml(textOf(table.table_xml)),
            table_asset: writeTableAsset(options.table_assets_dir, tableId, table.table_xml, stylesAssetPath, {
              filePath,
              sectionId: section.section_id,
              sectionTitle: section.title,
            }),
          }
        }),
      }
    }),
  }
}

/** Persist structure separately from diagnostics so normal retrieval stays compact. */
export function writeDocumentStructureArtifacts<T extends { warnings?: DocumentStructureWarning[] }>(
  structurePath: string,
  artifact: T,
) {
  const { warnings = [], ...structure } = artifact
  const warningsPath = structurePath.replace(/\.json$/i, "") + "-warn.json"
  mkdirSync(dirname(structurePath), { recursive: true })
  writeFileSync(warningsPath, JSON.stringify({
    structure_path: structurePath,
    warning_count: warnings.length,
    warnings,
  }, null, 2), "utf-8")
  writeFileSync(structurePath, JSON.stringify(structure, null, 2), "utf-8")
  return { structure_warnings_path: warningsPath, warning_count: warnings.length }
}
