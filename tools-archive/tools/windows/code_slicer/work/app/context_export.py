from __future__ import annotations

import json
import os
import re
import sqlite3
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.config import MAX_FUNCTIONS_PER_BLOCK, MAX_TOTAL_LINES_PER_BLOCK
from app.path_blocks import generate_blocks, get_persisted_block, list_persisted_blocks
from app.scanner import read_source_text


TYPE_TOKEN_PATTERN = re.compile(r"\b(?:struct|enum|union)\s+[A-Za-z_][A-Za-z0-9_]*\b|\b[A-Za-z_][A-Za-z0-9_]*\b")
IDENTIFIER_PATTERN = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")
NON_CODE_TOKEN_PATTERN = re.compile(
    r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\''
)
BUILTIN_TYPE_NAMES = {
    "auto",
    "bool",
    "char",
    "const",
    "double",
    "extern",
    "far",
    "float",
    "inline",
    "int",
    "long",
    "near",
    "register",
    "restrict",
    "short",
    "signed",
    "size_t",
    "ssize_t",
    "static",
    "typedef",
    "unsigned",
    "void",
    "volatile",
}
MEMORY_QUALIFIERS = {
    "bdata",
    "bit",
    "code",
    "data",
    "far",
    "idata",
    "interrupt",
    "near",
    "pdata",
    "reentrant",
    "sbit",
    "sfr",
    "sfr16",
    "xdata",
    "using",
}


@dataclass(slots=True)
class FunctionExportRecord:
    id: int
    name: str
    path: str
    start_line: int
    end_line: int
    return_type: str
    signature_text: str
    body_text: str
    attached_comments: str | None


@dataclass(slots=True)
class GlobalRefRecord:
    function_id: int
    global_definition_id: int
    ref_line: int
    ref_id: int
    name: str
    type_text: str
    path: str
    def_line: int
    definition_text: str
    attached_comments: str | None


@dataclass(slots=True)
class GlobalExportRecord:
    id: int
    name: str
    type_text: str
    path: str
    line: int
    definition_text: str
    attached_comments: str | None


@dataclass(slots=True)
class GlobalCatalog:
    by_name: dict[str, list[GlobalExportRecord]]


@dataclass(slots=True)
class MacroExportRecord:
    id: int
    name: str
    kind: str
    path: str
    start_line: int
    end_line: int
    definition_text: str
    replacement_text: str
    parameters: tuple[str, ...]
    attached_comments: str | None


@dataclass(slots=True)
class MacroCatalog:
    by_name: dict[str, list[MacroExportRecord]]


@dataclass(slots=True)
class TypeExportRecord:
    id: int
    name: str
    path: str
    start_line: int
    end_line: int
    definition_text: str
    target_type: str
    attached_comments: str | None


@dataclass(slots=True)
class TypeCatalog:
    by_name: dict[str, list[TypeExportRecord]]
    fields_by_type_id: dict[int, list[str]]


@dataclass(slots=True)
class ContextExportResult:
    project_path: str
    out_dir: str
    manifest_file: str
    context_count: int


