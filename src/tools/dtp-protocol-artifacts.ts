import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs"
import { dirname, extname, isAbsolute, join, resolve } from "path"
import type {
  DefaultPaths,
  DtpDataQualityIssue,
  DtpDataQualityReport,
  DtpProtocolDataWriterResult,
  DtpProtocolDefinition,
  DtpProtocolDefinitionsDocument,
  DtpProtocolFieldDefinition,
  DtpProtocolFrameDefinition,
  DtpProtocolRetryContext,
  DtpProtocolVariantDefinition,
  DtpProtocolWriterOptions,
  DtpProtocolWriterPreviewDocument,
  GeneratedDataFileIndex,
  GeneratedDataFileIndexEntry,
  PacketFieldValuePlan,
} from "./dtp-data-generation-core"
import {
  getDtpPrimaryProtocolFrame,
  getDtpProtocolFrames,
} from "./dtp-protocol-definitions"
import {
  applyDtpBusBlockFrameChecksums,
  normalizeDtpBusFrameLayout,
} from "./dtp-bus-adapters/registry"
import { computeIso8473Checksum } from "./dtp-bus-adapters/spacewire-adapter"

type DtpProtocolVariant = {
  suffix: string
  values: Map<string, string>
  fieldValuePlan: PacketFieldValuePlan[]
  warnings: string[]
}

function ensureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })
}

function normalizeHexByte(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(?:0x)?([0-9a-fA-F]{1,2})H?$/)
  return match?.[1]?.toUpperCase().padStart(2, "0")
}

function computeByteSum(bytes: string[]): string {
  const sum = bytes.reduce((acc, byte) => acc + Number.parseInt(byte, 16), 0) & 0xff
  return sum.toString(16).toUpperCase().padStart(2, "0")
}

