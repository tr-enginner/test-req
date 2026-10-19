import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { ensureMatrixDirs } from "./data-store"

const INTERNAL_DIRS = new Set([".matrix", ".opencode", ".config", ".git", "node_modules"])
const MAX_DESCENDANT_SCAN_DEPTH = 4

export interface MatrixWorkspaceSelection {
  requestedDir: string
  workspaceDir: string
  resolutionReason: "requested-dir"
  inactiveMatrixDirs: string[]
}

function collectDescendantDirsWithMarker(
  startDir: string,
  markerResolver: (dir: string) => string | null,
  currentDir = resolve(startDir),
  depth = 0,
): string[] {
  const results: string[] = []
  const resolved = markerResolver(currentDir)
  if (resolved) {
    results.push(resolve(resolved))
  }

  if (depth >= MAX_DESCENDANT_SCAN_DEPTH) return results

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(".")) continue
    if (INTERNAL_DIRS.has(entry.name)) continue
    results.push(
      ...collectDescendantDirsWithMarker(
        startDir,
        markerResolver,
        join(currentDir, entry.name),
        depth + 1,
      ),
    )
  }

  return results
}

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths.map((value) => resolve(value)))].sort()
}

function collectMatrixDirs(scopeDir: string): string[] {
  return uniqueSorted(
    collectDescendantDirsWithMarker(scopeDir, (dir) =>
      existsSync(join(dir, ".matrix")) ? join(dir, ".matrix") : null,
    ),
  )
}

export function resolveMatrixWorkspace(requestedDir: string): MatrixWorkspaceSelection {
  const requested = resolve(requestedDir)

  // The explicitly opened OpenCode directory is the only valid Matrix workspace root.
  // Never redirect to ancestor/descendant .matrix directories or persisted workspace state.
  return {
    requestedDir: requested,
    workspaceDir: requested,
    resolutionReason: "requested-dir",
    inactiveMatrixDirs: [],
  }
}

export function ensureMatrixWorkspace(
  requestedDirOrSelection: string | MatrixWorkspaceSelection,
): MatrixWorkspaceSelection {
  const selection =
    typeof requestedDirOrSelection === "string"
      ? resolveMatrixWorkspace(requestedDirOrSelection)
      : requestedDirOrSelection
  ensureMatrixDirs(selection.workspaceDir)

  const scopeDir = selection.requestedDir
  const activeMatrixDir = join(selection.workspaceDir, ".matrix")
  const inactiveMatrixDirs = collectMatrixDirs(scopeDir).filter((dir) => dir !== activeMatrixDir)

  const stateDir = join(activeMatrixDir, "state")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, "workspace-root.json"),
    JSON.stringify(
      {
        requested_dir: selection.requestedDir,
        scope_dir: scopeDir,
        active_work_dir: selection.workspaceDir,
        active_matrix_dir: activeMatrixDir,
        inactive_matrix_dirs: inactiveMatrixDirs,
        multiple_matrix_dirs_detected: inactiveMatrixDirs.length > 0,
        resolution_reason: selection.resolutionReason,
        guidance: inactiveMatrixDirs.length > 0
          ? "当前仅 active_matrix_dir 对应的 .matrix 视为生效目录；其他 .matrix 视为历史残留或独立子项目，请迁移或清理。"
          : "当前项目仅检测到一个生效中的 .matrix 目录。",
      },
      null,
      2,
    ) + "\n",
  )

  if (inactiveMatrixDirs.length > 0) {
    console.warn(
      `[matrix] 检测到多个 .matrix 目录。当前生效目录: ${activeMatrixDir}；其余目录: ${inactiveMatrixDirs.join(", ")}`,
    )
  }

  return {
    ...selection,
    inactiveMatrixDirs,
  }
}

export function prepareMatrixWorkspace(requestedDir: string): MatrixWorkspaceSelection {
  return ensureMatrixWorkspace(requestedDir)
}
