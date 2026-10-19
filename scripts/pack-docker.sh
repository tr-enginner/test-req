#!/usr/bin/env bash
# pack-docker.sh — Build & package the complete Matrix Agent Docker offline deployment
#
# Usage:
#   bash scripts/pack-docker.sh [--version VERSION] [--arch ARCH] [--skip-build] [--skip-nginx-pull] [--incremental] [--include-tools]
#
# 增量打包（不重建镜像、尽量不拉 registry）:
#   bash scripts/pack-docker.sh --incremental
#   # 等价于: --skip-build --skip-nginx-pull
#
# 仅改 manager 等小文件、需更新镜像时（利用层缓存；tag 与脚本内 VERSION= 一致）:
#   DOCKER_BUILDKIT=1 docker build --network=host -f scripts/server/Dockerfile -t matrix-agent:<VERSION> -t matrix-agent:latest . \
#     && docker build --network=host -f scripts/server/Dockerfile.samba -t matrix-samba:<VERSION> -t matrix-samba:latest scripts/server \
#     && docker build --network=host -f scripts/server/schema-mirror/Dockerfile -t matrix-opencode-schema-mirror:<VERSION> -t matrix-opencode-schema-mirror:latest scripts/server/schema-mirror
#   bash scripts/pack-docker.sh --incremental
#
# Prerequisites:
#   - Docker (with buildx)
#   - tools-archive/runtime/linux/{bun,opencode,rg}      (runtime binaries; refresh: bash scripts/download-runtime-linux.sh)
#   - tools-archive/tools/linux/{joern-cli,z3,jdk,...}    (optional, external tools)
#
# Produces:
#   release/matrix-docker-v<VERSION>-linux-<ARCH>.tar.gz
#
# The tarball contains everything needed for air-gapped deployment:
#   - Pre-built Docker images (matrix-agent, matrix-samba, matrix-opencode-schema-mirror, nginx)
#   - docker-compose.yml, nginx.conf, .env.example
#   - install.sh one-click installer
#   - Deployment guide (README.md)
#   - External tools (optional, if present)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="0.2.17"
ARCH="$(uname -m)"
SKIP_BUILD=false
SKIP_NGINX_PULL=false
INCLUDE_TOOLS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-nginx-pull) SKIP_NGINX_PULL=true; shift ;;
    --incremental) SKIP_BUILD=true; SKIP_NGINX_PULL=true; shift ;;
    --include-tools) INCLUDE_TOOLS=true; shift ;;
    -h|--help)
      echo "Usage: bash scripts/pack-docker.sh [--version VERSION] [--arch ARCH] [--skip-build] [--skip-nginx-pull] [--incremental] [--include-tools]"
      echo "  --version VERSION     Set version tag (default: 0.2.17)"
      echo "  --arch ARCH           Target architecture: x86_64 or aarch64 (default: host arch)"
      echo "  --skip-build          Skip Docker image build (use existing local tags matrix-agent/samba:VERSION)"
      echo "  --skip-nginx-pull     Do not docker pull nginx; use local nginx:1.27-alpine (fail save if missing)"
      echo "  --incremental         Same as --skip-build --skip-nginx-pull (offline-friendly re-pack)"
      echo "  --include-tools       Include external tools in the package (default: separate)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]]; then
  echo "ERROR: Unsupported architecture: $ARCH (expected x86_64 or aarch64)" >&2
  exit 1
fi

PACKAGE_NAME="matrix-docker-v${VERSION}-linux-${ARCH}"
RELEASE_DIR="$ROOT_DIR/release"
STAGING_DIR="$(mktemp -d)"
PACKAGE_DIR="$STAGING_DIR/$PACKAGE_NAME"
trap 'rm -rf "$STAGING_DIR"' EXIT

echo "==========================================="
echo " Matrix Agent Docker 离线部署包构建"
echo "==========================================="
echo "版本:   $VERSION"
echo "输出:   $RELEASE_DIR/$PACKAGE_NAME.tar.gz"
echo ""