def export_contexts(
    conn: sqlite3.Connection,
    *,
    repo_path: str,
    out_dir: str,
    persisted_only: bool = True,
    slicing_strategy: str = "path",
    max_functions: int | None = MAX_FUNCTIONS_PER_BLOCK,
    max_total_lines: int = MAX_TOTAL_LINES_PER_BLOCK,
) -> ContextExportResult:
    repo_root = Path(repo_path).resolve()
    if not repo_root.exists() or not repo_root.is_dir():
        raise ValueError("repo_path must be an existing directory")

    output_dir = _resolve_output_dir(repo_root, out_dir)
    blocks = _load_path_blocks(
        conn,
        persisted_only=persisted_only,
        slicing_strategy=slicing_strategy,
        max_functions=max_functions,
        max_total_lines=max_total_lines,
    )
    blocks.sort(key=_block_sort_key)

    all_function_ids = sorted({function_id for block in blocks for function_id in block["path_function_ids"]})
    functions_by_id = _load_function_records(conn, all_function_ids)
    global_refs_by_function = _load_global_refs(conn, all_function_ids)
    global_catalog = _load_global_catalog(conn)
    macro_catalog = _load_macro_catalog(conn)
    type_catalog = _load_type_catalog(conn)

    _prepare_output_dir(output_dir)

    manifest_contexts: list[dict[str, str]] = []
    for index, block in enumerate(blocks, start=1):
        context_id = f"ctx-{index:04d}"
        function_ids = [int(function_id) for function_id in block["path_function_ids"]]
        function_records = _functions_for_block(block_id=str(block["block_id"]), function_ids=function_ids, functions_by_id=functions_by_id)
        initial_global_records = _collect_globals(function_ids, global_refs_by_function)
        global_records, type_records, macro_records = _collect_semantic_dependencies(
            function_records=function_records,
            initial_global_records=initial_global_records,
            global_catalog=global_catalog,
            macro_catalog=macro_catalog,
            type_catalog=type_catalog,
        )
        context_payload = _build_context_payload(
            context_id=context_id,
            block=block,
            repo_root=repo_root,
            function_records=function_records,
            global_records=global_records,
            type_records=type_records,
            macro_records=macro_records,
        )
        context_path = output_dir / "contexts" / f"{context_id}.json"
        _write_json(context_path, context_payload)
        manifest_contexts.append(
            {
                "context_id": context_id,
                "entry_name": function_records[0].name if function_records else str(block["root_function_name"]),
                "slicing_strategy": str(block.get("slicing_strategy", block.get("block_kind", "path"))),
                "block_kind": str(block.get("block_kind", "path")),
                "file": f"contexts/{context_path.name}",
            }
        )

    manifest_path = output_dir / "manifest.json"
    manifest = {
        "project_path": repo_root.as_posix(),
        "generated_at": _utc_now_isoformat(),
        "context_count": len(manifest_contexts),
        "contexts": manifest_contexts,
    }
    _write_json(manifest_path, manifest)
    return ContextExportResult(
        project_path=repo_root.as_posix(),
        out_dir=output_dir.as_posix(),
        manifest_file=manifest_path.as_posix(),
        context_count=len(manifest_contexts),
    )


def _load_path_blocks(
    conn: sqlite3.Connection,
    *,
    persisted_only: bool,
    slicing_strategy: str,
    max_functions: int | None,
    max_total_lines: int,
) -> list[dict]:
    if persisted_only:
        summaries = [
            block
            for block in list_persisted_blocks(conn, slicing_strategy=slicing_strategy)
            if block["block_kind"] == slicing_strategy
        ]
        if not summaries:
            raise ValueError(
                f"no persisted {slicing_strategy} blocks found; call /blocks/generate first or use persisted_only=false"
            )
        blocks: list[dict] = []
        for summary in summaries:
            block = get_persisted_block(conn, str(summary["block_id"]), slicing_strategy=slicing_strategy)
            if block is not None and block["block_kind"] == slicing_strategy:
                blocks.append(block)
        if not blocks:
            raise ValueError(
                f"no persisted {slicing_strategy} blocks found; call /blocks/generate first or use persisted_only=false"
            )
        return blocks

    return [
        block.to_dict()
        for block in generate_blocks(
            conn,
            strategy=slicing_strategy,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        )
        if block.block_kind == slicing_strategy
    ]


def _block_sort_key(block: dict) -> tuple[str, int, str]:
    functions = block.get("functions", [])
    if functions:
        first = functions[0]
        return (
            str(first["path"]),
            int(first["start_line"]),
            str(block["path_signature"]),
        )
    return ("", 0, str(block["path_signature"]))


