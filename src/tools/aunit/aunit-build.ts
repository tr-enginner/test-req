import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "fs"
import { basename, join, resolve } from "path"
import {
  resolveAunitCli,
  execAunit,
  buildArgs,
  normalizePath,
  AUNIT_WORKSPACE,
  normalizeProjectDir,
  parseUniversalConf,
  resolveConfEnvPaths,
  writeUniversalConf,
  selectIncludesForHeaders,
  addPathToConf,
  addDaToConf,
  buildEnvMap,
  expandEnvRefs,
} from "./aunit-utils"
import {
  parseSyntaxErrors,
  parseCompilerNotFound,
  searchCompilerGlobal,
  parseBuildErrors,
  loadPlatformCompilers,
  diagnoseMakefileTemplate,
  type BuildSyntaxError,
  type BuildErrorAnalysis,
  type MakefileDiagnostic,
} from "./aunit-build-diagnostics"

/** Backup directory name within the AUnit project root */
const SOURCE_BACKUP_DIR = ".source-backup"

/**
 * Read, validate, and patch the project-local universal.conf in place.
 * Resolves env path entries: disk check → system env lookup → warn+skip.
 * Also warns about inc/path entries whose %envName%-expanded values are
 * missing or unresolvable (e.g. %AUNIT_HOME% entries when installDir is given).
 * Safe to call with a non-existent path — returns empty warnings.
 *
 * @param installDir  AUnit installation directory (resolves `%AUNIT_HOME%`).
 * @exported for testing
 */
export function patchUniversalConf(
  confPath: string,
  installDir?: string,
): {
  warnings: string[]
  env_search_needed: Array<{ name: string; original_value: string; suggested_path?: string }>
} {
  const parsed = parseUniversalConf(confPath)
  if (!parsed) return { warnings: [], env_search_needed: [] }

  const { resolved, warnings, env_search_needed } = resolveConfEnvPaths(parsed, installDir)
  writeUniversalConf(confPath, resolved)
  return { warnings, env_search_needed }
}

/**
 * Add new include directories to universal.conf (only those not already present).
 * Returns the list of paths actually added. No-ops if conf doesn't exist.
 *
 * Deduplication expands %envName% tokens (including the built-in %AUNIT_HOME%)
 * in existing inc entries before comparing, so `inc=%AUNIT_HOME%/includes/runtime`
 * is correctly recognised as equivalent to its resolved absolute path and not
 * added again.
 *
 * @param installDir  AUnit installation directory (resolves `%AUNIT_HOME%`).
 * @exported for testing
 */
export function addIncludesToConf(
  confPath: string,
  newPaths: string[],
  installDir?: string,
): string[] {
  const parsed = parseUniversalConf(confPath)
  if (!parsed) return []

  const envMap = buildEnvMap(parsed, installDir)

  const existing = new Set(
    parsed.entries
      .filter(e => e.type === "inc")
      .map(e => normalizePath(expandEnvRefs(e.value ?? "", envMap))),
  )

  const added: string[] = []
  for (const p of newPaths) {
    // Expand the candidate path too (in case caller passes a %var%-bearing path)
    const normalized = normalizePath(expandEnvRefs(p, envMap))
    if (!existing.has(normalized)) {
      parsed.entries.push({ type: "inc", raw: `inc=${p}`, value: p })
      existing.add(normalized)
      added.push(p)
    }
  }

  if (added.length > 0) {
    writeUniversalConf(confPath, parsed)
  }
  return added
}

// ─── Source file backup / restore ───────────────────────────────────────────

/**
 * Create a manifest mapping original path → backup filename.
 * The manifest is a JSON file so restore can work without the original list.
 */
interface BackupManifest {
  created_at: string
  files: { original: string; backup_name: string }[]
}

/**
 * Back up source files before build so they can be restored afterwards.
 * Each file is copied into `<projectPath>/.source-backup/` with an index-based name.
 * A manifest.json is written to track original → backup mapping.
 *
 * @exported for testing
 */
export function backupSourceFiles(
  projectPath: string,
  sourceFiles: string[],
): { backed_up: string[]; backup_dir: string } {
  const backupDir = join(projectPath, SOURCE_BACKUP_DIR)

  // Clean any stale backup from a previous run
  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true })
  }
  mkdirSync(backupDir, { recursive: true })

  const backedUp: string[] = []
  const manifest: BackupManifest = {
    created_at: new Date().toISOString(),
    files: [],
  }

  for (let i = 0; i < sourceFiles.length; i++) {
    const src = sourceFiles[i]
    if (!existsSync(src)) continue

    // Use index + original basename to keep filenames readable
    const backupName = `${i}_${basename(src)}`
    const backupPath = join(backupDir, backupName)

    copyFileSync(src, backupPath)
    manifest.files.push({ original: src, backup_name: backupName })
    backedUp.push(src)
  }

  // Write manifest so restore can work independently
  const manifestPath = join(backupDir, "manifest.json")
  const { writeFileSync } = require("fs")
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

  return { backed_up: backedUp, backup_dir: backupDir }
}

