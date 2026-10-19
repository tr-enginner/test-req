#!/usr/bin/env bun
/**
 * pdf-extract.ts — Standalone PDF text extraction CLI
 *
 * Usage: bun bin/pdf-extract.ts <pdf-path> [--per-page]
 *
 * Default: outputs merged text (all pages joined with newlines)
 * --per-page: outputs JSON { totalPages, pages: string[] }
 *
 * Depends only on `unpdf` (installed via package.json).
 */

import { extractText, getDocumentProxy } from "unpdf"

const args = process.argv.slice(2)
const perPage = args.includes("--per-page")
const pdfPath = args.find((a) => !a.startsWith("--"))

if (!pdfPath) {
  process.stderr.write("Usage: bun bin/pdf-extract.ts <pdf-path> [--per-page]\n")
  process.exit(1)
}

const file = Bun.file(pdfPath)

if (!(await file.exists())) {
  process.stderr.write(`File not found: ${pdfPath}\n`)
  process.exit(1)
}

const buffer = await file.arrayBuffer()
const proxy = await getDocumentProxy(new Uint8Array(buffer), {
  standardFontDataUrl: "data:application/octet-stream;base64,",
})
const pdf = await extractText(proxy)

if (perPage) {
  const output = JSON.stringify({
    totalPages: pdf.totalPages,
    pages: pdf.text,
  })
  process.stdout.write(output)
} else {
  // Join all page texts with double newlines
  const text = pdf.text.join("\n\n")
  process.stdout.write(text)
}
