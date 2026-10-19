import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { phase6WorkerOutputAppend } from "../../src/tools/phase6-worker-output-append"
import { createTestDesignerWorkerAgent } from "../../src/agents/test-designer-worker"
import { testcaseFormatCheck } from "../../src/tools/testcase-generator-runner"

function makeCtx(directory: string) {
  return {
    sessionID: "sid-1",
    messageID: "mid-1",
    agent: "test-designer",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function makeCase(name: string) {
  return { test_case_name: name, test_purpose: "目的。", test_step: [{ 步骤描述: "第1秒操作。", 预期结果: "结果。" }] }
}

function makeSteps(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    步骤描述: `第${index + 1}步操作。`,
    预期结果: `第${index + 1}步结果。`,
  }))
}

describe("phase6_worker_output_append(小用例兼容 + 大用例增量协议)", () => {
  test("逐段对象追加→查询可见用例名→finish 拼装落盘并清理段目录", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-append-"))
    const cases = [makeCase("用例一"), makeCase("用例二")]

    // 每段 = 一个完整用例对象,无数组括号
    for (const [i, c] of cases.entries()) {
      const appended = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
        { requirement_id: "TR-JK-001、TR-JK-002", chunk_index: i + 1, content: JSON.stringify(c) },
        makeCtx(dir),
      ))
      expect(appended.status).toBe("appended")
      expect(appended.received_total).toBe(i + 1)
      expect(appended.case_names).toEqual(cases.slice(0, i + 1).map((c) => c.test_case_name))
    }

    // 查询模式:已收段+用例名
    const query = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-JK-001、TR-JK-002" },
      makeCtx(dir),
    ))
    expect(query.received_chunks).toEqual([1, 2])
    expect(query.case_names).toEqual(["用例一", "用例二"])
    expect(query.finalized).toBe(false)

    // finish 收尾 → 工具拼装为 JSON 数组落盘
    const finalized = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-JK-001、TR-JK-002", finish: true },
      makeCtx(dir),
    ))
    expect(finalized.status).toBe("finalized")
    expect(finalized.case_count).toBe(2)
    const outputFile = join(dir, ".matrix", "data", "TR-JK-001、TR-JK-002_output.json")
    expect(existsSync(outputFile)).toBe(true)
    expect(JSON.parse(readFileSync(outputFile, "utf-8"))).toEqual(cases)
    // 段目录已清理
    expect(existsSync(join(dir, ".matrix", "tmp", "worker-output", "TR_JK_001_TR_JK_002"))).toBe(false)

    // finish 幂等:再调返回 already_finalized
    const again = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-JK-001、TR-JK-002", finish: true },
      makeCtx(dir),
    ))
    expect(again.status).toBe("finalized")
    expect(again.already_finalized).toBe(true)
    expect(again.case_count).toBe(2)
    rmSync(dir, { recursive: true, force: true })
  })

  test("180步大用例通过元数据+步骤批次增量落盘，无需临时文件回灌", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-append-large-"))
    const requirementId = "TR-LARGE"
    const steps = makeSteps(180)
    const metadata = {
      test_case_name: "180步大用例",
      test_purpose: "验证大用例增量落盘。",
      covered_tr_items: [requirementId],
      correspond_fun_id: requirementId,
    }

    const started = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: requirementId, case_index: 1, case_metadata: JSON.stringify(metadata) },
      makeCtx(dir),
    ))
    expect(started.status).toBe("case_started")

    for (let offset = 0; offset < steps.length; offset += 20) {
      const batchIndex = offset / 20 + 1
      const appended = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
        {
          requirement_id: requirementId,
          case_index: 1,
          step_batch_index: batchIndex,
          step_batch: JSON.stringify(steps.slice(offset, offset + 20)),
        },
        makeCtx(dir),
      ))
      expect(appended.status).toBe("steps_appended")
      expect(appended.step_count).toBe(Math.min(offset + 20, 180))
    }

    const query = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: requirementId },
      makeCtx(dir),
    ))
    expect(query.in_progress_cases).toEqual([{
      case_index: 1,
      case_name: "180步大用例",
      received_step_batches: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      step_count: 180,
    }])

    const prematureSuiteFinish = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: requirementId, finish: true },
      makeCtx(dir),
    ))
    expect(prematureSuiteFinish.status).toBe("invalid")
    expect(prematureSuiteFinish.error).toContain("未收尾")

    const wrongCount = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: requirementId, case_index: 1, finish_case: true, expected_step_count: 181 },
      makeCtx(dir),
    ))
    expect(wrongCount.status).toBe("invalid")
    expect(wrongCount.error).toContain("期望 181，实际 180")

    const caseFinalized = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: requirementId, case_index: 1, finish_case: true, expected_step_count: 180 },
      makeCtx(dir),
    ))
    expect(caseFinalized.status).toBe("case_finalized")
    expect(caseFinalized.step_count).toBe(180)

    const finalized = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: requirementId, finish: true },
      makeCtx(dir),
    ))
    expect(finalized.status).toBe("finalized")
    expect(finalized.case_count).toBe(1)
    const output = JSON.parse(readFileSync(join(dir, ".matrix", "data", `${requirementId}_output.json`), "utf-8"))
    expect(output[0]).toEqual({ ...metadata, test_step: steps })
    rmSync(dir, { recursive: true, force: true })
  })

  test("增量步骤批次限制20步并在收尾时拒绝缺批", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-append-batch-guard-"))
    const metadata = JSON.stringify({ test_case_name: "批次校验", test_purpose: "目的。" })
    await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-BATCH", case_index: 1, case_metadata: metadata },
      makeCtx(dir),
    )
    const oversized = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-BATCH", case_index: 1, step_batch_index: 1, step_batch: JSON.stringify(makeSteps(21)) },
      makeCtx(dir),
    ))
    expect(oversized.status).toBe("invalid")
    expect(oversized.error).toContain("最多 20 步")

    const missingExpectedCount = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-BATCH", case_index: 1, finish_case: true },
      makeCtx(dir),
    ))
    expect(missingExpectedCount.status).toBe("invalid")
    expect(missingExpectedCount.error).toContain("expected_step_count")

    await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-BATCH", case_index: 1, step_batch_index: 2, step_batch: JSON.stringify(makeSteps(2)) },
      makeCtx(dir),
    )
    const missing = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-BATCH", case_index: 1, finish_case: true, expected_step_count: 2 },
      makeCtx(dir),
    ))
    expect(missing.status).toBe("invalid")
    expect(missing.error).toContain("step_batch_index=1")
    rmSync(dir, { recursive: true, force: true })
  })

  test("content 通道硬拒绝超过60步的完整用例并引导增量模式", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-append-large-content-"))
    const oversizedCase = { ...makeCase("超大用例"), test_step: makeSteps(61) }
    const result = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-LARGE-CONTENT", chunk_index: 1, content: JSON.stringify(oversizedCase) },
      makeCtx(dir),
    ))
    expect(result.status).toBe("invalid")
    expect(result.error).toContain("超过 content 通道60步上限")
    expect(result.hint).toContain("case_metadata")
    expect(result.hint).toContain("step_batch")
    expect(existsSync(join(dir, ".matrix", "tmp", "worker-output", "TR-LARGE-CONTENT"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("对象段被截断时逐段即时报错并指引仅重发该段", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-append-trunc-"))
    const full = JSON.stringify(makeCase("用例一"))
    const truncated = full.slice(0, -3) // 去掉尾部闭合 }

    // 第 1 段被截断 → 立即报错(不等 finish)
    const invalid = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-X", chunk_index: 1, content: truncated },
      makeCtx(dir),
    ))
    expect(invalid.status).toBe("invalid")
    expect(invalid.error).toContain("chunk 1")
    expect(invalid.hint).toContain("重发该段")
    // 未写入、未落盘
    expect(existsSync(join(dir, ".matrix", "tmp", "worker-output", "TR-X"))).toBe(false)
    expect(existsSync(join(dir, ".matrix", "data", "TR-X_output.json"))).toBe(false)

    // 重发完整对象(同 chunk_index) → 成功;finish 随最后一段 → 落盘
    const finalized = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-X", chunk_index: 1, content: full, finish: true },
      makeCtx(dir),
    ))
    expect(finalized.status).toBe("finalized")
    expect(finalized.case_count).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test("非对象段(数组/带围栏对象外的文本)报错;fenced 对象段宽容通过", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-append-obj-"))
    const arraySeg = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-Y", chunk_index: 1, content: '[{"a":1}]' },
      makeCtx(dir),
    ))
    expect(arraySeg.status).toBe("invalid")
    expect(arraySeg.error).toContain("用例对象")

    // ```json 围栏包裹的对象段 → 宽容通过
    const fenced = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-Y", chunk_index: 1, content: "```json\n" + JSON.stringify(makeCase("围栏用例")) + "\n```" },
      makeCtx(dir),
    ))
    expect(fenced.status).toBe("appended")
    rmSync(dir, { recursive: true, force: true })
  })

  test("无任何已收段时 finish 报错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-append-empty-"))
    const result = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-EMPTY", finish: true },
      makeCtx(dir),
    ))
    expect(result.status).toBe("invalid")
    expect(result.error).toContain("没有任何已收段")
    rmSync(dir, { recursive: true, force: true })
  })

  test("旧格式残留段目录在 v2 首次写入时被清空(不与新段混拼)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-append-legacy-"))
    const chunkDir = join(dir, ".matrix", "tmp", "worker-output", "TR-L")
    mkdirSync(chunkDir, { recursive: true })
    // 旧协议残留:拼接片段(数组开头/带逗号结尾)与陈旧 total 文件,无 v2 标记
    writeFileSync(join(chunkDir, "chunk_1.txt"), '[{"test_case_name": "旧片段一"},', "utf-8")
    writeFileSync(join(chunkDir, "chunk_2.txt"), '{"test_case_name": "旧片段二"}]', "utf-8")
    writeFileSync(join(chunkDir, "total_36.txt"), "36", "utf-8")

    const appended = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-L", chunk_index: 1, content: JSON.stringify(makeCase("新用例")) },
      makeCtx(dir),
    ))
    expect(appended.status).toBe("appended")
    expect(appended.case_names).toEqual(["新用例"]) // 旧片段未混入

    const finalized = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-L", finish: true },
      makeCtx(dir),
    ))
    expect(finalized.case_count).toBe(1)
    const output = JSON.parse(readFileSync(join(dir, ".matrix", "data", "TR-L_output.json"), "utf-8"))
    expect(output.map((c: any) => c.test_case_name)).toEqual(["新用例"])
    rmSync(dir, { recursive: true, force: true })
  })

  test("乱序/跳段不影响:按序号排序拼装", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-append-order-"))
    // 先发第 2 段
    await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-O", chunk_index: 2, content: JSON.stringify(makeCase("用例二")) },
      makeCtx(dir),
    )
    // 再发第 1 段
    await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-O", chunk_index: 1, content: JSON.stringify(makeCase("用例一")) },
      makeCtx(dir),
    )
    const finalized = JSON.parse(await (phase6WorkerOutputAppend as any).execute(
      { requirement_id: "TR-O", finish: true },
      makeCtx(dir),
    ))
    expect(finalized.case_count).toBe(2)
    const output = JSON.parse(readFileSync(join(dir, ".matrix", "data", "TR-O_output.json"), "utf-8"))
    expect(output.map((c: any) => c.test_case_name)).toEqual(["用例一", "用例二"])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("worker 提示词序列化契约(静态断言)", () => {
  const agent = createTestDesignerWorkerAgent()
  const prompt = typeof agent.prompt === "string" ? agent.prompt : ""

  test("落盘铁律:禁止内联 JSON 全文、对象段协议、finish 收尾、requirement_id 逐字", () => {
    // 2026-08-20 事故根因:内联 JSON/大 write 参数。
    expect(prompt).toContain("无论 JSON 大小,一律落盘,禁止在回复中直接输出 JSON 全文")
    expect(prompt).toContain("phase6_worker_output_append")
    expect(prompt).toContain("禁止 base64")
    // 2026-08-21 v2 协议:每段一个完整用例对象 + finish 收尾 + id 逐字
    expect(prompt).toContain("一个完整用例对象")
    expect(prompt).toContain("finish=true")
    expect(prompt).toContain("requirement_id 逐字铁律")
    expect(prompt).toContain("超过60步")
    expect(prompt).toContain("step_batch")
    expect(prompt).toContain("expected_step_count")
    expect(prompt).toContain("禁止自建用例 JSON 临时文件")
    // 旧措辞必须移除:首版协议的标点簿记与总量预估是 TR-JK 卡死事故根因
    expect(prompt).not.toContain("total_chunks")
    expect(prompt).not.toContain("首段以 [")
    expect(prompt).not.toContain("printf '%s'")
    expect(prompt).not.toContain("cat <<'EOF'")
    expect(prompt).not.toContain("量小时可直接在回复中输出")
    expect(prompt).not.toContain("用 Write 工具直接写入")
  })

  test("权限硬拒绝 Bash 和工作区外路径，避免 /tmp Read 进入待审批", () => {
    const permission = agent.permission as Record<string, unknown>
    expect(permission.bash).toBe("deny")
    expect(permission.external_directory).toBe("deny")
    expect(permission.read).toBe("allow")
    expect(permission.write).toBe("deny")
  })
})

