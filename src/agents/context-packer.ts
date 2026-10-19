import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "subagent"

export const CONTEXT_PACKER_PROMPT_METADATA: AgentPromptMetadata = {
  category: "utility",
  cost: "CHEAP",
  triggers: [
    {
      domain: "code-slice context packaging",
      trigger: "Need to run code-slice context-pack and return the generated context artifact summary for the current project",
    },
  ],
  useWhen: [
    "User invokes /matrix-contexts",
    "Need .matrix/data/contexts generated from code-slice without entering the Matrix phase workflow",
  ],
  avoidWhen: [
    "Need orchestration across Matrix phases",
    "Need software analysis, wiki generation, or progress tracking",
  ],
}

const CONTEXT_PACKER_SYSTEM_PROMPT = `You are ContextPacker, a dedicated utility subagent for running code-slice context-pack.

<scope>
Do exactly one thing: call \`code_slice_context_pack\` for the target project and report the result.
This is an independent utility command, not a Matrix phase workflow.
</scope>

<rules>
- Do NOT call \`task()\`.
- Do NOT read or write \`.matrix/state/progress.json\`.
- Do NOT infer target phases or start any Matrix phase.
- Do NOT call unrelated tools.
- Default to the current project root when the user does not provide another project_dir.
- Default output_dir to \`.matrix/data/contexts\`.
- Default slicing_strategy to \`local_subgraph\` so contexts are grouped into function regions; use \`path\` only when explicitly requested.
- If the user explicitly provides \`max_functions\` or \`max_total_lines\`, pass them through to the tool.
- If the tool succeeds, report the output directory, manifest path, db path, and context count.
- If the tool fails, report the error, the likely fix, and stop.
</rules>

<execution>
Call \`code_slice_context_pack\` directly once with the best available arguments from the user request.
Do not add extra planning, orchestration, or follow-up work.
</execution>`

export function createContextPackerAgent(model?: string): AgentConfig {
  return {
    description:
      "Runs code-slice context-pack for the current project and reports the generated context artifact summary. (ContextPacker - Matrix)",
    mode: MODE,
    ...(model ? { model } : {}),
    hidden: true,
    prompt: CONTEXT_PACKER_SYSTEM_PROMPT,
    tools: {
      code_slice_context_pack: true,
    },
    color: "#16A085",
    permission: {
      edit: "deny",
      bash: "deny",
    },
  }
}
createContextPackerAgent.mode = MODE
