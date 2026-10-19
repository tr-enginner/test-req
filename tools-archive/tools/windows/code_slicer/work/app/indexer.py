from __future__ import annotations

from dataclasses import dataclass

from app.extractors import extract_file
from app.models import AliasHintRecord, FieldAccessRecord, GlobalDefinitionRecord, NameRefRecord
from app.parser import build_parser, parse_source
from app.scanner import file_sha1, iter_source_files, read_source_text
from app.storage import SQLiteStore


@dataclass(slots=True)
class IndexStats:
    files_indexed: int = 0
    functions_indexed: int = 0
    calls_indexed: int = 0
    global_definitions_indexed: int = 0
    macro_definitions_indexed: int = 0
    type_definitions_indexed: int = 0
    global_symbol_refs_indexed: int = 0


@dataclass(slots=True)
class FunctionDef:
    function_id: int
    file_path: str
    name: str
    linkage: str
    start_line: int


def build_index(repo_path: str, db_path: str) -> IndexStats:
    store = SQLiteStore(db_path)
    store.initialize()
    store.reset()
    parser = build_parser()
    stats = IndexStats()

    file_local_functions: dict[tuple[str, str], list[FunctionDef]] = {}
    global_functions: dict[str, list[FunctionDef]] = {}
    function_ids_by_file_and_name: dict[tuple[str, str], int] = {}
    global_defs: list[tuple[int, GlobalDefinitionRecord]] = []
    deferred_calls: list[tuple[int, int, object]] = []
    deferred_name_refs: list[tuple[int, int, NameRefRecord]] = []
    deferred_alias_hints: list[tuple[int, int, AliasHintRecord]] = []
    deferred_field_accesses: list[tuple[int, int, FieldAccessRecord]] = []
    type_def_ids_by_name: dict[tuple[str, str], list[int]] = {}

    for file_path in iter_source_files(repo_path):
        stats.files_indexed += 1
        source_text = read_source_text(file_path)
        parsed = parse_source(parser, source_text)
        extraction = extract_file(str(file_path), parsed.tree.root_node, parsed.source_bytes)

        file_id = store.upsert_file(str(file_path), file_sha1(file_path))

        for function in extraction.functions:
            function_id = store.insert_function(file_id, function)
            function.id = function_id
            function_ids_by_file_and_name[(function.file_path, function.name)] = function_id
            definition = FunctionDef(
                function_id=function_id,
                file_path=function.file_path,
                name=function.name,
                linkage=function.linkage,
                start_line=function.start_line,
            )
            if function.linkage == "static":
                file_local_functions.setdefault((function.file_path, function.name), []).append(definition)
            else:
                global_functions.setdefault(function.name, []).append(definition)
            stats.functions_indexed += 1

        for type_def in extraction.type_definitions:
            type_def_id = store.insert_type_definition(file_id, type_def)
            type_def_ids_by_name.setdefault((type_def.file_path, type_def.name), []).append(type_def_id)
            stats.type_definitions_indexed += 1

        for type_field in extraction.type_fields:
            for type_def_id in type_def_ids_by_name.get((type_field.file_path, type_field.type_name), []):
                store.insert_type_field(type_def_id, type_field)

        for global_def in extraction.global_definitions:
            global_definition_id = store.insert_global_definition(file_id, global_def)
            global_defs.append((global_definition_id, global_def))
            stats.global_definitions_indexed += 1

        for macro_def in extraction.macro_definitions:
            store.insert_macro_definition(file_id, macro_def)
            stats.macro_definitions_indexed += 1

        for call in extraction.calls:
            caller_function_id = function_ids_by_file_and_name[(call.file_path, call.caller_function_name)]
            deferred_calls.append((file_id, caller_function_id, call))

        for name_ref in extraction.name_refs:
            function_id = function_ids_by_file_and_name[(name_ref.file_path, name_ref.function_name)]
            deferred_name_refs.append((file_id, function_id, name_ref))

        for alias in extraction.alias_hints:
            function_id = function_ids_by_file_and_name[(alias.file_path, alias.function_name)]
            deferred_alias_hints.append((file_id, function_id, alias))

        for field_access in extraction.field_accesses:
            function_id = function_ids_by_file_and_name[(field_access.file_path, field_access.function_name)]
            deferred_field_accesses.append((file_id, function_id, field_access))

    stats.calls_indexed = resolve_calls(store, deferred_calls, file_local_functions, global_functions)
    resolved_name_refs = resolve_name_refs(deferred_name_refs, global_defs)
    stats.global_symbol_refs_indexed = build_global_symbol_refs(
        store, global_defs, resolved_name_refs, deferred_alias_hints, deferred_field_accesses
    )
    store.commit()
    store.close()
    return stats


