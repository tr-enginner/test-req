import type { KeywordMeta } from "./testcase-keywords"
import { isManualTestRequirement, manualTestEnvironment, validateTestTypeCases } from "./phase6-test-type-policy"
import {
  applySemanticBindingsToStandardizedCase,
  type KeywordCandidateContext,
  type PlaceholderSuggestion,
  type RequirementSemanticContext,
  serializeKeywordCandidate,
} from "./keyword-argument-binding"
import {
  resolveGeneratedTestEnvironment,
  type TestEnvironmentMode,
} from "./test-environment"
import { scoreKeywordCandidates } from "./testcase-keywords"

const CONSTRAINTS_DEFAULT = "无"
const ASSESS_CRITERIA_DEFAULT = "实际结果与预期结果一致"
const CEASE_CONDITION_DEFAULT =
  "Z1：测试用例按照所设计的操作步骤完成，测试正常终止；" +
  "Z2：测试用例不能按照所设计的操作步骤完成，测试异常终止。"

const FIELD_LABEL_PREFIXES = [
  "测试环境：", "测试环境:", "初始状态：", "初始状态:",
  "初始设置：", "初始设置:", "输入：", "输入:",
  "测试输入：", "测试输入:",
]

export interface ValidationError {
  case_index: number
  step_index?: number
  field: string
  message: string
}

export interface StandardizedCase {
  case_name: string
  test_purpose: string
  test_step: Array<{ 步骤描述: string; 预期结果: string }>
  test_environment: string
  initial_settings: string
  test_input: string
  constraints: string
  assess_criteria: string
  cease_condition: string
  correspond_fun_id?: string
  covered_tr_items?: string[]
}

export interface Phase6StandardizationContext {
  projectDir: string
  testEnvironmentMode: TestEnvironmentMode
  input_dataset_ref?: string
  input_dataset_file?: string
  input_dataset_id?: string
  requirement_id?: string
  test_type_chinese?: string
  chapter_title?: string
  // 上下文字段统一使用 flat 格式的五字段命名（I-05）
  requirementContext?: string
  inputFlowContext?: string
  processingContext?: string
  outputFlowContext?: string
  constraintContext?: string
  /** Relevant protocol definitions supplied from other requirements in this project. */
  protocolContext?: string
  keyword_candidates?: KeywordCandidateContext[]
  keyword_map?: Map<string, KeywordMeta>
  placeholder_suggestions?: PlaceholderSuggestion[]
}

export type Phase6StandardizationResult =
  | {
    valid: true
    cases: StandardizedCase[]
    warnings: string[]
    total_count: number
  }
  | {
    valid: false
    errors: ValidationError[]
    warnings: string[]
    valid_count?: number
    total_count?: number
    hint?: string
  }

function isSingleTestCase(obj: Record<string, unknown>): boolean {
  const keys = ["case_name", "test_case_name", "caseName", "test_purpose", "testPurpose", "test_step", "testStep"]
  return keys.some((key) => key in obj)
}

export function extractJsonFromMarkdown(text: string): string {
  const trimmed = text.trim()

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()

  const arrayStart = trimmed.indexOf("[")
  const arrayEnd = trimmed.lastIndexOf("]")
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return trimmed.slice(arrayStart, arrayEnd + 1)
  }

  const objStart = trimmed.indexOf("{")
  const objEnd = trimmed.lastIndexOf("}")
  if (objStart >= 0 && objEnd > objStart) {
    return trimmed.slice(objStart, objEnd + 1)
  }

  return trimmed
}

export function normalizeGeneratedCaseList(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data as Record<string, unknown>[]

  if (data !== null && typeof data === "object") {
    const obj = data as Record<string, unknown>

    if (isSingleTestCase(obj)) return [obj]
    if (Array.isArray(obj.testcases)) return obj.testcases as Record<string, unknown>[]
    if (Array.isArray(obj.test_cases)) return obj.test_cases as Record<string, unknown>[]

    for (const value of Object.values(obj)) {
      if (Array.isArray(value) && value.length > 0) return value as Record<string, unknown>[]
    }
  }

  return null
}

