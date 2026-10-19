import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { tmpdir } from "os"
import { filldataParser } from "../../src/tools"
import { writeZip } from "../../src/tools/docx-zip"

const TEMP_DIRS: string[] = []

function makeCtx(directory: string) {
  return {
    sessionID: "sid-1",
    messageID: "mid-1",
    agent: "filldata-enricher",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function writeJson(path: string, obj: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8")
}

function writeAutoNumberedDocx(
  path: string,
  options: { outlineOnlyHeading?: boolean; tableHeading?: boolean; compactManualHeadings?: boolean; numericStyleIds?: boolean } = {},
) {
  const heading1Style = options.numericStyleIds ? "2" : "Heading1"
  const heading2Style = options.numericStyleIds ? "3" : "Heading2"
  const heading1Text = options.compactManualHeadings ? "3需求" : "Requirements"
  const heading2Text = options.compactManualHeadings ? "3.1控制器初始化" : "Controller Init"
  const zipBuffer = writeZip([
    {
      path: "[Content_Types].xml",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
          "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
          "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
          "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>",
          "<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>",
          "<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>",
          "</Types>",
        ].join(""),
        "utf-8",
      ),
    },
    {
      path: "_rels/.rels",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
          "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>",
          "</Relationships>",
        ].join(""),
        "utf-8",
      ),
    },
    {
      path: "word/document.xml",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
          "<w:body>",
          options.outlineOnlyHeading
            ? "<w:p><w:pPr><w:outlineLvl w:val=\"0\"/></w:pPr><w:r><w:t>Outline-only cover</w:t></w:r></w:p>"
            : "",
          options.tableHeading
            ? "<w:tbl><w:tr><w:tc><w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Table-only heading</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
            : "",
          `<w:p><w:pPr><w:pStyle w:val="${heading1Style}"/></w:pPr><w:r><w:t>${heading1Text}</w:t></w:r></w:p>`,
          "<w:p><w:r><w:t>System overview paragraph.</w:t></w:r></w:p>",
          `<w:p><w:pPr><w:pStyle w:val="${heading2Style}"/></w:pPr><w:r><w:t>${heading2Text}</w:t></w:r></w:p>`,
          "<w:p><w:r><w:t>The controller shall initialize hardware resources during startup.</w:t></w:r></w:p>",
          "<w:sectPr/>",
          "</w:body>",
          "</w:document>",
        ].join(""),
        "utf-8",
      ),
    },
    {
      path: "word/styles.xml",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
          `<w:style w:type="paragraph" w:styleId="${heading1Style}"><w:name w:val="heading 1"/></w:style>`,
          `<w:style w:type="paragraph" w:styleId="${heading2Style}"><w:name w:val="heading 2"/></w:style>`,
          "</w:styles>",
        ].join(""),
        "utf-8",
      ),
    },
    {
      path: "word/numbering.xml",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
          "<w:abstractNum w:abstractNumId=\"42\">",
          `<w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/><w:pStyle w:val="${heading1Style}"/></w:lvl>`,
          `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/><w:pStyle w:val="${heading2Style}"/></w:lvl>`,
          "</w:abstractNum>",
          "</w:numbering>",
        ].join(""),
        "utf-8",
      ),
    },
  ])

  writeFileSync(path, zipBuffer)
}