/**
 * Restore source files from backup after build completes.
 * Reads manifest.json from the backup directory, copies each backup back
 * to its original location, then removes the backup directory.
 *
 * @exported for testing
 */
export function restoreSourceFiles(
  projectPath: string,
): { restored: string[]; errors: string[] } {
  const backupDir = join(projectPath, SOURCE_BACKUP_DIR)
  const manifestPath = join(backupDir, "manifest.json")

  if (!existsSync(manifestPath)) {
    return { restored: [], errors: [] }
  }

  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
  } catch {
    return { restored: [], errors: ["Failed to read backup manifest"] }
  }

  const restored: string[] = []
  const errors: string[] = []

  for (const entry of manifest.files) {
    const backupPath = join(backupDir, entry.backup_name)
    if (!existsSync(backupPath)) {
      errors.push(`Backup file missing: ${entry.backup_name} for ${entry.original}`)
      continue
    }

    try {
      copyFileSync(backupPath, entry.original)
      restored.push(entry.original)
    } catch (err) {
      errors.push(`Failed to restore ${entry.original}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Clean up backup directory
  try {
    rmSync(backupDir, { recursive: true, force: true })
  } catch {
    // Non-critical — leave it
  }

  return { restored, errors }
}

/**
 * aunit_build — Analyze and build an AUnit project.
 * Wraps: SunwiseAUnit.cli.bat ut build
 *
 * Before building:
 *   1. Backs up original source files (if source_files provided)
 *   2. Reads <project>/universal.conf (in project root directory)
 *   3. Validates env path entries (disk → system env → warn+skip)
 *   4. Writes the patched conf back in place
 *
 * After building (success or failure):
 *   - Restores all backed-up source files to their original locations
 *
 * On build failure, retries up to 2 times by adding include paths from
 * <installDir>/includes/ to the conf file before each retry.
 */
export const aunitBuild: ToolDefinition = tool({
  description:
    "Analyze and build a SunwiseAUnit project. Parses source files, extracts functions, " +
    "and prepares the project for test case generation and execution. " +
    "Automatically patches the project universal.conf env paths before building, " +
    "retries with expanded include paths from <installDir>/includes/ on failure, " +
    "searches for missing compilers globally and adds them to universal.conf path= entries, " +
    "and returns structured syntax_errors for agent-level auto-fix. " +
    "IMPORTANT: Pass source_files (the original source file paths) to automatically " +
    "back up and restore them after build — AUnit analysis may modify source files in place.",
  args: {
    project_name: tool.schema.string().describe("AUnit project name"),
    source_files: tool.schema
      .array(tool.schema.string())
      .describe(
        "Original source file paths (absolute) to back up before build and restore after. " +
        "AUnit analysis/build may modify these files — they will be automatically restored.",
      ),
    source_paths: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Specific source files to rebuild (optional, rebuilds all if omitted)"),
    aunit_path: tool.schema
      .string()
      .optional()
      .describe("Path to AUnit installation directory (optional — auto-detected from PATH if omitted)"),
    project_dir: tool.schema
      .string()
      .describe("Project root directory"),
  },
  async execute({ project_name, source_files, source_paths, aunit_path, project_dir }) {
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

    // -pp must be absolute path to the project inside .matrix/aunit/
    const projectPath = resolve(normalizePath(normalizeProjectDir(project_dir)), AUNIT_WORKSPACE, project_name)

    // Path to project-local universal.conf (in project root, NOT meta/data/common/base/)
    const confPath = resolve(projectPath, "universal.conf")

    // ── Phase 0: Back up original source files before any build ──────────
    const backupInfo = backupSourceFiles(projectPath, source_files)

    // ── Phase 1: Patch env paths in universal.conf before building ─────────
    const { warnings: confWarnings, env_search_needed: envSearchNeeded } =
      patchUniversalConf(confPath, installDir)

    const args = buildArgs({
      "-pp": projectPath,
      "-src": source_paths,
    })

    // ── Phase 2: Build with error-type-aware retry (max 2 retries = 3 total) ─
    const allIncAdded: string[] = []
    let lastResult = execAunit(cliPath, installDir, "ut", "build", args, 1_800_000, project_dir)
    let lastErrorAnalysis: BuildErrorAnalysis | null = null

    const MAX_RETRIES = 2
    // Load platform compilers once for enriched compiler-not-found detection
    const platformCompilers = loadPlatformCompilers(installDir)

    for (
      let retry = 0;
      retry < MAX_RETRIES && lastResult.exitCode !== 0 && !lastResult.stdout.includes("success");
      retry++
    ) {
      // Classify the error to determine the right fix strategy
      lastErrorAnalysis = parseBuildErrors(lastResult.stdout, lastResult.stderr, installDir)

      if (lastErrorAnalysis.primary_fix === "add_includes") {
        // Smart include selection: prefer dirs containing the missing headers;
        // fall back to platform-keyword matching; never add all dirs blindly
        const selected = selectIncludesForHeaders(
          installDir,
          lastErrorAnalysis.missing_headers,
          undefined,
        )
        if (selected.length === 0) break  // No suitable includes found — stop retrying

        const added = addIncludesToConf(confPath, selected, installDir)
        if (added.length === 0) break  // All candidates already in conf

        allIncAdded.push(...added)
        lastResult = execAunit(cliPath, installDir, "ut", "build", args, 1_800_000, project_dir)
      } else if (lastErrorAnalysis.primary_fix === "add_da_macros") {
        const daActions = lastErrorAnalysis.recommended_actions.filter(a => a.action === "add_da")
        if (daActions.length === 0) break
        let anyAdded = false
        for (const da of daActions) {
          if (addDaToConf(confPath, da.target, da.value)) anyAdded = true
        }
        if (!anyAdded) break  // All da= entries already present
        lastResult = execAunit(cliPath, installDir, "ut", "build", args, 1_800_000, project_dir)
      } else {
        // For other error types (preprocessor needed, env issues, compiler),
        // adding includes won't help — stop the retry loop
        break
      }
    }

    // Re-classify final failure state if not yet done
    if (
      lastResult.exitCode !== 0 &&
      !lastResult.stdout.includes("success") &&
      !lastErrorAnalysis
    ) {
      lastErrorAnalysis = parseBuildErrors(lastResult.stdout, lastResult.stderr, installDir)
    }

    // ── Phase 3: Compiler-not-found detection + global search + retry ──────
    let compilerFix: {
      compiler_name: string
      found_at: string
      added_to_conf: boolean
      retry_succeeded: boolean
    } | null = null

    if (lastResult.exitCode !== 0 && !lastResult.stdout.includes("success")) {
      const compilerName = parseCompilerNotFound(lastResult.stdout, lastResult.stderr)
      if (compilerName) {
        const foundDir = searchCompilerGlobal(compilerName)
        if (foundDir) {
          const added = addPathToConf(confPath, foundDir, installDir)
          const retryResult = execAunit(cliPath, installDir, "ut", "build", args, 1_800_000, project_dir)
          const succeeded = retryResult.exitCode === 0 || retryResult.stdout.includes("success")
          compilerFix = {
            compiler_name: compilerName,
            found_at: foundDir,
            added_to_conf: added,
            retry_succeeded: succeeded,
          }
          if (succeeded) lastResult = retryResult
        } else {
          compilerFix = {
            compiler_name: compilerName,
            found_at: "",
            added_to_conf: false,
            retry_succeeded: false,
          }
        }
      }
    }

    // ── Phase 4: Parse syntax errors (regardless of success/failure) ───────
    const syntaxErrors: BuildSyntaxError[] = parseSyntaxErrors(lastResult.stdout, lastResult.stderr)

    // ── Phase 5: Restore original source files ──────────────────────────────
    const restoreInfo = restoreSourceFiles(projectPath)

    // ── Return result ──────────────────────────────────────────────────────
    const failed = lastResult.exitCode !== 0 && !lastResult.stdout.includes("success")

    const sourceRestoration = {
      backed_up: backupInfo.backed_up.length,
      restored: restoreInfo.restored.length,
      errors: restoreInfo.errors,
    }

    if (failed) {
      // Run Makefile template diagnostics when all retries are exhausted
      let makefileDiagnostics: MakefileDiagnostic | undefined
      try {
        const firstSource = source_paths?.[0]
        const sourceBaseName = firstSource ? basename(firstSource) : undefined
        const diag = diagnoseMakefileTemplate(projectPath, sourceBaseName)
        if (diag.suggestions.length > 0 || diag.missing_in_template.includes.length > 0 ||
            diag.missing_in_template.defines.length > 0) {
          makefileDiagnostics = diag
        }
      } catch {
        // Non-critical — skip Makefile diagnostics on error
      }

      return JSON.stringify({
        status: "error",
        exit_code: lastResult.exitCode,
        message: "AUnit build failed after retries",
        cmd: lastResult.cmd,
        conf_path: confPath,
        conf_modifications: {
          env_warnings: confWarnings,
          inc_added: allIncAdded,
          retry_count: allIncAdded.length > 0 ? MAX_RETRIES : 0,
        },
        ...(envSearchNeeded.length > 0 ? { env_search_needed: envSearchNeeded } : {}),
        compiler_fix: compilerFix,
        build_error_analysis: lastErrorAnalysis,
        syntax_errors: syntaxErrors,
        ...(makefileDiagnostics ? { makefile_diagnostics: makefileDiagnostics } : {}),
        source_restoration: sourceRestoration,
        stdout: lastResult.stdout.slice(0, 5000),
        stderr: lastResult.stderr.slice(0, 3000),
      })
    }

    return JSON.stringify({
      status: "success",
      project_name,
      cmd: lastResult.cmd,
      conf_path: confPath,
      conf_modifications: {
        env_warnings: confWarnings,
        inc_added: allIncAdded,
        retry_count: allIncAdded.length > 0 ? 1 : 0,
      },
      ...(envSearchNeeded.length > 0 ? { env_search_needed: envSearchNeeded } : {}),
      compiler_fix: compilerFix,
      syntax_errors: syntaxErrors,
      source_restoration: sourceRestoration,
      stdout: lastResult.stdout.slice(0, 5000),
    })
  },
})
