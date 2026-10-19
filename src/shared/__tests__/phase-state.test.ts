import { describe, test, expect } from "bun:test"
import { mkdirSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  resolveActivePhases,
  getReadyPhases,
  canStartPhase,
  isWorkflowComplete,
  createInitialProgress,
  detectSoftPlatform,
  markPhaseStarted,
  markPhaseCompleted,
  markPhasePublishing,
} from "../phase-state"

describe("resolveActivePhases", () => {
  test("target phase 8 resolves to the summary dependency closure without Phase 5 (Phase 6 depends only on Phase 2)", () => {
    const active = resolveActivePhases(["8"])
    expect(active).toContain("0")
    expect(active).toContain("1")
    expect(active).toContain("2")
    expect(active).toContain("3")
    expect(active).toContain("4")
    expect(active).toContain("6")
    expect(active).toContain("8")
    expect(active).not.toContain("5")
    expect(active).not.toContain("7")
    expect(active.length).toBe(7)
  })

  test("target phase 4 resolves to 0,1,2,4", () => {
    const active = resolveActivePhases(["4"])
    expect(active.sort()).toEqual(["0", "1", "2", "4"].sort())
  })

  test("target phase 7 resolves to 0,1,2,5,6,7", () => {
    const active = resolveActivePhases(["7"])
    expect(active.sort()).toEqual(["0", "1", "2", "5", "6", "7"].sort())
  })

  test("multiple targets merge dependencies", () => {
    const active = resolveActivePhases(["3", "4"])
    expect(active.sort()).toEqual(["0", "1", "2", "3", "4"].sort())
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

  test("after phase 0 completes, phases 1 and 2 are ready", () => {
    let progress = createInitialProgress("test", "new_project", ["8"])
    progress = markPhaseCompleted(progress, "0")
    const ready = getReadyPhases(progress)
    expect(ready.sort()).toEqual(["1", "2"].sort())
  })

  test("after phase 0 and 2 complete, phases 1 and 6 are ready; 3 and 4 wait for phase 1; 5 is inactive", () => {
    let progress = createInitialProgress("test", "new_project", ["8"])
    progress = markPhaseCompleted(progress, "0")
    progress = markPhaseCompleted(progress, "2")
    const ready = getReadyPhases(progress)

    expect(ready).toContain("1")
    expect(ready).toContain("6")
    expect(ready).not.toContain("3")
    expect(ready).not.toContain("4")
    expect(ready).not.toContain("5")
    expect(ready).not.toContain("8")
  })

  test("after phase 1 and 2 complete, phases 3, 4, and 6 are all ready in parallel", () => {
    let progress = createInitialProgress("test", "new_project", ["8"])
    progress = markPhaseCompleted(progress, "0")
    progress = markPhaseCompleted(progress, "1")
    progress = markPhaseCompleted(progress, "2")
    const ready = getReadyPhases(progress)

    expect(ready.sort()).toEqual(["3", "4", "6"].sort())
  })

  test("target phase 7 remains available as a legacy explicit workflow", () => {
    let progress = createInitialProgress("test", "new_project", ["8"])
    expect(progress.active_phases).not.toContain("7")

    progress = createInitialProgress("test", "new_project", ["7"])
    expect(progress.active_phases.sort()).toEqual(["0", "1", "2", "5", "6", "7"].sort())
  })

  test("phase 7 is ready only when explicitly active and 5 and 6 are completed", () => {
    let progress = createInitialProgress("test", "new_project", ["7"])
    for (const p of ["0", "1", "2"] as const) {
      progress = markPhaseCompleted(progress, p)
    }
    progress = markPhaseCompleted(progress, "5")
    let ready = getReadyPhases(progress)
    expect(ready).not.toContain("7")

    progress = markPhaseCompleted(progress, "6")
    ready = getReadyPhases(progress)
    expect(ready).toContain("7")
  })

  test("phase 7 stays blocked while phase 6 is publishing", () => {
    let progress = createInitialProgress("test", "new_project", ["7"])
    for (const p of ["0", "1", "2"] as const) {
      progress = markPhaseCompleted(progress, p)
    }
    progress = markPhaseCompleted(progress, "5")
    progress = markPhasePublishing(progress, "6")

    const ready = getReadyPhases(progress)
    expect(ready).not.toContain("7")
  })

  test("phases not in active_phases are never ready", () => {
    let progress = createInitialProgress("test", "new_project", ["4"])
    for (const p of ["0", "1", "2"] as const) {
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
    for (const p of ["0", "1", "2", "4"] as const) {
      progress = markPhaseCompleted(progress, p)
    }
    expect(isWorkflowComplete(progress)).toBe(true)
  })
})

describe("detectSoftPlatform", () => {
  test("detects a root-level *软平台* directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-state-sp-"))
    mkdirSync(join(dir, "某项目软平台"), { recursive: true })

    expect(detectSoftPlatform(dir)).toBe("某项目软平台")
  })

  test("detects an already-provisioned .matrix/data/DTPProject with 组合关键字", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-state-dtp-"))
    mkdirSync(join(dir, ".matrix", "data", "DTPProject", "组合关键字"), { recursive: true })

    expect(detectSoftPlatform(dir)).toBe(".matrix/data/DTPProject")
  })

  test("does not detect an empty .matrix/data/DTPProject", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-state-dtp-empty-"))
    mkdirSync(join(dir, ".matrix", "data", "DTPProject"), { recursive: true })

    expect(detectSoftPlatform(dir)).toBeNull()
  })

  test("returns null when no soft platform exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-state-none-"))
    mkdirSync(dir, { recursive: true })

    expect(detectSoftPlatform(dir)).toBeNull()
  })
})

describe("createInitialProgress soft platform pre-detection", () => {
  test("marks Phase 5 completed when .matrix/data/DTPProject is already provisioned (no root *软平台*)", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-state-init-dtp-"))
    mkdirSync(join(dir, ".matrix", "data", "DTPProject", "组合关键字"), { recursive: true })

    const progress = createInitialProgress("test", "new_project", ["7"], dir)
    expect(progress.phases["5"].status).toBe("completed")
    expect(progress.phases["5"].artifacts).toContain("DTPProject/")
  })

  test("keeps Phase 5 pending when no soft platform source exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-state-init-none-"))
    mkdirSync(dir, { recursive: true })

    const progress = createInitialProgress("test", "new_project", ["7"], dir)
    expect(progress.phases["5"].status).toBe("pending")
  })
})
