# Matrix Embedded Agent -- 离线部署指南

本文档面向 IT 管理员，说明如何在**联网构建机**上打包离线安装包，然后在**离线目标机器**上完成部署。

---

## 1. 构建离线安装包（在联网构建机上执行）

### 1.1 前置条件

| 项目 | 要求 |
|------|------|
| Bun | >= 1.0 |
| NSIS | 3.x（仅 Windows 安装包需要，`makensis` 需在 PATH 中） |
| 项目源码 | 已克隆仓库，并执行过 `bun install && bun run build` |

### 1.2 准备运行时二进制和外部工具

在项目根目录下创建 `tools-archive/` 目录，按以下结构放置运行时二进制和可选的外部工具：

```
tools-archive/
├── runtime/
│   ├── windows/         # bun.exe, opencode.exe, rg.exe
│   └── linux/           # bun, opencode, rg
└── tools/
    ├── windows/
    │   ├── specchecker/   # SpecChecker 静态分析工具
    │   ├── aunit/         # SunwiseAUnit 单元测试框架
    │   ├── code_slicer/   # code_slicer context-pack 工具
    │   ├── joern-cli/     # Joern 代码属性图分析（可选）
    │   └── z3/            # Z3 约束求解器（可选）
    └── linux/
        ├── joern-cli/     # Joern 代码属性图分析（可选）
        └── z3/            # Z3 约束求解器（可选）
```

> **说明：** `runtime/` 下的 Bun、OpenCode 和 ripgrep (`rg`) 二进制都是必需的核心组件。`rg` 缺失会导致离线环境中的文档发现、`glob/grep` 以及 PDF 需求提取流程不完整，打包脚本现在会直接失败。`tools/` 下的外部工具仍为可选组件。

### 1.3 构建命令

```bash
# 打包 Windows 离线安装程序（输出 .exe）
bun run pack:offline -- --platform windows --version 0.1.0

# 打包 Linux 离线安装包（输出 .tar.gz）
bun run pack:offline -- --platform linux --version 0.1.0
```

如果 `tools-archive/` 位于非默认位置，可使用 `--tools-archive` 指定：

```bash
bun run pack:offline -- --platform linux --version 0.1.0 --tools-archive /path/to/tools
```

构建产物输出到 `release/` 目录：

| 平台 | 输出文件 |
|------|----------|
| Windows | `release/matrix-offline-v0.1.0-windows-x64.exe` |
| Linux | `release/matrix-offline-v0.1.0-linux-x64.tar.gz` |

---

## 2. 部署（在目标离线机器上执行）

将构建产物拷贝到目标离线机器后，按对应平台执行安装。

### 2.1 Windows 安装

1. 将 `matrix-offline-v<版本>-windows-x64.exe` 拷贝到目标机器
2. **以管理员身份**双击运行安装程序
3. 按照安装向导操作：
   - 阅读并同意许可协议
   - 选择安装目录（默认 `C:\Matrix`）
   - 选择要安装的可选组件（SpecChecker、AUnit、code_slicer、Joern、Z3）
   - 填写 LLM 服务配置：
     - **API 地址**：私有化大模型的 API 端点（例如 `http://llm.internal:8000/v1`）
     - **模型名称**：部署的模型名（例如 `qwen2.5-72b-instruct`）
     - **API Key**：可选，按需填写
4. 等待安装完成
5. 验证安装：打开新的命令提示符窗口，执行：
   ```cmd
   opencode --version
   ```

> 安装程序会自动将运行时目录添加到系统 PATH，并在"控制面板 - 程序和功能"中注册卸载入口。

安装后插件会注册到两个 OpenCode 配置位置，保证 OpenCode TUI 和
OpenCode Desktop 都能发现 Matrix 智能体：
- `%USERPROFILE%\.config\opencode\plugins\matrix.js`
- `%APPDATA%\opencode\plugins\matrix.js`

