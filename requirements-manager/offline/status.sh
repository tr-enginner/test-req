#!/usr/bin/env sh
set -eu
BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$BASE_DIR/compose.sh" ps
echo "宿主机应仅对外监听Web端口8089；可使用 ss -ltnp 检查。"

