import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { writeZip } from "../../src/tools/docx-zip"
import { buildDocumentStructureArtifact, writeDocumentStructureArtifacts } from "../../src/tools/document-structure-artifact"

const TEMP_DIRS: string[] = []

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function writeDocx(
  path: string,
  bodyXml: string,
  stylesXml?: string,
) {
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
          bodyXml,
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
        stylesXml ?? [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
          "<w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"Heading 1\"/></w:style>",
          "<w:style w:type=\"paragraph\" w:styleId=\"Heading2\"><w:name w:val=\"Heading 2\"/></w:style>",
          "<w:style w:type=\"table\" w:styleId=\"ProtoTable\"><w:name w:val=\"ProtoTable\"/></w:style>",
          "</w:styles>",
        ].join(""),
        "utf-8",
      ),
    },
  ])

  writeFileSync(path, zipBuffer)
}

function heading(level: 1 | 2 | 3 | 4, text: string) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
}

function paragraph(text: string) {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
}

function makeTableXml(title: string) {
  return [
    "<w:tbl>",
    "<w:tblPr><w:tblStyle w:val=\"ProtoTable\"/><w:tblW w:w=\"6000\" w:type=\"dxa\"/></w:tblPr>",
    "<w:tblGrid><w:gridCol w:w=\"3000\"/><w:gridCol w:w=\"3000\"/></w:tblGrid>",
    "<w:tr>",
    "<w:tc><w:tcPr><w:tcW w:w=\"6000\" w:type=\"dxa\"/><w:gridSpan w:val=\"2\"/></w:tcPr><w:p><w:r><w:t>Merged Header</w:t></w:r></w:p></w:tc>",
    "</w:tr>",
    "<w:tr>",
    `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${title}</w:t></w:r></w:p></w:tc>`,
    "<w:tc><w:tcPr><w:tcW w:w=\"3000\" w:type=\"dxa\"/></w:tcPr><w:p><w:r><w:t>Description</w:t></w:r></w:p></w:tc>",
    "</w:tr>",
    "</w:tbl>",
  ].join("")
}

function makeProtocolTableXml(rows: string[][]) {
  const columnCount = rows[0]?.length || 1
  const columnWidth = Math.floor(6000 / columnCount)
  const grid = Array.from({ length: columnCount }, () => `<w:gridCol w:w="${columnWidth}"/>`).join("")
  const bodyRows = rows
    .map((row) => [
      "<w:tr>",
      ...row.map((cell) => [
        `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/></w:tcPr>`,
        `<w:p><w:r><w:t>${cell}</w:t></w:r></w:p>`,
        "</w:tc>",
      ].join("")),
      "</w:tr>",
    ].join(""))
    .join("")

  return [
    "<w:tbl>",
    "<w:tblPr><w:tblStyle w:val=\"ProtoTable\"/><w:tblW w:w=\"6000\" w:type=\"dxa\"/></w:tblPr>",
    `<w:tblGrid>${grid}</w:tblGrid>`,
    bodyRows,
    "</w:tbl>",
  ].join("")
}

function makeOleObjectTableXml() {
  return [
    "<w:tbl>",
    "<w:tblPr><w:tblW w:w=\"6000\" w:type=\"dxa\"/></w:tblPr>",
    "<w:tr>",
    "<w:tc>",
    "<w:p>",
    "<w:r>",
    "<w:object>",
    "<v:shape id=\"visio_rId7\">",
    "<o:OLEObject Type=\"Embed\" ProgID=\"Visio.Drawing.15\"/>",
    "</v:shape>",
    "</w:object>",
    "</w:r>",
    "</w:p>",
    "</w:tc>",
    "</w:tr>",
    "</w:tbl>",
  ].join("")
}

