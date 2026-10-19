---
name: data-processing-test-requirements
description: 从Phase 2 source artifacts中提取独立、通用的数据采集、转换、质量清洗、融合和解释需求；排除接口协议、边界校验、核心业务算法与业务暂存，并生成4.7可追溯raw JSON。
---

# 数据处理测试需求
## source_refs契约
每行`source_refs`必须非空、去重，逐字复制`sections[].source_ref`并至少包含一个`primary::`；supporting只能补充。合法：`["primary::SRS-3.2.1", "supporting-002-protocol::SRS-8.4"]`。禁止裸章节ID、标题、路径、source plan信息和table_id；只引用直接支持当前行的最具体章节。

只使用payload的`source_artifacts_path`引用的document structure作为原始证据。正文读取`sections[].text`，表格通过占位符读取同章节`tables[].table_html`，按原文顺序提取需求并输出真实`source_refs`。

数据处理测试需求验证数据内容质量或通用表示经过独立预处理后是否得到正确、可观察的结果。接口协议、边界校验、核心业务算法、业务暂存、路由和存储控制不属于4.7。

## 执行流程

1. 搜索采集、接收、读取、校验、转换、换算、计算、滤波、剔除、融合、存储、输出、解释、判读、更新遥测/参数/数据帧等语义。
2. 确认候选以数据内容质量或通用表示预处理为主要对象，且能脱离具体业务功能独立描述输入、规则和结果。
3. 固定按4.3接口协议→4.6边界→4.1核心功能→4.7数据处理裁决；前三类任一成立时不生成row，不得依据动作关键词强行贴标签。
4. 按合并拆分规则整理，删除全文重复项。
5. 写入唯一raw文件前按质量清单和输出契约自检。

关键边界：接口接收/解析/合法性归4.3，范围与端点归4.6，坐标、姿态、指向、相位、控制码等任务核心算法及SRAM/文件/缓存暂存读取归4.1。4.7转换仅保留单位、量纲、基础编码、数值格式和标准化等通用预处理。复合描述删除前三类内容后若没有独立预处理链路，整项不生成。

必须读取以下文件：

- [分类规则](references/classification-rules.md)
- [证据与范围](references/evidence-and-scope.md)
- [关联与拆分](references/association-and-splitting.md)
- [质量检查](references/quality-checklist.md)

## 输出契约

```json
{
  "rows": [
    {
      "data_processing_requirement_description": "原文可追溯的完整数据处理需求",
      "source_refs": ["primary::SRS-3.2.1"],
      "related_description": "数据采集"
    }
  ],
  "open_questions": []
}
```

顶层严格只有`rows`和`open_questions`；row严格只有`data_processing_requirement_description`、`source_refs`、`related_description`三个字段。不得输出`requirement_id`，TR-SC编号由finalize按去重后顺序生成。`open_questions`只允许字符串。

`related_description`严格只能是：`数据采集`、`数据转换`、`数据剔除`、`数据融合`、`数据解释`。

写入raw前逐行自检该受控分类；这是模型生成质量要求，不是raw复用或finalize阶段的枚举硬门禁。

不得输出序号、测试需求标识、来源标识、hash或版本字段。不成立的候选项直接忽略，允许`rows`为空；禁止用“无法形成数据处理关系”等文字制造需求。不得补造原文没有的数据源、算法、阈值、单位、存储对象、输出结果或异常处理行为。

TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用，应写出来源明确的数据处理规则和结果。将此规则作为生成质量自检执行，不依赖代码正则在raw复用或finalize阶段拦截。