def resolve_calls(
    store,
    deferred_calls,
    file_local_functions: dict[tuple[str, str], list[FunctionDef]],
    global_functions: dict[str, list[FunctionDef]],
) -> int:
    inserted = 0
    for file_id, caller_function_id, call in deferred_calls:
        if call.caller_function_name == call.callee_name and call.callee_kind == "direct":
            continue
        call.resolved_function_id = resolve_call(call, file_local_functions, global_functions)
        if call.resolved_function_id == caller_function_id:
            continue
        store.insert_call(file_id, caller_function_id, call)
        inserted += 1
    return inserted


def resolve_call(
    call, file_local_functions: dict[tuple[str, str], list[FunctionDef]], global_functions: dict[str, list[FunctionDef]]
) -> int | None:
    if call.callee_kind != "direct":
        return None

    local_candidates = file_local_functions.get((call.file_path, call.callee_name), [])
    if len(local_candidates) == 1:
        return local_candidates[0].function_id

    global_candidates = global_functions.get(call.callee_name, [])
    if len(global_candidates) == 1:
        return global_candidates[0].function_id

    return None


def resolve_name_refs(
    deferred_name_refs, global_defs
) -> list[tuple[int, int, NameRefRecord, int | None]]:
    file_globals: dict[tuple[str, str], list[tuple[int, GlobalDefinitionRecord]]] = {}
    repo_globals: dict[str, list[tuple[int, GlobalDefinitionRecord]]] = {}
    for global_definition_id, global_def in global_defs:
        file_globals.setdefault((global_def.file_path, global_def.name), []).append((global_definition_id, global_def))
        repo_globals.setdefault(global_def.name, []).append((global_definition_id, global_def))

    resolved: list[tuple[int, int, NameRefRecord, int | None]] = []
    for file_id, function_id, name_ref in deferred_name_refs:
        resolved_global_definition_id = resolve_global_definition_id(
            file_path=name_ref.file_path,
            symbol_name=name_ref.name,
            file_global_defs=file_globals,
            repo_global_defs=repo_globals,
        )
        resolved.append((file_id, function_id, name_ref, resolved_global_definition_id))
    return resolved


def build_global_symbol_refs(store, global_defs, resolved_name_refs, alias_hints, field_accesses) -> int:
    global_by_id = {global_definition_id: global_def for global_definition_id, global_def in global_defs}
    file_global_defs: dict[tuple[str, str], list[tuple[int, GlobalDefinitionRecord]]] = {}
    repo_global_defs: dict[str, list[tuple[int, GlobalDefinitionRecord]]] = {}
    for global_definition_id, global_def in global_defs:
        file_global_defs.setdefault((global_def.file_path, global_def.name), []).append((global_definition_id, global_def))
        repo_global_defs.setdefault(global_def.name, []).append((global_definition_id, global_def))

    alias_map = build_alias_map(alias_hints, resolved_name_refs, global_by_id, file_global_defs, repo_global_defs)

    inserted = 0
    for file_id, function_id, name_ref, global_definition_id in resolved_name_refs:
        if global_definition_id is None:
            continue
        global_def = global_by_id.get(global_definition_id)
        if global_def is None:
            continue
        store.insert_global_symbol_ref(
            file_id=file_id,
            function_id=function_id,
            global_definition_id=global_definition_id,
            symbol_name=global_def.name,
            role=normalize_global_role(name_ref.role),
            line=name_ref.line,
            access_path=global_def.name,
            via_symbol=None,
        )
        inserted += 1

    for file_id, function_id, access in field_accesses:
        resolved = resolve_global_for_field_access(access, alias_map, file_global_defs, repo_global_defs)
        if resolved is None:
            continue
        symbol_id, symbol_name, via_symbol = resolved
        store.insert_global_symbol_ref(
            file_id=file_id,
            function_id=function_id,
            global_definition_id=symbol_id,
            symbol_name=symbol_name,
            role=normalize_global_role(access.role),
            line=access.line,
            access_path=f"{access.base_name}{access.access_kind}{access.field_name}",
            via_symbol=via_symbol,
        )
        inserted += 1

    return inserted


