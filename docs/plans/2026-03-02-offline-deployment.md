# Offline Deployment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an offline packaging and installation system so Matrix Embedded Agent can be deployed in air-gapped private environments on Windows (NSIS GUI installer) and Linux (tar.gz + shell script).

**Architecture:** A `scripts/pack-offline.ts` orchestrator script collects all runtime artifacts (Bun, OpenCode, plugin bundle, bundled binaries, optional tools), generates config templates, then either invokes `makensis` to produce a Windows `.exe` installer or creates a Linux `.tar.gz` with an `install.sh`. A `scripts/installer/` directory holds the NSIS script, banner, icon, and license.

**Tech Stack:** TypeScript (Bun runtime), NSIS 3.x (Windows installer), Bash (Linux installer), existing postinstall.ts binary download patterns.

---

### Task 1: Create installer directory structure and static assets

**Files:**
- Create: `scripts/installer/license.txt`
- Create: `scripts/installer/matrix-banner.bmp` (placeholder — 150x57 BMP, can be replaced later)
- Create: `scripts/installer/matrix-icon.ico` (placeholder — can be replaced later)

**Step 1: Create directory and placeholder files**

```bash
mkdir -p scripts/installer
```

**Step 2: Create license.txt**

Write `scripts/installer/license.txt` with the MIT license text from `package.json`:

```text
MIT License

Copyright (c) 2025 Matrix Embedded Agent Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Step 3: Create placeholder image assets**

For `matrix-banner.bmp` and `matrix-icon.ico`, create minimal valid files. These are visual branding assets and can be replaced later by a designer. For now we generate trivially small valid placeholders:

```typescript
// Generate a 150x57 24-bit BMP (white background) as placeholder
// and a 16x16 ICO as placeholder
// The pack-offline.ts script will just copy them; actual branding comes later
```

Create a tiny `scripts/create-installer-assets.ts` that generates the two placeholder files:

```typescript
#!/usr/bin/env bun
/**
 * Generate placeholder installer assets (banner BMP + icon ICO).
 * Replace these with real branding assets before production release.
 */
import { writeFileSync, existsSync } from "fs"
import { join } from "path"

const DIR = join(import.meta.dir, "installer")

// --- 150x57 24-bit BMP (white) ---
function createPlaceholderBmp(path: string, w: number, h: number): void {
  if (existsSync(path)) return
  const rowBytes = Math.ceil((w * 3) / 4) * 4
  const pixelDataSize = rowBytes * h
  const fileSize = 54 + pixelDataSize
  const buf = Buffer.alloc(fileSize, 0xff) // white pixels

  // BMP header
  buf.write("BM", 0)
  buf.writeUInt32LE(fileSize, 2)
  buf.writeUInt32LE(54, 10) // pixel data offset
  // DIB header (BITMAPINFOHEADER)
  buf.writeUInt32LE(40, 14) // header size
  buf.writeInt32LE(w, 18)
  buf.writeInt32LE(h, 22)
  buf.writeUInt16LE(1, 26) // planes
  buf.writeUInt16LE(24, 28) // bpp
  buf.writeUInt32LE(pixelDataSize, 34)

  writeFileSync(path, buf)
  console.log(`Created placeholder: ${path}`)
}

// --- Minimal 16x16 ICO (white) ---
function createPlaceholderIco(path: string): void {
  if (existsSync(path)) return
  const w = 16, h = 16
  const bpp = 24
  const rowBytes = Math.ceil((w * bpp / 8) / 4) * 4
  const maskRowBytes = Math.ceil(w / 32) * 4
  const imgSize = 40 + rowBytes * h + maskRowBytes * h
  const fileSize = 6 + 16 + imgSize

  const buf = Buffer.alloc(fileSize, 0)
  // ICO header
  buf.writeUInt16LE(0, 0)   // reserved
  buf.writeUInt16LE(1, 2)   // type = ICO
  buf.writeUInt16LE(1, 4)   // count = 1
  // ICO directory entry
  buf.writeUInt8(w, 6)
  buf.writeUInt8(h, 7)
  buf.writeUInt16LE(1, 10)  // planes
  buf.writeUInt16LE(bpp, 12)
  buf.writeUInt32LE(imgSize, 14)
  buf.writeUInt32LE(22, 18) // offset to image data
  // BMP info header (inside ICO)
  buf.writeUInt32LE(40, 22)
  buf.writeInt32LE(w, 26)
  buf.writeInt32LE(h * 2, 30) // double height for ICO
  buf.writeUInt16LE(1, 34)
  buf.writeUInt16LE(bpp, 36)
  // Pixel data: all white
  const pixelStart = 62
  for (let i = pixelStart; i < pixelStart + rowBytes * h; i++) {
    buf[i] = 0xff
  }

  writeFileSync(path, buf)
  console.log(`Created placeholder: ${path}`)
}

