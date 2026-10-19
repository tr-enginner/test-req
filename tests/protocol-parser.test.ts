import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import {
  buildProtocolSummaryFromText,
  findProtocolForInputFlow,
  resolveProtocolSearchDirs,
} from "../src/shared/protocol-parser"
import { writeZip } from "../src/tools/docx-zip"

function writeTextDocx(path: string, paragraphs: string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const paragraphXml = paragraphs
    .map((paragraph) => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`)
    .join("")
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
          "</Types>",
        ].join(""),
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
      ),
    },
    {
      path: "word/document.xml",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
          "<w:body>",
          paragraphXml,
          "<w:sectPr/>",
          "</w:body>",
          "</w:document>",
        ].join(""),
      ),
    },
  ])
  writeFileSync(path, zipBuffer)
}

describe("protocol parser", () => {
  test("uses workdir .matrix/reports as Phase 6 protocol search directory", () => {
    const dirs = resolveProtocolSearchDirs("/tmp/matrix-project")
    expect(dirs).toEqual(["/tmp/matrix-project/.matrix/reports"])
  })

  test("builds structured protocol fields from plain text", () => {
    const summary = buildProtocolSummaryFromText(
      "/tmp/间接指令.docx",
      [
        "字段A：默认值为0x01，取值范围：0x01-0x05",
        "执行时间：执行时间，范围：1-10秒",
        "总线通道：参数3：循环时间，单位为秒，默认值0",
      ].join("\n"),
    )

    expect(summary.protocol_name).toBe("间接指令")
    expect(summary.items).toHaveLength(3)
    expect(summary.items[0]?.default_value).toBe("0x01")
    expect(summary.items[0]?.enum_values).toContain("0x01")
    expect(summary.items[1]?.range).toContain("1-10秒")
  })

  test("only uses DOCX files whose names contain 第三方测试需求 under .matrix/reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "protocol-third-party-only-"))
    writeTextDocx(join(dir, ".matrix", "reports", "普通协议.docx"), [
      "输入流：间接指令。",
      "字段A：默认值为0x01",
    ])

    const result = await findProtocolForInputFlow("间接指令。", dir)
    expect(result.summary).toBeUndefined()
    expect(result.summary_file).toBeUndefined()
    expect(result.warnings.join("\n")).toContain("第三方测试需求")
  })

  test("does not fall back to configured protocol_search_dirs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "protocol-no-config-fallback-"))
    writeTextDocx(join(dir, "legacy-protocols", "间接指令.docx"), [
      "输入流：间接指令。",
      "字段A：默认值为0x01",
    ])

    const result = await findProtocolForInputFlow("间接指令。", dir, ["legacy-protocols"])
    expect(result.summary).toBeUndefined()
    expect(result.warnings.join("\n")).toContain(".matrix/reports")
  })

  test("uses the only third-party requirement DOCX even when inputFlow does not match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "protocol-single-third-party-"))
    const docxFile = join(dir, ".matrix", "reports", "CNAS第三方测试需求.docx")
    writeTextDocx(docxFile, [
      "字段A：默认值为0x01，取值范围：0x01-0x05",
    ])

    const result = await findProtocolForInputFlow("不存在的输入流", dir)
    expect(result.summary?.source_file).toBe(docxFile)
    expect(result.summary?.items[0]?.default_value).toBe("0x01")
    expect(result.summary_file).toContain(join(".matrix", "data", "protocols"))
    expect(result.warnings.join("\n")).toContain("未匹配到输入流")
  })

  test("selects the best third-party requirement DOCX by inputFlow content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "protocol-best-third-party-"))
    const first = join(dir, ".matrix", "reports", "A第三方测试需求.docx")
    const second = join(dir, ".matrix", "reports", "B第三方测试需求.docx")
    writeTextDocx(first, [
      "字段A：默认值为0x01",
    ])
    writeTextDocx(second, [
      "输入流：间接指令。",
      "字段B：默认值为0x02",
    ])

    const result = await findProtocolForInputFlow("间接指令。", dir)
    expect(result.summary?.source_file).toBe(second)
    expect(result.summary?.items.some((item) => item.default_value === "0x02")).toBe(true)
  })
})
