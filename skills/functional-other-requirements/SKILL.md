---
name: functional-other-requirements
description: 从Phase 2 source artifacts和第三章硬件接口派生文本中为4.1功能测试下单个非初始化功能叶子生成精炼、可追溯且不重复接口格式的需求正文。
---

# 剩余功能需求内容生成
## source_refs契约
每个`processing[]`项的`source_refs`必须是非空、去重数组，逐字复制document structure的`sections[].source_ref`，至少一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸章节ID、标题、路径、source plan信息和table_id。只引用直接支持当前TR的最具体章节；item顶层`source_refs`由finalize汇总，worker不得手工输出。

## 目标

生成 `4.1 功能测试` 中 payload `target_leaf` 指定的单个非初始化功能叶子标题正文。每次 worker 只生成一个内容项，粒度与 AD 采集、固存采集等功能项一致。

只生成标题树叶子下的正文内容，不生成测试用例、不生成通过准则、不合并初始化内容、不接入总 `test-requirements.json`。

## 输入约束

- 必须读取 payload 中的 `source_artifacts_path` 及其引用的 document structure；正文读取 `sections[].text`，表格通过占位符关联同章节 `tables[].table_html`。
- 必须读取 `functional-test-title-tree.json`，确认 payload `target_leaf` 是标题树中未被 `routing` 排除的叶子。
- 必须读取 payload 中的 `target_leaf` 和 `excluded_title_nos`；输出 item 只能对应 `target_leaf`。
- 硬件接口参考来源固定为 payload 中的 `hardware_interface_report_path`，即当前项目 `.matrix/reports/hardware-interface-model.docx`。
- 不要直接读取 `hardware_interface_report_path` 指向的 DOCX 二进制文件。
- 必须读取 payload 中的 `hardware_interface_report_text_path`；该文件由 workflow 从当前项目 `.matrix/reports/hardware-interface-model.docx` 解包抽取得到，用于引用第三章中已经生成的硬件接口、输入输出流、数据流描述和表格上下文。
- 硬件接口上下文只使用 `hardware_interface_report_text_path`。
- 不读取源代码；第一版不使用 `.matrix/data/software-analysis.json`。
- `source_ref` 只能逐字沿用 payload `target_leaf.source_ref`。

## 标题挂载

- `items` 必须且只能包含 1 个 item。
- 该 item 必须沿用 payload `target_leaf` 的 `title_no`、`title`、`tr_code`、`source_ref`。
- `excluded_title_nos` 必须逐字等于 payload `excluded_title_nos`。
- finalized 标题树始终有初始化路由；必须排除 `routing.initialization_title_no` 指向的初始化子树。
- 不允许输出 routing 指向的初始化子树内容。
- 不允许重新命名标题，不允许生成新的 TR 主编号。

## 内容结构

每个 item 固定包含：

- `summary`：一句话概括该功能项做什么。
- `input_flow`：输入流说明数组，只写输入对象、数据、指令、状态量或事件的名称。没有输入时写 `["无。"]`，不要留空数组。
- 不要输出 `processing_preamble` 字段；公式、算法前言、校验规则和前置说明写入最相关的 `processing.content`，复杂字段映射和重复格式明细写入 `tables`。
- `processing`：处理要求数组；每项包含 `requirement_id`、`source_refs`、`content`、`table_refs`；`source_refs` 非空且至少包含一个真实 `primary::` 引用，无表 TR 使用 `table_refs: []`。
- `output_flow`：输出流说明数组，只写输出对象、数据、状态、控制量、应答或遥测结果的名称。没有输出时写 `["无。"]`，不要留空数组。
- `tables`：通用格式表数组；无表时写 `[]`。每张表包含 `table_id`、`title`、`columns`、`rows`，列名可按来源内容确定，每行对象必须与全部列名逐一对应。
- 不要输出 `test_requirements`；“测试要求”小节及其固定值由 DOCX 渲染器生成。

## 内容完整性

