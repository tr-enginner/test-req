import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join, isAbsolute } from "path"
import { readZip } from "./docx-zip"
import { CoverInfo } from "../schema/cover-info"
import { DATA_DIR } from "../shared/constants"

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p)
}

// ─── Types ──────────────────────────────────────────────────────────

interface ParsedTable {
  rows: string[][] // rows[r][c] = cell text
}

interface ParsedDoc {
  paragraphs: string[]
  tables: ParsedTable[]
}

// ─── XML Parsing (regex-based, no external deps) ────────────────────

/**
 * Extract paragraph text and table structure from word/document.xml.
 * Uses regex to parse OOXML — avoids adding DOM/SAX dependencies.
 */
function parseDocXml(xml: string, maxParagraphs: number, maxTables: number): ParsedDoc {
  const paragraphs: string[] = []
  const tables: ParsedTable[] = []

  // Extract paragraphs: <w:p>...<w:t>text</w:t>...</w:p>
  const pRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  let pMatch: RegExpExecArray | null
  while ((pMatch = pRegex.exec(xml)) !== null && paragraphs.length < maxParagraphs) {
    const pXml = pMatch[0]
    // Skip paragraphs inside tables (they'll be captured in table extraction)
    // We do a simple heuristic: paragraphs at top level are extracted here
    const texts: string[] = []
    const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let tMatch: RegExpExecArray | null
    while ((tMatch = tRegex.exec(pXml)) !== null) {
      texts.push(tMatch[1])
    }
    const joined = texts.join("")
    if (joined.trim()) {
      paragraphs.push(joined)
    }
  }

  // Extract tables: <w:tbl>...<w:tr>...<w:tc>...<w:t>text</w:t>...</w:tc>...</w:tr>...</w:tbl>
  const tblRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g
  let tblMatch: RegExpExecArray | null
  while ((tblMatch = tblRegex.exec(xml)) !== null && tables.length < maxTables) {
    const tblXml = tblMatch[1]
    const rows: string[][] = []
    const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
    let trMatch: RegExpExecArray | null
    while ((trMatch = trRegex.exec(tblXml)) !== null) {
      const trXml = trMatch[1]
      const cells: string[] = []
      const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
      let tcMatch: RegExpExecArray | null
      const seenTexts = new Set<string>()
      while ((tcMatch = tcRegex.exec(trXml)) !== null) {
        const tcXml = tcMatch[1]
        const cellTexts: string[] = []
        const ctRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
        let ctMatch: RegExpExecArray | null
        while ((ctMatch = ctRegex.exec(tcXml)) !== null) {
          cellTexts.push(ctMatch[1])
        }
        const cellText = cellTexts.join("").trim()
        // Deduplicate merged cells (DOCX repeats content for merged cells)
        if (cellText && !seenTexts.has(cellText)) {
          seenTexts.add(cellText)
          cells.push(cellText)
        } else if (!cellText) {
          cells.push("")
        }
      }
      if (cells.length > 0) {
        rows.push(cells)
      }
    }
    if (rows.length > 0) {
      tables.push({ rows })
    }
  }

  return { paragraphs, tables }
}

// ─── Basic Field Extractors ─────────────────────────────────────────

function extractConfigId(text: string): string | null {
  const patterns = [
    /([A-Za-z0-9\u4e00-\u9fa5/\-_]+)\s*\.\s*JDDG1/i,
    /([A-Za-z0-9\u4e00-\u9fa5/\-_]+)\.JDDG1/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[1].trim()
  }
  return null
}

function extractFileName(texts: string[]): string | null {
  const normalizeCandidate = (value: string): string | null => {
    const name = value.trim().replace(/\s+/g, "")
    return /^XHDZ[A-Za-z0-9\u4e00-\u9fa5_-]+$/.test(name) ? name : null
  }
  const patterns = [
    /(XHDZ.*?)\s*FPGA\s*软件/g,
    /(XHDZ.*?)\s*软件鉴定测评大纲/g,
    /(XHDZ.*?)\s*软件/g,
  ]

  // Keep paragraph boundaries so unrelated cover fields cannot join a name.
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const name = normalizeCandidate(match[1])
        if (name) return name
      }
    }
    if (index > 0 && /^\s*(?:FPGA\s*)?软件/.test(text)) {
      const name = normalizeCandidate(texts[index - 1])
      if (name) return name
    }
  }
  return null
}

