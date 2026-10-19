import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  resolveAunitCli,
  listAvailablePlatforms,
  extractPlatformCompiler,
  parseCliEnv,
  checkCompilerInPath,
} from "./aunit-utils"

/**
 * aunit_validate_platform — Validate that a platform's compiler is available
 * before creating an AUnit project.
 */
export const aunitValidatePlatform: ToolDefinition = tool({
  description:
    "Validate that an AUnit platform's compiler is available in the environment. " +
    "Checks that the platform exists, extracts its compiler from the Makefile, " +
    "and verifies the compiler can be found using the CLI's PATH. " +
    "Use this BEFORE aunit_create_project to catch missing compilers early.",
  args: {
    platform_name: tool.schema
      .string()
      .describe("Platform configuration name (e.g., 'C6X_CCS_v3.3_VTEST_BIG')"),
    aunit_path: tool.schema
      .string()
      .optional()
      .describe("Path to AUnit installation directory (optional — auto-detected from PATH if omitted)"),
  },
  async execute({ platform_name, aunit_path }) {
    // 1. Resolve AUnit CLI
    let installDir: string
    try {
      const cli = resolveAunitCli(aunit_path)
      installDir = cli.installDir
    } catch (err) {
      return JSON.stringify({
        status: "error",
        platform: platform_name,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // 2. Verify platform exists
    const platforms = listAvailablePlatforms(installDir)
    if (!platforms.includes(platform_name)) {
      return JSON.stringify({
        status: "error",
        platform: platform_name,
        compiler: null,
        compiler_path: null,
        compiler_available: false,
        makefile_exists: false,
        cli_path_dirs: [],
        error: `Platform '${platform_name}' not found. Available platforms: ${platforms.join(", ")}`,
      })
    }

    // 3. Parse CLI environment (includes PATH modifications)
    const cliEnv = parseCliEnv(installDir)

    // Extract CLI-added PATH directories for diagnostics
    const originalPath = process.env.PATH ?? process.env.Path ?? ""
    const cliPath = (cliEnv.PATH ?? cliEnv.Path ?? "") as string
    const originalDirs = new Set(originalPath.split(/[;:]/))
    const cliPathDirs = cliPath
      .split(/[;:]/)
      .filter((d) => d && !originalDirs.has(d))

    // 4. Extract compiler from platform Makefile
    const compiler = extractPlatformCompiler(installDir, platform_name)
    if (!compiler) {
      return JSON.stringify({
        status: "error",
        platform: platform_name,
        compiler: null,
        compiler_path: null,
        compiler_available: false,
        makefile_exists: true,
        cli_path_dirs: cliPathDirs,
        error: `Could not determine compiler for platform '${platform_name}'. No CC/COMPILER/CXX found in Makefile and name-based inference failed.`,
      })
    }

    // 5. Check compiler availability using CLI environment
    const compilerPath = checkCompilerInPath(compiler, cliEnv)

    return JSON.stringify({
      status: "success",
      platform: platform_name,
      compiler,
      compiler_path: compilerPath,
      compiler_available: compilerPath !== null,
      makefile_exists: true,
      cli_path_dirs: cliPathDirs,
    })
  },
})
