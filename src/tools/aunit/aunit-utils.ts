import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { join, dirname, resolve } from "path"
import { exec, execSync, spawn } from "child_process"
import { decodeGbk } from "./gbk-encoding"

// ─── universal.conf types ───────────────────────────────────────────────────

export type UniversalConfEntryType = "env" | "inc" | "path" | "da" | "comment" | "blank" | "unknown"

export interface UniversalConfEntry {
  type: UniversalConfEntryType
  raw: string     // original line (without trailing newline)
  name?: string   // env / da: variable or macro name
  value?: string  // env / da / inc / path: the value portion
}

export interface ParsedUniversalConf {
  entries: UniversalConfEntry[]
}

/**
 * Parse a universal.conf file (located in the AUnit project root directory).
 * Returns null if the file doesn't exist.
 */
export function parseUniversalConf(confPath: string): ParsedUniversalConf | null {
  if (!existsSync(confPath)) return null

  const content = readFileSync(confPath, "utf-8")
  const entries: UniversalConfEntry[] = []

  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim()

    if (trimmed === "") {
      entries.push({ type: "blank", raw })
      continue
    }
    if (trimmed.startsWith("#")) {
      entries.push({ type: "comment", raw })
      continue
    }

    // env NAME=VALUE
    const envMatch = trimmed.match(/^env\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (envMatch) {
      entries.push({ type: "env", raw, name: envMatch[1], value: envMatch[2] })
      continue
    }

    // inc=PATH
    const incMatch = trimmed.match(/^inc=(.*)$/)
    if (incMatch) {
      entries.push({ type: "inc", raw, value: incMatch[1] })
      continue
    }

    // path=DIR
    const pathMatch = trimmed.match(/^path=(.*)$/)
    if (pathMatch) {
      entries.push({ type: "path", raw, value: pathMatch[1] })
      continue
    }

    // da NAME=VALUE  (value may be empty)
    const daMatch = trimmed.match(/^da\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/)
    if (daMatch) {
      entries.push({ type: "da", raw, name: daMatch[1], value: daMatch[2] ?? "" })
      continue
    }

    entries.push({ type: "unknown", raw })
  }

  return { entries }
}

/** Returns true if a string looks like a filesystem path (not a plain number/word) */
function isPathLike(value: string): boolean {
  if (!value || value.trim() === "") return false
  return /[/\\]/.test(value) || /^[A-Za-z]:/.test(value) || /%[^%]+%/.test(value)
}

// ─── %envName% expansion ─────────────────────────────────────────────────────

/**
 * Build a name→value lookup map for expanding `%envName%` tokens in
 * universal.conf `inc=` and `path=` entries.
 *
 * Priority order (highest wins):
 * 1. Built-in AUnit variables — `AUNIT_HOME` is always the AUnit installation
 *    directory. It is injected automatically when `installDir` is provided;
 *    no `env AUNIT_HOME=…` line is needed in universal.conf.
 * 2. Conf-defined `env NAME=VALUE` entries.
 * 3. Current process environment (`process.env`) as low-priority fallback.
 *
 * All keys are stored lowercase so that expandEnvRefs() can match
 * case-insensitively (Windows CMD.EXE semantics).
 *
 * @param parsed   Parsed universal.conf.
 * @param installDir  AUnit installation directory (resolves `%AUNIT_HOME%`).
 */
export function buildEnvMap(
  parsed: ParsedUniversalConf,
  installDir?: string,
): Map<string, string> {
  const map = new Map<string, string>()

  // Priority 3: process.env (lowest)
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      map.set(k.toLowerCase(), v)
    }
  }

  // Priority 2: conf-defined env entries
  for (const entry of parsed.entries) {
    if (entry.type === "env" && entry.name && entry.value !== undefined) {
      map.set(entry.name.toLowerCase(), entry.value)
    }
  }

  // Priority 1: built-in AUnit variable — always authoritative
  if (installDir) {
    map.set("aunit_home", normalizePath(installDir))
  }

  return map
}

/**
 * Expand all `%envName%` tokens in `value` using `envMap`.
 *
 * - Matching is case-insensitive (Windows CMD.EXE semantics).
 * - Unresolvable tokens are left unchanged (not stripped).
 * - Single-pass: nested references like `%A%%B%` are resolved in one pass.
 * - The original file content is never modified — this function is for
 *   in-memory comparison and validation only.
 */
export function expandEnvRefs(value: string, envMap: Map<string, string>): string {
  return value.replace(/%([^%\r\n]+)%/g, (_match, name: string) => {
    return envMap.get(name.toLowerCase()) ?? _match
  })
}

/**
 * Validate and resolve `env NAME=VALUE` path entries in a parsed universal.conf.
 *
 * For each `env NAME=VALUE` where VALUE looks like a path:
 * 1. existsSync(VALUE) → keep as-is
 * 2. process.env[NAME] exists on disk → update VALUE, record in warnings
 * 3. Infer the tool from NAME and search PATH → update VALUE, record in warnings
 * 4. Nothing found → keep original, add entry to env_search_needed (agent should ask user)
 *
 * `inc=` and `path=` entries are NOT touched — AUnit expands %envName% tokens
 * at runtime automatically; no pre-expansion or validation is needed here.
 *
 * da entries are NOT modified.
 *
 * @param parsed      Parsed universal.conf.
 * @param installDir  AUnit installation directory (resolves `%AUNIT_HOME%`).
 */