describe("testcase_format_check 截断精确诊断", () => {
  test("worker 输出文件被截断时报 truncated 并指引重派", async () => {
    const dir = mkdtempSync(join(tmpdir(), "format-check-trunc-"))
    const truncated = JSON.stringify([
      { case_name: "用例一", test_purpose: "目的。", test_step: [{ 步骤描述: "第1秒操作。", 预期结果: "结果。" }] },
    ])
    const file = join(dir, ".matrix", "data", "TR-Z_output.json")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, truncated.slice(0, truncated.length - 20), "utf-8")

    const result = JSON.parse(await (testcaseFormatCheck as any).execute(
      { generated_text_file: file, requirement_id: "TR-Z" },
      makeCtx(dir),
    ))
    expect(result.valid).toBe(false)
    expect(result.error_kind).toBe("truncated")
    expect(result.error).toContain("不完整")
    expect(result.hint).toContain("重派")
    rmSync(dir, { recursive: true, force: true })
  })

  test("合法 fenced JSON 仍正常通过诊断(不误报)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "format-check-ok-"))
    const file = join(dir, ".matrix", "data", "TR-W_output.json")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      "```json\n" + JSON.stringify([
        { case_name: "用例一", test_purpose: "目的。", test_step: [{ 步骤描述: "第1秒操作。", 预期结果: "结果。" }] },
      ]) + "\n```",
      "utf-8",
    )
    const result = JSON.parse(await (testcaseFormatCheck as any).execute(
      { generated_text_file: file, requirement_id: "TR-W" },
      makeCtx(dir),
    ))
    expect(result.error_kind).toBeUndefined()
    expect(result.valid).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
