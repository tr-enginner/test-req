#!/usr/bin/env bash
# prepare-commercial-tools.sh — Prepare commercial tools for offline packaging
#
# Usage:
#   bash scripts/prepare-commercial-tools.sh \
#     [--specchecker-path /path/to/SpecChecker] \
#     [--aunit-bin /path/to/SunwiseAUnit*.bin] \
#     [--code-slicer-path /path/to/code_slicer] \
#     [--output-dir DIR]
#
# This script copies SpecChecker / code_slicer and extracts AUnit into the
# tools-archive directory so that pack-tools.sh can include them in the
# offline package.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SPECCHECKER_PATH=""
AUNIT_BIN=""
CODE_SLICER_PATH=""
OUTPUT_DIR="$ROOT_DIR/tools-archive/tools/linux"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --specchecker-path) SPECCHECKER_PATH="$2"; shift 2 ;;
    --aunit-bin)        AUNIT_BIN="$2"; shift 2 ;;
    --code-slicer-path) CODE_SLICER_PATH="$2"; shift 2 ;;
    --output-dir)       OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash scripts/prepare-commercial-tools.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --specchecker-path PATH  Path to extracted SpecChecker directory"
      echo "  --aunit-bin PATH         Path to AUnit self-extracting .bin file"
      echo "  --code-slicer-path PATH  Path to extracted code_slicer directory"
      echo "  --output-dir DIR         Output directory (default: tools-archive/tools/linux)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$SPECCHECKER_PATH" && -z "$AUNIT_BIN" && -z "$CODE_SLICER_PATH" ]]; then
  echo "ERROR: at least one of --specchecker-path, --aunit-bin, or --code-slicer-path is required" >&2
  exit 1
fi

if [[ -n "$SPECCHECKER_PATH" && ! -d "$SPECCHECKER_PATH" ]]; then
  echo "ERROR: SpecChecker directory not found: $SPECCHECKER_PATH" >&2
  exit 1
fi
if [[ -n "$AUNIT_BIN" && ! -f "$AUNIT_BIN" ]]; then
  echo "ERROR: AUnit .bin file not found: $AUNIT_BIN" >&2
  exit 1
fi
if [[ -n "$CODE_SLICER_PATH" && ! -d "$CODE_SLICER_PATH" ]]; then
  echo "ERROR: code_slicer directory not found: $CODE_SLICER_PATH" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "=== 商业工具准备 ==="
[[ -n "$SPECCHECKER_PATH" ]] && echo "SpecChecker: $SPECCHECKER_PATH"
[[ -n "$AUNIT_BIN" ]] && echo "AUnit:       $AUNIT_BIN"
[[ -n "$CODE_SLICER_PATH" ]] && echo "code_slicer: $CODE_SLICER_PATH"
echo "输出目录:    $OUTPUT_DIR"
echo ""

if [[ -n "$SPECCHECKER_PATH" ]]; then
  echo "[1/3] 准备 SpecChecker..."
  SPEC_DEST="$OUTPUT_DIR/specchecker"

  if [[ -d "$SPEC_DEST" ]]; then
    echo "  → 已存在，备份为 specchecker.bak"
    rm -rf "$SPEC_DEST.bak"
    mv "$SPEC_DEST" "$SPEC_DEST.bak"
  fi

  echo "  → 复制 SpecChecker 目录..."
  cp -a "$SPECCHECKER_PATH" "$SPEC_DEST"

  if [[ -d "$SPEC_DEST/config" ]]; then
    SPEC_SIZE=$(du -sh "$SPEC_DEST" 2>/dev/null | cut -f1)
    echo "  → SpecChecker 准备完成 ($SPEC_SIZE)"
  else
    echo "  → 警告: SpecChecker 目录结构可能不完整 (缺少 config/)"
  fi
fi

