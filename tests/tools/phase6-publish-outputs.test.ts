import { describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { phase6PublishOutputs } from "../../src/tools/phase6-publish-outputs"
import { testcaseGeneratorRun } from "../../src/tools/testcase-generator-runner"

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function writeText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value, "utf-8")
}

function makeCtx(directory: string) {
  return {
    sessionID: "sid-1",
    messageID: "mid-1",
    agent: "conductor",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function makeCase(caseId: string, requirementId: string) {
  return {
    case_id: caseId,
    case_name: `用例${caseId.slice(-1)}`,
    test_environment: "软平台测试环境",
    test_purpose: `验证${requirementId}。`,
    correspond_fun_id: requirementId,
    test_type: "功能测试",
    path: "/4/1/1/",
    constraints: "无",
    initial_settings: "无",
    test_input: "无",
    test_step: [
      {
        key_name: "",
        step_desc: "启动软平台。",
        parameter: [],
        source_step_desc: "启动软平台。",
        expected_result: "软件正常运行。",
        expected_key_name: "保留",
        source_expected_key_name: "保留",
        expected_parameter: [],
        is_startup_step: true,
      },
      {
        key_name: "DemoKeyword",
        step_desc: `执行${requirementId}的测试步骤。`,
        parameter: [],
        source_step_desc: `执行${requirementId}的测试步骤。`,
        expected_result: `${requirementId}输出正确结果。`,
        expected_key_name: "保留",
        source_expected_key_name: "保留",
        expected_parameter: [],
        is_startup_step: false,
      },
    ],
    assess_criteria: "实际结果与预期结果一致。",
    cease_condition: "测试正常结束。",
    status: 0,
    translate_status: "success",
  }
}

function writePublishGateArtifacts(
  root: string,
  suiteFile: string,
  requirementIds: string[] = ["TR-GN-001"],
) {
  writeJson(join(root, ".matrix", "data", "test-requirements.json"), {
    funItem: requirementIds.map((requirementId, index) => ({
      funId: [requirementId],
      test_type: "功能测试",
      titleNo: `4.1.${index + 1}`,
      title: `功能需求${index + 1}`,
      requirementContext: `验证${requirementId}。`,
      processingContext: `执行${requirementId}对应功能。`,
    })),
    softwareId: "SW-001",
    codeVersion: "V1.0",
  })
  writeJson(join(root, ".matrix", "data", "reviews", "case-review.json"), {
    id: "REV-CASE-001",
    phase: "test_case_design",
    target_artifact: suiteFile,
    verdict: "PASS",
    issues: [],
    reviewer: "reviewer",
    review_date: "2026-09-21",
  })
}

describe("phase6_publish_outputs", () => {
  test("rechecks real generation provenance and blocks template drift despite reviewer PASS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-publish-template-drift-"))
    try {
      const suiteFile = join(dir, ".matrix/data/confirmation-tests.json")
      writePublishGateArtifacts(dir, suiteFile)
      cpSync(join(import.meta.dir, "../../templates/testcase-prompts"), join(dir, "templates/testcase-prompts"), { recursive: true })
      const generated = JSON.parse(await (testcaseGeneratorRun as any).execute({}, makeCtx(dir)))
      expect(generated.status).toBe("success")
      writeJson(suiteFile, {
        project_name: "Matrix", version: "1.0", created_date: "2026-09-21",
        test_cases: [makeCase("TC-GN-001", "TR-GN-001")],
        traceability: [], summary: { total_cases: 1, by_type: { 功能测试: 1 } },
      })
      const templateFile = join(dir, "templates/testcase-prompts/test-functional.md")
      writeFileSync(templateFile, readFileSync(templateFile, "utf8") + "\n<!-- changed after generation -->\n")
      const result = JSON.parse(await (phase6PublishOutputs as any).execute({ suite_file: suiteFile }, makeCtx(dir)))
      expect(result.status).toBe("error")
      expect(result.error).toContain("template_provenance")
      expect(result.error).toContain("template_hash")
      expect(existsSync(join(dir, ".matrix/reports/confirmation-tests.docx"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("publication review inherits custom requirement path and project type from the generation manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-publish-template-context-"))
    try {
      const suiteFile = join(dir, ".matrix/data/confirmation-tests.json")
      writePublishGateArtifacts(dir, suiteFile)
      const requirementsFile = join(dir, ".matrix/data/custom-requirements.json")
      cpSync(join(dir, ".matrix/data/test-requirements.json"), requirementsFile)
      cpSync(join(import.meta.dir, "../../templates/testcase-prompts"), join(dir, "templates/testcase-prompts"), { recursive: true })
      const generated = JSON.parse(await (testcaseGeneratorRun as any).execute({
        test_requirements_file: requirementsFile, project_type: "software_variant",
      }, makeCtx(dir)))
      expect(generated.status).toBe("success")
      writeJson(suiteFile, {
        project_name: "Matrix", version: "1.0", created_date: "2026-09-21",
        test_cases: [makeCase("TC-GN-001", "TR-GN-001")],
        traceability: [], summary: { total_cases: 1, by_type: { 功能测试: 1 } },
      })
      const result = JSON.parse(await (phase6PublishOutputs as any).execute({ suite_file: suiteFile }, makeCtx(dir)))
      expect(result.status).toBe("success")
      const prepared = JSON.parse(readFileSync(join(dir, ".matrix/data/reviews/case-review-prepared.json"), "utf8"))
      expect(prepared.project_type).toBe("software_variant")
      expect(prepared.test_requirements_file).toBe(requirementsFile)
      expect(prepared.candidate_issues.filter((issue: any) => issue.category.startsWith("template_"))).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("publishes formal markdown and docx outputs from the reviewed suite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-publish-outputs-"))
    const suiteFile = join(dir, ".matrix", "data", "source-confirmation-tests.json")

    writeJson(suiteFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [
        makeCase("TC-GN-001", "TR-GN-001"),
      ],
      traceability: [
        { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 1,
        by_type: { "功能测试": 1 },
      },
    })
    writePublishGateArtifacts(dir, suiteFile)

    const raw = await (phase6PublishOutputs as any).execute(
      {
        suite_file: suiteFile,
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.status).toBe("success")
    expect(result.suite_file).toBe(suiteFile)
    expect(existsSync(result.markdown_file)).toBe(true)
    expect(existsSync(result.docx_file)).toBe(true)
    expect(existsSync(result.publish_state_file)).toBe(true)
  })

  test("propagates sub-tool validation issues into the publish error", async () => {
    // 真实事故(2026-08-20): parseJsonResult 只透传 error 字符串、丢弃 issues,
    // 智能体拿不到失败字段路径,被迫离开项目目录读插件源码自行定位。
    // 子工具的校验诊断(字段路径+消息)必须出现在发布错误里。
    const dir = mkdtempSync(join(tmpdir(), "phase6-publish-issues-"))
    const suiteFile = join(dir, ".matrix", "data", "source-confirmation-tests.json")

    const brokenCase = makeCase("TC-GN-001", "TR-GN-001")
    ;(brokenCase as Record<string, unknown>).status = "应为数字的状态"
    writeJson(suiteFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [brokenCase],
      traceability: [
        { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 1,
        by_type: { "功能测试": 1 },
      },
    })
    writePublishGateArtifacts(dir, suiteFile)

    const raw = await (phase6PublishOutputs as any).execute(
      { suite_file: suiteFile },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.status).toBe("error")
    expect(result.error).toContain("phase6_case_review_prepare")
    expect(result.error).toContain("test_cases.0.status")
  })

  test("最新预审存在未覆盖 requirement 时，即使 review 写 PASS 也拒绝发布", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-publish-coverage-gate-"))
    const suiteFile = join(dir, ".matrix", "data", "confirmation-tests.json")
    writeJson(suiteFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [makeCase("TC-GN-001", "TR-GN-001")],
      traceability: [
        { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
      ],
      summary: { total_cases: 1, by_type: { "功能测试": 1 } },
    })
    writePublishGateArtifacts(dir, suiteFile, ["TR-GN-001", "TR-GN-002"])

    const raw = await (phase6PublishOutputs as any).execute({ suite_file: suiteFile }, makeCtx(dir))
    const result = JSON.parse(raw)
    expect(result.status).toBe("error")
    expect(result.error).toContain("发布门禁失败")
    expect(result.error).toContain("coverage_completeness")
    expect(existsSync(join(dir, ".matrix", "reports", "test-cases.md"))).toBe(false)
  })

  test("review 不是 PASS 或审查目标不一致时拒绝发布", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-publish-review-gate-"))
    const suiteFile = join(dir, ".matrix", "data", "confirmation-tests.json")
    writeJson(suiteFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [makeCase("TC-GN-001", "TR-GN-001")],
      traceability: [],
      summary: { total_cases: 1, by_type: { "功能测试": 1 } },
    })
    writePublishGateArtifacts(dir, suiteFile)
    const reviewFile = join(dir, ".matrix", "data", "reviews", "case-review.json")
    writeJson(reviewFile, {
      id: "REV-CASE-001",
      phase: "test_case_design",
      target_artifact: suiteFile,
      verdict: "REVISE",
      issues: [{ severity: "blocking", description: "覆盖不完整" }],
      reviewer: "reviewer",
      review_date: "2026-09-21",
    })

    const raw = await (phase6PublishOutputs as any).execute({ suite_file: suiteFile }, makeCtx(dir))
    const result = JSON.parse(raw)
    expect(result.status).toBe("error")
    expect(result.error).toContain("verdict=REVISE")
  })

  test("defers DTP generation to phase6_execution_loop when a DTP project exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-publish-dtp-"))
    const suiteFile = join(dir, ".matrix", "data", "source-confirmation-tests.json")
    const translatedSuiteFile = join(dir, ".matrix", "data", "confirmation-tests.json")
    const keywordDir = join(dir, ".matrix", "data", "DTPProject", "\u7ec4\u5408\u5173\u952e\u5b57")

    writeJson(suiteFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [
        makeCase("TC-GN-001", "TR-GN-001"),
      ],
      traceability: [
        { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 1,
        by_type: { "功能测试": 1 },
      },
    })
    writePublishGateArtifacts(dir, suiteFile)
    writeJson(translatedSuiteFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [
        {
          ...makeCase("TC-GN-001", "TR-GN-001"),
          test_step: [
            {
              key_name: "DemoKeyword",
              step_desc: "Run demo keyword",
              expected_result: "Demo result is correct",
              parameter: [
                { Name: "${time}", Value: 1.1, Comments: "\u6267\u884c\u65f6\u95f4" },
              ],
            },
          ],
        },
      ],
      traceability: [
        { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 1,
        by_type: { "功能测试": 1 },
      },
    })
    writeText(join(dir, ".matrix", "data", "test-cases-todo.txt"), "TC-GN-001\n")
    writeJson(join(keywordDir, "Demo.json"), {
      Items: [
        { Name: "\u542f\u52a8VTEST", Arguments: [{ Name: "${vte}" }] },
        { Name: "\u6d4b\u8bd5\u7ed3\u675f", Arguments: [{ Name: "${time}" }] },
        { Name: "\u63cf\u8ff0", Arguments: [{ Name: "${message}" }] },
        {
          Name: "DemoKeyword",
          Arguments: [{ Name: "${time}", Comments: "\u6267\u884c\u65f6\u95f4" }],
        },
      ],
    })
    writeText(
      join(keywordDir, "Demo.txt"),
      [
        "\u542f\u52a8VTEST",
        "    [Arguments]    ${vte}",
        "\u6d4b\u8bd5\u7ed3\u675f",
        "    [Arguments]    ${time}",
        "\u63cf\u8ff0",
        "    [Arguments]    ${message}",
        "DemoKeyword",
        "    [Arguments]    ${time}",
      ].join("\n"),
    )

    const raw = await (phase6PublishOutputs as any).execute(
      {
        suite_file: suiteFile,
        doc_type: "software",
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    const outputRobotFile = join(dir, ".matrix", "data", "DTPProject", "V1", "\u6d4b\u8bd5\u7528\u4f8b", "TC-GN-001.robot")

    expect(result.status).toBe("success")
    expect(result.dtp_generation_deferred_to).toBe("phase6_execution_loop")
    expect(result.dtp_outputs).toBeUndefined()
    expect(existsSync(join(dir, ".matrix", "data", "generated-test-data.json"))).toBe(false)
    expect(existsSync(outputRobotFile)).toBe(false)
  })

  test("does not run DTP preflight or generate todo during publication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-publish-dtp-preflight-"))
    const suiteFile = join(dir, ".matrix", "data", "source-confirmation-tests.json")
    const translatedSuiteFile = join(dir, ".matrix", "data", "confirmation-tests.json")
    const keywordDir = join(dir, ".matrix", "data", "DTPProject", "\u7ec4\u5408\u5173\u952e\u5b57")

    writeJson(suiteFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [
        makeCase("TC-GN-001", "TR-GN-001"),
      ],
      traceability: [
        { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 1,
        by_type: { functional: 1 },
      },
    })
    writePublishGateArtifacts(dir, suiteFile)
    writeJson(translatedSuiteFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [
        {
          ...makeCase("TC-GN-001", "TR-GN-001"),
          test_step: [
            {
              key_name: "DemoKeyword",
              step_desc: "Run demo keyword",
              expected_result: "Demo result is correct",
              parameter: [],
            },
          ],
        },
      ],
      traceability: [
        { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 1,
        by_type: { "功能测试": 1 },
      },
    })
    writeJson(join(keywordDir, "Demo.json"), {
      Items: [
        { Name: "\u542f\u52a8VTEST", Arguments: [{ Name: "${vte}" }] },
        { Name: "\u6d4b\u8bd5\u7ed3\u675f", Arguments: [{ Name: "${time}" }] },
        { Name: "\u63cf\u8ff0", Arguments: [{ Name: "${message}" }] },
        { Name: "DemoKeyword", Arguments: [{ Name: "${time}" }] },
      ],
    })
    writeText(
      join(keywordDir, "Demo.txt"),
      [
        "\u542f\u52a8VTEST",
        "    [Arguments]    ${vte}",
        "\u6d4b\u8bd5\u7ed3\u675f",
        "    [Arguments]    ${time}",
        "\u63cf\u8ff0",
        "    [Arguments]    ${message}",
        "DemoKeyword",
        "    [Arguments]    ${time}",
      ].join("\n"),
    )

    const raw = await (phase6PublishOutputs as any).execute(
      {
        suite_file: suiteFile,
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)

    expect(result.status).toBe("success")
    expect(result.dtp_generation_deferred_to).toBe("phase6_execution_loop")
    expect(result.warnings).toBeUndefined()
    expect(existsSync(join(dir, ".matrix", "data", "test-cases-todo.txt"))).toBe(false)
    expect(existsSync(join(dir, ".matrix", "data", "generated-test-data.json"))).toBe(false)
  })
})
