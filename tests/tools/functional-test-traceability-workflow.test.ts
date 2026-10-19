import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { readZip } from "../../src/tools/docx-zip"
import { compressTraceabilityRequirementIds } from "../../src/tools/functional-test-traceability-docx"
import { generateFunctionalTestTraceability, parseSrsSectionNumber } from "../../src/tools/functional-test-traceability-workflow"

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function writeJson(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2)) }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "phase2-traceability-")); dirs.push(dir)
  const data = join(dir, ".matrix", "data"); mkdirSync(data, { recursive: true })
  const primaryStructure = join(data, "primary-structure.json")
  const supportingStructure = join(data, "supporting-structure.json")
  const section = (source_ref: string, title: string, text = "正文") => ({ source_ref, section_id: source_ref.split("::").at(-1), title, level: 1, section_path_titles: [title], text, tables: [] })
  writeJson(primaryStructure, { sections: [
    section("primary::SRS-001", "引言", ""),
    section("primary::SRS-2.1", "引用文件"),
    section("primary::SRS-010", "总线通信要求", "[表格：primary::SRS-010::table-1]"),
    section("primary::SRS-3", "纯标题章节", " \n\t"),
    section("primary::SRS-4", "另一个纯标题章节", "\n"),
    section("primary::SRS-5", "无测试需求的正文章节"),
    section("primary::SRS-PREAMBLE", "文档前置内容"),
    section("primary::SEG-064", "无编号标题"),
    section("primary::SRS-A", "数据字典"),
  ] })
  writeJson(supportingStructure, { sections: [section("supporting-001-protocol::SRS-3.1", "补充协议")] })
  writeJson(join(data, "source-artifacts.json"), {
    primary_document: { role: "primary", path: "requirements.docx", structure_path: primaryStructure },
    supporting_documents: [{ role: "supporting", path: "protocol.docx", structure_path: supportingStructure }],
  })
  writeJson(join(data, "functional-test-content.json"), { children: [{ processing: [{ requirement_id: "TR-GN-001", source_refs: ["primary::SRS-2.1"] }] }] })
  writeJson(join(data, "performance-test-content.json"), { rows: [{ requirement_id: "TR-XN-001", source_refs: ["primary::SRS-010"] }] })
  writeJson(join(data, "interface-test-content.json"), { rows: [{ test_requirement_id: "TR-JK-001", source_refs: ["primary::SRS-2.1", "primary::SRS-010", "supporting-001-protocol::SRS-3.1"] }] })
  writeJson(join(data, "reliability-safety-test-content.json"), { rows: [{ requirement_id: "TR-AQ-001", source_refs: ["primary::SRS-3"] }] })
  writeJson(join(data, "margin-test-content.json"), { rows: [{ requirement_id: "TR-YL-001", source_refs: ["primary::SRS-4", "primary::SRS-2.1"] }] })
  writeJson(join(data, "boundary-test-content.json"), { rows: [{ requirement_id: "TR-BJ-001", source_refs: ["primary::SRS-A"] }] })
  for (const file of ["data-processing", "recovery", "strength"]) writeJson(join(data, `${file}-test-content.json`), { rows: [] })
  return { dir, data, ctx: { directory: dir, worktree: dir } as any }
}

describe("Phase 2 traceability workflow", () => {
  test("normalizes numeric SRS section numbers and rejects appendices or internal ids", () => {
    expect(parseSrsSectionNumber("primary::SRS-001")).toBe("1")
    expect(parseSrsSectionNumber("primary::SRS-5.2.4.3")).toBe("5.2.4.3")
    expect(parseSrsSectionNumber("primary::SRS-A")).toBeNull()
    expect(parseSrsSectionNumber("primary::SEG-064")).toBeNull()
    expect(parseSrsSectionNumber("primary::SRS-PREAMBLE")).toBeNull()
  })

  test("compresses adjacent requirement identifiers without crossing prefixes", () => {
    expect(compressTraceabilityRequirementIds(["TR-GN-001", "TR-GN-002", "TR-GN-003", "TR-XN-001"]))
      .toEqual(["TR-GN-001~003", "TR-XN-001"])
  })

  test("builds one row per primary numeric section in source order", async () => {
    const { data, ctx } = fixture()
    const result = JSON.parse(await generateFunctionalTestTraceability(ctx))
    expect(result.ok).toBe(true)
    const artifact = JSON.parse(readFileSync(result.output.phase2_traceability_path, "utf-8"))
    expect(artifact.version).toBe("3.0")
    expect(artifact.rows).toEqual([
      { source_ref: "primary::SRS-2.1", document_name: "需求规格说明", section_number: "2.1", section_title: "引用文件", test_requirement_ids: ["TR-GN-001", "TR-JK-001", "TR-YL-001"] },
      { source_ref: "primary::SRS-010", document_name: "需求规格说明", section_number: "10", section_title: "总线通信要求", test_requirement_ids: ["TR-XN-001", "TR-JK-001"] },
      { source_ref: "primary::SRS-5", document_name: "需求规格说明", section_number: "5", section_title: "无测试需求的正文章节", test_requirement_ids: [] },
    ])
    expect(artifact.rows.some((row: any) => /SRS-A|SEG|PREAMBLE|supporting/.test(row.source_ref))).toBe(false)
    expect(artifact.summary).toEqual({ row_count: 3, requirement_count: 6 })

    const gaps = JSON.parse(readFileSync(result.output.phase2_traceability_gaps_path, "utf-8"))
    expect(gaps.version).toBe("3.0")
    expect(gaps.gaps).toEqual([
      expect.objectContaining({ requirement_id: "TR-AQ-001", source_ref: "primary::SRS-3", message: expect.stringContaining("正文为空") }),
      expect.objectContaining({ requirement_id: "TR-BJ-001", source_ref: "primary::SRS-A" }),
    ])
    expect(gaps.summary.total).toBe(2)

    const xml = readZip(readFileSync(result.output.phase2_traceability_report_path)).get("word/document.xml")?.toString("utf-8") || ""
    for (const header of ["文档名称", "章节号", "标题名称", "测试需求标识"]) expect(xml).toContain(header)
    expect(xml).toContain("需求规格说明")
    expect(xml).toContain("非测试需求项")
    expect(xml).toContain("TR-GN-001")
    expect(xml).not.toContain("requirements.docx")
    expect(xml).not.toContain("数据字典")
    expect(xml).not.toContain("补充协议")
    expect(readFileSync(join(data, "phase2-test-traceability.json"), "utf-8")).toBeTruthy()
  })
})
