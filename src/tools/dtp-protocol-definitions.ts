import { createHash } from "crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs"
import { dirname } from "path"
import type {
  DefaultPaths,
  DtpDataModelHooks,
  DtpNonGeneratedTable,
  DtpProtocolBusContext,
  DtpProtocolBusProfile,
  DtpProtocolBlockDefinition,
  DtpProtocolChecksumDefinition,
  DtpProtocolContextPackage,
  DtpProtocolDefinition,
  DtpProtocolDefinitionValidationIssue,
  DtpProtocolDefinitionValidationResult,
  DtpProtocolDefinitionsDocument,
  DtpProtocolReferenceEvidence,
  DtpProtocolFieldLayout,
  DtpProtocolFieldRole,
  DtpProtocolFrameDefinition,
  DtpProtocolGroup,
  DtpProtocolInterfaceEnvelope,
  DtpProtocolProvenance,
  DtpProtocolRelation,
  DtpProtocolSemanticRole,
  DtpProtocolSemanticIdentity,
  DtpProtocolFieldDefinition,
  DtpProtocolFieldOption,
  DtpProtocolFlowBlock,
  DtpProtocolFrameEnvelope,
  DtpProtocolFamily,
  DtpProtocolFamilyVariant,
  DtpProtocolSelectorRelation,
  DtpProtocolValueRule,
  DtpProtocolVariableDefinition,
  DtpProtocolVariantDefinition,
  PacketFieldValuePlan,
  ProjectKnowledgeIndex,
  ProjectKnowledgeReference,
  ProjectKnowledgeSnippet,
  ProjectKnowledgeTable,
  SectionProtocolModel,
  SectionProtocolRelation,
  SectionProtocolRelationTableInput,
  FlowDirection,
} from "./dtp-data-generation-core"
import {
  prepareProtocolUnderstandingContexts,
  prepareRequestedProtocolEvidenceContext,
  type DtpModelEvidenceRequest,
} from "./dtp-model-evidence"

const DEFAULT_CHECKSUM_RULE = "SUM = low8(byte-sum(TITLE + W0 + W1 + ... + W(n-1)))"
const SPI_CHECKSUM_RULE = "SUM = low8(byte-sum(ADDRESS + LENGTH + DATA0 + ... + DATAn))"
const DEFAULT_DTP_PROTOCOL_UNDERSTANDING_TIMEOUT_MS = 100_000
const DEFAULT_DTP_MODEL_SECTION_CONCURRENCY = 3

function ensureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })
}

function readPositiveIntegerEnv(name: string, defaultValue: number, options?: { min?: number; max?: number }): number {
  const raw = process.env[name]
  const parsed = raw ? Number(raw) : NaN
  if (!Number.isFinite(parsed)) return defaultValue
  const rounded = Math.floor(parsed)
  const min = options?.min ?? 1
  const max = options?.max ?? Number.MAX_SAFE_INTEGER
  return Math.min(max, Math.max(min, rounded))
}

function getDtpProtocolUnderstandingTimeoutMs(): number {
  return readPositiveIntegerEnv(
    "DTP_PROTOCOL_UNDERSTANDING_TIMEOUT_MS",
    DEFAULT_DTP_PROTOCOL_UNDERSTANDING_TIMEOUT_MS,
    { min: 10_000, max: 10 * 60_000 },
  )
}

function protocolUnderstandingTimeoutMs(context: DtpProtocolContextPackage): number {
  if (process.env.DTP_PROTOCOL_UNDERSTANDING_TIMEOUT_MS) return getDtpProtocolUnderstandingTimeoutMs()
  return context.model_timeout_ms ?? getDtpProtocolUnderstandingTimeoutMs()
}

function getDtpModelSectionConcurrency(): number {
  return readPositiveIntegerEnv("DTP_MODEL_SECTION_CONCURRENCY", DEFAULT_DTP_MODEL_SECTION_CONCURRENCY, {
    min: 1,
    max: 6,
  })
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex
        nextIndex += 1
        results[currentIndex] = await worker(items[currentIndex], currentIndex)
      }
    }),
  )

  return results
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function getNestedArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
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

function inferTableProtocolIdentity(
  context: DtpProtocolContextPackage,
  table: SectionProtocolRelationTableInput,
): { baseName: string; flowDirection: "input" | "output" | "unknown" } {
  const captionName = cleanGeneratedDataFileBaseName(table.caption ?? table.id)
    .replace(/(?:\u6570\u636e)?\u683c\u5f0f(?:\u5b9a\u4e49)?$/i, "")
  const sectionText = context.section_text ?? ""
  const captionIndex = table.caption ? sectionText.indexOf(table.caption) : -1
  const flowMarkers = Array.from(sectionText.matchAll(
    /(?:^|\n)\s*(\u8f93\u5165|\u8f93\u51fa)\u6d41?(?:\s*\d+)?\s*[:\uff1a]\s*([^\uff0c,\u3002\uff1b;\n\r]+)/g,
  )).map((match) => ({
    index: match.index ?? -1,
    direction: match[1] === "\u8f93\u5165" ? "input" as const : "output" as const,
    name: cleanGeneratedDataFileBaseName(match[2]),
  }))
  const nearest = captionIndex >= 0
    ? flowMarkers.filter((marker) => marker.index <= captionIndex).at(-1)
    : flowMarkers.find((marker) => {
        const markerName = normalizeLookupText(marker.name)
        const normalizedCaption = normalizeLookupText(captionName)
        return markerName.includes(normalizedCaption) || normalizedCaption.includes(markerName)
      })
  return {
    baseName: nearest?.name || captionName,
    flowDirection: nearest?.direction ?? "unknown",
  }
}

function usablePreferredProtocolName(value: string | undefined): string | undefined {
  const cleaned = cleanGeneratedDataFileBaseName(value)
  return cleaned === "unnamed" || looksLikeFrameHeaderBaseName(cleaned) ? undefined : cleaned
}

function containsCjk(value: string | undefined): boolean {
  return /[\u3400-\u9FFF]/.test(value ?? "")
}

function preferredProtocolIdentity(
  modelName: string | undefined,
  inferredName: string,
): { baseName: string; aliases: string[] } {
  const cleanedModelName = usablePreferredProtocolName(modelName)
  const cleanedInferredName = usablePreferredProtocolName(inferredName) ?? inferredName
  const modelLooksMachineGenerated = Boolean(
    cleanedModelName &&
    !containsCjk(cleanedModelName) &&
    containsCjk(cleanedInferredName) &&
    /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(cleanedModelName),
  )
  const baseName = !cleanedModelName || modelLooksMachineGenerated
    ? cleanedInferredName
    : cleanedModelName
  return {
    baseName,
    aliases: uniqueStrings([cleanedModelName, cleanedInferredName].filter((item): item is string => Boolean(item && item !== baseName))),
  }
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

function resolveDictionaryProtocolBaseName(
  relation: SectionProtocolRelation,
  frameTable: SectionProtocolRelationTableInput,
  dictionaryTable: SectionProtocolRelationTableInput | undefined,
): string {
  const preferredName = relation.preferred_name ? cleanGeneratedDataFileBaseName(relation.preferred_name) : ""
  if (preferredName && !looksLikeFrameHeaderBaseName(preferredName)) return preferredName

  const dictionaryName = dictionaryTable ? cleanDictionaryProtocolBaseName(dictionaryTable.caption ?? dictionaryTable.id) : ""
  if (dictionaryName && !looksLikeFrameHeaderBaseName(dictionaryName)) return dictionaryName

  const frameName = cleanGeneratedDataFileBaseName(frameTable.caption ?? frameTable.id)
  if (frameName && !looksLikeFrameHeaderBaseName(frameName)) return frameName

  return "\u534f\u8bae"
}

function normalizeHexByte(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(?:0x)?([0-9a-fA-F]{1,2})H?$/)
  return match?.[1]?.toUpperCase().padStart(2, "0")
}

function snippetOrdinal(snippet: ProjectKnowledgeSnippet): number {
  return Number(snippet.id.match(/snippet-(\d+)$/)?.[1] ?? 0)
}

function tableOrdinal(table: ProjectKnowledgeTable | SectionProtocolRelationTableInput): number {
  if ("ordinal" in table) return table.ordinal
  return Number(table.id.match(/table-(\d+)$/)?.[1] ?? 0)
}

function isFrameFormatTable(table: ProjectKnowledgeTable): boolean {
  const tableText = [table.caption, ...table.rows.map((row) => row.join(" "))].filter(Boolean).join(" ")
  const isCanFrame = /\u5e27\u5e8f|\u4ef2\u88c1\u573a|\u63a7\u5236\u573a|DLC|RTR/i.test(tableText)
  const isSpiFrame = /\bADDRESS\b/i.test(tableText) &&
    /\bLENGTH\b/i.test(tableText) &&
    /\bDATA\s*\d+/i.test(tableText) &&
    /\bSUM\b/i.test(tableText)
  const isSpaceWireBlock = /(?:Space\s*wire|\u4e0a\u6ce8\u6570\u636e\u5757)/i.test(tableText) &&
    /W\s*0\s*[~～\-]\s*W\s*1/i.test(tableText) &&
    /W\s*716\b/i.test(tableText) &&
    /W\s*719\b/i.test(tableText)
  return isCanFrame || isSpiFrame || isSpaceWireBlock
}

function findTableCaptionSnippetOrdinal(table: ProjectKnowledgeTable, snippets: ProjectKnowledgeSnippet[]): number {
  const captionKey = normalizeLookupText(table.caption ?? "")
  if (!captionKey) return Number.MAX_SAFE_INTEGER

  const matched = snippets.find((snippet) => {
    if (snippet.source_document_id !== table.source_document_id) return false
    const snippetKey = normalizeLookupText(snippet.text)
    const looksLikeTableCaption = /^\s*(?:表|附表)\s*[A-Za-z0-9]/.test(snippet.text)
    return snippetKey && (snippetKey.includes(captionKey) || (looksLikeTableCaption && captionKey.includes(snippetKey)))
  })

  return matched ? snippetOrdinal(matched) : Number.MAX_SAFE_INTEGER
}

