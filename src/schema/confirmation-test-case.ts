import { z } from "zod"
import { ReportMeta } from "./report-meta"

/**
 * A single logical test step record.
 */
export const TestStepRecord = z
  .object({
    步骤描述: z.string().optional(),
    预期结果: z.string().optional(),
    step_desc: z.string().optional(),
    step_description: z.string().optional(),
    expected_result: z.string().optional(),
  })
  .passthrough()
  .transform((value, ctx) => {
    const stepDescription = value.步骤描述 ?? value.step_desc ?? value.step_description
    const expectedResult = value.预期结果 ?? value.expected_result

    if (!stepDescription) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "test_step 缺少步骤描述/step_desc",
      })
    }
    if (!expectedResult) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "test_step 缺少预期结果/expected_result",
      })
    }

    return {
      步骤描述: stepDescription ?? "",
      预期结果: expectedResult ?? "",
      // Preserve semantic anchor fields through Zod normalization
      // so that keyword matching and DOCX generation can use them.
      ...(value.operation_type ? { operation_type: value.operation_type } : {}),
      ...(value.channel !== undefined && value.channel !== null ? { channel: value.channel } : {}),
      ...(value.temporal ? { temporal: value.temporal } : {}),
      ...(Array.isArray(value.data_checks) ? { data_checks: value.data_checks } : {}),
    }
  })
export type TestStepRecord = z.infer<typeof TestStepRecord>

/**
 * Extended step record that preserves optional semantic anchor fields
 * emitted by the LLM worker when anchor-aware generation is active.
 * These fields guide keyword matching but are strictly optional —
 * missing anchors fall back to traditional global keyword scoring.
 */
export interface TestStepWithAnchors {
  步骤描述: string
  预期结果: string
  /** Operation type anchor, e.g. "send_command", "set_memory", "verify_telemetry" */
  operation_type?: string
  /** Bus channel anchor, e.g. "CANA", "CANB" */
  channel?: string
  /** Temporal anchor, e.g. "第3.0秒" */
  temporal?: string
  /** Data check anchors — explicit assertions in expected result */
  data_checks?: string[]
}

export const ParsedTestStepList = z
  .array(TestStepRecord)
  .nonempty("test_step JSON 数组不能为空")

/**
 * Historical files may store test_step as a JSON string.
 * New files persist test_step directly as an array.
 */
const LegacyTestStepJsonString = z
  .string()
  .superRefine((value, ctx) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'test_step 必须是 JSON 数组或合法 JSON 数组字符串，形如 [{"步骤描述":"...","预期结果":"..."}]',
      })
      return
    }

    const result = ParsedTestStepList.safeParse(parsed)
    if (!result.success) {
      for (const issue of result.error.issues) {
        const issuePath = issue.path.length > 0 ? ` (${issue.path.join(".")})` : ""
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `test_step JSON 结构无效${issuePath}: ${issue.message}`,
        })
      }
    }
  })
  .transform((value) => JSON.parse(value) as TestStepRecord[])

export const TestStepArray = z.union([ParsedTestStepList, LegacyTestStepJsonString])

/**
 * Normalize test_step into the standard format.
 *
 * With `includeAnchors: false` (default, backward-compatible):
 *   Returns Array<{ 步骤描述: string; 预期结果: string }>
 *
 * With `includeAnchors: true`:
 *   Returns Array<TestStepWithAnchors> preserving optional anchor fields.
 */
export function normalizeTestStepRecords(
  value: unknown,
  includeAnchors?: false,
): Array<{ 步骤描述: string; 预期结果: string }>
export function normalizeTestStepRecords(
  value: unknown,
  includeAnchors: true,
): TestStepWithAnchors[]
export function normalizeTestStepRecords(
  value: unknown,
  includeAnchors = false,
): Array<{ 步骤描述: string; 预期结果: string }> | TestStepWithAnchors[] {
  const result = TestStepArray.safeParse(value)
  if (!result.success) return []

  if (includeAnchors) {
    // Re-parse the raw value to preserve anchor fields
    let rawSteps: unknown[] = []
    if (typeof value === "string") {
      try { rawSteps = JSON.parse(value) } catch { return [] }
    } else if (Array.isArray(value)) {
      rawSteps = value
    } else {
      return []
    }

    return rawSteps.map((step: unknown): TestStepWithAnchors => {
      const s = step as Record<string, unknown>
      return {
        步骤描述: String(s.步骤描述 ?? s.step_desc ?? s.step_description ?? ""),
        预期结果: String(s.预期结果 ?? s.expected_result ?? ""),
        ...(s.operation_type ? { operation_type: String(s.operation_type) } : {}),
        ...(s.channel ? { channel: String(s.channel) } : {}),
        ...(s.temporal ? { temporal: String(s.temporal) } : {}),
        ...(Array.isArray(s.data_checks) ? { data_checks: s.data_checks as string[] } : {}),
      }
    })
  }

  return result.data
}

