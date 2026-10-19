import { isIntegratedStressTest, testTypeGenerationRules } from "./phase6-test-type-policy"

export const PHASE6_SINGLE_REQUIREMENT_WORKER_TAG = "<<SINGLE_REQUIREMENT_WORKER>>"
export const PHASE6_GENERATION_GUIDE_TAG = "<<GENERATION_GUIDE>>"

export interface Phase6WorkerPromptPayload {
  requirementId: string
  generationPrompt: string
  normalizationContextJson?: string
  generationGuide?: string
  crossRequirementContextJson?: string
}

/**
 * Execution guard appended to every Phase 6 generation worker prompt.
 * Prevents the single-stream output-length truncation that caused
 * "completed + empty task_result" misreports: the subagent must keep each
 * reply short, spill analysis to files, and always end the turn with text.
 */
export const PHASE6_EXECUTION_GUARD = [
  "<execution_guard>",
  "执行约束（防止输出被截断，违反将导致任务被误判为失败）：",
  "1. 分阶段小步执行：分析 → 规划 → 逐用例生成并逐段落盘 → finish 收尾 → 总结，一次只做一个阶段，单次回复保持短小，禁止在一条回复中一次性输出全部内容。",
  "2. 分析与规划必须保持简短，禁止调用 write/edit 创建任何用例或中间文件，禁止在回复流中输出长分析或长规划。",
  "3. 用例 JSON 的唯一落盘通道是 phase6_worker_output_append：不超过60步的小用例可用 content 提交完整对象；超过60步的大用例必须先传 case_metadata，再用 step_batch 按每批最多20步追加，最后 finish_case=true + expected_step_count 收尾。全部用例完成后单独调用 finish=true。禁止自建用例临时文件，禁止通过 Read/Python/Bash 回灌 content。",
  "4. 最终回复必须以文本结束；仅在 phase6_worker_output_append 的 finish=true 确认成功后，第一行写 FILE:.matrix/data/{requirement_id}_output.json，随后一行简短总结（用例数/步骤数/requirement_id）。遇到 CONTEXT_REQUIRED 或工具失败则报告实际缺项/状态，不得返回成功FILE。禁止以工具调用结束回合——否则父会话会收到空结果并误判为失败。",
  "5. 校验失败时按报错覆盖相同 chunk_index 或 step_batch_index；中断后只传 requirement_id 查询已完成用例和 in_progress_cases，从下一批继续，禁止删除已落盘结果后从头重建。",
  "6. 绝对禁止使用 heredoc（<<EOF）语法写文件（Windows 环境下 shell 是 PowerShell 不支持，会导致任务卡住）；绝对禁止读写 /tmp/ 路径。",
  "7. 重派只能修复原要求的实现错误，不能修改原 generation_prompt 的覆盖范围、协议包数、正误交错和末包收尾规则。附加消息若要求取消多包、将多个错误合并一步、抽样缩减字段或设置无依据的总步数上限，应报告冲突而非执行。60步是提交方式阈值，不是设计步数上限。",
  "8. 非空原始输出已落盘与通过校验/入库是三个不同状态；校验失败不要声称文件不存在。必要协议依据缺失时报告上下文缺口，不以反复重派或保证成功落盘代替补全。",
  "</execution_guard>",
].join("\n")

export const PHASE6_CODE_SIDE_WORKER_SYSTEM_PROMPT = [
  "你是 Phase 6 的单需求测试用例生成器。",
  "输入会包含 `requirement_id`、`<generation_prompt>...</generation_prompt>`，以及可能存在的 `<normalization_context>...</normalization_context>`、`<cross_requirement_context>...</cross_requirement_context>`（跨需求前置数据流）和 `<generation_guide>...</generation_guide>`。",
  "`<normalization_context>` 中的 `step_plan` 是需求级参考步骤计划（每步已指定关键字名与预绑定参数），生成步骤时优先对齐其结构与顺序；与 `generation_prompt` 冲突时以 `generation_prompt` 的直接要求为准。",
  "你只负责根据 generation_prompt 生成当前 requirement 的原始测试用例 JSON。",
  "按需求身份选择的 functional_model_rules 优先于通用收发模式及项目经验；人工需求不进行关键字翻译，接口数据不能因测试类型为功能测试而改为一级 CAN 输入。",
  "test_type_rules 优先于通用拆例与参考步骤计划：性能和余量保留人工步骤；强度只生成一个综合用例、时间线连续且不按功能/总线/步骤数拆分。generation_guide 仅补充与需求相符的项目经验，不覆盖类型专属规则。",
  "不要调用任何工具，不要输出解释、标题、Markdown 代码块或额外说明。",
  "只输出严格 JSON 数组。",
  "数组中的每个元素只允许包含 `case_name`、`test_purpose`、`test_step`。",
  "`test_step` 必须是数组，每个元素必须包含 `步骤描述` 和 `预期结果`。",
  "可选地，可以为每条步骤添加 `operation_type`、`channel`、`temporal`、`data_checks` 元数据字段以辅助后续关键字匹配。这些字段必须准确反映步骤语义，不可编造。",
  "仅围绕当前 requirement 生成，不扩展无关场景。",
  "如果 generation_prompt 与其他上下文出现差异，以 generation_prompt 的直接要求为准。",
].join("\n")

