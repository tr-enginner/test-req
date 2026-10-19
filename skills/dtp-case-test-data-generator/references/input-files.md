# Input Files

## `test-cases-todo.txt`

Treat this file as the execution list.

Rules:

- one case id per non-empty line
- trim whitespace
- ignore blank lines
- preserve original case order
- warn when a case id is not found in `confirmation-tests.json`

## `confirmation-tests.json`

Treat this file as the primary case-detail source.

Important fields:

- `test_cases[]`
- `translate_status`
- `case_id`
- `case_name`
- `test_purpose`
- `test_environment`
- `test_step`

Within each `test_step`, prefer these normalized keys:

- `key_name`
- `step_desc`
- `parameter`
- `expected_result`

Ignore requirement-link metadata in each case. Do not parse, copy, validate, warn about, or publish it; `case_id` is sufficient to correlate generated output with the source case.

Process only cases whose `translate_status` is exactly `success`. Skip missing, partial, failed, error, or any other status and record a warning.

Skip any case whose `test_environment` is `硬平台测试环境`. It is outside DTP case-data and Robot generation scope, regardless of `translate_status`.

Read and preserve `expected_result` for downstream Robot/assertion output, but exclude it from case data-file generation and keyword argument inference.

## Ignored Legacy Requirement Context

`.matrix/data/requirements-context.json` is not an input to this skill. If it exists because another feature produces it, leave the source file untouched and ignore it. Do not include its content in protocol selection, argument inference, model prompts, cache hashes, or freshness checks.

## Third-Party Test Requirement Documents

- parse only `.docx`
- scan only project documents whose filenames contain `第三方测试需求`
- use the chapter titled `数据及接口需求` and its descendants as the primary protocol-structure scope
- identify chapters by title semantics; chapter number 3 is supporting evidence, not a hard-coded requirement
- resolve exact internal table, section, and appendix references
- follow only explicit external references to `.docx` files whose names identify a requirement specification
- search the whole current project workspace, including `.matrix/reports`, but never ancestor or sibling workspaces
- do not follow references found inside the referenced requirement specification
- if the requirement specification cannot be found, resolve the same target in the primary document only when the target identifier matches exactly, and preserve a warning
- use other chapters only to resolve variable values such as W0-Wn, enums, or command codes
- do not let a requirement-summary table replace a frame-definition table

These source-document rules apply only to `knowledge_mode=source`. In trusted `offline` mode, do not scan these documents or validate their freshness. Require a readable `.matrix/data/dtp-generation/project-knowledge-index.json` with reusable parsed evidence, prefer an existing readable `dtp-protocol-definitions.json`, and treat manifest hashes and version metadata as non-blocking diagnostics.

## Alias And Encoding Handling

Input files may be encoded as:

- UTF-8
- UTF-8 BOM
- GBK / GB2312 compatible encodings

Field matching should allow aliases instead of relying on one exact display form.

Typical aliases:

- keyword name: `key_name`, `keyword_name`, `关键字名称`
- step description: `step_desc`, `step_description`, `步骤描述`
- expected result: `expected_result`, `预期结果`
- parameters: `parameter`, `parameters`, `参数`

## Upstream Parameter Trust Rule

Only `${time}` is trusted as a direct upstream parameter value.

All other upstream parameter values are hints at most. Resolve them from keyword argument comments, canonical protocol definitions, the optional generated-data-files index, `step_desc`, and relevant project-document evidence. Preserve `test_purpose` as case metadata only; do not use it as step intent.