# ---------------------------------------------------------------------------
# 1. Build Docker images
# ---------------------------------------------------------------------------
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo "=== [1/5] 构建 Docker 镜像 ==="

  # Check prerequisites
  if [[ ! -f "$ROOT_DIR/tools-archive/runtime/linux/bun" ]]; then
    echo "ERROR: tools-archive/runtime/linux/bun not found" >&2
    echo "请先准备 runtime 二进制文件 (bun, opencode, rg)" >&2
    exit 1
  fi

  echo "[构建] matrix-agent:${VERSION}..."
  # --network=host: default bridge build often has no working DNS → pip/apt fail inside RUN
  DOCKER_BUILDKIT=1 docker build --network=host \
    --build-arg "MATRIX_AGENT_VERSION=${VERSION}" \
    -f "$ROOT_DIR/scripts/server/Dockerfile" \
    -t "matrix-agent:${VERSION}" \
    -t "matrix-agent:latest" \
    "$ROOT_DIR"

  echo "[构建] matrix-samba:${VERSION}..."
  DOCKER_BUILDKIT=1 docker build --network=host \
    -f "$ROOT_DIR/scripts/server/Dockerfile.samba" \
    -t "matrix-samba:${VERSION}" \
    -t "matrix-samba:latest" \
    "$ROOT_DIR/scripts/server"

  echo "[构建] matrix-opencode-schema-mirror:${VERSION}..."
  DOCKER_BUILDKIT=1 docker build --network=host \
    -f "$ROOT_DIR/scripts/server/schema-mirror/Dockerfile" \
    -t "matrix-opencode-schema-mirror:${VERSION}" \
    -t "matrix-opencode-schema-mirror:latest" \
    "$ROOT_DIR/scripts/server/schema-mirror"
else
  echo "=== [1/5] 跳过镜像构建 (--skip-build) ==="
fi

echo ""

# ---------------------------------------------------------------------------
# 2. Stage deployment files
# ---------------------------------------------------------------------------
echo "=== [2/5] 准备部署文件 ==="
mkdir -p "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR/images"

# Core deployment files
cp "$ROOT_DIR/scripts/server/docker-compose.yml" "$PACKAGE_DIR/"
cp "$ROOT_DIR/scripts/server/nginx.conf"         "$PACKAGE_DIR/"
cp "$ROOT_DIR/scripts/server/.env.example"        "$PACKAGE_DIR/"
cp "$ROOT_DIR/scripts/server/Dockerfile.samba"    "$PACKAGE_DIR/"
cp "$ROOT_DIR/scripts/server/smb.conf"            "$PACKAGE_DIR/"
cp -a "$ROOT_DIR/scripts/server/schema-mirror"    "$PACKAGE_DIR/"
mkdir -p "$PACKAGE_DIR/opencode-config"
if [[ -f "$ROOT_DIR/release/opencode-config/config.json" ]]; then
  cp "$ROOT_DIR/release/opencode-config/config.json" "$PACKAGE_DIR/opencode-config/"
else
  cp "$ROOT_DIR/scripts/server/opencode-config/config.json" "$PACKAGE_DIR/opencode-config/"
fi

echo "  → docker-compose.yml, nginx.conf, .env.example, Dockerfile.samba, smb.conf, schema-mirror/, opencode-config/"

# ---------------------------------------------------------------------------
# 3. Save Docker images
# ---------------------------------------------------------------------------
echo ""
echo "=== [3/5] 导出 Docker 镜像 ==="

for img in "matrix-agent:${VERSION}" "matrix-samba:${VERSION}" "matrix-opencode-schema-mirror:${VERSION}"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "ERROR: 本地不存在镜像 $img，无法导出。" >&2
    echo "  去掉 --skip-build / --incremental 先构建，或: docker tag matrix-agent:latest $img" >&2
    exit 1
  fi
done

echo "[导出] matrix-agent:${VERSION}..."
docker save "matrix-agent:${VERSION}" | gzip > "$PACKAGE_DIR/images/matrix-agent-${VERSION}.tar.gz"
echo "  → $(du -sh "$PACKAGE_DIR/images/matrix-agent-${VERSION}.tar.gz" | cut -f1)"

