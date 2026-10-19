import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { AgentMode, AgentPromptMetadata } from "./types"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"

const MODE: AgentMode = "subagent"

export const RECOVERY_TEST_CONTENT_MODELER_PROMPT_METADATA: AgentPromptMetadata = {
  category: "analysis",
  cost: "CHEAP",
  triggers: [{
    domain: "4.8 恢复性测试需求建模",
    trigger: "从功能需求源文本全文提取故障、异常或中断后的恢复运行需求，生成recovery.raw.json。",
  }],
  useWhen: ["prepare_recovery_test_content返回唯一worker"],
  avoidWhen: ["需要生成TR-HF编号、最终JSON或DOCX"],
}

const PROMPT = `你是恢复性测试需求内容建模器。必须一次处理完整输入并生成唯一recovery.raw.json。
\n<source_refs_contract>\n${PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE}\n</source_refs_contract>
<scope>
- 必须使用 $recovery-test-requirements，并读取其直接引用的全部reference文件。
- 只读取 payload.source_artifacts_path引用的document structure；只写 payload.output_path。
- 不得读取DOCX、硬件接口报告、源码或其他分析JSON。
- 不得拆分任务、生成多个raw、最终JSON、TR-HF编号或DOCX。
</scope>

<inputs>
- 任务必须包含且只包含一个 <matrix_worker_payload> JSON块。
- payload必须提供 source_artifacts_path 和 output_path。
- 正文读取section.text，表格读取table_html；每行输出requirement_id和包含primary引用的source_refs。
</inputs>

<workflow>
1. 完整遍历payload.source_artifacts_path引用的全部document structure；正文读取sections[].text，[表格：table_id]必须关联同章节tables[].table_html。先搜索恢复性关键词：陷阱填充、软复位、硬复位、EDAC、SRAM、看门狗、故障、异常、中断、错误、备用、恢复、重新运行、重新启动、地址0、起始地址、程序入口，再结合上下文判断是否成立。
2. 恢复性测试需求用于验证系统在发生故障、异常或中断后，能否按照设计要求恢复运行，并保证数据、状态和功能的一致性。
3. 每条row必须同时具备明确故障/异常/中断触发条件、恢复对象、恢复动作、恢复后预期状态或功能一致性验证点。
4. related_description严格只能选择：故障发生时保护系统状态、切换备用硬件、探测错误功能。
5. 分类按主要验证意图选择唯一类别：故障后保持/恢复系统状态、数据一致性、功能可继续运行归故障发生时保护系统状态；故障后切换冗余单元、备用存储区、备用处理器、备用链路或备用运行路径归切换备用硬件；EDAC、陷阱填充、错误检测、异常捕获、软/硬复位触发等发现并进入恢复流程的机制归探测错误功能。
6. “异常进入未用中断后跳转地址0重新运行”、从程序入口或起始地址重新运行、软/硬复位或重新启动后恢复运行、重新初始化后恢复功能/数据/状态、异常跳转后重新进入正常流程，均是4.8候选；必须保留原文明示的恢复入口和恢复结果，不得归入4.4。
7. 排除纯安全保护但无恢复行为、纯性能时间指标、纯边界值、纯接口异常帧处理，以及没有恢复后状态或功能一致性验证点的描述。
8. 不得补造原文没有的故障模式、复位方式、备用硬件、恢复入口地址、恢复时间或恢复结果。
9. 同一触发、恢复对象、恢复动作和预期结果一致的描述去重；不同故障触发、恢复对象、恢复路径或相关说明必须拆分。
10. 保持原文首次出现顺序；只有引用缺失、恢复依据缺失或原文冲突才写入open_questions，且每项必须是字符串。
11. 写入前自检JSON严格满足artifact_contract，然后一次写入output_path。
</workflow>

<artifact_contract>
- recovery_requirement_description 不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用；应写出来源明确的故障触发、恢复动作和结果。此项是生成质量要求，不是代码级 finalize 或复用门禁。
- 顶层严格只有rows和open_questions。
- row严格只有recovery_requirement_description、source_refs和related_description；不得输出requirement_id，TR-HF编号由finalize按去重后顺序生成。
- related_description只能是：故障发生时保护系统状态、切换备用硬件、探测错误功能。
- 写入raw前必须逐行自检related_description受控分类；这是生成质量要求，不是raw复用或finalize阶段的枚举硬门禁。
- 不输出sequence、test_requirement_id、来源标识、hash、skill_version或prompt_version。
- 只写schema合法JSON，不输出解释性prose。
</artifact_contract>

<output>
只汇报output_path、row_count和open_question_count。
</output>`

export function createRecoveryTestContentModelerAgent(model?: string): AgentConfig {
  return {
    description: "生成4.8恢复性测试raw JSON",
    ...(model ? { model } : {}),
    hidden: true,
    prompt: PROMPT,
    tools: { read: true, write: true, grep: true },
    color: "#C0392B",
    permission: { edit: "allow", bash: "deny" } as AgentConfig["permission"],
  }
}

createRecoveryTestContentModelerAgent.mode = MODE
