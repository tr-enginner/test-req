from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass
from typing import Iterable

import sqlite3

from app.config import MAX_FUNCTIONS_PER_BLOCK, MAX_TOTAL_LINES_PER_BLOCK


@dataclass(slots=True)
class FunctionNode:
    id: int
    file_id: int
    path: str
    name: str
    start_line: int
    end_line: int
    linkage: str
    signature_text: str
    body_text: str

    @property
    def line_span(self) -> int:
        return max(0, self.end_line - self.start_line + 1)


@dataclass(slots=True)
class ContinuationCandidate:
    function_id: int
    function_name: str
    path: str
    linkage: str


@dataclass(slots=True)
class PathBlock:
    block_kind: str
    block_id: str
    root_function_id: int | None
    root_function_name: str
    coverage_note: str | None
    path_function_ids: list[int]
    path_signature: str
    depth: int
    total_functions: int
    total_lines: int
    truncated: bool
    truncation_reason: str | None
    continuation_candidates: list[ContinuationCandidate]
    functions: list[FunctionNode]
    rendered_block: str

    def to_dict(self) -> dict:
        result = asdict(self)
        result["continuation_candidates"] = [asdict(candidate) for candidate in self.continuation_candidates]
        result["functions"] = [asdict(node) for node in self.functions]
        return result


def list_root_functions(conn: sqlite3.Connection) -> list[dict]:
    functions = load_functions(conn)
    incoming = load_incoming_counts(conn)
    roots = [node for node in functions.values() if incoming.get(node.id, 0) == 0]
    roots.sort(key=lambda node: (node.path, node.start_line, node.name))
    return [
        {
            "function_id": node.id,
            "function_name": node.name,
            "path": node.path,
            "linkage": node.linkage,
            "start_line": node.start_line,
            "end_line": node.end_line,
        }
        for node in roots
    ]


def generate_path_blocks(
    conn: sqlite3.Connection,
    *,
    max_functions: int | None = MAX_FUNCTIONS_PER_BLOCK,
    max_total_lines: int = MAX_TOTAL_LINES_PER_BLOCK,
) -> list[PathBlock]:
    return generate_blocks(
        conn,
        strategy="path",
        max_functions=max_functions,
        max_total_lines=max_total_lines,
    )


def generate_blocks(
    conn: sqlite3.Connection,
    *,
    strategy: str = "path",
    max_functions: int | None = MAX_FUNCTIONS_PER_BLOCK,
    max_total_lines: int = MAX_TOTAL_LINES_PER_BLOCK,
) -> list[PathBlock]:
    if strategy == "path":
        return generate_path_strategy_blocks(
            conn,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        )
    if strategy == "local_subgraph":
        return generate_local_subgraph_strategy_blocks(
            conn,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        )
    raise ValueError(f"unknown slicing strategy: {strategy}")


def generate_path_strategy_blocks(
    conn: sqlite3.Connection,
    *,
    max_functions: int | None = MAX_FUNCTIONS_PER_BLOCK,
    max_total_lines: int = MAX_TOTAL_LINES_PER_BLOCK,
) -> list[PathBlock]:
    functions = load_functions(conn)
    if not functions:
        return []

    outgoing = load_outgoing_edges(conn)
    incoming = load_incoming_counts(conn)
    root_ids = sorted(
        (node.id for node in functions.values() if incoming.get(node.id, 0) == 0),
        key=lambda function_id: (functions[function_id].path, functions[function_id].start_line, functions[function_id].name),
    )

    path_blocks: list[PathBlock] = []
    for current_root_id in root_ids:
        _walk_paths(
            current_root_id=current_root_id,
            functions=functions,
            outgoing=outgoing,
            path=[],
            visited=set(),
            total_lines=0,
            blocks=path_blocks,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        )

    covered_function_ids = {function_id for block in path_blocks for function_id in block.path_function_ids}
    other_blocks = generate_other_blocks(
        functions=functions,
        covered_function_ids=covered_function_ids,
        max_functions=max_functions,
        max_total_lines=max_total_lines,
    )
    return [*path_blocks, *other_blocks]


