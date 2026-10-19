#!/usr/bin/env sh
set -eu

BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$BASE_DIR"

[ -f .env ] || { echo "错误：缺少.env，请先执行 ./install.sh" >&2; exit 1; }

required_vars="POSTGRES_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY JWT_SECRET OPENCODE_USERNAME OPENCODE_PASSWORD ADMIN_USERNAME ADMIN_PASSWORD WEB_ORIGIN"
for name in $required_vars; do
  value=$(sed -n "s/^${name}=//p" .env | tail -n 1)
  if [ -z "$value" ] || printf '%s' "$value" | grep -qi 'replace-with'; then
    echo "错误：请在.env中正确设置 $name" >&2
    exit 1
  fi
done

web_origin=$(sed -n 's/^WEB_ORIGIN=//p' .env | tail -n 1)
case "$web_origin" in
  http://*:8089|https://*:8089) ;;
  *) echo "错误：WEB_ORIGIN必须是外部可访问地址并使用8089端口，例如 http://192.168.1.100:8089" >&2; exit 1 ;;
esac

jwt_secret=$(sed -n 's/^JWT_SECRET=//p' .env | tail -n 1)
if [ ${#jwt_secret} -lt 32 ]; then
  echo "错误：JWT_SECRET至少需要32个字符" >&2
  exit 1
fi

[ -s data/opencode-config/opencode.json ] || { echo "错误：缺少OpenCode配置文件" >&2; exit 1; }
grep -q '"model"' data/opencode-config/opencode.json || { echo "错误：OpenCode配置中未设置model" >&2; exit 1; }
grep -q 'file:///plugin/dist/index.js' data/opencode-config/opencode.json || { echo "错误：OpenCode配置中必须保留Matrix插件" >&2; exit 1; }

if command -v ss >/dev/null 2>&1 && ss -ltn | awk '{print $4}' | grep -Eq '(^|:)8089$'; then
  echo "错误：宿主机8089端口已被占用" >&2
  exit 1
fi

./compose.sh up -d --pull never
echo "服务正在启动，请稍候..."
./compose.sh ps
echo "访问地址：$web_origin"