def _load_function_records(conn: sqlite3.Connection, function_ids: list[int]) -> dict[int, FunctionExportRecord]:
    if not function_ids:
        return {}
    rows = conn.execute(
        f"""
        SELECT f.id, fi.path, f.name, f.start_line, f.end_line,
               COALESCE(f.return_type, '') AS return_type,
               f.signature_text, f.body_text, f.attached_comments
        FROM functions f
        JOIN files fi ON fi.id = f.file_id
        WHERE f.id IN ({_placeholders(len(function_ids))})
        """,
        function_ids,
    ).fetchall()
    return {
        int(row["id"]): FunctionExportRecord(
            id=int(row["id"]),
            name=str(row["name"]),
            path=str(row["path"]),
            start_line=int(row["start_line"]),
            end_line=int(row["end_line"]),
            return_type=str(row["return_type"]),
            signature_text=str(row["signature_text"]),
            body_text=str(row["body_text"]),
            attached_comments=str(row["attached_comments"]) if row["attached_comments"] is not None else None,
        )
        for row in rows
    }


def _load_global_refs(conn: sqlite3.Connection, function_ids: list[int]) -> dict[int, list[GlobalRefRecord]]:
    if not function_ids:
        return {}
    rows = conn.execute(
        f"""
        SELECT gsr.id AS ref_id,
               gsr.function_id,
               gsr.global_definition_id,
               gsr.line,
               gd.name,
               gd.type_text,
               gd.def_line,
               gd.definition_text,
               gd.attached_comments,
               fi.path
        FROM global_symbol_refs gsr
        JOIN global_definitions gd ON gd.id = gsr.global_definition_id
        JOIN files fi ON fi.id = gd.file_id
        WHERE gsr.function_id IN ({_placeholders(len(function_ids))})
        ORDER BY gsr.function_id, gsr.line, gsr.id
        """,
        function_ids,
    ).fetchall()
    refs_by_function: dict[int, list[GlobalRefRecord]] = {}
    for row in rows:
        ref = GlobalRefRecord(
            function_id=int(row["function_id"]),
            global_definition_id=int(row["global_definition_id"]),
            ref_line=int(row["line"]),
            ref_id=int(row["ref_id"]),
            name=str(row["name"]),
            type_text=str(row["type_text"]),
            path=str(row["path"]),
            def_line=int(row["def_line"]),
            definition_text=str(row["definition_text"]),
            attached_comments=str(row["attached_comments"]) if row["attached_comments"] is not None else None,
        )
        refs_by_function.setdefault(ref.function_id, []).append(ref)
    return refs_by_function


def _load_global_catalog(conn: sqlite3.Connection) -> GlobalCatalog:
    rows = conn.execute(
        """
        SELECT gd.id, gd.name, gd.type_text, gd.def_line, gd.definition_text,
               gd.attached_comments, fi.path
        FROM global_definitions gd
        JOIN files fi ON fi.id = gd.file_id
        ORDER BY fi.path, gd.def_line, gd.name, gd.id
        """
    ).fetchall()
    globals_by_name: dict[str, list[GlobalExportRecord]] = {}
    for row in rows:
        record = GlobalExportRecord(
            id=int(row["id"]),
            name=str(row["name"]),
            type_text=str(row["type_text"]),
            path=str(row["path"]),
            line=int(row["def_line"]),
            definition_text=str(row["definition_text"]),
            attached_comments=str(row["attached_comments"]) if row["attached_comments"] is not None else None,
        )
        globals_by_name.setdefault(record.name, []).append(record)
    return GlobalCatalog(by_name=globals_by_name)


