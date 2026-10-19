from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from app.models import (
    CallRecord,
    FunctionRecord,
    GlobalDefinitionRecord,
    MacroDefinitionRecord,
    TypeDefinitionRecord,
    TypeFieldRecord,
)


SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    sha1 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS functions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    return_type TEXT,
    signature_text TEXT NOT NULL,
    body_text TEXT NOT NULL,
    ast_type TEXT NOT NULL,
    linkage TEXT NOT NULL,
    attached_comments TEXT,
    UNIQUE(file_id, name, start_line),
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS global_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type_text TEXT NOT NULL,
    def_line INTEGER NOT NULL,
    definition_text TEXT NOT NULL,
    linkage TEXT NOT NULL,
    attached_comments TEXT,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS macro_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    definition_text TEXT NOT NULL,
    replacement_text TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    attached_comments TEXT,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    caller_function_id INTEGER NOT NULL,
    callee_name TEXT NOT NULL,
    callee_kind TEXT NOT NULL,
    resolved_function_id INTEGER,
    line INTEGER NOT NULL,
    arg_texts_json TEXT NOT NULL,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY(caller_function_id) REFERENCES functions(id) ON DELETE CASCADE,
    FOREIGN KEY(resolved_function_id) REFERENCES functions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS type_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    definition_text TEXT NOT NULL,
    underlying_type TEXT,
    target_type TEXT,
    is_function_pointer INTEGER NOT NULL,
    attached_comments TEXT,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS type_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_definition_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    field_type TEXT NOT NULL,
    line INTEGER NOT NULL,
    is_function_pointer INTEGER NOT NULL,
    FOREIGN KEY(type_definition_id) REFERENCES type_definitions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS global_symbol_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    function_id INTEGER NOT NULL,
    global_definition_id INTEGER NOT NULL,
    symbol_name TEXT NOT NULL,
    role TEXT NOT NULL,
    line INTEGER NOT NULL,
    access_path TEXT NOT NULL,
    via_symbol TEXT,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY(function_id) REFERENCES functions(id) ON DELETE CASCADE,
    FOREIGN KEY(global_definition_id) REFERENCES global_definitions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS path_blocks (
    block_id TEXT PRIMARY KEY,
    block_kind TEXT NOT NULL,
    slicing_strategy TEXT NOT NULL DEFAULT 'path',
    root_function_id INTEGER,
    root_function_name TEXT NOT NULL,
    path_signature TEXT NOT NULL,
    depth INTEGER NOT NULL,
    total_functions INTEGER NOT NULL,
    total_lines INTEGER NOT NULL,
    truncated INTEGER NOT NULL,
    truncation_reason TEXT,
    max_functions INTEGER NOT NULL,
    max_total_lines INTEGER NOT NULL,
    FOREIGN KEY(root_function_id) REFERENCES functions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS path_block_functions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    function_id INTEGER NOT NULL,
    FOREIGN KEY(block_id) REFERENCES path_blocks(block_id) ON DELETE CASCADE,
    FOREIGN KEY(function_id) REFERENCES functions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS path_block_continuations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    function_id INTEGER NOT NULL,
    function_name TEXT NOT NULL,
    path TEXT NOT NULL,
    linkage TEXT NOT NULL,
    FOREIGN KEY(block_id) REFERENCES path_blocks(block_id) ON DELETE CASCADE,
    FOREIGN KEY(function_id) REFERENCES functions(id) ON DELETE CASCADE
);

