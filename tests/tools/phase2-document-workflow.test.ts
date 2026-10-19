import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { filldataPhase2Workflow } from "../../src/tools/filldata-phase2-workflow"
import { readZip, writeZip, type ZipEntry } from "../../src/tools/docx-zip"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const chapters = [
  ["chapter1-scope.docx", "1 范围", "R/YJYE001-1/01.RX1"],
  ["chapter2-system-overview.docx", "2 系统概述", "BM3803"],
  ["hardware-interface-model.docx", "3.1 硬件接口", "TR-HW-001"],
  ["functional-test-content.docx", "4.1 功能测试", "TR-GN-001"],
  ["performance-test-content.docx", "4.2 性能测试", "TR-XN-001"],
  ["interface-test-content.docx", "4.3 接口测试", "TR-JK-001"],
  ["reliability-safety-test-content.docx", "4.4 可靠性安全性测试", "TR-AQ-001"],
  ["margin-test-content.docx", "4.5 余量测试", "TR-YL-001"],
  ["boundary-test-content.docx", "4.6 边界测试", "TR-BJ-001"],
  ["data-processing-test-content.docx", "4.7 数据处理测试", "TR-SC-001"],
  ["recovery-test-content.docx", "4.8 恢复性测试", "TR-HF-001"],
  ["strength-test-content.docx", "4.9 强度测试", "TR-QD-001"],
  ["phase2-test-traceability.docx", "6  测试需求覆盖性说明", "TR-GN-TRACE-001"],
] as const

function ctx(directory: string) {
  return { directory, worktree: directory } as any
}

