# Matrix Agent x86_64 离线部署手册

## 概述

Matrix Agent 是一个基于 LLM 的嵌入式软件测试多智能体系统，支持 GJB 5000A、DO-178C、IEC 61508 等标准的全流程自动化测试。

本手册指导在 **无互联网环境**（air-gapped）的 **x86_64 Ubuntu 22.04** 服务器上完成完整部署。

## 离线部署包清单

| 包名称 | 大小 | 说明 |
|--------|------|------|
| `matrix-docker-v0.2.0-linux-x86_64.tar.gz` | ~1.6 GB | Docker 镜像 + 编排配置 + 安装脚本 |
| `matrix-tools-v0.2.0-linux-x86_64.tar.gz` | ~4.2 GB | 5 款外部测试工具 |

> **注意**：工具包只需部署一次，Docker 包可随版本迭代更新。

---

## 一、系统要求

| 项目 | 最低要求 | 推荐配置 |
|------|---------|---------|
| 操作系统 | Ubuntu 22.04 LTS (x86_64) | — |
| Docker | >= 20.10（含 Docker Compose V2） | >= 24.0 |
| CPU | 4 核 | 8 核+ |
| 内存 | 8 GB | 16 GB+ |
| 磁盘 | 20 GB 可用 | 50 GB+ |
| LLM API | 支持 Function Calling 的大模型 API | Qwen2.5-72B / DeepSeek-V3 / Kimi |

### 检查 Docker 是否安装

```bash
docker --version
docker compose version
```