def generate_local_subgraph_strategy_blocks(
    conn: sqlite3.Connection,
    *,
    max_functions: int | None = MAX_FUNCTIONS_PER_BLOCK,
    max_total_lines: int = MAX_TOTAL_LINES_PER_BLOCK,
) -> list[PathBlock]:
    functions = load_functions(conn)
    if not functions:
        return []

    outgoing = load_outgoing_edges(conn)
    incoming = load_incoming_counts(conn)
    seed_queue = sorted(
        (node.id for node in functions.values() if incoming.get(node.id, 0) == 0),
        key=lambda function_id: _function_sort_key(functions[function_id]),
    )
    queued = set(seed_queue)
    covered_function_ids: set[int] = set()
    blocks: list[PathBlock] = []

    while seed_queue:
        seed_id = seed_queue.pop(0)
        queued.discard(seed_id)
        if seed_id in covered_function_ids:
            continue

        block_ids, boundary_ids = grow_local_subgraph_block(
            seed_id=seed_id,
            functions=functions,
            outgoing=outgoing,
            covered_function_ids=covered_function_ids,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        )
        if block_ids:
            blocks.append(
                build_local_subgraph_block(
                    root_function_id=seed_id,
                    function_ids=block_ids,
                    boundary_ids=boundary_ids,
                    functions=functions,
                )
            )
            covered_function_ids.update(block_ids)

        for boundary_id in boundary_ids:
            if boundary_id not in covered_function_ids and boundary_id not in queued:
                seed_queue.append(boundary_id)
                queued.add(boundary_id)

    remaining_seed_ids = [
        node.id
        for node in sorted(functions.values(), key=_function_sort_key)
        if node.id not in covered_function_ids
    ]
    for seed_id in remaining_seed_ids:
        if seed_id in covered_function_ids:
            continue
        block_ids, boundary_ids = grow_local_subgraph_block(
            seed_id=seed_id,
            functions=functions,
            outgoing=outgoing,
            covered_function_ids=covered_function_ids,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        )
        if not block_ids:
            continue
        blocks.append(
            build_local_subgraph_block(
                root_function_id=seed_id,
                function_ids=block_ids,
                boundary_ids=boundary_ids,
                functions=functions,
            )
        )
        covered_function_ids.update(block_ids)

    return blocks


def grow_local_subgraph_block(
    *,
    seed_id: int,
    functions: dict[int, FunctionNode],
    outgoing: dict[int, list[int]],
    covered_function_ids: set[int],
    max_functions: int | None,
    max_total_lines: int,
) -> tuple[list[int], list[int]]:
    block_ids: list[int] = []
    block_set: set[int] = set()
    boundary_ids: list[int] = []
    boundary_set: set[int] = set()
    expansion_queue: list[int] = []
    total_lines = 0

    def add_boundary(function_id: int) -> None:
        if function_id in block_set or function_id in covered_function_ids or function_id in boundary_set:
            return
        boundary_ids.append(function_id)
        boundary_set.add(function_id)

    def admit(function_id: int) -> bool:
        nonlocal total_lines
        if function_id in block_set or function_id in covered_function_ids:
            return False
        candidate = functions[function_id]
        if not can_admit_function(
            candidate,
            current_function_count=len(block_ids),
            current_total_lines=total_lines,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        ):
            return False
        block_ids.append(function_id)
        block_set.add(function_id)
        total_lines += candidate.line_span
        expansion_queue.append(function_id)
        return True

    if not admit(seed_id):
        add_boundary(seed_id)
        return [], boundary_ids

    while expansion_queue:
        current_id = expansion_queue.pop(0)
        for callee_id in outgoing.get(current_id, []):
            if callee_id in block_set or callee_id in covered_function_ids:
                continue
            if not admit(callee_id):
                add_boundary(callee_id)

    return block_ids, boundary_ids


