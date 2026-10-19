import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { filldataPhase2Workflow } from "../../src/tools"
import { readZip, writeZip } from "../../src/tools/docx-zip"
import { renderFunctionalInitContentDocx } from "../../src/tools/functional-init-content-docx"

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

function writeJson(path: string, value: unknown) {
  // Legacy fixture builders omit flows; provide explicit raw-contract fields.
  if (path.endsWith(".raw.json") && value && typeof value === "object" && Array.isArray((value as any).items)) {
    for (const item of (value as any).items) {
      item.input_flow ??= ["无。"]
      item.output_flow ??= ["无。"]
      item.processing ??= []
    }
  }
  if ((path.endsWith("requirements-section-list.json") || path.endsWith("req-document-structure.json")) && value && typeof value === "object") {
    for (const section of Array.isArray((value as any).sections) ? (value as any).sections : []) {
      for (const table of Array.isArray(section.tables) ? section.tables : []) {
        if (Array.isArray(table.rows) && !table.table_html) {
          table.table_html = `<table>${table.rows.map((row: unknown[]) => `<tr>${row.map((cell) => `<td>${String(cell)}</td>`).join("")}</tr>`).join("")}</table>`
          delete table.rows
        }
      }
    }
  }
  if (path.endsWith("hardware-interface-model.raw.json") && value && typeof value === "object" && Array.isArray((value as any).blocks)) {
    const legacy = value as any
    value = {
      model_version: 2,
      chapter_title: legacy.chapter_title,
      section_title: legacy.section_title,
      interfaces: legacy.blocks.map((block: any, index: number) => ({
        candidate_id: `HI-${String(index + 1).padStart(3, "0")}`,
        interface_id: `IF-LEGACY-${String(index + 1).padStart(3, "0")}`,
        interface_name: block.title || block.interface_type || `硬件接口${index + 1}`,
        interface_kind: block.interface_type || "other",
        title: block.title || `${block.interface_type || "硬件接口"}及相关数据流`,
        overview: [block.overview, ...(block.acquisition_processes || []).map((process: any) => process.content), block.timing_description].filter(Boolean).join(" "),
        source_refs: block.source_refs || block.subsections?.[0]?.source_refs || block.acquisition_processes?.[0]?.source_refs || [],
        overview_tables: block.overview_tables || [],
        topics: [
          ...(block.acquisition_processes || []).map((process: any) => ({
            title: process.title,
            source_refs: process.source_refs || block.source_refs || [],
            input_flow: "", input_tables: [], output_flow: "", output_tables: [],
          })),
          ...(block.timing_description ? [{
            title: "串口接收和发送时序说明",
            source_refs: block.source_refs || [],
            input_flow: "", input_tables: [], output_flow: "", output_tables: [],
          }] : []),
          ...(block.subsections || []).map((topic: any) => ({
            title: topic.title, source_refs: topic.source_refs,
            input_flow: topic.input_flow, input_tables: topic.input_tables,
            output_flow: topic.output_flow, output_tables: topic.output_tables,
          })),
        ],
        input_flow: block.input_flow || "",
        input_tables: block.input_tables || [],
        output_flow: block.output_flow || "",
        output_tables: block.output_tables || [],
      })),
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

function writeDocx(path: string, bodyXml: string, stylesXml?: string, numberingXml?: string) {
  const entries = [
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
          numberingXml ? "<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>" : "",
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
  ]

  if (numberingXml) {
    entries.push({
      path: "word/numbering.xml",
      data: Buffer.from(numberingXml, "utf-8"),
    })
  }

  const zipBuffer = writeZip(entries)

  writeFileSync(path, zipBuffer)
}

function tableXml(cells: string[], width = 7200) {
  return [
    "<w:tbl>",
    `<w:tblPr><w:tblStyle w:val="ProtoTable"/><w:tblW w:w="${width}" w:type="dxa"/></w:tblPr>`,
    "<w:tblGrid><w:gridCol w:w=\"2400\"/><w:gridCol w:w=\"2400\"/><w:gridCol w:w=\"2400\"/></w:tblGrid>",
    "<w:tr>",
    ...cells.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`),
    "</w:tr>",
    "</w:tbl>",
  ].join("")
}

function tableCellXml(text: string, options: { gridSpan?: number; vMerge?: "restart" | "continue" } = {}) {
  const props = [
    "<w:tcPr><w:tcW w:w=\"1200\" w:type=\"dxa\"/>",
    options.gridSpan && options.gridSpan > 1 ? `<w:gridSpan w:val="${options.gridSpan}"/>` : "",
    options.vMerge === "restart" ? "<w:vMerge w:val=\"restart\"/>" : "",
    options.vMerge === "continue" ? "<w:vMerge/>" : "",
    "</w:tcPr>",
  ].join("")
  return `<w:tc>${props}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
}

function tableRowXml(cells: string[]) {
  return `<w:tr>${cells.join("")}</w:tr>`
}

function mergedTelemetryFrameTableXml() {
  return [
    "<w:tbl>",
    "<w:tblPr><w:tblStyle w:val=\"ProtoTable\"/><w:tblW w:w=\"14400\" w:type=\"dxa\"/></w:tblPr>",
    "<w:tblGrid>",
    Array.from({ length: 12 }, () => "<w:gridCol w:w=\"1200\"/>").join(""),
    "</w:tblGrid>",
    tableRowXml([
      tableCellXml("帧序号", { vMerge: "restart" }),
      tableCellXml("仲裁场、控制场", { gridSpan: 2 }),
      tableCellXml("有效数据场", { gridSpan: 8 }),
      tableCellXml("说明", { vMerge: "restart" }),
    ]),
    tableRowXml([
      tableCellXml("", { vMerge: "continue" }),
      tableCellXml("1"),
      tableCellXml("2"),
      ...["3", "4", "5", "6", "7", "8", "9", "10"].map((value) => tableCellXml(value, { vMerge: "restart" })),
      tableCellXml("", { vMerge: "continue" }),
    ]),
    tableRowXml([
      tableCellXml("", { vMerge: "continue" }),
      tableCellXml("ID10~ID3"),
      tableCellXml("ID2~ID0, RTR, DLC"),
      ...Array.from({ length: 8 }, () => tableCellXml("", { vMerge: "continue" })),
      tableCellXml("", { vMerge: "continue" }),
    ]),
    tableRowXml([
      tableCellXml("1."),
      tableCellXml("8DH"),
      tableCellXml("04H"),
      tableCellXml("T00H"),
      tableCellXml("10H"),
      tableCellXml("01H"),
      tableCellXml("SUM"),
      ...Array.from({ length: 5 }, () => tableCellXml("")),
    ]),
    "</w:tbl>",
  ].join("")
}

function heading(level: 1 | 2, text: string, styleId = `Heading${level}`) {
  return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
}

function numberedHeading(level: 1 | 2, text: string, styleId = `Heading${level}`) {
  return [
    "<w:p><w:pPr>",
    `<w:pStyle w:val="${styleId}"/>`,
    `<w:numPr><w:ilvl w:val="${level - 1}"/><w:numId w:val="1"/></w:numPr>`,
    "</w:pPr>",
    `<w:r><w:t>${text}</w:t></w:r>`,
    "</w:p>",
  ].join("")
}

function headingNumberingXml() {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    "<w:abstractNum w:abstractNumId=\"0\">",
    "<w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"decimal\"/><w:lvlText w:val=\"%1\"/></w:lvl>",
    "<w:lvl w:ilvl=\"1\"><w:start w:val=\"1\"/><w:numFmt w:val=\"decimal\"/><w:lvlText w:val=\"%1.%2\"/></w:lvl>",
    "</w:abstractNum>",
    "<w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num>",
    "</w:numbering>",
  ].join("")
}

function paragraph(text: string) {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
}

function outlineParagraph(text: string, outlineLevel = 3) {
  return [
    "<w:p><w:pPr>",
    `<w:outlineLvl w:val="${outlineLevel}"/>`,
    "</w:pPr>",
    `<w:r><w:t>${text}</w:t></w:r>`,
    "</w:p>",
  ].join("")
}

function expectIndentedParagraph(documentXml: string, text: string) {
  const paragraphs = Array.from(documentXml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)).map((match) => match[0])
  const matchingParagraph = paragraphs.find((paragraphXml) => paragraphXml.includes(text))
  expect(matchingParagraph, `${text} should be rendered as a two-character indented paragraph`).toBeDefined()
  expect(matchingParagraph).toContain('<w:ind w:firstLineChars="200"/>')
  expect(matchingParagraph).not.toContain('<w:ind w:left="480"/>')
}

function writeTableAsset(path: string, xml: string, sourcePath: string, sectionId: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, xml, "utf-8")
  const stylesPath = join(dirname(path), "source-styles.xml")
  writeFileSync(stylesPath, [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    "<w:style w:type=\"table\" w:styleId=\"ProtoTable\"><w:name w:val=\"ProtoTable\"/></w:style>",
    "</w:styles>",
  ].join(""), "utf-8")
  return {
    kind: "docx_table_xml",
    path,
    styles_path: stylesPath,
    source_path: sourcePath,
    section_id: sectionId,
    section_title: sectionId,
  }
}

function writeFunctionalSourceArtifacts(dir: string) {
  const matrixDir = join(dir, ".matrix", "data")
  const structurePath = join(matrixDir, "req-document-structure.json")
  const sourceArtifactsPath = join(matrixDir, "source-artifacts.json")
  const sections = [
    { section_id: "SRS-3.2", source_ref: "primary::SRS-3.2", title: "能力需求", level: 2 },
    { section_id: "SRS-3.2.1", source_ref: "primary::SRS-3.2.1", title: "初始化功能", level: 3 },
    { section_id: "SRS-3.2.1.1", source_ref: "primary::SRS-3.2.1.1", title: "80C32 控制器初始化", level: 4 },
    { section_id: "SRS-3.2.1.2", source_ref: "primary::SRS-3.2.1.2", title: "CAN 控制器初始化", level: 4 },
    { section_id: "SRS-3.2.2", source_ref: "primary::SRS-3.2.2", title: "解析执行总线指令", level: 3 },
    { section_id: "SRS-3.2.2.1", source_ref: "primary::SRS-3.2.2.1", title: "轮询控制处理", level: 4 },
    { section_id: "SRS-3.2.2.2", source_ref: "primary::SRS-3.2.2.2", title: "说明", level: 4 },
    { section_id: "SRS-3.3", source_ref: "primary::SRS-3.3", title: "其他需求", level: 2 },
  ].map((section) => ({
    ...section,
    text: "",
    tables: [],
  }))
  writeJson(structurePath, {
    file_path: join(dir, "requirements.docx"),
    format: "docx",
    total_sections: sections.length,
    sections,
  })
  writeJson(sourceArtifactsPath, {
    source_plan_path: join(matrixDir, "source-plan.json"),
    primary_document: {
      path: join(dir, "requirements.docx"),
      role: "primary_srs",
      format: "docx",
      segments_path: join(matrixDir, "req-segments.json"),
      toc_path: join(matrixDir, "req-segments-toc.json"),
      structure_path: structurePath,
    },
    supporting_documents: [],
  })
  writeFileSync(join(matrixDir, "hardware-interface-report-text.md"), "# 3.1 硬件接口\n\n表3.1-1 接口定义\n", "utf-8")
  writeJson(join(matrixDir, "chapter2-system-overview.json"), { processor_type: "80C32", memory_io_summary: "" })
  writeJson(join(matrixDir, "hardware-interface-model.json"), { model_version: 2, interfaces: [] })
  return { sourceArtifactsPath }
}

function writeReorderedFunctionalSourceArtifacts(dir: string) {
  const matrixDir = join(dir, ".matrix", "data")
  const structurePath = join(matrixDir, "req-document-structure.json")
  const sourceArtifactsPath = join(matrixDir, "source-artifacts.json")
  const sections = [
    { section_id: "SRS-5.3", source_ref: "primary::SRS-5.3", title: "功能需求", level: 2 },
    { section_id: "SRS-5.3.1", source_ref: "primary::SRS-5.3.1", title: "BootLoader程序功能要求", level: 3 },
    { section_id: "SRS-5.3.2", source_ref: "primary::SRS-5.3.2", title: "初始化功能", level: 3 },
    { section_id: "SRS-5.3.2.1", source_ref: "primary::SRS-5.3.2.1", title: "控制器初始化", level: 4 },
    { section_id: "SRS-5.3.3", source_ref: "primary::SRS-5.3.3", title: "其他功能", level: 3 },
  ].map((section) => ({
    ...section,
    text: "",
    tables: [],
  }))
  writeJson(structurePath, {
    file_path: join(dir, "requirements.docx"),
    format: "docx",
    total_sections: sections.length,
    sections,
  })
  writeJson(sourceArtifactsPath, {
    source_plan_path: join(matrixDir, "source-plan.json"),
    primary_document: {
      path: join(dir, "requirements.docx"),
      role: "primary_srs",
      format: "docx",
      segments_path: join(matrixDir, "req-segments.json"),
      toc_path: join(matrixDir, "req-segments-toc.json"),
      structure_path: structurePath,
    },
    supporting_documents: [],
  })
  return { sourceArtifactsPath }
}

function writeGuidanceBeforeInitSourceArtifacts(dir: string) {
  const matrixDir = join(dir, ".matrix", "data")
  const structurePath = join(matrixDir, "req-document-structure.json")
  const sourceArtifactsPath = join(matrixDir, "source-artifacts.json")
  const sections = [
    { section_id: "SRS-5.2", source_ref: "primary::SRS-5.2", title: "功能需求", level: 2 },
    { section_id: "SRS-5.2.1", source_ref: "primary::SRS-5.2.1", title: "引导加载", level: 3 },
    { section_id: "SRS-5.2.2", source_ref: "primary::SRS-5.2.2", title: "初始化", level: 3 },
    { section_id: "SRS-5.2.3", source_ref: "primary::SRS-5.2.3", title: "接收处理 Spacewire 总线上注数据", level: 3 },
    { section_id: "SRS-5.2.4", source_ref: "primary::SRS-5.2.4", title: "接收处理一级 CAN 总线数据", level: 3 },
    { section_id: "SRS-5.2.4.1", source_ref: "primary::SRS-5.2.4.1", title: "轮询指令处理", level: 4 },
    { section_id: "SRS-5.2.4.2", source_ref: "primary::SRS-5.2.4.2", title: "遥控指令", level: 4 },
    { section_id: "SRS-5.2.5", source_ref: "primary::SRS-5.2.5", title: "采集处理遥测数据", level: 3 },
  ].map((section) => ({
    ...section,
    text: "",
    tables: [],
  }))
  writeJson(structurePath, {
    file_path: join(dir, "requirements.docx"),
    format: "docx",
    total_sections: sections.length,
    sections,
  })
  writeJson(sourceArtifactsPath, {
    source_plan_path: join(matrixDir, "source-plan.json"),
    primary_document: {
      path: join(dir, "requirements.docx"),
      role: "primary_srs",
      format: "docx",
      segments_path: join(matrixDir, "req-segments.json"),
      toc_path: join(matrixDir, "req-segments-toc.json"),
      structure_path: structurePath,
    },
    supporting_documents: [],
  })
  return { sourceArtifactsPath }
}

function writeFunctionalTitleTreeArtifact(dir: string) {
  const titleTreePath = join(dir, ".matrix", "data", "functional-test-title-tree.json")
  writeJson(titleTreePath, {
    chapter_title_no: "4",
    chapter_title: "测试类型说明",
    section_title_no: "4.1",
    section_title: "功能测试",
    functional_root_source_ref: "primary::SRS-3.2",
    root_title: "能力需求",
    routing: {
      has_initialization: true,
      initialization_title_no: "4.1.1",
      initialization_source_ref: "primary::SRS-3.2.1",
    },
    children: [
      {
        title_no: "4.1.1",
        title: "初始化功能需求项",
        source_ref: "primary::SRS-3.2.1",
        children: [
          {
            title_no: "4.1.1.1",
            title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
            tr_code: "TR-GN-80C32Init",
            source_ref: "primary::SRS-3.2.1.1",
            children: [],
          },
          {
            title_no: "4.1.1.2",
            title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
            tr_code: "TR-GN-CANInit",
            source_ref: "primary::SRS-3.2.1.2",
            children: [],
          },
        ],
      },
      {
        title_no: "4.1.2",
        title: "解析执行总线指令功能需求项",
        source_ref: "primary::SRS-3.2.2",
        children: [
          {
            title_no: "4.1.2.1",
            title: "轮询控制处理功能需求项[TR-GN-PollCtrl]",
            tr_code: "TR-GN-PollCtrl",
            source_ref: "primary::SRS-3.2.2.1",
            children: [],
          },
        ],
      },
    ],
    skipped_source_refs: ["primary::SRS-3.2.2.2"],
  })
  return titleTreePath
}

function writeFunctionalOtherSourceArtifacts(dir: string) {
  const matrixDir = join(dir, ".matrix", "data")
  const requirementsPath = join(dir, "requirements.docx")
  const structurePath = join(matrixDir, "req-document-structure.json")
  const sourceArtifactsPath = join(matrixDir, "source-artifacts.json")
  const stylesXml = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    "<w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"Heading 1\"/><w:pPr><w:outlineLvl w:val=\"0\"/></w:pPr></w:style>",
    "<w:style w:type=\"paragraph\" w:styleId=\"CnHeading2\"><w:name w:val=\"标题 2\"/><w:pPr><w:outlineLvl w:val=\"1\"/></w:pPr></w:style>",
    "<w:style w:type=\"table\" w:styleId=\"ProtoTable\"><w:name w:val=\"ProtoTable\"/></w:style>",
    "</w:styles>",
  ].join("")
  writeDocx(requirementsPath, [
    numberedHeading(1, "能力需求"),
    numberedHeading(2, "初始化功能", "CnHeading2"),
    paragraph("控制器初始化用于建立默认运行状态。"),
    numberedHeading(2, "遥测采集", "CnHeading2"),
    outlineParagraph("1、引导加载：将PROM/MRAM应用程序搬移到SRAM中运行。"),
    outlineParagraph("处理:"),
    paragraph("PROM 引导程序具备以下功能："),
    heading(2, "1、通过接口HIREQ4.2对SPI总线进行复位;", "CnHeading2"),
    heading(2, "4、延时100us;", "CnHeading2"),
    numberedHeading(2, "AD遥测", "CnHeading2"),
    paragraph("软件通过 AD 采集接口采集 A/D 参数，并生成速变遥测数据和缓变遥测数据。"),
    paragraph("SMU通过CAN总线向下位机发送遥测帧2轮询控制序列，传送格式如表所示。"),
    mergedTelemetryFrameTableXml(),
    numberedHeading(2, "固存数据采集", "CnHeading2"),
    paragraph("软件从固存接口读取数据块并形成固存遥测输出。"),
  ].join(""), stylesXml, headingNumberingXml())
  const sections = [
    { section_id: "SRS-3.2", source_ref: "primary::SRS-3.2", title: "能力需求", level: 2 },
    { section_id: "SRS-3.2.1", source_ref: "primary::SRS-3.2.1", title: "初始化功能", level: 3 },
    { section_id: "SRS-3.2.1.1", source_ref: "primary::SRS-3.2.1.1", title: "控制器初始化", level: 4 },
    { section_id: "SRS-3.2.3", source_ref: "primary::SRS-3.2.3", title: "遥测采集", level: 3 },
    { section_id: "SRS-3.2.3.1", source_ref: "primary::SRS-3.2.3.1", title: "AD遥测", level: 4 },
    { section_id: "SRS-3.2.3.2", source_ref: "primary::SRS-3.2.3.2", title: "固存数据采集", level: 4 },
  ].map((section) => ({
    ...section,
    text: "",
    tables: [],
  }))
  writeJson(structurePath, {
    file_path: requirementsPath,
    format: "docx",
    total_sections: sections.length,
    sections,
  })
  writeJson(sourceArtifactsPath, {
    source_plan_path: join(matrixDir, "source-plan.json"),
    primary_document: {
      path: requirementsPath,
      role: "primary_srs",
      format: "docx",
      segments_path: join(matrixDir, "req-segments.json"),
      toc_path: join(matrixDir, "req-segments-toc.json"),
      structure_path: structurePath,
    },
    supporting_documents: [],
  })
  writeFileSync(join(matrixDir, "hardware-interface-report-text.md"), "# 3.1 硬件接口\n\n表3.1-1 接口定义\n", "utf-8")
  return { sourceArtifactsPath }
}

function writeFunctionalOtherTitleTreeArtifact(dir: string) {
  const titleTreePath = join(dir, ".matrix", "data", "functional-test-title-tree.json")
  writeJson(titleTreePath, {
    chapter_title_no: "4",
    chapter_title: "测试类型说明",
    section_title_no: "4.1",
    section_title: "功能测试",
    functional_root_source_ref: "primary::SRS-3.2",
    root_title: "能力需求",
    routing: {
      has_initialization: true,
      initialization_title_no: "4.1.1",
      initialization_source_ref: "primary::SRS-3.2.1",
    },
    children: [
      {
        title_no: "4.1.1",
        title: "初始化功能需求项",
        source_ref: "primary::SRS-3.2.1",
        children: [
          {
            title_no: "4.1.1.1",
            title: "控制器初始化功能需求项[TR-GN-CtrlInit]",
            tr_code: "TR-GN-CtrlInit",
            source_ref: "primary::SRS-3.2.1.1",
            children: [],
          },
        ],
      },
      {
        title_no: "4.1.2",
        title: "遥测采集功能需求项",
        source_ref: "primary::SRS-3.2.3",
        children: [
          {
            title_no: "4.1.2.1",
            title: "AD遥测功能需求项[TR-GN-YC-AD]",
            tr_code: "TR-GN-YC-AD",
            source_ref: "primary::SRS-3.2.3.1",
            children: [],
          },
          {
            title_no: "4.1.2.2",
            title: "固存数据采集功能需求项[TR-GN-YC-GC]",
            tr_code: "TR-GN-YC-GC",
            source_ref: "primary::SRS-3.2.3.2",
            children: [],
          },
        ],
      },
    ],
    skipped_source_refs: [],
  })
  return titleTreePath
}

