import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import {
  parseDtpCoverageData,
  parseDtpTestSummary,
  optimizePhase6CasesFromExecutionReport,
  runPhase6ExecutionLoop,
  type RoundAnalysis,
} from "../../src/tools/phase6-execution-loop"
import type { SourceConfirmationTestSuite } from "../../src/schema/confirmation-test-case"
import type { DtpExecutorOptions } from "../../src/tools/dtp-executor"

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function writeText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value, "utf-8")
}

function makeSourceSuite(caseIds = ["TC-GN-001"]): SourceConfirmationTestSuite {
  return {
    project_name: "Matrix",
    version: "1.0",
    created_date: "2026-04-27",
    test_cases: caseIds.map((caseId, index) => ({
      case_id: caseId,
      case_name: `功能用例${index + 1}`,
      test_environment: "软平台测试环境",
      test_purpose: "验证功能。",
      correspond_fun_id: `TR-GN-${String(index + 1).padStart(3, "0")}`,
      test_type: "功能测试",
      path: `/4/1/${index + 1}/`,
      constraints: "无",
      initial_settings: "无",
      test_input: "无",
      test_step: [
        { 步骤描述: "执行功能步骤。", 预期结果: "输出正确。" },
      ],
      assess_criteria: "实际结果与预期结果一致。",
      cease_condition: "测试正常结束。",
      status: 0,
    })),
    traceability: caseIds.map((caseId, index) => ({
      test_req_id: `TR-GN-${String(index + 1).padStart(3, "0")}`,
      case_ids: [caseId],
      coverage_status: "full",
    })),
    summary: {
      total_cases: caseIds.length,
      by_type: { "功能测试": caseIds.length },
    },
  }
}

function makeTranslatedSuite(caseIds = ["TC-GN-001"]) {
  return {
    ...makeSourceSuite(caseIds),
    test_cases: makeSourceSuite(caseIds).test_cases.map((testCase) => ({
      ...testCase,
      test_step: [
        {
          key_name: "DemoKeyword",
          step_desc: "执行功能步骤",
          parameter: [],
          expected_result: "输出正确",
        },
      ],
    })),
  }
}

function writeKeywordLibrary(dir: string) {
  writeJson(join(dir, ".matrix", "data", "DTPProject", "组合关键字", "Demo.json"), {
    Items: [
      {
        Name: "DemoKeyword",
        Comments: "执行功能步骤",
        Arguments: [],
      },
    ],
  })
}

function writePhase6Inputs(dir: string, caseIds = ["TC-GN-001"], config: Record<string, unknown> = {}) {
  writeJson(join(dir, ".matrix", "config", "matrix.jsonc"), {
    dtp_server: {
      base_url: "http://127.0.0.1:18087",
      default_version: "V1",
      poll_interval: 1,
    },
    phase6_execution_max_optimization_rounds: 1,
    ...config,
  })
  writeJson(join(dir, ".matrix", "data", "source-confirmation-tests.json"), makeSourceSuite(caseIds))
  writeJson(join(dir, ".matrix", "data", "confirmation-tests.json"), makeTranslatedSuite(caseIds))
  writeKeywordLibrary(dir)
  mkdirSync(join(dir, ".matrix", "data", "DTPProject", "报告"), { recursive: true })
}

function writeRobotOutput(reportsDir: string, status: "PASS" | "FAIL", message = "") {
  const pass = status === "PASS" ? 1 : 0
  const fail = status === "FAIL" ? 1 : 0
  writeText(
    join(reportsDir, "output.xml"),
    [
      "<robot>",
      "<suite>",
      `<test name="TC-GN-001"><status status="${status}">${message}</status></test>`,
      "</suite>",
      "<statistics><total>",
      `<stat pass="${pass}" fail="${fail}" skip="0">All Tests</stat>`,
      "</total></statistics>",
      "</robot>",
    ].join(""),
  )
}

function sampleFailureMessage() {
  return [
    {
      keyword: "DataPool.判读数据池项相等",
      argments: {
        "${time}": "22.5",
        "${Name}": "状态遥测参数_控制指令计数",
        "${Value}": "1",
      },
      expect: "第22.5秒，状态遥测参数_控制指令计数 = 1",
      actual: "第22.5秒，状态遥测参数_控制指令计数 = null",
      failmsg: "0.0 != 1.0",
    },
  ]
}