createPlaceholderBmp(join(DIR, "matrix-banner.bmp"), 150, 57)
createPlaceholderIco(join(DIR, "matrix-icon.ico"))
```

Run: `bun scripts/create-installer-assets.ts`

**Step 4: Commit**

```bash
git add scripts/installer/ scripts/create-installer-assets.ts
git commit -m "chore: add installer directory structure and placeholder assets"
```

---

### Task 2: Create config templates

**Files:**
- Create: `scripts/installer/opencode.json.template`
- Create: `scripts/installer/matrix.jsonc.template`

**Step 1: Create OpenCode config template**

Write `scripts/installer/opencode.json.template` — this is the template that the installer populates with user-provided LLM settings:

```jsonc
{
  "provider": {
    "name": "openai-compatible",
    "base_url": "{{LLM_BASE_URL}}",
    "api_key": "{{LLM_API_KEY}}",
    "model": "{{LLM_MODEL}}"
  },
  "plugins": {
    "matrix-embedded-agent": {
      "path": "{{INSTALL_DIR}}/plugin"
    }
  }
}
```

**Step 2: Create Matrix plugin config template**

Write `scripts/installer/matrix.jsonc.template`:

```jsonc
// Matrix Embedded Agent Configuration
// Generated by offline installer
{
  "standard": "gjb5000a",
  "coverage_target": "statement",
  "coding_standard": "misra-c-2012",
  "compiler_dialect": "auto",
  "output_language": "zh-CN",
  "auto_advance": true,
  "wiki_enabled": true,

  // External tool paths (populated by installer based on component selection)
  // "specchecker_home": "{{SPECCHECKER_PATH}}",
  // "aunit_path": "{{AUNIT_PATH}}"
}
```

**Step 3: Commit**

```bash
git add scripts/installer/opencode.json.template scripts/installer/matrix.jsonc.template
git commit -m "chore: add OpenCode and Matrix config templates for offline installer"
```

---

### Task 3: Write the NSIS installer script

**Files:**
- Create: `scripts/installer/matrix.nsi`

This is the core NSIS script. It defines 7 wizard pages: Welcome, License, Directory, Components, LLM Config (custom page), Install, Finish.

**Step 1: Write the NSIS script**

Write `scripts/installer/matrix.nsi`:

```nsi
; Matrix Embedded Agent — NSIS Installer Script
; Requires NSIS 3.x with MUI2

;--------------------------------
; Build-time defines (set by pack-offline.ts via -D flags)
;   PRODUCT_VERSION  — e.g. "0.1.0"
;   STAGING_DIR      — path to staged offline files

!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.0.0-dev"
!endif

!define PRODUCT_NAME    "Matrix Embedded Agent"
!define PRODUCT_PUBLISHER "Matrix Team"
!define INSTALL_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

;--------------------------------
; Includes

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

;--------------------------------
; General

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "matrix-offline-v${PRODUCT_VERSION}-windows-x64.exe"
InstallDir "C:\Matrix"
InstallDirRegKey HKLM "${INSTALL_REG_KEY}" "InstallLocation"
RequestExecutionLevel admin
Unicode True

;--------------------------------
; Interface Settings

!define MUI_ICON "matrix-icon.ico"
!define MUI_UNICON "matrix-icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "matrix-banner.bmp"
!define MUI_ABORTWARNING

;--------------------------------
; Variables for LLM config page

Var LlmBaseUrl
Var LlmModel
Var LlmApiKey
Var HwndLlmBaseUrl
Var HwndLlmModel
Var HwndLlmApiKey

;--------------------------------
; Pages

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "license.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
Page custom LlmConfigPageCreate LlmConfigPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; Uninstaller pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

;--------------------------------
; Languages

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

;--------------------------------
; LLM Configuration Custom Page

Function LlmConfigPageCreate
  !insertmacro MUI_HEADER_TEXT "LLM 服务配置" "配置私有化大模型的连接信息"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ; API Base URL
  ${NSD_CreateLabel} 0 0 100% 12u "API 地址 (例: http://llm.internal:8000/v1):"
  Pop $0
  ${NSD_CreateText} 0 14u 100% 12u "http://localhost:8000/v1"
  Pop $HwndLlmBaseUrl

  ; Model name
  ${NSD_CreateLabel} 0 34u 100% 12u "模型名称 (例: qwen2.5-72b-instruct):"
  Pop $0
  ${NSD_CreateText} 0 48u 100% 12u "qwen2.5-72b-instruct"
  Pop $HwndLlmModel

  ; API Key
  ${NSD_CreateLabel} 0 68u 100% 12u "API Key (可选，留空则不设置):"
  Pop $0
  ${NSD_CreateText} 0 82u 100% 12u ""
  Pop $HwndLlmApiKey

  nsDialogs::Show
FunctionEnd

