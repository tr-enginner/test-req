import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, isAbsolute, join, resolve } from "path"
import {
  SourceConfirmationTestSuite,
  extractSourceSteps,
} from "../schema/confirmation-test-case"
import {
  Phase6CaseReviewPrepared,
  type Phase6PreparedCandidateIssue,
  type Phase6PreparedFieldIssue,
  type Phase6PreparedPlaceholder,
  type Phase6PreparedSemanticValidationFailure,
  type Phase6PreparedSummary,
  type Phase6PreparedTemplateBaseline,
} from "../schema/phase6-case-review-prepared"
import { loadPluginConfig } from "../plugin-config"
import { ARTIFACT_PATHS } from "../shared/constants"
import {
  collectUnresolvedPlaceholders,
  requiredPrimaryBusesFromRequirementContext,
  validatePersistedPhase6Steps,
  type RequirementSemanticContext,
} from "../shared/keyword-argument-binding"
import { analyzeRequiredPrimaryBusCoverage } from "../shared/phase6-confirmation-translator"
import {
  extractPhase6PromptRuleSections,
  loadPhase6PromptTemplates,
  normalizePhase6TestType,
  resolvePhase6PromptTemplate,
  type Phase6ProjectType,
} from "../shared/phase6-prompt-templates"
import {
  expandFunIdString,
  loadTestRequirementFile,
  preparePhase6Input,
  findCrossRequirementContext,
  getStressProtocolContextGaps,
  type PreparedPhase6Requirement,
} from "../shared/test-requirements"
import { moduleDir } from "../shared/runtime-paths"
import { resolveFunctionalModel, validateFunctionalModelSteps } from "../shared/phase6-functional-model"
import { isManualTestRequirement, manualTestEnvironment, validateTestTypeCases } from "../shared/phase6-test-type-policy"
import { explicitStepAction, translatedStepSemanticIssues } from "../shared/testcase-step-semantics"

type ReviewSeverity = "blocking" | "major" | "minor"

interface MinimalReviewIssue {
  severity: ReviewSeverity
  category: string
  description: string
  suggestion?: string
  count?: number
  sample_ids?: string[]
  sample_locations?: string[]
}

function getToolBaseDirectory(ctx?: ToolContext): string {
  const candidates = [ctx?.directory, ctx?.worktree, process.cwd()]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  return candidates[0] || process.cwd()
}

function resolvePath(projectDir: string, supplied: string | undefined, fallback: string): string {
  if (!supplied) return join(projectDir, fallback)
  return isAbsolute(supplied) ? supplied : join(projectDir, supplied)
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

function uniq(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))]
}

function normalizeText(value: string): string {
  return value
    .replace(/[\s\t\r\n]+/g, " ")
    .replace(/[，。；：、,.!?:;()[\]{}<>\-_/\\]+/g, " ")
    .toLowerCase()
    .trim()
}

function stableSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function takeSample(values: string[], limit = 5): string[] {
  return values.slice(0, limit)
}

/** English type key → canonical Chinese test type name (mirrors the generation-side mapping). */
const TYPE_TO_CHINESE: Record<string, string> = {
  functional: "功能测试",
  interface: "接口测试",
  performance: "性能测试",
  robustness: "可靠性安全性测试",
  safety: "可靠性安全性测试",
  boundary: "边界测试",
  stress: "强度测试",
  margin: "余量测试",
  data_processing: "数据处理测试",
  recovery: "恢复性测试",
  logic: "逻辑测试",
  logic_test: "逻辑测试",
  timing: "时序测试",
}

/** Resolve a requirement's canonical Chinese test type name (null when undetermined). */
function resolveRequirementTestTypeChinese(requirement: PreparedPhase6Requirement): string | null {
  return TYPE_TO_CHINESE[requirement.test_type] ?? normalizePhase6TestType(requirement.test_type)
}

interface TestTypeMismatch {
  case_id: string
  correspond_fun_id: string
  expected_type: string
  actual_type: string
}

function compactIssue(issue: MinimalReviewIssue): Phase6PreparedCandidateIssue {
  return {
    severity: issue.severity,
    category: issue.category,
    description: issue.description,
    ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
    ...(issue.count !== undefined ? { count: issue.count } : {}),
    sample_ids: takeSample(issue.sample_ids ?? []),
    sample_locations: takeSample(issue.sample_locations ?? []),
  }
}

function formatSchemaIssues(issues: Array<{ path: PropertyKey[]; message: string }>, limit = 20): string[] {
  return issues.slice(0, limit).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root"
    return `${path}: ${issue.message}`
  })
}

function buildRequirementMap(requirements: PreparedPhase6Requirement[]): Map<string, PreparedPhase6Requirement> {
  return new Map(requirements.map((requirement) => [requirement.requirement_id, requirement]))
}

/**
 * Match a test case's correspond_fun_id (possibly 、-separated multi-ID with
 * ~ ranges) against the prepared requirement map (keyed by 、-separated
 * requirement_id).
 *
 * Tries, in order:
 *   1. exact string match
 *   2. sorted individual-ID-set comparison after ~ range expansion
 *   3. ID intersection: attribute the case to the requirement sharing the most
 *      IDs (a case may legitimately cover a subset of one requirement's TR-IDs)
 */
