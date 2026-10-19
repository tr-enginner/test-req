---
name: test-requirement-chapter1
description: "从 Matrix Phase 2 的 source-artifacts.json 与 source-plan.json 提取第三方测试需求文档第1章字段，并生成章节级来源追溯。"
---

# 测试需求第1章字段提取
## source_refs契约
`source_refs`是本章实际使用源章节的非空、去重汇总数组。每个值必须逐字复制document structure的`sections[].source_ref`，至少一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸`SRS-3.1`、标题/编号、DOCX路径、source plan信息及`primary::SRS-3.1::table-1`等table_id。只引用直接支持本章内容的最具体章节，不得全量罗列整份文档。

## 输入与边界

- 只读取 worker payload 指定的 `source_plan_path`、`source_artifacts_path` 及manifest引用的document structure；内容证据来自structure，source plan仅用于文档角色和编排。
- 只写 `output_path`，输出 schema 合法的 JSON；不要生成 DOCX 或固定章节文字。
- 不读取 `software-analysis.json`，不从常识补全源文档中不存在的信息。

## 提取顺序

1. 以 `source-plan.json.primary_srs_path` 确定主 SRS。
2. 先从主 SRS 文件名和正文中的封面、标识、适用范围、版本、引用文件段落提取。
3. 再用 `source-artifacts.json` 核对主文档及补充文档路径，并从全文识别任务书和设计报告。
4. 字段存在冲突时置空，并在 `warnings` 中说明候选值；不要自行选择。

## 字段规则

- `document_id`：提取主 SRS 的文档或项目标识。对于 `WB-R/YJYE001-1/01/RX1-2.00` 这类编号，可去掉 `WB-` 和尾部版本并输出 `R/YJYE001-1/01.RX1`；其他编号保留可靠提取值，不要因为原文没有 `.RX1` 而置空。渲染器会在缺少后缀时追加 `.RX1`。
- `document_version`：始终输出 `1.00`。
- `software_name_and_id`：使用单个 JSON 字符串，固定组合为“<型号或项目代号><软件全称>(<软件标识号>)”，不添加“第三方测试需求”。型号与软件全称之间不加空格，软件标识号使用半角 `(`、`)` 包裹；标识号内部原有括号、斜杠、连字符和版本号必须保持来源原文。型号或项目代号、软件全称、软件标识号依次从主 SRS 标题、文件名和明确字段提取并互相核对。
- `software_name_and_id` 正确示例：`XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)`。禁止输出“软件名称（型号）”、仅软件名称或仅标识号。
- 任一组成部分无法确认时只把该部分写 `XXX` 并写入 `warnings`：缺型号为 `XXX配电器下位机软件(R/...)`，缺名称为 `XHDZ-0000755XXX(R/...)`，缺标识为 `XHDZ-0000755配电器下位机软件(XXX)`，全部不确定为 `XXXXXX(XXX)`；不得留空或只保留已有片段。
- `model_name`：输出型号或项目标识，不包含“项目办”。优先使用主 SRS 文件名中位于软件名称前的型号。
- `client_address`：只有明确地址证据时填写，否则输出空字符串。
- `system_name`：提取软件所属系统或分系统全称。
- `csci_names`：输出软件配置项全称及标识；存在多个配置项时逐项输出。
- `code_version`：仅输出版本值，不加 `V`；无法识别时输出 `1.00`。
- `programming_languages`：只根据主 SRS 的文件名、正文和测试依据识别；C/C语言输出 `c`，X86汇编输出 `x86_assembly`，51/8051/MCS-51汇编输出 `mcs51_assembly`。未识别时输出空数组，不输出其他值。

## 引用文档

- `references` 只输出项目动态引用，不重复基础标准。
- 不要把C、X86汇编或51汇编编程约定写入 `references`；确定性工具根据 `programming_languages` 映射正式标准。
- 必须包含主需规的编号和正式文件名。
- 输入存在第三方评测任务书或软件设计报告时，分别加入其编号和正式文件名。
- 识别火星、载人航天或空间站项目时，可输出相应条件引用；确定性工具会再次归一化和去重。
- 每项提供 `document_id`、`document_title`、`source_kind` 和简短 `evidence`。

## 输出约束

- raw顶层严格包含 `source_refs`、`document_id`、`document_version`、`software_name_and_id`、`model_name`、`client_address`、`system_name`、`csci_names`、`code_version`、`programming_languages`、`references`、`warnings`；不输出 `version`、`source_artifacts_path` 或顶层 `evidence`，字段来源统一由 `source_refs` 表达。
- 缺失、冲突和低置信信息写入 `warnings`。除 `document_version` 和默认 `code_version` 外，不得臆造。