Function LlmConfigPageLeave
  ${NSD_GetText} $HwndLlmBaseUrl $LlmBaseUrl
  ${NSD_GetText} $HwndLlmModel $LlmModel
  ${NSD_GetText} $HwndLlmApiKey $LlmApiKey

  ; Validate base URL is not empty
  ${If} $LlmBaseUrl == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "请输入 LLM API 地址"
    Abort
  ${EndIf}
FunctionEnd

;--------------------------------
; Installer Sections

Section "Matrix 核心" SecCore
  SectionIn RO  ; Required, cannot uncheck

  SetOutPath "$INSTDIR"

  ; Runtime: Bun + OpenCode CLI
  SetOutPath "$INSTDIR\runtime"
  File /r "${STAGING_DIR}\runtime\*.*"

  ; Plugin: dist + node_modules + bin + skills + templates + standards + joern
  SetOutPath "$INSTDIR\plugin"
  File /r "${STAGING_DIR}\plugin\*.*"

  ; Generate OpenCode config from template + user input
  SetOutPath "$INSTDIR\config"
  FileOpen $0 "$INSTDIR\config\opencode.json" w
  FileWrite $0 '{$\n'
  FileWrite $0 '  "provider": {$\n'
  FileWrite $0 '    "name": "openai-compatible",$\n'
  FileWrite $0 '    "base_url": "$LlmBaseUrl",$\n'
  FileWrite $0 '    "api_key": "$LlmApiKey",$\n'
  FileWrite $0 '    "model": "$LlmModel"$\n'
  FileWrite $0 '  },$\n'
  FileWrite $0 '  "plugins": {$\n'
  FileWrite $0 '    "matrix-embedded-agent": {$\n'
  FileWrite $0 '      "path": "$INSTDIR\plugin"$\n'
  FileWrite $0 '    }$\n'
  FileWrite $0 '  }$\n'
  FileWrite $0 '}$\n'
  FileClose $0

  ; Add to PATH
  EnVar::AddValue "PATH" "$INSTDIR\runtime"

  ; Write uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Write registry keys for Add/Remove Programs
  WriteRegStr HKLM "${INSTALL_REG_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${INSTALL_REG_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "${INSTALL_REG_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${INSTALL_REG_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${INSTALL_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "NoRepair" 1

  ; Calculate installed size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "EstimatedSize" $0

SectionEnd

Section "SpecChecker 静态分析工具" SecSpecChecker
  SetOutPath "$INSTDIR\tools\specchecker"
  File /r "${STAGING_DIR}\tools\specchecker\*.*"
SectionEnd

Section "SunwiseAUnit 单元测试框架" SecAUnit
  SetOutPath "$INSTDIR\tools\aunit"
  File /r "${STAGING_DIR}\tools\aunit\*.*"
SectionEnd

Section "Joern 代码属性图分析" SecJoern
  SetOutPath "$INSTDIR\tools\joern-cli"
  File /r "${STAGING_DIR}\tools\joern-cli\*.*"
SectionEnd

Section "Z3 约束求解器" SecZ3
  SetOutPath "$INSTDIR\tools\z3"
  File /r "${STAGING_DIR}\tools\z3\*.*"
SectionEnd

;--------------------------------
; Desktop shortcut (optional, checked by default on Finish page)

Section "桌面快捷方式" SecShortcut
  CreateShortcut "$DESKTOP\Matrix Agent.lnk" "$INSTDIR\runtime\opencode.exe" "" "$INSTDIR\runtime\opencode.exe"
SectionEnd

;--------------------------------
; Section descriptions

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore}        "OpenCode CLI、Bun 运行时和 Matrix 插件（必选）"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecSpecChecker}  "航天器 C 语言编码规范静态检查工具"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAUnit}        "嵌入式软件单元测试框架"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecJoern}        "代码属性图生成，用于原子性违规检测"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecZ3}           "SMT 约束求解器，用于原子性违规可行性验证"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecShortcut}     "在桌面创建 Matrix Agent 快捷方式"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

;--------------------------------
; Uninstaller

Section "Uninstall"

  ; Remove from PATH
  EnVar::DeleteValue "PATH" "$INSTDIR\runtime"

  ; Remove registry keys
  DeleteRegKey HKLM "${INSTALL_REG_KEY}"

  ; Remove files
  RMDir /r "$INSTDIR"

  ; Remove shortcuts
  Delete "$DESKTOP\Matrix Agent.lnk"

