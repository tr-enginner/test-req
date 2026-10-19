import { describe, expect, test } from "bun:test"
import { buildProtocolSemanticDocumentFromXml } from "../src/shared/protocol-semantics"

describe("protocol semantics", () => {
  test("extracts table titles, headers and rows from document xml", () => {
    const xml = [
      "<w:document>",
      "<w:body>",
      "<w:p><w:r><w:t>3.1.1.7 间接指令</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>输入流：间接指令，格式及内容如下表所示。</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>表3.1.1.7-2 间接数据指令说明</w:t></w:r></w:p>",
      "<w:tbl>",
      "<w:tr>",
      "<w:tc><w:p><w:r><w:t>序号</w:t></w:r></w:p></w:tc>",
      "<w:tc><w:p><w:r><w:t>指令名称</w:t></w:r></w:p></w:tc>",
      "<w:tc><w:p><w:r><w:t>指令码</w:t></w:r></w:p></w:tc>",
      "<w:tc><w:p><w:r><w:t>指令说明</w:t></w:r></w:p></w:tc>",
      "</w:tr>",
      "<w:tr>",
      "<w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc>",
      "<w:tc><w:p><w:r><w:t>中继测控子系统与中继星1通信</w:t></w:r></w:p></w:tc>",
      "<w:tc><w:p><w:r><w:t>1501AAAA</w:t></w:r></w:p></w:tc>",
      "<w:tc><w:p><w:r><w:t>缓变遥测为1</w:t></w:r></w:p></w:tc>",
      "</w:tr>",
      "</w:tbl>",
      "</w:body>",
      "</w:document>",
    ].join("")

    const document = buildProtocolSemanticDocumentFromXml("/tmp/间接指令.docx", xml)

    expect(document.protocol_name).toBe("间接指令")
    expect(document.tables).toHaveLength(1)
    expect(document.tables[0]?.title).toContain("表3.1.1.7-2")
    expect(document.tables[0]?.section_title).toContain("输入流")
    expect(document.tables[0]?.headers).toEqual(["序号", "指令名称", "指令码", "指令说明"])
    expect(document.tables[0]?.rows[0]?.["指令名称"]).toBe("中继测控子系统与中继星1通信")
  })

  test("sanitizes encoded xml fragments from extracted headers and rows", () => {
    const xml = [
      "<w:document>",
      "<w:body>",
      "<w:p><w:r><w:t>表3.1.1.7-2 间接数据指令说明</w:t></w:r></w:p>",
      "<w:tbl>",
      "<w:tr>",
      "<w:tc><w:p><w:r><w:t>&lt;w:tcW w:w=&quot;123&quot;/&gt;指令名称</w:t></w:r></w:p></w:tc>",
      "<w:tc><w:p><w:r><w:t>指令说明</w:t></w:r></w:p></w:tc>",
      "</w:tr>",
      "<w:tr>",
      "<w:tc><w:p><w:r><w:t>&lt;w:rPr/&gt;中继测控子系统与中继星1通信</w:t></w:r></w:p></w:tc>",
      "<w:tc><w:p><w:r><w:t>缓变遥测为1</w:t></w:r></w:p></w:tc>",
      "</w:tr>",
      "</w:tbl>",
      "</w:body>",
      "</w:document>",
    ].join("")

    const document = buildProtocolSemanticDocumentFromXml("/tmp/间接指令.docx", xml)

    expect(document.tables[0]?.headers[0]).toBe("指令名称")
    expect(document.tables[0]?.rows[0]?.["指令名称"]).toBe("中继测控子系统与中继星1通信")
  })
})
