import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { phase2Warnings, phase2Warning } from "../shared/phase2-tolerance"
import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { Chapter1ScopeRawSchema, Chapter1ScopeSchema, type Chapter1Reference, type Chapter1Scope } from "../schema/chapter1-scope"
import { BASE_CHAPTER1_REFERENCES, renderChapter1ScopeDocx } from "./chapter1-scope-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { PHASE2_CHAPTER_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"

const artifact = (ctx: ToolContext, fallback: string) => resolve(ctx.directory, fallback)
const readJson = (path: string): unknown => readPhase2Json(path)
const writeJson = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n") }

function normalizeDocumentId(value: string): string {
  let id = value.trim().replace(/^WB-/i, "")
  const match = id.match(/^(.+?)[\/-]RX1(?:[-_.]?\d+(?:\.\d+)*)?$/i)
  if (match) id = `${match[1]}.RX1`
  else if (/\.RX1$/i.test(id)) id = id.replace(/\.rx1$/i, ".RX1")
  return id
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))]
}

function conditionReferences(text: string): Chapter1Reference[] {
  const refs: Chapter1Reference[] = []
  const add = (document_id: string, document_title: string, pattern: RegExp) => {
    if (pattern.test(text)) refs.push({ document_id, document_title, source_kind: "conditional", evidence: `项目文本匹配：${pattern.source}` })
  }
  add("WY-MARS-1JY167", "火星探测器软件产品保证要求", /火星|MARS/i)
  add("CMS-RW-04", "载人航天软件工程化技术标准软件测试细则", /载人航天/)
  add("ZR-KJZXZ004", "空间站软件工程化实施细则", /空间站/)
  return refs
}

const PROGRAMMING_LANGUAGE_REFERENCES = {
  c: { document_id: "Q/W-Q80-18-01-2014", document_title: "航天器软件C语言编程约定" },
  x86_assembly: { document_id: "Q/W 1141-2007", document_title: "航天器X86汇编语言软件编程约定" },
  mcs51_assembly: { document_id: "Q/W 1139-2007", document_title: "航天器51汇编语言软件编程约定" },
} as const

function programmingLanguageReferences(languages: Chapter1Scope["programming_languages"]): Chapter1Reference[] {
  const selected = new Set(languages)
  return (["c", "x86_assembly", "mcs51_assembly"] as const)
    .filter((language) => selected.has(language))
    .map((language) => ({ ...PROGRAMMING_LANGUAGE_REFERENCES[language], source_kind: "programming_language", evidence: `主SRS编程语言：${language}` }))
}

function normalize(raw: unknown, sourceText: string, sourceArtifactsPath: string): Chapter1Scope {
  const parsed = Chapter1ScopeRawSchema.safeParse(JSON.parse(JSON.stringify(raw)))
  if (!parsed.success) throw new Error(`invalid chapter1 scope raw artifact; rerun chapter1-scope-modeler: ${parsed.error.message}`)
  const model = carryOrigins(raw, parsed.data)
  const bundle = loadPhase2SourceBundle(sourceArtifactsPath)
  const warnings = [...model.warnings]
  const documentId = normalizeDocumentId(model.document_id)
  if (!documentId) warnings.push("未识别到文档标识，按空值渲染")
  if (!model.client_address) warnings.push("未识别到委托单位地址，按空值渲染")
  if (!model.code_version) warnings.push("未识别到代码版本，使用默认值1.00")
  const refs = [...programmingLanguageReferences(model.programming_languages), ...model.references, ...conditionReferences(sourceText)]
  const seen = new Set(BASE_CHAPTER1_REFERENCES.map((ref) => ref.document_id.trim().toUpperCase()))
  const references = refs.filter((ref) => {
    const key = ref.document_id.trim().toUpperCase()
    if (!key || seen.has(key)) return false
    seen.add(key); return true
  })
  const normalized = {
    ...model,
    version: "2.0",
    source_artifacts_path: sourceArtifactsPath,
    source_refs: normalizeAndValidateSourceRefs(model.source_refs, bundle, "chapter1"),
    document_id: documentId,
    document_version: "1.00",
    client_address: model.client_address.trim(),
    csci_names: uniqueStrings(model.csci_names),
    code_version: model.code_version.trim() || "1.00",
    programming_languages: [...new Set(model.programming_languages)],
    references,
    warnings: uniqueStrings([...warnings, ...phase2Warnings()]),
  }
  return carryOrigins(normalized, Chapter1ScopeSchema.parse(JSON.parse(JSON.stringify(normalized))))
}

