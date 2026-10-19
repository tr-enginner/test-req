import { mappedEditorTarget, UneditableTarget } from "./phase2-editor-mapping"
import { readPhase2Json } from "../shared/phase2-json"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { PerformanceRelatedDescription } from "../schema/performance-test-content"
import { ReliabilitySafetyRelatedDescription } from "../schema/reliability-safety-test-content"
import { MarginRelatedDescription } from "../schema/margin-test-content"
import { BoundaryRelatedDescription } from "../schema/boundary-test-content"
import { DataProcessingRelatedDescription } from "../schema/data-processing-test-content"
import { RecoveryRelatedDescription } from "../schema/recovery-test-content"
import { StrengthRelatedDescription } from "../schema/strength-test-content"

type Json = Record<string, any>
type Operation = "update" | "add" | "delete"

export interface Phase2EditorRequest {
  directory: string
  artifact: string
  business_id?: string
  container_id?: string
  operation?: Operation
  expected_revision?: string
  value?: Json
  identity?: Json
}

export interface Phase2InlineChange { edit_key: string; value: unknown }
export interface Phase2TableOperation {
  container_key: string
  operation: "add_row" | "delete_row" | "add_column" | "delete_column"
  row_key?: string
  column_key?: string
  insert_after_key?: string
  initial_value?: unknown
}
export interface Phase2RequirementOperation {
  container_key: string
  operation: "add_requirement" | "delete_requirement"
  requirement_key?: string
  requested_suffix?: string
  initial_value?: {
    content?: string
    description?: string
    related_description?: string
    source_refs: string[]
  }
}
export interface Phase2ReferenceOperation {
  container_key: string
  operation: "add_reference" | "update_reference" | "delete_reference"
  reference_key?: string
  initial_value?: { document_id: string; document_title: string }
}
export interface Phase2InlineBatchRequest {
  directory: string
  expected_revision: string
  expected_artifact_revisions?: Record<string, string>
  changes?: Phase2InlineChange[]
  table_operations?: Phase2TableOperation[]
  requirement_operations?: Phase2RequirementOperation[]
  reference_operations?: Phase2ReferenceOperation[]
}

export function phase2EditorMutationFiles(request: Phase2EditorRequest | Phase2InlineBatchRequest) {
  const files = new Set<string>()
  const addTarget = (key: InlineKey) => {
    const target = locate({directory: request.directory, artifact: key.artifact, business_id: key.business_id,
      container_id: key.container_id, identity: key.identity})
    files.add(resolve(target.rawFile))
  }
  if ("edit_key" in (request as any) || "changes" in request || "table_operations" in request || "requirement_operations" in request || "reference_operations" in request) {
    const batch = request as Phase2InlineBatchRequest
    for (const change of batch.changes || []) addTarget(decodePhase2EditKey(change.edit_key))
    for (const operation of batch.table_operations || []) addTarget(decodePhase2EditKey(operation.container_key))
    for (const operation of batch.requirement_operations || []) addTarget(decodePhase2EditKey(operation.container_key))
    for (const operation of batch.reference_operations || []) addTarget(decodePhase2EditKey(operation.container_key))
    if ((batch.requirement_operations || []).length || (batch.changes || []).some(change => decodePhase2EditKey(change.edit_key).field === "requirement_id_suffix")) files.add(resolve(dataPath(request.directory, "phase2-editor-state.json")))
  } else {
    const single = request as Phase2EditorRequest
    const target = locate(single)
    files.add(resolve(target.rawFile))
    if (single.operation === "add" || single.operation === "delete") files.add(resolve(dataPath(request.directory, "phase2-editor-state.json")))
  }
  return [...files].sort()
}

type InlineKey = { artifact: string; business_id?: string; container_id?: string; identity?: Json; field: string }
const INLINE_FIELDS: Record<string, RegExp> = {
  "chapter1-scope.json": /^(source_refs|document_id|document_version|software_name_and_id|model_name|client_address|system_name|code_version|programming_languages|csci_names|references|references\.\d+\.(document_id|document_title))$/,
  "chapter2-system-overview.json": /^(source_refs|system_relationship|processor_type|processor_frequency|memory_io_summary|software_name_and_id|software_level|programming_language|development_platform|compilation_environment|subsystem_and_software_functions\.\d+|interrupts|interrupts\.\d+|interrupts\.\d+\.(interrupt_name|priority|frequency_or_random|trigger_mode|execution_function)|memory_io_tables\.\d+|memory_io_tables\.\d+\.title|memory_io_tables\.\d+\.columns\.\d+|memory_io_tables\.\d+\.rows\.\d+|memory_io_tables\.\d+\.rows\.\d+\.\d+)$/,
  "hardware-interface-model.json": /^(title|overview|input_flow(?:\.\d+)?|output_flow(?:\.\d+)?|overview_tables|input_tables|output_tables|topics\.\d+\.(title|input_flow(?:\.\d+)?|output_flow(?:\.\d+)?|input_tables|output_tables)|source_refs|topics\.\d+\.source_refs)$/,
  "functional-test-content.json": /^(processing|requirement_id_suffix|summary|input_flow\.\d+|output_flow\.\d+|content|source_refs|tables\.\d+|tables\.\d+\.title|tables\.\d+\.columns\.\d+|tables\.\d+\.rows\.\d+|tables\.\d+\.rows\.\d+\.\d+)$/,
  "performance-test-content.json": /^(rows|rows\.\d+|performance_requirement_description|related_description|source_refs)$/,
  "interface-test-content.json": /^(rows|interface_requirement_description|related_description|source_refs)$/,
  "reliability-safety-test-content.json": /^(rows|rows\.\d+|reliability_safety_requirement_description|related_description|source_refs)$/,
  "margin-test-content.json": /^(rows|rows\.\d+|margin_requirement_description|related_description|source_refs)$/,
  "boundary-test-content.json": /^(rows|rows\.\d+|boundary_requirement_description|related_description|source_refs)$/,
  "data-processing-test-content.json": /^(rows|rows\.\d+|data_processing_requirement_description|related_description|source_refs)$/,
  "recovery-test-content.json": /^(rows|rows\.\d+|recovery_requirement_description|related_description|source_refs)$/,
  "strength-test-content.json": /^(rows|rows\.\d+|strength_requirement_description|related_description|source_refs)$/,
}

export function encodePhase2EditKey(value: InlineKey) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}
function decodePhase2EditKey(value: string): InlineKey {
  let parsed: InlineKey
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) } catch { throw new Error("无效的edit_key") }
  if (!parsed?.artifact || !parsed.field || !INLINE_FIELDS[parsed.artifact]?.test(parsed.field)) throw new Error("edit_key不在可编辑白名单中")
  return parsed
}

