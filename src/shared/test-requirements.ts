import { existsSync, readFileSync } from "fs"
import { basename } from "path"
import type {
  TestRequirementsArtifact,
  TestRequirementFlatArtifact,
  TestRequirementFlatItem,
} from "../schema/test-requirement"
import {
  TestRequirementFlatArtifact as TestRequirementFlatArtifactSchema,
  isFlatTestRequirements,
  normalizeFlatFieldNames,
} from "../schema/test-requirement"

export interface NormalizedTestRequirement {
  id: string
  source_requirement_ids: string[]
  title: string
  description: string
  type: string
  priority: string
  verification_method: string
  verification_criteria: string
  adequacy_requirements: string[]
  termination_requirement?: string
  input_flows: string[]
  processing?: string
  output_flows: string[]
}

export interface RequirementIndexEntry {
  requirement_id: string
  category_key: string
  path: string
  title_no: string
  chapter_title: string
  chapter_background: string
  handling: string
  name: string
  inputFlow?: string
  outputFlow?: string
  /** Same-project protocol context used by stress generation and all validation entry points. */
  protocolContext?: string
  /** Missing protocol sources shared by generation, direct append, and review gates. */
  contextGaps?: string[]
  /**
   * The authored 、-subtoken of the funId element that expanded to this id
   * (e.g. "TR-GN-SWRC-001~006" or "TR-JK-001"). Used to recompose
   * correspond_fun_id in the requirements file's own authored form.
   */
  fun_id_token?: string
  /**
   * 0-based position of the owning funItem in test-requirements.json file order.
   * correspond_fun_id must equal the whole owning funItem's funId, and the
   * suite's case order must follow the funItem order — both need this ordinal.
   */
  item_index: number
  /**
   * The owning funItem's full authored funId form (funId elements joined with
   * 、, range tokens preserved as authored, e.g. "TR-JK-001、TR-JK-002" or
   * "TR-GN-SWRC-001~006"). correspond_fun_id canonicalizes to exactly this.
   */
  item_fun_id_form: string
}

export interface Phase6ArtifactMeta {
  software_id: string
  code_version: string
  project_id: string
  doc_type: number | null
}

export interface Phase6SuiteMeta {
  project_name: string
  version: string
  software_id: string
  code_version: string
}

export interface PreparedPhase6Requirement {
  requirement_id: string
  source_requirement_ids: string[]
  title: string
  title_no: string
  path: string
  category_key: string
  chapter_title: string
  chapter_background: string
  test_type: string
  priority: string
  handling: string
  name: string
  sufficiency: string | null
  test_method: string
  pass_criteria: string
  inputFlow: string
  outputFlow: string
  /** Requirement-level context (flat format; maps to {tr_summary} in test-*.md templates) */
  requirementContext?: string
  /** Test constraints (flat format; maps to {tr_testConstraint} in test-*.md templates) */
  constraintContext?: string
  /** 中断上下文(SpaceWire 等中断触发类接口;flat 格式可选字段,存在才进入生成提示 */
  interruptContext?: string
}

export interface PreparedPhase6Input {
  artifact: TestRequirementFlatArtifact
  artifact_meta: Phase6ArtifactMeta
  suite_meta: Phase6SuiteMeta
  requirements: PreparedPhase6Requirement[]
}

interface Phase6ProjectMetaSource {
  csci_name?: string
  version?: string
  doc_id?: string
}

const HIGH_PRIORITY_TOKENS = ["critical", "high", "高", "严重"]
const MEDIUM_PRIORITY_TOKENS = ["medium", "中"]
const LOW_PRIORITY_TOKENS = ["low", "低"]

const INSPECTION_TOKENS = ["inspection", "审查", "走查"]
const ANALYSIS_TOKENS = ["analysis", "分析", "静态"]
const DEMONSTRATION_TOKENS = ["demonstration", "演示"]

/** CHINESE_TO_TYPE: maps Chinese test type names to English type keys. */
const CHINESE_TO_TYPE: Record<string, string> = {
  "功能测试": "functional",
  "性能测试": "performance",
  "接口测试": "interface",
  "安全性测试": "safety",
  "可靠性安全性测试": "safety",
  "边界测试": "boundary",
  "强度测试": "stress",
  "余量测试": "margin",
  "数据处理测试": "data_processing",
  "恢复性测试": "recovery",
  "逻辑测试": "logic",
  "时序测试": "timing",
}