export function applyDtpBlockFrameChecksums(
  sourceBytes: string[],
  protocol: DtpProtocolDefinition,
): { bytes: string[]; warnings: string[] } {
  const result = applyDtpBusBlockFrameChecksums(sourceBytes, protocol)
  return { ...result, warnings: uniqueStrings(result.warnings) }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function normalizeLookupText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/\.(txt|dat|bin|csv|xml)$/i, "")
    .replace(/[\s\\/_\-\u3002\uff0c\uff1b\uff1a\uff08\uff09()[\]{}"'`=]+/g, "")
}

function stripGeneratedNameMarker(value: string): string {
  return value.replace(/(?:[\s,，;；:：\-－]+)?D\d(?:D\d)*(?:\s*[:：;-].*)?$/i, "")
}

function sanitizeReadableFileBaseName(value: string | undefined): string {
  return stripGeneratedNameMarker(
    (value ?? "")
      .replace(/\.(txt|dat|bin|csv|xml)$/i, "")
      .replace(/[\\/:*?"<>|]/g, ""),
  )
    .replace(/[，；：。]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function cleanGeneratedDataFileBaseName(value: string | undefined): string {
  const cleaned = sanitizeReadableFileBaseName(value)
    .replace(/^(?:\u9644\u8868|\u8868\u683c|\u8868)\s*[A-Za-z]?\s*[-\uff0d]?\s*\d+(?:\.\d+)*(?:\s*[-\uff0d]\s*\d+)?\s*/i, "")
    .replace(/(?:[,，;；\s]+D\d(?:D\d)*\s*(?:=|[-:：]).*)$/i, "")
    .replace(/[;；,，]\s*(?:D\d)+\s*[-:\uff1a].*$/i, "")
    .replace(/(?:D\d)+\s*(?:=|[-:\uff1a]).*$/i, "")
    .replace(/^[,，;；:：\-\uff0d\s]+|[,，;；:：\-\uff0d]+$/g, "")
    .replace(/\s+/g, "")
  return cleaned || normalizeLookupText(value) || "unnamed"
}

function looksLikeFrameHeaderBaseName(value: string | undefined): boolean {
  const normalized = normalizeLookupText(value)
  if (!normalized) return false
  const headerTokens = [
    "\u5e8f\u53f7",
    "id10",
    "id3",
    "id2",
    "id0",
    "rtr",
    "dlc",
    "title",
    "sum",
    "w0",
    "w1",
    "w2",
    "w3",
  ]
  const hitCount = headerTokens.filter((token) => normalized.includes(token)).length
  return hitCount >= 2 || /^\u5e8f\u53f7.*id/.test(normalized)
}

function cleanDictionaryProtocolBaseName(value: string | undefined): string {
  const cleaned = cleanGeneratedDataFileBaseName(value)
    .replace(/\u7801\u5b9a\u4e49\u8868$/g, "")
    .replace(/\u7801\u5b57\u5178\u8868$/g, "")
    .replace(/\u5b9a\u4e49\u8868$/g, "")
    .replace(/\u5b57\u5178\u8868$/g, "")
    .replace(/\u683c\u5f0f\u8868$/g, "")
    .replace(/\u8868$/g, "")
  return cleaned || cleanGeneratedDataFileBaseName(value)
}

function protocolFileNameBase(protocol: DtpProtocolDefinition): string {
  if (!looksLikeFrameHeaderBaseName(protocol.base_file_name)) return protocol.base_file_name

  const evidenceName = protocol.evidence
    .map((item) => cleanDictionaryProtocolBaseName(item))
    .find((item) => item && !looksLikeFrameHeaderBaseName(item))
  return evidenceName || protocol.base_file_name
}

function flowDirectoryName(flowDirection: string | undefined): string {
  return flowDirection === "output" ? "\u8f93\u51fa\u6d41" : "\u8f93\u5165\u6d41"
}

function flowHeadingName(flowDirection: string | undefined): string | undefined {
  if (flowDirection === "input") return "\u8f93\u5165\u6d41"
  if (flowDirection === "output") return "\u8f93\u51fa\u6d41"
  return undefined
}

function toRobotPath(inputPath: string): string {
  return inputPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("\\\\")
}

function toRuntimeInputDataPath(relativePath: string): string {
  return toRobotPath(join("\u8f93\u5165\u6570\u636e", relativePath))
}

function decideBusinessPath(
  requestedName: string,
  flowDirection: string = "input",
  directoryLayout: DtpProtocolWriterOptions["directoryLayout"] = "flow",
): string {
  return directoryLayout === "flat"
    ? requestedName
    : join(flowDirectoryName(flowDirection), requestedName)
}

function appendDataFileIndexEntry(index: GeneratedDataFileIndex, entry: GeneratedDataFileIndexEntry): void {
  const existing = index.entries.find((item) =>
    entry.file_path
      ? item.file_path === entry.file_path
      : item.id === entry.id,
  )
  if (existing) {
    Object.assign(existing, entry)
    return
  }
  index.entries.push(entry)
}

function decodeTextFile(filePath: string): string {
  const buffer = readFileSync(filePath)
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf-8")
  }

  const utf8Text = buffer.toString("utf-8")
  if (!utf8Text.includes("\ufffd")) return utf8Text

  try {
    return new TextDecoder("gb18030" as any).decode(buffer)
  } catch {
    return utf8Text
  }
}

function protocolFieldValuePlan(
  fieldName: string,
  value: string,
  valueSource: PacketFieldValuePlan["value_source"],
  field: DtpProtocolFieldDefinition,
  sourceText?: string,
): PacketFieldValuePlan {
  return {
    field_name: fieldName,
    value,
    value_source: valueSource,
    source_table_id: field.source_table_id,
    source_text: sourceText ?? field.source_text ?? field.source,
    confidence: Math.max(0, Math.min(1, field.confidence ?? 0.75)),
    reasoning: [`Value resolved from dtp-protocol-definitions field ${fieldName}.`],
  }
}

function fixedFieldValueSource(field: DtpProtocolFieldDefinition): PacketFieldValuePlan["value_source"] {
  const source = field.source
  if (
    source === "frame-table" ||
    source === "support-table" ||
    source === "dictionary-row" ||
    source === "enum-option" ||
    source === "bitfield-enum" ||
    source === "model" ||
    source === "fallback-zero"
  ) {
    return source
  }
  return field.value ? "model" : "fallback-zero"
}

function applyFixedFieldsToVariant(
  variant: DtpProtocolVariant,
  fields: DtpProtocolFieldDefinition[],
): DtpProtocolVariant {
  const values = new Map(variant.values)
  const fieldValuePlan = [...variant.fieldValuePlan]
  const warnings = [...variant.warnings]

  for (const field of fields) {
    const fieldName = field.name.toUpperCase()
    const value = normalizeHexByte(field.value) ?? "00"
    values.set(fieldName, value)
    fieldValuePlan.push(protocolFieldValuePlan(fieldName, value, fixedFieldValueSource(field), field))
    if (!field.value) warnings.push(`Field ${fieldName} has no fixed value; 00 fallback was used.`)
  }

  return { ...variant, values, fieldValuePlan, warnings }
}

function protocolExplicitVariants(
  protocol: DtpProtocolDefinition,
  variants: DtpProtocolVariantDefinition[],
  maxCombinations: number,
): DtpProtocolVariant[] {
  const base = applyFixedFieldsToVariant(
    { suffix: "", values: new Map(), fieldValuePlan: [], warnings: [] },
    protocol.fields.filter((field) => field.type === "fixed" || !field.options?.length),
  )

  return variants.slice(0, maxCombinations).map((variant) => {
    const suffix = sanitizeReadableFileBaseName(variant.name)
    return applyFixedFieldsToVariant(
      {
        suffix,
        values: new Map(base.values),
        fieldValuePlan: [...base.fieldValuePlan],
        warnings: uniqueStrings([...base.warnings, ...variant.warnings]),
      },
      variant.fields,
    )
  })
}

function cartesianProtocolVariants(groups: DtpProtocolVariant[][], maxCombinations: number): DtpProtocolVariant[] {
  let variants: DtpProtocolVariant[] = [{ suffix: "", values: new Map(), fieldValuePlan: [], warnings: [] }]
  for (const group of groups) {
    const next: DtpProtocolVariant[] = []
    for (const variant of variants) {
      for (const choice of group) {
        const values = new Map(variant.values)
        for (const [key, value] of choice.values) values.set(key, value)
        next.push({
          suffix: [variant.suffix, choice.suffix].filter(Boolean).join("-"),
          values,
          fieldValuePlan: [...variant.fieldValuePlan, ...choice.fieldValuePlan],
          warnings: [...variant.warnings, ...choice.warnings],
        })
        if (next.length >= maxCombinations) break
      }
      if (next.length >= maxCombinations) break
    }
    variants = next
    if (variants.length >= maxCombinations) break
  }
  return variants
}

function protocolVariants(protocol: DtpProtocolDefinition, maxCombinations: number): DtpProtocolVariant[] {
  if (protocol.variants?.length) {
    return protocolExplicitVariants(protocol, protocol.variants, maxCombinations)
  }

  const fixedValues = new Map<string, string>()
  const fixedPlan: PacketFieldValuePlan[] = []
  const warnings: string[] = []
  const variantGroups: DtpProtocolVariant[][] = []

  for (const field of protocol.fields) {
    const fieldName = field.name.toUpperCase()
    if (field.type === "fixed" || !field.options?.length) {
      const value = normalizeHexByte(field.value) ?? "00"
      fixedValues.set(fieldName, value)
      fixedPlan.push(protocolFieldValuePlan(
        fieldName,
        value,
        fixedFieldValueSource(field),
        field,
      ))
      if (!field.value) warnings.push(`Field ${fieldName} has no fixed value; 00 fallback was used.`)
      continue
    }

    const valueSource: PacketFieldValuePlan["value_source"] = field.type === "bitfield" ? "bitfield-enum" : "enum-option"
    const choices = field.options
      .map((option): DtpProtocolVariant | null => {
        const value = normalizeHexByte(option.value)
        if (!value) return null
        return {
          suffix: sanitizeReadableFileBaseName(option.label) || `${fieldName}-${value}`,
          values: new Map([[fieldName, value]]),
          fieldValuePlan: [protocolFieldValuePlan(fieldName, value, valueSource, field, option.source ?? option.label)],
          warnings: [],
        }
      })
      .filter((item): item is DtpProtocolVariant => Boolean(item))

    if (choices.length) {
      variantGroups.push(choices)
    } else {
      fixedValues.set(fieldName, "00")
      fixedPlan.push(protocolFieldValuePlan(fieldName, "00", "fallback-zero", field))
      warnings.push(`Field ${fieldName} has no valid variant option; 00 fallback was used.`)
    }
  }

  const variants = variantGroups.length ? cartesianProtocolVariants(variantGroups, maxCombinations) : [{ suffix: "", values: new Map(), fieldValuePlan: [], warnings: [] }]
  return variants.map((variant) => {
    const values = new Map(fixedValues)
    for (const [key, value] of variant.values) values.set(key, value)
    return {
      ...variant,
      values,
      fieldValuePlan: [...fixedPlan, ...variant.fieldValuePlan],
      warnings: [...warnings, ...variant.warnings],
    }
  })
}

function hasExpandableDictionaryRows(protocol: DtpProtocolDefinition): boolean {
  if (protocol.variants?.length) return true
  return protocol.fields.some((field) => field.options?.some((option) => normalizeHexByte(option.value)))
}

function isLikelyLengthByte(layout: string[], index: number, sumIndex: number): boolean {
  if (index !== 3) return false
  const value = normalizeHexByte(layout[index])
  if (!value || /^W\d+$/i.test(layout[index])) return false
  if (sumIndex < 5) return false
  const dataFieldCount = layout.slice(index + 1, sumIndex).filter((item) => /^W\d+$/i.test(item)).length
  if (!dataFieldCount) return false

  const numericValue = Number.parseInt(value, 16)
  return numericValue === dataFieldCount || (numericValue <= 0x10 && numericValue >= dataFieldCount)
}

function protocolChecksumIndexes(
  frameDefinition: DtpProtocolFrameDefinition,
  layout: string[],
  sumIndex: number,
): Set<number> {
  const startName = frameDefinition.checksum?.start?.trim()
  if (startName && !/^TITLE$/i.test(startName)) {
    const normalizedStart = startName.toUpperCase()
    const startField = frameDefinition.field_layout.find((field) => field.name.toUpperCase() === normalizedStart)
    const startIndex = startField?.byte_offset ?? layout.findIndex((token) => token.toUpperCase() === normalizedStart)
    if (startIndex >= 0 && startIndex < sumIndex) {
      return new Set(Array.from({ length: sumIndex - startIndex }, (_, offset) => startIndex + offset))
    }
  }

  const semanticIndexes = new Set(
    frameDefinition.field_layout
      .filter((field) => field.role === "title" || field.role === "data")
      .flatMap((field) => Array.from({ length: field.byte_length }, (_, offset) => field.byte_offset + offset))
      .filter((index) => index >= 0 && (sumIndex < 0 || index < sumIndex)),
  )
  if (frameDefinition.field_layout.some((field) => field.role === "title")) return semanticIndexes

  const checksumStartIndex = sumIndex >= 3 ? 2 : 0
  return new Set(layout
    .map((_, index) => index)
    .filter((index) => index >= checksumStartIndex && index !== sumIndex && !isLikelyLengthByte(layout, index, sumIndex)))
}

function renderProtocolFrameLineFromLayout(
  frameDefinition: DtpProtocolFrameDefinition,
  values: Map<string, string>,
  layout: string[],
): { line: string | null; warnings: string[] } {
  const warnings: string[] = []
  const bytes: string[] = []
  const checksumBytes: string[] = []
  const sumIndex = layout.findIndex((item) => /^SUM$/i.test(item))
  const checksumType = frameDefinition.checksum?.type ?? "unknown"
  const checksumIndexes = protocolChecksumIndexes(frameDefinition, layout, sumIndex)

  for (let index = 0; index < layout.length; index += 1) {
    const token = layout[index].trim()
    if (!token) continue

    if (/^SUM$/i.test(token)) {
      bytes.push(checksumType === "sum_low8" ? computeByteSum(checksumBytes) : "00")
      continue
    }

    const fieldName = token.match(/^((?:W|DATA)\d+)$/i)?.[1]?.toUpperCase()
    const value = fieldName ? values.get(fieldName) ?? "00" : normalizeHexByte(token)
    if (!value) {
      warnings.push(`Frame token ${token} could not be converted to a byte; 00 fallback was used.`)
      bytes.push("00")
      if (checksumIndexes.has(index)) checksumBytes.push("00")
      continue
    }

    if (fieldName && !values.has(fieldName)) {
      warnings.push(`Frame field ${fieldName} has no value; 00 fallback was used.`)
    }

    bytes.push(value)
    if (checksumType === "sum_low8" && checksumIndexes.has(index)) {
      checksumBytes.push(value)
    }
  }

  return bytes.length ? { line: bytes.join(" "), warnings } : { line: null, warnings: ["Protocol frame byte_layout is empty."] }
}

function rawProtocolFrames(protocol: DtpProtocolDefinition) {
  return getDtpProtocolFrames(protocol)
}

function rawProtocolFrameLayouts(protocol: DtpProtocolDefinition): string[][] {
  return rawProtocolFrames(protocol).map((frame) => frame.byte_layout)
}

function protocolFrameLayouts(protocol: DtpProtocolDefinition): string[][] {
  return rawProtocolFrameLayouts(protocol).map((layout) => normalizeDtpBusFrameLayout(protocol, layout).layout)
}

function applyCrossFrameTitleChecksum(
  frames: DtpProtocolFrameDefinition[],
  lines: string[],
): string[] {
  if (frames.length < 2 || lines.length !== frames.length) return lines

  const titleFrames = frames
    .map((frame, frameIndex) => ({
      frameIndex,
      offset: frame.field_layout.find((field) => field.role === "title" || /^(?:TITLE|T)$/i.test(field.name))?.byte_offset,
    }))
    .filter((item): item is { frameIndex: number; offset: number } => item.offset !== undefined)
  const checksumFrames = frames
    .map((frame, frameIndex) => ({
      frameIndex,
      offset: frame.field_layout.find((field) => field.role === "checksum")?.byte_offset ??
        frame.byte_layout.findIndex((token) => /^(?:SUM|CHECKSUM)$/i.test(token)),
    }))
    .filter((item) => item.offset >= 0)
  if (titleFrames.length !== 1 || !checksumFrames.length) return lines

  const title = titleFrames[0]
  const checksum = checksumFrames.at(-1)!
  const checksumDefinition = frames[checksum.frameIndex].checksum
  if (
    title.frameIndex >= checksum.frameIndex ||
    checksumDefinition?.type !== "sum_low8" ||
    !/^TITLE$/i.test(checksumDefinition.start ?? "")
  ) return lines

  const checksumBytes: string[] = []
  for (const [frameIndex, frame] of frames.entries()) {
    const bytes = lines[frameIndex].trim().split(/\s+/)
    for (const field of frame.field_layout) {
      if (field.role !== "title" && field.role !== "data") continue
      for (let offset = 0; offset < field.byte_length; offset += 1) {
        const byteIndex = field.byte_offset + offset
        if (frameIndex === title.frameIndex && byteIndex < title.offset) continue
        if (byteIndex < bytes.length) checksumBytes.push(bytes[byteIndex])
      }
    }
  }
  if (!checksumBytes.length) return lines

  const finalBytes = lines[checksum.frameIndex].trim().split(/\s+/)
  if (checksum.offset >= finalBytes.length) return lines
  finalBytes[checksum.offset] = computeByteSum(checksumBytes)
  const updated = [...lines]
  updated[checksum.frameIndex] = finalBytes.join(" ")
  return updated
}

function renderProtocolFrameContent(
  protocol: DtpProtocolDefinition,
  values: Map<string, string>,
  paths?: DefaultPaths,
): { content: string | null; warnings: string[] } {
  if (protocol.block_layout?.kind === "spacewire_program_upload" && paths) {
    return renderSpaceWireProgramUpload(protocol, paths)
  }
  const lines: string[] = []
  const warnings: string[] = []

  for (const frameDefinition of rawProtocolFrames(protocol)) {
    const resolvedLayout = normalizeDtpBusFrameLayout(protocol, frameDefinition.byte_layout)
    warnings.push(...resolvedLayout.warnings)
    const frame = renderProtocolFrameLineFromLayout(frameDefinition, values, resolvedLayout.layout)
    warnings.push(...frame.warnings)
    if (frame.line) lines.push(frame.line)
  }

  const renderedLines = applyCrossFrameTitleChecksum(rawProtocolFrames(protocol), lines)
  return renderedLines.length
    ? { content: `${renderedLines.join("\n")}\n`, warnings: uniqueStrings(warnings) }
    : { content: null, warnings: uniqueStrings(warnings.length ? warnings : ["Protocol frame could not be rendered."]) }
}

function encodeUnsignedInteger(value: bigint, byteLength: number, byteOrder: "big" | "little"): string[] {
  const bytes = Array.from({ length: byteLength }, () => {
    const byte = Number(value & 0xffn).toString(16).toUpperCase().padStart(2, "0")
    value >>= 8n
    return byte
  })
  return byteOrder === "big" ? bytes.reverse() : bytes
}

function spaceWirePayloadCandidates(workspaceRoot: string): string[] {
  const matches: string[] = []
  const excluded = new Set([".git", "node_modules", "dist", "release", "tools-archive", "\u8f93\u5165\u6570\u636e"])
  const visit = (directory: string, depth: number): void => {
    if (depth > 4) return
    let entries: Array<{
      name: string
      isDirectory(): boolean
      isFile(): boolean
    }>
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === ".matrix" && depth > 0) continue
        visit(fullPath, depth + 1)
        continue
      }
      if (!entry.isFile() || ![".bin", ".img"].includes(extname(entry.name).toLowerCase())) continue
      try {
        if (statSync(fullPath).size > 0) matches.push(fullPath)
      } catch {
        // Ignore files that disappear while the workspace is being scanned.
      }
    }
  }
  visit(workspaceRoot, 0)
  return matches
}

function resolveSpaceWirePayloadFile(
  protocol: DtpProtocolDefinition,
  paths: DefaultPaths,
): { file?: string; warnings: string[] } {
  const configured = protocol.block_layout?.payload_file
  if (configured) {
    const candidate = isAbsolute(configured) ? configured : resolve(paths.workspaceRoot, configured)
    if (existsSync(candidate)) return { file: candidate, warnings: [] }
    return { warnings: [`Configured SpaceWire payload file does not exist: ${candidate}.`] }
  }
  const candidates = spaceWirePayloadCandidates(paths.workspaceRoot)
  if (candidates.length === 1) return { file: candidates[0], warnings: [] }
  if (candidates.length > 1) {
    return {
      warnings: [
        `Multiple SpaceWire payload candidates were found (${candidates.join(", ")}); none was selected automatically. Configure block_layout.payload_file.`,
      ],
    }
  }
  return { warnings: ["No SpaceWire program image was found; one zero-filled 704-byte payload block was emitted in permissive mode."] }
}

function spaceWireTemplateBytes(frame: DtpProtocolFrameDefinition, totalBytes: number): string[] {
  const fieldsByOffset = new Map(frame.field_layout
    .filter((field) => field.bit_offset === undefined)
    .map((field) => [field.byte_offset, field]))
  return Array.from({ length: totalBytes }, (_, index) => (
    normalizeHexByte(frame.byte_layout[index]) ?? normalizeHexByte(fieldsByOffset.get(index)?.default_value) ?? "00"
  ))
}

function renderSpaceWireProgramUpload(
  protocol: DtpProtocolDefinition,
  paths: DefaultPaths,
): { content: string | null; warnings: string[] } {
  const block = protocol.block_layout
  if (!block || block.kind !== "spacewire_program_upload") return { content: null, warnings: ["SpaceWire block layout is missing."] }
  const warnings = [...protocol.warnings]
  const frames = rawProtocolFrames(protocol)
  const startFrame = frames.find((frame) => frame.frame_id === "start-block") ?? frames[0]
  const middleFrame = frames.find((frame) => frame.frame_id === "middle-block") ?? frames[1]
  const checkFrame = frames.find((frame) => frame.frame_id === "check-block") ?? frames.at(-1)
  if (!startFrame || !middleFrame || !checkFrame) {
    return { content: null, warnings: ["SpaceWire program upload requires start, middle, and check block templates."] }
  }
  const payloadResolution = resolveSpaceWirePayloadFile(protocol, paths)
  warnings.push(...payloadResolution.warnings)
  const payload = payloadResolution.file
    ? new Uint8Array(readFileSync(payloadResolution.file))
    : new Uint8Array(block.payload_capacity ?? 704)
  const payloadCapacity = block.payload_capacity ?? 704
  const payloadOffset = block.payload_offset ?? 12
  const totalBytes = block.total_bytes
  const scalarByteOrder = block.scalar_byte_order === "little" ? "little" : "big"
  if (block.scalar_byte_order === "unknown") {
    warnings.push("SpaceWire scalar byte order is unknown; big-endian document order was used as a warned fallback.")
  }
  const startAddress = BigInt(`0x${(block.start_address ?? "00000000").replace(/^0x/i, "")}`)
  const blockCount = Math.max(1, Math.ceil(payload.length / payloadCapacity))
  const lines: string[] = []

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const template = blockIndex === 0 ? startFrame : middleFrame
    const bytes = spaceWireTemplateBytes(template, totalBytes)
    const chunk = payload.slice(blockIndex * payloadCapacity, Math.min(payload.length, (blockIndex + 1) * payloadCapacity))
    const paddedChunk = new Uint8Array(payloadCapacity)
    paddedChunk.set(chunk)
    for (let index = 0; index < payloadCapacity; index += 1) {
      bytes[payloadOffset + index] = paddedChunk[index].toString(16).toUpperCase().padStart(2, "0")
    }
    if (block.block_type_offset !== undefined) {
      bytes[block.block_type_offset] = blockIndex === 0
        ? block.start_block_type ?? "00"
        : block.middle_block_type ?? "05"
    }
    if (block.address_offset !== undefined && block.address_length) {
      bytes.splice(
        block.address_offset,
        block.address_length,
        ...encodeUnsignedInteger(startAddress + BigInt(blockIndex * payloadCapacity), block.address_length, scalarByteOrder),
      )
    }
    if (block.length_offset !== undefined && block.length_length) {
      bytes.splice(
        block.length_offset,
        block.length_length,
        ...encodeUnsignedInteger(BigInt(payloadCapacity), block.length_length, scalarByteOrder),
      )
    }
    const frameChecksums = applyDtpBlockFrameChecksums(bytes, protocol)
    bytes.splice(0, bytes.length, ...frameChecksums.bytes)
    warnings.push(...frameChecksums.warnings)
    lines.push(bytes.join(" "))
  }

  const checkBytes = spaceWireTemplateBytes(checkFrame, totalBytes)
  if (block.block_type_offset !== undefined) checkBytes[block.block_type_offset] = block.check_block_type ?? "0A"
  if (block.address_offset !== undefined && block.address_length) {
    checkBytes.splice(block.address_offset, block.address_length, ...encodeUnsignedInteger(startAddress, block.address_length, scalarByteOrder))
  }
  if (block.length_offset !== undefined && block.length_length) {
    checkBytes.splice(block.length_offset, block.length_length, ...encodeUnsignedInteger(BigInt(payload.length), block.length_length, scalarByteOrder))
  }
  for (const checksum of block.checksums) {
    if (checksum.algorithm === "sum_low32" && checksum.source === "payload_image") {
      const sum = payload.reduce((value, byte) => (value + BigInt(byte)) & 0xffffffffn, 0n)
      const checksumOrder = checksum.byte_order === "little" ? "little" : "big"
      if (checksum.byte_order === "unknown") warnings.push(`${checksum.name} byte order is unknown; big-endian document order was used.`)
      checkBytes.splice(checksum.output_offset, checksum.output_length, ...encodeUnsignedInteger(sum, checksum.output_length, checksumOrder))
    }
  }
  const checkFrameChecksums = applyDtpBlockFrameChecksums(checkBytes, protocol)
  checkBytes.splice(0, checkBytes.length, ...checkFrameChecksums.bytes)
  warnings.push(...checkFrameChecksums.warnings)
  lines.push(checkBytes.join(" "))
  if (payloadResolution.file) warnings.push(`SpaceWire payload was loaded from ${payloadResolution.file}.`)
  return { content: `${lines.join("\n")}\n`, warnings: uniqueStrings(warnings) }
}