export function resolveConfEnvPaths(
  parsed: ParsedUniversalConf,
  installDir?: string,
): {
  resolved: ParsedUniversalConf
  warnings: string[]
  /** env entries whose path could not be resolved — agent should ask the user */
  env_search_needed: Array<{ name: string; original_value: string; suggested_path?: string }>
} {
  const warnings: string[] = []
  const envSearchNeeded: Array<{ name: string; original_value: string; suggested_path?: string }> = []

  const resolvedEntries = parsed.entries.map((entry): UniversalConfEntry => {
    if (entry.type !== "env" || !entry.name || !isPathLike(entry.value ?? "")) {
      return { ...entry }
    }

    const originalValue = entry.value!

    // 1. Exists on disk → keep
    if (existsSync(originalValue)) {
      return { ...entry }
    }

    // 2. Try system env var
    const sysVal = process.env[entry.name]
    if (sysVal && existsSync(sysVal)) {
      warnings.push(
        `env ${entry.name}: disk path "${originalValue}" not found; resolved via system env to "${sysVal}"`,
      )
      const newRaw = entry.raw.replace(`=${originalValue}`, `=${sysVal}`)
      return { ...entry, value: sysVal, raw: newRaw }
    }

    // 3. Infer the tool from the env var name and search PATH
    const found = searchEnvDirectory(entry.name)
    if (found) {
      warnings.push(
        `env ${entry.name}: path "${originalValue}" not found; ` +
        `${found.method} → updated to "${found.path}"`,
      )
      const newRaw = entry.raw.replace(`=${originalValue}`, `=${found.path}`)
      return { ...entry, value: found.path, raw: newRaw }
    }

    // 4. Could not resolve — agent must ask the user
    const toolBin = inferToolFromEnvName(entry.name)
    envSearchNeeded.push({
      name: entry.name,
      original_value: originalValue,
      ...(toolBin ? { suggested_path: `(search for ${toolBin} installation directory)` } : {}),
    })
    warnings.push(
      `env ${entry.name}: path "${originalValue}" not found on disk, in system env, or via tool search — ` +
      `manual configuration required`,
    )
    return { ...entry }
  })

  return { resolved: { entries: resolvedEntries }, warnings, env_search_needed: envSearchNeeded }
}

// ─── Env variable tool inference & search ────────────────────────────────────

/**
 * Infer the associated tool binary from an environment variable name.
 * Used when an env path entry in universal.conf cannot be found on disk.
 * Returns a binary name (without .exe) or null when no inference is possible.
 */
function inferToolFromEnvName(name: string): string | null {
  const u = name.toUpperCase()
  if (u === "JAVA_HOME" || /\bJAVA\b|\bJDK\b|\bJRE\b/.test(u)) return "java"
  if (/\bARMCLANG\b/.test(u)) return "armclang"
  if (/\bARMCC\b|\bKEIL\b|\bMDK\b/.test(u)) return "armcc"
  if (/\bGCC\b|\bGNUC\b/.test(u)) return "gcc"
  if (/\bIAR\b|\bEWARM\b/.test(u)) return "iccarm"
  if (/\bCCS\b|\bTI_COMPILER\b|\bTI_ARM\b/.test(u)) return "armcl"
  if (/\bWINDRIVER\b|\bTORNADO\b/.test(u)) return "ccppc"
  if (/\bGHS\b|\bGREENHILL\b/.test(u)) return "elxr"
  if (/\bSDCC\b/.test(u)) return "sdcc"
  return null
}

/**
 * Try to locate the directory an environment variable should point to by
 * inferring the associated tool from the variable name, then finding it on PATH.
 *
 * Returns { path, method } on success, or null when the tool cannot be found.
 * The returned `path` is the inferred install root (one level above `bin/`).
 */
export function searchEnvDirectory(
  envName: string,
): { path: string; method: string } | null {
  const toolBin = inferToolFromEnvName(envName)
  if (!toolBin) return null

  try {
    const cmd = isWindows ? `where ${toolBin}` : `which ${toolBin}`
    const out = execSync(cmd, { stdio: "pipe", encoding: "utf-8", timeout: 5_000 }).trim()
    const toolPath = out.split(/\r?\n/)[0].trim()
    if (!toolPath) return null

    // Derive the install root: go up from the bin/ directory
    let dir = normalizePath(dirname(toolPath))
    if (/\/bin$/i.test(dir)) dir = normalizePath(dirname(dir))

    return { path: dir, method: `found ${toolBin} at ${toolPath}, derived install root` }
  } catch {
    return null
  }
}

/**
 * Write a ParsedUniversalConf back to disk.
 * Reconstructs content from `raw` fields of each entry, joined by newlines.
 */
export function writeUniversalConf(confPath: string, parsed: ParsedUniversalConf): void {
  const content = parsed.entries.map(e => e.raw).join("\n")
  writeFileSync(confPath, content, "utf-8")
}

/**
 * Collect all subdirectories under <installDir>/includes/ recursively.
 * Used to find candidate include paths when a build fails with missing headers.
 * Returns absolute, deduplicated, normalized paths. Empty array if includes/ doesn't exist.
 */
export function collectInstallIncludes(installDir: string): string[] {
  const includesRoot = join(normalizePath(installDir), "includes")
  if (!existsSync(includesRoot)) return []

  const results = new Set<string>()

  function scanDir(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subPath = join(dir, entry.name as string)
          results.add(normalizePath(subPath))
          scanDir(subPath)
        }
      }
    } catch {
      // ignore unreadable directories
    }
  }

  scanDir(includesRoot)
  return Array.from(results)
}

/**
 * Select include directories from `<installDir>/includes/` that are most likely
 * to resolve the given missing header files.
 *
 * Selection priority:
 * 1. Directories that actually contain one of the missing header files (scanned by filename).
 *    Returns only these when any are found — avoids adding unrelated paths.
 * 2. Directories whose names match keywords derived from `platformName`
 *    (e.g. GNUC → "gcc"/"gnu"/"runtime"; ARM → "arm"/"cmsis").
 * 3. Last resort (no platform info): directories matching generic names like "runtime",
 *    "stdlib", "standard".
 *
 * Never returns ALL directories — always selects a targeted subset.
 */
