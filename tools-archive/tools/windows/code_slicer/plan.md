# 目标

做一个不依赖训练、适合仓库级 / 嵌入式 C 代码的漏洞分析前端。

当前主路线调整为：

> 先建立轻量代码索引，再提供多种可选择的函数级代码切片策略；当前保留旧的 path 切片方式，同时新增 local subgraph 切片方式，后续继续扩展更多切片策略；随后按需补充全局状态和类型定义，最后把这些上下文块交给 LLM 判断。

这条路线强调：

- 不废弃已经可用的旧切片方式。
- 新切片方式不覆盖旧入口，而是作为新策略并行存在。
- Step 2 的长期形态应是多策略可选的 slicing framework。
- 每种切片策略都要有清晰边界、稳定输出和独立测试。

---

# 工作依据摘要

## 总目标

把当前系统从“单一 path block 生成器”演进为“多策略代码切片框架”。

最终系统应满足：

- 默认保留现有 `path` 切片行为，避免破坏已验证能力。
- 新增 `local_subgraph` 切片策略，用于生成局域、预算受控、函数体默认不重复的子图块。
- API、CLI、持久化和 Step 3 都能明确知道当前 block 由哪种策略生成。
- 后续新增切片方式时，不需要重写已有 `path` 或 `local_subgraph` 逻辑。

## 当前最近目标

最近一轮改造只聚焦 Step 2。

本轮不做：

- 不删除 `_walk_paths()`。
- 不改变默认 `path` 行为。
- 不重构 Step 3 输出格式。
- 不做复杂 scoring、token budget、fan-out soft limit。
- 不把所有 `path_*` 字段一次性重命名。

本轮要做：

- 抽出策略分发入口。
- 保留 `path` strategy。
- 新增 `local_subgraph` strategy。
- 让 HTTP / CLI 可以选择 `slicing_strategy`。
- 给两种策略分别建立验证。
- 保证两种策略输出都能继续接上 Step 3 的全局变量和类型定义补充。

关键约束：

> Step 2 可以产生不同形态的 block，但必须向 Step 3 提供稳定的函数集合。Step 3 的全局变量和类型定义补充应基于 block 内函数集合工作，而不是依赖 block 一定是线性调用路径。

## 阶段交付总览

### 阶段 1：策略分层，行为不变

目标：

- 当前 `path` 输出必须保持不变。
- 现有验证脚本应继续通过。
- 代码结构从“只有 path 生成函数”调整为“通用策略入口 + path 策略实现”。

交付物：

- `generate_blocks(conn, strategy="path", ...)`
- `generate_path_strategy_blocks(...)`
- `generate_path_blocks(...)` 继续保留，并委托给 `strategy="path"`
- `persist_path_blocks(...)` 行为不变

验收标准：

- 默认调用仍生成旧的 path blocks。
- `A_supported` 的旧 path block 验证不变。
- HTTP 现有调用不需要改参数也能工作。

### 阶段 2：新增 `local_subgraph` 策略

目标：

- 新增局部子图切片，不影响 `path`。
- 在预算允许时合并共享前缀，减少重复函数体。
- 保证不会通过未吸收的 boundary 节点继续展开下游。
- 生成的 block 必须包含 Step 3 可消费的函数 ID 列表。

交付物：

- `generate_local_subgraph_strategy_blocks(...)`
- `grow_local_subgraph_block(...)`
- `can_admit_function(...)`
- boundary 去重与 seed queue 续接逻辑
- `block_kind` 或 `slicing_strategy` 能区分新策略结果
- local subgraph block 的 `path_function_ids` 暂时继续作为 Step 3 函数集合输入

验收标准：

- `A -> B`、`A -> C` 在预算允许时生成 `{A, B, C}`。
- `A -> B -> D` 中，`B` 未进入当前 block 时不能生成 `{A, D}`。
- `path` 策略验证仍通过。
- 使用 `local_subgraph` 生成的 block 能进入 Step 3，补出对应全局变量和类型定义。

### 阶段 3：入口参数化

目标：

