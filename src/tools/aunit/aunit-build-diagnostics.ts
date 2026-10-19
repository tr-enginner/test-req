/**
 * aunit-build-diagnostics.ts
 * Parsing utilities for AUnit build output, plus platform compiler discovery.
 */

import { execSync } from "child_process"
import { existsSync, readdirSync, readFileSync } from "fs"
import { dirname, join } from "path"

const isWindows = process.platform === "win32"

export type SyntaxErrorType =
  | "unknown_extension"
  | "implicit_declaration"
  | "unknown_type"
  | "syntax_error"
  | "linker_error"
  | "other"

export interface BuildSyntaxError {
  file: string
  line: number
  column: number
  type: SyntaxErrorType
  message: string
}

/**
 * Parse AUnit/GCC-style compiler output for syntax errors.
 * Handles lines of the form:
 *   <file>:<line>:<col>: error: <message>
 *
 * Returns deduplicated list (same file+line+col deduped).
 */
export function parseSyntaxErrors(stdout: string, stderr: string): BuildSyntaxError[] {
  const combined = `${stdout}\n${stderr}`
  // GCC/Clang style: file:line:col: error: message
  const lineRe = /^(.+?):(\d+):(\d+):\s+error:\s+(.+)$/gm
  const seen = new Set<string>()
  const results: BuildSyntaxError[] = []

  let match: RegExpExecArray | null
  while ((match = lineRe.exec(combined)) !== null) {
    const [, file, lineStr, colStr, message] = match
    const line = parseInt(lineStr, 10)
    const column = parseInt(colStr, 10)
    const key = `${file}:${line}:${column}`
    if (seen.has(key)) continue
    seen.add(key)

    results.push({
      file,
      line,
      column,
      type: classifyError(message),
      message: message.trim(),
    })
  }

  return results
}

// ─── Linker error parsing ─────────────────────────────────────────────────

export interface LinkerError {
  symbol: string
  raw_message: string
}

/**
 * Parse linker errors from build output.
 * Detects GCC (`undefined reference to`), MSVC (`unresolved external symbol`),
 * and ARM linker (`Undefined symbol`) patterns.
 */
export function parseLinkerErrors(stdout: string, stderr: string): LinkerError[] {
  const combined = `${stdout}\n${stderr}`
  const seen = new Set<string>()
  const results: LinkerError[] = []

  // GCC/Clang: undefined reference to `symbol'
  for (const m of combined.matchAll(/undefined reference to [`']([^`']+)[`']/gi)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      results.push({ symbol: m[1], raw_message: m[0] })
    }
  }

  // MSVC: unresolved external symbol _symbol
  for (const m of combined.matchAll(/unresolved external symbol\s+_?(\w+)/gi)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      results.push({ symbol: m[1], raw_message: m[0] })
    }
  }

  // ARM linker: Undefined symbol symbol (referred from ...)
  for (const m of combined.matchAll(/Undefined symbol\s+(\w+)/gi)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      results.push({ symbol: m[1], raw_message: m[0] })
    }
  }

  return results
}

function classifyError(message: string): SyntaxErrorType {
  const m = message.toLowerCase()
  if (
    m.includes("attribute") ||
    m.includes("__asm__") ||
    m.includes("__packed") ||
    m.includes("__attribute") ||
    m.includes("not supported") ||
    m.includes("unknown attribute") ||
    m.includes("extension")
  ) {
    return "unknown_extension"
  }
  if (m.includes("implicit declaration")) {
    return "implicit_declaration"
  }
  if (m.includes("unknown type name") || m.includes("undeclared")) {
    return "unknown_type"
  }
  if (
    m.includes("expected") ||
    m.includes("parse error") ||
    m.includes("syntax error") ||
    m.includes("unexpected")
  ) {
    return "syntax_error"
  }
  if (
    m.includes("undefined reference") ||
    m.includes("unresolved external symbol") ||
    m.includes("undefined symbol")
  ) {
    return "linker_error"
  }
  return "other"
}

/**
 * Compiler names that are actual compilers (not headers or libraries).
 * Used to filter out false positives like "stdio.h: No such file".
 * Extended to cover common embedded toolchains.
 */
