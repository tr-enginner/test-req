[CmdletBinding()]
param(
  [string]$ToolsArchive = "",
  [string]$PythonVersion = "3.12",
  [switch]$ForceRuntimeRefresh,
  [switch]$ForcePythonRebuild,
  [switch]$SkipRuntime,
  [switch]$SkipPython
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info([string]$Message) {
  Write-Host "[INFO]  $Message" -ForegroundColor Cyan
}

function Write-WarnMsg([string]$Message) {
  Write-Host "[WARN]  $Message" -ForegroundColor Yellow
}

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Green
}

function Ensure-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Copy-FileIfNeeded([string]$Source, [string]$Destination, [switch]$ForceCopy) {
  if (-not (Test-Path -LiteralPath $Source)) {
    return $false
  }
  if ((-not $ForceCopy) -and (Test-Path -LiteralPath $Destination)) {
    return $true
  }
  Ensure-Dir (Split-Path -Parent $Destination)
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  return $true
}

function Copy-DirIfNeeded([string]$Source, [string]$Destination, [switch]$ForceCopy) {
  if (-not (Test-Path -LiteralPath $Source)) {
    return $false
  }
  if ($ForceCopy -and (Test-Path -LiteralPath $Destination)) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  Ensure-Dir (Split-Path -Parent $Destination)
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
  return $true
}

function Resolve-CommandPath([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $cmd) {
    return $null
  }
  return $cmd.Source
}

function Assert-PathExists([string]$Path, [string]$Message) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw $Message
  }
}

function Resolve-GlobalNpmRoot() {
  try {
    $out = & cmd.exe /c "npm root -g" 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) {
      return ($out | Select-Object -First 1).Trim()
    }
  } catch {
  }
  $fallback = Join-Path $env:APPDATA "npm\node_modules"
  if (Test-Path -LiteralPath $fallback) {
    return $fallback
  }
  return $null
}

function Resolve-PythonBootstrap() {
  $launchers = @()
  $py = Resolve-CommandPath "py.exe"
  if ($py) {
    $launchers += @{ exe = $py; args = @("-$PythonVersion") }
    $launchers += @{ exe = $py; args = @("-3") }
  }
  $python = Resolve-CommandPath "python.exe"
  if ($python) {
    $launchers += @{ exe = $python; args = @() }
  }

  foreach ($candidate in $launchers) {
    try {
      & $candidate.exe @($candidate.args + @("-c", "import sys; print(sys.executable)")) | Out-Null
      if ($LASTEXITCODE -eq 0) {
        return $candidate
      }
    } catch {
    }
  }
  return $null
}

function Invoke-Checked([string]$Exe, [string[]]$Arguments, [string]$Description) {
  Write-Info $Description
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $Exe $($Arguments -join ' ')"
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $ToolsArchive) {
  $ToolsArchive = Join-Path $repoRoot "tools-archive"
}
$ToolsArchive = [System.IO.Path]::GetFullPath($ToolsArchive)

$runtimeWindows = Join-Path $ToolsArchive "runtime\windows"
$pythonWindows = Join-Path $ToolsArchive "python\windows"

Ensure-Dir $runtimeWindows
Ensure-Dir $pythonWindows

Write-Info "tools-archive: $ToolsArchive"