function matchRequirementByCorrespondFunId(
  requirementMap: Map<string, PreparedPhase6Requirement>,
  correspondFunId: string,
): PreparedPhase6Requirement | undefined {
  const exact = requirementMap.get(correspondFunId)
  if (exact) return exact

  const funIds = expandFunIdString(correspondFunId)
  if (funIds.length === 0) return undefined
  const sorted = stableSorted(funIds)
  for (const requirement of requirementMap.values()) {
    const reqIds = stableSorted(
      (requirement.source_requirement_ids ?? []).flatMap((id) => expandFunIdString(id)),
    )
    if (reqIds.length === sorted.length && reqIds.every((id, index) => id === sorted[index])) {
      return requirement
    }
  }

  let bestMatch: { requirement: PreparedPhase6Requirement; shared: number } | undefined
  for (const requirement of requirementMap.values()) {
    const reqIds = (requirement.source_requirement_ids ?? []).flatMap((id) => expandFunIdString(id))
    const shared = funIds.filter((id) => reqIds.includes(id)).length
    if (shared > 0 && (!bestMatch || shared > bestMatch.shared)) {
      bestMatch = { requirement, shared }
    }
  }
  return bestMatch?.requirement
}

function buildRequirementContext(
  requirement: PreparedPhase6Requirement | undefined,
  testTypeChinese: string,
): RequirementSemanticContext | undefined {
  if (!requirement) return undefined
  return {
    requirementId: requirement.requirement_id,
    requirementHandling: requirement.handling,
    chapterBackground: requirement.chapter_background,
    chapterTitle: requirement.chapter_title,
    inputFlow: requirement.inputFlow,
    outputFlow: requirement.outputFlow,
    testTypeChinese,
  }
}

function isMeaningfulText(value: string): boolean {
  const normalized = value.trim()
  return Boolean(normalized) && !/^(无|待补充|tbd|todo|n\/a)$/i.test(normalized)
}

function isUnclearPurpose(caseName: string, purpose: string): boolean {
  const compactName = normalizeText(caseName)
  const compactPurpose = normalizeText(purpose)
  if (!compactPurpose) return true
  if (compactPurpose === compactName) return true
  if (/^(验证|检查|测试)(功能|接口|性能|安全性|正确性|是否正确|是否正常)?$/.test(compactPurpose)) {
    return true
  }
  return false
}

function buildTemplateBaseline(
  testType: string,
  projectType: Phase6ProjectType,
  loadedTemplates: ReturnType<typeof loadPhase6PromptTemplates>,
  domain: string,
): Phase6PreparedTemplateBaseline {
  const resolved = resolvePhase6PromptTemplate({
    loaded: loadedTemplates,
    testTypeChinese: normalizePhase6TestType(testType),
    projectType,
    domain,
  })
  const sections = extractPhase6PromptRuleSections(resolved.body)

  return {
    test_type: testType,
    project_type: projectType,
    template_key: resolved.key,
    template_source: resolved.source,
    ...(resolved.file ? { template_file: resolved.file } : {}),
    template_hash: resolved.hash ?? createHash("sha256").update(resolved.body).digest("hex"),
    ...(resolved.index_file ? { template_index_file: resolved.index_file } : {}),
    template_domain: domain,
    ...(resolved.selection_reason ? { template_selection_reason: resolved.selection_reason } : {}),
    general_rules: sections.general_rules,
    type_rules: sections.type_rules,
    warnings: loadedTemplates.warnings,
  }
}

