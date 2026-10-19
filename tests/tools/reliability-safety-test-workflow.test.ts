import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { prepareReliabilitySafetyTestContent, finalizeReliabilitySafetyTestContent } from "../../src/tools/reliability-safety-test-workflow"
import { readZip } from "../../src/tools/docx-zip"
import { writePhase2SourceBundleFixture } from "./phase2-source-fixture"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() { const dir = mkdtempSync(join(tmpdir(), "reliability-safety-")); dirs.push(dir); mkdirSync(join(dir, ".matrix/data"), { recursive: true }); writeFileSync(join(dir, ".matrix/data/functional-test-content.json"), "{}"); writePhase2SourceBundleFixture(dir, "数据有效性检查：非法ID应丢弃且不响应。"); return { dir, ctx: { directory: dir, worktree: dir } as any } }

describe("reliability safety test workflow", () => {
  test("enforces 4.1 prerequisite", async () => { const { dir, ctx } = fixture(); rmSync(join(dir, ".matrix/data/functional-test-content.json")); expect(JSON.parse(await prepareReliabilitySafetyTestContent(ctx)).missing_prerequisite).toBe("functional_test_content") })
  test("uses one worker, strict rows, deduplication and standalone 4.4 DOCX", async () => {
    const { dir, ctx } = fixture(), prepared = JSON.parse(await prepareReliabilitySafetyTestContent(ctx))
    expect(prepared.summary).toEqual({ worker_count: 1, raw_reused: false }); expect(prepared.worker.subagent_type).toBe("reliability-safety-test-content-modeler")
    expect(prepared.worker.worker_prompt).toContain("不进行代码正则硬校验")
    expect(prepared.worker.worker_prompt).toContain("异常条件下系统的处理和保护能力")
    expect(prepared.worker.worker_prompt).toContain("异常条件下软件的处理和保护能力")
    expect(prepared.worker.worker_prompt).toContain("禁止输出历史兼容值")
    expect(prepared.worker.worker_prompt).toContain("均归4.8恢复性，不生成TR-AQ")
    expect(prepared.worker.worker_payload).toEqual({ source_artifacts_path: join(dir, ".matrix/data/source-artifacts.json"), output_path: join(dir, ".matrix/data/reliability-safety.raw.json") })
    expect(existsSync(join(dir, ".matrix/data/reliability-safety-test-plan.json"))).toBe(false)
    const row = { reliability_safety_requirement_description: "接收到非法ID时，软件应丢弃数据且不响应。", related_description: "输入故障模式的测试" }
    writeFileSync(prepared.output.reliability_safety_test_raw_path, JSON.stringify({ rows: [row, row, { reliability_safety_requirement_description: "SRAM采用三模冗余存储并按位多数表决。", related_description: "提高安全性的容错方案" }].map((item) => ({ ...item, source_refs: ["primary::SRS-1"] })), open_questions: ["引用表缺失。"] }))
    const result = JSON.parse(await finalizeReliabilitySafetyTestContent(ctx)), model = JSON.parse(readFileSync(result.output.reliability_safety_test_content_path, "utf-8"))
    expect(model.rows).toHaveLength(2); expect(Object.keys(model.rows[0])).toEqual(["requirement_id", "source_refs", "reliability_safety_requirement_description", "related_description"]); expect(model.test_requirements.priority).toBe("低优先级")
    const xml = readZip(readFileSync(result.output.reliability_safety_test_report_path)).get("word/document.xml")?.toString() || ""
    expect(xml).toContain("4.4 可靠性安全性测试"); expect(xml).toContain("表4.4-1  可靠性安全性需求项总结表"); expect(xml).toContain("TR-AQ-002")
    const reused = JSON.parse(await prepareReliabilitySafetyTestContent(ctx)); expect(reused.summary.raw_reused).toBe(true); expect(reused.worker).toBeUndefined()
  })

  test("accepts new system/software categories and keeps the legacy category reusable", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await prepareReliabilitySafetyTestContent(ctx))
    writeFileSync(prepared.output.reliability_safety_test_raw_path, JSON.stringify({ rows: [
      { reliability_safety_requirement_description: "软件检测异常输入并执行隔离。", related_description: "异常条件下软件的处理和保护能力", source_refs: ["primary::SRS-1"] },
      { reliability_safety_requirement_description: "系统协调冗余组件进入安全状态。", related_description: "异常条件下系统的处理和保护能力", source_refs: ["primary::SRS-1"] },
      { reliability_safety_requirement_description: "历史需求保持兼容。", related_description: "异常条件下系统软件的处理和保护能力", source_refs: ["primary::SRS-1"] },
    ], open_questions: [] }))
    const reused = JSON.parse(await prepareReliabilitySafetyTestContent(ctx))
    expect(reused.summary).toEqual({ worker_count: 0, raw_reused: true })
    const result = JSON.parse(await finalizeReliabilitySafetyTestContent(ctx))
    const model = JSON.parse(readFileSync(result.output.reliability_safety_test_content_path, "utf-8"))
    expect(model.rows.map((row: any) => row.related_description)).toEqual([
      "异常条件下软件的处理和保护能力",
      "异常条件下系统的处理和保护能力",
      "异常条件下系统软件的处理和保护能力",
    ])
  })
})
