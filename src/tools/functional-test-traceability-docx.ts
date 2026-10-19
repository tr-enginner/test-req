import type { FunctionalTestTraceability } from "../schema/functional-test-traceability"
import { writeZip, type ZipEntry } from "./docx-zip"
import { formatTestRequirementsDocx } from "./test-requirements-docx-format"

const WIDTHS = [1800, 1300, 2700, 3520]
const HEADERS = ["文档名称", "章节号", "标题名称", "测试需求标识"]

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function runs(text: string, bold = false): string {
  return text.split(/\r?\n/).map((line, index) => {
    const br = index === 0 ? "" : "<w:r><w:br/></w:r>"
    return `${br}<w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
  }).join("")
}

function paragraph(text: string, style?: string, centered = false, firstLineIndent = false): string {
  return `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${centered ? '<w:jc w:val="center"/>' : ""}${firstLineIndent ? '<w:ind w:firstLine="480"/>' : ""}<w:spacing w:after="100"/></w:pPr>${runs(text)}</w:p>`
}

function cell(text: string, width: number, header = false): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>${runs(text, header)}</w:p></w:tc>`
}

export function compressTraceabilityRequirementIds(ids: readonly string[]): string[] {
  const result: string[] = []
  let index = 0
  while (index < ids.length) {
    const first = ids[index]
    const firstMatch = first.match(/^(.*?)(\d+)$/)
    if (!firstMatch) {
      result.push(first)
      index += 1
      continue
    }

    const prefix = firstMatch[1]
    const width = firstMatch[2].length
    let lastNumber = Number(firstMatch[2])
    let end = index
    while (end + 1 < ids.length) {
      const nextMatch = ids[end + 1].match(/^(.*?)(\d+)$/)
      if (
        !nextMatch
        || nextMatch[1] !== prefix
        || nextMatch[2].length !== width
        || Number(nextMatch[2]) !== lastNumber + 1
      ) break
      lastNumber += 1
      end += 1
    }

    result.push(end > index ? `${first}~${String(lastNumber).padStart(width, "0")}` : first)
    index = end + 1
  }
  return result
}

function table(model: FunctionalTestTraceability): string {
  const borders = '<w:tblBorders><w:top w:val="single" w:sz="12"/><w:left w:val="single" w:sz="12"/><w:bottom w:val="single" w:sz="12"/><w:right w:val="single" w:sz="12"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>'
  const blocks = [
    "<w:tbl>",
    `<w:tblPr><w:tblW w:w="9320" w:type="dxa"/><w:tblLayout w:type="fixed"/>${borders}</w:tblPr>`,
    `<w:tblGrid>${WIDTHS.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`,
    "<w:tr><w:trPr><w:tblHeader/></w:trPr>",
    ...HEADERS.map((header, index) => cell(header, WIDTHS[index], true)),
    "</w:tr>",
  ]
  for (const row of model.rows) {
    const values = [
      row.document_name,
      row.section_number,
      row.section_title,
      row.test_requirement_ids.length > 0
        ? compressTraceabilityRequirementIds(row.test_requirement_ids).join("\n")
        : "非测试需求项",
    ]
    blocks.push("<w:tr>", ...values.map((value, index) => cell(value, WIDTHS[index])), "</w:tr>")
  }
  blocks.push("</w:tbl>")
  return blocks.join("")
}

function stylesXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableTitle"><w:name w:val="Table Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style></w:styles>'
}

export function renderFunctionalTestTraceabilityDocx(model: FunctionalTestTraceability): Buffer {
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    paragraph("6  测试需求覆盖性说明", "Heading1"),
    paragraph(`经过上述的测试需求分析过程，共总结出测试点 ${model.summary.requirement_count} 项。`, undefined, false, true),
    paragraph("本测试需求总结的测试点覆盖了需求规格说明书的内容，具体的对应关系如下表。", undefined, false, true),
    paragraph("表6-1  测试需求覆盖表", "TableTitle", true),
    table(model),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr>',
    "</w:body></w:document>",
  ].join("")
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>') },
    { path: "_rels/.rels", data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { path: "word/document.xml", data: Buffer.from(documentXml, "utf-8") },
    { path: "word/styles.xml", data: Buffer.from(stylesXml(), "utf-8") },
    { path: "word/_rels/document.xml.rels", data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
  ]
  return formatTestRequirementsDocx(writeZip(entries), { addPageNumbers: false })
}