const TranslatedStepParameterValue = z.union([z.string(), z.number(), z.null()])

export const TranslatedStepParameter = z.object({
  Value: TranslatedStepParameterValue,
  Name: z.string().regex(/^\$\{[^}]+\}$/, "Name 必须保持 ${placeholder} 格式"),
  Comments: z.string(),
})
export type TranslatedStepParameter = z.infer<typeof TranslatedStepParameter>

export const TranslatedTestStepRecord = z.object({
  key_name: z.string().min(1, "key_name 不能为空"),
  step_desc: z.string().min(1, "step_desc 不能为空"),
  parameter: z.array(TranslatedStepParameter),
  expected_result: z.string().min(1, "expected_result 不能为空"),
})
export type TranslatedTestStepRecord = z.infer<typeof TranslatedTestStepRecord>

export const TranslatedTestStepArray = z
  .array(TranslatedTestStepRecord)
  .nonempty("translated test_step 数组不能为空")

// ============================================================
// UNIFIED TEST STEP RECORD (source + translated combined)
// ============================================================
// Generated during Phase 6 with inline keyword translation.
// Each step carries both the original natural-language description
// and the keyword-matched executable form, preserving traceability
// between the two representations in a single record.

export const UnifiedStepParameter = z.object({
  Value: z.union([z.string(), z.number(), z.null()]),
  Name: z.string(), // "${placeholder}" or placeholder values like "保留"
  Comments: z.string(),
})
export type UnifiedStepParameter = z.infer<typeof UnifiedStepParameter>

export const UnifiedTestStepRecord = z.object({
  // --- Translated fields (from keyword matching) ---
  key_name: z.string(),                         // matched keyword name, empty for startup steps
  step_desc: z.string(),                         // rendered keyword description with parameters filled
  parameter: z.array(UnifiedStepParameter),     // extracted argument bindings

  // --- Source fields (preserved from original 步骤描述/预期结果) ---
  source_step_desc: z.string(),                  // original natural-language 步骤描述
  expected_result: z.string(),                   // original natural-language 预期结果 (unchanged logic)

  // --- Expected-result keyword mapping (placeholder fields for future extension) ---
  expected_key_name: z.string().default("保留"),
  source_expected_key_name: z.string().default("保留"),
  expected_parameter: z.array(UnifiedStepParameter).default([]),

  // --- Startup step marker (startup steps are skipped from translation,
  //     not counted as failures) ---
  is_startup_step: z.boolean().default(false),
  // Manual requirement steps preserve source text and never carry executable keywords.
  translation_exempt_reason: z.literal("manual_requirement").optional(),
})
export type UnifiedTestStepRecord = z.infer<typeof UnifiedTestStepRecord>

export const UnifiedTestStepArray = z
  .array(UnifiedTestStepRecord)
  .nonempty("unified test_step 数组不能为空")

/** Detect whether steps are already in unified format. */
export function isUnifiedStepArray(steps: unknown): steps is UnifiedTestStepRecord[] {
  if (!Array.isArray(steps) || steps.length === 0) return false
  const first = steps[0]
  return first !== null && typeof first === "object" && "key_name" in first && "source_step_desc" in first
}

/** Convert legacy [{步骤描述, 预期结果}] steps to UnifiedTestStepRecord[] (untranslated). */
export function migrateLegacyStepsToUnified(steps: unknown): UnifiedTestStepRecord[] {
  const sourceSteps = typeof steps === "string"
    ? (() => { try { return normalizeTestStepRecords(steps) } catch { return [] } })()
    : normalizeTestStepRecords(steps)
  return sourceSteps.map((s) => ({
    key_name: "",
    step_desc: s.步骤描述,
    parameter: [],
    source_step_desc: s.步骤描述,
    expected_result: s.预期结果,
    expected_key_name: "保留",
    source_expected_key_name: "保留",
    expected_parameter: [],
    is_startup_step: false,
  }))
}

