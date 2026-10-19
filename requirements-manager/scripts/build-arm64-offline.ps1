param(
  [string]$OutputDirectory = "release/requirements-manager-arm64-offline",
  [string]$ComposeVersion = "v2.39.2",
  [string]$DownloadCacheDirectory = "release/download-cache",
  [string]$HostProxyUrl = "",
  [switch]$RefreshDownloads,
  [switch]$ReuseLocalThirdPartyImages,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepositoryRoot = (Resolve-Path (Join-Path $ProjectRoot "..")).Path
$OutputPath = Join-Path $ProjectRoot $OutputDirectory
$DownloadCachePath = if ([System.IO.Path]::IsPathRooted($DownloadCacheDirectory)) {
  [System.IO.Path]::GetFullPath($DownloadCacheDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $DownloadCacheDirectory))
}
$ImagesArchive = Join-Path $OutputPath "requirements-manager-arm64-images.tar"
$BundleArchive = "$OutputPath.tar.gz"
$BuildProxyArguments = @()
$MinioVersion = "RELEASE.2025-10-15T17-29-55Z"
$MinioSource = "ghcr.io/coollabsio/minio:$MinioVersion"

function Assert-MinioVersion {
  $VersionOutput = & docker run --rm --platform linux/arm64 --entrypoint minio requirements-manager-minio:arm64 --version
  if ($LASTEXITCODE -ne 0 -or ($VersionOutput -join "`n") -notmatch ("(?m)^minio version " + [regex]::Escape($MinioVersion) + "(?:\s|$)")) {
    throw "MinIO镜像版本不匹配或无法运行，需要 $MinioVersion。请去掉-ReuseLocalThirdPartyImages重新构建，或执行 docker pull --platform linux/arm64 $MinioSource 后执行 docker tag $MinioSource requirements-manager-minio:arm64。检测结果：$VersionOutput"
  }
  Write-Host ($VersionOutput -join "`n")
}

if ($HostProxyUrl) {
  $env:HTTP_PROXY = $HostProxyUrl
  $env:HTTPS_PROXY = $HostProxyUrl
  $ContainerProxyUrl = $HostProxyUrl -replace '127\.0\.0\.1', 'host.docker.internal' -replace 'localhost', 'host.docker.internal'
  $BuildProxyArguments = @(
    "--build-arg", "HTTP_PROXY=$ContainerProxyUrl",
    "--build-arg", "HTTPS_PROXY=$ContainerProxyUrl"
  )
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败：$Command $($Arguments -join ' ')"
  }
}

function Invoke-Download([string]$Uri, [string]$Destination, [string]$ProxyUrl = "") {
  $Arguments = @(
    "--fail",
    "--location",
    "--retry", "8",
    "--retry-delay", "3",
    "--retry-all-errors",
    "--continue-at", "-",
    "--output", $Destination
  )
  if ($ProxyUrl) {
    $Arguments += @("--proxy", $ProxyUrl)
  }
  $Arguments += $Uri
  Invoke-Checked "curl.exe" $Arguments
}

function Test-Arm64Elf([string]$Path) {
  if (-not (Test-Path $Path -PathType Leaf)) {
    return $false
  }
  $Stream = [System.IO.File]::OpenRead($Path)
  try {
    if ($Stream.Length -lt 20) {
      return $false
    }
    $Header = New-Object byte[] 20
    if ($Stream.Read($Header, 0, $Header.Length) -ne $Header.Length) {
      return $false
    }
    # ELF magic + 64-bit + little-endian + e_machine=AArch64 (0x00B7).
    return $Header[0] -eq 0x7f -and $Header[1] -eq 0x45 -and $Header[2] -eq 0x4c -and `
      $Header[3] -eq 0x46 -and $Header[4] -eq 2 -and $Header[5] -eq 1 -and `
      $Header[18] -eq 0xb7 -and $Header[19] -eq 0x00
  } finally {
    $Stream.Dispose()
  }
}

function Get-CachedArm64Download(
  [string]$Uri,
  [string]$CachePath,
  [string]$ProxyUrl = "",
  [switch]$Refresh
) {
  if (-not $Refresh -and (Test-Arm64Elf $CachePath)) {
    Write-Host "复用已缓存的ARM64二进制：$CachePath"
    return $CachePath
  }

  New-Item (Split-Path $CachePath -Parent) -ItemType Directory -Force | Out-Null
  $PartialPath = "$CachePath.partial"
  if ($Refresh -and (Test-Path $PartialPath)) {
    Remove-Item $PartialPath -Force
  }
  Write-Host "下载ARM64二进制到缓存：$CachePath"
  Invoke-Download $Uri $PartialPath $ProxyUrl
  if (-not (Test-Arm64Elf $PartialPath)) {
    throw "下载文件不是有效的Linux ARM64 ELF二进制：$PartialPath"
  }
  Move-Item $PartialPath $CachePath -Force
  return $CachePath
}

Write-Host "检查Docker Buildx..."
Invoke-Checked "docker" @("buildx", "version")

if ($ReuseLocalThirdPartyImages) {
  # Reject stale MinIO before spending time rebuilding application images.
  Assert-MinioVersion
}