function pathParts(value: string) { return value.split(".").map(part => /^\d+$/.test(part) ? Number(part) : part) }
function setPath(root: any, field: string, value: unknown) {
  const parts = pathParts(field); let current = root
  for (let i = 0; i < parts.length - 1; i++) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null) {
      throw new Error(`edit_key路径与raw结构不一致: ${field}`)
    }
    const key: any = parts[i], next: any = parts[i + 1]
    if (current[key] == null) current[key] = typeof next === "number" ? [] : {}
    current = current[key]
  }
  if ((typeof current !== "object" && typeof current !== "function") || current === null) {
    throw new Error(`edit_key路径与raw结构不一致: ${field}`)
  }
  current[parts.at(-1) as any] = value
}

const NON_FUNCTIONAL: Record<string, { raw: string; final: string; prefix: string; description: string }> = {
  "performance-test-content.json": { raw: "performance.raw.json", final: "performance-test-content.json", prefix: "TR-XN", description: "performance_requirement_description" },
  "reliability-safety-test-content.json": { raw: "reliability-safety.raw.json", final: "reliability-safety-test-content.json", prefix: "TR-AQ", description: "reliability_safety_requirement_description" },
  "margin-test-content.json": { raw: "margin.raw.json", final: "margin-test-content.json", prefix: "TR-YL", description: "margin_requirement_description" },
  "boundary-test-content.json": { raw: "boundary.raw.json", final: "boundary-test-content.json", prefix: "TR-BJ", description: "boundary_requirement_description" },
  "data-processing-test-content.json": { raw: "data-processing.raw.json", final: "data-processing-test-content.json", prefix: "TR-SC", description: "data_processing_requirement_description" },
  "recovery-test-content.json": { raw: "recovery.raw.json", final: "recovery-test-content.json", prefix: "TR-HF", description: "recovery_requirement_description" },
  "strength-test-content.json": { raw: "strength.raw.json", final: "strength-test-content.json", prefix: "TR-QD", description: "strength_requirement_description" },
}
const RELATED_DESCRIPTION_SCHEMAS: Record<string, {safeParse: (value: unknown) => {success: boolean; error?: {issues?: Array<{message?: string}>}}}> = {
  "performance-test-content.json": PerformanceRelatedDescription,
  "reliability-safety-test-content.json": ReliabilitySafetyRelatedDescription,
  "margin-test-content.json": MarginRelatedDescription,
  "boundary-test-content.json": BoundaryRelatedDescription,
  "data-processing-test-content.json": DataProcessingRelatedDescription,
  "recovery-test-content.json": RecoveryRelatedDescription,
  "strength-test-content.json": StrengthRelatedDescription,
}

function validatedRelatedDescription(artifact: string, value: unknown) {
  const normalized = String(value ?? "").replace(/[\u200B-\u200D\uFEFF]/gu, "").trim()
  const schema = RELATED_DESCRIPTION_SCHEMAS[artifact]
  if (!schema) {
    if (!normalized) throw new Error("相关说明不能为空")
    return normalized
  }
  const result = schema.safeParse(normalized)
  if (!result.success) throw new Error(`${artifact}相关说明无效: ${JSON.stringify(normalized)}；${result.error?.issues?.[0]?.message || "不在允许范围内"}`)
  return normalized
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const readJson = (file: string): Json => readPhase2Json(file)
const writeJsonAtomic = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.phase2-edit-${process.pid}-${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8")
  renameSync(temporary, file)
}
const dataPath = (directory: string, name: string) => join(resolve(directory), ".matrix", "data", name)
const revisionOf = (files: string[]) => hash(files.sort().map((file) => `${file}\0${existsSync(file) ? readFileSync(file, "utf8") : ""}`).join("\0"))

function sourceCatalog(directory: string) {
  const warnings: string[] = [], options: Json[] = [], tables: Json[] = []
  let order = 0
  try {
    const manifest = readJson(dataPath(directory, "source-artifacts.json"))
    for (const document of [manifest.primary_document, ...(manifest.supporting_documents || [])].filter(Boolean)) {
      try {
        const path = String(document.structure_path || "")
        if (!path) throw new Error("缺少structure_path")
        const structure = readJson(isAbsolute(path) ? path : resolve(directory, path))
        if (!Array.isArray(structure.sections)) throw new Error("sections不是数组")
        for (const section of structure.sections) {
          const ref = section.source_ref || `${document.role === "primary" ? "primary" : document.role}::${section.section_id}`
          options.push({value: ref, role: document.role, document_name: sourceDocumentName(document, false),
            number: displaySectionNumber(section.section_id), title: section.title || "", path_titles: section.section_path_titles || []})
          for (const table of section.tables || []) {
            if (!table?.table_id) continue
            tables.push({table_id: String(table.table_id), title: String(table.title || ""), source_ref: ref,
              document_name: sourceDocumentName(document, true), section_number: displaySectionNumber(section.section_id),
              section_title: section.title || "", section_path_titles: section.section_path_titles || [],
              table_html: String(table.table_html || ""), order: order++})
          }
        }
      } catch (error) { warnings.push(`来源目录不可读取：${document.structure_path || "未知文件"}：${String(error)}`) }
    }
  } catch (error) { warnings.push(`来源清单不可读取：${String(error)}`) }
  return {options: [...new Map(options.map(option => [option.value, option])).values()], tables,
    warnings, skipped_count: warnings.length, complete: warnings.length === 0}
}
function sourceOptions(directory: string) { return sourceCatalog(directory).options }

function filteredView(value: any, known: Set<string>): any {
  if (Array.isArray(value)) return value.map(item => filteredView(item, known))
  if (!value || typeof value !== "object") return value
  const result: Json = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, filteredView(child, known)]))
  if ("source_refs" in result) result.source_refs = Array.isArray(result.source_refs)
    ? [...new Set(result.source_refs.filter((ref: unknown) => typeof ref === "string").map((ref: string) => ref.trim()))].filter(ref => known.has(ref as string)) : []
  return result
}
function normalizedEdits(directory: string, value: any): any {
  if (Array.isArray(value)) return value.map(item => normalizedEdits(directory, item))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === "source_refs" ? requireCanonicalPrimaryRefs(directory, child, "编辑") : normalizedEdits(directory, child)]))
}

function sourceDocumentName(document: Json, keepExtension: boolean) {
  const raw = String(document.name || document.file_name || document.path || "")
  const fileName = raw.split(/[\\/]/u).filter(Boolean).at(-1) || raw
  return keepExtension ? fileName : fileName.replace(/\.docx$/iu, "")
}

