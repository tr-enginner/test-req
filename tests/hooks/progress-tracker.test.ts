import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { createProgressTrackerHook } from "../../src/hooks/progress-tracker"
import { ARTIFACT_PATHS } from "../../src/shared/constants"
import { createInitialProgress } from "../../src/shared/phase-state"

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

describe("progress-tracker", () => {
  test("moves Phase 6 to publishing after PASS review and completes only after execution loop passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "progress-tracker-phase6-"))
    const progressPath = join(dir, ARTIFACT_PATHS.PROGRESS)
    const hook = createProgressTrackerHook(dir)

    const progress = createInitialProgress("test", "new_project", ["6"])
    progress.phases["0"].status = "completed"
    progress.phases["2"].status = "completed"
    progress.phases["6"].status = "review_pending"
    writeJson(progressPath, progress)
    writeJson(join(dir, ARTIFACT_PATHS.CASE_REVIEW), {
      verdict: "PASS",
    })

    await hook["tool.execute.after"](
      { tool: "write", sessionID: "sid-1" },
      {
        title: "write",
        output: "Saved to .matrix/data/reviews/case-review.json",
        metadata: {},
      },
    )

    let updated = JSON.parse(readFileSync(progressPath, "utf-8"))
    expect(updated.phases["6"].status).toBe("publishing")
    expect(updated.phases["6"].review_count).toBe(1)

    await hook["tool.execute.after"](
      { tool: "phase6_publish_outputs", sessionID: "sid-1" },
      {
        title: "phase6_publish_outputs",
        output: JSON.stringify({
          status: "success",
          markdown_file: join(dir, ".matrix", "reports", "test-cases.md"),
          docx_file: join(dir, ".matrix", "reports", "confirmation-tests.docx"),
        }),
        metadata: {},
      },
    )

    updated = JSON.parse(readFileSync(progressPath, "utf-8"))
    expect(updated.phases["6"].status).toBe("publishing")
    expect(updated.phases["6"].notes).toContain("waiting for DTP execution loop gate")
    expect(updated.phases["6"].completed_at).toBeUndefined()

    await hook["tool.execute.after"](
      { tool: "phase6_execution_loop", sessionID: "sid-1" },
      {
        title: "phase6_execution_loop",
        output: JSON.stringify({
          status: "success",
          gate_status: "passed",
          phase6_execution_loop_file: join(dir, ".matrix", "data", "phase6-execution-loop.json"),
        }),
        metadata: {},
      },
    )

    updated = JSON.parse(readFileSync(progressPath, "utf-8"))
    expect(updated.phases["6"].status).toBe("completed")
    expect(typeof updated.phases["6"].completed_at).toBe("string")
  })
})
