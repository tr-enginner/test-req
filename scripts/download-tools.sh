#!/usr/bin/env bash
# download-tools.sh — Download open-source tools (Joern, Z3, JDK)
# Usage: bash scripts/download-tools.sh [--arch ARCH] [--output-dir DIR]
#
# Downloads to: tools-archive/tools/linux/{joern-cli,z3,jdk}/
#
# NOTE: SpecChecker, AUnit, and code_slicer are commercial tools that must be
# obtained separately. Place them in
# tools-archive/tools/linux/{specchecker,aunit,code_slicer}/ before running
# pack-tools.sh, or use prepare-commercial-tools.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Versions
JOERN_VERSION="latest"
Z3_VERSION="4.13.4"
JDK_VERSION="21"

# Defaults
ARCH="$(uname -m)"
OUTPUT_DIR="${ROOT_DIR}/tools-archive/tools/linux"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash scripts/download-tools.sh [--arch ARCH] [--output-dir DIR]"
      echo "  --arch ARCH       Target architecture: x86_64 or aarch64 (default: host arch)"
      echo "  --output-dir DIR  Output directory (default: tools-archive/tools/linux)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]]; then
  echo "ERROR: Unsupported architecture: $ARCH (expected x86_64 or aarch64)" >&2
  exit 1
fi

# Architecture-specific asset mappings
if [[ "$ARCH" == "x86_64" ]]; then
  Z3_ARCH_ASSET="z3-${Z3_VERSION}-x64-glibc-2.35.zip"
  JDK_ARCH="x64"
else
  Z3_ARCH_ASSET="z3-${Z3_VERSION}-arm64-glibc-2.34.zip"
  JDK_ARCH="aarch64"
fi

mkdir -p "$OUTPUT_DIR"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "=== Matrix Tools Downloader ($ARCH) ==="
echo "Output: $OUTPUT_DIR"
echo ""

# ---------------------------------------------------------------------------
# 1. Joern CLI
# ---------------------------------------------------------------------------
echo "[1/3] Downloading Joern CLI..."
JOERN_URL="https://github.com/joernio/joern/releases/latest/download/joern-cli.zip"
JOERN_ZIP="$TEMP_DIR/joern-cli.zip"

if [[ -d "$OUTPUT_DIR/joern-cli/bin" ]]; then
  echo "  → joern-cli/ already exists, skipping (delete to re-download)"
else
  curl -fSL --progress-bar -o "$JOERN_ZIP" "$JOERN_URL"
  echo "  → Extracting..."
  unzip -qo "$JOERN_ZIP" -d "$TEMP_DIR/joern-extract"
  # The zip contains a joern-cli/ top-level directory
  if [[ -d "$TEMP_DIR/joern-extract/joern-cli" ]]; then
    rm -rf "$OUTPUT_DIR/joern-cli"
    mv "$TEMP_DIR/joern-extract/joern-cli" "$OUTPUT_DIR/joern-cli"
  else
    # Some releases extract to a versioned directory
    JOERN_EXTRACTED=$(find "$TEMP_DIR/joern-extract" -maxdepth 1 -type d -name "joern-cli*" | head -1)
    if [[ -n "$JOERN_EXTRACTED" ]]; then
      rm -rf "$OUTPUT_DIR/joern-cli"
      mv "$JOERN_EXTRACTED" "$OUTPUT_DIR/joern-cli"
    else
      echo "ERROR: Could not find joern-cli directory in archive" >&2
      exit 1
    fi
  fi
  chmod +x "$OUTPUT_DIR/joern-cli/bin/"*
  echo "  → Done: $(ls "$OUTPUT_DIR/joern-cli/bin/" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# 2. Z3
# ---------------------------------------------------------------------------
echo "[2/3] Downloading Z3 v${Z3_VERSION} ($ARCH)..."
Z3_ASSET="$Z3_ARCH_ASSET"
Z3_URL="https://github.com/Z3Prover/z3/releases/download/z3-${Z3_VERSION}/${Z3_ASSET}"
Z3_ZIP="$TEMP_DIR/z3.zip"

if [[ -f "$OUTPUT_DIR/z3/bin/z3" ]]; then
  echo "  → z3/ already exists, skipping (delete to re-download)"