if (-not $SkipRuntime) {
  Write-Step "Prepare runtime/windows"

  $runtimeFiles = @(
    @{ name = "bun.exe"; source = (Resolve-CommandPath "bun.exe") },
    @{ name = "opencode.exe"; source = (Resolve-CommandPath "opencode.exe") },
    @{ name = "node.exe"; source = (Resolve-CommandPath "node.exe") },
    @{ name = "rg.exe"; source = (Resolve-CommandPath "rg.exe") }
  )

  foreach ($item in $runtimeFiles) {
    if (-not $item.source) {
      Write-WarnMsg "$($item.name) not found in PATH; please place it under $runtimeWindows manually."
      continue
    }
    $dest = Join-Path $runtimeWindows $item.name
    if (Copy-FileIfNeeded -Source $item.source -Destination $dest -ForceCopy:$ForceRuntimeRefresh) {
      Write-Info "Runtime file ready: $($item.name)"
    }
  }

  $opencodeWrapper = Resolve-CommandPath "opencode"
  if (-not $opencodeWrapper) {
    $opencodeWrapper = Resolve-CommandPath "opencode.ps1"
  }
  if ($opencodeWrapper) {
    $wrapperDir = Split-Path -Parent $opencodeWrapper
    foreach ($wrapperName in @("opencode", "opencode.cmd", "opencode.ps1")) {
      $src = Join-Path $wrapperDir $wrapperName
      $dest = Join-Path $runtimeWindows $wrapperName
      if (Copy-FileIfNeeded -Source $src -Destination $dest -ForceCopy:$ForceRuntimeRefresh) {
        Write-Info "Runtime file ready: $wrapperName"
      }
    }
  } else {
    Write-WarnMsg "opencode wrapper not found in PATH; please install opencode globally before packaging."
  }

  $npmRoot = Resolve-GlobalNpmRoot
  if ($npmRoot) {
    $opencodePkg = Join-Path $npmRoot "opencode-ai"
    $opencodeDest = Join-Path $runtimeWindows "node_modules\opencode-ai"
    if (Copy-DirIfNeeded -Source $opencodePkg -Destination $opencodeDest -ForceCopy:$ForceRuntimeRefresh) {
      Write-Info "Copied global opencode-ai package into runtime/windows/node_modules"
    } else {
      Write-WarnMsg "Global opencode-ai package not found under $npmRoot; opencode wrappers may not run offline."
    }
  } else {
    Write-WarnMsg "Unable to resolve npm global root; skipped copying opencode-ai package."
  }

  $requiredRuntime = @(
    @{ name = "bun.exe"; path = (Join-Path $runtimeWindows "bun.exe") },
    @{ name = "opencode.exe"; path = (Join-Path $runtimeWindows "opencode.exe") },
    @{ name = "rg.exe"; path = (Join-Path $runtimeWindows "rg.exe") }
  )

  foreach ($item in $requiredRuntime) {
    Assert-PathExists -Path $item.path -Message "$($item.name) is required for offline packaging. Please place it under $runtimeWindows and rerun this script."
  }
}

if (-not $SkipPython) {
  Write-Step "Prepare python/windows"

  $pythonRequirements = Join-Path $repoRoot "tools-archive-requirements.txt"
  if (-not (Test-Path -LiteralPath $pythonRequirements)) {
    throw "Python requirements file not found: $pythonRequirements"
  }
  $pythonRequirements = (Resolve-Path -LiteralPath $pythonRequirements).Path

  if ($ForcePythonRebuild -and (Test-Path -LiteralPath $pythonWindows)) {
    Remove-Item -LiteralPath $pythonWindows -Recurse -Force
    Ensure-Dir $pythonWindows
  }

  $targetPython = Join-Path $pythonWindows "Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $targetPython)) {
    $targetPython = Join-Path $pythonWindows "python.exe"
  }

  if (-not (Test-Path -LiteralPath $targetPython)) {
    $bootstrap = Resolve-PythonBootstrap
    if ($null -eq $bootstrap) {
      throw "No usable Python bootstrap found. Install Python/py launcher first, or prepare $pythonWindows manually."
    }

    Invoke-Checked -Exe $bootstrap.exe -Arguments @($bootstrap.args + @("-m", "venv", $pythonWindows)) -Description "Creating virtual environment at $pythonWindows"

    $targetPython = Join-Path $pythonWindows "Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $targetPython)) {
      $targetPython = Join-Path $pythonWindows "python.exe"
    }
  }

  $env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
  Invoke-Checked -Exe $targetPython -Arguments @("-m", "pip", "install", "--upgrade", "pip") -Description "Upgrading pip inside offline Python runtime"
  Invoke-Checked -Exe $targetPython -Arguments @("-m", "pip", "install", "--upgrade", "--requirement", $pythonRequirements) -Description "Installing offline Python requirements from $pythonRequirements"
}

Write-Host ""
Write-Host "Done. Next step:" -ForegroundColor Green
Write-Host "  bun run build"
Write-Host "  bun run pack:offline -- --platform windows --version 0.1.0"