def _load_macro_catalog(conn: sqlite3.Connection) -> MacroCatalog:
    try:
        rows = conn.execute(
            """
            SELECT md.id, md.name, md.kind, md.start_line, md.end_line,
                   md.definition_text, md.replacement_text, md.parameters_json,
                   md.attached_comments, fi.path
            FROM macro_definitions md
            JOIN files fi ON fi.id = md.file_id
            ORDER BY fi.path, md.start_line, md.name, md.id
            """
        ).fetchall()
    except sqlite3.OperationalError:
        return MacroCatalog(by_name={})
    macros_by_name: dict[str, list[MacroExportRecord]] = {}
    for row in rows:
        record = MacroExportRecord(
            id=int(row["id"]),
            name=str(row["name"]),
            kind=str(row["kind"]),
            path=str(row["path"]),
            start_line=int(row["start_line"]),
            end_line=int(row["end_line"]),
            definition_text=str(row["definition_text"]),
            replacement_text=str(row["replacement_text"]),
            parameters=tuple(str(value) for value in json.loads(str(row["parameters_json"]))),
            attached_comments=str(row["attached_comments"]) if row["attached_comments"] is not None else None,
        )
        macros_by_name.setdefault(record.name, []).append(record)
    return MacroCatalog(by_name=macros_by_name)


def _load_type_catalog(conn: sqlite3.Connection) -> TypeCatalog:
    type_rows = conn.execute(
        """
        SELECT td.id, fi.path, td.name, td.start_line, td.end_line, td.definition_text,
               COALESCE(td.target_type, '') AS target_type, td.attached_comments
        FROM type_definitions td
        JOIN files fi ON fi.id = td.file_id
        ORDER BY fi.path, td.start_line, td.name
        """
    ).fetchall()
    type_defs_by_name: dict[str, list[TypeExportRecord]] = {}
    for row in type_rows:
        type_record = TypeExportRecord(
            id=int(row["id"]),
            name=str(row["name"]),
            path=str(row["path"]),
            start_line=int(row["start_line"]),
            end_line=int(row["end_line"]),
            definition_text=str(row["definition_text"]),
            target_type=str(row["target_type"]),
            attached_comments=str(row["attached_comments"]) if row["attached_comments"] is not None else None,
        )
        type_defs_by_name.setdefault(type_record.name, []).append(type_record)

    field_rows = conn.execute(
        """
        SELECT type_definition_id, field_type
        FROM type_fields
        ORDER BY type_definition_id, line, id
        """
    ).fetchall()
    fields_by_type_id: dict[int, list[str]] = {}
    for row in field_rows:
        fields_by_type_id.setdefault(int(row["type_definition_id"]), []).append(str(row["field_type"]))
    return TypeCatalog(by_name=type_defs_by_name, fields_by_type_id=fields_by_type_id)


def _functions_for_block(
    *,
    block_id: str,
    function_ids: list[int],
    functions_by_id: dict[int, FunctionExportRecord],
) -> list[FunctionExportRecord]:
    missing = [function_id for function_id in function_ids if function_id not in functions_by_id]
    if missing:
        raise ValueError(f"missing function rows for block {block_id}: {missing}")
    return [functions_by_id[function_id] for function_id in function_ids]


def _collect_globals(
    function_ids: list[int],
    global_refs_by_function: dict[int, list[GlobalRefRecord]],
) -> list[GlobalExportRecord]:
    seen_global_ids: set[int] = set()
    globals_for_block: list[GlobalExportRecord] = []
    for function_id in function_ids:
        refs = global_refs_by_function.get(function_id, [])
        for ref in refs:
            if ref.global_definition_id in seen_global_ids:
                continue
            seen_global_ids.add(ref.global_definition_id)
            globals_for_block.append(
                GlobalExportRecord(
                    id=ref.global_definition_id,
                    name=ref.name,
                    type_text=ref.type_text,
                    path=ref.path,
                    line=ref.def_line,
                    definition_text=ref.definition_text,
                    attached_comments=ref.attached_comments,
                )
            )
    return globals_for_block


