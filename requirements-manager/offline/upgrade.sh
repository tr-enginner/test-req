#!/usr/bin/env sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET_DIR=${1:-}
backup_root=""
services_stopped=0

report_failure() {
  exit_code=$?
  if [ "$exit_code" -ne 0 ] && [ "$services_stopped" -eq 1 ]; then
    echo "升级未完成，服务当前可能处于停止或部分启动状态。" >&2
    echo "数据未被删除；升级前备份位于：$backup_root" >&2
  fi
}
trap report_failure EXIT

usage() {
  cat <<'EOF'
用法：
  ./upgrade.sh /现有/requirements-manager-arm64-offline

请在“新版本离线包”的解压目录中执行本脚本，并把当前正在使用的旧部署目录作为参数。
脚本不会覆盖旧部署中的 data/、.env 和 data/opencode-config/opencode.json。
EOF
}

fail() {
  echo "错误：$*" >&2
  exit 1
}

[ -n "$TARGET_DIR" ] || { usage >&2; exit 1; }
[ -d "$TARGET_DIR" ] || fail "旧部署目录不存在：$TARGET_DIR"
TARGET_DIR=$(CDPATH= cd -- "$TARGET_DIR" && pwd)
[ "$SOURCE_DIR" != "$TARGET_DIR" ] || fail "新旧部署目录不能相同；请将新离线包解压到独立目录后执行升级"

for command_name in docker sha256sum cp date uname; do
  command -v "$command_name" >/dev/null 2>&1 || fail "系统缺少命令：$command_name"
done
docker info >/dev/null 2>&1 || fail "当前用户无法访问Docker，请检查Docker服务和用户权限"
case "$(uname -m)" in
  aarch64|arm64) ;;
  *) fail "该离线升级包仅支持ARM64/aarch64，当前架构为 $(uname -m)" ;;
esac

for source_file in SHA256SUMS requirements-manager-arm64-images.tar docker-compose.yml compose.sh start.sh stop.sh status.sh logs.sh; do
  [ -f "$SOURCE_DIR/$source_file" ] || fail "新离线包缺少文件：$source_file"
done
[ -x "$SOURCE_DIR/bin/docker-compose" ] || fail "新离线包缺少可执行的 bin/docker-compose"
[ -f "$TARGET_DIR/.env" ] || fail "旧部署目录缺少.env：$TARGET_DIR/.env"
[ -d "$TARGET_DIR/data" ] || fail "旧部署目录缺少data目录：$TARGET_DIR/data"
[ -s "$TARGET_DIR/data/opencode-config/opencode.json" ] || fail "旧部署缺少OpenCode配置文件"
[ -x "$TARGET_DIR/compose.sh" ] || fail "旧部署缺少可执行的compose.sh"
[ -f "$TARGET_DIR/docker-compose.yml" ] || fail "旧部署缺少docker-compose.yml"

echo "[1/8] 校验新离线包完整性..."
(cd "$SOURCE_DIR" && sed 's/\r$//' SHA256SUMS | sha256sum -c -)

timestamp=$(date +%Y%m%d-%H%M%S)
target_parent=$(dirname "$TARGET_DIR")
backup_root="$target_parent/requirements-manager-backups/$timestamp"
mkdir -p "$backup_root"

echo "[2/8] 检查旧服务并备份PostgreSQL..."
postgres_container=$("$TARGET_DIR/compose.sh" ps -q postgres 2>/dev/null || true)
[ -n "$postgres_container" ] || fail "旧部署的PostgreSQL未运行，无法生成一致的逻辑备份。请先启动旧服务后重试"
docker inspect "$postgres_container" >/dev/null 2>&1 || fail "无法访问旧PostgreSQL容器"
"$TARGET_DIR/compose.sh" exec -T postgres \
  pg_dump -U matrix -d matrix_requirements -Fc \
  > "$backup_root/matrix_requirements.dump"
[ -s "$backup_root/matrix_requirements.dump" ] || fail "PostgreSQL逻辑备份为空，已终止升级"

echo "[3/8] 导入新版本ARM64镜像..."
docker load -i "$SOURCE_DIR/requirements-manager-arm64-images.tar"

