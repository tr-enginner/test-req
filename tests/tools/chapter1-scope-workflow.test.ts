import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { filldataPhase2Workflow } from "../../src/tools/filldata-phase2-workflow"
import { readZip } from "../../src/tools/docx-zip"

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const ctx = (directory: string) => ({ directory, worktree: directory } as any)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "chapter1-scope-")); dirs.push(dir)
  const data = join(dir, ".matrix", "data"); mkdirSync(data, { recursive: true })
  writeFileSync(join(data, "source-plan.json"), JSON.stringify({ primary_srs_path: "WB-R/YJYE001-1/01/RX1-2.00 管理控制器控制软件需求规格说明.docx", other_document_paths: [] }))
  const structure = join(data, "req-document-structure.json")
  writeFileSync(structure, JSON.stringify({ sections: [{ section_id: "SRS-1", source_ref: "primary::SRS-1", title: "需求", level: 1, section_path_titles: ["需求"], text: "火星项目 管理控制器软件需求", tables: [] }] }))
  writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({ primary_document: { path: "srs.docx", structure_path: structure }, supporting_documents: [] }))
  return { dir, data }
}

const raw = {
  source_refs: ["primary::SRS-1"],
  document_id: "WB-R/YJYE001-1/01/RX1-2.00",
  document_version: "1.00",
  software_name_and_id: "XHDZ-0000744管理控制器控制软件（R/YJYE001-1/01）",
  model_name: "XHDZ-0000744",
  client_address: "",
  system_name: "XHDZ-0000744相机分系统",
  csci_names: ["管理控制器控制软件（R/YJYE001-1/01）", "管理控制器控制软件（R/YJYE001-1/01）"],
  code_version: "",
  programming_languages: ["c"],
  references: [{ document_id: "WB-R/YJYE001-1/01/RX1-2.00", document_title: "管理控制器控制软件需求规格说明", source_kind: "primary_srs", evidence: "封面" }],
  warnings: [],
}

