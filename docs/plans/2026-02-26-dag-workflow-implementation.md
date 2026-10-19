# DAG Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the linear phase cursor with a dependency graph so phases 3/4/5/6 can run in parallel, and users can target specific phases without running the full pipeline.

**Architecture:** Add `PHASE_DEPS` dependency graph to constants. Rewrite `phase-state.ts` with `resolveActivePhases()`, `getReadyPhases()`, `isWorkflowComplete()`. Rewrite Conductor prompt with dependency-driven dispatch loop. Update all 7 hooks that reference `current_phase`.

**Tech Stack:** TypeScript, Zod, Bun test runner

---

### Task 1: Add Phase IDs and Dependency Graph to Constants

**Files:**
- Modify: `src/shared/constants.ts`

**Step 1: Add `PHASE_IDS` and `PhaseId` type**

Add after line 14 (`export type PhaseNumber = ...`):

```typescript
/** All phase identifiers including 1b */
export const PHASE_IDS = ["0", "1", "1b", "2", "3", "4", "5", "6", "7", "8"] as const
export type PhaseId = (typeof PHASE_IDS)[number]
```

**Step 2: Add `PHASE_DEPS` dependency graph**

Add after the new `PhaseId` type:

```typescript
/** Phase dependency graph — a phase can start only when ALL its deps are completed */
export const PHASE_DEPS: Record<PhaseId, PhaseId[]> = {
  "0": [],
  "1": ["0"],
  "1b": ["1"],
  "2": ["1b"],
  "3": ["2"],
  "4": ["2"],
  "5": ["2"],
  "6": ["2"],
  "7": ["5", "6"],
  "8": ["3", "4", "7"],
}
```

**Step 3: Add `PHASE_NAMES` and `PHASE_AGENTS` entries for Phase 1b**

Update `PHASE_NAMES` — change from `Record<PhaseNumber, string>` to `Record<PhaseId, string>` and add Phase 1b:

```typescript
export const PHASE_NAMES: Record<PhaseId, string> = {
  "0": "Task Classification",
  "1": "Software Analysis",
  "1b": "Code Wiki Generation",
  "2": "Test Requirements Analysis",
  "3": "Code Review & Static Analysis",
  "4": "Unit Testing",
  "5": "Test Environment Development",
  "6": "Confirmation Test Case Design",
  "7": "Test Execution",
  "8": "Test Summary",
}
```

Update `PHASE_AGENTS` similarly:

```typescript
export const PHASE_AGENTS: Record<PhaseId, string | string[]> = {
  "0": "conductor",
  "1": "analyst",
  "1b": "wiki-builder",
  "2": "req-architect",
  "3": ["inspector", "static-analyzer", "isr-reviewer"],
  "4": "unit-tester",
  "5": "env-architect",
  "6": "test-designer",
  "7": "test-executor",
  "8": "summarizer",
}
```

**Step 4: Update `REVIEW_REQUIRED_PHASES` to use `PhaseId`**

```typescript
export const REVIEW_REQUIRED_PHASES: PhaseId[] = ["2", "5", "6"]
```

Note: Phase 3 uses cr-reviewer internally (not in this list). Keep that behavior.

**Step 5: Commit**

```bash
git add src/shared/constants.ts
git commit -m "feat: add phase dependency graph and PhaseId type to constants"
```

---

### Task 2: Rewrite Phase State Module

**Files:**
- Modify: `src/shared/phase-state.ts`
- Create: `src/shared/__tests__/phase-state.test.ts`

**Step 1: Write tests for the new DAG functions**

Create `src/shared/__tests__/phase-state.test.ts`:

