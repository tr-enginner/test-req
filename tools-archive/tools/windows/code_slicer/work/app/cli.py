from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from app.config import MAX_FUNCTIONS_PER_BLOCK, MAX_TOTAL_LINES_PER_BLOCK
from app.context_export import export_contexts
from app.indexer import build_index
from app.path_blocks import persist_blocks


SUPPORTED_SLICING_STRATEGIES = {"path", "local_subgraph"}
DEFAULT_CONTEXT_PACK_SLICING_STRATEGY = "local_subgraph"


def _build_cli_db_path(repo_path: Path) -> Path:
    return repo_path / ".matrix" / "data" / "index.db"


def cmd_context_pack(args: argparse.Namespace) -> int:
    repo_path = Path(args.repo).resolve()
    if not repo_path.exists() or not repo_path.is_dir():
        raise SystemExit(f"repo path does not exist or is not a directory: {repo_path}")

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    db_path = _build_cli_db_path(repo_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    stats = build_index(str(repo_path), str(db_path))

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        blocks = persist_blocks(
            conn,
            strategy=args.slicing_strategy,
            max_functions=args.max_functions,
            max_total_lines=args.max_total_lines,
        )
        result = export_contexts(
            conn,
            repo_path=str(repo_path),
            out_dir=str(out_dir),
            persisted_only=True,
            slicing_strategy=args.slicing_strategy,
            max_functions=args.max_functions,
            max_total_lines=args.max_total_lines,
        )
    finally:
        conn.close()

    summary = {
        "repo_path": repo_path.as_posix(),
        "db_path": db_path.as_posix(),
        "out_dir": result.out_dir,
        "manifest_file": result.manifest_file,
        "context_count": result.context_count,
        "index": {
            "files_indexed": stats.files_indexed,
            "functions_indexed": stats.functions_indexed,
            "calls_indexed": stats.calls_indexed,
            "global_definitions_indexed": stats.global_definitions_indexed,
            "macro_definitions_indexed": stats.macro_definitions_indexed,
            "type_definitions_indexed": stats.type_definitions_indexed,
            "global_symbol_refs_indexed": stats.global_symbol_refs_indexed,
        },
        "blocks": {
            "slicing_strategy": args.slicing_strategy,
            "blocks_generated": len(blocks),
            "persisted": True,
            "max_functions": args.max_functions,
            "max_total_lines": args.max_total_lines,
        },
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lightweight Code Indexer CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    context_pack_parser = subparsers.add_parser(
        "context-pack",
        help="Generate packaged analysis artifacts for one repository",
    )
    context_pack_parser.add_argument("--repo", required=True, help="Repository root to scan")
    context_pack_parser.add_argument("--out", required=True, help="Output directory for generated context artifacts")
    context_pack_parser.add_argument(
        "--max-functions",
        type=int,
        default=MAX_FUNCTIONS_PER_BLOCK,
        help="Max functions per Step 2 block. Default: unlimited.",
    )
    context_pack_parser.add_argument(
        "--max-total-lines",
        type=int,
        default=MAX_TOTAL_LINES_PER_BLOCK,
        help=(
            "Max source-function lines used when extending a Step 2 block; "
            "one indivisible seed function may exceed the limit. "
            f"Default: {MAX_TOTAL_LINES_PER_BLOCK}"
        ),
    )
    context_pack_parser.add_argument(
        "--slicing-strategy",
        choices=sorted(SUPPORTED_SLICING_STRATEGIES),
        default=DEFAULT_CONTEXT_PACK_SLICING_STRATEGY,
        help=f"Step 2 slicing strategy. Default: {DEFAULT_CONTEXT_PACK_SLICING_STRATEGY}",
    )
    context_pack_parser.set_defaults(func=cmd_context_pack)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
