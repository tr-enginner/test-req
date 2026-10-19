import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { basename, extname, join, resolve } from "path"
import { extractDocxText } from "../tools/docx-heading-numbering"

export interface ProtocolField {
  name: string
  title: string
  desc: string
  range?: string
  enum_values: string[]
  default_value?: string
  aliases: string[]
}

export interface ProtocolSummary {
  protocol_name: string
  format: string
  items: ProtocolField[]
  source_file: string
}

interface ProtocolIndexEntry {
  protocol_name: string
  file_path: string
  summary_file: string
  match_hint?: string
}

const THIRD_PARTY_REQUIREMENT_MARKER = "第三方测试需求"
const DEFAULT_PROTOCOL_REPORTS_DIR = ".matrix/reports"

function normalizeText(value: string): string {
  return value
    .replace(/[\s\t\r\n]+/g, " ")
    .replace(/[，。；：、,.!?:;()[\]{}<>\-_/\\]+/g, " ")
    .toLowerCase()
    .trim()
}

export function normalizeProtocolFieldKey(value: string): string {
  return normalizeText(value).replace(/\s+/g, "_")
}

function listThirdPartyRequirementDocxFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...listThirdPartyRequirementDocxFiles(full))
    } else if (
      entry.isFile()
      && extname(entry.name).toLowerCase() === ".docx"
      && entry.name.includes(THIRD_PARTY_REQUIREMENT_MARKER)
    ) {
      results.push(full)
    }
  }
  return results
}

function scoreProtocolCandidate(inputFlow: string, filePath: string, contentText: string): number {
  const needle = normalizeText(inputFlow)
  if (!needle) return 0
  const name = normalizeText(basename(filePath, extname(filePath)))
  let score = 0
  if (name.includes(needle)) score += 8
  const content = normalizeText(contentText)
  if (content.includes(needle)) score += 5
  return score
}

function extractEnumValues(desc: string): string[] {
  const values = new Set<string>()

  for (const match of desc.matchAll(/0x[0-9a-fA-F]+/g)) {
    values.add(match[0])
  }

  for (const match of desc.matchAll(/\b-?\d+(?:\.\d+)?\b/g)) {
    const value = match[0]
    if (/^-?\d+(?:\.\d+)?$/.test(value) && !values.has(value)) {
      values.add(value)
    }
  }

  for (const match of desc.matchAll(/[（(]([^()（）]{1,64})[)）]/g)) {
    const raw = String(match[1] ?? "")
    if (!raw.includes(":") && !raw.includes("：")) continue
    for (const part of raw.split(/[;,；，、|/]/)) {
      const value = part.split(/[:：]/)[0]?.trim()
      if (value) values.add(value)
    }
  }

  return [...values]
}

function extractDefaultValue(desc: string): string | undefined {
  const patterns = [
    /默认值(?:为|:|：)?\s*([^;；，。,]+)/,
    /默认(?:为|:|：)?\s*([^;；，。,]+)/,
  ]
  for (const pattern of patterns) {
    const value = desc.match(pattern)?.[1]?.trim()
    if (value) return value
  }
  return undefined
}

function extractAliases(name: string, desc: string): string[] {
  const aliases = new Set<string>()
  const trimmed = name.trim()
  if (trimmed) aliases.add(trimmed)

  const normalized = normalizeProtocolFieldKey(trimmed)
  if (normalized && normalized !== trimmed) aliases.add(normalized)

  for (const match of trimmed.matchAll(/[（(]([^()（）]{1,48})[)）]/g)) {
    const value = String(match[1] ?? "").trim()
    if (value) aliases.add(value)
  }

  for (const match of desc.matchAll(/(?:又称|别名|简称)[:：]?\s*([^;；，。,]+)/g)) {
    const raw = String(match[1] ?? "")
    for (const part of raw.split(/[、,，/|]/)) {
      const alias = part.trim()
      if (alias) aliases.add(alias)
    }
  }

  return [...aliases]
}

// ---------------------------------------------------------------------------
// Table reference extraction from requirement text
// ---------------------------------------------------------------------------

