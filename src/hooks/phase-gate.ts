import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { ARTIFACT_PATHS, PHASE_DEPS, PHASE_NAMES, type PhaseId } from "../shared/constants"
import type { ProgressState } from "../shared/phase-state"

/** Artifacts that can be written by multiple phases - exempt from single-phase gating */
const CROSS_PHASE_ARTIFACTS = ["defects", "false-positives"] as const

/**
 * phase-gate hook - prevents agents from writing artifacts for phases
 * that are not active or whose dependencies are not met.
 */
export function createPhaseGateHook(directory: string) {
  return {
    "tool.execute.after": async (
      input: { tool: string; sessionID: string },
      output: { title: string; output: string; metadata: any },
    ) => {
      const writtenArtifactPaths = extractWrittenArtifactPaths(input.tool, output.output)
      if (writtenArtifactPaths.length === 0) return

      const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)
      if (!existsSync(progressPath)) return

      try {
        const raw = readFileSync(progressPath, "utf-8")
        const progress: ProgressState = JSON.parse(raw)

        const phaseForArtifact = detectPhaseForArtifacts(writtenArtifactPaths, progress)
        if (phaseForArtifact === null) return
        if (shouldIgnorePlaceholderProgress(progress, phaseForArtifact)) return

        if (!progress.active_phases.includes(phaseForArtifact)) {
          output.output =
            `[PHASE GATE] Blocked: Phase ${phaseForArtifact} ` +
            `(${PHASE_NAMES[phaseForArtifact] || "unknown"}) ` +
            `is not in the active phase set for this workflow.`
          output.metadata = { ...output.metadata, phase_gate_blocked: true }
          return
        }

        const deps = PHASE_DEPS[phaseForArtifact]
        if (deps) {
          for (const dep of deps) {
            const depState = progress.phases[dep]
            if (!depState || depState.status !== "completed") {
              output.output =
                `[PHASE GATE] Blocked: Cannot write artifacts for phase ${phaseForArtifact} ` +
                `(${PHASE_NAMES[phaseForArtifact] || "unknown"}) - ` +
                `dependency phase ${dep} (${PHASE_NAMES[dep] || "unknown"}) ` +
                `is not completed (status: ${depState?.status || "missing"}).`
              output.metadata = { ...output.metadata, phase_gate_blocked: true }
              return
            }
          }
        }
      } catch {
        // Silently ignore parse errors.
      }
    },
  }
}

function shouldIgnorePlaceholderProgress(progress: ProgressState, phaseForArtifact: PhaseId): boolean {
  if (phaseForArtifact !== "2") return false
  if (progress.project_name !== "unknown") return false
  if (progress.task_type !== "new_project") return false
  if (progress.target_phases.length !== 1 || progress.target_phases[0] !== "8") return false
  if (progress.active_phases.join(",") !== "0,1,2,3,4,6,8") return false

  return Object.entries(progress.phases).every(([phaseId, phase]) => {
    if (phaseId === "1b") return phase.status === "skipped"
    return (
      phase.status === "pending" &&
      !phase.started_at &&
      !phase.completed_at &&
      (phase.review_count ?? 0) === 0 &&
      (phase.failure_count ?? 0) === 0 &&
      (phase.artifacts?.length ?? 0) === 0 &&
      !phase.notes
    )
  })
}

function extractWrittenArtifactPaths(toolName: string, rawOutput: string): string[] {
  const paths = new Set<string>()

  const addPath = (value: unknown) => {
    if (typeof value !== "string") return
    const normalized = value.replace(/\\/g, "/")
    if (!normalized.includes(".matrix/data/")) return
    paths.add(normalized)
  }

  try {
    const parsed = JSON.parse(rawOutput) as unknown
    collectWrittenPaths(parsed, addPath)
  } catch {
    // Ignore non-JSON outputs and fall back to write-tool text parsing below.
  }

  if (toolName === "write") {
    const normalized = rawOutput.replace(/\\/g, "/")
    const filePathMatch = normalized.match(/(?:wrote|created|saved)\s+(?:to\s+)?([^\s]+\.json)/i)
    if (filePathMatch?.[1]) addPath(filePathMatch[1])
  }

  return Array.from(paths)
}

function collectWrittenPaths(
  node: unknown,
  addPath: (value: unknown) => void,
  insideOutput = false,
): void {
  if (!node || typeof node !== "object") return

  if (Array.isArray(node)) {
    for (const item of node) collectWrittenPaths(item, addPath, insideOutput)
    return
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const isOutputKey = key === "output"
    const topLevelWritablePathKey =
      !insideOutput &&
      [
        "output_file",
        "output_path",
        "phase6_execution_loop_file",
        "test_execution_file",
        "todo_file",
        "filldata_path",
        "semantic_path",
        "req_segments_path",
        "req_segments_toc_path",
      ].includes(key)

    if (insideOutput || topLevelWritablePathKey) {
      addPath(value)
    }

    if (isOutputKey) {
      collectWrittenPaths(value, addPath, true)
      continue
    }

    if (value && typeof value === "object") {
      collectWrittenPaths(value, addPath, insideOutput)
    }
  }
}

function detectPhaseForArtifacts(paths: string[], progress: ProgressState): PhaseId | null {
  for (const path of paths) {
    const phase = detectPhaseForArtifact(path, progress)
    if (phase !== null) return phase
  }
  return null
}

/**
 * Detect which phase an artifact belongs to.
 *
 * Cross-phase artifacts can be written by phases 3, 4, or 7.
 * We resolve them to whichever of those phases is currently in_progress.
 * If none is in_progress, we allow them through rather than blocking.
 */
function detectPhaseForArtifact(path: string, progress: ProgressState): PhaseId | null {
  if (path.includes("software-analysis")) return "1"
  if (path.includes("test-requirements")) return "2"
  if (CROSS_PHASE_ARTIFACTS.some((artifact) => path.includes(artifact))) {
    const candidatePhases: PhaseId[] = ["3", "4", "7"]
    for (const phase of candidatePhases) {
      if (progress.phases[phase]?.status === "in_progress") return phase
    }
    return null
  }
  if (path.includes("unit-tests")) return "4"
  if (path.includes("phase6-execution-loop") || path.includes("test-cases-todo")) return "6"
  if (path.includes("confirmation-tests")) return "6"
  if (path.includes("test-execution")) {
    if (
      progress.phases["6"]?.status === "publishing" ||
      (progress.active_phases.includes("6") && !progress.active_phases.includes("7"))
    ) {
      return "6"
    }
    return "7"
  }
  if (path.includes("test-summary")) return "8"
  return null
}