/** Versioned manifests pin the generation template; historical artifacts remain reviewable with an explicit warning. */
function validateTemplateProvenance(args: {
  projectDir: string
  testRequirementsPath: string
  projectType: Phase6ProjectType
  domain: string
  requirements: PreparedPhase6Requirement[]
  baselines: Map<string, Phase6PreparedTemplateBaseline>
  warnings: string[]
}): Phase6PreparedCandidateIssue[] {
  const manifestPath = join(args.projectDir, ARTIFACT_PATHS.PHASE6_GENERATION_MANIFEST)
  const issues: Phase6PreparedCandidateIssue[] = []
  const issue = (description: string, requirementId?: string) => {
    issues.push(compactIssue({
      severity: "blocking",
      category: "template_provenance",
      description,
      suggestion: "恢复生成时的模板与领域配置，或使用当前模板重新生成相关需求用例和生成清单，再重新审查；不得只改写来源记录以绕过校验。",
      sample_ids: requirementId ? [requirementId] : [],
      sample_locations: [manifestPath],
    }))
  }
  if (!existsSync(manifestPath)) {
    args.warnings.push("未找到 Phase 6 生成清单，历史工件无模板来源可验证；当前模板仅作为审查参考，不代表已验证生成与审查来源一致。")
    return issues
  }
  let manifest: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("生成清单必须是 JSON 对象")
    manifest = parsed as Record<string, unknown>
  } catch (error) {
    issue(`无法解析 Phase 6 模板来源清单：${error instanceof Error ? error.message : String(error)}`)
    return issues
  }
  if (manifest.template_provenance_version === undefined) {
    args.warnings.push("Phase 6 生成清单为旧版本，无模板来源可验证；当前模板仅作为审查参考，不代表已验证生成与审查来源一致。")
    return issues
  }
  if (manifest.template_provenance_version !== 1) {
    issue(`不支持的模板来源版本：${String(manifest.template_provenance_version)}。`)
    return issues
  }
  if (manifest.domain !== args.domain) {
    issue(`生成清单 domain 缺失或发生漂移：生成时 ${String(manifest.domain)}，当前 ${args.domain}。`)
  }
  const normalizedPath = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? resolve(args.projectDir, value) : null
  if (normalizedPath(manifest.test_requirements_file) !== normalizedPath(args.testRequirementsPath)) {
    issue(`生成清单 test_requirements_file 缺失或与当前审查输入不一致：生成时 ${String(manifest.test_requirements_file)}，当前 ${args.testRequirementsPath}。`)
  }
  if (manifest.project_type !== args.projectType) {
    issue(`生成清单 project_type 缺失或发生漂移：生成时 ${String(manifest.project_type)}，当前 ${args.projectType}。`)
  }
  if (!Array.isArray(manifest.items)) {
    issue("版本 1 生成清单缺少有效 items，无法核验逐需求模板来源。")
    return issues
  }
  const items = manifest.items.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item))
  for (const requirement of args.requirements) {
    const requirementId = requirement.requirement_id
    const matches = items.filter((item) => item.requirement_id === requirementId)
    if (matches.length !== 1) {
      issue(`${requirementId} 的生成模板来源记录${matches.length === 0 ? "缺失" : "重复"}，要求每条需求恰有一条记录。`, requirementId)
      continue
    }
    const item = matches[0]!
    const requiredStrings = ["project_type", "template_key", "template_source", "template_hash", "template_domain", "template_selection_reason"]
    const missing = requiredStrings.filter((key) => typeof item[key] !== "string" || !String(item[key]).trim())
    for (const key of ["template_file", "template_index_file"]) {
      if (!(key in item) || (item[key] !== null && (typeof item[key] !== "string" || !String(item[key]).trim()))) missing.push(key)
      else if (item.template_source === "markdown" && item[key] === null) missing.push(key)
    }
    if (missing.length > 0) {
      issue(`${requirementId} 的版本 1 模板来源字段不完整：${missing.join("、")}。`, requirementId)
      continue
    }
    if (!/^[a-f0-9]{64}$/i.test(String(item.template_hash)) || !["markdown", "legacy", "builtin"].includes(String(item.template_source))) {
      issue(`${requirementId} 的模板来源 hash 或 source 格式非法。`, requirementId)
      continue
    }
    const testType = resolveRequirementTestTypeChinese(requirement) ?? requirement.test_type
    const baseline = args.baselines.get(testType)
    if (!baseline || baseline.template_source === "unresolved") continue // A separate blocking resolution issue explains the failure.
    const comparisons: Array<[string, unknown, unknown]> = [
      ["project_type", item.project_type, args.projectType],
      ["template_key", item.template_key, baseline.template_key],
      ["template_source", item.template_source, baseline.template_source],
      ["template_hash", String(item.template_hash).toLowerCase(), baseline.template_hash],
      ["template_domain", item.template_domain, args.domain],
      ["template_file", normalizedPath(item.template_file), normalizedPath(baseline.template_file)],
      ["template_index_file", normalizedPath(item.template_index_file), normalizedPath(baseline.template_index_file)],
    ]
    const changed = comparisons.filter(([, recorded, current]) => recorded !== current)
    if (changed.length > 0) {
      issue(`${requirementId} 的生成/审查模板来源发生漂移：${changed.map(([key, recorded, current]) => `${key}（生成=${String(recorded)}，当前=${String(current)}）`).join("；")}。`, requirementId)
    }
  }
  return issues
}

