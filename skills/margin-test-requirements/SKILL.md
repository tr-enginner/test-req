---
name: margin-test-requirements
description: 从功能需求源文本的空间、资源和明确余量章节提取4.5余量测试需求。用于拆分独立存储资源，并仅在证据可执行时识别时间或输入输出通道吞吐余量，生成包含来源追溯的raw JSON。
---

# 余量测试需求
## source_refs契约
每行`source_refs`必须非空、去重，逐字复制`sections[].source_ref`并至少包含一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸章节ID、标题、路径、source plan信息和table_id；只引用直接支持当前行的最具体章节。

只读取任务指定的 `source_artifacts_path` 及其引用的全部 document structure；正文读取 `sections[].text`，表格读取 `tables[].table_html`，一次处理全文并写入唯一 `margin.raw.json`，每行输出真实 `source_refs`。

## 工作流

1. 优先定位性能需求、时间特性、空间需求、资源需求及余量需求章节。
2. 提取资源对象、能力上限、允许/实际使用量、比例、负载阈值、可观察统计口径和单位。
3. 按 [margin-establishment.md](references/margin-establishment.md) 判断余量关系是否成立。
4. 按 [classification-rules.md](references/classification-rules.md) 选择唯一分类。
5. 按 [association-and-splitting.md](references/association-and-splitting.md) 合并、拆分和去重。
6. 写入前执行 [quality-checklist.md](references/quality-checklist.md)。

## 输出契约

顶层只允许 `rows`、`open_questions`。row只允许 `margin_requirement_description`、`source_refs`、`related_description`；不得输出`requirement_id`，TR-YL编号由finalize按去重后顺序生成。相关说明只能是固定三类之一。写入raw前逐行自检；这是模型生成质量要求，不是raw复用或finalize阶段的枚举硬门禁。

禁止输出序号、测试需求标识、hash和版本字段；禁止读取DOCX、硬件接口报告、源码或其他分析JSON；禁止补造或计算原文未给出的余量。

以存储余量为主要内容，并按独立存储区生成：不同介质分别生成，同一介质的多个命名区或独立地址范围也分别生成。地址只用于识别对象，不计算原文未给出的容量。20%不是默认值；只有原文对单区或全部存储区明确规定余量≥20%时才使用，其他比例保持原值。时间余量必须由原文明示；不得根据周期和处理时间推导余量。吞吐余量必须具有可施加负载和可观察统计口径。

TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用，应写出来源明确的余量对象、限制和结果。将此规则作为生成质量自检执行，不依赖代码正则在raw复用或finalize阶段拦截。