def can_admit_function(
    candidate: FunctionNode,
    *,
    current_function_count: int,
    current_total_lines: int,
    max_functions: int | None,
    max_total_lines: int,
) -> bool:
    # A function is the indivisible unit of a local subgraph block. Always
    # admit its seed so an oversized function becomes one block instead of an
    # endlessly requeued boundary.
    if current_function_count == 0:
        return True
    if max_functions is not None and current_function_count + 1 > max_functions:
        return False
    return (
        current_total_lines + candidate.line_span <= max_total_lines
    )


def persist_path_blocks(
    conn: sqlite3.Connection,
    *,
    max_functions: int | None = MAX_FUNCTIONS_PER_BLOCK,
    max_total_lines: int = MAX_TOTAL_LINES_PER_BLOCK,
) -> list[PathBlock]:
    return persist_blocks(
        conn,
        strategy="path",
        max_functions=max_functions,
        max_total_lines=max_total_lines,
    )


def persist_blocks(
    conn: sqlite3.Connection,
    *,
    strategy: str = "path",
    max_functions: int | None = MAX_FUNCTIONS_PER_BLOCK,
    max_total_lines: int = MAX_TOTAL_LINES_PER_BLOCK,
) -> list[PathBlock]:
    ensure_path_blocks_schema(conn)
    blocks = generate_blocks(
        conn,
        strategy=strategy,
        max_functions=max_functions,
        max_total_lines=max_total_lines,
    )
    conn.execute(
        """
        DELETE FROM path_block_continuations
        WHERE block_id IN (SELECT block_id FROM path_blocks WHERE slicing_strategy = ?)
        """,
        (strategy,),
    )
    conn.execute(
        """
        DELETE FROM path_block_functions
        WHERE block_id IN (SELECT block_id FROM path_blocks WHERE slicing_strategy = ?)
        """,
        (strategy,),
    )
    conn.execute("DELETE FROM path_blocks WHERE slicing_strategy = ?", (strategy,))
    for block in blocks:
        conn.execute(
            """
            INSERT INTO path_blocks(
                block_id, block_kind, slicing_strategy, root_function_id, root_function_name, path_signature, depth, total_functions,
                total_lines, truncated, truncation_reason, max_functions, max_total_lines
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                block.block_id,
                block.block_kind,
                strategy,
                block.root_function_id,
                block.root_function_name,
                block.path_signature,
                block.depth,
                block.total_functions,
                block.total_lines,
                1 if block.truncated else 0,
                block.truncation_reason,
                _persisted_max_functions(max_functions),
                max_total_lines,
            ),
        )
        for ordinal, function_id in enumerate(block.path_function_ids):
            conn.execute(
                """
                INSERT INTO path_block_functions(block_id, ordinal, function_id)
                VALUES (?, ?, ?)
                """,
                (block.block_id, ordinal, function_id),
            )
        for ordinal, candidate in enumerate(block.continuation_candidates):
            conn.execute(
                """
                INSERT INTO path_block_continuations(
                    block_id, ordinal, function_id, function_name, path, linkage
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    block.block_id,
                    ordinal,
                    candidate.function_id,
                    candidate.function_name,
                    candidate.path,
                    candidate.linkage,
                ),
            )
    conn.commit()
    return blocks


def list_persisted_blocks(conn: sqlite3.Connection, *, slicing_strategy: str | None = None) -> list[dict]:
    ensure_path_blocks_schema(conn)
    params: tuple[object, ...] = ()
    where_clause = ""
    if slicing_strategy is not None:
        where_clause = "WHERE slicing_strategy = ?"
        params = (slicing_strategy,)
    rows = conn.execute(
        f"""
        SELECT block_id, root_function_id, root_function_name, path_signature, depth, total_functions,
               total_lines, truncated, truncation_reason, max_functions, max_total_lines, block_kind, slicing_strategy
        FROM path_blocks
        {where_clause}
        ORDER BY slicing_strategy, block_kind, root_function_name, block_id
        """,
        params,
    ).fetchall()
    return [_normalize_persisted_block_summary(dict(row)) for row in rows]


