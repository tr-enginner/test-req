from __future__ import annotations

from dataclasses import dataclass, field

from tree_sitter import Node

from app.models import (
    AliasHintRecord,
    CallRecord,
    FieldAccessRecord,
    FunctionRecord,
    GlobalDefinitionRecord,
    MacroDefinitionRecord,
    NameRefRecord,
    TypeDefinitionRecord,
    TypeFieldRecord,
)
from app.parser import end_line_no, line_no, node_text


BLOCK_SCOPE_TYPES = {
    "compound_statement",
    "if_statement",
    "for_statement",
    "while_statement",
    "switch_statement",
    "case_statement",
}

TYPE_CONTAINER_TYPES = {"type_definition", "struct_specifier", "enum_specifier"}
DECLARATOR_NODE_TYPES = {
    "init_declarator",
    "pointer_declarator",
    "array_declarator",
    "function_declarator",
    "parenthesized_declarator",
    "identifier",
    "type_identifier",
    "field_identifier",
    "ERROR",
}
MEMORY_QUALIFIER_IDENTIFIERS = {
    "xdata",
    "idata",
    "pdata",
    "data",
    "bdata",
    "code",
}
PREPROCESSOR_CONTAINER_TYPES = {
    "preproc_if",
    "preproc_ifdef",
    "preproc_else",
    "preproc_elif",
}
MACRO_NODE_TYPES = {"preproc_def", "preproc_function_def"}


@dataclass(slots=True)
class ScopeContext:
    function_name: str
    scope_key: str
    local_names: tuple[frozenset[str], ...]


@dataclass(slots=True)
class FileExtraction:
    functions: list[FunctionRecord] = field(default_factory=list)
    global_definitions: list[GlobalDefinitionRecord] = field(default_factory=list)
    macro_definitions: list[MacroDefinitionRecord] = field(default_factory=list)
    name_refs: list[NameRefRecord] = field(default_factory=list)
    calls: list[CallRecord] = field(default_factory=list)
    type_definitions: list[TypeDefinitionRecord] = field(default_factory=list)
    type_fields: list[TypeFieldRecord] = field(default_factory=list)
    alias_hints: list[AliasHintRecord] = field(default_factory=list)
    field_accesses: list[FieldAccessRecord] = field(default_factory=list)


def extract_file(path: str, root: Node, source_bytes: bytes) -> FileExtraction:
    result = FileExtraction()
    for child in iter_indexable_top_level_nodes(root):
        if child.type == "function_definition":
            result.functions.append(extract_function(path, child, source_bytes, result))
        elif child.type == "declaration":
            global_def = extract_global_definition(path, child, source_bytes)
            if global_def is not None:
                result.global_definitions.append(global_def)
        elif child.type in MACRO_NODE_TYPES:
            macro_def = extract_macro_definition(path, child, source_bytes)
            if macro_def is not None:
                result.macro_definitions.append(macro_def)
        if child.type in TYPE_CONTAINER_TYPES:
            extract_type_container(path, child, source_bytes, result)
    attach_leading_comments(result, source_bytes.decode("utf-8", errors="ignore"))
    return result


def iter_indexable_top_level_nodes(root: Node):
    for child in root.children:
        if child.type in PREPROCESSOR_CONTAINER_TYPES:
            yield from iter_indexable_top_level_nodes(child)
        else:
            yield child


def extract_macro_definition(path: str, node: Node, source_bytes: bytes) -> MacroDefinitionRecord | None:
    name_node = next((child for child in node.children if child.type == "identifier"), None)
    if name_node is None:
        return None
    params_node = next((child for child in node.children if child.type == "preproc_params"), None)
    replacement_node = next((child for child in node.children if child.type == "preproc_arg"), None)
    parameters = tuple(
        node_text(source_bytes, child).strip()
        for child in params_node.children
        if child.type == "identifier"
    ) if params_node is not None else ()
    return MacroDefinitionRecord(
        file_path=path,
        name=node_text(source_bytes, name_node).strip(),
        kind="function" if node.type == "preproc_function_def" else "object",
        start_line=line_no(node),
        end_line=max(line_no(node), end_line_no(node) - (1 if node.end_point[1] == 0 else 0)),
        definition_text=node_text(source_bytes, node).rstrip(),
        replacement_text=node_text(source_bytes, replacement_node).strip(),
        parameters=parameters,
    )


