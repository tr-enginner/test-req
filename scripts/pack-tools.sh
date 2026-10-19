#!/usr/bin/env bash
# pack-tools.sh — Package tools into an offline installer tarball
# Usage: bash scripts/pack-tools.sh [--version VERSION] [--arch ARCH]
#
# Reads from:  tools-archive/tools/linux/{specchecker,aunit,code_slicer,joern-cli,z3,jdk}/
# Produces:    release/matrix-tools-v<VERSION>-linux-<ARCH>.tar.gz

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="0.1.0"
ARCH="$(uname -m)"
TOOLS_SRC="$ROOT_DIR/tools-archive/tools/linux"
RELEASE_DIR="$ROOT_DIR/release"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash scripts/pack-tools.sh [--version VERSION] [--arch ARCH]"
      echo "  --version VERSION   Set version tag (default: 0.1.0)"
      echo "  --arch ARCH         Target architecture: x86_64 or aarch64 (default: host arch)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]]; then
  echo "ERROR: Unsupported architecture: $ARCH (expected x86_64 or aarch64)" >&2
  exit 1
fi

PACKAGE_NAME="matrix-tools-v${VERSION}-linux-${ARCH}"
STAGING_DIR="$(mktemp -d)"
PACKAGE_DIR="$STAGING_DIR/$PACKAGE_NAME"
trap 'rm -rf "$STAGING_DIR"' EXIT

# All tools to include (order: commercial first, then open-source)
ALL_TOOLS=(specchecker aunit code_slicer joern-cli z3 jdk)

# Required tools — pack will fail if missing
REQUIRED_TOOLS=(joern-cli z3 jdk)

# Optional tools — included if present, skipped with warning otherwise
OPTIONAL_TOOLS=(specchecker aunit code_slicer)

echo "=== Matrix Tools Packager ($ARCH) ==="
echo "Version: $VERSION"
echo "Arch:    $ARCH"
echo "Source:  $TOOLS_SRC"
echo ""

# ---------------------------------------------------------------------------
# Validate required tools
# ---------------------------------------------------------------------------
MISSING=0
for tool in "${REQUIRED_TOOLS[@]}"; do
  if [[ ! -d "$TOOLS_SRC/$tool" ]]; then
    echo "ERROR: $TOOLS_SRC/$tool/ not found" >&2
    MISSING=1
  fi
done
if [[ $MISSING -ne 0 ]]; then
  echo ""
  echo "Run 'bash scripts/download-tools.sh' first to download open-source tools."
  exit 1
fi

# Validate key binaries exist
for bin_path in joern-cli/bin/joern-parse z3/bin/z3 jdk/bin/java; do
  if [[ ! -f "$TOOLS_SRC/$bin_path" ]]; then
    echo "ERROR: Missing binary: $TOOLS_SRC/$bin_path" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Stage package contents (symlinks to save disk space; tar -h dereferences)
# ---------------------------------------------------------------------------
echo "Staging package..."
mkdir -p "$PACKAGE_DIR"

# Symlink tool directories into staging
INCLUDED_TOOLS=()
for tool in "${ALL_TOOLS[@]}"; do
  if [[ -d "$TOOLS_SRC/$tool" ]]; then
    echo "  → Linking $tool/..."
    ln -s "$(cd "$TOOLS_SRC/$tool" && pwd)" "$PACKAGE_DIR/$tool"
    INCLUDED_TOOLS+=("$tool")
  else
    echo "  → $tool/ not found, skipping (optional)"
  fi
done

# Copy deploy script
cp "$ROOT_DIR/scripts/deploy-tools.sh" "$PACKAGE_DIR/deploy-tools.sh"
chmod +x "$PACKAGE_DIR/deploy-tools.sh"

# Generate README inside the package
cat > "$PACKAGE_DIR/README.md" << READMEEOF
# Matrix Tools 离线安装包

本安装包包含 Matrix Agent 所需的外部工具。

## 包含工具

| 工具 | 说明 |
|------|------|
| \`specchecker/\` | SpecChecker 静态分析工具（MISRA/GJB 编码规范检查） |
| \`aunit/\` | SunwiseAUnit 单元测试工具 |
| \`joern-cli/\` | Joern 代码属性图 (CPG) 分析框架 |
| \`z3/\` | Z3 SMT 求解器 |
| \`jdk/\` | Eclipse Temurin JRE 21 (${ARCH}) |

## 安装方法

\`\`\`bash
# 解压安装包
tar xzf ${PACKAGE_NAME}.tar.gz
cd ${PACKAGE_NAME}/

# 运行部署脚本（默认部署到 /data/matrix-tools）
sudo bash deploy-tools.sh

# 或指定自定义目录
sudo bash deploy-tools.sh --target /path/to/tools
\`\`\`

## 部署后验证

\`\`\`bash
# 检查工具目录
ls /data/matrix-tools/

# 验证 Java
/data/matrix-tools/jdk/bin/java -version

# 验证 Z3
/data/matrix-tools/z3/bin/z3 --version

# 验证 Joern（需要 Java）
JAVA_HOME=/data/matrix-tools/jdk PATH=/data/matrix-tools/jdk/bin:\\\$PATH \\
  /data/matrix-tools/joern-cli/bin/joern-parse --help
\`\`\`

## 与 Docker 部署的关系

工具部署到 \`MATRIX_TOOLS_DIR\`（默认 \`/data/matrix-tools\`）后，
\`matrix-manager\` 容器启动时会自动扫描该目录并注入以下环境变量到 OpenCode 实例：

- \`SPECCHECKER_HOME=/opt/matrix/tools/specchecker\`
- \`AUNIT_HOME=/opt/matrix/tools/aunit\`
- \`JOERN_HOME=/opt/matrix/tools/joern-cli\`
- \`Z3_HOME=/opt/matrix/tools/z3\`
- \`JAVA_HOME=/opt/matrix/tools/jdk\`
- \`PATH\` 包含所有工具的 \`bin/\` 目录

部署完成后需重启 \`matrix-manager\` 容器使配置生效。
READMEEOF

# ---------------------------------------------------------------------------
# Create tarball
# ---------------------------------------------------------------------------
echo ""
echo "Creating tarball..."
mkdir -p "$RELEASE_DIR"
OUTPUT_FILE="$RELEASE_DIR/${PACKAGE_NAME}.tar.gz"

tar czf "$OUTPUT_FILE" -h -C "$STAGING_DIR" "$PACKAGE_NAME"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
echo ""
echo "=== Package Created ==="
echo "File: $OUTPUT_FILE"
echo "Size: $SIZE"
echo ""
echo "Included tools: ${INCLUDED_TOOLS[*]}"
echo ""
echo "Contents:"
tar tzf "$OUTPUT_FILE" | head -20
echo "  ... ($(tar tzf "$OUTPUT_FILE" | wc -l) entries total)"
