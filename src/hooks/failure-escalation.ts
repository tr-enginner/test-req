import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { ARTIFACT_PATHS, MAX_FAILURES_BEFORE_ESCALATION, PHASE_NAMES, type PhaseId } from "../shared/constants"
import type { ProgressState } from "../shared/phase-state"
import { withFileLock } from "../shared/file-mutex"

/**
 * failure-escalation hook — Detects consecutive failures and escalates to Oracle.
 * Monitors chat messages for error patterns and tracks failure counts.
 */
export function createFailureEscalationHook(directory: string) {
  return {
    "chat.message": async (
      input: { sessionID: string; agent?: string },
      output: { message: any; parts: any[] },
    ) => {
      // Check for failure indicators in the message
      const messageText = output.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n")

      const hasFailure =
        /\b(error|failed|failure|exception|cannot|unable to|blocked)\b/i.test(
          messageText,
        ) &&
        !/\b(fixed|resolved|succeeded|passed)\b/i.test(messageText)

      if (!hasFailure) return

      const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)
      if (!existsSync(progressPath)) return

      try {
        const escalationMsg = await withFileLock(progressPath, () => {
          const raw = readFileSync(progressPath, "utf-8")
          const progress: ProgressState = JSON.parse(raw)

          // Find the first in_progress phase to attribute the failure to
          const inProgressPhases = Object.entries(progress.phases)
            .filter(([, state]) => state.status === "in_progress")
            .map(([id]) => id as PhaseId)

          if (inProgressPhases.length === 0) return null

          const targetPhase = inProgressPhases[0]
          const phaseState = progress.phases[targetPhase]

          if (!phaseState) return null

          // Increment failure count
          phaseState.failure_count++
          progress.updated_at = new Date().toISOString()
          writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf-8")

          if (phaseState.failure_count >= MAX_FAILURES_BEFORE_ESCALATION) {
            const phaseName = PHASE_NAMES[targetPhase] || targetPhase
            return (
              `\n\n---\n` +
              `**[ESCALATION]** Phase ${targetPhase} (${phaseName}) has failed ` +
              `${phaseState.failure_count} consecutive times (threshold: ${MAX_FAILURES_BEFORE_ESCALATION}). ` +
              `**Automatically escalating to Oracle** for technical consultation.\n\n` +
              `Delegate to the **oracle** agent with context:\n` +
              `- Current phase: ${phaseName}\n` +
              `- Failure count: ${phaseState.failure_count}\n` +
              `- Ask Oracle for alternative strategy or root cause analysis.\n`
            )
          }
          return null
        })

        if (escalationMsg) {
          output.parts = [
            ...output.parts,
            { type: "text", text: escalationMsg },
          ]
        }
      } catch {
        // Silently ignore
      }
    },
  }
}