def extract_function(path: str, node: Node, source_bytes: bytes, result: FileExtraction) -> FunctionRecord:
    declarator = node.child_by_field_name("declarator")
    func_name = extract_declarator_name(declarator, source_bytes) or "<anonymous>"
    type_node = node.child_by_field_name("type")
    body_node = node.child_by_field_name("body")
    linkage = detect_function_linkage(node, source_bytes)
    function = FunctionRecord(
        file_path=path,
        name=func_name,
        start_line=line_no(node),
        end_line=end_line_no(node),
        return_type=node_text(source_bytes, type_node).strip(),
        signature_text=node_text(source_bytes, declarator).strip(),
        body_text=node_text(source_bytes, body_node).strip(),
        ast_type=node.type,
        linkage=linkage,
    )
    function_scope_key = make_scope_key(path, func_name, node)
    param_names = extract_param_names(declarator, source_bytes)
    extract_function_body(path, func_name, body_node, source_bytes, result, function_scope_key, param_names)
    return function


def extract_param_names(
    declarator: Node | None,
    source_bytes: bytes,
) -> frozenset[str]:
    if declarator is None:
        return frozenset()
    params_node = find_descendant_of_type(declarator, "parameter_list")
    if params_node is None:
        return frozenset()
    names: list[str] = []
    for child in params_node.children:
        if child.type != "parameter_declaration":
            continue
        name = extract_declarator_name(child.child_by_field_name("declarator"), source_bytes) or "<anon_param>"
        names.append(name)
    return frozenset(names)


def extract_function_body(
    path: str,
    function_name: str,
    body_node: Node | None,
    source_bytes: bytes,
    result: FileExtraction,
    function_scope_key: str,
    param_names: frozenset[str],
) -> None:
    if body_node is None:
        return
    context = ScopeContext(function_name=function_name, scope_key=function_scope_key, local_names=(param_names,))
    visit_node(path, body_node, source_bytes, result, context)


def visit_node(path: str, node: Node, source_bytes: bytes, result: FileExtraction, context: ScopeContext) -> None:
    next_context = context
    if node.type in BLOCK_SCOPE_TYPES:
        next_context = ScopeContext(
            function_name=context.function_name,
            scope_key=extend_scope_key(context.scope_key, node),
            local_names=(*context.local_names, frozenset()),
        )

    if node.type == "declaration":
        declared_names = extract_declared_names(node, source_bytes)
        next_context = add_local_names(next_context, declared_names)
        alias_hint = extract_declaration_alias(path, context.function_name, node, source_bytes, next_context.scope_key)
        if alias_hint is not None:
            result.alias_hints.append(alias_hint)
    elif node.type == "assignment_expression":
        result.name_refs.extend(extract_assignment_name_refs(path, context, node, source_bytes))
        alias_hint = extract_assignment_alias(path, context, node, source_bytes)
        if alias_hint is not None:
            result.alias_hints.append(alias_hint)
    elif node.type == "call_expression":
        call = extract_call(path, context.function_name, node, source_bytes)
        if call is not None:
            result.calls.append(call)
    elif node.type == "field_expression":
        result.field_accesses.append(extract_field_access(path, context, node, source_bytes))
    elif node.type == "identifier" and should_record_identifier(node):
        name = node_text(source_bytes, node)
        if not is_local_name(context, name):
            result.name_refs.append(
                NameRefRecord(
                    file_path=path,
                    function_name=context.function_name,
                    name=name,
                    line=line_no(node),
                    column=node.start_point[1] + 1,
                    role="use",
                    scope_key=next_context.scope_key,
                )
            )

    for child in node.children:
        visit_node(path, child, source_bytes, result, next_context)