export function selectIncludesForHeaders(
  installDir: string,
  missingHeaders: string[],
  platformName?: string,
): string[] {
  const includesRoot = join(normalizePath(installDir), "includes")
  if (!existsSync(includesRoot)) return []

  // Collect all leaf-ish directories (those containing at least one .h file)
  const dirsWithHeaders: string[] = []
  const scanDir = (dir: string): void => {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      const hasH = entries.some((e) => e.isFile() && /\.h(pp|xx)?$/i.test(e.name))
      if (hasH) dirsWithHeaders.push(normalizePath(dir))
      for (const e of entries) {
        if (e.isDirectory()) scanDir(join(dir, e.name))
      }
    } catch { }
  }
  scanDir(includesRoot)

  if (dirsWithHeaders.length === 0) return []

  // Priority 1: directories that contain one of the missing header files
  const lowerHeaders = missingHeaders.map((h) => h.toLowerCase())
  const direct: string[] = []
  for (const dir of dirsWithHeaders) {
    try {
      const files = readdirSync(dir).map((f) => f.toLowerCase())
      if (lowerHeaders.some((h) => files.includes(h))) direct.push(dir)
    } catch { }
  }
  if (direct.length > 0) return direct

  // Priority 2: keyword matching on directory names
  const keywords: string[] = []
  if (platformName) {
    const up = platformName.toUpperCase()
    if (up.includes("GNUC") || up.includes("GCC")) keywords.push("gcc", "gnu", "stdlib", "runtime", "standard")
    if (up.includes("ARMCLANG")) keywords.push("armclang", "arm", "cmsis")
    if (up.includes("ARMCC")) keywords.push("armcc", "arm", "cmsis")
    if (up.includes("IAR")) keywords.push("iar", "clib", "dlmalloc")
    if (up.includes("C51") || up.includes("KEIL")) keywords.push("c51", "keil", "8051")
    if (up.includes("TI")) keywords.push("ti", "ccs", "driverlib", "runtime")
    if (up.includes("WINDRIVER") || up.includes("TORNADO")) keywords.push("ppc", "vxworks")
  }
  if (keywords.length === 0) keywords.push("runtime", "stdlib", "standard", "common")

  const keywordMatch = dirsWithHeaders.filter((dir) => {
    const lower = dir.toLowerCase()
    return keywords.some((k) => lower.includes(k))
  })
  if (keywordMatch.length > 0) return keywordMatch

  // Last resort: return nothing (caller falls back to other strategies)
  return []
}

/**
 * Add a directory to the path= entries of universal.conf.
 * Returns true if added (was not already present), false if already present or conf missing.
 *
 * Deduplication expands %envName% tokens (including %AUNIT_HOME%) in existing
 * entries before comparing, so `path=%AUNIT_HOME%/bin` is treated as equivalent
 * to its resolved absolute path and not added again.
 *
 * @param installDir  AUnit installation directory (resolves `%AUNIT_HOME%`).
 */
export function addPathToConf(confPath: string, dir: string, installDir?: string): boolean {
  const parsed = parseUniversalConf(confPath)
  if (!parsed) return false

  const envMap = buildEnvMap(parsed, installDir)
  const normalized = normalizePath(dir)

  const alreadyPresent = parsed.entries
    .filter(e => e.type === "path")
    .some(e => normalizePath(expandEnvRefs(e.value ?? "", envMap)) === normalized)

  if (alreadyPresent) return false

  parsed.entries.push({ type: "path", raw: `path=${dir}`, value: dir })
  writeUniversalConf(confPath, parsed)
  return true
}

/**
 * Add a `da` (define/macro) entry to universal.conf, deduplicating by macro name.
 * Appends `da NAME` or `da NAME=VALUE` if not already present.
 * Returns true if a new entry was added, false if already present or conf missing.
 */
export function addDaToConf(confPath: string, name: string, value?: string): boolean {
  // Normalize empty string to undefined (flag macro, no value)
  const effectiveValue = value || undefined

  const parsed = parseUniversalConf(confPath)
  if (!parsed) return false

  // Check if da entry with the same name already exists
  const alreadyPresent = parsed.entries
    .filter(e => e.type === "da")
    .some(e => e.name === name)

  if (alreadyPresent) return false

  const raw = effectiveValue !== undefined ? `da ${name}=${effectiveValue}` : `da ${name}`
  parsed.entries.push({ type: "da", raw, name, value: effectiveValue ?? "" })
  writeUniversalConf(confPath, parsed)
  return true
}

const DEFAULT_PLATFORM = "GENERAL_GNUC_VTEST"

/**
 * List available AUnit platform configurations.
 * Reads folder names from `<installDir>/config/platform/`.
 */