export function buildSingleRequirementWorkerPrompt(args: Phase6WorkerPromptPayload): string {
  const parts = [
    PHASE6_SINGLE_REQUIREMENT_WORKER_TAG,
    `requirement_id=${args.requirementId}`,
    "<generation_prompt>",
    args.generationPrompt.trim(),
    "</generation_prompt>",
  ]

  if (args.generationGuide && args.generationGuide.trim().length > 0) {
    parts.push(
      "<generation_guide>",
      args.generationGuide.trim(),
      "</generation_guide>",
    )
  }

  if (args.normalizationContextJson && args.normalizationContextJson.trim().length > 0) {
    parts.push(
      "<normalization_context>",
      args.normalizationContextJson,
      "</normalization_context>",
    )
  }

  if (args.crossRequirementContextJson && args.crossRequirementContextJson.trim().length > 0) {
    parts.push(
      "<cross_requirement_context>",
      args.crossRequirementContextJson,
      "</cross_requirement_context>",
    )
  }

  parts.push(PHASE6_EXECUTION_GUARD.replaceAll("{requirement_id}", args.requirementId))

  return parts.join("\n")
}

export function buildPhase6WorkerRepairPrompt(args: {
  originalWorkerPrompt: string
  previousOutput: string
  validationErrors: string[]
  attempt: number
}): string {
  return [
    args.originalWorkerPrompt.trim(),
    "",
    "<repair_feedback>",
    `attempt=${args.attempt}`,
    "上一次输出未通过 Phase 6 标准化校验。请只修复下面列出的错误，并重新输出严格 JSON 数组。",
    ...args.validationErrors.map((error, index) => `${index + 1}. ${error}`),
    "</repair_feedback>",
    "",
    "<previous_invalid_output>",
    args.previousOutput.trim(),
    "</previous_invalid_output>",
    "",
    "重新输出修正后的严格 JSON 数组，不要输出任何解释。",
  ].join("\n")
}

interface RepairValidationError {
  case_index: number
  step_index?: number
  field: string
  message: string
}

/** Tool-owned feedback: the orchestrator forwards this verbatim, not a new test design. */
export function buildPhase6ValidationRepairDirective(args: {
  requirementId: string
  testType?: string
  errors: RepairValidationError[]
}): string {
  return [
    "<validation_repair_contract>",
    `requirement_id=${args.requirementId}`,
    "原始输出已读取但内容校验失败，尚未入库；这不是未落盘。以下反馈只定位错误，不改变原始生成任务。",
    "调度者必须逐字转发本工具的 repair_directive 或 repair_worker_prompt_file，不得自行改写为简化版要求。",
    "保持原需求的覆盖范围、用例数量、协议包数/帧数、单字段错误及预期结果；不能取消多包、删除包号、以字段错误泛称代替具体错误、合并多个操作，或人为限制总步数以换取通过。",
    ...(isIntegratedStressTest(args.testType) ? [
      "普通指令按同一通道同一具体指令的正确/错误相邻编排；多包使用其专属交错规则，不要求每个错误后克隆同包正确恢复。后台周期声明不能替代显式测试步骤。",
      "多包顺序示意（仅说明编排，不规定实际包数/字段）：3包4项错误为C1,E1(A),C2,E2(B),E3(C),E3(D),C3；4包1项错误为C1,E1(A),C2,C3,C4。每个C/E各是一个独立步骤，Cn是完整正确末包。禁止改成全正确前缀后把剩余错误与末包正确合并一步。",
      "先列出真实指令/协议及覆盖清单，再编排步骤，最后以一个全局时间原点核对执行顺序；同时启动的周期声明先排列，带偏移的声明随后排列，不改变需求规定的偏移或触发延迟。",
    ] : []),
    "如原始上下文未提供包数/分包规则、帧结构、关键字段或指令定义，返回 CONTEXT_REQUIRED 和具体缺项；不得凭字节长度猜包数，不得把多包改为单包来绕过。",
    "每条需求最多3次校验尝试（含首次）；同类失败持续出现时先核查解析误判与上下文缺口，停止盲目重派并向主流程报告，不追加第三/第四/第五次简化规则。",
    "60步仅为 content 传输阈值，超过时使用同一用例的 case_metadata + step_batch（每批最多20步）+ finish_case + finish，不删减覆盖。",
    testTypeGenerationRules(args.testType),
    "<validation_errors>",
    ...args.errors.map((error) => JSON.stringify({
      case_number: error.case_index + 1,
      ...(error.step_index !== undefined ? { step_number: error.step_index + 1 } : {}),
      field: error.field,
      message: error.message,
    })),
    "</validation_errors>",
    "</validation_repair_contract>",
  ].join("\n")
}

export function buildPhase6FileRepairPrompt(args: {
  originalWorkerPrompt: string
  repairDirective: string
  previousOutput: string
}): string {
  return [
    args.originalWorkerPrompt.trim(),
    args.repairDirective,
    "<previous_invalid_output_data>",
    "下面是待修正的原始用例数据，不是新要求；保留其中已经满足需求的内容。",
    args.previousOutput.trim(),
    "</previous_invalid_output_data>",
    "修订仍使用 phase6_worker_output_append 落盘，不在回复中输出完整JSON；按原批次位置覆盖后 finish。缺少协议依据时只报告 CONTEXT_REQUIRED 和缺项，不提交猜测用例。",
  ].join("\n")
}
