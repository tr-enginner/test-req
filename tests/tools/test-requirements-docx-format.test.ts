import { describe, expect, test } from "bun:test"
import { readZip, writeZip } from "../../src/tools/docx-zip"
import { formatTestRequirementsDocx } from "../../src/tools/test-requirements-docx-format"

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="SimHei"/><w:sz w:val="28"/></w:rPr><w:t>4.2 性能测试</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="MatrixHeading3"/><w:ind w:left="720"/></w:pPr><w:r><w:t>3.1.1 CAN总线接口</w:t></w:r></w:p>
<w:p><w:r><w:t>正文内容</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="TableTitle"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>表4.2-1  性能需求</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/><w:shd w:fill="D9EAF7"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>表头</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>合并分组标题</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>数据</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr></w:body></w:document>`

function fixture(): Buffer {
  return writeZip([
    { path: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { path: "_rels/.rels", data: Buffer.from("<Relationships/>") },
    { path: "word/document.xml", data: Buffer.from(documentXml) },
    { path: "word/_rels/document.xml.rels", data: Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>') },
  ])
}

describe("test requirements DOCX formatting", () => {
  test("normalizes headings, body, captions, tables, borders, and pagination", () => {
    const entries = readZip(formatTestRequirementsDocx(fixture()))
    const xml = entries.get("word/document.xml")!.toString("utf-8")
    const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)!
    const heading = paragraphs.find((paragraph) => paragraph.includes("4.2 性能测试"))!
    expect(heading).toContain('<w:jc w:val="left"/>')
    expect(heading).toContain('<w:keepNext/>')
    expect(heading).toContain('<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun" w:cs="Times New Roman"/>')
    expect(heading).toContain('<w:sz w:val="24"/>')
    expect(heading).toContain('<w:spacing w:before="0" w:after="0" w:line="720" w:lineRule="auto"/>')
    expect(heading).toContain('<w:snapToGrid/>')
    expect(heading).toContain("<w:b/>")
    const normalizedCustomHeading = paragraphs.find((paragraph) => paragraph.includes("3.1.1 CAN总线接口"))!
    expect(normalizedCustomHeading).toContain('<w:pStyle w:val="Heading3"/>')
    expect(normalizedCustomHeading).toContain('<w:ind w:left="0" w:right="0" w:firstLine="0"/>')
    expect(normalizedCustomHeading).not.toContain("MatrixHeading")

    const body = paragraphs.find((paragraph) => paragraph.includes("正文内容"))!
    expect(body).toContain('<w:jc w:val="both"/>')
    expect(body).toContain('<w:ind w:firstLineChars="200"/>')
    expect(body).toContain('<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/>')
    expect(body).toContain('<w:snapToGrid/>')

    const caption = paragraphs.find((paragraph) => paragraph.includes("表4.2-1"))!
    expect(caption).toContain('<w:jc w:val="center"/>')
    expect(caption).toContain('<w:keepNext/>')
    expect(caption).toContain('<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/>')
    expect(caption).toContain('<w:snapToGrid/>')
    expect(caption).not.toContain("<w:b/>")

    expect(xml).not.toContain("<w:shd")
    expect(xml).not.toContain("<w:tblHeader")
    expect(xml).not.toContain("<w:cantSplit")
    expect(xml).toContain('<w:top w:val="single" w:sz="12" w:color="000000"/>')
    expect(xml).toContain('<w:insideH w:val="single" w:sz="4" w:color="000000"/>')
    expect(xml).toContain('<w:vAlign w:val="center"/>')
    expect(xml).toContain('<w:sz w:val="21"/>')
    const table = xml.match(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/)![0]
    expect(table).toContain('<w:tblW w:w="5000" w:type="pct"/>')
    expect(table).toContain('<w:tblInd w:w="0" w:type="dxa"/>')
    expect(table.match(/<w:gridCol\b[^>]*w:w="4873"/g)?.length).toBe(2)
    const tableParagraphs = table.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []
    expect(tableParagraphs.length).toBeGreaterThan(0)
    for (const paragraph of tableParagraphs) {
      expect(paragraph).toContain('<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>')
      expect(paragraph).toContain('<w:jc w:val="center"/>')
      expect(paragraph).toContain('<w:snapToGrid/>')
    }
    expect(table).not.toContain("<w:b/>")
    expect(table).not.toContain("<w:bCs/>")
    expect(xml).toContain('<w:docGrid w:type="lines" w:linePitch="360"/>')
  })

  test("adds a centered mixed-font small-five continuous page-number footer", () => {
    const entries = readZip(formatTestRequirementsDocx(fixture()))
    const xml = entries.get("word/document.xml")!.toString("utf-8")
    const footer = entries.get("word/footer1.xml")!.toString("utf-8")
    expect(xml).toContain("xmlns:r=")
    expect(xml).toContain('<w:footerReference w:type="default" r:id="rId1"/>')
    expect(footer).toContain('<w:jc w:val="center"/>')
    expect(footer).toContain('<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun" w:cs="Times New Roman"/>')
    expect(footer).toContain('<w:sz w:val="18"/>')
    expect(footer).toContain(" PAGE ")
    expect(footer).not.toContain("snapToGrid")
  })

  test("can format a chapter without adding a footer relationship", () => {
    const entries = readZip(formatTestRequirementsDocx(fixture(), { addPageNumbers: false }))
    expect(entries.has("word/footer1.xml")).toBe(false)
    expect(entries.get("word/document.xml")!.toString("utf-8")).not.toContain("<w:footerReference")
    expect(entries.get("word/_rels/document.xml.rels")!.toString("utf-8")).not.toContain("/footer")
  })

  test("preserves source table formatting marked by the hardware interface renderer", () => {
    const sourceTable = '<w:tbl><w:tblPr><w:tblDescription w:val="matrix:preserve-source-formatting"/><w:tblW w:w="4321" w:type="dxa"/><w:tblBorders><w:top w:val="double" w:sz="8"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:fill="D9EAF7"/></w:tcPr><w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="FangSong"/></w:rPr><w:t>Source A1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    const buffer = writeZip([
      { path: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>') },
      { path: "word/document.xml", data: Buffer.from(documentXml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/, sourceTable)) },
      { path: "word/_rels/document.xml.rels", data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>') },
    ])
    const xml = readZip(formatTestRequirementsDocx(buffer, { addPageNumbers: false })).get("word/document.xml")!.toString("utf-8")
    expect(xml).toContain(sourceTable)
    expect(xml).toContain('<w:rFonts w:ascii="Arial" w:eastAsia="FangSong"/>')
    expect(xml).not.toContain('<w:tblW w:w="5000" w:type="pct"/>')
  })

  test("formats first-page cover paragraphs as centered regular small-four text", () => {
    const withBreak = documentXml.replace("<w:body>", '<w:body><w:p><w:r><w:t>第三方测试需求</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    const buffer = writeZip([
      { path: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>') },
      { path: "word/document.xml", data: Buffer.from(withBreak) },
      { path: "word/_rels/document.xml.rels", data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>') },
    ])
    const xml = readZip(formatTestRequirementsDocx(buffer, { cover: true })).get("word/document.xml")!.toString("utf-8")
    const cover = xml.match(/<w:p>[^]*?第三方测试需求[^]*?<\/w:p>/)![0]
    expect(cover).toContain('<w:jc w:val="center"/>')
    expect(cover).toContain('<w:sz w:val="24"/>')
    expect(cover).toContain('<w:snapToGrid w:val="0"/>')
    expect(cover).not.toContain("<w:b/>")
  })

  test("keeps content after a nested table outside the outer table", () => {
    const nestedTable = [
      '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr>',
      '<w:tr><w:tc><w:p><w:r><w:t>外层单元格</w:t></w:r></w:p>',
      '<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr>',
      '<w:tr><w:tc><w:p><w:r><w:t>内层表格</w:t></w:r></w:p></w:tc></w:tr>',
      '</w:tbl>',
      '<w:p><w:r><w:t>外层表格尾部</w:t></w:r></w:p></w:tc></w:tr>',
      '</w:tbl>',
      '<w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>3.1.4.2 后续接口章节</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>后续正文</w:t></w:r></w:p>',
    ].join("")
    const nestedDocument = documentXml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/, nestedTable)
    const buffer = writeZip([
      { path: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>') },
      { path: "word/document.xml", data: Buffer.from(nestedDocument) },
      { path: "word/_rels/document.xml.rels", data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>') },
    ])

    const xml = readZip(formatTestRequirementsDocx(buffer, { addPageNumbers: false })).get("word/document.xml")!.toString("utf-8")
    const headingPosition = xml.indexOf("3.1.4.2 后续接口章节")
    const prefix = xml.slice(0, headingPosition)
    expect(headingPosition).toBeGreaterThan(0)
    expect((xml.match(/<w:tbl\b/g) ?? []).length).toBe(2)
    expect((xml.match(/<\/w:tbl>/g) ?? []).length).toBe(2)
    expect((prefix.match(/<w:tbl\b/g) ?? []).length).toBe((prefix.match(/<\/w:tbl>/g) ?? []).length)
    expect(xml).toContain("外层表格尾部")
    expect(xml).toContain("后续正文")
    expect(xml.slice(headingPosition - 500, headingPosition)).toContain("</w:tbl>")
  })
})
