---
name: test-requirement-chapter2
description: "从 Matrix Phase 2 的 source-artifacts.json 与 source-plan.json 提取第三方测试需求文档第2章‘系统概述’的结构化字段和章节级来源追溯。"
---

# 测试需求第2章系统概述提取
## source_refs契约
`source_refs`是本章实际使用源章节的非空、去重汇总数组。每个值必须逐字复制document structure的`sections[].source_ref`，至少一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸`SRS-3.1`、标题/编号、DOCX路径、source plan信息及`primary::SRS-3.1::table-1`等table_id。只引用直接支持本章内容的最具体章节，不得全量罗列整份文档。

## 输入与边界

- 只读取 payload 指定的 `source_artifacts_path`、`source_plan_path` 及manifest引用的document structure，只写 `output_path`；source plan仅用于文档角色和编排。
- 只输出 schema 合法 JSON；不要生成 DOCX、Markdown 正文或模板占位符。
- 不读取 `software-analysis.json`，不使用领域常识补全来源中不存在的信息。
- 除无法确定的软件级别使用 `B`、`software_name_and_id` 缺失组成部分按固定格式写 `XXX` 外，缺失字段输出空值并写入 `warnings`。

## 定位与提取

1. 优先检查前几章的“系统组成”“软件概述”“运行环境规定”“硬件环境”，提取系统关系、处理器和存储器信息。
2. 从“存储器”“内存分配”“存储空间”相关章节提取 `memory_io_summary`。该字段只写存储器的名称或类型、容量、地址空间和用途，不写 CPU、总线控制器、A/D 转换器、GPIO、并行数据口或其他芯片、外设信息。每种存储器都必须带地址空间，例如 `00000000H~0001FFFFH`；源文档没有给出或无法确认时使用固定占位 `XXXXH~XXXXH`，不得根据容量或芯片型号猜测地址。
3. 原文存在适合保留的存储器或 I/O 表格时生成 `memory_io_tables`，保持原始列名、行序、数值和单位；I/O 和外设信息只能进入对应表格或其他适用字段，不得混入 `memory_io_summary`。
4. 生成 `interrupts` 前必须扫描全文的中断相关内容，不得只检查前几章。检索“中断设置”“中断”“专项分析”“中断分析”“任务分析”“中断/任务分析”以及表达相同含义的章节标题。
5. 从专项分析补充中断名称、优先级、周期或随机性、触发方式和执行功能。任务分析中的条目只有明确属于中断上下文、ISR、中断服务程序、定时器中断或外部中断时才能进入 `interrupts`；不要把普通周期任务、调度任务、轮询任务或普通周期函数误作中断。
6. 前几章与专项分析内容互相冲突且无法判定时，不要静默覆盖：将冲突单元格置空，并在 `warnings` 中列出候选值及各自证据。
7. 从 `source-plan.json.primary_srs_path` 的文件名提取软件名称和标识号，并用正文封面或标识内容核对。
8. 从“软件编程编译要求”“编程要求”“编译要求”分别提取编写语言、开发平台和编译环境。`development_platform` 只写宿主操作系统、IDE 或开发平台；`compilation_environment` 只写编译器/编译工具链名称、版本和明确的编译配置。烧录、下载、调试工具及其他辅助工具不得写入 `compilation_environment`。
9. 从“软件研制”“研制单位”“编制单位”提取纯单位名称。
10. `subsystem_and_software_functions` 只以 primary 需求规格 document structure 的功能标题树为依据。定位“功能需求”“软件功能需求”等功能根节点，只取其直接主要功能子节点的可见标题，按原始文档顺序提取业务名称；不要从正文重新概括、聚类、改名、合并或遗漏标题。输出前去除标题开头的章节结构编号及其后的空格、“、”等分隔符，并去除标题末尾括号中的 `SR`、`SRS` 或纯章节编号。例如：`3.2.1.2 总线通信`、`3.2.1.2、总线通信`、`总线通信（SR3.2.1.2）`、`总线通信（SRS-3.2.1.2）` 和 `3.2.1.2 总线通信（SR3.2.1.2）` 都输出 `总线通信`。
11. 标题去编号只清理结构编号，不得删除业务名称中的数字、接口名或型号：`1553B总线通信`、`CAN1接口处理`、`模块保护功能1` 必须原样保留。清理后去除首尾空白和残留分隔符；结果为空时不要写入数组，并在 `warnings` 说明被跳过的原始标题。
12. 初始化功能必须位于功能数组第一项：标题树存在初始化相关标题时，将去除结构编号后的原始业务标题移到第一项，并保持其他标题的相对顺序；标题树不存在初始化相关标题时，在第一项补充固定标题 `初始化功能`，其余标题仍保持标题树顺序。

