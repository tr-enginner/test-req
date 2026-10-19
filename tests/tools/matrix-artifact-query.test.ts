import { describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { matrixArtifactQuery } from "../../src/tools/matrix-artifact-query"

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function makeCtx(directory: string) {
  return {
    sessionID: "sid-1",
    messageID: "mid-1",
    agent: "test-designer",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

async function query(directory: string, args: Record<string, unknown>) {
  const raw = await (matrixArtifactQuery as any).execute(args, makeCtx(directory))
  return JSON.parse(raw)
}

function writeTestRequirements(root: string) {
  writeJson(join(root, ".matrix", "data", "test-requirements.json"), {
    funItem: [
      {
        funId: ["TR-GN-A-001"],
        test_type: "功能测试",
        titleNo: "4.1",
        title: "A 功能",
        requirementContext: "功能测试",
        inputFlowContext: "输入 A。",
        processingContext: "验证 A 功能。",
        outputFlowContext: "输出 A。",
      },
      {
        funId: ["TR-GN-B-002"],
        test_type: "功能测试",
        titleNo: "4.1",
        title: "B 功能",
        requirementContext: "功能测试",
        inputFlowContext: "输入 B。",
        processingContext: "验证 B 功能。",
        outputFlowContext: "输出 B。",
      },
    ],
    softwareId: "SW-001",
    codeVersion: "V1.0",
  })
}

function baseSuite(testCases: unknown[]) {
  return {
    project_name: "Demo",
    version: "V1.0",
    created_date: "20260506",
    traceability: [
      {
        test_req_id: "TR-GN-A-001",
        case_ids: ["TC-GN-A-001"],
        coverage_status: "full",
      },
    ],
    summary: {
      total_cases: testCases.length,
      by_type: { 功能测试: testCases.length },
    },
    test_cases: testCases,
  }
}

function writeSuites(root: string) {
  writeJson(join(root, ".matrix", "data", "source-confirmation-tests.json"), baseSuite([
    {
      case_name: "A 功能用例",
      test_purpose: "验证 A 功能。",
      correspond_fun_id: "TR-GN-A-001",
      case_id: "TC-GN-A-001",
      test_type: "功能测试",
      test_step: [
        { 步骤描述: "执行 A。", 预期结果: "A 正确。" },
      ],
      related_software_req_ids: ["SRS-A"],
    },
    {
      case_name: "B 功能用例",
      test_purpose: "验证 B 功能。",
      correspond_fun_id: "TR-GN-B-002",
      case_id: "TC-GN-B-002",
      test_type: "功能测试",
      test_step: [
        { 步骤描述: "执行 B。", 预期结果: "B 正确。" },
      ],
      related_software_req_ids: ["SRS-B"],
    },
  ]))

  writeJson(join(root, ".matrix", "data", "confirmation-tests.json"), baseSuite([
    {
      case_name: "A 功能用例",
      test_purpose: "验证 A 功能。",
      correspond_fun_id: "TR-GN-A-001",
      case_id: "TC-GN-A-001",
      test_type: "功能测试",
      test_step: [
        {
          key_name: "执行A操作",
          step_desc: "执行 A。",
          parameter: [],
          expected_result: "A 正确。",
        },
      ],
      related_software_req_ids: ["SRS-A"],
    },
  ]))
}

function writeGenerationManifest(root: string) {
  writeJson(join(root, ".matrix", "data", "phase6-generation-items.json"), {
    status: "success",
    template_provenance_version: 1,
    domain: "generic",
    template_source: "testcase-prompts/index.json",
    template_usage: [{ template_file: "/templates/test-functional.md", requirement_count: 2 }],
    input_format: "test_requirements_file",
    test_requirements_file: ".matrix/data/test-requirements.json",
    suite_meta: { project_name: "Demo", version: "V1.0" },
    artifact_meta: { software_id: "SW-001" },
    project_type: "software",
    total: 2,
    warnings: ["提示 A"],
    items: [
      {
        requirement_id: "TR-GN-A-001",
        category_key: "GN-A",
        test_type_chinese: "功能测试",
        template_file: "/templates/test-functional.md",
        template_hash: "a".repeat(64),
        template_source: "markdown",
        template_index_file: "/templates/index.json",
        template_domain: "generic",
        template_selection_reason: "software test family",
        source_requirement_ids: ["SRS-A"],
        path: "/4/1/1/",
        prompt: "SECRET_PROMPT_SHOULD_BE_HIDDEN",
        worker_prompt_file: ".matrix/data/phase6-worker-prompts/TR-GN-A-001.txt",
        normalization_context_json: JSON.stringify({ requirement_id: "TR-GN-A-001", secret: "SECRET_CONTEXT" }),
      },
      {
        requirement_id: "TR-GN-B-002",
        category_key: "GN-B",
        test_type_chinese: "功能测试",
        source_requirement_ids: ["SRS-B"],
        path: "/4/1/2/",
        prompt: "需求 B prompt",
        worker_prompt_file: ".matrix/data/phase6-worker-prompts/TR-GN-B-002.txt",
      },
    ],
  })
}

function writeWorkerRun(root: string) {
  const runDir = join(root, ".matrix", "data", "phase6-worker-runs", "run-001")
  mkdirSync(runDir, { recursive: true })
  const status = {
    run_id: "run-001",
    started_at: "2026-05-06T00:00:00.000Z",
    updated_at: "2026-05-06T00:00:02.000Z",
    run_dir: runDir,
    status_file: join(runDir, "status.json"),
    events_file: join(runDir, "events.jsonl"),
    latest_run_file: join(root, ".matrix", "data", "phase6-worker-runs", "latest-run.json"),
    result_summary_file: join(runDir, "result-summary.json"),
    concurrency_limit: 5,
    peak_in_flight: 2,
    total: 2,
    pending: 0,
    running: 0,
    succeeded: 1,
    failed: 1,
    launched_total: 2,
    running_requirement_ids: [],
    completed_requirement_ids: ["TR-GN-A-001", "TR-GN-B-002"],
    failed_requirement_ids: ["TR-GN-B-002"],
  }
  writeJson(join(runDir, "status.json"), status)
  writeJson(join(root, ".matrix", "data", "phase6-worker-runs", "latest-run.json"), status)
  writeJson(join(runDir, "result-summary.json"), {
    status: "partial_success",
    run_id: "run-001",
    run_dir: runDir,
    status_file: join(runDir, "status.json"),
    events_file: join(runDir, "events.jsonl"),
    latest_run_file: join(root, ".matrix", "data", "phase6-worker-runs", "latest-run.json"),
    result_summary_file: join(runDir, "result-summary.json"),
    generation_manifest_file: ".matrix/data/phase6-generation-items.json",
    suite_file: ".matrix/data/source-confirmation-tests.json",
    source_suite_file: ".matrix/data/source-confirmation-tests.json",
    translated_suite_file: ".matrix/data/confirmation-tests.json",
    translation_status: "success",
    concurrency_limit: 5,
    peak_in_flight: 2,
    launched_total: 2,
    total: 2,
    succeeded: 1,
    failed: 1,
    persisted_case_count: 1,
    persisted_requirement_count: 1,
    failed_requirements: [
      {
        requirement_id: "TR-GN-B-002",
        attempts: 3,
        diagnostic_file: join(runDir, "TR-GN-B-002.json"),
      },
    ],
    requirements: [
      {
        source_index: 0,
        requirement_id: "TR-GN-A-001",
        status: "success",
        attempts: 1,
        case_count: 1,
        diagnostic_file: join(runDir, "TR-GN-A-001.json"),
      },
      {
        source_index: 1,
        requirement_id: "TR-GN-B-002",
        status: "error",
        attempts: 3,
        errors: ["缺少预期结果"],
        diagnostic_file: join(runDir, "TR-GN-B-002.json"),
      },
    ],
  })
  appendFileSync(join(runDir, "events.jsonl"), JSON.stringify({ event: "run_started", run_id: "run-001" }) + "\n")
  appendFileSync(join(runDir, "events.jsonl"), JSON.stringify({ event: "requirement_failed", run_id: "run-001", requirement_id: "TR-GN-B-002" }) + "\n")
  writeJson(join(runDir, "TR-GN-B-002.json"), {
    requirement_id: "TR-GN-B-002",
    status: "error",
    attempts: 3,
    validation_errors: ["case[0].test_step: 缺少预期结果"],
    warnings: [],
    attempts_detail: [
      { attempt: 1, prompt_kind: "initial", validation_errors: ["错误 1"] },
    ],
  })
}

function writeCaseReviewPrepared(root: string) {
  writeJson(join(root, ".matrix", "data", "reviews", "case-review-prepared.json"), {
    status: "success",
    generated_at: "2026-05-06T00:00:00.000Z",
    confirmation_tests_file: ".matrix/data/source-confirmation-tests.json",
    test_requirements_file: ".matrix/data/test-requirements.json",
    project_type: "software",
    summary: {
      total_requirements: 2,
      total_cases: 2,
      covered_requirements: 2,
      uncovered_requirements: 0,
      broken_requirement_links: 0,
      path_mismatches: 0,
      related_requirement_mismatches: 0,
      empty_mandatory_fields: 0,
      unclear_test_purposes: 0,
      unresolved_placeholders: 1,
      semantic_validation_failures: 0,
    },
    coverage: {
      covered_requirement_ids: ["TR-GN-A-001", "TR-GN-B-002"],
      uncovered_requirement_ids: [],
    },
    template_baselines: [
      {
        test_type: "功能测试",
        project_type: "software",
        template_key: "功能测试-STEP-GENERATED",
        template_source: "markdown",
        general_rules: ["规则 A"],
        type_rules: ["规则 B"],
        warnings: [],
      },
    ],
    broken_links: [],
    path_mismatches: [],
    related_requirement_mismatches: [],
    unresolved_placeholders: [
      {
        case_id: "TC-GN-A-001",
        correspond_fun_id: "TR-GN-A-001",
        location: "test_step[0].步骤描述",
        placeholders: ["${para1}"],
      },
    ],
    field_issues: [],
    semantic_validation_failures: [],
    candidate_issues: [
      {
        severity: "minor",
        category: "placeholder",
        description: "存在未解析占位符",
        sample_ids: ["TC-GN-A-001"],
        sample_locations: ["test_step[0].步骤描述"],
      },
    ],
    warnings: ["诊断 warning"],
    errors: [],
  })
}

describe("matrix_artifact_query", () => {
  test("matrix_config summary omits DTP server precheck signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-config-"))
    writeJson(join(dir, ".matrix", "config", "matrix.jsonc"), {
      dtp_server: {
        base_url: "http://127.0.0.1:18087",
      },
    })

    const result = await query(dir, {
      artifact: "matrix_config",
      view: "summary",
    })

    expect(result.status).toBe("success")
    expect(result.summary).not.toHaveProperty("dtp_server_configured")
  })

  test("queries test requirements without returning the chapterTrList tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-query-tr-"))
    writeTestRequirements(dir)

    const summary = await query(dir, { artifact: "test_requirements", view: "summary" })
    expect(summary.status).toBe("success")
    expect(summary.summary.total_requirements).toBe(2)
    expect(JSON.stringify(summary)).not.toContain("chapterTrList")

    const list = await query(dir, { artifact: "test_requirements", view: "list_requirements", limit: 1 })
    expect(list.items).toHaveLength(1)
    expect(list.pagination.total).toBe(2)
    expect(list.items[0].requirement_id).toBe("TR-GN-A-001")
    // 长上下文字段默认不返回，避免列表视图膨胀（include_context 默认 false）
    expect(list.items[0]).not.toHaveProperty("handling")
    expect(list.items[0]).not.toHaveProperty("inputFlow")
    expect(list.items[0]).not.toHaveProperty("outputFlow")

    const item = await query(dir, {
      artifact: "test_requirements",
      view: "get_requirement",
      requirement_id: "TR-GN-B-002",
      include_context: true,
    })
    expect(item.item.handling).toBe("验证 B 功能。")
    expect(item.item.inputFlow).toBe("输入 B。")
  })

  test("queries confirmation suites with compact lists and optional steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-query-suite-"))
    writeSuites(dir)

    const sourceList = await query(dir, {
      artifact: "source_confirmation_suite",
      view: "list_cases",
    })
    expect(sourceList.items).toHaveLength(2)
    expect(sourceList.items[0].step_count).toBe(1)
    expect(sourceList.items[0].test_step).toBeUndefined()

    const translatedCase = await query(dir, {
      artifact: "translated_confirmation_suite",
      view: "get_case",
      case_id: "TC-GN-A-001",
      include_steps: true,
    })
    expect(translatedCase.item.keyword_names).toEqual(["执行A操作"])
    expect(translatedCase.item.test_step[0].key_name).toBe("执行A操作")
  })

  test("serves translated suite queries in degraded mode when a step key_name is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-query-suite-degraded-"))
    writeSuites(dir)
    // 修复循环常态：部分步骤未翻译（key_name 为空），Translated 严格 schema
    // 校验失败，但 Source schema 可解析——查询通道必须继续可用而非整体 error。
    writeJson(join(dir, ".matrix", "data", "confirmation-tests.json"), baseSuite([
      {
        case_name: "A 功能用例",
        test_purpose: "验证 A 功能。",
        correspond_fun_id: "TR-GN-A-001",
        case_id: "TC-GN-A-001",
        test_type: "功能测试",
        test_step: [
          {
            key_name: "",
            step_desc: "执行 A。",
            parameter: [],
            source_step_desc: "执行 A。",
            expected_result: "A 正确。",
          },
        ],
        related_software_req_ids: ["SRS-A"],
        translate_status: "failure",
      },
    ]))

    const summary = await query(dir, {
      artifact: "translated_confirmation_suite",
      view: "summary",
    })
    expect(summary.status).toBe("success")
    expect(summary.schema_status).toBe("invalid")
    expect(summary.details).toContain("key_name")
    expect(summary.summary.total_cases).toBe(1)

    const item = await query(dir, {
      artifact: "translated_confirmation_suite",
      view: "get_case",
      case_id: "TC-GN-A-001",
      include_steps: true,
    })
    expect(item.status).toBe("success")
    expect(item.schema_status).toBe("invalid")
    expect(item.item.case_id).toBe("TC-GN-A-001")
    expect(item.item.test_step[0].key_name).toBe("")

    const list = await query(dir, {
      artifact: "translated_confirmation_suite",
      view: "list_cases",
    })
    expect(list.status).toBe("success")
    expect(list.items).toHaveLength(1)

    // 两个 schema 都不通过时仍然报 schema_invalid
    writeJson(join(dir, ".matrix", "data", "confirmation-tests.json"), {
      project_name: "Demo",
      test_cases: [{ case_name: "无步骤用例", test_purpose: "X", correspond_fun_id: "TR-GN-A-001", case_id: "TC-GN-A-001", test_type: "功能测试", test_step: [] }],
    })
    const broken = await query(dir, {
      artifact: "translated_confirmation_suite",
      view: "summary",
    })
    expect(broken.status).toBe("error")
    expect(broken.error.code).toBe("schema_invalid")
  })

  test("queries generation manifest without returning prompts by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-query-generation-"))
    writeGenerationManifest(dir)

    const summary = await query(dir, { artifact: "phase6_generation_manifest", view: "summary" })
    expect(summary.summary.total_items).toBe(2)
    expect(summary.summary.generation_manifest_file).toBe(".matrix/data/phase6-generation-items.json")
    expect(summary.summary.template_provenance_version).toBe(1)
    expect(summary.summary.template_usage).toEqual([{ template_file: "/templates/test-functional.md", requirement_count: 2 }])

    const paths = await query(dir, { artifact: "phase6_generation_manifest", view: "paths" })
    expect(paths.item.worker_prompt_files_count).toBe(2)

    const list = await query(dir, { artifact: "phase6_generation_manifest", view: "list_items" })
    expect(list.items[0].requirement_id).toBe("TR-GN-A-001")
    expect(list.items[0].template_file).toBe("/templates/test-functional.md")
    expect(list.items[0].template_hash).toBe("a".repeat(64))
    expect(list.items[0].template_source).toBe("markdown")
    expect(JSON.stringify(list)).not.toContain("SECRET_PROMPT_SHOULD_BE_HIDDEN")
    expect(JSON.stringify(list)).not.toContain("SECRET_CONTEXT")

    const item = await query(dir, {
      artifact: "phase6_generation_manifest",
      view: "get_item",
      requirement_id: "TR-GN-A-001",
      include_prompt: true,
      include_context: true,
    })
    expect(item.item.prompt).toContain("SECRET_PROMPT_SHOULD_BE_HIDDEN")
    expect(item.item.normalization_context.requirement_id).toBe("TR-GN-A-001")

    const warnings = await query(dir, { artifact: "phase6_generation_manifest", view: "warnings" })
    expect(warnings.items[0].message).toBe("提示 A")
  })

  test("lists landed worker outputs and reconciles against the generation manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-query-worker-outputs-"))
    writeJson(join(dir, ".matrix", "data", "phase6-generation-items.json"), {
      status: "success",
      items: [
        { requirement_id: "TR-GN-A-001" },
        { requirement_id: "TR-GN-B-002" },
        { requirement_id: "TR-GN-C-003" },
      ],
    })
    writeJson(join(dir, ".matrix", "data", "TR-GN-A-001_output.json"), [{ 步骤描述: "A" }])
    writeFileSync(join(dir, ".matrix", "data", "TR-GN-B-002_output.json"), "{broken", "utf-8")
    writeJson(join(dir, ".matrix", "data", "confirmation-tests.json"), { decoy: true })

    const summary = await query(dir, { artifact: "phase6_worker_outputs", view: "summary" })
    expect(summary.summary.manifest_status).toBe("valid")
    expect(summary.summary.total_files).toBe(2)
    expect(summary.summary.valid_count).toBe(1)
    expect(summary.summary.invalid_count).toBe(1)
    expect(summary.landed_requirement_ids).toEqual(["TR-GN-A-001", "TR-GN-B-002"])
    expect(summary.missing_requirement_ids).toEqual(["TR-GN-C-003"])
    expect(summary.extra_requirement_ids).toEqual([])

    const list = await query(dir, { artifact: "phase6_worker_outputs", view: "list_files" })
    expect(list.items.map((item: { requirement_id: string }) => item.requirement_id)).toEqual([
      "TR-GN-A-001",
      "TR-GN-B-002",
    ])
    expect(list.items[0].file).toBe(".matrix/data/TR-GN-A-001_output.json")
    expect(list.items[0].json_status).toBe("valid")
    expect(typeof list.items[0].size_bytes).toBe("number")
    expect(list.items[1].json_status).toBe("invalid_json")
  })

  test("reports dir_missing and degrades without the generation manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-query-worker-outputs-missing-"))
    const empty = await query(dir, { artifact: "phase6_worker_outputs" })
    expect(empty.status).toBe("error")
    expect(empty.error.code).toBe("dir_missing")

    writeJson(join(dir, ".matrix", "data", "TR-GN-A-001_output.json"), [{ 步骤描述: "A" }])
    const summary = await query(dir, { artifact: "phase6_worker_outputs" })
    expect(summary.summary.manifest_status).toBe("missing")
    expect(summary.summary.total_files).toBe(1)
    expect(summary.missing_requirement_ids).toBeUndefined()
    expect(summary.landed_requirement_ids).toBeUndefined()
  })

  test("queries worker run summary, final result, tail events and diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-query-worker-"))
    writeWorkerRun(dir)

    const summary = await query(dir, { artifact: "phase6_worker_run", view: "summary" })
    expect(summary.summary.final_status).toBe("partial_success")
    expect(summary.summary.result_summary_file).toContain("result-summary.json")

    const resultSummary = await query(dir, { artifact: "phase6_worker_run", view: "result_summary" })
    expect(resultSummary.item.requirements_count).toBe(2)
    expect(resultSummary.item).not.toHaveProperty("requirements")

    const requirements = await query(dir, { artifact: "phase6_worker_run", view: "list_requirements" })
    expect(requirements.items.map((item: { requirement_id: string }) => item.requirement_id)).toEqual([
      "TR-GN-A-001",
      "TR-GN-B-002",
    ])

    const status = await query(dir, { artifact: "phase6_worker_run", view: "status" })
    expect(status.summary.failed_requirement_count).toBe(1)

    const events = await query(dir, { artifact: "phase6_worker_run", view: "events_tail", limit: 1 })
    expect(events.items).toHaveLength(1)
    expect(events.items[0].event).toBe("requirement_failed")

    const diagnostic = await query(dir, {
      artifact: "phase6_worker_run",
      view: "diagnostic",
      requirement_id: "TR-GN-B-002",
    })
    expect(diagnostic.item.validation_errors[0]).toContain("缺少预期结果")

    const failed = await query(dir, { artifact: "phase6_worker_run", view: "failed_requirements" })
    expect(failed.items[0].requirement_id).toBe("TR-GN-B-002")
  })

  test("queries phase6 prepared review details without returning the full artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-query-review-"))
    writeCaseReviewPrepared(dir)

    const summary = await query(dir, {
      artifact: "phase6_case_review_prepared",
      view: "summary",
    })
    expect(summary.status).toBe("success")
    expect(summary.summary.summary.total_requirements).toBe(2)

    const placeholders = await query(dir, {
      artifact: "phase6_case_review_prepared",
      view: "unresolved_placeholders",
    })
    expect(placeholders.items).toHaveLength(1)
    expect(placeholders.items[0].placeholders).toEqual(["${para1}"])

    const templates = await query(dir, {
      artifact: "phase6_case_review_prepared",
      view: "template_baselines",
    })
    expect(templates.items[0].template_key).toBe("功能测试-STEP-GENERATED")

    const coverage = await query(dir, {
      artifact: "phase6_case_review_prepared",
      view: "coverage",
    })
    expect(coverage.items[0].covered_requirement_ids).toEqual(["TR-GN-A-001", "TR-GN-B-002"])

    const unsupported = await query(dir, {
      artifact: "phase6_case_review_prepared",
      view: "raw",
    })
    expect(unsupported.error.code).toBe("unsupported_view")
    expect(JSON.stringify(unsupported)).not.toContain("规则 A")
  })

  test("returns structured errors for unsupported views and malformed JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-artifact-query-errors-"))
    mkdirSync(join(dir, ".matrix", "data"), { recursive: true })

    const unsupported = await query(dir, { artifact: "test_requirements", view: "raw" })
    expect(unsupported.status).toBe("error")
    expect(unsupported.error.code).toBe("unsupported_view")

    writeFileSync(
      join(dir, ".matrix", "data", "test-requirements.json"),
      "{ SECRET_FULL_TEXT_THIS_SHOULD_NOT_BE_RETURNED",
      "utf-8",
    )
    const malformed = await query(dir, { artifact: "test_requirements", view: "summary" })
    expect(malformed.status).toBe("error")
    expect(malformed.error.code).toBe("schema_invalid")
    expect(JSON.stringify(malformed)).not.toContain("SECRET_FULL_TEXT_THIS_SHOULD_NOT_BE_RETURNED")
  })
})
