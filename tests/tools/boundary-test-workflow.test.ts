import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { prepareBoundaryTestContent, finalizeBoundaryTestContent } from "../../src/tools/boundary-test-workflow"
import { readZip } from "../../src/tools/docx-zip"
import { writePhase2SourceBundleFixture } from "./phase2-source-fixture"

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "boundary-test-"))
  dirs.push(dir)
  mkdirSync(join(dir, ".matrix/data"), { recursive: true })
  writeFileSync(join(dir, ".matrix/data/functional-test-content.json"), "{}")
  writePhase2SourceBundleFixture(dir, "温度设置值范围为[1,100]，范围外保持原值。")
  return { dir, ctx: { directory: dir, worktree: dir } as any }
}

describe("boundary test workflow", () => {
  test("enforces the complete 4.1 prerequisite", async () => {
    const { dir, ctx } = fixture()
    rmSync(join(dir, ".matrix/data/functional-test-content.json"))
    expect(JSON.parse(await prepareBoundaryTestContent(ctx)).missing_prerequisite).toBe("functional_test_content")
  })

  test("uses one worker, validates rows, deduplicates, and renders TR-BJ only in DOCX", async () => {
    const { dir, ctx } = fixture()
    const prepared = JSON.parse(await prepareBoundaryTestContent(ctx))
    expect(prepared.summary).toEqual({ worker_count: 1, raw_reused: false })
    expect(prepared.worker.subagent_type).toBe("boundary-test-content-modeler")
    expect(prepared.worker.worker_prompt).toContain("不进行代码正则硬校验")
    expect(prepared.worker.worker_prompt).toContain("闭区间写[start, end]")
    expect(prepared.worker.worker_prompt).toContain("开区间写(start, end)")
    expect(prepared.worker.worker_prompt).toContain("半开区间写[start, end)或(start, end]")
    expect(prepared.worker.worker_prompt).toContain("十六进制值")
    expect(prepared.worker.worker_prompt).toContain("100±10等容差不自行计算端点")
    expect(prepared.worker.worker_prompt).toContain("程序注入、烧录、内存访问、缓冲区和数据搬运")
    expect(prepared.worker.worker_prompt).toContain("起始地址+长度-1")
    expect(prepared.worker.worker_prompt).toContain("地址加法溢出或回绕")
    expect(prepared.worker.worker_prompt).toContain("related_description使用具体对象加现有数据输入域边界/端点后缀")
    expect(prepared.worker.worker_prompt).toContain("不得依据位宽、容量或常识计算未给出的端点")
    expect(prepared.worker.worker_prompt).toContain("普通地址计算、文件写入或烧录步骤本身不成立")
    expect(prepared.worker.worker_payload).toEqual({ source_artifacts_path: join(dir, ".matrix/data/source-artifacts.json"), output_path: join(dir, ".matrix/data/boundary.raw.json") })
    expect(existsSync(join(dir, ".matrix/data/boundary-test-plan.json"))).toBe(false)
    expect(existsSync(join(dir, ".matrix/data/boundary-test-content-batches"))).toBe(false)

    const row = { boundary_requirement_description: "温度设置值范围为[1,100]，范围内更新，范围外保持原值。", source_refs: ["primary::SRS-1"], related_description: "温度设置值数据输入域边界测试" }
    writeFileSync(prepared.output.boundary_test_raw_path, JSON.stringify({ rows: [row, row, { boundary_requirement_description: "输出限幅范围为0~255。", related_description: "遥测值数据输出域端点测试" }, { boundary_requirement_description: "温度跨越阈值时进入或退出控温状态。", related_description: "状态转换的边界点测试" }].map((item) => ({ ...item, source_refs: ["primary::SRS-1"] })), open_questions: ["同一阈值在两处原文中冲突。"] }))
    const result = JSON.parse(await finalizeBoundaryTestContent(ctx))
    const model = JSON.parse(readFileSync(result.output.boundary_test_content_path, "utf-8"))
    expect(model.rows).toHaveLength(3)
    expect(Object.keys(model.rows[0])).toEqual(["requirement_id", "source_refs", "boundary_requirement_description", "related_description"])
    expect(model.test_requirements).toEqual({ sufficiency: "C1、C2、C3、C4、C5", termination: "Z1、Z2", priority: "高优先级" })
    const gaps = JSON.parse(readFileSync(result.output.boundary_test_gaps_path, "utf-8"))
    expect(gaps.summary.total).toBe(1)
    const xml = readZip(readFileSync(result.output.boundary_test_report_path)).get("word/document.xml")?.toString() || ""
    expect(xml).toContain("表4.6-1  边界需求项总结表")
    expect(xml).toContain("TR-BJ-001")
    expect(xml).toContain("TR-BJ-003")
    expect(model.rows.map((item: any) => item.requirement_id)).toEqual(["TR-BJ-001", "TR-BJ-002", "TR-BJ-003"])
    expect(model.rows[1].boundary_requirement_description).toBe("输出限幅范围为0~255。")

    const reused = JSON.parse(await prepareBoundaryTestContent(ctx))
    expect(reused.summary.raw_reused).toBe(true)
    expect(reused.worker).toBeUndefined()
  })

  test("rejects extra row fields and non-string questions", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await prepareBoundaryTestContent(ctx))
    writeFileSync(prepared.output.boundary_test_raw_path, JSON.stringify({ rows: [{ sequence: 1, boundary_requirement_description: "范围为[1,2]。", related_description: "边界测试" }], open_questions: [{ question: "缺失" }] }))
    await expect(finalizeBoundaryTestContent(ctx)).rejects.toThrow()
  })

  test("accepts an empty result without manufacturing requirements", async () => {
    const { ctx } = fixture()
    const prepared = JSON.parse(await prepareBoundaryTestContent(ctx))
    writeFileSync(prepared.output.boundary_test_raw_path, JSON.stringify({ rows: [], open_questions: [] }))
    const result = JSON.parse(await finalizeBoundaryTestContent(ctx))
    const model = JSON.parse(readFileSync(result.output.boundary_test_content_path, "utf-8"))
    expect(model.rows).toEqual([])
    expect(model.summary.total).toBe(0)
  })
})