export function normalizeTestRequirements(
  artifact: TestRequirementsArtifact | Record<string, unknown> | null | undefined,
): NormalizedTestRequirement[] {
  if (!artifact || typeof artifact !== "object") return []

  if (isFlatTestRequirements(artifact)) {
    return artifact.funItem
      .filter((rawItem) => Array.isArray(rawItem.funId) && rawItem.funId.length > 0)
      .map((rawItem) => {
        // 原始 JSON 可能使用 testType(驼峰),先统一字段名再取值
        const item = normalizeFlatFieldNames(rawItem) as TestRequirementFlatItem
        return {
          id: item.funId.join("、"),
          source_requirement_ids: item.funId,
          title: textOf(item.title),
          description: textOf(item.processingContext),
          // 使用项目自带的测试类型;映射表不认识的自定义类型保留原文,不静默降级为 functional
          type: CHINESE_TO_TYPE[item.test_type] ?? item.test_type,
          priority: "medium",
          verification_method: "test",
          verification_criteria: textOf(item.constraintContext) || textOf(item.processingContext),
          adequacy_requirements: [],
          termination_requirement: undefined,
          input_flows: textOf(item.inputFlowContext) ? [textOf(item.inputFlowContext)] : [],
          processing: textOf(item.processingContext) || undefined,
          output_flows: textOf(item.outputFlowContext) ? [textOf(item.outputFlowContext)] : [],
        }
      })
  }

  return []
}

export function buildRequirementIndex(
  artifact: TestRequirementsArtifact | Record<string, unknown> | null | undefined,
): Map<string, RequirementIndexEntry> {
  if (!artifact || typeof artifact !== "object") return new Map()

  if (!isFlatTestRequirements(artifact)) return new Map()

  // Index construction remains permissive for partial artifacts. Use the same
  // preparation function as generation without imposing new schema requirements
  // (e.g. a title) on callers which only need requirement identifiers.
  const preparedRequirements = artifact.funItem.map((rawItem) => prepareFlatPhase6Requirement(
    normalizeFlatFieldNames(rawItem) as TestRequirementFlatItem,
    "",
  ))
  const entries: RequirementIndexEntry[] = []
  let itemIndex = -1
  for (const rawItem of artifact.funItem) {
    itemIndex += 1
    // 原始 JSON 可能使用 testType(驼峰),先统一字段名再取值;
    // chapter_title 在此承载项目自带的测试类型(如"接口测试")。
    const item = normalizeFlatFieldNames(rawItem) as TestRequirementFlatItem
    const titleNo = textOf(item.titleNo)
    const itemFunIdForm = (item.funId ?? []).filter(Boolean).join("、")
    const prepared = preparedRequirements[itemIndex]
    const crossContext = prepared.test_type === "stress"
      ? findCrossRequirementContext(prepared, preparedRequirements)
      : null
    const protocolContext = crossContext ? JSON.stringify(crossContext, null, 2) : undefined
    const contextGaps = getStressProtocolContextGaps(prepared, crossContext)
    for (const funId of item.funId ?? []) {
      if (!funId) continue
      // funId elements may be range strings ("TR-GN-SWRC-001~006") or
      // multi-ID strings ("TR-GN-SPICJ-001~002、TR-GN-SPICJ-004"). Expand
      // them so cases referencing a single expanded ID still resolve to this
      // requirement entry and inherit its path/chapter_title. Each expanded
      // id also records its authored 、-subtoken so correspond_fun_id can be
      // recomposed in the requirements file's own form.
      for (const token of splitFunIds(funId)) {
        if (!token) continue
        for (const expandedId of expandFunIdString(token)) {
          entries.push({
            requirement_id: expandedId,
            category_key: extractRequirementCategoryKey(expandedId) ?? "UNK",
            path: titleNoToHierarchyPath(titleNo),
            title_no: titleNo,
            chapter_title: textOf(item.test_type) ?? "",
            chapter_background: textOf(item.requirementContext),
            handling: textOf(item.processingContext),
            name: textOf(item.title),
            inputFlow: textOf(item.inputFlowContext) || undefined,
            outputFlow: textOf(item.outputFlowContext) || undefined,
            ...(protocolContext ? { protocolContext } : {}),
            ...(contextGaps.length > 0 ? { contextGaps } : {}),
            fun_id_token: token,
            item_index: itemIndex,
            item_fun_id_form: itemFunIdForm,
          })
        }
      }
    }
  }

  return new Map(entries.map((entry) => [entry.requirement_id, entry]))
}

