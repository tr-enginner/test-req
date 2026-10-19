#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Matrix Agent — Server Deployment Setup
# =============================================================================
# Run on the aarch64 Linux server after install.sh has placed files in /opt/matrix.
# Installs Nginx, Samba, creates the matrix user, sets up directories,
# registers the systemd service, and configures Samba sharing.
#
# Usage:
#   sudo bash setup-server.sh [--data-dir /data/matrix-projects] [--skip-samba]
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
INSTALL_DIR="/opt/matrix"
DATA_DIR="/data/matrix-projects"
SKIP_SAMBA=false
MATRIX_USER="matrix"
MATRIX_GROUP="matrix-users"

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
    --data-dir)
      DATA_DIR="$2"; shift 2 ;;
    --install-dir)
      INSTALL_DIR="$2"; shift 2 ;;
    --skip-samba)
      SKIP_SAMBA=true; shift ;;
    -h|--help)
      echo "Usage: sudo bash setup-server.sh [--data-dir DIR] [--install-dir DIR] [--skip-samba]"
      exit 0 ;;
    *)
      error "Unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root (use sudo)."
fi

if [[ ! -d "$INSTALL_DIR/runtime" ]]; then
  error "Matrix not installed at $INSTALL_DIR. Run install.sh first."
fi

# ---------------------------------------------------------------------------
# [1/6] Create matrix user and group
# ---------------------------------------------------------------------------
info "[1/6] Creating matrix user and group..."

if ! getent group "$MATRIX_GROUP" >/dev/null 2>&1; then
  groupadd "$MATRIX_GROUP"
  info "  Created group: $MATRIX_GROUP"
else
  info "  Group $MATRIX_GROUP already exists."
fi

if ! id "$MATRIX_USER" >/dev/null 2>&1; then
  useradd -r -g "$MATRIX_GROUP" -d "$INSTALL_DIR" -s /usr/sbin/nologin "$MATRIX_USER"
  info "  Created user: $MATRIX_USER"
else
  info "  User $MATRIX_USER already exists."
fi

# Add matrix user to matrix-users group (for Samba directory access)
usermod -aG "$MATRIX_GROUP" "$MATRIX_USER" 2>/dev/null || true

# ---------------------------------------------------------------------------
# [2/6] Create directories
# ---------------------------------------------------------------------------
info "[2/6] Creating directories..."

mkdir -p "$DATA_DIR"
mkdir -p "$INSTALL_DIR/nginx.d"
mkdir -p "$INSTALL_DIR/run"
mkdir -p "$INSTALL_DIR/server"

# Copy manager files
if [[ -f "$SCRIPT_DIR/manager.ts" ]]; then
  cp "$SCRIPT_DIR/manager.ts" "$INSTALL_DIR/server/manager.ts"
  info "  Copied manager.ts to $INSTALL_DIR/server/"
fi

# Set ownership
chown -R "$MATRIX_USER:$MATRIX_GROUP" "$DATA_DIR"
chown -R "$MATRIX_USER:$MATRIX_GROUP" "$INSTALL_DIR/run"
chown -R "$MATRIX_USER:$MATRIX_GROUP" "$INSTALL_DIR/nginx.d"
chown -R "$MATRIX_USER:$MATRIX_GROUP" "$INSTALL_DIR/server"
chmod 2775 "$DATA_DIR"  # setgid so new dirs inherit group

info "  Data directory: $DATA_DIR"
info "  Run directory:  $INSTALL_DIR/run"

# ---------------------------------------------------------------------------
# [3/6] Install Nginx
# ---------------------------------------------------------------------------
info "[3/6] Installing Nginx..."

if command -v nginx >/dev/null 2>&1; then
  info "  Nginx is already installed."
else
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq nginx
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q nginx
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q nginx
  else
    warn "  Cannot determine package manager. Please install Nginx manually."
  fi
fi

# Install Nginx config
NGINX_CONF_DEST="/etc/nginx/conf.d/matrix.conf"
if [[ -f "$SCRIPT_DIR/nginx-main.conf" ]]; then
  cp "$SCRIPT_DIR/nginx-main.conf" "$NGINX_CONF_DEST"
  info "  Installed Nginx config to $NGINX_CONF_DEST"
fi

# Allow matrix user to reload Nginx via sudo (no password)
SUDOERS_FILE="/etc/sudoers.d/matrix-nginx"
if [[ ! -f "$SUDOERS_FILE" ]]; then
  echo "$MATRIX_USER ALL=(root) NOPASSWD: /usr/sbin/nginx -s reload" > "$SUDOERS_FILE"
  chmod 440 "$SUDOERS_FILE"
  info "  Granted matrix user permission to reload Nginx"
