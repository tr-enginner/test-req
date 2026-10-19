# 质量检查清单

写入 raw JSON 前逐项检查：

- 顶层只有 `rows` 和 `open_questions`。
- 每个 row 只有 `recovery_requirement_description`、`source_refs` 和 `related_description`。
- `related_description` 只取三类固定值。
- 每条 row 都有明确故障/异常/中断触发条件。
- 每条 row 都有明确恢复对象。
- 每条 row 都有明确恢复动作。
- 每条 row 都有恢复后预期状态、数据一致性或功能一致性验证点。
- 从地址0/起始地址/程序入口重新运行、重新启动、复位或重新初始化后的恢复行为已按4.8处理，并保留原文明示的恢复入口与结果。
- 没有输出序号、`TR-HF-*`、来源标识、hash、skill_version 或 prompt_version。
- 没有补造原文未给出的故障模式、复位方式、备用硬件、恢复入口地址、恢复时间或恢复结果。
- `open_questions` 中每一项都是字符串。
- 没有制造否定性伪需求；无证据时允许 `rows: []`。
