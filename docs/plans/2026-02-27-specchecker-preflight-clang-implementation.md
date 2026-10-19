# SpecChecker Pre-flight Clang Check Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Insert a clang `-fsyntax-only` pre-flight compilation check into the SpecChecker
`check` pipeline (after config injection, before `analyze`) so that compilation errors are
detected and fixed within seconds rather than after a 600-second wasted analysis run.

**Architecture:** Add a `runPreflightClangCheck()` function to `misra-checker.ts` that reads
SpecChecker's generated conf files, runs the bundled clang binary against original source files,
deduplicates cascade errors, and either auto-repairs (missing stubs) or escalates to the agent
(wrong preset). The function is wired into `executeCheck()` between Step 1.5 and Step 2.

**Tech Stack:** TypeScript/Bun, `child_process.execSync`, existing `extractIncludePaths()` /
`findMatrixRoot()` / `resolveCompilationEnv()` helpers already in `misra-checker.ts`,
`discoverExpectedSymbols` / `generateDemandStub` / `getPrebuiltStub` from the preprocessing layer.

---

## Reference: Key File Locations

- Main tool: `src/tools/misra-checker.ts`
  - `extractIncludePaths()` — line ~573, parses `-i` lines from conf content
  - `normalizePath()` — line ~566
  - `findMatrixRoot()` — already used at line ~775
  - `injectCompilationConfig()` — line ~634, call site at line 804
  - Integration point: **between line 804 and line 806** (after inject, before analyze)
  - `emit/unit/compiler.conf` — SpecChecker preset built-in includes + platform defines
  - `emit/unit/analysis.conf` — injected project includes + stubs
- Stub generation:
  - `src/tools/preprocessing/include-resolver.ts` — exports `discoverExpectedSymbols`, `generateDemandStub`
  - `src/tools/preprocessing/standard-stubs.ts` — exports `getPrebuiltStub`
- Tests: `tests/tools/misra-checker-preflight.test.ts` (new file)
- Existing test pattern: see `tests/aunit/aunit-build-errors.test.ts`

---

## Task 1: Add `extractDefines` helper + tests

**Files:**
- Modify: `src/tools/misra-checker.ts` (add near `extractIncludePaths`, ~line 573)
- Create: `tests/tools/misra-checker-preflight.test.ts`

### Step 1: Write the failing test

Create `tests/tools/misra-checker-preflight.test.ts`:

```typescript
import { test, expect, describe } from "bun:test"

// We will import helpers once they exist. Start with a placeholder import
// that will fail until Task 1 is done.
import { extractDefines } from "../../src/tools/misra-checker-preflight"

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
})
```

### Step 2: Run test to confirm it fails

```bash
cd D:/git-rep/matrix/matrix-embedded-agent
bun test tests/tools/misra-checker-preflight.test.ts
```

Expected: **FAIL** — `Cannot find module '../../src/tools/misra-checker-preflight'`

### Step 3: Create `src/tools/misra-checker-preflight.ts` with `extractDefines`

Create a new file `src/tools/misra-checker-preflight.ts`:

```typescript
/**
 * Pre-flight compilation check helpers for misra-checker.
 * Exported separately for unit testing.
 */

/**
 * Extract all -d define values from a SpecChecker conf file content.
 * Handles both quoted (-d "NAME=VAL") and unquoted (-d NAME) forms.
 */
export function extractDefines(confContent: string): string[] {
  const defines: string[] = []
  for (const line of confContent.split("\n")) {
    const match = line.trim().match(/^-d\s+"?([^"]+?)"?\s*$/)
    if (match) defines.push(match[1])
  }
  return defines
}
```

### Step 4: Run test to confirm it passes

```bash
bun test tests/tools/misra-checker-preflight.test.ts --test-name-pattern "extractDefines"
```

Expected: **PASS** — all 5 extractDefines tests green

### Step 5: Commit

```bash
git add src/tools/misra-checker-preflight.ts tests/tools/misra-checker-preflight.test.ts
git commit -m "feat(preflight): add extractDefines helper with tests"
```

---

## Task 2: Add `findClangBinary` helper + tests

**Files:**
- Modify: `src/tools/misra-checker-preflight.ts`
- Modify: `tests/tools/misra-checker-preflight.test.ts`

