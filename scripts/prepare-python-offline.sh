#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Matrix Embedded Agent — Prepare Python Offline Payload (Linux)
# =============================================================================
# Build-machine script to prepare the offline Python runtime for packaging.
#
# Two modes:
#   ONLINE  (default): pip install directly from PyPI — build machine needs internet
#   OFFLINE (--offline): pip install from pre-downloaded wheels — build machine air-gapped
#
# Workflow for air-gapped build machine:
#   Step 1 (internet machine): bash scripts/prepare-python-offline.sh --download-only
#          -> downloads all wheels to tools-archive/python/wheels/
#   Step 2 (copy tools-archive/ to air-gapped build machine)
#   Step 3 (air-gapped): bash scripts/prepare-python-offline.sh --offline
#          -> installs from local wheels only
#
# Usage:
#   bash scripts/prepare-python-offline.sh                   # Online mode (default)
#   bash scripts/prepare-python-offline.sh --offline         # Offline mode (local wheels)
#   bash scripts/prepare-python-offline.sh --download-only   # Download wheels only
#   bash scripts/prepare-python-offline.sh --force           # Force rebuild venv
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_BIN=""
FORCE_REBUILD=false
OFFLINE_MODE=false
DOWNLOAD_ONLY=false
PYTHON_VENV_DIR="$PROJECT_ROOT/tools-archive/python/linux"
WHEELS_DIR="$PROJECT_ROOT/tools-archive/python/wheels"
REQUIREMENTS_FILE="$PROJECT_ROOT/tools-archive-requirements.txt"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "\033[1;34m[INFO]\033[0m  %s\n" "$*"; }
warn()  { printf "\033[1;33m[WARN]\033[0m  %s\n" "$*"; }
error() { printf "\033[1;31m[ERROR]\033[0m %s\n" "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE_REBUILD=true
      shift
      ;;
    --offline)
      OFFLINE_MODE=true
      shift
      ;;
    --download-only)
      DOWNLOAD_ONLY=true
      shift
      ;;
    --python)
      PYTHON_BIN="${2:-}"
      [[ -n "$PYTHON_BIN" ]] || error "--python requires a path argument"
      shift 2
      ;;
    -h|--help)
      echo ""
      echo "Usage: $(basename "$0") [OPTIONS]"
      echo ""
      echo "Matrix — Prepare Python Offline Payload (Linux)"
      echo ""
      echo "Options:"
      echo "  --python PATH     Path to Python 3 executable (default: auto-detect)"
      echo "  --offline         Install from local wheels only (air-gapped mode)"
      echo "  --download-only   Download wheels only, skip venv creation/install"
      echo "  --force           Remove existing venv and rebuild"
      echo "  -h, --help        Show this help message"
      echo ""
      echo "Air-gapped workflow:"
      echo "  1. On internet machine:  bash $0 --download-only"
      echo "  2. Copy tools-archive/ to air-gapped machine"
      echo "  3. On air-gapped machine: bash $0 --offline"
      echo ""
      exit 0
      ;;
    *)
      error "Unknown option: $1 (use --help for usage)"
      ;;
  esac
done

echo ""
echo "============================================="
echo "  Matrix — Prepare Python Offline Payload (Linux)"
echo "============================================="
echo ""

# ---------------------------------------------------------------------------
# DownloadOnly mode — pre-download all wheel files for air-gapped use
# ---------------------------------------------------------------------------
if [[ "$DOWNLOAD_ONLY" == true ]]; then
  info "DownloadOnly mode: pre-caching all pip wheels..."

  # Detect Python for pip download
  if [[ -z "$PYTHON_BIN" ]]; then
    for candidate in python3.12 python3.11 python3.10 python3; do
      if command -v "$candidate" &>/dev/null; then
        PYTHON_BIN="$(command -v "$candidate")"
        break
      fi
    done
    if [[ -z "$PYTHON_BIN" ]]; then
      error "No Python 3 found. Install Python 3.10+ or use --python to specify the path."
    fi
  fi

  if [[ ! -f "$REQUIREMENTS_FILE" ]]; then
    error "Requirements file not found: $REQUIREMENTS_FILE"
  fi

  # Clean old wheels if --force
  if [[ "$FORCE_REBUILD" == true ]] && [[ -d "$WHEELS_DIR" ]]; then
    rm -rf "$WHEELS_DIR"
  fi

  mkdir -p "$WHEELS_DIR"

  info "Downloading wheels to: $WHEELS_DIR"
  info "Requirements: $REQUIREMENTS_FILE"

  "$PYTHON_BIN" -m pip download \
    --requirement "$REQUIREMENTS_FILE" \
    --dest "$WHEELS_DIR"

  echo ""
  info "Wheels downloaded to: $WHEELS_DIR"
  info "Copy the entire tools-archive/ directory to your air-gapped build machine."
  info "Then run: bash $0 --offline"
  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