function buildCandidateIssues(args: {
  uncoveredRequirementIds: string[]
  brokenLinkCaseIds: string[]
  brokenLinkLocations: string[]
  pathMismatchCaseIds: string[]
  relatedMismatchCaseIds: string[]
  typeMismatchCases: TestTypeMismatch[]
  unresolvedPlaceholders: Phase6PreparedPlaceholder[]
  fieldIssues: Phase6PreparedFieldIssue[]
  semanticFailures: Phase6PreparedSemanticValidationFailure[]
  unclearPurposeCaseIds: string[]
  toolErrors: string[]
  templateWarnings: string[]
}): Phase6PreparedCandidateIssue[] {
  const issues: MinimalReviewIssue[] = []

  if (args.toolErrors.length > 0) {
    issues.push({
      severity: "blocking",
      category: "artifact_validation",
      description: `Phase 6 结构化预审失败：${args.toolErrors[0]}`,
      suggestion: "先修复 confirmation-tests.json 或 test-requirements.json 的 JSON/schema 问题，再重新执行审查。",
      count: args.toolErrors.length,
      sample_locations: takeSample(args.toolErrors),
    })
  }

  if (args.uncoveredRequirementIds.length > 0) {
    issues.push({
      severity: "blocking",
      category: "coverage_completeness",
      description: `${args.uncoveredRequirementIds.length} 条测试需求没有任何确认测试用例覆盖。`,
      suggestion: "为未覆盖的 requirement 补充确认测试用例，或修正用例中的 correspond_fun_id。",
      count: args.uncoveredRequirementIds.length,
      sample_ids: args.uncoveredRequirementIds,
    })
  }

  if (args.brokenLinkCaseIds.length > 0) {
    issues.push({
      severity: "blocking",
      category: "traceability",
      description: `${args.brokenLinkCaseIds.length} 条用例引用了不存在的 requirement 标识。`,
      suggestion: "修正 correspond_fun_id，使其精确对应 test-requirements.json 中存在的 requirement_id。",
      count: args.brokenLinkCaseIds.length,
      sample_ids: args.brokenLinkCaseIds,
      sample_locations: args.brokenLinkLocations,
    })
  }

  if (args.typeMismatchCases.length > 0) {
    issues.push({
      severity: "blocking",
      category: "test_type_mismatch",
      description: `${args.typeMismatchCases.length} 条用例的 test_type 与其对应测试需求类型不符。`,
      suggestion: "将用例 test_type 修正为该 requirement 的 test_type_chinese，或删除无需求依据的冗余用例。",
      count: args.typeMismatchCases.length,
      sample_ids: args.typeMismatchCases.map((item) => item.case_id),
      sample_locations: args.typeMismatchCases.map((item) =>
        `${item.case_id}: ${item.actual_type} → 应为 ${item.expected_type}`),
    })
  }

  if (args.pathMismatchCaseIds.length > 0) {
    issues.push({
      severity: "blocking",
      category: "path_traceability",
      description: `${args.pathMismatchCaseIds.length} 条用例的 path 与测试需求章节路径不一致。`,
      suggestion: "按 test-requirements.json 中 requirement 所在章节的 titleNo 重新生成 path。",
      count: args.pathMismatchCaseIds.length,
      sample_ids: args.pathMismatchCaseIds,
    })
  }

  if (args.relatedMismatchCaseIds.length > 0) {
    issues.push({
      severity: "blocking",
      category: "related_requirement_traceability",
      description: `${args.relatedMismatchCaseIds.length} 条用例的 related_software_req_ids 引用了不属于对应需求项的子需求 ID。`,
      suggestion: "related_software_req_ids 只能引用该用例对应需求项（correspond_fun_id）内的具体子需求 ID，允许只引用其中的子集。修正或移除不属于该需求项的 ID。",
      count: args.relatedMismatchCaseIds.length,
      sample_ids: args.relatedMismatchCaseIds,
    })
  }

  if (args.semanticFailures.length > 0) {
    issues.push({
      severity: "blocking",
      category: "explicit_output_verification",
      description: `${args.semanticFailures.length} 条用例未满足 Phase 6 共享校验规则，例如显式输出验证、双总线覆盖或功能测试范围约束。`,
      suggestion: "根据需求、章节背景和输出流重写步骤与预期结果，并重新通过 testcase_format_check / 共享标准化校验。",
      count: args.semanticFailures.length,
      sample_ids: args.semanticFailures.map((item) => item.case_id),
    })
  }

  if (args.fieldIssues.length > 0) {
    issues.push({
      severity: "blocking",
      category: "mandatory_fields",
      description: `${args.fieldIssues.length} 处 mandatory field 缺失、无意义或不可用。`,
      suggestion: "补齐 case_name、test_purpose、test_step 等必要字段，并清理“无/TBD/待补充”之类的占位内容。",
      count: args.fieldIssues.length,
      sample_ids: args.fieldIssues.map((item) => item.case_id),
      sample_locations: args.fieldIssues.map((item) => `${item.case_id}.${item.field}`),
    })
  }

  if (args.unclearPurposeCaseIds.length > 0) {
    issues.push({
      severity: "major",
      category: "test_purpose_clarity",
      description: `${args.unclearPurposeCaseIds.length} 条用例的 test_purpose 过于空泛或与 case_name 重复，无法清晰表达测试意图。`,
      suggestion: "把 test_purpose 改成明确的验证目标，说明要验证的功能点、状态变化或输出结果。",
      count: args.unclearPurposeCaseIds.length,
      sample_ids: args.unclearPurposeCaseIds,
    })
  }

  if (args.templateWarnings.length > 0) {
    issues.push({
      severity: "minor",
      category: "template_baseline",
      description: `模板基线及来源核验存在 ${args.templateWarnings.length} 条非阻断告警。`,
      suggestion: "检查模板配置和生成清单；历史工件缺少来源记录时，仅能参考当前模板审查，不能声称已验证生成与审查模板一致。",
      count: args.templateWarnings.length,
      sample_locations: args.templateWarnings,
    })
  }

  return issues.map(compactIssue)
}

