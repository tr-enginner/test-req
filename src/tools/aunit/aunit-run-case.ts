import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { resolve, join } from "path"
import {
  resolveAunitCli,
  execAunit,
  buildArgs,
  normalizePath,
  AUNIT_WORKSPACE,
  normalizeProjectDir,
  collectInstallIncludes,
  selectIncludesForHeaders,
  addPathToConf,
  addDaToConf,
  readFuncSourceMap,
} from "./aunit-utils"
import { addIncludesToConf, patchUniversalConf } from "./aunit-build"
import {
  parseSyntaxErrors,
  parseMissingHeaders,
  parseCompilerNotFound,
  searchCompilerGlobal,
  parseBuildErrors,
  parseMemoryAccessErrors,
  type BuildSyntaxError,
  type BuildErrorAnalysis,
  type MemoryAccessError,
} from "./aunit-build-diagnostics"

/** Error classification for runCase failures */
type RunCaseFailureType = "build_env" | "case_compile_error" | "runtime_memory_access" | "unknown"

interface RunCaseDiagnostics {
  failure_type: RunCaseFailureType
  compiler_not_found: string | null
  syntax_errors: BuildSyntaxError[]
  memory_access_errors?: MemoryAccessError[]
  summary: string
}

/**
 * Classify runCase failure by parsing compilation errors from the output.
 *
 * IMPORTANT: aunit_run_case failure (non-zero exit code) is ALWAYS a compilation
 * error — either in the build environment or in the test case scripts. Expected
 * value mismatches (retValue wrong or unset) do NOT cause execution failure.
 * AUnit executes such cases normally and records actual outputs in gson; pass/fail
 * verdict is determined later by comparing retValue vs result.obValues.
 *
 * Build environment errors (build_env):
 *   - Compiler not found (gcc, armcc, etc.)
 *   - Missing system/SDK headers (#include not found)
 *   - Missing toolchain libraries (undefined reference to system symbols)
 *   - Dialect extensions not supported (unknown_extension)
 *   - Unknown types from SDK/BSP headers (unknown_type)
 *
 * Test case script compilation errors (case_compile_error):
 *   - Syntax errors in the generated test harness
 *   - Type mismatch in paraExprs (parameter type incompatible)
 *   - Wrong parameter count
 *   - Missing stub function definitions referenced by the test
 *   - Undeclared identifiers in test expressions
 */