function writeFunctionalOtherNoInitArtifacts(dir: string) {
  const matrixDir = join(dir, ".matrix", "data")
  const structurePath = join(matrixDir, "req-document-structure.json")
  const sourceArtifactsPath = join(matrixDir, "source-artifacts.json")
  const titleTreePath = join(matrixDir, "functional-test-title-tree.json")
  const sections = [
    { section_id: "SRS-3.2", source_ref: "primary::SRS-3.2", title: "能力需求", level: 2 },
    { section_id: "SRS-3.2.2", source_ref: "primary::SRS-3.2.2", title: "解析执行总线指令", level: 3 },
    { section_id: "SRS-3.2.2.1", source_ref: "primary::SRS-3.2.2.1", title: "轮询控制处理", level: 4 },
  ].map((section) => ({
    ...section,
    text: "",
    tables: [],
  }))
  writeJson(structurePath, {
    file_path: join(dir, "requirements.docx"),
    format: "docx",
    total_sections: sections.length,
    sections,
  })
  writeJson(sourceArtifactsPath, {
    source_plan_path: join(matrixDir, "source-plan.json"),
    primary_document: {
      path: join(dir, "requirements.docx"),
      role: "primary_srs",
      format: "docx",
      segments_path: join(matrixDir, "req-segments.json"),
      toc_path: join(matrixDir, "req-segments-toc.json"),
      structure_path: structurePath,
    },
    supporting_documents: [],
  })
  writeJson(titleTreePath, {
    chapter_title_no: "4",
    chapter_title: "测试类型说明",
    section_title_no: "4.1",
    section_title: "功能测试",
    functional_root_source_ref: "primary::SRS-3.2",
    root_title: "能力需求",
    routing: {
      has_initialization: false,
      initialization_title_no: null,
      initialization_source_ref: null,
    },
    children: [
      {
        title_no: "4.1.1",
        title: "解析执行总线指令功能需求项",
        source_ref: "primary::SRS-3.2.2",
        children: [
          {
            title_no: "4.1.1.1",
            title: "轮询控制处理功能需求项[TR-GN-PollCtrl]",
            tr_code: "TR-GN-PollCtrl",
            source_ref: "primary::SRS-3.2.2.1",
            children: [],
          },
        ],
      },
    ],
    skipped_source_refs: [],
  })
  return { sourceArtifactsPath, titleTreePath }
}

function writeHardwareInterfaceModelArtifact(dir: string) {
  const modelPath = join(dir, ".matrix", "data", "hardware-interface-model.json")
  writeJson(modelPath, {
    chapter_title: "数据及接口需求",
    section_title: "硬件接口",
    blocks: [
      {
        interface_type: "ad",
        title: "AD 数据采集接口及相关数据流",
        overview: "软件通过 AD 数据采集接口采集 A/D 参数。",
        source_refs: ["primary::SRS-3.2.3.1"],
        input_flow: "A/D 参数。",
        input_tables: [],
        output_flow: "速变遥测数据、缓变遥测数据。",
        output_tables: [],
        acquisition_processes: [],
      },
    ],
  })
  return modelPath
}

