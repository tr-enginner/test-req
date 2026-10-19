import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ensureMatrixWorkspace, resolveMatrixWorkspace } from "../workspace-root"

describe("workspace-root", () => {
  test("resolveMatrixWorkspace keeps the explicitly opened project directory", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "matrix-workspace-root-"))
    const userHome = join(sandbox, "Users", "zhuyuzhao")
    const projectDir = join(userHome, "Desktop", "matrix-offline", "code", "test")

    mkdirSync(join(userHome, ".matrix", "state"), { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(userHome, ".matrix", "state", "workspace-root.json"),
      JSON.stringify({
        requested_dir: join(userHome, "legacy-project"),
        active_work_dir: userHome,
        active_matrix_dir: join(userHome, ".matrix"),
        resolution_reason: "ancestor-matrix",
      }),
      "utf-8",
    )

    const selection = resolveMatrixWorkspace(projectDir)

    expect(selection.requestedDir).toBe(projectDir)
    expect(selection.workspaceDir).toBe(projectDir)
    expect(selection.resolutionReason).toBe("requested-dir")
    expect(selection.inactiveMatrixDirs).toEqual([])
  })

  test("ensureMatrixWorkspace materializes state only under the current project", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "matrix-workspace-root-"))
    const userHome = join(sandbox, "Users", "zhuyuzhao")
    const projectDir = join(userHome, "Desktop", "matrix-offline", "code", "test")
    const legacyStatePath = join(userHome, ".matrix", "state", "workspace-root.json")

    mkdirSync(join(userHome, ".matrix", "state"), { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      legacyStatePath,
      JSON.stringify({
        requested_dir: join(userHome, "legacy-project"),
        active_work_dir: userHome,
        active_matrix_dir: join(userHome, ".matrix"),
        resolution_reason: "ancestor-matrix",
      }),
      "utf-8",
    )

    const selection = ensureMatrixWorkspace(projectDir)
    const projectStatePath = join(projectDir, ".matrix", "state", "workspace-root.json")

    expect(selection.workspaceDir).toBe(projectDir)
    expect(existsSync(projectStatePath)).toBe(true)

    const projectState = JSON.parse(readFileSync(projectStatePath, "utf-8"))
    expect(projectState.requested_dir).toBe(projectDir)
    expect(projectState.active_work_dir).toBe(projectDir)
    expect(projectState.active_matrix_dir).toBe(join(projectDir, ".matrix"))
    expect(projectState.resolution_reason).toBe("requested-dir")

    const legacyState = JSON.parse(readFileSync(legacyStatePath, "utf-8"))
    expect(legacyState.active_work_dir).toBe(userHome)
  })
})
