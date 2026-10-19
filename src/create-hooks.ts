import type { MatrixConfig } from "./config/schema"
import { createPhaseGateHook } from "./hooks/phase-gate"
import { createReviewEnforcerHook } from "./hooks/review-enforcer"
import { createEvidenceTrackerHook } from "./hooks/evidence-tracker"
import { createTraceabilityInjectorHook } from "./hooks/traceability-injector"
import { createArtifactValidatorHook } from "./hooks/artifact-validator"
import { createContextPreloaderHook } from "./hooks/context-preloader"
import { createFailureEscalationHook } from "./hooks/failure-escalation"
import { createProgressTrackerHook } from "./hooks/progress-tracker"
import { createSchemaValidatorHook } from "./hooks/schema-validator"
import { createMetricsTrackerHook } from "./hooks/metrics-tracker"
import { createModelCompatHook } from "./hooks/model-compat"
import { createWikiBottomUpEnforcerHook } from "./hooks/wiki-bottom-up-enforcer"
import { createPhase6StructuredReadGuardHook } from "./hooks/phase6-structured-read-guard"

/** Hook name constants */
const HOOK_NAMES = {
  PHASE_GATE: "phase-gate",
  REVIEW_ENFORCER: "review-enforcer",
  EVIDENCE_TRACKER: "evidence-tracker",
  TRACEABILITY_INJECTOR: "traceability-injector",
  ARTIFACT_VALIDATOR: "artifact-validator",
  CONTEXT_PRELOADER: "context-preloader",
  FAILURE_ESCALATION: "failure-escalation",
  PROGRESS_TRACKER: "progress-tracker",
  SCHEMA_VALIDATOR: "schema-validator",
  METRICS_TRACKER: "metrics-tracker",
  MODEL_COMPAT: "model-compat",
  WIKI_BOTTOM_UP_ENFORCER: "wiki-bottom-up-enforcer",
  PHASE6_STRUCTURED_READ_GUARD: "phase6-structured-read-guard",
} as const

/**
 * Create all hooks for the plugin.
 * Returns named hook instances, each containing their relevant hook handlers.
 */
export function createHooks(directory: string, pluginConfig: MatrixConfig) {
  const disabledHooks = new Set(pluginConfig.disabled_hooks)

  function isEnabled(name: string) {
    return !disabledHooks.has(name)
  }

  return {
    phaseGate: isEnabled(HOOK_NAMES.PHASE_GATE)
      ? createPhaseGateHook(directory)
      : null,
    reviewEnforcer: isEnabled(HOOK_NAMES.REVIEW_ENFORCER)
      ? createReviewEnforcerHook(directory)
      : null,
    evidenceTracker: isEnabled(HOOK_NAMES.EVIDENCE_TRACKER)
      ? createEvidenceTrackerHook(directory)
      : null,
    traceabilityInjector: isEnabled(HOOK_NAMES.TRACEABILITY_INJECTOR)
      ? createTraceabilityInjectorHook(directory)
      : null,
    artifactValidator: isEnabled(HOOK_NAMES.ARTIFACT_VALIDATOR)
      ? createArtifactValidatorHook(directory)
      : null,
    contextPreloader: isEnabled(HOOK_NAMES.CONTEXT_PRELOADER)
      ? createContextPreloaderHook(directory)
      : null,
    failureEscalation: isEnabled(HOOK_NAMES.FAILURE_ESCALATION)
      ? createFailureEscalationHook(directory)
      : null,
    progressTracker: isEnabled(HOOK_NAMES.PROGRESS_TRACKER)
      ? createProgressTrackerHook(directory)
      : null,
    schemaValidator: isEnabled(HOOK_NAMES.SCHEMA_VALIDATOR)
      ? createSchemaValidatorHook(directory)
      : null,
    metricsTracker: isEnabled(HOOK_NAMES.METRICS_TRACKER)
      ? createMetricsTrackerHook(directory)
      : null,
    modelCompat: isEnabled(HOOK_NAMES.MODEL_COMPAT)
      ? createModelCompatHook(pluginConfig)
      : null,
    wikiBottomUpEnforcer: isEnabled(HOOK_NAMES.WIKI_BOTTOM_UP_ENFORCER)
      ? createWikiBottomUpEnforcerHook(directory)
      : null,
    phase6StructuredReadGuard: isEnabled(HOOK_NAMES.PHASE6_STRUCTURED_READ_GUARD)
      ? createPhase6StructuredReadGuardHook(directory)
      : null,
  }
}

export type MatrixHooks = ReturnType<typeof createHooks>
