import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { ARTIFACT_PATHS } from "../shared/constants"
import { withFileLock } from "../shared/file-mutex"

type PageCategory = "suspected_defect" | "suspected_fp"
type PageStatus = "pending" | "running" | "succeeded" | "failed"

interface WavePageInput {
  category: PageCategory
  offset: number
  limit: number
}

interface WavePageState extends WavePageInput {
  lease_version: number
  status: PageStatus
  attempts: number
  last_claimed_at?: string
  completed_at?: string
  note?: string
}

interface WaveState {
  wave_id: string
  status: "active" | "completed"
  created_at: string
  updated_at: string
  pages: Record<string, WavePageState>
}

interface WaveDatabase {
  waves: Record<string, WaveState>
}

function resolveArtifactPath(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildPageKey(category: PageCategory, offset: number): string {
  return `${category}:${offset}`
}

function ensureWaveDb(filePath: string): WaveDatabase {
  if (!existsSync(filePath)) return { waves: {} }
  try {
    const raw = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<WaveDatabase>
    return {
      waves: parsed.waves ?? {},
    }
  } catch {
    return { waves: {} }
  }
}

function writeWaveDb(filePath: string, db: WaveDatabase): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(db, null, 2), "utf-8")
}

function pageSummary(page: WavePageState) {
  const ageMs = page.last_claimed_at
    ? Math.max(0, Date.now() - Date.parse(page.last_claimed_at))
    : null

  return {
    category: page.category,
    offset: page.offset,
    limit: page.limit,
    status: page.status,
    lease_version: page.lease_version,
    attempts: page.attempts,
    last_claimed_at: page.last_claimed_at ?? null,
    completed_at: page.completed_at ?? null,
    age_ms: ageMs,
    note: page.note ?? null,
  }
}

function isStalled(page: WavePageState, staleAfterMs?: number): boolean {
  if (staleAfterMs === undefined || page.status !== "running" || !page.last_claimed_at) {
    return false
  }
  return Date.now() - Date.parse(page.last_claimed_at) >= staleAfterMs
}

function summarizeWave(wave: WaveState, staleAfterMs?: number) {
  const pending_pages: Array<ReturnType<typeof pageSummary>> = []
  const running_pages: Array<ReturnType<typeof pageSummary>> = []
  const succeeded_pages: Array<ReturnType<typeof pageSummary>> = []
  const failed_pages: Array<ReturnType<typeof pageSummary>> = []
  const stalled_pages: Array<ReturnType<typeof pageSummary>> = []

  for (const page of Object.values(wave.pages)) {
    if (page.status === "pending") pending_pages.push(pageSummary(page))
    else if (page.status === "running") {
      const summary = pageSummary(page)
      running_pages.push(summary)
      if (isStalled(page, staleAfterMs)) stalled_pages.push(summary)
    }
    else if (page.status === "succeeded") succeeded_pages.push(pageSummary(page))
    else if (page.status === "failed") failed_pages.push(pageSummary(page))
  }

  return {
    total_pages: Object.keys(wave.pages).length,
    pending_pages,
    running_pages,
    succeeded_pages,
    failed_pages,
    stalled_pages,
  }
}

function refreshWaveStatus(wave: WaveState): void {
  wave.status = Object.values(wave.pages).every((page) => page.status === "succeeded")
    ? "completed"
    : "active"
  wave.updated_at = new Date().toISOString()
}

function cloneWave(wave: WaveState): WaveState {
  return JSON.parse(JSON.stringify(wave)) as WaveState
}

function snapshotResult(wave: WaveState, staleAfterMs?: number) {
  const summary = summarizeWave(wave, staleAfterMs)
  const status = summary.succeeded_pages.length === summary.total_pages
    ? "completed"
    : summary.failed_pages.length > 0
      ? "failed"
      : "active"

  return {
    status,
    wave_id: wave.wave_id,
    total: summary.total_pages,
    pending: summary.pending_pages.length,
    running: summary.running_pages.length,
    succeeded: summary.succeeded_pages.length,
    failed: summary.failed_pages.length,
    stalled: summary.stalled_pages.length,
  }
}

function orderedPendingPages(wave: WaveState): WavePageState[] {
  const categoryRank: Record<PageCategory, number> = {
    suspected_defect: 0,
    suspected_fp: 1,
  }

  return Object.values(wave.pages)
    .filter((page) => page.status === "pending")
    .sort((a, b) =>
      (b.lease_version - a.lease_version) ||
      (b.attempts - a.attempts) ||
      (categoryRank[a.category] - categoryRank[b.category]) ||
      (a.offset - b.offset),
    )
}