function unresolvedFrameFields(protocol: DtpProtocolDefinition): string[] {
  const availableFields = new Set([
    ...protocol.fields.map((field) => field.name.toUpperCase()),
    ...(protocol.variants ?? []).flatMap((variant) => variant.fields.map((field) => field.name.toUpperCase())),
  ])
  return uniqueStrings(
    protocolFrameLayouts(protocol)
      .flat()
      .map((token) => token.match(/^(W\d+)$/i)?.[1]?.toUpperCase())
      .filter((fieldName): fieldName is string => Boolean(fieldName))
      .filter((fieldName) => !availableFields.has(fieldName)),
  )
}

function withFallbackFields(
  protocol: DtpProtocolDefinition,
  unresolvedFields: string[],
  reason: string,
): DtpProtocolDefinition {
  const fallbackFields: DtpProtocolFieldDefinition[] = unresolvedFields.map((fieldName) => ({
    name: fieldName,
    type: "fixed",
    value: "00",
    source: "fallback-zero",
    confidence: 0,
    warnings: [`${fieldName} used 00 fallback because ${reason}`],
  }))

  return {
    ...protocol,
    fields: [...protocol.fields, ...fallbackFields],
    warnings: uniqueStrings([
      ...protocol.warnings,
      `Fallback-zero was used for unresolved frame fields ${unresolvedFields.join(", ")}: ${reason}`,
    ]),
  }
}