function makeV1Categories() {
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

function makeCanonicalSourceArtifact() {
  const segments = [
    {
      segment_id: "SEG-001",
      level: 1,
      title: "Preamble",
      text: "Document metadata before numbered sections.",
    },
    {
      segment_id: "SRS-003",
      level: 1,
      title: "Requirements",
      text: "Umbrella requirements chapter.",
      section_path_ids: ["SRS-003"],
      section_path_titles: ["Requirements"],
    },
    {
      segment_id: "SRS-3.2.1__01",
      level: 3,
      title: "Controller Init",
      text: "The controller shall initialize hardware resources during startup. " + "A".repeat(120),
      section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.1"],
      section_path_titles: ["Requirements", "Capability Requirements", "Controller Init"],
    },
    {
      segment_id: "SRS-3.2.1__02",
      level: 3,
      title: "Controller Init",
      text: "The controller shall confirm initialization state and publish readiness. " + "B".repeat(120),
      section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.1"],
      section_path_titles: ["Requirements", "Capability Requirements", "Controller Init"],
    },
    {
      segment_id: "SRS-3.3",
      level: 2,
      title: "Bus Interface",
      text: "The system shall expose a bus status query interface.",
      section_path_ids: ["SRS-003", "SRS-3.3"],
      section_path_titles: ["Requirements", "Bus Interface"],
    },
    {
      segment_id: "SRS-A",
      level: 1,
      title: "Appendix A",
      text: "Appendix header only.",
      section_path_ids: ["SRS-A"],
      section_path_titles: ["Appendix A"],
    },
  ]

  return {
    file: "demo.pdf",
    format: "pdf",
    extraction_mode: "segments_only_v1",
    total_segments: segments.length,
    toc: segments.map(({ segment_id, level, title, section_path_ids, section_path_titles }) => ({
      segment_id,
      level,
      title,
      ...(section_path_ids ? { section_path_ids } : {}),
      ...(section_path_titles ? { section_path_titles } : {}),
    })),
    segments,
  }
}

function writeCanonicalArtifacts(dir: string, artifact = makeCanonicalSourceArtifact()) {
  const matrixDir = join(dir, ".matrix", "data")
  mkdirSync(matrixDir, { recursive: true })
  const segmentsPath = join(matrixDir, "req-segments.json")
  const tocPath = join(matrixDir, "req-segments-toc.json")
  writeJson(segmentsPath, artifact)
  writeJson(tocPath, {
    file: artifact.file,
    format: artifact.format,
    extraction_mode: "segments_toc_only_v1",
    total_segments: artifact.total_segments,
    toc: artifact.toc,
  })
  return { matrixDir, segmentsPath, tocPath }
}

function buildOutlineLabelBatch(batchOutline: any, labelsByNodeId: Record<string, string[]>) {
  return {
    file: batchOutline.file,
    format: batchOutline.format,
    total_nodes: batchOutline.total_nodes,
    nodes: batchOutline.nodes.map((node: any) => ({
      node_id: node.node_id,
      labels: labelsByNodeId[node.node_id] || [],
    })),
  }
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe("filldataParser extract", () => {
  test("normalizes structured integer headings to SRS-001 and keeps fallback ids off the SRS namespace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-extract-"))
    TEMP_DIRS.push(dir)

    const inputPath = join(dir, "requirements.md")
    writeFileSync(
      inputPath,
      [
        "Prelude text before headings.",
        "1 Introduction",
        "System shall initialize subsystems.",
        "2 System Overview",
        "System shall complete initialization.",
      ].join("\n"),
      "utf-8",
    )

    const raw = await (filldataParser as any).execute(
      {
        mode: "extract",
        file_path: inputPath,
        format: "markdown",
        write_artifacts: true,
      },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
    const segmentIds = extracted.segments.map((segment: { segment_id: string }) => segment.segment_id)

    expect(result.ok).toBe(true)
    expect(segmentIds).toContain("SEG-001")
    expect(segmentIds).toContain("SRS-001")
    expect(segmentIds).toContain("SRS-002")
    expect(segmentIds).not.toContain("SRS-1")
  })

  test("keeps oversized extracted sections intact as one real chapter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-extract-split-"))
    TEMP_DIRS.push(dir)

    const inputPath = join(dir, "requirements.md")
    writeFileSync(
      inputPath,
      [
        "1 Long Requirement",
        "Requirement alpha detail, with punctuation. ".repeat(100),
        "",
        "Requirement beta detail, with punctuation. ".repeat(100),
      ].join("\n"),
      "utf-8",
    )

    const raw = await (filldataParser as any).execute(
      {
        mode: "extract",
        file_path: inputPath,
        format: "markdown",
        write_artifacts: true,
      },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
    const segmentIds = extracted.segments.map((segment: { segment_id: string }) => segment.segment_id)

    expect(result.ok).toBe(true)
    expect(segmentIds).toEqual(["SRS-001"])
    expect(extracted.toc.map((entry: { segment_id: string }) => entry.segment_id)).toEqual(["SRS-001"])
    expect(extracted.segments[0].text.length).toBeGreaterThan(2000)

    const getRaw = await (filldataParser as any).execute(
      {
        mode: "get_segment",
        segments_path: result.output.req_segments_path,
        segment_id: "SRS-001",
      },
      makeCtx(dir),
    )
    const getResult = JSON.parse(getRaw)
    expect(getResult.ok).toBe(true)
    expect(getResult.segment.segment_id).toBe("SRS-001")
    expect(getResult.segment.text).toContain("Requirement alpha detail")
    expect(getResult.segment.text).toContain("with punctuation.")
  })

  test("preserves DOCX auto-numbered heading prefixes when heading text itself has no visible numbers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-extract-docx-numbering-"))
    TEMP_DIRS.push(dir)

    const inputPath = join(dir, "requirements.docx")
    writeAutoNumberedDocx(inputPath)

    const raw = await (filldataParser as any).execute(
      {
        mode: "extract",
        file_path: inputPath,
        format: "docx",
        write_artifacts: true,
      },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
    const segmentIds = extracted.segments.map((segment: { segment_id: string }) => segment.segment_id)

    expect(result.ok).toBe(true)
    expect(segmentIds).toContain("SRS-003")
    expect(segmentIds).toContain("SRS-3.1")
    expect(
      extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-003")?.title,
    ).toBe("Requirements")
    expect(
      extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.1")?.title,
    ).toBe("Controller Init")
  })

  test("parses compact manual numbering from numeric Word heading styles without duplicating prefixes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-extract-docx-compact-numbering-"))
    TEMP_DIRS.push(dir)

    const inputPath = join(dir, "requirements.docx")
    writeAutoNumberedDocx(inputPath, { compactManualHeadings: true, numericStyleIds: true })

    const raw = await (filldataParser as any).execute(
      { mode: "extract", file_path: inputPath, format: "docx", write_artifacts: true },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
    const root = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-003")
    const child = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.1")

    expect(result.ok).toBe(true)
    expect(root?.title).toBe("需求")
    expect(child?.title).toBe("控制器初始化")
    expect(child?.section_path_ids).toEqual(["SRS-003", "SRS-3.1"])
    expect(extracted.segments.some((segment: { title: string }) => /^3(?:\.1)?3(?:\.1)?/.test(segment.title))).toBe(false)
    expect(extracted.segments.some((segment: { segment_id: string }) => segment.segment_id.startsWith("SEG-"))).toBe(false)
  })

  test("matches Mammoth headings by title and level when OOXML contains an extra outline heading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-extract-docx-outline-mismatch-"))
    TEMP_DIRS.push(dir)

    const inputPath = join(dir, "requirements.docx")
    writeAutoNumberedDocx(inputPath, { outlineOnlyHeading: true })

    const raw = await (filldataParser as any).execute(
      {
        mode: "extract",
        file_path: inputPath,
        format: "docx",
        write_artifacts: true,
      },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))

    expect(result.ok).toBe(true)
    expect(extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-003")?.title).toBe("Requirements")
    expect(extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.1")?.title).toBe("Controller Init")
    expect(extracted.segments.find((segment: { title: string }) => segment.title === "Requirements")?.text).toContain("System overview paragraph")
  })

  test("does not let an unmatched Mammoth table heading consume the next OOXML heading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-extract-docx-mammoth-mismatch-"))
    TEMP_DIRS.push(dir)

    const inputPath = join(dir, "requirements.docx")
    writeAutoNumberedDocx(inputPath, { tableHeading: true })

    const raw = await (filldataParser as any).execute(
      {
        mode: "extract",
        file_path: inputPath,
        format: "docx",
        write_artifacts: true,
      },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))

    expect(result.ok).toBe(true)
    expect(extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-003")?.title).toBe("Requirements")
    expect(extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.1")?.title).toBe("Controller Init")
    expect(extracted.segments.find((segment: { title: string }) => segment.title === "Table-only heading")?.segment_id).not.toBe("SRS-003")
  })

  test("attaches section hierarchy path to structured child headings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-extract-path-"))
    TEMP_DIRS.push(dir)

    const inputPath = join(dir, "requirements.md")
    writeFileSync(
      inputPath,
      [
        "3 Requirements",
        "3.2 Functional Requirements",
        "3.2.1 Init Features",
        "3.2.1.1 Controller Init",
        "System shall initialize the controller after power-on.",
      ].join("\n"),
      "utf-8",
    )

    const raw = await (filldataParser as any).execute(
      {
        mode: "extract",
        file_path: inputPath,
        format: "markdown",
        write_artifacts: true,
      },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)
    const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
    const target = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.2.1.1")

    expect(result.ok).toBe(true)
    expect(target.section_path_ids).toEqual(["SRS-003", "SRS-3.2", "SRS-3.2.1", "SRS-3.2.1.1"])
    expect(target.section_path_titles).toEqual(["Requirements", "Functional Requirements", "Init Features", "Controller Init"])
  })
})