function tableBelongsToFlow(table: ProjectKnowledgeTable, flowSnippetIds: string[], snippets: ProjectKnowledgeSnippet[]): boolean {
  if (!flowSnippetIds.length) return false
  const flowOrdinals = flowSnippetIds
    .map((id) => snippets.find((snippet) => snippet.id === id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .map(snippetOrdinal)
  if (!flowOrdinals.length) return false
  const tableOrdinalValue = findTableCaptionSnippetOrdinal(table, snippets)
  return tableOrdinalValue >= Math.min(...flowOrdinals) && tableOrdinalValue <= Math.max(...flowOrdinals)
}

function flowHeadingName(flowDirection: string | undefined): string | undefined {
  if (flowDirection === "input") return "\u8f93\u5165\u6d41"
  if (flowDirection === "output") return "\u8f93\u51fa\u6d41"
  return undefined
}

type CanInterfaceIdentity = {
  interfaceLevel: "primary" | "secondary" | "unknown"
  interfaceId?: string
  interfaceName?: string
}

function inferCanInterfaceIdentity(text: string): CanInterfaceIdentity {
  const normalized = text.replace(/\s+/g, "")
  const interfaceId = text.match(/IF-CAN\d+-\d+/i)?.[0]?.toUpperCase()
  const secondary = /\u4e8c\u7ea7CAN/i.test(normalized) || /^IF-CAN1-/i.test(interfaceId ?? "")
  const primary = /\u4e00\u7ea7CAN/i.test(normalized) || /^IF-CAN0-/i.test(interfaceId ?? "")
  return {
    interfaceLevel: secondary ? "secondary" : primary ? "primary" : "unknown",
    interfaceId,
    interfaceName: secondary
      ? "\u4e8c\u7ea7CAN\u603b\u7ebf\u63a5\u53e3"
      : primary
        ? "\u4e00\u7ea7CAN\u603b\u7ebf\u63a5\u53e3"
        : undefined,
  }
}

function inferNearestStructuralCanInterfaceIdentity(
  index: ProjectKnowledgeIndex,
  model: SectionProtocolModel,
): CanInterfaceIdentity {
  const sectionSnippetOrdinals = model.section_snippet_ids
    .map((id) => index.snippets.find((snippet) => snippet.id === id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .map(snippetOrdinal)
  const sectionStart = sectionSnippetOrdinals.length
    ? Math.min(...sectionSnippetOrdinals)
    : Number.MAX_SAFE_INTEGER
  const structuralCandidates = index.snippets
    .filter((snippet) => (
      snippet.source_document_id === model.source_document_id &&
      snippetOrdinal(snippet) < sectionStart &&
      (
        /(?:^|\s)(?:一级|二级)CAN总线接口及相关数据流\s*$/i.test(snippet.text) ||
        /^IF-CAN[01]-\d+\s*[:：]/i.test(snippet.text)
      )
    ))
    .sort((left, right) => snippetOrdinal(right) - snippetOrdinal(left))
  return structuralCandidates.length
    ? inferCanInterfaceIdentity(structuralCandidates[0].text)
    : { interfaceLevel: "unknown" }
}

export function inferDtpSectionCanInterfaceIdentity(
  index: ProjectKnowledgeIndex,
  model: SectionProtocolModel,
): CanInterfaceIdentity {
  // Flow prose may name a forwarding destination, not the owning interface.
  for (const heading of [...(model.section_path ?? [])].reverse().concat(model.section_title)) {
    const identity = inferCanInterfaceIdentity(heading.split(/(?:输入流|输出流)\s*[:：]/, 1)[0])
    if (identity.interfaceLevel !== "unknown" || identity.interfaceId) return identity
  }
  return inferNearestStructuralCanInterfaceIdentity(index, model)
}

function inferContextCanInterfaceIdentity(context: DtpProtocolContextPackage): CanInterfaceIdentity {
  const structural = inferCanInterfaceIdentity([
    ...(context.section_path ?? []),
    context.section_title,
  ].join(" "))
  if (structural.interfaceLevel !== "unknown" || structural.interfaceId) return structural
  return inferCanInterfaceIdentity(context.interface_context_text ?? "")
}

function applyContextCanInterfaceScope(
  context: DtpProtocolContextPackage,
  busContext: DtpProtocolBusContext | undefined,
): DtpProtocolBusContext | undefined {
  if (!busContext || busContext.bus_type !== "CAN") return busContext
  const identity = inferContextCanInterfaceIdentity(context)
  if (identity.interfaceLevel === "unknown" && !identity.interfaceId) return busContext
  const interfaceEvidence = [context.interface_context_text, context.section_text].filter(Boolean).join(" ")
  const secondaryFpga = identity.interfaceLevel === "secondary" && /FPGA/i.test(interfaceEvidence)
  const controller = secondaryFpga && (!busContext.controller || busContext.controller === "unknown")
    ? "FPGA"
    : busContext.controller
  return {
    ...busContext,
    interface_level: identity.interfaceLevel,
    interface_id: identity.interfaceId ?? busContext.interface_id,
    interface_name: identity.interfaceName ?? busContext.interface_name,
    profile_scope: "interface",
    controller,
  }
}

function applyContextBusInterfaceScope(
  context: DtpProtocolContextPackage,
  busContext: DtpProtocolBusContext | undefined,
): DtpProtocolBusContext | undefined {
  if (!busContext || busContext.bus_type === "CAN") return applyContextCanInterfaceScope(context, busContext)
  if (busContext.bus_type !== "SPI") return busContext
  const evidence = [
    ...(context.section_path ?? []),
    context.section_title,
    context.interface_context_text,
    context.section_text,
  ].filter(Boolean).join(" ")
  const interfaceId = evidence.match(/IF-SPI\d+(?:-\d+)?/i)?.[0]?.toUpperCase()
  return {
    ...busContext,
    interface_id: interfaceId ?? busContext.interface_id,
    interface_name: busContext.interface_name ?? "SPI\u603b\u7ebf\u63a5\u53e3",
    profile_scope: "interface",
    controller: busContext.controller ?? (/FPGA/i.test(evidence) ? "FPGA" : undefined),
  }
}

function extractDocumentCanBusProfiles(
  index: ProjectKnowledgeIndex,
  sourceDocumentId: string,
): DtpProtocolBusProfile[] {
  const evidenceItems = index.snippets
    .filter((snippet) =>
      snippet.source_document_id === sourceDocumentId &&
      snippet.topic === "hardware_interface",
    )
    .map((snippet) => ({
      text: snippet.text,
      confidence: snippet.confidence,
    }))

  for (const topic of index.topics) {
    if (
      topic.topic !== "hardware_interface" ||
      topic.source_document_ids.length !== 1 ||
      topic.source_document_ids[0] !== sourceDocumentId
    ) continue
    evidenceItems.push(...topic.facts.map((text) => ({ text, confidence: 0.7 })))
  }

  const profiles = new Map<string, DtpProtocolBusProfile>()
  for (const item of evidenceItems) {
    if (!/(?:\bCAN\b|CAN总线|SJA1000)/i.test(item.text)) continue
    const controller: DtpProtocolBusProfile["controller"] | undefined =
      /SJA1000T/i.test(item.text)
        ? "SJA1000T"
        : /SJA1000/i.test(item.text)
          ? "SJA1000"
          : undefined
    const mode: DtpProtocolBusProfile["mode"] | undefined =
      /PeliCAN/i.test(item.text)
        ? "PeliCAN"
        : /BasicCAN/i.test(item.text)
          ? "BasicCAN"
          : undefined
    if (!controller || !mode) continue

    const interfaceIdentity = inferCanInterfaceIdentity(item.text)
    const key = `${interfaceIdentity.interfaceId ?? interfaceIdentity.interfaceLevel}:SJA1000:${mode}`
    const existing = profiles.get(key)
    if (existing) {
      if (controller === "SJA1000T") existing.controller = controller
      existing.evidence = uniqueStrings([...existing.evidence, item.text])
      existing.confidence = Math.max(existing.confidence, item.confidence)
      continue
    }
    profiles.set(key, {
      source_document_id: sourceDocumentId,
      bus_type: "CAN",
      interface_level: interfaceIdentity.interfaceLevel,
      interface_id: interfaceIdentity.interfaceId,
      interface_name: interfaceIdentity.interfaceName,
      controller,
      controller_family: "SJA1000",
      mode,
      evidence: [item.text],
      confidence: item.confidence,
    })
  }

  return [...profiles.values()]
}

function resolvedReferenceTargetIds(reference: ProjectKnowledgeReference): string[] {
  return uniqueStrings([
    ...(reference.resolved_table_ids ?? []),
    reference.resolved_table_id ?? "",
    reference.resolved_section_model_id ?? "",
    reference.resolved_snippet_id ?? "",
    reference.resolved_document_id ?? "",
  ])
}

function collectResolvedReferenceClosure(
  index: ProjectKnowledgeIndex,
  model: SectionProtocolModel,
): {
  references: ProjectKnowledgeReference[]
  tableIds: string[]
  snippetIds: string[]
  evidence: DtpProtocolReferenceEvidence[]
} {
  const references: ProjectKnowledgeReference[] = []
  const tableIds = new Set<string>()
  const snippetIds = new Set<string>()
  const activeSnippetIds = new Set(model.section_snippet_ids)
  const activeTableIds = new Set(model.table_ids)
  const visitedReferenceIds = new Set<string>()
  const modelsById = new Map(index.section_protocol_models.map((candidate) => [candidate.id, candidate]))
  const maxReferenceDepth = 3

  for (let traversalDepth = 0; traversalDepth < maxReferenceDepth; traversalDepth += 1) {
    const nextSnippetIds = new Set<string>()
    const nextTableIds = new Set<string>()
    for (const reference of index.references) {
      if (reference.state !== "resolved" && reference.state !== "fallback_resolved") continue
      const identity = reference.reference_id ?? [
        reference.source_document_id,
        reference.source_snippet_id ?? "",
        reference.source_table_id ?? "",
        reference.reference_text,
      ].join("|")
      if (visitedReferenceIds.has(identity)) continue
      const sourceMatches = Boolean(
        (reference.source_snippet_id && activeSnippetIds.has(reference.source_snippet_id)) ||
        (reference.source_table_id && activeTableIds.has(reference.source_table_id)),
      )
      if (!sourceMatches) continue

      visitedReferenceIds.add(identity)
      references.push(reference)
      for (const tableId of reference.resolved_table_ids ?? (reference.resolved_table_id ? [reference.resolved_table_id] : [])) {
        tableIds.add(tableId)
        nextTableIds.add(tableId)
      }
      if (reference.resolved_snippet_id) {
        snippetIds.add(reference.resolved_snippet_id)
        nextSnippetIds.add(reference.resolved_snippet_id)
      }
      const referencedModel = reference.resolved_section_model_id
        ? modelsById.get(reference.resolved_section_model_id)
        : undefined
      for (const snippetId of referencedModel?.section_snippet_ids ?? []) {
        snippetIds.add(snippetId)
        nextSnippetIds.add(snippetId)
      }
      for (const tableId of referencedModel?.table_ids ?? []) {
        tableIds.add(tableId)
        nextTableIds.add(tableId)
      }
    }
    if (!nextSnippetIds.size && !nextTableIds.size) break
    for (const snippetId of nextSnippetIds) activeSnippetIds.add(snippetId)
    for (const tableId of nextTableIds) activeTableIds.add(tableId)
  }

  return {
    references,
    tableIds: Array.from(tableIds),
    snippetIds: Array.from(snippetIds),
    evidence: references.map((reference) => ({
      reference_id: reference.reference_id ?? `${reference.source_document_id}:${reference.reference_text}`,
      reference_text: reference.reference_text,
      source_id: reference.source_snippet_id ?? reference.source_table_id ?? reference.source_document_id,
      target_ids: resolvedReferenceTargetIds(reference),
      semantic_roles: reference.semantic_roles?.length ? reference.semantic_roles : ["unknown"],
      depth: reference.depth ?? 0,
      state: reference.state as "resolved" | "fallback_resolved",
      confidence: reference.confidence ?? (reference.state === "resolved" ? 1 : 0.75),
      warnings: reference.warnings ?? [],
    })),
  }
}

function buildDtpProtocolContextPackage(index: ProjectKnowledgeIndex, model: SectionProtocolModel): DtpProtocolContextPackage {
  const snippetsById = new Map(index.snippets.map((snippet) => [snippet.id, snippet]))
  const tablesById = new Map(index.tables.map((table) => [table.id, table]))
  const sectionSnippets = model.section_snippet_ids
    .map((id) => snippetsById.get(id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
  const inputFlowSnippets = model.input_flow_snippet_ids
    .map((id) => snippetsById.get(id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
  const outputFlowSnippets = model.output_flow_snippet_ids
    .map((id) => snippetsById.get(id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
  const interfaceIdentity = inferDtpSectionCanInterfaceIdentity(index, model)
  const interfaceContextText = index.snippets
    .filter((snippet) => {
      if (snippet.source_document_id !== model.source_document_id || snippet.topic !== "hardware_interface") return false
      const candidate = inferCanInterfaceIdentity(snippet.text)
      if (interfaceIdentity.interfaceId && candidate.interfaceId) {
        return interfaceIdentity.interfaceId === candidate.interfaceId
      }
      return interfaceIdentity.interfaceLevel !== "unknown" && candidate.interfaceLevel === interfaceIdentity.interfaceLevel
    })
    .map((snippet) => snippet.text)
    .join("\n\n")
  const referenceClosure = collectResolvedReferenceClosure(index, model)
  const referencedTableIds = referenceClosure.tableIds
  const referencedSnippetIds = referenceClosure.snippetIds
  const referencedContextText = referencedSnippetIds
    .map((id) => snippetsById.get(id)?.text)
    .filter((text): text is string => Boolean(text))
    .join("\n\n")
  const contextTableIds = uniqueStrings([...model.table_ids, ...referencedTableIds])
  const tables = contextTableIds
    .map((id) => tablesById.get(id))
    .filter((table): table is ProjectKnowledgeTable => Boolean(table))
    .sort((a, b) => tableOrdinal(a) - tableOrdinal(b))
  const tableInputs = tables.map((table) => ({
    id: table.id,
    caption: table.caption,
    ordinal: tableOrdinal(table),
    is_frame_format: isFrameFormatTable(table),
    headers: table.rows[0] ?? [],
    rows: table.rows,
    table_html: table.table_html,
    cells: table.cells,
    aliases: table.aliases,
    topic: table.topic,
  }))
  const flowBlock = (direction: "input" | "output", flowSnippets: ProjectKnowledgeSnippet[]): DtpProtocolFlowBlock => {
    const snippetIds = flowSnippets.map((snippet) => snippet.id)
    return {
      direction,
      heading_text: flowSnippets[0]?.text ?? "",
      snippet_ids: snippetIds,
      text: flowSnippets.map((snippet) => snippet.text).join("\n\n"),
      table_ids: tables
        .filter((table) => tableBelongsToFlow(table, snippetIds, sectionSnippets))
        .map((table) => table.id),
    }
  }

  return {
    section_model_id: model.id,
    source_document_id: model.source_document_id,
    section_id: model.section_id,
    section_title: model.section_title,
    section_path: model.section_path,
    interface_context_text: interfaceContextText || undefined,
    section_text: sectionSnippets.map((snippet) => snippet.text).join("\n\n"),
    referenced_context_text: referencedContextText || undefined,
    reference_evidence: referenceClosure.evidence,
    flow_blocks: {
      input: flowBlock("input", inputFlowSnippets),
      output: flowBlock("output", outputFlowSnippets),
    },
    tables: tableInputs,
    primary_table_ids: model.primary_table_ids,
    support_table_ids: uniqueStrings([
      ...model.support_table_ids,
      ...referencedTableIds.filter((tableId) => !model.primary_table_ids.includes(tableId)),
    ]),
    reference_backed: model.reference_backed,
    referenced_primary_table_ids: model.referenced_primary_table_ids,
    heuristic_relations: model.protocol_relations,
    bus_profiles: extractDocumentCanBusProfiles(index, model.source_document_id),
  }
}

export function buildDtpProtocolContextPackages(index: ProjectKnowledgeIndex): DtpProtocolContextPackage[] {
  return index.section_protocol_models.map((model) => buildDtpProtocolContextPackage(index, model))
}

function inlineDataFieldFromCell(cell: string): { name: string; value: string } | null {
  const normalized = cell
    .replace(/\s+/g, "")
    .replace(/[()（）:：=,，/]/g, "")
  const match = normalized.match(/^W(\d+?)([0-9A-Fa-f]{2})H$/i)
  if (!match?.[1] || !match[2]) return null
  return {
    name: `W${Number.parseInt(match[1], 10)}`,
    value: match[2].toUpperCase(),
  }
}

type StructuredFrameLayoutCell = {
  token: string
  fieldName?: string
  defaultValue?: string
  valueRule?: DtpProtocolValueRule
}

function structuredFrameLayoutCell(cell: string): StructuredFrameLayoutCell | undefined {
  const normalized = cell.replace(/\s+/g, "")
  if (!normalized || /^[-\u2014\u2013]+$/.test(normalized)) return undefined
  if (/^SUM$/i.test(normalized)) return { token: "SUM", fieldName: "SUM" }

  const calculatedStationAddress = normalized.match(/^(?:(T|TITLE|W\d+))?([0-9A-Fa-f]{1,2})H?\+\u7ad9\u5730\u5740$/i)
  if (calculatedStationAddress?.[2]) {
    const prefix = calculatedStationAddress[1]?.toUpperCase()
    const fieldName = prefix === "T" || prefix === "TITLE" ? "TITLE" : prefix
    return {
      token: fieldName ?? "DYNAMIC_STATION_ADDRESS",
      fieldName,
      valueRule: {
        operation: "add_low8",
        base: calculatedStationAddress[2].toUpperCase().padStart(2, "0"),
        variable: "station_address",
      },
    }
  }

  const variableField = normalized.match(/^(T|TITLE|W\d+)(\u7ad9\u5730\u5740|\u6307\u4ee4\u6807\u8bc6|\u6307\u4ee4\u7801)$/i)
  if (variableField?.[1] && variableField[2]) {
    const prefix = variableField[1].toUpperCase()
    const fieldName = prefix === "T" || prefix === "TITLE" ? "TITLE" : prefix
    return {
      token: fieldName,
      fieldName,
      valueRule: {
        operation: "variable",
        variable: variableField[2] === "\u7ad9\u5730\u5740" ? "station_address" : "command_identifier",
      },
    }
  }

  const structuralFixed = normalized.match(/^(I|INDEX|T|TITLE|L|LENGTH|LEN)([0-9A-Fa-f]{1,2})H$/i)
  if (structuralFixed?.[1] && structuralFixed[2]) {
    const prefix = structuralFixed[1].toUpperCase()
    const fieldName = prefix === "I" || prefix === "INDEX"
      ? "FRAME_SEQUENCE"
      : prefix === "T" || prefix === "TITLE"
        ? "TITLE"
        : "LENGTH"
    const value = structuralFixed[2].toUpperCase().padStart(2, "0")
    return { token: value, fieldName, defaultValue: value }
  }

  const inlineDataField = inlineDataFieldFromCell(cell)
  if (inlineDataField) {
    return {
      token: inlineDataField.name,
      fieldName: inlineDataField.name,
      defaultValue: inlineDataField.value,
    }
  }
  const dataName = normalized.match(/^(W\d+)$/i)?.[1]
  if (dataName) return { token: dataName.toUpperCase(), fieldName: dataName.toUpperCase() }
  const hexWithSuffix = normalized.match(/^([0-9A-Fa-f]{1,2})H$/)
  if (hexWithSuffix?.[1]) {
    const value = hexWithSuffix[1].toUpperCase().padStart(2, "0")
    return { token: value, defaultValue: value }
  }
  const plainByte = normalized.match(/^(?:0x)?([0-9A-Fa-f]{1,2})$/)
  if (plainByte?.[1]) {
    const value = plainByte[1].toUpperCase().padStart(2, "0")
    return { token: value, defaultValue: value }
  }
  return undefined
}

function dynamicValueRuleFromCell(cell: string): DtpProtocolValueRule | undefined {
  return structuredFrameLayoutCell(cell)?.valueRule
}

function normalizeFrameLayoutCell(cell: string): string | null {
  return structuredFrameLayoutCell(cell)?.token ?? null
}

function normalizeFrameByteLayoutTokens(tokens: string[]): string[] {
  return tokens
    .map(normalizeFrameLayoutCell)
    .filter((item): item is string => Boolean(item))
}

function frameLayoutRowScore(row: string[]): number {
  return row.slice(1).reduce((score, cell) => {
    const normalized = cell.replace(/\s+/g, "")
    if (!normalized) return score
    const structured = structuredFrameLayoutCell(cell)
    if (structured?.valueRule) return score + 4
    if (structured?.fieldName) return score + 3
    if (/^SUM$/i.test(normalized)) return score + 3
    if (inlineDataFieldFromCell(cell)) return score + 3
    if (/^W\d+$/i.test(normalized)) return score + 3
    if (/^(?:TITLE|Title|T)[0-9A-Fa-f]{1,2}H$/i.test(normalized)) return score + 3
    if (/^(?:LENGTH|Length|L)[0-9A-Fa-f]{1,2}H$/i.test(normalized)) return score + 3
    if (/^[0-9A-Fa-f]{1,2}H$/i.test(normalized)) return score + 2
    return score
  }, 0)
}

function looksLikeNumericColumnIndexRow(row: string[]): boolean {
  const values = row
    .slice(1)
    .map((cell) => cell.trim())
    .filter(Boolean)
  if (values.length < 4) return false
  if (!values.every((value) => /^\d+[.、]?$/.test(value))) return false

  const numbers = values.map((value) => Number.parseInt(value, 10))
  return numbers.every((value, index) => index === 0 || value === numbers[index - 1] + 1)
}

function isFrameLayoutDataRow(row: string[]): boolean {
  if (looksLikeNumericColumnIndexRow(row) || frameLayoutRowScore(row) <= 0) return false
  const arbitration = normalizeFrameLayoutCell(row[1] ?? "")
  const control = normalizeFrameLayoutCell(row[2] ?? "")
  const arbitrationResolved = Boolean(arbitration && (
    /^[0-9A-F]{2}$/.test(arbitration) || arbitration === "DYNAMIC_STATION_ADDRESS"
  ))
  return Boolean(arbitrationResolved && control && /^[0-9A-F]{2}$/.test(control))
}

function canFrameDlc(row: string[], hasPackedCanControl: boolean): number | undefined {
  if (!hasPackedCanControl) return undefined
  const control = normalizeFrameLayoutCell(row[2] ?? "")
  if (!control || !/^[0-9A-F]{2}$/.test(control)) return undefined
  const dlc = Number.parseInt(control, 16) & 0x0f
  return dlc <= 8 ? dlc : undefined
}

function hasAuthoritativeCanDlcLayout(table: SectionProtocolRelationTableInput | undefined): boolean {
  if (!table || !isCanFrameTableInput(table)) return false
  const tableText = [table.caption, table.table_html, ...table.rows.flat()]
    .filter(Boolean)
    .join(" ")
  // Register/frame-buffer tables may intentionally describe all physical
  // slots. Business-frame tables instead use DLC as the transmitted length.
  if (/(?:frame\s*buffer|register|缓冲区|寄存器)/i.test(tableText)) return false
  const hasPackedCanControl = /RTR.*DLC|DLC.*RTR/i.test(tableText)
  return hasPackedCanControl && table.rows
    .filter(isFrameLayoutDataRow)
    .some((row) => canFrameDlc(row, true) !== undefined)
}

type FrameLayoutEntry = { token: string; column: number }

function expandSparseFrameLayoutEntries(
  table: SectionProtocolRelationTableInput,
  rows: string[][],
): FrameLayoutEntry[][] {
  const hasPackedCanControl = table.rows.some((row) => row.some((cell) => /RTR.*DLC|DLC.*RTR/i.test(cell)))
  let nextDataWord: number | undefined
  return rows.map((row) => {
    const dlc = canFrameDlc(row, hasPackedCanControl)
    const lastColumn = dlc === undefined ? row.length - 1 : Math.min(row.length - 1, 2 + dlc)
    const layout: FrameLayoutEntry[] = []
    for (let column = 1; column <= lastColumn; column += 1) {
      const rawCell = row[column] ?? ""
      if (/^\s*[-—–]+\s*$/.test(rawCell)) break
      const structured = structuredFrameLayoutCell(rawCell)
      const token = structured?.token
      const dataWord = token?.match(/^W(\d+)$/i)
      if (dataWord?.[1]) nextDataWord = Number.parseInt(dataWord[1], 10) + 1
      // A fixed structural cell such as TC0H renders as byte C0, but its
      // fieldName still marks the point after which sparse columns are W0... .
      if (structured?.fieldName === "TITLE") nextDataWord = 0
      if (token) {
        layout.push({ token, column })
        if (/^(?:SUM|CHECKSUM|CRC)$/i.test(token)) break
        continue
      }
      if (nextDataWord !== undefined && column >= 3) {
        layout.push({ token: `W${nextDataWord}`, column })
        nextDataWord += 1
      }
    }
    return layout
  })
}

function expandSparseFrameByteLayouts(table: SectionProtocolRelationTableInput, rows: string[][]): string[][] {
  return expandSparseFrameLayoutEntries(table, rows).map((layout) => layout.map((entry) => entry.token))
}

function spiFieldNamesFromCell(value: string | undefined): string[] {
  const normalized = (value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, "")
    .toUpperCase()
  if (!normalized) return []
  if (/^ADDRESS$/.test(normalized)) return ["ADDRESS"]
  if (/^(?:LENGTH|LEN)$/.test(normalized)) return ["LENGTH"]
  if (/^(?:SUM|CHECKSUM)$/.test(normalized)) return ["SUM"]
  const range = normalized.match(/^DATA(\d+)(?:[~～\-至]+(?:DATA)?(\d+))?$/)
  if (!range) return []
  const start = Number.parseInt(range[1], 10)
  const end = range[2] === undefined ? start : Number.parseInt(range[2], 10)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 255) return []
  return Array.from({ length: end - start + 1 }, (_, index) => `DATA${start + index}`)
}

function spiFrameHeader(table: SectionProtocolRelationTableInput): { rowIndex: number; row: string[] } | undefined {
  const candidates = table.rows
    .map((row, rowIndex) => ({
      row,
      rowIndex,
      names: row.flatMap((cell) => spiFieldNamesFromCell(cell)),
    }))
    .filter((candidate) => (
      candidate.names.includes("ADDRESS") &&
      candidate.names.includes("LENGTH") &&
      candidate.names.some((name) => /^DATA\d+$/.test(name)) &&
      candidate.names.includes("SUM")
    ))
    .sort((left, right) => right.names.length - left.names.length)
  return candidates[0]
}

function isSpiFrameTableInput(table: SectionProtocolRelationTableInput | undefined): boolean {
  return Boolean(table && spiFrameHeader(table))
}

function isCanFrameTableInput(table: SectionProtocolRelationTableInput | undefined): boolean {
  if (!table) return false
  const text = [table.caption, table.table_html, ...table.rows.flat()]
    .filter(Boolean)
    .join(" ")
  const hasArbitration = /仲裁场|ARBITRATION/i.test(text)
  const hasControl = /控制场|CONTROL|\bDLC\b|\bRTR\b/i.test(text)
  const hasSequence = /帧序号|FRAME[_\s-]?SEQUENCE|\bINDEX\b/i.test(text)
  return (hasArbitration && hasControl) || (hasControl && hasSequence)
}

function hexBytesFromSpiCell(value: string | undefined): string[] {
  const raw = value?.trim() ?? ""
  if (!raw) return []

  const explicit = Array.from(
    raw.matchAll(/(?:0x([0-9A-F]{1,2})|([0-9A-F]{1,2})H)(?![0-9A-Z])/gi),
    (match) => (match[1] ?? match[2]).toUpperCase().padStart(2, "0"),
  )
  if (explicit.length) return explicit

  const plainTokens = raw.split(/\s+/)
  if (plainTokens.every((token) => /^[0-9A-F]{1,2}$/i.test(token))) {
    return plainTokens.map((token) => token.toUpperCase().padStart(2, "0"))
  }
  return []
}

function spiFrameDataRows(table: SectionProtocolRelationTableInput): string[][] {
  const header = spiFrameHeader(table)
  if (!header) return []
  const addressColumn = header.row.findIndex((cell) => spiFieldNamesFromCell(cell).includes("ADDRESS"))
  const lengthColumn = header.row.findIndex((cell) => spiFieldNamesFromCell(cell).includes("LENGTH"))
  return table.rows.slice(header.rowIndex + 1).filter((row) => (
    hexBytesFromSpiCell(row[addressColumn]).length > 0 &&
    hexBytesFromSpiCell(row[lengthColumn]).length > 0
  ))
}

function spiFrameLayoutFromRow(
  table: SectionProtocolRelationTableInput,
  row: string[],
): { byteLayout: string[]; fieldLayout: DtpProtocolFieldLayout[] } {
  const header = spiFrameHeader(table)
  if (!header) return { byteLayout: [], fieldLayout: [] }
  const byteLayout: string[] = []
  const fieldLayout: DtpProtocolFieldLayout[] = []

  for (const [column, headerCell] of header.row.entries()) {
    const names = spiFieldNamesFromCell(headerCell)
    if (!names.length) continue
    const rawCell = row[column] ?? ""
    const explicitValues = hexBytesFromSpiCell(rawCell)
    const addressChoices = names.length === 1 && names[0] === "ADDRESS" && /[\/／]/.test(rawCell)
      ? [...new Set(explicitValues)]
      : []
    for (const [fieldIndex, name] of names.entries()) {
      const byteOffset = byteLayout.length
      const isChecksum = name === "SUM"
      const explicitValue = explicitValues[fieldIndex] ?? (names.length === 1 ? explicitValues[0] : undefined)
      byteLayout.push(isChecksum ? "SUM" : addressChoices.length > 1 ? name : explicitValue ?? name)
      fieldLayout.push({
        name,
        role: inferFieldRole(name),
        byte_offset: byteOffset,
        byte_length: 1,
        default_value: isChecksum || addressChoices.length > 1 ? undefined : explicitValue,
        options: addressChoices.length > 1 ? addressChoices.map(value => ({ value, label: `ADDRESS=${value}H` })) : undefined,
        source_table_id: table.id,
        source_text: rawCell || headerCell,
      })
    }
  }
  return { byteLayout, fieldLayout }
}

function enrichSpiAddressBitFields(
  layout: DtpProtocolFieldLayout[],
  context: DtpProtocolContextPackage,
  table?: SectionProtocolRelationTableInput,
): DtpProtocolFieldLayout[] {
  const address = layout.find((field) => field.name.toUpperCase() === "ADDRESS")
  if (!address) return layout
  const evidence = [
    context.interface_context_text,
    context.section_text,
    context.flow_blocks.input.text,
    context.flow_blocks.output.text,
  ].filter(Boolean).join(" ")
  const tableDefinesAddressParts = Boolean(table && (() => {
    const header = spiFrameHeader(table)
    if (!header) return false
    const addressColumn = header.row.findIndex((cell) => spiFieldNamesFromCell(cell).includes("ADDRESS"))
    return addressColumn >= 0 && table.rows.slice(header.rowIndex + 1).some((row) => (
      /\u7ad9\u5730\u5740/.test(row[addressColumn] ?? "") &&
      /(?:\u7c7b\u578b|TYPE)/i.test(row[addressColumn + 1] ?? "")
    ))
  })())
  const stationDefined = tableDefinesAddressParts || /(?:\u9ad8\s*5\s*\u4f4d|D7\s*[~～\-]\s*D3).{0,100}\u7ad9\u5730\u5740|\u7ad9\u5730\u5740.{0,100}(?:\u9ad8\s*5\s*\u4f4d|D7\s*[~～\-]\s*D3)/i.test(evidence)
  const typeDefined = tableDefinesAddressParts || /(?:\u4f4e\s*3\s*\u4f4d|D2\s*[~～\-]\s*D0).{0,100}(?:\u7c7b\u578b|TYPE)|(?:\u7c7b\u578b|TYPE).{0,100}(?:\u4f4e\s*3\s*\u4f4d|D2\s*[~～\-]\s*D0)/i.test(evidence)
  const addressValue = normalizeHexByte(address.default_value)
  const numericAddress = addressValue ? Number.parseInt(addressValue, 16) : undefined
  const additions: DtpProtocolFieldLayout[] = []
  if (stationDefined && !layout.some((field) => field.name.toUpperCase() === "STATION_ADDRESS")) {
    additions.push({
      name: "STATION_ADDRESS",
      role: "address",
      byte_offset: address.byte_offset,
      byte_length: 1,
      bit_offset: 3,
      bit_length: 5,
      default_value: numericAddress === undefined ? undefined : ((numericAddress >> 3) & 0x1f).toString(16).toUpperCase().padStart(2, "0"),
      source_table_id: address.source_table_id,
      source_text: "Document-defined ADDRESS high 5 station-address bits.",
    })
  }
  if (typeDefined && !layout.some((field) => field.name.toUpperCase() === "MESSAGE_TYPE")) {
    additions.push({
      name: "MESSAGE_TYPE",
      role: "type",
      byte_offset: address.byte_offset,
      byte_length: 1,
      bit_offset: 0,
      bit_length: 3,
      default_value: numericAddress === undefined ? undefined : (numericAddress & 0x07).toString(16).toUpperCase().padStart(2, "0"),
      source_table_id: address.source_table_id,
      source_text: "Document-defined ADDRESS low 3 message-type bits.",
    })
  }
  return [...layout, ...additions]
}

function spiFrameLayoutsFromTableInput(table: SectionProtocolRelationTableInput): Array<{
  byteLayout: string[]
  fieldLayout: DtpProtocolFieldLayout[]
}> {
  return spiFrameDataRows(table)
    .map((row) => spiFrameLayoutFromRow(table, row))
    .filter((frame) => frame.byteLayout.length > 0)
}

type SpaceWireByteRange = { start: number; end: number }

function spaceWireByteRange(value: string | undefined): SpaceWireByteRange | undefined {
  const normalized = (value ?? "").replace(/\s+/g, "").toUpperCase()
  const match = normalized.match(/^W(\d+)(?:[~～\-](?:W)?(\d+))?$/)
  if (!match) return undefined
  const start = Number.parseInt(match[1], 10)
  const end = match[2] === undefined ? start : Number.parseInt(match[2], 10)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 4095) return undefined
  return { start, end }
}

function spaceWireBlockColumns(table: SectionProtocolRelationTableInput): {
  headerIndex: number
  byteColumn: number
  contentColumn: number
  dataColumn: number
} | undefined {
  for (const [headerIndex, row] of table.rows.entries()) {
    const byteColumn = row.findIndex((cell) => /^(?:\u5b57\u8282|BYTE)$/i.test(cell.trim()))
    const contentColumn = row.findIndex((cell) => /^(?:\u5185\u5bb9|CONTENT)$/i.test(cell.trim()))
    const dataColumn = row.findIndex((cell) => /^(?:\u6570\u636e|DATA)$/i.test(cell.trim()))
    if (byteColumn >= 0 && contentColumn >= 0 && dataColumn >= 0) {
      return { headerIndex, byteColumn, contentColumn, dataColumn }
    }
  }
  return undefined
}

function isSpaceWireBlockTableInput(table: SectionProtocolRelationTableInput | undefined): boolean {
  if (!table) return false
  const columns = spaceWireBlockColumns(table)
  if (!columns) return false
  const ranges = table.rows.slice(columns.headerIndex + 1)
    .map((row) => spaceWireByteRange(row[columns.byteColumn]))
    .filter((range): range is SpaceWireByteRange => Boolean(range))
  const maximum = ranges.reduce((value, range) => Math.max(value, range.end), -1)
  return maximum >= 359 && /(?:Space\s*wire|\u4e0a\u6ce8|\u7a0b\u5e8f)/i.test([table.caption, ...table.rows.flat()].join(" "))
}

function fixedBytesFromWideValue(value: string | undefined, byteLength: number): string[] | undefined {
  const normalized = (value ?? "").replace(/\s+/g, "")
  const directHex = normalized.match(/^(?:0x)?([0-9A-F]+)H?(?:[（(][^）)]*[）)])?$/i)?.[1]
  if (directHex) {
    const padded = directHex.length % 2 ? `0${directHex}` : directHex
    const bytes = padded.match(/.{2}/g)?.map((item) => item.toUpperCase()) ?? []
    if (bytes.length <= byteLength) return [...Array(byteLength - bytes.length).fill("00"), ...bytes]
  }
  const decimal = normalized.match(/^(\d+)(?:\u5b57\u8282)?$/)?.[1]
  if (decimal) {
    let numeric = BigInt(decimal)
    const bytes = Array.from({ length: byteLength }, () => {
      const byte = Number(numeric & 0xffn).toString(16).toUpperCase().padStart(2, "0")
      numeric >>= 8n
      return byte
    }).reverse()
    return numeric === 0n ? bytes : undefined
  }
  return undefined
}

function fixedSpaceWireFieldBytes(
  name: string,
  role: DtpProtocolFieldRole,
  data: string,
  byteLength: number,
): string[] | undefined {
  if (name === "START_ADDRESS") {
    const startAddress = firstWideHexValue(data, byteLength)
    return startAddress ? fixedBytesFromWideValue(startAddress, byteLength) : undefined
  }
  if (name === "DATA_LENGTH") {
    const fixedLength = data.match(/(?:\u56fa\u5b9a\u4e3a\s*)?(\d+)\s*\u5b57\u8282/i)?.[1]
    return fixedLength
      ? fixedBytesFromWideValue(`${BigInt(fixedLength).toString(16)}H`, byteLength)
      : undefined
  }
  if (role === "data" || role === "checksum") return undefined
  return fixedBytesFromWideValue(data.split(/[\uff1a:]/)[0], byteLength)
}

function spaceWireFieldRole(content: string): DtpProtocolFieldRole {
  if (/\u5305\u7c7b\u578b/.test(content)) return "type"
  if (/\u8d77\u59cb\u5730\u5740/.test(content)) return "address"
  if (/\u6570\u636e\u957f\u5ea6/.test(content)) return "length"
  if (/ISO\s*\u6821\u9a8c|\u6821\u9a8c\u548c/i.test(content)) return "checksum"
  if (/\u6709\u6548\u6570\u636e/.test(content)) return "data"
  if (/\u586b\u5145|\u5305\u6807\u8bc6/.test(content)) return "fixed"
  return "unknown"
}

function spaceWireFieldName(content: string, range: SpaceWireByteRange): string {
  if (/\u5305\u6807\u8bc6/.test(content)) return "PACKAGE_ID"
  if (/\u5305\u7c7b\u578b/.test(content)) return "BLOCK_TYPE"
  if (/\u8d77\u59cb\u5730\u5740/.test(content)) return "START_ADDRESS"
  if (/\u6570\u636e\u957f\u5ea6/.test(content)) return "DATA_LENGTH"
  if (/ISO\s*\u6821\u9a8c/i.test(content)) return "ISO_CHECKSUM"
  if (/\u6821\u9a8c\u548c/.test(content)) return "PROGRAM_CHECKSUM"
  if (/\u6709\u6548\u6570\u636e/.test(content)) return "PAYLOAD"
  return `W${range.start}_${range.end}`
}

function spaceWireBlockFrameFromTable(
  table: SectionProtocolRelationTableInput,
  frameId: string,
  sequence: number,
  blockType?: string,
): DtpProtocolFrameDefinition | undefined {
  const columns = spaceWireBlockColumns(table)
  if (!columns) return undefined
  const rows = table.rows.slice(columns.headerIndex + 1)
    .map((row) => ({
      row,
      range: spaceWireByteRange(row[columns.byteColumn]),
      content: row[columns.contentColumn]?.trim() ?? "",
      data: row[columns.dataColumn]?.trim() ?? "",
    }))
    .filter((item): item is typeof item & { range: SpaceWireByteRange } => Boolean(item.range))
  const totalBytes = rows.reduce((value, item) => Math.max(value, item.range.end + 1), 0)
  if (!totalBytes) return undefined
  const byteLayout = Array.from({ length: totalBytes }, (_, index) => `W${index}`)
  const fieldLayout: DtpProtocolFieldLayout[] = []

  for (const item of rows) {
    const byteLength = item.range.end - item.range.start + 1
    const name = spaceWireFieldName(item.content, item.range)
    const role = spaceWireFieldRole(item.content)
    let fixedBytes = fixedSpaceWireFieldBytes(name, role, item.data, byteLength)
    if (name === "BLOCK_TYPE" && blockType) fixedBytes = [blockType]
    if (/\u586b\u5145/.test(item.content) && /00/i.test(item.data)) fixedBytes = Array(byteLength).fill("00")
    for (let offset = 0; offset < byteLength; offset += 1) {
      const index = item.range.start + offset
      byteLayout[index] = fixedBytes?.[offset] ?? `${name}${byteLength > 1 ? `_${offset}` : ""}`
    }
    fieldLayout.push({
      name,
      role,
      byte_offset: item.range.start,
      byte_length: byteLength,
      default_value: byteLength === 1 ? fixedBytes?.[0] : undefined,
      source_table_id: table.id,
      source_text: [item.row[columns.byteColumn], item.content, item.data].filter(Boolean).join(" | "),
    })
  }
  const checksumField = fieldLayout.find((field) => field.role === "checksum")
  const checksumSourceStart = fieldLayout.find((field) => (
    field.byte_offset <= 12 && field.byte_offset + field.byte_length > 12
  ))?.name
  const checksumSourceEnd = fieldLayout.find((field) => (
    field.byte_offset <= 715 && field.byte_offset + field.byte_length > 715
  ))?.name
  return {
    frame_id: frameId,
    sequence,
    source_table_id: table.id,
    byte_layout: byteLayout,
    field_layout: fieldLayout,
    checksum: checksumField ? {
      type: "iso",
      start: checksumSourceStart,
      end: checksumSourceEnd,
      expression: "ISO 8473 checksum over W12..W715.",
    } : undefined,
  }
}

function spaceWireBlockTypeValue(table: SectionProtocolRelationTableInput, label: string): string | undefined {
  const text = table.rows.flat().join(" ")
  const beforeLabel = text.match(new RegExp(`([0-9A-F]{1,2})H?\\s*[:\uff1a]?\\s*${label}`, "i"))?.[1]
  const afterLabel = text.match(new RegExp(`${label}[^0-9A-F]{0,12}([0-9A-F]{1,2})H?`, "i"))?.[1]
  return normalizeHexByte(beforeLabel ?? afterLabel)
}

function firstWideHexValue(sourceText: string | undefined, byteLength: number): string | undefined {
  if (!sourceText || byteLength < 1) return undefined
  const expectedDigits = byteLength * 2
  const match = sourceText.match(new RegExp(`\\b([0-9A-F]{${expectedDigits}})H?\\b`, "i"))
  return match?.[1]?.toUpperCase()
}

function buildSpaceWireBlockProtocolForContext(context: DtpProtocolContextPackage): DtpProtocolDefinition | undefined {
  const blockTables = context.tables.filter(isSpaceWireBlockTableInput)
  const startMiddleTable = blockTables.find((table) => /\u8d77\u59cb\u5757.*\u4e2d\u95f4\u5757|\u4e2d\u95f4\u5757.*\u8d77\u59cb\u5757/.test(table.caption ?? "")) ??
    blockTables.find((table) => /00H[^\n]{0,80}05H/i.test(table.rows.flat().join(" ")))
  const checkTable = blockTables.find((table) => /\u6821\u9a8c\u5757/.test(table.caption ?? ""))
  if (!startMiddleTable || !checkTable) return undefined

  const startBlockType = spaceWireBlockTypeValue(startMiddleTable, "\u8d77\u59cb\u5757")
  const middleBlockType = spaceWireBlockTypeValue(startMiddleTable, "\u4e2d\u95f4\u5757")
  const checkBlockType = spaceWireBlockTypeValue(checkTable, "\u6821\u9a8c\u5757")
  if (!startBlockType || !middleBlockType || !checkBlockType) return undefined
  const startFrame = spaceWireBlockFrameFromTable(startMiddleTable, "start-block", 1, startBlockType)
  const middleFrame = spaceWireBlockFrameFromTable(startMiddleTable, "middle-block", 2, middleBlockType)
  const checkFrame = spaceWireBlockFrameFromTable(checkTable, "check-block", 3, checkBlockType)
  if (!startFrame || !middleFrame || !checkFrame) return undefined
  const totalBytes = Math.max(startFrame.byte_layout.length, checkFrame.byte_layout.length)
  const payloadField = startFrame.field_layout.find((field) => field.name === "PAYLOAD")
  const addressField = startFrame.field_layout.find((field) => field.name === "START_ADDRESS")
  const lengthField = startFrame.field_layout.find((field) => field.name === "DATA_LENGTH")
  const blockTypeField = startFrame.field_layout.find((field) => field.name === "BLOCK_TYPE")
  const isoField = startFrame.field_layout.find((field) => field.name === "ISO_CHECKSUM")
  const programChecksumField = checkFrame.field_layout.find((field) => field.name === "PROGRAM_CHECKSUM")
  if (!payloadField || !addressField || !lengthField || !blockTypeField || !isoField || !programChecksumField) return undefined
  const blockLayout: DtpProtocolBlockDefinition = {
    kind: "spacewire_program_upload",
    total_bytes: totalBytes,
    payload_offset: payloadField.byte_offset,
    payload_capacity: payloadField.byte_length,
    payload_file_patterns: ["*.bin", "*.img", "*.dat"],
    start_address: firstWideHexValue(addressField.source_text, addressField.byte_length),
    address_offset: addressField.byte_offset,
    address_length: addressField.byte_length,
    length_offset: lengthField.byte_offset,
    length_length: lengthField.byte_length,
    scalar_byte_order: "unknown",
    block_type_offset: blockTypeField.byte_offset,
    start_block_type: startBlockType,
    middle_block_type: middleBlockType,
    check_block_type: checkBlockType,
    checksums: [
      {
        name: "ISO_CHECKSUM",
        algorithm: isoField.byte_length === 2 && /ISO\s*\u6821\u9a8c/i.test(isoField.source_text ?? "")
          ? "iso_8473"
          : "iso_unknown",
        source: "frame_range",
        source_start: payloadField.byte_offset,
        source_end: isoField.byte_offset - 1,
        output_offset: isoField.byte_offset,
        output_length: isoField.byte_length,
        byte_order: "big",
        source_text: isoField.source_text ?? "ISO\u6821\u9a8c\uff08W12~W715\uff09",
      },
      {
        name: "PROGRAM_CHECKSUM",
        algorithm: "sum_low32",
        source: "payload_image",
        output_offset: programChecksumField.byte_offset,
        output_length: programChecksumField.byte_length,
        byte_order: "unknown",
        source_text: "\u4ece\u8d77\u59cb\u5730\u5740\u5f00\u59cb\u6309\u5b57\u8282\u8ba1\u7b97\u7d2f\u52a0\u548c\uff0c\u6570\u636e\u957f\u5ea6\u4e3aN.",
      },
    ],
    source_table_ids: [startMiddleTable.id, checkTable.id],
  }
  return {
    protocol_id: `${context.section_model_id}-spacewire-program-upload`,
    source_section: context.section_title,
    flow_direction: "input",
    base_file_name: "\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u6570\u636e\u5757",
    generation_mode: "single_file",
    frames: [startFrame, middleFrame, checkFrame],
    bus_context: {
      bus_type: "SpaceWire",
      interface_id: context.section_text.match(/IF-Space\s*wire-\d+/i)?.[0],
      interface_name: "SpaceWire\u603b\u7ebf\u63a5\u53e3",
      profile_scope: "interface",
      controller: /FPGA/i.test(context.section_text) ? "FPGA" : "unknown",
      frame_buffer_layout: "business-payload",
      evidence: [startMiddleTable.caption ?? startMiddleTable.id, checkTable.caption ?? checkTable.id],
      confidence: 0.98,
    },
    block_layout: blockLayout,
    fields: [],
    evidence: [startMiddleTable.caption ?? startMiddleTable.id, checkTable.caption ?? checkTable.id],
    warnings: [
      "SpaceWire scalar byte order is not explicitly defined; big-endian document order is used only as a warned fallback during rendering.",
      ...(blockLayout.checksums.some((checksum) => checksum.name === "ISO_CHECKSUM" && checksum.algorithm === "iso_unknown")
        ? ["ISO checksum algorithm could not be resolved from the two-byte ISO field definition."]
        : []),
    ],
    confidence: 0.9,
    understanding_source: "heuristic-fallback",
  }
}

function frameByteLayoutFromTableInput(table: SectionProtocolRelationTableInput | undefined): string[] {
  if (!table) return []
  if (isSpaceWireBlockTableInput(table)) {
    return spaceWireBlockFrameFromTable(table, "block-1", 1)?.byte_layout ?? []
  }
  if (isSpiFrameTableInput(table)) return spiFrameLayoutsFromTableInput(table)[0]?.byteLayout ?? []
  const candidateRows = table.rows
    .filter(isFrameLayoutDataRow)
    .map((row) => ({ row, score: frameLayoutRowScore(row) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
  const dataRow = candidateRows[0]?.row ?? table.rows.find((row) => frameLayoutRowScore(row) > 0) ?? table.rows[1]
  if (!dataRow) return []
  return dataRow
    .slice(1)
    .map(normalizeFrameLayoutCell)
    .filter((item): item is string => Boolean(item))
}

function frameByteLayoutsFromTableInput(table: SectionProtocolRelationTableInput | undefined): string[][] {
  if (!table) return []
  if (isSpaceWireBlockTableInput(table)) {
    const frame = spaceWireBlockFrameFromTable(table, "block-1", 1)
    return frame ? [frame.byte_layout] : []
  }
  if (isSpiFrameTableInput(table)) {
    return spiFrameLayoutsFromTableInput(table).map((frame) => frame.byteLayout)
  }
  const layouts = expandSparseFrameByteLayouts(table, table.rows.filter(isFrameLayoutDataRow))
    .filter((layout) => layout.length > 0)
  return layouts.length ? layouts : [frameByteLayoutFromTableInput(table)].filter((layout) => layout.length > 0)
}

function frameLayoutDataRows(table: SectionProtocolRelationTableInput | undefined): string[][] {
  if (table && isSpiFrameTableInput(table)) return spiFrameDataRows(table)
  return table?.rows.filter(isFrameLayoutDataRow) ?? []
}

function semanticFieldNameFromCell(value: string | undefined): string | undefined {
  const normalized = (value ?? "").replace(/\s+/g, "")
  if (!normalized) return undefined
  const structured = structuredFrameLayoutCell(value ?? "")
  if (structured?.fieldName) return structured.fieldName
  if (/仲裁场|ARBITRATION|^ID$/i.test(normalized)) return "ARBITRATION"
  if (/控制场|CONTROL|DLC|RTR/i.test(normalized)) return "CONTROL"
  if (/帧序号|帧索引|FRAME(?:_?SEQUENCE|_?INDEX)|^INDEX$/i.test(normalized)) return "FRAME_SEQUENCE"
  if (/^(?:TITLE|T)(?:[0-9A-F]{1,2}H?)?$/i.test(normalized)) return "TITLE"
  if (/^(?:LENGTH|LEN|L)(?:[0-9A-F]{1,2}H?)?$/i.test(normalized)) return "LENGTH"
  if (/^(?:SUM|CHECKSUM)$/i.test(normalized)) return "SUM"
  if (/^CRC/i.test(normalized)) return "CRC"
  const spiField = spiFieldNamesFromCell(value)[0]
  if (spiField) return spiField
  const inlineDataField = inlineDataFieldFromCell(value ?? "")
  if (inlineDataField) return inlineDataField.name
  const dataWord = normalized.match(/^(W\d+)$/i)?.[1]
  return dataWord?.toUpperCase()
}

function isImplicitCanFrameSequenceColumn(
  table: SectionProtocolRelationTableInput,
  column: number,
): boolean {
  if (!isCanFrameTableInput(table)) return false
  const tableText = [table.caption, ...table.rows.flat()].filter(Boolean).join(" ")
  if (!/帧序号|帧索引|frame\s*(?:sequence|index)/i.test(tableText)) return false
  const values = frameLayoutDataRows(table).map((row) => normalizeHexByte(row[column]))
  if (values.length < 2 || values.some((value) => !value)) return false
  const numeric = values.map((value) => Number.parseInt(value!, 16))
  return numeric[0] === 0 && numeric.every((value, index) => value === index)
}

function frameFieldLayoutFromTableInput(
  table: SectionProtocolRelationTableInput | undefined,
  byteLayout: string[],
  fields: DtpProtocolFieldDefinition[] = [],
  selectedDataRow?: string[],
  sourceColumns?: number[],
): DtpProtocolFieldLayout[] {
  if (!table) return normalizeFieldLayout(undefined, byteLayout, fields)
  const headerRow = table.rows.find((row) =>
    row.some((cell) => Boolean(semanticFieldNameFromCell(cell))),
  ) ?? table.headers
  const dataRow = selectedDataRow ?? table.rows.find(isFrameLayoutDataRow)
  const firstDataRowIndex = table.rows.findIndex(isFrameLayoutDataRow)
  const headerRows = firstDataRowIndex >= 0 ? table.rows.slice(0, firstDataRowIndex) : table.rows
  const tableText = [table.caption, ...table.rows.flat()].filter(Boolean).join(" ")
  const supplied: DtpProtocolFieldLayout[] = byteLayout.map((token, byteOffset) => {
    const column = sourceColumns?.[byteOffset] ?? byteOffset + 1
    const structured = structuredFrameLayoutCell(dataRow?.[column] ?? "")
    const structuralName = byteOffset === 0 && /仲裁场|ARBITRATION/i.test(tableText)
      ? "ARBITRATION"
      : byteOffset === 1 && /控制场|CONTROL|DLC|RTR/i.test(tableText)
        ? "CONTROL"
        : undefined
    const columnSemanticName = headerRows
      .map((row) => semanticFieldNameFromCell(row[column]))
      .find((value): value is string => Boolean(value))
    const implicitFrameSequence = !columnSemanticName && isImplicitCanFrameSequenceColumn(table, column)
    const name = structuralName ??
      structured?.fieldName ??
      semanticFieldNameFromCell(headerRow?.[column]) ??
      columnSemanticName ??
      (implicitFrameSequence ? "FRAME_SEQUENCE" : undefined) ??
      semanticFieldNameFromCell(dataRow?.[column]) ??
      token
    return {
      name,
      role: inferFieldRole(name),
      byte_offset: byteOffset,
      byte_length: 1,
      default_value: structured?.defaultValue ?? normalizeHexByte(token),
      value_rule: structured?.valueRule,
      source_table_id: table.id,
      source_text: dataRow?.[column] || undefined,
    }
  })
  const titleOffset = supplied.find((field) => field.role === "title")?.byte_offset
  const checksumOffset = supplied.find((field) => field.role === "checksum")?.byte_offset
  const hasExplicitDataWords = supplied.some((field) => /^W\d+$/i.test(field.name))
  let nextDataWord = 0
  const withPayloadRoles = supplied.map((field) => {
    const explicitDataWord = field.name.match(/^W(\d+)$/i)?.[1]
    if (explicitDataWord !== undefined) {
      nextDataWord = Number.parseInt(explicitDataWord, 10) + 1
      return { ...field, name: `W${Number.parseInt(explicitDataWord, 10)}`, role: "data" as const }
    }
    const isUnnamedPayload = titleOffset !== undefined &&
      field.byte_offset > titleOffset &&
      (checksumOffset === undefined || field.byte_offset < checksumOffset) &&
      (field.role === "fixed" || field.role === "unknown")
    if (!isUnnamedPayload) return field

    const payloadField = {
      ...field,
      role: "data" as const,
    }
    if (hasExplicitDataWords) return payloadField
    const namedPayloadField = { ...payloadField, name: `W${nextDataWord}` }
    nextDataWord += 1
    return namedPayloadField
  })
  const controlField = withPayloadRoles.find((field) => field.role === "control")
  if (controlField && /(?:ID\s*2\s*[~～至-]\s*ID\s*0|RTR|DLC)/i.test(tableText)) {
    if (/RTR/i.test(tableText) && !withPayloadRoles.some((field) => /^RTR$/i.test(field.name))) {
      withPayloadRoles.push({
        name: "RTR",
        role: "control",
        byte_offset: controlField.byte_offset,
        byte_length: 1,
        bit_offset: 4,
        bit_length: 1,
        source_table_id: table.id,
        source_text: "RTR bit in the compact CAN control field.",
      })
    }
    if (/DLC/i.test(tableText) && !withPayloadRoles.some((field) => /^DLC$/i.test(field.name))) {
      withPayloadRoles.push({
        name: "DLC",
        role: "length",
        byte_offset: controlField.byte_offset,
        byte_length: 1,
        bit_offset: 0,
        bit_length: 4,
        source_table_id: table.id,
        source_text: "DLC bits in the compact CAN control field.",
      })
    }
  }
  return normalizeFieldLayout(withPayloadRoles, byteLayout, fields)
}

function frameFieldLayoutsFromTableInput(
  table: SectionProtocolRelationTableInput | undefined,
  byteLayouts: string[][],
  fields: DtpProtocolFieldDefinition[] = [],
): DtpProtocolFieldLayout[][] {
  if (table && isSpaceWireBlockTableInput(table)) {
    const frame = spaceWireBlockFrameFromTable(table, "block-1", 1)
    return frame ? [frame.field_layout] : []
  }
  if (table && isSpiFrameTableInput(table)) {
    return spiFrameLayoutsFromTableInput(table).map((frame) => normalizeFieldLayout(frame.fieldLayout, frame.byteLayout, fields))
  }
  const dataRows = frameLayoutDataRows(table)
  const tableLayoutEntries = table ? expandSparseFrameLayoutEntries(table, dataRows) : []
  return byteLayouts.map((layout, index) => {
    const dataRow = dataRows[index]
    if (index > 0 && !dataRow) return []
    const entries = tableLayoutEntries[index] ?? []
    const sourceColumns = entries.length === layout.length && entries.every((entry, entryIndex) => entry.token === layout[entryIndex])
      ? entries.map((entry) => entry.column)
      : undefined
    return frameFieldLayoutFromTableInput(table, layout, fields, dataRow, sourceColumns)
  })
}

function protocolFramesFromTableInput(
  table: SectionProtocolRelationTableInput,
  byteLayouts: string[][],
  fields: DtpProtocolFieldDefinition[],
  checksum: DtpProtocolChecksumDefinition,
  context?: DtpProtocolContextPackage,
): DtpProtocolFrameDefinition[] {
  const fieldLayouts = frameFieldLayoutsFromTableInput(table, byteLayouts, fields)
  return byteLayouts.map((layout, index) => ({
    frame_id: `frame-${index + 1}`,
    sequence: index + 1,
    source_table_id: table.id,
    byte_layout: layout,
    field_layout: context && isSpiFrameTableInput(table)
      ? enrichSpiAddressBitFields(fieldLayouts[index], context, table)
      : fieldLayouts[index],
    checksum,
  }))
}

function expandReferenceBackedPacketGroups(
  context: DtpProtocolContextPackage,
  frames: DtpProtocolFrameDefinition[],
): { frames: DtpProtocolFrameDefinition[]; warnings: string[] } {
  if (!context.reference_backed || !frames.length) return { frames, warnings: [] }
  const ownershipText = [
    context.section_text,
    context.flow_blocks.input.text,
    context.flow_blocks.output.text,
  ].filter(Boolean).join(" ")
  const packetDeclaration = ownershipText.match(/(?:包含|共)\s*(\d+)\s*包[^。；;]{0,80}?每包\s*(\d+)\s*字节/)
  if (!packetDeclaration?.[1] || !packetDeclaration[2]) return { frames, warnings: [] }
  const packetCount = Number.parseInt(packetDeclaration[1], 10)
  const declaredPacketBytes = Number.parseInt(packetDeclaration[2], 10)
  const actualPacketBytes = frames.reduce((total, frame) => total + frame.byte_layout.length, 0)
  if (!Number.isFinite(packetCount) || packetCount <= 1) return { frames, warnings: [] }
  if (!Number.isFinite(declaredPacketBytes) || declaredPacketBytes !== actualPacketBytes) {
    return {
      frames,
      warnings: [
        `Reference-backed flow declares ${packetCount} packet(s) of ${declaredPacketBytes} bytes, but the referenced layout contains ${actualPacketBytes} bytes; packet repetition was not applied.`,
      ],
    }
  }
  return {
    frames: Array.from({ length: packetCount }, (_, packetIndex) => frames.map((frame, frameIndex) => ({
      ...frame,
      frame_id: `packet-${packetIndex + 1}-${frame.frame_id}`,
      sequence: packetIndex * frames.length + frameIndex + 1,
      packet_group_id: `packet-${packetIndex + 1}`,
    }))).flat(),
    warnings: [],
  }
}

function checksumDefinitionForFrameTable(
  table: SectionProtocolRelationTableInput,
  checksumRule: string | undefined,
): DtpProtocolChecksumDefinition {
  if (isSpiFrameTableInput(table)) {
    const expression = checksumRule && !/(?:TITLE|\bW\d+\b)/i.test(checksumRule)
      ? checksumRule
      : SPI_CHECKSUM_RULE
    return {
      type: "sum_low8",
      start: "ADDRESS",
      end: "BEFORE_SUM",
      expression,
    }
  }
  return {
    type: /SUM|\u6821\u9a8c|checksum/i.test(checksumRule ?? "") ? "sum_low8" : "unknown",
    start: "TITLE",
    end: "BEFORE_SUM",
    expression: checksumRule ?? DEFAULT_CHECKSUM_RULE,
  }
}

function normalizeFrameByteLayouts(rawLayouts: unknown[]): string[][] {
  return rawLayouts
    .map((rawLayout) => Array.isArray(rawLayout)
      ? normalizeFrameByteLayoutTokens(
        rawLayout
          .map((item) => asString(item))
          .filter((item): item is string => Boolean(item)),
      )
      : [],
    )
    .filter((layout) => layout.length > 0)
}

function protocolGenerationModeFromRelation(relation: SectionProtocolRelation): DtpProtocolDefinition["generation_mode"] {
  return relation.generation_mode === "one_file_per_dictionary_row" ? "one_file_per_dictionary_row" : "single_file"
}

function protocolVariablesFromContext(context: DtpProtocolContextPackage): DtpProtocolVariableDefinition[] {
  const variables: DtpProtocolVariableDefinition[] = []
  for (const table of context.tables) {
    const tableText = [table.caption, ...table.rows.flat()].filter(Boolean).join(" ")
    if (!/\u7ad9\u5730\u5740/.test(tableText)) continue
    const headerIndexValue = table.rows.findIndex((row) => row.some((cell) => /\u7ad9\u5730\u5740/.test(cell)))
    if (headerIndexValue < 0) continue
    const header = table.rows[headerIndexValue]
    const addressIndex = header.findIndex((cell) => /\u7ad9\u5730\u5740/.test(cell))
    const labelIndex = header.findIndex((cell) => /(?:\u5355\u673a|\u8bbe\u5907|\u8282\u70b9|\u540d\u79f0)/.test(cell))
    if (addressIndex < 0) continue
    const options = table.rows.slice(headerIndexValue + 1)
      .map((row): DtpProtocolFieldOption | null => {
        const value = normalizeHexByte(row[addressIndex])
        const label = (labelIndex >= 0 ? row[labelIndex] : row.find((cell, index) => index !== addressIndex && cell.trim()))?.trim()
        if (!value || !label) return null
        return { value, label, source: row.filter(Boolean).join(" | ") }
      })
      .filter((item): item is DtpProtocolFieldOption => Boolean(item))
    if (!options.length) continue
    variables.push({
      name: "station_address",
      display_name: "\u7ad9\u5730\u5740",
      type: "uint8",
      options,
      source_table_id: table.id,
      source_text: table.caption,
    })
    break
  }
  const stationAddressSource = context.tables.find((table) => (
    table.rows.some((row) => row.some((cell) => dynamicValueRuleFromCell(cell)?.variable === "station_address"))
  ))
  if (!variables.some((variable) => variable.name === "station_address") && stationAddressSource) {
    variables.push({
      name: "station_address",
      display_name: "\u7ad9\u5730\u5740",
      type: "uint8",
      source_table_id: stationAddressSource.id,
      source_text: stationAddressSource.caption,
    })
  }
  const commandIdentifierSource = context.tables.find((table) => (
    table.rows.some((row) => row.some((cell) => dynamicValueRuleFromCell(cell)?.variable === "command_identifier"))
  ))
  if (commandIdentifierSource) {
    variables.push({
      name: "command_identifier",
      display_name: "\u6307\u4ee4\u6807\u8bc6",
      type: "uint8",
      source_table_id: commandIdentifierSource.id,
      source_text: commandIdentifierSource.caption,
    })
  }
  return variables
}

type DtpProtocolFrameEnvelopeInference = {
  envelope?: DtpProtocolFrameEnvelope
  warnings: string[]
}

function documentOrderedHexBytes(rawValue: string): string[] | undefined {
  const matches = Array.from(rawValue.matchAll(/(?:0x([0-9A-Fa-f]{1,16})|([0-9A-Fa-f]{1,16})H)/gi))
  if (!matches.length) return undefined
  const bytes: string[] = []
  for (const match of matches) {
    const digits = (match[1] ?? match[2] ?? "").toUpperCase()
    if (!digits) return undefined
    const normalized = digits.padStart(Math.ceil(digits.length / 2) * 2, "0")
    for (let index = 0; index < normalized.length; index += 2) bytes.push(normalized.slice(index, index + 2))
  }
  return bytes.length && bytes.length <= 8 ? bytes : undefined
}

function frameEnvelopeEvidenceSegments(evidence: string): string[] {
  const directSegments = evidence
    .split(/[\r\n\u3002\uff1b;!?\uff01\uff1f]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const windows: string[] = []
  for (const match of evidence.matchAll(/(?:\u6bcf(?:\u4e00)?\u5e27|\u9010\u5e27)/gu)) {
    const index = match.index ?? 0
    windows.push(evidence.slice(Math.max(0, index - 100), Math.min(evidence.length, index + 220)).trim())
  }
  return uniqueStrings([...directSegments, ...windows])
}

function firstFrameEnvelopeLiteralAfterAction(segment: string): { rawValue: string; bytes: string[] } | undefined {
  const actionPatterns = [
    /(?:\u524d(?:\u9762|\u90e8)?|\u5e27\u5934|\u5934\u90e8).{0,12}?(?:\u589e\u52a0|\u6dfb\u52a0|\u52a0\u4e0a?|\u9644\u52a0|\u63d2\u5165|\u8865\u5145)/iu,
    /(?:\u589e\u52a0|\u6dfb\u52a0|\u52a0\u4e0a?|\u9644\u52a0|\u63d2\u5165|\u8865\u5145).{0,16}?(?:\u5230|\u5728)?(?:\u6bcf(?:\u4e00)?\u5e27|\u9010\u5e27)?.{0,8}?(?:\u524d(?:\u9762|\u90e8)?|\u5e27\u5934|\u5934\u90e8)/iu,
    /\u524d\u7f00(?:\u503c)?(?:\u4e3a|\u662f|\u91c7\u7528|\u4f7f\u7528|\u8bbe\u4e3a)/iu,
  ]
  const action = actionPatterns
    .map((pattern) => pattern.exec(segment))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))[0]
  if (!action) return undefined
  const afterAction = segment.slice((action.index ?? 0) + action[0].length)
  const tokens = Array.from(afterAction.matchAll(/(?:0x[0-9A-Fa-f]{1,16}|[0-9A-Fa-f]{1,16}H)/gi))
  if (!tokens.length || (tokens[0].index ?? 0) > 40) return undefined
  const selected = [tokens[0]]
  for (const token of tokens.slice(1)) {
    const previous = selected[selected.length - 1]
    const previousEnd = (previous.index ?? 0) + previous[0].length
    const separator = afterAction.slice(previousEnd, token.index ?? previousEnd)
    if (!/^[\s\u3001,\uff0c/]+$/u.test(separator)) break
    selected.push(token)
  }
  const rawValue = selected.map((token) => token[0]).join(" ")
  const bytes = documentOrderedHexBytes(rawValue)
  return bytes ? { rawValue, bytes } : undefined
}

function explicitFrameEnvelopeLengths(segment: string): {
  businessFrameLength?: number
  wireFrameLength?: number
} {
  const businessMatch = segment.match(/(?:\u6bcf(?:\u4e00)?\u5e27|\u9010\u5e27)(?:\u7684)?\s*(\d{1,4})\s*\u5b57\u8282/iu) ??
    segment.match(/(\d{1,4})\s*\u5b57\u8282(?:\u7684)?(?:\u6807\u51c6|\u4e1a\u52a1)?\u5e27(?:\u4e4b)?\u524d/iu)
  const wireMatch = segment.match(/(?:\u7ec4\u6210|\u5f62\u6210|\u6784\u6210|\u53d8\u4e3a|\u53d8\u6210|\u6210\u4e3a|\u5c01\u88c5\u4e3a).{0,12}?(\d{1,4})\s*\u5b57\u8282/iu)
  return {
    businessFrameLength: businessMatch ? Number.parseInt(businessMatch[1], 10) : undefined,
    wireFrameLength: wireMatch ? Number.parseInt(wireMatch[1], 10) : undefined,
  }
}

function modelFrameEnvelopeFromEvidence(
  rawEnvelope: unknown,
  evidence: string,
): DtpProtocolFrameEnvelopeInference {
  if (!isRecord(rawEnvelope) || asString(rawEnvelope.type) !== "fixed_prefix") return { warnings: [] }
  const rawBytes = Array.isArray(rawEnvelope.bytes)
    ? rawEnvelope.bytes.map((value) => normalizeHexByte(asString(value))).filter((value): value is string => Boolean(value))
    : []
  const rawValue = asString(rawEnvelope.raw_value)
  const literalBytes = rawValue ? documentOrderedHexBytes(rawValue) : undefined
  const bytes = literalBytes?.length ? literalBytes : rawBytes
  if (!bytes.length || bytes.length > 8) {
    return { warnings: ["Model frame-envelope candidate was rejected because its prefix bytes are invalid."] }
  }
  if (rawBytes.length && rawBytes.length !== bytes.length) {
    return { warnings: ["Model frame-envelope candidate was rejected because bytes and raw_value disagree."] }
  }
  if (rawBytes.length && rawBytes.some((value, index) => value !== bytes[index])) {
    return { warnings: ["Model frame-envelope candidate was rejected because bytes and raw_value disagree."] }
  }
  const compactEvidence = evidence.toUpperCase().replace(/[\s\u3001,\uff0c:：;\uff1b"'()（）\[\]{}]/gu, "")
  const joinedBytes = bytes.join("")
  const literalIsDocumented = compactEvidence.includes(`${joinedBytes}H`) ||
    compactEvidence.includes(bytes.map((value) => `${value}H`).join(""))
  const perFrameIsDocumented = /(?:\u6bcf(?:\u4e00)?\u5e27|\u9010\u5e27)/u.test(evidence)
  const prefixPositionIsDocumented = /(?:\u524d(?:\u9762|\u90e8)?|\u5e27\u5934|\u5934\u90e8|\u524d\u7f00)/u.test(evidence)
  if (!literalIsDocumented || !perFrameIsDocumented || !prefixPositionIsDocumented) {
    return { warnings: ["Model frame-envelope candidate was rejected because its value, per-frame scope, or prefix position is not supported by source evidence."] }
  }
  const businessFrameLength = asNumber(rawEnvelope.business_frame_length)
  const wireFrameLength = asNumber(rawEnvelope.wire_frame_length)
  if (
    businessFrameLength !== undefined &&
    wireFrameLength !== undefined &&
    businessFrameLength + bytes.length !== wireFrameLength
  ) {
    return {
      warnings: [
        `Model frame-envelope candidate conflicts with documented lengths ${businessFrameLength}+${bytes.length}!=${wireFrameLength}.`,
      ],
    }
  }
  const rawDirections = Array.isArray(rawEnvelope.directions)
    ? uniqueStrings(rawEnvelope.directions.map(asString).filter((value): value is string => value === "send" || value === "receive")) as Array<"send" | "receive">
    : []
  return {
    envelope: {
      type: "fixed_prefix",
      bytes,
      applies_per_frame: true,
      position: "before_frame",
      raw_value: rawValue ?? `${joinedBytes}H`,
      byte_order: "document_order",
      ...(businessFrameLength !== undefined ? { business_frame_length: businessFrameLength } : {}),
      ...(wireFrameLength !== undefined ? { wire_frame_length: wireFrameLength } : {}),
      ...(rawDirections.length ? { directions: rawDirections } : {}),
      confidence: Math.max(0, Math.min(1, asNumber(rawEnvelope.confidence) ?? 0.8)),
      source_text: asString(rawEnvelope.source_text),
    },
    warnings: [],
  }
}

function inferProtocolFrameEnvelope(
  context: DtpProtocolContextPackage,
  busContext: DtpProtocolBusContext | undefined,
  rawModelEnvelope?: unknown,
): DtpProtocolFrameEnvelopeInference {
  if (busContext?.bus_type !== "CAN") return { warnings: [] }
  const identity = inferContextCanInterfaceIdentity(context)
  if (identity.interfaceLevel !== "secondary") return { warnings: [] }
  const evidence = [context.interface_context_text, context.section_text].filter(Boolean).join(" ")
  const warnings: string[] = []
  const candidates = frameEnvelopeEvidenceSegments(evidence).flatMap((segment) => {
    if (!/(?:\u6bcf(?:\u4e00)?\u5e27|\u9010\u5e27)/u.test(segment)) return []
    if (!/(?:\u524d(?:\u9762|\u90e8)?|\u5e27\u5934|\u5934\u90e8|\u524d\u7f00)/u.test(segment)) return []
    const literal = firstFrameEnvelopeLiteralAfterAction(segment)
    if (!literal) {
      if (/(?:\u589e\u52a0|\u6dfb\u52a0|\u52a0\u4e0a?|\u9644\u52a0|\u63d2\u5165|\u8865\u5145|\u524d\u7f00)/u.test(segment)) {
        warnings.push(`Per-frame prefix evidence has no resolvable hexadecimal value: ${segment.slice(0, 160)}`)
      }
      return []
    }
    const lengths = explicitFrameEnvelopeLengths(segment)
    if (
      lengths.businessFrameLength !== undefined &&
      lengths.wireFrameLength !== undefined &&
      lengths.businessFrameLength + literal.bytes.length !== lengths.wireFrameLength
    ) {
      warnings.push(
        `Per-frame prefix ${literal.rawValue} conflicts with documented lengths ${lengths.businessFrameLength}+${literal.bytes.length}!=${lengths.wireFrameLength}.`,
      )
      return []
    }
    const directions: Array<"send" | "receive"> = []
    if (/(?:\u53d1\u9001|\u53d1\u51fa|\u5199\u5165|\u4e0b\u53d1)/u.test(segment)) directions.push("send")
    if (/(?:\u63a5\u6536|\u6536\u5230|\u8bfb\u53d6|\u4e0a\u4f20)/u.test(segment)) directions.push("receive")
    return [{ segment, literal, lengths, directions }]
  })
  if (!candidates.length) {
    const modelInference = modelFrameEnvelopeFromEvidence(rawModelEnvelope, evidence)
    return {
      envelope: modelInference.envelope,
      warnings: uniqueStrings([...warnings, ...modelInference.warnings]),
    }
  }
  const byPrefix = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    const key = candidate.literal.bytes.join(" ")
    byPrefix.set(key, [...(byPrefix.get(key) ?? []), candidate])
  }
  if (byPrefix.size > 1) {
    warnings.push(`Conflicting per-frame prefixes were documented for the same secondary CAN interface: ${Array.from(byPrefix.keys()).join(", ")}.`)
    return { warnings: uniqueStrings(warnings) }
  }
  const matches = Array.from(byPrefix.values())[0]
  const selected = [...matches].sort((left, right) => (
    Number(right.lengths.businessFrameLength !== undefined) + Number(right.lengths.wireFrameLength !== undefined) -
    Number(left.lengths.businessFrameLength !== undefined) - Number(left.lengths.wireFrameLength !== undefined)
  ))[0]
  const directions = uniqueStrings(matches.flatMap((candidate) => candidate.directions)) as Array<"send" | "receive">
  return {
    envelope: {
      type: "fixed_prefix",
      bytes: selected.literal.bytes,
      applies_per_frame: true,
      position: "before_frame",
      raw_value: selected.literal.rawValue,
      byte_order: "document_order",
      ...(selected.lengths.businessFrameLength !== undefined
        ? { business_frame_length: selected.lengths.businessFrameLength }
        : {}),
      ...(selected.lengths.wireFrameLength !== undefined
        ? { wire_frame_length: selected.lengths.wireFrameLength }
        : {}),
      ...(directions.length ? { directions } : {}),
      confidence: selected.lengths.businessFrameLength !== undefined && selected.lengths.wireFrameLength !== undefined ? 1 : 0.9,
      source_text: selected.segment.slice(0, 240),
    },
    warnings: uniqueStrings(warnings),
  }
}

function fieldsFromValuePlan(plan: PacketFieldValuePlan[] | undefined): DtpProtocolFieldDefinition[] {
  return (plan ?? []).map((item) => ({
    name: item.field_name,
    type: "fixed",
    value: normalizeHexByte(item.value) ?? item.value,
    source: item.value_source,
    source_table_id: item.source_table_id,
    source_text: item.source_text,
    confidence: item.confidence,
    warnings: [],
  }))
}

function headerIndex(headers: string[], patterns: RegExp[]): number {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)))
}

function getTableHeader(table: SectionProtocolRelationTableInput): string[] {
  return table.rows[0] ?? []
}

function alignDictionaryRowToHeader(row: string[], header: string[]): string[] {
  const firstHeader = normalizeLookupText(header[0])
  if (
    row.length === header.length - 1 &&
    /^(?:\u5e8f\u53f7|no|index)$/i.test(firstHeader)
  ) {
    return ["", ...row]
  }
  return row
}

function bestDictionaryHeaderIndex(headers: string[], scoreHeader: (header: string) => number): number {
  let bestIndex = -1
  let bestScore = 0
  headers.forEach((header, index) => {
    const score = scoreHeader(header)
    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  })
  return bestIndex
}

function findDictionaryColumns(table: SectionProtocolRelationTableInput): {
  nameIndex: number
  codeIndex: number
} | null {
  const headers = getTableHeader(table).map((header) => normalizeLookupText(header))
  let nameIndex = bestDictionaryHeaderIndex(headers, (header) => {
    let score = 0
    if (/指令名称|参数名称|名称|项目|command.*name|name/i.test(header)) score += 4
    if (/指令码字|指令码|码字|code|数据/.test(header)) score -= 5
    return score
  })
  let codeIndex = bestDictionaryHeaderIndex(headers, (header) => {
    let score = 0
    if (/指令码字|指令码|码字|code/i.test(header)) score += 5
    if (/数据/.test(header)) score += 2
    if (/指令名称|参数名称|名称|项目|name/i.test(header)) score -= 4
    return score
  })

  if (nameIndex < 0) nameIndex = headerIndex(headers, [/指令名称/, /名称/, /项目/, /参数名称/, /command.*name/i, /name/i])
  if (codeIndex < 0) codeIndex = headerIndex(headers, [/指令码字/, /码字/, /指令码/, /code/i, /数据/])
  if (nameIndex === codeIndex) {
    codeIndex = headers.findIndex((header, index) => index !== nameIndex && /指令码字|码字|指令码|code/i.test(header))
  }
  if (nameIndex < 0 || codeIndex < 0) return null
  return { nameIndex, codeIndex }
}

function extractCommandCodeBytes(value: string | undefined): string[] {
  if (!value) return []
  const normalized = value.replace(/H/gi, "").replace(/[^0-9A-Fa-f]/g, "")
  if (!normalized || normalized.length % 2 !== 0) return []
  const bytes: string[] = []
  for (let index = 0; index < normalized.length; index += 2) {
    const byte = normalizeHexByte(normalized.slice(index, index + 2))
    if (byte) bytes.push(byte)
  }
  return bytes
}

function commandCodeKey(value: string | undefined): string {
  return extractCommandCodeBytes(value).join("")
}

function dictionaryRowCodeMatchesOption(rowCodeBytes: string[], option: DtpProtocolFieldOption): boolean {
  const optionCode = commandCodeKey(option.source)
  const rowCode = rowCodeBytes.join("")
  if (optionCode && rowCode.startsWith(optionCode)) return true
  if (option.value && rowCodeBytes[1] === option.value) return true
  return false
}

function enrichDictionaryEnumLabelsFromTable(
  field: DtpProtocolFieldDefinition,
  context: DtpProtocolContextPackage,
): DtpProtocolFieldDefinition {
  if (!field.options?.length || !field.source_table_id) return field
  const dictionaryTable = context.tables.find((table) => table.id === field.source_table_id)
  if (!dictionaryTable) return field
  const columns = findDictionaryColumns(dictionaryTable)
  if (!columns) return field

  const header = getTableHeader(dictionaryTable)
  const rows = dictionaryTable.rows.slice(1)
    .map((row) => {
      const alignedRow = alignDictionaryRowToHeader(row, header)
      return {
        row: alignedRow,
        name: cleanGeneratedDataFileBaseName(alignedRow[columns.nameIndex]),
        codeBytes: extractCommandCodeBytes(alignedRow[columns.codeIndex]),
      }
    })
    .filter((item) => item.name && item.codeBytes.length)

  if (!rows.length) return field

  const usedRowIndexes = new Set<number>()
  const options = field.options.map((option) => {
    const rowIndex = rows.findIndex((candidate, index) =>
      !usedRowIndexes.has(index) && dictionaryRowCodeMatchesOption(candidate.codeBytes, option),
    )
    if (rowIndex < 0) return option

    usedRowIndexes.add(rowIndex)
    const candidate = rows[rowIndex]
    return {
      ...option,
      label: candidate.name,
      source: candidate.row.filter(Boolean).join(" | "),
    }
  })

  return { ...field, options }
}

function frameFieldNames(layout: string[]): string[] {
  return layout
    .map((item) => item.match(/^(W\d+)$/i)?.[1]?.toUpperCase())
    .filter((item): item is string => Boolean(item))
}

function alignDictionaryCodeBytesToFrameFields(
  codeBytes: string[],
  frameLayout: string[],
  fieldCount: number,
): string[] {
  if (codeBytes.length <= fieldCount) return codeBytes

  const firstFieldIndex = frameLayout.findIndex((item) => /^W\d+$/i.test(item))
  const fixedPrefixBytes = firstFieldIndex > 0
    ? frameLayout.slice(0, firstFieldIndex).map(normalizeHexByte).filter((item): item is string => Boolean(item))
    : []
  const extraCount = codeBytes.length - fieldCount
  const prefixToDrop = codeBytes.slice(0, extraCount)
  const fixedSuffix = fixedPrefixBytes.slice(-extraCount)

  if (fixedSuffix.length === prefixToDrop.length && fixedSuffix.every((byte, index) => byte === prefixToDrop[index])) {
    return codeBytes.slice(extraCount)
  }

  return codeBytes.slice(codeBytes.length - fieldCount)
}

function dictionaryRowVariants(
  relation: SectionProtocolRelation,
  dictionaryTable: SectionProtocolRelationTableInput | undefined,
  frameLayout: string[],
): DtpProtocolVariantDefinition[] {
  if (!dictionaryTable) return []
  const columns = findDictionaryColumns(dictionaryTable)
  if (!columns) return []
  const fields = frameFieldNames(frameLayout)
  if (!fields.length) return []

  const header = getTableHeader(dictionaryTable)
  return dictionaryTable.rows.slice(1)
    .map((row): DtpProtocolVariantDefinition | null => {
      const alignedRow = alignDictionaryRowToHeader(row, header)
      const rawName = alignedRow[columns.nameIndex]?.trim()
      const codeBytes = extractCommandCodeBytes(alignedRow[columns.codeIndex])
      const bytes = alignDictionaryCodeBytesToFrameFields(codeBytes, frameLayout, fields.length)
      if (!rawName || bytes.length < fields.length) return null
      const name = cleanGeneratedDataFileBaseName(rawName)
      return {
        name,
        fields: fields.map((fieldName, index) => ({
          name: fieldName,
          type: "fixed",
          value: bytes[index],
          source: "dictionary-row",
          source_table_id: dictionaryTable.id,
          source_text: alignedRow.filter(Boolean).join(" | "),
          confidence: relation.confidence,
          warnings: [],
        })),
        evidence: [dictionaryTable.caption ?? dictionaryTable.id, alignedRow.filter(Boolean).join(" | ")],
        warnings: [],
        confidence: relation.confidence,
      }
    })
    .filter((item): item is DtpProtocolVariantDefinition => Boolean(item))
}

function extractExplicitSupportByte(row: string[]): string | undefined {
  for (const cell of row) {
    const trimmed = cell.trim()
    const exact = trimmed.match(/^(?:0x([0-9A-Fa-f]{1,2})|([0-9A-Fa-f]{1,2})H)$/)
    const value = exact?.[1] ?? exact?.[2]
    if (value) return value.toUpperCase().padStart(2, "0")
  }

  const rowText = row.filter(Boolean).join(" ")
  const normalWholeByte = rowText.match(/(?:^|[\s,，;；])(?:0x)?([0-9A-Fa-f]{1,2})H?\s*[:：]\s*正常/)
  if (normalWholeByte?.[1]) return normalWholeByte[1].toUpperCase().padStart(2, "0")

  const optionByte = rowText.match(/(?:^|[^A-Za-z0-9])([0-9A-Fa-f]{1,2})H\s*[:：]/)
  if (optionByte?.[1]) return optionByte[1].toUpperCase().padStart(2, "0")

  return undefined
}

function shouldDefaultSupportRowToZero(row: string[]): boolean {
  const rowText = normalizeLookupText(row.filter(Boolean).join(" "))
  return /十六进制原码|采集值原码|数据定义|参数|门限|状态|标志|模式|选择|设置|物理值|原码值|备用|预留|公式|转换|N\s*=|Bit\d+/i.test(rowText)
}

function extractDataValuesFromSupportTable(table: SectionProtocolRelationTableInput): Map<string, string> {
  const values = new Map<string, string>()
  for (const row of table.rows) {
    const dataName = row.find((cell) => /^W\d+$/i.test(cell.trim()))?.trim().toUpperCase()
    if (!dataName) continue

    const explicitByte = extractExplicitSupportByte(row)
    if (explicitByte) {
      values.set(dataName, explicitByte)
      continue
    }

    if (shouldDefaultSupportRowToZero(row)) {
      values.set(dataName, "00")
    }
  }
  return values
}

function findFieldSourceText(fieldName: string, table: SectionProtocolRelationTableInput): string | undefined {
  const key = fieldName.toUpperCase()
  const matched = table.rows.find((row) => row.some((cell) => cell.trim().toUpperCase() === key))
  return matched?.filter(Boolean).join(" | ")
}

function mergeFieldValuePlans(
  base: PacketFieldValuePlan[],
  overrides: PacketFieldValuePlan[],
): PacketFieldValuePlan[] {
  const merged = new Map<string, PacketFieldValuePlan>()
  for (const item of base) merged.set(item.field_name.toUpperCase(), item)
  for (const item of overrides) merged.set(item.field_name.toUpperCase(), item)
  return Array.from(merged.values()).sort((left, right) => {
    const leftIndex = Number(left.field_name.replace(/^W/i, ""))
    const rightIndex = Number(right.field_name.replace(/^W/i, ""))
    return leftIndex - rightIndex
  })
}

function buildFrameFieldValuePlan(
  frameLayout: string[],
  supportTables: SectionProtocolRelationTableInput[],
  overrides: PacketFieldValuePlan[] = [],
): PacketFieldValuePlan[] {
  const supportValues = new Map<string, { value: string; table: SectionProtocolRelationTableInput; sourceText?: string }>()
  for (const supportTable of supportTables) {
    const tableValues = extractDataValuesFromSupportTable(supportTable)
    for (const [fieldName, value] of tableValues) {
      if (supportValues.has(fieldName)) continue
      supportValues.set(fieldName, {
        value,
        table: supportTable,
        sourceText: findFieldSourceText(fieldName, supportTable),
      })
    }
  }

  const basePlan = frameFieldNames(frameLayout).map((fieldName): PacketFieldValuePlan => {
    const supportValue = supportValues.get(fieldName)
    if (supportValue) {
      return {
        field_name: fieldName,
        value: supportValue.value,
        value_source: "support-table",
        source_table_id: supportValue.table.id,
        source_text: supportValue.sourceText,
        confidence: 0.72,
        reasoning: [`${fieldName} was filled from a related support/definition table.`],
      }
    }

    return {
      field_name: fieldName,
      value: "00",
      value_source: "fallback-zero",
      source_table_id: undefined,
      source_text: undefined,
      confidence: 0.2,
      reasoning: [`${fieldName} has no concrete value in the current field plan; 00 is used as a loose-mode fallback.`],
    }
  })

  return mergeFieldValuePlans(basePlan, overrides)
}

function supportTableDefinesFrameDataBlock(table: SectionProtocolRelationTableInput): boolean {
  const fields = extractDataValuesFromSupportTable(table)
  return fields.has("W0") && fields.has("W1") && fields.size >= 3
}

type FieldVariantChoice = {
  suffix: string
  overrides: PacketFieldValuePlan[]
  warnings: string[]
}

type FieldVariantGroup = {
  fieldName: string
  choices: FieldVariantChoice[]
}

type BitFieldSegment = {
  bits: number[]
  sourceText: string
  options: Array<{ binary: string; label: string }>
}

function sanitizeVariantLabel(value: string | undefined): string {
  return sanitizeReadableFileBaseName(value)
    .replace(/(?:D\d)+\s*[:：].*$/i, "")
    .replace(/[;,，；]\s*(?:D\d)+\s*[-:：].*$/i, "")
    .replace(/^[,，；。+]+|[,，；。+]+$/g, "")
    .replace(/^[\s:：\-]+/, "")
    .replace(/\s+/g, "")
}

function supportTableFieldRows(table: SectionProtocolRelationTableInput): Array<{ fieldName: string; rowText: string }> {
  return table.rows
    .map((row) => {
      const fieldName = row.find((cell) => /^W\d+$/i.test(cell.trim()))?.trim().toUpperCase()
      if (!fieldName) return null
      return {
        fieldName,
        rowText: row.filter(Boolean).join("\n"),
      }
    })
    .filter((item): item is { fieldName: string; rowText: string } => Boolean(item))
}

function isBitFieldDescription(text: string): boolean {
  return /(?:D\d(?:\s*D\d)+|D\d\s*[:：]|bit\s*\d|位\s*\d)/i.test(text)
}

function isBusinessExpandableDescription(text: string): boolean {
  return /选择|模式|方式|回路|通道|加热|控温|控制|温度|工作|类型/.test(text)
}

function enumOptionsFromFieldText(text: string): Array<{ value: string; label: string }> {
  if (isBitFieldDescription(text)) return []

  const options: Array<{ value: string; label: string }> = []
  const optionPattern = /(?:^|[\s\r\n,，;；])((?:0x)?[0-9A-Fa-f]{1,2}H?|[01])\s*[-:：]\s*([^,，;；。\r\n]+)/g
  for (const match of text.matchAll(optionPattern)) {
    const value = normalizeHexByte(match[1])
    const label = sanitizeVariantLabel(match[2])
    if (!value || !label) continue
    options.push({ value, label })
  }

  const unique = new Map<string, { value: string; label: string }>()
  for (const option of options) unique.set(`${option.value}:${option.label}`, option)
  return Array.from(unique.values())
}

function enumVariantGroup(table: SectionProtocolRelationTableInput, fieldName: string, rowText: string): FieldVariantGroup | null {
  if (!isBusinessExpandableDescription(rowText)) return null

  const options = enumOptionsFromFieldText(rowText)
  if (options.length < 2) return null

  return {
    fieldName,
    choices: options.slice(0, 8).map((option) => ({
      suffix: option.label,
      warnings: [],
      overrides: [
        {
          field_name: fieldName,
          value: option.value,
          value_source: "enum-option",
          source_table_id: table.id,
          source_text: rowText,
          confidence: 0.86,
          reasoning: [`${fieldName} is expanded from enum option "${option.label}".`],
        },
      ],
    })),
  }
}

function bitFieldSegmentsFromText(text: string): BitFieldSegment[] {
  const segments: BitFieldSegment[] = []
  const segmentPattern = /((?:D\s*\d\s*)+)\s*(?:[:：]|\s+(?=[01]{1,8}\s*[-:：]))\s*([\s\S]*?)(?=(?:D\s*\d\s*)+\s*(?:[:：]|\s+(?=[01]{1,8}\s*[-:：]))|$)/gi
  for (const match of text.matchAll(segmentPattern)) {
    const segmentText = match[2] ?? ""
    const bits = Array.from(match[1].matchAll(/D\s*(\d)/gi)).map((item) => Number(item[1]))
    if (!bits.length) continue

    const options: BitFieldSegment["options"] = []
    const optionPattern = /([01]{1,8})\s*[-:：]\s*([\s\S]*?)(?=(?:[,，;；]\s*)?[01]{1,8}\s*[-:：]|(?:D\s*\d\s*)+\s*[:：]|$)/g
    for (const optionMatch of segmentText.matchAll(optionPattern)) {
      const binary = optionMatch[1]
      const label = sanitizeVariantLabel(optionMatch[2])
      if (binary.length > bits.length || !label) continue
      options.push({ binary: binary.padStart(bits.length, "0"), label })
    }

    if (options.length) {
      segments.push({
        bits,
        sourceText: `${match[1].replace(/\s+/g, "")}: ${segmentText.trim()}`,
        options,
      })
    }
  }

  return segments
}

function bitFieldSegmentHasBits(segment: BitFieldSegment, expectedBits: number[]): boolean {
  const bits = new Set(segment.bits)
  return expectedBits.every((bit) => bits.has(bit)) && segment.bits.length === expectedBits.length
}

function optionMatching(segment: BitFieldSegment | undefined, pattern: RegExp): { binary: string; label: string } | undefined {
  return segment?.options.find((option) => pattern.test(option.label))
}

function defaultBitFieldOption(segment: BitFieldSegment): { binary: string; label: string } {
  return (
    optionMatching(segment, /默认|恢复|闭环|停止/) ??
    segment.options.find((option) => /^0+$/.test(option.binary)) ??
    { binary: "0".repeat(segment.bits.length), label: "默认0" }
  )
}

function bitFieldByteValue(
  segments: BitFieldSegment[],
  selectedOptions: Map<BitFieldSegment, { binary: string; label: string }>,
): string {
  let value = 0
  for (const segment of segments) {
    const selected = selectedOptions.get(segment) ?? defaultBitFieldOption(segment)
    for (let index = 0; index < segment.bits.length; index += 1) {
      const bitValue = selected.binary[index] === "1" ? 1 : 0
      value |= bitValue << segment.bits[index]
    }
  }
  return value.toString(16).toUpperCase().padStart(2, "0")
}

function bitFieldChoice(
  table: SectionProtocolRelationTableInput,
  fieldName: string,
  rowText: string,
  segments: BitFieldSegment[],
  suffix: string,
  selectedOptions: Map<BitFieldSegment, { binary: string; label: string }>,
): FieldVariantChoice {
  const sourceText = Array.from(selectedOptions.entries())
    .map(([segment, option]) => `${segment.sourceText} => ${option.binary}-${option.label}`)
    .join("; ")

  return {
    suffix,
    warnings: [],
    overrides: [
      {
        field_name: fieldName,
        value: bitFieldByteValue(segments, selectedOptions),
        value_source: "bitfield-enum",
        source_table_id: table.id,
        source_text: sourceText || rowText,
        confidence: 0.84,
        reasoning: [`${fieldName} is assembled from bit-field options in ${table.caption ?? table.id}.`],
      },
    ],
  }
}

function bitFieldVariantGroup(table: SectionProtocolRelationTableInput, fieldName: string, rowText: string): FieldVariantGroup | null {
  if (!isBusinessExpandableDescription(rowText)) return null

  const segments = bitFieldSegmentsFromText(rowText)
  if (!segments.length) return null

  const modeSegment = segments.find((segment) => segment.options.some((option) => /闭环|开环/.test(option.label)))
  const heatSegment = segments.find((segment) => segment.options.some((option) => /开启加热|停止加热/.test(option.label)))
  const resistorRuleSegment = segments.find((segment) => bitFieldSegmentHasBits(segment, [4]))
  const temperatureSegment = segments.find((segment) => bitFieldSegmentHasBits(segment, [3, 2, 1, 0]))
  const choices: FieldVariantChoice[] = []

  if (modeSegment) {
    const closed = optionMatching(modeSegment, /闭环/)
    const open = optionMatching(modeSegment, /开环/)

    if (closed) {
      choices.push(bitFieldChoice(table, fieldName, rowText, segments, "闭环默认控温", new Map([[modeSegment, closed]])))
    }

    if (open && heatSegment) {
      for (const heatOption of heatSegment.options.filter((option) => /开启加热|停止加热/.test(option.label))) {
        choices.push(bitFieldChoice(
          table,
          fieldName,
          rowText,
          segments,
          heatOption.label.includes("开环时") ? heatOption.label : `开环${heatOption.label}`,
          new Map([
            [modeSegment, open],
            [heatSegment, heatOption],
          ]),
        ))
      }
    } else if (open) {
      choices.push(bitFieldChoice(table, fieldName, rowText, segments, "开环", new Map([[modeSegment, open]])))
    }
  }

  if (temperatureSegment) {
    const closed = optionMatching(modeSegment, /闭环/)
    const explicitResistorRule = optionMatching(resistorRuleSegment, /按照|选取控温电阻/)
    for (const temperatureOption of temperatureSegment.options.filter((option) => /温度\d+/.test(option.label)).slice(0, 7)) {
      choices.push(bitFieldChoice(
        table,
        fieldName,
        rowText,
        segments,
        temperatureOption.label,
        new Map([
          ...(closed && modeSegment ? [[modeSegment, closed] as const] : []),
          ...(explicitResistorRule && resistorRuleSegment ? [[resistorRuleSegment, explicitResistorRule] as const] : []),
          [temperatureSegment, temperatureOption],
        ]),
      ))
    }
  }

  if (!choices.length) {
    const firstBusinessSegment = segments.find((segment) => segment.options.length > 1) ?? segments[0]
    for (const option of firstBusinessSegment.options.slice(0, 4)) {
      choices.push(bitFieldChoice(table, fieldName, rowText, segments, option.label, new Map([[firstBusinessSegment, option]])))
    }
  }

  return choices.length ? { fieldName, choices: choices.slice(0, 16) } : null
}

function supportTableFieldVariantGroups(table: SectionProtocolRelationTableInput): FieldVariantGroup[] {
  return supportTableFieldRows(table)
    .map(({ fieldName, rowText }) =>
      isBitFieldDescription(rowText)
        ? bitFieldVariantGroup(table, fieldName, rowText)
        : enumVariantGroup(table, fieldName, rowText),
    )
    .filter((item): item is FieldVariantGroup => Boolean(item))
    .sort((left, right) => Number(left.fieldName.slice(1)) - Number(right.fieldName.slice(1)))
}

function supportTableVariantChoices(table: SectionProtocolRelationTableInput): FieldVariantChoice[] {
  const groups = supportTableFieldVariantGroups(table)
  if (!groups.length) return [{ suffix: "", overrides: [], warnings: [] }]

  let combinations: FieldVariantChoice[] = [{ suffix: "", overrides: [], warnings: [] }]
  for (const group of groups.slice(0, 3)) {
    const next: FieldVariantChoice[] = []
    for (const combination of combinations) {
      for (const choice of group.choices) {
        next.push({
          suffix: [combination.suffix, choice.suffix].filter(Boolean).join("-"),
          overrides: [...combination.overrides, ...choice.overrides],
          warnings: [...combination.warnings, ...choice.warnings],
        })
      }
    }
    combinations = next.slice(0, 32)
  }

  return combinations
}

function supportTableVariants(
  supportTable: SectionProtocolRelationTableInput,
  relation: SectionProtocolRelation,
): DtpProtocolVariantDefinition[] {
  return supportTableVariantChoices(supportTable)
    .filter((choice) => choice.suffix || choice.overrides.length)
    .map((choice): DtpProtocolVariantDefinition => ({
      name: choice.suffix,
      fields: fieldsFromValuePlan(choice.overrides),
      evidence: [supportTable.caption ?? supportTable.id],
      warnings: choice.warnings,
      confidence: Math.max(0.82, relation.confidence),
    }))
}

function buildHeuristicProtocolDefinitionsForContext(context: DtpProtocolContextPackage): {
  protocols: DtpProtocolDefinition[]
  nonGeneratedTables: DtpNonGeneratedTable[]
  warnings: string[]
} {
  const tablesById = new Map(context.tables.map((table) => [table.id, table]))
  const protocols: DtpProtocolDefinition[] = []
  const nonGeneratedTables: DtpNonGeneratedTable[] = []
  const generatedTableIds = new Set<string>()
  const supportOnlyTableIds = new Set<string>()
  const protocolVariables = protocolVariablesFromContext(context)
  const relationNameCounts = new Map<string, number>()
  for (const relation of context.heuristic_relations) {
    const key = normalizeLookupText(relation.preferred_name)
    if (key) relationNameCounts.set(key, (relationNameCounts.get(key) ?? 0) + 1)
  }

  for (const relation of context.heuristic_relations) {
    const frameTable = tablesById.get(relation.frame_table_id)
    if (!frameTable) continue
    const inferredIdentity = inferTableProtocolIdentity(context, frameTable)
    const preferredName = usablePreferredProtocolName(relation.preferred_name) ?? inferredIdentity.baseName
    const flowDirection = relation.flow_direction && relation.flow_direction !== "unknown"
      ? relation.flow_direction
      : inferredIdentity.flowDirection
    const tablePayloadLength = frameTable.caption?.match(/(?:\u957f\u5ea6\s*)?(\d{1,4})\s*\u5b57\u8282/i)?.[1]
    const needsLengthDisambiguation = Boolean(
      preferredName &&
      tablePayloadLength &&
      (relationNameCounts.get(normalizeLookupText(relation.preferred_name)) ?? 0) > 1 &&
      !/\d{1,4}\s*\u5b57\u8282/i.test(preferredName),
    )
    const baseName = cleanGeneratedDataFileBaseName(
      needsLengthDisambiguation
        ? `${tablePayloadLength}\u5b57\u8282${preferredName}`
        : preferredName || frameTable.caption || frameTable.id,
    )
    const orderedTables = [...context.tables].sort((left, right) => tableOrdinal(left) - tableOrdinal(right))
    const frameIndex = orderedTables.findIndex((table) => table.id === relation.frame_table_id)
    const nextFrameIndex = orderedTables.findIndex((table, index) => index > frameIndex && table.is_frame_format)
    const relatedSupportIds = frameIndex >= 0
      ? orderedTables
        .slice(frameIndex + 1, nextFrameIndex >= 0 ? nextFrameIndex : orderedTables.length)
        .filter((table) => !table.is_frame_format && table.id !== relation.dictionary_table_id)
        .map((table) => table.id)
      : []
    const supportIds = uniqueStrings(relatedSupportIds)
    const supportTables = supportIds
      .map((tableId) => tablesById.get(tableId))
      .filter((table): table is SectionProtocolRelationTableInput => Boolean(table))
    const frameLayouts = frameByteLayoutsFromTableInput(frameTable)
    const frameLayout = frameLayouts[0] ?? []
    const dictionaryTable = relation.dictionary_table_id ? tablesById.get(relation.dictionary_table_id) : undefined
    const busContext = inferProtocolBusContext(context, frameTable)
    const frameEnvelopeInference = inferProtocolFrameEnvelope(context, busContext)

    generatedTableIds.add(relation.frame_table_id)
    if (relation.dictionary_table_id) generatedTableIds.add(relation.dictionary_table_id)
    for (const tableId of supportIds) {
      supportOnlyTableIds.add(tableId)
      nonGeneratedTables.push({
        table_id: tableId,
        reason: "Support table used to explain fields for a generated protocol; it is not a standalone data file.",
      })
    }

    if (relation.generation_mode === "one_file_per_dictionary_row") {
      const variants = dictionaryRowVariants(relation, dictionaryTable, frameLayout)
      const dictionaryBaseName = resolveDictionaryProtocolBaseName(relation, frameTable, dictionaryTable)
      const protocolFields = fieldsFromValuePlan(relation.field_value_plan)
      const checksum = checksumDefinitionForFrameTable(frameTable, relation.checksum_rule)
      const packetGroups = expandReferenceBackedPacketGroups(
        context,
        protocolFramesFromTableInput(frameTable, frameLayouts, protocolFields, checksum, context),
      )
      protocols.push({
        protocol_id: `${context.section_model_id}-${protocols.length + 1}`,
        source_section: relation.source_section ?? context.section_title,
        flow_direction: flowDirection,
        base_file_name: dictionaryBaseName,
        generation_mode: protocolGenerationModeFromRelation(relation),
        frames: packetGroups.frames,
        bus_context: busContext,
        variables: protocolVariables.length ? protocolVariables : undefined,
        frame_envelope: frameEnvelopeInference.envelope,
        fields: protocolFields,
        variants: variants.length ? variants : undefined,
        evidence: uniqueStrings([
          frameTable.caption ?? frameTable.id,
          relation.dictionary_table_id ? (tablesById.get(relation.dictionary_table_id)?.caption ?? relation.dictionary_table_id) : "",
          ...supportIds.map((tableId) => tablesById.get(tableId)?.caption ?? tableId),
        ]),
        warnings: uniqueStrings([
          ...(flowDirection !== "unknown"
            ? []
            : ["Flow direction is unknown; deterministic writer should skip or warn before writing."]),
          ...(!variants.length ? ["Dictionary relation did not produce row variants."] : []),
          ...packetGroups.warnings,
          ...frameEnvelopeInference.warnings,
        ]),
        confidence: relation.confidence,
        understanding_source: "heuristic-fallback",
      })
      continue
    }

    const dataBlockSupportTables = supportTables.filter(supportTableDefinesFrameDataBlock)
    const frameFileSupportSets = dataBlockSupportTables.length
      ? dataBlockSupportTables.map((supportTable) => [supportTable])
      : [supportTables]

    for (const selectedSupportTables of frameFileSupportSets) {
      const selectedDataBlockTable = selectedSupportTables.length === 1 && supportTableDefinesFrameDataBlock(selectedSupportTables[0])
        ? selectedSupportTables[0]
        : undefined
      const protocolVariants = selectedDataBlockTable ? supportTableVariants(selectedDataBlockTable, relation) : []
      const protocolBaseName = selectedDataBlockTable
        ? cleanGeneratedDataFileBaseName(selectedDataBlockTable.caption ?? selectedDataBlockTable.id)
        : baseName
      const protocolFields = fieldsFromValuePlan(
        buildFrameFieldValuePlan(frameLayout, selectedSupportTables, relation.field_value_plan ?? []),
      )
      const checksum = checksumDefinitionForFrameTable(frameTable, relation.checksum_rule)

      const packetGroups = expandReferenceBackedPacketGroups(
        context,
        protocolFramesFromTableInput(frameTable, frameLayouts, protocolFields, checksum, context),
      )
      protocols.push({
        protocol_id: `${context.section_model_id}-${protocols.length + 1}`,
        source_section: relation.source_section ?? context.section_title,
        flow_direction: flowDirection,
        base_file_name: protocolBaseName,
        generation_mode: protocolVariants.length ? "expand_variants" : "single_file",
        frames: packetGroups.frames,
        bus_context: busContext,
        variables: protocolVariables.length ? protocolVariables : undefined,
        frame_envelope: frameEnvelopeInference.envelope,
        fields: protocolFields,
        variants: protocolVariants.length ? protocolVariants : undefined,
        evidence: uniqueStrings([
          frameTable.caption ?? frameTable.id,
          ...selectedSupportTables.map((table) => table.caption ?? table.id),
        ]),
        warnings: uniqueStrings([
          ...(flowDirection !== "unknown"
            ? []
            : ["Flow direction is unknown; deterministic writer should skip or warn before writing."]),
          ...packetGroups.warnings,
          ...frameEnvelopeInference.warnings,
        ]),
        confidence: Math.max(selectedDataBlockTable ? 0.82 : relation.confidence, relation.confidence),
        understanding_source: "heuristic-fallback",
      })
    }
  }

  for (const table of context.tables) {
    if (generatedTableIds.has(table.id)) continue
    if (supportOnlyTableIds.has(table.id)) continue
    if (!context.primary_table_ids.includes(table.id) && !context.support_table_ids.includes(table.id)) continue
    nonGeneratedTables.push({
      table_id: table.id,
      reason: "No protocol relation selected this table as a standalone generated protocol.",
    })
  }

  return { protocols, nonGeneratedTables, warnings: [] }
}

function selectorHeaderIndex(row: string[], pattern: RegExp): number {
  return row.findIndex((cell) => pattern.test(cell.replace(/\s+/g, "")))
}

function normalizeSelectorByte(value: string): string | undefined {
  const match = value.trim().match(/^(?:0x)?([0-9A-Fa-f]{1,2})H?$/i)
  return match?.[1].toUpperCase().padStart(2, "0")
}

function commonProtocolScope(protocols: DtpProtocolDefinition[]): Pick<
  DtpProtocolSelectorRelation,
  "bus_type" | "interface_level" | "interface_id"
> {
  const common = <T>(values: Array<T | undefined>): T | undefined => {
    const present = values.filter((value): value is T => value !== undefined)
    return present.length > 0 && new Set(present).size === 1 ? present[0] : undefined
  }
  return {
    bus_type: common(protocols.map((protocol) => protocol.bus_context?.bus_type)),
    interface_level: common(protocols.map((protocol) => protocol.bus_context?.interface_level)),
    interface_id: common(protocols.map((protocol) => protocol.bus_context?.interface_id)),
  }
}

function buildDeterministicProtocolSelectorRelations(
  context: DtpProtocolContextPackage,
  protocols: DtpProtocolDefinition[],
): DtpProtocolSelectorRelation[] {
  const telemetryProtocols = protocols.filter((protocol) => /遥测|telemetry/i.test([
    protocol.base_file_name,
    protocol.source_section,
    ...protocol.evidence,
  ].filter(Boolean).join(" ")))
  const frameCounts = new Set(telemetryProtocols.map((protocol) => getDtpProtocolFrames(protocol).length))
  if (telemetryProtocols.length < 2 || frameCounts.size < 2) return []

  const relations: DtpProtocolSelectorRelation[] = []
  const addressHeaderPattern = /^(?:(?:一|二)级)?(?:CAN)?(?:节点)?(?:(?:站|节点|终端|设备|单机)地址)$/i
  const frameCountHeaderPattern = /^(?:(?:遥测|数据)?帧(?:数|数量|个数))$/i
  for (const table of context.tables) {
    const headerRowIndex = table.rows.slice(0, 5).findIndex((row) => (
      selectorHeaderIndex(row, addressHeaderPattern) >= 0 &&
      selectorHeaderIndex(row, frameCountHeaderPattern) >= 0
    ))
    if (headerRowIndex < 0) continue
    const header = table.rows[headerRowIndex]
    const selectorIndex = selectorHeaderIndex(header, addressHeaderPattern)
    const frameCountIndex = selectorHeaderIndex(header, frameCountHeaderPattern)
    const mappingRows = table.rows.slice(headerRowIndex + 1).flatMap((row) => {
      const selectorValue = normalizeSelectorByte(row[selectorIndex] ?? "")
      const frameCountMatch = (row[frameCountIndex] ?? "").trim().match(/^\d+$/)
      const targetFrameCount = frameCountMatch ? Number.parseInt(frameCountMatch[0], 10) : undefined
      if (!selectorValue || !targetFrameCount) return []
      const targets = telemetryProtocols.filter((protocol) => getDtpProtocolFrames(protocol).length === targetFrameCount)
      if (targets.length !== 1) return []
      return [{ selectorValue, targetFrameCount, target: targets[0], rowText: row.join(" | ") }]
    })
    if (!mappingRows.length) continue

    const targetProtocols = uniqueStrings(mappingRows.map((item) => item.target.protocol_id))
      .map((protocolId) => protocols.find((protocol) => protocol.protocol_id === protocolId))
      .filter((protocol): protocol is DtpProtocolDefinition => Boolean(protocol))
    relations.push({
      relation_id: `${context.section_model_id}-selector-${table.id}`,
      section_model_id: context.section_model_id,
      selector_name: header[selectorIndex].trim() || "站地址",
      selector_aliases: uniqueStrings([header[selectorIndex].trim(), "站地址", "节点地址", "终端地址", "设备地址", "单机地址"]),
      selector_type: "uint8",
      protocol_family: "telemetry",
      ...commonProtocolScope(targetProtocols),
      mappings: mappingRows.map((item) => ({
        selector_value: item.selectorValue,
        target_protocol_id: item.target.protocol_id,
        target_frame_count: item.targetFrameCount,
        evidence: [table.id, item.rowText],
      })),
      evidence: [table.id, table.caption ?? table.id],
      source: "table",
      confidence: Math.max(0.8, table.ordinal >= 0 ? 0.95 : 0.8),
      warnings: [],
    })
  }
  return relations
}

function sameProtocolSectionScope(
  left: DtpProtocolContextPackage,
  right: DtpProtocolContextPackage,
  relatedDocumentIds?: Map<string, Set<string>>,
): boolean {
  const interfacePath = (context: DtpProtocolContextPackage): string | undefined => (
    [...(context.section_path ?? [])].reverse().find((item) => /(?:CAN|SPI|Space\s*Wire|1553B|RS\s*[-_]?\s*422|UART|串口|总线|接口)/i.test(item))
  )
  if (left.source_document_id === right.source_document_id) {
    if (left.section_id && right.section_id) return left.section_id === right.section_id
    const leftPath = interfacePath(left)
    const rightPath = interfacePath(right)
    return Boolean(leftPath && rightPath && normalizeLookupText(leftPath) === normalizeLookupText(rightPath))
  }

  const contextIdentityIds = (context: DtpProtocolContextPackage): Set<string> => new Set([
    context.source_document_id,
    context.section_model_id,
    ...context.tables.map((table) => table.id),
  ])
  const referencesContext = (source: DtpProtocolContextPackage, target: DtpProtocolContextPackage): boolean => {
    const targetIds = contextIdentityIds(target)
    return (source.reference_evidence ?? []).some((reference) => (
      reference.state === "resolved" || reference.state === "fallback_resolved"
    ) && reference.target_ids.some((targetId) => targetIds.has(targetId)))
  }
  const documentsAreRelated = relatedDocumentIds?.get(left.source_document_id)?.has(right.source_document_id) ?? false
  if (!documentsAreRelated && !referencesContext(left, right) && !referencesContext(right, left)) return false

  const leftIdentity = inferContextCanInterfaceIdentity(left)
  const rightIdentity = inferContextCanInterfaceIdentity(right)
  if (
    leftIdentity.interfaceLevel !== "unknown" &&
    rightIdentity.interfaceLevel !== "unknown" &&
    leftIdentity.interfaceLevel !== rightIdentity.interfaceLevel
  ) return false
  if (leftIdentity.interfaceId && rightIdentity.interfaceId && leftIdentity.interfaceId !== rightIdentity.interfaceId) {
    return false
  }
  return true
}

function buildCrossContextProtocolSelectorRelations(
  contexts: DtpProtocolContextPackage[],
  protocols: DtpProtocolDefinition[],
  sections: DtpProtocolDefinitionsDocument["sections"],
  relatedDocumentIds?: Map<string, Set<string>>,
): DtpProtocolSelectorRelation[] {
  const contextByTableId = new Map<string, DtpProtocolContextPackage>()
  for (const context of contexts) {
    for (const table of context.tables) {
      if (!contextByTableId.has(table.id)) contextByTableId.set(table.id, context)
    }
  }
  const protocolById = new Map(protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const protocolsByContext = new Map<string, DtpProtocolDefinition[]>()
  for (const section of sections) {
    protocolsByContext.set(
      section.section_model_id,
      section.protocol_ids.map((protocolId) => protocolById.get(protocolId)).filter((item): item is DtpProtocolDefinition => Boolean(item)),
    )
  }

  const addressHeaderPattern = /^(?:(?:一|二)级)?(?:CAN)?(?:节点)?(?:(?:站|节点|终端|设备|单机)地址)$/i
  const frameCountHeaderPattern = /^(?:(?:遥测|数据)?帧(?:数|数量|个数))$/i
  const relations: DtpProtocolSelectorRelation[] = []
  for (const selectorContext of contexts) {
    const selectorScope = commonProtocolScope(protocolsByContext.get(selectorContext.section_model_id) ?? [])
    const candidateProtocols = protocols.filter((protocol) => {
      if (!/遥测|telemetry/i.test([protocol.base_file_name, ...(protocol.aliases ?? []), protocol.source_section, ...protocol.evidence].filter(Boolean).join(" "))) {
        return false
      }
      const sourceContext = getDtpProtocolFrames(protocol)
        .map((frame) => contextByTableId.get(frame.source_table_id))
        .find(Boolean)
      if (!sourceContext || !sameProtocolSectionScope(selectorContext, sourceContext, relatedDocumentIds)) return false
      if (selectorScope.bus_type && protocol.bus_context?.bus_type !== selectorScope.bus_type) return false
      if (selectorScope.interface_level && protocol.bus_context?.interface_level !== selectorScope.interface_level) return false
      if (selectorScope.interface_id && protocol.bus_context?.interface_id !== selectorScope.interface_id) return false
      return true
    })
    const frameCounts = new Set(candidateProtocols.map((protocol) => getDtpProtocolFrames(protocol).length))
    if (candidateProtocols.length < 2 || frameCounts.size < 2) continue

    for (const table of selectorContext.tables) {
      const headerRowIndex = table.rows.slice(0, 5).findIndex((row) => (
        selectorHeaderIndex(row, addressHeaderPattern) >= 0 &&
        selectorHeaderIndex(row, frameCountHeaderPattern) >= 0
      ))
      if (headerRowIndex < 0) continue
      const header = table.rows[headerRowIndex]
      const selectorIndex = selectorHeaderIndex(header, addressHeaderPattern)
      const frameCountIndex = selectorHeaderIndex(header, frameCountHeaderPattern)
      const mappings = table.rows.slice(headerRowIndex + 1).flatMap((row) => {
        const selectorValue = normalizeSelectorByte(row[selectorIndex] ?? "")
        const frameCountMatch = (row[frameCountIndex] ?? "").trim().match(/^\d+$/)
        const targetFrameCount = frameCountMatch ? Number.parseInt(frameCountMatch[0], 10) : undefined
        if (!selectorValue || !targetFrameCount) return []
        const targets = candidateProtocols.filter((protocol) => getDtpProtocolFrames(protocol).length === targetFrameCount)
        if (targets.length !== 1) return []
        return [{
          selector_value: selectorValue,
          target_protocol_id: targets[0].protocol_id,
          target_frame_count: targetFrameCount,
          evidence: [table.id, row.join(" | ")],
        }]
      })
      if (!mappings.length) continue
      const targetProtocols = uniqueStrings(mappings.map((mapping) => mapping.target_protocol_id))
        .map((protocolId) => protocolById.get(protocolId))
        .filter((item): item is DtpProtocolDefinition => Boolean(item))
      relations.push({
        relation_id: `${selectorContext.section_model_id}-cross-selector-${table.id}`,
        section_model_id: selectorContext.section_model_id,
        selector_name: header[selectorIndex].trim() || "站地址",
        selector_aliases: uniqueStrings([header[selectorIndex].trim(), "站地址", "节点地址", "终端地址", "设备地址", "单机地址"]),
        selector_type: "uint8",
        protocol_family: "telemetry",
        ...commonProtocolScope(targetProtocols),
        mappings,
        evidence: [table.id, table.caption ?? table.id],
        source: "table",
        confidence: 0.95,
        warnings: [],
      })
    }
  }
  return relations
}

function sanitizeModelProtocolSelectorRelations(
  context: DtpProtocolContextPackage,
  protocols: DtpProtocolDefinition[],
  rawUnderstanding: Record<string, unknown>,
): DtpProtocolSelectorRelation[] {
  const tableIds = new Set(context.tables.map((table) => table.id))
  const protocolsById = new Map(protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const relations: DtpProtocolSelectorRelation[] = []
  for (const rawRelation of getNestedArray(rawUnderstanding, ["selector_relations"])) {
    if (!isRecord(rawRelation)) continue
    const selectorName = asString(rawRelation.selector_name)
    const selectorTypeRaw = asString(rawRelation.selector_type)
    const selectorType: DtpProtocolSelectorRelation["selector_type"] =
      selectorTypeRaw === "integer" || selectorTypeRaw === "string" ? selectorTypeRaw : "uint8"
    if (!selectorName) continue
    const mappings = getNestedArray(rawRelation, ["mappings"]).flatMap((rawMapping) => {
      if (!isRecord(rawMapping)) return []
      const selectorValue = selectorType === "uint8"
        ? normalizeSelectorByte(asString(rawMapping.selector_value) ?? "")
        : asString(rawMapping.selector_value)
      const targetFrameCount = asNumber(rawMapping.target_frame_count)
      const explicitTargetId = asString(rawMapping.target_protocol_id)
      const candidateTargets = explicitTargetId && protocolsById.has(explicitTargetId)
        ? [protocolsById.get(explicitTargetId)!]
        : targetFrameCount
          ? protocols.filter((protocol) => getDtpProtocolFrames(protocol).length === Math.floor(targetFrameCount))
          : []
      if (!selectorValue || candidateTargets.length !== 1) return []
      const evidence = getNestedArray(rawMapping, ["evidence"])
        .map((item) => asString(item))
        .filter((item): item is string => typeof item === "string" && (tableIds.has(item) || item.length <= 240))
      return [{
        selector_value: selectorValue,
        target_protocol_id: candidateTargets[0].protocol_id,
        target_frame_count: targetFrameCount ? Math.floor(targetFrameCount) : undefined,
        evidence,
      }]
    })
    if (!mappings.length) continue
    const rawFamily = asString(rawRelation.protocol_family)
    const protocolFamily: DtpProtocolSelectorRelation["protocol_family"] =
      rawFamily === "telemetry" || rawFamily === "poll" || rawFamily === "response" || rawFamily === "command"
        ? rawFamily
        : "unknown"
    const targetProtocols = uniqueStrings(mappings.map((mapping) => mapping.target_protocol_id))
      .map((id) => protocolsById.get(id))
      .filter((protocol): protocol is DtpProtocolDefinition => Boolean(protocol))
    relations.push({
      relation_id: asString(rawRelation.relation_id) ?? `${context.section_model_id}-model-selector-${relations.length + 1}`,
      section_model_id: context.section_model_id,
      selector_name: selectorName,
      selector_aliases: uniqueStrings(getNestedArray(rawRelation, ["selector_aliases"])
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item))),
      selector_type: selectorType,
      protocol_family: protocolFamily,
      ...commonProtocolScope(targetProtocols),
      mappings,
      evidence: uniqueStrings(getNestedArray(rawRelation, ["evidence"])
        .map((item) => asString(item))
        .filter((item): item is string => typeof item === "string" && (tableIds.has(item) || item.length <= 240))),
      source: "model",
      confidence: Math.max(0, Math.min(1, asNumber(rawRelation.confidence) ?? 0.7)),
      warnings: getNestedArray(rawRelation, ["warnings"])
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item)),
    })
  }
  return relations
}

function normalizeProtocolChecksum(raw: unknown): DtpProtocolChecksumDefinition | undefined {
  if (!isRecord(raw)) return undefined
  const rawType = asString(raw.type)
  const type: DtpProtocolChecksumDefinition["type"] =
    rawType === "sum_low8" || rawType === "sum_low16" || rawType === "sum_low32" || rawType === "iso" ||
    rawType === "crc" || rawType === "none" || rawType === "unknown"
      ? rawType
      : "unknown"
  return {
    type,
    start: asString(raw.start),
    end: asString(raw.end),
    expression: asString(raw.expression),
  }
}

function normalizeProtocolBlockDefinition(raw: unknown): DtpProtocolBlockDefinition | undefined {
  if (!isRecord(raw)) return undefined
  const kind = asString(raw.kind)
  if (kind !== "spacewire_program_upload" && kind !== "spacewire_fixed_block") return undefined
  const totalBytes = asNumber(raw.total_bytes)
  if (!totalBytes || totalBytes < 1) return undefined
  const scalarByteOrder = asString(raw.scalar_byte_order)
  const byteOrder: DtpProtocolBlockDefinition["scalar_byte_order"] =
    scalarByteOrder === "big" || scalarByteOrder === "little" ? scalarByteOrder : "unknown"
  const checksums = getNestedArray(raw, ["checksums"])
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .flatMap((item) => {
      const name = asString(item.name)
      const algorithm = asString(item.algorithm)
      const source = asString(item.source)
      const outputOffset = asNumber(item.output_offset)
      const outputLength = asNumber(item.output_length)
      const checksumByteOrder = asString(item.byte_order)
      if (
        !name ||
        !["sum_low8", "sum_low16", "sum_low32", "iso_8473", "iso_unknown", "unknown"].includes(algorithm ?? "") ||
        (source !== "frame_range" && source !== "payload_image") ||
        outputOffset === undefined || outputOffset < 0 ||
        outputLength === undefined || outputLength < 1
      ) return []
      return [{
        name,
        algorithm: algorithm as DtpProtocolBlockDefinition["checksums"][number]["algorithm"],
        source: source as DtpProtocolBlockDefinition["checksums"][number]["source"],
        source_start: asNumber(item.source_start),
        source_end: asNumber(item.source_end),
        output_offset: Math.floor(outputOffset),
        output_length: Math.floor(outputLength),
        byte_order: (checksumByteOrder === "big" || checksumByteOrder === "little" ? checksumByteOrder : "unknown") as
          DtpProtocolBlockDefinition["checksums"][number]["byte_order"],
        source_text: asString(item.source_text),
      }]
    })
  return {
    kind,
    total_bytes: Math.floor(totalBytes),
    payload_offset: asNumber(raw.payload_offset),
    payload_capacity: asNumber(raw.payload_capacity),
    payload_file: asString(raw.payload_file),
    payload_file_patterns: getNestedArray(raw, ["payload_file_patterns"])
      .map((item) => asString(item)).filter((item): item is string => Boolean(item)),
    start_address: asString(raw.start_address),
    address_offset: asNumber(raw.address_offset),
    address_length: asNumber(raw.address_length),
    length_offset: asNumber(raw.length_offset),
    length_length: asNumber(raw.length_length),
    scalar_byte_order: byteOrder,
    block_type_offset: asNumber(raw.block_type_offset),
    start_block_type: normalizeHexByte(asString(raw.start_block_type)),
    middle_block_type: normalizeHexByte(asString(raw.middle_block_type)),
    check_block_type: normalizeHexByte(asString(raw.check_block_type)),
    checksums,
    source_table_ids: getNestedArray(raw, ["source_table_ids"])
      .map((item) => asString(item)).filter((item): item is string => Boolean(item)),
  }
}

function normalizeProtocolValueRule(raw: unknown): DtpProtocolValueRule | undefined {
  if (!isRecord(raw)) return undefined
  const operation = asString(raw.operation)
  if (
    operation !== "fixed" &&
    operation !== "variable" &&
    operation !== "add_low8" &&
    operation !== "bit_or" &&
    operation !== "bit_and" &&
    operation !== "shift_left" &&
    operation !== "concat"
  ) return undefined
  return {
    operation,
    value: normalizeHexByte(asString(raw.value)),
    base: normalizeHexByte(asString(raw.base)),
    variable: asString(raw.variable),
    operand: normalizeHexByte(asString(raw.operand)),
    shift: asNumber(raw.shift),
    mask: normalizeHexByte(asString(raw.mask)),
  }
}

function inferFieldRole(name: string): DtpProtocolFieldRole {
  const normalized = name.trim().toUpperCase()
  if (/^(SUM|CRC|CHECKSUM)$/.test(normalized)) return "checksum"
  if (/^(ADDRESS|STATION_ADDRESS)$/.test(normalized)) return "address"
  if (/^(MESSAGE_TYPE|TYPE)$/.test(normalized)) return "type"
  if (/^(TITLE|T)$/.test(normalized)) return "title"
  if (/^(LENGTH|LEN|L|DLC)$/.test(normalized)) return "length"
  if (/^(FRAME_SEQUENCE|FRAME_INDEX|SEQUENCE|INDEX)$/.test(normalized)) return "sequence"
  if (/^(ARBITRATION|ARBITRATION_FIELD|ID)$/.test(normalized)) return "arbitration"
  if (/^(CONTROL|CONTROL_FIELD|RTR)$/.test(normalized)) return "control"
  if (/^(?:W|DATA)\d+$/.test(normalized)) return "data"
  if (normalizeHexByte(normalized)) return "fixed"
  return "unknown"
}

function normalizeFieldLayout(
  rawLayout: unknown,
  byteLayout: string[],
  fields: DtpProtocolFieldDefinition[],
): DtpProtocolFieldLayout[] {
  const supplied = Array.isArray(rawLayout)
    ? rawLayout
      .map((raw): DtpProtocolFieldLayout | null => {
        if (!isRecord(raw)) return null
        const name = asString(raw.name)
        const byteOffset = asNumber(raw.byte_offset)
        const byteLength = asNumber(raw.byte_length)
        if (!name || byteOffset === undefined || byteOffset < 0) return null
        const roleValue = asString(raw.role)
        const allowedRoles = new Set<DtpProtocolFieldRole>([
          "arbitration",
          "control",
          "address",
          "type",
          "title",
          "length",
          "sequence",
          "data",
          "checksum",
          "fixed",
          "unknown",
        ])
        const role = allowedRoles.has(roleValue as DtpProtocolFieldRole)
          ? roleValue as DtpProtocolFieldRole
          : inferFieldRole(name)
        const field = fields.find((item) => item.name.toUpperCase() === name.toUpperCase())
        return {
          name,
          role,
          byte_offset: Math.floor(byteOffset),
          byte_length: Math.max(1, Math.floor(byteLength ?? 1)),
          bit_offset: asNumber(raw.bit_offset),
          bit_length: asNumber(raw.bit_length),
          default_value: normalizeHexByte(asString(raw.default_value)) ?? field?.value,
          value_rule: normalizeProtocolValueRule(raw.value_rule),
          options: Array.isArray(raw.options)
            ? raw.options.filter(isRecord).flatMap(option => {
                const value = normalizeHexByte(asString(option.value))
                return value ? [{ value, label: asString(option.label) ?? value }] : []
              })
            : field?.options,
          source_table_id: asString(raw.source_table_id) ?? field?.source_table_id,
          source_text: asString(raw.source_text) ?? field?.source_text,
        }
      })
      .filter((item): item is DtpProtocolFieldLayout => Boolean(item))
    : []
  if (supplied.length) return supplied

  return byteLayout.map((token, byteOffset) => {
    const field = fields.find((item) => item.name.toUpperCase() === token.toUpperCase())
    return {
      name: token,
      role: inferFieldRole(token),
      byte_offset: byteOffset,
      byte_length: 1,
      default_value: normalizeHexByte(token) ?? field?.value,
      options: field?.options,
      source_table_id: field?.source_table_id,
      source_text: field?.source_text,
    }
  })
}

function mergeModelSemanticsIntoTableFieldLayout(
  rawModelLayout: unknown,
  tableLayout: DtpProtocolFieldLayout[],
  byteLayout: string[],
  fields: DtpProtocolFieldDefinition[],
  warnings?: string[],
  frameLabel = "frame",
): DtpProtocolFieldLayout[] {
  const modelLayout = normalizeFieldLayout(rawModelLayout, byteLayout, fields)
  if (!tableLayout.length) return modelLayout

  const merged = tableLayout.map((tableField) => {
    const exactModelField = modelLayout.find((field) => field.name.toUpperCase() === tableField.name.toUpperCase())
    const tableFieldIsUnlabelled = tableField.role === "fixed" ||
      tableField.role === "unknown" ||
      Boolean(normalizeHexByte(tableField.name))
    const positionalModelField = exactModelField || !tableFieldIsUnlabelled
      ? undefined
      : modelLayout.find((field) => field.byte_offset === tableField.byte_offset)
    const modelField = exactModelField ?? positionalModelField
    if (modelField && modelField.byte_offset !== tableField.byte_offset) {
      warnings?.push(
        `${frameLabel}: model field ${modelField.name}@${modelField.byte_offset} conflicts with table layout @${tableField.byte_offset}; table position was retained.`,
      )
    } else if (positionalModelField) {
      warnings?.push(
        `${frameLabel}: table byte @${tableField.byte_offset} has no structural label; model semantic ${positionalModelField.name} was accepted at the same position.`,
      )
    }
    return {
      ...modelField,
      ...tableField,
      name: positionalModelField?.name ?? tableField.name,
      role: positionalModelField?.role ?? tableField.role,
      default_value: tableField.default_value ?? modelField?.default_value,
      value_rule: tableField.value_rule ?? modelField?.value_rule,
      options: tableField.options ?? modelField?.options,
      source_table_id: tableField.source_table_id ?? modelField?.source_table_id,
      source_text: tableField.source_text ?? modelField?.source_text,
    }
  })

  const tableNames = new Set(tableLayout.map((field) => field.name.toUpperCase()))
  const modelBitFields = modelLayout.filter((field) => (
    field.bit_offset !== undefined &&
    !tableNames.has(field.name.toUpperCase()) &&
    field.byte_offset >= 0 &&
    field.byte_offset < byteLayout.length
  ))
  return normalizeFieldLayout([...merged, ...modelBitFields], byteLayout, fields)
}

function hasTableAuthoritativeFieldLayout(frame: DtpProtocolFrameDefinition | undefined): boolean {
  if (!frame) return false
  return frame.field_layout.some((field) => (
    field.source_table_id === frame.source_table_id && Boolean(field.source_text)
  ))
}

export function getDtpProtocolFrames(protocol: DtpProtocolDefinition | undefined): DtpProtocolFrameDefinition[] {
  if (!protocol) return []
  if (protocol.frames?.length) return protocol.frames
  const legacy = protocol.frame
  if (!legacy) return []
  const layouts = legacy.byte_layouts?.length ? legacy.byte_layouts : [legacy.byte_layout]
  return layouts.map((byteLayout, index) => ({
    frame_id: `frame-${index + 1}`,
    sequence: index + 1,
    source_table_id: legacy.source_table_id,
    byte_layout: byteLayout,
    field_layout: normalizeFieldLayout(legacy.field_layout, byteLayout, protocol.fields),
    checksum: legacy.checksum,
  }))
}

export function getDtpPrimaryProtocolFrame(protocol: DtpProtocolDefinition | undefined): DtpProtocolFrameDefinition | undefined {
  return getDtpProtocolFrames(protocol)[0]
}

function normalizeCanFrameChecksum(
  busContext: DtpProtocolBusContext | undefined,
  frame: DtpProtocolFrameDefinition,
  warnings: string[],
): DtpProtocolChecksumDefinition | undefined {
  const checksum = frame.checksum
  if (busContext?.bus_type !== "CAN" || (checksum?.type !== undefined && checksum.type !== "unknown")) {
    return checksum
  }
  const hasSum = frame.field_layout.some((field) => field.role === "checksum" && /^SUM$/i.test(field.name)) ||
    frame.byte_layout.some((token) => /^SUM$/i.test(token))
  const hasTitle = frame.field_layout.some((field) => field.role === "title" || /^(?:TITLE|T)$/i.test(field.name)) ||
    frame.byte_layout.some((token) => /^TITLE$/i.test(token))
  const specializedAlgorithm = /\b(?:CRC|ISO|XOR|FLETCHER|HAMMING)\b|循环冗余|异或|海明|奇偶校验/i.test(
    checksum?.expression ?? "",
  )
  if (!hasSum || !hasTitle || specializedAlgorithm) return checksum

  warnings.push(
    `${frame.frame_id}: explicit CAN TITLE/SUM layout uses the default low-byte SUM because no specialized checksum algorithm was defined.`,
  )
  return {
    type: "sum_low8",
    start: "TITLE",
    end: "BEFORE_SUM",
    expression: DEFAULT_CHECKSUM_RULE,
  }
}

function repairImplicitCanFrameSequence(
  busContext: DtpProtocolBusContext | undefined,
  frames: DtpProtocolFrameDefinition[],
): DtpProtocolFrameDefinition[] {
  if (busContext?.bus_type !== "CAN" || frames.length < 2) return frames
  if (frames.some((frame) => frame.field_layout.some((field) => field.role === "sequence"))) return frames
  const controlOffsets = frames.map((frame) => frame.field_layout.find((field) => (
    field.role === "control" && /^(?:CONTROL|CONTROL_FIELD)$/i.test(field.name)
  ))?.byte_offset)
  if (controlOffsets.some((offset) => offset === undefined)) return frames
  const sequenceOffset = (controlOffsets[0] ?? 1) + 1
  if (!controlOffsets.every((offset) => offset === controlOffsets[0])) return frames
  const values = frames.map((frame) => normalizeHexByte(frame.byte_layout[sequenceOffset]))
  if (values.some((value) => !value)) return frames
  if (!values.every((value, index) => Number.parseInt(value!, 16) === index)) return frames

  return frames.map((frame, index) => {
    const existing = frame.field_layout.find((field) => (
      field.byte_offset === sequenceOffset && field.bit_offset === undefined
    ))
    const sequenceField: DtpProtocolFieldLayout = {
      ...(existing ?? {}),
      name: "FRAME_SEQUENCE",
      role: "sequence",
      byte_offset: sequenceOffset,
      byte_length: 1,
      default_value: values[index],
      source_table_id: existing?.source_table_id ?? frame.source_table_id,
      source_text: existing?.source_text ?? "Sequential CAN frame byte inferred after the control field.",
    }
    return {
      ...frame,
      field_layout: [
        ...frame.field_layout.filter((field) => field !== existing),
        sequenceField,
      ].sort((left, right) => left.byte_offset - right.byte_offset),
    }
  })
}

function protocolSemanticRoleFromText(value: string): DtpProtocolSemanticIdentity["role"] {
  const text = value.replace(/\s+/g, "")
  if (/(?:星务.*时间.*广播|时间广播|timebroadcast)/i.test(text)) return "time_broadcast"
  if (/(?:应答|响应|回复|reply|response|(?:^|[_-])ack(?:$|[_-]))/i.test(text)) return "response"
  if (/(?:轮询|poll)/i.test(text) && /(?:指令|序列|控制|command)/i.test(text)) return "poll"
  if (/(?:遥测数据|数据传送|数据回传|telemetrydata)/i.test(text)) return "telemetry"
  if (/(?:上行数据块|下行数据块|uplinkdatablock|downlinkdatablock)/i.test(text)) return "data_block"
  if (/(?:辅助数据包|auxiliarypacket)/i.test(text)) return "auxiliary"
  if (/(?:指令|命令|控制序列|command|cmd)/i.test(text)) return "command"
  return "unknown"
}

function firstExplicitByteLength(value: string): number | undefined {
  const match = value.match(/(?:长度\s*)?(\d{1,4})[\s_-]*(?:字节|bytes?\b)/i)
  const parsed = match ? Number.parseInt(match[1], 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function semanticLengthIdentity(
  text: string,
  role: DtpProtocolSemanticIdentity["role"],
): Pick<DtpProtocolSemanticIdentity, "message_length_bytes" | "related_message_length_bytes"> {
  const compact = text.replace(/\s+/g, "")
  if (role === "response") {
    const related = compact.match(/(\d{1,4})字节(?:的)?[^，。；;]{0,24}(?:指令|命令)[^，。；;]{0,12}(?:应答|响应|回复)/)
    if (related) return { related_message_length_bytes: Number.parseInt(related[1], 10) }
    const own = compact.match(/(\d{1,4})字节(?:的)?(?:应答|响应|回复)/)
    if (own) return { message_length_bytes: Number.parseInt(own[1], 10) }
    return {}
  }
  const length = firstExplicitByteLength(compact)
  return length ? { message_length_bytes: length } : {}
}

function protocolSemanticIdentity(protocol: DtpProtocolDefinition): DtpProtocolSemanticIdentity {
  const identityValues = [
    protocol.base_file_name,
    ...(protocol.aliases ?? []),
    ...(protocol.evidence ?? []),
    protocol.source_section ?? "",
  ].filter(Boolean)
  // A shared section title may describe both a command and its response. Prefer
  // the concrete protocol name so section-level wording cannot invert its role.
  const role = identityValues
    .map(protocolSemanticRoleFromText)
    .find((candidate) => candidate !== "unknown") ?? "unknown"
  const canonicalName = protocol.base_file_name.trim()
  const entity = canonicalName
    .replace(/(?:正确|错误|异常|正常)/g, "")
    .replace(/(?:应答|响应|回复)$/g, "")
    .trim()
  const lengthIdentity = role === "response"
    ? [
        protocol.base_file_name,
        ...(protocol.aliases ?? []),
        ...(protocol.evidence ?? []),
        protocol.source_section ?? "",
      ].map((value) => semanticLengthIdentity(value, role))
        .find((value) => value.message_length_bytes !== undefined || value.related_message_length_bytes !== undefined) ?? {}
    : (() => {
        const messageLength = [
          protocol.base_file_name,
          ...(protocol.aliases ?? []),
          ...(protocol.evidence ?? []),
          protocol.source_section ?? "",
        ].map(firstExplicitByteLength).find((value): value is number => value !== undefined)
        return messageLength ? { message_length_bytes: messageLength } : {}
      })()
  return {
    canonical_name: canonicalName,
    normalized_name: normalizeLookupText(canonicalName),
    role,
    ...(entity ? { entity } : {}),
    ...lengthIdentity,
  }
}

function protocolSemanticAliases(
  protocol: DtpProtocolDefinition,
  identity: DtpProtocolSemanticIdentity,
): string[] {
  if (identity.role !== "response") return []
  const entity = (identity.entity ?? "")
    .replace(/^(?:一级|二级)?\s*(?:CAN|SPI|Space\s*Wire|RS\s*[-_]?\s*422|1553B)[\s_-]*/i, "")
    .replace(/^\d{1,4}\s*字节/, "")
    .trim()
  if (!entity) return []
  const responseEntity = /(?:应答|响应|回复)$/i.test(entity) ? entity : `${entity}应答`
  return uniqueStrings([
    responseEntity,
    ...(identity.related_message_length_bytes
      ? [`${identity.related_message_length_bytes}字节${responseEntity}`]
      : []),
  ].filter((alias) => alias !== protocol.base_file_name))
}

function normalizedProtocolProvenance(protocol: DtpProtocolDefinition): DtpProtocolProvenance[] {
  return (protocol.provenance ?? []).flatMap((item) => {
    if (!item.source_document_id) return []
    return [{
      ...item,
      source_table_ids: uniqueStrings(item.source_table_ids ?? []),
      source_sections: uniqueStrings(item.source_sections ?? []),
      evidence: uniqueStrings(item.evidence ?? []),
    }]
  })
}

export function normalizeDtpProtocolDefinition(protocol: DtpProtocolDefinition): DtpProtocolDefinition {
  const { frame: _legacyFrame, ...rest } = protocol
  const busContext = sanitizeProtocolBusContext(protocol.bus_context) ?? protocol.bus_context
  const semanticIdentity = protocolSemanticIdentity(protocol)
  const checksumWarnings: string[] = []
  const frames = getDtpProtocolFrames(protocol).map((frame, index) => {
    const normalizedFrame: DtpProtocolFrameDefinition = {
      ...frame,
      frame_id: frame.frame_id || `frame-${index + 1}`,
      sequence: Number.isFinite(frame.sequence) && frame.sequence > 0 ? Math.floor(frame.sequence) : index + 1,
      wire_length: frame.byte_layout.length,
      field_layout: normalizeFieldLayout(frame.field_layout, frame.byte_layout, protocol.fields),
    }
    return {
      ...normalizedFrame,
      checksum: normalizeCanFrameChecksum(busContext, normalizedFrame, checksumWarnings),
    }
  })
  return {
    ...rest,
    aliases: uniqueStrings([
      ...(protocol.aliases ?? []),
      ...protocolSemanticAliases(protocol, semanticIdentity),
    ]),
    bus_context: busContext,
    block_layout: normalizeProtocolBlockDefinition(protocol.block_layout) ?? protocol.block_layout,
    frames: repairImplicitCanFrameSequence(busContext, frames),
    semantic_identity: semanticIdentity,
    transport: {
      bus_type: busContext?.bus_type ?? "unknown",
      interface_level: busContext?.interface_level ?? "unknown",
      ...(busContext?.interface_id ? { interface_id: busContext.interface_id } : {}),
      frame_count: frames.length,
      wire_lengths: frames.map((frame) => frame.byte_layout.length),
    },
    provenance: normalizedProtocolProvenance(protocol),
    warnings: uniqueStrings([...(protocol.warnings ?? []), ...checksumWarnings]),
  }
}

function parseProtocolGroupOrdinal(value: string): number | undefined {
  if (/^[1-9]\d*$/.test(value)) return Number.parseInt(value, 10)
  const digits: Record<string, number> = {
    "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9,
  }
  if (value === "十") return 10
  const match = value.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/)
  if (match) return (match[1] ? digits[match[1]] : 1) * 10 + (match[2] ? digits[match[2]] : 0)
  return digits[value]
}

function numberedProtocolOrderFromEvidence(value: string): number | undefined {
  const compact = value.replace(/\s+/g, "")
  const matches = Array.from(compact.matchAll(
    /(?:辅助数据包|上行数据块|遥测数据包|数据块|数据包|控制序列|指令|命令)(?:第)?([一二两三四五六七八九十\d]+)(?=$|[（(，,。；;:_-])/gi,
  ))
  for (const match of matches.reverse()) {
    const order = parseProtocolGroupOrdinal(match[1])
    if (order !== undefined) return order
  }
  return undefined
}

function protocolGroupDisplayName(value: string): string {
  return value
    .trim()
    .replace(/[\s_-]*(?:第)?[一二两三四五六七八九十\d]+$/i, "")
    .replace(/^(?:长度\s*)?\d+\s*字节(?:的)?/i, "")
    .trim()
}

function numberedProtocolGroupIdentity(protocol: DtpProtocolDefinition): { name: string; aliases: string[]; order: number } | undefined {
  const baseName = protocol.base_file_name.trim()
  const baseOrder = numberedProtocolOrderFromEvidence(baseName)
  const protocolSpecificEvidence = uniqueStrings([
    ...(protocol.aliases ?? []),
    ...(protocol.evidence ?? []),
    ...(protocol.provenance ?? []).flatMap((item) => item.evidence ?? []),
  ])
  const evidenceOrder = protocolSpecificEvidence
    .map(numberedProtocolOrderFromEvidence)
    .find((order): order is number => order !== undefined)
  const order = baseOrder ?? evidenceOrder
  if (order === undefined) return undefined

  const fullName = baseName
    .replace(/[\s_-]*(?:第)?[一二两三四五六七八九十\d]+$/i, "")
    .trim()
  const name = protocolGroupDisplayName(baseName)
  if (name.length < 2) return undefined
  return {
    name,
    aliases: uniqueStrings([name, fullName]),
    order,
  }
}

function declaredOrderedProtocolCount(value: string): number | undefined {
  const patterns = [
    /(?:发送|包含|分为|包括).{0,12}([一二两三四五六七八九十\d]+)个(?:数据包|数据块)/i,
    /([一二两三四五六七八九十\d]+)个(?:数据包|数据块).{0,20}(?:间隔|依次|连续|分别)/i,
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    const count = match ? parseProtocolGroupOrdinal(match[1]) : undefined
    if (count !== undefined) return count
  }
  return undefined
}

function protocolGroupScopeKey(protocol: DtpProtocolDefinition): string {
  return [
    protocol.bus_context?.bus_type ?? "unknown",
    protocol.bus_context?.interface_level ?? "unknown",
    protocol.bus_context?.interface_id ?? "unknown",
    protocol.flow_direction,
  ].join("|")
}

function deriveOrderedProtocolGroups(
  definitions: DtpProtocolDefinitionsDocument,
  protocols: DtpProtocolDefinition[],
): DtpProtocolGroup[] {
  const byId = new Map(protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const groups: DtpProtocolGroup[] = []
  for (const section of definitions.sections) {
    const candidates = section.protocol_ids
      .map((protocolId) => byId.get(protocolId))
      .filter((protocol): protocol is DtpProtocolDefinition => Boolean(protocol))
      .flatMap((protocol) => {
        const identity = numberedProtocolGroupIdentity(protocol)
        return identity ? [{ protocol, ...identity }] : []
      })
    const byName = new Map<string, typeof candidates>()
    for (const candidate of candidates) {
      const key = candidate.name.replace(/\s+/g, "").toLowerCase()
      const values = byName.get(key) ?? []
      values.push(candidate)
      byName.set(key, values)
    }
    for (const candidatesForName of byName.values()) {
      if (candidatesForName.length < 2) continue
      const ordered = [...candidatesForName].sort((left, right) => left.order - right.order)
      if (new Set(ordered.map((item) => protocolGroupScopeKey(item.protocol))).size !== 1) continue
      if (new Set(ordered.map((item) => item.order)).size !== ordered.length) continue
      if (ordered.some((item, index) => index > 0 && item.order !== ordered[index - 1].order + 1)) continue
      const roles = new Set(ordered.map((item) => item.protocol.semantic_identity?.role ?? "unknown"))
      if (roles.size !== 1) continue
      const payloadLengths = new Set(ordered
        .map((item) => item.protocol.semantic_identity?.message_length_bytes)
        .filter((value): value is number => value !== undefined))
      if (payloadLengths.size > 1) continue
      const groupingEvidence = [
        section.section_title,
        ...ordered.flatMap((item) => [item.protocol.source_section ?? "", ...item.protocol.evidence]),
      ].join(" ")
      const explicitlyOrdered = /(?:每.{0,20}(?:发送|包含).{0,12}[一二两三四五六七八九十\d]+个(?:数据包|数据块)|[一二两三四五六七八九十\d]+个(?:数据包|数据块).{0,20}(?:间隔|依次|连续|分别)|(?:依次|连续)发送)/i.test(groupingEvidence)
      if (!explicitlyOrdered) continue
      const declaredCount = declaredOrderedProtocolCount(groupingEvidence)
      if (declaredCount !== undefined && declaredCount !== ordered.length) continue
      const name = ordered[0].name
      groups.push({
        group_id: `${section.section_model_id}-group-${groups.length + 1}`,
        name,
        aliases: uniqueStrings(ordered.flatMap((item) => item.aliases)),
        protocol_ids: ordered.map((item) => item.protocol.protocol_id),
        ordered: true,
        flow_direction: ordered[0].protocol.flow_direction,
        source_section_model_id: section.section_model_id,
        evidence: uniqueStrings([
          section.section_title,
          ...ordered.flatMap((item) => [
            item.protocol.source_section ?? "",
            ...item.protocol.evidence,
          ]),
        ].filter(Boolean)),
        warnings: [],
      })
    }
  }
  return groups
}

function normalizeProtocolGroups(
  definitions: DtpProtocolDefinitionsDocument,
  protocols: DtpProtocolDefinition[],
): DtpProtocolGroup[] {
  const protocolIds = new Set(protocols.map((protocol) => protocol.protocol_id))
  const existing = (definitions.protocol_groups ?? []).flatMap((group) => {
    const childIds = uniqueStrings(group.protocol_ids ?? []).filter((protocolId) => protocolIds.has(protocolId))
    if (!group.group_id || !group.name || childIds.length < 2) return []
    return [{
      ...group,
      aliases: uniqueStrings(group.aliases ?? []),
      protocol_ids: childIds,
      ordered: true as const,
      evidence: uniqueStrings(group.evidence ?? []),
      warnings: uniqueStrings(group.warnings ?? []),
    }]
  })
  const seenChildren = new Set(existing.map((group) => group.protocol_ids.join("|")))
  return [
    ...existing,
    ...deriveOrderedProtocolGroups(definitions, protocols).filter((group) => {
      const key = group.protocol_ids.join("|")
      if (seenChildren.has(key)) return false
      seenChildren.add(key)
      return true
    }),
  ]
}

function protocolSourcePriority(document: ProjectKnowledgeIndex["source_documents"][number] | undefined): DtpProtocolProvenance["priority"] {
  if (document?.role === "primary-third-party-test-requirement") return "primary"
  if (document?.role === "referenced-document") return "referenced"
  if (document?.role === "explicit-supporting-document") return "supporting"
  return "unknown"
}

function attachProtocolProvenance(
  protocols: DtpProtocolDefinition[],
  knowledgeIndex: ProjectKnowledgeIndex,
): DtpProtocolDefinition[] {
  const tableById = new Map(knowledgeIndex.tables.map((table) => [table.id, table]))
  const documentById = new Map(knowledgeIndex.source_documents.map((document) => [document.id, document]))
  return protocols.map((protocol) => {
    const sourceTableIds = uniqueStrings([
      ...getDtpProtocolFrames(protocol).map((frame) => frame.source_table_id),
      ...(protocol.block_layout?.source_table_ids ?? []),
    ])
    const tableGroups = new Map<string, string[]>()
    for (const tableId of sourceTableIds) {
      const documentId = tableById.get(tableId)?.source_document_id
      if (!documentId) continue
      const ids = tableGroups.get(documentId) ?? []
      ids.push(tableId)
      tableGroups.set(documentId, ids)
    }
    const generated = Array.from(tableGroups, ([sourceDocumentId, tableIds]) => ({
      source_document_id: sourceDocumentId,
      source_table_ids: uniqueStrings(tableIds),
      source_sections: uniqueStrings([protocol.source_section ?? ""]),
      evidence: uniqueStrings(protocol.evidence ?? []),
      priority: protocolSourcePriority(documentById.get(sourceDocumentId)),
    }))
    return normalizeDtpProtocolDefinition({
      ...protocol,
      provenance: generated.length ? generated : protocol.provenance,
    })
  })
}

function protocolDefinitionStructuralKey(protocol: DtpProtocolDefinition): string {
  const identity = protocol.semantic_identity ?? protocolSemanticIdentity(protocol)
  return JSON.stringify({
    name: identity.normalized_name,
    role: identity.role,
    message_length_bytes: identity.message_length_bytes,
    related_message_length_bytes: identity.related_message_length_bytes,
    bus: protocol.bus_context?.bus_type ?? "unknown",
    interface_level: protocol.bus_context?.interface_level ?? "unknown",
    interface_id: protocol.bus_context?.interface_id ?? "",
    flow_direction: protocol.flow_direction,
    frames: getDtpProtocolFrames(protocol).map((frame) => ({
      bytes: frame.byte_layout.map((value) => value.trim().toUpperCase()),
      fields: frame.field_layout.map((field) => [field.name.toUpperCase(), field.role, field.byte_offset, field.byte_length]),
      checksum: frame.checksum ? [frame.checksum.type, frame.checksum.start, frame.checksum.end, frame.checksum.expression] : undefined,
    })),
  })
}

function protocolPriority(protocol: DtpProtocolDefinition): number {
  const rank: Record<DtpProtocolProvenance["priority"], number> = {
    primary: 4,
    referenced: 3,
    supporting: 2,
    unknown: 1,
  }
  return Math.max(0, ...(protocol.provenance ?? []).map((item) => rank[item.priority]))
}

function buildResolvedDocumentReferenceScopes(
  knowledgeIndex: ProjectKnowledgeIndex,
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  const link = (left: string, right: string): void => {
    const related = adjacency.get(left) ?? new Set<string>()
    related.add(right)
    adjacency.set(left, related)
  }
  for (const document of knowledgeIndex.source_documents) link(document.id, document.id)
  for (const reference of knowledgeIndex.references) {
    if (reference.state !== "resolved" && reference.state !== "fallback_resolved") continue
    const targetDocumentId = reference.resolved_document_id
    if (!targetDocumentId || targetDocumentId === reference.source_document_id) continue
    link(reference.source_document_id, targetDocumentId)
    link(targetDocumentId, reference.source_document_id)
  }

  const scopes = new Map<string, Set<string>>()
  for (const documentId of adjacency.keys()) {
    const visited = new Set<string>([documentId])
    const queue = [documentId]
    while (queue.length) {
      const current = queue.shift()!
      for (const related of adjacency.get(current) ?? []) {
        if (visited.has(related)) continue
        visited.add(related)
        queue.push(related)
      }
    }
    scopes.set(documentId, visited)
  }
  return scopes
}

function protocolsShareDocumentReferenceScope(
  left: DtpProtocolDefinition,
  right: DtpProtocolDefinition,
  relatedDocumentIds?: Map<string, Set<string>>,
): boolean {
  const leftDocumentIds = uniqueStrings((left.provenance ?? []).map((item) => item.source_document_id))
  const rightDocumentIds = uniqueStrings((right.provenance ?? []).map((item) => item.source_document_id))
  if (leftDocumentIds.some((documentId) => rightDocumentIds.includes(documentId))) return true
  if (!relatedDocumentIds) return false
  return leftDocumentIds.some((documentId) => (
    rightDocumentIds.some((otherDocumentId) => relatedDocumentIds.get(documentId)?.has(otherDocumentId))
  ))
}

function inheritSecondaryCanFrameEnvelopes(
  protocols: DtpProtocolDefinition[],
  relatedDocumentIds?: Map<string, Set<string>>,
): DtpProtocolDefinition[] {
  const donors = protocols.filter((protocol) => (
    protocol.bus_context?.bus_type === "CAN" &&
    protocol.bus_context.interface_level === "secondary" &&
    protocol.frame_envelope?.type === "fixed_prefix" &&
    protocol.frame_envelope.applies_per_frame
  ))
  if (!donors.length) return protocols

  return protocols.map((protocol) => {
    if (
      protocol.frame_envelope ||
      protocol.bus_context?.bus_type !== "CAN" ||
      protocol.bus_context.interface_level !== "secondary"
    ) return protocol

    const sourceDocumentIds = new Set((protocol.provenance ?? []).map((item) => item.source_document_id))
    const compatible = donors.filter((donor) => {
      const protocolInterfaceId = protocol.bus_context?.interface_id
      const donorInterfaceId = donor.bus_context?.interface_id
      if (protocolInterfaceId && donorInterfaceId) return protocolInterfaceId === donorInterfaceId
      if ((donor.provenance ?? []).some((item) => sourceDocumentIds.has(item.source_document_id))) return true
      return protocolsShareDocumentReferenceScope(protocol, donor, relatedDocumentIds)
    })
    const envelopeGroups = new Map<string, DtpProtocolDefinition[]>()
    for (const donor of compatible) {
      const key = JSON.stringify({
        type: donor.frame_envelope?.type,
        bytes: donor.frame_envelope?.bytes,
        applies_per_frame: donor.frame_envelope?.applies_per_frame,
      })
      envelopeGroups.set(key, [...(envelopeGroups.get(key) ?? []), donor])
    }
    if (envelopeGroups.size !== 1) return protocol
    const donor = Array.from(envelopeGroups.values())[0]
      .sort((left, right) => protocolPriority(right) - protocolPriority(left))[0]
    if (!donor.frame_envelope) return protocol

    return normalizeDtpProtocolDefinition({
      ...protocol,
      frame_envelope: donor.frame_envelope,
      evidence: uniqueStrings([
        ...protocol.evidence,
        `Interface frame envelope inherited from ${donor.protocol_id}.`,
      ]),
    })
  })
}

function deriveInterfaceEnvelopeDefinitions(
  protocols: DtpProtocolDefinition[],
): DtpProtocolInterfaceEnvelope[] {
  const groups = new Map<string, DtpProtocolDefinition[]>()
  for (const protocol of protocols) {
    const envelope = protocol.frame_envelope
    if (!envelope) continue
    const key = JSON.stringify({
      bus_type: protocol.bus_context?.bus_type ?? "unknown",
      interface_level: protocol.bus_context?.interface_level ?? "unknown",
      interface_id: protocol.bus_context?.interface_id ?? "",
      envelope: {
        type: envelope.type,
        bytes: envelope.bytes,
        applies_per_frame: envelope.applies_per_frame,
        business_frame_length: envelope.business_frame_length,
        wire_frame_length: envelope.wire_frame_length,
        directions: envelope.directions,
      },
    })
    groups.set(key, [...(groups.get(key) ?? []), protocol])
  }
  return Array.from(groups.values(), (members, index) => {
    const representative = members
      .slice()
      .sort((left, right) => protocolPriority(right) - protocolPriority(left))[0]
    const envelope = representative.frame_envelope!
    return {
      envelope_id: `interface-envelope-${index + 1}`,
      bus_type: representative.bus_context?.bus_type ?? "unknown",
      interface_level: representative.bus_context?.interface_level ?? "unknown",
      ...(representative.bus_context?.interface_id
        ? { interface_id: representative.bus_context.interface_id }
        : {}),
      frame_envelope: envelope,
      source_document_ids: uniqueStrings(members.flatMap((protocol) => (
        (protocol.provenance ?? []).map((item) => item.source_document_id)
      ))),
      source_protocol_ids: uniqueStrings(members.map((protocol) => protocol.protocol_id)),
      evidence: uniqueStrings(members.flatMap((protocol) => [
        ...(protocol.evidence ?? []),
        envelope.source_text ?? "",
      ])),
      confidence: Math.max(0, ...members.map((protocol) => protocol.frame_envelope?.confidence ?? protocol.confidence)),
      warnings: uniqueStrings(members.flatMap((protocol) => protocol.warnings ?? [])),
    }
  })
}

function mergeCanonicalProtocol(primary: DtpProtocolDefinition, duplicate: DtpProtocolDefinition): DtpProtocolDefinition {
  return normalizeDtpProtocolDefinition({
    ...primary,
    aliases: uniqueStrings([
      ...(primary.aliases ?? []),
      duplicate.base_file_name,
      ...(duplicate.aliases ?? []),
    ]),
    variables: primary.variables?.length ? primary.variables : duplicate.variables,
    frame_envelope: primary.frame_envelope ?? duplicate.frame_envelope,
    block_layout: primary.block_layout ?? duplicate.block_layout,
    fields: primary.fields.length ? primary.fields : duplicate.fields,
    variants: [...(primary.variants ?? []), ...(duplicate.variants ?? [])],
    evidence: uniqueStrings([...primary.evidence, ...duplicate.evidence]),
    warnings: uniqueStrings([...primary.warnings, ...duplicate.warnings]),
    provenance: [...(primary.provenance ?? []), ...(duplicate.provenance ?? [])],
    confidence: Math.max(primary.confidence, duplicate.confidence),
  })
}

function canonicalizeProtocolDefinitions(
  protocols: DtpProtocolDefinition[],
): { protocols: DtpProtocolDefinition[]; remappedIds: Map<string, string>; warnings: string[] } {
  const buckets = new Map<string, DtpProtocolDefinition[]>()
  for (const protocol of protocols) {
    const key = protocolDefinitionStructuralKey(protocol)
    const values = buckets.get(key) ?? []
    values.push(protocol)
    buckets.set(key, values)
  }
  const canonical: DtpProtocolDefinition[] = []
  const remappedIds = new Map<string, string>()
  const warnings: string[] = []
  for (const values of buckets.values()) {
    const ordered = [...values].sort((left, right) => protocolPriority(right) - protocolPriority(left))
    let selected = ordered[0]
    for (const duplicate of ordered.slice(1)) {
      remappedIds.set(duplicate.protocol_id, selected.protocol_id)
      selected = mergeCanonicalProtocol(selected, duplicate)
      warnings.push(`Merged equivalent protocol ${duplicate.protocol_id} into ${selected.protocol_id}.`)
    }
    canonical.push(selected)
  }
  return { protocols: canonical, remappedIds, warnings }
}

function protocolLayoutFingerprint(protocol: DtpProtocolDefinition): string {
  return createHash("sha256")
    .update(protocolDefinitionStructuralKey(protocol))
    .digest("hex")
}

function protocolLayoutTableIds(protocol: DtpProtocolDefinition): string[] {
  return uniqueStrings([
    ...getDtpProtocolFrames(protocol).map((frame) => frame.source_table_id),
    ...(protocol.block_layout?.source_table_ids ?? []),
  ])
}

function selectorSemanticKey(relation: DtpProtocolSelectorRelation): string {
  const names = [relation.selector_name, ...relation.selector_aliases].join(" ")
  if (/(?:站|节点|终端|设备|单机)地址|station[_\s-]*address/i.test(names)) return "station_address"
  return names.replace(/\s+/g, "").toLowerCase() || relation.relation_id
}

function protocolFamilyScopeKey(relation: DtpProtocolSelectorRelation): string {
  return [
    relation.bus_type ?? "unknown",
    relation.interface_level ?? "unknown",
    relation.interface_id ?? "unknown",
    relation.protocol_family ?? "unknown",
  ].join("|")
}

function protocolFamilyId(scopeKey: string, role: string): string {
  const digest = createHash("sha256").update(scopeKey).digest("hex").slice(0, 12)
  return `protocol-family-${role}-${digest}`
}

function deriveSelectorProtocolFamilies(
  protocols: DtpProtocolDefinition[],
  selectorRelations: DtpProtocolSelectorRelation[],
): DtpProtocolFamily[] {
  const protocolById = new Map(protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const relationsByScope = new Map<string, DtpProtocolSelectorRelation[]>()
  for (const relation of selectorRelations) {
    const key = protocolFamilyScopeKey(relation)
    relationsByScope.set(key, [...(relationsByScope.get(key) ?? []), relation])
  }

  return Array.from(relationsByScope.entries()).flatMap(([scopeKey, relations]) => {
    const targetProtocols = uniqueStrings(relations.flatMap((relation) => (
      relation.mappings.map((mapping) => mapping.target_protocol_id)
    )))
      .map((protocolId) => protocolById.get(protocolId))
      .filter((protocol): protocol is DtpProtocolDefinition => Boolean(protocol))
    if (!targetProtocols.length) return []

    const variantBuckets = new Map<string, DtpProtocolDefinition[]>()
    for (const protocol of targetProtocols) {
      const fingerprint = protocolLayoutFingerprint(protocol)
      const frameCount = getDtpProtocolFrames(protocol).length
      const key = `${frameCount}|${fingerprint}`
      variantBuckets.set(key, [...(variantBuckets.get(key) ?? []), protocol])
    }
    const variants: DtpProtocolFamilyVariant[] = Array.from(variantBuckets.entries()).map(([key, members]) => {
      const [frameCountText, fingerprint] = key.split("|")
      const canonical = members.slice().sort((left, right) => protocolPriority(right) - protocolPriority(left))[0]
      const frameCount = Number.parseInt(frameCountText, 10)
      return {
        variant_key: `frame_count_${frameCount}_${fingerprint.slice(0, 8)}`,
        protocol_ids: members.map((protocol) => protocol.protocol_id),
        canonical_protocol_id: canonical.protocol_id,
        frame_count: Number.isFinite(frameCount) ? frameCount : undefined,
        layout_fingerprint: fingerprint,
        layout_table_ids: uniqueStrings(members.flatMap(protocolLayoutTableIds)),
        evidence: uniqueStrings(members.flatMap((protocol) => protocol.evidence)),
      }
    })
    const variantByProtocolId = new Map(variants.flatMap((variant) => (
      variant.protocol_ids.map((protocolId) => [protocolId, variant] as const)
    )))
    const selectorGroups = new Map<string, DtpProtocolSelectorRelation[]>()
    for (const relation of relations) {
      const key = `${relation.selector_type}|${selectorSemanticKey(relation)}`
      selectorGroups.set(key, [...(selectorGroups.get(key) ?? []), relation])
    }
    const selectors = Array.from(selectorGroups.entries()).map(([key, selectorRelations]) => {
      const mappingsByValue = new Map<string, Array<{ relation: DtpProtocolSelectorRelation; mapping: DtpProtocolSelectorRelation["mappings"][number] }>>()
      for (const relation of selectorRelations) {
        for (const mapping of relation.mappings) {
          const value = mapping.selector_value.toUpperCase()
          mappingsByValue.set(value, [...(mappingsByValue.get(value) ?? []), { relation, mapping }])
        }
      }
      const mappings = Array.from(mappingsByValue.entries()).map(([selectorValue, entries]) => {
        const targetFrameCounts = uniqueStrings(entries.flatMap(({ mapping }) => {
          const protocol = protocolById.get(mapping.target_protocol_id)
          const frameCount = mapping.target_frame_count ?? (protocol ? getDtpProtocolFrames(protocol).length : undefined)
          return frameCount === undefined ? [] : [String(frameCount)]
        })).map(Number)
        const warnings = targetFrameCounts.length > 1
          ? [`Selector value ${selectorValue} maps to conflicting frame counts: ${targetFrameCounts.join(", ")}.`]
          : []
        return {
          selector_value: selectorValue,
          variant_keys: uniqueStrings(entries.flatMap(({ mapping }) => {
            const variant = variantByProtocolId.get(mapping.target_protocol_id)
            return variant ? [variant.variant_key] : []
          })),
          target_frame_count: targetFrameCounts.length === 1 ? targetFrameCounts[0] : undefined,
          evidence: uniqueStrings(entries.flatMap(({ mapping }) => mapping.evidence)),
          warnings,
        }
      })
      const [, semanticKey] = key.split("|")
      return {
        selector_id: `${protocolFamilyId(scopeKey, relations[0].protocol_family ?? "unknown")}-selector-${semanticKey}`,
        relation_ids: selectorRelations.map((relation) => relation.relation_id),
        selector_name: selectorRelations[0].selector_name,
        selector_aliases: uniqueStrings(selectorRelations.flatMap((relation) => [
          relation.selector_name,
          ...relation.selector_aliases,
        ])),
        selector_type: selectorRelations[0].selector_type,
        mappings,
        evidence: uniqueStrings(selectorRelations.flatMap((relation) => relation.evidence)),
        confidence: Math.max(...selectorRelations.map((relation) => relation.confidence)),
        warnings: uniqueStrings([
          ...selectorRelations.flatMap((relation) => relation.warnings),
          ...mappings.flatMap((mapping) => mapping.warnings),
        ]),
      }
    })
    const flowDirections = uniqueStrings(targetProtocols.map((protocol) => protocol.flow_direction)) as FlowDirection[]
    const role = relations[0].protocol_family ?? "unknown"
    return [{
      family_id: protocolFamilyId(scopeKey, role),
      bus_type: relations[0].bus_type ?? targetProtocols[0].bus_context?.bus_type ?? "unknown",
      interface_level: relations[0].interface_level ?? targetProtocols[0].bus_context?.interface_level ?? "unknown",
      ...(relations[0].interface_id ? { interface_id: relations[0].interface_id } : {}),
      flow_direction: flowDirections.length === 1 ? flowDirections[0] : "unknown",
      semantic_role: role,
      variants,
      selectors,
      evidence: uniqueStrings(relations.flatMap((relation) => relation.evidence)),
      warnings: uniqueStrings(selectors.flatMap((selector) => selector.warnings)),
    }]
  })
}

function deriveCompositionProtocolFamilies(
  protocols: DtpProtocolDefinition[],
  groups: DtpProtocolGroup[],
): DtpProtocolFamily[] {
  const protocolById = new Map(protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const orderedPacketFamilies = groups.flatMap((group): DtpProtocolFamily[] => {
    const members = group.protocol_ids
      .map((protocolId) => protocolById.get(protocolId))
      .filter((protocol): protocol is DtpProtocolDefinition => Boolean(protocol))
    if (members.length < 2) return []
    const roles = uniqueStrings(members.map((protocol) => protocol.semantic_identity?.role ?? "unknown")) as DtpProtocolSemanticRole[]
    return [{
      family_id: `protocol-family-group-${group.group_id}`,
      bus_type: members[0].bus_context?.bus_type ?? "unknown",
      interface_level: members[0].bus_context?.interface_level ?? "unknown",
      ...(members[0].bus_context?.interface_id ? { interface_id: members[0].bus_context.interface_id } : {}),
      flow_direction: group.flow_direction,
      semantic_role: roles.length === 1 ? roles[0] : "unknown",
      variants: [],
      selectors: [],
      composition: {
        type: "ordered_packets",
        group_id: group.group_id,
        members: members.map((protocol, index) => ({
          protocol_id: protocol.protocol_id,
          role: `packet_${index + 1}`,
          order: index + 1,
          cardinality: "1",
        })),
      },
      evidence: group.evidence,
      warnings: group.warnings,
    }]
  })
  const orderedBlockFamilies = protocols.flatMap((protocol): DtpProtocolFamily[] => {
    const block = protocol.block_layout
    if (!block) return []
    const members: Extract<DtpProtocolFamily["composition"], { type: "ordered_blocks" }>["members"] = []
    if (block.start_block_type) members.push({ role: "start", order: 1, cardinality: "1", discriminator: block.start_block_type })
    if (block.middle_block_type) members.push({ role: "middle", order: 2, cardinality: "0..n", discriminator: block.middle_block_type })
    if (block.check_block_type) members.push({ role: "check", order: 3, cardinality: "1", discriminator: block.check_block_type })
    if (members.length < 2) return []
    return [{
      family_id: `protocol-family-block-${protocol.protocol_id}`,
      bus_type: protocol.bus_context?.bus_type ?? "unknown",
      interface_level: protocol.bus_context?.interface_level ?? "unknown",
      ...(protocol.bus_context?.interface_id ? { interface_id: protocol.bus_context.interface_id } : {}),
      flow_direction: protocol.flow_direction,
      semantic_role: protocol.semantic_identity?.role ?? "data_block",
      variants: [],
      selectors: [],
      composition: {
        type: "ordered_blocks",
        protocol_id: protocol.protocol_id,
        members,
      },
      evidence: uniqueStrings([...protocol.evidence, ...block.source_table_ids]),
      warnings: protocol.warnings,
    }]
  })
  return [...orderedPacketFamilies, ...orderedBlockFamilies]
}

function deriveProtocolFamilies(
  protocols: DtpProtocolDefinition[],
  groups: DtpProtocolGroup[],
  selectorRelations: DtpProtocolSelectorRelation[],
): DtpProtocolFamily[] {
  return [
    ...deriveSelectorProtocolFamilies(protocols, selectorRelations),
    ...deriveCompositionProtocolFamilies(protocols, groups),
  ]
}

function protocolRelationIdentity(protocol: DtpProtocolDefinition): string {
  return normalizeLookupText(protocol.semantic_identity?.entity ?? protocol.base_file_name)
    .replace(/(?:应答|响应|回复|reply|response)$/i, "")
}

function buildProtocolRelations(
  protocols: DtpProtocolDefinition[],
  groups: DtpProtocolGroup[],
  selectorRelations: DtpProtocolSelectorRelation[],
): DtpProtocolRelation[] {
  const relations: DtpProtocolRelation[] = []
  const commands = protocols.filter((protocol) => protocol.semantic_identity?.role === "command")
  for (const response of protocols.filter((protocol) => protocol.semantic_identity?.role === "response")) {
    const responseIdentity = protocolRelationIdentity(response)
    const relatedLength = response.semantic_identity?.related_message_length_bytes
    let candidates = commands.filter((command) => {
      if (command.bus_context?.bus_type !== response.bus_context?.bus_type) return false
      if ((command.bus_context?.interface_level ?? "unknown") !== (response.bus_context?.interface_level ?? "unknown")) return false
      const commandIdentity = protocolRelationIdentity(command)
      if (!(responseIdentity.includes(commandIdentity) || commandIdentity.includes(responseIdentity))) return false
      return relatedLength === undefined || command.semantic_identity?.message_length_bytes === relatedLength
    })
    const sameSection = candidates.filter((command) => (
      Boolean(response.source_section) && command.source_section === response.source_section
    ))
    if (sameSection.length) candidates = sameSection
    const responseDocumentIds = new Set((response.provenance ?? []).map((item) => item.source_document_id))
    const sameDocument = candidates.filter((command) => (
      (command.provenance ?? []).some((item) => responseDocumentIds.has(item.source_document_id))
    ))
    if (sameDocument.length) candidates = sameDocument
    if (candidates.length === 1) {
      relations.push({
        relation_id: `${response.protocol_id}-responds-to-${candidates[0].protocol_id}`,
        type: "responds_to",
        source_id: response.protocol_id,
        source_kind: "protocol",
        target_ids: [candidates[0].protocol_id],
        target_kind: "protocol",
        evidence: uniqueStrings([response.source_section ?? "", candidates[0].source_section ?? ""]),
        confidence: 0.9,
        warnings: [],
      })
    }
  }
  for (const group of groups) {
    relations.push({
      relation_id: `${group.group_id}-composed-of`,
      type: "composed_of",
      source_id: group.group_id,
      source_kind: "protocol_group",
      target_ids: group.protocol_ids,
      target_kind: "protocol",
      evidence: group.evidence,
      confidence: 1,
      warnings: [],
    })
    for (let index = 1; index < group.protocol_ids.length; index += 1) {
      relations.push({
        relation_id: `${group.protocol_ids[index]}-follows-${group.protocol_ids[index - 1]}`,
        type: "follows",
        source_id: group.protocol_ids[index],
        source_kind: "protocol",
        target_ids: [group.protocol_ids[index - 1]],
        target_kind: "protocol",
        evidence: group.evidence,
        confidence: 1,
        warnings: [],
      })
    }
  }
  for (const selector of selectorRelations) {
    for (const protocolId of uniqueStrings(selector.mappings.map((mapping) => mapping.target_protocol_id))) {
      relations.push({
        relation_id: `${protocolId}-selected-by-${selector.relation_id}`,
        type: "selected_by",
        source_id: protocolId,
        source_kind: "protocol",
        target_ids: [selector.relation_id],
        target_kind: "selector_relation",
        evidence: selector.evidence,
        confidence: selector.confidence,
        warnings: selector.warnings,
      })
    }
  }
  return relations
}

export function migrateDtpProtocolDefinitionsDocument(
  definitions: DtpProtocolDefinitionsDocument,
): DtpProtocolDefinitionsDocument {
  const normalizedProtocols = inheritSecondaryCanFrameEnvelopes(
    definitions.protocols.map(normalizeDtpProtocolDefinition),
  )
  const canonicalized = canonicalizeProtocolDefinitions(normalizedProtocols)
  const protocols = canonicalized.protocols
  const protocolIds = new Set(protocols.map((protocol) => protocol.protocol_id))
  const remapProtocolId = (protocolId: string): string => canonicalized.remappedIds.get(protocolId) ?? protocolId
  const sections = definitions.sections.map((section) => ({
    ...section,
    protocol_ids: uniqueStrings(section.protocol_ids.map(remapProtocolId)),
  }))
  const remappedGroups = (definitions.protocol_groups ?? []).map((group) => ({
    ...group,
    protocol_ids: uniqueStrings(group.protocol_ids.map(remapProtocolId)),
  }))
  const protocolGroups = normalizeProtocolGroups({ ...definitions, sections, protocol_groups: remappedGroups }, protocols)
  const selectorRelations = (definitions.selector_relations ?? []).flatMap((relation) => {
    if (!relation?.relation_id || !relation.section_model_id || !relation.selector_name) return []
    const mappings = (relation.mappings ?? [])
      .map((mapping) => ({ ...mapping, target_protocol_id: remapProtocolId(mapping.target_protocol_id) }))
      .filter((mapping) => Boolean(mapping.selector_value) && protocolIds.has(mapping.target_protocol_id))
    if (!mappings.length) return []
    return [{
      ...relation,
      selector_aliases: uniqueStrings(relation.selector_aliases ?? []),
      mappings,
      evidence: uniqueStrings(relation.evidence ?? []),
      warnings: uniqueStrings(relation.warnings ?? []),
    }]
  })
  const protocolFamilies = deriveProtocolFamilies(protocols, protocolGroups, selectorRelations)
  return {
    ...definitions,
    schema_version: "4.0.0",
    sections,
    protocols,
    protocol_groups: protocolGroups,
    protocol_families: protocolFamilies,
    selector_relations: selectorRelations,
    relations: buildProtocolRelations(protocols, protocolGroups, selectorRelations),
    warnings: uniqueStrings([...(definitions.warnings ?? []), ...canonicalized.warnings]),
    updated_at: definitions.updated_at || new Date().toISOString(),
  }
}

export function validateDtpProtocolDefinitions(
  definitions: DtpProtocolDefinitionsDocument,
): DtpProtocolDefinitionValidationResult {
  const issues: DtpProtocolDefinitionValidationIssue[] = []
  if (definitions.schema_version !== "4.0.0") {
    issues.push({ severity: "error", message: `Protocol schema ${definitions.schema_version} is unsupported; expected 4.0.0.` })
  }
  const protocolIds = new Set(definitions.protocols.map((protocol) => protocol.protocol_id))
  const protocolGroupIds = new Set((definitions.protocol_groups ?? []).map((group) => group.group_id))
  const selectorRelationIds = new Set((definitions.selector_relations ?? []).map((relation) => relation.relation_id))
  const familyIds = new Set((definitions.protocol_families ?? []).map((family) => family.family_id))
  for (const group of definitions.protocol_groups ?? []) {
    if (group.protocol_ids.length < 2) {
      issues.push({ severity: "error", message: `Protocol group ${group.group_id} must contain at least two protocols.` })
    }
    for (const protocolId of group.protocol_ids) {
      if (!protocolIds.has(protocolId)) {
        issues.push({ severity: "error", message: `Protocol group ${group.group_id} targets missing protocol ${protocolId}.` })
      }
    }
  }
  for (const relation of definitions.selector_relations ?? []) {
    const targetsByValue = new Map<string, Set<string>>()
    for (const mapping of relation.mappings) {
      if (!protocolIds.has(mapping.target_protocol_id)) {
        issues.push({
          severity: "error",
          message: `Selector relation ${relation.relation_id} targets missing protocol ${mapping.target_protocol_id}.`,
        })
      }
      const value = mapping.selector_value.toUpperCase()
      const targets = targetsByValue.get(value) ?? new Set<string>()
      targets.add(mapping.target_protocol_id)
      targetsByValue.set(value, targets)
    }
    for (const [value, targets] of targetsByValue) {
      if (targets.size > 1) {
        issues.push({
          severity: "warning",
          message: `Selector relation ${relation.relation_id} maps value ${value} to multiple protocols; runtime selection will remain ambiguous.`,
        })
      }
    }
  }
  if (familyIds.size !== (definitions.protocol_families ?? []).length) {
    issues.push({ severity: "error", message: "Protocol family ids must be unique." })
  }
  for (const family of definitions.protocol_families ?? []) {
    const variantKeys = new Set(family.variants.map((variant) => variant.variant_key))
    for (const variant of family.variants) {
      if (!protocolIds.has(variant.canonical_protocol_id)) {
        issues.push({ severity: "error", message: `Protocol family ${family.family_id} has missing canonical protocol ${variant.canonical_protocol_id}.` })
      }
      for (const protocolId of variant.protocol_ids) {
        if (!protocolIds.has(protocolId)) {
          issues.push({ severity: "error", message: `Protocol family ${family.family_id} targets missing protocol ${protocolId}.` })
        }
      }
    }
    for (const selector of family.selectors) {
      for (const mapping of selector.mappings) {
        for (const variantKey of mapping.variant_keys) {
          if (!variantKeys.has(variantKey)) {
            issues.push({ severity: "error", message: `Protocol family selector ${selector.selector_id} targets missing variant ${variantKey}.` })
          }
        }
      }
    }
    if (family.composition?.type === "ordered_packets") {
      for (const member of family.composition.members) {
        if (!protocolIds.has(member.protocol_id)) {
          issues.push({ severity: "error", message: `Protocol family ${family.family_id} contains missing packet ${member.protocol_id}.` })
        }
      }
    }
    if (family.composition?.type === "ordered_blocks" && !protocolIds.has(family.composition.protocol_id)) {
      issues.push({ severity: "error", message: `Protocol family ${family.family_id} contains missing block protocol ${family.composition.protocol_id}.` })
    }
  }
  for (const relation of definitions.relations ?? []) {
    const validSource = relation.source_kind === "protocol"
      ? protocolIds.has(relation.source_id)
      : protocolGroupIds.has(relation.source_id)
    if (!validSource) {
      issues.push({ severity: "error", message: `Relation ${relation.relation_id} has missing source ${relation.source_id}.` })
    }
    const validTargets = relation.target_kind === "protocol"
      ? relation.target_ids.every((id) => protocolIds.has(id))
      : relation.target_kind === "protocol_group"
        ? relation.target_ids.every((id) => protocolGroupIds.has(id))
        : relation.target_ids.every((id) => selectorRelationIds.has(id))
    if (!validTargets) {
      issues.push({ severity: "error", message: `Relation ${relation.relation_id} has one or more missing targets.` })
    }
  }
  for (const protocol of definitions.protocols) {
    if (!protocol.semantic_identity || !protocol.transport) {
      issues.push({ severity: "error", protocol_id: protocol.protocol_id, message: "Protocol semantic_identity and transport are required in schema 4.0.0." })
    }
    if (
      protocol.bus_context?.interface_level === "secondary" &&
      (/SJA1000/i.test(protocol.bus_context.controller ?? "") || /PeliCAN/i.test(protocol.bus_context.mode ?? ""))
    ) {
      issues.push({
        severity: "error",
        protocol_id: protocol.protocol_id,
        message: "Secondary CAN protocol must not inherit a primary SJA1000/PeliCAN profile.",
      })
    }
    if (protocol.frame_envelope && protocol.bus_context?.interface_level !== "secondary") {
      issues.push({
        severity: "error",
        protocol_id: protocol.protocol_id,
        message: "The fixed FPGA frame envelope is only valid for a secondary CAN interface.",
      })
    }
    if (protocol.frame_envelope) {
      const envelope = protocol.frame_envelope
      if (
        envelope.type !== "fixed_prefix" ||
        !envelope.applies_per_frame ||
        !envelope.bytes.length ||
        envelope.bytes.some((byte) => !/^[0-9A-F]{2}$/u.test(byte))
      ) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          message: "The fixed frame envelope must contain valid uppercase bytes and apply to every frame.",
        })
      }
      if (envelope.position && envelope.position !== "before_frame") {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          message: "The fixed frame envelope must be positioned before the business frame.",
        })
      }
      const businessLength = envelope.business_frame_length
      const wireLength = envelope.wire_frame_length
      if (businessLength !== undefined && (!Number.isInteger(businessLength) || businessLength <= 0)) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          message: "The frame-envelope business length must be a positive integer.",
        })
      }
      if (wireLength !== undefined && (!Number.isInteger(wireLength) || wireLength <= 0)) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          message: "The frame-envelope wire length must be a positive integer.",
        })
      }
      if (
        businessLength !== undefined &&
        wireLength !== undefined &&
        businessLength + envelope.bytes.length !== wireLength
      ) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          message: `The frame-envelope length equation is inconsistent: ${businessLength}+${envelope.bytes.length}!=${wireLength}.`,
        })
      }
    }
    const frames = getDtpProtocolFrames(protocol)
    if (!frames.length) {
      issues.push({
        severity: "error",
        protocol_id: protocol.protocol_id,
        message: "Protocol has no frame definition.",
      })
      continue
    }
    // CAN multi-frame payloads commonly carry TITLE only in the first frame and
    // SUM only in the tail frame. Treat that TITLE as a protocol-level anchor.
    const protocolTitleFrameIndexes = frames
      .map((frame, frameIndex) => ({
        frameIndex,
        titleOffsets: new Set(frame.field_layout
          .filter((field) => field.role === "title" || /^(?:TITLE|T)$/i.test(field.name))
          .map((field) => field.byte_offset)),
      }))
      .filter((item) => item.titleOffsets.size === 1)
      .map((item) => item.frameIndex)
    const protocolChecksumFrameIndexes = frames
      .map((frame, frameIndex) => ({ frame, frameIndex }))
      .filter(({ frame }) => (
        frame.field_layout.some((field) => field.role === "checksum") ||
        frame.byte_layout.some((token) => /^(?:SUM|CHECKSUM|CRC)$/i.test(token))
      ))
      .map((item) => item.frameIndex)
    const blockLayout = protocol.block_layout
    if (blockLayout) {
      const rangeChecks: Array<{ name: string; offset?: number; length?: number }> = [
        { name: "payload", offset: blockLayout.payload_offset, length: blockLayout.payload_capacity },
        { name: "address", offset: blockLayout.address_offset, length: blockLayout.address_length },
        { name: "length", offset: blockLayout.length_offset, length: blockLayout.length_length },
        { name: "block type", offset: blockLayout.block_type_offset, length: 1 },
        ...blockLayout.checksums.map((checksum) => ({
          name: `checksum ${checksum.name}`,
          offset: checksum.output_offset,
          length: checksum.output_length,
        })),
      ]
      for (const range of rangeChecks) {
        if (range.offset === undefined || range.length === undefined) continue
        if (range.offset < 0 || range.length < 1 || range.offset + range.length > blockLayout.total_bytes) {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            message: `SpaceWire ${range.name} range is outside the ${blockLayout.total_bytes}-byte block.`,
          })
        }
      }
      for (const checksum of blockLayout.checksums.filter((item) => item.source === "frame_range")) {
        if (
          checksum.source_start === undefined ||
          checksum.source_end === undefined ||
          checksum.source_start < 0 ||
          checksum.source_end < checksum.source_start ||
          checksum.source_end >= blockLayout.total_bytes
        ) {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            message: `SpaceWire checksum ${checksum.name} has an invalid source range.`,
          })
        }
      }
      for (const frame of frames) {
        if (frame.byte_layout.length !== blockLayout.total_bytes) {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            frame_id: frame.frame_id,
            message: `SpaceWire block template must contain exactly ${blockLayout.total_bytes} bytes.`,
          })
        }
      }
      if (blockLayout.kind === "spacewire_program_upload") {
        const frameIds = new Set(frames.map((frame) => frame.frame_id))
        for (const requiredFrameId of ["start-block", "middle-block", "check-block"]) {
          if (!frameIds.has(requiredFrameId)) {
            issues.push({
              severity: "error",
              protocol_id: protocol.protocol_id,
              message: `SpaceWire program upload is missing the ${requiredFrameId} template.`,
            })
          }
        }
      }
    }
    const seenSequences = new Set<number>()
    for (const [frameIndex, frame] of frames.entries()) {
      if (frame.wire_length !== frame.byte_layout.length) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          frame_id: frame.frame_id,
          message: `Frame wire_length ${frame.wire_length ?? "missing"} does not match byte_layout length ${frame.byte_layout.length}.`,
        })
      }
      if (!frame.byte_layout.length) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          frame_id: frame.frame_id,
          message: "Frame byte_layout is empty.",
        })
      }
      if (seenSequences.has(frame.sequence)) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          frame_id: frame.frame_id,
          message: `Duplicate frame sequence ${frame.sequence}.`,
        })
      }
      seenSequences.add(frame.sequence)
      for (const field of frame.field_layout) {
        if (
          field.value_rule?.variable &&
          !(protocol.variables ?? []).some((variable) => variable.name === field.value_rule?.variable)
        ) {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            frame_id: frame.frame_id,
            message: `Field ${field.name} references undefined variable ${field.value_rule.variable}.`,
          })
        }
        if (field.byte_offset < 0 || field.byte_length < 1 || field.byte_offset + field.byte_length > frame.byte_layout.length) {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            frame_id: frame.frame_id,
            message: `Field ${field.name} is outside the frame byte layout.`,
          })
        }
        if (
          field.bit_offset !== undefined &&
          (field.bit_offset < 0 || field.bit_offset > 7 || (field.bit_length ?? 1) < 1 || field.bit_offset + (field.bit_length ?? 1) > field.byte_length * 8)
        ) {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            frame_id: frame.frame_id,
            message: `Field ${field.name} has an invalid bit range.`,
          })
        }
      }
      const titleFields = frame.field_layout.filter((field) => field.role === "title" || /^(?:TITLE|T)$/i.test(field.name))
      const titleOffsets = new Set(titleFields.map((field) => field.byte_offset))
      if (titleOffsets.size > 1) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          frame_id: frame.frame_id,
          message: "TITLE resolves to multiple byte offsets in field_layout.",
        })
      }
      const dataWords = frame.field_layout
        .map((field) => ({ field, index: Number.parseInt(field.name.match(/^W(\d+)$/i)?.[1] ?? "", 10) }))
        .filter((item) => Number.isFinite(item.index))
        .sort((a, b) => a.index - b.index)
      const w0 = dataWords.find((item) => item.index === 0)?.field
      if (w0 && titleOffsets.has(w0.byte_offset)) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          frame_id: frame.frame_id,
          message: "TITLE and W0 resolve to the same byte offset.",
        })
      }
      for (let index = 1; index < dataWords.length; index += 1) {
        const previous = dataWords[index - 1]
        const current = dataWords[index]
        if (current.index === previous.index) {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            frame_id: frame.frame_id,
            message: `W${current.index} is defined more than once in field_layout.`,
          })
        } else if (
          current.index === previous.index + 1 &&
          current.field.byte_offset !== previous.field.byte_offset + previous.field.byte_length
        ) {
          issues.push({
            severity: "warning",
            protocol_id: protocol.protocol_id,
            frame_id: frame.frame_id,
            message: `W${previous.index} and W${current.index} are not physically contiguous.`,
          })
        }
      }
      const checksumStart = frame.checksum?.start?.trim().toUpperCase()
      const inheritedMultiFrameTitle =
        checksumStart === "TITLE" &&
        titleOffsets.size === 0 &&
        protocolTitleFrameIndexes.length === 1 &&
        protocolTitleFrameIndexes[0] < frameIndex &&
        protocolChecksumFrameIndexes.some((checksumFrameIndex) => checksumFrameIndex >= frameIndex)
      if (checksumStart === "TITLE" && titleOffsets.size !== 1 && !inheritedMultiFrameTitle) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          frame_id: frame.frame_id,
          message: "Checksum starts at TITLE, but TITLE cannot be resolved uniquely.",
        })
      } else if (
        checksumStart &&
        checksumStart !== "TITLE" &&
        !frame.field_layout.some((field) => field.name.toUpperCase() === checksumStart)
      ) {
        issues.push({
          severity: "error",
          protocol_id: protocol.protocol_id,
          frame_id: frame.frame_id,
          message: `Checksum starts at ${checksumStart}, but that field is missing from field_layout.`,
        })
      }
      if (
        frame.checksum?.type === "sum_low8" &&
        !frame.field_layout.some((field) => field.role === "checksum") &&
        !inheritedMultiFrameTitle
      ) {
        issues.push({
          severity: "warning",
          protocol_id: protocol.protocol_id,
          frame_id: frame.frame_id,
          message: "SUM checksum is configured but no checksum field exists in field_layout.",
        })
      }
      if (protocol.bus_context?.bus_type === "SPI") {
        const addressFields = frame.field_layout.filter((field) => field.name.toUpperCase() === "ADDRESS")
        const lengthField = frame.field_layout.find((field) => field.role === "length")
        const dataOffsets = new Set(frame.field_layout
          .filter((field) => field.role === "data")
          .flatMap((field) => Array.from({ length: field.byte_length }, (_, offset) => field.byte_offset + offset)))
        if (addressFields.length !== 1 || addressFields[0].byte_offset !== 0) {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            frame_id: frame.frame_id,
            message: "SPI frame must define one ADDRESS field at byte offset 0.",
          })
        }
        if (!lengthField) {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            frame_id: frame.frame_id,
            message: "SPI frame must define a LENGTH field.",
          })
        } else {
          const declaredLength = normalizeHexByte(lengthField.default_value)
          if (declaredLength && Number.parseInt(declaredLength, 16) !== dataOffsets.size) {
            issues.push({
              severity: "error",
              protocol_id: protocol.protocol_id,
              frame_id: frame.frame_id,
              message: `SPI LENGTH=${Number.parseInt(declaredLength, 16)} does not match ${dataOffsets.size} DATA byte(s).`,
            })
          }
        }
        if (frame.checksum?.type === "sum_low8" && checksumStart !== "ADDRESS") {
          issues.push({
            severity: "error",
            protocol_id: protocol.protocol_id,
            frame_id: frame.frame_id,
            message: "SPI low-byte SUM must start at ADDRESS.",
          })
        }
      }
    }
  }
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
  }
}

