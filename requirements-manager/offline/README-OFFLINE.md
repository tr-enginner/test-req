# Matrix测试需求管理工具 ARM64 离线部署

## 服务器要求

- Linux ARM64/aarch64
- Docker Engine 24或更高版本
- 至少8GB内存和30GB可用磁盘空间
- 外部防火墙仅需放行TCP `8089`
- 能访问内部模型服务；运行过程不需要访问互联网

## Windows构建机打包

开发和离线包统一使用Coollabs第三方镜像
`ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z`（固定版本，非MinIO官方发布镜像）。
离线部署仍使用本地标签 `requirements-manager-minio:arm64`，服务器不需要访问GHCR。

首次构建或从旧MinIO切换时，在 `requirements-manager` 目录执行：

```powershell
.\scripts\build-arm64-offline.ps1
```

该命令重新构建应用及第三方镜像。后续可以使用下面的复用命令；如果本地MinIO仍是旧版本，
脚本会拒绝打包并提示重新获取。已有部署升级前必须备份数据，从新包目录运行现有
`./upgrade.sh /旧部署目录` 流程，不要删除或覆盖旧数据目录。

### 更新代码后构建离线包（推荐）

如果本地已有三个 `requirements-manager-postgres:arm64`、
`requirements-manager-redis:arm64`、`requirements-manager-minio:arm64` 镜像，可在
`requirements-manager` 目录执行：

```powershell
.\scripts\build-arm64-offline.ps1 -ReuseLocalThirdPartyImages
```

该命令会从当前代码重新构建API、Worker、Web、OpenCode四个应用镜像，再生成离线包，
确保代码更新进入交付镜像。`-ReuseLocalThirdPartyImages` 只复用本地PostgreSQL、Redis、MinIO
第三方镜像，不会跳过应用镜像构建。脚本会检查镜像的ARM64架构，并验证MinIO和mc可运行；
缺失镜像、架构不匹配或MinIO版本不是指定的10月版本会报错。
本地镜像应来自可信来源；Compose二进制已缓存时会自动复用。

### 应用镜像已构建完成后继续打包

仅当四个应用镜像已成功构建，且此后没有修改代码或构建配置时，才可执行：

```powershell
.\scripts\build-arm64-offline.ps1 -SkipBuild -ReuseLocalThirdPartyImages
```

`-SkipBuild` 跳过四个应用镜像的构建，直接将本机已有镜像打包，**不会把新的代码修改
构建进镜像**。修改代码后请使用上面的推荐命令，不要添加 `-SkipBuild`。
仅使用 `-SkipBuild` 仍会构建第三方镜像；是否复用第三方镜像由
`-ReuseLocalThirdPartyImages` 单独控制。

## 安装

```bash
tar -xf requirements-manager-arm64-offline.tar.gz
cd requirements-manager-arm64-offline
chmod +x install.sh
./install.sh
```

安装脚本会校验文件、导入ARM64镜像并创建数据目录。首次执行后必须编辑：

```bash
vi .env
vi data/opencode-config/opencode.json
```

将 `.env` 中所有 `replace-with` 值替换为强密码，并把 `WEB_ORIGIN` 改为服务器实际地址，例如：

```dotenv
WEB_ORIGIN=http://192.168.1.100:8089
COOKIE_SECURE=false
```

离线服务器当前通过HTTP的`8089`端口访问，因此必须保持`COOKIE_SECURE=false`。后续配置HTTPS反向代理后再改为`true`。

在 `opencode.json` 中配置内网Provider、模型和认证方式，并保留：

```json
"plugin": ["file:///plugin/dist/index.js"]
```

## 启动与维护

```bash
./start.sh          # 校验配置并启动
./status.sh         # 查看容器状态
./logs.sh           # 查看全部实时日志
./logs.sh worker    # 仅查看生成任务日志
./stop.sh           # 停止服务并保留数据
```

启动后访问 `http://服务器IP:8089`。API、PostgreSQL、Redis、MinIO和OpenCode均只在容器内部网络通信，不应在防火墙上开放对应端口。

## 数据与备份

全部持久化数据位于部署目录的 `data/`：

- `data/postgres`：账号、项目和评审数据
- `data/redis`：任务队列
- `data/minio`：上传文件和导出工件
- `data/projects`：源文档及Matrix运行工件
- `data/opencode-config`：OpenCode运行配置

备份前建议执行 `./stop.sh`，然后整体备份 `data/` 和 `.env`。

## 一键安全升级

