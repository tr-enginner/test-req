import { existsSync, readFileSync } from "fs"
import { dirname, extname, join } from "path"
import { fileURLToPath } from "url"
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter"

export type CodeParseWarning = {
  file_path: string
  parser_path?: string
  language?: "c" | "cpp"
  message: string
  error_count?: number
  missing_count?: number
}

export type AnalyzedFunction = {
  name: string
  file_path: string
  line_range: { start: number; end: number }
  return_type: string
  parameters: Array<{ name: string; type: string }>
  cyclomatic_complexity: number
  calls: string[]
  safety_critical: boolean
  body?: string
}

export type AnalyzedDataStructure = {
  name: string
  file_path: string
  line_range: { start: number; end: number }
  kind: "struct" | "enum" | "union" | "typedef" | "GlobalVar"
  type?: string
  fields: Array<{ name: string; type: string }>
}

export type AnalyzeCodeFileInput = {
  originalPath: string
  parsePath: string
  reportedPath: string
  parseContent: string
  originalContent: string
  lineDelta: number
  includeBodies: boolean
}

type ParserLanguage = "c" | "cpp"

type ParseAttempt = {
  languageName: ParserLanguage
  functions: AnalyzedFunction[]
  macroNames: Set<string>
  errorCount: number
  missingCount: number
}

type StructureParseAttempt = {
  languageName: ParserLanguage
  structures: AnalyzedDataStructure[]
  errorCount: number
  missingCount: number
}

let initPromise: Promise<void> | null = null
let cLanguagePromise: Promise<Language> | null = null
let cppLanguagePromise: Promise<Language> | null = null

export async function analyzeCodeFile(input: AnalyzeCodeFileInput): Promise<{
  functions: AnalyzedFunction[]
  warnings: CodeParseWarning[]
}> {
  const languages = languagesForPath(input.originalPath)
  const attempts: ParseAttempt[] = []

  for (const languageName of languages) {
    attempts.push(await parseWithLanguage(input, languageName))
  }

  const selected = selectBestAttempt(attempts)
  const warnings = buildWarnings(input, selected, attempts)
  return { functions: selected.functions, warnings }
}

export async function analyzeDataStructuresFile(input: Omit<AnalyzeCodeFileInput, "includeBodies">): Promise<{
  structures: AnalyzedDataStructure[]
  warnings: CodeParseWarning[]
}> {
  const languages = languagesForPath(input.originalPath)
  const attempts: StructureParseAttempt[] = []

  for (const languageName of languages) {
    attempts.push(await parseStructuresWithLanguage(input, languageName))
  }

  const selected = selectBestStructureAttempt(attempts)
  const warningAttempts = attempts.map((attempt) => ({
    languageName: attempt.languageName,
    functions: [],
    macroNames: new Set<string>(),
    errorCount: attempt.errorCount,
    missingCount: attempt.missingCount,
  }))
  const warnings = buildWarnings(
    { ...input, includeBodies: false },
    {
      languageName: selected.languageName,
      functions: [],
      macroNames: new Set(),
      errorCount: selected.errorCount,
      missingCount: selected.missingCount,
    },
    warningAttempts,
  )

  return { structures: selected.structures, warnings }
}

function languagesForPath(filePath: string): ParserLanguage[] {
  const ext = extname(filePath).toLowerCase()
  if ([".cpp", ".hpp", ".cc", ".cxx"].includes(ext)) return ["cpp"]
  if (ext === ".h") return ["c", "cpp"]
  return ["c"]
}

function selectBestAttempt(attempts: ParseAttempt[]): ParseAttempt {
  return attempts.reduce((best, current) => {
    const bestScore = best.errorCount + best.missingCount
    const currentScore = current.errorCount + current.missingCount
    if (currentScore < bestScore) return current
    if (currentScore === bestScore && current.functions.length > best.functions.length) return current
    return best
  })
}

function selectBestStructureAttempt(attempts: StructureParseAttempt[]): StructureParseAttempt {
  return attempts.reduce((best, current) => {
    const bestScore = best.errorCount + best.missingCount
    const currentScore = current.errorCount + current.missingCount
    if (currentScore < bestScore) return current
    if (currentScore === bestScore && current.structures.length > best.structures.length) return current
    return best
  })
}

