import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { ARTIFACT_PATHS, REVIEW_REQUIRED_PHASES, PHASE_NAMES, type PhaseId } from "../shared/constants"
import type { ProgressState } from "../shared/phase-state"

/**
 * review-enforcer hook — Forces review for phases that require it.
 * Injects review reminder into chat messages when a reviewable phase completes.
 */
export function createReviewEnforcerHook(directory: string) {
  return {
    "chat.message": async (
      input: { sessionID: string; agent?: string },
      output: { message: any; parts: any[] },
    ) => {
      const progressPath = join(directory, ARTIFACT_PATHS.PROGRESS)
      if (!existsSync(progressPath)) return

      try {
        const raw = readFileSync(progressPath, "utf-8")
        const progress: ProgressState = JSON.parse(raw)

        const isConductor = input.agent === "conductor" || !input.agent

        // Check all review-required phases for pending reviews
        for (const phaseId of REVIEW_REQUIRED_PHASES) {
          const phaseState = progress.phases[phaseId]
          if (phaseState?.status === "review_pending") {
            const phaseName = PHASE_NAMES[phaseId]
            const reviewMsg = isConductor
              ? (
                `\n\n---\n` +
                `**[REVIEW REQUIRED]** Phase ${phaseId} (${phaseName}) has produced a new artifact version and is waiting for review. ` +
                `Before continuing, you MUST delegate to the **reviewer** agent for the quality gate.\n`
              )
              : (
                `\n\n---\n` +
                `**[REVIEW REQUIRED]** Phase ${phaseId} (${phaseName}) is waiting for reviewer quality-gate approval. ` +
                `Do not publish final outputs or continue to downstream phases from this sub-agent.\n`
              )

            output.parts = [
              ...output.parts,
              { type: "text", text: reviewMsg },
            ]
          }
        }

        // Check all phases for revision_needed status
        for (const [phaseId, phaseState] of Object.entries(progress.phases)) {
          if (phaseState?.status === "revision_needed") {
            const phaseName = PHASE_NAMES[phaseId as PhaseId] || phaseId
            const revisionMsg = isConductor
              ? (
                `\n\n---\n` +
                `**[REVISION NEEDED]** Phase ${phaseId} (${phaseName}) review returned REVISE. ` +
                `Re-dispatch the owning phase agent to revise the artifact before proceeding.\n`
              )
              : (
                `\n\n---\n` +
                `**[REVISION NEEDED]** Phase ${phaseId} (${phaseName}) review returned REVISE. ` +
                `This sub-agent should only handle revision work assigned by the upper-level conductor.\n`
              )

            output.parts = [
              ...output.parts,
              { type: "text", text: revisionMsg },
            ]
          }
        }
      } catch {
        // Silently ignore
      }
    },
  }
}
