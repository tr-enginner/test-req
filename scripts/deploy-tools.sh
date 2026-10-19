#!/usr/bin/env bash
# deploy-tools.sh — Deploy Matrix tools to MATRIX_TOOLS_DIR
# Usage: sudo bash deploy-tools.sh [--target DIR]
#
# This script is included inside the offline package tarball.
# It deploys all tool directories found in the package to the target directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${MATRIX_TOOLS_DIR:-/data/matrix-tools}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: sudo bash deploy-tools.sh [--target DIR]"
      echo "  --target DIR   Deploy to DIR (default: /data/matrix-tools)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# All known tool directories (deploy whichever are present in the package)
ALL_TOOLS=(specchecker aunit code_slicer joern-cli z3 jdk)

echo "=== Matrix Tools 部署 ==="
echo "源目录: $SCRIPT_DIR"
echo "目标目录: $TARGET_DIR"
echo ""

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
mkdir -p "$TARGET_DIR"

DEPLOYED=()
for tool in "${ALL_TOOLS[@]}"; do
  if [[ -d "$SCRIPT_DIR/$tool" ]]; then
    echo "[部署] $tool → $TARGET_DIR/$tool"
    if [[ -d "$TARGET_DIR/$tool" ]]; then
      echo "  → 已存在，备份为 ${tool}.bak"
      rm -rf "$TARGET_DIR/${tool}.bak"
      mv "$TARGET_DIR/$tool" "$TARGET_DIR/${tool}.bak"
    fi
    cp -a "$SCRIPT_DIR/$tool" "$TARGET_DIR/$tool"
    DEPLOYED+=("$tool")
  fi
done

if [[ ${#DEPLOYED[@]} -eq 0 ]]; then
  echo "错误: 未找到任何工具目录" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Set permissions
# ---------------------------------------------------------------------------
echo ""
echo "[权限] 设置可执行权限..."
chmod +x "$TARGET_DIR/joern-cli/bin/"* 2>/dev/null || true
chmod +x "$TARGET_DIR/z3/bin/z3" 2>/dev/null || true
chmod +x "$TARGET_DIR/jdk/bin/"* 2>/dev/null || true

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
echo ""
echo "=== 验证工具 ==="

# SpecChecker
if [[ -d "$TARGET_DIR/specchecker" ]]; then
  echo -n "[验证] SpecChecker: "
  if [[ -f "$TARGET_DIR/specchecker/specchecker" ]] || [[ -d "$TARGET_DIR/specchecker/config" ]]; then
    echo "目录结构 OK"
  else
    echo "警告: 目录结构不完整"
  fi
fi

# AUnit
if [[ -d "$TARGET_DIR/aunit" ]]; then
  echo -n "[验证] AUnit: "
  if [[ -f "$TARGET_DIR/aunit/SunwiseAUnit" ]]; then
    echo "SunwiseAUnit OK"
  else
    echo "警告: SunwiseAUnit 二进制未找到"
  fi
fi

# code_slicer
if [[ -d "$TARGET_DIR/code_slicer" ]]; then
  echo -n "[验证] code_slicer: "
  if [[ -f "$TARGET_DIR/code_slicer/work/run_cli.py" ]]; then
    echo "work/run_cli.py OK"
  else
    echo "警告: work/run_cli.py 未找到"
  fi
fi

# Java
if [[ -d "$TARGET_DIR/jdk" ]]; then
  echo -n "[验证] Java: "
  if "$TARGET_DIR/jdk/bin/java" -version 2>&1 | head -1; then
    :
  else
    echo "警告: Java 验证失败"
  fi
fi

# Z3
if [[ -d "$TARGET_DIR/z3" ]]; then
  echo -n "[验证] Z3: "
  if "$TARGET_DIR/z3/bin/z3" --version 2>&1 | head -1; then
    :
  else
    echo "警告: Z3 验证失败"
  fi
fi

# Joern (requires Java)
if [[ -d "$TARGET_DIR/joern-cli" ]]; then
  echo -n "[验证] Joern: "
  export JAVA_HOME="$TARGET_DIR/jdk"
  export PATH="$TARGET_DIR/jdk/bin:$PATH"
  if "$TARGET_DIR/joern-cli/bin/joern-parse" --help >/dev/null 2>&1; then
    echo "joern-parse OK"
  else
    echo "警告: joern-parse 验证失败（可能需要更多依赖）"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== 部署完成 ==="
echo "工具目录: $TARGET_DIR"
for tool in "${DEPLOYED[@]}"; do
  SIZE=$(du -sh "$TARGET_DIR/$tool" 2>/dev/null | cut -f1)
  echo "  ├── $tool/  ($SIZE)"
done
echo ""
echo "下一步："
echo "  1. 重启 matrix-manager 容器: docker restart matrix-manager"
echo "  2. manager 将自动检测工具并注入环境变量到 OpenCode 实例"
