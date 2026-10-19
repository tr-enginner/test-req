import { readFileSync, writeFileSync } from "fs"

/**
 * GBK encoding/decoding utilities for AUnit gson files.
 *
 * AUnit (Java) on Chinese Windows writes gson files in GBK encoding (system default).
 * We must read/write gson files in GBK to avoid garbled Chinese characters.
 *
 * Uses TextDecoder('gbk') for decoding (built-in WHATWG Encoding API).
 * Builds a reverse lookup table from TextDecoder for encoding back to GBK.
 * No external dependencies required.
 */

/** Lazy-initialized GBK encoding map: Unicode char → GBK 2-byte sequence */
let gbkEncodeMap: Map<string, Uint8Array> | null = null

function ensureGbkEncodeMap(): Map<string, Uint8Array> {
  if (gbkEncodeMap) return gbkEncodeMap

  gbkEncodeMap = new Map()
  const decoder = new TextDecoder("gbk" as ConstructorParameters<typeof TextDecoder>[0])

  // GBK double-byte range: high byte 0x81-0xFE, low byte 0x40-0xFE (skip 0x7F)
  for (let high = 0x81; high <= 0xfe; high++) {
    for (let low = 0x40; low <= 0xfe; low++) {
      if (low === 0x7f) continue
      const bytes = new Uint8Array([high, low])
      const char = decoder.decode(bytes)
      // Only map valid characters (not replacement char, single char)
      if (char && char !== "\ufffd" && char.length === 1) {
        gbkEncodeMap.set(char, bytes)
      }
    }
  }

  return gbkEncodeMap
}

/** Encode a JavaScript string to GBK bytes */
export function encodeGbk(str: string): Uint8Array {
  const map = ensureGbkEncodeMap()
  const result: number[] = []

  for (const char of str) {
    const code = char.charCodeAt(0)
    if (code < 0x80) {
      // ASCII: single byte
      result.push(code)
    } else {
      const bytes = map.get(char)
      if (bytes) {
        result.push(bytes[0], bytes[1])
      } else {
        // Unknown character → '?'
        result.push(0x3f)
      }
    }
  }

  return new Uint8Array(result)
}

/** Decode GBK bytes to a JavaScript string */
export function decodeGbk(buffer: Buffer | Uint8Array): string {
  return new TextDecoder("gbk" as ConstructorParameters<typeof TextDecoder>[0]).decode(buffer)
}

/** Read a gson file with GBK decoding and parse as JSON */
export function readGsonFile(path: string): any {
  const buffer = readFileSync(path)
  const text = decodeGbk(buffer)
  return JSON.parse(text)
}

/** Stringify data as JSON and write to a gson file with GBK encoding */
export function writeGsonFile(path: string, data: any): void {
  const text = JSON.stringify(data, null, 2)
  const buffer = encodeGbk(text)
  writeFileSync(path, buffer)
}
