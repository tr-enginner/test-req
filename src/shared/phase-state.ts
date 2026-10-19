import { execSync } from "child_process"
import { existsSync, mkdirSync, readdirSync } from "fs"
import { join } from "path"
import { z } from "zod"
import {
  PHASE_IDS,
  PHASE_NAMES,
  PHASE_DEPS,
  REVIEW_REQUIRED_PHASES,
  type PhaseId,
} from "./constants"

/** Phase status */
export const PhaseStatus = z.enum([
  "pending",
  "in_progress",
  "review_pending",
  "review_in_progress",
  "revision_needed",
  "publishing",
  "completed",
  "failed",
  "skipped",
])
export type PhaseStatus = z.infer<typeof PhaseStatus>

/** Single phase state */
export const PhaseState = z.object({
  phase: z.string(),
  name: z.string(),
  status: PhaseStatus,
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  review_count: z.number().default(0),
  failure_count: z.number().default(0),
  artifacts: z.array(z.string()).default([]),
  notes: z.string().optional(),
})
export type PhaseState = z.infer<typeof PhaseState>

/** Overall progress state — DAG-based, no linear cursor */
export const ProgressState = z.object({
  project_name: z.string(),
  task_type: z.enum(["new_project", "regression", "focused", "review_fix"]),
  target_phases: z.array(z.string()),
  active_phases: z.array(z.string()),
  phases: z.record(z.string(), PhaseState),
  started_at: z.string(),
  updated_at: z.string(),
})
export type ProgressState = z.infer<typeof ProgressState>

/** Compute transitive dependency closure for target phases */
export function resolveActivePhases(targets: PhaseId[]): PhaseId[] {
  const active = new Set<PhaseId>()
  const stack = [...targets]
  while (stack.length > 0) {
    const phase = stack.pop()!
    if (active.has(phase)) continue
    active.add(phase)
    const deps = PHASE_DEPS[phase]
    if (deps) {
      for (const dep of deps) {
        if (!active.has(dep)) stack.push(dep)
      }
    }
  }
  return PHASE_IDS.filter((id) => active.has(id))
}

/** Create initial progress state */
/**
 * Code-level detection of a pre-existing soft platform.
 * Recognizes BOTH locations:
 *   1. `.matrix/data/DTPProject/` already provisioned (with V1/ or 组合关键字/)
 *   2. A project-root directory whose name contains "软平台"
 * Returns the directory path (relative to projectDir) if found, null otherwise.
 * This replaces unreliable LLM-based glob/bash detection.
 */
export function detectSoftPlatform(projectDir: string): string | null {
  try {
    if (!existsSync(projectDir)) return null
    // 已就绪的 DTPProject（会话恢复时不再依赖根目录 *软平台* 的存在）
    const dtpProject = join(projectDir, ".matrix", "data", "DTPProject")
    if (existsSync(join(dtpProject, "V1")) || existsSync(join(dtpProject, "组合关键字"))) {
      return ".matrix/data/DTPProject"
    }
    const entries = readdirSync(projectDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.includes("软平台")) {
        return entry.name
      }
    }
  } catch { /* ignore read errors */ }
  return null
}

/**
 * Provision DTPProject from a soft platform directory.
 * Creates .matrix/data/DTPProject/ and copies all contents from the soft platform.
 */
export function provisionSoftPlatform(projectDir: string, softPlatformDir: string): boolean {
  try {
    const src = join(projectDir, softPlatformDir)
    const dst = join(projectDir, ".matrix", "data", "DTPProject")
    if (!existsSync(src)) return false
    // detectSoftPlatform 可能直接返回已就绪的 DTPProject 路径，此时无需复制
    if (src === dst) {
      return existsSync(join(dst, "V1")) || existsSync(join(dst, "组合关键字"))
    }
    mkdirSync(dst, { recursive: true })
    // Use shell cp for cross-platform compatibility with recursive copy
    execSync(`cp -r "${src}"/. "${dst}"/ 2>/dev/null || cp -r "${src}"/* "${dst}"/`, { stdio: "ignore" })
    return existsSync(join(dst, "V1")) || existsSync(join(dst, "组合关键字"))
  } catch {
    return false
  }
}

