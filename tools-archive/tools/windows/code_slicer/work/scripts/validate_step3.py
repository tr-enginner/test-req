from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKDIR = ROOT / "work"
if str(WORKDIR) not in sys.path:
    sys.path.insert(0, str(WORKDIR))

from fastapi import HTTPException

from app.context_export import export_contexts
from app.indexer import build_index
from app.main import generate_context_files
from app.path_blocks import generate_path_blocks, persist_blocks, persist_path_blocks
from app.schemas import ContextsGenerateRequest


REPO_PATH = ROOT / "testcases" / "step1" / "A_supported"


def main() -> None:
    temp_root_path = WORKDIR / "validation_scratch" / "validate_step3"
    if temp_root_path.exists():
        shutil.rmtree(temp_root_path)
    temp_root_path.mkdir(parents=True, exist_ok=True)
    try:
        validate_persisted_export(temp_root_path)
        validate_local_subgraph_persisted_export(temp_root_path)
        validate_live_export_without_persisted_blocks(temp_root_path)
        validate_persisted_only_requires_blocks(temp_root_path)
        validate_none_sections(temp_root_path)
        validate_non_function_attached_comments_are_omitted(temp_root_path)
    finally:
        shutil.rmtree(temp_root_path, ignore_errors=True)
    print("validation_ok")