def _collect_semantic_dependencies(
    *,
    function_records: list[FunctionExportRecord],
    initial_global_records: list[GlobalExportRecord],
    global_catalog: GlobalCatalog,
    macro_catalog: MacroCatalog,
    type_catalog: TypeCatalog,
) -> tuple[list[GlobalExportRecord], list[TypeExportRecord], list[MacroExportRecord]]:
    global_records = list(initial_global_records)
    global_ids = {record.id for record in global_records}
    type_records: list[TypeExportRecord] = []
    macro_records: list[MacroExportRecord] = []
    macro_ids: set[int] = set()

    while True:
        before = (len(global_records), len(type_records), len(macro_records))
        semantic_texts = [
            text
            for record in function_records
            for text in (record.return_type, record.signature_text, record.body_text)
        ]
        semantic_texts.extend(
            text
            for record in global_records
            for text in (record.type_text, record.definition_text)
        )
        semantic_texts.extend(
            text
            for record in type_records
            for text in (record.target_type, record.definition_text)
        )
        semantic_texts.extend(record.replacement_text for record in macro_records)
        for text in semantic_texts:
            _append_referenced_macros(
                text=text,
                macro_catalog=macro_catalog,
                selected=macro_records,
                selected_ids=macro_ids,
            )

        for macro_record in macro_records:
            for identifier, _invoked in _extract_identifier_uses(
                macro_record.replacement_text,
                excluded_names=set(macro_record.parameters),
            ):
                for global_record in global_catalog.by_name.get(identifier, []):
                    if global_record.id in global_ids:
                        continue
                    global_ids.add(global_record.id)
                    global_records.append(global_record)

        type_records = _collect_types(function_records, global_records, type_catalog, macro_records)
        after = (len(global_records), len(type_records), len(macro_records))
        if after == before:
            return global_records, type_records, macro_records


def _append_referenced_macros(
    *,
    text: str,
    macro_catalog: MacroCatalog,
    selected: list[MacroExportRecord],
    selected_ids: set[int],
    excluded_names: set[str] | None = None,
) -> None:
    for identifier, invoked in _extract_identifier_uses(text, excluded_names=excluded_names):
        for macro_record in macro_catalog.by_name.get(identifier, []):
            if macro_record.kind == "function" and not invoked:
                continue
            if macro_record.id in selected_ids:
                continue
            selected_ids.add(macro_record.id)
            selected.append(macro_record)


def _extract_identifier_uses(
    text: str,
    excluded_names: set[str] | None = None,
) -> list[tuple[str, bool]]:
    if not text:
        return []
    sanitized = NON_CODE_TOKEN_PATTERN.sub(" ", text)
    excluded = excluded_names or set()
    uses: list[tuple[str, bool]] = []
    for match in IDENTIFIER_PATTERN.finditer(sanitized):
        identifier = match.group(0)
        if identifier in excluded:
            continue
        invoked = re.match(r"\s*\(", sanitized[match.end():]) is not None
        uses.append((identifier, invoked))
    return uses


def _collect_types(
    function_records: list[FunctionExportRecord],
    global_records: list[GlobalExportRecord],
    type_catalog: TypeCatalog,
    macro_records: list[MacroExportRecord] | None = None,
) -> list[TypeExportRecord]:
    pending_names: deque[str] = deque()
    queued_names: set[str] = set()
    collected_ids: set[int] = set()
    collected_types: list[TypeExportRecord] = []

    seed_texts = [record.type_text for record in global_records]
    seed_texts.extend(record.definition_text for record in global_records)
    seed_texts.extend(record.return_type for record in function_records)
    seed_texts.extend(record.signature_text for record in function_records)
    seed_texts.extend(record.replacement_text for record in macro_records or [])

    for text in seed_texts:
        for candidate in _extract_type_candidates(text):
            if candidate in type_catalog.by_name and candidate not in queued_names:
                pending_names.append(candidate)
                queued_names.add(candidate)

    while pending_names:
        type_name = pending_names.popleft()
        for type_record in type_catalog.by_name.get(type_name, []):
            if type_record.id in collected_ids:
                continue
            collected_ids.add(type_record.id)
            collected_types.append(type_record)
            for candidate in _extract_type_candidates(type_record.target_type):
                if candidate in type_catalog.by_name and candidate not in queued_names:
                    pending_names.append(candidate)
                    queued_names.add(candidate)
            for field_type in type_catalog.fields_by_type_id.get(type_record.id, []):
                for candidate in _extract_type_candidates(field_type):
                    if candidate in type_catalog.by_name and candidate not in queued_names:
                        pending_names.append(candidate)
                        queued_names.add(candidate)

    return collected_types


