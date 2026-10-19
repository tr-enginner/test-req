import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import {
  TestCaseExecution,
  TestExecutionReport,
} from "../schema/test-execution"
import { ARTIFACT_PATHS } from "../shared/constants"
import { withFileLock } from "../shared/file-mutex"

function resolveArtifactPath(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * exec_report_create — Create a skeleton TestExecutionReport JSON file.
 */
export const execReportCreate: ToolDefinition = tool({
  description:
    "Create a new test execution report skeleton at .matrix/data/test-execution.json. " +
    "Initializes the file with project metadata, empty executions array, and zeroed " +
    "coverage/summary. Must be called before exec_report_add_execution.",
  args: {
    project_name: tool.schema.string().describe("Project name"),
    version: tool.schema.string().describe("Project version"),
  },
  async execute({ project_name, version }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.TEST_EXECUTION)

    const skeleton = {
      project_name,
      version,
      created_date: new Date().toISOString().split("T")[0],
      executions: [],
      coverage: {
        requirement_coverage: 0,
        test_case_coverage: 0,
      },
      summary: {
        total_executed: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        not_executed: 0,
        pass_rate: 0,
        total_defects_found: 0,
      },
    }

    ensureDir(filePath)
    writeFileSync(filePath, JSON.stringify(skeleton, null, 2), "utf-8")

    return JSON.stringify({
      status: "success",
      action: "created",
      file: ARTIFACT_PATHS.TEST_EXECUTION,
      message: `Created test execution report skeleton for "${project_name}" v${version}`,
    })
  },
})

/**
 * exec_report_add_execution — Append one TestCaseExecution to the report.
 */
export const execReportAddExecution: ToolDefinition = tool({
  description:
    "Add a single test case execution record to the report. " +
    "The report must have been created with exec_report_create first. " +
    "Automatically fills in executed_date. Call this once per executed test case.",
  args: {
    test_case_id: tool.schema
      .string()
      .describe("ID of the confirmation test case executed (CT-XXXX)"),
    execution_id: tool.schema
      .string()
      .describe("Unique execution ID (e.g. EXEC-0001)"),
    verdict: tool.schema
      .enum(["pass", "fail", "blocked", "not_executed"])
      .describe("Overall verdict for this test case execution"),
    step_results: tool.schema
      .array(
        tool.schema.object({
          step_number: tool.schema.number().describe("Step sequence number"),
          actual_result: tool.schema
            .string()
            .describe("What the SUT actually did"),
          verdict: tool.schema
            .enum(["pass", "fail", "blocked", "not_executed"])
            .describe("Step verdict"),
          evidence: tool.schema
            .string()
            .optional()
            .describe("Logs, register values, or output captures"),
          notes: tool.schema
            .string()
            .optional()
            .describe("Additional observations"),
        }),
      )
      .describe("Per-step execution results"),
    defect_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("IDs of defects discovered during this execution"),
    environment: tool.schema
      .object({
        platform: tool.schema
          .string()
          .optional()
          .describe("Execution platform"),
        software_version: tool.schema
          .string()
          .optional()
          .describe("SUT version"),
        tools: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Tools used"),
      })
      .describe("Execution environment details"),
    executed_by: tool.schema
      .string()
      .describe("Who or what executed the test (agent name or person)"),
    duration_min: tool.schema
      .number()
      .optional()
      .describe("Execution duration in minutes"),
    notes: tool.schema
      .string()
      .optional()
      .describe("General notes about this execution"),
  },
  async execute({
    test_case_id,
    execution_id,
    verdict,
    step_results,
    defect_ids,
    environment,
    executed_by,
    duration_min,
    notes,
  }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.TEST_EXECUTION)

    const execution: any = {
      test_case_id,
      execution_id,
      verdict,
      step_results,
      defect_ids: defect_ids ?? [],
      environment: {
        platform: environment.platform,
        software_version: environment.software_version,
        tools: environment.tools ?? [],
      },
      executed_by,
      executed_date: new Date().toISOString().split("T")[0],
      duration_min,
      notes,
    }

    // Validate before acquiring lock
    const parsed = TestCaseExecution.safeParse(execution)
    if (!parsed.success) {
      return JSON.stringify({
        error: "Execution record validation failed",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      })
    }

    return await withFileLock(filePath, () => {
      if (!existsSync(filePath)) {
        return JSON.stringify({
          error:
            "Report file not found. Call exec_report_create first before adding executions.",
        })
      }

      let report: any
      try {
        report = JSON.parse(readFileSync(filePath, "utf-8"))
      } catch {
        return JSON.stringify({ error: "Failed to parse existing report file." })
      }

      // Check for duplicate execution ID
      if (report.executions.some((e: any) => e.execution_id === execution_id)) {
        return JSON.stringify({
          error: `Duplicate execution ID: ${execution_id}. Each execution must have a unique ID.`,
        })
      }

      report.executions.push(parsed.data)
      writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8")

      return JSON.stringify({
        status: "success",
        action: "added",
        execution_id,
        test_case_id,
        verdict,
        total_executions: report.executions.length,
        file: ARTIFACT_PATHS.TEST_EXECUTION,
      })
    })
  },
})

