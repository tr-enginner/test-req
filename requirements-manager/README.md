# Matrix 测试需求管理工具

面向测试需求生成与评审的一体化管理工具。系统支持上传 DOCX 源文档、调用 OpenCode 执行 Matrix Phase 2、实时查看生成进度、在线预览源文档、维护双向追溯关系、完成内容质量评估并导出评审结果。

## 功能概览

- 本地账号登录、管理员密码修改和角色权限控制。
- 通过 ZIP 压缩包新建项目，压缩包内仅允许包含 DOCX 源文档。
- 调用 OpenCode `/matrix-phase2` 生成第三方测试需求。
- 实时显示阶段进度、章节状态和结构化运行日志。
- 使用 `docx-preview` 在线预览 DOCX，并通过 OOXML 解析生成文档目录。
- 查看源文档章节与第三方测试需求之间的双向追溯关系。
- 按章节或功能叶子进行内容质量评估。
- 下载第三方测试需求 DOCX，导出测试需求评审报告。
- 管理员可编辑 OpenCode JSON 配置并自动重启 OpenCode 服务。

## 系统架构

| 组件 | 技术 | 默认端口 | 作用 |
| --- | --- | ---: | --- |
| Web | React、TypeScript、Vite、Ant Design、Nginx | `8080`（开发Compose）/`8089`（ARM离线） | 项目管理、生成进度、文档预览、评审及API统一入口 |
| API | NestJS、Fastify、Prisma | `3000` | 认证、项目、评审、追溯、下载和系统设置接口 |
| Worker | Node.js、BullMQ、OpenCode SDK | 无 | Phase 2任务执行、事件处理和DOCX结构索引 |
| OpenCode | OpenCode Server + Matrix插件 | 容器内`4096` | 执行 `/matrix-phase2` |
| PostgreSQL | PostgreSQL 16 | `5432` | 项目、任务、评审、目录和追溯数据 |
| Redis | Redis 7 | 仅容器网络 | BullMQ任务队列 |
| MinIO | MinIO | 控制台`9001` | 项目文件对象存储 |

## 目录结构

```text
requirements-manager/
├── apps/
│   ├── api/                 # NestJS API、Prisma模型和模板
│   ├── web/                 # React前端
│   └── worker/              # Phase 2任务和DOCX索引Worker
├── docker/
│   ├── app.Dockerfile       # API、Web、Worker多阶段镜像
│   ├── opencode.Dockerfile  # OpenCode与Matrix插件镜像
│   └── opencode-entrypoint.sh
├── docker-compose.yml
├── .env.example
└── package.json
```

## 环境要求

推荐使用 Docker Compose 部署，避免本机分别配置 PostgreSQL、Redis、MinIO、OpenCode 和共享项目目录。

- Docker Desktop或Docker Engine 24+
- Docker Compose v2
- 至少8 GB可用内存，推荐16 GB
- 首次构建时能够访问Docker Hub和npm仓库
- 本地执行Node.js命令时需要Node.js 22+、npm 10+

## 快速启动

### 1. 准备环境变量

PowerShell：

```powershell
Copy-Item .env.example .env
```

Bash：

```bash
cp .env.example .env
```

至少修改以下配置：

```dotenv
JWT_SECRET=请替换为至少32字符的随机字符串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请替换为强密码
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=请替换为强密码
MINIO_SECRET_KEY=请替换为强密码
DEEPSEEK_API_KEY=你的DeepSeek密钥
```

不要提交 `.env`。该文件已被Git忽略，但仍应确认其中不包含可公开的密钥。

### 2. 构建并启动全部服务

```bash
docker compose up --build -d
```

首次启动时API容器会自动执行Prisma迁移并创建管理员账号，无需手动运行种子脚本。

### 3. 检查服务状态

```bash
docker compose ps
docker compose logs --tail=100 api worker opencode
```

所有核心服务应显示为 `Up`。随后访问：

- 管理界面：<http://localhost:8080>
- API：<http://localhost:3000/api>
- MinIO控制台：<http://localhost:9001>

使用 `.env` 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。

## Docker组件构建与部署

生产镜像中的Web由Nginx提供静态页面，并将同源 `/api/` 请求代理到API服务。开发Compose仍保留API、PostgreSQL和MinIO调试端口；ARM离线Compose只向宿主机发布Web的 `8089` 端口。

### 构建全部或单个组件

```bash
docker compose build
docker compose build web
docker compose build api
docker compose build worker
docker compose build opencode
```

### 更新组件

修改代码后，应重新构建镜像并通过Compose替换容器，不要使用 `docker cp`：

```bash
docker compose build api web
docker compose up -d api web

docker compose build worker opencode
docker compose up -d worker opencode
```