echo "[导出] matrix-samba:${VERSION}..."
docker save "matrix-samba:${VERSION}" | gzip > "$PACKAGE_DIR/images/matrix-samba-${VERSION}.tar.gz"
echo "  → $(du -sh "$PACKAGE_DIR/images/matrix-samba-${VERSION}.tar.gz" | cut -f1)"

echo "[导出] matrix-opencode-schema-mirror:${VERSION}..."
docker save "matrix-opencode-schema-mirror:${VERSION}" | gzip > "$PACKAGE_DIR/images/matrix-opencode-schema-mirror-${VERSION}.tar.gz"
echo "  → $(du -sh "$PACKAGE_DIR/images/matrix-opencode-schema-mirror-${VERSION}.tar.gz" | cut -f1)"

echo "[导出] nginx:1.27-alpine..."
if [[ "$SKIP_NGINX_PULL" == "true" ]]; then
  if ! docker image inspect nginx:1.27-alpine >/dev/null 2>&1; then
    echo "ERROR: 本地不存在镜像 nginx:1.27-alpine，无法使用 --skip-nginx-pull / --incremental" >&2
    echo "  请先执行: docker pull nginx:1.27-alpine   或去掉 --skip-nginx-pull" >&2
    exit 1
  fi
  echo "  (跳过 pull，使用本地缓存镜像)"
else
  docker pull nginx:1.27-alpine 2>/dev/null || true
fi
docker save nginx:1.27-alpine | gzip > "$PACKAGE_DIR/images/nginx-1.27-alpine.tar.gz"
echo "  → $(du -sh "$PACKAGE_DIR/images/nginx-1.27-alpine.tar.gz" | cut -f1)"

# ---------------------------------------------------------------------------
# 4. Include external tools (optional)
# ---------------------------------------------------------------------------
echo ""
TOOLS_SRC="$ROOT_DIR/tools-archive/tools/linux"
if [[ "$INCLUDE_TOOLS" == "true" && -d "$TOOLS_SRC" ]]; then
  echo "=== [4/5] 打包外部工具（内嵌模式）==="
  mkdir -p "$PACKAGE_DIR/tools"

  TOOL_LIST=(specchecker aunit code_slicer joern-cli z3 jdk vtest)
  for tool in "${TOOL_LIST[@]}"; do
    if [[ -d "$TOOLS_SRC/$tool" ]]; then
      echo "  → $tool/ ..."
      cp -a "$TOOLS_SRC/$tool" "$PACKAGE_DIR/tools/$tool"
    fi
  done

  # Include deploy-tools.sh
  cp "$ROOT_DIR/scripts/deploy-tools.sh" "$PACKAGE_DIR/tools/"
  chmod +x "$PACKAGE_DIR/tools/deploy-tools.sh"
else
  echo "=== [4/5] 外部工具不内嵌（使用 pack-tools.sh 单独打包）==="
fi

# ---------------------------------------------------------------------------
# 5. Generate install.sh and README
# ---------------------------------------------------------------------------
echo ""
echo "=== [5/5] 生成安装脚本和部署手册 ==="

# ── install.sh ──
cat > "$PACKAGE_DIR/install.sh" << 'INSTALLEOF'
#!/usr/bin/env bash
# Matrix Agent Docker 离线安装脚本
# Usage: sudo bash install.sh [--deploy-dir DIR] [--data-dir DIR] [--tools-dir DIR]
set -euo pipefail

DEPLOY_DIR="/opt/matrix-docker"
DATA_DIR="/data/matrix-projects"
TOOLS_DIR="/data/matrix-tools"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-dir) DEPLOY_DIR="$2"; shift 2 ;;
    --data-dir)   DATA_DIR="$2";   shift 2 ;;
    --tools-dir)  TOOLS_DIR="$2";  shift 2 ;;
    -h|--help)
      echo "Usage: sudo bash install.sh [--deploy-dir DIR] [--data-dir DIR] [--tools-dir DIR]"
      echo "  --deploy-dir DIR  Docker Compose 部署目录 (默认: /opt/matrix-docker)"
      echo "  --data-dir DIR    项目数据目录 (默认: /data/matrix-projects)"
      echo "  --tools-dir DIR   外部工具目录 (默认: /data/matrix-tools)"
      exit 0
      ;;
    *) echo "未知选项: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==========================================="