### Step 1: Write the failing test

Append to `tests/tools/misra-checker-preflight.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { findClangBinary } from "../../src/tools/misra-checker-preflight"

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
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/tools/misra-checker-preflight.test.ts --test-name-pattern "findClangBinary"
```

Expected: **FAIL** — `findClangBinary is not a function`

### Step 3: Add `findClangBinary` to `misra-checker-preflight.ts`

```typescript
import { existsSync } from "fs"
import { join } from "path"

/**
 * Locate the clang binary bundled with SpecChecker.
 * Returns the absolute path to clang.exe / clang, or null if not found.
 */
export function findClangBinary(specHome: string): string | null {
  const candidates = [
    join(specHome, "tools", "clang", "clang.exe"),
    join(specHome, "tools", "clang", "bin", "clang.exe"),
    join(specHome, "tools", "clang", "clang"),
    join(specHome, "tools", "clang", "bin", "clang"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
```

### Step 4: Run test to confirm it passes

```bash
bun test tests/tools/misra-checker-preflight.test.ts --test-name-pattern "findClangBinary"
```

Expected: **PASS**

### Step 5: Commit

```bash
git add src/tools/misra-checker-preflight.ts tests/tools/misra-checker-preflight.test.ts
git commit -m "feat(preflight): add findClangBinary helper with tests"
```

---

## Task 3: Add `parseClangErrors` + `deduplicateCascades` + tests

**Files:**
- Modify: `src/tools/misra-checker-preflight.ts`
- Modify: `tests/tools/misra-checker-preflight.test.ts`

### Step 1: Write the failing tests

Append to the test file:

```typescript
import { parseClangErrors, deduplicateCascades, type ClangError } from "../../src/tools/misra-checker-preflight"

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
    // a.c: only the include error; b.c: its type error is not a cascade (no prior include error)
    expect(result).toHaveLength(2)
    expect(result.some(e => e.file === "a.c" && e.message.includes("file not found"))).toBe(true)
    expect(result.some(e => e.file === "b.c")).toBe(true)
  })
})
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/tools/misra-checker-preflight.test.ts --test-name-pattern "parseClangErrors|deduplicateCascades"
```

Expected: **FAIL**

### Step 3: Implement in `misra-checker-preflight.ts`

Add to the file:

```typescript
export interface ClangError {
  file: string
  line: number
  col: number
  message: string
}

/**
 * Parse clang -fsyntax-only stderr into structured ClangError objects.
 * Matches lines of the form: /path/to/file.c:line:col: error: message
 */
export function parseClangErrors(stderr: string): ClangError[] {
  const errors: ClangError[] = []
  const re = /^(.+?):(\d+):(\d+):\s+error:\s+(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr)) !== null) {
    errors.push({ file: m[1], line: parseInt(m[2]), col: parseInt(m[3]), message: m[4] })
  }
  return errors
}

const INCLUDE_ERROR_PATTERNS = ["file not found", "cannot open include file", "no such file or directory"]

function isMissingIncludeError(message: string): boolean {
  const lower = message.toLowerCase()
  return INCLUDE_ERROR_PATTERNS.some(p => lower.includes(p))
}

/**
 * Remove cascade errors caused by a missing include.
 * When a file has a "cannot open include file" error, all subsequent
 * type/identifier errors in the same file are suppressed as non-root-cause cascades.
 */
export function deduplicateCascades(errors: ClangError[]): ClangError[] {
  // Group by file, sort by line number
  const byFile = new Map<string, ClangError[]>()
  for (const e of errors) {
    if (!byFile.has(e.file)) byFile.set(e.file, [])
    byFile.get(e.file)!.push(e)
  }

  const rootCauses: ClangError[] = []
  for (const fileErrors of byFile.values()) {
    fileErrors.sort((a, b) => a.line - b.line)
    let hasMissingInclude = false
    for (const err of fileErrors) {
      if (isMissingIncludeError(err.message)) {
        rootCauses.push(err)
        hasMissingInclude = true
      } else if (!hasMissingInclude) {
        rootCauses.push(err)
      }
      // else: cascade from missing include — skip
    }
  }
  return rootCauses
}
```

### Step 4: Run test to confirm it passes