const KNOWN_COMPILER_NAMES = new Set([
  // GCC / Clang family
  "gcc", "g++", "cc", "c++", "cc1", "cc1plus", "cpp",
  "clang", "clang++", "clang-cl",
  // ARM (Keil/DS-5/DS-MDK)
  "armcc", "armclang", "armasm", "armlink", "armar",
  "arm-none-eabi-gcc", "arm-none-eabi-g++", "arm-none-eabi-as",
  "arm-linux-gnueabi-gcc", "arm-linux-gnueabihf-gcc",
  "aarch64-linux-gnu-gcc", "aarch64-none-elf-gcc",
  // IAR Embedded Workbench
  "iccarm", "iccavr", "iccrx", "icc8051", "iccrl78", "iccrh850",
  "iccar", "icc", "iararm",
  // Keil C51 / C251 (8051)
  "c51", "cx51", "c251", "a51", "a251",
  // TI Code Composer Studio
  "armcl", "cl430", "cl6x", "cl7x", "cl2000", "cl55", "cl55p", "tiarmclang",
  // Wind River / Diab Data
  "ccppc", "ccarm", "ccmips", "cc68k", "ccpentium", "ccc", "dcc", "das",
  // Green Hills Software
  "elxr", "cxppc", "cxarm", "ccarm",
  // TASKING (TriCore, PCP, etc.)
  "ctc", "etppc", "etarm", "astc",
  // Renesas
  "ccrx", "ccrl", "ccnx",
  // Microchip XC
  "xc8", "xc16", "xc32", "pic-as",
  // SDCC / TCC
  "sdcc", "tcc",
  // NXP / Freescale CodeWarrior
  "mwcceppc", "mwccarm",
  // Various cross compilers
  "xgcc",
  "msp430-elf-gcc", "powerpc-eabi-gcc",
  "xtensa-esp32-elf-gcc", "xtensa-lx106-elf-gcc",
  "riscv32-unknown-elf-gcc", "riscv64-unknown-elf-gcc",
  // MSVC
  "cl",
])

/**
 * Load compiler names from Makefile files across all platform configs.
 * Reads `<installDir>/config/platform/<name>/Makefile` for each platform,
 * extracts CC=, COMPILER=, CXX= assignments, and returns the union as a Set.
 * Combined with KNOWN_COMPILER_NAMES for comprehensive compiler detection.
 */