- 正文不得使用“等”“等等”“之类”“相关”等省略语掩盖关键判定、处理动作或异常响应；复杂字段清单应完整写入表格，不在正文逐项铺陈。
- 第三章已有对应格式表时，该表是接口格式的唯一展示位置；4.1正文不得重复帧数量、完整控制场、DATA/W0～Wn布局、全部固定值或完整字段映射，也不得为同一格式建立本地重复表格。
- 正文只保留当前TR实际执行的校验字段、决定消息类型或业务分支的数据特征字段，以及校验后的功能动作、模式条件、异常响应、状态变化和可观测结果。
- 如果来源只给出概括性描述而无法展开完整清单，不能用“等”补齐；应只写已定位到的具体内容，并在 `open_questions` 中说明缺失的表号、字段、通道或待确认对象。
- 自查所有生成的中文说明字段，凡“等”表示省略时都必须删除并改为完整列举；固定术语本身包含“等”且不是省略含义时才可保留。

## 动态测试用例友好处理描述

- `processing.content` 使用一条或多条连贯、确定、可测试的自然语言需求语句。按实际处理顺序组织内容：来源明确的条件自然放在句首，随后描述软件动作、判定和结果；内容较多时拆成两到数句连贯表述。
- 禁止按“前置条件：xxx。处理动作：yyy。可观测输出：zzz。”固定模板拼接正文，也禁止使用“输入：”“触发条件：”“判断：”“异常响应：”“状态更新：”“结果：”等分类标签或固定槽位。
- 不要求每条需求机械包含全部要素。只覆盖来源明确且与当前 TR 相关的条件、动作、格式规则、计算/校验、异常行为、状态变化和可观测结果，不为凑模板补写来源未说明的信息；同时不得只写“解析数据”“完成处理”等空泛语句。
- 精炼写法示例：`软件按照表3.1.6-2规定的格式接收上行遥控包，校验SUM，并依据功能标识执行对应处理；校验失败时丢弃该包。` 示例中的行为和表号仅用于说明语序，实际内容必须以来源证据为准。
- SUM/CRC、DLC/Length、帧序号、标识符、帧类型等字段仅在当前功能确实执行相应合法性校验时保留；功能码、命令码、数据块标识、消息类型、模式标志等字段仅在其决定功能分支或数据含义时保留。只写必要位置、期望值和对应行为，不得把所有字段一律展开。
- 涉及输出映射时，正文说明映射动作和结果，具体源字段到输出字段、遥测字、状态量、控制量或上传区位置的长映射关系写入表格。
- `input_flow` 和 `output_flow` 只保留名称短语；复杂格式明细放入 `tables`。
- 如果来源没有给出某个字段、范围、映射或可观测结果，不能编造；只写已定位内容，并在 `open_questions` 说明缺失信息和已搜索关键词。

处理要求编号规则：

- 使用当前叶子的 `tr_code` 作为前缀。
- 从 `-001` 开始连续编号，例如 `TR-GN-YC-AD-001`、`TR-GN-YC-AD-002`。
- 不要生成 `TR-GN-INIT-001` 或新的主编号。

DOCX 渲染器会固定输出充分性 C1、C2、C3、C4，终止要求 Z1、Z2，优先级高优先级；raw JSON 不承载这些固定值。

## 引用第三章

- 功能需求正文必须引用 `source_artifacts_path` 指向的 document structure；不得把标题树、source plan或硬件接口派生文本当作原始需求证据。
- 引用 `hardware_interface_report_text_path` 中已经抽取出的接口标题、数据流、输入输出流描述和表格上下文。
- 能稳定定位到第三章真实完整表号时，正文直接使用“按照表3.x规定的格式……”引用，不得缩写、改写或编造表号。
- 能确认对应接口标题但无法稳定定位表号时，使用“按第三章<接口标题>规定的格式”自然引用，不复制完整格式，并在 `open_questions` 写明接口、消息、缺失表号和已搜索关键词。
- 第三章确无对应格式表时，才允许使用当前功能的本地 `tables/table_refs` 承载复杂映射。

## 输入输出流写法

- `input_flow` 和 `output_flow` 只输出相应名称即可，不展开描述格式。
- 输入流名称示例：`A/D 参数`、`固存数据`、`轮询指令`、`机构控制电路遥测应答数据`。
- 输出流名称示例：`速变遥测数据`、`缓变遥测数据`、`固存数据采集结果`、`一级 CAN 总线遥测上传区数据`。
- 不要在 `input_flow` 或 `output_flow` 中写帧格式、站地址、DATA 字段、通道映射、字节含义、校验规则或“通过/按照/解析/映射”等处理描述。
- 当前TR实际使用的校验字段和分支特征字段写入 `processing.content`；完整协议格式不塞进输入流/输出流。

## 表格引用与正文分工

