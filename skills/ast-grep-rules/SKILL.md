---
name: ast-grep-rules
description: "ast-grep 工作流与 YAML 规则编写参考：先生成通用规则、验证、再调用工具执行匹配"
metadata:
  agent: "astgrep"
  category: "analysis"
---

# ast-grep 规则驱动工作流

本技能指导 agent 通过 **YAML 规则驱动** 的方式执行 AST 级代码搜索。核心原则：

1. **规则先行**：先编写并验证 YAML 规则文件，再调用 `astgrep_run` 工具执行
2. **工具匹配，非 LLM 匹配**：所有模式匹配由 ast-grep 引擎完成，LLM 只负责规则设计和结果解读
3. **规则通用化**：规则描述的是通用代码模式（如「未检查 malloc 返回值」），不得与被测软件的具体标识符、函数名、变量名耦合

---

## 1. 工作流

### 步骤 1：理解搜索意图

将用户的自然语言描述转化为精确的结构化搜索需求：

- 要匹配的 **AST 结构**是什么？（函数调用、赋值、条件判断……）
- 是否需要上下文约束？（在某种结构内部、不在某种结构内部）
- 匹配结果应包含哪些信息？（位置、捕获的元变量）

### 步骤 2：编写通用 YAML 规则

根据搜索意图编写 YAML 规则。规则必须遵循以下设计原则：

**通用性原则：**
- 使用元变量（`$NAME`、`$$$ARGS`）代替所有可变的标识符
- 规则描述的是「代码模式类别」而非「特定代码实例」
- 一条好规则应能在任意 C/C++ 项目上执行并产生有意义的结果

**正确示例：**
```yaml
# 好：检测所有未检查返回值的 malloc 调用（通用模式）
id: unchecked_malloc
language: c
rule:
  pattern: $PTR = malloc($SIZE);
  not:
    follows:
      pattern: if ($PTR == NULL)
      stopBy: end
```

**错误示例：**
```yaml
# 差：规则耦合了具体的变量名和函数名
id: check_pcu_buffer
language: c
rule:
  pattern: pcu_rx_buffer = malloc(PCU_BUF_SIZE);
```

### 步骤 3：验证规则

调用 `astgrep_run` **之前**，逐项检查：

| 检查项 | 要求 |
|--------|------|
| `id` 字段 | 存在且为合法标识符 |
| `language` 字段 | 存在且匹配目标语言（`c` / `cpp`） |
| `rule` 字段 | 存在且至少包含一个正向规则（`pattern`、`kind`、`nthChild`、`range`） |
| 正向性 | `regex`、`not`、关系规则不算正向规则，必须搭配正向规则使用 |
| 元变量 | 所有可变部分使用 `$VAR` / `$$$VAR` 占位，无硬编码的具体标识符 |
| C 解析陷阱 | 函数调用 pattern 末尾带分号，或使用 `context + selector` |
| YAML 语法 | 缩进正确、冒号后有空格、字符串含特殊字符时加引号 |

### 步骤 4：执行搜索

验证通过后，调用 `astgrep_run` 工具：

```
astgrep_run(project_dir=<项目路径>, mode="rule", rule_yaml=<规则内容>)
```

- 简单 pattern 搜索也应优先使用 `mode="rule"`，因为 YAML 规则可携带 `id`、`message` 等完整元信息
- 仅在极其简单的一次性搜索（如 `malloc($SIZE)`）时才使用 `mode="pattern"`

### 步骤 5：解读结果

- 按文件组织匹配结果，附带行号和匹配代码片段
- 超过 20 条匹配时，按文件统计数量，只展示代表性样例
- 解释匹配结果与用户搜索意图的关联
- 如果结果不符合预期，回到步骤 2 调整规则后重新执行

---

## 2. YAML 规则语法参考

### 2.1 顶层字段

