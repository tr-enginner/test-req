import { createHash } from "crypto"
import { canBusAdapter } from "./can-adapter"
import { genericBusAdapter } from "./generic-adapter"
import { mil1553BusAdapter, rs422BusAdapter, uartBusAdapter } from "./passthrough-adapters"
import { spaceWireBusAdapter } from "./spacewire-adapter"
import { spiBusAdapter } from "./spi-adapter"
import type {
  CaseStepDataGenerationPlan,
  DtpProtocolDefinition,
  DtpProtocolFieldLayout,
  PacketFieldValuePlan,
  StepDataQualityIssue,
} from "../dtp-data-generation-core"
import type {
  DtpBusAdapter,
  DtpBusInterfaceConstraint,
  DtpBusType,
  DtpModelFallbackClassification,
  DtpModelFallbackPolicy,
  DtpModelFallbackProfileRegistry,
  DtpModelFallbackProfileSelection,
  DtpRenderedBusFrame,
  DtpTransportEncodingResult,
  DtpTransportInspectionResult,
} from "./types"
import type { FlowDirection } from "../dtp-data-generation-core"

const ADAPTERS: readonly DtpBusAdapter[] = [
  canBusAdapter,
  spiBusAdapter,
  spaceWireBusAdapter,
  rs422BusAdapter,
  uartBusAdapter,
  mil1553BusAdapter,
  genericBusAdapter,
]

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]))
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")
}

export function listDtpBusAdapters(): readonly DtpBusAdapter[] {
  return ADAPTERS
}

export function resolveDtpBusAdapter(busType: DtpBusType | string | undefined): DtpBusAdapter {
  if (!busType) return genericBusAdapter
  const normalized = busType.replace(/\s+/g, "").toLowerCase()
  return ADAPTERS.find((adapter) => adapter.busType.toLowerCase() === normalized || adapter.aliases.some(
    (alias) => alias.replace(/\s+/g, "").toLowerCase() === normalized,
  )) ?? genericBusAdapter
}

export function detectDtpBusType(text: string): DtpBusType | undefined {
  return ADAPTERS.find((adapter) => adapter.matchesEvidence?.(text))?.busType
}

export function classifyDtpBusInterface(
  busType: DtpBusType | string | undefined,
  text: string,
): DtpBusInterfaceConstraint {
  return resolveDtpBusAdapter(busType).classifyInterface?.(text) ?? { source: "unresolved" }
}

export function resolveDtpBusFlowConstraint(
  busType: DtpBusType | string | undefined,
  stepText: string,
): { handled: boolean; flow?: FlowDirection } {
  return resolveDtpBusAdapter(busType).resolveFlowConstraint?.(stepText) ?? { handled: false }
}

export function dtpBusSelectorValuesEquivalent(
  busType: DtpBusType | string | undefined,
  context: Parameters<NonNullable<DtpBusAdapter["selectorValuesEquivalent"]>>[0],
): boolean {
  return resolveDtpBusAdapter(busType).selectorValuesEquivalent?.(context) ?? false
}

export function dtpBusProtocolEntityConflicts(
  protocol: DtpProtocolDefinition,
  normalizedStepText: string,
): boolean {
  return resolveDtpBusAdapter(protocol.bus_context?.bus_type).protocolEntityConflicts?.(
    protocol,
    normalizedStepText,
  ) ?? false
}

export function allowDtpBusCommandDictionaryDefault(
  protocol: DtpProtocolDefinition,
  stepText: string,
): boolean {
  return resolveDtpBusAdapter(protocol.bus_context?.bus_type).allowCommandDictionaryDefault?.(
    protocol,
    stepText,
  ) ?? false
}

export function resolveDtpBusFieldOption(
  protocol: DtpProtocolDefinition | undefined,
  field: DtpProtocolFieldLayout,
  semanticText: string,
) {
  return resolveDtpBusAdapter(protocol?.bus_context?.bus_type).resolveFieldOption?.(field, semanticText)
}

export function documentedDtpBusFieldPlans(
  protocol: DtpProtocolDefinition | undefined,
  semanticText: string,
): PacketFieldValuePlan[] {
  return resolveDtpBusAdapter(protocol?.bus_context?.bus_type).documentedDefaultFieldPlans?.(protocol, semanticText) ?? []
}

