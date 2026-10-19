from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKDIR = ROOT / "work"
if str(WORKDIR) not in sys.path:
    sys.path.insert(0, str(WORKDIR))

from app.indexer import build_index
from app.extractors import find_leading_comment
from app.path_blocks import generate_blocks, generate_path_blocks, get_persisted_block, list_persisted_blocks, persist_blocks, persist_path_blocks
from app.scanner import read_source_text


REPO_PATH = ROOT / "testcases" / "step1" / "A_supported"
DB_PATH = ROOT / "work" / "a_supported.db"


def main() -> None:
    assert_gb18030_source_decoding()
    assert_block_comment_without_star_prefix_attaches()
    stats = build_index(str(REPO_PATH), str(DB_PATH))
    assert stats.files_indexed == 4, stats
    assert stats.functions_indexed == 6, stats
    assert stats.calls_indexed == 6, stats
    assert stats.global_definitions_indexed == 4, stats
    assert stats.macro_definitions_indexed == 6, stats
    assert stats.type_definitions_indexed == 7, stats
    assert stats.global_symbol_refs_indexed == 12, stats

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        assert_calls(conn)
        assert_roots(conn)
        assert_global_definitions(conn)
        assert_macro_definitions(conn)
        assert_attached_comments(conn)
        assert_global_refs(conn)
        assert_default_blocks(conn)
        assert_local_subgraph_blocks(conn)
        assert_strategy_persistence(conn)
        assert_truncated_path_produces_others(conn)
    finally:
        conn.close()

    print("validation_ok")


def assert_gb18030_source_decoding() -> None:
    expected = "/* GB18030-only: \U00020000 */\nvoid decode_fixture(void) {}\n"
    with tempfile.TemporaryDirectory() as temp_dir:
        source_path = Path(temp_dir) / "gb18030_source.c"
        source_path.write_bytes(expected.encode("gb18030"))
        assert read_source_text(source_path) == expected


def assert_block_comment_without_star_prefix_attaches() -> None:
    lines = [
        "/*******************************************************",
        "  函数名称:  main",
        "  功能描述:  ",
        "  修改记录:  ",
        "********************************************************/",
        "void main(void)",
    ]
    assert find_leading_comment(lines, 6) == "\n".join(
        [
            "/*******************************************************",
            "  函数名称:  main",
            "  功能描述:",
            "  修改记录:",
            "********************************************************/",
        ]
    )


def assert_calls(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT caller_function_id, callee_name, resolved_function_id
        FROM calls
        ORDER BY caller_function_id, line, id
        """
    ).fetchall()
    actual = [(row["caller_function_id"], row["callee_name"], row["resolved_function_id"]) for row in rows]
    expected = [
        (2, "compute_limit", 1),
        (2, "update_global_len", 4),
        (2, "dispatch_event", 6),
        (4, "mark_busy", 3),
        (6, "fn", None),
        (6, "default_worker", 5),
    ]
    assert actual == expected, actual


def assert_roots(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT f.name
        FROM functions f
        WHERE f.id NOT IN (
            SELECT DISTINCT resolved_function_id
            FROM calls
            WHERE resolved_function_id IS NOT NULL
              AND caller_function_id != resolved_function_id
        )
        ORDER BY f.id
        """
    ).fetchall()
    actual = [row["name"] for row in rows]
    assert actual == ["boot"], actual


def assert_global_definitions(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT name, type_text, def_line, linkage
        FROM global_definitions
        ORDER BY def_line, name
        """
    ).fetchall()
    actual = [(row["name"], row["type_text"], row["def_line"], row["linkage"]) for row in rows]
    expected = [
        ("default_ctx", "device_ctx_t", 4, "global"),
        ("g_ctx", "device_ctx_t", 6, "global"),
        ("g_counter", "int", 8, "global"),
        ("g_macro_state", "macro_state_t", 10, "global"),
    ]
    assert actual == expected, actual


def assert_macro_definitions(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT name, kind, start_line, end_line, replacement_text
        FROM macro_definitions
        ORDER BY start_line, id
        """
    ).fetchall()
    actual = [(row["name"], row["kind"], row["start_line"], row["end_line"]) for row in rows]
    assert actual == [
        ("MODEL_CONTEXT_MACROS_H", "object", 14, 14),
        ("LIMIT_INCREMENT", "object", 16, 16),
        ("LIMIT_INCREMENT", "object", 18, 18),
        ("RECORD_MACRO_STATE", "function", 21, 22),
        ("BOOT_INCREMENT", "object", 23, 23),
        ("UNUSED_CONTEXT_MACRO", "object", 24, 24),
    ], actual
    replacement = next(row["replacement_text"] for row in rows if row["name"] == "RECORD_MACRO_STATE")
    assert "g_macro_state = MACRO_BUSY" in replacement, replacement
    assert "LIMIT_INCREMENT" in replacement, replacement


