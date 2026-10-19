import { describe, expect, test } from "bun:test"
import {
  SourceConfirmationTestSuite,
  TranslatedConfirmationTestSuite,
} from "../src/schema/confirmation-test-case"

const baseCase = {
  case_name: "功能用例",
  test_environment: "软平台测试环境",
  test_purpose: "验证功能。",
  correspond_fun_id: "TR-GN-001",
  case_id: "TC-GN-001",
  test_type: "功能测试",
  constraints: "无",
  initial_settings: "无",
  test_input: "无",
  assess_criteria: "实际结果与预期结果一致。",
  cease_condition: "测试正常结束。",
}

const baseSuite = {
  project_name: "Matrix",
  version: "1.0",
  created_date: "2026-04-27",
  traceability: [
    { test_req_id: "TR-GN-001", case_ids: ["TC-GN-001"], coverage_status: "full" },
  ],
  summary: {
    total_cases: 1,
    by_type: { "功能测试": 1 },
  },
}

describe("confirmation test suite schemas", () => {
  test("source suite accepts Chinese natural-language step fields", () => {
    const result = SourceConfirmationTestSuite.safeParse({
      ...baseSuite,
      test_cases: [
        {
          ...baseCase,
          test_step: [
            {
              步骤描述: "启动软平台。",
              预期结果: "软件正常运行。",
            },
          ],
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  test("translated suite accepts executable keyword step fields", () => {
    const result = TranslatedConfirmationTestSuite.safeParse({
      ...baseSuite,
      test_cases: [
        {
          ...baseCase,
          translate_status: "success",
          test_step: [
            {
              key_name: "发送CANA数据",
              step_desc: "第10s，通过CAN总线发送正确的过放保护允许间接指令",
              parameter: [
                { Value: 10, Name: "${time}", Comments: "执行时间" },
                { Value: null, Name: "${para3}", Comments: "循环时间" },
              ],
              expected_result: "系统接收到指令并正确处理",
            },
          ],
        },
      ],
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.test_cases[0]?.translate_status).toBe("success")
    }
  })

  test("translated suite rejects missing key_name and missing parameter metadata", () => {
    const missingKeyName = TranslatedConfirmationTestSuite.safeParse({
      ...baseSuite,
      test_cases: [
        {
          ...baseCase,
          test_step: [
            {
              step_desc: "第10s，执行操作",
              parameter: [],
              expected_result: "系统正确处理",
            },
          ],
        },
      ],
    })
    expect(missingKeyName.success).toBe(false)

    const missingParameterComments = TranslatedConfirmationTestSuite.safeParse({
      ...baseSuite,
      test_cases: [
        {
          ...baseCase,
          test_step: [
            {
              key_name: "发送CANA数据",
              step_desc: "第10s，执行操作",
              parameter: [
                { Value: 10, Name: "${time}" },
              ],
              expected_result: "系统正确处理",
            },
          ],
        },
      ],
    })
    expect(missingParameterComments.success).toBe(false)
  })

  test("translated suite allows unresolved parameter placeholders to be preserved", () => {
    const unresolvedPlaceholder = TranslatedConfirmationTestSuite.safeParse({
      ...baseSuite,
      test_cases: [
        {
          ...baseCase,
          test_step: [
            {
              key_name: "发送CANA数据",
              step_desc: "第${time}s，执行操作",
              parameter: [
                { Value: "${time}", Name: "${time}", Comments: "执行时间" },
              ],
              expected_result: "系统正确处理${para1}",
            },
          ],
        },
      ],
    })
    expect(unresolvedPlaceholder.success).toBe(true)
  })
})
