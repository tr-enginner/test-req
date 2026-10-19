import type {
  DtpProtocolDefinition,
  DtpProtocolFieldLayout,
  DtpProtocolFrameDefinition,
  StepDataQualityIssue,
} from "../dtp-data-generation-core"
import { getDtpProtocolFrames } from "../dtp-protocol-definitions"
import { encodeFixedFrameEnvelope, mergeTransportWarnings } from "./generic-adapter"
import type {
  DtpBusAdapter,
  DtpBusInterfaceConstraint,
  DtpRenderedBusFrame,
  DtpTransportEncodingResult,
} from "./types"

type PeliCanFrameInformation = {
  value: string
  ff: number
  rtr: number
  dlc: number
  dlcFieldExplicit: boolean
  dataByteCount?: number
}

function normalizeHexByte(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(?:0x)?([0-9a-f]{1,2})H?$/i)
  return match?.[1]?.toUpperCase().padStart(2, "0")
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function matchesCanEvidence(text: string): boolean {
  return /\bCAN[AB]?\b|一级\s*CAN|二级\s*CAN/i.test(text)
}

function classifyCanInterface(text: string): DtpBusInterfaceConstraint {
  const interfaceId = text.match(/IF-CAN\d+-\d+/i)?.[0]?.toUpperCase()
  if (interfaceId) {
    return {
      level: /^IF-CAN1-/i.test(interfaceId) ? "secondary" : /^IF-CAN0-/i.test(interfaceId) ? "primary" : undefined,
      interfaceId,
      source: "interface_id",
    }
  }
  const compact = text.replace(/\s+/g, "")
  const explicitLevels = uniqueStrings(
    Array.from(compact.matchAll(/(一级|二级)CAN[AB]?(?:总线|接口)?/gi)).map((match) => match[1]),
  )
  if (explicitLevels.length === 1) {
    return {
      level: explicitLevels[0] === "二级" ? "secondary" : "primary",
      source: "explicit_level",
    }
  }
  const alias = compact.match(/(CANA|CANB)(?:总线)?/i)?.[1]?.toUpperCase()
  if (alias) return { level: "primary", source: "legacy_channel_alias", matchedAlias: alias }
  return { source: "unresolved" }
}

export function shouldEncodePeliCanCaseFrames(protocol: DtpProtocolDefinition | undefined): boolean {
  const bus = protocol?.bus_context
  if (!bus || bus.bus_type !== "CAN" || bus.interface_level === "secondary") return false
  const isSja1000 = /SJA1000T?/i.test(bus.controller ?? "") || /SJA1000/i.test(bus.controller_family ?? "")
  return isSja1000 && /PeliCAN/i.test(bus.mode ?? "") && bus.frame_information?.apply_to_case_data !== false
}

function findCanControlField(frame: DtpProtocolFrameDefinition): DtpProtocolFieldLayout | undefined {
  return frame.field_layout.find((field) => /^(?:CONTROL|CONTROL_FIELD)$/i.test(field.name)) ??
    frame.field_layout.find((field) => field.role === "control" && !/^RTR$/i.test(field.name))
}

function readFrameBitField(
  bytes: string[],
  field: DtpProtocolFieldLayout | undefined,
  fallbackBitOffset: number,
  fallbackBitLength: number,
): number | undefined {
  if (!field || field.byte_offset < 0 || field.byte_offset >= bytes.length) return undefined
  const byteValue = Number.parseInt(bytes[field.byte_offset] ?? "", 16)
  if (!Number.isFinite(byteValue)) return undefined
  const bitOffset = Math.max(0, Math.floor(field.bit_offset ?? fallbackBitOffset))
  const bitLength = Math.max(1, Math.min(8, Math.floor(field.bit_length ?? fallbackBitLength)))
  return (byteValue >> bitOffset) & ((1 << bitLength) - 1)
}

export function frameAlreadyContainsPeliCanInformation(
  protocol: DtpProtocolDefinition,
  frame: DtpProtocolFrameDefinition,
): boolean {
  if (frame.field_layout.some((field) => /^(?:FI|FRAME_INFO|FRAME_INFORMATION)$/i.test(field.name))) return true
  if (protocol.bus_context?.frame_buffer_layout !== "sja1000-pelican") return false
  const explicit = normalizeHexByte(protocol.bus_context.frame_info_byte)
  return Boolean(explicit && normalizeHexByte(frame.byte_layout[0]) === explicit)
}