if (-not $SkipBuild) {
  Write-Host "构建ARM64 API镜像..."
  Invoke-Checked "docker" (@("buildx", "build", "--platform", "linux/arm64", "--load") + $BuildProxyArguments + @("--target", "api", "-t", "requirements-manager-api:arm64", "-f", (Join-Path $ProjectRoot "docker/app.Dockerfile"), $ProjectRoot))

  Write-Host "构建ARM64 Worker镜像..."
  Invoke-Checked "docker" (@("buildx", "build", "--platform", "linux/arm64", "--load") + $BuildProxyArguments + @("--target", "worker", "-t", "requirements-manager-worker:arm64", "-f", (Join-Path $ProjectRoot "docker/app.Dockerfile"), $ProjectRoot))

  Write-Host "构建ARM64 Web镜像..."
  Invoke-Checked "docker" (@("buildx", "build", "--platform", "linux/arm64", "--load") + $BuildProxyArguments + @("--target", "web", "-t", "requirements-manager-web:arm64", "-f", (Join-Path $ProjectRoot "docker/app.Dockerfile"), $ProjectRoot))

  Write-Host "构建ARM64 OpenCode镜像..."
  Invoke-Checked "docker" (@("buildx", "build", "--platform", "linux/arm64", "--load") + $BuildProxyArguments + @("-t", "requirements-manager-opencode:arm64", "-f", (Join-Path $ProjectRoot "docker/opencode.Dockerfile"), $RepositoryRoot))
}

$ThirdPartyImageDefinitions = @(
  @{ Source = "postgres:16-alpine"; Target = "requirements-manager-postgres:arm64" },
  @{ Source = "redis:7-alpine"; Target = "requirements-manager-redis:arm64" },
  # Registry availability can change; verified local images can be reused via
  # -ReuseLocalThirdPartyImages without resolving remote manifests.
  @{ Source = $MinioSource; Target = "requirements-manager-minio:arm64" }
)
foreach ($Definition in $ThirdPartyImageDefinitions) {
  if ($ReuseLocalThirdPartyImages) {
    $LocalArchitecture = & docker image inspect $Definition.Target --format "{{.Architecture}}"
    if ($LASTEXITCODE -ne 0 -or "$LocalArchitecture".Trim() -ne "arm64") {
      throw "无法复用本地镜像：$($Definition.Target) 不存在或不是ARM64架构。请先导入可信的ARM64镜像，或去掉-ReuseLocalThirdPartyImages重新构建。"
    }
    Write-Host "复用本地ARM64基础镜像：$($Definition.Target)"
    continue
  }
  Write-Host "构建ARM64基础镜像：$($Definition.Source) -> $($Definition.Target)"
  Invoke-Checked "docker" (@(
    "buildx", "build",
    "--platform", "linux/arm64",
    "--load"
  ) + $BuildProxyArguments + @(
    "--build-arg", "BASE_IMAGE=$($Definition.Source)",
    "-t", $Definition.Target,
    "-f", (Join-Path $ProjectRoot "docker/third-party.Dockerfile"),
    $ProjectRoot
  ))
}

Write-Host "验证ARM64 MinIO和健康检查客户端..."
Assert-MinioVersion
Invoke-Checked "docker" @("run", "--rm", "--platform", "linux/arm64", "--entrypoint", "mc", "requirements-manager-minio:arm64", "--version")

$ApplicationImages = @(
  "requirements-manager-api:arm64",
  "requirements-manager-worker:arm64",
  "requirements-manager-web:arm64",
  "requirements-manager-opencode:arm64"
)
$ThirdPartyImages = $ThirdPartyImageDefinitions | ForEach-Object { $_.Target }
$AllImages = $ApplicationImages + $ThirdPartyImages
foreach ($Image in $AllImages) {
  $Architecture = (& docker image inspect $Image --format "{{.Architecture}}" 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or $Architecture -ne "arm64") {
    throw "镜像不是ARM64架构或不存在：$Image（检测结果：$Architecture）"
  }
}

Write-Host "验证ARM64 OpenCode镜像中的Node Phase 2 runner..."
$OpenCodeImage = "requirements-manager-opencode:arm64"
Invoke-Checked "docker" @(
  "run", "--rm", "--platform", "linux/arm64", "--entrypoint", "node",
  $OpenCodeImage, "-e", "console.log(process.arch, 'node runtime ok')"
)
Invoke-Checked "docker" @(
  "run", "--rm", "--platform", "linux/arm64", "--entrypoint", "sh", $OpenCodeImage, "-lc",
  "test -s /plugin/dist/direct-phase2-runner.js && ! grep -aEq 'Bun\.(serve|file|Glob)|import\.meta\.dir' /plugin/dist/direct-phase2-runner.js"
)