export function listAvailablePlatforms(installDir: string): string[] {
  const platformDir = join(normalizePath(installDir), "config", "platform")
  if (!existsSync(platformDir)) return []
  try {
    return readdirSync(platformDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

export interface ResolvedPlatform {
  platform: string
  source: string
  /** Compiler binary name extracted from the platform's Makefile (or inferred from platform name) */
  compiler: string | null
  /** Absolute path to the compiler executable (from PATH lookup), or null if not found */
  compiler_path: string | null
  /** Whether the compiler was found on the system PATH */
  compiler_available: boolean
  /** Platforms that were ranked but skipped because their compiler was not in PATH */
  compiler_skipped: Array<{ platform: string; compiler: string | null; reason: string }>
}

/**
 * Resolve AUnit platform config by auto-matching against available platforms.
 *
 * Priority:
 * 1. Explicit aunit_platform override (from config) — validated against available platforms
 * 2. Auto-match from compilation-env.json (compiler_dialect + target_cpu) against available platform folder names
 * 3. Auto-match from config compiler_dialect against available platform folder names
 * 4. Default: GENERAL_GNUC_VTEST
 *
 * For auto-match levels (2 and 3), platforms are ranked by keyword score and each
 * candidate is checked for compiler availability before committing. The first candidate
 * whose compiler exists on PATH is selected. If the explicit override (level 1) is used,
 * the compiler status is reported but the platform is not skipped.
 *
 * All platform names MUST exist as folder names under `<installDir>/config/platform/`.
 */
export function resolveAunitPlatform(
  installDir: string,
  projectDir: string,
  compilerDialect?: string,
  explicitPlatform?: string,
): ResolvedPlatform {
  const available = listAvailablePlatforms(installDir)
  const skipped: ResolvedPlatform["compiler_skipped"] = []

  // Parse the AUnit CLI bat/sh once to get the same env it provides at runtime.
  // This ensures that PATH entries added by the bat file (e.g. compiler bin dirs)
  // are visible when we run `where`/`which` to verify compiler availability.
  const cliEnv = parseCliEnv(installDir)

  /** Check compiler for a given platform; returns null compiler → assume OK (unknown toolchain) */
  const tryPlatform = (platformName: string): { compiler: string | null; compiler_path: string | null; available: boolean } => {
    const compiler = extractPlatformCompiler(installDir, platformName)
    if (!compiler) return { compiler: null, compiler_path: null, available: true }
    const foundAt = checkCompilerInPath(compiler, cliEnv)
    return { compiler, compiler_path: foundAt, available: foundAt !== null }
  }

  // 1. Explicit override — validate it exists, report compiler status (do not skip)
  if (explicitPlatform) {
    if (available.length === 0 || available.includes(explicitPlatform)) {
      const check = tryPlatform(explicitPlatform)
      return {
        platform: explicitPlatform,
        source: "config_override",
        compiler: check.compiler,
        compiler_path: check.compiler_path,
        compiler_available: check.available,
        compiler_skipped: skipped,
      }
    }
    // Explicit platform not found in available list, fall through to auto-match
  }

  // 2. Auto-match from compilation-env.json — iterate ranked candidates
  if (available.length > 0) {
    const envInfo = readCompilationEnv(projectDir)
    if (envInfo) {
      const keywords = buildKeywords(envInfo.compiler_dialect, envInfo.target_cpu)
      const ranked = rankPlatforms(available, keywords)
      for (const candidate of ranked) {
        const check = tryPlatform(candidate)
        if (check.available) {
          return {
            platform: candidate,
            source: `auto_matched (dialect=${envInfo.compiler_dialect}, cpu=${envInfo.target_cpu || "N/A"})`,
            compiler: check.compiler,
            compiler_path: check.compiler_path,
            compiler_available: true,
            compiler_skipped: skipped,
          }
        }
        skipped.push({
          platform: candidate,
          compiler: check.compiler,
          reason: `compiler "${check.compiler}" not found in PATH`,
        })
      }
    }

    // 3. Auto-match from config compiler_dialect — iterate ranked candidates
    if (compilerDialect && compilerDialect !== "auto") {
      const keywords = buildKeywords(compilerDialect)
      const ranked = rankPlatforms(available, keywords)
      for (const candidate of ranked) {
        if (skipped.some((s) => s.platform === candidate)) continue // already tried
        const check = tryPlatform(candidate)
        if (check.available) {
          return {
            platform: candidate,
            source: `config_dialect (${compilerDialect})`,
            compiler: check.compiler,
            compiler_path: check.compiler_path,
            compiler_available: true,
            compiler_skipped: skipped,
          }
        }
        skipped.push({
          platform: candidate,
          compiler: check.compiler,
          reason: `compiler "${check.compiler}" not found in PATH`,
        })
      }
    }
  }

  // 4. Default
  const defaultCheck = tryPlatform(DEFAULT_PLATFORM)
  return {
    platform: DEFAULT_PLATFORM,
    source: "default",
    compiler: defaultCheck.compiler,
    compiler_path: defaultCheck.compiler_path,
    compiler_available: defaultCheck.available,
    compiler_skipped: skipped,
  }
}

/** Read compilation-env.json from project directory */
function readCompilationEnv(projectDir: string): { compiler_dialect: string; target_cpu?: string } | null {
  try {
    const envPath = resolve(normalizePath(projectDir), ".matrix", "data", "compilation-env.json")
    if (!existsSync(envPath)) return null
    const data = JSON.parse(readFileSync(envPath, "utf-8"))
    if (data.compiler_dialect) {
      return {
        compiler_dialect: data.compiler_dialect,
        target_cpu: data.target_cpu || undefined,
      }
    }
  } catch {
    // Cannot read or parse
  }
  return null
}

/**
 * Build keyword list for platform matching from compiler dialect and target CPU.
 * Keywords are uppercase and used for case-insensitive overlap scoring against
 * platform folder names.
 */
function buildKeywords(compilerDialect: string, targetCpu?: string): string[] {
  const keywords: string[] = []
  const dialect = compilerDialect.toUpperCase()

  if (dialect !== "AUTO" && dialect !== "GENERIC") {
    keywords.push(dialect)
    if (dialect === "ARMCC" || dialect === "ARMCLANG") keywords.push("ARM")
    if (dialect === "KEIL") keywords.push("C51", "KEIL")
    if (dialect === "C51") keywords.push("KEIL")
    if (dialect === "WINDRIVER") keywords.push("TORNADO", "PPC")
    if (dialect === "TI") keywords.push("TIARM")
  }

  if (targetCpu) {
    const cpu = targetCpu.toUpperCase()
    keywords.push(cpu)
    if (cpu.includes("CORTEX") || cpu.includes("ARM")) keywords.push("ARM")
    if (cpu.includes("8051") || cpu.includes("C51")) keywords.push("C51")
    if (cpu.includes("PPC") || cpu.includes("POWERPC")) keywords.push("PPC", "TORNADO")
    if (cpu.includes("MSP") || cpu.includes("TMS")) keywords.push("TI", "TIARM")
  }

  return keywords
}

/**
 * Rank platforms by keyword overlap score (descending). Returns only platforms with score > 0.
 */
function rankPlatforms(available: string[], keywords: string[]): string[] {
  if (keywords.length === 0) return []
  const scored: Array<{ platform: string; score: number }> = []
  for (const platform of available) {
    const upper = platform.toUpperCase()
    let score = 0
    for (const kw of keywords) {
      if (upper.includes(kw)) score++
    }
    if (score > 0) scored.push({ platform, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.platform)
}

/**
 * Infer compiler binary from platform folder name using common naming conventions.
 * Used as fallback when the platform's Makefile is absent or has no CC= assignment.
 */
function inferCompilerFromPlatformName(platformName: string): string | null {
  const upper = platformName.toUpperCase()
  if (upper.includes("ARMCLANG")) return "armclang"
  if (upper.includes("ARMCC")) return "armcc"
  if (upper.includes("GNUC") || upper.includes("GCC")) return "gcc"
  if (upper.includes("IAR")) return "iccarm"
  if (upper.includes("TIARM") || upper.includes("TI_ARM")) return "armcl"
  if (upper.includes("C51") || upper.includes("KEIL")) return "c51"
  if (upper.includes("PPC") || upper.includes("TORNADO") || upper.includes("WINDRIVER")) return "ccppc"
  return null
}

/**
 * Extract the compiler binary name from a platform's Makefile.
 * Reads `<installDir>/config/platform/<platformName>/Makefile` and looks for
 * CC=, COMPILER=, or CXX= assignments. Falls back to name-based inference.
 */
export function extractPlatformCompiler(installDir: string, platformName: string): string | null {
  const makefilePath = join(normalizePath(installDir), "config", "platform", platformName, "Makefile")
  if (existsSync(makefilePath)) {
    try {
      const content = readFileSync(makefilePath, "utf-8")
      const patterns = [
        /^CC\s*[:+]?=\s*(\S+)/m,
        /^COMPILER\s*[:+]?=\s*(\S+)/m,
        /^CXX\s*[:+]?=\s*(\S+)/m,
      ]
      for (const pattern of patterns) {
        const match = content.match(pattern)
        if (match?.[1]) {
          // Strip quotes, take basename, strip .exe
          let compiler = match[1].replace(/['"]/g, "").trim()
          compiler = compiler.replace(/.*[/\\]/, "").replace(/\.exe$/i, "")
          if (compiler) return compiler
        }
      }
    } catch {
      // Fall through to name-based inference
    }
  }
  return inferCompilerFromPlatformName(platformName)
}

/**
 * Parse environment variable assignments from the AUnit CLI bat/sh file.
 *
 * Simulates SET (Windows) / export (Linux) statements in top-to-bottom order,
 * expanding variable references (%VAR% on Windows, $VAR/${VAR} on Linux) as
 * each line is processed — matching real shell evaluation semantics.
 *
 * Only variable assignment lines are processed; control-flow constructs
 * (IF, GOTO, labels, etc.) are ignored. This handles the common pattern where
 * the CLI wrapper prepends compiler directories to PATH and sets JAVA_HOME /
 * tool-specific variables before invoking the underlying Java process.
 *
 * Returns process.env merged with any overrides from the bat/sh file.
 */
export function parseCliEnv(installDir: string): NodeJS.ProcessEnv {
  const cliPath = join(normalizePath(installDir), CLI_NAME)
  if (!existsSync(cliPath)) return { ...process.env }

  let content: string
  try {
    content = readFileSync(cliPath, "utf-8")
  } catch {
    return { ...process.env }
  }

  if (isWindows) {
    // Windows env keys are case-insensitive — store everything uppercase
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k.toUpperCase()] = v
    }

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("::") || /^rem\b/i.test(trimmed)) continue
      // Strip leading @ (e.g. @set, @echo)
      const stripped = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed
      // Match: SET VAR=VALUE  (SET /A and other flags are ignored)
      const m = stripped.match(/^set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)/i)
      if (!m) continue
      const name = m[1].toUpperCase()
      const rawValue = m[2]
      // Expand %VAR% tokens using accumulated env (uppercase lookup)
      const expanded = rawValue.replace(/%([^%\r\n]+)%/g, (_match, varName: string) => {
        return env[varName.toUpperCase()] ?? ""
      })
      env[name] = expanded
    }

    return env as NodeJS.ProcessEnv
  } else {
    // Linux/macOS: preserve original case
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      // Match: export VAR=VALUE  or  VAR=VALUE
      const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (!m) continue
      // Strip surrounding quotes from value
      const rawValue = m[2].replace(/^["']|["']$/g, "")
      // Expand $VAR or ${VAR}
      const expanded = rawValue.replace(
        /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (_match, v1?: string, v2?: string) => env[v1 ?? v2 ?? ""] ?? "",
      )
      env[m[1]] = expanded
    }

    return env as NodeJS.ProcessEnv
  }
}

/**
 * Check if a compiler binary is reachable using the given environment.
 * Uses `where` (Windows) or `which` (Linux/macOS); 5 s timeout.
 * Pass `cliEnv` (from parseCliEnv) so that PATH entries set by the AUnit
 * CLI bat/sh file are included in the lookup — matching what AUnit sees.
 * Returns the found executable path, or null if not found.
 */
export function checkCompilerInPath(compiler: string, env?: NodeJS.ProcessEnv): string | null {
  try {
    const cmd = isWindows ? `where ${compiler}` : `which ${compiler}`
    const result = execSync(cmd, {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 5_000,
      env: env,
    }).trim()
    const firstLine = result.split(/\r?\n/)[0].trim()
    return firstLine || null
  } catch {
    return null
  }
}

/** Normalize path separators to forward slashes (Bun path.join has issues with backslashes on Windows) */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

/** Result of CLI resolution, including both the CLI executable path and the installation directory */
export interface AunitCliInfo {
  cliPath: string
  installDir: string
}

const isWindows = process.platform === "win32"
const CLI_NAME = isWindows ? "SunwiseAUnit.cli.bat" : "SunwiseAUnit.cli.sh"

/**
 * Resolve the SunwiseAUnit CLI executable.
 *
 * Resolution priority:
 * 1. Explicit aunit_path from config (if provided) — join with CLI filename, verify exists
 * 2. Disk cache (.matrix/state/aunit-cli-cache.json) — reuses a previously discovered path
 * 3. System PATH — `where` (Windows) / `which` (Linux) for exact filename
 * 4. Global filesystem search — `where /R` from drive roots (Windows) / `find /` (Linux)
 * 5. Fail — throws an error; unit testing should stop and mark status as abnormal
 */
export function resolveAunitCli(aunitPath?: string): AunitCliInfo {
  // 1. Explicit config path (highest priority)
  if (aunitPath) {
    const cliPath = join(normalizePath(aunitPath), CLI_NAME)
    if (existsSync(cliPath)) {
      const result = { cliPath, installDir: normalizePath(aunitPath) }
      writeCliCache(result)
      return result
    }
  }

  // 2. Disk cache — reuse previously discovered path (avoids expensive re-search)
  const cached = readCliCache()
  if (cached) return cached

  // 3. System PATH lookup
  const pathResult = findCliInPath()
  if (pathResult) {
    writeCliCache(pathResult)
    return pathResult
  }

  // 4. Global filesystem search
  const globalResult = findCliGlobal()
  if (globalResult) {
    writeCliCache(globalResult)
    return globalResult
  }

  // 5. Fail — cannot locate CLI anywhere
  const searchedLocations = aunitPath
    ? `config path (${aunitPath}), system PATH, and global filesystem search`
    : "system PATH and global filesystem search"
  throw new Error(
    `SunwiseAUnit CLI (${CLI_NAME}) not found. Searched: ${searchedLocations}. ` +
    `Unit testing cannot proceed. Please either:\n` +
    `  - Add the directory containing ${CLI_NAME} to your system PATH, or\n` +
    `  - Set aunit_path in .matrix/config/matrix.jsonc to the SunwiseAUnit installation directory.`,
  )
}

/** Cache file path for persisting discovered AUnit CLI location */
function getCliCachePath(): string {
  return join(process.cwd(), ".matrix", "state", "aunit-cli-cache.json")
}

/** Read cached CLI info from disk, validating the path still exists */
function readCliCache(): AunitCliInfo | null {
  try {
    const cachePath = getCliCachePath()
    if (!existsSync(cachePath)) return null
    const data = JSON.parse(readFileSync(cachePath, "utf-8"))
    if (data.cliPath && existsSync(data.cliPath)) {
      return { cliPath: data.cliPath, installDir: data.installDir }
    }
  } catch {
    // Cache read failed — proceed without cache
  }
  return null
}

/** Write discovered CLI info to disk cache */
function writeCliCache(info: AunitCliInfo): void {
  try {
    const cachePath = getCliCachePath()
    const stateDir = dirname(cachePath)
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    writeFileSync(cachePath, JSON.stringify({
      cliPath: info.cliPath,
      installDir: info.installDir,
      cachedAt: new Date().toISOString(),
    }), "utf-8")
  } catch {
    // Cache write failed — non-fatal, proceed normally
  }
}

/** Try to find CLI via system PATH using `where` (Windows) or `which` (Linux) */
function findCliInPath(): AunitCliInfo | null {
  try {
    const cmd = isWindows ? `where ${CLI_NAME}` : `which ${CLI_NAME}`
    const result = execSync(cmd, {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 10_000,
    }).trim()

    // `where` on Windows may return multiple lines; take the first
    const firstLine = result.split(/\r?\n/)[0].trim()
    if (firstLine && existsSync(firstLine)) {
      return {
        cliPath: firstLine,
        installDir: normalizePath(dirname(firstLine)),
      }
    }
  } catch {
    // Command failed — CLI not in PATH
  }
  return null
}

/** Global filesystem search for the CLI executable */
function findCliGlobal(): AunitCliInfo | null {
  try {
    let result: string
    if (isWindows) {
      // Get available drive letters and search each
      const drives = getWindowsDrives()
      for (const drive of drives) {
        try {
          const found = execSync(`where /R ${drive}\\ ${CLI_NAME}`, {
            stdio: "pipe",
            encoding: "utf-8",
            timeout: 120_000,
          }).trim()

          const firstLine = found.split(/\r?\n/)[0].trim()
          if (firstLine && existsSync(firstLine)) {
            return {
              cliPath: firstLine,
              installDir: normalizePath(dirname(firstLine)),
            }
          }
        } catch {
          // Not found on this drive, try next
        }
      }
    } else {
      // Linux/macOS: find from root
      result = execSync(
        `find / -name "${CLI_NAME}" -type f -print -quit 2>/dev/null`,
        {
          stdio: "pipe",
          encoding: "utf-8",
          timeout: 120_000,
        },
      ).trim()

      if (result && existsSync(result)) {
        return {
          cliPath: result,
          installDir: normalizePath(dirname(result)),
        }
      }
    }
  } catch {
    // Search failed or timed out
  }
  return null
}

/** Get available Windows drive letters (e.g., ["C:", "D:"]) */
function getWindowsDrives(): string[] {
  try {
    const output = execSync("wmic logicaldisk get name", {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 10_000,
    })
    const drives = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Z]:$/.test(line))
    return drives.length > 0 ? drives : ["C:"]
  } catch {
    return ["C:"]
  }
}

/** Strip ANSI escape sequences (CSI, OSC, DCS, and all known sequence types — regex from ansi-regex v6) */
function stripAnsi(text: string): string {
  return text.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    "",
  )
}

