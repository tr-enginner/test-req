#!/usr/bin/env bash
# build-x86_64-release.sh — One-click build for x86_64 offline deployment packages
#
# Produces TWO independent packages:
#   release/matrix-tools-v<VERSION>-linux-x86_64.tar.gz    (tools, deploy once)
#   release/matrix-docker-v<VERSION>-linux-x86_64.tar.gz   (Docker, can update)
#
# Usage:
#   bash scripts/build-x86_64-release.sh \
#     --specchecker-path /path/to/SpecChecker \
#     --aunit-bin /path/to/SunwiseAUnit*.bin \
#     [--version VERSION] [--skip-download] [--skip-tools] [--skip-build]
#
# Prerequisites:
#   - x86_64 Linux host with Docker (>= 20.10), Bun, curl, unzip, tar
#   - tools-archive/runtime/linux/{bun,opencode,rg} (x86_64 runtime binaries)
#   - Network access to GitHub (for downloading Joern, Z3, JDK)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
VERSION="0.2.0"
ARCH="x86_64"
SPECCHECKER_PATH=""
AUNIT_BIN=""
SKIP_DOWNLOAD=false
SKIP_TOOLS=false
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)          VERSION="$2";          shift 2 ;;
    --specchecker-path) SPECCHECKER_PATH="$2"; shift 2 ;;
    --aunit-bin)        AUNIT_BIN="$2";        shift 2 ;;
    --skip-download)    SKIP_DOWNLOAD=true;    shift ;;
    --skip-tools)       SKIP_TOOLS=true;       shift ;;
    --skip-build)       SKIP_BUILD=true;       shift ;;
    -h|--help)
      cat << 'EOF'
Usage: bash scripts/build-x86_64-release.sh [OPTIONS]

Options:
  --version VERSION          Version tag (default: 0.2.0)
  --specchecker-path PATH    Path to extracted SpecChecker directory
  --aunit-bin PATH           Path to AUnit self-extracting .bin file
  --skip-download            Skip downloading open-source tools (Joern, Z3, JDK)
  --skip-tools               Skip tools package (only build Docker package)
  --skip-build               Skip Docker image build (use existing images)

Produces:
  release/matrix-tools-v<VERSION>-linux-x86_64.tar.gz   (tools offline package)
  release/matrix-docker-v<VERSION>-linux-x86_64.tar.gz   (Docker offline package)

Example (full build):
  bash scripts/build-x86_64-release.sh \
    --specchecker-path /home/sunwise/00-git/matrix-tools/SpecChecker \
    --aunit-bin /home/sunwise/00-git/matrix-tools/SunwiseAUnit_CentOS_Kylin_V4.2.0_20251205.bin

Example (Docker package only, tools already deployed):
  bash scripts/build-x86_64-release.sh --skip-tools --skip-build
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "==========================================="
echo " Matrix Agent x86_64 离线部署包构建"
echo "==========================================="
echo "版本:       $VERSION"
echo "架构:       $ARCH"
echo "跳过下载:   $SKIP_DOWNLOAD"
echo "跳过工具包: $SKIP_TOOLS"
echo "跳过构建:   $SKIP_BUILD"
echo ""

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
HOST_ARCH="$(uname -m)"
if [[ "$HOST_ARCH" != "x86_64" ]]; then
  echo "WARNING: 当前机器架构为 $HOST_ARCH，而非 x86_64。" >&2
  echo "         构建的 Docker 镜像可能不兼容目标架构。" >&2
  echo ""
fi

if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker 未安装" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Install project dependencies
# ---------------------------------------------------------------------------
echo "=== [1/6] 安装项目依赖 ==="
if ! command -v bun &>/dev/null; then
  echo "ERROR: Bun 未安装。请运行: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

cd "$ROOT_DIR"
bun install
echo "  → 依赖安装完成"
echo ""

# ---------------------------------------------------------------------------
# Step 2: Verify x86_64 runtime binaries
# ---------------------------------------------------------------------------
echo "=== [2/6] 检查 runtime 二进制 ==="
RUNTIME_DIR="$ROOT_DIR/tools-archive/runtime/linux"
RUNTIME_OK=true

for bin_name in bun opencode rg; do
  if [[ -f "$RUNTIME_DIR/$bin_name" ]]; then
    BIN_ARCH=$(file "$RUNTIME_DIR/$bin_name" | grep -o 'x86-64\|x86_64\|aarch64\|ARM aarch64' || echo "unknown")
    echo "  → $bin_name: $BIN_ARCH"
    if [[ "$BIN_ARCH" != *"x86"* && "$BIN_ARCH" != *"x86_64"* ]]; then
      echo "    WARNING: $bin_name 可能不是 x86_64 架构"
    fi
  else
    echo "  → $bin_name: 未找到"
    RUNTIME_OK=false
  fi
done

