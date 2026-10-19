import type {
  CaseStepDataGenerationPlan,
  DtpProtocolDefinition,
  DtpProtocolFieldLayout,
  DtpProtocolSelectorRelation,
  FlowDirection,
  PacketFieldValuePlan,
  StepDataQualityIssue,
} from "../dtp-data-generation-core"

export type DtpBusType = "CAN" | "SPI" | "SpaceWire" | "RS422" | "UART" | "1553B" | "unknown"

export type DtpModelFallbackProtocolFamily =
  | "telemetry"
  | "poll"
  | "response"
  | "command"
  | "data-block"
  | "unknown"

export type DtpModelFallbackClassification = {
  bus_type: DtpBusType
  interface_level: "primary" | "secondary" | "unknown"
  protocol_family: DtpModelFallbackProtocolFamily
  flow_direction: "input" | "output" | "unknown"
}

export type DtpModelFallbackPolicy = {
  id: string
  version: string
  priority: number
  match: Partial<DtpModelFallbackClassification>
  instructions: string[]
  required_evidence: Array<"protocol-definition" | "source-table" | "selector-relation" | "command-dictionary">
  max_candidates: number
  context_budget_chars: number
  relation_depth: number
  missing_evidence_policy: "warn" | "fail"
}

export type DtpModelFallbackProfileRegistry = {
  schema_version: "1.0.0"
  source: "builtin"
  config_path: string
  registry_hash: string
  profiles: DtpModelFallbackPolicy[]
  profile_sources: Record<string, "builtin">
  warnings: string[]
}

export type DtpModelFallbackProfileSelection = {
  profile_id: string
  profile_version: string
  source: "builtin"
  registry_hash: string
  profile_hash: string
  classification: DtpModelFallbackClassification
  instructions: string[]
  required_evidence: DtpModelFallbackPolicy["required_evidence"]
  max_candidates: number
  context_budget_chars: number
  relation_depth: number
  missing_evidence_policy: DtpModelFallbackPolicy["missing_evidence_policy"]
}

export type DtpRenderedBusFrame = {
  canonicalFrameIndex: number
  bytes: string[]
}

export type DtpTransportEncodingResult = {
  lines: string[][]
  frameInformationBytes: string[]
  envelopeBytes: string[]
  warnings: string[]
}

export type DtpTransportInspectionResult = {
  payloadLines: string[][]
  issues: StepDataQualityIssue[]
}

export type DtpFieldOptionResolution = {
  value: string
  source: "step_desc" | "frame-table" | "document_order_default"
}

export type DtpCasePlanValidationContext = {
  protocol?: DtpProtocolDefinition
  stepText: string
  plan: CaseStepDataGenerationPlan
  busConstraint: DtpBusType
}

export type DtpGeneratedLinesValidationContext = {
  protocol: DtpProtocolDefinition
  lines: string[][]
  plan: CaseStepDataGenerationPlan
}

export type DtpBusInterfaceConstraint = {
  level?: "primary" | "secondary"
  interfaceId?: string
  source: "explicit_level" | "interface_id" | "legacy_channel_alias" | "unresolved"
  matchedAlias?: string
}

export type DtpBusFlowConstraint = {
  handled: boolean
  flow?: FlowDirection
}

export type DtpSelectorValueMatchContext = {
  relation: DtpProtocolSelectorRelation
  selectorValue: string
  mappingValue?: string
}

export interface DtpBusAdapter {
  readonly id: string
  readonly busType: DtpBusType
  readonly aliases: readonly string[]
  readonly fallbackPolicies: readonly DtpModelFallbackPolicy[]

  matchesEvidence?(text: string): boolean
  classifyInterface?(text: string): DtpBusInterfaceConstraint
  resolveFlowConstraint?(stepText: string): DtpBusFlowConstraint
  selectorValuesEquivalent?(context: DtpSelectorValueMatchContext): boolean
  protocolEntityConflicts?(protocol: DtpProtocolDefinition, normalizedStepText: string): boolean
  allowCommandDictionaryDefault?(protocol: DtpProtocolDefinition, stepText: string): boolean
  resolveFieldOption?(field: DtpProtocolFieldLayout, semanticText: string): DtpFieldOptionResolution | undefined
  documentedDefaultFieldPlans?(protocol: DtpProtocolDefinition | undefined, semanticText: string): PacketFieldValuePlan[]
  normalizeFrameLayout?(protocol: DtpProtocolDefinition, layout: string[]): { layout: string[]; warnings: string[] }
  encodeTransport?(frames: DtpRenderedBusFrame[], protocol: DtpProtocolDefinition | undefined): DtpTransportEncodingResult
  inspectTransport?(
    rawLines: string[][],
    protocol: DtpProtocolDefinition,
    renderedCanonicalFrameIndices: number[],
  ): DtpTransportInspectionResult
  validateCasePlan?(context: DtpCasePlanValidationContext): StepDataQualityIssue[]
  validateGeneratedLines?(context: DtpGeneratedLinesValidationContext): StepDataQualityIssue[]
  applyBlockFrameChecksums?(bytes: string[], protocol: DtpProtocolDefinition): { bytes: string[]; warnings: string[] }
}
