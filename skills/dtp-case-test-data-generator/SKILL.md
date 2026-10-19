---
name: dtp-case-test-data-generator
description: Instantiate case-level DTP test data from test-cases-todo.txt and confirmation-tests.json using keyword definitions plus generated data-file indexes. Use when Codex needs layer 2 of the DTP pipeline: fill keyword arguments and write .matrix/data/dtp-generation/generated-test-data.json for Robot rendering.
---

# Overview

Generate structured case-level test data for downstream Robot rendering.

This skill owns case-level protocol preparation and data instantiation. It consumes the pending case list, the A-side confirmation test JSON, keyword definitions, and cached canonical protocol definitions when valid. It outputs resolved keyword calls in `.matrix/data/dtp-generation/generated-test-data.json`.

It does not pre-generate all project files, and it does not render `.robot`.

# Pipeline Boundary

Use this skill only for case-level data instantiation.

- Entry point: `dtp_test_data_generate`
- Code path: `runDtpCaseDataInstantiation`
- Required inputs: `.matrix/data/test-cases-todo.txt`, `.matrix/data/confirmation-tests.json`
- Reuse inputs: `.matrix/data/dtp-generation/dtp-protocol-definitions.json`, `.matrix/data/dtp-generation/generated-data-files-index.json`
- Reference graph: `.matrix/data/dtp-generation/document-reference-graph.json`
- Portable package manifest: `.matrix/data/dtp-generation/knowledge-package-manifest.json`
- Runtime output: `.matrix/data/dtp-generation/generated-test-data.json`
- Diagnostics index: `.matrix/data/dtp-generation/generated-test-data-diagnostics.json`
- Atomic case checkpoints: `.matrix/data/dtp-generation/cases/{case_id}.json`
- Full case diagnostics: `.matrix/data/dtp-generation/diagnostics/{case_id}.json`
- Downstream skill: `dtp-robot-script-generator`

If a required data file is absent from the generated-data-files index, this skill may generate a supplemental case-specific file and append it to the index.

# Workflow

Follow this sequence strictly:

1. Read `.matrix/data/test-cases-todo.txt`.
2. Treat each non-empty line as one pending `case_id`.
3. Read `.matrix/data/confirmation-tests.json`.
4. Find the matching case node by `case_id`; continue only when `translate_status` is exactly `success` and `test_environment` is not `硬平台测试环境`, otherwise skip it with a warning.
5. Read case metadata such as `case_name` and `test_purpose` when present.
6. Iterate each `test_step`.
7. Read normalized step keys:
   - `key_name`
   - `step_desc`
   - `parameter`
8. Preserve `expected_result` for downstream Robot/assertion output only; do not use it for evidence retrieval, protocol matching, data-file naming, mutation planning, or argument inference.
9. Trust only `${time}` from upstream parameters.
10. Locate the exact keyword definition under `.matrix/data/DTPProject/组合关键字`.
11. Read paired keyword `.txt` and `.json` files.
12. Use keyword argument comments to decide parameter semantics.
13. Treat the third-party test requirement chapter named `数据及接口需求` and its descendants as the primary protocol-structure scope. Resolve exact internal table/section/appendix references and one external hop to an explicitly referenced requirement-specification `.docx`; never recursively follow references inside that specification.
14. Validate and reuse schema V4 `dtp-protocol-definitions.json`. In source mode, reject and rebuild stale legacy protocol caches; in trusted offline mode, normalize readable legacy definitions in memory and rebuild only unusable definitions. Restore an unlabeled CAN byte after the control field as `FRAME_SEQUENCE` when all canonical frames prove a `00/01/...` sequence.
15. Resolve a canonical protocol definition before constructing a case-specific data file. Canonicalize structurally identical definitions across source documents, merge their provenance, and prefer the primary third-party test requirement as the executable baseline. Persist protocol families, variants, selector constraints, and semantic relations such as `responds_to`, `composed_of`, and `selected_by`; use the model only when deterministic identity, scope, relation, and selector evidence still tie.
16. Use `frames[].byte_layout` as the complete baseline and `frames[].field_layout` for deterministic field locations.
17. Resolve variable field values from explicit step assignments, linked support tables, and relevant project-document evidence. Use `00` with a warning when a variable value remains unresolved.
18. If deterministic planning still cannot uniquely select a protocol or resolve a required semantic value, load the invocation-scoped model fallback Profile, build bounded candidate/evidence input, and call the model once. Never send the complete knowledge index.
19. Apply field faults and multi-frame operations deterministically, then calculate SUM/CRC in code.
20. For CAN protocols using the `SJA1000` controller family in `PeliCAN` mode, derive and prepend a Frame Information byte to every final frame.
21. Reuse an identical semantic step plan without another model call, while still writing one file per step.
22. Write case-specific files as `S{step}-{protocol}-{command_code}-{command_name}-{variant}.txt` when a unique command-dictionary entry is resolved; otherwise use `S{step}-{protocol}-{variant}.txt`. Write under `输入流/用例生成/{case_id}` or `输出流/用例生成/{case_id}`.
23. Atomically write a compact case checkpoint and a full case diagnostic file after each case completes.
24. After all requested cases finish, publish `.matrix/data/dtp-generation/generated-test-data.json` once as the compact Robot runtime contract.
25. Return only output paths, counts, quality totals, and a bounded warning preview from the tool; never return the complete generated dataset to the OpenCode conversation.

