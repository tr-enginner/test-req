import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import {
  SourceConfirmationTestCase,
  SourceConfirmationTestSuite,
  TranslatedConfirmationTestSuite,
  normalizeTestStepRecords,
  ensureUnifiedSteps,
  extractSourceStepsFromUnified,
  extractTranslatedStepsFromUnified,
} from "../schema/confirmation-test-case"
import { ARTIFACT_PATHS } from "../shared/constants"
import { withFileLock } from "../shared/file-mutex"
import { loadPluginConfig } from "../plugin-config"
import {
  buildRequirementIndex,
  compressFunIdsToRangeString,
  expandFunIdString,
  extractRequirementCategoryKey,
  type RequirementIndexEntry,
} from "../shared/test-requirements"
import {
  resolveGeneratedTestEnvironment,
  TEST_ENVIRONMENT_MODE_VALUES,
  type TestEnvironmentMode,
} from "../shared/test-environment"
import type { StandardizedCase } from "../shared/phase6-testcase-standardizer"
import { scanKeywordDirs } from "../shared/testcase-keywords"
import { isManualTestRequirement, manualTestEnvironment, isIntegratedStressTest, validateTestTypeCases } from "../shared/phase6-test-type-policy"
import { normalizePhase6TestType } from "../shared/phase6-prompt-templates"
import { writePhase6TestCasesTodoFromSuite } from "../shared/phase6-todo"

interface SuiteToolSummary {
  name: string
  purpose: string
  version: string
}

export interface ConfirmationSuiteCreateInput {
  project_name: string
  version: string
  hardware_environment?: string
  software_environment?: string
  test_tools?: SuiteToolSummary[]
}

export interface ConfirmationSuiteCaseInput {
  case_id?: string  // Optional — auto-generated from category + sequential counter when missing
  case_name: string
  test_purpose: string
  correspond_fun_id: string
  test_type: string
  test_step: unknown
  test_environment?: string
  test_environment_mode?: TestEnvironmentMode
  initial_settings?: string
  test_input?: string
  constraints?: string
  assess_criteria?: string
  cease_condition?: string
  path?: string
  /**
   * TR-IDs this specific case covers (from the worker's covered_tr_items).
   * Takes priority over related_software_req_ids when resolving the persisted
   * related_software_req_ids subset. Accepts atomic IDs or 、/~-joined forms.
   */
  covered_tr_items?: string[]
  /** Range-style string listing only THIS case's TR-IDs, e.g. "TR-JK-001~003、TR-JK-005" */
  related_software_req_ids?: string
  designer?: string
  designer_date?: string
  /** Translation status of test steps (Unified format).
   *  "success" — all non-startup steps have key_name populated.
   *  "failure" — one or more non-startup steps have empty key_name.
   *  Defaults to "success" when not provided. */
  translate_status?: "success" | "failure" | "not_applicable"
}

export interface ConfirmationSuiteCaseAppendResult {
  suite: Record<string, unknown>
  persisted_case: SourceConfirmationTestCase
  canonical_case_id: string
  canonical_path?: string
  persisted_test_environment: string
  /** Non-fatal canonicalization notices (e.g. related_software_req_ids left empty). */
  warnings: string[]
}

export interface ConfirmationSuiteFinalizeResult {
  suite: SourceConfirmationTestSuite
  summary: SourceConfirmationTestSuite["summary"]
  traceability: {
    total_requirements: number
    full_coverage: number
    partial_coverage: number
    no_coverage: number
  }
}

export interface Phase6PersistRequirementCases {
  requirement_id: string
  test_type: string
  source_requirement_ids?: string[]
  path?: string
  input_dataset_ref?: string
  cases: StandardizedCase[]
}

export interface Phase6PersistSuiteInput extends ConfirmationSuiteCreateInput {
  projectDir: string
  requirement_cases: Phase6PersistRequirementCases[]
  test_environment_mode?: TestEnvironmentMode
}

export interface Phase6PersistSuiteResult extends ConfirmationSuiteFinalizeResult {
  suite_file: string
  source_suite_file: string
  todo_file: string
  todo_case_count: number
  persisted_case_count: number
  persisted_requirement_count: number
}

function resolveArtifactPath(relativePath: string, projectDir = process.cwd()): string {
  return join(projectDir, relativePath)
}

const DEFAULT_KEYWORD_DIRS = [
  ".matrix/data/DTPProject/组合关键字",
]

function resolveKeywordSearchDirs(projectDir: string, configuredDirs?: string[]): string[] {
  const dirs = configuredDirs && configuredDirs.length > 0
    ? configuredDirs
    : DEFAULT_KEYWORD_DIRS

  return dirs.map((dir) =>
    (dir.startsWith("/") || /^[A-Za-z]:\\/.test(dir)) ? dir : join(projectDir, dir)
  )
}

function removeIfExists(filePath: string): void {
  if (existsSync(filePath)) unlinkSync(filePath)
}

/**
 * Parse JSON with automatic repair of common LLM output errors.
 *
 * Handles:
 * - ASCII double quotes embedded inside Chinese text within JSON string values
 * - HTML comment markers (<!--...-->) in JSON output
 * - Trailing commas before closing brackets/braces
 *
 * Returns the parsed value on success, or throws on irreparable failure.
 */
function parseAndRepairJson(raw: string, source: string): any {
  // Attempt 1: direct parse
  try {
    return JSON.parse(raw)
  } catch {
    // fall through to repair
  }

  let repaired = raw

  // Repair 1: strip HTML comment markers (LLM sometimes leaks <!--...--> into JSON)
  repaired = repaired.replace(/<!--[\s\S]*?-->/g, "").trim()

  // Repair 2: fix trailing commas before ] or }
  repaired = repaired.replace(/,(\s*[}\]])/g, "$1")

  // Repair 3: replace ASCII double quotes embedded inside Chinese text.
  // Pattern: a Chinese char, CJK punctuation, or CJK-compatible context followed by
  // an ASCII " that is NOT a JSON structural delimiter.
  // We detect "structural" quotes: preceded by :, [, {, comma, or whitespace+start of value.
  // Repair approach: find all " in the text, classify each as structural vs embedded,
  // replace embedded ones with Chinese corner brackets 「」 alternating.
  try {
    JSON.parse(repaired)
    return JSON.parse(repaired)
  } catch (firstRepairError) {
    // Repair 4: fix ASCII double quotes inside Chinese text in string values
    // Strategy: find string values that contain unbalanced quotes and fix them
    repaired = repairEmbeddedAsciiQuotes(repaired)
  }

  // Final attempt
  try {
    return JSON.parse(repaired)
  } catch (finalError) {
    throw new Error(
      `JSON parse failed for ${source} after repair attempts: ${finalError instanceof Error ? finalError.message : String(finalError)}`
    )
  }
}

/**
 * Repair ASCII double quotes (" U+0022) embedded inside Chinese text within JSON string values.
 *
 * LLMs sometimes use "quoted Chinese terms" inside JSON strings, which breaks JSON parsing.
 * We detect these by finding " pairs that appear between Chinese/CJK characters and are NOT
 * JSON structural delimiters (preceded by :, [, {, comma, or at value boundaries).
 */
function repairEmbeddedAsciiQuotes(text: string): string {
  // Match segments between Chinese/CJK chars — these are candidate locations for embedded quotes
  // CJK range: 一-鿿, fullwidth forms: 　-〿, CJK punctuation: ＀-￯
  // Pattern: Chinese char followed by "content" followed by Chinese char
  const embeddedPattern = /([一-鿿　-〿＀-￯])\x22([^\x22]*?)\x22([一-鿿　-〿＀-￯])/g

  // Only replace if the pattern looks like embedded Chinese quotes (not JSON structure)
  let result = text
  let counter = 0
  result = result.replace(embeddedPattern, (_full, before, content, after) => {
    counter++
    const open = counter % 2 === 1 ? "「" : "「"  // 「
    const close = "」"  // 」
    return `${before}${open}${content}${close}${after}`
  })

  return result
}

