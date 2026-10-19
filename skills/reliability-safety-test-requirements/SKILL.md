---
name: reliability-safety-test-requirements
description: 从功能需求源文本的可靠性、安全性或可靠性安全性章节提取并展开4.4可靠性安全性测试需求。用于识别容错方案、异常保护恢复和输入故障模式，并生成包含来源追溯的raw JSON。
---

# 可靠性安全性测试需求
## source_refs契约
每行`source_refs`必须非空、去重，逐字复制`sections[].source_ref`并至少包含一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸章节ID、标题、路径、source plan信息和table_id；只引用直接支持当前行的最具体章节。

只读取任务指定的 `source_artifacts_path` 及其引用的全部 document structure。以可靠性/安全性需求章节作为候选入口；正文读取 `sections[].text`，表格读取 `tables[].table_html`，每行输出真实 `source_refs`。

## 工作流

1. 完整读取源文本并定位可靠性、安全性相关章节边界。
2. 从章节条目建立候选清单，尽量保留原文的项目语义和细节。
3. 遇到交叉引用时按 [reference-expansion.md](references/reference-expansion.md) 执行 grep + read 展开。
4. 按 [requirement-patterns.md](references/requirement-patterns.md) 判断是否属于4.4。
5. 按 [association-and-splitting.md](references/association-and-splitting.md) 合并、拆分并去重。
6. 写入前执行 [quality-checklist.md](references/quality-checklist.md)。

## 分类

`related_description` 只能是：

- `提高安全性的容错方案`
- `异常条件下系统的处理和保护能力`
- `异常条件下软件的处理和保护能力`
- `输入故障模式的测试`

写入raw前逐行自检该受控分类；这是模型生成质量要求，不是raw复用或finalize阶段的枚举硬门禁。

软件独立执行检测、抑制、隔离、数据保护或安全处理时选择“软件”；主要验证整机、多软硬件组件协同或系统级安全状态时选择“系统”。同一条覆盖多个主体或类别时按主要测试对象只选一个，不复制为多行。无法判断主体时写入`open_questions`，不得新生成历史兼容值`异常条件下系统软件的处理和保护能力`。

从地址0、程序入口或起始地址重新运行，软/硬复位或重新启动后恢复运行，重新初始化后恢复功能、数据或状态，以及异常跳转后重新进入正常流程，均归4.8恢复性，不生成4.4 row。复合描述仅保留删除恢复部分后仍独立成立的检测、隔离、降级、安全状态或保护需求。

## 输出

顶层只允许 `rows`、`open_questions`。row只允许 `reliability_safety_requirement_description`、`source_refs`、`related_description`；不得输出`requirement_id`，TR-AQ编号由finalize按去重后顺序生成。描述必须包含可确认的故障/异常条件及容错、保护或恢复结果，能够直接进入表4.4-1。

禁止输出序号、测试需求标识、来源标识、hash和版本字段；禁止读取DOCX、硬件接口报告、源码和其他分析JSON；禁止根据常识补充阈值或行为。

TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用，应展开来源明确的故障、保护和恢复语义。将此规则作为生成质量自检执行，不依赖代码正则在raw复用或finalize阶段拦截。