```bash
bun test tests/tools/misra-checker-preflight.test.ts --test-name-pattern "parseClangErrors|deduplicateCascades"
```

Expected: **PASS**

### Step 5: Commit

```bash
git add src/tools/misra-checker-preflight.ts tests/tools/misra-checker-preflight.test.ts
git commit -m "feat(preflight): add parseClangErrors and deduplicateCascades with tests"
```

---

## Task 4: Add `classifyPreflightErrors` + tests

**Files:**
- Modify: `src/tools/misra-checker-preflight.ts`
- Modify: `tests/tools/misra-checker-preflight.test.ts`

This function takes root-cause errors (already deduplicated) and decides which level of response
is appropriate.

### Step 1: Write the failing test

Append to the test file:

```typescript
import { classifyPreflightErrors } from "../../src/tools/misra-checker-preflight"

describe("classifyPreflightErrors", () => {
  test("classifies missing include errors as 'missing_headers'", () => {
    const errors: ClangError[] = [
      { file: "a.c", line: 1, col: 1, message: "'hal.h' file not found" },
      { file: "b.c", line: 1, col: 1, message: "'rtos.h' file not found" },
    ]
    const result = classifyPreflightErrors(errors)
    expect(result.pattern).toBe("missing_headers")
    expect(result.missing_headers).toContain("hal.h")
    expect(result.missing_headers).toContain("rtos.h")
  })

  test("classifies widespread type errors (>= 5 files) as 'wrong_preset'", () => {
    const errors: ClangError[] = Array.from({ length: 6 }, (_, i) => ({
      file: `src/file${i}.c`, line: 1, col: 1, message: "unknown type name 'uint8_t'",
    }))
    expect(classifyPreflightErrors(errors).pattern).toBe("wrong_preset")
  })

  test("classifies few isolated errors as 'source_defects'", () => {
    const errors: ClangError[] = [
      { file: "a.c", line: 10, col: 5, message: "expected ';' after expression" },
    ]
    expect(classifyPreflightErrors(errors).pattern).toBe("source_defects")
  })

  test("returns 'none' for empty error list", () => {
    expect(classifyPreflightErrors([]).pattern).toBe("none")
  })

  test("missing_headers takes priority over wrong_preset when both present", () => {
    const errors: ClangError[] = [
      { file: "a.c", line: 1, col: 1, message: "'hal.h' file not found" },
      ...Array.from({ length: 6 }, (_, i) => ({
        file: `src/file${i}.c`, line: 1, col: 1, message: "unknown type name 'uint8_t'",
      })),
    ]
    expect(classifyPreflightErrors(errors).pattern).toBe("missing_headers")
  })
})
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/tools/misra-checker-preflight.test.ts --test-name-pattern "classifyPreflightErrors"
```

Expected: **FAIL**

### Step 3: Implement `classifyPreflightErrors`

```typescript
export type PreflightErrorPattern = "none" | "missing_headers" | "wrong_preset" | "source_defects"

export interface PreflightClassification {
  pattern: PreflightErrorPattern
  missing_headers: string[]   // only populated when pattern === "missing_headers"
}

/**
 * Classify root-cause clang errors into an actionable pattern.
 *
 * Priority order:
 *   1. missing_headers — any "cannot open include file" → auto-repair with stubs
 *   2. wrong_preset    — >= 5 distinct files with type errors → agent retries with different preset
 *   3. source_defects  — small isolated errors → record, allow analysis to proceed
 *   4. none            — no errors
 */
export function classifyPreflightErrors(rootCauses: ClangError[]): PreflightClassification {
  if (rootCauses.length === 0) return { pattern: "none", missing_headers: [] }

  // Extract missing header names from include errors
  const missingHeaders: string[] = []
  for (const e of rootCauses) {
    if (isMissingIncludeError(e.message)) {
      // Extract header name from message: 'name.h' file not found
      const m = e.message.match(/['"]([^'"]+\.[hH][hH]*)['"]/)?.[1]
        ?? e.message.match(/['"]([^'"]+)['"]/)?.[1]
      if (m) {
        const base = m.split(/[\\/]/).pop()!
        if (!missingHeaders.includes(base)) missingHeaders.push(base)
      }
    }
  }

  if (missingHeaders.length > 0) return { pattern: "missing_headers", missing_headers: missingHeaders }

  // Check for widespread type errors across many files (threshold: 5 distinct files)
  const filesWithTypeErrors = new Set(rootCauses.map(e => e.file))
  if (filesWithTypeErrors.size >= 5) return { pattern: "wrong_preset", missing_headers: [] }

  return { pattern: "source_defects", missing_headers: [] }
}
```

