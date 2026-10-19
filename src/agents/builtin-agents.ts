import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { AgentFactory, AgentPromptMetadata } from "./types"

import { createConductorAgent, AGENT_PROMPT_METADATA as CONDUCTOR_META } from "./conductor"
import { createPlannerAgent, AGENT_PROMPT_METADATA as PLANNER_META } from "./planner"
import { createAnalystAgent, ANALYST_PROMPT_METADATA as ANALYST_META } from "./analyst"
import { createSourcePlannerAgent, SOURCE_PLANNER_PROMPT_METADATA as SOURCE_PLANNER_META } from "./source-planner"
import { createChapter1ScopeModelerAgent, CHAPTER1_SCOPE_MODELER_PROMPT_METADATA as CHAPTER1_SCOPE_MODELER_META } from "./chapter1-scope-modeler"
import { createChapter2SystemOverviewModelerAgent, CHAPTER2_SYSTEM_OVERVIEW_MODELER_PROMPT_METADATA as CHAPTER2_SYSTEM_OVERVIEW_MODELER_META } from "./chapter2-system-overview-modeler"
import {
  createHardwareInterfaceModelerAgent,
  HARDWARE_INTERFACE_MODELER_PROMPT_METADATA as HARDWARE_INTERFACE_MODELER_META,
} from "./hardware-interface-modeler"
import {
  createFunctionalTitleTreeModelerAgent,
  FUNCTIONAL_TITLE_TREE_MODELER_PROMPT_METADATA as FUNCTIONAL_TITLE_TREE_MODELER_META,
} from "./functional-title-tree-modeler"
import {
  createFunctionalInitContentModelerAgent,
  FUNCTIONAL_INIT_CONTENT_MODELER_PROMPT_METADATA as FUNCTIONAL_INIT_CONTENT_MODELER_META,
} from "./functional-init-content-modeler"
import {
  createFunctionalOtherContentModelerAgent,
  FUNCTIONAL_OTHER_CONTENT_MODELER_PROMPT_METADATA as FUNCTIONAL_OTHER_CONTENT_MODELER_META,
} from "./functional-other-content-modeler"
import {
  createHardwareInterfaceDiscovererAgent,
  HARDWARE_INTERFACE_DISCOVERER_PROMPT_METADATA as HARDWARE_INTERFACE_DISCOVERER_META,
} from "./hardware-interface-discoverer"
import { createFilldataEnricherAgent, FILLDATA_ENRICHER_PROMPT_METADATA as FILLDATA_ENRICHER_META } from "./filldata-enricher"
import { createInspectorAgent, INSPECTOR_PROMPT_METADATA as INSPECTOR_META } from "./inspector"
import {
  createSpecImplementationReviewAgent,
  SPEC_IMPLEMENTATION_REVIEW_PROMPT_METADATA as SPEC_IMPLEMENTATION_REVIEW_META,
} from "./spec-implementation-review"
import {
  createBehavioralSafetyReviewAgent,
  BEHAVIORAL_SAFETY_REVIEW_PROMPT_METADATA as BEHAVIORAL_SAFETY_REVIEW_META,
} from "./behavioral-safety-review"
import {
  createCodeReviewSummaryAgent,
  CODE_REVIEW_SUMMARY_PROMPT_METADATA as CODE_REVIEW_SUMMARY_META,
} from "./code-review-summary"
import { createStaticAnalyzerAgent, AGENT_PROMPT_METADATA as STATIC_ANALYZER_META } from "./static-analyzer"
import { createUnitTesterAgent, AGENT_PROMPT_METADATA as UNIT_TESTER_META } from "./unit-tester"
import { createEnvArchitectAgent, AGENT_PROMPT_METADATA as ENV_ARCHITECT_META } from "./env-architect"
import { createTestDesignerAgent, AGENT_PROMPT_METADATA as TEST_DESIGNER_META } from "./test-designer"
import {
  createTestDesignerWorkerAgent,
  AGENT_PROMPT_METADATA as TEST_DESIGNER_WORKER_META,
} from "./test-designer-worker"
import { createTestExecutorAgent, TEST_EXECUTOR_PROMPT_METADATA as TEST_EXECUTOR_META } from "./test-executor"
import { createReviewerAgent, REVIEWER_PROMPT_METADATA as REVIEWER_META } from "./reviewer"
import { createOracleAgent, AGENT_PROMPT_METADATA as ORACLE_META } from "./oracle"
import { createSummarizerAgent, SUMMARIZER_PROMPT_METADATA as SUMMARIZER_META } from "./summarizer"
import { createAstgrepAgent, ASTGREP_PROMPT_METADATA as ASTGREP_META } from "./astgrep"
import { createWikiSchedulerAgent, WIKI_SCHEDULER_PROMPT_METADATA as WIKI_SCHEDULER_META } from "./wiki-scheduler"
import { createWikiExecutorAgent, WIKI_EXECUTOR_PROMPT_METADATA as WIKI_EXECUTOR_META } from "./wiki-executor"
import { createIsrReviewerAgent, ISR_REVIEWER_PROMPT_METADATA as ISR_REVIEWER_META } from "./isr-reviewer"
import { createCrReviewerAgent, CR_REVIEWER_PROMPT_METADATA as CR_REVIEWER_META } from "./cr-reviewer"
import { createSaReviewerAgent, SA_REVIEWER_PROMPT_METADATA as SA_REVIEWER_META } from "./sa-reviewer"
import { createMultivarAtomicityCheckerAgent, MULTIVAR_ATOMICITY_CHECKER_PROMPT_METADATA as MULTIVAR_ATOMICITY_CHECKER_META } from "./multivar-atomicity-checker"
import {
  createSinglevarAtomicityCheckerAgent,
  SINGLEVAR_ATOMICITY_CHECKER_PROMPT_METADATA as SINGLEVAR_ATOMICITY_CHECKER_META,
} from "./singlevar-atomicity-checker"
import { createRobotExecutorAgent, ROBOT_EXECUTOR_PROMPT_METADATA as ROBOT_EXECUTOR_META } from "./robot-executor"
import { createContextPackerAgent, CONTEXT_PACKER_PROMPT_METADATA as CONTEXT_PACKER_META } from "./context-packer"
import {
  createInterfaceTestContentModelerAgent,
  INTERFACE_TEST_CONTENT_MODELER_PROMPT_METADATA as INTERFACE_TEST_CONTENT_MODELER_META,
} from "./interface-test-content-modeler"
import {
  createInterfaceTestIdentifierDiscovererAgent,
  INTERFACE_TEST_IDENTIFIER_DISCOVERER_PROMPT_METADATA as INTERFACE_TEST_IDENTIFIER_DISCOVERER_META,
} from "./interface-test-identifier-discoverer"
import {
  createPerformanceTestContentModelerAgent,
  PERFORMANCE_TEST_CONTENT_MODELER_PROMPT_METADATA as PERFORMANCE_TEST_CONTENT_MODELER_META,
} from "./performance-test-content-modeler"
import {
  createReliabilitySafetyTestContentModelerAgent,
  RELIABILITY_SAFETY_TEST_CONTENT_MODELER_PROMPT_METADATA as RELIABILITY_SAFETY_TEST_CONTENT_MODELER_META,
} from "./reliability-safety-test-content-modeler"
import {
  createMarginTestContentModelerAgent,
  MARGIN_TEST_CONTENT_MODELER_PROMPT_METADATA as MARGIN_TEST_CONTENT_MODELER_META,
} from "./margin-test-content-modeler"
import {
  createBoundaryTestContentModelerAgent,
  BOUNDARY_TEST_CONTENT_MODELER_PROMPT_METADATA as BOUNDARY_TEST_CONTENT_MODELER_META,
} from "./boundary-test-content-modeler"
import {
  createDataProcessingTestContentModelerAgent,
  DATA_PROCESSING_TEST_CONTENT_MODELER_PROMPT_METADATA as DATA_PROCESSING_TEST_CONTENT_MODELER_META,
} from "./data-processing-test-content-modeler"
import {
  createRecoveryTestContentModelerAgent,
  RECOVERY_TEST_CONTENT_MODELER_PROMPT_METADATA as RECOVERY_TEST_CONTENT_MODELER_META,
} from "./recovery-test-content-modeler"
import {
  createStrengthTestContentModelerAgent,
  STRENGTH_TEST_CONTENT_MODELER_PROMPT_METADATA as STRENGTH_TEST_CONTENT_MODELER_META,
} from "./strength-test-content-modeler"
import {
  createPhase2OrchestratorAgent,
  PHASE2_ORCHESTRATOR_PROMPT_METADATA as PHASE2_ORCHESTRATOR_META,
} from "./phase2-orchestrator"
import {
  createHardwareInterfaceOrchestratorAgent,
  HARDWARE_INTERFACE_ORCHESTRATOR_PROMPT_METADATA as HARDWARE_INTERFACE_ORCHESTRATOR_META,
} from "./hardware-interface-orchestrator"

