#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Matrix Embedded Agent — Linux Uninstaller
# =============================================================================

INSTALL_DIR="${1:-/opt/matrix}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "\033[1;34m[INFO]\033[0m  %s\n" "$*"; }
warn()  { printf "\033[1;33m[WARN]\033[0m  %s\n" "$*"; }
error() { printf "\033[1;31m[ERROR]\033[0m %s\n" "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
if [[ ! -d "$INSTALL_DIR" ]]; then
  error "Installation directory not found: $INSTALL_DIR"
fi

# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------
echo ""
echo "This will remove Matrix Embedded Agent from: $INSTALL_DIR"
echo ""
read -rp "Continue? [y/N]: " yn
if [[ "${yn,,}" != "y" ]]; then
  echo "Aborted."
  exit 0
fi

# ---------------------------------------------------------------------------
# Remove installation directory
# ---------------------------------------------------------------------------
info "Removing installation directory: $INSTALL_DIR"
rm -rf "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# Remove /etc/profile.d drop-in
# ---------------------------------------------------------------------------
if [[ -f /etc/profile.d/matrix-agent.sh ]]; then
  info "Removing /etc/profile.d/matrix-agent.sh"
  rm -f /etc/profile.d/matrix-agent.sh
fi

# ---------------------------------------------------------------------------
# Remove symlinks
# ---------------------------------------------------------------------------
for bin in opencode bun; do
  if [[ -L "/usr/local/bin/$bin" ]]; then
    info "Removing symlink /usr/local/bin/$bin"
    rm -f "/usr/local/bin/$bin"
  fi
done

# ---------------------------------------------------------------------------
# Remove OpenCode plugin and config we installed
# ---------------------------------------------------------------------------
REAL_HOME="${HOME}"
if [[ -n "${SUDO_USER:-}" ]]; then
  REAL_HOME=$(eval echo "~${SUDO_USER}")
fi

OPENCODE_CONFIG_DIR="${REAL_HOME}/.config/opencode"
if [[ -f "${OPENCODE_CONFIG_DIR}/plugin/matrix.js" ]]; then
  info "Removing OpenCode plugin: ${OPENCODE_CONFIG_DIR}/plugin/matrix.js"
  rm -f "${OPENCODE_CONFIG_DIR}/plugin/matrix.js"
  rm -f "${OPENCODE_CONFIG_DIR}/plugin/package.json"
fi
if [[ -f "${OPENCODE_CONFIG_DIR}/plugins/matrix.js" ]]; then
  info "Removing legacy OpenCode plugin: ${OPENCODE_CONFIG_DIR}/plugins/matrix.js"
  rm -f "${OPENCODE_CONFIG_DIR}/plugins/matrix.js"
  rm -f "${OPENCODE_CONFIG_DIR}/plugins/package.json"
fi
if [[ -d "${OPENCODE_CONFIG_DIR}/skills" ]]; then
  info "Removing OpenCode skills: ${OPENCODE_CONFIG_DIR}/skills/"
  rm -rf "${OPENCODE_CONFIG_DIR}/skills"
fi
if [[ -d "${OPENCODE_CONFIG_DIR}/templates" ]]; then
  info "Removing OpenCode templates: ${OPENCODE_CONFIG_DIR}/templates/"
  rm -rf "${OPENCODE_CONFIG_DIR}/templates"
fi
if [[ -d "${OPENCODE_CONFIG_DIR}/standards" ]]; then
  info "Removing OpenCode standards: ${OPENCODE_CONFIG_DIR}/standards/"
  rm -rf "${OPENCODE_CONFIG_DIR}/standards"
fi
if [[ -d "${OPENCODE_CONFIG_DIR}/joern" ]]; then
  info "Removing OpenCode Joern scripts: ${OPENCODE_CONFIG_DIR}/joern/"
  rm -rf "${OPENCODE_CONFIG_DIR}/joern"
fi
if [[ -d "${OPENCODE_CONFIG_DIR}/bin" ]]; then
  info "Removing Matrix binaries from OpenCode bin: ${OPENCODE_CONFIG_DIR}/bin/"
  rm -f \
    "${OPENCODE_CONFIG_DIR}/bin/pdf-extract.ts" \
    "${OPENCODE_CONFIG_DIR}/bin/sg" \
    "${OPENCODE_CONFIG_DIR}/bin/sg.exe" \
    "${OPENCODE_CONFIG_DIR}/bin/ast-grep" \
    "${OPENCODE_CONFIG_DIR}/bin/ast-grep.exe" \
    "${OPENCODE_CONFIG_DIR}/bin/mdbook" \
    "${OPENCODE_CONFIG_DIR}/bin/mdbook.exe"
  rmdir "${OPENCODE_CONFIG_DIR}/bin" 2>/dev/null || true
fi
# Legacy path from older install.sh (skills under plugins/)
if [[ -d "${OPENCODE_CONFIG_DIR}/plugins/skills" ]]; then
  info "Removing legacy OpenCode skills: ${OPENCODE_CONFIG_DIR}/plugins/skills/"
  rm -rf "${OPENCODE_CONFIG_DIR}/plugins/skills"
fi
if [[ -f "${OPENCODE_CONFIG_DIR}/opencode.json" ]]; then
  info "Removing OpenCode config: ${OPENCODE_CONFIG_DIR}/opencode.json"
  rm -f "${OPENCODE_CONFIG_DIR}/opencode.json"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
info "Matrix Embedded Agent has been uninstalled."
echo ""
