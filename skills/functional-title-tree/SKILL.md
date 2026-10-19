---
name: functional-title-tree
description: 将源需求文档中聚集的功能需求目录映射为第三方测试需求文档第 4.1 节“功能测试”标题树。用于只生成标题层级、source_ref 追溯关系和叶子节点 TR-GN 编号，不生成正文、测试用例或总 test-requirements.json。
---

# 功能测试标题树

## 目标

只从源文档的功能需求簇生成 `4.1 功能测试` 标题树。不要生成正文、通过准则、输入输出流、测试用例，也不要生成最终的 `test-requirements.json`。

## 来源章节定位

- 在主 SRS 或 source artifacts 中定位一个聚集的功能需求根章节，例如 `3.2 能力需求`、`功能需求`、`软件功能需求`。
- 标题层级以 `document-structure` artifact 为准，不以 `req-segments-toc.json` 或 `req-segments.json` 为准。
- `SRS-3.2.3__01`、`SRS-3.2.3__02` 这类 `__NN` 后缀表示长章节切块，不是真实目录节点；不要把它们生成成两个标题，也不要要求模型补齐这些切块。
- 功能根章节只用于定位，不为它本身生成目标标题。
- 从功能根的子节点开始映射到 `4.1` 下，编号从 `4.1.1` 开始。
- raw 标题树应忠实反映源目录：源功能根下存在初始化节点时识别并路由；源标题不存在初始化时不要伪造来源。finalize 会确定性保证初始化节点位于 `4.1.1`：已有节点移到首位并重新编号，缺失时创建 `初始化功能需求项[TR-GN-Init]`，原功能节点及后代顺延。
- 如果已经存在清晰的功能需求簇，不要全篇搜索并重新聚类零散功能点。
- 如果功能根下的某个子节点明显只是说明性内容，例如概述、定义、背景、约束说明，可将它的 `source_ref` 放入 `skipped_source_refs`，不要放入标题树。

## 标题映射

- 尽量保留源标题原文。
- 保持源目录的相对层级，不压平、不合并兄弟节点、不重新分组、不跳级。
- 源目录中的叶子章节映射后就是目标叶子标题，直接追加 TR 编号；不要为了放置 TR 编号而新增同名子标题。
- 标题只追加后缀：
  - 如果源标题已经以 `功能` 结尾，追加 `需求项`。
  - 否则追加 `功能需求项`。
- 示例：
  - `初始化功能` -> `初始化功能需求项`
  - `解析执行总线指令` -> `解析执行总线指令功能需求项`
  - `温度控制` -> `温度控制功能需求项`

## TR-GN 编号

- 只有叶子节点生成 TR 编号。
- 叶子节点标题必须包含 `[TR-GN-xxx]`，节点中也必须单独提供 `tr_code: "TR-GN-xxx"`。
- 非叶子节点不能包含 `[TR-GN-xxx]`，也不能包含 `tr_code`。
- `xxx` 应从完整叶子标题生成，并保留区分性实体。
- 优先使用简短、可读的英文字母和数字，不使用分隔符。
- 推荐示例：
  - `80C32 控制器初始化` -> `TR-GN-80C32Init`
  - `CAN 控制器初始化` -> `TR-GN-CANInit`
  - `采集、处理一次电源的工程参数` -> `TR-GN-CPPEP`
  - `温度控制` -> `TR-GN-TempCon`
- 当源标题包含区分性实体时，避免生成 `TR-GN-Init` 这类过泛编号。

## Raw JSON 契约

只向指定输出路径写入一个 JSON 对象：

```json
{
  "functional_root_source_ref": "primary::SRS-3.2",
  "root_title": "能力需求",
  "routing": {
    "has_initialization": true,
    "initialization_title_no": "4.1.1",
    "initialization_source_ref": "primary::SRS-3.2.1"
  },
  "children": [
    {
      "title_no": "4.1.1",
      "title": "初始化功能需求项",
      "source_ref": "primary::SRS-3.2.1",
      "children": [
        {
          "title_no": "4.1.1.1",
          "title": "80C32 控制器初始化功能需求项[TR-GN-80C32Init]",
          "tr_code": "TR-GN-80C32Init",
          "source_ref": "primary::SRS-3.2.1.1",
          "children": []
        }
      ]
    }
  ],
  "skipped_source_refs": []
}
```

规则：

- 每个节点必须包含 `title_no`、`title`、`source_ref`、`children`。
- `children` 必须是数组，叶子节点使用 `[]`。
- raw 的 `routing.has_initialization` 表示源标题是否存在初始化节点；有初始化时路由必须指向真实节点，没有时可为 `false/null`。finalized 标题树一律规范化为 `has_initialization=true`，初始化节点固定为 `4.1.1`。
- `source_ref` 只能使用 source artifacts 中 `sections[].source_ref` 的规范值，必须逐字复制。
- 不要把裸 `section_id` 写入 `source_ref`。
- `skipped_source_refs` 只包含 source_ref 字符串。