function writeHardwareInterfaceReportArtifact(dir: string) {
  const reportPath = join(dir, ".matrix", "reports", "hardware-interface-model.docx")
  mkdirSync(dirname(reportPath), { recursive: true })
  writeDocx(reportPath, [
    heading(1, "3 数据及接口需求"),
    heading(2, "3.1 硬件接口"),
    heading(2, "3.1.1 AD 数据采集接口及相关数据流"),
    paragraph("输入流：A/D 参数。"),
    paragraph("输出流：速变遥测数据、缓变遥测数据。"),
    tableXml(["接口", "输入", "输出"]),
  ].join(""))
  return reportPath
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("filldataPhase2Workflow", () => {
  test("exposes only workflow controls and irreducibly dynamic path lists", () => {
    expect(Object.keys((filldataPhase2Workflow as any).args)).toEqual([
      "mode",
      "hardware_interface_block_raw_paths",
      "functional_other_content_raw_paths",
      "skip_intermediate_report",
      "functional_other_content_worker_batch_index",
      "hardware_interface_worker_batch_index",
      "interface_test_worker_batch_index",
      "allow_code",
    ])
  })

  test("requires candidate-ordered raw paths when merging hardware interfaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-hardware-merge-paths-"))
    TEMP_DIRS.push(dir)
    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      { mode: "merge_hardware_interface_blocks" },
      makeCtx(dir),
    ))

    expect(result.error).toContain("hardware_interface_block_raw_paths is required")
  })

  test("functional init DOCX does not duplicate the section heading when the init section is also a leaf", () => {
    const docx = renderFunctionalInitContentDocx({
      parent_section_title_no: "4.1",
      parent_section_title: "Functional Test",
      section_title_no: "4.1.1",
      section_title: "Init Section",
      items: [
        {
          title_no: "4.1.1",
          title: "Init Section",
          tr_code: "TR-GN-Init",
          source_ref: "primary::SRS-1",
          summary: "Initialize the system.",
          input_flow: ["Reset signal"],
          processing: [{ requirement_id: "TR-GN-Init-001", content: "Set initial state." }],
          output_flow: ["Initial state"],
          tables: [],
        },
      ],
    })
    const documentXml = readZip(docx).get("word/document.xml")?.toString("utf-8") || ""

    expect((documentXml.match(/4\.1\.1 Init Section/g) || []).length).toBe(1)
    expect(documentXml).toContain("4.1.1.1")
    expect(documentXml).toContain("4.1.1.2")
    expect(documentXml).toContain("TR-GN-Init-001")
  })

  test("functional init DOCX keeps non-tabular initialization in TR text and renders only suitable tables", () => {
    const docx = renderFunctionalInitContentDocx({
      parent_section_title_no: "4.1",
      parent_section_title: "功能测试",
      section_title_no: "4.1.1",
      section_title: "初始化功能需求项",
      items: [
        {
          title_no: "4.1.1",
          title: "初始化功能需求项",
          tr_code: "TR-GN-Init",
          source_ref: "primary::SRS-3.2.1",
          summary: "软件初始化处理器、总线和运行状态。",
          input_flow: ["无。"],
          processing: [
            {
              requirement_id: "TR-GN-Init-001",
              content: "软件将固定指令序列流程参数恢复为来源规定的默认值，按上注内容初始化上注指令序列流程参数，并将加断电标志和初始化完成标志设置为来源规定的状态。",
              table_refs: [],
            },
            {
              requirement_id: "TR-GN-Init-002",
              content: "软件初始化处理器，并将二级CAN总线节点状态和SPI总线单板状态设置为来源规定的运行初始状态。",
              table_refs: ["cpu-registers"],
            },
          ],
          output_flow: ["初始化完成状态。"],
          tables: [
            {
              table_id: "cpu-registers",
              table_no: "表4.1.1-1",
              title: "处理器初始化说明表",
              columns: ["名称", "地址/寄存器地址", "初值", "初值含义"],
              rows: [{
                "名称": "中断允许寄存器（IE）",
                "地址/寄存器地址": "A8H",
                "初值": "80H",
                "初值含义": "允许总中断。",
              }],
            },
          ],
        },
      ],
    })
    const documentXml = readZip(docx).get("word/document.xml")?.toString("utf-8") || ""

    expect(documentXml).toContain("固定指令序列流程参数")
    expect(documentXml).toContain("上注指令序列流程参数")
    expect(documentXml).toContain("加断电标志")
    expect(documentXml).toContain("二级CAN总线节点状态")
    expect(documentXml).toContain("SPI总线单板状态")
    expect(documentXml.match(/具体初始化设置见/g)).toHaveLength(1)
    expect(documentXml).toContain("中断允许寄存器（IE）")
  })

  test("discovers supported documents and ignores Word temp files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-discover-"))
    TEMP_DIRS.push(dir)

    writeFileSync(join(dir, "requirements.docx"), "placeholder", "utf-8")
    writeFileSync(join(dir, "~$requirements.docx"), "word temp lock file", "utf-8")
    writeFileSync(join(dir, "notes.md"), "# ignored markdown", "utf-8")

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      { mode: "discover_documents" },
      makeCtx(dir),
    ))

    const candidates = readJson<any>(result.output.candidates_path)
    expect(result.ok).toBe(true)
    expect(result.output.document_root_path).toBe(dir)
    expect(candidates.documents).toHaveLength(1)
    expect(candidates.documents[0].file_name).toBe("requirements.docx")
    expect(result.subagent_type).toBe("source-planner")
    expect(result.summary.source_plan_reused).toBe(false)
  })

  test("reuses a valid source plan and skips source-planner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-source-plan-reuse-"))
    TEMP_DIRS.push(dir)
    const primaryPath = join(dir, "requirements.docx")
    writeFileSync(primaryPath, "placeholder", "utf-8")
    const sourcePlanPath = join(dir, ".matrix", "data", "source-plan.json")
    writeJson(sourcePlanPath, { primary_srs_path: primaryPath, other_document_paths: [] })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      { mode: "discover_documents" },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    expect(result.incremental_reuse).toBe(true)
    expect(result.summary.source_plan_reused).toBe(true)
    expect(result.worker_prompt).toBeUndefined()
    expect(result.subagent_type).toBeUndefined()
    expect(result.reused_artifacts).toEqual([{ output_path: sourcePlanPath }])
  })

  test("reuses structurally valid source plans even when document paths changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-source-plan-stale-"))
    TEMP_DIRS.push(dir)
    writeFileSync(join(dir, "requirements.docx"), "placeholder", "utf-8")
    writeJson(join(dir, ".matrix", "data", "source-plan.json"), {
      primary_srs_path: join(dir, "missing.docx"),
      other_document_paths: [],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      { mode: "discover_documents" },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    expect(result.incremental_reuse).toBe(true)
    expect(result.summary.source_plan_reused).toBe(true)
    expect(result.subagent_type).toBeUndefined()
  })




  test("finalize_hardware_interface skips missing source tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-no-source-table-"))
    TEMP_DIRS.push(dir)

    const sourceDocxPath = join(dir, "source.docx")
    const rawModelPath = join(dir, ".matrix", "data", "hardware-interface-model.raw.json")
    const modelPath = join(dir, ".matrix", "data", "hardware-interface-model.json")
    const sourceArtifactsPath = join(dir, ".matrix", "data", "source-artifacts.json")
    const structurePath = join(dir, ".matrix", "data", "req-document-structure.json")

    writeJson(structurePath, {
      file_path: sourceDocxPath,
      format: "docx",
      total_sections: 1,
      sections: [{ section_id: "SRS-A.2", title: "CAN overview", level: 2, text: "", tables: [] }],
    })
    writeJson(sourceArtifactsPath, {
      source_plan_path: join(dir, ".matrix", "data", "source-plan.json"),
      primary_document: {
        path: sourceDocxPath,
        role: "primary_srs",
        format: "docx",
        segments_path: join(dir, ".matrix", "data", "req-segments.json"),
        toc_path: join(dir, ".matrix", "data", "req-segments-toc.json"),
        structure_path: structurePath,
      },
      supporting_documents: [],
    })
    writeJson(rawModelPath, {
      chapter_title: "Data and Interface Requirements",
      section_title: "Hardware Interfaces",
      blocks: [
        {
          interface_type: "can",
          title: "CAN Bus Interface and Related Data Flow",
          overview: "CAN overview.",
          overview_tables: [],
          subsections: [
            {
              title: "Missing table subsection",
              input_flow: "输入流：缺失表。",
              input_tables: [{ table_id: "SRS-A.2::table-1", title: "Missing table" }],
              output_flow: "",
              output_tables: [],
              source_refs: ["primary::SRS-A.2"],
            },
          ],
        },
      ],
    })

    const finalize = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_hardware_interface",
        hardware_interface_model_raw_path: rawModelPath,
        hardware_interface_model_path: modelPath,
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))

    expect(finalize.ok).toBe(true)
  })

  test("finalize_hardware_interface keeps tableless CAN subsections when source_refs are canonical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-can-tableless-"))
    TEMP_DIRS.push(dir)

    const sourceDocxPath = join(dir, "source.docx")
    const rawModelPath = join(dir, ".matrix", "data", "hardware-interface-model.raw.json")
    const modelPath = join(dir, ".matrix", "data", "hardware-interface-model.json")
    const sourceArtifactsPath = join(dir, ".matrix", "data", "source-artifacts.json")
    const structurePath = join(dir, ".matrix", "data", "req-document-structure.json")

    writeJson(structurePath, {
      file_path: sourceDocxPath,
      format: "docx",
      total_sections: 1,
      sections: [
        {
          section_id: "SRS-8.4",
          source_ref: "primary::SRS-8.4",
          title: "广播数据",
          level: 3,
          text: "数传下位机通过CAN总线接收广播数据。",
          tables: [],
        },
      ],
    })
    writeJson(sourceArtifactsPath, {
      source_plan_path: join(dir, ".matrix", "data", "source-plan.json"),
      primary_document: {
        path: sourceDocxPath,
        role: "primary_srs",
        format: "docx",
        segments_path: join(dir, ".matrix", "data", "req-segments.json"),
        toc_path: join(dir, ".matrix", "data", "req-segments-toc.json"),
        structure_path: structurePath,
      },
      supporting_documents: [],
    })
    writeJson(rawModelPath, {
      chapter_title: "数据及接口需求",
      section_title: "硬件接口",
      blocks: [
        {
          interface_type: "can",
          title: "CAN总线接口及相关数据流",
          overview: "CAN overview.",
          source_refs: ["primary::SRS-8.4"],
          overview_tables: [],
          subsections: [
            {
              title: "广播数据及相关数据流",
              input_flow: "输入流：广播数据。数传下位机通过CAN总线接收广播数据。",
              input_tables: [],
              output_flow: "",
              output_tables: [],
              source_refs: ["primary::SRS-8.4"],
            },
          ],
        },
      ],
    })

    const finalize = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_hardware_interface",
        hardware_interface_model_raw_path: rawModelPath,
        hardware_interface_model_path: modelPath,
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))

    const reportZip = readZip(Buffer.from(readFileSync(finalize.output.hardware_interface_report_path)))
    const documentXml = reportZip.get("word/document.xml")?.toString("utf-8") || ""

    expect(finalize.ok).toBe(true)
    expect(finalize.output.hardware_interface_report_text_path).toBe(join(dir, ".matrix", "data", "hardware-interface-report-text.md"))
    expect(existsSync(finalize.output.hardware_interface_report_text_path)).toBe(true)
    expect(readFileSync(finalize.output.hardware_interface_report_text_path, "utf-8")).toContain("广播数据及相关数据流")
    expect(finalize.summary.nested_section_count).toBe(1)
    expect(documentXml).toContain("广播数据及相关数据流")
  })

  test("finalize_hardware_interface skips bare local section_ids in source_refs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-bare-source-ref-"))
    TEMP_DIRS.push(dir)

    const sourceDocxPath = join(dir, "source.docx")
    const rawModelPath = join(dir, ".matrix", "data", "hardware-interface-model.raw.json")
    const modelPath = join(dir, ".matrix", "data", "hardware-interface-model.json")
    const sourceArtifactsPath = join(dir, ".matrix", "data", "source-artifacts.json")
    const structurePath = join(dir, ".matrix", "data", "req-document-structure.json")

    writeJson(structurePath, {
      file_path: sourceDocxPath,
      format: "docx",
      total_sections: 1,
      sections: [
        {
          section_id: "SRS-8.4",
          source_ref: "primary::SRS-8.4",
          title: "广播数据",
          level: 3,
          text: "数传下位机通过CAN总线接收广播数据。",
          tables: [],
        },
      ],
    })
    writeJson(sourceArtifactsPath, {
      source_plan_path: join(dir, ".matrix", "data", "source-plan.json"),
      primary_document: {
        path: sourceDocxPath,
        role: "primary_srs",
        format: "docx",
        segments_path: join(dir, ".matrix", "data", "req-segments.json"),
        toc_path: join(dir, ".matrix", "data", "req-segments-toc.json"),
        structure_path: structurePath,
      },
      supporting_documents: [],
    })
    writeJson(rawModelPath, {
      chapter_title: "数据及接口需求",
      section_title: "硬件接口",
      blocks: [
        {
          interface_type: "can",
          title: "CAN总线接口及相关数据流",
          overview: "CAN overview.",
          source_refs: ["SRS-8.4"],
          overview_tables: [],
          subsections: [
            {
              title: "广播数据及相关数据流",
              input_flow: "输入流：广播数据。",
              input_tables: [],
              output_flow: "",
              output_tables: [],
              source_refs: ["SRS-8.4"],
            },
          ],
        },
      ],
    })

    const finalize = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_hardware_interface",
        hardware_interface_model_raw_path: rawModelPath,
        hardware_interface_model_path: modelPath,
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))

    expect(finalize.ok).toBe(true)
    expect(finalize.ok).toBe(true)
  })

  test("finalize_hardware_interface allows generic topics to select only relevant source section tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-can-missing-source-table-"))
    TEMP_DIRS.push(dir)

    const sourceDocxPath = join(dir, "source.docx")
    const rawModelPath = join(dir, ".matrix", "data", "hardware-interface-model.raw.json")
    const modelPath = join(dir, ".matrix", "data", "hardware-interface-model.json")
    const sourceArtifactsPath = join(dir, ".matrix", "data", "source-artifacts.json")
    const structurePath = join(dir, ".matrix", "data", "req-document-structure.json")
    const requestAsset = writeTableAsset(
      join(dir, ".matrix", "data", "source-tables", "primary", "SRS-8.1.1__table-1.xml"),
      tableXml(["Request", "0x181"]),
      sourceDocxPath,
      "SRS-8.1.1",
    )
    const responseAsset = writeTableAsset(
      join(dir, ".matrix", "data", "source-tables", "primary", "SRS-8.1.1__table-2.xml"),
      tableXml(["Response", "0x182"]),
      sourceDocxPath,
      "SRS-8.1.1",
    )

    writeJson(structurePath, {
      file_path: sourceDocxPath,
      format: "docx",
      total_sections: 1,
      sections: [
        {
          section_id: "SRS-8.1.1",
          source_ref: "primary::SRS-8.1.1",
          title: "速变遥测轮询控制序列",
          level: 4,
          text: "速变遥测轮询请求和应答。",
          tables: [
            {
              table_id: "primary::SRS-8.1.1::table-1",
              title: "速变遥测轮询请求表",
              rows: [["Request", "0x181"]],
              table_asset: requestAsset,
            },
            {
              table_id: "primary::SRS-8.1.1::table-2",
              title: "速变遥测轮询应答表",
              rows: [["Response", "0x182"]],
              table_asset: responseAsset,
            },
          ],
        },
      ],
    })
    writeJson(sourceArtifactsPath, {
      source_plan_path: join(dir, ".matrix", "data", "source-plan.json"),
      primary_document: {
        path: sourceDocxPath,
        role: "primary_srs",
        format: "docx",
        segments_path: join(dir, ".matrix", "data", "req-segments.json"),
        toc_path: join(dir, ".matrix", "data", "req-segments-toc.json"),
        structure_path: structurePath,
      },
      supporting_documents: [],
    })
    writeJson(rawModelPath, {
      chapter_title: "数据及接口需求",
      section_title: "硬件接口",
      blocks: [
        {
          interface_type: "can",
          title: "CAN总线接口及相关数据流",
          overview: "CAN overview.",
          source_refs: ["primary::SRS-8.1.1"],
          overview_tables: [],
          subsections: [
            {
              title: "速变遥测轮询及相关数据流",
              input_flow: "输入流：速变遥测轮询。",
              input_tables: [{ table_id: "primary::SRS-8.1.1::table-1" }],
              output_flow: "输出流：速变遥测轮询应答。",
              output_tables: [],
              source_refs: ["primary::SRS-8.1.1"],
            },
          ],
        },
      ],
    })

    const finalize = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_hardware_interface",
        hardware_interface_model_raw_path: rawModelPath,
        hardware_interface_model_path: modelPath,
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))

    expect(finalize.ok).toBe(true)
    const finalizedModel = readJson<{
      blocks: Array<{
        subsections: Array<{
          input_tables: Array<{ table_id: string }>
          output_tables: Array<{ table_id: string }>
        }>
      }>
    }>(modelPath)
    expect(finalizedModel.interfaces[0]?.topics[0]?.input_tables.map((table) => table.table_id)).toEqual([
      "primary::SRS-8.1.1::table-1",
    ])
    expect(finalizedModel.interfaces[0]?.topics[0]?.output_tables).toEqual([])
  })


  test("finalize_hardware_interface matches by table_id only when display title differs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-title-mismatch-"))
    TEMP_DIRS.push(dir)

    const sourceDocxPath = join(dir, "source.docx")
    const rawModelPath = join(dir, ".matrix", "data", "hardware-interface-model.raw.json")
    const modelPath = join(dir, ".matrix", "data", "hardware-interface-model.json")
    const sourceArtifactsPath = join(dir, ".matrix", "data", "source-artifacts.json")
    const structurePath = join(dir, ".matrix", "data", "req-document-structure.json")
    const tableAsset = writeTableAsset(
      join(dir, ".matrix", "data", "source-tables", "primary", "SRS-A.3__table-13.xml"),
      tableXml(["Identifier", "ID10~ID9", "ID8~ID3"]),
      sourceDocxPath,
      "SRS-A.3",
    )

    writeJson(structurePath, {
      file_path: sourceDocxPath,
      format: "docx",
      total_sections: 1,
      sections: [
        {
          section_id: "SRS-A.3",
          source_ref: "primary::SRS-A.3",
          title: "Identifier",
          level: 2,
          text: "Identifier table.",
          tables: [
            {
              table_id: "SRS-A.3::table-13",
              title: "Identifier",
              rows: [["Identifier"], ["ID10~ID9", "ID8~ID3"]],
              table_asset: tableAsset,
            },
          ],
        },
      ],
    })
    writeJson(sourceArtifactsPath, {
      source_plan_path: join(dir, ".matrix", "data", "source-plan.json"),
      primary_document: {
        path: sourceDocxPath,
        role: "primary_srs",
        format: "docx",
        segments_path: join(dir, ".matrix", "data", "req-segments.json"),
        toc_path: join(dir, ".matrix", "data", "req-segments-toc.json"),
        structure_path: structurePath,
      },
      supporting_documents: [],
    })
    writeJson(rawModelPath, {
      chapter_title: "Data and Interface Requirements",
      section_title: "Hardware Interfaces",
      blocks: [
        {
          interface_type: "fpga",
          title: "FPGA接口及相关数据流",
          overview: "Identifier is part of the FPGA frame.",
          source_refs: ["primary::SRS-A.3"],
          overview_tables: [
            {
              table_id: "SRS-A.3::table-13",
              title: "CAN frame identifier composition",
            },
          ],
          subsections: [],
        },
      ],
    })

    const finalize = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_hardware_interface",
        hardware_interface_model_raw_path: rawModelPath,
        hardware_interface_model_path: modelPath,
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))

    const enrichedModel = readJson<any>(modelPath)
    const reportZip = readZip(Buffer.from(readFileSync(finalize.output.hardware_interface_report_path)))
    const documentXml = reportZip.get("word/document.xml")?.toString("utf-8") || ""

    expect(finalize.ok).toBe(true)
    expect(enrichedModel.interfaces[0].overview_tables[0].title).toBe("Identifier")
    expect(enrichedModel.interfaces[0].overview_tables[0].table_asset.path).toBe(tableAsset.path)
    expect(documentXml).not.toContain("CAN frame identifier composition")
    expect(documentXml).toContain("Identifier")
    expect(documentXml).toContain("ID10~ID9")
  })

  test("finalize_hardware_interface enriches generic AD interface tables under input/output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-ad-block-"))
    TEMP_DIRS.push(dir)

    const sourceDocxPath = join(dir, "source.docx")
    const rawModelPath = join(dir, ".matrix", "data", "hardware-interface-model.raw.json")
    const modelPath = join(dir, ".matrix", "data", "hardware-interface-model.json")
    const sourceArtifactsPath = join(dir, ".matrix", "data", "source-artifacts.json")
    const structurePath = join(dir, ".matrix", "data", "req-document-structure.json")
    const inputAsset = writeTableAsset(
      join(dir, ".matrix", "data", "source-tables", "primary", "AD__table-1.xml"),
      tableXml(["Channel", "ADC0", "0x10"]),
      sourceDocxPath,
      "SRS-AD.1",
    )
    const outputAsset = writeTableAsset(
      join(dir, ".matrix", "data", "source-tables", "primary", "AD__table-2.xml"),
      tableXml(["Value", "0x1234", "OK"]),
      sourceDocxPath,
      "SRS-AD.1",
    )

    writeJson(structurePath, {
      file_path: sourceDocxPath,
      format: "docx",
      total_sections: 1,
      sections: [
        {
          section_id: "SRS-AD.1",
          source_ref: "primary::SRS-AD.1",
          title: "AD采集说明",
          level: 2,
          text: "AD acquisition details.",
          tables: [
            {
              table_id: "primary::SRS-AD.1::table-1",
              title: "AD输入参数表",
              rows: [["Channel", "ADC0", "0x10"]],
              table_asset: inputAsset,
            },
            {
              table_id: "primary::SRS-AD.1::table-2",
              title: "AD输出结果表",
              rows: [["Value", "0x1234", "OK"]],
              table_asset: outputAsset,
            },
          ],
        },
      ],
    })
    writeJson(sourceArtifactsPath, {
      source_plan_path: join(dir, ".matrix", "data", "source-plan.json"),
      primary_document: {
        path: sourceDocxPath,
        role: "primary_srs",
        format: "docx",
        segments_path: join(dir, ".matrix", "data", "req-segments.json"),
        toc_path: join(dir, ".matrix", "data", "req-segments-toc.json"),
        structure_path: structurePath,
      },
      supporting_documents: [],
    })
    writeJson(rawModelPath, {
      chapter_title: "Data and Interface Requirements",
      section_title: "Hardware Interfaces",
      blocks: [
        {
          interface_type: "ad",
          title: "AD数据采集接口及相关数据流",
          overview: "IF-AD-001：12位AD芯片，量程0~5V，转换时间10us。",
          acquisition_processes: [
            {
              title: "轮询采集",
              content: "启动转换后读取高低位数据，并进行一次均值滤波。",
              source_refs: ["primary::SRS-AD.1"],
            },
          ],
          input_flow: "输入流：AD采集的参数。",
          input_tables: [
            {
              table_id: "primary::SRS-AD.1::table-1",
              title: "AD输入参数表",
            },
          ],
          output_flow: "输出流：AD采集结果。",
          output_tables: [
            {
              table_id: "primary::SRS-AD.1::table-2",
              title: "AD输出结果表",
            },
          ],
          source_refs: ["primary::SRS-AD.1"],
        },
      ],
    })

    const finalize = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_hardware_interface",
        hardware_interface_model_raw_path: rawModelPath,
        hardware_interface_model_path: modelPath,
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))

    const enrichedModel = readJson<any>(modelPath)
    const reportZip = readZip(Buffer.from(readFileSync(finalize.output.hardware_interface_report_path)))
    const documentXml = reportZip.get("word/document.xml")?.toString("utf-8") || ""

    expect(finalize.ok).toBe(true)
    expect(enrichedModel.interfaces[0].input_tables[0].table_asset.path).toBe(inputAsset.path)
    expect(enrichedModel.interfaces[0].output_tables[0].table_asset.path).toBe(outputAsset.path)
    expect(documentXml).toContain("IF-AD-001")
    expect(documentXml).not.toContain("IF-AD-001: IF-AD-001")
    expect(documentXml).toContain("轮询采集")
    expect(documentXml).toContain("AD输入参数表")
    expect(documentXml).toContain("AD输出结果表")
  })

  test("finalize_hardware_interface enriches generic serial interface tables in fixed input/output order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-serial-block-"))
    TEMP_DIRS.push(dir)

    const sourceDocxPath = join(dir, "source.docx")
    const rawModelPath = join(dir, ".matrix", "data", "hardware-interface-model.raw.json")
    const modelPath = join(dir, ".matrix", "data", "hardware-interface-model.json")
    const sourceArtifactsPath = join(dir, ".matrix", "data", "source-artifacts.json")
    const structurePath = join(dir, ".matrix", "data", "req-document-structure.json")
    const outputAsset = writeTableAsset(
      join(dir, ".matrix", "data", "source-tables", "primary", "SERIAL__table-1.xml"),
      tableXml(["Cmd", "0x55", "WRITE"]),
      sourceDocxPath,
      "SRS-UART.1",
    )
    const inputAsset = writeTableAsset(
      join(dir, ".matrix", "data", "source-tables", "primary", "SERIAL__table-2.xml"),
      tableXml(["Rsp", "0xAA", "OK"]),
      sourceDocxPath,
      "SRS-UART.1",
    )

    writeJson(structurePath, {
      file_path: sourceDocxPath,
      format: "docx",
      total_sections: 1,
      sections: [
        {
          section_id: "SRS-UART.1",
          source_ref: "primary::SRS-UART.1",
          title: "RS485 串口说明",
          level: 2,
          text: "RS485 master-slave communication.",
          tables: [
            {
              table_id: "primary::SRS-UART.1::table-1",
              title: "RS485输出命令表",
              rows: [["Cmd", "0x55", "WRITE"]],
              table_asset: outputAsset,
            },
            {
              table_id: "primary::SRS-UART.1::table-2",
              title: "RS485输入应答表",
              rows: [["Rsp", "0xAA", "OK"]],
              table_asset: inputAsset,
            },
          ],
        },
      ],
    })
    writeJson(sourceArtifactsPath, {
      source_plan_path: join(dir, ".matrix", "data", "source-plan.json"),
      primary_document: {
        path: sourceDocxPath,
        role: "primary_srs",
        format: "docx",
        segments_path: join(dir, ".matrix", "data", "req-segments.json"),
        toc_path: join(dir, ".matrix", "data", "req-segments-toc.json"),
        structure_path: structurePath,
      },
      supporting_documents: [],
    })
    writeJson(rawModelPath, {
      chapter_title: "Data and Interface Requirements",
      section_title: "Hardware Interfaces",
      blocks: [
        {
          interface_type: "serial",
          title: "RS485总线接口及相关数据流",
          overview: "IF-485-001：主从通信方式，波特率9600bps，8N1格式。",
          timing_description: "主机发送命令后，从机返回应答。",
          flow_order: ["output", "input"],
          output_flow: "输出流：RS485控制指令。",
          output_tables: [
            {
              table_id: "primary::SRS-UART.1::table-1",
              title: "RS485输出命令表",
            },
          ],
          input_flow: "输入流：RS485状态应答。",
          input_tables: [
            {
              table_id: "primary::SRS-UART.1::table-2",
              title: "RS485输入应答表",
            },
          ],
          source_refs: ["primary::SRS-UART.1"],
        },
      ],
    })

    const finalize = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_hardware_interface",
        hardware_interface_model_raw_path: rawModelPath,
        hardware_interface_model_path: modelPath,
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))

    const enrichedModel = readJson<any>(modelPath)
    const reportZip = readZip(Buffer.from(readFileSync(finalize.output.hardware_interface_report_path)))
    const documentXml = reportZip.get("word/document.xml")?.toString("utf-8") || ""

    expect(finalize.ok).toBe(true)
    expect(enrichedModel.interfaces[0].output_tables[0].table_asset.path).toBe(outputAsset.path)
    expect(enrichedModel.interfaces[0].input_tables[0].table_asset.path).toBe(inputAsset.path)
    expect(documentXml).toContain("RS485总线接口及相关数据流")
    expect(documentXml).toContain("串口接收和发送时序说明")
    expect(documentXml.indexOf("输入流")).toBeLessThan(documentXml.indexOf("输出流"))
    expect(documentXml).toContain("RS485输出命令表")
    expect(documentXml).toContain("RS485输入应答表")
  })






  test("prepares and finalizes functional title tree artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-title-tree-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)

    const prep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))

    expect(prep.ok).toBe(true)
    expect(prep.subagent_type).toBe("functional-title-tree-modeler")
    expect(prep.worker_prompt).toContain("$functional-title-tree")

    writeJson(prep.output.functional_title_tree_raw_path, {
      functional_root_source_ref: "primary::SRS-3.2",
      root_title: "能力需求",
      routing: {
        has_initialization: true,
        initialization_title_no: "4.1.1",
        initialization_source_ref: "primary::SRS-3.2.1",
      },
      children: [
        {
          title_no: "4.1.1",
          title: "初始化功能需求项",
          source_ref: "primary::SRS-3.2.1",
          children: [
            {
              title_no: "4.1.1.1",
              title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
              tr_code: "TR-GN-80C32Init",
              source_ref: "primary::SRS-3.2.1.1",
              children: [],
            },
            {
              title_no: "4.1.1.2",
              title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
              tr_code: "TR-GN-CANInit",
              source_ref: "primary::SRS-3.2.1.2",
              children: [],
            },
          ],
        },
        {
          title_no: "4.1.2",
          title: "解析执行总线指令功能需求项",
          source_ref: "primary::SRS-3.2.2",
          children: [
            {
              title_no: "4.1.2.1",
              title: "轮询控制处理功能需求项[TR-GN-PollCtrl]",
              tr_code: "TR-GN-PollCtrl",
              source_ref: "primary::SRS-3.2.2.1",
              children: [],
            },
          ],
        },
      ],
      skipped_source_refs: ["primary::SRS-3.2.2.2"],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_raw_path: prep.output.functional_title_tree_raw_path,
        functional_title_tree_path: prep.output.functional_title_tree_path,
        functional_title_tree_report_path: prep.output.functional_title_tree_report_path,
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    expect(result.summary).toEqual({
      node_count: 5,
      leaf_count: 3,
      skipped_source_ref_count: 1,
    })
    const model = readJson<any>(prep.output.functional_title_tree_path)
    expect(model.chapter_title_no).toBe("4")
    expect(model.section_title_no).toBe("4.1")
    expect(model.routing).toEqual({
      has_initialization: true,
      initialization_title_no: "4.1.1",
      initialization_source_ref: "primary::SRS-3.2.1",
    })
    expect(model.children[0].title).toBe("初始化功能需求项")
    expect(model.children[0].children[0].tr_code).toBe("TR-GN-80C32Init")
    const report = readFileSync(prep.output.functional_title_tree_report_path, "utf-8")
    expect(report).toContain("4.1.1 初始化功能需求项")
    expect(report).toContain("来源：primary::SRS-3.2.1.1")
    expect(report).toContain("跳过的源章节")

    const incrementalPrep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))
    expect(incrementalPrep.ok).toBe(true)
    expect(incrementalPrep.incremental_reuse).toBe(true)
    expect(incrementalPrep.worker_batch).toBeUndefined()
    expect(incrementalPrep.worker_prompt).toBeUndefined()
    expect(incrementalPrep.summary).toMatchObject({
      worker_batch_count: 0,
      reused_artifact_count: 1,
      node_count: 5,
      leaf_count: 3,
      skipped_source_ref_count: 1,
    })
    expect(incrementalPrep.output.functional_title_tree_path).toBe(prep.output.functional_title_tree_path)
  })

  test("does not inspect source table semantics while preparing empty hardware batches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-legacy-structure-"))
    TEMP_DIRS.push(dir)
    const dataDir = join(dir, ".matrix", "data")
    const structurePath = join(dataDir, "requirements-section-list.json")
    const manifestPath = join(dataDir, "source-artifacts.json")
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(structurePath, JSON.stringify({
      file_path: join(dir, "requirements.docx"),
      format: "docx",
      total_sections: 1,
      sections: [{
        section_id: "SRS-3.1",
        source_ref: "primary::SRS-3.1",
        title: "Hardware Interfaces",
        level: 2,
        text: "",
        tables: [{ table_id: "primary::SRS-3.1::table-1", title: "Legacy", rows: [["A"]] }],
      }],
    }))
    writeFileSync(manifestPath, JSON.stringify({
      primary_document: {
        path: join(dir, "requirements.docx"),
        role: "primary_srs",
        format: "docx",
        structure_path: structurePath,
      },
      supporting_documents: [],
    }))
    writeFileSync(join(dataDir, "hardware-interface-candidates.json"), JSON.stringify({
      model_version: 1,
      source_artifacts_path: manifestPath,
      candidates: [],
    }))

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_hardware_interface_batches",
      source_artifacts_path: manifestPath,
      hardware_interface_candidates_path: join(dataDir, "hardware-interface-candidates.json"),
    }, makeCtx(dir)))
    expect(result.ok).toBe(true)
    expect(result.worker_batches).toHaveLength(0)
  })

  test("finalizes a functional tree whose unnumbered SEG root owns differently-prefixed SRS children by explicit path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-title-seg-root-"))
    TEMP_DIRS.push(dir)
    const matrixDir = join(dir, ".matrix", "data")
    const structurePath = join(matrixDir, "req-document-structure.json")
    const sourceArtifactsPath = join(matrixDir, "source-artifacts.json")
    const rawPath = join(matrixDir, "functional-test-title-tree.raw.json")
    const finalPath = join(matrixDir, "functional-test-title-tree.json")
    const reportPath = join(dir, ".matrix", "reports", "functional-test-title-tree.md")
    writeJson(structurePath, {
      file_path: join(dir, "requirements.docx"),
      format: "docx",
      total_sections: 3,
      sections: [
        { section_id: "SEG-032", source_ref: "primary::SEG-032", title: "功能需求", level: 2, section_path_ids: ["SEG-032"], section_path_titles: ["功能需求"], text: "", tables: [] },
        { section_id: "SRS-5.2.1", source_ref: "primary::SRS-5.2.1", title: "工作模式功能", level: 3, section_path_ids: ["SEG-032", "SRS-5.2.1"], section_path_titles: ["功能需求", "工作模式功能"], text: "", tables: [] },
        { section_id: "SRS-5.2.2", source_ref: "primary::SRS-5.2.2", title: "间接指令响应功能", level: 3, section_path_ids: ["SEG-032", "SRS-5.2.2"], section_path_titles: ["功能需求", "间接指令响应功能"], text: "", tables: [] },
      ],
    })
    writeJson(sourceArtifactsPath, {
      source_plan_path: join(matrixDir, "source-plan.json"),
      primary_document: { path: join(dir, "requirements.docx"), role: "primary_srs", format: "docx", segments_path: join(matrixDir, "req-segments.json"), toc_path: join(matrixDir, "req-segments-toc.json"), structure_path: structurePath },
      supporting_documents: [],
    })
    writeJson(rawPath, {
      functional_root_source_ref: "primary::SEG-032",
      root_title: "功能需求",
      routing: { has_initialization: false, initialization_title_no: null, initialization_source_ref: null },
      children: [
        { title_no: "4.1.1", title: "工作模式功能需求项[TR-GN-WorkMode]", tr_code: "TR-GN-WorkMode", source_ref: "primary::SRS-5.2.1", children: [] },
        { title_no: "4.1.2", title: "间接指令响应功能需求项[TR-GN-IndirCmd]", tr_code: "TR-GN-IndirCmd", source_ref: "primary::SRS-5.2.2", children: [] },
      ],
      skipped_source_refs: [],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "finalize_functional_title_tree",
      source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_raw_path: rawPath,
      functional_title_tree_path: finalPath,
      functional_title_tree_report_path: reportPath,
    }, makeCtx(dir)))

    expect(result.ok).toBe(true)
    expect(result.summary).toMatchObject({ node_count: 3, leaf_count: 3 })
    const model = readJson<any>(finalPath)
    expect(model.routing).toEqual({
      has_initialization: true,
      initialization_title_no: "4.1.1",
      initialization_source_ref: "primary::SEG-032",
    })
    expect(model.children[0]).toMatchObject({
      title_no: "4.1.1",
      title: "初始化功能需求项[TR-GN-Init]",
      tr_code: "TR-GN-Init",
      source_ref: "primary::SEG-032",
    })
    expect(model.children[1].title_no).toBe("4.1.2")
    expect(model.children[2].title_no).toBe("4.1.3")
  })

  test("finalize_functional_title_tree allows sibling reordering for initialization-first title trees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-title-reordered-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeReorderedFunctionalSourceArtifacts(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-test-title-tree.raw.json")
    const finalPath = join(dir, ".matrix", "data", "functional-test-title-tree.json")

    writeJson(rawPath, {
      functional_root_source_ref: "primary::SRS-5.3",
      root_title: "功能需求",
      routing: {
        has_initialization: true,
        initialization_title_no: "4.1.1",
        initialization_source_ref: "primary::SRS-5.3.2",
      },
      children: [
        {
          title_no: "4.1.1",
          title: "初始化功能需求项",
          source_ref: "primary::SRS-5.3.2",
          children: [
            {
              title_no: "4.1.1.1",
              title: "控制器初始化功能需求项[TR-GN-CtrlInit]",
              tr_code: "TR-GN-CtrlInit",
              source_ref: "primary::SRS-5.3.2.1",
              children: [],
            },
          ],
        },
        {
          title_no: "4.1.2",
          title: "BootLoader程序功能要求功能需求项[TR-GN-BootLoader]",
          tr_code: "TR-GN-BootLoader",
          source_ref: "primary::SRS-5.3.1",
          children: [],
        },
        {
          title_no: "4.1.3",
          title: "其他功能需求项[TR-GN-Other]",
          tr_code: "TR-GN-Other",
          source_ref: "primary::SRS-5.3.3",
          children: [],
        },
      ],
      skipped_source_refs: [],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_raw_path: rawPath,
        functional_title_tree_path: finalPath,
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    const model = readJson<any>(finalPath)
    expect(model.routing).toEqual({
      has_initialization: true,
      initialization_title_no: "4.1.1",
      initialization_source_ref: "primary::SRS-5.3.2",
    })
    expect(model.children.map((child: any) => child.source_ref)).toEqual([
      "primary::SRS-5.3.2",
      "primary::SRS-5.3.1",
      "primary::SRS-5.3.3",
    ])
  })

  test("finalize_functional_title_tree allows initialization before guidance-loading source sections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-title-guidance-init-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeGuidanceBeforeInitSourceArtifacts(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-test-title-tree.raw.json")
    const finalPath = join(dir, ".matrix", "data", "functional-test-title-tree.json")

    writeJson(rawPath, {
      functional_root_source_ref: "primary::SRS-5.2",
      root_title: "功能需求",
      routing: {
        has_initialization: true,
        initialization_title_no: "4.1.1",
        initialization_source_ref: "primary::SRS-5.2.2",
      },
      children: [
        {
          title_no: "4.1.1",
          title: "初始化功能需求项[TR-GN-Init]",
          tr_code: "TR-GN-Init",
          source_ref: "primary::SRS-5.2.2",
          children: [],
        },
        {
          title_no: "4.1.2",
          title: "引导加载功能需求项[TR-GN-BootLoad]",
          tr_code: "TR-GN-BootLoad",
          source_ref: "primary::SRS-5.2.1",
          children: [],
        },
        {
          title_no: "4.1.3",
          title: "接收处理 Spacewire 总线上注数据功能需求项[TR-GN-SpwUpload]",
          tr_code: "TR-GN-SpwUpload",
          source_ref: "primary::SRS-5.2.3",
          children: [],
        },
        {
          title_no: "4.1.4",
          title: "接收处理一级 CAN 总线数据功能需求项",
          source_ref: "primary::SRS-5.2.4",
          children: [
            {
              title_no: "4.1.4.1",
              title: "轮询指令处理功能需求项[TR-GN-PollCmd]",
              tr_code: "TR-GN-PollCmd",
              source_ref: "primary::SRS-5.2.4.1",
              children: [],
            },
            {
              title_no: "4.1.4.2",
              title: "遥控指令功能需求项[TR-GN-TeleCmd]",
              tr_code: "TR-GN-TeleCmd",
              source_ref: "primary::SRS-5.2.4.2",
              children: [],
            },
          ],
        },
        {
          title_no: "4.1.5",
          title: "采集处理遥测数据功能需求项[TR-GN-Telemetry]",
          tr_code: "TR-GN-Telemetry",
          source_ref: "primary::SRS-5.2.5",
          children: [],
        },
      ],
      skipped_source_refs: [],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_raw_path: rawPath,
        functional_title_tree_path: finalPath,
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    const model = readJson<any>(finalPath)
    expect(model.routing).toEqual({
      has_initialization: true,
      initialization_title_no: "4.1.1",
      initialization_source_ref: "primary::SRS-5.2.2",
    })
    expect(model.children.map((child: any) => child.source_ref)).toEqual([
      "primary::SRS-5.2.2",
      "primary::SRS-5.2.1",
      "primary::SRS-5.2.3",
      "primary::SRS-5.2.4",
      "primary::SRS-5.2.5",
    ])
  })

  test("prepare_functional_title_tree refreshes chunked source structures before worker modeling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-title-refresh-"))
    TEMP_DIRS.push(dir)

    const matrixDir = join(dir, ".matrix", "data")
    const segmentsPath = join(matrixDir, "req-segments.json")
    const structurePath = join(matrixDir, "req-document-structure.json")
    const sourceArtifactsPath = join(matrixDir, "source-artifacts.json")

    writeJson(segmentsPath, {
      file: join(dir, "requirements.txt"),
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
      ],
      segments: [
        { segment_id: "SRS-3.2", level: 2, title: "能力需求", text: "" },
        {
          segment_id: "SRS-3.2.3__01",
          level: 3,
          title: "采集、处理一次电源的工程参数",
          text: "chunk one",
          section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.3"],
        },
        {
          segment_id: "SRS-3.2.3__02",
          level: 3,
          title: "采集、处理一次电源的工程参数",
          text: "chunk two",
          section_path_ids: ["SRS-003", "SRS-3.2", "SRS-3.2.3"],
        },
      ],
    })
    writeJson(structurePath, {
      file_path: join(dir, "requirements.txt"),
      format: "txt",
      total_sections: 3,
      sections: [
        { section_id: "SRS-3.2", source_ref: "primary::SRS-3.2", title: "能力需求", level: 2, text: "", tables: [] },
        { section_id: "SRS-3.2.3__01", source_ref: "primary::SRS-3.2.3__01", title: "采集、处理一次电源的工程参数", level: 3, text: "chunk one", tables: [] },
        { section_id: "SRS-3.2.3__02", source_ref: "primary::SRS-3.2.3__02", title: "采集、处理一次电源的工程参数", level: 3, text: "chunk two", tables: [] },
      ],
    })
    writeJson(sourceArtifactsPath, {
      source_plan_path: join(matrixDir, "source-plan.json"),
      primary_document: {
        path: join(dir, "requirements.txt"),
        role: "primary_srs",
        format: "txt",
        segments_path: segmentsPath,
        toc_path: join(matrixDir, "req-segments-toc.json"),
        structure_path: structurePath,
      },
      supporting_documents: [],
    })

    const prep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
      },
      makeCtx(dir),
    ))

    expect(prep.ok).toBe(true)
    const refreshed = readJson<any>(structurePath)
    expect(refreshed.sections.map((section: any) => section.section_id)).toEqual(["SRS-3.2", "SRS-3.2.3"])
    expect(refreshed.sections[1].source_ref).toBe("primary::SRS-3.2.3")
    expect(refreshed.sections[1].text).toContain("chunk one")
    expect(refreshed.sections[1].text).toContain("chunk two")
  })

  test("finalize_functional_title_tree repairs duplicate TR codes and skips invalid source scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-title-errors-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-test-title-tree.raw.json")

    writeJson(rawPath, {
      functional_root_source_ref: "primary::SRS-3.2",
      root_title: "能力需求",
      children: [
        {
          title_no: "4.1.1",
          title: "初始化功能需求项",
          source_ref: "primary::SRS-3.2.1",
          children: [
            {
              title_no: "4.1.1.1",
              title: "80C32 控制器初始化功能需求项[TR-GN-Init]",
              tr_code: "TR-GN-Init",
              source_ref: "primary::SRS-3.2.1.1",
              children: [],
            },
            {
              title_no: "4.1.1.2",
              title: "CAN 控制器初始化功能需求项[TR-GN-Init]",
              tr_code: "TR-GN-Init",
              source_ref: "primary::SRS-3.2.1.2",
              children: [],
            },
          ],
        },
        {
          title_no: "4.1.2",
          title: "解析执行总线指令功能需求项",
          source_ref: "primary::SRS-3.2.2",
          children: [
            {
              title_no: "4.1.2.1",
              title: "轮询控制处理功能需求项[TR-GN-PollCtrl]",
              tr_code: "TR-GN-PollCtrl",
              source_ref: "primary::SRS-3.2.2.1",
              children: [],
            },
            {
              title_no: "4.1.2.2",
              title: "说明功能需求项[TR-GN-Desc]",
              tr_code: "TR-GN-Desc",
              source_ref: "primary::SRS-3.2.2.2",
              children: [],
            },
          ],
        },
      ],
      skipped_source_refs: [],
    })

    const duplicate = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(duplicate.ok).toBe(true)

    writeJson(rawPath, {
      functional_root_source_ref: "primary::SRS-3.2",
      root_title: "能力需求",
      children: [
        {
          title_no: "4.1.1",
          title: "其他需求功能需求项[TR-GN-Other]",
          tr_code: "TR-GN-Other",
          source_ref: "primary::SRS-3.3",
          children: [],
        },
      ],
      skipped_source_refs: [],
    })

    const outside = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(outside.ok).toBe(true)
    expect(outside.ok).toBe(true)
  })

  test("finalize_functional_title_tree normalizes leaf and non-leaf TR fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-title-tr-rules-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-test-title-tree.raw.json")

    writeJson(rawPath, {
      functional_root_source_ref: "primary::SRS-3.2",
      root_title: "能力需求",
      children: [
        {
          title_no: "4.1.1",
          title: "初始化功能需求项[TR-GN-Init]",
          tr_code: "TR-GN-Init",
          source_ref: "primary::SRS-3.2.1",
          children: [
            {
              title_no: "4.1.1.1",
              title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
              tr_code: "TR-GN-80C32Init",
              source_ref: "primary::SRS-3.2.1.1",
              children: [],
            },
            {
              title_no: "4.1.1.2",
              title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
              tr_code: "TR-GN-CANInit",
              source_ref: "primary::SRS-3.2.1.2",
              children: [],
            },
          ],
        },
        {
          title_no: "4.1.2",
          title: "解析执行总线指令功能需求项",
          source_ref: "primary::SRS-3.2.2",
          children: [
            {
              title_no: "4.1.2.1",
              title: "轮询控制处理功能需求项[TR-GN-PollCtrl]",
              tr_code: "TR-GN-PollCtrl",
              source_ref: "primary::SRS-3.2.2.1",
              children: [],
            },
            {
              title_no: "4.1.2.2",
              title: "说明功能需求项[TR-GN-Desc]",
              tr_code: "TR-GN-Desc",
              source_ref: "primary::SRS-3.2.2.2",
              children: [],
            },
          ],
        },
      ],
      skipped_source_refs: [],
    })

    const nonLeaf = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(nonLeaf.ok).toBe(true)

    writeJson(rawPath, {
      functional_root_source_ref: "primary::SRS-3.2",
      root_title: "能力需求",
      children: [
        {
          title_no: "4.1.1",
          title: "初始化功能需求项",
          source_ref: "primary::SRS-3.2.1",
          children: [
            {
              title_no: "4.1.1.1",
              title: "80C32 控制器初始化功能需求项",
              source_ref: "primary::SRS-3.2.1.1",
              children: [],
            },
            {
              title_no: "4.1.1.2",
              title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
              tr_code: "TR-GN-CANInit",
              source_ref: "primary::SRS-3.2.1.2",
              children: [],
            },
          ],
        },
        {
          title_no: "4.1.2",
          title: "解析执行总线指令功能需求项",
          source_ref: "primary::SRS-3.2.2",
          children: [
            {
              title_no: "4.1.2.1",
              title: "轮询控制处理功能需求项[TR-GN-PollCtrl]",
              tr_code: "TR-GN-PollCtrl",
              source_ref: "primary::SRS-3.2.2.1",
              children: [],
            },
            {
              title_no: "4.1.2.2",
              title: "说明功能需求项[TR-GN-Desc]",
              tr_code: "TR-GN-Desc",
              source_ref: "primary::SRS-3.2.2.2",
              children: [],
            },
          ],
        },
      ],
      skipped_source_refs: [],
    })

    const missingLeaf = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_title_tree",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(missingLeaf.ok).toBe(true)
  })

  test("prepares and finalizes functional init content artifacts with DOCX preview", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-init-content-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const titleTreePath = writeFunctionalTitleTreeArtifact(dir)

    const prep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
      },
      makeCtx(dir),
    ))

    expect(prep.ok).toBe(true)
    expect(prep.subagent_type).toBe("functional-init-content-modeler")
    expect(prep.worker_prompt).toContain("$functional-init-requirements")
    expect(prep.worker_prompt).toContain("references/initialization-object-workflow.md")
    expect(prep.worker_prompt).toContain("references/bm3803fmgrh-template.md")
    expect(prep.worker_prompt).toContain("references/can-initialization-template.md")
    expect(prep.worker_prompt).toContain("完整输出示例")
    expect(prep.worker_prompt).toContain("提取源初始化条目 → 识别初始化对象 → 为每项指定TR正文或表格行")
    expect(prep.worker_prompt).toContain("对象按CPU、总线接口、独立芯片、数据缓冲区/全局变量排序")
    expect(prep.worker_prompt).toContain("同一CAN类型的CANA/CANB等通道合并为一个TR")
    expect(prep.worker_prompt).toContain("CAN总线是初始化对象")
    expect(prep.worker_prompt).toContain("禁止按单个寄存器拆分TR或表格")
    expect(prep.worker_prompt).toContain("CPU型号是一个对象")
    expect(prep.worker_prompt).toContain("80C32的IE、IP、TMOD、TCON、PCON、TH1/TL1、TH0/TL0必须按模板顺序进入同一个CPU TR和同一张多行表")
    expect(prep.worker_prompt).toContain("CPU片上定时器及预分频器必须并入CPU初始化")
    expect(prep.worker_prompt).toContain("禁止生成“定时器初始化”独立TR")
    expect(prep.worker_prompt).toContain("禁止生成“定时器初始化说明表”或“预分频器初始化说明表”独立表格")
    expect(prep.worker_prompt).toContain("只有来源明确说明是CPU外部独立定时器芯片时才可拆成独立芯片对象")
    expect(prep.worker_prompt).toContain("CPU片上定时器不得拥有独立processing或独立table")
    expect(prep.worker_prompt).toContain("每个具有可表格化配置的对象最多生成一张多行汇总表")
    expect(prep.worker_prompt).toContain("对象 → 默认一个processing → 零或一张汇总表")
    expect(prep.worker_prompt).toContain("缺失、冲突或无法判断时默认BasicCAN")
    expect(prep.worker_prompt).toContain("无法从当前项目需求、匹配手册或所选模板确认时统一写XX")
    expect(prep.worker_prompt).toContain("“名称”列是低自由度模板字段")
    expect(prep.worker_prompt).toContain("按顺序逐字复制模板名称")
    expect(prep.worker_prompt).toContain("不得翻译、缩写、扩写、概括、改写或只保留代号")
    expect(prep.worker_prompt).toContain("正式寄存器名称（寄存器代号）")
    expect(prep.worker_prompt).toContain("配置寄存器1（MCFG1）")
    expect(prep.worker_prompt).toContain("总线定时寄存器0（BTR0）")
    expect(prep.worker_prompt).toContain("不得只输出裸代号")
    expect(prep.worker_prompt).toContain("配置前值→配置后值")
    expect(prep.worker_prompt).toContain("ITMP写“0→0330H”")
    expect(prep.worker_prompt).toContain("不加括号，不写“->”")
    expect(prep.worker_prompt).toContain("只确认最终值时写单值")
    expect(prep.worker_prompt).toContain("不得把“0→0330H”与“0330H”解释成相同含义")
    expect(prep.worker_prompt).toContain("每行初值只能是一个确定值")
    expect(prep.worker_prompt).toContain("不得写“01H\\n04H”“40H/80H”“00H、01H、02H”")
    expect(prep.worker_prompt).toContain("未明确初始化实际写入值时，将初值写XX")
    expect(prep.worker_prompt).toContain("出现多个候选值且无法唯一确认时必须写XX")
    expect(prep.worker_prompt).toContain("不得删除、重命名或移动模板行")
    expect(prep.worker_prompt).toContain("“中断”“I/O设备访问配置”“PROM访问配置”")
    expect(prep.worker_prompt).toContain("“模式控制寄存器”“验收码0”“CANA复位控制”")
    expect(prep.worker_prompt).toContain("追加在全部模板行之后")
    expect(prep.worker_prompt).toContain("BasicCAN B不得补CR")
    expect(prep.worker_prompt).toContain("PeliCAN重复TXEC只保留一行")
    expect(prep.worker_prompt).toContain("逐表自查模板名称、模板顺序、缺失模板行和非必要新增行")
    expect(prep.worker_prompt).toContain("只有来源明确存在主动触发时input_flow才写具体方式")
    expect(prep.worker_prompt).toContain("不得用“等”“等等”“之类”“相关”作为省略语")
    expect(prep.worker_prompt).toContain("已识别的寄存器、地址、端口、位字段必须逐项展开")
    expect(prep.worker_prompt).toContain("初始化内容必须条目化")
    expect(prep.worker_prompt).toContain("summary是唯一例外")
    expect(prep.worker_prompt).toContain("summary必须是一个无换行、无编号、无项目符号、无分类标签的完整句子")
    expect(prep.worker_prompt).toContain("对A、B、C进行初始化，并复位D、E")
    expect(prep.worker_prompt).toContain("不得写“无独立芯片需要初始化”“未识别到独立芯片”")
    expect(prep.worker_prompt).toContain("执行条件仅在来源明确时放在句首")
    expect(prep.worker_prompt).toContain("寄存器、端口、位字段或初值含义应拆成独立表格行")
    expect(prep.worker_prompt).toContain("每个初始化 item 必须包含 input_flow、processing、output_flow 和 tables")
    expect(prep.worker_prompt).toContain("输入为空或没有输入时 input_flow 写 [\"无。\"]")
    expect(prep.worker_prompt).toContain("requirement_id 必须以当前 item.tr_code 为前缀")
    expect(prep.worker_prompt).toContain("不要输出 test_requirements")
    expect(prep.worker_prompt).toContain("固定值由 DOCX 渲染器生成")
    expect(prep.worker_prompt).toContain("processing.content 使用一条或多条连贯的确定性自然需求语句")
    expect(prep.worker_prompt).toContain("软件上电或复位后初始化 BM3803")
    expect(prep.worker_prompt).toContain("来源未明确触发条件时写“软件初始化 BM3803")
    expect(prep.worker_prompt).toContain("禁止使用“应该”“应当”“应”“需要”“需”“可以”“建议”")
    expect(prep.worker_prompt).toContain("不得用“完成初始化配置”代替明确动作")
    expect(prep.worker_prompt).toContain("processing.content不得重复表格已完整承载的配置")
    expect(prep.worker_prompt).toContain("源初始化条目 → processing.content或具体表格行")
    expect(prep.worker_prompt).toContain("summary、input_flow、output_flow不算TR覆盖")
    expect(prep.worker_prompt).toContain("固定指令序列参数、上注参数、加断电标志、初始化完成标志")
    expect(prep.worker_prompt).toContain("不得在初值中填写“默认值”“初始状态”“完成”“上注值或默认值”")
    expect(prep.worker_prompt).toContain("structure的table_html或hardware_interface_report_text_path")
    expect(prep.worker_prompt).toContain("不得编造")
    expect(prep.worker_prompt).toContain("tables[].table_html")
    expect(prep.worker_prompt).toContain("table_refs")
    expect(prep.worker_prompt).toContain("以hardware_interface_report_text_path中的表格及表号为准")
    expect(prep.worker_prompt).toContain("直接引用硬件接口报告表格是允许的")
    expect(prep.worker_prompt).toContain("不得拼接“触发时机：”“前置状态：”“初始化对象：”“设置动作：”“预期状态与可观测点：”等分类标签")
    expect(prep.worker_prompt).toContain("来源未明确时省略触发条件并直接写“软件初始化<对象>。”")
    expect(prep.worker_prompt).toContain("不得推断通用的上电、复位或启动时机")
    expect(prep.worker_prompt).toContain("不要仅因缺少这些信息新增open_questions")
    expect(prep.worker_prompt).toContain("table_refs")
    expect(prep.worker_prompt).toContain("无表TR使用table_refs: []")
    expect(prep.worker_prompt).toContain("不要输出 processing_preamble 字段")
    expect(prep.worker_prompt).toContain("表格及表号")
    expect(prep.worker_prompt).toContain("附录名")
    expect(prep.worker_prompt).toContain("已搜索关键词")
    expect(prep.worker_payload.allow_code).toBe(false)
    expect(prep.worker_payload.source_artifacts_path).toBe(join(dir, ".matrix", "data", "source-artifacts.json"))
    expect(prep.worker_payload.hardware_interface_report_text_path).toBe(join(dir, ".matrix", "data", "hardware-interface-report-text.md"))

    writeJson(prep.output.functional_init_content_raw_path, {
      section_title_no: "4.1.1",
      section_title: "初始化功能需求项",
      allow_code: false,
      items: [
        {
          title_no: "4.1.1.1",
          title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
          tr_code: "TR-GN-80C32Init",
          source_ref: "primary::SRS-3.2.1.1",
          summary: "软件上电或复位后，对 BM3803FMGRH、一级 CAN 总线、遥测参数和固定指令序列流程进行初始化，并复位一级 CAN 总线、SpaceWire 总线、二级 CAN 总线和 SPI 总线。",
          input_flow: [],
          processing: [
            {
              requirement_id: "TR-GN-80C32Init-001",
              content: "软件在上电或复位后设置 IE 中断允许寄存器，使 EA 位允许总中断、EX0 位允许外部中断 0，并形成 80C32 控制器初始化后的中断使能状态。",
              table_refs: ["80c32-registers"],
            },
          ],
          output_flow: ["80C32 控制器初始化状态。"],
          tables: [
            {
              table_id: "80c32-registers",
              title: "80C32 控制器初始化说明表",
              columns: ["名称", "地址/寄存器地址", "初值", "初值含义"],
              rows: [
                {
                  "名称": "IE 中断允许寄存器",
                  "地址/寄存器地址": "A8H",
                  "初值": "未明确",
                  "初值含义": "1. EA=1 表示允许总中断。\n2. EX0=1 表示允许外部中断 0。",
                },
              ],
            },
          ],
        },
        {
          title_no: "4.1.1.2",
          title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
          tr_code: "TR-GN-CANInit",
          source_ref: "primary::SRS-3.2.1.2",
          summary: "软件上电或复位后应对 CAN 控制器进行初始化。",
          input_flow: ["上电或复位事件。"],
          processing: [
            {
              requirement_id: "TR-GN-CANInit-001",
              content: "软件在上电或复位后设置 BTR0 总线时序寄存器 0，使 CAN 控制器使用 41H 对应的总线时序配置，并形成 CAN 控制器初始化后的通信状态。",
              table_refs: ["can-registers"],
            },
          ],
          output_flow: ["CAN 控制器初始化状态。"],
          tables: [
            {
              table_id: "can-registers",
              title: "CAN 控制器初始化说明表",
              columns: ["名称", "地址/寄存器地址", "初值", "初值含义"],
              rows: [
                {
                  "名称": "BTR0 总线时序寄存器 0",
                  "地址/寄存器地址": "CAN 地址 6",
                  "初值": "41H",
                  "初值含义": "需求要求总线时序寄存器 0 配置值为 41H。",
                },
              ],
            },
          ],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const incrementalPrep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
      },
      makeCtx(dir),
    ))
    expect(incrementalPrep.ok).toBe(true)
    expect(incrementalPrep.incremental_reuse).toBe(true)
    expect(incrementalPrep.worker_batch).toBeUndefined()
    expect(incrementalPrep.worker_prompt).toBeUndefined()
    expect(incrementalPrep.summary.worker_batch_count).toBe(0)
    expect(incrementalPrep.summary.reused_raw_artifact_count).toBe(1)
    expect(incrementalPrep.output.functional_init_content_raw_path).toBe(prep.output.functional_init_content_raw_path)

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        functional_init_content_raw_path: prep.output.functional_init_content_raw_path,
        functional_init_content_path: prep.output.functional_init_content_path,
        functional_init_content_report_path: prep.output.functional_init_content_report_path,
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    expect(result.summary).toEqual({
      item_count: 2,
      processing_count: 2,
      table_count: 2,
      allow_code: false,
    })
    const model = readJson<any>(prep.output.functional_init_content_path)
    expect(model.section_title_no).toBe("4.1.1")
    expect(model.items[0].tr_code).toBe("TR-GN-80C32Init")
    expect(model.items[0].input_flow).toEqual(["无。"])
    expect(model.items[0].processing[0].requirement_id).toBe("TR-GN-80C32Init-001")
    expect(model.items[0].processing[0].table_refs).toEqual(["80c32-registers"])
    expect(model.items[0].tables[0].table_no).toBe("表4.1.1.1-1")
    expect(model.items[0].test_requirements).toBeUndefined()
    expect(model.items[1].test_requirements).toBeUndefined()
    expect(existsSync(prep.output.functional_init_content_report_path)).toBe(true)
    const zip = readZip(readFileSync(prep.output.functional_init_content_report_path))
    const documentXml = zip.get("word/document.xml")?.toString("utf-8") || ""
    expect(documentXml).toContain("4.1.1 初始化功能需求项")
    expectIndentedParagraph(documentXml, "软件上电或复位后，对 BM3803FMGRH、一级 CAN 总线、遥测参数和固定指令序列流程进行初始化，并复位一级 CAN 总线、SpaceWire 总线、二级 CAN 总线和 SPI 总线。")
    expect(documentXml).toContain("80C32 控制器初始化说明表")
    expect(documentXml).toContain("IE 中断允许寄存器")
    expect(documentXml).toContain("4.1.1.1.1 输入流说明")
    expect(documentXml).toContain("4.1.1.1.2 处理")
    expect(documentXml).toContain("4.1.1.1.3 输出流说明")
    expect(documentXml).toContain("4.1.1.1.4 测试要求")
    expect(documentXml).toContain("测试充分性要求：C1、C2、C3、C4；")
    expect(documentXml).toContain("测试终止要求：Z1、Z2；")
    expect(documentXml).toContain("优先级：所有需求项为高优先级。")
    expect(documentXml).not.toContain("旧充分性值")
    expect(documentXml).not.toContain("旧终止值")
    expect(documentXml).not.toContain("旧优先级")
    expect(documentXml).toContain("TR-GN-80C32Init-001：软件在上电或复位后设置 IE 中断允许寄存器")
    expect(documentXml).toContain("具体初始化设置见表4.1.1.1-1。")
    expect(documentXml).toContain("表4.1.1.1-1 80C32 控制器初始化说明表")
    const processingIndex = documentXml.indexOf("TR-GN-80C32Init-001：")
    const referenceIndex = documentXml.indexOf("具体初始化设置见表4.1.1.1-1。")
    const tableTitleIndex = documentXml.indexOf("表4.1.1.1-1 80C32 控制器初始化说明表")
    const tableIndex = documentXml.indexOf("<w:tbl>", tableTitleIndex)
    expect(processingIndex).toBeLessThan(referenceIndex)
    expect(referenceIndex).toBeLessThan(tableTitleIndex)
    expect(tableTitleIndex).toBeLessThan(tableIndex)
    expectIndentedParagraph(documentXml, "无。")
    expectIndentedParagraph(documentXml, "TR-GN-80C32Init-001：软件在上电或复位后设置 IE 中断允许寄存器，使 EA 位允许总中断、EX0 位允许外部中断 0，并形成 80C32 控制器初始化后的中断使能状态。")
    expectIndentedParagraph(documentXml, "80C32 控制器初始化状态。")
    expectIndentedParagraph(documentXml, "测试充分性要求：C1、C2、C3、C4；")
    expect(documentXml).toContain("EA=1 表示允许总中断")
    expect(documentXml).toContain("EX0=1 表示允许外部中断 0")
    expect(documentXml).toContain("<w:br/>")

    const legacyRaw = readJson<any>(prep.output.functional_init_content_raw_path)
    for (const item of legacyRaw.items) {
      for (const processingItem of item.processing || []) delete processingItem.table_refs
      for (const tableEntry of item.tables || []) delete tableEntry.table_id
    }
    writeJson(prep.output.functional_init_content_raw_path, legacyRaw)
    const legacyPrep = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_functional_init_content",
      source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_path: titleTreePath,
    }, makeCtx(dir)))
    expect(legacyPrep.incremental_reuse).toBe(true)
    expect(legacyPrep.worker_batch).toBeUndefined()
  })

  test("requires finalized initialization routing instead of skipping functional init content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-init-no-route-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath, titleTreePath } = writeFunctionalOtherNoInitArtifacts(dir)

    const prep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
      },
      makeCtx(dir),
    ))

    expect(prep.ok).toBe(false)
    expect(prep.error).toContain("required initialization node")

    const finalize = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
      },
      makeCtx(dir),
    ))

    expect(finalize.ok).toBe(false)
    expect(finalize.error).toContain("required initialization node")
  })

  test("finalize_functional_init_content repairs TR codes and skips incompatible tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-init-errors-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const titleTreePath = writeFunctionalTitleTreeArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-init-content.raw.json")

    writeJson(rawPath, {
      section_title_no: "4.1.1",
      section_title: "初始化功能需求项",
      allow_code: false,
      items: [
        {
          title_no: "4.1.1.1",
          title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
          tr_code: "TR-GN-INIT-001",
          source_ref: "primary::SRS-3.2.1.1",
          summary: "初始化。",
          tables: [],
        },
        {
          title_no: "4.1.1.2",
          title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
          tr_code: "TR-GN-CANInit",
          source_ref: "primary::SRS-3.2.1.2",
          summary: "初始化。",
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const wrongTr = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        functional_init_content_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(wrongTr.ok).toBe(true)
    const mappingState = JSON.parse(readFileSync(join(dir, ".matrix", "data", "phase2-editor-state.json"), "utf8"))
    const initMapping = Object.entries(mappingState.edit_mappings.artifacts).find(([name]) => name.endsWith("functional-init-content.json"))?.[1] as any
    expect(initMapping.entries.some((entry: any) => entry.identity.title_no === "4.1.1.1" && entry.path.join(".") === "items.0")).toBe(true)

    writeJson(rawPath, {
      section_title_no: "4.1.1",
      section_title: "初始化功能需求项",
      allow_code: false,
      items: [
        {
          title_no: "4.1.1.1",
          title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
          tr_code: "TR-GN-80C32Init",
          source_ref: "primary::SRS-3.2.1.1",
          summary: "初始化。",
          tables: [
            {
              table_id: "bad-columns",
              title: "错误列表",
              columns: ["名称", "地址/寄存器地址", "初值", "初值含义", "来源"],
              rows: [],
            },
          ],
        },
        {
          title_no: "4.1.1.2",
          title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
          tr_code: "TR-GN-CANInit",
          source_ref: "primary::SRS-3.2.1.2",
          summary: "初始化。",
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const badColumns = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        functional_init_content_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(badColumns.ok).toBe(true)
    expect(badColumns.skipped_count).toBeGreaterThan(0)
  })

  test("finalize_functional_init_content preserves blank template cells and nonstandard address wording", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-init-address-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const titleTreePath = writeFunctionalTitleTreeArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-init-content.raw.json")

    writeJson(rawPath, {
      section_title_no: "4.1.1",
      section_title: "初始化功能需求项",
      allow_code: false,
      items: [
        {
          title_no: "4.1.1.1",
          title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
          tr_code: "TR-GN-80C32Init",
          source_ref: "primary::SRS-3.2.1.1",
          summary: "初始化。",
          tables: [
            {
              table_id: "bad-address",
              title: "80C32 初始化说明表",
              columns: ["名称", "地址/寄存器地址", "初值", "初值含义"],
              rows: [
                {
                  "名称": "背景说明",
                  "地址/寄存器地址": "",
                  "初值": "",
                  "初值含义": "背景说明。",
                },
              ],
            },
          ],
        },
        {
          title_no: "4.1.1.2",
          title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
          tr_code: "TR-GN-CANInit",
          source_ref: "primary::SRS-3.2.1.2",
          summary: "初始化。",
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const blankCells = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        functional_init_content_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(blankCells.ok).toBe(true)
    const blankModel = readJson<any>(blankCells.output.functional_init_content_path)
    expect(blankModel.items[0].tables[0].rows[0]["地址/寄存器地址"]).toBe("XX")
    expect(blankModel.items[0].tables[0].rows[0]["初值"]).toBe("XX")

    const invalidRaw = readJson<any>(rawPath)
    invalidRaw.items[0].tables[0].rows[0]["地址/寄存器地址"] = "不适用"
    writeJson(rawPath, invalidRaw)
    const invalidAddress = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        functional_init_content_raw_path: rawPath,
      },
      makeCtx(dir),
    ))
    expect(invalidAddress.ok).toBe(true)
  })

  test("finalize_functional_init_content validates explicit TR table associations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-init-table-links-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const titleTreePath = writeFunctionalTitleTreeArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-init-content.raw.json")
    const table = (table_id: string, name: string) => ({
      table_id,
      title: `${name}初始化说明表`,
      columns: ["名称", "地址/寄存器地址", "初值", "初值含义"],
      rows: [{ "名称": name, "地址/寄存器地址": "A8H", "初值": "80H", "初值含义": `${name}初值` }],
    })
    const baseRaw = {
      section_title_no: "4.1.1", section_title: "初始化功能需求项", allow_code: false,
      items: [
        {
          title_no: "4.1.1.1", title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
          tr_code: "TR-GN-80C32Init", source_ref: "primary::SRS-3.2.1.1", summary: "初始化。",
          processing: [
            { requirement_id: "TR-GN-80C32Init-001", content: "配置中断。", table_refs: ["ie", "ip"] },
            { requirement_id: "TR-GN-80C32Init-002", content: "等待控制器就绪。", table_refs: [] },
          ],
          tables: [table("ie", "IE"), table("ip", "IP")],
        },
        {
          title_no: "4.1.1.2", title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
          tr_code: "TR-GN-CANInit", source_ref: "primary::SRS-3.2.1.2", summary: "初始化。",
          processing: [{ requirement_id: "TR-GN-CANInit-001", content: "等待CAN就绪。", table_refs: [] }],
          tables: [],
        },
      ],
      skipped_title_refs: [], open_questions: [],
    }
    const finalize = async (raw: any) => {
      writeJson(rawPath, raw)
      return JSON.parse(await (filldataPhase2Workflow as any).execute({
        mode: "finalize_functional_init_content", source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath, functional_init_content_raw_path: rawPath,
      }, makeCtx(dir)))
    }

    const accepted = await finalize(structuredClone(baseRaw))
    expect(accepted.ok).toBe(true)
    const model = readJson<any>(accepted.output.functional_init_content_path)
    expect(model.items[0].tables.map((entry: any) => entry.table_no)).toEqual(["表4.1.1.1-1", "表4.1.1.1-2"])

    const fallbackRaw = structuredClone(baseRaw)
    fallbackRaw.items[0].processing = []
    const fallback = await finalize(fallbackRaw)
    expect(fallback.ok).toBe(true)
    const fallbackModel = readJson<any>(fallback.output.functional_init_content_path)
    expect(fallbackModel.items[0].processing).toEqual([])
    expect(fallbackModel.items[0].tables).toHaveLength(2)

    const unknown = structuredClone(baseRaw)
    unknown.items[0].processing[0].table_refs = ["missing"]
    expect((await finalize(unknown)).ok).toBe(true)

    const duplicateId = structuredClone(baseRaw)
    duplicateId.items[0].tables[1].table_id = "ie"
    expect((await finalize(duplicateId)).ok).toBe(true)

    const duplicateRef = structuredClone(baseRaw)
    duplicateRef.items[0].processing[0].table_refs = ["ie", "ie", "ip"]
    expect((await finalize(duplicateRef)).ok).toBe(true)

    const shared = structuredClone(baseRaw)
    shared.items[0].processing[0].table_refs = ["ie"]
    shared.items[0].processing[1].table_refs = ["ip", "ie"]
    expect((await finalize(shared)).ok).toBe(true)

    const orphan = structuredClone(baseRaw)
    orphan.items[0].processing[0].table_refs = ["ie"]
    expect((await finalize(orphan)).ok).toBe(true)
  })

  test("reuses legacy CAN raw without semantically merging TRs or tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-init-can-aggregate-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const titleTreePath = writeFunctionalTitleTreeArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-init-content.raw.json")
    const canTable = (id: string, register: string, value: string, meaning: string) => ({
      table_id: id,
      title: `CAN ${register}配置`,
      columns: ["名称", "地址/寄存器地址", "初值", "初值含义"],
      rows: [{
        "名称": `${register}寄存器`,
        "地址/寄存器地址": "",
        "初值": value,
        "初值含义": meaning,
      }],
    })
    const raw = {
      section_title_no: "4.1.1", section_title: "初始化功能需求项", allow_code: false,
      items: [
        {
          title_no: "4.1.1.1", title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
          tr_code: "TR-GN-80C32Init", source_ref: "primary::SRS-3.2.1.1", summary: "初始化80C32控制器。",
          processing: [{ requirement_id: "TR-GN-80C32Init-001", content: "软件应初始化80C32控制器。", table_refs: [] }],
          tables: [],
        },
        {
          title_no: "4.1.1.2", title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
          tr_code: "TR-GN-CANInit", source_ref: "primary::SRS-3.2.1.2", summary: "初始化CAN总线。",
          processing: [
            { requirement_id: "TR-GN-CANInit-001", content: "软件应设置CAN总线定时寄存器BTR1。", table_refs: ["btr1"] },
            { requirement_id: "TR-GN-CANInit-002", content: "软件应设置CAN输出控制寄存器OCR。", table_refs: ["ocr"] },
            { requirement_id: "TR-GN-CANInit-003", content: "软件应设置CAN时钟分频寄存器CDR。", table_refs: ["cdr"] },
            { requirement_id: "TR-GN-CANInit-004", content: "软件应设置CAN中断允许寄存器IER。", table_refs: ["ier"] },
          ],
          tables: [
            canTable("btr1", "BTR1", "C5H", "配置CAN总线采样点和采样次数"),
            canTable("ocr", "OCR", "4AH", "配置CAN输出方式"),
            canTable("cdr", "CDR", "04H", "选择BasicCAN模式"),
            canTable("ier", "IER", "03H", "使能CAN接收和发送中断"),
          ],
        },
      ],
      skipped_title_refs: [], open_questions: [],
    }
    writeJson(rawPath, raw)
    const rawBefore = readFileSync(rawPath, "utf-8")

    const prepared = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_functional_init_content",
      source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_path: titleTreePath,
      functional_init_content_raw_path: rawPath,
    }, makeCtx(dir)))
    expect(prepared.incremental_reuse).toBe(true)
    expect(readFileSync(rawPath, "utf-8")).toBe(rawBefore)

    const finalized = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "finalize_functional_init_content",
      source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_path: titleTreePath,
      functional_init_content_raw_path: rawPath,
    }, makeCtx(dir)))
    expect(finalized.ok).toBe(true)
    expect(readFileSync(rawPath, "utf-8")).toBe(rawBefore)
    const model = readJson<any>(finalized.output.functional_init_content_path)
    const canItem = model.items[1]
    expect(canItem.processing).toHaveLength(4)
    expect(canItem.processing.map((entry: any) => entry.table_refs)).toEqual([
      ["btr1"], ["ocr"], ["cdr"], ["ier"],
    ])
    expect(canItem.tables).toHaveLength(4)
    expect(canItem.tables.map((table: any) => table.title)).toEqual([
      "CAN BTR1配置", "CAN OCR配置", "CAN CDR配置", "CAN IER配置",
    ])
    expect(canItem.tables.map((table: any) => table.table_no)).toEqual([
      "表4.1.1.2-1", "表4.1.1.2-2", "表4.1.1.2-3", "表4.1.1.2-4",
    ])

    const documentXml = readZip(readFileSync(finalized.output.functional_init_content_report_path))
      .get("word/document.xml")?.toString("utf-8") || ""
    expect(documentXml.match(/<w:tbl>/g)?.length).toBe(4)
    expect(documentXml).toContain("具体初始化设置见表4.1.1.2-1")
    for (const register of ["BTR1寄存器", "OCR寄存器", "CDR寄存器", "IER寄存器"]) {
      expect(documentXml).toContain(register)
    }
  })

  test("finalize preserves split 80C32 processing and tables without semantic merging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-init-cpu-no-merge-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const titleTreePath = writeFunctionalTitleTreeArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-init-content.raw.json")
    const table = (id: string, register: string) => ({
      table_id: id,
      title: `80C32 ${register}配置`,
      columns: ["名称", "地址/寄存器地址", "初值", "初值含义"],
      rows: [{ "名称": register, "地址/寄存器地址": register, "初值": "00H", "初值含义": `配置${register}` }],
    })
    writeJson(rawPath, {
      section_title_no: "4.1.1", section_title: "初始化功能需求项", allow_code: false,
      items: [
        {
          title_no: "4.1.1.1", title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
          tr_code: "TR-GN-80C32Init", source_ref: "primary::SRS-3.2.1.1", summary: "初始化80C32控制器。",
          processing: [
            { requirement_id: "TR-GN-80C32Init-001", content: "软件应配置80C32中断。", table_refs: ["ie"] },
            { requirement_id: "TR-GN-80C32Init-002", content: "软件应配置80C32优先级。", table_refs: ["ip"] },
            { requirement_id: "TR-GN-80C32Init-003", content: "软件应配置80C32定时器。", table_refs: ["tmod"] },
            { requirement_id: "TR-GN-80C32Init-004", content: "软件应配置80C32外部中断。", table_refs: ["tcon"] },
          ],
          tables: [table("ie", "IE"), table("ip", "IP"), table("tmod", "TMOD"), table("tcon", "TCON")],
        },
        {
          title_no: "4.1.1.2", title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
          tr_code: "TR-GN-CANInit", source_ref: "primary::SRS-3.2.1.2", summary: "初始化CAN控制器。",
          processing: [{ requirement_id: "TR-GN-CANInit-001", content: "软件应初始化CAN控制器。", table_refs: [] }],
          tables: [],
        },
      ],
      skipped_title_refs: [], open_questions: [],
    })

    const finalized = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "finalize_functional_init_content", source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_path: titleTreePath, functional_init_content_raw_path: rawPath,
    }, makeCtx(dir)))
    expect(finalized.ok).toBe(true)
    const cpuItem = readJson<any>(finalized.output.functional_init_content_path).items[0]
    expect(cpuItem.processing).toHaveLength(4)
    expect(cpuItem.tables.map((entry: any) => entry.table_id)).toEqual(["ie", "ip", "tmod", "tcon"])
    expect(cpuItem.processing.map((entry: any) => entry.table_refs)).toEqual([["ie"], ["ip"], ["tmod"], ["tcon"]])
  })

  test("does not group CANA and CANB tables in finalize and preserves correct multi-row tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-init-can-channels-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const titleTreePath = writeFunctionalTitleTreeArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-init-content.raw.json")
    const row = (name: string) => ({
      "名称": name, "地址/寄存器地址": "", "初值": "00H", "初值含义": `配置${name}`,
    })
    const baseItem = {
      title_no: "4.1.1.1", title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
      tr_code: "TR-GN-80C32Init", source_ref: "primary::SRS-3.2.1.1", summary: "初始化80C32控制器。",
      processing: [{ requirement_id: "TR-GN-80C32Init-001", content: "软件应初始化80C32控制器。", table_refs: [] }],
      tables: [],
    }
    const writeRaw = (canItem: any) => writeJson(rawPath, {
      section_title_no: "4.1.1", section_title: "初始化功能需求项", allow_code: false,
      items: [baseItem, canItem], skipped_title_refs: [], open_questions: [],
    })
    const finalize = async () => JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "finalize_functional_init_content", source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_path: titleTreePath, functional_init_content_raw_path: rawPath,
    }, makeCtx(dir)))

    writeRaw({
      title_no: "4.1.1.2", title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
      tr_code: "TR-GN-CANInit", source_ref: "primary::SRS-3.2.1.2", summary: "初始化CANA和CANB。",
      processing: [
        { requirement_id: "TR-GN-CANInit-001", content: "软件应配置CANA的BTR0。", table_refs: ["a-btr0"] },
        { requirement_id: "TR-GN-CANInit-002", content: "软件应配置CANB的BTR0。", table_refs: ["b-btr0"] },
        { requirement_id: "TR-GN-CANInit-003", content: "软件应配置CANA的CDR。", table_refs: ["a-cdr"] },
        { requirement_id: "TR-GN-CANInit-004", content: "软件应配置CANB的CDR。", table_refs: ["b-cdr"] },
      ],
      tables: [
        { table_id: "a-btr0", title: "CANA BTR0配置", columns: ["名称", "地址/寄存器地址", "初值", "初值含义"], rows: [row("BTR0")] },
        { table_id: "b-btr0", title: "CANB BTR0配置", columns: ["名称", "地址/寄存器地址", "初值", "初值含义"], rows: [row("BTR0")] },
        { table_id: "a-cdr", title: "CANA CDR配置", columns: ["名称", "地址/寄存器地址", "初值", "初值含义"], rows: [row("CDR")] },
        { table_id: "b-cdr", title: "CANB CDR配置", columns: ["名称", "地址/寄存器地址", "初值", "初值含义"], rows: [row("CDR")] },
      ],
    })
    const channels = await finalize()
    expect(channels.ok).toBe(true)
    const channelItem = readJson<any>(channels.output.functional_init_content_path).items[1]
    expect(channelItem.processing).toHaveLength(4)
    expect(channelItem.processing.map((entry: any) => entry.table_refs)).toEqual([
      ["a-btr0"], ["b-btr0"], ["a-cdr"], ["b-cdr"],
    ])
    expect(channelItem.tables.map((table: any) => [table.title, table.rows.length])).toEqual([
      ["CANA BTR0配置", 1],
      ["CANB BTR0配置", 1],
      ["CANA CDR配置", 1],
      ["CANB CDR配置", 1],
    ])

    writeRaw({
      title_no: "4.1.1.2", title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
      tr_code: "TR-GN-CANInit", source_ref: "primary::SRS-3.2.1.2", summary: "初始化CAN总线。",
      processing: [{ requirement_id: "TR-GN-CANInit-001", content: "软件应完成CAN总线初始化。", table_refs: ["can"] }],
      tables: [{
        table_id: "can", title: "CAN总线初始化设置表",
        columns: ["名称", "地址/寄存器地址", "初值", "初值含义"],
        rows: [row("BTR0"), row("CDR")],
      }],
    })
    const alreadyCorrect = await finalize()
    expect(alreadyCorrect.ok).toBe(true)
    const correctItem = readJson<any>(alreadyCorrect.output.functional_init_content_path).items[1]
    expect(correctItem.processing[0].content).toBe("软件应完成CAN总线初始化。")
    expect(correctItem.tables[0].rows).toHaveLength(2)
  })

  test("functional init raw with table-reference wording finalizes successfully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-init-table-ref-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalSourceArtifacts(dir)
    const titleTreePath = writeFunctionalTitleTreeArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-init-content.raw.json")

    writeJson(rawPath, {
      section_title_no: "4.1.1",
      section_title: "初始化功能需求项",
      allow_code: false,
      items: [
        {
          title_no: "4.1.1.1",
          title: "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
          tr_code: "TR-GN-80C32Init",
          source_ref: "primary::SRS-3.2.1.1",
          summary: "软件上电或复位后应对 80C32 控制器进行初始化。",
          processing: [
            {
              requirement_id: "TR-GN-80C32Init-001",
              content: "软件上电后按见表3完成 IE 中断允许寄存器初始化。",
              table_refs: [],
            },
          ],
          tables: [],
        },
        {
          title_no: "4.1.1.2",
          title: "CAN 控制器初始化功能需求项[TR-GN-CANInit]",
          tr_code: "TR-GN-CANInit",
          source_ref: "primary::SRS-3.2.1.2",
          summary: "软件上电或复位后应对 CAN 控制器进行初始化。",
          processing: [
            {
              requirement_id: "TR-GN-CANInit-001",
              content: "软件上电后设置 BTR0 总线时序寄存器 0，使 CAN 控制器进入规定通信状态。",
              table_refs: [],
            },
          ],
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const prepared = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        functional_init_content_raw_path: rawPath,
      },
      makeCtx(dir),
    ))
    expect(prepared.incremental_reuse).toBe(true)

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_init_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        functional_init_content_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    const model = readJson<any>(result.output.functional_init_content_path)
    expect(model.items[0].processing[0].content).toContain("见表3")
  })

  test("keeps large functional other worker sets compact and retrieves one validated batch at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-many-batches-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalOtherSourceArtifacts(dir)
    const titleTreePath = writeFunctionalOtherTitleTreeArtifact(dir)
    const titleTree = readJson<any>(titleTreePath)
    titleTree.children[1].children = Array.from({ length: 19 }, (_, index) => ({
      title_no: `4.1.2.${index + 1}`,
      title: `功能${index + 1}[TR-GN-F${index + 1}]`,
      tr_code: `TR-GN-F${index + 1}`,
      source_ref: `primary::SRS-3.2.3.${index + 1}`,
      children: [],
    }))
    writeJson(titleTreePath, titleTree)
    const hardwareReportPath = writeHardwareInterfaceReportArtifact(dir)

    const prep = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_functional_other_content",
      source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_path: titleTreePath,
      hardware_interface_report_path: hardwareReportPath,
    }, makeCtx(dir)))

    expect(prep.ok).toBe(true)
    expect(prep.summary.worker_batch_count).toBe(19)
    expect(prep.worker_batches).toHaveLength(19)
    expect(prep.worker_batches.every((batch: any) => batch.worker_prompt === undefined && batch.worker_payload === undefined)).toBe(true)
    expect(JSON.stringify(prep).length).toBeLessThan(20_000)
    expect(readJson<any>(prep.output.functional_other_content_worker_manifest_path).worker_batches).toHaveLength(19)

    const last = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "get_functional_other_content_worker_batch",
      functional_other_content_worker_manifest_path: prep.output.functional_other_content_worker_manifest_path,
      functional_other_content_worker_batch_index: 19,
    }, makeCtx(dir)))
    expect(last.ok).toBe(true)
    expect(last.worker_batch.worker_payload.target_leaf.title_no).toBe("4.1.2.19")
    expect(last.worker_batch.worker_prompt).toContain("$functional-other-requirements")

    const outOfRange = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "get_functional_other_content_worker_batch",
      functional_other_content_worker_manifest_path: prep.output.functional_other_content_worker_manifest_path,
      functional_other_content_worker_batch_index: 20,
    }, makeCtx(dir)))
    expect(outOfRange.error).toContain("out of range")

    titleTree.children[1].children[0].title = "changed"
    writeJson(titleTreePath, titleTree)
    const stale = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "get_functional_other_content_worker_batch",
      functional_other_content_worker_manifest_path: prep.output.functional_other_content_worker_manifest_path,
      functional_other_content_worker_batch_index: 1,
    }, makeCtx(dir)))
    expect(stale.error).toContain("stale or invalid")
    expect(stale.rerun_required).toBe("prepare_functional_other_content")
  })

  test("prepares and finalizes functional other content artifacts with DOCX preview", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-content-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalOtherSourceArtifacts(dir)
    const titleTreePath = writeFunctionalOtherTitleTreeArtifact(dir)
    const hardwareReportPath = writeHardwareInterfaceReportArtifact(dir)

    const prep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
      },
      makeCtx(dir),
    ))

    expect(prep.ok).toBe(true)
    expect(prep.worker_batches).toHaveLength(2)
    expect(prep.summary.worker_batch_count).toBe(2)
    expect(existsSync(prep.output.functional_other_content_worker_manifest_path)).toBe(true)
    expect(prep.worker_batches[0].worker_prompt).toBeUndefined()
    expect(prep.worker_batches[0].batch_index).toBe(1)
    const firstBatchResult = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "get_functional_other_content_worker_batch",
        functional_other_content_worker_manifest_path: prep.output.functional_other_content_worker_manifest_path,
        functional_other_content_worker_batch_index: 1,
      },
      makeCtx(dir),
    ))
    const secondBatchResult = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "get_functional_other_content_worker_batch",
        functional_other_content_worker_manifest_path: prep.output.functional_other_content_worker_manifest_path,
        functional_other_content_worker_batch_index: 2,
      },
      makeCtx(dir),
    ))
    expect(firstBatchResult.ok).toBe(true)
    const firstBatch = firstBatchResult.worker_batch
    const secondBatch = secondBatchResult.worker_batch
    expect(firstBatch.subagent_type).toBe("functional-other-content-modeler")
    expect(firstBatch.worker_prompt).toContain("$functional-other-requirements")
    expect(firstBatch.worker_prompt).toContain("$hardware-interface-dataflow-constraints")
    expect(firstBatch.worker_prompt).toContain("软件/CPU是被测件")
    expect(firstBatch.worker_prompt).toContain("跨接口转换写入 processing")
    expect(firstBatch.worker_prompt).toContain("不得复制为下游接口输入")
    expect(firstBatch.worker_prompt).toContain("payload.target_leaf")
    expect(firstBatch.worker_payload.hardware_interface_report_path).toBe(hardwareReportPath)
    expect(existsSync(prep.output.source_artifacts_path)).toBe(true)
    expect(firstBatch.worker_payload.source_artifacts_path).toBe(prep.output.source_artifacts_path)
    expect(existsSync(prep.output.hardware_interface_report_text_path)).toBe(true)
    expect(firstBatch.worker_payload.hardware_interface_report_text_path).toBe(prep.output.hardware_interface_report_text_path)
    expect(firstBatch.worker_payload.target_leaf).toEqual({
      title_no: "4.1.2.1",
      title: "AD遥测功能需求项[TR-GN-YC-AD]",
      tr_code: "TR-GN-YC-AD",
      source_ref: "primary::SRS-3.2.3.1",
    })
    expect(secondBatch.worker_payload.target_leaf.title_no).toBe("4.1.2.2")
    expect(firstBatch.worker_payload.excluded_title_nos).toEqual(["4.1.1"])
    expect(prep.output.functional_other_content_raw_paths).toEqual([
      firstBatch.output_path,
      secondBatch.output_path,
    ])
    expect(prep.output.functional_other_content_raw_paths[0]).toContain("functional-other-content-leaves")
    expect(prep.output.functional_other_content_raw_paths[0]).toContain("001-4.1.2.1.raw.json")
    expect(firstBatch.worker_prompt).toContain("source-artifacts.json")
    expect(firstBatch.worker_prompt).toContain("source_artifacts_path")
    expect(firstBatch.worker_prompt).toContain("不得读取segments_path或toc_path")
    expect(firstBatch.worker_prompt).toContain("跟随其中的structure_path读取需求正文")
    expect(firstBatch.worker_prompt).toContain("hardware_interface_report_text_path")
    expect(firstBatch.worker_prompt).toContain("不要直接读取 hardware_interface_report_path")
    expect(firstBatch.worker_prompt).toContain("硬件接口参考来源固定为当前项目 .matrix/reports/hardware-interface-model.docx")
    expect(firstBatch.worker_prompt).toContain("第三章格式表是接口格式的优先且唯一展示位置")
    expect(firstBatch.worker_prompt).toContain("按照表3.x规定的格式接收/发送")
    expect(firstBatch.worker_prompt).toContain("只有第三章确无对应格式表时")
    expect(firstBatch.worker_prompt).toContain("以hardware_interface_report_text_path中的表格及表号为准")
    expect(firstBatch.worker_prompt).toContain("worker仅可自行写hardware_interface_report_text_path中已确认的原表号")
    expect(firstBatch.worker_prompt).toContain("不要输出 processing_preamble 字段")
    expect(firstBatch.worker_prompt).toContain("正文不得复述表格已完整承载的字段")
    expect(firstBatch.worker_prompt).toContain("不复述帧数量、完整控制场、DATA/W0～Wn布局")
    expect(firstBatch.worker_prompt).toContain("只保留当前TR实际执行的SUM/CRC、DLC/Length")
    expect(firstBatch.worker_prompt).toContain("决定功能分支的数据特征字段")
    expect(firstBatch.worker_prompt).toContain("input_flow 和 output_flow 只输出相应名称，不展开描述格式")
    expect(firstBatch.worker_prompt).toContain("第三章已有的完整格式不得重复写入tables")
    expect(firstBatch.worker_prompt).toContain("processing.content使用一条或多条连贯、确定、可测试的自然语言需求语句")
    expect(firstBatch.worker_prompt).toContain("禁止按“前置条件：xxx。处理动作：yyy。可观测输出：zzz。”固定模板拼接正文")
    expect(firstBatch.worker_prompt).toContain("不要求每条需求机械包含全部要素")
    expect(firstBatch.worker_prompt).toContain("按照表3.1.6-2规定的格式接收上行遥控包")
    expect(firstBatch.worker_prompt).toContain("示例行为和表号不得脱离来源照搬")
    expect(firstBatch.worker_prompt).toContain("不要只写“解析数据”“完成处理”")
    expect(firstBatch.worker_prompt).toContain("每个item必须包含tables")
    expect(firstBatch.worker_prompt).toContain("worker仅可自行写hardware_interface_report_text_path中已确认的原表号")
    const hardwareReportText = readFileSync(prep.output.hardware_interface_report_text_path, "utf-8")
    expect(hardwareReportText).toContain("表3.1-1 接口定义")

    for (const batch of [firstBatch, secondBatch]) {
      const leaf = batch.worker_payload.target_leaf
      writeJson(batch.output_path, {
        section_title_no: "4.1",
        section_title: "功能测试",
        excluded_title_nos: ["4.1.1"],
        items: [{
          title_no: leaf.title_no,
          title: leaf.title,
          tr_code: leaf.tr_code,
          source_ref: leaf.source_ref,
          summary: "旧版正文。",
          input_flow: ["输入。"],
          processing: [{ requirement_id: `${leaf.tr_code}-001`, content: "旧版逐字展开表格正文。" }],
          output_flow: ["输出。"],
        }],
        skipped_title_refs: [],
        open_questions: [],
      })
    }
    const stalePrep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
      },
      makeCtx(dir),
    ))
    expect(stalePrep.worker_batches).toHaveLength(2)
    expect(stalePrep.summary.reused_raw_artifact_count).toBe(0)

    writeJson(firstBatch.output_path, {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: ["4.1.1"],
      items: [
        {
          title_no: "4.1.2.1",
          title: "AD遥测功能需求项[TR-GN-YC-AD]",
          tr_code: "TR-GN-YC-AD",
          source_ref: "primary::SRS-3.2.3.1",
          summary: "软件通过 AD 采集接口采集 A/D 参数。",
          input_flow: ["A/D 参数。"],
          processing: [
            {
              requirement_id: "TR-GN-YC-AD-001",
              source_refs: ["primary::SRS-3.2.3.1"],
              content: "软件通过 AD 数据采集接口采集 A/D 数据。",
              table_refs: ["ad-field-map"],
            },
            {
              requirement_id: "TR-GN-YC-AD-002",
              source_refs: ["primary::SRS-3.2.3.1"],
              content: "软件按第三章硬件接口中 AD 数据采集接口的采集过程进行处理。",
              table_refs: [],
            },
          ],
          output_flow: ["A/D 参数。", "速变遥测数据。", "缓变遥测数据。"],
          tables: [
            {
              table_id: "ad-field-map",
              title: "A/D 数据字段映射表",
              columns: ["字段", "含义"],
              rows: [
                { 字段: "W0", 含义: "母线电压" },
                { 字段: "W1", 含义: "蓄电池电压" },
              ],
            },
          ],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })
    writeJson(secondBatch.output_path, {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: ["4.1.1"],
      items: [
        {
          title_no: "4.1.2.2",
          title: "固存数据采集功能需求项[TR-GN-YC-GC]",
          tr_code: "TR-GN-YC-GC",
          source_ref: "primary::SRS-3.2.3.2",
          summary: "软件采集固存数据并形成遥测输出。",
          input_flow: ["固存数据。"],
          processing: [
            {
              requirement_id: "TR-GN-YC-GC-001",
              source_refs: ["primary::SRS-3.2.3.2"],
              content: "软件读取固存数据并进行格式化处理。",
              table_refs: [],
            },
          ],
          output_flow: ["固存数据采集结果。"],
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const incrementalOtherPrep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
      },
      makeCtx(dir),
    ))
    expect(incrementalOtherPrep.ok).toBe(true)
    expect(incrementalOtherPrep.worker_batches).toHaveLength(0)
    expect(incrementalOtherPrep.output.functional_other_content_raw_paths).toEqual(prep.output.functional_other_content_raw_paths)
    expect(incrementalOtherPrep.summary.worker_batch_count).toBe(0)
    expect(incrementalOtherPrep.summary.reused_raw_artifact_count).toBe(2)
    expect(incrementalOtherPrep.reused_raw_artifacts.map((artifact: any) => artifact.target_leaf.title_no)).toEqual(["4.1.2.1", "4.1.2.2"])

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_paths: prep.output.functional_other_content_raw_paths,
        functional_other_content_path: prep.output.functional_other_content_path,
        functional_other_content_report_path: prep.output.functional_other_content_report_path,
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    expect(result.summary).toEqual({
      item_count: 2,
      processing_count: 3,
      raw_file_count: 2,
    })
    const model = readJson<any>(prep.output.functional_other_content_path)
    expect(model.section_title_no).toBe("4.1")
    expect(model.items[0].tr_code).toBe("TR-GN-YC-AD")
    expect(model.items[0].tables[0].table_no).toBe("表4.1.2.1-1")
    expect(model.items[0]).not.toHaveProperty("processing_preamble")
    expect(existsSync(prep.output.functional_other_content_report_path)).toBe(true)
    const zip = readZip(readFileSync(prep.output.functional_other_content_report_path))
    const documentXml = zip.get("word/document.xml")?.toString("utf-8") || ""
    expect(documentXml).toContain("4.1 功能测试")
    const parentTitleIndex = documentXml.indexOf("4.1.2 遥测采集功能需求项")
    const firstLeafTitleIndex = documentXml.indexOf("4.1.2.1 AD遥测功能需求项[TR-GN-YC-AD]")
    expect(parentTitleIndex).toBeGreaterThan(-1)
    expect(firstLeafTitleIndex).toBeGreaterThan(parentTitleIndex)
    expect(documentXml).toContain("4.1.2.1 AD遥测功能需求项[TR-GN-YC-AD]")
    expect(documentXml).toContain("4.1.2.1.1 输入流说明")
    expect(documentXml).toContain("4.1.2.1.2 处理")
    expect(documentXml).not.toContain("使用的计算公式：")
    expect(documentXml).not.toContain("Q当前=150Ah+Q充-Q放")
    expect(documentXml).toContain("TR-GN-YC-AD-001：软件通过 AD 数据采集接口采集 A/D 数据。")
    expect(documentXml).toContain("详细格式见表4.1.2.1-1。")
    expect(documentXml).toContain("表4.1.2.1-1 A/D 数据字段映射表")
    expect(documentXml).toContain("母线电压")
    expect(documentXml).toContain("蓄电池电压")
    expect(documentXml).toContain("测试充分性要求：C1、C2、C3、C4；")
    expectIndentedParagraph(documentXml, "软件通过 AD 采集接口采集 A/D 参数。")
    expectIndentedParagraph(documentXml, "A/D 参数。")
    expectIndentedParagraph(documentXml, "TR-GN-YC-AD-001：软件通过 AD 数据采集接口采集 A/D 数据。")
    expectIndentedParagraph(documentXml, "a. A/D 参数；")
    expectIndentedParagraph(documentXml, "b. 速变遥测数据；")
    expectIndentedParagraph(documentXml, "c. 缓变遥测数据。")
    expectIndentedParagraph(documentXml, "测试充分性要求：C1、C2、C3、C4；")

    rmSync(prep.output.functional_other_content_report_path)
    const editorFastPath = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "finalize_functional_other_content",
      functional_other_content_raw_paths: prep.output.functional_other_content_raw_paths,
      skip_intermediate_report: true,
    }, makeCtx(dir)))
    expect(editorFastPath.ok).toBe(true)
    expect(editorFastPath.output.functional_other_content_report_path).toBeUndefined()
    expect(existsSync(prep.output.functional_other_content_report_path)).toBe(false)

    const validFirstRaw = readJson<any>(firstBatch.output_path)
    const finalizeWithFirstRaw = async (raw: any) => {
      writeJson(firstBatch.output_path, raw)
      return JSON.parse(await (filldataPhase2Workflow as any).execute(
        {
          mode: "finalize_functional_other_content",
          source_artifacts_path: sourceArtifactsPath,
          functional_title_tree_path: titleTreePath,
          hardware_interface_report_path: hardwareReportPath,
          functional_other_content_raw_paths: prep.output.functional_other_content_raw_paths,
        },
        makeCtx(dir),
      ))
    }

    const unknown = structuredClone(validFirstRaw)
    unknown.items[0].processing[0].table_refs = ["missing-table"]
    expect((await finalizeWithFirstRaw(unknown)).ok).toBe(true)

    const unknownSource = structuredClone(validFirstRaw)
    unknownSource.items[0].processing[0].source_refs = ["primary::SRS-UNKNOWN"]
    const unknownSourceResult = await finalizeWithFirstRaw(unknownSource)
    expect(unknownSourceResult.ok).toBe(true)
    expect(unknownSourceResult.skipped_count).toBeGreaterThan(0)

    const duplicate = structuredClone(validFirstRaw)
    duplicate.items[0].processing[0].table_refs = ["ad-field-map", "ad-field-map"]
    expect((await finalizeWithFirstRaw(duplicate)).ok).toBe(true)

    const orphan = structuredClone(validFirstRaw)
    orphan.items[0].processing[0].table_refs = []
    expect((await finalizeWithFirstRaw(orphan)).ok).toBe(true)

    const mismatchedRow = structuredClone(validFirstRaw)
    mismatchedRow.items[0].tables[0].rows[0] = { 字段: "W0" }
    expect((await finalizeWithFirstRaw(mismatchedRow)).ok).toBe(true)
  })

  test("finalize_functional_other_content requires prepared leaf raw paths and never falls back to a legacy aggregate raw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-no-legacy-fallback-"))
    TEMP_DIRS.push(dir)
    const legacyRawPath = join(dir, ".matrix", "data", "functional-other-content.raw.json")
    writeJson(legacyRawPath, { items: [] })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      { mode: "finalize_functional_other_content" },
      makeCtx(dir),
    ))

    expect(result.error).toContain("functional_other_content_raw_paths is required")
    expect(result.missing_prerequisite).toBe("functional_other_content_raw_paths")
    expect(result.rerun_required).toBe("prepare_functional_other_content")
  })

  test("finalize_functional_other_content validates leaf raw artifact paths and target leaves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-leaf-errors-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalOtherSourceArtifacts(dir)
    const titleTreePath = writeFunctionalOtherTitleTreeArtifact(dir)
    const hardwareReportPath = writeHardwareInterfaceReportArtifact(dir)

    const prep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
      },
      makeCtx(dir),
    ))
    const rawPaths = prep.output.functional_other_content_raw_paths

    const missing = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_paths: rawPaths,
      },
      makeCtx(dir),
    ))
    expect(missing.error).toContain("functional_other_content_raw_paths[0]: File not found")

    writeFileSync(rawPaths[0], "{\"section_title_no\": \"4.1\", 软")
    const malformed = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_paths: rawPaths,
      },
      makeCtx(dir),
    ))
    expect(malformed.error).toContain("functional_other_content_raw_paths[0]")
    expect(malformed.error).toContain(rawPaths[0])
    expect(malformed.error).toContain("target_leaf=4.1.2.1")
    expect(malformed.error).toContain("JSON Parse error")

    writeJson(rawPaths[0], {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: ["4.1.1"],
      items: [],
      skipped_title_refs: [],
      open_questions: [],
    })
    const emptyItems = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_paths: rawPaths,
      },
      makeCtx(dir),
    ))
    expect(emptyItems.ok).toBe(false) // The other required leaf raw file has not been written yet.

    writeJson(rawPaths[0], {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: ["4.1.1"],
      items: [
        {
          title_no: "4.1.2.2",
          title: "固存数据采集功能需求项[TR-GN-YC-GC]",
          tr_code: "TR-GN-YC-GC",
          source_ref: "primary::SRS-3.2.3.2",
          summary: "错误叶子。",
          input_flow: [],
          processing: [],
          output_flow: [],
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })
    const mismatchedLeaf = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_paths: rawPaths,
      },
      makeCtx(dir),
    ))
    expect(mismatchedLeaf.ok).toBe(false) // The second required raw file is still missing.
  })

  test("functional other raw with table-reference wording finalizes successfully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-table-ref-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalOtherSourceArtifacts(dir)
    const titleTreePath = writeFunctionalOtherTitleTreeArtifact(dir)
    const hardwareReportPath = writeHardwareInterfaceReportArtifact(dir)

    const prep = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
      },
      makeCtx(dir),
    ))
    const rawPaths = prep.output.functional_other_content_raw_paths

    writeJson(rawPaths[0], {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: ["4.1.1"],
      items: [
        {
          title_no: "4.1.2.1",
          title: "AD遥测功能需求项[TR-GN-YC-AD]",
          tr_code: "TR-GN-YC-AD",
          source_ref: "primary::SRS-3.2.3.1",
          summary: "软件通过 AD 采集接口采集 A/D 参数。",
          input_flow: ["A/D 参数。"],
          processing: [
            {
              requirement_id: "TR-GN-YC-AD-001",
              content: "软件接收遥测数据后见附录表15~表17解析 AD 通道。",
              table_refs: [],
            },
          ],
          output_flow: ["A/D 参数。"],
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })
    writeJson(rawPaths[1], {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: ["4.1.1"],
      items: [
        {
          title_no: "4.1.2.2",
          title: "固存数据采集功能需求项[TR-GN-YC-GC]",
          tr_code: "TR-GN-YC-GC",
          source_ref: "primary::SRS-3.2.3.2",
          summary: "软件采集固存数据并形成遥测输出。",
          input_flow: ["固存数据。"],
          processing: [
            {
              requirement_id: "TR-GN-YC-GC-001",
              content: "软件读取固存数据并进行格式化处理。",
              table_refs: [],
            },
          ],
          output_flow: ["固存数据采集结果。"],
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const reused = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
      },
      makeCtx(dir),
    ))
    expect(reused.worker_batches).toHaveLength(0)
    expect(reused.summary.reused_raw_artifact_count).toBe(2)

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_paths: rawPaths,
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    const model = readJson<any>(result.output.functional_other_content_path)
    expect(model.items[0].processing[0].content).toContain("见附录表15~表17")
  })

  test("functional other content allows 4.1.1 when there is no initialization route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-no-init-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath, titleTreePath } = writeFunctionalOtherNoInitArtifacts(dir)
    const hardwareReportPath = writeHardwareInterfaceReportArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-other-content-leaves", "001-4.1.1.1.raw.json")

    writeJson(rawPath, {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: [],
      items: [
        {
          title_no: "4.1.1.1",
          title: "轮询控制处理功能需求项[TR-GN-PollCtrl]",
          tr_code: "TR-GN-PollCtrl",
          source_ref: "primary::SRS-3.2.2.1",
          summary: "软件解析并执行轮询控制处理。",
          input_flow: [],
          processing: [
            { requirement_id: "TR-GN-PollCtrl-001", content: "软件应解析轮询控制指令并执行相应处理。", table_refs: [] },
          ],
          output_flow: [],
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_paths: [rawPath],
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    const model = readJson<any>(result.output.functional_other_content_path)
    expect(model.excluded_title_nos).toEqual([])
    expect(model.items[0].title_no).toBe("4.1.1.1")
    const zip = readZip(readFileSync(result.output.functional_other_content_report_path))
    const documentXml = zip.get("word/document.xml")?.toString("utf-8") || ""
    expect(documentXml).toContain("无。")
  })

  test("finalize_functional_test_content assembles initialization and other content by title tree order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-test-content-"))
    TEMP_DIRS.push(dir)
    const titleTreePath = writeFunctionalOtherTitleTreeArtifact(dir)
    const titleTree = readJson<any>(titleTreePath)
    const initLeaf = titleTree.children[0].children[0]
    const otherLeaves = titleTree.children[1].children
    const initContentPath = join(dir, ".matrix", "data", "functional-init-content.json")
    const otherContentPath = join(dir, ".matrix", "data", "functional-other-content.json")

    writeJson(initContentPath, {
      chapter_title_no: "4",
      chapter_title: titleTree.chapter_title,
      parent_section_title_no: "4.1",
      parent_section_title: titleTree.section_title,
      section_title_no: titleTree.routing.initialization_title_no,
      section_title: titleTree.children[0].title,
      allow_code: false,
      items: [
        {
          title_no: initLeaf.title_no,
          title: initLeaf.title,
          tr_code: initLeaf.tr_code,
          source_ref: initLeaf.source_ref,
          summary: "init summary",
          input_flow: ["无。"],
          processing: [
            {
              requirement_id: `${initLeaf.tr_code}-001`,
              content: "init processing",
              table_refs: ["init-registers"],
            },
            {
              requirement_id: `${initLeaf.tr_code}-002`,
              content: "wait for controller ready",
              table_refs: [],
            },
          ],
          output_flow: ["init output"],
          tables: [{
            table_id: "init-registers",
            table_no: `表${initLeaf.title_no}-1`,
            title: "初始化说明表",
            columns: ["名称", "地址/寄存器地址", "初值", "初值含义"],
            rows: [{ "名称": "IE", "地址/寄存器地址": "A8H", "初值": "80H", "初值含义": "允许总中断" }],
          }],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })
    writeJson(otherContentPath, {
      chapter_title_no: "4",
      chapter_title: titleTree.chapter_title,
      section_title_no: "4.1",
      section_title: titleTree.section_title,
      excluded_title_nos: ["4.1.1"],
      items: otherLeaves.map((leaf: any, index: number) => ({
        title_no: leaf.title_no,
        title: leaf.title,
        tr_code: leaf.tr_code,
        source_ref: leaf.source_ref,
        summary: `other summary ${index + 1}`,
        input_flow: [`input ${index + 1}`],

        processing: [
          {
            requirement_id: `${leaf.tr_code}-001`,
            content: `processing ${index + 1}`,
            table_refs: index === 0 ? ["other-field-map"] : [],
          },
        ],
        output_flow: [`output ${index + 1}`],
        tables: index === 0 ? [{
          table_id: "other-field-map",
          table_no: `表${leaf.title_no}-1`,
          title: "字段映射表",
          columns: ["字段", "含义"],
          rows: [{ 字段: "W0", 含义: "母线电压" }],
        }] : [],
      })),
      skipped_title_refs: [],
      open_questions: [],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_test_content",
        functional_title_tree_path: titleTreePath,
        functional_init_content_path: initContentPath,
        functional_other_content_path: otherContentPath,
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(true)
    expect(result.summary).toMatchObject({
      has_initialization: true,
      leaf_count: 3,
      initialization_item_count: 1,
      other_item_count: 2,
      processing_count: 4,
    })
    const model = readJson<any>(result.output.functional_test_content_path)
    expect(JSON.stringify(model)).not.toContain("\"test_requirements\"")
    expect(model.children.map((node: any) => node.title_no)).toEqual(["4.1.1", "4.1.2"])
    expect(model.children[0].children[0].content_type).toBe("initialization")
    expect(model.children[1].children[0].content_type).toBe("other")
    expect(JSON.stringify(model)).not.toContain("processing_preamble")
    const zip = readZip(readFileSync(result.output.functional_test_content_report_path))
    const documentXml = zip.get("word/document.xml")?.toString("utf-8") || ""
    expect(documentXml).toContain("4.1.1")
    expect(documentXml).toContain("4.1.2")
    expect(documentXml.indexOf("4.1.1")).toBeLessThan(documentXml.indexOf("4.1.2"))
    expect(documentXml).not.toContain("使用的计算公式：")
    expect(documentXml).not.toContain("Q当前=150Ah+Q充-Q放")
    expect(documentXml).toContain("4.1.1.1.1 输入流说明")
    expect(documentXml).toContain(`${initLeaf.tr_code}-001：init processing`)
    expect(documentXml).toContain(`具体初始化设置见表${initLeaf.title_no}-1。`)
    expect(documentXml.indexOf(`${initLeaf.tr_code}-001：init processing`)).toBeLessThan(documentXml.indexOf(`具体初始化设置见表${initLeaf.title_no}-1。`))
    expect(documentXml).toContain(`${initLeaf.tr_code}-002：wait for controller ready`)
    expect(documentXml.match(/具体初始化设置见表/g)).toHaveLength(1)
    expect(documentXml).toContain("TR-GN-YC-AD-001")
    expect(documentXml).toContain(`详细格式见表${otherLeaves[0].title_no}-1。`)
    expect(documentXml).toContain(`表${otherLeaves[0].title_no}-1 字段映射表`)
    expect(documentXml).toContain("母线电压")
    expectIndentedParagraph(documentXml, "init summary")
    expectIndentedParagraph(documentXml, "other summary 1")
    expectIndentedParagraph(documentXml, "无。")
    expectIndentedParagraph(documentXml, `${initLeaf.tr_code}-001：init processing`)
    expectIndentedParagraph(documentXml, "input 1。")
    expectIndentedParagraph(documentXml, "TR-GN-YC-AD-001：processing 1")
    expectIndentedParagraph(documentXml, "output 1。")
    expectIndentedParagraph(documentXml, "测试终止要求：Z1、Z2；")
  })

  test("finalize_functional_test_content rejects a finalized tree without initialization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-test-no-init-"))
    TEMP_DIRS.push(dir)
    const { titleTreePath } = writeFunctionalOtherNoInitArtifacts(dir)
    const titleTree = readJson<any>(titleTreePath)
    const leaf = titleTree.children[0].children[0]
    const otherContentPath = join(dir, ".matrix", "data", "functional-other-content.json")

    writeJson(otherContentPath, {
      chapter_title_no: "4",
      chapter_title: titleTree.chapter_title,
      section_title_no: "4.1",
      section_title: titleTree.section_title,
      excluded_title_nos: [],
      items: [
        {
          title_no: leaf.title_no,
          title: leaf.title,
          tr_code: leaf.tr_code,
          source_ref: leaf.source_ref,
          summary: "ordinary 4.1.1 content",
          input_flow: [],
          processing: [
            {
              requirement_id: `${leaf.tr_code}-001`,
              content: "processing",
            },
          ],
          output_flow: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_test_content",
        functional_title_tree_path: titleTreePath,
        functional_other_content_path: otherContentPath,
      },
      makeCtx(dir),
    ))

    expect(result.ok).toBe(false)
    expect(result.error).toContain("must contain the required initialization node")
  })

  test("prepare_functional_other_content reports missing hardware report prerequisite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-missing-hardware-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalOtherSourceArtifacts(dir)
    const titleTreePath = writeFunctionalOtherTitleTreeArtifact(dir)

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
      },
      makeCtx(dir),
    ))

    expect(result.error).toContain("hardware-interface-model.docx")
    expect(result.missing_prerequisite).toBe("hardware_interface_report")
  })

  test("functional prepare modes require finalized hardware report text and do not regenerate it", async () => {
    const initDir = mkdtempSync(join(tmpdir(), "filldata-functional-init-missing-hardware-text-"))
    TEMP_DIRS.push(initDir)
    const { sourceArtifactsPath: initSourceArtifactsPath } = writeFunctionalSourceArtifacts(initDir)
    const initTitleTreePath = writeFunctionalTitleTreeArtifact(initDir)
    writeHardwareInterfaceReportArtifact(initDir)
    const initHardwareTextPath = join(initDir, ".matrix", "data", "hardware-interface-report-text.md")
    rmSync(initHardwareTextPath)

    const initResult = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_functional_init_content",
      source_artifacts_path: initSourceArtifactsPath,
      functional_title_tree_path: initTitleTreePath,
    }, makeCtx(initDir)))

    expect(initResult.error).toContain("hardware-interface-report-text.md")
    expect(initResult.missing_prerequisite).toBe("hardware_interface_report_text")
    expect(existsSync(initHardwareTextPath)).toBe(false)

    const otherDir = mkdtempSync(join(tmpdir(), "filldata-functional-other-missing-hardware-text-"))
    TEMP_DIRS.push(otherDir)
    const { sourceArtifactsPath: otherSourceArtifactsPath } = writeFunctionalOtherSourceArtifacts(otherDir)
    const otherTitleTreePath = writeFunctionalOtherTitleTreeArtifact(otherDir)
    writeHardwareInterfaceReportArtifact(otherDir)
    const otherHardwareTextPath = join(otherDir, ".matrix", "data", "hardware-interface-report-text.md")
    rmSync(otherHardwareTextPath)

    const otherResult = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_functional_other_content",
      source_artifacts_path: otherSourceArtifactsPath,
      functional_title_tree_path: otherTitleTreePath,
    }, makeCtx(otherDir)))

    expect(otherResult.error).toContain("hardware-interface-report-text.md")
    expect(otherResult.missing_prerequisite).toBe("hardware_interface_report_text")
    expect(existsSync(otherHardwareTextPath)).toBe(false)
  })

  test("prepare_functional_other_content reports missing source artifacts prerequisite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-missing-source-text-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalOtherSourceArtifacts(dir)
    const titleTreePath = writeFunctionalOtherTitleTreeArtifact(dir)
    const hardwareReportPath = writeHardwareInterfaceReportArtifact(dir)
    rmSync(sourceArtifactsPath)

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_functional_other_content",
      source_artifacts_path: sourceArtifactsPath,
      functional_title_tree_path: titleTreePath,
      hardware_interface_report_path: hardwareReportPath,
    }, makeCtx(dir)))

    expect(result.error).toContain("source-artifacts.json")
    expect(result.missing_prerequisite).toBe("source_artifacts")
  })

  test("finalize_functional_other_content does not accept the legacy aggregate raw artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-errors-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalOtherSourceArtifacts(dir)
    const titleTreePath = writeFunctionalOtherTitleTreeArtifact(dir)
    const hardwareReportPath = writeHardwareInterfaceReportArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-other-content.raw.json")

    writeJson(rawPath, {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: ["4.1.1"],
      items: [
        {
          title_no: "4.1.1.1",
          title: "控制器初始化功能需求项[TR-GN-CtrlInit]",
          tr_code: "TR-GN-CtrlInit",
          source_ref: "primary::SRS-3.2.1.1",
          summary: "初始化。",
          input_flow: [],
          processing: [],
          output_flow: [],
          tables: [],
        },
        {
          title_no: "4.1.2.2",
          title: "固存数据采集功能需求项[TR-GN-YC-GC]",
          tr_code: "TR-GN-YC-GC",
          source_ref: "primary::SRS-3.2.3.2",
          summary: "固存采集。",
          input_flow: [],
          processing: [],
          output_flow: [],
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const initItem = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(initItem.error).toContain("functional_other_content_raw_paths is required")
    return

    writeJson(rawPath, {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: ["4.1.1"],
      items: [
        {
          title_no: "4.1.2.1",
          title: "AD遥测功能需求项[TR-GN-YC-AD]",
          tr_code: "TR-GN-YC-AD",
          source_ref: "primary::SRS-3.2.3.1",
          summary: "AD 遥测。",
          input_flow: [],
          processing: [],
          output_flow: [],
          tables: [],
        },
        {
          title_no: "4.1.2.2",
          title: "固存数据采集功能需求项[TR-GN-YC-GC]",
          tr_code: "TR-GN-YC-GC",
          source_ref: "primary::SRS-3.2.3.2",
          summary: "固存采集。",
          input_flow: [],
          processing: [],
          output_flow: [],
          tables: [],
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const changedDefaults = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(changedDefaults.ok).toBe(true)
    const normalized = readJson<any>(changedDefaults.output.functional_other_content_path)
    expect(normalized.items.every((item: any) => item.test_requirements === undefined)).toBe(true)
    const reportXml = readZip(readFileSync(changedDefaults.output.functional_other_content_report_path))
      .get("word/document.xml")?.toString("utf-8") || ""
    expect(reportXml).toContain("测试充分性要求：C1、C2、C3、C4；")
    expect(reportXml).toContain("测试终止要求：Z1、Z2；")
    expect(reportXml).toContain("优先级：所有需求项为高优先级。")
    expect(reportXml).not.toContain("中优先级")
  })

  test("finalize_functional_other_content ignores a legacy aggregate raw artifact with invalid processing IDs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-functional-other-id-errors-"))
    TEMP_DIRS.push(dir)
    const { sourceArtifactsPath } = writeFunctionalOtherSourceArtifacts(dir)
    const titleTreePath = writeFunctionalOtherTitleTreeArtifact(dir)
    const hardwareReportPath = writeHardwareInterfaceReportArtifact(dir)
    const rawPath = join(dir, ".matrix", "data", "functional-other-content.raw.json")

    writeJson(rawPath, {
      section_title_no: "4.1",
      section_title: "功能测试",
      excluded_title_nos: ["4.1.1"],
      items: [
        {
          title_no: "4.1.2.1",
          title: "AD遥测功能需求项[TR-GN-YC-AD]",
          tr_code: "TR-GN-YC-AD",
          source_ref: "primary::SRS-3.2.3.1",
          summary: "AD 遥测。",
          input_flow: [],
          processing: [
            { requirement_id: "TR-GN-YC-AD-001", content: "采集 A/D 数据。", table_refs: [] },
            { requirement_id: "TR-GN-YC-AD-003", content: "处理 A/D 数据。", table_refs: [] },
          ],
          output_flow: [],
          tables: [],
        },
        {
          title_no: "4.1.2.2",
          title: "固存数据采集功能需求项[TR-GN-YC-GC]",
          tr_code: "TR-GN-YC-GC",
          source_ref: "primary::SRS-3.2.3.2",
          summary: "固存采集。",
          input_flow: [],
          processing: [],
          output_flow: [],
          tables: [],
        },
      ],
      skipped_title_refs: [],
      open_questions: [],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "finalize_functional_other_content",
        source_artifacts_path: sourceArtifactsPath,
        functional_title_tree_path: titleTreePath,
        hardware_interface_report_path: hardwareReportPath,
        functional_other_content_raw_path: rawPath,
      },
      makeCtx(dir),
    ))

    expect(result.error).toContain("functional_other_content_raw_paths is required")
  })


  test("prepare_document_artifacts stops with a clear error when the selected primary document is .doc", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-phase2-doc-primary-"))
    TEMP_DIRS.push(dir)

    const primaryPath = join(dir, "requirements.doc")
    const otherPath = join(dir, "protocol.txt")
    const candidatesPath = join(dir, ".matrix", "data", "phase2-document-candidates.json")
    const sourcePlanPath = join(dir, ".matrix", "data", "source-plan.json")
    writeFileSync(primaryPath, "binary placeholder", "utf-8")
    writeFileSync(otherPath, "1 Protocol\n1.1 CAN telemetry polling", "utf-8")
    writeJson(candidatesPath, {
      documents: [
        { file_path: primaryPath, file_name: "requirements.doc" },
        { file_path: otherPath, file_name: "protocol.txt" },
      ],
    })
    writeJson(sourcePlanPath, {
      primary_srs_path: primaryPath,
      other_document_paths: [otherPath],
    })

    const result = JSON.parse(await (filldataPhase2Workflow as any).execute(
      {
        mode: "prepare_document_artifacts",
        candidates_path: candidatesPath,
        source_plan_path: sourcePlanPath,
      },
      makeCtx(dir),
    ))

    expect(result.error).toContain("Please convert to .docx first")
    expect(result.error).toContain(primaryPath)
  })

  test("discovers, batches, merges, and finalizes generic hardware interfaces in waves of five", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-generic-hardware-"))
    TEMP_DIRS.push(dir)
    const primaryPath = join(dir, "requirements.docx")
    writeDocx(primaryPath, [
      heading(1, "数据及接口需求"),
      heading(2, "硬件接口"),
      paragraph("软件通过一级CAN、二级CAN、FPGA、AD、内部SPI和硬件狗接口与外部设备交互。"),
    ].join(""))
    const discover = JSON.parse(await (filldataPhase2Workflow as any).execute({ mode: "discover_documents" }, makeCtx(dir)))
    writeJson(discover.output.source_plan_path, { primary_srs_path: primaryPath, other_document_paths: [] })
    const prep = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_document_artifacts",
      candidates_path: discover.output.candidates_path,
      source_plan_path: discover.output.source_plan_path,
    }, makeCtx(dir)))

    expect(prep.summary).toEqual({ structure_warning_count: 0 })
    const preparedManifest = readJson<any>(prep.output.source_artifacts_path)
    expect(readJson<any>(preparedManifest.primary_document.structure_warnings_path).warnings).toEqual([])

    const discovery = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "discover_hardware_interface_candidates",
      source_artifacts_path: prep.output.source_artifacts_path,
    }, makeCtx(dir)))
    expect(discovery.discovery_batch.subagent_type).toBe("hardware-interface-discoverer")
    expect(discovery.discovery_batch.worker_prompt).toContain("同一父章节下名称仅以CANA/CANB或CAN A/CAN B通道标识区分")
    expect(discovery.discovery_batch.worker_prompt).toContain("一级/二级CAN、不同父章节、不同通信对象或独立物理接口不得合并")
    expect(discovery.discovery_batch.worker_prompt).toContain("必须全文搜索‘看门狗’")
    expect(discovery.discovery_batch.worker_prompt).toContain("interface_kind=watchdog")
    expect(discovery.discovery_batch.worker_prompt).toContain("不要求位于外部接口章节")
    const manifest = readJson<any>(prep.output.source_artifacts_path)
    const structure = readJson<any>(manifest.primary_document.structure_path)
    const sourceRef = structure.sections.find((section: any) => section.title === "硬件接口").source_ref
    const names = ["一级CAN总线", "二级CAN接口", "FPGA接口", "AD采集接口", "内部SPI总线", "硬件狗接口", "维护串口", "1553B总线接口"]
    const kinds = ["can", "can", "fpga", "ad", "spi", "watchdog", "serial", "mil1553b"]
    writeJson(discovery.output.hardware_interface_candidates_path, {
      model_version: 1,
      source_artifacts_path: prep.output.source_artifacts_path,
      candidates: names.map((name, index) => ({
        candidate_id: `HI-${String(index + 1).padStart(3, "0")}`,
        interface_name: name,
        interface_kind: kinds[index],
        keywords: [name],
        source_refs: [sourceRef],
        evidence_summary: `软件通过${name}与外部设备交互。`,
      })),
    })
    const reusedDiscovery = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "discover_hardware_interface_candidates",
      source_artifacts_path: prep.output.source_artifacts_path,
    }, makeCtx(dir)))
    expect(reusedDiscovery.incremental_reuse).toBe(true)
    expect(reusedDiscovery.summary).toEqual({ candidate_count: 8, raw_reused: true })
    expect(reusedDiscovery.discovery_batch).toBeUndefined()
    expect(reusedDiscovery.reused_artifacts).toEqual([{ output_path: discovery.output.hardware_interface_candidates_path }])

    const validCandidatesArtifact = readJson<any>(discovery.output.hardware_interface_candidates_path)
    writeJson(discovery.output.hardware_interface_candidates_path, {
      ...validCandidatesArtifact,
      source_artifacts_path: join(dir, ".matrix", "data", "different-source-artifacts.json"),
    })
    const staleDiscovery = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "discover_hardware_interface_candidates",
      source_artifacts_path: prep.output.source_artifacts_path,
    }, makeCtx(dir)))
    expect(staleDiscovery.incremental_reuse).toBe(true)
    expect(staleDiscovery.summary.raw_reused).toBe(true)
    expect(staleDiscovery.discovery_batch).toBeUndefined()
    writeJson(discovery.output.hardware_interface_candidates_path, validCandidatesArtifact)

    const batches = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_hardware_interface_batches",
      source_artifacts_path: prep.output.source_artifacts_path,
      hardware_interface_candidates_path: discovery.output.hardware_interface_candidates_path,
    }, makeCtx(dir)))
    expect(batches.worker_waves.map((wave: any[]) => wave.length)).toEqual([5, 3])
    expect(batches.summary.max_parallelism).toBe(5)
    expect(JSON.stringify(batches).length).toBeLessThan(15000)
    expect(batches.worker_batches.every((batch: any) => batch.worker_prompt === undefined)).toBe(true)
    const getHardwareBatch = async (kind: string) => {
      const compact = batches.worker_batches.find((batch: any) => batch.interface_kind === kind)
      const result = JSON.parse(await (filldataPhase2Workflow as any).execute({
        mode: "get_hardware_interface_worker_batch",
        hardware_interface_worker_batch_index: compact.batch_index,
      }, makeCtx(dir)))
      return result.worker_batch
    }
    const adBatch = await getHardwareBatch("ad")
    const serialBatch = await getHardwareBatch("serial")
    const mil1553bBatch = await getHardwareBatch("mil1553b")
    const canBatch = await getHardwareBatch("can")
    const watchdogBatch = await getHardwareBatch("watchdog")
    expect(adBatch.worker_prompt).toContain("$ad-acquisition-interface-analysis")
    expect(adBatch.worker_prompt).toContain("同一模拟量采集过程的处理分支")
    expect(adBatch.worker_prompt).toContain("禁止分别生成电压采集与电流采集topics")
    expect(adBatch.worker_prompt).toContain("其他真正独立的AD事务仍可生成topic")
    expect(adBatch.worker_prompt).toContain("不新增、转换、裁剪、重画或摘要化原表")
    expect(adBatch.worker_prompt).not.toContain("还必须加载并使用 $serial-interface-analysis")
    expect(serialBatch.worker_prompt).toContain("$serial-interface-analysis")
    expect(serialBatch.worker_prompt).not.toContain("还必须加载并使用 $ad-acquisition-interface-analysis")
    expect(mil1553bBatch.worker_prompt).toContain("$mil1553b-interface-analysis")
    expect(mil1553bBatch.worker_prompt).not.toContain("还必须加载并使用 $ad-acquisition-interface-analysis")
    expect(mil1553bBatch.worker_prompt).not.toContain("还必须加载并使用 $serial-interface-analysis")
    expect(mil1553bBatch.worker_prompt).toContain("逐项检查芯片名称、符合标准、传输速率、时钟频率、寄存器基地址、RAM基地址、零等待模式及位数、BC/RT/BM角色、RT地址和挂接中断")
    expect(mil1553bBatch.worker_prompt).toContain("允许写中断号或名称及挂接关系")
    expect(mil1553bBatch.worker_prompt).toContain("不得写优先级、触发方式、ISR、中断使能或寄存器配置")
    expect(mil1553bBatch.worker_prompt).toContain("T/R=0输入、T/R=1输出")
    expect(mil1553bBatch.worker_prompt).toContain("子地址分配原表必须完整进入overview_tables")
    expect(mil1553bBatch.worker_prompt).toContain("短名称、软件处理过程、数据格式表")
    expect(mil1553bBatch.worker_prompt).toContain("真实接收/发送子地址")
    expect(mil1553bBatch.worker_prompt).toContain("属性无证据不补造")
    expect(canBatch.worker_prompt).toContain("$can-bus-interface-analysis")
    expect(canBatch.worker_prompt).not.toContain("还必须加载并使用 $ad-acquisition-interface-analysis")
    expect(canBatch.worker_prompt).not.toContain("还必须加载并使用 $serial-interface-analysis")
    expect(canBatch.worker_prompt).not.toContain("还必须加载并使用 $mil1553b-interface-analysis")
    expect(canBatch.worker_prompt).toContain("初始化/初始设置/复位配置/寄存器初值表")
    expect(canBatch.worker_prompt).toContain("中断设置/配置/分配/优先级/触发方式表不得进入overview_tables")
    expect(canBatch.worker_prompt).toContain("仅含少量中断行的混合原表可完整保留")
    expect(canBatch.worker_prompt).toContain("不得写初始化时机/动作/初值/默认配置/结果")
    expect(canBatch.worker_prompt).toContain("通信对象、控制芯片、工作模式、波特率或数据传输速率、技术规范和数据格式")
    expect(canBatch.worker_prompt).toContain("必备要素无来源时写XX")
    expect(canBatch.worker_prompt).toContain("中断号或名称和挂接关系")
    expect(canBatch.worker_prompt).toContain("中断优先级、触发方式、ISR、中断使能或寄存器配置")
    expect(canBatch.worker_prompt).toContain("不得把排除内容转移到topic或输入输出流")
    expect(canBatch.worker_prompt).toContain("不重复‘通过CAN总线’、‘经CAN接口’")
    expect(canBatch.worker_prompt).toContain("合并的CANA/CANB候选必须同时读取两个来源章节并只生成一个三级接口")
    expect(canBatch.worker_prompt).toContain("A、B两条总线关系为XX")
    expect(canBatch.worker_prompt).toContain("同一业务事务在A、B通道内容等价时只生成一个topic")
    expect(canBatch.worker_prompt).toContain("原始地址表和格式表必须完整引用，不新增、裁剪或重画")
    expect(canBatch.worker_prompt).toContain("overview只保留指令码、输出地址、脉冲参数（脉宽、电平）")
    expect(canBatch.worker_prompt).toContain("内容等价或同一table_id的指令原表只在最匹配位置完整引用一次")
    expect(canBatch.worker_prompt).toContain("呈现采集地址和参数名称的真实原表")
    expect(canBatch.worker_prompt).toContain("数据流只明确实际参数及定义")
    expect(canBatch.worker_prompt).toContain("不重复软件读取、按地址采集或接口输入等接口动作")
    expect(canBatch.worker_prompt).not.toContain("T/R=0输入、T/R=1输出")
    expect(watchdogBatch.worker_prompt).toContain("$watchdog-interface-analysis")
    expect(watchdogBatch.worker_prompt).toContain("复位、看门狗、硬件狗、喂狗、狗咬、Watchdog")
    expect(watchdogBatch.worker_prompt).toContain("芯片型号、喂狗端口、喂狗电平或动作、狗咬时间和狗咬后的结果")
    expect(watchdogBatch.worker_prompt).toContain("缺失项在对应位置写XX")
    expect(watchdogBatch.worker_prompt).toContain("狗咬后的复位结果只写入overview")
    for (const batch of [adBatch, serialBatch, mil1553bBatch, canBatch]) {
      expect(batch.worker_prompt).not.toContain("还必须加载并使用 $watchdog-interface-analysis")
    }
    expect(serialBatch.worker_prompt).not.toContain("允许写中断号或名称及挂接关系")

    const fallbackCandidates = [
      { interface_name: "备用AD采集接口", interface_kind: "other", keywords: ["模数采集"] },
      { interface_name: "维护UART接口", interface_kind: "other", keywords: ["RS485"] },
      { interface_name: "综合通信接口", interface_kind: "other", keywords: ["CANA总线"] },
      { interface_name: "遥测1553B总线", interface_kind: "other", keywords: ["MIL-STD-1553B"] },
      { interface_name: "等效国军标总线", interface_kind: "other", keywords: ["GJB 289A 与 MIL-STD-1553B 等效"] },
      { interface_name: "旧型号总线", interface_kind: "other", keywords: ["1553"] },
      { interface_name: "国军标总线", interface_kind: "other", keywords: ["GJB 289A"] },
      { interface_name: "离散量接口", interface_kind: "other", keywords: ["GPIO"] },
      { interface_name: "名称含串口但类别明确为CAN", interface_kind: "can", keywords: ["UART"] },
      { interface_name: "综合保护接口", interface_kind: "other", keywords: ["硬件狗", "喂狗"] },
    ]
    writeJson(discovery.output.hardware_interface_candidates_path, {
      model_version: 1,
      source_artifacts_path: prep.output.source_artifacts_path,
      candidates: fallbackCandidates.map((candidate, index) => ({
        candidate_id: `HI-${String(index + 1).padStart(3, "0")}`,
        ...candidate,
        source_refs: [sourceRef],
        evidence_summary: `${candidate.interface_name}存在真实交互。`,
      })),
    })
    const fallbackPrep = JSON.parse(await (filldataPhase2Workflow as any).execute({ mode: "prepare_hardware_interface_batches" }, makeCtx(dir)))
    const fallbackPrompts = await Promise.all(fallbackPrep.worker_batches.map(async (batch: any) => {
      const fetched = JSON.parse(await (filldataPhase2Workflow as any).execute({
        mode: "get_hardware_interface_worker_batch",
        hardware_interface_worker_batch_index: batch.batch_index,
      }, makeCtx(dir)))
      return fetched.worker_batch.worker_prompt
    }))
    expect(fallbackPrompts[0]).toContain("$ad-acquisition-interface-analysis")
    expect(fallbackPrompts[1]).toContain("$serial-interface-analysis")
    expect(fallbackPrompts[2]).toContain("$can-bus-interface-analysis")
    expect(fallbackPrompts[3]).toContain("$mil1553b-interface-analysis")
    expect(fallbackPrompts[4]).toContain("$mil1553b-interface-analysis")
    for (const index of [5, 6, 7]) {
      expect(fallbackPrompts[index]).toContain("不得加载 $can-bus-interface-analysis、$ad-acquisition-interface-analysis、$serial-interface-analysis、$mil1553b-interface-analysis 或 $watchdog-interface-analysis")
    }
    expect(fallbackPrompts[8]).toContain("$can-bus-interface-analysis")
    expect(fallbackPrompts[9]).toContain("$watchdog-interface-analysis")

    writeJson(discovery.output.hardware_interface_candidates_path, {
      model_version: 1,
      source_artifacts_path: prep.output.source_artifacts_path,
      candidates: [
        {
          candidate_id: "HI-001", interface_name: "FPGA接口", interface_kind: "other",
          keywords: ["A/D采集", "RS422"], source_refs: [sourceRef], evidence_summary: "候选分类存在冲突。",
        },
        {
          candidate_id: "HI-002", interface_name: "综合数据接口", interface_kind: "other",
          keywords: ["A/D采集", "RS422", "MIL-STD-1553B"], source_refs: [sourceRef], evidence_summary: "候选分类存在冲突。",
        },
      ],
    })
    const conflictPrep = JSON.parse(await (filldataPhase2Workflow as any).execute({ mode: "prepare_hardware_interface_batches" }, makeCtx(dir)))
    expect(conflictPrep.ok).toBe(true)
    expect(conflictPrep.summary.degraded_candidate_count).toBe(0)
    expect(conflictPrep.classification_repairs).toHaveLength(2)
    expect(conflictPrep.classification_repairs[0]).toMatchObject({ original_kind: "other", resolved_kind: "fpga", decision_rule: "explicit-interface-name" })
    expect(conflictPrep.classification_repairs[1]).toMatchObject({ original_kind: "other", resolved_kind: "mil1553b", decision_rule: "score-tie:mil1553b>ad>serial>can>watchdog" })
    expect(conflictPrep.warnings[0]).toMatchObject({ candidate_id: "HI-002", code: "SPECIALIZED_SKILL_TIE" })
    const repairedCandidates = readJson<any>(discovery.output.hardware_interface_candidates_path)
    expect(repairedCandidates.candidates.map((candidate: any) => candidate.interface_kind)).toEqual(["fpga", "mil1553b"])
    const classificationAudit = readJson<any>(join(dirname(discovery.output.hardware_interface_candidates_path), "hardware-interface-classification-audit.json"))
    expect(classificationAudit.repairs.at(-2)).toMatchObject({ candidate_id: "HI-001", original_kind: "other", resolved_kind: "fpga" })
    expect(classificationAudit.repairs.at(-1)).toMatchObject({ candidate_id: "HI-002", original_kind: "other", resolved_kind: "mil1553b" })
    const fpgaPrompt = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "get_hardware_interface_worker_batch", hardware_interface_worker_batch_index: 1,
    }, makeCtx(dir))).worker_batch.worker_prompt
    expect(fpgaPrompt).toContain("不得加载 $can-bus-interface-analysis、$ad-acquisition-interface-analysis、$serial-interface-analysis、$mil1553b-interface-analysis 或 $watchdog-interface-analysis")
    writeJson(discovery.output.hardware_interface_candidates_path, validCandidatesArtifact)

    for (const batch of batches.worker_batches) {
      writeJson(batch.output_path, { interface: {
        candidate_id: batch.candidate_id,
        interface_id: `IF-TEST-${batch.candidate_id.slice(3)}`,
        interface_name: batch.interface_name,
        interface_kind: batch.interface_kind,
        title: `${batch.interface_name}及相关数据流`,
        overview: `${batch.interface_name}接口说明。`,
        source_refs: [sourceRef],
        overview_tables: [],
        topics: [],
        input_flow: "",
        input_tables: [],
        output_flow: `输出流：${batch.interface_name}控制数据。`,
        output_tables: [],
      } })
    }
    const contractBatch = batches.worker_batches[0]
    const validContractRaw = readJson<any>(contractBatch.output_path)
    const missingIdRaw = JSON.parse(JSON.stringify(validContractRaw))
    delete missingIdRaw.interface.interface_id
    writeJson(contractBatch.output_path, missingIdRaw)
    const missingIdPrep = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_hardware_interface_batches",
      source_artifacts_path: prep.output.source_artifacts_path,
      hardware_interface_candidates_path: discovery.output.hardware_interface_candidates_path,
    }, makeCtx(dir)))
    expect(missingIdPrep.worker_batches.some((batch: any) => batch.candidate_id === contractBatch.candidate_id)).toBe(false)

    const topicContentRaw = JSON.parse(JSON.stringify(validContractRaw))
    topicContentRaw.interface.topics = [{
      title: "旧专题", content: "旧说明", source_refs: [sourceRef],
      input_flow: "", input_tables: [], output_flow: "", output_tables: [],
    }]
    writeJson(contractBatch.output_path, topicContentRaw)
    const topicContentPrep = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "prepare_hardware_interface_batches",
      source_artifacts_path: prep.output.source_artifacts_path,
      hardware_interface_candidates_path: discovery.output.hardware_interface_candidates_path,
    }, makeCtx(dir)))
    expect(topicContentPrep.worker_batches.some((batch: any) => batch.candidate_id === contractBatch.candidate_id)).toBe(true)
    writeJson(contractBatch.output_path, validContractRaw)

    const merged = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "merge_hardware_interface_blocks",
      source_artifacts_path: prep.output.source_artifacts_path,
      hardware_interface_candidates_path: discovery.output.hardware_interface_candidates_path,
      hardware_interface_block_raw_paths: batches.output.hardware_interface_block_raw_paths,
      hardware_interface_model_raw_path: batches.output.hardware_interface_model_raw_path,
    }, makeCtx(dir)))
    expect(merged.summary.interface_count).toBe(8)
    const finalized = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "finalize_hardware_interface",
      source_artifacts_path: prep.output.source_artifacts_path,
      hardware_interface_model_raw_path: merged.output.hardware_interface_model_raw_path,
      hardware_interface_model_path: batches.output.hardware_interface_model_path,
    }, makeCtx(dir)))
    expect(finalized.error).toBeUndefined()
    expect(finalized.ok).toBe(true)
    expect(readJson<any>(batches.output.hardware_interface_model_path).model_version).toBe(2)
    expect(readJson<any>(batches.output.hardware_interface_model_path).interfaces).toHaveLength(8)
    expect(existsSync(finalized.output.hardware_interface_report_path)).toBe(true)

    const secondBatch = batches.worker_batches[1]
    const secondRaw = readJson<any>(secondBatch.output_path)
    secondRaw.interface.interface_id = readJson<any>(batches.worker_batches[0].output_path).interface.interface_id
    writeJson(secondBatch.output_path, secondRaw)
    const duplicateIdMerged = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "merge_hardware_interface_blocks",
      source_artifacts_path: prep.output.source_artifacts_path,
      hardware_interface_candidates_path: discovery.output.hardware_interface_candidates_path,
      hardware_interface_block_raw_paths: batches.output.hardware_interface_block_raw_paths,
      hardware_interface_model_raw_path: join(dir, ".matrix", "data", "duplicate-id-model.raw.json"),
    }, makeCtx(dir)))
    expect(duplicateIdMerged.ok).toBe(true)
    secondRaw.interface.interface_id = `IF-TEST-${secondBatch.candidate_id.slice(3)}`
    writeJson(secondBatch.output_path, secondRaw)

    const firstBatch = batches.worker_batches[0]
    writeJson(firstBatch.output_path, { interface: {
      candidate_id: firstBatch.candidate_id, interface_id: "IF-TEST-001", interface_name: firstBatch.interface_name, interface_kind: firstBatch.interface_kind,
      title: `${firstBatch.interface_name}及相关数据流`, overview: "接口说明。", source_refs: [sourceRef],
      overview_tables: [{ table_id: "DUP-TABLE" }], topics: [],
      input_flow: "输入流：接口数据。", input_tables: [{ table_id: "DUP-TABLE" }], output_flow: "", output_tables: [],
    } })
    const duplicate = JSON.parse(await (filldataPhase2Workflow as any).execute({
      mode: "merge_hardware_interface_blocks",
      source_artifacts_path: prep.output.source_artifacts_path,
      hardware_interface_candidates_path: discovery.output.hardware_interface_candidates_path,
      hardware_interface_block_raw_paths: batches.output.hardware_interface_block_raw_paths,
    }, makeCtx(dir)))
    expect(duplicate.ok).toBe(true)
  })
})