function extractCoverDate(text: string): string | null {
  const patterns = [
    /[一二三四五六七八九〇○零]{4}\s*年\s*[一二三四五六七八九十]{1,2}\s*月(?:\s*[一二三四五六七八九十]{1,3}\s*日)?/,
    /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?/,
    /[一二三四五六七八九〇零]{4}年[一二三四五六七八九十]{1,2}月(?:[一二三四五六七八九十]{1,3}日)?/,
    /\d{4}年\d{1,2}月(?:\d{1,2}日)?/,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[0].trim().replace(/\s+/g, "")
  }
  return null
}

// ─── Signature Extraction ───────────────────────────────────────────

const LABEL_MAPPING: Record<string, string[]> = {
  std_review: ["标审", "标准审查"],
  preparation: ["编制", "编写"],
  proofread: ["校对"],
  review: ["审核", "审查"],
  countersign: ["会签"],
  approval: ["批准", "审批"],
}

function isValidSignatureValue(value: string): boolean {
  if (!value || !value.trim()) return false

  const v = value.trim()

  // Length check (Chinese names typically 2-4 chars, minorities may be longer)
  if (v.length < 2 || v.length > 20) return false

  // Must contain at least one Chinese character
  if (!/[\u4e00-\u9fa5]/.test(v)) return false

  // Exclude invalid values
  const invalidValues = new Set([
    "日期", "时间", "：", ":", "/", "\\", "|",
    "_", "__", "___", "____", "-----", "______",
    "\u3000", "□", "■", "※", "、", "，", "。", "的", "和", "与",
  ])
  if (invalidValues.has(v)) return false

  // Exclude pure special characters
  if (/^[_\-\s.:：]+$/.test(v)) return false

  // Exclude date formats
  if (/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?$/.test(v)) return false
  if (/^\d{8}$/.test(v)) return false
  if (/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(v)) return false

  // Exclude pure numbers
  if (/^\d+$/.test(v)) return false

  // Exclude version numbers
  if (/^\d+(\.\d+)+\.?$/.test(v)) return false

  // Exclude signature keywords (avoid extracting label itself)
  const signatureKeywords = [
    "编制", "校对", "审核", "标审", "会签", "批准",
    "日期", "修订", "历史", "记录", "文档", "规范",
    "标准", "指南", "手册", "说明书",
  ]
  if (signatureKeywords.some((kw) => v.includes(kw))) return false

  // Exclude digit-dot combos (version numbers)
  if (/\d+\.\d+/.test(v)) return false

  // Exclude common document terms
  const documentTerms = [
    "修订", "历史", "记录", "版本", "页码", "目录",
    "章节", "附录", "说明", "摘要", "前言", "目的",
    "范围", "引用", "术语", "缩略语",
  ]
  if (documentTerms.some((term) => v.includes(term))) return false

  // Exclude pure punctuation
  if (/^[\W_]+$/.test(v)) return false

  // Exclude placeholders
  if (/^[_\-]+$/.test(v) || /^\s+$/.test(v) || /^\.+$/.test(v) || /^X+$/.test(v)) return false

  return true
}

function extractSignatureField(text: string, labels: string[]): string | null {
  for (const label of labels) {
    // Build pattern allowing spaces between label chars (e.g. "编   制")
    const labelChars = [...label]
    const labelPattern = labelChars.join("\\s*")

    // Negative lookbehind to avoid matching labels inside compound words
    const fullLabelPattern = `(?<![文档手册说明书规范标准指南])${labelPattern}`

    // Check if label exists
    if (!new RegExp(fullLabelPattern).test(text)) continue

    // Match patterns in priority order
    const patterns = [
      // Pattern 1: label + colon + name + "日期"
      new RegExp(`${fullLabelPattern}\\s*[：:]\\s+((?:[^\\s：:]+(?:\\s{2,}[^\\s：:]+)*))\\s+日\\s*[期：:]`),
      // Pattern 2: label + colon + space + name
      new RegExp(`${fullLabelPattern}\\s*[：:]\\s+((?:[^\\s：:]+(?:\\s{2,}[^\\s：:]+)*))`),
      // Pattern 3: label + colon + name (may be adjacent)
      new RegExp(`${fullLabelPattern}\\s*[：:]((?:[^\\s：:]+(?:\\s{2,}[^\\s：:]+)*))`),
      // Pattern 4: label + colon + newline + name
      new RegExp(`${fullLabelPattern}\\s*[：:]\\s*\\n\\s*((?:[^\\s\\n：:]+(?:\\s{2,}[^\\s\\n：:]+)*))`),
      // Pattern 5: label + multiple spaces + name
      new RegExp(`${fullLabelPattern}\\s{2,}((?:[^\\s：:]+(?:\\s{2,}[^\\s：:]+)*))`),
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match) {
        // Clean: remove all whitespace from value
        const value = match[1].trim().replace(/\s+/g, "")
        if (isValidSignatureValue(value)) {
          return value
        }
      }
    }
  }
  return null
}

