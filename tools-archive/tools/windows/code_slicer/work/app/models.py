from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class FunctionRecord:
    file_path: str
    name: str
    start_line: int
    end_line: int
    return_type: str
    signature_text: str
    body_text: str
    ast_type: str
    linkage: str
    attached_comments: str | None = None
    id: int | None = None


@dataclass(slots=True)
class GlobalDefinitionRecord:
    file_path: str
    name: str
    type_text: str
    def_line: int
    definition_text: str
    linkage: str
    attached_comments: str | None = None


@dataclass(slots=True)
class MacroDefinitionRecord:
    file_path: str
    name: str
    kind: str
    start_line: int
    end_line: int
    definition_text: str
    replacement_text: str
    parameters: tuple[str, ...]
    attached_comments: str | None = None


@dataclass(slots=True)
class NameRefRecord:
    file_path: str
    function_name: str
    name: str
    line: int
    column: int
    role: str
    scope_key: str


@dataclass(slots=True)
class CallRecord:
    file_path: str
    caller_function_name: str
    callee_name: str
    line: int
    arg_texts: list[str]
    callee_kind: str
    resolved_function_id: int | None = None


@dataclass(slots=True)
class TypeDefinitionRecord:
    file_path: str
    name: str
    kind: str
    start_line: int
    end_line: int
    definition_text: str
    underlying_type: str
    target_type: str
    is_function_pointer: bool
    attached_comments: str | None = None


@dataclass(slots=True)
class TypeFieldRecord:
    file_path: str
    type_name: str
    field_name: str
    field_type: str
    line: int
    is_function_pointer: bool


@dataclass(slots=True)
class AliasHintRecord:
    file_path: str
    function_name: str
    target_name: str
    source_name: str
    line: int
    scope_key: str


@dataclass(slots=True)
class FieldAccessRecord:
    file_path: str
    function_name: str
    base_name: str
    field_name: str
    access_kind: str
    role: str
    line: int
    column: int
    scope_key: str
