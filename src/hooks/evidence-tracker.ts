import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { ARTIFACT_PATHS, type PhaseId } from "../shared/constants"
import type { ProgressState } from "../shared/phase-state"
import { withFileLock } from "../shared/file-mutex"

/**
 * evidence-tracker hook — Tracks artifact production as evidence chain.
 * Records which artifacts were produced at each phase for audit trail.
 */
export function createEvidenceTrackerHook(directory: string) {
  return {
    "tool.execute.after": async (
      input: { tool: string; sessionID: string },
      output: { title: string; output: string; metadata: any },
    ) => {
      // Only track file write operations to .matrix/
      if (input.tool !== "write" && input.tool !== "edit") return

      // Check if output references .matrix/ paths
      const matrixPathMatch = output.output.match(/\.matrix\/\S+/)
      if (!matrixPathMatch) return

      const artifactPath = matrixPathMatch[0]
      const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)

      if (!existsSync(progressPath)) return

      try {
        await withFileLock(progressPath, () => {
          const raw = readFileSync(progressPath, "utf-8")
          const progress: ProgressState = JSON.parse(raw)

          // Detect phase from artifact path, using progress state for cross-phase artifacts
          const phase = detectPhaseForArtifact(artifactPath, progress)
          const phaseState = phase ? progress.phases[phase] : null

          if (phaseState && !phaseState.artifacts.includes(artifactPath)) {
            phaseState.artifacts.push(artifactPath)
            progress.updated_at = new Date().toISOString()

            const dir = dirname(progressPath)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf-8")
          }
        })
      } catch {
        // Silently ignore
      }
    },
  }
}

/** Artifacts that can be written by multiple phases — resolved from progress state */
const CROSS_PHASE_ARTIFACTS = ["defects", "false-positives"] as const

function detectPhaseForArtifact(path: string, progress?: ProgressState): PhaseId | null {
  if (path.includes("software-analysis")) return "1"
  if (path.includes("test-requirements")) return "2"
  if (CROSS_PHASE_ARTIFACTS.some((a) => path.includes(a))) {
    // Resolve to whichever of phases 3, 4, 6, 7 is currently in_progress
    if (progress) {
      const candidatePhases: PhaseId[] = ["3", "4", "6", "7"]
      for (const p of candidatePhases) {
        if (progress.phases[p]?.status === "in_progress") return p
      }
    }
    return "3" // fallback for evidence tracking when no progress context
  }
  if (path.includes("review-records") || path.includes("code-review") || path.includes("static-analysis") || path.includes("interrupt-review")) return "3"
  if (path.includes("unit-test")) return "4"
  if (path.includes("test-env")) return "5"
  if (path.includes("phase6-execution-loop") || path.includes("test-cases-todo")) return "6"
  if (path.includes("confirmation-test") || path.includes("test-cases")) return "6"
  if (path.includes("test-execution")) {
    if (progress?.phases["6"]?.status === "publishing") return "6"
    return "7"
  }
  if (path.includes("test-summary")) return "8"
  return null
}
