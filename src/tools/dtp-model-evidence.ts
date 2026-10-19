import type {
  DtpModelInputMetrics,
  DtpProtocolContextPackage,
  SectionProtocolRelationModelInput,
  SectionProtocolRelationTableInput,
} from "./dtp-data-generation-core"

const ESTIMATED_TOKEN_CHARS = 2
const RELATION_TOKEN_BUDGET = 20_000
const PROTOCOL_TOKEN_BUDGET = 30_000
const FULL_TABLE_MAX_ROWS = 30
const FULL_TABLE_MAX_CELLS = 300
const FULL_TABLE_MAX_CHARS = 10_000
const MATCHED_ROW_LIMIT = 12
const PRIMARY_TABLES_PER_WINDOW = 2
const MAX_PROTOCOL_WINDOWS = 2
const SUPPORT_TABLE_LIMIT = 5
const TEXT_BUDGET_RATIO = 0.20
const TABLE_BUDGET_RATIO = 0.55
const RELATION_STATIC_PROMPT_RESERVE_CHARS = 12_000
const PROTOCOL_STATIC_PROMPT_RESERVE_CHARS = 20_000

type PrepareOptions = {
  tokenBudget: number
  tableCharBudget?: number
  queryText: string
  primaryTableIds: string[]
  supportTableIds: string[]
  referencedTableIds: string[]
  flowTableIds: string[]
}

type PreparedTableSelection = {
  tables: SectionProtocolRelationTableInput[]
  metrics: DtpModelInputMetrics
}

export type DtpModelEvidenceRequest = {
  table_id: string
  row_keys: string[]
  fields: string[]
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / ESTIMATED_TOKEN_CHARS)
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\s_\-—–:：,，。；;()（）\[\]【】<>《》]+/g, "")
    .toLowerCase()
}

function queryTokens(value: string): string[] {
  const explicit = Array.from(value.matchAll(
    /(?:TCY|TR|ID)[-_]?\d+[A-Za-z0-9_-]*|(?:表|附表)\s*[A-Za-z]?\d+(?:\.\d+)*(?:-\d+)?|W\d+|TITLE|LENGTH|SUM|CRC|ISO|SpaceWire|SPI|CAN[A-B]?|RS422|1553B/gi,
  )).map((match) => normalizeText(match[0]))
  const phrases = value
    .split(/[，。；：、,.;:()（）\[\]【】<>《》\s]+/)
    .map(normalizeText)
    .filter((item) => item.length >= 3 && item.length <= 40)
  return uniqueStrings([...explicit, ...phrases])
}

function tableCellCount(table: SectionProtocolRelationTableInput): number {
  return table.cells?.length ?? table.rows.reduce((total, row) => total + row.length, 0)
}

function tableCharCount(table: SectionProtocolRelationTableInput): number {
  return table.table_html?.length ?? safeJsonLength(table.rows)
}

function tableSearchText(table: SectionProtocolRelationTableInput): string {
  return [table.caption, ...(table.aliases ?? []), ...(table.headers ?? []), ...(table.rows ?? []).flat()]
    .filter(Boolean)
    .join(" ")
}

function tableScore(table: SectionProtocolRelationTableInput, tokens: string[]): number {
  const captionText = normalizeText([
    table.caption,
    ...(table.aliases ?? []),
    ...(table.headers ?? []),
  ].filter(Boolean).join(" "))
  const bodyText = normalizeText(tableSearchText(table))
  let score = 0
  for (const token of tokens) {
    if (captionText.includes(token)) score += 100 + Math.min(40, token.length)
    else if (bodyText.includes(token)) score += 10 + Math.min(20, token.length)
  }
  return score
}

function selectedTableIds(
  tables: SectionProtocolRelationTableInput[],
  options: PrepareOptions,
): Set<string> {
  const tableIds = new Set(tables.map((table) => table.id))
  const mandatoryIds = new Set([
    ...options.primaryTableIds,
    ...options.referencedTableIds,
    ...options.flowTableIds,
  ].filter((id) => tableIds.has(id)))
  const tokens = queryTokens(options.queryText)
  const supports = tables
    .filter((table) => !mandatoryIds.has(table.id))
    .map((table) => ({ table, score: tableScore(table, tokens) }))
    .filter(({ table, score }) => options.supportTableIds.includes(table.id) || score > 0)
    .sort((left, right) => {
      const leftSupport = options.supportTableIds.includes(left.table.id) ? 1 : 0
      const rightSupport = options.supportTableIds.includes(right.table.id) ? 1 : 0
      return rightSupport - leftSupport || right.score - left.score || left.table.ordinal - right.table.ordinal
    })
    .slice(0, SUPPORT_TABLE_LIMIT)
  return new Set([...mandatoryIds, ...supports.map(({ table }) => table.id)])
}

