# Stage Selection

Use this file to decide which DTP stage tools must run.

## User Intent

Trigger this pipeline when the user intent is Robot script generation, even if the user does not explicitly name every stage.

Examples:

- `帮我生成 robot 脚本`
- `生成 DTP Robot`
- `用 confirmation-tests.json 继续生成脚本`
- `数据生成和脚本生成一起跑`

## Decision Tree

1. If `.matrix/data/dtp-generation/generated-test-data.json` passes the structural, freshness, and data-quality checks below, call only `dtp_robot_generate`.
2. If `generated-test-data.json` is missing, empty, or invalid, check `.matrix/data/confirmation-tests.json` and `.matrix/data/test-cases-todo.txt`.
3. If case inputs exist, call `dtp_test_data_generate`; it validates, migrates, caches, or builds canonical protocol definitions on demand.
4. Call `dtp_robot_generate`.

## Reusable Baseline Readiness

Pre-existing `.txt` data readiness does not block case-level generation. Canonical protocol readiness and required step files are handled by `dtp_test_data_generate`.

The following are optional reusable inputs, not blockers:

- `.matrix/data/dtp-generation/generated-data-files-index.json` exists and contains usable entries.
- `.matrix/data/DTPProject/V1/输入数据` exists and contains generated data files.

If both are missing, continue with `dtp_test_data_generate`; it builds protocol definitions and generates only files required by pending cases.

## Case-Level Data Readiness

Case-level data is ready when:

- `.matrix/data/dtp-generation/generated-test-data.json` exists
- it parses as JSON
- its root is an object, not an array
- it contains `schema_version` and `source_files`
- it contains `cases`
- at least one case has `generated_steps`
- no generated step has `data_quality.status: failed`
- it is not older than `confirmation-tests.json` or `test-cases-todo.txt`

The presence or timestamp of `.matrix/data/requirements-context.json` must not select or invalidate a pipeline stage.

If any condition fails, run `dtp_test_data_generate` when its inputs are available. Do not manually synthesize or patch the output JSON.

## Robot Readiness

Robot rendering can run when:

- `.matrix/data/dtp-generation/generated-test-data.json` is ready
- `.matrix/data/DTPProject` exists
- `.matrix/data/DTPProject/组合关键字` exists

The `.vte` file is not a hard blocker because `dtp_robot_generate` has fallback behavior and records warnings.
