/**
 * docx-image-handler.ts — Cross-document image migration and relationship maintenance.
 *
 * When copying content from a reference document to a template, embedded images
 * (<a:blip r:embed="rId...">) must be migrated: the binary media files copied,
 * new relationship IDs generated, and references updated.
 *
 * Migrated from Python _process_complete_image_system().
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface ImageRef {
  rId: string
  /** Offset in the XML fragment where r:embed="rIdX" appears */
  offset: number
}

export interface MigratedImage {
  originalRId: string
  newRId: string
  /** path like "word/media/image1.png" */
  targetMediaPath: string
  /** Binary content */
  data: Buffer
}

export interface ImageMigrationResult {
  /** Updated XML fragment with new rIds */
  updatedFragment: string
  /** New images to add to target ZIP entries */
  newMediaFiles: MigratedImage[]
  /** New relationship entries to add to document.xml.rels */
  newRelEntries: string[]
}

// ─── Image Reference Collection ────────────────────────────────────

/**
 * Scan an XML fragment for all <a:blip r:embed="rIdX"/> references.
 */
export function collectImageReferences(xmlFragment: string): ImageRef[] {
  const refs: ImageRef[] = []
  const regex = /r:embed="(rId\d+)"/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(xmlFragment)) !== null) {
    refs.push({ rId: m[1], offset: m.index })
  }
  return refs
}

// ─── Relationship XML Parsing ──────────────────────────────────────

interface RelEntry {
  id: string
  type: string
  target: string
}

function parseRels(relsXml: string): RelEntry[] {
  const entries: RelEntry[] = []
  const regex = /<Relationship\s+[^>]*Id="([^"]+)"[^>]*Type="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(relsXml)) !== null) {
    entries.push({ id: m[1], type: m[2], target: m[3] })
  }
  // Also match different attribute ordering
  const regex2 = /<Relationship\s+[^>]*Target="([^"]+)"[^>]*Type="([^"]+)"[^>]*Id="([^"]+)"[^>]*\/>/g
  while ((m = regex2.exec(relsXml)) !== null) {
    if (!entries.find((e) => e.id === m![3])) {
      entries.push({ id: m[3], type: m[2], target: m[1] })
    }
  }
  return entries
}

/**
 * Find the maximum rId number in a rels XML file.
 */
function findMaxRId(relsXml: string): number {
  let max = 0
  const regex = /Id="rId(\d+)"/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(relsXml)) !== null) {
    const num = parseInt(m[1], 10)
    if (num > max) max = num
  }
  return max
}

// ─── Image Migration ───────────────────────────────────────────────

/**
 * Migrate images referenced in an XML fragment from source to target document.
 *
 * @param sourceEntries - Source DOCX ZIP entries (Map<path, Buffer>)
 * @param targetRelsXml - Target document's word/_rels/document.xml.rels content
 * @param xmlFragment - The XML fragment being copied
 * @param imageRefs - Image references collected from the fragment
 * @param sourceRelsXml - Source document's word/_rels/document.xml.rels content
 * @param existingTargetEntries - Existing target ZIP entries (to check for conflicts)
 */
export function migrateImages(
  sourceEntries: Map<string, Buffer>,
  targetRelsXml: string,
  xmlFragment: string,
  imageRefs: ImageRef[],
  sourceRelsXml: string,
  existingTargetEntries: Map<string, Buffer>,
): ImageMigrationResult {
  if (imageRefs.length === 0) {
    return { updatedFragment: xmlFragment, newMediaFiles: [], newRelEntries: [] }
  }

  const sourceRels = parseRels(sourceRelsXml)
  let nextRId = findMaxRId(targetRelsXml) + 1

  // Deduplicate: same source rId should map to one new rId
  const rIdRemap = new Map<string, string>()
  const newMediaFiles: MigratedImage[] = []
  const newRelEntries: string[] = []

  // Track used media file names in target
  const usedMediaNames = new Set<string>()
  for (const [path] of existingTargetEntries) {
    if (path.startsWith("word/media/")) {
      usedMediaNames.add(path)
    }
  }

  for (const ref of imageRefs) {
    if (rIdRemap.has(ref.rId)) continue // Already processed

    // Find the source relationship
    const srcRel = sourceRels.find((r) => r.id === ref.rId)
    if (!srcRel) {
      rIdRemap.set(ref.rId, ref.rId) // Keep unchanged if not found
      continue
    }

    // Resolve source media path
    const srcMediaPath = srcRel.target.startsWith("/")
      ? srcRel.target.substring(1)
      : `word/${srcRel.target}`

    const mediaData = sourceEntries.get(srcMediaPath)
    if (!mediaData) {
      rIdRemap.set(ref.rId, ref.rId)
      continue
    }

    // Generate unique target media path
    let targetMediaPath = srcMediaPath
    if (usedMediaNames.has(targetMediaPath)) {
      const ext = targetMediaPath.match(/\.\w+$/)?.[0] ?? ".bin"
      const baseName = targetMediaPath.replace(/\.\w+$/, "")
      let suffix = 1
      while (usedMediaNames.has(`${baseName}_${suffix}${ext}`)) {
        suffix++
      }
      targetMediaPath = `${baseName}_${suffix}${ext}`
    }
    usedMediaNames.add(targetMediaPath)

    // Generate new rId
    const newRId = `rId${nextRId++}`
    rIdRemap.set(ref.rId, newRId)

    newMediaFiles.push({
      originalRId: ref.rId,
      newRId,
      targetMediaPath,
      data: mediaData,
    })

    // Build relationship entry
    const relTarget = targetMediaPath.replace(/^word\//, "")
    newRelEntries.push(
      `<Relationship Id="${newRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${relTarget}"/>`,
    )
  }

  // Rewrite rId references in the fragment
  let updatedFragment = xmlFragment
  for (const [oldRId, newRId] of rIdRemap) {
    if (oldRId !== newRId) {
      updatedFragment = updatedFragment.replace(
        new RegExp(`r:embed="${escapeRegex(oldRId)}"`, "g"),
        `r:embed="${newRId}"`,
      )
    }
  }

  return { updatedFragment, newMediaFiles, newRelEntries }
}

// ─── Merge Relationships ───────────────────────────────────────────

/**
 * Merge new relationship entries into the target document.xml.rels.
 */
export function mergeRelationships(targetRelsXml: string, newRelEntries: string[]): string {
  if (newRelEntries.length === 0) return targetRelsXml

  const closeTag = "</Relationships>"
  const closeIdx = targetRelsXml.lastIndexOf(closeTag)
  if (closeIdx === -1) return targetRelsXml

  return (
    targetRelsXml.substring(0, closeIdx) +
    newRelEntries.join("\n") +
    "\n" +
    closeTag
  )
}

// ─── Utils ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