def _extract_type_candidates(text: str) -> list[str]:
    if not text:
        return []
    candidates: list[str] = []
    seen: set[str] = set()
    for match in TYPE_TOKEN_PATTERN.finditer(text):
        candidate = match.group(0).strip()
        if not candidate:
            continue
        if candidate in seen:
            continue
        if _should_ignore_type_candidate(candidate):
            continue
        seen.add(candidate)
        candidates.append(candidate)
    return candidates


def _should_ignore_type_candidate(candidate: str) -> bool:
    if " " in candidate:
        head, _tail = candidate.split(" ", 1)
        return head in MEMORY_QUALIFIERS
    return candidate in BUILTIN_TYPE_NAMES or candidate in MEMORY_QUALIFIERS


def _build_context_payload(
    *,
    context_id: str,
    block: dict,
    repo_root: Path,
    function_records: list[FunctionExportRecord],
    global_records: list[GlobalExportRecord],
    type_records: list[TypeExportRecord],
    macro_records: list[MacroExportRecord],
) -> dict:
    slicing_strategy = str(block.get("slicing_strategy", block.get("block_kind", "path")))
    block_kind = str(block.get("block_kind", slicing_strategy))
    outline = _build_outline(
        slicing_strategy=slicing_strategy,
        function_records=function_records,
        global_records=global_records,
        type_records=type_records,
        macro_records=macro_records,
    )
    return {
        "context_id": context_id,
        "block": {
            "block_id": str(block["block_id"]),
            "block_kind": block_kind,
            "slicing_strategy": slicing_strategy,
            "root_function_name": str(block["root_function_name"]),
            "function_ids": [int(function_id) for function_id in block["path_function_ids"]],
        },
        "outline": outline,
        "locations": {
            "functions": [
                {
                    "name": record.name,
                    "path": _to_repo_relative_path(record.path, repo_root),
                    "start_line": record.start_line,
                    "end_line": record.end_line,
                }
                for record in function_records
            ],
            "globals": [
                {
                    "name": record.name,
                    "path": _to_repo_relative_path(record.path, repo_root),
                    "line": record.line,
                }
                for record in global_records
            ],
            "types": [
                {
                    "name": record.name,
                    "path": _to_repo_relative_path(record.path, repo_root),
                    "start_line": record.start_line,
                    "end_line": record.end_line,
                }
                for record in type_records
            ],
            "macros": [
                {
                    "name": record.name,
                    "path": _to_repo_relative_path(record.path, repo_root),
                    "start_line": record.start_line,
                    "end_line": record.end_line,
                    "kind": record.kind,
                }
                for record in macro_records
            ],
            "attached_comments": _build_attached_comment_locations(function_records, repo_root),
        },
        "prompt_ready": {
            "text": _build_prompt_text(
                context_id=context_id,
                slicing_strategy=slicing_strategy,
                repo_root=repo_root,
                function_records=function_records,
                global_records=global_records,
                type_records=type_records,
                macro_records=macro_records,
            )
        },
    }


def _build_attached_comment_locations(
    function_records: list[FunctionExportRecord],
    repo_root: Path,
) -> list[dict]:
    locations: list[dict] = []
    for record in function_records:
        location = _function_attached_comment_location(record, repo_root)
        if location is not None:
            locations.append(location)
    return locations


def _function_attached_comment_location(
    record: FunctionExportRecord,
    repo_root: Path,
) -> dict | None:
    attached_comment = _clean_attached_comment(record.attached_comments)
    if not attached_comment:
        return None

    start_line, end_line = _locate_attached_comment_lines(record, attached_comment)
    return {
        "func_name": record.name,
        "path": _to_repo_relative_path(record.path, repo_root),
        "start_line": start_line,
        "end_line": end_line,
    }


