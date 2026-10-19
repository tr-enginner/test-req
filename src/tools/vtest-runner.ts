import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { execSync } from "child_process"
import * as jsonc from "jsonc-parser/lib/esm/main.js"
import { parseTestResults, parseCoxCoverage, parseVtestJsonOutput, classifyInitErrors, analyzeDiagnostics } from "./vtest/result-parser"
import { dirname } from "path"
import { TEST_ENV_DIR } from "../shared/constants"

/**
 * Resolve vtestc.exe path. Strict config validation:
 *  - If matrix.jsonc has `vtest_home`, use it (or report error if invalid).
 *  - NO automatic fallback to env vars or common paths.
 */
export function resolveVtestExe(overridePath?: string): string | null {
  // Level 0: explicit override
  if (overridePath) {
    const exe = join(overridePath, "vtestc.exe")
    if (existsSync(exe)) return exe
    if (existsSync(overridePath) && overridePath.toLowerCase().endsWith("vtestc.exe")) {
      return overridePath
    }
  }

  // Level 1: .matrix/config/matrix.jsonc → vtest_home (REQUIRED, no fallback)
  const configPath = join(process.cwd(), ".matrix/config/matrix.jsonc")
  if (existsSync(configPath)) {
    const cfg = jsonc.parse(readFileSync(configPath, "utf-8")) ?? {}
    if (cfg.vtest_home) {
      const exe = join(cfg.vtest_home, "vtestc.exe")
      if (existsSync(exe)) return exe
      // Configured but invalid — no fallback, return null
      // (caller should report error with the configured path)
      return null
    }
  }

  // No vtest_home in config — no automatic search
  return null
}

/**
 * Build a vtestc.exe command line with proper flags.
 *
 * vtestc CLI flags (from VTest documentation):
 *   -p <vte_file>   Load .vte project file
 *   -d              Auto-initialize VM (vminit) after loading
 *   -s              Auto-start simulation (vmrun) after init
 *   -json           Output structured JSON-line events to stdout
 *   -timeout <sec>  Stop simulation after N seconds of simulated time
 *   -cov <file>     Output coverage .cox file on exit
 *
 * The minimal required sequence is: -p (load) + -d (init) + -s (run).
 * Without -d, vtestc loads but does NOT initialize → vmrun fails.
 */
function buildVtestCmd(
  vtestExe: string,
  vteAbsPath: string,
  timeoutSec: number,
  covAbsPath?: string,
): string {
  // -p: load project, -d: auto-init, -s: auto-start, -json: structured output, -timeout: auto-stop
  // -u: UTF-8 mode — converts GBK output to UTF-8 for Git Bash / Node.js child_process
  let cmd = `"${vtestExe}" -u -p "${vteAbsPath}" -d -s -json -timeout ${timeoutSec}`
  if (covAbsPath) {
    cmd += ` -cov "${covAbsPath}"`
  }
  return cmd
}

/**
 * vtest_runner — Execute VTest simulation via vtestc.exe and parse results.
 *
 * Uses cmd.exe (not PowerShell/Git Bash) for reliable Windows path handling
 * and chcp 65001 for UTF-8 encoding of Chinese console output.
 *
 * Used by: EnvArchitect (baseline verification), TestExecutor (Phase 7)
 */