function displaySectionNumber(sectionId: unknown) {
  const numeric = String(sectionId || "").match(/^SRS-(\d+(?:\.\d+)*)$/u)?.[1]
  if (!numeric) return ""
  return numeric.split(".").map(part => String(Number(part))).join(".")
}

function sourceTables(directory: string) { return sourceCatalog(directory).tables }

function hardwareAssignments(directory: string, warnings: string[] = []) {
  const assigned = new Map<string, string>(), blockDir = dataPath(directory, "hardware-interface-blocks")
  if (!existsSync(blockDir)) return assigned
  const visit = (tables: unknown, location: string) => {
    for (const table of Array.isArray(tables) ? tables : []) {
      const tableId = hardwareTableId(table)
      if (tableId) assigned.set(tableId, location)
    }
  }
  for (const file of readdirSync(blockDir).filter(name => name.endsWith(".raw.json"))) {
    let raw: Json
    try { raw = readJson(join(blockDir, file)) } catch { warnings.push(`已跳过无法读取的硬件raw：${file}`); continue }
    if (!raw || typeof raw !== "object") { warnings.push(`已跳过结构无效的硬件raw：${file}`); continue }
    const item = raw.interface || raw
    const name = String(item.title || item.interface_name || item.interface_id || file)
    visit(item.overview_tables, `${name} / 概述`); visit(item.input_tables, `${name} / 输入流`); visit(item.output_tables, `${name} / 输出流`)
    for (const [index, topic] of (Array.isArray(item.topics) ? item.topics : []).entries()) {
      if (!topic || typeof topic !== "object") continue
      const topicName = String(topic.title || `主题${index + 1}`)
      visit(topic.input_tables, `${name} / ${topicName} / 输入流`); visit(topic.output_tables, `${name} / ${topicName} / 输出流`)
    }
  }
  return assigned
}

function hardwareTableId(table: unknown) {
  if (typeof table === "string") return table.trim()
  if (table && typeof table === "object") return String((table as Json).table_id || "").trim()
  return ""
}

function formSchema(value: Json, readOnly: string[] = []) {
  return Object.entries(value).filter(([key]) => !readOnly.includes(key)).map(([key, item]) => ({
    key,
    label: key,
    type: key === "source_refs" ? "source_refs" : Array.isArray(item) ? "json" : typeof item === "object" && item !== null ? "json" : "text",
    required: key.endsWith("_requirement_description") || key === "content",
  }))
}

function stateOf(directory: string) {
  const file = dataPath(directory, "phase2-editor-state.json")
  const state = existsSync(file) ? readJson(file) : { version: 1, next_sequences: {}, tombstoned_requirement_ids: [] }
  state.version = 1
  state.next_sequences ||= {}
  state.tombstoned_requirement_ids ||= []
  return { file, state }
}

function allocateId(directory: string, prefix: string, existing: string[]) {
  const { file, state } = stateOf(directory)
  const all = [...existing, ...state.tombstoned_requirement_ids]
  const max = all.reduce((value, id) => {
    const match = String(id).match(new RegExp(`^${prefix}-(\\d+)$`))
    return match ? Math.max(value, Number(match[1])) : value
  }, 0)
  const next = Math.max(Number(state.next_sequences[prefix] || 1), max + 1)
  const id = `${prefix}-${String(next).padStart(3, "0")}`
  state.next_sequences[prefix] = next + 1
  writeJsonAtomic(file, state)
  return id
}

function tombstone(directory: string, id: string) {
  const { file, state } = stateOf(directory)
  if (!state.tombstoned_requirement_ids.includes(id)) state.tombstoned_requirement_ids.push(id)
  writeJsonAtomic(file, state)
}

function requireCanonicalPrimaryRefs(directory: string, refs: unknown, location: string) {
  if (refs == null) return []
  if (!Array.isArray(refs) || refs.some(ref => typeof ref !== "string")) {
    throw new Error(`${location}.source_refs必须是字符串数组`)
  }
  if (!refs.length) return []
  const catalog = sourceCatalog(directory)
  if (!catalog.complete) throw new Error("来源目录不可用，无法可靠保存非空来源；可以显式清空")
  const known = new Set(catalog.options.map(option => option.value))
  return [...new Set(refs.map(ref => ref.trim()))].filter(ref => known.has(ref))
}

function normalizedRequestedId(directory: string, prefix: string, suffix: unknown, existing: string[], oldId?: string) {
  const value = String(suffix ?? "").trim()
  if (!/^\d+$/u.test(value) || Number(value) <= 0) throw new Error("TR数字序号必须为正整数")
  const id = `${prefix}-${value.padStart(3, "0")}`
  const { state } = stateOf(directory)
  if (id !== oldId && existing.includes(id)) throw new Error(`TR编号已存在: ${id}`)
  if (id !== oldId && state.tombstoned_requirement_ids.includes(id)) throw new Error(`TR编号已被删除或改号，不能复用: ${id}`)
  return id
}

function allRequirementIds(directory: string) {
  const ids: string[] = []
  const finalFiles = ["functional-test-content.json", "interface-test-content.json", ...Object.keys(NON_FUNCTIONAL)]
    .map(name => dataPath(directory, name)).filter(existsSync)
  for (const file of [...inlineEditorFiles(directory), ...finalFiles]) {
    let raw: Json
    try { raw = readJson(file) } catch { continue }
    const collect = (value: unknown) => {
      if (!value || typeof value !== "object") return
      const object = value as Json
      if (typeof object.requirement_id === "string") ids.push(object.requirement_id)
      if (typeof object.test_requirement_id === "string" && object.test_requirement_id !== "AUTO_TR_JK") ids.push(object.test_requirement_id)
      for (const child of Object.values(object)) {
        if (Array.isArray(child)) child.forEach(collect)
        else if (child && typeof child === "object") collect(child)
      }
    }
    collect(raw)
  }
  return ids
}

