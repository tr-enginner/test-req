import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { basename, extname, join } from "path"
import { readZip } from "../tools/docx-zip"

export interface ProtocolSemanticTable {
  title: string
  section_title?: string
  headers: string[]
  rows: Array<Record<string, string>>
}

export interface ProtocolSemanticDocument {
  protocol_name: string
  source_file: string
  paragraphs: string[]
  tables: ProtocolSemanticTable[]
}

interface ProtocolSemanticIndexEntry {
  protocol_name: string
  file_path: string
  semantic_file: string
  match_hint?: string
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
}

function sanitizeWordText(value: string): string {
  return decodeXmlEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractTextRuns(xml: string): string {
  const parts: string[] = []
  const textRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
  let match: RegExpExecArray | null
  while ((match = textRegex.exec(xml)) !== null) {
    const sanitized = sanitizeWordText(match[1])
    if (sanitized) parts.push(sanitized)
  }
  return sanitizeWordText(parts.join(""))
}

function parseTableRows(tableXml: string): string[][] {
  const rows: string[][] = []
  const rowRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowRegex.exec(tableXml)) !== null) {
    const cells: string[] = []
    const cellRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
    let cellMatch: RegExpExecArray | null
    const seenTexts = new Set<string>()

    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const cellText = extractTextRuns(cellMatch[1])
      if (cellText && !seenTexts.has(cellText)) {
        seenTexts.add(cellText)
        cells.push(cellText)
      } else if (!cellText) {
        cells.push("")
      }
    }

    if (cells.length > 0) rows.push(cells)
  }

  return rows
}

function countNonEmpty(values: string[]): number {
  return values.filter((value) => value.trim().length > 0).length
}

function chooseHeaderRow(rows: string[][]): number {
  let bestIndex = 0
  let bestScore = -1
  const candidates = rows.slice(0, Math.min(rows.length, 3))

  for (let index = 0; index < candidates.length; index += 1) {
    const row = candidates[index]
    const score = countNonEmpty(row)
    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  }

  return bestIndex
}

function normalizeHeaderCell(value: string, index: number): string {
  const trimmed = sanitizeWordText(value)
  return trimmed || `列${index + 1}`
}

function rowsToRecords(rows: string[][]): { headers: string[]; records: Array<Record<string, string>> } {
  if (rows.length === 0) return { headers: [], records: [] }

  const headerIndex = chooseHeaderRow(rows)
  const headers = rows[headerIndex].map((cell, index) => normalizeHeaderCell(cell, index))
  const records: Array<Record<string, string>> = []

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]
    if (countNonEmpty(row) === 0) continue

    const record: Record<string, string> = {}
    for (let columnIndex = 0; columnIndex < Math.max(headers.length, row.length); columnIndex += 1) {
      const key = headers[columnIndex] ?? `列${columnIndex + 1}`
      record[key] = sanitizeWordText(row[columnIndex] ?? "")
    }
    records.push(record)
  }

  return { headers, records }
}

function isSectionParagraph(text: string): boolean {
  const normalized = text.trim()
  return /^(输入流|输出流)[:：]/.test(normalized) || /^\d+(?:\.\d+)+/.test(normalized)
}

function isTableTitleParagraph(text: string): boolean {
  return /^表[\dA-Za-z.\-]+/.test(text.trim())
}

export function buildProtocolSemanticDocumentFromXml(
  filePath: string,
  documentXml: string,
): ProtocolSemanticDocument {
  const paragraphs: string[] = []
  const tables: ProtocolSemanticTable[] = []
  const previousParagraphs: string[] = []
  const blockRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = blockRegex.exec(documentXml)) !== null) {
    const block = blockMatch[0]
    if (block.startsWith("<w:p")) {
      const text = extractTextRuns(block)
      if (!text) continue
      paragraphs.push(text)
      previousParagraphs.push(text)
      if (previousParagraphs.length > 16) previousParagraphs.shift()
      continue
    }

    const rows = parseTableRows(block)
    if (rows.length === 0) continue

    const { headers, records } = rowsToRecords(rows)
    const title = [...previousParagraphs].reverse().find(isTableTitleParagraph)
      ?? previousParagraphs[previousParagraphs.length - 1]
      ?? `表格${tables.length + 1}`
    const sectionTitle = [...previousParagraphs].reverse().find(isSectionParagraph)

    tables.push({
      title,
      section_title: sectionTitle,
      headers,
      rows: records,
    })
  }

  return {
    protocol_name: basename(filePath, extname(filePath)),
    source_file: filePath,
    paragraphs,
    tables,
  }
}