fi

# Update the manager to use sudo for nginx reload
# (The manager calls `nginx -s reload` — we need it to use `sudo nginx -s reload`)

# Test and start Nginx
nginx -t 2>/dev/null && systemctl enable --now nginx && info "  Nginx enabled and started." || warn "  Nginx config test failed — check $NGINX_CONF_DEST"

# ---------------------------------------------------------------------------
# [4/6] Install and configure Samba
# ---------------------------------------------------------------------------
if [[ "$SKIP_SAMBA" == true ]]; then
  info "[4/6] Samba installation skipped (--skip-samba)."
else
  info "[4/6] Installing and configuring Samba..."

  if command -v smbd >/dev/null 2>&1; then
    info "  Samba is already installed."
  else
    if command -v apt-get >/dev/null 2>&1; then
      apt-get install -y -qq samba
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q samba
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q samba
    else
      warn "  Cannot determine package manager. Please install Samba manually."
    fi
  fi

  # Add Samba share configuration if not already present
  SMB_CONF="/etc/samba/smb.conf"
  if [[ -f "$SMB_CONF" ]] && ! grep -q "\[matrix-projects\]" "$SMB_CONF"; then
    cat >> "$SMB_CONF" <<EOF

[matrix-projects]
    comment = Matrix Agent Project Files
    path = $DATA_DIR
    browseable = yes
    read only = no
    valid users = @$MATRIX_GROUP
    create mask = 0664
    directory mask = 2775
    force group = $MATRIX_GROUP
EOF
    info "  Added [matrix-projects] share to $SMB_CONF"
  else
    info "  Samba share [matrix-projects] already configured."
  fi

  # Enable and start Samba
  systemctl enable --now smbd 2>/dev/null || systemctl enable --now smb 2>/dev/null || warn "  Could not enable Samba service."
  info "  Samba configured. Windows users can access: \\\\<server>\\matrix-projects"
  echo ""
  info "  To add a Samba user:  smbpasswd -a <username>"
  info "  Then add them to the group:  usermod -aG $MATRIX_GROUP <username>"
fi

# ---------------------------------------------------------------------------
# [5/6] Install systemd service
# ---------------------------------------------------------------------------
info "[5/6] Installing systemd service..."

SERVICE_FILE="/etc/systemd/system/matrix-manager.service"
if [[ -f "$SCRIPT_DIR/matrix-manager.service" ]]; then
  # Update paths in the service file
  sed -e "s|/data/matrix-projects|$DATA_DIR|g" \
      -e "s|/opt/matrix|$INSTALL_DIR|g" \
      "$SCRIPT_DIR/matrix-manager.service" > "$SERVICE_FILE"
  info "  Installed $SERVICE_FILE"
fi

systemctl daemon-reload
systemctl enable matrix-manager
info "  Service enabled. Start with: systemctl start matrix-manager"

# ---------------------------------------------------------------------------
# [6/6] Configure the manager to use sudo for Nginx reload
# ---------------------------------------------------------------------------
info "[6/6] Final configuration..."

# Create a wrapper script for nginx reload that uses sudo
NGINX_RELOAD_WRAPPER="$INSTALL_DIR/server/nginx-reload.sh"
cat > "$NGINX_RELOAD_WRAPPER" <<'WRAPPER'
#!/bin/bash
sudo /usr/sbin/nginx -s reload
WRAPPER
chmod +x "$NGINX_RELOAD_WRAPPER"
info "  Created Nginx reload wrapper"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "============================================="
echo "  Server Setup Complete"
echo "============================================="
echo ""
echo "  Data directory      : $DATA_DIR"
echo "  Manager service     : matrix-manager.service"
echo "  Nginx config        : $NGINX_CONF_DEST"
echo "  Nginx fragments     : $INSTALL_DIR/nginx.d/"
if [[ "$SKIP_SAMBA" != true ]]; then
echo "  Samba share         : \\\\<server>\\matrix-projects"
fi
echo ""
echo "  Next steps:"
echo ""
echo "  1. Edit LLM settings in $SERVICE_FILE:"
echo "     Environment=LLM_BASE_URL=http://<llm-server>:<port>/v1"
echo "     Environment=LLM_MODEL=<your-model>"
echo ""
echo "  2. Start the manager service:"
echo "     systemctl start matrix-manager"
echo ""
echo "  3. Open browser to http://<server>/projects/ to manage projects"
echo ""
if [[ "$SKIP_SAMBA" != true ]]; then
echo "  4. Add Samba users (for each Windows user):"
echo "     useradd -g $MATRIX_GROUP <username>"
echo "     smbpasswd -a <username>"
echo ""
fi
