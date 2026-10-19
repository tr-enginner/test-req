/**
 * preflight_check — Stateful per-file compilation verification tool.
 *
 * Drives a state machine: start → (retry | skip)* → all_passed/completed.
 * The agent calls start to begin, then iteratively fixes errors and calls
 * retry to re-check the current file. The tool manages retry counts,
 * unfixable tracking, and automatic file advancement.
 *
 * Used by: StaticAnalyzer agent (Phase 3, Step 0)
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readdirSync, statSync, readFileSync, mkdirSync } from "fs"
import { join, resolve } from "path"
import {
  findClangBinary,
  checkSingleFile,
  buildClangFlags,
  type ClangError,
  type UnfixableFile,
} from "./misra-checker-preflight"

/** Max retry attempts per single source file */
const MAX_ATTEMPTS = 5

const SOURCE_EXTS = new Set([".c", ".cpp", ".cc", ".cxx"])

interface PreflightSession {
  files: string[]
  index: number
  attempt: number
  passed: string[]
  unfixable: UnfixableFile[]
  clangPath: string
  emitDir: string
  specHome: string
  logDir: string | null
}

/** Module-level session — persists across tool invocations within a single runtime */
let session: PreflightSession | null = null

/** Resolve source files from compile_commands.json or directory scan */
function resolveSourceFiles(projectDir: string): string[] {
  // Priority 1: compile_commands.json
  let dir = resolve(projectDir)
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".matrix"))) {
      const dbPath = join(dir, ".matrix", "data", "compile_commands.json")
      if (existsSync(dbPath)) {
        try {
          const db = JSON.parse(readFileSync(dbPath, "utf-8"))
          if (Array.isArray(db)) {
            const files = db.map((e: any) => e.file).filter(Boolean) as string[]
            if (files.length > 0) return files
          }
        } catch { /* fall through */ }
      }
      break
    }
    const parent = resolve(dir, "..")
    if (parent === dir) break
    dir = parent
  }

  // Priority 2: recursive scan
  const files: string[] = []
  function walk(d: string): void {
    let names: string[]
    try { names = readdirSync(d) as string[] } catch { return }
    for (const name of names) {
      const full = join(d, name)
      let st: ReturnType<typeof statSync> | undefined
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (!name.startsWith(".") && name !== "node_modules" && name !== "build" && name !== "dist") {
          walk(full)
        }
      } else if (st.isFile()) {
        const ext = name.slice(name.lastIndexOf(".")).toLowerCase()
        if (SOURCE_EXTS.has(ext)) files.push(full)
      }
    }
  }
  walk(projectDir)
  return files
}

function makeProgress(s: PreflightSession) {
  const checked = s.passed.length + s.unfixable.length
  return {
    checked,
    passed: s.passed.length,
    total: s.files.length,
    unfixable: s.unfixable.map(f => f.file),
    pass_rate: checked > 0 ? s.passed.length / checked : 0,
  }
}

function getFlagStr(s: PreflightSession): string {
  return buildClangFlags(s.emitDir, s.specHome).join(" ")
}

/** Check current file. Returns errors or null if passed. */
function checkCurrentFile(s: PreflightSession): ClangError[] | null {
  const file = s.files[s.index]
  if (!file || !existsSync(file)) return null
  const result = checkSingleFile(s.clangPath, getFlagStr(s), file, s.logDir)
  return result.passed ? null : result.rootCauses
}

/** Advance to next failing file. Returns file_failed result or all_passed. */
function advanceToNextFailing(s: PreflightSession): Record<string, any> {
  while (s.index < s.files.length) {
    const file = s.files[s.index]
    if (!existsSync(file)) {
      s.index++
      continue
    }
    const errors = checkCurrentFile(s)
    if (errors === null) {
      s.passed.push(file)
      s.index++
      continue
    }
    // Found a failing file
    s.attempt = 1
    return {
      status: "file_failed",
      current_file: file,
      attempt: s.attempt,
      max_attempts: MAX_ATTEMPTS,
      errors,
      progress: makeProgress(s),
    }
  }
  // All files processed
  const result = {
    status: "all_passed",
    progress: makeProgress(s),
  }
  session = null
  return result
}

function handleStart(args: Record<string, string>): string {
  const projectDir = args.project_dir
  const emitDir = args.emit_dir
  const specHome = args.spec_home

  if (!projectDir || !emitDir || !specHome) {
    return JSON.stringify({ error: "start requires project_dir, emit_dir, and spec_home" })
  }

  const clangPath = findClangBinary(specHome)
  if (!clangPath) {
    return JSON.stringify({
      error: `clang not found under ${join(specHome, "tools", "clang")}`,
    })
  }

  const files = resolveSourceFiles(projectDir)
  if (files.length === 0) {
    return JSON.stringify({
      status: "all_passed",
      progress: { checked: 0, passed: 0, total: 0, unfixable: [], pass_rate: 0 },
    })
  }

  // Find .matrix/log dir for logging
  let logDir: string | null = null
  let dir = resolve(projectDir)
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".matrix"))) {
      logDir = join(dir, ".matrix", "log")
      break
    }
    const parent = resolve(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  if (logDir) mkdirSync(logDir, { recursive: true })

  session = {
    files,
    index: 0,
    attempt: 1,
    passed: [],
    unfixable: [],
    clangPath,
    emitDir,
    specHome,
    logDir,
  }

  return JSON.stringify(advanceToNextFailing(session))
}

