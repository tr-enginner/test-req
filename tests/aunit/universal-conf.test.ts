import { test, expect, describe } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  parseUniversalConf,
  resolveConfEnvPaths,
  writeUniversalConf,
  collectInstallIncludes,
  type ParsedUniversalConf,
} from "../../src/tools/aunit/aunit-utils"

const SAMPLE_CONF = `# Platform: ARM GNUC
env ARMCC_PATH=C:\\Keil_v5\\ARM\\ARMCC
env BUILD_JOBS=4
inc=C:\\Keil_v5\\ARM\\include
inc=C:\\Keil_v5\\ARM\\cmsis
path=C:\\Keil_v5\\ARM\\bin
da CORTEX_M4=1
da __MICROLIB=

# trailing comment
`

describe("parseUniversalConf", () => {
  let tmpDir: string
  let confPath: string

  function setup(content: string) {
    tmpDir = mkdtempSync(join(tmpdir(), "aunit-conf-"))
    confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, content, "utf-8")
  }

  test("returns null for missing file", () => {
    const result = parseUniversalConf("/nonexistent/path/universal.conf")
    expect(result).toBeNull()
  })

  test("parses env entries", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)
    expect(result).not.toBeNull()
    const envEntries = result!.entries.filter(e => e.type === "env")
    expect(envEntries).toHaveLength(2)
    expect(envEntries[0].name).toBe("ARMCC_PATH")
    expect(envEntries[0].value).toBe("C:\\Keil_v5\\ARM\\ARMCC")
    expect(envEntries[1].name).toBe("BUILD_JOBS")
    expect(envEntries[1].value).toBe("4")
  })

  test("parses inc entries", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    const incEntries = result.entries.filter(e => e.type === "inc")
    expect(incEntries).toHaveLength(2)
    expect(incEntries[0].value).toBe("C:\\Keil_v5\\ARM\\include")
    expect(incEntries[1].value).toBe("C:\\Keil_v5\\ARM\\cmsis")
  })

  test("parses path entries", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    const pathEntries = result.entries.filter(e => e.type === "path")
    expect(pathEntries).toHaveLength(1)
    expect(pathEntries[0].value).toBe("C:\\Keil_v5\\ARM\\bin")
  })

  test("parses da entries with and without value", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    const daEntries = result.entries.filter(e => e.type === "da")
    expect(daEntries).toHaveLength(2)
    expect(daEntries[0].name).toBe("CORTEX_M4")
    expect(daEntries[0].value).toBe("1")
    expect(daEntries[1].name).toBe("__MICROLIB")
    expect(daEntries[1].value).toBe("")
  })

  test("preserves comments and blank lines", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    const commentEntries = result.entries.filter(e => e.type === "comment")
    expect(commentEntries.length).toBeGreaterThanOrEqual(2)
    const blankEntries = result.entries.filter(e => e.type === "blank")
    expect(blankEntries.length).toBeGreaterThanOrEqual(1)
  })

  test("preserves raw line for round-trip", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    for (const entry of result.entries) {
      expect(typeof entry.raw).toBe("string")
    }
  })
})

// ─── resolveConfEnvPaths ─────────────────────────────────────────────────────

