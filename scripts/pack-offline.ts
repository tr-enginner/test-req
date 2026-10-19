#!/usr/bin/env bun
/**
 * pack-offline.ts — Offline packaging orchestrator
 *
 * Runs on a networked build machine. Collects all runtime artifacts into a
 * staging directory, then produces platform-specific installers:
 *   - Windows: NSIS .exe installer (requires makensis on PATH)
 *   - Linux:   tar.gz archive with embedded install.sh / uninstall.sh
 *
 * Usage:
 *   bun scripts/pack-offline.ts --platform <windows|linux|docker> --version <X.Y.Z> [--tools-archive <dir>] [--help]
 */
import {
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  readdirSync,
} from "fs"
import { resolve, join, basename, dirname } from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { execSync, execFileSync } from "child_process"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Bun uses import.meta.dir; Node/tsx uses import.meta.url
const __dir =
  (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, "..")
const STAGING_BASE = join(ROOT, ".pack-staging")
const RELEASE_DIR = join(ROOT, "release")
const INSTALLER_DIR = join(ROOT, "scripts", "installer")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Arch = "x64" | "aarch64"
type RuntimePlatform = "windows" | "linux"

interface PackOptions {
  platform: "windows" | "linux" | "docker"
  arch: Arch
  version: string
  toolsArchive: string
  nsisOnly: boolean
  skipArchive: boolean
  skipInstall: boolean
  skipBuild: boolean
}

const REQUIRED_RUNTIME_FILES: Record<RuntimePlatform, string[]> = {
  windows: ["bun.exe", "opencode.exe", "rg.exe"],
  linux: ["bun", "opencode", "rg"],
}

const REQUIRED_PDF_BUNDLE_MARKERS = [
  "PDF extraction failed",
  "getDocumentProxy",
  "extractText",
]