# Mandatory Rules

- Treat the current OpenCode workspace as the only project root. Do not search ancestor, sibling, or unrelated directories when `.matrix` or an input file is missing; report the missing project-local path instead.
- In source mode, parse only `.docx`. Primary documents must contain `第三方测试需求` in the filename. External documents must contain `需求规格说明` or an accepted requirement-specification name variant and must be explicitly referenced by the primary document.
- Resolve complete table identifiers such as `表3.1.1.5-1` exactly. Never shorten a locator to `表3` or select the first fuzzy table match.
- If an explicitly referenced requirement specification is unavailable, use the same appendix/section/table from the primary third-party requirement only when it resolves exactly, and preserve a warning.
- When a flow has no local frame table but exactly references one, materialize a reference-backed protocol window. The referenced table supplies the physical byte layout only; protocol name, flow direction, bus/interface scope, and output ownership remain with the referring flow.
- Keep complete frame-format tables and small tables in model evidence. For a large support/dictionary table, send structure-preserving `table_html` containing the header, matched rows, and required merged-cell anchor rows instead of duplicating `table_html`, `rows`, and `cells`.
- Match cases by exact `case_id`.
- Generate case data only for cases whose `translate_status` is exactly `success`.
- Skip cases whose `test_environment` is `硬平台测试环境`, even when translation succeeded, and remove stale generated artifacts for them.
- Treat missing or non-success translation status as non-executable.
- Match keywords by exact keyword name.
- Do not perform fuzzy keyword selection; A-side output already provides `key_name`.
- Treat upstream non-time parameters as hints only.
- Ignore requirement-link metadata in `confirmation-tests.json`; case-level generation is keyed only by `case_id` and step content.
- Ignore `.matrix/data/requirements-context.json` when present. It is not an input, freshness dependency, cache identity component, or model-evidence source for this skill.
- Assume the only trusted upstream parameter is `${time}`.
- Never infer parameter meaning from `${para1}`, `${para2}`, `${para3}` alone.
- Always use keyword `.json` argument comments to resolve semantics.
- Reuse an exact, validated indexed baseline file when available, but never require or trigger project-wide `.txt` materialization.
- Use only `step_desc` as authoritative step intent text for data generation. Do not use `test_purpose` or `expected_result` for protocol selection, mutation planning, data-file naming, or parameter inference.
- Never treat an empty requested file-name hint as a data-file index match.
- When the step text explicitly contains an indexed protocol/data-file name, lock that canonical entry before accepting a model plan.
- Do not let a weakly related protocol definition replace an exact indexed protocol match.
- Keep arbitration/control bytes in the generated `.txt` when the canonical protocol defines a complete bus frame.
- For case-level `SJA1000`/`SJA1000T` PeliCAN CAN data, calculate Frame Information as `(FF << 7) | (RTR << 6) | (DLC & 0x0F)`; do not use the raw line byte count as DLC.
- Accept controller and mode inherited into the canonical protocol from a unique compatible document-level bus profile; do not independently guess those values during case generation.
- If canonical controller or mode remains unknown because document profiles are ambiguous, leave the frame unchanged and preserve the warning.
- Apply Frame Information per frame after mutations, checksum calculation, and sequence operations. Do not include it in business checksum calculation or canonical field offsets.
- Do not prepend Frame Information for BasicCAN or non-CAN protocols.
- Use the model to identify protocol intent and mutations, not to replace a canonical frame with a partial payload.
- Treat a length in `15字节遥控指令应答` as the related command length, not the physical response-frame length. Physical frame length comes only from `frames[].wire_length` and `byte_layout`.
- Ignore model `selected_block`/`artifact_scope` values when the selected canonical protocol has no `block_layout`.
- Resolve one code-owned BusAdapter per step and use its built-in model fallback policy. Do not read or create a project-level fallback Profile file.
- Use the CAN Adapter's `primary-can` or `secondary-can` policy, the SPI or SpaceWire Adapter policy, or the Generic Adapter policy based on bus type, interface level, protocol family, and flow direction.
- Supply bounded canonical protocol candidates and their source tables, selector relations, command dictionary entries, and directly relevant project evidence. Do not send all project tables or the complete project knowledge index.
- Prefer a supplied candidate `protocol_id`. This version must not ask the model to compile a new temporary protocol definition.
- Include Adapter policy and evidence hashes in the model cache identity so policy or evidence changes invalidate only affected model plans.
- Keep final byte serialization, checksum calculation, transport framing, file I/O, and quality validation in deterministic code.
- Keep each selected project-evidence section intact; avoid mixing unrelated protocol sections into one step plan.
- Prefer exact protocol names under `数据及接口需求`; requirement-summary tables are retrieval aids and must not become canonical frame definitions.
- Compile source-backed selector relationships such as `站地址 -> 遥测帧数 -> 协议` during protocol preparation. Prefer deterministic table extraction; allow the section-level model to add relationships stated only in prose.
- Allow a selector table and its target frame tables to live in separate flow models when they belong to the same source document, interface scope, and protocol section. Do not link unrelated chapters merely because their frame counts match.
- Persist selector-driven variants in `protocol_families`. Treat a selector result such as `站地址01H -> 4帧` as a hard family constraint: discard 3-frame candidates first, then use step semantics to choose among the remaining 4-frame variants.
- Merge selector relations that use semantic aliases such as `站地址`, `二级节点站地址`, and `终端地址`. Multiple mappings that agree on the same frame count are supporting evidence, not a conflict; mappings that disagree on frame count remain ambiguous.
- Keep protocol alternatives separate from protocol composition. Use `variants` for mutually exclusive layouts, `ordered_packets` for packets that must all be transmitted in order, and `ordered_blocks` for start/middle/check block sequences.
- Prefer the flow name or table caption as the canonical Chinese protocol name. Keep opaque model identifiers such as `can2-mechanism-control-response` as aliases rather than replacing the source name.
- For an explicitly documented SPI ADDRESS bit field, compare device identity using the station-address bits. A command ADDRESS such as `59H` may therefore select the response layout whose ADDRESS is `5BH` when only the low message-type bits differ.
- Apply selector relationships only after bus, interface level, flow, semantic role, and intrinsic length constraints. A selector may break a remaining same-family tie, but it must not revive an already rejected protocol.
- If a selector value maps to zero or multiple eligible protocols, keep the protocol unresolved or ambiguous and preserve diagnostics. Never select the first mapping by document order.
- Persist selector relationships in `.matrix/data/dtp-generation/dtp-protocol-definitions.json` so source and offline knowledge modes use the same runtime selection behavior.
- Persist source-backed ordered packet families in `protocol_groups`. Never group numbered alternatives without section evidence that they form one transmitted unit. For an unqualified group fault, mutate only the first applicable frame of the first child packet and record the default selection as a warning.
- Other document chapters may supply W0-Wn values, enum values, or command codes, but must not redefine the canonical frame layout.
- When a unique command dictionary entry is resolved, preserve its code, name, and source table in `data_generation_plan.command`; apply its field overrides deterministically and include the command identity in the case-step data-file name.
- Treat resolved command-dictionary bytes and fixed canonical protocol fields as the normal command baseline. A model may fill genuinely unresolved fields but must not overwrite resolved baseline fields; explicit step faults are applied afterward.
- Preserve explicit assignments from `step_desc`, including normal assignments and explicit erroneous checksum values.
- Fill only unresolved variable fields with `00`; record `fallback-zero` field plans and warnings, then calculate checksum from the final values.
- Keep one data file per step. Semantic plan reuse may skip duplicate model calls but must not merge step output paths.
- Do not manually create, patch, or repair `.matrix/data/dtp-generation/generated-test-data.json`; only the `dtp_test_data_generate` tool may publish it.
- Do not write model responses, local repair plans, or analysis JSON to the project root or `.matrix/data` root.
- Preserve warnings and trace notes for every unresolved or inferred value.
- Do not generate final `.robot` files.