export function normalizeDtpBusFrameLayout(
  protocol: DtpProtocolDefinition,
  layout: string[],
): { layout: string[]; warnings: string[] } {
  return resolveDtpBusAdapter(protocol.bus_context?.bus_type).normalizeFrameLayout?.(protocol, layout) ?? {
    layout,
    warnings: [],
  }
}

export function encodeDtpBusTransport(
  frames: DtpRenderedBusFrame[],
  protocol: DtpProtocolDefinition | undefined,
): DtpTransportEncodingResult {
  const adapter = resolveDtpBusAdapter(protocol?.bus_context?.bus_type)
  return (adapter.encodeTransport ?? genericBusAdapter.encodeTransport!)(frames, protocol)
}

export function inspectDtpBusTransport(
  rawLines: string[][],
  protocol: DtpProtocolDefinition,
  renderedCanonicalFrameIndices: number[],
): DtpTransportInspectionResult {
  return resolveDtpBusAdapter(protocol.bus_context?.bus_type).inspectTransport?.(
    rawLines,
    protocol,
    renderedCanonicalFrameIndices,
  ) ?? { payloadLines: rawLines, issues: [] }
}

export function validateDtpBusCasePlan(
  protocol: DtpProtocolDefinition | undefined,
  stepText: string,
  plan: CaseStepDataGenerationPlan,
  busConstraint: DtpBusType,
): StepDataQualityIssue[] {
  return resolveDtpBusAdapter(protocol?.bus_context?.bus_type ?? busConstraint).validateCasePlan?.({
    protocol,
    stepText,
    plan,
    busConstraint,
  }) ?? []
}

export function validateDtpBusGeneratedLines(
  protocol: DtpProtocolDefinition,
  lines: string[][],
  plan: CaseStepDataGenerationPlan,
): StepDataQualityIssue[] {
  return resolveDtpBusAdapter(protocol.bus_context?.bus_type).validateGeneratedLines?.({ protocol, lines, plan }) ?? []
}

export function applyDtpBusBlockFrameChecksums(
  bytes: string[],
  protocol: DtpProtocolDefinition,
): { bytes: string[]; warnings: string[] } {
  return resolveDtpBusAdapter(protocol.bus_context?.bus_type).applyBlockFrameChecksums?.(bytes, protocol) ?? {
    bytes: bytes.slice(),
    warnings: [],
  }
}

export function createDtpModelFallbackProfileRegistry(): DtpModelFallbackProfileRegistry {
  const profiles = ADAPTERS.flatMap((adapter) => [...adapter.fallbackPolicies])
  return {
    schema_version: "1.0.0",
    source: "builtin",
    config_path: "builtin://dtp-bus-adapters",
    registry_hash: hashValue(profiles),
    profiles,
    profile_sources: Object.fromEntries(profiles.map((profile) => [profile.id, "builtin" as const])),
    warnings: [],
  }
}

function profileSpecificity(profile: DtpModelFallbackPolicy): number {
  return Object.values(profile.match).filter((value) => value !== undefined && value !== "unknown").length
}

function profileMatches(profile: DtpModelFallbackPolicy, classification: DtpModelFallbackClassification): boolean {
  return Object.entries(profile.match).every(([key, value]) => (
    value === undefined || value === classification[key as keyof DtpModelFallbackClassification]
  ))
}

export function selectDtpModelFallbackPolicy(
  registry: DtpModelFallbackProfileRegistry,
  classification: DtpModelFallbackClassification,
): DtpModelFallbackProfileSelection {
  const selected = registry.profiles
    .filter((profile) => profileMatches(profile, classification))
    .sort((left, right) => profileSpecificity(right) - profileSpecificity(left) || right.priority - left.priority)[0] ??
    genericBusAdapter.fallbackPolicies[0]
  return {
    profile_id: selected.id,
    profile_version: selected.version,
    source: "builtin",
    registry_hash: registry.registry_hash,
    profile_hash: hashValue(selected),
    classification,
    instructions: [...selected.instructions],
    required_evidence: [...selected.required_evidence],
    max_candidates: selected.max_candidates,
    context_budget_chars: selected.context_budget_chars,
    relation_depth: selected.relation_depth,
    missing_evidence_policy: selected.missing_evidence_policy,
  }
}