export interface TableReference {
  table_id: string
  raw_match: string
  context: string
}

/**
 * Extract table references from requirement handling text.
 * Matches patterns like "表3.1.2-1", "表3.1.1-2、3.1.1-3", "表1", etc.
 */
export function extractTableReferences(text: string): TableReference[] {
  const results: TableReference[] = []
  // Match "表X.Y.Z-W" or "表N" patterns
  const tableRegex = /表\s*([\d]+(?:\.\d+)*(?:[-–—]\d+)?)/g
  let match: RegExpExecArray | null
  const seen = new Set<string>()

  while ((match = tableRegex.exec(text)) !== null) {
    const tableId = match[1].trim()
    if (seen.has(tableId)) continue
    seen.add(tableId)

    // Extract surrounding context (up to 60 chars)
    const start = Math.max(0, match.index - 20)
    const end = Math.min(text.length, match.index + match[0].length + 40)
    const context = text.slice(start, end).replace(/\s+/g, " ").trim()

    results.push({
      table_id: tableId,
      raw_match: match[0].trim(),
      context,
    })
  }

  return results
}

/**
 * Match table references against parsed protocol semantic tables.
 * Returns matching tables with relevance scores.
 */
export function matchTableReferencesToProtocol(
  references: TableReference[],
  tableTitles: string[],
): Array<{ reference: TableReference; matched_title: string; score: number }> {
  const results: Array<{ reference: TableReference; matched_title: string; score: number }> = []

  for (const ref of references) {
    for (const title of tableTitles) {
      const normalizedTitle = title.replace(/[表\s]/g, "")
      const normalizedRef = ref.table_id.replace(/[表\s]/g, "")
      let score = 0

      if (normalizedTitle === normalizedRef) {
        score = 10
      } else if (normalizedTitle.includes(normalizedRef) || normalizedRef.includes(normalizedTitle)) {
        score = 6
      } else if (normalizedTitle.startsWith(normalizedRef.split(".")[0] || "")) {
        score = 3
      }

      if (score > 0) {
        results.push({ reference: ref, matched_title: title, score })
      }
    }
  }

  return results.sort((a, b) => b.score - a.score)
}

export function inferProtocolFormat(text: string, filePath: string): string {
  const corpus = `${basename(filePath)}\n${text}`.toLowerCase()
  if (corpus.includes("cana")) return "CANA"
  if (corpus.includes("can")) return "CAN"
  if (corpus.includes("1553")) return "1553B"
  if (corpus.includes("uart") || corpus.includes("串口")) return "UART"
  if (corpus.includes("以太网") || corpus.includes("ethernet")) return "Ethernet"
  return "generic"
}

function splitProtocolLine(line: string): { title: string; desc: string } | null {
  const delimiterIndex = line.search(/[：:]/)
  if (delimiterIndex <= 0) return null

  const title = line.slice(0, delimiterIndex).trim()
  const desc = line.slice(delimiterIndex + 1).trim()
  if (!title || !desc || title.length > 64) return null

  return { title, desc }
}

export function extractProtocolItemsFromText(text: string): ProtocolField[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const items: ProtocolField[] = []

  for (const line of lines) {
    const split = splitProtocolLine(line)
    if (!split) continue

    const { title, desc } = split
    const rangeMatch = desc.match(/(?:取值范围|取值区间|范围|区间|取值)[:：]?\s*([^;；，。]+)/)
    const range = rangeMatch?.[1]?.trim() || undefined
    const field: ProtocolField = {
      name: title,
      title,
      desc,
      range,
      enum_values: extractEnumValues(desc),
      default_value: extractDefaultValue(desc),
      aliases: extractAliases(title, desc),
    }
    items.push(field)
  }

  return items.slice(0, 80)
}

export function buildProtocolSummaryFromText(filePath: string, text: string): ProtocolSummary {
  return {
    protocol_name: basename(filePath, extname(filePath)),
    format: inferProtocolFormat(text, filePath),
    items: extractProtocolItemsFromText(text),
    source_file: filePath,
  }
}