```typescript
import { describe, test, expect } from "bun:test"
import {
  resolveActivePhases,
  getReadyPhases,
  canStartPhase,
  isWorkflowComplete,
  createInitialProgress,
  markPhaseStarted,
  markPhaseCompleted,
} from "../phase-state"

describe("resolveActivePhases", () => {
  test("target phase 8 resolves to all phases", () => {
    const active = resolveActivePhases(["8"])
    expect(active).toContain("0")
    expect(active).toContain("1")
    expect(active).toContain("1b")
    expect(active).toContain("2")
    expect(active).toContain("3")
    expect(active).toContain("4")
    expect(active).toContain("5")
    expect(active).toContain("6")
    expect(active).toContain("7")
    expect(active).toContain("8")
    expect(active.length).toBe(10)
  })

  test("target phase 4 resolves to 0,1,1b,2,4", () => {
    const active = resolveActivePhases(["4"])
    expect(active.sort()).toEqual(["0", "1", "1b", "2", "4"].sort())
  })

  test("target phase 7 resolves to 0,1,1b,2,5,6,7", () => {
    const active = resolveActivePhases(["7"])
    expect(active.sort()).toEqual(["0", "1", "1b", "2", "5", "6", "7"].sort())
  })

  test("multiple targets merge dependencies", () => {
    const active = resolveActivePhases(["3", "4"])
    expect(active.sort()).toEqual(["0", "1", "1b", "2", "3", "4"].sort())
  })

  test("target phase 0 resolves to just phase 0", () => {
    const active = resolveActivePhases(["0"])
    expect(active).toEqual(["0"])
  })
})

describe("getReadyPhases", () => {
  test("initially only phase 0 is ready", () => {
    const progress = createInitialProgress("test", "new_project", ["8"])
    const ready = getReadyPhases(progress)
    expect(ready).toEqual(["0"])
  })

  test("after phase 0 completes, phase 1 is ready", () => {
    let progress = createInitialProgress("test", "new_project", ["8"])
    progress = markPhaseCompleted(progress, "0")
    const ready = getReadyPhases(progress)
    expect(ready).toEqual(["1"])
  })

  test("after phase 2 completes, phases 3,4,5,6 are all ready", () => {
    let progress = createInitialProgress("test", "new_project", ["8"])
    progress = markPhaseCompleted(progress, "0")
    progress = markPhaseCompleted(progress, "1")
    progress = markPhaseCompleted(progress, "1b")
    progress = markPhaseCompleted(progress, "2")
    const ready = getReadyPhases(progress)
    expect(ready.sort()).toEqual(["3", "4", "5", "6"].sort())
  })

  test("phase 7 is ready only when 5 and 6 are completed", () => {
    let progress = createInitialProgress("test", "new_project", ["8"])
    for (const p of ["0", "1", "1b", "2"] as const) {
      progress = markPhaseCompleted(progress, p)
    }
    // Complete only phase 5
    progress = markPhaseCompleted(progress, "5")
    let ready = getReadyPhases(progress)
    expect(ready).not.toContain("7")

    // Now complete phase 6 too
    progress = markPhaseCompleted(progress, "6")
    ready = getReadyPhases(progress)
    expect(ready).toContain("7")
  })

  test("phases not in active_phases are never ready", () => {
    // Target only phase 4 — phase 3 should never appear
    let progress = createInitialProgress("test", "new_project", ["4"])
    for (const p of ["0", "1", "1b", "2"] as const) {
      progress = markPhaseCompleted(progress, p)
    }
    const ready = getReadyPhases(progress)
    expect(ready).toEqual(["4"])
    expect(ready).not.toContain("3")
  })
})

describe("canStartPhase", () => {
  test("phase 0 can start immediately", () => {
    const progress = createInitialProgress("test", "new_project", ["8"])
    expect(canStartPhase(progress, "0")).toBe(true)
  })

  test("phase 1 cannot start before phase 0 completes", () => {
    const progress = createInitialProgress("test", "new_project", ["8"])
    expect(canStartPhase(progress, "1")).toBe(false)
  })

  test("phase not in active_phases cannot start", () => {
    const progress = createInitialProgress("test", "new_project", ["4"])
    expect(canStartPhase(progress, "3")).toBe(false)
  })
})

describe("isWorkflowComplete", () => {
  test("not complete when targets are pending", () => {
    const progress = createInitialProgress("test", "new_project", ["4"])
    expect(isWorkflowComplete(progress)).toBe(false)
  })

  test("complete when all targets are completed", () => {
    let progress = createInitialProgress("test", "new_project", ["4"])
    for (const p of ["0", "1", "1b", "2", "4"] as const) {
      progress = markPhaseCompleted(progress, p)
    }
    expect(isWorkflowComplete(progress)).toBe(true)
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/shared/__tests__/phase-state.test.ts
```