function extractSignatureInfo(text: string): Record<string, string | null> {
  const result: Record<string, string | null> = {
    preparation: null,
    proofread: null,
    review: null,
    std_review: null,
    countersign: null,
    approval: null,
  }

  // Pre-process: normalize whitespace
  const processed = text.replace(/[ \t]+/g, " ")

  for (const [fieldName, labels] of Object.entries(LABEL_MAPPING)) {
    // Try processed text first, then original
    let value = extractSignatureField(processed, labels)
    if (!value) {
      value = extractSignatureField(text, labels)
    }
    if (value) {
      result[fieldName] = value
    }
  }

  return result
}

// ─── Version Extraction ─────────────────────────────────────────────

function extractVersionFromText(text: string): string | null {
  if (!text) return null
  const patterns = [
    /[vV]?\s*(\d+\.\d+)/,
    /版本\s*[vV]?\s*(\d+\.\d+)/,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[1]
  }
  return null
}

// ─── Table Lookup Helpers ───────────────────────────────────────────

function findTableByTitle(tables: ParsedTable[], title: string): ParsedTable | null {
  for (const table of tables) {
    if (table.rows.length > 0) {
      for (const cell of table.rows[0]) {
        if (cell.includes(title)) return table
      }
    }
  }
  return null
}

function findTableByExactFirstRowTitle(tables: ParsedTable[], exactTitle: string): ParsedTable | null {
  for (const table of tables) {
    if (table.rows.length > 0) {
      for (const cell of table.rows[0]) {
        if (cell.trim() === exactTitle) return table
      }
    }
  }
  return null
}

function extractToolFromTable(table: ParsedTable, targetUsage: string): string | null {
  if (table.rows.length < 2) return null

  const headerRow = table.rows[0]
  let usageCol: number | null = null
  let toolCol: number | null = null

  for (let i = 0; i < headerRow.length; i++) {
    const text = headerRow[i].trim()
    if (text.includes("用途")) usageCol = i
    if (text.includes("软件项名称") || text.includes("名称")) toolCol = i
  }

  if (usageCol === null || toolCol === null) return null

  for (let r = 1; r < table.rows.length; r++) {
    const row = table.rows[r]
    if (row.length > Math.max(usageCol, toolCol)) {
      if (row[usageCol].includes(targetUsage)) {
        const toolName = row[toolCol].trim()
        if (toolName) return toolName
      }
    }
  }
  return null
}

// ─── Extended Field Extractors ──────────────────────────────────────

function extractVersionFromReviewTable(
  tables: ParsedTable[],
  tableTitle: string,
): string | null {
  const table = findTableByTitle(tables, tableTitle)
  if (!table) return null

  for (const row of table.rows) {
    for (let i = 0; i < row.length; i++) {
      if (row[i].includes("审查文档")) {
        if (i + 1 < row.length) {
          const ver = extractVersionFromText(row[i + 1])
          if (ver) return ver
        }
      }
    }
  }
  return null
}

function extractReqVersion(tables: ParsedTable[]): string | null {
  return extractVersionFromReviewTable(tables, "软件需求规格说明审查单")
}

function extractDesignVersion(tables: ParsedTable[]): string | null {
  return extractVersionFromReviewTable(tables, "软件设计文档审查单")
}