def extract_global_definition(path: str, node: Node, source_bytes: bytes) -> GlobalDefinitionRecord | None:
    if is_extern_declaration(node, source_bytes):
        return None
    declarator = get_primary_declarator(node, source_bytes)
    if declarator is None or is_function_prototype_declarator(declarator):
        return None
    name = extract_declarator_name(declarator, source_bytes)
    if not name:
        return None
    return GlobalDefinitionRecord(
        file_path=path,
        name=name,
        type_text=render_declared_type(node, source_bytes),
        def_line=line_no(node),
        definition_text=node_text(source_bytes, node).strip(),
        linkage="static" if is_static_declaration(node, source_bytes) else "global",
    )


def extract_declared_names(node: Node, source_bytes: bytes) -> frozenset[str]:
    names: list[str] = []
    for declarator in iter_declarators(node, source_bytes):
        name = extract_declarator_name(declarator, source_bytes)
        if name:
            names.append(name)
    return frozenset(names)


def add_local_names(context: ScopeContext, names: frozenset[str]) -> ScopeContext:
    if not names:
        return context
    local_names = list(context.local_names)
    if local_names:
        local_names[-1] = frozenset(set(local_names[-1]) | set(names))
    else:
        local_names.append(names)
    return ScopeContext(function_name=context.function_name, scope_key=context.scope_key, local_names=tuple(local_names))


def extract_assignment_name_refs(
    path: str, context: ScopeContext, node: Node, source_bytes: bytes
) -> list[NameRefRecord]:
    left = node.child_by_field_name("left")
    right = node.child_by_field_name("right")
    refs: list[NameRefRecord] = []
    for ident in find_identifier_nodes(left):
        name = node_text(source_bytes, ident)
        if is_local_name(context, name):
            continue
        refs.append(
            NameRefRecord(
                file_path=path,
                function_name=context.function_name,
                name=name,
                line=line_no(ident),
                column=ident.start_point[1] + 1,
                role="write",
                scope_key=context.scope_key,
            )
        )
    for ident in find_identifier_nodes(right):
        name = node_text(source_bytes, ident)
        if is_local_name(context, name):
            continue
        refs.append(
            NameRefRecord(
                file_path=path,
                function_name=context.function_name,
                name=name,
                line=line_no(ident),
                column=ident.start_point[1] + 1,
                role="use",
                scope_key=context.scope_key,
            )
        )
    return refs


def extract_declaration_alias(
    path: str,
    function_name: str,
    node: Node,
    source_bytes: bytes,
    scope_key: str,
) -> AliasHintRecord | None:
    declarator = node.child_by_field_name("declarator")
    if declarator is None or declarator.type != "init_declarator":
        return None
    target_node = declarator.child_by_field_name("declarator")
    value_node = declarator.child_by_field_name("value")
    target_name = extract_declarator_name(target_node, source_bytes)
    source_name = extract_alias_source_name(value_node, source_bytes)
    if not target_name or not source_name:
        return None
    return AliasHintRecord(
        file_path=path,
        function_name=function_name,
        target_name=target_name,
        source_name=source_name,
        line=line_no(declarator),
        scope_key=scope_key,
    )


def extract_assignment_alias(path: str, context: ScopeContext, node: Node, source_bytes: bytes) -> AliasHintRecord | None:
    left = node.child_by_field_name("left")
    right = node.child_by_field_name("right")
    if left is None or left.type != "identifier":
        return None
    target_name = node_text(source_bytes, left).strip()
    source_name = extract_alias_source_name(right, source_bytes)
    if not source_name:
        return None
    return AliasHintRecord(
        file_path=path,
        function_name=context.function_name,
        target_name=target_name,
        source_name=source_name,
        line=line_no(node),
        scope_key=context.scope_key,
    )


def extract_call(path: str, function_name: str, node: Node, source_bytes: bytes) -> CallRecord | None:
    function_node = node.child_by_field_name("function")
    args_node = node.child_by_field_name("arguments")
    callee_name = extract_call_target_name(function_node, source_bytes)
    if not callee_name:
        return None
    arg_texts: list[str] = []
    if args_node is not None:
        for child in args_node.children:
            if child.type in {"(", ")", ","}:
                continue
            arg_texts.append(node_text(source_bytes, child).strip())
    return CallRecord(
        file_path=path,
        caller_function_name=function_name,
        callee_name=callee_name,
        line=line_no(node),
        arg_texts=arg_texts,
        callee_kind=infer_callee_kind(function_node),
    )


