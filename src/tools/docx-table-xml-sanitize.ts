const RELATIONSHIP_ATTR_RE = /\s+r:(?:id|embed|link)=(?:"[^"]*"|'[^']*')/gi
const MEDIA_BLOCK_TAGS = [
  "mc:AlternateContent",
  "w:drawing",
  "w:pict",
  "w:object",
  "wp:inline",
  "wp:anchor",
  "a:graphic",
  "pic:pic",
  "v:shape",
  "v:group",
]
const MEDIA_SELF_CLOSING_TAGS = [
  ...MEDIA_BLOCK_TAGS,
  "a:blip",
  "v:imagedata",
  "o:OLEObject",
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function removeXmlElementBlocks(xml: string, tagName: string): string {
  const escaped = escapeRegExp(tagName)
  const blockRe = new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi")
  const selfClosingRe = new RegExp(`<${escaped}\\b[^>]*/>`, "gi")
  let previous = xml
  let next = previous.replace(blockRe, "").replace(selfClosingRe, "")

  while (next !== previous) {
    previous = next
    next = previous.replace(blockRe, "").replace(selfClosingRe, "")
  }

  return next
}

export function sanitizeDocxTableAssetXml(tableXml: string): string {
  let cleaned = tableXml
  for (const tagName of MEDIA_BLOCK_TAGS) {
    cleaned = removeXmlElementBlocks(cleaned, tagName)
  }
  for (const tagName of MEDIA_SELF_CLOSING_TAGS) {
    const escaped = escapeRegExp(tagName)
    cleaned = cleaned.replace(new RegExp(`<${escaped}\\b[^>]*/>`, "gi"), "")
  }
  return cleaned.replace(RELATIONSHIP_ATTR_RE, "")
}

export function hasDocxTableRelationshipReferences(tableXml: string): boolean {
  RELATIONSHIP_ATTR_RE.lastIndex = 0
  return RELATIONSHIP_ATTR_RE.test(tableXml)
}