SectionEnd
```

**Step 2: Commit**

```bash
git add scripts/installer/matrix.nsi
git commit -m "feat: add NSIS installer script for Windows offline deployment"
```

---

### Task 4: Write Linux install.sh

**Files:**
- Create: `scripts/installer/install.sh`

**Step 1: Write install.sh**

Write `scripts/installer/install.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Matrix Embedded Agent — Linux Offline Installer
# Usage: sudo ./install.sh [--install-dir /opt/matrix] [--non-interactive]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/matrix"
NON_INTERACTIVE=false

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case $1 in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    -h|--help)
      echo "Usage: sudo $0 [--install-dir DIR] [--non-interactive]"
      echo "  --install-dir DIR    Installation directory (default: /opt/matrix)"
      echo "  --non-interactive    Skip interactive prompts (use env vars instead):"
      echo "    LLM_BASE_URL, LLM_MODEL, LLM_API_KEY"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Check prerequisites ---
echo "=== Matrix Embedded Agent Offline Installer ==="
echo ""

if [[ $EUID -ne 0 ]]; then
  echo "Warning: Not running as root. May lack permission to install to $INSTALL_DIR"
fi

# Check disk space (need at least 1GB)
AVAILABLE_KB=$(df -k "$(dirname "$INSTALL_DIR")" | tail -1 | awk '{print $4}')
if [[ $AVAILABLE_KB -lt 1048576 ]]; then
  echo "Error: Insufficient disk space. Need at least 1GB, available: $((AVAILABLE_KB / 1024))MB"
  exit 1
fi

# --- Interactive prompts ---
if [[ "$NON_INTERACTIVE" == false ]]; then
  read -rp "Installation directory [$INSTALL_DIR]: " input
  INSTALL_DIR="${input:-$INSTALL_DIR}"

  echo ""
  echo "--- LLM Service Configuration ---"
  read -rp "LLM API base URL (e.g. http://llm.internal:8000/v1): " LLM_BASE_URL
  read -rp "LLM model name (e.g. qwen2.5-72b-instruct): " LLM_MODEL
  read -rp "LLM API key (optional, press Enter to skip): " LLM_API_KEY
  LLM_API_KEY="${LLM_API_KEY:-}"

  echo ""
  echo "--- Optional Components ---"
  INSTALL_JOERN=false
  INSTALL_Z3=false
  read -rp "Install Joern (code property graph analysis)? [y/N]: " yn
  [[ "$yn" =~ ^[Yy] ]] && INSTALL_JOERN=true
  read -rp "Install Z3 (constraint solver)? [y/N]: " yn
  [[ "$yn" =~ ^[Yy] ]] && INSTALL_Z3=true
else
  LLM_BASE_URL="${LLM_BASE_URL:?LLM_BASE_URL must be set in non-interactive mode}"
  LLM_MODEL="${LLM_MODEL:?LLM_MODEL must be set in non-interactive mode}"
  LLM_API_KEY="${LLM_API_KEY:-}"
  INSTALL_JOERN="${INSTALL_JOERN:-false}"
  INSTALL_Z3="${INSTALL_Z3:-false}"
fi

# --- Install ---
echo ""
echo "Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"

echo "[1/5] Copying runtime (Bun + OpenCode)..."
cp -r "$SCRIPT_DIR/runtime" "$INSTALL_DIR/runtime"
chmod +x "$INSTALL_DIR/runtime/"*

echo "[2/5] Copying Matrix plugin..."
cp -r "$SCRIPT_DIR/plugin" "$INSTALL_DIR/plugin"
chmod +x "$INSTALL_DIR/plugin/bin/"* 2>/dev/null || true

echo "[3/5] Installing optional components..."
if [[ "$INSTALL_JOERN" == true ]] && [[ -d "$SCRIPT_DIR/tools/joern-cli" ]]; then
  cp -r "$SCRIPT_DIR/tools/joern-cli" "$INSTALL_DIR/tools/joern-cli"
  chmod +x "$INSTALL_DIR/tools/joern-cli/"* 2>/dev/null || true
  echo "  - Joern installed"
fi
if [[ "$INSTALL_Z3" == true ]] && [[ -d "$SCRIPT_DIR/tools/z3" ]]; then
  cp -r "$SCRIPT_DIR/tools/z3" "$INSTALL_DIR/tools/z3"
  chmod +x "$INSTALL_DIR/tools/z3/bin/"* 2>/dev/null || true
  echo "  - Z3 installed"
fi

echo "[4/5] Generating configuration..."
mkdir -p "$INSTALL_DIR/config"

# Escape paths for JSON (replace \ with \\)
ESCAPED_INSTALL_DIR=$(echo "$INSTALL_DIR" | sed 's/\\/\\\\/g')

cat > "$INSTALL_DIR/config/opencode.json" <<EOFCONFIG
{
  "provider": {
    "name": "openai-compatible",
    "base_url": "$LLM_BASE_URL",
    "api_key": "$LLM_API_KEY",
    "model": "$LLM_MODEL"
  },
  "plugins": {
    "matrix-embedded-agent": {
      "path": "$ESCAPED_INSTALL_DIR/plugin"
    }
  }
}
EOFCONFIG

echo "[5/5] Registering system paths..."

