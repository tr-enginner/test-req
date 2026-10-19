# Matrix Embedded Agent 离线部署设计

> 日期: 2026-03-02
> 状态: 已批准

## 1. 背景与目标

Matrix Embedded Agent 需要在私有环境（完全断网）下部署，让 10-50 人规模的团队能够方便使用。

**约束条件:**

- 完全无互联网访问
- 目标平台: Windows + Linux
- LLM 推理: 私有化大模型（vLLM/Ollama 等，提供 OpenAI 兼容 API）
- 用户技术能力参差不齐，需简化安装流程

## 2. 方案选择

**选定方案: 全包离线安装包 (方案 A)**

- Windows: NSIS 图形化安装程序 (`.exe`)
- Linux: tar.gz + `install.sh` 脚本

**淘汰方案:**

| 方案 | 淘汰原因 |
|------|----------|
| 内网 npm registry (B) | 需额外基础设施维护，用户配置步骤多 |
| Docker 容器化 (C) | SpecChecker/AUnit 为 Windows 专属工具，容器化困难；CLI 交互体验差 |

## 3. 安装包目录结构

```
matrix-offline-v{VERSION}-{OS}/
│
├── runtime/
│   ├── bun-v1.x/                    # Bun 运行时二进制
│   └── opencode-v{X}/               # OpenCode CLI 二进制
│
├── plugin/
│   ├── dist/                        # 预构建的 matrix-embedded-agent
│   ├── node_modules/                # 所有 npm 依赖（预安装，含 native 二进制）
│   ├── bin/                         # mdbook + ast-grep（预下载，目标平台版本）
│   ├── joern/                       # Joern Scala 脚本
│   ├── skills/                      # 16 个 SKILL.md
│   ├── templates/                   # 报告模板
│   ├── standards/                   # 标准检查清单
│   └── package.json                 # 移除 postinstall 脚本的版本
│
├── tools/                           # 可选外部工具（按需包含）
│   ├── specchecker/                 # SpecChecker（仅 Windows 包）
│   ├── aunit/                       # SunwiseAUnit（仅 Windows 包）
│   ├── joern-cli/                   # Joern CLI
│   └── z3/                          # Z3 求解器
│
├── config/
│   ├── opencode.json.template       # OpenCode 配置模板（LLM 地址占位符）
│   └── matrix.jsonc.template        # Matrix 插件配置模板
│
├── install.sh                       # Linux 安装脚本
├── install.bat                      # Windows 安装脚本（NSIS 内部调用或独立备用）
├── uninstall.sh / uninstall.bat     # 卸载脚本
└── README.txt                       # 安装说明
```

### 关键设计点

1. **node_modules 预装**: 打包时执行 `bun install --frozen-lockfile`，完整 `node_modules` 打入包中，用户安装时无需网络
2. **bin/ 预下载**: 打包时执行 postinstall 下载 mdbook 和 sg，每个平台包只含对应平台二进制
3. **tools/ 可选**: 安装程序/脚本中允许用户选择性安装外部工具
4. **native 依赖**: `sharp`、`playwright` 有平台相关 native 二进制，需在对应平台上执行 `bun install` 获取

## 4. Windows NSIS 图形化安装程序

### 安装向导页面

```
1. 欢迎页 — Matrix 嵌入式软件测试系统 v{VERSION}
2. 许可协议
3. 安装目录选择 — 默认 C:\Matrix\
4. 组件选择（可勾选）
   ☑ Matrix 核心 (必选): OpenCode CLI + Bun 运行时 + Matrix 插件
   ☐ SpecChecker 静态分析工具
   ☐ SunwiseAUnit 单元测试框架
   ☐ Joern 代码属性图分析
   ☐ Z3 约束求解器
5. LLM 服务配置
   - API 地址:  [http://llm.internal:8000/v1]
   - 模型名称:  [qwen2.5-72b-instruct]
   - API Key:   [可选]
6. 安装进度条
7. 完成页
   ☑ 添加到系统 PATH
   ☑ 创建桌面快捷方式
```

### NSIS 脚本职责

1. 解压文件到 `$INSTDIR`
2. 从 LLM 配置页面读取用户输入，写入 OpenCode 配置文件
3. 根据组件选择写入 Matrix 配置模板（填写工具路径）
4. 添加 `$INSTDIR\bin` 到系统 PATH（注册表 `HKLM\SYSTEM\...\Environment`）
5. 注册 matrix-embedded-agent 为 OpenCode 插件
6. 写入卸载信息到"程序和功能"（Add/Remove Programs）
7. 创建开始菜单 + 桌面快捷方式
8. 生成 `uninstall.exe`

### 卸载

NSIS 自动生成的 `uninstall.exe` 在"控制面板 → 程序和功能"中可一键卸载，清理 PATH 注册表项和安装目录。

## 5. Linux 安装脚本 (install.sh)

