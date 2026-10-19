import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { filldataPhase2Workflow } from "../../src/tools/filldata-phase2-workflow"
import { cleanChapter2TableTitle, formatChapter2MemorySummary } from "../../src/tools/chapter2-system-overview-docx"
import { readZip } from "../../src/tools/docx-zip"

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const ctx = (directory: string) => ({ directory, worktree: directory } as any)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "chapter2-overview-")); dirs.push(dir)
  const data = join(dir, ".matrix", "data"); mkdirSync(data, { recursive: true })
  writeFileSync(join(data, "source-plan.json"), JSON.stringify({ primary_srs_path: "XHDZ-0000744管理控制器控制软件（R/YJYE001-1/01）需求规格说明.docx" }))
  const structure = join(data, "req-document-structure.json")
  writeFileSync(structure, JSON.stringify({ sections: [{ section_id: "SRS-1", source_ref: "primary::SRS-1", title: "需求", level: 1, section_path_titles: ["需求"], text: "软件概述 BM3803 40MHz", tables: [] }] }))
  writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({ primary_document: { path: "srs.docx", structure_path: structure }, supporting_documents: [] }))
  return { dir, data }
}

const raw = {
  source_refs: ["primary::SRS-1"],
  system_relationship: "管理控制器通过CAN总线与其他单机交换数据。",
  processor_type: "BM3803FMGRH",
  processor_frequency: "40MHz",
  memory_io_summary: "程序存储器、MRAM和SRAM分别用于程序、参数和应用数据。",
  memory_io_tables: [{ title: "存储器使用说明", columns: ["区域", "容量"], rows: [["PROM", "128KB"], ["SRAM", "2MB"]] }],
  interrupts: [{ interrupt_name: "外部中断0（IO4）", priority: "28（低）", frequency_or_random: "随机（频繁）", trigger_mode: "低电平", execution_function: "CANA总线中断" }],
  software_name_and_id: "XHDZ-0000744管理控制器控制软件（R/YJYE001-1/01）",
  software_level: "B",
  programming_language: "C语言",
  developer_unit_name: "508所",
  subsystem_and_software_functions: ["引导加载功能", "初始化功能", "引导加载功能"],
  development_platform: "SpecC-2.55",
  compilation_environment: "SpecC编译器2.55版",
  warnings: [],
}