function extractGuideVersion(tables: ParsedTable[]): string | null {
  const titleCandidates = [
    "用户手册（使用说明）审查单",
    "使用说明审查单",
    "用户手册审查单",
    "用户手册（使用说明）",
    "使用说明",
    "用户手册",
  ]

  let table: ParsedTable | null = null
  for (const title of titleCandidates) {
    table = findTableByTitle(tables, title)
    if (table) break
  }
  if (!table) return null

  // Strategy 1: look for "文件/标准名称" etc.
  const nameKeywords = ["文件/标准名称", "文件名称", "文档名称", "标准名称", "名称"]
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]
    for (let i = 0; i < row.length; i++) {
      if (nameKeywords.some((kw) => row[i].includes(kw))) {
        if (i + 1 < row.length) {
          const ver = extractVersionFromText(row[i + 1])
          if (ver) return ver
        }
        // Check next row, same column
        if (r + 1 < table.rows.length && i < table.rows[r + 1].length) {
          const ver = extractVersionFromText(table.rows[r + 1][i])
          if (ver) return ver
        }
      }
    }
  }

  // Strategy 2: look for "审查文档"
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]
    for (let i = 0; i < row.length; i++) {
      if (row[i].includes("审查文档") || row[i].includes("审查文件")) {
        if (i + 1 < row.length) {
          const ver = extractVersionFromText(row[i + 1])
          if (ver) return ver
        }
        if (r + 1 < table.rows.length && i < table.rows[r + 1].length) {
          const ver = extractVersionFromText(table.rows[r + 1][i])
          if (ver) return ver
        }
        const ver = extractVersionFromText(row[i])
        if (ver) return ver
      }
    }
  }

  // Strategy 3: scan entire table
  for (const row of table.rows) {
    for (const cell of row) {
      const ver = extractVersionFromText(cell)
      if (ver) return ver
    }
  }

  return null
}

function extractStaticTestTool(tables: ParsedTable[]): string | null {
  for (const table of tables) {
    const result = extractToolFromTable(table, "代码审查")
    if (result) return result
  }
  return null
}

function extractSimulationTestTool(tables: ParsedTable[]): string | null {
  for (const table of tables) {
    const result = extractToolFromTable(table, "仿真验证")
    if (result) return result
  }
  return null
}

function extractStaticTimingAnalysisTool(tables: ParsedTable[]): string | null {
  for (const table of tables) {
    const result = extractToolFromTable(table, "静态时序分析")
    if (result) return result
  }
  return null
}

function extractPercentageFromText(text: string): string | null {
  if (!text) return null
  const match = text.match(/(\d+(?:\.\d+)?)\s*[%％]/)
  return match ? `${match[1]}%` : null
}

function extractRemainFromTable(
  tables: ParsedTable[],
  exactTitle: string,
  mode: "resource" | "clock",
): string | null {
  const table = findTableByExactFirstRowTitle(tables, exactTitle)
  if (!table) return null

  // Find "测试项描述" column
  let testItemCol: number | null = null
  for (const row of table.rows) {
    for (let i = 0; i < row.length; i++) {
      if (row[i].includes("测试项描述")) {
        testItemCol = i
        break
      }
    }
    if (testItemCol !== null) break
  }
  if (testItemCol === null) return null

  let foundHeader = false
  for (const row of table.rows) {
    if (!foundHeader) {
      if (row.some((c) => c.includes("测试项描述"))) {
        foundHeader = true
      }
      continue
    }

    if (testItemCol < row.length) {
      const cellText = row[testItemCol]
      const pct = extractPercentageFromText(cellText)
      if (!pct) continue

      const value = parseFloat(pct.replace("%", ""))

      if (mode === "resource") {
        // Resource: result is usage upper limit percentage
        let upper: number
        if (cellText.includes("使用") && !cellText.includes("余量")) {
          upper = value
        } else if (cellText.includes("余量")) {
          upper = 100 - value
        } else {
          upper = value
        }
        return `${Math.round(upper)}%`
      } else {
        // Clock: result is the remain percentage itself
        let remain: number
        if (cellText.includes("使用") && !cellText.includes("��量")) {
          remain = 100 - value
        } else if (cellText.includes("余量")) {
          remain = value
        } else {
          remain = value
        }
        return `${Math.round(remain)}%`
      }
    }
  }
  return null
}

function extractResourceRemain(tables: ParsedTable[]): string | null {
  return extractRemainFromTable(tables, "资源使用率余量", "resource")
}

function extractClockRemain(tables: ParsedTable[]): string | null {
  return extractRemainFromTable(tables, "时钟余量", "clock")
}