Expected: FAIL — new functions don't exist yet.

**Step 3: Rewrite `phase-state.ts` with DAG-based state model**

Replace the entire file:

```typescript
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
export function createInitialProgress(
  projectName: string,
  taskType: ProgressState["task_type"] = "new_project",
  targets: PhaseId[] = ["8"],
): ProgressState {
  const now = new Date().toISOString()
  const activePhases = resolveActivePhases(targets)

  const phases: Record<string, PhaseState> = {}
  for (const id of PHASE_IDS) {
    phases[id] = {
      phase: id,
      name: PHASE_NAMES[id],
      status: activePhases.includes(id) ? "pending" : "skipped",
      review_count: 0,
      failure_count: 0,
      artifacts: [],
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
    return depState?.status === "completed"
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
```

**Step 4: Run tests to verify they pass**

```bash
bun test src/shared/__tests__/phase-state.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/shared/phase-state.ts src/shared/__tests__/phase-state.test.ts
git commit -m "feat: rewrite phase-state with DAG-based scheduling

Replace linear current_phase cursor with dependency graph resolution.
New functions: resolveActivePhases, getReadyPhases, canStartPhase,
isWorkflowComplete. Remove advancePhase and canAdvancePhase."
```

---

### Task 3: Update Phase Gate Hook

**Files:**
- Modify: `src/hooks/phase-gate.ts`

**Step 1: Rewrite phase-gate to use dependency check**

Replace entire file:

```typescript
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { ARTIFACT_PATHS, PHASE_DEPS, PHASE_NAMES, type PhaseId } from "../shared/constants"
import type { ProgressState } from "../shared/phase-state"

/**
 * phase-gate hook — Prevents agents from writing artifacts for phases
 * that are not active or whose dependencies are not met.
 */
export function createPhaseGateHook(directory: string) {
  return {
    "tool.execute.after": async (
      input: { tool: string; sessionID: string },
      output: { title: string; output: string; metadata: any },
    ) => {
      if (!output.output.includes(".matrix/data/")) return

      const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)
      if (!existsSync(progressPath)) return

      try {
        const raw = readFileSync(progressPath, "utf-8")
        const progress: ProgressState = JSON.parse(raw)

        const phaseForArtifact = detectPhaseForArtifact(output.output)
        if (phaseForArtifact === null) return

        // Block if phase is not in active set
        if (!progress.active_phases.includes(phaseForArtifact)) {
          output.output =
            `[PHASE GATE] Blocked: Phase ${phaseForArtifact} ` +
            `(${PHASE_NAMES[phaseForArtifact] || "unknown"}) ` +
            `is not in the active phase set for this workflow.`
          output.metadata = { ...output.metadata, phase_gate_blocked: true }
          return
        }

        // Block if dependencies are not completed
        const deps = PHASE_DEPS[phaseForArtifact]
        if (deps) {
          for (const dep of deps) {
            const depState = progress.phases[dep]
            if (!depState || depState.status !== "completed") {
              output.output =
                `[PHASE GATE] Blocked: Cannot write artifacts for phase ${phaseForArtifact} ` +
                `(${PHASE_NAMES[phaseForArtifact] || "unknown"}) — ` +
                `dependency phase ${dep} (${PHASE_NAMES[dep] || "unknown"}) ` +
                `is not completed (status: ${depState?.status || "missing"}).`
              output.metadata = { ...output.metadata, phase_gate_blocked: true }
              return
            }
          }
        }
      } catch {
        // Silently ignore parse errors
      }
    },
  }
}

function detectPhaseForArtifact(output: string): PhaseId | null {
  if (output.includes("software-analysis")) return "1"
  if (output.includes("test-requirements")) return "2"
  if (output.includes("defects")) return "3" // Can be written in 3, 4, or 7
  if (output.includes("unit-tests")) return "4"
  if (output.includes("confirmation-tests")) return "6"
  if (output.includes("test-execution")) return "7"
  if (output.includes("test-summary")) return "8"
  return null
}
```