# Add to PATH via profile.d
cat > /etc/profile.d/matrix-agent.sh <<EOFPROFILE
# Matrix Embedded Agent
export PATH="$INSTALL_DIR/runtime:\$PATH"
export OPENCODE_CONFIG="$INSTALL_DIR/config/opencode.json"
EOFPROFILE
chmod +x /etc/profile.d/matrix-agent.sh

# Symlinks for convenience
ln -sf "$INSTALL_DIR/runtime/opencode" /usr/local/bin/opencode 2>/dev/null || true
ln -sf "$INSTALL_DIR/runtime/bun" /usr/local/bin/bun 2>/dev/null || true

echo ""
echo "=== Installation Complete ==="
echo "  Install dir:  $INSTALL_DIR"
echo "  LLM endpoint: $LLM_BASE_URL"
echo "  LLM model:    $LLM_MODEL"
echo ""
echo "To start using Matrix, open a new terminal and run:"
echo "  cd /path/to/your/project"
echo "  opencode /matrix-start"
echo ""
echo "Or source the profile now:  source /etc/profile.d/matrix-agent.sh"
```

**Step 2: Make it executable in git**

```bash
chmod +x scripts/installer/install.sh
```

**Step 3: Commit**

```bash
git add scripts/installer/install.sh
git commit -m "feat: add Linux offline install script"
```

---

### Task 5: Write Linux uninstall.sh

**Files:**
- Create: `scripts/installer/uninstall.sh`

**Step 1: Write uninstall.sh**

Write `scripts/installer/uninstall.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Matrix Embedded Agent — Linux Uninstaller

INSTALL_DIR="${1:-/opt/matrix}"

if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "Error: Installation not found at $INSTALL_DIR"
  echo "Usage: sudo $0 [install-dir]"
  exit 1
fi

echo "This will remove Matrix Embedded Agent from: $INSTALL_DIR"
read -rp "Continue? [y/N]: " yn
if [[ ! "$yn" =~ ^[Yy] ]]; then
  echo "Cancelled."
  exit 0
fi

echo "Removing files..."
rm -rf "$INSTALL_DIR"

echo "Removing system paths..."
rm -f /etc/profile.d/matrix-agent.sh
rm -f /usr/local/bin/opencode
rm -f /usr/local/bin/bun

echo "Done. Matrix Embedded Agent has been uninstalled."
echo "Open a new terminal for PATH changes to take effect."
```

**Step 2: Commit**

```bash
chmod +x scripts/installer/uninstall.sh
git add scripts/installer/uninstall.sh
git commit -m "feat: add Linux offline uninstall script"
```

---

### Task 6: Write the pack-offline.ts orchestrator (Part 1 — CLI and staging)

**Files:**
- Create: `scripts/pack-offline.ts`

This is the main packaging script. It runs on a **networked build machine**, collects all artifacts into a staging directory, then produces the platform-specific installer.

**Step 1: Write pack-offline.ts — argument parsing and staging logic**

Write `scripts/pack-offline.ts`:

```typescript
#!/usr/bin/env bun
/**
 * pack-offline.ts — Build an offline installer package for Matrix Embedded Agent.
 *
 * Usage:
 *   bun scripts/pack-offline.ts --platform windows --version 0.1.0
 *   bun scripts/pack-offline.ts --platform linux --version 0.1.0
 *
 * Prerequisites:
 *   - Run from the project root after `bun install && bun run build`
 *   - For Windows: NSIS 3.x must be installed (makensis on PATH)
 *   - External tool archives placed in tools-archive/ (optional)
 */
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { execSync } from "child_process"

const ROOT = resolve(import.meta.dir, "..")
const STAGING_BASE = join(ROOT, ".pack-staging")
const RELEASE_DIR = join(ROOT, "release")
const INSTALLER_DIR = join(ROOT, "scripts", "installer")

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface PackOptions {
  platform: "windows" | "linux"
  version: string
  toolsArchive?: string // optional path to directory containing external tool archives
}

function parseArgs(): PackOptions {
  const args = process.argv.slice(2)
  let platform: string | undefined
  let version: string | undefined
  let toolsArchive: string | undefined

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--platform":
        platform = args[++i]
        break
      case "--version":
        version = args[++i]
        break
      case "--tools-archive":
        toolsArchive = args[++i]
        break
      case "--help":
        console.log("Usage: bun scripts/pack-offline.ts --platform <windows|linux> --version <X.Y.Z>")
        console.log("  --tools-archive <dir>  Directory containing external tool archives")
        process.exit(0)
    }
  }

  if (!platform || !["windows", "linux"].includes(platform)) {
    console.error("Error: --platform must be 'windows' or 'linux'")
    process.exit(1)
  }
  if (!version) {
    console.error("Error: --version is required")
    process.exit(1)
  }

  return { platform: platform as "windows" | "linux", version, toolsArchive }
}

