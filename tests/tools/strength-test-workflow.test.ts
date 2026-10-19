import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { finalizeStrengthTestContent, prepareStrengthTestContent } from "../../src/tools/strength-test-workflow"
import { filldataPhase2Workflow } from "../../src/tools/filldata-phase2-workflow"
import { readZip } from "../../src/tools/docx-zip"
import { writePhase2SourceBundleFixture } from "./phase2-source-fixture"

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "strength-test-"))
  dirs.push(dir)
  mkdirSync(join(dir, ".matrix/data"), { recursive: true })
  writeFileSync(join(dir, ".matrix/data/functional-test-content.json"), "{}")
  writePhase2SourceBundleFixture(dir, [
    "# 功能需求",
    "软件连续运行时间25小时，以1s为周期发送遥测参数取数消息，以8min为周期发送时间码，随机发送内存读出指令和遥控指令，查看软件的各个功能处理情况。",
    "时间码发送后，将1553B总线数据的发送间隔从10ms逐步缩小，测试软件承受能力，即何时达到运行不正常（校时时间精度大于等于5ms）和运行故障（校时时间精度大于等于7ms，造成RBMA主要功能失效）。",
  ].join("\n"))
  return { dir, ctx: { directory: dir, worktree: dir } as any }
}

describe("strength test workflow", () => {
  test("prepare enforces 4.1 completion and source artifacts", async () => {
    const { dir, ctx } = fixture()
    rmSync(join(dir, ".matrix/data/functional-test-content.json"))
    const result = JSON.parse(await prepareStrengthTestContent(ctx))
    expect(result.missing_prerequisite).toBe("functional_test_content")
  })

  test("uses one worker, validates rows, deduplicates, and renders TR-QD only in DOCX", async () => {
    const { dir, ctx } = fixture()
    const prepared = JSON.parse(await prepareStrengthTestContent(ctx))
    expect(prepared.summary).toEqual({ worker_count: 1, raw_reused: false })
    expect(prepared.worker.subagent_type).toBe("strength-test-content-modeler")
    expect(prepared.worker.output_path).toBe(join(dir, ".matrix/data/strength.raw.json"))
    expect(prepared.worker.worker_payload).toEqual({
      source_artifacts_path: join(dir, ".matrix/data/source-artifacts.json"),
      output_path: join(dir, ".matrix/data/strength.raw.json"),
    })
    expect(prepared.worker.worker_prompt).toContain("$strength-test-requirements")
    expect(prepared.worker.worker_prompt).toContain("逐步加压")
    expect(prepared.worker.worker_prompt).toContain("不进行代码正则硬校验")
    expect(existsSync(join(dir, ".matrix/data/strength-test-plan.json"))).toBe(false)
    expect(existsSync(join(dir, ".matrix/data/strength-test-content-batches"))).toBe(false)

    const row = {
      strength_requirement_description: "软件连续运行时间25小时，以1s为周期发送遥测参数取数消息，以8min为周期发送时间码，随机发送内存读出指令和遥控指令，查看软件的各个功能处理情况。",
      related_description: "长时间连续不间断综合功能测试",
    }
    writeFileSync(prepared.output.strength_test_raw_path, JSON.stringify({
      rows: [
        row,
        row,
        { strength_requirement_description: "时间码发送后，将1553B总线数据的发送间隔从10ms逐步缩小，测试软件承受能力，即何时达到运行不正常（校时时间精度大于等于5ms）和运行故障（校时时间精度大于等于7ms，造成RBMA主要功能失效）。", related_description: "提供数据能力的饱和性试验指标" },
      ].map((item) => ({ ...item, source_refs: ["primary::SRS-1"] })),
      open_questions: ["原文未说明异常点保持时间和反复确认次数。"],
    }, null, 2))

    const result = JSON.parse(await finalizeStrengthTestContent(ctx))
    const model = JSON.parse(readFileSync(result.output.strength_test_content_path, "utf-8"))
    expect(model.rows).toHaveLength(2)
    expect(Object.keys(model.rows[0])).toEqual(["requirement_id", "source_refs", "strength_requirement_description", "related_description"])
    expect(model.test_requirements).toEqual({ sufficiency: "C1、C2", termination: "Z1、Z2", priority: "低优先级" })
    expect(model.summary).toEqual({ total: 2, gap_count: 1 })
    expect(model.rows.map((item: any) => item.requirement_id)).toEqual(["TR-QD-001", "TR-QD-002"])

    const gaps = JSON.parse(readFileSync(result.output.strength_test_gaps_path, "utf-8"))
    expect(gaps.summary.total).toBe(1)

    const xml = readZip(readFileSync(result.output.strength_test_report_path)).get("word/document.xml")?.toString("utf-8") || ""
    expect(xml).toContain("4.9 强度测试")
    expect(xml).toContain("表4.9-1  强度需求项总结表")
    expect(xml).toContain("TR-QD-001")
    expect(xml).toContain("TR-QD-002")
    expect(xml).toContain("优先级：所有需求项为低优先级。")

    const reused = JSON.parse(await prepareStrengthTestContent(ctx))
    expect(reused.summary).toEqual({ worker_count: 0, raw_reused: true })
    expect(reused.worker).toBeUndefined()
  })

  test("rejects extra row fields and non-string questions", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await prepareStrengthTestContent(ctx))
    writeFileSync(prepared.output.strength_test_raw_path, JSON.stringify({
      rows: [{ sequence: 1, strength_requirement_description: "连续运行25小时。", related_description: "长时间测试" }],
      open_questions: [{ question: "缺失" }],
    }))
    await expect(finalizeStrengthTestContent(ctx)).rejects.toThrow()
  })

  test("accepts an empty result without manufacturing requirements", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await prepareStrengthTestContent(ctx))
    writeFileSync(prepared.output.strength_test_raw_path, JSON.stringify({ rows: [], open_questions: [] }))
    const result = JSON.parse(await finalizeStrengthTestContent(ctx))
    const model = JSON.parse(readFileSync(result.output.strength_test_content_path, "utf-8"))
    expect(model.rows).toEqual([])
    expect(model.summary.total).toBe(0)
  })

  test("filldata_phase2_workflow dispatches the strength modes", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_strength_test_content" }, ctx))
    expect(prepared.mode).toBe("prepare_strength_test_content")
    writeFileSync(prepared.output.strength_test_raw_path, JSON.stringify({ rows: [], open_questions: [] }))
    const finalized = JSON.parse(await filldataPhase2Workflow.execute({
      mode: "finalize_strength_test_content",
    }, ctx))
    expect(finalized.mode).toBe("finalize_strength_test_content")
  })
})