如未安装，参考 [Docker 官方文档](https://docs.docker.com/engine/install/ubuntu/) 离线安装。

---

## 二、工具离线包部署

### 2.1 解压

```bash
tar xzf matrix-tools-v0.2.0-linux-x86_64.tar.gz
cd matrix-tools-v0.2.0-linux-x86_64/
```

### 2.2 包含工具

| 工具 | 目录 | 用途 | 环境变量 |
|------|------|------|---------|
| SpecChecker | `specchecker/` | MISRA/GJB 编码规范静态检查 | `SPECCHECKER_HOME` |
| SunwiseAUnit | `aunit/` | 单元测试框架 | `AUNIT_HOME` |
| Joern CLI | `joern-cli/` | 代码属性图 (CPG) 分析框架 | `JOERN_HOME` |
| Z3 | `z3/` | SMT 求解器（原子性违规验证） | `Z3_HOME` |
| Eclipse Temurin JRE 21 | `jdk/` | Java 运行环境（Joern 依赖） | `JAVA_HOME` |

### 2.3 一键部署

```bash
sudo bash deploy-tools.sh
```

默认部署到 `/data/matrix-tools`。自定义路径：

```bash
sudo bash deploy-tools.sh --target /opt/my-tools
```

### 2.4 验证部署

```bash
# Java
/data/matrix-tools/jdk/bin/java -version

# Z3
/data/matrix-tools/z3/bin/z3 --version

# Joern（依赖 Java）
export JAVA_HOME=/data/matrix-tools/jdk
export PATH=$JAVA_HOME/bin:$PATH
/data/matrix-tools/joern-cli/bin/joern-parse --help

# SpecChecker（检查目录结构）
ls /data/matrix-tools/specchecker/config/

# AUnit（检查可执行文件）
ls /data/matrix-tools/aunit/AUnitBuildLinux.sh
```

### 2.5 环境变量自动注入

部署完成后，Matrix Docker 容器内的每个 OpenCode 实例会自动获得以下环境变量：

```
SPECCHECKER_HOME=/opt/matrix/tools/specchecker
AUNIT_HOME=/opt/matrix/tools/aunit
JOERN_HOME=/opt/matrix/tools/joern-cli
Z3_HOME=/opt/matrix/tools/z3
JAVA_HOME=/opt/matrix/tools/jdk
PATH=/opt/matrix/tools/joern-cli/bin:/opt/matrix/tools/z3/bin:/opt/matrix/tools/jdk/bin:...
```

> 工具目录通过 Docker Volume 以只读方式挂载到容器内 `/opt/matrix/tools/`。Manager 启动 OpenCode 实例时自动扫描该目录并注入环境变量，无需手动配置。

---

## 三、Docker 离线包部署

### 3.1 解压

```bash
tar xzf matrix-docker-v0.2.0-linux-x86_64.tar.gz
cd matrix-docker-v0.2.0-linux-x86_64/
```

### 3.2 包含内容

```
matrix-docker-v0.2.0-linux-x86_64/
├── images/                          # Docker 镜像
│   ├── matrix-agent-0.2.0.tar.gz   # 主镜像（Manager + OpenCode + Plugin + Docling）
│   ├── matrix-samba-0.2.0.tar.gz   # Samba 文件共享镜像
│   └── nginx-1.27-alpine.tar.gz    # Nginx 反向代理镜像
├── docker-compose.yml               # Docker Compose 编排
├── nginx.conf                       # Nginx 反向代理配置
├── .env.example                     # 环境变量模板
├── Dockerfile.samba                 # Samba 构建文件
├── smb.conf                         # Samba 配置
├── install.sh                       # 一键安装脚本
└── README.md                        # 部署说明
```

### 3.3 一键安装

```bash
sudo bash install.sh
```

该脚本会自动完成：
1. 导入 3 个 Docker 镜像
2. 创建部署目录 `/opt/matrix-docker`、数据目录 `/data/matrix-projects`
3. 复制配置文件到部署目录
4. 生成 `.env` 配置模板

自定义路径：

```bash
sudo bash install.sh \
  --deploy-dir /opt/matrix-docker \
  --data-dir /data/matrix-projects \
  --tools-dir /data/matrix-tools
```

### 3.4 配置 LLM（必须）

```bash
sudo vi /opt/matrix-docker/.env
```

必须配置以下三项：

```ini
# LLM API 地址（必填）
LLM_BASE_URL=http://your-llm-api:8080/v1

# 模型名称（必填）
LLM_MODEL=qwen2.5-72b-instruct

# API Key（如有）
LLM_API_KEY=your-api-key
```

### 3.5 环境变量完整说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_BASE_URL` | LLM API 地址（必填） | — |
| `LLM_MODEL` | 模型名称（必填） | — |
| `LLM_API_KEY` | API Key（可选） | — |
| `MATRIX_VERSION` | 镜像版本号 | `0.2.0` |
| `MATRIX_DATA_DIR` | 项目数据存储路径 | `/data/matrix-projects` |
| `MATRIX_TOOLS_DIR` | 外部工具路径 | `/data/matrix-tools` |
| `NGINX_PORT` | Web 管理门户端口 | `80` |
| `SAMBA_PORT` | Samba 文件共享端口 | `445` |
| `INSTANCE_PORT_RANGE` | OpenCode 实例端口范围 | `5101-5200` |
| `COMPOSE_PROJECT_NAME` | Docker Compose 项目名 | `matrix` |

### 3.6 启动服务

```bash
cd /opt/matrix-docker
sudo docker compose up -d
```

### 3.7 验证启动

```bash
# 查看服务状态
docker compose ps

# 应看到 3 个服务：
# matrix-nginx    — Running
# matrix-manager  — Running
# matrix-samba    — Running

# 查看 Manager 日志
docker compose logs -f manager
```

---

## 四、使用指南

### 4.1 访问管理门户

浏览器打开 `http://<服务器IP>:<NGINX_PORT>`（默认端口 80）

**默认管理员账户**：
- 用户名：`admin`
- 密码：`123456`

> **安全提醒**：首次登录后，请立即在管理员面板创建新的管理员账户或修改密码。

### 4.2 管理员功能

登录后点击导航栏"管理"进入管理员面板：

- **创建用户**：为团队成员创建账户（普通用户只能管理自己的项目）
- **删除用户**：移除不需要的账户
- **删除项目**：管理员可删除任意用户的项目

### 4.3 项目工作流

1. **创建项目**：在项目列表页填写项目名称，点击"创建"
2. **上传代码**：
   - 通过 Samba 共享文件夹上传源代码（`\\<服务器IP>\matrix-projects\<用户名>\<项目名>\`）
   - 或在管理门户上传 zip/tar.gz 压缩包
3. **启动实例**：点击项目的"启动"按钮
4. **打开 OpenCode**：点击"打开"按钮直接进入 OpenCode Web 界面（无需二次登录）
5. **执行测试**：在 OpenCode 中使用 `/matrix-start` 启动全流程测试
6. **下载报告**：测试完成后，点击"下载报告"获取 `.matrix/reports/` 下的测试报告

### 4.4 Samba 文件共享配置

首次使用 Samba 需创建共享用户：

```bash
docker exec -it matrix-samba bash
groupadd matrix
useradd -g matrix -s /sbin/nologin myuser
smbpasswd -a myuser
# 输入密码两次
exit
```

Windows 连接：`\\<服务器IP>\matrix-projects`

---

## 五、架构说明

```
┌──────────────────────────────────────────────────────────────────┐
│                     Nginx (端口 80 + 5101-5200)                  │
│  ┌───────────────────┐  ┌──────────────────────────────────────┐ │
│  │ / → Manager (3000) │  │ :5101 → OpenCode 实例 1 (用户A/项目1) │ │
│  │   (项目管理/认证)   │  │ :5102 → OpenCode 实例 2 (用户B/项目2) │ │
│  └─────────┬─────────┘  │ ...                                   │ │
│            │             └────────────────┬─────────────────────┘ │
└────────────┼──────────────────────────────┼──────────────────────┘
             │                              │
   ┌─────────▼──────────┐     ┌─────────────▼────────────────┐
   │  matrix-manager     │     │  opencode-<user>-<project>   │
   │  ┌────────────────┐ │     │  ┌────────────────────────┐  │
   │  │ 用户认证       │ │     │  │ OpenCode Web IDE       │  │
   │  │ 项目管理       │ │◄────│  │ + Matrix Agent Plugin  │  │
   │  │ 实例编排       │ │     │  │ + docling (文档解析)   │  │
   │  │ Nginx 配置生成 │ │     │  │ + 21 个测试智能体     │  │
   │  └────────────────┘ │     │  └────────────────────────┘  │
   └─────────┬──────────┘     └──────────┬───────────────────┘
             │                           │
   ┌─────────▼───────────────────────────▼───────────────────┐
   │              Docker Volumes (持久化存储)                   │
   │  ┌─────────────────────────┐  ┌──────────────────────┐  │
   │  │ matrix-projects (rw)    │  │ matrix-tools (ro)    │  │
   │  │ /data/matrix-projects/  │  │ /data/matrix-tools/  │  │
   │  │ ├── userA/project1/     │  │ ├── specchecker/     │  │
   │  │ │   ├── src/            │  │ ├── aunit/           │  │
   │  │ │   └── .matrix/        │  │ ├── joern-cli/       │  │
   │  │ └── userB/project2/     │  │ ├── z3/              │  │
   │  │     └── ...             │  │ └── jdk/             │  │
   │  └─────────────────────────┘  └──────────────────────┘  │
   └─────────────────────────────────────────────────────────┘
```

---

## 六、服务管理

```bash
cd /opt/matrix-docker

# 启动
docker compose up -d

# 停止
docker compose down

# 重启
docker compose restart

# 查看日志
docker compose logs -f manager
docker compose logs -f nginx

# 查看所有容器（含 OpenCode 实例）
docker ps

# 重载 Nginx 配置
docker kill -s SIGHUP matrix-nginx
```

---

## 七、版本更新

当有新版本的 Docker 离线包时：

```bash
cd /opt/matrix-docker

# 1. 停止服务
docker compose down

# 2. 解压新版本
tar xzf matrix-docker-v<NEW_VERSION>-linux-x86_64.tar.gz
cd matrix-docker-v<NEW_VERSION>-linux-x86_64/

# 3. 导入新镜像
for img in images/*.tar.gz; do docker load -i "$img"; done

# 4. 更新配置文件（保留 .env）
cp docker-compose.yml nginx.conf Dockerfile.samba smb.conf /opt/matrix-docker/

# 5. 更新 .env 中的版本号
sed -i 's/^MATRIX_VERSION=.*/MATRIX_VERSION=<NEW_VERSION>/' /opt/matrix-docker/.env

# 6. 重新启动
cd /opt/matrix-docker && docker compose up -d
```

> 项目数据和工具目录不受版本更新影响。

---

## 八、故障排查

### 8.1 Manager 无法启动

```bash
docker compose logs manager
```

常见原因：
- `.env` 中 `LLM_BASE_URL` 或 `LLM_MODEL` 为空
- Docker socket 权限不足：`ls -la /var/run/docker.sock`

### 8.2 OpenCode 实例无法启动

```bash
# 查看 Manager 日志
docker logs matrix-manager | tail -20

# 检查镜像是否存在
docker images | grep matrix-agent
```

### 8.3 工具不可用

```bash
# 检查工具卷是否挂载
docker exec <opencode-container> ls /opt/matrix/tools/

# 检查环境变量
docker exec <opencode-container> env | grep -E 'HOME|Z3|JOERN|SPEC|AUNIT'
```

### 8.4 Nginx 502 Bad Gateway

```bash
# 检查 OpenCode 实例是否运行
docker ps | grep opencode

# 重载 Nginx
docker kill -s SIGHUP matrix-nginx
```

### 8.5 端口冲突

编辑 `/opt/matrix-docker/.env` 修改端口，然后重启：

```bash
docker compose down && docker compose up -d
```

### 8.6 磁盘空间不足

```bash
# 查看磁盘使用
df -h

# 清理已停止的 OpenCode 实例容器
docker container prune

# 清理未使用的镜像
docker image prune
```

---

## 九、安全建议

1. **修改默认密码**：首次登录后立即修改 `admin` 账户密码或创建新管理员
2. **防火墙**：仅开放必要端口（80/443, 445, 5101-5200）
3. **LLM API Key**：确保 `.env` 文件权限为 600（`chmod 600 .env`）
4. **定期备份**：备份 `/data/matrix-projects` 和 `/opt/matrix-docker/.env`
