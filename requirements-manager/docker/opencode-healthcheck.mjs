const username = process.env.OPENCODE_SERVER_USERNAME || "opencode"
const password = process.env.OPENCODE_SERVER_PASSWORD || ""
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
const signal = AbortSignal.timeout(5_000)
const runnerPort = process.env.MATRIX_PHASE2_RUNNER_PORT || "4097"

const checks = [
  ["OpenCode", "http://127.0.0.1:4096/global/health"],
  ["Phase 2 runner", `http://127.0.0.1:${runnerPort}/health`],
]

for (const [name, url] of checks) {
  const response = await fetch(url, {headers: {Authorization: authorization}, signal})
  if (!response.ok) throw new Error(`${name} health check returned HTTP ${response.status}`)
}
