#!/usr/bin/env bun
/**
 * Matrix Agent — Multi-user Project Manager
 *
 * A lightweight Bun HTTP service that manages OpenCode Web instances
 * for multiple users on a shared Linux server.
 *
 * Features:
 *   - User authentication with session cookies
 *   - Default admin account (admin / 123456)
 *   - Admin can create/delete users and delete projects
 *   - Regular users can only manage their own projects
 *   - OpenCode instances are pre-authenticated via Nginx (no double-login)
 *
 * Supports two deployment modes:
 *   - bare-metal (default): Bun.spawn per instance, sudo nginx reload
 *   - docker (MATRIX_DEPLOY_MODE=docker): Docker API per instance, SIGHUP nginx container
 *
 * Environment variables:
 *   MATRIX_DATA_DIR    — Root directory for project data (default: /data/matrix-projects)
 *   OPENCODE_BIN       — Path to opencode binary (default: /opt/matrix/runtime/opencode)
 *   BUN_BIN            — Path to bun binary (default: /opt/matrix/runtime/bun)
 *   MATRIX_PLUGIN_DIR  — Path to matrix plugin directory (default: /opt/matrix/plugin)
 *   NGINX_CONF_DIR     — Directory for Nginx config fragments (default: /opt/matrix/nginx.d)
 *   MATRIX_RUN_DIR     — Directory for PID files (default: /opt/matrix/run)
 *   MATRIX_PORT        — Port for this manager service (default: 3000)
 *   PORT_RANGE_START   — First port for OpenCode instances (default: 5101). New instances use
 *                        monotonic ports (max allocated + 1), not the lowest free port, so
 *                        deleting a project does not immediately recycle its port — avoids
 *                        OpenCode Web reusing the same origin (host:port) with a stale workspace path.
 *   LLM_BASE_URL       — LLM API base URL (required for opencode.json generation)
 *   LLM_PUBLIC_URL     — Optional; baseURL in opencode.json (browsers must resolve it; default = LLM_BASE_URL)
 *   LLM_BASE_URL_OPENCODE — Optional; LLM URL for OpenCode container env only (overrides localhost rewrite)
 *   LLM_MODEL          — LLM model name (required for opencode.json generation)
 *   LLM_API_KEY        — LLM API key (optional)
 *   MATRIX_PORTAL_PUBLIC_URL — Browser-reachable portal base URL (no trailing slash), e.g. http://192.168.1.10
 *                              Used for opencode.json $schema → /matrix-opencode-schema/config.json (offline Web UI).
 *   MATRIX_OPENCODE_OFFLINE — Set to 0 to allow OpenCode outbound checks. Default: inject OPENCODE_OFFLINE=1 etc.
 *                              into the OpenCode process only (not opencode.json — schema rejects key \"offline\").
 *
 * Docker-mode additional variables:
 *   MATRIX_DEPLOY_MODE — Set to "docker" to enable container management
 *   MATRIX_IMAGE       — Docker image for opencode instances (default: matrix-agent:latest)
 *   MATRIX_NETWORK     — Docker network name (default: matrix_matrix-net)
 *   MATRIX_VOLUME      — Docker volume name for projects (default: matrix_matrix-projects)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, cpSync, rmSync, realpathSync } from "fs"
import { join, basename, extname, dirname, resolve, sep } from "path"
import { execSync, execFileSync } from "child_process"
import { tmpdir } from "os"
import { createHash, randomBytes } from "crypto"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEPLOY_MODE = process.env.MATRIX_DEPLOY_MODE === "docker" ? "docker" : "bare-metal"
const DATA_DIR = process.env.MATRIX_DATA_DIR ?? "/data/matrix-projects"
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "/opt/matrix/runtime/opencode"
const BUN_BIN = process.env.BUN_BIN ?? "/opt/matrix/runtime/bun"
const PLUGIN_DIR = process.env.MATRIX_PLUGIN_DIR ?? "/opt/matrix/plugin"
const NGINX_CONF_DIR = process.env.NGINX_CONF_DIR ?? "/opt/matrix/nginx.d"
const RUN_DIR = process.env.MATRIX_RUN_DIR ?? "/opt/matrix/run"
const MANAGER_PORT = parseInt(process.env.MATRIX_PORT ?? "3000", 10)
const PORT_RANGE_START = parseInt(process.env.PORT_RANGE_START ?? "5101", 10)
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? ""
const LLM_MODEL = process.env.LLM_MODEL ?? ""
const LLM_API_KEY = process.env.LLM_API_KEY ?? ""
/** Optional override for URLs written into opencode.json / OpenCode container env (Docker networking). */
const LLM_BASE_URL_OPENCODE = process.env.LLM_BASE_URL_OPENCODE?.trim() ?? ""
/** Browser + opencode.json baseURL: must be a hostname/IP all clients can resolve (never host.docker.internal). */
const LLM_PUBLIC_URL = process.env.LLM_PUBLIC_URL?.trim() ?? ""

// Docker-mode config
const DOCKER_IMAGE = process.env.MATRIX_IMAGE ?? "matrix-agent:latest"
const DOCKER_NETWORK = process.env.MATRIX_NETWORK ?? "matrix_matrix-net"
const DOCKER_VOLUME = process.env.MATRIX_VOLUME ?? "matrix_matrix-projects"
const DOCKER_VOLUME_TOOLS = process.env.MATRIX_VOLUME_TOOLS ?? "matrix_matrix-tools"
const TOOLS_MOUNT = "/opt/matrix/tools"
const DOCKER_SOCK = "/var/run/docker.sock"

/** Docker network DNS alias opencode.ai → schema-mirror serves https://opencode.ai/config.json (offline). */
const OPENCODE_SCHEMA_MIRROR = process.env.MATRIX_OPENCODE_SCHEMA_MIRROR === "1"
/**
 * Relax TLS verification for the OpenCode process (Bun): set NODE_TLS_REJECT_UNAUTHORIZED=0.
 * Docker Compose always runs opencode-schema-mirror (self-signed `opencode.ai`); OpenCode may still
 * fetch that host even when $schema is stripped — so in docker mode this is independent of
 * MATRIX_OPENCODE_SCHEMA_MIRROR. Bare metal: only when schema mirror is enabled (same env as before).
 * Set MATRIX_OPENCODE_SCHEMA_INSECURE_TLS=0 to enforce TLS verification.
 */
const OPENCODE_ALLOW_INSECURE_TLS =
  process.env.MATRIX_OPENCODE_SCHEMA_INSECURE_TLS === "0"
    ? false
    : DEPLOY_MODE === "docker" || OPENCODE_SCHEMA_MIRROR
const OPENCODE_SCHEMA_CANONICAL_URL = "https://opencode.ai/config.json"
/** Portal HTTP path (matrix-nginx) → opencode-schema-mirror; avoids browser TLS/DNS issues with https://opencode.ai. */
const OPENCODE_SCHEMA_PORTAL_PATH = "/matrix-opencode-schema/config.json"
/**
 * Base URL clients use to open the Matrix portal (no trailing slash), e.g. http://10.0.0.5 or http://host:8080.
 * When set, opencode.json $schema points here so the OpenCode **browser** can load JSON Schema offline.
 */
const MATRIX_PORTAL_PUBLIC_URL = process.env.MATRIX_PORTAL_PUBLIC_URL?.trim().replace(/\/$/, "") ?? ""

/**
 * When true (default), inject OPENCODE_OFFLINE / OPENCODE_DISABLE_* into the OpenCode process env only.
 * Do not write \"offline\" into opencode.json — current OpenCode config schema rejects it (ConfigInvalidError).
 */
const MATRIX_OPENCODE_OFFLINE = process.env.MATRIX_OPENCODE_OFFLINE !== "0"

function shouldIncludeOpencodeJsonSchema(): boolean {
  return Boolean(MATRIX_PORTAL_PUBLIC_URL) || OPENCODE_SCHEMA_MIRROR
}

/** $schema URL: prefer portal HTTP path when MATRIX_PORTAL_PUBLIC_URL is set; else HTTPS (container-side mirror). */
function resolvedOpencodeSchemaUrl(): string {
  if (MATRIX_PORTAL_PUBLIC_URL) {
    return `${MATRIX_PORTAL_PUBLIC_URL}${OPENCODE_SCHEMA_PORTAL_PATH}`
  }
  return OPENCODE_SCHEMA_CANONICAL_URL
}

/** OpenCode Web server block — see https://opencode.ai/docs/web/ */
function mergeOpencodeWebServerConfig(config: Record<string, unknown>): boolean {
  if (DEPLOY_MODE !== "docker") return false
  const want = { hostname: "0.0.0.0", port: 3000, mdns: false as const }
  const cur = config.server as Record<string, unknown> | undefined
  if (
    !cur ||
    cur.hostname !== want.hostname ||
    cur.port !== want.port ||
    cur.mdns !== want.mdns
  ) {
    config.server = { ...want }
    return true
  }
  return false
}

/** Remove legacy/invalid `offline` key from opencode.json (schema does not allow it in shipped OpenCode builds). */
function stripUnsupportedOfflineKey(config: Record<string, unknown>): boolean {
  if ("offline" in config) {
    delete config.offline
    return true
  }
  return false
}

