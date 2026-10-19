import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"

export function writePhase2SourceBundleFixture(directory: string, text = "需求正文", sourceRef = "primary::SRS-1"): string {
  const dataDir = join(directory, ".matrix", "data")
  mkdirSync(dataDir, { recursive: true })
  const structurePath = join(dataDir, "req-document-structure.json")
  writeFileSync(structurePath, JSON.stringify({
    sections: [{
      section_id: sourceRef.split("::").at(-1),
      source_ref: sourceRef,
      title: "需求",
      level: 1,
      section_path_titles: ["需求"],
      text,
      tables: [],
    }],
  }))
  const manifestPath = join(dataDir, "source-artifacts.json")
  writeFileSync(manifestPath, JSON.stringify({
    primary_document: { role: "primary", path: "srs.docx", structure_path: structurePath },
    supporting_documents: [],
  }))
  return manifestPath
}