echo " Matrix Agent Docker 离线安装"
echo "==========================================="
echo "部署目录: $DEPLOY_DIR"
echo "数据目录: $DATA_DIR"
echo "工具目录: $TOOLS_DIR"
echo ""

# Check Docker
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker 未安装，请先安装 Docker" >&2
  exit 1
fi

# 1. Load Docker images
echo "=== [1/4] 导入 Docker 镜像 ==="
for img in "$SCRIPT_DIR"/images/*.tar.gz; do
  if [[ -f "$img" ]]; then
    echo "[导入] $(basename "$img")..."
    docker load -i "$img"
  fi
done

# 2. Create directories
echo ""
echo "=== [2/4] 创建目录 ==="
mkdir -p "$DEPLOY_DIR" "$DATA_DIR" "$TOOLS_DIR"
echo "  → $DEPLOY_DIR"
echo "  → $DATA_DIR"
echo "  → $TOOLS_DIR"

# 3. Copy deployment files
echo ""
echo "=== [3/4] 部署配置文件 ==="
for f in docker-compose.yml nginx.conf Dockerfile.samba smb.conf; do
  if [[ -f "$SCRIPT_DIR/$f" ]]; then
    cp "$SCRIPT_DIR/$f" "$DEPLOY_DIR/$f"
    echo "  → $f"
  fi
done

if [[ -d "$SCRIPT_DIR/schema-mirror" ]]; then
  rm -rf "$DEPLOY_DIR/schema-mirror"
  cp -a "$SCRIPT_DIR/schema-mirror" "$DEPLOY_DIR/schema-mirror"
  echo "  → schema-mirror/"
fi
mkdir -p "$DEPLOY_DIR/opencode-config"
if [[ -f "$SCRIPT_DIR/opencode-config/config.json" ]]; then
  cp "$SCRIPT_DIR/opencode-config/config.json" "$DEPLOY_DIR/opencode-config/config.json"
  echo "  → opencode-config/config.json"
fi

# .env — only copy if not exists (preserve user edits)
if [[ ! -f "$DEPLOY_DIR/.env" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$DEPLOY_DIR/.env"
  # Set data & tools paths
  sed -i "s|^MATRIX_DATA_DIR=.*|MATRIX_DATA_DIR=$DATA_DIR|" "$DEPLOY_DIR/.env"
  sed -i "s|^MATRIX_TOOLS_DIR=.*|MATRIX_TOOLS_DIR=$TOOLS_DIR|" "$DEPLOY_DIR/.env"
  echo "  → .env (从模板创建，请编辑 LLM 配置)"
else
  echo "  → .env 已存在，保留用户配置"
fi

# 4. Deploy external tools (if included)
echo ""
echo "=== [4/4] 部署外部工具 ==="
if [[ -d "$SCRIPT_DIR/tools" ]] && ls "$SCRIPT_DIR/tools/" | grep -qvE '^deploy-tools\.sh$'; then
  cd "$SCRIPT_DIR/tools"
  bash deploy-tools.sh --target "$TOOLS_DIR"
else
  echo "  → 离线包中未包含外部工具（可稍后手动部署）"
fi

# Summary
echo ""
echo "==========================================="
echo " 安装完成!"
echo "==========================================="
echo ""
echo "下一步操作："
echo ""
echo "  1. 编辑 LLM 配置:"
echo "     vi $DEPLOY_DIR/.env"
echo ""
echo "  2. 启动服务:"
echo "     cd $DEPLOY_DIR && docker compose up -d"
echo ""
echo "  3. 查看状态:"
echo "     docker compose -f $DEPLOY_DIR/docker-compose.yml ps"
echo ""
echo "  4. 访问管理门户:"
echo "     http://<服务器IP>:<NGINX_PORT>"
echo "     默认账户: admin / changeme（请尽快修改）"
echo ""
echo "  5. (可选) 配置 Samba 文件共享用户:"
echo "     docker exec -it matrix-samba bash"
echo "     groupadd matrix"
echo "     useradd -g matrix -s /sbin/nologin <username>"
echo "     smbpasswd -a <username>"
INSTALLEOF
chmod +x "$PACKAGE_DIR/install.sh"
echo "  → install.sh"

# ── README.md ──
cat > "$PACKAGE_DIR/README.md" << READMEEOF
# Matrix Agent Docker 离线部署包 v${VERSION}

## 概述

Matrix Agent 是一个基于 LLM 的嵌入式软件测试多智能体系统，支持 GJB 5000A、DO-178C、IEC 61508 等标准。

本离线部署包包含在无互联网环境中部署所需的所有文件。

## 包含内容

\`\`\`
${PACKAGE_NAME}/
├── images/                     # Docker 镜像（离线导入）
│   ├── matrix-agent-${VERSION}.tar.gz    # 主镜像（Manager + OpenCode + Plugin）
│   ├── matrix-samba-${VERSION}.tar.gz    # Samba 文件共享镜像
│   ├── matrix-opencode-schema-mirror-${VERSION}.tar.gz  # OpenCode schema 镜像（离线 \$schema）
│   └── nginx-1.27-alpine.tar.gz       # Nginx 反向代理镜像
├── tools/                      # 外部工具（可选）
│   ├── specchecker/            # MISRA/GJB 编码规范检查
│   ├── aunit/                  # SunwiseAUnit 单元测试
│   ├── joern-cli/              # Joern CPG 代码分析
│   ├── z3/                     # Z3 SMT 求解器
│   ├── jdk/                    # Eclipse Temurin JRE 21
│   └── deploy-tools.sh         # 工具部署脚本
├── docker-compose.yml          # Docker Compose 编排
├── nginx.conf                  # Nginx 反向代理配置
├── .env.example                # 环境变量模板
├── Dockerfile.samba            # Samba 镜像构建文件
├── smb.conf                    # Samba 配置
├── schema-mirror/              # OpenCode schema HTTPS 镜像（opencode.ai 自签）
├── opencode-config/            # 挂载给 schema-mirror 的 config.json（完整 JSON Schema）
├── install.sh                  # 一键安装脚本
└── README.md                   # 本文档
\`\`\`

## 系统要求

- **操作系统**: Linux (aarch64/arm64 或 x86_64)
- **Docker**: >= 20.10 (含 Docker Compose V2)
- **内存**: >= 8GB（推荐 16GB+）
- **磁盘**: >= 20GB 可用空间
- **LLM API**: 需要一个支持 Function Calling 的大模型 API
  - 推荐: Qwen2.5-72B, DeepSeek-V3, Kimi 等
  - 上下文长度: >= 32K tokens
  - 需要支持 tool_call

## 快速安装

\`\`\`bash
# 1. 解压
tar xzf ${PACKAGE_NAME}.tar.gz
cd ${PACKAGE_NAME}/

# 2. 一键安装
sudo bash install.sh

# 3. 编辑 LLM 配置（必须）
sudo vi /opt/matrix-docker/.env

# 4. 启动服务
cd /opt/matrix-docker
sudo docker compose up -d
\`\`\`

## 手动安装

如果需要自定义安装路径：

\`\`\`bash
sudo bash install.sh \\
  --deploy-dir /opt/matrix-docker \\
  --data-dir /data/matrix-projects \\
  --tools-dir /data/matrix-tools
\`\`\`

## 环境变量说明 (.env)

| 变量 | 说明 | 默认值 |
|------|------|--------|
| \`LLM_BASE_URL\` | LLM API 地址 (必填) | — |
| \`LLM_MODEL\` | 模型名称 (必填) | — |
| \`LLM_API_KEY\` | API Key (可选) | — |
| \`MATRIX_VERSION\` | 镜像版本号 | \`${VERSION}\` |
| \`MATRIX_DATA_DIR\` | 项目数据存储路径 | \`/data/matrix-projects\` |
| \`MATRIX_TOOLS_DIR\` | 外部工具路径 | \`/data/matrix-tools\` |
| \`NGINX_PORT\` | Web 门户端口 | \`80\` |
| \`SAMBA_PORT\` | Samba 文件共享端口 | \`445\` |
| \`INSTANCE_PORT_RANGE\` | OpenCode 实例端口范围 | \`5101-5200\` |
| \`MATRIX_ADMIN_USER\` | 管理员用户名 | \`admin\` |
| \`MATRIX_ADMIN_PASS\` | 管理员密码 (必填) | \`changeme\` |
| \`COMPOSE_PROJECT_NAME\` | Docker Compose 项目名 | \`matrix\` |
| \`MATRIX_OPENCODE_SCHEMA_MIRROR\` | 是否在 opencode.json 写入 \`\$schema\` 指向 mirror | \`1\` |
| \`MATRIX_OPENCODE_SCHEMA_INSECURE_TLS\` | Docker 下对 OpenCode 跳过 TLS 校验（自签 opencode.ai）；\`0\` 为严格校验 | \`1\` |
| \`OPENCODE_SCHEMA_HOST_PATH\` | 宿主机完整 \`config.json\` 路径 | \`./opencode-config/config.json\` |

## 架构说明

\`\`\`
┌─────────────────────────────────────────────────────┐
│                    Nginx (端口 80)                    │
│  ┌─────────────┐  ┌──────────────────────────────┐  │
│  │ / → Manager  │  │ :5101-5200 → OpenCode 实例   │  │
│  └──────┬──────┘  └─────────────┬────────────────┘  │
└─────────┼───────────────────────┼───────────────────┘
          │                       │
  ┌───────▼─────────┐   ┌────────▼──────────┐
  │ Manager (3000)  │   │ OpenCode Instance  │
  │  - 项目管理      │   │  - 代码分析         │
  │  - 用户认证      │◄──│  - 测试生成         │
  │  - 实例编排      │   │  - 报告输出         │
  │  - 文件上传/下载  │   │  (每个项目一个容器)   │
  └────────┬────────┘   └────────┬──────────┘
           │                     │
     ┌─────▼─────────────────────▼─────┐
     │  Docker Volume: matrix-projects │
     │  /data/matrix-projects/          │
     │  ├── user1/project1/             │
     │  │   ├── 源码子目录/              │  ← sourceRoot 自动检测
     │  │   │   ├── .matrix/reports/    │  ← 报告在源码目录下
     │  │   │   ├── opencode.json       │
     │  │   │   └── src/...             │
     │  │   └── ...                     │
     │  └── user2/project2/             │
     └────────────────────────────────-─┘
\`\`\`

### 源码子目录自动检测 (v${VERSION} 新特性)

当用户上传的压缩包包含一个顶层包装目录时（如 \`2024年/\`），系统会自动检测：

1. **创建项目时**: \`detectSourceRoot()\` 检测解压后的唯一子目录
2. **保存记录**: \`sourceRoot\` 字段持久化到 \`port-allocations.json\`
3. **启动实例时**: OpenCode 的工作目录自动设置为源码子目录
4. **下载报告时**: \`findMatrixDir()\` 递归搜索有实际内容的 \`.matrix/\` 目录

这解决了之前"下载报告为空"的问题。

## 服务管理

\`\`\`bash
cd /opt/matrix-docker

# 启动所有服务
docker compose up -d

# 查看状态
docker compose ps

# 查看日志
docker compose logs -f manager
docker compose logs -f nginx

# 重启
docker compose restart

# 停止
docker compose down

# 更新（替换镜像后）
docker compose down
docker load -i images/matrix-agent-${VERSION}.tar.gz
docker compose up -d
\`\`\`

## 外部工具

外部工具部署到 \`MATRIX_TOOLS_DIR\` 后，Manager 会自动检测并注入环境变量到 OpenCode 实例：

| 工具目录 | 环境变量 | 用途 |
|----------|----------|------|
| \`specchecker/\` | \`SPECCHECKER_HOME\` | MISRA/GJB 编码规范静态检查 |
| \`aunit/\` | \`AUNIT_HOME\` | SunwiseAUnit 单元测试框架 |
| \`joern-cli/\` | \`JOERN_HOME\` | Joern CPG 代码属性图分析 |
| \`z3/\` | \`Z3_HOME\` | Z3 SMT 求解器 (原子性验证) |
| \`jdk/\` | \`JAVA_HOME\` | Java 运行环境 (Joern 依赖) |
| \`vtest/\` | \`VTEST_HOME\` | VTest 测试执行工具 |

如果离线包中未包含工具，可稍后单独部署：

\`\`\`bash
# 将工具解压到 MATRIX_TOOLS_DIR
tar xzf matrix-tools-v*-linux-*.tar.gz
cd matrix-tools-v*/
sudo bash deploy-tools.sh --target /data/matrix-tools