### Step 4: Run test to confirm it passes

```bash
bun test tests/tools/misra-checker-preflight.test.ts --test-name-pattern "classifyPreflightErrors"
```

Expected: **PASS**

### Step 5: Commit

```bash
git add src/tools/misra-checker-preflight.ts tests/tools/misra-checker-preflight.test.ts
git commit -m "feat(preflight): add classifyPreflightErrors with tests"
```

---

## Task 5: Add `buildClangFlags` helper + tests

**Files:**
- Modify: `src/tools/misra-checker-preflight.ts`
- Modify: `tests/tools/misra-checker-preflight.test.ts`

This function reads SpecChecker's conf files and produces the `-I` / `-D` flag array for clang.

### Step 1: Write the failing test

```typescript
import { buildClangFlags } from "../../src/tools/misra-checker-preflight"
import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

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
    expect(iFlags).toContain('-IC:/spec/include')
    expect(iFlags).toContain('-IC:/project/inc')
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
})
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/tools/misra-checker-preflight.test.ts --test-name-pattern "buildClangFlags"
```

Expected: **FAIL**

### Step 3: Implement `buildClangFlags`

Add to `misra-checker-preflight.ts`. Note: `extractIncludePaths` lives in `misra-checker.ts`
(not exported). Re-implement the same logic locally to keep the preflight module self-contained:

```typescript
import { readFileSync, existsSync } from "fs"
import { join, resolve } from "path"

/**
 * Parse -i include path lines from SpecChecker conf file content.
 * Handles both quoted and unquoted forms.
 */
function parseConfIncludes(confContent: string): string[] {
  const paths: string[] = []
  for (const line of confContent.split("\n")) {
    const match = line.trim().match(/^-i\s+"?([^"]+?)"?\s*$/)
    if (match) paths.push(resolve(match[1]))
  }
  return paths
}

/**
 * Build the clang -I / -D flags from SpecChecker's emit/unit conf files.
 * Deduplicates include paths (case-insensitive on Windows).
 */
export function buildClangFlags(emitDir: string): string[] {
  const compilerConf = join(emitDir, "compiler.conf")
  const analysisConf = join(emitDir, "analysis.conf")

  const seenIncludes = new Set<string>()
  const includes: string[] = []
  const defines: string[] = []

  for (const confPath of [compilerConf, analysisConf]) {
    if (!existsSync(confPath)) continue
    const content = readFileSync(confPath, "utf-8")
    for (const p of parseConfIncludes(content)) {
      const key = process.platform === "win32" ? p.toLowerCase() : p
      if (!seenIncludes.has(key)) {
        seenIncludes.add(key)
        includes.push(`-I${p}`)
      }
    }
    defines.push(...extractDefines(content))
  }

  return [
    ...includes,
    ...defines.map(d => `-D${d}`),
  ]
}
```

### Step 4: Run test to confirm it passes

```bash
bun test tests/tools/misra-checker-preflight.test.ts --test-name-pattern "buildClangFlags"
```

Expected: **PASS**

### Step 5: Commit

```bash
git add src/tools/misra-checker-preflight.ts tests/tools/misra-checker-preflight.test.ts
git commit -m "feat(preflight): add buildClangFlags helper with tests"
```

---

## Task 6: Implement `runPreflightClangCheck` (core function)

**Files:**
- Modify: `src/tools/misra-checker-preflight.ts`

This function orchestrates the clang invocation loop (no auto-repair yet — just detection).

### Step 1: Add to `misra-checker-preflight.ts`

No new tests here — this function depends on a real clang binary. Tested via integration in Task 8.