export function loadDtpProtocolDefinitions(
  definitionsFile: string,
  expectedProjectRoot?: string,
  options: { allowLegacySchema?: boolean; allowValidationErrors?: boolean } = {},
): DtpProtocolDefinitionsDocument | null {
  if (!existsSync(definitionsFile)) return null
  try {
    const parsed = JSON.parse(readFileSync(definitionsFile, "utf-8")) as DtpProtocolDefinitionsDocument
    if (
      !isRecord(parsed) ||
      (!options.allowLegacySchema && parsed.schema_version !== "4.0.0") ||
      !Array.isArray(parsed.sections) ||
      !Array.isArray(parsed.protocols)
    ) return null
    if (expectedProjectRoot && parsed.project_root !== expectedProjectRoot) return null
    const migrated = migrateDtpProtocolDefinitionsDocument(parsed)
    return options.allowValidationErrors || validateDtpProtocolDefinitions(migrated).valid ? migrated : null
  } catch {
    return null
  }
}

function normalizeBusType(value: string | undefined): DtpProtocolBusContext["bus_type"] {
  if (/^CAN$/i.test(value ?? "")) return "CAN"
  if (/^SPI$/i.test(value ?? "")) return "SPI"
  if (/^SpaceWire$/i.test(value ?? "")) return "SpaceWire"
  if (/^RS422$/i.test(value ?? "")) return "RS422"
  if (/^UART$/i.test(value ?? "")) return "UART"
  if (/^1553B$/i.test(value ?? "")) return "1553B"
  return "unknown"
}