### 使用网络代理构建

PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7897"
$env:HTTPS_PROXY = "http://127.0.0.1:7897"

docker compose build `
  --build-arg HTTP_PROXY=http://host.docker.internal:7897 `
  --build-arg HTTPS_PROXY=http://host.docker.internal:7897
```

Bash：

```bash
export http_proxy=http://127.0.0.1:7897
export https_proxy=http://127.0.0.1:7897
export all_proxy=socks5://127.0.0.1:7897

docker compose build \
  --build-arg HTTP_PROXY=http://host.docker.internal:7897 \
  --build-arg HTTPS_PROXY=http://host.docker.internal:7897
```

### 日志与服务管理

```bash
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f opencode
docker compose logs -f web

# 停止但保留数据
docker compose down

# 删除容器及全部卷数据
docker compose down -v
```

> `down -v` 会删除数据库、项目文件和OpenCode配置，无法恢复。

## 本地开发

### 安装、构建与测试

```bash
npm install
npm run db:generate

npm --workspace @matrix/api run build
npm --workspace @matrix/worker run build
npm --workspace @matrix/web run build

# 构建全部工作区
npm run build

# 运行全部测试
npm test

# 运行单个测试文件
npx vitest run apps/api/src/archive.test.ts
```

### 前端热更新

推荐让API及基础设施运行在Docker中，只在宿主机启动Vite：

```bash
docker compose up -d postgres redis minio opencode api worker
npm run dev:web
```

访问 <http://localhost:5173>。Vite会将 `/api` 代理到本机的 `3000` 端口。

### API与Worker开发

API和Worker依赖PostgreSQL、Redis、OpenCode及同一份项目目录。本地启动前需要将容器主机名改为宿主机可访问地址：

```dotenv
DATABASE_URL=postgresql://matrix:matrix@localhost:5432/matrix_requirements
REDIS_URL=redis://localhost:6379
OPENCODE_URL=http://localhost:4096
PROJECTS_ROOT=D:/your-local-projects
WEB_ORIGIN=http://localhost:5173
```

默认Compose没有向宿主机暴露Redis和OpenCode端口，因此完整API/Worker联调推荐在容器内进行。仅编译和单元测试时不需要启动全部服务。

## ARM64离线部署

项目支持在x86开发机上交叉构建Linux ARM64离线部署包。打包机需要Docker Buildx并可访问Docker Hub、GHCR、npm和GitHub；目标服务器只需要Docker Engine，不需要网络或预装Compose。

开发和离线构建统一使用Coollabs第三方镜像 `ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z`，
固定版本而非 `latest`。开发环境首次切换时，先备份MinIO数据卷，再执行
`docker compose pull minio` 和 `docker compose up -d minio`；保留原数据卷，勿使用 `down -v`。
离线部署继续使用 `requirements-manager-minio:arm64` 本地标签，已有服务器先备份，再按现有离线升级流程操作。

### 1. 在x86开发机生成离线包

在PowerShell中执行：

```powershell
cd requirements-manager
./scripts/build-arm64-offline.ps1
```

首次切换使用上述完整构建命令。后续本地第三方镜像齐全且MinIO版本正确时，可执行
`./scripts/build-arm64-offline.ps1 -ReuseLocalThirdPartyImages`，仍会构建最新应用代码。
脚本会拒绝复用旧版MinIO。`-SkipBuild` 仅适用于应用镜像已构建且代码未变的继续打包场景，
更新代码后不要使用它。

如需使用代理，先为当前终端设置代理环境变量，Docker Desktop也需要配置可访问的构建代理：

```powershell
./scripts/build-arm64-offline.ps1 -HostProxyUrl "http://127.0.0.1:7897"
```

脚本会把按版本下载的ARM64 Docker Compose二进制缓存到 `release/download-cache/`。后续使用相同
`ComposeVersion` 构建时直接复用缓存，不再重复访问GitHub；切换版本会自动使用新的缓存文件。如需
忽略现有缓存并重新下载，可执行：

```powershell
./scripts/build-arm64-offline.ps1 -RefreshDownloads
```

可通过 `-DownloadCacheDirectory` 指定其他持久缓存目录；相对路径以仓库目录为基准，也可传入绝对路径。

脚本会同时生成目录 `release/requirements-manager-arm64-offline/` 和可直接交付的 `release/requirements-manager-arm64-offline.tar.gz`，其中包含ARM64镜像归档、Compose二进制、校验文件和服务器脚本。

### 2. 在ARM64离线服务器安装

```bash
tar -xf requirements-manager-arm64-offline.tar.gz
cd requirements-manager-arm64-offline
chmod +x install.sh
./install.sh
```

编辑 `.env`，将 `WEB_ORIGIN` 设置为服务器实际地址和端口，例如 `http://192.168.1.100:8089`，并替换全部默认密码。随后配置内网模型并启动：