echo "[4/8] 停止旧服务（保留全部数据）..."
"$TARGET_DIR/stop.sh"
services_stopped=1

echo "[5/8] 归档全部持久化数据和配置..."
docker run --rm --user 0:0 \
  --entrypoint tar \
  -v "$TARGET_DIR:/source:ro" \
  -v "$backup_root:/backup" \
  requirements-manager-postgres:arm64 \
  -czpf /backup/persistent-data.tar.gz -C /source data .env
[ -s "$backup_root/persistent-data.tar.gz" ] || fail "持久化数据归档为空，已停止升级"
(cd "$backup_root" && sha256sum matrix_requirements.dump persistent-data.tar.gz > BACKUP-SHA256SUMS)
if [ -f "$TARGET_DIR/manifest.json" ]; then
  cp -p "$TARGET_DIR/manifest.json" "$backup_root/previous-manifest.json"
fi
cp -p "$TARGET_DIR/docker-compose.yml" "$backup_root/previous-docker-compose.yml"

echo "[6/8] 更新部署脚本和Compose配置..."
mkdir -p "$TARGET_DIR/bin"
for runtime_file in docker-compose.yml compose.sh install.sh start.sh stop.sh status.sh logs.sh upgrade.sh README-OFFLINE.md; do
  if [ -f "$SOURCE_DIR/$runtime_file" ]; then
    cp -p "$SOURCE_DIR/$runtime_file" "$TARGET_DIR/$runtime_file"
  fi
done
# 不能用cp直接截断正在或刚刚执行过的Compose二进制，否则Linux可能返回
# "Text file busy"。先写入同目录临时文件，再通过rename原子替换旧inode。
compose_temp="$TARGET_DIR/bin/.docker-compose.upgrade.$$"
rm -f "$compose_temp"
cp -p "$SOURCE_DIR/bin/docker-compose" "$compose_temp"
chmod +x "$compose_temp"
mv -f "$compose_temp" "$TARGET_DIR/bin/docker-compose"
if [ -f "$SOURCE_DIR/manifest.json" ]; then
  cp -p "$SOURCE_DIR/manifest.json" "$TARGET_DIR/manifest.json"
fi
chmod +x "$TARGET_DIR/bin/docker-compose" "$TARGET_DIR"/*.sh

# 再次断言用户数据和关键配置仍然存在，防止错误路径导致带病启动。
[ -d "$TARGET_DIR/data/postgres" ] || fail "升级后缺少data/postgres，拒绝启动"
[ -d "$TARGET_DIR/data/projects" ] || fail "升级后缺少data/projects，拒绝启动"
[ -s "$TARGET_DIR/.env" ] || fail "升级后.env丢失，拒绝启动"
[ -s "$TARGET_DIR/data/opencode-config/opencode.json" ] || fail "升级后OpenCode配置丢失，拒绝启动"

echo "[7/8] 启动新版本（API会自动执行数据库迁移）..."
"$TARGET_DIR/start.sh"

echo "[8/8] 等待核心服务进入运行状态..."
attempt=0
while [ "$attempt" -lt 36 ]; do
  infrastructure_healthy=1
  for service_name in postgres redis minio; do
    service_container=$("$TARGET_DIR/compose.sh" ps -q "$service_name" 2>/dev/null || true)
    service_health=""
    if [ -n "$service_container" ]; then
      service_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$service_container" 2>/dev/null || true)
    fi
    [ "$service_health" = "healthy" ] || infrastructure_healthy=0
  done
  application_count=$("$TARGET_DIR/compose.sh" ps --status running -q opencode api worker web 2>/dev/null | wc -l | tr -d ' ')
  if [ "$infrastructure_healthy" -eq 1 ] && [ "$application_count" -eq 4 ]; then
    echo "升级完成。"
    echo "备份目录：$backup_root"
    echo "请登录系统核对账号、项目、上传文件、评审记录和.matrix工件。"
    "$TARGET_DIR/status.sh"
    services_stopped=0
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 5
done

echo "错误：部分服务未在180秒内进入运行状态。数据备份完好，位置：$backup_root" >&2
echo "请执行：$TARGET_DIR/logs.sh api worker opencode web" >&2
"$TARGET_DIR/status.sh" >&2 || true
exit 1
