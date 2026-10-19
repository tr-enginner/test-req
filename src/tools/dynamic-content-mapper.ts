/**
 * dynamic-content-mapper.ts — Content library dynamic content extraction and test case filling.
 *
 * Generates range mappings for FPGA (12 standard) and software (16 standard) documents.
 * Extracts dynamic test type content from content library DOCX files and fills test cases.
 *
 * Migrated from Python dynamic_content_mapper.py + routes.py generate_standard_range_mappings().
 */

import type { RangeMapping } from "../schema/eval-desc"

// ─── Test Type Constants ───────────────────────────────────────────

/** FPGA test types (7 dynamic) */
const FPGA_TEST_TYPES = [
  { type: "function_test", title: "功能测试", placeholder: "{{function_test_chapter}}" },
  { type: "logical_test", title: "逻辑测试", placeholder: "{{logical_test_chapter}}" },
  { type: "performance_test", title: "性能测试", placeholder: "{{performance_test_chapter}}" },
  { type: "timing_test", title: "时序测试", placeholder: "{{timing_test_chapter}}" },
  { type: "interface_test", title: "接口测试", placeholder: "{{interface_test_chapter}}" },
  { type: "boundary_test", title: "边界测试", placeholder: "{{boundary_test_chapter}}" },
  { type: "security_test", title: "可靠性安全性测试", placeholder: "{{security_test_chapter}}" },
] as const

/** Additional software test types (3 more beyond FPGA) */
const SOFTWARE_EXTRA_TEST_TYPES = [
  { type: "remain_test", title: "余量测试", placeholder: "{{remain_test_chapter}}" },
  { type: "intensity_test", title: "强度测试", placeholder: "{{intensity_test_chapter}}" },
  { type: "data_process_test", title: "数据处理测试", placeholder: "{{data_process_test_chapter}}" },
  { type: "recovery_test", title: "恢复性测试", placeholder: "{{recovery_test_chapter}}" },
] as const

// ─── Static Mapping Constants ──────────────────────────────────────

const FPGA_STATIC_MAPPINGS: RangeMapping[] = [
  {
    placeholder: "{{chapter_1}}",
    startTitle: "测评依据",
    endTitle: "测评性质",
    includeStartTitle: false,
    includeEndTitle: false,
  },
  {
    placeholder: "{{chapter_2}}",
    startTitle: "测评性质",
    endTitle: "测评目的",
    includeStartTitle: false,
    includeEndTitle: false,
  },
  {
    placeholder: "{{chapter_3}}",
    startTitle: "测评对象及环境",
    endTitle: "测评内容、方法及要求",
    includeStartTitle: false,
    includeEndTitle: false,
  },
  {
    placeholder: "{{document_review}}",
    startTitle: "附件3",
    endTitle: "附件4",
    includeStartTitle: false,
    includeEndTitle: false,
  },
  {
    placeholder: "{{code_review}}",
    startTitle: "附件4",
    endTitle: "附件5",
    includeStartTitle: false,
    includeEndTitle: false,
  },
]

const SOFTWARE_STATIC_MAPPINGS: RangeMapping[] = [
  {
    placeholder: "{{chapter_1}}",
    startTitle: "测评依据",
    endTitle: "测评性质",
    includeStartTitle: false,
    includeEndTitle: false,
  },
  {
    placeholder: "{{chapter_2}}",
    startTitle: "测评性质",
    endTitle: "测评目的",
    includeStartTitle: false,
    includeEndTitle: false,
  },
  {
    placeholder: "{{chapter_3}}",
    startTitle: "测评对象及环境",
    endTitle: "测试内容、方法及要求",
    includeStartTitle: false,
    includeEndTitle: false,
  },
  {
    placeholder: "{{document_review}}",
    startTitle: "附件1",
    endTitle: "附件2",
    includeStartTitle: false,
    includeEndTitle: false,
  },
  {
    placeholder: "{{code_review}}",
    startTitle: "附件2",
    endTitle: "附件3",
    includeStartTitle: false,
    includeEndTitle: false,
  },
  {
    placeholder: "{{unit_test_review}}",
    startTitle: "附件3",
    endTitle: undefined,
    includeStartTitle: false,
    includeEndTitle: false,
  },
]

// ─── Generate Range Mappings ───────────────────────────────────────

/**
 * Generate FPGA standard range mappings (12 total: 5 static + 7 dynamic).
 */
export function generateFpgaRangeMappings(
  contentLibraryFile?: string,
): RangeMapping[] {
  const mappings: RangeMapping[] = [...FPGA_STATIC_MAPPINGS]

  for (const testType of FPGA_TEST_TYPES) {
    mappings.push({
      placeholder: testType.placeholder,
      startTitle: testType.title,
      includeStartTitle: false,
      includeEndTitle: false,
      dynamicContent: {
        enabled: true,
        type: testType.type,
        contentLibraryFile,
      },
    })
  }

  return mappings
}

/**
 * Generate software standard range mappings (16 total: 6 static + 10 dynamic).
 */
