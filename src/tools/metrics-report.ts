import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { ARTIFACT_PATHS } from "../shared/constants"
import { MetricsDatabase as MetricsDatabaseSchema } from "../schema/metrics"

/**
 * metrics_report — Query performance metrics collected during workflow execution.
 * Reads .matrix/data/metrics.json and returns formatted summaries.
 */
export const metricsReport: ToolDefinition = tool({
  description:
    "Query Matrix performance metrics: per-agent token usage, cost, and execution time. " +
    "Reads collected metrics from .matrix/data/metrics.json. " +
    "Supports summary, by_agent, by_phase, and detail views with optional agent/phase filters.",
  args: {
    project_dir: tool.schema.string().describe("Project root directory"),
    view: tool.schema
      .enum(["summary", "by_agent", "by_phase", "detail"])
      .optional()
      .describe("View mode (default: summary)"),
    agent: tool.schema
      .string()
      .optional()
      .describe("Filter by agent name"),
    phase: tool.schema
      .string()
      .optional()
      .describe("Filter by phase ID (e.g. '0', '1', '1b', '2', ..., '8')"),
  },
  async execute({ project_dir, view = "summary", agent, phase }) {
    const metricsPath = join(project_dir, ARTIFACT_PATHS.METRICS)

    if (!existsSync(metricsPath)) {
      return JSON.stringify({
        error: "No metrics data found. Run a workflow first to collect metrics.",
        path: metricsPath,
      })
    }

    let db
    try {
      const raw = readFileSync(metricsPath, "utf-8")
      db = MetricsDatabaseSchema.parse(JSON.parse(raw))
    } catch (err) {
      return JSON.stringify({
        error: `Failed to parse metrics data: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    switch (view) {
      case "summary":
        return JSON.stringify({
          view: "summary",
          totals: db.totals,
          agent_count: db.by_agent.length,
          phase_count: db.by_phase.length,
          top_agents_by_tokens: db.by_agent.slice(0, 5).map((a) => ({
            agent: a.agent,
            total_tokens: a.total_tokens,
            total_cost: a.total_cost,
            message_count: a.message_count,
          })),
          top_agents_by_time: [...db.by_agent]
            .sort((a, b) => b.total_duration_ms - a.total_duration_ms)
            .slice(0, 5)
            .map((a) => ({
              agent: a.agent,
              total_duration_ms: a.total_duration_ms,
              avg_duration_ms: a.avg_duration_ms,
            })),
          updated_at: db.updated_at,
        })

      case "by_agent": {
        let agents = db.by_agent
        if (agent) {
          agents = agents.filter((a) => a.agent === agent)
        }
        return JSON.stringify({
          view: "by_agent",
          agents,
        })
      }

      case "by_phase": {
        let phases = db.by_phase
        if (phase !== undefined) {
          phases = phases.filter((p) => p.phase === phase)
        }
        return JSON.stringify({
          view: "by_phase",
          phases,
        })
      }

      case "detail": {
        let entries = db.entries
        if (agent) {
          entries = entries.filter((e) => e.agent === agent)
        }
        if (phase !== undefined) {
          entries = entries.filter((e) => e.phase === phase)
        }
        return JSON.stringify({
          view: "detail",
          count: entries.length,
          entries,
        })
      }

      default:
        return JSON.stringify({ error: `Unknown view: ${view}` })
    }
  },
})