/**
 * Normalize an ID-list input (string array or 、/~-joined string) into a
 * single 、-joined string. Returns undefined for empty/absent input.
 */
function normalizeIdListInput(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim()) return raw.trim()
  if (Array.isArray(raw) && raw.length > 0) {
    const joined = raw.map(String).filter((s) => s.trim()).join("、")
    return joined || undefined
  }
  return undefined
}

interface RelatedReqIdsResolution {
  value?: string
  warnings: string[]
}

/**
 * Resolve the case's own related_software_req_ids (subset semantics).
 *
 * Priority (per test-design skill): covered_tr_items → explicit
 * related_software_req_ids → single-ID requirement item fallback. Never the
 * whole requirement group: for a multi-ID item without coverage info the
 * value stays empty and a warning is surfaced (the review gate requires it).
 * With a requirement index available, every ID must trace to the case's own
 * requirement item — untraceable or cross-item IDs fail loudly instead of
 * being silently filtered.
 */
function resolveCaseRelatedReqIds(input: {
  covered_tr_items?: unknown
  related_software_req_ids?: unknown
  canonicalCorrespondFunId: string
  requirementIndex: Map<string, RequirementIndexEntry>
}): RelatedReqIdsResolution {
  const warnings: string[] = []
  const coveredRaw = normalizeIdListInput(input.covered_tr_items)
  const explicitRaw = normalizeIdListInput(input.related_software_req_ids)

  // Without a requirements artifact there is no source of truth — best effort:
  // covered → explicit, no validation, no fallback default.
  if (input.requirementIndex.size === 0) {
    const raw = coveredRaw ?? explicitRaw
    const expanded = raw !== undefined ? expandFunIdString(raw) : []
    return expanded.length > 0
      ? { value: compressFunIdsToRangeString(expanded), warnings }
      : { warnings }
  }

  const resolveSource = (raw: string, sourceLabel: string): string | undefined => {
    const expanded = expandFunIdString(raw)
    if (expanded.length === 0) return undefined
    const untraceable = expanded.filter((id) => !input.requirementIndex.has(id))
    if (untraceable.length > 0) {
      throw new Error(
        `${sourceLabel} "${raw}" 含有无法追溯到 test-requirements.json funId 的 ID: ${untraceable.join("、")}。`,
      )
    }
    const itemExpanded = expandFunIdString(input.canonicalCorrespondFunId)
    const foreign = expanded.filter((id) => !itemExpanded.includes(id))
    if (foreign.length > 0) {
      throw new Error(
        `${sourceLabel} "${raw}" 含有不属于当前测试需求项 (${input.canonicalCorrespondFunId}) 的 ID: ${foreign.join("、")}。` +
          "related_software_req_ids 只能列当前用例所属需求项 funId 内的 TR-ID。",
      )
    }
    return compressFunIdsToRangeString(expanded)
  }

  if (coveredRaw !== undefined) {
    const value = resolveSource(coveredRaw, "covered_tr_items")
    if (value !== undefined) return { value, warnings }
  }
  if (explicitRaw !== undefined) {
    const value = resolveSource(explicitRaw, "related_software_req_ids")
    if (value !== undefined) return { value, warnings }
  }

  // Single-ID requirement item: the case's coverage IS that ID.
  const itemExpanded = expandFunIdString(input.canonicalCorrespondFunId)
  if (itemExpanded.length === 1) {
    return { value: itemExpanded[0], warnings }
  }
  if (itemExpanded.length > 1) {
    warnings.push(
      `需求项 ${input.canonicalCorrespondFunId} 含多个 TR-ID，且该用例未提供 covered_tr_items/related_software_req_ids；` +
        "related_software_req_ids 留空（禁止默认整组），请补充该用例实际覆盖的 TR-ID 后重新保存。",
    )
  }
  return { warnings }
}

/**
 * Canonicalize correspond_fun_id against the requirement index.
 *
 * correspond_fun_id is item-level identity: it must EXACTLY equal the owning
 * funItem's funId (joined 、-form, ranges as authored). Workers may submit a
 * subset or an invented range form ("TR-JK-001~003" against atomic IDs), so
 * the value is recomposed from the index: every atomic ID must trace to a
 * funId entry (untraceable IDs fail loudly) and all IDs must belong to ONE
 * funItem (spanning multiple items fails loudly — one case belongs to one
 * requirement item); the output is then that item's full authored funId form.
 */
function canonicalizeCorrespondFunId(
  input: string,
  requirementIndex: Map<string, RequirementIndexEntry>,
): string {
  const covered = new Set(expandFunIdString(input))
  if (covered.size === 0) return input
  // Without a requirements artifact there is no source of truth to validate
  // against — keep the input as-is.
  if (requirementIndex.size === 0) return input

  const untraceable = [...covered].filter((id) => !requirementIndex.has(id))
  if (untraceable.length > 0) {
    throw new Error(
      `correspond_fun_id "${input}" 含有无法追溯到 test-requirements.json funId 的 ID: ${untraceable.join("、")}。` +
        "请检查该用例对应的测试需求编号是否正确。",
    )
  }

  let itemIndex: number | null = null
  let itemFunIdForm = ""
  for (const id of covered) {
    const entry = requirementIndex.get(id)!
    if (itemIndex === null) {
      itemIndex = entry.item_index
      itemFunIdForm = entry.item_fun_id_form || id
    } else if (entry.item_index !== itemIndex) {
      throw new Error(
        `correspond_fun_id "${input}" 同时覆盖多个测试需求项 (含 item_index ${itemIndex} 与 ${entry.item_index})。` +
          "一条测试用例只能属于一个 funItem；请修正 correspond_fun_id 使其只含单个需求项的 ID。",
      )
    }
  }
  return itemFunIdForm
}

/**
 * Sanitize an ID that may contain range-format syntax (e.g. "TR-001~TR-003").
 * Range-format IDs are produced by LLMs trying to express "this case covers TR-001 through TR-003".
 * They break traceability (no single TR-ID match) and case_id uniqueness.
 *
 * Strategy: take the part before the first "~" as the primary ID.
 * "TR-GN-BOOT-001~TR-GN-BOOT-003" → "TR-GN-BOOT-001"
 * "TC-GN-BOOT-001~TR-GN-BOOT-001" → "TC-GN-BOOT-001"
 */
function sanitizeRangeField(value: string): string {
  const tildeIdx = value.indexOf("~")
  if (tildeIdx === -1) return value
  return value.slice(0, tildeIdx)
}

function writeJsonFileAtomic(filePath: string, value: unknown): void {
  ensureDir(filePath)
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf-8")
  renameSync(tempPath, filePath)
}

function resetDirectory(dirPath: string): void {
  rmSync(dirPath, { recursive: true, force: true })
  mkdirSync(dirPath, { recursive: true })
}

function sanitizeCaseFileName(caseId: string, index: number): string {
  const sanitized = caseId.trim().replace(/[^A-Za-z0-9_.-]+/g, "_")
  return sanitized ? `${sanitized}.json` : `case-${index + 1}.json`
}

/**
 * Flatten CNAS chapterTrList tree into a flat array of { funId, name, ... } items.
 * Preserves DFS traversal order (= original requirement order in the document).
 */