function ensureChinesePeriod(value: string): string {
  const trimmed = value.trim()
  return trimmed && !trimmed.endsWith("。") ? `${trimmed}。` : trimmed
}

function pickField(obj: Record<string, unknown>, ...aliases: string[]): unknown {
  for (const alias of aliases) {
    if (alias in obj && obj[alias] !== null && obj[alias] !== undefined && obj[alias] !== "") {
      return obj[alias]
    }
  }
  return undefined
}

function stripFieldLabelPrefix(value: string): string {
  const trimmed = value.trim()
  for (const prefix of FIELD_LABEL_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim()
    }
  }
  return trimmed
}

function buildKeywordLookupText(
  caseRecord: StandardizedCase,
  bindingContext?: {
    requirement_id?: string
    test_type_chinese?: string
    chapter_title?: string
    requirementContext?: string
    inputFlowContext?: string
    processingContext?: string
    outputFlowContext?: string
    constraintContext?: string
  },
): string {
  return [
    bindingContext?.requirement_id ?? "",
    bindingContext?.test_type_chinese ?? "",
    bindingContext?.chapter_title ?? "",
    bindingContext?.requirementContext ?? "",
    bindingContext?.inputFlowContext ?? "",
    bindingContext?.processingContext ?? "",
    bindingContext?.outputFlowContext ?? "",
    bindingContext?.constraintContext ?? "",
    caseRecord.case_name,
    caseRecord.test_purpose,
    ...caseRecord.test_step.map((step) => `${step.步骤描述} ${step.预期结果}`),
  ]
    .filter(Boolean)
    .join("\n")
}

function mergeKeywordCandidateLists(
  primary: KeywordCandidateContext[],
  secondary: KeywordCandidateContext[],
): KeywordCandidateContext[] {
  const merged = new Map<string, KeywordCandidateContext>()
  for (const candidate of [...primary, ...secondary]) {
    if (!candidate.keywordName) continue
    if (!merged.has(candidate.keywordName)) merged.set(candidate.keywordName, candidate)
  }
  return [...merged.values()]
}

function resolveNormalizationKeywordCandidates(
  caseRecord: StandardizedCase,
  bindingContext?: {
    requirement_id?: string
    test_type_chinese?: string
    chapter_title?: string
    requirementContext?: string
    inputFlowContext?: string
    processingContext?: string
    outputFlowContext?: string
    constraintContext?: string
    keyword_candidates?: KeywordCandidateContext[]
    keyword_map?: Map<string, KeywordMeta>
  },
): KeywordCandidateContext[] {
  const hintedCandidates = bindingContext?.keyword_candidates ?? []
  const keywordMap = bindingContext?.keyword_map
  if (!keywordMap || keywordMap.size === 0) return hintedCandidates

  const lookupText = buildKeywordLookupText(caseRecord, bindingContext)
  const rescannedCandidates = scoreKeywordCandidates(lookupText, keywordMap, 12)
    .map(serializeKeywordCandidate)

  return mergeKeywordCandidateLists(rescannedCandidates, hintedCandidates)
}

function resolveSteps(
  rawSteps: unknown,
  index: number,
  errors: ValidationError[],
): Array<{ 步骤描述: string; 预期结果: string }> | null {
  let stepsData: unknown = rawSteps

  if (typeof stepsData === "string") {
    const trimmed = stepsData.trim()
    if (!trimmed) {
      errors.push({ case_index: index, field: "test_step", message: "test_step 字符串为空" })
      return null
    }
    try {
      stepsData = JSON.parse(trimmed)
    } catch {
      errors.push({
        case_index: index,
        field: "test_step",
        message: "test_step 是字符串，但不是合法 JSON；期望得到 JSON 数组字符串",
      })
      return null
    }
  }

  if (!Array.isArray(stepsData)) {
    errors.push({
      case_index: index,
      field: "test_step",
      message: `test_step 必须是数组或 JSON 数组字符串，当前得到的是 ${typeof stepsData}`,
    })
    return null
  }

  if ((stepsData as unknown[]).length === 0) {
    errors.push({ case_index: index, field: "test_step", message: "test_step 数组不能为空" })
    return null
  }

  return stepsData as Array<{ 步骤描述: string; 预期结果: string }>
}

