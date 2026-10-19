import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { normalizeFindingPathForReview } from "../../src/tools/misra-checker"

describe("normalizeFindingPathForReview", () => {
  test("converts project-local absolute paths to matrix-root relative paths", () => {
    const matrixRoot = mkdtempSync(join(tmpdir(), "matrix-root-"))
    const findingPath = join(matrixRoot, "src", "main.c")

    expect(normalizeFindingPathForReview(findingPath, matrixRoot)).toBe("src/main.c")
  })

  test("normalizes separators for already-relative finding paths", () => {
    expect(normalizeFindingPathForReview("src\\drivers\\uart.c", "D:\\repo\\project")).toBe("src/drivers/uart.c")
  })

  test("maps SpecChecker workspace paths back to source-relative paths", () => {
    const matrixRoot = mkdtempSync(join(tmpdir(), "matrix-root-"))
    const sourceDir = join(matrixRoot, "src")
    mkdirSync(sourceDir, { recursive: true })

    const specHome = mkdtempSync(join(tmpdir(), "spechome-"))
    const projectPath = join(specHome, "workspace", "myproject")
    mkdirSync(projectPath, { recursive: true })

    // SpecChecker report has workspace path
    const workspacePath = join(projectPath, "power.c")

    const result = normalizeFindingPathForReview(workspacePath, matrixRoot, sourceDir, projectPath)
    expect(result).toBe("src/power.c")
  })

  test("returns basename for external paths outside both matrixRoot and workspace", () => {
    const matrixRoot = mkdtempSync(join(tmpdir(), "matrix-root-"))
    const externalPath = join(mkdtempSync(join(tmpdir(), "external-")), "vendor", "stdio.h")

    expect(normalizeFindingPathForReview(externalPath, matrixRoot)).toBe("stdio.h")
  })

  test("returns empty string for empty input", () => {
    expect(normalizeFindingPathForReview("", null)).toBe("")
  })
})