describe("chapter 1 scope workflow", () => {
  test("keeps canonical and segmented-XXX software_name_and_id strings", async () => {
    const values = [
      "XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)",
      "XXX配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)",
      "XHDZ-0000755配电器下位机软件(XXX)",
      "XXXXXX(XXX)",
    ]
    for (const softwareNameAndId of values) {
      const { dir, data } = fixture()
      writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({ ...raw, software_name_and_id: softwareNameAndId }))
      const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter1_scope" }, ctx(dir)))
      expect(result.ok).toBe(true)
      expect(JSON.parse(readFileSync(join(data, "chapter1-scope.json"), "utf-8")).software_name_and_id).toBe(softwareNameAndId)
    }
  })

  test("reports all missing required inputs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chapter1-missing-")); dirs.push(dir)
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter1_scope" }, ctx(dir)))
    expect(result.ok).toBe(false)
    expect(result.error).toBe("missing_inputs")
    expect(result.missing).toHaveLength(2)
  })

  test("returns a constrained worker and then reuses a schema-valid raw artifact after all inputs change", async () => {
    const { dir, data } = fixture()
    let result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter1_scope" }, ctx(dir)))
    expect(result.ok).toBe(true)
    expect(result.subagent_type).toBe("chapter1-scope-modeler")
    expect(result.worker_prompt).toContain("source_artifacts_path")
    expect(result.worker_prompt).toContain("XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)")
    expect(result.worker_prompt).toContain("标识号使用半角括号")
    for (const placeholder of ["XXX配电器下位机软件(R/...)", "XHDZ-0000755XXX(R/...)", "XHDZ-0000755配电器下位机软件(XXX)", "XXXXXX(XXX)"]) {
      expect(result.worker_prompt).toContain(placeholder)
    }
    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify(raw))
    writeFileSync(join(data, "source-plan.json"), JSON.stringify({ primary_srs_path: "changed.docx", other_document_paths: [] }))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({ primary_document: { path: "changed.docx" }, supporting_documents: [] }))
    result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter1_scope" }, ctx(dir)))
    expect(result.summary.raw_reused).toBe(true)
    expect(result.worker_prompt).toBeUndefined()
  })

  test("normalizes fields, adds conditional references, and renders fixed chapter content", async () => {
    const { dir, data } = fixture()
    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify(raw))
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter1_scope" }, ctx(dir)))
    expect(result.ok).toBe(true)
    const model = JSON.parse(readFileSync(join(data, "chapter1-scope.json"), "utf-8"))
    expect(model.document_id).toBe("R/YJYE001-1/01.RX1")
    expect(model.code_version).toBe("1.00")
    expect(model.csci_names).toHaveLength(1)
    expect(model.references.some((ref: any) => ref.document_id === "WY-MARS-1JY167")).toBe(true)
    expect(model.references.some((ref: any) => ref.document_id === "Q/W-Q80-18-01-2014")).toBe(true)
    expect(model.references.some((ref: any) => ref.document_id === "Q/W 1141-2007")).toBe(false)
    expect(model.references.some((ref: any) => ref.document_id === "Q/W 1139-2007")).toBe(false)
    expect(model.warnings.join("\n")).toContain("委托单位地址")
    const report = join(dir, ".matrix", "reports", "chapter1-scope.docx")
    expect(existsSync(report)).toBe(true)
    const xml = readZip(readFileSync(report)).get("word/document.xml")!.toString("utf-8")
    expect(xml).toContain("XHDZ-0000744项目办")
    expect(xml).toContain("TR-GN-YYY-XXX")
    expect(xml).toContain("C5：")
    expect(xml).toContain("Z3：")
    expect(xml).not.toContain("client_org")
    expect(xml).not.toContain("/*")
    const testTypeTable = [...xml.matchAll(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g)].find((match) => match[0].includes("TR-GN-YYY-XXX"))?.[0]
    expect(testTypeTable).toBeDefined()
    expect(testTypeTable).toContain('<w:tblW w:w="5000" w:type="pct"/>')
    expect(testTypeTable).toContain('<w:tblInd w:w="0" w:type="dxa"/>')
    expect(testTypeTable).toContain('<w:gridCol w:w="939"/>')
    expect(testTypeTable).toContain('<w:gridCol w:w="4579"/>')
    expect(testTypeTable).toContain('<w:gridCol w:w="4227"/>')

    const paragraphContaining = (text: string) => {
      const block = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].find((match) => match[0].includes(text))?.[0]
      expect(block).toBeDefined()
      return block!
    }
    for (const text of [
      "a. 文档标识：",
      "CSCI：计算机软件配置项",
      "本文档适用的系统是",
      "本文是XHDZ-0000744",
      "GJB/Z 141-2004",
      "依据委托方的要求",
      "注：ALL为固定符号",
      "C1：",
      "Z3：",
    ]) expect(paragraphContaining(text)).toContain('<w:ind w:firstLineChars="200"/>')

    for (const text of ["1 范围", "1.1 标识", "1.2 文档概述", "1.3 依据文件和引用文档", "1.4 测试需求概述", "表1-1  测试类型总结表"]) {
      expect(paragraphContaining(text)).not.toContain("firstLineChars")
    }
  })

  test("maps language enums in C, X86, and 51 order and deduplicates explicit references", async () => {
    const { dir, data } = fixture()
    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({
      ...raw,
      programming_languages: ["mcs51_assembly", "c", "x86_assembly", "c"],
      references: [
        ...raw.references,
        { document_id: "Q/W-Q80-18-01-2014", document_title: "重复C约定", source_kind: "source", evidence: "引用章节" },
      ],
    }))
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter1_scope" }, ctx(dir)))
    expect(result.ok).toBe(true)
    const model = JSON.parse(readFileSync(join(data, "chapter1-scope.json"), "utf-8"))
    const ids = model.references.map((ref: any) => ref.document_id)
    expect(ids.filter((id: string) => id === "Q/W-Q80-18-01-2014")).toHaveLength(1)
    expect(ids.indexOf("Q/W-Q80-18-01-2014")).toBeLessThan(ids.indexOf("Q/W 1141-2007"))
    expect(ids.indexOf("Q/W 1141-2007")).toBeLessThan(ids.indexOf("Q/W 1139-2007"))
    expect(model.programming_languages).toEqual(["mcs51_assembly", "c", "x86_assembly"])
  })

  test("maps each supported language to only its matching programming convention", async () => {
    const cases = [
      ["c", "Q/W-Q80-18-01-2014"],
      ["x86_assembly", "Q/W 1141-2007"],
      ["mcs51_assembly", "Q/W 1139-2007"],
    ] as const
    const programmingIds = cases.map((item) => item[1])
    for (const [language, expectedId] of cases) {
      const { dir, data } = fixture()
      writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({ ...raw, programming_languages: [language] }))
      const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter1_scope" }, ctx(dir)))
      expect(result.ok).toBe(true)
      const model = JSON.parse(readFileSync(join(data, "chapter1-scope.json"), "utf-8"))
      const ids = model.references.map((ref: any) => ref.document_id)
      expect(ids.filter((id: string) => programmingIds.includes(id as any))).toEqual([expectedId])
    }
  })

  test("omits all programming convention references when no supported language is identified", async () => {
    const { dir, data } = fixture()
    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({ ...raw, programming_languages: [] }))
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter1_scope" }, ctx(dir)))
    expect(result.ok).toBe(true)
    const model = JSON.parse(readFileSync(join(data, "chapter1-scope.json"), "utf-8"))
    const ids = model.references.map((ref: any) => ref.document_id)
    expect(ids).not.toContain("Q/W-Q80-18-01-2014")
    expect(ids).not.toContain("Q/W 1141-2007")
    expect(ids).not.toContain("Q/W 1139-2007")
    const xml = readZip(readFileSync(join(dir, ".matrix", "reports", "chapter1-scope.docx"))).get("word/document.xml")!.toString("utf-8")
    expect(xml).not.toContain("航天器软件C语言编程约定")
    expect(xml).not.toContain("航天器X86汇编语言软件编程约定")
    expect(xml).not.toContain("航天器51汇编语言软件编程约定")
  })

  test("does not reuse legacy raw artifacts without programming_languages", async () => {
    const { dir, data } = fixture()
    const { programming_languages: _removed, ...legacyRaw } = raw
    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify(legacyRaw))
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter1_scope" }, ctx(dir)))
    expect(result.ok).toBe(true)
    expect(result.summary.raw_reused).toBe(false)
    expect(result.subagent_type).toBe("chapter1-scope-modeler")
  })

  test("does not reuse malformed raw JSON", async () => {
    const { dir, data } = fixture()
    writeFileSync(join(data, "chapter1-scope.raw.json"), "{not-json")
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "prepare_chapter1_scope" }, ctx(dir)))
    expect(result.summary.raw_reused).toBe(false)
    expect(result.subagent_type).toBe("chapter1-scope-modeler")
  })

  test("appends .RX1 only while rendering identifiers that do not already have the suffix", async () => {
    const { dir, data } = fixture()
    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({ ...raw, document_id: "CASC-STEC-PT013" }))
    let result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter1_scope" }, ctx(dir)))
    expect(result.ok).toBe(true)
    let model = JSON.parse(readFileSync(join(data, "chapter1-scope.json"), "utf-8"))
    expect(model.document_id).toBe("CASC-STEC-PT013")
    let xml = readZip(readFileSync(join(dir, ".matrix", "reports", "chapter1-scope.docx"))).get("word/document.xml")!.toString("utf-8")
    expect(xml).toContain("文档标识：CASC-STEC-PT013.RX1，版本号")

    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({ ...raw, document_id: "CASC-STEC-PT013.RX1" }))
    result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_chapter1_scope" }, ctx(dir)))
    expect(result.ok).toBe(true)
    model = JSON.parse(readFileSync(join(data, "chapter1-scope.json"), "utf-8"))
    expect(model.document_id).toBe("CASC-STEC-PT013.RX1")
    xml = readZip(readFileSync(join(dir, ".matrix", "reports", "chapter1-scope.docx"))).get("word/document.xml")!.toString("utf-8")
    expect(xml).toContain("文档标识：CASC-STEC-PT013.RX1，版本号")
    expect(xml).not.toContain("CASC-STEC-PT013.RX1.RX1")
  })
})
