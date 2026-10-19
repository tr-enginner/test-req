# DAG Workflow Design: Dependency-Driven Phase Scheduling

Date: 2026-02-26

## Problem

Current workflow is strictly sequential (Phase 0→1→1b→2→3→4→5→6→7→8). Phases 3 (Code Review), 4 (Unit Testing), 5 (Test Environment), 6 (Test Design) have no data dependency on each other — they all only depend on Phase 2 outputs. Running them serially wastes time.

Additionally, running the full pipeline is the only option. Users who only need unit testing (Phase 4) are forced through code review (Phase 3) first, even though Phase 4 doesn't depend on Phase 3.

## Design

Replace the linear `current_phase` cursor with a dependency graph. Each phase declares its prerequisites. The Conductor dispatches all phases whose dependencies are satisfied, in parallel.

### Phase Dependency Graph

```
Phase 0  →  Phase 1  →  Phase 1b  →  Phase 2
                                       │
                       ┌───────┬───────┼───────┐
                       ▼       ▼       ▼       ▼
                    Phase 3  Phase 4  Phase 5  Phase 6
                       │       │       │       │
                       │       │       └───┬───┘
                       │       │           ▼
                       │       │        Phase 7
                       └───────┴───────────┤
                                           ▼
                                        Phase 8
```

```typescript
export const PHASE_DEPS: Record<PhaseId, PhaseId[]> = {
  "0":  [],
  "1":  ["0"],
  "1b": ["1"],
  "2":  ["1b"],
  "3":  ["2"],
  "4":  ["2"],
  "5":  ["2"],
  "6":  ["2"],
  "7":  ["5", "6"],
  "8":  ["3", "4", "7"],
}
```

Quality gates remain bound to their phases:
- Phase 2 → `reviewer`
- Phase 3 → `cr-reviewer` (internal multi-step: focused reviews → summary → cr-reviewer)
- Phase 5 → `reviewer`
- Phase 6 → `reviewer`

A quality gate REVISE only blocks the phase it belongs to. Other parallel phases are unaffected.

### Phase ID System

Formalize Phase 1b as a first-class phase. Change `PhaseId` from `number` to `string`:

```typescript
export const PHASE_IDS = ["0", "1", "1b", "2", "3", "4", "5", "6", "7", "8"] as const
export type PhaseId = (typeof PHASE_IDS)[number]
```

The numeric `PHASES` constant stays for backward compatibility but is secondary to `PHASE_IDS`.

### State Model

Replace the linear cursor with per-phase status tracking and target-based activation:

```typescript
// Old
{
  current_phase: 3,
  phases: PhaseState[]  // indexed by number
}

// New
{
  target_phases: PhaseId[],       // user's goals (e.g., ["4"] for just unit testing)
  active_phases: PhaseId[],       // transitive dependency closure of targets
  phases: Record<PhaseId, PhaseState>,  // keyed by PhaseId, not array index
  started_at: string,
  updated_at: string,
}
```

`current_phase` is removed. The workflow is complete when all `target_phases` reach `completed` status.

### Core Functions

#### `resolveActivePhases(targets: PhaseId[]): PhaseId[]`

Compute transitive dependency closure. Walk backward through `PHASE_DEPS` to find all phases that must execute.

```
resolveActivePhases(["4"])     → ["0", "1", "1b", "2", "4"]
resolveActivePhases(["7"])     → ["0", "1", "1b", "2", "5", "6", "7"]
resolveActivePhases(["8"])     → ["0", "1", "1b", "2", "3", "4", "5", "6", "7", "8"]  (all)
resolveActivePhases(["3","4"]) → ["0", "1", "1b", "2", "3", "4"]
```

#### `getReadyPhases(progress: ProgressState): PhaseId[]`

Return phases that can start now: in `active_phases`, status is `pending`, and all dependencies are `completed`.

#### `isWorkflowComplete(progress: ProgressState): boolean`

All `target_phases` are `completed`.

#### `canStartPhase(progress: ProgressState, phase: PhaseId): boolean`

