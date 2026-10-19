import { trackRaw, restoreEditOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { HardwareInterfaceRaw, HardwareCandidatesRaw } from "../schema/phase2-hardware-raw"
import { readPhase2Json } from "../shared/phase2-json"
import { withPhase2Diagnostics, phase2Warnings, phase2Warning, relaxedReferenceSchema, referenceDefaults, normalizeLocalTables } from "../shared/phase2-tolerance"
import { assignStableRequirementIds } from "../shared/phase2-stable-ids"
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import Ajv, { type ErrorObject } from "ajv"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from "path"
import { filldataParser } from "./filldata-parser"
import {
  buildDocumentStructureArtifact,
  writeDocumentStructureArtifacts,
  type DocumentStructureArtifact,
  type TableAssetArtifact,
} from "./document-structure-artifact"
import { renderHardwareInterfaceDocx } from "./hardware-interface-docx"
import { renderFunctionalInitContentDocx } from "./functional-init-content-docx"
import { renderFunctionalOtherContentDocx } from "./functional-other-content-docx"
import { renderFunctionalTestContentDocx } from "./functional-test-content-docx"
import { readZip } from "./docx-zip"
import { resolveHeadings, shouldSuppressDocxBodyHeading, type HeadingEntry } from "./docx-heading-resolver"
import { writeDocumentQualityReport } from "./document-quality-report"
import { finalizeInterfaceTestContent, getInterfaceTestWorkerBatch, prepareInterfaceTestContent } from "./interface-test-workflow"
import { finalizePerformanceTestContent, preparePerformanceTestContent } from "./performance-test-workflow"
import { finalizeReliabilitySafetyTestContent, prepareReliabilitySafetyTestContent } from "./reliability-safety-test-workflow"
import { finalizeMarginTestContent, prepareMarginTestContent } from "./margin-test-workflow"
import { finalizeBoundaryTestContent, prepareBoundaryTestContent } from "./boundary-test-workflow"
import { finalizeDataProcessingTestContent, prepareDataProcessingTestContent } from "./data-processing-test-workflow"
import { finalizeRecoveryTestContent, prepareRecoveryTestContent } from "./recovery-test-workflow"
import { finalizeStrengthTestContent, prepareStrengthTestContent } from "./strength-test-workflow"
import { finalizePhase2Document } from "./phase2-document-workflow"
import { generateFunctionalTestTraceability } from "./functional-test-traceability-workflow"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { docxTableXmlToHtml } from "./docx-table-html"
import { finalizeChapter1Scope, prepareChapter1Scope } from "./chapter1-scope-workflow"
import { finalizeChapter2SystemOverview, prepareChapter2SystemOverview } from "./chapter2-system-overview-workflow"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"

/**
 * /matrix-phase2 Phase 2 的确定性状态机。
 *
 * 这条链路只把两类语义判断交给 worker：
 * 1. source-planner 只根据候选文件名选择唯一主 SRS。
 * 2. hardware-interface-modeler 只根据 source-artifacts 判断 CAN/FPGA/SpaceWire/SPI 结构、输入输出流和应引用的原文表格。
 *
 * 代码侧负责固定流程、抽取 source artifacts、校验表格身份并生成 DOCX。表格不是由模型重画：
 * modeler 只能输出真实存在的 table_id，并写出 hardware-interface-model.raw.json；
 * finalize_hardware_interface 再从 source-artifacts 硬回填 table_asset，产出 hardware-interface-model.json；
 * hardware-interface-docx 最后按 table_asset.path 读取抽取阶段保存的原表 XML。匹配不到真实 DOCX 表资源时直接失败。
 */

type SupportedFormat = "text" | "docx" | "pdf"
type PreparedDocumentRole = "primary_srs" | "other_document"

interface DocumentCandidate {
  file_path: string
  file_name: string
}

interface DocumentCandidatesArtifact {
  documents: DocumentCandidate[]
}

interface SourcePlanArtifact {
  primary_srs_path: string
  other_document_paths: string[]
}

interface PreparedSourceDocumentArtifact {
  path: string
  role: PreparedDocumentRole
  format: string
  segments_path: string
  toc_path: string
  structure_path: string
  structure_warnings_path?: string
}

interface SourceArtifactsManifest {
  source_plan_path: string
  document_quality_report_path?: string
  primary_document: PreparedSourceDocumentArtifact
  supporting_documents: PreparedSourceDocumentArtifact[]
}

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

interface HardwareInterfaceModelAcquisitionProcess {
  title?: string
  content?: unknown
  source_refs?: unknown
}

interface HardwareInterfaceModelCanFpgaBlock {
  interface_type?: string
  title?: string
  overview?: string
  source_refs?: unknown
  overview_tables?: HardwareInterfaceModelTable[]
  subsections?: HardwareInterfaceModelSubsection[]
}

interface HardwareInterfaceModelAdBlock {
  interface_type?: string
  title?: string
  overview?: string
  source_refs?: unknown
  acquisition_processes?: HardwareInterfaceModelAcquisitionProcess[]
  input_flow?: unknown
  input_tables?: HardwareInterfaceModelTable[]
  output_flow?: unknown
  output_tables?: HardwareInterfaceModelTable[]
}

interface HardwareInterfaceModelSerialBlock {
  interface_type?: string
  title?: string
  overview?: string
  source_refs?: unknown
  timing_description?: unknown
  flow_order?: unknown
  input_flow?: unknown
  input_tables?: HardwareInterfaceModelTable[]
  output_flow?: unknown
  output_tables?: HardwareInterfaceModelTable[]
}

type HardwareInterfaceModelBlock =
  | HardwareInterfaceModelCanFpgaBlock
  | HardwareInterfaceModelAdBlock
  | HardwareInterfaceModelSerialBlock

interface HardwareInterfaceModelArtifact {
  model_version?: number
  candidate_source?: string
  chapter_title?: string
  section_title?: string
  blocks?: HardwareInterfaceModelBlock[]
  interfaces?: GenericHardwareInterface[]
}

type HardwareInterfaceKind = "can" | "fpga" | "ad" | "serial" | "spi" | "spacewire" | "watchdog" | "gpio" | "discrete" | "ethernet" | "mil1553b" | "i2c" | "other"

interface HardwareInterfaceCandidate {
  candidate_id: string
  interface_name: string
  interface_kind: HardwareInterfaceKind
  keywords: string[]
  source_refs: string[]
  evidence_summary: string
}

interface HardwareInterfaceCandidatesArtifact {
  model_version: 1
  source_artifacts_path: string
  candidates: HardwareInterfaceCandidate[]
}

interface HardwareInterfaceClassificationRepair {
  candidate_id: string
  interface_name: string
  original_kind: HardwareInterfaceKind
  resolved_kind: HardwareInterfaceKind
  scores: Record<"mil1553b" | "ad" | "serial" | "can" | "watchdog", number>
  evidence: string[]
  decision_rule: string
  timestamp: string
}

interface HardwareInterfaceClassificationWarning {
  candidate_id: string
  code: "SPECIALIZED_SKILL_TIE" | "CLASSIFICATION_PERSIST_FAILED"
  message: string
}

interface GenericHardwareInterfaceTopic {
  title?: string
  source_refs?: unknown
  input_flow?: unknown
  input_tables?: HardwareInterfaceModelTable[]
  output_flow?: unknown
  output_tables?: HardwareInterfaceModelTable[]
}

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

interface GenericHardwareInterfaceArtifact {
  interface?: GenericHardwareInterface | null
}

interface HardwareInterfaceDiscoveryBatch {
  subagent_type: "hardware-interface-discoverer"
  output_path: string
  worker_payload: { worker_type: string; input_artifact_path: string; output_path: string }
  worker_prompt: string
}

interface GenericHardwareInterfaceWorkerBatch {
  subagent_type: "hardware-interface-modeler"
  candidate_id: string
  interface_name: string
  interface_kind: HardwareInterfaceKind
  output_path: string
  worker_payload: {
    worker_type: string
    input_artifact_path: string
    candidates_path: string
    candidate_id: string
    output_path: string
  }
  worker_prompt: string
}

interface HardwareInterfaceWorkerManifest {
  schema_version: 1
  source_artifacts_path: string
  hardware_interface_candidates_path: string
  worker_batches: GenericHardwareInterfaceWorkerBatch[]
}

interface RawArtifactReadResult {
  value: unknown
  repaired: boolean
}

interface FunctionalTitleTreeNode {
  title_no?: string
  title?: string
  tr_code?: string
  source_ref?: string
  children?: FunctionalTitleTreeNode[]
}

interface FunctionalTitleTreeRouting {
  has_initialization?: boolean
  initialization_title_no?: string | null
  initialization_source_ref?: string | null
}

interface FunctionalTitleTreeRawArtifact {
  functional_root_source_ref?: string
  root_title?: string
  children?: FunctionalTitleTreeNode[]
  skipped_source_refs?: string[]
  routing?: FunctionalTitleTreeRouting
}

interface FunctionalTitleTreeArtifact extends FunctionalTitleTreeRawArtifact {
  chapter_title_no: "4"
  chapter_title: string
  section_title_no: "4.1"
  section_title: string
  functional_root_source_ref: string
  root_title: string
  children: FunctionalTitleTreeNode[]
  skipped_source_refs: string[]
  routing: Required<FunctionalTitleTreeRouting>
}

interface FunctionalTitleTreeWorkerBatch {
  subagent_type: "functional-title-tree-modeler"
  output_path: string
  worker_payload: {
    worker_type: string
    input_artifact_path: string
    output_path: string
  }
  worker_prompt: string
}

interface FunctionalInitContentTableRow {
  [key: string]: string | undefined
  "名称"?: string
  "地址/寄存器地址"?: string
  "初值"?: string
  "初值含义"?: string
}

interface FunctionalInitContentTable {
  table_id?: string
  table_no?: string
  title?: string
  columns?: string[]
  rows?: FunctionalInitContentTableRow[]
}

interface FunctionalInitContentItem {
  title_no?: string
  title?: string
  tr_code?: string
  source_ref?: string
  source_refs?: string[]
  summary?: string
  input_flow?: string[]
  processing?: FunctionalOtherProcessingItem[]
  output_flow?: string[]
  tables?: FunctionalInitContentTable[]
}

interface FunctionalInitContentRawArtifact {
  section_title_no?: string
  section_title?: string
  allow_code?: boolean
  items?: FunctionalInitContentItem[]
  skipped_title_refs?: string[]
  open_questions?: string[]
}

interface FunctionalInitContentArtifact extends FunctionalInitContentRawArtifact {
  chapter_title_no: "4"
  chapter_title: string
  parent_section_title_no: "4.1"
  parent_section_title: string
  section_title_no: string
  section_title: string
  allow_code: boolean
  items: FunctionalInitContentItem[]
  skipped_title_refs: string[]
  open_questions: string[]
}

interface FunctionalInitContentWorkerBatch {
  subagent_type: "functional-init-content-modeler"
  output_path: string
  worker_payload: {
    worker_type: string
    input_artifact_path: string
    source_artifacts_path: string
    chapter2_system_overview_path: string
    hardware_interface_model_path: string
    hardware_interface_report_text_path: string
    functional_title_tree_path: string
    output_path: string
    allow_code: boolean
  }
  worker_prompt: string
}

interface FunctionalOtherProcessingItem {
  requirement_id?: string
  source_refs?: string[]
  content?: string
  table_refs?: string[]
}

interface FunctionalOtherContentTable {
  table_id?: string
  table_no?: string
  title?: string
  columns?: string[]
  rows?: Array<Record<string, string>>
}

interface FunctionalOtherContentItem {
  title_no?: string
  title?: string
  tr_code?: string
  source_ref?: string
  source_refs?: string[]
  summary?: string
  input_flow?: string[]
  processing?: FunctionalOtherProcessingItem[]
  output_flow?: string[]
  tables?: FunctionalOtherContentTable[]
}

interface FunctionalOtherContentRawArtifact {
  section_title_no?: string
  section_title?: string
  excluded_title_nos?: string[]
  items?: FunctionalOtherContentItem[]
  skipped_title_refs?: string[]
  open_questions?: string[]
}

interface FunctionalOtherContentArtifact extends FunctionalOtherContentRawArtifact {
  chapter_title_no: "4"
  chapter_title: string
  section_title_no: "4.1"
  section_title: string
  excluded_title_nos: string[]
  items: FunctionalOtherContentItem[]
  skipped_title_refs: string[]
  open_questions: string[]
}

interface FunctionalOtherTargetLeaf {
  title_no: string
  title: string
  tr_code: string
  source_ref: string
}

interface FunctionalOtherContentWorkerBatch {
  subagent_type: "functional-other-content-modeler"
  output_path: string
  worker_payload: {
    worker_type: string
    input_artifact_path: string
    source_artifacts_path: string
    functional_title_tree_path: string
    hardware_interface_report_path: string
    hardware_interface_report_text_path: string
    target_leaf: FunctionalOtherTargetLeaf
    excluded_title_nos: string[]
    output_path: string
  }
  worker_prompt: string
}

interface FunctionalOtherContentWorkerManifest {
  schema_version: 1
  source_artifacts_path: string
  functional_title_tree_path: string
  hardware_interface_report_path: string
  excluded_title_nos: string[]
  target_leaves: FunctionalOtherTargetLeaf[]
  functional_other_content_raw_paths: string[]
  worker_batches: FunctionalOtherContentWorkerBatch[]
}

interface FunctionalTestContentNode extends FunctionalTitleTreeNode {
  content_type?: "initialization" | "other" | null
  init_content?: FunctionalInitContentItem
  other_content?: FunctionalOtherContentItem
  children?: FunctionalTestContentNode[]
}

interface FunctionalTestContentArtifact {
  chapter_title_no: "4"
  chapter_title: string
  section_title_no: "4.1"
  section_title: string
  routing: Required<FunctionalTitleTreeRouting>
  initialization_skipped: boolean
  source_paths: {
    functional_title_tree_path: string
    functional_init_content_path?: string
    functional_other_content_path: string
  }
  children: FunctionalTestContentNode[]
}

function resolveNormalizedPath(path: string): string {
  return resolve(path)
}

const IGNORED_DIRS = new Set([
  ".git",
  ".matrix",
  "node_modules",
  "dist",
  "coverage",
  "$RECYCLE.BIN",
  "System Volume Information",
])

function isFilesystemRoot(path: string): boolean {
  const resolved = resolve(path)
  return parse(resolved).root === resolved
}

function getBaseDirectory(ctx: ToolContext): string {
  const candidates = [ctx.directory, ctx.worktree, process.cwd()].filter((value): value is string => typeof value === "string" && value.length > 0)
  const preferred = candidates.find((value) => !isFilesystemRoot(value))
  return preferred || candidates[0] || process.cwd()
}

function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const rootResolved = resolve(rootPath)
  const candidateResolved = resolve(candidatePath)
  const rootComparable = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved
  const candidateComparable = process.platform === "win32" ? candidateResolved.toLowerCase() : candidateResolved
  const rel = relative(rootComparable, candidateComparable)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function resolveDocumentRootPath(ctx: ToolContext, supplied?: string): string {
  const baseDir = getBaseDirectory(ctx)
  const documentRoot = supplied
    ? isAbsolute(supplied) ? supplied : join(baseDir, supplied)
    : baseDir
  if (isFilesystemRoot(documentRoot)) {
    throw new Error(`Refusing to scan filesystem root for documents: ${resolve(documentRoot)}. Run the command from the project folder or pass a subdirectory under it.`)
  }
  if (!isPathInsideOrEqual(baseDir, documentRoot)) {
    throw new Error(`document_root_path must stay inside the current project directory. project=${baseDir}; requested=${resolve(documentRoot)}.`)
  }
  return resolve(documentRoot)
}

function resolveArtifactPath(ctx: ToolContext, supplied: string | undefined, defaultName: string): string {
  const base = getBaseDirectory(ctx)
  if (supplied) {
    return isAbsolute(supplied) ? supplied : join(base, supplied)
  }
  return join(base, ".matrix", "data", defaultName)
}

function resolveReportPath(ctx: ToolContext, supplied: string | undefined, defaultName: string): string {
  const base = getBaseDirectory(ctx)
  if (supplied) {
    return isAbsolute(supplied) ? supplied : join(base, supplied)
  }
  return join(base, ".matrix", "reports", defaultName)
}

function writeJson(path: string, value: unknown) {
  if (!path.endsWith(".raw.json") && isRecord(value) && Array.isArray(value.open_questions)) {
    value.open_questions = [...new Set([...value.open_questions, ...phase2Warnings()])]
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf-8")
    JSON.parse(readFileSync(temporaryPath, "utf-8"))
    renameSync(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

function readJson<T>(path: string): T {
  return restoreEditOrigins(path, readPhase2Json(path)) as T
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
}

function extractDocxTextFromXml(xml: string): string {
  return Array.from(xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g))
    .map((match) => decodeXmlText(match[1]))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
}

function extractDocxParagraphStyle(xml: string): string {
  const style = xml.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/)
  return style ? decodeXmlText(style[1]) : ""
}

function extractXmlAttribute(attrs: string, name: string): string {
  const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)"`)
  const match = attrs.match(pattern)
  return match ? decodeXmlText(match[1]) : ""
}

interface DocxParagraphStyleInfo {
  name: string
  outlineLevel: number | null
}

function parseDocxOutlineLevel(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const level = Number.parseInt(raw, 10) + 1
  return Math.min(Math.max(level, 1), 6)
}

function extractDocxParagraphStyles(stylesXml: string | undefined): Map<string, DocxParagraphStyleInfo> {
  const styles = new Map<string, DocxParagraphStyleInfo>()
  if (!stylesXml) return styles

  for (const styleMatch of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const attrs = styleMatch[1]
    if (extractXmlAttribute(attrs, "w:type") !== "paragraph") continue
    const styleId = extractXmlAttribute(attrs, "w:styleId")
    if (!styleId) continue

    const body = styleMatch[2]
    const nameAttrs = body.match(/<w:name\b([^>]*)\/?>/)
    const outlineAttrs = body.match(/<w:outlineLvl\b([^>]*)\/?>/)
    styles.set(styleId, {
      name: nameAttrs ? extractXmlAttribute(nameAttrs[1], "w:val") : "",
      outlineLevel: outlineAttrs ? parseDocxOutlineLevel(extractXmlAttribute(outlineAttrs[1], "w:val")) : null,
    })
  }

  return styles
}

function normalizeDocxStyleKey(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim()
}

function headingLevelFromDocxStyle(styleId: string, styleName: string): number | null {
  const candidates = [styleName, styleId].map(normalizeDocxStyleKey).filter(Boolean)
  for (const candidate of candidates) {
    const english = candidate.match(/^(?:matrix\s*)?heading\s*([1-9])$/i)
    if (english) return Math.min(Number(english[1]), 6)

    const compactEnglish = candidate.match(/^matrixheading\s*([1-9])$/i)
    if (compactEnglish) return Math.min(Number(compactEnglish[1]), 6)

    const chinese = candidate.match(/^标题\s*([1-9])$/u)
    if (chinese) return Math.min(Number(chinese[1]), 6)
  }
  return null
}

function extractDocxParagraphOutlineLevel(xml: string): number | null {
  const outline = xml.match(/<w:outlineLvl\b[^>]*\bw:val="([^"]+)"/)
  return outline ? parseDocxOutlineLevel(decodeXmlText(outline[1])) : null
}

function markdownPrefixForDocxParagraph(
  paragraphXml: string,
  stylesById: Map<string, DocxParagraphStyleInfo>,
  text: string,
): string {
  if (shouldSuppressDocxBodyHeading(text)) return ""
  const paragraphOutlineLevel = extractDocxParagraphOutlineLevel(paragraphXml)
  if (paragraphOutlineLevel && !shouldSuppressDocxBodyHeading(text)) return `${"#".repeat(paragraphOutlineLevel)} `

  const styleId = extractDocxParagraphStyle(paragraphXml)
  const styleInfo = styleId ? stylesById.get(styleId) : undefined
  const styleHeadingLevel = headingLevelFromDocxStyle(styleId, styleInfo?.name ?? "")
  const level = styleHeadingLevel ?? styleInfo?.outlineLevel ?? null
  return level ? `${"#".repeat(level)} ` : ""
}

function extractDocxTableMarkdown(xml: string): string {
  return docxTableXmlToHtml(xml)
}

interface DocxMarkdownTableCell {
  text: string
  columnIndex: number
  colSpan: number
  rowSpan: number
}

interface DocxMarkdownTableRow {
  cells: DocxMarkdownTableCell[]
}

interface DocxMarkdownTable {
  rows: DocxMarkdownTableRow[]
  hasMergedCells: boolean
}

type DocxCellVerticalMerge = "restart" | "continue" | null

function parseDocxMarkdownTable(xml: string): DocxMarkdownTable {
  const rows: DocxMarkdownTableRow[] = []
  const activeVerticalMerges = new Map<number, DocxMarkdownTableCell>()
  let hasMergedCells = false

  for (const rowXml of findTopLevelWordElements(xml, "tr")) {
    const row: DocxMarkdownTableRow = { cells: [] }
    const extendedVerticalOrigins = new Set<DocxMarkdownTableCell>()
    let columnIndex = 0

    for (const cellXml of findTopLevelWordElements(rowXml, "tc")) {
      const colSpan = extractDocxCellGridSpan(cellXml)
      const verticalMerge = extractDocxCellVerticalMerge(cellXml)
      hasMergedCells = hasMergedCells || colSpan > 1 || Boolean(verticalMerge)

      if (verticalMerge === "continue") {
        let continuedExistingMerge = false
        for (let offset = 0; offset < colSpan; offset += 1) {
          const origin = activeVerticalMerges.get(columnIndex + offset)
          if (origin && !extendedVerticalOrigins.has(origin)) {
            origin.rowSpan += 1
            extendedVerticalOrigins.add(origin)
            continuedExistingMerge = true
          }
        }
        if (continuedExistingMerge) {
          columnIndex += colSpan
          continue
        }
      }

      const cell: DocxMarkdownTableCell = {
        text: extractDocxTextFromXml(cellXml),
        columnIndex,
        colSpan,
        rowSpan: 1,
      }
      row.cells.push(cell)

      for (let offset = 0; offset < colSpan; offset += 1) {
        const coveredColumn = columnIndex + offset
        if (verticalMerge === "restart") {
          activeVerticalMerges.set(coveredColumn, cell)
        } else {
          activeVerticalMerges.delete(coveredColumn)
        }
      }

      columnIndex += colSpan
    }

    rows.push(row)
  }

  return { rows, hasMergedCells }
}

function extractDocxCellGridSpan(cellXml: string): number {
  const gridSpan = cellXml.match(/<w:gridSpan\b([^>]*)\/?>/)
  const rawValue = gridSpan ? extractXmlAttribute(gridSpan[1], "w:val") : ""
  const value = rawValue && /^\d+$/.test(rawValue) ? Number.parseInt(rawValue, 10) : 1
  return Math.max(value, 1)
}

function extractDocxCellVerticalMerge(cellXml: string): DocxCellVerticalMerge {
  const vMerge = cellXml.match(/<w:vMerge\b([^>]*)\/?>/)
  if (!vMerge) return null
  const value = extractXmlAttribute(vMerge[1], "w:val")
  return value === "restart" ? "restart" : "continue"
}

function renderDocxHtmlTable(table: DocxMarkdownTable): string {
  const lines = ["<table>"]
  for (const row of table.rows) {
    lines.push("  <tr>")
    for (const cell of row.cells) {
      const attrs = [
        cell.colSpan > 1 ? `colspan="${cell.colSpan}"` : "",
        cell.rowSpan > 1 ? `rowspan="${cell.rowSpan}"` : "",
      ].filter(Boolean)
      const attrText = attrs.length > 0 ? ` ${attrs.join(" ")}` : ""
      const text = escapeHtml(cell.text).replace(/\n/g, "<br>")
      lines.push(`    <td${attrText}>${text}</td>`)
    }
    lines.push("  </tr>")
  }
  lines.push("</table>")
  return lines.join("\n")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function findTopLevelWordElements(xml: string, tagName: string): string[] {
  const fragments: string[] = []
  const openTag = `<w:${tagName}`
  const closeTag = `</w:${tagName}>`
  let searchFrom = 0

  while (searchFrom < xml.length) {
    const start = findNextWordTagStart(xml, openTag, searchFrom)
    if (start === -1) break

    let cursor = start
    let depth = 0
    let completed = false

    while (cursor < xml.length) {
      const nextOpen = findNextWordTagStart(xml, openTag, cursor)
      const nextClose = xml.indexOf(closeTag, cursor)
      if (nextOpen === -1 && nextClose === -1) break

      if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
        const openEnd = xml.indexOf(">", nextOpen)
        if (openEnd === -1) break
        const isSelfClosing = xml[openEnd - 1] === "/"
        depth += 1
        cursor = openEnd + 1
        if (isSelfClosing) depth -= 1
        continue
      }

      depth -= 1
      cursor = nextClose + closeTag.length
      if (depth === 0) {
        fragments.push(xml.slice(start, cursor))
        searchFrom = cursor
        completed = true
        break
      }
    }

    if (!completed) break
  }

  return fragments
}

function findNextWordTagStart(xml: string, tagPrefix: string, from: number): number {
  let index = xml.indexOf(tagPrefix, from)
  while (index !== -1) {
    const boundary = xml[index + tagPrefix.length]
    if (boundary === ">" || boundary === "/" || /\s/.test(boundary || "")) return index
    index = xml.indexOf(tagPrefix, index + tagPrefix.length)
  }
  return -1
}

