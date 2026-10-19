import { existsSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { filldataPhase2Workflow } from "./tools/filldata-phase2-workflow"
import { applyPhase2Editor, applyPhase2InlineBatch, describePhase2Editor, describePhase2InlineEditor, phase2EditorMutationFiles } from "./tools/phase2-editor"

const allowedModes = new Set([
  "finalize_chapter1_scope", "finalize_chapter2_system_overview", "finalize_hardware_interface",
  "finalize_functional_init_content", "finalize_functional_other_content", "finalize_functional_test_content",
  "finalize_performance_test_content", "finalize_interface_test_content", "finalize_reliability_safety_test_content",
  "finalize_margin_test_content", "finalize_boundary_test_content", "finalize_data_processing_test_content",
  "finalize_recovery_test_content", "finalize_strength_test_content", "generate_phase2_traceability", "finalize_phase2_document",
])

type RunnerOptions = { port?: number; root?: string }

function authorized(request: IncomingMessage) {
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  const password = process.env.OPENCODE_SERVER_PASSWORD || ""
  return request.headers.authorization === `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function safeDirectory(value: unknown, root: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error("directory is required")
  const directory = resolve(value), rel = relative(root, directory)
  if (rel.startsWith("..") || resolve(rel) === rel) throw new Error("directory must be inside PROJECTS_ROOT")
  return directory
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {"Content-Type": "application/json; charset=utf-8"})
  response.end(JSON.stringify(value))
}

async function workflow(body: any, root: string) {
  const directory = safeDirectory(body.directory, root), mode = String(body.mode || "")
  if (!allowedModes.has(mode)) throw new Error(`unsupported deterministic mode: ${mode}`)
  const args: any = { mode }
  if (mode === "finalize_hardware_interface") {
    const blockDirectory = resolve(directory, ".matrix/data/hardware-interface-blocks")
    const paths = existsSync(blockDirectory) ? readdirSync(blockDirectory, {withFileTypes: true})
      .filter(entry => entry.isFile() && entry.name.endsWith(".raw.json"))
      .map(entry => join(blockDirectory, entry.name)).sort() : []
    if (paths.length) {
      const mergedOutput = await (filldataPhase2Workflow as any).execute({mode: "merge_hardware_interface_blocks",
        hardware_interface_block_raw_paths: paths}, {directory, worktree: directory})
      const merged = typeof mergedOutput === "string" ? JSON.parse(mergedOutput) : mergedOutput
      if (merged?.ok !== true) throw new Error(merged?.error || "merge_hardware_interface_blocks failed")
    }
  }
  if (mode === "finalize_functional_other_content") {
    const manifestPath = resolve(directory, ".matrix/data/functional-other-content-worker-manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    args.functional_other_content_raw_paths = manifest.functional_other_content_raw_paths
    args.skip_intermediate_report = body.editor_fast_path === true
  }
  const output = await (filldataPhase2Workflow as any).execute(args, { directory, worktree: directory })
  const parsed = typeof output === "string" ? JSON.parse(output) : output
  if (parsed?.ok !== true) throw new Error(parsed?.error || `${mode} failed`)
  return parsed
}

export function createPhase2RunnerServer(options: RunnerOptions = {}) {
  const root = resolve(options.root || process.env.PROJECTS_ROOT || "/data/projects")
  return createServer(async (request, response) => {
    try {
      if (!authorized(request)) {
        response.writeHead(401, {"WWW-Authenticate": "Basic"})
        response.end("Unauthorized")
        return
      }
      const pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname
      if (request.method === "GET" && pathname === "/health") return sendJson(response, 200, {ok: true})
      if (request.method !== "POST") {
        response.writeHead(404)
        response.end("Not found")
        return
      }
      const body: any = await readJsonBody(request)
      body.directory = safeDirectory(body.directory, root)
      if (pathname === "/v1/phase2/workflow/execute") return sendJson(response, 200, await workflow(body, root))
      if (pathname === "/v1/phase2/editor/describe") return sendJson(response, 200, describePhase2Editor(body))
      if (pathname === "/v1/phase2/editor/apply") return sendJson(response, 200, applyPhase2Editor(body))
      if (pathname === "/v1/phase2/editor/inline-describe") return sendJson(response, 200, describePhase2InlineEditor(body.directory))
      if (pathname === "/v1/phase2/editor/mutation-files") return sendJson(response, 200, {ok: true, files: phase2EditorMutationFiles(body)})
      if (pathname === "/v1/phase2/editor/apply-batch") return sendJson(response, 200, applyPhase2InlineBatch(body))
      response.writeHead(404)
      response.end("Not found")
    } catch (error) {
      sendJson(response, 400, {ok: false, error: error instanceof Error ? error.message : String(error)})
    }
  })
}

export function startPhase2Runner(options: RunnerOptions = {}) {
  const port = options.port ?? Number(process.env.MATRIX_PHASE2_RUNNER_PORT || 4097)
  const server = createPhase2RunnerServer(options)
  server.on("error", error => console.error("Matrix Phase 2 deterministic runner server error", error))
  server.listen(port, "0.0.0.0", () => console.log(`Matrix Phase 2 deterministic runner listening on ${port}`))
  process.on("uncaughtExceptionMonitor", error =>
    console.error("Matrix Phase 2 deterministic runner uncaught exception", error))
  process.on("unhandledRejection", reason => {
    console.error("Matrix Phase 2 deterministic runner unhandled rejection", reason)
    server.close(() => process.exit(1))
  })
  const shutdown = () => server.close(error => {
    if (error) console.error("Matrix Phase 2 deterministic runner shutdown error", error)
    process.exitCode = error ? 1 : 0
  })
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  return server
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false
if (isMain) startPhase2Runner()
