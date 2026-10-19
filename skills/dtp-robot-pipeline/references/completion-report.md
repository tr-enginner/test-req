# Completion Report

After running the pipeline, summarize the result in a compact report.

Include:

- which tools were called
- which stages were skipped and why
- `.matrix/data/dtp-generation/generated-test-data.json` status
- `.matrix/data/dtp-generation/robot-generation-result.json` status
- generated `.robot` file paths
- warnings from data generation and robot generation
- skipped non-success case ids and removed stale Robot files

## Preferred Summary Shape

Use concise bullets:

- canonical protocol definitions: cache hit/rebuilt, validation status
- knowledge mode: requested/effective mode and whether source-document scanning occurred
- `dtp_test_data_generate`: called/skipped, reason
- `dtp_robot_generate`: called/skipped, reason
- `generated-test-data.json`: path
- `.robot` files: paths
- warnings: none or brief list

## Warning Handling

Warnings should be read from:

- `.matrix/data/dtp-generation/generated-test-data.json`
- `.matrix/data/dtp-generation/robot-generation-result.json`

Do not hide warnings.

Do not write warnings into `.robot` comments.

## Success Definition

Treat the pipeline as successful when:

- Robot generation finished
- at least one `.robot` file exists under `.matrix/data/DTPProject/V1/测试用例`
- any remaining warnings are reported

If no `.robot` file is generated, report the blocker and the latest available result JSON.