export function extractRequirementCategoryKey(requirementId: string): string | null {
  const parts = String(requirementId)
    .trim()
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length < 3 || parts[0].toUpperCase() !== "TR") return null
  const categoryParts = parts.slice(1).filter((_, index, items) => index !== items.length - 1)
  if (categoryParts.length === 0) return null
  return categoryParts.join("-").toUpperCase()
}

export function titleNoToHierarchyPath(titleNo: string | null | undefined): string {
  const normalized = String(titleNo ?? "")
    .trim()
    .replace(/^\.+|\.+$/g, "")

  if (!normalized) return "/"
  return `/${normalized.replace(/\./g, "/")}/`
}

/**
 * Convert a funId array to a range-based requirement ID string.
 * ["TR-JK-001","TR-JK-002","TR-JK-003","TR-JK-005"] → "TR-JK-001~003、TR-JK-005"
 */
export function formatFunIdsAsRange(funIds: string[]): string {
  if (!funIds || funIds.length === 0) return ""
  if (funIds.length === 1) return funIds[0]

  const sorted = [...funIds].sort()
  const groups: Array<{ prefix: string; start: number; end: number; origStart: string; origEnd: string }> = []

  // Parse each ID into prefix and numeric suffix
  const re = /^(.*[^\d])(\d+)$/
  for (const id of sorted) {
    const m = id.match(re)
    if (!m) {
      groups.push({ prefix: "", start: -1, end: -1, origStart: id, origEnd: id, _standalone: true } as any)
      continue
    }
    const prefix = m[1]
    const num = parseInt(m[2], 10)
    const numStr = m[2]  // preserve leading zeros from original string
    if (groups.length > 0) {
      const last = groups[groups.length - 1]
      if (last.prefix === prefix && last.end === num - 1) {
        last.end = num
        last.origEnd = numStr
        continue
      }
    }
    groups.push({ prefix, start: num, end: num, origStart: numStr, origEnd: numStr })
  }

  return groups.map((g) => {
    if ((g as any)._standalone) return (g as any).origStart
    if (g.start === g.end) return `${g.prefix}${g.origStart}`
    return `${g.prefix}${g.origStart}~${g.origEnd}`
  }).join("、")
}

/**
 * Split a 、-separated TR-ID string into individual IDs.
 * "TR-JK-001、TR-JK-002、TR-JK-003" → ["TR-JK-001", "TR-JK-002", "TR-JK-003"]
 */
export function splitFunIds(correspondFunId: string): string[] {
  return String(correspondFunId ?? "")
    .split("、")
    .map((s) => s.trim())
    .filter(Boolean)
}

const MAX_RANGE_EXPANSION = 500

/**
 * Split a 、-separated TR-ID string into individual IDs with ~ range expansion.
 *
 * Handles the ID forms that appear in real data and LLM output:
 *   "TR-JK-001~TR-JK-003"        → ["TR-JK-001", "TR-JK-002", "TR-JK-003"]
 *   "TR-GN-SPICJ-001~002"        → ["TR-GN-SPICJ-001", "TR-GN-SPICJ-002"]
 *   "TR-GN-SPICJ-001~002、TR-GN-SPICJ-004" → ["TR-GN-SPICJ-001", "TR-GN-SPICJ-002", "TR-GN-SPICJ-004"]
 *
 * Parts that cannot be parsed as numeric ranges are kept as-is.
 */
export function expandFunIdString(funIdString: string): string[] {
  const result: string[] = []
  for (const part of splitFunIds(funIdString)) {
    const tilde = part.indexOf("~")
    if (tilde === -1) {
      result.push(part)
      continue
    }

    const left = part.slice(0, tilde).trim()
    const right = part.slice(tilde + 1).trim()
    const leftMatch = left.match(/^(.*\D)(\d+)$/)
    if (!leftMatch) {
      result.push(part)
      continue
    }

    const startNum = parseInt(leftMatch[2], 10)
    const prefix = leftMatch[1]
    let endText: string
    // Full-range form ("TR-JK-001~TR-JK-003") repeats the prefix on the right.
    const rightMatch = right.match(/^(.*\D)(\d+)$/)
    if (rightMatch) {
      if (rightMatch[1] !== prefix) {
        result.push(part)
        continue
      }
      endText = rightMatch[2]
    } else if (/^\d+$/.test(right)) {
      endText = right
    } else {
      result.push(part)
      continue
    }

    const endNum = parseInt(endText, 10)
    if (!Number.isFinite(startNum) || !Number.isFinite(endNum) || endNum < startNum) {
      result.push(part)
      continue
    }
    // Guard against runaway ranges (e.g. TR-001~99999)
    if (endNum - startNum > MAX_RANGE_EXPANSION) {
      result.push(part)
      continue
    }

    const width = leftMatch[2].length
    for (let n = startNum; n <= endNum; n += 1) {
      result.push(`${prefix}${String(n).padStart(width, "0")}`)
    }
  }
  return [...new Set(result)]
}

