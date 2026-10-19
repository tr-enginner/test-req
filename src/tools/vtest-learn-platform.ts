import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join, resolve, basename, extname } from "path"
import * as jsonc from "jsonc-parser/lib/esm/main.js"

/** File extensions to load as documentation */
const DOC_EXTENSIONS = new Set([".md", ".txt", ".h"])

/** File extensions to scan for source code pin extraction */
const SRC_EXTENSIONS = new Set([".c", ".cpp", ".h"])

/** Default max total doc size in KB */
const DEFAULT_MAX_DOC_SIZE_KB = 500

interface PortDef {
  id: string
  name: string
  type: string
}

interface SourcePortInfo {
  source_file: string
  ports: PortDef[]
  properties: string[]
}

/**
 * Recursively collect files with given extensions from a directory.
 */
function collectFiles(dir: string, extensions: Set<string>): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...collectFiles(fullPath, extensions))
      } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        results.push(fullPath)
      }
    }
  } catch { /* permission errors, etc. */ }
  return results
}

/**
 * Extract port definitions from VTest simulator source code.
 *
 * Looks for:
 * 1. vttPORT gPorts[] array: `{ ID, "NAME", TYPE }` entries
 * 2. Port ID enums: `enum ... { PIN_INT = 0, SERIAL = 1, ... }`
 * 3. Attribute name arrays: `gAttrName[] = { "BaseAddress", ... }`
 */
function extractPortDefinitions(filePath: string, content: string): SourcePortInfo {
  const ports: PortDef[] = []
  const properties: string[] = []

  // Match vttPORT array entries: { <id_or_number>, "<name>", <type> }
  const portArrayRegex = /\{\s*(\w+)\s*,\s*"([^"]+)"\s*,\s*(\w+)\s*\}/g
  let match: RegExpExecArray | null

  // First, try to find gPorts array definition context
  const gPortsMatch = content.match(/(?:vttPORT\s+\w*(?:gPorts|g_ports|Ports)\s*\[\s*\]\s*=\s*\{)([\s\S]*?)\}\s*;/i)
  if (gPortsMatch) {
    const portsBlock = gPortsMatch[1]
    while ((match = portArrayRegex.exec(portsBlock)) !== null) {
      ports.push({ id: match[1], name: match[2], type: match[3] })
    }
  }

  // Also try generic vttPORT array pattern (different naming conventions)
  if (ports.length === 0) {
    const genericPortMatch = content.match(/vttPORT\s+\w+\s*\[\s*\]\s*=\s*\{([\s\S]*?)\}\s*;/i)
    if (genericPortMatch) {
      const portsBlock = genericPortMatch[1]
      while ((match = portArrayRegex.exec(portsBlock)) !== null) {
        ports.push({ id: match[1], name: match[2], type: match[3] })
      }
    }
  }

  // Extract enum definitions for port IDs (e.g., enum { PIN_INT = 0, SERIAL = 1, ... })
  const enumRegex = /enum\s*(?:\w+\s*)?\{([^}]+)\}/g
  while ((match = enumRegex.exec(content)) !== null) {
    const enumBody = match[1]
    const enumEntries = enumBody.match(/(\w+)\s*=\s*(\d+)/g)
    if (enumEntries && enumEntries.length > 0) {
      for (const entry of enumEntries) {
        const parts = entry.match(/(\w+)\s*=\s*(\d+)/)
        if (parts) {
          const enumName = parts[1]
          const enumValue = parts[2]
          for (const port of ports) {
            if (port.id === enumValue) {
              port.id = enumName
            }
          }
        }
      }
    }
  }

  // Extract attribute/property name arrays: gAttrName[] = { "Attr1", "Attr2", ... }
  const attrRegex = /(?:gAttrName|g_attr_name|AttrName|g_PropName|PropNames?)\s*\[\s*\]\s*=\s*\{([^}]+)\}/i
  const attrMatch = content.match(attrRegex)
  if (attrMatch) {
    const attrBlock = attrMatch[1]
    const strRegex = /"([^"]+)"/g
    let strMatch: RegExpExecArray | null
    while ((strMatch = strRegex.exec(attrBlock)) !== null) {
      properties.push(strMatch[1])
    }
  }

  // Fallback: look for DeviceProperty-related string literals in switch/if blocks
  if (properties.length === 0) {
    const propCaseRegex = /(?:case\s+"([^"]+)"|strcmp\s*\([^,]+,\s*"([^"]+)"\))/g
    const propSet = new Set<string>()
    while ((match = propCaseRegex.exec(content)) !== null) {
      const prop = match[1] || match[2]
      if (prop && /^[A-Z]/.test(prop)) {
        propSet.add(prop)
      }
    }
    properties.push(...propSet)
  }

  return {
    source_file: basename(filePath),
    ports,
    properties,
  }
}

/**
 * Read config paths from .matrix/config/matrix.jsonc
 */