function docx(title: string, id: string, extraEntries: ZipEntry[] = []): Buffer {
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>` +
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>${id}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style></w:styles>'
  return writeZip([
    { path: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { path: "_rels/.rels", data: Buffer.from("<Relationships/>") },
    { path: "word/document.xml", data: Buffer.from(documentXml) },
    { path: "word/styles.xml", data: Buffer.from(stylesXml) },
    {
      path: "word/_rels/document.xml.rels",
      data: Buffer.from('<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    },
    ...extraEntries,
  ])
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "phase2-document-"))
  dirs.push(dir)
  const reports = join(dir, ".matrix/reports")
  mkdirSync(reports, { recursive: true })
  const data = join(dir, ".matrix/data")
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({
    software_name_and_id: "XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)",
    document_id: "WB-R/JBVO1-8A(F2)/00-2.00.RX1",
    system_name: "配电器下位机软件",
    model_name: "XHDZ-0000755",
  }))
  for (const [name, title, id] of chapters) writeFileSync(join(reports, name), docx(title, id))
  return dir
}

describe("phase2 complete document workflow", () => {
  test("returns every missing chapter report without creating final output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase2-document-missing-"))
    dirs.push(dir)
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.ok).toBe(false)
    expect(result.error).toBe("missing_chapter_reports")
    expect(result.missing_chapter_reports).toHaveLength(13)
    expect(existsSync(join(dir, ".matrix/reports/phase2-test-requirements.docx"))).toBe(false)
  })

  test("prepends the populated three-page template and merges all chapter bodies in order", async () => {
    const dir = fixture()
    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.ok).toBe(true)
    expect(result.summary.chapter_count).toBe(13)
    expect(result.summary.template_front_matter_pages).toBe(3)
    expect(result.summary.cover_template_path).toContain("phase2-test-requirements-cover.docx")
    expect(result.summary.chapter_order).toEqual(chapters.map((chapter) => chapter[1]))

    const outputPath = join(dir, ".matrix/reports/phase2-test-requirements.docx")
    const entries = readZip(readFileSync(outputPath))
    const xml = entries.get("word/document.xml")!.toString("utf-8")
    const header = entries.get("word/header1.xml")!.toString("utf-8")
    const allWordXml = [...entries]
      .filter(([path]) => path.startsWith("word/") && path.endsWith(".xml"))
      .map(([, value]) => value.toString("utf-8"))
      .join("\n")
    expect(xml).toContain("XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)")
    expect(xml).toContain("WB-R/JBVO1-8A(F2)/00-2.00.RX1")
    expect(xml).toContain("配电器下位机软件")
    expect(xml).toContain("XHDZ-0000755")
    expect(header).toContain("XHDZ-0000755")
    expect(header).toContain("配电器下位机软件")
    expect(allWordXml).not.toMatch(/\{(?:型号或者项目代号|软件全称|软件标识号|文档标识)\}/)
    expect(xml).toContain('TOC \\o "1-3" \\h \\z')
    expect(xml).not.toContain("PAGEREF _Toc")
    expect(xml).toContain("目  录")
    expect(xml).toContain("请点击“引用 → 更新目录”，选择更新整个目录。")
    expect(xml).toContain('\\z \\u')
    const stylesXml = entries.get("word/styles.xml")!.toString("utf-8")
    for (let level = 1; level <= 4; level++) {
      const style = stylesXml.match(new RegExp(`<w:style\\b[^>]*w:styleId="Heading${level}"[^>]*>[\\s\\S]*?</w:style>`))?.[0]
      expect(style).toContain(`<w:outlineLvl w:val="${level - 1}"/>`)
    }
    expect(xml).toMatch(/<w:pPr><w:pStyle w:val="Heading2"\/>[^]*?<w:outlineLvl w:val="1"\/>/)
    const builtinNames = [...stylesXml.matchAll(/<w:name\b[^>]*w:val="heading\s*2"/gi)]
    expect(builtinNames).toHaveLength(1)
    expect(xml).not.toContain('<w:pStyle w:val="2"/>')
    expect(entries.get("word/settings.xml")!.toString("utf-8")).toContain('<w:updateFields w:val="true"/>')
    let previous = -1
    const visibleXml = xml.replace(/<\/w:t><w:tab\/><w:t xml:space="preserve">/g, " ")
    for (const [, title, id] of chapters) {
      const position = visibleXml.indexOf(title.replace(/ +/g, " "))
      expect(position).toBeGreaterThan(previous)
      expect(xml).toContain(id)
      previous = position
    }
    expect((xml.match(/<w:sectPr\b/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect(xml).toContain("<w:tbl>")
    expect(xml).toMatch(/<w:footerReference\b[^>]*w:type="default"/)
    expect(entries.has("word/footer1.xml")).toBe(true)
    expect(entries.get("word/_rels/document.xml.rels")!.toString("utf-8")).toContain("/footer")
    expect(visibleXml.indexOf("4.8 恢复性测试")).toBeLessThan(visibleXml.indexOf("4.9 强度测试"))
    expect(visibleXml.indexOf("4.9 强度测试")).toBeLessThan(visibleXml.indexOf("6 测试需求覆盖性说明"))
    expect(xml).toContain('\\u \\w')
    for (const [id, position] of [["57", 420], ["72", 709], ["42", 993]]) {
      const toc = stylesXml.match(new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`))![0]
      expect(toc).toContain('w:eastAsia="宋体"')
      expect(toc).toContain('<w:sz w:val="24"/>')
      expect(toc).toContain(`w:left="${position}" w:hanging="${position}"`)
      expect(toc).toContain('w:line="240"')
      expect(toc).toContain('w:leader="dot"')
      expect(toc).not.toContain("w:link")
    }
    expect(entries.get("word/styles.xml")!.toString("utf-8").match(/w:styleId="Heading2"/g)).toHaveLength(1)
    expect(entries.has("word/header1.xml")).toBe(true)
    expect(entries.has("word/footer2.xml")).toBe(true)
    expect(entries.has("word/numbering.xml")).toBe(true)
  })

  test("isolates copied table styles that collide with numbered cover styles", async () => {
    const dir = fixture()
    const hardwarePath = join(dir, ".matrix/reports/hardware-interface-model.docx")
    const collisionDoc = docx("3.1 硬件接口", "TR-HW-001")
    const collisionEntries = readZip(collisionDoc)
    collisionEntries.set("word/document.xml", Buffer.from(
      collisionEntries.get("word/document.xml")!.toString("utf-8")
        .replace("<w:p><w:r><w:t>TR-HW-001", '<w:p><w:pPr><w:pStyle w:val="10"/></w:pPr><w:r><w:t>TR-HW-001'),
    ))
    collisionEntries.set("word/styles.xml", Buffer.from(
      collisionEntries.get("word/styles.xml")!.toString("utf-8").replace(
        "</w:styles>",
        '<w:style w:type="paragraph" w:styleId="10"><w:name w:val="Source Table Text"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style></w:styles>',
      ),
    ))
    writeFileSync(hardwarePath, writeZip([...collisionEntries].map(([path, data]) => ({ path, data }))))

    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.ok).toBe(true)
    const output = readZip(readFileSync(join(dir, ".matrix/reports/phase2-test-requirements.docx")))
    const documentXml = output.get("word/document.xml")!.toString("utf-8")
    const stylesXml = output.get("word/styles.xml")!.toString("utf-8")
    expect(documentXml).toContain('<w:pStyle w:val="MatrixBody_10"/>')
    expect(stylesXml).toContain('w:styleId="MatrixBody_10"')
    expect(stylesXml).toContain('w:name w:val="Source Table Text"')
    expect(documentXml).not.toMatch(/<w:pStyle w:val="10"\/>[^]*?<w:t>TR-HW-001<\/w:t>/)
  })

  test("requires valid Chapter 1 raw cover values and preserves an existing output", async () => {
    const dir = fixture()
    const rawPath = join(dir, ".matrix/data/chapter1-scope.raw.json")
    const outputPath = join(dir, ".matrix/reports/phase2-test-requirements.docx")
    writeFileSync(outputPath, "keep-me")

    rmSync(rawPath)
    let result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.error).toBe("missing_chapter1_raw")
    expect(readFileSync(outputPath, "utf-8")).toBe("keep-me")

    writeFileSync(rawPath, "{not-json")
    result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.error).toContain("Invalid Chapter 1 raw JSON")
    expect(readFileSync(outputPath, "utf-8")).toBe("keep-me")

    writeFileSync(rawPath, JSON.stringify({ software_name_and_id: "软件(编号)" }))
    result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.error).toContain("document_id, system_name, model_name")
    expect(readFileSync(outputPath, "utf-8")).toBe("keep-me")
  })

  test("renders empty Chapter 1 cover strings as XX", async () => {
    const dir = fixture()
    const rawPath = join(dir, ".matrix/data/chapter1-scope.raw.json")
    writeFileSync(rawPath, JSON.stringify({
      software_name_and_id: "测试软件(TEST-001)",
      document_id: "DOC-001",
      system_name: "测试系统",
      model_name: "   ",
    }))

    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.ok).toBe(true)
    const entries = readZip(readFileSync(join(dir, ".matrix/reports/phase2-test-requirements.docx")))
    const xml = entries.get("word/document.xml")!.toString("utf-8")
    expect(xml).toContain("XX")
    expect(xml).not.toContain("{型号或者项目代号}")
  })

  test("replaces the final document on repeat without modifying chapter reports", async () => {
    const dir = fixture()
    const sourcePath = join(dir, ".matrix/reports/strength-test-content.docx")
    const before = readFileSync(sourcePath)
    const outputPath = join(dir, ".matrix/reports/phase2-test-requirements.docx")
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, "old")

    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.ok).toBe(true)
    expect(readFileSync(outputPath).subarray(0, 2).toString()).toBe("PK")
    expect(readFileSync(sourcePath).equals(before)).toBe(true)
  })

  test("rejects unsupported media and preserves an existing final document", async () => {
    const dir = fixture()
    const badPath = join(dir, ".matrix/reports/interface-test-content.docx")
    writeFileSync(badPath, docx("4.3 接口测试", "TR-JK-001", [
      { path: "word/media/image1.png", data: Buffer.from([1, 2, 3]) },
    ]))
    const outputPath = join(dir, ".matrix/reports/phase2-test-requirements.docx")
    writeFileSync(outputPath, "keep-me")

    const result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Unsupported media relationship")
    expect(readFileSync(outputPath, "utf-8")).toBe("keep-me")
  })

  test("rejects invalid DOCX and packages missing document.xml", async () => {
    const dir = fixture()
    const invalidPath = join(dir, ".matrix/reports/performance-test-content.docx")
    writeFileSync(invalidPath, "not-a-docx")
    let result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Invalid chapter DOCX")

    writeFileSync(invalidPath, writeZip([{ path: "word/styles.xml", data: Buffer.from("<w:styles/>") }]))
    result = JSON.parse(await filldataPhase2Workflow.execute({ mode: "finalize_phase2_document" }, ctx(dir)))
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing word/document.xml")
  })
})
