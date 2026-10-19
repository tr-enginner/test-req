from __future__ import annotations

from dataclasses import dataclass

from tree_sitter import Language, Node, Parser
import tree_sitter_c as tsc


def build_parser() -> Parser:
    parser = Parser()
    parser.language = Language(tsc.language())
    return parser


@dataclass(slots=True)
class ParsedFile:
    source_bytes: bytes
    tree: object


def parse_source(parser: Parser, source_text: str) -> ParsedFile:
    source_bytes = source_text.encode("utf-8", errors="ignore")
    tree = parser.parse(source_bytes)
    return ParsedFile(source_bytes=source_bytes, tree=tree)


def node_text(source_bytes: bytes, node: Node | None) -> str:
    if node is None:
        return ""
    return source_bytes[node.start_byte : node.end_byte].decode("utf-8", errors="ignore")


def line_no(node: Node) -> int:
    return node.start_point[0] + 1


def end_line_no(node: Node) -> int:
    return node.end_point[0] + 1
