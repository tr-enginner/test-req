#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Matrix Embedded Agent — Linux Offline Installer
# =============================================================================
# Runs from inside the extracted tar.gz archive. Copies runtime, plugin, and
# optional tools to the target directory, generates OpenCode configuration,
# and registers system-wide paths.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
INSTALL_DIR="/opt/matrix"
NON_INTERACTIVE=false
INSTALL_JOERN=false
INSTALL_Z3=false
LLM_BASE_URL=""
LLM_MODEL=""
LLM_API_KEY=""
LLM_CONTEXT_SIZE="131072"
LLM_OUTPUT_SIZE="16384"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Matrix Embedded Agent — Linux Offline Installer

Options:
  --install-dir DIR     Installation directory (default: /opt/matrix)
  --non-interactive     Skip prompts; read config from environment variables:
                          LLM_BASE_URL   (required)
                          LLM_MODEL      (required)
                          LLM_API_KEY    (optional)
                          LLM_CONTEXT_SIZE (default: 131072)
                          LLM_OUTPUT_SIZE  (default: 16384)
                          INSTALL_JOERN  (true/false, default: false)
                          INSTALL_Z3     (true/false, default: false)
  -h, --help            Show this help message and exit
EOF
}

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
    --install-dir)
      [[ -n "${2:-}" ]] || error "--install-dir requires an argument"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --non-interactive)
      NON_INTERACTIVE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1 (see --help)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  warn "Not running as root. You may need sudo for /opt and /etc writes."
fi

# Check available disk space (need at least 1 GB)
AVAIL_KB=$(df -Pk "$(dirname "$INSTALL_DIR")" 2>/dev/null | awk 'NR==2 {print $4}')
if [[ -n "$AVAIL_KB" ]] && (( AVAIL_KB < 1048576 )); then
  warn "Less than 1 GB disk space available at $(dirname "$INSTALL_DIR") (${AVAIL_KB} KB free)."
fi

# ---------------------------------------------------------------------------
# Gather configuration
# ---------------------------------------------------------------------------
if [[ "$NON_INTERACTIVE" == true ]]; then
  # Non-interactive: read from environment variables
  LLM_BASE_URL="${LLM_BASE_URL:?Environment variable LLM_BASE_URL is required in non-interactive mode}"
  LLM_MODEL="${LLM_MODEL:?Environment variable LLM_MODEL is required in non-interactive mode}"
  LLM_API_KEY="${LLM_API_KEY:-}"
  LLM_CONTEXT_SIZE="${LLM_CONTEXT_SIZE:-131072}"
  LLM_OUTPUT_SIZE="${LLM_OUTPUT_SIZE:-16384}"
  INSTALL_JOERN="${INSTALL_JOERN:-false}"
  INSTALL_Z3="${INSTALL_Z3:-false}"
else
  # Interactive prompts
  echo ""
  echo "============================================="
  echo "  Matrix Embedded Agent — Installation Setup"
  echo "============================================="
  echo ""

  read -rp "Installation directory [$INSTALL_DIR]: " input
  INSTALL_DIR="${input:-$INSTALL_DIR}"

  echo ""
  read -rp "LLM API base URL (e.g., http://llm.internal:8000/v1): " LLM_BASE_URL
  [[ -n "$LLM_BASE_URL" ]] || error "LLM API base URL cannot be empty."

  read -rp "LLM model name (e.g., qwen2.5-72b-instruct): " LLM_MODEL
  [[ -n "$LLM_MODEL" ]] || error "LLM model name cannot be empty."

  read -rp "LLM API key (optional, press Enter to skip): " LLM_API_KEY

  echo ""
  read -rp "Context window size in tokens [$LLM_CONTEXT_SIZE]: " input
  LLM_CONTEXT_SIZE="${input:-$LLM_CONTEXT_SIZE}"

  read -rp "Max output size in tokens [$LLM_OUTPUT_SIZE]: " input
  LLM_OUTPUT_SIZE="${input:-$LLM_OUTPUT_SIZE}"

  echo ""
  read -rp "Install Joern (code property graph analysis)? [y/N]: " yn
  [[ "${yn,,}" == "y" ]] && INSTALL_JOERN=true

  read -rp "Install Z3 (SMT constraint solver)? [y/N]: " yn
  [[ "${yn,,}" == "y" ]] && INSTALL_Z3=true
