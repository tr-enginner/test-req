import type { DtpProtocolDefinition, StepDataQualityIssue } from "../dtp-data-generation-core"
import { getDtpProtocolFrames } from "../dtp-protocol-definitions"
import type { DtpBusAdapter } from "./types"

function normalizeHexByte(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(?:0x)?([0-9a-f]{1,2})H?$/i)
  return match?.[1]?.toUpperCase().padStart(2, "0")
}

export function computeIso8473Checksum(bytes: string[]): [string, string] {
  let c0 = 0
  let c1 = 0
  for (const byte of bytes) {
    c0 = (c0 + Number.parseInt(normalizeHexByte(byte) ?? "00", 16)) % 255
    c1 = (c1 + c0) % 255
  }
  const first = (255 - ((c0 + c1) % 255)) % 255
  const second = (255 - ((c0 + first) % 255)) % 255
  return [first, second].map((value) => value.toString(16).toUpperCase().padStart(2, "0")) as [string, string]
}

function applyBlockFrameChecksums(
  inputBytes: string[],
  protocol: DtpProtocolDefinition,
): { bytes: string[]; warnings: string[] } {
  const bytes = inputBytes.slice()
  const warnings: string[] = []
  const block = protocol.block_layout
  if (!block) return { bytes, warnings }
  for (const checksum of block.checksums.filter((item) => item.source === "frame_range")) {
    if (
      checksum.source_start === undefined || checksum.source_end === undefined ||
      checksum.source_start < 0 || checksum.source_end < checksum.source_start ||
      checksum.source_end >= bytes.length || checksum.output_offset < 0 ||
      checksum.output_offset + checksum.output_length > bytes.length
    ) {
      warnings.push(`${checksum.name} has an invalid source or output range and was not written.`)
      continue
    }
    if (checksum.algorithm === "iso_8473" && checksum.output_length === 2) {
      bytes.splice(checksum.output_offset, checksum.output_length, ...computeIso8473Checksum(bytes.slice(checksum.source_start, checksum.source_end + 1)))
    } else if (checksum.algorithm === "iso_unknown") {
      warnings.push(`${checksum.name} was left as ${"00 ".repeat(checksum.output_length).trim()} because its algorithm is not defined.`)
    }
  }
  return { bytes, warnings }
}

function blockTemplateIndex(protocol: DtpProtocolDefinition, line: string[], fallback: number): number {
  const block = protocol.block_layout
  if (!block || block.kind !== "spacewire_program_upload" || block.block_type_offset === undefined) return fallback
  const type = normalizeHexByte(line[block.block_type_offset])
  if (type === normalizeHexByte(block.start_block_type)) return 0
  if (type === normalizeHexByte(block.middle_block_type)) return 1
  if (type === normalizeHexByte(block.check_block_type)) return 2
  return fallback
}

function blockShapeMatches(protocol: DtpProtocolDefinition, lines: string[][], selectedBlock?: string): boolean {
  const block = protocol.block_layout
  if (!block || !lines.length || lines.some((line) => line.length !== block.total_bytes)) return false
  if (selectedBlock) {
    const frameIndex = getDtpProtocolFrames(protocol).findIndex((frame) => frame.frame_id === selectedBlock)
    return frameIndex >= 0 && lines.length === 1 && blockTemplateIndex(protocol, lines[0], frameIndex) === frameIndex
  }
  if (block.kind !== "spacewire_program_upload") return true
  if (lines.length < 2 || block.block_type_offset === undefined) return false
  const types = lines.map((line) => normalizeHexByte(line[block.block_type_offset!]))
  return types[0] === normalizeHexByte(block.start_block_type) &&
    types.at(-1) === normalizeHexByte(block.check_block_type) &&
    types.slice(1, -1).every((value) => value === normalizeHexByte(block.middle_block_type))
}

function validateGeneratedLines(
  protocol: DtpProtocolDefinition,
  lines: string[][],
  checksumPolicy: string,
  artifactScope?: string,
  selectedBlock?: string,
): StepDataQualityIssue[] {
  const block = protocol.block_layout
  if (!block) return []
  const issues: StepDataQualityIssue[] = []
  for (const [lineIndex, line] of lines.entries()) {
    if (line.length !== block.total_bytes) {
      issues.push({ severity: "error", type: "frame_layout_mismatch", message: `SpaceWire block ${lineIndex + 1} has ${line.length} bytes, expected ${block.total_bytes}.` })
      continue
    }
    for (const checksum of block.checksums.filter((item) => item.algorithm === "iso_8473" && item.source === "frame_range" && item.output_length === 2)) {
      const expectedLine = applyBlockFrameChecksums(line, protocol).bytes
      const actual = line.slice(checksum.output_offset, checksum.output_offset + checksum.output_length)
      const expected = expectedLine.slice(checksum.output_offset, checksum.output_offset + checksum.output_length)
      const matches = actual.join(" ") === expected.join(" ")
      if (checksumPolicy === "make_incorrect" ? matches : !matches) {
        issues.push({
          severity: "error",
          type: checksumPolicy === "make_incorrect" ? "checksum_expected_incorrect" : "checksum_expected_correct",
          message: `SpaceWire block ${lineIndex + 1} ${checksum.name} is ${actual.join(" ")}, expected ${expected.join(" ")}.`,
        })
      }
    }
  }
  const singleBlock = artifactScope === "single_block" && selectedBlock
  if (!blockShapeMatches(protocol, lines, singleBlock ? selectedBlock : undefined)) {
    issues.push({
      severity: "error",
      type: "frame_layout_mismatch",
      message: singleBlock
        ? `SpaceWire output must contain exactly one ${selectedBlock}.`
        : "SpaceWire block sequence must contain one start block, zero or more middle blocks, and one final check block.",
    })
  }
  return issues
}

export const spaceWireBusAdapter: DtpBusAdapter = {
  id: "spacewire",
  busType: "SpaceWire",
  aliases: ["SpaceWire", "Space Wire", "SPACEWIRE"],
  matchesEvidence: (text) => /Space\s*Wire/i.test(text),
  fallbackPolicies: [{
    id: "spacewire",
    version: "2.0.0",
    priority: 100,
    match: { bus_type: "SpaceWire" },
    instructions: [
      "只能选择 SpaceWire 报文协议或数据块协议。",
      "必须保留规范数据块布局、字节序、块类型、地址、长度、payload 和校验定义。",
      "不得把 SpaceWire 数据块重新解释为 CAN 帧，也不得使用模型提供的字节替换完整规范数据块。",
      "步骤明确起始块、首块、中间块、续块或校验块时，必须返回 artifact_scope=single_block 及对应的 selected_block。",
      "内存写入目标地址只是执行位置，不得将其当作 SpaceWire 协议块内的程序起始地址。",
    ],
    required_evidence: ["protocol-definition", "source-table"],
    max_candidates: 5,
    context_budget_chars: 14_000,
    relation_depth: 2,
    missing_evidence_policy: "warn",
  }],
  applyBlockFrameChecksums,
  validateGeneratedLines({ protocol, lines, plan }) {
    return validateGeneratedLines(protocol, lines, plan.checksum_policy, plan.artifact_scope, plan.selected_block)
  },
}