function uniqueTarget<T>(values: T[], label: string): T {
  if (values.length !== 1) throw new Error(values.length ? `${label}不唯一，拒绝修改` : `未找到${label}`)
  return values[0]
}
function sameBody(left: Json, right: Json) {
  const fields = ["content", "related_description", ...Object.keys(right).filter(key => key.endsWith("_requirement_description"))]
  return fields.some(key => typeof right[key] === "string" && right[key]) &&
    fields.every(key => String(left[key] ?? "") === String(right[key] ?? ""))
}
function rawRowsIndex(rows: Json[], request: Phase2EditorRequest, finalRows: Json[]) {
  if (!request.business_id) return -1
  const direct = rows.map((row, index) => ({row, index})).filter(({row}) => (row.requirement_id || row.test_requirement_id) === request.business_id)
  if (direct.length) return uniqueTarget(direct, "测试需求").index
  const finals = finalRows.filter(row => (row.requirement_id || row.test_requirement_id) === request.business_id)
  if (finals.length !== 1) return -1
  const matches = rows.map((row, index) => ({row, index})).filter(({row}) => sameBody(row, finals[0]))
  return matches.length ? uniqueTarget(matches, "测试需求正文").index : -1
}
function nonFunctionalTarget(request: Phase2EditorRequest) {
  const config = NON_FUNCTIONAL[request.artifact]
  if (!config) return null
  const rawFile = dataPath(request.directory, config.raw), finalFile = dataPath(request.directory, config.final)
  const raw = readJson(rawFile), final = readJson(finalFile)
  const index = rawRowsIndex(raw.rows || [], request, final.rows || [])
  if (request.business_id && index < 0) throw new Error("未找到测试需求")
  return {config, rawFile, raw, files: [rawFile], collection: raw.rows as Json[], index}
}
function findFunctionalTarget(request: Phase2EditorRequest) {
  const files = [dataPath(request.directory, "functional-init-content.raw.json")]
  const otherDir = dataPath(request.directory, "functional-other-content-leaves")
  if (existsSync(otherDir)) files.push(...readdirSync(otherDir).filter(name => name.endsWith(".json")).map(name => join(otherDir, name)))
  const matches: any[] = []
  const fallbacks: any[] = [], finalTargets: Json[] = []
  const finalFile = dataPath(request.directory, "functional-test-content.json")
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return
    if (request.business_id ? node.requirement_id === request.business_id
      : Array.isArray(node.processing) && node.title_no === (request.container_id || request.identity?.title_no)) finalTargets.push(node)
    Object.values(node).forEach(visit)
  }
  if (existsSync(finalFile)) visit(readJson(finalFile))
  for (const file of files.filter(existsSync)) {
    let raw: Json
    try { raw = readJson(file) } catch { continue }
    for (const item of raw.items || []) {
      if (finalTargets.length === 1) {
        const finalTarget = finalTargets[0]
        if (request.business_id) {
          for (const [index, entry] of (item.processing || []).entries()) {
            if (sameBody(entry, finalTarget)) fallbacks.push({rawFile: file, raw, files: [file], collection: item.processing, index, prefix: String(request.business_id).replace(/-\d+$/, ""), item})
          }
        } else if (["source_ref", "title"].some(key => finalTarget[key] && String(item[key] || "").trim() === String(finalTarget[key]).trim())) {
          fallbacks.push({rawFile: file, raw, files: [file], collection: item.processing, index: -1, prefix: finalTarget.tr_code || item.tr_code, item})
        }
      }
      const indexes = (item.processing || []).map((entry: Json, index: number) => ({entry, index})).filter(({entry}: any) => entry.requirement_id === request.business_id)
      if (request.business_id) {
        for (const {index} of indexes) matches.push({rawFile: file, raw, files: [file], collection: item.processing, index, prefix: item.tr_code, item})
      } else if ((request.container_id || request.identity?.title_no) === item.title_no) {
        matches.push({rawFile: file, raw, files: [file], collection: item.processing, index: -1, prefix: item.tr_code, item})
      }
    }
  }
  return uniqueTarget(matches.length ? matches : fallbacks, "功能测试需求")
}
function findInterfaceTarget(request: Phase2EditorRequest) {
  const dir = dataPath(request.directory, "interface-test-content-batches")
  const files = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".raw.json")).map(name => join(dir, name)) : []
  const finalFile = dataPath(request.directory, "interface-test-content.json")
  const final = existsSync(finalFile) ? readJson(finalFile) : {rows: []}
  const matches: any[] = []
  for (const file of files) {
    let raw: Json
    try { raw = readJson(file) } catch { continue }
    const index = rawRowsIndex(raw.rows || [], request, final.rows || [])
    if (request.business_id ? index >= 0 : request.identity?.interface_id === raw.interface_id) {
      matches.push({rawFile: file, raw, files: [file], collection: raw.rows, index, prefix: "TR-JK", item: raw})
    }
  }
  return uniqueTarget(matches, "接口测试需求")
}

function locate(request: Phase2EditorRequest): any {
  if (!INLINE_FIELDS[request.artifact]) throw new Error("编辑工件不在允许目录及白名单中")
  const mapped = mappedEditorTarget(request)
  if (mapped) return { ...mapped, config: NON_FUNCTIONAL[request.artifact] }
  const nf = nonFunctionalTarget(request)
  if (nf) return nf
  if (request.artifact === "chapter1-scope.json") {
    const rawFile = dataPath(request.directory, "chapter1-scope.raw.json")
    return { rawFile, raw: readJson(rawFile), files: [rawFile], object: true }
  }
  if (request.artifact === "chapter2-system-overview.json") {
    const rawFile = dataPath(request.directory, "chapter2-system-overview.raw.json")
    return { rawFile, raw: readJson(rawFile), files: [rawFile], object: true }
  }
  if (request.artifact === "hardware-interface-model.json") {
    const blockDir = dataPath(request.directory, "hardware-interface-blocks")
    const interfaceId = request.identity?.interface_id, candidateId = request.identity?.candidate_id
    const matches: any[] = []
    for (const rawFile of existsSync(blockDir) ? readdirSync(blockDir).filter((name) => name.endsWith(".raw.json")).map((name) => join(blockDir, name)) : []) {
      let raw: Json
      try { raw = readJson(rawFile) } catch { continue }
      const item = raw.interface || raw
      if (item.interface_id !== interfaceId && item.candidate_id !== candidateId) continue
      matches.push({ rawFile, raw, files: [rawFile], collection: [item], index: 0,
        readOnly: ["candidate_id", "interface_id", "interface_kind"] })
    }
    return uniqueTarget(matches, "硬件接口")
  }
  if (request.artifact === "functional-test-content.json") return findFunctionalTarget(request)
  if (request.artifact === "interface-test-content.json") return findInterfaceTarget(request)
  throw new Error(`不支持编辑工件 ${request.artifact}`)
}

