---
name: strength-test-requirements
description: Generate Chapter 4.9 strength/stress test requirement raw JSON from functional source text.
---

# 强度测试需求
## source_refs契约
每行`source_refs`必须非空、去重，逐字复制`sections[].source_ref`并至少包含一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸章节ID、标题、路径、source plan信息和table_id；只引用直接支持当前行的最具体章节。

## Goal

强度测试需求针对软件系统在超出正常运行负载或接近极限条件下的表现提出测试要求，用于验证系统的稳定性、可靠性和抗压力能力。

输入固定为 payload 的 `source_artifacts_path` 及其引用的全部 document structure；正文读取 `sections[].text`，表格读取 `tables[].table_html`。输出 raw JSON 顶层只能包含：

```json
{
  "rows": [
    {
      "strength_requirement_description": "完整强度需求描述",
      "source_refs": ["primary::SRS-..."],
      "related_description": "长时间连续不间断综合功能测试"
    }
  ],
  "open_questions": []
}
```

## Required References

Read these files before producing rows:

- `references/classification-rules.md`
- `references/evidence-and-scope.md`
- `references/pressure-search-method.md`
- `references/association-and-splitting.md`
- `references/quality-checklist.md`

## Fixed Categories

`related_description` must be exactly one of:

- `长时间连续不间断综合功能测试`
- `提供数据能力的饱和性试验指标`

写入raw前逐行自检该受控分类；这是模型生成质量要求，不是raw复用或finalize阶段的枚举硬门禁。

## Output Rules

- Do not output sequence numbers.
- Do not output `TR-QD-*` identifiers.
- Do not output final chapter JSON or DOCX content.
- Each row contains exactly `strength_requirement_description`, `source_refs`, and `related_description`; do not output `requirement_id`, because finalize assigns contiguous TR-QD IDs after deduplication.
- Allow `rows: []` when no strength requirement is supported by the source text.
- Do not leave isolated references such as “见表xxx”, “详见表xxx”, or “按表xxx” in the TR description; express the source-supported stress condition and observable result instead. Treat this as a generation-quality rule, not a regex gate during raw reuse or finalize.