def _locate_attached_comment_lines(record: FunctionExportRecord, attached_comment: str) -> tuple[int, int]:
    try:
        lines = read_source_text(record.path).splitlines()
    except (OSError, UnicodeError):
        return _fallback_attached_comment_lines(record, attached_comment)

    index = record.start_line - 2
    while index >= 0 and not lines[index].strip():
        index -= 1
    if index < 0:
        return _fallback_attached_comment_lines(record, attached_comment)

    end_index = index
    stripped = _normalize_comment_line(lines[index])
    if stripped.startswith("//"):
        start_index = index
        while start_index - 1 >= 0 and _normalize_comment_line(lines[start_index - 1]).startswith("//"):
            start_index -= 1
        if _normalize_attached_comment_text(lines[start_index : end_index + 1]) == attached_comment:
            return start_index + 1, end_index + 1
    elif _is_block_comment_line(stripped):
        start_index = index
        while start_index >= 0:
            current = _normalize_comment_line(lines[start_index])
            if current.startswith("/*"):
                if _normalize_attached_comment_text(lines[start_index : end_index + 1]) == attached_comment:
                    return start_index + 1, end_index + 1
                break
            start_index -= 1

    return _fallback_attached_comment_lines(record, attached_comment)


def _fallback_attached_comment_lines(record: FunctionExportRecord, attached_comment: str) -> tuple[int, int]:
    comment_line_count = max(1, len(attached_comment.splitlines()))
    end_line = max(1, record.start_line - 1)
    start_line = max(1, end_line - comment_line_count + 1)
    return start_line, end_line


def _normalize_comment_line(text: str) -> str:
    return text.lstrip("\ufeff").strip()


def _normalize_attached_comment_text(lines: list[str]) -> str:
    return "\n".join(line.rstrip() for line in lines).lstrip("\ufeff").strip()


def _is_block_comment_line(text: str) -> bool:
    return text.startswith("/*") or text.startswith("*") or text.endswith("*/")


def _build_outline(
    *,
    slicing_strategy: str,
    function_records: list[FunctionExportRecord],
    global_records: list[GlobalExportRecord],
    type_records: list[TypeExportRecord],
    macro_records: list[MacroExportRecord],
) -> dict:
    macro_names: list[str] = []
    for record in macro_records:
        if record.name not in macro_names:
            macro_names.append(record.name)
    outline: dict[str, list[str]] = {
        "globals": [record.name for record in global_records],
        "types": [record.name for record in type_records],
        "macros": macro_names,
    }
    function_names = [record.name for record in function_records]
    if slicing_strategy == "local_subgraph":
        outline["function_region"] = function_names
    else:
        outline["function_chain"] = function_names
    return outline


def _build_prompt_text(
    *,
    context_id: str,
    slicing_strategy: str,
    repo_root: Path,
    function_records: list[FunctionExportRecord],
    global_records: list[GlobalExportRecord],
    type_records: list[TypeExportRecord],
    macro_records: list[MacroExportRecord],
) -> str:
    function_names = [record.name for record in function_records]
    function_context = _format_function_context(slicing_strategy=slicing_strategy, function_names=function_names)
    includes_globals = ", ".join(record.name for record in global_records) if global_records else "(none)"
    includes_types = ", ".join(record.name for record in type_records) if type_records else "(none)"
    macro_names = list(dict.fromkeys(record.name for record in macro_records))
    includes_macros = ", ".join(macro_names) if macro_names else "(none)"

    sections = [
        "\n".join(
            [
                "[Context]",
                f"id: {context_id}",
                f"slicing_strategy: {slicing_strategy}",
                function_context,
                f"includes_globals: {includes_globals}",
                f"includes_types: {includes_types}",
                f"includes_macros: {includes_macros}",
            ]
        ),
        _render_functions_section(function_records, repo_root),
        _render_globals_section(global_records, repo_root),
        _render_types_section(type_records, repo_root),
        _render_macros_section(macro_records, repo_root),
    ]
    return "\n\n".join(sections)


