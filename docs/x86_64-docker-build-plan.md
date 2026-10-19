# Matrix Agent — x86_64 Docker 离线部署包构建计划

## 目标

在 **x86_64 Ubuntu 22.04** 机器上，构建与 aarch64 版本结构一致的 Docker 离线部署包。

## 前提条件

- Ubuntu 22.04 x86_64 机器，已安装：
  - Docker >= 20.10（含 Docker Compose V2）
  - Git
  - curl, unzip, tar
  - Bun（用于构建 TypeScript 插件），安装命令：`curl -fsSL https://bun.sh/install | bash`
- 可访问 GitHub（下载开源工具和 runtime 二进制）
- 至少 20GB 可用磁盘空间

## 最终产物

```
release/matrix-docker-v0.2.0-linux-x86_64.tar.gz
```

其结构与 aarch64 版本一致：

```
matrix-docker-v0.2.0-linux-x86_64/
├── images/
│   ├── matrix-agent-0.2.0.tar.gz    # 主镜像（Manager + OpenCode + Plugin）
│   ├── matrix-samba-0.2.0.tar.gz    # Samba 文件共享镜像
│   └── nginx-1.27-alpine.tar.gz     # Nginx 反向代理镜像
├── docker-compose.yml
├── nginx.conf
├── .env.example
├── Dockerfile.samba
├── smb.conf
├── install.sh                        # 一键安装脚本
└── README.md
```

---

## 步骤

### 第 1 步：克隆代码仓库

```bash
git clone https://github.com/wangilson/matrix-embedded-agent.git
cd matrix-embedded-agent
git checkout confirmation-test-case
```

如果已经位于对应仓库和分支，可以跳过这一步。

### 第 2 步：安装项目依赖

```bash
bun install
```

此命令会：
- 安装 npm 依赖
- 通过 `scripts/postinstall.ts` 自动下载 x86_64 的 `bin/mdbook` 和 `bin/sg`（ast-grep）

验证：
```bash
file bin/mdbook bin/sg
# 应输出: x86-64
```

### 第 3 步：准备 x86_64 runtime 二进制

`tools-archive/runtime/linux/` 目录在 `.gitignore` 中，不会被 git 跟踪，需要手动准备三个 x86_64 二进制文件。

```bash
mkdir -p tools-archive/runtime/linux
```

#### 3.1 下载 Bun (x86_64)

```bash
curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.2.5/bun-linux-x64.zip
unzip -o /tmp/bun.zip -d /tmp/bun-extract
cp /tmp/bun-extract/bun-linux-x64/bun tools-archive/runtime/linux/bun
chmod +x tools-archive/runtime/linux/bun
rm -rf /tmp/bun.zip /tmp/bun-extract
```

> **注意**：Bun 版本应与 aarch64 一致。当前 aarch64 使用的是 Bun 1.2.x，建议直接去 https://github.com/oven-sh/bun/releases 确认最新 1.2.x 稳定版。

#### 3.2 下载 OpenCode (x86_64)

OpenCode 需要从其发布渠道获取 x86_64 版本。查看 aarch64 版本中 opencode 的来源：

```bash
# 检查 opencode 二进制中的版本信息
strings tools-archive/runtime/linux/opencode | grep -i "opencode.*version\|v[0-9]" | head -5
```

如果 OpenCode 有 GitHub Release，下载对应 x86_64 / linux-x64 版本放到 `tools-archive/runtime/linux/opencode`。

> **如果找不到 x86_64 的 opencode 二进制**：请从 aarch64 机器获取 opencode 的来源信息（下载 URL 或构建方法），然后在 x86_64 机器上获取对应版本。

```bash
chmod +x tools-archive/runtime/linux/opencode
```

#### 3.3 下载 ripgrep (x86_64)

```bash
RG_VERSION="14.1.1"
curl -fsSL -o /tmp/rg.tar.gz \
  "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz"
tar xzf /tmp/rg.tar.gz -C /tmp/
cp /tmp/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl/rg tools-archive/runtime/linux/rg
chmod +x tools-archive/runtime/linux/rg
rm -rf /tmp/rg.tar.gz /tmp/ripgrep-*
```

#### 验证

```bash
file tools-archive/runtime/linux/*
# 三个文件都应该是: ELF 64-bit LSB ... x86-64
```

### 第 4 步：构建 Docker 镜像

```bash
# 构建主镜像 matrix-agent
docker build -f scripts/server/Dockerfile \
  -t matrix-agent:0.2.0 \
  -t matrix-agent:latest \
  .

# 构建 Samba 镜像
docker build -f scripts/server/Dockerfile.samba \
  -t matrix-samba:0.2.0 \
  -t matrix-samba:latest \
  scripts/server/
```