/** AUnit workspace directory under .matrix/ */
export const AUNIT_WORKSPACE = ".matrix/aunit"

const AUNIT_WORKSPACE_SUFFIX_RE = /[/\\]\.matrix[/\\]aunit\/?$/

/** Strip trailing .matrix/aunit from project_dir if the caller mistakenly passed the workspace path. */
export function normalizeProjectDir(dir: string): string {
  return dir.replace(AUNIT_WORKSPACE_SUFFIX_RE, "")
}

/** Append a JSONL entry to `.matrix/log/aunit_cmd.log`. Best-effort — never throws. */
function logAunitCmd(
  logDir: string,
  entry: { ts: string; cmd: string; exitCode: number; durationMs: number; error?: string },
): void {
  try {
    const dir = resolve(normalizePath(logDir), ".matrix", "log")
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, "aunit_cmd.log")
    appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8")
  } catch {
    // logging is best-effort — never let it break tool execution
  }
}

/**
 * Execute an AUnit CLI command and return stdout/stderr.
 * CWD is always set to installDir (the AUnit installation directory)
 * because the bat file runs `java -jar SunwiseAUnit.cli.jar` as a relative path.
 */
export function execAunit(
  cliPath: string,
  installDir: string,
  subcommand: "ut" | "it",
  action: string,
  args: string[],
  timeoutMs: number = 300_000,
  logDir?: string,
): { stdout: string; stderr: string; exitCode: number; cmd: string } {
  const safeCli = normalizePath(cliPath)
  const safeCwd = normalizePath(installDir)
  const cmd = `"${safeCli}" ${subcommand} ${action} ${args.join(" ")}`
  const t0 = Date.now()

  const decodeOutput = (buf: Buffer | string | null | undefined): string => {
    if (!buf) return ""
    if (typeof buf === "string") return buf
    return isWindows ? decodeGbk(buf) : buf.toString("utf-8")
  }

  try {
    const rawOut = execSync(cmd, {
      stdio: "pipe",
      timeout: timeoutMs,
      cwd: safeCwd,
      maxBuffer: 20 * 1024 * 1024,
    })
    const result = { stdout: stripAnsi(decodeOutput(rawOut)), stderr: "", exitCode: 0, cmd }
    if (logDir) {
      logAunitCmd(logDir, {
        ts: new Date(t0).toISOString(),
        cmd,
        exitCode: 0,
        durationMs: Date.now() - t0,
      })
    }
    return result
  } catch (err: any) {
    const result = {
      stdout: stripAnsi(decodeOutput(err.stdout)),
      stderr: stripAnsi(decodeOutput(err.stderr) || err.message || String(err)),
      exitCode: err.status ?? 1,
      cmd,
    }
    if (logDir) {
      logAunitCmd(logDir, {
        ts: new Date(t0).toISOString(),
        cmd,
        exitCode: result.exitCode,
        durationMs: Date.now() - t0,
        ...(result.stderr ? { error: result.stderr.slice(0, 500) } : {}),
      })
    }
    return result
  }
}

