import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { repoRead } from "../../src/tools/repo-read"

describe("repo_read tool", () => {
  test("normalizes malformed Windows absolute paths that start with /D:/", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-read-tool-"))
    const filePath = join(root, "sample.txt")
    writeFileSync(filePath, "alpha\nbeta\ngamma\n", "utf-8")

    const toolImpl = repoRead as unknown as {
      execute: (args: { path: string; offset?: number; limit?: number }) => Promise<string>
    }

    const output = await toolImpl.execute({
      path: `/${filePath.replace(/\\/g, "/")}`,
      offset: 2,
      limit: 1,
    })

    expect(output).toContain("Path:")
    expect(output).toContain("Lines: 2-2")
    expect(output).toContain("2 | beta")
  })

  test("resolves repository-relative paths against process cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-read-tool-cwd-"))
    mkdirSync(join(root, ".matrix", "plans"), { recursive: true })
    const previousCwd = process.cwd()
    writeFileSync(join(root, ".matrix", "plans", "wiki-generation-plan.json"), "{\n  \"ok\": true\n}\n", "utf-8")

    const toolImpl = repoRead as unknown as {
      execute: (args: { path: string; offset?: number; limit?: number }) => Promise<string>
    }

    process.chdir(root)
    try {
      const output = await toolImpl.execute({
        path: ".matrix/plans/wiki-generation-plan.json",
        offset: 1,
        limit: 2,
      })

      expect(output).toContain("wiki-generation-plan.json")
      expect(output).toContain("1 | {")
    } finally {
      process.chdir(previousCwd)
    }
  })
})