/** Ensure steps are in unified format, migrating legacy format when needed. */
export function ensureUnifiedSteps(steps: unknown): UnifiedTestStepRecord[] {
  if (isUnifiedStepArray(steps)) return steps
  return migrateLegacyStepsToUnified(steps)
}

/** Extract source-only test_step records (Chinese field names) for DOCX generation etc. */
export function extractSourceStepsFromUnified(
  steps: UnifiedTestStepRecord[],
): Array<{ 步骤描述: string; 预期结果: string }> {
  return steps.map((s) => ({
    步骤描述: s.source_step_desc,
    预期结果: s.expected_result,
  }))
}

/**
 * Extract source-only steps ({步骤描述, 预期结果}) from either unified or
 * legacy step data.
 *
 * For unified steps, the source text is the original natural-language
 * `source_step_desc` / `expected_result` — NOT the rendered `step_desc`
 * (which carries keyword Documentation text with `${}` placeholders
 * sanitized to `{}`). Consumers that need the human-authored text
 * (DOCX/Markdown reports, review checks) must go through this function.
 * Falls back to `normalizeTestStepRecords` for legacy data.
 */
export function extractSourceSteps(
  steps: unknown,
): Array<{ 步骤描述: string; 预期结果: string }> {
  if (Array.isArray(steps) && steps.length > 0 && isUnifiedStepArray(steps)) {
    return steps.map((s) => ({
      步骤描述: s.source_step_desc || s.step_desc,
      预期结果: s.expected_result,
    }))
  }
  return normalizeTestStepRecords(steps)
}

/** Extract translated-only test_step records for confirmation-tests.json derivation */
export function extractTranslatedStepsFromUnified(
  steps: UnifiedTestStepRecord[],
): TranslatedTestStepRecord[] {
  return steps
    .filter((s) => !s.is_startup_step && !s.translation_exempt_reason && s.key_name !== "")
    .map((s) => ({
      key_name: s.key_name,
      step_desc: s.step_desc,
      parameter: s.parameter.map((p) => ({
        Value: p.Value,
        Name: p.Name.startsWith("${") ? p.Name : `\${${p.Name}}`,
        Comments: p.Comments,
      })),
      expected_result: s.expected_result,
    }))
}

/**
 * Confirmation test case — matches the auto-testcase-generator database schema (doc_tr_case).
 *
 * Key fields:
 *   case_name          test case name (≤20 chars)
 *   test_purpose       what the test verifies
 *   correspond_fun_id  TR requirement ID this case is derived from
 *   case_id            test case identifier (e.g. TC-GN-INIT-001)
 *   test_type          Chinese type name (e.g. 功能测试, 接口测试)
 *   test_step          JSON array: [{"步骤描述":"...","预期结果":"..."}]
 *   constraints/initial_settings/test_input/assess_criteria/cease_condition: hardcoded defaults
 *
 * Matrix traceability extension:
 *   related_software_req_ids  software requirement IDs for SRS→CT traceability chain
 */
