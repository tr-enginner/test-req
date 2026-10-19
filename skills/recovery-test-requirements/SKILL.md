---
name: recovery-test-requirements
description: Generate Chapter 4.8 recovery test requirement raw JSON from functional source text.
---

# 恢复性测试需求
## source_refs契约
每行`source_refs`必须非空、去重，逐字复制`sections[].source_ref`并至少包含一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸章节ID、标题、路径、source plan信息和table_id；只引用直接支持当前行的最具体章节。

## Goal

恢复性测试需求用于验证系统在发生故障、异常或中断后，能否按照设计要求恢复运行，并保证数据、状态和功能的一致性。

从地址0、程序入口或起始地址重新运行，软/硬复位或重新启动后恢复运行，重新初始化后恢复功能、数据或状态，以及异常跳转后重新进入正常流程，均属于4.8候选。典型正例：`异常进入未用中断后跳转地址0重新运行`。只保留原文明示的恢复入口、动作和结果，不自行补足。

输入固定为 payload 的 `source_artifacts_path` 及其引用的全部 document structure；正文读取 `sections[].text`，表格读取 `tables[].table_html`。输出 raw JSON 顶层只能包含：

```json
{
  "rows": [
    {
      "recovery_requirement_description": "完整恢复性需求描述",
      "source_refs": ["primary::SRS-..."],
      "related_description": "故障发生时保护系统状态"
    }
  ],
  "open_questions": []
}
```

## Required References

Read these files before producing rows:

- `references/classification-rules.md`
- `references/evidence-and-scope.md`
- `references/association-and-splitting.md`
- `references/quality-checklist.md`

## Fixed Categories

`related_description` must be exactly one of:

- `故障发生时保护系统状态`
- `切换备用硬件`
- `探测错误功能`

写入raw前逐行自检该受控分类；这是模型生成质量要求，不是raw复用或finalize阶段的枚举硬门禁。

## Output Rules

- Do not output sequence numbers.
- Do not output `TR-HF-*` identifiers.
- Do not output final chapter JSON or DOCX content.
- Each row contains exactly `recovery_requirement_description`, `source_refs`, and `related_description`; do not output `requirement_id`, because finalize assigns contiguous TR-HF IDs after deduplication.
- Allow `rows: []` when no recovery requirement is supported by the source text.
- Do not leave isolated references such as “见表xxx”, “详见表xxx”, or “按表xxx” in the TR description; express the source-supported fault trigger, recovery action, and result instead. Treat this as a generation-quality rule, not a regex gate during raw reuse or finalize.
