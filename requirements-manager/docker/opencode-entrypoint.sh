#!/bin/sh
set -u

CONFIG_DIR=/root/.config/opencode
CONFIG_FILE="$CONFIG_DIR/opencode.json"
RESTART_FILE="$CONFIG_DIR/.restart-request"
APPLIED_FILE="$CONFIG_DIR/.restart-applied"

mkdir -p "$CONFIG_DIR"
if [ ! -s "$CONFIG_FILE" ]; then
  printf '{"$schema":"https://opencode.ai/config.json","model":"deepseek/deepseek-v4-flash","plugin":["file:///plugin/dist/index.js"]}\n' > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
fi

child_pid=""
runner_pid=""
last_request="$(cat "$RESTART_FILE" 2>/dev/null || true)"

if ! command -v node >/dev/null 2>&1; then
  echo "Phase 2 runner启动失败：容器中未找到Node.js" >&2
  exit 1
fi
if [ ! -f /plugin/dist/direct-phase2-runner.js ]; then
  echo "Phase 2 runner启动失败：缺少/plugin/dist/direct-phase2-runner.js" >&2
  exit 1
fi

start_server() {
  echo "正在启动OpenCode服务"
  "$@" &
  child_pid=$!
}

stop_server() {
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
}

start_runner() {
  echo "正在启动Matrix Phase 2 deterministic runner"
  node --enable-source-maps /plugin/dist/direct-phase2-runner.js &
  runner_pid=$!
  sleep 1
  if ! kill -0 "$runner_pid" 2>/dev/null; then
    wait "$runner_pid"
    status=$?
    [ "$status" -ne 0 ] || status=1
    echo "Matrix Phase 2 deterministic runner启动失败，退出码：$status" >&2
    exit "$status"
  fi
}

stop_runner() {
  if [ -n "$runner_pid" ] && kill -0 "$runner_pid" 2>/dev/null; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
}

trap 'stop_server; stop_runner; exit 0' INT TERM
start_runner
start_server "$@"

while true; do
  if ! kill -0 "$runner_pid" 2>/dev/null; then
    wait "$runner_pid"
    status=$?
    [ "$status" -ne 0 ] || status=1
    echo "Matrix Phase 2 deterministic runner异常退出，容器退出码：$status" >&2
    exit "$status"
  fi
  if ! kill -0 "$child_pid" 2>/dev/null; then
    wait "$child_pid" 2>/dev/null || true
    echo "OpenCode服务已退出，2秒后自动重试"
    sleep 2
    start_server "$@"
  fi
  request="$(cat "$RESTART_FILE" 2>/dev/null || true)"
  if [ -n "$request" ] && [ "$request" != "$last_request" ]; then
    echo "检测到OpenCode配置更新，正在重启服务"
    stop_server
    last_request="$request"
    start_server "$@"
    printf '%s\n' "$request" > "$APPLIED_FILE"
  fi
  sleep 1
done