export function writeDtpProtocolDataFiles(
  paths: DefaultPaths,
  definitions: DtpProtocolDefinitionsDocument,
  dataFileIndex: GeneratedDataFileIndex,
  options: DtpProtocolWriterOptions = {},
): DtpProtocolDataWriterResult {
  const maxVariantCombinations = Math.max(1, options.maxVariantCombinations ?? 64)
  const unknownFlowPolicy = options.unknownFlowPolicy ?? "warn_and_skip"
  const dryRun = options.dryRun ?? false
  const directoryLayout = options.directoryLayout ?? "flow"
  const generatedFiles: GeneratedDataFileIndexEntry[] = []
  const usedRelativePaths = new Set<string>()
  const skippedProtocols: DtpProtocolDataWriterResult["skipped_protocols"] = []
  const warnings: string[] = []

  for (const protocol of definitions.protocols) {
    if (protocol.generation_mode === "skip") {
      skippedProtocols.push({ protocol_id: protocol.protocol_id, reason: "Protocol generation_mode is skip." })
      continue
    }

    const flowDirection = protocol.flow_direction === "unknown"
      ? (unknownFlowPolicy === "warn_and_put_input" ? "input" : "unknown")
      : protocol.flow_direction
    if (flowDirection === "unknown") {
      skippedProtocols.push({
        protocol_id: protocol.protocol_id,
        reason: "Protocol flow_direction is unknown.",
      })
      continue
    }

    const unresolvedFields = unresolvedFrameFields(protocol)
    if (unresolvedFields.length) {
      if (!options.allowFallbackForUnresolvedFields) {
        skippedProtocols.push({
          protocol_id: protocol.protocol_id,
          reason: `Protocol frame has unresolved fields: ${unresolvedFields.join(", ")}.`,
        })
        continue
      }
    }

    const protocolForWrite = unresolvedFields.length
      ? withFallbackFields(
        protocol,
        unresolvedFields,
        options.fallbackReason ?? "protocol understanding retry could not resolve them",
      )
      : protocol

    if (protocolForWrite.generation_mode === "one_file_per_dictionary_row" && !hasExpandableDictionaryRows(protocolForWrite)) {
      skippedProtocols.push({
        protocol_id: protocolForWrite.protocol_id,
        reason: "Dictionary-row protocol has no valid variants or enum options to expand.",
      })
      continue
    }

    const variants = protocolVariants(protocolForWrite, maxVariantCombinations)
    if (variants.length >= maxVariantCombinations) {
      warnings.push(`Protocol ${protocolForWrite.protocol_id} variant expansion reached max ${maxVariantCombinations}.`)
    }

    for (const variant of variants) {
      const frame = renderProtocolFrameContent(protocolForWrite, variant.values, paths)
      if (!frame.content) {
        skippedProtocols.push({
          protocol_id: protocolForWrite.protocol_id,
          reason: frame.warnings.join("; ") || "Protocol frame could not be rendered.",
        })
        continue
      }

      const safeProtocolBaseName = protocolFileNameBase(protocolForWrite)
      const baseName = variant.suffix ? `${safeProtocolBaseName}-${variant.suffix}` : safeProtocolBaseName
      let requestedName = `${cleanGeneratedDataFileBaseName(baseName)}.txt`
      let relativePath = decideBusinessPath(requestedName, flowDirection, directoryLayout)
      if (usedRelativePaths.has(relativePath.toLowerCase())) {
        requestedName = `${cleanGeneratedDataFileBaseName(baseName)}-${flowDirectoryName(flowDirection)}.txt`
        relativePath = decideBusinessPath(requestedName, flowDirection, directoryLayout)
      }
      usedRelativePaths.add(relativePath.toLowerCase())
      const fullPath = join(paths.inputDataRoot, relativePath)
      const robotFilePath = toRuntimeInputDataPath(relativePath)
      if (!dryRun) {
        ensureDirectory(dirname(fullPath))
        writeFileSync(fullPath, frame.content, "utf-8")
      }

      const entry: GeneratedDataFileIndexEntry = {
        id: normalizeLookupText(`${protocolForWrite.protocol_id}-${requestedName}`) || `${Date.now()}-${generatedFiles.length}`,
        protocol_name: safeProtocolBaseName,
        requested_file_name: requestedName,
        file_path: robotFilePath,
        absolute_file_path: fullPath,
        source: "pre-generated",
        source_documents: dataFileIndex.source_documents,
        generation_basis: [
          "dtp-protocol-definitions",
          protocolForWrite.understanding_source,
          ...protocolForWrite.evidence,
        ],
        checksum_rule: getDtpPrimaryProtocolFrame(protocolForWrite)?.checksum?.expression ??
          getDtpPrimaryProtocolFrame(protocolForWrite)?.checksum?.type,
        field_value_plan: variant.fieldValuePlan,
        flow_direction: flowDirection,
        source_section: protocolForWrite.source_section,
        source_flow_heading: flowHeadingName(flowDirection),
        confidence: protocolForWrite.confidence,
        state: "generated",
        warnings: uniqueStrings([
          ...protocolForWrite.warnings,
          ...variant.warnings,
          ...frame.warnings,
        ]),
      }
      if (!dryRun) appendDataFileIndexEntry(dataFileIndex, entry)
      generatedFiles.push(entry)
    }
  }

  return {
    schema_version: "1.0.0",
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    generated_files: dedupeGeneratedDataFiles(generatedFiles),
    skipped_protocols: skippedProtocols,
    warnings: uniqueStrings(warnings),
  }
}

