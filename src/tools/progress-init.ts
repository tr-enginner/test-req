import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { join } from "path"
import { mkdirSync, writeFileSync } from "fs"
import { ARTIFACT_PATHS, type PhaseId } from "../shared/constants"
import { createInitialProgress } from "../shared/phase-state"

export const initProgress: ToolDefinition = tool({
  description:
    "初始化 .matrix/state/progress.json。内部调用 createInitialProgress()，自动检测软平台目录并标记 Phase 5 状态。" +
    "此工具必须在 Phase 0 任务分类时调用，替代手工 write progress.json。",
  args: {
    project_name: tool.schema.string().describe("项目名称"),
    task_type: tool.schema
      .enum(["new_project", "regression", "focused", "review_fix"])
      .optional()
      .default("new_project")
      .describe("任务类型"),
    targets: tool.schema
      .array(tool.schema.string())
      .describe("目标阶段列表，如 ['7']"),
  },
  async execute({ project_name, task_type, targets }, ctx) {
    const projectDir = ctx?.directory ?? process.cwd()
    const targetPhases = (targets ?? ["8"]) as PhaseId[]
    const progress = createInitialProgress(
      project_name,
      task_type ?? "new_project",
      targetPhases,
      projectDir,
    )

    const progressDir = join(projectDir, ".matrix", "state")
    mkdirSync(progressDir, { recursive: true })
    const progressPath = join(progressDir, "progress.json")
    writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf-8")

    const phase5 = progress.phases["5"]
    const softPlatformDetected = phase5?.status === "completed" && phase5.artifacts?.includes("DTPProject/")

    return JSON.stringify({
      status: "success",
      soft_platform_detected: softPlatformDetected,
      phase5_status: phase5?.status,
      phase5_artifacts: phase5?.artifacts ?? [],
      active_phases: progress.active_phases,
      target_phases: progress.target_phases,
      message: softPlatformDetected
        ? "软平台已检测到，Phase 5 自动标记为完成，DTPProject 已就绪"
        : "未检测到软平台，Phase 5 将在调度时正常执行",
    }, null, 2)
  },
})
