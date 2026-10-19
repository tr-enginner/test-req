---
name: serial-interface-analysis
description: 为通用硬件接口建模补充串口、UART、RS232、RS422和RS485领域的检索词、接口属性、收发时序和表格归类经验。仅在候选 interface_kind=serial，或 other 候选的真实接口名/keywords 明确表示串口类型时使用；不得替代通用硬件接口模型契约。
---

# 串口接口领域补充

同时使用 `$hardware-interface-modeling` 和 `$hardware-interface-dataflow-constraints`。本 Skill 只补充串口领域经验；发生冲突时，以这两个通用 Skill 为准。

## 检索线索

- 检索串口、UART、RS232、RS422、RS485、收发器、波特率、晶振、字符格式、数据位、停止位、校验位、主从模式、接收时序、发送时序和寄存器操作。
- 判断当前真实串口主题属于内部还是外部接口，并整理有证据的通信对象、总线数量、总线关系、工作方式和寄存器地址操作。
- 只处理当前候选，不把其他串口主题或仅在正文偶然出现的串口词汇并入当前接口。

## 内容组织

- 将内部/外部属性、晶振、波特率、字符格式、主从关系、寄存器操作和收发时序等非数据流说明写入三级节点 `overview`。
- `interface_id`必须使用独立字段，不得把 `IF-xxx-001`嵌入 `overview`。
- 只有源文档存在独立通信事务、请求—响应对或数据主题时才生成 `topics[]`；不得强制串口无四级标题。
- `topics[]`禁止 `content`，所有说明性正文统一进入 `overview`。

## 数据流与表格

- 始终以被测 CPU 软件为主体判定输入输出，不因主从模式机械交换方向。
- 输入输出继续使用“输入流/输出流：短主题。简短说明”的通用句式；只有一侧有证据时保持单向。
- 接口级寄存器地址、端口地址和静态映射表进入 `overview_tables`。
- 接收帧和外部指令格式表进入对应 `input_tables`；软件发送帧、请求、应答或控制数据表进入对应 `output_tables`。
- 同一 `table_id` 只能出现一次；不得新造、截断、删改、重画或摘要化原表。

## 通用契约边界

- 使用统一 `interface_id`、三级标题、可选 `topics[]`及通用输入输出字段。
- 不新增字段，不恢复 serial block、timing_description、flow_order或类型专属 DOCX 布局。
- 不得覆盖通用 Skill 的接口成立条件、来源边界、CPU方向和跨接口隔离规则。