export async function parseProtocolSemanticDocx(filePath: string): Promise<ProtocolSemanticDocument> {
  const docxBuffer = readFileSync(filePath)
  const zipEntries = readZip(Buffer.from(docxBuffer))
  const documentXml = zipEntries.get("word/document.xml")
  if (!documentXml) {
    throw new Error(`DOCX 缺少 word/document.xml: ${filePath}`)
  }

  return buildProtocolSemanticDocumentFromXml(filePath, documentXml.toString("utf-8"))
}

export function loadProtocolSemanticDocument(filePath: string): ProtocolSemanticDocument {
  return JSON.parse(readFileSync(filePath, "utf-8")) as ProtocolSemanticDocument
}

export function persistProtocolSemanticDocument(
  projectDir: string,
  document: ProtocolSemanticDocument,
  inputFlow?: string,
): string {
  const semanticsDir = join(projectDir, ".matrix", "data", "protocol-semantics")
  mkdirSync(semanticsDir, { recursive: true })

  const semanticFile = join(semanticsDir, `${document.protocol_name}.json`)
  writeFileSync(semanticFile, JSON.stringify(document, null, 2) + "\n")

  const indexFile = join(semanticsDir, "index.json")
  const index: ProtocolSemanticIndexEntry[] = existsSync(indexFile)
    ? JSON.parse(readFileSync(indexFile, "utf-8"))
    : []

  const existing = index.find((entry) => entry.protocol_name === document.protocol_name)
  if (existing) {
    existing.file_path = document.source_file
    existing.semantic_file = semanticFile
    existing.match_hint = inputFlow
  } else {
    index.push({
      protocol_name: document.protocol_name,
      file_path: document.source_file,
      semantic_file: semanticFile,
      match_hint: inputFlow,
    })
  }

  writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n")
  return semanticFile
}

// ---------------------------------------------------------------------------
// Field-level extraction and assertion template generation
// ---------------------------------------------------------------------------

export interface ProtocolFieldLayout {
  field_name: string
  byte_offset?: string
  bit_position?: string
  bit_width?: string
  value_range?: string
  description: string
  source_table: string
}

export interface ProtocolFieldAssertionTemplate {
  field_name: string
  template: string
  example: string
  source_table: string
}

function extractFieldLayoutsFromTable(table: ProtocolSemanticTable): ProtocolFieldLayout[] {
  const layouts: ProtocolFieldLayout[] = []

  // Detect header patterns for protocol table formats
  const hasByteOffset = table.headers.some(h =>
    /字节(偏移|序号|位置)|byte|offset|地址/i.test(h)
  )
  const hasBitPosition = table.headers.some(h =>
    /位(置|号)|bit|Bit/i.test(h)
  )
  const hasFieldName = table.headers.some(h =>
    /名称|字段|信号|参数|数据|含义|定义/i.test(h)
  )
  const hasValueRange = table.headers.some(h =>
    /取值(范围)?|范围|值|说明|备注/i.test(h)
  )

  if (!hasFieldName && table.rows.length < 3) {
    // Not a protocol field definition table, skip
    return layouts
  }

  // Map columns to field attributes
  const colMap: Record<string, string> = {}
  for (const header of table.headers) {
    if (/字节(偏移|序号|位置)|byte|offset|地址/i.test(header)) colMap.byte_offset = header
    else if (/位(置|号)|bit|Bit/i.test(header)) colMap.bit_position = header
    else if (/名称|字段|信号|参数/i.test(header)) colMap.field_name = header
    else if (/取值(范围)?|范围|值/i.test(header)) colMap.value_range = header
    else if (/说明|备注|描述|含义|定义|数据/i.test(header)) colMap.description = header
  }

  if (!colMap.field_name) {
    // Try first column as field name
    colMap.field_name = table.headers[0]
    if (hasValueRange) colMap.value_range = table.headers[1]
    if (table.headers.length > 2 && !colMap.description) colMap.description = table.headers[table.headers.length - 1]
  }

  for (const row of table.rows) {
    const fieldName = row[colMap.field_name]?.trim()
    if (!fieldName || fieldName.length > 80) continue

    const layout: ProtocolFieldLayout = {
      field_name: fieldName,
      description: colMap.description ? (row[colMap.description]?.trim() || "") : "",
      source_table: table.title,
    }

    if (colMap.byte_offset) {
      layout.byte_offset = row[colMap.byte_offset]?.trim() || undefined
    }
    if (colMap.bit_position) {
      layout.bit_position = row[colMap.bit_position]?.trim() || undefined
    }
    if (colMap.value_range) {
      layout.value_range = row[colMap.value_range]?.trim() || undefined
    }

    layouts.push(layout)
  }

  return layouts
}