export async function parseProtocolDocx(filePath: string): Promise<ProtocolSummary> {
  const text = await extractDocxText(filePath)
  return buildProtocolSummaryFromText(filePath, text)
}

export function loadProtocolSummary(filePath: string): ProtocolSummary {
  return JSON.parse(readFileSync(filePath, "utf-8")) as ProtocolSummary
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
}

function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !isWindowsAbsolutePath(value)
}

function resolveSearchDir(projectDir: string, dir: string): string {
  if (isPosixAbsolutePath(dir) || isWindowsAbsolutePath(dir)) return dir
  if (isPosixAbsolutePath(projectDir)) {
    const base = projectDir.replace(/\/+$/, "")
    const child = dir.replace(/^[\\/]+/, "").replace(/\\/g, "/")
    return `${base}/${child}`
  }
  return resolve(projectDir, dir)
}

export function resolveProtocolSearchDirs(
  projectDir: string,
  _configuredDirs?: string[],
): string[] {
  return [resolveSearchDir(projectDir, DEFAULT_PROTOCOL_REPORTS_DIR)]
}

export async function findProtocolForInputFlow(
  inputFlow: string,
  projectDir: string,
  configuredDirs?: string[],
): Promise<{ summary?: ProtocolSummary; summary_file?: string; warnings: string[] }> {
  const warnings: string[] = []
  const dirs = resolveProtocolSearchDirs(projectDir, configuredDirs)
  const docxFiles = dirs.flatMap((dir) => listThirdPartyRequirementDocxFiles(dir)).sort((a, b) => a.localeCompare(b))
  if (docxFiles.length === 0) {
    return {
      warnings: warnings.concat("未找到 .matrix/reports 目录下文件名包含“第三方测试需求”的 DOCX 文档。"),
    }
  }

  const candidates: Array<{ path: string; score: number; text: string }> = []
  for (const file of docxFiles) {
    try {
      const text = await extractDocxText(file)
      candidates.push({
        path: file,
        score: scoreProtocolCandidate(inputFlow, file, text),
        text,
      })
    } catch (err) {
      warnings.push(`第三方测试需求文档读取失败: ${file} (${String(err)})`)
    }
  }

  if (candidates.length === 0) {
    return { warnings: warnings.concat("未找到可读取的第三方测试需求 DOCX 文档。") }
  }

  candidates.sort((a, b) => {
    const scoreDelta = b.score - a.score
    return scoreDelta !== 0 ? scoreDelta : a.path.localeCompare(b.path)
  })

  const best = candidates[0]
  if (best.score <= 0) {
    if (candidates.length === 1) {
      warnings.push(`唯一第三方测试需求文档未匹配到输入流“${inputFlow}”，仍使用该文档: ${best.path}`)
    } else {
      warnings.push(`多个第三方测试需求文档均未匹配到输入流“${inputFlow}”，按路径顺序使用: ${best.path}`)
    }
  }

  const summary = buildProtocolSummaryFromText(best.path, best.text)
  const summaryFile = persistProtocolSummary(projectDir, summary, inputFlow)
  return { summary, summary_file: summaryFile, warnings }
}