if [[ "$RUNTIME_OK" == "false" ]]; then
  echo ""
  echo "ERROR: runtime 二进制文件不完整。" >&2
  echo "请参考 docs/x86_64-docker-build-plan.md 第 3 步准备:" >&2
  echo "  mkdir -p $RUNTIME_DIR" >&2
  echo "  # 下载 x86_64 的 bun, opencode, rg 到 $RUNTIME_DIR/" >&2
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Step 3: Download open-source tools
# ---------------------------------------------------------------------------
if [[ "$SKIP_TOOLS" == "false" ]]; then
  if [[ "$SKIP_DOWNLOAD" == "false" ]]; then
    echo "=== [3/6] 下载开源工具 (Joern, Z3, JDK) ==="
    bash "$SCRIPT_DIR/download-tools.sh" --arch "$ARCH"
    echo ""
  else
    echo "=== [3/6] 跳过开源工具下载 (--skip-download) ==="
    echo ""
  fi

  # ---------------------------------------------------------------------------
  # Step 4: Prepare commercial tools
  # ---------------------------------------------------------------------------
  if [[ -n "$SPECCHECKER_PATH" && -n "$AUNIT_BIN" ]]; then
    echo "=== [4/6] 准备商业工具 (SpecChecker, AUnit) ==="
    bash "$SCRIPT_DIR/prepare-commercial-tools.sh" \
      --specchecker-path "$SPECCHECKER_PATH" \
      --aunit-bin "$AUNIT_BIN"
    echo ""
  elif [[ -d "$ROOT_DIR/tools-archive/tools/linux/specchecker" && \
          -d "$ROOT_DIR/tools-archive/tools/linux/aunit" ]]; then
    echo "=== [4/6] 商业工具已存在，跳过准备 ==="
    echo ""
  else
    echo "=== [4/6] 跳过商业工具准备 ==="
    if [[ -z "$SPECCHECKER_PATH" ]]; then
      echo "  → 未指定 --specchecker-path"
    fi
    if [[ -z "$AUNIT_BIN" ]]; then
      echo "  → 未指定 --aunit-bin"
    fi
    echo "  → 工具包中将不包含 SpecChecker 和/或 AUnit"
    echo ""
  fi

  # ---------------------------------------------------------------------------
  # Step 5: Package tools offline bundle
  # ---------------------------------------------------------------------------
  echo "=== [5/6] 打包工具离线包 ==="
  bash "$SCRIPT_DIR/pack-tools.sh" --version "$VERSION" --arch "$ARCH"
  echo ""
else
  echo "=== [3/6] 跳过开源工具下载 (--skip-tools) ==="
  echo "=== [4/6] 跳过商业工具准备 (--skip-tools) ==="
  echo "=== [5/6] 跳过工具离线包打包 (--skip-tools) ==="
  echo ""
fi

# ---------------------------------------------------------------------------
# Step 6: Build Docker images + package Docker offline bundle
# ---------------------------------------------------------------------------
echo "=== [6/6] 构建 Docker 离线包 ==="

DOCKER_ARGS=(--version "$VERSION" --arch "$ARCH")
if [[ "$SKIP_BUILD" == "true" ]]; then
  DOCKER_ARGS+=(--skip-build)
fi

bash "$SCRIPT_DIR/pack-docker.sh" "${DOCKER_ARGS[@]}"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo " 构建完成!"
echo "==========================================="
echo ""

RELEASE_DIR="$ROOT_DIR/release"
TOOLS_PKG="$RELEASE_DIR/matrix-tools-v${VERSION}-linux-${ARCH}.tar.gz"
DOCKER_PKG="$RELEASE_DIR/matrix-docker-v${VERSION}-linux-${ARCH}.tar.gz"

if [[ "$SKIP_TOOLS" == "false" && -f "$TOOLS_PKG" ]]; then
  TOOLS_SIZE=$(du -sh "$TOOLS_PKG" | cut -f1)
  echo "工具包: $TOOLS_PKG ($TOOLS_SIZE)"
else
  echo "工具包: (跳过)"
fi

if [[ -f "$DOCKER_PKG" ]]; then
  DOCKER_SIZE=$(du -sh "$DOCKER_PKG" | cut -f1)
  echo "Docker包: $DOCKER_PKG ($DOCKER_SIZE)"
fi

echo ""
echo "部署步骤 (离线机器):"
echo ""
if [[ "$SKIP_TOOLS" == "false" ]]; then
  echo "  1. 部署工具 (仅首次):"
  echo "     tar xzf matrix-tools-v${VERSION}-linux-${ARCH}.tar.gz"
  echo "     cd matrix-tools-v${VERSION}-linux-${ARCH}/"
  echo "     sudo bash deploy-tools.sh --target /data/matrix-tools"
  echo ""
  echo "  2. 部署 Docker 服务:"
else
  echo "  1. 部署 Docker 服务:"
fi
echo "     tar xzf matrix-docker-v${VERSION}-linux-${ARCH}.tar.gz"
echo "     cd matrix-docker-v${VERSION}-linux-${ARCH}/"
echo "     sudo bash install.sh"
echo "     sudo vi /opt/matrix-docker/.env    # 配置 LLM"
echo "     cd /opt/matrix-docker && sudo docker compose up -d"
