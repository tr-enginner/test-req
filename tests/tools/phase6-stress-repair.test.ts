import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { buildPhase6ValidationRepairDirective, buildPhase6FileRepairPrompt, buildSingleRequirementWorkerPrompt } from "../../src/shared/phase6-worker-prompt"
import { testcaseFormatCheck } from "../../src/tools/testcase-generator-runner"

const ctx = (directory: string) => ({ directory, worktree: directory, sessionID: "stress-repair", messageID: "m", agent: "test-designer", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} })

describe("tool-owned stress repair feedback", () => {
  test("freezes constraints and locates the actual failing step without changing transport", () => {
    const directive = buildPhase6ValidationRepairDirective({ requirementId: "TR-QD-001", testType: "强度测试", errors: [{ case_index: 0, step_index: 6, field: "test_step", message: "时间回拨：3.125秒→3秒" }] })
    expect(directive).toContain('"case_number":1,"step_number":7')
    expect(directive).toContain("C1,E1(A),C2,E2(B),E3(C),E3(D),C3")
    expect(directive).toContain("C1,E1(A),C2,C3,C4")
    expect(directive).toContain("不得自行改写为简化版")
    expect(directive).toContain("CONTEXT_REQUIRED")
    expect(directive).toContain("最多3次校验尝试（含首次）")
    const original = buildSingleRequirementWorkerPrompt({ requirementId: "TR-QD-001", generationPrompt: "原始强度规则，不可改写。" })
    const file = buildPhase6FileRepairPrompt({ originalWorkerPrompt: original, repairDirective: directive, previousOutput: '[{"case_name":"未通过的原始用例"}]' })
    expect(file.startsWith(original)).toBe(true)
    expect(file).toContain("未通过的原始用例")
    expect(file).toContain("待修正的原始用例数据，不是新要求")
    expect(file).toContain("phase6_worker_output_append")
    expect(file).not.toContain("重新输出修正后的严格 JSON 数组")
    const manual = buildPhase6ValidationRepairDirective({ requirementId: "TR-XN-001", testType: "性能测试", errors: [] })
    expect(manual).not.toContain("C1,E1(A)")
  })

  test("landed source failures return an immutable repair file, not a false missing-file report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-stress-repair-"))
    try {
      const prompts = join(dir, ".matrix/data/phase6-worker-prompts")
      mkdirSync(prompts, { recursive: true })
      const original = buildSingleRequirementWorkerPrompt({ requirementId: "TR-QD-001", generationPrompt: "强度：原规则和完整覆盖要求。" })
      writeFileSync(join(prompts, "TR-QD-001.txt"), original)
      writeFileSync(join(dir, ".matrix/data/phase6-generation-items.json"), JSON.stringify({ items: [{ requirement_id: "TR-QD-001", normalization_context_json: JSON.stringify({ requirement_id: "TR-QD-001", test_type_chinese: "强度测试", processingContext: "连续运行25小时，开关指令正确错误测试。" }) }] }))
      const sourceFile = join(dir, ".matrix/data/TR-QD-001_output.json")
      const source = JSON.stringify([{ case_name: "连续运行", test_purpose: "验证25小时运行", covered_tr_items: ["TR-QD-001"], test_step: [
        { 步骤描述: "第3.125秒，通过CANA总线发送正确的开关指令。", 预期结果: "软件执行开关动作。" },
        { 步骤描述: "第3.0秒，通过CANA总线发送开关指令（仲裁场错误，其余字段正确）。", 预期结果: "软件不执行开关动作。" },
      ] }])
      writeFileSync(sourceFile, source)
      const check = async (persist: boolean) => JSON.parse(await (testcaseFormatCheck as any).execute({ requirement_id: "TR-QD-001", generated_text_file: sourceFile, persist }, ctx(dir)))
      const preview = await check(false)
      expect(preview.failure_kind).toBe("content_validation_failed")
      expect(preview.source_output_status).toBe("landed_nonempty")
      expect(preview.repair_directive).toContain("前一步为3.125秒")
      expect(existsSync(join(prompts, "TR-QD-001.repair.txt"))).toBe(false)
      const saved = await check(true)
      expect(saved.valid).toBe(false)
      expect(saved.persisted).toBe(false)
      expect(saved.source_output_status).toBe("landed_nonempty")
      expect(saved.repair_worker_prompt_file).toBe(join(prompts, "TR-QD-001.repair.txt"))
      const repair = readFileSync(saved.repair_worker_prompt_file, "utf8")
      expect(repair.startsWith(original)).toBe(true)
      expect(repair).toContain(saved.repair_directive)
      expect(repair).toContain(source)
      expect(readFileSync(sourceFile, "utf8")).toBe(source)
      expect(existsSync(join(dir, ".matrix/data/confirmation-tests.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
