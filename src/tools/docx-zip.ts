/**
 * docx-zip.ts — Minimal ZIP read/write utility for DOCX files.
 *
 * DOCX is a ZIP archive containing XML files. This module provides
 * simple read/write operations without external dependencies, using
 * only Node.js-compatible zlib (available in Bun).
 *
 * Used by: issue-report-generator.ts, create-issue-report-template.ts
 */

import { deflateRawSync, inflateRawSync } from "node:zlib"

// ─── ZIP Format Constants ──────────────────────────────────────────

const LOCAL_FILE_HEADER_SIG = 0x04034b50
const CENTRAL_DIR_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const COMPRESSION_DEFLATE = 8
const COMPRESSION_STORE = 0

// ─── Types ─────────────────────────────────────────────────────────

export interface ZipEntry {
  path: string
  data: Buffer
}

// ─── CRC32 ─────────────────────────────────────────────────────────

const crc32Table = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  crc32Table[i] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ─── Read ZIP ──────────────────────────────────────────────────────

/**
 * Read all entries from a ZIP buffer.
 * Returns a Map of path → Buffer for each file in the archive.
 */
export function readZip(zipBuffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()

  // Find End of Central Directory record (search backwards)
  let eocdOffset = -1
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) throw new Error("Invalid ZIP: EOCD not found")

  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16)
  const cdEntries = zipBuffer.readUInt16LE(eocdOffset + 10)

  let pos = cdOffset
  for (let i = 0; i < cdEntries; i++) {
    if (zipBuffer.readUInt32LE(pos) !== CENTRAL_DIR_SIG) {
      throw new Error(`Invalid ZIP: bad central directory entry at ${pos}`)
    }

    const compression = zipBuffer.readUInt16LE(pos + 10)
    const compressedSize = zipBuffer.readUInt32LE(pos + 20)
    const uncompressedSize = zipBuffer.readUInt32LE(pos + 24)
    const nameLen = zipBuffer.readUInt16LE(pos + 28)
    const extraLen = zipBuffer.readUInt16LE(pos + 30)
    const commentLen = zipBuffer.readUInt16LE(pos + 32)
    const localHeaderOffset = zipBuffer.readUInt32LE(pos + 42)

    const name = zipBuffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf-8")

    // Skip directories
    if (!name.endsWith("/")) {
      // Read from local file header to get actual data offset
      const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26)
      const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28)
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen

      const compressedData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize)

      let data: Buffer
      if (compression === COMPRESSION_STORE) {
        data = Buffer.from(compressedData)
      } else if (compression === COMPRESSION_DEFLATE) {
        data = inflateRawSync(compressedData)
      } else {
        throw new Error(`Unsupported compression method: ${compression}`)
      }

      entries.set(name, data)
    }

    pos += 46 + nameLen + extraLen + commentLen
  }

  return entries
}

// ─── Write ZIP ─────────────────────────────────────────────────────

interface CentralDirEntry {
  path: string
  crc: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  compression: number
}

/**
 * Create a ZIP buffer from a list of entries.
 * Small text files are stored uncompressed, larger files use DEFLATE.
 */
export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const cdEntries: CentralDirEntry[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.path, "utf-8")
    const crc = crc32(entry.data)
    const uncompressedSize = entry.data.length

    // Use DEFLATE for files > 512 bytes, STORE for small files
    let compression: number
    let compressedData: Buffer
    if (uncompressedSize > 512) {
      compression = COMPRESSION_DEFLATE
      compressedData = deflateRawSync(entry.data)
      // If deflate doesn't save space, store instead
      if (compressedData.length >= uncompressedSize) {
        compression = COMPRESSION_STORE
        compressedData = entry.data
      }
    } else {
      compression = COMPRESSION_STORE
      compressedData = entry.data
    }

    const compressedSize = compressedData.length

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30 + nameBuffer.length)
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0)
    localHeader.writeUInt16LE(20, 4)   // version needed
    localHeader.writeUInt16LE(0, 6)    // flags
    localHeader.writeUInt16LE(compression, 8)
    localHeader.writeUInt16LE(0, 10)   // mod time
    localHeader.writeUInt16LE(0, 12)   // mod date
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressedSize, 18)
    localHeader.writeUInt32LE(uncompressedSize, 22)
    localHeader.writeUInt16LE(nameBuffer.length, 26)
    localHeader.writeUInt16LE(0, 28)   // extra field length
    nameBuffer.copy(localHeader, 30)

    cdEntries.push({
      path: entry.path,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset: offset,
      compression,
    })

    parts.push(localHeader)
    parts.push(compressedData)
    offset += localHeader.length + compressedData.length
  }

  // Central directory
  const cdStart = offset
  for (const cd of cdEntries) {
    const nameBuffer = Buffer.from(cd.path, "utf-8")
    const cdHeader = Buffer.alloc(46 + nameBuffer.length)
    cdHeader.writeUInt32LE(CENTRAL_DIR_SIG, 0)
    cdHeader.writeUInt16LE(20, 4)   // version made by
    cdHeader.writeUInt16LE(20, 6)   // version needed
    cdHeader.writeUInt16LE(0, 8)    // flags
    cdHeader.writeUInt16LE(cd.compression, 10)
    cdHeader.writeUInt16LE(0, 12)   // mod time
    cdHeader.writeUInt16LE(0, 14)   // mod date
    cdHeader.writeUInt32LE(cd.crc, 16)
    cdHeader.writeUInt32LE(cd.compressedSize, 20)
    cdHeader.writeUInt32LE(cd.uncompressedSize, 24)
    cdHeader.writeUInt16LE(nameBuffer.length, 28)
    cdHeader.writeUInt16LE(0, 30)   // extra field length
    cdHeader.writeUInt16LE(0, 32)   // comment length
    cdHeader.writeUInt16LE(0, 34)   // disk number
    cdHeader.writeUInt16LE(0, 36)   // internal attrs
    cdHeader.writeUInt32LE(0, 38)   // external attrs
    cdHeader.writeUInt32LE(cd.localHeaderOffset, 42)
    nameBuffer.copy(cdHeader, 46)

    parts.push(cdHeader)
    offset += cdHeader.length
  }

  const cdSize = offset - cdStart

  // End of central directory
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)                    // disk number
  eocd.writeUInt16LE(0, 6)                    // disk with CD
  eocd.writeUInt16LE(cdEntries.length, 8)     // entries on this disk
  eocd.writeUInt16LE(cdEntries.length, 10)    // total entries
  eocd.writeUInt32LE(cdSize, 12)              // CD size
  eocd.writeUInt32LE(cdStart, 16)             // CD offset
  eocd.writeUInt16LE(0, 20)                   // comment length

  parts.push(eocd)

  return Buffer.concat(parts)
}

/**
 * Convenience: read a ZIP file, modify some entries, write back.
 * Returns a new ZIP buffer with the modified entries.
 */
export function modifyZip(
  zipBuffer: Buffer,
  modifier: (entries: Map<string, Buffer>) => Map<string, Buffer>,
): Buffer {
  const entries = readZip(zipBuffer)
  const modified = modifier(entries)

  const zipEntries: ZipEntry[] = []
  for (const [path, data] of modified) {
    zipEntries.push({ path, data })
  }

  return writeZip(zipEntries)
}