export function derivePeliCanFrameInformation(
  protocol: DtpProtocolDefinition,
  frame: DtpProtocolFrameDefinition,
  bytes: string[],
): PeliCanFrameInformation | null {
  const embedded = frameAlreadyContainsPeliCanInformation(protocol, frame)
  const embeddedByte = embedded ? Number.parseInt(bytes[0] ?? "", 16) : NaN
  const format = protocol.bus_context?.frame_format
  const ff = format === "extended" ? 1 : format === "standard" ? 0 : Number.isFinite(embeddedByte) ? (embeddedByte >> 7) & 1 : undefined
  if (ff === undefined) return null
  const dlcField = frame.field_layout.find((field) => /^DLC$/i.test(field.name)) ??
    frame.field_layout.find((field) => field.role === "length" && /DLC/i.test(field.source_text ?? ""))
  const rtrField = frame.field_layout.find((field) => /^RTR$/i.test(field.name))
  const controlField = findCanControlField(frame)
  const dlc = readFrameBitField(bytes, dlcField, 0, 4) ?? readFrameBitField(bytes, controlField, 0, 4) ??
    (Number.isFinite(embeddedByte) ? embeddedByte & 0x0f : undefined)
  const rtr = readFrameBitField(bytes, rtrField, 4, 1) ?? readFrameBitField(bytes, controlField, 4, 1) ??
    (Number.isFinite(embeddedByte) ? (embeddedByte >> 6) & 1 : 0)
  if (dlc === undefined || rtr === undefined) return null
  return {
    value: ((ff << 7) | (rtr << 6) | (dlc & 0x0f)).toString(16).toUpperCase().padStart(2, "0"),
    ff,
    rtr,
    dlc,
    dlcFieldExplicit: Boolean(dlcField),
    dataByteCount: controlField && !embedded ? Math.max(0, bytes.length - controlField.byte_offset - 1) : undefined,
  }
}

function isTrailingCanPlaceholderField(field: DtpProtocolFieldLayout | undefined): boolean {
  return Boolean(field) && (/^(?:UNUSED|RESERVED|PADDING|PAD)$/i.test(field!.name) ||
    /^\s*(?:[-—–]+|N\/?A|UNUSED|RESERVED)\s*$/i.test(field!.source_text ?? ""))
}

function repairRenderedCanDlcPlaceholderTails(
  renderedFrames: DtpRenderedBusFrame[],
  protocol: DtpProtocolDefinition,
): { frames: DtpRenderedBusFrame[]; warnings: string[] } {
  const protocolFrames = getDtpProtocolFrames(protocol)
  const warnings: string[] = []
  const frames = renderedFrames.map((renderedFrame, outputIndex) => {
    const frame = protocolFrames[renderedFrame.canonicalFrameIndex] ?? protocolFrames[outputIndex] ?? protocolFrames[0]
    if (!frame || frameAlreadyContainsPeliCanInformation(protocol, frame)) return renderedFrame
    const dlcField = frame.field_layout.find((field) => /^DLC$/i.test(field.name))
    const controlField = findCanControlField(frame)
    if (!dlcField || !controlField) return renderedFrame
    const dlc = readFrameBitField(renderedFrame.bytes, dlcField, 0, 4)
    if (dlc === undefined || dlc > 8) return renderedFrame
    const expectedLength = controlField.byte_offset + 1 + dlc
    if (renderedFrame.bytes.length <= expectedLength) return renderedFrame
    const trailingOffsets = Array.from({ length: renderedFrame.bytes.length - expectedLength }, (_, index) => expectedLength + index)
    const trailingFields = trailingOffsets.map((offset) => frame.field_layout.find((field) => (
      field.byte_offset === offset && field.bit_offset === undefined
    )))
    if (!trailingFields.every(isTrailingCanPlaceholderField)) return renderedFrame
    warnings.push(`Frame ${outputIndex + 1} discarded ${trailingOffsets.length} trailing CAN placeholder byte(s) beyond DLC ${dlc}.`)
    return { ...renderedFrame, bytes: renderedFrame.bytes.slice(0, expectedLength) }
  })
  return { frames, warnings: uniqueStrings(warnings) }
}