- 用户可以显式选择切片策略。
- 默认仍为 `path`。

交付物：

- `POST /blocks/generate?slicing_strategy=path`
- `POST /blocks/generate?slicing_strategy=local_subgraph`
- `GET /blocks?persisted_only=false&slicing_strategy=...`
- CLI `--slicing-strategy`

验收标准：

- 不传参数时使用 `path`。
- 传 `local_subgraph` 时走新策略。
- 错误 strategy 返回清晰错误。

### 阶段 4：持久化策略信息

目标：

- 持久化 block 时记录它的生成策略。
- 查询时不混淆 `path` 与 `local_subgraph`。

交付物：

- 推荐新增 `slicing_strategy` 字段。
- 持久化、列表查询、单 block 查询都返回 strategy。
- 现有旧库或默认值兼容 `path`。

验收标准：

- 同一 DB 中能判断 block 来自哪种策略。
- Step 3 能按策略读取或过滤 block。

### 阶段 5：Step 3 多策略适配

目标：

- Step 3 不再假设所有 block 都是线性调用链。
- `path` 仍可展示 `function_chain`。
- `local_subgraph` 使用稳定函数区域语义。
- 不论 block 来自哪种策略，全局变量和类型定义补充逻辑都继续可用。

交付物：

- Step 3 基于 `function_ids` / `path_function_ids` 读取函数集合。
- `path` 输出链式描述。
- `local_subgraph` 输出区域式描述。
- `_collect_globals(...)` 和 `_collect_types(...)` 继续复用，不按策略分叉。

验收标准：

- 两种策略都能导出上下文。
- `local_subgraph` 不被误描述为唯一调用路径。
- `local_subgraph` 导出的上下文中包含其函数集合涉及的 globals/types。

---

# 总体实现路线

1. Step 1：建立轻量代码索引。
2. Step 2：提供多策略代码切片入口。
3. Step 3：补充切片块涉及的全局状态和类型定义。
4. Step 4：判断当前块是否闭合。
5. Step 5：必要时沿 continuation / boundary / 全局状态继续扩展。
6. Step 6：块去重、压缩与最终打包。

当前状态：

- Step 1 已实现。
- Step 2 已实现旧版 `path` 切片。
- 下一步不是替换旧 `path` 切片，而是新增 `local_subgraph` 切片策略。
- Step 3-6 仍是后续研发计划，需逐步适配多策略输出。

---

# Step 1：轻量代码索引

## 目标

做一个足够轻量、但能支撑后续多策略切片和上下文补充的索引层。

当前 Step 1 的定位是：

- 能索引函数定义与函数体。
- 能建立轻量调用图。
- 能建立类型定义索引。
- 能建立类型字段索引。
- 能建立全局变量定义索引。
- 能建立全局变量到读写函数的反向索引。
- 能提取定义前的 attached comments。

## 当前已实现的输出

### 1. 函数表

每个函数记录：

- 函数名
- 文件路径
- 起止行号
- 返回类型
- `linkage`：`static` / `global`
- 函数签名文本
- 函数体文本
- `attached_comments`

### 2. 调用表

每条调用记录：

- caller 所属函数
- callee 名称
- 调用所在行号
- 实参文本列表
- `callee_kind`
  - `direct`
  - `field_fnptr`
  - `unknown`
- 轻量解析后的 `resolved_function_id`

当前调用解析策略：

- 优先匹配同文件 `static` 函数。
- 其次匹配全仓唯一全局定义。
- 不做精确函数指针调用解析。
- 不记录函数对自身的 caller / callee。

### 3. 类型、字段、全局状态索引

当前已实现：

- `typedef` / `struct` / `enum` / 函数指针 `typedef`。
- 结构体字段索引。
- 全局变量定义索引。
- 全局变量读写反向索引。
- 函数、全局变量、类型定义前的 attached comments。

## 当前能力边界

当前 Step 1 不承诺精确支持：

