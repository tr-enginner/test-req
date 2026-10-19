import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { ARTIFACT_PATHS, type PhaseId } from "../shared/constants"
import { ProgressState, detectSoftPlatform, provisionSoftPlatform } from "../shared/phase-state"
import { withFileLock } from "../shared/file-mutex"

/**
 * progress-tracker hook — Tracks overall test progress and maintains phase state machine.
 * Listens to events and updates .matrix/state/progress.json.
 */
function runSoftPlatformDetection(directory: string): void {
  const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)
  if (!existsSync(progressPath)) return
  try {
    const raw = readFileSync(progressPath, "utf-8")
    const progress: ProgressState = JSON.parse(raw)
    const phase5 = progress.phases["5"]
    if (phase5 && (phase5.status === "pending" || phase5.status === "in_progress")) {
      const softPlatform = detectSoftPlatform(directory)
      if (softPlatform) {
        const provisioned = provisionSoftPlatform(directory, softPlatform)
        if (provisioned) {
          phase5.status = "completed"
          if (!phase5.artifacts) phase5.artifacts = []
          if (!phase5.artifacts.includes("DTPProject/")) phase5.artifacts.push("DTPProject/")
          phase5.completed_at = new Date().toISOString()
          progress.updated_at = new Date().toISOString()
          writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf-8")
        }
      }
    }
  } catch { /* ignore */ }
}

export function createProgressTrackerHook(directory: string) {
  // Run detection immediately on hook creation — before any tool executes
  runSoftPlatformDetection(directory)

  return {
    event: async (input: { event: any }) => {
      const { event } = input
      if (!event) return
      // Run detection on every event as well, ensuring timeliness
      runSoftPlatformDetection(directory)
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string },
      output: { title: string; output: string; metadata: any },
    ) => {
      // Run detection on every tool execution (keep as fallback)
      runSoftPlatformDetection(directory)

      const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)
      if (!existsSync(progressPath)) return

      try {
        await withFileLock(progressPath, () => {
          const raw = readFileSync(progressPath, "utf-8")
          const progress: ProgressState = JSON.parse(raw)

          // Soft platform detection already handled by runSoftPlatformDetection()
          // at the top of this handler (runs before withFileLock for early detection).

          let updated = false

          const outputNorm = output.output.replace(/\\/g, "/")
          const parsedOutput = parseToolOutput(output.output)

          // Auto-detect phase completion based on artifact creation
          const artifactPhaseMap: [string, PhaseId][] = [
            ["software-analysis.json", "1"],
            ["test-requirements.json", "2"],
            ["unit-tests.json", "4"],
            ["confirmation-tests.json", "6"],
            ["test-summary.json", "8"],
          ]

          for (const [artifact, phaseId] of artifactPhaseMap) {
            if (outputNorm.includes(artifact)) {
              const phase = progress.phases[phaseId]
              if (phase?.status === "in_progress" || phase?.status === "revision_needed") {
                // For review-required phases, mark as review_pending
                if (phaseId === "2" || phaseId === "6") {
                  phase.status = "review_pending"
                } else {
                  phase.status = "completed"
                  phase.completed_at = new Date().toISOString()
                }
                updated = true
              }
            }
          }

          if (outputNorm.includes("test-execution.json") && input.tool !== "phase6_execution_loop") {
            const phase = progress.phases["7"]
            if (phase?.status === "in_progress" && progress.active_phases.includes("7")) {
              phase.status = "completed"
              phase.completed_at = new Date().toISOString()
              updated = true
            }
          }

          const reviewPhase = detectReviewPhase(outputNorm)
          if (reviewPhase) {
            const verdict = loadReviewVerdict(directory, reviewPhase)
            if (verdict === "PASS") {
              const phase = progress.phases[reviewPhase]
              if (phase?.status === "review_pending" || phase?.status === "review_in_progress") {
                phase.review_count++
                if (reviewPhase === "6") {
                  phase.status = "publishing"
                } else {
                  phase.status = "completed"
                  phase.completed_at = new Date().toISOString()
                }
                updated = true
              }
            } else if (verdict === "REVISE") {
              const phase = progress.phases[reviewPhase]
              if (
                phase?.status === "review_pending" ||
                phase?.status === "review_in_progress" ||
                phase?.status === "in_progress"
              ) {
                phase.status = "revision_needed"
                phase.review_count++
                updated = true
              }
            }
          }

          if (
            input.tool === "phase6_publish_outputs" &&
            isSuccessfulPhase6Publish(parsedOutput)
          ) {
            const phase = progress.phases["6"]
            if (phase?.status === "publishing") {
              phase.notes = "Phase 6 formal outputs published; waiting for DTP execution loop gate."
              updated = true
            }
          }

          if (
            input.tool === "phase6_execution_loop" &&
            isSuccessfulPhase6ExecutionLoop(parsedOutput)
          ) {
            const phase = progress.phases["6"]
            if (phase?.status === "publishing" || phase?.status === "in_progress") {
              phase.status = "completed"
              phase.completed_at = new Date().toISOString()
              phase.notes = "Phase 6 DTP execution loop gate passed."
              updated = true
            }
          }

          if (updated) {
            progress.updated_at = new Date().toISOString()
            writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf-8")
          }
        })
      } catch {
        // Silently ignore
      }
    },
  }
}

function parseToolOutput(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function loadReviewVerdict(directory: string, reviewPhase: PhaseId): "PASS" | "REVISE" | null {
  const reviewPath = join(directory, getReviewArtifactPath(reviewPhase))
  if (!existsSync(reviewPath)) return null

  try {
    const raw = JSON.parse(readFileSync(reviewPath, "utf-8")) as { verdict?: unknown }
    return raw.verdict === "PASS" || raw.verdict === "REVISE" ? raw.verdict : null
  } catch {
    return null
  }
}

function getReviewArtifactPath(reviewPhase: PhaseId): string {
  switch (reviewPhase) {
    case "2":
      return ARTIFACT_PATHS.REQ_REVIEW
    case "5":
      return ARTIFACT_PATHS.ENV_REVIEW
    case "6":
      return ARTIFACT_PATHS.CASE_REVIEW
    default:
      return ARTIFACT_PATHS.CASE_REVIEW
  }
}

function isSuccessfulPhase6Publish(parsedOutput: unknown): boolean {
  if (!parsedOutput || typeof parsedOutput !== "object") return false

  const record = parsedOutput as {
    status?: unknown
    markdown_file?: unknown
    docx_file?: unknown
  }

  if (record.status !== "success") return false
  return typeof record.markdown_file === "string" && typeof record.docx_file === "string"
}

function isSuccessfulPhase6ExecutionLoop(parsedOutput: unknown): boolean {
  if (!parsedOutput || typeof parsedOutput !== "object") return false

  const record = parsedOutput as {
    status?: unknown
    gate_status?: unknown
    phase6_execution_loop_file?: unknown
  }

  return (
    record.status === "success" &&
    record.gate_status === "passed" &&
    typeof record.phase6_execution_loop_file === "string"
  )
}

/** Detect which phase a review result belongs to from its artifact path */
function detectReviewPhase(output: string): PhaseId | null {
  if (output.includes("req-review.json")) return "2"
  if (output.includes("cr-review.json")) return "3"
  if (output.includes("env-review.json")) return "5"
  if (output.includes("case-review.json")) return "6"
  return null
}