验证镜像：
```bash
docker images | grep -E "matrix-agent|matrix-samba"
```

### 第 5 步：修改打包脚本的架构标识（可选）

当前 `scripts/pack-docker.sh` 生成的包名带有 `aarch64`。需要修改为 `x86_64`：

在 `scripts/pack-docker.sh` 中，找到这一行：
```bash
PACKAGE_NAME="matrix-docker-v${VERSION}-linux-aarch64"
```

改为：
```bash
PACKAGE_NAME="matrix-docker-v${VERSION}-linux-x86_64"
```

或者直接不改脚本，在打包完成后重命名。

### 第 6 步：打包离线部署包

```bash
bash scripts/pack-docker.sh --skip-build
```

使用 `--skip-build` 是因为第 4 步已经构建好了镜像。

脚本会：
1. 将 `docker-compose.yml`、`nginx.conf`、`.env.example`、`Dockerfile.samba`、`smb.conf` 复制到临时目录
2. `docker save` 导出 `matrix-agent:0.2.0`、`matrix-samba:0.2.0`、`nginx:1.27-alpine` 镜像
3. 生成 `install.sh` 一键安装脚本和 `README.md`
4. 打包为 `release/matrix-docker-v0.2.0-linux-aarch64.tar.gz`（如未改脚本则是 aarch64 名字）

如果没改脚本，重命名：
```bash
mv release/matrix-docker-v0.2.0-linux-aarch64.tar.gz \
   release/matrix-docker-v0.2.0-linux-x86_64.tar.gz
```

### 第 7 步：验证

```bash
tar tzf release/matrix-docker-v0.2.0-linux-x86_64.tar.gz
```

预期输出结构：
```
matrix-docker-v0.2.0-linux-x86_64/
matrix-docker-v0.2.0-linux-x86_64/nginx.conf
matrix-docker-v0.2.0-linux-x86_64/docker-compose.yml
matrix-docker-v0.2.0-linux-x86_64/install.sh
matrix-docker-v0.2.0-linux-x86_64/.env.example
matrix-docker-v0.2.0-linux-x86_64/smb.conf
matrix-docker-v0.2.0-linux-x86_64/README.md
matrix-docker-v0.2.0-linux-x86_64/Dockerfile.samba
matrix-docker-v0.2.0-linux-x86_64/images/
matrix-docker-v0.2.0-linux-x86_64/images/matrix-agent-0.2.0.tar.gz
matrix-docker-v0.2.0-linux-x86_64/images/matrix-samba-0.2.0.tar.gz
matrix-docker-v0.2.0-linux-x86_64/images/nginx-1.27-alpine.tar.gz
```

---

## （可选）第 8 步：打包外部工具

如果需要同时打包外部工具（Joern、Z3、JDK 等），需先修改 `scripts/download-tools.sh` 中的架构为 x86_64：

| 工具 | aarch64 资源名 | x86_64 资源名 |
|------|---------------|---------------|
| Z3 | `z3-4.13.4-arm64-glibc-2.34.zip` | `z3-4.13.4-x64-glibc-2.35.zip` |
| JDK | `.../linux/aarch64/jre/...` | `.../linux/x64/jre/...` |
| Joern | 平台无关（Java） | 平台无关（Java） |

修改完后：
```bash
bash scripts/download-tools.sh
bash scripts/pack-tools.sh
```

或者直接把工具内嵌到 Docker 包中：
```bash
bash scripts/pack-docker.sh --skip-build --include-tools
```

---

## 关键注意事项

1. **所有二进制必须是 x86_64 架构**：`tools-archive/runtime/linux/` 下的 `bun`、`opencode`、`rg` 以及 `bin/` 下的 `mdbook`、`sg` 都必须是 x86_64 版本。`bun install`（postinstall）会自动处理 `bin/` 下的文件，但 `tools-archive/` 需要手动准备。

2. **Dockerfile 和 manager.ts 无需修改**：当前代码是架构无关的，Docker 基础镜像（`oven/bun:1-debian`、`debian:bookworm-slim`）会自动拉取匹配宿主机架构的版本。

3. **Bun 和 OpenCode 版本必须与 aarch64 一致**：避免行为差异。

4. **pack-docker.sh 包名**：脚本中硬编码了 `aarch64`，在 x86_64 机器上需要修改为 `x86_64` 或打包后重命名。

5. **目标部署机器内核要求**：Bun 依赖 `io_uring`，需要 Linux 内核 >= 5.1。Ubuntu 22.04 默认内核为 5.15，满足要求。
