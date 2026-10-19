import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readdirSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { resolveAunitCli, execAunitAsync, buildArgs, normalizePath, AUNIT_WORKSPACE, normalizeProjectDir, readFuncSourceMap, scanGsonPaths } from "./aunit-utils"
import { decodeGbk } from "./gbk-encoding"

/** Default concurrency — number of parallel autogen processes */
const DEFAULT_BATCH_SIZE = 4

/** Result for a single function's autogen */
interface FunctionAutogenResult {
  function_name: string
  status: "success" | "error" | "timeout"
  stdout: string
  stderr?: string
  cmd?: string
}

/**
 * Discover function names from AUnit project.
 * Prefers summary.json (also used for func→src mapping); falls back to gson scan.
 * The gson fallback uses scanGsonPaths (path-only) then reads only funcName from each file.
 */
function discoverFunctions(projectPath: string): string[] {
  // Try summary.json first — faster and provides func→src mapping
  const funcSourceMap = readFuncSourceMap(projectPath)
  if (funcSourceMap.size > 0) {
    return [...funcSourceMap.keys()]
  }

  // Fallback: scan gson file paths, then read only funcName from each
  const utDir = join(projectPath, "meta", "model", "UT")
  if (!existsSync(utDir)) return []

  const funcNames = new Set<string>()
  for (const gsonPath of scanGsonPaths(utDir)) {
    try {
      const buffer = readFileSync(gsonPath)
      const text = decodeGbk(buffer)
      const data = JSON.parse(text)
      if (data.entry?.funcName) {
        funcNames.add(data.entry.funcName)
      }
    } catch {
      // skip unreadable gson
    }
  }
  return [...funcNames]
}

/**
 * Check which functions already have test cases in their gson files.
 * Returns the list of function names that have at least one case.
 * Uses scanGsonPaths for lightweight directory traversal.
 */
function functionsWithExistingCases(projectPath: string, funcNames: string[]): string[] {
  const utDir = join(projectPath, "meta", "model", "UT")
  if (!existsSync(utDir)) return []

  const nameSet = new Set(funcNames)
  const withCases = new Set<string>()

  for (const gsonPath of scanGsonPaths(utDir)) {
    try {
      const buffer = readFileSync(gsonPath)
      const text = decodeGbk(buffer)
      const data = JSON.parse(text)
      const name = data.entry?.funcName
      if (name && nameSet.has(name) && Array.isArray(data.cases) && data.cases.length > 0) {
        withCases.add(name)
      }
    } catch {
      // skip unreadable gson
    }
  }
  return [...withCases]
}

/**
 * aunit_autogen — Auto-generate test cases for functions in an AUnit project.
 * Wraps: SunwiseAUnit.cli.bat ut autogen
 *
 * When function_names is not specified, automatically discovers all functions
 * from gson files and runs autogen in parallel batches for efficiency.
 * Each function's autogen is independent and can run concurrently.
 */