function cloneGeneratedDataFileIndex(index: GeneratedDataFileIndex): GeneratedDataFileIndex {
  return JSON.parse(JSON.stringify(index)) as GeneratedDataFileIndex
}

function sortedUniquePaths(entries: GeneratedDataFileIndexEntry[]): string[] {
  return uniqueStrings(entries.map((entry) => entry.file_path)).sort()
}

function dedupeGeneratedDataFiles(entries: GeneratedDataFileIndexEntry[]): GeneratedDataFileIndexEntry[] {
  const deduped = new Map<string, GeneratedDataFileIndexEntry>()
  for (const entry of entries) {
    deduped.set(entry.file_path || `${entry.protocol_name ?? ""}\u0000${entry.requested_file_name}`, entry)
  }
  return Array.from(deduped.values())
}

export function buildDtpProtocolWriterPreview(
  paths: DefaultPaths,
  definitions: DtpProtocolDefinitionsDocument,
  dataFileIndex: GeneratedDataFileIndex,
  options: DtpProtocolWriterOptions = {},
): DtpProtocolWriterPreviewDocument {
  const protocolWriterResult = writeDtpProtocolDataFiles(
    paths,
    definitions,
    cloneGeneratedDataFileIndex(dataFileIndex),
    { ...options, dryRun: true },
  )
  const protocolPaths = sortedUniquePaths(protocolWriterResult.generated_files)

  return {
    schema_version: "1.0.0",
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    legacy_generated_count: 0,
    protocol_writer_generated_count: protocolPaths.length,
    matched_file_paths: [],
    legacy_only_file_paths: [],
    protocol_writer_only_file_paths: [],
    skipped_protocols: protocolWriterResult.skipped_protocols,
    warnings: protocolWriterResult.warnings,
    updated_at: new Date().toISOString(),
  }
}