def validate_persisted_export(temp_root: Path) -> None:
    db_path = temp_root / f"persisted_{uuid.uuid4().hex}.db"
    output_dir = temp_root / "persisted_out"
    build_index(str(REPO_PATH), str(db_path))

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        persisted_blocks = [block for block in persist_path_blocks(conn) if block.block_kind == "path"]
        result = export_contexts(
            conn,
            repo_path=str(REPO_PATH),
            out_dir=str(output_dir),
            persisted_only=True,
        )
        assert result.context_count == len(persisted_blocks), result

        stale_path = output_dir / "contexts" / "ctx-9999.json"
        stale_path.write_text('{"stale": true}\n', encoding="utf-8")
        second_result = export_contexts(
            conn,
            repo_path=str(REPO_PATH),
            out_dir=str(output_dir),
            persisted_only=True,
        )
        assert second_result.context_count == len(persisted_blocks), second_result
        assert not stale_path.exists(), stale_path
    finally:
        conn.close()

    manifest = load_json(output_dir / "manifest.json")
    assert manifest["project_path"] == REPO_PATH.resolve().as_posix(), manifest
    assert manifest["context_count"] == 3, manifest
    assert len(manifest["contexts"]) == 3, manifest
    context_files = [output_dir / entry["file"] for entry in manifest["contexts"]]
    assert all(path.exists() for path in context_files), context_files

    contexts = [load_json(path) for path in context_files]
    target = next(context for context in contexts if context["outline"]["function_chain"] == ["boot", "update_global_len", "mark_busy"])
    assert set(target) == {"context_id", "block", "outline", "locations", "prompt_ready"}, target
    assert target["block"]["slicing_strategy"] == "path", target["block"]
    assert target["block"]["block_kind"] == "path", target["block"]
    assert target["locations"]["functions"] == [
        {"name": "boot", "path": "src/entry.c", "start_line": 19, "end_line": 38},
        {"name": "update_global_len", "path": "src/state.c", "start_line": 19, "end_line": 30},
        {"name": "mark_busy", "path": "src/state.c", "start_line": 12, "end_line": 16},
    ], target["locations"]["functions"]
    assert target["locations"]["attached_comments"] == [
        {"func_name": "boot", "path": "src/entry.c", "start_line": 18, "end_line": 18},
        {"func_name": "update_global_len", "path": "src/state.c", "start_line": 18, "end_line": 18},
    ], target["locations"]["attached_comments"]
    assert target["outline"]["globals"] == ["g_ctx", "g_counter"], target["outline"]
    assert target["outline"]["macros"] == [], target["outline"]
    assert target["outline"]["types"] == [
        "device_ctx_t",
        "struct device_ctx",
        "device_state_t",
        "worker_fn_t",
        "enum device_state",
    ], target["outline"]

    prompt_text = target["prompt_ready"]["text"]
    assert "[Context]" in prompt_text, prompt_text
    assert "[Functions]" in prompt_text, prompt_text
    assert "[Globals]" in prompt_text, prompt_text
    assert "[Types]" in prompt_text, prompt_text
    assert "function_chain: boot -> update_global_len -> mark_busy" in prompt_text, prompt_text
    assert "slicing_strategy: path" in prompt_text, prompt_text
    assert "includes_globals: g_ctx, g_counter" in prompt_text, prompt_text
    assert "includes_types: device_ctx_t, struct device_ctx, device_state_t, worker_fn_t, enum device_state" in prompt_text, prompt_text
    assert "//// file: src/entry.c" in prompt_text, prompt_text
    assert "/* Boot sequence entry point. */" in prompt_text, prompt_text
    assert (
        "//// attached_comment: function boot [18,18]\n"
        "/* Boot sequence entry point. */\n"
        "//// function: boot [19-38]\n"
        "void boot(void) {"
    ) in prompt_text, prompt_text
    assert (
        "//// global: g_ctx [line 6]\n"
        "device_ctx_t *g_ctx = &default_ctx;"
    ) in prompt_text, prompt_text
    assert (
        "//// type: device_ctx_t [31-36]\n"
        "typedef struct device_ctx {"
    ) in prompt_text, prompt_text
    assert "//// attached_comment: global" not in prompt_text, prompt_text
    assert "//// attached_comment: type" not in prompt_text, prompt_text
    assert "//// attached_comment: macro" not in prompt_text, prompt_text
    assert REPO_PATH.resolve().as_posix() not in prompt_text, prompt_text

    macro_target = next(context for context in contexts if context["outline"]["function_chain"] == ["boot", "compute_limit"])
    assert macro_target["outline"]["macros"] == [
        "BOOT_INCREMENT",
        "RECORD_MACRO_STATE",
        "LIMIT_INCREMENT",
    ], macro_target["outline"]
    assert macro_target["outline"]["globals"] == ["g_ctx", "g_macro_state"], macro_target["outline"]
    assert "macro_state_t" in macro_target["outline"]["types"], macro_target["outline"]
    assert len([item for item in macro_target["locations"]["macros"] if item["name"] == "LIMIT_INCREMENT"]) == 2, macro_target
    assert macro_target["locations"]["attached_comments"] == [
        {"func_name": "boot", "path": "src/entry.c", "start_line": 18, "end_line": 18},
    ], macro_target["locations"]["attached_comments"]
    macro_prompt = macro_target["prompt_ready"]["text"]
    assert "includes_macros: BOOT_INCREMENT, RECORD_MACRO_STATE, LIMIT_INCREMENT" in macro_prompt, macro_prompt
    assert "[Macros]" in macro_prompt, macro_prompt
    assert "#define RECORD_MACRO_STATE(value) \\" in macro_prompt, macro_prompt
    assert "kind=object" not in macro_prompt, macro_prompt
    assert "kind=function" not in macro_prompt, macro_prompt
    assert "MODEL_CONTEXT_MACROS_H" not in macro_prompt, macro_prompt
    assert "UNUSED_CONTEXT_MACRO" not in macro_prompt, macro_prompt

    response = generate_context_files(
        ContextsGenerateRequest(
            repo_path=str(REPO_PATH),
            out_dir=str(output_dir),
            db_path=str(db_path),
            persisted_only=True,
        )
    )
    assert response.context_count == len(persisted_blocks), response
    assert Path(response.manifest_file).exists(), response


def validate_live_export_without_persisted_blocks(temp_root: Path) -> None:
    db_path = temp_root / f"live_{uuid.uuid4().hex}.db"
    output_dir = temp_root / "live_out"
    build_index(str(REPO_PATH), str(db_path))

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        live_blocks = [block for block in generate_path_blocks(conn) if block.block_kind == "path"]
        result = export_contexts(
            conn,
            repo_path=str(REPO_PATH),
            out_dir=str(output_dir),
            persisted_only=False,
        )
        assert result.context_count == len(live_blocks), result
    finally:
        conn.close()