function flattenChapterTrList(node: any): any[] {
  const results: any[] = []
  for (const item of node.funItem ?? []) {
    results.push(item)
  }
  for (const child of node.children ?? []) {
    results.push(...flattenChapterTrList(child))
  }
  return results
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function normalizePersistedTestSteps(
  steps: unknown,
  _testEnvironment: string,
): unknown {
  // No longer auto-inserts "启动软平台" step.
  // That auto-insertion caused step index offsets (S1→S2…) which broke
  // downstream scripts that reference steps by their original indices.
  return steps
}

function loadTestRequirementsArtifactFromDisk(projectDir = process.cwd()): Record<string, unknown> | null {
  const requirementPath = resolveArtifactPath(ARTIFACT_PATHS.TEST_REQUIREMENTS, projectDir)
  if (!existsSync(requirementPath)) return null

  try {
    const parsed = JSON.parse(readFileSync(requirementPath, "utf-8"))
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function extractCategoryFromCaseId(caseId: string): string | null {
  const parts = caseId.trim().split("-").filter(Boolean)
  if (parts.length >= 2 && parts[0].toUpperCase() === "TC") {
    const categoryParts = parts.slice(1, -1)
    return categoryParts.length > 0 ? categoryParts.join("-").toUpperCase() : null
  }
  return null
}

function loadRequirementIndexFromDisk(projectDir = process.cwd()): Map<string, RequirementIndexEntry> {
  const artifact = loadTestRequirementsArtifactFromDisk(projectDir)
  if (!artifact) return new Map()

  try {
    return buildRequirementIndex(artifact)
  } catch {
    return new Map()
  }
}

function resolveCaseCategory(
  requirementEntry: RequirementIndexEntry | undefined,
  correspondFunId: string,
  inputCaseId?: string,
): string {
  return requirementEntry?.category_key
    ?? extractRequirementCategoryKey(correspondFunId)
    ?? extractCategoryFromCaseId(inputCaseId ?? "")
    ?? "UNK"
}

function buildCanonicalCaseId(
  suite: { test_cases?: Array<{ case_id?: string }> },
  requirementEntry: RequirementIndexEntry | undefined,
  correspondFunId: string,
  inputCaseId?: string,
): string {
  const category = resolveCaseCategory(requirementEntry, correspondFunId, inputCaseId)
  const prefix = `TC-${category}-`

  // If the input already provides a valid case_id for this category, reuse its counter.
  // This preserves case IDs across replace operations instead of allocating new numbers.
  if (inputCaseId && inputCaseId.startsWith(prefix)) {
    const inputSuffix = inputCaseId.slice(prefix.length)
    const inputCounter = Number.parseInt(inputSuffix, 10)
    if (Number.isFinite(inputCounter)) {
      // Check if this case_id is already in the suite (not the one being replaced)
      const existingIds = new Set((suite.test_cases ?? []).map(tc => tc.case_id))
      if (!existingIds.has(inputCaseId)) {
        return inputCaseId
      }
    }
  }

  let maxCounter = 0

  for (const testCase of suite.test_cases ?? []) {
    const value = String(testCase.case_id ?? "")
    if (!value.startsWith(prefix)) continue
    const suffix = value.slice(prefix.length)
    const counter = Number.parseInt(suffix, 10)
    if (Number.isFinite(counter)) {
      maxCounter = Math.max(maxCounter, counter)
    }
  }

  return `${prefix}${String(maxCounter + 1).padStart(3, "0")}`
}

function formatValidationIssues(issues: Array<{ path: PropertyKey[]; message: string }>): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }))
}

function buildValidationMessage(prefix: string, issues: Array<{ path: PropertyKey[]; message: string }>): string {
  const details = formatValidationIssues(issues)
    .map((issue) => `${issue.path || "root"}: ${issue.message}`)
    .join("; ")
  return details ? `${prefix}: ${details}` : prefix
}

export function createConfirmationSuiteSkeletonData({
  project_name,
  version,
  hardware_environment,
  software_environment,
  test_tools,
}: ConfirmationSuiteCreateInput): Record<string, unknown> {
  const skeleton: Record<string, unknown> = {
    project_name,
    version,
    created_date: new Date().toISOString().split("T")[0],
    test_cases: [],
    traceability: [],
    summary: {
      total_cases: 0,
      by_type: {},
    },
  }

  if (hardware_environment || software_environment || test_tools?.length) {
    skeleton.test_environment_summary = {
      hardware_environment: hardware_environment ?? "",
      software_environment: software_environment ?? "",
      test_tools: test_tools ?? [],
    }
  }

  return skeleton
}

