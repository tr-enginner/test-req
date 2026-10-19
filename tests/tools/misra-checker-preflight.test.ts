import { test, expect, describe } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { extractDefines, findClangBinary } from "../../src/tools/misra-checker-preflight"
import { parseClangErrors, deduplicateCascades, type ClangError } from "../../src/tools/misra-checker-preflight"
import { buildClangFlags } from "../../src/tools/misra-checker-preflight"

describe("extractDefines", () => {
  test("extracts unquoted define", () => {
    expect(extractDefines('-d USE_HAL_DRIVER\n')).toEqual(["USE_HAL_DRIVER"])
  })

  test("extracts quoted define", () => {
    expect(extractDefines('-d "STM32F407xx"\n')).toEqual(["STM32F407xx"])
  })

  test("extracts define with value", () => {
    expect(extractDefines('-d "HSE_VALUE=8000000"\n')).toEqual(["HSE_VALUE=8000000"])
  })

  test("extracts multiple defines, ignores -i lines", () => {
    const conf = `-i "C:/include"\n-d "USE_HAL"\n-d "DEBUG=1"\n`
    expect(extractDefines(conf)).toEqual(["USE_HAL", "DEBUG=1"])
  })

  test("returns empty array for empty content", () => {
    expect(extractDefines("")).toEqual([])
  })

  test("handles CRLF line endings", () => {
    expect(extractDefines('-d "USE_HAL_DRIVER"\r\n')).toEqual(["USE_HAL_DRIVER"])
  })
})

describe("findClangBinary", () => {
  test("finds clang.exe at tools/clang/clang.exe", () => {
    const specHome = mkdtempSync(join(tmpdir(), "spechome-"))
    const clangDir = join(specHome, "tools", "clang")
    mkdirSync(clangDir, { recursive: true })
    writeFileSync(join(clangDir, "clang.exe"), "")
    expect(findClangBinary(specHome)).toBe(join(clangDir, "clang.exe"))
  })

  test("finds clang.exe at tools/clang/bin/clang.exe as fallback", () => {
    const specHome = mkdtempSync(join(tmpdir(), "spechome-"))
    const binDir = join(specHome, "tools", "clang", "bin")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, "clang.exe"), "")
    expect(findClangBinary(specHome)).toBe(join(binDir, "clang.exe"))
  })

  test("returns null when clang is not found", () => {
    const specHome = mkdtempSync(join(tmpdir(), "spechome-"))
    expect(findClangBinary(specHome)).toBeNull()
  })

  test("prefers tools/clang/clang.exe over bin/ variant", () => {
    const specHome = mkdtempSync(join(tmpdir(), "spechome-"))
    const clangDir = join(specHome, "tools", "clang")
    const binDir = join(clangDir, "bin")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(clangDir, "clang.exe"), "")
    writeFileSync(join(binDir, "clang.exe"), "")
    expect(findClangBinary(specHome)).toBe(join(clangDir, "clang.exe"))
  })
})

describe("parseClangErrors", () => {
  test("parses standard clang error line", () => {
    const stderr = `C:/src/main.c:5:10: error: 'stm32f4xx.h' file not found`
    expect(parseClangErrors(stderr)).toEqual([{
      file: "C:/src/main.c", line: 5, col: 10,
      message: "'stm32f4xx.h' file not found",
    }])
  })

  test("parses multiple errors from different files", () => {
    const stderr = [
      `C:/src/a.c:3:1: error: 'missing.h' file not found`,
      `C:/src/b.c:10:5: error: unknown type name 'uint32_t'`,
    ].join("\n")
    const result = parseClangErrors(stderr)
    expect(result).toHaveLength(2)
    expect(result[0].file).toBe("C:/src/a.c")
    expect(result[1].file).toBe("C:/src/b.c")
  })

  test("ignores warning lines", () => {
    const stderr = `C:/src/main.c:5:10: warning: unused variable 'x'`
    expect(parseClangErrors(stderr)).toHaveLength(0)
  })

  test("returns empty array for clean output", () => {
    expect(parseClangErrors("")).toHaveLength(0)
  })
})

describe("deduplicateCascades", () => {
  test("keeps missing-include as root cause, drops subsequent type errors in same file", () => {
    const errors: ClangError[] = [
      { file: "a.c", line: 1, col: 1, message: "'hal.h' file not found" },
      { file: "a.c", line: 5, col: 3, message: "unknown type name 'GPIO_TypeDef'" },
      { file: "a.c", line: 8, col: 3, message: "undeclared identifier 'HAL_Init'" },
    ]
    const result = deduplicateCascades(errors)
    expect(result).toHaveLength(1)
    expect(result[0].message).toContain("file not found")
  })

  test("keeps isolated type errors when no preceding include error in same file", () => {
    const errors: ClangError[] = [
      { file: "b.c", line: 3, col: 1, message: "unknown type name 'sfr'" },
      { file: "b.c", line: 7, col: 1, message: "unknown type name 'sbit'" },
    ]
    const result = deduplicateCascades(errors)
    expect(result).toHaveLength(2)
  })

  test("handles errors from multiple files independently", () => {
    const errors: ClangError[] = [
      { file: "a.c", line: 1, col: 1, message: "'hal.h' file not found" },
      { file: "a.c", line: 5, col: 1, message: "unknown type name 'GPIO_TypeDef'" },
      { file: "b.c", line: 2, col: 1, message: "unknown type name 'uint8_t'" },
    ]
    const result = deduplicateCascades(errors)
    expect(result).toHaveLength(2)
    expect(result.some(e => e.file === "a.c" && e.message.includes("file not found"))).toBe(true)
    expect(result.some(e => e.file === "b.c")).toBe(true)
  })
})


describe("buildClangFlags", () => {
  function makeEmitDir(compilerConf: string, analysisConf: string): string {
    const tmp = mkdtempSync(join(tmpdir(), "emit-"))
    writeFileSync(join(tmp, "compiler.conf"), compilerConf, "utf-8")
    writeFileSync(join(tmp, "analysis.conf"), analysisConf, "utf-8")
    return tmp
  }

  test("merges -I flags from both conf files without duplicates", () => {
    const emitDir = makeEmitDir(
      '-i "C:/spec/include"\n',
      '-i "C:/spec/include"\n-i "C:/project/inc"\n',
    )
    const flags = buildClangFlags(emitDir)
    const iFlags = flags.filter(f => f.startsWith("-I"))
    expect(iFlags).toHaveLength(2)
  })

  test("extracts -D flags from compiler.conf", () => {
    const emitDir = makeEmitDir('-d "USE_HAL_DRIVER"\n-d "STM32F4"\n', "")
    const flags = buildClangFlags(emitDir)
    expect(flags).toContain("-DUSE_HAL_DRIVER")
    expect(flags).toContain("-DSTM32F4")
  })

  test("returns empty array when conf files are absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "empty-emit-"))
    expect(buildClangFlags(tmp)).toEqual([])
  })

  test("deduplicates -D flags that appear in both conf files", () => {
    const emitDir = makeEmitDir(
      '-d "USE_HAL_DRIVER"\n',
      '-d "USE_HAL_DRIVER"\n',
    )
    const flags = buildClangFlags(emitDir)
    const dFlags = flags.filter(f => f === "-DUSE_HAL_DRIVER")
    expect(dFlags).toHaveLength(1)
  })
})
