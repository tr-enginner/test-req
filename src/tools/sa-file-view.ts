import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, statSync } from "fs"
import { extname, isAbsolute, relative, resolve } from "path"

const DEFAULT_CONTEXT_LINES = 15
const DEFAULT_RANGE_LINES = 400
const MAX_RANGE_LINES = 1200
const DEFAULT_MAX_CHARS = 24000
const MAX_MAX_CHARS = 80000

interface FunctionSpan {
  name: string | null
  signature: string
  startLine: number
  endLine: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/")
}

function resolveTargetPath(rawPath: string) {
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(process.cwd(), rawPath)
  const rel = normalizePath(relative(process.cwd(), absolutePath))
  return {
    absolutePath,
    project_relative_path: rel.startsWith("../") || rel === ".." ? null : (rel || "."),
  }
}

function renderLines(lines: string[], startLine: number, maxChars: number) {
  const rendered: string[] = []
  let totalChars = 0
  let truncated = false

  for (let index = 0; index < lines.length; index++) {
    const renderedLine = `${startLine + index}: ${lines[index]}`
    const delta = renderedLine.length + (rendered.length > 0 ? 1 : 0)
    if (rendered.length > 0 && totalChars + delta > maxChars) {
      truncated = true
      break
    }
    rendered.push(renderedLine)
    totalChars += delta
  }

  return {
    content: rendered.join("\n"),
    end_line: rendered.length > 0 ? startLine + rendered.length - 1 : startLine,
    truncated,
  }
}

function buildRangeView(lines: string[], startLine: number, lineCount: number, maxChars: number) {
  const safeStart = clamp(startLine, 1, Math.max(lines.length, 1))
  const safeCount = clamp(lineCount, 1, MAX_RANGE_LINES)
  const sliceStart = safeStart - 1
  const sliceEnd = Math.min(lines.length, sliceStart + safeCount)
  const slice = lines.slice(sliceStart, sliceEnd)
  const rendered = renderLines(slice, safeStart, maxChars)

  return {
    start_line: safeStart,
    end_line: rendered.end_line,
    requested_line_count: safeCount,
    returned_line_count: slice.length,
    truncated:
      rendered.truncated || sliceEnd < lines.length || safeCount < lineCount,
    content: rendered.content,
  }
}

function looksLikeFunctionSignature(signature: string): boolean {
  const compact = signature.replace(/\s+/g, " ").trim()
  if (!compact.includes("(") || !compact.includes(")") || !compact.includes("{")) return false
  if (compact.startsWith("#")) return false
  if (compact.includes("=")) return false
  if (compact.includes(";")) return false
  if (/\b(?:if|for|while|switch|catch|return|sizeof|typedef)\b/.test(compact)) return false

  const nameMatch = compact.match(/([A-Za-z_]\w*)\s*\([^{};]*\)\s*\{$/)
  return Boolean(nameMatch)
}

function extractFunctionName(signature: string): string | null {
  const compact = signature.replace(/\s+/g, " ").trim()
  const match = compact.match(/([A-Za-z_]\w*)\s*\([^{};]*\)\s*\{$/)
  return match ? match[1] : null
}

/**
 * Count brace depth changes in a line, skipping braces inside string
 * literals, char literals, single-line comments, and tracking multi-line
 * comment state across calls.
 */
function countBraces(line: string, inBlockComment: boolean): { delta: number; hasOpen: boolean; inBlockComment: boolean } {
  let delta = 0
  let hasOpen = false
  let inString = false
  let inChar = false
  let inLineComment = false
  let inBlock = inBlockComment

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const next = i + 1 < line.length ? line[i + 1] : ""

    // Skip escaped characters inside strings/chars
    if ((inString || inChar) && ch === "\\") {
      i += 1
      continue
    }

    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        i += 1
      }
      continue
    }

    if (inLineComment) continue

    if (inString) {
      if (ch === '"') inString = false
      continue
    }

    if (inChar) {
      if (ch === "'") inChar = false
      continue
    }

    if (ch === "/" && next === "/") {
      inLineComment = true
      i += 1
      continue
    }

    if (ch === "/" && next === "*") {
      inBlock = true
      i += 1
      continue
    }

    if (ch === '"') { inString = true; continue }
    if (ch === "'") { inChar = true; continue }

    if (ch === "{") { delta += 1; hasOpen = true }
    else if (ch === "}") { delta -= 1 }
  }

  return { delta, hasOpen, inBlockComment: inBlock }
}

function findFunctionSpans(lines: string[]): FunctionSpan[] {
  const spans: FunctionSpan[] = []

  for (let startIndex = 0; startIndex < lines.length; startIndex++) {
    let signature = ""
    let openBraceLine = -1

    for (let endIndex = startIndex; endIndex < Math.min(lines.length, startIndex + 8); endIndex++) {
      const trimmed = lines[endIndex].trim()
      if (!trimmed && signature.length === 0) continue
      signature = signature ? `${signature} ${trimmed}` : trimmed

      if (!signature.includes("{") && trimmed.includes(";")) break
      if (!signature.includes("{")) continue
      if (!looksLikeFunctionSignature(signature)) break

      openBraceLine = endIndex
      break
    }

    if (openBraceLine === -1) continue

    let braceDepth = 0
    let foundOpeningBrace = false
    let endLine = openBraceLine + 1
    let inBlockComment = false

    for (let index = startIndex; index < lines.length; index++) {
      const result = countBraces(lines[index], inBlockComment)
      inBlockComment = result.inBlockComment
      braceDepth += result.delta
      if (result.hasOpen) foundOpeningBrace = true

      if (foundOpeningBrace && braceDepth === 0) {
        endLine = index + 1
        break
      }
    }

    if (!foundOpeningBrace || braceDepth !== 0) continue

    spans.push({
      name: extractFunctionName(signature),
      signature: signature.replace(/\s+/g, " ").trim(),
      startLine: startIndex + 1,
      endLine,
    })
    startIndex = Math.max(startIndex, endLine - 1)
  }

  return spans
}