def extract_field_access(path: str, context: ScopeContext, node: Node, source_bytes: bytes) -> FieldAccessRecord:
    argument_node = node.child_by_field_name("argument")
    field_node = node.child_by_field_name("field")
    access_text = node_text(source_bytes, node)
    access_kind = "->" if "->" in access_text else "."
    role = "write" if is_assignment_left(node) else "use"
    return FieldAccessRecord(
        file_path=path,
        function_name=context.function_name,
        base_name=extract_base_identifier(argument_node, source_bytes),
        field_name=node_text(source_bytes, field_node).strip(),
        access_kind=access_kind,
        role=role,
        line=line_no(node),
        column=node.start_point[1] + 1,
        scope_key=context.scope_key,
    )


def extract_type_container(path: str, node: Node, source_bytes: bytes, result: FileExtraction) -> None:
    if node.type == "type_definition":
        result.type_definitions.extend(extract_typedef_records(path, node, source_bytes))
        result.type_fields.extend(extract_typedef_field_records(path, node, source_bytes))
    elif node.type == "struct_specifier":
        struct_record = extract_named_struct_record(path, node, source_bytes)
        if struct_record is not None:
            result.type_definitions.append(struct_record)
            result.type_fields.extend(extract_struct_fields(path, struct_record.name, node, source_bytes))
    elif node.type == "enum_specifier":
        enum_record = extract_named_enum_record(path, node, source_bytes)
        if enum_record is not None:
            result.type_definitions.append(enum_record)


def extract_typedef_records(path: str, node: Node, source_bytes: bytes) -> list[TypeDefinitionRecord]:
    records: list[TypeDefinitionRecord] = []
    type_node = node.child_by_field_name("type")
    declarator = node.child_by_field_name("declarator")
    alias_name = extract_declarator_name(declarator, source_bytes)
    if type_node is None or not alias_name:
        return records

    target_type = node_text(source_bytes, type_node).strip()
    definition_text = node_text(source_bytes, node).strip()
    is_fn_ptr = is_function_pointer_declarator(declarator)
    kind = "function_pointer_typedef" if is_fn_ptr else "typedef"
    records.append(
        TypeDefinitionRecord(
            file_path=path,
            name=alias_name,
            kind=kind,
            start_line=line_no(node),
            end_line=end_line_no(node),
            definition_text=definition_text,
            underlying_type=node_text(source_bytes, type_node).strip(),
            target_type=normalize_type_target(type_node, alias_name, source_bytes),
            is_function_pointer=is_fn_ptr,
        )
    )

    if type_node.type == "struct_specifier":
        struct_record = extract_named_struct_record(path, type_node, source_bytes)
        if struct_record is not None:
            records.append(struct_record)
    elif type_node.type == "enum_specifier":
        enum_record = extract_named_enum_record(path, type_node, source_bytes)
        if enum_record is not None:
            records.append(enum_record)
    return records


def extract_typedef_field_records(path: str, node: Node, source_bytes: bytes) -> list[TypeFieldRecord]:
    type_node = node.child_by_field_name("type")
    declarator = node.child_by_field_name("declarator")
    alias_name = extract_declarator_name(declarator, source_bytes)
    if type_node is None or not alias_name or type_node.type != "struct_specifier":
        return []
    records = extract_struct_fields(path, alias_name, type_node, source_bytes)
    name_node = type_node.child_by_field_name("name")
    struct_name = node_text(source_bytes, name_node).strip()
    if struct_name:
        records.extend(extract_struct_fields(path, f"struct {struct_name}", type_node, source_bytes))
    return records


def extract_named_struct_record(path: str, node: Node, source_bytes: bytes) -> TypeDefinitionRecord | None:
    name_node = node.child_by_field_name("name")
    name = node_text(source_bytes, name_node).strip()
    if not name:
        return None
    return TypeDefinitionRecord(
        file_path=path,
        name=f"struct {name}",
        kind="struct",
        start_line=line_no(node),
        end_line=end_line_no(node),
        definition_text=node_text(source_bytes, node).strip(),
        underlying_type="struct",
        target_type=f"struct {name}",
        is_function_pointer=False,
    )