function normalizeCanMode(value: string | undefined): DtpProtocolBusContext["mode"] | undefined {
  if (/^BasicCAN$/i.test(value ?? "")) return "BasicCAN"
  if (/^PeliCAN$/i.test(value ?? "")) return "PeliCAN"
  if (/^unknown$/i.test(value ?? "")) return "unknown"
  return value
}

function normalizeCanController(value: string | undefined): DtpProtocolBusContext["controller"] | undefined {
  if (/^SJA1000T$/i.test(value ?? "")) return "SJA1000T"
  if (/^SJA1000$/i.test(value ?? "")) return "SJA1000"
  if (/^unknown$/i.test(value ?? "")) return "unknown"
  return value
}

function normalizeCanControllerFamily(
  value: string | undefined,
  controller: string | undefined,
): DtpProtocolBusContext["controller_family"] | undefined {
  if (/^SJA1000$/i.test(value ?? "") || /SJA1000T?/i.test(controller ?? "")) return "SJA1000"
  if (/^unknown$/i.test(value ?? "")) return "unknown"
  return value
}

function normalizeFrameFormat(value: string | undefined): DtpProtocolBusContext["frame_format"] | undefined {
  if (value === "standard" || value === "extended" || value === "unknown") return value
  return undefined
}

function normalizeFrameBufferLayout(value: string | undefined): DtpProtocolBusContext["frame_buffer_layout"] | undefined {
  if (
    value === "business-payload" ||
    value === "sja1000-basiccan" ||
    value === "sja1000-pelican" ||
    value === "unknown"
  ) return value
  return undefined
}

