---
name: boundary-test-requirements
description: 从Phase 2 source artifacts中提取4.6边界测试需求，识别输入输出域、程序注入与内存地址、有限域端点、临界状态和状态转换条件，并生成可追溯raw JSON。
---

# 边界测试需求
## source_refs契约
每行`source_refs`必须非空、去重，逐字复制`sections[].source_ref`并至少包含一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸章节ID、标题、路径、source plan信息和table_id；只引用直接支持当前行的最具体章节。

只使用payload的`source_artifacts_path`引用的document structure作为原始证据。正文读取`sections[].text`，表格通过占位符读取同章节`tables[].table_html`，按原文顺序提取需求并输出真实`source_refs`。

## 执行流程

1. 搜索范围、区间、阈值、上下限、枚举、索引、计数、长度、地址、对齐、禁区、跨区、溢出、回绕、饱和值和状态转换条件；主动覆盖程序注入、烧录、内存访问、缓冲区和数据搬运场景。
2. 确认候选项同时包含明确对象、明确边界依据和边界处的预期行为。
3. 按输入域、输出域或状态转换分类，并区分边界与端点。
4. 按合并拆分规则整理，删除全文重复项。
5. 写入唯一raw文件前按质量清单和输出契约自检。

地址属于输入域对象，不新增分类枚举。地址需求只有在原文明示合法区间、端点、对齐、禁止/保留/只读区、跨区、回绕、溢出或`起始地址+长度-1`约束，并给出边界处预期行为时才成立。仅有地址计算、文件写入、烧录动作或单个基址不成立；不得按芯片位宽、存储容量或常识推导缺失端点。

必须读取以下文件：

- [分类规则](references/classification-rules.md)
- [边界与端点](references/boundary-and-endpoint.md)
- [关联与拆分](references/association-and-splitting.md)
- [质量检查](references/quality-checklist.md)

## 输出契约

```json
{
  "rows": [
    {
      "boundary_requirement_description": "原文可追溯的完整边界规则",
      "source_refs": ["primary::SRS-3.2.1"],
      "related_description": "温度点设置值数据输入域边界测试"
    }
  ],
  "open_questions": []
}
```

顶层严格只有`rows`和`open_questions`；row严格只有`boundary_requirement_description`、`source_refs`、`related_description`三个字段。不得输出`requirement_id`，TR-BJ编号由finalize按去重后顺序生成。`open_questions`只允许字符串，不得输出序号、hash或版本字段。

`related_description`必须采用具体对象名称加受控后缀，或采用固定的状态转换分类；写入raw前逐行自检。这是模型生成质量要求，不是raw复用或finalize阶段的后缀/分类硬门禁。

不成立的候选项直接忽略，允许`rows`为空；禁止用“无法形成边界关系”等文字制造需求。不得补造原文没有的边界值、单位、`±1`值或处理行为。

新生成的连续区间统一使用数学区间记法，逗号后保留一个空格，不使用`start~end`或`start～end`。必须按原文语义区分闭区间、开区间和半开区间；详细转换与保留规则见[边界与端点](references/boundary-and-endpoint.md)。

TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用，应写出来源明确的边界条件和预期行为。将此规则作为生成质量自检执行，不依赖代码正则在raw复用或finalize阶段拦截。
