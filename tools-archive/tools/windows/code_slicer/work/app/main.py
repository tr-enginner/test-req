from __future__ import annotations

import sqlite3
from pathlib import Path
from dataclasses import asdict
from fastapi import FastAPI, HTTPException, Query

from app.config import DEFAULT_DB_PATH, MAX_FUNCTIONS_PER_BLOCK, MAX_TOTAL_LINES_PER_BLOCK
from app.context_export import export_contexts
from app.indexer import build_index
from app.path_blocks import (
    generate_blocks as generate_strategy_blocks,
    get_path_block,
    get_persisted_block,
    list_persisted_blocks,
    list_root_functions,
    persist_blocks,
)
from app.schemas import ContextsGenerateRequest, ContextsGenerateResponse, IndexRequest, IndexResponse

app = FastAPI(title="Lightweight Code Indexer", version="0.1.0")

SUPPORTED_SLICING_STRATEGIES = {"path", "local_subgraph"}


def connect(db_path: str | None) -> sqlite3.Connection:
    path = str(Path(db_path) if db_path else DEFAULT_DB_PATH)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/index", response_model=IndexResponse)
def index_repo(request: IndexRequest) -> IndexResponse:
    repo = Path(request.repo_path)
    if not repo.exists() or not repo.is_dir():
        raise HTTPException(status_code=400, detail="repo_path must be an existing directory")
    db_path = str(Path(request.db_path) if request.db_path else DEFAULT_DB_PATH)
    stats = build_index(str(repo), db_path)
    return IndexResponse(db_path=db_path, **asdict(stats))


@app.get("/functions")
def list_functions(name: str | None = Query(default=None), db_path: str | None = Query(default=None)) -> list[dict]:
    conn = connect(db_path)
    try:
        sql = """
            SELECT f.id, fi.path, f.name, f.start_line, f.end_line, f.return_type, f.signature_text, f.linkage, f.attached_comments
            FROM functions f
            JOIN files fi ON fi.id = f.file_id
        """
        params: tuple[object, ...] = ()
        if name:
            sql += " WHERE f.name = ?"
            params = (name,)
        sql += " ORDER BY fi.path, f.start_line"
        rows = conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.get("/functions/{function_id}")