export function describePhase2Editor(request: Phase2EditorRequest) {
  let target: any
  try { target = locate(request) } catch (error) {
    if (!(error instanceof UneditableTarget)) throw error
    const catalog = sourceCatalog(request.directory)
    return { artifact: request.artifact, business_id: request.business_id, editable: false, disabled_reason: error.message,
      operation_capabilities: {update: false, add: false, delete: false}, form_schema: [], value: {},
      warnings: catalog.warnings, skipped_count: catalog.skipped_count }
  }
  const catalog = sourceCatalog(request.directory)
  const value = target.object ? target.raw : target.index >= 0 ? target.collection[target.index] : {}
  const isRequirement = Boolean(request.business_id?.startsWith("TR-"))
  const hardware = request.artifact === "hardware-interface-model.json"
  return {
    artifact: request.artifact,
    business_id: request.business_id,
    revision: revisionOf(target.files),
    operation_capabilities: { update: true, add: !hardware && (isRequirement || request.artifact.startsWith("functional-") || Boolean(NON_FUNCTIONAL[request.artifact])), delete: !hardware && isRequirement },
    form_schema: formSchema({source_refs: [], ...value}, [...(target.readOnly || []), "requirement_id", "test_requirement_id", "table_refs", "tables"]),
    value: filteredView({source_refs: [], ...value}, new Set(catalog.options.map(option => option.value))),
    editable: true, warnings: catalog.warnings, skipped_count: catalog.skipped_count,
    available_source_refs: sourceOptions(request.directory),
  }
}

export function applyPhase2Editor(request: Phase2EditorRequest) {
  if (!request.operation) throw new Error("operation is required")
  const target = locate(request), revision = revisionOf(target.files)
  if (revision !== request.expected_revision) throw new Error("raw工件已发生变化，请刷新后重新编辑")
  const value = normalizedEdits(request.directory, request.value || {})
  let assignedId = request.business_id
  let previousValue: Json | undefined
  if (target.object) {
    if (request.operation !== "update") throw new Error("章节根对象只允许update")
    target.raw = { ...target.raw, ...value }
  } else if (request.operation === "update") {
    if (target.index < 0) throw new Error("目标测试需求不存在")
    const current = target.collection[target.index]
    previousValue = structuredClone(current)
    const protectedFields = ["requirement_id", "test_requirement_id", "table_refs", "tables", ...(target.readOnly || [])]
    Object.assign(current, { ...value, ...Object.fromEntries(protectedFields.filter((key) => key in current).map((key) => [key, current[key]])) })
  } else if (request.operation === "delete") {
    if (target.index < 0 || !request.business_id) throw new Error("目标测试需求不存在")
    previousValue = structuredClone(target.collection[target.index])
    target.collection.splice(target.index, 1)
    tombstone(request.directory, request.business_id)
  } else {
    const existing = target.collection.map((row: Json) => row.requirement_id || row.test_requirement_id).filter(Boolean)
    assignedId = allocateId(request.directory, target.config?.prefix || target.prefix, existing)
    const idKey = request.artifact === "interface-test-content.json" ? "test_requirement_id" : "requirement_id"
    const editable = { ...value }
    for (const key of ["requirement_id", "test_requirement_id", "table_refs", "tables", ...(target.readOnly || [])]) delete editable[key]
    target.collection.push({ ...editable, [idKey]: assignedId, ...(target.item?.interface_id ? { interface_name: target.item.interface_name, interface_id: target.item.interface_id } : {}) })
  }
  writeJsonAtomic(target.rawFile, target.raw)
  return { ok: true, artifact: request.artifact, operation: request.operation, requirement_id: assignedId,
    previous_value: previousValue, revision: revisionOf(target.files), raw_path: target.rawFile }
}

function sharedTarget(located: any, targets: Map<string, any>) {
  const shared = targets.get(located.rawFile)
  if (!shared || shared === located) return located
  const findPath = (node: any, wanted: any, path: string[] = []): string[] | undefined => {
    if (node === wanted) return path
    if (!node || typeof node !== "object") return undefined
    for (const [key, child] of Object.entries(node)) {
      const found = findPath(child, wanted, [...path, key])
      if (found) return found
    }
    return undefined
  }
  const rebind = (value: any) => {
    const path = findPath(located.raw, value)
    return path ? path.reduce((node: any, key) => node?.[key], shared.raw) : value
  }
  return {...located, raw: shared.raw, item: rebind(located.item),
    collection: findPath(located.raw, located.collection) ? rebind(located.collection) : located.collection?.map(rebind)}
}

