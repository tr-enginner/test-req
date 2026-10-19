import type { Plugin } from "@opencode-ai/plugin"
import { loadPluginConfig } from "./plugin-config"
import { createTools } from "./create-tools"
import { createHooks } from "./create-hooks"
import { createPluginInterface } from "./plugin-interface"
import { resolveSkillsDir } from "./create-skills"
import { resolveMatrixWorkspace } from "./shared/workspace-root"

/**
 * Matrix Embedded Agent — OpenCode Plugin
 *
 * Multi-agent system for embedded software testing.
 * Provides specialized agents, domain tools, process hooks,
 * bundled skills, and slash commands covering the full embedded
 * software test lifecycle.
 */
const MatrixEmbeddedAgentPlugin: Plugin = async (ctx) => {
  // Sanitize PATH on Windows: remove AUnit's bundled msys64 directories to prevent
  // MSYS2 DLL version conflicts when the LLM agent runs shell commands (rm, mkdir, etc.)
  // AUnit's .bat file re-adds msys64 to PATH in its own CMD session, so make.exe still works.
  if (process.platform === "win32") {
    const pathKey =
      Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ||
      "Path"
    const original = process.env[pathKey] || ""
    const sanitized = original
      .split(";")
      .filter((entry) => !/[/\\]msys(32|64)[/\\]/i.test(entry))
      .join(";")
    if (sanitized !== original) {
      process.env[pathKey] = sanitized
    }
  }

  // Plugin startup stays read-only: use the OpenCode project directory itself
  // as the Matrix workspace root without creating .matrix until a Matrix task begins.
  const workspace = resolveMatrixWorkspace(ctx.directory)
  if (process.cwd() !== workspace.workspaceDir) {
    process.chdir(workspace.workspaceDir)
  }

  const pluginConfig = loadPluginConfig(workspace.workspaceDir)
  const tools = createTools(pluginConfig, ctx.client)
  const hooks = createHooks(workspace.workspaceDir, pluginConfig)
  const skillsDir = resolveSkillsDir()

  const pluginInterface = createPluginInterface({
    directory: workspace.workspaceDir,
    pluginConfig,
    hooks,
    tools,
    skillsDir,
  })

  return pluginInterface
}

export default MatrixEmbeddedAgentPlugin

// Type exports only — do NOT export functions (opencode treats all exports as plugin instances)
export type { MatrixConfig } from "./config/schema"
export type { BuiltinAgentName } from "./agents/builtin-agents"