fi

# Normalise boolean values from env (accept "true"/"1"/"yes")
normalize_bool() {
  local val="${1,,}"
  [[ "$val" == "true" || "$val" == "1" || "$val" == "yes" ]] && echo true || echo false
}
INSTALL_JOERN=$(normalize_bool "$INSTALL_JOERN")
INSTALL_Z3=$(normalize_bool "$INSTALL_Z3")

# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------
echo ""
info "Installation directory : $INSTALL_DIR"
info "LLM base URL           : $LLM_BASE_URL"
info "LLM model              : $LLM_MODEL"
info "LLM API key            : ${LLM_API_KEY:+(set)}"
info "Context window         : $LLM_CONTEXT_SIZE tokens"
info "Max output             : $LLM_OUTPUT_SIZE tokens"
info "Install Joern          : $INSTALL_JOERN"
info "Install Z3             : $INSTALL_Z3"
echo ""

# =============================================================================
# Installation
# =============================================================================

mkdir -p "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# [1/5] Copy runtime (Bun + OpenCode)
# ---------------------------------------------------------------------------
info "[1/5] Copying runtime (Bun + OpenCode)..."
cp -r "$SCRIPT_DIR/runtime" "$INSTALL_DIR/runtime"
chmod +x "$INSTALL_DIR/runtime/"* 2>/dev/null || true

# ---------------------------------------------------------------------------
# [2/5] Copy Matrix plugin
# ---------------------------------------------------------------------------
info "[2/5] Copying Matrix plugin..."
cp -r "$SCRIPT_DIR/plugin" "$INSTALL_DIR/plugin"
if [[ -d "$INSTALL_DIR/plugin/bin" ]]; then
  chmod +x "$INSTALL_DIR/plugin/bin/"* 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# [3/5] Install optional components
# ---------------------------------------------------------------------------
info "[3/5] Installing optional components..."
mkdir -p "$INSTALL_DIR/tools"

# SpecChecker
if [[ -d "$SCRIPT_DIR/tools/specchecker" ]]; then
  cp -r "$SCRIPT_DIR/tools/specchecker" "$INSTALL_DIR/tools/specchecker"
  info "  SpecChecker installed."
else
  info "  SpecChecker not found in archive. Skipping."
fi

# AUnit
if [[ -d "$SCRIPT_DIR/tools/aunit" ]]; then
  cp -r "$SCRIPT_DIR/tools/aunit" "$INSTALL_DIR/tools/aunit"
  chmod +x "$INSTALL_DIR/tools/aunit/"* 2>/dev/null || true
  info "  AUnit installed."
else
  info "  AUnit not found in archive. Skipping."
fi

# code_slicer
if [[ -d "$SCRIPT_DIR/tools/code_slicer" ]]; then
  cp -r "$SCRIPT_DIR/tools/code_slicer" "$INSTALL_DIR/tools/code_slicer"
  chmod +x "$INSTALL_DIR/tools/code_slicer/"* 2>/dev/null || true
  chmod +x "$INSTALL_DIR/tools/code_slicer/work/"* 2>/dev/null || true
  info "  code_slicer installed."
else
  info "  code_slicer not found in archive. Skipping."
fi

# Joern
if [[ "$INSTALL_JOERN" == true ]]; then
  if [[ -d "$SCRIPT_DIR/tools/joern-cli" ]]; then
    cp -r "$SCRIPT_DIR/tools/joern-cli" "$INSTALL_DIR/tools/joern-cli"
    chmod +x "$INSTALL_DIR/tools/joern-cli/bin/"* 2>/dev/null || true
    info "  Joern installed."
  else
    warn "  Joern package not found in archive (tools/joern-cli). Skipping."
  fi
