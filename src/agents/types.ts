import type { AgentConfig } from "@opencode-ai/sdk/v2"

export type AgentMode = "primary" | "subagent" | "all"

export type AgentFactory = ((model?: string) => AgentConfig) & {
  mode: AgentMode
}

export type AgentCategory =
  | "orchestration"
  | "analysis"
  | "testing"
  | "quality"
  | "utility"

export type AgentCost = "FREE" | "CHEAP" | "EXPENSIVE"

export interface DelegationTrigger {
  domain: string
  trigger: string
}

export interface AgentPromptMetadata {
  category: AgentCategory
  cost: AgentCost
  triggers: DelegationTrigger[]
  useWhen?: string[]
  avoidWhen?: string[]
  dedicatedSection?: string
  promptAlias?: string
}
