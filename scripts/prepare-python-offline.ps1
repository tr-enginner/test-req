#!/usr/bin/env pwsh
[CmdletBinding()]
param(
  [string]$PythonVersion = "3.12",
  [switch]$Force,
  [switch]$Offline,
  [switch]$DownloadOnly
)

# =============================================================================
# Matrix Embedded Agent — Prepare Python Offline Payload (Windows)
# =============================================================================
# Build-machine script to prepare the offline Python runtime for packaging.
#
# Two modes:
#   ONLINE  (default): pip install directly from PyPI — build machine needs internet
#   OFFLINE (-Offline): pip install from pre-downloaded wheels — build machine air-gapped
#
# Workflow for air-gapped build machine:
#   Step 1 (internet machine): .\scripts\prepare-python-offline.ps1 -DownloadOnly
#          → downloads all wheels to tools-archive/python/wheels/
#   Step 2 (copy tools-archive/ to air-gapped build machine)
#   Step 3 (air-gapped): .\scripts\prepare-python-offline.ps1 -Offline
#          → installs from local wheels only
#
# Usage:
#   .\scripts\prepare-python-offline.ps1                   # Online mode (default)
#   .\scripts\prepare-python-offline.ps1 -Offline          # Offline mode (local wheels)
#   .\scripts\prepare-python-offline.ps1 -DownloadOnly     # Download wheels only, skip install
#   .\scripts\prepare-python-offline.ps1 -Force            # Force rebuild venv
# =============================================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$InstallerScript = Join-Path $ScriptDir "installer\prepare-tools-archive.windows.ps1"
$WheelsDir = Join-Path $ProjectRoot "tools-archive\python\wheels"
$RequirementsFile = Join-Path $ProjectRoot "tools-archive-requirements.txt"

if (-not (Test-Path -LiteralPath $InstallerScript)) {
  Write-Error "Installer script not found: $InstallerScript"
  exit 1
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Matrix — Prepare Python Offline Payload (Windows)" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Project root    : $ProjectRoot"
Write-Host "Python version  : $PythonVersion"
Write-Host "Force rebuild   : $Force"
Write-Host "Offline mode    : $Offline"
Write-Host "Download only   : $DownloadOnly"
Write-Host ""

# ---------------------------------------------------------------------------
# DownloadOnly mode — pre-download all wheel files for air-gapped use
# ---------------------------------------------------------------------------
if ($DownloadOnly) {
  Write-Host "[INFO]  DownloadOnly mode: pre-caching all pip wheels..." -ForegroundColor Cyan
  Write-Host ""

  # Find a Python to run pip download
  $bootstrap = $null
  $py = Get-Command "py.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($py) {
    $bootstrap = @{ exe = $py.Source; args = @("-$PythonVersion") }
  }
  if (-not $bootstrap) {
    $python = Get-Command "python.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($python) {
      $bootstrap = @{ exe = $python.Source; args = @() }
    }
  }

  if (-not $bootstrap) {
    Write-Error "No Python found. Install Python or py.exe launcher first."
    exit 1
  }

  if (-not (Test-Path -LiteralPath $RequirementsFile)) {
    Write-Error "Requirements file not found: $RequirementsFile"
    exit 1
  }

  # Remove old wheels if Force
  if ($Force -and (Test-Path -LiteralPath $WheelsDir)) {
    Remove-Item -LiteralPath $WheelsDir -Recurse -Force
  }

  if (-not (Test-Path -LiteralPath $WheelsDir)) {
    New-Item -ItemType Directory -Path $WheelsDir -Force | Out-Null
  }

  Write-Host "[INFO]  Downloading wheels to: $WheelsDir" -ForegroundColor Cyan
  Write-Host "[INFO]  Requirements: $RequirementsFile" -ForegroundColor Cyan

  $downloadArgs = @($bootstrap.args) + @(
    "-m", "pip", "download",
    "--requirement", $RequirementsFile,
    "--dest", $WheelsDir
  )

  & $bootstrap.exe @downloadArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Error "pip download failed."
    exit $LASTEXITCODE
  }

  Write-Host ""
  Write-Host "Wheels downloaded to: $WheelsDir" -ForegroundColor Green
  Write-Host "Copy the entire tools-archive/ directory to your air-gapped build machine."
  Write-Host "Then run: .\scripts\prepare-python-offline.ps1 -Offline"
  Write-Host ""
  exit 0
}

