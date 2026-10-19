import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { ctDocxGenerator } from "../../src/tools/ct-docx-generator"
import { readZip } from "../../src/tools/docx-zip"

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function findCaseOrder(documentXml: string, caseIds: string[]): number[] {
  return caseIds.map((caseId) => documentXml.indexOf(caseId))
}

function makeCase(caseId: string, requirementId: string) {
  return {
    case_id: caseId,
    case_name: `用例${caseId.slice(-1)}`,
    test_environment: "软平台测试环境",
    test_purpose: `验证${requirementId}。`,
    correspond_fun_id: requirementId,
    test_type: "功能测试",
    path: "/4/1/1/",
    constraints: "无",
    initial_settings: "无",
    test_input: "无",
    test_step: [
      {
        步骤描述: "启动软平台。",
        预期结果: "软件正常运行。",
      },
      {
        步骤描述: `执行${requirementId}的测试步骤。`,
        预期结果: `${requirementId}输出正确结果。`,
      },
    ],
    assess_criteria: "实际结果与预期结果一致。",
    cease_condition: "测试正常结束。",
    status: 0,
  }
}

describe("ct_docx_generate", () => {
  test("覆盖测试需求项 {{tr_id}} 取 related_software_req_ids 子集而非 correspond_fun_id 整组", async () => {
    // 2026-08-20 用户报告:DOCX 覆盖列显示 TR-JK-001~008(整组),实际覆盖 TR-JK-001~003
    const dir = mkdtempSync(join(tmpdir(), "ct-docx-generator-coverage-"))
    const dataFile = join(dir, ".matrix", "data", "confirmation-tests.json")
    const outputFile = join(dir, ".matrix", "reports", "confirmation-tests.docx")
    const templatePath = join(import.meta.dir, "..", "..", "templates", "ct-template.docx")

    const coverageCase = makeCase("TC-JK-001", "TR-JK-001、TR-JK-002、TR-JK-003、TR-JK-004、TR-JK-005、TR-JK-006、TR-JK-007、TR-JK-008") as Record<string, unknown>
    coverageCase.case_name = "遥测帧1轮询控制序列CANA接口异常测试"
    coverageCase.related_software_req_ids = "TR-JK-001~003"
    coverageCase.translate_status = "success"
    coverageCase.test_step = [
      {
        key_name: "发送CANATXT数据",
        step_desc: "第1.0秒,通过CANA总线0发送遥测帧1轮询控制序列（仲裁场错误）",
        parameter: [],
        source_step_desc: "第1.0秒，通过CANA总线发送遥测帧1轮询控制序列（仲裁场错误,其余字段正确）。",
        expected_result: "该帧被丢弃。",
        expected_key_name: "保留",
        source_expected_key_name: "保留",
        expected_parameter: [],
        is_startup_step: false,
      },
    ]

    writeJson(dataFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-21",
      test_cases: [coverageCase],
      traceability: [
        { test_req_id: "TR-JK-001", case_ids: ["TC-JK-001"], coverage_status: "full" },
      ],
      summary: { total_cases: 1, by_type: { "接口测试": 1 } },
    })

    const result = JSON.parse(
      await (ctDocxGenerator as any).execute({
        test_cases_file: dataFile,
        template_path: templatePath,
        output_path: outputFile,
      }),
    )

    expect(result.status).toBe("success")
    const documentXml = readZip(readFileSync(outputFile)).get("word/document.xml")!.toString("utf-8")
    // 覆盖列 = 实际覆盖子集,不得出现整组范围
    expect(documentXml).toContain("TR-JK-001~003")
    expect(documentXml).not.toContain("TR-JK-001~008")
  })

  test("accepts Unified steps whose parameter Value is null (loop-interval placeholder)", async () => {
    // 真实事故(2026-08-20): 正则路径 ${para3} 循环时间空捕获产出 Value:null,
    // coerceNulls 把 null 转 undefined 后 z.union([string,number,null]) 拒绝,
    // 发布阶段整包失败(127 处)。校验必须先按文件原样通过 Value:null,
    // coerce 只作为可选字段显式为 null 时的宽容兜底。
    const dir = mkdtempSync(join(tmpdir(), "ct-docx-generator-null-value-"))
    const dataFile = join(dir, ".matrix", "data", "confirmation-tests.json")
    const outputFile = join(dir, ".matrix", "reports", "confirmation-tests.docx")
    const templatePath = join(import.meta.dir, "..", "..", "templates", "ct-template.docx")

    const unifiedCase = makeCase("TC-GN-001", "TR-GN-001") as Record<string, unknown>
    unifiedCase.translate_status = "success"
    unifiedCase.test_step = [
      {
        key_name: "发送CANATXT数据",
        step_desc: "第3.0秒,通过CANA总线0发送cmd10.txt",
        parameter: [
          { Value: 3, Name: "${time}", Comments: "执行时间" },
          { Value: 1, Name: "${para1}", Comments: "参数1：ID:0~255" },
          { Value: "cmd10.txt", Name: "${para2}", Comments: "参数2：数据文件" },
          { Value: null, Name: "${para3}", Comments: "参数3：循环时间" },
        ],
        source_step_desc: "第3.0秒，通过CANA总线发送遥控指令。",
        expected_result: "软件正确接收。",
        expected_key_name: "保留",
        source_expected_key_name: "保留",
        expected_parameter: [],
        is_startup_step: false,
      },
    ]

    writeJson(dataFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-21",
      test_cases: [unifiedCase],
      traceability: [
        { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 1,
        by_type: { "功能测试": 1 },
      },
    })

    const result = JSON.parse(
      await (ctDocxGenerator as any).execute({
        test_cases_file: dataFile,
        template_path: templatePath,
        output_path: outputFile,
      }),
    )

    expect(result.status).toBe("success")
    expect(existsSync(outputFile)).toBe(true)
  })

  test("increments the custom case title numbering across cloned DOCX pages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-docx-generator-"))
    const dataFile = join(dir, ".matrix", "data", "source-confirmation-tests.json")
    const outputFile = join(dir, ".matrix", "reports", "confirmation-tests.docx")
    const templatePath = join(import.meta.dir, "..", "..", "templates", "ct-template.docx")

    writeJson(dataFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-21",
      test_cases: [
        makeCase("TC-GN-001", "TR-GN-001"),
        makeCase("TC-GN-002", "TR-GN-002"),
        makeCase("TC-GN-003", "TR-GN-003"),
      ],
      traceability: [
        { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
        { test_req_id: "TR-GN-002", case_ids: ["TC-GN-002"], coverage_status: "full" },
        { test_req_id: "TR-GN-003", case_ids: ["TC-GN-003"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 3,
        by_type: { "功能测试": 3 },
      },
    })

    const result = JSON.parse(
      await (ctDocxGenerator as any).execute({
        test_cases_file: dataFile,
        template_path: templatePath,
        output_path: outputFile,
      }),
    )

    expect(result.status).toBe("success")

    const zipEntries = readZip(readFileSync(outputFile))
    const numberingXml = zipEntries.get("word/numbering.xml")!.toString("utf-8")
    const documentXml = zipEntries.get("word/document.xml")!.toString("utf-8")
    const numIds = [...documentXml.matchAll(/<w:numId\s+w:val="(\d+)"/g)].map((match) => match[1])

    expect(new Set(numIds).size).toBe(3)
    expect(numberingXml).toMatch(/<w:abstractNumId w:val="0"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="2"\/><\/w:lvlOverride>/)
    expect(numberingXml).toMatch(/<w:abstractNumId w:val="0"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"\/><\/w:lvlOverride>/)
  })

  test("orders DOCX cases by test-requirements order and preserves suite order within the same requirement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-docx-generator-order-"))
    const dataFile = join(dir, ".matrix", "data", "source-confirmation-tests.json")
    const requirementsFile = join(dir, ".matrix", "data", "test-requirements.json")
    const outputFile = join(dir, ".matrix", "reports", "confirmation-tests.docx")
    const templatePath = join(import.meta.dir, "..", "..", "templates", "ct-template.docx")

    writeJson(requirementsFile, {
      chapterTrList: {
        titleNo: "4",
        title: "测试类型说明",
        level: 1,
        funItem: [],
        children: [
          {
            titleNo: "4.1",
            title: "功能测试",
            level: 2,
            funItem: [],
            children: [
              {
                titleNo: "4.1.1",
                title: "B需求",
                level: 3,
                funItem: [
                  {
                    funId: "TR-B-001",
                    handling: "B需求。",
                    name: "B需求",
                    priority: "high",
                    sufficiency: "",
                    testMethod: "",
                    passCriteria: "",
                  },
                ],
                children: null,
              },
              {
                titleNo: "4.1.2",
                title: "A需求",
                level: 3,
                funItem: [
                  {
                    funId: "TR-A-001",
                    handling: "A需求。",
                    name: "A需求",
                    priority: "high",
                    sufficiency: "",
                    testMethod: "",
                    passCriteria: "",
                  },
                ],
                children: null,
              },
            ],
          },
        ],
      },
    })

    writeJson(dataFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [
        makeCase("TC-Z-002", "TR-A-001"),
        makeCase("TC-B-001", "TR-B-001"),
        makeCase("TC-A-001", "TR-A-001"),
      ],
      traceability: [
        { test_req_id: "TR-A-001", case_ids: ["TC-Z-002", "TC-A-001"], coverage_status: "full" },
        { test_req_id: "TR-B-001", case_ids: ["TC-B-001"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 3,
        by_type: { "功能测试": 3 },
      },
    })

    const result = JSON.parse(
      await (ctDocxGenerator as any).execute({
        test_cases_file: dataFile,
        template_path: templatePath,
        output_path: outputFile,
      }),
    )

    expect(result.status).toBe("success")

    const zipEntries = readZip(readFileSync(outputFile))
    const documentXml = zipEntries.get("word/document.xml")!.toString("utf-8")
    const [bPos, a2Pos, a1Pos] = findCaseOrder(documentXml, ["TC-B-001", "TC-Z-002", "TC-A-001"])

    expect(bPos).toBeGreaterThan(-1)
    expect(a2Pos).toBeGreaterThan(-1)
    expect(a1Pos).toBeGreaterThan(-1)
    expect(bPos).toBeLessThan(a2Pos)
    expect(a2Pos).toBeLessThan(a1Pos)
  })

  test("keeps suite order when test-requirements.json is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-docx-generator-fallback-order-"))
    const dataFile = join(dir, ".matrix", "data", "source-confirmation-tests.json")
    const outputFile = join(dir, ".matrix", "reports", "confirmation-tests.docx")
    const templatePath = join(import.meta.dir, "..", "..", "templates", "ct-template.docx")

    writeJson(dataFile, {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [
        makeCase("TC-Z-002", "TR-A-001"),
        makeCase("TC-A-001", "TR-A-001"),
      ],
      traceability: [
        { test_req_id: "TR-A-001", case_ids: ["TC-Z-002", "TC-A-001"], coverage_status: "full" },
      ],
      summary: {
        total_cases: 2,
        by_type: { "功能测试": 2 },
      },
    })

    const result = JSON.parse(
      await (ctDocxGenerator as any).execute({
        test_cases_file: dataFile,
        template_path: templatePath,
        output_path: outputFile,
      }),
    )

    expect(result.status).toBe("success")

    const zipEntries = readZip(readFileSync(outputFile))
    const documentXml = zipEntries.get("word/document.xml")!.toString("utf-8")
    const [zPos, aPos] = findCaseOrder(documentXml, ["TC-Z-002", "TC-A-001"])

    expect(zPos).toBeGreaterThan(-1)
    expect(aPos).toBeGreaterThan(-1)
    expect(zPos).toBeLessThan(aPos)
  })
})
