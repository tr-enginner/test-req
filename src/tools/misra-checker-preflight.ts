/**
 * Pre-flight compilation check helpers for misra-checker.
 * Exported separately for unit testing.
 */

import { execSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs"
import { join, resolve } from "path"

/**
 * Extract all -d define values from a SpecChecker conf file content.
 * Handles both quoted (-d "NAME=VAL") and unquoted (-d NAME) forms.
 */
export function extractDefines(confContent: string): string[] {
  const defines: string[] = []
  for (const line of confContent.split("\n")) {
    const match = line.trim().match(/^-d\s+"?([^"]+?)"?\s*$/) // \s*$ absorbs trailing \r from CRLF files
    if (match) defines.push(match[1])
  }
  return defines
}

/**
 * Locate the clang binary bundled with SpecChecker.
 * SpecChecker ships clang under <specHome>/tools/clang/.
 * Returns the absolute path to the binary, or null if not found.
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
  // (.+?) uses lazy matching, but regex backtracking ensures Windows drive-letter paths
  // (e.g. C:/path/file.c) are parsed correctly: the engine extends the capture until the
  // mandatory :(\d+):(\d+): suffix can be satisfied, so the colon in "C:" is absorbed
  // into the file capture group rather than treated as a field delimiter.
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
 * Extract the base header filename from a missing-include error message.
 * Returns null if the error is not a missing-include or the name cannot be parsed.
 */
function extractMissingHeaderName(message: string): string | null {
  if (!isMissingIncludeError(message)) return null
  const m = message.match(/['"]([^'"]+\.[hH][hH]*)['"]/)?.[1]
    ?? message.match(/['"]([^'"]+)['"]/)?.[1]
  if (!m) return null
  return m.split(/[\\/]/).pop()!
}

/**
 * Remove cascade errors caused by a missing include.
 * When a file has a "cannot open include file" error, all subsequent
 * type/identifier errors in the same file are suppressed as non-root-cause cascades.
 */
export function deduplicateCascades(errors: ClangError[]): ClangError[] {
  const byFile = new Map<string, ClangError[]>()
  for (const e of errors) {
    if (!byFile.has(e.file)) byFile.set(e.file, [])
    byFile.get(e.file)!.push(e)
  }

  const rootCauses: ClangError[] = []
  for (const fileErrors of byFile.values()) {
    fileErrors.sort((a, b) => a.line - b.line || a.col - b.col)
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

/**
 * Parse SpecChecker conf files and extract all compilation-relevant flags,
 * translating them to clang-compatible equivalents.
 *
 * SpecChecker conf flag types and their clang mappings:
 *   -i "path"     → -I<path>          (system include path)
 *   -q "path"     → -iquote <path>    (quote include path)
 *   -d "MACRO"    → -D<MACRO>         (preprocessor define)
 *   -p "file"     → -include <file>   (force-include / compat header)
 *   -c <args>     → <args>            (clang pass-through, e.g. --sysroot, -ferror-limit)
 *
 * Flags that are SpecChecker-internal and NOT passed to clang:
 *   -t (preset name), -s (type widths), -f (output format),
 *   -lang (language), -o (output path), -filte (filter)
 */
function parseConfFile(confContent: string, specHome: string): {
  includes: string[]
  quoteIncludes: string[]
  defines: string[]
  preIncludes: string[]
  passthrough: string[]
} {
  const includes: string[] = []
  const quoteIncludes: string[] = []
  const defines: string[] = []
  const preIncludes: string[] = []
  const passthrough: string[] = []

  for (const rawLine of confContent.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    // -i "path" — system include
    const iMatch = line.match(/^-i\s+"?([^"]+?)"?\s*$/)
    if (iMatch) {
      const p = iMatch[1].replace(/%install%/g, specHome)
      includes.push(resolve(p))
      continue
    }

    // -q "path" — quote include
    const qMatch = line.match(/^-q\s+"?([^"]+?)"?\s*$/)
    if (qMatch) {
      const p = qMatch[1].replace(/%install%/g, specHome)
      quoteIncludes.push(resolve(p))
      continue
    }

    // -d "MACRO" or -d MACRO — define
    const dMatch = line.match(/^-d\s+"?([^"]+?)"?\s*$/)
    if (dMatch) {
      defines.push(dMatch[1])
      continue
    }

    // -p "file" — pre-include (compat header)
    const pMatch = line.match(/^-p\s+"?([^"]+?)"?\s*$/)
    if (pMatch) {
      const p = pMatch[1].replace(/%install%/g, specHome)
      preIncludes.push(resolve(p))
      continue
    }

    // -c <args> — clang pass-through
    const cMatch = line.match(/^-c\s+(.+)$/)
    if (cMatch) {
      const arg = cMatch[1].trim().replace(/%install%/g, specHome)
      passthrough.push(arg)
      continue
    }
  }

  return { includes, quoteIncludes, defines, preIncludes, passthrough }
}