def get_persisted_block(
    conn: sqlite3.Connection,
    block_id: str,
    *,
    slicing_strategy: str | None = None,
) -> dict | None:
    ensure_path_blocks_schema(conn)
    params: tuple[object, ...]
    strategy_clause = ""
    if slicing_strategy is None:
        params = (block_id,)
    else:
        strategy_clause = "AND slicing_strategy = ?"
        params = (block_id, slicing_strategy)
    row = conn.execute(
        f"""
        SELECT block_id, root_function_id, root_function_name, path_signature, depth, total_functions,
               total_lines, truncated, truncation_reason, max_functions, max_total_lines, block_kind, slicing_strategy
        FROM path_blocks
        WHERE block_id = ?
        {strategy_clause}
        """,
        params,
    ).fetchone()
    if row is None:
        return None

    functions = conn.execute(
        """
        SELECT pbf.ordinal, f.id, fi.path, f.name, f.start_line, f.end_line, f.linkage, f.signature_text, f.body_text
        FROM path_block_functions pbf
        JOIN functions f ON f.id = pbf.function_id
        JOIN files fi ON fi.id = f.file_id
        WHERE pbf.block_id = ?
        ORDER BY pbf.ordinal
        """,
        (block_id,),
    ).fetchall()
    continuations = conn.execute(
        """
        SELECT ordinal, function_id, function_name, path, linkage
        FROM path_block_continuations
        WHERE block_id = ?
        ORDER BY ordinal
        """,
        (block_id,),
    ).fetchall()

    result = dict(row)
    result = _normalize_persisted_block_summary(result)
    result["truncated"] = bool(result["truncated"])
    result["coverage_note"] = (
        "functions not included in primary path blocks" if result["block_kind"] == "others" else None
    )
    result["path_function_ids"] = [int(item["id"]) for item in functions]
    result["functions"] = [
        {
            "id": int(item["id"]),
            "path": str(item["path"]),
            "name": str(item["name"]),
            "start_line": int(item["start_line"]),
            "end_line": int(item["end_line"]),
            "linkage": str(item["linkage"]),
            "signature_text": str(item["signature_text"]),
            "body_text": str(item["body_text"]),
        }
        for item in functions
    ]
    result["continuation_candidates"] = [
        {
            "function_id": int(item["function_id"]),
            "function_name": str(item["function_name"]),
            "path": str(item["path"]),
            "linkage": str(item["linkage"]),
        }
        for item in continuations
    ]
    result["rendered_block"] = render_block_text(
        block_kind=str(result["block_kind"]),
        root_function_name=str(result["root_function_name"]),
        coverage_note=result["coverage_note"],
        path_signature=str(result["path_signature"]),
        truncated=bool(result["truncated"]),
        truncation_reason=result["truncation_reason"],
        functions=result["functions"],
    )
    return result


def ensure_path_blocks_schema(conn: sqlite3.Connection) -> None:
    rows = conn.execute("PRAGMA table_info(path_blocks)").fetchall()
    if not rows:
        return
    column_names = {str(row["name"] if isinstance(row, sqlite3.Row) else row[1]) for row in rows}
    if "slicing_strategy" not in column_names:
        conn.execute("ALTER TABLE path_blocks ADD COLUMN slicing_strategy TEXT NOT NULL DEFAULT 'path'")
        conn.commit()


def _persisted_max_functions(max_functions: int | None) -> int:
    return int(max_functions) if max_functions is not None else 0


def _normalize_persisted_block_summary(block: dict) -> dict:
    if int(block["max_functions"]) == 0:
        block["max_functions"] = None
    return block


def get_path_block(
    conn: sqlite3.Connection,
    block_id: str,
    *,
    max_functions: int | None = MAX_FUNCTIONS_PER_BLOCK,
    max_total_lines: int = MAX_TOTAL_LINES_PER_BLOCK,
) -> PathBlock | None:
    for block in generate_blocks(
        conn,
        strategy="path",
        max_functions=max_functions,
        max_total_lines=max_total_lines,
    ):
        if block.block_id == block_id:
            return block
    return None