```
install.sh 流程:
1. 检测系统环境 (OS, 架构, 磁盘空间)
2. 选择安装目录 — 默认 /opt/matrix/
3. 复制文件
   - runtime/bun → {install_dir}/bun
   - runtime/opencode → {install_dir}/opencode
   - plugin/ → {install_dir}/plugin/
   - tools/ (按用户选择)
4. 交互式配置
   - 输入私有 LLM 服务地址
   - 输入 LLM 模型名称
   - 输入 API Key (可选)
   - 选择要启用的外部工具
5. 生成配置文件
   - 写入 OpenCode 配置 (provider, base_url, model)
   - 写入 Matrix 配置模板 (工具路径)
6. 注册环境
   - 添加到 PATH (/etc/profile.d/ 或 ~/.bashrc)
   - 注册 matrix-embedded-agent 为 OpenCode 插件
   - 创建 /usr/local/bin/matrix 软链接
7. 验证安装
   - opencode --version
   - bun --version
   - 检测插件是否加载成功
```

## 6. LLM 配置

OpenCode 支持 OpenAI 兼容 API，安装时生成的配置:

```jsonc
// OpenCode 配置
{
  "provider": {
    "name": "openai-compatible",
    "base_url": "http://llm.internal:8000/v1",  // 用户填写
    "api_key": "sk-xxx",                          // 可选
    "model": "qwen2.5-72b-instruct"              // 用户选择
  }
}
```

### 私有化模型最低推荐规格

Matrix 的 19 个 agent 对 LLM 能力有较高要求:

- 上下文窗口 >= 32K tokens
- 支持 function calling / tool use
- 推荐 70B+ 参数模型（Qwen2.5-72B, DeepSeek-V3 等）

## 7. 打包构建流水线

在**联网构建机**上运行 `scripts/pack-offline.ts`:

```
构建步骤:

1. 准备阶段
   ├── 检出指定版本的 matrix-embedded-agent
   ├── bun install --frozen-lockfile    # 安装 npm 依赖 + postinstall 下载二进制
   └── bun run build                    # 构建 dist/index.js

2. 收集运行时
   ├── 下载 Bun 二进制 (目标平台)
   ├── 下载 OpenCode CLI 二进制 (目标平台)
   └── 下载外部工具包 (SpecChecker, AUnit, Joern, Z3)

3. 收集插件包
   ├── 复制 dist/, node_modules/, bin/, joern/, skills/, templates/, standards/
   ├── 为目标平台下载对应 bin/ 二进制 (mdbook, sg)
   └── 复制 package.json (移除 devDependencies 和 scripts.postinstall)

4. 生成配置模板
   ├── opencode.json.template: LLM endpoint 占位符 {{LLM_BASE_URL}}
   └── matrix.jsonc.template:  工具路径占位符

5. 平台特定打包
   ├── Windows: makensis scripts/installer/matrix.nsi → .exe 安装程序
   └── Linux:   tar.gz 压缩包（含 install.sh）

构建命令:
  bun run pack:offline --platform windows --version 0.1.0
  bun run pack:offline --platform linux --version 0.1.0

产物:
  release/matrix-offline-v0.1.0-windows-x64.exe
  release/matrix-offline-v0.1.0-linux-x64.tar.gz
```

### native 依赖注意

`sharp` 和 `playwright` 有平台相关 native 二进制。打包 Windows 包需在 Windows 上执行 `bun install`，Linux 包需在 Linux 上执行。可通过 CI 双平台构建解决。

## 8. 升级策略

### 增量补丁包

```
matrix-patch-v{OLD}-to-v{NEW}-{OS}/
├── plugin/                          # 仅变更的文件
│   ├── dist/index.js
│   ├── skills/ (仅变更的)
│   └── bin/ (如有版本更新)
├── patch.sh / patch.bat             # 应用补丁脚本
├── CHANGELOG.md                     # 变更说明
└── rollback.sh / rollback.bat       # 回滚脚本
```

- 补丁脚本先备份当前版本到 `{install_dir}/backup/v{OLD}/`
- npm 依赖有变更时，补丁包包含差异化 `node_modules`
- 提供回滚脚本从备份恢复

## 9. 项目新增文件

```
scripts/
├── pack-offline.ts              # 跨平台打包主脚本
└── installer/
    ├── matrix.nsi               # NSIS 安装脚本
    ├── matrix-banner.bmp        # 安装向导头部横幅图
    ├── matrix-icon.ico          # 安装程序图标
    └── license.txt              # 许可协议文本
```

## 10. 用户日常使用流程

安装完成后，用户在被测项目目录下:

```bash
cd /path/to/my-embedded-project/

opencode /matrix-plan      # 交互式规划测试范围
opencode /matrix-start     # 启动全流程
opencode /matrix-analyze   # 仅分析阶段
opencode /matrix-static    # 仅静态分析
opencode /matrix-test      # 仅单元测试
opencode /matrix-status    # 查看进度
open .matrix/book/index.html  # 浏览报告
```
