import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const runnerPath = resolve("dist/direct-phase2-runner.js")
const source = await readFile(runnerPath, "utf8").catch(error => {
  console.error(`Node runner build output is missing: ${runnerPath}`)
  throw error
})
const forbidden = ["Bun.serve", "Bun.file", "Bun.Glob", "import.meta.dir"]
const matches = forbidden.filter(value => source.includes(value))
if (matches.length) {
  throw new Error(`Node runner bundle contains Bun-only APIs: ${matches.join(", ")}`)
}
console.log("Verified Node-compatible Phase 2 runner bundle")
