# Pipeline

This skill is layer 2 of the DTP data-to-Robot pipeline.

The protocol preparation stage provides or ensures:

- `.matrix/data/dtp-generation/project-knowledge-index.json`
- `.matrix/data/dtp-generation/dtp-protocol-definitions.json` schema V4, including semantic identity, physical transport lengths, merged provenance, generic protocol relations, selector relations, and ordered protocol groups
- `.matrix/data/dtp-generation/document-reference-graph.json`
- `.matrix/data/dtp-generation/protocol-evidence-trace.json`
- `.matrix/data/dtp-generation/knowledge-package-manifest.json`

`.matrix/data/dtp-generation/generated-data-files-index.json` and project-wide reusable files are optional fallback inputs.

This skill then produces:

- compact Robot contract: `.matrix/data/dtp-generation/generated-test-data.json`
- diagnostics summary: `.matrix/data/dtp-generation/generated-test-data-diagnostics.json`
- atomic case checkpoints: `.matrix/data/dtp-generation/cases/{case_id}.json`
- full case diagnostics: `.matrix/data/dtp-generation/diagnostics/{case_id}.json`

Downstream Robot rendering consumes `generated-test-data.json` and is responsible for:

- `Resource` lines
- `.vte` lookup
- Robot path formatting
- `.robot` output files

## Case-Level Sequence

1. Read `test-cases-todo.txt`.
2. Iterate each case id line by line.
3. Load `confirmation-tests.json`.
4. Find the matching case node by `case_id` and keep it only when `translate_status` is exactly `success` and `test_environment` is not `硬平台测试环境`.
5. Iterate the case `test_step` list. Ignore requirement-link metadata because `case_id` is the only case correlation key needed by this stage.
6. For each step, use `key_name`, `step_desc`, and `parameter`; preserve `expected_result` for downstream output but exclude it from data-generation semantics.
7. Locate the paired keyword definition in `.matrix/data/DTPProject/组合关键字`.
8. Resolve `${time}` from upstream step data.
9. Validate/reuse the protocol cache or rebuild stale canonical definitions. In source mode, use per-document content-hash extraction caches, resolve exact internal references and one requirement-specification hop, expand a bounded same-document reference closure, classify referenced evidence roles, then select frame definitions under `数据及接口需求` first. In offline mode, trust readable imported knowledge, skip SHA-256 and source-freshness enforcement, normalize readable legacy protocol definitions in memory, and rebuild only missing or unusable protocol sections.
10. Extract explicit length semantics from `step_desc`. For a command/data protocol it constrains that message; for wording such as `15字节遥控指令应答` it constrains the command referenced by `responds_to`, never the response frame's physical wire length.
11. Derive the required flow from step semantics. Sending, injecting, or writing selects an input-flow protocol; a response or output protocol from the same chapter is not eligible.
12. Resolve the protocol by deterministic identity, interface scope, semantic relation, message-length meaning, flow, selector relation, and frame evidence. Canonicalize duplicate definitions before ranking. A generic name may select an ordered `protocol_group` only when the source section explicitly says the numbered packets are transmitted together; an explicitly numbered name selects only that child. Treat a model-provided `protocol_id` as advisory when it conflicts with those constraints.
13. If same-family protocols remain tied, parse an explicit selector value from `step_desc` and apply a source-backed `selector_relation`, for example `站地址01H -> 4帧遥测协议`. Selector tables may be linked across separate input/output flow models only inside the same document, interface scope, and protocol section. Conflicting mappings remain ambiguous.
14. Resolve all other arguments from keyword comments, the step description, relevant project-document evidence, and indexed data files.
15. Use other chapters only as field-value evidence. Fill unresolved W0-Wn values with `00` and preserve a warning.
16. Reconstruct the complete frame from the selected canonical protocol. Model `base_bytes` may provide planning evidence but must not replace a missing or incomplete canonical frame.
17. If deterministic planning is incomplete, classify the step by bus, interface level, protocol family, and flow, then select one invocation-scoped fallback Profile.
18. Build a bounded evidence package from canonical candidate protocols and directly related source tables, referenced appendices/tables, selector relations, command dictionary entries, and relevant project evidence. The model receives `step_desc`, not `test_purpose` or `expected_result`. Preserve complete frame/small tables; reduce large support tables to header plus matched rows in `table_html`.
19. Ask the model to select a candidate protocol and complete a structured plan. Do not let it compile a temporary protocol or write final bytes.
20. Apply explicit assignments, field faults, or frame-sequence variants deterministically. If an ordered-group fault names no child or frame, target the first applicable frame of the first child and preserve a warning.
21. Calculate the business checksum from canonical packet bytes, independently for every child packet in an ordered group.
22. If a secondary-CAN interface note explicitly defines a fixed prefix before every business frame, use the validated canonical `frame_envelope` to prepend its dynamically extracted bytes after business-field mutation and checksum calculation. Do not assume `0008H`; preserve document byte order and require any documented business/wire lengths to satisfy the length equation.
23. If the selected protocol is CAN with the `SJA1000` controller family in `PeliCAN` mode, derive Frame Information from each final frame's `FF`, `RTR`, and `DLC`, then prepend it to that frame. Do not confuse this controller byte with a fixed FPGA/interface envelope.
24. Generate each attempt below `.case-work/<case_id>/<step>` and publish only the final attempt into the formal case directory. Remove stale files for the same step before generation and after successful retry selection.
25. Reuse matching semantic plans across steps, but keep a separately named file for every step.
26. Name the file `S{step}-{protocol}-{variant}.txt` and place it in the case-specific input/output flow directory. When canonical protocols share a base name, include the payload length in `{protocol}`.
27. If no complete canonical base can be resolved, or a semantic fault is not represented by an actual mutation, write only an isolated `S{step}-{protocol}-{variant}-待确认.txt` below `用例生成/<case_id>` and mark `data_quality` as failed; never publish it as a normal variant or fall back to a flat flow-root file.
28. Atomically publish the compact and diagnostic case artifacts after each case completes.
29. Merge the compact case checkpoints into `generated-test-data.json` once after the requested run completes.
30. Return only bounded summary metadata to OpenCode; keep full plans and quality evidence out of the conversation context.