export function generateSoftwareRangeMappings(
  contentLibraryFile?: string,
): RangeMapping[] {
  const mappings: RangeMapping[] = [...SOFTWARE_STATIC_MAPPINGS]

  // All FPGA test types + extra software types
  const allTestTypes = [...FPGA_TEST_TYPES, ...SOFTWARE_EXTRA_TEST_TYPES]

  for (const testType of allTestTypes) {
    mappings.push({
      placeholder: testType.placeholder,
      startTitle: testType.title,
      includeStartTitle: false,
      includeEndTitle: false,
      dynamicContent: {
        enabled: true,
        type: testType.type,
        contentLibraryFile,
      },
    })
  }

  return mappings
}

// ─── Dynamic Content Extraction ────────────────────────────────────

/** Attachment 3 mapping rules (document review) */
const TABLE_MAPPING_RULES: Record<string, string> = {
  "文档共性审查单": "测试用例0001{{case_id}}",
  "软件需求规格说明审查单": "测试用例0002{{case_id}}",
  "软件设计文档审查单": "测试用例0003{{case_id}}",
  "用户手册（使用说明）审查单": "测试用例0004{{case_id}}",
}

/** Attachment 4 mapping rules (code review) */
const CODE_REVIEW_MAPPING_RULES: Record<string, string> = {
  "编程规范类": "{{test_case_0011}} {{case_id}}",
  "设计一致性": "{{test_case_0012}} {{case_id}}",
  "器件管脚使用": "{{test_case_0013}} {{case_id}}",
  "跨时钟域处理": "{{test_case_0014}} {{case_id}}",
  "复位初始化": "{{test_case_0015}} {{case_id}}",
  "状态机": "{{test_case_0016}} {{case_id}}",
  "抗辐射加固设计": "{{test_case_0017}} {{case_id}}",
  "综合实现": "{{test_case_0018}} {{case_id}}",
}

/**
 * Test type Chinese → English mapping for matching confirmation test data.
 */
const TEST_TYPE_MAP: Record<string, string> = {
  "功能测试": "function_test",
  "逻辑测试": "logical_test",
  "性能测试": "performance_test",
  "时序测试": "timing_test",
  "接口测试": "interface_test",
  "边界测试": "boundary_test",
  "可靠性安全性测试": "security_test",
  "安全性测试": "security_test", // Legacy content libraries remain readable.
  "余量测试": "remain_test",
  "强度测试": "intensity_test",
  "数据处理测试": "data_process_test",
  "恢复性测试": "recovery_test",
}

/**
 * Get the Chinese test type name from a dynamic content type identifier.
 */
export function getTestTypeChinese(type: string): string {
  for (const [cn, en] of Object.entries(TEST_TYPE_MAP)) {
    if (en === type) return cn
  }
  return type
}

/**
 * Get the English test type from a Chinese name.
 */
export function getTestTypeEnglish(cnName: string): string {
  return TEST_TYPE_MAP[cnName] ?? cnName
}

/**
 * Generate enhanced mappings for FPGA attachment 3/4 dynamic content.
 */
export function createEnhancedMappings(): {
  tableMappingRules: Record<string, string>
  codeReviewMappingRules: Record<string, string>
} {
  return {
    tableMappingRules: { ...TABLE_MAPPING_RULES },
    codeReviewMappingRules: { ...CODE_REVIEW_MAPPING_RULES },
  }
}

/**
 * Extract dynamic content from a content library document by test type.
 *
 * Looks for headings matching the test type name in the content library,
 * and extracts the content section under that heading.
 *
 * @param contentLibraryXml - Content of the content library's word/document.xml
 * @param headings - Pre-resolved headings from the content library
 * @param testType - The test type identifier (e.g. "function_test")
 * @returns XML fragment for the test type section, or empty string if not found
 */
export function extractDynamicContentByType(
  contentLibraryXml: string,
  headings: Array<{ label: string; title: string; level: number; paraIndex: number }>,
  testType: string,
): string {
  const typeChinese = getTestTypeChinese(testType)

  // Find the heading matching this test type
  const heading = headings.find((h) => h.title.includes(typeChinese))
    ?? (testType === "security_test" ? headings.find((h) => h.title.includes("安全性测试")) : undefined)
  if (!heading) return ""

  // Find the next heading at same or higher level
  const headingIdx = headings.indexOf(heading)
  let endHeading: typeof heading | undefined
  for (let i = headingIdx + 1; i < headings.length; i++) {
    if (headings[i].level <= heading.level) {
      endHeading = headings[i]
      break
    }
  }

  // Import findSectionRange inline to avoid circular dependency
  const { findSectionRange } = require("./docx-heading-resolver")
  const range = findSectionRange(
    contentLibraryXml,
    headings,
    heading.title,
    endHeading?.title,
    { includeStartTitle: false, includeEndTitle: false },
  )

  if (!range) return ""

  let fragment = contentLibraryXml.substring(range.startOffset, range.endOffset)
  // Remove <w:sectPr>
  fragment = fragment.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, "")

  return fragment
}