/** All agent names */
export type BuiltinAgentName =
  | "conductor"
  | "planner"
  | "analyst"
  | "source-planner"
  | "chapter1-scope-modeler"
  | "chapter2-system-overview-modeler"
  | "hardware-interface-discoverer"
  | "hardware-interface-modeler"
  | "functional-title-tree-modeler"
  | "functional-init-content-modeler"
  | "functional-other-content-modeler"
  | "interface-test-content-modeler"
  | "interface-test-identifier-discoverer"
  | "performance-test-content-modeler"
  | "reliability-safety-test-content-modeler"
  | "margin-test-content-modeler"
  | "boundary-test-content-modeler"
  | "data-processing-test-content-modeler"
  | "recovery-test-content-modeler"
  | "strength-test-content-modeler"
  | "phase2-orchestrator"
  | "hardware-interface-orchestrator"
  | "filldata-enricher"
  | "inspector"
  | "spec-implementation-review"
  | "behavioral-safety-review"
  | "code-review-summary"
  | "static-analyzer"
  | "unit-tester"
  | "env-architect"
  | "test-designer"
  | "test-designer-worker"
  | "test-executor"
  | "reviewer"
  | "oracle"
  | "summarizer"
  | "astgrep"
  | "wiki-scheduler"
  | "wiki-executor"
  | "isr-reviewer"
  | "cr-reviewer"
  | "sa-reviewer"
  | "multivar-atomicity-checker"
  | "singlevar-atomicity-checker"
  | "robot-executor"
  | "context-packer"