```yaml
id: rule_unique_id          # 必填：规则唯一标识
language: c                  # 必填：目标语言（c / cpp）
rule:                        # 必填：匹配规则
  pattern: ...
severity: warning            # 可选：hint | info | warning | error
message: "描述，可用 $VAR"   # 可选：人类可读消息
note: "修复建议"             # 可选
constraints:                 # 可选：元变量约束
  VAR_NAME: { rule }
transform:                   # 可选：元变量变换
  NEW_VAR: { operation }
utils:                       # 可选：工具规则（供 matches 引用）
  rule_name: { rule }
fix: "替换代码"              # 可选：自动修复模板
files:                       # 可选：限定文件 glob
  - "src/**/*.c"
ignores:                     # 可选：排除文件 glob
  - "test/**"
```

### 2.2 Pattern 语法

**元变量：**

| 语法 | 含义 | 示例 |
|------|------|------|
| `$NAME` | 匹配单个 AST 节点 | `malloc($SIZE)` → `malloc(1024)` |
| `$$$NAME` | 匹配零或多个节点 | `foo($$$ARGS)` → `foo()`, `foo(a,b)` |
| `$_` | 通配符（不捕获） | `if ($_)` → 匹配任何 if 条件 |

**同一元变量出现多次强制同一性**：`$A == $A` 只匹配 `x == x`，不匹配 `x == y`。

**Pattern 对象格式（消除解析歧义）：**

```yaml
rule:
  pattern:
    context: "void f() { target(a); }"
    selector: call_expression
```

**strictness 级别**：`cst` > `smart`（默认） > `ast` > `relaxed` > `signature`

### 2.3 原子规则

| 规则 | 说明 | 示例 |
|------|------|------|
| `pattern` | 匹配代码模式 | `pattern: malloc($SIZE)` |
| `kind` | 按 AST 节点类型匹配 | `kind: call_expression` |
| `regex` | 正则匹配节点文本（**非正向，须配合 kind/pattern**） | `regex: "^HAL_"` |
| `nthChild` | 按兄弟位置选择 | `nthChild: 1` |
| `range` | 按源码行列范围匹配 | `range: {start: {line: 10}, end: {line: 20}}` |

**C/C++ 常用 kind**：`function_definition`、`call_expression`、`if_statement`、`for_statement`、`while_statement`、`do_statement`、`switch_statement`、`return_statement`、`binary_expression`、`assignment_expression`、`pointer_expression`、`field_expression`、`cast_expression`、`subscript_expression`、`declaration`、`parameter_declaration`、`struct_specifier`、`enum_specifier`、`preproc_include`、`preproc_def`、`preproc_ifdef`、`comment`、`string_literal`、`number_literal`、`macro_type_specifier`

### 2.4 关系规则

| 规则 | 含义 |
|------|------|
| `inside` | 目标在另一节点**内部** |
| `has` | 目标**包含**另一节点 |
| `follows` | 目标在另一节点**之后**（同层级兄弟） |
| `precedes` | 目标在另一节点**之前** |

**stopBy 参数**（控制搜索范围）：

| 值 | 说明 |
|----|------|
| `neighbor` | 默认，仅直接相邻 |
| `end` | 搜索到子树末尾 |
| `{rule}` | 遇到匹配指定规则的节点时停止 |

**field 参数**（`inside`/`has` 专用，指定子节点角色）：`condition`、`body`、`consequence`、`alternative`、`initializer`、`update`、`declarator`、`type`、`left`、`right`、`argument`、`arguments`、`function`

```yaml
# 示例：匹配 if 条件中的 NULL 比较
rule:
  pattern: $A == NULL
  inside:
    kind: if_statement
    field: condition
```

### 2.5 组合规则

| 规则 | 逻辑 | 元变量行为 |
|------|------|-----------|
| `all` | AND，全部匹配 | 子规则间合并 |
| `any` | OR，至少一个匹配 | 仅来自匹配分支 |
| `not` | 取反，排除匹配节点 | — |
| `matches` | 引用 `utils` 中的工具规则 | — |

