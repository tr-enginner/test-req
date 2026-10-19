import type { InterfaceTestContent } from "../schema/interface-test-content"
import { writeZip, type ZipEntry } from "./docx-zip"
import { formatTestRequirementsDocx } from "./test-requirements-docx-format"

const WIDTHS = [620, 3300, 1250, 1900, 1100, 1150]
const HEADERS = ["序号", "接口需求描述", "对应测试需求标识", "相关说明", "对应接口名称", "接口标识"]

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;")
}

function runs(text: string, bold = false): string {
  return text.split(/\r?\n/).map((line, index) => {
    const br = index === 0 ? "" : "<w:r><w:br/></w:r>"
    const props = bold ? "<w:rPr><w:b/></w:rPr>" : ""
    return `${br}<w:r>${props}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
  }).join("")
}

function tableRuns(text: string, bold = false): string {
  return text.split(/\r?\n/).map((line, index) => {
    const br = index === 0 ? "" : "<w:r><w:br/></w:r>"
    const boldProp = bold ? "<w:b/>" : ""
    return `${br}<w:r><w:rPr>${boldProp}<w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
  }).join("")
}

function paragraph(text: string, style?: string, centered = false, indent = false): string {
  const properties = [
    style ? `<w:pStyle w:val="${style}"/>` : "",
    centered ? '<w:jc w:val="center"/>' : "",
    indent ? '<w:ind w:firstLine="480"/>' : "",
    '<w:spacing w:after="100"/>',
  ].join("")
  return `<w:p><w:pPr>${properties}</w:pPr>${runs(text)}</w:p>`
}

function cell(text: string, width: number, header = false): string {
  return [
    "<w:tc>",
    `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>`,
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>${tableRuns(text, header)}</w:p>`,
    "</w:tc>",
  ].join("")
}

function table(model: InterfaceTestContent): string {
  const borders = '<w:tblBorders><w:top w:val="single" w:sz="12"/><w:left w:val="single" w:sz="12"/><w:bottom w:val="single" w:sz="12"/><w:right w:val="single" w:sz="12"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>'
  const blocks = [
    "<w:tbl>",
    `<w:tblPr><w:tblW w:w="9320" w:type="dxa"/><w:tblLayout w:type="fixed"/>${borders}</w:tblPr>`,
    `<w:tblGrid>${WIDTHS.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`,
    "<w:tr><w:trPr><w:tblHeader/></w:trPr>",
    ...HEADERS.map((header, index) => cell(header, WIDTHS[index], true)),
    "</w:tr>",
  ]
  for (const [index, row] of model.rows.entries()) {
    const values = [
      String(index + 1), row.interface_requirement_description, row.test_requirement_id, row.related_description,
      row.interface_name, row.interface_id,
    ]
    blocks.push("<w:tr>", ...values.map((value, index) => cell(value, WIDTHS[index])), "</w:tr>")
  }
  blocks.push("</w:tbl>")
  return blocks.join("")
}

function documentXml(model: InterfaceTestContent): string {
  const blocks = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    paragraph("4.3 接口测试", "Heading2"),
    paragraph("4.3.1 接口需求项[TR-JK]", "Heading3"),
    paragraph(`依据引用文档及上述测试需求分析，共总结如下 ${model.rows.length} 项接口需求：`, undefined, false, true),
    paragraph("表4.3-1  接口需求项总结表", "TableTitle", true),
    table(model),
    paragraph("", undefined),
    paragraph("4.3.2 测试要求", "Heading3"),
    paragraph(`测试充分性要求：${model.test_requirements.sufficiency}；`, undefined, false, true),
    paragraph(`测试终止要求：${model.test_requirements.termination}；`, undefined, false, true),
    paragraph(`优先级：所有需求项为${model.test_requirements.priority}。`, undefined, false, true),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr>',
    "</w:body></w:document>",
  ]
  return blocks.join("")
}

function stylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:sz w:val="28"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:sz w:val="26"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="TableTitle"><w:name w:val="Table Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>',
    "</w:styles>",
  ].join("")
}

export function renderInterfaceTestContentDocx(model: InterfaceTestContent): Buffer {
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>') },
    { path: "_rels/.rels", data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { path: "word/document.xml", data: Buffer.from(documentXml(model), "utf-8") },
    { path: "word/styles.xml", data: Buffer.from(stylesXml(), "utf-8") },
    { path: "word/_rels/document.xml.rels", data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
  ]
  return formatTestRequirementsDocx(writeZip(entries), { addPageNumbers: false })
}