function reusable(rawPath: string): boolean {
  if (!existsSync(rawPath)) return false
  try {
    Chapter1ScopeRawSchema.parse(readJson(rawPath))
    return true
  } catch { return false }
}

export async function prepareChapter1Scope(ctx: ToolContext): Promise<string> {
  const inputs = {
    source_plan_path: artifact(ctx, ".matrix/data/source-plan.json"),
    source_artifacts_path: artifact(ctx, ".matrix/data/source-artifacts.json"),
  }
  const missing = Object.entries(inputs).filter(([, path]) => !existsSync(path)).map(([name, path]) => ({ name, path }))
  if (missing.length) return JSON.stringify({ ok: false, mode: "prepare_chapter1_scope", error: "missing_inputs", missing }, null, 2)
  const outputPath = artifact(ctx, ".matrix/data/chapter1-scope.raw.json")
  const rawReused = reusable(outputPath)
  const payload = { worker_type: "chapter1-scope-modeler", ...inputs, output_path: outputPath }
  return JSON.stringify({
    ok: true, mode: "prepare_chapter1_scope", output: { chapter1_scope_raw_path: outputPath },
    summary: { raw_reused: rawReused },
    ...(rawReused ? {} : {
      subagent_type: "chapter1-scope-modeler",
      worker_payload: payload,
      worker_prompt: `Use $test-requirement-chapter1 and write the requested raw JSON.\n${PHASE2_CHAPTER_SOURCE_REFS_GUIDANCE}\nsoftware_name_and_id必须是单个JSON字符串，固定写成“<型号或项目代号><软件全称>(<软件标识号>)”，型号与软件全称之间不加空格，标识号使用半角括号；正确示例必须参考“XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)”。标识号内部原有括号、斜杠、连字符和版本号保持来源原文。任一组成部分无法确认时只把该部分写XXX并在warnings说明：缺型号为“XXX配电器下位机软件(R/...)”，缺名称为“XHDZ-0000755XXX(R/...)”，缺标识为“XHDZ-0000755配电器下位机软件(XXX)”，全部不确定为“XXXXXX(XXX)”。禁止输出“软件名称（型号）”、仅软件名称或仅标识号。\n<matrix_worker_payload>\n${JSON.stringify(payload, null, 2)}\n</matrix_worker_payload>`,
    }),
  }, null, 2)
}

export async function finalizeChapter1Scope(ctx: ToolContext): Promise<string> {
  const rawPath = artifact(ctx, ".matrix/data/chapter1-scope.raw.json")
  const sourceTextPath = artifact(ctx, ".matrix/data/source-artifacts.json")
  if (!existsSync(rawPath) || !existsSync(sourceTextPath)) return JSON.stringify({ ok: false, mode: "finalize_chapter1_scope", error: "missing_inputs", missing: [rawPath, sourceTextPath].filter((p) => !existsSync(p)) }, null, 2)
  try {
    const model = normalize(trackRaw(readJson(rawPath), rawPath), loadPhase2SourceBundle(sourceTextPath).searchable_text, sourceTextPath)
    const outputPath = artifact(ctx, ".matrix/data/chapter1-scope.json")
    const reportPath = artifact(ctx, ".matrix/reports/chapter1-scope.docx")
    writeJson(outputPath, model)
    mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, renderChapter1ScopeDocx(model))
    publishEditMapping(outputPath, model)
    return JSON.stringify({ ok: true, mode: "finalize_chapter1_scope", output: { chapter1_scope_path: outputPath, chapter1_scope_report_path: reportPath }, summary: { reference_count: model.references.length, warning_count: model.warnings.length } }, null, 2)
  } catch (error) {
    return JSON.stringify({ ok: false, mode: "finalize_chapter1_scope", error: error instanceof Error ? error.message : String(error) }, null, 2)
  }
}