/**
 * Compress TR-IDs into the human-readable range string used by
 * related_software_req_ids: consecutive numeric suffixes under the same
 * prefix collapse to "PREFIX-001~003" (end abbreviated to its numeric part).
 *
 *   ["TR-JK-001","TR-JK-002","TR-JK-003","TR-JK-005"] → "TR-JK-001~003、TR-JK-005"
 *
 * Inputs may themselves contain range forms; they are expanded first.
 * Non-numeric IDs are kept verbatim at the end.
 */
export function compressFunIdsToRangeString(ids: string[]): string {
  const expanded = [...new Set(ids.flatMap((id) => expandFunIdString(String(id))))]
  const numeric: Array<{ prefix: string; num: number; id: string }> = []
  const verbatim: string[] = []
  for (const id of expanded) {
    const match = id.match(/^(.*\D)(\d+)$/)
    if (match) {
      numeric.push({ prefix: match[1], num: parseInt(match[2], 10), id })
    } else {
      verbatim.push(id)
    }
  }
  numeric.sort((a, b) => (a.prefix === b.prefix ? a.num - b.num : a.prefix < b.prefix ? -1 : 1))

  const parts: string[] = []
  let index = 0
  while (index < numeric.length) {
    let runEnd = index
    while (
      runEnd + 1 < numeric.length &&
      numeric[runEnd + 1].prefix === numeric[index].prefix &&
      numeric[runEnd + 1].num === numeric[runEnd].num + 1
    ) {
      runEnd += 1
    }
    if (runEnd > index) {
      parts.push(`${numeric[index].id}~${numeric[runEnd].id.match(/(\d+)$/)?.[1] ?? numeric[runEnd].id}`)
    } else {
      parts.push(numeric[index].id)
    }
    index = runEnd + 1
  }
  return [...parts, ...verbatim].join("、")
}

/**
 * Convert a single flat-format requirement item into a PreparedPhase6Requirement.
 */
function prepareFlatPhase6Requirement(
  item: TestRequirementFlatItem,
  workdirName: string,
): PreparedPhase6Requirement {
  const funIds = item.funId ?? []
  const requirementId = funIds.join("、")
  // 保留未识别类型供模板解析器明确拒绝，不能悄悄生成功能测试。
  const testTypeEnglish = CHINESE_TO_TYPE[item.test_type] ?? item.test_type
  const titleNo = item.titleNo ?? ""
  const path = titleNoToHierarchyPath(titleNo)
  const categoryKey = funIds.length > 0
    ? (extractRequirementCategoryKey(funIds[0]) ?? "UNK")
    : "UNK"

  return {
    requirement_id: requirementId,
    source_requirement_ids: funIds,
    title: item.title,
    title_no: titleNo,
    path,
    category_key: categoryKey,
    chapter_title: item.test_type,  // flat format uses test_type as chapter title
    chapter_background: item.requirementContext ?? "",
    test_type: testTypeEnglish,
    priority: "medium",
    handling: item.processingContext ?? "",
    name: item.title,
    sufficiency: null,         // resolved later in toTrItem()
    test_method: "",           // resolved later in toTrItem()
    pass_criteria: "",         // not directly provided by flat format
    inputFlow: item.inputFlowContext ?? "",
    outputFlow: item.outputFlowContext ?? "",
    requirementContext: item.requirementContext,
    constraintContext: item.constraintContext,
    interruptContext: item.interruptContext,
  }
}

/**
 * Prepare Phase 6 input from flat-format test requirements.
 */