function opencodeOfflineDockerEnv(): string[] {
  if (!MATRIX_OPENCODE_OFFLINE) return []
  return [
    "OPENCODE_OFFLINE=1",
    "OPENCODE_DISABLE_AUTOUPDATE=1",
    "OPENCODE_DISABLE_SHARE=1",
    "OPENCODE_DISABLE_APP_PROXY=1",
  ]
}

// Detect Docker API version at startup (fall back to 1.41)
let DOCKER_API_VER = "1.41"
try {
  const verOut = execFileSync("curl", [
    "-s", "--unix-socket", DOCKER_SOCK, "http://localhost/version",
  ], { encoding: "utf-8", timeout: 5000 })
  const verData = JSON.parse(verOut)
  if (verData.ApiVersion) DOCKER_API_VER = verData.ApiVersion
} catch { /* use default */ }

/**
 * URL written to opencode.json — must work from the **browser** (remote PCs, Linux desktop).
 * Do NOT put host.docker.internal here (often unresolved in browsers → "Unable to connect").
 */
function llmBaseUrlForProjectConfig(): string {
  if (LLM_PUBLIC_URL) return LLM_PUBLIC_URL
  return LLM_BASE_URL.trim()
}

/**
 * Container env only: reach LLM on the Docker host when .env uses localhost.
 * opencode.json uses llmBaseUrlForProjectConfig() instead.
 */
function llmUrlForOpenCodeContainerEnv(): string {
  if (LLM_BASE_URL_OPENCODE) return LLM_BASE_URL_OPENCODE
  const base = LLM_BASE_URL.trim()
  if (!base || DEPLOY_MODE !== "docker") return base
  try {
    const u = new URL(base)
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      u.hostname = "host.docker.internal"
      return u.toString()
    }
  } catch {
    /* ignore */
  }
  return base
}

function needsDockerHostGateway(): boolean {
  return DEPLOY_MODE === "docker" && llmUrlForOpenCodeContainerEnv().includes("host.docker.internal")
}

// ---------------------------------------------------------------------------
// Docker API helper (curl-based, avoids Bun node:http socketPath issues)
// ---------------------------------------------------------------------------

interface DockerApiResult {
  status: number
  data: any
}

function dockerApi(method: string, path: string, body?: unknown): DockerApiResult {
  const args = [
    "-s",
    "--unix-socket", DOCKER_SOCK,
    "-w", "\n%{http_code}",
    "-X", method,
  ]
  if (body) {
    args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body))
  }
  args.push(`http://localhost${path}`)

  try {
    const out = execFileSync("curl", args, { encoding: "utf-8", timeout: 30_000 })
    const lines = out.trimEnd().split("\n")
    const statusStr = lines.pop() ?? "500"
    const status = parseInt(statusStr, 10) || 500
    const bodyStr = lines.join("\n")
    let data: any = {}
    try {
      data = JSON.parse(bodyStr || "{}")
    } catch {
      data = { raw: bodyStr }
    }
    return { status, data }
  } catch (err: any) {
    return { status: 500, data: { error: String(err) } }
  }
}

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

interface UserRecord {
  passwordHash: string
  salt: string
  role: "admin" | "user"
}

const usersFile = join(RUN_DIR, "users.json")
const users = new Map<string, UserRecord>()

function hashPwd(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? randomBytes(16).toString("hex")
  const hash = createHash("sha256").update(s + password).digest("hex")
  return { hash, salt: s }
}

function verifyPwd(password: string, record: UserRecord): boolean {
  return hashPwd(password, record.salt).hash === record.passwordHash
}

function loadUsers(): void {
  if (existsSync(usersFile)) {
    try {
      const data = JSON.parse(readFileSync(usersFile, "utf-8"))
      for (const [name, info] of Object.entries(data)) {
        users.set(name, info as UserRecord)
      }
    } catch { /* corrupted — will recreate default */ }
  }
  if (users.size === 0) {
    const { hash, salt } = hashPwd("123456")
    users.set("admin", { passwordHash: hash, salt, role: "admin" })
    saveUsers()
    console.log("[AUTH] Created default admin user (admin / 123456)")
  }
}