function sanitizeProtocolBusContext(raw: unknown): DtpProtocolBusContext | undefined {
  if (!isRecord(raw)) return undefined
  const busType = normalizeBusType(asString(raw.bus_type))
  const controller = normalizeCanController(asString(raw.controller))
  const controllerFamily = normalizeCanControllerFamily(asString(raw.controller_family), controller)
  const rawFrameInformation = isRecord(raw.frame_information) ? raw.frame_information : undefined
  const applyToCaseData = rawFrameInformation?.apply_to_case_data
  const strategy = asString(rawFrameInformation?.strategy)
  const rawInterfaceLevel = asString(raw.interface_level)
  const interfaceId = asString(raw.interface_id)
  const interfaceIdLevel: DtpProtocolBusContext["interface_level"] = busType === "CAN"
    ? /^IF-CAN0-/i.test(interfaceId ?? "")
      ? "primary"
      : /^IF-CAN1-/i.test(interfaceId ?? "")
        ? "secondary"
        : undefined
    : undefined
  const interfaceLevel: DtpProtocolBusContext["interface_level"] =
    rawInterfaceLevel === "primary" || rawInterfaceLevel === "secondary"
      ? rawInterfaceLevel
      : interfaceIdLevel ?? (rawInterfaceLevel === "unknown" ? "unknown" : undefined)
  const rawProfileScope = asString(raw.profile_scope)
  const profileScope: DtpProtocolBusContext["profile_scope"] =
    rawProfileScope === "interface" || rawProfileScope === "section" || rawProfileScope === "document"
      ? rawProfileScope
      : undefined
  const context: DtpProtocolBusContext = {
    bus_type: busType,
    interface_level: interfaceLevel,
    interface_id: interfaceId,
    interface_name: asString(raw.interface_name),
    profile_scope: profileScope,
    controller,
    controller_family: controllerFamily,
    mode: normalizeCanMode(asString(raw.mode)),
    frame_format: normalizeFrameFormat(asString(raw.frame_format)),
    frame_buffer_layout: normalizeFrameBufferLayout(asString(raw.frame_buffer_layout)),
    frame_info_byte: normalizeHexByte(asString(raw.frame_info_byte)),
    frame_information: strategy === "derive_from_ff_rtr_dlc" || applyToCaseData === true
      ? {
          apply_to_case_data: applyToCaseData !== false,
          strategy: "derive_from_ff_rtr_dlc",
        }
      : undefined,
    evidence: uniqueStrings(
      getNestedArray(raw, ["evidence"])
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item)),
    ),
    confidence: Math.max(0, Math.min(1, asNumber(raw.confidence) ?? 0.5)),
    warnings: getNestedArray(raw, ["warnings"])
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item)),
  }

  if (
    context.bus_type === "unknown" &&
    !context.controller &&
    !context.controller_family &&
    !context.mode &&
    !context.frame_buffer_layout &&
    !context.frame_info_byte &&
    !context.frame_information
  ) return undefined

  return context
}

