# Phase 6 项目上下文（精简版）

## 一、项目背景
本项目（matrix-embedded-agent）旨在构建以 Phase 6 为核心的动态确认测试闭环：
- Phase 6：测试用例 + Robot Framework 脚本生成 + DTP 执行与门禁
- Phase 7：保留为兼容/手动执行入口，主流程不再依赖

Phase 6 的核心目标是：
将自然语言测试需求转化为**基于关键字库的可执行测试步骤**，自动完成参数填充、格式化输出、Robot 生成、DTP 执行与结果门禁。

---

## 二、当前系统核心架构（已收敛）

### 1. 单一输入源
- 唯一输入文件：
  `.matrix/data/test-requirements.json`
- 所有生成、报告、后处理均基于该文件
- 禁止大 JSON 传参与多输入来源

---

### 2. 分层架构（强约束）
```
生成层（LLM）
  ↓
标准化层（规则/工具）
  ↓
输出层（测试用例 / 文档）
```

#### 职责划分：
- `testcase_generator_run`
  - 展平需求
  - 构建极简 prompt
  - 生成步骤（不做决策）

- `testcase_format_check`
  - 关键字匹配（基于真实库）
  - 协议解析（docx → 结构化）
  - 占位符替换与校验

→ 生成 ≠ 决策 ≠ 校验（严格隔离）

---

### 3. 关键能力模块

#### （1）关键字驱动生成
- 所有测试步骤必须来源于关键字库
- 禁止自由生成不可执行步骤

#### （2）协议解析
- 输入：docx
- 输出：结构化 JSON（字段/范围/语义）
- 用于参数填充

#### （3）参数填充机制（解耦后）
参数来源优先级：
1. LLM建议值（placeholder_suggestions）
2. 协议精确匹配
3. 需求 + 章节上下文
4. 默认策略

→ 输入数据文件不参与参数填充

---

### 4. 上下文增强
- 每条 requirement 必须包含：
  - `chapter_background`
- 解决语义缺失问题（如多总线场景）

---

### 5. Prompt 策略（极简化）
- 仅保留必要信息
- 移除：
  - 示例
  - 协议内容
  - 关键字候选

→ prompt = 执行指令，而非说明文档

---

## 三、输入/输出与依赖策略

### 1. 输入策略
- 文件驱动（工具自行读取）
- 显式参数：`test_requirements_file`
- 错误直接失败（不 fallback）

---

### 2. 依赖清理
已完全移除：
- `software-analysis.json`（Phase 6 内）

保留原则：
- 无隐式依赖
- 所有数据来源可追溯

---

### 3. 输出分层
- 人工审查与文档源：
  - `source-confirmation-tests.json`
  - 保留自然语言步骤字段：`步骤描述`、`预期结果`
- 执行与 DTP 源：
  - `confirmation-tests.json`
  - 使用组合关键字翻译后的结构：`key_name`、`step_desc`、`parameter`、`expected_result`
  - 自动补入的软平台首步 `启动软平台 / 软件正常运行` 仅保留在源用例中，不进入可执行关键字步骤
- Markdown / DOCX 仅基于 `source-confirmation-tests.json` 生成
- Robot / DTP 执行基于 `confirmation-tests.json` 与 `test-cases-todo.txt`
- 执行闭环输出：
  - `test-cases-todo.txt`：每行一个待生成 Robot 的 `case_id`；首次生成时为全量，优化占位阶段当前也为全量
  - `test-execution.json`：DTP 执行结果归一化报告
  - `phase6-execution-loop.json`：通过率、覆盖率、闭环轮次与门禁结果

---

## 四、工作流（已修正）

### 新流程：评审 + 执行门禁驱动
```
生成（test-designer）
  ↓
评审（review）
  ↓
发布（publication tool）
  ↓
DTP 执行闭环（phase6_execution_loop）
```

关键约束：
- 文档仅在 review 通过后生成
- `phase6_publish_outputs` 成功后 Phase 6 仍未完成
- `phase6_execution_loop` 的通过率与覆盖率均达标后，Phase 6 才完成
- 覆盖率缺失按未达标处理
- Phase 8 依赖 Phase 3、Phase 4、Phase 6；不再依赖 Phase 7

### 角色划分：
- test-designer：生成草稿
- conductor：流程控制 + 发布 + 执行闭环调用

---

## 五、模板与提示词体系

### 统一模板结构：
```
任务目标 → 输出格式 → 通用规则 → 类型规则 → 输入信息
```

约束：
- Markdown 模板 = fallback 模板（完全一致）
- 模板必须可测试
- 禁止冗余说明和示例

---

## 六、可观测性（运行时能力）

新增：
- 运行状态目录：`.matrix/data/phase6-worker-runs/`
- 事件日志：`events.jsonl`
- 实时 metadata 输出

→ 支持调试 / 回放 / 分析

---

## 七、当前状态

### 已完成
- ✅ 架构收敛（输入 / 分层 / 依赖）
- ✅ 功能实现（生成 + 校验 + 报告）
- ✅ prompt 与模板重构
- ✅ 可观测性体系
- ✅ 工作流修正方案（评审驱动）
- ✅ 源测试用例与可执行翻译产物拆分
- ✅ Phase 7 主流程并入 Phase 6 执行闭环
- ✅ 回归测试通过
- ✅ 已提交版本（可复现）

### 进行中
- ⏳ 执行结果驱动的测试用例优化策略细化（当前为空占位，全量 case_id 写入 todo）

---

## 八、核心结论（压缩版）

Phase 6 已完成从：
- 多输入 + 强依赖 + prompt驱动

→ 演进为：
- 单一输入 + 分层架构 + 工具主导 + 可观测 + 评审驱动

系统当前具备：
- 可执行性（关键字驱动）
- 可控性（规则主导）
- 可调试性（日志与状态）
- 可扩展性（模块解耦）

下一阶段重点：
- 执行结果驱动的用例优化策略
- 覆盖率报告格式适配更多 DTP 输出