def _format_function_context(*, slicing_strategy: str, function_names: list[str]) -> str:
    if not function_names:
        value = "(none)"
    elif slicing_strategy == "local_subgraph":
        value = ", ".join(function_names)
    else:
        value = " -> ".join(function_names)

    if slicing_strategy == "local_subgraph":
        return f"function_region: {value}"
    return f"function_chain: {value}"


def _render_functions_section(function_records: list[FunctionExportRecord], repo_root: Path) -> str:
    if not function_records:
        return "[Functions]\n(none)"
    sections = ["[Functions]"]
    for record in function_records:
        sections.append(f"//// file: {_to_repo_relative_path(record.path, repo_root)}")
        attached_comment = _clean_attached_comment(record.attached_comments)
        if attached_comment:
            comment_start_line, comment_end_line = _locate_attached_comment_lines(record, attached_comment)
            sections.append(f"//// attached_comment: function {record.name} [{comment_start_line},{comment_end_line}]")
            sections.append(attached_comment)
        sections.append(f"//// function: {record.name} [{record.start_line}-{record.end_line}]")
        signature_head = f"{record.return_type} {record.signature_text}".strip()
        sections.append(f"{signature_head} {record.body_text}".strip())
        sections.append("")
    return "\n".join(sections[:-1])


def _render_globals_section(global_records: list[GlobalExportRecord], repo_root: Path) -> str:
    if not global_records:
        return "[Globals]\n(none)"
    sections = ["[Globals]"]
    for record in global_records:
        sections.append(f"//// file: {_to_repo_relative_path(record.path, repo_root)}")
        sections.append(f"//// global: {record.name} [line {record.line}]")
        sections.append(record.definition_text.strip())
        sections.append("")
    return "\n".join(sections[:-1])


def _render_types_section(type_records: list[TypeExportRecord], repo_root: Path) -> str:
    if not type_records:
        return "[Types]\n(none)"
    sections = ["[Types]"]
    for record in type_records:
        sections.append(f"//// file: {_to_repo_relative_path(record.path, repo_root)}")
        sections.append(f"//// type: {record.name} [{record.start_line}-{record.end_line}]")
        sections.append(record.definition_text.strip())
        sections.append("")
    return "\n".join(sections[:-1])


def _render_macros_section(macro_records: list[MacroExportRecord], repo_root: Path) -> str:
    if not macro_records:
        return "[Macros]\n(none)"
    sections = ["[Macros]"]
    for record in macro_records:
        sections.append(f"//// file: {_to_repo_relative_path(record.path, repo_root)}")
        sections.append(f"//// macro: {record.name} [{record.start_line}-{record.end_line}]")
        sections.append(record.definition_text.strip())
        sections.append("")
    return "\n".join(sections[:-1])


def _clean_attached_comment(attached_comments: str | None) -> str | None:
    if attached_comments is None:
        return None
    cleaned = attached_comments.strip()
    return cleaned or None


def _resolve_output_dir(repo_root: Path, out_dir: str) -> Path:
    output_dir = Path(out_dir)
    if output_dir.is_absolute():
        return output_dir.resolve()
    return (repo_root / output_dir).resolve()


def _prepare_output_dir(output_dir: Path) -> None:
    contexts_dir = output_dir / "contexts"
    contexts_dir.mkdir(parents=True, exist_ok=True)
    for stale_file in contexts_dir.glob("ctx-*.json"):
        stale_file.unlink()


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def _to_repo_relative_path(path: str, repo_root: Path) -> str:
    absolute_path = Path(path).resolve()
    relative_path = os.path.relpath(absolute_path, repo_root)
    if relative_path.startswith(".."):
        return absolute_path.as_posix()
    return Path(relative_path).as_posix()


def _utc_now_isoformat() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _placeholders(count: int) -> str:
    return ", ".join("?" for _ in range(count))