function classifyFailure(stdout: string, stderr: string): RunCaseDiagnostics {
  const compilerName = parseCompilerNotFound(stdout, stderr)
  const syntaxErrors = parseSyntaxErrors(stdout, stderr)
  const combined = `${stdout}\n${stderr}`

  // Runtime memory access violation → simulator PhyMem config issue
  const memErrors = parseMemoryAccessErrors(stdout, stderr)
  if (memErrors.length > 0) {
    const addrList = memErrors.map(e => `0x${e.addr}`).join(", ")
    return {
      failure_type: "runtime_memory_access",
      compiler_not_found: null,
      syntax_errors: [],
      memory_access_errors: memErrors,
      summary:
        `Runtime memory access out-of-bounds at address(es): ${addrList}. ` +
        `These addresses are not declared in template.vte [PhyMem]. ` +
        `Add corresponding address ranges to [PhyMem] and retry.`,
    }
  }

  // Compiler not found → definitely build environment
  if (compilerName) {
    return {
      failure_type: "build_env",
      compiler_not_found: compilerName,
      syntax_errors: syntaxErrors,
      summary: `Compiler "${compilerName}" not found. Build environment needs to be configured.`,
    }
  }

  // Check for environment-level indicators
  const hasMissingHeaders = /No such file or directory/i.test(combined) &&
    /#include/i.test(combined)
  const hasLinkerErrors = /undefined reference to/i.test(combined) ||
    /unresolved external symbol/i.test(combined)

  // Has compilation errors → classify by error patterns
  if (syntaxErrors.length > 0) {
    const envErrorTypes = new Set(["unknown_extension", "implicit_declaration", "unknown_type", "linker_error"])
    const envErrors = syntaxErrors.filter((e) => envErrorTypes.has(e.type))
    const scriptErrors = syntaxErrors.filter((e) => !envErrorTypes.has(e.type))

    // If environment indicators or environment-type errors dominate → build_env
    if (hasMissingHeaders || hasLinkerErrors || envErrors.length > scriptErrors.length) {
      return {
        failure_type: "build_env",
        compiler_not_found: null,
        syntax_errors: syntaxErrors,
        summary:
          `Build environment issue: ${envErrors.length} environment error(s)` +
          (hasMissingHeaders ? ", missing header files" : "") +
          (hasLinkerErrors ? ", unresolved linker symbols" : "") +
          `. ${scriptErrors.length} other compilation error(s).`,
      }
    }

    // Script-level compilation errors (type mismatch, syntax, missing stubs)
    return {
      failure_type: "case_compile_error",
      compiler_not_found: null,
      syntax_errors: syntaxErrors,
      summary:
        `Test case script compilation error: ${scriptErrors.length} error(s). ` +
        `Likely causes: type mismatch in paraExprs, wrong parameter count, ` +
        `missing stub definitions, or syntax errors in injected test expressions. ` +
        `Fix the cases (aunit_enrich_cases / aunit_inject_cases) or add missing stubs, then retry.`,
    }
  }

  // Missing headers / linker errors detected but no parseable syntax errors
  if (hasMissingHeaders || hasLinkerErrors) {
    return {
      failure_type: "build_env",
      compiler_not_found: null,
      syntax_errors: [],
      summary:
        `Build environment issue` +
        (hasMissingHeaders ? ": missing header files" : "") +
        (hasLinkerErrors ? ": unresolved linker symbols" : "") +
        `. Fix universal.conf or analysis.conf in the project root and retry.`,
    }
  }

  return {
    failure_type: "unknown",
    compiler_not_found: null,
    syntax_errors: syntaxErrors,
    summary: "Unclassified execution failure. Review stdout/stderr for details.",
  }
}

// ── PhyMem auto-fix for template.vte ─────────────────────────────────────────

interface PhyMemRange {
  index: number
  start: number
  end: number
}

/**
 * Parse existing [PhyMem] entries from template.vte content.
 * Each entry has the form: <index>=0x<start>,0x<end>,0
 */
function parsePhyMemEntries(content: string): PhyMemRange[] {
  const results: PhyMemRange[] = []
  // Match lines like: 1=0x40000000,0x44000000,0
  const re = /^(\d+)\s*=\s*0x([0-9a-fA-F]+)\s*,\s*0x([0-9a-fA-F]+)\s*,/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    results.push({
      index: parseInt(m[1], 10),
      start: parseInt(m[2], 16),
      end: parseInt(m[3], 16),
    })
  }
  return results
}

/**
 * Check if an address is already covered by an existing PhyMem range.
 */
function isAddressCovered(addr: number, ranges: PhyMemRange[]): boolean {
  return ranges.some(r => addr >= r.start && addr < r.end)
}

/**
 * Check if a proposed [start, end) range overlaps any existing range.
 */
function hasOverlap(start: number, end: number, ranges: PhyMemRange[]): boolean {
  return ranges.some(r => start < r.end && end > r.start)
}

/**
 * Fix memory access out-of-bounds by adding missing addresses to template.vte [PhyMem].
 *
 * @param projectPath AUnit project root (contains meta/data/common/base/template.vte)
 * @param addresses   Hex address strings (without 0x prefix) to add
 * @returns           Actions taken: added and skipped addresses
 */