```yaml
# 组合示例：检测不安全字符串操作
utils:
  is_unsafe_string_op:
    any:
      - pattern: strcpy($DST, $SRC);
      - pattern: strcat($DST, $SRC);
      - pattern: sprintf($DST, $$$ARGS);
      - pattern: gets($BUF);
rule:
  matches: is_unsafe_string_op
message: "Unsafe string operation detected"
```

### 2.6 约束

对捕获的元变量施加额外过滤，值为任意规则对象：

```yaml
rule:
  pattern: $FUNC($$$ARGS);
constraints:
  FUNC:
    regex: "^(strcpy|strcat|sprintf|gets)$"
```

### 2.7 变换（配合 fix 使用）

| 操作 | 说明 |
|------|------|
| `substring` | 提取子串 |
| `replace` | 正则替换 |
| `convert` | 命名风格转换（`camelCase`、`snakeCase` 等） |
| `rewrite` | AST 级别重写 |

---

## 3. 通用规则库

以下规则适用于任意 C/C++ 项目，可直接使用或作为模板扩展。

### 3.1 内存安全

```yaml
# 未检查的动态内存分配
id: unchecked_malloc
language: c
rule:
  pattern: $PTR = malloc($SIZE);
  not:
    follows:
      pattern: if ($PTR == NULL)
      stopBy: end
message: "malloc result assigned to $PTR without NULL check"
```

```yaml
# 所有动态内存分配调用
id: dynamic_alloc_calls
language: c
rule:
  any:
    - pattern: malloc($$$ARGS);
    - pattern: calloc($$$ARGS);
    - pattern: realloc($$$ARGS);
    - pattern: free($$$ARGS);
message: "Dynamic memory operation detected"
```

### 3.2 字符串安全

```yaml
# 不安全字符串操作
id: unsafe_string_ops
language: c
rule:
  any:
    - pattern: strcpy($DST, $SRC);
    - pattern: strcat($DST, $SRC);
    - pattern: sprintf($DST, $$$ARGS);
    - pattern: gets($BUF);
message: "Unsafe unbounded string operation"
```

### 3.3 指针安全

```yaml
# 空指针解引用风险（指针访问不在 NULL 检查保护内）
id: possible_null_deref
language: c
rule:
  all:
    - pattern: $PTR->$FIELD
    - not:
        inside:
          pattern: if ($PTR != NULL) { $$$ }
          stopBy: end
    - not:
        inside:
          pattern: if ($PTR) { $$$ }
          stopBy: end
```

### 3.4 位操作

```yaml
# 位设置操作
id: bit_set_ops
language: c
rule:
  pattern: $REG |= $MASK;
message: "Bit set operation on $REG"
```

```yaml
# 位清除操作
id: bit_clear_ops
language: c
rule:
  pattern: $REG &= ~$MASK;
message: "Bit clear operation on $REG"
```

### 3.5 易失性与寄存器访问

```yaml
# 直接 volatile 寄存器访问
id: volatile_register_access
language: c
rule:
  pattern: "*((volatile $TYPE *)$ADDR)"
message: "Direct volatile register access at $ADDR"
```

```yaml
# 全局变量缺少 volatile 修饰
id: global_not_volatile
language: c
rule:
  kind: declaration
  not:
    regex: "\\bvolatile\\b"
  inside:
    kind: translation_unit
  has:
    kind: init_declarator
```

### 3.6 控制流

```yaml
# 查找 ISR / 中断处理函数
id: find_isr_functions
language: c
rule:
  kind: function_definition
  has:
    kind: function_declarator
    regex: "ISR|_Handler|_IRQHandler|interrupt"
```

```yaml
# 无 default 的 switch 语句
id: switch_no_default
language: c
rule:
  kind: switch_statement
  not:
    has:
      kind: case_statement
      has:
        pattern:
          context: "switch(x) { default: break; }"
          selector: default
      stopBy: end
```