describe("chapter 2 system overview workflow", () => {
  test("keeps canonical and segmented-XXX software_name_and_id strings", async () => {
    const values = [
      "XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)",
      "XXX配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)",
      "XHDZ-0000755配电器下位机软件(XXX)",
      "XXXXXX(XXX)",
    ]
    for (const softwareNameAndId of values) {
      const { dir, data } = fixture()
      writeFileSync(join(data, "chapter2-system-overview.raw.json"), JSON.stringify({ ...raw, software_name_and_id: softwareNameAndId }))
      const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter2_system_overview" }, ctx(dir)))
      expect(result.ok).toBe(true)
      expect(JSON.parse(readFileSync(join(data, "chapter2-system-overview.json"), "utf-8")).software_name_and_id).toBe(softwareNameAndId)
    }
  })

  test("removes an original requirement table number before assigning the chapter 2 table number", () => {
    expect(cleanChapter2TableTitle("表 3.3-1 80C32 系统 P1 端口位定义")).toBe("80C32 系统 P1 端口位定义")
    expect(cleanChapter2TableTitle("表 3.2.3-1 遥测参数通道地址表")).toBe("遥测参数通道地址表")
    expect(cleanChapter2TableTitle("表 3.2.3-1")).toBe("存储器及I/O使用说明")
  })

  test("formats memory table references without a leading comma or a redundant single-table range", () => {
    expect(formatChapter2MemorySummary("程序存储器用于存放程序。", 1)).toBe("程序存储器用于存放程序。具体见表2-1。")
    expect(formatChapter2MemorySummary("程序存储器用于存放程序", 2)).toBe("程序存储器用于存放程序。具体见表2-1至表2-2。")
    expect(formatChapter2MemorySummary("程序存储器用于存放程序。", 0)).toBe("程序存储器用于存放程序。")
  })

  test("reports both required inputs and returns a constrained worker", async () => {
    const empty = mkdtempSync(join(tmpdir(), "chapter2-missing-")); dirs.push(empty)
    let result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter2_system_overview" }, ctx(empty)))
    expect(result.ok).toBe(false)
    expect(result.missing).toHaveLength(2)
    const { dir } = fixture()
    result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter2_system_overview" }, ctx(dir)))
    expect(result.subagent_type).toBe("chapter2-system-overview-modeler")
    expect(result.worker_prompt).toContain("$test-requirement-chapter2")
    expect(result.worker_prompt).toContain("primary需求规格document structure中的功能标题树")
    expect(result.worker_prompt).toContain("3.2.1.2 总线通信（SR3.2.1.2）")
    expect(result.worker_prompt).toContain("1553B总线通信")
    expect(result.worker_prompt).toContain("CAN1接口处理")
    expect(result.worker_prompt).toContain("清理后为空则跳过并写warnings")
    expect(result.worker_prompt).toContain("不存在时在第一项补充“初始化功能”")
    expect(result.worker_prompt).toContain("memory_io_summary只写存储器名称或类型、容量、地址空间和用途")
    expect(result.worker_prompt).toContain('typeof memory_io_summary === "string"')
    expect(result.worker_prompt).toContain('typeof software_name_and_id === "string"')
    expect(result.worker_prompt).toContain("XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)")
    expect(result.worker_prompt).toContain("标识号使用半角括号")
    for (const placeholder of ["XXX配电器下位机软件(R/...)", "XHDZ-0000755XXX(R/...)", "XHDZ-0000755配电器下位机软件(XXX)", "XXXXXX(XXX)"]) {
      expect(result.worker_prompt).toContain(placeholder)
    }
    expect(result.worker_prompt).toContain("顶层不得输出evidence字段")
    expect(result.worker_prompt).toContain("源文档未给出时固定写XXXXH~XXXXH")
    expect(result.worker_prompt).toContain("development_platform与compilation_environment不得重复")
    expect(result.worker_prompt).toContain("不得包含编程语言、操作系统、烧录/下载/调试工具")
  })

  test("reuses a schema-valid raw artifact after all inputs change", async () => {
    const { dir, data } = fixture()
    writeFileSync(join(data, "chapter2-system-overview.raw.json"), JSON.stringify(raw))
    writeFileSync(join(data, "source-plan.json"), JSON.stringify({ primary_srs_path: "changed.docx" }))
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter2_system_overview" }, ctx(dir)))
    expect(result.summary.raw_reused).toBe(true)
    expect(result.worker_prompt).toBeUndefined()
  })

  test("does not reuse malformed or schema-invalid raw artifacts", async () => {
    const { dir, data } = fixture()
    const rawPath = join(data, "chapter2-system-overview.raw.json")
    writeFileSync(rawPath, "{not-json")
    let result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter2_system_overview" }, ctx(dir)))
    expect(result.summary.raw_reused).toBe(false)
    expect(result.subagent_type).toBe("chapter2-system-overview-modeler")

    writeFileSync(rawPath, JSON.stringify({ ...raw, processor_type: 123 }))
    result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter2_system_overview" }, ctx(dir)))
    expect(result.summary.raw_reused).toBe(false)
    expect(result.subagent_type).toBe("chapter2-system-overview-modeler")

    for (const invalidRaw of [
      { ...raw, memory_io_summary: ["程序存储器", "SRAM"] },
      { ...raw, software_name_and_id: { name: "管理控制器控制软件", id: "R/YJYE001-1/01" } },
      { ...raw, evidence: { processor_type: "硬件环境章节" } },
    ]) {
      writeFileSync(rawPath, JSON.stringify(invalidRaw))
      result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter2_system_overview" }, ctx(dir)))
      expect(result.summary.raw_reused).toBe(false)
      expect(result.subagent_type).toBe("chapter2-system-overview-modeler")
    }
  })

  test("normalizes functions and renders detailed fields, dynamic tables, and interrupts", async () => {
    const { dir, data } = fixture()
    writeFileSync(join(data, "chapter2-system-overview.raw.json"), JSON.stringify({
      ...raw,
      memory_io_tables: [{...raw.memory_io_tables[0], title: "表 3.3-1 存储器使用说明"}],
    }))
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter2_system_overview" }, ctx(dir)))
    expect(result.ok).toBe(true)
    const model = JSON.parse(readFileSync(join(data, "chapter2-system-overview.json"), "utf-8"))
    expect(model.software).toBeUndefined()
    expect(model.subsystem_and_software_functions).toEqual(["引导加载功能", "初始化功能"])
    const report = join(dir, ".matrix", "reports", "chapter2-system-overview.docx")
    expect(existsSync(report)).toBe(true)
    const xml = readZip(readFileSync(report)).get("word/document.xml")!.toString("utf-8")
    for (const text of ["2 系统概述", "CPU：BM3803FMGRH，主频：40MHz", "表2-1  存储器使用说明", "表2-2  中断使用说明", "周期（触发频率）/随机（频繁/偶发）", "CANA总线中断", "等级为B", "编程语言为C语言", "研制单位为508所", "SpecC-2.55", "SpecC编译器2.55版"]) expect(xml).toContain(text)
    expect(xml).toContain(raw.system_relationship)
    expect(xml).not.toContain(`a. ${raw.system_relationship}`)
    expect(xml).toContain("a. CPU：BM3803FMGRH，主频：40MHz")
    expect(xml).toContain(`b. ${raw.memory_io_summary}具体见表2-1。`)
    expect(xml).not.toContain("，具体见表2-1")
    expect(xml).not.toContain("表2-1至表2-1")
    expect(xml).toContain("c. 中断使用情况如下表：")
    expect(xml).not.toContain("表2-1  表 3.3-1")
    expect(xml).not.toContain("/**/")
  })

  test("keeps an empty interrupt table and warns when no interrupts are found", async () => {
    const { dir, data } = fixture()
    writeFileSync(join(data, "chapter2-system-overview.raw.json"), JSON.stringify({ ...raw, memory_io_tables: [], interrupts: [] }))
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter2_system_overview" }, ctx(dir)))
    expect(result.ok).toBe(true)
    const model = JSON.parse(readFileSync(join(data, "chapter2-system-overview.json"), "utf-8"))
    expect(model.warnings.join("\n")).toContain("保留空中断表")
    const xml = readZip(readFileSync(join(dir, ".matrix", "reports", "chapter2-system-overview.docx"))).get("word/document.xml")!.toString("utf-8")
    expect(xml).toContain("表2-1  中断使用说明")
    expect(xml).toContain("未识别到相关测试需求。")
    expect(xml).not.toContain("中断名称")
    expect(xml).not.toContain("无中断")
  })

  test("skips non-rectangular memory tables but rejects the legacy software object", async () => {
    const { dir, data } = fixture()
    writeFileSync(join(data, "chapter2-system-overview.raw.json"), JSON.stringify({ ...raw, memory_io_tables: [{ title: "bad", columns: ["a", "b"], rows: [["one"]] }] }))
    let result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter2_system_overview" }, ctx(dir)))
    expect(result.ok).toBe(true)
    expect(result.skipped_count).toBe(1)
    writeFileSync(join(data, "chapter2-system-overview.raw.json"), JSON.stringify({ ...raw, software: {} }))
    result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter2_system_overview" }, ctx(dir)))
    expect(result.ok).toBe(false)
  })
})
