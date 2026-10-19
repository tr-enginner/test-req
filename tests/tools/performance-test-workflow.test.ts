import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { finalizePerformanceTestContent, preparePerformanceTestContent } from "../../src/tools/performance-test-workflow"
import { readZip } from "../../src/tools/docx-zip"
import { writePhase2SourceBundleFixture } from "./phase2-source-fixture"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "performance-test-content-")); dirs.push(dir)
  mkdirSync(join(dir, ".matrix", "data"), { recursive: true })
  writeFileSync(join(dir, ".matrix", "data", "functional-test-content.json"), "{}")
  writePhase2SourceBundleFixture(dir, [
    "# 性能需求", "软件初始化时间小于10s。", "多帧数据的帧间空隙最小不小于20us，最大不超过2ms。",
    "# 功能需求", "软件应及时处理指令。",
  ].join("\n"))
  return { dir, ctx: { directory: dir, worktree: dir } as any }
}

describe("performance test workflow", () => {
  test("prepare enforces 4.1 completion and source artifacts", async () => {
    const { dir, ctx } = fixture()
    rmSync(join(dir, ".matrix", "data", "functional-test-content.json"))
    const result = JSON.parse(await preparePerformanceTestContent(ctx))
    expect(result.missing_prerequisite).toBe("functional_test_content")
  })

  test("uses one raw worker and renders standalone 4.2 DOCX", async () => {
    const { dir, ctx } = fixture()
    const prepared = JSON.parse(await preparePerformanceTestContent(ctx))
    expect(prepared.ok).toBe(true)
    expect(prepared.summary).toEqual({ worker_count: 1, raw_reused: false })
    expect(prepared.worker.subagent_type).toBe("performance-test-content-modeler")
    expect(prepared.worker.output_path).toBe(join(dir, ".matrix", "data", "performance.raw.json"))
    expect(prepared.worker.worker_payload).toEqual({
      source_artifacts_path: join(dir, ".matrix", "data", "source-artifacts.json"),
      output_path: join(dir, ".matrix", "data", "performance.raw.json"),
    })
    expect(prepared.worker.worker_prompt).not.toContain("batch")
    expect(prepared.worker.worker_prompt).toContain("不进行代码正则硬校验")
    expect(prepared.worker.worker_prompt).toContain("固定调度或设计配置")
    expect(prepared.worker.worker_prompt).toContain("定时周期为10毫秒")
    expect(prepared.worker.worker_prompt).toContain("采集周期小于1秒")
    expect(prepared.worker.worker_prompt).toContain("已排除（固定调度周期/设计约束）")
    expect(existsSync(join(dir, ".matrix", "data", "performance-test-plan.json"))).toBe(false)
    expect(existsSync(join(dir, ".matrix", "data", "performance-test-content-batches"))).toBe(false)

    writeFileSync(prepared.output.performance_test_raw_path, JSON.stringify({
      rows: [
        { performance_requirement_description: "软件初始化时间小于10s。", related_description: "处理时间" },
        { performance_requirement_description: "多帧数据的帧间空隙最小不小于20us，最大不超过2ms。", related_description: "时间间隔" },
        { performance_requirement_description: "软件初始化时间小于10s。", related_description: "处理时间" },
        { performance_requirement_description: "收到控制指令后应在2ms内输出响应。", related_description: "隐含需求：响应时间" },
      ].map((row) => ({ ...row, source_refs: ["primary::SRS-1"] })),
      open_questions: [
        "“及时处理”没有可量化阈值。",
        "已排除（固定调度周期/设计约束）：每1秒更新并发送一次；来源：primary::SRS-1；理由：固定发送节拍。",
      ],
    }, null, 2))

    const finalized = JSON.parse(await finalizePerformanceTestContent(ctx))
    expect(finalized.ok).toBe(true)
    const model = JSON.parse(readFileSync(finalized.output.performance_test_content_path, "utf-8"))
    expect(model.rows).toHaveLength(3)
    expect(Object.keys(model.rows[0])).toEqual(["requirement_id", "source_refs", "performance_requirement_description", "related_description"])
    expect(model.rows[1].related_description).toBe("时间间隔")
    expect(model.rows[2].related_description).toBe("隐含需求：响应时间")
    expect(model.test_requirements).toEqual({ sufficiency: "C1、C2", termination: "Z1、Z2", priority: "低优先级" })
    expect(model.summary).toEqual({ total: 3, gap_count: 2 })
    const gaps = JSON.parse(readFileSync(finalized.output.performance_test_gaps_path, "utf-8"))
    expect(gaps.summary.total).toBe(2)
    expect(gaps.gaps[1].question).toContain("已排除（固定调度周期/设计约束）")

    const zip = readZip(readFileSync(finalized.output.performance_test_report_path))
    const xml = zip.get("word/document.xml")?.toString("utf-8") || ""
    expect(xml).toContain("4.2 性能测试")
    expect(xml).toContain("表4.2-1  性能需求项总结表")
    expect(xml).toContain("TR-XN-001")
    expect(xml).toContain("TR-XN-003")
    expect(xml).toContain("优先级：所有需求项为低优先级。")

    const reused = JSON.parse(await preparePerformanceTestContent(ctx))
    expect(reused.summary).toEqual({ worker_count: 0, raw_reused: true })
    expect(reused.worker).toBeUndefined()
  })
})
