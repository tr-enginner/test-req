# 调用图切片方法论：预算约束下的局部子图覆盖

## 1. 背景

当前 Step 2 的主块生成策略，本质上是：

> 从 root 出发，沿单条调用路径 DFS，生成 path block。

例如调用关系是：

```text
A
|- B
`- C
```

旧策略容易生成：

```text
block 1: A -> B
block 2: A -> C
```

这会带来两个问题：

- 共享前缀 `A` 被重复放进多个块，造成冗余分析
- `A` 作为调度点、编排点、分发点的整体语义被拆散

对于 LLM 上下文来说，单条路径不一定是最好的上下文单位。

更合适的单位应当是：

> 预算范围内的局部调用子图。

也就是：

```text
block: {A, B, C}
```

这个块不再表示一条线性路径，而表示一个以 `A` 为入口的局部调用区域。


## 2. 目标

新的切片方法希望达到：

- 减少共享前缀重复
- 保留局部调用结构
- 控制每个块的大小
- 让 Step 3 获得更稳定、更少重复的上下文
- 为后续 token 预算、复杂度预算、语义权重等扩展留接口

核心变化是：

> 从 path decomposition 转向 budget-constrained local graph cover。

即：

- 旧策略：把调用图拆成若干路径
- 新策略：把调用图覆盖成若干预算受控的局部子图


## 3. 问题抽象

给定调用图：

```text
G = (V, E)
```

其中：

- `V` 是函数节点集合
- `E` 是调用边集合
- `cost(v)` 是函数节点代价，例如代码行数、token 数、复杂度

目标是生成一组 block：

```text
B1, B2, ..., Bn
```

每个 block 是调用图上的一个局部区域：

```text
B = (VB, EB)
VB ⊆ V
EB = {(u, v) ∈ E | u ∈ VB and v ∈ VB}
```

每个 block 必须满足预算约束：

```text
|VB| <= MAX_FUNCTIONS_PER_BLOCK
sum(cost(v) for v in VB) <= MAX_TOTAL_LINES_PER_BLOCK
```

可以把 block 质量理解为一个优化目标：

```text
maximize:
  internal_edges(B)
  + locality_score(B)
  - duplication_penalty(B)
  - boundary_penalty(B)
```

直观解释：

- `internal_edges`：块内保留下来的调用边越多越好
- `locality_score`：函数越局部相关越好
- `duplication_penalty`：跨块重复越少越好
- `boundary_penalty`：被切断的调用边越少越好

这个定义的重点是：

> DFS 或 BFS 不是方法论本身，只是候选节点访问顺序。

真正需要稳定定义的是：

- seed 如何选择
- frontier 如何排序
- candidate 如何准入
- boundary 如何接续


## 4. 基本方法：Region Growing + Boundary Cut

推荐使用：

> Region Growing + Boundary Cut。

也就是从一个 seed 函数开始，在预算允许范围内向外吸收邻居函数，形成一个局部调用区域。

当某些候选函数无法被当前 block 吸收时，它们不再进入当前 block，而是成为 boundary。

整体过程：

```text
1. 选择一个 seed
2. 初始化 block = {seed}
3. 初始化 frontier = seed 的 callees
4. 从 frontier 中选择最适合的 candidate
5. 如果 candidate 通过 admission policy，则吸收进 block
6. 如果 candidate 未通过 admission policy，则进入 boundary
7. 重复扩张，直到当前 block 无法继续吸收
8. 从 boundary 或其他未覆盖节点继续生成后续 block
```

这里的关键不是“用 BFS 还是 DFS”，而是：

> 每一次扩张都必须经过 candidate scoring 和 budgeted admission。


## 5. 四个核心策略

### 5.1 Seed Selection

seed 是一个 block 的起点。

第一版推荐：

```text
1. 优先从图 root 开始
2. 然后处理上一批 block 留下的 boundary
3. 最后处理仍未覆盖的孤立函数或剩余函数
```

图 root 仍然可以沿用现有定义：

```text
没有 caller 的函数
```

但是 continuation root 的语义需要变化。

旧语义：

```text
某条路径被截断后的下一个节点
```

新语义：

```text
上一个局部子图的 boundary seed
```

也就是说，continuation 不再依附于“路径”，而是依附于“局部子图边界”。


### 5.2 Candidate Scoring

frontier 中可能同时存在多个 candidate。

候选函数不应该只按 DFS 顺序被动进入 block，而应该有一个稳定评分。

通用形式：

```text
score(v | B) =
  α * internal_connectivity(v, B)