const REQUIRED_NODE_MODULE_ASSETS = [
  "web-tree-sitter/web-tree-sitter.wasm",
  "@repomix/tree-sitter-wasms/out/tree-sitter-c.wasm",
  "@repomix/tree-sitter-wasms/out/tree-sitter-cpp.wasm",
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function info(msg: string): void {
  console.log(`\x1b[1;34m[INFO]\x1b[0m  ${msg}`)
}

function warn(msg: string): void {
  console.warn(`\x1b[1;33m[WARN]\x1b[0m  ${msg}`)
}

function fatal(msg: string): never {
  console.error(`\x1b[1;31m[ERROR]\x1b[0m ${msg}`)
  process.exit(1)
}

/** Copy a directory if it exists in ROOT into a destination. */
function copyDir(src: string, dest: string, label?: string): void {
  if (!existsSync(src)) {
    warn(`${label ?? basename(src)} not found at ${src}, skipping.`)
    return
  }
  cpSync(src, dest, { recursive: true })
  info(`  Copied ${label ?? basename(src)}`)
}

function copyIfExists(src: string, dest: string, label: string): boolean {
  if (!existsSync(src)) return false
  cpSync(src, dest, { recursive: true })
  info(`  Copied ${label}`)
  return true
}

function runtimePlatformForPack(platform: PackOptions["platform"]): RuntimePlatform {
  return platform === "windows" ? "windows" : "linux"
}

function validateBundledPdfParsing(distEntry: string): void {
  if (!existsSync(distEntry)) {
    fatal(`Bundled plugin entry not found: ${distEntry}`)
  }

  const bundle = readFileSync(distEntry, "utf-8")
  const missing = REQUIRED_PDF_BUNDLE_MARKERS.filter((marker) => !bundle.includes(marker))
  if (missing.length > 0) {
    fatal(
      "The built plugin bundle does not appear to include the req_parser PDF extraction path. " +
        `Missing markers in ${distEntry}: ${missing.join(", ")}`
    )
  }
}

function runRepoCommand(label: string, args: string[], timeoutMs: number): void {
  info(label)
  try {
    execFileSync(process.execPath, args, {
      cwd: ROOT,
      stdio: "inherit",
      timeout: timeoutMs,
    })
  } catch (error) {
    fatal(
      `${label} failed. Packaging stopped before producing a broken offline installer. ` +
        `Command: bun ${args.join(" ")}. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function prepareWorkspace(opts: PackOptions): void {
  if (opts.nsisOnly) {
    warn("--nsis-only reuses existing staging; skipping automatic bun install/build.")
    return
  }

  if (opts.skipInstall) {
    warn("Skipping bun install because --skip-install was provided.")
  } else {
    runRepoCommand("Installing dependencies with bun install...", ["install"], 900_000)
  }

  validateNodeModuleAssets(join(ROOT, "node_modules"), "root node_modules")

  if (opts.skipBuild) {
    warn("Skipping bun run build because --skip-build was provided.")
  } else {
    runRepoCommand("Building plugin bundle with bun run build...", ["run", "build"], 600_000)
  }
}

function validateNodeModuleAssets(nodeModulesDir: string, contextLabel: string): void {
  const missing = REQUIRED_NODE_MODULE_ASSETS.filter(
    (asset) => !existsSync(join(nodeModulesDir, ...asset.split("/"))),
  )
  if (missing.length > 0) {
    fatal(
      `${contextLabel} is missing required runtime assets: ${missing.join(", ")}. ` +
        "Tree-sitter code parsing will fail offline without these WASM files."
    )
  }
}

async function validatePluginRegistration(distEntry: string): Promise<void> {
  if (!existsSync(distEntry)) {
    fatal(`Bundled plugin entry not found: ${distEntry}`)
  }

  const importUrl = `${pathToFileURL(distEntry).href}?packcheck=${Date.now()}`
  let pluginModule: any
  let pluginInterface: any
  const previousCwd = process.cwd()

  try {
    pluginModule = await import(importUrl)
    if (typeof pluginModule.default !== "function") {
      fatal(`Plugin bundle does not have a default plugin function: ${distEntry}`)
    }

    pluginInterface = await pluginModule.default({
      directory: ROOT,
      client: {},
    })
  } catch (error) {
    fatal(
      "Plugin bundle failed to import or initialize. " +
        "Run `bun run build` and ensure package.json builds with `--target bun`. " +
        `Entry: ${distEntry}. Error: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    if (process.cwd() !== previousCwd) {
      process.chdir(previousCwd)
    }
  }

  if (!pluginInterface || typeof pluginInterface.config !== "function") {
    fatal(`Plugin bundle did not expose a config hook: ${distEntry}`)
  }

  const config: any = {}
  try {
    await pluginInterface.config(config)
  } catch (error) {
    fatal(
      "Plugin config hook failed during packaging validation. " +
        `Entry: ${distEntry}. Error: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    if (process.cwd() !== previousCwd) {
      process.chdir(previousCwd)
    }
  }

  const requiredAgents = ["conductor", "planner", "inspector", "behavioral-safety-review"]
  const missingAgents = requiredAgents.filter((name) => !config.agent?.[name])
  if (missingAgents.length > 0) {
    fatal(
      "Plugin bundle loaded, but required Matrix agents were not registered: " +
        `${missingAgents.join(", ")}. This package would install without conductor.`
    )
  }

  const requiredCommands = ["matrix-start", "matrix-plan", "matrix-review"]
  const missingCommands = requiredCommands.filter((name) => !config.command?.[name])
  if (missingCommands.length > 0) {
    fatal(
      "Plugin bundle loaded, but required Matrix commands were not registered: " +
        `${missingCommands.join(", ")}.`
    )
  }

  info(
    `  Plugin registration OK: ${Object.keys(config.agent ?? {}).length} agents, ` +
      `${Object.keys(config.command ?? {}).length} commands`
  )
}

function validateRuntimeDirectory(
  runtimeDir: string,
  platform: RuntimePlatform,
  contextLabel: string,
): void {
  const missing = REQUIRED_RUNTIME_FILES[platform].filter(
    (name) => !existsSync(join(runtimeDir, name)),
  )
  if (missing.length > 0) {
    fatal(
      `${contextLabel} is missing required runtime files: ${missing.join(", ")}. ` +
        "Offline packages must include these files so OpenCode can discover documents " +
        "and Matrix can parse PDF requirement specifications offline."
    )
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
Usage:
  bun scripts/pack-offline.ts --platform <windows|linux|docker> --version <X.Y.Z> [OPTIONS]

Options:
  --platform <windows|linux|docker>  Target platform (required)
  --version <X.Y.Z>            Semver version string (required)
  --arch <x64|aarch64>         Target architecture (default: auto-detect from host)
  --tools-archive <dir>        Path to directory containing external tool archives
                               (default: tools-archive/)
  --nsis-only                  Rebuild only the NSIS setup.exe (skip staging & archiving)
  --skip-archive               Skip final 7z/tar.gz archive creation
  --skip-install               Do not run bun install before packaging
  --skip-build                 Do not run bun run build before packaging
  --help                       Show this help message and exit

Example:
  bun scripts/pack-offline.ts --platform windows --version 1.0.0
  bun scripts/pack-offline.ts --platform windows --version 1.0.0 --nsis-only
  bun scripts/pack-offline.ts --platform linux --version 1.0.0 --arch aarch64
  bun scripts/pack-offline.ts --platform linux --version 1.0.0 --tools-archive /builds/tools
  bun scripts/pack-offline.ts --platform docker --version 1.0.0 --arch aarch64
`)
}

function detectArch(platform?: "windows" | "linux" | "docker"): Arch {
  // Windows offline packaging currently targets the standard x64 runtime layout.
  // Defaulting to host arm64 here produces misleading package names on ARM build
  // hosts even though tools-archive/runtime/windows/ contains x64 binaries.
  if (platform === "windows") return "x64"
  return process.arch === "arm64" ? "aarch64" : "x64"
}

function parseArgs(argv: string[]): PackOptions {
  let platform: string | undefined
  let version: string | undefined
  let arch: string | undefined
  let toolsArchive: string | undefined
  let nsisOnly = false
  let skipArchive = false
  let skipInstall = false
  let skipBuild = false

  const args = argv.slice(2) // skip bun and script path
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--platform":
        platform = args[++i]
        break
      case "--version":
        version = args[++i]
        break
      case "--arch":
        arch = args[++i]
        break
      case "--tools-archive":
        toolsArchive = args[++i]
        break
      case "--nsis-only":
        nsisOnly = true
        break
      case "--skip-archive":
        skipArchive = true
        break
      case "--skip-install":
        skipInstall = true
        break
      case "--skip-build":
        skipBuild = true
        break
      case "--help":
      case "-h":
        printUsage()
        process.exit(0)
      default:
        fatal(`Unknown argument: ${args[i]}  (use --help for usage)`)
    }
  }

  if (!platform) fatal("--platform is required (windows, linux, or docker)")
  if (platform !== "windows" && platform !== "linux" && platform !== "docker")
    fatal(`--platform must be "windows", "linux", or "docker", got "${platform}"`)

  if (!version) fatal("--version is required (e.g. 1.0.0)")
  if (!/^\d+\.\d+\.\d+/.test(version))
    warn(`Version "${version}" does not look like semver — continuing anyway.`)

  const resolvedArch: Arch = arch
    ? (arch === "x64" || arch === "aarch64"
        ? arch
        : fatal(`--arch must be "x64" or "aarch64", got "${arch}"`))
    : detectArch(platform as "windows" | "linux" | "docker")

  return {
    platform: platform as "windows" | "linux" | "docker",
    arch: resolvedArch,
    version,
    toolsArchive: toolsArchive ?? join(ROOT, "tools-archive"),
    nsisOnly,
    skipArchive,
    skipInstall,
    skipBuild,
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

async function stage(opts: PackOptions): Promise<string> {
  const dirName = `matrix-offline-v${opts.version}-${opts.platform}-${opts.arch}`
  const stagingDir = join(STAGING_BASE, dirName)

  // Clean previous staging
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true })
  }
  mkdirSync(stagingDir, { recursive: true })

  // ------------------------------------------------------------------
  // [1/4] Plugin files → {staging}/plugin/
  // ------------------------------------------------------------------
  info("[1/4] Copying plugin files...")
  const pluginDir = join(stagingDir, "plugin")
  mkdirSync(pluginDir, { recursive: true })

  const pluginDirs = ["dist", "bin", "joern", "skills", "templates", "standards"]
  for (const dir of pluginDirs) {
    copyDir(join(ROOT, dir), join(pluginDir, dir), dir)
  }

  // node_modules — must exist (user should run bun install first)
  const nmSrc = join(ROOT, "node_modules")
  if (!existsSync(nmSrc)) {
    fatal(
      "node_modules/ not found. Please run `bun install` before packaging."
    )
  }
  cpSync(nmSrc, join(pluginDir, "node_modules"), { recursive: true })
  info("  Copied node_modules")

  // package.json — strip postinstall and devDependencies
  const pkgRaw = readFileSync(join(ROOT, "package.json"), "utf-8")
  const pkg = JSON.parse(pkgRaw)
  if (pkg.scripts) {
    delete pkg.scripts.postinstall
  }
  delete pkg.devDependencies
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n"
  )
  info("  Copied package.json (postinstall and devDependencies removed)")

  // ------------------------------------------------------------------
  // [2/4] Runtime binaries → {staging}/runtime/
  // ------------------------------------------------------------------
  info("[2/4] Copying runtime binaries...")
  const runtimePlatform = runtimePlatformForPack(opts.platform)
  const runtimeSrc = join(opts.toolsArchive, "runtime", runtimePlatform)
  const runtimeDest = join(stagingDir, "runtime")

  if (existsSync(runtimeSrc) && readdirSync(runtimeSrc).length > 0) {
    cpSync(runtimeSrc, runtimeDest, { recursive: true })
    info(`  Copied runtime from ${runtimeSrc}`)
  } else {
    fatal(
      `Runtime binaries not found at ${runtimeSrc}. ` +
        `Populate tools-archive/runtime/${runtimePlatform}/ with ${REQUIRED_RUNTIME_FILES[runtimePlatform].join(", ")} before packaging.`
    )
  }

  const pythonCandidates = [
    join(opts.toolsArchive, "python", opts.platform),
    join(opts.toolsArchive, "runtime", opts.platform, "python"),
  ]
  let pythonBundled = false
  for (const candidate of pythonCandidates) {
    if (copyIfExists(candidate, join(runtimeDest, "python"), `python runtime from ${candidate}`)) {
      pythonBundled = true
      break
    }
  }
  if (!pythonBundled) {
    info("  python runtime not found - skipped (docxtpl requires MATRIX_PYTHON on target machine)")
  }

  // ------------------------------------------------------------------
  // [2.5/4] Ensure ripgrep (rg) is in runtime directory
  // ------------------------------------------------------------------
  // OpenCode's grep/glob tools require ripgrep. On offline machines,
  // the auto-download from GitHub will fail. We bundle rg.exe alongside
  // opencode.exe so it's found via Bun.which() (both on PATH).
  info("[2.5/4] Ensuring ripgrep is bundled...")
  const rgName = runtimePlatform === "windows" ? "rg.exe" : "rg"
  const rgInRuntime = join(runtimeDest, rgName)

  if (existsSync(rgInRuntime)) {
    info(`  ripgrep already present in runtime: ${rgInRuntime}`)
  } else {
    // Check if rg exists in tools-archive
    const rgSearchPaths = [
      join(opts.toolsArchive, "runtime", opts.platform, rgName),
      join(opts.toolsArchive, rgName),
    ]
    let rgFound = false
    for (const src of rgSearchPaths) {
      if (existsSync(src)) {
        cpSync(src, rgInRuntime)
        info(`  Copied ripgrep from ${src}`)
        rgFound = true
        break
      }
    }

    if (!rgFound) {
      // Try to download ripgrep during packaging (build machine has network)
      const RG_VERSION = "14.1.1"
      const linuxRgArch = opts.arch === "aarch64" ? "aarch64" : "x86_64"
      const platformMap: Partial<Record<PackOptions["platform"], string>> = {
        windows: "x86_64-pc-windows-msvc",
        linux: `${linuxRgArch}-unknown-linux-musl`,
        docker: `${linuxRgArch}-unknown-linux-musl`,
      }
      const extMap: Partial<Record<PackOptions["platform"], string>> = {
        windows: "zip",
        linux: "tar.gz",
        docker: "tar.gz",
      }
      const rgPlatform = platformMap[opts.platform]
      const rgExt = extMap[opts.platform]

      if (rgPlatform && rgExt) {
        const rgFilename = `ripgrep-${RG_VERSION}-${rgPlatform}.${rgExt}`
        const rgUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${rgFilename}`
        const rgArchive = join(runtimeDest, rgFilename)

        info(`  Downloading ripgrep ${RG_VERSION} from GitHub...`)
        try {
          const resp = await fetch(rgUrl, { redirect: "follow" })
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          await Bun.write(rgArchive, await resp.arrayBuffer())

          if (rgExt === "zip") {
            // Extract rg.exe from zip — use unzip on Linux, PowerShell on Windows
            if (process.platform === "win32") {
              execSync(
                `powershell -NoProfile -Command "` +
                  `$$entries = [IO.Compression.ZipFile]::OpenRead('${rgArchive.replace(/'/g, "''")}').Entries; ` +
                  `$$rg = $$entries | Where-Object { $$_.Name -eq 'rg.exe' } | Select-Object -First 1; ` +
                  `[IO.Compression.ZipFileExtensions]::ExtractToFile($$rg, '${rgInRuntime.replace(/'/g, "''")}', $$true)"`,
                { stdio: "pipe", timeout: 60_000 }
              )
            } else {
              // Cross-packaging on Linux: use unzip to extract rg.exe
              const tmpExtract = join(runtimeDest, "__rg_tmp")
              mkdirSync(tmpExtract, { recursive: true })
              execSync(`unzip -o "${rgArchive}" "*/rg.exe" -d "${tmpExtract}"`, {
                stdio: "pipe",
                timeout: 60_000,
              })
              // Find and move rg.exe to runtime dir
              const found = execSync(`find "${tmpExtract}" -name rg.exe -type f`, {
                encoding: "utf-8",
              }).trim()
              if (found) {
                cpSync(found, rgInRuntime)
              }
              rmSync(tmpExtract, { recursive: true, force: true })
            }
          } else {
            execSync(
              `tar -xzf "${rgArchive}" --strip-components=1 --wildcards "*/rg" -C "${runtimeDest}"`,
              { stdio: "pipe", timeout: 60_000 }
            )
            chmodSync(rgInRuntime, 0o755)
          }

          // Cleanup archive
          rmSync(rgArchive, { force: true })

          if (existsSync(rgInRuntime)) {
            info(`  ripgrep ${RG_VERSION} downloaded and extracted successfully`)
          } else {
            fatal(
              "ripgrep extraction finished but the binary is still missing from runtime/. " +
                "Offline packaging cannot continue without rg."
            )
          }
        } catch (e) {
          fatal(
            `Failed to obtain ripgrep: ${e instanceof Error ? e.message : String(e)}. ` +
              `Manually place ${rgName} in tools-archive/runtime/${runtimePlatform}/ before packaging.`
          )
        }
      }
    }
  }

  validateRuntimeDirectory(runtimeDest, runtimePlatform, "staged runtime")
  validateNodeModuleAssets(join(pluginDir, "node_modules"), "staged plugin/node_modules")

  // ------------------------------------------------------------------
  // [3/4] Optional external tools → {staging}/tools/
  // ------------------------------------------------------------------
  info("[3/4] Copying optional external tools...")

  // Large tools (specchecker, aunit, code_slicer) are NOT embedded in NSIS — they ship
  // alongside setup.exe and are copied via CopyFiles at install time.
  // Only small tools (joern-cli, z3) are embedded in the NSIS datablock.
  const embeddedTools: string[] = []
  const externalTools = ["specchecker", "aunit", "code_slicer", "joern-cli", "z3"]
  const allToolNames = [...embeddedTools, ...externalTools]

  const toolsDest = join(stagingDir, "tools")
  mkdirSync(toolsDest, { recursive: true })

  // Search both {toolsArchive}/{platform}/ and {toolsArchive}/tools/{platform}/
  const toolSearchPaths = [
    join(opts.toolsArchive, opts.platform),
    join(opts.toolsArchive, "tools", opts.platform),
  ]

  for (const toolName of allToolNames) {
    let found = false
    for (const searchDir of toolSearchPaths) {
      const src = join(searchDir, toolName)
      if (existsSync(src)) {
        if (opts.platform === "windows" && externalTools.includes(toolName)) {
          // Large tool — skip embedding, will be placed next to setup.exe later
          info(`  Found ${toolName} (external, will ship alongside installer)`)
        } else {
          cpSync(src, join(toolsDest, toolName), { recursive: true })
          info(`  Copied ${toolName} from ${src}`)
        }
        found = true
        break
      }
    }
    if (!found) {
      info(`  ${toolName} not found — skipped (this is expected if not needed)`)
      // Create empty dir with a placeholder so NSIS File /r *.* doesn't fail
      if (opts.platform === "windows" && embeddedTools.includes(toolName)) {
        const emptyDir = join(toolsDest, toolName)
        mkdirSync(emptyDir, { recursive: true })
        writeFileSync(join(emptyDir, ".placeholder"), "")
      }
    }
  }

  // ------------------------------------------------------------------
  // [4/4] Installer files
  // ------------------------------------------------------------------
  info("[4/4] Copying installer files...")

  // For Linux: copy install.sh and uninstall.sh to staging root
  if (opts.platform === "linux") {
    cpSync(join(INSTALLER_DIR, "install.sh"), join(stagingDir, "install.sh"))
    cpSync(
      join(INSTALLER_DIR, "uninstall.sh"),
      join(stagingDir, "uninstall.sh")
    )
    info("  Copied install.sh and uninstall.sh to staging root")
  }

  // Config templates (both platforms)
  const configDest = join(stagingDir, "config")
  mkdirSync(configDest, { recursive: true })

  const configTemplates = ["matrix.jsonc.template", "opencode.json.template"]
  for (const tpl of configTemplates) {
    const src = join(INSTALLER_DIR, tpl)
    if (existsSync(src)) {
      cpSync(src, join(configDest, tpl))
      info(`  Copied ${tpl} to config/`)
    }
  }

  info(`Staging complete: ${stagingDir}`)
  return stagingDir
}

