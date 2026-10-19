import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, isAbsolute, join, resolve } from "path"
import { ARTIFACT_PATHS, REPORT_PATHS } from "../shared/constants"
import { ReviewRecord } from "../schema/review"
import { docGenerator } from "./doc-generator"
import { ctDocxGenerator } from "./ct-docx-generator"
import { coverInfoExtractor } from "./cover-info-extractor"
import { evalDescGenerator } from "./eval-desc-generator"
import { phase6CaseReviewPrepare } from "./phase6-case-review-prepare"
import type { Phase6ProjectType } from "../shared/phase6-prompt-templates"

type PublishStatus = "success" | "error"

type JsonRecord = Record<string, unknown>

function getToolBaseDirectory(ctx?: ToolContext): string {
  const candidates = [ctx?.directory, ctx?.worktree, process.cwd()]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  return candidates[0] || process.cwd()
}

function resolveProjectPath(projectDir: string, supplied: string | undefined, fallback: string): string {
  if (!supplied) return join(projectDir, fallback)
  return isAbsolute(supplied) ? supplied : join(projectDir, supplied)
}

function parseJsonResult(raw: string, label: string): JsonRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} 返回了无法解析的 JSON：${String(error)}`)
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${label} 返回了非法结果`)
  }

  const record = parsed as JsonRecord
  if (typeof record.error === "string" && record.error) {
    // 子工具的校验诊断(issues 含字段路径)必须随错误透传——否则智能体只拿到
    // 一句笼统失败,被迫离开项目目录去读插件源码自行定位(真实事故:2026-08-20)
    const issues = Array.isArray(record.issues) ? record.issues : []
    const issueDetail = issues.length > 0
      ? `；issues: ${issues.slice(0, 10).map((issue) => {
          if (!issue || typeof issue !== "object") return String(issue)
          const item = issue as Record<string, unknown>
          const path = typeof item.path === "string" && item.path ? item.path : "(root)"
          const message = typeof item.message === "string" ? item.message : JSON.stringify(issue)
          return `${path}: ${message}`
        }).join("；")}`
      : ""
    throw new Error(`${label}: ${record.error}${issueDetail}`)
  }
  if (record.status === "error") {
    const errors = Array.isArray(record.errors)
      ? record.errors.slice(0, 10).map((item) => String(item)).join("；")
      : ""
    const detail = record.message ?? record.error ?? (errors || "unknown error")
    throw new Error(`${label}: ${String(detail)}`)
  }

  return record
}

function writePublishState(
  projectDir: string,
  payload: {
    suite_file: string
    translated_suite_file: string
    review_file: string
    published_at: string
    markdown_file: string
    docx_file: string
    eval_desc_file?: string
  },
) {
  const stateFile = join(projectDir, ".matrix", "state", "phase6-publish.json")
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify(payload, null, 2), "utf-8")
  return stateFile
}

function validatePassedReview(projectDir: string, suiteFile: string): string {
  const reviewFile = join(projectDir, ARTIFACT_PATHS.CASE_REVIEW)
  if (!existsSync(reviewFile)) {
    throw new Error(`Phase 6 发布门禁失败：缺少审查文件 ${reviewFile}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(reviewFile, "utf-8"))
  } catch (error) {
    throw new Error(`Phase 6 发布门禁失败：case-review.json 无法解析：${String(error)}`)
  }
  const parsed = ReviewRecord.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Phase 6 发布门禁失败：case-review.json 不符合 ReviewRecord schema`)
  }
  if (parsed.data.verdict !== "PASS") {
    throw new Error(`Phase 6 发布门禁失败：reviewer verdict=${parsed.data.verdict}，必须先完成修订并重审`)
  }
  const blockingReviewIssues = parsed.data.issues.filter((issue) => issue.severity === "blocking")
  if (blockingReviewIssues.length > 0) {
    throw new Error(
      `Phase 6 发布门禁失败：PASS 审查仍包含 ${blockingReviewIssues.length} 个 blocking issue，` +
      "不允许附条件 PASS",
    )
  }

  const reviewedTarget = isAbsolute(parsed.data.target_artifact)
    ? parsed.data.target_artifact
    : join(projectDir, parsed.data.target_artifact)
  if (resolve(reviewedTarget) !== resolve(suiteFile)) {
    throw new Error(
      `Phase 6 发布门禁失败：审查目标 ${parsed.data.target_artifact} 与待发布 suite ${suiteFile} 不一致`,
    )
  }
  return reviewFile
}

