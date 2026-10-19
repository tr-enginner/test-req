import { describe, expect, test } from "bun:test"
import {
  hasExplicitHierarchicalHeadingLabel,
  resolveHeadings,
  shouldSuppressDocxBodyHeading,
} from "../../src/tools/docx-heading-resolver"

function numberedHeading(style: string, numId: string, ilvl: number, title: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>`
}

describe("resolveHeadings", () => {
  test("recognizes compact numbered headings and keeps ordinary body lists suppressed", () => {
    expect(hasExplicitHierarchicalHeadingLabel("1.1配置项基本信息")).toBe(true)
    expect(hasExplicitHierarchicalHeadingLabel("F.2遥测数据")).toBe(true)
    expect(shouldSuppressDocxBodyHeading("1.1配置项基本信息")).toBe(false)
    expect(shouldSuppressDocxBodyHeading("1、普通正文列表")).toBe(true)

    const heading = (title: string): string =>
      `<w:p><w:pPr><w:pStyle w:val="3"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>`
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
      heading("1.1配置项基本信息"),
      heading("1.2.编写目的"),
      heading("1.3。缩略语定义"),
      heading("F.2遥测数据"),
      heading("12指令格式定义"),
      heading("72字节上行数据块"),
    ].join("")}<w:sectPr/></w:body></w:document>`
    const stylesXml = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="3"><w:name w:val="heading 2"/></w:style></w:styles>`

    expect(resolveHeadings(documentXml, undefined, stylesXml).map(({ label, title }) => ({ label, title }))).toEqual([
      { label: "1.1", title: "配置项基本信息" },
      { label: "1.2", title: "编写目的" },
      { label: "1.3", title: "缩略语定义" },
      { label: "F.2", title: "遥测数据" },
      { label: "12", title: "指令格式定义" },
      { label: "12.1", title: "72字节上行数据块" },
    ])
  })

  test("does not let self-closing table paragraphs swallow following headings", () => {
    const table = "<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>"
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
      table,
      numberedHeading("Heading1", "42", 0, "软件详细需求"),
      table,
      numberedHeading("Heading2", "42", 1, "功能需求"),
      table,
      numberedHeading("Heading3", "42", 2, "249字节上行数据块"),
      numberedHeading("Heading3", "42", 2, "72字节上行数据块"),
    ].join("")}<w:sectPr/></w:body></w:document>`
    const numberingXml = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="7">
        <w:lvl w:ilvl="0"><w:start w:val="5"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="2"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
        <w:lvl w:ilvl="2"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2.%3"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="42"><w:abstractNumId w:val="7"/></w:num>
    </w:numbering>`
    const stylesXml = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/></w:style>
    </w:styles>`

    expect(resolveHeadings(documentXml, numberingXml, stylesXml).map(({ label, title }) => ({ label, title }))).toEqual([
      { label: "5", title: "软件详细需求" },
      { label: "5.2", title: "功能需求" },
      { label: "5.2.3", title: "249字节上行数据块" },
      { label: "5.2.4", title: "72字节上行数据块" },
    ])
  })

  test("removes only delimited explicit heading labels from titles", () => {
    const plainHeading = (title: string): string =>
      `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>`
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
      plainHeading("5.2.4.3 标题一"),
      plainHeading("5.2.4.4. 标题二"),
      plainHeading("249字节上行数据块"),
      plainHeading("72字节上行数据块"),
    ].join("")}<w:sectPr/></w:body></w:document>`
    const stylesXml = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/></w:style></w:styles>`

    expect(resolveHeadings(documentXml, undefined, stylesXml).map(({ label, title }) => ({ label, title }))).toEqual([
      { label: "5.2.4.3", title: "标题一" },
      { label: "5.2.4.4", title: "标题二" },
      { label: "5.2.5", title: "249字节上行数据块" },
      { label: "5.2.6", title: "72字节上行数据块" },
    ])
  })

  test("honors numbering starts and level overrides when reconstructing Word heading labels", () => {
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
      numberedHeading("Heading1", "42", 0, "软件详细需求"),
      numberedHeading("Heading2", "42", 1, "功能需求"),
      numberedHeading("Heading3", "42", 2, "工作模式功能"),
      numberedHeading("Heading3", "42", 2, "间接指令响应功能"),
    ].join("")}<w:sectPr/></w:body></w:document>`
    const numberingXml = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="7">
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
        <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2.%3"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="42"><w:abstractNumId w:val="7"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride><w:lvlOverride w:ilvl="1"><w:startOverride w:val="2"/></w:lvlOverride></w:num>
    </w:numbering>`
    const stylesXml = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/></w:style>
    </w:styles>`

    expect(resolveHeadings(documentXml, numberingXml, stylesXml).map((heading) => heading.label)).toEqual([
      "5",
      "5.2",
      "5.2.1",
      "5.2.2",
    ])
  })

  test("keeps WPS multilevel heading counters continuous when numId changes", () => {
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
      numberedHeading("Heading3", "42", 2, "内务指令响应功能"),
      numberedHeading("Heading3", "43", 2, "接收时间广播与内部时间维护功能"),
      numberedHeading("Heading3", "44", 2, "遥测应答功能"),
    ].join("")}<w:sectPr/></w:body></w:document>`
    const numberingXml = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="7">
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
        <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2.%3"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="42"><w:abstractNumId w:val="7"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride><w:lvlOverride w:ilvl="1"><w:startOverride w:val="2"/></w:lvlOverride><w:lvlOverride w:ilvl="2"><w:startOverride w:val="3"/></w:lvlOverride></w:num>
      <w:num w:numId="43"><w:abstractNumId w:val="7"/></w:num>
      <w:num w:numId="44"><w:abstractNumId w:val="7"/><w:lvlOverride w:ilvl="2"><w:startOverride w:val="5"/><w:lvl><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2.%3"/></w:lvl></w:lvlOverride></w:num>
    </w:numbering>`
    const stylesXml = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/></w:style></w:styles>`

    expect(resolveHeadings(documentXml, numberingXml, stylesXml).map((heading) => heading.label)).toEqual([
      "5.2.3",
      "5.2.4",
      "5.2.5",
    ])
  })

  test("keeps appendices in a letter hierarchy without advancing chapter numbering", () => {
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
      numberedHeading("Heading1", "42", 0, "Safety Requirements"),
      numberedHeading("Heading1", "42", 0, "Appendix placeholder"),
    ].join("")
      .replace("Appendix placeholder", "附录 A 数据字典")}${[
      numberedHeading("Heading1", "42", 0, "附录 B 需求跟踪矩阵"),
      numberedHeading("Heading2", "42", 1, "逆向跟踪矩阵"),
      numberedHeading("Heading2", "42", 1, "正向跟踪矩阵"),
      numberedHeading("Heading1", "42", 0, "11.附录 L 遥测数据"),
      numberedHeading("Heading2", "42", 1, "遥测帧1"),
      numberedHeading("Heading2", "42", 1, "遥测帧2"),
      numberedHeading("Heading1", "42", 0, "CAN总线数据传输格式"),
    ].join("")}<w:sectPr/></w:body></w:document>`
    const numberingXml = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="7">
        <w:lvl w:ilvl="0"><w:start w:val="8"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="42"><w:abstractNumId w:val="7"/></w:num>
    </w:numbering>`
    const stylesXml = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style>
    </w:styles>`

    expect(resolveHeadings(documentXml, numberingXml, stylesXml).map((heading) => heading.label)).toEqual([
      "8",
      "A",
      "B",
      "B.1",
      "B.2",
      "L",
      "L.1",
      "L.2",
      "9",
    ])
  })

  test("does not restart a shared sequence when top-level and child styles alternate numIds", () => {
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
      numberedHeading("Heading1", "10", 0, "范围"),
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>标识</w:t></w:r></w:p>`,
      numberedHeading("Heading1", "10", 0, "引用文档"),
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>规范性引用文件</w:t></w:r></w:p>`,
      numberedHeading("Heading1", "10", 0, "需求"),
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>软件能力需求</w:t></w:r></w:p>`,
      `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>功能需求</w:t></w:r></w:p>`,
    ].join("")}<w:sectPr/></w:body></w:document>`
    const numberingXml = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="3">
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
        <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2.%3"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="3"/></w:num>
      <w:num w:numId="10"><w:abstractNumId w:val="3"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
    </w:numbering>`
    const stylesXml = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    </w:styles>`

    expect(resolveHeadings(documentXml, numberingXml, stylesXml).map((heading) => heading.label)).toEqual([
      "1", "1.1", "2", "2.1", "3", "3.1", "3.1.1",
    ])
  })

  test("extracts only visible heading text around tabs bookmarks breaks and proofing markers", () => {
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="42"/></w:numPr></w:pPr>
        <w:r><w:tab/></w:r><w:bookmarkStart w:id="1" w:name="_Toc1"/><w:proofErr w:type="spellStart"/>
        <w:r><w:t>需求 &amp; 范围</w:t></w:r><w:r><w:br/><w:t>说明</w:t></w:r><w:bookmarkEnd w:id="1"/>
      </w:p><w:sectPr/></w:body></w:document>`
    const numberingXml = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl></w:abstractNum><w:num w:numId="42"><w:abstractNumId w:val="7"/></w:num></w:numbering>`
    const stylesXml = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>`

    const [heading] = resolveHeadings(documentXml, numberingXml, stylesXml)
    expect(heading.title).toBe("需求 & 范围\n说明")
    expect(heading.title).not.toContain("<w:")
  })

  test("keeps inferred headings aligned after authoritative Word numbering", () => {
    const plainHeading = (style: string, title: string): string =>
      `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>`
    const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
      numberedHeading("Heading1", "42", 0, "范围"),
      numberedHeading("Heading2", "42", 1, "标识"),
      plainHeading("Heading1", "引用文档"),
      plainHeading("Heading2", "规范性引用文件"),
      plainHeading("Heading2", "研制依据引用文件"),
      plainHeading("Heading1", "需求"),
      plainHeading("Heading2", "要求的状态和方式"),
      plainHeading("Heading2", "软件能力需求"),
      plainHeading("Heading3", "功能需求"),
    ].join("")}<w:sectPr/></w:body></w:document>`
    const numberingXml = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="7">
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="42"><w:abstractNumId w:val="7"/></w:num>
    </w:numbering>`
    const stylesXml = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/></w:style>
    </w:styles>`

    const headings = resolveHeadings(documentXml, numberingXml, stylesXml)
    expect(headings.map((heading) => heading.label)).toEqual([
      "1",
      "1.1",
      "2",
      "2.1",
      "2.2",
      "3",
      "3.1",
      "3.2",
      "3.2.1",
    ])
    expect(headings.at(-1)?.label_source).toBe("inferred")
  })
})