function readConfigPaths(): { docsPaths: string[]; srcPaths: string[] } {
  const configPath = join(process.cwd(), ".matrix/config/matrix.jsonc")
  if (!existsSync(configPath)) {
    return { docsPaths: [], srcPaths: [] }
  }
  try {
    const cfg = jsonc.parse(readFileSync(configPath, "utf-8")) ?? {}
    return {
      docsPaths: Array.isArray(cfg.vtest_docs_paths) ? cfg.vtest_docs_paths : [],
      srcPaths: Array.isArray(cfg.vtest_src_paths) ? cfg.vtest_src_paths : [],
    }
  } catch {
    return { docsPaths: [], srcPaths: [] }
  }
}

/**
 * vtest_learn_platform — Read VTest platform docs and extract simulator pin definitions.
 * Used by: EnvArchitect agent (Phase 5, Step 0.5)
 */
export const vtestLearnPlatform: ToolDefinition = tool({
  description:
    "Read VTest platform reference documentation and simulator source code. " +
    "Returns documentation content and structured port/pin definitions extracted from simulator gPorts arrays. " +
    "Use this to learn VTest mechanisms (MainProc, vtestc CLI, VTE format) and discover existing simulator pin names before generating VTest environments.",
  args: {
    docs_paths: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Override vtest_docs_paths config: directories containing .md/.txt/.h reference docs"),
    src_paths: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Override vtest_src_paths config: directories containing simulator .c/.cpp/.h source code"),
    max_doc_size_kb: tool.schema
      .number()
      .optional()
      .describe("Maximum total documentation size in KB before truncation (default: 500)"),
  },
  async execute({ docs_paths, src_paths, max_doc_size_kb }) {
    const config = readConfigPaths()
    const docsPaths = (docs_paths && docs_paths.length > 0)
      ? docs_paths
      : config.docsPaths
    const srcPaths = (src_paths && src_paths.length > 0)
      ? src_paths
      : config.srcPaths
    const maxDocSizeBytes = (max_doc_size_kb ?? DEFAULT_MAX_DOC_SIZE_KB) * 1024

    // --- Documentation loading ---
    const docParts: string[] = []
    let docsLoaded = 0
    let totalDocBytes = 0
    let truncated = false

    for (const dirPath of docsPaths) {
      const resolvedDir = resolve(dirPath)
      const files = collectFiles(resolvedDir, DOC_EXTENSIONS).sort()
      for (const filePath of files) {
        try {
          const content = readFileSync(filePath, "utf-8")
          const contentBytes = Buffer.byteLength(content, "utf-8")
          if (totalDocBytes + contentBytes > maxDocSizeBytes) {
            const remaining = maxDocSizeBytes - totalDocBytes
            if (remaining > 0) {
              docParts.push(`\n--- ${basename(filePath)} (truncated) ---\n`)
              docParts.push(content.slice(0, remaining))
            }
            truncated = true
            docsLoaded++
            totalDocBytes = maxDocSizeBytes
            break
          }
          docParts.push(`\n--- ${basename(filePath)} ---\n`)
          docParts.push(content)
          docsLoaded++
          totalDocBytes += contentBytes
        } catch { /* skip unreadable files */ }
      }
      if (truncated) break
    }

    // --- Source code pin extraction ---
    const portDefinitions: SourcePortInfo[] = []
    let sourceFilesScanned = 0

    for (const dirPath of srcPaths) {
      const resolvedDir = resolve(dirPath)
      const files = collectFiles(resolvedDir, SRC_EXTENSIONS).sort()
      for (const filePath of files) {
        try {
          const content = readFileSync(filePath, "utf-8")
          sourceFilesScanned++
          const info = extractPortDefinitions(filePath, content)
          if (info.ports.length > 0 || info.properties.length > 0) {
            portDefinitions.push(info)
          }
        } catch { /* skip unreadable files */ }
      }
    }

    const documentation = docParts.join("")
    const docsTotalSizeKb = Math.round(totalDocBytes / 1024 * 10) / 10

    if (docsLoaded === 0 && sourceFilesScanned === 0) {
      return JSON.stringify({
        status: "no_data",
        message:
          "No documentation or source paths configured. Set vtest_docs_paths and/or vtest_src_paths in .matrix/config/matrix.jsonc, or pass them as tool parameters.",
        docs_loaded: 0,
        docs_total_size_kb: 0,
        source_files_scanned: 0,
        port_definitions: [],
        documentation: "",
      })
    }

    return JSON.stringify({
      status: "success",
      docs_loaded: docsLoaded,
      docs_total_size_kb: docsTotalSizeKb,
      ...(truncated ? { docs_truncated: true, max_doc_size_kb: max_doc_size_kb ?? DEFAULT_MAX_DOC_SIZE_KB } : {}),
      source_files_scanned: sourceFilesScanned,
      port_definitions: portDefinitions,
      documentation,
    })
  },
})
