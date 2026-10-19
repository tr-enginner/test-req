import { tool, type ToolDefinition } from "@opencode-ai/plugin"

/**
 * test_env_ctrl — Simulation test environment lifecycle management.
 * Used by: EnvArchitect (setup/teardown), TestExecutor (preconditions).
 *
 * For VTest-specific operations (vtestc execution, VTE validation, diagnostics),
 * use the `vtest_runner` tool instead — it is the single entry point for all vtestc operations.
 */
export const testEnvCtrl: ToolDefinition = tool({
  description:
    "Control simulation test environment lifecycle: start, stop, configure, status, reset, load_image. " +
    "For VTest simulation runs, VTE validation, and diagnostics, use vtest_runner instead.",
  args: {
    action: tool.schema
      .enum(["start", "stop", "configure", "status", "reset", "load_image"])
      .describe("Lifecycle action to perform on the test environment"),
    config: tool.schema
      .string()
      .optional()
      .describe("Configuration JSON string or file path"),
    image_path: tool.schema
      .string()
      .optional()
      .describe("Path to software image to load (for load_image action)"),
    timeout_ms: tool.schema
      .number()
      .optional()
      .describe("Timeout in milliseconds for the action"),
  },
  async execute({ action, config, image_path }) {
    switch (action) {
      case "configure":
        return JSON.stringify({
          status: "configured",
          action: "configure",
          config: config || "default",
          message:
            "Test environment configured. " +
            "For VTest VTE validation, use vtest_runner(action='validate_static') instead.",
        })

      case "start":
        return JSON.stringify({
          status: "mock_started",
          action: "start",
          config: config || "default",
          message:
            "Test environment mock started. " +
            "Configure your HIL/SIL platform connection in .matrix/config/matrix.jsonc.",
        })

      case "stop":
        return JSON.stringify({
          status: "mock_stopped",
          action: "stop",
          message: "Test environment mock stopped.",
        })

      case "status":
        return JSON.stringify({
          status: "mock_idle",
          action: "status",
          environment: {
            state: "idle",
            platform: "mock-simulator",
            uptime_ms: 0,
            loaded_image: null,
          },
          message: "Test environment mock status: idle",
        })

      case "reset":
        return JSON.stringify({
          status: "mock_reset",
          action: "reset",
          message: "Test environment mock reset.",
        })

      case "load_image":
        return JSON.stringify({
          status: "mock_loaded",
          action: "load_image",
          image_path: image_path || "unknown",
          message: "Test environment mock: image loaded.",
        })

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` })
    }
  },
})
