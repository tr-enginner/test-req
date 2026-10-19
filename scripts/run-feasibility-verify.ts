#!/usr/bin/env bun
/**
 * Standalone CLI wrapper around `multivar_feasibility_verify` tool, allowing
 * external scripts (e.g. EmbedSVABench/tools/eval_sva_stage3.py) to invoke
 * the Stage 3 path-feasibility analysis without spinning up OpenCode.
 *
 * Reads JSON-encoded parameters from stdin, calls the tool's execute()
 * function with a synthetic ToolContext, and writes the resulting JSON
 * (whatever the tool returned) to stdout.
 *
 * Parameter envelope (stdin):
 * {
 *   "violations_path": "...",          // optional
 *   "violations": "...",                 // optional (JSON string)
 *   "cpg_path": "...",                   // optional
 *   "project_name": "...",               // optional
 *   "critical_section_apis": "[...]",    // optional JSON array string
 *   "interrupt_apis": "[...]",           // optional
 *   "init_functions": "[...]",           // optional
 *   "output_path": "...",                // optional
 *   "confirmed_output_path": "...",      // optional
 *   "md_output_path": "..."              // optional
 * }
 *
 * Usage:
 *   bun run scripts/run-feasibility-verify.ts < params.json
 */
import { multivarFeasibilityVerify } from "../src/tools/multivar-feasibility-verify"

async function readStdin(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of (process.stdin as AsyncIterable<string | Buffer>)) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"))
  }
  return chunks.join("")
}

async function main() {
  let body = ""
  try {
    body = await readStdin()
  } catch (err: any) {
    console.error(`[run-feasibility-verify] stdin read failed: ${err?.message ?? err}`)
    process.exit(2)
  }
  if (!body.trim()) {
    console.error("[run-feasibility-verify] empty stdin — pass JSON params")
    process.exit(2)
  }
  let params: Record<string, unknown>
  try {
    params = JSON.parse(body) as Record<string, unknown>
  } catch (err: any) {
    console.error(`[run-feasibility-verify] invalid JSON on stdin: ${err?.message ?? err}`)
    process.exit(2)
  }

  // Synthetic ToolContext — the tool only uses .directory/.worktree for path
  // resolution heuristics; we point them at cwd.
  const cwd = process.cwd()
  const ctx = {
    sessionID: "standalone",
    messageID: "standalone",
    agent: "standalone",
    directory: cwd,
    worktree: cwd,
    abort: new AbortController().signal,
    metadata(_: { title?: string; metadata?: Record<string, unknown> }) {
      // no-op
    },
    async ask(_: any) {
      // standalone mode: never wait for user approval
    },
  } as any

  try {
    const result = await multivarFeasibilityVerify.execute(params as any, ctx)
    process.stdout.write(result)
    process.stdout.write("\n")
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error(`[run-feasibility-verify] tool execution failed: ${msg.slice(0, 1000)}`)
    process.stdout.write(JSON.stringify({ status: "error", error: msg }) + "\n")
    process.exit(1)
  }
}

main()