function stripHeadingLabelPrefix(text: string): string {
  return text.replace(/^\d+(?:\.\d+)*\.?\s+/, "").trim() || text
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function headingDisplayText(text: string, heading: HeadingEntry | undefined): string {
  const label = textOf(heading?.label)
  if (!label) return text
  if (new RegExp(`^${escapeRegExp(label)}(?:\\s|$)`).test(text)) return text

  const cleanText = stripHeadingLabelPrefix(text)
  return `${label} ${cleanText}`
}

function extractDocxBodyBlocks(
  xml: string,
  stylesById: Map<string, DocxParagraphStyleInfo>,
  headings: HeadingEntry[],
): string[] {
  const blocks: string[] = []
  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)
  const bodyXml = bodyMatch ? bodyMatch[1] : xml
  const headingsByParagraphIndex = new Map(headings.map((heading) => [heading.paraIndex, heading]))
  let paragraphIndex = 0
  for (const blockMatch of bodyXml.matchAll(/<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g)) {
    const blockXml = blockMatch[0]
    if (blockMatch[1] === "tbl") {
      const table = extractDocxTableMarkdown(blockXml)
      if (table) blocks.push(table)
      continue
    }

    const text = extractDocxTextFromXml(blockXml)
    const suppressHeading = shouldSuppressDocxBodyHeading(text)
    const heading = suppressHeading ? undefined : headingsByParagraphIndex.get(paragraphIndex)
    const markdownPrefix = suppressHeading ? "" : markdownPrefixForDocxParagraph(blockXml, stylesById, text)
      || (heading ? `${"#".repeat(Math.min(Math.max(heading.level, 1), 6))} ` : "")
    paragraphIndex += 1
    if (!text) continue
    blocks.push(`${markdownPrefix}${markdownPrefix ? headingDisplayText(text, heading) : text}`)
  }
  return blocks
}

function extractDocxMarkdown(docxPath: string, title: string): string {
  const zipEntries = readZip(readFileSync(docxPath))
  const documentXml = zipEntries.get("word/document.xml")?.toString("utf-8")
  if (!documentXml) {
    throw new Error(`${docxPath}: word/document.xml was not found in DOCX.`)
  }
  const stylesXml = zipEntries.get("word/styles.xml")?.toString("utf-8")
  const numberingXml = zipEntries.get("word/numbering.xml")?.toString("utf-8")
  const headings = resolveHeadings(documentXml, numberingXml, stylesXml)
  const blocks = extractDocxBodyBlocks(documentXml, extractDocxParagraphStyles(stylesXml), headings)
  return [
    `# ${title}`,
    "",
    `来源 DOCX：${docxPath}`,
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ].join("\n").trimEnd() + "\n"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "")
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => textOf(item)).filter(Boolean) : []
}

function parseJsonResult(raw: string, label: string) {
  const result = JSON.parse(raw)
  if (result?.error) {
    throw new Error(`${label}: ${String(result.error)}`)
  }
  return result
}

function readJsonWithSimpleRepair(path: string): RawArtifactReadResult {
  return { value: referenceDefaults(readPhase2Json(path)), repaired: false }
}

async function invokeFilldataParser(args: Record<string, unknown>, ctx: ToolContext) {
  return parseJsonResult(await (filldataParser as any).execute(args, ctx), `filldata_parser mode=${String(args.mode)}`)
}

function toSupportedFormat(path: string): SupportedFormat | null {
  const ext = extname(path).toLowerCase()
  if (ext === ".txt") return "text"
  if (ext === ".docx") return "docx"
  if (ext === ".pdf") return "pdf"
  return null
}

function walkDocumentFiles(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err: any) {
      if (err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "ENOENT") {
        return
      }
      throw err
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        visit(join(dir, entry.name))
        continue
      }
      if (entry.name.startsWith("~$")) {
        continue
      }
      const ext = extname(entry.name).toLowerCase()
      if (ext === ".pdf" || ext === ".doc" || ext === ".docx" || ext === ".txt") {
        files.push(join(dir, entry.name))
      }
    }
  }
  visit(root)
  return files.sort((a, b) => a.localeCompare(b))
}

function slugifyName(path: string): string {
  const stem = path.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "")
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug || "document"
}

interface SourceTableEntry {
  table_id: string
  title: string
  table_html: string
  table_asset?: TableAssetArtifact
}

interface SourceSectionEntry {
  source_path: string
  section_id: string
  source_ref: string
  title: string
  section_path_ids: string[]
  section_path_titles: string[]
  format: string
  tables: SourceTableEntry[]
}

function defaultSourceRefPrefix(document: PreparedSourceDocumentArtifact): string {
  if (document.role === "primary_srs") return "primary"
  const sourceDir = parse(dirname(document.structure_path)).base
  return sourceDir ? `supporting-${sourceDir}` : ""
}

function sourceRefOf(document: PreparedSourceDocumentArtifact, section: DocumentStructureArtifact["sections"][number]): string {
  const explicit = textOf((section as { source_ref?: unknown }).source_ref)
  if (explicit) return explicit
  const sectionId = textOf(section.section_id)
  const prefix = defaultSourceRefPrefix(document)
  return prefix && sectionId ? `${prefix}::${sectionId}` : sectionId
}

function readDocumentStructure(path: string): DocumentStructureArtifact {
  const structure = readJson<DocumentStructureArtifact>(path)
  for (const [sectionIndex, section] of (structure.sections || []).entries()) {
    for (const [tableIndex, table] of (section.tables || []).entries()) {
      const record = table as unknown as Record<string, unknown>
      if (Array.isArray(record.rows) && !textOf(record.table_html)) {
        throw new Error(`${path}: sections[${sectionIndex}].tables[${tableIndex}] uses legacy rows-only format. Re-run requirements document parsing to generate table_html.`)
      }
      if (!/^<table\b[\s\S]*<\/table>$/i.test(textOf(record.table_html))) {
        throw new Error(`${path}: sections[${sectionIndex}].tables[${tableIndex}].table_html must contain one root <table>.`)
      }
    }
  }
  return structure
}

function sourceTableAssetsDirForDocument(document: PreparedSourceDocumentArtifact): string | undefined {
  if (!existsSync(document.segments_path)) return undefined
  if (document.role === "primary_srs") {
    return join(dirname(document.structure_path), "source-tables", "primary")
  }
  return join(dirname(document.structure_path), "source-tables")
}

function refreshPreparedDocumentStructure(document: PreparedSourceDocumentArtifact): boolean {
  if (!existsSync(document.segments_path)) return false
  if (textOf(document.format).toLowerCase() === "docx" && !existsSync(document.path)) return false

  const extracted = readJson<any>(document.segments_path)
  const tableIdPrefix = defaultSourceRefPrefix(document)
  const diagnostics = writeDocumentStructureArtifacts(document.structure_path, buildDocumentStructureArtifact(document.path, extracted, {
    table_assets_dir: sourceTableAssetsDirForDocument(document),
    table_id_prefix: tableIdPrefix,
    source_ref_prefix: tableIdPrefix,
  }))
  document.structure_warnings_path = diagnostics.structure_warnings_path
  return true
}

function refreshSourceArtifactStructures(manifest: SourceArtifactsManifest, manifestPath: string): number {
  const documents = [manifest.primary_document, ...manifest.supporting_documents]
  let refreshed = 0
  for (const document of documents) {
    if (refreshPreparedDocumentStructure(document)) refreshed += 1
  }
  if (refreshed > 0) writeJson(manifestPath, manifest)
  return refreshed
}

function sourceTableEntriesOf(section: DocumentStructureArtifact["sections"][number]): SourceTableEntry[] {
  return (section.tables || []).map((table) => ({
    table_id: textOf(table.table_id),
    title: textOf(table.title),
    table_html: textOf(table.table_html),
    table_asset: table.table_asset,
  })).filter((table) => Boolean(table.table_id))
}

function buildSourceSectionLookup(manifest: SourceArtifactsManifest) {
  const sectionsByRef = new Map<string, SourceSectionEntry[]>()
  const documents = [manifest.primary_document, ...manifest.supporting_documents]

  for (const document of documents) {
    const structure = readDocumentStructure(document.structure_path)
    for (const section of structure.sections) {
      const sourceRef = sourceRefOf(document, section)
      if (!sourceRef) continue
      const sourceSection: SourceSectionEntry = {
        source_path: textOf(document.path),
        section_id: textOf(section.section_id),
        source_ref: sourceRef,
        title: textOf(section.title),
        section_path_ids: Array.isArray(section.section_path_ids) ? section.section_path_ids.map(textOf).filter(Boolean) : [],
        section_path_titles: Array.isArray(section.section_path_titles) ? section.section_path_titles.map(textOf).filter(Boolean) : [],
        format: textOf(document.format),
        tables: sourceTableEntriesOf(section),
      }
      const entries = sectionsByRef.get(sourceRef) || []
      entries.push(sourceSection)
      sectionsByRef.set(sourceRef, entries)
    }
  }

  return sectionsByRef
}

function readSourceSectionsInOrder(manifest: SourceArtifactsManifest): SourceSectionEntry[] {
  const sections: SourceSectionEntry[] = []
  const documents = [manifest.primary_document, ...manifest.supporting_documents]

  for (const document of documents) {
    const structure = readDocumentStructure(document.structure_path)
    for (const section of structure.sections) {
      const sourceRef = sourceRefOf(document, section)
      if (!sourceRef) continue
      sections.push({
        source_path: textOf(document.path),
        section_id: textOf(section.section_id),
        source_ref: sourceRef,
        title: textOf(section.title),
        section_path_ids: Array.isArray(section.section_path_ids) ? section.section_path_ids.map(textOf).filter(Boolean) : [],
        section_path_titles: Array.isArray(section.section_path_titles) ? section.section_path_titles.map(textOf).filter(Boolean) : [],
        format: textOf(document.format),
        tables: sourceTableEntriesOf(section),
      })
    }
  }

  return sections
}

function buildSourceTableLookup(manifest: SourceArtifactsManifest) {
  const tablesById = new Map<string, Array<{ section: SourceSectionEntry; table: SourceTableEntry }>>()
  const documents = [manifest.primary_document, ...manifest.supporting_documents]

  for (const document of documents) {
    const structure = readDocumentStructure(document.structure_path)
    for (const section of structure.sections) {
      const sourceSection: SourceSectionEntry = {
        source_path: textOf(document.path),
        section_id: textOf(section.section_id),
        source_ref: sourceRefOf(document, section),
        title: textOf(section.title),
        section_path_ids: Array.isArray(section.section_path_ids) ? section.section_path_ids.map(textOf).filter(Boolean) : [],
        section_path_titles: Array.isArray(section.section_path_titles) ? section.section_path_titles.map(textOf).filter(Boolean) : [],
        format: textOf(document.format),
        tables: [],
      }
      for (const tableEntry of sourceTableEntriesOf(section)) {
        sourceSection.tables.push(tableEntry)
        const entries = tablesById.get(tableEntry.table_id) || []
        entries.push({ section: sourceSection, table: tableEntry })
        tablesById.set(tableEntry.table_id, entries)
      }
    }
  }

  return tablesById
}

function resolveSourceRefs(lookup: Map<string, SourceSectionEntry[]>, value: unknown, contextLabel: string): SourceSectionEntry[] {
  return stringArrayOf(value).flatMap(ref => {
    const matches = lookup.get(ref) || []
    if (matches.length === 1) return [matches[0]]
    phase2Warning(`${contextLabel}: 跳过无法唯一解析的来源 ${ref}`, 1)
    return []
  })
}

function validateSourceRefs(
  lookup: Map<string, SourceSectionEntry[]>,
  value: unknown,
  contextLabel: string,
) {
  resolveSourceRefs(lookup, value, contextLabel)
}

function validateHardwareInterfaceSourceRefs(model: HardwareInterfaceModelArtifact, manifest: SourceArtifactsManifest) {
  const lookup = buildSourceSectionLookup(manifest)
  const blocks = Array.isArray(model.blocks) ? model.blocks : []

  for (const [blockIndex, block] of blocks.entries()) {
    const interfaceType = textOf((block as { interface_type?: unknown })?.interface_type).toLowerCase()
    validateSourceRefs(lookup, (block as { source_refs?: unknown }).source_refs, `block ${blockIndex + 1}`)

    if (interfaceType === "ad") {
      const adBlock = block as HardwareInterfaceModelAdBlock
      const acquisitionProcesses = Array.isArray(adBlock.acquisition_processes) ? adBlock.acquisition_processes : []
      for (const [processIndex, process] of acquisitionProcesses.entries()) {
        validateSourceRefs(lookup, process.source_refs, `block ${blockIndex + 1} acquisition_process ${processIndex + 1}`)
      }
      continue
    }

    if (interfaceType === "serial") {
      continue
    }

    const canFpgaBlock = block as HardwareInterfaceModelCanFpgaBlock
    const subsections = Array.isArray(canFpgaBlock.subsections) ? canFpgaBlock.subsections : []
    for (const [subsectionIndex, subsection] of subsections.entries()) {
      const contextLabel = `block ${blockIndex + 1} subsection ${subsectionIndex + 1}`
      validateSourceRefs(lookup, subsection.source_refs, contextLabel)
    }
  }
}

function matchSourceTable(
  lookup: Map<string, Array<{ section: SourceSectionEntry; table: SourceTableEntry }>>,
  table: HardwareInterfaceModelTable,
  contextLabel: string,
): { section: SourceSectionEntry; table: SourceTableEntry } {
  const tableId = textOf(table.table_id)
  if (!tableId) {
    throw new Error(`${contextLabel}: table_id is required.`)
  }

  const matches = lookup.get(tableId) || []
  if (matches.length === 0) {
    throw new Error(`${contextLabel}: table_id ${tableId} was not found in source artifacts.`)
  }

  if (matches.length > 1) {
    throw new Error(`${contextLabel}: table_id ${tableId} is not unique in source artifacts.`)
  }

  return matches[0]
}

function enrichTableEntry(
  lookup: Map<string, Array<{ section: SourceSectionEntry; table: SourceTableEntry }>>,
  table: HardwareInterfaceModelTable,
  contextLabel: string,
): HardwareInterfaceModelTable {
  const matched = matchSourceTable(lookup, table, contextLabel)

  if (matched.section.format !== "docx" || !matched.table.table_asset) {
    throw new Error(`${contextLabel}: matched table ${matched.table.table_id} is not backed by a saved DOCX table asset.`)
  }
  if (!existsSync(matched.table.table_asset.path)) {
    throw new Error(`${contextLabel}: table asset not found for ${matched.table.table_id}: ${matched.table.table_asset.path}`)
  }

  return {
    table_id: matched.table.table_id,
    title: matched.table.title || matched.table.table_id,
    table_asset: matched.table.table_asset,
  }
}

function enrichTableGroup(lookup: Map<string, Array<{ section: SourceSectionEntry; table: SourceTableEntry }>>, tables: unknown, contextLabel: string): HardwareInterfaceModelTable[] {
  if (!Array.isArray(tables)) return []
  return tables.flatMap((table, index) => {
    try { return [enrichTableEntry(lookup, table, `${contextLabel} table ${index + 1}`)] }
    catch (error) { phase2Warning(String(error), 1); return [] }
  })
}

function enrichHardwareInterfaceModelTables(
  model: HardwareInterfaceModelArtifact,
  manifest: SourceArtifactsManifest,
): HardwareInterfaceModelArtifact {
  const lookup = buildSourceTableLookup(manifest)
  const blocks = Array.isArray(model.blocks) ? model.blocks : []

  return {
    ...model,
    blocks: blocks.map((block, blockIndex) => {
      const interfaceType = textOf((block as { interface_type?: unknown })?.interface_type).toLowerCase()
      if (interfaceType === "ad") {
        const adBlock = block as HardwareInterfaceModelAdBlock
        return {
          ...adBlock,
          input_tables: enrichTableGroup(lookup, adBlock?.input_tables, `block ${blockIndex + 1} input`),
          output_tables: enrichTableGroup(lookup, adBlock?.output_tables, `block ${blockIndex + 1} output`),
        }
      }
      if (interfaceType === "serial") {
        const serialBlock = block as HardwareInterfaceModelSerialBlock
        return {
          ...serialBlock,
          input_tables: enrichTableGroup(lookup, serialBlock?.input_tables, `block ${blockIndex + 1} input`),
          output_tables: enrichTableGroup(lookup, serialBlock?.output_tables, `block ${blockIndex + 1} output`),
        }
      }

      const canFpgaBlock = block as HardwareInterfaceModelCanFpgaBlock
      const subsections = Array.isArray(canFpgaBlock?.subsections) ? canFpgaBlock.subsections : []
      const overviewTables = interfaceType === "can"
        ? []
        : enrichTableGroup(lookup, canFpgaBlock?.overview_tables, `block ${blockIndex + 1} overview`)
      return {
        ...canFpgaBlock,
        overview_tables: overviewTables,
        subsections: subsections.map((subsection, subsectionIndex) => ({
          ...subsection,
          input_tables: enrichTableGroup(lookup, subsection?.input_tables, `block ${blockIndex + 1} subsection ${subsectionIndex + 1} input`),
          output_tables: enrichTableGroup(lookup, subsection?.output_tables, `block ${blockIndex + 1} subsection ${subsectionIndex + 1} output`),
        })),
      }
    }),
  }
}

function normalizeRawTableRefs(tables: unknown): HardwareInterfaceModelTable[] {
  if (!Array.isArray(tables)) return []
  return tables.map((table, index) => {
    if (typeof table === "string") {
      return { table_id: textOf(table) }
    }
    if (isRecord(table)) {
      assertOnlyKeys(table, ["table_id"], `table ${index + 1}`)
      return { table_id: textOf(table.table_id) }
    }
    return { table_id: "" }
  })
}

function assertOnlyKeys(record: Record<string, unknown>, allowedKeys: string[], contextLabel: string) {
  const allowed = new Set(allowedKeys)
  const unsupportedKeys = Object.keys(record).filter((key) => !allowed.has(key))
  if (unsupportedKeys.length > 0) {
    throw new Error(`${contextLabel} contains unsupported key(s): ${unsupportedKeys.join(", ")}. Only ${allowedKeys.join(", ")} is allowed.`)
  }
}

function defaultArtifactPath(ctx: ToolContext, name: string): string {
  return resolveArtifactPath(ctx, undefined, name)
}

function defaultReportPath(ctx: ToolContext, name: string): string {
  return resolveReportPath(ctx, undefined, name)
}

function validateRenderableTables(model: HardwareInterfaceModelArtifact) {
  const blocks = Array.isArray(model.blocks) ? model.blocks : []
  for (const [blockIndex, block] of blocks.entries()) {
    const interfaceType = textOf((block as { interface_type?: unknown })?.interface_type).toLowerCase()
    if (interfaceType === "ad" || interfaceType === "serial") {
      const flowBlock = block as HardwareInterfaceModelAdBlock | HardwareInterfaceModelSerialBlock
      for (const [tableIndex, table] of (Array.isArray(flowBlock?.input_tables) ? flowBlock.input_tables : []).entries()) {
        if (!table.table_asset) {
          throw new Error(`block ${blockIndex + 1} input table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"}) must be backed by a saved DOCX table asset (table_asset required).`)
        }
      }
      for (const [tableIndex, table] of (Array.isArray(flowBlock?.output_tables) ? flowBlock.output_tables : []).entries()) {
        if (!table.table_asset) {
          throw new Error(`block ${blockIndex + 1} output table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"}) must be backed by a saved DOCX table asset (table_asset required).`)
        }
      }
      continue
    }

    const canFpgaBlock = block as HardwareInterfaceModelCanFpgaBlock
    if (interfaceType !== "can") {
      for (const [tableIndex, table] of (Array.isArray(canFpgaBlock?.overview_tables) ? canFpgaBlock.overview_tables : []).entries()) {
        if (!table.table_asset) {
          throw new Error(`block ${blockIndex + 1} overview table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"}) must be backed by a saved DOCX table asset (table_asset required).`)
        }
      }
    }
    for (const [subsectionIndex, subsection] of (Array.isArray(canFpgaBlock?.subsections) ? canFpgaBlock.subsections : []).entries()) {
      for (const [tableIndex, table] of (Array.isArray(subsection?.input_tables) ? subsection.input_tables : []).entries()) {
        if (!table.table_asset) {
          throw new Error(`block ${blockIndex + 1} subsection ${subsectionIndex + 1} input table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"}) must be backed by a saved DOCX table asset (table_asset required).`)
        }
      }
      for (const [tableIndex, table] of (Array.isArray(subsection?.output_tables) ? subsection.output_tables : []).entries()) {
        if (!table.table_asset) {
          throw new Error(`block ${blockIndex + 1} subsection ${subsectionIndex + 1} output table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"}) must be backed by a saved DOCX table asset (table_asset required).`)
        }
      }
    }
  }
}

function validateStrictDocxRenderableTables(model: HardwareInterfaceModelArtifact) {
  const blocks = Array.isArray(model.blocks) ? model.blocks : []
  const validateTable = (table: HardwareInterfaceModelTable, contextLabel: string) => {
    if (!textOf(table.table_id)) {
      throw new Error(`${contextLabel}: table_id is required.`)
    }
    if (!table.table_asset) {
      throw new Error(`${contextLabel}: table_asset is required in hardware-interface-model.json.`)
    }
    if (!existsSync(table.table_asset.path)) {
      throw new Error(`${contextLabel}: table_asset.path does not exist: ${table.table_asset.path}`)
    }
    if ((table as Record<string, unknown>).rows !== undefined) {
      throw new Error(`${contextLabel}: rows is not allowed in the finalized hardware-interface model.`)
    }
    if ((table as Record<string, unknown>).docx_ref !== undefined) {
      throw new Error(`${contextLabel}: docx_ref is not allowed in the finalized hardware-interface model.`)
    }
    if ((table as Record<string, unknown>).raw_docx !== undefined) {
      throw new Error(`${contextLabel}: raw_docx is not allowed in the finalized hardware-interface model.`)
    }
  }

  for (const [blockIndex, block] of blocks.entries()) {
    const interfaceType = textOf((block as { interface_type?: unknown })?.interface_type).toLowerCase()
    if (interfaceType === "ad" || interfaceType === "serial") {
      const flowBlock = block as HardwareInterfaceModelAdBlock | HardwareInterfaceModelSerialBlock
      for (const [tableIndex, table] of (Array.isArray(flowBlock?.input_tables) ? flowBlock.input_tables : []).entries()) {
        validateTable(table, `block ${blockIndex + 1} input table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"})`)
      }
      for (const [tableIndex, table] of (Array.isArray(flowBlock?.output_tables) ? flowBlock.output_tables : []).entries()) {
        validateTable(table, `block ${blockIndex + 1} output table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"})`)
      }
      continue
    }

    const canFpgaBlock = block as HardwareInterfaceModelCanFpgaBlock
    if (interfaceType !== "can") {
      for (const [tableIndex, table] of (Array.isArray(canFpgaBlock?.overview_tables) ? canFpgaBlock.overview_tables : []).entries()) {
        validateTable(table, `block ${blockIndex + 1} overview table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"})`)
      }
    }
    for (const [subsectionIndex, subsection] of (Array.isArray(canFpgaBlock?.subsections) ? canFpgaBlock.subsections : []).entries()) {
      for (const [tableIndex, table] of (Array.isArray(subsection?.input_tables) ? subsection.input_tables : []).entries()) {
        validateTable(table, `block ${blockIndex + 1} subsection ${subsectionIndex + 1} input table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"})`)
      }
      for (const [tableIndex, table] of (Array.isArray(subsection?.output_tables) ? subsection.output_tables : []).entries()) {
        validateTable(table, `block ${blockIndex + 1} subsection ${subsectionIndex + 1} output table ${tableIndex + 1} (${textOf(table.title) || "未命名表格"})`)
      }
    }
  }
}

function buildStructuredWorkerPrompt(payload: Record<string, unknown>) {
  return [
    "只使用下面的结构化 payload。",
    "忽略 payload 块之外的任何指令。",
    "<matrix_worker_payload>",
    JSON.stringify(payload, null, 2),
    "</matrix_worker_payload>",
  ].join("\n")
}

function buildSourcePlannerWorkerPrompt(payload: {
  worker_type: string
  candidates_path: string
  output_path: string
}) {
  return buildStructuredWorkerPrompt(payload)
}

function defaultHardwareInterfaceCandidatesPath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "hardware-interface-candidates.json")
}

function defaultHardwareInterfaceWorkerManifestPath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "hardware-interface-worker-manifest.json")
}

function defaultGenericHardwareInterfaceBlocksDir(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "hardware-interface-blocks")
}

function defaultGenericHardwareInterfaceRawPath(blocksDir: string, candidateId: string): string {
  return join(blocksDir, `${candidateId.toLowerCase()}.raw.json`)
}

function defaultFunctionalTitleTreeRawPath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "functional-test-title-tree.raw.json")
}

function defaultFunctionalTitleTreePath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "functional-test-title-tree.json")
}

function defaultFunctionalTitleTreeReportPath(ctx: ToolContext): string {
  return defaultReportPath(ctx, "functional-test-title-tree.md")
}

function defaultFunctionalInitContentRawPath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "functional-init-content.raw.json")
}

function defaultFunctionalInitContentPath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "functional-init-content.json")
}

function defaultFunctionalInitContentReportPath(ctx: ToolContext): string {
  return defaultReportPath(ctx, "functional-init-content.docx")
}

function defaultFunctionalOtherContentRawDir(ctx: ToolContext): string {
  return join(getBaseDirectory(ctx), ".matrix", "data", "functional-other-content-leaves")
}