function makeImageRelationTableXml() {
  return [
    "<w:tbl>",
    "<w:tblPr><w:tblStyle w:val=\"ProtoTable\"/><w:tblW w:w=\"6000\" w:type=\"dxa\"/></w:tblPr>",
    "<w:tblGrid><w:gridCol w:w=\"3000\"/><w:gridCol w:w=\"3000\"/></w:tblGrid>",
    "<w:tr>",
    "<w:tc><w:tcPr><w:tcW w:w=\"3000\" w:type=\"dxa\"/></w:tcPr><w:p><w:r><w:t>Signal</w:t></w:r></w:p></w:tc>",
    "<w:tc><w:tcPr><w:tcW w:w=\"3000\" w:type=\"dxa\"/></w:tcPr>",
    "<w:p><w:r><w:t>Payload</w:t></w:r></w:p>",
    "<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed=\"rId5\" r:link=\"rId6\"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",
    "<w:p><w:hyperlink r:id=\"rId7\"><w:r><w:t>Linked manual</w:t></w:r></w:hyperlink></w:p>",
    "</w:tc>",
    "</w:tr>",
    "<w:tr>",
    "<w:tc><w:tcPr><w:tcW w:w=\"3000\" w:type=\"dxa\"/></w:tcPr><w:p><w:r><w:t>CAN-ID</w:t></w:r></w:p></w:tc>",
    "<w:tc><w:tcPr><w:tcW w:w=\"3000\" w:type=\"dxa\"/></w:tcPr><w:p><w:r><w:t>0x181</w:t></w:r></w:p></w:tc>",
    "</w:tr>",
    "</w:tbl>",
  ].join("")
}