## 字段规则

- `system_relationship` 描述系统组成、与其他分系统的连接及数据交互，不要混入详细功能清单。
- `processor_type` 与 `processor_frequency` 分开输出，频率保留原始单位。
- `memory_io_summary` 必须是单个 JSON 字符串，即使包含多种存储器也合并为一段文字，禁止数组、对象或 `null`。只写存储器使用情况，建议按“存储器名称（容量），地址空间：起始地址~结束地址，用于……”表述；不得列举芯片或外设。地址不明时必须写 `XXXXH~XXXXH`。
- `software_name_and_id` 必须是单个 JSON 字符串，固定写成“<型号或项目代号><软件全称>(<软件标识号>)”。型号与软件全称之间不加空格，软件标识号使用半角 `(`、`)` 包裹；标识号内部原有括号、斜杠、连字符和版本号保持来源原文。型号或项目代号、软件全称、软件标识号依次从主 SRS 标题、文件名和明确字段提取并互相核对。
- `software_name_and_id` 正确示例：`XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)`。禁止输出“软件名称（型号）”、仅软件名称、仅标识号、对象、数组或 `null`。
- 任一组成部分无法确认时只把该部分写 `XXX` 并写入 `warnings`：缺型号为 `XXX配电器下位机软件(R/...)`，缺名称为 `XHDZ-0000755XXX(R/...)`，缺标识为 `XHDZ-0000755配电器下位机软件(XXX)`，全部不确定为 `XXXXXX(XXX)`；不得留空或只保留已有片段。Chapter 1 与 Chapter 2 必须使用相同来源优先级和拼接规则。
- `memory_io_tables` 每项严格包含 `title`、`columns`、`rows`；每行单元格数量必须等于列数。
- `interrupts` 每项严格包含 `interrupt_name`、`priority`、`frequency_or_random`、`trigger_mode`、`execution_function`。无法确认的单元格使用空字符串，不猜测。
- `software_level` 只能是 `A`、`B` 或 `C`；无明确证据时输出 `B` 并告警。
- `programming_language` 保留来源表述，可包含多种语言。
- `developer_unit_name` 只输出单位名称，不包含“研制单位为”等句式。
- `subsystem_and_software_functions` 必须是非空字符串数组并去重，例如 `["初始化功能", "总线通信", "1553B数据处理"]`；第一项必须是初始化功能，其余项必须与 primary 需求规格功能标题树的原始顺序和业务名称一致，但不得携带标题前后的章节号、SR/SRS编号，不得输出单个字符串。
- `development_platform` 与 `compilation_environment` 内容不得重复。前者描述宿主操作系统、IDE 或开发平台；后者只描述编译器/工具链名称、版本和编译配置，不包含编程语言、操作系统、烧录工具、下载工具、调试工具或其他辅助内容。来源只有组合描述时按语义拆分，每条信息只放入一个字段；无法可靠拆分时放入最匹配字段，另一字段留空并在 `warnings` 说明，不得复制同一描述。
- 发现互相冲突且无法判定的值时，将对应字段置空并在 `warnings` 中列出候选值与证据。

## 输出约束

- raw顶层严格包含 `source_refs`、`system_relationship`、`processor_type`、`processor_frequency`、`memory_io_summary`、`memory_io_tables`、`interrupts`、`software_name_and_id`、`software_level`、`programming_language`、`developer_unit_name`、`subsystem_and_software_functions`、`development_platform`、`compilation_environment`、`warnings`；不输出 `version`、`source_artifacts_path` 或顶层 `evidence`，字段来源统一由 `source_refs` 表达。
- 写文件前必须确认 `typeof memory_io_summary === "string"` 且 `typeof software_name_and_id === "string"`。
- 不要输出笼统的 `software` 对象，不要输出解释性 prose。
