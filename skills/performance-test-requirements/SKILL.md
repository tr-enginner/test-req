---
name: performance-test-requirements
description: 从source-artifacts.json引用的document structure中检索、筛选、分类并合并可量化的时间特性，生成4.2性能测试需求raw JSON。用于识别时间间隔、处理时间、处理精度和响应时间，区分显式与隐含性能需求，并排除功能、接口、安全可靠性及不可量化描述；一次处理全部structure，不负责TR-XN编号或DOCX渲染。
---

# 性能测试需求生成
## source_refs契约
每行`source_refs`必须非空、去重，逐字复制`sections[].source_ref`并至少包含一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸章节ID、标题、路径、source plan信息和table_id；只引用直接支持当前行的最具体章节。

## 输入与范围

- 只读取 `source_artifacts_path` 引用的全部 document structure；正文读取 `sections[].text`，表格读取 `tables[].table_html`，每行输出真实 `source_refs`。
- 先定位“性能需求”“时间特性”等章节，再扫描全文其他可量化时间约束。
- 所有阈值、范围、周期、频率、误差和单位必须来自原文；检索命中不是需求证据，周期或频率关键词也不是性能需求的充分条件。
- 一次处理全文并写入唯一的 `performance.raw.json`，不得拆分批次。

## 工作流

1. 检索时间单位、周期/频率、上下限、超时、误差和响应关系。
2. 提取测试对象、触发、动作、时间关系、数值、单位和比较关系，并先判断它表达的是外部可验收的性能边界还是内部调度/协议配置。
3. 按 [分类规则](references/classification-rules.md) 选择唯一的性能类型；固定调度值和设计配置不得分类为性能需求。
4. 按 [显式与隐含规则](references/explicit-and-implicit.md) 判断是否成立；证据不足时写入 `open_questions`。
5. 按 [关联、拆分与去重规则](references/association-and-splitting.md) 形成最少且完整的需求行，并保持原文顺序。
6. 按 [质量检查表](references/quality-checklist.md) 自检后写入raw JSON。

## 成立条件

每项需求必须同时具有：

- 明确的对象或动作；
- 明确的时间关系；
- 原文可追溯的可验收性能边界，例如上下限、范围、截止时间、时间精度、误差、抖动、吞吐能力或明确要求验证的实际周期准确性。

混合描述只抽取可独立成立的性能约束，但保留理解指标所需的主体、触发和动作。固定周期可作为误差或抖动指标的上下文，不得再单独形成一条性能需求。

## 设计约束排除与审计

- `定时周期为10毫秒`、`每1秒更新并发送一次`等只规定软件定时器、任务、中断、计数器、采集或发送节拍的固定值，属于调度或设计配置，不生成row。
- 数据包长度、轮询方式、更新节拍和协议配置本身不属于性能需求。
- `采集周期小于1秒`、`响应时间不超过2毫秒`、频率下限、帧间隔范围、时间误差和抖动等具有可测试判定边界，仍可生成row。
- `周期为10毫秒，误差不超过±1毫秒`只围绕误差生成row；固定周期仅作为必要上下文。
- 明确排除项需要留下来源与理由。由于raw契约没有`warnings`字段，在`open_questions`中使用`已排除（固定调度周期/设计约束）：<原始摘要>；来源：<canonical source_ref>；理由：<理由>`记录；真正语义不明的候选才写普通待确认问题。

## 输出契约

- 顶层必须且只能包含 `rows` 和 `open_questions`。
- 每个row必须且只能包含 `performance_requirement_description`、`source_refs` 和 `related_description`；不得输出`requirement_id`，TR-XN编号由finalize按去重后顺序生成。
- `performance_requirement_description` 必须是可直接放入表4.2-1的完整需求句。
- `related_description` 只能是四种显式分类，或添加 `隐含需求：` 前缀的四种分类。
- 写入raw前逐行自检该受控分类；这是模型生成质量要求，不是raw复用或finalize阶段的枚举硬门禁。
- 不输出 `sequence`、`test_requirement_id`、hash、`skill_version` 或 `prompt_version`。

## 禁止事项

- 不读取DOCX二进制、硬件接口报告、源代码或其他分析JSON。
- 不根据常识补造阈值、单位、触发或性能指标。
- 不把所有含时间单位的句子机械纳入。
- 不把普通周期任务、定时中断、计数器或固定采集/更新/发送节拍机械归为“时间间隔”。
- 不纳入日期、版本号、普通时间记录、纯功能、纯接口、纯安全可靠性或普通数值精度描述。
- 不把“及时”“快速”“实时”等无量化依据的描述改写为性能需求。
- 不生成最终JSON、TR-XN编号或DOCX。
- TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用，应写出来源明确的可测试语义。将此规则作为生成质量自检执行，不依赖代码正则在raw复用或finalize阶段拦截。