Phase is in `active_phases`, status is `pending`, and every phase in `PHASE_DEPS[phase]` has status `completed`.

### Conductor Dispatch Loop

The Conductor prompt changes from a linear "Phase N then Phase N+1" to a dependency-driven loop:

```
loop:
  ready = getReadyPhases()
  if ready is empty AND isWorkflowComplete() → finish
  if ready is empty AND NOT complete → error (deadlock)

  if len(ready) == 1:
    dispatch synchronously via task()
  else:
    dispatch all via task(..., run_in_background=true)
    wait for any to complete

  re-evaluate ready (newly unblocked phases may appear)
```

Phase 3 retains its internal multi-step logic (focused reviews → summary → cr-reviewer) within the single Phase 3 dispatch. From the Conductor's perspective, Phase 3 is one unit.

### Phase Gate Hook

Replace linear check with dependency check:

```typescript
// Old
if (phaseForArtifact > currentPhase + 1) → block

// New
if (phaseForArtifact not in activePhases) → block
if (any dep of phaseForArtifact is not completed) → block
```

### Progress Tracker Hook

Remove `current_phase` references. Artifact detection remains per-phase but doesn't need to check linear ordering. Review PASS handling changes from `progress.current_phase` to checking which phase the review artifact belongs to.

### Slash Commands

Each command specifies its target phases:

| Command | Target Phases | Result |
|---------|--------------|--------|
| `/matrix-start` | `["8"]` | Full workflow (all phases via transitive deps) |
| `/matrix-plan` | — | No change (interactive, no phase dispatch) |
| `/matrix-analyze` | `["1"]` | Phases 0, 1 |
| `/matrix-review` | `["3"]` | Phases 0, 1, 1b, 2, 3 |
| `/matrix-test` | `["4"]` | Phases 0, 1, 1b, 2, 4 |
| `/matrix-report` | `["8"]` | Same as `/matrix-start` |
| `/matrix-status` | — | No change (read-only) |
| `/matrix-metrics` | — | No change (read-only) |
| `/matrix-astgrep` | — | No change (standalone tool) |
| `/matrix-isr-review` | `["3"]` | Same as `/matrix-review` (ISR is part of Phase 3) |

Users can also specify custom targets via the Conductor (e.g., "I only need unit testing and test environment" → targets `["4", "5"]`).

### Backward Compatibility

- `progress.json` format changes (no `current_phase`, new fields). Old files won't parse — acceptable since this is a development tool and `.matrix/` is ephemeral.
- Phase numbering stays the same (0, 1, 1b, 2-8). No renumbering.
- Agent prompts and skills don't change — only the Conductor's dispatch logic and shared infrastructure.

## Files to Modify

| File | Change |
|------|--------|
| `src/shared/constants.ts` | Add `PHASE_IDS`, `PHASE_DEPS`. Keep `PHASES` for agent mapping. |
| `src/shared/phase-state.ts` | Rewrite: new `ProgressState` schema, `resolveActivePhases`, `getReadyPhases`, `canStartPhase`, `isWorkflowComplete`. Remove `advancePhase` (no linear cursor). Keep `markPhaseCompleted`, `markRevisionNeeded`, `recordPhaseFailure`. |
| `src/agents/conductor.ts` | Rewrite prompt: dependency-driven dispatch loop replacing linear phase sequence. |
| `src/hooks/phase-gate.ts` | Replace linear check with dependency-based check. |
| `src/hooks/progress-tracker.ts` | Remove `current_phase` references, adapt review PASS logic. |
| `src/create-skills.ts` | Update command templates to specify target phases. |
| `CLAUDE.md` | Update architecture docs to reflect DAG workflow. |

## Non-Changes

- Agent prompts (except Conductor): No changes. Each agent does its job regardless of scheduling.
- Skills: No changes. Skills describe methodology, not scheduling.
- Tools: No changes. Tools are phase-agnostic.
- Hooks (except phase-gate, progress-tracker): No changes.
- Schemas (except phase-state): No changes.