```bash
vi .env
vi data/opencode-config/opencode.json
./start.sh
./status.sh
```

浏览器访问 `http://服务器IP:8089`。ARM离线配置只发布 `8089:80`，API、PostgreSQL、Redis、MinIO和OpenCode不映射宿主机端口。

### 3. 离线服务运维

```bash
./logs.sh             # 所有实时日志
./logs.sh worker      # Worker日志
./logs.sh opencode    # OpenCode与模型调用日志
./stop.sh             # 停止并保留数据
./start.sh            # 重新启动
```

部署数据保存在离线包目录下的 `data/`。详细说明见离线包中的 `README-OFFLINE.md`。

### 需求版本历史冲突修复

若变更分析接口报告 `RequirementRevision_projectId_sequence_key` 或 Prisma `P2002`，先停止 Worker，备份数据库和项目卷，再对目标项目执行只读检查：

```bash
docker compose stop worker
docker compose run --rm worker npm --workspace @matrix/worker run repair:requirement-history -- <projectId>
```

确认输出显示项目为“单个 `PUBLISHED V1` 且无基线”，且编辑回滚备份与版本快照完整后，显式执行修复：

```bash
docker compose run --rm worker npm --workspace @matrix/worker run repair:requirement-history -- <projectId> --apply
docker compose start worker
```

工具会把编辑前备份重建为迁移基线 V1、将当前编辑结果规范化为 V2，并输出安全备份目录。前置检查失败时不会修改数据；执行中失败会尝试自动回滚。若提示回滚失败，应保持服务停止并从安全备份恢复。

### 4. 一键升级且保留服务器数据

将新版离线包解压到独立目录，不要覆盖旧部署目录，然后从新版目录运行：

```bash
./upgrade.sh /opt/requirements-manager-arm64-offline
```

升级脚本会在数据库迁移前自动生成PostgreSQL逻辑备份和完整持久化数据归档，保留旧部署的 `data/`、`.env` 与OpenCode配置，再导入镜像并启动、检查全部核心服务。备份默认位于旧部署目录同级的 `requirements-manager-backups/时间戳/`。完整升级、验收和回滚说明见离线包中的 `README-OFFLINE.md`。

```bash
npm run dev:api
npm run dev:worker
npm run dev:web

# 或并行启动
npm run dev
```

## 使用说明

### 1. 新建项目

1. 登录后点击“新建项目”。
2. 输入项目名称。
3. 上传ZIP源文档包。
4. 点击确认，系统完成解压、DOCX校验和目录解析。

ZIP规则：

- 至少包含一个 `.docx` 文件。
- 可以包含目录。
- 所有普通文件必须为 `.docx`，扩展名不区分大小写。
- 禁止 `.doc`、`.pdf`、图片、`.matrix`、隐藏系统文件和其他格式。
- 系统会阻止Zip Slip、符号链接逃逸、超限文件和压缩炸弹。

新项目统一进入 `PENDING_GENERATION`，不会复用压缩包中的历史 `.matrix` 数据。

### 2. 生成测试需求

1. 进入项目详情页。
2. 点击“开始生成测试需求”。
3. 页面通过SSE实时显示队列、OpenCode会话、prepare/finalize阶段、章节状态和错误。
4. 如需停止任务，点击“终止生成”。
5. 全部必需工件有效后，项目进入 `READY_FOR_REVIEW`。

完成状态不仅依赖OpenCode会话结束，还会校验对应最终JSON以及 `.matrix/reports/phase2-test-requirements.docx` 是否实际存在。

### 3. 评审测试需求

评审页主要分为：

- 左侧：源DOCX在线预览。
- 右侧：按Phase 2最终文档格式渲染的第三方测试需求。

将鼠标移到两侧边缘可打开对应目录。目录支持章节定位、展开折叠和追溯关系查看。点击追溯来源可切换源文档并定位章节；点击源章节关联项可跳转到测试需求章节或TR。

内容质量评分公式：

```text
综合分 = 准确性 × 40% + 覆盖性 × 35% + 可测试性 × 25%
```

Reviewer可以填写修改建议。评分按可评估章节独立保存，不对父标题或单个处理TR重复评分。

### 4. 下载与导出

- “下载第三方测试需求”：下载项目生成的Phase 2 DOCX。
- “导出评审报告”：全部可评估节点完成评审后才可导出；缺失时页面会列出未评审章节。

### 5. 系统设置

