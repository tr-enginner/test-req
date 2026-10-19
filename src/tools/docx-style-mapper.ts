/**
 * docx-style-mapper.ts — Cross-document style ID mapping and merging.
 *
 * When copying content from a reference document to a template, styles may have
 * different IDs for the same name. This module builds a mapping table and rewrites
 * style references in extracted XML fragments.
 *
 * Migrated from Python _copy_missing_styles_to_template_with_mapping().
 */

export interface StyleIdMapping {
  /** source styleId → target styleId */
  pStyle: Map<string, string>
  rStyle: Map<string, string>
  tblStyle: Map<string, string>
  /** New style definitions to append to template styles.xml */
  newStyleDefs: string[]
}

interface StyleInfo {
  styleId: string
  name: string
  type: string   // paragraph, character, table, numbering
  xmlDef: string // full <w:style>...</w:style> XML
}

// ─── Style XML Parsing ─────────────────────────────────────────────

function parseStyles(stylesXml: string): StyleInfo[] {
  const styles: StyleInfo[] = []
  const styleRegex = /<w:style\s+[^>]*?w:type="([^"]+)"[^>]*?w:styleId="([^"]+)"[^>]*?>([\s\S]*?)<\/w:style>/g
  let m: RegExpExecArray | null

  while ((m = styleRegex.exec(stylesXml)) !== null) {
    const type = m[1]
    const styleId = m[2]
    const body = m[3]
    const fullDef = m[0]

    // Extract name
    const nameMatch = body.match(/<w:name\s+w:val="([^"]+)"/)
    const name = nameMatch?.[1] ?? styleId

    styles.push({ styleId, name, type, xmlDef: fullDef })
  }

  return styles
}

// ─── Build Mapping ─────────────────────────────────────────────────

/**
 * Compare source and template styles.xml to build a mapping from source style IDs
 * to template style IDs. Styles that exist only in source get new unique IDs.
 */
export function buildStyleMapping(
  sourceStylesXml: string,
  templateStylesXml: string,
): StyleIdMapping {
  const sourceStyles = parseStyles(sourceStylesXml)
  const templateStyles = parseStyles(templateStylesXml)

  // Build template lookups by name
  const templateByName = new Map<string, StyleInfo>()
  const templateById = new Set<string>()
  for (const s of templateStyles) {
    templateByName.set(s.name, s)
    templateById.add(s.styleId)
  }

  const mapping: StyleIdMapping = {
    pStyle: new Map(),
    rStyle: new Map(),
    tblStyle: new Map(),
    newStyleDefs: [],
  }

  let idCounter = 1000

  for (const srcStyle of sourceStyles) {
    const existingByName = templateByName.get(srcStyle.name)

    if (existingByName) {
      // Same name exists in template — map source ID to template ID
      addToMapping(mapping, srcStyle.type, srcStyle.styleId, existingByName.styleId)
    } else if (templateById.has(srcStyle.styleId)) {
      // Same ID but different name — generate a new unique ID
      let newId: string
      do {
        newId = `imported_${idCounter++}`
      } while (templateById.has(newId))

      templateById.add(newId)
      addToMapping(mapping, srcStyle.type, srcStyle.styleId, newId)

      // Rewrite the style definition with the new ID
      const newDef = srcStyle.xmlDef.replace(
        new RegExp(`w:styleId="${escapeRegex(srcStyle.styleId)}"`),
        `w:styleId="${newId}"`,
      )
      mapping.newStyleDefs.push(newDef)
    } else {
      // ID doesn't exist in template — copy as-is (identity mapping)
      addToMapping(mapping, srcStyle.type, srcStyle.styleId, srcStyle.styleId)
      mapping.newStyleDefs.push(srcStyle.xmlDef)
      templateById.add(srcStyle.styleId)
    }
  }

  return mapping
}

function addToMapping(
  mapping: StyleIdMapping,
  type: string,
  fromId: string,
  toId: string,
): void {
  if (fromId === toId) return // No mapping needed for identity
  switch (type) {
    case "paragraph":
      mapping.pStyle.set(fromId, toId)
      break
    case "character":
      mapping.rStyle.set(fromId, toId)
      break
    case "table":
      mapping.tblStyle.set(fromId, toId)
      break
  }
}

// ─── Apply Mapping ─────────────────────────────────────────────────

/**
 * Replace style references in an XML fragment using the mapping table.
 */
export function applyStyleMapping(xmlFragment: string, mapping: StyleIdMapping): string {
  let result = xmlFragment

  // Replace <w:pStyle w:val="..."/>
  for (const [from, to] of mapping.pStyle) {
    result = result.replace(
      new RegExp(`(<w:pStyle\\s+w:val=")${escapeRegex(from)}(")`, "g"),
      `$1${to}$2`,
    )
  }

  // Replace <w:rStyle w:val="..."/>
  for (const [from, to] of mapping.rStyle) {
    result = result.replace(
      new RegExp(`(<w:rStyle\\s+w:val=")${escapeRegex(from)}(")`, "g"),
      `$1${to}$2`,
    )
  }

  // Replace <w:tblStyle w:val="..."/>
  for (const [from, to] of mapping.tblStyle) {
    result = result.replace(
      new RegExp(`(<w:tblStyle\\s+w:val=")${escapeRegex(from)}(")`, "g"),
      `$1${to}$2`,
    )
  }

  return result
}

// ─── Merge Styles ──────────────────────────────────────────────────

/**
 * Merge new style definitions into the template's styles.xml.
 */
export function mergeStyles(templateStylesXml: string, newStyleDefs: string[]): string {
  if (newStyleDefs.length === 0) return templateStylesXml

  // Insert before </w:styles>
  const closeTag = "</w:styles>"
  const closeIdx = templateStylesXml.lastIndexOf(closeTag)
  if (closeIdx === -1) return templateStylesXml

  return (
    templateStylesXml.substring(0, closeIdx) +
    newStyleDefs.join("\n") +
    "\n" +
    closeTag
  )
}

// ─── Utils ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