async function validateDeterministicPreReview(
  suiteFile: string,
  ctx: ToolContext,
  context: { test_requirements_file?: string; project_type?: Phase6ProjectType },
): Promise<{ preparedFile?: string }> {
  // 发布复验必须沿用生成的输入/项目类型，而非重置到默认 software。
  // 显式参数仍优先；若与来源清单不同，预审会给出 blocking 漂移问题。
  const manifestFile = join(getToolBaseDirectory(ctx), ARTIFACT_PATHS.PHASE6_GENERATION_MANIFEST)
  let recorded: JsonRecord = {}
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"))
    if (manifest?.template_provenance_version === 1) recorded = manifest
  }
  const raw = await (phase6CaseReviewPrepare as any).execute(
    {
      confirmation_tests_file: suiteFile,
      test_requirements_file: context.test_requirements_file ?? recorded.test_requirements_file,
      project_type: context.project_type ?? recorded.project_type,
    },
    ctx,
  )
  const result = parseJsonResult(raw, "phase6_case_review_prepare")
  const candidateIssues = Array.isArray(result.candidate_issues)
    ? result.candidate_issues.filter((issue): issue is JsonRecord => Boolean(issue) && typeof issue === "object")
    : []
  const blocking = candidateIssues.filter((issue) => issue.severity === "blocking")
  if (blocking.length > 0) {
    const details = blocking.slice(0, 5).map((issue) =>
      `${String(issue.category ?? "blocking")}: ${String(issue.description ?? "未提供说明")}`,
    )
    throw new Error(
      `Phase 6 发布门禁失败：最新确定性预审仍有 ${blocking.length} 个 blocking issue；${details.join("；")}`,
    )
  }

  const counts = result.counts && typeof result.counts === "object"
    ? result.counts as JsonRecord
    : {}
  if (Number(counts.uncovered_requirements ?? 0) > 0) {
    throw new Error(
      `Phase 6 发布门禁失败：仍有 ${String(counts.uncovered_requirements)} 个未覆盖 requirement`,
    )
  }
  return {
    preparedFile: typeof result.prepared_file === "string" ? result.prepared_file : undefined,
  }
}

