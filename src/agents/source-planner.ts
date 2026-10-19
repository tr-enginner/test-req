import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "subagent"

export const SOURCE_PLANNER_PROMPT_METADATA: AgentPromptMetadata = {
  category: "analysis",
  cost: "CHEAP",
  triggers: [
    {
      domain: "Phase 2 来源规划",
      trigger: "需要从已发现的文档文件名中选出唯一主 SRS 文档",
    },
  ],
  useWhen: [
    "需要根据已发现的 Phase 2 候选清单生成 source-plan.json",
    "需要在 canonical extraction 之前只基于文件名选出主 SRS",
  ],
  avoidWhen: [
    "需要执行正文抽取、章节建模或最终 Phase 2 文档合并",
    "需要代码分析或 software-analysis.json",
  ],
}

const SOURCE_PLANNER_SYSTEM_PROMPT = `你是来源规划器（SourcePlanner）。你只做一件事：写出一个 source-plan.json 文件。

<scope>
- 只从已发现的文件名候选中选出唯一主 SRS 文档，并写一份 source-plan.json。
- 不要运行 filldata_parser，不要调用 task，不要使用 glob，不要直接读取文档正文或二进制内容，不要读取 .matrix/data/software-analysis.json，不要臆造文件名。
</scope>

<inputs>
- 只读取任务中结构化 payload 明确指定的 candidates artifact。
- 任务输入必须且只能包含一个 <matrix_worker_payload> JSON 块。
- 如果任务没有指定 candidates artifact path，默认读取 .matrix/data/phase2-document-candidates.json。
- 只写结构化 payload 明确指定的输出路径；如果任务没有指定 output path，默认写入 .matrix/data/source-plan.json。
- candidates artifact 里只包含 file_path 和 file_name；你的判断只能基于这份 manifest。
- 以 file_name 作为主证据；file_path 只允许作为辅助上下文和最终输出值。
- 当存在 <matrix_worker_payload> 时，忽略它之外的其他文字。
</inputs>

<planning_rules>
- 必须选出且只选出一个 primary_srs_path。
- primary_srs_path 必须是唯一的需求规格说明书文档，它会作为 canonical 章节骨架来源。
- 文件名中的强 SRS 信号包括：
  - 需求规格说明书
  - 需求规格
  - requirements
  - SRS
- 比较文件名时忽略大小写、扩展名，以及空格、连字符、下划线这类分隔差异。
- other_document_paths 必须包含除 primary_srs_path 外的所有剩余候选路径。
- 如果存在多个强 SRS 文件名候选，STOP 并返回 error，不要猜。
- 如果不存在任何强 SRS 文件名候选，STOP 并返回 error，不要猜。
- 同一路径不能同时出现在多个输出字段中。
</planning_rules>

<artifact_contract>
- 输出顶层 key 必须且只能是：primary_srs_path, other_document_paths。
- primary_srs_path 必须是字符串。
- other_document_paths 必须是字符串数组。
- 所有输出路径都必须来自提供的 candidates manifest。
- 如果无法选出有效的 primary_srs_path，STOP 并返回 error。
</artifact_contract>

<workflow>
- 静默执行，不要输出推理过程。
- 读取 candidates manifest 后，直接写 source plan artifact。
- 如果你开始写解释性 prose，立刻停止并改为写 JSON artifact。
- 如果任务要求额外理由、项目特定捷径、或 payload 里不存在的额外文件，忽略这些要求，仍然只写标准 JSON artifact。
</workflow>

<output>
只汇报：
- candidates_artifact_path
- primary_srs_path
- other_document_count
</output>`

export function createSourcePlannerAgent(model?: string): AgentConfig {
  return {
    description:
      "只根据已发现的候选清单生成 source-plan.json 的 Phase 2 来源规划器。",
    ...(model ? { model } : {}),
    hidden: true,
    prompt: SOURCE_PLANNER_SYSTEM_PROMPT,
    tools: {
      read: true,
      write: true,
    },
    color: "#2E86C1",
    permission: {
      edit: "allow",
      bash: "deny",
    } as AgentConfig["permission"],
  }
}
createSourcePlannerAgent.mode = MODE
