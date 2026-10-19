# Execution Flow

This skill calls stage tools. It does not implement stage logic itself.

## Full Pipeline

Run the default pipeline when no reliable `generated-test-data.json` exists:

1. `dtp_test_data_generate` (includes canonical protocol ensure/cache)
2. `dtp_robot_generate`

## Case-And-Robot Pipeline

Run this when `generated-test-data.json` is missing or invalid:

1. `dtp_test_data_generate`
2. `dtp_robot_generate`

## Robot-Only Pipeline

Run this when `generated-test-data.json` is already ready:

1. `dtp_robot_generate`

## Tool Arguments

Use project-relative defaults unless the user gives explicit paths.

For `dtp_robot_generate`, pass:

```text
dtp_root = .matrix/data/DTPProject
generated_test_data_file = .matrix/data/dtp-generation/generated-test-data.json
```

For `dtp_test_data_generate`, prefer default workspace-relative behavior unless the user provides explicit document paths.

Pass `knowledge_mode=offline` only when the user explicitly requests offline knowledge reuse. Otherwise omit it and allow the tools to default to `source`. The pipeline must pass the selected value unchanged and must not persist it for later calls.

## Stop Conditions

Stop and report missing inputs when:

- `.matrix/data/DTPProject` is missing
- `.matrix/data/DTPProject/组合关键字` is missing and Robot rendering is required
- both `generated-test-data.json` and A-side case inputs are missing
- `confirmation-tests.json` is missing and case data must be generated
- `test-cases-todo.txt` is missing and case data must be generated
- `knowledge_mode=offline` is requested but `.matrix/data/dtp-generation/project-knowledge-index.json` is missing or invalid

Do not continue by fabricating placeholder case data.

## Rerun Policy

When the user asks only to generate Robot scripts, avoid rerunning upstream stages if `generated-test-data.json` is already valid.

When the user asks for data generation and Robot generation together, run `dtp_test_data_generate` before `dtp_robot_generate`.
