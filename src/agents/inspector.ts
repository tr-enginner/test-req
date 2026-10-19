import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "subagent"

export const INSPECTOR_PROMPT_METADATA: AgentPromptMetadata = {
  category: "quality",
  cost: "EXPENSIVE",
  promptAlias: "Inspector",
  triggers: [
    {
      domain: "Phase 3 unified review entry",
      trigger:
        "Route Phase 3 work into requirement consistency review, rigid behavioral safety review, or final code review summary",
    },
  ],
  useWhen: [
    "A single unified Phase 3 review entry is needed",
    "The caller should not choose between spec-implementation-review, behavioral-safety-review, and code-review-summary manually",
  ],
  avoidWhen: [
    "Automated static analysis is the goal (use static-analyzer instead)",
    "Software analysis has not been completed yet (run analyst first)",
  ],
}

const INSPECTOR_SYSTEM_PROMPT = `You are the Inspector, the unified Phase 3 review entry for the Matrix embedded software testing system.

<role>
You do not use review_mode protocol.

Your job is to route the incoming Phase 3 request to exactly one of these specialized agents:
- spec-implementation-review
- behavioral-safety-review
- code-review-summary
</role>

<routing_rules>
Route by intent and payload:

1. If the prompt includes target_requirement_id=<REQ_ID>, dispatch to:
   task(subagent_type="spec-implementation-review", prompt="<equivalent prompt>")

2. If the prompt includes target_file=<PATH> or target_dir=<PATH>, dispatch to:
   task(subagent_type="behavioral-safety-review", prompt="<equivalent prompt>")

3. If the prompt asks for the final Phase 3 merge, summary, completeness verification,
   reading review-records/safety-records, defect merge, or code-review.md generation,
   dispatch to:
   task(subagent_type="code-review-summary", prompt="<equivalent prompt>")

4. If the request is ambiguous, ask for clarification instead of guessing.
</routing_rules>

<delegation_rules>
- Delegate exactly one specialized agent per invocation.
- Do not perform the specialized review work yourself.
- Pass through all relevant context markers such as target_requirement_id, has_linked_functions=false, target_file, target_dir, and artifact expectations.
- When delegating, append this instruction to the specialized agent prompt: "所有人类可读内容必须使用简体中文；JSON 字段名、枚举值、代码标识符和文件路径保持英文；JSON 中的 title、description、summary、suggestion 等描述性字符串值必须使用中文。"
- Return the delegated agent's result.
</delegation_rules>`

export function createInspectorAgent(model?: string): AgentConfig {
  return {
    description:
      "Unified Phase 3 review entry. Routes requests to spec-implementation-review, behavioral-safety-review, or code-review-summary without exposing the old mode-based inspector protocol. (Inspector - Matrix)",
    mode: MODE,
    ...(model ? { model } : {}),
    prompt: INSPECTOR_SYSTEM_PROMPT,
    color: "#F39C12",
    permission: {
      task: "allow",
      read: "allow",
      write: "allow",
      edit: "allow",
      glob: "allow",
      grep: "allow",
      bash: "deny",
    } as AgentConfig["permission"],
  }
}
createInspectorAgent.mode = MODE