`skills`、`templates`、`standards`、`bin`、`joern` 等运行资产会同步到
上述配置根目录旁边。`opencode.json` 只保存模型配置和默认智能体，不再
把本地 JS 文件写入 `plugin` 字段；本地插件由 `plugins/` 目录自动加载。

### 2.2 Linux 安装

1. 将 `matrix-offline-v<版本>-linux-x64.tar.gz` 拷贝到目标机器
2. 解压安装包：
   ```bash
   tar -xzf matrix-offline-v0.1.0-linux-x64.tar.gz
   cd matrix-offline-v0.1.0-linux-x64
   ```
3. 以 root 权限运行安装脚本：
   ```bash
   sudo ./install.sh
   ```
4. 按交互式提示完成配置：
   - 安装目录（默认 `/opt/matrix`）
   - LLM API 地址、模型名称、API Key
   - 是否安装 Joern 和 Z3 可选组件
5. 验证安装：打开新的终端会话（或手动加载环境），执行：
   ```bash
   source /etc/profile.d/matrix-agent.sh
   opencode --version
   ```

### 2.3 无人值守安装（Linux）

在批量部署或自动化场景下，可通过环境变量和 `--non-interactive` 参数跳过交互式提示：

```bash
sudo LLM_BASE_URL="http://llm.internal:8000/v1" \
     LLM_MODEL="qwen2.5-72b-instruct" \
     LLM_API_KEY="your-api-key" \
     INSTALL_JOERN=true \
     INSTALL_Z3=false \
     ./install.sh --non-interactive
```

支持的环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `LLM_BASE_URL` | 是 | LLM 服务 API 地址 |
| `LLM_MODEL` | 是 | 模型名称 |
| `LLM_API_KEY` | 否 | API 密钥，留空则不设置 |
| `INSTALL_JOERN` | 否 | 是否安装 Joern（`true`/`false`，默认 `false`） |
| `INSTALL_Z3` | 否 | 是否安装 Z3（`true`/`false`，默认 `false`） |

可通过 `--install-dir` 自定义安装路径：

```bash
sudo LLM_BASE_URL="http://llm.internal:8000/v1" \
     LLM_MODEL="qwen2.5-72b-instruct" \
     ./install.sh --non-interactive --install-dir /data/matrix
```

---

## 3. 私有化 LLM 推荐要求

Matrix Agent 需要连接兼容 OpenAI API 的大语言模型服务。以下为私有化部署的硬件和模型推荐：

| 要求 | 最低 | 推荐 |
|------|------|------|
| 上下文窗口 | 16K tokens | 32K+ tokens |
| Function Calling | 必须支持 | -- |
| 参数规模 | 30B | 70B+ |
| 推荐模型 | -- | Qwen2.5-72B, DeepSeek-V3 |

> **注意：** Matrix Agent 大量使用 Function Calling（工具调用）能力驱动多智能体协作，所部署的模型**必须**支持此特性。参数规模低于 30B 的模型在复杂嵌入式测试场景中可能出现推理质量不足的问题。

---

## 4. 卸载

### 4.1 Windows

通过系统标准流程卸载：

**控制面板** --> **程序和功能** --> 找到 **Matrix Embedded Agent** --> **卸载**

卸载程序会自动完成以下操作：
- 删除安装目录及所有文件
- 从系统 PATH 中移除运行时路径
- 清理注册表条目
- 删除桌面快捷方式（如已创建）

### 4.2 Linux

以 root 权限运行卸载脚本：

```bash
sudo /opt/matrix/uninstall.sh
```

如果安装时使用了自定义路径，需将路径作为参数传入：

```bash
sudo /opt/matrix/uninstall.sh /data/matrix
```

卸载脚本会自动完成以下操作：
- 删除安装目录（`/opt/matrix` 或自定义路径）
- 移除 `/etc/profile.d/matrix-agent.sh` 环境配置
- 清理 `/usr/local/bin/` 下的符号链接（`opencode`、`bun`）
