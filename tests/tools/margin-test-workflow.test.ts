import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { prepareMarginTestContent, finalizeMarginTestContent } from "../../src/tools/margin-test-workflow"
import { readZip } from "../../src/tools/docx-zip"
import { writePhase2SourceBundleFixture } from "./phase2-source-fixture"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() { const dir = mkdtempSync(join(tmpdir(), "margin-test-")); dirs.push(dir); mkdirSync(join(dir, ".matrix/data"), { recursive: true }); writeFileSync(join(dir, ".matrix/data/functional-test-content.json"), "{}"); writePhase2SourceBundleFixture(dir, "PROM空间128K，实际使用不超过80%。初始化时间小于10s。"); return { dir, ctx: { directory: dir, worktree: dir } as any } }

describe("margin test workflow", () => {
  test("enforces 4.1 prerequisite", async () => { const { dir, ctx } = fixture(); rmSync(join(dir, ".matrix/data/functional-test-content.json")); expect(JSON.parse(await prepareMarginTestContent(ctx)).missing_prerequisite).toBe("functional_test_content") })
  test("uses one worker, strict rows, deduplication and standalone 4.5 DOCX", async () => {
    const { dir, ctx } = fixture(), prepared = JSON.parse(await prepareMarginTestContent(ctx))
    expect(prepared.summary).toEqual({ worker_count: 1, raw_reused: false }); expect(prepared.worker.subagent_type).toBe("margin-test-content-modeler")
    expect(prepared.worker.worker_prompt).toContain("不进行代码正则硬校验")
    expect(prepared.worker.worker_prompt).toContain("同一介质的多个命名区或独立地址范围也分别生成")
    expect(prepared.worker.worker_prompt).toContain("地址只识别对象，不得通过地址差值计算容量")
    expect(prepared.worker.worker_prompt).toContain("20%不是默认值")
    expect(prepared.worker.worker_prompt).toContain("全部存储区统一余量≥20%")
    expect(prepared.worker.worker_prompt).toContain("有审计价值时写open_questions")
    expect(prepared.worker.worker_prompt).toContain("普通中断/任务周期、响应时间、截止时间和处理上限属于性能测试")
    expect(prepared.worker.worker_prompt).toContain("禁止通过周期-处理时间或处理时间÷周期推导5%、10%、20%")
    expect(prepared.worker.worker_prompt).toContain("周期500μs/处理50μs")
    expect(prepared.worker.worker_prompt).toContain("周期1ms/处理50μs")
    expect(prepared.worker.worker_prompt).toContain("可施加的峰值负载")
    expect(prepared.worker.worker_prompt).toContain("可观察统计口径")
    expect(prepared.worker.worker_payload).toEqual({ source_artifacts_path: join(dir, ".matrix/data/source-artifacts.json"), output_path: join(dir, ".matrix/data/margin.raw.json") })
    expect(existsSync(join(dir, ".matrix/data/margin-test-plan.json"))).toBe(false); expect(existsSync(join(dir, ".matrix/data/margin-test-content-batches"))).toBe(false)
    const row = { margin_requirement_description: "PROM空间为128K，实际使用空间不超过80%。", related_description: "存储量的余量" }
    writeFileSync(prepared.output.margin_test_raw_path, JSON.stringify({ rows: [row, row, { margin_requirement_description: "处理周期为10ms，最大处理耗时不超过周期的70%。", related_description: "功能处理时间的余量" }, { margin_requirement_description: "通道能力为1Mbps，峰值输入输出负载不超过80%。", related_description: "输入/输出及通道的吞吐能力余量" }].map((item) => ({ ...item, source_refs: ["primary::SRS-1"] })), open_questions: ["SRAM仅给出总容量，缺少使用上限。"] }))
    const result = JSON.parse(await finalizeMarginTestContent(ctx)), model = JSON.parse(readFileSync(result.output.margin_test_content_path, "utf-8"))
    expect(model.rows).toHaveLength(3); expect(Object.keys(model.rows[0])).toEqual(["requirement_id", "source_refs", "margin_requirement_description", "related_description"]); expect(model.test_requirements.priority).toBe("低优先级")
    const gaps = JSON.parse(readFileSync(result.output.margin_test_gaps_path, "utf-8")); expect(gaps.summary.total).toBe(1)
    const xml = readZip(readFileSync(result.output.margin_test_report_path)).get("word/document.xml")?.toString() || ""
    expect(xml).toContain("4.5 余量测试"); expect(xml).toContain("表4.5-1  余量需求项总结表"); expect(xml).toContain("TR-YL-003")
    const reused = JSON.parse(await prepareMarginTestContent(ctx)); expect(reused.summary.raw_reused).toBe(true); expect(reused.worker).toBeUndefined()
    const sourcePath = join(dir, ".matrix/data/source-artifacts.json")
    await Bun.sleep(10)
    writeFileSync(sourcePath, readFileSync(sourcePath, "utf-8"))
    const stale = JSON.parse(await prepareMarginTestContent(ctx)); expect(stale.summary.raw_reused).toBe(true); expect(stale.worker).toBeUndefined()
  })
})