export function applyPhase2InlineBatch(request: Phase2InlineBatchRequest) {
  const changes = Array.isArray(request.changes) ? request.changes : [], operations = Array.isArray(request.table_operations) ? request.table_operations : []
  const requirementOperations = Array.isArray(request.requirement_operations) ? request.requirement_operations : []
  const referenceOperations = Array.isArray(request.reference_operations) ? request.reference_operations : []
  if (!changes.length && !operations.length && !requirementOperations.length && !referenceOperations.length) throw new Error("编辑操作不能为空")
  const decoded = changes.map(change => ({...change, key: decodePhase2EditKey(change.edit_key)}))
  if (decoded.some(item => item.key.artifact === "chapter1-scope.json" && item.key.field === "references")) {
    throw new Error("references必须通过reference_operations修改")
  }
  const decodedOperations = operations.map(operation => ({...operation, key: decodePhase2EditKey(operation.container_key),
    row: operation.row_key ? decodePhase2EditKey(operation.row_key) : undefined,
    column: operation.column_key ? decodePhase2EditKey(operation.column_key) : undefined})).sort((left, right) => {
      const rank = (value: string) => value === "delete_column" ? 0 : value === "delete_row" ? 1 : value === "add_column" ? 2 : 3
      const difference = rank(left.operation) - rank(right.operation); if (difference) return difference
      const indexOf = (value?: InlineKey) => Number(value?.field.match(/\.(\d+)$/u)?.[1] || -1)
      return indexOf(right.row || right.column) - indexOf(left.row || left.column)
    })
  const decodedRequirementOperations = requirementOperations.map(operation => ({...operation,
    key: decodePhase2EditKey(operation.container_key),
    requirement: operation.requirement_key ? decodePhase2EditKey(operation.requirement_key) : undefined}))
  const decodedReferenceOperations = referenceOperations.map(operation => ({...operation, key: decodePhase2EditKey(operation.container_key)}))
  const targets = new Map<string, any>()
  for (const item of [...decoded, ...decodedOperations, ...decodedRequirementOperations, ...decodedReferenceOperations]) {
    const requirementBusinessId = "requirement" in item ? item.requirement?.business_id : undefined
    const keyRequest: Phase2EditorRequest = {directory: request.directory, artifact: item.key.artifact,
      business_id: item.key.business_id || requirementBusinessId, container_id: item.key.container_id, identity: item.key.identity}
    const target = locate(keyRequest), mapKey = target.rawFile
    if (!targets.has(mapKey)) targets.set(mapKey, target)
  }
  for (const decodedItem of [...decoded, ...decodedOperations]) {
    const target = locate({directory: request.directory, ...decodedItem.key})
    for (const [from, to] of Object.entries(target.fieldMap || {})) {
      if (decodedItem.key.field === from || decodedItem.key.field.startsWith(from + ".")) {
        decodedItem.key.field = String(to) + decodedItem.key.field.slice(from.length); break
      }
    }
  }
  const files = inlineEditorFiles(request.directory)
  const editedArtifacts = new Set([...decoded, ...decodedOperations, ...decodedRequirementOperations, ...decodedReferenceOperations]
    .map(item => item.key.artifact))
  if (request.expected_artifact_revisions) {
    for (const artifact of editedArtifacts) {
      const expected = request.expected_artifact_revisions[artifact]
      const current = revisionOf(inlineEditorFilesByArtifact(request.directory)[artifact] || [])
      if (!expected || current !== expected) throw new Error(`${artifact}的raw工件已发生变化，请刷新后重新编辑`)
    }
  } else if (revisionOf(files) !== request.expected_revision) {
    throw new Error("raw工件已发生变化，请刷新后重新编辑")
  }
  const options = sourceOptions(request.directory)
  for (const item of decoded.filter(item => item.key.field !== "requirement_id_suffix")) {
    const target = sharedTarget(locate({directory: request.directory, artifact: item.key.artifact,
      business_id: item.key.business_id, container_id: item.key.container_id, identity: item.key.identity}), targets)
    const base = target.object ? target.raw : target.index >= 0 ? target.collection[target.index] : target.item
    if (!base) throw new Error(`找不到edit_key对应内容: ${item.key.field}`)
    if (item.key.field === "source_refs" || item.key.field.endsWith(".source_refs")) {
      setPath(base, item.key.field, requireCanonicalPrimaryRefs(request.directory, item.value, "编辑"))
    } else if (item.key.field === "related_description") {
      setPath(base, item.key.field, validatedRelatedDescription(item.key.artifact, item.value))
    } else if (/(?:^|\.)\w+_tables$/u.test(item.key.field)) {
      if (!Array.isArray(item.value)) throw new Error("引用表格选择必须是table_id数组")
      const available = new Map(sourceTables(request.directory).map(item => [item.table_id, item]))
      const ids = item.value.map(String)
      setPath(base, item.key.field, ids.map(table_id => ({table_id})))
      const ownerRefs = ids.map(id => available.get(id)?.source_ref).filter(Boolean) as string[]
      const sourceField = "source_refs"
      const current = pathParts(sourceField).reduce((value: any, key: any) => value?.[key], base)
      setPath(base, sourceField, [...new Set([...(Array.isArray(current) ? current : []), ...ownerRefs])])
    } else {
      const functionalCell = item.key.artifact === "functional-test-content.json"
        ? item.key.field.match(/^tables\.(\d+)\.(columns\.(\d+)|rows\.(\d+)\.(\d+))$/u) : undefined
      const table = functionalCell ? base.tables?.[Number(functionalCell[1])] : undefined
      const objectRows = Array.isArray(table?.rows) && table.rows.some((row: unknown) => row && typeof row === "object" && !Array.isArray(row))
      if (functionalCell && table && objectRows) {
        if (functionalCell[3] !== undefined) {
          const columnIndex = Number(functionalCell[3]), oldColumn = String(table.columns?.[columnIndex] || ""), newColumn = String(item.value || "")
          table.columns[columnIndex] = newColumn
          if (oldColumn !== newColumn) for (const row of table.rows) {
            if (!row || typeof row !== "object" || Array.isArray(row)) continue
            row[newColumn] = row[oldColumn] ?? ""
            delete row[oldColumn]
          }
        } else {
          const rowIndex = Number(functionalCell[4]), columnIndex = Number(functionalCell[5]), column = String(table.columns?.[columnIndex] || "")
          if (!column || !table.rows[rowIndex] || Array.isArray(table.rows[rowIndex])) throw new Error("功能表格单元格路径无效")
          table.rows[rowIndex][column] = item.value
        }
      } else setPath(base, item.key.field, item.value)
    }
  }
  for (const operation of decodedOperations) {
    const target = sharedTarget(locate({directory: request.directory, artifact: operation.key.artifact,
      business_id: operation.key.business_id, container_id: operation.key.container_id, identity: operation.key.identity}), targets)
    const base = operation.key.field === "rows" && Array.isArray(target.raw?.rows) ? target.raw : target.object ? target.raw : target.index >= 0 ? target.collection[target.index] : target.item
    const container = pathParts(operation.key.field).reduce((value: any, key: any) => value?.[key], base)
    const editableMatrix = operation.key.artifact === "chapter2-system-overview.json" && /^memory_io_tables\.\d+$/u.test(operation.key.field)
      || operation.key.artifact === "functional-test-content.json" && /^tables\.\d+$/u.test(operation.key.field)
    if (editableMatrix) {
      if (!container || !Array.isArray(container.columns) || !Array.isArray(container.rows)) throw new Error("动态表格结构无效")
      if (operation.operation === "add_row") {
        const values = Array.isArray(operation.initial_value) ? operation.initial_value.map(String) : []
        const usesObjectRows = operation.key.artifact === "functional-test-content.json"
          && container.rows.some((row: unknown) => row && typeof row === "object" && !Array.isArray(row))
        const row = usesObjectRows
          ? Object.fromEntries(container.columns.map((column: string, columnIndex: number) => [column, values[columnIndex] || ""]))
          : container.columns.map((_: string, columnIndex: number) => values[columnIndex] || "")
        container.rows.push(row)
      }
      else if (operation.operation === "delete_row") {
        const rowIndex = Number(operation.row?.field.match(/\.rows\.(\d+)$/u)?.[1]); if (!Number.isInteger(rowIndex)) throw new Error("row_key无效")
        container.rows.splice(rowIndex, 1)
      } else if (operation.operation === "add_column") {
        const columnDraft = operation.initial_value && typeof operation.initial_value === "object" && !Array.isArray(operation.initial_value)
          ? operation.initial_value as Json : undefined
        const title = columnDraft ? String(columnDraft.title || "") : typeof operation.initial_value === "string" ? operation.initial_value : "新列"
        const values = Array.isArray(columnDraft?.values) ? columnDraft.values.map(String) : []
        container.columns.push(title)
        for (const [rowIndex, row] of container.rows.entries()) {
          if (Array.isArray(row)) row.push(values[rowIndex] || "")
          else if (row && typeof row === "object") row[title] = values[rowIndex] || ""
        else throw new Error(`动态表格第${rowIndex + 1}行既不是数组也不是对象: ${JSON.stringify(row)}`)
        }
      } else {
        const columnIndex = Number(operation.column?.field.match(/\.columns\.(\d+)$/u)?.[1]); if (!Number.isInteger(columnIndex)) throw new Error("column_key无效")
        const removedColumn = String(container.columns[columnIndex] || "")
        container.columns.splice(columnIndex, 1)
        for (const [rowIndex, row] of container.rows.entries()) {
          if (Array.isArray(row)) row.splice(columnIndex, 1)
          else if (row && typeof row === "object") delete row[removedColumn]
          else throw new Error(`动态表格第${rowIndex + 1}行既不是数组也不是对象`)
        }
      }
      for (const [rowIndex, row] of container.rows.entries()) {
        if (Array.isArray(row)) { while (row.length < container.columns.length) row.push(""); row.length = container.columns.length }
        else if (row && typeof row === "object") {
          for (const column of container.columns) if (!(column in row)) row[column] = ""
        } else throw new Error(`动态表格第${rowIndex + 1}行既不是数组也不是对象: ${JSON.stringify(row)}`)
      }
    } else if (operation.key.field === "interrupts") {
      if (!Array.isArray(container)) throw new Error("中断表结构无效")
      if (operation.operation === "add_row") {
        const values = Array.isArray(operation.initial_value) ? operation.initial_value.map(String) : []
        container.push(Object.fromEntries(["interrupt_name", "priority", "frequency_or_random", "trigger_mode", "execution_function"].map((key, index) => [key, values[index] || ""])))
      }
      else if (operation.operation === "delete_row") {
        const rowIndex = Number(operation.row?.field.match(/^interrupts\.(\d+)$/u)?.[1]); if (!Number.isInteger(rowIndex)) throw new Error("row_key无效")
        container.splice(rowIndex, 1)
      } else throw new Error("固定业务表不允许增删列")
    } else if (operation.key.field === "rows" && target.config && Array.isArray(container)) {
      if (operation.operation === "add_row") {
        const existing = container.map((row: Json) => row.requirement_id).filter(Boolean)
        const requirement_id = allocateId(request.directory, target.config.prefix, existing)
        const firstPrimary = options.find(item => item.value.startsWith("primary::"))?.value
        const values = Array.isArray(operation.initial_value) ? operation.initial_value.map(String) : []
        container.push({requirement_id, [target.config.description]: values[0] || "", related_description: values[1] || "", source_refs: firstPrimary ? [firstPrimary] : []})
      } else if (operation.operation === "delete_row") {
        const rowIndex = Number(operation.row?.field.match(/^rows\.(\d+)$/u)?.[1]); if (!Number.isInteger(rowIndex) || !container[rowIndex]) throw new Error("row_key无效")
        const id = String(container[rowIndex].requirement_id || ""); container.splice(rowIndex, 1); if (id) tombstone(request.directory, id)
      } else throw new Error("测试需求表不允许增删列")
    } else throw new Error("container_key不在表格结构操作白名单中")
  }
  const renames: Array<{from: string; to: string}> = []
  const knownIds = allRequirementIds(request.directory)
  for (const item of decoded.filter(item => item.key.field === "requirement_id_suffix")) {
    if (item.key.artifact !== "functional-test-content.json" || !item.key.business_id) throw new Error("requirement_id_suffix仅允许用于功能TR")
    const located = locate({directory: request.directory, artifact: item.key.artifact, business_id: item.key.business_id})
    const target = sharedTarget(located, targets)
    const current = target.collection[target.index]
    const oldId = String(item.key.business_id || current.requirement_id || "")
    const newId = normalizedRequestedId(request.directory, target.prefix, item.value, knownIds, oldId)
    if (newId !== oldId) {
      current.requirement_id = newId
      tombstone(request.directory, oldId)
      const knownIndex = knownIds.indexOf(oldId)
      if (knownIndex >= 0) knownIds.splice(knownIndex, 1, newId)
      else knownIds.push(newId)
      renames.push({from: oldId, to: newId})
    }
  }
  for (const operation of decodedRequirementOperations) {
    if (!["functional-test-content.json", "interface-test-content.json", ...Object.keys(NON_FUNCTIONAL)].includes(operation.key.artifact)) {
      throw new Error("container_key不在测试需求结构操作白名单中")
    }
    const located = locate({directory: request.directory, artifact: operation.key.artifact,
      business_id: operation.requirement?.business_id, container_id: operation.key.container_id, identity: operation.key.identity})
    const target = sharedTarget(located, targets)
    const collection = target.collection as Json[]
    if (!Array.isArray(collection)) throw new Error("测试需求容器结构无效")
    if (operation.operation === "delete_requirement") {
      const id = operation.requirement?.business_id
      const index = target.index
      if (!id || index < 0) throw new Error("requirement_key对应的TR不存在")
      collection.splice(index, 1); tombstone(request.directory, id)
      continue
    }
    const initial = operation.initial_value || {source_refs: []}
    const refs = requireCanonicalPrimaryRefs(request.directory, initial.source_refs, "新增TR")
    const prefix = target.config?.prefix || target.prefix
    const relatedDescription = operation.key.artifact === "functional-test-content.json"
      ? "" : validatedRelatedDescription(operation.key.artifact, initial.related_description)
    let id: string
    if (operation.key.artifact === "functional-test-content.json" && operation.requested_suffix?.trim()) {
      id = normalizedRequestedId(request.directory, prefix, operation.requested_suffix, knownIds)
    } else id = allocateId(request.directory, prefix, knownIds)
    knownIds.push(id)
    if (operation.key.artifact === "functional-test-content.json") {
      collection.push({requirement_id: id, source_refs: refs, content: String(initial.content || ""), table_refs: []})
    } else if (operation.key.artifact === "interface-test-content.json") {
      collection.push({interface_requirement_description: String(initial.description || ""), test_requirement_id: id,
        source_refs: refs, related_description: relatedDescription,
        interface_name: String(target.raw.interface_name || ""), interface_id: String(target.raw.interface_id || "")})
    } else {
      collection.push({requirement_id: id, [target.config.description]: String(initial.description || ""),
        related_description: relatedDescription, source_refs: refs})
    }
  }
  const reservedReferenceIds = new Set([
    "TE-GTCG-003-2021", "QJ 3027A-2016", "Q/QJA 300-2014", "GB/T 25000.51-2016", "GB/T 25000.10-2016", "五办[2011]479号", "QMS-LAB-ST-CX01",
    "Q/W-Q80-18-01-2014", "Q/W 1141-2007", "Q/W 1139-2007", "WY-MARS-1JY167", "CMS-RW-04", "ZR-KJZXZ004"
  ].map(value => value.trim().toUpperCase()))
  for (const operation of decodedReferenceOperations) {
    if (operation.key.artifact !== "chapter1-scope.json" || operation.key.field !== "references") throw new Error("引用文档操作仅允许修改第一章项目引用")
    const target = sharedTarget(locate({directory: request.directory, artifact: operation.key.artifact}), targets)
    if (target?.raw?.references === undefined) target.raw.references = []
    const references = target?.raw?.references
    if (!Array.isArray(references)) throw new Error("第一章references结构无效")
    const referenceKey = String(operation.reference_key || "").trim(), normalizedKey = referenceKey.toUpperCase()
    const index = references.findIndex((item: Json) => String(item.document_id || "").trim().toUpperCase() === normalizedKey)
    const immutable = index >= 0 && ["programming_language", "conditional"].includes(String(references[index]?.source_kind || ""))
    if (operation.operation === "delete_reference") {
      if (!referenceKey || index < 0) throw new Error("待删除的项目引用不存在")
      if (immutable) throw new Error("固定或自动维护的引用文档不允许删除")
      references.splice(index, 1)
      continue
    }
    const documentId = String(operation.initial_value?.document_id || "").trim()
    const documentTitle = String(operation.initial_value?.document_title || "").trim()
    if (!documentId || !documentTitle) throw new Error("引用文档标识和名称不能为空")
    const normalizedId = documentId.toUpperCase()
    if (reservedReferenceIds.has(normalizedId)) throw new Error(`引用文档标识与固定或自动维护条目重复: ${documentId}`)
    const duplicate = references.findIndex((item: Json) => String(item.document_id || "").trim().toUpperCase() === normalizedId)
    if (operation.operation === "add_reference") {
      if (duplicate >= 0) throw new Error(`引用文档标识已存在: ${documentId}`)
      references.push({document_id: documentId, document_title: documentTitle, source_kind: "manual_edit", evidence: "在线编辑添加"})
    } else {
      if (!referenceKey || index < 0) throw new Error("待修改的项目引用不存在")
      if (immutable) throw new Error("固定或自动维护的引用文档不允许修改")
      if (duplicate >= 0 && duplicate !== index) throw new Error(`引用文档标识已存在: ${documentId}`)
      references[index] = {...references[index], document_id: documentId, document_title: documentTitle}
    }
  }
  for (const target of targets.values()) writeJsonAtomic(target.rawFile, target.raw)
  return {ok: true, artifacts: [...new Set([...decoded, ...decodedOperations, ...decodedRequirementOperations, ...decodedReferenceOperations].map(item => item.key.artifact))], raw_paths: [...targets.keys()],
    revision: revisionOf(files), changes: decoded.map(item => ({edit_key: item.edit_key, field: item.key.field})), requirement_id_renames: renames}
}

