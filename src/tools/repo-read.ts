import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "fs"
import { isAbsolute, join, normalize } from "path"

function normalizeWindowsLikePath(inputPath: string): string {
  if (!inputPath) return inputPath
  const trimmed = inputPath.trim()
  const withoutLeadingSlash = trimmed.replace(/^\/([A-Za-z]:[\\/])/, "$1")
  return withoutLeadingSlash.replace(/\\/g, "/")
}

function resolveRepoPath(inputPath: string): string {
  const normalizedInput = normalizeWindowsLikePath(inputPath)
  const candidate = isAbsolute(normalizedInput)
    ? normalizedInput
    : join(process.cwd(), normalizedInput)
  return normalize(candidate)
}

function formatLineWindow(
  content: string,
  offset?: number,
  limit?: number,
): { rendered: string; startLine: number; endLine: number; totalLines: number } {
  const lines = content.split(/\r?\n/)
  const totalLines = lines.length

  const startLine = Math.max(1, Number.isFinite(offset) ? Math.trunc(offset as number) : 1)
  const requestedLimit = Math.max(1, Number.isFinite(limit) ? Math.trunc(limit as number) : 80)
  const endLine = Math.min(totalLines, startLine + requestedLimit - 1)

  const width = String(endLine).length
  const rendered = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => {
      const lineNumber = String(startLine + index).padStart(width, " ")
      return `${lineNumber} | ${line}`
    })
    .join("\n")

  return { rendered, startLine, endLine, totalLines }
}

export const repoRead: ToolDefinition = tool({
  description:
    "Read a repository file using workspace-relative or absolute paths, with Windows path normalization. " +
    "Use this instead of the built-in read tool when local files may be reported as /D:/... on Windows. " +
    "Do not use this for predefined Matrix schema JSON/JSONL/TXT artifacts; use matrix_artifact_query instead. " +
    "Only fall back to repo_read for unstructured files without a predefined artifact schema.",
  args: {
    path: tool.schema
      .string()
      .describe(
        "Repository-relative path like .matrix/plans/wiki-generation-plan.json or Int_RT1553.c, " +
          "or an absolute path such as D:/tests/CNAS/2018/Int_RT1553.c. A malformed Windows path like /D:/... is also accepted.",
      ),
    offset: tool.schema
      .number()
      .optional()
      .describe("1-based starting line number. Defaults to 1."),
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum number of lines to return. Defaults to 80."),
  },
  async execute({ path, offset, limit }) {
    const resolvedPath = resolveRepoPath(path)
    if (!existsSync(resolvedPath)) {
      return (
        `Error: File not found\n` +
        `Requested path: ${path}\n` +
        `Resolved path: ${resolvedPath}\n` +
        `Workspace root: ${process.cwd()}`
      )
    }

    const raw = readFileSync(resolvedPath, "utf-8")
    const { rendered, startLine, endLine, totalLines } = formatLineWindow(raw, offset, limit)

    return (
      `Path: ${resolvedPath}\n` +
      `Lines: ${startLine}-${endLine} of ${totalLines}\n\n` +
      rendered
    )
  },
})
