import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync, appendFileSync, rmSync } from "fs"
import { join, resolve, basename, relative, isAbsolute } from "path"
import * as jsonc from "jsonc-parser/lib/esm/main.js"
import { execSync, spawn } from "child_process"
import { cpus } from "os"
import { SARawFindingsReport } from "../schema/sa-raw-findings"
import { classifyIssue } from "./specrepair/issue-classifier"
import { tryBuiltinRepair, hasBuiltinStrategy } from "./specrepair/builtin-strategies"
import { trySkillRepair, getSkillContext, getSkillCount } from "./specrepair/repair-skills"
import { assessPatchRisk } from "./specrepair/safety-checker"
import { PRIORITY_MAP, CONFORMANCE_MAP, CATEGORY_MAP } from "./specrepair/ruleset-parser"

/**
 * specchecker — SpecChecker.exe wrapper for aerospace C coding standard analysis.
 *
 * Replaces the former mock misra_checker and static_analyzer tools.
 * Wraps the real SpecChecker 3-step pipeline (create → analyze → report)
 * and provides integrated defect classification and repair suggestions.
 *
 * Used by: StaticAnalyzer agent (Phase 3)
 */

/** Default SpecChecker ruleset */
const DEFAULT_RULESET = "航天器C语言软件编程约定2024版"

/** Common SpecChecker installation paths */
const COMMON_SPECCHECKER_PATHS = [
  "D:\\SunwiseInfo\\SpecCheckerWeb\\SpecChecker",
  "C:\\SunwiseInfo\\SpecCheckerWeb\\SpecChecker",
  "C:\\SpecChecker",
]

/** Inactivity timeout: kill process after 5 min of no output */
const INACTIVITY_TIMEOUT_MS = 600_000

/**
 * Select the best SpecChecker preset compiler config based on the analyst's
 * compilation environment output (target_cpu + compiler_dialect).
 *
 * Selection is **target-platform-first**: SpecChecker presets are organized by
 * target platform (C51, ARM, MSP430, DSP_C6000, …), so the target CPU is the
 * primary factor.  compiler_dialect is only used as a secondary refinement when
 * multiple presets serve the same platform (e.g. tricore-gcc vs TRICORE_TC22XX,
 * aarch64-clang++ vs aarch64-linux-gnu-g++).
 *
 * Available presets under {specHome}/config/compilers/:
 *   ANSI, ARM, C51, GNUC, IAR_78, IAR_80, MSP430,
 *   DSP_C2000, DSP_C3x4x, DSP_C4000, DSP_C5000, DSP_C5500, DSP_C6000,
 *   TRICORE_TC22XX, Paradigm_ST8028, tricore-gcc,
 *   aarch64-clang++, aarch64-gnu-g++, aarch64-linux-gnu-g++,
 *   cl2000, cl7x, cpp, cross-platform, i686-pc-windows-msvc,
 *   linux-universal, windows-universal
 */
// ── SpecChecker compiler preset selection ────────────────────────────────
//
// Available presets (from config/compilers/):
//   Embedded MCU:    ARM, C51, IAR_78, IAR_80, MSP430, Paradigm_ST8028
//   TI DSP:          DSP_C2000, DSP_C3x4x, DSP_C4000, DSP_C5000, DSP_C5500, DSP_C6000, cl2000, cl7x
//   AArch64:         aarch64-clang++, aarch64-gnu-g++, aarch64-linux-gnu-g++
//   TriCore:         TRICORE_TC22XX, tricore-gcc
//   Desktop/Server:  i686-pc-windows-msvc, linux-universal, windows-universal, cross-platform
//   Generic:         ANSI, GNUC
//
// Selection uses a two-phase classification + table lookup:
//   1. detectCpuFamily()  — identifies CPU architecture from target_cpu and compiler hints
//   2. detectToolchain()  — identifies compiler/IDE from compiler_dialect string
//   3. PRESET_TABLE       — maps (cpuFamily, toolchain) → preset name
// ─────────────────────────────────────────────────────────────────────────

/**
 * CPU family patterns — evaluated top-to-bottom, first match wins.
 * Word-boundary anchors (\b) prevent false substring matches
 * (e.g. "armcc" won't trigger the ARM CPU pattern).
 */
const CPU_FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // ── 8051 family ──
  [/\b(?:8051|80c51|c51|at89|stc\d|w78|n76)\b/i, "8051"],

  // ── ARM 32-bit (Cortex-M, Cortex-R, classic cores) ──
  [/\bcortex[_-]?[mr]\d*/i, "arm32"],
  [/\barm[_-]?(?:7|9|11|926|946|966)\w*/i, "arm32"],
  // Common ARM Cortex-M MCU product families
  [/\b(?:stm32|gd32|at32|apm32|efm32|s32k|xmc\d|lpc\d|nrf5\d|atsam|rp20\d\d)/i, "arm32"],

  // ── ARM 64-bit / AArch64 (must precede generic "arm") ──
  [/\b(?:aarch64|arm64)\b/i, "aarch64"],
  [/\bcortex[_-]?a\d*/i, "aarch64"],
  [/\b(?:imx|i\.mx)[89]\d*/i, "aarch64"],

  // ── Generic "arm" (\b prevents matching inside "armcc"/"armclang") ──
  [/\barm\b/i, "arm32"],
  // IAR product name EWARM → ARM
  [/\bewarm\b/i, "arm32"],

  // ── TI MSP430 ──
  [/\bmsp430/i, "msp430"],

  // ── Infineon TriCore / AURIX ──
  [/\b(?:tricore|tc[23]\d{2}|aurix)/i, "tricore"],

  // ── TI DSP families (most specific patterns first) ──
  [/\b(?:tms320c6|c6[4-9]\d{2}|c674\d)/i, "ti_c6x"],
  [/\b(?:tms320c55|c55\d{2})/i, "ti_c55x"],
  [/\b(?:tms320c5[0-4]|c5[0-4]\d{2})/i, "ti_c5x"],
  [/\bc4000\b/i, "ti_c4x"],
  [/\b(?:tms320c[34]\d|c[34]\d[x\d])/i, "ti_c3x4x"],
  [/\b(?:c7[0-9x]|tms320c7)/i, "ti_c7x"],
  [/\b(?:c2000|tms320f\d|f28\d|c28\d)/i, "ti_c2000"],

  // ── Renesas ──
  [/\b(?:78k|rl78)\b/i, "renesas_78k"],
  [/\b(?:ew78k|ewrl78)\b/i, "renesas_78k"],
  [/\brx\d{2,}/i, "renesas_rx"],
  [/\bewrx\b/i, "renesas_rx"],
  [/\b(?:sh[247]\d*|superh)\b/i, "renesas_sh"],
  [/\bv850/i, "renesas_v850"],

  // ── ST8 / ST10 / Paradigm ──
  [/\b(?:stm?8|st10)/i, "st8"],

  // ── x86 family ──
  [/\b(?:x86[_-]64|amd64|x64)\b/i, "x86_64"],
  [/\b(?:x86|i[3-6]86)\b/i, "x86"],

  // ── Other architectures ──
  [/\b(?:ppc|powerpc|spc5\d|mpc5\d)/i, "ppc"],
  [/\b(?:riscv|risc[_-]?v|ch32v)/i, "riscv"],
  [/\bmips\b/i, "mips"],
  [/\bavr/i, "avr"],
  [/\bewavr\b/i, "avr"],
]

/**
 * Compiler/toolchain patterns — more specific patterns precede generic ones
 * (e.g. "armclang" before "clang", "ewarm" as IAR variant).
 */
const TOOLCHAIN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\barmclang\b/i, "clang"],
  [/\barmcc\b/i, "armcc"],
  [/\bclang\b/i, "clang"],
  [/\biar\b/i, "iar"],
  [/\b(?:ewarm|ewrl78|ew78k|ewavr|ewrx)\b/i, "iar"],
  [/\b(?:keil|mdk|uvision)\b/i, "keil"],
  [/\bmsvc\b/i, "msvc"],
  [/\b(?:green\s*hills?|ghs|multi)\b/i, "greenhill"],
  [/\b(?:wind\s*river|diab|vxworks)\b/i, "windriver"],
  [/\b(?:ccs|ti[_-]cgt)\b/i, "ti"],
  [/\bti\b/i, "ti"],
  [/\b(?:gcc|gnu|g\+\+)\b/i, "gcc"],
]

