import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "primary"

export const HARDWARE_INTERFACE_ORCHESTRATOR_PROMPT_METADATA: AgentPromptMetadata = {
  category: "orchestration",
  cost: "EXPENSIVE",
  triggers: [{ domain: "硬件接口章节生成", trigger: "按候选发现和通用建模两阶段生成硬件接口。" }],
  useWhen: ["Run /matrix-hardware-interface", "仅需生成3.1硬件接口章节"],
  avoidWhen: ["生成其他测试需求章节", "合并完整 Phase 2 文档"],
}

const PROMPT = `你是 HardwareInterfaceOrchestrator，只负责两阶段通用硬件接口建模。

严格按顺序执行：
1. filldata_phase2_workflow mode="prepare_document_artifacts"。
2. mode="discover_hardware_interface_candidates"，只传mode；若 incremental_reuse=true，直接复用候选集合且不得委派 worker；否则将 discovery_batch.worker_prompt 原样委派给 hardware-interface-discoverer，且只调用一次。
3. mode="prepare_hardware_interface_batches"，只传mode；workflow从默认路径读取source artifacts和candidates。
4. 严格按 worker_waves 顺序执行。每个 wave 内将全部 hardware-interface-modeler 任务一次性并行发起（最多5个），等待整个 wave 收敛后才能启动下一 wave。
5. 任一 worker 失败、缺少输出或 raw 无效时，保留成功 artifact，停止后续 wave、merge 和 finalize，并报告失败 candidate_id；不得把不完整结果合并。
6. 全部 wave 成功后调用 mode="merge_hardware_interface_blocks"，只原样传入完整且按候选顺序排列的 hardware_interface_block_raw_paths；其他路径由workflow内部确定。
7. 调用 mode="finalize_hardware_interface"，只传mode，然后立即停止。

只能使用 workflow 返回的 worker_prompt，不得改写。空候选集合合法且可复用，仍执行 merge 和 finalize。重跑时尊重 discovery 的 incremental_reuse 和建模阶段的 reused_raw_artifacts，不重复发现或建模。不得直接编辑 JSON/DOCX，不读取源码或 software-analysis.json。`

export function createHardwareInterfaceOrchestratorAgent(model?: string): AgentConfig {
  return {
    description: "通过候选发现与最多5路并行的通用建模生成硬件接口章节。",
    mode: MODE,
    ...(model ? { model } : {}),
    temperature: 0.1,
    prompt: PROMPT,
    tools: { filldata_phase2_workflow: true, task: true, read: true },
    color: "#2874A6",
    permission: { task: "allow", read: "allow", edit: "deny", bash: "deny" } as AgentConfig["permission"],
  }
}

createHardwareInterfaceOrchestratorAgent.mode = MODE
