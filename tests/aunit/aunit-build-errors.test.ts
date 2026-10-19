import { test, expect, describe } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { addPathToConf, parseUniversalConf } from "../../src/tools/aunit/aunit-utils"

describe("addPathToConf", () => {
  test("returns false when conf does not exist", () => {
    const result = addPathToConf("/nonexistent/conf", "C:\\MinGW\\bin")
    expect(result).toBe(false)
  })

  test("appends path= entry when not already present", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-path-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "env X=1\ninc=C:\\include\n", "utf-8")

    const result = addPathToConf(confPath, "C:\\MinGW\\bin")
    expect(result).toBe(true)

    const parsed = parseUniversalConf(confPath)!
    const pathEntries = parsed.entries.filter(e => e.type === "path")
    expect(pathEntries).toHaveLength(1)
    expect(pathEntries[0].value).toBe("C:\\MinGW\\bin")
  })

  test("returns false and does not duplicate when path= already present", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-path-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "path=C:\\MinGW\\bin\n", "utf-8")

    const result = addPathToConf(confPath, "C:\\MinGW\\bin")
    expect(result).toBe(false)

    const parsed = parseUniversalConf(confPath)!
    expect(parsed.entries.filter(e => e.type === "path")).toHaveLength(1)
  })

  test("normalizes slashes when checking for duplicates", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-path-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "path=C:/MinGW/bin\n", "utf-8")

    // Same path with backslashes — should be treated as duplicate
    const result = addPathToConf(confPath, "C:\\MinGW\\bin")
    expect(result).toBe(false)
  })
})

import { parseSyntaxErrors, parseCompilerNotFound } from "../../src/tools/aunit/aunit-build-diagnostics"

describe("parseSyntaxErrors", () => {
  test("parses GCC-style unknown extension error", () => {
    const output = `/path/to/power.c:42:10: error: attribute '__packed__' is not supported`
    const errors = parseSyntaxErrors(output, "")
    expect(errors).toHaveLength(1)
    expect(errors[0].file).toBe("/path/to/power.c")
    expect(errors[0].line).toBe(42)
    expect(errors[0].column).toBe(10)
    expect(errors[0].type).toBe("unknown_extension")
    expect(errors[0].message).toContain("__packed__")
  })

  test("parses implicit declaration error", () => {
    const output = `src/main.c:8:5: error: implicit declaration of function 'printf'`
    const errors = parseSyntaxErrors(output, "")
    expect(errors).toHaveLength(1)
    expect(errors[0].type).toBe("implicit_declaration")
    expect(errors[0].file).toBe("src/main.c")
    expect(errors[0].line).toBe(8)
  })

  test("parses unknown type error", () => {
    const output = `src/hal.c:15:3: error: unknown type name 'uint32_t'`
    const errors = parseSyntaxErrors(output, "")
    expect(errors).toHaveLength(1)
    expect(errors[0].type).toBe("unknown_type")
  })

  test("parses generic syntax error", () => {
    const output = `src/main.c:22:7: error: expected ';' before '}' token`
    const errors = parseSyntaxErrors(output, "")
    expect(errors).toHaveLength(1)
    expect(errors[0].type).toBe("syntax_error")
  })

  test("returns multiple errors from multi-line output", () => {
    const output = [
      `src/a.c:1:1: error: attribute '__asm__' not supported`,
      `src/b.c:5:2: error: implicit declaration of function 'memset'`,
      `src/c.c:9:3: error: expected ';' before '}' token`,
    ].join("\n")
    const errors = parseSyntaxErrors(output, "")
    expect(errors).toHaveLength(3)
    expect(errors[0].type).toBe("unknown_extension")
    expect(errors[1].type).toBe("implicit_declaration")
    expect(errors[2].type).toBe("syntax_error")
  })

  test("returns empty array when no errors in output", () => {
    const errors = parseSyntaxErrors("Build succeeded", "")
    expect(errors).toHaveLength(0)
  })

  test("deduplicates same file+line+col errors", () => {
    const output = [
      `src/a.c:1:1: error: attribute '__packed__' not supported`,
      `src/a.c:1:1: error: attribute '__packed__' not supported`,
    ].join("\n")
    const errors = parseSyntaxErrors(output, "")
    expect(errors).toHaveLength(1)
  })
})

describe("parseCompilerNotFound", () => {
  test("detects 'command not found' pattern", () => {
    const result = parseCompilerNotFound("", "gcc: command not found")
    expect(result).toBe("gcc")
  })

  test("detects '/bin/sh: not found' pattern", () => {
    const result = parseCompilerNotFound("/bin/sh: 1: armcc: not found", "")
    expect(result).toBe("armcc")
  })

  test("detects 'No such file or directory' for compiler", () => {
    const result = parseCompilerNotFound("armcc: No such file or directory", "")
    expect(result).toBe("armcc")
  })

  test("detects cc1 not found", () => {
    const result = parseCompilerNotFound("", "'cc1' not found")
    expect(result).toBe("cc1")
  })

  test("returns null when no compiler error", () => {
    const result = parseCompilerNotFound("Build failed: syntax error", "")
    expect(result).toBeNull()
  })

  test("returns null for include-related not found (not a compiler)", () => {
    const result = parseCompilerNotFound("stdio.h: No such file or directory", "")
    expect(result).toBeNull()
  })
})

import { searchCompilerGlobal } from "../../src/tools/aunit/aunit-build-diagnostics"

describe("searchCompilerGlobal", () => {
  test("returns null for obviously nonexistent compiler name", () => {
    const result = searchCompilerGlobal("__definitely_not_a_real_compiler_xyz987__")
    expect(result).toBeNull()
  }, 90_000)

  test("result is null or a string directory path", () => {
    // bun may or may not be findable — just validate the return type
    const result = searchCompilerGlobal("bun")
    expect(result === null || typeof result === "string").toBe(true)
  }, 90_000)
})