function buildWarnings(
  input: AnalyzeCodeFileInput,
  selected: ParseAttempt,
  attempts: ParseAttempt[],
): CodeParseWarning[] {
  const warnings: CodeParseWarning[] = []

  if (selected.errorCount > 0 || selected.missingCount > 0) {
    warnings.push({
      file_path: input.reportedPath,
      parser_path: input.parsePath,
      language: selected.languageName,
      message: "Tree-sitter recovered from syntax errors while parsing this file.",
      error_count: selected.errorCount,
      missing_count: selected.missingCount,
    })
  }

  const first = attempts[0]
  if (attempts.length > 1 && selected.languageName !== first.languageName) {
    warnings.push({
      file_path: input.reportedPath,
      parser_path: input.parsePath,
      language: selected.languageName,
      message: `Selected ${selected.languageName} grammar because it produced fewer parse errors than ${first.languageName}.`,
      error_count: selected.errorCount,
      missing_count: selected.missingCount,
    })
  }

  return warnings
}

async function parseWithLanguage(
  input: AnalyzeCodeFileInput,
  languageName: ParserLanguage,
): Promise<ParseAttempt> {
  const language = await loadLanguage(languageName)
  const parser = new Parser()
  parser.setLanguage(language)

  const tree = parser.parse(input.parseContent)
  if (!tree) {
    parser.delete()
    return {
      languageName,
      functions: [],
      macroNames: new Set(),
      errorCount: 1,
      missingCount: 0,
    }
  }

  const counts = countParseProblems(tree.rootNode)
  const macroNames = collectFunctionLikeMacroNames(tree.rootNode)
  const functions = tree.rootNode
    .descendantsOfType("function_definition")
    .map((node) => extractFunction(input, node, macroNames))
    .filter((fn): fn is AnalyzedFunction => fn !== null)

  tree.delete()
  parser.delete()

  return {
    languageName,
    functions,
    macroNames,
    errorCount: counts.errorCount,
    missingCount: counts.missingCount,
  }
}

async function parseStructuresWithLanguage(
  input: Omit<AnalyzeCodeFileInput, "includeBodies">,
  languageName: ParserLanguage,
): Promise<StructureParseAttempt> {
  const language = await loadLanguage(languageName)
  const parser = new Parser()
  parser.setLanguage(language)

  const tree = parser.parse(input.parseContent)
  if (!tree) {
    parser.delete()
    return {
      languageName,
      structures: [],
      errorCount: 1,
      missingCount: 0,
    }
  }

  const counts = countParseProblems(tree.rootNode)
  const structures = extractDataStructures(input, tree.rootNode)

  tree.delete()
  parser.delete()

  return {
    languageName,
    structures,
    errorCount: counts.errorCount,
    missingCount: counts.missingCount,
  }
}

async function loadLanguage(languageName: ParserLanguage): Promise<Language> {
  await initParser()
  if (languageName === "c") {
    cLanguagePromise ??= Language.load(resolvePackageFile("@repomix/tree-sitter-wasms/out/tree-sitter-c.wasm"))
    return cLanguagePromise
  }

  cppLanguagePromise ??= Language.load(resolvePackageFile("@repomix/tree-sitter-wasms/out/tree-sitter-cpp.wasm"))
  return cppLanguagePromise
}

async function initParser(): Promise<void> {
  initPromise ??= Parser.init({
    locateFile(scriptName: string) {
      return join(dirname(resolvePackageFile("web-tree-sitter/web-tree-sitter.wasm")), scriptName)
    },
  })
  return initPromise
}

function resolvePackageFile(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier))
}

function countParseProblems(root: SyntaxNode): { errorCount: number; missingCount: number } {
  let errorCount = 0
  let missingCount = 0

  walk(root, (node) => {
    if (node.isError) errorCount++
    if (node.isMissing) missingCount++
  })

  return { errorCount, missingCount }
}

function collectFunctionLikeMacroNames(root: SyntaxNode): Set<string> {
  const names = new Set<string>()
  for (const node of root.descendantsOfType("preproc_function_def")) {
    const nameNode = node.childForFieldName("name")
    if (nameNode) names.add(nameNode.text)
  }
  return names
}