**Step 2: Commit**

```bash
git add src/hooks/phase-gate.ts
git commit -m "feat: update phase-gate hook to use dependency-based checks

Replace linear currentPhase+1 check with active_phases membership
and dependency completion verification."
```

---

### Task 4: Update Progress Tracker Hook

**Files:**
- Modify: `src/hooks/progress-tracker.ts`

**Step 1: Rewrite progress-tracker to remove `current_phase` references**

Replace entire file:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { ARTIFACT_PATHS, type PhaseId } from "../shared/constants"
import { ProgressState, createInitialProgress } from "../shared/phase-state"
import { withFileLock } from "../shared/file-mutex"

/**
 * progress-tracker hook — Tracks overall test progress and maintains phase state machine.
 * Listens to events and updates .matrix/state/progress.json.
 */
export function createProgressTrackerHook(directory: string) {
  return {
    event: async (input: { event: any }) => {
      const { event } = input
      if (!event) return

      const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)

      if (event.type === "session.created" || event.type === "session.started") {
        await withFileLock(progressPath, () => {
          if (!existsSync(progressPath)) {
            const dir = dirname(progressPath)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

            const initial = createInitialProgress("unknown")
            writeFileSync(progressPath, JSON.stringify(initial, null, 2), "utf-8")
          }
        })
      }
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string },
      output: { title: string; output: string; metadata: any },
    ) => {
      const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)
      if (!existsSync(progressPath)) return

      try {
        await withFileLock(progressPath, () => {
          const raw = readFileSync(progressPath, "utf-8")
          const progress: ProgressState = JSON.parse(raw)

          let updated = false
          const outputNorm = output.output.replace(/\\/g, "/")

          // Auto-detect phase completion based on artifact creation
          const artifactPhaseMap: [string, PhaseId][] = [
            ["software-analysis.json", "1"],
            ["test-requirements.json", "2"],
            ["unit-tests.json", "4"],
            ["confirmation-tests.json", "6"],
            ["test-execution.json", "7"],
            ["test-summary.json", "8"],
          ]

          for (const [artifact, phaseId] of artifactPhaseMap) {
            if (outputNorm.includes(artifact)) {
              const phase = progress.phases[phaseId]
              if (phase?.status === "in_progress") {
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

          // Handle review results — detect which phase from review artifact path
          if (outputNorm.includes("review") && outputNorm.includes("PASS")) {
            const reviewPhase = detectReviewPhase(outputNorm)
            if (reviewPhase) {
              const phase = progress.phases[reviewPhase]
              if (phase?.status === "review_pending" || phase?.status === "review_in_progress") {
                phase.status = "completed"
                phase.completed_at = new Date().toISOString()
                phase.review_count++
                updated = true
              }
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

/** Detect which phase a review result belongs to from its artifact path */
function detectReviewPhase(output: string): PhaseId | null {
  if (output.includes("req-review")) return "2"
  if (output.includes("cr-review")) return "3"
  if (output.includes("env-review")) return "5"
  if (output.includes("case-review")) return "6"
  return null
}
```

**Step 2: Commit**

```bash
git add src/hooks/progress-tracker.ts
git commit -m "feat: update progress-tracker to detect phase from artifact path

Remove current_phase dependency. Map review results to specific
phases by artifact filename instead of using linear cursor."
```

---

### Task 5: Update Remaining Hooks (context-preloader, review-enforcer, failure-escalation, evidence-tracker, metrics-tracker)

**Files:**
- Modify: `src/hooks/context-preloader.ts`
- Modify: `src/hooks/review-enforcer.ts`
- Modify: `src/hooks/failure-escalation.ts`
- Modify: `src/hooks/evidence-tracker.ts`
- Modify: `src/hooks/metrics-tracker.ts`

**Step 1: Update `context-preloader.ts`**

Change `PHASE_DATA_DEPS` keys from `number` to `PhaseId`, and load context for all `in_progress` phases instead of just `current_phase`.

Key changes:
- Line 3: Import `PhaseId` instead of `PhaseNumber`
- Line 7: `Record<PhaseId, string[]>` with string keys (`"2"`, `"3"`, etc.)
- Lines 40-41: Replace `const currentPhase = progress.current_phase` with iterating all phases that have status `in_progress`:

```typescript
// Old:
const currentPhase = progress.current_phase as PhaseNumber
const deps = PHASE_DATA_DEPS[currentPhase]

// New: collect deps for all in_progress phases
const allDeps = new Set<string>()
for (const [phaseId, phase] of Object.entries(progress.phases)) {
  if (phase.status === "in_progress" || phase.status === "review_pending") {
    const deps = PHASE_DATA_DEPS[phaseId as PhaseId]
    if (deps) deps.forEach((d) => allDeps.add(d))
  }
}
if (allDeps.size === 0) return
// ... use allDeps instead of deps
```

**Step 2: Update `review-enforcer.ts`**

Change from checking `current_phase` to scanning all phases with `status === "completed"` and `review_count === 0` that are in `REVIEW_REQUIRED_PHASES`:

```typescript
// Old:
const currentPhase = progress.current_phase as PhaseNumber
const phaseState = progress.phases[currentPhase]
if (REVIEW_REQUIRED_PHASES.includes(currentPhase) && phaseState?.status === "completed" && phaseState.review_count === 0)

// New: check all review-required phases
for (const phaseId of REVIEW_REQUIRED_PHASES) {
  const phaseState = progress.phases[phaseId]
  if (phaseState?.status === "completed" && phaseState.review_count === 0) {
    // Inject review reminder for this specific phase
  }
}
// Also check all phases for revision_needed status
for (const [phaseId, phaseState] of Object.entries(progress.phases)) {
  if (phaseState?.status === "revision_needed") {
    // Inject revision reminder
  }
}
```

**Step 3: Update `failure-escalation.ts`**

Change from incrementing `current_phase` failure count to detecting which phase the failure belongs to. Since agents run in subtasks, use a heuristic: find in_progress phases and increment the first one's failure count. The Conductor's delegation provides the context.

```typescript
// Old:
const currentPhase = progress.current_phase as PhaseNumber
const phaseState = progress.phases[currentPhase]

// New: find all in_progress phases, increment first match
const inProgressPhases = Object.entries(progress.phases)
  .filter(([, state]) => state.status === "in_progress")
  .map(([id]) => id as PhaseId)

if (inProgressPhases.length === 0) return null

// Use the agent name to match phase if possible, otherwise first in_progress
const targetPhase = inProgressPhases[0]
const phaseState = progress.phases[targetPhase]
```

**Step 4: Update `evidence-tracker.ts`**

Replace `current_phase` lookup with artifact-to-phase detection (same approach as phase-gate):

```typescript
// Old:
const currentPhase = progress.current_phase
const phaseState = progress.phases[currentPhase]

// New: detect phase from artifact path
const phase = detectPhaseForArtifact(artifactPath)
if (!phase) return
const phaseState = progress.phases[phase]
```

Add the same `detectPhaseForArtifact` helper used in phase-gate, or extract it to a shared utility.

**Step 5: Update `metrics-tracker.ts`**

The `readCurrentPhase()` function (lines 44-56) returns a single number. With DAG, multiple phases can be in_progress. Change to detect phase from agent name (available in the metric entry) or return all in_progress phases.

Simplest approach: find the in_progress phase that matches the agent name via `PHASE_AGENTS`:

```typescript
// Old:
function readCurrentPhase(): number {
  return progress.current_phase
}

// New:
function readActivePhases(): string[] {
  try {
    const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)
    if (existsSync(progressPath)) {
      const raw = readFileSync(progressPath, "utf-8")
      const progress = JSON.parse(raw)
      if (progress.phases) {
        return Object.entries(progress.phases)
          .filter(([, state]: [string, any]) => state.status === "in_progress")
          .map(([id]) => id)
      }
    }
  } catch {}
  return []
}

function resolvePhaseForAgent(agentName: string): string {
  for (const [phaseId, agents] of Object.entries(PHASE_AGENTS)) {
    const agentList = Array.isArray(agents) ? agents : [agents]
    if (agentList.includes(agentName)) return phaseId
  }
  return "-1"
}
```

Then at line 113: `const phase = resolvePhaseForAgent(msg.agent || "unknown")` instead of `readCurrentPhase()`.

Note: The `MetricEntry.phase` field type changes from `number` to `string`. Check `src/schema/metrics.ts` and update if needed.

**Step 6: Commit**

```bash
git add src/hooks/context-preloader.ts src/hooks/review-enforcer.ts src/hooks/failure-escalation.ts src/hooks/evidence-tracker.ts src/hooks/metrics-tracker.ts
git commit -m "feat: update 5 hooks to remove current_phase dependency

context-preloader: load deps for all in_progress phases.
review-enforcer: scan all phases for pending reviews.
failure-escalation: detect phase from in_progress status.
evidence-tracker: detect phase from artifact path.
metrics-tracker: resolve phase from agent name."
```

---

### Task 6: Check and Update MetricEntry Schema

**Files:**
- Modify: `src/schema/metrics.ts` (if `phase` field is `z.number()`)

**Step 1: Read metrics schema**

Check if `MetricEntry.phase` is typed as `z.number()`. If so, change to `z.string()` (since PhaseId is now a string like `"1b"`).

**Step 2: Update if needed and commit**

```bash
git add src/schema/metrics.ts
git commit -m "fix: change MetricEntry.phase type from number to string for PhaseId compatibility"
```

---

### Task 7: Update Slash Commands

**Files:**
- Modify: `src/create-skills.ts`

**Step 1: Add target phases to command templates**

Each command that drives a workflow needs to specify target phases in its template text, so the Conductor knows what to activate. Update the template strings:

- `matrix-start`: Add "Target phases: [\"8\"] (full workflow)"
- `matrix-analyze`: Change to target `["1"]` — "Target phases: [\"1\"] (software analysis only)"
- `matrix-review`: Change to target `["3"]` — "Target phases: [\"3\"] (through code review)"
- `matrix-test`: Change to target `["4"]` — "Target phases: [\"4\"] (through unit testing)"
- `matrix-report`: Same as start, target `["8"]`

Also update the `/matrix-start` template to describe the new parallel workflow instead of the old sequential list.

**Step 2: Commit**

```bash
git add src/create-skills.ts
git commit -m "feat: add target phases to slash command templates

Each workflow command now specifies target phases so the Conductor
activates only the required dependency subgraph."
```

---

### Task 8: Rewrite Conductor Prompt

**Files:**
- Modify: `src/agents/conductor.ts`

This is the largest change. The Conductor's `<phase_workflow>` section must change from a linear "Phase N → Phase N+1" sequence to a dependency-driven dispatch loop.

**Step 1: Rewrite the `CONDUCTOR_SYSTEM_PROMPT`**

Key changes:

1. **Identity**: Change "8-phase pipeline" to "dependency-driven testing workflow".

2. **Phase workflow section**: Replace sequential listing with:
   - Dependency graph description (which phases depend on which)
   - Individual phase descriptions (what each phase does, its agent, inputs/outputs, gates) — keep these, just remove the sequential ordering language
   - Dispatch loop algorithm

3. **Phase 0 changes**: After classification, parse target phases from the user's request. Call `createInitialProgress(projectName, taskType, targetPhases)` conceptually, and write to progress.json.

4. **Dispatch loop** (new section replacing sequential flow):
```
## Dispatch Algorithm

After Phase 0 classification, enter the dispatch loop:

1. Read progress.json
2. Find all READY phases (status=pending, all dependencies completed, in active_phases)
3. If no ready phases and all targets completed → workflow finished
4. If only 1 ready phase → dispatch synchronously via task()
5. If multiple ready phases → dispatch ALL with run_in_background=true, wait for completions
6. After any phase completes (or its review gate passes) → update progress.json → goto step 1

Each phase dispatch follows its specific protocol below.
```

5. **Phase descriptions**: Keep all phase descriptions (Phase 0 through Phase 8) but remove sequential ordering language like "After Phase 1 completes" and "Advance to Phase 4". Instead, the dispatch loop handles ordering automatically.

6. **Phase 3 internal logic**: Keep the multi-step internal logic (focused reviews → summary → cr-reviewer) exactly as-is. Phase 3 is one atomic unit from the dispatch loop's perspective.

7. **Review protocol**: Keep the same review flow, but clarify that a review REVISE only blocks the specific phase, not the whole workflow.

8. **Target phase support**: Add instructions for how to determine target phases from user input:
   - `/matrix-start` → target `["8"]`
   - User says "I only need unit testing" → target `["4"]`
   - User says "Run code review and unit testing" → target `["3", "4"]`

**Step 2: Update the agent `description` field**

Change from "8-phase workflow" to "dependency-driven testing workflow".

**Step 3: Commit**

```bash
git add src/agents/conductor.ts
git commit -m "feat: rewrite Conductor prompt for DAG-based dispatch

Replace sequential phase-by-phase orchestration with dependency-driven
dispatch loop. Phases 3/4/5/6 run in parallel after Phase 2.
Support target phases for partial workflow execution."
```

---

### Task 9: Fix Type References Across Codebase

**Files:**
- Potentially: any file importing `PhaseNumber` or using numeric phase indexing

**Step 1: Search for all `PhaseNumber` imports and usages**

```bash
grep -r "PhaseNumber" src/
```

Any file still importing `PhaseNumber` needs to either:
- Switch to `PhaseId` if it uses phase identifiers
- Keep `PhaseNumber` if `PHASES` numeric constant is still needed for backward compat

The `PHASES` constant and `PhaseNumber` type can stay for backward compat — they are used by agent prompts as semantic constants. But all state management code should use `PhaseId`.

**Step 2: Fix each file and commit**

```bash
git add -A
git commit -m "fix: migrate remaining PhaseNumber references to PhaseId"
```

---

### Task 10: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update the workflow section**

Replace the linear "9-Phase Workflow" section with the dependency graph description. Update the phase listing to show dependencies instead of sequential order. Mention that phases 3/4/5/6 run in parallel after Phase 2.

**Step 2: Update the phase-state description**

Mention `resolveActivePhases`, `getReadyPhases`, `target_phases`, `active_phases`. Remove mention of `current_phase`, `advancePhase`.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for DAG workflow architecture"
```

---

### Task 11: Typecheck and Integration Verify

**Step 1: Run typecheck**

```bash
bun run typecheck
```

Fix any type errors.

**Step 2: Run all tests**

```bash
bun test
```

Fix any test failures.

**Step 3: Build**

```bash
bun run build
```

Verify build succeeds.

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve type errors and test failures from DAG migration"
```