function saveUsers(): void {
  const obj: Record<string, UserRecord> = {}
  for (const [name, info] of users) obj[name] = info
  writeFileSync(usersFile, JSON.stringify(obj, null, 2) + "\n")
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface Session {
  username: string
  role: "admin" | "user"
}

const sessions = new Map<string, Session>()

function createSession(username: string, role: "admin" | "user"): string {
  const token = randomBytes(24).toString("hex")
  sessions.set(token, { username, role })
  return token
}

function getSession(req: Request): Session | null {
  const cookie = req.headers.get("cookie") ?? ""
  const match = cookie.match(/session=([a-f0-9]+)/)
  if (!match) return null
  return sessions.get(match[1]) ?? null
}

function destroySession(req: Request): void {
  const cookie = req.headers.get("cookie") ?? ""
  const match = cookie.match(/session=([a-f0-9]+)/)
  if (match) sessions.delete(match[1])
}

function sessionCookie(token: string): string {
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/`
}

function clearSessionCookie(): string {
  return "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
}

// ---------------------------------------------------------------------------
// State — instance tracking
// ---------------------------------------------------------------------------

interface InstanceInfo {
  port: number
  pid: number | null
  password: string
  containerName?: string
  sourceRoot?: string
  workspaceRoot?: string
}

const instances = new Map<string, InstanceInfo>()
const allocFile = join(RUN_DIR, "port-allocations.json")

function ensureDirs(): void {
  for (const dir of [DATA_DIR, NGINX_CONF_DIR, RUN_DIR]) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadAllocations(): void {
  if (!existsSync(allocFile)) return
  try {
    const data = JSON.parse(readFileSync(allocFile, "utf-8"))
    for (const [key, info] of Object.entries(data)) {
      instances.set(key, { ...(info as InstanceInfo), pid: null })
    }
  } catch { /* corrupted — start fresh */ }
}

function saveAllocations(): void {
  const obj: Record<string, {
    port: number
    password: string
    containerName?: string
    sourceRoot?: string
    workspaceRoot?: string
  }> = {}
  for (const [key, info] of instances) {
    obj[key] = {
      port: info.port,
      password: info.password,
      containerName: info.containerName,
      sourceRoot: info.sourceRoot,
      workspaceRoot: info.workspaceRoot,
    }
  }
  writeFileSync(allocFile, JSON.stringify(obj, null, 2) + "\n")
}

function allocatePort(): number {
  const usedPorts = [...instances.values()].map((i) => i.port)
  if (usedPorts.length === 0) return PORT_RANGE_START
  // Monotonic: do not fill gaps left by deleted projects. Same host:port = same browser
  // storage origin; recycling ports made new projects look like the old workspace path.
  return Math.max(...usedPorts) + 1
}

function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"
  let pwd = ""
  for (let i = 0; i < 8; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)]
  }
  return pwd
}

function instanceKey(user: string, project: string): string {
  return `${user}/${project}`
}

function containerName(user: string, project: string): string {
  return `opencode-${user}-${project}`
}

// ---------------------------------------------------------------------------
// Archive extraction
// ---------------------------------------------------------------------------

const INTERNAL_DIRS = new Set([".matrix", ".opencode", ".config"])
const INTERNAL_FILES = new Set(["opencode.json"])

function detectSourceRoot(projectDir: string): string | undefined {
  const entries = readdirSync(projectDir, { withFileTypes: true })
  const subdirs = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith(".") && !INTERNAL_DIRS.has(e.name),
  )
  if (subdirs.length === 1) {
    return subdirs[0].name
  }
  return undefined
}

function normalizeWorkspaceRoot(root: string | undefined): string | undefined {
  if (!root || root === ".") return "."
  return root
}

function workspaceDirFromRoot(projectDir: string, workspaceRoot: string): string {
  return workspaceRoot === "." ? projectDir : join(projectDir, workspaceRoot)
}

/**
 * Resolve the canonical workspace root for a project.
 *
 * Priority:
 * 1. Previously persisted workspaceRoot
 * 2. Legacy persisted sourceRoot (migration compatibility)
 * 3. Existing .matrix at project root (keep current root-based workflow stable)
 * 4. Freshly detected single source root
 * 5. Fallback to project root
 */
function resolveWorkspaceRoot(
  projectDir: string,
  options: {
    persistedWorkspaceRoot?: string
    persistedSourceRoot?: string
    detectedSourceRoot?: string
  } = {},
): string {
  const persistedWorkspaceRoot = normalizeWorkspaceRoot(options.persistedWorkspaceRoot)
  if (persistedWorkspaceRoot === ".") return "."
  if (persistedWorkspaceRoot && existsSync(join(projectDir, persistedWorkspaceRoot))) {
    return persistedWorkspaceRoot
  }

  const legacySourceRoot = normalizeWorkspaceRoot(options.persistedSourceRoot)
  if (legacySourceRoot === ".") return "."
  if (legacySourceRoot && existsSync(join(projectDir, legacySourceRoot))) {
    return legacySourceRoot
  }

  if (existsSync(join(projectDir, ".matrix"))) {
    return "."
  }

  const detected = options.detectedSourceRoot ?? detectSourceRoot(projectDir)
  if (detected && existsSync(join(projectDir, detected))) {
    return detected
  }

  return "."
}

function persistWorkspaceRoot(user: string, project: string, workspaceRoot: string): void {
  const key = instanceKey(user, project)
  const info = instances.get(key)
  if (!info) return

  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot) ?? "."
  const legacySourceRoot = normalizedWorkspaceRoot === "." ? undefined : normalizedWorkspaceRoot
  let changed = false

  if (info.workspaceRoot !== normalizedWorkspaceRoot) {
    info.workspaceRoot = normalizedWorkspaceRoot
    changed = true
  }
  if (info.sourceRoot !== legacySourceRoot) {
    info.sourceRoot = legacySourceRoot
    changed = true
  }

  if (changed) saveAllocations()
}

function collectMatrixDirs(projectDir: string, currentDir = projectDir, depth = 0): string[] {
  const results: string[] = []
  const matrixDir = join(currentDir, ".matrix")
  if (existsSync(matrixDir)) {
    results.push(matrixDir)
  }

  if (depth >= 4) return results

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(".")) continue
    if (NESTED_ARCHIVE_SKIP_DIRS.has(entry.name)) continue
    results.push(...collectMatrixDirs(projectDir, join(currentDir, entry.name), depth + 1))
  }

  return results
}

function recordWorkspaceSelection(projectDir: string, workDir: string, workspaceRoot: string): void {
  const activeMatrixDir = join(workDir, ".matrix")
  const stateDir = join(activeMatrixDir, "state")
  mkdirSync(stateDir, { recursive: true })

  const inactiveMatrixDirs = collectMatrixDirs(projectDir)
    .filter((dir, index, arr) => arr.indexOf(dir) === index)
    .filter((dir) => dir !== activeMatrixDir)

  const stateFile = join(stateDir, "workspace-root.json")
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        project_dir: projectDir,
        active_work_dir: workDir,
        workspace_root: workspaceRoot,
        active_matrix_dir: activeMatrixDir,
        inactive_matrix_dirs: inactiveMatrixDirs,
        multiple_matrix_dirs_detected: inactiveMatrixDirs.length > 0,
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
      `[MATRIX] Multiple .matrix directories detected under ${projectDir}. ` +
      `Active: ${activeMatrixDir}. Inactive: ${inactiveMatrixDirs.join(", ")}`,
    )
  }
}

const ALLOWED_EXTENSIONS = new Set([".zip", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar", ".rar"])

/** Skip these dirs when searching for nested archives (avoid .git/.matrix noise). */
const NESTED_ARCHIVE_SKIP_DIRS = new Set([".matrix", ".opencode", ".config", ".git", "node_modules"])
const MAX_NESTED_ARCHIVE_PASSES = 64
const MAX_NESTED_ARCHIVE_TOTAL = 500

function getArchiveExtension(filename: string): string | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith(".tar.gz")) return ".tar.gz"
  if (lower.endsWith(".tar.bz2")) return ".tar.bz2"
  for (const ext of [".tbz2", ".zip", ".tgz", ".tar", ".rar"]) {
    if (lower.endsWith(ext)) return ext
  }
  return null
}

const EXTRACT_ZIP_PY = `
import zipfile, os, sys, stat
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as zf:
    for info in zf.infolist():
        # ZIP files from Chinese Windows use GBK; spec default is CP437.
        if info.flag_bits & 0x800:
            out_name = info.filename
        else:
            try:
                out_name = info.filename.encode('cp437').decode('gbk')
            except (UnicodeDecodeError, UnicodeEncodeError):
                out_name = info.filename
        target = os.path.join(dst, out_name)
        if info.is_dir():
            os.makedirs(target, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as f:
                f.write(zf.read(info))
            if info.external_attr >> 16 & 0o111:
                os.chmod(target, os.stat(target).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
`

/** GNU/bsdtar mishandle some UTF-8 / pax paths; Python tarfile matches zip path behavior better. */
const EXTRACT_TAR_PY = `
import tarfile, sys
src, dst = sys.argv[1], sys.argv[2]
with tarfile.open(src, mode="r:*") as tf:
    tf.extractall(path=dst)
`

function extractRarArchive(archivePath: string, destDir: string): void {
  const attempts: [string, string[]][] = [
    ["unrar", ["x", "-o+", archivePath, destDir]],
    ["unrar-free", ["x", "-o+", archivePath, destDir]],
  ]
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: "pipe", timeout: 300_000 })
      return
    } catch {
      /* try next */
    }
  }
  execFileSync("bsdtar", ["xf", archivePath, "-C", destDir], { stdio: "pipe", timeout: 300_000 })
}

function extractArchive(archivePath: string, destDir: string): void {
  const ext = getArchiveExtension(archivePath)
  switch (ext) {
    case ".zip":
      execFileSync("python3", ["-c", EXTRACT_ZIP_PY, archivePath, destDir], { stdio: "pipe", timeout: 300_000 })
      break
    case ".tar.gz":
    case ".tgz":
    case ".tar.bz2":
    case ".tbz2":
    case ".tar":
      execFileSync("python3", ["-c", EXTRACT_TAR_PY, archivePath, destDir], { stdio: "pipe", timeout: 300_000 })
      break
    case ".rar":
      extractRarArchive(archivePath, destDir)
      break
    default:
      throw new Error(`Unsupported archive format: ${archivePath}`)
  }
}

function isPathUnderRoot(candidate: string, rootResolved: string): boolean {
  const c = resolve(candidate)
  return c === rootResolved || c.startsWith(rootResolved + sep)
}

/**
 * Recursively find and extract nested archives under projectRoot (zip / rar / tar.gz / …).
 * Each archive is extracted into its parent directory, then the archive file is removed.
 */
function expandNestedArchives(projectRoot: string): void {
  const rootResolved = realpathSync(projectRoot)
  let totalExtracted = 0
  let pass = 0

  while (pass < MAX_NESTED_ARCHIVE_PASSES) {
    pass++
    const archives = listNestedArchiveFiles(projectRoot, rootResolved)
    if (archives.length === 0) break

    for (const archivePath of archives) {
      if (totalExtracted >= MAX_NESTED_ARCHIVE_TOTAL) {
        throw new Error(`Nested archive limit exceeded (${MAX_NESTED_ARCHIVE_TOTAL} files)`)
      }
      let ar: string
      try {
        ar = realpathSync(archivePath)
      } catch {
        continue
      }
      if (!isPathUnderRoot(ar, rootResolved)) continue
      if (!getArchiveExtension(basename(ar))) continue

      const destDir = dirname(ar)
      if (!isPathUnderRoot(resolve(destDir), rootResolved)) continue

      extractArchive(ar, destDir)
      try {
        unlinkSync(ar)
      } catch {
        /* archive may already be removed or busy */
      }
      totalExtracted++
    }
  }
}

function listNestedArchiveFiles(projectRoot: string, rootResolved: string): string[] {
  const out: string[] = []

  function walk(dir: string): void {
    let dirResolved: string
    try {
      dirResolved = realpathSync(dir)
    } catch {
      return
    }
    if (!isPathUnderRoot(dirResolved, rootResolved)) return

    let entries
    try {
      entries = readdirSync(dirResolved, { withFileTypes: true })
    } catch {
      return
    }

    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue
      const full = join(dirResolved, ent.name)
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".")) continue
        if (NESTED_ARCHIVE_SKIP_DIRS.has(ent.name)) continue
        walk(full)
      } else if (ent.isFile() && getArchiveExtension(ent.name)) {
        out.push(full)
      }
    }
  }

  walk(projectRoot)
  return out.sort((a, b) => a.localeCompare(b))
}

// ---------------------------------------------------------------------------
// Nginx config generation
// ---------------------------------------------------------------------------

function nginxConfPath(user: string, project: string): string {
  return join(NGINX_CONF_DIR, `${user}--${project}.conf`)
}

function writeNginxConf(user: string, project: string, port: number, ocPassword: string): void {
  const basicAuth = Buffer.from(`opencode:${ocPassword}`).toString("base64")

  if (DEPLOY_MODE === "docker") {
    const varName = `upstream_${user.replace(/-/g, "_")}__${project.replace(/-/g, "_")}`
    const conf = `# Auto-generated by matrix-manager for ${user}/${project}
server {
    listen ${port};
    server_name _;
    resolver 127.0.0.11 valid=5s;

    # Hashed OpenCode Web chunks: allow long browser cache so offline mode can use disk cache (see Network tab).
    location ~* \\.(?:js|mjs|css|wasm|woff2?|svg|png|jpg|jpeg|gif|ico|webmanifest|map)$ {
        set $${varName} ${containerName(user, project)};
        proxy_pass http://$${varName}:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization "Basic ${basicAuth}";
        proxy_hide_header Cache-Control;
        add_header Cache-Control "public, max-age=2592000, immutable" always;
        proxy_connect_timeout 10s;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
        proxy_cache off;
    }

    location / {
        set $${varName} ${containerName(user, project)};
        proxy_pass http://$${varName}:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # $host omits port → OpenCode builds wrong API/WS URLs on non-80 ports (timeouts)
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization "Basic ${basicAuth}";
        proxy_connect_timeout 10s;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
        proxy_cache off;
        proxy_next_upstream error timeout http_502 http_503;
        proxy_next_upstream_tries 30;
        proxy_next_upstream_timeout 120s;
        error_page 502 503 504 /matrix-wait.html;
    }

    location = /matrix-wait.html {
        default_type text/html;
        return 200 '<!DOCTYPE html><html><head><meta charset="utf-8"><title>启动中...</title><meta http-equiv="refresh" content="3"><style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;background:#f1f5f9;color:#475569}div{text-align:center}h2{font-size:1.5rem;margin-bottom:.5rem}.spinner{width:40px;height:40px;border:4px solid #e2e8f0;border-top-color:#3b82f6;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 1rem}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div><div class="spinner"></div><h2>OpenCode 正在启动</h2><p>请稍候，页面将自动刷新...</p></div></body></html>';
    }
}
`
    writeFileSync(nginxConfPath(user, project), conf)
  } else {
    const conf = `# Auto-generated by matrix-manager for ${user}/${project}
location /u/${user}/${project}/ {
    proxy_pass http://127.0.0.1:${port}/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization "Basic ${basicAuth}";
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_buffering off;
    proxy_cache off;
}
`
    writeFileSync(nginxConfPath(user, project), conf)
  }
}

function removeNginxConf(user: string, project: string): void {
  const path = nginxConfPath(user, project)
  if (existsSync(path)) unlinkSync(path)
}

function reloadNginx(): void {
  try {
    if (DEPLOY_MODE === "docker") {
      execFileSync("curl", [
        "-s", "--unix-socket", DOCKER_SOCK, "-X", "POST",
        `http://localhost/v${DOCKER_API_VER}/containers/matrix-nginx/kill?signal=SIGHUP`,
      ], { stdio: "pipe", timeout: 5000 })
    } else {
      execSync("sudo /usr/sbin/nginx -s reload", { stdio: "pipe", timeout: 5000 })
    }
  } catch {
    console.warn("[WARN] Failed to reload Nginx — config may be stale")
  }
}

