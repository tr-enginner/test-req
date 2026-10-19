import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { filldataPhase2Workflow } from "../../src/tools/filldata-phase2-workflow"
import { parsePhase2Json } from "../../src/shared/phase2-json"
import { normalizeLocalTables } from "../../src/shared/phase2-tolerance"
import { renderFunctionalOtherContentDocx } from "../../src/tools/functional-other-content-docx"
import { readZip } from "../../src/tools/docx-zip"
import { writePhase2SourceBundleFixture } from "./phase2-source-fixture"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "phase2-tolerance-"))
  directories.push(directory)
  writePhase2SourceBundleFixture(directory)
  const write = (name: string, value: unknown) => {
    const path = join(directory, ".matrix/data", name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
    return path
  }
  const run = async (mode: string, args = {}) => JSON.parse(await (filldataPhase2Workflow as any).execute({ mode, ...args }, { directory, worktree: directory }))
  return { directory, write, run }
}

const chapters = [
  ["performance", "performance", "performance_requirement_description", "响应时间"],
  ["reliability_safety", "reliability-safety", "reliability_safety_requirement_description", "提高安全性的容错方案"],
  ["margin", "margin", "margin_requirement_description", "存储量的余量"],
  ["boundary", "boundary", "boundary_requirement_description", "状态转换的边界点测试"],
  ["data_processing", "data-processing", "data_processing_requirement_description", "数据采集"],
  ["recovery", "recovery", "recovery_requirement_description", "探测错误功能"],
  ["strength", "strength", "strength_requirement_description", "长时间连续不间断综合功能测试"],
] as const

