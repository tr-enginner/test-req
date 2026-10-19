import type { DtpProtocolDefinition } from "../dtp-data-generation-core"
import type {
  DtpBusAdapter,
  DtpRenderedBusFrame,
  DtpTransportEncodingResult,
} from "./types"

function normalizeHexByte(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(?:0x)?([0-9a-f]{1,2})H?$/i)
  return match?.[1]?.toUpperCase().padStart(2, "0")
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export function encodeFixedFrameEnvelope(
  renderedFrames: DtpRenderedBusFrame[],
  protocol: DtpProtocolDefinition | undefined,
): DtpTransportEncodingResult | undefined {
  const envelope = protocol?.frame_envelope
  if (envelope?.type !== "fixed_prefix" || !envelope.applies_per_frame) return undefined

  const prefix = envelope.bytes.map(normalizeHexByte).filter((item): item is string => Boolean(item))
  if (prefix.length !== envelope.bytes.length || !prefix.length) {
    return {
      lines: renderedFrames.map((frame) => frame.bytes),
      frameInformationBytes: [],
      envelopeBytes: [],
      warnings: ["Fixed frame envelope was not applied because its prefix bytes are invalid."],
    }
  }
  const requiredDirection = protocol?.flow_direction === "input"
    ? "send"
    : protocol?.flow_direction === "output"
      ? "receive"
      : undefined
  if (requiredDirection && envelope.directions?.length && !envelope.directions.includes(requiredDirection)) {
    return {
      lines: renderedFrames.map((frame) => frame.bytes),
      frameInformationBytes: [],
      envelopeBytes: [],
      warnings: [`Fixed frame envelope was not applied because it is not documented for ${requiredDirection} traffic.`],
    }
  }
  const invalidBusinessLength = envelope.business_frame_length !== undefined && renderedFrames.some(
    (frame) => frame.bytes.length !== envelope.business_frame_length,
  )
  const invalidWireLength = envelope.wire_frame_length !== undefined && renderedFrames.some(
    (frame) => frame.bytes.length + prefix.length !== envelope.wire_frame_length,
  )
  if (invalidBusinessLength || invalidWireLength) {
    return {
      lines: renderedFrames.map((frame) => frame.bytes),
      frameInformationBytes: [],
      envelopeBytes: [],
      warnings: ["Fixed frame envelope was not applied because the rendered business/wire frame length conflicts with its source evidence."],
    }
  }
  return {
    lines: renderedFrames.map((frame) => [...prefix, ...frame.bytes]),
    frameInformationBytes: [],
    envelopeBytes: prefix,
    warnings: [],
  }
}

export const genericBusAdapter: DtpBusAdapter = {
  id: "generic",
  busType: "unknown",
  aliases: [],
  fallbackPolicies: [{
    id: "generic",
    version: "2.0.0",
    priority: 0,
    match: {},
    instructions: [
      "优先选择一个已提供的规范协议候选，并保留其完整字段布局。",
      "证据只能用于选择协议和解析缺失的语义值，不得编造新的协议定义。",
      "如果所有候选都与步骤冲突，返回 unknown 并添加 warning。",
    ],
    required_evidence: ["protocol-definition"],
    max_candidates: 4,
    context_budget_chars: 10_000,
    relation_depth: 1,
    missing_evidence_policy: "warn",
  }],
  encodeTransport(renderedFrames, protocol) {
    return encodeFixedFrameEnvelope(renderedFrames, protocol) ?? {
      lines: renderedFrames.map((frame) => frame.bytes),
      frameInformationBytes: [],
      envelopeBytes: [],
      warnings: [],
    }
  },
}

export function mergeTransportWarnings(result: DtpTransportEncodingResult, warnings: string[]): DtpTransportEncodingResult {
  return { ...result, warnings: uniqueStrings([...warnings, ...result.warnings]) }
}