function reconcileModelBusContextWithTableEvidence(
  context: DtpProtocolContextPackage,
  frameTable: SectionProtocolRelationTableInput | undefined,
  modelBusContext: DtpProtocolBusContext | undefined,
): DtpProtocolBusContext | undefined {
  if (!frameTable || !modelBusContext) return modelBusContext
  if (context.referenced_primary_table_ids?.includes(frameTable.id)) {
    // A strongly referenced table contributes the payload layout, while the
    // referring flow remains authoritative for the transport/interface scope.
    return inferProtocolBusContext(context, frameTable) ?? modelBusContext
  }
  const structuralBusType: DtpProtocolBusContext["bus_type"] | undefined =
    isSpaceWireBlockTableInput(frameTable)
      ? "SpaceWire"
      : isSpiFrameTableInput(frameTable)
        ? "SPI"
        : isCanFrameTableInput(frameTable)
          ? "CAN"
          : undefined
  if (!structuralBusType || modelBusContext.bus_type === structuralBusType) return modelBusContext

  const inferred = inferProtocolBusContext(context, frameTable)
  if (!inferred || inferred.bus_type !== structuralBusType) return modelBusContext
  return {
    ...inferred,
    evidence: uniqueStrings([...(inferred.evidence ?? []), ...(modelBusContext.evidence ?? [])]),
    confidence: Math.max(inferred.confidence ?? 0, modelBusContext.confidence ?? 0),
    warnings: uniqueStrings([
      ...(inferred.warnings ?? []),
      ...(modelBusContext.warnings ?? []),
      `Model bus_type ${modelBusContext.bus_type} was overridden by table-local ${structuralBusType} frame evidence.`,
    ]),
  }
}

