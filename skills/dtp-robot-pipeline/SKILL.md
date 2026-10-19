---
name: dtp-robot-pipeline
description: Orchestrate the DTP Robot generation pipeline. Use when Codex is asked to generate Robot scripts and should ensure cached canonical protocol definitions, generate case-level test data when needed, and render Robot files.
---

# Overview

Generate DTP Robot scripts with a case-first pipeline. Canonical protocol preparation happens inside case-level generation; this pipeline never materializes project-wide protocol `.txt` files.

This skill is an orchestration skill. It does not generate protocol data, infer keyword arguments, or render `.robot` files by itself. It decides which stage tools to call, in what order, based on the files already present in the current project.

Use this skill when the user says things like:

- `帮我生成 robot 脚本`
- `从 confirmation-tests.json 生成 Robot`
- `数据生成和 Robot 脚本生成一起跑`
- `用例模板已经生成好了，继续生成脚本`

# Stage Tools

This skill may call these tools:

1. `dtp_test_data_generate`
   - Skill: `dtp-case-test-data-generator`
   - Inputs: `.matrix/data/test-cases-todo.txt`, `.matrix/data/confirmation-tests.json`
   - Output: `.matrix/data/dtp-generation/generated-test-data.json`
2. `dtp_robot_generate`
   - Skill: `dtp-robot-script-generator`
   - Input: `.matrix/data/dtp-generation/generated-test-data.json`
   - Output: `.matrix/data/DTPProject/V1/测试用例/*.robot`

# Core Decision Rule

When the user asks to generate Robot scripts, inspect the current project state and run only the missing required stages.

Preferred behavior:

1. If `.matrix/data/dtp-generation/generated-test-data.json` exists, passes the full structural/freshness checks, and contains no failed step data-quality result, call `dtp_robot_generate`.
2. If `generated-test-data.json` is missing or unusable, but `.matrix/data/confirmation-tests.json` and `.matrix/data/test-cases-todo.txt` exist, call `dtp_test_data_generate`, then call `dtp_robot_generate`.
3. `dtp_test_data_generate` ensures or reuses `.matrix/data/dtp-generation/project-knowledge-index.json` and `.matrix/data/dtp-generation/dtp-protocol-definitions.json`; project-wide `.txt` materialization is not a pipeline stage.
4. If required upstream inputs are missing, stop and report the missing files.

Do not blindly run all stages when a later-stage input is already valid.

# Knowledge Mode

When data generation is required, pass the user-selected `knowledge_mode` unchanged to `dtp_test_data_generate`:

- Omitted means `source`.
- `offline` must be explicitly requested and requires `.matrix/data/dtp-generation/project-knowledge-index.json`.

Do not persist the mode between calls, infer `offline` from a missing Word document, or silently switch modes. Robot-only rendering does not need `knowledge_mode`.

# Mandatory Rules

- Do not perform semantic keyword matching in this skill.
- Do not infer business parameter values in this skill.
- Do not generate protocol/input data files in this skill.
- Do not render `.robot` content in this skill.
- Do not manually create, patch, or repair `.matrix/data/dtp-generation/generated-test-data.json`; rerun `dtp_test_data_generate` when it is missing, stale, malformed, or contains failed data-quality results.
- Do not write DTP analysis fragments or model responses to the project root or `.matrix/data` root.
- Use this skill only to inspect readiness, call the correct tools, and summarize results.
- Keep warnings in each tool's result JSON; summarize warnings to the user after execution.
- Treat `.matrix/data/DTPProject` as the DTP runtime root.
- Treat `V1` as the current runtime directory unless a later workflow explicitly defines runtime selection.

# Required Checks

Before selecting stages, check for:

- `.matrix/data/DTPProject`
- `.matrix/data/DTPProject/组合关键字`
- `.matrix/data/DTPProject/V1`
- `.matrix/data/dtp-generation/dtp-protocol-definitions.json` (reused when valid, built on demand otherwise)
- `.matrix/data/dtp-generation/generated-data-files-index.json` (optional case-level traceability and baseline index)
- `.matrix/data/confirmation-tests.json`
- `.matrix/data/test-cases-todo.txt`
- `.matrix/data/dtp-generation/generated-test-data.json`

Read [readiness-checks.md](references/readiness-checks.md) for exact stage-readiness rules.

# Execution

Use [stage-selection.md](references/stage-selection.md) to decide which tools to call.

Use [execution-flow.md](references/execution-flow.md) for the ordered pipeline.

After execution, use [completion-report.md](references/completion-report.md) to summarize outputs.

# Completion Criteria

The pipeline is complete when:

- `.matrix/data/dtp-generation/generated-test-data.json` exists
- every rendered case has `translate_status: success`
- `.matrix/data/DTPProject/V1/测试用例` exists
- at least one `.robot` file was generated or an explicit warning explains why none was generated
- `.matrix/data/dtp-generation/robot-generation-result.json` exists
- warnings have been summarized to the user

# References

- [stage-selection.md](references/stage-selection.md)
- [readiness-checks.md](references/readiness-checks.md)
- [execution-flow.md](references/execution-flow.md)
- [completion-report.md](references/completion-report.md)
