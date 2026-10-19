import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { finalizeRecoveryTestContent, prepareRecoveryTestContent } from "../../src/tools/recovery-test-workflow"
import { filldataPhase2Workflow } from "../../src/tools/filldata-phase2-workflow"
import { readZip } from "../../src/tools/docx-zip"
import { writePhase2SourceBundleFixture } from "./phase2-source-fixture"

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "recovery-test-"))
  dirs.push(dir)
  mkdirSync(join(dir, ".matrix/data"), { recursive: true })
  writeFileSync(join(dir, ".matrix/data/functional-test-content.json"), "{}")
  writePhase2SourceBundleFixture(dir, [
    "# 功能需求",
    "开启BM3803的EDAC功能，若数据错误，软件重新从SRAM起始地址运行。",
    "SRAM空白区填充软件陷阱；在SRAM空白区填充软件陷阱，跳转至SRAM起始地址，重新运行。",
    "主存储区故障后，系统应切换至备用存储区运行，并保持遥测数据状态一致。",
  ].join("\n"))
  return { dir, ctx: { directory: dir, worktree: dir } as any }
}

describe("recovery test workflow", () => {
  test("prepare enforces 4.1 completion and source artifacts", async () => {
    const { dir, ctx } = fixture()
    rmSync(join(dir, ".matrix/data/functional-test-content.json"))
    const result = JSON.parse(await prepareRecoveryTestContent(ctx))
    expect(result.missing_prerequisite).toBe("functional_test_content")
  })

  test("uses one worker, validates rows, deduplicates, and renders TR-HF only in DOCX", async () => {
    const { dir, ctx } = fixture()
    const prepared = JSON.parse(await prepareRecoveryTestContent(ctx))
    expect(prepared.summary).toEqual({ worker_count: 1, raw_reused: false })
    expect(prepared.worker.subagent_type).toBe("recovery-test-content-modeler")
    expect(prepared.worker.output_path).toBe(join(dir, ".matrix/data/recovery.raw.json"))
    expect(prepared.worker.worker_payload).toEqual({
      source_artifacts_path: join(dir, ".matrix/data/source-artifacts.json"),
      output_path: join(dir, ".matrix/data/recovery.raw.json"),
    })
    expect(prepared.worker.worker_prompt).toContain("$recovery-test-requirements")
    expect(prepared.worker.worker_prompt).toContain("陷阱填充")
    expect(prepared.worker.worker_prompt).toContain("地址0")
    expect(prepared.worker.worker_prompt).toContain("程序入口")
    expect(prepared.worker.worker_prompt).toContain("异常进入未用中断后跳转地址0重新运行")
    expect(prepared.worker.worker_prompt).toContain("均按4.8恢复性候选处理")
    expect(prepared.worker.worker_prompt).toContain("不进行代码正则硬校验")
    expect(existsSync(join(dir, ".matrix/data/recovery-test-plan.json"))).toBe(false)
    expect(existsSync(join(dir, ".matrix/data/recovery-test-content-batches"))).toBe(false)

    const row = {
      recovery_requirement_description: "开启BM3803的EDAC功能，若数据错误，软件重新从SRAM起始地址运行。",
      related_description: "探测错误功能",
    }
    writeFileSync(prepared.output.recovery_test_raw_path, JSON.stringify({
      rows: [
        row,
        row,
        { recovery_requirement_description: "SRAM空白区填充软件陷阱；在SRAM空白区填充软件陷阱，跳转至SRAM起始地址，重新运行。", related_description: "故障发生时保护系统状态" },
        { recovery_requirement_description: "主存储区故障后，系统应切换至备用存储区运行，并保持遥测数据状态一致。", related_description: "切换备用硬件" },
      ].map((item) => ({ ...item, source_refs: ["primary::SRS-1"] })),
      open_questions: ["原文未说明EDAC错误恢复是否保持寄存器状态。"],
    }, null, 2))

    const result = JSON.parse(await finalizeRecoveryTestContent(ctx))
    const model = JSON.parse(readFileSync(result.output.recovery_test_content_path, "utf-8"))
    expect(model.rows).toHaveLength(3)
    expect(Object.keys(model.rows[0])).toEqual(["requirement_id", "source_refs", "recovery_requirement_description", "related_description"])
    expect(model.test_requirements).toEqual({ sufficiency: "C1、C2", termination: "Z1、Z2", priority: "高优先级" })
    expect(model.summary).toEqual({ total: 3, gap_count: 1 })
    expect(model.rows.map((item: any) => item.requirement_id)).toEqual(["TR-HF-001", "TR-HF-002", "TR-HF-003"])

    const gaps = JSON.parse(readFileSync(result.output.recovery_test_gaps_path, "utf-8"))
    expect(gaps.summary.total).toBe(1)

    const xml = readZip(readFileSync(result.output.recovery_test_report_path)).get("word/document.xml")?.toString("utf-8") || ""
    expect(xml).toContain("4.8 恢复性测试")
    expect(xml).toContain("表4.8-1  恢复性需求项总结表")
    expect(xml).toContain("TR-HF-001")
    expect(xml).toContain("TR-HF-003")
    expect(xml).toContain("优先级：所有需求项为高优先级。")

    const reused = JSON.parse(await prepareRecoveryTestContent(ctx))
    expect(reused.summary).toEqual({ worker_count: 0, raw_reused: true })
    expect(reused.worker).toBeUndefined()
  })

  test("rejects extra row fields and non-string questions", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await prepareRecoveryTestContent(ctx))
    writeFileSync(prepared.output.recovery_test_raw_path, JSON.stringify({
      rows: [{ sequence: 1, recovery_requirement_description: "发生错误后软复位并恢复运行。", related_description: "软复位" }],
      open_questions: [{ question: "缺失" }],
    }))
    await expect(finalizeRecoveryTestContent(ctx)).rejects.toThrow()
  })

  test("accepts an empty result without manufacturing requirements", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await prepareRecoveryTestContent(ctx))
    writeFileSync(prepared.output.recovery_test_raw_path, JSON.stringify({ rows: [], open_questions: [] }))
    const result = JSON.parse(await finalizeRecoveryTestContent(ctx))
    const model = JSON.parse(readFileSync(result.output.recovery_test_content_path, "utf-8"))
    expect(model.rows).toEqual([])
    expect(model.summary.total).toBe(0)
  })

  test("filldata_phase2_workflow dispatches the recovery modes", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_recovery_test_content" }, ctx))
    expect(prepared.mode).toBe("prepare_recovery_test_content")
    writeFileSync(prepared.output.recovery_test_raw_path, JSON.stringify({ rows: [], open_questions: [] }))
    const finalized = JSON.parse(await filldataPhase2Workflow.execute({
      mode: "finalize_recovery_test_content",
    }, ctx))
    expect(finalized.mode).toBe("finalize_recovery_test_content")
  })
})