def build_alias_map(alias_hints, resolved_name_refs, global_by_id, file_global_defs, repo_global_defs):
    aliases: dict[tuple[str, str, str], list[tuple[int, str, int, str]]] = {}
    local_resolutions: dict[tuple[str, str, str, int], int] = {}
    for _file_id, function_id, name_ref, global_definition_id in resolved_name_refs:
        if function_id is None or global_definition_id is None:
            continue
        local_resolutions[(name_ref.file_path, name_ref.function_name, name_ref.name, name_ref.line)] = global_definition_id

    sorted_hints = sorted(alias_hints, key=lambda item: item[2].line)
    for _file_id, _function_id, hint in sorted_hints:
        source_global = resolve_alias_source(
            hint,
            aliases,
            local_resolutions,
            global_by_id,
            file_global_defs,
            repo_global_defs,
        )
        if source_global is None:
            continue
        aliases.setdefault((hint.file_path, hint.function_name, hint.target_name), []).append(
            (hint.line, hint.scope_key, source_global[0], source_global[1])
        )
    return aliases


def resolve_alias_source(hint, aliases, local_resolutions, global_by_id, file_global_defs, repo_global_defs):
    direct_global = resolve_global_definition(hint.file_path, hint.source_name, file_global_defs, repo_global_defs)
    if direct_global is not None:
        global_definition_id, global_def = direct_global
        return global_definition_id, global_def.name

    resolved_local = local_resolutions.get((hint.file_path, hint.function_name, hint.source_name, hint.line))
    if resolved_local is not None:
        global_def = global_by_id.get(resolved_local)
        if global_def is not None:
            return resolved_local, global_def.name

    alias_candidates = aliases.get((hint.file_path, hint.function_name, hint.source_name), [])
    for line, scope_key, symbol_id, symbol_name in reversed(alias_candidates):
        if line <= hint.line and scope_matches(hint.scope_key, scope_key):
            return symbol_id, symbol_name
    return None


def resolve_global_for_field_access(access, aliases, file_global_defs, repo_global_defs):
    direct_global = resolve_global_definition(access.file_path, access.base_name, file_global_defs, repo_global_defs)
    if direct_global is not None:
        symbol_id, symbol = direct_global
        return symbol_id, symbol.name, None

    alias_candidates = aliases.get((access.file_path, access.function_name, access.base_name), [])
    for line, scope_key, symbol_id, symbol_name in reversed(alias_candidates):
        if line <= access.line and scope_matches(access.scope_key, scope_key):
            return symbol_id, symbol_name, access.base_name
    return None


def resolve_global_definition(file_path: str, symbol_name: str, file_global_defs, repo_global_defs):
    same_file_defs = file_global_defs.get((file_path, symbol_name), [])
    unique_same_file = unique_global_definition(same_file_defs)
    if unique_same_file is not None:
        return unique_same_file

    repo_defs = repo_global_defs.get(symbol_name, [])
    return unique_global_definition(repo_defs)


def unique_global_definition(candidates):
    unique_ids = {global_definition_id for global_definition_id, _global_def in candidates}
    if len(unique_ids) != 1:
        return None
    return candidates[0]


def resolve_global_definition_id(file_path: str, symbol_name: str, file_global_defs, repo_global_defs) -> int | None:
    resolved = resolve_global_definition(file_path, symbol_name, file_global_defs, repo_global_defs)
    if resolved is None:
        return None
    return resolved[0]


def normalize_global_role(role: str) -> str:
    return "write" if role == "write" else "read"
def scope_matches(use_scope: str, def_scope: str) -> bool:
    return use_scope.startswith(def_scope)
