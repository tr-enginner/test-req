# AGENTS.md

本文件为在 requirements-manager 工程内工作的编码代理提供指导。以下路径除特别说明外均相对于本目录。详细架构见 [docs/整体架构.md](docs/整体架构.md)。

## 工程定位

requirements-manager 是 Matrix Phase 2 测试需求生成的管理系统，负责项目导入、异步任务、原文预览、需求追踪、人工评审、在线编辑、版本与导出。

- 本目录是独立 Git 仓库；操作前用 `git status` 确认本仓库状态，不将父仓库提交视为本工程提交。
- 本工程使用 **Node.js 22+、npm workspaces、TypeScript、Vitest**。父目录 Matrix 插件使用 Bun，不要直接套用其构建和测试命令。
- 需求语义生成由 OpenCode 加载父目录 Matrix 插件执行。API 和 Worker 负责管理与协调，不自行实现另一套需求生成流程。
- 在线编辑使用独立确定性 runner 重建，不能默认改为重新调用模型。
- 当前实际应用只有 `apps/api`、`apps/worker`、`apps/web`。虽然 package.json 声明 `packages/*`，目前没有该共享包层。

## 开发与验证命令

以下命令在 requirements-manager 目录执行：

```bash
npm ci                         # 按 package-lock.json 安装依赖
npm run db:generate            # 根据 Prisma schema 生成客户端
npm run dev                    # 同时启动 API、Worker、Web 开发进程
npm run dev:api
npm run dev:worker
npm run dev:web
npm run build                  # 构建全部 workspace，包含 TypeScript 检查
npm test                       # 执行各 workspace 的 Vitest 测试

npm --workspace @matrix/api run test
npm --workspace @matrix/worker run test
npm --workspace @matrix/web run test
```

- 当前没有根级 `typecheck` 脚本，类型检查包含在各应用 build 中。
- 本地开发需要可访问的 PostgreSQL、Redis、OpenCode/runner，以及各进程均能访问的项目目录；`npm run dev` 不会启动这些基础设施。
- `npm run db:migrate` 执行的是 `prisma migrate deploy`，会修改所连接数据库；它不是生成新迁移的命令。修改数据模型时须同时提供 Prisma migration，并核查 Worker SQL。
- 先运行与改动相关的测试；涉及跨组件契约时，再执行相关 workspace 测试和完整构建。不要为验证文档修改启动生成任务或改写业务数据。
- 记录验证结果与环境阻塞，不将未执行的测试描述为通过。

## 组件与代码导航

| 组件 | 关键位置 | 职责 |
| --- | --- | --- |
| Web | `apps/web/src/main.tsx`、`ui.tsx`、`api.ts` | 页面、请求、生成监控、评审与编辑交互 |
| 文档和版本界面 | `DocxPreview.tsx`、`Phase2DocumentRenderer.tsx`、`RequirementDiff.tsx` | 原文预览、正式章节展示、版本比较 |
| API 入口 | `apps/api/src/main.ts`、`modules.ts` | NestJS/Fastify 启动、组件注册、全局认证 |
| 项目导入 | `apps/api/src/projects.ts`、`archive.ts` | 上传、安全解压、工作区定位与索引入队 |
| 生成任务 API | `apps/api/src/runs.ts` | 创建、取消、查询与 SSE |
| 查询和评审 | `apps/api/src/traceability.ts`、`phase2-document.ts`、`reviews.ts` | 原文和需求关联、展示模型、人工评审 |
| 编辑 API | `apps/api/src/phase2-edits.ts` | 编辑描述、角色与版本校验、异步编辑任务 |
| 下载和历史 | `apps/api/src/exports.ts`、`documents.ts`、`requirement-revisions.ts` | 文档、评审报告和历史版本访问 |
| 数据模型 | `apps/api/prisma/schema.prisma`、`prisma/migrations/` | 业务实体与数据库迁移 |
| Worker 入口 | `apps/worker/src/index.ts` | 队列消费、OpenCode 生成与恢复协调 |
| 生成支撑 | `opencode-transport.ts`、`session-tasks.ts`、`progress.ts`、`token-usage.ts`、`retry-policy.ts` | 会话、事件、进度、使用量与重试 |
| 数据索引 | `apps/worker/src/indexing.ts` | DOCX 原文、需求节点和追踪关系入库 |
| 编辑执行和版本 | `apps/worker/src/phase2-edit.ts`、`requirement-revisions.ts` | runner 调用、备份、重建、发布及恢复 |
| 部署 | `docker/`、`docker-compose*.yml` | 镜像、反向代理、服务和共享卷 |
| 离线交付 | `scripts/build-arm64-offline.ps1`、`offline/`、`release/` | ARM64 构建、部署说明与交付产物 |

表中 Web、API、Worker 的简写文件名分别位于对应 `apps/<name>/src/`。定位源码用路径与函数/类名，不在维护文档中固定行号。

## 组件交互与执行边界

### 导入和生成

1. Web 通过 `/api` 请求 API，使用登录 Cookie。
2. API 接收 ZIP，安全解压并建立项目工作区；当前导入为 DOCX-only，不接受包内已有 `.matrix`。
3. API 将索引或生成任务送入 BullMQ；Worker 消费 `document-index`、`phase2`、`phase2-edit` 三类队列。
4. 生成 Worker 调用 OpenCode，在共享工作区执行 Matrix Phase 2，采集事件与进度。
5. Worker 将文件产物索引到数据库，生成完成后建立基线并更新项目状态。
6. API 从数据库查询运行事件与状态，通过 SSE 返回浏览器。浏览器不直接连接 Redis 或 OpenCode。