else
  info "  Joern skipped."
fi

# Z3
if [[ "$INSTALL_Z3" == true ]]; then
  if [[ -d "$SCRIPT_DIR/tools/z3" ]]; then
    cp -r "$SCRIPT_DIR/tools/z3" "$INSTALL_DIR/tools/z3"
    chmod +x "$INSTALL_DIR/tools/z3/bin/"* 2>/dev/null || true
    info "  Z3 installed."
  else
    warn "  Z3 package not found in archive (tools/z3). Skipping."
  fi
else
  info "  Z3 skipped."
fi

# ---------------------------------------------------------------------------
# [4/5] Register plugin and generate configuration
# ---------------------------------------------------------------------------
info "[4/5] Registering plugin and generating configuration..."

# Determine the real home directory (works even under sudo)
REAL_HOME="${HOME}"
if [[ -n "${SUDO_USER:-}" ]]; then
  REAL_HOME=$(eval echo "~${SUDO_USER}")
fi

OPENCODE_CONFIG_DIR="${REAL_HOME}/.config/opencode"
OPENCODE_LEGACY_PLUGIN_DIR="${OPENCODE_CONFIG_DIR}/plugin"
OPENCODE_PLUGINS_DIR="${OPENCODE_CONFIG_DIR}/plugins"

# Register plugin with OpenCode local plugin directories.
# OpenCode Desktop and current OpenCode builds auto-load local JS plugins from
# ~/.config/opencode/plugins/. Mirror to the singular plugin/ directory for
# older TUI builds that still scan that legacy path.
# resolveSkillsDir() = join(plugin/matrix.js dir, "..", "skills") => ~/.config/opencode/skills
mkdir -p "${OPENCODE_PLUGINS_DIR}" "${OPENCODE_LEGACY_PLUGIN_DIR}" "${OPENCODE_CONFIG_DIR}/skills"
cp "$INSTALL_DIR/plugin/dist/index.js" "${OPENCODE_PLUGINS_DIR}/matrix.js"
cp "$INSTALL_DIR/plugin/dist/index.js" "${OPENCODE_LEGACY_PLUGIN_DIR}/matrix.js"
printf '{\n  "type": "module"\n}\n' > "${OPENCODE_PLUGINS_DIR}/package.json"
printf '{\n  "type": "module"\n}\n' > "${OPENCODE_LEGACY_PLUGIN_DIR}/package.json"
info "  Copied plugin to ${OPENCODE_PLUGINS_DIR}/matrix.js"
info "  Mirrored legacy plugin entry to ${OPENCODE_LEGACY_PLUGIN_DIR}/matrix.js"

for asset_dir in skills templates standards bin joern; do
  if [[ -d "$INSTALL_DIR/plugin/${asset_dir}" ]]; then
    mkdir -p "${OPENCODE_CONFIG_DIR}/${asset_dir}"
    cp -r "$INSTALL_DIR/plugin/${asset_dir}/"* "${OPENCODE_CONFIG_DIR}/${asset_dir}/" 2>/dev/null || true
    info "  Copied ${asset_dir} to ${OPENCODE_CONFIG_DIR}/${asset_dir}/"
  fi
done

# Generate opencode.json. Local JS plugins are loaded from plugins/ above; do
# not put ./plugins/matrix.js into the "plugin" field because current OpenCode
# interprets that field as npm plugin packages, which can make Desktop skip the
# local Matrix plugin.
cat > "${OPENCODE_CONFIG_DIR}/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "default_agent": "conductor",
  "model": "private-llm/${LLM_MODEL}",
  "provider": {
    "private-llm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "私有大模型",
      "options": {
        "baseURL": "${LLM_BASE_URL}",
        "apiKey": "${LLM_API_KEY}"
      },
      "models": {
        "${LLM_MODEL}": {
          "name": "${LLM_MODEL}",
          "tool_call": true,
          "limit": {
            "context": ${LLM_CONTEXT_SIZE},
            "output": ${LLM_OUTPUT_SIZE}
          }
        }
      }
    }
  }
}
EOF