export function appendConfirmationCaseToSuiteData(
  suite: Record<string, unknown>,
  input: ConfirmationSuiteCaseInput,
  requirementIndex = new Map<string, RequirementIndexEntry>(),
): ConfirmationSuiteCaseAppendResult {
  // 显式 test_environment 优先于 mode 解析(2026-09-08 取证:看门狗等硬平台
  // 用例经逐用例 add_case 路径落库时,标准化覆写的环境值必须被尊重——
  // 此前只认 test_environment_mode,环境覆写在非 persist 路径丢失)
  let persistedTestEnvironment = (input.test_environment ?? "").trim() !== ""
    ? String(input.test_environment).trim()
    : resolveGeneratedTestEnvironment(input.test_environment_mode ?? "software")
  // correspond_fun_id may be a 、-separated multi-ID string with ~ ranges
  // (e.g. "TR-JK-001~TR-JK-003"). requirementIndex is keyed by individual TR-IDs —
  // expand ranges and use the first expanded ID present in the index for lookup.
  const funIds = expandFunIdString(input.correspond_fun_id)
  // Issue-2/4 contract: cfid canonicalized to the owning funItem's FULL funId
  // form (subset inputs are auto-completed to the whole group); rsrid resolves
  // per-case coverage — covered_tr_items first, explicit value second, never
  // the whole requirement group.
  const canonicalCorrespondFunId = canonicalizeCorrespondFunId(input.correspond_fun_id, requirementIndex)
  const relatedResolution = resolveCaseRelatedReqIds({
    covered_tr_items: input.covered_tr_items,
    related_software_req_ids: input.related_software_req_ids,
    canonicalCorrespondFunId,
    requirementIndex,
  })
  const relatedReqIds = relatedResolution.value
  const requirementEntry = funIds
    .map((id) => requirementIndex.get(id))
    .find((entry) => entry !== undefined)

  const existingCases = Array.isArray(suite.test_cases) ? suite.test_cases as Array<{ case_id?: string }> : []

  // Compute canonical case ID BEFORE building the testCase object.
  // This ensures auto-generation works even when input.case_id is missing (common in batch import).
  // correspond_fun_id 可能是多 ID 顿号串（新格式 funId 数组直接拼接而来），
  // 类别键只从第一个展开后的单 ID 提取，避免把整串当 ID 解析。
  const canonicalCaseId = buildCanonicalCaseId(
    { test_cases: existingCases },
    requirementEntry,
    funIds[0] ?? input.correspond_fun_id,
    input.case_id,
  )
  const canonicalPath = requirementEntry?.path ?? input.path

  // Convert test_step to unified format BEFORE Zod validation.
  // Handles both 4-anchor format (from subagent generation: {步骤描述, 预期结果,
  // operation_type, channel, temporal, data_checks}) and legacy format.
  // Previously this conversion ran after safeParse, which caused 87/88 cases
  // to fail validation when subagents output 4-anchor format.
  const unifiedTestStep = ensureUnifiedSteps(input.test_step)
  const rawSteps = typeof input.test_step === "string" ? JSON.parse(input.test_step) : input.test_step

  // Detect translate_status from unified steps when not explicitly provided.
  // All non-startup steps matched → "success"; anything else → "failure".
  let effectiveTranslateStatus: "success" | "failure" | "not_applicable" | undefined = input.translate_status
  const manualRequirement = isManualTestRequirement({
    name: requirementEntry?.name,
    requirementId: requirementEntry?.requirement_id ?? input.correspond_fun_id,
    testType: requirementEntry?.chapter_title ?? input.test_type,
  })
  if (manualRequirement) {
    effectiveTranslateStatus = "not_applicable"
    for (const step of unifiedTestStep) {
      step.key_name = ""
      step.parameter = []
      step.expected_key_name = "保留"
      step.source_expected_key_name = "保留"
      step.expected_parameter = []
      step.step_desc = step.source_step_desc
      step.translation_exempt_reason = "manual_requirement"
    }
  } else if (effectiveTranslateStatus === "not_applicable" || unifiedTestStep.some((step) => step.translation_exempt_reason)) {
    throw new Error("仅需求身份明确为人工验证的引导加载/初始化、性能测试和余量测试用例可以跳过关键字翻译。")
  }
  if (effectiveTranslateStatus === undefined) {
    const allMatched = unifiedTestStep.every(
      (s) => s.is_startup_step || s.key_name !== "",
    )
    effectiveTranslateStatus = allMatched ? "success" : "failure"
  }

  // test_type: the matched requirement's classification (chapter_title in the
  // flat format, e.g. "接口测试", normalized from test_type/testType by
  // buildRequirementIndex) is authoritative — every case generated for an
  // 接口测试 requirement must itself be 接口测试. Never let a raw LLM-supplied
  // test_type win over the requirement's own classification. Fall back to the
  // caller-provided value only when no requirement entry is matched (e.g.
  // legacy import), and NEVER silently default to 功能测试 — fail loudly instead.
  const chapterType = String(requirementEntry?.chapter_title ?? "").trim()
  const rawTestType = chapterType || String(input.test_type ?? "").trim()
  const effectiveTestType = normalizePhase6TestType(rawTestType) ?? rawTestType
  if (!effectiveTestType) {
    throw new Error(
      "无法确定 test_type：用例 " +
      `"${input.case_name}"（对应测试需求 ${input.correspond_fun_id}）在 ` +
      "test-requirements.json 中没有可用的测试类型。请显式传入 test_type，" +
      "或检查该 funItem 的 test_type/testType 字段。",
    )
  }

  persistedTestEnvironment = manualTestEnvironment(effectiveTestType) ?? persistedTestEnvironment
  if (requirementEntry?.contextGaps?.length) {
    throw new Error(`CONTEXT_REQUIRED：${requirementEntry.contextGaps.join("；")} 请补充协议依据后重新生成，不能重派猜测。`)
  }
  const policyIssues = validateTestTypeCases(effectiveTestType, [{
    test_environment: persistedTestEnvironment,
    test_step: unifiedTestStep.map((step, index) => ({
      ...step,
      // Legacy migration may fold step_desc/source_step_desc into the Chinese
      // action; retain conflicting raw timing as evidence, not as new content.
      ...(Array.isArray(rawSteps) && rawSteps[index] && typeof rawSteps[index] === "object" ? rawSteps[index] : {}),
      步骤描述: step.source_step_desc,
      预期结果: step.expected_result,
    })),
  }], [requirementEntry?.chapter_background, requirementEntry?.handling, requirementEntry?.inputFlow, requirementEntry?.outputFlow, requirementEntry?.protocolContext].filter(Boolean).join("\n"))
  if (policyIssues.length) throw new Error(policyIssues.map((issue) => issue.message).join("\n"))
  if (isIntegratedStressTest(effectiveTestType) && existingCases.some((existing) =>
    expandFunIdString(String((existing as Record<string, unknown>).correspond_fun_id ?? "")).some((id) =>
      expandFunIdString(canonicalCorrespondFunId).includes(id)))) {
    throw new Error("一条强度测试需求只能生成一个综合用例；本需求已经存在用例，不能按功能、总线或步骤数追加新用例。")
  }

  const testCase: Record<string, unknown> = {
    case_id: canonicalCaseId,
    case_name: input.case_name,
    test_purpose: input.test_purpose,
    correspond_fun_id: canonicalCorrespondFunId,
    test_type: effectiveTestType,
    test_step: unifiedTestStep,
    test_environment: persistedTestEnvironment,
    initial_settings: input.initial_settings ?? "无",
    test_input: input.test_input ?? "无",
    constraints: input.constraints ?? "无",
    assess_criteria: input.assess_criteria ?? "实际结果与预期结果一致",
    cease_condition:
      input.cease_condition ??
      "Z1：测试用例按照所设计的操作步骤完成，测试正常终止；" +
        "Z2：测试用例不能按照所设计的操作步骤完成，测试异常终止。",
    ...((requirementEntry?.path ?? input.path) !== undefined && { path: requirementEntry?.path ?? input.path }),
    ...(relatedReqIds !== undefined && { related_software_req_ids: relatedReqIds }),
    ...(input.designer !== undefined && { designer: input.designer }),
    ...(input.designer_date !== undefined && { designer_date: input.designer_date }),
    translate_status: effectiveTranslateStatus,
    status: 0,
  }

  const caseResult = SourceConfirmationTestCase.safeParse(testCase)
  if (!caseResult.success) {
    throw new Error(buildValidationMessage("Test case validation failed", caseResult.error.issues))
  }

  if (existingCases.some((testCase) => testCase.case_id === canonicalCaseId)) {
    throw new Error(`Duplicate case_id: ${canonicalCaseId}. Each case must have a unique case_id.`)
  }

  const normalizedTestSteps = normalizePersistedTestSteps(
    unifiedTestStep,
    persistedTestEnvironment,
  )

  const persistedCase: SourceConfirmationTestCase = {
    ...caseResult.data,
    case_id: canonicalCaseId,
    path: canonicalPath,
    test_step: normalizedTestSteps as SourceConfirmationTestCase["test_step"],
  }

  return {
    suite: {
      ...suite,
      test_cases: [...existingCases, persistedCase],
    },
    persisted_case: persistedCase,
    canonical_case_id: canonicalCaseId,
    canonical_path: canonicalPath,
    persisted_test_environment: persistedTestEnvironment,
    warnings: [...relatedResolution.warnings],
  }
}

function buildSuiteTraceability(
  suite: Record<string, unknown>,
  testRequirementsArtifact?: Record<string, unknown> | null,
): Array<{ test_req_id: string; case_ids: string[]; coverage_status: "full" | "partial" | "none" }> {
  const existingTraceability = Array.isArray(suite.traceability) ? suite.traceability : []
  if (!testRequirementsArtifact) return existingTraceability as Array<{ test_req_id: string; case_ids: string[]; coverage_status: "full" | "partial" | "none" }>

  try {
    const testCases = Array.isArray(suite.test_cases) ? suite.test_cases : []
    const traceability: Array<{ test_req_id: string; case_ids: string[]; coverage_status: "full" | "partial" | "none" }> = []

    let requirements: any[] = (testRequirementsArtifact as any).requirements ?? []
    if (requirements.length === 0 && (testRequirementsArtifact as any).chapterTrList) {
      requirements = flattenChapterTrList((testRequirementsArtifact as any).chapterTrList)
    }
    // Flat format: top-level funItem[] (current primary Phase 6 input format).
    // Without this branch the persisted traceability matrix was always empty.
    if (requirements.length === 0 && Array.isArray((testRequirementsArtifact as any).funItem)) {
      requirements = (testRequirementsArtifact as any).funItem
    }

    for (const req of requirements) {
      const rawReqId = req.id ?? req.funId
      if (!rawReqId) continue
      // Normalize to individual TR-ID list (funId may be a standard array)
      const reqIds = Array.isArray(rawReqId)
        ? rawReqId.filter((id: unknown): id is string => typeof id === "string")
        : [String(rawReqId)]
      if (reqIds.length === 0) continue
      if (
        req.test_level &&
        req.test_level !== "confirmation" &&
        req.test_level !== "system"
      ) {
        continue
      }

      // Expand ~ ranges on both sides (e.g. "TR-GN-SPICJ-001~002" in funId,
      // "TR-JK-001~TR-JK-003" in correspond_fun_id) so range-format IDs match.
      const reqIdsExpanded = reqIds.flatMap((id) => expandFunIdString(String(id)))

      const coveringCaseIds = testCases
        .filter(
          (testCase: any) =>
            reqIdsExpanded.some((reqId) =>
              expandFunIdString(String(testCase.correspond_fun_id ?? "")).includes(reqId),
            ) ||
            reqIdsExpanded.some((reqId) =>
              expandFunIdString(String(testCase.related_software_req_ids ?? "")).includes(reqId),
            ),
        )
        .map((testCase: any) => testCase.case_id)

      let coverageStatus: "full" | "partial" | "none" = "none"
      if (coveringCaseIds.length > 0) {
        coverageStatus =
          req.verification_method === "test" ? "full" : "partial"
        if (!req.verification_method) {
          coverageStatus = "full"
        }
      }

      traceability.push({
        test_req_id: reqIds.join("、"),
        case_ids: coveringCaseIds,
        coverage_status: coverageStatus,
      })
    }

    return traceability
  } catch {
    return existingTraceability as Array<{ test_req_id: string; case_ids: string[]; coverage_status: "full" | "partial" | "none" }>
  }
}

