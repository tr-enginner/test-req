#!/usr/bin/env bash
# Matrix Agent — Docker offline deployment script
#
# This script is included in the offline Docker package and runs on
# target servers that have Docker installed but no internet access.
#
# It loads pre-built container images and starts the compose stack.
#
# Usage:
#   ./deploy.sh [--data-dir /data/matrix-projects] [--port 80]
#
# What it does:
#   1. docker load — loads matrix-agent, matrix-samba, matrix-opencode-schema-mirror, nginx images
#   2. Copies compose files to /opt/matrix-docker/
#   3. Creates .env from template (or preserves existing)
#   4. docker compose up -d

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/matrix-docker"
DATA_DIR="/data/matrix-projects"
NGINX_PORT="80"
SAMBA_PORT="445"

# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)  DATA_DIR="$2";   shift 2 ;;
    --port)      NGINX_PORT="$2"; shift 2 ;;
    --samba-port) SAMBA_PORT="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--data-dir DIR] [--port PORT] [--samba-port PORT] [--install-dir DIR]"
      echo ""
      echo "Options:"
      echo "  --data-dir DIR       Project data directory (default: /data/matrix-projects)"
      echo "  --port PORT          Nginx HTTP port (default: 80)"
      echo "  --samba-port PORT    Samba port (default: 445)"
      echo "  --install-dir DIR    Installation directory (default: /opt/matrix-docker)"
      exit 0
      ;;
    *) echo "[ERROR] Unknown argument: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

info()  { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $*"; exit 1; }

if ! command -v docker &>/dev/null; then
  error "Docker is not installed. Please install Docker first."
fi

if ! docker info &>/dev/null; then
  error "Docker daemon is not running or current user lacks permissions."
fi

# Check for docker compose (v2 plugin or standalone)
if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  error "docker compose is not available. Install docker-compose-plugin or standalone docker-compose."
fi

# ---------------------------------------------------------------------------
# [1/3] Load Docker images
# ---------------------------------------------------------------------------

info "=== Matrix Agent — Docker Deployment ==="
info ""
info "[1/3] Loading Docker images..."

IMAGE_COUNT=0
for tarfile in "$SCRIPT_DIR"/images/*.tar.gz "$SCRIPT_DIR"/images/*.tar; do
  if [[ -f "$tarfile" ]]; then
    info "  Loading $(basename "$tarfile")..."
    docker load -i "$tarfile"
    IMAGE_COUNT=$((IMAGE_COUNT + 1))
  fi
done

if [[ $IMAGE_COUNT -eq 0 ]]; then
  warn "No image tar files found in $SCRIPT_DIR/images/"
  warn "Make sure matrix-agent, matrix-samba, matrix-opencode-schema-mirror, and nginx images are available."
fi

info "  Loaded $IMAGE_COUNT images."

# ---------------------------------------------------------------------------
# [2/3] Install compose files
# ---------------------------------------------------------------------------

info ""
info "[2/3] Setting up compose files in $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR"
mkdir -p "$DATA_DIR"

# Copy compose files
for f in docker-compose.yml nginx.conf Dockerfile.samba smb.conf; do
  if [[ -f "$SCRIPT_DIR/$f" ]]; then
    cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
    info "  Copied $f"
  fi
done

# OpenCode JSON Schema mirror (offline https://opencode.ai/config.json)
if [[ -d "$SCRIPT_DIR/schema-mirror" ]]; then
  rm -rf "$INSTALL_DIR/schema-mirror"
  cp -a "$SCRIPT_DIR/schema-mirror" "$INSTALL_DIR/schema-mirror"
  info "  Copied schema-mirror/"
fi
mkdir -p "$INSTALL_DIR/opencode-config"
if [[ -f "$SCRIPT_DIR/opencode-config/config.json" ]]; then
  cp "$SCRIPT_DIR/opencode-config/config.json" "$INSTALL_DIR/opencode-config/config.json"
  info "  Copied opencode-config/config.json"
fi

# Create .env if not present (preserve existing config on re-deploy)
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  info "  Existing .env preserved (not overwritten)"
else
  if [[ -f "$SCRIPT_DIR/.env.example" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  else
    cat > "$ENV_FILE" <<ENVEOF
LLM_BASE_URL=http://your-llm-server:8080/v1
LLM_MODEL=your-model-name
LLM_API_KEY=
MATRIX_VERSION=latest
MATRIX_DATA_DIR=$DATA_DIR
NGINX_PORT=$NGINX_PORT
SAMBA_PORT=$SAMBA_PORT
COMPOSE_PROJECT_NAME=matrix
ENVEOF
  fi
  info "  Created .env — please edit LLM_BASE_URL and LLM_MODEL before first use"
fi

# Update data dir and ports in .env if they differ from defaults
sed -i "s|^MATRIX_DATA_DIR=.*|MATRIX_DATA_DIR=$DATA_DIR|" "$ENV_FILE"
sed -i "s|^NGINX_PORT=.*|NGINX_PORT=$NGINX_PORT|" "$ENV_FILE"
sed -i "s|^SAMBA_PORT=.*|SAMBA_PORT=$SAMBA_PORT|" "$ENV_FILE"

# ---------------------------------------------------------------------------
# [3/3] Start services
# ---------------------------------------------------------------------------

info ""
info "[3/3] Starting Docker Compose services..."

cd "$INSTALL_DIR"
$COMPOSE up -d

info ""
info "=== Deployment complete ==="
info ""
info "  Management portal: http://localhost:${NGINX_PORT}/projects/"
info "  Data directory:    $DATA_DIR"
info "  Compose files:     $INSTALL_DIR"
info ""
info "  To check status:   cd $INSTALL_DIR && $COMPOSE ps"
info "  To view logs:      cd $INSTALL_DIR && $COMPOSE logs -f"
info "  To stop:           cd $INSTALL_DIR && $COMPOSE down"
info ""
info "  IMPORTANT: Edit $ENV_FILE to set LLM_BASE_URL and LLM_MODEL,"
info "  then restart:  cd $INSTALL_DIR && $COMPOSE restart manager"
