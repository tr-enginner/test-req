import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { ARTIFACT_PATHS } from "../shared/constants"
import { buildTraceabilityMatrix, calculateCoverageStats } from "../shared/traceability"
import { SoftwareAnalysisReport } from "../schema/sut"
import { TestRequirementsArtifact } from "../schema/test-requirement"
import { TranslatedConfirmationTestSuite } from "../schema/confirmation-test-case"
import { UnitTestReport } from "../schema/unit-test-case"
import { TestExecutionReport } from "../schema/test-execution"
import { DefectDatabase } from "../schema/defect"
import { loadData } from "../shared/data-store"

/**
 * traceability-injector hook — Injects requirement traceability matrix into system prompt.
 * Ensures all agents have access to the current traceability state.
 */
export function createTraceabilityInjectorHook(directory: string) {
  return {
    "experimental.chat.system.transform": async (
      input: { sessionID: string },
      output: { system: string[] },
    ) => {
      try {
        // Load all available data
        const analysis = loadData(
          SoftwareAnalysisReport,
          join(directory, ARTIFACT_PATHS.SOFTWARE_ANALYSIS),
        )
        if (!analysis) return // No analysis yet, nothing to inject

        const testReqs = loadData(
          TestRequirementsArtifact,
          join(directory, ARTIFACT_PATHS.TEST_REQUIREMENTS),
        )
        const unitTests = loadData(
          UnitTestReport,
          join(directory, ARTIFACT_PATHS.UNIT_TESTS),
        )
        const confirmTests = loadData(
          TranslatedConfirmationTestSuite,
          join(directory, ARTIFACT_PATHS.CONFIRMATION_TESTS),
        )
        const execution = loadData(
          TestExecutionReport,
          join(directory, ARTIFACT_PATHS.TEST_EXECUTION),
        )
        const defects = loadData(
          DefectDatabase,
          join(directory, ARTIFACT_PATHS.DEFECTS),
        )

        const matrix = buildTraceabilityMatrix({
          analysis,
          testReqs,
          unitTests,
          confirmationTests: confirmTests,
          testExecution: execution,
          defects,
        })

        if (matrix.length === 0) return

        const stats = calculateCoverageStats(matrix)

        // Build compact traceability summary
        let traceText = `<traceability-matrix>\n`
        traceText += `## Current Traceability Status\n`
        traceText += `- Total Requirements: ${stats.total_requirements}\n`
        traceText += `- Fully Covered: ${stats.fully_covered}\n`
        traceText += `- Partially Covered: ${stats.partially_covered}\n`
        traceText += `- Not Covered: ${stats.not_covered}\n`
        traceText += `- Coverage: ${stats.coverage_pct}%\n\n`

        // Only inject uncovered/partial items to save context
        const uncovered = matrix.filter(
          (e) => e.coverage_status === "none" || e.coverage_status === "partial",
        )
        if (uncovered.length > 0) {
          traceText += `### Uncovered/Partial Requirements:\n`
          for (const entry of uncovered.slice(0, 20)) {
            traceText += `- ${entry.software_req_id} (${entry.software_req_title}): `
            traceText += `TRs=[${entry.test_req_ids.join(",")}] `
            traceText += `UTs=[${entry.unit_test_ids.join(",")}] `
            traceText += `CTs=[${entry.confirmation_test_ids.join(",")}] `
            traceText += `[${entry.coverage_status}]\n`
          }
          if (uncovered.length > 20) {
            traceText += `... and ${uncovered.length - 20} more\n`
          }
        }

        traceText += `</traceability-matrix>`

        output.system.push(traceText)
      } catch {
        // Silently ignore errors — traceability is advisory
      }
    },
  }
}
