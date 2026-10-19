import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "fs"
import { join, resolve, relative, isAbsolute } from "path"
import { execSync } from "child_process"
import { PREPROCESSED_DIR } from "../shared/constants"
import { runtimeAssetRoot } from "../shared/runtime-paths"

/** Resolve the bundled ast-grep (sg) binary path (installed by postinstall script) */
function resolveAstGrepBin(): string {
  const pluginRoot = runtimeAssetRoot(import.meta.url)
  const binary = process.platform === "win32" ? "sg.exe" : "sg"
  const binaryPath = join(pluginRoot, "bin", binary)

  if (!existsSync(binaryPath)) {
    throw new Error(
      `ast-grep binary not found at ${binaryPath}. Run "bun install" to download it.`,
    )
  }

  return binaryPath
}

/**
 * Build a mapping from preprocessed file paths back to original file paths
 * by parsing #line directives in the preprocessed files.
 *
 * The code_preprocessor inserts `#line 1 "relative/path.c"` at the top of
 * each preprocessed file. We use this to map results back to the original.
 */
function buildLineMap(
  preprocessedDir: string,
  projectDir: string,
): Map<string, string> {
  const map = new Map<string, string>()

  function scanDir(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as any
    } catch {
      return
    }
    for (const entry of entries as any[]) {
      const fullPath = join(dir, entry.name ?? entry)
      if (typeof entry === "object" && entry.isDirectory?.()) {
        scanDir(fullPath)
      } else if (
        typeof entry === "string"
          ? /\.[ch](pp)?$/i.test(entry)
          : /\.[ch](pp)?$/i.test(entry.name)
      ) {
        try {
          const content = readFileSync(fullPath, "utf-8")
          const firstLine = content.split("\n")[0]
          const match = firstLine.match(/^#line\s+\d+\s+"([^"]+)"/)
          if (match) {
            const originalRel = match[1]
            const originalAbs = isAbsolute(originalRel)
              ? originalRel
              : resolve(projectDir, originalRel)
            // Normalize the preprocessed path for lookup
            const normalizedPP = resolve(fullPath)
            map.set(normalizedPP, originalAbs)
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  scanDir(preprocessedDir)
  return map
}

/**
 * Map a file path from preprocessed dir back to original source, using the
 * #line directive map. Falls back to relative-path substitution if no
 * #line map entry is found.
 */
function mapToOriginal(
  filePath: string,
  lineMap: Map<string, string>,
  preprocessedDir: string,
  projectDir: string,
): string {
  // Try direct map lookup
  const normalized = resolve(filePath)
  const mapped = lineMap.get(normalized)
  if (mapped) return mapped

  // Fallback: replace preprocessedDir prefix with projectDir
  const rel = relative(preprocessedDir, filePath)
  if (!rel.startsWith("..")) {
    return join(projectDir, rel)
  }

  return filePath
}

/**
 * astgrep_run — Execute ast-grep pattern or YAML rule search on a project.
 * Requires the bundled sg binary (installed by postinstall).
 *
 * When use_preprocessed is true (or auto-detected), searches the
 * dialect-translated files in .matrix/preprocessed/ for better parsing
 * accuracy, then maps results back to original source file paths.
 */
export const astgrepRunner: ToolDefinition = tool({
  description:
    "Run ast-grep (AST-level structural code search) on a project directory. " +
    "Supports two modes: 'pattern' for simple pattern matching and 'rule' for " +
    "complex YAML rule-based matching. Uses the bundled sg binary. " +
    "Set use_preprocessed=true (or 'auto') to search dialect-translated files " +
    "in .matrix/preprocessed/ for projects with non-standard C dialects " +
    "(8051/C51, IAR, Keil ARM, etc.), with results mapped back to original paths.",
  args: {
    project_dir: tool.schema
      .string()
      .describe("Project root directory (absolute path)"),
    mode: tool.schema
      .enum(["pattern", "rule"])
      .describe("Search mode: 'pattern' for simple patterns, 'rule' for YAML rules"),
    pattern: tool.schema
      .string()
      .optional()
      .describe(
        "Pattern string for 'pattern' mode (e.g., 'malloc($SIZE)'). Ignored in 'rule' mode.",
      ),
    rule_yaml: tool.schema
      .string()
      .optional()
      .describe(
        "Complete YAML rule content for 'rule' mode. Must be valid ast-grep rule YAML.",
      ),
    lang: tool.schema
      .string()
      .optional()
      .describe(
        "Source language (default: 'c'). Used in 'pattern' mode to set rule language. " +
        "Common values: c, cpp, java, python, typescript, javascript, go, rust.",
      ),
    paths: tool.schema
      .string()
      .optional()
      .describe(
        "Subdirectory to search within project_dir (e.g., 'src' or 'drivers/uart'). " +
        "Defaults to the entire project_dir.",
      ),
    use_preprocessed: tool.schema
      .enum(["auto", "true", "false"])
      .optional()
      .describe(
        "Whether to search preprocessed (dialect-translated) files instead of originals. " +
        "'auto' (default): use preprocessed if .matrix/preprocessed/ exists. " +
        "'true': force use preprocessed (error if not found). " +
        "'false': always search original files.",
      ),
  },
  async execute({ project_dir, mode, pattern, rule_yaml, lang, paths, use_preprocessed }) {
    // Validate args
    if (mode === "pattern" && !pattern) {
      return JSON.stringify({
        error: "pattern is required when mode is 'pattern'",
      })
    }
    if (mode === "rule" && !rule_yaml) {
      return JSON.stringify({
        error: "rule_yaml is required when mode is 'rule'",
      })
    }

    // Locate bundled binary
    let sgBin: string
    try {
      sgBin = resolveAstGrepBin()
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Determine whether to use preprocessed files
    const preprocessedDir = join(project_dir, PREPROCESSED_DIR)
    const preprocessedExists = existsSync(preprocessedDir)
    const ppMode = use_preprocessed || "auto"
    let usePreprocessed = false

    if (ppMode === "true") {
      if (!preprocessedExists) {
        return JSON.stringify({
          error:
            `Preprocessed directory not found at ${preprocessedDir}. ` +
            "Run code_preprocessor first to translate dialect constructs.",
        })
      }
      usePreprocessed = true
    } else if (ppMode === "auto") {
      usePreprocessed = preprocessedExists
    }
    // ppMode === "false" → usePreprocessed stays false

    // Build line map for path mapping if using preprocessed files
    let lineMap: Map<string, string> | null = null
    if (usePreprocessed) {
      lineMap = buildLineMap(preprocessedDir, project_dir)
    }

    // Build temporary rule file in system temp dir
    const ruleId = `matrix_search_${Date.now()}`
    const tmpDir = process.env.TMPDIR || process.env.TEMP || "/tmp"
    const tmpRulePath = join(tmpDir, `${ruleId}.yml`)
    const language = lang || "c"

    try {
      let ruleContent: string
      if (mode === "pattern") {
        ruleContent = [
          `id: ${ruleId}`,
          `language: ${language}`,
          `rule:`,
          `  pattern: ${JSON.stringify(pattern)}`,
        ].join("\n")
      } else {
        ruleContent = rule_yaml!
      }

      writeFileSync(tmpRulePath, ruleContent, "utf-8")

      // Determine search target
      let target: string
      if (usePreprocessed) {
        target = paths ? join(preprocessedDir, paths) : preprocessedDir
      } else {
        target = paths ? join(project_dir, paths) : project_dir
      }

      // Build command
      const cmd = `"${sgBin}" scan --rule "${tmpRulePath}" --json=compact "${target}"`

      let stdout: string
      try {
        stdout = execSync(cmd, {
          stdio: "pipe",
          timeout: 120_000,
          cwd: usePreprocessed ? preprocessedDir : project_dir,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        })
      } catch (err: any) {
        // ast-grep returns exit code 1 when no matches found but stdout may still be valid
        if (err.stdout) {
          stdout = err.stdout
        } else {
          const msg = err.stderr || err.message || String(err)
          return JSON.stringify({ error: `ast-grep execution failed: ${msg}` })
        }
      }

      // Parse JSON output
      const trimmed = stdout!.trim()
      if (!trimmed || trimmed === "[]") {
        return JSON.stringify({
          status: "no_matches",
          total_matches: 0,
          matches: [],
          searched_preprocessed: usePreprocessed,
        })
      }

      let raw: any[]
      try {
        raw = JSON.parse(trimmed)
      } catch {
        return JSON.stringify({
          error: "Failed to parse ast-grep JSON output",
          raw_output: trimmed.slice(0, 2000),
        })
      }

      const matches = raw.map((m: any) => {
        let file = m.file as string
        // Map preprocessed paths back to originals
        if (usePreprocessed && lineMap) {
          file = mapToOriginal(file, lineMap, preprocessedDir, project_dir)
        }

        // Line numbers: subtract 1 if using preprocessed files to account for
        // the injected #line directive at line 0. ast-grep reports 0-based lines.
        const lineOffset = usePreprocessed ? 1 : 0
        const lineStart = (m.range?.start?.line ?? m.start?.line ?? 0) - lineOffset
        const lineEnd = (m.range?.end?.line ?? m.end?.line ?? 0) - lineOffset

        return {
          file,
          line_start: Math.max(0, lineStart),
          line_end: Math.max(0, lineEnd),
          column_start: m.range?.start?.column ?? m.start?.column,
          column_end: m.range?.end?.column ?? m.end?.column,
          matched_text: m.text ?? m.matchedText ?? "",
          meta_variables: m.metaVariables ?? m.env ?? undefined,
        }
      })

      return JSON.stringify({
        status: "success",
        total_matches: matches.length,
        matches,
        searched_preprocessed: usePreprocessed,
      })
    } finally {
      try {
        unlinkSync(tmpRulePath)
      } catch {
        // ignore cleanup errors
      }
    }
  },
})
