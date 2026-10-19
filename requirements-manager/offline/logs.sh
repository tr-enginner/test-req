#!/usr/bin/env sh
set -eu
BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$BASE_DIR/compose.sh" logs -f --tail=200 "$@"

