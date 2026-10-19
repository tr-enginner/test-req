#!/usr/bin/env bun
/**
 * create-installer-assets — generate placeholder BMP and ICO files for the
 * NSIS Windows installer. These are minimal valid images (white fill) that
 * can be replaced by a designer later.
 *
 * Usage:
 *   bun scripts/create-installer-assets.ts
 *
 * Generated files:
 *   scripts/installer/matrix-banner.bmp  — 150x57 24-bit BMP (NSIS header image)
 *   scripts/installer/matrix-icon.ico    — 16x16 32-bit ICO  (installer icon)
 */
import { existsSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

// Compatible with both Bun (import.meta.dir) and Node/tsx (import.meta.url)
const __dirname =
  (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const INSTALLER_DIR = join(ROOT, "scripts", "installer")

// ---------------------------------------------------------------------------
// BMP generator — 150x57 24-bit white bitmap
// ---------------------------------------------------------------------------

function createBmp(width: number, height: number): Buffer {
  // BMP row stride: each row is padded to a multiple of 4 bytes
  const bytesPerPixel = 3
  const rowBytes = width * bytesPerPixel
  const rowPadding = (4 - (rowBytes % 4)) % 4
  const stride = rowBytes + rowPadding

  const pixelDataSize = stride * height
  const headerSize = 14 // BITMAPFILEHEADER
  const dibSize = 40 // BITMAPINFOHEADER
  const fileSize = headerSize + dibSize + pixelDataSize

  const buf = Buffer.alloc(fileSize, 0)

  // -- BITMAPFILEHEADER (14 bytes) --
  buf.write("BM", 0, "ascii") // signature
  buf.writeUInt32LE(fileSize, 2) // file size
  buf.writeUInt32LE(0, 6) // reserved
  buf.writeUInt32LE(headerSize + dibSize, 10) // pixel data offset

  // -- BITMAPINFOHEADER (40 bytes) --
  buf.writeUInt32LE(dibSize, 14) // DIB header size
  buf.writeInt32LE(width, 18) // width
  buf.writeInt32LE(height, 22) // height (positive = bottom-up)
  buf.writeUInt16LE(1, 26) // color planes
  buf.writeUInt16LE(24, 28) // bits per pixel
  buf.writeUInt32LE(0, 30) // compression (BI_RGB)
  buf.writeUInt32LE(pixelDataSize, 34) // image size
  buf.writeInt32LE(2835, 38) // x pixels per meter (~72 DPI)
  buf.writeInt32LE(2835, 42) // y pixels per meter
  buf.writeUInt32LE(0, 46) // colors in table
  buf.writeUInt32LE(0, 50) // important colors

  // -- Pixel data: fill with white (0xFF for each BGR channel) --
  const dataOffset = headerSize + dibSize
  for (let y = 0; y < height; y++) {
    const rowStart = dataOffset + y * stride
    for (let x = 0; x < width; x++) {
      const px = rowStart + x * bytesPerPixel
      buf[px] = 0xff // B
      buf[px + 1] = 0xff // G
      buf[px + 2] = 0xff // R
    }
    // Padding bytes remain 0 (already zeroed by Buffer.alloc)
  }

  return buf
}

// ---------------------------------------------------------------------------
// ICO generator — 16x16 32-bit white icon
// ---------------------------------------------------------------------------

function createIco(size: number): Buffer {
  // ICO format: ICONDIR + ICONDIRENTRY + BMP DIB (no file header) + pixel data
  const bytesPerPixel = 4 // BGRA
  const rowBytes = size * bytesPerPixel
  // ICO BMP rows are already 4-byte aligned at 32bpp for power-of-2 sizes
  const rowPadding = (4 - (rowBytes % 4)) % 4
  const stride = rowBytes + rowPadding

  // AND mask: 1bpp, each row padded to 4 bytes
  const andRowBytes = Math.ceil(size / 8)
  const andRowPadding = (4 - (andRowBytes % 4)) % 4
  const andStride = andRowBytes + andRowPadding
  const andMaskSize = andStride * size

  const dibSize = 40
  const pixelDataSize = stride * size
  const imageDataSize = dibSize + pixelDataSize + andMaskSize

  // ICONDIR (6 bytes) + 1 ICONDIRENTRY (16 bytes) + image data
  const iconDirSize = 6
  const iconDirEntrySize = 16
  const fileSize = iconDirSize + iconDirEntrySize + imageDataSize

  const buf = Buffer.alloc(fileSize, 0)

  // -- ICONDIR (6 bytes) --
  buf.writeUInt16LE(0, 0) // reserved
  buf.writeUInt16LE(1, 2) // type: 1 = ICO
  buf.writeUInt16LE(1, 4) // image count

  // -- ICONDIRENTRY (16 bytes) --
  const entryOffset = 6
  buf.writeUInt8(size, entryOffset) // width (0 means 256)
  buf.writeUInt8(size, entryOffset + 1) // height
  buf.writeUInt8(0, entryOffset + 2) // color palette count
  buf.writeUInt8(0, entryOffset + 3) // reserved
  buf.writeUInt16LE(1, entryOffset + 4) // color planes
  buf.writeUInt16LE(32, entryOffset + 6) // bits per pixel
  buf.writeUInt32LE(imageDataSize, entryOffset + 8) // image data size
  buf.writeUInt32LE(iconDirSize + iconDirEntrySize, entryOffset + 12) // offset to image data

  // -- BITMAPINFOHEADER (40 bytes) — height is doubled (XOR + AND mask) --
  const dibOffset = iconDirSize + iconDirEntrySize
  buf.writeUInt32LE(dibSize, dibOffset) // DIB header size
  buf.writeInt32LE(size, dibOffset + 4) // width
  buf.writeInt32LE(size * 2, dibOffset + 8) // height (doubled for ICO)
  buf.writeUInt16LE(1, dibOffset + 12) // color planes
  buf.writeUInt16LE(32, dibOffset + 14) // bits per pixel
  buf.writeUInt32LE(0, dibOffset + 16) // compression
  buf.writeUInt32LE(pixelDataSize + andMaskSize, dibOffset + 20) // image size
  buf.writeInt32LE(0, dibOffset + 24) // x ppm
  buf.writeInt32LE(0, dibOffset + 28) // y ppm
  buf.writeUInt32LE(0, dibOffset + 32) // colors used
  buf.writeUInt32LE(0, dibOffset + 36) // important colors

  // -- Pixel data: BGRA, white opaque --
  const pixelOffset = dibOffset + dibSize
  for (let y = 0; y < size; y++) {
    const rowStart = pixelOffset + y * stride
    for (let x = 0; x < size; x++) {
      const px = rowStart + x * bytesPerPixel
      buf[px] = 0xff // B
      buf[px + 1] = 0xff // G
      buf[px + 2] = 0xff // R
      buf[px + 3] = 0xff // A (fully opaque)
    }
  }

  // AND mask: all zeros (fully visible) — already zeroed by Buffer.alloc

  return buf
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  mkdirSync(INSTALLER_DIR, { recursive: true })

  const bannerPath = join(INSTALLER_DIR, "matrix-banner.bmp")
  if (existsSync(bannerPath)) {
    console.log(`[skip] ${bannerPath} already exists`)
  } else {
    const bmp = createBmp(150, 57)
    writeFileSync(bannerPath, bmp)
    console.log(`[created] ${bannerPath} (150x57 24-bit BMP, ${bmp.length} bytes)`)
  }

  const iconPath = join(INSTALLER_DIR, "matrix-icon.ico")
  if (existsSync(iconPath)) {
    console.log(`[skip] ${iconPath} already exists`)
  } else {
    const ico = createIco(16)
    writeFileSync(iconPath, ico)
    console.log(`[created] ${iconPath} (16x16 32-bit ICO, ${ico.length} bytes)`)
  }
}

main()