const ConfirmationTestCaseBase = z.object({
  // --- DB metadata (optional in file, auto-assigned by DB) ---
  id: z.number().int().optional(),
  project_id: z.string().optional(),

  // --- Core test case fields ---
  case_name: z.string().max(50),
  test_environment: z.string().default("无"),
  test_purpose: z.string(),
  correspond_fun_id: z.string(),         // TR requirement IDs in 、-separated format (e.g. "TR-JK-001、TR-JK-002、TR-JK-003")
  case_id: z.string(),                   // Test case ID (e.g. TC-GN-INIT-001)
  test_type: z.string(),                 // Chinese: 功能测试, 接口测试, etc.
  path: z.string().optional(),           // Hierarchy path (e.g. /6/2/1/)

  // --- Preconditions / environment ---
  constraints: z.string().default("无"),
  initial_settings: z.string().default("无"),
  test_input: z.string().default("无"),

  // --- Criteria ---
  assess_criteria: z.string().default("实际结果与预期结果一致"),
  cease_condition: z
    .string()
    .default(
      "Z1：测试用例按照所设计的操作步骤完成，测试正常终止；" +
        "Z2：测试用例不能按照所设计的操作步骤完成，测试异常终止。",
    ),

  // --- Personnel / time metadata ---
  designer: z.string().optional(),
  designer_date: z.string().optional(),  // YYYYMMDD

  // --- Status: 0=draft, 1=reviewed, 2=approved ---
  status: z.number().int().default(0),

  // --- Audit timestamps ---
  create_time: z.string().optional(),
  user_id: z.string().optional(),
  create_by: z.string().optional(),
  update_time: z.string().optional(),
  update_by: z.string().optional(),

  // --- Matrix traceability extension: range-style string listing only this
  //     case's TR-IDs (e.g. "TR-JK-001~003、TR-JK-005"). Legacy array values
  //     are joined on read. ---
  related_software_req_ids: z.preprocess(
    (value) => (Array.isArray(value) ? value.join("、") : value),
    z.string().optional(),
  ),

  // --- "success": automated steps matched; "not_applicable": manual requirement;
  //     "failure": attempted translation failed (legacy "partial" normalizes here). ---
  // Subagent now performs inline translation; this field is REQUIRED in the output.
  translate_status: z.preprocess(
    (value) => (value === "partial" ? "failure" : value),
    z.enum(["success", "failure", "not_applicable"]),
  ),
})

export const SourceConfirmationTestCase = ConfirmationTestCaseBase.extend({
  // --- Steps in unified format (source + translated combined in one record) ---
  test_step: UnifiedTestStepArray,
})
export type SourceConfirmationTestCase = z.infer<typeof SourceConfirmationTestCase>

export const TranslatedConfirmationTestCase = ConfirmationTestCaseBase.extend({
  // Only "success" cases are executable by DTP data and Robot generation.
  translate_status: z.string().min(1).optional(),
  // --- Steps translated into executable keyword records ---
  test_step: TranslatedTestStepArray,
})
export type TranslatedConfirmationTestCase = z.infer<typeof TranslatedConfirmationTestCase>

export const ConfirmationTestCase = TranslatedConfirmationTestCase
export type ConfirmationTestCase = TranslatedConfirmationTestCase

/** Suite-level test environment summary (Section 2 of test specification) */
export const TestEnvironmentSummary = z.object({
  /** Hardware environment description */
  hardware_environment: z.string(),
  /** Software environment description */
  software_environment: z.string(),
  /** Test tools used across the suite */
  test_tools: z.array(z.object({
    name: z.string(),
    purpose: z.string(),
    version: z.string(),
  })).default([]),
})
export type TestEnvironmentSummary = z.infer<typeof TestEnvironmentSummary>

const ConfirmationTestSuiteBase = ReportMeta.merge(z.object({
  /** Suite-level test environment description */
  test_environment_summary: TestEnvironmentSummary.optional(),
  traceability: z.array(
    z.object({
      test_req_id: z.string(),
      case_ids: z.array(z.string()),
      coverage_status: z.enum(["full", "partial", "none"]),
    }),
  ),
  /** Items deemed untestable via dynamic testing (with rationale) */
  untestable_items: z.array(z.object({
    req_id: z.string(),
    reason: z.string(),
    alternative_method: z.string().optional(),
  })).default([]),
  /** Coverage of each test type category */
  type_coverage: z.array(z.object({
    test_type: z.string(),
    total_requirements: z.number(),
    covered_requirements: z.number(),
    coverage_ratio: z.number(),
  })).default([]),
  summary: z.object({
    total_cases: z.number(),
    by_type: z.record(z.string(), z.number()),
  }),
}))

/** Source confirmation test suite — human-readable output of TestDesigner. */
export const SourceConfirmationTestSuite = ConfirmationTestSuiteBase.extend({
  test_cases: z.array(SourceConfirmationTestCase),
})
export type SourceConfirmationTestSuite = z.infer<typeof SourceConfirmationTestSuite>

/** Translated confirmation test suite — executable keyword-oriented output. */
export const TranslatedConfirmationTestSuite = ConfirmationTestSuiteBase.extend({
  test_cases: z.array(TranslatedConfirmationTestCase),
})
export type TranslatedConfirmationTestSuite = z.infer<typeof TranslatedConfirmationTestSuite>

export const ConfirmationTestSuite = TranslatedConfirmationTestSuite
export type ConfirmationTestSuite = TranslatedConfirmationTestSuite