function extractFunction(
  input: AnalyzeCodeFileInput,
  node: SyntaxNode,
  macroNames: Set<string>,
): AnalyzedFunction | null {
  const declarator = node.childForFieldName("declarator")
  if (!declarator) return null

  const functionDeclarator = findNodeByType(declarator, "function_declarator")
  const nameNode = functionDeclarator
    ? functionDeclarator.childForFieldName("declarator")
    : null
  if (!functionDeclarator || !nameNode) return null

  const name = extractIdentifierName(nameNode)
  if (!name || isKeyword(name)) return null

  const start = toReportedLine(node.startPosition.row + 1, input.lineDelta)
  const end = Math.max(start, toReportedLine(node.endPosition.row + 1, input.lineDelta))
  const bodyNode = node.childForFieldName("body")

  const functionText = textSlice(input.parseContent, node.startIndex, node.endIndex)
  const returnType = extractReturnType(input.parseContent, node, declarator, nameNode)
  const parameters = extractParameters(functionDeclarator)
  const calls = bodyNode ? extractCalls(bodyNode, name, macroNames) : []
  const safetyCritical = detectSafetyCritical(input.originalContent, start)

  return {
    name,
    file_path: input.reportedPath,
    line_range: { start, end },
    return_type: returnType,
    parameters,
    cyclomatic_complexity: estimateComplexity(bodyNode ?? node),
    calls,
    safety_critical: safetyCritical,
    ...(input.includeBodies ? { body: extractBody(input, node, functionText, { start, end }) } : {}),
  }
}

function extractReturnType(
  source: string,
  functionNode: SyntaxNode,
  topDeclarator: SyntaxNode,
  nameNode: SyntaxNode,
): string {
  const prefixEnd = topDeclarator.type === "function_declarator"
    ? topDeclarator.startIndex
    : nameNode.startIndex
  const raw = textSlice(source, functionNode.startIndex, prefixEnd)
  const normalized = normalizeType(raw)
  return normalized || "int"
}

function extractParameters(functionDeclarator: SyntaxNode): Array<{ name: string; type: string }> {
  const parameterList = functionDeclarator.childForFieldName("parameters")
  if (!parameterList) return []

  const declarations = parameterList.namedChildren.filter((child) => child.type === "parameter_declaration")
  if (
    declarations.length === 1 &&
    declarations[0].childForFieldName("declarator") === null &&
    normalizeType(declarations[0].text) === "void"
  ) {
    return []
  }

  return declarations.map((param, index) => {
    const declarator = param.childForFieldName("declarator")
    const nameNode = declarator ? findDeepestIdentifier(declarator) : null
    if (!nameNode) {
      return {
        name: `param${index + 1}`,
        type: normalizeType(param.text) || "int",
      }
    }

    const name = extractIdentifierName(nameNode) || `param${index + 1}`
    const relativeStart = nameNode.startIndex - param.startIndex
    const relativeEnd = nameNode.endIndex - param.startIndex
    const typeText = `${param.text.slice(0, relativeStart)}${param.text.slice(relativeEnd)}`

    return {
      name,
      type: normalizeType(typeText) || "int",
    }
  })
}

function extractCalls(bodyNode: SyntaxNode, selfName: string, macroNames: Set<string>): string[] {
  const calls = new Set<string>()

  walk(bodyNode, (node) => {
    if (node.type !== "call_expression") return
    const functionNode = node.childForFieldName("function")
    if (!functionNode) return

    const name = extractCalleeName(functionNode)
    if (
      name &&
      name !== selfName &&
      !isKeyword(name) &&
      !isStdlib(name) &&
      !macroNames.has(name)
    ) {
      calls.add(name)
    }
  })

  return Array.from(calls)
}

function extractCalleeName(node: SyntaxNode): string | null {
  if (isIdentifierNode(node)) return node.text

  if (node.type === "field_expression") {
    const field = node.childForFieldName("field")
    if (field) return extractIdentifierName(field)
  }

  if (node.type === "qualified_identifier" || node.type === "scoped_identifier") {
    const name = node.childForFieldName("name")
    if (name) return extractIdentifierName(name)
  }

  return extractIdentifierName(node)
}

function estimateComplexity(node: SyntaxNode): number {
  let complexity = 1

  walk(node, (child) => {
    switch (child.type) {
      case "if_statement":
      case "for_statement":
      case "while_statement":
      case "do_statement":
      case "case_statement":
      case "conditional_expression":
        complexity++
        break
      case "binary_expression":
        if (/\&\&|\|\|/.test(child.text)) complexity++
        break
    }
  })

  return complexity
}