export function createPhase6PublishOutputs(_client?: unknown): ToolDefinition {
  return tool({
    description:
      "在 Phase 6 review PASS 之后统一发布正式产物。根据 .matrix/data/confirmation-tests.json 生成 Markdown/DOCX，" +
      "并在条件满足时补充封面信息提取与鉴定测评说明；DTP 数据/Robot 生成由 phase6_execution_loop 负责。",
    args: {
      suite_file: tool.schema
        .string()
        .optional()
        .describe("源确认测试用例套件文件路径，默认 .matrix/data/confirmation-tests.json"),
      test_requirements_file: tool.schema.string().optional()
        .describe("发布复验使用的测试需求文件；默认沿用版本 1 生成清单中的路径，历史工件使用标准路径。"),
      project_type: tool.schema.enum(["software", "software_variant", "fpga", "requirements"]).optional()
        .describe("发布复验的项目类型；默认沿用生成清单，必须与生成时一致。"),
      use_outline: tool.schema
        .boolean()
        .optional()
        .describe("是否启用大纲发布分支。默认 false。"),
      reference_path: tool.schema
        .string()
        .optional()
        .describe("大纲或参考 DOCX 路径；存在时可提取封面信息，配合 use_outline=true 时可生成鉴定测评说明。"),
      doc_type: tool.schema
        .enum(["software", "fpga"])
        .optional()
        .describe("鉴定测评说明的文档类型；仅在 use_outline=true 且 reference_path 存在时使用。"),
      dtp_root: tool.schema
        .string()
        .optional()
        .describe("兼容旧调用保留；phase6_publish_outputs 不再生成 DTP 数据/Robot，DTP 准备统一由 phase6_execution_loop 处理。"),
      software_id: tool.schema
        .string()
        .optional()
        .describe("用于 DOCX/鉴定测评说明占位符的 software_id。"),
      code_version: tool.schema
        .string()
        .optional()
        .describe("用于 DOCX/鉴定测评说明占位符的 code_version。"),
      designer: tool.schema
        .string()
        .optional()
        .describe("用于鉴定测评说明占位符的设计人员。"),
    },
    async execute({
      suite_file,
      test_requirements_file,
      project_type,
      use_outline,
      reference_path,
      doc_type,
      dtp_root,
      software_id,
      code_version,
      designer,
    }, ctx) {
      const projectDir = getToolBaseDirectory(ctx)
      const suiteFile = resolveProjectPath(
        projectDir,
        suite_file,
        ARTIFACT_PATHS.CONFIRMATION_TESTS,
      )

      if (!existsSync(suiteFile)) {
        return JSON.stringify({
          status: "error" satisfies PublishStatus,
          error: `Confirmation test suite not found: ${suiteFile}`,
        })
      }

      const markdownFile = join(projectDir, REPORT_PATHS.TEST_CASES)
      const docxFile = join(projectDir, ".matrix", "reports", "confirmation-tests.docx")
      const translatedSuiteFile = join(projectDir, ARTIFACT_PATHS.CONFIRMATION_TESTS)
      const warnings: string[] = []
      if (dtp_root) {
        warnings.push("dtp_root 参数已保留兼容但不在发布阶段使用；DTP 数据/Robot 生成已延后到 phase6_execution_loop。")
      }

      try {
        const reviewFile = validatePassedReview(projectDir, suiteFile)
        const preReview = await validateDeterministicPreReview(suiteFile, ctx, { test_requirements_file, project_type })
        const docGeneratorResult = parseJsonResult(
          await (docGenerator as any).execute(
            {
              data_file: suiteFile,
              doc_type: "test-cases",
              output_file: markdownFile,
            },
            ctx,
          ),
          "doc_generator",
        )

        let coverInfoFile: string | undefined
        if (reference_path) {
          const referencePath = resolveProjectPath(projectDir, reference_path, reference_path)
          if (existsSync(referencePath)) {
            const coverInfoResult = parseJsonResult(
              await (coverInfoExtractor as any).execute(
                { docx_path: referencePath },
                ctx,
              ),
              "cover_info_extract",
            )
            if (typeof coverInfoResult.output_file === "string") {
              coverInfoFile = coverInfoResult.output_file
            } else {
              coverInfoFile = join(projectDir, ".matrix", "data", "cover-info.json")
            }
          } else {
            warnings.push(`reference_path 不存在，已跳过 cover_info_extract：${referencePath}`)
          }
        }

        const docxGeneratorResult = parseJsonResult(
          await (ctDocxGenerator as any).execute(
            {
              test_cases_file: suiteFile,
              output_path: docxFile,
              software_id,
              code_version,
              ...(coverInfoFile ? { cover_info_file: coverInfoFile } : {}),
            },
            ctx,
          ),
          "ct_docx_generate",
        )

        let evalDescFile: string | undefined
        if (use_outline === true) {
          if (reference_path && doc_type) {
            const referencePath = resolveProjectPath(projectDir, reference_path, reference_path)
            if (existsSync(referencePath)) {
              const evalDescResult = parseJsonResult(
                await (evalDescGenerator as any).execute(
                  {
                    doc_type,
                    reference_path: referencePath,
                    test_cases_file: suiteFile,
                    software_id,
                    code_version,
                    designer,
                    ...(coverInfoFile ? { cover_info_file: coverInfoFile } : {}),
                  },
                  ctx,
                ),
                "eval_desc_generate",
              )
              if (typeof evalDescResult.output_path === "string") {
                evalDescFile = evalDescResult.output_path
              }
            } else {
              warnings.push(`reference_path 不存在，已跳过 eval_desc_generate：${referencePath}`)
            }
          } else {
            warnings.push("use_outline=true 但缺少 reference_path 或 doc_type，已跳过 eval_desc_generate。")
          }
        }

        const publishStateFile = writePublishState(projectDir, {
          suite_file: suiteFile,
          translated_suite_file: translatedSuiteFile,
          review_file: reviewFile,
          published_at: new Date().toISOString(),
          markdown_file: typeof docGeneratorResult.output_file === "string"
            ? docGeneratorResult.output_file
            : markdownFile,
          docx_file: typeof docxGeneratorResult.output_path === "string"
            ? docxGeneratorResult.output_path
            : typeof docxGeneratorResult.output_file === "string"
            ? docxGeneratorResult.output_file
            : docxFile,
          ...(evalDescFile ? { eval_desc_file: evalDescFile } : {}),
        })

        return JSON.stringify({
          status: "success" satisfies PublishStatus,
          suite_file: suiteFile,
          source_suite_file: suiteFile,
          translated_suite_file: translatedSuiteFile,
          markdown_file: typeof docGeneratorResult.output_file === "string"
            ? docGeneratorResult.output_file
            : markdownFile,
          docx_file: typeof docxGeneratorResult.output_path === "string"
            ? docxGeneratorResult.output_path
            : typeof docxGeneratorResult.output_file === "string"
            ? docxGeneratorResult.output_file
            : docxFile,
          ...(coverInfoFile ? { cover_info_file: coverInfoFile } : {}),
          ...(evalDescFile ? { eval_desc_file: evalDescFile } : {}),
          dtp_generation_deferred_to: "phase6_execution_loop",
          publish_state_file: publishStateFile,
          review_file: reviewFile,
          ...(preReview.preparedFile ? { prepared_review_file: preReview.preparedFile } : {}),
          warnings: warnings.length > 0 ? warnings : undefined,
        })
      } catch (error) {
        return JSON.stringify({
          status: "error" satisfies PublishStatus,
          error: error instanceof Error ? error.message : String(error),
          suite_file: suiteFile,
          source_suite_file: suiteFile,
          translated_suite_file: translatedSuiteFile,
          warnings: warnings.length > 0 ? warnings : undefined,
        })
      }
    },
  })
}

export const phase6PublishOutputs: ToolDefinition = createPhase6PublishOutputs()
