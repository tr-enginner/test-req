# Phase 2 在线编辑与确定性重建

Phase 2 编辑器直接修改项目 `.matrix/data/*.raw.json`，随后调用 Matrix runner 的确定性 finalize，整个过程不会创建 OpenCode session，也不会请求模型。

## 服务

OpenCode 容器入口会同时启动：

- OpenCode：`4096`
- 基于 Node.js 22 的 Matrix deterministic runner：`4097`（仅容器网络内部使用）

API 和 worker 使用 `MATRIX_PHASE2_RUNNER_URL=http://opencode:4097`。runner 使用与 OpenCode 相同的 Basic Auth，并拒绝 `/data/projects` 之外的目录以及非白名单 workflow mode。

升级后必须重新构建 `matrix-opencode`、`api`、`worker`、`web` 镜像，并执行 Prisma migration：

```bash
docker compose build opencode api worker web
docker compose run --rm api npm run db:migrate
docker compose up -d
```

ARM64 离线包需包含 Matrix 的 `dist/index.js` 和 `dist/direct-phase2-runner.js`。
runner 不再依赖目标机上的 Bun JavaScript 运行时，因此支持 ARM64 64 KB 页内核。镜像构建仍可使用 Bun 作为构建工具，但发布门禁必须使用 Node 启动 runner 并通过 `4097/health` 检查。

## 数据安全

每次编辑前，worker 将 `.matrix/data` 和 `.matrix/reports` 备份到：

```text
.matrix/history/rollback/<runId>/
```

重建失败时恢复文件并重新建立数据库索引。成功发布的不可变版本保存到 `.matrix/history/revisions/<revisionId>/`。成功前项目状态为 `REBUILDING`，界面禁止再次编辑、评审和下载。TR 删除仅从当前索引移除，历史 Review/AuditLog 不物理删除；编号写入 tombstone，后续不复用。

## 故障排查

```bash
curl -u "$OPENCODE_USERNAME:$OPENCODE_PASSWORD" http://opencode:4097/health
docker compose logs -f opencode worker api
```

如果 runner 异常退出，opencode 容器会以非零状态退出并由 Docker 重启，避免只有 OpenCode 4096 存活而 4097 不可用的假健康状态。

`Phase2EditRun.errorMessage` 记录失败阶段；`backupPath` 指向可人工恢复的备份。
