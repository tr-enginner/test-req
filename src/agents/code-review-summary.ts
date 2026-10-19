import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "subagent"

export const CODE_REVIEW_SUMMARY_PROMPT_METADATA: AgentPromptMetadata = {
  category: "quality",
  cost: "EXPENSIVE",
  promptAlias: "CodeReviewSummary",
  triggers: [
    {
      domain: "Code review aggregation",
      trigger:
        "Merge per-requirement review records and per-file behavioral safety records into the final code-review defects and report",
    },
  ],
  useWhen: [
    "Phase 3 final code-review merge/report step",
    "All review-records and safety-records have already been produced",
  ],
  avoidWhen: [
    "Single requirement consistency review is needed (use spec-implementation-review)",
    "Per-file behavioral safety analysis is needed (use behavioral-safety-review)",
  ],
}

const CODE_REVIEW_SUMMARY_SYSTEM_PROMPT = `You are the Code-Review Summary agent, a specialized subagent in the Matrix embedded software testing system.

<role>
Your sole responsibility is the holistic code-review aggregation step after all per-requirement consistency reviews and per-file behavioral safety reviews have completed.

You do not perform per-requirement review yourself.
You do not perform per-file behavioral safety analysis yourself.
You read those artifacts, verify completeness, merge defects, and produce the final code-review outputs.
</role>

<workflow>
1. Read:
   - .matrix/data/software-analysis.json
   - .matrix/data/compilation-env.json
2. Discover project source files with glob.
3. Read all .matrix/data/review-records/*.json files.
4. Read all .matrix/data/safety-records/*.json files.
5. Verify completeness, merge defects, and write code_review defects via append_defects with replace_source="code_review".
6. Write .matrix/reports/code-review.md from the same merged defect set.
</workflow>

<quality_rules>
- Treat .matrix/data/defects.json as the single source of truth for final merged output.
- Preserve other sources by using append_defects with replace_source="code_review".
- The report and the code_review defect set must match exactly.
- Flag missing review-records or safety-records explicitly.
</quality_rules>`

export function createCodeReviewSummaryAgent(model?: string): AgentConfig {
  return {
    description:
      "Holistic code-review aggregation agent. Merges review-records and safety-records, validates completeness, writes code_review defects via append_defects, and generates .matrix/reports/code-review.md. (Code-Review Summary - Matrix)",
    mode: MODE,
    ...(model ? { model } : {}),
    prompt: CODE_REVIEW_SUMMARY_SYSTEM_PROMPT,
    tools: {
      append_defects: true,
      read: true,
      write: true,
      glob: true,
      grep: true,
    },
    color: "#E67E22",
    permission: {
      edit: "allow",
      bash: "deny",
    },
  }
}
createCodeReviewSummaryAgent.mode = MODE
