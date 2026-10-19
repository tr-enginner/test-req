import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "subagent"

export const SPEC_IMPLEMENTATION_REVIEW_PROMPT_METADATA: AgentPromptMetadata = {
  category: "quality",
  cost: "EXPENSIVE",
  promptAlias: "SpecImplementationReview",
  triggers: [
    {
      domain: "Requirement-code consistency",
      trigger:
        "Verify implementation matches requirement specifications across logic, values, boundaries, states, timing, formulas, error handling, interfaces, and hardware behavior",
    },
  ],
  useWhen: [
    "Phase 3 per-requirement document-implementation consistency review",
    "You need requirement-to-code verification with D1-D10 dimension checking",
  ],
  avoidWhen: [
    "Per-file behavioral safety defect hunting is needed (use behavioral-safety-review)",
    "Holistic code review defect merge/report generation is needed (use code-review-summary)",
  ],
}

const SPEC_IMPLEMENTATION_REVIEW_SYSTEM_PROMPT = `You are the Spec-Implementation Review agent, a specialized subagent in the Matrix embedded software testing system.

<role>
Your sole responsibility is reviewing one requirement per invocation and verifying whether the code actually implements that requirement correctly.

You do not perform behavioral safety defect hunting without a requirement anchor.
You do not perform static rule checking.
You do not generate the final merged code-review report.
</role>

<activation>
Expect the delegated prompt to include:
- target_requirement_id=<REQ_ID>

Optional prompt markers:
- has_linked_functions=false
- traced_function_ids=[...]
- traced_function_ids=none

If target_requirement_id is missing, ask for the exact requirement ID and stop.
</activation>

<workflow>
1. Load the dedicated skill:
\`\`\`
skill spec-implementation-review
\`\`\`
2. Read:
   - .matrix/data/software-analysis.json
   - .matrix/data/compilation-env.json
3. Discover project source files with glob when code discovery is needed.
4. Review exactly one requirement and write one ReviewRecord JSON to .matrix/data/review-records/<REQ_ID>.json.
</workflow>

<quality_rules>
- Review one requirement only.
- Read actual source code before judging consistency.
- Every MISMATCH must map to a defect.
- Do not collapse multi-clause requirements into one check.
- Do not substitute comments or identifier names for executable behavior.
- If the requirement references hardware, interrupts, registers, DMA, or platform-specific behavior, evaluate D10.
- Report exact file_path and line_start for every defect.
</quality_rules>`

export function createSpecImplementationReviewAgent(model?: string): AgentConfig {
  return {
    description:
      "Dedicated document-implementation consistency review agent. Reviews one requirement per invocation, writes ReviewRecord JSON to .matrix/data/review-records/, and focuses on D1-D10 requirement-to-code verification. (Spec-Implementation Review - Matrix)",
    mode: MODE,
    ...(model ? { model } : {}),
    prompt: SPEC_IMPLEMENTATION_REVIEW_SYSTEM_PROMPT,
    tools: {
      code_parser: true,
      code_preprocessor: true,
      req_parser: true,
      read: true,
      write: true,
      glob: true,
      grep: true,
      skill: true,
    },
    color: "#F39C12",
    permission: {
      edit: "allow",
      bash: "deny",
    },
  }
}
createSpecImplementationReviewAgent.mode = MODE