else
  curl -fSL --progress-bar -o "$Z3_ZIP" "$Z3_URL"
  echo "  → Extracting..."
  unzip -qo "$Z3_ZIP" -d "$TEMP_DIR/z3-extract"
  # Find the z3 binary — try nested directory first, then flat layout
  Z3_BIN=""
  for candidate in "$TEMP_DIR"/z3-extract/z3-*/bin/z3 "$TEMP_DIR"/z3-extract/bin/z3; do
    if [[ -f "$candidate" ]]; then
      Z3_BIN="$candidate"
      break
    fi
  done
  if [[ -z "$Z3_BIN" ]]; then
    echo "ERROR: Could not find z3 binary in archive. Contents:" >&2
    ls -R "$TEMP_DIR/z3-extract/" | head -30 >&2
    exit 1
  fi
  Z3_EXTRACTED="$(dirname "$(dirname "$Z3_BIN")")"
  rm -rf "$OUTPUT_DIR/z3"
  mkdir -p "$OUTPUT_DIR/z3/bin"
  cp "$Z3_BIN" "$OUTPUT_DIR/z3/bin/z3"
  chmod +x "$OUTPUT_DIR/z3/bin/z3"
  # Copy lib/ if present (libz3.so may be needed)
  if [[ -d "$Z3_EXTRACTED/lib" ]]; then
    cp -r "$Z3_EXTRACTED/lib" "$OUTPUT_DIR/z3/lib"
  fi
  echo "  → Done: z3/bin/z3"
fi

# ---------------------------------------------------------------------------
# 3. Eclipse Temurin JRE 21
# ---------------------------------------------------------------------------
echo "[3/3] Downloading Eclipse Temurin JRE ${JDK_VERSION} ($ARCH)..."
JDK_URL="https://api.adoptium.net/v3/binary/latest/${JDK_VERSION}/ga/linux/${JDK_ARCH}/jre/hotspot/normal/eclipse"
JDK_TAR="$TEMP_DIR/jdk.tar.gz"

if [[ -d "$OUTPUT_DIR/jdk/bin" ]]; then
  echo "  → jdk/ already exists, skipping (delete to re-download)"
else
  curl -fSL --progress-bar -o "$JDK_TAR" -L "$JDK_URL"
  echo "  → Extracting..."
  mkdir -p "$TEMP_DIR/jdk-extract"
  tar xzf "$JDK_TAR" -C "$TEMP_DIR/jdk-extract"
  # Find the extracted JRE directory (e.g., jdk-21.0.x+y-jre/)
  JDK_EXTRACTED=$(find "$TEMP_DIR/jdk-extract" -maxdepth 1 -type d -name "jdk-*" | head -1)
  if [[ -z "$JDK_EXTRACTED" ]]; then
    echo "ERROR: Could not find JDK directory in archive" >&2
    ls -la "$TEMP_DIR/jdk-extract/"
    exit 1
  fi
  rm -rf "$OUTPUT_DIR/jdk"
  mv "$JDK_EXTRACTED" "$OUTPUT_DIR/jdk"
  # Flatten nested directory if mv placed it inside an existing dir
  if [[ ! -f "$OUTPUT_DIR/jdk/bin/java" ]] && [[ -d "$OUTPUT_DIR/jdk" ]]; then
    NESTED=$(find "$OUTPUT_DIR/jdk" -maxdepth 1 -type d -name "jdk-*" | head -1)
    if [[ -n "$NESTED" ]]; then
      mv "$OUTPUT_DIR/jdk" "$OUTPUT_DIR/jdk-nested-tmp"
      mv "$NESTED" "$OUTPUT_DIR/jdk"
      rm -rf "$OUTPUT_DIR/jdk-nested-tmp"
    fi
  fi
  echo "  → Done: $(${OUTPUT_DIR}/jdk/bin/java -version 2>&1 | head -1)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Download Complete ==="
echo "Directory structure:"
echo "  $OUTPUT_DIR/"
for tool in specchecker aunit code_slicer joern-cli z3 jdk; do
  if [[ -d "$OUTPUT_DIR/$tool" ]]; then
    SIZE=$(du -sh "$OUTPUT_DIR/$tool" 2>/dev/null | cut -f1)
    echo "  ├── $tool/  ($SIZE)"
  else
    echo "  ├── $tool/  (not present)"
  fi
done
echo ""
echo "Note: specchecker, aunit, and code_slicer are commercial tools."
echo "  Use 'bash scripts/prepare-commercial-tools.sh' to prepare them, or manually:"
echo "  cp -a /path/to/SpecChecker $OUTPUT_DIR/specchecker"
echo "  /path/to/SunwiseAUnit*.bin (self-extract to $OUTPUT_DIR/aunit)"
echo "  cp -a /path/to/code_slicer $OUTPUT_DIR/code_slicer"
echo ""
echo "Next step: run 'bash scripts/pack-tools.sh --arch $ARCH' to create the offline package"
