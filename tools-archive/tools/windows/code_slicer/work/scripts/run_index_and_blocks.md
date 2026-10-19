# `run_index_and_blocks.py` Usage

`run_index_and_blocks.py` is a helper script for batch-testing the HTTP API.

It can call these endpoints in order:

1. `POST /index`
2. `POST /blocks/generate`
3. `GET /blocks`
4. `POST /contexts/generate`

By default, you only need to provide:

- `repo_path`
- `db_path`

## Prerequisite

Start the service first:

```powershell
python D:\work\code-slice\work\run_server.py
```

The default base URL is:

```text
http://127.0.0.1:8000
```

If your service is running on another address, pass `--base-url`.

## Single Project

Run one repository:

```powershell
python D:\work\code-slice\work\scripts\run_index_and_blocks.py `
  --repo-path "D:/tests/CNAS/2024" `
  --db-path "D:/tests/CNAS/2024/index.db"
```

What this does by default:

- rebuilds the SQLite index
- generates persisted Step 2 path blocks
- fetches the block list with `persisted_only=false`
- saves the full `/blocks` response as JSON
- generates Step 3 context files with `persisted_only=true`

## Batch Mode

You can run multiple repositories from one JSON file.

Example batch file:

```json
[
  {
    "repo_path": "D:/tests/CNAS/2024",
    "db_path": "D:/tests/CNAS/2024/index.db"
  },
  {
    "repo_path": "D:/work/code-slice/testcases/step1/A_supported",
    "db_path": "D:/work/code-slice/work/a_supported.db"
  }
]
```

Run it with:

```powershell
python D:\work\code-slice\work\scripts\run_index_and_blocks.py `
  --batch-file "D:\work\code-slice\work\scripts\batch_cases.example.json"
```

## Main Outputs

### Step 2 blocks JSON

By default, the script saves the full `GET /blocks` result.

Default location:

```text
<db_dir>/<db_stem>.blocks.json
```

Example:

```text
D:/tests/CNAS/2024/index.blocks.json
```

If `--blocks-output-dir` is set, the saved file becomes:

```text
<blocks_output_dir>/<repo_name>.<db_name>.blocks.json
```

### Step 3 contexts

By default, the script also calls `POST /contexts/generate`.

Default output directory:

```text
<db_dir>/<db_stem>.contexts/
```

This directory contains:

- `manifest.json`
- `contexts/ctx-0001.json`
- `contexts/ctx-0002.json`
- ...

If `--contexts-output-dir` is set, the generated directory becomes:

```text
<contexts_output_dir>/<repo_name>.<db_name>.contexts/
```

## Common Options

### API location

```powershell
--base-url "http://127.0.0.1:8000"
```

### Step 2 block generation limits

```powershell
--max-functions 8
--max-total-lines 2000
```

These values are passed to:

- `POST /blocks/generate`
- `GET /blocks` when needed
- `POST /contexts/generate` when needed

### Control how `/blocks` is fetched

Default:

```powershell
--no-persisted-only
```

Use persisted Step 2 blocks instead:

```powershell
--persisted-only
```

### Disable Step 3 generation

If you only want Step 1 and Step 2 results:

```powershell
--no-generate-contexts
```

### Control how Step 3 reads blocks

Default:

```powershell
--contexts-persisted-only
```

This means Step 3 reads the persisted Step 2 blocks produced by `/blocks/generate`.

If you want Step 3 to generate contexts from live blocks instead:

```powershell
--no-contexts-persisted-only
```

### Save outputs into custom directories

```powershell
python D:\work\code-slice\work\scripts\run_index_and_blocks.py `
  --repo-path "D:/tests/CNAS/2024" `
  --db-path "D:/tests/CNAS/2024/index.db" `
  --blocks-output-dir "D:/tests/CNAS/outputs/blocks" `
  --contexts-output-dir "D:/tests/CNAS/outputs/contexts"
```

### Stop on first batch failure

```powershell
--stop-on-error
```

### Increase timeout for large repositories

```powershell
--timeout 600
```

## Example Commands

Generate Step 2 and Step 3 outputs for one project:

```powershell
python D:\work\code-slice\work\scripts\run_index_and_blocks.py `
  --repo-path "D:/tests/CNAS/2024" `
  --db-path "D:/tests/CNAS/2024/index.db"
```

Generate only Step 2 blocks and skip Step 3:

```powershell
python D:\work\code-slice\work\scripts\run_index_and_blocks.py `
  --repo-path "D:/tests/CNAS/2024" `
  --db-path "D:/tests/CNAS/2024/index.db" `
  --no-generate-contexts
```

Run batch mode and stop on the first failed repository:

```powershell
python D:\work\code-slice\work\scripts\run_index_and_blocks.py `
  --batch-file "D:\work\code-slice\work\scripts\batch_cases.example.json" `
  --stop-on-error
```

## Console Output

For each case, the script prints:

- index statistics
- block generation summary
- block count summary
- saved Step 2 JSON path
- Step 3 context count
- Step 3 manifest path
- a short block preview

## Notes

- `repo_path` and `db_path` are required for each case.
- `--repo-path/--db-path` and `--batch-file` are mutually exclusive.
- The script overwrites the target `.blocks.json` file.
- `POST /contexts/generate` will overwrite the target context directory contents for `ctx-*.json` and `manifest.json`.