def validate_local_subgraph_persisted_export(temp_root: Path) -> None:
    db_path = temp_root / f"local_persisted_{uuid.uuid4().hex}.db"
    output_dir = temp_root / "local_persisted_out"
    build_index(str(REPO_PATH), str(db_path))

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        persisted_blocks = persist_blocks(conn, strategy="local_subgraph")
        assert len(persisted_blocks) == 1, persisted_blocks
        result = export_contexts(
            conn,
            repo_path=str(REPO_PATH),
            out_dir=str(output_dir),
            persisted_only=True,
            slicing_strategy="local_subgraph",
        )
        assert result.context_count == 1, result
    finally:
        conn.close()

    manifest = load_json(output_dir / "manifest.json")
    assert manifest["context_count"] == 1, manifest
    context_path = output_dir / manifest["contexts"][0]["file"]
    context = load_json(context_path)
    assert context["block"]["slicing_strategy"] == "local_subgraph", context["block"]
    assert context["block"]["block_kind"] == "local_subgraph", context["block"]
    assert "function_chain" not in context["outline"], context["outline"]
    assert context["outline"]["function_region"] == [
        "boot",
        "compute_limit",
        "update_global_len",
        "dispatch_event",
        "mark_busy",
        "default_worker",
    ], context
    assert context["outline"]["globals"] == ["g_ctx", "g_counter", "g_macro_state"], context["outline"]
    assert context["outline"]["macros"] == ["BOOT_INCREMENT", "RECORD_MACRO_STATE", "LIMIT_INCREMENT"], context["outline"]
    assert "macro_state_t" in context["outline"]["types"], context["outline"]
    assert len([item for item in context["locations"]["macros"] if item["name"] == "LIMIT_INCREMENT"]) == 2, context
    assert context["locations"]["attached_comments"] == [
        {"func_name": "boot", "path": "src/entry.c", "start_line": 18, "end_line": 18},
        {"func_name": "update_global_len", "path": "src/state.c", "start_line": 18, "end_line": 18},
    ], context["locations"]["attached_comments"]
    prompt_text = context["prompt_ready"]["text"]
    assert "slicing_strategy: local_subgraph" in prompt_text, prompt_text
    assert "function_region: boot, compute_limit, update_global_len, dispatch_event, mark_busy, default_worker" in prompt_text, prompt_text
    assert "function_chain: boot -> compute_limit" not in prompt_text, prompt_text
    assert "[Macros]" in prompt_text, prompt_text
    assert "g_macro_state = MACRO_BUSY" in prompt_text, prompt_text
    assert "kind=object" not in prompt_text, prompt_text
    assert "kind=function" not in prompt_text, prompt_text
    assert "UNUSED_CONTEXT_MACRO" not in prompt_text, prompt_text


def validate_persisted_only_requires_blocks(temp_root: Path) -> None:
    db_path = temp_root / f"error_{uuid.uuid4().hex}.db"
    output_dir = temp_root / "error_out"
    build_index(str(REPO_PATH), str(db_path))

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        try:
            export_contexts(
                conn,
                repo_path=str(REPO_PATH),
                out_dir=str(output_dir),
                persisted_only=True,
            )
        except ValueError as exc:
            message = str(exc)
            assert "call /blocks/generate first" in message, message
        else:
            raise AssertionError("persisted_only export should fail without persisted blocks")

        try:
            generate_context_files(
                ContextsGenerateRequest(
                    repo_path=str(REPO_PATH),
                    out_dir=str(output_dir),
                    db_path=str(db_path),
                    persisted_only=True,
                )
            )
        except HTTPException as exc:
            assert exc.status_code == 400, exc
        else:
            raise AssertionError("HTTP entry should reject persisted_only export without blocks")
    finally:
        conn.close()