if [[ -n "$AUNIT_BIN" ]]; then
  echo ""
  echo "[2/3] 准备 AUnit..."
  AUNIT_DEST="$OUTPUT_DIR/aunit"
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT

  if [[ -d "$AUNIT_DEST" ]]; then
    echo "  → 已存在，备份为 aunit.bak"
    rm -rf "$AUNIT_DEST.bak"
    mv "$AUNIT_DEST" "$AUNIT_DEST.bak"
  fi

  TAIL_OFFSET=$(head -20 "$AUNIT_BIN" | grep -aoP 'tail\s+-n\s+\+\K[0-9]+' | head -1)
  if [[ -z "$TAIL_OFFSET" ]]; then
    echo "ERROR: Could not parse 'tail -n +N' offset from .bin header" >&2
    echo "  First 15 lines of .bin:" >&2
    head -15 "$AUNIT_BIN" >&2
    exit 1
  fi

  echo "  → 提取 tar.gz 数据 (从第 ${TAIL_OFFSET} 行开始)..."
  tail -n +"$TAIL_OFFSET" "$AUNIT_BIN" > "$TEMP_DIR/aunit-payload.tar.gz"

  echo "  → 解压中..."
  tar xzf "$TEMP_DIR/aunit-payload.tar.gz" -C "$TEMP_DIR"
  rm -f "$TEMP_DIR/aunit-payload.tar.gz"

  AUNIT_EXTRACTED=$(find "$TEMP_DIR" -maxdepth 1 -type d -name "SunwiseAUnit*" | head -1)
  if [[ -z "$AUNIT_EXTRACTED" ]]; then
    AUNIT_EXTRACTED=$(find "$TEMP_DIR" -maxdepth 1 -type d ! -name "$(basename "$TEMP_DIR")" | head -1)
  fi

  if [[ -z "$AUNIT_EXTRACTED" || ! -d "$AUNIT_EXTRACTED" ]]; then
    echo "ERROR: Could not find extracted AUnit directory" >&2
    ls -la "$TEMP_DIR/"
    exit 1
  fi

  mv "$AUNIT_EXTRACTED" "$AUNIT_DEST"

  find "$AUNIT_DEST" -type f -name "*.sh" -exec chmod +x {} \;
  find "$AUNIT_DEST" -type f -name "SunwiseAUnit*" -exec chmod +x {} \;

  AUNIT_SIZE=$(du -sh "$AUNIT_DEST" 2>/dev/null | cut -f1)
  echo "  → AUnit 准备完成 ($AUNIT_SIZE)"
fi

if [[ -n "$CODE_SLICER_PATH" ]]; then
  echo ""
  echo "[3/3] 准备 code_slicer..."
  CODE_SLICER_DEST="$OUTPUT_DIR/code_slicer"

  if [[ -d "$CODE_SLICER_DEST" ]]; then
    echo "  → 已存在，备份为 code_slicer.bak"
    rm -rf "$CODE_SLICER_DEST.bak"
    mv "$CODE_SLICER_DEST" "$CODE_SLICER_DEST.bak"
  fi

  echo "  → 复制 code_slicer 目录..."
  cp -a "$CODE_SLICER_PATH" "$CODE_SLICER_DEST"

  if [[ -f "$CODE_SLICER_DEST/work/run_cli.py" ]]; then
    CODE_SLICER_SIZE=$(du -sh "$CODE_SLICER_DEST" 2>/dev/null | cut -f1)
    echo "  → code_slicer 准备完成 ($CODE_SLICER_SIZE)"
  else
    echo "  → 警告: code_slicer 目录结构可能不完整 (缺少 work/run_cli.py)"
  fi
fi

echo ""
echo "=== 准备完成 ==="
echo "  $OUTPUT_DIR/"
for tool in specchecker aunit code_slicer; do
  if [[ -d "$OUTPUT_DIR/$tool" ]]; then
    SIZE=$(du -sh "$OUTPUT_DIR/$tool" 2>/dev/null | cut -f1)
    echo "  ├─ $tool/  ($SIZE)"
  fi
done
echo ""
echo "下一步: 运行 'bash scripts/pack-tools.sh' 打包工具离线包"
