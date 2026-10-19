#!/usr/bin/env bun
/**
 * postinstall — download bundled open-source tool binaries for the current platform.
 * Runs automatically after `bun install`.
 * Binaries are placed in <project-root>/bin/ and shipped with the package.
 *
 * To add a new bundled binary:
 * 1. Add an entry to the TOOLS array below (name, version, asset resolver)
 * 2. In the corresponding tool .ts file, use resolveBin() to reference it at runtime
 */
import { existsSync, mkdirSync, chmodSync, unlinkSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"

const ROOT = join(import.meta.dir, "..")
const BIN_DIR = join(ROOT, "bin")

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ToolAsset {
  url: string
  binary: string
  archiveExt: string
}

interface BundledTool {
  name: string
  version: string
  asset: () => ToolAsset
}

const TOOLS: BundledTool[] = [
  {
    name: "mdbook",
    version: "0.4.40",
    asset() {
      const v = this.version
      const platform = process.platform
      const arch = process.arch
      if (platform === "win32") {
        return {
          url: `https://github.com/rust-lang/mdBook/releases/download/v${v}/mdbook-v${v}-x86_64-pc-windows-msvc.zip`,
          binary: "mdbook.exe",
          archiveExt: "zip",
        }
      }
      if (platform === "darwin") {
        const target =
          arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
        return {
          url: `https://github.com/rust-lang/mdBook/releases/download/v${v}/mdbook-v${v}-${target}.tar.gz`,
          binary: "mdbook",
          archiveExt: "tar.gz",
        }
      }
      {
        const target =
          arch === "arm64"
            ? "aarch64-unknown-linux-gnu"
            : "x86_64-unknown-linux-gnu"
        return {
          url: `https://github.com/rust-lang/mdBook/releases/download/v${v}/mdbook-v${v}-${target}.tar.gz`,
          binary: "mdbook",
          archiveExt: "tar.gz",
        }
      }
    },
  },
  {
    name: "ast-grep",
    version: "0.38.1",
    asset() {
      const v = this.version
      const platform = process.platform
      const arch = process.arch
      if (platform === "win32") {
        return {
          url: `https://github.com/ast-grep/ast-grep/releases/download/${v}/app-x86_64-pc-windows-msvc.zip`,
          binary: "sg.exe",
          archiveExt: "zip",
        }
      }
      if (platform === "darwin") {
        const target =
          arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
        return {
          url: `https://github.com/ast-grep/ast-grep/releases/download/${v}/app-${target}.zip`,
          binary: "sg",
          archiveExt: "zip",
        }
      }
      {
        const target =
          arch === "arm64"
            ? "aarch64-unknown-linux-gnu"
            : "x86_64-unknown-linux-gnu"
        return {
          url: `https://github.com/ast-grep/ast-grep/releases/download/${v}/app-${target}.zip`,
          binary: "sg",
          archiveExt: "zip",
        }
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Download logic
// ---------------------------------------------------------------------------

function downloadAndExtract(tool: BundledTool): void {
  const asset = tool.asset()
  const binaryPath = join(BIN_DIR, asset.binary)

  if (existsSync(binaryPath)) {
    console.log(`  ${tool.name} — already exists, skipping.`)
    return
  }

  console.log(`  ${tool.name} v${tool.version} — downloading...`)

  const archivePath = join(BIN_DIR, `${tool.name}-archive.${asset.archiveExt}`)

  execSync(`curl -fsSL -o "${archivePath}" "${asset.url}"`, {
    stdio: "inherit",
    timeout: 120_000,
  })

  if (asset.archiveExt === "zip") {
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Force '${archivePath}' '${BIN_DIR}'"`,
        { stdio: "inherit", timeout: 30_000 },
      )
    } else {
      execSync(`unzip -o "${archivePath}" -d "${BIN_DIR}"`, {
        stdio: "inherit",
        timeout: 30_000,
      })
    }
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${BIN_DIR}"`, {
      stdio: "inherit",
      timeout: 30_000,
    })
  }

  unlinkSync(archivePath)

  if (process.platform !== "win32") {
    chmodSync(binaryPath, 0o755)
  }

  console.log(`  ${tool.name} v${tool.version} — installed to ${binaryPath}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!existsSync(BIN_DIR)) {
  mkdirSync(BIN_DIR, { recursive: true })
}

console.log("Installing bundled tool binaries...")

let failed = false
for (const tool of TOOLS) {
  try {
    downloadAndExtract(tool)
  } catch (err) {
    console.error(
      `  ${tool.name} — FAILED: ${err instanceof Error ? err.message : String(err)}`,
    )
    failed = true
  }
}

if (failed) {
  console.error("Some tools failed to install. Plugin features may be limited.")
  process.exit(1)
}

console.log("Done.")