function encodeCanTransport(
  renderedFrames: DtpRenderedBusFrame[],
  protocol: DtpProtocolDefinition | undefined,
): DtpTransportEncodingResult {
  if (!protocol) return { lines: renderedFrames.map((frame) => frame.bytes), frameInformationBytes: [], envelopeBytes: [], warnings: [] }
  const repaired = repairRenderedCanDlcPlaceholderTails(renderedFrames, protocol)
  const fixedEnvelope = encodeFixedFrameEnvelope(repaired.frames, protocol)
  if (fixedEnvelope) return mergeTransportWarnings(fixedEnvelope, repaired.warnings)
  if (!shouldEncodePeliCanCaseFrames(protocol)) {
    return { lines: repaired.frames.map((frame) => frame.bytes), frameInformationBytes: [], envelopeBytes: [], warnings: repaired.warnings }
  }
  const protocolFrames = getDtpProtocolFrames(protocol)
  const warnings = [...repaired.warnings]
  const frameInformationBytes: string[] = []
  const lines = repaired.frames.map((renderedFrame, outputIndex) => {
    const frame = protocolFrames[renderedFrame.canonicalFrameIndex] ?? protocolFrames[outputIndex] ?? protocolFrames[0]
    if (!frame) {
      warnings.push(`PeliCAN Frame Information was not added to frame ${outputIndex + 1}: canonical frame metadata is missing.`)
      return renderedFrame.bytes
    }
    const information = derivePeliCanFrameInformation(protocol, frame, renderedFrame.bytes)
    if (!information) {
      warnings.push(`PeliCAN Frame Information was not added to frame ${outputIndex + 1}: FF/RTR/DLC could not be resolved.`)
      return renderedFrame.bytes
    }
    frameInformationBytes.push(information.value)
    if (frameAlreadyContainsPeliCanInformation(protocol, frame)) {
      const line = renderedFrame.bytes.slice()
      line[0] = information.value
      return line
    }
    return [information.value, ...renderedFrame.bytes]
  })
  return { lines, frameInformationBytes, envelopeBytes: [], warnings: uniqueStrings(warnings) }
}

function normalizeCanFrameLayout(
  protocol: DtpProtocolDefinition,
  layout: string[],
): { layout: string[]; warnings: string[] } {
  const bus = protocol.bus_context
  const isFrameBuffer = bus?.bus_type === "CAN" && /SJA1000/i.test(bus.controller ?? "") &&
    /PeliCAN/i.test(bus.mode ?? "") && bus.frame_buffer_layout === "sja1000-pelican"
  if (!isFrameBuffer) return { layout, warnings: [] }
  const frameInfoByte = normalizeHexByte(bus.frame_info_byte)
  if (!frameInfoByte) {
    return {
      layout,
      warnings: ["SJA1000/PeliCAN frame-buffer layout was detected, but no explicit frame_info_byte was available; byte layout was left unchanged."],
    }
  }
  if (normalizeHexByte(layout[0]) === frameInfoByte) return { layout, warnings: [] }
  return {
    layout: [frameInfoByte, ...layout],
    warnings: [`SJA1000/PeliCAN frame_info_byte ${frameInfoByte} was prepended to the frame-buffer byte layout.`],
  }
}

