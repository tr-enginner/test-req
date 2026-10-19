import { phase2Warning } from "../shared/phase2-tolerance"
import { existsSync, readFileSync } from "fs"
import { dirname, resolve } from "path"

export interface Phase2SourceSection {
  source_ref: string
  document_role: "primary" | "supporting"
  document_path: string
  section_id: string
  title: string
  level: number
  section_path_titles: string[]
  text: string
  tables: Array<{ table_id: string; title: string; table_html: string; table_asset?: unknown }>
}

export interface Phase2SourceBundle {
  manifest_path: string
  sections: Phase2SourceSection[]
  section_by_ref: Map<string, Phase2SourceSection>
  searchable_text: string
}

type SourceDocument = { role?: string; path: string; structure_path: string }
type SourceManifest = {
  primary_document: SourceDocument
  supporting_documents: SourceDocument[]
}

function json(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"))
}

function canonicalStructurePath(manifestPath: string, value: string): string {
  return resolve(dirname(manifestPath), value)
}

export function loadPhase2SourceBundle(sourceArtifactsPath: string): Phase2SourceBundle {
  const manifestPath = resolve(sourceArtifactsPath)
  if (!existsSync(manifestPath)) throw new Error(`File not found: ${manifestPath}`)
  const manifest = json(manifestPath) as Partial<SourceManifest>
  if (!manifest.primary_document || !Array.isArray(manifest.supporting_documents)) {
    throw new Error(`Invalid source-artifacts.json: ${manifestPath}. Re-run requirements document parsing.`)
  }
  const documents = [manifest.primary_document, ...manifest.supporting_documents]
  const sections: Phase2SourceSection[] = []
  const sectionByRef = new Map<string, Phase2SourceSection>()

  documents.forEach((document, documentIndex) => {
    if (!document.path || !document.structure_path) throw new Error(`Invalid source document entry in ${manifestPath}`)
    const structurePath = canonicalStructurePath(manifestPath, document.structure_path)
    if (!existsSync(structurePath)) throw new Error(`File not found: ${structurePath}. Re-run requirements document parsing.`)
    const structureBytes = readFileSync(structurePath)
    const structure = JSON.parse(structureBytes.toString("utf-8")) as { sections?: any[] }
    if (!Array.isArray(structure.sections)) throw new Error(`Invalid document structure: ${structurePath}`)
    const role = documentIndex === 0 ? "primary" : "supporting"
    for (const raw of structure.sections) {
      const sourceRef = String(raw.source_ref || "").trim()
      if (!sourceRef) throw new Error(`Section without source_ref in ${structurePath}. Re-run requirements document parsing.`)
      if (sectionByRef.has(sourceRef)) throw new Error(`Duplicate source_ref: ${sourceRef}`)
      const tables = Array.isArray(raw.tables) ? raw.tables.map((table: any) => {
        if ("rows" in table || typeof table.table_html !== "string") {
          throw new Error(`Legacy table artifact at ${sourceRef}. Re-run requirements document parsing to generate table_html.`)
        }
        return { table_id: String(table.table_id), title: String(table.title || ""), table_html: table.table_html, ...(table.table_asset ? { table_asset: table.table_asset } : {}) }
      }) : []
      const section: Phase2SourceSection = {
        source_ref: sourceRef,
        document_role: role,
        document_path: document.path,
        section_id: String(raw.section_id || ""),
        title: String(raw.title || ""),
        level: Number(raw.level || 0),
        section_path_titles: Array.isArray(raw.section_path_titles) ? raw.section_path_titles.map(String) : [],
        text: String(raw.text || ""),
        tables,
      }
      sections.push(section)
      sectionByRef.set(sourceRef, section)
    }
  })
  const searchableText = sections.map((section) => {
    const tables = section.tables.map((table) => `${table.title}\n${table.table_html}`).join("\n")
    return `[${section.source_ref}] ${section.section_path_titles.join(" > ")}\n${section.text}\n${tables}`
  }).join("\n\n")
  return { manifest_path: manifestPath, sections, section_by_ref: sectionByRef, searchable_text: searchableText }
}

export function normalizeAndValidateSourceRefs(value: unknown, bundle: Phase2SourceBundle, label: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some(ref => typeof ref !== "string")) {
    throw new Error(`${label}.source_refs must be a string array.`)
  }
  return [...new Set(value.map(ref => ref.trim()))].filter(ref => {
    if (ref && bundle.section_by_ref.has(ref)) return true
    phase2Warning(`${label}: 跳过无法解析的来源 ${ref || "(空)"}`, 1)
    return false
  })
}