export function preparePhase6InputFromFlat(
  artifact: TestRequirementFlatArtifact,
  options?: {
    project_meta?: Phase6ProjectMetaSource | null
    workdir?: string | null
  },
): PreparedPhase6Input {
  const canonicalArtifact = TestRequirementFlatArtifactSchema.parse(artifact)
  const projectMeta = options?.project_meta ?? {}
  const workdir = options?.workdir ?? process.cwd()
  const workdirName = basename(workdir) || "未命名项目"

  const artifactMeta: Phase6ArtifactMeta = {
    software_id: textOf((canonicalArtifact as any).softwareId),
    code_version: textOf((canonicalArtifact as any).codeVersion),
    project_id: textOf((canonicalArtifact as any).projectId),
    doc_type: typeof (canonicalArtifact as any).docType === "number"
      ? (canonicalArtifact as any).docType
      : null,
  }

  const suiteMeta: Phase6SuiteMeta = {
    project_name: textOf(projectMeta.csci_name) || workdirName,
    version: textOf(projectMeta.version) || artifactMeta.code_version || "未标注",
    software_id: artifactMeta.software_id || textOf(projectMeta.doc_id),
    code_version: artifactMeta.code_version || textOf(projectMeta.version),
  }

  const requirements = (canonicalArtifact.funItem ?? []).map((item) => {
    const requirement = prepareFlatPhase6Requirement(item, workdirName)
    // 中断上下文工件级回退(2026-09-02 用户数据形态):顶层 interruptContext
    // 是项目级中断使用说明表,项级未单独提供时对所有 requirement 生效
    if (!requirement.interruptContext && canonicalArtifact.interruptContext) {
      requirement.interruptContext = canonicalArtifact.interruptContext
    }
    return requirement
  })

  return {
    artifact: canonicalArtifact,
    artifact_meta: artifactMeta,
    suite_meta: suiteMeta,
    requirements,
  }
}

/**
 * Load flat-format test-requirements.json from disk.
 */