export function extractAllFieldLayouts(document: ProtocolSemanticDocument): ProtocolFieldLayout[] {
  const allLayouts: ProtocolFieldLayout[] = []
  for (const table of document.tables) {
    const layouts = extractFieldLayoutsFromTable(table)
    allLayouts.push(...layouts)
  }
  return allLayouts
}

export function generateFieldAssertionTemplates(
  document: ProtocolSemanticDocument,
  dataPrefix = "遥测数据",
): ProtocolFieldAssertionTemplate[] {
  const layouts = extractAllFieldLayouts(document)
  const templates: ProtocolFieldAssertionTemplate[] = []

  for (const layout of layouts) {
    const safeName = layout.field_name.replace(/[（(][^)）]*[)）]/g, "").trim()
    const template = `${dataPrefix}_{field_name} = {value}`

    // Generate example: for byte fields use 0x prefix, for bit fields use 0/1
    let exampleValue = "{value}"
    if (layout.byte_offset) {
      exampleValue = `0x{XX}`
    } else if (layout.bit_position) {
      exampleValue = "{0|1}"
    }

    templates.push({
      field_name: safeName,
      template: template.replace("{field_name}", safeName).replace("{value}", exampleValue),
      example: template.replace("{field_name}", safeName).replace("{value}", "0x00"),
      source_table: layout.source_table,
    })
  }

  return templates
}

export function formatFieldAssertionTemplates(
  templates: ProtocolFieldAssertionTemplate[],
  maxPerTable = 5,
): string {
  if (templates.length === 0) return "未提取到协议字段断言模板。"

  const byTable = new Map<string, ProtocolFieldAssertionTemplate[]>()
  for (const t of templates) {
    const key = t.source_table
    if (!byTable.has(key)) byTable.set(key, [])
    byTable.get(key)!.push(t)
  }

  const parts: string[] = []
  for (const [table, items] of byTable) {
    parts.push(`表: ${table}`)
    for (const item of items.slice(0, maxPerTable)) {
      parts.push(`  ${item.field_name}: \`${item.example}\``)
    }
    if (items.length > maxPerTable) {
      parts.push(`  ... 及其他 ${items.length - maxPerTable} 个字段`)
    }
  }

  return parts.join("\n")
}

export function formatProtocolSemanticPreview(
  document: ProtocolSemanticDocument,
  maxTables = 3,
  maxRows = 3,
): string {
  const tableText = document.tables
    .slice(0, maxTables)
    .map((table) => {
      const rowsText = table.rows
        .slice(0, maxRows)
        .map((row, index) => {
          const values = table.headers
            .map((header) => `${header}=${row[header] ?? ""}`)
            .join(" | ")
          return `  行${index + 1}: ${values}`
        })
        .join("\n")
      return [
        `表格标题: ${table.title}`,
        table.section_title ? `所在段落: ${table.section_title}` : undefined,
        `表头: ${table.headers.join(" | ") || "（无）"}`,
        rowsText || "  （无记录行）",
      ]
        .filter(Boolean)
        .join("\n")
    })
    .join("\n\n")

  return [
    `协议名称: ${document.protocol_name}`,
    `协议文件: ${document.source_file}`,
    "协议表格预览:",
    tableText || "（未解析到表格）",
  ].join("\n")
}
