#!/usr/bin/env sh
set -eu

BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$BASE_DIR"

ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
  echo "错误：该离线包仅支持ARM64/aarch64，当前架构为 $ARCH" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || { echo "错误：未安装Docker Engine" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "错误：当前用户无法访问Docker，请检查Docker服务和用户权限" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "错误：系统缺少sha256sum" >&2; exit 1; }

echo "校验离线包完整性..."
# Accept legacy bundles whose checksum manifest was generated on Windows with
# CRLF endings. Only the manifest stream is normalised; payload files remain
# byte-for-byte unchanged and are still fully verified.
sed 's/\r$//' SHA256SUMS | sha256sum -c -

chmod +x bin/docker-compose ./*.sh
mkdir -p data/postgres data/redis data/minio data/projects data/opencode-config

if [ ! -f .env ]; then
  cp .env.example .env
  echo "已生成.env，请修改其中的密码、服务器地址和模型配置后再执行 ./start.sh"
fi
if [ ! -f data/opencode-config/opencode.json ]; then
  cp data/opencode-config/opencode.json.example data/opencode-config/opencode.json
  chmod 600 data/opencode-config/opencode.json
fi

echo "导入ARM64镜像，这可能需要几分钟..."
docker load -i requirements-manager-arm64-images.tar

echo "离线安装完成。请编辑 .env 和 data/opencode-config/opencode.json，然后执行 ./start.sh"