test("prepare returns only paths and total warnings while refresh migrates legacy structures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prepare-compact-warnings-"))
  TEMP_DIRS.push(dir)
  const primaryPath = join(dir, "requirements.docx")
  const supportingPath = join(dir, "support.docx")
  writeDocx(primaryPath, Array.from({ length: 300 }, (_, i) => heading(1, `${i + 1} First`) + heading(1, `${i + 1} Second`)).join(""))
  writeDocx(supportingPath, [heading(1, "1 First"), heading(1, "1 Second")].join(""))
  const discover = JSON.parse(await (filldataPhase2Workflow as any).execute({ mode: "discover_documents" }, makeCtx(dir)))
  writeJson(discover.output.source_plan_path, { primary_srs_path: primaryPath, other_document_paths: [supportingPath] })
  const raw = await (filldataPhase2Workflow as any).execute({ mode: "prepare_document_artifacts" }, makeCtx(dir))
  const result = JSON.parse(raw)
  expect(result.ok).toBe(true)
  expect(Object.keys(result).sort()).toEqual(["mode", "ok", "output", "summary"])
  expect(Object.keys(result.output).sort()).toEqual(["document_quality_report_path", "source_artifacts_path"])
  const manifest = readJson<any>(result.output.source_artifacts_path)
  let count = 0
  for (const document of [manifest.primary_document, ...manifest.supporting_documents]) {
    const structure = readJson<any>(document.structure_path)
    const diagnostics = readJson<any>(document.structure_warnings_path)
    expect(structure.warnings).toBeUndefined()
    expect(diagnostics.warning_count).toBe(diagnostics.warnings.length)
    count += diagnostics.warning_count
    // Simulate old artifacts before a downstream refresh.
    writeJson(document.structure_path, { ...structure, warnings: diagnostics.warnings })
    delete document.structure_warnings_path
  }
  expect(count).toBeGreaterThan(200)
  expect(result.summary).toEqual({ structure_warning_count: count })
  expect(Buffer.byteLength(raw)).toBeLessThan(2048)
  writeJson(result.output.source_artifacts_path, manifest)
  const next = JSON.parse(await (filldataPhase2Workflow as any).execute({ mode: "discover_hardware_interface_candidates" }, makeCtx(dir)))
  expect(next.ok).toBe(true)
  const refreshed = readJson<any>(result.output.source_artifacts_path)
  for (const document of [refreshed.primary_document, ...refreshed.supporting_documents]) {
    expect(document.structure_warnings_path).toBeTruthy()
    expect(readJson<any>(document.structure_path).warnings).toBeUndefined()
    expect(readJson<any>(document.structure_warnings_path).warnings.length).toBeGreaterThan(0)
  }
})