+ β * call_order_locality(v, B)
+ γ * file_locality(v, B)
+ δ * semantic_priority(v)
- λ * cost(v)
- μ * duplication_penalty(v)
```

含义：

- `internal_connectivity(v, B)`：候选函数与当前 block 已有函数的连接越多，越优先
- `call_order_locality(v, B)`：调用出现顺序越靠近当前上下文，越优先
- `file_locality(v, B)`：同文件或相近文件中的函数，越优先
- `semantic_priority(v)`：调度函数、核心业务函数、导出函数等可获得更高权重
- `cost(v)`：函数越大，吸收成本越高
- `duplication_penalty(v)`：已经被其他 block 覆盖过，优先级降低

第一版不需要实现复杂打分。

可以先采用稳定排序：

```text
1. 调用出现顺序
2. 文件路径
3. 起始行号
4. function_id
```

这样先保证输出稳定，再逐步升级 scoring。


### 5.3 Budgeted Admission

admission policy 决定 candidate 能不能进入当前 block。

这是规模控制的唯一入口。

推荐第一版准入顺序：

```text
1. candidate 已在当前 block 中：跳过
2. candidate 超过全局重复策略：放入 boundary
3. 加入后超过 MAX_FUNCTIONS_PER_BLOCK：放入 boundary
4. 加入后超过 MAX_TOTAL_LINES_PER_BLOCK：放入 boundary
5. 否则吸收进 block
```

最重要的规则是：

> 只有已经被当前 block 吸收的函数，才允许继续展开它的 callee。

这条规则必须成立。

否则会出现一种错误情况：

```text
A -> B -> D
```

如果 `B` 因为预算没进当前 block，但算法继续展开 `B`，把 `D` 放进了当前 block，那么当前 block 就会变成：

```text
{A, D}
```

这在调用语义上是不完整的。

因此：

- 被预算拒绝的 candidate 不继续展开
- 被重复策略拒绝的 candidate 不继续展开
- boundary 只是后续 block 的候选入口
- boundary 不是当前 block 的隐藏扩展点


### 5.4 Boundary Continuation

boundary 是当前 block 无法吸收、但与当前 block 有调用关系的函数集合。

定义：

```text
Boundary(B) = {v ∉ VB | ∃u ∈ VB, (u, v) ∈ E}
```

boundary 产生原因包括：

- 超过函数数量预算
- 超过总代码行数预算
- 超过跨块重复限制
- fan-out 太大，被策略延后
- 后续语义策略主动切分

boundary 可以成为后续 block 的 seed。

因此，`continuation_candidates` 更准确的语义是：

```text
当前局部子图的未吸收边界入口
```

而不是：

```text
当前路径的下一跳
```


## 6. 规模控制

### 6.1 硬预算

第一版保留两个硬预算：

```text
MAX_FUNCTIONS_PER_BLOCK
MAX_TOTAL_LINES_PER_BLOCK
```

它们必须在 admission policy 中强制执行。

任何 candidate 进入 block 前都要检查：

```text
next_function_count <= MAX_FUNCTIONS_PER_BLOCK
next_total_lines <= MAX_TOTAL_LINES_PER_BLOCK
```

如果不满足：

```text
candidate -> boundary
```

而不是：

```text
candidate -> block -> 再裁剪
```

也就是说，切片应该是“准入前控制”，不是“生成后裁剪”。


### 6.2 可扩展预算

后续可以加入更多预算：

```text
MAX_TOTAL_TOKENS_PER_BLOCK
MAX_COMPLEXITY_PER_BLOCK
MAX_BLOCK_DEPTH
MAX_FRONTIER_WIDTH
MAX_DIRECT_CALLEES_ABSORBED_PER_FUNCTION
```

这些预算都应接入同一个 admission policy。

这样模型不会因为新增限制而重写。

例如：

```text
admit(candidate, block, policy):
  check_duplicate()
  check_function_count()
  check_line_budget()
  check_token_budget()
  check_depth_budget()
  check_frontier_width()
