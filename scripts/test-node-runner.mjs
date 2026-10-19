import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

const root = await mkdtemp(join(tmpdir(), "matrix-node-runner-"))
const data = join(root, ".matrix", "data")
const port = 20_000 + Math.floor(Math.random() * 20_000)
const username = "opencode", password = "node-runner-test"
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
const child = spawn(process.execPath, [resolve("dist/direct-phase2-runner.js")], {
  env: {...process.env, PROJECTS_ROOT: root, MATRIX_PHASE2_RUNNER_PORT: String(port),
    OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password},
  stdio: ["ignore", "pipe", "pipe"],
})
let output = ""
child.stdout.on("data", chunk => { output += chunk })
child.stderr.on("data", chunk => { output += chunk })

async function request(path, init = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {...init,
    headers: {Authorization: authorization, ...(init.headers || {})}})
}

try {
  await mkdir(data, {recursive: true})
  await writeFile(join(data, "chapter1-scope.raw.json"), JSON.stringify({document_id: "OLD", source_refs: []}))
  await writeFile(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
  await writeFile(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {
    role: "primary", structure_path: join(data, "primary-structure.json")}, supporting_documents: []}))
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await request("/health")
      if (response.ok) break
    } catch {}
    if (attempt === 49) throw new Error(`runner did not become healthy\n${output}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  const unauthorized = await fetch(`http://127.0.0.1:${port}/health`)
  if (unauthorized.status !== 401) throw new Error(`expected 401, received ${unauthorized.status}`)
  const missing = await request("/missing")
  if (missing.status !== 404) throw new Error(`expected 404, received ${missing.status}`)
  const invalid = await request("/v1/phase2/editor/inline-describe", {method: "POST",
    headers: {"Content-Type": "application/json"}, body: "{"})
  if (invalid.status !== 400) throw new Error(`expected invalid JSON 400, received ${invalid.status}`)
  const escaped = await request("/v1/phase2/editor/inline-describe", {method: "POST",
    headers: {"Content-Type": "application/json"}, body: JSON.stringify({directory: join(root, "..")})})
  if (escaped.status !== 400) throw new Error(`expected directory escape 400, received ${escaped.status}`)

  const described = await request("/v1/phase2/editor/inline-describe", {method: "POST",
    headers: {"Content-Type": "application/json"}, body: JSON.stringify({directory: root})})
  const descriptor = await described.json()
  if (!described.ok || typeof descriptor.revision !== "string" || !descriptor.revision) {
    throw new Error(`inline describe did not return a revision: HTTP ${described.status} ${JSON.stringify(descriptor)}\n${output}`)
  }
  const editKey = Buffer.from(JSON.stringify({artifact: "chapter1-scope.json", field: "document_id"})).toString("base64url")
  const applied = await request("/v1/phase2/editor/apply-batch", {method: "POST",
    headers: {"Content-Type": "application/json"}, body: JSON.stringify({directory: root,
      expected_revision: descriptor.revision, changes: [{edit_key: editKey, value: "NEW"}]})})
  if (!applied.ok) throw new Error(`batch apply failed: ${await applied.text()}`)
  const saved = JSON.parse(await readFile(join(data, "chapter1-scope.raw.json"), "utf8"))
  if (saved.document_id !== "NEW") throw new Error("batch apply did not persist the edit")
  console.log("Node Phase 2 runner integration test passed")
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM")
    await new Promise(resolve => child.once("exit", resolve))
  }
  await rm(root, {recursive: true, force: true})
}
