import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import {
  UnitTestCase,
  UnitTestResult,
  UnitTestReport,
} from "../schema/unit-test-case"
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
 * ut_report_create — Create a skeleton UnitTestReport JSON file.
 */
export const utReportCreate: ToolDefinition = tool({
  description:
    "Create a new unit test report skeleton at .matrix/data/unit-tests.json. " +
    "Initializes the file with project metadata, empty test_cases/results arrays, " +
    "and zeroed coverage/summary. Must be called before ut_report_add_case.",
  args: {
    project_name: tool.schema.string().describe("Project name"),
    version: tool.schema.string().describe("Project version"),
    framework: tool.schema
      .string()
      .optional()
      .describe("Test framework (unity, cunit, gtest, custom)"),
  },
  async execute({ project_name, version }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.UNIT_TESTS)

    const skeleton = {
      project_name,
      version,
      created_date: new Date().toISOString().split("T")[0],
      test_cases: [],
      results: [],
      coverage: {
        uncovered_functions: [],
      },
      summary: {
        total_cases: 0,
        passed: 0,
        failed: 0,
        error: 0,
        skip: 0,
        pass_rate: 0,
      },
    }

    ensureDir(filePath)
    writeFileSync(filePath, JSON.stringify(skeleton, null, 2), "utf-8")

    return JSON.stringify({
      status: "success",
      action: "created",
      file: ARTIFACT_PATHS.UNIT_TESTS,
      message: `Created unit test report skeleton for "${project_name}" v${version}`,
    })
  },
})

/**
 * ut_report_add_case — Append one UnitTestCase to the report.
 */
export const utReportAddCase: ToolDefinition = tool({
  description:
    "Add a single unit test case to the report. " +
    "The report must have been created with ut_report_create first. " +
    "Call this once per test case — design one case, add it, then design the next.",
  args: {
    id: tool.schema.string().describe("Test case ID, format UT-XXXX"),
    target_function_id: tool.schema
      .string()
      .describe("ID of the function under test from software analysis"),
    target_function_name: tool.schema
      .string()
      .describe("Name of the function under test"),
    related_requirement_ids: tool.schema
      .array(tool.schema.string())
      .describe("Test requirement IDs this case covers"),
    title: tool.schema.string().describe("Concise test case title"),
    description: tool.schema
      .string()
      .describe("What the test verifies and why"),
    design_method: tool.schema
      .enum([
        "equivalence_partition",
        "boundary_value",
        "basic_path",
        "condition_combination",
        "error_guessing",
        "state_transition",
      ])
      .describe("Test design method used"),
    preconditions: tool.schema
      .array(tool.schema.string())
      .describe("Conditions that must be true before execution"),
    inputs: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string().describe("Parameter name"),
          type: tool.schema.string().describe("Parameter type"),
          value: tool.schema.string().describe("Input value"),
          description: tool.schema
            .string()
            .optional()
            .describe("Description of this input"),
        }),
      )
      .describe("Input parameters"),
    expected_outputs: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string().describe("Output name"),
          type: tool.schema.string().describe("Output type"),
          value: tool.schema.string().describe("Expected value"),
          description: tool.schema
            .string()
            .optional()
            .describe("Description of this output"),
        }),
      )
      .describe("Expected output values"),
    stubs: tool.schema
      .array(
        tool.schema.object({
          function_name: tool.schema
            .string()
            .describe("Name of function to stub"),
          return_value: tool.schema
            .string()
            .describe("Value the stub returns"),
          description: tool.schema
            .string()
            .optional()
            .describe("Why this stub is needed"),
        }),
      )
      .optional()
      .describe("Function stubs needed for isolation"),
    postconditions: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Expected system state after test"),
    coverage_contribution: tool.schema
      .enum(["statement", "branch", "mc_dc"])
      .optional()
      .describe("Primary coverage criterion this case targets"),
  },
  async execute({
    id,
    target_function_id,
    target_function_name,
    related_requirement_ids,
    title,
    description,
    design_method,
    preconditions,
    inputs,
    expected_outputs,
    stubs,
    postconditions,
    coverage_contribution,
  }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.UNIT_TESTS)

    const testCase: any = {
      id,
      target_function_id,
      target_function_name,
      related_requirement_ids,
      title,
      description,
      design_method,
      preconditions,
      inputs,
      expected_outputs,
      stubs: stubs ?? [],
      postconditions: postconditions ?? [],
      coverage_contribution,
    }

    // Validate the single case before acquiring lock
    const caseResult = UnitTestCase.safeParse(testCase)
    if (!caseResult.success) {
      return JSON.stringify({
        error: "Test case validation failed",
        details: caseResult.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      })
    }

    return await withFileLock(filePath, () => {
      if (!existsSync(filePath)) {
        return JSON.stringify({
          error:
            "Report file not found. Call ut_report_create first before adding cases.",
        })
      }

      let report: any
      try {
        report = JSON.parse(readFileSync(filePath, "utf-8"))
      } catch {
        return JSON.stringify({ error: "Failed to parse existing report file." })
      }

      // Check for duplicate ID
      if (report.test_cases.some((tc: any) => tc.id === id)) {
        return JSON.stringify({
          error: `Duplicate test case ID: ${id}. Each case must have a unique ID.`,
        })
      }

      report.test_cases.push(caseResult.data)
      writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8")

      return JSON.stringify({
        status: "success",
        action: "added",
        case_id: id,
        total_cases: report.test_cases.length,
        file: ARTIFACT_PATHS.UNIT_TESTS,
      })
    })
  },
})

