#!/usr/bin/env sh
set -eu

BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE="$BASE_DIR/bin/docker-compose"

if [ ! -x "$COMPOSE" ]; then
  echo "错误：未找到可执行的ARM64 Docker Compose：$COMPOSE" >&2
  echo "请先执行 ./install.sh" >&2
  exit 1
fi

exec "$COMPOSE" --project-directory "$BASE_DIR" -f "$BASE_DIR/docker-compose.yml" "$@"