export function createInitialProgress(
  projectName: string,
  taskType: ProgressState["task_type"] = "new_project",
  targets: PhaseId[] = ["8"],
  projectDir?: string,
): ProgressState {
  const now = new Date().toISOString()
  const activePhases = resolveActivePhases(targets)

  // Code-level soft platform detection — runs automatically, no LLM involvement
  let phase5PreCompleted = false
  if (projectDir && activePhases.includes("5")) {
    const softPlatform = detectSoftPlatform(projectDir)
    if (softPlatform) {
      const provisioned = provisionSoftPlatform(projectDir, softPlatform)
      if (provisioned) {
        phase5PreCompleted = true
        console.log(`[Matrix] 检测到已有软平台环境 "${softPlatform}"，Phase 5 自动跳过，DTPProject 已就绪`)
      }
    }
  }

  const phases: Record<string, PhaseState> = {}
  for (const id of PHASE_IDS) {
    const isActive = activePhases.includes(id)
    phases[id] = {
      phase: id,
      name: PHASE_NAMES[id],
      status: phase5PreCompleted && id === "5" ? "completed"
        : isActive ? "pending" : "skipped",
      review_count: 0,
      failure_count: 0,
      artifacts: phase5PreCompleted && id === "5" ? ["DTPProject/"] : [],
    }
  }

  return {
    project_name: projectName,
    task_type: taskType,
    target_phases: targets,
    active_phases: activePhases,
    phases,
    started_at: now,
    updated_at: now,
  }
}

/** Check if a phase can start: is active, is pending, and all deps are completed */
export function canStartPhase(progress: ProgressState, phase: PhaseId): boolean {
  if (!progress.active_phases.includes(phase)) return false

  const phaseState = progress.phases[phase]
  if (!phaseState || phaseState.status !== "pending") return false

  const deps = PHASE_DEPS[phase]
  if (!deps) return true

  return deps.every((dep) => {
    const depState = progress.phases[dep]
    return depState?.status === "completed" || depState?.status === "skipped"
  })
}

/** Get all phases that are ready to start */
export function getReadyPhases(progress: ProgressState): PhaseId[] {
  return PHASE_IDS.filter((id) => canStartPhase(progress, id))
}

/** Check if all target phases are completed */
export function isWorkflowComplete(progress: ProgressState): boolean {
  return progress.target_phases.every((target) => {
    const state = progress.phases[target]
    return state?.status === "completed"
  })
}

/** Mark a phase as started (in_progress) */
export function markPhaseStarted(progress: ProgressState, phase: PhaseId): ProgressState {
  const now = new Date().toISOString()
  return {
    ...progress,
    phases: {
      ...progress.phases,
      [phase]: {
        ...progress.phases[phase],
        status: "in_progress" as const,
        started_at: now,
      },
    },
    updated_at: now,
  }
}

/** Mark a phase as completed */
export function markPhaseCompleted(progress: ProgressState, phase: PhaseId): ProgressState {
  const now = new Date().toISOString()
  return {
    ...progress,
    phases: {
      ...progress.phases,
      [phase]: {
        ...progress.phases[phase],
        status: "completed" as const,
        completed_at: now,
      },
    },
    updated_at: now,
  }
}

/** Mark a phase as needing revision (after failed review) */
export function markRevisionNeeded(progress: ProgressState, phase: PhaseId): ProgressState {
  const now = new Date().toISOString()
  const phaseState = progress.phases[phase]
  return {
    ...progress,
    phases: {
      ...progress.phases,
      [phase]: {
        ...phaseState,
        status: "revision_needed" as const,
        review_count: (phaseState?.review_count ?? 0) + 1,
      },
    },
    updated_at: now,
  }
}

/** Mark a phase as publishing (review passed, formal outputs being published) */
export function markPhasePublishing(progress: ProgressState, phase: PhaseId): ProgressState {
  const now = new Date().toISOString()
  return {
    ...progress,
    phases: {
      ...progress.phases,
      [phase]: {
        ...progress.phases[phase],
        status: "publishing" as const,
      },
    },
    updated_at: now,
  }
}

/** Record a failure in a phase */
export function recordPhaseFailure(progress: ProgressState, phase: PhaseId): ProgressState {
  const now = new Date().toISOString()
  const phaseState = progress.phases[phase]
  return {
    ...progress,
    phases: {
      ...progress.phases,
      [phase]: {
        ...phaseState,
        failure_count: (phaseState?.failure_count ?? 0) + 1,
      },
    },
    updated_at: now,
  }
}