function detectSafetyCritical(originalContent: string, startLine: number): boolean {
  const lines = originalContent.split("\n")
  const before = lines.slice(Math.max(0, startLine - 4), startLine).join("\n")
  return /safety|critical|SAFETY_CRITICAL|ASIL|SIL/i.test(before)
}

function extractBody(
  input: AnalyzeCodeFileInput,
  node: SyntaxNode,
  parseFunctionText: string,
  reportedRange: { start: number; end: number },
): string {
  if (existsSync(input.reportedPath)) {
    const originalLines = input.originalContent.split("\n")
    if (reportedRange.start >= 1 && reportedRange.end <= originalLines.length) {
      return originalLines.slice(reportedRange.start - 1, reportedRange.end).join("\n")
    }
  }

  return parseFunctionText || textSlice(input.parseContent, node.startIndex, node.endIndex)
}

function extractDataStructures(
  input: Omit<AnalyzeCodeFileInput, "includeBodies">,
  root: SyntaxNode,
): AnalyzedDataStructure[] {
  const structures: AnalyzedDataStructure[] = []

  walk(root, (node) => {
    if (node.type === "type_definition") {
      structures.push(...extractTypedefStructure(input, node))
      return
    }

    if (node.type === "declaration" && isGlobalDeclaration(node)) {
      structures.push(...extractGlobalVariables(input, node))
      return
    }

    if (!["struct_specifier", "union_specifier", "enum_specifier"].includes(node.type)) {
      return
    }

    if (node.parent?.type === "type_definition") {
      return
    }

    const structure = extractTaggedStructure(input, node)
    if (structure) {
      structures.push(structure)
    }
  })

  structures.push(...extractDialectGlobalVariables(input, structures))
  return dedupeStructures(structures)
}

function extractGlobalVariables(
  input: Omit<AnalyzeCodeFileInput, "includeBodies">,
  node: SyntaxNode,
): AnalyzedDataStructure[] {
  const declarators = collectGlobalVariableDeclarators(node)
  const first = declarators[0]
  const baseType = first ? extractDeclarationBaseType(node, first.anchor) : ""

  return declarators.map(({ declarator, nameNode }) => {
    const type = decorateFieldType(baseType, declarator, nameNode) || baseType || "unknown"
    return {
      name: nameNode.text,
      file_path: input.reportedPath,
      line_range: nodeLineRange(input, node),
      kind: "GlobalVar" as const,
      type,
      fields: [],
    }
  })
}

function isGlobalDeclaration(node: SyntaxNode): boolean {
  let current = node.parent
  while (current) {
    if (
      current.type === "function_definition" ||
      current.type === "compound_statement" ||
      current.type === "field_declaration_list" ||
      current.type === "parameter_list"
    ) {
      return false
    }
    if (current.type === "translation_unit") return true
    current = current.parent
  }
  return false
}

function collectGlobalVariableDeclarators(node: SyntaxNode): Array<{
  anchor: SyntaxNode
  declarator: SyntaxNode
  nameNode: SyntaxNode
}> {
  const results: Array<{ anchor: SyntaxNode; declarator: SyntaxNode; nameNode: SyntaxNode }> = []

  for (const child of node.namedChildren) {
    if (isTypeOnlyNode(child) || isDialectStorageQualifierNode(child)) continue

    const declarator = child.type === "init_declarator"
      ? child.childForFieldName("declarator")
      : child
    if (!declarator || isFunctionPrototypeDeclarator(declarator)) continue

    const nameNode = findDeepestVariableIdentifier(declarator)
    if (!nameNode || isKeyword(nameNode.text)) continue

    results.push({
      anchor: child,
      declarator,
      nameNode,
    })
  }

  return results
}

function isFunctionPrototypeDeclarator(node: SyntaxNode): boolean {
  if (node.type !== "function_declarator") return false

  const declarator = node.childForFieldName("declarator")
  if (!declarator) return true

  return isIdentifierNode(declarator) ||
    declarator.type === "qualified_identifier" ||
    declarator.type === "scoped_identifier"
}

function isDialectStorageQualifierNode(node: SyntaxNode): boolean {
  if (node.type !== "ERROR") return false
  const identifiers = node.namedChildren.filter((child) => child.type === "identifier")
  return identifiers.length === 1 && isDialectStorageQualifier(identifiers[0].text)
}

function isDialectStorageQualifier(value: string): boolean {
  return new Set([
    "code",
    "data",
    "xdata",
    "idata",
    "pdata",
    "bdata",
    "near",
    "far",
    "huge",
  ]).has(value)
}

