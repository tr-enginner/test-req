import {describe, expect, it} from "vitest";
import {
    missingCompletionStages,
    parseToolOutput,
    progressOf,
    REQUIRED_COMPLETION_STAGES,
    STAGE_WEIGHTS,
    workerBatchIndex
} from "./progress.js";

describe("Phase 2 progress", () => {
    it("never reaches 100 before final verification", () => {
        expect(progressOf(new Set(Object.keys(STAGE_WEIGHTS)))).toBe(99)
    });
    it("advances after completed stages", () => {
        expect(progressOf(new Set(["discover_documents", "prepare_document_artifacts"]))).toBeGreaterThan(0)
    });
    it("rejects invalid tool output", () => {
        expect(parseToolOutput("not-json").error).toContain("没有可定位的业务raw.json")
    });
    it("keeps business failures", () => {
        expect(parseToolOutput('{"ok":false,"error":"missing_inputs"}').error).toBe("missing_inputs")
    })

    it("distinguishes truncated OpenCode output from an invalid business JSON artifact", () => {
        const result = parseToolOutput("...The tool call succeeded but the output was truncated...", {
            truncated: true,
            outputPath: "/root/.local/share/opencode/tool-output/tool_123",
        })
        expect(result.ok).toBe(false)
        expect(result.error).toContain("并非某个业务raw.json无效")
        expect(result.error).toContain("/root/.local/share/opencode/tool-output/tool_123")
    })
    it("extracts every compact worker batch index", () => {
        expect(workerBatchIndex("get_hardware_interface_worker_batch", {hardware_interface_worker_batch_index: 2})).toBe(2)
        expect(workerBatchIndex("get_interface_test_worker_batch", {interface_test_worker_batch_index: 4})).toBe(4)
        expect(workerBatchIndex("get_functional_other_content_worker_batch", {functional_other_content_worker_batch_index: 6})).toBe(6)
    })
    it("does not accept an early idle session as complete", () => {
        expect(missingCompletionStages(new Set(["discover_documents"]))).toEqual(REQUIRED_COMPLETION_STAGES)
    });
    it("accepts only all required final stages", () => {
        expect(missingCompletionStages(new Set(REQUIRED_COMPLETION_STAGES))).toEqual([])
    })
});