export const aunitAutogen: ToolDefinition = tool({
  description:
    "Auto-generate unit test cases for C/C++ functions in a SunwiseAUnit project. " +
    "Can target all functions, specific source files, or specific function names. " +
    "When targeting all functions, automatically discovers functions from gson files " +
    "and runs autogen in parallel batches (default 4 concurrent) for efficiency.",
  args: {
    project_name: tool.schema.string().describe("AUnit project name"),
    source_paths: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Specific source files to generate cases for"),
    function_names: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Specific function names to generate cases for (runs in parallel batches)"),
    per_function_timeout: tool.schema
      .number()
      .optional()
      .describe("Timeout in milliseconds for each function's autogen (default: 604800000 = 1 week, effectively no limit). Z3 solver may hang on complex functions; timed-out functions are marked status 'timeout'."),
    batch_size: tool.schema
      .number()
      .optional()
      .describe(`Number of functions to process concurrently (default: ${DEFAULT_BATCH_SIZE})`),
    aunit_path: tool.schema
      .string()
      .optional()
      .describe("Path to AUnit installation directory (optional — auto-detected from PATH if omitted)"),
    project_dir: tool.schema
      .string()
      .describe("Project root directory"),
  },
  async execute({ project_name, source_paths, function_names, per_function_timeout, batch_size, aunit_path, project_dir }) {
    let cliPath: string
    let installDir: string
    try {
      const cli = resolveAunitCli(aunit_path)
      cliPath = cli.cliPath
      installDir = cli.installDir
    } catch (err) {
      return JSON.stringify({
        status: "abnormal",
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const projectPath = resolve(normalizePath(normalizeProjectDir(project_dir)), AUNIT_WORKSPACE, project_name)

    // Determine function list: explicit → discovered from gson → fall back to single full run
    let duplicateWarning: string | undefined
    let funcsToProcess = function_names
    if (!funcsToProcess || funcsToProcess.length === 0) {
      // If source_paths is specified, fall back to single run with -src (can't reliably
      // map source files to function names without parsing)
      if (source_paths && source_paths.length > 0) {
        return await runSingleAutogen(cliPath, installDir, projectPath, project_name, source_paths, undefined, project_dir, per_function_timeout)
      }

      // Discover all functions from gson files
      funcsToProcess = discoverFunctions(projectPath)
      if (funcsToProcess.length === 0) {
        // No gson files found — fall back to single full autogen
        return await runSingleAutogen(cliPath, installDir, projectPath, project_name, undefined, undefined, project_dir, per_function_timeout)
      }

      // Check for functions that already have cases — warn about potential duplicates
      const alreadyCovered = functionsWithExistingCases(projectPath, funcsToProcess)
      if (alreadyCovered.length > 0) {
        duplicateWarning =
          `${alreadyCovered.length} of ${funcsToProcess.length} functions already have test cases ` +
          `(${alreadyCovered.join(", ")}). To avoid duplicates, use function_names to target only specific functions.`
      }
    }

    // ── Parallel batch execution ──────────────────────────────────────────
    const concurrency = batch_size ?? DEFAULT_BATCH_SIZE
    const funcTimeout = per_function_timeout ?? 604_800_000
    const results: FunctionAutogenResult[] = []
    let successCount = 0
    let errorCount = 0
    let timeoutCount = 0

    // Build func→src map from summary.json (AUnit CLI requires -func paired with -src)
    const funcSourceMap = readFuncSourceMap(projectPath)

    // Process functions in batches
    for (let i = 0; i < funcsToProcess.length; i += concurrency) {
      const batch = funcsToProcess.slice(i, i + concurrency)

      const batchPromises = batch.map(async (funcName): Promise<FunctionAutogenResult> => {
        const srcFile = funcSourceMap.get(funcName) ?? source_paths?.[0]
        const args = buildArgs({
          "-pp": projectPath,
          "-func": [funcName],
          "-src": srcFile ? [srcFile] : undefined,
        })

        const result = await execAunitAsync(cliPath, installDir, "ut", "autogen", args, funcTimeout, project_dir)

        if (result.timedOut) {
          return {
            function_name: funcName,
            status: "timeout",
            cmd: result.cmd,
            stdout: result.stdout.slice(0, 500),
            stderr: `Z3 solver timeout after ${funcTimeout}ms`,
          }
        }
        if (result.exitCode !== 0 && !result.stdout.includes("success")) {
          return {
            function_name: funcName,
            status: "error",
            cmd: result.cmd,
            stdout: result.stdout.slice(0, 1000),
            stderr: result.stderr.slice(0, 500),
          }
        }
        return {
          function_name: funcName,
          status: "success",
          cmd: result.cmd,
          stdout: result.stdout.slice(0, 500),
        }
      })

      // Use Promise.allSettled to prevent one rejection from losing the entire batch
      const settled = await Promise.allSettled(batchPromises)
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          const r = outcome.value
          results.push(r)
          if (r.status === "success") successCount++
          else if (r.status === "timeout") timeoutCount++
          else errorCount++
        } else {
          // Unexpected rejection — record as error
          results.push({
            function_name: "(unknown)",
            status: "error",
            stdout: "",
            stderr: String(outcome.reason),
          })
          errorCount++
        }
      }
    }

    return JSON.stringify({
      status: (errorCount + timeoutCount) === funcsToProcess.length ? "error" : "success",
      project_name,
      total_functions: funcsToProcess.length,
      success_count: successCount,
      error_count: errorCount,
      timeout_count: timeoutCount,
      batch_size: concurrency,
      per_function_timeout: funcTimeout,
      ...(timeoutCount > 0 ? { timeout_note: `${timeoutCount} function(s) timed out during Z3 solving. These functions should be covered by functional test cases instead of retrying autogen.` } : {}),
      ...(duplicateWarning ? { warning: duplicateWarning } : {}),
      results: results.map((r) => ({
        function_name: r.function_name,
        status: r.status,
        // Only include diagnostic info for error/timeout — success entries are name+status only
        ...(r.status === "error" || r.status === "timeout"
          ? { cmd: r.cmd, error: r.stderr || r.stdout }
          : {}),
      })),
    })
  },
})

/** Fallback: run a single autogen command (no per-function parallelism) */
async function runSingleAutogen(
  cliPath: string,
  installDir: string,
  projectPath: string,
  project_name: string,
  source_paths: string[] | undefined,
  function_names: string[] | undefined,
  logDir?: string,
  timeoutMs?: number,
): Promise<string> {
  const args = buildArgs({
    "-pp": projectPath,
    "-src": source_paths,
    "-func": function_names,
  })

  const result = await execAunitAsync(cliPath, installDir, "ut", "autogen", args, timeoutMs ?? 604_800_000, logDir)

  if (result.exitCode !== 0 && !result.stdout.includes("success")) {
    return JSON.stringify({
      status: "error",
      exit_code: result.exitCode,
      message: "AUnit autogen failed",
      cmd: result.cmd,
      stdout: result.stdout.slice(0, 5000),
      stderr: result.stderr.slice(0, 3000),
    })
  }

  return JSON.stringify({
    status: "success",
    project_name,
    cmd: result.cmd,
    stdout: result.stdout.slice(0, 5000),
  })
}
