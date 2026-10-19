# OpenCode schema file for `opencode-schema-mirror`

Place a pre-downloaded copy of the official schema JSON here as **`config.json`**.

Example (from repo root):

```bash
cp release/opencode-config/config.json scripts/server/opencode-config/config.json
```

Docker Compose mounts this file into `opencode-schema-mirror` as `/config.json`, served over **HTTPS** (`https://opencode.ai/config.json` inside the compose network) and **HTTP** (port 80) for `matrix-nginx` → `/matrix-opencode-schema/config.json`.

For **offline OpenCode Web in the browser**, set `MATRIX_PORTAL_PUBLIC_URL` in `.env` so `opencode.json` uses `http://<your-host>/matrix-opencode-schema/config.json` (see `.env.example`).