"""


class SQLiteStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row

    def initialize(self) -> None:
        self.conn.executescript(SCHEMA_SQL)
        self._migrate_path_blocks()
        self.conn.commit()

    def _migrate_path_blocks(self) -> None:
        rows = self.conn.execute("PRAGMA table_info(path_blocks)").fetchall()
        column_names = {str(row["name"]) for row in rows}
        if "slicing_strategy" not in column_names:
            self.conn.execute("ALTER TABLE path_blocks ADD COLUMN slicing_strategy TEXT NOT NULL DEFAULT 'path'")

    def reset(self) -> None:
        self.conn.executescript(
            """
            PRAGMA foreign_keys = OFF;
            DROP TABLE IF EXISTS resource_ops;
            DROP TABLE IF EXISTS path_block_continuations;
            DROP TABLE IF EXISTS path_block_functions;
            DROP TABLE IF EXISTS path_blocks;
            DROP TABLE IF EXISTS global_symbol_refs;
            DROP TABLE IF EXISTS global_definitions;
            DROP TABLE IF EXISTS macro_definitions;
            DROP TABLE IF EXISTS type_fields;
            DROP TABLE IF EXISTS type_definitions;
            DROP TABLE IF EXISTS calls;
            DROP TABLE IF EXISTS functions;
            DROP TABLE IF EXISTS files;
            PRAGMA foreign_keys = ON;
            """
        )
        self.conn.executescript(SCHEMA_SQL)
        self.conn.commit()

    def upsert_file(self, path: str, sha1: str) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO files(path, sha1) VALUES(?, ?)
            ON CONFLICT(path) DO UPDATE SET sha1 = excluded.sha1
            """,
            (path, sha1),
        )
        if cursor.lastrowid:
            return int(cursor.lastrowid)
        row = self.conn.execute("SELECT id FROM files WHERE path = ?", (path,)).fetchone()
        return int(row["id"])

    def insert_function(self, file_id: int, record: FunctionRecord) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO functions(
                file_id, name, start_line, end_line, return_type, signature_text, body_text, ast_type,
                linkage, attached_comments
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                file_id,
                record.name,
                record.start_line,
                record.end_line,
                record.return_type,
                record.signature_text,
                record.body_text,
                record.ast_type,
                record.linkage,
                record.attached_comments,
            ),
        )
        return int(cursor.lastrowid)

    def insert_global_definition(self, file_id: int, record: GlobalDefinitionRecord) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO global_definitions(file_id, name, type_text, def_line, definition_text, linkage, attached_comments)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                file_id,
                record.name,
                record.type_text,
                record.def_line,
                record.definition_text,
                record.linkage,
                record.attached_comments,
            ),
        )
        return int(cursor.lastrowid)

    def insert_macro_definition(self, file_id: int, record: MacroDefinitionRecord) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO macro_definitions(
                file_id, name, kind, start_line, end_line, definition_text, replacement_text,
                parameters_json, attached_comments
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                file_id,
                record.name,
                record.kind,
                record.start_line,
                record.end_line,
                record.definition_text,
                record.replacement_text,
                json.dumps(record.parameters, ensure_ascii=True),
                record.attached_comments,
            ),
        )
        return int(cursor.lastrowid)

    def insert_call(self, file_id: int, caller_function_id: int, record: CallRecord) -> None:
        self.conn.execute(
            """
            INSERT INTO calls(
                file_id, caller_function_id, callee_name, callee_kind, resolved_function_id, line, arg_texts_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                file_id,
                caller_function_id,
                record.callee_name,
                record.callee_kind,
                record.resolved_function_id,
                record.line,
                json.dumps(record.arg_texts, ensure_ascii=True),
            ),
        )

    def insert_type_definition(self, file_id: int, record: TypeDefinitionRecord) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO type_definitions(
                file_id, name, kind, start_line, end_line, definition_text, underlying_type, target_type,
                is_function_pointer, attached_comments
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                file_id,
                record.name,
                record.kind,
                record.start_line,
                record.end_line,
                record.definition_text,
                record.underlying_type,
                record.target_type,
                1 if record.is_function_pointer else 0,
                record.attached_comments,
            ),
        )
        return int(cursor.lastrowid)

    def insert_type_field(self, type_definition_id: int, record: TypeFieldRecord) -> None:
        self.conn.execute(
            """
            INSERT INTO type_fields(type_definition_id, field_name, field_type, line, is_function_pointer)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                type_definition_id,
                record.field_name,
                record.field_type,
                record.line,
                1 if record.is_function_pointer else 0,
            ),
        )

    def insert_global_symbol_ref(
        self,
        file_id: int,
        function_id: int,
        global_definition_id: int,
        symbol_name: str,
        role: str,
        line: int,
        access_path: str,
        via_symbol: str | None,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO global_symbol_refs(
                file_id, function_id, global_definition_id, symbol_name, role, line, access_path, via_symbol
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (file_id, function_id, global_definition_id, symbol_name, role, line, access_path, via_symbol),
        )

    def commit(self) -> None:
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