function hasKnownBusValue(value: string | undefined): boolean {
  return Boolean(value && value.toLowerCase() !== "unknown")
}

function inheritDocumentCanBusProfile(
  local: DtpProtocolBusContext | undefined,
  profiles: DtpProtocolBusProfile[],
): DtpProtocolBusContext | undefined {
  if (!local || local.bus_type !== "CAN" || !profiles.length) return local

  const compatible = profiles.filter((profile) => {
    if (
      local.interface_level &&
      local.interface_level !== "unknown" &&
      (!profile.interface_level || profile.interface_level === "unknown")
    ) return false
    if (
      local.interface_id &&
      profile.interface_id &&
      local.interface_id.toUpperCase() !== profile.interface_id.toUpperCase()
    ) return false
    if (
      local.interface_level &&
      local.interface_level !== "unknown" &&
      profile.interface_level &&
      profile.interface_level !== "unknown" &&
      local.interface_level !== profile.interface_level
    ) return false
    if (
      hasKnownBusValue(local.controller_family) &&
      profile.controller_family !== local.controller_family
    ) return false
    if (
      hasKnownBusValue(local.controller) &&
      profile.controller !== local.controller &&
      profile.controller_family !== local.controller_family
    ) return false
    if (hasKnownBusValue(local.mode) && profile.mode !== local.mode) return false
    return true
  })

  if (compatible.length !== 1) {
    const message = compatible.length > 1
      ? `Multiple document-level CAN bus profiles match this section (${compatible
        .map((profile) => `${profile.controller}/${profile.mode}`)
        .join(", ")}); controller and mode were not inherited.`
      : "Document-level CAN bus profiles conflict with the explicit section bus context; section values were kept."
    return {
      ...local,
      warnings: uniqueStrings([...(local.warnings ?? []), message]),
    }
  }

  const inherited = compatible[0]
  const controller = hasKnownBusValue(local.controller) ? local.controller : inherited.controller
  const controllerFamily = hasKnownBusValue(local.controller_family)
    ? local.controller_family
    : inherited.controller_family
  const mode = hasKnownBusValue(local.mode) ? local.mode : inherited.mode
  const shouldDeriveFrameInformation = controllerFamily === "SJA1000" && mode === "PeliCAN"

  return {
    ...local,
    interface_level: local.interface_level ?? inherited.interface_level,
    interface_id: local.interface_id ?? inherited.interface_id,
    interface_name: local.interface_name ?? inherited.interface_name,
    profile_scope: "interface",
    controller,
    controller_family: controllerFamily,
    mode,
    frame_information: local.frame_information ?? (shouldDeriveFrameInformation
      ? {
          apply_to_case_data: true,
          strategy: "derive_from_ff_rtr_dlc",
        }
      : undefined),
    evidence: uniqueStrings([
      ...(local.evidence ?? []),
      ...inherited.evidence.map((evidence) => `Document bus profile: ${evidence}`),
    ]),
    confidence: Math.max(local.confidence ?? 0, inherited.confidence),
  }
}

function inferProtocolBusContext(
  context: DtpProtocolContextPackage,
  frameTable: SectionProtocolRelationTableInput,
): DtpProtocolBusContext | undefined {
  const frameText = [
    frameTable.caption,
    frameTable.table_html,
    ...frameTable.rows.flat(),
  ].filter(Boolean).join(" ")
  const localSectionText = [
    ...(context.section_path ?? []),
    context.section_title,
    context.interface_context_text,
  ].filter(Boolean).join(" ")
  const sectionText = [
    localSectionText,
    context.section_text,
    context.flow_blocks.input.text,
    context.flow_blocks.output.text,
    frameText,
  ].join(" ")
  const hasCanFrameStructure = isCanFrameTableInput(frameTable)
  const isSpi = isSpiFrameTableInput(frameTable) || (
    /\bSPI\b/i.test(sectionText) &&
    /\bADDRESS\b/i.test(frameText) &&
    /\bLENGTH\b/i.test(frameText)
  )
  if (isSpi) {
    const interfaceId = sectionText.match(/IF-SPI\d+(?:-\d+)?/i)?.[0]?.toUpperCase()
    return {
      bus_type: "SPI",
      interface_id: interfaceId,
      interface_name: "SPI\u603b\u7ebf\u63a5\u53e3",
      profile_scope: "interface",
      controller: /FPGA/i.test(sectionText) ? "FPGA" : "unknown",
      frame_buffer_layout: "business-payload",
      evidence: uniqueStrings([
        interfaceId ?? "",
        frameTable.caption ?? frameTable.id,
        /FPGA/i.test(sectionText) ? "FPGA SPI" : "SPI",
      ]),
      confidence: isSpiFrameTableInput(frameTable) ? 0.98 : 0.85,
    }
  }
  const isReferencedPayloadLayout = context.referenced_primary_table_ids?.includes(frameTable.id) ?? false
  const isSpaceWire = isSpaceWireBlockTableInput(frameTable) || (
    (!hasCanFrameStructure || isReferencedPayloadLayout) && /Space\s*wire/i.test(localSectionText)
  )
  if (isSpaceWire) {
    return {
      bus_type: "SpaceWire",
      interface_id: sectionText.match(/IF-Space\s*wire-\d+/i)?.[0],
      interface_name: "SpaceWire\u603b\u7ebf\u63a5\u53e3",
      profile_scope: "interface",
      controller: /FPGA/i.test(sectionText) ? "FPGA" : "unknown",
      frame_buffer_layout: "business-payload",
      evidence: uniqueStrings([
        frameTable.caption ?? frameTable.id,
        isReferencedPayloadLayout ? "explicit-reference-layout" : "",
        /FPGA/i.test(sectionText) ? "FPGA" : "",
      ]),
      confidence: isSpaceWireBlockTableInput(frameTable) ? 0.98 : 0.8,
    }
  }
  const isCan = hasCanFrameStructure ||
    /(?:\bCAN[A-Z]?\b|SJA1000|PeliCAN|BasicCAN|\u4ef2\u88c1\u573a|\u63a7\u5236\u573a|DLC|RTR)/i.test(`${localSectionText} ${frameText}`)
  if (!isCan) return undefined

  const controller = /SJA1000T/i.test(sectionText)
    ? "SJA1000T"
    : /SJA1000/i.test(sectionText)
      ? "SJA1000"
      : "unknown"
  const controllerFamily = /SJA1000T?/i.test(controller) ? "SJA1000" : "unknown"
  const mode = /PeliCAN/i.test(sectionText)
    ? "PeliCAN"
    : /BasicCAN/i.test(sectionText)
      ? "BasicCAN"
      : "unknown"
  const isFrameBuffer = /(?:frame\s*buffer|\u5e27\u7f13\u51b2|\u62a5\u6587\u7f13\u51b2|\u53d1\u9001\u7f13\u51b2|\u63a5\u6536\u7f13\u51b2|CAN\u63a7\u5236\u5668)/i.test(sectionText)
  const looksLikeBusinessPayload = /(?:TITLE|SUM|\bW\d+\b|\u6570\u636e\u5305|\u6307\u4ee4\u683c\u5f0f|\u4f20\u9001\u683c\u5f0f)/i.test(frameText)
  const frameBufferLayout: DtpProtocolBusContext["frame_buffer_layout"] =
    controllerFamily === "SJA1000" && mode === "PeliCAN" && isFrameBuffer && !looksLikeBusinessPayload
      ? "sja1000-pelican"
      : controllerFamily === "SJA1000" && mode === "BasicCAN" && isFrameBuffer && !looksLikeBusinessPayload
        ? "sja1000-basiccan"
        : looksLikeBusinessPayload
          ? "business-payload"
          : "unknown"
  const interfaceIdentity = inferContextCanInterfaceIdentity(context)
  const scopedController = interfaceIdentity.interfaceLevel === "secondary" && /FPGA/i.test(sectionText)
    ? "FPGA"
    : controller

  const localContext: DtpProtocolBusContext = {
    bus_type: "CAN",
    interface_level: interfaceIdentity.interfaceLevel,
    interface_id: interfaceIdentity.interfaceId,
    interface_name: interfaceIdentity.interfaceName,
    profile_scope: interfaceIdentity.interfaceLevel === "unknown" ? "section" : "interface",
    controller: scopedController,
    mode,
    frame_format: /(?:extended|\u6269\u5c55\u5e27|29\s*bit|ID\s*28.*ID\s*0)/i.test(sectionText)
      ? "extended"
      : /(?:standard\s+frame|\u6807\u51c6\u5e27|11\s*bit|ID\s*10.*ID\s*0)/i.test(sectionText)
        ? "standard"
        : "unknown",
    controller_family: controllerFamily,
    frame_buffer_layout: frameBufferLayout,
    frame_information: controllerFamily === "SJA1000" && mode === "PeliCAN"
      ? {
          apply_to_case_data: true,
          strategy: "derive_from_ff_rtr_dlc",
        }
      : undefined,
    evidence: uniqueStrings([
      frameTable.caption ?? frameTable.id,
      ...(controllerFamily === "SJA1000" ? [controller] : []),
      ...(mode !== "unknown" ? [mode] : []),
      ...(isFrameBuffer ? ["frame-buffer-context"] : []),
    ]),
    confidence: controllerFamily === "SJA1000" && mode !== "unknown" ? 0.82 : 0.62,
    warnings: frameBufferLayout === "business-payload" && controllerFamily === "SJA1000" && mode === "PeliCAN"
      ? ["SJA1000/PeliCAN is mentioned, but this protocol looks like a business payload; project-level frame-buffer bytes are not applied."]
      : [],
  }
  return inheritDocumentCanBusProfile(localContext, context.bus_profiles)
}

function sanitizeProtocolFieldOption(raw: unknown): DtpProtocolFieldOption | null {
  if (!isRecord(raw)) return null
  const value = normalizeHexByte(asString(raw.value))
  const label = asString(raw.label)
  if (!value || !label) return null
  return {
    value,
    label: sanitizeReadableFileBaseName(label) || label,
    source: asString(raw.source),
  }
}

function sanitizeProtocolField(raw: unknown, tableIds: Set<string>): DtpProtocolFieldDefinition | null {
  if (!isRecord(raw)) return null
  const name = asString(raw.name)?.toUpperCase()
  if (!name || !/^(?:(?:W|DATA)\d+|ADDRESS|STATION_ADDRESS|MESSAGE_TYPE|LENGTH)$/.test(name)) return null
  const rawType = asString(raw.type)
  const type: DtpProtocolFieldDefinition["type"] =
    rawType === "fixed" || rawType === "enum" || rawType === "bitfield" || rawType === "unknown"
      ? rawType
      : "unknown"
  const sourceTableId = asString(raw.source_table_id)
  const options = getNestedArray(raw, ["options"])
    .map(sanitizeProtocolFieldOption)
    .filter((item): item is DtpProtocolFieldOption => Boolean(item))
  return {
    name,
    type,
    value: normalizeHexByte(asString(raw.value)),
    options: options.length ? options : undefined,
    source: asString(raw.source),
    source_table_id: sourceTableId && tableIds.has(sourceTableId) ? sourceTableId : undefined,
    source_text: asString(raw.source_text),
    confidence: Math.max(0, Math.min(1, asNumber(raw.confidence) ?? 0.5)),
    warnings: getNestedArray(raw, ["warnings"])
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item)),
  }
}

function sanitizeProtocolVariant(raw: unknown, tableIds: Set<string>): DtpProtocolVariantDefinition | null {
  if (!isRecord(raw)) return null
  const name = cleanGeneratedDataFileBaseName(asString(raw.name))
  const fields = getNestedArray(raw, ["fields"])
    .map((item) => sanitizeProtocolField(item, tableIds))
    .filter((item): item is DtpProtocolFieldDefinition => Boolean(item))
  if (!name || !fields.length) return null

  return {
    name,
    fields,
    evidence: uniqueStrings(
      getNestedArray(raw, ["evidence"])
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item)),
    ),
    warnings: getNestedArray(raw, ["warnings"])
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item)),
    confidence: Math.max(0, Math.min(1, asNumber(raw.confidence) ?? 0.75)),
  }
}