管理员可在项目列表右上角打开“设置”。

#### 修改密码

输入当前密码和新密码。修改成功后所有刷新令牌会被撤销，当前会话退出，需要使用新密码重新登录。

#### OpenCode配置

可以直接编辑共享卷中的 `opencode.json`，用于修改Provider、模型及其配置。保存时系统会：

1. 校验内容为合法JSON对象。
2. 自动保留Matrix插件 `file:///plugin/dist/index.js`。
3. 拒绝在Phase 2任务排队或运行期间保存。
4. 原子写入配置并自动重启OpenCode子进程。
5. 等待OpenCode健康恢复后返回成功。

配置中可能包含明文API Key，仅管理员可访问；不要将密钥复制到日志、截图或Git仓库。

## 关键环境变量

| 变量 | 说明 | 示例/默认值 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL连接串 | `postgresql://matrix:matrix@postgres:5432/matrix_requirements` |
| `REDIS_URL` | Redis连接串 | `redis://redis:6379` |
| `MINIO_ENDPOINT` | MinIO API地址 | `http://minio:9000` |
| `MINIO_ACCESS_KEY` | MinIO账号 | `matrix` |
| `MINIO_SECRET_KEY` | MinIO密码 | 必须修改 |
| `JWT_SECRET` | 登录令牌签名密钥 | 至少32字符 |
| `ADMIN_USERNAME` | 初始管理员名 | `admin` |
| `ADMIN_PASSWORD` | 初始管理员密码 | 必须修改 |
| `OPENCODE_URL` | OpenCode服务地址 | `http://opencode:4096` |
| `OPENCODE_USERNAME` | OpenCode Basic Auth账号 | `opencode` |
| `OPENCODE_PASSWORD` | OpenCode Basic Auth密码 | 必须修改 |
| `PROJECTS_ROOT` | 项目共享目录 | `/data/projects` |
| `WEB_ORIGIN` | 允许携带Cookie的前端来源 | `http://localhost:5173` |
| `COOKIE_SECURE` | 是否仅通过HTTPS发送登录Cookie；HTTP部署必须为`false` | `false` |
| `PHASE2_CONCURRENCY` | Worker并发任务数 | `2` |
| `MAX_ARCHIVE_BYTES` | ZIP上传大小上限 | `1073741824` |
| `MAX_EXTRACTED_BYTES` | 解压后总大小上限 | `5368709120` |
| `MAX_ARCHIVE_FILES` | ZIP文件数量上限 | `10000` |
| `DEEPSEEK_API_KEY` | 默认DeepSeek模型密钥 | 无默认值 |

## 数据卷

| 卷 | 内容 |
| --- | --- |
| `postgres-data` | 数据库数据 |
| `redis-data` | 队列数据 |
| `minio-data` | MinIO对象数据 |
| `projects` | 源文档和项目 `.matrix` 工件 |
| `opencode-config` | OpenCode运行配置和重启信号 |

## 常见问题

### 页面无法访问

```bash
docker compose ps
docker compose logs --tail=100 web api
```

确认 `web` 映射了 `8080:80`，并访问 <http://localhost:8080>。

### 登录失败

- 首次启动确认API日志中出现“管理员已创建”。
- 使用 `.env` 中的管理员账号密码。
- 如果已通过设置修改密码，应使用修改后的密码，而不是 `.env` 旧值。

### 项目生成一直没有进度

```bash
docker compose logs -f worker opencode
```

重点检查OpenCode是否监听 `4096`、Provider密钥是否有效、Worker与OpenCode认证是否一致，以及是否存在旧任务。

### OpenCode配置保存失败

- 有 `QUEUED` 或 `RUNNING` 的Phase 2任务时，必须先终止任务。
- JSON必须是对象，不能是数组或纯文本。
- 查看 `docker compose logs -f opencode api` 获取重启错误。

### Docker Hub或npm连接失败

按“使用网络代理构建”配置宿主机代理和Docker构建参数。容器访问宿主机代理时应使用 `host.docker.internal`，而不是 `127.0.0.1`。

### MinIO容器未启动

```bash
docker compose logs --tail=100 minio
docker compose up -d minio
```

确认MinIO密码满足要求，并检查 `9001` 端口是否被占用。

## 安全建议

- 首次启动后立即修改管理员、MinIO和OpenCode密码。
- 使用随机且足够长的 `JWT_SECRET`。
- 不要提交 `.env`、OpenCode配置卷或项目源文档。
- 生产环境不要直接暴露PostgreSQL、MinIO控制台和API端口，应通过反向代理和访问控制发布服务。
- 定期备份 `postgres-data`、`projects`、`minio-data` 和 `opencode-config`。
