import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk/client"
import {
  createDtpDataModelHooks,
  normalizeDocsContext,
  normalizeWorkspaceRoot,
  resolveDefaultPaths,
  runDtpCaseDataInstantiation,
} from "./dtp-data-generation-core"

export function createDtpTestDataGenerator(client?: OpencodeClient | null): ToolDefinition {
  return tool({
    description:
      "Instantiate case-level DTP test data from .matrix/data/test-cases-todo.txt and " +
      ".matrix/data/confirmation-tests.json. This layer consumes only ${time} directly from upstream " +
      "step parameters, reuses project-level generated data files when possible, dynamically fills missing " +
      "file arguments when needed, and writes .matrix/data/dtp-generation/generated-test-data.json for Robot rendering. " +
      "Source mode limits project document discovery to filenames containing 第三方测试需求; offline mode reuses the existing knowledge index.",
    args: {
      project_dir: tool.schema
        .string()
        .optional()
        .describe("Workspace root directory. Defaults to the current OpenCode workspace and cannot point outside it."),
      knowledge_mode: tool.schema
        .enum(["source", "offline"])
        .optional()
        .describe(
          "Knowledge source mode. source scans third-party requirement documents; offline requires and reuses " +
          ".matrix/data/dtp-generation/project-knowledge-index.json without scanning source documents. Defaults to source.",
        ),
      background_docs: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Optional background-knowledge document paths or descriptors."),
      hardware_docs: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Optional hardware-interface document paths or descriptors."),
      protocol_docs: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Optional data-protocol document paths or descriptors."),
      convention_docs: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Optional data-convention document paths or descriptors."),
      packet_structure_docs: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Optional packet-structure document paths or descriptors."),
      format_rule_docs: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Optional format-validation rule document paths or descriptors."),
      requirement_docs: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Optional requirement document paths or descriptors."),
    },
    async execute(args, context) {
      try {
        const workspaceRoot = normalizeWorkspaceRoot(args.project_dir, context.directory)
        const docsContext = normalizeDocsContext({
          backgroundDocs: args.background_docs,
          hardwareDocs: args.hardware_docs,
          protocolDocs: args.protocol_docs,
          conventionDocs: args.convention_docs,
          packetStructureDocs: args.packet_structure_docs,
          formatRuleDocs: args.format_rule_docs,
          requirementDocs: args.requirement_docs,
        })

        const result = await runDtpCaseDataInstantiation(
          workspaceRoot,
          docsContext,
          createDtpDataModelHooks(client, context),
          undefined,
          { knowledgeMode: args.knowledge_mode },
        )
        const paths = resolveDefaultPaths(workspaceRoot)
        const generatedSteps = result.cases.flatMap((testCase) => testCase.generated_steps)
        const qualityCounts = generatedSteps.reduce(
          (counts, step) => {
            const status = step.data_quality?.status ?? "pass"
            counts[status] += 1
            return counts
          },
          { pass: 0, warning: 0, failed: 0 },
        )
        const warningPreview = Array.from(new Set(result.warnings)).slice(0, 20)
        return JSON.stringify(
          {
            status: "success",
            schema_version: "1.1.0",
            generation_scope: "case_level",
            knowledge_mode_requested: args.knowledge_mode ?? "source",
            knowledge_mode_effective: args.knowledge_mode ?? "source",
            knowledge_index_file: paths.projectKnowledgeIndexFile,
            source_document_scan_performed:
              (args.knowledge_mode ?? "source") === "source" && result.cases.length > 0,
            generated_test_data_file: paths.generatedDataFile,
            diagnostics_index_file: paths.generatedDiagnosticsIndexFile,
            case_checkpoint_dir: paths.generatedCasesDir,
            case_diagnostics_dir: paths.generatedDiagnosticsDir,
            case_data_output_layout: "DTPProject/V1/输入数据/{输入流|输出流}/用例生成/{case_id}",
            case_count: result.cases.length,
            step_count: generatedSteps.length,
            quality_counts: qualityCounts,
            warning_count: new Set(result.warnings).size,
            warnings: warningPreview,
            warnings_truncated: Math.max(0, new Set(result.warnings).size - warningPreview.length),
          },
          null,
          2,
        )
      } catch (error) {
        return JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        )
      }
    },
  })
}

export const dtpTestDataGenerator: ToolDefinition = createDtpTestDataGenerator()