def _walk_paths(
    *,
    current_root_id: int,
    functions: dict[int, FunctionNode],
    outgoing: dict[int, list[int]],
    path: list[int],
    visited: set[int],
    total_lines: int,
    blocks: list[PathBlock],
    max_functions: int | None,
    max_total_lines: int,
) -> None:
    node = functions[current_root_id]
    would_path = [*path, current_root_id]
    would_total_lines = total_lines + node.line_span

    function_limit_exceeded = max_functions is not None and len(would_path) > max_functions
    line_limit_exceeded = would_total_lines > max_total_lines
    if path and (function_limit_exceeded or line_limit_exceeded):
        blocks.append(
            build_block(
                block_kind="path",
                root_function_id=path[0],
                path_ids=path,
                truncation_reason="max_functions" if function_limit_exceeded else "max_total_lines",
                continuation_ids=[current_root_id],
                functions=functions,
            )
        )
        return

    next_path = would_path
    next_visited = set(visited)
    next_visited.add(current_root_id)
    next_total_lines = would_total_lines

    direct_children = outgoing.get(current_root_id, [])
    expandable_children: list[int] = []
    repeated_children: list[int] = []
    for child_id in direct_children:
        if child_id in next_visited:
            repeated_children.append(child_id)
        else:
            expandable_children.append(child_id)

    truncation_reason: str | None = None
    if max_functions is not None and len(next_path) >= max_functions:
        truncation_reason = "max_functions"
    elif next_total_lines >= max_total_lines:
        truncation_reason = "max_total_lines"
    elif not expandable_children and repeated_children:
        truncation_reason = "repeated_function"

    if truncation_reason is not None or not expandable_children:
        blocks.append(
            build_block(
                block_kind="path",
                root_function_id=next_path[0],
                path_ids=next_path,
                truncation_reason=truncation_reason,
                continuation_ids=direct_children,
                functions=functions,
            )
        )
        return

    for child_id in expandable_children:
        _walk_paths(
            current_root_id=child_id,
            functions=functions,
            outgoing=outgoing,
            path=next_path,
            visited=next_visited,
            total_lines=next_total_lines,
            blocks=blocks,
            max_functions=max_functions,
            max_total_lines=max_total_lines,
        )


def build_block(
    *,
    block_kind: str,
    root_function_id: int,
    path_ids: list[int],
    truncation_reason: str | None,
    continuation_ids: Iterable[int],
    functions: dict[int, FunctionNode],
) -> PathBlock:
    path_signature = "->".join(str(function_id) for function_id in path_ids)
    block_id = hashlib.sha1(path_signature.encode("ascii")).hexdigest()[:12]
    nodes = [functions[function_id] for function_id in path_ids]
    continuation_candidates = build_continuation_candidates(
        continuation_ids=continuation_ids,
        path_ids=path_ids,
        functions=functions,
    )
    return PathBlock(
        block_kind=block_kind,
        block_id=block_id,
        root_function_id=root_function_id,
        root_function_name=functions[root_function_id].name,
        coverage_note=None,
        path_function_ids=path_ids,
        path_signature=path_signature,
        depth=max(0, len(path_ids) - 1),
        total_functions=len(path_ids),
        total_lines=sum(node.line_span for node in nodes),
        truncated=truncation_reason is not None,
        truncation_reason=truncation_reason,
        continuation_candidates=continuation_candidates,
        functions=nodes,
        rendered_block=render_block_text(
            block_kind=block_kind,
            root_function_name=functions[root_function_id].name,
            coverage_note=None,
            path_signature=path_signature,
            truncated=truncation_reason is not None,
            truncation_reason=truncation_reason,
            functions=[asdict(node) for node in nodes],
        ),
    )