def extract_named_enum_record(path: str, node: Node, source_bytes: bytes) -> TypeDefinitionRecord | None:
    name_node = node.child_by_field_name("name")
    name = node_text(source_bytes, name_node).strip()
    if not name:
        return None
    return TypeDefinitionRecord(
        file_path=path,
        name=f"enum {name}",
        kind="enum",
        start_line=line_no(node),
        end_line=end_line_no(node),
        definition_text=node_text(source_bytes, node).strip(),
        underlying_type="enum",
        target_type=f"enum {name}",
        is_function_pointer=False,
    )


def extract_struct_fields(path: str, type_name: str, node: Node, source_bytes: bytes) -> list[TypeFieldRecord]:
    fields_node = find_descendant_of_type(node, "field_declaration_list")
    if fields_node is None:
        return []
    records: list[TypeFieldRecord] = []
    for child in fields_node.children:
        if child.type != "field_declaration":
            continue
        field_name = extract_field_declarator_name(child.child_by_field_name("declarator"), source_bytes)
        if not field_name:
            continue
        records.append(
            TypeFieldRecord(
                file_path=path,
                type_name=type_name,
                field_name=field_name,
                field_type=render_declared_type(child, source_bytes),
                line=line_no(child),
                is_function_pointer=is_function_pointer_declarator(child.child_by_field_name("declarator")),
            )
        )
    return records


def infer_callee_kind(node: Node | None) -> str:
    if node is None:
        return "unknown"
    if node.type == "identifier":
        return "direct"
    if node.type == "field_expression":
        return "field_fnptr"
    return "unknown"


def detect_function_linkage(node: Node, source_bytes: bytes) -> str:
    text = node_text(source_bytes, node)
    return "static" if "static" in text.split("{", 1)[0].split("(")[0] else "global"


def render_declared_type(node: Node, source_bytes: bytes) -> str:
    type_node = node.child_by_field_name("type")
    declarator = node.child_by_field_name("declarator")
    base = node_text(source_bytes, type_node).strip()
    if declarator is None:
        return base
    if is_function_pointer_declarator(declarator):
        return node_text(source_bytes, node).strip().rstrip(";")
    pointer_depth = count_pointer_layers(declarator)
    if pointer_depth:
        return f"{base}{' *' * pointer_depth}"
    return base


def extract_call_target_name(node: Node | None, source_bytes: bytes) -> str:
    if node is None:
        return ""
    if node.type == "identifier":
        return node_text(source_bytes, node).strip()
    if node.type == "field_expression":
        field = node.child_by_field_name("field")
        return node_text(source_bytes, field).strip()
    return node_text(source_bytes, node).strip()


def extract_declarator_name(node: Node | None, source_bytes: bytes) -> str:
    if node is None:
        return ""
    if node.type in {"identifier", "type_identifier", "field_identifier"}:
        candidate = node_text(source_bytes, node).strip()
        return "" if is_memory_qualifier_identifier(candidate) else candidate
    for child in node.children:
        name = extract_declarator_name(child, source_bytes)
        if name:
            return name
    return ""


def extract_field_declarator_name(node: Node | None, source_bytes: bytes) -> str:
    if node is None:
        return ""
    if node.type == "field_identifier":
        return node_text(source_bytes, node).strip()
    return extract_declarator_name(node, source_bytes)


def extract_alias_source_name(node: Node | None, source_bytes: bytes) -> str:
    if node is None:
        return ""
    if node.type == "identifier":
        return node_text(source_bytes, node).strip()
    if node.type == "field_expression":
        return extract_base_identifier(node.child_by_field_name("argument"), source_bytes)
    if node.type in {"cast_expression", "parenthesized_expression"}:
        for child in reversed(node.children):
            candidate = extract_alias_source_name(child, source_bytes)
            if candidate:
                return candidate
    if node.type == "pointer_expression":
        for child in node.children:
            candidate = extract_alias_source_name(child, source_bytes)
            if candidate:
                return candidate
    return ""