# Inputs

Primary inputs:

- `.matrix/data/test-cases-todo.txt`
- `.matrix/data/confirmation-tests.json`

Supporting inputs:

- `.matrix/data/DTPProject/组合关键字/*.json`
- `.matrix/data/DTPProject/组合关键字/*.txt`
- `.matrix/data/dtp-generation/project-knowledge-index.json`
- `.matrix/data/dtp-generation/dtp-table-evidence-index.json`
- `.matrix/data/dtp-generation/document-reference-graph.json`
- `.matrix/data/dtp-generation/knowledge-package-manifest.json`
- `.matrix/data/dtp-generation/generated-data-files-index.json`
- `.matrix/data/dtp-generation/dtp-protocol-definitions.json`
- project `.docx` documents whose filenames contain `第三方测试需求`
- explicitly referenced requirement-specification `.docx` documents within the current workspace

Read [input-files.md](references/input-files.md) before parsing pending case data.

# Knowledge Modes

Pass `knowledge_mode` to `dtp_test_data_generate` only when the user explicitly selects a mode:

- `source` is the default. Discover and validate project `.docx` documents whose filenames contain `第三方测试需求`, then resolve the supported one-hop requirement-specification references.
- `offline` is trusted reuse mode. It requires a readable `.matrix/data/dtp-generation/project-knowledge-index.json` with reusable parsed evidence and must not scan or parse source documents.