def build_local_subgraph_block(
    *,
    root_function_id: int,
    function_ids: list[int],
    boundary_ids: Iterable[int],
    functions: dict[int, FunctionNode],
) -> PathBlock:
    path_signature = f"local_subgraph:{root_function_id}:{','.join(str(function_id) for function_id in function_ids)}"
    block_id = hashlib.sha1(path_signature.encode("ascii")).hexdigest()[:12]
    nodes = [functions[function_id] for function_id in function_ids]
    continuation_candidates = build_ordered_continuation_candidates(
        continuation_ids=boundary_ids,
        block_ids=function_ids,
        functions=functions,
    )
    return PathBlock(
        block_kind="local_subgraph",
        block_id=block_id,
        root_function_id=root_function_id,
        root_function_name=functions[root_function_id].name,
        coverage_note=None,
        path_function_ids=function_ids,
        path_signature=path_signature,
        depth=max(0, len(function_ids) - 1),
        total_functions=len(function_ids),
        total_lines=sum(node.line_span for node in nodes),
        truncated=bool(continuation_candidates),
        truncation_reason="boundary" if continuation_candidates else None,
        continuation_candidates=continuation_candidates,
        functions=nodes,
        rendered_block=render_block_text(
            block_kind="local_subgraph",
            root_function_name=functions[root_function_id].name,
            coverage_note=None,
            path_signature=path_signature,
            truncated=bool(continuation_candidates),
            truncation_reason="boundary" if continuation_candidates else None,
            functions=[asdict(node) for node in nodes],
        ),
    )


def build_continuation_candidates(
    *,
    continuation_ids: Iterable[int],
    path_ids: list[int],
    functions: dict[int, FunctionNode],
) -> list[ContinuationCandidate]:
    seen: set[int] = set()
    path_set = set(path_ids)
    candidates: list[ContinuationCandidate] = []
    for function_id in continuation_ids:
        if function_id in path_set or function_id in seen:
            continue
        seen.add(function_id)
        node = functions[function_id]
        candidates.append(
            ContinuationCandidate(
                function_id=node.id,
                function_name=node.name,
                path=node.path,
                linkage=node.linkage,
            )
        )
    candidates.sort(key=lambda item: (item.path, item.function_name, item.function_id))
    return candidates


def build_ordered_continuation_candidates(
    *,
    continuation_ids: Iterable[int],
    block_ids: list[int],
    functions: dict[int, FunctionNode],
) -> list[ContinuationCandidate]:
    seen: set[int] = set()
    block_set = set(block_ids)
    candidates: list[ContinuationCandidate] = []
    for function_id in continuation_ids:
        if function_id in block_set or function_id in seen:
            continue
        seen.add(function_id)
        node = functions[function_id]
        candidates.append(
            ContinuationCandidate(
                function_id=node.id,
                function_name=node.name,
                path=node.path,
                linkage=node.linkage,
            )
        )
    return candidates


def generate_other_blocks(
    *,
    functions: dict[int, FunctionNode],
    covered_function_ids: set[int],
    max_functions: int | None,
    max_total_lines: int,
) -> list[PathBlock]:
    remaining_nodes = [
        node
        for node in sorted(functions.values(), key=lambda item: (item.path, item.start_line, item.name))
        if node.id not in covered_function_ids
    ]
    if not remaining_nodes:
        return []

    grouped: dict[str, list[FunctionNode]] = {}
    for node in remaining_nodes:
        grouped.setdefault(node.path, []).append(node)

    blocks: list[PathBlock] = []
    for path, nodes in grouped.items():
        chunk: list[FunctionNode] = []
        chunk_lines = 0
        chunk_index = 0
        for node in nodes:
            next_count = len(chunk) + 1
            next_lines = chunk_lines + node.line_span
            function_limit_exceeded = max_functions is not None and next_count > max_functions
            if chunk and (function_limit_exceeded or next_lines > max_total_lines):
                blocks.append(build_other_block(path=path, nodes=chunk, chunk_index=chunk_index))
                chunk_index += 1
                chunk = []
                chunk_lines = 0
            chunk.append(node)
            chunk_lines += node.line_span
        if chunk:
            blocks.append(build_other_block(path=path, nodes=chunk, chunk_index=chunk_index))
    return blocks