/**
 * The 0-based funItem ordinal a case belongs to (via correspond_fun_id's first
 * index-hit ID). Cases whose cfid cannot be traced (e.g. legacy imports) sort
 * to the end so they never displace traceable cases.
 */
function caseRequirementOrdinal(
  testCase: Record<string, unknown>,
  requirementIndex: Map<string, RequirementIndexEntry>,
): number {
  const ids = expandFunIdString(String(testCase.correspond_fun_id ?? ""))
  for (const id of ids) {
    const entry = requirementIndex.get(id)
    if (entry) return entry.item_index
  }
  return Number.MAX_SAFE_INTEGER
}

/**
 * Stable-sort cases by the owning funItem's position in test-requirements.json
 * (requirement order). Cases of the same requirement item keep their existing
 * relative order (insertion order). case_id values are NOT renumbered — the
 * suite array order is what the persisted JSON, DOCX and todo list follow.
 */
function sortCasesByRequirementOrder(
  testCases: Array<Record<string, unknown>>,
  requirementIndex: Map<string, RequirementIndexEntry>,
): Array<Record<string, unknown>> {
  if (requirementIndex.size === 0) return testCases
  return testCases
    .map((testCase, index) => ({ testCase, index }))
    .sort((a, b) => {
      const orderA = caseRequirementOrdinal(a.testCase, requirementIndex)
      const orderB = caseRequirementOrdinal(b.testCase, requirementIndex)
      return orderA !== orderB ? orderA - orderB : a.index - b.index
    })
    .map(({ testCase }) => testCase)
}

export function finalizeConfirmationSuiteData(
  suite: Record<string, unknown>,
  testRequirementsArtifact?: Record<string, unknown> | null,
): ConfirmationSuiteFinalizeResult {
  const testCases = Array.isArray(suite.test_cases)
    ? (suite.test_cases as Array<Record<string, unknown>>)
    : []
  // 用例顺序与 test-requirements.json 中 funItem 的文件顺序强制一致:
  // 并行 worker 的保存顺序不可靠,排序必须在代码侧确定性完成。
  const requirementIndex = buildRequirementIndex(testRequirementsArtifact)
  const sortedTestCases = sortCasesByRequirementOrder(testCases, requirementIndex)
  const byType: Record<string, number> = {}
  for (const testCase of sortedTestCases) {
    const testType = String(testCase.test_type ?? "")
    if (!testType) continue
    byType[testType] = (byType[testType] || 0) + 1
  }

  const finalizedSuiteCandidate: Record<string, unknown> = {
    ...suite,
    test_cases: sortedTestCases,
    summary: {
      total_cases: sortedTestCases.length,
      by_type: byType,
    },
    traceability: buildSuiteTraceability(
      { ...suite, test_cases: sortedTestCases },
      testRequirementsArtifact,
    ),
  }

  const result = SourceConfirmationTestSuite.safeParse(finalizedSuiteCandidate)
  if (!result.success) {
    throw new Error(buildValidationMessage("Schema validation failed", result.error.issues))
  }

  const fullCoverage = result.data.traceability.filter((entry) => entry.coverage_status === "full").length
  const partialCoverage = result.data.traceability.filter((entry) => entry.coverage_status === "partial").length
  const noCoverage = result.data.traceability.filter((entry) => entry.coverage_status === "none").length

  return {
    suite: result.data,
    summary: result.data.summary,
    traceability: {
      total_requirements: result.data.traceability.length,
      full_coverage: fullCoverage,
      partial_coverage: partialCoverage,
      no_coverage: noCoverage,
    },
  }
}

export async function persistPhase6ConfirmationSuite({
  projectDir,
  project_name,
  version,
  hardware_environment,
  software_environment,
  test_tools,
  requirement_cases,
  test_environment_mode = "software",
}: Phase6PersistSuiteInput): Promise<Phase6PersistSuiteResult> {
  const filePath = resolveArtifactPath(ARTIFACT_PATHS.CONFIRMATION_TESTS, projectDir)
  const requirementIndex = loadRequirementIndexFromDisk(projectDir)
  const testRequirementsArtifact = loadTestRequirementsArtifactFromDisk(projectDir)

  return await withFileLock(filePath, () => {
    let suite = createConfirmationSuiteSkeletonData({
      project_name,
      version,
      hardware_environment,
      software_environment,
      test_tools,
    })

    let persistedCaseCount = 0
    let persistedRequirementCount = 0

    for (const requirementCase of requirement_cases) {
      if (!Array.isArray(requirementCase.cases) || requirementCase.cases.length === 0) continue
      persistedRequirementCount += 1

      for (const standardizedCase of requirementCase.cases) {
        const resolvedTestInput =
          standardizedCase.test_input && standardizedCase.test_input !== "无"
            ? standardizedCase.test_input
            : requirementCase.input_dataset_ref || standardizedCase.test_input

        const appended = appendConfirmationCaseToSuiteData(
          suite,
          {
            case_id: `AUTO-${requirementCase.requirement_id}`,
            case_name: standardizedCase.case_name,
            test_purpose: standardizedCase.test_purpose,
            correspond_fun_id: requirementCase.requirement_id,
            test_type: requirementCase.test_type,
            test_step: standardizedCase.test_step,
            test_environment: standardizedCase.test_environment,
            test_environment_mode,
            initial_settings: standardizedCase.initial_settings,
            test_input: resolvedTestInput,
            constraints: standardizedCase.constraints,
            assess_criteria: standardizedCase.assess_criteria,
            cease_condition: standardizedCase.cease_condition,
            path: requirementCase.path,
            // Per-case coverage: worker 的 covered_tr_items 透传给保存层统一解析
            // (covered 优先,其次显式 related,多 ID 项无覆盖信息时留空并告警,
            // 绝不默认整组)。解析逻辑见 appendConfirmationCaseToSuiteData。
            covered_tr_items: Array.isArray(standardizedCase.covered_tr_items)
              ? standardizedCase.covered_tr_items.map(String)
              : undefined,
            related_software_req_ids: normalizeIdListInput(
              (standardizedCase as unknown as Record<string, unknown>).related_software_req_ids,
            ),
          },
          requirementIndex,
        )
        suite = appended.suite
        persistedCaseCount += 1
      }
    }

    const finalized = finalizeConfirmationSuiteData(suite, testRequirementsArtifact)
    writeJsonFileAtomic(filePath, finalized.suite)
    // Translation is now inline — subagent outputs Combined format directly
    const todo = writePhase6TestCasesTodoFromSuite(projectDir, finalized.suite, "initial_generation")

    return {
      suite_file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
      source_suite_file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
      todo_file: todo.todo_file,
      todo_case_count: todo.case_count,
      persisted_case_count: persistedCaseCount,
      persisted_requirement_count: persistedRequirementCount,
      ...finalized,
    }
  })
}