function writeDtpSummary(
  reportsDir: string,
  cases: Array<{ name: string; status: "PASS" | "FAIL"; error_message?: unknown }>,
) {
  const passed = cases.filter((item) => item.status === "PASS").length
  const failed = cases.filter((item) => item.status === "FAIL").length
  const passRate = cases.length > 0 ? ((passed / cases.length) * 100).toFixed(1) : "0.0"
  writeJson(join(reportsDir, "test_summary.json"), {
    summary: {
      total: cases.length,
      passed,
      failed,
      pass_rate: `${passRate}%`,
    },
    test_cases: cases.map((item) => ({
      name: item.name,
      status: item.status,
      error_message: item.error_message ?? "",
    })),
  })
}

function writeCoverage(reportsDir: string, branch: number, statement = 95) {
  writeJson(join(reportsDir, "coverage_report", "coverage_data.json"), {
    total_coverage: {
      statement: {
        percent: statement,
        covered: 1900,
        total: 3290,
      },
      branch: {
        percent: branch,
        covered: 181,
        total: 438,
      },
    },
  })
}

function makeAnalysisForOptimizer(failedCaseId: string): RoundAnalysis {
  return {
    reportsDir: "",
    resultSource: "test_summary_json",
    outputXml: "",
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    passRate: 0,
    robotTests: [{ name: failedCaseId, status: "FAIL", message: "failed" }],
    failedCases: [{ case_id: failedCaseId, status: "FAIL", message: "failed" }],
    coverage: {
      metrics: { branch: 95 },
      missing: false,
      warnings: [],
    },
  }
}