function persistProtocolSummary(
  projectDir: string,
  summary: ProtocolSummary,
  inputFlow?: string,
): string {
  const protocolsDir = join(projectDir, ".matrix", "data", "protocols")
  mkdirSync(protocolsDir, { recursive: true })
  const outPath = join(protocolsDir, `${summary.protocol_name}.json`)
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n")

  const indexPath = join(protocolsDir, "index.json")
  const index: ProtocolIndexEntry[] = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf-8"))
    : []
  const existing = index.find((entry) => entry.protocol_name === summary.protocol_name)
  if (!existing) {
    index.push({
      protocol_name: summary.protocol_name,
      file_path: summary.source_file,
      summary_file: outPath,
      match_hint: inputFlow,
    })
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n")
  return outPath
}

// ---------------------------------------------------------------------------
// Requirement Pattern Classification
// ---------------------------------------------------------------------------

export type RequirementPattern =
  | "can_communication"     // "接收X轮询→发送Y数据" via CAN bus
  | "telemetry_acquisition" // "采集FPGA遥测→组帧发送"
  | "command_execution"     // "接收X指令→执行Y操作/设置Y值"
  | "autonomous_management" // "检测X状态→执行Y动作"
  | "broadcast_processing"  // "接收X广播→提取Y信息"
  | "data_upload"           // "接收上行数据块→写入存储"
  | "general"

/**
 * Classify the requirement's operation pattern from its text content.
 * Used to select the right step plan template and keyword family.
 */
export function classifyRequirementPattern(
  handling: string,
  inputFlow: string,
  outputFlow: string,
  chapterContent: string,
): RequirementPattern {
  const combined = `${handling} ${inputFlow} ${outputFlow} ${chapterContent}`.toLowerCase()

  // CAN communication: polling/control sequence based
  // Must involve "轮询" OR explicit CAN bus send with polling context
  if (/轮询控制序列/.test(combined)) return "can_communication"
  if (/通过.*can.*发送.*轮询|轮询.*通过.*can.*发送/i.test(combined)) return "can_communication"

  // Telemetry acquisition: collect FPGA data, assemble and send
  if (/采集.*遥测|读取.*遥测|采集.*fpga|读取.*状态量/.test(combined)) return "telemetry_acquisition"
  if (/组帧发送.*遥测|采集.*组帧/.test(combined)) return "telemetry_acquisition"

  // Command execution: receive command → execute operation
  // Handle cases where "指令" and the operation ("设置"/"写入"/"转发") are separated by other text
  if (/间接指令.*设置|间接指令.*写入|间接指令.*转发/.test(combined)) return "command_execution"
  if (/接收到.*指令.*(?:设置|写入|转发|执行)/.test(combined)) return "command_execution"
  if (/接收到.*指令.*则/.test(combined)) return "command_execution"
  if (/若.*接收到.*指令/.test(combined)) return "command_execution"

  // Autonomous management: detect state → take action
  if (/连续.*检测|自主管理|超过.*时间|大于.*分钟/.test(combined)) return "autonomous_management"

  // Broadcast processing: receive broadcast → extract/store
  if (/广播.*提取|广播.*授时|广播.*写入/.test(combined)) return "broadcast_processing"
  if (/接收到.*广播/.test(combined)) return "broadcast_processing"

  // Data upload: receive upload data block → write to storage
  if (/上行数据块.*写入|上注.*标识|上注.*flash/i.test(combined)) return "data_upload"

  return "general"
}

// ---------------------------------------------------------------------------
// Interface Context Extraction — structured interface info per requirement
// ---------------------------------------------------------------------------

export interface InterfaceContext {
  bus_type: "CAN" | "1553B" | "UART" | "generic"
  dual_redundant: boolean
  bus_info: {
    cana_data_addr?: string
    canb_data_addr?: string
    cana_latch_addr?: string
    canb_latch_addr?: string
    interrupt?: string
    mode?: string
    clock?: string
    speed?: string
  }
  section_path: string[]
  parent_section_summary: string
  input_flow_name: string
  input_flow_section: string
  output_flow_name: string
  output_flow_section: string
  referenced_tables: string[]
  channel_keywords: {
    cana_send: string
    canb_send: string
  }
}

interface MarkdownSection {
  level: number       // 1=###, 2=####
  title: string
  lineIndex: number
}

/**
 * Parse the protocol markdown document to extract interface context for a requirement.
 * Uses table references in requirement.handling to locate the relevant protocol section,
 * then walks up to extract bus info, dual-redundancy, and flow names.
 */
export function extractInterfaceContext(
  requirementHandling: string,
  requirementInputFlow: string,
  requirementOutputFlow: string,
  protocolMarkdown: string,
): InterfaceContext | null {
  const lines = protocolMarkdown.split("\n")

  // Parse section headers
  const sections: MarkdownSection[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,4})\s+(.+)/)
    if (m) {
      sections.push({
        level: m[1].length - 2,  // ##=0, ###=1, ####=2
        title: m[2].trim(),
        lineIndex: i,
      })
    }
  }

  // Extract table references from requirement handling
  const tableRefs = extractTableReferences(requirementHandling)
  const tableIds = tableRefs.map(r => r.table_id)

  // Find the section that contains these table references
  let matchedSection: MarkdownSection | null = null
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si]
    // Check if any table ref appears in the next few lines or in the section title itself
    const checkEnd = si + 1 < sections.length ? sections[si + 1].lineIndex : lines.length
    for (let li = section.lineIndex; li < checkEnd; li++) {
      for (const tableId of tableIds) {
        if (lines[li].includes(tableId)) {
          matchedSection = section
          break
        }
      }
      if (matchedSection) break
    }
    if (matchedSection) break
  }

  // Fallback: match requirement flow keywords against section titles.
  // When inputFlow is very short (e.g. "间接指令。"), prefer outputFlow which is more descriptive.
  const inputFlowShort = !requirementInputFlow || requirementInputFlow.replace(/[a-f]\.\s*/g, "").replace(/[。，,；;\s]/g, "").length < 5
  const primaryFlow = inputFlowShort ? null : requirementInputFlow
  const secondaryFlow = inputFlowShort ? requirementInputFlow : requirementOutputFlow
  const tertiaryFlow = inputFlowShort ? requirementOutputFlow : null

  for (const flowText of [primaryFlow, secondaryFlow, tertiaryFlow]) {
    if (!flowText || matchedSection) continue

    const flowKeywords = flowText
      .replace(/[a-f]\.\s*/g, "")
      .split(/[；;\n]/)
      .map(s => s.replace(/[。，,]$/, "").trim())
      .filter(s => s.length >= 2)

    for (const kw of flowKeywords) {
      // Try exact keyword match first (if kw is meaningful)
      if (kw.length >= 3) {
        for (const section of sections) {
          if (section.title.includes(kw)) {
            matchedSection = section
            break
          }
        }
        if (matchedSection) break

        // Try partial match
        const partial = kw.slice(0, Math.min(kw.length, 8))
        for (const section of sections) {
          if (/^(输入流|输出流)/.test(section.title) && section.title.includes(partial)) {
            matchedSection = section
            break
          }
        }
        if (matchedSection) break
      }

      // For short keywords, try substring match against section titles
      if (kw.length >= 2) {
        for (const section of sections) {
          if (section.title.includes(kw) || kw.includes(section.title.slice(0, kw.length + 2))) {
            matchedSection = section
            break
          }
        }
        if (matchedSection) break
      }
    }
  }

  if (!matchedSection) return null

  // Walk backward to find the paired input/output flow section
  const isOutputFlow = /^输出流/.test(matchedSection.title)
  const isInputFlow = /^输入流/.test(matchedSection.title)

  let inputSection: MarkdownSection | null = isInputFlow ? matchedSection : null
  let outputSection: MarkdownSection | null = isOutputFlow ? matchedSection : null

  // Find the nearest preceding input flow if we matched on output flow, or vice versa
  if (isOutputFlow) {
    for (let si = sections.indexOf(matchedSection) - 1; si >= 0; si--) {
      if (/^输入流/.test(sections[si].title)) {
        inputSection = sections[si]
        break
      }
    }
  } else if (isInputFlow) {
    for (let si = sections.indexOf(matchedSection) + 1; si < sections.length; si++) {
      if (/^输出流/.test(sections[si].title)) {
        outputSection = sections[si]
        break
      }
    }
  }

  // Extract flow names from section titles
  const inputFlowName = inputSection
    ? inputSection.title.replace(/^输入流[:：]\s*/, "").split(/[，,]/)[0].trim()
    : ""
  const outputFlowName = outputSection
    ? outputSection.title.replace(/^输出流[:：]\s*/, "").split(/[，,]/)[0].trim()
    : ""

  // Collect referenced table titles
  const referencedTables: string[] = []
  for (const section of sections) {
    if (section.level === 2) { // #### table titles
      for (const tableId of tableIds) {
        if (section.title.includes(tableId)) {
          referencedTables.push(section.title)
        }
      }
    }
  }

  // Walk backward from matched section to find parent interface description
  // Look for paragraph text containing "CAN", "总线", "接口", "IF-"
  // Stop at XML blocks, table sections, or previous flow sections
  const searchStart = inputSection ? inputSection.lineIndex : matchedSection.lineIndex
  let parentSummary = ""
  const parentParagraphs: string[] = []
  for (let li = searchStart - 1; li >= Math.max(0, searchStart - 50); li--) {
    const line = lines[li].trim()
    if (!line || line.startsWith("#") || line.startsWith("```") || line.startsWith("*所属")) continue
    if (line.startsWith("<") || line.startsWith("</")) break  // stop at XML blocks
    if (/^(输入流|输出流)[:：]/.test(line)) break  // hit another flow section
    if (/^### 表\d+:/.test(line)) break  // hit another table section
    parentParagraphs.unshift(line)
  }
  parentSummary = parentParagraphs.join(" ")

  // Detect bus type and dual-redundancy from parent text.
  // Fallback: if parent scan didn't find bus info, check the requirement text itself.
  const fullTextForDetection = parentSummary + " " + requirementHandling + " " + requirementInputFlow + " " + requirementOutputFlow
  const busType = /CAN/i.test(parentSummary) ? "CAN"
    : /1553/i.test(parentSummary) ? "1553B"
    : /UART|串口/i.test(parentSummary) ? "UART"
    : /CAN/i.test(fullTextForDetection) ? "CAN"  // fallback: detect from requirement text
    : /间接指令/.test(fullTextForDetection) ? "CAN"  // indirect commands are always CAN in this domain
    : "generic"

  const dualRedundant = /A.*B.*(互相备份|互为备份|冗余|备份)|(互相备份|互为备份|冗余|备份).*A.*B|CANA.*CANB|CANB.*CANA/.test(parentSummary)
    || /CANA.*CANB|CANB.*CANA/.test(fullTextForDetection)

  // Extract bus addresses from parent text
  const busInfo: InterfaceContext["bus_info"] = {}
  const addrAMatch = parentSummary.match(/A总线(?:数据锁存)?地址(?:锁存)?为\s*([0-9A-Fa-f]+H?)/)
  if (addrAMatch) busInfo.cana_data_addr = addrAMatch[1]
  const addrBMatch = parentSummary.match(/B总线(?:数据锁存)?地址(?:锁存)?为\s*([0-9A-Fa-f]+H?)/)
  if (addrBMatch) busInfo.canb_data_addr = addrBMatch[1]
  const latchAMatch = parentSummary.match(/A总线地址锁存为\s*([0-9A-Fa-f]+H?)/)
  if (latchAMatch) busInfo.cana_latch_addr = latchAMatch[1]
  const latchBMatch = parentSummary.match(/B总线地址锁存为\s*([0-9A-Fa-f]+H?)/)
  if (latchBMatch) busInfo.canb_latch_addr = latchBMatch[1]
  const intMatch = parentSummary.match(/外部中断(\d+)/)
  if (intMatch) busInfo.interrupt = intMatch[1]
  const modeMatch = parentSummary.match(/(BASIC|PELICAN|EXTENDED)\s*模式/)
  if (modeMatch) busInfo.mode = modeMatch[1]
  const clockMatch = parentSummary.match(/时钟为\s*([\d.]+MHz)/)
  if (clockMatch) busInfo.clock = clockMatch[1]
  const speedMatch = parentSummary.match(/传输速率[为约]?\s*([\d.]+K?Hz)/)
  if (speedMatch) busInfo.speed = speedMatch[1]

  // Determine the right keyword channel names
  const channelKeywords = {
    cana_send: "发送CANA数据_数据文件",
    canb_send: "发送CANB数据_数据文件",
  }

  return {
    bus_type: busType,
    dual_redundant: dualRedundant,
    bus_info: busInfo,
    section_path: [],
    parent_section_summary: parentSummary,
    input_flow_name: inputFlowName,
    input_flow_section: inputSection?.title || "",
    output_flow_name: outputFlowName,
    output_flow_section: outputSection?.title || "",
    referenced_tables: referencedTables,
    channel_keywords: channelKeywords,
  }
}