function inspectCanTransport(
  rawLines: string[][],
  protocol: DtpProtocolDefinition,
  renderedIndices: number[],
): { payloadLines: string[][]; issues: StepDataQualityIssue[] } {
  if (!shouldEncodePeliCanCaseFrames(protocol)) return { payloadLines: rawLines, issues: [] }
  const frames = getDtpProtocolFrames(protocol)
  const issues: StepDataQualityIssue[] = []
  const payloadLines = rawLines.map((rawLine, lineIndex) => {
    const indexed = frames[renderedIndices[lineIndex] ?? lineIndex]
    const matching = frames.find((frame) => rawLine.length === frame.byte_layout.length + (frameAlreadyContainsPeliCanInformation(protocol, frame) ? 0 : 1))
    const frame = indexed && (rawLine.length === indexed.byte_layout.length || rawLine.length === indexed.byte_layout.length + 1)
      ? indexed
      : matching ?? frames[0]
    if (!frame) {
      issues.push({ severity: "warning", type: "frame_information_missing", message: `Frame ${lineIndex + 1} has no canonical metadata for PeliCAN Frame Information validation.` })
      return rawLine
    }
    const embedded = frameAlreadyContainsPeliCanInformation(protocol, frame)
    if (!embedded && rawLine.length <= frame.byte_layout.length) {
      issues.push({ severity: "error", type: "frame_information_missing", message: `Frame ${lineIndex + 1} is missing the PeliCAN Frame Information byte.` })
      return rawLine
    }
    const actual = rawLine[0]
    const payload = embedded ? rawLine : rawLine.slice(1)
    const expected = derivePeliCanFrameInformation(protocol, frame, payload)
    if (!expected) {
      issues.push({ severity: "warning", type: "frame_information_missing", message: `Frame ${lineIndex + 1} FF/RTR/DLC could not be resolved for PeliCAN Frame Information validation.` })
      return payload
    }
    if (actual !== expected.value) issues.push({ severity: "error", type: "frame_information_mismatch", message: `Frame ${lineIndex + 1} PeliCAN Frame Information is ${actual}, expected ${expected.value}.` })
    if (expected.dlc > 8) issues.push({ severity: "error", type: "dlc_out_of_range", message: `Frame ${lineIndex + 1} DLC is ${expected.dlc}; classic SJA1000 CAN should use DLC 0..8.` })
    if (expected.dlcFieldExplicit && expected.rtr === 0 && expected.dataByteCount !== undefined && expected.dataByteCount !== expected.dlc) {
      issues.push({ severity: "error", type: "dlc_mismatch", message: `Frame ${lineIndex + 1} DLC is ${expected.dlc}, but ${expected.dataByteCount} CAN data bytes are present.` })
    }
    return payload
  })
  return { payloadLines, issues }
}

export const canBusAdapter: DtpBusAdapter = {
  id: "can",
  busType: "CAN",
  aliases: ["CAN", "CANA", "CANB", "一级CAN", "二级CAN"],
  matchesEvidence: matchesCanEvidence,
  classifyInterface: classifyCanInterface,
  allowCommandDictionaryDefault(protocol, stepText) {
    return protocol.bus_context?.interface_level === "primary" &&
      /遥控指令/.test(stepText) &&
      !/遥控指令(?:应答|响应)|(?:应答|响应).*遥控指令/.test(stepText)
  },
  fallbackPolicies: [
    {
      id: "primary-can",
      version: "2.0.0",
      priority: 100,
      match: { bus_type: "CAN", interface_level: "primary" },
      instructions: [
        "除非证据明确证明属于其他接口层级，否则只能选择一级 CAN 协议。",
        "必须保留规范布局中的仲裁场、控制场、TITLE、长度、帧序号、W 字段及校验字段位置。",
        "为兼容旧用例，步骤只写 CANA/CANB 且没有层级证据时，按一级 CAN 处理。",
        "不要添加 SJA1000/PeliCAN Frame Information 字节，传输层封装由确定性 writer 负责。",
      ],
      required_evidence: ["protocol-definition", "source-table"],
      max_candidates: 5,
      context_budget_chars: 12_000,
      relation_depth: 1,
      missing_evidence_policy: "warn",
    },
    {
      id: "secondary-can",
      version: "2.0.0",
      priority: 110,
      match: { bus_type: "CAN", interface_level: "secondary" },
      instructions: [
        "只能选择二级 CAN 协议，并保留站地址相关 selector_relation 作为候选选择证据。",
        "通过规范 value_rule 计算“基础值 + 站地址”等表达式，不得把表达式文本直接写入字节。",
        "证据提供站地址映射时，使用该映射选择遥测帧数或协议变体。",
        "不要添加 SJA1000/PeliCAN Frame Information 字节，传输层封装由确定性 writer 负责。",
      ],
      required_evidence: ["protocol-definition", "source-table"],
      max_candidates: 6,
      context_budget_chars: 14_000,
      relation_depth: 2,
      missing_evidence_policy: "warn",
    },
  ],
  normalizeFrameLayout: normalizeCanFrameLayout,
  encodeTransport: encodeCanTransport,
  inspectTransport: inspectCanTransport,
}