```yaml
# Yoda 条件（字面量在比较左侧）
id: yoda_condition
language: c
rule:
  pattern: $A == $B
constraints:
  A:
    kind: number_literal
message: "Yoda condition: literal $A on left side"
```

### 3.7 函数结构

```yaml
# 所有函数定义
id: all_function_defs
language: c
rule:
  kind: function_definition
```

```yaml
# 包含指定类别调用的函数（用 constraints 过滤）
id: functions_with_io_calls
language: c
rule:
  kind: function_definition
  has:
    kind: call_expression
    has:
      kind: identifier
      regex: "^(printf|scanf|fopen|fclose|fread|fwrite)$"
    stopBy: end
```

---

## 4. 常见陷阱

### 正向性要求
每条 `rule` 必须至少含一个正向原子规则（`pattern` / `kind` / `nthChild` / `range`）。`regex`、`not`、关系规则本身不算正向。

### C 解析陷阱
`func(arg)` 不带分号会被 tree-sitter 解析为 `macro_type_specifier`。解决：pattern 加分号 `func($ARG);`，或使用 `context + selector`。

### kind 与 pattern 不可直接组合
```yaml
# 错误
rule:
  kind: call_expression
  pattern: malloc($SIZE)

# 正确：用 all 组合
rule:
  all:
    - kind: call_expression
    - pattern: malloc($SIZE)
```

### 元变量惰性匹配
`$$$VAR` 采用惰性策略，在首个可能位置停止。需要匹配到末尾时调整 pattern 结构。

### 循环依赖
- 关系规则内的 `matches` 允许自引用（递归遍历 AST）
- 组合规则（`all`/`any`/`not`）内的 `matches` 禁止自引用

### 语言差异
C 和 C++ 使用不同的 tree-sitter parser，AST 结构可能不同。每条规则只能指定一种 `language`。

---

## 5. 编译器方言项目处理

### 问题

tree-sitter-c 只认识标准 C 语法。以下嵌入式编译器方言的特有关键字会导致解析失败，ast-grep 无法在受影响区域进行匹配：

| 方言 | 无法解析的构造 |
|------|--------------|
| 8051/C51 (Keil) | `sfr`, `sbit`, `xdata`, `idata`, `pdata`, `code`, `data`, `bit`, `interrupt N using M`, `reentrant`, `_at_` |
| IAR | `__root`, `__no_init`, `__ramfunc`, `@"section"`, `#pragma location` |
| Keil ARM | `__svc(N)`, `__value_in_regs`, `data at 0xNN` |
| TI CCS | `cregister`, `_nassert()`, `#pragma CODE_SECTION` |
| Green Hills | `__ghs_*`, `#pragma ghs` |
| Wind River | `__DCC__`, `#pragma section` |

### 解决方案：使用预处理后的文件

Matrix 的 `code_preprocessor` 工具会将方言构造翻译为标准 C 等价物，输出到 `.matrix/preprocessed/` 目录。

调用 `astgrep_run` 时设置 `use_preprocessed` 参数：

```
astgrep_run(
  project_dir=<路径>,
  mode="rule",
  rule_yaml=<规则>,
  use_preprocessed="auto"   # "auto" | "true" | "false"
)
```

- **`auto`**（默认）：如果 `.matrix/preprocessed/` 存在则自动使用
- **`true`**：强制使用预处理后的文件（不存在则报错）
- **`false`**：始终搜索原始文件

工具会自动将匹配结果的文件路径映射回原始源文件，并修正行号偏移。

### 判断何时需要使用

1. 使用 `glob` 检查 `.matrix/preprocessed/` 是否存在
2. 如果存在，设置 `use_preprocessed="true"`
3. 如果不存在但项目明显使用方言（从文件名、头文件名、或源码特征判断），建议用户先运行 `code_preprocessor`