/**
 * ct_suite_create — Create a skeleton confirmation test suite JSON file.
 */
export const ctSuiteCreate: ToolDefinition = tool({
  description:
    "Create a new confirmation test suite skeleton at .matrix/data/confirmation-tests.json. " +
    "Initializes the file with project metadata and empty arrays. " +
    "project_name/version should come from the Phase 6 suite metadata chain " +
    "(matrix.jsonc.project + test-requirements.json top-level fields + workdir fallback). " +
    "Must be called before ct_suite_add_case.",
  args: {
    project_name: tool.schema
      .string()
      .describe("Project name from Phase 6 suite metadata."),
    version: tool.schema
      .string()
      .describe("Project version from Phase 6 suite metadata."),
    hardware_environment: tool.schema
      .string()
      .optional()
      .describe("Hardware environment description (CPU, board, bus, etc.)"),
    software_environment: tool.schema
      .string()
      .optional()
      .describe("Software environment description (OS, BSP, compiler, IDE, etc.)"),
    test_tools: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string().describe("Tool name"),
          purpose: tool.schema.string().describe("Tool purpose"),
          version: tool.schema.string().describe("Tool version"),
        }),
      )
      .optional()
      .describe("Test tools used across the suite"),
  },
  async execute({ project_name, version, hardware_environment, software_environment, test_tools }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.CONFIRMATION_TESTS)

    // Non-destructive: if suite already exists, load it instead of overwriting.
    // This prevents case loss during revision when only a subset of cases need correction.
    if (existsSync(filePath)) {
      try {
        const existing = JSON.parse(readFileSync(filePath, "utf-8"))
        const caseCount = Array.isArray(existing.test_cases) ? existing.test_cases.length : 0
        return JSON.stringify({
          status: "success",
          action: "loaded",
          file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
          message: `Loaded existing suite with ${caseCount} cases. Use ct_suite_add_case to add or replace cases.`,
          existing_case_count: caseCount,
        })
      } catch {
        // If parse fails, fall through to create new
      }
    }

    const skeleton = createConfirmationSuiteSkeletonData({
      project_name,
      version,
      hardware_environment,
      software_environment,
      test_tools,
    })

    writeJsonFileAtomic(filePath, skeleton)

    return JSON.stringify({
      status: "success",
      action: "created",
      file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
      message: `Created confirmation test suite skeleton for "${project_name}" v${version}`,
    })
  },
})

/**
 * Enrich test steps with semantic anchor fields when the LLM has not provided them.
 * Infers operation_type, channel, and temporal from the step's 步骤描述 text.
 * Only fills in missing fields — existing values are preserved.
 */
function enrichStepAnchors(
  steps: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const timePattern = /第(\d+(?:\.\d+)?)秒/

  const operationRules: Array<{ pattern: RegExp; type: string }> = [
    { pattern: /发送|注入|下发/, type: "inject_input" },
    { pattern: /接收|输出|应返回|响应/, type: "verify_telemetry" },
    { pattern: /启动/, type: "initialization" },
    { pattern: /验证|检查|确认|应.*丢弃|应.*加1/, type: "verify" },
    { pattern: /总线/, type: "bus_communication" },
    { pattern: /设置|置/, type: "set_input_data" },
  ]

  return steps.map((step) => {
    const desc = String(step["步骤描述"] ?? "")
    const expected = String(step["预期结果"] ?? "")
    const combined = desc + expected

    // channel
    if (!step["channel"]) {
      if (/CANA/i.test(combined)) step["channel"] = "CANA"
      else if (/CANB/i.test(combined)) step["channel"] = "CANB"
      else step["channel"] = ""
    }

    // operation_type
    if (!step["operation_type"]) {
      for (const rule of operationRules) {
        if (rule.pattern.test(desc)) {
          step["operation_type"] = rule.type
          break
        }
      }
      if (!step["operation_type"]) step["operation_type"] = "other"
    }

    // temporal
    if (!step["temporal"]) {
      const m = desc.match(timePattern)
      if (m) step["temporal"] = `第${m[1]}秒`
    }

    return step
  })
}

/**
 * ct_suite_add_case — Append one ConfirmationTestCase to the suite.
 *
 * Field names match the auto-testcase-generator database schema (doc_tr_case).
 */