# Fix ownership if running under sudo
if [[ -n "${SUDO_USER:-}" ]]; then
  chown -R "${SUDO_USER}:$(id -gn "${SUDO_USER}")" "${OPENCODE_CONFIG_DIR}"
fi

info "  Config written to ${OPENCODE_CONFIG_DIR}/opencode.json"

# ---------------------------------------------------------------------------
# [5/5] Register system paths
# ---------------------------------------------------------------------------
info "[5/5] Registering system paths..."

# Write /etc/profile.d drop-in with runtime + tool paths
if [[ -d /etc/profile.d ]]; then
  {
    echo "# Matrix Embedded Agent — added by install.sh"
    echo "export PATH=\"${INSTALL_DIR}/runtime:\$PATH\""

    if [[ -x "$INSTALL_DIR/runtime/python/bin/python3" ]]; then
      echo "export MATRIX_PYTHON=\"${INSTALL_DIR}/runtime/python/bin/python3\""
    elif [[ -x "$INSTALL_DIR/runtime/python/bin/python" ]]; then
      echo "export MATRIX_PYTHON=\"${INSTALL_DIR}/runtime/python/bin/python\""
    elif [[ -x "$INSTALL_DIR/runtime/python/python" ]]; then
      echo "export MATRIX_PYTHON=\"${INSTALL_DIR}/runtime/python/python\""
    fi


    if [[ -d "$INSTALL_DIR/tools/specchecker" ]]; then
      echo "export SPECCHECKER_HOME=\"${INSTALL_DIR}/tools/specchecker\""
      echo "export PATH=\"${INSTALL_DIR}/tools/specchecker:\$PATH\""
    fi
    if [[ -d "$INSTALL_DIR/tools/aunit" ]]; then
      echo "export AUNIT_HOME=\"${INSTALL_DIR}/tools/aunit\""
      echo "export PATH=\"${INSTALL_DIR}/tools/aunit:\$PATH\""
    fi
    if [[ -d "$INSTALL_DIR/tools/joern-cli" ]]; then
      echo "export JOERN_HOME=\"${INSTALL_DIR}/tools/joern-cli\""
      echo "export PATH=\"${INSTALL_DIR}/tools/joern-cli/bin:\$PATH\""
    fi
    if [[ -d "$INSTALL_DIR/tools/z3" ]]; then
      echo "export Z3_HOME=\"${INSTALL_DIR}/tools/z3\""
      echo "export PATH=\"${INSTALL_DIR}/tools/z3/bin:\$PATH\""
    fi
  } > /etc/profile.d/matrix-agent.sh
  chmod 644 /etc/profile.d/matrix-agent.sh
  info "  Created /etc/profile.d/matrix-agent.sh"
else
  warn "  /etc/profile.d not found. Please add ${INSTALL_DIR}/runtime to PATH manually."
fi

# Create convenience symlinks
for bin in opencode bun; do
  if [[ -f "$INSTALL_DIR/runtime/$bin" ]]; then
    ln -sf "$INSTALL_DIR/runtime/$bin" "/usr/local/bin/$bin"
    info "  Symlinked /usr/local/bin/$bin"
  fi
done

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "============================================="
echo "  Installation Complete"
echo "============================================="
echo ""
echo "  Install directory : $INSTALL_DIR"
echo "  LLM endpoint      : $LLM_BASE_URL"
echo "  LLM model         : $LLM_MODEL"
echo "  Config file        : ${OPENCODE_CONFIG_DIR}/opencode.json"
echo "  Plugin file        : ${OPENCODE_PLUGIN_DIR}/matrix.js"
echo ""
echo "  To start using Matrix Agent:"
echo ""
echo "    source /etc/profile.d/matrix-agent.sh"
echo "    cd /path/to/your/project"
echo "    opencode"
echo ""
echo "  Or open a new shell session (paths are loaded automatically)."
echo ""