def build_other_block(*, path: str, nodes: list[FunctionNode], chunk_index: int) -> PathBlock:
    path_ids = [node.id for node in nodes]
    path_signature = f"others:{path}:{chunk_index}:{','.join(str(node_id) for node_id in path_ids)}"
    block_id = hashlib.sha1(path_signature.encode("utf-8")).hexdigest()[:12]
    root_label = f"repo_others:{path}#{chunk_index}"
    return PathBlock(
        block_kind="others",
        block_id=block_id,
        root_function_id=None,
        root_function_name=root_label,
        coverage_note="functions not included in primary path blocks",
        path_function_ids=path_ids,
        path_signature=path_signature,
        depth=0,
        total_functions=len(nodes),
        total_lines=sum(node.line_span for node in nodes),
        truncated=False,
        truncation_reason=None,
        continuation_candidates=[],
        functions=nodes,
        rendered_block=render_block_text(
            block_kind="others",
            root_function_name=root_label,
            coverage_note="functions not included in primary path blocks",
            path_signature=path_signature,
            truncated=False,
            truncation_reason=None,
            functions=[asdict(node) for node in nodes],
        ),
    )


def load_functions(conn: sqlite3.Connection) -> dict[int, FunctionNode]:
    rows = conn.execute(
        """
        SELECT f.id, f.file_id, fi.path, f.name, f.start_line, f.end_line, f.linkage, f.signature_text, f.body_text
        FROM functions f
        JOIN files fi ON fi.id = f.file_id
        ORDER BY fi.path, f.start_line
        """
    ).fetchall()
    return {
        int(row["id"]): FunctionNode(
            id=int(row["id"]),
            file_id=int(row["file_id"]),
            path=str(row["path"]),
            name=str(row["name"]),
            start_line=int(row["start_line"]),
            end_line=int(row["end_line"]),
            linkage=str(row["linkage"]),
            signature_text=str(row["signature_text"]),
            body_text=str(row["body_text"]),
        )
        for row in rows
    }


def _function_sort_key(node: FunctionNode) -> tuple[str, int, str, int]:
    return (node.path, node.start_line, node.name, node.id)


def render_block_text(
    *,
    block_kind: str,
    root_function_name: str,
    coverage_note: str | None,
    path_signature: str,
    truncated: bool,
    truncation_reason: str | None,
    functions: list[dict],
) -> str:
    header = [f"/* BLOCK kind={block_kind} root={root_function_name} path={path_signature} */"]
    if coverage_note:
        header.append(f"/* {coverage_note} */")
    if truncated:
        header.append(f"/* truncated={str(truncated).lower()} reason={truncation_reason} */")

    sections: list[str] = ["\n".join(header)]
    for function in functions:
        signature_text = function["signature_text"].strip()
        body_text = function["body_text"].strip()
        sections.append(
            "\n".join(
                [
                    f"//// file: {function['path']}",
                    f"//// function: {function['name']} [{function['start_line']}-{function['end_line']}]",
                    f"{signature_text} {body_text}",
                ]
            )
        )
    return "\n\n".join(sections)


def load_outgoing_edges(conn: sqlite3.Connection) -> dict[int, list[int]]:
    rows = conn.execute(
        """
        SELECT caller_function_id, resolved_function_id
        FROM calls
        WHERE resolved_function_id IS NOT NULL
        ORDER BY caller_function_id, line, id
        """
    ).fetchall()
    outgoing: dict[int, list[int]] = {}
    for row in rows:
        caller = int(row["caller_function_id"])
        callee = int(row["resolved_function_id"])
        if caller == callee:
            continue
        bucket = outgoing.setdefault(caller, [])
        if callee not in bucket:
            bucket.append(callee)
    return outgoing


def load_incoming_counts(conn: sqlite3.Connection) -> dict[int, int]:
    rows = conn.execute(
        """
        SELECT resolved_function_id AS function_id, COUNT(*) AS caller_count
        FROM calls
        WHERE resolved_function_id IS NOT NULL AND caller_function_id != resolved_function_id
        GROUP BY resolved_function_id
        """
    ).fetchall()
    return {int(row["function_id"]): int(row["caller_count"]) for row in rows}