export const ctSuiteAddCase: ToolDefinition = tool({
  description:
    "Add a single confirmation test case to the suite using database-format fields. " +
    "The suite must have been created with ct_suite_create first. " +
    "Call this once per test case — design one case, add it immediately, then design the next.",
  args: {
    case_id: tool.schema
      .string()
      .describe("Test case ID, e.g. TC-GN-INIT-001"),
    case_name: tool.schema.string().max(50).describe("Test case name (≤50 chars)"),
    test_purpose: tool.schema.string().describe("What the test verifies"),
    correspond_fun_id: tool.schema
      .string()
      .describe("TR requirement ID this case is derived from (e.g. TR-GN-JJZL-001)"),
    test_type: tool.schema
      .string()
      .describe("Chinese test type, e.g. 功能测试, 接口测试, 性能测试, 可靠性安全性测试, 边界测试, 强度测试"),
    test_step: tool.schema
      .any()
      .describe(
        'Test steps as an array or legacy JSON string, e.g. [{"步骤描述":"操作步骤。","预期结果":"预期结果。"}]',
      ),
    test_environment: tool.schema
      .string()
      .optional()
      .describe("Legacy compatibility field. Persisted value is normalized by test_environment_mode."),
    test_environment_mode: tool.schema
      .enum(TEST_ENVIRONMENT_MODE_VALUES)
      .optional()
      .describe(
        "Persisted test environment mode. software=软平台测试环境（默认），" +
        "evaluation=硬平台测试环境。预留给后续按软件/鉴定类型切换。",
      ),
    initial_settings: tool.schema
      .string()
      .optional()
      .describe("Initial state / preconditions before the test; defaults to 无"),
    test_input: tool.schema
      .string()
      .optional()
      .describe("Test input description; defaults to 无"),
    constraints: tool.schema
      .string()
      .optional()
      .describe("Constraints; defaults to 无"),
    assess_criteria: tool.schema
      .string()
      .optional()
      .describe("Assessment criteria; defaults to 实际结果与预期结果一致"),
    cease_condition: tool.schema
      .string()
      .optional()
      .describe("Termination condition; defaults to standard Z1/Z2 text"),
    path: tool.schema
      .string()
      .optional()
      .describe("Hierarchy path, e.g. /6/2/1/"),
    covered_tr_items: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "本用例实际覆盖的 TR-ID 列表(worker 回包的 covered_tr_items 原样透传,支持原子 ID 或范围/顿号串)。" +
          "优先级高于 related_software_req_ids;仅含单个 TR-ID 的需求项可省略",
      ),
    related_software_req_ids: tool.schema
      .string()
      .optional()
      .describe('Range-style string of ONLY this case\'s TR-IDs, e.g. "TR-JK-001~003、TR-JK-005"; never the whole requirement group'),
    action: tool.schema
      .enum(["append", "replace"])
      .optional()
      .default("append")
      .describe("append=add new case (default); replace=replace existing case with same case_id"),
    designer: tool.schema.string().optional().describe("Designer name"),
    designer_date: tool.schema
      .string()
      .optional()
      .describe("Design date in YYYYMMDD format"),
    translate_status: tool.schema
      .enum(["success", "failure", "not_applicable"])
      .optional()
      .describe("success=all automation steps matched; failure=translation failed; not_applicable=manual boot/initialization, performance or margin requirement, verified from requirements; auto-detected when omitted"),
  },
  async execute({
    case_id,
    case_name,
    test_purpose,
    correspond_fun_id,
    test_type,
    test_step,
    test_environment,
    test_environment_mode,
    initial_settings,
    test_input,
    constraints,
    assess_criteria,
    cease_condition,
    path,
    covered_tr_items,
    related_software_req_ids,
    action,
    designer,
    designer_date,
    translate_status,
  }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.CONFIRMATION_TESTS)
    const requirementIndex = loadRequirementIndexFromDisk()

    return await withFileLock(filePath, () => {
      if (!existsSync(filePath)) {
        return JSON.stringify({
          error:
            "Suite file not found. Call ct_suite_create first before adding cases.",
        })
      }

      let suite: any
      try {
        suite = JSON.parse(readFileSync(filePath, "utf-8"))
      } catch {
        return JSON.stringify({ error: "Failed to parse existing suite file." })
      }

      // Handle "replace" action: remove existing case with same case_id before appending
      const replaceMode = action === "replace"
      let replacedExisting = false
      if (replaceMode && Array.isArray(suite.test_cases)) {
        const existingIndex = suite.test_cases.findIndex((tc: any) => tc.case_id === case_id)
        if (existingIndex >= 0) {
          suite.test_cases.splice(existingIndex, 1)
          replacedExisting = true
        }
      }

      // Normalize test_step to array form and enrich with semantic anchors
      let enrichedSteps: Array<Record<string, unknown>>
      if (typeof test_step === "string") {
        try { enrichedSteps = JSON.parse(test_step) as Array<Record<string, unknown>> }
        catch { enrichedSteps = [] }
      } else if (Array.isArray(test_step)) {
        enrichedSteps = test_step as Array<Record<string, unknown>>
      } else {
        enrichedSteps = []
      }
      enrichedSteps = enrichStepAnchors(enrichedSteps)

      try {
        const appended = appendConfirmationCaseToSuiteData(
          suite,
          {
            case_id,
            case_name,
            test_purpose,
            correspond_fun_id,
            test_type,
            test_step: enrichedSteps,
            test_environment,
            test_environment_mode,
            initial_settings,
            test_input,
            constraints,
            assess_criteria,
            cease_condition,
            path,
            covered_tr_items,
            related_software_req_ids,
            designer,
            designer_date,
            translate_status,
          },
          requirementIndex,
        )

        writeJsonFileAtomic(filePath, appended.suite)

        return JSON.stringify({
          status: "success",
          action: replacedExisting ? "replaced" : "added",
          case_id: appended.canonical_case_id,
          test_environment: appended.persisted_test_environment,
          ...(appended.warnings.length > 0 ? { warnings: appended.warnings } : {}),
          ...(replacedExisting ? { replaced_existing: true } : {}),
          ...(case_id !== appended.canonical_case_id
            ? { warning: `输入的 case_id 已规范化为 ${appended.canonical_case_id}` }
            : {}),
          ...(path !== appended.canonical_path && appended.canonical_path
            ? { path_warning: `输入的 path 已规范化为 ${appended.canonical_path}` }
            : {}),
          ...(test_environment !== undefined
            ? { test_environment_warning: `输入的 test_environment 已被统一写为 ${appended.persisted_test_environment}` }
            : {}),
          total_cases: Array.isArray(appended.suite.test_cases) ? appended.suite.test_cases.length : 0,
          file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
        })
      } catch (error) {
        return JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  },
})

/**
 * ct_suite_import_cases — Import multiple test cases into the suite in a single call.
 *
 * Use this for batch import when you have many cases (>10) to avoid the overhead
 * of calling ct_suite_add_case for each one individually. Each case goes through
 * the same normalization and canonical case_id generation as ct_suite_add_case.
 */
export const ctSuiteImportCases: ToolDefinition = tool({
  description:
    "Batch-import multiple test cases into the confirmation test suite. " +
    "Each case goes through the same normalization logic as ct_suite_add_case " +
    "(canonical case_id generation, anchor enrichment, test environment resolution). " +
    "Use this when importing many cases at once to avoid repeated individual calls. " +
    "The suite must have been created with ct_suite_create first. " +
    "For large JSON payloads (>100KB), use cases_file to pass a file path instead of inline cases.",
  args: {
    cases: tool.schema
      .any()
      .optional()
      .describe(
        'JSON array of test case objects. Each object must include: ' +
        'case_name (required), test_purpose (required), correspond_fun_id (required), ' +
        'test_type (required, e.g. 功能测试), test_step (required, array or JSON string). ' +
        'Optional: case_id (auto-generated if missing), path, test_environment, test_environment_mode, ' +
        'initial_settings, test_input, constraints, assess_criteria, cease_condition, ' +
        'related_software_req_ids (auto-populated from covered_tr_items if empty), designer, designer_date, covered_tr_items. ' +
        'Omit this when using cases_file for large payloads.'
      ),
    cases_file: tool.schema
      .string()
      .optional()
      .describe(
        'Path to a JSON file containing the cases array. Use this instead of cases for large payloads (>100KB) ' +
        'that would exceed tool call context limits when passed inline. ' +
        'The file must contain a valid JSON array of test case objects in the same format as the cases parameter. ' +
        'Mutually exclusive with cases — provide one or the other.'
      ),
    action: tool.schema
      .enum(["append", "replace"])
      .optional()
      .default("append")
      .describe("append=add all new cases (default); replace=replace cases with matching case_ids"),
  },
  async execute({ cases, cases_file, action }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.CONFIRMATION_TESTS)
    const requirementIndex = loadRequirementIndexFromDisk()

    return await withFileLock(filePath, () => {
      if (!existsSync(filePath)) {
        return JSON.stringify({
          error: "Suite file not found. Call ct_suite_create first before importing cases.",
        })
      }

      let suite: any
      try {
        suite = JSON.parse(readFileSync(filePath, "utf-8"))
      } catch {
        return JSON.stringify({ error: "Failed to parse existing suite file." })
      }

      // Resolve cases from either cases_file or inline cases parameter
      let caseList: any[]
      if (cases_file) {
        // File path input — designed for large payloads that can't fit inline
        const resolvedPath = (cases_file.startsWith("/") || /^[A-Za-z]:\\/.test(cases_file))
          ? cases_file
          : join(process.cwd(), cases_file)
        if (!existsSync(resolvedPath)) {
          return JSON.stringify({ error: `cases_file not found: ${resolvedPath}` })
        }
        try {
          const fileContent = readFileSync(resolvedPath, "utf-8")
          caseList = parseAndRepairJson(fileContent, resolvedPath)
          if (!Array.isArray(caseList)) {
            return JSON.stringify({ error: `cases_file content is not a JSON array: ${resolvedPath}` })
          }
        } catch (e) {
          return JSON.stringify({ error: `Failed to parse cases_file: ${e instanceof Error ? e.message : String(e)}` })
        }
      } else if (cases !== undefined && cases !== null) {
        caseList = Array.isArray(cases) ? cases : (() => {
          if (typeof cases === "string") {
            return parseAndRepairJson(cases, "<inline>")
          }
          return []
        })()
      } else {
        return JSON.stringify({ error: "Either cases or cases_file must be provided" })
      }

      if (caseList.length === 0) {
        return JSON.stringify({ error: "cases must be a non-empty JSON array" })
      }

      const replaceMode = action === "replace"
      const results: Array<{ index: number; status: string; case_id: string; case_name?: string }> = []
      let added = 0
      let replaced = 0
      let failed = 0
      const errors: Array<{ index: number; message: string }> = []

      for (let i = 0; i < caseList.length; i++) {
        const rawCase = caseList[i]
        if (typeof rawCase !== "object" || rawCase === null) {
          failed++
          errors.push({ index: i, message: `case[${i}] is not an object` })
          continue
        }

        // case_id must never contain range syntax — strip if present
        const rawCaseId = String(rawCase.case_id ?? "")
        const inputCaseId = sanitizeRangeField(rawCaseId)

        // correspond_fun_id uses 、-separated multi-ID format (e.g. "TR-001、TR-002、TR-003")
        const correspondFunId = String(rawCase.correspond_fun_id ?? rawCase.correspondFunId ?? "")

        // Replace mode: remove existing case with same case_id
        let replacedExisting = false
        if (replaceMode && inputCaseId && Array.isArray(suite.test_cases)) {
          const existingIndex = suite.test_cases.findIndex((tc: any) => tc.case_id === inputCaseId)
          if (existingIndex >= 0) {
            suite.test_cases.splice(existingIndex, 1)
            replacedExisting = true
          }
        }

        // Normalize test_step
        const rawSteps = rawCase.test_step ?? rawCase.testSteps ?? []
        let enrichedSteps: Array<Record<string, unknown>>
        if (typeof rawSteps === "string") {
          try { enrichedSteps = JSON.parse(rawSteps) }
          catch { enrichedSteps = [] }
        } else if (Array.isArray(rawSteps)) {
          enrichedSteps = rawSteps as Array<Record<string, unknown>>
        } else {
          enrichedSteps = []
        }
        enrichedSteps = enrichStepAnchors(enrichedSteps)

        try {
          const appended = appendConfirmationCaseToSuiteData(
            suite,
            {
              case_id: inputCaseId || undefined,
              case_name: String(rawCase.case_name ?? rawCase.test_case_name ?? `未命名-${i + 1}`),
              test_purpose: String(rawCase.test_purpose ?? ""),
              correspond_fun_id: correspondFunId,
              // Empty string → appendConfirmationCaseToSuiteData derives the type
              // from the matched requirement (chapter title) instead of mislabeling
              // every imported case as 功能测试.
              test_type: String(rawCase.test_type ?? rawCase.testType ?? ""),
              test_step: enrichedSteps,
              test_environment: rawCase.test_environment ?? rawCase.testEnvironment,
              test_environment_mode: rawCase.test_environment_mode ?? rawCase.testEnvironmentMode ?? "software",
              initial_settings: rawCase.initial_settings ?? rawCase.initialSettings ?? "无",
              test_input: rawCase.test_input ?? rawCase.testInput ?? "无",
              constraints: rawCase.constraints ?? "无",
              assess_criteria: rawCase.assess_criteria ?? rawCase.assessCriteria ?? "实际结果与预期结果一致",
              cease_condition: rawCase.cease_condition ?? rawCase.ceaseCondition,
              path: rawCase.path,
              covered_tr_items: Array.isArray(rawCase.covered_tr_items ?? rawCase.coveredTrItems)
                ? (rawCase.covered_tr_items ?? rawCase.coveredTrItems).map(String)
                : undefined,
              related_software_req_ids: normalizeIdListInput(
                rawCase.related_software_req_ids ?? rawCase.relatedSoftwareReqIds,
              ),
              designer: rawCase.designer,
              designer_date: rawCase.designer_date ?? rawCase.designerDate,
              // Legacy "partial" raw values normalize to "failure" (two-state contract)
              translate_status: (rawCase.translate_status ?? rawCase.translateStatus) === "partial"
                ? "failure"
                : (rawCase.translate_status ?? rawCase.translateStatus ?? undefined),
            },
            requirementIndex,
          )

          suite = appended.suite
          const status = replacedExisting ? "replaced" : "added"
          if (replacedExisting) replaced++
          else added++

          results.push({
            index: i,
            status,
            case_id: appended.canonical_case_id,
            case_name: appended.persisted_case.case_name,
          })
        } catch (error) {
          failed++
          const msg = error instanceof Error ? error.message : String(error)
          errors.push({ index: i, message: msg })
          results.push({
            index: i,
            status: "failed",
            case_id: inputCaseId || `index-${i}`,
          })
        }
      }

      writeJsonFileAtomic(filePath, suite)

      return JSON.stringify({
        status: failed === 0 ? "success" : (added + replaced > 0 ? "partial_success" : "error"),
        summary: { total: caseList.length, added, replaced, failed },
        total_cases_in_suite: Array.isArray(suite.test_cases) ? suite.test_cases.length : 0,
        results,
        ...(errors.length > 0 ? { errors: errors.slice(0, 20) } : {}),
        file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
      })
    })
  },
})