def extract_base_identifier(node: Node | None, source_bytes: bytes) -> str:
    if node is None:
        return ""
    if node.type == "identifier":
        return node_text(source_bytes, node).strip()
    if node.type == "field_expression":
        return extract_base_identifier(node.child_by_field_name("argument"), source_bytes)
    if node.type in {"parenthesized_expression", "cast_expression", "pointer_expression"}:
        for child in node.children:
            base = extract_base_identifier(child, source_bytes)
            if base:
                return base
    return ""


def extract_identifiers(node: Node | None, source_bytes: bytes) -> set[str]:
    names: set[str] = set()
    if node is None:
        return names
    for sub in walk(node):
        if sub.type == "identifier":
            names.add(node_text(source_bytes, sub).strip())
    return names


def find_descendant_of_type(node: Node | None, node_type: str) -> Node | None:
    if node is None:
        return None
    if node.type == node_type:
        return node
    for child in node.children:
        found = find_descendant_of_type(child, node_type)
        if found is not None:
            return found
    return None


def iter_declarators(node: Node, source_bytes: bytes):
    yielded_ids: set[int] = set()

    declarator = node.child_by_field_name("declarator")
    if declarator is not None:
        candidate = declarator.child_by_field_name("declarator") if declarator.type == "init_declarator" else declarator
        if candidate is not None and extract_declarator_name(candidate, source_bytes):
            yielded_ids.add(id(candidate))
            yield candidate

    for child in node.children:
        if child.type not in DECLARATOR_NODE_TYPES:
            continue
        if id(child) in yielded_ids:
            continue
        if extract_declarator_name(child, source_bytes):
            yielded_ids.add(id(child))
            yield child


def find_identifier_nodes(node: Node | None) -> list[Node]:
    if node is None:
        return []
    found: list[Node] = []
    for sub in walk(node):
        if sub.type == "identifier":
            found.append(sub)
    return found


def should_record_identifier(node: Node) -> bool:
    if is_declarator_identifier(node):
        return False
    if has_ancestor_type(node, "assignment_expression"):
        return False
    parent = node.parent
    if parent is None:
        return True
    return parent.type not in {
        "function_definition",
        "call_expression",
        "assignment_expression",
        "field_expression",
    }


def is_declarator_identifier(node: Node) -> bool:
    origin = node
    current = node.parent
    while current is not None:
        if current.type in {"declaration", "parameter_declaration", "field_declaration", "type_definition", "function_definition"}:
            declarator = current.child_by_field_name("declarator")
            if declarator is not None and node_is_within(origin, declarator):
                return True
            return False
        if current.type in {"compound_statement", "function_definition", "translation_unit"}:
            return False
        current = current.parent
    return False


def node_is_within(node: Node, container: Node) -> bool:
    current: Node | None = node
    while current is not None:
        if current == container:
            return True
        current = current.parent
    return False


def has_ancestor_type(node: Node, node_type: str) -> bool:
    current = node.parent
    while current is not None:
        if current.type == node_type:
            return True
        current = current.parent
    return False


def is_assignment_left(node: Node) -> bool:
    parent = node.parent
    return parent is not None and parent.type == "assignment_expression" and parent.child_by_field_name("left") == node


def is_function_pointer_declarator(node: Node | None) -> bool:
    function_declarator = find_descendant_of_type(node, "function_declarator")
    if function_declarator is None:
        return False

    current = get_inner_declarator(function_declarator)
    while current is not None:
        if current.type == "pointer_declarator":
            return True
        if current.type == "parenthesized_declarator":
            current = get_inner_declarator(current)
            continue
        break
    return False


def is_function_prototype_declarator(node: Node | None) -> bool:
    return find_descendant_of_type(node, "function_declarator") is not None and not is_function_pointer_declarator(node)


def is_extern_declaration(node: Node, source_bytes: bytes) -> bool:
    return node_text(source_bytes, node).lstrip().startswith("extern ")


def is_static_declaration(node: Node, source_bytes: bytes) -> bool:
    return node_text(source_bytes, node).lstrip().startswith("static ")


def is_local_name(context: ScopeContext, name: str) -> bool:
    return any(name in scope for scope in reversed(context.local_names))


