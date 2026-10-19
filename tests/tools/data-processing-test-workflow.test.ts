import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { prepareDataProcessingTestContent, finalizeDataProcessingTestContent } from "../../src/tools/data-processing-test-workflow"
import { filldataPhase2Workflow } from "../../src/tools/filldata-phase2-workflow"
import { readZip } from "../../src/tools/docx-zip"
import { writePhase2SourceBundleFixture } from "./phase2-source-fixture"

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "data-processing-test-"))
  dirs.push(dir)
  mkdirSync(join(dir, ".matrix/data"), { recursive: true })
  writeFileSync(join(dir, ".matrix/data/functional-test-content.json"), "{}")
  writePhase2SourceBundleFixture(dir, [
    "# 功能需求",
    "每秒通过SPI总线发送电机遥测轮询指令，并使用返回的电机遥测数据更新遥测帧1参数、遥测帧2参数中电机参数。",
    "对三路温度采样值进行均值滤波后输出温度估计值。",
    "校验失败的数据帧不参与后续计算。",
  ].join("\n"))
  return { dir, ctx: { directory: dir, worktree: dir } as any }
}

describe("data processing test workflow", () => {
  test("prepare enforces 4.1 completion and source artifacts", async () => {
    const { dir, ctx } = fixture()
    rmSync(join(dir, ".matrix/data/functional-test-content.json"))
    const result = JSON.parse(await prepareDataProcessingTestContent(ctx))
    expect(result.missing_prerequisite).toBe("functional_test_content")
  })

  test("uses one worker, validates rows, deduplicates, and renders TR-SC only in DOCX", async () => {
    const { dir, ctx } = fixture()
    const prepared = JSON.parse(await prepareDataProcessingTestContent(ctx))
    expect(prepared.summary).toEqual({ worker_count: 1, raw_reused: false })
    expect(prepared.worker.subagent_type).toBe("data-processing-test-content-modeler")
    expect(prepared.worker.worker_payload).toEqual({
      source_artifacts_path: join(dir, ".matrix/data/source-artifacts.json"),
      output_path: join(dir, ".matrix/data/data-processing.raw.json"),
    })
    expect(prepared.worker.worker_prompt).toContain("$data-processing-test-requirements")
    expect(prepared.worker.worker_prompt).toContain("不进行代码正则硬校验")
    expect(prepared.worker.worker_prompt).toContain("以数据内容质量或通用表示预处理为主要验证对象")
    expect(prepared.worker.worker_prompt).toContain("4.3接口协议→4.6边界→4.1核心功能→4.7数据处理")
    expect(prepared.worker.worker_prompt).toContain("从SRAM/文件/缓存/内部变量读取业务输入")
    expect(prepared.worker.worker_prompt).toContain("坐标系、姿态矩阵、角度修正、指向、相位、控制码")
    expect(prepared.worker.worker_prompt).toContain("数值范围/上下限/端点归4.6")
    expect(prepared.worker.worker_prompt).toContain("定位标志和状态字合法性")
    expect(prepared.worker.worker_prompt).toContain("上注包保存SRAM并定时读取")
    expect(prepared.worker.worker_prompt).toContain("普通排除项直接忽略")
    expect(existsSync(join(dir, ".matrix/data/data-processing-test-plan.json"))).toBe(false)
    expect(existsSync(join(dir, ".matrix/data/data-processing-test-content-batches"))).toBe(false)

    const row = {
      data_processing_requirement_description: "每秒通过SPI总线发送电机遥测轮询指令，并使用返回的电机遥测数据更新遥测帧1参数、遥测帧2参数中电机参数。",
      related_description: "数据采集",
    }
    writeFileSync(prepared.output.data_processing_test_raw_path, JSON.stringify({
      rows: [
        row,
        row,
        { data_processing_requirement_description: "对三路温度采样值进行均值滤波后输出温度估计值。", related_description: "数据融合" },
        { data_processing_requirement_description: "CAN帧长度或校验和不合法时丢弃该帧。", related_description: "数据剔除" },
      ].map((item) => ({ ...item, source_refs: ["primary::SRS-1"] })),
      open_questions: ["原文未说明温度滤波窗口长度。"],
    }, null, 2))

    const result = JSON.parse(await finalizeDataProcessingTestContent(ctx))
    const model = JSON.parse(readFileSync(result.output.data_processing_test_content_path, "utf-8"))
    expect(model.rows).toHaveLength(3)
    expect(Object.keys(model.rows[0])).toEqual(["requirement_id", "source_refs", "data_processing_requirement_description", "related_description"])
    expect(model.test_requirements).toEqual({ sufficiency: "C1、C2", termination: "Z1、Z2", priority: "高优先级" })
    expect(model.summary).toEqual({ total: 3, gap_count: 1 })
    expect(model.rows.map((item: any) => item.requirement_id)).toEqual(["TR-SC-001", "TR-SC-002", "TR-SC-003"])
    expect(model.rows[2].data_processing_requirement_description).toBe("CAN帧长度或校验和不合法时丢弃该帧。")

    const gaps = JSON.parse(readFileSync(result.output.data_processing_test_gaps_path, "utf-8"))
    expect(gaps.summary.total).toBe(1)

    const xml = readZip(readFileSync(result.output.data_processing_test_report_path)).get("word/document.xml")?.toString("utf-8") || ""
    expect(xml).toContain("4.7 数据处理测试")
    expect(xml).toContain("表4.7-1  数据处理需求项总结表")
    expect(xml).toContain("TR-SC-001")
    expect(xml).toContain("TR-SC-003")
    expect(xml).toContain("优先级：所有需求项为高优先级。")

    const reused = JSON.parse(await prepareDataProcessingTestContent(ctx))
    expect(reused.summary).toEqual({ worker_count: 0, raw_reused: true })
    expect(reused.worker).toBeUndefined()
  })

  test("rejects extra row fields and non-string questions", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await prepareDataProcessingTestContent(ctx))
    writeFileSync(prepared.output.data_processing_test_raw_path, JSON.stringify({
      rows: [{ sequence: 1, data_processing_requirement_description: "采集遥测数据。", related_description: "数据校验" }],
      open_questions: [{ question: "缺失" }],
    }))
    await expect(finalizeDataProcessingTestContent(ctx)).rejects.toThrow()
  })

  test("accepts an empty result without manufacturing requirements", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await prepareDataProcessingTestContent(ctx))
    writeFileSync(prepared.output.data_processing_test_raw_path, JSON.stringify({ rows: [], open_questions: [] }))
    const result = JSON.parse(await finalizeDataProcessingTestContent(ctx))
    const model = JSON.parse(readFileSync(result.output.data_processing_test_content_path, "utf-8"))
    expect(model.rows).toEqual([])
    expect(model.summary.total).toBe(0)
  })

  test("filldata_phase2_workflow dispatches the data processing modes", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_data_processing_test_content" }, ctx))
    expect(prepared.mode).toBe("prepare_data_processing_test_content")
    writeFileSync(prepared.output.data_processing_test_raw_path, JSON.stringify({ rows: [], open_questions: [] }))
    const finalized = JSON.parse(await filldataPhase2Workflow.execute({
      mode: "finalize_data_processing_test_content",
    }, ctx))
    expect(finalized.mode).toBe("finalize_data_processing_test_content")
  })
})