// ---------------------------------------------------------------------------
// Staging: collect all files into a flat staging directory
// ---------------------------------------------------------------------------

function stage(opts: PackOptions): string {
  const stagingDir = join(STAGING_BASE, `matrix-offline-v${opts.version}-${opts.platform}-x64`)

  // Clean previous staging
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true })
  }
  mkdirSync(stagingDir, { recursive: true })

  console.log(`\nStaging to: ${stagingDir}\n`)

  // 1. Plugin files
  console.log("[1/4] Staging plugin...")
  const pluginDir = join(stagingDir, "plugin")
  mkdirSync(pluginDir, { recursive: true })

  const pluginDirs = ["dist", "bin", "joern", "skills", "templates", "standards"]
  for (const dir of pluginDirs) {
    const src = join(ROOT, dir)
    if (existsSync(src)) {
      cpSync(src, join(pluginDir, dir), { recursive: true })
      console.log(`  - ${dir}/`)
    }
  }

  // Copy node_modules (pre-installed)
  const nmSrc = join(ROOT, "node_modules")
  if (!existsSync(nmSrc)) {
    console.error("Error: node_modules/ not found. Run 'bun install' first.")
    process.exit(1)
  }
  console.log("  - node_modules/ (this may take a moment...)")
  cpSync(nmSrc, join(pluginDir, "node_modules"), { recursive: true })

  // Copy package.json without postinstall script
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"))
  delete pkg.scripts?.postinstall
  delete pkg.devDependencies
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify(pkg, null, 2))
  console.log("  - package.json (postinstall removed)")

  // 2. Runtime binaries (placeholders — these need to be provided)
  console.log("\n[2/4] Staging runtime...")
  const runtimeDir = join(stagingDir, "runtime")
  mkdirSync(runtimeDir, { recursive: true })

  // Check for pre-downloaded runtime binaries
  const runtimeSrcDir = join(ROOT, "tools-archive", "runtime", opts.platform)
  if (existsSync(runtimeSrcDir)) {
    cpSync(runtimeSrcDir, runtimeDir, { recursive: true })
    console.log("  - Copied from tools-archive/runtime/")
  } else {
    console.warn(`  ! Runtime binaries not found at ${runtimeSrcDir}`)
    console.warn("    Please place bun and opencode binaries there before packaging.")
    console.warn("    Creating empty runtime/ — you must populate it manually.")
  }

  // 3. Optional external tools
  console.log("\n[3/4] Staging optional tools...")
  const toolsDir = join(stagingDir, "tools")
  mkdirSync(toolsDir, { recursive: true })

  const toolNames = ["specchecker", "aunit", "joern-cli", "z3"]
  const archiveBase = opts.toolsArchive || join(ROOT, "tools-archive", "tools", opts.platform)
  for (const tool of toolNames) {
    const toolSrc = join(archiveBase, tool)
    if (existsSync(toolSrc)) {
      cpSync(toolSrc, join(toolsDir, tool), { recursive: true })
      console.log(`  - ${tool}/`)
    } else {
      console.log(`  - ${tool}/ (not found, skipping)`)
    }
  }

  // 4. Installer files
  console.log("\n[4/4] Staging installer files...")
  if (opts.platform === "linux") {
    cpSync(join(INSTALLER_DIR, "install.sh"), join(stagingDir, "install.sh"))
    cpSync(join(INSTALLER_DIR, "uninstall.sh"), join(stagingDir, "uninstall.sh"))
    console.log("  - install.sh, uninstall.sh")
  }

  // Config templates (both platforms — Linux uses them in install.sh, Windows uses NSIS inline)
  const configDir = join(stagingDir, "config")
  mkdirSync(configDir, { recursive: true })
  cpSync(join(INSTALLER_DIR, "opencode.json.template"), join(configDir, "opencode.json.template"))
  cpSync(join(INSTALLER_DIR, "matrix.jsonc.template"), join(configDir, "matrix.jsonc.template"))
  console.log("  - config templates")

  return stagingDir
}

// ---------------------------------------------------------------------------
// Package: platform-specific archive/installer generation
// ---------------------------------------------------------------------------

function packageWindows(stagingDir: string, opts: PackOptions): void {
  console.log("\n=== Building Windows NSIS Installer ===\n")

  // Check makensis is available
  try {
    execSync("makensis /VERSION", { stdio: "pipe" })
  } catch {
    console.error("Error: makensis not found on PATH. Install NSIS 3.x first.")
    console.error("  https://nsis.sourceforge.io/Download")
    process.exit(1)
  }

  mkdirSync(RELEASE_DIR, { recursive: true })

  const nsiPath = join(INSTALLER_DIR, "matrix.nsi")
  const outFile = `matrix-offline-v${opts.version}-windows-x64.exe`

  execSync(
    `makensis /DPRODUCT_VERSION=${opts.version} /DSTAGING_DIR="${stagingDir}" /DOUTFILE="${join(RELEASE_DIR, outFile)}" "${nsiPath}"`,
    { stdio: "inherit", cwd: INSTALLER_DIR },
  )

  console.log(`\nWindows installer: ${join(RELEASE_DIR, outFile)}`)
}