function validateAndStandardize(
  item: Record<string, unknown>,
  index: number,
  warnings: string[],
  bindingContext: Phase6StandardizationContext,
): { errors: ValidationError[]; case?: StandardizedCase } {
  const errors: ValidationError[] = []

  let rawName = pickField(item, "case_name", "test_case_name", "testCaseName", "caseName", "name")
  if (!rawName) {
    errors.push({ case_index: index, field: "case_name", message: "必须提供 case_name（或 test_case_name）" })
    rawName = "未命名测试用例"
  }
  let name = String(rawName).trim()
  if (name.length > 50) {
    warnings.push(`case[${index}].case_name "${name}" 长度为 ${name.length}（>50），已截断为 50 个字符`)
    name = name.slice(0, 50)
  }

  const rawPurpose = pickField(item, "test_purpose", "testPurpose", "purpose", "objective")
  if (!rawPurpose) {
    errors.push({ case_index: index, field: "test_purpose", message: "必须提供 test_purpose" })
  }
  const purpose = ensureChinesePeriod(rawPurpose ? String(rawPurpose) : "")

  const rawSteps = pickField(item, "test_step", "testStep", "testSteps", "steps", "test_steps")
  if (rawSteps === undefined || rawSteps === null) {
    errors.push({ case_index: index, field: "test_step", message: "必须提供 test_step（数组或 JSON 字符串）" })
  }

  if (errors.length > 0) return { errors }

  const stepArr = resolveSteps(rawSteps, index, errors)
  if (errors.length > 0) return { errors }

  const steps: Array<{ 步骤描述: string; 预期结果: string;[key: string]: unknown }> = []
  for (let stepIndex = 0; stepIndex < stepArr!.length; stepIndex += 1) {
    const step = stepArr![stepIndex]
    if (typeof step !== "object" || step === null) {
      errors.push({
        case_index: index,
        step_index: stepIndex,
        field: "test_step",
        message: `step[${stepIndex}] 必须是对象，当前得到的是 ${typeof step}`,
      })
      continue
    }
    const stepObj = step as Record<string, unknown>

    // Main flow step formats are first-class here: the Unified record uses
    // source_step_desc (original natural language) + step_desc (rendered keyword
    // form), and the schema accepts 步骤描述/step_desc/step_description alike.
    // source_step_desc is preferred over step_desc when both exist (Unified
    // re-validation), because re-translation should start from the original text.
    const action = pickField(stepObj, "步骤描述", "source_step_desc", "step_desc", "step_description", "action", "description", "step")
    const expected = pickField(stepObj, "预期结果", "expected_result", "expectedResult", "expected", "result")

    if (!action) {
      errors.push({
        case_index: index,
        step_index: stepIndex,
        field: "步骤描述",
        message: `step[${stepIndex}] 必须提供 步骤描述（也接受 step_desc、source_step_desc、action、description）`,
      })
    }
    if (!expected) {
      errors.push({
        case_index: index,
        step_index: stepIndex,
        field: "预期结果",
        message: `step[${stepIndex}] 必须提供 预期结果（也接受 expected_result、expected）`,
      })
    }

    if (action && expected) {
      // Preserve semantic anchor fields from the original step
      // so that keyword translation can use them for accurate matching.
      steps.push({
        步骤描述: ensureChinesePeriod(String(action)),
        预期结果: ensureChinesePeriod(String(expected)),
        ...(stepObj.operation_type ? { operation_type: stepObj.operation_type } : {}),
        ...(stepObj.channel !== undefined && stepObj.channel !== null ? { channel: stepObj.channel } : {}),
        ...(stepObj.temporal ? { temporal: stepObj.temporal } : {}),
        ...(Array.isArray(stepObj.data_checks) ? { data_checks: stepObj.data_checks } : {}),
      })
    }
  }

  if (errors.length > 0) return { errors }

  // 硬件狗接口(2026-09-08 用户拍板):看门狗用例靠示波器实测清狗间隔,测试
  // 环境固定为硬平台——不随 testEnvironmentMode 走(软平台模拟不了示波器)
  const isWatchdogRequirement = /硬件狗|看门狗|喂狗/.test(
    [
      bindingContext.requirementContext,
      bindingContext.inputFlowContext,
      bindingContext.processingContext,
    ].filter(Boolean).join(" "),
  )
  const resolvedTestEnvironment = manualTestEnvironment(bindingContext.test_type_chinese) ?? resolveGeneratedTestEnvironment(
    isWatchdogRequirement ? "evaluation" : bindingContext.testEnvironmentMode,
  )
  const rawTestEnv = pickField(item, "test_environment", "testEnvironment")
  if (rawTestEnv !== undefined && rawTestEnv !== null && String(rawTestEnv).trim() !== "") {
    warnings.push(
      `case[${index}].test_environment "${String(rawTestEnv).trim()}" 已被系统值覆盖为 ` +
      `"${resolvedTestEnvironment}"`,
    )
  }
  const initSettings = stripFieldLabelPrefix(String(pickField(item, "initial_settings", "initialSettings") ?? "无")) || "无"
  const testInput = stripFieldLabelPrefix(String(pickField(item, "test_input", "testInput") ?? "无")) || "无"
  // Preserve correspond_fun_id and covered_tr_items from LLM output
  const correspondFunId = pickField(item, "correspond_fun_id", "correspondFunId")
  const coveredTrItems = item.covered_tr_items ?? item.coveredTrItems

  let standardized: StandardizedCase = {
    case_name: name,
    test_purpose: purpose,
    test_step: steps,
    test_environment: resolvedTestEnvironment,
    initial_settings: initSettings,
    test_input: testInput,
    constraints: CONSTRAINTS_DEFAULT,
    assess_criteria: ASSESS_CRITERIA_DEFAULT,
    cease_condition: CEASE_CONDITION_DEFAULT,
    ...(correspondFunId ? { correspond_fun_id: String(correspondFunId) } : {}),
    ...(Array.isArray(coveredTrItems) ? { covered_tr_items: coveredTrItems as string[] } : {}),
  }

  // Validate source operations before binding can rephrase or drop source text.
  const sourceIssues = validateTestTypeCases(bindingContext.test_type_chinese, [{
    ...standardized,
    // Preserve raw timing evidence for validation only; field folding must not
    // hide a zero-time rendered description behind a nonzero source step.
    test_step: steps.map((step, stepIndex) => ({ ...(stepArr![stepIndex] as Record<string, unknown>), ...step })),
  }],
    [bindingContext.requirementContext, bindingContext.inputFlowContext, bindingContext.processingContext, bindingContext.outputFlowContext, bindingContext.protocolContext].filter(Boolean).join("\n"))
  if (sourceIssues.length) return { errors: sourceIssues.map((issue) => ({ ...issue, case_index: index })) }

  const manualRequirement = isManualTestRequirement({
    name: bindingContext?.chapter_title,
    requirementId: bindingContext?.requirement_id,
    testType: bindingContext?.test_type_chinese,
  })
  const keywordCandidates = manualRequirement ? [] : resolveNormalizationKeywordCandidates(standardized, bindingContext)
  const hasBindingContext = keywordCandidates.length > 0
  if (hasBindingContext) {
    try {
      // 问题3：占位符解析所需的全部上下文已包含在 test-requirements.json 中，
      // 不再读取/依赖第三方测试需求 docx 的协议语义文件。
      const requirementContext: RequirementSemanticContext = {
        requirementId: bindingContext.requirement_id,
        requirementHandling: bindingContext.processingContext,
        chapterBackground: [bindingContext.requirementContext, bindingContext.protocolContext].filter(Boolean).join("\n"),
        chapterTitle: bindingContext.chapter_title,
        inputFlow: bindingContext.inputFlowContext,
        outputFlow: bindingContext.outputFlowContext,
        testTypeChinese: bindingContext.test_type_chinese,
      }
      const bound = applySemanticBindingsToStandardizedCase(
        standardized,
        {
          keywordCandidates,
          datasetRef: bindingContext.input_dataset_ref ?? standardized.test_input,
          requirementContext,
          placeholderSuggestions: bindingContext.placeholder_suggestions,
          caseIndex: index,
        },
      )
      warnings.push(...bound.warnings.map((warning) => `case[${index}] ${warning}`))
      if (bound.errors.length > 0) {
        return {
          errors: bound.errors.map((message) => ({
            case_index: index,
            field: "test_step",
            message,
          })),
        }
      }
      standardized = {
        ...standardized,
        test_step: bound.test_step,
        test_input: bound.test_input,
      }
    } catch (error) {
      warnings.push(`case[${index}] 协议语义绑定失败：${String(error)}`)
    }
  } else if (bindingContext.input_dataset_ref && standardized.test_input === "无") {
    standardized = {
      ...standardized,
      test_input: bindingContext.input_dataset_ref,
    }
  }

  return {
    errors: [],
    case: standardized,
  }
}