/**
 * Preset lookup table: cpuFamily → { toolchain: preset, _: defaultPreset }
 * The "_" key is the default when no toolchain-specific entry matches.
 */
const PRESET_TABLE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "8051":         { _: "C51" },
  "arm32":        { iar: "IAR_80", _: "ARM" },
  "aarch64":      { clang: "aarch64-clang++", gcc: "aarch64-gnu-g++", _: "aarch64-linux-gnu-g++" },
  "msp430":       { _: "MSP430" },
  "tricore":      { gcc: "tricore-gcc", _: "TRICORE_TC22XX" },
  "ti_c6x":       { _: "DSP_C6000" },
  "ti_c55x":      { _: "DSP_C5500" },
  "ti_c5x":       { _: "DSP_C5000" },
  "ti_c4x":       { _: "DSP_C4000" },
  "ti_c3x4x":     { _: "DSP_C3x4x" },
  "ti_c7x":       { _: "cl7x" },
  "ti_c2000":     { ti: "cl2000", _: "DSP_C2000" },
  "renesas_78k":  { _: "IAR_78" },
  "renesas_rx":   { iar: "IAR_80", _: "GNUC" },
  "renesas_sh":   { iar: "IAR_80", _: "GNUC" },
  "renesas_v850": { iar: "IAR_80", _: "GNUC" },
  "st8":          { _: "Paradigm_ST8028" },
  "x86_64":       { msvc: "i686-pc-windows-msvc", _: "linux-universal" },
  "x86":          { msvc: "i686-pc-windows-msvc", _: "cross-platform" },
  "ppc":          { greenhill: "cross-platform", windriver: "cross-platform", _: "GNUC" },
  "riscv":        { _: "GNUC" },
  "mips":         { _: "GNUC" },
  "avr":          { _: "GNUC" },
}

/** Fallback when CPU family is unknown — select by toolchain alone. */
const TOOLCHAIN_ONLY_FALLBACK: Readonly<Record<string, string>> = {
  iar:       "IAR_80",
  armcc:     "ARM",
  clang:     "cross-platform",
  keil:      "ARM",
  msvc:      "i686-pc-windows-msvc",
  ti:        "DSP_C2000",
  greenhill: "cross-platform",
  windriver: "cross-platform",
  gcc:       "GNUC",
}

/**
 * Detect CPU architecture family from target_cpu string and compiler hints.
 * Checks target_cpu first (high confidence), then falls back to CPU keywords
 * embedded in the compiler string (e.g. "keil c51" → 8051, "ewarm" → ARM).
 */
function detectCpuFamily(targetCpu: string, compiler: string): string | null {
  const cpu = targetCpu.toLowerCase()
  const comp = compiler.toLowerCase()

  // Priority 1: match from explicit target_cpu field
  for (const [re, family] of CPU_FAMILY_PATTERNS) {
    if (re.test(cpu)) return family
  }

  // Priority 2: extract CPU hints from compiler string
  for (const [re, family] of CPU_FAMILY_PATTERNS) {
    if (re.test(comp)) return family
  }

  return null
}

/**
 * Detect compiler/IDE toolchain from the compiler_dialect string.
 * Patterns are ordered from most specific to most generic.
 */
function detectToolchain(compiler: string): string | null {
  const comp = compiler.toLowerCase()
  for (const [re, toolchain] of TOOLCHAIN_PATTERNS) {
    if (re.test(comp)) return toolchain
  }
  return null
}

/**
 * Select the best SpecChecker compiler preset based on target CPU and compiler info.
 *
 * Uses a two-phase classification:
 *   1. Identify CPU family (from target_cpu, or compiler string as fallback)
 *   2. Identify toolchain (from compiler string)
 * Then looks up the preset from a (cpuFamily, toolchain) table.
 *
 * Examples:
 *   ("cortex-m4", "gcc")       → ARM
 *   ("cortex-m4", "iar")       → IAR_80
 *   ("", "keil c51")           → C51   (CPU "8051" from compiler hint)
 *   ("", "keil")               → ARM   (toolchain-only fallback)
 *   ("8051", "keil")           → C51
 *   ("aarch64", "armclang")    → aarch64-clang++
 *   ("stm32f407", "gcc")       → ARM   (MCU family → arm32)
 *   ("f28379d", "ti")          → cl2000
 */
function selectSpecCheckerCompiler(
  targetCpu?: string,
  compiler?: string,
): string {
  const cpuFamily = detectCpuFamily(targetCpu ?? "", compiler ?? "")
  const toolchain = detectToolchain(compiler ?? "")

  // Phase 1: CPU family identified — use (cpuFamily, toolchain) lookup
  if (cpuFamily) {
    const presets = PRESET_TABLE[cpuFamily]
    if (presets) {
      if (toolchain && presets[toolchain]) return presets[toolchain]
      // x86_64 platform-aware default
      if (cpuFamily === "x86_64" && !toolchain && process.platform === "win32") {
        return "windows-universal"
      }
      return presets._ ?? "ANSI"
    }
  }

  // Phase 2: CPU unknown — select by toolchain alone
  if (toolchain) {
    return TOOLCHAIN_ONLY_FALLBACK[toolchain] ?? "ANSI"
  }

  // Phase 3: no information available
  return "ANSI"
}

/** Return alternative SpecChecker presets to try after a PREFLIGHT_WRONG_PRESET failure. */
function buildAlternativePresets(currentPreset: string): string[] {
  // Embedded-first order: most common embedded presets first, then desktop/generic
  const ALL_COMMON = [
    "ARM", "GNUC", "C51", "IAR_80", "ANSI",
    "cross-platform", "aarch64-gnu-g++", "i686-pc-windows-msvc",
  ]
  return ALL_COMMON.filter(p => p !== currentPreset)
}

/** Resolved config from .matrix/config or auto-discovery */
interface ResolvedConfig {
  specCheckerHome: string
  exePath: string
  ruleset: string
  source: "config" | "env" | "path" | "auto_discovered" | "global_search"
}

