import { describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { tmpdir } from "os"
import { writeZip } from "../../src/tools/docx-zip"
import { reqParser } from "../../src/tools/req-parser"

function writeTemp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "req-parser-"))
  const file = join(dir, "requirements.md")
  writeFileSync(file, content, "utf-8")
  return file
}

function makeCtx(directory?: string) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), "req-parser-out-"))
  return {
    sessionID: "sid-1",
    messageID: "mid-1",
    agent: "req-architect",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function makeEmptyV1Categories() {
  return {
    functional: [],
    performance: [],
    interface: [],
    safety: [],
    margin: [],
    boundary: [],
    data_processing: [],
    recovery: [],
    stress: [],
    code_review: [],
    static_analysis: [],
    code_walkthrough: [],
    logic_test: [],
  }
}

describe("reqParser extract", () => {
  test("returns file-not-found error", async () => {
    const raw = await (reqParser as any).execute({
      file_path: "C:/not-exists/xx.md",
      format: "markdown",
    }, makeCtx())
    const result = JSON.parse(raw)
    expect(String(result.error || "")).toContain("File not found")
  })

  test("extracts toc and segments", async () => {
    const file = writeTemp(`
# SRS-1 Initialization Function
System shall complete initialization.
# SRS-2 Performance Requirement
Response time shall be lower than 10ms.`.trim())

    const raw = await (reqParser as any).execute(
      {
        file_path: file,
        format: "markdown",
        write_artifacts: false,
      },
      makeCtx(),
    )
    const result = JSON.parse(raw)

    expect(result.ok).toBe(true)
    expect(result.extraction_mode).toBe("segments_only_v1")
    expect(result.total_segments).toBe(2)
    expect(Array.isArray(result.toc)).toBe(true)
    expect(result.toc[0].segment_id).toBe("SRS-001")
  })

  test("writes req-segments artifact", async () => {
    const file = writeTemp(`
# SRS-1 Functional
System shall perform control loop.`.trim())

    const outDir = mkdtempSync(join(tmpdir(), "req-parser-artifact-"))
    const raw = await (reqParser as any).execute(
      {
        file_path: file,
        format: "markdown",
        write_artifacts: true,
      },
      makeCtx(outDir),
    )
    const result = JSON.parse(raw)

    expect(existsSync(result.output.req_segments_path)).toBe(true)
    expect(existsSync(result.output.req_segments_toc_path)).toBe(true)

    const json = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
    const tocJson = JSON.parse(readFileSync(result.output.req_segments_toc_path, "utf-8"))
    expect(json.extraction_mode).toBe("segments_only_v1")
    expect(tocJson.extraction_mode).toBe("segments_toc_only_v1")
    expect(Array.isArray(json.segments)).toBe(true)
    expect(Array.isArray(tocJson.toc)).toBe(true)
  })

  test("writes extract output to explicit output_file paths and returns a compact summary", async () => {
    const file = writeTemp(`
# SRS-1 Functional
System shall perform control loop.
# SRS-2 Performance
Response time shall be lower than 10ms.
`.trim())

    const outDir = mkdtempSync(join(tmpdir(), "req-parser-output-file-"))
    const outputPath = join(outDir, ".matrix", "data", "software-analysis-stage-02-requirements-tool.json")
    const outputTocPath = join(outDir, ".matrix", "data", "software-analysis-stage-02-requirements-toc.json")
    const raw = await (reqParser as any).execute(
      {
        file_path: file,
        format: "markdown",
        write_artifacts: false,
        output_file: outputPath,
        output_toc_file: outputTocPath,
      },
      makeCtx(outDir),
    )
    const result = JSON.parse(raw)

    expect(result.ok).toBe(true)
    expect(result.output.req_segments_path).toBe(outputPath)
    expect(result.output.req_segments_toc_path).toBe(outputTocPath)
    expect(result.summary.structured_segments).toBe(2)
    expect(result.toc).toBeUndefined()
    expect(existsSync(outputPath)).toBe(true)
    expect(existsSync(outputTocPath)).toBe(true)

    const extraction = JSON.parse(readFileSync(outputPath, "utf-8"))
    expect(extraction.total_segments).toBe(2)
    expect(extraction.segments).toHaveLength(2)
  })

  test("deduplicates repeated non-requirement headings during extract", async () => {
    const file = writeTemp(`
# CASC-STEC-PT013 能力验证软件需求规格说明
中国航天系统科学与工程研究院

# SRS-1 Initialization Function
System shall complete initialization.

# CASC-STEC-PT013 能力验证软件需求规格说明
第二页重复页眉

# SRS-2 Response Time
Response time shall be lower than 10ms.
`.trim())

    const outDir = mkdtempSync(join(tmpdir(), "req-parser-dedupe-"))
    const raw = await (reqParser as any).execute(
      {
        file_path: file,
        format: "markdown",
        write_artifacts: true,
      },
      makeCtx(outDir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
    const duplicateTitles = extracted.segments.filter((seg: any) => seg.title === "CASC-STEC-PT013 能力验证软件需求规格说明")

    expect(result.ok).toBe(true)
    expect(duplicateTitles.length).toBe(1)
    expect(extracted.total_segments).toBe(3)
  })

  test("keeps formally numbered sections that share the same non-requirement title", async () => {
    const file = writeTemp([
      "# 1 Introduction",
      "## 1.2 文档概述",
      "First overview.",
      "## 1.4 文档概述",
      "Second overview.",
    ].join("\n"))
    const outDir = mkdtempSync(join(tmpdir(), "req-parser-duplicate-numbered-title-"))
    const result = JSON.parse(await (reqParser as any).execute({
      file_path: file,
      format: "markdown",
      write_artifacts: true,
    }, makeCtx(outDir)))
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))

    expect(extracted.segments.find((segment: any) => segment.segment_id === "SRS-1.2")?.text).toBe("First overview.")
    expect(extracted.segments.find((segment: any) => segment.segment_id === "SRS-1.4")?.text).toBe("Second overview.")
  })

  test("sanitizes leaked Word XML from heading titles and content", async () => {
    const file = writeTemp([
      "# 4 Requirements",
      "## 4.2.1.1 <w:tab w:val=\"clear\" w:pos=\"420\"/><w:r><w:t>Controller Init</w:t></w:r><v:shape id=\"ole_rId7\"><o:OLEObject Type=\"Embed\" ProgID=\"Excel.Sheet\"/></v:shape>",
      "<w:tab w:val=\"left\" w:pos=\"1680\"/><w:r><w:t>System shall initialize the controller.</w:t></w:r><v:shape id=\"ole_rId8\"/>",
    ].join("\n"))

    const outDir = mkdtempSync(join(tmpdir(), "req-parser-word-xml-"))
    const raw = await (reqParser as any).execute(
      {
        file_path: file,
        format: "markdown",
        write_artifacts: true,
      },
      makeCtx(outDir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
    const target = extracted.segments.find((segment: any) => segment.segment_id === "SRS-4.2.1.1")

    expect(result.ok).toBe(true)
    expect(target).toBeTruthy()
    expect(target.title).toBe("Controller Init")
    expect(target.text).toContain("System shall initialize the controller.")
    expect(JSON.stringify(target)).not.toContain("<w:")
    expect(JSON.stringify(target)).not.toContain("<v:")
    expect(JSON.stringify(target)).not.toContain("OLEObject")
  })

  test("extracts docx toc from heading styles without duplicating table-of-contents rows", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "req-parser-docx-"))
    const documentPath = join(outDir, "requirements.docx")
    const paragraph = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
      paragraph("软件需求规格说明"),
      paragraph("范围 5", "TOC1"),
      paragraph("标识 5", "TOC2"),
      paragraph("功能测试 8", "TOC1"),
      paragraph("1 范围", "Heading1"),
      paragraph("1.1 标识", "Heading2"),
      paragraph("系统标识正文。"),
      paragraph("1.2 文档概述", "Heading2"),
      paragraph("文档概述正文。"),
    ].join("")}</w:body></w:document>`
    writeFileSync(documentPath, writeZip([
      { path: "word/document.xml", data: Buffer.from(documentXml) },
      { path: "word/styles.xml", data: Buffer.from('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>') },
    ]))
    const raw = await (reqParser as any).execute(
      {
        file_path: documentPath,
        format: "docx",
        write_artifacts: true,
      },
      makeCtx(outDir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
    const tocTitles = extracted.toc.map((entry: { title: string }) => entry.title)

    expect(result.ok).toBe(true)
    expect(tocTitles[0]).toBe("文档前置内容")
    expect(extracted.segments[0].segment_id).toBe("SRS-PREAMBLE")
    expect(extracted.segments[0].likely_non_requirement).toBe(true)
    expect(tocTitles[1]).toBe("范围")
    expect(tocTitles.filter((title: string) => title === "范围")).toHaveLength(1)
    expect(tocTitles.filter((title: string) => title === "标识")).toHaveLength(1)
    expect(tocTitles.filter((title: string) => title === "文档概述")).toHaveLength(1)
    expect(tocTitles).not.toContain("preamble")
    expect(tocTitles).not.toContain("标识 5")
    expect(tocTitles).not.toContain("功能测试 8")
  })
})