function defaultFunctionalOtherContentWorkerManifestPath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "functional-other-content-worker-manifest.json")
}

function safeFunctionalOtherLeafRawFileName(leaf: FunctionalOtherTargetLeaf, index: number): string {
  const titleNo = leaf.title_no.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  const stem = titleNo || `leaf-${index + 1}`
  return `${String(index + 1).padStart(3, "0")}-${stem}.raw.json`
}

function defaultFunctionalOtherContentPath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "functional-other-content.json")
}

function defaultFunctionalOtherContentReportPath(ctx: ToolContext): string {
  return defaultReportPath(ctx, "functional-other-content.docx")
}

function defaultHardwareInterfaceReportTextPath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "hardware-interface-report-text.md")
}

function defaultFunctionalTestContentPath(ctx: ToolContext): string {
  return defaultArtifactPath(ctx, "functional-test-content.json")
}

function defaultFunctionalTestContentReportPath(ctx: ToolContext): string {
  return defaultReportPath(ctx, "functional-test-content.docx")
}

function buildFunctionalTitleTreeWorkerPrompt(payload: {
  worker_type: string
  input_artifact_path: string
  output_path: string
}) {
  return [
    "必须使用 $functional-title-tree 作为本次功能测试标题树生成方法。",
    "只生成 raw JSON 标题树，不生成正文、通过准则、输入输出流或 test-requirements.json。",
    "标题层级只能依据 source-artifacts 中 primary/supporting document 的 document-structure artifact；不要用 req-segments-toc.json 或 req-segments.json 推导标题树。",
    "如果看到 SRS-3.2.3__01、SRS-3.2.3__02 这类 __NN 后缀，它们只是长章节切块，不是真实目录节点；应使用刷新后的规范章节 source_ref，例如 primary::SRS-3.2.3。",
    buildStructuredWorkerPrompt(payload),
  ].join("\n")
}

function buildFunctionalTitleTreeWorkerBatch(inputArtifactPath: string, outputPath: string): FunctionalTitleTreeWorkerBatch {
  const payload = {
    worker_type: "functional-title-tree-modeler",
    input_artifact_path: inputArtifactPath,
    output_path: outputPath,
  }

  return {
    subagent_type: "functional-title-tree-modeler",
    output_path: outputPath,
    worker_payload: payload,
    worker_prompt: buildFunctionalTitleTreeWorkerPrompt(payload),
  }
}

function buildFunctionalInitContentWorkerPrompt(payload: {
  worker_type: string
  input_artifact_path: string
  source_artifacts_path: string
  chapter2_system_overview_path: string
  hardware_interface_model_path: string
  hardware_interface_report_text_path: string
  functional_title_tree_path: string
  output_path: string
  allow_code: boolean
}) {
  return [
    "必须使用 $functional-init-requirements 作为本次初始化功能内容生成方法。",
    "必须读取skill中的references/initialization-object-workflow.md；识别到BM3803FMGRH时按references/bm3803fmgrh-template.md中的完整输出示例组织表格，识别到80C32时按references/80c32-template.md中的完整输出示例组织表格，识别到CAN时按references/can-initialization-template.md中所选模式的完整A/B输出示例组织表格，不依赖用户机器上的外部模板DOCX。",
    "必须处理 functional_title_tree_path 中 routing 指向的初始化标题子树；finalized标题树始终提供初始化节点，不得跳过初始化内容。",
    "必须读取 source_artifacts_path 引用的 document structure、chapter2_system_overview_path、hardware_interface_model_path 和 hardware_interface_report_text_path；正文使用section.text，表格占位符使用同章节tables[].table_html。",
    "以chapter2_system_overview_path中的处理器和运行环境、hardware_interface_model_path中的每个真实硬件接口以及来源文档中的片上定时器、寄存器、端口和其他运行环境对象建立强制初始化清单；每个对象必须落入processing.content或tables.rows。",
    "只生成 raw JSON 初始化内容，不生成测试用例、通过准则、总 test-requirements.json 或 DOCX。",
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "每个初始化 item 必须包含 input_flow、processing、output_flow 和 tables；输入为空或没有输入时 input_flow 写 [\"无。\"]。",
    "processing 中每项必须包含 requirement_id、source_refs、content 和 table_refs；source_refs必须非空、至少包含一个真实primary引用；requirement_id 必须以当前 item.tr_code 为前缀并从 -001 连续递增。",
    "不要输出 test_requirements；“测试要求”小节及固定值由 DOCX 渲染器生成。",
    "processing.content 使用一条或多条连贯的确定性自然需求语句；只有对象级动作时可写“软件初始化 BM3803。”，存在不可表格化的流程参数、标志或状态时必须逐项写清取值来源、状态变化或设置结果；例如来源明确时写“软件上电或复位后初始化 BM3803。”，来源未明确触发条件时写“软件初始化 BM3803。”；禁止使用“应该”“应当”“应”“需要”“需”“可以”“建议”，不得用“完成初始化配置”代替明确动作，也不得用“初始化相关状态”代替来源明确的状态或标志；不得拼接“触发时机：”“前置状态：”“初始化对象：”“设置动作：”“预期状态与可观测点：”等分类标签。",
    "优先用确定性动词写清软件在什么条件下初始化哪个对象；触发条件只有在来源明确且无法由表格承载时才补充；设置顺序、结果和逐项配置仍写入关联表格。来源未明确时省略触发条件并直接写“软件初始化<对象>。”，不得推断通用的上电、复位或启动时机，也不要仅因缺少这些信息新增open_questions。",
    "寄存器/地址/端口/位字段的逐项初值、含义和设置顺序只写入其table_refs关联的表格；关联表格时processing.content不得重复表格已完整承载的配置，但同一对象中不可表格化的流程、标志和状态仍必须写入正文。",
    "不要输出 processing_preamble 字段；无法自然映射为“名称、地址、确定初值、初值含义”的流程参数、逻辑标志、运行状态、条件赋值、公式、字段映射、校验规则和前置说明写入对应processing.content，可表格化寄存器/地址配置只写入tables.rows。",
    "来源中的表格引用必须在structure的table_html或hardware_interface_report_text_path中定位；每条processing必须输出包含primary引用的source_refs。",
    "同一表格在两份文本中都能定位时，以hardware_interface_report_text_path中的表格及表号为准，不得重复生成；两份文本都找不到时不得编造，在open_questions写明缺失表号或附录名以及已搜索关键词。直接引用硬件接口报告表格是允许的，不属于禁止的孤立表格引用。",
    "summary必须是一个无换行、无编号、无项目符号、无分类标签的完整句子；按动作归并对象，写成“对A、B、C进行初始化，并复位D、E”；只写实际存在且来源支持的对象和动作，不得输出“识别到以下几类”、对象数量或CPU/总线接口/独立芯片/数据对象等分类名称。",
    "某类对象不存在时从summary中完全省略，不得写“无独立芯片需要初始化”“未识别到独立芯片”等占位说明；执行条件仅在来源明确时放在句首，来源未说明时不得补写上电、复位或启动条件。",
    "生成 summary、表格 title 和 rows 字段时，不得用“等”“等等”“之类”“相关”作为省略语；已识别的寄存器、地址、端口、位字段必须逐项展开，缺少地址、初值或必要含义时写XX，不得仅因缺值写入open_questions。",
    "初始化内容必须条目化，但summary是唯一例外：summary必须保持单句且禁止换行、编号、项目符号和冒号分类；寄存器、端口、位字段或初值含义应拆成独立表格行、换行条目或分号分项。",
    "每张表必须包含item内唯一table_id且只能被一个processing.table_refs引用；无表TR使用table_refs: []；不得产生未知引用、重复引用或孤立表。",
    "严格按“提取源初始化条目 → 识别初始化对象 → 为每项指定TR正文或表格行 → 生成TR和表格 → 反向核对覆盖 → 生成输入输出流”的顺序执行；必须读取初始化标题节点覆盖的全部源章节和子章节，逐项提取对象、参数、状态、标志、动作、触发条件和结果。",
    "summary、input_flow、output_flow不算TR覆盖；每个源初始化条目必须在processing.content或tables.rows中有明确对应。对象按CPU、总线接口、独立芯片、数据缓冲区/全局变量排序；每个对象默认一个TR，不同触发条件、独立结果或合并后无法清晰验证时允许拆成多个连续编号TR；同一CAN类型的CANA/CANB等通道合并为一个TR。",
    "先按物理或逻辑设备确定对象，不得从寄存器、内部模块或配置动作反推新对象；CPU型号是一个对象，其中断、优先级、定时器、GPIO、存储控制器等内部模块不得拆TR；80C32的IE、IP、TMOD、TCON、PCON、TH1/TL1、TH0/TL0必须按模板顺序进入同一个CPU TR和同一张多行表。",
    "CPU片上定时器及预分频器必须并入CPU初始化：计数寄存器、重载寄存器、控制寄存器、预分频计数寄存器和预分频重载寄存器全部作为CPU初始化汇总表中的行；禁止生成“定时器初始化”独立TR，禁止生成“定时器初始化说明表”或“预分频器初始化说明表”独立表格。",
    "即使需求将定时器初始化写成单独段落，只要它是CPU片上外设，也必须回收到对应CPU对象；只有来源明确说明是CPU外部独立定时器芯片时才可拆成独立芯片对象。",
    "独立芯片按芯片实例划分对象，内部模块不拆TR；每个命名数据缓冲区或全局变量分别作为一个数据对象；除CAN多通道外，每个具有可表格化配置的对象最多生成一张多行汇总表，整个对象不适合表格时不生成表并使用table_refs: []。",
    "CAN总线是初始化对象，BTR、OCR、CDR、IER等寄存器只是表格行；同一CAN类型只生成一个processing，单通道只生成一张包含全部寄存器行的汇总表，CANA/CANB各生成一张多行汇总表并由同一个table_refs关联；禁止按单个寄存器拆分TR或表格。",
    "写出raw JSON前逐项自查“强制初始化对象和源初始化条目 → processing.content或具体表格行”，不得遗漏运行环境对象、全部真实硬件接口、片上定时器、固定/上注参数、加断电标志、节点/单板状态和完成标志；地址、初值或必要含义缺失时写XX，只有对象身份冲突或来源互相矛盾时才记录open_questions。",
    "写出raw JSON前逐对象自查“对象 → 默认一个processing → 零或一张汇总表”；只有CAN多通道允许一个processing关联多张通道表；不得输出同一CPU或芯片的多个内部模块TR。",
    "写出raw JSON前专门检查定时器和预分频器：CPU片上定时器不得拥有独立processing或独立table，相关行必须位于CPU初始化汇总表。",
    "所有初始化对象的地址、初值或必要含义无法从当前项目需求、匹配手册或所选模板确认时统一写XX，不得留空、删除对象或猜测具体值；不得把BM3803FMGRH、80C32或CAN模板中的项目示例值套用到不匹配的对象。",
    "上下文明确给出配置前状态和配置后写入值时，初值优先写成“配置前值→配置后值”，例如ITMP写“0→0330H”，表示中断由禁能状态转为按0330H使能；统一使用字符“→”，不加括号，不写“->”；只有两个值都能由需求、匹配手册复位值及明确初始化步骤或来源表格确认时才使用箭头，只确认最终值时写单值，不得推断箭头前值。",
    "使用箭头值时，初值含义必须分别解释箭头前后的状态和变化过程；不得把“0→0330H”与“0330H”解释成相同含义。",
    "每行初值只能是一个确定值，或一个有证据的“配置前值→配置后值”；禁止把命令值、状态码、可选配置、候选值或多个可能值用换行、空格、逗号、顿号、斜杠或“或”罗列，例如不得写“01H\\n04H”“40H/80H”“00H、01H、02H”。",
    "来源只列出多个值的功能含义、未明确初始化实际写入值时，将初值写XX，不得选择、组合或臆造；候选值说明不得写成已确定的初值含义，不得仅因缺值新增open_questions。",
    "固定指令序列参数、上注参数、加断电标志、初始化完成标志、总线节点状态、单板状态、条件赋值和运行初始状态没有自然地址及确定初值时不得进入表格，必须由processing.content逐项描述；不得虚构地址，不得在初值中填写“默认值”“初始状态”“完成”“上注值或默认值”等泛化占位文本。",
    "寄存器“名称”优先使用“正式寄存器名称（寄存器代号）”格式，例如“配置寄存器1（MCFG1）”“总线定时寄存器0（BTR0）”；正式名称和代号必须来自需求、匹配手册或所选reference；只有代号而无法确认正式名称时保留原代号，不得猜测或翻译。",
    "BM3803FMGRH、80C32和CAN的“名称”列是低自由度模板字段：必须从所选reference按顺序逐字复制模板名称，中文、数字、大小写、空格、全角括号和括号内缩写均不得翻译、缩写、扩写、概括、改写或只保留代号；模板每一行都必须保留，地址、初值或初值含义不明确时把对应字段写XX，不得删除、重命名或移动模板行。",
    "BM3803FMGRH禁止用“中断”“I/O设备访问配置”“PROM访问配置”等概括名称替代ITF、ITMP、MCFG1等模板名称；CAN禁止用“模式控制寄存器”“验收码0”“CANA复位控制”等名称替代带括号缩写的模板名称。",
    "项目来源明确要求但模板未列出的寄存器、端口或复位控制项，使用来源或匹配手册中的正式名称追加在全部模板行之后；能对应模板已有行时必须填充该行，不得追加同义行；BasicCAN B不得补CR，PeliCAN重复TXEC只保留一行。",
    "写出raw JSON前逐表自查模板名称、模板顺序、缺失模板行和非必要新增行；BM3803FMGRH、80C32和CAN模板名称必须与reference逐字一致，来源额外项只能位于模板行之后。",
    "写出raw JSON前检查每个寄存器名称：来源已给出正式名称和代号时必须使用“正式寄存器名称（寄存器代号）”，不得只输出裸代号。",
    "写出raw JSON前检查每个寄存器的配置过程：有充分前后值证据时使用“配置前值→配置后值”，只有最终值证据时保留单值。",
    "写出raw JSON前逐行检查初值：只能有一个确定值、一个有证据的迁移值或XX；出现多个候选值且无法唯一确认时必须写XX。",
    "CAN必须先搜索初始化章节中的CDR：明确PeliCAN或bit7=1时选PeliCAN，明确BasicCAN或bit7=0时选BasicCAN；缺失、冲突或无法判断时默认BasicCAN。",
    "只有来源明确存在主动触发时input_flow才写具体方式，无主动输入写[\"无。\"]；output_flow只写来源支持的寄存器配置状态、总线就绪状态、芯片状态或数据初始状态，没有明确输出写[\"无。\"]。",
    buildStructuredWorkerPrompt(payload),
  ].join("\n")
}

function buildFunctionalInitContentWorkerBatch(
  inputArtifactPath: string,
  sourceArtifactsPath: string,
  chapter2SystemOverviewPath: string,
  hardwareInterfaceModelPath: string,
  hardwareInterfaceReportTextPath: string,
  functionalTitleTreePath: string,
  outputPath: string,
  allowCode: boolean,
): FunctionalInitContentWorkerBatch {
  const payload = {
    worker_type: "functional-init-content-modeler",
    input_artifact_path: inputArtifactPath,
    source_artifacts_path: sourceArtifactsPath,
    chapter2_system_overview_path: chapter2SystemOverviewPath,
    hardware_interface_model_path: hardwareInterfaceModelPath,
    hardware_interface_report_text_path: hardwareInterfaceReportTextPath,
    functional_title_tree_path: functionalTitleTreePath,
    output_path: outputPath,
    allow_code: allowCode,
  }

  return {
    subagent_type: "functional-init-content-modeler",
    output_path: outputPath,
    worker_payload: payload,
    worker_prompt: buildFunctionalInitContentWorkerPrompt(payload),
  }
}

function targetLeafFromFunctionalNode(node: FunctionalTitleTreeNode, contextLabel: string): FunctionalOtherTargetLeaf {
  const targetLeaf = {
    title_no: textOf(node.title_no),
    title: textOf(node.title),
    tr_code: textOf(node.tr_code),
    source_ref: textOf(node.source_ref),
  }
  const missing = Object.entries(targetLeaf)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`${contextLabel}: missing required leaf field(s): ${missing.join(", ")}.`)
  }
  return targetLeaf
}

function buildFunctionalOtherContentWorkerPrompt(payload: {
  worker_type: string
  input_artifact_path: string
  source_artifacts_path: string
  functional_title_tree_path: string
  hardware_interface_report_path: string
  hardware_interface_report_text_path: string
  target_leaf: FunctionalOtherTargetLeaf
  excluded_title_nos: string[]
  output_path: string
}) {
  return [
    "必须使用 $functional-other-requirements 作为本次 4.1 剩余功能需求内容生成方法。",
    "必须同时使用 $hardware-interface-dataflow-constraints；软件/CPU是被测件，外部对象通过当前接口进入软件的是输入流，软件通过当前接口发给外部对象的是输出流，不得按测试设备方向、总线主从角色或文档叙述视角反转。",
    "跨接口转换写入 processing；上游接口收到的指令不得复制为下游接口输入，下游接口发出的信号不得复制为上游接口输出。硬件接口报告方向与原始需求证据冲突时按被测软件边界重新判定。",
    "只为 payload.target_leaf 这一个标题树叶子生成 raw JSON 内容，不生成其他叶子、不生成初始化内容、测试用例、总 test-requirements.json 或 DOCX。",
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "items 必须且只能包含 1 个 item；该 item 的 title_no、title、tr_code、source_ref 必须逐字等于 payload.target_leaf。",
    "excluded_title_nos 必须逐字等于 payload.excluded_title_nos；finalized标题树始终排除routing指向的初始化子树。",
    "必须读取 source_artifacts_path引用的document structure、functional_title_tree_path 和 hardware_interface_report_text_path。",
    "input_artifact_path与source_artifacts_path均指向source-artifacts.json manifest；必须跟随其中的structure_path读取需求正文和canonical source_ref，不得读取segments_path或toc_path。",
    "需求正文必须来自source_artifacts_path清单引用的structure：正文读取sections[].text，表格占位符关联同章节tables[].table_html。",
    "不要直接读取 hardware_interface_report_path 指向的 DOCX 二进制文件；workflow 已从该 DOCX 抽取 hardware_interface_report_text_path 供你读取。",
    "硬件接口参考来源固定为当前项目 .matrix/reports/hardware-interface-model.docx；第三章硬件接口标题、数据流、输入输出流和表格上下文只从 hardware_interface_report_text_path 获取。",
    "每个item必须包含tables；无表时写[]。processing每项必须包含requirement_id、source_refs、content和table_refs；source_refs必须非空、至少包含一个真实primary引用；无表TR使用table_refs: []。",
    "不要输出 processing_preamble 字段；公式、算法前言、校验规则和前置说明写入对应 processing.content，复杂字段映射和重复格式明细写入tables。",
    "遇到表格引用时必须通过text中的[表格：table_id]关联同章节tables[].table_html，或在hardware_interface_report_text_path中定位；每条processing必须输出包含primary引用的source_refs。",
    "hardware_interface_report_text_path中的第三章格式表是接口格式的优先且唯一展示位置；能定位真实完整表号时，processing.content使用“按照表3.x规定的格式接收/发送……”引用，不生成4.1本地重复表格，也不复述帧数量、完整控制场、DATA/W0～Wn布局、全部固定值或完整字段映射。",
    "processing.content只保留当前TR实际执行的SUM/CRC、DLC/Length、帧序号、标识符或帧类型等合法性校验字段，以及功能码、命令码、数据块标识、消息类型或模式标志等决定功能分支的数据特征字段；只写必要位置、期望值和对应行为，不得借关键字段重新展开完整格式。",
    "校验通过后的读取、计算、状态判断、模式约束、异常响应、应答生成、状态变化和可观测结果必须完整保留，不得以精炼格式为由删除。",
    "能确认第三章接口标题但无法稳定定位表号时，使用“按第三章<接口标题>规定的格式”自然引用，不复制完整格式，并在open_questions写明接口、消息、缺失表号及已搜索关键词；只有第三章确无对应格式表时，才通过source structure的table_id/table_html生成本地tables并用table_refs关联。",
    "同一表格在两份文本中都能定位时，以hardware_interface_report_text_path中的表格及表号为准，不得重复生成；两份文本都找不到时不得编造，在open_questions写明缺失表号或附录名以及已搜索关键词。",
    "worker仅可自行写hardware_interface_report_text_path中已确认的原表号；本地生成表不得自行编号或写“详细格式见如下表”，DOCX渲染器会根据table_refs自动生成“详细格式见表x。”。正文不得复述表格已完整承载的字段。",
    "每张表必须有item内唯一table_id且只能被一个processing.table_refs引用；不得产生未知引用、重复引用、多个TR共享同一表或孤立表。",
    "input_flow 和 output_flow 只输出相应名称，不展开描述格式；当前TR实际使用的格式校验和分支特征字段写入processing.content，第三章已有的完整格式不得重复写入tables。",
    "不要输出 test_requirements；“测试要求”小节及固定值由 DOCX 渲染器生成。",
    "processing.content使用一条或多条连贯、确定、可测试的自然语言需求语句，按实际处理顺序自然描述来源明确的条件、软件动作、关键格式判定、计算/校验规则、异常响应、状态更新和可观测结果；内容较多时拆成两到数句。",
    "禁止按“前置条件：xxx。处理动作：yyy。可观测输出：zzz。”固定模板拼接正文，也禁止使用“输入：”“触发条件：”“判断：”“异常响应：”“状态更新：”“结果：”等分类标签、冒号分类或固定槽位。",
    "不要求每条需求机械包含全部要素，只写来源明确且与当前TR相关的行为，不为凑模板补写信息；同时不要只写“解析数据”“完成处理”。精炼示例：“软件按照表3.1.6-2规定的格式接收上行遥控包，校验SUM，并依据功能标识执行对应处理；校验失败时丢弃该包。”示例行为和表号不得脱离来源照搬。",
    buildStructuredWorkerPrompt(payload),
  ].join("\n")
}

function buildFunctionalOtherContentWorkerBatch(
  inputArtifactPath: string,
  sourceArtifactsPath: string,
  functionalTitleTreePath: string,
  hardwareInterfaceReportPath: string,
  hardwareInterfaceReportTextPath: string,
  targetLeaf: FunctionalOtherTargetLeaf,
  excludedTitleNos: string[],
  outputPath: string,
): FunctionalOtherContentWorkerBatch {
  const payload = {
    worker_type: "functional-other-content-modeler",
    input_artifact_path: inputArtifactPath,
    source_artifacts_path: sourceArtifactsPath,
    functional_title_tree_path: functionalTitleTreePath,
    hardware_interface_report_path: hardwareInterfaceReportPath,
    hardware_interface_report_text_path: hardwareInterfaceReportTextPath,
    target_leaf: targetLeaf,
    excluded_title_nos: excludedTitleNos,
    output_path: outputPath,
  }

  return {
    subagent_type: "functional-other-content-modeler",
    output_path: outputPath,
    worker_payload: payload,
    worker_prompt: buildFunctionalOtherContentWorkerPrompt(payload),
  }
}

const HARDWARE_INTERFACE_KINDS = new Set<HardwareInterfaceKind>([
  "can", "fpga", "ad", "serial", "spi", "spacewire", "watchdog", "gpio", "discrete", "ethernet", "mil1553b", "i2c", "other",
])

function buildHardwareInterfaceDiscoveryBatch(inputArtifactPath: string, outputPath: string): HardwareInterfaceDiscoveryBatch {
  const payload = { worker_type: "hardware-interface-discoverer", input_artifact_path: inputArtifactPath, output_path: outputPath }
  return {
    subagent_type: "hardware-interface-discoverer",
    output_path: outputPath,
    worker_payload: payload,
    worker_prompt: [
      "sections[].text 中的 [表格：table_id] 仅表示原始位置；表格内容唯一来源是同章节 tables[].table_html，须按 table_id 关联并理解 rowspan/colspan。",
      "必须从主 SRS 全文发现真实硬件接口候选；补充文档不能新增候选。",
      "优先硬件接口章节，同时检查硬件环境和运行环境中的硬件狗、GPIO、离散量等接口。",
      "必须全文搜索‘看门狗’；主SRS中出现看门狗对象及相关说明时生成interface_kind=watchdog的候选，不要求位于外部接口章节，并汇总运行环境、硬件环境及相关功能章节的source_refs和证据。‘硬件狗’和‘Watchdog’按同义对象处理。",
      "同一父章节下名称仅以CANA/CANB或CAN A/CAN B通道标识区分的两个接口必须合并为一个CAN总线候选，合并source_refs、keywords和证据摘要并按首次出现位置连续编号；一级/二级CAN、不同父章节、不同通信对象或独立物理接口不得合并，且不得仅凭A/B名称推断互备。",
      buildStructuredWorkerPrompt(payload),
    ].join("\n"),
  }
}