# 重启 manager 使配置生效
docker restart matrix-manager
\`\`\`

## 故障排查

### Manager 无法启动
\`\`\`bash
docker compose logs manager
# 检查 .env 中 LLM_BASE_URL 和 LLM_MODEL 是否正确
\`\`\`

### 项目实例无法启动
\`\`\`bash
# 检查 Docker API
docker info
# 检查 Manager 日志
docker logs matrix-manager
# 检查 Docker socket 权限
ls -la /var/run/docker.sock
\`\`\`

### 下载报告为空
v${VERSION} 已修复此问题。如果仍然为空，检查：
\`\`\`bash
# 进入项目目录查看 .matrix 位置
find /data/matrix-projects/<user>/<project>/ -name ".matrix" -type d
\`\`\`

### Nginx 502 Bad Gateway
\`\`\`bash
# 检查实例容器是否在运行
docker ps | grep opencode
# 重载 Nginx 配置
docker kill -s SIGHUP matrix-nginx
\`\`\`

### 端口冲突
编辑 \`.env\` 修改端口，然后 \`docker compose down && docker compose up -d\`

## 版本历史

### v${VERSION} ($(date +%Y-%m-%d)) — 本离线包
- **OpenCode 工作目录**: 修复 Web 终端/工作区仍显示 \`/\` 的问题。\`manager\` 在 Docker 模式下不再因「容器已在运行」跳过初始化；始终写入配置并 \`ensureGitWorkspace\`（无 \`HEAD\` 时补空提交）；\`sourceRoot\` 以磁盘检测为准并与持久化记录校验；实例容器强制重建；\`opencode web\` 通过 \`sh -lc cd\` 与 \`OPENCODE_WORKDIR\`/\`PWD\` 进入项目目录。

### v0.2.3 及更早（摘要）
- LLM / \`opencode.json\`、中文路径 \`tarfile\` 解压、RAR、\`git\` 初版与 \`autoupdate: false\`、Nginx \`\$http_host\`、\`sourceRoot\`、大文件上传等；详见上一发行包说明。

### 从上一版本升级

\`\`\`bash
cd /opt/matrix-docker
docker compose down
docker load -i /path/to/${PACKAGE_NAME}/images/matrix-agent-${VERSION}.tar.gz
docker load -i /path/to/${PACKAGE_NAME}/images/matrix-samba-${VERSION}.tar.gz
# 编辑 .env：MATRIX_VERSION=${VERSION}
vi .env
docker compose up -d
# 各 OpenCode 项目建议「停止」再「启动」以刷新 Nginx 片段与配置
\`\`\`
READMEEOF
echo "  → README.md"

# ---------------------------------------------------------------------------
# Create final tarball
# ---------------------------------------------------------------------------
echo ""
echo "=== 打包 ==="
mkdir -p "$RELEASE_DIR"
OUTPUT_FILE="$RELEASE_DIR/${PACKAGE_NAME}.tar.gz"

tar czf "$OUTPUT_FILE" -C "$STAGING_DIR" "$PACKAGE_NAME"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL_SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
echo ""
echo "==========================================="
echo " 离线部署包构建完成!"
echo "==========================================="
echo ""
echo "文件: $OUTPUT_FILE"
echo "大小: $TOTAL_SIZE"
echo ""
echo "包含内容:"
tar tzf "$OUTPUT_FILE" | grep -E '^[^/]+/[^/]*$' | sed 's/^/  /'
echo ""
echo "部署步骤:"
echo "  1. 将 $OUTPUT_FILE 传输到目标服务器"
echo "  2. tar xzf $(basename "$OUTPUT_FILE")"
echo "  3. cd $PACKAGE_NAME && sudo bash install.sh"
echo "  4. 编辑 /opt/matrix-docker/.env 配置 LLM"
echo "  5. cd /opt/matrix-docker && docker compose up -d"
