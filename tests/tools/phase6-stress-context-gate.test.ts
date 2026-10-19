import { describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { testcaseGeneratorRun, testcaseFormatCheck } from "../../src/tools/testcase-generator-runner"
import { matrixArtifactQuery } from "../../src/tools/matrix-artifact-query"
import { appendConfirmationCaseToSuiteData } from "../../src/tools/ct-suite-builder"
import { phase6CaseReviewPrepare } from "../../src/tools/phase6-case-review-prepare"
import { buildRequirementIndex } from "../../src/shared/test-requirements"

const requirementId = "TR-QD-001"
const ctx = (directory: string) => ({
  directory, worktree: directory, sessionID: "stress-context-gate", messageID: "m", agent: "test-designer",
  abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
})
function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value), "utf8")
}

const stressRequirement = {
  funId: [requirementId], testType: "强度测试", titleNo: "4.2.1", title: "长期运行综合强度需求",
  requirementContext: "验证软件长时间运行时的响应。",
  inputFlowContext: "无。", outputFlowContext: "无。",
  processingContext: "TR-QD-001：连续运行25小时，通过CANA总线发送正确和错误的249字节上行数据块，检查软件运行正常。",
}
const protocolRequirement = {
  funId: ["TR-JK-SJ-001"], testType: "接口测试", titleNo: "4.1.1", title: "一级CAN上行数据接收接口",
  requirementContext: "通过一级CAN总线接收上行数据。",
  inputFlowContext: [
    "#### 4.1.1 249字节上行数据块数据流",
    "本测试输入由3包组成。每包249字节，各包按包序号连续接收，末包完整正确时结束传输。",
    "首帧包含仲裁场、控制场、INDEX、LENGTH、TITLE；中间帧包含连续帧序号；尾帧包含SUM校验。",
    "#### 4.1.2 不相关的相机配置数据流",
    "不应注入强度需求的无关配置字段。",
  ].join("\n"),
  processingContext: "完整正确包被接收，错误包丢弃，正确末包到达后完成业务处理。",
  outputFlowContext: "上行数据应答控制序列。",
}

const structurallyValidCase = {
  case_name: "长时间综合测试", test_purpose: "验证25小时内软件运行正常。", correspond_fun_id: requirementId,
  covered_tr_items: [requirementId], test_type: "强度测试",
  test_step: [
    ...[1, 2, 3].map(n => ({ 步骤描述: `第${n + 2}秒，通过CANA总线发送249字节上行数据块第${n}包（完整正确）。`, 预期结果: "软件接收完整正确数据包。" })),
    { 步骤描述: "第25小时，检查软件运行状态。", 预期结果: "软件运行正常。" },
  ],
}