- 精确函数指针调用解析。
- 完整 points-to / alias analysis。
- 深层多跳别名传播。
- 宏展开后的精确语义恢复。
- GNU C / 内核式方言。
- 完整类型系统。
- CFG / PDG / SSA。

## 当前实现入口

- 服务入口：[work/app/main.py](/C:/Users/84003/Desktop/doc/0/code-slice/work/app/main.py)
- 索引主流程：[work/app/indexer.py](/C:/Users/84003/Desktop/doc/0/code-slice/work/app/indexer.py)
- AST 提取：[work/app/extractors.py](/C:/Users/84003/Desktop/doc/0/code-slice/work/app/extractors.py)
- 数据库 schema：[work/app/storage.py](/C:/Users/84003/Desktop/doc/0/code-slice/work/app/storage.py)

---

# Step 1 当前验证

已执行：

```powershell
python -m compileall .
```

已对支持集工程建立索引库：

- [testcases/step1/A_supported](/C:/Users/84003/Desktop/doc/0/code-slice/testcases/step1/A_supported)

当前支持集结果：

```text
IndexStats(
  files_indexed=4,
  functions_indexed=6,
  calls_indexed=6,
  global_definitions_indexed=3,
  type_definitions_indexed=5,
  global_symbol_refs_indexed=12
)
```

已人工抽查：

- 类型定义和字段已入库。
- `ctx = g_ctx; ctx->len` 能回挂到全局变量 `g_ctx`。
- 全局变量读写访问路径已进入反向索引。
- 函数、全局变量、类型定义的 `attached_comments` 已入库。

---

# Step 2：多策略代码切片

## 目标

Step 2 不应固定为单一切片算法，而应演进为多策略可选的切片层。

第一阶段支持两种策略：

- `path`：保留当前 DFS 调用路径切片。
- `local_subgraph`：新增预算约束下的不重复局部子图切片。

后续可以继续扩展（但是暂不考虑扩展）：

- `file_region`
- `manual_seed`

## 为什么保留旧 `path` 策略

旧 `path` 策略虽然会重复共享前缀，但仍有价值：

- 逻辑简单，当前已经实现并验证。
- 输出是一条线性调用链，便于阅读和调试。
- 对“沿某条调用链追踪问题”的场景直观。
- 可以作为新策略的基线对照。

因此不应直接删除或覆盖旧实现。

## 为什么新增 `local_subgraph` 策略

当调用图存在共享前缀或分发节点时，旧 `path` 策略容易重复函数片段。

例如：

```text
A
|- B
`- C
```

旧 `path` 可能生成：

```text
block 1: A -> B
block 2: A -> C
```

`local_subgraph` 目标是在预算允许时生成：

```text
block 1: {A, B, C}
```

它解决的是：

- 减少共享前缀重复。
- 保留局部调用区域。
- 让调度函数、分发函数和其直接上下游尽量在同一个上下文块中出现。

---

# Step 2 策略接口设计

## 推荐 API 参数

HTTP 和 CLI 都应显式暴露切片策略。

建议参数名：

```text
slicing_strategy
```

可选值：

```text
path
local_subgraph
```

默认值建议：

```text
path
```

原因：

- 保持现有行为不变。
- 降低回归风险。
- 用户可以主动选择新策略做对比。

## HTTP 示例

```text
POST /blocks/generate?slicing_strategy=path
POST /blocks/generate?slicing_strategy=local_subgraph

GET /blocks?persisted_only=false&slicing_strategy=path
GET /blocks?persisted_only=false&slicing_strategy=local_subgraph
```

## CLI 示例

```text
python -m app.cli --slicing-strategy path
python -m app.cli --slicing-strategy local_subgraph
```

## 内部函数建议

现有函数可以保留兼容：

```text
generate_path_blocks(...)
persist_path_blocks(...)
```

但内部应逐步新增通用入口：

```text
generate_blocks(conn, strategy="path", ...)
persist_blocks(conn, strategy="path", ...)
```

策略分发：

```text
generate_blocks:
  if strategy == "path":
    return generate_path_strategy_blocks(...)

  if strategy == "local_subgraph":
    return generate_local_subgraph_strategy_blocks(...)

  raise unknown strategy