describe("Phase 2 tolerant finalization", () => {
  test("repairs syntax without modifying commas inside strings", () => {
    expect(parsePhase2Json('```json\n{"text":"literal ,} and ,]", "rows":[],}\n```')).toEqual({ text: "literal ,} and ,]", rows: [] })
    expect(() => parsePhase2Json('{"rows":[')).toThrow()
  })

  test.each(chapters)("%s reuses structural raw, skips unknown refs, and regenerates invalid JSON/schema", async (mode, file, field, related) => {
    const { directory, write, run } = fixture()
    write("functional-test-content.json", {})
    const path = write(file + ".raw.json", { rows: [{ [field]: "保留正文", related_description: related, source_refs: ["missing"] }], open_questions: [] })
    expect((await run("prepare_" + mode + "_test_content")).summary.raw_reused).toBe(true)
    const result = await run("finalize_" + mode + "_test_content")
    expect(result.ok).toBe(true)
    expect(result.skipped_count).toBe(1)
    const final = JSON.parse(readFileSync(join(directory, ".matrix/data", file + "-test-content.json"), "utf-8"))
    expect(final.rows[0][field]).toBe("保留正文")
    expect(final.rows[0].source_refs).toEqual([])
    expect(JSON.parse(readFileSync(path, "utf-8")).rows[0].source_refs).toEqual(["missing"])
    writeFileSync(path, '{"rows":[')
    expect((await run("finalize_" + mode + "_test_content")).ok).toBe(false)
    expect((await run("prepare_" + mode + "_test_content")).summary.raw_reused).toBe(false)
    write(file + ".raw.json", { rows: [{ [field]: 42, related_description: related }] })
    expect((await run("prepare_" + mode + "_test_content")).summary.raw_reused).toBe(false)
    write(file + ".raw.json", { rows: [{ [field]: "恢复后的正文", related_description: related, source_refs: null }] })
    expect((await run("prepare_" + mode + "_test_content")).summary.raw_reused).toBe(true)
    expect((await run("finalize_" + mode + "_test_content")).ok).toBe(true)
  })

  test("keeps orphan tables, shares table numbers, and repairs duplicate table IDs without losing rows", () => {
    const item = normalizeLocalTables({
      title_no: "4.1.1", title: "功能", summary: "", input_flow: [], output_flow: [],
      processing: [
        { requirement_id: "TR-GN-X-001", content: "正文一", table_refs: ["A", "A", "missing"] },
        { requirement_id: "TR-GN-X-002", content: "正文二", table_refs: ["A"] },
      ],
      tables: [
        { table_id: "A", title: "共享表", columns: ["值"], rows: [{ 值: "shared-value" }] },
        { table_id: "A", title: "重复ID表", columns: ["值"], rows: [{ 值: "duplicate-value" }] },
        { title: "孤立表", columns: ["值"], rows: [{ 值: "orphan-value" }] },
        { table_id: "bad", title: "坏表", columns: ["值"], rows: [{ 其他: "wrong" }] },
      ],
    })
    expect(item.tables).toHaveLength(3)
    expect(new Set(item.tables.map(table => table.table_id)).size).toBe(3)
    expect(item.processing[0].table_refs).toEqual(["A"])
    const xml = readZip(renderFunctionalOtherContentDocx({ items: [item] } as any)).get("word/document.xml")!.toString()
    for (const text of ["shared-value", "duplicate-value", "orphan-value"]) expect(xml.split(text)).toHaveLength(2)
    expect(xml).not.toContain("wrong")
  })

  test("stops functional assembly when unresolved references leave no locatable functional root", async () => {
    const { directory, write, run } = fixture()
    write("source-plan.json", { primary_srs_path: "srs.docx", other_document_paths: [] })
    write("chapter1-scope.raw.json", {
      source_refs: null, document_id: "", document_version: "1.00", software_name_and_id: "测试软件", model_name: "",
      client_address: "", system_name: "", csci_names: [], code_version: "", programming_languages: [],
      references: [], warnings: [],
    })
    write("chapter2-system-overview.raw.json", {
      source_refs: ["unknown"], system_relationship: "", processor_type: "", processor_frequency: "", memory_io_summary: "",
      memory_io_tables: [], interrupts: [], software_name_and_id: "测试软件", software_level: "C", programming_language: "",
      developer_unit_name: "", subsystem_and_software_functions: [], development_platform: "", compilation_environment: "", warnings: [],
    })
    for (const chapter of ["chapter1_scope", "chapter2_system_overview"]) {
      expect((await run("prepare_" + chapter)).summary.raw_reused).toBe(true)
      expect(await run("finalize_" + chapter)).toMatchObject({ok: true})
    }
    write("hardware-interface-model.raw.json", { model_version: 2, interfaces: [{
      interface_id: "IF-X", interface_name: "接口", title: "接口", overview: "接口正文", source_refs: ["unknown"],
      overview_tables: [{ table_id: "missing" }], topics: [], input_flow: "", input_tables: [], output_flow: "", output_tables: [],
    }] })
    expect((await run("finalize_hardware_interface")).ok).toBe(true)
    write("functional-test-title-tree.raw.json", { functional_root_source_ref: "unknown", root_title: "unknown", children: [], skipped_source_refs: [] })
    expect((await run("prepare_functional_title_tree")).incremental_reuse).toBe(true)
    expect((await run("finalize_functional_title_tree")).ok).toBe(true)
    expect((await run("prepare_functional_init_content")).error).toContain("required initialization node")
    const other = await run("prepare_functional_other_content")
    expect(other.worker_batches).toHaveLength(0)
    expect((await run("finalize_functional_other_content", { functional_other_content_raw_paths: other.output.functional_other_content_raw_paths })).ok).toBe(true)
    expect((await run("finalize_functional_test_content")).error).toContain("required initialization node")
    return
    for (const [mode, file, field, related] of chapters) {
      write(file + ".raw.json", { rows: [{ [field]: "有效正文", related_description: related, source_refs: ["unknown"] }] })
      expect((await run("prepare_" + mode + "_test_content")).summary.raw_reused).toBe(true)
      expect((await run("finalize_" + mode + "_test_content")).ok).toBe(true)
    }
    write("interface-test-identifiers.json", { interfaces: [], open_questions: [] })
    expect((await run("prepare_interface_test_content")).ok).toBe(true)
    expect((await run("finalize_interface_test_content")).ok).toBe(true)
    expect((await run("generate_phase2_traceability")).ok).toBe(true)
    const result = await run("finalize_phase2_document")
    expect(result.ok).toBe(true)
    expect(result.summary.chapter_count).toBe(13)
    expect(existsSync(result.output.phase2_report_path)).toBe(true)
    const xml = readZip(readFileSync(result.output.phase2_report_path)).get("word/document.xml")!.toString()
    expect(xml).toContain("有效正文")
    expect(xml).not.toContain("missing")
  })
})