function normalizeHardwareInterfaceCandidates(path: string, manifest: SourceArtifactsManifest): HardwareInterfaceCandidatesArtifact {
  const root = HardwareCandidatesRaw.parse(readJson<unknown>(path))
  if (!isRecord(root) || !Array.isArray(root.candidates)) {
    throw new Error(`${path}: candidates artifact must contain a top-level candidates array.`)
  }
  if (Number(root.model_version) !== 1) throw new Error(`${path}: model_version must be 1.`)
  const sourceArtifactsPath = textOf(root.source_artifacts_path)
  if (!sourceArtifactsPath) throw new Error(`${path}: source_artifacts_path is required.`)
  const candidates: HardwareInterfaceCandidate[] = []
  const seenNames = new Set<string>()
  for (const [index, value] of root.candidates.entries()) {
    if (!isRecord(value)) throw new Error(`${path}: candidates[${index}] must be an object.`)
    assertOnlyKeys(value, ["candidate_id", "interface_name", "interface_kind", "keywords", "source_refs", "evidence_summary"], `candidates[${index}]`)
    const candidateId = `HI-${String(index + 1).padStart(3, "0")}`
    const expectedId = `HI-${String(index + 1).padStart(3, "0")}`
    if (candidateId !== expectedId) throw new Error(`${path}: candidates[${index}].candidate_id must be ${expectedId}.`)
    const interfaceName = textOf(value.interface_name)
    const interfaceKind = textOf(value.interface_kind).toLowerCase() as HardwareInterfaceKind
    const keywords = stringArrayOf(value.keywords)
    const sourceRefs = stringArrayOf(value.source_refs)
    const evidenceSummary = textOf(value.evidence_summary)
    if (!interfaceName || !HARDWARE_INTERFACE_KINDS.has(interfaceKind) || keywords.length === 0 || !evidenceSummary) {
      throw new Error(`${path}: candidates[${index}] has missing or invalid required fields.`)
    }
    const nameKey = normalizeSearchText(interfaceName)
    if (seenNames.has(nameKey)) { phase2Warning(`跳过重复接口 ${interfaceName}`, 1); continue }
    seenNames.add(nameKey)

    candidates.push({ candidate_id: candidateId, interface_name: interfaceName, interface_kind: interfaceKind, keywords: [...new Set(keywords)], source_refs: [...new Set(sourceRefs)], evidence_summary: evidenceSummary })
  }
  return { model_version: 1, source_artifacts_path: sourceArtifactsPath, candidates }
}

function reusableHardwareInterfaceCandidatesArtifact(
  candidatesPath: string,
  sourceArtifactsPath: string,
  manifest: SourceArtifactsManifest,
): HardwareInterfaceCandidatesArtifact | null {
  if (!existsSync(candidatesPath)) return null
  try {
    const artifact = normalizeHardwareInterfaceCandidates(candidatesPath, manifest)

    return artifact
  } catch {
    return null
  }
}

function buildGenericHardwareInterfaceWorkerBatch(
  inputArtifactPath: string,
  candidatesPath: string,
  candidate: HardwareInterfaceCandidate,
  outputPath: string,
): GenericHardwareInterfaceWorkerBatch {
  const specializedSkill = specializedHardwareInterfaceModelingSkill(candidate)
  const isMil1553b = specializedSkill === "mil1553b-interface-analysis"
  const isCan = specializedSkill === "can-bus-interface-analysis"
  const isAd = specializedSkill === "ad-acquisition-interface-analysis"
  const isWatchdog = specializedSkill === "watchdog-interface-analysis"
  const payload = {
    worker_type: "hardware-interface-modeler",
    input_artifact_path: inputArtifactPath,
    candidates_path: candidatesPath,
    candidate_id: candidate.candidate_id,
    output_path: outputPath,
  }
  return {
    subagent_type: "hardware-interface-modeler",
    candidate_id: candidate.candidate_id,
    interface_name: candidate.interface_name,
    interface_kind: candidate.interface_kind,
    output_path: outputPath,
    worker_payload: payload,
    worker_prompt: [
      `必须使用 $hardware-interface-modeling 为候选 ${candidate.candidate_id}/${candidate.interface_name} 建模。`,
      "必须同时使用 $hardware-interface-dataflow-constraints；以被测 CPU 软件为主体，允许单向流，禁止跨接口归因。",
      specializedSkill
        ? `本候选还必须加载并使用 $${specializedSkill}；该专用 Skill 只补充领域检索与组织经验，通用模型契约和数据流约束优先。`
        : "本候选不得加载 $can-bus-interface-analysis、$ad-acquisition-interface-analysis、$serial-interface-analysis、$mil1553b-interface-analysis 或 $watchdog-interface-analysis。",
      "严格执行成立判定、检索、总述、三级标题、四级标题判定、先表后流和唯一归类；接口级地址/寄存器/端口/通道静态映射原表可放overview_tables，事务原表放对应输入或输出，同一table_id不得重复。初始化/初始设置/复位配置/寄存器初值表及中断设置/配置/分配/优先级/触发方式表不得进入overview_tables；以地址、端口、通道映射为主且仅含少量中断行的混合原表可完整保留，主用途不明时不引用。",
      "若当前候选包含间接指令，overview只保留指令码、输出地址、脉冲参数（脉宽、电平），删除电路构成和无关背景；内容等价或同一table_id的指令原表只在最匹配位置完整引用一次，不跨overview、顶层流和topics重复，不同事务且内容不等价的原表仍分别保留。若包含数字量采集，优先完整引用呈现采集地址和参数名称的真实原表并将静态地址/参数映射表放入overview_tables，不重画或裁剪；正文不重复表格地址，数据流只明确实际参数及定义，不重复软件读取、按地址采集或接口输入等接口动作。",
      isCan
        ? "必须生成以 IF- 开头的 interface_id；candidate_id 仅用于内部匹配。topics 禁止 content 字段。合并的CANA/CANB候选必须同时读取两个来源章节并只生成一个三级接口。CAN overview必须明确通信对象、控制芯片、工作模式、波特率或数据传输速率、技术规范和数据格式，必备要素无来源时写XX；有互备证据时写‘A、B两条总线互相备份，A总线基地址为XXX，B总线基地址为XXX’，关系不明确时写‘A、B两条总线关系为XX’，A/B基地址缺失时分别写XX，不得仅凭A/B名称推断互备。有证据时保留总线数量、时钟、基地址、冗余关系及中断号或名称和挂接关系。不得写初始化时机/动作/初值/默认配置/结果、中断优先级、触发方式、ISR、中断使能或寄存器配置，也不得把排除内容转移到topic或输入输出流。"
        : isMil1553b
        ? "必须生成以 IF- 开头的 interface_id；candidate_id 仅用于内部匹配。topics 禁止 content 字段。1553B overview必须逐项检查芯片名称、符合标准、传输速率、时钟频率、寄存器基地址、RAM基地址、零等待模式及位数、BC/RT/BM角色、RT地址和挂接中断，只写有证据的事实；允许写中断号或名称及挂接关系，但不得写优先级、触发方式、ISR、中断使能或寄存器配置。不得写初始化时机/动作/初值/默认配置/结果，也不得把排除内容转移到topic或输入输出流。"
        : isWatchdog
        ? "必须生成以 IF- 开头的 interface_id；candidate_id 仅用于内部匹配。topics 禁止 content 字段。必须从运行环境、硬件环境和相关功能章节开始并全文搜索‘复位、看门狗、硬件狗、喂狗、狗咬、Watchdog’。看门狗overview必须包含芯片型号、喂狗端口、喂狗电平或动作、狗咬时间和狗咬后的结果，缺失项在对应位置写XX，不得根据示例或芯片常识猜测。"
        : "必须生成以 IF- 开头的 interface_id；candidate_id 仅用于内部匹配。topics 禁止 content 字段。overview只保留接口数量、通信对象、总线类型、基地址、时钟、波特率、工作模式、位数、量程、转换时间等必要接口事实；不得写初始化时机/动作/初值/默认配置/结果或中断号/优先级/触发方式/ISR/中断使能/挂接关系，也不得把排除内容转移到topic或输入输出流。独立中断/离散信号接口的真实事件仍可作为数据流。",
      isMil1553b
        ? "软件明确作为RT时，描述当前RT的子地址表按T/R=0输入、T/R=1输出解释；非RT、主体不明或证据冲突时回到被测CPU边界，无法消歧不得猜测。总线数据及其子地址分配原表必须完整进入overview_tables并保留全部原始列。"
        : "方向继续严格以被测CPU软件边界判定，不得因总线角色或表格方向字段改变。",
      isCan
        ? "输入输出使用“输入流/输出流：数据内容短名。数据内容说明”；只聚焦实际指令、数据、状态、请求或应答内容，不重复‘通过CAN总线’、‘经CAN接口’或通信对象等已由overview说明的通信方式；同一业务事务在A、B通道内容等价时只生成一个topic，通道专属且内容不同的事务才分别保留；有对应表格时自然引出‘格式如下表所示’。原始地址表和格式表必须完整引用，不新增、裁剪或重画。"
        : "输入输出使用“输入流/输出流：短主题。简短说明”；用一两句介绍谁通过什么总线/接口接收或发送了什么内容，有对应表格时自然引出“格式如下表所示”。",
      isMil1553b
        ? "每条1553B数据流必须按短名称、软件处理过程、数据格式表的顺序组织；处理过程写明软件通过有证据的真实接收/发送子地址执行的接收、解析、处理或发送动作，不得补造子地址。输出前检查属性无证据不补造、子地址表未遗漏、RT场景T/R方向正确、每张格式表唯一归类。"
        : isAd
        ? "同一AD接口同时存在电压遥测量采集和电流遥测量采集时，二者是同一模拟量采集过程的处理分支：将不同位宽、通道范围、采样次数、滤波和计算逻辑完整合并到三级overview，顶层input_flow统一概括实际电压、电流模拟量，禁止分别生成电压采集与电流采集topics；其他真正独立的AD事务仍可生成topic。表格沿用原表引用机制，不新增、转换、裁剪、重画或摘要化原表。"
        : isWatchdog
        ? "软件驱动端口或信号完成喂狗时可生成输出流；狗咬后的复位结果只写入overview，不凭空创建输入流或四级topic。端口、时序或静态映射原表按通用规则完整引用，不新增、截断、删改、重画或摘要化原表。"
        : "不得为没有证据的数据流补造地址、处理动作或格式表。",
      buildStructuredWorkerPrompt(payload),
    ].join("\n"),
  }
}

type SpecializedHardwareInterfaceModelingSkill =
  | "can-bus-interface-analysis"
  | "ad-acquisition-interface-analysis"
  | "serial-interface-analysis"
  | "mil1553b-interface-analysis"
  | "watchdog-interface-analysis"

const SPECIALIZED_KIND_PRIORITY = ["mil1553b", "ad", "serial", "can", "watchdog"] as const

const SPECIALIZED_KIND_PATTERNS: Record<(typeof SPECIALIZED_KIND_PRIORITY)[number], RegExp> = {
  mil1553b: /(?:MIL\s*[-_]?\s*STD\s*[-_]?\s*1553B|(?<!\d)1553B(?!\d)|GJB\s*[-_]?\s*289A[\s\S]{0,40}(?:等效|符合|兼容|对应)[\s\S]{0,40}(?:MIL\s*[-_]?\s*STD\s*[-_]?\s*)?1553B|(?:MIL\s*[-_]?\s*STD\s*[-_]?\s*)?1553B[\s\S]{0,40}(?:等效|符合|兼容|对应)[\s\S]{0,40}GJB\s*[-_]?\s*289A)/i,
  ad: /(?:A\s*(?:\/\s*)?D\s*(?:数据\s*)?采集|模数(?:转换)?采集)/i,
  serial: /(?:串口|UART|RS\s*[-_]?\s*(?:232|422|485))/i,
  can: /(?:^|[^A-Z0-9])CAN(?:[AB0-9]+)?(?:[^A-Z0-9]|$)|CAN总线/i,
  watchdog: /(?:看门狗|硬件狗|Watchdog)/i,
}

const EXPLICIT_INTERFACE_NAME_RULES: Array<{ kind: Exclude<HardwareInterfaceKind, "other">; pattern: RegExp }> = [
  { kind: "mil1553b", pattern: SPECIALIZED_KIND_PATTERNS.mil1553b },
  { kind: "fpga", pattern: /(?:^|[^A-Z0-9])FPGA(?:[^A-Z0-9]|$)/i },
  { kind: "spacewire", pattern: /(?:SpaceWire|Space\s*Wire)/i },
  { kind: "ethernet", pattern: /(?:以太网|Ethernet)/i },
  { kind: "watchdog", pattern: SPECIALIZED_KIND_PATTERNS.watchdog },
  { kind: "serial", pattern: SPECIALIZED_KIND_PATTERNS.serial },
  { kind: "ad", pattern: SPECIALIZED_KIND_PATTERNS.ad },
  { kind: "spi", pattern: /(?:^|[^A-Z0-9])SPI(?:[^A-Z0-9]|$)/i },
  { kind: "i2c", pattern: /(?:I\s*2\s*C|I²C)/i },
  { kind: "gpio", pattern: /(?:^|[^A-Z0-9])GPIO(?:[^A-Z0-9]|$)/i },
  { kind: "discrete", pattern: /离散(?:量|信号|接口)/i },
  { kind: "can", pattern: /(?:^|[^A-Z0-9])CAN(?:[AB0-9]+)?(?:[^A-Z0-9]|$)|CAN总线/i },
]

function candidateSourceContext(candidate: HardwareInterfaceCandidate, manifest: SourceArtifactsManifest): string[] {
  try {
    const lookup = buildSourceSectionLookup(manifest)
    return candidate.source_refs.flatMap((sourceRef) => (lookup.get(sourceRef) || []).map((section) =>
      [section.title, ...section.section_path_titles].filter(Boolean).join(" "),
    ))
  } catch {
    return []
  }
}

function classifyHardwareInterfaceCandidate(
  candidate: HardwareInterfaceCandidate,
  manifest: SourceArtifactsManifest,
): { candidate: HardwareInterfaceCandidate; repair?: HardwareInterfaceClassificationRepair; warning?: HardwareInterfaceClassificationWarning } {
  if (candidate.interface_kind !== "other") return { candidate }

  const explicit = EXPLICIT_INTERFACE_NAME_RULES.find((rule) => rule.pattern.test(candidate.interface_name))
  if (explicit) {
    const repair: HardwareInterfaceClassificationRepair = {
      candidate_id: candidate.candidate_id,
      interface_name: candidate.interface_name,
      original_kind: "other",
      resolved_kind: explicit.kind,
      scores: { mil1553b: 0, ad: 0, serial: 0, can: 0, watchdog: 0 },
      evidence: [`interface_name:${candidate.interface_name}`],
      decision_rule: "explicit-interface-name",
      timestamp: new Date().toISOString(),
    }
    return { candidate: { ...candidate, interface_kind: explicit.kind }, repair }
  }

  const scores = { mil1553b: 0, ad: 0, serial: 0, can: 0, watchdog: 0 }
  const evidence: string[] = []
  const contexts = candidateSourceContext(candidate, manifest)
  for (const kind of SPECIALIZED_KIND_PRIORITY) {
    const pattern = SPECIALIZED_KIND_PATTERNS[kind]
    for (const keyword of candidate.keywords) {
      if (!pattern.test(keyword)) continue
      scores[kind] += 25
      evidence.push(`${kind}:keyword:${keyword}`)
    }
    if (pattern.test(candidate.evidence_summary)) {
      scores[kind] += 5
      evidence.push(`${kind}:evidence_summary`)
    }
    for (const context of contexts) {
      if (!pattern.test(context)) continue
      scores[kind] += 2
      evidence.push(`${kind}:source_context:${context}`)
    }
  }

  const highestScore = Math.max(...Object.values(scores))
  if (highestScore <= 0) return { candidate }
  const tiedKinds = SPECIALIZED_KIND_PRIORITY.filter((kind) => scores[kind] === highestScore)
  const resolvedKind = tiedKinds[0]
  const repair: HardwareInterfaceClassificationRepair = {
    candidate_id: candidate.candidate_id,
    interface_name: candidate.interface_name,
    original_kind: "other",
    resolved_kind: resolvedKind,
    scores,
    evidence,
    decision_rule: tiedKinds.length > 1 ? "score-tie:mil1553b>ad>serial>can>watchdog" : "highest-specialized-score",
    timestamp: new Date().toISOString(),
  }
  const warning = tiedKinds.length > 1 ? {
    candidate_id: candidate.candidate_id,
    code: "SPECIALIZED_SKILL_TIE" as const,
    message: `候选 ${candidate.candidate_id}/${candidate.interface_name} 专用类别评分并列（${tiedKinds.join("、")}），已按 mil1553b > ad > serial > can > watchdog 自动选择 ${resolvedKind}。`,
  } : undefined
  return { candidate: { ...candidate, interface_kind: resolvedKind }, repair, warning }
}

function persistHardwareInterfaceClassification(
  candidatesPath: string,
  artifact: HardwareInterfaceCandidatesArtifact,
  repairs: HardwareInterfaceClassificationRepair[],
  ctx: ToolContext,
  manifest: SourceArtifactsManifest,
) {
  if (repairs.length === 0) return
  const auditPath = defaultArtifactPath(ctx, "hardware-interface-classification-audit.json")
  const previousAudit = existsSync(auditPath) ? readJson<{ schema_version?: number; repairs?: HardwareInterfaceClassificationRepair[] }>(auditPath) : undefined
  const audit = {
    schema_version: 1,
    candidates_path: candidatesPath,
    updated_at: new Date().toISOString(),
    repairs: [...(Array.isArray(previousAudit?.repairs) ? previousAudit.repairs : []), ...repairs],
  }
  HardwareCandidatesRaw.parse(artifact)
  writeJsonAtomic(candidatesPath, artifact)
  normalizeHardwareInterfaceCandidates(candidatesPath, manifest)
  writeJsonAtomic(auditPath, audit)
}

function specializedHardwareInterfaceModelingSkill(candidate: HardwareInterfaceCandidate): SpecializedHardwareInterfaceModelingSkill | null {
  if (candidate.interface_kind === "can") return "can-bus-interface-analysis"
  if (candidate.interface_kind === "ad") return "ad-acquisition-interface-analysis"
  if (candidate.interface_kind === "serial") return "serial-interface-analysis"
  if (candidate.interface_kind === "mil1553b") return "mil1553b-interface-analysis"
  if (candidate.interface_kind === "watchdog") return "watchdog-interface-analysis"
  return null
}