function packageLinux(stagingDir: string, opts: PackOptions): void {
  console.log("\n=== Building Linux tar.gz Archive ===\n")

  mkdirSync(RELEASE_DIR, { recursive: true })

  const archiveName = `matrix-offline-v${opts.version}-linux-x64.tar.gz`
  const archivePath = join(RELEASE_DIR, archiveName)

  // Make scripts executable
  execSync(`chmod +x "${join(stagingDir, "install.sh")}"`, { stdio: "inherit" })
  execSync(`chmod +x "${join(stagingDir, "uninstall.sh")}"`, { stdio: "inherit" })

  // Create tar.gz
  execSync(
    `tar -czf "${archivePath}" -C "${join(stagingDir, "..")}" "${join(stagingDir).split(/[/\\]/).pop()}"`,
    { stdio: "inherit" },
  )

  console.log(`\nLinux archive: ${archivePath}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs()

console.log(`Matrix Offline Packager`)
console.log(`  Platform: ${opts.platform}`)
console.log(`  Version:  ${opts.version}`)

// Verify build
if (!existsSync(join(ROOT, "dist", "index.js"))) {
  console.error("Error: dist/index.js not found. Run 'bun run build' first.")
  process.exit(1)
}

const stagingDir = stage(opts)

if (opts.platform === "windows") {
  packageWindows(stagingDir, opts)
} else {
  packageLinux(stagingDir, opts)
}

// Cleanup staging
console.log("\nCleaning up staging directory...")
rmSync(STAGING_BASE, { recursive: true })

console.log("\nDone!")
```

**Step 2: Register the pack:offline script in package.json**

Add to `package.json` scripts:

```jsonc
"pack:offline": "bun scripts/pack-offline.ts"
```

Modify `package.json`:

```diff
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun --format esm",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
-   "postinstall": "bun scripts/postinstall.ts"
+   "postinstall": "bun scripts/postinstall.ts",
+   "pack:offline": "bun scripts/pack-offline.ts"
  },
```

**Step 3: Commit**

```bash
git add scripts/pack-offline.ts package.json
git commit -m "feat: add pack-offline.ts orchestrator for offline deployment packaging"
```

---

### Task 7: Update .gitignore for packaging artifacts

**Files:**
- Modify: `.gitignore`

**Step 1: Add packaging-related entries to .gitignore**

Append to `.gitignore`:

```gitignore
# Offline packaging
.pack-staging/
release/
tools-archive/
```

**Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore packaging artifacts"
```

---

### Task 8: Write packaging documentation (README for IT admins)

**Files:**
- Create: `scripts/installer/README.md`

**Step 1: Write the packaging and deployment guide**

Write `scripts/installer/README.md`:

```markdown
# Matrix Embedded Agent — 离线部署指南

## 构建离线安装包（在联网构建机上执行）

### 前置条件

1. **Bun** >= 1.0 已安装
2. **NSIS 3.x** 已安装（仅构建 Windows 包时需要，`makensis` 须在 PATH 上）
3. 项目已 clone 并安装依赖：

```bash
git clone <repo-url>
cd matrix-embedded-agent
bun install       # 安装依赖 + 下载 mdbook/sg 二进制
bun run build     # 构建 dist/index.js
```

### 准备运行时二进制

在项目根目录创建 `tools-archive/` 目录结构：

```
tools-archive/
├── runtime/
│   ├── windows/            # 放入 bun.exe 和 opencode.exe
│   └── linux/              # 放入 bun 和 opencode 二进制
└── tools/
    ├── windows/
    │   ├── specchecker/    # SpecChecker 安装目录（可选）
    │   ├── aunit/          # SunwiseAUnit 安装目录（可选）
    │   ├── joern-cli/      # Joern CLI（可选）
    │   └── z3/             # Z3 求解器（可选）
    └── linux/
        ├── joern-cli/      # Joern CLI（可选）
        └── z3/             # Z3 求解器（可选）
```

### 构建命令

```bash
# 构建 Windows 安装程序 (.exe)
bun run pack:offline -- --platform windows --version 0.1.0

# 构建 Linux 归档包 (.tar.gz)
bun run pack:offline -- --platform linux --version 0.1.0
```

产物输出到 `release/` 目录。

---

## 部署（在目标离线机器上执行）

### Windows

1. 将 `matrix-offline-v{VERSION}-windows-x64.exe` 拷贝到目标机器
2. 双击运行安装程序
3. 按向导提示操作：
   - 选择安装目录
   - 勾选需要的组件
   - 填写私有 LLM 服务地址、模型名称、API Key
4. 安装完成后打开 cmd/PowerShell，验证：
   ```
   opencode --version
   ```

### Linux

1. 将 `matrix-offline-v{VERSION}-linux-x64.tar.gz` 拷贝到目标机器
2. 解压并运行安装脚本：
   ```bash
   tar xzf matrix-offline-v0.1.0-linux-x64.tar.gz
   cd matrix-offline-v0.1.0-linux-x64/
   sudo ./install.sh
   ```
3. 按提示输入安装目录、LLM 配置等信息
4. 打开新终端，验证：
   ```bash
   opencode --version
   ```

### 无人值守安装 (Linux)

```bash
LLM_BASE_URL="http://llm.internal:8000/v1" \
LLM_MODEL="qwen2.5-72b-instruct" \
LLM_API_KEY="sk-xxx" \
sudo -E ./install.sh --install-dir /opt/matrix --non-interactive
```

---

## 私有化 LLM 推荐要求

Matrix 的多 Agent 系统对 LLM 能力有较高要求：

| 要求 | 最低 | 推荐 |
|------|------|------|
| 上下文窗口 | 16K tokens | 32K+ tokens |
| Function Calling | 必须支持 | — |
| 参数规模 | 30B | 70B+ |
| 推荐模型 | — | Qwen2.5-72B, DeepSeek-V3 |

---

## 卸载

### Windows

控制面板 → 程序和功能 → Matrix Embedded Agent → 卸载

### Linux

```bash
sudo /opt/matrix/uninstall.sh
# 或指定自定义安装目录:
sudo /path/to/uninstall.sh /custom/install/dir
```
```

**Step 2: Commit**

```bash
git add scripts/installer/README.md
git commit -m "docs: add offline deployment guide for IT admins"
```

---

### Task 9: End-to-end test — dry run the Linux packaging pipeline

**Files:** None (verification only)

**Step 1: Build the project**

```bash
bun install
bun run build
```

Expected: `dist/index.js` exists, `bin/mdbook.exe` and `bin/sg.exe` exist.

**Step 2: Create minimal runtime stubs for testing**

```bash
mkdir -p tools-archive/runtime/linux
echo '#!/bin/sh' > tools-archive/runtime/linux/bun
echo '#!/bin/sh' > tools-archive/runtime/linux/opencode
chmod +x tools-archive/runtime/linux/*
```

**Step 3: Run pack:offline for Linux**

```bash
bun run pack:offline -- --platform linux --version 0.1.0-test
```

Expected:
- `release/matrix-offline-v0.1.0-test-linux-x64.tar.gz` is created
- No errors in output
- Staging directory is cleaned up

**Step 4: Verify archive contents**

```bash
tar tzf release/matrix-offline-v0.1.0-test-linux-x64.tar.gz | head -20
```

Expected: See `plugin/dist/index.js`, `plugin/bin/`, `plugin/skills/`, `runtime/`, `install.sh`, etc.

**Step 5: Clean up test artifacts**

```bash
rm -rf release/ tools-archive/
```

---

### Task 10: End-to-end test — dry run the Windows NSIS packaging (if NSIS available)

**Files:** None (verification only)

**Step 1: Check NSIS availability**

```bash
makensis /VERSION
```

If not available, skip this task — NSIS testing requires NSIS to be installed.

**Step 2: Create minimal runtime stubs**

```bash
mkdir -p tools-archive/runtime/windows
echo "stub" > tools-archive/runtime/windows/bun.exe
echo "stub" > tools-archive/runtime/windows/opencode.exe
```

**Step 3: Run pack:offline for Windows**

```bash
bun run pack:offline -- --platform windows --version 0.1.0-test
```

Expected: `release/matrix-offline-v0.1.0-test-windows-x64.exe` is created.

**Step 4: Clean up**

```bash
rm -rf release/ tools-archive/
```

**Step 5: Commit any fixes discovered during testing**

```bash
git add -A
git commit -m "fix: address issues found during offline packaging dry run"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Installer directory + placeholder assets | `scripts/installer/`, `scripts/create-installer-assets.ts` |
| 2 | Config templates | `scripts/installer/*.template` |
| 3 | NSIS installer script | `scripts/installer/matrix.nsi` |
| 4 | Linux install.sh | `scripts/installer/install.sh` |
| 5 | Linux uninstall.sh | `scripts/installer/uninstall.sh` |
| 6 | pack-offline.ts orchestrator | `scripts/pack-offline.ts`, `package.json` |
| 7 | .gitignore updates | `.gitignore` |
| 8 | Packaging documentation | `scripts/installer/README.md` |
| 9 | E2E test: Linux dry run | (verification) |
| 10 | E2E test: Windows NSIS dry run | (verification) |
