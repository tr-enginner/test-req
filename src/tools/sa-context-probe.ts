import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, statSync } from "fs"
import { extname, isAbsolute, relative, resolve } from "path"
import * as jsonc from "jsonc-parser/lib/esm/main.js"
import { MatrixConfigSchema } from "../config/schema"
import { CompilationEnvironment } from "../schema/compilation"
import { SoftwareAnalysisReport } from "../schema/sut"
import { WikiIndex } from "../schema/wiki"
import { ARTIFACT_PATHS } from "../shared/constants"

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/")
}

function resolvePublicContextPath(rawPath: string): { path: string; absolutePath: string } | { error: string } {
  if (isAbsolute(rawPath)) {
    return { error: `Absolute paths are not allowed: ${rawPath}` }
  }

  const absolutePath = resolve(process.cwd(), rawPath)
  const rel = normalizeRelativePath(relative(process.cwd(), absolutePath))
  if (rel.startsWith("../") || rel === "..") {
    return { error: `Path escapes project root: ${rawPath}` }
  }

  return {
    path: rel || ".",
    absolutePath,
  }
}

function truncateText(value: string | undefined, maxLength = 240): string | null {
  if (!value) return null
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`
}

function summarizeJsonValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const sample = value[0]
    return {
      type: "array",
      length: value.length,
      sample_item_type: sample === undefined ? "empty" : Array.isArray(sample) ? "array" : typeof sample,
      sample_item_keys:
        sample && typeof sample === "object" && !Array.isArray(sample)
          ? Object.keys(sample as Record<string, unknown>).slice(0, 12)
          : [],
    }
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    const scalar_fields: Record<string, unknown> = {}
    const array_fields: Array<{ key: string; length: number }> = []
    const object_fields: Array<{ key: string; keys: string[] }> = []

    for (const key of keys.slice(0, 20)) {
      const entry = obj[key]
      if (
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean"
      ) {
        scalar_fields[key] = typeof entry === "string" ? truncateText(entry, 120) : entry
      } else if (Array.isArray(entry)) {
        array_fields.push({ key, length: entry.length })
      } else if (entry && typeof entry === "object") {
        object_fields.push({
          key,
          keys: Object.keys(entry as Record<string, unknown>).slice(0, 12),
        })
      }
    }

    return {
      type: "object",
      total_keys: keys.length,
      keys: keys.slice(0, 20),
      scalar_fields,
      array_fields,
      object_fields,
    }
  }

  return {
    type: value === null ? "null" : typeof value,
    value: value === undefined ? null : truncateText(String(value), 120),
  }
}

function summarizeSoftwareAnalysis(path: string, raw: string) {
  const parsed = SoftwareAnalysisReport.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    return {
      path,
      exists: true,
      valid: false,
      kind: "software_analysis",
      error: parsed.error.message,
    }
  }

  const data = parsed.data
  return {
    path,
    exists: true,
    valid: true,
    kind: "software_analysis",
    summary: {
      project_name: data.project_name ?? null,
      csci_name: data.csci_name ?? null,
      system_name: data.system_name ?? null,
      total_functions: data.summary.total_functions,
      total_requirements: data.summary.total_requirements,
      total_modules: data.modules.length,
      safety_critical_functions: data.summary.safety_critical_functions,
      target_cpu: data.runtime_environment?.target_cpu ?? null,
      programming_language: data.runtime_environment?.programming_language ?? null,
      interrupt_count: data.runtime_environment?.interrupt_table?.length ?? 0,
      main_functions_summary: truncateText(data.main_functions_summary),
    },
  }
}

function summarizeMatrixConfig(path: string, raw: string) {
  const parsed = MatrixConfigSchema.safeParse(jsonc.parse(raw))
  if (!parsed.success) {
    return {
      path,
      exists: true,
      valid: false,
      kind: "matrix_config",
      error: parsed.error.message,
    }
  }

  const data = parsed.data
  return {
    path,
    exists: true,
    valid: true,
    kind: "matrix_config",
    summary: {
      standard: data.standard,
      compiler_dialect: data.compiler_dialect,
      target_cpu: data.target_cpu ?? null,
      target_platform: data.target_platform ?? null,
      coverage_target: data.coverage_target,
      wiki_enabled: data.wiki_enabled,
      aunit_platform: data.aunit_platform ?? null,
    },
  }
}

function summarizeWikiIndex(path: string, raw: string) {
  const parsed = WikiIndex.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    return {
      path,
      exists: true,
      valid: false,
      kind: "wiki_index",
      error: parsed.error.message,
    }
  }

  const data = parsed.data
  return {
    path,
    exists: true,
    valid: true,
    kind: "wiki_index",
    summary: {
      module_count: data.modules.length,
      function_count: Object.keys(data.function_index).length,
      function_index_chunk_count: data.function_index_chunks.length,
      target_cpu: data.tech_stack.target_cpu,
      compiler_dialect: data.tech_stack.compiler_dialect,
      rtos: data.tech_stack.rtos ?? null,
      architecture_pattern: data.architecture.pattern,
    },
  }
}

function summarizeCompilationEnv(path: string, raw: string) {
  const parsed = CompilationEnvironment.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    return {
      path,
      exists: true,
      valid: false,
      kind: "compilation_env",
      error: parsed.error.message,
    }
  }

  const data = parsed.data
  return {
    path,
    exists: true,
    valid: true,
    kind: "compilation_env",
    summary: {
      build_system: data.build_system,
      compiler_dialect: data.compiler_dialect,
      target_cpu: data.target_cpu ?? null,
      files_indexed: data.files_indexed,
      include_dir_count: data.include_dirs.length,
      define_count: data.defines.length,
      missing_header_count: data.missing_headers.length,
      stub_count: data.stubs.length,
    },
  }
}

function summarizeGenericJson(path: string, raw: string, parser: "json" | "jsonc") {
  const parsed = parser === "jsonc" ? jsonc.parse(raw) : JSON.parse(raw)
  return {
    path,
    exists: true,
    valid: true,
    kind: parser === "jsonc" ? "generic_jsonc" : "generic_json",
    summary: summarizeJsonValue(parsed),
  }
}

function summarizeTextFile(path: string, raw: string) {
  return {
    path,
    exists: true,
    valid: true,
    kind: "generic_text",
    summary: {
      line_count: raw.length === 0 ? 0 : raw.split(/\r?\n/).length,
      excerpt: truncateText(raw.replace(/\s+/g, " "), 240),
    },
  }
}

const DEFAULT_STARTUP_PATHS = [
  ARTIFACT_PATHS.SOFTWARE_ANALYSIS,
  ARTIFACT_PATHS.CONFIG,
  ARTIFACT_PATHS.WIKI_INDEX,
]

const KNOWN_SUMMARIZERS: Record<string, (path: string, raw: string) => Record<string, unknown>> = {
  [normalizeRelativePath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS)]: summarizeSoftwareAnalysis,
  [normalizeRelativePath(ARTIFACT_PATHS.CONFIG)]: summarizeMatrixConfig,
  [normalizeRelativePath(ARTIFACT_PATHS.WIKI_INDEX)]: summarizeWikiIndex,
  [normalizeRelativePath(ARTIFACT_PATHS.COMPILATION_ENV)]: summarizeCompilationEnv,
}

/**
 * sa_context_probe — Return compact summaries for shared/public SA-review context files.
 *
 * The SA-Reviewer should use this tool for shared project context artifacts instead of
 * eagerly `read`-ing large `.matrix` JSON/JSONC files into model context. Known files get
 * structured summaries; other public context files get a generic shape summary.
 */
export const saContextProbe: ToolDefinition = tool({
  description:
    "Return compact summaries for shared/public static-analysis review context files. " +
    "If no paths are provided, probes the default startup bundle. Use this instead of " +
    "reading large shared context artifacts directly during SA-reviewer startup.",
  args: {
    paths: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "Relative public context paths to summarize. If omitted, the default startup bundle is used.",
      ),
  },
  async execute(args) {
    const requestedPaths = (args.paths as string[] | undefined)?.length
      ? (args.paths as string[])
      : DEFAULT_STARTUP_PATHS
    const uniquePaths = Array.from(new Set(requestedPaths.map((value) => normalizeRelativePath(value))))

    const result: Record<string, unknown> = {
      project_root: process.cwd(),
      requested_paths: uniquePaths,
      files: [] as Array<Record<string, unknown>>,
    }

    const files = result.files as Array<Record<string, unknown>>

    for (const requestedPath of uniquePaths) {
      const resolved = resolvePublicContextPath(requestedPath)
      if ("error" in resolved) {
        files.push({
          path: requestedPath,
          exists: false,
          valid: false,
          kind: "invalid_path",
          error: resolved.error,
        })
        continue
      }

      const { path, absolutePath } = resolved
      if (!existsSync(absolutePath)) {
        files.push({
          path,
          exists: false,
          valid: false,
          kind: "missing",
        })
        continue
      }

      const stat = statSync(absolutePath)
      try {
        const raw = readFileSync(absolutePath, "utf-8")
        const knownSummarizer = KNOWN_SUMMARIZERS[path]
        const ext = extname(path).toLowerCase()
        const summary = knownSummarizer
          ? knownSummarizer(path, raw)
          : ext === ".json"
            ? summarizeGenericJson(path, raw, "json")
            : ext === ".jsonc"
              ? summarizeGenericJson(path, raw, "jsonc")
              : summarizeTextFile(path, raw)

        files.push({
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
          ...summary,
        })
      } catch (error) {
        files.push({
          path,
          exists: true,
          valid: false,
          kind: "unreadable",
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    result.guidance =
      "Use this tool for shared/public context artifacts such as .matrix analysis reports, config files, " +
      "wiki indexes, compilation summaries, and other shared JSON/JSONC/TEXT context files. Avoid direct read on " +
      "those files unless you need raw text or a field missing from the summary. Reserve read for source files and " +
      "specific per-finding evidence files."

    return JSON.stringify(result)
  },
})