def validate_none_sections(temp_root: Path) -> None:
    repo_root = temp_root / "minimal_repo"
    repo_root.mkdir(parents=True, exist_ok=True)
    (repo_root / "main.c").write_text(
        "\n".join(
            [
                "static void helper(void) {",
                "}",
                "",
                "void boot(void) {",
                "    helper();",
                "}",
                "",
            ]
        ),
        encoding="utf-8",
        newline="\n",
    )
    db_path = temp_root / f"minimal_{uuid.uuid4().hex}.db"
    output_dir = temp_root / "minimal_out"
    build_index(str(repo_root), str(db_path))

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        result = export_contexts(
            conn,
            repo_path=str(repo_root),
            out_dir=str(output_dir),
            persisted_only=False,
        )
        assert result.context_count == 1, result
    finally:
        conn.close()

    manifest = load_json(output_dir / "manifest.json")
    context_path = output_dir / manifest["contexts"][0]["file"]
    context = load_json(context_path)
    assert context["outline"]["globals"] == [], context
    assert context["outline"]["types"] == [], context
    assert context["outline"]["macros"] == [], context
    assert context["locations"]["attached_comments"] == [], context
    prompt_text = context["prompt_ready"]["text"]
    assert "includes_globals: (none)" in prompt_text, prompt_text
    assert "includes_types: (none)" in prompt_text, prompt_text
    assert "includes_macros: (none)" in prompt_text, prompt_text
    assert "[Globals]\n(none)" in prompt_text, prompt_text
    assert "[Types]\n(none)" in prompt_text, prompt_text
    assert "[Macros]\n(none)" in prompt_text, prompt_text


def validate_non_function_attached_comments_are_omitted(temp_root: Path) -> None:
    db_path = temp_root / f"empty_comments_{uuid.uuid4().hex}.db"
    output_dir = temp_root / "empty_comments_out"
    build_index(str(REPO_PATH), str(db_path))

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("UPDATE functions SET attached_comments = ? WHERE name = ?", (" \t\n ", "boot"))
        conn.execute("UPDATE global_definitions SET attached_comments = ? WHERE name = ?", ("/* keep out */", "g_ctx"))
        conn.execute("UPDATE type_definitions SET attached_comments = ? WHERE name = ?", ("/* keep out */", "device_ctx_t"))
        conn.execute("UPDATE macro_definitions SET attached_comments = ? WHERE name = ?", ("/* keep out */", "RECORD_MACRO_STATE"))
        conn.commit()
        persisted_blocks = [block for block in persist_path_blocks(conn) if block.block_kind == "path"]
        result = export_contexts(
            conn,
            repo_path=str(REPO_PATH),
            out_dir=str(output_dir),
            persisted_only=True,
        )
        assert result.context_count == len(persisted_blocks), result
    finally:
        conn.close()

    manifest = load_json(output_dir / "manifest.json")
    prompt_text = "\n\n".join(
        load_json(output_dir / entry["file"])["prompt_ready"]["text"]
        for entry in manifest["contexts"]
    )
    assert "//// function: boot [19-38]" in prompt_text, prompt_text
    assert "//// global: g_ctx [line 6]" in prompt_text, prompt_text
    assert "//// type: device_ctx_t [31-36]" in prompt_text, prompt_text
    assert "//// macro: RECORD_MACRO_STATE [21-22]" in prompt_text, prompt_text
    assert "//// attached_comment: function boot" not in prompt_text, prompt_text
    assert "//// attached_comment: global g_ctx" not in prompt_text, prompt_text
    assert "//// attached_comment: type device_ctx_t" not in prompt_text, prompt_text
    assert "//// attached_comment: macro RECORD_MACRO_STATE" not in prompt_text, prompt_text
    assert "/* keep out */" not in prompt_text, prompt_text
    attached_comments = [
        item
        for entry in manifest["contexts"]
        for item in load_json(output_dir / entry["file"])["locations"]["attached_comments"]
    ]
    assert {"func_name": "boot", "path": "src/entry.c", "start_line": 18, "end_line": 18} not in attached_comments, attached_comments
    assert {"func_name": "update_global_len", "path": "src/state.c", "start_line": 18, "end_line": 18} in attached_comments, attached_comments


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


if __name__ == "__main__":
    main()