const inlineDescriptorCache = new Map<string, { signature: string; value: Json }>()

function inlineEditorSignature(directory: string) {
  const files = [...inlineEditorFiles(directory)], manifestPath = dataPath(directory, "source-artifacts.json")
  if (existsSync(manifestPath)) {
    files.push(manifestPath)
    let manifest: Json
    try { manifest = readJson(manifestPath) } catch { manifest = {} }
    const documents = [manifest.primary_document, ...(manifest.supporting_documents || [])].filter(Boolean)
    for (const document of documents) {
      const structurePath = String(document.structure_path || "")
      if (structurePath) files.push(isAbsolute(structurePath) ? structurePath : resolve(directory, structurePath))
    }
  }
  return [...new Set(files)].sort().map(file => {
    try {
      const stat = statSync(file)
      return `${file}\0${stat.size}\0${stat.mtimeMs}`
    } catch { return `${file}\0missing` }
  }).join("\0")
}

export function describePhase2InlineEditor(directory: string) {
  const cacheKey = resolve(directory), signature = inlineEditorSignature(directory)
  const cached = inlineDescriptorCache.get(cacheKey)
  if (cached?.signature === signature) return cached.value
  const scanWarnings: string[] = []
  const assigned = hardwareAssignments(directory, scanWarnings)
  const artifactRevisions = Object.fromEntries(Object.entries(inlineEditorFilesByArtifact(directory))
    .map(([artifact, files]) => [artifact, revisionOf(files)]))
  const catalog = sourceCatalog(directory)
  const value = {ok: true, warnings: [...catalog.warnings, ...scanWarnings], skipped_count: catalog.skipped_count + scanWarnings.length, revision: revisionOf(inlineEditorFiles(directory)), artifact_revisions: artifactRevisions, available_source_refs: catalog.options,
    available_tables: sourceTables(directory).map(item => ({...item, selected_location: assigned.get(item.table_id)}))}
  inlineDescriptorCache.set(cacheKey, {signature, value})
  return value
}

