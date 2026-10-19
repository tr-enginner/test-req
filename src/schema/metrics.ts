import { z } from "zod"
import { PHASE_IDS, PHASE_NAMES, type PhaseId } from "../shared/constants"

/** Token usage breakdown for a single message */
export const TokenMetrics = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
  reasoning: z.number().default(0),
  cache_read: z.number().default(0),
  cache_write: z.number().default(0),
})
export type TokenMetrics = z.infer<typeof TokenMetrics>

/** Single completed message measurement */
export const MetricEntry = z.object({
  message_id: z.string(),
  agent: z.string(),
  model_id: z.string().default("unknown"),
  phase: z.string().default("-1"),
  tokens: TokenMetrics,
  total_tokens: z.number(),
  cost: z.number().default(0),
  duration_ms: z.number().default(0),
  created_at: z.string(),
  completed_at: z.string(),
})
export type MetricEntry = z.infer<typeof MetricEntry>

/** Per-agent aggregate summary */
export const AgentSummary = z.object({
  agent: z.string(),
  message_count: z.number(),
  tokens: TokenMetrics,
  total_tokens: z.number(),
  total_cost: z.number(),
  total_duration_ms: z.number(),
  avg_duration_ms: z.number(),
})
export type AgentSummary = z.infer<typeof AgentSummary>

/** Per-phase aggregate summary */
export const PhaseSummary = z.object({
  phase: z.string(),
  phase_name: z.string(),
  agents: z.array(z.string()),
  tokens: TokenMetrics,
  total_tokens: z.number(),
  total_cost: z.number(),
  total_duration_ms: z.number(),
  message_count: z.number(),
})
export type PhaseSummary = z.infer<typeof PhaseSummary>

/** Top-level metrics database */
export const MetricsDatabase = z.object({
  entries: z.array(MetricEntry),
  by_agent: z.array(AgentSummary),
  by_phase: z.array(PhaseSummary),
  totals: z.object({
    total_tokens: z.number(),
    total_cost: z.number(),
    total_duration_ms: z.number(),
    total_messages: z.number(),
  }),
  updated_at: z.string(),
})
export type MetricsDatabase = z.infer<typeof MetricsDatabase>

/** Create an empty metrics database */
export function createEmptyMetricsDatabase(): MetricsDatabase {
  return {
    entries: [],
    by_agent: [],
    by_phase: [],
    totals: {
      total_tokens: 0,
      total_cost: 0,
      total_duration_ms: 0,
      total_messages: 0,
    },
    updated_at: new Date().toISOString(),
  }
}

/** Recompute by_agent, by_phase, and totals from entries (idempotent) */
export function recomputeSummaries(db: MetricsDatabase): MetricsDatabase {
  // Aggregate by agent
  const agentMap = new Map<string, MetricEntry[]>()
  for (const entry of db.entries) {
    const list = agentMap.get(entry.agent) || []
    list.push(entry)
    agentMap.set(entry.agent, list)
  }

  const by_agent: AgentSummary[] = []
  for (const [agent, entries] of agentMap) {
    const tokens = sumTokens(entries)
    const total_tokens = entries.reduce((s, e) => s + e.total_tokens, 0)
    const total_cost = entries.reduce((s, e) => s + e.cost, 0)
    const total_duration_ms = entries.reduce((s, e) => s + e.duration_ms, 0)
    by_agent.push({
      agent,
      message_count: entries.length,
      tokens,
      total_tokens,
      total_cost,
      total_duration_ms,
      avg_duration_ms: entries.length > 0 ? Math.round(total_duration_ms / entries.length) : 0,
    })
  }
  by_agent.sort((a, b) => b.total_tokens - a.total_tokens)

  // Aggregate by phase
  const phaseMap = new Map<string, MetricEntry[]>()
  for (const entry of db.entries) {
    const list = phaseMap.get(entry.phase) || []
    list.push(entry)
    phaseMap.set(entry.phase, list)
  }

  const by_phase: PhaseSummary[] = []
  for (const [phase, entries] of phaseMap) {
    const tokens = sumTokens(entries)
    const agents = [...new Set(entries.map((e) => e.agent))]
    by_phase.push({
      phase,
      phase_name: PHASE_NAMES[phase as PhaseId] ?? (phase === "-1" ? "Pre-workflow" : `Phase ${phase}`),
      agents,
      tokens,
      total_tokens: entries.reduce((s, e) => s + e.total_tokens, 0),
      total_cost: entries.reduce((s, e) => s + e.cost, 0),
      total_duration_ms: entries.reduce((s, e) => s + e.duration_ms, 0),
      message_count: entries.length,
    })
  }
  // Sort by PHASE_IDS order; unknown phases go last
  const phaseOrder = new Map(PHASE_IDS.map((id, i) => [id, i]))
  by_phase.sort((a, b) => (phaseOrder.get(a.phase as PhaseId) ?? 999) - (phaseOrder.get(b.phase as PhaseId) ?? 999))

  // Grand totals
  const totals = {
    total_tokens: db.entries.reduce((s, e) => s + e.total_tokens, 0),
    total_cost: db.entries.reduce((s, e) => s + e.cost, 0),
    total_duration_ms: db.entries.reduce((s, e) => s + e.duration_ms, 0),
    total_messages: db.entries.length,
  }

  return {
    entries: db.entries,
    by_agent,
    by_phase,
    totals,
    updated_at: new Date().toISOString(),
  }
}

/** Sum token fields across multiple entries */
function sumTokens(entries: MetricEntry[]): TokenMetrics {
  return {
    input: entries.reduce((s, e) => s + e.tokens.input, 0),
    output: entries.reduce((s, e) => s + e.tokens.output, 0),
    reasoning: entries.reduce((s, e) => s + e.tokens.reasoning, 0),
    cache_read: entries.reduce((s, e) => s + e.tokens.cache_read, 0),
    cache_write: entries.reduce((s, e) => s + e.tokens.cache_write, 0),
  }
}
