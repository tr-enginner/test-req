import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { resolveAunitCli, listAvailablePlatforms } from "./aunit-utils"

/**
 * aunit_list_platforms — List available AUnit platform configurations.
 * Reads folder names from <installDir>/config/platform/.
 */
export const aunitListPlatforms: ToolDefinition = tool({
  description:
    "List available SunwiseAUnit platform configurations. " +
    "Returns platform folder names from <installDir>/config/platform/. " +
    "Use this to see what platforms are available before creating a project.",
  args: {
    aunit_path: tool.schema
      .string()
      .optional()
      .describe("Path to AUnit installation directory (optional — auto-detected from PATH if omitted)"),
  },
  async execute({ aunit_path }) {
    let installDir: string
    try {
      const cli = resolveAunitCli(aunit_path)
      installDir = cli.installDir
    } catch (err) {
      return JSON.stringify({
        status: "abnormal",
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const platforms = listAvailablePlatforms(installDir)

    return JSON.stringify({
      status: "success",
      install_dir: installDir,
      platforms,
      count: platforms.length,
    })
  },
})
