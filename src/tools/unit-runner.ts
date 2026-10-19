import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync } from "fs"

/**
 * unit_runner — Compile and run unit tests using Unity/CUnit/Google Test.
 * Used by: UnitTester
 *
 * Currently a mock that simulates test execution.
 * TODO: Integrate real test runners (Unity, CUnit, GTest).
 */
export const unitRunner: ToolDefinition = tool({
  description:
    "Compile and run unit tests for C/C++ functions. Supports Unity, CUnit, and Google Test " +
    "frameworks. Returns test results with pass/fail status for each test case.",
  args: {
    test_file: tool.schema.string().describe("Path to the test source file"),
    source_files: tool.schema
      .array(tool.schema.string())
      .describe("Paths to source files under test"),
    framework: tool.schema
      .enum(["unity", "cunit", "gtest"])
      .optional()
      .describe("Unit test framework (default: unity)"),
    build_flags: tool.schema
      .string()
      .optional()
      .describe("Additional compiler flags"),
  },
  async execute({ test_file, source_files, framework = "unity", build_flags }) {
    // Validate files exist
    if (!existsSync(test_file)) {
      return JSON.stringify({ error: `Test file not found: ${test_file}` })
    }
    for (const src of source_files) {
      if (!existsSync(src)) {
        return JSON.stringify({ error: `Source file not found: ${src}` })
      }
    }

    // Mock execution — in real implementation, this would:
    // 1. Compile test + source with appropriate framework
    // 2. Run the compiled test binary
    // 3. Parse framework-specific output (Unity: TEST(), CUnit: CU_*, GTest: TEST_F())
    return JSON.stringify({
      test_file,
      source_files,
      framework,
      build_flags: build_flags || "",
      status: "mock_execution",
      message:
        "Unit runner mock: In production, this would compile and run the test. " +
        "Please provide the actual test execution results for the agent to process. " +
        "The agent should generate test driver code, and the user/CI should execute it.",
      results: [],
      note: "Replace with real test runner integration (e.g., Unity test_runner.rb, ctest, gtest XML output)",
    }, null, 2)
  },
})