function fixPhyMemInVte(
  projectPath: string,
  addresses: string[],
): { added: string[]; skipped: string[]; vte_path: string } {
  const vtePath = join(projectPath, "meta", "data", "common", "base", "template.vte")
  const added: string[] = []
  const skipped: string[] = []

  if (!existsSync(vtePath)) {
    return { added, skipped: addresses, vte_path: vtePath }
  }

  let content = readFileSync(vtePath, "utf-8")
  const existingRanges = parsePhyMemEntries(content)
  let nextIndex = existingRanges.length > 0
    ? Math.max(...existingRanges.map(r => r.index)) + 1
    : 1

  // Collect new ranges to add (accumulate so overlap checks include previously added ranges)
  const allRanges = [...existingRanges]
  const newLines: string[] = []

  for (const addrHex of addresses) {
    const addr = parseInt(addrHex, 16)
    if (isAddressCovered(addr, allRanges)) {
      skipped.push(`0x${addrHex}`)
      continue
    }

    // Default: 4KB range from addr
    let rangeStart = addr
    let rangeEnd = addr + 0x1000

    // Shrink if overlapping with existing ranges
    if (hasOverlap(rangeStart, rangeEnd, allRanges)) {
      // Try minimal range: just 16 bytes
      rangeEnd = addr + 0x10
      if (hasOverlap(rangeStart, rangeEnd, allRanges)) {
        // Cannot fit even 16 bytes — skip
        skipped.push(`0x${addrHex}`)
        continue
      }
    }

    const startHex = rangeStart.toString(16).padStart(8, "0")
    const endHex = rangeEnd.toString(16).padStart(8, "0")
    newLines.push(`${nextIndex}=0x${startHex},0x${endHex},0`)
    allRanges.push({ index: nextIndex, start: rangeStart, end: rangeEnd })
    added.push(`0x${startHex}-0x${endHex}`)
    nextIndex++
  }

  if (newLines.length > 0) {
    // Find [PhyMem] section and append entries at its end
    const phyMemIdx = content.search(/^\[PhyMem\]\s*$/mi)
    if (phyMemIdx !== -1) {
      // Find the end of the [PhyMem] section (next section header or EOF)
      const afterHeader = content.indexOf("\n", phyMemIdx)
      const nextSectionMatch = content.slice(afterHeader + 1).search(/^\[/m)
      const insertPos = nextSectionMatch !== -1
        ? afterHeader + 1 + nextSectionMatch
        : content.length

      // Ensure newline before insertion
      const prefix = content[insertPos - 1] === "\n" ? "" : "\n"
      const suffix = nextSectionMatch !== -1 ? "" : "\n"
      content =
        content.slice(0, insertPos) +
        prefix + newLines.join("\n") + "\n" + suffix +
        content.slice(insertPos)
    } else {
      // No [PhyMem] section — append one
      const suffix = content.endsWith("\n") ? "" : "\n"
      content += `${suffix}[PhyMem]\n${newLines.join("\n")}\n`
    }

    writeFileSync(vtePath, content, "utf-8")
  }

  return { added, skipped, vte_path: vtePath }
}

/**
 * aunit_run_case — Execute test cases in an AUnit project.
 * Wraps: SunwiseAUnit.cli.bat ut runCase
 *
 * On failure, automatically diagnoses the cause:
 *   - Compilation errors are parsed and classified as build_env vs case_error
 *   - If compiler is not found, searches globally and adds to universal.conf path=
 *   - If missing includes are detected, adds <installDir>/includes/ paths to conf
 *   - Retries once after environment fixes
 *   - Returns structured diagnostics for agent-level decision making
 */
export const aunitRunCase: ToolDefinition = tool({
  description:
    "Execute unit test cases in a SunwiseAUnit project. " +
    "Can run all cases, or filter by source file, function name, or specific case IDs. " +
    "NOTE: Expected value mismatch (retValue wrong or unset) does NOT cause execution failure — " +
    "AUnit runs such cases normally and records actual outputs in gson for later analysis. " +
    "Execution failure (non-zero exit) is ALWAYS a compilation error. On failure, automatically " +
    "parses and classifies as build_env (compiler/headers/linker) vs case_compile_error " +
    "(type mismatch, missing stubs, syntax in test scripts). Attempts auto-fix for build_env " +
    "issues and retries.",
  args: {
    project_name: tool.schema.string().describe("AUnit project name"),
    source_paths: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Specific source files to run cases for"),
    function_names: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Specific function names to run cases for"),
    case_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Specific test case IDs to execute"),
    aunit_path: tool.schema
      .string()
      .optional()
      .describe("Path to AUnit installation directory (optional — auto-detected from PATH if omitted)"),
    project_dir: tool.schema
      .string()
      .describe("Project root directory"),
  },
  async execute({ project_name, source_paths, function_names, case_ids, aunit_path, project_dir }) {
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
    const confPath = resolve(projectPath, "universal.conf")

    // ── Build per-file groups when -func needs -src auto-resolution ──────
    // AUnit CLI: -src only accepts ONE file, so functions from different files
    // must be executed in separate calls, each with its own -src.
    type FileGroup = { srcFile: string | undefined; funcs: string[] }
    let fileGroups: FileGroup[] | null = null // null = single run (no grouping)

    if (function_names && function_names.length > 0 && !case_ids) {
      // When user provides a single source_paths, all functions belong to that file — skip map lookup
      if (source_paths && source_paths.length === 1) {
        fileGroups = [{ srcFile: source_paths[0], funcs: function_names }]
      } else {
        // Resolve func→src from summary.json; fallback to source_paths[0] if map misses
        const funcSourceMap = readFuncSourceMap(projectPath)
        const fallbackSrc = source_paths?.[0]
        // Group functions by source file
        const grouped = new Map<string, string[]>() // srcFile → funcNames
        const unmapped: string[] = []
        for (const fn of function_names) {
          const src = funcSourceMap.get(fn) ?? fallbackSrc
          if (src) {
            const list = grouped.get(src)
            if (list) list.push(fn)
            else grouped.set(src, [fn])
          } else {
            unmapped.push(fn)
          }
        }
        // Only use multi-file grouping when functions span >1 source file
        if (grouped.size > 1 || (grouped.size === 1 && unmapped.length > 0)) {
          fileGroups = []
          for (const [src, funcs] of grouped) {
            fileGroups.push({ srcFile: src, funcs })
          }
          if (unmapped.length > 0) {
            fileGroups.push({ srcFile: undefined, funcs: unmapped })
          }
        } else if (grouped.size === 1) {
          // Single source file — use it as resolved source_paths for the single run below
          const [src] = grouped.keys()
          fileGroups = [{ srcFile: src, funcs: function_names }]
        }
        // grouped.size === 0 && unmapped only → fall through to single run without -src
      }
    }

    // ── Helper: run a single CLI call and return raw result ──────────────
    const runOnce = (groupArgs: string[]) =>
      execAunit(cliPath, installDir, "ut", "runCase", groupArgs, 86_400_000, project_dir)

    // ── Helper: attempt auto-fix for build_env / runtime_memory_access ───
    const attemptAutoFix = (result: ReturnType<typeof execAunit>) => {
      const diagnostics = classifyFailure(result.stdout, result.stderr)

      // Runtime memory access violation → fix template.vte [PhyMem]
      if (diagnostics.failure_type === "runtime_memory_access" && diagnostics.memory_access_errors) {
        const actions: string[] = []
        const addrs = diagnostics.memory_access_errors.map(e => e.addr)
        const fix = fixPhyMemInVte(projectPath, addrs)
        if (fix.added.length > 0) {
          actions.push(
            `Added ${fix.added.length} PhyMem range(s) to template.vte: ${fix.added.join(", ")}`,
          )
        }
        if (fix.skipped.length > 0) {
          actions.push(
            `Skipped ${fix.skipped.length} address(es) already covered: ${fix.skipped.join(", ")}`,
          )
        }
        return { diagnostics, actions }
      }

      if (diagnostics.failure_type !== "build_env") return { diagnostics, actions: [] as string[] }

      const actions: string[] = []
      const buildAnalysis = parseBuildErrors(result.stdout, result.stderr, installDir)

      if (diagnostics.compiler_not_found) {
        const foundDir = searchCompilerGlobal(diagnostics.compiler_not_found)
        if (foundDir) {
          const added = addPathToConf(confPath, foundDir, installDir)
          actions.push(
            added
              ? `Found compiler "${diagnostics.compiler_not_found}" at ${foundDir}, added to universal.conf path=`
              : `Compiler "${diagnostics.compiler_not_found}" found at ${foundDir} (already in conf)`,
          )
        } else {
          actions.push(`Compiler "${diagnostics.compiler_not_found}" not found on system`)
        }
      }

      const { warnings } = patchUniversalConf(confPath, installDir)
      if (warnings.length > 0) {
        actions.push(`Patched universal.conf env paths (${warnings.length} warning(s))`)
      }

      const missingHeaders = parseMissingHeaders(result.stdout, result.stderr)
      const availableIncludes = missingHeaders.length > 0
        ? selectIncludesForHeaders(installDir, missingHeaders)
        : collectInstallIncludes(installDir)
      if (availableIncludes.length > 0) {
        const added = addIncludesToConf(confPath, availableIncludes, installDir)
        if (added.length > 0) {
          actions.push(`Added ${added.length} include path(s) targeting missing headers`)
        }
      }

      const daActions = buildAnalysis.recommended_actions.filter(a => a.action === "add_da")
      if (daActions.length > 0) {
        let daAdded = 0
        for (const da of daActions) {
          if (addDaToConf(confPath, da.target, da.value)) daAdded++
        }
        if (daAdded > 0) {
          actions.push(`Added ${daAdded} da= macro(s) to universal.conf`)
        }
      }

      return { diagnostics, actions }
    }

    // ── Multi-file grouped execution ─────────────────────────────────────
    if (fileGroups && fileGroups.length > 1) {
      const groupResults: Array<{ srcFile: string | undefined; funcs: string[]; status: string; cmd?: string; stdout: string; stderr?: string }> = []
      let allSuccess = true
      let autoFixApplied = false
      let autoFixActions: string[] = []

      for (const group of fileGroups) {
        const gArgs = buildArgs({
          "-pp": projectPath,
          "-src": group.srcFile ? [group.srcFile] : undefined,
          "-func": group.funcs,
        })

        let gResult = runOnce(gArgs)

        if (gResult.exitCode === 0 || gResult.stdout.includes("success")) {
          groupResults.push({ srcFile: group.srcFile, funcs: group.funcs, status: "success", cmd: gResult.cmd, stdout: gResult.stdout.slice(0, 2000) })
          continue
        }

        // First build_env failure → attempt auto-fix once (project-wide), then retry this + remaining groups
        if (!autoFixApplied) {
          const fix = attemptAutoFix(gResult)
          if (fix.actions.length > 0) {
            autoFixApplied = true
            autoFixActions = fix.actions
            // Retry this group after fix
            gResult = runOnce(gArgs)
            if (gResult.exitCode === 0 || gResult.stdout.includes("success")) {
              groupResults.push({ srcFile: group.srcFile, funcs: group.funcs, status: "success", cmd: gResult.cmd, stdout: gResult.stdout.slice(0, 2000) })
              continue
            }
          }
        }

        allSuccess = false
        const diag = classifyFailure(gResult.stdout, gResult.stderr)
        groupResults.push({
          srcFile: group.srcFile,
          funcs: group.funcs,
          status: "error",
          cmd: gResult.cmd,
          stdout: gResult.stdout.slice(0, 2000),
          stderr: `[${diag.failure_type}] ${diag.summary}`,
        })
      }

      const successGroups = groupResults.filter(g => g.status === "success")
      const errorGroups = groupResults.filter(g => g.status !== "success")

      return JSON.stringify({
        status: allSuccess ? "success" : (successGroups.length > 0 ? "partial" : "error"),
        project_name,
        total_groups: fileGroups.length,
        success_groups: successGroups.length,
        error_groups: errorGroups.length,
        ...(autoFixActions.length > 0 ? { auto_fix: { actions: autoFixActions } } : {}),
        groups: groupResults.map(g => ({
          src_file: g.srcFile ?? "(unmapped)",
          functions: g.funcs,
          status: g.status,
          cmd: g.cmd,
          ...(g.status === "error" ? { error: g.stderr } : {}),
        })),
        conf_path: allSuccess ? undefined : confPath,
      })
    }

    // ── Single run path (no grouping, or single-file group) ──────────────
    const singleGroup = fileGroups?.[0]
    const args = buildArgs({
      "-pp": projectPath,
      "-src": singleGroup?.srcFile ? [singleGroup.srcFile] : source_paths,
      "-func": function_names,
      "-case": case_ids,
    })

    let result = runOnce(args)

    // ── Success path (also check for runtime memory errors in stdout) ────
    if (result.exitCode === 0 || result.stdout.includes("success")) {
      // Even on "success" exit code, check for memory access violations
      // that AUnit may have logged without failing the process
      const memErrors = parseMemoryAccessErrors(result.stdout, result.stderr)
      if (memErrors.length > 0) {
        const addrs = memErrors.map(e => e.addr)
        const fix = fixPhyMemInVte(projectPath, addrs)
        if (fix.added.length > 0) {
          // Retry after fixing PhyMem
          const retryResult = runOnce(args)
          return JSON.stringify({
            status: (retryResult.exitCode === 0 || retryResult.stdout.includes("success")) ? "success" : "error",
            project_name,
            cmd: retryResult.cmd,
            auto_fix: {
              actions: [`Added ${fix.added.length} PhyMem range(s) to template.vte: ${fix.added.join(", ")}`],
              retry_succeeded: retryResult.exitCode === 0 || retryResult.stdout.includes("success"),
            },
            stdout: retryResult.stdout.slice(0, 5000),
          })
        }
      }

      return JSON.stringify({
        status: "success",
        project_name,
        cmd: result.cmd,
        stdout: result.stdout.slice(0, 5000),
      })
    }

    // ── Failure path: diagnose and attempt auto-fix ───────────────────────
    const { diagnostics, actions } = attemptAutoFix(result)

    if (actions.length > 0) {
      const retryResult = runOnce(args)
      const retrySucceeded = retryResult.exitCode === 0 || retryResult.stdout.includes("success")

      if (retrySucceeded) {
        return JSON.stringify({
          status: "success",
          project_name,
          cmd: retryResult.cmd,
          auto_fix: { actions, retry_succeeded: true },
          stdout: retryResult.stdout.slice(0, 5000),
        })
      }

      const retryDiagnostics = classifyFailure(retryResult.stdout, retryResult.stderr)
      const retryBuildAnalysis = parseBuildErrors(retryResult.stdout, retryResult.stderr, installDir)

      return JSON.stringify({
        status: "error",
        exit_code: retryResult.exitCode,
        message: "AUnit runCase failed after environment auto-fix",
        cmd: retryResult.cmd,
        diagnostics: retryDiagnostics,
        build_error_analysis: retryBuildAnalysis,
        auto_fix: { actions, retry_succeeded: false },
        conf_path: confPath,
        stdout: retryResult.stdout.slice(0, 5000),
        stderr: retryResult.stderr.slice(0, 3000),
      })
    }

    // No auto-fix applied or case_error — return diagnostics with build analysis for agent
    const buildAnalysis = parseBuildErrors(result.stdout, result.stderr, installDir)
    return JSON.stringify({
      status: "error",
      exit_code: result.exitCode,
      message: "AUnit runCase failed",
      cmd: result.cmd,
      diagnostics,
      build_error_analysis: buildAnalysis,
      auto_fix: null,
      conf_path: confPath,
      stdout: result.stdout.slice(0, 5000),
      stderr: result.stderr.slice(0, 3000),
    })
  },
})