function normalizeGenericTopic(value: unknown, context: string): GenericHardwareInterfaceTopic {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`)
  assertOnlyKeys(value, ["title", "source_refs", "input_flow", "input_tables", "output_flow", "output_tables"], context)
  return {
    ...value, title: textOf(value.title), source_refs: stringArrayOf(value.source_refs),
    input_flow: textOf(value.input_flow), input_tables: normalizeRawTableRefs(value.input_tables),
    output_flow: textOf(value.output_flow), output_tables: normalizeRawTableRefs(value.output_tables),
  }
}

function readGenericHardwareInterfaceArtifact(path: string, candidate: HardwareInterfaceCandidate): GenericHardwareInterface[] {
  const root = trackRaw(HardwareInterfaceRaw.parse(readJson<unknown>(path)), path)
  if (!isRecord(root)) throw new Error(`${path}: raw interface artifact must be an object.`)
  assertOnlyKeys(root, ["interface"], path)
  if (root.interface == null) return []
  if (!isRecord(root.interface)) throw new Error(`${path}: interface must be an object or null.`)
  const value = root.interface
  assertOnlyKeys(value, ["candidate_id", "interface_id", "interface_name", "interface_kind", "title", "overview", "source_refs", "overview_tables", "topics", "input_flow", "input_tables", "output_flow", "output_tables"], `${path}: interface`)
  const sourceRefs = stringArrayOf(value.source_refs)
  if (!Array.isArray(value.overview_tables)) throw new Error(`${path}: interface.overview_tables must be an array.`)
  const interfaceId = /^IF-\\S+$/.test(textOf(value.interface_id)) ? textOf(value.interface_id) : `IF-${candidate.candidate_id}`
  return [{
    ...value,
    candidate_id: candidate.candidate_id, interface_id: interfaceId, interface_name: candidate.interface_name, interface_kind: candidate.interface_kind,
    title: textOf(value.title), overview: textOf(value.overview), source_refs: sourceRefs,
    overview_tables: normalizeRawTableRefs(value.overview_tables),
    topics: (Array.isArray(value.topics) ? value.topics : []).map((topic, index) => normalizeGenericTopic(topic, `${path}: topics[${index}]`)),
    input_flow: textOf(value.input_flow), input_tables: normalizeRawTableRefs(value.input_tables),
    output_flow: textOf(value.output_flow), output_tables: normalizeRawTableRefs(value.output_tables),
  }]
}

function genericInterfaceTableGroups(item: GenericHardwareInterface): Array<{ tables: HardwareInterfaceModelTable[]; label: string }> {
  const groups = [
    { tables: Array.isArray(item.overview_tables) ? item.overview_tables : [], label: "overview" },
    { tables: Array.isArray(item.input_tables) ? item.input_tables : [], label: "input" },
    { tables: Array.isArray(item.output_tables) ? item.output_tables : [], label: "output" },
  ]
  for (const [index, topic] of (Array.isArray(item.topics) ? item.topics : []).entries()) {
    groups.push({ tables: Array.isArray(topic.input_tables) ? topic.input_tables : [], label: `topic ${index + 1} input` })
    groups.push({ tables: Array.isArray(topic.output_tables) ? topic.output_tables : [], label: `topic ${index + 1} output` })
  }
  return groups
}

export function validateGenericInterfaceTableUniqueness(item: GenericHardwareInterface, contextLabel: string) {
  for (const group of genericInterfaceTableGroups(item)) {
    const seen = new Set<string>()
    group.tables.splice(0, group.tables.length, ...group.tables.filter(table => {
      const id = textOf(table.table_id)
      if (!id || seen.has(id)) return false
      seen.add(id); return true
    }))
  }
}

function validateAndEnrichGenericModel(model: HardwareInterfaceModelArtifact, manifest: SourceArtifactsManifest): HardwareInterfaceModelArtifact {
  const sourceLookup = buildSourceSectionLookup(manifest)
  const tableLookup = buildSourceTableLookup(manifest)
  const interfaces = Array.isArray(model.interfaces) ? model.interfaces : []
  const seenInterfaceIds = new Set<string>()
  return {
    ...model,
    interfaces: interfaces.map((item, index) => {
      let interfaceId = textOf(item.interface_id)
      if (!/^IF-\S+$/.test(interfaceId) || seenInterfaceIds.has(interfaceId)) {
        interfaceId = `IF-AUTO-${index + 1}`
        while (seenInterfaceIds.has(interfaceId)) interfaceId += "-1"
      }
      seenInterfaceIds.add(interfaceId)
      validateGenericInterfaceTableUniqueness(item, `interface ${index + 1}`)
      const topics = (Array.isArray(item.topics) ? item.topics : []).map((topic, topicIndex) => {
        return {
          ...topic,
          source_refs: resolveSourceRefs(sourceLookup, topic.source_refs, "topic").map(section => section.source_ref),
          input_tables: enrichTableGroup(tableLookup, topic.input_tables, `interface ${index + 1} topic ${topicIndex + 1} input`),
          output_tables: enrichTableGroup(tableLookup, topic.output_tables, `interface ${index + 1} topic ${topicIndex + 1} output`),
        }
      })
      return {
        ...item, interface_id: interfaceId, source_refs: resolveSourceRefs(sourceLookup, item.source_refs, "interface").map(section => section.source_ref), topics,
        overview_tables: enrichTableGroup(tableLookup, item.overview_tables, `interface ${index + 1} overview`),
        input_tables: enrichTableGroup(tableLookup, item.input_tables, `interface ${index + 1} input`),
        output_tables: enrichTableGroup(tableLookup, item.output_tables, `interface ${index + 1} output`),
      }
    }),
  }
}

function canReuseGenericHardwareInterfaceRawArtifact(path: string, candidate: HardwareInterfaceCandidate, manifest: SourceArtifactsManifest): boolean {
  if (!existsSync(path)) return false
  try { readGenericHardwareInterfaceArtifact(path, candidate); return true } catch { return false }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors || [])
    .map((error) => {
      const path = error.instancePath || "/"
      const params = Object.keys(error.params || {}).length > 0 ? ` ${JSON.stringify(error.params)}` : ""
      return `- ${path}: ${error.message || error.keyword}${params}`
    })
    .join("\n")
}


const functionalTitleTreeAjv = new Ajv({ allErrors: true, useDefaults: true })

const functionalTitleTreeRawSchema = {
  type: "object",
  required: ["functional_root_source_ref", "root_title", "children", "skipped_source_refs"],
  additionalProperties: false,
  properties: {
    functional_root_source_ref: { type: "string" },
    root_title: { type: "string", minLength: 1 },
    children: {
      type: "array",
      items: { $ref: "#/$defs/node" },
    },
    routing: { $ref: "#/$defs/routing" },
    skipped_source_refs: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
  $defs: {
    routing: {
      type: "object",
      required: ["has_initialization", "initialization_title_no", "initialization_source_ref"],
      additionalProperties: false,
      properties: {
        has_initialization: { type: "boolean" },
        initialization_title_no: {
          anyOf: [
            { type: "string", minLength: 1 },
            { type: "null" },
          ],
        },
        initialization_source_ref: {
          anyOf: [
            { type: "string", minLength: 1 },
            { type: "null" },
          ],
        },
      },
    },
    node: {
      type: "object",
      required: ["title_no", "title", "source_ref", "children"],
      additionalProperties: false,
      properties: {
        title_no: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        tr_code: { type: "string", minLength: 1 },
        source_ref: { type: "string", minLength: 1 },
        children: {
          type: "array",
          items: { $ref: "#/$defs/node" },
        },
      },
    },
  },
}

const validateFunctionalTitleTreeRawSchema = functionalTitleTreeAjv.compile(relaxedReferenceSchema(functionalTitleTreeRawSchema))
const FUNCTIONAL_TR_CODE_RE = /^TR-GN-[A-Za-z0-9]+$/
const FUNCTIONAL_TR_MARKER_RE = /\[TR-GN-[A-Za-z0-9]+\]/g

function readFunctionalTitleTreeRawArtifact(path: string): FunctionalTitleTreeRawArtifact {
  const readResult = readJsonWithSimpleRepair(path)
  if (!validateFunctionalTitleTreeRawSchema(readResult.value)) {
    throw new Error([
      `${path}: functional title tree raw artifact does not match the JSON schema.`,
      formatAjvErrors(validateFunctionalTitleTreeRawSchema.errors),
      "Repair hint: rerun functional-title-tree-modeler or ask the model to repair only the JSON structure.",
    ].filter(Boolean).join("\n"))
  }
  if (readResult.repaired) {
    writeJson(path, readResult.value)
  }
  return readResult.value as FunctionalTitleTreeRawArtifact
}

function normalizeTitleForCompare(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function appendFunctionalRequirementSuffix(sourceTitle: string): string {
  const title = normalizeTitleForCompare(sourceTitle)
  if (!title) return "功能需求项"
  if (title.endsWith("功能需求项") || title.endsWith("需求项")) return title
  if (title.endsWith("功能需求") || title.endsWith("需求")) return `${title}项`
  if (title.endsWith("功能")) return `${title}需求项`
  return `${title}功能需求项`
}

function isInitializationFunctionalTitle(title: string): boolean {
  return normalizeTitleForCompare(title).includes("\u521d\u59cb\u5316")
}

function collectInitializationFunctionalNodes(nodes: FunctionalTitleTreeNode[], matches: FunctionalTitleTreeNode[] = []): FunctionalTitleTreeNode[] {
  for (const node of nodes) {
    if (isInitializationFunctionalTitle(textOf(node.title))) {
      matches.push(node)
      continue
    }
    const children = Array.isArray(node.children) ? node.children : []
    collectInitializationFunctionalNodes(children, matches)
  }
  return matches
}

function deriveFunctionalTitleTreeRouting(children: FunctionalTitleTreeNode[]): Required<FunctionalTitleTreeRouting> {
  const initCandidates = collectInitializationFunctionalNodes(children)
  if (initCandidates.length > 1) {
    phase2Warning(`发现 ${initCandidates.length} 个初始化标题，首个走初始化流程，其余按普通功能处理`)
  }
  if (initCandidates.length === 0) {
    return {
      has_initialization: false,
      initialization_title_no: null,
      initialization_source_ref: null,
    }
  }

  const initSection = initCandidates[0]
  const titleNo = textOf(initSection.title_no)
  const sourceRef = textOf(initSection.source_ref)
  if (!titleNo || !sourceRef) {
    phase2Warning("初始化标题缺少身份或来源，按普通功能处理")
    return { has_initialization: false, initialization_title_no: null, initialization_source_ref: null }
  }
  return {
    has_initialization: true,
    initialization_title_no: titleNo,
    initialization_source_ref: sourceRef,
  }
}

function renumberFunctionalTitleTreeNodes(nodes: FunctionalTitleTreeNode[], parentTitleNo = "4.1"): FunctionalTitleTreeNode[] {
  return nodes.map((node, index) => {
    const titleNo = `${parentTitleNo}.${index + 1}`
    return {
      ...node,
      title_no: titleNo,
      children: renumberFunctionalTitleTreeNodes(Array.isArray(node.children) ? node.children : [], titleNo),
    }
  })
}

function ensureInitializationFunctionalNode(
  children: FunctionalTitleTreeNode[],
  fallbackSourceRef: string,
): FunctionalTitleTreeNode[] {
  const extractInitialization = (nodes: FunctionalTitleTreeNode[]): {
    initialization?: FunctionalTitleTreeNode
    remaining: FunctionalTitleTreeNode[]
  } => {
    for (const [index, node] of nodes.entries()) {
      if (isInitializationFunctionalTitle(textOf(node.title))) {
        return { initialization: node, remaining: nodes.filter((_, nodeIndex) => nodeIndex !== index) }
      }
      const nested = extractInitialization(Array.isArray(node.children) ? node.children : [])
      if (nested.initialization) {
        return {
          initialization: nested.initialization,
          remaining: nodes.map((candidate, nodeIndex) => nodeIndex === index
            ? { ...candidate, children: nested.remaining }
            : candidate),
        }
      }
    }
    return { remaining: nodes }
  }

  const extracted = extractInitialization(children)
  const initialization = extracted.initialization || {
      title_no: "4.1.1",
      title: "初始化功能需求项[TR-GN-Init]",
      tr_code: "TR-GN-Init",
      source_ref: fallbackSourceRef,
      children: [],
    }
  return renumberFunctionalTitleTreeNodes([initialization, ...extracted.remaining])
}

function normalizeFunctionalTitleTreeRouting(titleTree: FunctionalTitleTreeArtifact): Required<FunctionalTitleTreeRouting> {
  return deriveFunctionalTitleTreeRouting(Array.isArray(titleTree.children) ? titleTree.children : [])
}

function sameSourceDocument(left: SourceSectionEntry, right: SourceSectionEntry): boolean {
  return left.source_path === right.source_path
}

function isDescendantSection(root: SourceSectionEntry, candidate: SourceSectionEntry): boolean {
  if (!sameSourceDocument(root, candidate) || !root.section_id) return false
  const pathIds = candidate.section_path_ids
  if (pathIds.length > 0) {
    const rootIndex = pathIds.indexOf(root.section_id)
    return rootIndex >= 0 && rootIndex < pathIds.length - 1
  }
  return candidate.section_id.startsWith(`${root.section_id}.`)
}

function isDirectChildSection(parent: SourceSectionEntry, candidate: SourceSectionEntry): boolean {
  if (!sameSourceDocument(parent, candidate) || !parent.section_id) return false
  const pathIds = candidate.section_path_ids
  if (pathIds.length > 0) {
    return pathIds.length >= 2 && pathIds[pathIds.length - 2] === parent.section_id
  }
  if (!isDescendantSection(parent, candidate)) return false
  const suffix = candidate.section_id.slice(parent.section_id.length + 1)
  return suffix.length > 0 && !suffix.includes(".")
}

function resolveUniqueSourceRef(
  lookup: Map<string, SourceSectionEntry[]>,
  sourceRef: string,
  contextLabel: string,
): SourceSectionEntry {
  if (!sourceRef.includes("::")) {
    throw new Error(`${contextLabel}: source_ref ${sourceRef} must include a document prefix such as primary::SRS-3.2.`)
  }
  const matches = lookup.get(sourceRef) || []
  if (matches.length === 0) {
    throw new Error(`${contextLabel}: source_ref ${sourceRef} was not found in source artifacts.`)
  }
  if (matches.length > 1) {
    throw new Error(`${contextLabel}: source_ref ${sourceRef} is not unique in source artifacts.`)
  }
  return matches[0]
}

function buildSkippedFunctionalSourceSet(
  skippedRefs: string[],
  lookup: Map<string, SourceSectionEntry[]>,
  root: SourceSectionEntry,
): Set<string> {
  const skipped = new Set<string>()
  for (const [index, ref] of skippedRefs.entries()) {
    const source = resolveUniqueSourceRef(lookup, ref, `skipped_source_refs[${index}]`)
    if (source.source_ref === root.source_ref) {
      throw new Error("skipped_source_refs must not include the functional root itself.")
    }
    if (!isDescendantSection(root, source)) {
      throw new Error(`skipped_source_refs[${index}]: ${ref} is outside functional_root_source_ref ${root.source_ref}.`)
    }
    skipped.add(source.source_ref)
  }
  return skipped
}

function isSkippedByAncestor(
  source: SourceSectionEntry,
  skippedRefs: Set<string>,
  lookup: Map<string, SourceSectionEntry[]>,
): boolean {
  if (skippedRefs.has(source.source_ref)) return true
  for (const skippedRef of skippedRefs) {
    const skipped = lookup.get(skippedRef)?.[0]
    if (skipped && isDescendantSection(skipped, source)) return true
  }
  return false
}

function expectedFunctionalChildren(
  parent: SourceSectionEntry,
  allSections: SourceSectionEntry[],
  skippedRefs: Set<string>,
  lookup: Map<string, SourceSectionEntry[]>,
): SourceSectionEntry[] {
  return allSections.filter((section) =>
    isDirectChildSection(parent, section) && !isSkippedByAncestor(section, skippedRefs, lookup)
  )
}

interface FunctionalTitleTreeValidationState {
  allSections: SourceSectionEntry[]
  lookup: Map<string, SourceSectionEntry[]>
  skippedRefs: Set<string>
  trCodes: Map<string, string>
  nodeCount: number
  leafCount: number
}

function validateFunctionalTitleTreeChildren(
  nodes: FunctionalTitleTreeNode[],
  expectedSources: SourceSectionEntry[],
  parentTitleNo: string,
  state: FunctionalTitleTreeValidationState,
) {
  if (nodes.length !== expectedSources.length) {
    throw new Error(
      `${parentTitleNo}: expected ${expectedSources.length} child node(s) from source tree, got ${nodes.length}. ` +
      `Expected source_ref(s): ${expectedSources.map((source) => source.source_ref).join(", ") || "(none)"}.`,
    )
  }

  const expectedBySourceRef = new Map<string, SourceSectionEntry>()
  for (const expectedSource of expectedSources) {
    if (expectedBySourceRef.has(expectedSource.source_ref)) {
      throw new Error(`${parentTitleNo}: duplicate expected source_ref ${expectedSource.source_ref} in source tree.`)
    }
    expectedBySourceRef.set(expectedSource.source_ref, expectedSource)
  }

  const seenSourceRefs = new Set<string>()
  const expectedSourceRefList = expectedSources.map((source) => source.source_ref).join(", ") || "(none)"

  for (const [index, node] of nodes.entries()) {
    const contextLabel = `${parentTitleNo} child ${index + 1}`
    const expectedTitleNo = `${parentTitleNo}.${index + 1}`
    const sourceRef = textOf(node.source_ref)
    const titleNo = textOf(node.title_no)
    const title = textOf(node.title)
    const trCode = textOf(node.tr_code)
    const children = Array.isArray(node.children) ? node.children : []

    state.nodeCount += 1

    if (seenSourceRefs.has(sourceRef)) {
      throw new Error(`${contextLabel}: duplicate source_ref ${sourceRef}.`)
    }
    seenSourceRefs.add(sourceRef)

    const expectedSource = expectedBySourceRef.get(sourceRef)
    if (!expectedSource) {
      throw new Error(`${contextLabel}: source_ref ${sourceRef || "empty"} is not an expected child of ${parentTitleNo}. Expected source_ref(s): ${expectedSourceRefList}.`)
    }
    if (titleNo !== expectedTitleNo) {
      throw new Error(`${contextLabel}: expected title_no ${expectedTitleNo}, got ${titleNo || "empty"}.`)
    }

    const expectedChildSources = expectedFunctionalChildren(expectedSource, state.allSections, state.skippedRefs, state.lookup)
    const isLeaf = expectedChildSources.length === 0
    const baseTitle = appendFunctionalRequirementSuffix(expectedSource.title)
    const markerMatches = title.match(FUNCTIONAL_TR_MARKER_RE) || []

    if (isLeaf) {
      state.leafCount += 1
      if (!trCode) {
        throw new Error(`${titleNo}: leaf node must include tr_code.`)
      }
      if (!FUNCTIONAL_TR_CODE_RE.test(trCode)) {
        throw new Error(`${titleNo}: tr_code ${trCode} must match TR-GN-[A-Za-z0-9]+.`)
      }
      if (markerMatches.length !== 1 || !title.includes(`[${trCode}]`)) {
        throw new Error(`${titleNo}: leaf title must contain exactly one [${trCode}] marker matching tr_code.`)
      }
      const expectedTitle = `${baseTitle}[${trCode}]`
      if (normalizeTitleForCompare(title) !== normalizeTitleForCompare(expectedTitle)) {
        throw new Error(`${titleNo}: title must preserve source title and append suffix/TR marker. Expected "${expectedTitle}", got "${title}".`)
      }
      const previousTitleNo = state.trCodes.get(trCode)
      if (previousTitleNo) {
        throw new Error(`${titleNo}: duplicate tr_code ${trCode}; also used at ${previousTitleNo}. Ask the model to generate a more specific abbreviation.`)
      }
      state.trCodes.set(trCode, titleNo)
    } else {
      if (trCode) {
        throw new Error(`${titleNo}: non-leaf node must not include tr_code.`)
      }
      if (markerMatches.length > 0) {
        throw new Error(`${titleNo}: non-leaf node must not include [TR-GN-xxx] in title.`)
      }
      if (normalizeTitleForCompare(title) !== normalizeTitleForCompare(baseTitle)) {
        throw new Error(`${titleNo}: title must preserve source title and append suffix. Expected "${baseTitle}", got "${title}".`)
      }
    }

    validateFunctionalTitleTreeChildren(children, expectedChildSources, titleNo, state)
  }
}

function finalizeFunctionalTitleTree(raw: FunctionalTitleTreeRawArtifact, manifest: SourceArtifactsManifest): FunctionalTitleTreeArtifact {
  const sections = readSourceSectionsInOrder(manifest)
  const roots = sections.filter(section => section.source_ref === raw.functional_root_source_ref)
  const titleRoots = sections.filter(section => section.title === raw.root_title)
  const root = roots.length === 1 ? roots[0] : titleRoots.length === 1 ? titleRoots[0] : undefined
  const codes = new Set<string>()
  const skipped = new Set(raw.skipped_source_refs || [])
  const visit = (parent: SourceSectionEntry, nodes: FunctionalTitleTreeNode[], prefix: string): FunctionalTitleTreeNode[] => {
    const expected = sections.filter(section => isDirectChildSection(parent, section) && !skipped.has(section.source_ref))
    for (const node of nodes) {
      if (!expected.some(source => source.source_ref === node.source_ref || appendFunctionalRequirementSuffix(source.title) === normalizeTitleForCompare(textOf(node.title)).replace(FUNCTIONAL_TR_MARKER_RE, ""))) {
        phase2Warning(`跳过无法归属的功能标题 ${node.title || node.source_ref}`, 1)
      }
    }
    const nodeOrder = new Map(nodes.map((node, index) => [node.source_ref, index]))
    expected.sort((a, b) => (nodeOrder.get(a.source_ref) ?? Number.MAX_SAFE_INTEGER) - (nodeOrder.get(b.source_ref) ?? Number.MAX_SAFE_INTEGER))
    return expected.map((source, index) => {
      const matches = nodes.filter(node => node.source_ref === source.source_ref)
      const titleMatches = nodes.filter(node => normalizeTitleForCompare(textOf(node.title)).replace(FUNCTIONAL_TR_MARKER_RE, "") === appendFunctionalRequirementSuffix(source.title))
      const node = matches.length === 1 ? matches[0] : titleMatches.length === 1 ? titleMatches[0] : undefined
      const titleNo = `${prefix}.${index + 1}`
      const children = visit(source, node?.children || [], titleNo)
      let code = textOf(node?.tr_code)
      if (!children.length) {
        if (!FUNCTIONAL_TR_CODE_RE.test(code) || codes.has(code)) code = `TR-GN-AUTO${titleNo.replaceAll(".", "")}`
        while (codes.has(code)) code += "X"
        codes.add(code)
      }
      return { title_no: titleNo, title: appendFunctionalRequirementSuffix(source.title) + (children.length ? "" : `[${code}]`),
        source_ref: source.source_ref, ...(children.length ? {} : { tr_code: code }), children }
    })
  }
  if (!root) phase2Warning("无法定位功能根：功能测试内容未生成", 1)
  const sourceChildren = root ? visit(root, raw.children || [], "4.1") : []
  const children = root ? ensureInitializationFunctionalNode(sourceChildren, root.source_ref) : []
  return { chapter_title_no: "4", chapter_title: "测试类型说明", section_title_no: "4.1", section_title: "功能测试",
    functional_root_source_ref: root?.source_ref || "", root_title: root?.title || "内容未生成", children,
    skipped_source_refs: (raw.skipped_source_refs || []).filter(ref => sections.some(section => section.source_ref === ref)),
    routing: deriveFunctionalTitleTreeRouting(children) }
}

function functionalTitleTreeArtifactToRaw(model: FunctionalTitleTreeArtifact): FunctionalTitleTreeRawArtifact {
  return {
    functional_root_source_ref: textOf(model.functional_root_source_ref),
    root_title: textOf(model.root_title),
    routing: model.routing,
    children: Array.isArray(model.children) ? model.children : [],
    skipped_source_refs: Array.isArray(model.skipped_source_refs) ? model.skipped_source_refs : [],
  }
}

function reusableFunctionalTitleTreeArtifact(
  path: string,
  manifest: SourceArtifactsManifest,
): FunctionalTitleTreeArtifact | undefined {
  if (!existsSync(path)) return undefined
  try {
    const existing = readJson<FunctionalTitleTreeArtifact>(path)
    const raw = referenceDefaults(functionalTitleTreeArtifactToRaw(existing))
    if (!validateFunctionalTitleTreeRawSchema(raw)) return undefined
    return finalizeFunctionalTitleTree(raw as FunctionalTitleTreeRawArtifact, manifest)
  } catch {
    return undefined
  }
}

function countFunctionalTitleTreeNodes(nodes: FunctionalTitleTreeNode[]): { nodeCount: number; leafCount: number } {
  let nodeCount = 0
  let leafCount = 0
  const visit = (node: FunctionalTitleTreeNode) => {
    nodeCount += 1
    const children = Array.isArray(node.children) ? node.children : []
    if (children.length === 0) leafCount += 1
    for (const child of children) visit(child)
  }
  for (const node of nodes) visit(node)
  return { nodeCount, leafCount }
}

function markdownHeadingLevel(titleNo: string): number {
  return Math.min(6, Math.max(2, titleNo.split(".").length + 1))
}

function renderFunctionalTitleTreeMarkdown(model: FunctionalTitleTreeArtifact): string {
  const lines: string[] = [
    "# 功能测试标题树",
    "",
    `功能需求根章节：${model.functional_root_source_ref} ${model.root_title}`,
    "",
    `初始化路由：${model.routing.has_initialization ? `${model.routing.initialization_title_no} ${model.routing.initialization_source_ref}` : "无"}`,
    "",
    `## ${model.chapter_title_no} ${model.chapter_title}`,
    "",
    `### ${model.section_title_no} ${model.section_title}`,
    "",
  ]

  const renderNode = (node: FunctionalTitleTreeNode) => {
    const titleNo = textOf(node.title_no)
    const title = textOf(node.title)
    const sourceRef = textOf(node.source_ref)
    const level = markdownHeadingLevel(titleNo)
    lines.push(`${"#".repeat(level)} ${titleNo} ${title}`)
    lines.push("")
    lines.push(`来源：${sourceRef}`)
    lines.push("")
    for (const child of Array.isArray(node.children) ? node.children : []) {
      renderNode(child)
    }
  }

  for (const child of model.children) {
    renderNode(child)
  }

  if (model.skipped_source_refs.length > 0) {
    lines.push("## 跳过的源章节")
    lines.push("")
    for (const sourceRef of model.skipped_source_refs) {
      lines.push(`- ${sourceRef}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd() + "\n"
}

const FUNCTIONAL_INIT_TABLE_COLUMNS = ["名称", "地址/寄存器地址", "初值", "初值含义"]
const functionalInitContentAjv = new Ajv({ allErrors: true, useDefaults: true })

const functionalInitContentRawSchema = {
  type: "object",
  required: ["section_title_no", "section_title", "allow_code", "items", "skipped_title_refs", "open_questions"],
  additionalProperties: false,
  properties: {
    section_title_no: { type: "string", minLength: 1 },
    section_title: { type: "string", minLength: 1 },
    allow_code: { type: "boolean" },
    items: {
      type: "array",
      items: { $ref: "#/$defs/item" },
    },
    skipped_title_refs: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    open_questions: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
  $defs: {
    item: {
      type: "object",
      required: ["title_no", "title", "tr_code", "source_ref", "summary", "input_flow", "processing", "output_flow", "tables"],
      additionalProperties: false,
      properties: {
        title_no: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        tr_code: { type: "string", minLength: 1 },
        source_ref: { type: "string", minLength: 1 },
        summary: { type: "string" },
        input_flow: {
          type: "array",
          items: { type: "string" },
        },
        processing: {
          type: "array",
          items: { $ref: "#/$defs/processingItem" },
        },
        output_flow: {
          type: "array",
          items: { type: "string" },
        },
        tables: {
          type: "array",
          items: { $ref: "#/$defs/table" },
        },
      },
    },
    processingItem: {
      type: "object",
      required: ["requirement_id", "source_refs", "content", "table_refs"],
      additionalProperties: false,
      properties: {
        requirement_id: { type: "string", minLength: 1 },
        source_refs: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^(?:primary|supporting-[^:]+)::[^:]+$" },
          contains: { type: "string", pattern: "^primary::[^:]+$" },
        },
        content: { type: "string", minLength: 1 },
        table_refs: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    table: {
      type: "object",
      required: ["table_id", "title", "columns", "rows"],
      additionalProperties: false,
      properties: {
        table_id: { type: "string", minLength: 1 },
        title: { type: "string" },
        columns: {
          type: "array",
          items: { type: "string" },
        },
        rows: {
          type: "array",
          items: { $ref: "#/$defs/row" },
        },
      },
    },
    row: {
      type: "object",
      required: ["名称", "地址/寄存器地址", "初值", "初值含义"],
      additionalProperties: false,
      properties: {
        "名称": { type: "string" },
        "地址/寄存器地址": { type: "string" },
        "初值": { type: "string" },
        "初值含义": { type: "string" },
      },
    },
  },
}

const validateFunctionalInitContentRawSchema = functionalInitContentAjv.compile(relaxedReferenceSchema(functionalInitContentRawSchema))

function readFunctionalInitContentRawArtifact(path: string): FunctionalInitContentRawArtifact {
  const readResult = readJsonWithSimpleRepair(path)
  if (!validateFunctionalInitContentRawSchema(readResult.value)) {
    throw new Error([
      `${path}: functional init content raw artifact does not match the JSON schema.`,
      formatAjvErrors(validateFunctionalInitContentRawSchema.errors),
      "Repair hint: rerun functional-init-content-modeler or ask the model to repair only the JSON structure.",
    ].filter(Boolean).join("\n"))
  }
  if (readResult.repaired) {
    writeJson(path, readResult.value)
  }
  return trackRaw(readResult.value, path) as FunctionalInitContentRawArtifact
}

function findFunctionalInitSection(titleTree: FunctionalTitleTreeArtifact): FunctionalTitleTreeNode | undefined {
  const routing = normalizeFunctionalTitleTreeRouting(titleTree)
  if (!routing.has_initialization || !routing.initialization_title_no) {
    return undefined
  }
  const findByTitleNo = (nodes: FunctionalTitleTreeNode[]): FunctionalTitleTreeNode | undefined => {
    for (const node of nodes) {
      if (textOf(node.title_no) === routing.initialization_title_no) return node
      const found = findByTitleNo(Array.isArray(node.children) ? node.children : [])
      if (found) return found
    }
    return undefined
  }
  const initSection = findByTitleNo(Array.isArray(titleTree.children) ? titleTree.children : [])
  if (!initSection) {
    throw new Error(`functional-test-title-tree.json routing points to missing initialization section ${routing.initialization_title_no}.`)
  }
  return initSection
}

function collectFunctionalLeafNodes(node: FunctionalTitleTreeNode): FunctionalTitleTreeNode[] {
  const children = Array.isArray(node.children) ? node.children : []
  if (children.length === 0) return [node]
  return children.flatMap((child) => collectFunctionalLeafNodes(child))
}

function validateFunctionalInitTable(table: FunctionalInitContentTable, contextLabel: string) {
  const columns = Array.isArray(table.columns) ? table.columns.map((column) => textOf(column)) : []
  if (columns.length !== FUNCTIONAL_INIT_TABLE_COLUMNS.length) {
    throw new Error(`${contextLabel}: columns must be exactly ${FUNCTIONAL_INIT_TABLE_COLUMNS.join(", ")}.`)
  }
  for (const [index, expected] of FUNCTIONAL_INIT_TABLE_COLUMNS.entries()) {
    if (columns[index] !== expected) {
      throw new Error(`${contextLabel}: columns must be exactly ${FUNCTIONAL_INIT_TABLE_COLUMNS.join(", ")}.`)
    }
  }

  for (const [rowIndex, row] of (Array.isArray(table.rows) ? table.rows : []).entries()) {
    if (textOf(row["地址/寄存器地址"]) === "不适用") {
      throw new Error(`${contextLabel} row ${rowIndex + 1}: 地址/寄存器地址 must not be 不适用.`)
    }
  }
}

function normalizeFunctionalFlow(values: string[] | undefined, fallback: string[]): string[] {
  const normalized = Array.isArray(values)
    ? values.map((value) => textOf(value)).filter(Boolean)
    : []
  return normalized.length > 0 ? normalized : fallback
}

function summarizeFunctionalInitObjects(item: FunctionalInitContentItem): string {
  const names: string[] = []
  for (const table of Array.isArray(item.tables) ? item.tables : []) {
    for (const row of Array.isArray(table.rows) ? table.rows : []) {
      const name = textOf(row["名称"])
      if (name && !names.includes(name)) names.push(name)
    }
  }
  if (names.length > 0) return names.join("、")
  return textOf(item.title) || "初始化对象"
}

function assignFunctionalInitTableNumbers(item: FunctionalInitContentItem, contextLabel: string): FunctionalInitContentItem {
  return normalizeLocalTables(item, true)
}

function normalizeFunctionalInitItem(item: FunctionalInitContentItem, trCode: string): FunctionalInitContentItem {
  if (!Array.isArray(item.processing) || item.processing.length === 0) {
    throw new Error(`${trCode}: processing is required; rerun functional-init-content-modeler to regenerate this raw artifact with source_refs.`)
  }
  const outputFallback = [`${summarizeFunctionalInitObjects(item)}初始化状态。`]
  const normalized: FunctionalInitContentItem = {
    ...item,
    input_flow: normalizeFunctionalFlow(item.input_flow, ["无。"]),
    processing: item.processing,
    output_flow: normalizeFunctionalFlow(item.output_flow, outputFallback),
  }
  return normalized
}

function normalizeFunctionalItems<T extends FunctionalLeafContentItem>(rawItems: T[], leaves: FunctionalTitleTreeNode[], initialization = false): T[] {
  const used = new Set<T>()
  const assignments = new Map<FunctionalTitleTreeNode, T[]>()
  for (const item of rawItems) {
    if (leaves.length === 1 && rawItems.length === 1) { assignments.set(leaves[0], [item]); continue }
    const targets = new Set<FunctionalTitleTreeNode>()
    for (const key of ["title_no", "tr_code", "source_ref", "title"] as const) {
      if (!textOf(item[key])) continue
      const matches = leaves.filter(leaf => textOf(leaf[key]) === textOf(item[key]))
      if (matches.length === 1) targets.add(matches[0])
    }
    if (targets.size === 1) {
      const target = [...targets][0]
      assignments.set(target, [...(assignments.get(target) || []), item])
    }
  }
  const items = leaves.map(leaf => {
    const candidates = assignments.get(leaf) || []
    const match = candidates.length === 1 ? candidates[0] : undefined
    if (match) used.add(match)
    else phase2Warning(`${leaf.title_no}: 内容未生成`)
    if (match && (textOf(match.title_no) !== textOf(leaf.title_no) || textOf(match.title) !== textOf(leaf.title) || textOf(match.tr_code) !== textOf(leaf.tr_code) || textOf(match.source_ref) !== textOf(leaf.source_ref))) {
      phase2Warning(`${leaf.title_no}: 已按当前任务回填功能项身份`)
    }
    const item = { ...(match || { summary: "内容未生成", input_flow: [], processing: [], output_flow: [], tables: [] }),
      title_no: leaf.title_no, title: leaf.title, tr_code: leaf.tr_code, source_ref: leaf.source_ref }
    if (initialization && match && !item.input_flow?.length) item.input_flow = ["无。"]
    return normalizeLocalTables({ ...item, processing: assignStableRequirementIds(item.processing || [], textOf(leaf.tr_code)) }, initialization) as T
  })
  for (const item of rawItems) if (!used.has(item)) phase2Warning(`跳过无法唯一归属的功能内容 ${item.title_no || item.title}`, 1)
  return items
}

function finalizeFunctionalInitContent(raw: FunctionalInitContentRawArtifact, titleTree: FunctionalTitleTreeArtifact, manifest: SourceArtifactsManifest): FunctionalInitContentArtifact {
  const section = findFunctionalInitSection(titleTree)!
  return {
    chapter_title_no: "4", chapter_title: "测试类型说明", parent_section_title_no: "4.1", parent_section_title: "功能测试",
    section_title_no: textOf(section.title_no), section_title: textOf(section.title), allow_code: raw.allow_code === true,
    items: normalizeFunctionalItems(raw.items || [], collectFunctionalLeafNodes(section), true),
    skipped_title_refs: resolveSourceRefs(buildSourceSectionLookup(manifest), raw.skipped_title_refs, "skipped_title_refs").map(section => section.source_ref),
    open_questions: raw.open_questions || [],
  }
}

function canReuseFunctionalInitContentRawArtifact(path: string, titleTree: FunctionalTitleTreeArtifact, manifest: SourceArtifactsManifest, allowCode: boolean): boolean {
  if (!existsSync(path)) return false
  try {
    const raw = readFunctionalInitContentRawArtifact(path)
    const section = findFunctionalInitSection(titleTree)
    if (!section || raw.allow_code !== allowCode) return false
    const leaves = collectFunctionalLeafNodes(section)
    const syntheticInitialization = leaves.some((leaf) => textOf(leaf.tr_code) === "TR-GN-Init")
    if (!syntheticInitialization) {
      finalizeFunctionalInitContent(raw, titleTree, manifest)
      return true
    }
    if (textOf(raw.section_title_no) !== textOf(section.title_no) || textOf(raw.section_title) !== textOf(section.title)) return false
    if ((raw.items || []).length !== leaves.length) return false
    const exactIdentity = leaves.every((leaf) => (raw.items || []).some((item) =>
      textOf(item.title_no) === textOf(leaf.title_no)
      && textOf(item.title) === textOf(leaf.title)
      && textOf(item.tr_code) === textOf(leaf.tr_code)
      && textOf(item.source_ref) === textOf(leaf.source_ref)))
    if (!exactIdentity) return false
    finalizeFunctionalInitContent(raw, titleTree, manifest)
    return true
  } catch {
    return false
  }
}

const functionalOtherContentAjv = new Ajv({ allErrors: true, useDefaults: true })

const functionalOtherContentRawSchema = {
  type: "object",
  required: ["section_title_no", "section_title", "excluded_title_nos", "items", "skipped_title_refs", "open_questions"],
  additionalProperties: false,
  properties: {
    section_title_no: { const: "4.1" },
    section_title: { const: "功能测试" },
    excluded_title_nos: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    items: {
      type: "array",
      items: { $ref: "#/$defs/item" },
    },
    skipped_title_refs: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    open_questions: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
  $defs: {
    item: {
      type: "object",
      required: ["title_no", "title", "tr_code", "source_ref", "summary", "input_flow", "processing", "output_flow", "tables"],
      additionalProperties: false,
      properties: {
        title_no: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        tr_code: { type: "string", minLength: 1 },
        source_ref: { type: "string", minLength: 1 },
        summary: { type: "string" },
        input_flow: {
          type: "array",
          items: { type: "string" },
        },
        processing: {
          type: "array",
          items: { $ref: "#/$defs/processingItem" },
        },
        output_flow: {
          type: "array",
          items: { type: "string" },
        },
        tables: {
          type: "array",
          items: { $ref: "#/$defs/table" },
        },
      },
    },
    processingItem: {
      type: "object",
      required: ["requirement_id", "source_refs", "content", "table_refs"],
      additionalProperties: false,
      properties: {
        requirement_id: { type: "string", minLength: 1 },
        source_refs: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^(?:primary|supporting-[^:]+)::[^:]+$" },
          contains: { type: "string", pattern: "^primary::[^:]+$" },
        },
        content: { type: "string", minLength: 1 },
        table_refs: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    table: {
      type: "object",
      required: ["table_id", "title", "columns", "rows"],
      additionalProperties: false,
      properties: {
        table_id: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        columns: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
  },
}

const validateFunctionalOtherContentRawSchema = functionalOtherContentAjv.compile(relaxedReferenceSchema(functionalOtherContentRawSchema))

function readFunctionalOtherContentRawArtifact(path: string): FunctionalOtherContentRawArtifact {
  const readResult = readJsonWithSimpleRepair(path)
  if (!validateFunctionalOtherContentRawSchema(readResult.value)) {
    throw new Error([
      `${path}: functional other content raw artifact does not match the JSON schema.`,
      formatAjvErrors(validateFunctionalOtherContentRawSchema.errors),
      "Repair hint: rerun functional-other-content-modeler or ask the model to repair only the JSON structure.",
    ].filter(Boolean).join("\n"))
  }
  if (readResult.repaired) {
    writeJson(path, readResult.value)
  }
  return trackRaw(readResult.value, path) as FunctionalOtherContentRawArtifact
}

function mergeFunctionalOtherLeafRawArtifacts(paths: string[], titleTree: FunctionalTitleTreeArtifact): FunctionalOtherContentRawArtifact {
  const excluded = expectedFunctionalOtherExclusions(titleTree)
  const leaves = collectFunctionalOtherLeafNodes(titleTree, excluded)
  const items: FunctionalOtherContentItem[] = [], skipped: string[] = [], questions: string[] = []
  for (const [index, path] of paths.entries()) {
    if (!existsSync(path)) throw new Error(`functional_other_content_raw_paths[${index}]: File not found: ${path}`)
    const targetLeaf = leaves[index]
    let raw: FunctionalOtherContentRawArtifact
    try {
      raw = readFunctionalOtherContentRawArtifact(path)
    } catch (error) {
      const target = targetLeaf
        ? `target_leaf=${textOf(targetLeaf.title_no)} ${textOf(targetLeaf.title)}`
        : "target_leaf=<unresolved>"
      throw new Error(`functional_other_content_raw_paths[${index}] (${target}) failed: ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!targetLeaf) { phase2Warning(`跳过无目标批次 ${path}`, 1); continue }
    items.push(...normalizeFunctionalItems(raw.items || [], [targetLeaf]))
    skipped.push(...(raw.skipped_title_refs || [])); questions.push(...(raw.open_questions || []))
  }
  return { section_title_no: "4.1", section_title: "功能测试", excluded_title_nos: excluded, items, skipped_title_refs: skipped, open_questions: questions }
}

