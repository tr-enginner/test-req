# Readiness Checks

Perform checks relative to the current project workspace. Do not hard-code absolute paths from a previous project.

## Workspace Root

Use the current OpenCode workspace root as the only project root. Do not search ancestor, sibling, or unrelated directories when required files are absent.

All paths below are project-relative:

- `.matrix/data`
- `.matrix/data/DTPProject`
- `.matrix/data/DTPProject/V1`

## Required Runtime Assets

Check:

- `.matrix/data/DTPProject`
- `.matrix/data/DTPProject/组合关键字`
- `.matrix/data/DTPProject/V1`

If `.matrix/data/DTPProject` is missing, stop and report it.

If `组合关键字` is missing, stop before Robot rendering because keyword validation cannot run.

If `V1` is missing, report it. Later workflows may support runtime selection, but current DTP workflow assumes `V1`.

## A-Side Case Inputs

For case-level data generation, require:

- `.matrix/data/confirmation-tests.json`
- `.matrix/data/test-cases-todo.txt`

If any is missing and `generated-test-data.json` is not already ready, stop and report the missing file.

At least one todo case must match a `confirmation-tests.json` case whose `translate_status` is exactly `success` and whose `test_environment` is not `硬平台测试环境`.

## Generated Data Inputs

Check:

- `.matrix/data/dtp-generation/generated-data-files-index.json`
- `.matrix/data/dtp-generation/project-knowledge-index.json`
- `.matrix/data/dtp-generation/generated-test-data.json`

`generated-data-files-index.json` is an optional case-level fallback and traceability index. Its absence does not block case-level generation.

`project-knowledge-index.json` and `dtp-protocol-definitions.json` are ensured by `dtp_test_data_generate` when case data must be generated.

When `knowledge_mode=offline`, `project-knowledge-index.json` is mandatory, must be readable, and must contain reusable snippets, tables, or section protocol models. Treat imported knowledge as trusted: do not enforce content hashes, manifest SHA-256 values, extractor versions, protocol schema metadata, compiler metadata, or source-document freshness. Normalize readable legacy protocol definitions in memory and rebuild only definitions that are missing or unusable. Source Word documents are not required and must not be scanned. When the mode is omitted or `source`, retain the existing source-document freshness checks.

When `.matrix/data/dtp-generation/knowledge-package-manifest.json` is present in offline mode, use it only as optional diagnostic metadata. Missing, malformed, stale, or mismatched manifest data must produce at most a warning and must not block trusted reuse. `document-reference-graph.json` is diagnostic traceability output; Robot rendering does not read it directly.

`generated-test-data.json` is mandatory for `dtp_robot_generate`.

Every renderable case in `generated-test-data.json` must carry `translate_status: success`.

No renderable case may carry `test_environment: 硬平台测试环境`.

Treat the file as ready only when it is a JSON object with `schema_version`, `source_files`, and a `cases` array; every case has `generated_steps`; and no step has `data_quality.status: failed`.

If either `confirmation-tests.json` or `test-cases-todo.txt` is newer than `generated-test-data.json`, treat the generated file as stale and rerun `dtp_test_data_generate`.

Ignore `.matrix/data/requirements-context.json` when present. It is not a readiness or freshness dependency for data generation or Robot rendering.

Never repair this contract by writing JSON manually. A failed or incomplete data-generation tool call must stop the pipeline before Robot rendering.

## Output Locations

Expected outputs:

- `.matrix/data/dtp-generation/generated-test-data.json`
- `.matrix/data/dtp-generation/robot-generation-result.json`
- `.matrix/data/DTPProject/V1/测试用例/*.robot`

If the final Robot output directory does not exist, allow `dtp_robot_generate` to create it.
