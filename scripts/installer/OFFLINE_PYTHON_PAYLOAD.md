# Offline Python Payload

离线部署包内置 Python 运行时，安装后无需联网即可执行 `docxtpl` DOCX 渲染和 `code_slicer` 代码切片服务。

Python 依赖统一定义在 `tools-archive-requirements.txt`，所有构建机使用同一份依赖清单。

## 目录结构

```text
tools-archive/
├── runtime/
│   ├── windows/         # bun.exe, opencode.exe, rg.exe
│   └── linux/           # bun, opencode, rg
├── python/
│   ├── wheels/          # 预下载的 .whl 离线缓存（--download-only 生成）
│   ├── windows/         # python.exe + Lib/site-packages（docxtpl + code_slicer deps）
│   └── linux/           # bin/python3 + site-packages
└── tools/
    ├── windows/
    └── linux/
```

## 快速开始

### Windows 构建机（可联网）

```powershell
# 一行命令：创建 venv + pip install（从 PyPI）
.\scripts\prepare-python-offline.ps1
```

### Linux 构建机（可联网）

```bash
bash scripts/prepare-python-offline.sh
```

## 气隙（Air-Gapped）构建环境

构建机无法联网时，分三步走：

### Step 1 — 联网机器上预下载 wheel 包

```powershell
# Windows
.\scripts\prepare-python-offline.ps1 -DownloadOnly
```

```bash
# Linux
bash scripts/prepare-python-offline.sh --download-only
```

此步骤将所有依赖的 `.whl` 文件下载到 `tools-archive/python/wheels/`，包含完整依赖树。

### Step 2 — 将 `tools-archive/` 目录复制到离线构建机

```text
联网机器  tools-archive/  ──拷贝──>  离线构建机  tools-archive/
```

`tools-archive/python/wheels/` 中包含全部 `.whl` 文件，这是离线安装的唯一依赖来源。

### Step 3 — 离线构建机上安装

```powershell
# Windows — 从本地 wheels 安装（完全不联网）
.\scripts\prepare-python-offline.ps1 -Offline
```

```bash
# Linux — 从本地 wheels 安装
bash scripts/prepare-python-offline.sh --offline
```

## 脚本参数参考

### `prepare-python-offline.ps1`（Windows）

| 参数 | 说明 |
|------|------|
| `-PythonVersion "3.12"` | 目标 Python 版本（默认 3.12） |
| `-Force` | 强制重建 venv |
| `-Offline` | 从本地 wheels 安装（不联网） |
| `-DownloadOnly` | 仅下载 wheels，不创建 venv |

### `prepare-python-offline.sh`（Linux）

| 参数 | 说明 |
|------|------|
| `--python /path/to/python3` | 指定 Python 路径（默认自动检测） |
| `--force` | 强制重建 venv |
| `--offline` | 从本地 wheels 安装（不联网） |
| `--download-only` | 仅下载 wheels，不创建 venv |

## 打包行为

执行 `pack-offline.ts` 时，脚本会自动检测 `tools-archive/python/<platform>/`：

- **存在** → 复制到 `runtime/python/`，嵌入离线包
- **不存在** → 跳过，目标机器需自行安装 Python（设置 `MATRIX_PYTHON` 环境变量）

```bash
# 完整打包流程
bun run build
bun run pack:offline -- --platform windows --version 0.1.0
```

## 安装器行为

安装器（NSIS / install.sh）自动注册 `MATRIX_PYTHON` 系统环境变量：

- **Windows**：注册表 `HKLM\SYSTEM\...\Environment\MATRIX_PYTHON` → `C:\Matrix\runtime\python\python.exe`
- **Linux**：`/etc/profile.d/matrix-agent.sh` 中 `export MATRIX_PYTHON=...`

工具 `code_slice_context_pack` 通过 `src/shared/python-runtime.ts` 自动解析 `MATRIX_PYTHON`。

## 依赖清单

`tools-archive-requirements.txt`：

```text
# DOCX 处理
docxtpl==0.20.2
Jinja2==3.1.6
MarkupSafe==3.0.3
lxml==6.0.3
python-docx==1.2.0
typing_extensions==4.15.0

# code_slicer 服务
fastapi>=0.115,<1.0
uvicorn>=0.30,<1.0
pydantic>=2.8,<3.0
tree-sitter>=0.24,<1.0
tree-sitter-c>=0.23,<1.0
```

## 验证

### 构建机上验证

```powershell
# Windows
.\tools-archive\python\windows\Scripts\python.exe -c "import docxtpl, docx, fastapi; print('OK')"
```

```bash
# Linux
./tools-archive/python/linux/bin/python3 -c "import docxtpl, docx, fastapi; print('OK')"
```

### 目标机器上验证（安装后）

```powershell
# Windows (PowerShell)
& $env:MATRIX_PYTHON -c "import docxtpl, docx, fastapi; print('OK')"
```

```bash
# Linux
$MATRIX_PYTHON -c "import docxtpl, docx, fastapi; print('OK')"
```