function selectedRows(table: SectionProtocolRelationTableInput, queryText: string): number[] {
  const tokens = queryTokens(queryText)
  const headerRows = new Set<number>([0])
  for (const cell of table.cells ?? []) {
    if (cell.is_header) headerRows.add(cell.row)
  }
  const matches = table.rows
    .map((row, rowIndex) => {
      const rowText = normalizeText(row.join(" "))
      const score = tokens.reduce(
        (total, token) => total + (rowText.includes(token) ? Math.max(1, token.length) : 0),
        0,
      )
      return { rowIndex, score }
    })
    .filter(({ rowIndex, score }) => !headerRows.has(rowIndex) && score > 0)
    .sort((left, right) => right.score - left.score || left.rowIndex - right.rowIndex)
    .slice(0, MATCHED_ROW_LIMIT)

  const selected = new Set(headerRows)
  if (matches.length) {
    for (const { rowIndex } of matches) {
      selected.add(rowIndex)
      if (rowIndex > 0) selected.add(rowIndex - 1)
      if (rowIndex + 1 < table.rows.length) selected.add(rowIndex + 1)
    }
  } else {
    for (let rowIndex = 1; rowIndex < Math.min(table.rows.length, 4); rowIndex += 1) {
      selected.add(rowIndex)
    }
  }

  for (const cell of table.cells ?? []) {
    const rowEnd = cell.row + (cell.rowspan ?? 1) - 1
    if (rowEnd > cell.row && Array.from(selected).some((row) => row >= cell.row && row <= rowEnd)) {
      selected.add(cell.row)
    }
  }
  return Array.from(selected).filter((row) => row >= 0 && row < table.rows.length).sort((a, b) => a - b)
}

function selectHtmlRows(tableHtml: string, rowIndexes: number[]): string {
  const openingTag = tableHtml.match(/<table\b[^>]*>/i)?.[0] ?? "<table>"
  const rows = Array.from(tableHtml.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)).map((match) => match[0])
  return `${openingTag}${rowIndexes.map((index) => rows[index]).filter(Boolean).join("")}</table>`
}

function compactTable(
  table: SectionProtocolRelationTableInput,
  queryText: string,
  forceCompact: boolean,
): SectionProtocolRelationTableInput {
  const keepComplete = !forceCompact && (
    table.is_frame_format || (
      table.rows.length <= FULL_TABLE_MAX_ROWS &&
      tableCellCount(table) <= FULL_TABLE_MAX_CELLS &&
      tableCharCount(table) <= FULL_TABLE_MAX_CHARS
    )
  )
  const rowIndexes = keepComplete
    ? table.rows.map((_, index) => index)
    : selectedRows(table, queryText)
  const selectedTableRows = rowIndexes.map((index) => table.rows[index]).filter((row): row is string[] => Boolean(row))
  return {
    ...table,
    rows: table.table_html ? [] : selectedTableRows,
    table_html: table.table_html
      ? keepComplete
        ? table.table_html
        : selectHtmlRows(table.table_html, rowIndexes)
      : undefined,
    cells: undefined,
    payload_mode: keepComplete ? "complete" : "header_and_matched_rows",
    original_row_count: table.original_row_count ?? table.rows.length,
    selected_row_indexes: rowIndexes,
  }
}

function trimTablesToBudget(
  tables: SectionProtocolRelationTableInput[],
  mandatoryIds: Set<string>,
  charBudget: number,
): SectionProtocolRelationTableInput[] {
  const selected: SectionProtocolRelationTableInput[] = []
  let usedChars = 0
  for (const table of tables) {
    const tableChars = safeJsonLength(table)
    if (mandatoryIds.has(table.id) || usedChars + tableChars <= charBudget) {
      selected.push(table)
      usedChars += tableChars
    }
  }
  return selected
}