```

第一阶段可以让旧入口继续调用 `strategy="path"`，避免破坏现有调用方。

---

# Step 2 策略一：`path`

## 语义

`path` 是当前已有策略。

它从无 caller 图根出发，沿调用边 DFS 展开，生成一条条调用路径块。

例如：

```text
A
|- B
`- C
```

可能生成：

```text
block 1: A -> B
block 2: A -> C
```

## 保留内容

继续保留：

- `_walk_paths()` 或等价的 path strategy 实现。
- `block_kind = "path"`。
- `path_function_ids` 表示线性路径上的函数 ID。
- `path_signature` 表示线性路径签名。
- `continuation_candidates` 表示路径截断后的候选续接点。

## 适用场景

- 想按调用链阅读代码。
- 想保留旧结果作为基线。
- 想对某条路径做线性上下文分析。

## 已知缺点

- 共享前缀会重复。
- 分发节点语义会被拆散。
- 在 fan-out 较大的入口处可能生成许多相似 block。

这些缺点由 `local_subgraph` 策略补足，而不是通过删除 `path` 策略解决。

---

# Step 2 策略二：`local_subgraph`

## 语义

`local_subgraph` 从 seed 函数开始，在预算允许范围内吸收它直接或间接调用到的函数，生成一个局部调用子图块。

第一版目标：

- 以函数为基本粒度，不做语句级切分。
- 每个 primary block 是一个预算约束下的局部调用子图。
- 同一个函数源码默认只完整进入一个 `local_subgraph` primary block。
- 共享前缀优先合并到同一个 block。
- 超预算或无法吸收的 callee 作为 boundary / continuation，后续再开新 block。

## 第一版不做

为了让实现可落地，第一版先不做：

- 语义 scoring。
- fan-out 软限制。
- 数据库表名迁移。
- Step 3 输出格式重构。

## 核心规则

```text
1. 一个函数源码最多完整进入一个 local_subgraph primary block。
2. 只有已经进入当前 block 的函数，才允许继续展开它的 callee。
```

第二条规则用于避免错误块：

```text
A -> B -> D
```

如果 `B` 因预算不足没有进入当前 block，不能生成：

```text
block 1: {A, D}
```

正确结果应是：

```text
block 1: {A}
boundary: {B}
block 2: {B, D}
```

## 最小可行算法

```text
generate_local_subgraph_blocks:
  covered = set()
  seed_queue = roots sorted by file, line, name, id
  blocks = []

  while seed_queue is not empty:
    seed = pop seed_queue

    if seed in covered:
      continue

    block, boundary = grow_block(seed, covered)

    if block is not empty:
      blocks.add(block)
      covered.add(all functions in block)

    for candidate in boundary:
      if candidate not in covered:
        seed_queue.add(candidate)

  remaining = functions not in covered
  blocks.add(repo_others(remaining))

  return blocks
```

```text
grow_block(seed, covered):
  block = []
  block_set = set()
  boundary = []
  expansion_queue = [seed]

  while expansion_queue is not empty:
    current = pop expansion_queue

    if current in block_set or current in covered:
      continue

    if current does not fit current budget:
      boundary.add(current)
      continue

    add current to block

    for callee in current callees sorted by call order:
      if callee in block_set or callee in covered:
        continue

      if callee fits current block budget:
        add callee to block
        expansion_queue.add(callee)
      else:
        boundary.add(callee)

  return block, boundary
```

最重要的实现约束：

```text
expansion_queue 只能接收已经进入 block 的函数。
boundary 中的函数不在当前 block 内继续展开。
```

## 稳定排序规则

root 排序：

```text
file path
start line
function name
function id
```

callee 排序：

```text
calls 表中的调用出现顺序
callee file path
callee start line
callee function id
```

boundary 排序：

```text
首次发现顺序
callee file path
callee start line
callee function id
```

## 预算规则

第一版沿用当前两个预算：