export function loadTestRequirementFile(
  filePath: string,
): TestRequirementFlatArtifact {
  if (!existsSync(filePath)) {
    throw new Error(`test-requirements.json 不存在：${filePath}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"))
  } catch (error) {
    throw new Error(
      `test-requirements.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const flatResult = TestRequirementFlatArtifactSchema.safeParse(parsed)
  if (flatResult.success) return flatResult.data

  throw new Error(
    "test-requirements.json 格式无法识别：不是合法的 flat funItem[] 格式。",
  )
}

export function preparePhase6Input(
  artifact: TestRequirementFlatArtifact | Record<string, unknown> | null | undefined,
  options?: {
    project_meta?: Phase6ProjectMetaSource | null
    workdir?: string | null
  },
): PreparedPhase6Input {
  if (!artifact || typeof artifact !== "object") {
    throw new Error("test-requirements artifact is null or not an object.")
  }

  if (isFlatTestRequirements(artifact)) {
    return preparePhase6InputFromFlat(artifact as TestRequirementFlatArtifact, options)
  }

  throw new Error(
    "test-requirements.json 必须是 flat funItem[] 格式。",
  )
}

function mapPriority(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return "medium"
  if (HIGH_PRIORITY_TOKENS.includes(normalized)) {
    return normalized === "critical" ? "critical" : "high"
  }
  if (MEDIUM_PRIORITY_TOKENS.includes(normalized)) return "medium"
  if (LOW_PRIORITY_TOKENS.includes(normalized)) return "low"
  return ["critical", "high", "medium", "low"].includes(normalized) ? normalized : "medium"
}

function mapVerificationMethod(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return "test"
  if (INSPECTION_TOKENS.some((token) => normalized.includes(token))) return "inspection"
  if (ANALYSIS_TOKENS.some((token) => normalized.includes(token))) return "analysis"
  if (DEMONSTRATION_TOKENS.some((token) => normalized.includes(token))) return "demonstration"
  return "test"
}

function splitAdequacy(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,;,、。，；]+/g)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

// ---------------------------------------------------------------------------
// Cross-Requirement Context — 跨需求数据流查找
// ---------------------------------------------------------------------------

export interface InputFlowMatch {
  requirement_id: string
  name: string
  inputFlow: string
  /** Extracted bus hierarchy level (e.g. "一级CAN", "二级CAN") */
  bus_level: string
}

export interface CrossRequirementContext {
  upstream_flows: InputFlowMatch[]
}

/**
 * Detect a missing source, not an invalid packet count. A concrete workload may
 * choose its data volume from the supplied protocol; it need not inherit a fixed
 * numeric total from the requirement. Only halt when the referenced multipacket
 * input has neither an authored format nor a related same-project protocol.
 */
export function getStressProtocolContextGaps(
  req: PreparedPhase6Requirement,
  crossContext?: CrossRequirementContext | null,
): string[] {
  if (req.test_type !== "stress") return []
  if (!/^(?:无|无输入|无输入流|不适用|none|n\/a)?[。．.\s]*$/i.test((req.inputFlow ?? "").trim())) return []
  const authored = [req.name, req.chapter_background, req.requirementContext, req.handling].filter(Boolean).join("\n")
  const upload249 = /249\s*字节上行数据(?:块|包)/i.test(authored)
  if (!upload249 && !/多包|分包/.test(authored)) return []
  const referencesFlow = (text: string) => upload249
    ? /249\s*字节上行数据(?:块|包)/i.test(text)
    : /多包|分包|首包|末包|第一包|最后一包|总包数/.test(text)
  // Ignore an unrelated SPI/CAN format in another workload item. Keep newlines
  // inside a protocol's own description so nested frame definitions still count.
  const relatedText = authored.split(/\n\s*\n|\n(?=[a-zA-Z][、．.])/)
    .filter(referencesFlow).join("\n")
  // Mentioning the upload in some other protocol's body is not its definition.
  // Require a matching named section, just as the cross-requirement lookup does.
  if (crossContext?.upstream_flows.some((flow) => namedInputFlowSections(flow.inputFlow).some((section) => (
    (upload249 ? referencesFlow(section.name) : stressReferencesFlow(relatedText, section.name))
    && section.text.split("\n").slice(1).join("\n").trim().length > 0
  )))) return []

  const frameShape = /首帧|中间帧|尾帧|帧格式|帧结构|帧序号/.test(relatedText)
  // "覆盖首帧/尾帧的 INDEX、SUM 错误" is a test objective, not a layout.
  // Accept an actual frame→field mapping or a field meaning/value definition.
  const frameFieldMapping = /(?:首帧|中间帧|尾帧)(?:的)?(?:格式|字段)?\s*(?:携带|包含|记录|存放|保存|：|:)[^。；;\n]{0,60}(?:仲裁场|控制场|\b(?:INDEX|TITLE|LENGTH|SUM)\b|包序号|总条数|总长度)/i.test(relatedText)
  const fieldDefinition = /(?:\b(?:INDEX|TITLE|LENGTH|SUM)\b|包序号|程序编号)(?:字段)?\s*(?:表示|标识|取值范围|范围为|取值为|为0x[\da-f]+|为\d+)|\|[^\n]*(?:字段|位号|字节位置)[^\n]*\|/i.test(relatedText)
  // Variable total packet counts are valid: per-packet capacity, a total-length
  // field, or a last-packet flag can establish the completion rule without N.
  const partitionRule = /每包.{0,16}\d+\s*(?:字节|条)|(?:首包|第一包)\s*(?:携带|包含|记录|存放|保存).{0,20}(?:总条数|总长度|总包数)|包序号\s*(?:从|自|起始(?:为|值为))\s*(?:0x[\da-f]+|\d+)|总包数\s*(?:由|根据).{0,30}(?:长度|条数|容量)|(?:末包|最后一包).{0,20}(?:结束标志|完成标志)\s*(?:为|置|取值为)\s*(?:0x[\da-f]+|\d+)/i.test(relatedText)
  if (frameFieldMapping || (frameShape && fieldDefinition) || partitionRule) return []

  const flow = upload249 ? "249字节上行数据块" : "多包数据"
  return [
    `${flow}缺少同项目协议中的分包规则/完整传输结束条件；请补充对应输入流或关联需求，不能猜测包数或改作单包绕过。`,
    `${flow}缺少首帧、中间帧、尾帧格式及关键字段定义的来源；当前输入流为无/空，须补充依据后再生成。`,
  ]
}

/**
 * Extract candidate data flow names from a requirement's inputFlow.
 * Parses `####` sub-section headers (e.g. "#### 1.2.3 遥控指令数据流").
 * Returns a list of unique data flow names (with trailing "数据流" stripped).
 */
function extractInputFlowNames(inputFlow: string): string[] {
  if (!inputFlow) return []
  const names: string[] = []
  const headerRe = /^#{3,4}\s+(?:\d+\.?)+\s+(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(inputFlow)) !== null) {
    let name = m[1].trim()
    // Strip common suffixes to get the canonical data flow name
    name = name.replace(/(?:相关)?数据流$/, "").replace(/[（(].+[)）]$/, "").trim()
    if (name.length > 0) names.push(name)
  }
  return [...new Set(names)]
}

