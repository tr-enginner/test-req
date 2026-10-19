import { describe, expect, test } from "bun:test"
import { createPhase6StructuredReadGuardHook } from "../../src/hooks/phase6-structured-read-guard"

async function runGuard(tool: string, title: string, outputText = "file content") {
  const hook = createPhase6StructuredReadGuardHook("/workspace")
  const output = {
    title,
    output: outputText,
    metadata: {},
  }
  await hook["tool.execute.after"]({ tool, sessionID: "sid-1" }, output)
  return output
}

describe("phase6 structured read guard", () => {
  test("blocks direct reads of Phase 6 structured artifacts", async () => {
    const output = await runGuard(
      "read",
      "Read .matrix/data/phase6-generation-items.json",
      "SECRET_FULL_PROMPT_SHOULD_NOT_SURVIVE",
    )

    expect(output.metadata.phase6_structured_read_blocked).toBe(true)
    expect(output.output).toContain("matrix_artifact_query")
    expect(output.output).toContain('artifact="phase6_generation_manifest"')
    expect(output.output).not.toContain("SECRET_FULL_PROMPT_SHOULD_NOT_SURVIVE")
  })

  test("blocks OpenCode tool-output cache reads", async () => {
    const output = await runGuard(
      "read",
      "Read /home/greatwall/.local/share/opencode/tool-output/tool_e0156100c00104O33sFi2Bqy2q",
      "TRUNCATED TOOL OUTPUT",
    )

    expect(output.metadata.phase6_structured_read_blocked).toBe(true)
    expect(output.output).toContain("tool-output")
    expect(output.output).toContain("phase6_worker_run")
    expect(output.output).not.toContain("TRUNCATED TOOL OUTPUT")
  })

  test("allows non-Phase 6 and wiki reads", async () => {
    const output = await runGuard(
      "repo_read",
      "Read .matrix/wiki/functions/foo.json",
      "wiki content",
    )

    expect(output.metadata.phase6_structured_read_blocked).toBeUndefined()
    expect(output.output).toBe("wiki content")
  })
})