def assert_attached_comments(conn: sqlite3.Connection) -> None:
    function_comments = {
        row["name"]: row["attached_comments"]
        for row in conn.execute("SELECT name, attached_comments FROM functions ORDER BY id")
    }
    assert function_comments["boot"] == "/* Boot sequence entry point. */", function_comments
    assert function_comments["update_global_len"] == "/* Writes the computed length into the shared context. */", function_comments
    assert function_comments["compute_limit"] is None, function_comments

    global_comments = {
        row["name"]: row["attached_comments"]
        for row in conn.execute("SELECT name, attached_comments FROM global_definitions ORDER BY id")
    }
    assert global_comments["default_ctx"] == "/* Default device context backing storage. */", global_comments
    assert global_comments["g_ctx"] == "/* Active global device context. */", global_comments
    assert global_comments["g_counter"] == "/* Global update counter. */", global_comments
    assert global_comments["g_macro_state"] == "/* State touched only through a macro expansion. */", global_comments

    macro_comments = {
        row["name"]: row["attached_comments"]
        for row in conn.execute("SELECT name, attached_comments FROM macro_definitions ORDER BY id")
    }
    assert macro_comments["RECORD_MACRO_STATE"] == "/* Records a macro-hidden state update and adjusts a computed result. */", macro_comments

    type_comments = {
        row["name"]: row["attached_comments"]
        for row in conn.execute("SELECT name, attached_comments FROM type_definitions ORDER BY id")
    }
    assert type_comments["device_state_t"] == "/* Device lifecycle states. */", type_comments
    assert type_comments["worker_fn_t"] == "/* Event callback type for device handlers. */", type_comments
    assert type_comments["device_ctx_t"] == "/* Shared device context layout. */", type_comments
    assert type_comments["struct device_ctx"] == "/* Shared device context layout. */", type_comments