describe("resolveConfEnvPaths", () => {
  test("keeps env value unchanged when path exists on disk", () => {
    const existingDir = mkdtempSync(join(tmpdir(), "aunit-env-"))
    const parsed: ParsedUniversalConf = {
      entries: [{ type: "env", raw: `env MYPATH=${existingDir}`, name: "MYPATH", value: existingDir }],
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    const entry = resolved.entries.find(e => e.name === "MYPATH")!
    expect(entry.value).toBe(existingDir)
    expect(warnings).toHaveLength(0)
  })

  test("resolves env value from process.env when disk path missing", () => {
    const existingDir = mkdtempSync(join(tmpdir(), "aunit-env-"))
    process.env["FAKE_TOOL_PATH"] = existingDir
    const parsed: ParsedUniversalConf = {
      entries: [{ type: "env", raw: "env FAKE_TOOL_PATH=C:\\nonexistent\\path", name: "FAKE_TOOL_PATH", value: "C:\\nonexistent\\path" }],
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    const entry = resolved.entries.find(e => e.name === "FAKE_TOOL_PATH")!
    expect(entry.value).toBe(existingDir)
    expect(warnings.some(w => w.includes("FAKE_TOOL_PATH"))).toBe(true)
    delete process.env["FAKE_TOOL_PATH"]
  })

  test("warns and keeps original when path not found anywhere", () => {
    const parsed: ParsedUniversalConf = {
      entries: [{ type: "env", raw: "env GHOST_PATH=C:\\ghost\\nowhere", name: "GHOST_PATH", value: "C:\\ghost\\nowhere" }],
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    const entry = resolved.entries.find(e => e.name === "GHOST_PATH")!
    expect(entry.value).toBe("C:\\ghost\\nowhere")
    expect(warnings.some(w => w.includes("GHOST_PATH") && w.includes("not found"))).toBe(true)
  })

  test("does not treat non-path env values as paths", () => {
    const parsed: ParsedUniversalConf = {
      entries: [{ type: "env", raw: "env BUILD_JOBS=4", name: "BUILD_JOBS", value: "4" }],
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    expect(resolved.entries[0].value).toBe("4")
    expect(warnings).toHaveLength(0)
  })

  test("does not modify inc/path/da entries", () => {
    const parsed: ParsedUniversalConf = {
      entries: [
        { type: "inc", raw: "inc=C:\\include", value: "C:\\include" },
        { type: "da", raw: "da FOO=1", name: "FOO", value: "1" },
      ],
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    expect(resolved.entries[0].value).toBe("C:\\include")
    expect(resolved.entries[1].value).toBe("1")
    expect(warnings).toHaveLength(0)
  })
})

// ─── writeUniversalConf ──────────────────────────────────────────────────────

describe("writeUniversalConf", () => {
  test("round-trips a parsed conf without modification", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-write-"))
    const confPath = join(tmpDir, "universal.conf")
    const original = `# header\nenv FOO=bar\ninc=C:\\include\nda MACRO=1\n`
    writeFileSync(confPath, original, "utf-8")

    const parsed = parseUniversalConf(confPath)!
    writeUniversalConf(confPath, parsed)

    const roundTripped = readFileSync(confPath, "utf-8")
    expect(roundTripped).toBe(original)
  })

  test("writes modified env value back to file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-write-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "env MYVAR=old_value\n", "utf-8")

    const parsed = parseUniversalConf(confPath)!
    parsed.entries[0] = { ...parsed.entries[0], value: "new_value", raw: "env MYVAR=new_value" }
    writeUniversalConf(confPath, parsed)

    const written = readFileSync(confPath, "utf-8")
    expect(written).toContain("env MYVAR=new_value")
    expect(written).not.toContain("old_value")
  })

  test("appends new inc entries to existing conf", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-write-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "env X=1\ninc=original\n", "utf-8")

    const parsed = parseUniversalConf(confPath)!
    parsed.entries.push({ type: "inc", raw: "inc=added_path", value: "added_path" })
    writeUniversalConf(confPath, parsed)

    const written = readFileSync(confPath, "utf-8")
    expect(written).toContain("inc=original")
    expect(written).toContain("inc=added_path")
  })
})

// ─── collectInstallIncludes ──────────────────────────────────────────────────

describe("collectInstallIncludes", () => {
  test("returns empty array when includes dir does not exist", () => {
    const result = collectInstallIncludes("/nonexistent/installDir")
    expect(result).toEqual([])
  })

  test("returns immediate subdirectories of includes/", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-inst-"))
    mkdirSync(join(tmpDir, "includes", "ARM"), { recursive: true })
    mkdirSync(join(tmpDir, "includes", "CMSIS"), { recursive: true })
    mkdirSync(join(tmpDir, "includes", "FreeRTOS"), { recursive: true })

    const result = collectInstallIncludes(tmpDir)
    const names = result.map(p => p.split(/[\\/]/).pop())
    expect(names).toContain("ARM")
    expect(names).toContain("CMSIS")
    expect(names).toContain("FreeRTOS")
    expect(result).toHaveLength(3)
  })

  test("returns nested subdirectories recursively", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-inst-"))
    mkdirSync(join(tmpDir, "includes", "ARM", "CMSIS"), { recursive: true })
    mkdirSync(join(tmpDir, "includes", "ARM", "Core"), { recursive: true })

    const result = collectInstallIncludes(tmpDir)
    expect(result.length).toBeGreaterThanOrEqual(3)
  })

  test("deduplicates paths", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-inst-"))
    mkdirSync(join(tmpDir, "includes", "common"), { recursive: true })

    const result = collectInstallIncludes(tmpDir)
    const unique = new Set(result)
    expect(unique.size).toBe(result.length)
  })

  test("returns only directories, not files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-inst-"))
    const incDir = join(tmpDir, "includes")
    mkdirSync(join(incDir, "sub"), { recursive: true })
    writeFileSync(join(incDir, "readme.txt"), "hello", "utf-8")

    const result = collectInstallIncludes(tmpDir)
    expect(result.every(p => !p.endsWith(".txt"))).toBe(true)
  })
})