/**
 * Kill an entire process tree rooted at `pid`.
 * - Windows: `taskkill /F /T /PID` forcefully kills the .bat→java→Z3 tree.
 * - POSIX: `process.kill(-pid, "SIGKILL")` kills the process group.
 * Best-effort — never throws.
 */
function killProcessTree(pid: number): void {
  try {
    if (isWindows) {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", timeout: 10_000 })
    } else {
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    // best-effort — process may have already exited
  }
}

/**
 * Async version of execAunit — runs the AUnit CLI command in a child process
 * and returns a Promise. Used for parallel execution of independent operations.
 *
 * Uses `spawn` + manual `taskkill /F /T` timeout kill instead of `exec` timeout,
 * because on Windows MSYS the SIGTERM from `exec` cannot kill the
 * `.bat → java → Z3` process tree, causing Promise.all to hang indefinitely.
 */
export function execAunitAsync(
  cliPath: string,
  installDir: string,
  subcommand: "ut" | "it",
  action: string,
  args: string[],
  timeoutMs: number = 300_000,
  logDir?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; cmd: string; timedOut?: boolean }> {
  const safeCli = normalizePath(cliPath)
  const safeCwd = normalizePath(installDir)
  const cmd = `"${safeCli}" ${subcommand} ${action} ${args.join(" ")}`
  const t0 = Date.now()

  return new Promise((resolve) => {
    let resolved = false
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    const joinChunks = (chunks: Buffer[]): string => {
      const buf = Buffer.concat(chunks)
      return isWindows ? decodeGbk(buf) : buf.toString("utf-8")
    }

    const child = spawn(cmd, [], {
      cwd: safeCwd,
      stdio: "pipe",
      shell: true,
      windowsHide: true,
    })

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    // Manual timeout with process tree kill
    const timer = setTimeout(() => {
      if (resolved) return
      if (child.pid) killProcessTree(child.pid)

      // Safety net: if 'close' event doesn't fire within 10s after kill, force resolve
      const safetyTimer = setTimeout(() => {
        if (resolved) return
        resolved = true
        const result = {
          stdout: stripAnsi(joinChunks(stdoutChunks)),
          stderr: stripAnsi(joinChunks(stderrChunks) || "Process killed: timeout exceeded"),
          exitCode: -1,
          cmd,
          timedOut: true,
        }
        if (logDir) {
          logAunitCmd(logDir, {
            ts: new Date(t0).toISOString(),
            cmd,
            exitCode: -1,
            durationMs: Date.now() - t0,
            error: `timeout (${timeoutMs}ms) — force resolved by safety net`,
          })
        }
        resolve(result)
      }, 10_000)
      // Prevent safety timer from keeping Node alive if close fires first
      if (safetyTimer.unref) safetyTimer.unref()
    }, timeoutMs)
    if (timer.unref) timer.unref()

    child.on("close", (code) => {
      clearTimeout(timer)
      if (resolved) return
      resolved = true

      const timedOut = code === null || (Date.now() - t0 >= timeoutMs - 500)
      const exitCode = timedOut ? -1 : (code ?? 1)

      const result = {
        stdout: stripAnsi(joinChunks(stdoutChunks)),
        stderr: stripAnsi(joinChunks(stderrChunks)),
        exitCode,
        cmd,
        ...(timedOut ? { timedOut: true } : {}),
      }
      if (logDir) {
        logAunitCmd(logDir, {
          ts: new Date(t0).toISOString(),
          cmd,
          exitCode,
          durationMs: Date.now() - t0,
          ...(timedOut ? { error: `timeout (${timeoutMs}ms)` } : {}),
          ...(result.stderr && !timedOut ? { error: result.stderr.slice(0, 500) } : {}),
        })
      }
      resolve(result)
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      if (resolved) return
      resolved = true

      const result = {
        stdout: stripAnsi(joinChunks(stdoutChunks)),
        stderr: stripAnsi(err.message || String(err)),
        exitCode: 1,
        cmd,
      }
      if (logDir) {
        logAunitCmd(logDir, {
          ts: new Date(t0).toISOString(),
          cmd,
          exitCode: 1,
          durationMs: Date.now() - t0,
          error: result.stderr.slice(0, 500),
        })
      }
      resolve(result)
    })
  })
}

/**
 * Generate a `.cdb` (Compilation DataBase) file for AUnit CDB creation mode.
 *
 * Each source file produces one block (separated by blank lines):
 * ```
 * compile:
 * <working_dir>\
 * <compiler_exe_path>
 * <source_filename>
 * <compiler_exe_path>
 *
 * ```
 *
 * @param sourcePaths  Absolute paths to each C/C++ source file.
 * @param compilerPath Absolute path to the compiler executable.
 * @param workingDir   Working directory written into each block (typically the source's parent dir).
 * @param outputPath   Where to write the `.cdb` file (absolute path).
 */
export function generateCdbFile(
  sourcePaths: string[],
  compilerPath: string,
  workingDir: string,
  outputPath: string,
): void {
  // Normalize to backslashes — AUnit CDB format uses Windows-style paths
  const toWin = (p: string) => p.replace(/\//g, "\\")
  const compilerWin = toWin(compilerPath)

  const blocks: string[] = []
  for (const srcPath of sourcePaths) {
    const srcFilename = srcPath.replace(/.*[/\\]/, "") // basename
    const srcDir = toWin(dirname(srcPath))
    blocks.push(
      [
        "compile:",
        `${srcDir}\\`,
        compilerWin,
        srcFilename,
        compilerWin,
      ].join("\n"),
    )
  }

  const dir = dirname(outputPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(outputPath, blocks.join("\n\n\n") + "\n\n\n", "utf-8")
}

/** Characters that require quoting in Windows CMD shell commands */
const CMD_NEEDS_QUOTING = /[\s&|<>^()!]/

/** Build CLI args array from an options object, skipping undefined values */
export function buildArgs(
  opts: Record<string, string | string[] | undefined>,
): string[] {
  const args: string[] = []
  for (const [flag, value] of Object.entries(opts)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length > 0) {
        const joined = value.join(",")
        args.push(flag, CMD_NEEDS_QUOTING.test(joined) ? `"${joined}"` : joined)
      }
    } else {
      args.push(flag, CMD_NEEDS_QUOTING.test(value) ? `"${value}"` : value)
    }
  }
  return args
}

/**
 * Read `<projectPath>/meta/model/summary.json` and build a funcName → srcFilePath map.
 * AUnit CLI requires `-func` to be paired with `-src`; this map provides the mapping.
 * Returns an empty map if summary.json doesn't exist or is unparseable.
 */
export function readFuncSourceMap(projectPath: string): Map<string, string> {
  const summaryPath = join(projectPath, "meta", "model", "summary.json")
  const map = new Map<string, string>()
  if (!existsSync(summaryPath)) return map

  try {
    const raw = readFileSync(summaryPath, "utf-8")
    const data = JSON.parse(raw)
    if (!Array.isArray(data.files)) return map

    for (const file of data.files) {
      const fileName = file.name as string | undefined
      if (!fileName) continue
      const funcs = file.funcs as Array<{ name?: string }> | undefined
      if (!Array.isArray(funcs)) continue
      for (const fn of funcs) {
        if (fn.name && !map.has(fn.name)) {
          map.set(fn.name, fileName)
        }
      }
    }
  } catch {
    // summary.json unreadable or malformed — return empty map
  }

  return map
}

/**
 * Recursively scan the UT directory for .gson files, returning only file paths.
 * Does NOT read or parse file contents — lightweight directory traversal only.
 * Skips the "preanalysis" subdirectory.
 */
export function scanGsonPaths(utDir: string): string[] {
  const paths: string[] = []
  const normalDir = normalizePath(utDir)
  if (!existsSync(normalDir)) return paths

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "preanalysis") continue
        walk(fullPath)
      } else if (entry.name.endsWith(".gson")) {
        paths.push(fullPath)
      }
    }
  }

  try {
    walk(normalDir)
  } catch {
    // ignore unreadable directories
  }
  return paths
}