```typescript
import { execSync } from "child_process"

export interface PreflightResult {
  passed: boolean
  files_checked: number
  root_cause_errors: ClangError[]
  classification: PreflightClassification
}

/**
 * Run clang -fsyntax-only on each source file using SpecChecker's conf flags.
 * Fail-fast: stops at the first file that produces errors.
 *
 * @param clangPath  Absolute path to clang.exe (from findClangBinary)
 * @param emitDir    Path to <projectPath>/emit/unit (contains compiler.conf, analysis.conf)
 * @param sourceFiles List of absolute source file paths (from compile_commands.json)
 */
export function runPreflightClangCheck(
  clangPath: string,
  emitDir: string,
  sourceFiles: string[],
): PreflightResult {
  const flags = buildClangFlags(emitDir)
  const flagStr = flags.join(" ")

  let filesChecked = 0
  const allErrors: ClangError[] = []

  for (const file of sourceFiles) {
    if (!existsSync(file)) continue
    filesChecked++

    let stderr = ""
    try {
      execSync(`"${clangPath}" -fsyntax-only -w ${flagStr} "${file}"`, {
        timeout: 30_000,
        stdio: ["ignore", "ignore", "pipe"],
      })
    } catch (err: any) {
      stderr = err.stderr?.toString() ?? ""
    }

    const errors = parseClangErrors(stderr)
    if (errors.length > 0) {
      allErrors.push(...errors)
      break  // fail-fast
    }
  }

  if (allErrors.length === 0) {
    return {
      passed: true,
      files_checked: filesChecked,
      root_cause_errors: [],
      classification: { pattern: "none", missing_headers: [] },
    }
  }

  const rootCauses = deduplicateCascades(allErrors)
  const classification = classifyPreflightErrors(rootCauses)

  return {
    passed: false,
    files_checked: filesChecked,
    root_cause_errors: rootCauses,
    classification,
  }
}
```

### Step 2: Commit

```bash
git add src/tools/misra-checker-preflight.ts
git commit -m "feat(preflight): implement runPreflightClangCheck core function"
```

---

## Task 7: Implement stub auto-repair loop

**Files:**
- Modify: `src/tools/misra-checker-preflight.ts`

The repair loop handles Level 1 (missing headers) automatically within the tool. It generates
stubs, re-injects the stubs directory into `analysis.conf`, and re-runs the pre-flight check.

### Step 1: Add `runPreflightWithAutoRepair` to `misra-checker-preflight.ts`

```typescript
import { mkdirSync, writeFileSync as fsWriteFileSync } from "fs"
import { dirname } from "path"
import { discoverExpectedSymbols } from "../preprocessing/include-resolver"
import { getPrebuiltStub, generateDemandStub } from "../preprocessing/standard-stubs"

// Note: generateDemandStub is in include-resolver.ts, re-check import path:
// import { discoverExpectedSymbols, generateDemandStub } from "../preprocessing/include-resolver"

const MAX_REPAIR_ITERATIONS = 3

/**
 * Run pre-flight clang check with automatic stub repair for missing headers.
 *
 * - Level 1 (missing_headers): auto-generates stubs, re-injects, retries (up to 3x)
 * - Level 2 (wrong_preset): returns result immediately for agent to handle
 * - Level 3 (source_defects): marks as passed-with-warnings, analysis proceeds
 *
 * @param stubsDir   Path to .matrix/stubs/ directory (created if absent)
 * @param analysisConf  Absolute path to emit/unit/analysis.conf (for re-injection)
 */
export function runPreflightWithAutoRepair(
  clangPath: string,
  emitDir: string,
  sourceFiles: string[],
  stubsDir: string,
  analysisConf: string,
): PreflightResult & { repair_iterations: number; auto_repaired_headers: string[] } {
  let iterations = 0
  const autoRepairedHeaders: string[] = []

  while (iterations < MAX_REPAIR_ITERATIONS) {
    const result = runPreflightClangCheck(clangPath, emitDir, sourceFiles)

    if (result.passed) {
      return { ...result, repair_iterations: iterations, auto_repaired_headers: autoRepairedHeaders }
    }

    const { pattern, missing_headers } = result.classification

    if (pattern === "missing_headers" && missing_headers.length > 0) {
      // Generate stubs for missing headers
      mkdirSync(stubsDir, { recursive: true })
      for (const headerName of missing_headers) {
        const prebuilt = getPrebuiltStub(headerName)
        const content = prebuilt
          ?? generateDemandStub(headerName, discoverExpectedSymbols(headerName, sourceFiles))
        const stubPath = join(stubsDir, headerName.includes("/") ? headerName.split("/").pop()! : headerName)
        fsWriteFileSync(stubPath, content, "utf-8")
        if (!autoRepairedHeaders.includes(headerName)) autoRepairedHeaders.push(headerName)
      }

      // Inject stubs dir into analysis.conf if not already present
      if (existsSync(analysisConf)) {
        const content = readFileSync(analysisConf, "utf-8")
        const stubsDirEntry = `-i "${stubsDir}"`
        if (!content.includes(stubsDir)) {
          fsWriteFileSync(analysisConf, content.trimEnd() + "\n" + stubsDirEntry + "\n", "utf-8")
        }
      }

      iterations++
      continue
    }

    // Level 2 (wrong_preset) or Level 3 (source_defects): return as-is
    return { ...result, repair_iterations: iterations, auto_repaired_headers: autoRepairedHeaders }
  }

  // Exhausted repair iterations — return last check result
  const finalResult = runPreflightClangCheck(clangPath, emitDir, sourceFiles)
  return { ...finalResult, repair_iterations: iterations, auto_repaired_headers: autoRepairedHeaders }
}
```