```text
MAX_FUNCTIONS_PER_BLOCK
MAX_TOTAL_LINES_PER_BLOCK
```

candidate 进入 block 前必须满足：

```text
len(block) + 1 <= MAX_FUNCTIONS_PER_BLOCK
current_total_lines + candidate.line_span <= MAX_TOTAL_LINES_PER_BLOCK
```

如果不满足：

```text
candidate -> boundary
```

不要先加入再裁剪。

---

# 输出结构与兼容策略

## 第一阶段

第一阶段不改数据库 schema。

保留旧字段：

- `PathBlock`
- `path_function_ids`
- `path_signature`
- `continuation_candidates`
- `path_blocks`
- `path_block_functions`
- `path_block_continuations`

但新增策略字段或复用现有字段时，要明确语义：

- `slicing_strategy = "path"`：`path_function_ids` 是线性路径。
- `slicing_strategy = "local_subgraph"`：`path_function_ids` 是 local subgraph block 内稳定排序的函数 ID。

如果短期内不新增数据库字段，可以先在 `block_kind` 中区分：

```text
block_kind = "path"
block_kind = "local_subgraph"
block_kind = "others"
```

更推荐新增：

```text
slicing_strategy TEXT NOT NULL DEFAULT 'path'
```

这样 `block_kind` 继续表达块类别，`slicing_strategy` 表达生成策略。

## 建议输出字段

长期建议统一为：

- `block_id`
- `block_kind`
- `slicing_strategy`
- `root_function_id`
- `root_function_name`
- `function_ids`
- `block_signature`
- `total_functions`
- `total_lines`
- `truncated`
- `truncation_reason`
- `continuation_candidates`
- `functions`
- `rendered_block`

但这应作为第二阶段迁移，不和新增 `local_subgraph` 策略混在一次改动里。

---

# 代码改造计划

## 阶段 1：策略分层，不改行为

目标：

- 保留现有 `path` 行为不变。
- 把当前 `_walk_paths()` 包装成 `path` strategy。
- 新增通用策略分发入口。

建议新增：

```text
generate_blocks(conn, strategy="path", ...)
generate_path_strategy_blocks(...)
```

现有：

```text
generate_path_blocks(...)
```

继续保留，并调用：

```text
generate_blocks(strategy="path")
```

## 阶段 2：新增 `local_subgraph` strategy

目标：

- 新增 `generate_local_subgraph_strategy_blocks(...)`。
- 新增 `grow_block(...)`。
- 新增 `can_admit(...)`。
- 新增 boundary 去重和 seed queue 续接。
- 不删除 `_walk_paths()`。

`path` 和 `local_subgraph` 两套实现应并行存在，代码结构清楚，不互相穿插。

## 阶段 3：HTTP / CLI 可选择策略

目标：

- `POST /blocks/generate` 支持 `slicing_strategy`。
- `GET /blocks` 在 `persisted_only=false` 时支持 `slicing_strategy`。
- CLI 支持 `--slicing-strategy`。
- 默认仍为 `path`。

## 阶段 4：持久化策略信息

目标：

- 数据库持久化记录本次 block 的 `slicing_strategy`。
- 查询时可按 strategy 过滤。
- 避免 `path` 和 `local_subgraph` 的 block 混在一起造成语义不清。

可选方案：

```text
方案 A：给 path_blocks 表新增 slicing_strategy 字段。
方案 B：生成时仍清空旧表，但每次只持久化一种 strategy。
```

推荐方案 A，但可以先用方案 B 快速落地。

## 阶段 5：Step 3 适配多策略

目标：

- Step 3 不再假设输入一定是线性调用链。
- 对 `path` 仍可输出 `function_chain`。
- 对 `local_subgraph` 应输出 `function_region` 或稳定函数列表。

第一阶段可以先复用 `path_function_ids`，但文档和测试要标明语义差异。

---

# Step 2 验证计划

## `path` 策略验证

继续保留现有验证：

```text
boot -> compute_limit
boot -> update_global_len -> mark_busy
boot -> dispatch_event -> default_worker
```