$RunnerCheckContainer = "requirements-manager-opencode-arm64-check-$PID"
try {
  $ContainerId = (& docker run -d --platform linux/arm64 --name $RunnerCheckContainer `
    -e OPENCODE_SERVER_USERNAME=opencode `
    -e OPENCODE_SERVER_PASSWORD=runner-check `
    -e PROJECTS_ROOT=/data/projects `
    -e MATRIX_PHASE2_RUNNER_PORT=4097 `
    $OpenCodeImage opencode serve --hostname 0.0.0.0 --port 4096 --print-logs --log-level INFO).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $ContainerId) {
    throw "无法启动ARM64 OpenCode镜像验证容器"
  }
  $Healthy = $false
  for ($Attempt = 1; $Attempt -le 60; $Attempt++) {
    # 服务启动期间健康检查失败是预期状态。让容器内的shell吞掉探测输出，
    # 避免Windows PowerShell把Node的stderr升级为NativeCommandError并提前终止轮询。
    & docker exec $RunnerCheckContainer sh -c "node /usr/local/bin/opencode-healthcheck.mjs >/dev/null 2>&1"
    if ($LASTEXITCODE -eq 0) {
      $Healthy = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $Healthy) {
    & docker logs $RunnerCheckContainer
    throw "ARM64 OpenCode或Phase 2 runner健康检查失败"
  }
  Write-Host "ARM64 Node Phase 2 runner健康检查通过"
} finally {
  & docker rm -f $RunnerCheckContainer *> $null
}

if (Test-Path $OutputPath) {
  Remove-Item $OutputPath -Recurse -Force
}
New-Item $OutputPath -ItemType Directory | Out-Null
New-Item (Join-Path $OutputPath "bin") -ItemType Directory | Out-Null
New-Item (Join-Path $OutputPath "data/opencode-config") -ItemType Directory -Force | Out-Null

Copy-Item (Join-Path $ProjectRoot "docker-compose.offline-arm64.yml") (Join-Path $OutputPath "docker-compose.yml")
Copy-Item (Join-Path $ProjectRoot ".env.offline.example") (Join-Path $OutputPath ".env.example")
Copy-Item (Join-Path $ProjectRoot "offline/opencode.json.example") (Join-Path $OutputPath "data/opencode-config/opencode.json.example")
Copy-Item (Join-Path $ProjectRoot "offline/*.sh") $OutputPath
Copy-Item (Join-Path $ProjectRoot "offline/README-OFFLINE.md") $OutputPath

$ComposeUrl = "https://github.com/docker/compose/releases/download/$ComposeVersion/docker-compose-linux-aarch64"
$ComposePath = Join-Path $OutputPath "bin/docker-compose"
$ComposeCacheName = "docker-compose-$($ComposeVersion -replace '[^A-Za-z0-9._-]', '_')-linux-aarch64"
$ComposeCachePath = Join-Path $DownloadCachePath $ComposeCacheName
Write-Host "准备ARM64 Docker Compose：$ComposeVersion"
$CachedComposePath = Get-CachedArm64Download $ComposeUrl $ComposeCachePath $HostProxyUrl -Refresh:$RefreshDownloads
Copy-Item $CachedComposePath $ComposePath

Write-Host "导出ARM64镜像归档，文件可能较大..."
Invoke-Checked "docker" (@("image", "save", "-o", $ImagesArchive) + $AllImages)

$IntegrityFiles = @(
  "requirements-manager-arm64-images.tar",
  "bin/docker-compose",
  "docker-compose.yml",
  ".env.example",
  "data/opencode-config/opencode.json.example",
  "README-OFFLINE.md"
) + (Get-ChildItem $OutputPath -Filter "*.sh" -File | ForEach-Object { $_.Name })
$IntegrityLines = $IntegrityFiles |
  Sort-Object -Unique |
  ForEach-Object {
    $AbsolutePath = Join-Path $OutputPath $_
    $Hash = (Get-FileHash $AbsolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$Hash  $($_ -replace '\\', '/')"
  }
$Sha256SumsPath = Join-Path $OutputPath "SHA256SUMS"
# The bundle is consumed by GNU sha256sum on Linux. PowerShell's Set-Content
# uses the host platform newline, so packages built on Windows used to contain
# CRLF here and sha256sum treated the trailing CR as part of every filename.
# Write the manifest as ASCII with explicit Unix LF line endings instead.
$Sha256SumsContent = ($IntegrityLines -join "`n") + "`n"
[System.IO.File]::WriteAllText(
  $Sha256SumsPath,
  $Sha256SumsContent,
  [System.Text.Encoding]::ASCII
)

$Sha256SumsBytes = [System.IO.File]::ReadAllBytes($Sha256SumsPath)
if ($Sha256SumsBytes -contains 13) {
  throw "SHA256SUMS包含CR字符，无法生成Linux离线包"
}

$Manifest = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  platform = "linux/arm64"
  composeVersion = $ComposeVersion
  externalPort = 8089
  images = $AllImages
}
$Manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $OutputPath "manifest.json") -Encoding utf8

if (Test-Path $BundleArchive) {
  Remove-Item $BundleArchive -Force
}
Invoke-Checked "tar" @("-czf", $BundleArchive, "-C", (Split-Path $OutputPath -Parent), (Split-Path $OutputPath -Leaf))

Write-Host "离线部署目录已生成：$OutputPath" -ForegroundColor Green
Write-Host "可交付压缩包已生成：$BundleArchive" -ForegroundColor Green

