# Inputs

## Primary Structured Input

Read:

- `.matrix/data/dtp-generation/generated-test-data.json`

Treat this file as the only primary structured input for Robot rendering.

Prefer the compact `schema_version: 1.1.0` contract. Continue accepting legacy `1.0.0` files during migration.

Do not load `.matrix/data/dtp-generation/diagnostics/*.json` during normal Robot rendering. Those files contain protocol selection and quality evidence for troubleshooting only.

Only cases with `translate_status` exactly equal to `success` are renderable. Missing or non-success statuses must not produce Robot files.

Cases with `test_environment` equal to `硬平台测试环境` are not renderable and must not produce Robot files, even when `translate_status` is `success`.

Do not use `confirmation-tests.json` as a primary rendering source in this skill.

## Pipeline Layer

This skill is the render stage only.

- `dtp-case-test-data-generator` prepares canonical protocol knowledge, generates required case-specific data files, and writes `.matrix/data/dtp-generation/generated-test-data.json`.
- `dtp-robot-script-generator` consumes `.matrix/data/dtp-generation/generated-test-data.json` and writes `.robot`.

If `field_value_plan` appears in generated data-file metadata, treat it as upstream traceability only. Do not recalculate packet bytes from it during Robot rendering.

## Upstream Contract

Assume the upstream case data output conforms to:

- `skills/dtp-case-test-data-generator/references/output-schema.json`

Required fields for Robot rendering:

- case metadata
- `translate_status: success`
- `test_environment` when present
- `generated_steps`
- `keyword_name`
- `resolved_arguments`
- `generated_data_files`
- warnings

Legacy generated files may contain extra case metadata. Ignore unknown legacy fields; Robot rendering must use only the documented runtime contract and must not load or select requirement context.

## Runtime Root

Treat the runtime root as:

- `.matrix/data/DTPProject`

Treat the current runtime directory as:

- `V1`

Expected runtime layout:

```text
.matrix/data/DTPProject/
├── 组合关键字/
└── V1/
    ├── 输入数据/
    ├── 测试用例/
    └── *.vte
```

## Assumptions

- generated protocol or input-data files already exist under `.matrix/data/DTPProject/V1/输入数据/...`
- `keyword_name` has already been decided upstream
- argument values have already been resolved upstream