export const vtestRunner: ToolDefinition = tool({
  description:
    "THE single entry point for all VTest/vtestc operations. " +
    "Handles VTE static validation, vtestc load/init verification, simulation execution, " +
    "device I/O diagnostics, and coverage collection. " +
    "All vtestc invocations use cmd.exe + UTF-8 internally — NEVER call vtestc via bash directly. " +
    "Requires vtest_home in matrix.jsonc or VTEST_HOME environment variable.",
  args: {
    project_file: tool.schema
      .string()
      .describe("Path to .vte project file (relative to project root)"),
    action: tool.schema
      .enum(["run", "run_with_coverage", "check_status", "validate", "validate_static", "diagnose"])
      .describe(
        "Action to perform:\n" +
        "- check_status: verify vtestc.exe is installed (no VTE needed)\n" +
        "- validate_static: static VTE file checks (sections, device IDs, memory overlap) — no vtestc needed\n" +
        "- validate: load + init only (catches pin name errors, DLL load failures) — needs vtestc\n" +
        "- run: full simulation with auto-diagnostics — needs vtestc\n" +
        "- run_with_coverage: full simulation + coverage .cox export\n" +
        "- diagnose: short-timeout run + device I/O pattern analysis (connectivity, FIFO, checksums)"
      ),
    timeout_ms: tool.schema
      .number()
      .default(60000)
      .describe("Simulation timeout in milliseconds (default: 60000)"),
    result_file: tool.schema
      .string()
      .optional()
      .describe("Path to test driver result JSON file (relative to project root)"),
    coverage_output: tool.schema
      .string()
      .optional()
      .describe("Coverage .cox output file path"),
    vtest_path: tool.schema
      .string()
      .optional()
      .describe("Override VTest installation directory (otherwise uses config or VTEST_HOME)"),
  },
  async execute({ project_file, action, timeout_ms, result_file, coverage_output, vtest_path }) {
    const vtestExe = resolveVtestExe(vtest_path)

    if (action === "check_status") {
      return JSON.stringify({
        vtest_found: vtestExe !== null,
        vtest_exe: vtestExe,
        message: vtestExe
          ? `VTest found at: ${vtestExe}`
          : "VTest not found. Set vtest_home in .matrix/config/matrix.jsonc to the VTest installation directory.",
      })
    }

    // ── validate_static: no vtestc needed, pure file checks ──
    if (action === "validate_static") {
      const vteAbsPath = resolve(process.cwd(), project_file)
      const checks = validateVteProject(vteAbsPath)
      const hasFail = checks.some(c => c.status === "FAIL")
      const hasWarn = checks.some(c => c.status === "WARN")
      return JSON.stringify({
        status: hasFail ? "invalid" : hasWarn ? "warnings" : "valid",
        checks,
        message: hasFail
          ? `VTE static validation failed: ${checks.filter(c => c.status === "FAIL").length} error(s).`
          : hasWarn
            ? `VTE static validation passed with ${checks.filter(c => c.status === "WARN").length} warning(s).`
            : "VTE static validation passed.",
      })
    }

    if (!vtestExe) {
      return JSON.stringify({
        error: "VTest not found",
        message:
          "Cannot find vtestc.exe. Set vtest_home in .matrix/config/matrix.jsonc " +
          "to the VTest installation directory (e.g. \"C:\\SunwiseInfo\\VTest3.4.0\\VTest\").",
      })
    }

    const vteAbsPath = resolve(process.cwd(), project_file)
    if (!existsSync(vteAbsPath)) {
      return JSON.stringify({
        error: `Project file not found: ${project_file}`,
      })
    }

    // Pre-flight: check that DLL files referenced in VTE actually exist
    const dllCheck = checkVteDlls(vteAbsPath)
    if (dllCheck.missing.length > 0) {
      return JSON.stringify({
        status: "error",
        error: "DLL files missing",
        missing_dlls: dllCheck.missing,
        message:
          `${dllCheck.missing.length} DLL(s) referenced in VTE not found on disk. ` +
          `Run vtest_compile first to build all DLLs.\n` +
          dllCheck.missing.map(d => `  - ${d}`).join("\n"),
      })
    }

    // ── Validate action: load + init only (no simulation run) ──
    if (action === "validate") {
      // Build command: -p (load) + -d (init) + -json, NO -s (run), NO -timeout
      // -u: UTF-8 mode for proper Chinese output in Git Bash / Node.js
      const validateCmd = `"${vtestExe}" -u -p "${vteAbsPath}" -d -json`
      const cmd = `chcp 65001 >nul && ${validateCmd}`

      let stdout = ""
      try {
        stdout = execSync(cmd, {
          timeout: 15000, // 15s should be enough for load + init
          windowsHide: true,
          encoding: "utf-8",
          cwd: join(process.cwd(), TEST_ENV_DIR),
          shell: "cmd.exe",
        })
      } catch (err: any) {
        stdout = typeof err.stdout === "string" ? err.stdout : ""
        const stderr = typeof err.stderr === "string" ? err.stderr : ""
        if (!stdout && stderr) {
          return JSON.stringify({
            status: "invalid",
            errors: [{
              category: "vm_init_error",
              message: stderr.substring(0, 2000),
              suggestion: "vtestc.exe 启动失败，检查 VTest 安装路径和 DLL 依赖。",
              auto_fixable: false,
            }],
            manual_action_required: true,
            command: validateCmd,
            message: "VTE 加载验证失败: vtestc.exe 无法启动。",
          })
        }
      }

      const parsed = parseVtestJsonOutput(stdout)
      const validation = classifyInitErrors(parsed)

      if (validation.valid && parsed.errors.length === 0) {
        return JSON.stringify({
          status: "valid",
          log_summary: {
            errors: parsed.errors,
            warnings: parsed.warnings,
            log_count: parsed.logs.length,
          },
          command: validateCmd,
          message: "VTE 加载和初始化成功，所有设备和引脚连接正常。",
        })
      }

      const hasManualErrors = validation.errors.some(e => !e.auto_fixable)
      return JSON.stringify({
        status: "invalid",
        errors: validation.errors,
        manual_action_required: hasManualErrors,
        log_summary: {
          errors: parsed.errors,
          warnings: parsed.warnings,
          log_count: parsed.logs.length,
        },
        command: validateCmd,
        message: hasManualErrors
          ? `VTE 加载验证失败，发现 ${validation.errors.length} 个错误需要人工确认修复方案。`
          : `VTE 加载验证失败，发现 ${validation.errors.length} 个可自动修复的错误。`,
      })
    }

    // ── diagnose: short-timeout run + device I/O pattern analysis ──
    if (action === "diagnose") {
      const diagTimeoutSec = Math.ceil((timeout_ms ?? 10000) / 1000)
      const diagCmd = `"${vtestExe}" -u -p "${vteAbsPath}" -d -s -json -timeout ${diagTimeoutSec}`
      const cmd = `chcp 65001 >nul && ${diagCmd}`

      let stdout = ""
      try {
        stdout = execSync(cmd, {
          timeout: (diagTimeoutSec + 10) * 1000,
          windowsHide: true,
          encoding: "utf-8",
          cwd: join(process.cwd(), TEST_ENV_DIR),
          shell: "cmd.exe",
        })
      } catch (err: any) {
        stdout = typeof err.stdout === "string" ? err.stdout : ""
        // Detect vtestc crash during diagnostics
        if (!stdout.trim()) {
          const stderr = typeof err.stderr === "string" ? err.stderr : ""
          const exitCode = typeof err.status === "number" ? err.status : -1
          return JSON.stringify({
            status: "error",
            simulation_status: "error",
            exit_code: exitCode,
            error: "vtestc_crash",
            command: diagCmd,
            message: stderr
              ? `vtestc.exe crashed during diagnostics (exit code ${exitCode}). stderr: ${stderr.substring(0, 500)}`
              : `vtestc.exe crashed with no output during diagnostics (exit code ${exitCode}). This usually indicates a DLL binary incompatibility — device DLLs compiled against an incorrect vttDevice.h.`,
          })
        }
      }

      const parsed = parseVtestJsonOutput(stdout)
      const report = analyzeDiagnostics(parsed)

      return JSON.stringify({
        status: report.overall_status === "pass" ? "healthy" : "issues_found",
        simulation_status: parsed.status,
        exit_code: parsed.exit_code,
        report,
        log_summary: {
          errors: parsed.errors,
          warnings: parsed.warnings,
          log_count: parsed.logs.length,
        },
        command: diagCmd,
        message: report.overall_status === "pass"
          ? `Diagnostics passed: ${report.device_summaries.length} device(s) healthy.`
          : `Diagnostics found ${report.issues.length} issue(s) in ${report.device_summaries.length} device(s).`,
      })
    }

    // Build command for run/run_with_coverage
    const timeoutSec = Math.ceil((timeout_ms ?? 60000) / 1000)
    const covAbsPath = (action === "run_with_coverage" && coverage_output)
      ? resolve(process.cwd(), coverage_output)
      : undefined
    const vtestCmd = buildVtestCmd(vtestExe, vteAbsPath, timeoutSec, covAbsPath)

    // Wrap with chcp 65001 for UTF-8, execute via cmd.exe
    const cmd = `chcp 65001 >nul && ${vtestCmd}`

    let stdout = ""
    try {
      stdout = execSync(cmd, {
        // Node timeout as safety net (add 10s buffer over vtestc's own timeout)
        timeout: (timeoutSec + 10) * 1000,
        windowsHide: true,
        encoding: "utf-8",
        cwd: join(process.cwd(), TEST_ENV_DIR),
        shell: "cmd.exe",
      })
    } catch (err: any) {
      // execSync throws on non-zero exit code; capture stdout from the error
      stdout = typeof err.stdout === "string" ? err.stdout : ""
      const stderr = typeof err.stderr === "string" ? err.stderr : ""
      // If Node itself killed the process (safety net timeout), report it
      if (err.killed && !stdout) {
        return JSON.stringify({
          status: "timeout",
          exit_code: -1,
          message: `VTest simulation killed by Node timeout after ${timeoutSec + 10}s (vtestc did not exit on its own).`,
          command: vtestCmd,
        })
      }
      // If no stdout at all — vtestc crashed or couldn't start
      if (!stdout.trim()) {
        const exitCode = typeof err.status === "number" ? err.status : -1
        return JSON.stringify({
          status: "error",
          exit_code: exitCode,
          error: "vtestc_crash",
          stderr: stderr ? stderr.substring(0, 2000) : undefined,
          command: vtestCmd,
          message: stderr
            ? `vtestc.exe crashed or failed to start (exit code ${exitCode}). stderr: ${stderr.substring(0, 500)}`
            : `vtestc.exe crashed with no output (exit code ${exitCode}). This usually indicates a DLL binary incompatibility — the device DLL was compiled against an incorrect vttDevice.h header (wrong struct sizes, enum values, or VTTFUNCS layout). Ensure vttDevice.h comes from the real VTest installation, not a manually created version.`,
        })
      }
    }

    const parsed = parseVtestJsonOutput(stdout)

    // Auto-diagnostics: analyze device I/O patterns from log output
    const diagnostics = analyzeDiagnostics(parsed)

    let testResults = null
    if (result_file) {
      const resultAbsPath = resolve(process.cwd(), result_file)
      testResults = parseTestResults(resultAbsPath)
    }

    let coverage = null
    if (action === "run_with_coverage" && coverage_output) {
      const coxAbsPath = resolve(process.cwd(), coverage_output)
      coverage = parseCoxCoverage(coxAbsPath)
    }

    return JSON.stringify({
      status: parsed.status,
      exit_code: parsed.exit_code,
      reason: parsed.reason,
      simulation_time_seconds: parsed.simulation_time,
      simulation_ticks: parsed.simulation_ticks,
      test_results: testResults,
      coverage,
      diagnostics: diagnostics.issues.length > 0 ? diagnostics : undefined,
      log_summary: {
        errors: parsed.errors,
        warnings: parsed.warnings,
        log_count: parsed.logs.length,
      },
      command: vtestCmd,
      message: parsed.status === "completed"
        ? `VTest simulation completed. ${parsed.errors.length} errors, ${parsed.warnings.length} warnings.`
          + (diagnostics.issues.length > 0 ? ` Diagnostics: ${diagnostics.issues.length} issue(s) found.` : "")
        : parsed.status === "timeout"
          ? `VTest simulation timed out after ${timeoutSec}s.`
          : `VTest simulation ended: ${parsed.reason}. ${parsed.errors.length} errors.`,
    })
  },
})