function canReuseFunctionalOtherLeafRawArtifact(path: string, expectedExcludedTitleNos: string[], expectedLeaf: FunctionalOtherTargetLeaf): boolean {
  if (!existsSync(path)) return false
  try { readFunctionalOtherContentRawArtifact(path); return true } catch { return false }
}

function isTitleNoUnder(titleNo: string, parentTitleNo: string): boolean {
  return titleNo === parentTitleNo || titleNo.startsWith(`${parentTitleNo}.`)
}

function collectFunctionalOtherLeafNodes(titleTree: FunctionalTitleTreeArtifact, excludedTitleNos: string[]): FunctionalTitleTreeNode[] {
  const leaves: FunctionalTitleTreeNode[] = []
  const visit = (node: FunctionalTitleTreeNode) => {
    const titleNo = textOf(node.title_no)
    if (excludedTitleNos.some((excluded) => isTitleNoUnder(titleNo, excluded))) {
      return
    }
    const children = Array.isArray(node.children) ? node.children : []
    if (children.length === 0) {
      leaves.push(node)
      return
    }
    for (const child of children) visit(child)
  }
  for (const child of Array.isArray(titleTree.children) ? titleTree.children : []) {
    visit(child)
  }
  return leaves
}

function validateFunctionalOtherProcessingIds(item: Pick<FunctionalOtherContentItem, "processing">, trCode: string, contextLabel: string) {
  item.processing = assignStableRequirementIds(item.processing || [], trCode)
}

function finalizeFunctionalOtherContent(raw: FunctionalOtherContentRawArtifact, titleTree: FunctionalTitleTreeArtifact, manifest: SourceArtifactsManifest, rawPaths: string[] = []): FunctionalOtherContentArtifact {
  const excluded = expectedFunctionalOtherExclusions(titleTree)
  return {
    chapter_title_no: "4", chapter_title: "测试类型说明", section_title_no: "4.1", section_title: "功能测试",
    excluded_title_nos: excluded,
    items: normalizeFunctionalItems(raw.items || [], collectFunctionalOtherLeafNodes(titleTree, excluded)),
    skipped_title_refs: resolveSourceRefs(buildSourceSectionLookup(manifest), raw.skipped_title_refs, "skipped_title_refs").map(section => section.source_ref),
    open_questions: raw.open_questions || [],
  }
}

type FunctionalLeafContentItem = FunctionalInitContentItem | FunctionalOtherContentItem

function withoutLegacyFunctionalFields<T extends FunctionalLeafContentItem>(item: T): T {
  return { ...item }
}

function mapFunctionalContentItems<T extends FunctionalLeafContentItem>(items: T[], expectedLeaves: FunctionalTitleTreeNode[], contextLabel: string): Map<string, T> {
  return new Map(normalizeFunctionalItems(items, expectedLeaves).map(item => [textOf(item.title_no), item]))
}

function expectedFunctionalOtherExclusions(titleTree: FunctionalTitleTreeArtifact): string[] {
  const routing = normalizeFunctionalTitleTreeRouting(titleTree)
  return routing.has_initialization && routing.initialization_title_no
    ? [routing.initialization_title_no]
    : []
}

function validateFunctionalOtherExclusions(model: FunctionalOtherContentArtifact, expectedExcludedTitleNos: string[]) {
  const actual = Array.isArray(model.excluded_title_nos) ? model.excluded_title_nos.map((titleNo) => textOf(titleNo)).filter(Boolean) : []
  if (actual.length !== expectedExcludedTitleNos.length || actual.some((titleNo, index) => titleNo !== expectedExcludedTitleNos[index])) {
    throw new Error(`functional-other-content.json excluded_title_nos must be ${JSON.stringify(expectedExcludedTitleNos)}, got ${JSON.stringify(actual)}.`)
  }
}

function buildFunctionalTestContentNode(
  node: FunctionalTitleTreeNode,
  routing: Required<FunctionalTitleTreeRouting>,
  initItems: Map<string, FunctionalInitContentItem>,
  otherItems: Map<string, FunctionalOtherContentItem>,
): FunctionalTestContentNode {
  const titleNo = textOf(node.title_no)
  const trCode = textOf(node.tr_code)
  const children = Array.isArray(node.children) ? node.children : []
  const merged: FunctionalTestContentNode = {
    title_no: titleNo,
    title: textOf(node.title),
    source_ref: textOf(node.source_ref),
    ...(trCode ? { tr_code: trCode } : {}),
    children: children.map((child) => buildFunctionalTestContentNode(child, routing, initItems, otherItems)),
  }

  if (children.length > 0) {
    merged.content_type = null
    return merged
  }

  const initTitleNo = routing.initialization_title_no || ""
  const isInitializationLeaf = routing.has_initialization && initTitleNo && isTitleNoUnder(titleNo, initTitleNo)
  if (isInitializationLeaf) {
    const item = initItems.get(titleNo)
    if (!item) {
      throw new Error(`functional-test-content: missing initialization content for ${titleNo}.`)
    }
    merged.content_type = "initialization"
    merged.init_content = item
    return merged
  }

  const item = otherItems.get(titleNo)
  if (!item) {
    throw new Error(`functional-test-content: missing other functional content for ${titleNo}.`)
  }
  merged.content_type = "other"
  merged.other_content = item
  return merged
}

function buildFunctionalTestContentArtifact(
  titleTree: FunctionalTitleTreeArtifact,
  otherContent: FunctionalOtherContentArtifact,
  paths: {
    functionalTitleTreePath: string
    functionalInitContentPath?: string
    functionalOtherContentPath: string
  },
  initContent?: FunctionalInitContentArtifact,
): FunctionalTestContentArtifact {
  const routing = normalizeFunctionalTitleTreeRouting(titleTree)
  if (!routing.has_initialization || !routing.initialization_title_no) {
    throw new Error("functional-test-content: finalized functional title tree must contain the required initialization node.")
  }
  const expectedExcludedTitleNos = expectedFunctionalOtherExclusions(titleTree)
  validateFunctionalOtherExclusions(otherContent, expectedExcludedTitleNos)

  const initSection = findFunctionalInitSection(titleTree)
  const initLeaves = initSection ? collectFunctionalLeafNodes(initSection) : []
  if (routing.has_initialization && !initContent) {
    throw new Error(`functional-test-content: ${routing.initialization_title_no} initialization content is required before assembling 4.1.`)
  }
  if (initContent && !routing.has_initialization) {
    throw new Error("functional-test-content: initialization content was provided, but functional title tree routing has has_initialization=false.")
  }
  if (initContent && initSection) {
    const sectionTitleNo = textOf(initContent.section_title_no)
    const sectionTitle = textOf(initContent.section_title)
    if (sectionTitleNo !== textOf(initSection.title_no)) {
      throw new Error(`functional-init-content.json section_title_no must be ${textOf(initSection.title_no)}, got ${sectionTitleNo || "empty"}.`)
    }
    if (normalizeTitleForCompare(sectionTitle) !== normalizeTitleForCompare(textOf(initSection.title))) {
      throw new Error("functional-init-content.json section_title must match the routed initialization title.")
    }
    initContent.items = initContent.items.map((item, index) => assignFunctionalInitTableNumbers(item, `functional-init-content.json.items[${index}]`))
  }

  const initItems = initContent
    ? mapFunctionalContentItems(initContent.items.map(withoutLegacyFunctionalFields), initLeaves, "functional-init-content.json")
    : new Map<string, FunctionalInitContentItem>()
  const otherLeaves = collectFunctionalOtherLeafNodes(titleTree, expectedExcludedTitleNos)
  const otherItems = mapFunctionalContentItems(otherContent.items.map(withoutLegacyFunctionalFields), otherLeaves, "functional-other-content.json")

  return {
    chapter_title_no: "4",
    chapter_title: textOf(titleTree.chapter_title) || "测试类型说明",
    section_title_no: "4.1",
    section_title: textOf(titleTree.section_title) || "功能测试",
    routing,
    initialization_skipped: !routing.has_initialization,
    source_paths: {
      functional_title_tree_path: paths.functionalTitleTreePath,
      ...(initContent && paths.functionalInitContentPath ? { functional_init_content_path: paths.functionalInitContentPath } : {}),
      functional_other_content_path: paths.functionalOtherContentPath,
    },
    children: (Array.isArray(titleTree.children) ? titleTree.children : [])
      .map((child) => buildFunctionalTestContentNode(child, routing, initItems, otherItems)),
  }
}

function countFunctionalTestContent(model: FunctionalTestContentArtifact): {
  nodeCount: number
  leafCount: number
  initializationItemCount: number
  otherItemCount: number
  initializationTableCount: number
  processingCount: number
} {
  let nodeCount = 0
  let leafCount = 0
  let initializationItemCount = 0
  let otherItemCount = 0
  let initializationTableCount = 0
  let processingCount = 0

  const visit = (node: FunctionalTestContentNode) => {
    nodeCount += 1
    const children = Array.isArray(node.children) ? node.children : []
    if (children.length > 0) {
      for (const child of children) visit(child)
      return
    }
    leafCount += 1
    if (node.content_type === "initialization" && node.init_content) {
      initializationItemCount += 1
      initializationTableCount += Array.isArray(node.init_content.tables) ? node.init_content.tables.length : 0
      processingCount += Array.isArray(node.init_content.processing) ? node.init_content.processing.length : 0
    }
    if (node.content_type === "other" && node.other_content) {
      otherItemCount += 1
      processingCount += Array.isArray(node.other_content.processing) ? node.other_content.processing.length : 0
    }
  }

  for (const child of model.children) visit(child)
  return { nodeCount, leafCount, initializationItemCount, otherItemCount, initializationTableCount, processingCount }
}

function readSourcePlanArtifact(path: string): SourcePlanArtifact {
  const root = readJson<Record<string, unknown>>(path)
  if (!isRecord(root) || typeof root.primary_srs_path !== "string" || !root.primary_srs_path.trim() || (root.other_document_paths !== undefined && (!Array.isArray(root.other_document_paths) || root.other_document_paths.some(item => typeof item !== "string")))) throw new Error(`${path}: invalid source plan schema`)
  return {
    primary_srs_path: textOf(root.primary_srs_path),
    other_document_paths: Array.isArray(root.other_document_paths)
      ? root.other_document_paths.filter((item): item is string => typeof item === "string")
      : [],
  }
}

function validateSourcePlanAgainstCandidates(sourcePlan: SourcePlanArtifact, candidates: DocumentCandidatesArtifact) {
  const candidateMap = new Map(candidates.documents.map((candidate) => [candidate.file_path, candidate]))
  if (!sourcePlan.primary_srs_path) {
    throw new Error("source-plan.json is missing primary_srs_path.")
  }
  const primary = candidateMap.get(sourcePlan.primary_srs_path)
  if (!primary) {
    throw new Error(`primary_srs_path is not present in candidate manifest: ${sourcePlan.primary_srs_path}`)
  }

  const seen = new Set<string>()
  seen.add(sourcePlan.primary_srs_path)

  for (const path of sourcePlan.other_document_paths) {
    if (!candidateMap.has(path)) {
      throw new Error(`other_document_path is not present in candidate manifest: ${path}`)
    }
    if (seen.has(path)) {
      throw new Error(`source-plan path appears more than once: ${path}`)
    }
    seen.add(path)
  }
}

async function prepareDocumentArtifacts(
  ctx: ToolContext,
  filePath: string,
  role: PreparedDocumentRole,
  segmentsPath: string,
  tocPath: string,
  structurePath: string,
  tableAssetsDir: string,
  tableIdPrefix: string,
): Promise<PreparedSourceDocumentArtifact> {
  if (extname(filePath).toLowerCase() === ".doc") {
    throw new Error(`Phase 2 does not extract .doc files directly. Please convert to .docx first: ${filePath}`)
  }
  const format = toSupportedFormat(filePath) || undefined
  await invokeFilldataParser({
    mode: "extract",
    file_path: filePath,
    format,
    write_artifacts: true,
    segments_path: segmentsPath,
    toc_path: tocPath,
  }, ctx)

  const extracted = readJson<any>(segmentsPath)
  const diagnostics = writeDocumentStructureArtifacts(structurePath, buildDocumentStructureArtifact(filePath, extracted, {
    table_assets_dir: tableAssetsDir,
    table_id_prefix: tableIdPrefix,
    source_ref_prefix: tableIdPrefix,
  }))

  return {
    path: filePath,
    role,
    format: textOf(extracted.format) || textOf(format) || "text",
    segments_path: segmentsPath,
    toc_path: tocPath,
    structure_path: structurePath,
    structure_warnings_path: diagnostics.structure_warnings_path,
  }
}