export function writeDtpProtocolWriterPreview(previewFile: string, preview: DtpProtocolWriterPreviewDocument): void {
  ensureDirectory(dirname(previewFile))
  writeFileSync(previewFile, `${JSON.stringify(preview, null, 2)}\n`, "utf-8")
}

function expectedChecksumFromProtocolLayout(
  bytes: string[],
  protocol: DtpProtocolDefinition | undefined,
  lineIndex = 0,
): string | undefined {
  if (!protocol) return undefined
  const frame = getDtpProtocolFrames(protocol)[lineIndex] ?? getDtpPrimaryProtocolFrame(protocol)
  if (frame?.checksum?.type !== "sum_low8") return undefined

  const layout = protocolFrameLayouts(protocol)[lineIndex] ?? frame.byte_layout
  const layoutSumIndex = layout.findIndex((item) => /^SUM$/i.test(item))
  if (layoutSumIndex < 0) return undefined

  const actualSumIndex = Math.min(layoutSumIndex, bytes.length - 1)
  const checksumIndexes = protocolChecksumIndexes(frame, layout, actualSumIndex)
  const checksumBytes = bytes.filter((_, index) => checksumIndexes.has(index))
  return checksumBytes.length ? computeByteSum(checksumBytes) : undefined
}

function validateGeneratedDataFileContent(
  entry: GeneratedDataFileIndexEntry,
  protocol?: DtpProtocolDefinition,
): DtpDataQualityIssue[] {
  const issues: DtpDataQualityIssue[] = []
  if (!entry.absolute_file_path || !existsSync(entry.absolute_file_path)) {
    issues.push({
      severity: "error",
      type: "missing_generated_file",
      file_path: entry.file_path,
      reason: "Generated data file is missing on disk.",
      recommended_fix: "Regenerate the affected protocol data file.",
    })
    return issues
  }

  const lines = decodeTextFile(entry.absolute_file_path)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))

  const block = protocol?.block_layout
  const normalizedBlockLines = block
    ? lines.map((line) => line.split(/\s+/).map((byte) => normalizeHexByte(byte)))
    : []
  if (block && normalizedBlockLines.every((line) => line.every(Boolean))) {
    const blockLines = normalizedBlockLines.map((line) => line as string[][][number])
    for (const [lineIndex, line] of blockLines.entries()) {
      if (line.length !== block.total_bytes) {
        issues.push({
          severity: "error",
          type: "length_mismatch",
          file_path: entry.file_path,
          reason: `SpaceWire block ${lineIndex + 1} contains ${line.length} bytes, expected ${block.total_bytes}.`,
          recommended_fix: "Regenerate the file from the canonical fixed-block layout.",
        })
      }
      for (const checksum of block.checksums.filter((item) => item.algorithm === "iso_8473" && item.source === "frame_range")) {
        if (
          line.length !== block.total_bytes ||
          checksum.source_start === undefined ||
          checksum.source_end === undefined ||
          checksum.output_length !== 2
        ) continue
        const expected = computeIso8473Checksum(line.slice(checksum.source_start, checksum.source_end + 1))
        const actual = line.slice(checksum.output_offset, checksum.output_offset + checksum.output_length)
        if (actual.join(" ") !== expected.join(" ")) {
          issues.push({
            severity: "error",
            type: "checksum_mismatch",
            file_path: entry.file_path,
            reason: `SpaceWire block ${lineIndex + 1} ${checksum.name} is ${actual.join(" ")}, expected ${expected.join(" ")}.`,
            recommended_fix: "Recompute the ISO 8473 checksum over the canonical frame range.",
          })
        }
      }
    }
    if (block.kind === "spacewire_program_upload" && block.block_type_offset !== undefined) {
      const blockTypes = blockLines.map((line) => line[block.block_type_offset!])
      const validSequence = blockLines.length >= 2 &&
        blockTypes[0] === normalizeHexByte(block.start_block_type) &&
        blockTypes.at(-1) === normalizeHexByte(block.check_block_type) &&
        blockTypes.slice(1, -1).every((value) => value === normalizeHexByte(block.middle_block_type))
      if (!validSequence) {
        issues.push({
          severity: "error",
          type: "length_mismatch",
          file_path: entry.file_path,
          reason: "SpaceWire block sequence is not start-block, zero or more middle-blocks, then check-block.",
          recommended_fix: "Regenerate the SpaceWire program upload from its canonical block layout.",
        })
      }
      const scalarOrder = block.scalar_byte_order === "little" ? "little" : "big"
      const decodeUnsigned = (bytes: string[]): bigint => {
        const ordered = scalarOrder === "little" ? bytes.slice().reverse() : bytes
        return BigInt(`0x${ordered.join("") || "0"}`)
      }
      const dataBlocks = blockLines.slice(0, -1)
      const checkBlock = blockLines.at(-1)
      if (block.address_offset !== undefined && block.address_length && block.start_address) {
        const startAddress = BigInt(`0x${block.start_address.replace(/^0x/i, "")}`)
        for (const [blockIndex, dataBlock] of dataBlocks.entries()) {
          const actualAddress = decodeUnsigned(dataBlock.slice(block.address_offset, block.address_offset + block.address_length))
          const expectedAddress = startAddress + BigInt(blockIndex * (block.payload_capacity ?? 0))
          if (actualAddress !== expectedAddress) {
            issues.push({
              severity: "error",
              type: "length_mismatch",
              file_path: entry.file_path,
              reason: `SpaceWire data block ${blockIndex + 1} address is ${actualAddress.toString(16).toUpperCase()}, expected ${expectedAddress.toString(16).toUpperCase()}.`,
              recommended_fix: "Regenerate block addresses from the start address and payload capacity.",
            })
          }
        }
      }
      if (block.length_offset !== undefined && block.length_length && checkBlock) {
        for (const [blockIndex, dataBlock] of dataBlocks.entries()) {
          const declaredLength = decodeUnsigned(dataBlock.slice(block.length_offset, block.length_offset + block.length_length))
          if (declaredLength !== BigInt(block.payload_capacity ?? 0)) {
            issues.push({
              severity: "error",
              type: "length_mismatch",
              file_path: entry.file_path,
              reason: `SpaceWire data block ${blockIndex + 1} declares ${declaredLength} bytes, expected ${block.payload_capacity ?? 0}.`,
              recommended_fix: "Regenerate the block length from block_layout.payload_capacity.",
            })
          }
        }
        const payloadLength = decodeUnsigned(checkBlock.slice(block.length_offset, block.length_offset + block.length_length))
        const payloadCapacity = block.payload_capacity ?? 0
        const payloadOffset = block.payload_offset ?? 0
        const availablePayload = dataBlocks.flatMap((line) => line.slice(payloadOffset, payloadOffset + payloadCapacity))
        if (payloadLength > BigInt(availablePayload.length)) {
          issues.push({
            severity: "error",
            type: "length_mismatch",
            file_path: entry.file_path,
            reason: `SpaceWire check block declares ${payloadLength} payload bytes, but only ${availablePayload.length} bytes are available.`,
            recommended_fix: "Regenerate the block sequence and check-block payload length from the same program image.",
          })
        } else {
          const checksum = block.checksums.find((item) => item.algorithm === "sum_low32" && item.source === "payload_image")
          if (checksum) {
            const payloadBytes = availablePayload.slice(0, Number(payloadLength))
            const expected = payloadBytes.reduce((sum, byte) => (sum + BigInt(`0x${byte}`)) & 0xffffffffn, 0n)
            const checksumBytes = checkBlock.slice(checksum.output_offset, checksum.output_offset + checksum.output_length)
            const checksumOrder = checksum.byte_order === "little" ? "little" : "big"
            const actual = BigInt(`0x${(checksumOrder === "little" ? checksumBytes.slice().reverse() : checksumBytes).join("") || "0"}`)
            if (actual !== expected) {
              issues.push({
                severity: "error",
                type: "checksum_mismatch",
                file_path: entry.file_path,
                reason: `SpaceWire program checksum mismatch: expected ${expected.toString(16).toUpperCase()}, actual ${actual.toString(16).toUpperCase()}.`,
                recommended_fix: "Recompute the check-block checksum over the unpadded program image bytes.",
              })
            }
          }
        }
      }
    }
  }

  for (const [lineIndex, line] of lines.entries()) {
    const bytes = line.split(/\s+/).filter(Boolean)
    if (!bytes.length) continue
    const invalidByte = bytes.find((byte) => !normalizeHexByte(byte))
    if (invalidByte) {
      issues.push({
        severity: "error",
        type: "invalid_byte_content",
        file_path: entry.file_path,
        reason: `Invalid byte "${invalidByte}" found in generated data file.`,
        recommended_fix: "Regenerate this file from a valid protocol definition.",
      })
      continue
    }

    if (!block && /sum_low8|SUM|byte-sum/i.test(entry.checksum_rule ?? "") && bytes.length >= 4) {
      const actual = normalizeHexByte(bytes.at(-1))
      const expected = expectedChecksumFromProtocolLayout(bytes, protocol, lineIndex)
      if (actual && expected && expected !== actual) {
        issues.push({
          severity: "error",
          type: "checksum_mismatch",
          file_path: entry.file_path,
          reason: `Checksum mismatch: expected ${expected}, actual ${actual}.`,
          recommended_fix: "Recompute SUM over the checksum range declared by the canonical protocol.",
        })
      }
    }
    if (protocol?.bus_context?.bus_type === "SPI") {
      const frame = getDtpProtocolFrames(protocol)[lineIndex] ?? getDtpPrimaryProtocolFrame(protocol)
      const lengthField = frame?.field_layout.find((field) => field.role === "length")
      const dataOffsets = new Set(frame?.field_layout
        .filter((field) => field.role === "data")
        .flatMap((field) => Array.from({ length: field.byte_length }, (_, offset) => field.byte_offset + offset)))
      const actualLength = lengthField && bytes[lengthField.byte_offset]
        ? Number.parseInt(bytes[lengthField.byte_offset], 16)
        : undefined
      if (actualLength !== undefined && Number.isFinite(actualLength) && actualLength !== dataOffsets.size) {
        issues.push({
          severity: "error",
          type: "length_mismatch",
          file_path: entry.file_path,
          reason: `SPI LENGTH=${actualLength}, but the canonical frame defines ${dataOffsets.size} DATA byte(s).`,
          recommended_fix: "Regenerate LENGTH from the number of DATA bytes in the canonical SPI field layout.",
        })
      }
    }
  }

  return issues
}