/** Agent factory registry */
export const agentFactories: Record<BuiltinAgentName, AgentFactory> = {
  conductor: createConductorAgent as AgentFactory,
  planner: createPlannerAgent as AgentFactory,
  analyst: createAnalystAgent as AgentFactory,
  "source-planner": createSourcePlannerAgent as AgentFactory,
  "chapter1-scope-modeler": createChapter1ScopeModelerAgent as AgentFactory,
  "chapter2-system-overview-modeler": createChapter2SystemOverviewModelerAgent as AgentFactory,
  "hardware-interface-discoverer": createHardwareInterfaceDiscovererAgent as AgentFactory,
  "hardware-interface-modeler": createHardwareInterfaceModelerAgent as AgentFactory,
  "functional-title-tree-modeler": createFunctionalTitleTreeModelerAgent as AgentFactory,
  "functional-init-content-modeler": createFunctionalInitContentModelerAgent as AgentFactory,
  "functional-other-content-modeler": createFunctionalOtherContentModelerAgent as AgentFactory,
  "interface-test-content-modeler": createInterfaceTestContentModelerAgent as AgentFactory,
  "interface-test-identifier-discoverer": createInterfaceTestIdentifierDiscovererAgent as AgentFactory,
  "performance-test-content-modeler": createPerformanceTestContentModelerAgent as AgentFactory,
  "reliability-safety-test-content-modeler": createReliabilitySafetyTestContentModelerAgent as AgentFactory,
  "margin-test-content-modeler": createMarginTestContentModelerAgent as AgentFactory,
  "boundary-test-content-modeler": createBoundaryTestContentModelerAgent as AgentFactory,
  "data-processing-test-content-modeler": createDataProcessingTestContentModelerAgent as AgentFactory,
  "recovery-test-content-modeler": createRecoveryTestContentModelerAgent as AgentFactory,
  "strength-test-content-modeler": createStrengthTestContentModelerAgent as AgentFactory,
  "phase2-orchestrator": createPhase2OrchestratorAgent as AgentFactory,
  "hardware-interface-orchestrator": createHardwareInterfaceOrchestratorAgent as AgentFactory,
  "filldata-enricher": createFilldataEnricherAgent as AgentFactory,
  inspector: createInspectorAgent as AgentFactory,
  "spec-implementation-review": createSpecImplementationReviewAgent as AgentFactory,
  "behavioral-safety-review": createBehavioralSafetyReviewAgent as AgentFactory,
  "code-review-summary": createCodeReviewSummaryAgent as AgentFactory,
  "static-analyzer": createStaticAnalyzerAgent as AgentFactory,
  "unit-tester": createUnitTesterAgent as AgentFactory,
  "env-architect": createEnvArchitectAgent as AgentFactory,
  "test-designer": createTestDesignerAgent as AgentFactory,
  "test-designer-worker": createTestDesignerWorkerAgent as AgentFactory,
  "test-executor": createTestExecutorAgent as AgentFactory,
  reviewer: createReviewerAgent as AgentFactory,
  oracle: createOracleAgent as AgentFactory,
  summarizer: createSummarizerAgent as AgentFactory,
  astgrep: createAstgrepAgent as AgentFactory,
  "wiki-scheduler": createWikiSchedulerAgent as AgentFactory,
  "wiki-executor": createWikiExecutorAgent as AgentFactory,
  "isr-reviewer": createIsrReviewerAgent as AgentFactory,
  "cr-reviewer": createCrReviewerAgent as AgentFactory,
  "sa-reviewer": createSaReviewerAgent as AgentFactory,
  "multivar-atomicity-checker": createMultivarAtomicityCheckerAgent as AgentFactory,
  "singlevar-atomicity-checker": createSinglevarAtomicityCheckerAgent as AgentFactory,
  "robot-executor": createRobotExecutorAgent as AgentFactory,
  "context-packer": createContextPackerAgent as AgentFactory,
}