export const phase6CaseReviewPrepare: ToolDefinition = tool({
  description:
    "在代码侧解析 .matrix/data/confirmation-tests.json 与 .matrix/data/test-requirements.json，" +
    "复用 Phase 6 共享规则生成结构化预审结果，并写入 .matrix/data/reviews/case-review-prepared.json。 " +
    "该工具只返回轻量摘要，避免 reviewer 直接 Read 大型 JSON 文件。",
  args: {
    confirmation_tests_file: tool.schema
      .string()
      .optional()
      .describe("源确认测试用例文件路径，默认 .matrix/data/confirmation-tests.json"),
    test_requirements_file: tool.schema
      .string()
      .optional()
      .describe("测试需求文件路径，默认 .matrix/data/test-requirements.json"),
    output_file: tool.schema
      .string()
      .optional()
      .describe("结构化预审工件输出路径，默认 .matrix/data/reviews/case-review-prepared.json"),
    project_type: tool.schema
      .enum(["software", "fpga", "requirements", "software_variant"])
      .optional()
      .describe("Phase 6 模板项目类型，默认 software。"),
  },
  async execute({ confirmation_tests_file, test_requirements_file, output_file, project_type }, ctx) {
    const projectDir = getToolBaseDirectory(ctx)
    const config = loadPluginConfig(projectDir)
    const confirmationTestsPath = resolvePath(projectDir, confirmation_tests_file, ARTIFACT_PATHS.CONFIRMATION_TESTS)
    const testRequirementsPath = resolvePath(projectDir, test_requirements_file, ARTIFACT_PATHS.TEST_REQUIREMENTS)
    const preparedFilePath = resolvePath(projectDir, output_file, ARTIFACT_PATHS.CASE_REVIEW_PREPARED)
    const projectType: Phase6ProjectType = project_type ?? "software"
    const domain = config.domain ?? "generic"
    const generatedAt = new Date().toISOString()
    const templateWarnings: string[] = []

    const writePrepared = (payload: unknown) => {
      ensureDir(preparedFilePath)
      const validated = Phase6CaseReviewPrepared.parse(payload)
      writeFileSync(preparedFilePath, JSON.stringify(validated, null, 2), "utf-8")
      return validated
    }

    let preparedRequirements: PreparedPhase6Requirement[]
    try {
      const artifact = loadTestRequirementFile(testRequirementsPath)
      preparedRequirements = preparePhase6Input(artifact, {
        project_meta: config.project,
        workdir: projectDir,
      }).requirements
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const payload = writePrepared({
        status: "error",
        generated_at: generatedAt,
        confirmation_tests_file: confirmationTestsPath,
        test_requirements_file: testRequirementsPath,
        project_type: projectType,
        candidate_issues: [
          {
            severity: "blocking",
            category: "artifact_validation",
            description: `无法解析 test-requirements.json：${message}`,
            suggestion: "先修复测试需求工件的 JSON/schema 问题，再重新执行 Phase 6 审查。",
            sample_locations: [message],
          },
        ],
        warnings: [],
        errors: [message],
      })

      return JSON.stringify({
        status: payload.status,
        prepared_file: preparedFilePath,
        summary: null,
        counts: null,
        sample_ids: [],
        candidate_issues: payload.candidate_issues,
        errors: payload.errors,
      })
    }

    let rawSuite: unknown
    try {
      rawSuite = JSON.parse(readFileSync(confirmationTestsPath, "utf-8"))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const payload = writePrepared({
        status: "error",
        generated_at: generatedAt,
        confirmation_tests_file: confirmationTestsPath,
        test_requirements_file: testRequirementsPath,
        project_type: projectType,
        candidate_issues: [
          {
            severity: "blocking",
            category: "artifact_validation",
            description: `无法读取 confirmation-tests.json：${message}`,
            suggestion: "确认 confirmation-tests.json 存在且是合法 JSON，然后重新执行 Phase 6 审查。",
            sample_locations: [message],
          },
        ],
        warnings: [],
        errors: [message],
      })

      return JSON.stringify({
        status: payload.status,
        prepared_file: preparedFilePath,
        summary: null,
        counts: null,
        sample_ids: [],
        candidate_issues: payload.candidate_issues,
        errors: payload.errors,
      })
    }

    const suiteResult = SourceConfirmationTestSuite.safeParse(rawSuite)
    if (!suiteResult.success) {
      const schemaIssues = formatSchemaIssues(suiteResult.error.issues)
      const payload = writePrepared({
        status: "error",
        generated_at: generatedAt,
        confirmation_tests_file: confirmationTestsPath,
        test_requirements_file: testRequirementsPath,
        project_type: projectType,
        candidate_issues: [
          {
            severity: "blocking",
            category: "artifact_validation",
            description: "confirmation-tests.json 不符合 SourceConfirmationTestSuite schema。",
            suggestion: "修复 confirmation-tests.json 的字段结构后重新执行 Phase 6 审查。",
            count: suiteResult.error.issues.length,
            sample_locations: schemaIssues,
          },
        ],
        warnings: [],
        errors: schemaIssues,
      })

      return JSON.stringify({
        status: payload.status,
        prepared_file: preparedFilePath,
        summary: null,
        counts: null,
        sample_ids: [],
        candidate_issues: payload.candidate_issues,
        errors: payload.errors,
      })
    }

    const suite = suiteResult.data
    const requirementMap = buildRequirementMap(preparedRequirements)
    let loadedTemplates: ReturnType<typeof loadPhase6PromptTemplates> | undefined
    const templateResolutionIssues: Phase6PreparedCandidateIssue[] = []
    try {
      loadedTemplates = loadPhase6PromptTemplates({
        projectDir,
        importMetaDir: moduleDir(import.meta.url),
      })
      templateWarnings.push(...loadedTemplates.warnings)
    } catch (error) {
      templateResolutionIssues.push(compactIssue({
        severity: "blocking",
        category: "template_resolution",
        description: `无法加载 Phase 6 审查模板：${error instanceof Error ? error.message : String(error)}`,
        suggestion: "修复指定模板目录及 index.json 后重新审查，不得静默改用其他模板。",
      }))
    }
    const coveredRequirementIds = new Set<string>()
    const brokenLinks: Array<{ case_id: string; field: string; referenced_id: string; message: string }> = []
    const pathMismatches: Array<{ case_id: string; correspond_fun_id: string; expected_path: string; actual_path: string }> = []
    const relatedRequirementMismatches: Array<{ case_id: string; correspond_fun_id: string; expected_ids: string[]; actual_ids: string[] }> = []
    const unresolvedPlaceholders: Phase6PreparedPlaceholder[] = []
    const fieldIssues: Phase6PreparedFieldIssue[] = []
    const semanticValidationFailures: Phase6PreparedSemanticValidationFailure[] = []
    const unclearPurposeCaseIds: string[] = []
    const typeMismatches: TestTypeMismatch[] = []
    const casesByRequirement = new Map<string, Array<{
      case_id: string
      case_name: string
      test_purpose: string
      test_type: string
      test_environment: string
      test_step: Array<{ 步骤描述: string; 预期结果: string }>
    }>>()

    const baselineByTestType = new Map<string, Phase6PreparedTemplateBaseline>()
    const ensureTemplateBaseline = (testType: string) => {
      if (baselineByTestType.has(testType)) return
      if (loadedTemplates) {
        try {
          baselineByTestType.set(testType, buildTemplateBaseline(testType, projectType, loadedTemplates, domain))
          return
        } catch (error) {
          templateResolutionIssues.push(compactIssue({
            severity: "blocking",
            category: "template_resolution",
            description: `无法解析 ${testType} 的 Phase 6 审查模板：${error instanceof Error ? error.message : String(error)}`,
            suggestion: "修复该测试类型的模板映射和 Markdown 文件后重新审查，不得静默改用其他模板。",
          }))
        }
      }
      baselineByTestType.set(testType, {
        test_type: testType,
        project_type: projectType,
        template_key: "unresolved",
        template_source: "unresolved",
        template_domain: domain,
        general_rules: [],
        type_rules: [],
        warnings: [],
      })
    }
    // Template provenance follows the input requirement, not a potentially wrong case type.
    for (const requirement of preparedRequirements) {
      ensureTemplateBaseline(resolveRequirementTestTypeChinese(requirement) ?? requirement.test_type)
    }
    const templateProvenanceIssues = validateTemplateProvenance({
      projectDir,
      testRequirementsPath,
      projectType,
      domain,
      requirements: preparedRequirements,
      baselines: baselineByTestType,
      warnings: templateWarnings,
    })

    const rawCases = (rawSuite as { test_cases: Array<{ test_step: unknown }> }).test_cases
    for (const [caseIndex, testCase] of suite.test_cases.entries()) {
      const caseId = testCase.case_id
      ensureTemplateBaseline(testCase.test_type)

      const requirement = matchRequirementByCorrespondFunId(requirementMap, testCase.correspond_fun_id)
      if (!requirement) {
        brokenLinks.push({
          case_id: caseId,
          field: "correspond_fun_id",
          referenced_id: testCase.correspond_fun_id,
          message: `case ${caseId} 引用了不存在的 requirement_id ${testCase.correspond_fun_id}`,
        })
        continue
      }

      coveredRequirementIds.add(requirement.requirement_id)

      // Test type consistency: the case's test_type must match the requirement's
      // type (e.g. an 接口测试 requirement must not produce 功能测试 cases).
      const expectedTypeChinese = resolveRequirementTestTypeChinese(requirement)
      const caseTypeChinese = normalizePhase6TestType(testCase.test_type)
      if (expectedTypeChinese && caseTypeChinese && expectedTypeChinese !== caseTypeChinese) {
        typeMismatches.push({
          case_id: caseId,
          correspond_fun_id: testCase.correspond_fun_id,
          expected_type: expectedTypeChinese,
          actual_type: testCase.test_type,
        })
      }

      if (!isMeaningfulText(testCase.case_name)) {
        fieldIssues.push({
          case_id: caseId,
          field: "case_name",
          message: "case_name 为空或仍是占位值。",
        })
      }

      if (!isMeaningfulText(testCase.test_purpose)) {
        fieldIssues.push({
          case_id: caseId,
          field: "test_purpose",
          message: "test_purpose 为空或仍是占位值。",
        })
      } else if (isUnclearPurpose(testCase.case_name, testCase.test_purpose)) {
        unclearPurposeCaseIds.push(caseId)
      }

      const expectedPath = requirement.path
      const actualPath = String(testCase.path ?? "").trim()
      if (expectedPath && actualPath !== expectedPath) {
        pathMismatches.push({
          case_id: caseId,
          correspond_fun_id: testCase.correspond_fun_id,
          expected_path: expectedPath,
          actual_path: actualPath,
        })
      }

      // related_software_req_ids 标识该用例参考了对应需求项中的哪些具体子需求
      // 项，允许是子集（如只参考 TR-JK-011），并不负责追踪需求项的全部 funId。
      // 校验：每个 ID 必须属于该需求项展开后的 funId 集合；引用集合之外的 ID
      // 才说明软件需求追溯链断裂。测试需求中没有 sourceIds 字段，不得以整项
      // funId 列表为基线要求相等。
      const requirementIdSet = new Set(
        (requirement.source_requirement_ids ?? []).flatMap((id) => expandFunIdString(id)),
      )
      const relatedIds = expandFunIdString(String(testCase.related_software_req_ids ?? ""))
      const invalidRelatedIds = relatedIds.filter((id) => !requirementIdSet.has(id))
      if (invalidRelatedIds.length > 0) {
        relatedRequirementMismatches.push({
          case_id: caseId,
          correspond_fun_id: testCase.correspond_fun_id,
          expected_ids: stableSorted([...requirementIdSet]),
          actual_ids: stableSorted(invalidRelatedIds),
        })
      }

      const purposePlaceholders = collectUnresolvedPlaceholders(testCase.test_purpose)
      if (purposePlaceholders.length > 0) {
        unresolvedPlaceholders.push({
          case_id: caseId,
          correspond_fun_id: testCase.correspond_fun_id,
          location: `${caseId}.test_purpose`,
          placeholders: purposePlaceholders,
        })
      }

      // Use SOURCE steps (source_step_desc/expected_result for unified records).
      // The rendered step_desc has ${placeholder} sanitized to {placeholder},
      // so checking it would silently miss unresolved placeholders that per the
      // main flow definition only survive in source_step_desc.
      const steps = extractSourceSteps(testCase.test_step)
      if (steps.length === 0) {
        fieldIssues.push({
          case_id: caseId,
          field: "test_step",
          message: "test_step 为空或不是合法步骤数组。",
        })
        continue
      }

      const requirementCases = casesByRequirement.get(requirement.requirement_id) ?? []
      const rawSteps = rawCases[caseIndex]?.test_step
      requirementCases.push({
        case_id: caseId,
        case_name: testCase.case_name,
        test_purpose: testCase.test_purpose,
        test_type: testCase.test_type,
        test_environment: testCase.test_environment,
        // Review source semantics while also retaining rendered timing and raw
        // temporal anchors that the persisted schema may otherwise strip.
        test_step: steps.map((step, index) => ({
          ...(Array.isArray(rawSteps) && rawSteps[index] && typeof rawSteps[index] === "object" ? rawSteps[index] : {}),
          ...testCase.test_step[index],
          ...step,
        })),
      })
      casesByRequirement.set(requirement.requirement_id, requirementCases)

      for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const stepPlaceholders = uniq([
          ...collectUnresolvedPlaceholders(steps[stepIndex].步骤描述),
          ...collectUnresolvedPlaceholders(steps[stepIndex].预期结果),
        ])
        if (stepPlaceholders.length > 0) {
          unresolvedPlaceholders.push({
            case_id: caseId,
            correspond_fun_id: testCase.correspond_fun_id,
            location: `${caseId}.test_step[${stepIndex}]`,
            placeholders: stepPlaceholders,
          })
        }
      }

      const requirementContext = buildRequirementContext(requirement, testCase.test_type)
      const manualRequirement = isManualTestRequirement({
        name: requirement.name, requirementId: requirement.requirement_id, testType: resolveRequirementTestTypeChinese(requirement) ?? undefined,
      })
      // Manual measurements still require meaningful source steps/results, but
      // referenced bus outputs are not additional automated measurement steps.
      const validationErrors = validatePersistedPhase6Steps(steps,
        manualTestEnvironment(resolveRequirementTestTypeChinese(requirement) ?? undefined) ? undefined : requirementContext)
      const functionalModel = resolveFunctionalModel({
        name: requirement?.name, requirementId: requirement?.requirement_id, testType: testCase.test_type,
      })
      validationErrors.push(...validateFunctionalModelSteps(functionalModel, steps, [requirement.handling, requirement.inputFlow, requirement.outputFlow, requirement.requirementContext].filter(Boolean).join("\n")))
      for (const [index, step] of testCase.test_step.entries()) {
        if (step.is_startup_step || step.translation_exempt_reason) continue
        if (!step.key_name && !explicitStepAction(step.source_step_desc)) continue
        validationErrors.push(...translatedStepSemanticIssues(step.source_step_desc, step)
          .map((issue) => `步骤${index + 1}：${issue}`))
      }
      if (manualRequirement) {
        if (testCase.translate_status !== "not_applicable"
          || testCase.test_step.some((step) => step.key_name || step.parameter.length || step.expected_parameter.length
            || step.step_desc !== step.source_step_desc || step.translation_exempt_reason !== "manual_requirement")) {
          validationErrors.push("引导加载/初始化、性能测试和余量测试的人工用例不得执行关键字翻译；应保留原步骤，清空关键字及参数并标记 not_applicable。")
        }
      } else if (testCase.translate_status === "not_applicable" || testCase.test_step.some((step) => step.translation_exempt_reason)) {
        validationErrors.push("非人工需求不能使用 not_applicable 或人工豁免标记跳过翻译。")
      }
      if (validationErrors.length > 0) {
        semanticValidationFailures.push({
          case_id: caseId,
          correspond_fun_id: testCase.correspond_fun_id,
          errors: validationErrors,
        })
      }
    }

    // 双总线完整性是 requirement/suite 级规则：同一指令的 CANA 与 CANB
    // 应当分成两个用例，再在整组用例中核对是否成对。禁止回退到
    // “每个单用例都必须同时出现 CANA/CANB”的互斥校验。
    for (const [requirementId, requirementCases] of casesByRequirement) {
      const requirement = requirementMap.get(requirementId)
      if (!requirement || requirementCases.length === 0) continue
      const context = buildRequirementContext(requirement, requirementCases[0]!.test_type)
      const protocolContext = findCrossRequirementContext(requirement, preparedRequirements)
      const contextGaps = getStressProtocolContextGaps(requirement, protocolContext)
      if (contextGaps.length) semanticValidationFailures.push({
        case_id: requirementCases[0]!.case_id,
        correspond_fun_id: requirementId,
        errors: contextGaps.map((gap) => `CONTEXT_REQUIRED：${gap}`),
      })
      const policyIssues = validateTestTypeCases(resolveRequirementTestTypeChinese(requirement) ?? undefined, requirementCases,
        [requirement.handling, requirement.inputFlow, requirement.outputFlow, requirement.requirementContext, protocolContext ? JSON.stringify(protocolContext) : ""].filter(Boolean).join("\n"))
      if (policyIssues.length) semanticValidationFailures.push({
        case_id: requirementCases[0]!.case_id,
        correspond_fun_id: requirementId,
        errors: policyIssues.map((issue) => `用例${issue.case_index + 1}${issue.step_index !== undefined ? `步骤${issue.step_index + 1}` : ""}：${issue.message}`),
      })
      const requiredBuses = requiredPrimaryBusesFromRequirementContext(context)
      const busViolations = analyzeRequiredPrimaryBusCoverage(requirementCases, requiredBuses)
      if (busViolations.length > 0) {
        semanticValidationFailures.push({
          case_id: requirementCases[0]!.case_id,
          correspond_fun_id: requirementId,
          errors: busViolations.map((violation) => violation.message),
        })
      }
    }

    const uncoveredRequirementIds = preparedRequirements
      .map((requirement) => requirement.requirement_id)
      .filter((requirementId) => !coveredRequirementIds.has(requirementId))

    const summary: Phase6PreparedSummary = {
      total_requirements: preparedRequirements.length,
      total_cases: suite.test_cases.length,
      covered_requirements: coveredRequirementIds.size,
      uncovered_requirements: uncoveredRequirementIds.length,
      broken_requirement_links: brokenLinks.length,
      path_mismatches: pathMismatches.length,
      related_requirement_mismatches: relatedRequirementMismatches.length,
      empty_mandatory_fields: fieldIssues.length,
      unclear_test_purposes: unclearPurposeCaseIds.length,
      unresolved_placeholders: unresolvedPlaceholders.length,
      semantic_validation_failures: semanticValidationFailures.length,
    }

    const candidateIssues = [...templateResolutionIssues, ...templateProvenanceIssues, ...buildCandidateIssues({
      uncoveredRequirementIds,
      brokenLinkCaseIds: brokenLinks.map((item) => item.case_id),
      brokenLinkLocations: brokenLinks.map((item) => `${item.case_id}.${item.field}`),
      pathMismatchCaseIds: pathMismatches.map((item) => item.case_id),
      relatedMismatchCaseIds: relatedRequirementMismatches.map((item) => item.case_id),
      typeMismatchCases: typeMismatches,
      unresolvedPlaceholders,
      fieldIssues,
      semanticFailures: semanticValidationFailures,
      unclearPurposeCaseIds,
      toolErrors: [],
      templateWarnings,
    })]
    const preparedWarnings = stableSorted([
      ...templateWarnings,
      ...(unresolvedPlaceholders.length > 0
        ? [`${unresolvedPlaceholders.length} 处文本包含未解析参数占位符，已按 Phase 6 容错策略作为非阻断提示保留。`]
        : []),
    ])

    const preparedPayload = writePrepared({
      status: "success",
      generated_at: generatedAt,
      confirmation_tests_file: confirmationTestsPath,
      test_requirements_file: testRequirementsPath,
      project_type: projectType,
      summary,
      coverage: {
        covered_requirement_ids: stableSorted([...coveredRequirementIds]),
        uncovered_requirement_ids: stableSorted(uncoveredRequirementIds),
      },
      template_baselines: [...baselineByTestType.values()],
      broken_links: brokenLinks,
      path_mismatches: pathMismatches,
      related_requirement_mismatches: relatedRequirementMismatches,
      unresolved_placeholders: unresolvedPlaceholders,
      field_issues: fieldIssues,
      semantic_validation_failures: semanticValidationFailures,
      candidate_issues: candidateIssues,
      warnings: preparedWarnings,
      errors: [],
    })

    return JSON.stringify({
      status: preparedPayload.status,
      prepared_file: preparedFilePath,
      summary: preparedPayload.summary,
      counts: {
        uncovered_requirements: uncoveredRequirementIds.length,
        broken_links: brokenLinks.length,
        path_mismatches: pathMismatches.length,
        related_requirement_mismatches: relatedRequirementMismatches.length,
        test_type_mismatches: typeMismatches.length,
        unresolved_placeholders: unresolvedPlaceholders.length,
        field_issues: fieldIssues.length,
        semantic_validation_failures: semanticValidationFailures.length,
        template_provenance_failures: templateProvenanceIssues.length,
        template_resolution_failures: templateResolutionIssues.length,
      },
      sample_ids: {
        uncovered_requirements: takeSample(uncoveredRequirementIds),
        broken_link_cases: takeSample(brokenLinks.map((item) => item.case_id)),
        type_mismatch_cases: takeSample(typeMismatches.map((item) => item.case_id)),
        placeholder_cases: takeSample(unresolvedPlaceholders.map((item) => item.case_id)),
        semantic_failure_cases: takeSample(semanticValidationFailures.map((item) => item.case_id)),
      },
      template_baselines: preparedPayload.template_baselines.map((baseline) => ({
        test_type: baseline.test_type,
        template_key: baseline.template_key,
        template_source: baseline.template_source,
      })),
      candidate_issues: preparedPayload.candidate_issues,
    })
  },
})
