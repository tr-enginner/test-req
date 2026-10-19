import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { readZip } from "../../src/tools/docx-zip"
import { renderHardwareInterfaceDocx } from "../../src/tools/hardware-interface-docx"

const TEMP_DIRS: string[] = []

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tableXml(cells: string[]) {
  return [
    "<w:tbl><w:tblPr><w:tblW w:w=\"7200\" w:type=\"dxa\"/></w:tblPr><w:tblGrid>",
    ...cells.map(() => "<w:gridCol w:w=\"2400\"/>"),
    "</w:tblGrid><w:tr>",
    ...cells.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`),
    "</w:tr></w:tbl>",
  ].join("")
}

function tableRef(dir: string, tableId: string, title: string) {
  const path = join(dir, `${tableId}.xml`)
  writeFileSync(path, tableXml(["名称", "地址", "说明"]), "utf-8")
  return { table_id: tableId, title, table_asset: { kind: "docx_table_xml", path, source_path: join(dir, "srs.docx"), section_id: "S1", section_title: "硬件接口" } }
}

function genericModel(interfaceKind = "other") {
  return {
    model_version: 2,
    chapter_title: "数据及接口需求",
    section_title: "硬件接口",
    interfaces: [{
      candidate_id: "HI-001",
      interface_id: "IF-TEST-001",
      interface_name: "测试接口",
      interface_kind: interfaceKind,
      title: "测试接口及相关数据流",
      overview: "软件通过测试接口与外部设备交互。",
      source_refs: ["primary::S1"],
      overview_tables: [] as any[],
      topics: [] as any[],
      input_flow: "",
      input_tables: [] as any[],
      output_flow: "",
      output_tables: [] as any[],
    }],
  }
}

function documentXml(model: any) {
  return readZip(Buffer.from(renderHardwareInterfaceDocx(model))).get("word/document.xml")?.toString("utf-8") || ""
}

function renderedParts(model: any) {
  const zip = readZip(Buffer.from(renderHardwareInterfaceDocx(model)))
  return {
    document: zip.get("word/document.xml")?.toString("utf-8") || "",
    styles: zip.get("word/styles.xml")?.toString("utf-8") || "",
  }
}

describe("renderHardwareInterfaceDocx", () => {
  test.each(["can", "fpga", "ad", "serial", "spacewire", "other"])("renders %s through the same generic path", (kind) => {
    const xml = documentXml(genericModel(kind))
    expect(xml).toContain("3.1.1 测试接口及相关数据流")
    expect(xml).toContain("IF-TEST-001: 软件通过测试接口与外部设备交互。")
    expect(xml).not.toContain("HI-001")
    expect(xml).not.toContain("数据采集过程")
    expect(xml).not.toContain("串口接收和发送时序说明")
  })

  test.each([
    ["一级CAN接口", "IF-CAN0-001"],
    ["二级CAN接口", "IF-CAN1-001"],
    ["SpaceWire接口", "IF-SPACEWIRE-001"],
    ["维护串口", "IF-UART-001"],
  ])("renders the display identifier for %s", (interfaceName, interfaceId) => {
    const model = genericModel()
    model.interfaces[0].interface_name = interfaceName
    model.interfaces[0].interface_id = interfaceId
    const xml = documentXml(model)
    expect(xml).toContain(`${interfaceId}:`)
    expect(xml).not.toContain("HI-001")
  })

  test("renders root flows directly under the level-three interface without inventing a level-four topic", () => {
    const model = genericModel("gpio")
    model.interfaces[0].input_flow = "输入流：离散量状态。CPU软件通过GPIO接口接收外部状态。"
    model.interfaces[0].output_flow = "输出流：控制信号。CPU软件通过GPIO接口发送控制信号。"
    const xml = documentXml(model)
    expect(xml).toContain("输入流：离散量状态")
    expect(xml).toContain("输出流：控制信号")
    expect(xml).not.toContain("测试接口数据流")
    expect(xml).not.toContain("3.1.1.1")
  })

  test("uses first-line indentation for overview and flow paragraphs", () => {
    const model = genericModel("gpio")
    model.interfaces[0].overview = "第一行概述。\n后续概述行不缩进。"
    model.interfaces[0].input_flow = "输入流第一行。\n输入流后续行。"
    model.interfaces[0].output_flow = "输出流第一行。\n输出流后续行。"
    const { document, styles } = renderedParts(model)

    expect(styles).toContain('<w:style w:type="paragraph" w:styleId="InterfaceId">')
    expect(styles).toContain('<w:style w:type="paragraph" w:styleId="FlowText">')
    expect(styles.match(/<w:ind w:firstLine="360"\/>/g)).toHaveLength(2)
    expect(styles).not.toContain('<w:ind w:left="360"/>')
    expect(document).toContain('w:pStyle w:val="InterfaceId"')
    expect(document.match(/w:pStyle w:val="FlowText"/g)).toHaveLength(2)
    expect(document.match(/<w:br\/>/g)).toHaveLength(3)
  })

  test("centers table titles and every paragraph in referenced tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "hardware-interface-centered-table-"))
    TEMP_DIRS.push(dir)
    const model = genericModel()
    model.interfaces[0].overview_tables = [tableRef(dir, "centered", "表4.41 一级CAN总线接口")]
    const { document, styles } = renderedParts(model)

    expect(styles).toContain('<w:style w:type="paragraph" w:styleId="TableTitle">')
    expect(styles).toContain('<w:jc w:val="center"/>')
    const tableXmlMatch = document.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)?.[0] || ""
    expect(tableXmlMatch).toContain('<w:tblDescription w:val="matrix:preserve-source-formatting"/>')
    expect(tableXmlMatch.match(/<w:tc>/g)).toHaveLength(3)
    expect(tableXmlMatch.match(/<w:jc w:val="center"\/>/g)).toHaveLength(3)
    expect(tableXmlMatch.match(/<w:vAlign w:val="center"\/>/g)).toHaveLength(3)
    expect(tableXmlMatch.match(/<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"\/>/g)).toHaveLength(3)
    expect(tableXmlMatch).toContain("名称")
    expect(tableXmlMatch).toContain("地址")
    expect(tableXmlMatch).toContain("说明")
  })

  test("numbers table captions per level-three heading and replaces generic source titles with contextual descriptions", () => {
    const dir = mkdtempSync(join(tmpdir(), "hardware-interface-global-table-captions-"))
    TEMP_DIRS.push(dir)
    const model = genericModel()
    model.interfaces[0].overview_tables = [
      tableRef(dir, "overview", "表 5.2- 9 缓变遥测轮询控制序列传输格式"),
      tableRef(dir, "uplink", "表 5.2- 17 上注重构数据包传输格式"),
    ]
    model.interfaces[0].input_tables = [tableRef(dir, "root-input", "表 A.1-1 发向W处理器的间接开关指令格式")]
    model.interfaces[0].output_tables = [tableRef(dir, "root-output", "")]
    model.interfaces[0].topics = [{
      title: "遥测数据流",
      source_refs: ["primary::S1.1"],
      input_flow: "输入流：遥测数据。",
      input_tables: [tableRef(dir, "topic-input", "表格2")],
      output_flow: "输出流：状态数据。",
      output_tables: [tableRef(dir, "topic-output", '表 A.1- 3</w:t></w:r><w:r w:rsidR="00A005FA"><w:t>GNSS 定位广播数据传送格式')],
    }]

    const secondInterface = JSON.parse(JSON.stringify(genericModel().interfaces[0]))
    secondInterface.interface_id = "IF-TEST-002"
    secondInterface.interface_name = "备用接口"
    secondInterface.title = "备用接口及相关数据流"
    secondInterface.overview_tables = [tableRef(dir, "second-overview", "表格1")]
    model.interfaces.push(secondInterface)

    const xml = documentXml(model)
    const expectedCaptions = [
      "表3.1.1-1  缓变遥测轮询控制序列传输格式",
      "表3.1.1-2  上注重构数据包传输格式",
      "表3.1.1-3  发向W处理器的间接开关指令格式",
      "表3.1.1-4  测试接口输出数据表",
      "表3.1.1-5  遥测数据流输入数据表",
      "表3.1.1-6  GNSS 定位广播数据传送格式",
      "表3.1.2-1  备用接口概述数据表",
    ]

    for (const caption of expectedCaptions) expect(xml).toContain(caption)
    for (let index = 1; index < expectedCaptions.length; index += 1) {
      expect(xml.indexOf(expectedCaptions[index - 1])).toBeLessThan(xml.indexOf(expectedCaptions[index]))
    }
    expect(xml).not.toContain("表 5.2- 9")
    expect(xml).not.toContain("表 5.2- 17")
    expect(xml).not.toContain("表 A.1-1")
    expect(xml).not.toContain("表 A.1- 3")
    expect(xml).not.toContain("00A005FA")
    expect(xml).not.toContain("&lt;/w:t&gt;")
    expect(xml).not.toContain(">表格1<")
    expect(xml).not.toContain(">表格2<")
    expect(new Set(expectedCaptions).size).toBe(expectedCaptions.length)
  })

  test("renders overview tables before topics and keeps explanatory text in overview", () => {
    const dir = mkdtempSync(join(tmpdir(), "hardware-interface-generic-"))
    TEMP_DIRS.push(dir)
    const model = genericModel("spacewire")
    model.interfaces[0].interface_id = "IF-Spacewire-001"
    model.interfaces[0].overview = "软件通过测试接口接收上注数据。上注事务按来源约定执行。"
    model.interfaces[0].overview_tables = [tableRef(dir, "address", "SpaceWire总线地址表Ⅱ")]
    model.interfaces[0].topics = [{
      title: "管控程序上注数据块及相关数据流",
      source_refs: ["primary::S1.1"],
      input_flow: "输入流：上注数据块。外部设备通过SpaceWire接口向CPU软件发送数据，格式如下表所示。",
      input_tables: [tableRef(dir, "frame", "上注数据块格式表")],
      output_flow: "",
      output_tables: [],
    }]
    const xml = documentXml(model)
    expect(xml.indexOf("软件通过测试接口")).toBeLessThan(xml.indexOf("SpaceWire总线地址表Ⅱ"))
    expect(xml.indexOf("SpaceWire总线地址表Ⅱ")).toBeLessThan(xml.indexOf("3.1.1.1 管控程序上注数据块及相关数据流"))
    expect(xml).toContain("上注事务按来源约定执行")
    expect(xml.indexOf("输入流：上注数据块")).toBeLessThan(xml.indexOf("上注数据块格式表"))
  })

  test("supports tableless one-way topics", () => {
    const model = genericModel("watchdog")
    model.interfaces[0].topics = [{ title: "硬件狗喂狗及相关数据流", source_refs: ["primary::S1"], input_flow: "", input_tables: [], output_flow: "输出流：喂狗信号。CPU软件通过硬件狗接口发送喂狗信号。", output_tables: [] }]
    const xml = documentXml(model)
    expect(xml).toContain("硬件狗喂狗及相关数据流")
    expect(xml).toContain("输出流：喂狗信号")
    expect(xml).not.toContain("输入流：")
  })

  test("skips missing table assets", () => {
    const model = genericModel()
    model.interfaces[0].overview_tables = [{ table_id: "T1", title: "地址表" }]
    expect(() => renderHardwareInterfaceDocx(model)).not.toThrow()
  })

  test("rejects legacy, missing-interface, and non-version-two models", () => {
    expect(() => renderHardwareInterfaceDocx({ blocks: [] } as any)).toThrow("model_version 2")
    expect(() => renderHardwareInterfaceDocx({ model_version: 2 } as any)).toThrow("interfaces array")
    expect(() => renderHardwareInterfaceDocx({ model_version: 2, interfaces: [], blocks: [] } as any)).toThrow("legacy hardware interface blocks")
  })

  test("normalizes an invalid display identifier without changing the input", () => {
    const model = genericModel()
    delete (model.interfaces[0] as any).interface_id
    expect(() => renderHardwareInterfaceDocx(model)).not.toThrow()
    expect(model.interfaces[0].interface_id).toBeUndefined()
  })
})
