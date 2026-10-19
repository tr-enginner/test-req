import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { ARTIFACT_PATHS, type PhaseId } from "../shared/constants"
import type { ProgressState } from "../shared/phase-state"

/** Map of phases to their upstream data dependencies */
const PHASE_DATA_DEPS: Record<string, string[]> = {
  "2": [],
  "3": [ARTIFACT_PATHS.SOFTWARE_ANALYSIS, ARTIFACT_PATHS.COMPILATION_ENV],
  "4": [ARTIFACT_PATHS.SOFTWARE_ANALYSIS, ARTIFACT_PATHS.TEST_REQUIREMENTS],
  "5": [ARTIFACT_PATHS.SOFTWARE_ANALYSIS, ARTIFACT_PATHS.TEST_REQUIREMENTS],
  "6": [ARTIFACT_PATHS.TEST_REQUIREMENTS],
  "7": [ARTIFACT_PATHS.CONFIRMATION_TESTS, ARTIFACT_PATHS.UNIT_TESTS],
  "8": [
    ARTIFACT_PATHS.SOFTWARE_ANALYSIS,
    ARTIFACT_PATHS.TEST_REQUIREMENTS,
    ARTIFACT_PATHS.DEFECTS,
    ARTIFACT_PATHS.UNIT_TESTS,
    ARTIFACT_PATHS.CONFIRMATION_TESTS,
    ARTIFACT_PATHS.TEST_EXECUTION,
  ],
}

/**
 * context-preloader hook — Automatically injects relevant upstream artifacts
 * into the system prompt based on the current phase.
 */
export function createContextPreloaderHook(directory: string) {
  return {
    "chat.message": async (
      input: { sessionID: string; agent?: string },
      output: { message: any; parts: any[] },
    ) => {
      const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)
      if (!existsSync(progressPath)) return

      try {
        const raw = readFileSync(progressPath, "utf-8")
        const progress: ProgressState = JSON.parse(raw)

        // Collect deps for all in_progress phases
        const allDeps = new Set<string>()
        for (const [phaseId, phase] of Object.entries(progress.phases)) {
          if (phase.status === "in_progress" || phase.status === "review_pending") {
            const deps = PHASE_DATA_DEPS[phaseId]
            if (deps) deps.forEach((d: string) => allDeps.add(d))
          }
        }
        if (allDeps.size === 0) return

        // Build context summary from upstream data
        const contextParts: string[] = []
        for (const dep of allDeps) {
          const filePath = join(directory, dep)
          if (existsSync(filePath)) {
            const data = readFileSync(filePath, "utf-8")
            try {
              const parsed = JSON.parse(data)
              // Include summary-level data, not full content
              const summary = extractSummary(dep, parsed)
              if (summary) contextParts.push(summary)
            } catch {
              // Skip invalid JSON
            }
          }
        }

        if (contextParts.length > 0) {
          const contextMsg =
            `<upstream-context>\n` +
            `## Upstream Data Summary (auto-loaded for current phase)\n\n` +
            contextParts.join("\n\n") +
            `\n</upstream-context>`

          output.parts = [
            { type: "text", text: contextMsg },
            ...output.parts,
          ]
        }
      } catch {
        // Silently ignore
      }
    },
  }
}

function extractSummary(path: string, data: any): string | null {
  if (path.includes("software-analysis") && data.summary) {
    return (
      `### Software Analysis Summary\n` +
      `- Requirements: ${data.summary.total_requirements}\n` +
      `- Functions: ${data.summary.total_functions}\n` +
      `- LOC: ${data.summary.total_loc}\n` +
      `- Safety-Critical: ${data.summary.safety_critical_functions}\n` +
      `- Interfaces: ${data.summary.total_interfaces}`
    )
  }
  if (path.includes("test-requirements") && data.summary) {
    return (
      `### Test Requirements Summary\n` +
      `- Total: ${data.summary.total}\n` +
      `- Testable: ${data.summary.testable_count}\n` +
      `- Not Testable: ${data.summary.not_testable_count}`
    )
  }
  if (path.includes("defects") && data.summary) {
    return (
      `### Defect Summary\n` +
      `- Total: ${data.summary.total}\n` +
      `- Open Critical: ${data.summary.open_critical}`
    )
  }
  if (path.includes("unit-tests") && data.summary) {
    return (
      `### Unit Test Summary\n` +
      `- Cases: ${data.summary.total_cases}\n` +
      `- Pass Rate: ${data.summary.pass_rate}%`
    )
  }
  if (path.includes("confirmation-tests") && data.summary) {
    return (
      `### Confirmation Test Cases\n` +
      `- Total: ${data.summary.total_cases}`
    )
  }
  if (path.includes("test-execution") && data.summary) {
    return (
      `### Test Execution Summary\n` +
      `- Executed: ${data.summary.total_executed}\n` +
      `- Pass Rate: ${data.summary.pass_rate}%`
    )
  }
  if (path.includes("compilation-env") && data) {
    return (
      `### Compilation Environment\n` +
      `- Build System: ${data.build_system || "none"}\n` +
      `- Compiler Dialect: ${data.compiler_dialect || "unknown"}\n` +
      `- Files Indexed: ${data.files_indexed || 0}\n` +
      `- Missing Headers: ${data.missing_headers?.length || 0} (stubs generated)\n` +
      `- Preprocessed: ${data.preprocessed_dir ? "yes" : "no"}`
    )
  }
  return null
}