if [[ ! -f "$REQUIREMENTS_FILE" ]]; then
  error "Requirements file not found: $REQUIREMENTS_FILE"
fi

if [[ "$OFFLINE_MODE" == true ]]; then
  if [[ ! -d "$WHEELS_DIR" ]]; then
    error "Wheel directory not found: $WHEELS_DIR. Run --download-only first on an internet-connected machine."
  fi
  wheel_count=$(find "$WHEELS_DIR" -maxdepth 1 -name "*.whl" 2>/dev/null | wc -l)
  if [[ "$wheel_count" -eq 0 ]]; then
    error "No .whl files found in $WHEELS_DIR. Run --download-only first on an internet-connected machine."
  fi
  info "Found $wheel_count wheel files in $WHEELS_DIR"
  info "Installing from local wheels (no internet required)..."
  echo ""
fi

info "Project root    : $PROJECT_ROOT"
info "Python venv dir : $PYTHON_VENV_DIR"
info "Requirements    : $REQUIREMENTS_FILE"

# ---------------------------------------------------------------------------
# Detect Python 3
# ---------------------------------------------------------------------------
if [[ -z "$PYTHON_BIN" ]]; then
  info "Auto-detecting Python 3..."
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" &>/dev/null; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  done
  if [[ -z "$PYTHON_BIN" ]]; then
    error "No Python 3 found. Install Python 3.10+ or use --python to specify the path."
  fi
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  error "Python executable not found or not executable: $PYTHON_BIN"
fi

PYTHON_VERSION=$("$PYTHON_BIN" --version 2>&1 || true)
info "Detected Python : $PYTHON_BIN ($PYTHON_VERSION)"

# ---------------------------------------------------------------------------
# Create virtual environment
# ---------------------------------------------------------------------------
TARGET_PYTHON="$PYTHON_VENV_DIR/bin/python3"

if [[ "$FORCE_REBUILD" == true ]] && [[ -d "$PYTHON_VENV_DIR" ]]; then
  warn "Removing existing venv at $PYTHON_VENV_DIR ..."
  rm -rf "$PYTHON_VENV_DIR"
fi

if [[ ! -x "$TARGET_PYTHON" ]]; then
  info "Creating virtual environment at $PYTHON_VENV_DIR ..."
  mkdir -p "$(dirname "$PYTHON_VENV_DIR")"
  "$PYTHON_BIN" -m venv "$PYTHON_VENV_DIR"
  info "Virtual environment created."
else
  info "Virtual environment already exists, skipping creation."
  info "  Use --force to rebuild."
fi

if [[ ! -x "$TARGET_PYTHON" ]]; then
  error "Python executable not found inside venv: $TARGET_PYTHON"
fi

# ---------------------------------------------------------------------------
# Install requirements
# ---------------------------------------------------------------------------
info "Upgrading pip..."
"$TARGET_PYTHON" -m pip install --upgrade pip --quiet

if [[ "$OFFLINE_MODE" == true ]]; then
  info "Installing packages from local wheels..."
  "$TARGET_PYTHON" -m pip install \
    --no-index \
    --find-links "$WHEELS_DIR" \
    --requirement "$REQUIREMENTS_FILE"
else
  info "Installing packages from $REQUIREMENTS_FILE ..."
  "$TARGET_PYTHON" -m pip install --requirement "$REQUIREMENTS_FILE"
fi

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
echo ""
info "Verifying installed packages..."
"$TARGET_PYTHON" -c "
import docxtpl, docx, fastapi, jinja2
print(f'  docxtpl      : {docxtpl.__version__}')
print(f'  python-docx  : {docx.__version__}')
print(f'  fastapi      : {fastapi.__version__}')
print(f'  jinja2       : {jinja2.__version__}')
print('  All packages imported successfully.')
" || error "Package import verification failed. Check pip install output above."

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================="
echo "  Python offline payload ready"
echo "============================================="
echo ""
echo "  Location: $PYTHON_VENV_DIR"
echo ""
echo "  Next steps:"
echo "    bun run build"
echo "    bun run pack:offline -- --platform linux --version <X.Y.Z>"
echo ""