const pageSchema = tool.schema.object({
  category: tool.schema
    .enum(["suspected_defect", "suspected_fp"])
    .describe("Page category"),
  offset: tool.schema.number().describe("0-based offset within the category"),
  limit: tool.schema.number().describe("Page size"),
})

const targetSchema = tool.schema.object({
  category: tool.schema
    .enum(["suspected_defect", "suspected_fp"])
    .describe("Page category"),
  offset: tool.schema.number().describe("0-based offset within the category"),
})

/**
 * sa_wave_guard — Track SA-reviewer page-wave progress with timeout-aware orchestration.
 *
 * Used by the SA-Reviewer orchestrator to avoid hanging forever on background page
 * workers. The orchestrator starts a wave, page workers claim/complete their pages,
 * and the orchestrator awaits completion with a hard timeout before retrying any
 * unfinished pages synchronously.
 */
export const saWaveGuard: ToolDefinition = tool({
  description:
    "Track static-analysis review dispatch state and page-worker progress. " +
    "Primary action: await_and_lease — blocks until free slots are available, auto-requeues " +
    "stalled/failed pages, and returns leased pages ready for dispatch. " +
    "Also supports: start_wave, snapshot, lease_pages, claim_page, complete_page, requeue_pages.",
  args: {
    action: tool.schema
      .enum(["start_wave", "await_and_lease", "snapshot", "lease_pages", "claim_page", "complete_page", "requeue_pages"])
      .describe("Wave-guard action to execute"),
    wave_id: tool.schema
      .string()
      .describe("Wave identifier, e.g. sa-wave-001"),
    pages: tool.schema
      .array(pageSchema)
      .optional()
      .describe("Pages belonging to a new wave (start_wave only). Prefer sd_total/fp_total/page_size instead to avoid output token bloat."),
    sd_total: tool.schema
      .number()
      .optional()
      .describe("Total suspected_defect findings count (start_wave). Tool generates pages internally."),
    fp_total: tool.schema
      .number()
      .optional()
      .describe("Total suspected_fp findings count (start_wave). Tool generates pages internally."),
    page_size: tool.schema
      .number()
      .optional()
      .describe("Page size for auto-generated pages (start_wave, default 10)."),
    targets: tool.schema
      .array(targetSchema)
      .optional()
      .describe("Pages to requeue after timeout/failure (requeue_pages only)"),
    count: tool.schema
      .number()
      .optional()
      .describe("How many pending pages to lease for dispatch (lease_pages only)"),
    category: tool.schema
      .enum(["suspected_defect", "suspected_fp"])
      .optional()
      .describe("Page category (claim_page / complete_page)"),
    offset: tool.schema
      .number()
      .optional()
      .describe("Page offset (claim_page / complete_page)"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Page size (optional context for claim_page / complete_page)"),
    lease_version: tool.schema
      .number()
      .optional()
      .describe("Expected lease version for the page claim/complete"),
    outcome: tool.schema
      .enum(["succeeded", "failed"])
      .optional()
      .describe("Completion outcome (complete_page only)"),
    note: tool.schema
      .string()
      .optional()
      .describe("Optional note stored on the page state"),
    max_concurrency: tool.schema
      .number()
      .optional()
      .describe("Max concurrent running pages for await_and_lease (default: 8)"),
    max_attempts: tool.schema
      .number()
      .optional()
      .describe("Max retry attempts per page before marking permanently failed in await_and_lease (default: 2)"),
    timeout_ms: tool.schema
      .number()
      .optional()
      .describe("Maximum time to wait in await_and_lease (default: 120000)"),
    stale_after_ms: tool.schema
      .number()
      .optional()
      .describe("Mark running pages as stalled once they exceed this age (optional)"),
  },
  async execute(args) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.SA_REVIEW_WAVES)

    if (args.action === "start_wave") {
      // Prefer count-based generation (sd_total/fp_total/page_size) to avoid
      // output token bloat from LLM enumerating thousands of page objects.
      // Falls back to explicit pages[] array for backward compatibility.
      let pages: WavePageInput[]
      if (args.sd_total !== undefined || args.fp_total !== undefined) {
        const sdTotal = (args.sd_total as number | undefined) ?? 0
        const fpTotal = (args.fp_total as number | undefined) ?? 0
        const pageSize = (args.page_size as number | undefined) ?? 10
        pages = []
        for (let offset = 0; offset < sdTotal; offset += pageSize) {
          pages.push({ category: "suspected_defect", offset, limit: pageSize })
        }
        for (let offset = 0; offset < fpTotal; offset += pageSize) {
          pages.push({ category: "suspected_fp", offset, limit: pageSize })
        }
      } else {
        pages = (args.pages ?? []) as WavePageInput[]
      }
      if (pages.length === 0) {
        return JSON.stringify({ error: "start_wave requires sd_total/fp_total or at least one page in pages[]" })
      }

      const result = await withFileLock(filePath, () => {
        const db = ensureWaveDb(filePath)
        const now = new Date().toISOString()
        const wave: WaveState = {
          wave_id: args.wave_id,
          status: "active",
          created_at: now,
          updated_at: now,
          pages: {},
        }

        for (const page of pages) {
          const key = buildPageKey(page.category, page.offset)
          wave.pages[key] = {
            ...page,
            lease_version: 0,
            status: "pending",
            attempts: 0,
          }
        }

        db.waves[args.wave_id] = wave
        writeWaveDb(filePath, db)

        const s = summarizeWave(wave)
        return {
          status: "wave_started",
          wave_id: args.wave_id,
          total: s.total_pages,
          pending: s.pending_pages.length,
          running: s.running_pages.length,
          succeeded: s.succeeded_pages.length,
          failed: s.failed_pages.length,
        }
      })

      return JSON.stringify(result)
    }

    if (args.action === "snapshot") {
      const result = await withFileLock(filePath, () => {
        const db = ensureWaveDb(filePath)
        const wave = db.waves[args.wave_id]
        if (!wave) return { error: `Wave not found: ${args.wave_id}` }
        return snapshotResult(cloneWave(wave), args.stale_after_ms)
      })

      return JSON.stringify(result)
    }

    if (args.action === "lease_pages") {
      const count = Math.max(0, Math.floor(args.count ?? 0))
      if (count <= 0) {
        return JSON.stringify({ error: "lease_pages requires count > 0" })
      }

      const result = await withFileLock(filePath, () => {
        const db = ensureWaveDb(filePath)
        const wave = db.waves[args.wave_id]
        if (!wave) return { error: `Wave not found: ${args.wave_id}` }

        const now = new Date().toISOString()
        // lease_version is NOT incremented here — it is a generation counter
        // for requeues only. A fresh lease keeps version 0; requeue bumps it
        // so stale workers from a previous lease are rejected on complete_page.
        const leased_pages = orderedPendingPages(wave)
          .slice(0, count)
          .map((page) => {
            page.status = "running"
            page.attempts += 1
            page.last_claimed_at = now
            if (args.note) page.note = args.note
            return pageSummary(page)
          })

        refreshWaveStatus(wave)
        writeWaveDb(filePath, db)

        const s = summarizeWave(wave, args.stale_after_ms)
        return {
          status: "leased",
          wave_id: args.wave_id,
          leased_pages,
          summary: {
            total: s.total_pages,
            pending: s.pending_pages.length,
            running: s.running_pages.length,
            succeeded: s.succeeded_pages.length,
            failed: s.failed_pages.length,
          },
        }
      })

      return JSON.stringify(result)
    }

    if (args.action === "claim_page") {
      if (args.category === undefined || args.offset === undefined || args.lease_version === undefined) {
        return JSON.stringify({ error: "claim_page requires category, offset, and lease_version" })
      }

      const category = args.category as PageCategory
      const offset = args.offset
      const leaseVersion = args.lease_version

      const result = await withFileLock(filePath, () => {
        const db = ensureWaveDb(filePath)
        const wave = db.waves[args.wave_id]
        if (!wave) return { error: `Wave not found: ${args.wave_id}` }

        const key = buildPageKey(category, offset)
        const page = wave.pages[key]
        if (!page) return { error: `Page not found in wave ${args.wave_id}: ${key}` }
        if (page.lease_version !== leaseVersion) {
          return {
            ok: false,
            code: "stale_lease",
            wave_id: args.wave_id,
            page: pageSummary(page),
            current_lease_version: page.lease_version,
          }
        }
        if (page.status === "succeeded") {
          return {
            ok: false,
            code: "already_completed",
            wave_id: args.wave_id,
            page: pageSummary(page),
          }
        }

        if (page.status !== "running") {
          page.attempts += 1
        }
        page.status = "running"
        page.last_claimed_at = new Date().toISOString()
        if (args.limit !== undefined) page.limit = args.limit
        if (args.note) page.note = args.note
        refreshWaveStatus(wave)
        writeWaveDb(filePath, db)

        return {
          ok: true,
          status: "claimed",
          wave_id: args.wave_id,
          page: pageSummary(page),
        }
      })

      return JSON.stringify(result)
    }

    if (args.action === "complete_page") {
      if (
        args.category === undefined ||
        args.offset === undefined ||
        args.lease_version === undefined ||
        args.outcome === undefined
      ) {
        return JSON.stringify({
          error: "complete_page requires category, offset, lease_version, and outcome",
        })
      }

      const category = args.category as PageCategory
      const offset = args.offset
      const leaseVersion = args.lease_version
      const outcome = args.outcome as "succeeded" | "failed"

      const result = await withFileLock(filePath, () => {
        const db = ensureWaveDb(filePath)
        const wave = db.waves[args.wave_id]
        if (!wave) return { error: `Wave not found: ${args.wave_id}` }

        const key = buildPageKey(category, offset)
        const page = wave.pages[key]
        if (!page) return { error: `Page not found in wave ${args.wave_id}: ${key}` }
        if (page.lease_version !== leaseVersion) {
          return {
            ok: false,
            code: "stale_lease",
            wave_id: args.wave_id,
            page: pageSummary(page),
            current_lease_version: page.lease_version,
          }
        }

        page.status = outcome
        page.completed_at = new Date().toISOString()
        if (args.note) page.note = args.note
        refreshWaveStatus(wave)
        writeWaveDb(filePath, db)

        const s = summarizeWave(wave)
        return {
          ok: true,
          status: outcome,
          wave_id: args.wave_id,
          page: pageSummary(page),
          wave_status: wave.status,
          summary: {
            total: s.total_pages,
            pending: s.pending_pages.length,
            running: s.running_pages.length,
            succeeded: s.succeeded_pages.length,
            failed: s.failed_pages.length,
          },
        }
      })

      return JSON.stringify(result)
    }

    if (args.action === "requeue_pages") {
      const targets = (args.targets ?? []) as Array<{ category: PageCategory; offset: number }>
      if (targets.length === 0) {
        return JSON.stringify({ error: "requeue_pages requires at least one target in targets[]" })
      }

      const result = await withFileLock(filePath, () => {
        const db = ensureWaveDb(filePath)
        const wave = db.waves[args.wave_id]
        if (!wave) return { error: `Wave not found: ${args.wave_id}` }

        const requeued_pages: Array<ReturnType<typeof pageSummary>> = []
        const skipped_pages: Array<ReturnType<typeof pageSummary>> = []

        for (const target of targets) {
          const key = buildPageKey(target.category, target.offset)
          const page = wave.pages[key]
          if (!page) continue

          if (page.status === "succeeded") {
            skipped_pages.push(pageSummary(page))
            continue
          }

          page.lease_version += 1
          page.status = "pending"
          page.completed_at = undefined
          page.last_claimed_at = undefined
          if (args.note) page.note = args.note
          requeued_pages.push(pageSummary(page))
        }

        refreshWaveStatus(wave)
        writeWaveDb(filePath, db)

        const s = summarizeWave(wave)
        return {
          status: "requeued",
          wave_id: args.wave_id,
          requeued_pages,
          skipped_pages,
          summary: {
            total: s.total_pages,
            pending: s.pending_pages.length,
            running: s.running_pages.length,
            succeeded: s.succeeded_pages.length,
            failed: s.failed_pages.length,
          },
        }
      })

      return JSON.stringify(result)
    }

    // ─── AWAIT_AND_LEASE ──────────────────────────────────────────────────
    // Blocks until free slots are available, auto-requeues stale/failed pages,
    // leases pending pages, and returns them for dispatch. The LLM only needs
    // to call this in a simple linear loop.
    if (args.action === "await_and_lease") {
      const maxConcurrency = Math.max(1, args.max_concurrency ?? 8)
      const maxAttempts = Math.max(1, args.max_attempts ?? 2)
      const staleAfterMs = args.stale_after_ms ?? 300_000
      const awaitTimeout = Math.max(5_000, args.timeout_ms ?? 120_000)
      const pollInterval = 2_000
      const staleCheckInterval = 5 // only run stale/failed requeue every Nth iteration
      const deadline = Date.now() + awaitTimeout
      let pollCount = 0

      while (Date.now() < deadline) {
        const result = await withFileLock(filePath, () => {
          const db = ensureWaveDb(filePath)
          const wave = db.waves[args.wave_id]
          if (!wave) return { error: `Wave not found: ${args.wave_id}` } as const

          const now = new Date().toISOString()
          let dirty = false

          // Auto-requeue stalled/failed pages only every Nth poll to reduce I/O
          if (pollCount % staleCheckInterval === 0) {
            for (const page of Object.values(wave.pages)) {
              if (page.status === "running" && isStalled(page, staleAfterMs)) {
                if (page.attempts < maxAttempts) {
                  page.lease_version += 1
                  page.status = "pending"
                  page.completed_at = undefined
                  page.last_claimed_at = undefined
                  page.note = `auto-requeued: stalled after ${staleAfterMs}ms (attempt ${page.attempts})`
                } else {
                  page.status = "failed"
                  page.completed_at = now
                  page.note = `permanently failed: stalled after ${maxAttempts} attempts`
                }
                dirty = true
              }
            }

            for (const page of Object.values(wave.pages)) {
              if (page.status === "failed" && page.attempts < maxAttempts) {
                page.lease_version += 1
                page.status = "pending"
                page.completed_at = undefined
                page.last_claimed_at = undefined
                page.note = `auto-requeued: retry after failure (attempt ${page.attempts})`
                dirty = true
              }
            }
          }

          // Check completion: all pages are succeeded or permanently failed
          const allDone = Object.values(wave.pages).every(
            (p) => p.status === "succeeded" || (p.status === "failed" && p.attempts >= maxAttempts),
          )
          if (allDone) {
            refreshWaveStatus(wave)
            if (dirty || wave.status === "completed") writeWaveDb(filePath, db)
            const summary = summarizeWave(wave, staleAfterMs)
            return {
              done: true as const,
              result: {
                status: "completed" as const,
                wave_id: args.wave_id,
                leased_pages: [] as Array<ReturnType<typeof pageSummary>>,
                summary: {
                  total: summary.total_pages,
                  pending: summary.pending_pages.length,
                  running: summary.running_pages.length,
                  succeeded: summary.succeeded_pages.length,
                  failed: summary.failed_pages.length,
                },
              },
            }
          }

          // Calculate free slots
          const runningCount = Object.values(wave.pages).filter((p) => p.status === "running").length
          const freeSlots = maxConcurrency - runningCount
          const pendingPages = orderedPendingPages(wave)

          if (freeSlots > 0 && pendingPages.length > 0) {
            // Lease pages — lease_version unchanged (see comment in lease_pages)
            const toLeaseCount = Math.min(freeSlots, pendingPages.length)
            const leased = pendingPages.slice(0, toLeaseCount).map((page) => {
              page.status = "running"
              page.attempts += 1
              page.last_claimed_at = now
              return pageSummary(page)
            })

            refreshWaveStatus(wave)
            writeWaveDb(filePath, db)

            const summary = summarizeWave(wave, staleAfterMs)
            return {
              done: true as const,
              result: {
                status: "pages_ready" as const,
                wave_id: args.wave_id,
                leased_pages: leased,
                summary: {
                  total: summary.total_pages,
                  pending: summary.pending_pages.length,
                  running: summary.running_pages.length,
                  succeeded: summary.succeeded_pages.length,
                  failed: summary.failed_pages.length,
                },
              },
            }
          }

          // No free slots or no pending pages — only write if state changed
          if (dirty) {
            refreshWaveStatus(wave)
            writeWaveDb(filePath, db)
          }
          return { done: false as const }
        })

        if ("error" in result) return JSON.stringify(result)
        if (result.done) return JSON.stringify(result.result)

        // Pool is full, wait for a slot to open
        pollCount += 1
        await sleep(pollInterval)
      }

      // Timeout — return current state
      const finalResult = await withFileLock(filePath, () => {
        const db = ensureWaveDb(filePath)
        const wave = db.waves[args.wave_id]
        if (!wave) return { error: `Wave not found: ${args.wave_id}` }
        const summary = summarizeWave(wave, staleAfterMs)
        return {
          status: "timeout" as const,
          wave_id: args.wave_id,
          leased_pages: [] as Array<ReturnType<typeof pageSummary>>,
          summary: {
            total: summary.total_pages,
            pending: summary.pending_pages.length,
            running: summary.running_pages.length,
            succeeded: summary.succeeded_pages.length,
            failed: summary.failed_pages.length,
          },
        }
      })
      return JSON.stringify(finalResult)
    }

    return JSON.stringify({ error: `Unknown action: ${args.action}` })
  },
})
