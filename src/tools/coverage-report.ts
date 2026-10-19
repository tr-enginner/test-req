import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "fs"

/**
 * coverage_report — Collect and analyze code coverage data (gcov/lcov).
 * Used by: UnitTester, TestExecutor
 *
 * Currently a mock that parses lcov-style data or returns placeholder results.
 * TODO: Integrate gcov/lcov/bullseye coverage tools.
 */
export const coverageReport: ToolDefinition = tool({
  description:
    "Collect and analyze code coverage data. Reads gcov/lcov output files and " +
    "generates coverage reports with statement, branch, and MC/DC metrics.",
  args: {
    coverage_file: tool.schema
      .string()
      .optional()
      .describe("Path to lcov.info or gcov output file"),
    source_dir: tool.schema
      .string()
      .optional()
      .describe("Source directory to measure coverage against"),
    coverage_type: tool.schema
      .enum(["statement", "branch", "mc_dc"])
      .optional()
      .describe("Type of coverage to measure (default: statement)"),
  },
  async execute({ coverage_file, source_dir, coverage_type = "statement" }) {
    // If coverage file provided, try to parse it
    if (coverage_file && existsSync(coverage_file)) {
      const content = readFileSync(coverage_file, "utf-8")
      return parseLcovData(content, coverage_type)
    }

    // Mock response when no real coverage data
    return JSON.stringify({
      status: "mock_coverage",
      coverage_type,
      source_dir: source_dir || "unknown",
      message:
        "Coverage report mock: In production, this would parse gcov/lcov data. " +
        "Run your tests with coverage flags (e.g., gcc -fprofile-arcs -ftest-coverage) " +
        "then provide the coverage data file path.",
      metrics: {
        statement: null,
        branch: null,
        mc_dc: null,
      },
      uncovered_functions: [],
      note: "Replace with real coverage tool integration",
    }, null, 2)
  },
})

function parseLcovData(content: string, coverageType: string): string {
  const lines = content.split("\n")
  let totalLines = 0
  let hitLines = 0
  let totalBranches = 0
  let hitBranches = 0
  const uncoveredFunctions: string[] = []

  for (const line of lines) {
    if (line.startsWith("LH:")) hitLines = parseInt(line.slice(3))
    if (line.startsWith("LF:")) totalLines = parseInt(line.slice(3))
    if (line.startsWith("BRH:")) hitBranches = parseInt(line.slice(4))
    if (line.startsWith("BRF:")) totalBranches = parseInt(line.slice(4))
    if (line.startsWith("FNDA:0,")) {
      uncoveredFunctions.push(line.slice(7))
    }
  }

  const statementPct = totalLines > 0 ? Math.round((hitLines / totalLines) * 100) : 0
  const branchPct = totalBranches > 0 ? Math.round((hitBranches / totalBranches) * 100) : 0

  return JSON.stringify({
    status: "parsed",
    coverage_type: coverageType,
    metrics: {
      statement: statementPct,
      branch: branchPct,
      mc_dc: null,
      lines_total: totalLines,
      lines_hit: hitLines,
      branches_total: totalBranches,
      branches_hit: hitBranches,
    },
    uncovered_functions: uncoveredFunctions,
  }, null, 2)
}
