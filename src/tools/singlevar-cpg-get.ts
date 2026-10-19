import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, copyFileSync } from "fs"
import { join, relative } from "path"
import { createHash } from "crypto"
import { execSync } from "child_process"
import { resolveJoernBin, findMatrixRoot } from "./joern-resolve-cli"
import { ensureMatrixDirs } from "../shared/data-store"
import { resolveMatrixWorkspace } from "../shared/workspace-root"

const IS_WINDOWS = process.platform === "win32"

/**
 * singlevar_cpg_get — Returns a CPG path, reusing an existing CPG when source
 * hash matches, otherwise rebuilding via joern-parse.
 *
 * Implements conflict-detector-contracts §1 (CPG sharing) so that
 * singlevar-atomicity-checker, multivar-atomicity-checker, and future conflict
 * detectors share the same CPG file rather than each rebuilding.
 *
 * Output paths follow contract §1.1:
 *   .matrix/data/cpg/<project>.bin
 *   .matrix/data/cpg/<project>.meta.json
 *
 * Reuse rule: if .bin exists AND .meta.json.source_hash matches the current
 * SHA-256 of the source tree, return the existing path without rebuilding.
 */

interface CpgMetadata {
  project_name: string
  source_hash: string
  source_files_count: number
  created_at: string
  created_by: string
  joern_version: string
  cpg_size_bytes: number
}

/** Recursively collect C/C++ source files under a directory */
function collectSourceFiles(dir: string, exts = [".c", ".h", ".cpp", ".hpp", ".cc"]): string[] {
  const out: string[] = []
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(cur)
    } catch {
      continue
    }
    for (const name of entries) {
      const p = join(cur, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        // Skip common build/vcs dirs
        if (name === ".git" || name === "node_modules" || name === ".matrix" || name === "build") continue
        stack.push(p)
      } else if (st.isFile()) {
        const lower = name.toLowerCase()
        if (exts.some((e) => lower.endsWith(e))) out.push(p)
      }
    }
  }
  out.sort()
  return out
}

/** Compute aggregate SHA-256 over the sorted (relpath, sha256) tuples */
function computeSourceHash(rootDir: string, files: string[]): string {
  const total = createHash("sha256")
  for (const f of files) {
    const rel = relative(rootDir, f).replace(/\\/g, "/")
    let buf: Buffer
    try {
      buf = readFileSync(f)
    } catch {
      continue
    }
    const fileHash = createHash("sha256").update(buf).digest("hex")
    total.update(rel)
    total.update("\x00")
    total.update(fileHash)
    total.update("\x00")
  }
  return total.digest("hex")
}

export const singlevarCpgGet: ToolDefinition = tool({
  description:
    "Return a Joern CPG path for the given source directory, reusing an existing CPG when the " +
    "source-tree hash is unchanged, otherwise rebuilding via joern-parse. Implements the CPG " +
    "sharing contract so multiple conflict-detector agents share the same CPG file.",
  args: {
    source_dir: tool.schema
      .string()
      .describe("Absolute path to the C/C++ source directory."),
    project_name: tool.schema
      .string()
      .describe("Project name used as CPG filename prefix."),
    force_rebuild: tool.schema
      .boolean()
      .optional()
      .describe("If true, skip hash check and rebuild unconditionally. Default false."),
  },
  async execute({ source_dir, project_name, force_rebuild }) {
    if (!existsSync(source_dir)) {
      return JSON.stringify({
        status: "error",
        error: `Source directory not found: ${source_dir}`,
      })
    }

    const matrixRoot =
      findMatrixRoot(source_dir) ?? resolveMatrixWorkspace(process.cwd()).workspaceDir
    ensureMatrixDirs(matrixRoot)

    const cpgDir = join(matrixRoot, ".matrix", "data", "cpg")
    if (!existsSync(cpgDir)) {
      mkdirSync(cpgDir, { recursive: true })
    }

    const cpgPath = join(cpgDir, `${project_name}.bin`)
    const metaPath = join(cpgDir, `${project_name}.meta.json`)

    // Compute current source hash
    const files = collectSourceFiles(source_dir)
    const currentHash = computeSourceHash(source_dir, files)

    // Check reuse condition
    if (!force_rebuild && existsSync(cpgPath) && existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as CpgMetadata
        if (meta.source_hash === currentHash) {
          return JSON.stringify({
            status: "reused",
            cpg_path: cpgPath,
            meta_path: metaPath,
            source_hash: currentHash,
            source_files_count: files.length,
            message: `CPG reused (source hash unchanged): ${cpgPath}`,
          })
        }
        // Hash mismatch — archive the stale CPG before rebuilding
        const ts = new Date().toISOString().replace(/[:.]/g, "-")
        const archiveDir = join(matrixRoot, ".matrix", "archive", "cpg", ts)
        mkdirSync(archiveDir, { recursive: true })
        copyFileSync(cpgPath, join(archiveDir, `${project_name}.bin`))
        copyFileSync(metaPath, join(archiveDir, `${project_name}.meta.json`))
      } catch {
        // Fall through to rebuild
      }
    }

    // Rebuild
    const joernParse = resolveJoernBin("joern-parse", matrixRoot)
    const cmd = `${joernParse} "${source_dir}" --output "${cpgPath}"`
    try {
      execSync(cmd, {
        stdio: "pipe",
        timeout: 300_000,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        ...(IS_WINDOWS && { shell: "cmd.exe" }),
      })
      if (!existsSync(cpgPath)) {
        return JSON.stringify({
          status: "error",
          error: "joern-parse completed but CPG file was not created",
        })
      }
    } catch (err: any) {
      return JSON.stringify({
        status: "error",
        error: `joern-parse failed: ${(err.message || String(err)).slice(0, 500)}`,
        stderr: err.stderr ? String(err.stderr).slice(0, 2000) : "",
      })
    }

    // Write metadata
    const meta: CpgMetadata = {
      project_name,
      source_hash: currentHash,
      source_files_count: files.length,
      created_at: new Date().toISOString(),
      created_by: "singlevar_cpg_get",
      joern_version: "unknown", // P0: not parsed yet; future enhancement
      cpg_size_bytes: statSync(cpgPath).size,
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8")

    return JSON.stringify({
      status: "rebuilt",
      cpg_path: cpgPath,
      meta_path: metaPath,
      source_hash: currentHash,
      source_files_count: files.length,
      cpg_size_bytes: meta.cpg_size_bytes,
      message: `CPG rebuilt: ${cpgPath}`,
    })
  },
})