def get_function(function_id: int, db_path: str | None = Query(default=None)) -> dict:
    conn = connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT f.id, fi.path, f.name, f.start_line, f.end_line, f.return_type, f.signature_text, f.body_text, f.linkage, f.attached_comments
            FROM functions f
            JOIN files fi ON fi.id = f.file_id
            WHERE f.id = ?
            """,
            (function_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="function not found")
        return dict(row)
    finally:
        conn.close()


@app.get("/calls/by-function/{function_id}")
def get_calls_by_function(function_id: int, db_path: str | None = Query(default=None)) -> list[dict]:
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT c.id, c.callee_name, c.callee_kind, c.resolved_function_id, c.line, c.arg_texts_json
            FROM calls c
            WHERE c.caller_function_id = ?
            ORDER BY c.line
            """,
            (function_id,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.get("/types")
def get_types(name: str | None = Query(default=None), db_path: str | None = Query(default=None)) -> list[dict]:
    conn = connect(db_path)
    try:
        sql = """
            SELECT td.id, fi.path, td.name, td.kind, td.start_line, td.end_line, td.underlying_type, td.target_type, td.is_function_pointer, td.attached_comments
            FROM type_definitions td
            JOIN files fi ON fi.id = td.file_id
        """
        params: tuple[object, ...] = ()
        if name:
            sql += " WHERE td.name = ?"
            params = (name,)
        sql += " ORDER BY fi.path, td.start_line"
        rows = conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.get("/types/fields")
def get_type_fields(name: str, db_path: str | None = Query(default=None)) -> list[dict]:
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT td.name AS type_name, tf.field_name, tf.field_type, tf.line, tf.is_function_pointer
            FROM type_fields tf
            JOIN type_definitions td ON td.id = tf.type_definition_id
            WHERE td.name = ?
            ORDER BY tf.line, tf.field_name
            """,
            (name,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.get("/globals")
def get_globals(name: str | None = Query(default=None), db_path: str | None = Query(default=None)) -> list[dict]:
    conn = connect(db_path)
    try:
        sql = """
            SELECT gd.id, fi.path, gd.name, gd.type_text, gd.def_line, gd.definition_text, gd.linkage, gd.attached_comments
            FROM global_definitions gd
            JOIN files fi ON fi.id = gd.file_id
        """
        params: tuple[object, ...] = ()
        if name:
            sql += " WHERE gd.name = ?"
            params = (name,)
        sql += " ORDER BY fi.path, gd.def_line, gd.name"
        rows = conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.get("/globals/refs")
def get_global_refs(symbol: str, db_path: str | None = Query(default=None)) -> list[dict]:
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT gsr.id, ff.path, f.name AS function_name, gsr.symbol_name, gsr.role, gsr.line, gsr.access_path, gsr.via_symbol
            FROM global_symbol_refs gsr
            JOIN functions f ON f.id = gsr.function_id
            JOIN files ff ON ff.id = f.file_id
            WHERE gsr.symbol_name = ?
            ORDER BY ff.path, f.name, gsr.line
            """,
            (symbol,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.get("/callers")
def get_callers(function: str, db_path: str | None = Query(default=None)) -> list[dict]:
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT c.id, ff.path, f.name AS caller_name, c.line
            FROM calls c
            JOIN functions f ON f.id = c.caller_function_id
            JOIN files ff ON ff.id = f.file_id
            WHERE c.callee_name = ?
            ORDER BY ff.path, c.line
            """,
            (function,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


@app.get("/callees")
def get_callees(function_id: int, db_path: str | None = Query(default=None)) -> list[dict]:
    return get_calls_by_function(function_id=function_id, db_path=db_path)


@app.get("/roots")
def get_roots(db_path: str | None = Query(default=None)) -> list[dict]:
    conn = connect(db_path)
    try:
        return list_root_functions(conn)
    finally:
        conn.close()


@app.get("/blocks")
def list_blocks(
    persisted_only: bool = Query(default=True),
    slicing_strategy: str = Query(default="path"),
    max_functions: int | None = Query(default=MAX_FUNCTIONS_PER_BLOCK, ge=1),
    max_total_lines: int = Query(default=MAX_TOTAL_LINES_PER_BLOCK, ge=1),
    db_path: str | None = Query(default=None),
) -> list[dict]:
    validate_slicing_strategy(slicing_strategy)
    conn = connect(db_path)
    try:
        if persisted_only:
            return list_persisted_blocks(conn, slicing_strategy=slicing_strategy)
        blocks = generate_strategy_blocks(
            conn,
            strategy=slicing_strategy,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        )
        return [block.to_dict() for block in blocks]
    finally:
        conn.close()


@app.post("/blocks/generate")
def generate_blocks_endpoint(
    slicing_strategy: str = Query(default="path"),
    max_functions: int | None = Query(default=MAX_FUNCTIONS_PER_BLOCK, ge=1),
    max_total_lines: int = Query(default=MAX_TOTAL_LINES_PER_BLOCK, ge=1),
    db_path: str | None = Query(default=None),
) -> dict:
    validate_slicing_strategy(slicing_strategy)
    conn = connect(db_path)
    try:
        blocks = persist_blocks(
            conn,
            strategy=slicing_strategy,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        )
        return {
            "blocks_generated": len(blocks),
            "slicing_strategy": slicing_strategy,
            "persisted": True,
            "max_functions": max_functions,
            "max_total_lines": max_total_lines,
        }
    finally:
        conn.close()


@app.get("/blocks/{block_id}")
def get_block(
    block_id: str,
    persisted_only: bool = Query(default=True),
    slicing_strategy: str | None = Query(default=None),
    max_functions: int | None = Query(default=MAX_FUNCTIONS_PER_BLOCK, ge=1),
    max_total_lines: int = Query(default=MAX_TOTAL_LINES_PER_BLOCK, ge=1),
    db_path: str | None = Query(default=None),
) -> dict:
    if slicing_strategy is not None:
        validate_slicing_strategy(slicing_strategy)
    conn = connect(db_path)
    try:
        if persisted_only:
            block = get_persisted_block(conn, block_id, slicing_strategy=slicing_strategy)
            if block is None:
                raise HTTPException(status_code=404, detail="block not found")
            return block
        if slicing_strategy is None or slicing_strategy == "path":
            block = get_path_block(
                conn,
                block_id,
                max_functions=max_functions,
                max_total_lines=max_total_lines,
            )
        else:
            block = next(
                (
                    candidate
                    for candidate in generate_strategy_blocks(
                        conn,
                        strategy=slicing_strategy,
                        max_functions=max_functions,
                        max_total_lines=max_total_lines,
                    )
                    if candidate.block_id == block_id
                ),
                None,
            )
        if block is None:
            raise HTTPException(status_code=404, detail="block not found")
        return block.to_dict()
    finally:
        conn.close()


def validate_slicing_strategy(slicing_strategy: str) -> None:
    if slicing_strategy not in SUPPORTED_SLICING_STRATEGIES:
        allowed = ", ".join(sorted(SUPPORTED_SLICING_STRATEGIES))
        raise HTTPException(status_code=400, detail=f"unknown slicing_strategy: {slicing_strategy}; expected one of: {allowed}")


@app.post("/contexts/generate", response_model=ContextsGenerateResponse)
def generate_context_files(request: ContextsGenerateRequest) -> ContextsGenerateResponse:
    validate_slicing_strategy(request.slicing_strategy)
    repo = Path(request.repo_path)
    if not repo.exists() or not repo.is_dir():
        raise HTTPException(status_code=400, detail="repo_path must be an existing directory")

    conn = connect(request.db_path)
    try:
        try:
            result = export_contexts(
                conn,
                repo_path=str(repo),
                out_dir=request.out_dir,
                persisted_only=request.persisted_only,
                slicing_strategy=request.slicing_strategy,
                max_functions=request.max_functions,
                max_total_lines=request.max_total_lines,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return ContextsGenerateResponse(
            project_path=result.project_path,
            out_dir=result.out_dir,
            manifest_file=result.manifest_file,
            context_count=result.context_count,
        )
    finally:
        conn.close()