describe("buildDocumentStructureArtifact", () => {
  test("merges parser chunk ids back into the real source section for structure output", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-chunks-"))
    TEMP_DIRS.push(dir)

    const artifact = buildDocumentStructureArtifact(join(dir, "requirements.txt"), {
      format: "txt",
      toc: [
        { segment_id: "SRS-3.2", level: 2, title: "能力需求", section_path_ids: ["SRS-003", "SRS-3.2"] },
        {
          segment_id: "SRS-3.2.3__01",
          level: 3,
          title: "采集、处理一次电源的工程参数",
          section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.3"],
        },
        {
          segment_id: "SRS-3.2.3__02",
          level: 3,
          title: "采集、处理一次电源的工程参数",
          section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.3"],
        },
        { segment_id: "SRS-3.2.4", level: 3, title: "温度控制", section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.4"] },
      ],
      segments: [
        { segment_id: "SRS-3.2", level: 2, title: "能力需求", text: "" },
        {
          segment_id: "SRS-3.2.3__01",
          level: 3,
          title: "采集、处理一次电源的工程参数",
          text: "AD 参数表第 1 至 27 行。",
          section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.3"],
        },
        {
          segment_id: "SRS-3.2.3__02",
          level: 3,
          title: "采集、处理一次电源的工程参数",
          text: "AD 参数表第 28 至 63 行。",
          section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.3"],
        },
        { segment_id: "SRS-3.2.4", level: 3, title: "温度控制", text: "温度控制要求。" },
      ],
    }, {
      source_ref_prefix: "primary",
    })

    expect(artifact.sections.map((section) => section.section_id)).toEqual([
      "SRS-3.2",
      "SRS-3.2.3",
      "SRS-3.2.4",
    ])
    expect(artifact.total_sections).toBe(3)
    expect(artifact.sections[1].source_ref).toBe("primary::SRS-3.2.3")
    expect(artifact.sections[1].section_path_ids).toEqual(["SRS-003", "SRS-3.2", "SRS-3.2.3"])
    expect(artifact.sections[1].section_path_titles.at(-1)).toBe("采集、处理一次电源的工程参数")
    expect(artifact.sections[1].text).toContain("AD 参数表第 1 至 27 行。")
    expect(artifact.sections[1].text).toContain("AD 参数表第 28 至 63 行。")
  })

  test("remaps duplicate structured ids without dropping content and keeps descendants under the remapped parent", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-duplicate-"))
    TEMP_DIRS.push(dir)

    const artifact = buildDocumentStructureArtifact(join(dir, "requirements.txt"), {
      format: "txt",
      toc: [
        { segment_id: "SRS-001", level: 1, title: "范围", section_path_ids: ["SRS-001"], section_path_titles: ["范围"] },
        { segment_id: "SRS-001", level: 1, title: "引用文档", section_path_ids: ["SRS-001"], section_path_titles: ["引用文档"] },
        { segment_id: "SRS-1.1", level: 2, title: "规范性引用文件", section_path_ids: ["SRS-001", "SRS-1.1"], section_path_titles: ["引用文档", "规范性引用文件"] },
      ],
      segments: [
        { segment_id: "SRS-001", level: 1, title: "范围", text: "范围正文。" },
        { segment_id: "SRS-001", level: 1, title: "引用文档", text: "引用文档正文。" },
        { segment_id: "SRS-1.1", level: 2, title: "规范性引用文件", text: "引用文件正文。" },
      ],
    }, { source_ref_prefix: "primary" })

    expect(artifact.sections).toHaveLength(3)
    expect(artifact.sections.map((section) => section.section_id)).toEqual(["SRS-001", "SEG-001", "SRS-1.1"])
    expect(artifact.sections[0].text).toContain("范围正文。")
    expect(artifact.sections[1].text).toContain("引用文档正文。")
    expect(artifact.sections[2].section_path_ids).toEqual(["SEG-001", "SRS-1.1"])
    expect(artifact.sections[2].section_path_titles).toEqual(["引用文档", "规范性引用文件"])
    expect(artifact.sections[1].source_ref).toBe("primary::SEG-001")
    expect(artifact.warnings).toContainEqual(expect.objectContaining({
      code: "duplicate_section_id_remapped",
      original_section_id: "SRS-001",
      assigned_section_id: "SEG-001",
      title: "引用文档",
    }))
  })

  test("sanitizes leaked Word XML in titles and records a non-fatal warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-title-xml-"))
    TEMP_DIRS.push(dir)

    const artifact = buildDocumentStructureArtifact(join(dir, "requirements.txt"), {
      format: "txt",
      toc: [{
        segment_id: "SRS-2.1",
        level: 2,
        title: "</w:r><w:bookmarkStart w:id=\"1\"/><w:r><w:t>规范性引用文件</w:t></w:r>",
        section_path_ids: ["SRS-002", "SRS-2.1"],
      }],
      segments: [{
        segment_id: "SRS-2.1",
        level: 2,
        title: "规范性引用文件",
        text: "正文。",
      }],
    })

    expect(artifact.sections[0].title).toBe("规范性引用文件")
    expect(artifact.sections[0].title).not.toContain("<w:")
    expect(artifact.warnings).toContainEqual(expect.objectContaining({ code: "xml_title_sanitized" }))
  })

  test("keeps heading-based table assignment and saves external table XML assets", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-heading-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    const tableAssetsDir = join(dir, "source-tables")
    writeDocx(docxPath, [
      "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Data and Interface Requirements</w:t></w:r></w:p>",
      "<w:p><w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr><w:r><w:t>Hardware Interfaces</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>CAN bus communication.</w:t></w:r></w:p>",
      makeTableXml("CAN Overview"),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-3.1", level: 2, title: "Hardware Interfaces" }],
      segments: [{ segment_id: "SRS-3.1", level: 2, title: "Hardware Interfaces", text: "CAN bus communication." }],
    }, {
      table_assets_dir: tableAssetsDir,
    })

    const table = artifact.sections[0].tables[0]
    expect(artifact.sections[0].tables).toHaveLength(1)
    expect(artifact.sections[0].source_ref).toBe("SRS-3.1")
    expect(table.title).toBe("Merged Header")
    expect(table.table_id).toBe("SRS-3.1::table-1")
    expect(table.table_asset?.path).toBe(join(tableAssetsDir, "SRS-3.1__table-1.xml"))
    expect(table.table_asset?.source_path).toBe(docxPath)
    expect(table.table_asset).not.toHaveProperty("table_index")
    expect(existsSync(table.table_asset!.path)).toBe(true)
    expect(readFileSync(table.table_asset!.path, "utf-8")).toContain("<w:gridSpan w:val=\"2\"/>")
    expect(existsSync(table.table_asset!.styles_path!)).toBe(true)
  })

  test("filters OLE or Visio object container tables from DOCX source tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-ole-table-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    const tableAssetsDir = join(dir, "source-tables")
    writeDocx(docxPath, [
      heading(1, "Data and Interface Requirements"),
      heading(2, "Hardware Interfaces"),
      makeOleObjectTableXml(),
      paragraph("表 B-1 Fast Telemetry Transfer Format"),
      makeProtocolTableXml([
        ["Frame Sequence", "Control Field", "Data Field"],
        ["1.", "86H", "04H"],
      ]),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-B.1", level: 2, title: "Hardware Interfaces" }],
      segments: [{ segment_id: "SRS-B.1", level: 2, title: "Hardware Interfaces", text: "" }],
    }, {
      table_assets_dir: tableAssetsDir,
    })

    expect(artifact.sections[0].tables).toHaveLength(1)
    expect(artifact.sections[0].tables[0].table_id).toBe("SRS-B.1::table-1")
    expect(artifact.sections[0].tables[0].title).toBe("表 B-1 Fast Telemetry Transfer Format")
    expect(readFileSync(artifact.sections[0].tables[0].table_asset!.path, "utf-8")).toContain("Frame Sequence")
    expect(readFileSync(artifact.sections[0].tables[0].table_asset!.path, "utf-8")).not.toContain("OLEObject")
  })

  test("sanitizes image and relationship references when saving DOCX table assets", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-image-table-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    const tableAssetsDir = join(dir, "source-tables")
    writeDocx(docxPath, [
      heading(1, "Data and Interface Requirements"),
      heading(2, "Hardware Interfaces"),
      paragraph("Table with an illustrative image in one cell."),
      makeImageRelationTableXml(),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-4.4.2.1", level: 2, title: "Hardware Interfaces" }],
      segments: [{ segment_id: "SRS-4.4.2.1", level: 2, title: "Hardware Interfaces", text: "" }],
    }, {
      table_assets_dir: tableAssetsDir,
    })

    const table = artifact.sections[0].tables[0]
    const savedXml = readFileSync(table.table_asset!.path, "utf-8")
    expect(artifact.sections[0].tables).toHaveLength(1)
    expect(table).not.toHaveProperty("rows")
    expect(table.table_html).toContain("<table>")
    expect(table.table_html).toContain("Signal")
    expect(table.table_html).toContain("Payload<br>Linked manual")
    expect(table.table_html).toContain("CAN-ID")
    expect(savedXml).toContain("Signal")
    expect(savedXml).toContain("Linked manual")
    expect(savedXml).not.toContain("<w:drawing")
    expect(savedXml).not.toContain("<a:blip")
    expect(savedXml).not.toContain("r:embed=")
    expect(savedXml).not.toContain("r:link=")
    expect(savedXml).not.toContain("r:id=")
  })

  test("adds canonical prefixed section source_refs when requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-source-ref-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Protocol</w:t></w:r></w:p>",
      "<w:p><w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr><w:r><w:t>Broadcast Data</w:t></w:r></w:p>",
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-8.4", level: 2, title: "Broadcast Data" }],
      segments: [{ segment_id: "SRS-8.4", level: 2, title: "Broadcast Data", text: "CAN broadcast data." }],
    }, {
      table_id_prefix: "supporting-002-protocol",
      source_ref_prefix: "supporting-002-protocol",
    })

    expect(artifact.sections[0].section_id).toBe("SRS-8.4")
    expect(artifact.sections[0].source_ref).toBe("supporting-002-protocol::SRS-8.4")
  })

  test("rebuilds section text in DOCX body order with one canonical table placeholder", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-placeholder-"))
    TEMP_DIRS.push(dir)
    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      heading(1, "Requirements"),
      heading(2, "Hardware Interfaces"),
      paragraph("Before table."),
      paragraph("表 3.1-1 Interface format"),
      makeProtocolTableXml([["Field", "Value"], ["ID", "01H"]]),
      paragraph("After table."),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-3.1", level: 2, title: "Hardware Interfaces" }],
      segments: [{ segment_id: "SRS-3.1", level: 2, title: "Hardware Interfaces", text: "stale\n| wrong | table |" }],
    }, { table_id_prefix: "primary", source_ref_prefix: "primary" })

    expect(artifact.sections[0].text).toBe("Before table.\n表 3.1-1 Interface format\n[表格：primary::SRS-3.1::table-1]\nAfter table.")
    expect(artifact.sections[0].tables[0].table_id).toBe("primary::SRS-3.1::table-1")
    expect(artifact.sections[0].tables[0]).not.toHaveProperty("rows")
  })

  test("assigns body content before the first heading to the preamble section", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-preamble-"))
    TEMP_DIRS.push(dir)
    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      paragraph("Cover title"),
      paragraph("目录"),
      paragraph("1 引言 ........ 3"),
      heading(1, "Introduction"),
      paragraph("Chapter body."),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [
        { segment_id: "SRS-PREAMBLE", level: 1, title: "文档前置内容" },
        { segment_id: "SRS-1", level: 1, title: "Introduction" },
      ],
      segments: [
        { segment_id: "SRS-PREAMBLE", level: 1, title: "文档前置内容", text: "stale preamble" },
        { segment_id: "SRS-1", level: 1, title: "Introduction", text: "stale body" },
      ],
    })

    expect(artifact.sections[0].section_id).toBe("SRS-PREAMBLE")
    expect(artifact.sections[0].text).toBe("Cover title\n目录\n1 引言 ........ 3")
    expect(artifact.sections[1].text).toBe("Chapter body.")
  })

  test("falls back to canonical section order when heading styles are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-fallback-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    const tableAssetsDir = join(dir, "source-tables")
    writeDocx(docxPath, [
      "<w:p><w:r><w:t>3 Data and Interface Requirements</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>3.1 Hardware Interfaces</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>Software communicates over CAN.</w:t></w:r></w:p>",
      makeTableXml("Request Frame"),
    ].join(""), [
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
      "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
      "<w:style w:type=\"paragraph\" w:styleId=\"BodyText\"><w:name w:val=\"Body Text\"/></w:style>",
      "</w:styles>",
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-3.1", level: 2, title: "Hardware Interfaces" }],
      segments: [{ segment_id: "SRS-3.1", level: 2, title: "Hardware Interfaces", text: "Software communicates over CAN." }],
    }, {
      table_assets_dir: tableAssetsDir,
    })

    const table = artifact.sections[0].tables[0]
    expect(artifact.sections[0].tables).toHaveLength(1)
    expect(table.table_id).toBe("SRS-3.1::table-1")
    expect(table.table_asset?.section_id).toBe("SRS-3.1")
    expect(readFileSync(table.table_asset!.path, "utf-8")).toContain("Request Frame")
  })

  test("keeps assigning tables when styled headings are followed by plain chapter and appendix headings", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-mixed-headings-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    const tableAssetsDir = join(dir, "source-tables")
    writeDocx(docxPath, [
      heading(1, "前置章节"),
      makeTableXml("Front Table"),
      paragraph("5 后续需求"),
      makeTableXml("Later Table"),
      paragraph("附录 A 接口数据定义"),
      makeTableXml("Appendix Table"),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [
        { segment_id: "SRS-1", level: 1, title: "前置章节" },
        { segment_id: "SRS-5", level: 1, title: "后续需求" },
        { segment_id: "SRS-A", level: 1, title: "接口数据定义" },
      ],
      segments: [
        { segment_id: "SRS-1", level: 1, title: "前置章节", text: "" },
        { segment_id: "SRS-5", level: 1, title: "后续需求", text: "" },
        { segment_id: "SRS-A", level: 1, title: "接口数据定义", text: "" },
      ],
    }, {
      table_assets_dir: tableAssetsDir,
    })

    expect(artifact.sections.map((section) => section.tables.length)).toEqual([1, 1, 1])
    expect(artifact.sections[0].tables[0].table_id).toBe("SRS-1::table-1")
    expect(artifact.sections[1].tables[0].table_id).toBe("SRS-5::table-1")
    expect(artifact.sections[2].tables[0].table_id).toBe("SRS-A::table-1")
    expect(readFileSync(artifact.sections[2].tables[0].table_asset!.path, "utf-8")).toContain("Appendix Table")
  })

  test("matches appendix prefixes like B.1 during fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-appendix-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    const tableAssetsDir = join(dir, "source-tables")
    writeDocx(docxPath, [
      "<w:p><w:r><w:t>Appendix B Telemetry and Command Data Definition</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>B.1 Fast Telemetry Polling and Response Format</w:t></w:r></w:p>",
      makeTableXml("Fast Telemetry Transfer Format"),
    ].join(""), [
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
      "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
      "<w:style w:type=\"paragraph\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/></w:style>",
      "</w:styles>",
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [
        { segment_id: "SRS-B", level: 1, title: "Telemetry and Command Data Definition" },
        { segment_id: "SRS-B.1", level: 2, title: "Fast Telemetry Polling and Response Format" },
      ],
      segments: [
        { segment_id: "SRS-B", level: 1, title: "Telemetry and Command Data Definition", text: "" },
        { segment_id: "SRS-B.1", level: 2, title: "Fast Telemetry Polling and Response Format", text: "" },
      ],
    }, {
      table_assets_dir: tableAssetsDir,
    })

    expect(artifact.sections[0].tables).toHaveLength(0)
    expect(artifact.sections[1].tables).toHaveLength(1)
    expect(artifact.sections[1].tables[0].table_id).toBe("SRS-B.1::table-1")
    expect(artifact.sections[1].tables[0].table_asset?.section_id).toBe("SRS-B.1")
    expect(artifact.sections[1].tables[0].table_asset?.section_title).toBe("Fast Telemetry Polling and Response Format")
  })

  test("prefers the caption paragraph before a DOCX table", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-caption-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Appendix B</w:t></w:r></w:p>",
      "<w:p><w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr><w:r><w:t>Hardware Interfaces</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>表 B-1 Fast Telemetry Transfer Format</w:t></w:r></w:p>",
      makeProtocolTableXml([
        ["Frame Sequence", "Control Field", "Data Field"],
        ["1.", "86H", "04H"],
      ]),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-B.1", level: 2, title: "Hardware Interfaces" }],
      segments: [{ segment_id: "SRS-B.1", level: 2, title: "Hardware Interfaces", text: "" }],
    })

    expect(artifact.sections[0].tables).toHaveLength(1)
    expect(artifact.sections[0].tables[0].title).toBe("表 B-1 Fast Telemetry Transfer Format")
  })

  test("does not reuse an older table caption across intervening prose", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-caption-distance-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>5 功能需求</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>表 5.2-17 上注重构数据包传输格式</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>星务计算机每秒发送时间广播数据。</w:t></w:r></w:p>",
      makeProtocolTableXml([
        ["帧序号", "仲裁场、控制场", "有效数据场"],
        ["1", "4FH 08H", "80H W0 W1 W2 W3 W4 W5 SUM"],
      ]),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-5.2", level: 1, title: "功能需求" }],
      segments: [{ segment_id: "SRS-5.2", level: 1, title: "功能需求", text: "" }],
    })

    expect(artifact.sections[0].tables).toHaveLength(1)
    expect(artifact.sections[0].tables[0].title).toBe("表格1")
    expect(artifact.sections[0].tables[0].title).not.toContain("上注重构")
  })

  test("recognizes 表格 and 附表 prefixes as valid table captions", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-caption-prefixes-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Appendix B</w:t></w:r></w:p>",
      "<w:p><w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr><w:r><w:t>Hardware Interfaces</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>表格 B-3 Fast Telemetry Summary</w:t></w:r></w:p>",
      makeProtocolTableXml([
        ["序号", "Data ID", "Name"],
        ["1.", "W0", "Voltage"],
      ]),
      "<w:p><w:r><w:t>附表 B-11 Charge Parameter Data Block</w:t></w:r></w:p>",
      makeProtocolTableXml([
        ["序号", "Data", "说明"],
        ["1.", "W0", "55H"],
      ]),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-B", level: 2, title: "Hardware Interfaces" }],
      segments: [{ segment_id: "SRS-B", level: 2, title: "Hardware Interfaces", text: "" }],
    })

    expect(artifact.sections[0].tables).toHaveLength(2)
    expect(artifact.sections[0].tables[0].title).toBe("表格 B-3 Fast Telemetry Summary")
    expect(artifact.sections[0].tables[1].title).toBe("附表 B-11 Charge Parameter Data Block")
  })

  test("uses visible SEQ field text as a table caption during sequence fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-seq-caption-"))
    TEMP_DIRS.push(dir)
    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      paragraph("接收时间广播与内部时间维护功能"),
      "<w:p><w:r><w:t>表 </w:t></w:r><w:fldSimple w:instr=\" SEQ 表 \"><w:r><w:fldChar w:fldCharType=\"begin\"/><w:instrText>SEQ 表</w:instrText><w:t>5.2-7</w:t><w:fldChar w:fldCharType=\"end\"/></w:r></w:fldSimple><w:r><w:t> 星务时间广播传输格式</w:t></w:r></w:p>",
      makeProtocolTableXml([["帧序号", "有效数据场"], ["1", "W0～W5"]]),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-5.2.4", level: 3, title: "接收时间广播与内部时间维护功能" }],
      segments: [{ segment_id: "SRS-5.2.4", level: 3, title: "接收时间广播与内部时间维护功能", text: "" }],
    })

    expect(artifact.sections[0].tables).toHaveLength(1)
    expect(artifact.sections[0].tables[0].title).toBe("表 5.2-7 星务时间广播传输格式")
  })

  test("uses an escaped Markdown caption only when the OOXML table title is generic", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-text-caption-"))
    TEMP_DIRS.push(dir)
    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      heading(3, "接收时间广播与内部时间维护功能"),
      makeProtocolTableXml([["参数名称", "说明"], ["星务时间秒", "UTC累计秒"]]),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-5.2.4", level: 3, title: "接收时间广播与内部时间维护功能" }],
      segments: [{
        segment_id: "SRS-5.2.4",
        level: 3,
        title: "接收时间广播与内部时间维护功能",
        text: "时间广播内容如下表所示。\n表 5\\.2-8 星务时间广播内容",
      }],
    })

    expect(artifact.sections[0].tables).toHaveLength(1)
    expect(artifact.sections[0].tables[0].title).toBe("表 5.2-8 星务时间广播内容")
  })

  test("inherits the previous explicit table title for continuation tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-continuation-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Appendix B</w:t></w:r></w:p>",
      "<w:p><w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr><w:r><w:t>Indirect Commands</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>表 B-3 Indirect Command and Response Format</w:t></w:r></w:p>",
      makeProtocolTableXml([
        ["序号", "Command Name", "Type", "Code"],
        ["1.", "Command 1", "Pulse", "A301AAAAH"],
        ["2.", "Command 2", "Pulse", "A302AAAAH"],
      ]),
      makeProtocolTableXml([
        ["3.", "Command 3", "Level", "A303AAAAH"],
        ["4.", "Command 4", "Level", "A304AAAAH"],
      ]),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-B.3", level: 2, title: "Indirect Commands" }],
      segments: [{ segment_id: "SRS-B.3", level: 2, title: "Indirect Commands", text: "" }],
    })

    expect(artifact.sections[0].tables).toHaveLength(2)
    expect(artifact.sections[0].tables[0].title).toBe("表 B-3 Indirect Command and Response Format")
    expect(artifact.sections[0].tables[1].title).toBe("表 B-3 Indirect Command and Response Format")
  })

  test("inherits the previous title for back-to-back untitled split tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-split-table-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Appendix B</w:t></w:r></w:p>",
      "<w:p><w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr><w:r><w:t>Indirect Commands</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>表 B-7 Indirect Command Format</w:t></w:r></w:p>",
      makeProtocolTableXml([
        ["帧序号", "仲裁场、控制场", "有效数据场", "说明"],
        ["1.", "86H", "04H", ""],
      ]),
      makeProtocolTableXml([
        ["序号", "ID10～ID3", "ID2～ID0 ，RTR ，DLC", ""],
        ["1.", "46H", "44H", ""],
      ]),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [{ segment_id: "SRS-B.3", level: 2, title: "Indirect Commands" }],
      segments: [{ segment_id: "SRS-B.3", level: 2, title: "Indirect Commands", text: "" }],
    })

    expect(artifact.sections[0].tables).toHaveLength(2)
    expect(artifact.sections[0].tables[0].title).toBe("表 B-7 Indirect Command Format")
    expect(artifact.sections[0].tables[1].title).toBe("表 B-7 Indirect Command Format")
  })

  test("keeps table ranges aligned after earlier tables with cell paragraphs", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-structure-table-offset-"))
    TEMP_DIRS.push(dir)

    const docxPath = join(dir, "requirements.docx")
    writeDocx(docxPath, [
      heading(1, "Introduction"),
      paragraph("表 1-1 Introduction Table"),
      makeProtocolTableXml([
        ["Name", "Value"],
        ["Intro", "A"],
      ]),
      heading(1, "Safety Mode"),
      paragraph("表 2-1 Safety Mode Table"),
      makeProtocolTableXml([
        ["Condition", "Status"],
        ["Mode 1", "Bit7=1"],
      ]),
    ].join(""))

    const artifact = buildDocumentStructureArtifact(docxPath, {
      format: "docx",
      toc: [
        { segment_id: "SRS-1", level: 1, title: "Introduction" },
        { segment_id: "SRS-2", level: 1, title: "Safety Mode" },
      ],
      segments: [
        { segment_id: "SRS-1", level: 1, title: "Introduction", text: "" },
        { segment_id: "SRS-2", level: 1, title: "Safety Mode", text: "" },
      ],
    })

    expect(artifact.sections[0].tables).toHaveLength(1)
    expect(artifact.sections[0].tables[0].title).toBe("表 1-1 Introduction Table")
    expect(artifact.sections[1].tables).toHaveLength(1)
    expect(artifact.sections[1].tables[0].title).toBe("表 2-1 Safety Mode Table")
  })

})