function inlineEditorFilesByArtifact(directory: string): Record<string, string[]> {
  const root = dataPath(directory, "")
  const existing = (...values: string[]) => values.map(value => join(root, value)).filter(existsSync)
  const folder = (value: string) => {
    const target = join(root, value)
    return existsSync(target) ? readdirSync(target).filter(name => name.endsWith(".json")).map(name => join(target, name)) : []
  }
  return {
    "chapter1-scope.json": existing("chapter1-scope.raw.json"),
    "chapter2-system-overview.json": existing("chapter2-system-overview.raw.json"),
    "hardware-interface-model.json": folder("hardware-interface-blocks"),
    "functional-test-content.json": [...existing("functional-init-content.raw.json"), ...folder("functional-other-content-leaves")],
    "interface-test-content.json": folder("interface-test-content-batches"),
    "performance-test-content.json": existing("performance.raw.json"),
    "reliability-safety-test-content.json": existing("reliability-safety.raw.json"),
    "margin-test-content.json": existing("margin.raw.json"),
    "boundary-test-content.json": existing("boundary.raw.json"),
    "data-processing-test-content.json": existing("data-processing.raw.json"),
    "recovery-test-content.json": existing("recovery.raw.json"),
    "strength-test-content.json": existing("strength.raw.json"),
  }
}

function inlineEditorFiles(directory: string) {
  const root = dataPath(directory, "")
  const names = ["chapter1-scope.raw.json", "chapter2-system-overview.raw.json", "performance.raw.json",
    "reliability-safety.raw.json", "margin.raw.json", "boundary.raw.json", "data-processing.raw.json", "recovery.raw.json", "strength.raw.json"]
  const files = names.map(name => join(root, name)).filter(existsSync)
  for (const folder of ["hardware-interface-blocks", "functional-other-content-leaves", "interface-test-content-batches"]) {
    const value = join(root, folder)
    if (existsSync(value)) files.push(...readdirSync(value).filter(name => name.endsWith(".json")).map(name => join(value, name)))
  }
  const init = join(root, "functional-init-content.raw.json"); if (existsSync(init)) files.push(init)
  return files
}
