import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import {
  resolveAunitCli,
  resolveAunitPlatform,
  execAunit,
  buildArgs,
  normalizePath,
  generateCdbFile,
  AUNIT_WORKSPACE,
  normalizeProjectDir,
} from "./aunit-utils"
import { readGsonFile } from "./gbk-encoding"

/** Regex matching any CJK character (Chinese, Japanese, Korean) */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/
/** Regex matching all CJK characters globally */
const CJK_RE_G = /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]+/g
/** Regex matching any non-ASCII character */
const NON_ASCII_RE_G = /[^\x00-\x7F]+/g

/**
 * Sanitize a name string by stripping all non-ASCII characters.
 * Collapses resulting multiple underscores/hyphens and trims edges.
 * Returns a fallback if the result is empty.
 */
function sanitizeToAscii(name: string, fallback: string): string {
  let result = name
    .replace(NON_ASCII_RE_G, "_")  // replace non-ASCII runs with underscore
    .replace(/_{2,}/g, "_")        // collapse multiple underscores
    .replace(/^[_\-]+|[_\-]+$/g, "") // trim leading/trailing underscores/hyphens
  if (!result || result.length < 2) {
    result = fallback
  }
  return result
}

/**
 * Compute the nearest common parent directory for a list of paths.
 * File paths are mapped to their parent directory first.
 */
function nearestCommonDir(paths: string[]): string {
  const dirs = paths.map((p) => {
    try {
      return statSync(p).isDirectory() ? p : dirname(p)
    } catch {
      return dirname(p)
    }
  })
  if (dirs.length === 1) return dirs[0]
  const parts = dirs.map((d) => d.split("/"))
  const common: string[] = []
  for (let i = 0; i < parts[0].length; i++) {
    const seg = parts[0][i]
    if (parts.every((p) => p[i] === seg)) common.push(seg)
    else break
  }
  return common.join("/") || "/"
}

/** Header file extensions that mark a directory as an include candidate */
const HEADER_EXTS = new Set([".h", ".hpp", ".hxx", ".hh"])

/** Directories to skip when scanning for include paths */
const SKIP_DIRS = new Set([".matrix", ".git", "node_modules", ".svn", "build", "out", "dist", "__pycache__"])

/**
 * Recursively scan a project directory to collect all directories that contain
 * header files (.h/.hpp/.hxx/.hh). Also includes directories that contain
 * source files, since peer headers are often in the same directory.
 * Skips known non-source directories (.matrix, .git, node_modules, etc.).
 * All returned paths are absolute with forward slashes.
 */
function collectIncludeDirs(root: string): string[] {
  const dirs = new Set<string>()

  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    let hasHeader = false
    for (const entry of entries) {
      const full = join(dir, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(entry.toLowerCase())) walk(full)
      } else if (!hasHeader) {
        const dot = entry.lastIndexOf(".")
        if (dot !== -1 && HEADER_EXTS.has(entry.slice(dot).toLowerCase())) {
          hasHeader = true
        }
      }
    }
    if (hasHeader) dirs.add(resolve(dir))
  }

  walk(root)
  return [...dirs]
}

/** Source file extensions to collect when expanding directories */
const SOURCE_EXTS = new Set([".c", ".cpp", ".cc", ".cxx"])

/**
 * Expand a mixed list of file/directory paths into concrete source file paths.
 * - File paths are kept as-is (regardless of extension — caller decides what to pass).
 * - Directory paths are recursively scanned for .c/.cpp/.cc/.cxx files.
 * - All returned paths are absolute.
 */
function collectSourceFiles(paths: string[]): string[] {
  const result: string[] = []

  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else {
        const dot = entry.lastIndexOf(".")
        if (dot !== -1 && SOURCE_EXTS.has(entry.slice(dot).toLowerCase())) {
          result.push(resolve(full))
        }
      }
    }
  }

  for (const p of paths) {
    try {
      if (statSync(p).isDirectory()) {
        walk(p)
      } else {
        result.push(resolve(p))
      }
    } catch {
      // Path doesn't exist — keep it so AUnit reports the error
      result.push(resolve(p))
    }
  }
  return result
}