**Import note**: `generateDemandStub` is in `include-resolver.ts`. Verify the import path is
`"../preprocessing/include-resolver"` and the export exists (it does — confirmed in codebase).

### Step 2: Commit

```bash
git add src/tools/misra-checker-preflight.ts
git commit -m "feat(preflight): add stub auto-repair loop (Level 1 self-healing)"
```

---

## Task 8: Wire pre-flight into `executeCheck()` in `misra-checker.ts`

**Files:**
- Modify: `src/tools/misra-checker.ts`

### Step 1: Add import at top of `misra-checker.ts`

Near the other imports (lines 1-11), add:

```typescript
import {
  findClangBinary,
  runPreflightWithAutoRepair,
  type PreflightResult,
} from "./misra-checker-preflight"
```

### Step 2: Add helper to read source files from compile_commands.json

Add this helper function near `resolveCompilationEnv` (~line 586):

```typescript
/** Read source file list from .matrix/data/compile_commands.json */
function resolveSourceFiles(targetDir: string): string[] {
  const matrixRoot = findMatrixRoot(targetDir)
  if (!matrixRoot) return []
  const dbPath = join(matrixRoot, ".matrix", "data", "compile_commands.json")
  if (!existsSync(dbPath)) return []
  try {
    const db = JSON.parse(readFileSync(dbPath, "utf-8"))
    if (!Array.isArray(db)) return []
    return db.map((e: any) => e.file).filter(Boolean)
  } catch {
    return []
  }
}
```

### Step 3: Insert pre-flight block between Step 1.5 and Step 2

In `executeCheck()`, after line 804 (`injectCompilationConfig`) and before line 806 (`// Step 2`):

```typescript
  // Step 1.6: Pre-flight clang compilation check
  const clangBin = findClangBinary(specHome)
  if (clangBin) {
    const emitDir = join(projectPath, "emit", "unit")
    const sourceFiles = resolveSourceFiles(targetDir)

    if (sourceFiles.length > 0) {
      const stubsDir = matrixRoot ? join(matrixRoot, ".matrix", "stubs") : join(projectPath, "stubs")
      const analysisConf = join(emitDir, "analysis.conf")

      const preflight = runPreflightWithAutoRepair(
        clangBin, emitDir, sourceFiles, stubsDir, analysisConf,
      )

      if (!preflight.passed) {
        const { pattern } = preflight.classification

        if (pattern === "wrong_preset") {
          // Level 2: escalate to agent — analysis not started, no time wasted
          return JSON.stringify({
            action_required: "PREFLIGHT_WRONG_PRESET",
            message:
              "Pre-flight clang check failed: widespread type errors indicate wrong SpecChecker " +
              "preset. Re-run with a different 'compiler' parameter.",
            suggested_presets: buildAlternativePresets(compilerName),
            preflight_summary: {
              files_checked: preflight.files_checked,
              root_cause_count: preflight.root_cause_errors.length,
            },
            preflight_errors: preflight.root_cause_errors.slice(0, 20),
          })
        }

        if (pattern === "missing_headers") {
          // Level 1 exhausted: still missing headers after 3 repair iterations
          return JSON.stringify({
            action_required: "PREFLIGHT_MISSING_HEADERS",
            message:
              "Pre-flight clang check failed: missing headers could not be resolved after " +
              `${preflight.repair_iterations} stub generation attempts.`,
            missing_headers: preflight.classification.missing_headers,
            auto_repaired_headers: preflight.auto_repaired_headers,
            preflight_errors: preflight.root_cause_errors.slice(0, 20),
          })
        }

        // Level 3 (source_defects): log in result, proceed to analyze
        // preflight_source_errors will be included in the final response below
      }

      // Attach preflight outcome to final result (added later in Task 9)
      // For now just proceed — preflight result is available in `preflight` variable
    }
  }
```

