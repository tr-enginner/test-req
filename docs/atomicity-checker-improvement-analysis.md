# 多变量原子性违反检测——改进分析报告

> 文档版本：2026-03-11
> 分析范围：全链路（Joern Scala 脚本 → Tool A/B/C/D → Agent 工作流）
> 分析方法：逐层代码审查 + 边界情况推导 + 真实项目验证数据对比

---

## 目录

- [执行摘要](#执行摘要)
- [改进问题总览](#改进问题总览)
- [L1：Joern Scala 脚本层（multivarCorrelatedVarsIdentify.scala）](#l1joern-scala-脚本层)
- [L2：Tool B — 关联变量识别（multivar-correlated-vars.ts）](#l2tool-b--关联变量识别)
- [L3：Tool C — 违反模式检测（multivar-violation-detect.ts）](#l3tool-c--违反模式检测)
- [L4：Tool D — 可行性验证（multivar-feasibility-verify.ts）](#l4tool-d--可行性验证)
- [L5：Agent 工作流层（multivar-atomicity-checker.ts）](#l5agent-工作流层)
- [L6：架构层设计问题](#l6架构层设计问题)
- [改进优先级排序与实施建议](#改进优先级排序与实施建议)

---

## 执行摘要

经过对全链路代码的逐层深入分析，共识别 25 项改进问题：

| 类别 | 总数 | 已修复 | 待定 | 典型影响 |
|------|------|--------|------|---------|
| **正确性缺陷**（可能产生错误结果） | 7 | 5（+1回退） | 0 | 漏报、误报、错误分类 |
| **精度局限**（合理简化但可改进） | 8 | 6 | 2 | UNKNOWN 比例偏高、部分真实违反被漏检 |
| **鲁棒性问题**（边界情况未处理） | 5 | 3（+1无需修改） | 1 | 大型项目崩溃或超时 |
| **设计耦合**（架构层面） | 4 | 3 | 1 | 维护难度高、扩展困难 |

**实施状态总览**：25 项中 **19 项已修复**，1 项已验证无需修改，1 项已回退（Joern 限制），3 项待定（架构级/框架限制），1 项验证后确认不需修改。

**已修复的 P0 最高优先级问题**：
1. ~~**TUP 滑动窗口遗漏非相邻写对**（L1-01）~~：**已修复** — TUP combinations() 改造
2. ~~**DAC 行号归位的脆弱性**（L2-01）~~：**已修复** — 行号归位 + 锚点位置 + 命名启发式三级回退
3. ~~**短路约束提取的同行限制**（L4-02）~~：**已修复** — 移除同行限制
4. ~~**初始化阶段函数误报**（L4-06）~~：**已修复** — init_functions 参数 + Agent 自动检测

**仍待定的问题**：
1. **Z3 编码仅支持线性整数**（L4-01）：非线性条件全部降级为 UNKNOWN（架构级重写）
2. **LLM 温度 0.2 过于保守**（L5-02）：框架限制
3. **三次 Joern 调用缺乏批处理**（L6-01）：架构级重构

---

## 改进问题总览

| ID | 层 | 标题 | 类别 | 优先级 | 状态 |
|----|-----|------|------|--------|------|
| L1-01 | Scala | TUP 滑动窗口只捕获相邻写对，遗漏间隔写对 | 正确性 | P0 | **已修复** |
| L1-02 | Scala | DAC 统计字段 `saa` 仍可能在多 child 场景下重复计数 | 正确性 | P1 | **已修复** |
| L1-03 | Scala | `determineAccessType` 对复杂 LHS 的识别不完整 | 精度 | P1 | **已修复** |
| L1-04 | Scala | `isConstant` 常量识别存在命名假设盲区 | 精度 | P2 | **已修复** |
| L1-05 | Scala | `removeDuplicate` 的 endsWith 语义会误删不同前缀的合法轨迹 | 正确性 | P1 | **已修复** |
| L1-06 | Scala | `combine()` 截断 MAX_COMBINE=500 静默丢弃变量组合 | 鲁棒性 | P2 | 已验证无需修改 |
| L1-07 | Scala | 共享变量识别不区分同名局部变量与全局变量 | 正确性 | P1 | **已回退**（Joern 无编译数据库时 local 节点包含全局变量） |
| L2-01 | Tool B | DAC 全读访问场景下行号归位的脆弱性 | 正确性 | P0 | **已修复** |
| L2-02 | Tool B | DFC 跨函数分裂后子组重分类的锚点类型可能不准确 | 精度 | P2 | **已修复** |
| L2-03 | Tool B | `estimateDependencyDepth` 从文本估算深度，精度低 | 精度 | P2 | **已修复**（缩减为 0~0.05 二级） |
| L3-01 | Tool C | CPG 全局查询的变量访问仍可能跨上下文污染 | 正确性 | P1 | **已修复** |
| L3-02 | Tool C | 无优先级配置时 ISR↔ISR 双向保守假设产生大量候选 | 精度 | P1 | **已修复** |
| L3-03 | Tool C | `getConsecutiveAccessPairs` 基于行号序的连续性假设可能错误 | 精度 | P1 | **已修复** |
| L3-04 | Tool C | 去重键未包含列号，同行多访问可能被误判为重复 | 正确性 | P2 | **已修复** |
| L4-01 | Tool D | Z3 仅支持 QF_LIA，非线性条件退化为自由变量（保守但不精确） | 精度 | P1 | 待定（架构级重写） |
| L4-02 | Tool D | 短路约束提取仅限同行两访问，大量合法约束被丢弃 | 精度 | P0 | **已修复** |
| L4-03 | Tool D | Joern CFG BFS 上限 2000 节点对大型函数可能不足 | 鲁棒性 | P1 | **已修复** |
| L4-04 | Tool D | 多调用点时只取首个调用点条件，可能丢失可行性约束 | 精度 | P2 | **已修复**（添加警告注释） |
| L4-05 | Tool D | 中断使能分析依赖 API 名称匹配，无法处理宏包装的禁用 | 精度 | P2 | **已修复**（wrapper 函数自动解析） |
| L5-01 | Agent | Step 3.5 大体量策略的截断点（80 个 DAC 锚点）无动态调整 | 鲁棒性 | P2 | **已修复**（动态分批截断） |
| L5-02 | Agent | LLM 温度 0.2 在评估 DAC 语义时可能导致评分过于保守 | 精度 | P3 | 待定（框架限制） |
| L6-01 | 架构 | Tool C 对 CPG 的两次 Joern 调用（查询访问 + 路径分析）缺乏批处理 | 鲁棒性 | P1 | 待定（架构级重构） |
| L6-02 | 架构 | multivar-correlated-groups.json 被 Agent Step 3.5 原地修改，缺乏版本追踪 | 设计 | P2 | **已修复**（分离 raw/refined 存储） |
| L6-03 | 架构 | pipeline 缺乏端到端进度可观测性 | 设计 | P2 | **已修复**（Agent 进度汇报指令） |
| L6-04 | 架构 | 缺少对 Keil C51 等方言的 ISR 入口自动发现 | 设计 | P2 | **已修复**（Step 1 ISR 完整性验证） |
| L4-06 | Tool D | 初始化阶段函数的违反未排除，导致大量误报 | 正确性 | P0 | **已修复**（init_functions 参数 + Agent 自动检测） |

---

## L1：Joern Scala 脚本层

### L1-01 ★ TUP 滑动窗口只捕获相邻写对，遗漏非相邻写对（P0）

**问题位置**：`multivarCorrelatedVarsIdentify.scala` — TUP BasicBlock 写对识别逻辑

**问题描述**：

TUP 的滑动窗口实现遍历排序后的全局写列表，仅捕获相邻的 `(i, i+1)` 对：

```scala
for (windowEnd <- 1 until sorted.size) {
  while (windowStart < windowEnd &&
         sorted(windowEnd)._3 - sorted(windowStart)._3 > MAX_WRITE_GAP) {
    windowStart += 1
  }
  // 只匹配 sorted[windowEnd] 和 sorted[windowEnd-1]（最近一次写）
  // sorted[windowEnd] 和 sorted[windowStart] 之间的非相邻对被遗漏
}
```

考虑以下代码：

```c
// BB 内的三个连续全局写
Time.S  = new_seconds;   // L10
counter = 0;             // L12（不相关的写，干扰了窗口）
Time.MS = new_millis;    // L14
```

若 `counter` 也是全局变量，滑动窗口会生成 `(Time.S, counter)` 和 `(counter, Time.MS)` 两对，**但不会生成 `(Time.S, Time.MS)` 对**——而后者才是真正的 TUP 事务。

**影响**：这是 TUP 模式的系统性漏检，当两个事务变量之间存在其他全局变量的写操作（哪怕是 `counter++`）时，核心的事务对会被完全错过。

**建议修复**：

改用 `combinations(2)` 枚举窗口内所有变量对，而非只取相邻对：

```scala
// 在 MAX_WRITE_GAP 窗口内收集到的所有全局写
val windowWrites = sorted.slice(windowStart, windowEnd + 1)

// 枚举窗口内所有两两组合（不仅是相邻对）
for {
  i <- windowWrites.indices
  j <- (i + 1) until windowWrites.size
  (exprI, nodeI, lineI) = windowWrites(i)
  (exprJ, nodeJ, lineJ) = windowWrites(j)
  if exprI != exprJ  // 不同变量
  if lineJ - lineI <= MAX_WRITE_GAP
} {
  // 生成 (i, j) 对
}
```

同时需要在 Tool B 的 `computeTransactionalScore` 中对非相邻的 TUP 组适当降低 `line_proximity` 分数以区分优先级。

---

### L1-02 DAC `saa` 统计字段在多 child 场景下重复计数（P1）

**问题描述**：

Fix-11 将 `saa` 改为 BB 级别计数，但 DAC 的识别逻辑按 `(control, controlledNode)` 对迭代，同一个控制结构的多个 child 节点都会触发 `statistics.saa += 1`：

```scala
childrenSubList.foreach(controlled => {
  val controlledVar2Path = collectVariable(controlled, ...)
  if (controlledVar2Path.nonEmpty) {
    // 每个非空 child 都增加一次 saa
    statistics.saa += 1  // 同一 if 语句 → 3 个 child → saa+3
  }
})
```

**影响**：`Stats.saa`（共享访问锚点数）偏高，报告中的分析环境统计数据不准确，但不影响检测正确性。

**建议修复**：在 `control` 节点层面增加一次计数，而非在每个 child 层面：

```scala
var currentDacCount = statistics.dac
childrenSubList.foreach(controlled => { ... })
if (statistics.dac > currentDacCount) statistics.saa += 1  // 只当有新 DAC 对时才增
```

---

### L1-03 `determineAccessType` 对复杂 LHS 的识别不完整（P1）

**问题描述**：

`determineAccessType` 通过检查 AST 父节点的 `argument(1)` 来判断是否为写操作：

```scala
def determineAccessType(node: AstNode): String = {
  node.astParent match {
    case call: Call if call.name == "<operator>.assignment" =>
      if (call.argument(1) == node) "WRITE" else "READ"
    // ...
  }
}
```

但以下合法的 WRITE 场景会被误识别为 READ：

```c
(*ptr_array)[i] = value;    // 间接寻址数组元素
struct_array[idx].field = 5; // 结构体数组成员
```

在这些情况下，节点可能不直接是 `argument(1)`，而是更深层的 AST 子节点。

**影响**：某些 WRITE 操作被错误标记为 READ，导致 TUP 组的写操作数量被低估，TUP 评分的 `struct_members` 等维度可能错误计算；也会影响 DAC 角色分配中对 DECISION/ACTION 的判断。

**建议修复**：改为向上遍历整个 AST 父链，检查是否位于任意赋值运算符的 LHS 子树：

```scala
def isOnLhsOfAssignment(node: AstNode): Boolean = {
  var current = node
  while (current.astParent.hasNext) {
    val parent = current.astParent.next()
    parent match {
      case call: Call if isAssignmentOp(call.name) =>
        return call.argument(1).id == current.id ||
               isAncestor(call.argument(1), current)
      case _: Method => return false  // 到达函数边界
      case _ => current = parent
    }
  }
  false
}
```

---

### L1-04 `isConstant` 常量识别存在命名假设盲区（P2）

**问题描述**：

`isConstant` 使用 ALL_CAPS 命名约定来识别常量标识符：

```scala
val looksLikeConstant = name.matches("^[A-Z][A-Z0-9_]*$") && name.length > 1
```

但在实际嵌入式代码中，存在大量不符合此约定的常量：

```c
#define maxSpeed    200         // 小写宏（不匹配 ALL_CAPS）
#define Threshold   0.85        // 首字母大写宏
const int arraySize = 64;      // const 变量（没有 ALL_CAPS）
enum Status { Active, Idle };  // 首字母大写枚举
```

**影响**：这些常量被误判为变量，导致 DAC 的 `collectVariablesComparedWithConstant()` 函数将 `if (sensor > maxSpeed)` 中的 `maxSpeed` 误当作共享变量参与配对，产生虚假的 DAC 关联组。

**建议修复**：增加 `const` 修饰符检测和宏展开值检查：

```scala
// 检查 CPG 中变量是否被标注为 const
val isConstDecl = id.refOut.collectAll[Local].exists(_.typeFullName.startsWith("const ")) ||
                  id.refOut.collectAll[Member].exists(_.typeFullName.startsWith("const "))
```

---

### L1-05 `removeDuplicate` 的 endsWith 语义误删合法轨迹（P1）

**问题描述**：

去重时使用 `newTrace.endsWith(cachedTrace)` 判断是否重复：

```scala
if (!traceLineStr.endsWith(candidateTraceLineStr)) {
  matched = false
}
```

这意味着如果缓存中已有轨迹 `"L9"（变量在 L9 使用）`，新轨迹 `"L15,L9"（变量先在 L15 赋值，再在 L9 使用）` 会被认为是重复而丢弃。但这两条轨迹代表完全不同的数据流路径——前者变量值来源不确定，后者变量已在 L15 被写入。

**影响**：具有不同数据流前缀的访问对被错误合并，可能导致漏检某些具有特定数据流路径的违反。

**建议修复**：改用完整轨迹的精确匹配，或改为集合相似度比较：

```scala
// 改为完整轨迹比较
if (traceLineStr != candidateTraceLineStr) {
  matched = false
}
```

或保持更宽松的哈希集合去重（仅以变量集合 + 入口函数去重，而非轨迹匹配）。

---

### L1-06 `combine()` 截断 MAX_COMBINE=500 静默丢弃组合（P2）

**问题描述**：

```scala
val MAX_COMBINE = 500
def combine(varPairsList: ListBuffer[List[VariableTrace]]): List[Map[String, VariableTrace]] = {
  if (result.length > MAX_COMBINE) return result.take(MAX_COMBINE)  // 静默截断
}
```

在涉及大量全局变量的复杂模块中（如状态机、通信协议栈），笛卡尔积组合可能轻易超过 500，截断后丢失的组合不会有任何日志提示。

**影响**：大型项目中某些关联变量对被静默丢弃，存在漏检风险，且难以诊断。

**建议修复**：至少记录警告日志，可选地实现基于变量置信度的优先级截断：

```scala
if (result.length > MAX_COMBINE) {
  // 记录日志供诊断
  println(s"[WARN] combine(): truncated ${result.length} combinations to $MAX_COMBINE")
  return result.take(MAX_COMBINE)
}
```

---

### L1-07 共享变量识别不区分同名局部变量与全局变量（P1）

**问题描述**：

`getSharedVariables` 通过变量名（字符串）来识别共享访问：

```scala
val allIdentifiers = func.body.ast.isIdentifier.name.toSet
if (allGlobalVars.contains(identifierName)) { ... }
```

但当函数内有与全局变量同名的局部变量时（变量遮蔽），局部变量的访问会被误统计为全局变量访问：

```c
int g_counter = 0;  // 全局变量

void processA() {
  int g_counter = 5;  // 局部变量遮蔽全局变量
  g_counter++;        // 这是局部变量的访问，但被误统计为全局访问
}
```

**影响**：`processA` 被错误地认为"访问了全局变量 g_counter"，导致与真正访问全局 g_counter 的 ISR 产生虚假的共享访问关系，最终产生误报。

**建议修复**：利用 CPG 的引用信息（`refOut`）区分局部变量和全局变量：

```scala
func.body.ast.isIdentifier
  .filter(id => id.refOut.collectAll[Local].isEmpty)  // 排除有本地定义的标识符
  .name.filter(allGlobalVars.contains).toSet
```

---

## L2：Tool B — 关联变量识别

### L2-01 ★ DAC 全读场景下行号归位的脆弱性（P0）

**问题描述**：

当 Joern 将 DAC 组的所有访问都报告为 READ（函数参数传递、非赋值使用时 Joern 常见行为），Tool B 通过**行号顺序**来推断 DECISION（条件变量，行号更小）和 ACTION（体变量，行号更大）：

```typescript
// Case 2: 所有访问都是 READ
const minLine = Math.min(...varMinLine.values())
const decisionNames = new Set(
  [...varMinLine.entries()]
    .filter(([, line]) => line === minLine)
    .map(([name]) => name),
)
```

但这个假设在以下常见场景下是错误的：

**场景 1：条件和体在同一行（宏展开或紧凑格式）**

```c
if (ready) process(buffer);  // ready 和 buffer 都在同一行 → minLine 相同 → 分配失败
```

此时 `decisionNames.size === varMinLine.size`，代码回退到命名启发式猜测，而非使用 Joern 的 CPG 结构信息。

**场景 2：体中有先于条件的访问（循环体引用外层条件）**

```c
do {
  process(buffer);          // L10: buffer 访问（ACTION，但行号更小！）
} while (data_ready);       // L15: data_ready 条件（DECISION，但行号更大）
```

此时 `buffer` 的行号（L10）小于 `data_ready` 的行号（L15），导致 DECISION 和 ACTION 完全反转。

**影响**：DECISION/ACTION 分配错误是 DAC 违反模式匹配（matchDacRWWW、matchDacRWWR）的核心输入，角色错误会导致模式匹配使用错误的访问类型（本应查找 READ(decision) + WRITE/READ(action)，却反过来匹配），产生系统性漏检或误报。

**建议修复**：

优先使用 Joern 的 CPG 结构信息（控制结构 AST）而非行号启发式。Tool A 应请求 Joern 脚本直接标注每个访问的 `role`（`condition_var` vs `body_var`），而非在 TypeScript 层猜测：

```scala
// 在 Joern 脚本中直接标注角色
val conditionRole = "condition_var"
val bodyRole = "body_var"
// 输出时携带角色信息
{"ExprText": "data_ready", "Role": "condition_var", ...}
{"ExprText": "buffer", "Role": "body_var", ...}
```

在修复 Joern 输出前的临时缓解措施：利用 CPG 的 `enclosing_conditions` 信息（Tool D 已有此能力），在 Tool B 评分时对行号反转的 DAC 组降低信心：

```typescript
// 如果条件变量行号 > 所有体变量行号，标记为可疑
if (decisionMinLine > actionMaxLine) {
  group.evidence.role_assignment_risk = -0.10  // 惩罚项
}
```

---

### L2-02 DFC 跨函数分裂后子组重分类的精度问题（P2）

**问题描述**：

DFC 跨函数组被分裂为按函数的子组后，每个子组通过 `inferAnchorType()` 重新分类。但 `inferAnchorType` 只看访问的读写模式，而子组中只有该函数的本地访问，可能缺乏上下文：

```
原始 DFC 组: [funcA中: READ(x), READ(y)] + [funcB中: WRITE(x), WRITE(y)]
→ 分裂后:
  子组0 (funcA): [READ(x), READ(y)] → inferAnchorType → DFC（读操作无法确定是否事务）
  子组1 (funcB): [WRITE(x), WRITE(y)] → inferAnchorType → TUP（两个写 → 事务？）
```

但子组1 中的两个写可能并非事务更新，而是在不同的上下文中（如初始化和运行时），被误升级为 TUP 后会获得 0.35 基础分（高于 DFC 的重分类）。

**影响**：精度问题，部分子组的锚点类型可能不准确，影响评分权重，但由于后续有 LLM 评估兜底，实际误报影响有限。

**建议修复**：对分裂后的子组，如果 Joern 原始 Source 标签是 `sink`，即便重分类结果是 TUP，也应在证据中保留 `joern_source_tag: "sink"` 以供追溯：

```typescript
const subGroup: CVGroup = {
  // ...
  evidence: joernSource ? {
    joern_source_tag: 1,
    original_source: joernSource,  // 保留原始 Joern 来源
  } : {},
}
```

---

### L2-03 `estimateDependencyDepth` 从文本字符串估算深度，精度低（P2）

**问题描述**：

DFC 证据中的 `dependency_depth` 维度（0.01~0.10）基于表达式字符串的简单文本分析：

```typescript
function estimateDependencyDepth(accesses: VarAccess[]): number {
  // 简单标识符 → 深度 1
  if (/^[a-zA-Z_]\w*(\.\w+|->\w+|\[\w+\])*$/.test(expr)) totalDepth += 1
  // 包含赋值的表达式 → 深度 2
  else if (/(?<![!<>=])=(?!=)/.test(expr)) totalDepth += 2
  // 其他 → 深度 3
  else totalDepth += 3
}
```

`dependency_depth` 的设计初衷是反映数据流路径的跳数（1跳=直接引用，3跳=经过中间计算），但当前实现实际上反映的是**表达式字符串的复杂程度**，两者关联性很弱。

例如 `g_sensor_data.channel[0].raw_value`（深度 1，直接成员访问）会因为含有 `[` 匹配第一个正则得到深度 1（正确），但 `tmp = g_sensor.value`（赋值语句中读取全局变量，数据流深度也应为 1）会因为含有 `=` 被估算为深度 2（错误）。

**影响**：`dependency_depth` 维度的得分不可靠，对 DFC 最终置信度（0~0.10 贡献）有小幅影响。

**建议修复**：利用 Joern 脚本直接在 AccessList 中输出数据流跳数（Joern 的 DDG 可以精确计算），避免文本估算。短期内可移除此维度（影响 DFC 上限从 0.76 降至 0.66，但精度提升）。

---

## L3：Tool C — 违反模式检测

### L3-01 CPG 全局查询的变量访问上下文污染（P1）

**问题描述**：

当前修复（Fix-3）通过排除 `groupEntryFunctions` 来避免组自身的入口函数与 CPG 查询结果混淆。但存在一个遗漏场景：

当同一个**函数**（非入口函数）被**多个入口函数**调用时，CPG 查询返回的访问不携带"通过哪个入口到达此访问"的信息，只携带 `entry_function`（在 `queryVariableAccesses` 输出中可能是直接包含该访问的函数名，而非顶层入口）：

```c
void shared_update(int val) {
  g_x = val;       // 这个访问的 entry_function 是 "shared_update"
  g_y = val + 1;   // 还是 "shared_update"
}

void main() { shared_update(100); }          // task 上下文
void TIMER_ISR() { shared_update(200); }     // ISR 上下文
```

CPG 查询中 `g_x` 和 `g_y` 的访问都指向 `shared_update`，而 `shared_update` 不在 `groupEntryFunctions` 中（组的 Entry 可能是 `main`），导致这些访问被放入 `cpgAccesses`。

在构建 `allSequences` 时，这些访问会以 `shared_update` 为键建立独立序列，既非 `main` 也非 `TIMER_ISR`，导致抢占关系检查 `canPreempt` 无法正确识别这对上下文的关系。

**影响**：通过共享子函数访问全局变量的模式（在嵌入式代码中极为常见）可能产生漏检或误报。

**建议修复**：Joern 的 `queryVariableAccesses` 脚本应同时输出 `top_level_entry`（顶层入口函数名）和 `local_function`（直接包含访问的函数名），Tool C 在构建序列时以 `top_level_entry` 为键分组：

```typescript
// 修改后：以顶层入口函数（main/ISR）而非直接函数来分组
const contextKey = access.top_level_entry || access.entry_function
```

---

### L3-02 无优先级配置时 ISR↔ISR 双向假设产生大量候选（P1）

**问题描述**：

```typescript
// 修复前
function canPreempt(lowCtx, highCtx, isrSet, priorities) {
  if (isrSet.has(lowCtx) && isrSet.has(highCtx)) {
    if (!priorities || Object.keys(priorities).length === 0) {
      return true  // 保守假设：任何 ISR 互相可抢占 ← 产生大量误报
    }
    return (priorities[highCtx] ?? 0) > (priorities[lowCtx] ?? 0)
  }
}
```

**已修复**：无优先级配置时，默认同级 ISR 不可互相抢占（符合 ARM Cortex-M NVIC 默认行为）：

```typescript
// 修复后
if (isrSet.has(lowCtx) && isrSet.has(highCtx)) {
  if (!priorities || Object.keys(priorities).length === 0) {
    return false  // 默认：同级 ISR 不可互相抢占
  }
  return (priorities[highCtx] ?? 0) > (priorities[lowCtx] ?? 0)
}
```

当需要 ISR↔ISR 检测时，用户显式提供 `interrupt_priorities` 配置。

---

### L3-03 `getConsecutiveAccessPairs` 基于行号的连续性假设（P1）

**问题描述**：

`getConsecutiveAccessPairs` 将"连续"定义为排序后的相邻访问，排序键是 `(line, column)`。但在以下情况下，行号排序不等于执行序连续：

**场景 1：宏展开**

```c
#define UPDATE_STATE(a, b) do { g_a = a; g_b = b; } while(0)
UPDATE_STATE(x, y);  // 展开后两个写操作的行号都是这一行
```

两个写操作可能有相同的行号，column 排序也可能不代表执行顺序。

**场景 2：函数调用内联**

在 CPG 中，内联函数的访问节点行号指向原始调用点，多个内联访问可能聚集在同一行。

**场景 3：条件编译**

```c
// #if PLATFORM_A
g_voltage_high = read_adc();
// #endif
g_voltage_low = read_adc();
```

条件编译的代码段在 CPG 中可能被合并处理，行号关系不反映实际执行顺序。

**影响**：连续性判断的准确性依赖于行号能准确反映执行顺序，在上述情况下会产生误判。

**建议修复**：Joern 脚本应额外输出每个访问节点的 CFG 顺序编号（CFG node ID），Tool C 优先使用 CFG 顺序而非行号排序：

```typescript
// 访问排序键：cfgOrder 优先，行号作为 fallback
.sort((a, b) => (a.cfgOrder ?? a.location.line) - (b.cfgOrder ?? b.location.line))
```

---

### L3-04 去重键未包含列号，同行多访问可能被误判为重复（P2）

**问题描述**：

当前去重键：

```typescript
const key = `${pattern}:${vars.sort().join(",")}:${mainLines}:${isrLines}`
// mainLines = main_accesses 行号（排序后），如 "120,135"
// isrLines  = isr_accesses  行号（排序后），如 "220,221"
```

如果两个不同的违反候选恰好涉及同一行的不同列位置（如同行的两个表达式），它们会被误判为重复而合并为一个。

**影响**：低概率发生，但会导致有效候选的静默丢失。

**建议修复**：将行号+列号联合作为去重键：

```typescript
const mainPos = v.main_accesses
  .map(a => `${a.location.line}:${a.location.column}`)
  .sort().join(",")
const isrPos = v.interrupt_accesses
  .map(ia => `${ia.access.location.line}:${ia.access.location.column}`)
  .sort().join(",")
const key = `${v.pattern}:${[...v.variables].sort().join(",")}:${mainPos}:${isrPos}`
```

---

## L4：Tool D — 可行性验证

### L4-01 Z3 仅支持 QF_LIA，非线性条件退化（P1）

**问题描述**：

Z3 SMT 编码使用 `QF_LIA`（无量词线性整数算术），无法处理以下在嵌入式代码中常见的非线性约束：

```c
if (speed * load > MAX_POWER)     // 乘法 → 非线性
if ((status & 0x07) == FLAG)      // 位运算 → 非 QF_LIA
if (buffer[index] != INVALID)     // 数组访问 → 需要数组理论
if (ptr != NULL)                  // 指针比较 → 非整数
```

这些条件在 `tryTranslateCondition` 中无法翻译，被声明为自由 Bool 变量（`declare-const opaque_N Bool`），使得 Z3 可以任意赋值，最终倾向于输出 `sat`（CONFIRMED）而非 `unsat`（INFEASIBLE）。

这意味着：**当真正保护违反的条件是位运算或非线性表达式时，Z3 无法利用这个约束来证明 INFEASIBLE，违反被标记为 CONFIRMED，产生误报。**

**影响**：对于嵌入式代码，位运算条件（`status & MASK`）极为常见，这类保护条件无法被 Z3 利用，直接影响验证精度，导致大量本可排除的候选被报告为 CONFIRMED。

**建议修复**：

**短期**：对位运算操作数引入 QF_BV（位向量）理论支持：

```smt2
(set-logic QF_BV)
(declare-const status (_ BitVec 8))
(declare-const MASK (_ BitVec 8))
(assert (= (bvand status MASK) (_ bv1 8)))  ; status & MASK == 1
```

**长期**：使用混合逻辑（`QF_BVLIA`），允许同一公式中混用整数和位向量变量。

**近期可行**：至少在注释中记录哪些条件因为非线性被丢弃，让审计者知道验证精度有限：

```typescript
if (!translated) {
  smtLines.push(`; OPAQUE (non-linear/bitwise): ${condition.expression}`)
  // 而不是完全静默
}
```

---

### L4-02 ★ 短路约束提取仅限同行两访问，大量合法约束被丢弃（P0）

**问题描述**：

Joern 脚本中的 `getShortCircuitConstraints` 函数只在两个主访问位于同一行时才提取 `&&` 链约束：

```scala
(mainAccess1Line, mainAccess2Line, mainAccess2Var) match {
  case (Some(a1Line), Some(a2Line), Some(var2)) if a1Line == a2Line =>
    // 仅当两个主访问在同一行才提取短路约束
}
```

但 99% 的 `&&` 短路场景，两个访问不在同一行：

```c
if (data_ready && buffer != NULL) {     // L120: data_ready 条件
    process(buffer);                     // L121: buffer 访问（不同行！）
}
```

在这个例子中，到达 L121 的 `process(buffer)` 时，`data_ready` 和 `buffer != NULL` 都已为真，但由于 L120 ≠ L121，这个短路约束不会被提取，`data_ready == true` 和 `buffer != NULL` 两个约束都被丢弃，Z3 无法利用它们推导不可行性。

**影响**：这是验证精度最重要的改进点之一。大量真实的 `if(flag && ptr)` 保护模式因为此限制无法为 Z3 提供有效约束，导致本可验证为 INFEASIBLE 的候选被标记为 UNKNOWN 甚至 CONFIRMED。

**建议修复**：

移除 `a1Line == a2Line` 的限制，改为对所有通过 `getEnclosingConditions` 识别到包含在 `&&` 链中的访问都提取前置约束：

```scala
// 从 SP1 的 enclosing_conditions 中，提取所有包含在 && 表达式中的条件
def getShortCircuitConstraints(
  enclosingConditions: List[(String, String, Int)],
  targetVar: String
): List[(String, String, Int)] = {
  enclosingConditions.filter { case (expr, branch, _) =>
    branch == "true" && expr.contains("&&") &&
    expr.contains(targetVar)  // 仅提取包含目标变量的 && 链
  }.flatMap { case (expr, _, line) =>
    splitAndChain(expr).filter(sub => !sub.contains(targetVar))  // 返回目标变量之前的所有子条件
  }
}
```

---

### L4-03 CFG BFS 上限 2000 节点对大型函数可能不足（P1）

**问题描述**：

```scala
val maxIterations = 2000
// BFS 超过 2000 节点后标记 hit_search_limit=true 并返回 unreachable
```

大型嵌入式函数（如状态机主循环、复杂协议解析器）的 CFG 节点数可能远超 2000。当 `hit_search_limit=true` 时，Tool D 将路径判定为"不可达"并返回 INFEASIBLE，这是**错误的保守处理**——实际上应该返回 UNKNOWN（无法确定），而非 INFEASIBLE（证明不可达）。

**影响**：大型函数中的真实违反可能因为 BFS 搜索限制而被错误标记为 INFEASIBLE，产生漏报。

**建议修复**：

1. 当 `hit_search_limit=true` 时，返回 `reachable: null`（表示无法确定），Tool D 将此路径视为 UNKNOWN 而非 INFEASIBLE：

```scala
// 修改后
if (foundTarget.isEmpty && iterations >= maxIterations) {
  return Obj(
    "reachable" -> ujson.Null,  // null 而非 false
    "hit_search_limit" -> true,
    ...
  )
}
```

2. Tool D 在处理 `reachable === null` 时：

```typescript
if (sp.reachable === null) {
  // 搜索受限，无法判断可达性 → 不能 INFEASIBLE，降级为 UNKNOWN
  feasibility = "UNKNOWN"
  reason = "CFG BFS search limit reached, cannot confirm infeasibility"
}
```

---

### L4-04 多调用点时只取首个调用点条件（P2）

**问题描述**：

当目标函数有多个调用点时（`has_multiple_call_sites=true`），`getCallerConditions` 只分析第一个（按行号最小）调用点的上下文：

```scala
val callSite = callSites.minBy(_.lineNumber.getOrElse(0))  // 只取第一个调用点
```

对于在不同条件下被调用的函数：

```c
if (mode == SAFE) {
  update_state();    // L50: 调用点1，外层有 mode==SAFE 约束
}
// ...
if (error_flag) {
  update_state();    // L120: 调用点2，外层有 error_flag 约束
}
```

分析只考虑 L50 的调用上下文（`mode==SAFE`），忽略 L120 的调用上下文（`error_flag`）。如果 ISR 访问仅在 `mode!=SAFE` 时触发，应该从 L50 的调用路径中推导出不可行性，但分析框架只取了一个调用点，无法覆盖所有路径。

**影响**：在函数有多个调用点的情况下，路径约束可能不完整，导致某些可行性结论不够精确。影响程度视具体项目而定，通常较为有限。

**建议修复**：对每个调用点独立运行路径分析，取所有调用点的约束的**析取**（OR）——只要存在一个可行的调用路径，违反就应标记为可行：

```scala
val allCallSiteResults = callSites.map(cs => analyzeCallSite(cs))
// SAT if ANY call site leads to SAT; UNSAT only if ALL call sites lead to UNSAT
```

---

### L4-05 中断使能分析依赖 API 名称匹配，无法处理宏包装（P2）

**问题描述**：

中断使能分析通过 API 名称列表匹配禁用/使能调用：

```typescript
const DEFAULT_INTERRUPT_DISABLE_APIS = [
  "__disable_irq", "taskENTER_CRITICAL", ...
]
```

但实际嵌入式代码中，这类 API 通常被封装在项目专用宏中：

```c
#define ENTER_CRITICAL()  __disable_irq()
#define EXIT_CRITICAL()   __enable_irq()

// 代码中使用宏
ENTER_CRITICAL();    // CPG 中可能看到 ENTER_CRITICAL 而非 __disable_irq
SHARED_UPDATE();     // 访问2
EXIT_CRITICAL();
```

如果 Joern CPG 没有内联宏（`ENTER_CRITICAL` 保留为调用节点），API 名称匹配失效，导致中断禁用状态被忽略，本应 INFEASIBLE 的候选被标记为 CONFIRMED。

**影响**：对使用自定义临界区宏的项目（极为常见），中断使能分析可能完全失效。

**建议修复**：

1. 在 `matrix.jsonc` 的 `critical_section_apis` 中允许用户配置项目特定的宏名
2. 分析前通过 Joern CPG 追踪宏调用的调用图，确定自定义宏是否最终调用了已知的禁用 API：

```scala
def expandInterruptApis(customApis: Set[String], cpg: Cpg): Set[String] = {
  val result = mutable.Set.from(customApis)
  var changed = true
  while (changed) {
    changed = false
    // 如果函数 F 唯一调用了已知禁用 API → F 也是禁用 API
    cpg.method.filter(m => m.call.exists(c => result.contains(c.name))).foreach { m =>
      if (result.add(m.name)) changed = true
    }
  }
  result.toSet
}
```

---

### L4-06 ★ 初始化阶段函数的违反未排除，导致大量误报（P0）

**问题位置**：`src/tools/multivar-feasibility-verify.ts` — 验证循环入口

**问题描述**：

Tool D 的可行性验证假设中断默认使能（`enabled = true`），这在主循环（`while(1)`）阶段是正确的，但对于 `main()` 中在中断使能之前执行的初始化函数（如 `CPUInitial()`、`SystemInit()`），中断此时尚未使能，ISR 不可能抢占。

```c
int main(void) {
  CPUInitial();       // ← init phase: 中断未使能，ISR 不可能触发
  GlobalInitial();    // ← init phase
  ControllterInitial(); // ← init phase
  RAMInitial();       // ← init phase

  while (1) {         // ← 主循环: 中断已使能，ISR 可以抢占
    // ... 业务逻辑 ...
  }
}
```

CPUInitial 等函数内的共享变量访问会被 Tool B 检测到违反候选，经 Tool D 的 Joern 路径分析后，由于 CPG 只分析函数内部路径，不关注调用时机，这些候选可能通过 Z3 验证被标记为 CONFIRMED——产生大量误报。

**验证数据**（real2_bench）：

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| CONFIRMED | 32（含 30 个 CPUInitial 误报） | **2**（全部真实缺陷） |
| INFEASIBLE | 243 | **273** |
| init-phase 排除 | — | **71** |

**修复方案**：

1. **Tool D 新增 `init_functions` 参数**：JSON 数组，列出初始化阶段函数名
2. **Phase 0 快速排除**：在 Phase 1（Joern 路径分析）之前，检查候选的所有 `main_accesses` 函数是否全部在 `init_functions` 中。若是，直接标记 INFEASIBLE，跳过 Joern 和 Z3
3. **Agent Step 5.1 自动检测**：Agent 分析 main() 调用序列，追踪到第一个中断使能调用前的所有函数
4. **保守默认**：若找不到明确的中断使能调用，不传 `init_functions`（假设中断可能已使能）

```typescript
// Phase 0: init-phase check
if (initFuncSet.size > 0) {
  const mainFunctions = violation.main_accesses.map(a => a.location?.function).filter(Boolean)
  if (mainFunctions.length > 0 && mainFunctions.every(f => initFuncSet.has(f!))) {
    // 所有低优先级访问在 init-phase 中 → INFEASIBLE
    results.push({ ...violation, feasibility: "INFEASIBLE", ... })
    continue
  }
}
```

**设计决策**：init-phase 检测由 Agent 层（Step 5.1）而非 Tool D 自动推断，因为中断使能方式因处理器而异（寄存器级操作 vs API 调用 vs 宏包装），自动检测不可靠；Agent 能读取源码上下文做出更准确的判断。

---

## L5：Agent 工作流层

### L5-01 Step 3.5 大体量策略的截断点缺乏动态调整（P2）

**问题描述**：

Step 3.5 的大体量策略固定截断 DAC 锚点为前 80 个：

```
大体量策略（>300 组 或 >80 DAC 锚点）：
  DAC 锚点：仅评估前 80 个，其余 llm_score = 0.0
```

但这个阈值是固定的，对于 10-50 个 DAC 锚点的项目（真实嵌入式项目的典型规模），不存在大体量问题，但 Agent 仍会使用单一的"top-80"逻辑。更重要的是，在极大型项目中（> 500 个锚点），即便截断为 80 个评估，也可能超出 LLM 上下文窗口。

**建议改进**：

1. 将大体量触发阈值从固定值改为动态计算（基于估计 token 消耗）
2. 对中等规模项目（< 80 锚点），无需任何截断，全量评估
3. 对极大规模项目，额外增加"分批评估"机制（将 80 个锚点分为 4 批 × 20 个）

---

### L5-02 LLM 温度 0.2 在 DAC 语义评估中可能过于保守（P3）

**问题描述**：

Agent 配置了 `temperature: 0.2`，有利于工具调用的稳定性，但 Step 3.5 的语义评估需要一定程度的创造性推理——特别是对于命名不规范、注释不完整的嵌入式代码，需要结合上下文和领域知识判断变量的语义关联。

低温度可能导致 LLM 对不确定的 DAC 组倾向于给出保守的低分（0.3-0.4），而非真正评估语义关联性。

**建议改进**：在 Step 3.5 期间临时提高推理温度（OpenCode 是否支持 per-step 温度调整取决于框架能力），或在提示词中明确鼓励对模糊案例进行详细推理后再给分，而非快速给低分：

```
评估原则：
- 不要因为不确定就给低分。如果存在合理的语义关联可能性，请给出 0.5-0.7 分并说明理由。
- 只有在你有充分理由认为两个变量语义上完全无关时，才给低于 0.3 的分数。
```

---

## L6：架构层设计问题

### L6-01 Tool C 和 Tool D 对 Joern 的两次独立调用缺乏批处理（P1）

**问题描述**：

整个 pipeline 对 Joern 发起了 3 次独立调用：

1. **Tool A**（`multivar_correlated_vars`）：运行 `multivarCorrelatedVarsIdentify.scala` 识别关联组
2. **Tool C**（`multivar_violation_detect`）：调用 `queryVariableAccesses` 查询所有变量的全局访问
3. **Tool D**（`multivar_feasibility_verify`）：调用 `analyzePathFeasibility` 进行 CFG 路径分析

每次 Joern 调用都需要：
- JVM 启动（~15-30s）
- CPG 加载到内存（~10-60s，取决于项目大小）
- 实际分析
- JVM 关闭

在 `real1_bench` 测试项目中，这意味着 CPG 被加载了 3 次。对于大型项目，Joern 的冷启动开销可占总运行时间的 50%+。

**建议改进**：

**理想方案**：将三次 Joern 调用合并为一次，在单个 Joern 会话中顺序执行三个分析阶段，通过中间 JSON 文件传递数据：

```scala
// 合并后的单次 Joern 会话
importCpg(cpgPath, projectName)

// Phase 1: 关联变量识别
val phase1Result = useDefChainAnalysis(projectName, entries)

// Phase 2: 访问点查询（基于 Phase 1 的变量集）
val varNames = extractVarNames(phase1Result)
val phase2Result = queryVariableAccesses(projectName, varNames, entries)

// Phase 3: 路径分析（基于 Phase 2 的候选）
// 候选由外部（经过 LLM 评估和模式匹配后）提供
val violationsJson = readFile(violationsPath)
val phase3Result = analyzePathFeasibility(projectName, violationsJson, interruptApis)

println(phase1Result)  // 分别输出各阶段结果
println(phase2Result)
println(phase3Result)
```

**近期可行方案**：在 Tool A 执行时顺带进行 `queryVariableAccesses` 查询，将结果缓存到 `.matrix/data/cpg-accesses.json`，Tool C 直接读取缓存而不再启动 Joern。

---

### L6-02 multivar-correlated-groups.json 被 Step 3.5 原地修改，缺乏版本追踪（P2）

**问题描述**：

Tool A 生成 `multivar-correlated-groups.json`，Agent Step 3.5 在读取后修改 `llm_score` 和 `confidence` 字段，再写回同一文件。这导致：

1. **Tool A 生成的原始工具层评分被覆盖**，无法事后比较工具层评分与 LLM 评估的差异
2. **如果 Step 3.5 因异常中断**（LLM 超时、上下文溢出），文件可能处于部分更新状态，重试时无法区分"已评估"和"未评估"的组
3. **可调试性差**：无法快速定位哪些组被 LLM 降分排除

**建议改进**：

1. **分离存储**：Tool A 输出 `correlated-groups-raw.json`，Step 3.5 输出 `correlated-groups-refined.json`，后续步骤使用 refined 版本
2. **增加评估状态字段**：在每个组中添加 `llm_evaluated: boolean` 字段，支持断点续评
3. **保留原始置信度**：`confidence_tool_layer`（工具层评分）和 `confidence_final`（最终置信度）分开存储

```json
{
  "id": "cg_0023",
  "confidence_tool_layer": 0.634,
  "confidence_final": 0.785,
  "evidence": {
    "base": 0.55,
    "dependency_depth": 0.10,
    "llm_score": 0.85
  },
  "llm_evaluated": true,
  "llm_reasoning": "sensor_value and threshold jointly determine alarm condition..."
}
```

---

### L6-03 pipeline 缺乏端到端进度可观测性（P2）

**问题描述**：

当前 pipeline 的各 Tool 执行时间差异巨大（CPG 构建 5 分钟、Joern 分析 10 分钟、Z3 验证若干秒/组），但 Agent 的工作流中没有进度估算和中间状态汇报机制。用户在等待过程中无法了解：
- 当前正在执行哪个步骤
- 已处理多少组/候选
- 预计剩余时间

**建议改进**：在各 Tool 的执行过程中，通过 stdout/文件方式定期输出进度信息，Agent 在调用各工具后解析进度摘要并向用户汇报：

```
[Step 2/6] 正在构建 CPG...（已用时 45s）
[Step 3/6] 关联变量识别完成：发现 817 个候选组，过滤后保留 89 个
[Step 3.5/6] LLM 语义评估中：已评估 67/89 组（DFC 12/12, TUP 8/8, DAC 47/69）
[Step 4/6] 违反模式匹配中...
```

---

### L6-04 缺少对 Keil C51 等方言的 ISR 入口自动发现（P2）

**问题描述**：

Step 1 要求 Agent 提供 `isr_entries`（ISR 入口函数列表），来源是 `software-analysis.json`。但 `software-analysis.json` 由 `analyst` 智能体生成，其中 ISR 标注的准确性和完整性不被 `multivar-atomicity-checker` 验证。

对于 Keil C51 的 `interrupt N using M` 语法，Joern CPG 可能无法直接识别这是 ISR 入口（因为 Joern 处理的是标准 C），需要 Agent 额外通过 grep/astgrep 发现。

目前系统提示中有这个提醒，但缺乏**自动验证机制**——如果 `isr_entries` 不完整，整个检测结果都是不可靠的，但没有任何报错。

**建议改进**：

在 Step 3（Tool A 执行后）增加一个 ISR 完整性验证步骤：将 `software-analysis.json` 中的 ISR 列表与 Joern CPG 实际发现的具有中断属性的函数进行对比，报告差异：

```typescript
// Tool A 可额外返回 CPG 中发现的潜在 ISR
const detectedIsrs = cpg.method
  .filter(m =>
    m.annotation.exists(_.name.contains("interrupt")) ||
    m.name.matches(".*_ISR$|.*_IRQ.*|.*_Handler$")
  )
  .name.toSet
```

---

## 改进优先级排序与实施状态

### P0 级（影响正确性） — 全部已修复 ✓

| ID | 改进内容 | 状态 |
|----|---------|------|
| **L1-01** | TUP 窗口改为枚举所有组合 | **已修复** |
| **L2-01** | DAC 角色分配（行号归位 + 锚点位置 + 命名启发式三级回退） | **已修复** |
| **L4-02** | 移除短路约束的同行限制 | **已修复** |
| **L4-06** | 初始化阶段函数误报排除（init_functions 参数 + Agent 自动检测） | **已修复** |

### P1 级（影响精度） — 大部分已修复

| ID | 改进内容 | 状态 |
|----|---------|------|
| L1-03 | 修复 `determineAccessType` 对复杂 LHS | **已修复** |
| L1-05 | 修复 `removeDuplicate` 的 endsWith 语义 | **已修复** |
| L1-07 | 共享变量识别过滤局部变量遮蔽 | **已回退**（Joern 无编译数据库时 local 节点包含全局变量） |
| L3-01 | 修复 CPG 查询的共享子函数上下文污染 | **已修复** |
| L3-02 | 无优先级时 ISR↔ISR 默认不可互相抢占 | **已修复** |
| L3-03 | 访问序排序改用 (line, column) + 同行容错 | **已修复** |
| L4-01 | 引入 QF_BV 支持位运算条件 | 待定（架构级重写） |
| L4-03 | BFS 超限改为返回 UNKNOWN 而非 INFEASIBLE | **已修复** |
| L6-01 | 合并三次 Joern 调用减少 JVM 启动开销 | 待定（架构级重构） |

### P2 级（逐步改进） — 大部分已修复

| ID | 状态 |
|----|------|
| L1-02 | **已修复** |
| L1-04 | **已修复** |
| L1-06 | 已验证无需修改 |
| L2-02 | **已修复** |
| L2-03 | **已修复**（缩减为 0~0.05 二级） |
| L3-04 | **已修复** |
| L4-04 | **已修复**（添加警告注释） |
| L4-05 | **已修复**（wrapper 函数自动解析） |
| L5-01 | **已修复**（动态分批截断） |
| L6-02 | **已修复**（分离 raw/refined 存储） |
| L6-03 | **已修复**（Agent 进度汇报指令） |
| L6-04 | **已修复**（Step 1 ISR 完整性验证） |

### P3 级

| ID | 状态 |
|----|------|
| L5-02 | 待定（框架限制，无法 per-step 调整温度） |

### 剩余待定项总结

```
仍需处理（3 项）：
  1. L4-01: Z3 QF_BV 位运算支持（架构级，需引入 QF_BVLIA 混合逻辑或位向量编码）
  2. L5-02: LLM 温度调整（依赖 OpenCode 框架支持 per-step 温度覆盖）
  3. L6-01: 合并三次 Joern 调用（架构级，需重构 Scala 脚本为单会话多阶段执行）

无法修复（1 项）：
  L1-07: Joern 在无 compile_commands.json 时对 C 代码创建的 Local 节点包含全局变量引用，
         导致 cpg.method().local 和 refOut 两种方法都无法区分局部变量与全局变量。
         根本解决需要：(a) 为目标项目提供 compile_commands.json，或 (b) Joern 修复 C 解析行为。
```
