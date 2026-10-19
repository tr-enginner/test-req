import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { ARTIFACT_PATHS, PHASE_AGENTS } from "../shared/constants"
import {
  type MetricsDatabase,
  type MetricEntry,
  MetricsDatabase as MetricsDatabaseSchema,
  createEmptyMetricsDatabase,
  recomputeSummaries,
} from "../schema/metrics"
import { withFileLock } from "../shared/file-mutex"

/**
 * metrics-tracker hook — Collects per-agent performance metrics from completed messages.
 * Listens to message.updated events, extracts token/cost/time data, and persists
 * aggregated metrics to .matrix/data/metrics.json.
 */
export function createMetricsTrackerHook(directory: string) {
  const metricsPath = join(directory, ARTIFACT_PATHS.METRICS)
  const recordedMessageIds = new Set<string>()

  /** Load existing database or create empty one */
  function loadOrCreateDb(): MetricsDatabase {
    try {
      if (existsSync(metricsPath)) {
        const raw = readFileSync(metricsPath, "utf-8")
        const parsed = JSON.parse(raw)
        return MetricsDatabaseSchema.parse(parsed)
      }
    } catch {
      // Corrupted file — start fresh
    }
    return createEmptyMetricsDatabase()
  }

  /** Persist database to disk */
  function saveDb(db: MetricsDatabase): void {
    const dir = dirname(metricsPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(metricsPath, JSON.stringify(db, null, 2), "utf-8")
  }

  /** Resolve phase from agent name using PHASE_AGENTS mapping */
  function resolvePhaseForAgent(agentName: string): string {
    for (const [phaseId, agents] of Object.entries(PHASE_AGENTS)) {
      const agentList = Array.isArray(agents) ? agents : [agents]
      if (agentList.includes(agentName)) return phaseId
    }
    return "-1"
  }

  /** Rebuild in-memory dedup set from persisted entries */
  function reloadDedupSet(): void {
    try {
      const db = loadOrCreateDb()
      recordedMessageIds.clear()
      for (const entry of db.entries) {
        recordedMessageIds.add(entry.message_id)
      }
    } catch {
      // Ignore
    }
  }

  return {
    event: async (input: { event: any }) => {
      const { event } = input
      if (!event) return

      // Reload dedup set on session start/restart
      if (event.type === "session.created" || event.type === "session.started") {
        reloadDedupSet()
        return
      }

      // Only process completed assistant messages
      if (event.type !== "message.updated") return

      const msg = event.properties?.info
      if (!msg) return
      if (msg.role !== "assistant") return
      if (!msg.finish) return
      if (!msg.time?.completed) return

      const messageId = msg.id
      if (!messageId) return

      // In-memory dedup
      if (recordedMessageIds.has(messageId)) return

      // Persistent dedup + write under lock
      await withFileLock(metricsPath, () => {
        const db = loadOrCreateDb()
        if (db.entries.some((e) => e.message_id === messageId)) {
          recordedMessageIds.add(messageId)
          return
        }

        const phase = resolvePhaseForAgent(msg.agent || "unknown")
        const tokens = msg.tokens || {}
        const time = msg.time || {}

        const entry: MetricEntry = {
          message_id: messageId,
          agent: msg.agent || "unknown",
          model_id: msg.model || "unknown",
          phase,
          tokens: {
            input: tokens.input || 0,
            output: tokens.output || 0,
            reasoning: tokens.reasoning || 0,
            cache_read: tokens.cache_read || tokens.cacheRead || 0,
            cache_write: tokens.cache_write || tokens.cacheWrite || 0,
          },
          total_tokens: (tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0),
          cost: msg.cost || 0,
          duration_ms: time.completed && time.created ? time.completed - time.created : 0,
          created_at: time.created ? new Date(time.created).toISOString() : new Date().toISOString(),
          completed_at: time.completed ? new Date(time.completed).toISOString() : new Date().toISOString(),
        }

        db.entries.push(entry)
        const updated = recomputeSummaries(db)
        saveDb(updated)
        recordedMessageIds.add(messageId)
      })
    },
  }
}
