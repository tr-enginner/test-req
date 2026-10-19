import { resolve } from "path"

interface GuardDecision {
  reason: string
  artifact: string
  view: string
  extra?: string
}

const PHASE6_STRUCTURED_PATTERNS: Array<{
  pattern: RegExp
  artifact: string
  view: string
  reason: string
  extra?: string
}> = [
  {
    pattern: /\.matrix\/data\/phase6-generation-items\.json/i,
    artifact: "phase6_generation_manifest",
    view: "summary",
    reason: "Phase 6 generation manifest 是已定义结构化产物。",
    extra: "如需条目列表，使用 view=\"list_items\"；如需单条需求，使用 view=\"get_item\" 并传 requirement_id。",
  },
  {
    pattern: /\.matrix\/data\/phase6-worker-runs\//i,
    artifact: "phase6_worker_run",
    view: "summary",
    reason: "Phase 6 worker run 产物是已定义结构化 JSON/JSONL 产物。",
    extra: "如需运行结果，使用 view=\"result_summary\"；如需失败详情，使用 view=\"failed_requirements\" 或 view=\"diagnostic\"。",
  },
  {
    pattern: /\.matrix\/data\/source-confirmation-tests\.json/i,
    artifact: "source_confirmation_suite",
    view: "summary",
    reason: "源确认测试套件是已定义结构化产物。",
    extra: "如需用例列表，使用 view=\"list_cases\"；如需单个用例，使用 view=\"get_case\" 并传 case_id。",
  },
  {
    pattern: /\.matrix\/data\/confirmation-tests(?:\.partial)?\.json/i,
    artifact: "translated_confirmation_suite",
    view: "summary",
    reason: "翻译后的确认测试套件是已定义结构化产物。",
    extra: "正式执行输入请查询 translated_confirmation_suite；partial 文件仅用于诊断。若该查询返回 schema_invalid（部分步骤未翻译所致），改查 artifact=\"source_confirmation_suite\" 的同名 view，不要改用 bash cat/python 读取文件。",
  },
  {
    pattern: /\.matrix\/data\/reviews\/case-review-prepared\.json/i,
    artifact: "phase6_case_review_prepared",
    view: "summary",
    reason: "Phase 6 预审产物是已定义结构化产物。",
    extra: "如需占位符、覆盖率或候选问题，使用 phase6_case_review_prepared 对应明细 view。",
  },
  {
    pattern: /\.matrix\/data\/phase6-execution-loop\.json/i,
    artifact: "phase6_execution_loop",
    view: "summary",
    reason: "Phase 6 执行闭环产物是已定义结构化产物。",
  },
  {
    pattern: /\.matrix\/data\/test-cases-todo\.txt/i,
    artifact: "phase6_todo",
    view: "summary",
    reason: "Phase 6 todo 文件是已定义结构化 TXT 产物。",
  },
  {
    pattern: /\.matrix\/data\/test-execution\.json/i,
    artifact: "phase6_execution_loop",
    view: "summary",
    reason: "Phase 6 DTP 执行报告应通过执行闭环或 suite 查询入口查看摘要。",
  },
]

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "/")
}

function isOpenCodeToolOutputRead(text: string): boolean {
  return /\/\.local\/share\/opencode\/tool-output\/tool_[\w.-]+/i.test(text)
}

function detectStructuredRead(text: string): GuardDecision | null {
  if (isOpenCodeToolOutputRead(text)) {
    return {
      reason: "OpenCode tool-output 缓存不是稳定的 Matrix 结构化查询入口，且容易因截断诱导重复读取。",
      artifact: "phase6_generation_manifest",
      view: "summary",
      extra: "如果刚执行 testcase_generator_run，查询 phase6_generation_manifest。",
    }
  }

  for (const candidate of PHASE6_STRUCTURED_PATTERNS) {
    if (candidate.pattern.test(text)) return candidate
  }
  return null
}

function buildBlockedOutput(decision: GuardDecision): string {
  return [
    "[PHASE 6 STRUCTURED READ GUARD] 已阻止读取结构化产物全文。",
    decision.reason,
    `请改用 matrix_artifact_query：artifact="${decision.artifact}" view="${decision.view}"。`,
    decision.extra ?? "",
  ].filter(Boolean).join("\n")
}

export function createPhase6StructuredReadGuardHook(_directory: string) {
  return {
    "tool.execute.after": async (
      input: { tool: string; sessionID: string },
      output: { title?: string; output?: string; metadata?: Record<string, unknown> },
    ) => {
      if (input.tool !== "read" && input.tool !== "repo_read") return
      const combined = normalizeText(`${output.title ?? ""}\n${output.output ?? ""}`)
      const decision = detectStructuredRead(combined)
      if (!decision) return

      output.output = buildBlockedOutput(decision)
      output.metadata = {
        ...(output.metadata ?? {}),
        phase6_structured_read_blocked: true,
        suggested_artifact: decision.artifact,
        suggested_view: decision.view,
        workspace_root: resolve(_directory),
      }
    },
  }
}