```


### 6.3 fan-out 控制

高 fan-out 函数是局部子图策略最容易失控的地方。

例如：

```text
A 调用了 40 个函数
```

即使每个函数都很短，也不一定应该全部进入同一个 block。

可以引入软限制：

```text
MAX_DIRECT_CALLEES_ABSORBED_PER_FUNCTION
```

第一版可以暂不启用。

但方法论上要预留这个位置。

当 fan-out 过大时，优先吸收：

```text
1. 同文件 callee
2. 调用顺序靠前的 callee
3. 与当前 block 已有节点连接更多的 callee
4. 未被其他 block 覆盖的 callee
```

剩余 callee 进入 boundary。


## 7. 重复控制

局部子图可以减少共享前缀重复，但不能完全消除跨块重复。

尤其是：

```text
A -> X
B -> X
```

`X` 是多个上游共享的函数。

这里不建议强行做到全局零重复。

更合理的是：

> block 内零重复，block 间受控重复。

推荐策略：

```text
block 内：
  同一函数只能出现一次

block 间：
  默认允许重复，但通过 scoring 和 admission 降低优先级

全局：
  可维护 function_emit_count，用于限制重复次数
```

第一版可采用：

```text
MAX_CROSS_BLOCK_DUPLICATION = 1 或 2
```

如果一个函数已经被完整覆盖过，再次遇到时可以：

```text
1. 不放入当前 block
2. 放入 boundary/reference
3. 在 rendered_block 中只记录引用关系
```

这样可以避免工具函数、公共函数在大量 block 中反复展开。


## 8. 输出语义

如果继续沿用现有 `PathBlock` 结构，需要逐步调整字段语义。

### 8.1 建议保留

- `block_id`
- `block_kind`
- `root_function_id`
- `root_function_name`
- `total_functions`
- `total_lines`
- `truncated`
- `truncation_reason`
- `continuation_candidates`
- `functions`
- `rendered_block`


### 8.2 建议改名

#### `path_function_ids`

当前名字会误导，因为 block 不再是 path。

建议改为：

```text
function_ids
```


#### `path_signature`

当前语义是线性 path。

局部子图不适合继续使用 path signature。

建议改为：

```text
block_signature
```

构造方式可以是：

```text
root_id + stable ordered function_ids
```

或者：

```text
hash(root_id, sorted(function_ids), internal_edges)
```


#### `depth`

如果保留，需要重新定义为：

```text
块内函数距离 root 的最大调用层级
```

如果实现成本高，也可以先删除或置为近似值。


### 8.3 `truncated` 的新语义

旧语义：

```text
路径因为预算不足被截断
```

新语义：

```text
局部子图存在未吸收的 boundary
```

对应的 `truncation_reason` 可以是：

```text
max_functions
max_total_lines
duplication_limit
fanout_limit
depth_limit
mixed_boundary
```


## 9. 推荐伪代码

```text
generate_blocks(call_graph):
  blocks = []
  covered = {}
  seed_queue = roots(call_graph)

  while seed_queue is not empty:
    seed = pop_seed(seed_queue)

    if should_skip_seed(seed, covered):
      continue

    block, boundary = grow_block(seed, covered)
    blocks.add(block)
    mark_covered(block, covered)

    for node in boundary:
      if should_enqueue_boundary(node, covered):
        seed_queue.add(node)

  remaining = functions_not_covered(call_graph, covered)
  blocks.add(repo_others(remaining))

  return blocks