function extractDialectGlobalVariables(
  input: Omit<AnalyzeCodeFileInput, "includeBodies">,
  existing: AnalyzedDataStructure[],
): AnalyzedDataStructure[] {
  const existingKeys = new Set(existing.map((item) =>
    `${item.kind}\0${item.name}\0${item.file_path}\0${item.line_range.start}`,
  ))
  const results: AnalyzedDataStructure[] = []
  let braceDepth = 0

  const lines = input.parseContent.split(/\r?\n/)
  lines.forEach((line, index) => {
    const lineNumber = toReportedLine(index + 1, input.lineDelta)
    const parsed = braceDepth === 0 ? parseDialectGlobalVariableLine(line) : null
    if (parsed) {
      const key = `GlobalVar\0${parsed.name}\0${input.reportedPath}\0${lineNumber}`
      if (!existingKeys.has(key)) {
        results.push({
          name: parsed.name,
          file_path: input.reportedPath,
          line_range: { start: lineNumber, end: lineNumber },
          kind: "GlobalVar",
          type: parsed.type,
          fields: [],
        })
      }
    }

    braceDepth = Math.max(0, braceDepth + countBraceDelta(stripComments(line)))
  })

  return results
}

function parseDialectGlobalVariableLine(line: string): { name: string; type: string } | null {
  const beforeSemicolon = stripComments(line).split(";")[0]?.trim()
  if (!beforeSemicolon || !containsDialectStorageQualifier(beforeSemicolon)) return null
  if (beforeSemicolon.includes("(") || beforeSemicolon.includes(")")) return null

  const declaration = beforeSemicolon.split("=")[0]?.trim()
  if (!declaration) return null

  const match = declaration.match(/^(.+?)([A-Za-z_]\w*)((?:\s*\[[^\]]*\])*)$/)
  if (!match) return null

  const prefix = normalizeType(match[1])
  const name = match[2]
  const arrays = normalizeType(match[3] ?? "")
  if (!prefix || isDialectStorageQualifier(name)) return null

  return {
    name,
    type: normalizeType(`${prefix}${arrays ? ` ${arrays}` : ""}`),
  }
}

function containsDialectStorageQualifier(value: string): boolean {
  return value.split(/\s+/).some((token) => isDialectStorageQualifier(token))
}

function stripComments(line: string): string {
  return line.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, " ")
}

function countBraceDelta(line: string): number {
  let delta = 0
  for (const char of line) {
    if (char === "{") delta++
    if (char === "}") delta--
  }
  return delta
}

function extractTypedefStructure(
  input: Omit<AnalyzeCodeFileInput, "includeBodies">,
  node: SyntaxNode,
): AnalyzedDataStructure[] {
  const underlying = node.namedChildren.find((child) =>
    ["struct_specifier", "union_specifier", "enum_specifier"].includes(child.type),
  )
  const aliases = extractTypedefAliases(node, underlying)

  return aliases.map((alias) => ({
    name: alias,
    file_path: input.reportedPath,
    line_range: nodeLineRange(input, node),
    kind: "typedef" as const,
    fields: underlying ? extractStructureFields(underlying) : [],
  }))
}

function extractTaggedStructure(
  input: Omit<AnalyzeCodeFileInput, "includeBodies">,
  node: SyntaxNode,
): AnalyzedDataStructure | null {
  if (!hasStructureBody(node)) return null

  const name = extractTagName(node)
  if (!name) return null

  return {
    name,
    file_path: input.reportedPath,
    line_range: nodeLineRange(input, node),
    kind: structureKind(node.type),
    fields: extractStructureFields(node),
  }
}

function hasStructureBody(node: SyntaxNode): boolean {
  return node.namedChildren.some((child) =>
    child.type === "field_declaration_list" || child.type === "enumerator_list",
  )
}

function structureKind(type: string): "struct" | "enum" | "union" {
  if (type === "union_specifier") return "union"
  if (type === "enum_specifier") return "enum"
  return "struct"
}

function extractStructureFields(node: SyntaxNode): Array<{ name: string; type: string }> {
  if (node.type === "enum_specifier") {
    return extractEnumFields(node)
  }

  const body = node.namedChildren.find((child) => child.type === "field_declaration_list")
  if (!body) return []

  return body.namedChildren.flatMap((child) =>
    child.type === "field_declaration" ? extractFieldDeclaration(child) : [],
  )
}

