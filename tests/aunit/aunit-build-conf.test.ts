import { test, expect, describe, beforeEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { parseUniversalConf } from "../../src/tools/aunit/aunit-utils"
import { patchUniversalConf, addIncludesToConf } from "../../src/tools/aunit/aunit-build"

// ─── patchUniversalConf ──────────────────────────────────────────────────────

describe("patchUniversalConf", () => {
  let projectDir: string
  let confPath: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "aunit-proj-"))
    // universal.conf lives in the AUnit project root directory
    const projRoot = join(projectDir, ".matrix", "aunit", "TestProject")
    mkdirSync(projRoot, { recursive: true })
    confPath = join(projRoot, "universal.conf")
  })

  test("returns no warnings when conf file does not exist", () => {
    const { warnings } = patchUniversalConf("/nonexistent/path/universal.conf")
    expect(warnings).toEqual([])
  })

  test("patches conf: resolves VALID_PATH, warns on MISSING_PATH", () => {
    writeFileSync(
      confPath,
      `env VALID_PATH=${projectDir}\nenv MISSING_PATH=C:\\ghost\\nowhere\ninc=C:\\original\\include\nda TEST_MACRO=1\n`,
      "utf-8",
    )

    const { warnings } = patchUniversalConf(confPath)

    expect(existsSync(confPath)).toBe(true)
    const parsed = parseUniversalConf(confPath)!

    const validEntry = parsed.entries.find(e => e.name === "VALID_PATH")
    expect(validEntry?.value).toBe(projectDir)

    const missingEntry = parsed.entries.find(e => e.name === "MISSING_PATH")
    expect(missingEntry?.value).toBe("C:\\ghost\\nowhere")

    expect(warnings.some(w => w.includes("MISSING_PATH") && w.includes("not found"))).toBe(true)
  })

  test("resolves env from process.env when disk path missing", () => {
    process.env["MY_SDK_PATH"] = projectDir
    writeFileSync(confPath, `env MY_SDK_PATH=C:\\missing\\sdk\n`, "utf-8")

    const { warnings } = patchUniversalConf(confPath)

    const parsed = parseUniversalConf(confPath)!
    const entry = parsed.entries.find(e => e.name === "MY_SDK_PATH")!
    expect(entry.value).toBe(projectDir)
    expect(warnings.some(w => w.includes("MY_SDK_PATH"))).toBe(true)

    delete process.env["MY_SDK_PATH"]
  })
})

// ─── addIncludesToConf ───────────────────────────────────────────────────────

describe("addIncludesToConf", () => {
  test("returns empty array when conf does not exist", () => {
    const result = addIncludesToConf("/nonexistent/conf", ["C:\\some\\path"])
    expect(result).toEqual([])
  })

  test("appends new inc entries not already present", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-retry-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "env X=1\ninc=C:\\existing\n", "utf-8")

    const newPaths = ["C:\\new\\path1", "C:\\new\\path2", "C:\\existing"]
    const added = addIncludesToConf(confPath, newPaths)

    const parsed = parseUniversalConf(confPath)!
    const incValues = parsed.entries.filter(e => e.type === "inc").map(e => e.value)
    expect(incValues).toContain("C:\\existing")
    expect(incValues).toContain("C:\\new\\path1")
    expect(incValues).toContain("C:\\new\\path2")
    expect(added).toHaveLength(2)
    expect(added).toContain("C:\\new\\path1")
    expect(added).not.toContain("C:\\existing")
  })

  test("does not write file when no new paths added", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-retry-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "inc=C:\\existing\n", "utf-8")

    const added = addIncludesToConf(confPath, ["C:\\existing"])
    expect(added).toHaveLength(0)
  })

  test("normalizes paths for deduplication (forward vs backslash)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-retry-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "inc=C:/existing/path\n", "utf-8")

    // Same path but with backslashes — should be treated as duplicate
    const added = addIncludesToConf(confPath, ["C:\\existing\\path"])
    expect(added).toHaveLength(0)
  })
})