```

```text
grow_block(seed, covered):
  block = {}
  expansion_queue = [seed]
  boundary = {}

  while expansion_queue is not empty:
    current = pop(expansion_queue)

    if current not in block:
      if not admit(current, block, covered):
        boundary.add(current)
        continue

      block.add(current)

    candidates = callees(current)
    candidates = score_and_sort(candidates, block, covered)

    for candidate in candidates:
      if candidate in block:
        continue

      if admit(candidate, block, covered):
        block.add(candidate)
        expansion_queue.push(candidate)
      else:
        boundary.add(candidate)

  return block, boundary
```

必须保证：

```text
expansion_queue 只接收已经进入 block 的函数
boundary 中的函数不在当前 block 内继续展开
admit() 是所有规模限制的入口
score_and_sort() 是后续质量优化的入口
```


## 10. 示例

### 示例 1：共享前缀

调用关系：

```text
A
|- B
`- C
```

旧策略：

```text
block 1: A -> B
block 2: A -> C
```

新策略：

```text
block 1: {A, B, C}
```


### 示例 2：预算内局部子图

调用关系：

```text
A
|- B
|  `- D
`- C
   `- E
```

如果预算允许：

```text
block 1: {A, B, C, D, E}
```


### 示例 3：预算不足

调用关系：

```text
A
|- B
|  `- D
`- C
   `- E
      `- F
```

如果当前 block 只能容纳：

```text
{A, B, C, D, E}
```

则：

```text
block 1: {A, B, C, D, E}
boundary: {F}
block 2: 从 F 继续生成
```


### 示例 4：禁止下游偷渡

调用关系：

```text
A -> B -> D
```

如果 `B` 因为预算不足无法进入当前 block，那么 `D` 也不能通过 `B` 被展开进当前 block。

正确结果：

```text
block 1: {A}
boundary: {B}
```

后续：

```text
block 2: 从 B 继续生成，可能得到 {B, D}
```

错误结果：

```text
block 1: {A, D}
```

这个结果破坏了调用语义，必须避免。


## 11. 与当前实现的差异

当前实现主要特征：

- DFS
- 每个 block 是单条路径
- 共享前缀会跨 block 重复
- continuation 表示路径下一跳

新方法主要特征：

- region growing
- 每个 block 是局部调用子图
- 共享前缀优先在同一 block 中合并
- boundary 表示局部子图未吸收边界
- continuation 从 boundary 中产生

所以这不是简单调参。

它是 block model 的变化。


## 12. 实现演进建议

建议分阶段推进。

### 阶段 1：稳定替换 block grower

目标：

- 用 `grow_block()` 替换 `_walk_paths()`
- 保留现有 `MAX_FUNCTIONS_PER_BLOCK`
- 保留现有 `MAX_TOTAL_LINES_PER_BLOCK`
- 保留现有输出字段，先兼容下游

这一阶段只解决：

```text
path block -> local subgraph block
```


### 阶段 2：字段语义升级

目标：

- `path_function_ids` 改为 `function_ids`
- `path_signature` 改为 `block_signature`
- `continuation_candidates` 改为 boundary 语义
- `truncated` 改为 boundary 存在语义


### 阶段 3：引入可扩展策略

目标：

- 引入 candidate scoring
- 引入跨块重复限制
- 引入 token 预算
- 引入 fan-out 控制
- 引入 block depth 控制


## 13. 当前决策建议

建议把新的 Step 2 切片策略正式定义为：

> 使用预算约束的局部图区域增长算法，将调用图分解为一组低边界、低重复、预算内的语义局部子图块；block 生成由 seed selection、candidate scoring、budgeted admission 和 boundary continuation 四个策略组成。

这个定义足够抽象，能支持后续扩展。

同时也足够具体，可以直接落到现有 `path_blocks.py` 的实现改造中。
