import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const VTESTC_EXE = "vtestc.exe"

/** Create a temp project directory with .matrix/config/matrix.jsonc */
function setupProject(configContent: string) {
  const root = mkdtempSync(join(tmpdir(), "vtest-validate-"))
  const configDir = join(root, ".matrix", "config")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, "matrix.jsonc"), configContent)
  return root
}

/** Create a fake VTest installation with vtestc.exe */
function setupVtestInstall(vtestHome: string) {
  mkdirSync(vtestHome, { recursive: true })
  writeFileSync(join(vtestHome, VTESTC_EXE), "fake vtestc")
}

/** Create a fake VS2013 installation with MSBuild */
function setupVs2013Install(vsRoot: string) {
  const msbuildDir = join(vsRoot, "..", "MSBuild", "12.0", "Bin")
  mkdirSync(msbuildDir, { recursive: true })
  writeFileSync(join(msbuildDir, "MSBuild.exe"), "fake msbuild")
}

let origCwd: string

beforeEach(() => {
  origCwd = process.cwd()
})

afterEach(() => {
  try { process.chdir(origCwd) } catch { /* ignore */ }
})

describe("resolveVtestExe - config strict validation", () => {
  test("returns null when matrix.jsonc has no vtest_home and no VTEST_HOME env", async () => {
    const root = setupProject(`{}`)
    process.chdir(root)
    const origVtestHome = process.env.VTEST_HOME
    delete process.env.VTEST_HOME
    try {
      const { resolveVtestExe } = await import("../../src/tools/vtest-runner")
      const result = resolveVtestExe()
      expect(result).toBeNull()
    } finally {
      if (origVtestHome !== undefined) process.env.VTEST_HOME = origVtestHome
      process.chdir(origCwd)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("returns null when matrix.jsonc has no vtest_home even if common paths might exist", async () => {
    const root = setupProject(`{}`)
    process.chdir(root)
    const origVtestHome = process.env.VTEST_HOME
    delete process.env.VTEST_HOME
    try {
      const { resolveVtestExe } = await import("../../src/tools/vtest-runner")
      const result = resolveVtestExe()
      // When no vtest_home in config, should return null (not scan common paths)
      expect(result).toBeNull()
    } finally {
      if (origVtestHome !== undefined) process.env.VTEST_HOME = origVtestHome
      process.chdir(origCwd)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("returns null when vtest_home points to non-existent path", async () => {
    const root = setupProject(`{"vtest_home": "C:\\\\nonexistent\\\\vtest"}`)
    process.chdir(root)
    const origVtestHome = process.env.VTEST_HOME
    delete process.env.VTEST_HOME
    try {
      const { resolveVtestExe } = await import("../../src/tools/vtest-runner")
      const result = resolveVtestExe()
      // When vtest_home configured but invalid, should return null (not fallback)
      expect(result).toBeNull()
    } finally {
      if (origVtestHome !== undefined) process.env.VTEST_HOME = origVtestHome
      process.chdir(origCwd)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("returns exe path when vtest_home is valid", async () => {
    const root = setupProject("")
    const vtestHome = join(root, "vtest-install")
    setupVtestInstall(vtestHome)
    const configDir = join(root, ".matrix", "config")
    writeFileSync(
      join(configDir, "matrix.jsonc"),
      JSON.stringify({ vtest_home: vtestHome })
    )
    process.chdir(root)
    const origVtestHome = process.env.VTEST_HOME
    delete process.env.VTEST_HOME
    try {
      const { resolveVtestExe } = await import("../../src/tools/vtest-runner")
      const result = resolveVtestExe()
      expect(result).toBe(join(vtestHome, VTESTC_EXE))
    } finally {
      if (origVtestHome !== undefined) process.env.VTEST_HOME = origVtestHome
      process.chdir(origCwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("resolveMSBuild - config strict validation", () => {
  test("returns null when matrix.jsonc has no vs2013_path", async () => {
    const root = setupProject(`{}`)
    process.chdir(root)
    try {
      const { resolveMSBuild } = await import("../../src/tools/vtest-compiler")
      const result = resolveMSBuild()
      // When no vs2013_path in config, should return null (not scan default/common paths)
      expect(result).toBeNull()
    } finally {
      process.chdir(origCwd)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("returns null when vs2013_path points to non-existent path", async () => {
    const root = setupProject(`{"vs2013_path": "C:\\\\nonexistent\\\\vs2013"}`)
    process.chdir(root)
    try {
      const { resolveMSBuild } = await import("../../src/tools/vtest-compiler")
      const result = resolveMSBuild()
      // When vs2013_path configured but invalid, should return null (not fallback)
      expect(result).toBeNull()
    } finally {
      process.chdir(origCwd)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("returns msbuild path when vs2013_path is valid", async () => {
    const root = setupProject("")
    const vsRoot = join(root, "vs2013")
    setupVs2013Install(vsRoot)
    const configDir = join(root, ".matrix", "config")
    writeFileSync(
      join(configDir, "matrix.jsonc"),
      JSON.stringify({ vs2013_path: vsRoot })
    )
    process.chdir(root)
    try {
      const { resolveMSBuild } = await import("../../src/tools/vtest-compiler")
      const result = resolveMSBuild()
      expect(result).not.toBeNull()
      expect(result!.path).toContain("MSBuild.exe")
      expect(result!.source).toContain("matrix.jsonc")
    } finally {
      process.chdir(origCwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
