import { describe, test, expect } from "bun:test"
import { createCommands } from "../src/create-skills"

describe("createCommands", () => {
  test("registers the standalone chapter 2 workflow command", () => {
    const command = createCommands()["matrix-chapter2"]
    expect(command).toBeDefined()
    expect(command.template).toContain("prepare_chapter2_system_overview")
    expect(command.template).toContain("finalize_chapter2_system_overview")
    expect(command.template).toContain("chapter2-system-overview.docx")
  })
  test("registers the standalone chapter 1 command", () => {
    const command = createCommands()["matrix-chapter1"]
    expect(command).toBeDefined()
    expect(command.agent).toBe("phase2-orchestrator")
    expect(command.template).toContain("prepare_chapter1_scope")
    expect(command.template).toContain("finalize_chapter1_scope")
    expect(command.template).toContain("chapter1-scope.docx")
  })
  test("registers the wiki scheduler slash command", () => {
    const commands = createCommands()

    expect(commands["matrix-wiki"]).toBeDefined()
    expect(commands["matrix-wiki"].agent).toBe("wiki-scheduler")
    expect(commands["matrix-wiki"].subtask).toBe(true)
    expect(commands["matrix-wiki"].template).toContain("Execute Phase 1b: Code Wiki Generation.")
    expect(commands["matrix-wiki"].template).toContain("wiki_data_structures_extract")
    expect(commands["matrix-wiki"].template).toContain("GlobalVar global variables")
    expect(commands["matrix-wiki"].template).toContain("top-level kind buckets")
    expect(commands["matrix-wiki"].template).toContain("description fields")
    expect(commands["matrix-wiki"].template).toContain(
      "Reuse only schema-valid function wiki artifacts at .matrix/wiki/functions/<func_name>.json that include parameters and return_value",
    )
    expect(commands["matrix-wiki"].template).toContain(
      "Treat a schema-valid software-analysis.json as the authoritative function ledger; if it is absent or invalid but the staged Phase 1 artifacts exist, finalize them first and then reconcile one-by-one",
    )
    expect(commands["matrix-wiki"].template).toContain("wiki_plan_builder mode=build_plan")
    expect(commands["matrix-wiki"].template).toContain("wiki_execution_planner mode=next_step")
    expect(commands["matrix-wiki"].template).toContain("wiki_artifacts mode=finalize_index")
    expect(commands["matrix-wiki"].template).toContain(
      "If any completion or inventory check finds missing function wiki artifacts, continue scheduling immediately",
    )
    expect(commands["matrix-wiki"].template).toContain("Do not declare completion until wiki_execution_planner returns complete")
  })

  test("keeps the expected command surface for current workflows", () => {
    const commands = createCommands()

    expect(Object.keys(commands)).toEqual(
      expect.arrayContaining([
        "matrix-start",
        "matrix-plan",
        "matrix-analyze",
        "matrix-wiki",
        "matrix-contexts",
        "matrix-hardware-interface",
        "matrix-phase2",
        "matrix-functional-title-tree",
        "matrix-functional-init-content",
        "matrix-functional-other-content",
        "matrix-functional-test-content",
        "matrix-functional-traceability",
        "matrix-interface-test-content",
        "matrix-performance-test-content",
        "matrix-reliability-safety-test-content",
        "matrix-margin-test-content",
        "matrix-boundary-test-content",
        "matrix-data-processing-test-content",
        "matrix-recovery-test-content",
        "matrix-strength-test-content",
        "matrix-review",
        "matrix-test",
        "matrix-dynamic-design",
        "matrix-dynamic-test",
        "matrix-status",
        "matrix-report",
        "matrix-metrics",
        "matrix-astgrep",
        "matrix-static",
        "matrix-isr-review",
        "matrix-multivar-atomicity",
      ]),
    )
  })

  test("registers the standalone performance test content command", () => {
    const command = createCommands()["matrix-performance-test-content"]
    expect(command.agent).toBe("filldata-enricher")
    expect(command.template).toContain("prepare_performance_test_content")
    expect(command.template).toContain("performance-test-content-modeler")
    expect(command.template).toContain("exactly once")
    expect(command.template).toContain("finalize_performance_test_content")
    expect(command.template).toContain("performance.raw.json")
    expect(command.template).not.toContain("performance-test-content-batches")
  })

  test("registers the standalone reliability safety test content command", () => {
    const command = createCommands()["matrix-reliability-safety-test-content"]
    expect(command.agent).toBe("filldata-enricher")
    expect(command.template).toContain("prepare_reliability_safety_test_content")
    expect(command.template).toContain("reliability-safety-test-content-modeler")
    expect(command.template).toContain("exactly once")
    expect(command.template).toContain("finalize_reliability_safety_test_content")
    expect(command.template).not.toContain("reliability-safety-test-content-batches")
  })

  test("registers the standalone margin test content command", () => {
    const command = createCommands()["matrix-margin-test-content"]
    expect(command.agent).toBe("filldata-enricher")
    expect(command.template).toContain("prepare_margin_test_content")
    expect(command.template).toContain("margin-test-content-modeler")
    expect(command.template).toContain("exactly once")
    expect(command.template).toContain("finalize_margin_test_content")
    expect(command.template).not.toContain("margin-test-content-batches")
  })

  test("registers the standalone boundary test content command", () => {
    const command = createCommands()["matrix-boundary-test-content"]
    expect(command.agent).toBe("filldata-enricher")
    expect(command.template).toContain("prepare_boundary_test_content")
    expect(command.template).toContain("boundary-test-content-modeler")
    expect(command.template).toContain("exactly once")
    expect(command.template).toContain("finalize_boundary_test_content")
    expect(command.template).not.toContain("boundary-test-content-batches")
  })

  test("registers the standalone data processing test content command", () => {
    const command = createCommands()["matrix-data-processing-test-content"]
    expect(command.agent).toBe("filldata-enricher")
    expect(command.template).toContain("prepare_data_processing_test_content")
    expect(command.template).toContain("data-processing-test-content-modeler")
    expect(command.template).toContain("exactly once")
    expect(command.template).toContain("finalize_data_processing_test_content")
    expect(command.template).toContain("data-processing.raw.json")
    expect(command.template).not.toContain("data-processing-test-content-batches")
  })

  test("registers the hardware-interface-only command on a primary orchestrator", () => {
    const command = createCommands()["matrix-hardware-interface"]

    expect(command).toBeDefined()
    expect(command.agent).toBe("hardware-interface-orchestrator")
    expect(command.subtask).toBe(false)
    expect(command.template).toContain("prepare_document_artifacts")
    expect(command.template).toContain("discover_hardware_interface_candidates")
    expect(command.template).toContain("incremental_reuse=true")
    expect(command.template).toContain("prepare_hardware_interface_batches")
    expect(command.template).toContain("merge_hardware_interface_blocks")
    expect(command.template).toContain("finalize_hardware_interface")
    expect(command.template).toContain("hardware-interface-discoverer")
    expect(command.template).toContain("hardware-interface-modeler")
    expect(command.template).toContain("worker_waves")
    expect(command.template).toContain("at most five")
    expect(command.template).toContain("stop before later waves, merge, and finalize")
    expect(command.template).toContain("hardware_interface_block_raw_paths")
    expect(command.template).not.toContain('mode="discover_documents"')
    expect(command.template).toContain("Do not generate 4.x test chapters")
  })

  test("registers matrix-phase2 as a primary complete document workflow", () => {
    const command = createCommands()["matrix-phase2"]
    expect(command).toBeDefined()
    expect(command.agent).toBe("phase2-orchestrator")
    expect(command.subtask).toBe(false)
    expect(command.template).toContain("run Chapter 1 scope and Chapter 2 system overview as two independent parallel branches")
    expect(command.template).toContain("Call prepare_chapter1_scope and prepare_chapter2_system_overview concurrently")
    expect(command.template).toContain("Launch the returned chapter1/chapter2 workers concurrently when both raws are not reused")
    expect(command.template).toContain("launch only the missing worker when one raw is reused")
    expect(command.template).toContain("launch neither when both are reused")
    expect(command.template).toContain("Do not start 3.1 until both finalizes succeed")
    expect(command.template).toContain("Finalize each branch independently by passing only its mode")
    expect(command.template).toContain("Never pass fixed artifact path or directory arguments")
    expect(command.template).not.toContain("hardware_interface_serial_block_raw_paths")
    expect(command.template).toContain("stop before 3.1, all 4.x chapters, traceability, and the total document")
    expect(command.template).toContain("Preserve artifacts already completed by the other branch")
    expect(command.template).not.toContain("first generate Chapter 1, then Chapter 2")
    expect(command.template).toContain("finalize_hardware_interface")
    expect(command.template).toContain("five non-functional workers for 4.5 through 4.9")
    expect(command.template).toContain("wait for all to succeed before serial discovery")
    expect(command.template).toContain("keep dynamic serial workers sequential")
    expect(command.template).toContain("ordered groups of at most 5")
    expect(command.template).toContain("concurrent within each group and sequential between groups")
    expect(command.template).toContain("functional-other and interface-test")
    expect(command.template).toContain("After 4.4 succeeds, prepare 4.5-4.9 in order")
    expect(command.template).toContain("launch returned margin/boundary/data-processing/recovery/strength workers concurrently")
    expect(command.template).toContain("finalize in 4.5-4.9 order by passing only mode")
    expect(command.template).toContain("Any failure blocks all five finalizes, traceability, and the total document")
    expect(command.template).toContain("successful raw files remain reusable")
    expect(command.template).toContain("finalize_functional_test_content")
    expect(command.template).toContain("prepare_performance_test_content")
    expect(command.template).toContain("prepare_interface_test_content")
    expect(command.template).toContain("prepare_reliability_safety_test_content")
    expect(command.template).toContain("prepare_margin_test_content")
    expect(command.template).toContain("prepare_boundary_test_content")
    expect(command.template).toContain("prepare_data_processing_test_content")
    expect(command.template).toContain("prepare_recovery_test_content")
    expect(command.template).toContain("prepare_strength_test_content")
    expect(command.template).toContain('mode="finalize_phase2_document"')
    expect(command.template).toContain('mode="generate_functional_traceability"')
    expect(command.template).toContain("functional-test-traceability.docx")
    expect(command.template).toContain(".matrix/reports/phase2-test-requirements.docx")
  })

  test("registers the standalone recovery test content command", () => {
    const command = createCommands()["matrix-recovery-test-content"]
    expect(command.agent).toBe("filldata-enricher")
    expect(command.subtask).toBe(true)
    expect(command.template).toContain("prepare_recovery_test_content")
    expect(command.template).toContain("recovery-test-content-modeler")
    expect(command.template).toContain("exactly once")
    expect(command.template).toContain("finalize_recovery_test_content")
    expect(command.template).toContain("recovery.raw.json")
    expect(command.template).not.toContain("recovery-test-content-batches")
  })

  test("registers the standalone strength test content command", () => {
    const command = createCommands()["matrix-strength-test-content"]
    expect(command.agent).toBe("filldata-enricher")
    expect(command.subtask).toBe(true)
    expect(command.template).toContain("prepare_strength_test_content")
    expect(command.template).toContain("strength-test-content-modeler")
    expect(command.template).toContain("exactly once")
    expect(command.template).toContain("finalize_strength_test_content")
    expect(command.template).toContain("strength.raw.json")
    expect(command.template).not.toContain("strength-test-content-batches")
  })

  test("registers the matrix-contexts command as an independent utility entry", () => {
    const commands = createCommands()
    const template = commands["matrix-contexts"].template

    expect(commands["matrix-contexts"]).toBeDefined()
    expect(commands["matrix-contexts"].agent).toBe("context-packer")
    expect(commands["matrix-contexts"].subtask).toBe(false)
    expect(template).toContain("independent utility command")
    expect(template).toContain("Do NOT initialize, read, or modify .matrix/state/progress.json.")
    expect(template).toContain("Do NOT call task().")
    expect(template).toContain("Call code_slice_context_pack directly once.")
    expect(template).toContain("Default output_dir to .matrix/data/contexts.")
    expect(template).toContain("Default slicing_strategy to local_subgraph")
  })

  test("updates matrix-analyze to use staged software analysis artifacts before finalizing", () => {
    const commands = createCommands()
    const template = commands["matrix-analyze"].template

    expect(template).toContain('Target phases: ["1"]')
    expect(template).toContain("Do not run Phase 1b/code wiki")
    expect(template).not.toContain('Target phases: ["1b"]')
    expect(template).toContain("software-analysis-stage-01-project.json")
    expect(template).toContain("req_parser output_file/output_toc_file")
    expect(template).toContain("software-analysis-stage-02-requirements-tool.json")
    expect(template).toContain("traceability_builder output_file=.matrix/data/software-analysis-stage-05-traceability-tool.json")
    expect(template).toContain("software-analysis-stage-05-traceability/*.json")
    expect(template).toContain("software-analysis-stage-06-finalize.json")
    expect(template).toContain("software_analysis_artifacts mode=save_stage")
    expect(template).toContain("software_analysis_artifacts mode=finalize")
    expect(template).toContain("compdb_generator's returned compilation_env_path")
    expect(template).toContain("do not create compilation-env.json from scratch")
    expect(template).toContain("workspace-relative paths")
    expect(template).toContain("do NOT inspect spelling")
    expect(template).toContain("retry finalize once")
    expect(template).toContain("do not regenerate compilation-env.json")
  })

  test("updates matrix-wiki to finalize staged Phase 1 artifacts before wiki generation when needed", () => {
    const commands = createCommands()
    const template = commands["matrix-wiki"].template

    expect(template).toContain("If it does not exist, is schema-invalid, or is otherwise unusable but .matrix/data/software-analysis-stage-03-code.json exists with payload.function_index")
    expect(template).toContain("Finalize staged Phase 1 artifacts before the final inventory reconciliation step")
  })

  test("registers matrix-dynamic-design as the Step 1-5 design and publication workflow", () => {
    const commands = createCommands()
    const design = commands["matrix-dynamic-design"]

    expect(design.agent).toBe("conductor")
    expect(design.description).toContain("Step 1–5")
    expect(design.template).toContain("生成或修订 .matrix/data/confirmation-tests.json")
    expect(design.template).toContain("调度 reviewer 执行 Phase 6 质量门审查")
    expect(design.template).toContain("如果 reviewer 返回 REVISE")
    expect(design.template).toContain("只有 reviewer 返回 PASS 后，才允许发布正式产物")
    expect(design.template).toContain("phase6_publish_outputs")
    expect(design.template).toContain("phase6_publish_outputs 不生成 DTP 数据或 Robot")
    expect(design.template).toContain("不要调用 phase6_execution_loop")
    expect(design.template).not.toContain("Step 6：")
    expect(design.template).not.toContain("Step 7：")
    expect(design.template).toContain(".matrix/reports/test-cases.md")
    expect(design.template).toContain(".matrix/reports/confirmation-tests.docx")
    expect(design.template).toContain("旧的 Phase 6 正式文档都应视为过期")
    expect(commands).not.toHaveProperty("matrix-design")
  })

  test("registers matrix-dynamic-test as the complete Step 1-7 dynamic test workflow", () => {
    const dynamicTest = createCommands()["matrix-dynamic-test"]

    expect(dynamicTest.agent).toBe("conductor")
    expect(dynamicTest.subtask).toBe(false)
    expect(dynamicTest.description).toContain("Step 1–7")
    expect(dynamicTest.template).toContain("生成或修订 .matrix/data/confirmation-tests.json")
    expect(dynamicTest.template).toContain("Step 5：PASS 后调用一次 phase6_publish_outputs")
    expect(dynamicTest.template).toContain("Step 6：phase6_publish_outputs 完成后调用 phase6_execution_loop")
    expect(dynamicTest.template).toContain("Step 7：只有 confirmation-tests.json 已通过审查")
    expect(dynamicTest.template).toContain(".matrix/data/phase6-execution-loop.json")
    expect(dynamicTest.template).toContain("内置默认值，不读取 matrix.jsonc 中的 DTP 设置")
    expect(dynamicTest.template).toContain("不要将 matrix_config 作为服务器预检入口")
  })

  test("registers the functional title tree slash command", () => {
    const commands = createCommands()

    expect(commands["matrix-functional-title-tree"]).toBeDefined()
    expect(commands["matrix-functional-title-tree"].agent).toBe("filldata-enricher")
    expect(commands["matrix-functional-title-tree"].subtask).toBe(true)
    expect(commands["matrix-functional-title-tree"].template).toContain("prepare the functional title tree worker")
    expect(commands["matrix-functional-title-tree"].template).toContain("functional-title-tree-modeler")
    expect(commands["matrix-functional-title-tree"].template).toContain(".matrix/data/functional-test-title-tree.json")
    expect(commands["matrix-functional-title-tree"].template).toContain(".matrix/reports/functional-test-title-tree.md")
  })

  test("registers the functional init content slash command", () => {
    const commands = createCommands()

    expect(commands["matrix-functional-init-content"]).toBeDefined()
    expect(commands["matrix-functional-init-content"].agent).toBe("filldata-enricher")
    expect(commands["matrix-functional-init-content"].subtask).toBe(true)
    expect(commands["matrix-functional-init-content"].template).toContain("prepare_functional_init_content")
    expect(commands["matrix-functional-init-content"].template).toContain("incremental_reuse=true")
    expect(commands["matrix-functional-init-content"].template).toContain("functional-init-content-modeler")
    expect(commands["matrix-functional-init-content"].template).toContain(".matrix/data/functional-init-content.json")
    expect(commands["matrix-functional-init-content"].template).toContain(".matrix/reports/functional-init-content.docx")
  })

  test("registers the functional other content slash command", () => {
    const commands = createCommands()

    expect(commands["matrix-functional-other-content"]).toBeDefined()
    expect(commands["matrix-functional-other-content"].agent).toBe("filldata-enricher")
    expect(commands["matrix-functional-other-content"].subtask).toBe(true)
    expect(commands["matrix-functional-other-content"].template).toContain("prepare_functional_other_content")
    expect(commands["matrix-functional-other-content"].template).toContain("functional-other-content-modeler")
    expect(commands["matrix-functional-other-content"].template).toContain("get_functional_other_content_worker_batch")
    expect(commands["matrix-functional-other-content"].template).toContain("consecutive groups of at most 5")
    expect(commands["matrix-functional-other-content"].template).toContain("launch that group's functional-other-content-modeler workers concurrently")
    expect(commands["matrix-functional-other-content"].template).toContain("do not occupy group slots")
    expect(commands["matrix-functional-other-content"].template).toContain("do not start later groups or finalize")
    expect(commands["matrix-functional-other-content"].template).toContain(".matrix/data/functional-other-content.json")
    expect(commands["matrix-functional-other-content"].template).toContain(".matrix/reports/functional-other-content.docx")
    expect(commands["matrix-functional-other-content"].template).toContain(".matrix/reports/hardware-interface-model.docx")
    expect(commands["matrix-functional-other-content"].template).toContain("current project directory")
    expect(commands["matrix-functional-other-content"].template).toContain("third-chapter hardware interface reference")
    expect(commands["matrix-functional-other-content"].template).toContain("source DOCX extraction")
    expect(commands["matrix-functional-other-content"].template).toContain("do not use req-segments.json or req-document-structure.json")
    expect(commands["matrix-functional-other-content"].template).toContain("sort pending entries by batch_index")
    expect(commands["matrix-functional-other-content"].template).toContain("Existing valid leaf raw JSON files are reused")
    expect(commands["matrix-functional-other-content"].template).toContain("functional_other_content_raw_paths")
  })

  test("registers the complete functional test content slash command", () => {
    const commands = createCommands()

    expect(commands["matrix-functional-test-content"]).toBeDefined()
    expect(commands["matrix-functional-test-content"].agent).toBe("filldata-enricher")
    expect(commands["matrix-functional-test-content"].subtask).toBe(true)
    expect(commands["matrix-functional-test-content"].template).toContain("functional-test-title-tree.json")
    expect(commands["matrix-functional-test-content"].template).toContain("routing.has_initialization")
    expect(commands["matrix-functional-test-content"].template).toContain("incremental_reuse is not true")
    expect(commands["matrix-functional-test-content"].template).toContain("finalize_functional_test_content")
    expect(commands["matrix-functional-test-content"].template).toContain("get_functional_other_content_worker_batch")
    expect(commands["matrix-functional-test-content"].template).toContain("groups of at most 5")
    expect(commands["matrix-functional-test-content"].template).toContain("run the group's functional-other-content-modeler workers concurrently")
    expect(commands["matrix-functional-test-content"].template).toContain("wait for the whole group before starting the next")
    expect(commands["matrix-functional-test-content"].template).toContain(".matrix/data/functional-test-content.json")
    expect(commands["matrix-functional-test-content"].template).toContain(".matrix/reports/functional-test-content.docx")
  })

  test("registers the deterministic functional traceability command", () => {
    const command = createCommands()["matrix-functional-traceability"]
    expect(command).toBeDefined()
    expect(command.agent).toBe("filldata-enricher")
    expect(command.template).toContain("generate_functional_traceability")
    expect(command.template).toContain("source_ref")
    expect(command.template).toContain("never use the generated 4.1.x title_no")
    expect(command.template).toContain("do not delegate any subagent")
    expect(command.template).toContain("functional-test-traceability.docx")
  })

  test("registers the standalone interface test content slash command", () => {
    const command = createCommands()["matrix-interface-test-content"]
    expect(command).toBeDefined()
    expect(command.agent).toBe("filldata-enricher")
    expect(command.subtask).toBe(true)
    expect(command.template).toContain("prepare_interface_test_content")
    expect(command.template).toContain("interface-test-content-modeler")
    expect(command.template).toContain("interface-test-identifier-discoverer")
    expect(command.template).toContain("one content worker_batch per distinct interface identifier")
    expect(command.template).toContain("groups of at most 5")
    expect(command.template).toContain("12 interfaces become 1-5, 6-10, 11-12")
    expect(command.template).toContain("get_interface_test_worker_batch")
    expect(command.template).toContain("concurrently within each group")
    expect(command.template).toContain("reused batches occupy no slots")
    expect(command.template).toContain("stop before later groups and finalize")
    expect(command.template).toContain("worker_batches is empty, finalize directly")
    expect(command.template).toContain("finalize_interface_test_content")
    expect(command.template).toContain("source-artifacts.json")
    expect(command.template).toContain("hardware-interface-report-text.md")
    expect(command.template).toContain("do not merge total test-requirements.json")
  })
})


test("removes legacy requirement commands while preserving Phase 2 and test generation", () => {
  const commands = createCommands()
  for (const name of ["matrix-filldata", "matrix-parse-requirements", "matrix-export-third-party-req"]) expect(commands[name]).toBeUndefined()
  for (const name of ["matrix-phase2", "matrix-test", "matrix-dynamic-design", "matrix-dynamic-test"]) expect(commands[name]).toBeDefined()
})
