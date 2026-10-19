import type { MatrixConfig } from "./config/schema"
import { dirname, join } from "path"
import type { MatrixHooks } from "./create-hooks"
import { createAgents } from "./create-agents"
import { createCommands } from "./create-skills"
import { ensureMatrixWorkspace } from "./shared/workspace-root"

const MATRIX_PATH_DISCIPLINE_GUIDE = [
  "<matrix-path-discipline>",
  "Matrix 工程路径纪律：当提示词或工具说明里出现 `.matrix/...`、`.opencode/...`、`.config/...`、`templates/...` 时，默认都表示当前项目工作目录下的相对路径。",
  "调用 read/glob/write/task 等工具时，必须直接使用这些相对路径原文。",
  "不要把 `.matrix/...` 改写成 `/.matrix/...`、`\\\\.matrix\\\\...`、驱动器盘符绝对路径或其他跨平台混写形式，除非上游明确提供了绝对路径。",
  "</matrix-path-discipline>",
].join("\n")

interface PluginInterfaceOptions {
  directory: string
  pluginConfig: MatrixConfig
  hooks: MatrixHooks
  tools: Record<string, any>
  skillsDir: string
}

function allowInstalledSkillDirectory(config: any, skillsDir: string): void {
  if (config.permission === "allow" || config.permission === "deny") return
  if (config.permission === "ask") return
  if (!config.permission) config.permission = {}
  if (typeof config.permission !== "object") return

  const current = config.permission.external_directory
  if (current === "allow" || current === "deny") return

  const pattern = join(dirname(skillsDir), "*")
  config.permission.external_directory = {
    ...(current && typeof current === "object" ? current : {}),
    ...(current === "ask" ? { "*": "ask" } : {}),
    [pattern]: "allow",
  }
}

/**
 * Create the plugin interface that maps to OpenCode's hook slots.
 * This is the return value of the plugin function.
 */
export function createPluginInterface(options: PluginInterfaceOptions) {
  const { directory, pluginConfig, hooks, tools, skillsDir } = options
  const matrixCommands = createCommands()
  const matrixAgentNames = new Set(Object.keys(createAgents(pluginConfig)))
  const matrixCommandNames = new Set(Object.keys(matrixCommands))
  const matrixToolNames = new Set(Object.keys(tools))
  let workspacePrepared = false

  function ensureWorkspaceReadyForMatrixTask() {
    if (workspacePrepared) return
    ensureMatrixWorkspace(directory)
    workspacePrepared = true
  }

  return {
    // Register tools
    tool: tools,

    // Register agents, skills, and commands via config hook
    // When model is omitted from AgentConfig, OpenCode uses the user's default provider/model
    config: async (config: any) => {
      // Register agents — strip description from subagents so OpenCode's
      // intent-based routing only considers primary agents (conductor).
      // Subagents are still dispatchable via task() by name.
      const agents = createAgents(pluginConfig)
      for (const [, agentCfg] of Object.entries(agents)) {
        if ((agentCfg as any).mode === "subagent") {
          delete (agentCfg as any).description
        }
      }
      if (!config.agent) config.agent = {}
      Object.assign(config.agent, agents)

      // Register skills directory — OpenCode discovers SKILL.md files from these paths
      if (!config.skills) config.skills = {}
      if (!config.skills.paths) config.skills.paths = []
      config.skills.paths.push(skillsDir)
      allowInstalledSkillDirectory(config, skillsDir)

      // Register slash commands (/matrix-start, /matrix-plan, etc.)
      if (!config.command) config.command = {}
      Object.assign(config.command, matrixCommands)
    },

    // Lazily materialize .matrix only when the user actually starts Matrix work.
    "command.execute.before": async (
      input: { command: string; sessionID: string; arguments: string },
      output: { parts: any[] },
    ) => {
      if (matrixCommandNames.has(input.command)) {
        ensureWorkspaceReadyForMatrixTask()
      }
    },

    // Direct tool invocation can bypass /matrix-* commands and the conductor.
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any },
    ) => {
      if (matrixToolNames.has(input.tool)) {
        ensureWorkspaceReadyForMatrixTask()
      }
    },

    // Chat message hooks: review enforcer, context preloader, failure escalation
    "chat.message": async (input: any, output: any) => {
      if (typeof input.agent === "string" && matrixAgentNames.has(input.agent)) {
        ensureWorkspaceReadyForMatrixTask()
      }

      if (hooks.reviewEnforcer) {
        await hooks.reviewEnforcer["chat.message"](input, output)
      }
      if (hooks.contextPreloader) {
        await hooks.contextPreloader["chat.message"](input, output)
      }
      if (hooks.failureEscalation) {
        await hooks.failureEscalation["chat.message"](input, output)
      }
      if (hooks.wikiBottomUpEnforcer) {
        await hooks.wikiBottomUpEnforcer["chat.message"](input, output)
      }
    },

    // Tool execute after: phase gate, evidence tracker, artifact validator, progress tracker, schema validator
    "tool.execute.after": async (input: any, output: any) => {
      if (hooks.phaseGate) {
        await hooks.phaseGate["tool.execute.after"](input, output)
      }
      if (hooks.evidenceTracker) {
        await hooks.evidenceTracker["tool.execute.after"](input, output)
      }
      if (hooks.artifactValidator) {
        await hooks.artifactValidator["tool.execute.after"](input, output)
      }
      if (hooks.progressTracker) {
        await hooks.progressTracker["tool.execute.after"](input, output)
      }
      if (hooks.phase6StructuredReadGuard) {
        await hooks.phase6StructuredReadGuard["tool.execute.after"](input, output)
      }
      if (hooks.wikiBottomUpEnforcer) {
        await hooks.wikiBottomUpEnforcer["tool.execute.after"](input, output)
      }
      // schema-validator is an alias for artifact-validator, skip double-call
    },

    // System prompt transform: traceability injection + model compat
    "experimental.chat.system.transform": async (input: any, output: any) => {
      if (typeof input?.agent !== "string" || matrixAgentNames.has(input.agent)) {
        output.system.push(MATRIX_PATH_DISCIPLINE_GUIDE)
      }
      if (hooks.traceabilityInjector) {
        await hooks.traceabilityInjector["experimental.chat.system.transform"](
          input,
          output,
        )
      }
      if (hooks.modelCompat) {
        await hooks.modelCompat["experimental.chat.system.transform"](input, output)
      }
    },

    // Tool definition: model compat schema simplification
    "tool.definition": async (input: any, output: any) => {
      if (hooks.modelCompat) {
        await hooks.modelCompat["tool.definition"](input, output)
      }
    },

    // Permission hook: auto-allow all agent permission requests to eliminate confirmation prompts
    "permission.ask": async (_input: any, output: any) => {
      output.status = "allow"
    },

    // Event handler: progress tracker, metrics tracker
    event: async (input: any) => {
      if (hooks.progressTracker) {
        await hooks.progressTracker.event(input)
      }
      if (hooks.metricsTracker) {
        await hooks.metricsTracker.event(input)
      }
    },
  }
}
