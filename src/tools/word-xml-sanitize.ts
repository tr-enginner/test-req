const WORD_XML_TAG_RE = /<\/?(?:w|v|o|mc|wp|a|r):[A-Za-z][^>]*\/?>/gi
const WORD_XML_BLOCK_RE = /<(?:w:object|v:shape|o:OLEObject|w:drawing|w:pict)\b[\s\S]*?<\/(?:w:object|v:shape|o:OLEObject|w:drawing|w:pict)>/gi
const WORD_XML_SELF_CLOSING_OBJECT_RE = /<(?:v:shape|o:OLEObject|w:object|w:drawing|w:pict)\b[^>]*\/>/gi

export function hasWordXmlMarkup(value: string): boolean {
  return /<\/?(?:w|v|o|mc|wp|a|r):[A-Za-z][^>]*\/?>/i.test(value)
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

export function sanitizeWordXmlText(value: string): string {
  if (!value) return ""

  const decoded = decodeXmlEntities(value)
    .replace(WORD_XML_BLOCK_RE, " ")
    .replace(WORD_XML_SELF_CLOSING_OBJECT_RE, " ")
    .replace(/<w:tab\b[^>]*\/>/gi, "\t")
    .replace(/<w:br\b[^>]*\/>/gi, "\n")
    .replace(WORD_XML_TAG_RE, " ")

  return decoded
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function sanitizePossibleWordXmlLine(line: string): string {
  return hasWordXmlMarkup(line) || /&lt;\/?(?:w|v|o|mc|wp|a|r):/i.test(line) ? sanitizeWordXmlText(line) : line
}

export function sanitizePossibleWordXmlText(value: string): string {
  return hasWordXmlMarkup(value) || /&lt;\/?(?:w|v|o|mc|wp|a|r):/i.test(value) ? sanitizeWordXmlText(value) : value
}