/**
 * ut_report_add_result — Append one UnitTestResult to the report.
 */
export const utReportAddResult: ToolDefinition = tool({
  description:
    "Add a single unit test execution result to the report. " +
    "The test case must already exist in the report (added via ut_report_add_case). " +
    "Automatically fills in executed_date.",
  args: {
    test_case_id: tool.schema
      .string()
      .describe("ID of the test case this result belongs to (UT-XXXX)"),
    verdict: tool.schema
      .enum(["pass", "fail", "error", "skip"])
      .describe("Execution verdict"),
    actual_outputs: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string().describe("Output name"),
          type: tool.schema.string().describe("Output type"),
          value: tool.schema.string().describe("Actual value observed"),
          description: tool.schema
            .string()
            .optional()
            .describe("Description"),
        }),
      )
      .optional()
      .describe("Actual output values observed"),
    error_message: tool.schema
      .string()
      .optional()
      .describe("Error message if verdict is error"),
    execution_time_ms: tool.schema
      .number()
      .optional()
      .describe("Execution time in milliseconds"),
  },
  async execute({
    test_case_id,
    verdict,
    actual_outputs,
    error_message,
    execution_time_ms,
  }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.UNIT_TESTS)

    const resultObj: any = {
      test_case_id,
      verdict,
      actual_outputs,
      error_message,
      execution_time_ms,
      executed_date: new Date().toISOString().split("T")[0],
    }

    // Validate before acquiring lock
    const parsed = UnitTestResult.safeParse(resultObj)
    if (!parsed.success) {
      return JSON.stringify({
        error: "Result validation failed",
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
            "Report file not found. Call ut_report_create first.",
        })
      }

      let report: any
      try {
        report = JSON.parse(readFileSync(filePath, "utf-8"))
      } catch {
        return JSON.stringify({ error: "Failed to parse existing report file." })
      }

      // Verify the test case exists
      const caseExists = report.test_cases.some(
        (tc: any) => tc.id === test_case_id,
      )
      if (!caseExists) {
        return JSON.stringify({
          error: `Test case ${test_case_id} not found. Add it with ut_report_add_case first.`,
        })
      }

      // Check for duplicate result
      if (report.results.some((r: any) => r.test_case_id === test_case_id)) {
        return JSON.stringify({
          error: `Result for ${test_case_id} already exists. Each case should have one result.`,
        })
      }

      report.results.push(parsed.data)
      writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8")

      return JSON.stringify({
        status: "success",
        action: "added_result",
        test_case_id,
        verdict,
        total_results: report.results.length,
        file: ARTIFACT_PATHS.UNIT_TESTS,
      })
    })
  },
})

/**
 * ut_report_finalize — Compute summary + validate the full UnitTestReport.
 */
export const utReportFinalize: ToolDefinition = tool({
  description:
    "Finalize the unit test report: fills in coverage data, computes summary " +
    "(total/passed/failed/error/skip/pass_rate), and validates against the " +
    "UnitTestReport Zod schema. Call this after all cases and results have been added.",
  args: {
    coverage_statement: tool.schema
      .number()
      .optional()
      .describe("Statement coverage percentage (0-100)"),
    coverage_branch: tool.schema
      .number()
      .optional()
      .describe("Branch coverage percentage (0-100)"),
    coverage_mc_dc: tool.schema
      .number()
      .optional()
      .describe("MC/DC coverage percentage (0-100)"),
    uncovered_functions: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("List of function names with no coverage"),
  },
  async execute({
    coverage_statement,
    coverage_branch,
    coverage_mc_dc,
    uncovered_functions,
  }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.UNIT_TESTS)

    return await withFileLock(filePath, () => {
      if (!existsSync(filePath)) {
        return JSON.stringify({
          error:
            "Report file not found. Call ut_report_create and add cases/results first.",
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
        statement: coverage_statement,
        branch: coverage_branch,
        mc_dc: coverage_mc_dc,
        uncovered_functions: uncovered_functions ?? [],
      }

      // Compute summary from results
      const results: any[] = report.results ?? []
      const passed = results.filter((r) => r.verdict === "pass").length
      const failed = results.filter((r) => r.verdict === "fail").length
      const errorCount = results.filter((r) => r.verdict === "error").length
      const skip = results.filter((r) => r.verdict === "skip").length
      const total = report.test_cases?.length ?? 0
      const passRate = total > 0 ? Math.round((passed / total) * 10000) / 100 : 0

      report.summary = {
        total_cases: total,
        passed,
        failed,
        error: errorCount,
        skip,
        pass_rate: passRate,
      }

      // Validate with Zod
      const result = UnitTestReport.safeParse(report)
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
        file: ARTIFACT_PATHS.UNIT_TESTS,
        summary: result.data.summary,
        coverage: result.data.coverage,
        message: `Finalized report: ${total} cases, ${passed} passed, ${failed} failed, pass rate ${passRate}%.`,
      })
    })
  },
})
