import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { docGenerator } from "../../src/tools/doc-generator"

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

describe("doc_generator", () => {
  test("renders test-cases markdown from source-confirmation-tests metadata without reading sibling software-analysis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-generator-test-cases-"))
    const dataFile = join(dir, ".matrix", "data", "source-confirmation-tests.json")
    const outputFile = join(dir, ".matrix", "reports", "test-cases.md")

    writeJson(dataFile, {
      project_name: "确认测试项目",
      version: "V2.3",
      created_date: "2026-04-15",
      summary: { total_cases: 1, by_type: { "功能测试": 1 } },
      test_cases: [
        {
          case_id: "TC-GN-JJZL-001",
          case_name: "双总线发送",
          correspond_fun_id: "TR-GN-JJZL-001",
          test_type: "功能测试",
          test_purpose: "验证双总线发送。",
          test_step: [
            { "步骤描述": "第10.8秒,通过CANA总线发送中继测控子系统与中继星1通信。", "预期结果": "软件正确处理。"},
          ],
        },
      ],
    })

    writeJson(join(dir, ".matrix", "data", "software-analysis.json"), {
      project_name: "不应被使用的软件分析项目名",
      version: "BAD-VERSION",
      summary: { total_functions: 999, total_loc: 123456 },
    })

    await (docGenerator as any).execute({
      data_file: dataFile,
      output_file: outputFile,
      doc_type: "test-cases",
    })

    const markdown = readFileSync(outputFile, "utf-8")
    expect(markdown).toContain("确认测试项目 确认测试说明")
    expect(markdown).toContain("**版本**: V2.3")
    expect(markdown).not.toContain("不应被使用的软件分析项目名")
    expect(markdown).not.toContain("BAD-VERSION")
  })
})

describe("doc_generator 覆盖测试需求项来源", () => {
  test("覆盖测试需求项取 related_software_req_ids 子集而非 correspond_fun_id 整组", async () => {
    // 2026-08-20 用户报告:DOCX/Markdown 的覆盖列显示 TR-JK-001~008(整组 funId),
    // 实际本用例只覆盖 TR-JK-001~003。修复后两处生成器都取 rsrid 子集。
    const dir = mkdtempSync(join(tmpdir(), "doc-generator-coverage-"))
    const dataFile = join(dir, ".matrix", "data", "confirmation-tests.json")
    const outputFile = join(dir, ".matrix", "reports", "test-cases.md")

    writeJson(dataFile, {
      project_name: "覆盖来源测试",
      version: "V1.0",
      created_date: "2026-08-20",
      summary: { total_cases: 1, by_type: { "接口测试": 1 } },
      test_cases: [
        {
          case_id: "TC-JK-001",
          case_name: "遥测帧1轮询控制序列CANA接口异常测试",
          correspond_fun_id: "TR-JK-001、TR-JK-002、TR-JK-003、TR-JK-004、TR-JK-005、TR-JK-006、TR-JK-007、TR-JK-008",
          related_software_req_ids: "TR-JK-001~003",
          test_type: "接口测试",
          test_purpose: "验证字段错误处理。",
          test_step: [
            { 步骤描述: "第1.0秒，通过CANA总线发送遥测帧1轮询控制序列（仲裁场错误）。", 预期结果: "丢弃。" },
          ],
        },
      ],
    })

    await (docGenerator as any).execute({
      data_file: dataFile,
      output_file: outputFile,
      doc_type: "test-cases",
    })

    const markdown = readFileSync(outputFile, "utf-8")
    expect(markdown).toContain("| 覆盖测试需求项 | TR-JK-001~003 |")
    expect(markdown).not.toContain("TR-JK-001~008")
  })
})