In `offline` mode, do not enforce portable content hashes, manifest SHA-256 values, source-document freshness, extractor versions, protocol schema metadata, or compiler metadata. Report metadata differences as warnings, normalize readable legacy protocol definitions in memory, and continue. Stop only when the project knowledge index is missing, malformed, or contains no reusable snippets, tables, or section protocol models, or when protocol definitions cannot be loaded or reconstructed from that evidence. Do not silently fall back to `source`, replace the imported index with an empty index, or rewrite a successfully reused imported knowledge package. Document path arguments are ignored with a warning.

Before section-level model calls, route tables by primary-frame ownership, explicit references, interface scope, flow direction, and exact protocol or field terms. Make at most one relation-analysis call per section and at most two protocol-understanding windows per section, with no more than two primary tables per window. For large tables, send the header plus matched rows and structural anchor rows; when `table_html` is available, do not duplicate `rows` or `cells`. Keep the complete relation-analysis request within about 20000 tokens and the complete protocol-understanding request within about 30000 tokens, including fixed prompts and output schemas. A protocol model may request one supplemental evidence fetch using existing `table_id`, `row_keys`, and `fields`; it must never invent a table id or write final bytes.

After bus type, interface level, and flow direction hard constraints are applied, resolve documented selector relations such as station address or device code before protocol-name scoring. A unique protocol target is selected directly. When multiple mappings agree on a structural constraint such as `frame_count=4`, restrict scoring to those matching variants and never retain an upstream 3-frame plan. Preserve relation ids, selector value, and the resolved structural constraint in diagnostics. Use semantic ranking or model fallback only inside the constrained variant set, or when selector evidence is absent, unresolved, or genuinely conflicting.

# Parameter Resolution

Use this priority order:

1. `${time}` from the step node when present
2. time or sequence information from the step node
3. keyword `.json` argument comments
4. generated-data-files index
5. step description
6. relevant project-document evidence

Read [keyword-params.md](references/keyword-params.md) before filling arguments.

# Output Contract

Write:

- `.matrix/data/dtp-generation/generated-test-data.json`
- `.matrix/data/dtp-generation/generated-test-data-diagnostics.json`
- `.matrix/data/dtp-generation/cases/{case_id}.json`
- `.matrix/data/dtp-generation/diagnostics/{case_id}.json`

The output must conform to [output-schema.json](references/output-schema.json).

The compact runtime output contains only:

- case metadata
- generated steps
- exact `keyword_name`
- resolved arguments
- compact generated data-file references
- bounded warning summaries with links to case diagnostics

Full protocol plans, rejected candidates, quality issues, context usage, argument quality, and trace notes belong in the per-case diagnostic files. Robot rendering must not load those fields during the normal path.

# Quality Checks

Before finishing, verify:

- every todo `case_id` was resolved or explicitly warned
- every step has an exact keyword name or warning
- every required argument is resolved or marked incomplete
- every file-type argument points to an existing generated file or records why it could not
- every generated supplemental file records source evidence

# References

- Read [pipeline.md](references/pipeline.md) first.
- Read [input-files.md](references/input-files.md) before parsing case inputs.
- Read [keyword-params.md](references/keyword-params.md) before resolving arguments.
- Read [output-schema.json](references/output-schema.json) before emitting generated-test-data.
- Read [diagnostics-schema.json](references/diagnostics-schema.json) before emitting the diagnostics index.
- Read [output-example.json](references/output-example.json) for a concrete case output.
- Read [warnings-and-fallbacks.md](references/warnings-and-fallbacks.md) when data is incomplete.
- Read [bus-adapters.md](references/bus-adapters.md) before changing bus-specific compilation, fallback, transport, checksum, or validation behavior.
- Read [document-references-and-cache.md](references/document-references-and-cache.md) before changing document discovery, reference resolution, table evidence, or offline packaging.
