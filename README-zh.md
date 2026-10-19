# Matrix Embedded Agent

嵌入式软件测试多智能体系统 —— 基于 [OpenCode](https://github.com/nicholasanthonio/opencode) 的插件。

29 个专业智能体协同工作，配合 77 个领域工具与 23 个斜杠命令，驱动被测软件通过 9 阶段测试流水线，生成符合 GJB 5000A / DO-178C / IEC 61508 等标准的全套测试文档。

## 核心特性

- **9 阶段测试流水线**：任务分类 → 软件分析 → 代码理解 → 测试需求 → 代码审查与静态分析 → 单元测试 → 测试环境 → 确认测试设计 → 测试执行 → 测试总结
- **评审门控**：阶段 2/3/5/6 设置质量关卡，未通过不能推进
- **嵌入式编译适配**：自动检测 GCC / ARMCC / IAR / Keil C51 等 8 种编译器方言，生成 `compile_commands.json`、桩头文件、方言翻译
- **中断冲突审计**：C1-C5 五类中断数据访问冲突模式自动检测
- **AST 级代码搜索**：基于 ast-grep 的结构化代码模式匹配
- **代码知识库**：自动生成按功能域组织的 DeepWiki 风格文档
- **HTML 报告站点**：通过 mdbook 将所有 Markdown 报告汇编为可浏览的 HTML 站点
- **中英双语**：`output_language` 配置切换全部人类可读输出语言

## 配套需求管理系统 requirements-manager

[requirements-manager](https://github.com/wsliture/matrix-test-req-reviewer) 是配套的 Web 需求管理系统，通过 OpenCode 调用本插件的 Phase 2 工作流，提供 DOCX 项目导入、生成监控、需求追踪、人工评审、在线编辑、版本比较与文档导出。

本地可将该独立仓库检出到 `requirements-manager/`。该目录被本仓库 `.gitignore` 忽略，不随本仓库克隆自动获取：

```bash
git clone https://github.com/wsliture/matrix-test-req-reviewer.git requirements-manager
```

若目录已存在，先检查其中的仓库状态，无需重复克隆。管理系统使用 Node.js 和 npm workspaces；本插件使用 Bun，两者分别构建、测试和提交。管理系统的 OpenCode 镜像构建依赖父目录的 Matrix 插件源码。

检出后参阅 [管理系统 README](requirements-manager/README.md)、[开发指导 AGENTS.md](requirements-manager/AGENTS.md) 和 [整体架构](requirements-manager/docs/整体架构.md)。涉及 Web、API、后台队列、评审或在线编辑的任务，应先阅读该工程的开发指导。

## 快速开始

### 安装

```bash
bun install              # 安装依赖 + 下载捆绑二进制
bun run build            # 构建到 dist/index.js
```

### 配置

在被测项目根目录创建 `.matrix/config/matrix.jsonc`：

```jsonc
{
  "standard": "gjb5000a",          // 合规标准
  "coverage_target": "branch",     // 覆盖率目标: statement | branch | mc_dc
  "coding_standard": "misra-c-2012", // 编码规范
  "unit_framework": "unity",       // 单元测试框架
  "compiler_dialect": "auto",      // 编译器方言 (auto 自动检测)
  "target_cpu": "cortex-m4",       // 目标 CPU
  "output_language": "zh-CN"       // 输出语言
}
```

全部配置项见 `src/config/schema.ts` 中的 `MatrixConfigSchema`。

外部工具可通过配置项显式指定，例如：

```jsonc
{
  "install_root": "D:\\Matrix"
}
```
`code_slicer` 会按固定相对路径解析为 `<install_root>/tools/code_slicer`。

### 常用命令

| 命令 | 说明 |
|------|------|
| `/matrix-start` | 启动完整 9 阶段测试流水线 |
| `/matrix-plan` | 交互式测试规划访谈 |
| `/matrix-analyze` | 代码与需求分析 (Phase 1) |
| `/matrix-wiki` | 生成代码 Wiki 知识库与 DeepWiki 文档 (Phase 1b) |
| `/matrix-contexts` | 生成按 `local_subgraph` 函数区域组织的 code-slice 上下文产物 (`.matrix/data/contexts`) |
| `/matrix-review` | 对当前阶段执行质量评审 |
| `/matrix-test` | 单元测试设计与执行 (Phase 4) |
| `/matrix-status` | 查看当前阶段进度 |
| `/matrix-report` | 生成最终测试总结 (Phase 8) |
| `/matrix-metrics` | 查看各智能体 token 用量与耗时 |
| `/matrix-astgrep` | AST 级结构化代码搜索 |
| `/matrix-isr-review` | 中断数据访问冲突审计 |

## 项目结构

```
src/
├── index.ts              # 插件入口
├── plugin-interface.ts    # OpenCode hook 映射
├── agents/               # 29 个智能体 (每个导出 AgentFactory)
├── tools/                # 77 个领域工具
├── hooks/                # 9 个流程钩子
├── schema/               # Zod 数据模型
├── config/               # 配置 schema
└── shared/               # 常量、状态管理、数据存储
skills/                   # 19 个 SKILL.md 技能文件
templates/                # 报告模板与业务模板根目录（含 testcase-prompts/）
standards/                # 标准检查清单
bin/                      # 捆绑二进制 (mdbook, ast-grep)
requirements-manager/     # 配套 Web 需求管理系统（独立仓库，需单独检出）
```

## 开发者扩展指南

### 添加智能体

1. 在 `src/agents/` 新建 `my-agent.ts`，导出工厂函数和元数据：

```typescript
import type { AgentFactory, AgentPromptMetadata } from "./types"

export const MY_AGENT_META: AgentPromptMetadata = {
  category: "testing",         // orchestration | analysis | testing | quality | utility
  cost: "EXPENSIVE",           // FREE | CHEAP | EXPENSIVE
  triggers: [{ domain: "testing", trigger: "when user asks for X" }],
}

export const createMyAgent: AgentFactory = Object.assign(
  (model?: string) => ({
    prompt: `你的系统提示...`,
    model: model ?? undefined,
    tools: ["read", "write", "glob", "grep"],  // 可用工具列表
  }),
  { mode: "subagent" as const },  // primary | subagent | all
)
```

2. 在 `src/agents/builtin-agents.ts` 注册：在 `BuiltinAgentName` 类型、`agentFactories` 和 `agentMetadata` 中添加对应条目。

### 添加工具

1. 在 `src/tools/` 新建 `my-tool.ts`，导出符合 OpenCode `ToolDefinition` 接口的对象：

```typescript
export const myTool = {
  description: "工具描述",
  parameters: {
    type: "object" as const,
    properties: { input: { type: "string", description: "输入参数" } },
    required: ["input"],
  },
  execute: async (params: { input: string }) => {
    return { result: "工具执行结果" }
  },
}
```

2. 在 `src/create-tools.ts` 的 `allTools` 对象中添加：`my_tool: myTool`。

### 添加技能 (Skill)

在 `skills/` 下创建 `my-skill/SKILL.md`，使用 YAML frontmatter + Markdown：

```markdown
---
name: my-skill
description: 技能简要描述
---

# 技能名称

技能的方法论内容...
```

插件启动时自动发现 `skills/` 下所有 `SKILL.md`。智能体通过 `skill my-skill` 工具按需加载。

### 添加钩子 (Hook)

1. 在 `src/hooks/` 新建文件，导出创建函数。
2. 在 `src/hooks/index.ts` 中 re-export。
3. 在 `src/create-hooks.ts` 中实例化并注册。
4. 在 `src/plugin-interface.ts` 的对应 hook slot 中调用。

钩子可拦截三类事件：
- `chat.message` — 聊天消息前后
- `tool.execute.after` — 工具执行后
- `experimental.chat.system.transform` — 系统提示转换

### 添加捆绑二进制

1. 在 `scripts/postinstall.ts` 的 `TOOLS` 数组中添加 `BundledTool` 条目。
2. 在对应工具 `.ts` 文件中通过 `join(import.meta.dir, "..", "bin", binaryName)` 解析路径。
3. 不要添加运行时下载逻辑 — 二进制仅在 `bun install` 时下载。

### 添加斜杠命令

在 `src/create-skills.ts` 的 `createCommands()` 返回对象中添加条目：

```typescript
"matrix-my-command": {
  description: "命令描述",
  agent: "my-agent",    // 绑定的智能体
  subtask: true,         // true = 子任务, false = 独立对话
  template: "命令模板文本...",
},
```

## 构建与测试

```bash
bun run build            # 构建
bun run typecheck        # 类型检查
bun test                 # 运行测试
bun run clean            # 清理构建产物
```

## 运行时产物

工作流执行过程中，所有数据保存在被测项目的 `.matrix/` 目录下：

| 目录 | 内容 |
|------|------|
| `config/` | 项目配置 (`matrix.jsonc`) |
| `data/` | JSON 结构化数据 (分析结果、缺陷、测试用例等) |
| `state/` | 阶段进度状态 |
| `reports/` | Markdown 报告 |
| `wiki/` | 代码知识库 (JSON 三层结构) |
| `stubs/` | 自动生成的桩头文件 |
| `preprocessed/` | 方言翻译后的源文件 |
| `book/` | mdbook HTML 站点 |

## 许可证

MIT
