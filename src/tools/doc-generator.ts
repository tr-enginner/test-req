import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { extractSourceSteps } from "../schema/confirmation-test-case"
import { formatFunIdsAsRange, normalizeTestRequirements, splitFunIds } from "../shared/test-requirements"
import { normalizePhase6TestType } from "../shared/phase6-prompt-templates"

/**
 * doc_generator — Generate standard-format test documents from structured JSON data.
 * Reads .matrix/data/*.json and renders to .matrix/reports/*.md.
 * Used by: Summarizer and all agents that produce documents
 */
export const docGenerator: ToolDefinition = tool({
  description:
    "Generate human-readable Markdown documents from structured JSON data files. " +
    "Reads data from .matrix/data/ and renders reports to .matrix/reports/. " +
    "Supports all test artifact types: software analysis, test requirements, " +
    "code review, static analysis, unit test, test cases, test execution, test summary.",
  args: {
    data_file: tool.schema.string().describe("Path to the JSON data file to render"),
    output_file: tool.schema.string().describe("Path for the output Markdown file"),
    doc_type: tool.schema
      .enum([
        "software-analysis",
        "test-requirements",
        "code-review",
        "static-analysis",
        "unit-test",
        "test-cases",
        "test-execution",
        "test-summary",
        "defects",
      ])
      .describe("Type of document to generate"),
    template_path: tool.schema
      .string()
      .optional()
      .describe("Optional custom template file path"),
  },
  async execute({ data_file, output_file, doc_type, template_path }) {
    if (!existsSync(data_file)) {
      return JSON.stringify({ error: `Data file not found: ${data_file}` })
    }

    const raw = readFileSync(data_file, "utf-8")
    let data: any
    try {
      data = JSON.parse(raw)
    } catch {
      return JSON.stringify({ error: `Failed to parse JSON: ${data_file}` })
    }

    let markdown: string
    switch (doc_type) {
      case "software-analysis":
        markdown = renderSoftwareAnalysis(data)
        break
      case "test-requirements":
        markdown = renderTestRequirements(data)
        break
      case "defects":
      case "code-review":
      case "static-analysis":
        markdown = renderDefects(data, doc_type)
        break
      case "unit-test":
        markdown = renderUnitTest({ ...data, _data_dir: dirname(data_file) })
        break
      case "test-cases":
        markdown = renderTestCases(data, data_file)
        break
      case "test-execution":
        markdown = renderTestExecution(data)
        break
      case "test-summary":
        markdown = renderTestSummary(data)
        break
      default:
        markdown = `# ${doc_type}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`
    }

    // Write output
    const dir = dirname(output_file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(output_file, markdown, "utf-8")

    return JSON.stringify({
      status: "success",
      output_file,
      doc_type,
      size_bytes: markdown.length,
    })
  },
})

function renderSoftwareAnalysis(data: any): string {
  let md = `# Software Analysis Report\n\n`
  md += `**Project**: ${data.project_name || "N/A"}  \n`
  md += `**Version**: ${data.version || "N/A"}  \n`
  md += `**Date**: ${data.created_date || "N/A"}  \n\n`

  md += `## Summary\n\n`
  if (data.summary) {
    md += `| Metric | Value |\n|--------|-------|\n`
    md += `| Total Functions | ${data.summary.total_functions} |\n`
    md += `| Total LOC | ${data.summary.total_loc} |\n`
    md += `| Total Requirements | ${data.summary.total_requirements} |\n`
    md += `| Total Interfaces | ${data.summary.total_interfaces} |\n`
    md += `| Safety-Critical Functions | ${data.summary.safety_critical_functions} |\n`
    md += `| Avg Complexity | ${data.summary.avg_complexity ?? "N/A"} |\n\n`
  }

  if (data.requirements?.length) {
    md += `## Requirements (${data.requirements.length})\n\n`
    md += `| ID | Title | Type | Priority |\n|-----|-------|------|----------|\n`
    for (const r of data.requirements) {
      md += `| ${r.id} | ${r.title} | ${r.type} | ${r.priority} |\n`
    }
    md += `\n`
  }

  if (data.functions?.length) {
    md += `## Functions (${data.functions.length})\n\n`
    md += `| ID | Name | File | Complexity | Safety |\n|-----|------|------|------------|--------|\n`
    for (const f of data.functions) {
      md += `| ${f.id} | ${f.name} | ${f.file_path} | ${f.cyclomatic_complexity ?? "-"} | ${f.safety_critical ? "YES" : "-"} |\n`
    }
    md += `\n`
  }

  if (data.traceability_matrix?.length) {
    md += `## Traceability Matrix\n\n`
    md += `| Requirement | Implementing Functions |\n|-------------|----------------------|\n`
    for (const t of data.traceability_matrix) {
      md += `| ${t.req_id} | ${t.function_ids.join(", ")} |\n`
    }
    md += `\n`
  }

  if (data.gap_analysis?.length) {
    md += `## GAP Analysis (Requirements Without Implementation)\n\n`
    md += `| Requirement | Reason |\n|-------------|--------|\n`
    for (const g of data.gap_analysis) {
      md += `| ${g.req_id} | ${g.reason} |\n`
    }
    md += `\n`
  }

  if (data.orphan_analysis?.length) {
    md += `## ORPHAN Analysis (Functions Without Requirements)\n\n`
    md += `| Function ID | Name | File |\n|-------------|------|------|\n`
    for (const o of data.orphan_analysis) {
      md += `| ${o.function_id} | ${o.function_name} | ${o.file_path} |\n`
    }
    md += `\n`
  }

  // Suppress out-of-scope consistency_check field with warning
  if (data.consistency_check) {
    md += `## Consistency Check\n\n`
    md += `> **WARNING**: This section was generated by the Analyst agent but is outside its scope. `
    md += `Document-implementation consistency verification belongs to the Spec-Implementation Review agent (Phase 3). `
    md += `The content below has been suppressed. Please refer to the Phase 3 Code Review report for consistency results.\n\n`
  }

  md += `---\n\n`
  md += `*This report contains structural analysis results only (requirement extraction, function extraction, traceability mapping, GAP/ORPHAN identification). `
  md += `Semantic consistency verification (whether code correctly implements requirements) is performed by the Spec-Implementation Review agent in Phase 3.*\n`

  return md
}

function renderTestRequirements(data: any): string {
  const normalizedRequirements = normalizeTestRequirements(data)
  const derivedByType: Record<string, number> = {}
  const derivedByPriority: Record<string, number> = {}
  for (const req of normalizedRequirements) {
    derivedByType[req.type] = (derivedByType[req.type] || 0) + 1
    derivedByPriority[req.priority] = (derivedByPriority[req.priority] || 0) + 1
  }

  let md = `# Test Requirement Specification\n\n`
  md += `**Project**: ${data.project_name || "N/A"}  \n`
  md += `**Standard**: ${data.standard || "N/A"}  \n`
  md += `**Version**: ${data.version || "N/A"}  \n`
  md += `**Date**: ${data.created_date || "N/A"}  \n\n`

  if (data.summary || normalizedRequirements.length > 0) {
    md += `## Summary\n\n`
    md += `| Metric | Value |\n|--------|-------|\n`
    md += `| Total | ${data.summary?.total ?? normalizedRequirements.length} |\n`
    md += `| Testable | ${data.summary?.testable_count ?? "N/A"} |\n`
    md += `| Not Testable | ${data.summary?.not_testable_count ?? "N/A"} |\n\n`
    const byType = data.summary?.by_type && Object.keys(data.summary.by_type).length
      ? data.summary.by_type
      : derivedByType
    if (Object.keys(byType).length) {
      md += `### By Type\n\n`
      md += `| Type | Count |\n|------|-------|\n`
      for (const [type, count] of Object.entries(byType)) {
        md += `| ${type} | ${count} |\n`
      }
      md += `\n`
    }
    const byPriority = data.summary?.by_priority && Object.keys(data.summary.by_priority).length
      ? data.summary.by_priority
      : derivedByPriority
    if (Object.keys(byPriority).length) {
      md += `### By Priority\n\n`
      md += `| Priority | Count |\n|----------|-------|\n`
      for (const [priority, count] of Object.entries(byPriority)) {
        md += `| ${priority} | ${count} |\n`
      }
      md += `\n`
    }
  }

  if (normalizedRequirements.length) {
    // Group requirements by type
    const byType: Record<string, any[]> = {}
    for (const r of normalizedRequirements) {
      const type = r.type || "unknown"
      if (!byType[type]) byType[type] = []
      byType[type].push(r)
    }

    md += `## Test Requirements\n\n`
    for (const [type, reqs] of Object.entries(byType)) {
      md += `### ${type} (${reqs.length})\n\n`
      for (const r of reqs) {
        md += `#### ${r.id}: ${r.title}\n\n`
        md += `- **Type**: ${r.type}\n`
        md += `- **Priority**: ${r.priority}\n`
        md += `- **Source**: ${r.source_requirement_ids?.join(", ") || "N/A"}\n`
        md += `- **Test Level**: ${(r as any).test_level || "N/A"}\n`
        md += `- **Verification Method**: ${r.verification_method || "N/A"}\n`
        md += `- **Testability**: ${(r as any).testability || "N/A"}\n`
        if ((r as any).testability_notes) md += `- **Testability Notes**: ${(r as any).testability_notes}\n`
        if ((r as any).coverage_target) md += `- **Coverage Target**: ${(r as any).coverage_target}\n`
        md += `- **Criteria**: ${r.verification_criteria}\n`

        // Adequacy and termination requirements
        if (r.adequacy_requirements?.length) {
          md += `- **Adequacy Requirements**: ${r.adequacy_requirements.join(", ")}\n`
        }
        if (r.termination_requirement) {
          md += `- **Termination Requirement**: ${r.termination_requirement}\n`
        }

        // Input/output flows for functional types
        if (r.input_flows?.length) {
          md += `- **Input Flows**: ${r.input_flows.join("; ")}\n`
        }
        if (r.processing) {
          md += `- **Processing**: ${r.processing}\n`
        }
        if (r.output_flows?.length) {
          md += `- **Output Flows**: ${r.output_flows.join("; ")}\n`
        }
        md += `\n`
      }
    }
  }

  // Technical elements analysis
  if (data.technical_elements) {
    const te = data.technical_elements
    const hasContent = te.new_states?.length || te.safety_critical_functions?.length || te.test_focus_points?.length
    if (hasContent) {
      md += `## Technical Elements Analysis\n\n`
      if (te.new_states?.length) {
        md += `### New States\n\n`
        md += `| Category | Description | Test Req |\n|----------|-------------|----------|\n`
        for (const ns of te.new_states) {
          md += `| ${ns.category} | ${ns.description} | ${ns.test_req_id} |\n`
        }
        md += `\n`
      }
      if (te.safety_critical_functions?.length) {
        md += `### Safety-Critical Functions\n\n`
        md += `| Category | Description | Test Req |\n|----------|-------------|----------|\n`
        for (const sc of te.safety_critical_functions) {
          md += `| ${sc.category} | ${sc.description} | ${sc.test_req_id} |\n`
        }
        md += `\n`
      }
      if (te.test_focus_points?.length) {
        md += `### Test Focus Points\n\n`
        md += `| Description | Test Req |\n|-------------|----------|\n`
        for (const fp of te.test_focus_points) {
          md += `| ${fp.description} | ${fp.test_req_id} |\n`
        }
        md += `\n`
      }
    }
  }

  // Design constraints
  if (data.design_constraints?.length) {
    md += `## Design Constraints\n\n`
    md += `| ID | Description |\n|----|-------------|\n`
    for (const dc of data.design_constraints) {
      md += `| ${dc.id} | ${dc.description} |\n`
    }
    md += `\n`
  }

  // Traceability matrix
  const derivedTraceability = !data.traceability?.length && normalizedRequirements.length
    ? Object.entries(
      normalizedRequirements.reduce((acc: Record<string, string[]>, req) => {
        for (const sourceId of req.source_requirement_ids) {
          if (!acc[sourceId]) acc[sourceId] = []
          acc[sourceId].push(req.id)
        }
        return acc
      }, {}),
    ).map(([software_req_id, test_req_ids]) => ({
      software_req_id,
      test_req_ids,
      coverage_status: test_req_ids.length > 0 ? "full" : "none",
    }))
    : []

  if (data.traceability?.length || derivedTraceability.length) {
    md += `## Traceability Matrix\n\n`
    md += `| Software Req | Test Reqs | Coverage |\n|-------------|-----------|----------|\n`
    for (const t of data.traceability?.length ? data.traceability : derivedTraceability) {
      md += `| ${t.software_req_id} | ${t.test_req_ids.join(", ")} | ${t.coverage_status} |\n`
    }
    md += `\n`
  }

  // Document traceability
  if (data.document_traceability?.length) {
    md += `## Document Traceability\n\n`
    md += `| Document | Section | Title | Test Reqs |\n|----------|---------|-------|----------|\n`
    for (const dt of data.document_traceability) {
      md += `| ${dt.document_name} | ${dt.section_number} | ${dt.section_title} | ${dt.test_req_ids.join(", ")} |\n`
    }
    md += `\n`
  }

  return md
}

function renderDefects(data: any, type: string): string {
  const title = type === "code-review" ? "Code Review Report"
    : type === "static-analysis" ? "Static Analysis Report"
    : "Defect Report"
  let md = `# ${title}\n\n`
  md += `**Project**: ${data.project_name || "N/A"}  \n\n`

  if (data.summary) {
    md += `## Summary\n\n`
    md += `- Total Defects: ${data.summary.total}\n`
    md += `- Open Critical: ${data.summary.open_critical}\n\n`
  }

  if (data.defects?.length) {
    md += `## Defects\n\n`
    for (const d of data.defects) {
      md += `### ${d.id}: ${d.title}\n\n`
      md += `- **Severity**: ${d.severity}\n`
      md += `- **Category**: ${d.category}\n`
      md += `- **Source**: ${d.source}\n`
      md += `- **Location**: ${d.location?.file_path}:${d.location?.line_start}\n`
      md += `- **Status**: ${d.status}\n`
      md += `\n${d.description}\n\n`
    }
  }

  return md
}

function renderUnitTest(data: any): string {
  let md = `# 单元测试报告\n\n`
  md += `**项目**: ${data.project_name || "N/A"}  \n`
  md += `**版本**: ${data.version || "N/A"}  \n`
  md += `**日期**: ${data.created_date || "N/A"}  \n\n`

  // Section 1: Test overview
  if (data.summary) {
    md += `## 1 测试概况\n\n`
    md += `| 指标 | 值 |\n|------|-----|\n`
    md += `| 总用例数 | ${data.summary.total_cases} |\n`
    md += `| 通过 | ${data.summary.passed} |\n`
    md += `| 失败 | ${data.summary.failed} |\n`
    md += `| 错误 | ${data.summary.error ?? 0} |\n`
    md += `| 跳过 | ${data.summary.skip ?? 0} |\n`
    md += `| 通过率 | ${data.summary.pass_rate}% |\n`
    md += `\n`
  }

  // Section 2: Coverage
  if (data.coverage) {
    md += `## 2 覆盖率\n\n`
    md += `| 覆盖类型 | 达成率 |\n|----------|--------|\n`
    if (data.coverage.statement != null) md += `| 语句覆盖 | ${data.coverage.statement}% |\n`
    if (data.coverage.branch != null) md += `| 分支覆盖 | ${data.coverage.branch}% |\n`
    if (data.coverage.mc_dc != null) md += `| MC/DC | ${data.coverage.mc_dc}% |\n`
    md += `\n`
  }

  // Section 3: Case source distribution
  const bySource = data.summary?.by_source
  if (bySource) {
    md += `## 3 用例来源分布\n\n`
    md += `| 来源 | 用例数 | 通过 | 失败 | 通过率 |\n`
    md += `|------|--------|------|------|--------|\n`
    const renderSourceRow = (label: string, s: any) => {
      const rate = s.total > 0 ? Math.round((s.passed / s.total) * 10000) / 100 : 0
      md += `| ${label} | ${s.total} | ${s.passed} | ${s.failed} | ${rate}% |\n`
    }
    renderSourceRow("Z3 自动生成", bySource.autogen)
    renderSourceRow("功能测试（需求驱动）", bySource.functional)
    renderSourceRow("覆盖率补充（种子变异）", bySource.coverage_supplement)
    md += `\n`
  }

  // Section 4: Per-function test results
  const perFunc = data.per_function_summary
  if (perFunc?.length) {
    md += `## 4 逐函数测试结果\n\n`

    // Build result lookup: test_case_id → result
    const resultMap = new Map<string, any>()
    for (const r of (data.results || [])) {
      resultMap.set(r.test_case_id, r)
    }
    // Build test case lookup: id → test case
    const caseMap = new Map<string, any>()
    for (const tc of (data.test_cases || [])) {
      caseMap.set(tc.id, tc)
    }

    for (let i = 0; i < perFunc.length; i++) {
      const pf = perFunc[i]
      const passRate = pf.total_cases > 0
        ? Math.round((pf.passed / pf.total_cases) * 10000) / 100
        : 0
      md += `### 4.${i + 1} ${pf.function_name}\n\n`
      md += `| 指标 | 值 |\n|------|-----|\n`
      md += `| 用例总数 | ${pf.total_cases} (autogen: ${pf.by_source.autogen}, functional: ${pf.by_source.functional}, supplement: ${pf.by_source.coverage_supplement}) |\n`
      md += `| 通过率 | ${passRate}% |\n`
      if (pf.coverage.statement != null) md += `| 语句覆盖 | ${pf.coverage.statement}% |\n`
      if (pf.coverage.branch != null) md += `| 分支覆盖 | ${pf.coverage.branch}% |\n`
      if (pf.coverage.mc_dc != null) md += `| MC/DC | ${pf.coverage.mc_dc}% |\n`
      md += `\n`

      // Find failed cases for this function
      const funcFailedCases: { tc: any; result: any }[] = []
      for (const tc of (data.test_cases || [])) {
        if (tc.target_function_name !== pf.function_name) continue
        const result = resultMap.get(tc.id)
        if (result && result.verdict === "fail") {
          funcFailedCases.push({ tc, result })
        }
      }
      if (funcFailedCases.length > 0) {
        md += `#### 失败用例\n\n`
        md += `| 用例ID | 来源 | 描述 | 预期输出 | 实际输出 |\n`
        md += `|--------|------|------|----------|----------|\n`
        for (const { tc, result } of funcFailedCases) {
          const SOURCE_ZH: Record<string, string> = {
            autogen: "Z3自动生成",
            functional: "功能测试",
            coverage_supplement: "覆盖率补充",
          }
          const sourceLabel = SOURCE_ZH[tc.case_source] || tc.case_source || "—"
          const desc = (tc.title || tc.description || "—").replace(/\|/g, "\\|").slice(0, 60)
          const expected = (tc.expected_outputs || []).map((o: any) => `${o.name}=${o.value}`).join(", ") || "—"
          const actual = (result.actual_outputs || []).map((o: any) => `${o.name}=${o.value}`).join(", ") || "—"
          md += `| ${tc.id} | ${sourceLabel} | ${desc} | ${expected} | ${actual} |\n`
        }
        md += `\n`
      }
    }
  }

  // Section 5: Requirement traceability matrix
  const allReqIds = new Map<string, { total: number; passed: number; failed: number }>()
  const resultMap5 = new Map<string, string>()
  for (const r of (data.results || [])) {
    resultMap5.set(r.test_case_id, r.verdict)
  }
  for (const tc of (data.test_cases || [])) {
    for (const reqId of (tc.related_requirement_ids || [])) {
      if (!allReqIds.has(reqId)) allReqIds.set(reqId, { total: 0, passed: 0, failed: 0 })
      const entry = allReqIds.get(reqId)!
      entry.total++
      const verdict = resultMap5.get(tc.id)
      if (verdict === "pass") entry.passed++
      else if (verdict === "fail") entry.failed++
    }
  }
  if (allReqIds.size > 0) {
    md += `## 5 需求追溯矩阵\n\n`
    md += `| 需求ID | 关联用例数 | 通过 | 失败 | 覆盖状态 |\n`
    md += `|--------|-----------|------|------|----------|\n`
    for (const [reqId, info] of allReqIds) {
      const status = info.failed > 0 ? "部分覆盖" : info.passed > 0 ? "完全覆盖" : "未执行"
      md += `| ${reqId} | ${info.total} | ${info.passed} | ${info.failed} | ${status} |\n`
    }
    md += `\n`
  }

  // Section 6: Defect summary — try to read defects.json
  try {
    const dataDir = data._data_dir // injected by caller if available
    if (dataDir) {
      const defectsPath = join(dataDir, "defects.json")
      if (existsSync(defectsPath)) {
        const defectsRaw = JSON.parse(readFileSync(defectsPath, "utf-8"))
        const defects = (defectsRaw.defects || defectsRaw || [])
        const utDefects = Array.isArray(defects)
          ? defects.filter((d: any) => d.source === "unit_test")
          : []
        if (utDefects.length > 0) {
          md += `## 6 缺陷汇总\n\n`
          md += `| 缺陷ID | 函数 | 描述 | 关联需求 |\n`
          md += `|--------|------|------|----------|\n`
          for (const d of utDefects) {
            const funcName = d.location?.function_name || d.function_name || "—"
            const desc = (d.title || d.description || "—").replace(/\|/g, "\\|").slice(0, 60)
            const reqs = (d.related_requirement_ids || []).join(", ") || "—"
            md += `| ${d.id} | ${funcName} | ${desc} | ${reqs} |\n`
          }
          md += `\n`
        }
      }
    }
  } catch { /* defect section is best-effort */ }

  return md
}

const TEST_TYPE_ZH: Record<string, string> = {
  functional: "功能测试",
  interface: "接口测试",
  performance: "性能测试",
  robustness: "可靠性安全性测试",
  safety: "可靠性安全性测试",
  boundary: "边界测试",
  margin: "余量测试",
  data_processing: "数据处理测试",
  recovery: "恢复性测试",
  stress: "强度测试",
  hmi: "人机交互界面测试",
  capacity: "容量测试",
  installation: "安装性测试",
  document_review: "文档审查",
  code_review: "代码审查",
  static_analysis: "静态分析",
  code_walkthrough: "代码走查",
  logic_test: "逻辑测试",
  information_security: "信息安全测试",
  compatibility: "兼容性测试",
}

const TEST_METHOD_ZH: Record<string, string> = {
  equivalence_partition: "等价类划分法",
  boundary_value: "边界值分析法",
  state_transition: "状态迁移法",
  cause_effect: "因果图法",
  error_injection: "错误注入法",
  stress: "强度测试法",
  manual_analysis: "人工分析法",
  code_walkthrough: "代码走查法",
  tool_analysis: "工具分析法",
  path_coverage: "路径覆盖法",
  output_domain_analysis: "输出域分析法",
  document_review: "文档审查法",
}

const ENV_TYPE_ZH: Record<string, string> = {
  host: "主机仿真",
  target: "目标机",
  hybrid: "混合环境",
}

const STATUS_ZH: Record<string, string> = {
  draft: "草稿",
  reviewed: "已评审",
  approved: "已批准",
}

const COVERAGE_STATUS_ZH: Record<string, string> = {
  full: "完全覆盖",
  partial: "部分覆盖",
  none: "未覆盖",
}

// Ordered list of test type sections for consistent output (English keys)
const TEST_TYPE_ORDER = [
  "functional", "performance", "interface", "robustness", "safety",
  "margin", "boundary", "data_processing", "recovery", "stress",
  "hmi", "capacity", "installation", "information_security", "compatibility",
  "document_review", "code_review", "static_analysis", "code_walkthrough", "logic_test",
]

// Ordered list of Chinese test type keys (for DB-format grouping)
const TEST_TYPE_ZH_ORDER = [
  "功能测试", "性能测试", "接口测试", "可靠性安全性测试",
  "余量测试", "边界测试", "数据处理测试", "恢复性测试", "强度测试",
  "逻辑测试", "人机交互界面测试", "容量测试", "安装性测试",
  "信息安全测试", "兼容性测试", "文档审查", "代码审查", "静态分析", "代码走查",
]

// DOCX content library section ordering for Section 4.X (matches 软件测试说明内容库.docx)
const DOCX_TEST_TYPE_ORDER = [
  "文档审查", "静态分析", "代码审查", "数据审查", "代码走查",
  "功能测试", "性能测试", "接口测试", "可靠性安全性测试", "余量测试",
  "边界测试", "强度测试", "数据处理测试", "恢复性测试", "逻辑测试",
]

/**
 * Detect whether the suite uses DB-format (case_id, test_step JSON string, Chinese test_type)
 * or the structured format (id, steps array, English test_type enum).
 */
function isDbFormat(data: any): boolean {
  const first = data.test_cases?.[0]
  if (!first) return false
  // DB format has case_id + test_step; structured format has id + steps.
  return typeof first.case_id === "string" && "test_step" in first
}

/**
 * Parse DB-format test_step from either new array form or legacy JSON string form.
 * Unified steps render the SOURCE natural-language text (source_step_desc),
 * not the rendered keyword form (step_desc) — Markdown reports are
 * human-readable test specifications.
 */
function parseTestStepJson(testStep: unknown): Array<{ 步骤描述: string; 预期结果: string }> {
  return extractSourceSteps(testStep)
}

/**
 * Format an array of case IDs into compact range notation.
 * e.g. ["TC-0001","TC-0002","TC-0003","TC-0005"] → "TC-0001~0003、TC-0005"
 */
function formatCaseIdRange(caseIds: string[]): string {
  if (!caseIds.length) return "—"
  if (caseIds.length === 1) return caseIds[0]

  // Parse into prefix + number
  const parsed = caseIds
    .map((id) => {
      const match = id.match(/^(.+-)(\d+)$/)
      if (!match) return { raw: id, prefix: "", num: 0, padLen: 0 }
      return { raw: id, prefix: match[1], num: parseInt(match[2], 10), padLen: match[2].length }
    })
    .sort((a, b) => {
      if (a.prefix !== b.prefix) return a.prefix.localeCompare(b.prefix)
      return a.num - b.num
    })

  const ranges: string[] = []
  let i = 0
  while (i < parsed.length) {
    if (!parsed[i].prefix) {
      ranges.push(parsed[i].raw)
      i++
      continue
    }
    const { prefix, padLen } = parsed[i]
    const start = parsed[i].num
    let end = start
    let j = i + 1
    while (j < parsed.length && parsed[j].prefix === prefix && parsed[j].num === end + 1) {
      end = parsed[j].num
      j++
    }
    if (start === end) {
      ranges.push(`${prefix}${String(start).padStart(padLen, "0")}`)
    } else {
      ranges.push(`${prefix}${String(start).padStart(padLen, "0")}~${String(end).padStart(padLen, "0")}`)
    }
    i = j
  }
  return ranges.join("、")
}

/** Convert YYYYMMDD → YYYY年MM月DD日 */
function formatDateZh(dateStr: string | undefined): string {
  if (!dateStr) return ""
  if (/^\d{8}$/.test(dateStr)) {
    return `${dateStr.slice(0, 4)}年${dateStr.slice(4, 6)}月${dateStr.slice(6, 8)}日`
  }
  return dateStr
}

/**
 * Load canonical test requirement order from test-requirements.json.
 * Returns a map of req_id → 0-based position index (for stable sorting).
 * Falls back to empty map if the file cannot be read.
 */
function loadReqOrderMap(dataDir: string): Map<string, number> {
  const orderMap = new Map<string, number>()
  try {
    const reqPath = join(dataDir, "test-requirements.json")
    if (!existsSync(reqPath)) return orderMap
    const reqData = JSON.parse(readFileSync(reqPath, "utf-8"))
    const reqs: any[] = reqData.funItem ?? reqData.requirements ?? []
    reqs.forEach((req: any, idx: number) => {
      const rawId = req.id ?? req.funId
      // funId may be a standard array — join into 、-separated key matching correspond_fun_id
      const id = Array.isArray(rawId) ? rawId.join("、") : rawId
      if (id) orderMap.set(id, idx)
    })
  } catch { /* ignore */ }
  return orderMap
}

/**
 * Load requirement id → title/name map from test-requirements.json.
 * Used for subsection titles within each test type section.
 */
function loadReqTitleMap(dataDir: string): Map<string, string> {
  const titleMap = new Map<string, string>()
  try {
    const reqPath = join(dataDir, "test-requirements.json")
    if (!existsSync(reqPath)) return titleMap
    const reqData = JSON.parse(readFileSync(reqPath, "utf-8"))
    const reqs: any[] = reqData.funItem ?? reqData.requirements ?? []
    for (const req of reqs) {
      const rawId = req.id ?? req.funId
      // funId may be a standard array — join into 、-separated key matching correspond_fun_id
      const id = Array.isArray(rawId) ? rawId.join("、") : rawId
      // 优先使用 name，其次 title
      const label = req.name ?? req.title
      if (id && label) titleMap.set(id, label)
    }
  } catch { /* ignore */ }
  return titleMap
}

/**
 * Render a single DB-format test case as a structured Markdown table block.
 */
function renderDbTestCase(tc: any, caseIdx: number): string {
  let md = ""
  const caseId = tc.case_id || "—"
  const caseName = tc.case_name || "—"
  const typeZh = normalizePhase6TestType(tc.test_type) ?? (tc.test_type || "—")
  const steps = parseTestStepJson(tc.test_step)

  const paddedIdx = String(caseIdx).padStart(4, "0")
  md += `**测试用例${paddedIdx}\t${caseId}**\n\n`

  md += `| 项目 | 内容 |\n`
  md += `|:-----|:-----|\n`
  md += `| 用例名称 | ${caseName} |\n`
  md += `| 用例标识 | ${caseId} |\n`
  md += `| 测试目的 | ${tc.test_purpose || "—"} |\n`
  // 覆盖测试需求项：显示本用例实际覆盖的 TR 子集(related_software_req_ids,
  // 已是范围显示形式),不是需求项整组 correspond_fun_id;rsrid 缺失(历史数据)才回退整组
  const relatedReqIds = typeof tc.related_software_req_ids === "string" && tc.related_software_req_ids.trim()
    ? tc.related_software_req_ids.trim()
    : ""
  const coveredDisplay = relatedReqIds
    ? (formatFunIdsAsRange(splitFunIds(relatedReqIds)) || relatedReqIds)
    : (formatFunIdsAsRange(splitFunIds(tc.correspond_fun_id)) || tc.correspond_fun_id || "—")
  md += `| 覆盖测试需求项 | ${coveredDisplay} |\n`
  md += `| 测试类型 | ${typeZh} |\n`
  md += `| 前提和约束 | ${tc.constraints || "无"} |\n`
  md += `| 初始设置 | ${tc.initial_settings || "无"} |\n`
  md += `| 测试环境 | ${tc.test_environment || "无"} |\n`
  md += `| 测试输入 | ${tc.test_input || "无"} |\n`
  md += `\n`

  if (steps.length > 0) {
    md += `| 序号 | 测试步骤 | 预期结果 | 实际结果 |\n`
    md += `|:-----|:---------|:---------|:--------|\n`
    for (let i = 0; i < steps.length; i++) {
      md += `| ${i + 1} | ${steps[i].步骤描述 || "—"} | ${steps[i].预期结果 || "—"} | |\n`
    }
    md += `\n`
  }

  md += `| 项目 | 内容 |\n`
  md += `|:-----|:-----|\n`
  md += `| 评估准则 | ${tc.assess_criteria || "实际结果与预期结果一致"} |\n`
  md += `| 终止条件 | ${tc.cease_condition || "—"} |\n`
  md += `| 设计人员 | ${tc.designer || "—"} |\n`
  md += `| 设计日期 | ${formatDateZh(tc.designer_date) || "—"} |\n`
  md += `\n`

  return md
}

function renderTestCases(data: any, dataFile?: string): string {
  // Auto-detect data format
  const dbFormat = isDbFormat(data)
  return dbFormat ? renderTestCasesDbFormat(data, dataFile) : renderTestCasesStructured(data)
}

/**
 * Render test cases in DB format (case_id, case_name, test_step JSON string, Chinese test_type).
 * Follows the template specification at templates/test-cases.md.
 * Document structure:
 *   1 测评依据 → 2 测评性质 → 3 测评对象及环境 → 4 首轮测试用例设计 → 附件
 */
function renderTestCasesDbFormat(data: any, dataFile?: string): string {
  // Phase 6 no longer falls back to sibling software-analysis.json.
  // Use suite top-level metadata written by ct_suite_create / ct_suite_finalize.
  const projectName = data.project_name || "N/A"
  const version = data.version || "N/A"
  const createdDate = formatDateZh(data.created_date) || "N/A"

  const dataDir = dataFile ? dirname(dataFile) : ""
  const reqTitleMap = dataDir ? loadReqTitleMap(dataDir) : new Map<string, string>()

  let md = ""

  // ========== Cover ==========
  md += `# ${projectName} 确认测试说明\n\n`
  md += `**版本**: ${version}  \n`
  md += `**日期**: ${createdDate}  \n\n`
  md += `---\n\n`

  // ========== 1 测评依据 ==========
  md += `## 1 测评依据\n\n`

  md += `### 1.1 测评任务来源\n\n`
  md += `无\n\n`

  md += `### 1.2 依据文件\n\n`

  md += `#### 1.2.1 管理类文件\n\n`
  md += `无\n\n`

  md += `#### 1.2.2 顶层技术文件\n\n`
  md += `无\n\n`

  md += `#### 1.2.3 被测软件文件\n\n`
  if (projectName !== "N/A") {
    md += `| 序号 | 文件名称 | 文件编号 | 版本 |\n`
    md += `|:-----|:---------|:--------|:-----|\n`
    md += `| 1 | ${projectName} | — | ${version} |\n`
    md += `\n`
  } else {
    md += `无\n\n`
  }

  md += `#### 1.2.4 其他文件\n\n`
  md += `无\n\n`

  // ========== 2 测评性质 ==========
  md += `## 2 测评性质\n\n`
  md += `无\n\n`

  // ========== 3 测评对象及环境 ==========
  md += `## 3 测评对象及环境\n\n`

  md += `### 3.1 测评对象\n\n`

  md += `#### 3.1.1 软件概述\n\n`
  const totalCases = Number(data.summary?.total_cases ?? data.test_cases?.length ?? 0)
  md += totalCases > 0
    ? `${projectName}确认测试共设计${totalCases}项测试用例。\n\n`
    : `无\n\n`

  md += `#### 3.1.2 软件基本信息\n\n`
  md += `| 项目 | 内容 |\n`
  md += `|:-----|:-----|\n`
  md += `| 软件名称 | ${projectName} |\n`
  md += `| 软件版本 | ${version} |\n`
  md += `\n`

  md += `#### 3.1.3 软件主要功能性能指标\n\n`
  md += `无\n\n`

  md += `#### 3.1.4 软件摸边探底情况\n\n`
  md += `无\n\n`

  md += `### 3.2 静态测试环境\n\n`

  md += `#### 3.2.1 测评环境说明\n\n`
  const env = data.test_environment_summary
  if (env?.hardware_environment || env?.software_environment) {
    if (env.hardware_environment) md += `**硬件环境**：${env.hardware_environment}\n\n`
    if (env.software_environment) md += `**软件环境**：${env.software_environment}\n\n`
  } else {
    md += `无\n\n`
  }

  md += `#### 3.2.2 软件项\n\n`
  if (env?.test_tools?.length) {
    md += `| 序号 | 工具名称 | 用途 | 版本 |\n`
    md += `|:-----|:---------|:-----|:-----|\n`
    let toolIdx = 1
    for (const t of env.test_tools) {
      md += `| ${toolIdx} | ${t.name} | ${t.purpose} | ${t.version} |\n`
      toolIdx++
    }
    md += `\n`
  } else {
    md += `无\n\n`
  }

  md += `#### 3.2.3 硬件和固件项\n\n`
  md += `无\n\n`

  md += `### 3.3 仿真测试环境\n\n`

  md += `#### 3.3.1 测评环境说明\n\n`
  md += `无\n\n`

  md += `#### 3.3.2 软件项\n\n`
  md += `无\n\n`

  md += `#### 3.3.3 硬件和固件项\n\n`
  md += `无\n\n`

  md += `#### 3.3.4 测评数据\n\n`
  md += `无\n\n`

  md += `#### 3.3.5 测评环境差异\n\n`
  md += `无\n\n`

  md += `### 3.4 半实物测试环境\n\n`

  md += `#### 3.4.1 测评环境说明\n\n`
  md += `无\n\n`

  md += `#### 3.4.2 软件项\n\n`
  md += `无\n\n`

  md += `#### 3.4.3 硬件和固件项\n\n`
  md += `无\n\n`

  md += `#### 3.4.4 测评数据\n\n`
  md += `无\n\n`

  md += `#### 3.4.5 测评环境差异\n\n`
  md += `无\n\n`

  // ========== 4 首轮测试用例设计 ==========
  if (data.test_cases?.length) {
    const byType: Record<string, any[]> = {}
    for (const tc of data.test_cases) {
      const type = normalizePhase6TestType(tc.test_type) ?? (tc.test_type || "未分类")
      if (!byType[type]) byType[type] = []
      byType[type].push(tc)
    }

    md += `## 4 首轮测试用例设计\n\n`
    let sectionIdx = 1

    // Build ordered type list: DOCX order first, then any remaining
    const orderedTypes = [...DOCX_TEST_TYPE_ORDER]
    for (const typeZh of Object.keys(byType)) {
      if (!orderedTypes.includes(typeZh)) orderedTypes.push(typeZh)
    }

    for (const typeZh of orderedTypes) {
      const cases = byType[typeZh]
      if (!cases?.length) continue

      md += `### 4.${sectionIdx} ${typeZh}\n\n`

      // Group by correspond_fun_id for potential subsections
      const byReq: Map<string, any[]> = new Map()
      for (const tc of cases) {
        const reqId = tc.correspond_fun_id || "未知需求"
        if (!byReq.has(reqId)) byReq.set(reqId, [])
        byReq.get(reqId)!.push(tc)
      }

      const reqIds = [...byReq.keys()]
      const hasSubsections = reqIds.length > 1

      if (hasSubsections) {
        let subIdx = 1
        for (const reqId of reqIds) {
          const subTitle = reqTitleMap.get(reqId) || reqId
          md += `#### 4.${sectionIdx}.${subIdx} ${subTitle}\n\n`
          let caseIdx = 1
          for (const tc of byReq.get(reqId)!) {
            md += renderDbTestCase(tc, caseIdx)
            caseIdx++
          }
          subIdx++
        }
      } else {
        let caseIdx = 1
        for (const tc of cases) {
          md += renderDbTestCase(tc, caseIdx)
          caseIdx++
        }
      }

      sectionIdx++
    }
  }

  // ========== 附件: 验证用例覆盖性说明 ==========
  if (data.traceability?.length && data.test_cases?.length) {
    md += `## 附件\n\n`
    md += `### 附件1 验证用例覆盖性说明\n\n`
    md += `| 序号 | 测试项名称 | 测试项标识 | 对应验证用例标识 |\n`
    md += `|:-----|:----------|:----------|:----------------|\n`

    // Build reqId → test_type lookup from test cases
    const reqTypeMap: Record<string, string> = {}
    for (const tc of data.test_cases) {
      if (tc.correspond_fun_id && tc.test_type) {
        reqTypeMap[tc.correspond_fun_id] = normalizePhase6TestType(tc.test_type) ?? tc.test_type
      }
    }

    // Sort traceability entries by original test-requirements.json order
    const reqOrderMap = dataDir ? loadReqOrderMap(dataDir) : new Map<string, number>()
    const sortedTraceability = [...(data.traceability as any[])].sort((a, b) => {
      const ai = reqOrderMap.has(a.test_req_id) ? reqOrderMap.get(a.test_req_id)! : Infinity
      const bi = reqOrderMap.has(b.test_req_id) ? reqOrderMap.get(b.test_req_id)! : Infinity
      if (ai !== bi) return ai - bi
      return String(a.test_req_id).localeCompare(String(b.test_req_id))
    })

    let appIdx = 1
    for (const t of sortedTraceability) {
      const rawReqId = t.test_req_id || "—"
      // 显示时转换为范围形式（如 "TR-JK-001~003"），查找仍用 、-joined 原始键
      const displayReqId = rawReqId === "—"
        ? "—"
        : formatFunIdsAsRange(splitFunIds(rawReqId)) || rawReqId
      // 优先显示测试需求的名称（name），其次显示测试类型
      const itemName = reqTitleMap.get(rawReqId) || reqTypeMap[rawReqId] || "—"
      const caseIds = t.case_ids || t.test_case_ids || []
      const rangeStr = formatCaseIdRange(caseIds)
      md += `| ${appIdx} | ${itemName} | ${displayReqId} | ${rangeStr} |\n`
      appIdx++
    }
    md += `\n`
  }

  return md
}

/**
 * Render test cases in structured format (id, title, steps array, English test_type enum).
 * Original rendering logic for the non-DB schema.
 */
function renderTestCasesStructured(data: any): string {
  let md = `# ${data.project_name || "N/A"} 第三方测试说明\n\n`
  md += `**版本**: ${data.version || "N/A"}  \n`
  md += `**日期**: ${data.created_date || "N/A"}  \n\n`
  md += `---\n\n`

  // --- Section 1: Summary table ---
  if (data.summary) {
    md += `## 1 测试用例汇总\n\n`
    md += `| 测试类型 | 用例数量 |\n|---------|--------|\n`
    if (data.summary.by_type && Object.keys(data.summary.by_type).length) {
      for (const type of TEST_TYPE_ORDER) {
        const count = data.summary.by_type[type]
        if (count != null && count > 0) {
          md += `| ${TEST_TYPE_ZH[type] || type} | ${count} |\n`
        }
      }
    }
    md += `| **合计** | **${data.summary.total_cases}** |\n\n`

    if (data.summary.by_method && Object.keys(data.summary.by_method).length) {
      md += `### 设计方法统计\n\n`
      md += `| 设计方法 | 用例数量 |\n|---------|--------|\n`
      for (const [method, count] of Object.entries(data.summary.by_method)) {
        md += `| ${TEST_METHOD_ZH[method] || method} | ${count} |\n`
      }
      md += `\n`
    }
  }

  // --- Section 2: Test environment ---
  if (data.test_environment_summary || data.test_cases?.length) {
    md += `## 2 测试环境\n\n`
    const envSummary = data.test_environment_summary

    if (envSummary?.hardware_environment) {
      md += `### 2.1 硬件环境\n\n${envSummary.hardware_environment}\n\n`
    }
    if (envSummary?.software_environment) {
      md += `### 2.2 软件环境\n\n${envSummary.software_environment}\n\n`
    }
    if (envSummary?.test_tools?.length) {
      md += `### 2.3 测试工具\n\n`
      md += `| 序号 | 工具名称 | 用途 | 版本 |\n|------|---------|-----|------|\n`
      let toolIdx = 1
      for (const t of envSummary.test_tools) {
        md += `| ${toolIdx} | ${t.name} | ${t.purpose} | ${t.version} |\n`
        toolIdx++
      }
      md += `\n`
    }

    // Derive environment_types table from test cases
    if (data.test_cases?.length) {
      const envByType: Record<string, Set<string>> = {}
      for (const tc of data.test_cases) {
        const type = tc.test_type || "unknown"
        if (!envByType[type]) envByType[type] = new Set()
        if (tc.test_environment_type) envByType[type].add(tc.test_environment_type)
      }
      const envEntries = TEST_TYPE_ORDER.filter((t) => envByType[t]?.size)
      if (envEntries.length) {
        md += `### 2.${envSummary?.test_tools?.length ? "4" : "3"} 环境类型说明\n\n`
        md += `| 序号 | 测试类型 | 环境类型 |\n|------|---------|--------|\n`
        let envIdx = 1
        for (const type of envEntries) {
          const types = [...envByType[type]].map((e) => ENV_TYPE_ZH[e] || e).join("、")
          md += `| ${envIdx} | ${TEST_TYPE_ZH[type] || type} | ${types} |\n`
          envIdx++
        }
        md += `\n`
      }
    }
  }

  // --- Section 3: Test cases grouped by type ---
  if (data.test_cases?.length) {
    const byType: Record<string, any[]> = {}
    for (const tc of data.test_cases) {
      const type = tc.test_type || "unknown"
      if (!byType[type]) byType[type] = []
      byType[type].push(tc)
    }

    md += `## 3 测试用例\n\n`
    let sectionIdx = 1
    for (const type of TEST_TYPE_ORDER) {
      const cases = byType[type]
      if (!cases?.length) continue

      const typeZh = TEST_TYPE_ZH[type] || type
      md += `### 3.${sectionIdx} ${typeZh}用例\n\n`

      for (const tc of cases) {
        md += `#### ${tc.id} ${tc.title}\n\n`

        // Case info table
        md += `| 属性 | 内容 |\n|------|------|\n`
        md += `| 用例标识 | ${tc.id} |\n`
        md += `| 测试类型 | ${typeZh} |\n`
        md += `| 设计方法 | ${TEST_METHOD_ZH[tc.test_method] || tc.test_method} |\n`
        md += `| 关联测试需求 | ${tc.related_test_req_ids?.join(", ") || "—"} |\n`
        md += `| 关联软件需求 | ${tc.related_software_req_ids || "—"} |\n`
        if (tc.design_rationale) md += `| 设计依据 | ${tc.design_rationale} |\n`
        if (tc.estimated_duration_min) md += `| 预估执行时间 | ${tc.estimated_duration_min} 分钟 |\n`
        md += `| 状态 | ${STATUS_ZH[tc.status] || tc.status} |\n`
        md += `\n`

        // Description
        if (tc.description) {
          md += `**用例描述**\n\n${tc.description}\n\n`
        }

        // Preconditions
        if (tc.preconditions?.length) {
          md += `**前提条件**\n\n`
          for (const p of tc.preconditions) {
            md += `- ${p}\n`
          }
          md += `\n`
        }

        // Initial setup
        if (tc.initial_setup) {
          md += `**初始化设置**\n\n${tc.initial_setup}\n\n`
        }

        // Test environment
        if (tc.test_environment || tc.test_environment_type) {
          md += `**测试环境**\n\n`
          if (tc.test_environment_type) md += `- 环境类型：${ENV_TYPE_ZH[tc.test_environment_type] || tc.test_environment_type}\n`
          if (tc.test_environment?.platform) md += `- 测试平台：${tc.test_environment.platform}\n`
          if (tc.test_environment?.tools?.length) md += `- 测试工具：${tc.test_environment.tools.join(", ")}\n`
          if (tc.test_environment?.configuration) md += `- 配置说明：${tc.test_environment.configuration}\n`
          md += `\n`
        }

        // Test input
        if (tc.test_input) {
          md += `**测试输入**\n\n${tc.test_input}\n\n`
        }

        // Steps table
        if (tc.steps?.length) {
          md += `**操作步骤**\n\n`
          md += `| 步骤号 | 操作 | 输入数据 | 预期结果 | 判定准则 |\n`
          md += `|-------|------|---------|---------|--------|\n`
          for (const s of tc.steps) {
            const input = s.input_data || "—"
            md += `| ${s.step_number} | ${s.action} | ${input} | ${s.expected_result} | ${s.judgment_criteria} |\n`
          }
          md += `\n`
        }

        // Postconditions
        if (tc.postconditions?.length) {
          md += `**后置条件**\n\n`
          for (const p of tc.postconditions) {
            md += `- ${p}\n`
          }
          md += `\n`
        }

        // Evaluation criteria
        if (tc.evaluation_criteria) {
          md += `**综合评判准则**\n\n${tc.evaluation_criteria}\n\n`
        }

        // Termination conditions
        if (tc.termination_conditions) {
          md += `**终止条件**\n\n${tc.termination_conditions}\n\n`
        }

        // Technical elements
        if (tc.technical_elements?.length) {
          md += `**关键技术要素**\n\n`
          for (const te of tc.technical_elements) {
            md += `- ${te}\n`
          }
          md += `\n`
        }

        md += `---\n\n`
      }

      sectionIdx++
    }
  }

  // --- Section 4: Untestable items ---
  if (data.untestable_items?.length) {
    md += `## 4 不可动态测试项\n\n`
    md += `| 序号 | 测试需求标识 | 不可测试原因 | 替代验证方法 |\n`
    md += `|------|------------|------------|------------|\n`
    let idx = 1
    for (const item of data.untestable_items) {
      md += `| ${idx} | ${item.req_id} | ${item.reason} | ${item.alternative_method || "—"} |\n`
      idx++
    }
    md += `\n`
  }

  // --- Section 5: Traceability matrix ---
  if (data.traceability?.length || data.type_coverage?.length) {
    md += `## 5 需求追踪矩阵\n\n`
  }
  if (data.traceability?.length) {
    md += `### 5.1 测试需求 — 测试用例追踪\n\n`
    md += `| 序号 | 测试需求标识 | 对应测试用例标识 | 覆盖状态 |\n`
    md += `|------|------------|----------------|--------|\n`
    let idx = 1
    for (const t of data.traceability) {
      const statusZh = COVERAGE_STATUS_ZH[t.coverage_status] || t.coverage_status
      const caseIds = t.case_ids || t.test_case_ids || []
      md += `| ${idx} | ${t.test_req_id} | ${caseIds.join(", ") || "—"} | ${statusZh} |\n`
      idx++
    }
    md += `\n`
  }

  // --- Section 5.2: Type coverage ---
  if (data.type_coverage?.length) {
    md += `### 5.2 测试类型覆盖统计\n\n`
    md += `| 序号 | 测试类型 | 需求总数 | 已覆盖需求数 | 覆盖率 |\n`
    md += `|------|---------|---------|------------|-------|\n`
    let idx = 1
    for (const tc of data.type_coverage) {
      const typeZh = TEST_TYPE_ZH[tc.test_type] || tc.test_type
      const ratio = typeof tc.coverage_ratio === "number" ? `${(tc.coverage_ratio * 100).toFixed(1)}%` : "—"
      md += `| ${idx} | ${typeZh} | ${tc.total_requirements} | ${tc.covered_requirements} | ${ratio} |\n`
      idx++
    }
    md += `\n`
  }

  return md
}

function renderTestExecution(data: any): string {
  let md = `# Test Execution Report\n\n`
  md += `**Project**: ${data.project_name || "N/A"}  \n`
  md += `**Date**: ${data.created_date || "N/A"}  \n\n`

  if (data.summary) {
    md += `## Summary\n\n`
    md += `| Metric | Value |\n|--------|-------|\n`
    md += `| Total Executed | ${data.summary.total_executed} |\n`
    md += `| Passed | ${data.summary.passed} |\n`
    md += `| Failed | ${data.summary.failed} |\n`
    md += `| Pass Rate | ${data.summary.pass_rate}% |\n`
    md += `| Defects Found | ${data.summary.total_defects_found} |\n\n`
  }

  return md
}

function renderTestSummary(data: any): string {
  let md = `# Test Summary Report\n\n`
  md += `**Project**: ${data.project_name || "N/A"}  \n`
  md += `**Conclusion**: **${data.conclusion?.toUpperCase() || "N/A"}**  \n\n`
  md += `${data.conclusion_rationale || ""}\n\n`

  if (data.metrics) {
    md += `## Metrics\n\n`
    md += `| Metric | Value |\n|--------|-------|\n`
    md += `| Requirement Coverage | ${data.metrics.requirement_coverage_pct}% |\n`
    md += `| Test Cases | ${data.metrics.total_test_cases} |\n`
    md += `| Pass Rate | ${data.metrics.pass_rate}% |\n`
    md += `| Total Defects | ${data.metrics.total_defects} |\n`
    md += `| Open Defects | ${data.metrics.open_defects} |\n`
    md += `| Critical Defects | ${data.metrics.critical_defects} |\n\n`
  }

  if (data.risk_items?.length) {
    md += `## Risk Items\n\n`
    for (const r of data.risk_items) {
      md += `- **[${r.severity}]** ${r.description}`
      if (r.mitigation) md += ` — Mitigation: ${r.mitigation}`
      md += `\n`
    }
    md += `\n`
  }

  if (data.recommendations?.length) {
    md += `## Recommendations\n\n`
    for (const r of data.recommendations) {
      md += `- ${r}\n`
    }
  }

  return md
}