async function executeDiscoverDocumentsMode(ctx: ToolContext) {
  try {
    const documentRootPath = resolveDocumentRootPath(ctx)
    const candidatesPath = defaultArtifactPath(ctx, "phase2-document-candidates.json")
    const sourcePlanPath = defaultArtifactPath(ctx, "source-plan.json")
    const paths = walkDocumentFiles(documentRootPath)
    const candidates: DocumentCandidate[] = paths.map((filePath) => ({
      file_path: filePath,
      file_name: parse(filePath).base,
    }))

    writeJson(candidatesPath, {
      documents: candidates,
    } satisfies DocumentCandidatesArtifact)

    if (existsSync(sourcePlanPath)) {
      try {
        const sourcePlan = readSourcePlanArtifact(sourcePlanPath)

        return JSON.stringify({
          ok: true,
          mode: "discover_documents",
          incremental_reuse: true,
          output: {
            candidates_path: candidatesPath,
            source_plan_path: sourcePlanPath,
            document_root_path: documentRootPath,
          },
          summary: {
            total_documents: candidates.length,
            document_root_path: documentRootPath,
            source_plan_reused: true,
          },
          reused_artifacts: [{ output_path: sourcePlanPath }],
        }, null, 2)
      } catch {
        // The existing plan is stale or malformed. Keep discovery deterministic and
        // ask source-planner to replace it using the freshly written candidates.
      }
    }

    return JSON.stringify({
      ok: true,
      mode: "discover_documents",
      output: {
        candidates_path: candidatesPath,
        source_plan_path: sourcePlanPath,
        document_root_path: documentRootPath,
      },
      summary: {
        total_documents: candidates.length,
        document_root_path: documentRootPath,
        source_plan_reused: false,
      },
      worker_payload: {
        worker_type: "source-planner",
        candidates_path: candidatesPath,
        output_path: sourcePlanPath,
      },
      subagent_type: "source-planner",
      worker_prompt: buildSourcePlannerWorkerPrompt({
        worker_type: "source-planner",
        candidates_path: candidatesPath,
        output_path: sourcePlanPath,
      }),
    }, null, 2)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

async function executePrepareDocumentArtifactsMode(ctx: ToolContext) {
  const candidatesPath = defaultArtifactPath(ctx, "phase2-document-candidates.json")
  const sourcePlanPath = defaultArtifactPath(ctx, "source-plan.json")
  const segmentsPath = defaultArtifactPath(ctx, "req-segments.json")
  const tocPath = defaultArtifactPath(ctx, "req-segments-toc.json")
  const primaryStructurePath = defaultArtifactPath(ctx, "req-document-structure.json")
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const documentQualityReportPath = defaultReportPath(ctx, "document-quality-report.md")
  const primaryTableAssetsDir = join(dirname(primaryStructurePath), "source-tables", "primary")
  const supportingSourcesDir = join(getBaseDirectory(ctx), ".matrix", "data", "supporting-sources")

  if (!existsSync(candidatesPath)) {
    return JSON.stringify({ error: `File not found: ${candidatesPath}` })
  }
  if (!existsSync(sourcePlanPath)) {
    return JSON.stringify({ error: `File not found: ${sourcePlanPath}` })
  }

  try {
    const candidates = readJson<DocumentCandidatesArtifact>(candidatesPath)
    const sourcePlan = readSourcePlanArtifact(sourcePlanPath)
    validateSourcePlanAgainstCandidates(sourcePlan, candidates)

    const primaryDocument = await prepareDocumentArtifacts(
      ctx,
      sourcePlan.primary_srs_path,
      "primary_srs",
      segmentsPath,
      tocPath,
      primaryStructurePath,
      primaryTableAssetsDir,
      "primary",
    )

    mkdirSync(supportingSourcesDir, { recursive: true })
    const supportingDocuments: PreparedSourceDocumentArtifact[] = []

    for (const [index, documentPath] of sourcePlan.other_document_paths.entries()) {
      const prefix = `${String(index + 1).padStart(3, "0")}-${slugifyName(documentPath)}`
      const docDir = join(supportingSourcesDir, prefix)
      const prepared = await prepareDocumentArtifacts(
        ctx,
        documentPath,
        "other_document",
        join(docDir, "req-segments.json"),
        join(docDir, "req-segments-toc.json"),
        join(docDir, "document-structure.json"),
        join(docDir, "source-tables"),
        `supporting-${prefix}`,
      )
      supportingDocuments.push(prepared)
    }

    const manifest: SourceArtifactsManifest = {
      source_plan_path: sourcePlanPath,
      document_quality_report_path: documentQualityReportPath,
      primary_document: primaryDocument,
      supporting_documents: supportingDocuments,
    }
    writeJson(sourceArtifactsPath, manifest)
    writeDocumentQualityReport([
      {
        path: primaryDocument.path,
        role: primaryDocument.role,
        format: primaryDocument.format,
      },
      ...supportingDocuments.map((document) => ({
        path: document.path,
        role: document.role,
        format: document.format,
      })),
    ], documentQualityReportPath)
    const structureWarningCount = [primaryDocument, ...supportingDocuments].reduce((sum, document) => {
      const diagnostics = readJson<{ warning_count: number }>(document.structure_warnings_path!)
      return sum + diagnostics.warning_count
    }, 0)
    return JSON.stringify({
      ok: true,
      mode: "prepare_document_artifacts",
      output: {
        source_artifacts_path: sourceArtifactsPath,
        document_quality_report_path: documentQualityReportPath,
      },
      summary: { structure_warning_count: structureWarningCount },
    }, null, 2)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

function assertSourceArtifactsManifest(value: unknown, sourcePath: string): asserts value is SourceArtifactsManifest {
  const manifest = value as Partial<SourceArtifactsManifest> | null
  if (!manifest || typeof manifest !== "object"
    || !manifest.primary_document || typeof manifest.primary_document !== "object"
    || typeof manifest.primary_document.path !== "string"
    || typeof manifest.primary_document.structure_path !== "string"
    || !Array.isArray(manifest.supporting_documents)) {
    throw new Error(`Invalid source artifacts manifest: ${sourcePath}`)
  }
}

function assignFunctionalOtherTableNumbers(item: FunctionalOtherContentItem, contextLabel: string): FunctionalOtherContentItem {
  return normalizeLocalTables(item)
}

async function executeDiscoverHardwareInterfaceCandidatesMode(ctx: ToolContext) {
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const candidatesPath = defaultHardwareInterfaceCandidatesPath(ctx)
  if (!existsSync(sourceArtifactsPath)) return JSON.stringify({ error: `File not found: ${sourceArtifactsPath}`, missing_prerequisite: "source_artifacts" })
  try {
    const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
    assertSourceArtifactsManifest(manifest, sourceArtifactsPath)
    refreshSourceArtifactStructures(manifest, sourceArtifactsPath)
    const reusableArtifact = reusableHardwareInterfaceCandidatesArtifact(candidatesPath, sourceArtifactsPath, manifest)
    if (reusableArtifact) {
      return JSON.stringify({
        ok: true,
        mode: "discover_hardware_interface_candidates",
        incremental_reuse: true,
        output: { source_artifacts_path: sourceArtifactsPath, hardware_interface_candidates_path: candidatesPath },
        summary: { candidate_count: reusableArtifact.candidates.length, raw_reused: true },
        reused_artifacts: [{ output_path: candidatesPath }],
      }, null, 2)
    }
    return JSON.stringify({
      ok: true,
      mode: "discover_hardware_interface_candidates",
      output: { source_artifacts_path: sourceArtifactsPath, hardware_interface_candidates_path: candidatesPath },
      summary: { candidate_count: 0, raw_reused: false },
      discovery_batch: buildHardwareInterfaceDiscoveryBatch(sourceArtifactsPath, candidatesPath),
    }, null, 2)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

async function executePrepareHardwareInterfaceBatchesMode(ctx: ToolContext) {
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const candidatesPath = defaultHardwareInterfaceCandidatesPath(ctx)
  const blocksDir = defaultGenericHardwareInterfaceBlocksDir(ctx)
  const modelRawPath = defaultArtifactPath(ctx, "hardware-interface-model.raw.json")
  const modelPath = defaultArtifactPath(ctx, "hardware-interface-model.json")
  if (!existsSync(sourceArtifactsPath)) return JSON.stringify({ ok: false, error: `File not found: ${sourceArtifactsPath}`, error_code: "SOURCE_ARTIFACTS_NOT_FOUND", retryable: false, missing_prerequisite: "source_artifacts" })
  if (!existsSync(candidatesPath)) return JSON.stringify({ ok: false, error: `File not found: ${candidatesPath}`, error_code: "HARDWARE_INTERFACE_CANDIDATES_NOT_FOUND", retryable: false })
  try {
    const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
    assertSourceArtifactsManifest(manifest, sourceArtifactsPath)
    refreshSourceArtifactStructures(manifest, sourceArtifactsPath)
    const originalArtifact = normalizeHardwareInterfaceCandidates(candidatesPath, manifest)
    const classificationResults = originalArtifact.candidates.map((candidate) => classifyHardwareInterfaceCandidate(candidate, manifest))
    const classificationRepairs = classificationResults.flatMap((result) => result.repair ? [result.repair] : [])
    const warnings: HardwareInterfaceClassificationWarning[] = classificationResults.flatMap((result) => result.warning ? [result.warning] : [])
    let artifact: HardwareInterfaceCandidatesArtifact = {
      ...originalArtifact,
      candidates: classificationResults.map((result) => result.candidate),
    }
    let degradedCandidateCount = 0
    if (classificationRepairs.length > 0) {
      try {
        persistHardwareInterfaceClassification(candidatesPath, artifact, classificationRepairs, ctx, manifest)
      } catch (error) {
        try { writeJsonAtomic(candidatesPath, originalArtifact) } catch { /* keep running with the in-memory original */ }
        artifact = originalArtifact
        degradedCandidateCount = classificationRepairs.length
        warnings.push(...classificationRepairs.map((repair) => ({
          candidate_id: repair.candidate_id,
          code: "CLASSIFICATION_PERSIST_FAILED" as const,
          message: `候选 ${repair.candidate_id}/${repair.interface_name} 自动分类为 ${repair.resolved_kind}，但分类结果持久化失败，已降级为通用硬件接口建模：${error instanceof Error ? error.message : String(error)}`,
        })))
      }
    }
    const repairedCandidateIds = degradedCandidateCount === 0
      ? new Set(classificationRepairs.map((repair) => repair.candidate_id))
      : new Set<string>()
    const allBatches = artifact.candidates.map((candidate) => buildGenericHardwareInterfaceWorkerBatch(
      sourceArtifactsPath, candidatesPath, candidate, defaultGenericHardwareInterfaceRawPath(blocksDir, candidate.candidate_id),
    ))
    const workerBatches: GenericHardwareInterfaceWorkerBatch[] = []
    const reusedRawArtifacts: Array<{ candidate_id: string; output_path: string }> = []
    for (const batch of allBatches) {
      const candidate = artifact.candidates.find((item) => item.candidate_id === batch.candidate_id)!
      if (!repairedCandidateIds.has(batch.candidate_id) && canReuseGenericHardwareInterfaceRawArtifact(batch.output_path, candidate, manifest)) {
        reusedRawArtifacts.push({ candidate_id: batch.candidate_id, output_path: batch.output_path })
      } else {
        workerBatches.push(batch)
      }
    }
    const workerWaves: GenericHardwareInterfaceWorkerBatch[][] = []
    for (let index = 0; index < workerBatches.length; index += 5) workerWaves.push(workerBatches.slice(index, index + 5))
    const workerManifestPath = defaultHardwareInterfaceWorkerManifestPath(ctx)
    writeJson(workerManifestPath, {
      schema_version: 1,
      source_artifacts_path: sourceArtifactsPath,
      hardware_interface_candidates_path: candidatesPath,
      worker_batches: workerBatches,
    } satisfies HardwareInterfaceWorkerManifest)
    const compactBatches = workerBatches.map((batch, index) => ({
      batch_index: index + 1,
      candidate_id: batch.candidate_id,
      interface_name: batch.interface_name,
      interface_kind: batch.interface_kind,
      output_path: batch.output_path,
    }))
    const compactWaves: typeof compactBatches[] = []
    for (let index = 0; index < compactBatches.length; index += 5) compactWaves.push(compactBatches.slice(index, index + 5))
    return JSON.stringify({
      ok: true,
      mode: "prepare_hardware_interface_batches",
      output: {
        source_artifacts_path: sourceArtifactsPath,
        hardware_interface_candidates_path: candidatesPath,
        hardware_interface_blocks_dir: blocksDir,
        hardware_interface_block_raw_paths: allBatches.map((batch) => batch.output_path),
        hardware_interface_model_raw_path: modelRawPath,
        hardware_interface_model_path: modelPath,
        hardware_interface_worker_manifest_path: workerManifestPath,
      },
      summary: { candidate_count: artifact.candidates.length, worker_batch_count: workerBatches.length, worker_wave_count: workerWaves.length, max_parallelism: 5, reused_raw_artifact_count: reusedRawArtifacts.length, degraded_candidate_count: degradedCandidateCount },
      warnings,
      classification_repairs: classificationRepairs,
      reused_raw_artifacts: reusedRawArtifacts,
      worker_batches: compactBatches,
      worker_waves: compactWaves,
    }, null, 2)
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    const retryable = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE", "ETIMEDOUT"]).has(error?.code || "")
    const message = err instanceof Error ? err.message : String(err)
    const failedCandidateId = message.match(/(?:候选|candidate)\s+(HI-\d+)/i)?.[1]
    return JSON.stringify({
      ok: false,
      error: message,
      error_code: error?.code ? `IO_${error.code}` : "HARDWARE_INTERFACE_PREPARE_FAILED",
      retryable,
      ...(failedCandidateId ? { failed_candidate_id: failedCandidateId } : {}),
    })
  }
}

async function executeGetHardwareInterfaceWorkerBatchMode(args: { hardware_interface_worker_batch_index?: number }, ctx: ToolContext) {
  const batchIndex = args.hardware_interface_worker_batch_index
  const manifestPath = defaultHardwareInterfaceWorkerManifestPath(ctx)
  if (!Number.isInteger(batchIndex) || (batchIndex as number) < 1) return JSON.stringify({ error: "hardware_interface_worker_batch_index must be a positive integer." })
  if (!existsSync(manifestPath)) return JSON.stringify({ error: `File not found: ${manifestPath}; rerun prepare_hardware_interface_batches.` })
  try {
    const manifest = readJson<HardwareInterfaceWorkerManifest>(manifestPath)
    if (manifest.schema_version !== 1 || !Array.isArray(manifest.worker_batches)) throw new Error("invalid worker manifest schema")
    const batch = manifest.worker_batches[(batchIndex as number) - 1]
    if (!batch) throw new Error(`batch index ${batchIndex} is out of range; manifest contains ${manifest.worker_batches.length} pending batches`)
    return JSON.stringify({ ok: true, mode: "get_hardware_interface_worker_batch", batch_index: batchIndex, worker_batch_count: manifest.worker_batches.length, worker_batch: batch }, null, 2)
  } catch (error) {
    return JSON.stringify({ error: `${manifestPath}: ${error instanceof Error ? error.message : String(error)}; rerun prepare_hardware_interface_batches.` })
  }
}

async function executeMergeGenericHardwareInterfaceBlocksMode(args: { hardware_interface_block_raw_paths?: string[] }, ctx: ToolContext) {
  if (!Array.isArray(args.hardware_interface_block_raw_paths)) {
    return JSON.stringify({ error: "hardware_interface_block_raw_paths is required for merge_hardware_interface_blocks." })
  }
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const candidatesPath = defaultHardwareInterfaceCandidatesPath(ctx)
  const rawPaths = args.hardware_interface_block_raw_paths.map((path, index) => resolveArtifactPath(ctx, path, `hardware-interface-${index + 1}.raw.json`))
  const modelRawPath = defaultArtifactPath(ctx, "hardware-interface-model.raw.json")
  if (!existsSync(sourceArtifactsPath)) return JSON.stringify({ error: `File not found: ${sourceArtifactsPath}`, missing_prerequisite: "source_artifacts" })
  if (!existsSync(candidatesPath)) return JSON.stringify({ error: `File not found: ${candidatesPath}` })
  try {
    const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
    const artifact = normalizeHardwareInterfaceCandidates(candidatesPath, manifest)
    if (rawPaths.length !== artifact.candidates.length) throw new Error(`Expected ${artifact.candidates.length} raw paths in candidate order, got ${rawPaths.length}.`)
    const interfaces = artifact.candidates.flatMap((candidate, index) => {
      const path = rawPaths[index]
      if (!existsSync(path)) throw new Error(`File not found for candidate ${candidate.candidate_id}: ${path}`)
      return readGenericHardwareInterfaceArtifact(path, candidate)
    })
    const model: HardwareInterfaceModelArtifact = {
      model_version: 2,
      candidate_source: candidatesPath,
      chapter_title: "数据及接口需求",
      section_title: "硬件接口",
      interfaces,
    }
    validateAndEnrichGenericModel(model, manifest)
    writeJson(modelRawPath, model)
    publishEditMapping(modelRawPath, model)
    return JSON.stringify({
      ok: true,
      mode: "merge_hardware_interface_blocks",
      output: { source_artifacts_path: sourceArtifactsPath, hardware_interface_candidates_path: candidatesPath, hardware_interface_block_raw_paths: rawPaths, hardware_interface_model_raw_path: modelRawPath },
      summary: { candidate_count: artifact.candidates.length, interface_count: interfaces.length },
    }, null, 2)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

async function executePrepareFunctionalTitleTreeMode(ctx: ToolContext) {
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const rawPath = defaultFunctionalTitleTreeRawPath(ctx)
  const finalPath = defaultFunctionalTitleTreePath(ctx)
  const reportPath = defaultFunctionalTitleTreeReportPath(ctx)

  if (!existsSync(sourceArtifactsPath)) {
    return JSON.stringify({ error: `File not found: ${sourceArtifactsPath}`, missing_prerequisite: "source_artifacts" })
  }

  const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
  refreshSourceArtifactStructures(manifest, sourceArtifactsPath)
  let reusableModel: FunctionalTitleTreeArtifact | undefined
  if (existsSync(rawPath)) {
    try { reusableModel = finalizeFunctionalTitleTree(readFunctionalTitleTreeRawArtifact(rawPath), manifest) } catch { /* regenerate invalid raw */ }
  } else reusableModel = reusableFunctionalTitleTreeArtifact(finalPath, manifest)
  if (reusableModel) {
    writeJson(finalPath, reusableModel)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, renderFunctionalTitleTreeMarkdown(reusableModel), "utf-8")
    const counts = countFunctionalTitleTreeNodes(reusableModel.children)
    return JSON.stringify({
      ok: true,
      incremental_reuse: true,
      mode: "prepare_functional_title_tree",
      output: {
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_raw_path: rawPath,
        functional_title_tree_path: finalPath,
        functional_title_tree_report_path: reportPath,
      },
      summary: {
        worker_batch_count: 0,
        reused_artifact_count: 1,
        node_count: counts.nodeCount,
        leaf_count: counts.leafCount,
        skipped_source_ref_count: reusableModel.skipped_source_refs.length,
      },
      reused_artifacts: [{ output_path: finalPath }],
      message: "Existing functional-test-title-tree.json is valid for the current source artifacts; skip functional-title-tree-modeler and use the existing title tree.",
    }, null, 2)
  }
  const workerBatch = buildFunctionalTitleTreeWorkerBatch(sourceArtifactsPath, rawPath)
  return JSON.stringify({
    ok: true,
    mode: "prepare_functional_title_tree",
    output: {
      source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_raw_path: rawPath,
      functional_title_tree_path: finalPath,
      functional_title_tree_report_path: reportPath,
    },
    worker_batch: workerBatch,
    subagent_type: workerBatch.subagent_type,
    worker_payload: workerBatch.worker_payload,
    worker_prompt: workerBatch.worker_prompt,
    summary: {
      worker_batch_count: 1,
      reused_artifact_count: 0,
    },
  }, null, 2)
}

async function executeFinalizeFunctionalTitleTreeMode(ctx: ToolContext) {
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const rawPath = defaultFunctionalTitleTreeRawPath(ctx)
  const finalPath = defaultFunctionalTitleTreePath(ctx)
  const reportPath = defaultFunctionalTitleTreeReportPath(ctx)

  if (resolveNormalizedPath(rawPath) === resolveNormalizedPath(finalPath)) {
    return JSON.stringify({
      error: "functional_title_tree_raw_path and functional_title_tree_path must resolve to different files.",
    })
  }
  if (!existsSync(sourceArtifactsPath)) {
    return JSON.stringify({ error: `File not found: ${sourceArtifactsPath}`, missing_prerequisite: "source_artifacts" })
  }
  if (!existsSync(rawPath)) {
    return JSON.stringify({ error: `File not found: ${rawPath}` })
  }

  try {
    const raw = readFunctionalTitleTreeRawArtifact(rawPath)
    const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
    refreshSourceArtifactStructures(manifest, sourceArtifactsPath)
    const model = finalizeFunctionalTitleTree(raw, manifest)
    writeJson(finalPath, model)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, renderFunctionalTitleTreeMarkdown(model), "utf-8")
    const counts = countFunctionalTitleTreeNodes(model.children)

    return JSON.stringify({
      ok: true,
      mode: "finalize_functional_title_tree",
      output: {
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_raw_path: rawPath,
        functional_title_tree_path: finalPath,
        functional_title_tree_report_path: reportPath,
      },
      summary: {
        node_count: counts.nodeCount,
        leaf_count: counts.leafCount,
        skipped_source_ref_count: model.skipped_source_refs.length,
      },
    }, null, 2)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

async function executePrepareFunctionalInitContentMode(args: { allow_code?: boolean }, ctx: ToolContext) {
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const chapter2SystemOverviewPath = defaultArtifactPath(ctx, "chapter2-system-overview.json")
  const hardwareInterfaceModelPath = defaultArtifactPath(ctx, "hardware-interface-model.json")
  const hardwareInterfaceReportTextPath = defaultHardwareInterfaceReportTextPath(ctx)
  const titleTreePath = defaultFunctionalTitleTreePath(ctx)
  const rawPath = defaultFunctionalInitContentRawPath(ctx)
  const finalPath = defaultFunctionalInitContentPath(ctx)
  const reportPath = defaultFunctionalInitContentReportPath(ctx)
  const allowCode = args.allow_code === true

  if (!existsSync(sourceArtifactsPath)) {
    return JSON.stringify({ error: `File not found: ${sourceArtifactsPath}`, missing_prerequisite: "source_artifacts" })
  }
  if (!existsSync(titleTreePath)) {
    return JSON.stringify({ error: `File not found: ${titleTreePath}` })
  }
  const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
  refreshSourceArtifactStructures(manifest, sourceArtifactsPath)
  const titleTree = readJson<FunctionalTitleTreeArtifact>(titleTreePath)
  const routing = normalizeFunctionalTitleTreeRouting(titleTree)
  if (!routing.has_initialization || !routing.initialization_title_no) {
    return JSON.stringify({ error: "functional-test-title-tree.json must contain the required initialization node." })
  }
  const missingInventoryInputs = [chapter2SystemOverviewPath, hardwareInterfaceModelPath].filter((path) => !existsSync(path))
  if (missingInventoryInputs.length > 0) {
    return JSON.stringify({
      error: `Missing required initialization inventory input(s): ${missingInventoryInputs.join(", ")}`,
      missing_prerequisite: "initialization_inventory",
    })
  }
  if (!existsSync(hardwareInterfaceReportTextPath)) {
    return JSON.stringify({ error: `File not found: ${hardwareInterfaceReportTextPath}`, missing_prerequisite: "hardware_interface_report_text" })
  }
  if (canReuseFunctionalInitContentRawArtifact(rawPath, titleTree, manifest, allowCode)) {
    return JSON.stringify({
      ok: true,
      incremental_reuse: true,
      mode: "prepare_functional_init_content",
      output: {
        source_artifacts_path: sourceArtifactsPath,
        chapter2_system_overview_path: chapter2SystemOverviewPath,
        hardware_interface_model_path: hardwareInterfaceModelPath,
        hardware_interface_report_text_path: hardwareInterfaceReportTextPath,
        functional_title_tree_path: titleTreePath,
        functional_init_content_raw_path: rawPath,
        functional_init_content_path: finalPath,
        functional_init_content_report_path: reportPath,
        allow_code: allowCode,
      },
      summary: {
        has_initialization: true,
        worker_batch_count: 0,
        reused_raw_artifact_count: 1,
      },
      reused_raw_artifacts: [{ output_path: rawPath }],
      message: "Existing functional-init-content raw artifact is valid for the current title tree; skip functional-init-content-modeler and continue to finalize.",
    }, null, 2)
  }
  const workerBatch = buildFunctionalInitContentWorkerBatch(
    sourceArtifactsPath,
    sourceArtifactsPath,
    chapter2SystemOverviewPath,
    hardwareInterfaceModelPath,
    hardwareInterfaceReportTextPath,
    titleTreePath,
    rawPath,
    allowCode,
  )
  return JSON.stringify({
    ok: true,
    mode: "prepare_functional_init_content",
    output: {
      source_artifacts_path: sourceArtifactsPath,
      chapter2_system_overview_path: chapter2SystemOverviewPath,
      hardware_interface_model_path: hardwareInterfaceModelPath,
      hardware_interface_report_text_path: hardwareInterfaceReportTextPath,
      functional_title_tree_path: titleTreePath,
      functional_init_content_raw_path: rawPath,
      functional_init_content_path: finalPath,
      functional_init_content_report_path: reportPath,
      allow_code: allowCode,
    },
    worker_batch: workerBatch,
    subagent_type: workerBatch.subagent_type,
    worker_payload: workerBatch.worker_payload,
    worker_prompt: workerBatch.worker_prompt,
    summary: {
      has_initialization: true,
      worker_batch_count: 1,
      reused_raw_artifact_count: 0,
    },
  }, null, 2)
}

async function executeFinalizeFunctionalInitContentMode(ctx: ToolContext) {
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const titleTreePath = defaultFunctionalTitleTreePath(ctx)
  const rawPath = defaultFunctionalInitContentRawPath(ctx)
  const finalPath = defaultFunctionalInitContentPath(ctx)
  const reportPath = defaultFunctionalInitContentReportPath(ctx)

  if (resolveNormalizedPath(rawPath) === resolveNormalizedPath(finalPath)) {
    return JSON.stringify({
      error: "functional_init_content_raw_path and functional_init_content_path must resolve to different files.",
    })
  }
  if (!existsSync(sourceArtifactsPath)) {
    return JSON.stringify({ error: `File not found: ${sourceArtifactsPath}`, missing_prerequisite: "source_artifacts" })
  }
  if (!existsSync(titleTreePath)) {
    return JSON.stringify({ error: `File not found: ${titleTreePath}` })
  }

  try {
    const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
    refreshSourceArtifactStructures(manifest, sourceArtifactsPath)
    const titleTree = readJson<FunctionalTitleTreeArtifact>(titleTreePath)
    const routing = normalizeFunctionalTitleTreeRouting(titleTree)
    if (!routing.has_initialization || !routing.initialization_title_no) {
      return JSON.stringify({ error: "functional-test-title-tree.json must contain the required initialization node." })
    }
    if (!existsSync(rawPath)) {
      return JSON.stringify({ error: `File not found: ${rawPath}` })
    }
    const raw = readFunctionalInitContentRawArtifact(rawPath)
    const sourceBundle = loadPhase2SourceBundle(sourceArtifactsPath)
    const model = finalizeFunctionalInitContent(raw, titleTree, manifest)
    model.items = model.items.map((item, itemIndex) => {
      const processing = (item.processing || []).map((entry, processingIndex) => ({ ...entry, source_refs: normalizeAndValidateSourceRefs(entry.source_refs, sourceBundle, `functional init item[${itemIndex}].processing[${processingIndex}]`) }))
      return { ...item, processing, source_refs: [...new Set(processing.flatMap((entry) => entry.source_refs || []))] }
    })
    writeJson(finalPath, model)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, renderFunctionalInitContentDocx(model))
    publishEditMapping(finalPath, model)

    return JSON.stringify({
      ok: true,
      mode: "finalize_functional_init_content",
      output: {
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        functional_init_content_raw_path: rawPath,
        functional_init_content_path: finalPath,
        functional_init_content_report_path: reportPath,
      },
      summary: {
        item_count: model.items.length,
        processing_count: model.items.reduce((total, item) => total + (Array.isArray(item.processing) ? item.processing.length : 0), 0),
        table_count: model.items.reduce((total, item) => total + (Array.isArray(item.tables) ? item.tables.length : 0), 0),
        allow_code: model.allow_code,
      },
    }, null, 2)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

async function executePrepareFunctionalOtherContentMode(ctx: ToolContext) {
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const titleTreePath = defaultFunctionalTitleTreePath(ctx)
  const hardwareInterfaceReportPath = defaultReportPath(ctx, "hardware-interface-model.docx")
  const hardwareInterfaceReportTextPath = defaultHardwareInterfaceReportTextPath(ctx)
  const rawDir = defaultFunctionalOtherContentRawDir(ctx)
  const workerManifestPath = defaultFunctionalOtherContentWorkerManifestPath(ctx)
  const finalPath = defaultFunctionalOtherContentPath(ctx)
  const reportPath = defaultFunctionalOtherContentReportPath(ctx)

  if (!existsSync(sourceArtifactsPath)) {
    return JSON.stringify({ error: `File not found: ${sourceArtifactsPath}`, missing_prerequisite: "source_artifacts" })
  }
  if (!existsSync(titleTreePath)) {
    return JSON.stringify({
      error: `File not found: ${titleTreePath}`,
      missing_prerequisite: "functional_title_tree",
    })
  }
  if (!existsSync(hardwareInterfaceReportPath)) {
    return JSON.stringify({
      error: `File not found: ${hardwareInterfaceReportPath}`,
      missing_prerequisite: "hardware_interface_report",
    })
  }
  if (!existsSync(hardwareInterfaceReportTextPath)) {
    return JSON.stringify({
      error: `File not found: ${hardwareInterfaceReportTextPath}`,
      missing_prerequisite: "hardware_interface_report_text",
    })
  }

  const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
  refreshSourceArtifactStructures(manifest, sourceArtifactsPath)
  let titleTree: FunctionalTitleTreeArtifact
  let excludedTitleNos: string[]
  let targetLeaves: FunctionalOtherTargetLeaf[]
  try {
    titleTree = readJson<FunctionalTitleTreeArtifact>(titleTreePath)
    excludedTitleNos = expectedFunctionalOtherExclusions(titleTree)
    targetLeaves = collectFunctionalOtherLeafNodes(titleTree, excludedTitleNos).map((leaf, index) =>
      targetLeafFromFunctionalNode(leaf, `functional other leaf ${index + 1}`)
    )
  } catch (err) {
    return JSON.stringify({
      error: `Failed to prepare functional other leaf batches: ${err instanceof Error ? err.message : String(err)}`,
      missing_prerequisite: "functional_other_leaves",
    })
  }
  mkdirSync(rawDir, { recursive: true })
  const allWorkerBatches = targetLeaves.map((targetLeaf, index) =>
    buildFunctionalOtherContentWorkerBatch(
      sourceArtifactsPath,
      sourceArtifactsPath,
      titleTreePath,
      hardwareInterfaceReportPath,
      hardwareInterfaceReportTextPath,
      targetLeaf,
      excludedTitleNos,
      join(rawDir, safeFunctionalOtherLeafRawFileName(targetLeaf, index)),
    )
  )
  const workerBatches: FunctionalOtherContentWorkerBatch[] = []
  const reusedRawArtifacts: Array<{ target_leaf: FunctionalOtherTargetLeaf; output_path: string }> = []
  for (const batch of allWorkerBatches) {
    if (canReuseFunctionalOtherLeafRawArtifact(batch.output_path, excludedTitleNos, batch.worker_payload.target_leaf)) {
      reusedRawArtifacts.push({
        target_leaf: batch.worker_payload.target_leaf,
        output_path: batch.output_path,
      })
    } else {
      workerBatches.push(batch)
    }
  }
  const rawPaths = allWorkerBatches.map((batch) => batch.output_path)
  const workerManifest: FunctionalOtherContentWorkerManifest = {
    schema_version: 1,
    source_artifacts_path: sourceArtifactsPath,
    functional_title_tree_path: titleTreePath,
    hardware_interface_report_path: hardwareInterfaceReportPath,
    excluded_title_nos: excludedTitleNos,
    target_leaves: targetLeaves,
    functional_other_content_raw_paths: rawPaths,
    worker_batches: workerBatches,
  }
  writeJson(workerManifestPath, workerManifest)
  return JSON.stringify({
    ok: true,
    mode: "prepare_functional_other_content",
    output: {
      source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_path: titleTreePath,
      hardware_interface_report_path: hardwareInterfaceReportPath,
      hardware_interface_report_text_path: hardwareInterfaceReportTextPath,
      functional_other_content_raw_dir: rawDir,
      functional_other_content_worker_manifest_path: workerManifestPath,
      functional_other_content_raw_paths: rawPaths,
      functional_other_content_path: finalPath,
      functional_other_content_report_path: reportPath,
    },
    summary: {
      leaf_count: targetLeaves.length,
      worker_batch_count: workerBatches.length,
      reused_raw_artifact_count: reusedRawArtifacts.length,
    },
    reused_raw_artifacts: reusedRawArtifacts,
    worker_batches: workerBatches.map((batch, index) => ({
      batch_index: index + 1,
      target_leaf: batch.worker_payload.target_leaf,
      output_path: batch.output_path,
    })),
  }, null, 2)
}

async function executeGetFunctionalOtherContentWorkerBatchMode(args: { functional_other_content_worker_batch_index?: number }, ctx: ToolContext) {
  const manifestPath = defaultFunctionalOtherContentWorkerManifestPath(ctx)
  if (!existsSync(manifestPath)) {
    return JSON.stringify({ error: `File not found: ${manifestPath}` })
  }
  const batchIndex = args.functional_other_content_worker_batch_index
  if (!Number.isInteger(batchIndex) || (batchIndex ?? 0) < 1) {
    return JSON.stringify({ error: "functional_other_content_worker_batch_index must be a positive 1-based integer." })
  }

  let manifest: FunctionalOtherContentWorkerManifest
  try {
    manifest = readJson<FunctionalOtherContentWorkerManifest>(manifestPath)
    if (manifest.schema_version !== 1 || !Array.isArray(manifest.worker_batches) || !Array.isArray(manifest.target_leaves)) {
      throw new Error("unsupported or malformed manifest schema")
    }
    if (!existsSync(manifest.source_artifacts_path)) throw new Error(`source artifact no longer exists: ${manifest.source_artifacts_path}`)
    if (!existsSync(manifest.hardware_interface_report_path)) throw new Error(`hardware interface report no longer exists: ${manifest.hardware_interface_report_path}`)
    if (!existsSync(manifest.functional_title_tree_path)) throw new Error(`functional title tree no longer exists: ${manifest.functional_title_tree_path}`)
    const currentTitleTree = readJson<FunctionalTitleTreeArtifact>(manifest.functional_title_tree_path)
    const currentExcludedTitleNos = expectedFunctionalOtherExclusions(currentTitleTree)
    const currentTargetLeaves = collectFunctionalOtherLeafNodes(currentTitleTree, currentExcludedTitleNos).map((leaf, index) =>
      targetLeafFromFunctionalNode(leaf, `functional other leaf ${index + 1}`)
    )
    if (JSON.stringify(currentExcludedTitleNos) !== JSON.stringify(manifest.excluded_title_nos)
      || JSON.stringify(currentTargetLeaves) !== JSON.stringify(manifest.target_leaves)) {
      throw new Error("functional title tree changed after prepare")
    }
  } catch (err) {
    return JSON.stringify({
      error: `Functional other content worker manifest is stale or invalid: ${err instanceof Error ? err.message : String(err)}`,
      manifest_path: manifestPath,
      rerun_required: "prepare_functional_other_content",
    })
  }

  const batch = manifest.worker_batches[(batchIndex as number) - 1]
  if (!batch) {
    return JSON.stringify({
      error: `Worker batch index ${batchIndex} is out of range; manifest contains ${manifest.worker_batches.length} pending batches.`,
      manifest_path: manifestPath,
    })
  }
  if (batch.worker_payload.output_path !== batch.output_path
    || JSON.stringify(batch.worker_payload.target_leaf) !== JSON.stringify(manifest.target_leaves.find((leaf) => leaf.title_no === batch.worker_payload.target_leaf.title_no))) {
    return JSON.stringify({
      error: `Functional other content worker manifest batch ${batchIndex} has conflicting target leaf or output path.`,
      manifest_path: manifestPath,
      rerun_required: "prepare_functional_other_content",
    })
  }
  return JSON.stringify({
    ok: true,
    mode: "get_functional_other_content_worker_batch",
    manifest_path: manifestPath,
    batch_index: batchIndex,
    worker_batch_count: manifest.worker_batches.length,
    worker_batch: batch,
  }, null, 2)
}

async function executeFinalizeFunctionalOtherContentMode(args: { functional_other_content_raw_paths?: string[]; skip_intermediate_report?: boolean }, ctx: ToolContext) {
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")
  const titleTreePath = defaultFunctionalTitleTreePath(ctx)
  const hardwareInterfaceReportPath = defaultReportPath(ctx, "hardware-interface-model.docx")
  const finalPath = defaultFunctionalOtherContentPath(ctx)
  const reportPath = defaultFunctionalOtherContentReportPath(ctx)

  if (!Array.isArray(args.functional_other_content_raw_paths)) {
    return JSON.stringify({
      error: "functional_other_content_raw_paths is required for finalize_functional_other_content; call prepare_functional_other_content first and pass output.functional_other_content_raw_paths unchanged.",
      missing_prerequisite: "functional_other_content_raw_paths",
      rerun_required: "prepare_functional_other_content",
    }, null, 2)
  }
  const rawPaths = args.functional_other_content_raw_paths.map((path, index) =>
    resolveArtifactPath(ctx, path, `functional-other-content-leaf-${index + 1}.raw.json`)
  )
  for (const [index, path] of rawPaths.entries()) {
    if (resolveNormalizedPath(path) === resolveNormalizedPath(finalPath)) {
      return JSON.stringify({
        error: `functional_other_content_raw_paths[${index}] and functional_other_content_path must resolve to different files.`,
      })
    }
  }
  if (!existsSync(sourceArtifactsPath)) {
    return JSON.stringify({ error: `File not found: ${sourceArtifactsPath}`, missing_prerequisite: "source_artifacts" })
  }
  if (!existsSync(titleTreePath)) {
    return JSON.stringify({ error: `File not found: ${titleTreePath}` })
  }
  if (!existsSync(hardwareInterfaceReportPath)) {
    return JSON.stringify({ error: `File not found: ${hardwareInterfaceReportPath}` })
  }
  try {
    const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
    refreshSourceArtifactStructures(manifest, sourceArtifactsPath)
    const titleTree = readJson<FunctionalTitleTreeArtifact>(titleTreePath)
    const raw = mergeFunctionalOtherLeafRawArtifacts(rawPaths, titleTree)
    const sourceBundle = loadPhase2SourceBundle(sourceArtifactsPath)
    for (const rawPath of rawPaths) readFunctionalOtherContentRawArtifact(rawPath)
    const model = finalizeFunctionalOtherContent(raw, titleTree, manifest, rawPaths)
    model.items = model.items.map((item, itemIndex) => {
      const rawPath = rawPaths[itemIndex]
      const itemLabel = rawPath
        ? `${rawPath}: functional other item[${itemIndex}]`
        : `functional other item[${itemIndex}]`
      const processing = (item.processing || []).map((entry, processingIndex) => ({ ...entry, source_refs: normalizeAndValidateSourceRefs(entry.source_refs, sourceBundle, `${itemLabel}.processing[${processingIndex}]`) }))
      return { ...item, processing, source_refs: [...new Set(processing.flatMap((entry) => entry.source_refs || []))] }
    })
    writeJson(finalPath, model)
    if (!args.skip_intermediate_report) {
      mkdirSync(dirname(reportPath), { recursive: true })
      writeFileSync(reportPath, renderFunctionalOtherContentDocx(model, titleTree))
    }
    publishEditMapping(finalPath, model)

    return JSON.stringify({
      ok: true,
      mode: "finalize_functional_other_content",
      output: {
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareInterfaceReportPath,
        functional_other_content_raw_paths: rawPaths,
        functional_other_content_path: finalPath,
        functional_other_content_report_path: args.skip_intermediate_report ? undefined : reportPath,
      },
      summary: {
        item_count: model.items.length,
        processing_count: model.items.reduce((total, item) => total + (Array.isArray(item.processing) ? item.processing.length : 0), 0),
        raw_file_count: rawPaths.length,
      },
    }, null, 2)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

async function executeFinalizeFunctionalTestContentMode(ctx: ToolContext) {
  const titleTreePath = defaultFunctionalTitleTreePath(ctx)
  const initContentPath = defaultFunctionalInitContentPath(ctx)
  const otherContentPath = defaultFunctionalOtherContentPath(ctx)
  const finalPath = defaultFunctionalTestContentPath(ctx)
  const reportPath = defaultFunctionalTestContentReportPath(ctx)

  if (!existsSync(titleTreePath)) {
    return JSON.stringify({ error: `File not found: ${titleTreePath}` })
  }
  if (!existsSync(otherContentPath)) {
    return JSON.stringify({ error: `File not found: ${otherContentPath}` })
  }

  try {
    const titleTree = readJson<FunctionalTitleTreeArtifact>(titleTreePath)
    const routing = normalizeFunctionalTitleTreeRouting(titleTree)
    let initContent: FunctionalInitContentArtifact | undefined
    let resolvedInitContentPath: string | undefined
    if (routing.has_initialization) {
      if (!existsSync(initContentPath)) {
        return JSON.stringify({ error: `File not found: ${initContentPath}` })
      }
      initContent = readJson<FunctionalInitContentArtifact>(initContentPath)
      resolvedInitContentPath = initContentPath
    }
    const otherContent = readJson<FunctionalOtherContentArtifact>(otherContentPath)
    const model = buildFunctionalTestContentArtifact(
      titleTree,
      otherContent,
      {
        functionalTitleTreePath: titleTreePath,
        functionalInitContentPath: resolvedInitContentPath,
        functionalOtherContentPath: otherContentPath,
      },
      initContent,
    )
    writeJson(finalPath, model)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, renderFunctionalTestContentDocx(model))
    publishEditMapping(finalPath, model)
    const counts = countFunctionalTestContent(model)

    return JSON.stringify({
      ok: true,
      mode: "finalize_functional_test_content",
      output: {
        functional_title_tree_path: titleTreePath,
        ...(resolvedInitContentPath ? { functional_init_content_path: resolvedInitContentPath } : {}),
        functional_other_content_path: otherContentPath,
        functional_test_content_path: finalPath,
        functional_test_content_report_path: reportPath,
      },
      summary: {
        has_initialization: routing.has_initialization,
        node_count: counts.nodeCount,
        leaf_count: counts.leafCount,
        initialization_item_count: counts.initializationItemCount,
        other_item_count: counts.otherItemCount,
        initialization_table_count: counts.initializationTableCount,
        processing_count: counts.processingCount,
      },
    }, null, 2)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

async function executeFinalizeHardwareInterfaceMode(ctx: ToolContext) {
  const hardwareInterfaceModelRawPath = defaultArtifactPath(ctx, "hardware-interface-model.raw.json")
  const hardwareInterfaceModelPath = defaultArtifactPath(ctx, "hardware-interface-model.json")
  const hardwareInterfaceReportPath = defaultReportPath(ctx, "hardware-interface-model.docx")
  const hardwareInterfaceReportTextPath = defaultHardwareInterfaceReportTextPath(ctx)
  const sourceArtifactsPath = defaultArtifactPath(ctx, "source-artifacts.json")

  if (resolveNormalizedPath(hardwareInterfaceModelRawPath) === resolveNormalizedPath(hardwareInterfaceModelPath)) {
    return JSON.stringify({
      error: "hardware_interface_model_raw_path and hardware_interface_model_path must resolve to different files.",
    })
  }

  if (!existsSync(hardwareInterfaceModelRawPath)) {
    return JSON.stringify({ error: `File not found: ${hardwareInterfaceModelRawPath}` })
  }
  if (!existsSync(sourceArtifactsPath)) {
    return JSON.stringify({
      error: `File not found: ${sourceArtifactsPath}. finalize_hardware_interface requires source-artifacts.json.`,
      missing_prerequisite: "source_artifacts",
    })
  }

  try {
    let model = readJson<HardwareInterfaceModelArtifact>(hardwareInterfaceModelRawPath)
    const manifest = readJson<SourceArtifactsManifest>(sourceArtifactsPath)
    refreshSourceArtifactStructures(manifest, sourceArtifactsPath)
    if (Number(model.model_version) !== 2) {
      throw new Error("finalize_hardware_interface requires model_version 2.")
    }
    if (!Array.isArray(model.interfaces)) {
      throw new Error("finalize_hardware_interface requires top-level interfaces array; legacy blocks are not supported.")
    }
    if (model.blocks !== undefined) {
      throw new Error("finalize_hardware_interface does not support legacy blocks.")
    }
    model = validateAndEnrichGenericModel(model, manifest)
    const interfaces = model.interfaces || []
    for (const [interfaceIndex, item] of interfaces.entries()) {
      for (const group of genericInterfaceTableGroups(item)) {
        for (const [tableIndex, table] of group.tables.entries()) {
          if (!textOf(table.table_id) || !table.table_asset || !existsSync(table.table_asset.path)) {
            throw new Error(`interface ${interfaceIndex + 1} ${group.label} table ${tableIndex + 1} is not backed by a valid DOCX table asset.`)
          }
        }
      }
    }
    writeJson(hardwareInterfaceModelPath, model)
    const nestedSectionCount = interfaces.reduce((total, item) => total + (Array.isArray(item.topics) ? item.topics.length : 0), 0)

    mkdirSync(dirname(hardwareInterfaceReportPath), { recursive: true })
    writeFileSync(hardwareInterfaceReportPath, renderHardwareInterfaceDocx(model))
    mkdirSync(dirname(hardwareInterfaceReportTextPath), { recursive: true })
    writeFileSync(
      hardwareInterfaceReportTextPath,
      extractDocxMarkdown(hardwareInterfaceReportPath, "第三章硬件接口报告文本抽取"),
      "utf-8",
    )
    publishEditMapping(hardwareInterfaceModelPath, model)

    return JSON.stringify({
      ok: true,
      mode: "finalize_hardware_interface",
      output: {
        hardware_interface_model_raw_path: hardwareInterfaceModelRawPath,
        hardware_interface_model_path: hardwareInterfaceModelPath,
        hardware_interface_report_path: hardwareInterfaceReportPath,
        hardware_interface_report_text_path: hardwareInterfaceReportTextPath,
        source_artifacts_path: sourceArtifactsPath,
      },
      summary: {
        interface_count: interfaces.length,
        block_count: 0,
        nested_section_count: nestedSectionCount,
      },
    }, null, 2)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

export const filldataPhase2Workflow: ToolDefinition = tool({
  description:
    "由代码执行固定步骤、只把语义判断留给 worker agents 的确定性 Phase 2 workflow 工具。固定产物统一使用当前项目的 .matrix 默认路径；仅两个动态 raw 路径列表允许从 prepare 结果透传。",
  args: {
    mode: tool.schema
      .enum([
        "discover_documents",
        "prepare_document_artifacts",
        "prepare_chapter1_scope",
        "finalize_chapter1_scope",
        "prepare_chapter2_system_overview",
        "finalize_chapter2_system_overview",
        "discover_hardware_interface_candidates",
        "prepare_hardware_interface_batches",
        "get_hardware_interface_worker_batch",
        "merge_hardware_interface_blocks",
        "finalize_hardware_interface",
        "prepare_functional_title_tree",
        "finalize_functional_title_tree",
        "prepare_functional_init_content",
        "finalize_functional_init_content",
        "prepare_functional_other_content",
        "get_functional_other_content_worker_batch",
        "finalize_functional_other_content",
        "finalize_functional_test_content",
        "generate_phase2_traceability",
        "prepare_interface_test_content",
        "get_interface_test_worker_batch",
        "finalize_interface_test_content",
        "prepare_performance_test_content",
        "finalize_performance_test_content",
        "prepare_reliability_safety_test_content",
        "finalize_reliability_safety_test_content",
        "prepare_margin_test_content",
        "finalize_margin_test_content",
        "prepare_boundary_test_content",
        "finalize_boundary_test_content",
        "prepare_data_processing_test_content",
        "finalize_data_processing_test_content",
        "prepare_recovery_test_content",
        "finalize_recovery_test_content",
        "prepare_strength_test_content",
        "finalize_strength_test_content",
        "finalize_phase2_document",
      ])
      .describe("Workflow step to execute."),
    hardware_interface_block_raw_paths: tool.schema.array(tool.schema.string()).optional().describe("Candidate-ordered raw interface artifact paths returned by prepare_hardware_interface_batches."),
    functional_other_content_raw_paths: tool.schema.array(tool.schema.string()).optional().describe("Complete leaf raw artifact paths returned by prepare_functional_other_content; required by finalize_functional_other_content."),
    skip_intermediate_report: tool.schema.boolean().optional().describe("Editor fast path: update the deterministic JSON model without rendering the standalone intermediate DOCX."),
    functional_other_content_worker_batch_index: tool.schema.number().int().positive().optional().describe("1-based pending worker batch index used by get_functional_other_content_worker_batch."),
    hardware_interface_worker_batch_index: tool.schema.number().int().positive().optional().describe("1-based pending worker batch index used by get_hardware_interface_worker_batch."),
    interface_test_worker_batch_index: tool.schema.number().int().positive().optional().describe("1-based pending worker batch index used by get_interface_test_worker_batch."),
    allow_code: tool.schema.boolean().optional().describe("Whether functional init content workers may use code evidence. Default false."),
  },
  async execute(args, ctx: ToolContext) {
    return withPhase2Diagnostics(args.mode, async () => {
    if (args.mode === "discover_documents") return executeDiscoverDocumentsMode(ctx)
    if (args.mode === "prepare_document_artifacts") return executePrepareDocumentArtifactsMode(ctx)
    if (args.mode === "prepare_chapter1_scope") return prepareChapter1Scope(ctx)
    if (args.mode === "finalize_chapter1_scope") return finalizeChapter1Scope(ctx)
    if (args.mode === "prepare_chapter2_system_overview") return prepareChapter2SystemOverview(ctx)
    if (args.mode === "finalize_chapter2_system_overview") return finalizeChapter2SystemOverview(ctx)
    if (args.mode === "discover_hardware_interface_candidates") return executeDiscoverHardwareInterfaceCandidatesMode(ctx)
    if (args.mode === "prepare_hardware_interface_batches") return executePrepareHardwareInterfaceBatchesMode(ctx)
    if (args.mode === "get_hardware_interface_worker_batch") return executeGetHardwareInterfaceWorkerBatchMode({ hardware_interface_worker_batch_index: args.hardware_interface_worker_batch_index }, ctx)
    if (args.mode === "merge_hardware_interface_blocks") {
      return executeMergeGenericHardwareInterfaceBlocksMode({ hardware_interface_block_raw_paths: args.hardware_interface_block_raw_paths }, ctx)
    }
    if (args.mode === "finalize_hardware_interface") return executeFinalizeHardwareInterfaceMode(ctx)
    if (args.mode === "prepare_functional_title_tree") return executePrepareFunctionalTitleTreeMode(ctx)
    if (args.mode === "finalize_functional_title_tree") return executeFinalizeFunctionalTitleTreeMode(ctx)
    if (args.mode === "prepare_functional_init_content") return executePrepareFunctionalInitContentMode({ allow_code: args.allow_code }, ctx)
    if (args.mode === "finalize_functional_init_content") return executeFinalizeFunctionalInitContentMode(ctx)
    if (args.mode === "prepare_functional_other_content") return executePrepareFunctionalOtherContentMode(ctx)
    if (args.mode === "get_functional_other_content_worker_batch") return executeGetFunctionalOtherContentWorkerBatchMode({ functional_other_content_worker_batch_index: args.functional_other_content_worker_batch_index }, ctx)
    if (args.mode === "finalize_functional_other_content") return executeFinalizeFunctionalOtherContentMode({ functional_other_content_raw_paths: args.functional_other_content_raw_paths, skip_intermediate_report: args.skip_intermediate_report }, ctx)
    if (args.mode === "finalize_functional_test_content") return executeFinalizeFunctionalTestContentMode(ctx)
    if (args.mode === "prepare_interface_test_content") return prepareInterfaceTestContent(ctx)
    if (args.mode === "get_interface_test_worker_batch") return getInterfaceTestWorkerBatch(args.interface_test_worker_batch_index, ctx)
    if (args.mode === "finalize_interface_test_content") return finalizeInterfaceTestContent(ctx)
    if (args.mode === "prepare_performance_test_content") return preparePerformanceTestContent(ctx)
    if (args.mode === "finalize_performance_test_content") return finalizePerformanceTestContent(ctx)
    if (args.mode === "prepare_reliability_safety_test_content") return prepareReliabilitySafetyTestContent(ctx)
    if (args.mode === "finalize_reliability_safety_test_content") return finalizeReliabilitySafetyTestContent(ctx)
    if (args.mode === "prepare_margin_test_content") return prepareMarginTestContent(ctx)
    if (args.mode === "finalize_margin_test_content") return finalizeMarginTestContent(ctx)
    if (args.mode === "prepare_boundary_test_content") return prepareBoundaryTestContent(ctx)
    if (args.mode === "finalize_boundary_test_content") return finalizeBoundaryTestContent(ctx)
    if (args.mode === "prepare_data_processing_test_content") return prepareDataProcessingTestContent(ctx)
    if (args.mode === "finalize_data_processing_test_content") return finalizeDataProcessingTestContent(ctx)
    if (args.mode === "prepare_recovery_test_content") return prepareRecoveryTestContent(ctx)
    if (args.mode === "finalize_recovery_test_content") return finalizeRecoveryTestContent(ctx)
    if (args.mode === "prepare_strength_test_content") return prepareStrengthTestContent(ctx)
    if (args.mode === "finalize_strength_test_content") return finalizeStrengthTestContent(ctx)
    if (args.mode === "generate_phase2_traceability") return generateFunctionalTestTraceability(ctx)
    if (args.mode === "finalize_phase2_document") return finalizePhase2Document(ctx)
    return JSON.stringify({ error: `unsupported filldata_phase2_workflow mode: ${String((args as any).mode)}` })
    }, ctx.directory, { compactSuccess: args.mode === "prepare_document_artifacts" })
  },
})
