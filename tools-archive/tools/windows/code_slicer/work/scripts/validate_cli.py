from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKDIR = ROOT / "work"
REPO_PATH = ROOT / "testcases" / "step1" / "A_supported"


def main() -> None:
    temp_root_path = WORKDIR / "validation_scratch" / "validate_cli"
    if temp_root_path.exists():
        shutil.rmtree(temp_root_path)
    temp_root_path.mkdir(parents=True, exist_ok=True)
    try:
        repo_copy = temp_root_path / "repo_copy"
        shutil.copytree(REPO_PATH, repo_copy)
        generated_copy_dir = repo_copy / ".matrix" / "preprocessed" / "src"
        shutil.copytree(repo_copy / "src", generated_copy_dir)
        out_dir = temp_root_path / "cli_contexts"
        result = subprocess.run(
            [
                sys.executable,
                str(WORKDIR / "run_cli.py"),
                "context-pack",
                "--repo",
                str(repo_copy),
                "--out",
                str(out_dir),
            ],
            cwd=str(WORKDIR),
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

        payload = json.loads(result.stdout)
        expected_db_path = (repo_copy / ".matrix" / "data" / "index.db").resolve()
        assert payload["repo_path"] == repo_copy.resolve().as_posix(), payload
        assert payload["db_path"] == expected_db_path.as_posix(), payload
        assert payload["context_count"] == 1, payload
        assert Path(payload["manifest_file"]).exists(), payload
        assert expected_db_path.exists(), expected_db_path
        assert payload["index"]["files_indexed"] == 4, payload
        assert payload["index"]["macro_definitions_indexed"] == 6, payload
        assert payload["blocks"]["max_functions"] is None, payload
        assert payload["blocks"]["max_total_lines"] == 3000, payload
        assert payload["blocks"]["slicing_strategy"] == "local_subgraph", payload
        assert payload["blocks"]["persisted"] is True, payload

        manifest = load_json(out_dir / "manifest.json")
        assert manifest["project_path"] == repo_copy.resolve().as_posix(), manifest
        assert manifest["context_count"] == 1, manifest
        assert "note" not in manifest, manifest

        first_context_path = out_dir / manifest["contexts"][0]["file"]
        context = load_json(first_context_path)
        assert set(context) == {"context_id", "block", "outline", "locations", "prompt_ready"}, context
        assert context["block"]["slicing_strategy"] == "local_subgraph", context
        assert "function_chain" not in context["outline"], context
        assert context["outline"]["function_region"] == [
            "boot",
            "compute_limit",
            "update_global_len",
            "dispatch_event",
            "mark_busy",
            "default_worker",
        ], context
        prompt_text = context["prompt_ready"]["text"]
        assert "STEP 3 context generation is not implemented yet" not in prompt_text, prompt_text
        assert "[Context]" in prompt_text, prompt_text
        assert "[Functions]" in prompt_text, prompt_text
        assert "[Globals]" in prompt_text, prompt_text
        assert "[Types]" in prompt_text, prompt_text
        assert "[Macros]" in prompt_text, prompt_text
        assert context["outline"]["macros"] == ["BOOT_INCREMENT", "RECORD_MACRO_STATE", "LIMIT_INCREMENT"], context
        assert "g_macro_state" in context["outline"]["globals"], context
        assert "kind=object" not in prompt_text, prompt_text
        assert "kind=function" not in prompt_text, prompt_text
        assert "MODEL_CONTEXT_MACROS_H" not in prompt_text, prompt_text

        path_out_dir = temp_root_path / "cli_contexts_path"
        path_result = subprocess.run(
            [
                sys.executable,
                str(WORKDIR / "run_cli.py"),
                "context-pack",
                "--repo",
                str(repo_copy),
                "--out",
                str(path_out_dir),
                "--slicing-strategy",
                "path",
            ],
            cwd=str(WORKDIR),
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        path_payload = json.loads(path_result.stdout)
        assert path_payload["context_count"] == 3, path_payload
        assert path_payload["blocks"]["slicing_strategy"] == "path", path_payload
        assert path_payload["blocks"]["blocks_generated"] == 3, path_payload
        assert path_payload["blocks"]["persisted"] is True, path_payload

        path_manifest = load_json(path_out_dir / "manifest.json")
        assert path_manifest["context_count"] == 3, path_manifest
        assert path_manifest["contexts"][0]["slicing_strategy"] == "path", path_manifest
        path_contexts = [load_json(path_out_dir / entry["file"]) for entry in path_manifest["contexts"]]
        path_context = next(item for item in path_contexts if item["outline"]["function_chain"] == ["boot", "compute_limit"])
        assert path_context["block"]["slicing_strategy"] == "path", path_context
        assert "function_chain" in path_context["outline"], path_context
        assert path_context["outline"]["macros"] == ["BOOT_INCREMENT", "RECORD_MACRO_STATE", "LIMIT_INCREMENT"], path_context

        line_limited_out_dir = temp_root_path / "cli_contexts_line_limited"
        line_limited_result = subprocess.run(
            [
                sys.executable,
                str(WORKDIR / "run_cli.py"),
                "context-pack",
                "--repo",
                str(repo_copy),
                "--out",
                str(line_limited_out_dir),
                "--slicing-strategy",
                "local_subgraph",
                "--max-total-lines",
                "1",
            ],
            cwd=str(WORKDIR),
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
        line_limited_payload = json.loads(line_limited_result.stdout)
        assert line_limited_payload["context_count"] == 6, line_limited_payload
        assert line_limited_payload["blocks"]["max_total_lines"] == 1, line_limited_payload
        assert line_limited_payload["blocks"]["slicing_strategy"] == "local_subgraph", line_limited_payload
    finally:
        shutil.rmtree(temp_root_path, ignore_errors=True)

    print("validation_ok")


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


if __name__ == "__main__":
    main()
