import { describe, expect, test } from "bun:test"
import { docxTableXmlToHtml } from "../../src/tools/docx-table-html"

const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const tc = (text: string, properties = "", extra = "") =>
  `<w:tc><w:tcPr>${properties}</w:tcPr>${p(text)}${extra}</w:tc>`

describe("docxTableXmlToHtml", () => {
  test("renders horizontal and vertical merges without duplicate continuation cells", () => {
    const xml = `<w:tbl>
      <w:tr>${tc("A", '<w:vMerge w:val="restart"/>')}${tc("B &amp; C", '<w:gridSpan w:val="2"/>')}</w:tr>
      <w:tr>${tc("", "<w:vMerge/>")}${tc("D")}${tc("E")}</w:tr>
    </w:tbl>`

    const html = docxTableXmlToHtml(xml)
    expect(html).toContain('<td rowspan="2">A</td>')
    expect(html).toContain('<td colspan="2">B &amp; C</td>')
    expect(html.match(/>A<\/td>/g)).toHaveLength(1)
  })

  test("preserves paragraph breaks, escaped characters, and nested tables", () => {
    const nested = `<w:tbl><w:tr>${tc("child")}</w:tr></w:tbl>`
    const xml = `<w:tbl><w:tr><w:tc><w:tcPr/>${p("x < y")}${p("next")}${nested}</w:tc></w:tr></w:tbl>`

    const html = docxTableXmlToHtml(xml)
    expect(html).toContain("x &lt; y<br>next<br><table>")
    expect(html).toContain("<td>child</td>")
  })
})
