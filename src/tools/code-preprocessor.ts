import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, resolve, dirname, relative } from "path"
import { getRulesForDialect, detectDialect } from "./preprocessing/dialect-rules"
import { PREPROCESSED_DIR, DATA_DIR } from "../shared/constants"

/**
 * code_preprocessor — Dialect translation preprocessor.
 *
 * Translates compiler-specific constructs (GCC, ARMCC, IAR, Keil,
 * Green Hills, TI, Wind River) into standard C/C++ so that downstream
 * tools and gcc/clang -E can parse the code.
 *
 * This does NOT perform full macro expansion or include resolution.
 * Full preprocessing is done in Phase 3 by the static analysis tools
 * using gcc/clang -E with the compile_commands.json generated here.
 */
export const codePreprocessor: ToolDefinition = tool({
  description:
    "Translate compiler-specific dialect constructs in C/C++ source files " +
    "into standard C/C++. Handles GCC __attribute__, IAR __root/__no_init, " +
    "Keil __packed/__svc, TI _nassert, Green Hills __ghs_*, Wind River __DCC__, " +
    "inline assembly, and compiler-specific #pragma directives. " +
    "Produces clean source files that can be parsed by standard tools " +
    "and further preprocessed by gcc/clang -E. " +
    "Preserves #line directives for line number mapping back to originals.",
  args: {
    file_path: tool.schema
      .string()
      .describe(
        "Path to a C/C++ source file to preprocess, or 'all' to preprocess " +
        "all files listed in compile_commands.json",
      ),
    compile_commands_path: tool.schema
      .string()
      .optional()
      .describe("Path to compile_commands.json (default: .matrix/data/compile_commands.json)"),
    output_dir: tool.schema
      .string()
      .optional()
      .describe("Directory for preprocessed output (default: .matrix/preprocessed/)"),
    keep_comments: tool.schema
      .boolean()
      .optional()
      .describe("Whether to preserve comments in output (default: true)"),
  },
  async execute({
    file_path,
    compile_commands_path,
    output_dir,
    keep_comments = true,
  }) {
    // Determine source files to process
    const filesToProcess: string[] = []
    let projectRoot = ""

    if (file_path === "all") {
      // Load compile_commands.json
      const compdbPath = compile_commands_path
        ? resolve(compile_commands_path)
        : null

      if (!compdbPath || !existsSync(compdbPath)) {
        return JSON.stringify({
          error: "compile_commands.json not found. Run compdb_generator first, or provide compile_commands_path.",
        })
      }

      const compdb = JSON.parse(readFileSync(compdbPath, "utf-8"))
      for (const entry of compdb) {
        if (existsSync(entry.file)) {
          filesToProcess.push(entry.file)
        }
      }
      // Infer project root from compile_commands.json directory
      projectRoot = compdb[0]?.directory || dirname(compdbPath)
    } else {
      const filePath = resolve(file_path)
      if (!existsSync(filePath)) {
        return JSON.stringify({ error: `File not found: ${file_path}` })
      }
      filesToProcess.push(filePath)
      projectRoot = dirname(filePath)
    }

    if (filesToProcess.length === 0) {
      return JSON.stringify({
        error: "No source files to process",
      })
    }

    // Detect dialect from source files
    const sampleContents = filesToProcess.slice(0, 20).map((f) => {
      try { return readFileSync(f, "utf-8") } catch { return "" }
    })
    const dialect = detectDialect(sampleContents)

    // Get translation rules
    const rules = getRulesForDialect(dialect)

    // Set up output directory
    const outDir = output_dir
      ? resolve(output_dir)
      : join(projectRoot, PREPROCESSED_DIR)
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true })
    }

    const results: Array<{
      original_path: string
      preprocessed_path: string
      dialect_translations: number
      warnings: string[]
    }> = []

    const totalStats: Record<string, number> = {}

    for (const srcFile of filesToProcess) {
      const fileWarnings: string[] = []
      let content: string
      try {
        content = readFileSync(srcFile, "utf-8")
      } catch (e) {
        fileWarnings.push(`Failed to read: ${e}`)
        continue
      }

      // Apply dialect translation rules
      let translated = content
      let translationCount = 0

      for (const rule of rules) {
        // Reset regex lastIndex for global patterns
        rule.regex.lastIndex = 0
        const matches = translated.match(rule.regex)
        if (matches && matches.length > 0) {
          translationCount += matches.length
          totalStats[rule.description] = (totalStats[rule.description] || 0) + matches.length
          // Re-create regex to reset state for replacement
          const freshRegex = new RegExp(rule.regex.source, rule.regex.flags)
          translated = translated.replace(freshRegex, rule.replacement)
        }
      }

      // Handle multi-line asm blocks that the simple regex might miss
      translated = removeMultiLineAsm(translated)

      // Add #line directive at the top for line number mapping
      const relPath = relative(projectRoot, srcFile).replace(/\\/g, "/")
      translated = `#line 1 "${relPath}"\n${translated}`

      // Determine output path (preserve relative directory structure)
      const relToProject = relative(projectRoot, srcFile)
      const outPath = join(outDir, relToProject)
      const outFileDir = dirname(outPath)
      if (!existsSync(outFileDir)) {
        mkdirSync(outFileDir, { recursive: true })
      }

      writeFileSync(outPath, translated, "utf-8")

      results.push({
        original_path: srcFile,
        preprocessed_path: outPath,
        dialect_translations: translationCount,
        warnings: fileWarnings,
      })
    }

    return JSON.stringify({
      processed_files: results.length,
      output_dir: outDir,
      files: results,
      dialect_summary: {
        dialect,
        constructs_translated: totalStats,
      },
    }, null, 2)
  },
})

/**
 * Remove multi-line __asm { ... } blocks that may span many lines.
 */
function removeMultiLineAsm(content: string): string {
  const lines = content.split("\n")
  const output: string[] = []
  let inAsmBlock = false
  let braceDepth = 0

  for (const line of lines) {
    if (!inAsmBlock) {
      // Detect start of __asm { block
      if (/\b__asm\s*\{/.test(line)) {
        inAsmBlock = true
        braceDepth = 0
        for (const ch of line) {
          if (ch === "{") braceDepth++
          if (ch === "}") braceDepth--
        }
        output.push("/* asm block removed */")
        if (braceDepth <= 0) {
          inAsmBlock = false
        }
      } else {
        output.push(line)
      }
    } else {
      // Inside asm block, count braces
      for (const ch of line) {
        if (ch === "{") braceDepth++
        if (ch === "}") braceDepth--
      }
      if (braceDepth <= 0) {
        inAsmBlock = false
      }
      // Omit asm lines from output
    }
  }

  return output.join("\n")
}