function extractEnumFields(node: SyntaxNode): Array<{ name: string; type: string }> {
  const body = node.namedChildren.find((child) => child.type === "enumerator_list")
  if (!body) return []

  return body.namedChildren
    .filter((child) => child.type === "enumerator")
    .map((child) => child.namedChildren.find((candidate) => isIdentifierNode(candidate))?.text ?? null)
    .filter((name): name is string => Boolean(name))
    .map((name) => ({
      name,
      type: "enum_constant",
    }))
}

function extractFieldDeclaration(node: SyntaxNode): Array<{ name: string; type: string }> {
  const declarators = collectFieldDeclarators(node)
  const baseType = declarators[0] ? extractFieldBaseType(node, declarators[0].declarator) : ""
  return declarators.map(({ declarator, nameNode, suffix }) => {
    const decorated = decorateFieldType(baseType, declarator, nameNode, suffix)
    return {
      name: nameNode.text,
      type: decorated || baseType || "unknown",
    }
  })
}

function collectFieldDeclarators(node: SyntaxNode): Array<{
  declarator: SyntaxNode
  nameNode: SyntaxNode
  suffix?: string
}> {
  const results: Array<{ declarator: SyntaxNode; nameNode: SyntaxNode; suffix?: string }> = []

  for (let index = 0; index < node.namedChildren.length; index++) {
    const child = node.namedChildren[index]!
    if (child.type === "bitfield_clause") continue
    if (isTypeOnlyNode(child)) continue

    const nameNode = findDeepestFieldIdentifier(child)
    if (!nameNode) continue

    const next = node.namedChildren[index + 1]
    results.push({
      declarator: child,
      nameNode,
      suffix: next?.type === "bitfield_clause" ? next.text : undefined,
    })
  }

  return results
}

function extractFieldBaseType(fieldNode: SyntaxNode, firstDeclarator: SyntaxNode): string {
  return extractDeclarationBaseType(fieldNode, firstDeclarator)
}

function extractDeclarationBaseType(declarationNode: SyntaxNode, firstDeclarator: SyntaxNode): string {
  const raw = textSlice(declarationNode.text, 0, firstDeclarator.startIndex - declarationNode.startIndex)
  return normalizeType(raw.replace(/,+\s*$/, ""))
}

function decorateFieldType(
  baseType: string,
  declarator: SyntaxNode,
  nameNode: SyntaxNode,
  suffix?: string,
): string {
  const relativeStart = nameNode.startIndex - declarator.startIndex
  const relativeEnd = nameNode.endIndex - declarator.startIndex
  const beforeName = declarator.text.slice(0, relativeStart)
  const afterName = declarator.text.slice(relativeEnd)
  const decoration = normalizeType(`${beforeName}${afterName}${suffix ?? ""}`)
  if (!decoration) return baseType
  return normalizeType(`${baseType} ${decoration}`)
}

function extractTagName(node: SyntaxNode): string | null {
  const named = node.childForFieldName("name")
  if (named) return extractIdentifierName(named)

  const body = node.namedChildren.find((child) =>
    child.type === "field_declaration_list" || child.type === "enumerator_list",
  )
  const candidates = node.namedChildren.filter((child) =>
    child !== body && (child.type === "type_identifier" || isIdentifierNode(child)),
  )
  return candidates[0] ? extractIdentifierName(candidates[0]) : null
}

function extractTypedefAliases(node: SyntaxNode, underlying?: SyntaxNode): string[] {
  const aliases: string[] = []

  for (const child of node.namedChildren) {
    if (underlying && sameNode(child, underlying)) continue
    if (isTypeOnlyNode(child)) continue

    const alias = child.type === "type_identifier" || isIdentifierNode(child)
      ? child.text
      : findDeepestTypeIdentifier(child)?.text
    if (alias) aliases.push(alias)
  }

  return uniquePreservingOrder(aliases)
}

function isTypeOnlyNode(node: SyntaxNode): boolean {
  return [
    "primitive_type",
    "sized_type_specifier",
    "type_qualifier",
    "storage_class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
  ].includes(node.type)
}

function findDeepestTypeIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "type_identifier" || isIdentifierNode(node)) return node

  const named = node.childForFieldName("name") ?? node.childForFieldName("declarator")
  if (named) {
    const found = findDeepestTypeIdentifier(named)
    if (found) return found
  }

  for (let i = node.namedChildren.length - 1; i >= 0; i--) {
    const found = findDeepestTypeIdentifier(node.namedChildren[i])
    if (found) return found
  }

  return null
}

function findDeepestFieldIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "field_identifier") return node

  const named = node.childForFieldName("name") ?? node.childForFieldName("declarator")
  if (named) {
    const found = findDeepestFieldIdentifier(named)
    if (found) return found
  }

  for (let i = node.namedChildren.length - 1; i >= 0; i--) {
    const found = findDeepestFieldIdentifier(node.namedChildren[i])
    if (found) return found
  }

  return null
}

function findDeepestVariableIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "identifier") {
    return isDialectStorageQualifier(node.text) ? null : node
  }

  const named = node.childForFieldName("name") ?? node.childForFieldName("declarator")
  if (named) {
    const found = findDeepestVariableIdentifier(named)
    if (found) return found
  }

  for (let i = node.namedChildren.length - 1; i >= 0; i--) {
    const found = findDeepestVariableIdentifier(node.namedChildren[i])
    if (found) return found
  }

  return null
}

function nodeLineRange(
  input: Omit<AnalyzeCodeFileInput, "includeBodies">,
  node: SyntaxNode,
): { start: number; end: number } {
  const start = toReportedLine(node.startPosition.row + 1, input.lineDelta)
  const end = Math.max(start, toReportedLine(node.endPosition.row + 1, input.lineDelta))
  return { start, end }
}

function dedupeStructures(structures: AnalyzedDataStructure[]): AnalyzedDataStructure[] {
  const seen = new Set<string>()
  const deduped: AnalyzedDataStructure[] = []

  for (const structure of structures) {
    const key = [
      structure.kind,
      structure.name,
      structure.file_path,
      structure.line_range.start,
      structure.line_range.end,
    ].join("\0")
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(structure)
  }

  return deduped
}

function sameNode(left: SyntaxNode, right: SyntaxNode): boolean {
  return left.type === right.type &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

function findNodeByType(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node
  for (const child of node.namedChildren) {
    const found = findNodeByType(child, type)
    if (found) return found
  }
  return null
}

function findDeepestIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (isIdentifierNode(node)) return node

  const named = node.childForFieldName("name") ?? node.childForFieldName("declarator")
  if (named) {
    const found = findDeepestIdentifier(named)
    if (found) return found
  }

  for (let i = node.namedChildren.length - 1; i >= 0; i--) {
    const found = findDeepestIdentifier(node.namedChildren[i])
    if (found) return found
  }

  return null
}

function extractIdentifierName(node: SyntaxNode): string | null {
  if (isIdentifierNode(node)) return node.text.replace(/^~/, "")

  const named = node.childForFieldName("name") ?? node.childForFieldName("declarator")
  if (named) return extractIdentifierName(named)

  return findDeepestIdentifier(node)?.text.replace(/^~/, "") ?? null
}

function isIdentifierNode(node: SyntaxNode): boolean {
  return [
    "identifier",
    "field_identifier",
    "type_identifier",
    "namespace_identifier",
    "operator_name",
    "destructor_name",
  ].includes(node.type)
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node)
  for (const child of node.namedChildren) {
    walk(child, visit)
  }
}

function normalizeType(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\r\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([*&,])/g, " $1")
    .replace(/([*&,])\s+/g, "$1 ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim()
}

function textSlice(source: string, start: number, end: number): string {
  return source.slice(start, end)
}

function toReportedLine(parseLine: number, lineDelta: number): number {
  return Math.max(1, parseLine + lineDelta)
}

function isKeyword(name: string): boolean {
  const keywords = new Set([
    "if", "else", "while", "for", "do", "switch", "case",
    "return", "break", "continue", "goto", "sizeof", "typedef",
    "struct", "union", "enum", "static", "extern", "inline",
    "namespace", "class", "template",
  ])
  return keywords.has(name)
}

function isStdlib(name: string): boolean {
  const stdlib = new Set([
    "printf", "scanf", "fprintf", "sprintf", "snprintf",
    "malloc", "calloc", "realloc", "free",
    "memcpy", "memset", "memmove", "memcmp",
    "strlen", "strcpy", "strncpy", "strcmp", "strncmp", "strcat",
    "abs",
    "sizeof", "assert",
  ])
  return stdlib.has(name)
}