/**
 * Build clang flags from SpecChecker's emit directory conf files.
 *
 * Reads compiler.conf and analysis.conf (the same files SpecChecker's analyze
 * step uses), translating all compilation-relevant flags to clang equivalents.
 * This ensures preflight clang checks use the same parameters as SpecChecker.
 *
 * @param specHome  SpecChecker installation root (for %install% expansion)
 */
export function buildClangFlags(emitDir: string, specHome?: string): string[] {
  const compilerConf = join(emitDir, "compiler.conf")
  const analysisConf = join(emitDir, "analysis.conf")
  const home = specHome ?? ""

  const seenIncludes = new Set<string>()
  const seenDefines = new Set<string>()
  const flags: string[] = []

  for (const confPath of [compilerConf, analysisConf]) {
    if (!existsSync(confPath)) continue
    const content = readFileSync(confPath, "utf-8")
    const parsed = parseConfFile(content, home)

    // -I (system includes)
    for (const p of parsed.includes) {
      const key = process.platform === "win32" ? p.toLowerCase() : p
      if (!seenIncludes.has(key)) {
        seenIncludes.add(key)
        flags.push(`-I${p}`)
      }
    }

    // -iquote (quote includes)
    for (const p of parsed.quoteIncludes) {
      const key = process.platform === "win32" ? p.toLowerCase() : p
      if (!seenIncludes.has(key)) {
        seenIncludes.add(key)
        flags.push(`-iquote`)
        flags.push(p)
      }
    }

    // -D (defines)
    for (const d of parsed.defines) {
      if (!seenDefines.has(d)) {
        seenDefines.add(d)
        flags.push(`-D${d}`)
      }
    }

    // -include (pre-include files)
    for (const p of parsed.preIncludes) {
      if (existsSync(p)) {
        flags.push(`-include`)
        flags.push(p)
      }
    }

    // pass-through (clang-native args)
    for (const arg of parsed.passthrough) {
      flags.push(arg)
    }
  }

  return flags
}

/**
 * Log a clang preflight command to .matrix/log/preflight_clang.log.
 * Mirrors the specchecker_cmd.log format used by misra-checker.ts.
 */
function logClangCmd(logDir: string | null, cmd: string, result?: string): void {
  if (!logDir) return
  try {
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, "preflight_clang.log")
    const timestamp = new Date().toISOString()
    let entry = `[${timestamp}] ${cmd}\n`
    if (result) entry += `  → ${result}\n`
    appendFileSync(logPath, entry, "utf-8")
  } catch { /* ignore logging errors */ }
}

export interface UnfixableFile {
  file: string
  errors: ClangError[]
}

/**
 * Run clang -fsyntax-only on a single source file.
 * Returns parsed root-cause errors (after cascade dedup) and missing header names.
 */
export function checkSingleFile(
  clangPath: string,
  flagStr: string,
  file: string,
  logDir?: string | null,
): { passed: boolean; rootCauses: ClangError[]; missingHeaders: string[] } {
  const cmd = `"${clangPath}" -fsyntax-only -w ${flagStr} "${file}"`
  let stderr = ""
  try {
    execSync(cmd, {
      timeout: 30_000,
      stdio: ["ignore", "ignore", "pipe"],
    })
    logClangCmd(logDir ?? null, cmd, "PASS")
  } catch (err: any) {
    stderr = err.stderr?.toString() ?? ""
    logClangCmd(logDir ?? null, cmd, `FAIL (${parseClangErrors(stderr).length} errors)`)
  }

  const errors = parseClangErrors(stderr)
  if (errors.length === 0) {
    return { passed: true, rootCauses: [], missingHeaders: [] }
  }

  const rootCauses = deduplicateCascades(errors)
  const missingHeaders: string[] = []
  for (const e of rootCauses) {
    const header = extractMissingHeaderName(e.message)
    if (header && !missingHeaders.includes(header)) missingHeaders.push(header)
  }

  return { passed: false, rootCauses, missingHeaders }
}