function prepareTables(
  tables: SectionProtocolRelationTableInput[],
  options: PrepareOptions,
  rawContextChars: number,
  retrievalStartedMs: number,
): PreparedTableSelection {
  const ids = selectedTableIds(tables, options)
  const mandatoryIds = new Set([
    ...options.primaryTableIds,
    ...options.referencedTableIds,
    ...options.flowTableIds,
  ])
  const routed = tables.filter((table) => ids.has(table.id))
  const tableCharBudget = options.tableCharBudget ?? Math.floor(
    options.tokenBudget * ESTIMATED_TOKEN_CHARS * TABLE_BUDGET_RATIO,
  )
  let compacted = routed.map((table) => compactTable(
    table,
    options.queryText,
    tableCharCount(table) > tableCharBudget,
  ))
  if (compacted.reduce((total, table) => total + safeJsonLength(table), 0) > tableCharBudget) {
    compacted = compacted.map((table) => (
      mandatoryIds.has(table.id) ? compactTable(table, options.queryText, true) : table
    ))
  }
  const budgeted = trimTablesToBudget(compacted, mandatoryIds, tableCharBudget)
  const finalChars = safeJsonLength(budgeted)
  return {
    tables: budgeted,
    metrics: {
      raw_context_chars: rawContextChars,
      raw_context_tokens: estimateTokens(rawContextChars),
      final_prompt_chars: finalChars,
      final_prompt_tokens: estimateTokens(finalChars),
      candidate_table_count: tables.length,
      selected_table_count: budgeted.length,
      selected_row_count: budgeted.reduce(
        (total, table) => total + (table.selected_row_indexes?.length ?? table.rows.length),
        0,
      ),
      token_budget: options.tokenBudget,
      retrieval_duration_ms: Date.now() - retrievalStartedMs,
      omitted_table_ids: tables.filter((table) => !budgeted.some((item) => item.id === table.id)).map((table) => table.id),
    },
  }
}

