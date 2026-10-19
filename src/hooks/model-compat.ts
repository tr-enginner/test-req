import type { MatrixConfig } from "../config/schema"

/** Compatibility tier determining what mitigations to apply */
export type CompatTier = "off" | "standard" | "basic"

/**
 * Resolve the effective compatibility tier from config + runtime model info.
 * When config is "auto", uses providerID/modelID heuristics.
 */
export function resolveCompatTier(
  configValue: MatrixConfig["model_compat"],
  providerID?: string,
  modelID?: string,
): CompatTier {
  if (configValue !== "auto") return configValue

  const pid = (providerID ?? "").toLowerCase()
  const mid = (modelID ?? "").toLowerCase()

  // Tier: off — models with native tool-calling support
  if (pid.startsWith("anthropic")) return "off"
  if (pid.startsWith("openai") && /^(gpt-4|o[1-9])/.test(mid)) return "off"
  if (pid.startsWith("google") && mid.includes("gemini")) return "off"

  // Everything else defaults to standard (safe default)
  return "standard"
}

/** Build the tool-calling format guide injected into the system prompt */
export function getToolFormatGuide(
  language: MatrixConfig["output_language"],
  tier: CompatTier,
): string {
  if (tier === "off") return ""

  if (language === "zh-CN") {
    let guide = "<tool_calling_rules>\n"
    guide += "重要：调用工具时，必须使用系统提供的结构化工具调用机制（function calling）。\n"
    guide += "不要在文本中输出 <|tool_calls_section_begin>、|tool_sep|>、<tool_call> 或其他原始标记。\n\n"
    guide += "规则：\n"
    guide += "1. 参数必须是合法 JSON：字符串使用双引号，不要使用尾随逗号\n"
    guide += "2. 数组参数使用 JSON 数组，例如 [\"item1\", \"item2\"]\n"
    guide += "3. 可选参数如果不需要就省略，不要传 null\n"
    guide += "4. 每次回复最多调用一个工具\n"
    guide += "5. 如果工具调用失败，检查参数格式后重试\n"

    if (tier === "basic") {
      guide += "\n"
      guide += "常用工具参数示例：\n"
      guide += "- code_parser: {\"action\": \"parse\", \"file_path\": \"src/main.c\"}\n"
      guide += "- req_parser: {\"action\": \"parse\", \"file_path\": \"docs/requirements.md\"}\n"
      guide += "- doc_generator: {\"template\": \"test-summary\", \"output_path\": \"report.md\"}\n"
    }

    guide += "</tool_calling_rules>"
    return guide
  }

  let guide = "<tool_calling_rules>\n"

  guide += "IMPORTANT: When calling tools, you MUST use the structured tool-calling mechanism provided by the system.\n"
  guide += "Do NOT output raw tokens like <|tool_calls_section_begin>, <|tool_sep|>, <tool_call> or other raw markers in text.\n\n"
  guide += "Rules:\n"
  guide += "1. Parameters must be valid JSON — strings in double quotes, no trailing commas\n"
  guide += "2. Array parameters use JSON arrays: [\"item1\", \"item2\"]\n"
  guide += "3. Omit optional parameters if not needed, do not pass null\n"
  guide += "4. Call at most one tool per response\n"
  guide += "5. If a tool call fails, check parameter format and retry\n"

  if (tier === "basic") {
    guide += "\n"
    guide += "Common tool parameter examples:\n"
    guide += "- code_parser: {\"action\": \"parse\", \"file_path\": \"src/main.c\"}\n"
    guide += "- req_parser: {\"action\": \"parse\", \"file_path\": \"docs/requirements.md\"}\n"
    guide += "- doc_generator: {\"template\": \"test-summary\", \"output_path\": \"report.md\"}\n"
  }

  guide += "</tool_calling_rules>"
  return guide
}

/** Max description length for basic tier tool schema simplification */
const MAX_DESCRIPTION_LENGTH = 300

/**
 * Simplify a tool's schema for weaker models (basic tier only).
 * - Truncates overly long descriptions
 * - Appends key parameter examples to description
 * Does NOT modify the parameters structure to avoid Zod validation mismatches.
 */
export function simplifyToolSchema(
  _toolID: string,
  output: { description: string; parameters: any },
) {
  if (output.description && output.description.length > MAX_DESCRIPTION_LENGTH) {
    output.description = output.description.slice(0, MAX_DESCRIPTION_LENGTH) + "..."
  }

  // Append parameter hints from schema if available
  if (output.parameters?.properties) {
    const props = output.parameters.properties as Record<string, any>
    const required = (output.parameters.required ?? []) as string[]
    const hints: string[] = []
    for (const key of required.slice(0, 4)) {
      const prop = props[key]
      if (prop) {
        const typeStr = prop.type ?? "string"
        hints.push(`${key}: <${typeStr}>`)
      }
    }
    if (hints.length > 0) {
      output.description += `\nRequired params: ${hints.join(", ")}`
    }
  }
}

/**
 * model-compat hook — Injects tool-calling format guidance into system prompts
 * and simplifies tool schemas for weaker models.
 *
 * Layer 1: experimental.chat.system.transform — format guidance (standard + basic)
 * Layer 2: tool.definition — schema simplification (basic only)
 */
export function createModelCompatHook(pluginConfig: MatrixConfig) {
  // Cache resolved tier for tool.definition (which has no model info)
  // This is only meaningful when model_compat is explicitly set (not "auto").
  // For "auto", tool.definition cannot detect tier at runtime, so it falls back
  // to the config value — "auto" is treated as not-basic.
  const explicitTier = pluginConfig.model_compat !== "auto"
    ? pluginConfig.model_compat
    : null

  return {
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model?: { providerID?: string; id?: string } },
      output: { system: string[] },
    ) => {
      const tier = resolveCompatTier(
        pluginConfig.model_compat,
        input.model?.providerID,
        input.model?.id,
      )
      if (tier === "off") return
      const guide = getToolFormatGuide(pluginConfig.output_language, tier)
      if (guide) {
        output.system.push(guide)
      }

      // Collapse the system array into a single leading entry.
      //
      // OpenCode keeps the system prompt as string[] (base prompt + agent prompt +
      // every plugin-injected segment) and emits ONE `role:system` message per
      // element. Strict OpenAI-compatible endpoints (e.g. Qwen served via vLLM /
      // SGLang) reject any request with more than one system message, or a system
      // message that is not messages[0], with:
      //   "System message must be at the beginning" (BadRequestError)
      // Merging here — after all of this plugin's pushes — yields a single system
      // message and sidesteps that constraint. Gated behind tier !== "off", so
      // native providers (anthropic/openai/google) keep their per-segment system
      // blocks and prompt-cache breakpoints untouched.
      if (output.system.length > 1) {
        const merged = output.system.join("\n\n")
        output.system.length = 0
        output.system.push(merged)
      }
    },

    "tool.definition": async (
      _input: { toolID: string },
      output: { description: string; parameters: any },
    ) => {
      // tool.definition has no model info, so schema simplification
      // is only applied when explicitly configured as "basic"
      if (explicitTier !== "basic") return
      simplifyToolSchema(_input.toolID, output)
    },
  }
}