// ── Test case value sanitization ──────────────────────────────────────────────
// AUnit embeds retValue, paraExprs[].in, gVars[].in/out directly into generated
// C source code. Values that are not valid C expressions cause compilation
// failures. This utility validates and sanitizes those values.

/** Tokens that are not valid C expressions and must be rejected/cleared */
const INVALID_VALUE_PATTERNS = [
  /^N\/A$/i,
  /^n\/a$/,
  /^undefined$/i,
  /^null$/i,
  /^none$/i,
  /^nan$/i,
  /^待定$/,
  /^未知$/,
  /^无$/,
  /^—$/,
  /^-$/,
  /^\?+$/,
  /^TODO$/i,
  /^TBD$/i,
  /^PENDING$/i,
]

/**
 * Sanitize a single test case value (retValue, paraExprs[].in, gVars[].out).
 * Returns the sanitized value, or empty string if the value is invalid.
 *
 * Rules:
 * 1. Trim whitespace
 * 2. Reject known non-C tokens (N/A, undefined, null, 待定, etc.)
 * 3. Strip trailing semicolons (not needed in AUnit value fields)
 * 4. Leave valid C literals/expressions unchanged (numbers, strings, casts, etc.)
 */
export function sanitizeCaseValue(value: string | undefined | null): string {
  if (value === undefined || value === null) return ""
  const trimmed = String(value).trim()
  if (trimmed === "") return ""

  // Reject known non-C tokens
  for (const pattern of INVALID_VALUE_PATTERNS) {
    if (pattern.test(trimmed)) return ""
  }

  // Strip trailing semicolons
  const cleaned = trimmed.replace(/;+$/, "").trim()
  if (cleaned === "") return ""

  return cleaned
}