/**
 * ct_suite_finalize — Compute traceability + summary and validate with Zod.
 * Also generates a natural-language DOCX confirmation test document.
 * Keyword translation is inline during generation — no translation here.
 */
export const ctSuiteFinalize: ToolDefinition = tool({
  description:
    "Finalize the confirmation test suite: reads test-requirements.json to compute " +
    "the traceability matrix, calculates summary statistics (by_type), " +
    "and validates the source suite against the SourceConfirmationTestSuite Zod schema. " +
    "Automatically generates a natural-language DOCX confirmation test document. " +
    "Subagent now performs inline keyword translation during test case generation, outputting " +
    "Combined format steps (key_name, step_desc, parameter[]). No separate translation step needed. " +
    "Call this after all test cases have been added with ct_suite_add_case.",
  args: {},
  async execute(_args, context) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.CONFIRMATION_TESTS)

    return await withFileLock(filePath, async () => {
      if (!existsSync(filePath)) {
        return JSON.stringify({
          error:
            "Suite file not found. Call ct_suite_create and add cases first.",
        })
      }

      let suite: any
      try {
        suite = JSON.parse(readFileSync(filePath, "utf-8"))
      } catch (error) {
        return JSON.stringify({
          error: "Source suite JSON parse failed",
          source_suite_file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
          issues: [
            {
              path: ARTIFACT_PATHS.CONFIRMATION_TESTS,
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        })
      }

      let finalized: ConfirmationSuiteFinalizeResult
      try {
        finalized = finalizeConfirmationSuiteData(suite, loadTestRequirementsArtifactFromDisk())
      } catch (error) {
        return JSON.stringify({
          error: "Source suite finalization failed",
          source_suite_file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
          issues: [{ path: "", message: error instanceof Error ? error.message : String(error) }],
        })
      }

      try {
        writeJsonFileAtomic(filePath, finalized.suite)

        // Translation is now inline — subagent outputs Combined format directly
        const todo = writePhase6TestCasesTodoFromSuite(process.cwd(), finalized.suite, "initial_generation")

        // ── DOCX generation (natural language, always performed) ────────────
        let docxFile: string | undefined
        let docxError: string | undefined
        try {
          const { ctDocxGenerator } = await import("./ct-docx-generator")
          const docxResultRaw = await (ctDocxGenerator as any).execute(
            {
              test_cases_file: filePath,
              output_path: join(process.cwd(), ".matrix", "reports", "confirmation-tests.docx"),
            },
            context,
          )
          const docxResult = typeof docxResultRaw === "string"
            ? JSON.parse(docxResultRaw)
            : docxResultRaw
          if (docxResult?.output_file) {
            docxFile = docxResult.output_file
          } else if (docxResult?.error) {
            docxError = docxResult.error
          }
        } catch (docxErr) {
          docxError = docxErr instanceof Error ? docxErr.message : String(docxErr)
        }

        const result: Record<string, unknown> = {
          status: "success",
          action: "finalized",
          file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
          source_suite_file: ARTIFACT_PATHS.CONFIRMATION_TESTS,
          docx_file: docxFile,
          todo_file: todo.todo_file,
          todo_case_count: todo.case_count,
          summary: finalized.summary,
          traceability: finalized.traceability,
          message: `Finalized suite: ${finalized.summary.total_cases} test cases, traceability computed, schema validated.`,
        }
        if (docxError) {
          result.docx_error = docxError
        }
        return JSON.stringify(result)
      } catch (error) {
        return JSON.stringify({
          error: "Source suite finalization failed",
          issues: [{ path: "", message: error instanceof Error ? error.message : String(error) }],
        })
      }
    })
  },
})
