import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "fs"
import { join, resolve, dirname } from "path"
import { execSync } from "child_process"
import * as jsonc from "jsonc-parser/lib/esm/main.js"

/**
 * From a VS2013 installation root (e.g. "C:\Program Files (x86)\Microsoft Visual Studio 12.0"),
 * MSBuild lives at the sibling directory: "..\MSBuild\12.0\Bin\MSBuild.exe".
 *
 * But users may configure vs2013_path as:
 *   - "C:\Program Files (x86)\Microsoft Visual Studio 12.0"         (root)
 *   - "C:\Program Files (x86)\Microsoft Visual Studio 12.0\Common7\IDE"  (IDE dir)
 *   - "C:\Program Files (x86)\Microsoft Visual Studio 12.0\VC"      (VC dir)
 *
 * We walk up from the configured path until we find "Microsoft Visual Studio 12.0",
 * then resolve MSBuild relative to its parent.
 */
function resolveMSBuildFromVsPath(vsPath: string): string | null {
  // Strategy 1: direct sibling — vsPath is VS root, MSBuild is at ../MSBuild/...
  const candidate1 = resolve(vsPath, "..", "MSBuild", "12.0", "Bin", "MSBuild.exe")
  if (existsSync(candidate1)) return candidate1

  // Strategy 2: walk up to find "Microsoft Visual Studio 12.0" ancestor
  let dir = resolve(vsPath)
  for (let i = 0; i < 5; i++) {
    const base = dir.split(/[\\/]/).pop()?.toLowerCase() ?? ""
    if (base.includes("visual studio 12") || base.includes("vs12")) {
      const candidate = resolve(dir, "..", "MSBuild", "12.0", "Bin", "MSBuild.exe")
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Strategy 3: if vsPath is under "Program Files (x86)", try MSBuild as sibling
  const progX86Match = vsPath.match(/^([A-Za-z]:\\Program Files \(x86\))\\/i)
  if (progX86Match) {
    const candidate = join(progX86Match[1], "MSBuild", "12.0", "Bin", "MSBuild.exe")
    if (existsSync(candidate)) return candidate
  }

  return null
}

/**
 * Resolve MSBuild.exe path. Strict config validation:
 *  - If matrix.jsonc has `vs2013_path`, use it (or report error if invalid).
 *  - NO automatic fallback to default paths or filesystem scanning.
 */
export function resolveMSBuild(): { path: string; source: string } | null {
  // matrix.jsonc → vs2013_path (REQUIRED, no fallback)
  const configPath = join(process.cwd(), ".matrix/config/matrix.jsonc")
  if (existsSync(configPath)) {
    const cfg = jsonc.parse(readFileSync(configPath, "utf-8")) ?? {}
    if (cfg.vs2013_path) {
      const msbuild = resolveMSBuildFromVsPath(cfg.vs2013_path)
      if (msbuild) return { path: msbuild, source: `matrix.jsonc vs2013_path: ${cfg.vs2013_path}` }
      // Configured but invalid — no fallback, return null
      return null
    }
  }

  // No vs2013_path in config — no automatic search
  return null
}

/** Parse MSBuild stdout to extract structured build results */
function parseMSBuildOutput(stdout: string): {
  succeeded: number
  failed: number
  skipped: number
  error_count: number
  warning_count: number
  errors: string[]
  warnings: string[]
  dll_files: string[]
} {
  const result = {
    succeeded: 0,
    failed: 0,
    skipped: 0,
    error_count: 0,
    warning_count: 0,
    errors: [] as string[],
    warnings: [] as string[],
    dll_files: [] as string[],
  }

  // Extract build summary: "Build succeeded." or "Build FAILED."
  // Also: "N succeeded, N failed, N skipped"
  const summaryMatch = stdout.match(
    /(\d+)\s+succeeded.*?(\d+)\s+failed.*?(\d+)\s+(?:up-to-date|skipped)/i
  )
  if (summaryMatch) {
    result.succeeded = parseInt(summaryMatch[1], 10)
    result.failed = parseInt(summaryMatch[2], 10)
    result.skipped = parseInt(summaryMatch[3], 10)
  } else if (/Build succeeded/i.test(stdout)) {
    result.succeeded = 1
  }

  // Extract error/warning counts: "N Warning(s)" / "N Error(s)"
  const warnMatch = stdout.match(/(\d+)\s+Warning\(s\)/i)
  const errMatch = stdout.match(/(\d+)\s+Error\(s\)/i)
  if (warnMatch) result.warning_count = parseInt(warnMatch[1], 10)
  if (errMatch) result.error_count = parseInt(errMatch[1], 10)

  // Extract individual error lines: "file(line): error CXXXX: message"
  const lines = stdout.split(/\r?\n/)
  for (const line of lines) {
    if (/:\s*error\s+[A-Z]+\d+/i.test(line)) {
      result.errors.push(line.trim())
    } else if (/:\s*warning\s+[A-Z]+\d+/i.test(line)) {
      result.warnings.push(line.trim())
    }
  }

  // Extract DLL output paths: "xxx.dll" in output lines or "-> path\to\file.dll"
  for (const line of lines) {
    const arrowMatch = line.match(/->\s+(.+\.dll)\s*$/i)
    if (arrowMatch) {
      result.dll_files.push(arrowMatch[1].trim())
      continue
    }
    // Also look for lines that contain a full path ending in .dll after "Successfully"
    const dllPathMatch = line.match(/([A-Za-z]:\\[^\s]+\.dll)/i)
    if (dllPathMatch && /(?:successfully|output|copy)/i.test(line)) {
      result.dll_files.push(dllPathMatch[1])
    }
  }

  // Deduplicate dll_files
  result.dll_files = [...new Set(result.dll_files)]

  // If error count not found in summary but we have error lines, use that
  if (result.error_count === 0 && result.errors.length > 0) {
    result.error_count = result.errors.length
  }

  return result
}

/**
 * vtest_compile — Compile VTest DLL projects using MSBuild (VS2013).
 *
 * Directly invokes MSBuild.exe via Node.js execSync, bypassing shell compatibility
 * issues (Git Bash / Bun Shell cannot handle MSBuild paths with spaces and chcp).
 */
export const vtestCompiler: ToolDefinition = tool({
  description:
    "Compile VTest virtual device DLLs using MSBuild (VS2013 v120 toolset). " +
    "Resolves MSBuild.exe automatically from matrix.jsonc vs2013_path, default path, " +
    "or common VS installation paths. Parses build output and returns structured results " +
    "(succeeded/failed counts, errors, warnings, produced DLL files). " +
    "Use this instead of bash for VTest DLL compilation — it handles Windows path " +
    "and encoding issues that Git Bash / Bun Shell cannot.",
  args: {
    sln_path: tool.schema
      .string()
      .default(".matrix/test-env/vtest-devices.sln")
      .describe("Path to .sln solution file (relative to project root). Default: .matrix/test-env/vtest-devices.sln"),
    configuration: tool.schema
      .string()
      .default("Debug")
      .describe("Build configuration (default: Debug)"),
    platform: tool.schema
      .string()
      .default("Win32")
      .describe("Build platform (default: Win32). VTest requires 32-bit DLLs."),
    targets: tool.schema
      .string()
      .optional()
      .describe("MSBuild targets (e.g., 'Build', 'Rebuild', 'Clean'). Default: Build"),
    timeout_ms: tool.schema
      .number()
      .default(120000)
      .describe("Build timeout in milliseconds (default: 120000 = 2 minutes)"),
  },
  async execute({ sln_path, configuration, platform, targets, timeout_ms }) {
    // Resolve MSBuild
    const msbuild = resolveMSBuild()
    if (!msbuild) {
      return JSON.stringify({
        status: "error",
        error: "MSBuild not found",
        message:
          "Cannot find MSBuild.exe (VS2013 v120). " +
          "Set vs2013_path in .matrix/config/matrix.jsonc " +
          "to the Visual Studio 2013 installation directory " +
          "(e.g. \"C:\\Program Files (x86)\\Microsoft Visual Studio 12.0\").",
      })
    }

    // Resolve solution file
    const slnAbsPath = resolve(process.cwd(), sln_path)
    if (!existsSync(slnAbsPath)) {
      return JSON.stringify({
        status: "error",
        error: `Solution file not found: ${sln_path}`,
        message: `Cannot find ${slnAbsPath}. Generate VTest project files first using vtest_project_generate.`,
      })
    }

    // Build MSBuild command
    const msbuildArgs = [
      `"${slnAbsPath}"`,
      `/p:Configuration=${configuration}`,
      `/p:Platform=${platform}`,
      `/m`,  // parallel build
    ]
    if (targets) {
      msbuildArgs.push(`/t:${targets}`)
    }

    // Use chcp 65001 for UTF-8 output, then invoke MSBuild
    const cmd = `chcp 65001 >nul && "${msbuild.path}" ${msbuildArgs.join(" ")}`

    let stdout = ""
    let exitCode = 0
    try {
      stdout = execSync(cmd, {
        timeout: timeout_ms ?? 120000,
        windowsHide: true,
        encoding: "utf-8",
        cwd: process.cwd(),
        shell: "cmd.exe",
      })
    } catch (err: any) {
      stdout = typeof err.stdout === "string" ? err.stdout : ""
      const stderr = typeof err.stderr === "string" ? err.stderr : ""
      exitCode = typeof err.status === "number" ? err.status : 1

      if (err.killed && !stdout) {
        return JSON.stringify({
          status: "timeout",
          error: `MSBuild timed out after ${(timeout_ms ?? 120000) / 1000}s`,
          message: "Build process was killed due to timeout. Try increasing timeout_ms.",
        })
      }

      // If we have stdout, continue to parse it — MSBuild returns non-zero on build errors
      if (!stdout && stderr) {
        return JSON.stringify({
          status: "error",
          exit_code: exitCode,
          error: "MSBuild execution failed",
          stderr: stderr.substring(0, 2000),
          message: `MSBuild failed with exit code ${exitCode}. Check stderr for details.`,
        })
      }
    }

    // Parse structured build output
    const parsed = parseMSBuildOutput(stdout)

    const status = parsed.failed === 0 && parsed.error_count === 0 ? "success" : "failed"

    // Truncate error/warning lists to prevent huge outputs
    const maxItems = 30
    const truncatedErrors = parsed.errors.length > maxItems
      ? [...parsed.errors.slice(0, maxItems), `... and ${parsed.errors.length - maxItems} more errors`]
      : parsed.errors
    const truncatedWarnings = parsed.warnings.length > maxItems
      ? [...parsed.warnings.slice(0, maxItems), `... and ${parsed.warnings.length - maxItems} more warnings`]
      : parsed.warnings

    return JSON.stringify({
      status,
      msbuild_path: msbuild.path,
      msbuild_source: msbuild.source,
      sln_path: slnAbsPath,
      configuration,
      platform,
      exit_code: exitCode,
      summary: {
        succeeded: parsed.succeeded,
        failed: parsed.failed,
        skipped: parsed.skipped,
        error_count: parsed.error_count,
        warning_count: parsed.warning_count,
      },
      errors: truncatedErrors,
      warnings: truncatedWarnings,
      dll_files: parsed.dll_files,
      message: status === "success"
        ? `Build succeeded: ${parsed.succeeded} project(s), ${parsed.warning_count} warning(s). DLLs: ${parsed.dll_files.join(", ") || "(check output directories)"}`
        : `Build FAILED: ${parsed.failed} project(s) failed, ${parsed.error_count} error(s). Fix errors and retry.`,
      raw_output: stdout.length > 5000 ? stdout.substring(stdout.length - 5000) : stdout,
    })
  },
})
