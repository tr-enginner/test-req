# Lightweight C Code Indexer and Context Exporter

这是一个面向 C 仓库的轻量代码索引、函数切片和上下文导出工具。当前目标不是完整编译 C 项目，而是在不依赖训练的前提下，把仓库代码组织成适合后续 LLM 缺陷检测、代码审查和安全分析的上下文片段。

当前实现包含三层能力：

- Step 1：索引 C 源码，提取函数、调用关系、全局变量、全局引用、类型定义、类型字段和 attached comments。
- Step 2：按可选策略生成函数级代码切片 block。
- Step 3：把 block 补充为可直接喂给下游智能体的上下文文件，包括函数体、相关全局变量、相关类型定义和范围级行号。

技术栈：

- Python
- FastAPI
- SQLite
- tree-sitter-c

## 当前能力

已支持：

- 扫描 `.c` / `.h` 文件。
- 解析函数定义、函数体、签名、起止行号和 attached comments。
- 建立轻量调用图。
- 提取全局变量定义。
- 建立全局变量读写反向索引。
- 提取 `typedef`、`struct`、`enum`、函数指针 typedef。
- 提取结构体字段。
- 支持两个 Step 2 slicing strategy：
  - `path`
  - `local_subgraph`
- 持久化不同策略生成的 blocks，并用 `slicing_strategy` 区分。
- Step 3 可按策略读取 blocks 并导出上下文。
- Step 3 对 `path` 输出 `function_chain`，对 `local_subgraph` 输出 `function_region`。
- Step 3 会补充 block 内函数涉及的全局变量和类型定义。

当前边界：

- 不做完整 points-to / alias analysis。
- 不做精确函数指针调用解析。
- 不做完整宏展开语义恢复。
- 不承诺覆盖 GNU C、内核风格扩展、statement expression、`container_of` 等复杂 C 方言。
- 输出的行号是范围级，不是逐行编号。

## Step 2 切片策略

### `path`

`path` 是保留的旧策略，按调用路径生成线性 block。

示例：

```text
A
|- B
`- C
```

可能生成：

```text
A -> B
A -> C
```

适合需要沿调用链阅读和调试的场景。

### `local_subgraph`

`local_subgraph` 是新增策略，从 seed/root 函数出发，在预算允许时吸收局部下游函数，减少共享前缀重复。

示例：

```text
A
|- B
`- C
```

预算允许时生成：

```text
{A, B, C}
```

核心规则：

- 一个函数默认只完整进入一个 `local_subgraph` primary block。
- 只有已经进入当前 block 的函数才允许继续展开它的 callee。
- 如果 callee 不能进入当前 block，它会成为 boundary / continuation candidate。

## 默认预算

当前默认只限制总行数：

```text
max_functions = null
max_total_lines = 3000
```

含义：

- 默认不限制每个 block 的函数数量。
- 用 `max_total_lines=3000` 控制 block 扩展时纳入的函数源码行数；单个不可拆分的 seed 函数自身可能超过该值。
- `max_total_lines` 不限制 Step 3 导出的最终 `prompt_ready` 文本；全局量、类型、宏和相关注释会在导出时补入。
- 如需启用函数数限制，可通过 HTTP 参数或 CLI 参数传入 `max_functions` / `--max-functions`。

示例：

```powershell
python run_cli.py context-pack --repo C:\repo --out C:\repo\.step3_context --slicing-strategy local_subgraph --max-functions 15
```

HTTP 示例：

```text
POST /blocks/generate?slicing_strategy=local_subgraph&max_functions=15
GET /blocks?persisted_only=false&slicing_strategy=local_subgraph&max_functions=15
```

## HTTP API

### 健康检查

```text
GET /health
```

### 建立索引

```text
POST /index
```

请求体：

```json
{
  "repo_path": "C:/path/to/repo",
  "db_path": "C:/path/to/index.db"
}
```

返回：

- `db_path`
- `files_indexed`
- `functions_indexed`
- `calls_indexed`
- `global_definitions_indexed`
- `macro_definitions_indexed`
- `type_definitions_indexed`
- `global_symbol_refs_indexed`

### 查询基础索引

```text
GET /functions
GET /functions/{function_id}
GET /calls/by-function/{function_id}
GET /callers?function=...
GET /callees?function_id=...
GET /types
GET /types/fields?name=...
GET /globals
GET /globals/refs?symbol=...
GET /roots
```