function compactText(value: string | undefined, queryText: string, maxChars: number): string | undefined {
  if (!value) return undefined
  const stripped = value
    .replace(/<table\b[\s\S]*?<\/table>/gi, "\n[table supplied separately]\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (stripped.length <= maxChars) return stripped
  const tokens = queryTokens(queryText)
  const segments = stripped.split(/\n{2,}/).filter(Boolean)
  const ranked = segments
    .map((text, index) => ({
      index,
      text,
      score: tokens.reduce((total, token) => total + (normalizeText(text).includes(token) ? token.length : 0), 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
  const selected: typeof ranked = []
  let chars = 0
  for (const segment of ranked) {
    if (chars + segment.text.length > maxChars && selected.length) continue
    selected.push(segment)
    chars += segment.text.length
    if (chars >= maxChars) break
  }
  return selected.sort((left, right) => left.index - right.index).map(({ text }) => text).join("\n\n").slice(0, maxChars)
}

function primaryGroups(
  primaryIds: string[],
  tables: SectionProtocolRelationTableInput[],
  heuristicRelations: SectionProtocolRelationModelInput["heuristic_relations"],
  maxGroups: number,
): string[][] {
  const available = primaryIds.filter((id) => tables.some((table) => table.id === id))
  if (available.length <= PRIMARY_TABLES_PER_WINDOW) return [available]
  const relationByTableId = new Map(heuristicRelations.map((relation) => [relation.frame_table_id, relation]))
  const ordered = [...available].sort((left, right) => {
    const leftRelation = relationByTableId.get(left)
    const rightRelation = relationByTableId.get(right)
    const needsModel = (relation: typeof leftRelation): number => (
      !relation ||
      !relation.preferred_name?.trim() ||
      !relation.flow_direction ||
      relation.flow_direction === "unknown" ||
      relation.confidence < 0.85
        ? 1
        : 0
    )
    return needsModel(rightRelation) - needsModel(leftRelation) || available.indexOf(left) - available.indexOf(right)
  })
  const groups: string[][] = []
  for (
    let index = 0;
    index < ordered.length && groups.length < maxGroups;
    index += PRIMARY_TABLES_PER_WINDOW
  ) {
    groups.push(ordered.slice(index, index + PRIMARY_TABLES_PER_WINDOW))
  }
  return groups
}

function refreshMetrics(
  metrics: DtpModelInputMetrics,
  value: unknown,
  staticPromptReserveChars: number,
  tokenBudget: number,
): void {
  const chars = safeJsonLength(value) + staticPromptReserveChars
  metrics.final_prompt_chars = chars
  metrics.final_prompt_tokens = estimateTokens(chars)
  metrics.token_budget = tokenBudget
}

function trimRelationInputToBudget(
  input: SectionProtocolRelationModelInput,
): SectionProtocolRelationModelInput {
  const maxPayloadChars = RELATION_TOKEN_BUDGET * ESTIMATED_TOKEN_CHARS - RELATION_STATIC_PROMPT_RESERVE_CHARS
  const originalTableIds = input.tables.map((table) => table.id)
  while (safeJsonLength(input) > maxPayloadChars) {
    const primaryIds = new Set(input.primary_table_ids)
    const removableIndex = input.tables.findLastIndex((table) => !primaryIds.has(table.id))
    if (removableIndex >= 0) {
      input.tables.splice(removableIndex, 1)
      continue
    }
    const textKeys: Array<"section_text" | "input_flow_text" | "output_flow_text"> = [
      "section_text",
      "input_flow_text",
      "output_flow_text",
    ]
    const longestKey = textKeys.sort((left, right) => input[right].length - input[left].length)[0]
    if (input[longestKey].length <= 512 && input.primary_table_ids.length > 1) {
      const removedId = input.primary_table_ids.pop()
      input.tables = input.tables.filter((table) => table.id !== removedId)
      continue
    }
    if (input[longestKey].length <= 512) break
    input[longestKey] = input[longestKey].slice(0, Math.max(512, Math.floor(input[longestKey].length * 0.75)))
  }
  input.support_table_ids = input.support_table_ids.filter((id) => input.tables.some((table) => table.id === id))
  input.heuristic_relations = input.heuristic_relations.filter((relation) => (
    input.tables.some((table) => table.id === relation.frame_table_id)
  ))
  if (input.model_input_metrics) {
    input.model_input_metrics.omitted_table_ids = uniqueStrings([
      ...input.model_input_metrics.omitted_table_ids,
      ...originalTableIds.filter((id) => !input.tables.some((table) => table.id === id)),
    ])
    input.model_input_metrics.selected_table_count = input.tables.length
    input.model_input_metrics.selected_row_count = input.tables.reduce(
      (total, table) => total + (table.selected_row_indexes?.length ?? table.rows.length),
      0,
    )
    refreshMetrics(input.model_input_metrics, input, RELATION_STATIC_PROMPT_RESERVE_CHARS, RELATION_TOKEN_BUDGET)
  }
  return input
}

function trimProtocolContextToBudget(input: DtpProtocolContextPackage): DtpProtocolContextPackage {
  const maxPayloadChars = PROTOCOL_TOKEN_BUDGET * ESTIMATED_TOKEN_CHARS - PROTOCOL_STATIC_PROMPT_RESERVE_CHARS
  const originalTableIds = input.tables.map((table) => table.id)
  while (safeJsonLength(input) > maxPayloadChars) {
    const primaryIds = new Set(input.primary_table_ids)
    const removableIndex = input.tables.findLastIndex((table) => !primaryIds.has(table.id))
    if (removableIndex >= 0) {
      input.tables.splice(removableIndex, 1)
      continue
    }
    const candidates: Array<{ get: () => string; set: (value: string) => void }> = [
      { get: () => input.section_text, set: (value: string) => { input.section_text = value } },
      { get: () => input.interface_context_text ?? "", set: (value: string) => { input.interface_context_text = value } },
      { get: () => input.referenced_context_text ?? "", set: (value: string) => { input.referenced_context_text = value } },
      { get: () => input.flow_blocks.input.text, set: (value: string) => { input.flow_blocks.input.text = value } },
      { get: () => input.flow_blocks.output.text, set: (value: string) => { input.flow_blocks.output.text = value } },
    ].sort((left, right) => right.get().length - left.get().length)
    const longest = candidates[0]
    if (longest.get().length <= 512 && input.primary_table_ids.length > 1) {
      const removedId = input.primary_table_ids.pop()
      input.tables = input.tables.filter((table) => table.id !== removedId)
      continue
    }
    if (longest.get().length <= 512) break
    longest.set(longest.get().slice(0, Math.max(512, Math.floor(longest.get().length * 0.75))))
  }
  const retainedIds = new Set(input.tables.map((table) => table.id))
  input.support_table_ids = input.support_table_ids.filter((id) => retainedIds.has(id))
  input.referenced_primary_table_ids = input.referenced_primary_table_ids?.filter((id) => retainedIds.has(id))
  input.reference_evidence = input.reference_evidence?.filter((evidence) => (
    evidence.target_ids.some((id) => retainedIds.has(id))
  ))
  input.heuristic_relations = input.heuristic_relations.filter((relation) => retainedIds.has(relation.frame_table_id))
  if (input.model_input_metrics) {
    input.model_input_metrics.omitted_table_ids = uniqueStrings([
      ...input.model_input_metrics.omitted_table_ids,
      ...originalTableIds.filter((id) => !input.tables.some((table) => table.id === id)),
    ])
    input.model_input_metrics.selected_table_count = input.tables.length
    input.model_input_metrics.selected_row_count = input.tables.reduce(
      (total, table) => total + (table.selected_row_indexes?.length ?? table.rows.length),
      0,
    )
    refreshMetrics(input.model_input_metrics, input, PROTOCOL_STATIC_PROMPT_RESERVE_CHARS, PROTOCOL_TOKEN_BUDGET)
  }
  return input
}

export function prepareSectionRelationModelInputs(
  input: SectionProtocolRelationModelInput,
): SectionProtocolRelationModelInput[] {
  const rawContextChars = safeJsonLength(input)
  const primaryIds = primaryGroups(
    input.primary_table_ids,
    input.tables,
    input.heuristic_relations,
    1,
  )[0] ?? []
  const startedMs = Date.now()
  const queryText = [input.section_title, input.input_flow_text, input.output_flow_text, input.section_text].join("\n")
  const referencedIds = (input.referenced_primary_table_ids ?? []).filter((id) => primaryIds.includes(id))
  const textBudget = Math.floor(RELATION_TOKEN_BUDGET * ESTIMATED_TOKEN_CHARS * TEXT_BUDGET_RATIO)
  const selected = prepareTables(input.tables, {
    tokenBudget: RELATION_TOKEN_BUDGET,
    tableCharBudget: 16_000,
    queryText,
    primaryTableIds: primaryIds,
    supportTableIds: input.support_table_ids,
    referencedTableIds: referencedIds,
    flowTableIds: [],
  }, rawContextChars, startedMs)
  const prepared: SectionProtocolRelationModelInput = {
    ...input,
    section_text: compactText(input.section_text, queryText, Math.floor(textBudget / 2)) ?? "",
    input_flow_text: compactText(input.input_flow_text, queryText, Math.floor(textBudget / 4)) ?? "",
    output_flow_text: compactText(input.output_flow_text, queryText, Math.floor(textBudget / 4)) ?? "",
    tables: selected.tables,
    primary_table_ids: primaryIds,
    support_table_ids: selected.tables.filter((table) => !primaryIds.includes(table.id)).map((table) => table.id),
    heuristic_relations: input.heuristic_relations.filter((relation) => selected.tables.some((table) => table.id === relation.frame_table_id)),
    model_input_metrics: selected.metrics,
    model_timeout_ms: 100_000,
  }
  trimRelationInputToBudget(prepared)
  return [prepared]
}

export function prepareProtocolUnderstandingContexts(
  input: DtpProtocolContextPackage,
): DtpProtocolContextPackage[] {
  const rawContextChars = safeJsonLength(input)
  const groups = primaryGroups(
    input.primary_table_ids,
    input.tables,
    input.heuristic_relations,
    MAX_PROTOCOL_WINDOWS,
  )
  return groups.map((primaryIds, windowIndex) => {
    const startedMs = Date.now()
    const queryText = [
      input.section_title,
      input.interface_context_text,
      input.flow_blocks.input.text,
      input.flow_blocks.output.text,
      input.section_text,
      input.referenced_context_text,
      JSON.stringify(input.reference_evidence ?? []),
    ].join("\n")
    const candidateReferencedIds = uniqueStrings([
      ...(input.referenced_primary_table_ids ?? []).filter((id) => primaryIds.includes(id)),
      ...(input.reference_evidence ?? []).flatMap((evidence) => evidence.target_ids),
    ]).filter((id) => input.tables.some((table) => table.id === id))
    const tokens = queryTokens(queryText)
    const referencedIds = uniqueStrings([
      ...primaryIds,
      ...candidateReferencedIds
        .filter((id) => !primaryIds.includes(id))
        .map((id) => ({ id, table: input.tables.find((table) => table.id === id) }))
        .filter((item): item is { id: string; table: SectionProtocolRelationTableInput } => Boolean(item.table))
        .sort((left, right) => tableScore(right.table, tokens) - tableScore(left.table, tokens))
        .slice(0, 3)
        .map(({ id }) => id),
    ])
    const allFlowTableIds = uniqueStrings([
      ...input.flow_blocks.input.table_ids,
      ...input.flow_blocks.output.table_ids,
    ])
    const flowTableIds = allFlowTableIds.filter((id) => primaryIds.includes(id))
    const selected = prepareTables(input.tables, {
      tokenBudget: PROTOCOL_TOKEN_BUDGET,
      tableCharBudget: 24_000,
      queryText,
      primaryTableIds: primaryIds,
      supportTableIds: input.support_table_ids,
      referencedTableIds: referencedIds,
      flowTableIds,
    }, rawContextChars, startedMs)
    const textBudget = Math.floor(PROTOCOL_TOKEN_BUDGET * ESTIMATED_TOKEN_CHARS * TEXT_BUDGET_RATIO)
    const selectedIds = new Set(selected.tables.map((table) => table.id))
    const prepared: DtpProtocolContextPackage = {
      ...input,
      section_model_id: groups.length > 1 ? `${input.section_model_id}::evidence-${windowIndex + 1}` : input.section_model_id,
      interface_context_text: compactText(input.interface_context_text, queryText, Math.floor(textBudget / 6)),
      section_text: compactText(input.section_text, queryText, Math.floor(textBudget / 2)) ?? "",
      referenced_context_text: compactText(input.referenced_context_text, queryText, Math.floor(textBudget / 6)),
      flow_blocks: {
        input: {
          ...input.flow_blocks.input,
          text: compactText(input.flow_blocks.input.text, queryText, Math.floor(textBudget / 12)) ?? "",
          table_ids: input.flow_blocks.input.table_ids.filter((id) => selectedIds.has(id)),
        },
        output: {
          ...input.flow_blocks.output,
          text: compactText(input.flow_blocks.output.text, queryText, Math.floor(textBudget / 12)) ?? "",
          table_ids: input.flow_blocks.output.table_ids.filter((id) => selectedIds.has(id)),
        },
      },
      tables: selected.tables,
      primary_table_ids: primaryIds,
      support_table_ids: selected.tables.filter((table) => !primaryIds.includes(table.id)).map((table) => table.id),
      reference_evidence: input.reference_evidence?.filter((evidence) => evidence.target_ids.some((id) => selectedIds.has(id))),
      heuristic_relations: input.heuristic_relations.filter((relation) => selectedIds.has(relation.frame_table_id)),
      model_input_metrics: selected.metrics,
    }
    trimProtocolContextToBudget(prepared)
    prepared.model_timeout_ms = prepared.model_input_metrics!.final_prompt_tokens <= 20_000 ? 150_000 : 100_000
    prepared.model_input_metrics!.applied_timeout_ms = prepared.model_timeout_ms
    return prepared
  })
}

export function prepareRequestedProtocolEvidenceContext(
  input: DtpProtocolContextPackage,
  requests: DtpModelEvidenceRequest[],
): DtpProtocolContextPackage | null {
  const requestedTableIds = uniqueStrings(requests.map((request) => request.table_id))
    .filter((id) => input.tables.some((table) => table.id === id))
  if (!requestedTableIds.length) return null
  const retainedIds = new Set([...input.primary_table_ids, ...requestedTableIds])
  const query = requests.flatMap((request) => [
    request.table_id,
    ...request.row_keys,
    ...request.fields,
  ]).join(" ")
  const narrowed: DtpProtocolContextPackage = {
    ...input,
    section_model_id: `${input.section_model_id}::evidence-supplement`,
    section_text: `${input.section_text}\n\nRequested evidence: ${query}`,
    tables: input.tables.filter((table) => retainedIds.has(table.id)),
    support_table_ids: uniqueStrings([...input.support_table_ids, ...requestedTableIds]),
    reference_evidence: input.reference_evidence?.filter((evidence) => (
      evidence.target_ids.some((id) => retainedIds.has(id))
    )),
  }
  return prepareProtocolUnderstandingContexts(narrowed)[0] ?? null
}