The selected case-step plan keeps `protocol_id` and `payload_length_bytes`. Downstream generation and quality retries must resolve by `protocol_id` before using a display name, so a `15字节遥控指令` cannot fall back to the same-name 10-byte protocol.

Protocol selection uses local evidence before chapter-wide context: `base_file_name`, an explicit `LENGTH`/`L` field, and the available `Wn` range are intrinsic; a length found only in `source_section` is contextual. Contextual chapter length must not override protocol identity or flow, especially when an input command and output response share one chapter.

Source flow names and table captions are canonical protocol names. Opaque model identifiers remain aliases. For a documented SPI ADDRESS bit field, selector matching compares the station-address bits so command and response ADDRESS values for the same device can share one protocol identity while retaining different message-type bits.

The emitted case metadata contains only fields needed by case-data diagnostics and Robot rendering. Use `case_id` to correlate it with `confirmation-tests.json`.

## SJA1000 PeliCAN Case Encoding

- Use `FI = (FF << 7) | (RTR << 6) | (DLC & 0x0F)`.
- Resolve `FF`, `RTR`, and `DLC` from canonical `field_layout` and bus metadata.
- Treat `SJA1000T` as the `SJA1000` controller family.
- Encode every final frame independently, including repeated or reordered multi-frame output.
- Do not infer DLC from total line length when the protocol supplies a control-field DLC.
- Keep Frame Information outside canonical field offsets and business checksum ranges.
- Leave BasicCAN and non-CAN files unchanged.

## Boundary

This skill must not:

- pre-generate every possible project-level data file
- semantically choose a different keyword from the one supplied by A-side output
- render `.robot`
- write Robot `Resource` lines

This skill should:

- normalize case input fields
- resolve keyword arguments
- reuse project-level generated files when available without requiring them
- generate missing case-specific files only when required
- preserve traceability for inferred values