常用参数：

- `db_path`
- `name`
- `function`
- `function_id`
- `symbol`

### 生成并持久化 blocks

```text
POST /blocks/generate
```

查询参数：

- `db_path`
- `slicing_strategy`：默认 `path`，可选 `path` / `local_subgraph`
- `max_functions`：可选；不传表示 unlimited
- `max_total_lines`：默认 `3000`

示例：

```powershell
curl -X POST "http://127.0.0.1:8000/blocks/generate?db_path=C:/tmp/index.db&slicing_strategy=local_subgraph"
```

返回示例：

```json
{
  "blocks_generated": 3,
  "slicing_strategy": "local_subgraph",
  "persisted": true,
  "max_functions": null,
  "max_total_lines": 3000
}
```

### 列出 blocks

```text
GET /blocks
```

查询参数：

- `db_path`
- `persisted_only`：默认 `true`
- `slicing_strategy`：默认 `path`
- `max_functions`：只在 `persisted_only=false` 时用于 live generation
- `max_total_lines`：只在 `persisted_only=false` 时用于 live generation

示例：

```powershell
curl "http://127.0.0.1:8000/blocks?db_path=C:/tmp/index.db&slicing_strategy=local_subgraph"
curl "http://127.0.0.1:8000/blocks?db_path=C:/tmp/index.db&persisted_only=false&slicing_strategy=local_subgraph"
```

### 查询单个 block

```text
GET /blocks/{block_id}
```

查询参数：

- `db_path`
- `persisted_only`：默认 `true`
- `slicing_strategy`：可选；建议传入以避免不同策略 block id 混淆
- `max_functions`
- `max_total_lines`

返回中包含：

- `block_id`
- `block_kind`
- `slicing_strategy`
- `root_function_name`
- `path_function_ids`
- `path_signature`
- `total_functions`
- `total_lines`
- `truncated`
- `truncation_reason`
- `continuation_candidates`
- `functions`
- `rendered_block`

## Step 3 上下文导出

```text
POST /contexts/generate
```

请求体：

```json
{
  "repo_path": "C:/path/to/repo",
  "out_dir": "C:/path/to/repo/.step3_context",
  "db_path": "C:/path/to/index.db",
  "persisted_only": true,
  "slicing_strategy": "local_subgraph",
  "max_functions": null,
  "max_total_lines": 3000
}
```

说明：

- `persisted_only=true` 时读取已持久化的 Step 2 blocks。
- 如果尚未执行 `/blocks/generate`，会返回 400。
- `persisted_only=false` 时临时生成 blocks 并直接导出。
- `slicing_strategy` 必须和你希望导出的 block 策略一致。

返回：

- `project_path`
- `out_dir`
- `manifest_file`
- `context_count`

导出目录结构：

```text
<out_dir>/
  manifest.json
  contexts/
    ctx-0001.json
    ctx-0002.json
```

### context 文件结构

每个 `contexts/ctx-xxxx.json` 包含：

- `context_id`
- `block`
- `outline`
- `locations`
- `prompt_ready.text`

示例：

```json
{
  "context_id": "ctx-0001",
  "block": {
    "block_id": "407b0a8a25b2",
    "block_kind": "local_subgraph",
    "slicing_strategy": "local_subgraph",
    "root_function_name": "main",
    "function_ids": [1, 2, 3]
  },
  "outline": {
    "function_region": ["main", "SystemInit", "DataProtect"],
    "globals": ["g_state", "g_counter"],
    "types": ["struct _HEAT_PARA"],
    "macros": ["SET_STATE", "STATE_BUSY"]
  },
  "locations": {
    "functions": [
      {
        "name": "main",
        "path": "power.c",
        "start_line": 100,
        "end_line": 180
      }
    ],
    "globals": [
      {
        "name": "g_state",
        "path": "power.c",
        "line": 20
      }
    ],
    "types": [
      {
        "name": "struct _HEAT_PARA",
        "path": "power.c",
        "start_line": 10,
        "end_line": 15
      }
    ],
    "macros": [
      {
        "name": "SET_STATE",
        "path": "power.h",
        "start_line": 20,
        "end_line": 21,
        "kind": "function"
      }
    ]
  },
  "prompt_ready": {
    "text": "..."
  }
}
```

### `path` 和 `local_subgraph` 的输出区别