/**
 * exec_report_finalize — Compute summary + validate the full TestExecutionReport.
 */
export const execReportFinalize: ToolDefinition = tool({
  description:
    "Finalize the test execution report: fills in coverage data, computes summary " +
    "(total/passed/failed/blocked/not_executed/pass_rate/defects), and validates " +
    "against the TestExecutionReport Zod schema. Call this after all executions have been added.",
  args: {
    requirement_coverage: tool.schema
      .number()
      .describe("Requirement coverage percentage (0-100)"),
    test_case_coverage: tool.schema
      .number()
      .describe("Test case coverage percentage (0-100)"),
    code_statement: tool.schema
      .number()
      .optional()
      .describe("Statement coverage percentage (0-100)"),
    code_branch: tool.schema
      .number()
      .optional()
      .describe("Branch coverage percentage (0-100)"),
    code_mc_dc: tool.schema
      .number()
      .optional()
      .describe("MC/DC coverage percentage (0-100)"),
    code_condition: tool.schema
      .number()
      .optional()
      .describe("Condition coverage percentage (0-100)"),
    code_path: tool.schema
      .number()
      .optional()
      .describe("Path coverage percentage (0-100)"),
  },
  async execute({
    requirement_coverage,
    test_case_coverage,
    code_statement,
    code_branch,
    code_mc_dc,
    code_condition,
    code_path,
  }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.TEST_EXECUTION)

    return await withFileLock(filePath, () => {
      if (!existsSync(filePath)) {
        return JSON.stringify({
          error:
            "Report file not found. Call exec_report_create and add executions first.",
        })
      }

      let report: any
      try {
        report = JSON.parse(readFileSync(filePath, "utf-8"))
      } catch {
        return JSON.stringify({ error: "Failed to parse report file." })
      }

      // Fill coverage
      report.coverage = {
        requirement_coverage,
        test_case_coverage,
        code_statement,
        code_branch,
        code_mc_dc,
        code_condition,
        code_path,
      }

      // Compute summary from executions
      const executions: any[] = report.executions ?? []
      const passed = executions.filter((e) => e.verdict === "pass").length
      const failed = executions.filter((e) => e.verdict === "fail").length
      const blocked = executions.filter((e) => e.verdict === "blocked").length
      const notExecuted = executions.filter(
        (e) => e.verdict === "not_executed",
      ).length
      const total = executions.length
      const passRate =
        total > 0 ? Math.round((passed / total) * 10000) / 100 : 0

      // Count unique defects across all executions
      const allDefectIds = new Set<string>()
      for (const exec of executions) {
        for (const defId of exec.defect_ids ?? []) {
          allDefectIds.add(defId)
        }
      }

      report.summary = {
        total_executed: total,
        passed,
        failed,
        blocked,
        not_executed: notExecuted,
        pass_rate: passRate,
        total_defects_found: allDefectIds.size,
      }

      // Validate with Zod
      const result = TestExecutionReport.safeParse(report)
      if (!result.success) {
        return JSON.stringify({
          error: "Schema validation failed — file NOT updated",
          issues: result.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        })
      }

      writeFileSync(filePath, JSON.stringify(result.data, null, 2), "utf-8")

      return JSON.stringify({
        status: "success",
        action: "finalized",
        file: ARTIFACT_PATHS.TEST_EXECUTION,
        summary: result.data.summary,
        coverage: result.data.coverage,
        message: `Finalized report: ${total} executions, ${passed} passed, ${failed} failed, pass rate ${passRate}%.`,
      })
    })
  },
})