describe("phase6_execution_loop", () => {
  test("parses DTP test_summary.json and coverage_data.json sample shapes", () => {
    const summary = parseDtpTestSummary({
      summary: { total: 16, passed: 4, failed: 12, pass_rate: "25.0%" },
      test_cases: [
        { name: "TC-JK-CAN-001", status: "PASS", error_message: "" },
        { name: "TC-JK-CAN-003", status: "FAIL", error_message: sampleFailureMessage() },
      ],
    })
    const coverage = parseDtpCoverageData({
      total_coverage: {
        statement: { percent: 57.75, covered: 1900, total: 3290 },
        branch: { percent: 41.32, covered: 181, total: 438 },
      },
    })

    expect(summary.total).toBe(16)
    expect(summary.passRate).toBe(25)
    expect(summary.failedCases).toHaveLength(1)
    expect(summary.failedCases[0].case_id).toBe("TC-JK-CAN-003")
    expect(summary.failedCases[0].message).toContain("failmsg=0.0 != 1.0")
    expect(coverage.statement).toBe(57.8)
    expect(coverage.branch).toBe(41.3)
  })

  test("passes the gate from DTP JSON reports and keeps the initial full todo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-execution-loop-pass-"))
    writePhase6Inputs(dir, ["TC-GN-001", "TC-GN-002"])
    const reportsDir = join(dir, ".matrix", "data", "DTPProject", "报告")
    writeDtpSummary(reportsDir, [
      { name: "TC-GN-001", status: "PASS" },
      { name: "TC-GN-002", status: "PASS" },
    ])
    writeCoverage(reportsDir, 95)
    const events: string[] = []

    const result = await runPhase6ExecutionLoop(dir, {}, {
      regenerateRobot: async () => {
        events.push("regenerate")
        expect(readFileSync(join(dir, ".matrix", "data", "test-cases-todo.txt"), "utf-8").trim()).toBe("TC-GN-001\nTC-GN-002")
        return [{ tool: "dtp_robot_generate", status: "success" }]
      },
      executeDtp: async () => {
        events.push("execute")
        return { success: true, reports_dir: reportsDir }
      },
    })

    expect(result.status).toBe("success")
    expect(result.gate_status).toBe("passed")
    expect(result.pass_rate).toBe(100)
    expect(result.coverage_target).toBe("branch")
    expect(result.coverage_value).toBe(95)
    expect(readFileSync(join(dir, ".matrix", "data", "test-cases-todo.txt"), "utf-8").trim()).toBe("TC-GN-001\nTC-GN-002")
    expect(existsSync(join(dir, ".matrix", "data", "test-execution.json"))).toBe(true)
    expect(existsSync(join(dir, ".matrix", "reports", "test-execution.md"))).toBe(true)
    expect(existsSync(join(dir, ".matrix", "data", "phase6-execution-loop.json"))).toBe(true)
    expect(events).toEqual(["regenerate", "execute"])
    const loop = JSON.parse(readFileSync(join(dir, ".matrix", "data", "phase6-execution-loop.json"), "utf-8"))
    expect(loop.rounds[0].robot_regenerated).toBe(true)
    expect(loop.rounds[0].dtp_generation_outputs).toEqual([{ tool: "dtp_robot_generate", status: "success" }])
  })

  test("optimizes only FAIL cases when pass rate is below threshold, rewrites todo, and retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-execution-loop-retry-pass-rate-"))
    const caseIds = ["TC-GN-001", "TC-GN-002", "TC-GN-003"]
    writePhase6Inputs(dir, caseIds)
    const reportsDir = join(dir, ".matrix", "data", "DTPProject", "报告")
    let attempts = 0
    let regenerateCount = 0

    const result = await runPhase6ExecutionLoop(dir, {}, {
      executeDtp: async () => {
        attempts += 1
        if (attempts === 1) {
          writeDtpSummary(reportsDir, [
            { name: "TC-GN-001", status: "PASS" },
            { name: "TC-GN-002", status: "FAIL", error_message: sampleFailureMessage() },
            { name: "TC-GN-003", status: "FAIL", error_message: sampleFailureMessage() },
          ])
        } else {
          writeDtpSummary(reportsDir, caseIds.map((caseId) => ({ name: caseId, status: "PASS" as const })))
        }
        writeCoverage(reportsDir, 95)
        return { success: true, reports_dir: reportsDir }
      },
      optimizeCases: async (_workspaceRoot, sourceSuite, analysis) => ({
        sourceSuite,
        changedCaseIds: analysis.failedCases.map((item) => item.case_id),
      }),
      regenerateRobot: async () => {
        regenerateCount += 1
        return []
      },
    })

    expect(result.status).toBe("success")
    expect(result.attempts).toBe(2)
    expect(regenerateCount).toBe(2)
    expect(readFileSync(join(dir, ".matrix", "data", "test-cases-todo.txt"), "utf-8").trim()).toBe("TC-GN-002\nTC-GN-003")

    const loop = JSON.parse(readFileSync(join(dir, ".matrix", "data", "phase6-execution-loop.json"), "utf-8"))
    expect(loop.rounds[0].result_source).toBe("test_summary_json")
    expect(loop.rounds[0].pass_rate_met).toBe(false)
    expect(loop.rounds[0].failed_cases.map((item: { case_id: string }) => item.case_id)).toEqual(["TC-GN-002", "TC-GN-003"])
    expect(loop.rounds[0].optimization_case_ids).toEqual(["TC-GN-002", "TC-GN-003"])
    expect(loop.rounds[1].pass_rate_met).toBe(true)
  })

  test("optimizes FAIL cases when pass rate passes but branch coverage is below threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-execution-loop-retry-coverage-"))
    const caseIds = ["TC-GN-001", "TC-GN-002", "TC-GN-003"]
    writePhase6Inputs(dir, caseIds)
    const reportsDir = join(dir, ".matrix", "data", "DTPProject", "报告")
    let attempts = 0

    const result = await runPhase6ExecutionLoop(dir, {}, {
      executeDtp: async () => {
        attempts += 1
        if (attempts === 1) {
          writeDtpSummary(reportsDir, [
            { name: "TC-GN-001", status: "PASS" },
            { name: "TC-GN-002", status: "PASS" },
            { name: "TC-GN-003", status: "FAIL", error_message: sampleFailureMessage() },
          ])
          writeCoverage(reportsDir, 41.32)
        } else {
          writeDtpSummary(reportsDir, caseIds.map((caseId) => ({ name: caseId, status: "PASS" as const })))
          writeCoverage(reportsDir, 95)
        }
        return { success: true, reports_dir: reportsDir }
      },
      optimizeCases: async (_workspaceRoot, sourceSuite, analysis) => ({
        sourceSuite,
        changedCaseIds: analysis.failedCases.map((item) => item.case_id),
      }),
      regenerateRobot: async () => [],
    })

    expect(result.status).toBe("success")
    expect(result.attempts).toBe(2)
    expect(readFileSync(join(dir, ".matrix", "data", "test-cases-todo.txt"), "utf-8").trim()).toBe("TC-GN-003")

    const loop = JSON.parse(readFileSync(join(dir, ".matrix", "data", "phase6-execution-loop.json"), "utf-8"))
    expect(loop.rounds[0].pass_rate_met).toBe(true)
    expect(loop.rounds[0].coverage_value).toBe(41.3)
    expect(loop.rounds[0].coverage_met).toBe(false)
  })

  test("fails immediately when coverage is low but no FAIL case can be optimized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-execution-loop-no-failed-case-"))
    writePhase6Inputs(dir, ["TC-GN-001", "TC-GN-002"], {
      phase6_execution_max_optimization_rounds: 1,
    })
    const reportsDir = join(dir, ".matrix", "data", "DTPProject", "报告")
    writeDtpSummary(reportsDir, [
      { name: "TC-GN-001", status: "PASS" },
      { name: "TC-GN-002", status: "PASS" },
    ])
    writeCoverage(reportsDir, 41.32)

    const result = await runPhase6ExecutionLoop(dir, {}, {
      executeDtp: async () => ({ success: true, reports_dir: reportsDir }),
      optimizeCases: async (_workspaceRoot, sourceSuite) => ({
        sourceSuite,
        changedCaseIds: [],
      }),
      regenerateRobot: async () => [],
    })

    expect(result.status).toBe("error")
    expect(result.gate_status).toBe("failed")
    expect(result.attempts).toBe(1)

    const loop = JSON.parse(readFileSync(join(dir, ".matrix", "data", "phase6-execution-loop.json"), "utf-8"))
    expect(loop.rounds[0].errors.join("\n")).toContain("未找到 status=FAIL")
    expect(loop.rounds[0].optimization_applied).toBe(false)
  })

  test("returns a structured error when initial DTP preparation fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-execution-loop-prepare-failure-"))
    writePhase6Inputs(dir, ["TC-GN-001"])

    const result = await runPhase6ExecutionLoop(dir, {}, {
      executeDtp: async () => {
        throw new Error("should not execute DTP after preparation failure")
      },
      regenerateRobot: async () => {
        throw new Error("keyword directory not found")
      },
    })

    expect(result.status).toBe("error")
    expect(result.gate_status).toBe("error")
    expect(result.error).toBe("DTP准备失败：keyword directory not found")

    const loop = JSON.parse(readFileSync(join(dir, ".matrix", "data", "phase6-execution-loop.json"), "utf-8"))
    expect(loop.rounds).toHaveLength(1)
    expect(loop.rounds[0].dtp_success).toBe(false)
    expect(loop.rounds[0].errors).toEqual(["DTP准备失败：keyword directory not found"])
    expect(loop.rounds[0].optimization_applied).toBe(false)
  })

  test("treats missing coverage data as a failed gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-execution-loop-no-coverage-"))
    writePhase6Inputs(dir, ["TC-GN-001"], {
      phase6_execution_max_optimization_rounds: 0,
    })
    const reportsDir = join(dir, ".matrix", "data", "DTPProject", "报告")
    writeDtpSummary(reportsDir, [{ name: "TC-GN-001", status: "PASS" }])

    const result = await runPhase6ExecutionLoop(dir, {}, {
      executeDtp: async () => ({ success: true, reports_dir: reportsDir }),
      regenerateRobot: async () => [],
    })

    expect(result.status).toBe("error")
    expect(result.gate_status).toBe("failed")
    expect(result.coverage_met).toBe(false)

    const loop = JSON.parse(readFileSync(join(dir, ".matrix", "data", "phase6-execution-loop.json"), "utf-8"))
    expect(loop.rounds[0].coverage_missing).toBe(true)
    expect(loop.final.message).toContain("覆盖率数据缺失")
  })

  test("keeps output.xml compatibility with explicit legacy coverage target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-execution-loop-output-xml-"))
    writePhase6Inputs(dir)
    const reportsDir = join(dir, ".matrix", "data", "DTPProject", "报告")
    writeRobotOutput(reportsDir, "PASS")
    writeJson(join(reportsDir, "coverage_report", "coverage_data.json"), { statement: 95 })

    const result = await runPhase6ExecutionLoop(dir, {
      coverage_target: "statement",
      coverage_threshold: 90,
      pass_rate_threshold: 100,
    }, {
      executeDtp: async () => ({ success: true, reports_dir: reportsDir }),
      regenerateRobot: async () => [],
    })

    expect(result.status).toBe("success")
    expect(result.gate_status).toBe("passed")
    expect(result.coverage_value).toBe(95)

    const loop = JSON.parse(readFileSync(join(dir, ".matrix", "data", "phase6-execution-loop.json"), "utf-8"))
    expect(loop.rounds[0].result_source).toBe("output_xml")
  })

  test("delegates only DTP project context to executor when matrix dtp_server is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-execution-loop-no-config-"))
    writeJson(join(dir, ".matrix", "data", "source-confirmation-tests.json"), makeSourceSuite())
    writeJson(join(dir, ".matrix", "data", "confirmation-tests.json"), makeTranslatedSuite())
    const reportsDir = join(dir, ".matrix", "data", "DTPProject", "报告")
    writeDtpSummary(reportsDir, [{ name: "TC-GN-001", status: "PASS" }])
    writeCoverage(reportsDir, 95)
    let receivedOptions: DtpExecutorOptions | null = null

    const result = await runPhase6ExecutionLoop(dir, {}, {
      executeDtp: async (options) => {
        receivedOptions = options
        return { success: true, reports_dir: reportsDir }
      },
      regenerateRobot: async () => [],
    })

    expect(result.status).toBe("success")
    expect(result.gate_status).toBe("passed")
    expect(receivedOptions).toEqual({
      project_dir: join(dir, ".matrix", "data", "DTPProject"),
      project_name: "DTPProject",
    })
    expect(receivedOptions).not.toHaveProperty("base_url")
    expect(receivedOptions).not.toHaveProperty("version")
    expect(receivedOptions).not.toHaveProperty("poll_interval")
    expect(existsSync(join(dir, ".matrix", "data", "test-execution.json"))).toBe(true)
  })

  test("records DTP executor failure directly without config precheck or optimization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-execution-loop-dtp-failure-"))
    writePhase6Inputs(dir, ["TC-GN-001"], {
      phase6_execution_max_optimization_rounds: 1,
    })

    const result = await runPhase6ExecutionLoop(dir, {}, {
      executeDtp: async () => ({
        success: false,
        error: "Execution start failed: 500",
      }),
      optimizeCases: async () => {
        throw new Error("should not optimize after DTP execution failure")
      },
      regenerateRobot: async () => [],
    })

    expect(result.status).toBe("error")
    expect(result.gate_status).toBe("error")
    expect(result.error).toBe("DTP执行失败：Execution start failed: 500")
    expect(String(result.error)).not.toContain("matrix.jsonc")

    const loop = JSON.parse(readFileSync(join(dir, ".matrix", "data", "phase6-execution-loop.json"), "utf-8"))
    expect(loop.rounds).toHaveLength(1)
    expect(loop.rounds[0].dtp_success).toBe(false)
    expect(loop.rounds[0].errors).toEqual(["DTP执行失败：Execution start failed: 500"])
    expect(loop.rounds[0].optimization_applied).toBe(false)
    expect(loop.final.attempts).toBe(1)
    expect(loop.final.message).not.toContain("matrix.jsonc")
  })

  test("optimizer helper returns only failed case ids", () => {
    const failedId = "TC-GN-002"
    const analysis = makeAnalysisForOptimizer(failedId)
    expect(optimizePhase6CasesFromExecutionReport(makeSourceSuite(["TC-GN-001", failedId]), analysis)).toEqual([failedId])
  })
})