export function loadPlatformCompilers(installDir: string): Set<string> {
  const result = new Set<string>()
  const platformDir = join(installDir.replace(/\\/g, "/"), "config", "platform")
  if (!existsSync(platformDir)) return result

  try {
    const platforms = readdirSync(platformDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)

    for (const platform of platforms) {
      const makefilePath = join(platformDir, platform, "Makefile")
      if (!existsSync(makefilePath)) continue
      try {
        const content = readFileSync(makefilePath, "utf-8")
        for (const pattern of [
          /^CC\s*[:+]?=\s*(\S+)/m,
          /^COMPILER\s*[:+]?=\s*(\S+)/m,
          /^CXX\s*[:+]?=\s*(\S+)/m,
          /^AS\s*[:+]?=\s*(\S+)/m,
        ]) {
          const m = content.match(pattern)
          if (m?.[1]) {
            const compiler = m[1].replace(/['"]/g, "")
              .replace(/.*[/\\]/, "")   // basename
              .replace(/\.exe$/i, "")   // strip .exe
              .trim()
              .toLowerCase()
            if (compiler) result.add(compiler)
          }
        }
      } catch {
        // skip unreadable Makefile
      }
    }
  } catch {
    // skip unreadable platform dir
  }

  return result
}

/**
 * Detect "compiler not found" in build output.
 * Returns the compiler name (e.g. "gcc") or null if no compiler error.
 *
 * Patterns matched:
 *   gcc: command not found
 *   /bin/sh: 1: armcc: not found
 *   'cc1' not found
 *   armcc: No such file or directory
 *   make[2]: armcc: Command not found
 *   'c51' is not recognized as an internal or external command  (Windows CMD)
 *   'c51' 不是内部或外部命令  (Windows CMD, Chinese locale)
 *   process_begin: CreateProcess(NULL, c51 ...) failed.  (GNU Make on Windows)
 */
export function parseCompilerNotFound(
  stdout: string,
  stderr: string,
  extraCompilers?: Set<string>,
): string | null {
  const combined = `${stdout}\n${stderr}`

  // Pattern 1: "<name>: command not found" or "<name>: not found"
  const notFoundRe = /['"]?(\S+?)['"]?:\s+(?:command\s+)?not\s+found/gi
  for (const match of combined.matchAll(notFoundRe)) {
    const candidate = match[1].toLowerCase().replace(/^.*[/\\]/, "") // strip path prefix
    if (isCompilerName(candidate, extraCompilers)) return candidate
  }

  // Pattern 2: "'<name>' not found"
  const quotedRe = /['"](\S+?)['"]\s+not\s+found/gi
  for (const match of combined.matchAll(quotedRe)) {
    const candidate = match[1].toLowerCase()
    if (isCompilerName(candidate, extraCompilers)) return candidate
  }

  // Pattern 3: "<name>: No such file or directory" — only for known compilers
  const noSuchRe = /^(\S+):\s+No such file or directory/gim
  for (const match of combined.matchAll(noSuchRe)) {
    const candidate = match[1].toLowerCase().replace(/^.*[/\\]/, "")
    if (isCompilerName(candidate, extraCompilers)) return candidate
  }

  // Pattern 4: Windows CMD — 'c51' is not recognized as an internal or external command
  const notRecognizedRe = /['"](\S+?)['"]?\s+is not recognized as an? (?:internal|external)/gi
  for (const match of combined.matchAll(notRecognizedRe)) {
    const candidate = match[1].toLowerCase().replace(/\.exe$/i, "")
    if (isCompilerName(candidate, extraCompilers)) return candidate
  }

  // Pattern 5: Windows CMD (Chinese locale) — 'c51' 不是内部或外部命令
  const notRecognizedZhRe = /['"](\S+?)['"]?\s+不是内部或外部命令/gi
  for (const match of combined.matchAll(notRecognizedZhRe)) {
    const candidate = match[1].toLowerCase().replace(/\.exe$/i, "")
    if (isCompilerName(candidate, extraCompilers)) return candidate
  }

  // Pattern 6: GNU Make CreateProcess failure — process_begin: CreateProcess(NULL, c51 ...) failed.
  const createProcessRe = /CreateProcess\(\s*NULL,\s*(\S+)/gi
  for (const match of combined.matchAll(createProcessRe)) {
    const candidate = match[1].toLowerCase().replace(/\.exe$/i, "")
    if (isCompilerName(candidate, extraCompilers)) return candidate
  }

  return null
}

function isCompilerName(name: string, extra?: Set<string>): boolean {
  if (KNOWN_COMPILER_NAMES.has(name)) return true
  if (extra?.has(name)) return true
  // Common patterns: arm-xxx-gcc, xtensa-xxx-g++, etc.
  if (/^[a-z0-9_-]+-(?:gcc|g\+\+|cc|clang)$/.test(name)) return true
  // Ends with gcc / g++ / cc1 / cc1plus (cross compilers)
  if (/(?:gcc|g\+\+|cc1|cc1plus)$/.test(name)) return true
  return false
}

/**
 * Search the system globally for a compiler binary.
 * Returns the absolute path to the binary's DIRECTORY (for adding to PATH),
 * or null if not found.
 *
 * Search order:
 * 1. System PATH (where/which)
 * 2. Global filesystem search (where /R on Windows, find on Linux)
 *
 * Timeout: 10s for PATH lookup, 60s for global search.
 */
export function searchCompilerGlobal(compilerName: string): string | null {
  // 1. PATH lookup
  try {
    const cmd = isWindows ? `where ${compilerName}` : `which ${compilerName}`
    const out = execSync(cmd, { stdio: "pipe", encoding: "utf-8", timeout: 10_000 }).trim()
    const first = out.split(/\r?\n/)[0].trim()
    if (first && existsSync(first)) {
      return dirname(first)
    }
  } catch {
    // Not in PATH
  }

  // 2. Global filesystem search
  if (isWindows) {
    const drives = getWindowsDrives()
    const exeName = compilerName.endsWith(".exe") ? compilerName : `${compilerName}.exe`
    for (const drive of drives) {
      try {
        const out = execSync(`where /R ${drive}\\ ${exeName}`, {
          stdio: "pipe",
          encoding: "utf-8",
          timeout: 60_000,
        }).trim()
        const first = out.split(/\r?\n/)[0].trim()
        if (first && existsSync(first)) {
          return dirname(first)
        }
      } catch {
        // Not on this drive
      }
    }
  } else {
    // Search common locations first to avoid full-system scan
    const searchPaths = ["/usr", "/opt", "/home", "/usr/local"]
    for (const sp of searchPaths) {
      try {
        const out = execSync(
          `find ${sp} -name "${compilerName}" -type f -print -quit 2>/dev/null`,
          { stdio: "pipe", encoding: "utf-8", timeout: 60_000 },
        ).trim()
        if (out && existsSync(out)) {
          return dirname(out)
        }
      } catch {
        // Not in this search path
      }
    }
  }

  return null
}

function getWindowsDrives(): string[] {
  try {
    const output = execSync("wmic logicaldisk get name", {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 10_000,
    })
    const drives = output
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => /^[A-Z]:$/.test(l))
    return drives.length > 0 ? drives : ["C:"]
  } catch {
    return ["C:"]
  }
}

// ─── Standard runtime headers (for platform-switch heuristic) ────────────────

/**
 * Standard C runtime headers. If a large fraction of missing headers are from
 * this set, the entire toolchain / runtime path is likely wrong — switching
 * the AUnit platform is more productive than patching individual include paths.
 */
const STANDARD_RUNTIME_HEADERS = new Set([
  "stdint.h", "stdio.h", "stdlib.h", "string.h", "stddef.h",
  "stdbool.h", "stdarg.h", "limits.h", "float.h", "math.h",
  "errno.h", "assert.h", "ctype.h", "signal.h", "time.h",
  "setjmp.h", "locale.h",
])

// ─── Missing header parsing ──────────────────────────────────────────────────

/**
 * Extract missing header file names from build output.
 * Returns just the filename (not the full path) for each missing header,
 * deduplicated. Handles GCC, Clang, ARMCC, MSVC, and IAR error formats.
 */
export function parseMissingHeaders(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`
  const headers = new Set<string>()

  // GCC/Clang: fatal error: foo.h: No such file or directory
  for (const m of combined.matchAll(/fatal error:\s+([^\s:]+\.h(?:pp|xx)?)\s*:/gi)) {
    headers.add(m[1].replace(/.*[/\\]/, "")) // basename only
  }

  // ARMCC: #include <foo.h>: failed to open source file
  for (const m of combined.matchAll(/failed to open source file\s+[<"']?([^>'"\s]+\.h(?:pp|xx)?)/gi)) {
    headers.add(m[1].replace(/.*[/\\]/, ""))
  }

  // MSVC / ARMCC: Cannot open include file: 'stdio.h'
  for (const m of combined.matchAll(/Cannot open include file:\s+['"]([^'"]+\.h(?:pp|xx)?)['"]/gi)) {
    headers.add(m[1].replace(/.*[/\\]/, ""))
  }

  // IAR: Error[Pe1696]: cannot open source file "FreeRTOS.h"
  for (const m of combined.matchAll(/cannot open source file\s+["']([^"']+\.h(?:pp|xx)?)["']/gi)) {
    headers.add(m[1].replace(/.*[/\\]/, ""))
  }

  // Generic: No such file or directory for .h files (catch-all)
  for (const m of combined.matchAll(/([^\s'"<>:]+\.h(?:pp|xx)?)['">\s]*:\s+No such file/gi)) {
    const name = m[1].replace(/.*[/\\]/, "")
    if (!name.includes(" ")) headers.add(name)
  }

  return Array.from(headers)
}

// ─── Unified build error analysis ────────────────────────────────────────────

/**
 * Recommended primary fix strategy from build error analysis.
 * Used by the build tool to determine the next auto-fix action.
 */
export type BuildFixStrategy =
  | "add_includes"        // Add header search paths to universal.conf inc=
  | "find_compiler"       // Compiler binary not in PATH — search and add path=
  | "preprocessor_needed" // Dialect extensions need code_preprocessor translation
  | "check_env"           // An env= path in universal.conf is wrong or missing
  | "add_da_macros"       // Missing macro definitions → add da= entries to conf
  | "fix_linker"          // Linker errors (undefined references) need stub/lib fixes
  | "check_makefile"      // Makefile template issues — inspect and fix project Makefile
  | "unknown"             // Could not determine fix strategy

export interface RecommendedAction {
  action: "add_inc" | "add_da" | "add_path" | "run_preprocessor"
        | "check_makefile" | "add_stub" | "fix_linker"
  target: string
  value?: string
  reason: string
  affected_files?: string[]
}

export interface BuildErrorAnalysis {
  /** Header filenames that could not be found (e.g. ["stdint.h", "FreeRTOS.h"]) */
  missing_headers: string[]
  /** Compiler binary not found in PATH (e.g. "armcc") */
  compiler_not_found: string | null
  /** Structured per-error breakdown */
  syntax_errors: BuildSyntaxError[]
  /** Linker errors (undefined references / unresolved symbols) */
  linker_errors: LinkerError[]
  /** Recommended primary fix action */
  primary_fix: BuildFixStrategy
  /** Human-readable summary of what was found and what to do */
  summary: string
  /** Structured recommended actions for automated fix */
  recommended_actions: RecommendedAction[]
  /** Files with dialect-specific constructs and their detected dialect hints */
  dialect_files?: { file: string; dialect_hint: string }[]
  /** Whether the error pattern suggests a platform mismatch that conf-level fixes cannot resolve */
  recommend_platform_switch: boolean
  /** Reason for recommending platform switch */
  platform_switch_reason?: string
}

/**
 * Unified build error classifier.
 *
 * Parses stdout + stderr and returns a structured analysis with a recommended
 * fix strategy. When `installDir` is provided, compiler names extracted from
 * platform Makefiles are included in the "compiler not found" detection.
 */
// ─── da= macro heuristics ─────────────────────────────────────────────────

/**
 * Well-known macro → symbol associations for embedded SDKs.
 * When we see implicit_declaration / unknown_type errors matching these
 * symbols and no missing headers are found, we suggest the corresponding
 * da= macro as a fix.
 */
const DA_MACRO_HINTS: Array<{ pattern: RegExp; macro: string; value?: string }> = [
  // STM32 HAL
  { pattern: /\bHAL_\w+/i, macro: "USE_HAL_DRIVER" },
  { pattern: /\bHSE_VALUE\b/i, macro: "HSE_VALUE", value: "8000000" },
  { pattern: /\bHSI_VALUE\b/i, macro: "HSI_VALUE", value: "16000000" },
  // FreeRTOS
  { pattern: /\bpdTRUE\b|\bpdFALSE\b|\bportTICK_PERIOD_MS\b/i, macro: "USE_FREERTOS" },
  // CMSIS
  { pattern: /\b__NVIC_PRIO_BITS\b/i, macro: "__NVIC_PRIO_BITS", value: "4" },
  // Generic "USE_STDPERIPH_DRIVER" for older STM32 SPL
  { pattern: /\bGPIO_Pin_\d+\b|\bRCC_APB\d/i, macro: "USE_STDPERIPH_DRIVER" },
]

/**
 * Dialect hint detection patterns: maps error-triggering constructs to
 * compiler dialect names used in the preprocessing pipeline.
 */
const DIALECT_HINT_PATTERNS: Array<{ pattern: RegExp; dialect: string }> = [
  { pattern: /__packed\b|__packed__/i, dialect: "armcc" },
  { pattern: /\bsfr\b|\bsbit\b|\bxdata\b|\bidata\b/i, dialect: "c51" },
  { pattern: /\b__interrupt\b|\b__near\b|\b__far\b/i, dialect: "iar" },
  { pattern: /\bcregister\b|\b__cregister\b/i, dialect: "ti" },
  { pattern: /__attribute__\s*\(\s*\(\s*section/i, dialect: "gcc" },
]

export function parseBuildErrors(
  stdout: string,
  stderr: string,
  installDir?: string,
): BuildErrorAnalysis {
  const platformCompilers = installDir ? loadPlatformCompilers(installDir) : undefined

  const missingHeaders = parseMissingHeaders(stdout, stderr)
  const compilerNotFound = parseCompilerNotFound(stdout, stderr, platformCompilers)
  const syntaxErrors = parseSyntaxErrors(stdout, stderr)
  const linkerErrors = parseLinkerErrors(stdout, stderr)

  const combined = `${stdout}\n${stderr}`
  const hasEnvPathError =
    /No such file or directory/i.test(combined) && !missingHeaders.length

  const extensionErrors = syntaxErrors.filter((e) => e.type === "unknown_extension")
  const typeErrors = syntaxErrors.filter(
    (e) => e.type === "unknown_type" || e.type === "implicit_declaration",
  )

  const recommendedActions: RecommendedAction[] = []

  // ── Collect recommended actions from all detected issues ──

  // Missing headers → add_inc actions
  for (const h of missingHeaders) {
    recommendedActions.push({
      action: "add_inc",
      target: h,
      reason: `Header file "${h}" not found`,
    })
  }

  // Compiler not found → add_path action
  if (compilerNotFound) {
    recommendedActions.push({
      action: "add_path",
      target: compilerNotFound,
      reason: `Compiler "${compilerNotFound}" not found in PATH`,
    })
  }

  // Extension errors → run_preprocessor actions grouped by dialect
  if (extensionErrors.length > 0) {
    const fileDialects = new Map<string, string>()
    for (const err of extensionErrors) {
      for (const { pattern, dialect } of DIALECT_HINT_PATTERNS) {
        if (pattern.test(err.message)) {
          fileDialects.set(err.file, dialect)
          break
        }
      }
    }
    const affectedFiles = [...new Set(extensionErrors.map(e => e.file))]
    recommendedActions.push({
      action: "run_preprocessor",
      target: affectedFiles[0] ?? "source",
      reason: `${extensionErrors.length} dialect extension error(s) need translation`,
      affected_files: affectedFiles,
    })
  }

  // da= macro candidates: when type/implicit errors exist but no missing headers
  const daMacrosSuggested = new Set<string>()
  if (typeErrors.length > 0 && missingHeaders.length === 0) {
    for (const err of typeErrors) {
      for (const { pattern, macro, value } of DA_MACRO_HINTS) {
        if (pattern.test(err.message) && !daMacrosSuggested.has(macro)) {
          daMacrosSuggested.add(macro)
          recommendedActions.push({
            action: "add_da",
            target: macro,
            value,
            reason: `Error "${err.message}" suggests missing macro definition`,
            affected_files: [err.file],
          })
        }
      }
    }
  }

  // Linker errors → fix_linker / add_stub actions
  for (const le of linkerErrors) {
    recommendedActions.push({
      action: "fix_linker",
      target: le.symbol,
      reason: `Undefined symbol "${le.symbol}" — provide stub or link the library`,
    })
  }

  // ── Dialect file info ──
  let dialectFiles: { file: string; dialect_hint: string }[] | undefined
  if (extensionErrors.length > 0) {
    const fileMap = new Map<string, string>()
    for (const err of extensionErrors) {
      if (fileMap.has(err.file)) continue
      for (const { pattern, dialect } of DIALECT_HINT_PATTERNS) {
        if (pattern.test(err.message)) {
          fileMap.set(err.file, dialect)
          break
        }
      }
    }
    if (fileMap.size > 0) {
      dialectFiles = [...fileMap.entries()].map(([file, dialect_hint]) => ({ file, dialect_hint }))
    }
  }

  // ── Determine primary fix (priority order) ──
  // find_compiler > add_includes > add_da_macros > preprocessor_needed > fix_linker > check_env > check_makefile > unknown
  let primaryFix: BuildFixStrategy
  let summary: string

  if (compilerNotFound) {
    primaryFix = "find_compiler"
    summary =
      `Compiler "${compilerNotFound}" not found. ` +
      `Search globally and add its directory to universal.conf path=.`
  } else if (missingHeaders.length > 0) {
    primaryFix = "add_includes"
    const listed = missingHeaders.slice(0, 5).join(", ")
    const more = missingHeaders.length > 5 ? ` (+${missingHeaders.length - 5} more)` : ""
    summary =
      `${missingHeaders.length} header file(s) not found: ${listed}${more}. ` +
      `Add the directory containing these headers to universal.conf inc=.`
  } else if (daMacrosSuggested.size > 0) {
    primaryFix = "add_da_macros"
    const listed = [...daMacrosSuggested].slice(0, 3).join(", ")
    summary =
      `${typeErrors.length} unknown type / implicit declaration error(s) with no missing headers. ` +
      `Suggested da= macros: ${listed}. Add to universal.conf.`
  } else if (extensionErrors.length > 0) {
    primaryFix = "preprocessor_needed"
    summary =
      `${extensionErrors.length} compiler dialect extension error(s) ` +
      `(e.g. __packed__, __attribute__). Run code_preprocessor to translate to standard C/C++.`
  } else if (typeErrors.length > 0) {
    // Unknown types usually come from missing includes
    primaryFix = "add_includes"
    summary =
      `${typeErrors.length} unknown type / implicit declaration error(s). ` +
      `Likely missing include paths for type definitions.`
  } else if (linkerErrors.length > 0 && syntaxErrors.length === 0) {
    primaryFix = "fix_linker"
    const listed = linkerErrors.slice(0, 3).map(e => e.symbol).join(", ")
    summary =
      `${linkerErrors.length} linker error(s): undefined symbol(s) ${listed}. ` +
      `Provide stub implementations or link the required library.`
  } else if (hasEnvPathError) {
    primaryFix = "check_env"
    summary =
      `Path not found errors detected but no specific header identified. ` +
      `Check env= path entries in universal.conf.`
  } else if (syntaxErrors.length > 0) {
    primaryFix = "preprocessor_needed"
    summary = `${syntaxErrors.length} compilation error(s). Review syntax or run code_preprocessor.`
  } else {
    primaryFix = "unknown"
    summary = "Build failed but no specific error pattern was recognised. Review stdout/stderr."
  }

  // ── Platform switch recommendation ──
  let recommendPlatformSwitch = false
  let platformSwitchReason: string | undefined

  if (compilerNotFound) {
    recommendPlatformSwitch = true
    platformSwitchReason =
      `Compiler "${compilerNotFound}" not found on this system. ` +
      `A different AUnit platform may use an available compiler.`
  } else {
    const standardMissing = missingHeaders.filter((h) =>
      STANDARD_RUNTIME_HEADERS.has(h.toLowerCase()),
    )
    if (standardMissing.length >= 3) {
      recommendPlatformSwitch = true
      platformSwitchReason =
        `${standardMissing.length} standard C runtime headers missing ` +
        `(${standardMissing.slice(0, 5).join(", ")}). ` +
        `This indicates the toolchain/runtime path is fundamentally wrong.`
    } else if (
      syntaxErrors.length > 0 &&
      extensionErrors.length / syntaxErrors.length >= 0.5
    ) {
      recommendPlatformSwitch = true
      platformSwitchReason =
        `${extensionErrors.length}/${syntaxErrors.length} errors are dialect extension errors. ` +
        `The platform compiler type likely does not match the source code dialect.`
    }
  }

  return {
    missing_headers: missingHeaders,
    compiler_not_found: compilerNotFound,
    syntax_errors: syntaxErrors,
    linker_errors: linkerErrors,
    primary_fix: primaryFix,
    summary,
    recommended_actions: recommendedActions,
    dialect_files: dialectFiles,
    recommend_platform_switch: recommendPlatformSwitch,
    platform_switch_reason: platformSwitchReason,
  }
}

// ─── Runtime memory access error parsing ─────────────────────────────────────

export interface MemoryAccessError {
  /** Hex address string (without 0x prefix) that caused the violation */
  addr: string
  /** Program counter at the time of violation (without 0x prefix) */
  pc: string
}

/**
 * Parse AUnit simulator "内存访问越界" (memory access out-of-bounds) errors.
 * These occur at runtime when the executed code accesses an address not declared
 * in the template.vte [PhyMem] section.
 *
 * Matches patterns:
 *   内存访问越界：addr=02000000，PC=40000100
 *   内存访问越界:addr=02000000,PC=40000100
 *   memory access out of bounds: addr=02000000, PC=40000100
 *
 * Returns deduplicated list of {addr, pc}.
 */
export function parseMemoryAccessErrors(stdout: string, stderr: string): MemoryAccessError[] {
  const combined = `${stdout}\n${stderr}`
  const results: MemoryAccessError[] = []
  const seenAddrs = new Set<string>()

  // Chinese: 内存访问越界：addr=xxx，PC=yyy  (full-width or half-width punctuation)
  // English: memory access out of bounds: addr=xxx, PC=yyy
  const re = /(?:内存访问越界|memory\s+access\s+out\s+of\s+bounds)\s*[：:]\s*addr\s*=\s*([0-9a-fA-F]+)\s*[，,]\s*PC\s*=\s*([0-9a-fA-F]+)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(combined)) !== null) {
    const addr = match[1].toLowerCase()
    if (seenAddrs.has(addr)) continue
    seenAddrs.add(addr)
    results.push({ addr, pc: match[2].toLowerCase() })
  }

  return results
}

// ─── Makefile template diagnostics ────────────────────────────────────────

export interface MakefileCompileInfo {
  compiler: string | null
  include_paths: string[]   // -I entries
  defines: string[]         // -D entries
  flags: string[]           // other compiler flags
  raw_compile_line: string
}

/**
 * Parse compile command info from an AUnit-generated Makefile.
 * Extracts CC=, -I, -D, and other flags from the CFLAGS / COMPILE lines.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function parseMakefileCompileCommand(makefilePath: string): MakefileCompileInfo | null {
  if (!existsSync(makefilePath)) return null

  let content: string
  try {
    content = readFileSync(makefilePath, "utf-8")
  } catch {
    return null
  }

  // Extract compiler name from CC= or COMPILER=
  let compiler: string | null = null
  const ccMatch = content.match(/^(?:CC|COMPILER)\s*[:+]?=\s*(\S+)/m)
  if (ccMatch) {
    compiler = ccMatch[1].replace(/['"]/g, "")
  }

  // Collect all -I, -D, and other flags from CFLAGS, COMPILE, EXTRA_CFLAGS lines
  const flagLines: string[] = []
  for (const m of content.matchAll(/^(?:CFLAGS|COMPILE|EXTRA_CFLAGS|CC_FLAGS)\s*[:+]?=\s*(.+)$/gm)) {
    flagLines.push(m[1].trim())
  }

  // Also look for continuation lines with gcc/cc invocation containing -I/-D
  for (const m of content.matchAll(/(?:gcc|g\+\+|cc|armcc|clang)\s+(.+-[ID]\S+.*)$/gm)) {
    flagLines.push(m[1].trim())
  }

  const rawCompileLine = flagLines.join(" ")
  const includePaths: string[] = []
  const defines: string[] = []
  const flags: string[] = []

  // Tokenize — split on spaces but respect quotes
  const tokens = rawCompileLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith("-I")) {
      const path = t.length > 2 ? t.slice(2) : (i + 1 < tokens.length ? tokens[++i] : undefined)
      if (path) includePaths.push(path.replace(/['"]/g, ""))
    } else if (t.startsWith("-D")) {
      const def = t.length > 2 ? t.slice(2) : (i + 1 < tokens.length ? tokens[++i] : undefined)
      if (def) defines.push(def.replace(/['"]/g, ""))
    } else if (t.startsWith("-")) {
      flags.push(t)
    }
  }

  return { compiler, include_paths: includePaths, defines, flags, raw_compile_line: rawCompileLine }
}

export interface MakefileDiagnostic {
  template_path: string
  function_path: string | null
  template_info: MakefileCompileInfo | null
  function_info: MakefileCompileInfo | null
  missing_in_template: { includes: string[]; defines: string[]; flags: string[] }
  suggestions: RecommendedAction[]
}

/**
 * Compare the base Makefile template with a function-level Makefile (if any)
 * and report missing -I, -D, or flag entries.
 *
 * @param projectPath  AUnit project root (contains meta/data/...)
 * @param sourceFileName  Base name of the source file (e.g. "main.c"), used to locate function dirs
 * @param functionName  Function name to locate function-level Makefile
 */
export function diagnoseMakefileTemplate(
  projectPath: string,
  sourceFileName?: string,
  functionName?: string,
): MakefileDiagnostic {
  const templatePath = join(projectPath, "meta", "data", "common", "base", "makefile")
  const templateInfo = parseMakefileCompileCommand(templatePath)

  let functionPath: string | null = null
  let functionInfo: MakefileCompileInfo | null = null

  if (sourceFileName && functionName) {
    // Function-level Makefiles live in meta/data/UT/uniform/<filename>_xxxx/<funcName>/makefile
    // The _xxxx suffix varies, so we scan for matching directories
    const uniformDir = join(projectPath, "meta", "data", "UT", "uniform")
    const baseName = sourceFileName.replace(/\.[^.]+$/, "") // strip extension
    if (existsSync(uniformDir)) {
      try {
        const candidates = readdirSync(uniformDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name.startsWith(baseName + "_"))
          .map(d => d.name)

        for (const candidate of candidates) {
          const funcMakefile = join(uniformDir, candidate, functionName, "makefile")
          if (existsSync(funcMakefile)) {
            functionPath = funcMakefile
            functionInfo = parseMakefileCompileCommand(funcMakefile)
            break
          }
        }
      } catch {
        // scan failed — skip
      }
    }
  }

  // Compare: find entries in function-level that are missing from template
  const missingIncludes: string[] = []
  const missingDefines: string[] = []
  const missingFlags: string[] = []
  const suggestions: RecommendedAction[] = []

  if (templateInfo && functionInfo) {
    const templateIncs = new Set(templateInfo.include_paths.map(p => p.toLowerCase()))
    const templateDefs = new Set(templateInfo.defines.map(d => d.split("=")[0].toLowerCase()))
    const templateFlags = new Set(templateInfo.flags)

    for (const inc of functionInfo.include_paths) {
      if (!templateIncs.has(inc.toLowerCase())) missingIncludes.push(inc)
    }
    for (const def of functionInfo.defines) {
      if (!templateDefs.has(def.split("=")[0].toLowerCase())) missingDefines.push(def)
    }
    for (const flag of functionInfo.flags) {
      if (!templateFlags.has(flag)) missingFlags.push(flag)
    }

    if (missingIncludes.length > 0) {
      suggestions.push({
        action: "add_inc",
        target: templatePath,
        reason: `${missingIncludes.length} include path(s) present in function Makefile but missing from base template`,
        affected_files: missingIncludes,
      })
    }
    if (missingDefines.length > 0) {
      for (const def of missingDefines) {
        const [name, value] = def.split("=")
        suggestions.push({
          action: "add_da",
          target: name,
          value: value,
          reason: `Define -D${def} present in function Makefile but missing from base template`,
        })
      }
    }
  } else if (!templateInfo) {
    suggestions.push({
      action: "check_makefile",
      target: templatePath,
      reason: "Base Makefile template not found or could not be parsed",
    })
  }

  return {
    template_path: templatePath,
    function_path: functionPath,
    template_info: templateInfo,
    function_info: functionInfo,
    missing_in_template: {
      includes: missingIncludes,
      defines: missingDefines,
      flags: missingFlags,
    },
    suggestions,
  }
}