async function withFixture(linkProtocol: boolean, run: (dir: string, result: any, item: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "matrix-stress-context-gate-"))
  const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
  try {
    cpSync(join(import.meta.dir, "../../templates/testcase-prompts"), join(dir, "testcase-prompts"), { recursive: true })
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    const requirements = join(dir, ".matrix/data/test-requirements.json")
    writeJson(requirements, { funItem: [stressRequirement, ...(linkProtocol ? [protocolRequirement] : [])] })
    const result = JSON.parse(await (testcaseGeneratorRun as any).execute({ test_requirements_file: requirements }, ctx(dir)))
    expect(result.status).toBe("success")
    const manifest = JSON.parse(readFileSync(result.generation_manifest_file, "utf8"))
    const item = manifest.items.find((entry: any) => entry.requirement_id === requirementId)
    expect(item).toBeDefined()
    await run(dir, result, item)
  } finally {
    if (previousGeneratorPath === undefined) delete process.env.MATRIX_TESTCASE_GENERATOR_PATH
    else process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("stress missing-context dispatch and persistence gate", () => {
  test("missing 249-byte protocol is visible in manifest, normalization context, and artifact queries", async () => {
    await withFixture(false, async (dir, result, item) => {
      expect(item.generation_status).toBe("context_required")
      expect(item.context_gaps.length).toBeGreaterThan(0)
      expect(item.context_gaps.join("\n")).toContain("249字节上行数据块")
      const normalization = JSON.parse(item.normalization_context_json)
      expect(normalization.generation_status).toBe(item.generation_status)
      expect(normalization.context_gaps).toEqual(item.context_gaps)
      expect(result.ready_count).toBe(0)
      expect(result.context_required_requirements).toEqual([{ requirement_id: requirementId, context_gaps: item.context_gaps }])

      const query = async (view: string) => JSON.parse(await (matrixArtifactQuery as any).execute({
        artifact: "phase6_generation_manifest", view, requirement_id: requirementId, include_context: true,
      }, ctx(dir)))
      const listed = await query("list_items")
      expect(listed.items[0].generation_status).toBe("context_required")
      expect(listed.items[0].context_gaps).toEqual(item.context_gaps)
      const detail = (await query("get_item")).item
      expect(detail.generation_status).toBe("context_required")
      expect(detail.context_gaps).toEqual(item.context_gaps)
      expect(detail.normalization_context.context_gaps).toEqual(item.context_gaps)
      expect(detail.normalization_context.generation_status).toBe("context_required")
    })
  })

  test("format checking a blocked manifest never retries, repairs, or writes the suite", async () => {
    await withFixture(false, async (dir, _result, item) => {
      const sourceFile = join(dir, `.matrix/data/${requirementId}_output.json`)
      writeJson(sourceFile, [{
        case_name: "长时间综合测试", test_purpose: "验证25小时内软件运行正常。", covered_tr_items: [requirementId],
        test_step: [
          { 步骤描述: "第3秒，通过CANA总线发送正确的249字节上行数据块。", 预期结果: "软件处理上行数据。" },
          { 步骤描述: "第25小时，检查软件运行状态。", 预期结果: "软件运行正常。" },
        ],
      }])
      const originalSource = readFileSync(sourceFile, "utf8")
      const suiteFile = join(dir, ".matrix/data/confirmation-tests.json")
      const legacySuiteFile = join(dir, ".matrix/data/source-confirmation-tests.json")
      const repairFile = join(dir, `.matrix/data/phase6-worker-prompts/${requirementId}.repair.txt`)
      for (const persist of [false, true]) {
        const result = JSON.parse(await (testcaseFormatCheck as any).execute({
          requirement_id: requirementId, generated_text_file: sourceFile, persist, auto_repair_structural_violations: true,
        }, ctx(dir)))
        expect(result.valid).toBe(false)
        expect(result.persisted).toBe(false)
        expect(result.failure_kind).toBe("context_required")
        expect(result.retry_allowed).toBe(false)
        expect(result.context_gaps).toEqual(item.context_gaps)
        expect(result.repair_worker_prompt_file).toBeUndefined()
        expect(existsSync(repairFile)).toBe(false)
        expect(existsSync(suiteFile)).toBe(false)
        expect(existsSync(legacySuiteFile)).toBe(false)
        expect(readFileSync(sourceFile, "utf8")).toBe(originalSource)
      }
      // A prior suite must also remain byte-for-byte unchanged on a blocked retry.
      const previousSuite = JSON.stringify({ project_name: "既有测试套件", version: "1.0", test_cases: [] })
      writeFileSync(suiteFile, previousSuite, "utf8")
      const result = JSON.parse(await (testcaseFormatCheck as any).execute({
        requirement_id: requirementId, generated_text_file: sourceFile, persist: true,
      }, ctx(dir)))
      expect(result.failure_kind).toBe("context_required")
      expect(readFileSync(suiteFile, "utf8")).toBe(previousSuite)
      expect(existsSync(repairFile)).toBe(false)
    })
  })

  test("a matching same-project protocol unblocks stress generation and carries its source", async () => {
    await withFixture(true, async (_dir, result, item) => {
      expect(item.generation_status).toBe("ready")
      expect(item.context_gaps).toEqual([])
      expect(result.ready_count).toBe(2)
      expect(result.context_required_requirements).toEqual([])
      const normalization = JSON.parse(item.normalization_context_json)
      expect(normalization.generation_status).toBe("ready")
      expect(normalization.context_gaps).toEqual([])
      const protocol = JSON.parse(normalization.protocolContext)
      expect(protocol.upstream_flows).toHaveLength(1)
      expect(protocol.upstream_flows[0].requirement_id).toBe("TR-JK-SJ-001")
      expect(protocol.upstream_flows[0].inputFlow).toContain("249字节上行数据块数据流")
      expect(protocol.upstream_flows[0].inputFlow).toContain("尾帧包含SUM校验")
      expect(protocol.upstream_flows[0].inputFlow).not.toContain("无关配置字段")
      expect(readFileSync(item.worker_prompt_file, "utf8")).toContain("249字节上行数据块数据流")
    })
  })

  test("direct builder rejects missing protocol without depending on a generation manifest", () => {
    const index = buildRequirementIndex({ funItem: [stressRequirement] } as any)
    expect(index.get(requirementId)!.contextGaps!.length).toBeGreaterThan(0)
    expect(() => appendConfirmationCaseToSuiteData({ test_cases: [] }, structurallyValidCase, index)).toThrow("CONTEXT_REQUIRED")
    const readyIndex = buildRequirementIndex({ funItem: [stressRequirement, protocolRequirement] } as any)
    expect(readyIndex.get(requirementId)!.protocolContext).toContain("249字节上行数据块数据流")
    expect(() => appendConfirmationCaseToSuiteData({ test_cases: [] }, structurallyValidCase, readyIndex)).not.toThrow()
  })

  test("independent review rejects missing context even if an externally supplied suite is structurally valid", async () => {
    await withFixture(false, async (dir) => {
      // Simulate an externally supplied/legacy case which bypassed the authoritative requirement index.
      const imported = appendConfirmationCaseToSuiteData({ test_cases: [] }, structurallyValidCase).persisted_case
      writeJson(join(dir, ".matrix/data/confirmation-tests.json"), {
        project_name: "强度上下文回归", version: "1.0", created_date: "20261008", test_cases: [imported],
        traceability: [{ test_req_id: requirementId, case_ids: [imported.case_id], coverage_status: "full" }],
        summary: { total_cases: 1, by_type: { 强度测试: 1 } },
      })
      const result = JSON.parse(await (phase6CaseReviewPrepare as any).execute({ project_dir: dir }, ctx(dir)))
      const prepared = JSON.parse(readFileSync(result.prepared_file, "utf8"))
      const failures = prepared.semantic_validation_failures.filter((failure: any) => failure.correspond_fun_id === requirementId)
      expect(JSON.stringify(failures)).toContain("CONTEXT_REQUIRED")
      expect(JSON.stringify(failures)).toContain("249字节上行数据块")
    })
  })
})