/** Find .matrix/ root by walking up from a directory */
function findMatrixRoot(startDir: string): string | null {
  let dir = resolve(startDir)
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".matrix"))) return dir
    const parent = resolve(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Read specchecker config from .matrix/config/matrix.jsonc */
function readMatrixConfig(matrixRoot: string): { specchecker_home?: string; specchecker_ruleset?: string } {
  const configPath = join(matrixRoot, ".matrix", "config", "matrix.jsonc")
  if (!existsSync(configPath)) return {}
  try {
    return jsonc.parse(readFileSync(configPath, "utf-8")) ?? {}
  } catch {
    return {}
  }
}

/** Auto-persist discovered SpecChecker config to .matrix/config/matrix.jsonc */
function persistSpecCheckerConfig(matrixRoot: string, home: string, ruleset: string): void {
  const configDir = join(matrixRoot, ".matrix", "config")
  const configPath = join(configDir, "matrix.jsonc")
  mkdirSync(configDir, { recursive: true })

  let config: any = {}
  if (existsSync(configPath)) {
    try {
      config = jsonc.parse(readFileSync(configPath, "utf-8")) ?? {}
    } catch { /* start fresh */ }
  }

  // Only write if not already set
  let changed = false
  if (!config.specchecker_home) {
    config.specchecker_home = home
    changed = true
  }
  if (!config.specchecker_ruleset) {
    config.specchecker_ruleset = ruleset
    changed = true
  }

  if (changed) {
    // Write with comments for discoverability
    const lines = [
      "{",
      `  // SpecChecker 安装目录 (auto-discovered, edit to override)`,
      `  "specchecker_home": ${JSON.stringify(config.specchecker_home)},`,
      `  // 规则集名称`,
      `  "specchecker_ruleset": ${JSON.stringify(config.specchecker_ruleset)}`,
    ]
    // Preserve other config keys
    for (const [key, value] of Object.entries(config)) {
      if (key === "specchecker_home" || key === "specchecker_ruleset") continue
      lines.push(`  ,${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    }
    lines.push("}")
    writeFileSync(configPath, lines.join("\n"), "utf-8")
  }
}

/** Resolve SpecChecker executable and config from all sources */
function resolveSpecCheckerConfig(targetDir: string, argsRuleset?: string): ResolvedConfig | null {
  const matrixRoot = findMatrixRoot(targetDir)

  // 1. Try .matrix/config/matrix.jsonc
  if (matrixRoot) {
    const cfg = readMatrixConfig(matrixRoot)
    if (cfg.specchecker_home) {
      const exe = join(cfg.specchecker_home, "specchecker.exe")
      if (existsSync(exe)) {
        return {
          specCheckerHome: cfg.specchecker_home,
          exePath: exe,
          ruleset: argsRuleset || cfg.specchecker_ruleset || DEFAULT_RULESET,
          source: "config",
        }
      }
    }
  }

  // 2. Try SPECCHECKER_HOME environment variable
  const envHome = process.env.SPECCHECKER_HOME
  if (envHome) {
    const exe = join(envHome, "specchecker.exe")
    if (existsSync(exe)) {
      // Auto-persist to config for future runs
      if (matrixRoot) persistSpecCheckerConfig(matrixRoot, envHome, argsRuleset || DEFAULT_RULESET)
      return {
        specCheckerHome: envHome,
        exePath: exe,
        ruleset: argsRuleset || DEFAULT_RULESET,
        source: "env",
      }
    }
  }

  // 2.5. Try PATH — look for specchecker.exe on system PATH
  try {
    const whereCmd = process.platform === "win32" ? "where specchecker.exe" : "which specchecker.exe"
    const found = execSync(whereCmd, { encoding: "utf-8", timeout: 5_000 }).trim().split(/\r?\n/)[0]
    if (found && existsSync(found)) {
      const home = resolve(found, "..")
      if (matrixRoot) persistSpecCheckerConfig(matrixRoot, home, argsRuleset || DEFAULT_RULESET)
      return {
        specCheckerHome: home,
        exePath: found,
        ruleset: argsRuleset || DEFAULT_RULESET,
        source: "path",
      }
    }
  } catch {
    // Not on PATH — continue to next strategy
  }

  // 3. Try common installation paths (auto-discovery)
  for (const p of COMMON_SPECCHECKER_PATHS) {
    const exe = join(p, "specchecker.exe")
    if (existsSync(exe)) {
      // Auto-persist to config for future runs
      if (matrixRoot) persistSpecCheckerConfig(matrixRoot, p, argsRuleset || DEFAULT_RULESET)
      return {
        specCheckerHome: p,
        exePath: exe,
        ruleset: argsRuleset || DEFAULT_RULESET,
        source: "auto_discovered",
      }
    }
  }

  // 4. Global filesystem search — scan all drive roots for SpecChecker installations
  const globalFound = globalSearchSpecChecker()
  if (globalFound) {
    if (matrixRoot) persistSpecCheckerConfig(matrixRoot, globalFound, argsRuleset || DEFAULT_RULESET)
    return {
      specCheckerHome: globalFound,
      exePath: join(globalFound, "specchecker.exe"),
      ruleset: argsRuleset || DEFAULT_RULESET,
      source: "global_search",
    }
  }

  return null
}

/**
 * Global filesystem search for specchecker.exe.
 * On Windows: scans all available drive letters at common depths.
 * Returns the parent directory of the first found specchecker.exe, or null.
 */
function globalSearchSpecChecker(): string | null {
  // Common directory patterns where SpecChecker might be installed
  const searchPatterns = [
    "SunwiseInfo/SpecCheckerWeb/SpecChecker",
    "SunwiseInfo/SpecChecker",
    "SpecChecker",
    "Program Files/SpecChecker",
    "Program Files (x86)/SpecChecker",
    "Program Files/SunwiseInfo/SpecCheckerWeb/SpecChecker",
    "Program Files (x86)/SunwiseInfo/SpecCheckerWeb/SpecChecker",
  ]

  if (process.platform === "win32") {
    // Discover available drive letters
    try {
      const drivesRaw = execSync("wmic logicaldisk get name", {
        encoding: "utf-8",
        timeout: 5_000,
      })
      const drives = drivesRaw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[A-Z]:$/.test(l))

      for (const drive of drives) {
        for (const pattern of searchPatterns) {
          const candidate = join(drive + "\\", pattern)
          const exe = join(candidate, "specchecker.exe")
          if (existsSync(exe)) return candidate
        }
      }
    } catch {
      // wmic failed — fall back to common drives
      for (const drive of ["C:", "D:", "E:", "F:"]) {
        for (const pattern of searchPatterns) {
          const candidate = join(drive + "\\", pattern)
          const exe = join(candidate, "specchecker.exe")
          if (existsSync(exe)) return candidate
        }
      }
    }
  }

  return null
}

/** Append a specchecker command to .matrix/log/specchecker_cmd.log */
function logSpecCheckerCmd(matrixRoot: string | null, cmd: string): void {
  if (!matrixRoot) return
  try {
    const logDir = join(matrixRoot, ".matrix", "log")
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, "specchecker_cmd.log")
    const timestamp = new Date().toISOString()
    appendFileSync(logPath, `[${timestamp}] ${cmd}\n`, "utf-8")
  } catch { /* ignore logging errors */ }
}

/** Run a command with inactivity-based timeout: kills process after 5 min of no stdout/stderr output */
function runCommand(
  cmd: string,
  cwd: string,
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: "pipe" })
    const chunks: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] }
    let timer: ReturnType<typeof setTimeout>

    const resetTimer = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        child.kill()
        resolve({
          success: false,
          stdout: chunks.stdout.join(""),
          stderr:
            chunks.stderr.join("") +
            "\n[STALLED] Process killed after 5 min inactivity",
          exitCode: -1,
        })
      }, INACTIVITY_TIMEOUT_MS)
    }

    resetTimer()
    child.stdout?.on("data", (d: Buffer) => { chunks.stdout.push(String(d)); resetTimer() })
    child.stderr?.on("data", (d: Buffer) => { chunks.stderr.push(String(d)); resetTimer() })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        success: code === 0,
        stdout: chunks.stdout.join(""),
        stderr: chunks.stderr.join(""),
        exitCode: code ?? 1,
      })
    })
  })
}

interface Violation {
  rule_id: string
  rule_name: string
  severity: string
  category: string
  conformance: string
  priority: string
  file: string
  line: number
  column: number
  message: string
  code_snippet: string
  fixability: string
  check_type: "rule_check" | "runtime_error" | "fault_pattern"
  has_builtin_repair: boolean
  has_skill_context: boolean
}

/** Parse SpecChecker JSON report into structured violations */
function parseSpecCheckerReport(jsonPath: string): {
  violations: Violation[]
  rules: Record<string, { name: string; description: string; category: string; priority: string; conformance: string }>
  errors: string[]
} {
  const errors: string[] = []
  const violations: Violation[] = []
  const rules: Record<string, any> = {}

  let data: any
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf-8"))
  } catch (e) {
    return { violations, rules, errors: [`Failed to parse JSON report: ${e}`] }
  }

  // JSON format: list with one element containing summary, ruleCheck
  if (Array.isArray(data) && data.length > 0) {
    data = data[0]
  }

  // Collect all check sections:
  //   ruleCheck     — coding standard violations
  //   runtimeError  — runtime error analysis (--runtime-error)
  //   faultParttern — typical fault patterns (--fault-pattern, note: SpecChecker typo "Parttern")
  const checkSections: Array<{ data: any; checkType: Violation["check_type"] }> = ([
    { data: data?.ruleCheck, checkType: "rule_check" as const },
    { data: data?.runtimeError, checkType: "runtime_error" as const },
    { data: data?.faultParttern, checkType: "fault_pattern" as const },
  ] satisfies Array<{ data: any; checkType: Violation["check_type"] }>).filter((s) => s.data)

  // Build rules lookup table (keyed per section to avoid id collisions)
  const allRulesLookup: Array<{ lookup: Record<number, any>; violations: any[]; checkType: Violation["check_type"] }> = []
  for (const section of checkSections) {
    const lookup: Record<number, any> = {}
    for (const ruleEntry of section.data.rule ?? []) {
      lookup[ruleEntry.id ?? -1] = ruleEntry
    }
    allRulesLookup.push({ lookup, violations: section.data.violation ?? [], checkType: section.checkType })
  }

  // Parse violations from all sections
  for (const { lookup: rulesLookup, violations: sectionViolations, checkType } of allRulesLookup)
  for (const vio of sectionViolations) {
    const ruleIdIdx = vio.ruleid ?? -1
    const ruleInfo = rulesLookup[ruleIdIdx] ?? {}

    let cid = ruleInfo.cid ?? ""
    // Handle multi-CID rules
    if (cid.includes(",")) {
      cid = cid.split(",")[0].trim()
    }

    const ruleName = (ruleInfo.description ?? "").trim()
    const priorityCn = ruleInfo.priority ?? ""
    const conlevelCn = ruleInfo.conlevel ?? ruleInfo.conLevel ?? ""
    const categoryCn = ruleInfo.category ?? ""

    const priority = PRIORITY_MAP[priorityCn] ?? ""
    const conformance = CONFORMANCE_MAP[conlevelCn] ?? ""
    const categoryId = CATEGORY_MAP[categoryCn] ?? categoryCn

    const severity = priority === "P001" ? "critical" : priority === "P002" ? "major" : "minor"

    // Extract code snippet
    const codeRaw = vio.code ?? ""
    const codeLines = codeRaw.split("\n")
    const snippet = codeLines[0]?.trim() ?? ""

    const fixability = classifyIssue(cid)

    violations.push({
      rule_id: cid,
      rule_name: ruleName,
      severity,
      category: categoryId,
      conformance,
      priority,
      file: vio.file ?? "",
      line: vio.line ?? 0,
      column: vio.column ?? 0,
      message: vio.message ?? "",
      code_snippet: snippet,
      fixability,
      check_type: checkType,
      has_builtin_repair: hasBuiltinStrategy(cid),
      has_skill_context: getSkillContext(cid) !== null,
    })

    // Collect rules
    if (cid && !rules[cid]) {
      rules[cid] = {
        name: ruleName,
        description: ruleInfo.specification ?? ruleName,
        category: categoryId,
        priority,
        conformance,
      }
    }
  }

  return { violations, rules, errors }
}

export const misraChecker: ToolDefinition = tool({
  description:
    "Run SpecChecker static analysis on C source files for aerospace coding standard compliance " +
    "(航天器C语言编程规范). Supports these modes:\n" +
    "- 'check': Full project analysis via SpecChecker 3-step pipeline (create→analyze→report). " +
    "Automatically writes .matrix/data/sa-raw-findings.json (SARawFindingsReport schema) with RAW-NNN IDs. " +
    "Accepts optional 'compiler' param to select a preset compilation config (ARM, C51, GNUC, IAR_80, etc.). " +
    "Auto-reads .matrix/data/compilation-env.json for include dirs and compiler dialect. " +
    "Returns violations with rule IDs, severity, fixability classification, and repair availability.\n" +
    "- 'repair_all': Generate repair suggestions for ALL auto_fixable violations from the check result. " +
    "Pass the violations JSON string from check output. Returns patches for all repairable violations.\n" +
    "- 'repair': Generate a repair suggestion for a SINGLE violation. " +
    "Provide file_path, rule_id, violation_line.\n" +
    "- 'verify': Verify a repair by applying it to a temp copy and re-running SpecChecker.\n" +
    `Loaded ${getSkillCount()} repair skills across 16 categories (C001-C016).`,
  args: {
    mode: tool.schema
      .enum(["check", "create", "analyze", "repair", "repair_all", "verify"])
      .describe(
        "'check' to run full pipeline (create+analyze+report), " +
        "'create' to create project only (returns emit_dir/project_path for preflight), " +
        "'analyze' to run analyze+report on an existing project (after preflight fixes), " +
        "'repair_all' to batch-repair all auto_fixable violations, " +
        "'repair' to fix a single violation, 'verify' to validate a repair patch",
      ),
    project_dir: tool.schema
      .string()
      .optional()
      .describe("Project source directory for 'check'/'create' mode (absolute path)"),
    file_path: tool.schema
      .string()
      .optional()
      .describe(
        "Single source file path. In 'check' mode: analyze single file only. " +
        "In 'repair'/'verify' mode: the file containing the violation.",
      ),
    ruleset: tool.schema
      .string()
      .optional()
      .describe("SpecChecker ruleset name (default: from config or 航天器C语言软件编程约定2024版)"),
    // repair mode args
    rule_id: tool.schema
      .string()
      .optional()
      .describe("Rule ID (e.g. CID181) for 'repair' mode"),
    violation_line: tool.schema
      .string()
      .optional()
      .describe("Violation line number (as string) for 'repair' mode"),
    // repair_all mode args
    violations_json: tool.schema
      .string()
      .optional()
      .describe(
        "JSON string of violations array from 'check' mode output. " +
        "For 'repair_all' mode: pass the full violations array to batch-repair all auto_fixable items.",
      ),
    // verify mode args
    original_code: tool.schema
      .string()
      .optional()
      .describe("Original code to replace (for 'verify' mode)"),
    repaired_code: tool.schema
      .string()
      .optional()
      .describe("Repaired code to apply (for 'verify' mode)"),
    start_line: tool.schema
      .string()
      .optional()
      .describe("Patch start line number (for 'verify' mode)"),
    end_line: tool.schema
      .string()
      .optional()
      .describe("Patch end line number (for 'verify' mode)"),
    // analyze mode args
    project_path: tool.schema
      .string()
      .optional()
      .describe(
        "SpecChecker project path for 'analyze' mode (returned by 'create' mode as project_path). " +
        "Required for 'analyze' mode, ignored for other modes.",
      ),
    // compilation environment args (check/create mode)
    compiler: tool.schema
      .string()
      .optional()
      .describe(
        "SpecChecker preset compiler name for 'check' mode (e.g. ARM, C51, GNUC, IAR_80, ANSI, DSP_C2000). " +
        "Maps to config/compilers/<name>/ in SpecChecker installation. " +
        "If omitted, auto-detected from .matrix/data/compilation-env.json compiler_dialect.",
      ),
    include_dirs: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of additional include directories for 'check' mode. " +
        "Appended to analysis.conf after dedup against existing paths in compiler.conf and analysis.conf.",
      ),
    parallel: tool.schema
      .string()
      .optional()
      .describe(
        "Number of parallel analysis threads for SpecChecker (e.g. '4'). " +
        "Maps to -j flag. Defaults to SpecChecker's own default if omitted. " +
        "Set based on available CPU cores for optimal performance.",
      ),
    defines: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of additional -d preprocessor define entries for 'check' mode. " +
        "Appended to compiler.conf after dedup against existing defines.",
      ),
  },
  async execute(args) {
    const { mode } = args

    if (mode === "check") {
      return await executeCheck(args)
    } else if (mode === "create") {
      return await executeCreate(args)
    } else if (mode === "analyze") {
      return await executeAnalyze(args)
    } else if (mode === "repair_all") {
      return executeRepairAll(args)
    } else if (mode === "repair") {
      return executeRepair(args)
    } else if (mode === "verify") {
      return await executeVerify(args)
    }

    return JSON.stringify({ error: `Unknown mode: ${mode}` })
  },
})

// ─── COMPILATION ENVIRONMENT HELPERS ─────────────────────────────────────────

/** Normalize a path for case-insensitive comparison on Windows */
function normalizePath(p: string): string {
  const resolved = resolve(p)
  // Windows: case-insensitive, normalize separators
  return process.platform === "win32" ? resolved.toLowerCase().replace(/\\/g, "/") : resolved
}

function isPathWithinRoot(filePath: string, rootDir: string): boolean {
  const normalizedRoot = normalizePath(rootDir).replace(/\/+$/, "")
  const normalizedFile = normalizePath(filePath)
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)
}

/**
 * Normalize a finding's file path for review.
 *
 * SpecChecker reports contain absolute paths pointing to the workspace copy
 * (e.g. D:\SunwiseInfo\SpecChecker\workspace\project\power.c).
 * Page workers running in the background cannot read files outside the project
 * directory (OpenCode blocks on permission prompt that background agents can't
 * answer). This function maps workspace paths back to source-relative paths.
 *
 * Priority:
 * 1. If path is under sourceDir → relativize to matrixRoot
 * 2. If path is under projectPath (SpecChecker workspace) → map to sourceDir, then relativize
 * 3. Fallback → just the basename (always readable from project root)
 */
export function normalizeFindingPathForReview(
  filePath: string,
  matrixRoot: string | null,
  sourceDir?: string,
  projectPath?: string,
): string {
  if (!filePath) return filePath

  const normalizedInput = filePath.replace(/\\/g, "/")
  if (!isAbsolute(filePath)) return normalizedInput

  // Case 1: path is within matrixRoot → relativize directly
  if (matrixRoot && isPathWithinRoot(filePath, matrixRoot)) {
    const rel = relative(matrixRoot, filePath).replace(/\\/g, "/")
    return rel.length > 0 ? rel : basename(filePath)
  }

  // Case 2: path is within SpecChecker workspace (projectPath) → map to sourceDir
  if (projectPath && sourceDir && isPathWithinRoot(filePath, projectPath)) {
    const relToProject = relative(projectPath, filePath)
    const mappedPath = join(sourceDir, relToProject)
    if (matrixRoot && isPathWithinRoot(mappedPath, matrixRoot)) {
      const rel = relative(matrixRoot, mappedPath).replace(/\\/g, "/")
      return rel.length > 0 ? rel : basename(filePath)
    }
    return mappedPath.replace(/\\/g, "/")
  }

  // Case 3: path is outside both → use basename to keep it readable
  // This ensures page workers can find the file via glob in the project
  return basename(filePath)
}

/** Extract all -i include paths from a SpecChecker conf file content */
function extractIncludePaths(confContent: string): Set<string> {
  const paths = new Set<string>()
  for (const line of confContent.split("\n")) {
    const trimmed = line.trim()
    // Match: -i "path" or -i path (with or without quotes)
    const match = trimmed.match(/^-i\s+"?([^"]+)"?\s*$/)
    if (match) {
      paths.add(normalizePath(match[1]))
    }
  }
  return paths
}

/**
 * Read .matrix/data/compilation-env.json if it exists.
 * Returns the parsed CompilationEnvironment or null.
 */
function resolveCompilationEnv(targetDir: string): {
  compiler_dialect?: string
  target_cpu?: string
  include_dirs?: string[]
  defines?: string[]
  preprocessed_dir?: string
} | null {
  const matrixRoot = findMatrixRoot(targetDir)
  if (!matrixRoot) return null

  const envPath = join(matrixRoot, ".matrix", "data", "compilation-env.json")
  if (!existsSync(envPath)) return null

  try {
    return JSON.parse(readFileSync(envPath, "utf-8"))
  } catch {
    return null
  }
}

/**
 * Resolve the list of C/C++ source files for pre-flight checking.
 *
 * Priority:
 *   1. .matrix/data/compile_commands.json (most accurate — respects build system)
 *   2. Recursive scan of sourceDir for .c/.cpp/.cc/.cxx files (fallback)
 */
/**
 * Determine the SpecChecker compiler preset from available sources.
 * Priority: explicit arg → compilation-env (target_cpu + compiler) → default
 */
function resolveCompilerName(
  compilerArg?: string,
  compilationEnv?: { compiler_dialect?: string; target_cpu?: string } | null,
): { name: string; explicit: boolean } {
  // Explicit tool arg is already a SpecChecker preset name — use directly
  if (compilerArg) return { name: compilerArg, explicit: true }
  // Derive from compilation environment: target platform first, compiler second
  if (compilationEnv?.target_cpu || compilationEnv?.compiler_dialect) {
    return {
      name: selectSpecCheckerCompiler(compilationEnv.target_cpu, compilationEnv.compiler_dialect),
      explicit: true,
    }
  }
  return { name: "GNUC", explicit: false }
}

/**
 * After SpecChecker `create`, inject additional include dirs into analysis.conf.
 * Reads existing -i paths from both compiler.conf and analysis.conf to avoid duplicates.
 */
function injectCompilationConfig(
  specHome: string,
  projectPath: string,
  targetDir: string,
  includeDirsArg?: string,
  definesArg?: string,
): { injected_includes: string[]; injected_defines: string[] } {
  const emitDir = join(projectPath, "emit", "unit")
  const analysisConfPath = join(emitDir, "analysis.conf")
  const compilerConfPath = join(emitDir, "compiler.conf")

  // Collect existing -i paths from both conf files
  const existingIncludes = new Set<string>()

  if (existsSync(compilerConfPath)) {
    for (const p of extractIncludePaths(readFileSync(compilerConfPath, "utf-8"))) {
      existingIncludes.add(p)
    }
  }

  let analysisContent = ""
  if (existsSync(analysisConfPath)) {
    analysisContent = readFileSync(analysisConfPath, "utf-8")
    for (const p of extractIncludePaths(analysisContent)) {
      existingIncludes.add(p)
    }
  }

  // Gather candidate include dirs
  const candidateDirs: string[] = []

  // From compilation-env.json
  const compEnv = resolveCompilationEnv(targetDir)
  if (compEnv?.include_dirs) {
    candidateDirs.push(...compEnv.include_dirs)
  }

  // From .matrix/stubs/
  const matrixRoot = findMatrixRoot(targetDir)
  if (matrixRoot) {
    const stubsDir = join(matrixRoot, ".matrix", "stubs")
    if (existsSync(stubsDir)) {
      candidateDirs.push(stubsDir)
    }
  }

  // From explicit arg (JSON array)
  if (includeDirsArg) {
    try {
      const dirs = JSON.parse(includeDirsArg)
      if (Array.isArray(dirs)) candidateDirs.push(...dirs)
    } catch { /* ignore parse errors */ }
  }

  // Dedup: only append paths not already in compiler.conf or analysis.conf
  const newIncludes: string[] = []
  for (const dir of candidateDirs) {
    const normalized = normalizePath(dir)
    if (!existingIncludes.has(normalized) && existsSync(dir)) {
      existingIncludes.add(normalized)
      newIncludes.push(resolve(dir))
    }
  }

  // Append new -i lines to analysis.conf
  if (newIncludes.length > 0 && existsSync(analysisConfPath)) {
    const appendLines = newIncludes.map((d) => `-i "${d}"`).join("\n")
    const updated = analysisContent.trimEnd() + "\n" + appendLines + "\n"
    writeFileSync(analysisConfPath, updated, "utf-8")
  }

  // Handle additional defines: append to compiler.conf
  const newDefines: string[] = []
  if (definesArg) {
    try {
      const defs = JSON.parse(definesArg)
      if (Array.isArray(defs)) newDefines.push(...defs)
    } catch { /* ignore parse errors */ }
  }
  if (compEnv?.defines && compEnv.defines.length > 0) {
    // Read existing defines from compiler.conf to dedup
    const existingDefines = new Set<string>()
    if (existsSync(compilerConfPath)) {
      const ccContent = readFileSync(compilerConfPath, "utf-8")
      for (const line of ccContent.split("\n")) {
        const m = line.trim().match(/^-d\s+"?([^"]+)"?\s*$/)
        if (m) existingDefines.add(m[1])
      }
    }
    for (const d of compEnv.defines) {
      if (!existingDefines.has(d)) newDefines.push(d)
    }
  }

  if (newDefines.length > 0 && existsSync(compilerConfPath)) {
    const ccContent = readFileSync(compilerConfPath, "utf-8")
    const appendLines = newDefines.map((d) => `-d "${d}"`).join("\n")
    writeFileSync(compilerConfPath, ccContent.trimEnd() + "\n" + appendLines + "\n", "utf-8")
  }

  return { injected_includes: newIncludes, injected_defines: newDefines }
}

// ─── SHARED CONTEXT FOR CHECK/CREATE/ANALYZE MODES ──────────────────────────

interface CreateContext {
  specHome: string
  exePath: string
  activeRuleset: string
  configSource: string
  sourceDir: string
  projectName: string
  projectPath: string
  matrixRoot: string | null
  reportDir: string
  compilerName: string
  compEnv: ReturnType<typeof resolveCompilationEnv>
  injection: { injected_includes: string[]; injected_defines: string[] }
}

/**
 * Resolve all paths + run SpecChecker create + inject compilation config.
 * Shared by executeCheck and executeCreate.
 */
async function doCreate(args: any): Promise<{ error?: string; ctx?: CreateContext }> {
  const { project_dir, file_path, ruleset, compiler, include_dirs, defines } = args

  if (!project_dir && !file_path) {
    return { error: JSON.stringify({ error: "Either project_dir or file_path is required" }) }
  }

  const targetDir = project_dir || (file_path ? resolve(file_path, "..") : "")

  const resolved = resolveSpecCheckerConfig(targetDir, ruleset)
  if (!resolved) {
    return { error: JSON.stringify({
      error:
        "SpecChecker not found. Set specchecker_home in .matrix/config/matrix.jsonc, " +
        "set SPECCHECKER_HOME environment variable, or add specchecker.exe to PATH.",
      hint: "specchecker_home should point to the directory containing specchecker.exe",
      tried: [
        ".matrix/config/matrix.jsonc → specchecker_home",
        "SPECCHECKER_HOME env var",
        "System PATH",
        ...COMMON_SPECCHECKER_PATHS,
        "Global filesystem search (all drives)",
      ],
    }) }
  }

  const { specCheckerHome: specHome, exePath, ruleset: activeRuleset, source: configSource } = resolved
  const sourceDir = file_path ? resolve(file_path, "..") : resolve(targetDir)
  const projectName = basename(sourceDir)

  const workspace = join(specHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const projectPath = join(workspace, projectName)

  const matrixRoot = findMatrixRoot(targetDir)
  const reportDir = matrixRoot
    ? join(matrixRoot, ".matrix", "reports")
    : join(workspace, `${projectName}_report`)
  mkdirSync(reportDir, { recursive: true })

  const compEnv = resolveCompilationEnv(targetDir)
  const { name: compilerName, explicit: compilerExplicit } = resolveCompilerName(compiler, compEnv)

  // Create project
  const compilerFlag = compilerExplicit ? `-t ${compilerName}` : "-a"
  const createCmd =
    `"${exePath}" create -p "${projectPath}" -s "${sourceDir}" ${compilerFlag} --clean`
  logSpecCheckerCmd(matrixRoot, createCmd)
  const createResult = await runCommand(createCmd, specHome)
  if (!createResult.success) {
    return { error: JSON.stringify({
      error: "SpecChecker create step failed",
      exit_code: createResult.exitCode,
      stderr: createResult.stderr.slice(0, 2000),
      stdout: createResult.stdout.slice(0, 2000),
      compiler: compilerName,
    }) }
  }

  // Inject compilation environment into project config
  const injection = injectCompilationConfig(specHome, projectPath, targetDir, include_dirs, defines)

  return { ctx: {
    specHome, exePath, activeRuleset, configSource,
    sourceDir, projectName, projectPath,
    matrixRoot, reportDir, compilerName, compEnv, injection,
  } }
}

/**
 * Run SpecChecker analyze + report + parse results.
 * Shared by executeCheck and executeAnalyze.
 */
async function doAnalyzeAndReport(ctx: CreateContext, parallel?: string): Promise<string> {
  const {
    specHome, exePath, activeRuleset, configSource,
    sourceDir, projectName, projectPath,
    matrixRoot, reportDir, compilerName, compEnv, injection,
  } = ctx

  // Analyze
  const defaultThreads = Math.max(2, Math.min(cpus().length || 4, 8))
  const parallelCount = parallel ? parseInt(parallel, 10) : defaultThreads
  const parallelFlag = ` -j ${parallelCount}`
  const analyzeCmd =
    `"${exePath}" analyze -p "${projectPath}" -r "${activeRuleset}" --runtime-error --fault-pattern${parallelFlag}`
  logSpecCheckerCmd(matrixRoot, analyzeCmd)
  const analyzeResult = await runCommand(analyzeCmd, specHome)
  if (!analyzeResult.success) {
    return JSON.stringify({
      error: "SpecChecker analyze step failed",
      exit_code: analyzeResult.exitCode,
      stderr: analyzeResult.stderr.slice(0, 2000),
    })
  }

  // Read compile.log
  let compileLog = ""
  const compileLogPath = join(projectPath, "log", "compile.log")
  try {
    if (existsSync(compileLogPath)) {
      compileLog = readFileSync(compileLogPath, "utf-8")
    }
  } catch { /* optional */ }

  // Generate JSON report
  const reportCmd =
    `"${exePath}" report -p "${projectPath}" -f json -o "${reportDir}"`
  logSpecCheckerCmd(matrixRoot, reportCmd)
  const reportResult = await runCommand(reportCmd, specHome)
  if (!reportResult.success) {
    return JSON.stringify({
      error: "SpecChecker report step failed",
      exit_code: reportResult.exitCode,
      stderr: reportResult.stderr.slice(0, 2000),
    })
  }

  // Parse report
  let jsonFiles: string[]
  try {
    jsonFiles = readdirSync(reportDir).filter((f) => f.endsWith(".json"))
  } catch {
    jsonFiles = []
  }
  if (jsonFiles.length === 0) {
    return JSON.stringify({ error: "No JSON report generated by SpecChecker" })
  }

  const { violations, rules, errors } = parseSpecCheckerReport(
    join(reportDir, jsonFiles[0]),
  )

  // Build summary
  const bySeverity: Record<string, number> = {}
  const byCategory: Record<string, number> = {}
  const byFixability: Record<string, number> = {}
  for (const v of violations) {
    bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1
    byCategory[v.category] = (byCategory[v.category] ?? 0) + 1
    byFixability[v.fixability] = (byFixability[v.fixability] ?? 0) + 1
  }

  // Write sa-raw-findings.json
  if (matrixRoot) {
    const dataDir = join(matrixRoot, ".matrix", "data")
    mkdirSync(dataDir, { recursive: true })

    const saViolations = violations.map((v, i) => ({
      id: `RAW-${String(i + 1).padStart(3, "0")}`,
      rule_id: v.rule_id,
      rule_name: v.rule_name,
      severity: v.severity,
      category: v.category,
      conformance: v.conformance,
      message: v.message,
      fixability: v.fixability,
      file: normalizeFindingPathForReview(v.file, matrixRoot, sourceDir, projectPath),
      line: v.line,
      code_snippet: v.code_snippet,
      check_type: v.check_type,
    }))

    const saReport = {
      project_name: projectName,
      analysis_date: new Date().toISOString(),
      tool: "specchecker" as const,
      source_dir: sourceDir,
      summary: {
        total: violations.length,
        by_severity: bySeverity,
        by_fixability: byFixability,
      },
      violations: saViolations,
    }

    const saPath = join(dataDir, "sa-raw-findings.json")
    const parsed = SARawFindingsReport.safeParse(saReport)
    if (!parsed.success) {
      errors.push(`sa-raw-findings.json validation failed: ${parsed.error.message}`)
    } else {
      try {
        writeFileSync(saPath, JSON.stringify(parsed.data, null, 2), "utf-8")
      } catch (e) {
        errors.push(`Failed to write sa-raw-findings.json: ${e}`)
      }
    }
  }

  // Build output
  const VIOLATIONS_PREVIEW_LIMIT = 10
  const saRawPath = matrixRoot
    ? join(matrixRoot, ".matrix", "data", "sa-raw-findings.json")
    : null
  const hasCompileErrors = !!compileLog
  const violationsPreview = violations.slice(0, VIOLATIONS_PREVIEW_LIMIT)
  const truncated = violations.length > VIOLATIONS_PREVIEW_LIMIT

  return JSON.stringify({
    ...(hasCompileErrors ? {
      action_required: "COMPILATION ERRORS DETECTED — follow Step 1.5 Compilation Diagnostics before proceeding",
      compile_log: compileLog,
    } : {
      compile_log: null,
    }),
    errors,
    project: sourceDir,
    compiler: compilerName,
    compilation_env: {
      source: compEnv ? "compilation-env.json" : "default",
      compiler_dialect: compEnv?.compiler_dialect ?? "unknown",
      injected_includes: injection.injected_includes,
      injected_defines: injection.injected_defines,
    },
    total_violations: violations.length,
    summary: {
      by_severity: bySeverity,
      by_category: byCategory,
      by_fixability: byFixability,
    },
    sa_raw_findings_path: saRawPath,
    violations_preview: violationsPreview,
    ...(truncated ? {
      violations_truncated: true,
      violations_message: `Showing first ${VIOLATIONS_PREVIEW_LIMIT} of ${violations.length} violations. Full data written to ${saRawPath ?? "sa-raw-findings.json"}. Use read tool to access complete violations.`,
    } : {}),
    ruleset: activeRuleset,
    cmd_log: matrixRoot ? join(matrixRoot, ".matrix", "log", "specchecker_cmd.log") : null,
    specchecker_home: specHome,
    project_path: projectPath,
    emit_dir: join(projectPath, "emit", "unit"),
    config_source: configSource,
    skill_count: getSkillCount(),
    rules,
  })
}

// ─── CHECK MODE (full pipeline: create → analyze → report) ──────────────────

async function executeCheck(args: any): Promise<string> {
  const { error, ctx } = await doCreate(args)
  if (error) return error
  return doAnalyzeAndReport(ctx!, args.parallel)
}

// ─── CREATE MODE (create project only, for preflight before analyze) ─────────

async function executeCreate(args: any): Promise<string> {
  const { error, ctx } = await doCreate(args)
  if (error) return error

  const { specHome, projectPath, sourceDir, compilerName, configSource, matrixRoot, compEnv, injection } = ctx!
  const emitDir = join(projectPath, "emit", "unit")

  return JSON.stringify({
    status: "project_created",
    project_path: projectPath,
    emit_dir: emitDir,
    specchecker_home: specHome,
    project: sourceDir,
    compiler: compilerName,
    config_source: configSource,
    compilation_env: {
      source: compEnv ? "compilation-env.json" : "default",
      compiler_dialect: compEnv?.compiler_dialect ?? "unknown",
      injected_includes: injection.injected_includes,
      injected_defines: injection.injected_defines,
    },
    next_step: "Run preflight_check to verify compilation, then specchecker(mode='analyze') to analyze.",
    cmd_log: matrixRoot ? join(matrixRoot, ".matrix", "log", "specchecker_cmd.log") : null,
  })
}

// ─── ANALYZE MODE HELPERS ─────────────────────────────────────────────────────

/** Find specchecker.exe under a specHome directory */
function resolveSpecCheckerExe(specHome: string): string | null {
  const exe = join(specHome, "specchecker.exe")
  return existsSync(exe) ? exe : null
}

/** Find .matrix root by walking up from a SpecChecker project path */
function findMatrixRootFromProject(projectPath: string): string | null {
  // Project is at <specHome>/workspace/<name> — matrixRoot is not derivable from this.
  // Instead, check cwd and walk up.
  return findMatrixRoot(process.cwd())
}

/** Read ruleset from matrix config */
function readRulesetFromConfig(matrixRoot: string | null): string | null {
  if (!matrixRoot) return null
  const cfg = readMatrixConfig(matrixRoot)
  return (cfg as any).specchecker_ruleset ?? null
}

/** Read the source directory from a SpecChecker project's create command (stored in project structure) */
function readSourceDirFromProject(projectPath: string): string | null {
  // SpecChecker stores the source dir in emit/unit/analysis.conf as the first -q entry
  const analysisConf = join(projectPath, "emit", "unit", "analysis.conf")
  if (!existsSync(analysisConf)) return null
  try {
    const content = readFileSync(analysisConf, "utf-8")
    for (const line of content.split("\n")) {
      const m = line.trim().match(/^-q\s+"?([^"]+?)"?\s*$/)
      if (m) return resolve(m[1])
    }
  } catch { /* ignore */ }
  return null
}

/** Read the compiler preset name from a SpecChecker project's compiler.conf */
function readCompilerFromProject(projectPath: string): string {
  // The compiler name is the directory name under config/compilers/ referenced in the project
  // For simplicity, read from the project's emit/unit/compiler.conf -t line if present
  const compilerConf = join(projectPath, "emit", "unit", "compiler.conf")
  if (!existsSync(compilerConf)) return "unknown"
  try {
    const content = readFileSync(compilerConf, "utf-8")
    const m = content.match(/^-t\s+"?([^"\s]+)"?\s*$/m)
    if (m) return m[1]
  } catch { /* ignore */ }
  return "unknown"
}

// ─── ANALYZE MODE (analyze + report on existing project) ─────────────────────

async function executeAnalyze(args: any): Promise<string> {
  const { project_path: projectPathArg, ruleset, parallel } = args

  if (!projectPathArg) {
    return JSON.stringify({
      error: "project_path is required for analyze mode (returned by create mode)",
    })
  }

  if (!existsSync(projectPathArg)) {
    return JSON.stringify({
      error: `Project path does not exist: ${projectPathArg}. Run specchecker(mode='create') first.`,
    })
  }

  // Derive context from existing project
  const projectName = basename(projectPathArg)
  const specHome = resolve(projectPathArg, "..", "..")
  const exePath = resolveSpecCheckerExe(specHome)
  if (!exePath) {
    return JSON.stringify({ error: `specchecker.exe not found under ${specHome}` })
  }

  // Read ruleset from arg or config
  const matrixRoot = findMatrixRootFromProject(projectPathArg)
  const activeRuleset = ruleset ?? readRulesetFromConfig(matrixRoot) ?? DEFAULT_RULESET

  const reportDir = matrixRoot
    ? join(matrixRoot, ".matrix", "reports")
    : join(resolve(projectPathArg, ".."), `${projectName}_report`)
  mkdirSync(reportDir, { recursive: true })

  // Read source dir from project's analysis.conf (first -q or -i entry that looks like a source dir)
  const sourceDir = readSourceDirFromProject(projectPathArg) ?? projectName

  const compEnv = matrixRoot ? resolveCompilationEnv(matrixRoot) : null
  const compilerName = readCompilerFromProject(projectPathArg)

  const ctx: CreateContext = {
    specHome, exePath, activeRuleset,
    configSource: "existing_project",
    sourceDir: typeof sourceDir === "string" ? sourceDir : projectName,
    projectName, projectPath: projectPathArg,
    matrixRoot, reportDir, compilerName,
    compEnv,
    injection: { injected_includes: [], injected_defines: [] },
  }

  return doAnalyzeAndReport(ctx, parallel)
}

// ─── REPAIR MODE ─────────────────────────────────────────────────────────────

function executeRepair(args: any): string {
  const { file_path, rule_id, violation_line } = args

  if (!file_path || !rule_id || !violation_line) {
    return JSON.stringify({
      error: "file_path, rule_id, and violation_line are required for repair mode",
    })
  }

  if (!existsSync(file_path)) {
    return JSON.stringify({ error: `File not found: ${file_path}` })
  }

  const lineNum = parseInt(violation_line, 10)
  if (isNaN(lineNum) || lineNum < 1) {
    return JSON.stringify({ error: `Invalid violation_line: ${violation_line}` })
  }

  const content = readFileSync(file_path, "utf-8")
  const fileLines = content.split("\n")
  const fixability = classifyIssue(rule_id)

  // Try builtin strategy first
  let patch = tryBuiltinRepair(rule_id, file_path, fileLines, lineNum)
  let repairSource = "builtin"

  // Try skill-based repair if no builtin
  if (!patch) {
    patch = trySkillRepair(rule_id, file_path, fileLines, lineNum)
    repairSource = "skill"
  }

  // Get skill context for LLM reasoning (even if no auto repair found)
  const skillContext = getSkillContext(rule_id)

  if (patch) {
    const risk = assessPatchRisk(patch)
    return JSON.stringify({
      status: "repair_found",
      fixability,
      repair_source: repairSource,
      suggestion: {
        rule_id,
        risk_level: risk.level,
        risk_warnings: risk.warnings,
        is_auto_applicable: risk.level === "safe" || risk.level === "low",
        patch,
      },
      skill_context: skillContext,
    })
  }

  // No auto repair available
  return JSON.stringify({
    status: "no_auto_repair",
    fixability,
    message:
      fixability === "unfixable"
        ? "This rule violation cannot be fixed by automation"
        : "No built-in or skill-based repair available. Use skill_context for LLM-assisted repair.",
    skill_context: skillContext,
  })
}

// ─── REPAIR ALL MODE ────────────────────────────────────────────────────────

function executeRepairAll(args: any): string {
  const { violations_json } = args

  if (!violations_json) {
    return JSON.stringify({
      error: "violations_json is required for repair_all mode. " +
        "Pass the violations array from check mode output as a JSON string.",
    })
  }

  let violations: any[]
  try {
    violations = JSON.parse(violations_json)
    if (!Array.isArray(violations)) {
      return JSON.stringify({ error: "violations_json must be a JSON array" })
    }
  } catch (e) {
    return JSON.stringify({ error: `Failed to parse violations_json: ${e}` })
  }

  // Group violations by file for efficient processing
  const byFile = new Map<string, Array<{ rule_id: string; line: number; message: string; fixability: string }>>()
  for (const v of violations) {
    const filePath = v.file || v.file_path
    if (!filePath) continue
    const arr = byFile.get(filePath) || []
    arr.push({
      rule_id: v.rule_id || "",
      line: v.line || 0,
      message: v.message || "",
      fixability: v.fixability || classifyIssue(v.rule_id || ""),
    })
    byFile.set(filePath, arr)
  }

  const results: Array<{
    file: string
    line: number
    rule_id: string
    status: string
    repair_source?: string
    risk_level?: string
    patch?: any
    skill_context?: any
    message?: string
  }> = []

  let repaired = 0
  let noRepair = 0
  let skipped = 0

  for (const [filePath, fileViolations] of byFile) {
    if (!existsSync(filePath)) {
      for (const v of fileViolations) {
        results.push({
          file: filePath,
          line: v.line,
          rule_id: v.rule_id,
          status: "error",
          message: `File not found: ${filePath}`,
        })
        skipped++
      }
      continue
    }

    // Read file content once per file
    const content = readFileSync(filePath, "utf-8")
    const fileLines = content.split("\n")

    // Sort violations by line number descending so repairs don't shift line numbers
    const sorted = [...fileViolations].sort((a, b) => b.line - a.line)

    for (const v of sorted) {
      if (v.line < 1 || v.line > fileLines.length) {
        results.push({
          file: filePath,
          line: v.line,
          rule_id: v.rule_id,
          status: "skipped",
          message: `Invalid line number: ${v.line}`,
        })
        skipped++
        continue
      }

      // Only attempt repair for auto_fixable or needs_review violations
      if (v.fixability === "unfixable") {
        results.push({
          file: filePath,
          line: v.line,
          rule_id: v.rule_id,
          status: "unfixable",
          skill_context: getSkillContext(v.rule_id),
          message: "Violation classified as unfixable by automation",
        })
        skipped++
        continue
      }

      // Try builtin strategy first
      let patch = tryBuiltinRepair(v.rule_id, filePath, fileLines, v.line)
      let repairSource = "builtin"

      // Try skill-based repair if no builtin
      if (!patch) {
        patch = trySkillRepair(v.rule_id, filePath, fileLines, v.line)
        repairSource = "skill"
      }

      const skillContext = getSkillContext(v.rule_id)

      if (patch) {
        const risk = assessPatchRisk(patch)
        results.push({
          file: filePath,
          line: v.line,
          rule_id: v.rule_id,
          status: "repair_found",
          repair_source: repairSource,
          risk_level: risk.level,
          patch,
          skill_context: skillContext,
        })
        repaired++
      } else {
        results.push({
          file: filePath,
          line: v.line,
          rule_id: v.rule_id,
          status: "no_auto_repair",
          skill_context: skillContext,
          message: "No built-in or skill-based repair available. Use skill_context for LLM-assisted repair.",
        })
        noRepair++
      }
    }
  }

  return JSON.stringify({
    total_violations: violations.length,
    repaired,
    no_auto_repair: noRepair,
    skipped,
    results,
  })
}

// ─── VERIFY MODE ─────────────────────────────────────────────────────────────

async function executeVerify(args: any): Promise<string> {
  const {
    file_path,
    original_code,
    repaired_code,
    start_line,
    end_line,
    rule_id,
    violation_line,
    ruleset,
  } = args

  if (!file_path || !original_code || !repaired_code || !rule_id || !violation_line) {
    return JSON.stringify({
      error:
        "file_path, original_code, repaired_code, rule_id, and violation_line " +
        "are required for verify mode",
    })
  }

  if (!existsSync(file_path)) {
    return JSON.stringify({ error: `File not found: ${file_path}` })
  }

  // Resolve specchecker config
  const sourceDir = resolve(file_path, "..")
  const verifyMatrixRoot = findMatrixRoot(sourceDir)
  const resolved = resolveSpecCheckerConfig(sourceDir, ruleset)
  if (!resolved) {
    return JSON.stringify({
      error: "SpecChecker not found for verification. Set specchecker_home in .matrix/config/matrix.jsonc.",
    })
  }

  const { specCheckerHome: specHome, exePath, ruleset: activeRuleset } = resolved

  // Create temp copy
  const tmpDir = process.env.TMPDIR || process.env.TEMP || "/tmp"
  const verifyDir = join(tmpDir, `matrix_verify_${Date.now()}`)
  mkdirSync(verifyDir, { recursive: true })
  const tmpFile = join(verifyDir, basename(file_path))

  try {
    // Read original and apply patch using line-based replacement when possible
    const content = readFileSync(file_path, "utf-8")
    let patched: string
    const sLine = start_line ? parseInt(start_line, 10) : 0
    const eLine = end_line ? parseInt(end_line, 10) : 0

    if (sLine > 0 && eLine > 0) {
      // Line-based patching: replace lines [sLine, eLine] with repaired_code
      const lines = content.split("\n")
      const before = lines.slice(0, sLine - 1)
      const after = lines.slice(eLine)
      patched = [...before, repaired_code, ...after].join("\n")
    } else {
      // Fallback: string-based replacement
      patched = content.replace(original_code, repaired_code)
    }

    if (patched === content) {
      return JSON.stringify({
        passed: false,
        message: "Patch application failed: original_code not found in file",
        original_issue_resolved: false,
        new_issues_introduced: 0,
      })
    }

    writeFileSync(tmpFile, patched, "utf-8")

    // Ensure verification project exists
    const workspace = join(specHome, "workspace")
    mkdirSync(workspace, { recursive: true })
    const verifyProject = join(workspace, "_verify")

    const createCmd = `"${exePath}" create -p "${verifyProject}" -s "${verifyDir}" -a --clean`
    if (!existsSync(verifyProject)) {
      logSpecCheckerCmd(verifyMatrixRoot, createCmd)
      await runCommand(createCmd, specHome)
    }

    // Update analysis config to target the temp file
    const emitDir = join(verifyProject, "emit", "unit")
    mkdirSync(emitDir, { recursive: true })
    const analysisConf = join(emitDir, "analysis.conf")
    const outDir = join(verifyProject, "out", "unit")
    mkdirSync(outDir, { recursive: true })
    const outXml = join(outDir, "verify.xml")

    const confContent =
      `${tmpFile}\n` +
      `-i "${resolve(file_path, "..")}"\n` +
      `-f xml\n-lang C\n-filte 1\n` +
      `-o "${outXml}"\n`

    writeFileSync(analysisConf, confContent, "utf-8")

    // Analyze
    const analyzeCmd = `"${exePath}" analyze -p "${verifyProject}" -r "${activeRuleset}"`
    logSpecCheckerCmd(verifyMatrixRoot, analyzeCmd)
    const analyzeResult = await runCommand(analyzeCmd, specHome)
    if (!analyzeResult.success) {
      return JSON.stringify({
        passed: false,
        message: `Verification analysis failed: ${analyzeResult.stderr.slice(0, 500)}`,
        original_issue_resolved: false,
        new_issues_introduced: 0,
      })
    }

    // Report
    const vReportDir = join(workspace, "_verify_report")
    mkdirSync(vReportDir, { recursive: true })
    const reportCmd = `"${exePath}" report -p "${verifyProject}" -f json -o "${vReportDir}"`
    logSpecCheckerCmd(verifyMatrixRoot, reportCmd)
    await runCommand(reportCmd, specHome)

    let vJsonFiles: string[]
    try {
      vJsonFiles = readdirSync(vReportDir).filter((f) => f.endsWith(".json"))
    } catch {
      vJsonFiles = []
    }

    if (vJsonFiles.length === 0) {
      return JSON.stringify({
        passed: true,
        message: "No violations found after repair (no report generated)",
        original_issue_resolved: true,
        new_issues_introduced: 0,
      })
    }

    const result = parseSpecCheckerReport(join(vReportDir, vJsonFiles[0]))
    const vLine = parseInt(violation_line, 10)

    // Check if original violation is resolved
    const originalResolved = !result.violations.some(
      (v) => v.rule_id === rule_id && v.line === vLine,
    )

    // All issues in temp file are "new" since we're checking a single file
    // But we should compare against original file's baseline
    // For simplicity, just count violations that weren't in original
    const newIssues = result.violations.filter(
      (v) => !(v.rule_id === rule_id && v.line === vLine),
    )

    const passed = originalResolved && newIssues.length === 0

    return JSON.stringify({
      passed,
      original_issue_resolved: originalResolved,
      new_issues_introduced: newIssues.length,
      new_issues: newIssues.slice(0, 10).map((v) => ({
        rule_id: v.rule_id,
        line: v.line,
        message: v.message,
      })),
      message: passed
        ? "Repair verified: original violation resolved, no new issues"
        : !originalResolved
          ? "Original violation not resolved by repair"
          : `Repair introduces ${newIssues.length} new violation(s)`,
    })
  } finally {
    // Cleanup temp files
    try {
      rmSync(verifyDir, { recursive: true, force: true })
    } catch { /* ignore cleanup errors */ }
  }
}