# ---------------------------------------------------------------------------
# Offline mode — install from local wheels only
# ---------------------------------------------------------------------------
if ($Offline) {
  if (-not (Test-Path -LiteralPath $WheelsDir)) {
    Write-Error "Wheel directory not found: $WheelsDir. Run -DownloadOnly first on an internet-connected machine."
    exit 1
  }

  $wheelCount = (Get-ChildItem -LiteralPath $WheelsDir -Filter "*.whl").Count
  if ($wheelCount -eq 0) {
    Write-Error "No .whl files found in $WheelsDir. Run -DownloadOnly first on an internet-connected machine."
    exit 1
  }
  Write-Host "[INFO]  Found $wheelCount wheel files in $WheelsDir" -ForegroundColor Cyan
  Write-Host "[INFO]  Installing from local wheels (no internet required)..." -ForegroundColor Cyan
  Write-Host ""
}

# ---------------------------------------------------------------------------
# Delegate to the full installer script (handles venv creation + pip install)
# ---------------------------------------------------------------------------
$delegateArgs = @(
  "-PythonVersion", $PythonVersion,
  "-SkipRuntime"   # Only prepare Python, runtime binaries handled by pack-offline.ts
)

if ($Force) {
  $delegateArgs += "-ForcePythonRebuild"
}

Write-Host "[INFO]  Delegating to prepare-tools-archive.windows.ps1 ..." -ForegroundColor Cyan

& $InstallerScript @delegateArgs

if ($LASTEXITCODE -ne 0) {
  Write-Error "Python payload preparation failed. See output above for details."
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------------------
# Offline mode: install from local wheels into the venv
# ---------------------------------------------------------------------------
if ($Offline) {
  $pythonWindows = Join-Path $ProjectRoot "tools-archive\python\windows"
  $pythonExe = Join-Path $pythonWindows "Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $pythonExe)) {
    $pythonExe = Join-Path $pythonWindows "python.exe"
  }

  if (-not (Test-Path -LiteralPath $pythonExe)) {
    Write-Error "Python executable not found after venv creation: $pythonExe"
    exit 1
  }

  Write-Host ""
  Write-Host "[INFO]  Installing packages from local wheels into venv..." -ForegroundColor Cyan

  & $pythonExe -m pip install --upgrade pip --quiet

  $installArgs = @(
    "-m", "pip", "install",
    "--no-index",
    "--find-links", $WheelsDir,
    "--requirement", $RequirementsFile
  )

  & $pythonExe @installArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Offline pip install failed. Check that all dependency wheels are present in $WheelsDir."
    exit $LASTEXITCODE
  }
}

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
$pythonWindows = Join-Path $ProjectRoot "tools-archive\python\windows"
$pythonExe = Join-Path $pythonWindows "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) {
  $pythonExe = Join-Path $pythonWindows "python.exe"
}

if (Test-Path -LiteralPath $pythonExe) {
  Write-Host ""
  Write-Host "Verifying Python payload..." -ForegroundColor Cyan
  & $pythonExe -c "import docxtpl, docx, fastapi, jinja2; print('  docxtpl     :', docxtpl.__version__); print('  python-docx :', docx.__version__); print('  fastapi     :', fastapi.__version__)"
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Package import verification failed. Check pip install output above."
  } else {
    Write-Host ""
    Write-Host "Python payload is ready." -ForegroundColor Green
  }
} else {
  Write-Warning "Python executable not found at expected location: $pythonExe"
}

Write-Host ""
Write-Host "Next step:" -ForegroundColor Green
Write-Host "  bun run build"
Write-Host "  bun run pack:offline -- --platform windows --version <X.Y.Z>"
Write-Host ""
