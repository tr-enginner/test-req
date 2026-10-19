import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { coverInfoExtractor } from "../../src/tools/cover-info-extractor"
import { writeZip } from "../../src/tools/docx-zip"

const originalCwd = process.cwd()
let directory: string | undefined

afterEach(() => {
  process.chdir(originalCwd)
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

describe("cover name extraction", () => {
  const cases: [string, string[], string | null][] = [
    ["ordinary title", ["XHDZ123软件鉴定测评大纲"], "XHDZ123"],
    ["FPGA title", ["XHDZ123FPGA软件鉴定测评大纲"], "XHDZ123"],
    ["Chinese name", ["XHDZ-123控制器软件鉴定测评大纲"], "XHDZ-123控制器"],
    ["internal spaces", ["XHDZ 123_ A FPGA 软件"], "XHDZ123_A"],
    ["adjacent title", ["XHDZ-123控制器", "软件鉴定测评大纲"], "XHDZ-123控制器"],
    ["adjacent FPGA title", ["XHDZ123", "FPGA 软件鉴定测评大纲"], "XHDZ123"],
    ["unrelated fields", ["文档编号：DOC-001", "发布状态：草稿", "XHDZ123 FPGA软件"], "XHDZ123"],
    ["intervening field", ["XHDZ123", "发布状态：草稿", "FPGA软件"], null],
    ["invalid then valid", ["XHDZ123/非法软件", "XHDZ456软件"], "XHDZ456"],
    ["invalid then valid in one paragraph", ["XHDZ123/非法软件 XHDZ456软件"], "XHDZ456"],
    ["invalid character", ["XHDZ123/非法FPGA软件"], null],
    ["prefix only", ["XHDZ软件鉴定测评大纲"], null],
    ["adjacent prefix only", ["XHDZ", "软件"], null],
    ["missing title", ["XHDZ123", "普通说明"], null],
    ["loose FPGA text", ["XHDZ123 FPGA工具"], null],
    ["no name", ["软件鉴定测评大纲"], null],
  ]

  for (const [label, paragraphs, expected] of cases) {
    test(label, async () => {
      directory = mkdtempSync(join(tmpdir(), "cover-info-"))
      process.chdir(directory)
      const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
        ...paragraphs,
        "ABC.JDDG1",
        "2026年10月",
      ].map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`
      const docxPath = join(directory, "cover.docx")
      writeFileSync(docxPath, writeZip([{ path: "word/document.xml", data: Buffer.from(xml) }]))
      const result = JSON.parse(await coverInfoExtractor.execute({ docx_path: docxPath }, {} as any))
      expect(result.status).toBe("success")
      expect(result.cover_info.file_name).toBe(expected)
      expect(result.cover_info.config_id).toBe("ABC")
      expect(result.cover_info.cover_date).toBe("2026年10月")
      const persisted = JSON.parse(readFileSync(result.output_file, "utf-8"))
      expect(persisted.file_name).toBe(expected)
    })
  }
})