describe("filldataParser build_outline", () => {
  test("builds req-outline.json from canonical segments and collapses chunked leaf segments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-outline-"))
    TEMP_DIRS.push(dir)
    const { segmentsPath } = writeCanonicalArtifacts(dir)

    const raw = await (filldataParser as any).execute(
      { mode: "build_outline", segments_path: segmentsPath },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)
    const outline = JSON.parse(readFileSync(result.output.outline_path, "utf-8"))

    expect(result.ok).toBe(true)
    expect(outline.total_nodes).toBe(5)
    expect(outline.total_segments).toBe(6)
    expect(outline.unstructured_segment_ids).toEqual(["SEG-001"])
    expect(outline.nodes.map((node: any) => node.node_id)).toEqual(["SRS-003", "SRS-3.2", "SRS-3.2.1", "SRS-3.3", "SRS-A"])
    expect(outline.nodes.find((node: any) => node.node_id === "SRS-3.2.1").segment_ids).toEqual(["SRS-3.2.1__01", "SRS-3.2.1__02"])
    expect(outline.outline_text).toContain("SRS-3.2.1 Controller Init [segments=2]")
  })
})

describe("filldataParser build_toc_anchor_map", () => {
  test("expands sparse anchors into a full toc-anchor-map artifact with nearest-ancestor inheritance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-toc-anchor-"))
    TEMP_DIRS.push(dir)
    const matrixDir = join(dir, ".matrix", "data")
    mkdirSync(matrixDir, { recursive: true })
    const tocPath = join(matrixDir, "req-segments-toc.json")

    writeJson(tocPath, {
      file: "demo.pdf",
      format: "pdf",
      total_segments: 3,
      toc: [
        { segment_id: "SRS-003", level: 1, title: "Requirements", section_path_ids: ["SRS-003"], section_path_titles: ["Requirements"] },
        { segment_id: "SRS-3.2.1", level: 3, title: "Controller Init", section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.1"], section_path_titles: ["Requirements", "Capability Requirements", "Controller Init"] },
        { segment_id: "SRS-3.3", level: 2, title: "Bus Interface", section_path_ids: ["SRS-003", "SRS-3.3"], section_path_titles: ["Requirements", "Bus Interface"] },
      ],
    })

    const raw = await (filldataParser as any).execute(
      {
        mode: "build_toc_anchor_map",
        toc_path: tocPath,
        toc_anchor_seeds: [
          { section_id: "SRS-003", labels: [] },
          { section_id: "SRS-3.2", labels: ["functional"] },
          { section_id: "SRS-3.3", labels: ["interface"] },
        ],
      },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)
    const artifact = JSON.parse(readFileSync(result.output.toc_anchor_path, "utf-8"))

    expect(result.ok).toBe(true)
    expect(artifact.source_toc_path).toBe(tocPath)
    expect(artifact.segments.find((segment: any) => segment.segment_id === "SRS-3.2.1").anchor_section_id).toBe("SRS-3.2")
    expect(artifact.segments.find((segment: any) => segment.segment_id === "SRS-3.2.1").labels).toEqual(["functional"])
    expect(artifact.segments.find((segment: any) => segment.segment_id === "SRS-3.3").labels).toEqual(["interface"])
  })
})