test("persists full diagnostics separately and clears stale warnings on regeneration", () => {
  const dir = mkdtempSync(join(tmpdir(), "structure-diagnostics-"))
  TEMP_DIRS.push(dir)
  const path = join(dir, "document-structure.json")
  const artifact = buildDocumentStructureArtifact(join(dir, "input.txt"), {
    format: "txt",
    segments: Array.from({ length: 1000 }, (_, i) => ({ segment_id: "SRS-001", title: `Heading ${i}`, level: 1, text: `Body ${i}` })),
  })
  expect(artifact.warnings!.length).toBeGreaterThan(900)
  writeFileSync(path, JSON.stringify(artifact)) // Legacy artifact with inline warnings.
  const result = writeDocumentStructureArtifacts(path, artifact)
  const stored = JSON.parse(readFileSync(path, "utf-8"))
  expect(stored.warnings).toBeUndefined()
  expect(stored.sections).toEqual(artifact.sections)
  expect(result.structure_warnings_path).toBe(join(dir, "document-structure-warn.json"))
  expect(JSON.parse(readFileSync(result.structure_warnings_path, "utf-8"))).toEqual({
    structure_path: path, warning_count: artifact.warnings!.length, warnings: artifact.warnings,
  })
  writeDocumentStructureArtifacts(path, { ...artifact, warnings: [] })
  expect(JSON.parse(readFileSync(result.structure_warnings_path, "utf-8"))).toEqual({
    structure_path: path, warning_count: 0, warnings: [],
  })
})