### 在线编辑

API 提交编辑任务，Worker 调用父目录 `src/direct-phase2-runner.ts` 提供的 HTTP 服务，执行修改、章节 finalize、追踪更新、总 DOCX 重建、索引和版本发布。

- 保留 `expected_revision` 和相关工件版本检查，不绕过活动任务及项目状态检查。
- 区分“草稿已保存”与“正式版本已发布”。发布失败时已有编辑稿可能保留，不能统一按未保存处理。
- 保留生成期间编辑的专门分支，其延后分析与发布行为不能直接替换成普通发布流程。
- 修改编辑流程时检查备份、失败恢复、再次索引、发布快照和重试路径。
- 人工评分评审与 Matrix 插件 PASS/REVISE 门禁不同，不自动将两者等同。

## 数据契约与一致性

- API 通过 Prisma 访问 PostgreSQL，Worker 直接使用 `pg` SQL。字段、枚举和关系变更必须检查两端，不只更新 Prisma 类型。
- PostgreSQL 保存业务数据及查询索引；Redis 保存队列调度信息；项目文件保存在共享 projects 目录。
- `.matrix/data` 的 raw 文件、正式章节 JSON/DOCX、数据库索引各有职责，不可当成可互相替代的数据源。
- 评审、审计和版本元数据并非都能从生成 JSON 恢复；不要通过清空数据库修复索引问题。
- `indexProject` 与 `indexAvailableRequirements` 有不同边界：前者可重建原文及需求，后者用于当前可用需求增量索引。保留项目行锁、事务和评审身份迁移处理。
- 需求身份、业务编号、来源引用和版本关联影响追踪、评审与历史。调整编号或重新索引时检查 `entityUid`、`businessId`、`sourceRefs` 及 Review/Revision 的关联。
- 编辑回滚备份在 `.matrix/history/rollback/`，发布快照在 `.matrix/history/revisions/`，两者不可混用。
- 文件写入、数据库事务和 Redis 入队没有统一跨系统事务。变更时检查部分成功、入队失败、恢复失败及重复执行的结果。
- Compose 中有 MinIO，但当前主要文件链路使用共享文件系统；不能仅根据 `Document.objectKey` 名称假定其为 S3 对象键。

## 部署和配置

```bash
docker compose config --quiet  # 校验默认 Compose
docker compose up --build -d  # 构建并启动服务，会运行数据库迁移和 seed
docker compose ps
docker compose logs --tail=100 api worker opencode
```

- 默认 Compose 包含 Web、API、Worker、OpenCode、PostgreSQL、Redis、MinIO。Web 默认主机端口 8080；API 3000；OpenCode 4096 和 runner 4097 在容器网络使用。
- OpenCode 与 runner 同容器、不同进程。修改入口脚本时保留健康检查、runner 退出处理、OpenCode 重启与配置重载协调。
- API、Worker、OpenCode 共享 `/data/projects`；持久化工作区路径依赖各进程一致的挂载路径。
- `opencode-config` 是模型/插件配置共享卷，API 写配置，Worker 只读，OpenCode 入口处理重启请求。
- Nginx `/api/` 代理需要支持 SSE 长连接；修改代理时核查缓冲、超时和事件刷新。
- 离线 ARM64 Compose 与默认 Compose 的镜像、端口及重启策略有差别。修改部署时核查两套配置及 `offline/` 说明。
- 离线交付使用预置镜像与依赖，模型生成仍需已配置的可达模型服务。
- 修改根 Matrix 插件或 runner 后，需要更新 OpenCode 镜像；仅重启 API/Worker 不会更新镜像内插件。

## 编码与安全约定

- 遵循现有 TypeScript strict、ESM 与 NodeNext 配置；API/Worker 相对模块导入沿用项目已有 `.js` 扩展名约定。
- 新 API 组件须检查 `modules.ts` 注册、认证、角色授权、输入验证和项目路径边界。
- 保留上传的路径穿越、符号链接、文件类型、数量及大小检查；不要让输入路径逃逸出项目工作区。
- 用户角色存在不代表所有接口具有完整 RBAC；项目当前也没有完整租户所有权模型。新增敏感接口应明确检查实际授权，不能假定 projectId 本身提供授权。
- 不提交 `.env`、密码、模型密钥、用户上传资料或生成运行数据。配置示例只使用占位值。
- 不手工修改 `node_modules/`、构建产物或离线 release 包代替源码修复。
- 修改任务恢复、历史修复脚本时，先理解读写范围；不要自动对现有业务数据库运行修复脚本。
- UI 和文档采用中文，代码标识、字段和枚举保持既有英文契约。
- 架构事实以源码和部署配置为准；README 与旧文档不一致时核对调用链，不照搬过时描述。

## 相关文档

- [整体架构](docs/整体架构.md)：组件、交互、数据和部署边界。
- [Phase 2 在线编辑](docs/phase2-online-editor.md)：编辑与确定性重建。
- [Matrix Phase 2 架构](../docs/phase2-arch.md)：生成端组件与章节工作流。
- [Phase 2 解析说明](../docs/phase2-parsing.md)：共同来源准备、文档解析和切片。
- [离线部署说明](offline/README-OFFLINE.md)：ARM64 交付与运维。

若改动跨越本工程与父目录 Matrix 插件，分别检查两边的工作区差异和验证结果。未经用户要求不自动提交。
