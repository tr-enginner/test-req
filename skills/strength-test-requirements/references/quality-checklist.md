# 质量检查清单

写入 raw JSON 前逐项检查：

- 顶层只有 `rows` 和 `open_questions`。
- 每个 row 只有 `strength_requirement_description` 和 `related_description`。
- `related_description` 只取两类固定值。
- 每条 row 都有明确施压对象。
- 每条 row 都有明确压力或负载条件。
- 每条 row 都有明确持续方式或周期。
- 每条 row 都有预期观察点。
- 饱和类需求包含异常点或故障点判定依据。
- 没有输出序号、`TR-QD-*`、来源标识、hash、skill_version 或 prompt_version。
- 没有补造原文未给出的持续时长、步长、异常阈值、故障阈值、丢帧比例、并发数量或数据量。
- `open_questions` 中每一项都是字符串。
- 没有制造否定性伪需求；无证据时允许 `rows: []`。