/**
 * Sanitize a semicolon-separated value sequence (stubInss[].inputs[].value, gVars[].in).
 * AUnit supports value sequences like "0;2;3;4" where each value is used on successive calls.
 * Each sub-value is sanitized individually; empty trailing segments are stripped.
 */
export function sanitizeSequenceValue(value: string | undefined | null): string {
  if (value === undefined || value === null) return ""
  const trimmed = String(value).trim()
  if (trimmed === "") return ""

  // If no semicolons, fall through to single-value sanitization
  if (!trimmed.includes(";")) return sanitizeCaseValue(trimmed)

  // Split, sanitize each sub-value, strip empty trailing segments
  const parts = trimmed.split(";").map(p => sanitizeCaseValue(p))
  // Remove trailing empty parts
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop()
  if (parts.length === 0) return ""

  return parts.join(";")
}

/**
 * Sanitize all value fields in a test case object (for aunit_inject_cases).
 * Modifies the case in-place. Returns a list of warnings for fields that were cleared.
 */
export function sanitizeCaseValues(c: any): string[] {
  const warnings: string[] = []

  // retValue (single-value)
  if (c.retValue !== undefined && c.retValue !== "") {
    const cleaned = sanitizeCaseValue(c.retValue)
    if (cleaned !== c.retValue) {
      warnings.push(`retValue "${c.retValue}" → "${cleaned || "(cleared)"}"`)
      c.retValue = cleaned
    }
  }

  // paraExprs[].in (single-value)
  if (Array.isArray(c.paraExprs)) {
    for (const p of c.paraExprs) {
      if (p.in !== undefined && p.in !== "") {
        const cleaned = sanitizeCaseValue(p.in)
        if (cleaned !== p.in) {
          warnings.push(`paraExprs[${p.expr}].in "${p.in}" → "${cleaned || "(cleared)"}"`)
          p.in = cleaned
        }
      }
    }
  }

  // gVars[].in (supports value sequences) and gVars[].out (single-value)
  if (Array.isArray(c.gVars)) {
    for (const gv of c.gVars) {
      if (gv.in !== undefined && gv.in !== "") {
        const cleaned = sanitizeSequenceValue(gv.in)
        if (cleaned !== gv.in) {
          warnings.push(`gVars[${gv.expr}].in "${gv.in}" → "${cleaned || "(cleared)"}"`)
          gv.in = cleaned
        }
      }
      if (gv.out !== undefined && gv.out !== "") {
        const cleaned = sanitizeCaseValue(gv.out)
        if (cleaned !== gv.out) {
          warnings.push(`gVars[${gv.expr}].out "${gv.out}" → "${cleaned || "(cleared)"}"`)
          gv.out = cleaned
        }
      }
    }
  }

  // stubInss[].inputs[].value (supports value sequences)
  if (Array.isArray(c.stubInss)) {
    for (const stub of c.stubInss) {
      if (Array.isArray(stub.inputs)) {
        for (const inp of stub.inputs) {
          if (inp.value !== undefined && inp.value !== "") {
            const cleaned = sanitizeSequenceValue(inp.value)
            if (cleaned !== inp.value) {
              warnings.push(`stubInss[${stub.stubName}].inputs[${inp.expr}].value "${inp.value}" → "${cleaned || "(cleared)"}"`)
              inp.value = cleaned
            }
          }
        }
      }
    }
  }

  return warnings
}