- 必须识别源章节和硬件接口上下文中的表格引用，包括“见表xx”、“见附录表xx”、“表x/表y格式”、“表15~表17”、“按附录J”、“参见表”、“参考表”、“参考附录表”、“按照表”和同义写法。
- 遇到表格引用时，先在 `hardware_interface_report_text_path` 搜索已生成的第三章真实完整表号；存在对应格式表时直接引用该表号，不将其内容复制到当前 raw JSON，也不生成4.1本地重复表格。
- 只有第三章确无对应格式表时，才通过 section.text 中的 `[表格：table_id]` 读取同章节 `tables[].table_html`，整理为当前 raw JSON 的通用表格并通过 `table_refs` 关联。
- 将上述要求作为生成质量自检执行；不要依赖代码正则在 raw 复用或 finalize 阶段拦截此类文字。
- 第三章格式表承载完整DATA/W0～Wn、参数字段、通道、重复帧、字节含义和映射关系；正文只引用真实表号并保留当前TR必要的校验与特征字段。
- worker 只能写 `hardware_interface_report_text_path` 中已经确认的原表号；本地生成表不得自行编号或写“详细格式见如下表”，DOCX 渲染器按 `table_refs` 自动输出表号、表题和表格。
- 每张表必须有 item 内唯一 `table_id` 且只能被一个 TR 引用；禁止未知引用、重复引用、多个 TR 共享同一表或孤立表。
- 不得只写无法追溯到具体表的说法；如果无法定位明确表号或表题，不能编造，必须在 `open_questions` 说明缺失的表号/表题和已搜索关键词。
- 表格应服务当前 `target_leaf`，只摘取与当前功能项相关的行、列和字段，不要整章搬运无关表格。
- 如果确实找不到表格内容，不能编造表号、字段或数据含义；在 `open_questions` 写明缺失的表号或附录名，以及已搜索的关键词。

## 模型生成 Word/DOCX 默认格式

当任务明确要求你直接生成或整理 Word/DOCX 内容时，使用以下默认格式；如果当前 workflow 只要求 raw JSON，则不要生成 DOCX，只把这些规则作为后续 Word 生成约束：

- 正文：中文宋体，小四；英文和数字 Times New Roman，小四。
- 一级标题：黑体，三号，加粗。
- 二级标题：黑体，小三，加粗。
- 三级标题：黑体，四号，加粗。
- 四级及以下标题：黑体，小四，加粗。
- 行距：单倍；正文段落尽量紧凑。
- 表格标题：置于表格上方并居中，例如“表 4-1 XXX表”。
- 表格宽度：页面宽度 100%。
- 表格边框：普通单线边框。
- 第一行作为表头：浅灰底、加粗。
- 表格正文：宋体，五号，白底。
- 单元格文字：左对齐、垂直居中，保留少量内边距。

## 自查

- 顶层只包含 `section_title_no`、`section_title`、`excluded_title_nos`、`items`、`skipped_title_refs`、`open_questions`。
- `section_title_no` 固定为 `4.1`，`section_title` 固定为 `功能测试`。
- `excluded_title_nos` 与 finalized routing 一致，只包含初始化顶层标题号。
- 唯一 item 对应 payload `target_leaf`，且该叶子未被 routing 排除。
- `input_flow`、`processing`、`output_flow`、`tables` 都存在；没有输入或输出时分别写 `["无。"]`，没有表时写 `tables: []`。
- `input_flow` 和 `output_flow` 只包含名称短语，不包含格式展开、处理动作或长句描述。
- 不要输出 `processing_preamble`；源需求中的公式、算法前言或不适合单独编号成 TR 的处理说明必须合并进最相关的 `processing.content`。
- 每个 processing 都有 `table_refs`；每张表都有唯一 `table_id`、非空 `columns` 和逐列对应的 `rows`，不存在未知引用、重复引用或孤立表。
- `processing.content` 未逐项复述第三章格式表或本地表格中的长字段映射；所写第三章表号均可在 `hardware_interface_report_text_path` 中核实，本地表未自行编号。
- `processing.content` 只保留当前TR实际使用的校验字段和分支特征字段，并将来源明确的条件、功能动作、模式约束、异常响应、状态更新和可观测输出组织成连贯自然语言，未使用分类标签或固定槽位。
- 不要输出 `test_requirements`。
- `processing.requirement_id` 从当前 `tr_code-001` 开始连续递增。
