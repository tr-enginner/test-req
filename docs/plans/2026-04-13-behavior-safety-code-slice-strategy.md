# 行为安全检查的 Code-Slice 策略设计

## 目标

将行为安全检查的分析粒度从“按函数逐个分析”调整为：

1. 优先使用 `code-slice` 生成的上下文切片作为分析单元。
2. 如果 `code-slice` 执行失败，则退化为“每个源文件一次分析”。
3. 不再退化回“每个函数一次分析”。

## 当前实现

当前工具链为：

- `behavior_safety_plan`
- `behavior_safety_run_batch`
- `behavior_safety_finalize`

当前 `src/tools/behavior-safety-execute.ts` 的执行方式是：

- 对每个源文件先做函数清单解析
- 使用 `FUNCTIONS_PER_BATCH = 1` 拆成单函数 batch
- 每次调用 LLM 只分析一个函数
- 最后将这些 batch 合并成一个按文件输出的 `BehaviorSafetyRecord`

## 目标策略

### 第一优先级：使用 code-slice

- `behavior_safety_plan` 在建立计划时，先尝试调用 `code_slice_context_pack`
- 如果成功：
  - 读取 `.matrix/data/contexts/manifest.json`
  - 读取 manifest 引用的 context 文件
  - 按切片建立 batch，而不是按函数建立 batch
  - 一个 code-slice context 对应一个 batch
- plan 输出中应明确记录：
  - `strategy: "code_slice"`
  - batch 列表
  - 每个切片归属的源文件
  - 对应的 `context_id` 和 context 文件路径

### 回退策略：按文件分析

- 如果 `code_slice_context_pack` 因任何原因失败：
  - 不中止行为安全检查
  - 不再退回单函数 batch
  - 而是直接为每个源文件创建一个 batch
- plan 输出中应明确记录：
  - `strategy: "per_file_fallback"`
  - fallback 原因

## 切片归属规则

行为安全检查的最终产物仍然保持“每个源文件一个最终记录”。

由于 code-slice 的一个切片可能包含跨文件引用，因此每个切片必须明确归属到一个源文件。归属规则应为：

- 使用该切片主函数所在的源文件作为归属文件
- 实际实现上，可以使用 context 里第一个或主函数位置对应的文件路径作为归属文件

这样可以保持 finalize 阶段的输出结构稳定：

- 一个源文件
- 对应多个 slice batch，或一个 fallback batch
- 最终合并成一个 `BehaviorSafetyRecord`

## 工具层改造方案

### `behavior_safety_plan`

- 保持输入形式不变：`target_file` / `target_dir`
- 内部改为：
  - 先解析目标文件列表
  - 再尝试 `code-slice`
  - 成功则建立 code-slice batch
  - 失败则建立 per-file fallback batch
- 仍然保留当前清理旧 artifacts 的行为

### `behavior_safety_run_batch`

- 不再根据 `FUNCTIONS_PER_BATCH` 在运行时重新切分 batch
- 改为直接根据 plan 里生成好的 batch 元数据执行
- 对于 `code_slice` batch：
  - 读取对应的 context JSON
  - 将 `prompt_ready.text` 与编译上下文、traceability 提示一起送入 LLM
- 对于 fallback batch：
  - 一次性分析整个文件
  - 需要时附带文件级函数清单与源码内容

### `behavior_safety_finalize`

- 保持当前职责不变
- 继续将同一源文件下的所有有效 batch 合并为一个最终记录
- 覆盖率统计需要适配两种模式：
  - `code_slice` 模式下统计已分析切片
  - fallback 模式下统计已分析文件

## Agent / Skill 层要求

对外工具链不变，仍然是：

- `behavior_safety_plan`
- `behavior_safety_run_batch`
- `behavior_safety_finalize`

后续只需要更新 agent 和 skill 的表述，让它们明确说明：

- 优先分析单元是 code-slice context
- 失败时的回退单元是整个文件
- 单函数 batch 不再是目标策略

## 非目标

这次改造不做以下事情：

- 不重构 Phase 3 总体编排流程
- 不把策略判断下放到 agent prompt
- 不新建第二套行为安全检查流水线
- 不改变最终 artifact 家族：
  - `BehaviorSafetyBatchRecord`
  - `BehaviorSafetyRecord`

## 实施约束

- 策略选择必须在工具代码中完成，不能依赖 prompt 自行决定
- `code-slice` 失败后必须稳定退化到按文件分析
- 最终记录必须继续保持按文件输出，避免破坏下游契约
- batch 元数据必须足够明确，`run_batch` 不能在执行时再猜测当前策略