function findContainingFunction(lines: string[], targetLine: number): FunctionSpan | null {
  const spans = findFunctionSpans(lines)
  return spans.find((span) => targetLine >= span.startLine && targetLine <= span.endLine) ?? null
}

/**
 * sa_file_view - Read SA-review evidence files without interactive permission prompts.
 *
 * Unlike OpenCode's built-in read tool, this plugin-side reader is safe for background
 * page workers because it does not rely on UI permission confirmation. Use it for
 * source files, wiki function/module files, and targeted output artifacts.
 */
export const saFileView: ToolDefinition = tool({
  description:
    "Read static-analysis review evidence files without interactive permission prompts. " +
    "Supports focused line windows, bounded file excerpts, and containing-function extraction " +
    "for source files.",
  args: {
    path: tool.schema
      .string()
      .describe("Absolute or project-relative file path to inspect"),
    line: tool.schema
      .number()
      .optional()
      .describe("Focus line number. If provided, returns a local context window around this line."),
    context_lines: tool.schema
      .number()
      .optional()
      .describe("Context lines on each side of `line` (default: 15, max: 100)"),
    start_line: tool.schema
      .number()
      .optional()
      .describe("Explicit start line for a bounded file excerpt when `line` is not provided"),
    line_count: tool.schema
      .number()
      .optional()
      .describe("Maximum number of lines to return for range/full views (default: 400, max: 1200)"),
    include_containing_function: tool.schema
      .boolean()
      .optional()
      .describe("When `line` is provided, also return the containing function if one can be detected"),
    max_chars: tool.schema
      .number()
      .optional()
      .describe("Character budget for each rendered section (default: 24000, max: 80000)"),
  },
  async execute(args) {
    const requestedPath = String(args.path)
    const targetLine = typeof args.line === "number" ? Math.floor(args.line) : undefined
    const contextLines = clamp(
      typeof args.context_lines === "number" ? Math.floor(args.context_lines) : DEFAULT_CONTEXT_LINES,
      0,
      100,
    )
    const startLine = typeof args.start_line === "number" ? Math.floor(args.start_line) : 1
    const lineCount = clamp(
      typeof args.line_count === "number" ? Math.floor(args.line_count) : DEFAULT_RANGE_LINES,
      1,
      MAX_RANGE_LINES,
    )
    const includeContainingFunction = Boolean(args.include_containing_function)
    const maxChars = clamp(
      typeof args.max_chars === "number" ? Math.floor(args.max_chars) : DEFAULT_MAX_CHARS,
      1000,
      MAX_MAX_CHARS,
    )

    const { absolutePath, project_relative_path } = resolveTargetPath(requestedPath)
    const result: Record<string, unknown> = {
      requested_path: requestedPath,
      resolved_path: absolutePath,
      project_relative_path,
      exists: false,
    }

    if (!existsSync(absolutePath)) {
      result.error = "File not found"
      return JSON.stringify(result, null, 2)
    }

    const stat = statSync(absolutePath)
    if (!stat.isFile()) {
      result.error = "Target is not a regular file"
      return JSON.stringify(result, null, 2)
    }

    const rawBuffer = readFileSync(absolutePath)
    if (rawBuffer.includes(0)) {
      result.exists = true
      result.error = "Binary files are not supported"
      return JSON.stringify(result, null, 2)
    }

    const rawText = rawBuffer.toString("utf-8")
    const lines = rawText.split(/\r?\n/)

    result.exists = true
    result.size_bytes = stat.size
    result.modified_at = stat.mtime.toISOString()
    result.extension = extname(absolutePath).toLowerCase()
    result.total_lines = lines.length

    if (targetLine !== undefined) {
      const focusStart = Math.max(1, targetLine - contextLines)
      const focusEnd = Math.min(lines.length, targetLine + contextLines)
      const focusSlice = lines.slice(focusStart - 1, focusEnd)
      const renderedFocus = renderLines(focusSlice, focusStart, maxChars)

      result.view = {
        mode: "focus",
        focus_line: targetLine,
        start_line: focusStart,
        end_line: renderedFocus.end_line,
        returned_line_count: focusSlice.length,
        truncated: renderedFocus.truncated || renderedFocus.end_line < focusEnd,
        content: renderedFocus.content,
      }

      if (includeContainingFunction) {
        const containingFunction = findContainingFunction(lines, targetLine)
        result.containing_function = containingFunction
          ? {
              name: containingFunction.name,
              signature: containingFunction.signature,
              start_line: containingFunction.startLine,
              end_line: containingFunction.endLine,
              ...(() => {
                const slice = lines.slice(containingFunction.startLine - 1, containingFunction.endLine)
                const rendered = renderLines(slice, containingFunction.startLine, maxChars)
                return {
                  returned_line_count: slice.length,
                  truncated: rendered.truncated || rendered.end_line < containingFunction.endLine,
                  content: rendered.content,
                }
              })(),
            }
          : null
      }
    } else {
      result.view = {
        mode: startLine === 1 && args.start_line === undefined ? "full_excerpt" : "range",
        ...buildRangeView(lines, startLine, lineCount, maxChars),
      }
    }

    result.guidance =
      "Use sa_context_probe for shared/public .matrix context files. Use sa_file_view for targeted evidence " +
      "reads such as source files, wiki function/module files, and concrete output artifacts needed during review."

    return JSON.stringify(result, null, 2)
  },
})