旧策略行为不应因为新增 `local_subgraph` 而变化。

## `local_subgraph` 策略验证

### 1. 共享前缀合并

```text
A -> B
A -> C
```

预算允许时：

```text
block 1: {A, B, C}
```

不应生成：

```text
block 1: {A, B}
block 2: {A, C}
```

### 2. 预算 boundary

```text
A -> B
A -> C
```

如果 `max_functions = 2`：

```text
block 1: {A, B}
boundary: {C}
block 2: {C}
```

### 3. 禁止穿透未吸收节点

```text
A -> B -> D
```

如果 `B` 没有进入当前 block：

```text
block 1: {A}
boundary: {B}
```

不允许：

```text
block 1: {A, D}
```

### 4. 当前支持集期望

`A_supported` 在 `local_subgraph` 策略下，预算允许时应倾向生成一个 primary local subgraph block：

```text
boot
compute_limit
update_global_len
dispatch_event
mark_busy
default_worker
```

`max_functions = 1` 时：

```text
block 1: boot
continuation_candidates:
  compute_limit
  update_global_len
  dispatch_event
```

后续 block 从这些 boundary 函数继续生成。

---

# Step 3：补充全局状态和类型定义

## 目标

在切片块基础上，只补充块内天然不包含、但又可能影响判断的链外信息。

Step 3 的核心输入不应该是“路径”，而应该是：

```text
block 内函数 ID 集合
```

因此，`path` 和 `local_subgraph` 都必须能接上 Step 3：

- `path` block 的函数集合来自线性路径。
- `local_subgraph` block 的函数集合来自局部子图。
- Step 3 对两者都执行同一套 globals/types 收集逻辑。

## 当前计划补充的内容

- 当前 block 涉及的全局变量定义。
- 操作这些全局变量的候选函数。
- 当前 block 涉及对象或全局状态的类型定义。
- 当前 block 涉及的关键字段定义。
- 必要时补充与 block 直接相关的注释、宏定义或声明上下文。

## 多策略适配原则

- Step 3 应消费统一 block 结构，而不是依赖具体策略内部实现。
- 对 `path`，可以保留线性 `function_chain` 展示。
- 对 `local_subgraph`，应避免把函数列表描述成唯一调用链。
- 全局变量和类型补充逻辑应基于 `function_ids`，与切片策略解耦。

## Step 2 到 Step 3 的连接契约

无论采用哪种切片策略，Step 2 输出给 Step 3 的 block 至少要包含：

- `block_id`
- `block_kind`
- `slicing_strategy`
- `root_function_id`
- `root_function_name`
- `function_ids` 或兼容期的 `path_function_ids`
- `functions`
- `total_functions`
- `total_lines`
- `continuation_candidates`

Step 3 只依赖函数集合做补充：

```text
function_ids -> global_symbol_refs -> global_definitions
function_ids + global definitions -> type_definitions / type_fields
```

这样 `local_subgraph` 不需要伪装成 path，也能继续补齐全局变量和类型定义。

兼容期规则：

- 如果 block 有 `function_ids`，Step 3 优先使用它。
- 如果没有 `function_ids`，Step 3 继续使用旧字段 `path_function_ids`。
- `path` 可以继续输出 `function_chain`。
- `local_subgraph` 应输出 `function_region` 或 `functions`，避免误导为线性调用链。

## Step 3 改造最小范围

为了接上 `local_subgraph`，Step 3 第一阶段只需要做最小改造：

- `_load_path_blocks(...)` 改成可按 `slicing_strategy` 加载 block。
- 读取函数 ID 时使用兼容 helper，例如 `get_block_function_ids(block)`。
- `_collect_globals(...)` 保持不变。
- `_collect_types(...)` 保持不变。
- `_build_context_payload(...)` 根据 strategy 选择 outline 字段：
  - `path`：`function_chain`
  - `local_subgraph`：`function_region`

不需要重写 globals/types 补充逻辑。

---

# Step 4：闭合判断

## 目标

判断当前 block 在加上必要的全局状态和类型信息后，是否已经足以支持一次有效的 LLM 分析。