// ---------------------------------------------------------------------------
// Project directory setup
// ---------------------------------------------------------------------------

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function getProjectDir(user: string, project: string): string {
  return join(DATA_DIR, user, project)
}

/**
 * Absolute workspace path for OpenCode Web's `directory` query param — must match the running
 * instance's PWD / OPENCODE_WORKDIR (single path segment style, forward slashes).
 */
function workspaceDirectoryForProject(user: string, project: string): string {
  const projectDir = getProjectDir(user, project)
  const key = instanceKey(user, project)
  const info = instances.get(key)
  const workspaceRoot = resolveWorkspaceRoot(projectDir, {
    persistedWorkspaceRoot: info?.workspaceRoot,
    persistedSourceRoot: info?.sourceRoot,
  })
  const full = workspaceDirFromRoot(projectDir, workspaceRoot)
  return full.split(sep).join("/")
}

/**
 * OpenCode Web client router expects the workspace as a **path segment** (base64 of the absolute
 * directory), e.g. `/{segment}/session`. Using only `?directory=` loads the shell but may not
 * navigate into the project (especially with a clean profile / incognito).
 * Base64url (`+`/`/` → `-`/`_`) keeps a single path segment; **do not strip `=` padding** — decoders
 * often require valid base64 length.
 */
function opencodeWebDirectoryPathSegment(workspaceAbsPath: string): string {
  const b64 = Buffer.from(workspaceAbsPath, "utf8").toString("base64")
  return b64.replace(/\+/g, "-").replace(/\//g, "_")
}

/**
 * Normalize opencode.json for air-gap: $schema URL, server.{hostname,port,mdns}, autoupdate: false.
 * OpenCode may rewrite opencode.json after container start — call again on a timer (air-gapped).
 */
function stripOpencodeJsonAirGap(dir: string): void {
  const opencodeConf = join(dir, "opencode.json")
  if (!existsSync(opencodeConf)) return
  try {
    const raw = readFileSync(opencodeConf, "utf-8")
    const config = JSON.parse(raw) as Record<string, unknown>
    let changed = false
    if (shouldIncludeOpencodeJsonSchema()) {
      const want = resolvedOpencodeSchemaUrl()
      if (config.$schema !== want) {
        config.$schema = want
        changed = true
      }
    } else if ("$schema" in config) {
      delete config.$schema
      changed = true
    }
    if (mergeOpencodeWebServerConfig(config)) {
      changed = true
    }
    if (stripUnsupportedOfflineKey(config)) {
      changed = true
    }
    if (config.autoupdate !== false) {
      config.autoupdate = false
      changed = true
    }
    if (changed) {
      writeFileSync(opencodeConf, JSON.stringify(config, null, 2) + "\n")
      console.log(`[CONFIG] Patched opencode.json (air-gap) → ${opencodeConf}`)
    }
  } catch (e) {
    console.warn(`[CONFIG] stripOpencodeJsonAirGap:`, e)
  }
}

/**
 * OpenCode may write `$schema` back on **first browser session** (click「打开」), not only at boot.
 * Schedule strips across several minutes to catch late writes in air-gapped deployments.
 */
function scheduleOpencodeJsonAirGapStrips(workDir: string): void {
  stripOpencodeJsonAirGap(workDir)
  const delays = [2_000, 8_000, 20_000, 45_000, 90_000, 180_000] as const
  for (const ms of delays) {
    setTimeout(() => stripOpencodeJsonAirGap(workDir), ms)
  }
}

/**
 * Ensure the project-level business template directory exists.
 *
 * This is the primary place users are expected to customize templates:
 *   <workDir>/templates/
 *
 * We copy only missing files from the bundled template set so later user edits
 * in the project are never overwritten during subsequent start/re-init flows.
 */
function ensureProjectBusinessTemplates(dir: string): void {
  const projectTemplatesDir = join(dir, "templates")
  mkdirSync(projectTemplatesDir, { recursive: true })

  const bundledTemplatesDir = join(PLUGIN_DIR, "templates")
  if (!existsSync(bundledTemplatesDir)) return

  for (const entry of readdirSync(bundledTemplatesDir, { withFileTypes: true })) {
    const src = join(bundledTemplatesDir, entry.name)
    const dest = join(projectTemplatesDir, entry.name)
    if (existsSync(dest)) continue
    cpSync(src, dest, { recursive: entry.isDirectory() })
  }
}

function ensureProjectConfigs(dir: string): void {
  ensureProjectBusinessTemplates(dir)

  const matrixDir = join(dir, ".matrix", "config")
  const matrixConf = join(matrixDir, "matrix.jsonc")
  if (!existsSync(matrixConf)) {
    mkdirSync(matrixDir, { recursive: true })
    writeFileSync(
      matrixConf,
      JSON.stringify(
        {
          standard: "gjb5000a",
          coverage_target: "statement",
          coverage_target_percentage: 90,
          output_language: "zh-CN",
          auto_advance: true,
        },
        null,
        2,
      ) + "\n",
    )
  }

  const opencodeConf = join(dir, "opencode.json")
  const llmUrl = llmBaseUrlForProjectConfig()

  if (existsSync(opencodeConf)) {
    try {
      const raw = readFileSync(opencodeConf, "utf-8")
      const config = JSON.parse(raw) as Record<string, unknown>
      let changed = false
      if (shouldIncludeOpencodeJsonSchema()) {
        const want = resolvedOpencodeSchemaUrl()
        if (config.$schema !== want) {
          config.$schema = want
          changed = true
        }
      } else if ("$schema" in config) {
        delete config.$schema
        changed = true
      }
      if (mergeOpencodeWebServerConfig(config)) {
        changed = true
      }
      if (stripUnsupportedOfflineKey(config)) {
        changed = true
      }
      if (config.autoupdate !== false) {
        config.autoupdate = false
        changed = true
      }
      if (llmUrl && LLM_MODEL) {
        const prov = config.provider as
          | { "private-llm"?: { options?: { baseURL?: string; apiKey?: string } } }
          | undefined
        const opts = prov?.["private-llm"]?.options
        if (opts) {
          if (opts.baseURL !== llmUrl) {
            opts.baseURL = llmUrl
            changed = true
          }
          if (LLM_API_KEY && opts.apiKey !== LLM_API_KEY) {
            opts.apiKey = LLM_API_KEY
            changed = true
          }
        }
      }
      if (changed) {
        writeFileSync(opencodeConf, JSON.stringify(config, null, 2) + "\n")
        console.log(`[CONFIG] Patched opencode.json in ${dir}`)
      }
    } catch (e) {
      console.warn(`[CONFIG] Could not patch opencode.json in ${dir}:`, e)
    }
  } else if (llmUrl && LLM_MODEL) {
    const config = {
      ...(shouldIncludeOpencodeJsonSchema() ? { $schema: resolvedOpencodeSchemaUrl() } : {}),
      ...(DEPLOY_MODE === "docker"
        ? { server: { hostname: "0.0.0.0", port: 3000, mdns: false } }
        : {}),
      autoupdate: false,
      model: `private-llm/${LLM_MODEL}`,
      provider: {
        "private-llm": {
          npm: "@ai-sdk/openai-compatible",
          name: "私有大模型",
          options: {
            baseURL: llmUrl,
            ...(LLM_API_KEY ? { apiKey: LLM_API_KEY } : {}),
          },
          models: {
            [LLM_MODEL]: {
              name: LLM_MODEL,
              tool_call: true,
              limit: { context: 131072, output: 16384 },
            },
          },
        },
      },
    }
    writeFileSync(opencodeConf, JSON.stringify(config, null, 2) + "\n")
  }
}

function ensureProjectDir(user: string, project: string): string {
  const dir = getProjectDir(user, project)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * OpenCode Web uses "/" as project root when the workspace has no `.git`
 * (see anomalyco/opencode#14445, #15719). A fresh `git init` makes the
 * UI and terminal use the real working directory without affecting sources.
 */
function ensureGitWorkspace(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    if (!existsSync(join(dir, ".git"))) {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe", timeout: 60_000 })
    }
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: dir,
        stdio: "pipe",
        timeout: 10_000,
      })
      return
    } catch {
      /* no commits yet — some OpenCode Web builds still treat this like "no repo" and show cwd as / */
    }
    execFileSync(
      "git",
      [
        "-c",
        "user.email=noreply@matrix.local",
        "-c",
        "user.name=Matrix Agent",
        "commit",
        "--allow-empty",
        "-m",
        "matrix: workspace root",
      ],
      { cwd: dir, stdio: "pipe", timeout: 60_000 },
    )
  } catch (e) {
    console.warn(`[GIT] ensureGitWorkspace failed in ${dir}:`, e)
  }
}