function sanitizeModelProtocolDefinitions(
  context: DtpProtocolContextPackage,
  rawUnderstanding: unknown,
): {
  protocols: DtpProtocolDefinition[]
  selectorRelations: DtpProtocolSelectorRelation[]
  nonGeneratedTables: DtpNonGeneratedTable[]
  warnings: string[]
} {
  if (!isRecord(rawUnderstanding)) return { protocols: [], selectorRelations: [], nonGeneratedTables: [], warnings: [] }

  const tableIds = new Set(context.tables.map((table) => table.id))
  const protocols: DtpProtocolDefinition[] = []
  const protocolVariables = protocolVariablesFromContext(context)
  for (const rawProtocol of getNestedArray(rawUnderstanding, ["protocols"])) {
    if (!isRecord(rawProtocol)) continue
    const rawFrames = getNestedArray(rawProtocol, ["frames"])
      .filter((item): item is Record<string, unknown> => isRecord(item))
    const frame: Record<string, unknown> = rawFrames[0] ?? (isRecord(rawProtocol.frame) ? rawProtocol.frame : {})
    const frameTableId = asString(frame.source_table_id)
    if (!frameTableId || !tableIds.has(frameTableId)) continue

    const rawFlowDirection = asString(rawProtocol.flow_direction)
    let flowDirection: DtpProtocolDefinition["flow_direction"] =
      rawFlowDirection === "input" || rawFlowDirection === "output" || rawFlowDirection === "unknown"
        ? rawFlowDirection
        : "unknown"
    const rawGenerationMode = asString(rawProtocol.generation_mode)
    const generationMode: DtpProtocolDefinition["generation_mode"] =
      rawGenerationMode === "single_file" ||
      rawGenerationMode === "expand_variants" ||
      rawGenerationMode === "one_file_per_dictionary_row" ||
      rawGenerationMode === "skip"
        ? rawGenerationMode
        : "single_file"
    const rawBaseFileName = asString(rawProtocol.base_file_name)
    let baseFileName = cleanGeneratedDataFileBaseName(rawBaseFileName ?? frameTableId)
    let protocolAliases: string[] = []
    const rawByteLayout = getNestedArray(frame, ["byte_layout"])
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item))
    const byteLayout = normalizeFrameByteLayoutTokens(rawByteLayout)
    const rawByteLayouts = rawFrames.length
      ? rawFrames.map((item) => getNestedArray(item, ["byte_layout"]))
      : getNestedArray(frame, ["byte_layouts"])
    const byteLayouts = normalizeFrameByteLayouts(rawByteLayouts)
    const frameTable = context.tables.find((table) => table.id === frameTableId)
    if (frameTable) {
      const inferredIdentity = inferTableProtocolIdentity(context, frameTable)
      const identity = preferredProtocolIdentity(rawBaseFileName, inferredIdentity.baseName)
      baseFileName = identity.baseName
      protocolAliases = uniqueStrings([
        ...identity.aliases,
        frameTable.caption,
        ...rawFrames.map((item) => asString(item.frame_id)),
      ].filter((item): item is string => Boolean(item && normalizeLookupText(item) !== normalizeLookupText(baseFileName))))
      if (flowDirection === "unknown") flowDirection = inferredIdentity.flowDirection
    }
    const fallbackByteLayouts = frameByteLayoutsFromTableInput(frameTable)
    const modelByteLayouts = byteLayouts.length ? byteLayouts : byteLayout.length ? [byteLayout] : []
    const layoutCompleteness = (layouts: string[][]): number => layouts.length * 1000 + layouts.flat().length
    const useFallbackByteLayouts = fallbackByteLayouts.length > 0 &&
      (
        hasAuthoritativeCanDlcLayout(frameTable) ||
        layoutCompleteness(fallbackByteLayouts) >= layoutCompleteness(modelByteLayouts)
      )
    const selectedByteLayouts = useFallbackByteLayouts
      ? fallbackByteLayouts
      : modelByteLayouts
    const multiByteLayouts = selectedByteLayouts
    const modelBusContext = reconcileModelBusContextWithTableEvidence(
      context,
      frameTable,
      applyContextBusInterfaceScope(context, sanitizeProtocolBusContext(rawProtocol.bus_context)),
    )
    const busContext = modelBusContext
      ? inheritDocumentCanBusProfile(modelBusContext, context.bus_profiles)
      : frameTable
        ? inferProtocolBusContext(context, frameTable)
        : undefined
    const frameEnvelopeInference = inferProtocolFrameEnvelope(context, busContext, rawProtocol.frame_envelope)
    const fields = getNestedArray(rawProtocol, ["fields"])
      .map((item) => sanitizeProtocolField(item, tableIds))
      .filter((item): item is DtpProtocolFieldDefinition => Boolean(item))
      .map((field) => enrichDictionaryEnumLabelsFromTable(field, context))
    const variants = getNestedArray(rawProtocol, ["variants"])
      .map((item) => sanitizeProtocolVariant(item, tableIds))
      .filter((item): item is DtpProtocolVariantDefinition => Boolean(item))
    const tableFieldLayouts = frameFieldLayoutsFromTableInput(frameTable, multiByteLayouts, fields)
      .map((layout) => frameTable && isSpiFrameTableInput(frameTable)
        ? enrichSpiAddressBitFields(layout, context, frameTable)
        : layout)
    const layoutWarnings: string[] = []

    protocols.push({
      protocol_id: asString(rawProtocol.protocol_id) ?? `${context.section_model_id}-${protocols.length + 1}`,
      source_section: asString(rawProtocol.source_section) ?? context.section_title,
      flow_direction: flowDirection,
      base_file_name: baseFileName,
      aliases: protocolAliases.length ? protocolAliases : undefined,
      generation_mode: generationMode,
      frames: multiByteLayouts.map((layout, index) => {
        const rawFrame = rawFrames[index] ?? frame
        return {
          frame_id: asString(rawFrame.frame_id) ?? `frame-${index + 1}`,
          sequence: Math.max(1, Math.floor(asNumber(rawFrame.sequence) ?? index + 1)),
          source_table_id: asString(rawFrame.source_table_id) ?? frameTableId,
          byte_layout: layout,
          field_layout: mergeModelSemanticsIntoTableFieldLayout(
            rawFrame.field_layout,
            tableFieldLayouts[index] ?? [],
            layout,
            fields,
            layoutWarnings,
            `${baseFileName}/${asString(rawFrame.frame_id) ?? `frame-${index + 1}`}`,
          ),
          checksum: frameTable && isSpiFrameTableInput(frameTable)
            ? checksumDefinitionForFrameTable(
                frameTable,
                normalizeProtocolChecksum(rawFrame.checksum)?.expression ?? normalizeProtocolChecksum(frame.checksum)?.expression,
              )
            : normalizeProtocolChecksum(rawFrame.checksum) ?? normalizeProtocolChecksum(frame.checksum),
        }
      }),
      bus_context: busContext,
      variables: protocolVariables.length ? protocolVariables : undefined,
      frame_envelope: frameEnvelopeInference.envelope,
      fields,
      variants: variants.length ? variants : undefined,
      evidence: uniqueStrings(
        getNestedArray(rawProtocol, ["evidence"])
          .map((item) => asString(item))
          .filter((item): item is string => Boolean(item)),
      ),
      warnings: getNestedArray(rawProtocol, ["warnings"])
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item))
        .concat(layoutWarnings, frameEnvelopeInference.warnings),
      confidence: Math.max(0, Math.min(1, asNumber(rawProtocol.confidence) ?? 0.75)),
      understanding_source: "model",
    })
  }

  const nonGeneratedTables = getNestedArray(rawUnderstanding, ["non_generated_tables"])
    .map((raw): DtpNonGeneratedTable | null => {
      if (!isRecord(raw)) return null
      const tableId = asString(raw.table_id)
      if (!tableId || !tableIds.has(tableId)) return null
      return {
        table_id: tableId,
        reason: asString(raw.reason) ?? "Model marked this table as non-generated.",
      }
    })
    .filter((item): item is DtpNonGeneratedTable => Boolean(item))
  const warnings = getNestedArray(rawUnderstanding, ["warnings"])
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item))

  return {
    protocols,
    selectorRelations: sanitizeModelProtocolSelectorRelations(context, protocols, rawUnderstanding),
    nonGeneratedTables,
    warnings,
  }
}

function sanitizeModelEvidenceRequests(
  context: DtpProtocolContextPackage,
  rawUnderstanding: unknown,
): DtpModelEvidenceRequest[] {
  if (!isRecord(rawUnderstanding) || asString(rawUnderstanding.status) !== "need_more_evidence") return []
  const tableIds = new Set(context.tables.map((table) => table.id))
  return getNestedArray(rawUnderstanding, ["requests"])
    .map((raw): DtpModelEvidenceRequest | null => {
      if (!isRecord(raw)) return null
      const tableId = asString(raw.table_id)
      if (!tableId || !tableIds.has(tableId)) return null
      return {
        table_id: tableId,
        row_keys: uniqueStrings(getNestedArray(raw, ["row_keys"])
          .map((item) => asString(item))
          .filter((item): item is string => Boolean(item))),
        fields: uniqueStrings(getNestedArray(raw, ["fields"])
          .map((item) => asString(item))
          .filter((item): item is string => Boolean(item))),
      }
    })
    .filter((item): item is DtpModelEvidenceRequest => Boolean(item))
}

function mergeRawProtocolUnderstandings(primary: unknown, supplemental: unknown): unknown {
  if (!isRecord(primary)) return supplemental
  if (!isRecord(supplemental)) return primary
  return {
    protocols: [...getNestedArray(primary, ["protocols"]), ...getNestedArray(supplemental, ["protocols"])],
    selector_relations: [
      ...getNestedArray(primary, ["selector_relations"]),
      ...getNestedArray(supplemental, ["selector_relations"]),
    ],
    non_generated_tables: [
      ...getNestedArray(primary, ["non_generated_tables"]),
      ...getNestedArray(supplemental, ["non_generated_tables"]),
    ],
    warnings: [...getNestedArray(primary, ["warnings"]), ...getNestedArray(supplemental, ["warnings"])],
  }
}

function collectKnownProtocolTableIds(definitions: DtpProtocolDefinitionsDocument): Set<string> {
  const tableIds = new Set<string>()
  for (const protocol of definitions.protocols) {
    for (const frame of getDtpProtocolFrames(protocol)) {
      if (frame.source_table_id) tableIds.add(frame.source_table_id)
    }
    for (const field of protocol.fields) {
      if (field.source_table_id) tableIds.add(field.source_table_id)
    }
    for (const variant of protocol.variants ?? []) {
      for (const field of variant.fields) {
        if (field.source_table_id) tableIds.add(field.source_table_id)
      }
    }
  }
  for (const item of definitions.non_generated_tables) {
    if (item.table_id) tableIds.add(item.table_id)
  }
  return tableIds
}

function sanitizeRetryProtocolPatch(
  rawProtocol: unknown,
  existing: DtpProtocolDefinition,
  tableIds: Set<string>,
): DtpProtocolDefinition | null {
  if (!isRecord(rawProtocol)) return null
  const rawFrames = getNestedArray(rawProtocol, ["frames"])
    .filter((item): item is Record<string, unknown> => isRecord(item))
  const frame = rawFrames[0] ?? (isRecord(rawProtocol.frame) ? rawProtocol.frame : {})
  const rawFlowDirection = asString(rawProtocol.flow_direction)
  const flowDirection: DtpProtocolDefinition["flow_direction"] =
    rawFlowDirection === "input" || rawFlowDirection === "output" || rawFlowDirection === "unknown"
      ? rawFlowDirection
      : existing.flow_direction
  const rawGenerationMode = asString(rawProtocol.generation_mode)
  const generationMode: DtpProtocolDefinition["generation_mode"] =
    rawGenerationMode === "single_file" ||
    rawGenerationMode === "expand_variants" ||
    rawGenerationMode === "one_file_per_dictionary_row" ||
    rawGenerationMode === "skip"
      ? rawGenerationMode
      : existing.generation_mode
  const frameTableId = asString(frame.source_table_id)
  const rawByteLayout = getNestedArray(frame, ["byte_layout"])
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item))
  const byteLayout = normalizeFrameByteLayoutTokens(rawByteLayout)
  const byteLayouts = normalizeFrameByteLayouts(
    rawFrames.length
      ? rawFrames.map((item) => getNestedArray(item, ["byte_layout"]))
      : getNestedArray(frame, ["byte_layouts"]),
  )
  const fields = getNestedArray(rawProtocol, ["fields"])
    .map((item) => sanitizeProtocolField(item, tableIds))
    .filter((item): item is DtpProtocolFieldDefinition => Boolean(item))
  const variants = getNestedArray(rawProtocol, ["variants"])
    .map((item) => sanitizeProtocolVariant(item, tableIds))
    .filter((item): item is DtpProtocolVariantDefinition => Boolean(item))
  const busContext = sanitizeProtocolBusContext(rawProtocol.bus_context)
  const evidence = getNestedArray(rawProtocol, ["evidence"])
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item))
  const warnings = getNestedArray(rawProtocol, ["warnings"])
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item))

  const existingFrames = getDtpProtocolFrames(existing)
  const existingPrimaryFrame = existingFrames[0]
  const selectedFrameTableId = frameTableId && tableIds.has(frameTableId)
    ? frameTableId
    : existingPrimaryFrame?.source_table_id ?? ""
  const requestedLayouts = byteLayouts.length
    ? byteLayouts
    : byteLayout.length
      ? [byteLayout]
      : []
  const frameCount = Math.max(existingFrames.length, requestedLayouts.length)
  const selectedLayouts = Array.from({ length: frameCount }, (_, index) => {
    const existingFrame = existingFrames[index]
    if (hasTableAuthoritativeFieldLayout(existingFrame)) return existingFrame.byte_layout
    return requestedLayouts[index] ?? existingFrame?.byte_layout ?? []
  }).filter((layout) => layout.length > 0)
  const selectedFields = fields.length ? fields : existing.fields
  const selectedChecksum = normalizeProtocolChecksum(frame.checksum) ?? existingPrimaryFrame?.checksum
  const { frame: _legacyFrame, ...existingV2 } = existing
  const retryIdentity = preferredProtocolIdentity(asString(rawProtocol.base_file_name), existing.base_file_name)

  return {
    ...existingV2,
    source_section: asString(rawProtocol.source_section) ?? existing.source_section,
    flow_direction: flowDirection,
    base_file_name: retryIdentity.baseName,
    aliases: uniqueStrings([
      ...(existing.aliases ?? []),
      existing.base_file_name,
      ...retryIdentity.aliases,
      asString(rawProtocol.base_file_name),
      ...getNestedArray(rawProtocol, ["aliases"]).map((item) => asString(item)),
    ].filter((item): item is string => Boolean(item && normalizeLookupText(item) !== normalizeLookupText(retryIdentity.baseName)))),
    generation_mode: generationMode,
    frames: selectedLayouts.map((layout, index) => ({
      frame_id: asString(rawFrames[index]?.frame_id) ?? existingFrames[index]?.frame_id ?? `frame-${index + 1}`,
      sequence: Math.max(1, Math.floor(asNumber(rawFrames[index]?.sequence) ?? existingFrames[index]?.sequence ?? index + 1)),
      source_table_id: asString(rawFrames[index]?.source_table_id) ?? selectedFrameTableId,
      byte_layout: layout,
      field_layout: hasTableAuthoritativeFieldLayout(existingFrames[index])
        ? mergeModelSemanticsIntoTableFieldLayout(
          rawFrames[index]?.field_layout,
          existingFrames[index]?.field_layout ?? [],
          layout,
          selectedFields,
        )
        : normalizeFieldLayout(
          rawFrames[index]?.field_layout ?? existingFrames[index]?.field_layout,
          layout,
          selectedFields,
        ),
      checksum: normalizeProtocolChecksum(rawFrames[index]?.checksum) ?? selectedChecksum,
    })),
    bus_context: busContext ?? existing.bus_context,
    fields: selectedFields,
    variants: variants.length ? variants : existing.variants,
    evidence: uniqueStrings([...existing.evidence, ...evidence, "model-retry-context"]),
    warnings: uniqueStrings([...existing.warnings, ...warnings]),
    confidence: Math.max(0, Math.min(1, asNumber(rawProtocol.confidence) ?? existing.confidence)),
    understanding_source: "model",
  }
}

export function mergeDtpProtocolDefinitionPatch(
  definitions: DtpProtocolDefinitionsDocument,
  rawPatch: unknown,
): {
  definitions: DtpProtocolDefinitionsDocument
  changed_protocol_ids: string[]
  warnings: string[]
} {
  if (!isRecord(rawPatch)) {
    return {
      definitions,
      changed_protocol_ids: [],
      warnings: ["Model retry response was not a JSON object."],
    }
  }

  const tableIds = collectKnownProtocolTableIds(definitions)
  const protocolsById = new Map(definitions.protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const patchesById = new Map<string, DtpProtocolDefinition>()
  const warnings = getNestedArray(rawPatch, ["warnings"])
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item))

  for (const rawProtocol of getNestedArray(rawPatch, ["protocols"])) {
    if (!isRecord(rawProtocol)) continue
    const protocolId = asString(rawProtocol.protocol_id)
    if (!protocolId) {
      warnings.push("Model retry protocol patch was ignored because protocol_id is missing.")
      continue
    }
    const existing = protocolsById.get(protocolId)
    if (!existing) {
      warnings.push(`Model retry protocol patch ${protocolId} was ignored because it does not match an existing protocol.`)
      continue
    }
    const sanitized = sanitizeRetryProtocolPatch(rawProtocol, existing, tableIds)
    if (!sanitized) {
      warnings.push(`Model retry protocol patch ${protocolId} was ignored because it is invalid.`)
      continue
    }
    patchesById.set(protocolId, sanitized)
  }

  if (!patchesById.size) {
    return {
      definitions,
      changed_protocol_ids: [],
      warnings: warnings.length ? warnings : ["Model retry response did not contain any valid protocol patch."],
    }
  }

  const changedProtocolIds = Array.from(patchesById.keys())
  return {
    definitions: {
      ...definitions,
      source: definitions.source === "heuristic-fallback" ? "mixed" : definitions.source,
      protocols: definitions.protocols.map((protocol) => patchesById.get(protocol.protocol_id) ?? protocol),
      warnings: uniqueStrings([
        ...definitions.warnings,
        ...warnings,
        `Model retry updated protocol definitions: ${changedProtocolIds.join(", ")}`,
      ]),
      updated_at: new Date().toISOString(),
    },
    changed_protocol_ids: changedProtocolIds,
    warnings,
  }
}

function mergeNonGeneratedTables(items: DtpNonGeneratedTable[]): DtpNonGeneratedTable[] {
  const merged = new Map<string, DtpNonGeneratedTable>()
  for (const item of items) {
    const key = `${item.table_id}\u0000${item.reason}`
    if (!merged.has(key)) merged.set(key, item)
  }
  return Array.from(merged.values())
}

function protocolSourceTableIds(protocol: DtpProtocolDefinition): Set<string> {
  return new Set(getDtpProtocolFrames(protocol)
    .map((frame) => frame.source_table_id)
    .filter(Boolean))
}

function mergeMissingTableProtocols(
  context: DtpProtocolContextPackage,
  understood: {
    protocols: DtpProtocolDefinition[]
    selectorRelations: DtpProtocolSelectorRelation[]
    nonGeneratedTables: DtpNonGeneratedTable[]
    warnings: string[]
  },
): typeof understood {
  const fallback = buildHeuristicProtocolDefinitionsForContext(context)
  if (!fallback.protocols.length) return understood

  const coveredTableIds = new Set(understood.protocols.flatMap((protocol) => [...protocolSourceTableIds(protocol)]))
  const protocolIds = new Set(understood.protocols.map((protocol) => protocol.protocol_id))
  const supplements = fallback.protocols
    .filter((protocol) => [...protocolSourceTableIds(protocol)].some((tableId) => !coveredTableIds.has(tableId)))
    .map((protocol) => {
      if (!protocolIds.has(protocol.protocol_id)) {
        protocolIds.add(protocol.protocol_id)
        return protocol
      }
      const tableSuffix = [...protocolSourceTableIds(protocol)][0]?.replace(/[^A-Za-z0-9]+/g, "-") ?? "fallback"
      let protocolId = `${protocol.protocol_id}-${tableSuffix}`
      let suffix = 2
      while (protocolIds.has(protocolId)) {
        protocolId = `${protocol.protocol_id}-${tableSuffix}-${suffix}`
        suffix += 1
      }
      protocolIds.add(protocolId)
      return { ...protocol, protocol_id: protocolId }
    })

  if (!supplements.length) return understood
  const supplementedTableIds = new Set(supplements.flatMap((protocol) => [...protocolSourceTableIds(protocol)]))
  return {
    protocols: [...understood.protocols, ...supplements],
    selectorRelations: understood.selectorRelations,
    nonGeneratedTables: mergeNonGeneratedTables([
      ...understood.nonGeneratedTables.filter((item) => !supplementedTableIds.has(item.table_id)),
      ...fallback.nonGeneratedTables.filter((item) => !supplementedTableIds.has(item.table_id)),
    ]),
    warnings: uniqueStrings([
      ...understood.warnings,
      `Deterministic table extraction supplemented ${supplements.length} protocol(s) omitted by model understanding.`,
    ]),
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function spiFallbackNeedsTargetedRetry(
  context: DtpProtocolContextPackage,
  fallback: ReturnType<typeof buildHeuristicProtocolDefinitionsForContext>,
): boolean {
  const spiTableIds = new Set(context.tables.filter(isSpiFrameTableInput).map((table) => table.id))
  if (!spiTableIds.size) return false
  return [...spiTableIds].some((tableId) => {
    const protocol = fallback.protocols.find((item) => getDtpProtocolFrames(item)
      .some((frame) => frame.source_table_id === tableId))
    if (!protocol || protocol.bus_context?.bus_type !== "SPI") return true
    if (!usablePreferredProtocolName(protocol.base_file_name) || protocol.flow_direction === "unknown") return true
    const frames = getDtpProtocolFrames(protocol)
    if (!frames.length) return true
    return frames.some((frame) => {
      const names = new Set(frame.field_layout.map((field) => field.name.toUpperCase()))
      return !frame.byte_layout.length ||
        !names.has("ADDRESS") ||
        !names.has("LENGTH") ||
        ![...names].some((name) => /^DATA\d+$/.test(name)) ||
        !names.has("SUM")
    })
  })
}

function compactSpiProtocolRetryContext(context: DtpProtocolContextPackage): DtpProtocolContextPackage {
  const spiTableIds = new Set(context.tables.filter(isSpiFrameTableInput).map((table) => table.id))
  const relatedTableIds = new Set([...spiTableIds, ...context.support_table_ids])
  const compactText = [
    context.flow_blocks.input.text,
    context.flow_blocks.output.text,
    ...context.tables.filter((table) => spiTableIds.has(table.id)).map((table) => table.caption ?? table.id),
  ].filter(Boolean).join("\n\n").slice(0, 6_000)
  return {
    ...context,
    interface_context_text: undefined,
    section_text: compactText,
    tables: context.tables
      .filter((table) => relatedTableIds.has(table.id))
      .map((table) => ({
        ...table,
        rows: table.table_html ? [] : table.rows,
        cells: table.table_html ? undefined : table.cells,
      })),
    primary_table_ids: context.primary_table_ids.filter((tableId) => spiTableIds.has(tableId)),
    support_table_ids: context.support_table_ids.filter((tableId) => relatedTableIds.has(tableId)),
    heuristic_relations: context.heuristic_relations.filter((relation) => spiTableIds.has(relation.frame_table_id)),
    bus_profiles: [],
  }
}

export function writeDtpProtocolDefinitions(definitionsFile: string, definitions: DtpProtocolDefinitionsDocument): void {
  ensureDirectory(dirname(definitionsFile))
  const normalized = migrateDtpProtocolDefinitionsDocument(definitions)
  writeFileSync(definitionsFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8")
}

export async function buildDtpProtocolDefinitionsDocument(
  paths: DefaultPaths,
  knowledgeIndex: ProjectKnowledgeIndex,
  modelHooks?: DtpDataModelHooks | null,
): Promise<DtpProtocolDefinitionsDocument> {
  const understand = modelHooks?.understandSectionProtocols
  const contexts = buildDtpProtocolContextPackages(knowledgeIndex)
  const relatedDocumentIds = buildResolvedDocumentReferenceScopes(knowledgeIndex)
  const protocols: DtpProtocolDefinition[] = []
  const selectorRelations: DtpProtocolSelectorRelation[] = []
  const nonGeneratedTables: DtpNonGeneratedTable[] = []
  const sections: DtpProtocolDefinitionsDocument["sections"] = []
  const warnings: string[] = []
  let modelProtocolCount = 0
  let fallbackProtocolCount = 0

  const contextResults = await mapWithConcurrency(
    contexts,
    getDtpModelSectionConcurrency(),
    async (context) => {
    let sectionUnderstanding: {
      protocols: DtpProtocolDefinition[]
      selectorRelations: DtpProtocolSelectorRelation[]
      nonGeneratedTables: DtpNonGeneratedTable[]
      warnings: string[]
    } | null = null
    const localWarnings: string[] = []

    if (understand && !context.reference_backed) {
      const modelContexts = prepareProtocolUnderstandingContexts(context)
      const modelParts: Array<{
        protocols: DtpProtocolDefinition[]
        selectorRelations: DtpProtocolSelectorRelation[]
        nonGeneratedTables: DtpNonGeneratedTable[]
        warnings: string[]
      }> = []
      for (const modelContext of modelContexts) {
        try {
          const timeoutMs = protocolUnderstandingTimeoutMs(modelContext)
          modelContext.model_timeout_ms = timeoutMs
          if (modelContext.model_input_metrics) modelContext.model_input_metrics.applied_timeout_ms = timeoutMs
          const runUnderstand = () =>
            withTimeout(
              understand(modelContext),
              timeoutMs,
              `Model protocol definition understanding timed out after ${timeoutMs}ms`,
            )
          let rawUnderstanding = modelHooks?.performance
            ? await modelHooks.performance.measureModelCall("model_protocol_understanding", modelContext, runUnderstand)
            : await runUnderstand()
          const evidenceRequests = sanitizeModelEvidenceRequests(context, rawUnderstanding)
          const supplementalContext = evidenceRequests.length
            ? prepareRequestedProtocolEvidenceContext(context, evidenceRequests)
            : null
          if (supplementalContext) {
            try {
              const supplementalTimeoutMs = protocolUnderstandingTimeoutMs(supplementalContext)
              supplementalContext.model_timeout_ms = supplementalTimeoutMs
              if (supplementalContext.model_input_metrics) {
                supplementalContext.model_input_metrics.applied_timeout_ms = supplementalTimeoutMs
              }
              const runSupplement = () => withTimeout(
                understand(supplementalContext),
                supplementalTimeoutMs,
                `Supplemental protocol evidence understanding timed out after ${supplementalTimeoutMs}ms`,
              )
              const supplementalUnderstanding = modelHooks?.performance
                ? await modelHooks.performance.measureModelCall(
                    "model_protocol_understanding",
                    supplementalContext,
                    runSupplement,
                  )
                : await runSupplement()
              rawUnderstanding = mergeRawProtocolUnderstandings(rawUnderstanding, supplementalUnderstanding)
            } catch (error) {
              localWarnings.push(
                `Supplemental protocol evidence failed for ${modelContext.section_title}: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
          const sanitized = sanitizeModelProtocolDefinitions(context, rawUnderstanding)
          if (sanitized.protocols.length) modelParts.push(sanitized)
          else {
            const warning = `Model protocol definition understanding returned no valid protocol for ${modelContext.section_title}; this evidence window used deterministic fallback.`
            localWarnings.push(warning)
            modelHooks?.performance?.recordFallback("model_protocol_understanding", modelContext, [warning])
          }
        } catch (error) {
          const warning = `Model protocol definition understanding failed for ${modelContext.section_title}: ${error instanceof Error ? error.message : String(error)}`
          localWarnings.push(warning)
          modelHooks?.performance?.recordFallback("model_protocol_understanding", modelContext, [warning])
        }
      }
      if (modelParts.length) {
        sectionUnderstanding = mergeMissingTableProtocols(context, {
          protocols: modelParts.flatMap((part) => part.protocols),
          selectorRelations: modelParts.flatMap((part) => part.selectorRelations),
          nonGeneratedTables: mergeNonGeneratedTables(modelParts.flatMap((part) => part.nonGeneratedTables)),
          warnings: uniqueStrings(modelParts.flatMap((part) => part.warnings)),
        })
      }
    }

    if (!sectionUnderstanding) {
      if (!understand || context.reference_backed) {
        modelHooks?.performance?.recordFallback("model_protocol_understanding", context, [
          context.reference_backed
            ? "Reference-backed protocol ownership and physical layout were compiled deterministically."
            : "Model protocol definition understanding hook was not available; heuristic fallback was used.",
        ])
      }
      const fallback = {
        ...buildHeuristicProtocolDefinitionsForContext(context),
        selectorRelations: [],
      }
      sectionUnderstanding = fallback
      if (understand && spiFallbackNeedsTargetedRetry(context, fallback)) {
        const compactContext = prepareProtocolUnderstandingContexts(compactSpiProtocolRetryContext(context))[0]
        try {
          const timeoutMs = protocolUnderstandingTimeoutMs(compactContext)
          compactContext.model_timeout_ms = timeoutMs
          if (compactContext.model_input_metrics) compactContext.model_input_metrics.applied_timeout_ms = timeoutMs
          const runUnderstand = () => withTimeout(
            understand(compactContext),
            timeoutMs,
            `Targeted SPI protocol understanding timed out after ${timeoutMs}ms`,
          )
          const rawUnderstanding = modelHooks?.performance
            ? await modelHooks.performance.measureModelCall("model_protocol_understanding", compactContext, runUnderstand)
            : await runUnderstand()
          const sanitized = sanitizeModelProtocolDefinitions(context, rawUnderstanding)
          if (sanitized.protocols.length) {
            sectionUnderstanding = mergeMissingTableProtocols(context, sanitized)
            localWarnings.push(`Targeted compact SPI protocol retry recovered ${context.section_title}.`)
          }
        } catch (error) {
          const warning = `Targeted compact SPI protocol retry failed for ${context.section_title}: ${error instanceof Error ? error.message : String(error)}`
          localWarnings.push(warning)
          modelHooks?.performance?.recordFallback("model_protocol_understanding", compactContext, [warning])
        }
      }
    }

    return {
      context,
      sectionUnderstanding,
      warnings: localWarnings,
    }
  },
  )

  for (const { context, sectionUnderstanding, warnings: localWarnings } of contextResults) {
    const spaceWireProtocol = buildSpaceWireBlockProtocolForContext(context)
    const spaceWireTableIds = new Set(spaceWireProtocol?.block_layout?.source_table_ids ?? [])
    const selectedProtocols = spaceWireProtocol
      ? [
          ...sectionUnderstanding.protocols.filter((protocol) => (
            !getDtpProtocolFrames(protocol).some((frame) => spaceWireTableIds.has(frame.source_table_id))
          )),
          spaceWireProtocol,
        ]
      : sectionUnderstanding.protocols
    for (const protocol of selectedProtocols) {
      if (protocol.understanding_source === "model") modelProtocolCount += 1
      else fallbackProtocolCount += 1
      protocols.push(protocol)
    }
    selectorRelations.push(
      ...buildDeterministicProtocolSelectorRelations(context, selectedProtocols),
      ...sectionUnderstanding.selectorRelations,
    )
    nonGeneratedTables.push(...sectionUnderstanding.nonGeneratedTables)
    warnings.push(...localWarnings)
    warnings.push(...sectionUnderstanding.warnings)
    sections.push({
      section_model_id: context.section_model_id,
      section_id: context.section_id,
      section_title: context.section_title,
      protocol_ids: selectedProtocols.map((protocol) => protocol.protocol_id),
      warnings: sectionUnderstanding.warnings,
    })
  }

  for (const relation of buildCrossContextProtocolSelectorRelations(contexts, protocols, sections, relatedDocumentIds)) {
    const selectorTableId = relation.evidence[0]
    if (selectorRelations.some((existing) => existing.evidence.includes(selectorTableId))) continue
    selectorRelations.push(relation)
  }

  const withProvenance = attachProtocolProvenance(protocols, knowledgeIndex)
  const withInterfaceEnvelopes = inheritSecondaryCanFrameEnvelopes(withProvenance, relatedDocumentIds)
  const canonicalized = canonicalizeProtocolDefinitions(withInterfaceEnvelopes)
  const remapProtocolId = (protocolId: string): string => canonicalized.remappedIds.get(protocolId) ?? protocolId
  const normalizedSections = sections.map((section) => ({
    ...section,
    protocol_ids: uniqueStrings(section.protocol_ids.map(remapProtocolId)),
  }))
  const normalizedSelectorRelations = selectorRelations.map((relation) => ({
    ...relation,
    mappings: relation.mappings.map((mapping) => ({
      ...mapping,
      target_protocol_id: remapProtocolId(mapping.target_protocol_id),
    })),
  }))
  for (const relation of buildCrossContextProtocolSelectorRelations(
    contexts,
    canonicalized.protocols,
    normalizedSections,
    relatedDocumentIds,
  )) {
    const selectorTableId = relation.evidence[0]
    if (normalizedSelectorRelations.some((existing) => existing.evidence.includes(selectorTableId))) continue
    normalizedSelectorRelations.push(relation)
  }

  const source: DtpProtocolDefinitionsDocument["source"] =
    modelProtocolCount > 0 && fallbackProtocolCount > 0
      ? "mixed"
      : modelProtocolCount > 0
        ? "model"
        : "heuristic-fallback"

  return migrateDtpProtocolDefinitionsDocument({
    schema_version: "4.0.0",
    project_root: paths.workspaceRoot,
    knowledge_index_file: paths.projectKnowledgeIndexFile,
    source,
    sections: normalizedSections,
    protocols: canonicalized.protocols,
    interface_envelopes: deriveInterfaceEnvelopeDefinitions(canonicalized.protocols),
    selector_relations: normalizedSelectorRelations,
    non_generated_tables: mergeNonGeneratedTables(nonGeneratedTables),
    warnings: uniqueStrings([...warnings, ...canonicalized.warnings]),
    updated_at: new Date().toISOString(),
  })
}