/** Agent metadata registry */
export const agentMetadata: Record<BuiltinAgentName, AgentPromptMetadata> = {
  conductor: CONDUCTOR_META,
  planner: PLANNER_META,
  analyst: ANALYST_META,
  "source-planner": SOURCE_PLANNER_META,
  "chapter1-scope-modeler": CHAPTER1_SCOPE_MODELER_META,
  "chapter2-system-overview-modeler": CHAPTER2_SYSTEM_OVERVIEW_MODELER_META,
  "hardware-interface-discoverer": HARDWARE_INTERFACE_DISCOVERER_META,
  "hardware-interface-modeler": HARDWARE_INTERFACE_MODELER_META,
  "functional-title-tree-modeler": FUNCTIONAL_TITLE_TREE_MODELER_META,
  "functional-init-content-modeler": FUNCTIONAL_INIT_CONTENT_MODELER_META,
  "functional-other-content-modeler": FUNCTIONAL_OTHER_CONTENT_MODELER_META,
  "interface-test-content-modeler": INTERFACE_TEST_CONTENT_MODELER_META,
  "interface-test-identifier-discoverer": INTERFACE_TEST_IDENTIFIER_DISCOVERER_META,
  "performance-test-content-modeler": PERFORMANCE_TEST_CONTENT_MODELER_META,
  "reliability-safety-test-content-modeler": RELIABILITY_SAFETY_TEST_CONTENT_MODELER_META,
  "margin-test-content-modeler": MARGIN_TEST_CONTENT_MODELER_META,
  "boundary-test-content-modeler": BOUNDARY_TEST_CONTENT_MODELER_META,
  "data-processing-test-content-modeler": DATA_PROCESSING_TEST_CONTENT_MODELER_META,
  "recovery-test-content-modeler": RECOVERY_TEST_CONTENT_MODELER_META,
  "strength-test-content-modeler": STRENGTH_TEST_CONTENT_MODELER_META,
  "phase2-orchestrator": PHASE2_ORCHESTRATOR_META,
  "hardware-interface-orchestrator": HARDWARE_INTERFACE_ORCHESTRATOR_META,
  "filldata-enricher": FILLDATA_ENRICHER_META,
  inspector: INSPECTOR_META,
  "spec-implementation-review": SPEC_IMPLEMENTATION_REVIEW_META,
  "behavioral-safety-review": BEHAVIORAL_SAFETY_REVIEW_META,
  "code-review-summary": CODE_REVIEW_SUMMARY_META,
  "static-analyzer": STATIC_ANALYZER_META,
  "unit-tester": UNIT_TESTER_META,
  "env-architect": ENV_ARCHITECT_META,
  "test-designer": TEST_DESIGNER_META,
  "test-designer-worker": TEST_DESIGNER_WORKER_META,
  "test-executor": TEST_EXECUTOR_META,
  reviewer: REVIEWER_META,
  oracle: ORACLE_META,
  summarizer: SUMMARIZER_META,
  astgrep: ASTGREP_META,
  "wiki-scheduler": WIKI_SCHEDULER_META,
  "wiki-executor": WIKI_EXECUTOR_META,
  "isr-reviewer": ISR_REVIEWER_META,
  "cr-reviewer": CR_REVIEWER_META,
  "sa-reviewer": SA_REVIEWER_META,
  "multivar-atomicity-checker": MULTIVAR_ATOMICITY_CHECKER_META,
  "singlevar-atomicity-checker": SINGLEVAR_ATOMICITY_CHECKER_META,
  "robot-executor": ROBOT_EXECUTOR_META,
  "context-packer": CONTEXT_PACKER_META,
}