`path`：

```json
{
  "outline": {
    "function_chain": ["boot", "update_global_len", "mark_busy"],
    "globals": ["g_ctx"],
    "types": ["device_ctx_t"],
    "macros": ["SET_BUSY"]
  }
}
```

prompt 中：

```text
function_chain: boot -> update_global_len -> mark_busy
```

`local_subgraph`：

```json
{
  "outline": {
    "function_region": ["main", "SystemInit", "DataProtect"],
    "globals": ["g_state"],
    "types": ["struct _HEAT_PARA"],
    "macros": ["SET_STATE", "STATE_BUSY"]
  }
}
```

prompt 中：

```text
function_region: main, SystemInit, DataProtect
```

### 行号定位能力

Step 3 当前提供范围级行号：

- 函数：`path + start_line + end_line`
- 全局变量：`path + line`
- 类型定义：`path + start_line + end_line`

这足以让下游智能体输出函数级或定义级缺陷定位，例如：

```json
{
  "finding": "possible state reset issue",
  "primary_location": {
    "path": "power.c",
    "function": "ChargeUnlock",
    "line_range": [1234, 1278]
  },
  "supporting_locations": [
    {
      "path": "power.c",
      "symbol": "chargeUnlockCount",
      "line": 88
    }
  ]
}
```

当前没有逐行编号。若后续需要精确语句级定位，可以在智能体指出代码片段后，再用源码文本反查实际行号。

## CLI 用法

入口：

```powershell
cd C:\Users\84003\Desktop\doc\0\code-slice\work
python run_cli.py context-pack --repo C:\path\to\repo --out C:\path\to\repo\.step3_context
```

默认行为：

- 建立索引库：`<repo>/.matrix/data/index.db`
- 从项目根目录扫描时忽略 `.matrix`、`.git` 和 `node_modules` 中的生成文件或依赖副本
- 使用默认策略 `local_subgraph`，输出按函数区域组织的 `function_region` contexts
- 持久化 Step 2 blocks
- 导出 Step 3 contexts

如需按调用路径输出 `function_chain` contexts，显式使用 `path`：

```powershell
python run_cli.py context-pack ^
  --repo C:\path\to\repo ^
  --out C:\path\to\repo\.step3_context ^
  --slicing-strategy path
```

启用函数数限制：

```powershell
python run_cli.py context-pack ^
  --repo C:\path\to\repo ^
  --out C:\path\to\repo\.step3_context ^
  --slicing-strategy local_subgraph ^
  --max-functions 15
```

可选参数：

- `--slicing-strategy path|local_subgraph`，CLI 默认 `local_subgraph`
- `--max-functions`
- `--max-total-lines`（限制 block 扩展所收纳的函数源码行数；单个 seed 函数可能超过该值）

## 验证脚本

常用验证：

```powershell
python -m compileall work
python work\scripts\validate_step1_step2.py
python work\scripts\validate_http_slicing.py
python work\scripts\validate_step3.py
python work\scripts\validate_cli.py
```

说明：

- 验证脚本使用 `work/validation_scratch/` 作为临时目录。
- 该目录已加入 `.gitignore`。

## 代码位置

- HTTP 服务入口：[app/main.py](app/main.py)
- CLI 入口：[app/cli.py](app/cli.py)
- 索引流程：[app/indexer.py](app/indexer.py)
- AST 提取：[app/extractors.py](app/extractors.py)
- SQLite schema：[app/storage.py](app/storage.py)
- Step 2 block 生成：[app/path_blocks.py](app/path_blocks.py)
- Step 3 context 导出：[app/context_export.py](app/context_export.py)

## 示例：cnas smoke test 结果

在 `C:\Users\84003\Desktop\cnas` 上，当前默认预算为：

```text
max_functions = null
max_total_lines = 3000
```

索引结果：

- C/H 文件：1
- 函数：40
- 调用记录：92
- 全局变量定义：114
- 类型定义：1
- 全局引用：981

默认切片结果：

| strategy | blocks | Step 3 contexts |
| --- | ---: | ---: |
| `path` | 40 | 40 |
| `local_subgraph` | 3 | 3 |

`local_subgraph` 三片分别是：

1. `main` 区域：33 个函数，2077 行。
2. `CAN_ISR` 区域：6 个函数，254 行。
3. `TIMER_ISR` 区域：1 个函数，8 行。