### Step 4: Add `buildAlternativePresets` helper

Add near `selectSpecCheckerCompiler`:

```typescript
/**
 * Return a ranked list of alternative SpecChecker presets to try when the
 * current one causes widespread type errors.
 */
function buildAlternativePresets(currentPreset: string): string[] {
  const ALL_COMMON = ["ARM", "C51", "IAR_80", "GNUC", "ANSI"]
  return ALL_COMMON.filter(p => p !== currentPreset)
}
```

### Step 5: Build and verify no TypeScript errors

```bash
cd D:/git-rep/matrix/matrix-embedded-agent
bun run typecheck
```

Expected: **no errors**. Fix any type errors before proceeding.

### Step 6: Run all tests to verify nothing broken

```bash
bun test
```

Expected: all existing tests pass + new preflight tests pass.

### Step 7: Commit

```bash
git add src/tools/misra-checker.ts src/tools/misra-checker-preflight.ts
git commit -m "feat(preflight): wire pre-flight clang check into specchecker pipeline"
```

---

## Task 9: Surface preflight outcome in final tool response

**Files:**
- Modify: `src/tools/misra-checker.ts` — final response builder (~line 915)

The final JSON response from `executeCheck()` should include a `preflight` field so the agent
can see what happened during pre-flight (especially for Level 3 source defects).

### Step 1: Capture preflight result and include in response

After the existing violations/summary block, append preflight info to the response object.

Find the block near line 915 that builds the return JSON, and add:

```typescript
  // Include preflight outcome in response
  const preflightSummary = clangBin
    ? (typeof preflight !== "undefined"
        ? {
            status: preflight.passed ? "passed" : "passed_with_source_errors",
            files_checked: preflight.files_checked,
            repair_iterations: preflight.repair_iterations,
            auto_repaired_headers: preflight.auto_repaired_headers,
            source_errors: preflight.classification.pattern === "source_defects"
              ? preflight.root_cause_errors.slice(0, 10)
              : [],
          }
        : { status: "skipped_no_sources" })
    : { status: "skipped_clang_not_found" }
```

Add `preflight: preflightSummary` to the returned JSON object.

### Step 2: Run typecheck + tests

```bash
bun run typecheck && bun test
```

Expected: **PASS** — no type errors, all tests pass.

### Step 3: Commit

```bash
git add src/tools/misra-checker.ts
git commit -m "feat(preflight): include preflight outcome in tool response"
```

---

## Task 10: Manual integration smoke test

**Goal:** Verify the end-to-end pre-flight flow works with a real SpecChecker installation.

### Step 1: Run against the sample 8051 project

```bash
cd D:/git-rep/matrix/matrix-embedded-agent
# The 8051 project uses C51 dialect — good test for preset selection
bun run build
```

Then in OpenCode, run `specchecker` tool against `tests/sample-8051-project/` and observe:
- Pre-flight runs (`preflight.files_checked` > 0 in response)
- If C51 preset is correct: `preflight.status === "passed"` → analyze runs
- If wrong preset: `action_required: "PREFLIGHT_WRONG_PRESET"` returned before analyze starts

### Step 2: Verify fail-fast timing

Temporarily set `compiler: "ANSI"` (wrong for any embedded project) and run the tool.
Expected: response returns in seconds with `PREFLIGHT_WRONG_PRESET`, not after 600s.

### Step 3: Final commit if any adjustments made

```bash
git add -A
git commit -m "fix(preflight): adjust pre-flight integration after smoke test"
```
