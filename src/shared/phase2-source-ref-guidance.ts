export const PHASE2_SOURCE_REFS_GUIDANCE = [
  "source_refs必须是非空字符串数组，并按首次使用顺序去重。",
  "每个值只能逐字复制source_artifacts_path引用的document structure中已有的sections[].source_ref；不得根据section_id自行拼接。",
  "source_refs至少包含一个primary::开头的主文档章节；supporting-<文档标识>::<章节ID>只能作为补充，不能成为唯一来源。",
  "合法示例：[\"primary::SRS-3.2.1\", \"supporting-002-protocol::SRS-8.4\"]。",
  "禁止填写裸章节ID（如SRS-3.1）、标题/标题编号、DOCX路径、source_plan信息或[表格：...]中的table_id（如primary::SRS-3.1::table-1）。",
  "只引用直接支持当前章节或当前测试需求的最具体源章节；不要无差别引用整份主文档。",
].join("\n")

export const PHASE2_CHAPTER_SOURCE_REFS_GUIDANCE = `${PHASE2_SOURCE_REFS_GUIDANCE}\n第1、2章的顶层source_refs汇总本章实际使用的源章节。`
export const PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE = `${PHASE2_SOURCE_REFS_GUIDANCE}\n测试需求的source_refs只记录直接支持当前需求内容的源章节。`