function extractDevelopEnvironment(tables: ParsedTable[]): string | null {
  let table = findTableByTitle(tables, "软件信息")
  if (!table) table = findTableByTitle(tables, "软件基本信息")
  if (!table) {
    // Fallback: any table with "开发环境" in header row
    for (const t of tables) {
      if (t.rows.length > 0 && t.rows[0].some((c) => c.includes("开发环境"))) {
        table = t
        break
      }
    }
  }
  if (!table || table.rows.length === 0) return null

  // Find "开发环境" column
  let devCol: number | null = null
  for (let i = 0; i < table.rows[0].length; i++) {
    if (table.rows[0][i].includes("开发环境")) {
      devCol = i
      break
    }
  }
  if (devCol === null) return null

  // Get first data row
  const dataRowIdx = table.rows.length > 1 ? 1 : 0
  const row = table.rows[dataRowIdx]
  if (devCol >= row.length) return null

  let value = row[devCol].trim()
  if (!value) return null

  // Remove parenthesized content (Chinese and English parentheses)
  value = value.replace(/[（(].*?[）)]/g, "").trim()
  return value || null
}

// ─── Full-document table extraction ─────────────────────────────────

/**
 * Parse ALL tables from the document XML (not limited by maxTables).
 * Used for extended field extraction that may reference tables deep in the document.
 */
function parseAllTables(xml: string): ParsedTable[] {
  const tables: ParsedTable[] = []
  const tblRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g
  let tblMatch: RegExpExecArray | null
  while ((tblMatch = tblRegex.exec(xml)) !== null) {
    const tblXml = tblMatch[1]
    const rows: string[][] = []
    const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
    let trMatch: RegExpExecArray | null
    while ((trMatch = trRegex.exec(tblXml)) !== null) {
      const trXml = trMatch[1]
      const cells: string[] = []
      const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
      let tcMatch: RegExpExecArray | null
      const seenTexts = new Set<string>()
      while ((tcMatch = tcRegex.exec(trXml)) !== null) {
        const tcXml = tcMatch[1]
        const cellTexts: string[] = []
        const ctRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
        let ctMatch: RegExpExecArray | null
        while ((ctMatch = ctRegex.exec(tcXml)) !== null) {
          cellTexts.push(ctMatch[1])
        }
        const cellText = cellTexts.join("").trim()
        if (cellText && !seenTexts.has(cellText)) {
          seenTexts.add(cellText)
          cells.push(cellText)
        } else if (!cellText) {
          cells.push("")
        }
      }
      if (cells.length > 0) {
        rows.push(cells)
      }
    }
    if (rows.length > 0) {
      tables.push({ rows })
    }
  }
  return tables
}

// ─── Tool Definition ────────────────────────────────────────────────