升级脚本必须从**新版本离线包的解压目录**执行，并把当前正在运行的旧部署目录作为参数。不要把新包直接解压覆盖到旧目录。

例如旧版本位于 `/opt/requirements-manager-arm64-offline`：

```bash
mkdir -p /opt/requirements-manager-new
tar -xf requirements-manager-arm64-offline.tar.gz -C /opt/requirements-manager-new
cd /opt/requirements-manager-new/requirements-manager-arm64-offline
chmod +x ./*.sh bin/docker-compose
./upgrade.sh /opt/requirements-manager-arm64-offline
```

脚本会自动完成：

1. 校验新离线包的SHA256。
2. 在旧PostgreSQL仍运行时生成一致的 `pg_dump` 逻辑备份。
3. 导入新版本镜像。
4. 停止旧容器，但不删除数据卷或宿主机数据。
5. 归档旧部署的整个 `data/` 和 `.env`。
6. 仅更新Compose、管理脚本和运行文件，保留旧 `.env`、项目数据和OpenCode配置。
7. 启动新版；API启动时自动执行数据库迁移。
8. 等待PostgreSQL、Redis、MinIO、OpenCode、API、Worker和Web全部进入运行状态。

备份默认写入旧部署目录的同级目录：

```text
/opt/requirements-manager-backups/YYYYMMDD-HHMMSS/
├── matrix_requirements.dump
├── persistent-data.tar.gz
├── BACKUP-SHA256SUMS
├── previous-docker-compose.yml
└── previous-manifest.json（旧包存在时）
```

升级完成后必须人工核对：

- 原账号可以登录。
- 原项目、源DOCX和评审数据仍存在。
- `data/projects` 中的 `.matrix/data`、`.matrix/reports` 工件完整。
- 已上传文件和导出文件可以访问。
- 新建一个小任务可以正常生成。

Web入口和版本标记使用禁止缓存响应头；页面还会在每60秒、重新获得焦点及从后台恢复时检查部署版本，发现新版本后自动刷新。首次部署包含该能力的版本时，升级前已经打开的旧页面尚无版本检测代码，需要人工刷新一次；此后的升级无需用户手动清理浏览器缓存。

### 升级失败与回滚

脚本在数据库备份失败时不会停服；在持久化归档完成前也不会替换运行配置。若新版启动失败，先查看：

```bash
/opt/requirements-manager-arm64-offline/status.sh
/opt/requirements-manager-arm64-offline/logs.sh api worker opencode web
```

需要回滚时先停止服务，并保存失败现场：

```bash
cd /opt/requirements-manager-arm64-offline
./stop.sh
mv data data.failed-upgrade
mkdir data
docker run --rm --user 0:0 --entrypoint tar \
  -v "$PWD:/target" \
  -v /opt/requirements-manager-backups/YYYYMMDD-HHMMSS:/backup:ro \
  requirements-manager-postgres:arm64 \
  -xzpf /backup/persistent-data.tar.gz -C /target
cp /opt/requirements-manager-backups/YYYYMMDD-HHMMSS/previous-docker-compose.yml docker-compose.yml
```

随后重新加载旧版本离线包中的镜像并执行 `./start.sh`。只有在物理数据无法正常启动时，才应使用 `matrix_requirements.dump` 重建数据库；不要在仍有可用物理备份时直接执行带 `--clean` 的恢复。

如果旧版升级脚本在更新 `bin/docker-compose` 时提示 `Text file busy`，表示Linux拒绝直接覆盖刚执行过的二进制，并不表示数据损坏。新版脚本已改为同目录临时文件加原子重命名。对于已经停在该错误位置的部署，可先用仍完好的旧脚本恢复服务：

```bash
/旧部署目录/start.sh
```

然后换用包含修复后 `upgrade.sh` 的离线包重新升级。不要删除旧部署的 `data/`；上一次失败产生的备份可以继续保留。

### 禁止操作

升级期间不要执行：

```bash
docker compose down -v
docker volume prune
rm -rf data
```

也不要覆盖旧部署中的 `.env` 或 `data/opencode-config/opencode.json`。

## 故障排查

- **8089被占用**：执行 `ss -ltnp | grep 8089` 查找占用进程。
- **页面无法访问**：执行 `./status.sh` 和 `./logs.sh web api`。
- **任务不运行**：执行 `./logs.sh worker opencode`，检查内网模型地址、模型ID和Key。
- **镜像缺失**：重新执行 `./install.sh`，不得在离线服务器上执行在线拉取。
- **确认端口暴露**：执行 `docker ps`，只有Web容器应显示 `0.0.0.0:8089->80/tcp`。
