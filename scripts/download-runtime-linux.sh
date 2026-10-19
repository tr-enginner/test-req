#!/usr/bin/env bash
# Download Bun, OpenCode, and ripgrep into tools-archive/runtime/linux/ (x86_64).
# Used by Docker images (scripts/server/Dockerfile COPY tools-archive/runtime/linux/).
#
# Usage:
#   bash scripts/download-runtime-linux.sh [--dir PATH] [--rg-version VER]
#
# Requires: curl, unzip, tar, file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/tools-archive/runtime/linux"
RG_VERSION="${RG_VERSION:-15.1.0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) RUNTIME_DIR="$2"; shift 2 ;;
    --rg-version) RG_VERSION="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash scripts/download-runtime-linux.sh [--dir PATH] [--rg-version VER]"
      echo "  Env: RG_VERSION (default $RG_VERSION)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$RUNTIME_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "=== Runtime target: $RUNTIME_DIR ==="

# --- Bun (GitHub latest x64 zip) ---
echo "[1/3] Bun (linux-x64)..."
curl -fsSL -o "$TMP/bun.zip" "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip"
unzip -q -o "$TMP/bun.zip" -d "$TMP/bun-extract"
cp "$TMP/bun-extract/bun-linux-x64/bun" "$RUNTIME_DIR/bun"
chmod +x "$RUNTIME_DIR/bun"
echo "  → $(file "$RUNTIME_DIR/bun" | sed 's/.*: //')"

# --- ripgrep (musl static) ---
echo "[2/3] ripgrep ${RG_VERSION} (x86_64-unknown-linux-musl)..."
RG_TGZ="ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz"
curl -fsSL -o "$TMP/$RG_TGZ" \
  "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${RG_TGZ}"
tar xzf "$TMP/$RG_TGZ" -C "$TMP"
cp "$TMP/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl/rg" "$RUNTIME_DIR/rg"
chmod +x "$RUNTIME_DIR/rg"
echo "  → $(file "$RUNTIME_DIR/rg" | sed 's/.*: //')"

# --- OpenCode (linux-x64 tarball, single binary) ---
echo "[3/3] OpenCode (opencode-linux-x64.tar.gz, latest)..."
curl -fsSL -o "$TMP/opencode-linux-x64.tar.gz" \
  "https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-x64.tar.gz"
tar xzf "$TMP/opencode-linux-x64.tar.gz" -C "$TMP"
cp "$TMP/opencode" "$RUNTIME_DIR/opencode"
chmod +x "$RUNTIME_DIR/opencode"
echo "  → $(file "$RUNTIME_DIR/opencode" | sed 's/.*: //')"

echo ""
echo "Done. Versions:"
"$RUNTIME_DIR/bun" --version 2>/dev/null || true
"$RUNTIME_DIR/opencode" --version 2>/dev/null || true
"$RUNTIME_DIR/rg" --version 2>/dev/null | head -1 || true
