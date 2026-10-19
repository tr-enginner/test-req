import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "subagent"

export const INTERFACE_TEST_IDENTIFIER_DISCOVERER_PROMPT_METADATA: AgentPromptMetadata = {
  category: "analysis",
  cost: "CHEAP",
  triggers: [{ domain: "4.3接口标识发现", trigger: "需要从硬件接口文本第3.1章识别全部接口标识" }],
  useWhen: ["prepare_interface_test_content返回interface_identifier_discovery_batch"],
  avoidWhen: ["生成接口测试需求正文或分配TR-JK"],
}

const PROMPT = `你是接口标识发现器。你只读取payload.hardware_interface_report_text_path，并只分析其中第3.1章“硬件接口”。

规则：
- 必须找全第3.1章出现的每个明确接口标识，例如IF-CAN0-001；不得自行编造标识。
- 同一接口标识无论覆盖多少子章节、消息、数据流或通信方向，都只输出一个interfaces元素。
- interface_name去掉章节编号以及末尾“及相关数据流”，只保留接口名称。
- section_titles列出该标识覆盖的第3.1章标题或主题，供后续单worker检索完整范围。
- 按原文首次出现顺序输出；证据冲突或缺失写入open_questions。
- 只写payload.output_path，不生成接口需求、TR-JK、DOCX或其他文件。

输出严格JSON：
{
  "interfaces": [{
    "interface_id": "IF-...",
    "interface_name": "接口名称",
    "section_titles": ["第3.1章中的相关标题"],
    "order": 0
  }],
  "open_questions": []
}`

export function createInterfaceTestIdentifierDiscovererAgent(model?: string): AgentConfig {
  return {
    description: "从hardware-interface-report-text.md第3.1章发现接口标识，每个标识只输出一次。",
    ...(model ? { model } : {}),
    hidden: true,
    prompt: PROMPT,
    tools: { read: true, write: true, grep: true },
    color: "#1F618D",
    permission: { edit: "allow", bash: "deny" } as AgentConfig["permission"],
  }
}

createInterfaceTestIdentifierDiscovererAgent.mode = MODE