def assert_global_refs(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT f.name AS function_name,
               gsr.symbol_name,
               gsr.role,
               gsr.access_path,
               COALESCE(gsr.via_symbol, '') AS via_symbol
        FROM global_symbol_refs gsr
        JOIN functions f ON f.id = gsr.function_id
        ORDER BY f.id, gsr.line, gsr.id
        """
    ).fetchall()
    actual = {
        (row["function_name"], row["symbol_name"], row["role"], row["access_path"], row["via_symbol"])
        for row in rows
    }
    assert len(rows) == 12, len(rows)
    expected = {
        ("boot", "g_ctx", "read", "ctx->state", "ctx"),
        ("boot", "g_ctx", "write", "ctx->flags", "ctx"),
        ("boot", "g_ctx", "read", "ctx->flags", "ctx"),
        ("update_global_len", "g_ctx", "write", "ctx->len", "ctx"),
        ("update_global_len", "g_counter", "write", "g_counter", ""),
        ("update_global_len", "g_counter", "read", "g_counter", ""),
        ("default_worker", "g_ctx", "read", "g_ctx", ""),
        ("default_worker", "g_ctx", "write", "g_ctx", ""),
        ("default_worker", "g_ctx", "read", "g_ctx", ""),
        ("default_worker", "g_ctx", "read", "g_ctx->flags", ""),
        ("default_worker", "g_ctx", "write", "g_ctx->flags", ""),
        ("dispatch_event", "g_ctx", "read", "ctx->on_event", "ctx"),
    }
    assert expected.issubset(actual), actual


def assert_default_blocks(conn: sqlite3.Connection) -> None:
    blocks = generate_path_blocks(conn)
    strategy_blocks = generate_blocks(conn)
    explicit_path_blocks = generate_blocks(conn, strategy="path")
    assert [block.to_dict() for block in strategy_blocks] == [block.to_dict() for block in blocks], strategy_blocks
    assert [block.to_dict() for block in explicit_path_blocks] == [block.to_dict() for block in blocks], explicit_path_blocks
    try:
        generate_blocks(conn, strategy="unknown")
    except ValueError as exc:
        assert "unknown slicing strategy" in str(exc), exc
    else:
        raise AssertionError("unknown strategy should fail")
    assert all(block.block_kind == "path" for block in blocks), blocks
    actual = sorted((block.root_function_name, tuple(node.name for node in block.functions)) for block in blocks)
    expected = [
        ("boot", ("boot", "compute_limit")),
        ("boot", ("boot", "dispatch_event", "default_worker")),
        ("boot", ("boot", "update_global_len", "mark_busy")),
    ]
    assert actual == expected, actual
    for block in blocks:
        assert block.rendered_block.startswith(f"/* BLOCK kind=path root={block.root_function_name}"), block.rendered_block
        assert block.coverage_note is None, block
        for function in block.functions:
            assert function.signature_text.strip(), function
            assert function.body_text.strip(), function
            assert function.name in block.rendered_block, block.rendered_block
            assert function.path in block.rendered_block, block.rendered_block


def assert_local_subgraph_blocks(conn: sqlite3.Connection) -> None:
    blocks = generate_blocks(conn, strategy="local_subgraph")
    assert len(blocks) == 1, blocks
    block = blocks[0]
    assert block.block_kind == "local_subgraph", block
    assert block.root_function_name == "boot", block
    assert tuple(function.name for function in block.functions) == (
        "boot",
        "compute_limit",
        "update_global_len",
        "dispatch_event",
        "mark_busy",
        "default_worker",
    ), block
    assert block.truncated is False, block
    assert block.truncation_reason is None, block
    assert block.continuation_candidates == [], block
    assert block.path_signature.startswith("local_subgraph:"), block.path_signature
    assert "kind=local_subgraph" in block.rendered_block, block.rendered_block

    truncated_blocks = generate_blocks(conn, strategy="local_subgraph", max_functions=1)
    assert len(truncated_blocks) == 6, truncated_blocks
    first = truncated_blocks[0]
    assert first.root_function_name == "boot", first
    assert tuple(function.name for function in first.functions) == ("boot",), first
    assert first.truncated is True, first
    assert first.truncation_reason == "boundary", first
    first_boundaries = [candidate.function_name for candidate in first.continuation_candidates]
    assert first_boundaries == ["compute_limit", "update_global_len", "dispatch_event"], first_boundaries
    assert "mark_busy" not in first_boundaries, first_boundaries
    assert "default_worker" not in first_boundaries, first_boundaries
    assert all(block.block_kind == "local_subgraph" for block in truncated_blocks), truncated_blocks
    assert sorted(tuple(function.name for function in block.functions) for block in truncated_blocks) == [
        ("boot",),
        ("compute_limit",),
        ("default_worker",),
        ("dispatch_event",),
        ("mark_busy",),
        ("update_global_len",),
    ], truncated_blocks

    line_limited_blocks = generate_blocks(conn, strategy="local_subgraph", max_total_lines=1)
    assert len(line_limited_blocks) == 6, line_limited_blocks
    assert all(block.total_functions == 1 for block in line_limited_blocks), line_limited_blocks
    assert sorted(tuple(function.name for function in block.functions) for block in line_limited_blocks) == [
        ("boot",),
        ("compute_limit",),
        ("default_worker",),
        ("dispatch_event",),
        ("mark_busy",),
        ("update_global_len",),
    ], line_limited_blocks


def assert_strategy_persistence(conn: sqlite3.Connection) -> None:
    path_blocks = persist_blocks(conn, strategy="path")
    local_blocks = persist_blocks(conn, strategy="local_subgraph")
    persisted_path = list_persisted_blocks(conn, slicing_strategy="path")
    persisted_local = list_persisted_blocks(conn, slicing_strategy="local_subgraph")
    assert len(persisted_path) == len(path_blocks), persisted_path
    assert len(persisted_local) == len(local_blocks), persisted_local
    assert {block["slicing_strategy"] for block in persisted_path} == {"path"}, persisted_path
    assert {block["slicing_strategy"] for block in persisted_local} == {"local_subgraph"}, persisted_local

    local_block = get_persisted_block(conn, local_blocks[0].block_id, slicing_strategy="local_subgraph")
    assert local_block is not None, local_blocks[0]
    assert local_block["slicing_strategy"] == "local_subgraph", local_block
    assert local_block["block_kind"] == "local_subgraph", local_block
    assert tuple(function["name"] for function in local_block["functions"]) == (
        "boot",
        "compute_limit",
        "update_global_len",
        "dispatch_event",
        "mark_busy",
        "default_worker",
    ), local_block


def assert_truncated_path_produces_others(conn: sqlite3.Connection) -> None:
    blocks = persist_path_blocks(conn, max_functions=1)
    assert len(blocks) == 6, len(blocks)
    path_blocks = [block for block in blocks if block.block_kind == "path"]
    other_blocks = [block for block in blocks if block.block_kind == "others"]
    assert len(path_blocks) == 1, path_blocks
    assert len(other_blocks) == 5, other_blocks
    block = path_blocks[0]
    assert block.root_function_name == "boot", block
    assert block.truncated is True, block
    assert block.truncation_reason, block
    continuations = [candidate.function_name for candidate in block.continuation_candidates]
    assert continuations == ["compute_limit", "update_global_len", "dispatch_event"], continuations
    assert "truncated=true reason=" in block.rendered_block, block.rendered_block
    assert block.coverage_note is None, block
    other_function_sets = sorted(tuple(function.name for function in block.functions) for block in other_blocks)
    assert other_function_sets == [
        ("compute_limit",),
        ("default_worker",),
        ("dispatch_event",),
        ("mark_busy",),
        ("update_global_len",),
    ], other_function_sets
    assert all(block.coverage_note == "functions not included in primary path blocks" for block in other_blocks), other_blocks
    assert all("kind=others" in block.rendered_block for block in other_blocks), other_blocks
    assert all("functions not included in primary path blocks" in block.rendered_block for block in other_blocks), other_blocks
    assert all("#" in block.root_function_name for block in other_blocks), other_blocks
    persisted = get_persisted_block(conn, block.block_id)
    assert persisted is not None, block.block_id
    assert persisted["block_kind"] == "path", persisted
    assert persisted["root_function_name"] == "boot", persisted
    assert "//// function: boot [" in persisted["rendered_block"], persisted["rendered_block"]


if __name__ == "__main__":
    main()
