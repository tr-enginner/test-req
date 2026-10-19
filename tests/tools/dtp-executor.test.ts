import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { dtpExecutor, executeDtpProject } from "../../src/tools/dtp-executor"

function makeCtx(directory: string) {
  return {
    sessionID: "sid-1",
    messageID: "mid-1",
    agent: "test-executor",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

describe("dtp_executor", () => {
  test("defines optional execution args and uses built-in defaults without matrix config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtp-executor-defaults-"))
    const raw = await (dtpExecutor as any).execute({}, makeCtx(dir))
    const result = JSON.parse(raw)

    expect((dtpExecutor as any).args).toBeDefined()
    expect(result.success).toBe(false)
    expect(result.error).toContain("项目目录不存在")
    expect(result.error).toContain(join(dir, ".matrix", "data", "DTPProject"))
    expect(result.effective_config).toEqual({
      source: "tool_args_or_defaults",
      base_url: "http://172.16.1.100:8087",
      project_dir: join(dir, ".matrix", "data", "DTPProject"),
      project_name: "DTPProject",
      version: "V1",
      poll_interval: 10000,
    })
    expect(raw).not.toContain("matrix.jsonc")
  })

  test("ignores invalid matrix.jsonc and reports only the DTP execution error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtp-executor-invalid-config-"))
    mkdirSync(join(dir, ".matrix", "config"), { recursive: true })
    writeFileSync(join(dir, ".matrix", "config", "matrix.jsonc"), "{ invalid jsonc", "utf-8")

    const raw = await (dtpExecutor as any).execute(
      {
        base_url: "http://127.0.0.1:18087",
        project_dir: "missing-dtp-project",
        project_name: "CustomProject",
        version: "V9",
        poll_interval: -1,
      },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)

    expect(result.success).toBe(false)
    expect(result.error).toBe(`项目目录不存在: ${join(dir, "missing-dtp-project")}`)
    expect(result.effective_config).toEqual({
      source: "tool_args_or_defaults",
      base_url: "http://127.0.0.1:18087",
      project_dir: join(dir, "missing-dtp-project"),
      project_name: "CustomProject",
      version: "V9",
      poll_interval: 10000,
    })
    expect(raw).not.toContain("invalid_jsonc")
    expect(raw).not.toContain("matrix.jsonc")
  })

  test("executeDtpProject returns missing project directory without config guidance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtp-executor-direct-"))
    const missingProjectDir = join(dir, "not-exist")
    const result = await executeDtpProject({ project_dir: missingProjectDir })

    expect(result).toEqual({
      success: false,
      error: `项目目录不存在: ${missingProjectDir}`,
    })
  })
})