function ensurePluginInstalled(projectDir: string): void {
  const legacyPluginDir = join(projectDir, ".config", "opencode", "plugin")
  const legacyPluginsDir = join(projectDir, ".config", "opencode", "plugins")
  const legacyOpencodeDir = join(projectDir, ".config", "opencode")
  const projectPluginDir = join(projectDir, ".opencode", "plugin")
  const projectPluginsDir = join(projectDir, ".opencode", "plugins")
  const projectOpencodeDir = join(projectDir, ".opencode")
  const pluginDirs = [
    legacyPluginDir,
    legacyPluginsDir,
    projectPluginDir,
    projectPluginsDir,
  ]

  for (const dir of pluginDirs) {
    mkdirSync(dir, { recursive: true })
  }

  const pluginDist = join(PLUGIN_DIR, "dist", "index.js")
  for (const pluginDir of pluginDirs) {
    const pluginDest = join(pluginDir, "matrix.js")
    if (existsSync(pluginDist) && !existsSync(pluginDest)) {
      try {
        execSync(`ln -sf "${pluginDist}" "${pluginDest}"`, { stdio: "pipe" })
      } catch {
        cpSync(pluginDist, pluginDest)
      }
    }

  }

  const assetDirs = ["skills", "templates", "standards", "bin"]
  for (const opencodeDir of [legacyOpencodeDir, projectOpencodeDir]) {
    for (const dir of assetDirs) {
      const src = join(PLUGIN_DIR, dir)
      const dest = join(opencodeDir, dir)
      if (existsSync(src) && !existsSync(dest)) {
        try {
          execSync(`ln -sf "${src}" "${dest}"`, { stdio: "pipe" })
        } catch {
          cpSync(src, dest, { recursive: true })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Docker-mode instance management
// ---------------------------------------------------------------------------

const TOOL_ENV_MAP: Record<string, { envVar: string; hasBin: boolean }> = {
  specchecker: { envVar: "SPECCHECKER_HOME", hasBin: false },
  aunit:       { envVar: "AUNIT_HOME",       hasBin: false },
  "joern-cli": { envVar: "JOERN_HOME",       hasBin: true },
  z3:          { envVar: "Z3_HOME",           hasBin: true },
  jdk:         { envVar: "JAVA_HOME",         hasBin: true },
}

function discoverToolsEnv(): string[] {
  const toolsDir = process.env.MATRIX_TOOLS_DIR ?? TOOLS_MOUNT
  const envVars: string[] = []
  const pathDirs: string[] = []

  for (const [dir, cfg] of Object.entries(TOOL_ENV_MAP)) {
    const toolPath = join(toolsDir, dir)
    if (existsSync(toolPath)) {
      envVars.push(`${cfg.envVar}=${join(TOOLS_MOUNT, dir)}`)
      if (cfg.hasBin) pathDirs.push(join(TOOLS_MOUNT, dir, "bin"))
    }
  }

  if (pathDirs.length > 0) {
    envVars.push(`PATH=${pathDirs.join(":")}:/opt/matrix/runtime:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)
  }

  return envVars
}

function isContainerRunning(name: string): boolean {
  try {
    const res = dockerApi("GET", `/v${DOCKER_API_VER}/containers/${name}/json`)
    return res.status === 200 && res.data?.State?.Running === true
  } catch {
    return false
  }
}

function startInstanceDocker(user: string, project: string): InstanceInfo {
  const key = instanceKey(user, project)
  const existing = instances.get(key)
  const name = containerName(user, project)

  const projectDir = ensureProjectDir(user, project)
  const port = existing?.port ?? allocatePort()
  const password = existing?.password ?? generatePassword()
  const workspaceRoot = resolveWorkspaceRoot(projectDir, {
    persistedWorkspaceRoot: existing?.workspaceRoot,
    persistedSourceRoot: existing?.sourceRoot,
  })
  const projectWorkDir = workspaceRoot === "."
    ? `/data/matrix-projects/${user}/${project}`
    : `/data/matrix-projects/${user}/${project}/${workspaceRoot}`

  const actualWorkDir = workspaceDirFromRoot(projectDir, workspaceRoot)
  ensureProjectConfigs(actualWorkDir)
  ensureGitWorkspace(actualWorkDir)
  ensurePluginInstalled(actualWorkDir)
  recordWorkspaceSelection(projectDir, actualWorkDir, workspaceRoot)

  // Always recreate: a short-circuit return when the container was already running skipped the
  // steps above and left OpenCode Web on an old process that still resolved the workspace as "/".
  dockerApi("DELETE", `/v${DOCKER_API_VER}/containers/${name}?force=true`)

  const llmForContainer = llmUrlForOpenCodeContainerEnv()
  const createBody = {
    Image: DOCKER_IMAGE,
    Cmd: [
      "/bin/sh",
      "-lc",
      'cd "$OPENCODE_WORKDIR" && exec /opt/matrix/runtime/opencode web --hostname 0.0.0.0 --port 3000',
    ],
    WorkingDir: projectWorkDir,
    Env: [
      `HOME=${projectWorkDir}`,
      `PWD=${projectWorkDir}`,
      `OPENCODE_WORKDIR=${projectWorkDir}`,
      `OPENCODE_SERVER_PASSWORD=${password}`,
      ...(llmForContainer ? [`LLM_BASE_URL=${llmForContainer}`] : []),
      ...(LLM_MODEL ? [`LLM_MODEL=${LLM_MODEL}`] : []),
      ...(LLM_API_KEY ? [`LLM_API_KEY=${LLM_API_KEY}`] : []),
      ...(OPENCODE_ALLOW_INSECURE_TLS ? [`NODE_TLS_REJECT_UNAUTHORIZED=0`] : []),
      ...opencodeOfflineDockerEnv(),
      ...discoverToolsEnv(),
    ],
    HostConfig: {
      Memory: 4 * 1024 * 1024 * 1024,
      NanoCPUs: 2_000_000_000,
      Binds: [
        `${DOCKER_VOLUME}:/data/matrix-projects`,
        `${DOCKER_VOLUME_TOOLS}:${TOOLS_MOUNT}:ro`,
      ],
      NetworkMode: DOCKER_NETWORK,
      ...(needsDockerHostGateway() ? { ExtraHosts: ["host.docker.internal:host-gateway"] } : {}),
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [DOCKER_NETWORK]: {},
      },
    },
  }

  const createRes = dockerApi(
    "POST",
    `/v${DOCKER_API_VER}/containers/create?name=${encodeURIComponent(name)}`,
    createBody,
  )

  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`Failed to create container: ${JSON.stringify(createRes.data)}`)
  }

  const startRes = dockerApi("POST", `/v${DOCKER_API_VER}/containers/${name}/start`)
  if (startRes.status !== 204 && startRes.status !== 304) {
    throw new Error(`Failed to start container: ${JSON.stringify(startRes.data)}`)
  }

  const info: InstanceInfo = {
    port,
    pid: null,
    password,
    containerName: name,
    sourceRoot: workspaceRoot === "." ? undefined : workspaceRoot,
    workspaceRoot,
  }
  instances.set(key, info)
  saveAllocations()

  writeNginxConf(user, project, port, password)
  reloadNginx()

  scheduleOpencodeJsonAirGapStrips(actualWorkDir)

  console.log(`[DOCKER] Started container ${name} for ${key} (workDir: ${projectWorkDir})`)
  return info
}

function stopInstanceDocker(user: string, project: string): boolean {
  const key = instanceKey(user, project)
  const info = instances.get(key)
  if (!info) return false

  const name = containerName(user, project)
  dockerApi("POST", `/v${DOCKER_API_VER}/containers/${name}/stop?t=10`)
  dockerApi("DELETE", `/v${DOCKER_API_VER}/containers/${name}?force=true`)

  removeNginxConf(user, project)
  reloadNginx()

  console.log(`[DOCKER] Stopped and removed container ${name} for ${key}`)
  return true
}

function getInstanceStatusDocker(user: string, project: string): "running" | "stopped" | "not_found" {
  const key = instanceKey(user, project)
  const info = instances.get(key)
  if (!info) return "not_found"

  const name = containerName(user, project)
  if (isContainerRunning(name)) return "running"
  return "stopped"
}

// ---------------------------------------------------------------------------
// Bare-metal instance management
// ---------------------------------------------------------------------------

function startInstanceBareMetal(user: string, project: string): InstanceInfo {
  const key = instanceKey(user, project)
  const existing = instances.get(key)

  if (existing?.pid && isProcessRunning(existing.pid)) {
    stopInstanceBareMetal(user, project)
  }

  const projectDir = ensureProjectDir(user, project)
  const port = existing?.port ?? allocatePort()
  const password = existing?.password ?? generatePassword()
  const workspaceRoot = resolveWorkspaceRoot(projectDir, {
    persistedWorkspaceRoot: existing?.workspaceRoot,
    persistedSourceRoot: existing?.sourceRoot,
  })
  const workDir = workspaceDirFromRoot(projectDir, workspaceRoot)

  ensureProjectConfigs(workDir)
  ensureGitWorkspace(workDir)
  ensurePluginInstalled(workDir)
  recordWorkspaceSelection(projectDir, workDir, workspaceRoot)

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: workDir,
    OPENCODE_SERVER_PASSWORD: password,
    ...(OPENCODE_ALLOW_INSECURE_TLS ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" } : {}),
    ...(MATRIX_OPENCODE_OFFLINE
      ? {
          OPENCODE_OFFLINE: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_SHARE: "1",
          OPENCODE_DISABLE_APP_PROXY: "1",
        }
      : {}),
  }

  const proc = Bun.spawn(
    [OPENCODE_BIN, "web", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: workDir,
      env,
      stdout: "ignore",
      stderr: "ignore",
    },
  )

  const info: InstanceInfo = {
    port,
    pid: proc.pid,
    password,
    sourceRoot: workspaceRoot === "." ? undefined : workspaceRoot,
    workspaceRoot,
  }
  instances.set(key, info)
  saveAllocations()

  writeFileSync(join(RUN_DIR, `${user}--${project}.pid`), String(proc.pid))

  writeNginxConf(user, project, port, password)
  reloadNginx()

  scheduleOpencodeJsonAirGapStrips(workDir)

  console.log(`[BARE-METAL] Started opencode for ${user}/${project} (workDir: ${workDir})`)
  return info
}

function stopInstanceBareMetal(user: string, project: string): boolean {
  const key = instanceKey(user, project)
  const info = instances.get(key)
  if (!info) return false

  if (info.pid && isProcessRunning(info.pid)) {
    try {
      process.kill(info.pid, "SIGTERM")
    } catch { /* already dead */ }
  }

  info.pid = null

  const pidFile = join(RUN_DIR, `${user}--${project}.pid`)
  if (existsSync(pidFile)) unlinkSync(pidFile)

  removeNginxConf(user, project)
  reloadNginx()

  return true
}

function getInstanceStatusBareMetal(user: string, project: string): "running" | "stopped" | "not_found" {
  const key = instanceKey(user, project)
  const info = instances.get(key)
  if (!info) return "not_found"
  if (info.pid && isProcessRunning(info.pid)) return "running"
  return "stopped"
}

// ---------------------------------------------------------------------------
// Unified interface
// ---------------------------------------------------------------------------

function startInstance(user: string, project: string): InstanceInfo {
  return DEPLOY_MODE === "docker" ? startInstanceDocker(user, project) : startInstanceBareMetal(user, project)
}

function stopInstance(user: string, project: string): boolean {
  return DEPLOY_MODE === "docker" ? stopInstanceDocker(user, project) : stopInstanceBareMetal(user, project)
}

function getInstanceStatus(user: string, project: string): "running" | "stopped" | "not_found" {
  return DEPLOY_MODE === "docker" ? getInstanceStatusDocker(user, project) : getInstanceStatusBareMetal(user, project)
}

function deleteProject(user: string, project: string): void {
  stopInstance(user, project)
  const key = instanceKey(user, project)
  instances.delete(key)
  saveAllocations()

  const dir = getProjectDir(user, project)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Recover previously running instances on startup
// ---------------------------------------------------------------------------

function recoverInstances(): void {
  for (const [key, info] of instances) {
    const [user, project] = key.split("/")
    if (!user || !project) continue

    const projectDir = getProjectDir(user, project)
    if (!existsSync(projectDir)) continue

    if (DEPLOY_MODE === "docker") {
      const name = containerName(user, project)
      if (isContainerRunning(name)) {
        console.log(`[RECOVER] Container ${name} for ${key} is still running`)
        continue
      }
    }

    console.log(`[RECOVER] Restarting ${key}...`)
    try {
      startInstance(user, project)
    } catch (err) {
      console.error(`[RECOVER] Failed to restart ${key}:`, err)
    }
  }
}

// ---------------------------------------------------------------------------
// Project listing
// ---------------------------------------------------------------------------

interface ProjectEntry {
  user: string
  project: string
  status: "running" | "stopped" | "not_found"
  port?: number
  url?: string
  /** Matches container/host workspace; use as OpenCode Web `?directory=` to avoid stale client state. */
  workspaceDirectory: string
}

function listProjects(filterUser?: string): ProjectEntry[] {
  const entries: ProjectEntry[] = []
  if (!existsSync(DATA_DIR)) return entries

  for (const userDirent of readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!userDirent.isDirectory() || userDirent.name.startsWith(".")) continue
    if (filterUser && userDirent.name !== filterUser) continue

    const userDir = join(DATA_DIR, userDirent.name)
    for (const proj of readdirSync(userDir, { withFileTypes: true })) {
      if (!proj.isDirectory() || proj.name.startsWith(".")) continue
      const status = getInstanceStatus(userDirent.name, proj.name)
      const key = instanceKey(userDirent.name, proj.name)
      const info = instances.get(key)
      const workspaceDirectory = workspaceDirectoryForProject(userDirent.name, proj.name)
      entries.push({
        user: userDirent.name,
        project: proj.name,
        status,
        port: info?.port,
        url: status === "running"
          ? (DEPLOY_MODE === "docker" && info?.port
            ? `:${info.port}/`
            : `/u/${userDirent.name}/${proj.name}/`)
          : undefined,
        workspaceDirectory,
      })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

const SHARED_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f1f5f9; color: #1e293b; min-height: 100vh; }
    .navbar { background: #1e293b; color: white; padding: 0 2rem; display: flex; align-items: center; height: 56px; gap: 1.5rem; }
    .navbar h1 { font-size: 1.125rem; font-weight: 600; white-space: nowrap; }
    .navbar .badge { background: #334155; font-size: 0.7rem; padding: 2px 8px; border-radius: 999px; }
    .navbar .spacer { flex: 1; }
    .navbar a { color: #94a3b8; text-decoration: none; font-size: 0.875rem; }
    .navbar a:hover { color: white; }
    .navbar .user-info { color: #cbd5e1; font-size: 0.875rem; }
    .container { max-width: 1100px; margin: 0 auto; padding: 1.5rem 2rem; }
    .card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.625rem 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; }
    th { font-weight: 600; font-size: 0.8rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    td { font-size: 0.9rem; }
    button, .btn { background: #3b82f6; color: white; border: none; padding: 0.375rem 0.875rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; font-weight: 500; display: inline-flex; align-items: center; text-decoration: none; }
    button:hover, .btn:hover { background: #2563eb; }
    .btn-sm { padding: 0.25rem 0.625rem; font-size: 0.75rem; }
    .btn-green { background: #16a34a; }
    .btn-green:hover { background: #15803d; }
    .btn-red { background: #dc2626; }
    .btn-red:hover { background: #b91c1c; }
    .btn-ghost { background: transparent; color: #3b82f6; border: 1px solid #e2e8f0; }
    .btn-ghost:hover { background: #f8fafc; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .form-row { display: flex; gap: 0.75rem; align-items: flex-end; flex-wrap: wrap; }
    .form-group { display: flex; flex-direction: column; gap: 0.25rem; }
    .form-group label { font-size: 0.8rem; font-weight: 500; color: #475569; }
    .form-group input, .form-group select { padding: 0.375rem 0.625rem; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.875rem; }
    .status-running { color: #16a34a; font-weight: 600; }
    .status-stopped { color: #94a3b8; }
    .empty-row { text-align: center; padding: 2rem; color: #94a3b8; }
    .actions { display: flex; gap: 0.5rem; align-items: center; }
    .alert { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.875rem; }
    .alert-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .alert-success { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
`

function renderLoginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix Agent — 登录</title>
  <style>
    ${SHARED_CSS}
    .login-wrapper { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-card { width: 380px; }
    .login-card h2 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .login-card p { font-size: 0.85rem; color: #64748b; margin-bottom: 1.25rem; }
    .login-card .form-group { margin-bottom: 0.75rem; }
    .login-card .form-group input { width: 100%; }
    .login-card button { width: 100%; justify-content: center; padding: 0.5rem; font-size: 0.9rem; margin-top: 0.25rem; }
  </style>
</head>
<body>
  <div class="login-wrapper">
    <div class="card login-card">
      <h2>Matrix Agent</h2>
      <p>嵌入式软件测试多智能体系统</p>
      ${error ? `<div class="alert alert-error">${error}</div>` : ""}
      <form method="POST" action="/login">
        <div class="form-group">
          <label>用户名</label>
          <input name="username" required autocomplete="username" autofocus>
        </div>
        <div class="form-group">
          <label>密码</label>
          <input name="password" type="password" required autocomplete="current-password">
        </div>
        <button type="submit">登 录</button>
      </form>
    </div>
  </div>
</body>
</html>`
}

function renderProjectsPage(session: Session, projects: ProjectEntry[], msg?: string): string {
  const isAdmin = session.role === "admin"

  const rows = projects.map((p) => {
    const statusHtml = p.status === "running"
      ? '<span class="status-running">● 运行中</span>'
      : '<span class="status-stopped">● 已停止</span>'

    // OpenCode Web: router uses /{base64(directory)}/session; ?directory= alone is not always enough
    // to open the workspace (e.g. incognito). Keep both segment + query for API compatibility.
    const dirParam = encodeURIComponent(p.workspaceDirectory)
    const pathSeg = opencodeWebDirectoryPathSegment(p.workspaceDirectory)
    const openLink =
      DEPLOY_MODE === "docker" && p.port
        ? `<a class="btn btn-sm btn-green" href="#" onclick="window.open(location.protocol+'//'+location.hostname+':${p.port}/${pathSeg}/session?directory=${dirParam}','_blank');return false">打开</a>`
        : `<a class="btn btn-sm btn-green" href="/u/${p.user}/${p.project}/${pathSeg}/session?directory=${dirParam}" target="_blank" rel="noopener noreferrer">打开</a>`

    let actions = ""
    if (p.status === "running") {
      actions = `
        ${openLink}
        <form method="POST" action="/projects/${p.user}/${p.project}/stop" style="display:inline">
          <button class="btn-sm btn-ghost" type="submit">停止</button>
        </form>`
    } else {
      actions = `
        <form method="POST" action="/projects/${p.user}/${p.project}/start" style="display:inline">
          <button class="btn-sm btn-green" type="submit">启动</button>
        </form>`
    }

    if (isAdmin) {
      actions += `
        <form method="POST" action="/projects/${p.user}/${p.project}/delete" style="display:inline"
              onsubmit="return confirm('确定删除项目 ${p.user}/${p.project}？此操作不可恢复！')">
          <button class="btn-sm btn-red" type="submit">删除</button>
        </form>`
    }

    const userCol = isAdmin ? `<td>${p.user}</td>` : ""
    return `<tr>
      ${userCol}
      <td>${p.project}</td>
      <td>${statusHtml}</td>
      <td>${p.port ?? "—"}</td>
      <td><div class="actions">${actions}</div></td>
    </tr>`
  }).join("\n")

  const userTh = isAdmin ? "<th>用户</th>" : ""
  const colCount = isAdmin ? 5 : 4

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix Agent — 项目管理</title>
  <style>${SHARED_CSS}</style>
</head>
<body>
  <nav class="navbar">
    <h1>Matrix Agent</h1>
    <span class="badge">${DEPLOY_MODE === "docker" ? "Docker" : "裸机"}</span>
    <span class="spacer"></span>
    ${isAdmin ? '<a href="/admin/users">用户管理</a>' : ""}
    <span class="user-info">${session.username}${isAdmin ? " (管理员)" : ""}</span>
    <a href="#" onclick="document.getElementById('logout-form').submit();return false">退出</a>
    <form id="logout-form" method="POST" action="/logout" style="display:none"></form>
  </nav>
  <div class="container">
    ${msg ? `<div class="alert alert-success">${msg}</div>` : ""}
    <div class="card">
      <form method="POST" action="/projects/create" enctype="multipart/form-data">
        <div class="form-row">
          <div class="form-group">
            <label>项目名称</label>
            <input name="project" required placeholder="my-project" pattern="[a-zA-Z0-9_-]+">
          </div>
          <div class="form-group">
            <label>源码压缩包 <span style="color:#94a3b8;font-weight:400">（可选）</span></label>
            <input type="file" name="archive" accept=".zip,.tar.gz,.tgz,.tar,.rar">
          </div>
          <button type="submit">创建项目</button>
        </div>
      </form>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div style="padding:0.65rem 1rem;font-size:0.8125rem;color:#64748b;border-bottom:1px solid #e2e8f0;line-height:1.45">
        请使用下方「打开」进入<strong>与本项目 OpenCode 相同的工作目录</strong>（即压缩包解压位置；若包内仅有一个顶层源码文件夹会自动进入该文件夹）。不要手动拼网址。
      </div>
      <table>
        <thead>
          <tr>${userTh}<th>项目</th><th>状态</th><th>端口</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="${colCount}" class="empty-row">暂无项目</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`
}

function renderAdminPage(session: Session, msg?: string): string {
  const userRows = [...users.entries()].map(([name, info]) => {
    const isSelf = name === session.username
    const deleteBtn = isSelf
      ? '<span style="color:#94a3b8;font-size:0.8rem">当前用户</span>'
      : `<form method="POST" action="/admin/users/${name}/delete" style="display:inline"
              onsubmit="return confirm('确定删除用户 ${name}？')">
           <button class="btn-sm btn-red" type="submit">删除</button>
         </form>`
    return `<tr>
      <td>${name}</td>
      <td>${info.role === "admin" ? "管理员" : "普通用户"}</td>
      <td>${deleteBtn}</td>
    </tr>`
  }).join("\n")

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix Agent — 用户管理</title>
  <style>${SHARED_CSS}</style>
</head>
<body>
  <nav class="navbar">
    <h1>Matrix Agent</h1>
    <span class="badge">用户管理</span>
    <span class="spacer"></span>
    <a href="/projects">项目管理</a>
    <span class="user-info">${session.username} (管理员)</span>
    <a href="#" onclick="document.getElementById('logout-form').submit();return false">退出</a>
    <form id="logout-form" method="POST" action="/logout" style="display:none"></form>
  </nav>
  <div class="container">
    ${msg ? `<div class="alert alert-success">${msg}</div>` : ""}
    <div class="card">
      <form method="POST" action="/admin/users/create">
        <div class="form-row">
          <div class="form-group">
            <label>用户名</label>
            <input name="username" required placeholder="zhangsan" pattern="[a-zA-Z0-9_-]+">
          </div>
          <div class="form-group">
            <label>密码</label>
            <input name="password" type="password" required placeholder="••••••" minlength="4">
          </div>
          <div class="form-group">
            <label>角色</label>
            <select name="role">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          <button type="submit">创建用户</button>
        </div>
      </form>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>用户名</th><th>角色</th><th>操作</th></tr></thead>
        <tbody>${userRows}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

ensureDirs()
loadUsers()
loadAllocations()

try {
  recoverInstances()
} catch (err) {
  console.error("[RECOVER] Recovery failed:", err)
}

const server = Bun.serve({
  port: MANAGER_PORT,
  hostname: DEPLOY_MODE === "docker" ? "0.0.0.0" : "127.0.0.1",

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // ── Public routes (no auth) ──────────────────────────────────────

    if (path === "/login" && req.method === "GET") {
      const error = url.searchParams.get("error")
      const msg = error === "1" ? "用户名或密码错误" : error === "2" ? "请先登录" : undefined
      return new Response(renderLoginPage(msg), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    if (path === "/login" && req.method === "POST") {
      const form = await req.formData()
      const username = (form.get("username") as string)?.trim() ?? ""
      const password = (form.get("password") as string) ?? ""

      const user = users.get(username)
      if (!user || !verifyPwd(password, user)) {
        return Response.redirect("/login?error=1", 303)
      }

      const token = createSession(username, user.role)
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/projects",
          "Set-Cookie": sessionCookie(token),
        },
      })
    }

    if (path === "/logout" && req.method === "POST") {
      destroySession(req)
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/login",
          "Set-Cookie": clearSessionCookie(),
        },
      })
    }

    // ── Auth check ───────────────────────────────────────────────────

    const session = getSession(req)
    if (!session) {
      if (path === "/api/projects" || (req.headers.get("content-type") ?? "").includes("application/json")) {
        return Response.json({ error: "unauthorized" }, { status: 401 })
      }
      return Response.redirect("/login?error=2", 303)
    }

    const isAdmin = session.role === "admin"

    // ── GET / or /projects — HTML project list ───────────────────────

    if (req.method === "GET" && (path === "/" || path === "/projects" || path === "/projects/")) {
      const projects = listProjects(isAdmin ? undefined : session.username)
      return new Response(renderProjectsPage(session, projects), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    // ── POST /projects/create ────────────────────────────────────────

    if (req.method === "POST" && path === "/projects/create") {
      let project: string
      let archiveFile: File | null = null
      const user = session.username

      const ct = req.headers.get("content-type") ?? ""
      if (ct.includes("application/json")) {
        const body = (await req.json()) as { project?: string }
        project = body.project?.trim() ?? ""
      } else {
        const form = await req.formData()
        project = (form.get("project") as string)?.trim() ?? ""
        const uploaded = form.get("archive")
        if (uploaded instanceof File && uploaded.size > 0) {
          archiveFile = uploaded
        }
      }

      if (!project) {
        return Response.json({ error: "project name is required" }, { status: 400 })
      }

      const nameRe = /^[a-zA-Z0-9_-]+$/
      if (!nameRe.test(project)) {
        return Response.json(
          { error: "project name must be alphanumeric (with - and _ allowed)" },
          { status: 400 },
        )
      }

      if (archiveFile) {
        const ext = getArchiveExtension(archiveFile.name)
        if (!ext) {
          return Response.json(
            { error: `Unsupported archive format. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}` },
            { status: 400 },
          )
        }
      }

      const projectDir = ensureProjectDir(user, project)

      if (archiveFile) {
        const tmpFile = join(tmpdir(), `matrix-upload-${randomBytes(8).toString("hex")}${getArchiveExtension(archiveFile.name)}`)
        try {
          const buf = await archiveFile.arrayBuffer()
          writeFileSync(tmpFile, Buffer.from(buf))
          extractArchive(tmpFile, projectDir)
          expandNestedArchives(projectDir)
        } catch (err: any) {
          try { unlinkSync(tmpFile) } catch {}
          return Response.json(
            { error: `Failed to extract archive: ${err.message ?? String(err)}` },
            { status: 500 },
          )
        }
        try { unlinkSync(tmpFile) } catch {}

        const key = instanceKey(user, project)
        const existing = instances.get(key)
        const detectedSourceRoot = detectSourceRoot(projectDir)
        const workspaceRoot = resolveWorkspaceRoot(projectDir, {
          persistedWorkspaceRoot: existing?.workspaceRoot,
          persistedSourceRoot: existing?.sourceRoot,
          detectedSourceRoot,
        })

        if (existing) {
          existing.workspaceRoot = workspaceRoot
          existing.sourceRoot = workspaceRoot === "." ? undefined : workspaceRoot
        } else {
          instances.set(key, {
            port: allocatePort(),
            pid: null,
            password: generatePassword(),
            sourceRoot: workspaceRoot === "." ? undefined : workspaceRoot,
            workspaceRoot,
          })
        }
        saveAllocations()

        const workDir = workspaceDirFromRoot(projectDir, workspaceRoot)
        ensureProjectConfigs(workDir)
        ensureGitWorkspace(workDir)
        ensurePluginInstalled(workDir)
        recordWorkspaceSelection(projectDir, workDir, workspaceRoot)
        console.log(`[CREATE] Workspace root: ${workspaceRoot} for ${user}/${project}`)
      } else {
        persistWorkspaceRoot(user, project, ".")
        ensureProjectConfigs(projectDir)
        ensureGitWorkspace(projectDir)
        ensurePluginInstalled(projectDir)
        recordWorkspaceSelection(projectDir, projectDir, ".")
      }

      if (ct.includes("application/json")) {
        return Response.json({ ok: true, path: getProjectDir(user, project) })
      }
      return Response.redirect("/projects", 303)
    }

    // ── POST /projects/:user/:proj/start ─────────────────────────────

    const startMatch = path.match(/^\/projects\/([^/]+)\/([^/]+)\/start$/)
    if (req.method === "POST" && startMatch) {
      const [, user, project] = startMatch
      if (!isAdmin && user !== session.username) {
        return Response.json({ error: "forbidden" }, { status: 403 })
      }

      const dir = getProjectDir(user!, project!)
      if (!existsSync(dir)) {
        return Response.json({ error: "project not found" }, { status: 404 })
      }

      try {
        const info = startInstance(user!, project!)
        const ct = req.headers.get("content-type") ?? ""
        if (ct.includes("application/json")) {
          return Response.json({
            ok: true,
            port: info.port,
            url: DEPLOY_MODE === "docker" ? `:${info.port}/` : `/u/${user}/${project}/`,
          })
        }
        return Response.redirect("/projects", 303)
      } catch (err: any) {
        console.error(`[ERROR] Failed to start ${user}/${project}:`, err)
        return Response.json({ error: err.message ?? String(err) }, { status: 500 })
      }
    }

    // ── POST /projects/:user/:proj/stop ──────────────────────────────

    const stopMatch = path.match(/^\/projects\/([^/]+)\/([^/]+)\/stop$/)
    if (req.method === "POST" && stopMatch) {
      const [, user, project] = stopMatch
      if (!isAdmin && user !== session.username) {
        return Response.json({ error: "forbidden" }, { status: 403 })
      }

      stopInstance(user!, project!)

      const ct = req.headers.get("content-type") ?? ""
      if (ct.includes("application/json")) {
        return Response.json({ ok: true })
      }
      return Response.redirect("/projects", 303)
    }

    // ── POST /projects/:user/:proj/delete (admin only) ───────────────

    const deleteMatch = path.match(/^\/projects\/([^/]+)\/([^/]+)\/delete$/)
    if (req.method === "POST" && deleteMatch) {
      if (!isAdmin) {
        return Response.json({ error: "admin only" }, { status: 403 })
      }

      const [, user, project] = deleteMatch
      try {
        deleteProject(user!, project!)
        console.log(`[ADMIN] Deleted project ${user}/${project} by ${session.username}`)
      } catch (err: any) {
        console.error(`[ERROR] Failed to delete ${user}/${project}:`, err)
      }

      const ct = req.headers.get("content-type") ?? ""
      if (ct.includes("application/json")) {
        return Response.json({ ok: true })
      }
      return Response.redirect("/projects", 303)
    }

    // ── GET /projects/:user/:proj/status ─────────────────────────────

    const statusMatch = path.match(/^\/projects\/([^/]+)\/([^/]+)\/status$/)
    if (req.method === "GET" && statusMatch) {
      const [, user, project] = statusMatch
      if (!isAdmin && user !== session.username) {
        return Response.json({ error: "forbidden" }, { status: 403 })
      }
      const status = getInstanceStatus(user!, project!)
      const info = instances.get(instanceKey(user!, project!))
      return Response.json({ status, port: info?.port })
    }

    // ── API: GET /api/projects ───────────────────────────────────────

    if (req.method === "GET" && path === "/api/projects") {
      return Response.json(listProjects(isAdmin ? undefined : session.username))
    }

    // ── Admin: GET /admin/users ──────────────────────────────────────

    if (req.method === "GET" && (path === "/admin/users" || path === "/admin/users/")) {
      if (!isAdmin) return Response.redirect("/projects", 303)
      return new Response(renderAdminPage(session), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    // ── Admin: POST /admin/users/create ──────────────────────────────

    if (req.method === "POST" && path === "/admin/users/create") {
      if (!isAdmin) return Response.json({ error: "admin only" }, { status: 403 })

      const form = await req.formData()
      const username = (form.get("username") as string)?.trim() ?? ""
      const password = (form.get("password") as string) ?? ""
      const role = (form.get("role") as string) === "admin" ? "admin" : "user" as const

      if (!username || !password) {
        return Response.json({ error: "username and password are required" }, { status: 400 })
      }

      const nameRe = /^[a-zA-Z0-9_-]+$/
      if (!nameRe.test(username)) {
        return Response.json({ error: "username must be alphanumeric" }, { status: 400 })
      }

      if (users.has(username)) {
        return Response.json({ error: "user already exists" }, { status: 409 })
      }

      const { hash, salt } = hashPwd(password)
      users.set(username, { passwordHash: hash, salt, role })
      saveUsers()
      console.log(`[ADMIN] Created user ${username} (${role}) by ${session.username}`)

      return Response.redirect("/admin/users", 303)
    }

    // ── Admin: POST /admin/users/:name/delete ────────────────────────

    const userDeleteMatch = path.match(/^\/admin\/users\/([^/]+)\/delete$/)
    if (req.method === "POST" && userDeleteMatch) {
      if (!isAdmin) return Response.json({ error: "admin only" }, { status: 403 })

      const targetUser = userDeleteMatch[1]!
      if (targetUser === session.username) {
        return Response.json({ error: "cannot delete yourself" }, { status: 400 })
      }

      if (!users.has(targetUser)) {
        return Response.json({ error: "user not found" }, { status: 404 })
      }

      users.delete(targetUser)
      saveUsers()

      // Invalidate all sessions for this user
      for (const [token, s] of sessions) {
        if (s.username === targetUser) sessions.delete(token)
      }

      console.log(`[ADMIN] Deleted user ${targetUser} by ${session.username}`)
      return Response.redirect("/admin/users", 303)
    }

    return new Response("Not Found", { status: 404 })
  },
  maxRequestBodySize: 2 * 1024 * 1024 * 1024,
})

console.log(`[matrix-manager] Deploy mode: ${DEPLOY_MODE}`)
console.log(`[matrix-manager] Listening on http://${DEPLOY_MODE === "docker" ? "0.0.0.0" : "127.0.0.1"}:${server.port}`)
console.log(`[matrix-manager] Data directory: ${DATA_DIR}`)
console.log(`[matrix-manager] Nginx config directory: ${NGINX_CONF_DIR}`)
if (DEPLOY_MODE === "docker") {
  console.log(`[matrix-manager] Docker image: ${DOCKER_IMAGE}`)
  console.log(`[matrix-manager] Docker network: ${DOCKER_NETWORK}`)
  try {
    const u = new URL(LLM_BASE_URL)
    if ((u.hostname === "localhost" || u.hostname === "127.0.0.1") && !LLM_PUBLIC_URL) {
      console.warn(
        "[matrix-manager] LLM_BASE_URL 为 localhost：浏览器与容器内 OpenCode 通常无法访问宿主机大模型。请改为内网 IP（推荐）或设置 LLM_PUBLIC_URL 指向可从浏览器访问的地址。",
      )
    }
  } catch {
    /* invalid or empty LLM_BASE_URL */
  }
}
