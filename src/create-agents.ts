import type { AgentConfig } from "@opencode-ai/sdk/v2"
import { createBuiltinAgents } from "./agents/builtin-agents"
import type { MatrixConfig } from "./config/schema"

/**
 * Create all agent configurations for the plugin.
 * Called during config hook to register agents with OpenCode.
 * When model is omitted, agents inherit the user's default provider/model.
 */
export function createAgents(
  pluginConfig: MatrixConfig,
  model?: string,
): Record<string, AgentConfig> {
  return createBuiltinAgents(
    pluginConfig.disabled_agents,
    model,
    pluginConfig.output_language,
    pluginConfig.static_repair_enabled,
  )
}