可能结果：

- `closed`
- `needs_definition`
- `needs_continuation`
- `needs_global_state`

---

# Step 5：必要时继续扩展

当 Step 4 判断当前 block 仍不闭合时，按缺口类型补充下一轮上下文。

扩展动作：

- `ExpandDefinition`：补缺失的类型定义或全局变量定义。
- `ExpandContinuation`：沿 `continuation_candidates` 或 boundary 继续接下一个块。
- `ExpandGlobalState`：沿 `global_continuation_candidates` 继续补共享状态相关函数。

---

# Step 6：去重、压缩与最终打包

目标：

- 按 block signature 去重。
- 按入口函数、策略和局部区域组织块。
- 避免最终输入重复包含相同函数体。
- 控制最终交给模型的块数量和总体积。

多策略场景下，去重应区分：

- 同一策略内重复。
- 不同策略之间的重叠。
- 最终打包时是否允许同时包含 `path` 与 `local_subgraph` 结果。

---

# 最终给 LLM 的输入形态

最终输入单元应包含：

- 一个切片策略生成的 primary block。
- 该 block 涉及的必要全局状态定义。
- 该 block 涉及的必要类型定义。
- 若未闭合，则附带有限的 continuation / boundary 信息。

目标不是只押注一种切片方式，而是让系统支持按场景选择：

- 需要线性调用链时用 `path`。
- 需要减少重复并保留局部区域时用 `local_subgraph`。
- 后续有特殊分析任务时继续增加新策略。

---

# 用例集

当前已经建立两套小型 C 工程用例集：

- [testcases/step1/A_supported](/C:/Users/84003/Desktop/doc/0/code-slice/testcases/step1/A_supported)
- [testcases/step1/B_unsupported](/C:/Users/84003/Desktop/doc/0/code-slice/testcases/step1/B_unsupported)

总说明见：

- [testcases/step1/README.md](/C:/Users/84003/Desktop/doc/0/code-slice/testcases/step1/README.md)

---

# 总体验证计划

## Step 1

- 已有基础可运行验证。
- 已有样例库和支持集建库验证。
- 后续再补正式 benchmark。

## Step 2-6

后续需要分别验证：

- 各策略 block 覆盖率。
- 各策略函数体重复率。
- block 平均体积。
- continuation / boundary 续接成功率。
- 全局状态补充有效性。
- 去重后的块数量和信息保留度。
- LLM 对不同策略输出的分析稳定性。

---

# 研发排期草案

## Week 1

- 完成 Step 1 原型。
- 补齐类型定义索引。
- 补齐全局变量反向索引。
- 建立 A / B 两套语料。

## Week 2

- 实现图根识别。
- 实现旧版 `path` block 原型。
- 实现最大函数数 / 总行数预算截断。

## Week 3

- 把 Step 2 重构为多策略分发结构。
- 保留 `path` 策略行为不变。
- 新增 `local_subgraph` 策略入口和实现。
- 更新验证脚本，分别验证两种策略。

## Week 4

- HTTP / CLI 支持 `slicing_strategy` 参数。
- 持久化记录或区分 slicing strategy。
- 验证 Step 3 能消费不同策略输出。

## Week 5

- 实现闭合判断。
- 实现按需扩展。

## Week 6

- 实现去重、压缩、最终打包。
- 准备接入 LLM 分析。

---

# 当前判断

基于当前实现，最准确的说法是：

- Step 1 已具备函数 / 调用 / 类型 / 类型字段 / 全局状态 / 注释索引能力。
- Step 2 当前已有可用的 `path` 切片策略。
- 新的 `local_subgraph` 不应替换旧策略，而应作为第二种切片策略新增。
- 后续代码切片应做成多方式可选，每种策略有独立入口、独立语义和独立验证。

下一步重点是：

> 把 Step 2 从单一 `generate_path_blocks()` 演进为策略化 slicing 层；默认保留 `path`，新增 `local_subgraph`，并通过 `slicing_strategy` 参数选择。