export const coverInfoExtractor: ToolDefinition = tool({
  description:
    "Extract cover page metadata (18 fields) from a reference DOCX document. " +
    "Extracts config_id, file_name, cover_date, signature info (preparation, proofread, " +
    "review, std_review, countersign, approval), version numbers (req, design, guide), " +
    "tool names (static test, simulation, static timing analysis), remain percentages " +
    "(resource, clock), and develop environment. Results are saved to .matrix/data/cover-info.json.",
  args: {
    docx_path: tool.schema
      .string()
      .describe("Path to the reference DOCX document to extract cover info from"),
    max_paragraphs: tool.schema
      .number()
      .optional()
      .describe("Maximum paragraphs to read from document start. Default: 50"),
    max_tables: tool.schema
      .number()
      .optional()
      .describe("Maximum tables to read from document start (for cover page). Default: 5"),
  },
  async execute({ docx_path, max_paragraphs, max_tables }) {
    const maxP = max_paragraphs ?? 50
    const maxT = max_tables ?? 5

    const docxPath = resolvePath(docx_path)
    if (!existsSync(docxPath)) {
      return JSON.stringify({
        status: "error",
        message: `File not found: ${docxPath}`,
      })
    }

    try {
      // Read DOCX as ZIP
      const docxBuffer = readFileSync(docxPath)
      const zipEntries = readZip(Buffer.from(docxBuffer))

      const docXmlBuf = zipEntries.get("word/document.xml")
      if (!docXmlBuf) {
        return JSON.stringify({
          status: "error",
          message: "DOCX is missing word/document.xml",
        })
      }

      const xml = docXmlBuf.toString("utf-8")

      // Parse cover-page content (limited paragraphs/tables)
      const doc = parseDocXml(xml, maxP, maxT)

      // Parse ALL tables for extended field extraction
      const allTables = parseAllTables(xml)

      // Create text versions for matching (space-joined, newline-joined, tight-joined)
      const allTexts = [
        ...doc.paragraphs,
        ...doc.tables.flatMap((t) => {
          const seen = new Set<string>()
          return t.rows.flatMap((r) =>
            r.filter((c) => {
              if (!c || seen.has(c)) return false
              seen.add(c)
              return true
            }),
          )
        }),
      ]

      const textVersions: Record<string, string> = {
        space: allTexts.join(" "),
        newline: allTexts.join("\n"),
        tight: allTexts.join(""),
      }

      // Extract basic fields
      let configId: string | null = null
      const fileName = extractFileName(allTexts)
      let coverDate: string | null = null

      for (const text of Object.values(textVersions)) {
        if (!configId) configId = extractConfigId(text)
        if (!coverDate) coverDate = extractCoverDate(text)
        if (configId && fileName && coverDate) break
      }

      // Extract signature info
      const signatureResult: Record<string, string | null> = {
        preparation: null,
        proofread: null,
        review: null,
        std_review: null,
        countersign: null,
        approval: null,
      }

      for (const text of Object.values(textVersions)) {
        const sig = extractSignatureInfo(text)
        for (const [field, value] of Object.entries(sig)) {
          if (value && !signatureResult[field]) {
            signatureResult[field] = value
          }
        }
        if (Object.values(signatureResult).every((v) => v !== null)) break
      }

      // Extract extended fields (use all tables)
      const reqVersion = extractReqVersion(allTables)
      const designVersion = extractDesignVersion(allTables)
      const guideVersion = extractGuideVersion(allTables)
      const staticTestTool = extractStaticTestTool(allTables)
      const simulationTestTool = extractSimulationTestTool(allTables)
      const staticTimingAnalysisTool = extractStaticTimingAnalysisTool(allTables)
      const resourceRemain = extractResourceRemain(allTables)
      const clockRemain = extractClockRemain(allTables)
      const developEnvironment = extractDevelopEnvironment(allTables)

      // Build result
      const coverInfo: CoverInfo = {
        config_id: configId,
        file_name: fileName,
        cover_date: coverDate,
        preparation: signatureResult.preparation,
        proofread: signatureResult.proofread,
        review: signatureResult.review,
        std_review: signatureResult.std_review,
        countersign: signatureResult.countersign,
        approval: signatureResult.approval,
        req_version: reqVersion,
        design_version: designVersion,
        guide_version: guideVersion,
        static_test_tool: staticTestTool,
        simulation_test_tool: simulationTestTool,
        static_timing_analysis_tool: staticTimingAnalysisTool,
        resource_remain: resourceRemain,
        clock_remain: clockRemain,
        develop_environment: developEnvironment,
      }

      // Count extracted fields
      const extractedCount = Object.values(coverInfo).filter((v) => v !== null).length

      // Persist to .matrix/data/cover-info.json
      const outputPath = join(process.cwd(), DATA_DIR, "cover-info.json")
      const outputDir = dirname(outputPath)
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
      writeFileSync(outputPath, JSON.stringify(coverInfo, null, 2), "utf-8")

      // Build raw_tables for agent inspection (table text representation)
      const rawTables: string[] = doc.tables.map((t, idx) => {
        const header = t.rows[0]?.join(" | ") ?? ""
        const dataRows = t.rows
          .slice(1)
          .map((r) => r.join(" | "))
          .join("\n")
        return `Table ${idx + 1}: ${header}\n${dataRows}`
      })

      return JSON.stringify({
        status: "success",
        cover_info: coverInfo,
        extracted_count: extractedCount,
        total_fields: 18,
        output_file: outputPath,
        raw_tables: rawTables,
        message: `Extracted ${extractedCount}/18 cover info fields from ${docx_path} → ${outputPath}`,
      })
    } catch (e: any) {
      return JSON.stringify({
        status: "error",
        message: `Failed to extract cover info: ${e.message}`,
      })
    }
  },
})