export function standardizeGeneratedTestcases(
  generatedText: string,
  bindingContext: Phase6StandardizationContext,
): Phase6StandardizationResult {
  const warnings: string[] = []
  const jsonStr = extractJsonFromMarkdown(generatedText)

  let data: unknown
  try {
    data = JSON.parse(jsonStr)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      valid: false,
      errors: [
        {
          case_index: -1,
          field: "json",
          message: `JSON 语法错误：${message}。请确保响应是一个合法的 JSON 数组，并且可被 \`\`\`json ... \`\`\` 标记正确包裹。`,
        },
      ],
      warnings,
      hint: "常见修复方式：删除尾随逗号，确保所有字符串使用双引号，并正确转义特殊字符。",
    }
  }

  const list = normalizeGeneratedCaseList(data)
  if (!list || list.length === 0) {
    return {
      valid: false,
      errors: [
        {
          case_index: -1,
          field: "root",
          message:
            "期望得到非空的测试用例对象 JSON 数组。 " +
            `实际得到：${Array.isArray(data) ? "空数组" : typeof data}。`,
        },
      ],
      warnings,
    }
  }

  const allErrors: ValidationError[] = []
  const cases: StandardizedCase[] = []

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (typeof item !== "object" || item === null) {
      allErrors.push({
        case_index: index,
        field: "item",
        message: `索引 ${index} 处的 item 必须是对象，当前得到的是 ${typeof item}`,
      })
      continue
    }

    const result = validateAndStandardize(
      item as Record<string, unknown>,
      index,
      warnings,
      bindingContext,
    )

    if (result.errors.length > 0) {
      allErrors.push(...result.errors)
    } else if (result.case) {
      cases.push(result.case)
    }
  }

  if (allErrors.length === 0) allErrors.push(...validateTestTypeCases(bindingContext.test_type_chinese, cases,
    [bindingContext.requirementContext, bindingContext.inputFlowContext, bindingContext.processingContext, bindingContext.outputFlowContext, bindingContext.protocolContext].filter(Boolean).join("\n")))

  if (allErrors.length > 0) {
    return {
      valid: false,
      errors: allErrors,
      warnings,
      valid_count: cases.length,
      total_count: list.length,
      hint: "请修复这些报错后重新生成。每条错误都包含 case_index 和 field，便于精确定位问题。",
    }
  }

  return {
    valid: true,
    cases,
    warnings,
    total_count: cases.length,
  }
}