function protocolKey(protocolName: string | undefined, flowDirection: string | undefined): string {
  return `${normalizeLookupText(protocolName)}\u0000${flowDirection ?? "unknown"}`
}

function buildProtocolLookup(definitions: DtpProtocolDefinitionsDocument): Map<string, DtpProtocolDefinition> {
  const lookup = new Map<string, DtpProtocolDefinition>()
  for (const protocol of definitions.protocols) {
    const key = protocolKey(protocol.base_file_name, protocol.flow_direction)
    if (!lookup.has(key)) lookup.set(key, protocol)
  }
  return lookup
}

export function buildDtpDataQualityReport(
  paths: DefaultPaths,
  definitions: DtpProtocolDefinitionsDocument,
  preview: DtpProtocolWriterPreviewDocument,
  dataFileIndex: GeneratedDataFileIndex,
): DtpDataQualityReport {
  const issues: DtpDataQualityIssue[] = []
  const protocolLookup = buildProtocolLookup(definitions)

  for (const skipped of preview.skipped_protocols) {
    issues.push({
      severity: "warning",
      type: "skipped_protocol",
      protocol_id: skipped.protocol_id,
      reason: skipped.reason,
      recommended_fix: "Review protocol definition flow direction, generation mode, and frame layout.",
    })
  }

  for (const protocol of definitions.protocols) {
    if (protocol.flow_direction === "unknown" && protocol.generation_mode !== "skip") {
      issues.push({
        severity: "warning",
        type: "unknown_flow",
        protocol_id: protocol.protocol_id,
        reason: "Protocol flow_direction is unknown, so it cannot be safely placed under 输入流 or 输出流.",
        recommended_fix: "Improve model understanding or source flow-block extraction.",
      })
    }
    for (const warning of protocol.warnings) {
      issues.push({
        severity: "info",
        type: "protocol_warning",
        protocol_id: protocol.protocol_id,
        reason: warning,
      })
    }
  }

  const checkedEntries = dataFileIndex.entries.filter((entry) => entry.source === "pre-generated" && entry.state === "generated")
  for (const entry of checkedEntries) {
    const expectedFlowDir = flowDirectoryName(entry.flow_direction)
    const pathSegments = entry.file_path.split(/[\\/]+/).filter(Boolean)
    const validFlatPath = pathSegments.length === 2 && pathSegments[0] === "输入数据"
    const validFlowPath = pathSegments.length >= 3 &&
      pathSegments[0] === "输入数据" &&
      pathSegments[1] === expectedFlowDir
    if (!validFlatPath && !validFlowPath) {
      issues.push({
        severity: "error",
        type: "invalid_file_path",
        file_path: entry.file_path,
        reason: `Generated file path is outside the supported flat or flow-based input-data layout for ${entry.flow_direction ?? "unknown"}.`,
        recommended_fix: "Regenerate the project-level file directly under 输入数据, or keep a valid flow directory for case-level files.",
      })
    }
    const protocol = protocolLookup.get(protocolKey(entry.protocol_name ?? entry.requested_file_name, entry.flow_direction))
    for (const warning of entry.warnings) {
      issues.push({
        severity: warning.includes("Fallback-zero") || warning.includes("00 fallback") ? "warning" : "info",
        type: "protocol_warning",
        file_path: entry.file_path,
        protocol_id: protocol?.protocol_id,
        reason: warning,
        recommended_fix: warning.includes("Fallback-zero") || warning.includes("00 fallback")
          ? "Revise the affected protocol definition so deterministic writer no longer needs 00 fallback."
          : undefined,
      })
    }
    issues.push(...validateGeneratedDataFileContent(entry, protocol))
  }

  const issueCounts = {
    error: issues.filter((issue) => issue.severity === "error").length,
    warning: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
  }
  const status: DtpDataQualityReport["status"] = issueCounts.error > 0 ? "fail" : issueCounts.warning > 0 ? "warning" : "pass"

  return {
    schema_version: "1.0.0",
    status,
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    protocol_writer_preview_file: paths.dtpProtocolWriterPreviewFile,
    generated_data_files_index_file: paths.generatedDataFilesIndexFile,
    checked_file_count: checkedEntries.length,
    issue_counts: issueCounts,
    issues,
    warnings: preview.warnings,
    updated_at: new Date().toISOString(),
  }
}