def count_pointer_layers(node: Node | None) -> int:
    count = 0
    current = node
    while current is not None and current.type == "pointer_declarator":
        count += 1
        current = current.child_by_field_name("declarator")
    return count


def get_inner_declarator(node: Node | None) -> Node | None:
    if node is None:
        return None
    inner = node.child_by_field_name("declarator")
    if inner is not None:
        return inner
    for child in node.children:
        if child.type.endswith("_declarator") or child.type in {"identifier", "type_identifier", "field_identifier"}:
            return child
    return None


def get_primary_declarator(node: Node, source_bytes: bytes) -> Node | None:
    declarator = node.child_by_field_name("declarator")
    if declarator is not None and extract_declarator_name(declarator, source_bytes):
        return declarator
    for child in node.children:
        if child.type not in DECLARATOR_NODE_TYPES:
            continue
        if extract_declarator_name(child, source_bytes):
            return child
    return declarator


def is_memory_qualifier_identifier(name: str) -> bool:
    return name in MEMORY_QUALIFIER_IDENTIFIERS


def normalize_type_target(type_node: Node, alias_name: str, source_bytes: bytes) -> str:
    parent = type_node.parent
    if parent is not None and is_function_pointer_declarator(parent.child_by_field_name("declarator")):
        return node_text(source_bytes, parent).strip().rstrip(";")
    if type_node.type == "struct_specifier":
        name_node = type_node.child_by_field_name("name")
        name = node_text(source_bytes, name_node).strip()
        return f"struct {name}" if name else alias_name
    if type_node.type == "enum_specifier":
        name_node = type_node.child_by_field_name("name")
        name = node_text(source_bytes, name_node).strip()
        return f"enum {name}" if name else alias_name
    return node_text(source_bytes, type_node).strip()


def make_scope_key(path: str, function_name: str, node: Node) -> str:
    start_line = line_no(node)
    start_col = node.start_point[1] + 1
    return f"{path}::{function_name}::{start_line}:{start_col}"


def extend_scope_key(parent_scope_key: str, node: Node) -> str:
    start_line = line_no(node)
    start_col = node.start_point[1] + 1
    return f"{parent_scope_key}/{start_line}:{start_col}"


def walk(node: Node | None):
    if node is None:
        return
    yield node
    for child in node.children:
        yield from walk(child)


# Leading comments are attached directly to top-level definitions so Step 3 can
# retrieve them without running a secondary association pass.
def attach_leading_comments(result: FileExtraction, source_text: str) -> None:
    lines = source_text.splitlines()
    for function in result.functions:
        function.attached_comments = find_leading_comment(lines, function.start_line)
    for global_def in result.global_definitions:
        global_def.attached_comments = find_leading_comment(lines, global_def.def_line)
    for macro_def in result.macro_definitions:
        macro_def.attached_comments = find_leading_comment(lines, macro_def.start_line)
    for type_def in result.type_definitions:
        type_def.attached_comments = find_leading_comment(lines, type_def.start_line)


def find_leading_comment(lines: list[str], target_line: int) -> str | None:
    index = target_line - 2
    while index >= 0 and not lines[index].strip():
        index -= 1
    if index < 0:
        return None

    stripped = normalize_comment_line(lines[index])
    if stripped.startswith('//'):
        start = index
        while start - 1 >= 0 and normalize_comment_line(lines[start - 1]).startswith('//'):
            start -= 1
        return normalize_comment_text(lines[start : index + 1])

    if not is_block_comment_line(stripped):
        return None

    start = index
    while start >= 0:
        current = normalize_comment_line(lines[start])
        if current.startswith('/*'):
            return normalize_comment_text(lines[start : index + 1])
        start -= 1
    return None


def normalize_comment_line(text: str) -> str:
    return text.lstrip('\ufeff').strip()


def normalize_comment_text(lines: list[str]) -> str | None:
    text = "\n".join(line.rstrip() for line in lines).lstrip('\ufeff').strip()
    return text or None


def is_block_comment_line(text: str) -> bool:
    return text.startswith('/*') or text.startswith('*') or text.endswith('*/')