/** Expected directories and files in a successfully created AUnit project */
const EXPECTED_DIRS = ["meta", "out"] as const
const EXPECTED_FILES = ["analysis.conf", "universal.conf"] as const

/**
 * Recursively scan a UT directory for gson files, skipping preanalysis/.
 * Returns the total number of gson files found and the number that have at
 * least one generated test case (cases.length > 0).
 */
function scanGsonCaseCounts(utDir: string): { total: number; withCases: number } {
  let total = 0
  let withCases = 0

  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      let st
      try {
        st = statSync(fullPath)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        // skip preanalysis/ subtree — it contains template gson files, not real function gsonfiles
        if (entry.toLowerCase() === "preanalysis") continue
        walk(fullPath)
      } else if (entry.endsWith(".gson")) {
        total++
        try {
          const data = readGsonFile(fullPath)
          if (Array.isArray(data?.cases) && data.cases.length > 0) {
            withCases++
          }
        } catch {
          // damaged or unreadable gson — count it but treat as no cases
        }
      }
    }
  }

  walk(utDir)
  return { total, withCases }
}

/**
 * aunit_create_project — Create a SunwiseAUnit unit test project from source files.
 * Wraps: SunwiseAUnit.cli.bat ut createProject
 */
export const aunitCreateProject: ToolDefinition = tool({
  description:
    "Create a SunwiseAUnit unit test project from C/C++ source files. " +
    "Sets up the AUnit project workspace for subsequent build, autogen, and execution steps. " +
    "Platform config (-config) is auto-selected from compilation-env.json analysis results " +
    "against available platforms in <installDir>/config/platform/. " +
    "IMPORTANT: All paths must be absolute. Chinese characters in project_name/software_name are auto-stripped to ASCII; Chinese in paths will be rejected.",
  args: {
    force_recreate: tool.schema
      .boolean()
      .optional()
      .describe(
        "Force delete and recreate the project even if it already exists. " +
        "Deletion uses Node.js native API (safe on Windows — no MSYS2 shell). Default: false."
      ),
    project_name: tool.schema.string().describe("Name for the AUnit project (ASCII only, no Chinese characters)"),
    source_paths: tool.schema
      .array(tool.schema.string())
      .describe("Absolute paths to source files or directories. In SRC mode, directories are automatically expanded to all .c/.cpp/.cc/.cxx files recursively."),
    include_dirs: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Additional include directories — absolute paths (-I)"),
    defines: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Additional preprocessor defines (-D)"),
    software_name: tool.schema
      .string()
      .optional()
      .describe("Software name for report headers (ASCII only, no Chinese characters)"),
    project_version: tool.schema
      .string()
      .optional()
      .describe("Project version for report headers"),
    aunit_path: tool.schema
      .string()
      .optional()
      .describe("Path to AUnit installation directory (optional — auto-detected from PATH if omitted)"),
    compiler_dialect: tool.schema
      .string()
      .optional()
      .describe("Compiler dialect for platform auto-mapping (default: auto)"),
    aunit_platform: tool.schema
      .string()
      .optional()
      .describe("Explicit AUnit platform config override"),
    creation_type: tool.schema
      .enum(["SRC", "CDB"])
      .optional()
      .describe(
        "Project creation type. CDB mode uses a compilation database file for precise source specification; " +
        "SRC mode uses a source directory. Default: auto (CDB if compiler path is available, otherwise SRC)."
      ),
    project_dir: tool.schema
      .string()
      .describe("Project root directory (absolute path)"),
  },
  async execute({
    project_name,
    source_paths,
    include_dirs,
    defines,
    software_name,
    project_version,
    aunit_path,
    compiler_dialect,
    aunit_platform,
    creation_type,
    project_dir,
    force_recreate,
  }) {
    // ── Auto-sanitize name parameters: strip Chinese/non-ASCII ──
    const sanitized: string[] = []
    if (CJK_RE.test(project_name)) {
      const original = project_name
      project_name = sanitizeToAscii(project_name, "AUnitProject")
      sanitized.push(`project_name: "${original}" → "${project_name}"`)
    }
    if (software_name && CJK_RE.test(software_name)) {
      const original = software_name
      software_name = sanitizeToAscii(software_name, "Software")
      sanitized.push(`software_name: "${original}" → "${software_name}"`)
    }

    // ── Validate paths: Chinese in filesystem paths cannot be auto-fixed ──
    const pathErrors: string[] = []
    if (CJK_RE.test(project_dir)) {
      pathErrors.push(`project_dir "${project_dir}" contains Chinese characters — cannot auto-fix filesystem paths`)
    }
    for (const sp of source_paths) {
      if (CJK_RE.test(sp)) {
        pathErrors.push(`source_path "${sp}" contains Chinese characters — cannot auto-fix filesystem paths`)
        break // one example is enough
      }
    }
    if (include_dirs) {
      for (const d of include_dirs) {
        if (CJK_RE.test(d)) {
          pathErrors.push(`include_dir "${d}" contains Chinese characters — cannot auto-fix filesystem paths`)
          break
        }
      }
    }
    if (pathErrors.length > 0) {
      return JSON.stringify({
        status: "error",
        message:
          "AUnit createProject path parameters must not contain Chinese characters. " +
          "Filesystem paths cannot be auto-converted — use ASCII-only paths.",
        path_errors: pathErrors,
      })
    }

    // ── Resolve all paths to absolute ──
    const absProjectDir = resolve(normalizePath(normalizeProjectDir(project_dir)))
    const absSourcePaths = source_paths.map((p) => resolve(normalizePath(absProjectDir), normalizePath(p)))
    const absIncludeDirs = include_dirs?.map((p) => resolve(normalizePath(absProjectDir), normalizePath(p)))

    // Resolve CLI (priority: config path → system PATH → global search → fail)
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

    // Ensure workspace directory exists
    const workspacePath = resolve(normalizePath(absProjectDir), AUNIT_WORKSPACE)
    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true })
    }

    // Clean up stale "nul" file that MSYS stdio:ignore may have created
    const nulFile = join(absProjectDir, "nul")
    if (existsSync(nulFile)) {
      try { unlinkSync(nulFile) } catch { /* best-effort */ }
    }

    // Resolve platform: auto-match from compilation-env.json → config dialect → default
    const {
      platform,
      source: platformSource,
      compiler: platformCompiler,
      compiler_path: platformCompilerPath,
      compiler_available: platformCompilerAvailable,
      compiler_skipped: platformCompilerSkipped,
    } = resolveAunitPlatform(
      installDir,
      absProjectDir,
      compiler_dialect,
      aunit_platform,
    )

    // ── Determine creation type: CDB (preferred) or SRC (fallback) ──
    const effectiveCreationType: "SRC" | "CDB" =
      creation_type ?? (platformCompilerPath ? "CDB" : "SRC")

    // ── CDB mode: generate .cdb file listing each source with its compiler ──
    let cdbPath: string | undefined
    if (effectiveCreationType === "CDB") {
      const workingDir = nearestCommonDir(absSourcePaths)
      cdbPath = join(workspacePath, `${project_name}.cdb`)
      generateCdbFile(absSourcePaths, platformCompilerPath!, workingDir, cdbPath)
    }

    // Build arguments — all paths are absolute
    const args = buildArgs({
      "-wp": workspacePath,
      "-pn": project_name,
      "-ct": effectiveCreationType,
      ...(effectiveCreationType === "CDB"
        ? { "-cdb_path": cdbPath! }
        : { "-src": collectSourceFiles(absSourcePaths).join(",") }),
      "-config": platform,
      "-sn": software_name,
      "-pv": project_version,
    })
    // ── Force-delete existing project using Node.js native API (no MSYS2 shell involvement) ──
    const projectRoot = join(workspacePath, project_name)
    if (force_recreate && existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true })
    }

    // ── Pre-creation existence check: skip if project already has autogen cases ──
    const existingMissing: string[] = []
    for (const dir of EXPECTED_DIRS) {
      if (!existsSync(join(projectRoot, dir))) existingMissing.push(`${dir}/`)
    }
    for (const file of EXPECTED_FILES) {
      if (!existsSync(join(projectRoot, file))) existingMissing.push(file)
    }
    if (existingMissing.length === 0) {
      // Structure is intact — check whether autogen has already run (≥50% functions have cases)
      const utDir = join(projectRoot, "meta", "model", "UT")
      const { total, withCases } = existsSync(utDir)
        ? scanGsonCaseCounts(utDir)
        : { total: 0, withCases: 0 }
      const coverageRatio = total > 0 ? withCases / total : 0

      if (total > 0 && coverageRatio >= 0.5) {
        return JSON.stringify({
          status: "already_exists",
          message:
            `AUnit project already exists with cases generated for ${withCases}/${total} functions ` +
            `(${Math.round(coverageRatio * 100)}%). Skipping recreation — use the existing project directly.`,
          project_name,
          project_root: projectRoot,
          workspace: workspacePath,
          creation_type: effectiveCreationType,
          ...(cdbPath ? { cdb_path: cdbPath } : {}),
          platform,
          platform_source: platformSource,
          platform_compiler: platformCompiler,
          platform_compiler_available: platformCompilerAvailable,
          ...(platformCompilerSkipped.length > 0 ? { platform_compiler_skipped: platformCompilerSkipped } : {}),
          source_paths: absSourcePaths,
          integrity_check: "passed",
          autogen_stats: {
            total_functions: total,
            functions_with_cases: withCases,
            coverage_ratio: coverageRatio,
          },
          ...(sanitized.length > 0 ? { auto_sanitized: sanitized } : {}),
        })
      }
      // Below threshold (autogen not yet run, or too few cases) — fall through to recreate
    }

    const result = execAunit(cliPath, installDir, "ut", "createProject", args, 300_000, project_dir)

    if (result.exitCode !== 0 && !result.stdout.includes("success")) {
      return JSON.stringify({
        status: "error",
        exit_code: result.exitCode,
        message: "AUnit createProject failed",
        cmd: result.cmd,
        creation_type: effectiveCreationType,
        ...(cdbPath ? { cdb_path: cdbPath } : {}),
        platform,
        platform_source: platformSource,
        platform_compiler: platformCompiler,
        platform_compiler_available: platformCompilerAvailable,
        ...(platformCompilerSkipped.length > 0 ? { platform_compiler_skipped: platformCompilerSkipped } : {}),
        stdout: result.stdout.slice(0, 3000),
        stderr: result.stderr.slice(0, 3000),
      })
    }

    // ── Post-creation integrity check ──
    const missing: string[] = []

    for (const dir of EXPECTED_DIRS) {
      if (!existsSync(join(projectRoot, dir))) {
        missing.push(`${dir}/`)
      }
    }
    for (const file of EXPECTED_FILES) {
      if (!existsSync(join(projectRoot, file))) {
        missing.push(file)
      }
    }

    if (missing.length > 0) {
      return JSON.stringify({
        status: "error",
        message:
          `AUnit createProject completed but project structure is incomplete. ` +
          `Missing: ${missing.join(", ")}. ` +
          `Expected directories: ${EXPECTED_DIRS.join(", ")}; ` +
          `Expected files: ${EXPECTED_FILES.join(", ")}.`,
        cmd: result.cmd,
        creation_type: effectiveCreationType,
        ...(cdbPath ? { cdb_path: cdbPath } : {}),
        project_root: projectRoot,
        missing,
        platform,
        platform_source: platformSource,
        platform_compiler: platformCompiler,
        platform_compiler_available: platformCompilerAvailable,
        ...(platformCompilerSkipped.length > 0 ? { platform_compiler_skipped: platformCompilerSkipped } : {}),
        stdout: result.stdout.slice(0, 3000),
      })
    }

    // ── Insert -i / -d into analysis.conf (deduplicated, positional) ──
    // -i sources (priority order):
    //   1. Scan project directory tree for all dirs containing .h/.hpp headers
    //   2. Source file parent directories (from absSourcePaths)
    //   3. User-configured extra_include_dirs (absIncludeDirs)
    // All are deduplicated against entries AUnit already wrote into analysis.conf.
    const analysisConfPath = join(projectRoot, "analysis.conf")
    if (existsSync(analysisConfPath)) {
      // Collect include dirs from project directory scan
      const scannedDirs = collectIncludeDirs(absProjectDir)
      // Add source file parent directories (headers often coexist with sources)
      const srcParentDirs = [...new Set(absSourcePaths.map((p) => dirname(p)))]
      // Merge all include dir sources: scanned → source parents → user config
      const allIncludeDirs = [...scannedDirs, ...srcParentDirs, ...(absIncludeDirs || [])]

      const existing = readFileSync(analysisConfPath, "utf-8")
      const existingLines = existing.split(/\r?\n/)

      // Collect existing -i and -d values for dedup (normalize: strip quotes + trailing slashes)
      const norm = (v: string) => v.replace(/^"|"$/g, "").replace(/[\\/]+$/, "").replace(/\\/g, "/")
      const existingIncludes = new Set<string>()
      const existingDefines = new Set<string>()
      for (const line of existingLines) {
        const mi = line.match(/^-i\s+"?(.+?)"?\s*$/)
        if (mi) { existingIncludes.add(norm(mi[1])); continue }
        const md = line.match(/^-d\s+"?(.+?)"?\s*$/)
        if (md) { existingDefines.add(norm(md[1])); continue }
      }

      // Deduplicate -i: skip dirs already in analysis.conf, also deduplicate among themselves
      const seenI = new Set<string>(existingIncludes)
      const newI: string[] = []
      for (const dir of allIncludeDirs) {
        const key = norm(dir)
        if (!seenI.has(key)) {
          seenI.add(key)
          newI.push(`-i "${dir}"`)
        }
      }
      // Deduplicate -d
      const newD: string[] = []
      if (defines) {
        for (const def of defines) {
          if (!existingDefines.has(norm(def))) newD.push(`-d "${def}"`)
        }
      }

      if (newI.length || newD.length) {
        // Find positional anchors: last -i line, last -d line, first -f line
        let lastIIdx = -1
        let lastDIdx = -1
        let firstFIdx = -1
        for (let i = 0; i < existingLines.length; i++) {
          const l = existingLines[i]
          if (/^-i\s/.test(l)) lastIIdx = i
          if (/^-d\s/.test(l)) lastDIdx = i
          if (firstFIdx === -1 && /^-f\s/.test(l)) firstFIdx = i
        }

        // Insert order in file: sources → -i → -d → -f …
        const result = [...existingLines]
        // Insert -d first (higher index), then -i, so splice indices stay valid
        if (newD.length) {
          const dPos = lastDIdx !== -1
            ? lastDIdx + 1
            : firstFIdx !== -1
              ? firstFIdx
              : result.length
          result.splice(dPos, 0, ...newD)
          if (lastIIdx >= dPos) lastIIdx += newD.length
          if (firstFIdx !== -1 && firstFIdx >= dPos) firstFIdx += newD.length
        }
        if (newI.length) {
          const iPos = lastIIdx !== -1
            ? lastIIdx + 1
            : lastDIdx !== -1
              ? lastDIdx
              : firstFIdx !== -1
                ? firstFIdx
                : result.length
          result.splice(iPos, 0, ...newI)
        }

        writeFileSync(analysisConfPath, result.join("\n"), "utf-8")
      }
    }

    return JSON.stringify({
      status: "success",
      project_name,
      project_root: projectRoot,
      workspace: workspacePath,
      creation_type: effectiveCreationType,
      ...(cdbPath ? { cdb_path: cdbPath } : {}),
      platform,
      platform_source: platformSource,
      platform_compiler: platformCompiler,
      platform_compiler_available: platformCompilerAvailable,
      ...(platformCompilerSkipped.length > 0 ? { platform_compiler_skipped: platformCompilerSkipped } : {}),
      source_paths: absSourcePaths,
      integrity_check: "passed",
      cmd: result.cmd,
      ...(sanitized.length > 0 ? { auto_sanitized: sanitized } : {}),
      stdout: result.stdout.slice(0, 3000),
    })
  },
})