/**
 * Language directive appended to agent system prompts when output_language is set.
 * Ensures all human-readable output uses the configured language.
 */
function buildLanguageDirective(language: string): string {
  if (language === "zh-CN") {
    return `

<language_directive>
你的所有人类可读输出必须使用简体中文，包括：
- 所有 Markdown 报告文件（\`.matrix/reports/\` 下的所有 \`.md\` 文件）
- 向用户汇报的状态消息和阶段总结
- 评审意见、缺陷描述、改进建议
- 生成的测试代码、桩代码中的代码注释
- 文档标题、章节名、表格内容

以下内容保持英文：
- JSON 数据文件中的字段名（schema 定义的 key）
- 函数名、变量名、类型名等代码标识符
- 枚举值（如 "logic_error"、"statement" 等 schema 定义的固定值）
- 文件路径和文件名
- Mermaid 图表中的节点 ID（但节点标签文本使用中文）

注意：JSON 数据文件中的字符串值（如 summary、description、purpose、title、suggestion 等描述性字段）也必须使用中文。
</language_directive>`
  }
  return ""
}

/**
 * Repair-disabled directive appended to the static-analyzer prompt when
 * static_repair_enabled is false (the default). Skips Steps 3 & 4 (repair /
 * verify) and adjusts classification and report sections accordingly.
 */
function buildRepairDisabledDirective(): string {
  return `

<repair_directive>
Auto-repair is DISABLED for this session. Follow the modified workflow below:
- SKIP Step 3 (Batch Repair — do NOT invoke specchecker with mode "repair_all").
- SKIP Step 4 (Verify Repairs — do NOT invoke specchecker with mode "verify").
- In Step 5, preserve sa-raw-findings.json as written by the specchecker tool (do NOT modify severity values). Do NOT write defects.json or repair-plan.json.
- In Step 6, omit the "Auto-repair results" section from the markdown report; instead note that repair was not performed in this run.
</repair_directive>`
}

/** Create all agent configs, optionally overriding model */
export function createBuiltinAgents(
  disabledAgents: string[] = [],
  model?: string,
  outputLanguage?: string,
  staticRepairEnabled = false,
): Record<string, AgentConfig> {
  const agents: Record<string, AgentConfig> = {}
  const langDirective = outputLanguage ? buildLanguageDirective(outputLanguage) : ""
  const repairDisabledDirective = staticRepairEnabled ? "" : buildRepairDisabledDirective()

  for (const [name, factory] of Object.entries(agentFactories)) {
    if (disabledAgents.includes(name)) continue
    const agent = factory(model)
    if (agent.prompt) {
      if (name === "static-analyzer" && repairDisabledDirective) {
        agent.prompt = agent.prompt + repairDisabledDirective
      }
      if (langDirective) {
        agent.prompt = agent.prompt + langDirective
      }
    }
    agents[name] = agent
  }

  return agents
}