export function writeDtpDataQualityReport(reportFile: string, report: DtpDataQualityReport): void {
  ensureDirectory(dirname(reportFile))
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf-8")
}

function inferProtocolIdsForIssue(issue: DtpDataQualityIssue, definitions: DtpProtocolDefinitionsDocument): string[] {
  if (issue.protocol_id) return [issue.protocol_id]
  const filePathKey = normalizeLookupText(issue.file_path)
  if (!filePathKey) return []

  return definitions.protocols
    .filter((protocol) => {
      const nameKey = normalizeLookupText(protocol.base_file_name)
      return nameKey && filePathKey.includes(nameKey)
    })
    .map((protocol) => protocol.protocol_id)
}

export function buildDtpProtocolRetryContext(
  paths: DefaultPaths,
  definitions: DtpProtocolDefinitionsDocument,
  preview: DtpProtocolWriterPreviewDocument,
  qualityReport: DtpDataQualityReport,
): DtpProtocolRetryContext {
  const actionableIssues = qualityReport.issues.filter((issue) => issue.severity !== "info")
  const protocolsById = new Map(definitions.protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const issuesByProtocol = new Map<string, DtpDataQualityIssue[]>()
  const issuesByFile = new Map<string, DtpDataQualityIssue[]>()

  for (const issue of actionableIssues) {
    for (const protocolId of inferProtocolIdsForIssue(issue, definitions)) {
      const issues = issuesByProtocol.get(protocolId) ?? []
      issues.push(issue)
      issuesByProtocol.set(protocolId, issues)
    }
    if (issue.file_path) {
      const issues = issuesByFile.get(issue.file_path) ?? []
      issues.push(issue)
      issuesByFile.set(issue.file_path, issues)
    }
  }

  const status: DtpProtocolRetryContext["status"] = actionableIssues.length ? "ready" : "not_needed"

  return {
    schema_version: "1.0.0",
    status,
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    quality_report_file: paths.dtpDataQualityReportFile,
    protocol_writer_preview_file: paths.dtpProtocolWriterPreviewFile,
    affected_protocols: Array.from(issuesByProtocol.entries()).map(([protocolId, issues]) => ({
      protocol_id: protocolId,
      protocol: protocolsById.get(protocolId),
      issues,
    })),
    affected_files: Array.from(issuesByFile.entries()).map(([filePath, issues]) => ({
      file_path: filePath,
      issues,
    })),
    preview_differences: {
      legacy_only_file_paths: preview.legacy_only_file_paths,
      protocol_writer_only_file_paths: preview.protocol_writer_only_file_paths,
    },
    guidance: [
      "Use this retry context to revise dtp-protocol-definitions for affected protocols only.",
      "Do not generate .txt content directly in the model response; return corrected protocol definitions.",
      "Resolve unknown flow directions from input/output flow evidence before writing files.",
      "Keep checksum bytes out of model-computed content; deterministic code recomputes SUM/CRC.",
    ],
    warnings: status === "not_needed" ? ["No actionable DTP data quality issue was found."] : [],
    updated_at: new Date().toISOString(),
  }
}

export function writeDtpProtocolRetryContext(retryContextFile: string, retryContext: DtpProtocolRetryContext): void {
  ensureDirectory(dirname(retryContextFile))
  writeFileSync(retryContextFile, `${JSON.stringify(retryContext, null, 2)}\n`, "utf-8")
}