// ─── Static VTE Validation (migrated from test-env-ctrl) ─────────────────────

const REQUIRED_VTE_SECTIONS = [
  "ProjectName", "Cpu", "CpuFre", "Devices", "Connect", "PhyMem",
]

interface VteCheck {
  check: string
  status: "PASS" | "FAIL" | "WARN"
  message: string
}

function parseVteFile(content: string): Map<string, string[]> {
  const sections = new Map<string, string[]>()
  let currentSection: string | null = null
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(";")) continue
    const sectionMatch = line.match(/^\[(\w+)\]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1]
      if (!sections.has(currentSection)) sections.set(currentSection, [])
    } else if (currentSection) {
      sections.get(currentSection)!.push(line)
    }
  }
  return sections
}

function validateVteProject(vtePath: string): VteCheck[] {
  const checks: VteCheck[] = []
  if (!existsSync(vtePath)) {
    checks.push({ check: "file_exists", status: "FAIL", message: `VTE file not found: ${vtePath}` })
    return checks
  }
  const content = readFileSync(vtePath, "utf-8")
  const sections = parseVteFile(content)

  // 1. Required sections
  for (const required of REQUIRED_VTE_SECTIONS) {
    if (!sections.has(required)) {
      checks.push({ check: `section_${required}`, status: "FAIL", message: `Missing required section: [${required}]` })
    } else {
      const lines = sections.get(required)!
      checks.push(lines.length === 0
        ? { check: `section_${required}`, status: "WARN", message: `Section [${required}] is empty` }
        : { check: `section_${required}`, status: "PASS", message: `[${required}] present (${lines.length} entries)` })
    }
  }

  // 2. Collect device IDs
  const devices = sections.get("Devices") || []
  const deviceIds = new Set<string>()
  for (const line of devices) {
    const match = line.match(/^(\d+)\s*=\s*(.+)$/)
    if (match) deviceIds.add(match[1])
  }
  if (deviceIds.size === 0 && sections.has("Devices")) {
    checks.push({ check: "devices_count", status: "FAIL", message: "[Devices] section has no valid device entries" })
  }

  // 3. Check [Connect] references valid device IDs
  for (const line of (sections.get("Connect") || [])) {
    for (const m of line.matchAll(/(\d+)\./g)) {
      if (m[1] !== "1000" && !deviceIds.has(m[1])) {
        checks.push({ check: "connect_device_id", status: "FAIL", message: `[Connect] references unknown device ID ${m[1]}: ${line}` })
      }
    }
  }

  // 4. Check [VPortConnect] references valid device IDs
  for (const line of (sections.get("VPortConnect") || [])) {
    for (const m of line.matchAll(/(\d+)\./g)) {
      if (m[1] !== "1000" && !deviceIds.has(m[1])) {
        checks.push({ check: "vport_device_id", status: "FAIL", message: `[VPortConnect] references unknown device ID ${m[1]}: ${line}` })
      }
    }
  }

  // 5. Check [PhyMem] for overlapping regions
  const memRegions: Array<{ start: number; size: number; line: string }> = []
  for (const line of (sections.get("PhyMem") || [])) {
    const match = line.match(/^(0x[0-9a-fA-F]+)\s*=\s*(0x[0-9a-fA-F]+)/)
    if (match) memRegions.push({ start: parseInt(match[1], 16), size: parseInt(match[2], 16), line })
  }
  memRegions.sort((a, b) => a.start - b.start)
  for (let i = 1; i < memRegions.length; i++) {
    if (memRegions[i].start < memRegions[i - 1].start + memRegions[i - 1].size) {
      checks.push({ check: "phymem_overlap", status: "FAIL", message: `[PhyMem] overlap between ${memRegions[i - 1].line} and ${memRegions[i].line}` })
    }
  }
  if (memRegions.length > 0 && !checks.some(c => c.check === "phymem_overlap")) {
    checks.push({ check: "phymem_regions", status: "PASS", message: `${memRegions.length} memory regions, no overlaps` })
  }

  return checks
}

/**
 * Pre-flight check: parse VTE [Devices] section and verify DLL files exist.
 * Only checks custom DLLs (those with directory separators — absolute paths).
 * System DLLs (bare names like "binparser.dll") are skipped.
 */
function checkVteDlls(vteAbsPath: string): { found: string[]; missing: string[] } {
  const found: string[] = []
  const missing: string[] = []
  try {
    const content = readFileSync(vteAbsPath, "utf-8")
    const lines = content.split(/\r?\n/)
    let inDevices = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith("[")) {
        inDevices = trimmed.toLowerCase() === "[devices]"
        continue
      }
      if (!inDevices) continue
      if (!trimmed || trimmed.startsWith(";")) continue
      // Format: ID=dll_path
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx < 0) continue
      const dllPath = trimmed.substring(eqIdx + 1).trim()
      // Skip system DLLs (bare name, no directory separator)
      if (!dllPath.includes("\\") && !dllPath.includes("/")) continue
      // Check existence (path should be absolute for custom DLLs)
      if (existsSync(dllPath)) {
        found.push(dllPath)
      } else {
        missing.push(dllPath)
      }
    }
  } catch { /* ignore parse errors */ }
  return { found, missing }
}