// ---------------------------------------------------------------------------
// Packaging — Windows (NSIS)
// ---------------------------------------------------------------------------

function packageWindows(
  stagingDir: string,
  version: string,
  opts: PackOptions
): string {
  info("Packaging Windows installer (NSIS)...")

  // Resolve makensis binary — prefer well-known install paths to avoid
  // MSYS2/Git-Bash mangling of /D flags (single-slash args are treated as paths).
  const nsisSearchPaths = [
    "C:\\Program Files (x86)\\NSIS\\makensis.exe",
    "C:\\Program Files\\NSIS\\makensis.exe",
  ]
  let makensisPath = ""
  for (const p of nsisSearchPaths) {
    if (existsSync(p)) {
      makensisPath = p
      break
    }
  }
  if (!makensisPath) {
    // Fallback: try bare command (user has it on PATH)
    try {
      // Linux NSIS uses -VERSION; Windows uses //VERSION
      const vFlag = process.platform === "win32" ? "//VERSION" : "-VERSION"
      execSync(`makensis ${vFlag}`, { stdio: "pipe" })
      makensisPath = "makensis"
    } catch {
      fatal(
        "makensis not found. Please install NSIS 3.x " +
          "(https://nsis.sourceforge.io) and ensure makensis is available."
      )
    }
  }
  info(`Using NSIS: ${makensisPath}`)

  mkdirSync(RELEASE_DIR, { recursive: true })

  // ---------------------------------------------------------------
  // Step 1: Build the NSIS setup.exe (core only, no large tools)
  // ---------------------------------------------------------------
  const distDirName = `matrix-offline-v${version}-windows-${opts.arch}`
  const distDir = join(RELEASE_DIR, distDirName)
  if (!opts.nsisOnly) {
    // Full build: clean and recreate dist dir
    if (existsSync(distDir)) rmSync(distDir, { recursive: true })
  }
  mkdirSync(distDir, { recursive: true })

  const setupExe = join(distDir, "setup.exe")
  const nsiPath = join(INSTALLER_DIR, "matrix.nsi")

  const toWinPath = (p: string) =>
    process.platform === "win32" ? p.replace(/\//g, "\\") : p

  // Linux makensis uses -D; Windows uses /D
  const dFlag = process.platform === "win32" ? "/D" : "-D"
  const charsetFlag = process.platform === "win32" ? "/INPUTCHARSET" : "-INPUTCHARSET"
  const nsisArgs = [
    charsetFlag,
    "UTF8",
    `${dFlag}PRODUCT_VERSION=${version}`,
    `${dFlag}STAGING_DIR=${toWinPath(stagingDir)}`,
    `${dFlag}OUTFILE=${toWinPath(setupExe)}`,
    toWinPath(nsiPath),
  ]

  info(`Running: makensis ${nsisArgs.join(" ")}`)
  execFileSync(makensisPath, nsisArgs, {
    cwd: INSTALLER_DIR,
    stdio: "inherit",
    timeout: 1_800_000,
  })
  info(`  setup.exe created`)

  // ---------------------------------------------------------------
  // Step 2: Copy large external tools next to setup.exe
  //   These are NOT embedded in NSIS (32-bit mmap limit).
  //   The NSIS installer uses $EXEDIR\tools\ to find them.
  //   Skipped in --nsis-only mode (tools already in place).
  // ---------------------------------------------------------------
  let hasExternalTools = existsSync(join(distDir, "tools"))
  if (!opts.nsisOnly) {
    const externalToolNames = ["specchecker", "aunit", "code_slicer", "joern-cli", "z3"]
    const toolSearchPaths = [
      join(opts.toolsArchive, opts.platform),
      join(opts.toolsArchive, "tools", opts.platform),
    ]

    hasExternalTools = false
    for (const toolName of externalToolNames) {
      for (const searchDir of toolSearchPaths) {
        const src = join(searchDir, toolName)
        if (existsSync(src)) {
          const dest = join(distDir, "tools", toolName)
          info(`  Copying external tool ${toolName} to distribution...`)
          cpSync(src, dest, { recursive: true })
          hasExternalTools = true
          break
        }
      }
    }
  } else {
    info("  --nsis-only: skipping external tool copy (using existing)")
  }

  // ---------------------------------------------------------------
  // Step 3: Create final archive (skipped with --nsis-only or --skip-archive)
  // ---------------------------------------------------------------
  if (opts.nsisOnly || opts.skipArchive) {
    info(`setup.exe rebuilt: ${setupExe}`)
    if (hasExternalTools) {
      info(`Distribution directory (tools in place): ${distDir}`)
    }
    return setupExe
  }

  if (hasExternalTools) {
    // Distribution has setup.exe + tools/ — create a 7z or zip archive
    info("Creating distribution archive...")
    const archiveName = `${distDirName}.7z`
    const archivePath = join(RELEASE_DIR, archiveName)

    // Try 7z first, fall back to zip via PowerShell
    let archived = false
    try {
      execSync("7z --help", { stdio: "pipe" })
      execSync(
        `7z a -mx=1 "${archivePath}" "${distDir}"`,
        { stdio: "inherit", timeout: 1_800_000 }
      )
      archived = true
    } catch {
      // 7z not available, try PowerShell Compress-Archive (creates .zip)
      const zipPath = join(RELEASE_DIR, `${distDirName}.zip`)
      info("  7z not found, using PowerShell to create .zip...")
      try {
        execSync(
          `powershell -NoProfile -Command "Compress-Archive -Path '${toWinPath(distDir)}' -DestinationPath '${toWinPath(zipPath)}' -Force"`,
          { stdio: "inherit", timeout: 1_800_000 }
        )
        archived = true
        info(`Windows distribution archive: ${zipPath}`)
        return zipPath
      } catch {
        warn("PowerShell Compress-Archive also failed. Distribution directory left as-is.")
      }
    }

    if (archived) {
      info(`Windows distribution archive: ${archivePath}`)
      return archivePath
    }
  }

  // No external tools or archiving failed — single setup.exe is the output
  info(`Windows installer created: ${setupExe}`)
  return setupExe
}

// ---------------------------------------------------------------------------
// Packaging — Linux (tar.gz)
// ---------------------------------------------------------------------------

function packageLinux(stagingDir: string, version: string, opts: PackOptions): string {
  info("Packaging Linux archive (tar.gz)...")

  mkdirSync(RELEASE_DIR, { recursive: true })

  // Make shell scripts executable
  const installSh = join(stagingDir, "install.sh")
  const uninstallSh = join(stagingDir, "uninstall.sh")

  if (existsSync(installSh)) chmodSync(installSh, 0o755)
  if (existsSync(uninstallSh)) chmodSync(uninstallSh, 0o755)

  // Also make runtime binaries executable
  const runtimeDir = join(stagingDir, "runtime")
  if (existsSync(runtimeDir)) {
    try {
      for (const entry of readdirSync(runtimeDir)) {
        chmodSync(join(runtimeDir, entry), 0o755)
      }
    } catch {
      // ignore — might be nested dirs
    }
  }

  const archiveName = `matrix-offline-v${version}-linux-${opts.arch}.tar.gz`
  const archivePath = join(RELEASE_DIR, archiveName)
  const parentDir = dirname(stagingDir)
  const dirName = basename(stagingDir)

  // --force-local: treat archive file as local even if the path contains a
  // colon (Windows drive letters like D:\ would otherwise be interpreted as a
  // remote host specification by GNU tar on MSYS2 / Git Bash).
  const tarArgs = ["-czf", archivePath, "--force-local", "-C", parentDir, dirName]
  info(`Running: tar ${tarArgs.join(" ")}`)
  execFileSync("tar", tarArgs, {
    stdio: "inherit",
    timeout: 1_800_000,
  })

  info(`Linux archive created: ${archivePath}`)
  return archivePath
}

// ---------------------------------------------------------------------------
// Packaging — Docker (image tar + compose bundle)
// ---------------------------------------------------------------------------

async function packageDocker(version: string, opts: PackOptions): Promise<string> {
  info("Packaging Docker deployment bundle...")

  mkdirSync(RELEASE_DIR, { recursive: true })

  const dockerPlatform = opts.arch === "aarch64" ? "linux/arm64" : "linux/amd64"
  const serverDir = join(ROOT, "scripts", "server")

  // ---------------------------------------------------------------
  // Step 1: Build matrix-agent image
  // ---------------------------------------------------------------
  info("[1/5] Building matrix-agent image...")
  execSync(
    `docker build --platform ${dockerPlatform} -f "${join(serverDir, "Dockerfile")}" -t matrix-agent:${version} .`,
    { cwd: ROOT, stdio: "inherit", timeout: 600_000 },
  )
  info("  matrix-agent image built")

  // ---------------------------------------------------------------
  // Step 2: Build matrix-samba image
  // ---------------------------------------------------------------
  info("[2/5] Building matrix-samba image...")
  execSync(
    `docker build --platform ${dockerPlatform} -f "${join(serverDir, "Dockerfile.samba")}" -t matrix-samba:${version} "${serverDir}"`,
    { cwd: serverDir, stdio: "inherit", timeout: 120_000 },
  )
  info("  matrix-samba image built")

  // ---------------------------------------------------------------
  // Step 3: Pull nginx image
  // ---------------------------------------------------------------
  info("[3/5] Pulling nginx:1.27-alpine...")
  try {
    execSync(`docker pull --platform ${dockerPlatform} nginx:1.27-alpine`, {
      stdio: "inherit",
      timeout: 120_000,
    })
  } catch {
    warn("Failed to pull nginx:1.27-alpine — it may already exist locally")
  }

  // ---------------------------------------------------------------
  // Step 4: Save images as tar files
  // ---------------------------------------------------------------
  info("[4/5] Saving Docker images...")
  const distDirName = `matrix-docker-v${version}-linux-${opts.arch}`
  const distDir = join(RELEASE_DIR, distDirName)

  if (existsSync(distDir)) rmSync(distDir, { recursive: true })
  const imagesDir = join(distDir, "images")
  mkdirSync(imagesDir, { recursive: true })

  const imageSaves = [
    { image: `matrix-agent:${version}`, file: "matrix-agent.tar" },
    { image: `matrix-samba:${version}`, file: "matrix-samba.tar" },
    { image: "nginx:1.27-alpine", file: "nginx-alpine.tar" },
  ]

  for (const { image, file } of imageSaves) {
    info(`  Saving ${image}...`)
    execSync(`docker save -o "${join(imagesDir, file)}" "${image}"`, {
      stdio: "inherit",
      timeout: 300_000,
    })
  }

  // ---------------------------------------------------------------
  // Step 5: Copy compose + deploy files
  // ---------------------------------------------------------------
  info("[5/5] Copying deployment files...")

  const deployFiles = [
    "docker-compose.yml",
    ".env.example",
    "nginx.conf",
    "deploy.sh",
    "Dockerfile.samba",
    "smb.conf",
  ]

  for (const file of deployFiles) {
    const src = join(serverDir, file)
    if (existsSync(src)) {
      cpSync(src, join(distDir, file))
      info(`  Copied ${file}`)
    }
  }

  // Make deploy.sh executable
  const deploySh = join(distDir, "deploy.sh")
  if (existsSync(deploySh)) chmodSync(deploySh, 0o755)

  // Update MATRIX_VERSION in .env.example
  const envExample = join(distDir, ".env.example")
  if (existsSync(envExample)) {
    let content = readFileSync(envExample, "utf-8")
    content = content.replace(/^MATRIX_VERSION=.*/m, `MATRIX_VERSION=${version}`)
    writeFileSync(envExample, content)
  }

  // ---------------------------------------------------------------
  // Create final tar.gz archive
  // ---------------------------------------------------------------
  if (opts.skipArchive) {
    info(`Docker bundle ready: ${distDir}`)
    return distDir
  }

  const archiveName = `${distDirName}.tar.gz`
  const archivePath = join(RELEASE_DIR, archiveName)
  const parentDir = dirname(distDir)
  const dirName = basename(distDir)

  info("Creating deployment archive...")
  execSync(
    `tar -czf "${archivePath}" --force-local -C "${parentDir}" "${dirName}"`,
    { stdio: "inherit", timeout: 600_000 },
  )

  // Clean up unarchived directory
  rmSync(distDir, { recursive: true })

  info(`Docker deployment archive created: ${archivePath}`)
  return archivePath
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv)
  const distEntry = join(ROOT, "dist", "index.js")

  console.log()
  info("=== Matrix Embedded Agent — Offline Packager ===")
  info(`Platform : ${opts.platform}`)
  info(`Arch     : ${opts.arch}`)
  info(`Version  : ${opts.version}`)
  info(`Tools    : ${opts.toolsArchive}`)
  if (opts.nsisOnly) info("Mode     : NSIS-only (incremental rebuild)")
  if (opts.skipArchive) info("Mode     : skip archive")
  if (opts.skipInstall) info("Mode     : skip install")
  if (opts.skipBuild) info("Mode     : skip build")
  console.log()

  prepareWorkspace(opts)

  validateBundledPdfParsing(distEntry)
  await validatePluginRegistration(distEntry)

  // Docker platform: entirely separate path (no staging needed)
  if (opts.platform === "docker") {
    validateRuntimeDirectory(
      join(opts.toolsArchive, "runtime", "linux"),
      "linux",
      "tools-archive/runtime/linux",
    )
    const outputPath = await packageDocker(opts.version, opts)
    console.log()
    info("Done!")
    info(`Output: ${outputPath}`)
    return
  }

  // --nsis-only: rebuild only the NSIS setup.exe, reuse existing staging/dist
  if (opts.nsisOnly) {
    if (opts.platform !== "windows") {
      fatal("--nsis-only is only supported for --platform windows")
    }

    // Try to find existing staging dir; create minimal one if missing
    const dirName = `matrix-offline-v${opts.version}-${opts.platform}-${opts.arch}`
    let stagingDir = join(STAGING_BASE, dirName)
    if (!existsSync(stagingDir)) {
      info("Staging directory not found, creating minimal staging for NSIS...")
      const runtimeDest = join(stagingDir, "runtime")
      mkdirSync(runtimeDest, { recursive: true })
      const pluginDir = join(stagingDir, "plugin")
      mkdirSync(pluginDir, { recursive: true })

      // Copy just the essential files for NSIS compilation
      const runtimeSrc = join(opts.toolsArchive, "runtime", opts.platform)
      if (existsSync(runtimeSrc)) {
        for (const entry of readdirSync(runtimeSrc)) {
          cpSync(join(runtimeSrc, entry), join(runtimeDest, entry), { recursive: true })
        }
      }
      validateRuntimeDirectory(runtimeDest, "windows", "NSIS staging runtime")

      // Copy plugin assets needed by the installer/runtime.
      const pluginDirs = ["dist", "bin", "joern", "skills", "templates", "standards"]
      for (const dir of pluginDirs) {
        const src = join(ROOT, dir)
        const dest = join(pluginDir, dir)
        if (existsSync(src)) {
          cpSync(src, dest, { recursive: true })
        }
      }

      const packageJsonPath = join(ROOT, "package.json")
      if (existsSync(packageJsonPath)) {
        cpSync(packageJsonPath, join(pluginDir, "package.json"))
      }

      const pluginNodeModules = join(ROOT, "node_modules")
      if (existsSync(pluginNodeModules)) {
        cpSync(pluginNodeModules, join(pluginDir, "node_modules"), { recursive: true })
      }
    }

    const stagedDistEntry = join(stagingDir, "plugin", "dist", "index.js")
    validateRuntimeDirectory(join(stagingDir, "runtime"), "windows", "NSIS staging runtime")
    validateNodeModuleAssets(join(stagingDir, "plugin", "node_modules"), "NSIS staging plugin/node_modules")
    validateBundledPdfParsing(stagedDistEntry)
    await validatePluginRegistration(stagedDistEntry)

    const outputPath = packageWindows(stagingDir, opts.version, opts)
    console.log()
    info("Done! (NSIS-only rebuild)")
    info(`Output: ${outputPath}`)
    return
  }

  // Verify build output exists
  if (!existsSync(distEntry)) {
    fatal(
      "dist/index.js not found. Please run `bun run build` before packaging."
    )
  }

  // Stage
  const stagingDir = await stage(opts)
  console.log()

  // Package
  let outputPath: string
  if (opts.platform === "windows") {
    outputPath = packageWindows(stagingDir, opts.version, opts)
  } else {
    outputPath = packageLinux(stagingDir, opts.version, opts)
  }

  // Cleanup staging
  console.log()
  info("Cleaning up staging directory...")
  rmSync(STAGING_BASE, { recursive: true })

  console.log()
  info("Done!")
  info(`Output: ${outputPath}`)
}

void main()
