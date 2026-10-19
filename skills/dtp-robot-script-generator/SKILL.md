---
name: dtp-robot-script-generator
description: Render DTP Robot Framework scripts from .matrix/data/dtp-generation/generated-test-data.json using DTP runtime assets under .matrix/data/DTPProject. Use after case-level data generation to validate resolved keyword names, derive Resource files from 组合关键字, locate .vte, and write .robot files into .matrix/data/DTPProject/V1/测试用例.
---

# Overview

Generate final `.robot` files from already-resolved DTP test data.

This skill is the downstream render-and-validate stage. It assumes:

- keyword selection has already been completed upstream
- business parameters have already been resolved upstream
- protocol or input-data files have already been generated upstream

This skill does not infer new keyword names or new business parameter values.

# Stage Boundary

The upstream case-data stage owns protocol preparation and data-file generation:

1. `dtp-case-test-data-generator` writes `.matrix/data/dtp-generation/generated-test-data.json` and required case-specific data files.
2. This skill reads only `.matrix/data/dtp-generation/generated-test-data.json` as the primary structured input and renders `.robot`.

Do not move protocol understanding, field-value planning, checksum calculation, keyword matching, or parameter inference into this skill.

# Workflow

Follow this sequence strictly:

1. Read `.matrix/data/dtp-generation/generated-test-data.json`.
2. Validate that the input matches the upstream case data output contract.
3. Keep only cases whose `translate_status` is exactly `success` and whose `test_environment` is not `硬平台测试环境`; remove previously generated Robot files outside this renderable set.
4. Resolve the DTP runtime root under `.matrix/data/DTPProject`.
5. Resolve the runtime directory, currently assumed to be `V1`.
6. Use the runtime root and runtime directory to locate:
   - `组合关键字`
   - `.vte`
   - `输入数据`
   - `测试用例`
7. For each case in the structured input:
   - iterate `generated_steps`
   - use upstream `keyword_name` and resolved arguments directly
   - validate `keyword_name` against `组合关键字`
   - derive `Resource` lines from the keyword `.txt` files
   - render Robot step lines
8. If a keyword cannot be validated:
   - downgrade the step to a description-style step
   - continue rendering the case
   - record a warning in the result JSON
9. Render `*** Settings ***`, `Resource`, setup, teardown, and test-case bodies.
10. Write one `.robot` file per case into `.matrix/data/DTPProject/V1/测试用例`.
11. Emit a robot-generation result JSON containing generated files and warnings.

# Mandatory Rules

- Treat the current OpenCode workspace as the only project root. Reject DTP roots and generated-data paths outside it instead of searching another project.
- Use `.matrix/data/dtp-generation/generated-test-data.json` as the primary structured input.
- Accept compact schema `1.1.0` and legacy schema `1.0.0`; do not load per-case diagnostics during normal rendering.
- Write robot-generation metadata only under `.matrix/data/dtp-generation`; never write temporary model or repair JSON to the project root.
- Render only cases whose `translate_status` is exactly `success`.
- Never render a case whose `test_environment` is `硬平台测试环境`.
- Never leave a previously generated Robot file executable after its case becomes non-success.
- Do not read `confirmation-tests.json` for keyword decisions or parameter inference.
- Do not perform semantic keyword matching in this skill.
- Do not consume `field_value_plan` except as optional trace metadata; render only resolved arguments and final file paths.
- Use `组合关键字` only for keyword existence validation and locating `.txt` resource files for `Resource`.
- Use upstream resolved arguments as-is unless a path needs Robot-format normalization.
- Robot-facing paths must use double backslashes.
- Warnings must be written to the result JSON, not to `.robot` comments.
- Missing keywords are non-blocking and must downgrade to description-style steps.

# Inputs

Primary structured input:

- `.matrix/data/dtp-generation/generated-test-data.json`

Runtime project inputs:

- `.matrix/data/DTPProject/组合关键字`
- `.matrix/data/DTPProject/V1/*.vte`
- `.matrix/data/DTPProject/V1/输入数据/...`

Read [inputs.md](references/inputs.md) before consuming the upstream JSON or runtime directories.

# Validation And Resources

For each rendered step:

- validate that `keyword_name` exists in `组合关键字`
- if it exists, locate the keyword `.txt` and include it in `Resource`
- if it does not exist, downgrade the step and emit a warning

Do not try to replace the missing keyword with another candidate.

Read [resource-and-validation.md](references/resource-and-validation.md) before implementing validation or `Resource` collection.

# Rendering Rules

This skill is responsible for:

- Robot settings section
- `Resource` lines
- setup and teardown lines
- Robot step rendering
- `.vte` lookup and fallback handling
- output file naming and output directory selection

This skill is not responsible for:

- protocol/data file generation
- checksum calculation
- parameter inference
- keyword matching

Read [robot-rendering.md](references/robot-rendering.md) before generating `.robot` output.

# Output Contract

Write `.robot` files into:

- `.matrix/data/DTPProject/V1/测试用例`

Also emit a robot-generation result JSON conforming to:

- [output-schema.json](references/output-schema.json)

Use [output-example.json](references/output-example.json) as the concrete example shape.

# References

- Read [inputs.md](references/inputs.md) first.
- Read [resource-and-validation.md](references/resource-and-validation.md) before validating keywords or collecting `Resource` files.
- Read [robot-rendering.md](references/robot-rendering.md) before rendering final `.robot` files.
- Read [output-schema.json](references/output-schema.json) before emitting the result JSON.
- Read [output-example.json](references/output-example.json) for a complete example.