interface NamedInputFlow {
  name: string
  text: string
}

/** Keep only the named protocol sections that the current stress workload uses. */
function namedInputFlowSections(inputFlow: string): NamedInputFlow[] {
  const headers = [...inputFlow.matchAll(/^(#{3,4})\s+(?:(?:\d+\.)*\d+\.?\s+)?(.+)$/gm)]
  return headers.map((header, index) => {
    // A nested frame-format heading belongs to its enclosing flow. Do not
    // truncate it merely because its heading itself is not a workload name.
    const next = headers.slice(index + 1).find((candidate) => candidate[1].length <= header[1].length)
    return {
      name: header[2].trim().replace(/[（(].+[)）]$/, "").replace(/(?:相关)?数据流$/, "").trim(),
      text: inputFlow.slice(header.index, next?.index ?? inputFlow.length).trim(),
    }
  })
}

function normalizedFlowReference(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "")
}

const FLOW_CHANNEL = /一级can(?:总线)?|二级can(?:总线)?|can[ab](?:总线)?|spacewire(?:总线)?|spi(?:总线)?/g
const GENERIC_FLOW_NAME = /^(?:输入|输出|输入流|输出流|接口|总线|数据|数据包|应答|应答数据|遥测|遥测数据|指令|遥控指令|上注数据|协议)$/

/**
 * A workload may enumerate many inputs in processingContext while inputFlow is
 * explicitly "无". Match dictionary entries from this project's protocol
 * headers, rather than extracting a short/greedy fragment from that enumeration.
 * Generic names need their channel in the same clause; channel names alone are
 * never evidence for importing an interface's complete protocol library.
 */
function stressReferencesFlow(text: string, flowName: string): boolean {
  const name = normalizedFlowReference(flowName)
  if (name.length < 2 || GENERIC_FLOW_NAME.test(name)) return false
  const channels = [...name.matchAll(FLOW_CHANNEL)].map((match) => match[0].replace(/总线$/, ""))
  const payloadName = name.replace(FLOW_CHANNEL, "").replace(/^(?:总线)?接口/, "")
  if (payloadName.length < 2) return false
  return text.split(/[。；;\n]/).some((clause) => {
    const normalized = normalizedFlowReference(clause)
    if (!normalized.includes(payloadName)) return false
    // Qualified names must retain their channel, including when prose places
    // "设置正确、错误的" between the channel and the payload name.
    if (channels.length > 0) {
      return channels.every((channel) => normalized.includes(channel))
    }
    return normalized.includes(name)
  })
}

/**
 * Extract candidate data flow references from chapter_background text.
 * Looks for patterns like:
 * - "通过XXX总线发送YYY" → YYY
 * - "接收到XXX指令/广播/数据" → XXX指令/广播/数据
 * - "XXX数据流" → XXX数据流
 * - "接收YYY" → YYY
 */
function extractDataFlowCandidates(text: string): string[] {
  if (!text) return []
  const candidates: string[] = []

  // Pattern 1: "通过...发送<name>" or "通过...广播<name>"
  const sendRe = /通过\S{0,10}(?:总线|接口)\S{0,8}(?:发送|广播|下发)([^，。；;、\s]{2,20})/g
  let m: RegExpExecArray | null
  while ((m = sendRe.exec(text)) !== null) {
    candidates.push(m[1])
  }

  // Pattern 2: "接收到XXX指令" / "接收到XXX广播" / "接收到XXX数据"
  const recvRe = /接收(?:到|了)?\s*(\S{2,20}?(?:指令|广播|数据|数据流|数据块|控制序列|轮询))/g
  while ((m = recvRe.exec(text)) !== null) {
    candidates.push(m[1])
  }

  // Pattern 3: standalone "XXX数据流" / "XXX指令" / "XXX广播"
  const flowRe = /(\S{2,20}?(?:数据流|指令|广播|数据块|控制序列))/g
  while ((m = flowRe.exec(text)) !== null) {
    // Avoid duplicates from patterns above
    if (!candidates.includes(m[1])) candidates.push(m[1])
  }

  // Pattern 4: "XXX的YYY" where YYY is a known flow type word
  const possessRe = /(\S{2,30}?(?:数据流|指令|广播|数据块|控制序列))/g
  // Already covered by flowRe above

  return [...new Set(candidates)]
}

/**
 * Extract the bus hierarchy level from a requirement's context.
 * Searches chapter_background + inputFlow for explicit bus-level mentions,
 * with fallback to requirement_id pattern matching.
 *
 * Returns e.g. "一级CAN", "二级CAN", or "" if undetermined.
 */
function extractBusLevel(req: PreparedPhase6Requirement): string {
  const text = `${req.chapter_background ?? ""}\n${req.inputFlow ?? ""}\n${req.name ?? ""}`

  // Pattern 1: explicit "X级CAN" / "X级总线" / "X级接口"
  const levelMatch = text.match(/([一二三四五]级)\s*(CAN|总线|接口)/)
  if (levelMatch) return `${levelMatch[1]}${levelMatch[2]}`

  // Pattern 2: infer from requirement_id (e.g. CAN0 → 一级CAN, CAN1 → 二级CAN)
  const idMatch = req.requirement_id.match(/CAN(\d+)/i)
  if (idMatch) {
    const num = parseInt(idMatch[1], 10)
    if (num === 0) return "一级CAN"
    if (num === 1) return "二级CAN"
    return `CAN${idMatch[1]}`
  }

  return ""
}

/**
 * Build an inverted index from data flow name → requirements that define
 * that data flow in their inputFlow section headers.
 */
export function buildInputFlowIndex(
  requirements: PreparedPhase6Requirement[],
): Map<string, PreparedPhase6Requirement[]> {
  const index = new Map<string, PreparedPhase6Requirement[]>()

  for (const req of requirements) {
    const names = extractInputFlowNames(req.inputFlow)
    for (const name of names) {
      const existing = index.get(name)
      if (existing) {
        existing.push(req)
      } else {
        index.set(name, [req])
      }
    }
  }

  return index
}

/**
 * Find upstream data flows that are preconditions for the current requirement.
 * Searches other requirements' inputFlow headers for references. Stress inputs
 * are commonly listed only in handling, so they also use the full authored
 * workload and match explicit names without the legacy fuzzy candidate limit.
 *
 * Returns null if no cross-requirement preconditions are found.
 */
export function findCrossRequirementContext(
  req: PreparedPhase6Requirement,
  allRequirements: PreparedPhase6Requirement[],
): CrossRequirementContext | null {
  if (req.test_type === "stress") {
    const workload = [req.chapter_background, req.requirementContext, req.inputFlow, req.handling, req.outputFlow]
      .filter(Boolean).join("\n")
    const matched: InputFlowMatch[] = []
    for (const other of allRequirements) {
      if (other.requirement_id === req.requirement_id) continue
      const sections = namedInputFlowSections(other.inputFlow)
        .filter((section) => stressReferencesFlow(workload, section.name))
      if (sections.length === 0) continue
      matched.push({
        requirement_id: other.requirement_id,
        name: other.name,
        inputFlow: sections.map((section) => section.text).join("\n\n"),
        bus_level: extractBusLevel(other),
      })
    }
    return matched.length > 0 ? { upstream_flows: matched } : null
  }

  const combinedText = `${req.chapter_background}\n${req.inputFlow}`
  const candidates = extractDataFlowCandidates(combinedText)
  if (candidates.length === 0) return null

  // Build index from OTHER requirements only (exclude self)
  const selfId = req.requirement_id
  const otherReqs = allRequirements.filter((r) => r.requirement_id !== selfId)

  const matched = new Map<string, InputFlowMatch>() // dedup by requirement_id
  for (const other of otherReqs) {
    const otherNames = extractInputFlowNames(other.inputFlow)
    for (const otherName of otherNames) {
      for (const candidate of candidates) {
        // Fuzzy match: candidate is a substring of otherName, or vice versa
        if (otherName.includes(candidate) || candidate.includes(otherName)) {
          if (!matched.has(other.requirement_id)) {
            matched.set(other.requirement_id, {
              requirement_id: other.requirement_id,
              name: other.name,
              inputFlow: other.inputFlow,
              bus_level: extractBusLevel(other),
            })
          }
          break // already matched this requirement
        }
      }
    }
  }

  if (matched.size === 0) return null

  return {
    upstream_flows: [...matched.values()],
  }
}
