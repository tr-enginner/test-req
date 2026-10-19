import { z } from "zod"

/** 单条 SpecChecker 原始违规记录 */
export const SARawFinding = z.object({
  id: z.string(),                          // e.g. "RAW-001"
  rule_id: z.string(),                     // e.g. "CID181"
  rule_name: z.string(),                   // 规则名称
  severity: z.enum(["critical", "major", "minor", "suggestion"]),
  category: z.string().optional(),         // e.g. "C001" (声明定义类) / "C006" (运算处理类)
  conformance: z.string().optional(),      // e.g. "mandatory" / "recommended"
  message: z.string().optional(),          // SpecChecker 违规描述信息
  fixability: z.enum(["auto_fixable", "needs_review", "unfixable"]).optional(),
  file: z.string(),                        // 源文件路径
  line: z.number(),                        // 违规行号
  code_snippet: z.string().optional(),     // 违规代码片段
  check_type: z.enum(["rule_check", "runtime_error", "fault_pattern"]).optional(), // 检查类别：编码规范 / 运行时错误 / 典型故障模式
  patch: z.string().optional(),            // repair patch (仅 repair_enabled 时有值)
})
export type SARawFinding = z.infer<typeof SARawFinding>

/** SA 原始输出报告 */
export const SARawFindingsReport = z.object({
  project_name: z.string(),
  analysis_date: z.string(),              // ISO 8601
  tool: z.literal("specchecker"),
  source_dir: z.string(),
  summary: z.object({
    total: z.number(),
    by_severity: z.record(z.string(), z.number()),
    by_fixability: z.record(z.string(), z.number()),
  }),
  violations: z.array(SARawFinding),
})
export type SARawFindingsReport = z.infer<typeof SARawFindingsReport>
