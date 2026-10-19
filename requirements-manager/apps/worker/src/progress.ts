export const STAGE_WEIGHTS: Record<string, number> = {
    discover_documents: 3,
    prepare_document_artifacts: 5,
    prepare_chapter1_scope: 2,
    finalize_chapter1_scope: 5,
    prepare_chapter2_system_overview: 2,
    finalize_chapter2_system_overview: 5,
    discover_hardware_interface_candidates: 3,
    prepare_hardware_interface_batches: 3,
    merge_hardware_interface_blocks: 4,
    finalize_hardware_interface: 7,
    prepare_functional_title_tree: 2,
    finalize_functional_title_tree: 3,
    prepare_functional_init_content: 2,
    finalize_functional_init_content: 3,
    prepare_functional_other_content: 3,
    finalize_functional_other_content: 7,
    finalize_functional_test_content: 5,
    prepare_performance_test_content: 2,
    finalize_performance_test_content: 4,
    prepare_interface_test_content: 2,
    finalize_interface_test_content: 4,
    prepare_reliability_safety_test_content: 2,
    finalize_reliability_safety_test_content: 4,
    prepare_margin_test_content: 1,
    finalize_margin_test_content: 3,
    prepare_boundary_test_content: 1,
    finalize_boundary_test_content: 3,
    prepare_data_processing_test_content: 1,
    finalize_data_processing_test_content: 3,
    prepare_recovery_test_content: 1,
    finalize_recovery_test_content: 3,
    prepare_strength_test_content: 1,
    finalize_strength_test_content: 3,
    generate_phase2_traceability: 5,
    finalize_phase2_document: 7
};
export const REQUIRED_COMPLETION_STAGES = [
    "finalize_chapter1_scope",
    "finalize_chapter2_system_overview",
    "finalize_hardware_interface",
    "finalize_functional_test_content",
    "finalize_performance_test_content",
    "finalize_interface_test_content",
    "finalize_reliability_safety_test_content",
    "finalize_margin_test_content",
    "finalize_boundary_test_content",
    "finalize_data_processing_test_content",
    "finalize_recovery_test_content",
    "finalize_strength_test_content",
    "generate_phase2_traceability",
    "finalize_phase2_document"
] as const;
const total = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0);

export function progressOf(completed: Set<string>) {
    return Math.min(99, Math.round([...completed].reduce((sum, stage) => sum + (STAGE_WEIGHTS[stage] || 0), 0) / total * 100))
}

export function missingCompletionStages(completed: Set<string>) {
    return REQUIRED_COMPLETION_STAGES.filter(stage => !completed.has(stage))
}

export function workerBatchIndex(mode: string, input: Record<string, unknown>): number | undefined {
    const key = {
        get_functional_other_content_worker_batch: "functional_other_content_worker_batch_index",
        get_hardware_interface_worker_batch: "hardware_interface_worker_batch_index",
        get_interface_test_worker_batch: "interface_test_worker_batch_index"
    }[mode];
    if (!key) return undefined;
    const index = Number(input[key]);
    return Number.isInteger(index) && index > 0 ? index : undefined
}

type ToolOutputMetadata = {truncated?: unknown; outputPath?: unknown} | undefined;

export function parseToolOutput(value: string, metadata?: ToolOutputMetadata) {
    try {
        return JSON.parse(value) as {
            ok?: boolean;
            mode?: string;
            error?: string;
            error_code?: string;
            retryable?: boolean;
            failed_candidate_id?: string;
            summary?: unknown;
            output?: unknown;
            warnings?: unknown[];
            skipped_count?: number
        }
    } catch (error) {
        const outputPath = typeof metadata?.outputPath === "string" ? metadata.outputPath : undefined;
        const truncated = metadata?.truncated === true || value.includes("The tool call succeeded but the output was truncated");
        if (truncated) {
            return {
                ok: false,
                error: `工具输出过长被OpenCode截断，并非某个业务raw.json无效。${outputPath ? `完整工具输出：${outputPath}。` : ""}请缩短该prepare阶段的返回内容或读取完整工具输出后重试。`,
            }
        }
        const detail = error instanceof Error ? error.message : String(error);
        const preview = value.replace(/\s+/g, " ").trim().slice(0, 240);
        return {
            ok: false,
            error: `工具返回值不是有效JSON：${detail}${preview ? `；返回值开头：${preview}` : ""}。该错误发生在工具返回值解析阶段，没有可定位的业务raw.json。`,
        }
    }
}