function handleRetry(): string {
  if (!session) {
    return JSON.stringify({ error: "No active preflight session. Call with action='start' first." })
  }

  const s = session
  const file = s.files[s.index]
  const errors = checkCurrentFile(s)

  if (errors === null) {
    // Current file now passes
    s.passed.push(file)
    const fixedFile = file
    s.index++

    const nextResult = advanceToNextFailing(s)
    return JSON.stringify({
      status: "file_passed",
      fixed_file: fixedFile,
      next_status: nextResult.status,
      ...(nextResult.status === "file_failed" ? {
        current_file: nextResult.current_file,
        attempt: nextResult.attempt,
        max_attempts: MAX_ATTEMPTS,
        errors: nextResult.errors,
      } : {}),
      progress: nextResult.progress ?? makeProgress(s),
    })
  }

  // File still fails
  s.attempt++

  if (s.attempt > MAX_ATTEMPTS) {
    // Mark unfixable and advance
    s.unfixable.push({ file, errors })
    const unfixableFile = file
    s.index++

    const nextResult = advanceToNextFailing(s)
    return JSON.stringify({
      status: "file_unfixable",
      unfixable_file: unfixableFile,
      errors,
      next_status: nextResult.status,
      ...(nextResult.status === "file_failed" ? {
        current_file: nextResult.current_file,
        attempt: nextResult.attempt,
        max_attempts: MAX_ATTEMPTS,
        errors: nextResult.errors,
      } : {}),
      progress: nextResult.progress ?? makeProgress(s),
    })
  }

  // Still has attempts left
  return JSON.stringify({
    status: "file_failed",
    current_file: file,
    attempt: s.attempt,
    max_attempts: MAX_ATTEMPTS,
    errors,
    progress: makeProgress(s),
  })
}

function handleSkip(): string {
  if (!session) {
    return JSON.stringify({ error: "No active preflight session. Call with action='start' first." })
  }

  const s = session
  const file = s.files[s.index]

  // Check one last time to record errors
  const errors = checkCurrentFile(s) ?? []
  s.unfixable.push({ file, errors })
  const unfixableFile = file
  s.index++

  const nextResult = advanceToNextFailing(s)
  return JSON.stringify({
    status: "file_unfixable",
    unfixable_file: unfixableFile,
    errors,
    next_status: nextResult.status,
    ...(nextResult.status === "file_failed" ? {
      current_file: nextResult.current_file,
      attempt: nextResult.attempt,
      max_attempts: MAX_ATTEMPTS,
      errors: nextResult.errors,
    } : {}),
    progress: nextResult.progress ?? makeProgress(s),
  })
}

function handleStatus(): string {
  if (!session) {
    return JSON.stringify({
      error: "No active preflight session.",
      completed: true,
    })
  }

  const s = session
  return JSON.stringify({
    progress: {
      ...makeProgress(s),
    },
    current_file: s.index < s.files.length ? s.files[s.index] : null,
    attempt: s.attempt,
    completed: s.index >= s.files.length,
  })
}

export const preflightChecker: ToolDefinition = tool({
  description:
    "Pre-flight compilation verification with per-file state tracking. " +
    "Checks each source file with clang -fsyntax-only using SpecChecker's compiler config. " +
    "Call with action='start' to begin, then 'retry' after fixing errors, 'skip' to mark " +
    "unfixable, or 'status' to check progress. Maintains retry counts (max 5 per file) " +
    "and automatically advances to the next failing file.",
  args: {
    action: tool.schema
      .string()
      .describe(
        "Action to perform: 'start' (initialize session and scan files), " +
        "'retry' (re-check current file after fix), 'skip' (mark current file unfixable), " +
        "'status' (query progress)",
      ),
    project_dir: tool.schema
      .string()
      .optional()
      .describe("Source code directory (required for action='start')"),
    emit_dir: tool.schema
      .string()
      .optional()
      .describe("SpecChecker emit/unit directory containing compiler.conf and analysis.conf (required for action='start')"),
    spec_home: tool.schema
      .string()
      .optional()
      .describe("SpecChecker installation directory (required for action='start')"),
  },
  async execute({ action, project_dir, emit_dir, spec_home }) {
    switch (action) {
      case "start":
        return handleStart({ project_dir: project_dir ?? "", emit_dir: emit_dir ?? "", spec_home: spec_home ?? "" })
      case "retry":
        return handleRetry()
      case "skip":
        return handleSkip()
      case "status":
        return handleStatus()
      default:
        return JSON.stringify({ error: `Unknown action: ${action}. Use start, retry, skip, or status.` })
    }
  },
})
