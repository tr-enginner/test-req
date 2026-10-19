# Tools Archive Download Checklist

Prepare the following directories on a networked build machine before running offline packaging.

If you want a helper to auto-fill missing Windows packaging assets from the local machine,
run:

```powershell
bun run prepare:offline-windows
```

It will try to:

- copy `bun.exe`, `node.exe`, `rg.exe`, and local `opencode` wrappers into `tools-archive/runtime/windows/`
- copy global `opencode-ai` npm package into `tools-archive/runtime/windows/node_modules/`
- create/update `tools-archive/python/windows/`
- install the shared Python packages from `tools-archive-requirements.txt`

## Required for Windows offline package

```text
tools-archive/
|- runtime/
|  `- windows/
`- python/
   `- windows/
```

### 1. `tools-archive/runtime/windows/`

Put these runtime binaries here:

- `bun.exe`
- `opencode.exe`
- `node.exe`
- `rg.exe`

`rg.exe` is mandatory. Without it, offline packages cannot reliably perform document discovery, `glob/grep`, or the PDF requirement parsing workflow. `opencode.exe` is also the expected Windows launcher because the installer desktop shortcut points to it.

### 2. `tools-archive/python/windows/`

Put a working Windows Python runtime here.

Recommended approach:

```powershell
py -3.12 -m venv tools-archive\python\windows
.\tools-archive\python\windows\Scripts\python.exe -m pip install --upgrade pip
.\tools-archive\python\windows\Scripts\python.exe -m pip install -r .\tools-archive-requirements.txt
```

## Optional tools

```text
tools-archive/
`- tools/
   `- windows/
      |- specchecker/
      |- aunit/
      |- code_slicer/
      |- joern-cli/
      `- z3/
```

Add only the tools you actually need:

- `specchecker/` for static analysis
- `aunit/` for unit testing
- `code_slicer/` for context packing via `run_cli.py context-pack`
- `joern-cli/` for CPG analysis
- `z3/` for SMT solving

## Packaging command

After all required assets are ready:

```powershell
bun run build
bun run pack:offline -- --platform windows --version 0.1.0
```
