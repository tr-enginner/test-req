from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "http://127.0.0.1:8000"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Call /index, /blocks/generate, /blocks, and /contexts/generate for one repo or a batch manifest."
    )
    parser.add_argument("--repo-path", help="Project directory to index.")
    parser.add_argument("--db-path", help="SQLite db path for the indexed result.")
    parser.add_argument(
        "--batch-file",
        help="Path to a JSON file containing a list of {repo_path, db_path} items.",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"API base URL. Default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument(
        "--max-functions",
        type=int,
        default=None,
        help="Optional max_functions for /blocks/generate.",
    )
    parser.add_argument(
        "--max-total-lines",
        type=int,
        default=None,
        help="Optional max_total_lines for /blocks/generate.",
    )
    parser.add_argument(
        "--slicing-strategy",
        choices=["path", "local_subgraph"],
        default="path",
        help="Step 2 slicing strategy for /blocks/generate and live /blocks. Default: path.",
    )
    parser.add_argument(
        "--persisted-only",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Use persisted_only for GET /blocks. Default: false.",
    )
    parser.add_argument(
        "--blocks-preview",
        type=int,
        default=3,
        help="How many blocks to preview in output. Default: 3.",
    )
    parser.add_argument(
        "--save-blocks-json",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Save the full GET /blocks result to a JSON file. Default: true.",
    )
    parser.add_argument(
        "--blocks-output-dir",
        help="Directory for saved blocks JSON files. Default: next to db_path.",
    )
    parser.add_argument(
        "--generate-contexts",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Call /contexts/generate after blocks are ready. Default: true.",
    )
    parser.add_argument(
        "--contexts-persisted-only",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Use persisted_only for POST /contexts/generate. Default: true.",
    )
    parser.add_argument(
        "--contexts-output-dir",
        help="Base directory for generated Step 3 context files. Default: next to db_path as <db>.contexts.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=300.0,
        help="HTTP timeout in seconds. Default: 300.",
    )
    parser.add_argument(
        "--stop-on-error",
        action="store_true",
        help="Stop immediately when one batch item fails.",
    )
    args = parser.parse_args()

    if bool(args.batch_file) == bool(args.repo_path or args.db_path):
        parser.error("Use either --batch-file, or both --repo-path and --db-path.")
    if args.repo_path and not args.db_path:
        parser.error("--db-path is required when --repo-path is provided.")
    if args.db_path and not args.repo_path:
        parser.error("--repo-path is required when --db-path is provided.")
    return args


def request_json(
    method: str,
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: float,
) -> Any:
    body: bytes | None = None
    headers: dict[str, str] = {}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url=url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset("utf-8")
            return json.loads(response.read().decode(charset))
    except urllib.error.HTTPError as exc:
        detail_text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {url}: {detail_text}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Request failed for {url}: {exc.reason}") from exc


def build_generate_url(
    base_url: str,
    db_path: str,
    slicing_strategy: str,
    max_functions: int | None,
    max_total_lines: int | None,
) -> str:
    query: dict[str, str | int] = {"db_path": db_path, "slicing_strategy": slicing_strategy}
    if max_functions is not None:
        query["max_functions"] = max_functions
    if max_total_lines is not None:
        query["max_total_lines"] = max_total_lines
    return f"{base_url.rstrip('/')}/blocks/generate?{urllib.parse.urlencode(query)}"


def build_list_blocks_url(
    base_url: str,
    db_path: str,
    persisted_only: bool,
    slicing_strategy: str,
    max_functions: int | None,
    max_total_lines: int | None,
) -> str:
    query: dict[str, str | int] = {
        "db_path": db_path,
        "persisted_only": str(persisted_only).lower(),
        "slicing_strategy": slicing_strategy,
    }
    if max_functions is not None:
        query["max_functions"] = max_functions
    if max_total_lines is not None:
        query["max_total_lines"] = max_total_lines
    return f"{base_url.rstrip('/')}/blocks?{urllib.parse.urlencode(query)}"


def build_contexts_output_dir(db_path: str, repo_path: str, output_dir: str | None) -> Path:
    db_file = Path(db_path)
    if output_dir:
        target_dir = Path(output_dir).resolve()
        repo_name = make_safe_filename(Path(repo_path).name)
        db_name = make_safe_filename(db_file.stem or db_file.name)
        return target_dir / f"{repo_name}.{db_name}.contexts"
    return db_file.resolve().with_name(f"{db_file.stem}.contexts")


def load_cases(args: argparse.Namespace) -> list[dict[str, str]]:
    if args.batch_file:
        batch_path = Path(args.batch_file).resolve()
        items = json.loads(batch_path.read_text(encoding="utf-8"))
        if not isinstance(items, list):
            raise RuntimeError("Batch file must be a JSON array.")
        cases: list[dict[str, str]] = []
        for index, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                raise RuntimeError(f"Batch item #{index} must be an object.")
            repo_path = item.get("repo_path")
            db_path = item.get("db_path")
            if not repo_path or not db_path:
                raise RuntimeError(f"Batch item #{index} must contain repo_path and db_path.")
            cases.append({"repo_path": str(repo_path), "db_path": str(db_path)})
        return cases

    return [{"repo_path": str(args.repo_path), "db_path": str(args.db_path)}]


def make_safe_filename(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._")
    return sanitized or "blocks"


def build_blocks_output_path(db_path: str, repo_path: str, output_dir: str | None) -> Path:
    db_file = Path(db_path)
    if output_dir:
        target_dir = Path(output_dir).resolve()
        repo_name = make_safe_filename(Path(repo_path).name)
        db_name = make_safe_filename(db_file.stem or db_file.name)
        return target_dir / f"{repo_name}.{db_name}.blocks.json"
    return db_file.resolve().with_name(f"{db_file.stem}.blocks.json")


def save_blocks_json(blocks_list_result: list[dict[str, Any]], output_path: Path) -> str:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(blocks_list_result, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(output_path)


def run_case(
    *,
    base_url: str,
    repo_path: str,
    db_path: str,
    persisted_only: bool,
    save_blocks_json_enabled: bool,
    blocks_output_dir: str | None,
    generate_contexts_enabled: bool,
    contexts_persisted_only: bool,
    contexts_output_dir: str | None,
    slicing_strategy: str,
    max_functions: int | None,
    max_total_lines: int | None,
    timeout: float,
) -> dict[str, Any]:
    index_url = f"{base_url.rstrip('/')}/index"
    generate_url = build_generate_url(base_url, db_path, slicing_strategy, max_functions, max_total_lines)
    list_blocks_url = build_list_blocks_url(base_url, db_path, persisted_only, slicing_strategy, max_functions, max_total_lines)
    contexts_url = f"{base_url.rstrip('/')}/contexts/generate"

    index_result = request_json(
        "POST",
        index_url,
        payload={"repo_path": repo_path, "db_path": db_path},
        timeout=timeout,
    )
    blocks_generate_result = request_json("POST", generate_url, timeout=timeout)
    blocks_list_result = request_json("GET", list_blocks_url, timeout=timeout)
    blocks_json_path: str | None = None
    if save_blocks_json_enabled:
        output_path = build_blocks_output_path(db_path, repo_path, blocks_output_dir)
        blocks_json_path = save_blocks_json(blocks_list_result, output_path)
    contexts_generate_result: dict[str, Any] | None = None
    if generate_contexts_enabled:
        contexts_out_dir = build_contexts_output_dir(db_path, repo_path, contexts_output_dir)
        contexts_payload: dict[str, Any] = {
            "repo_path": repo_path,
            "out_dir": str(contexts_out_dir),
            "db_path": db_path,
            "persisted_only": contexts_persisted_only,
            "slicing_strategy": slicing_strategy,
        }
        if max_functions is not None:
            contexts_payload["max_functions"] = max_functions
        if max_total_lines is not None:
            contexts_payload["max_total_lines"] = max_total_lines
        contexts_generate_result = request_json(
            "POST",
            contexts_url,
            payload=contexts_payload,
            timeout=timeout,
        )
    return {
        "repo_path": repo_path,
        "db_path": db_path,
        "slicing_strategy": slicing_strategy,
        "index": index_result,
        "blocks_generate": blocks_generate_result,
        "blocks_list": blocks_list_result,
        "blocks_json_path": blocks_json_path,
        "contexts_generate": contexts_generate_result,
    }


def print_case_result(case_number: int, total_cases: int, result: dict[str, Any], blocks_preview: int) -> None:
    index_result = result["index"]
    blocks_generate_result = result["blocks_generate"]
    blocks_list_result = result["blocks_list"]
    block_kind_counts: dict[str, int] = {}
    truncated_count = 0
    for block in blocks_list_result:
        block_kind = str(block.get("block_kind", "unknown"))
        block_kind_counts[block_kind] = block_kind_counts.get(block_kind, 0) + 1
        if block.get("truncated"):
            truncated_count += 1
    print(f"[{case_number}/{total_cases}] OK")
    print(f"  repo_path: {result['repo_path']}")
    print(f"  db_path:   {result['db_path']}")
    print(f"  strategy:  {result['slicing_strategy']}")
    print(
        "  index:     "
        f"files={index_result.get('files_indexed')} "
        f"functions={index_result.get('functions_indexed')} "
        f"calls={index_result.get('calls_indexed')} "
        f"globals={index_result.get('global_definitions_indexed')} "
        f"types={index_result.get('type_definitions_indexed')} "
        f"global_refs={index_result.get('global_symbol_refs_indexed')}"
    )
    print(
        "  generate:  "
        f"generated={blocks_generate_result.get('blocks_generated')} "
        f"max_functions={blocks_generate_result.get('max_functions')} "
        f"max_total_lines={blocks_generate_result.get('max_total_lines')}"
    )
    print(
        "  blocks:    "
        f"count={len(blocks_list_result)} "
        f"path={block_kind_counts.get('path', 0)} "
        f"others={block_kind_counts.get('others', 0)} "
        f"truncated={truncated_count}"
    )
    if result.get("blocks_json_path"):
        print(f"  saved:     {result['blocks_json_path']}")
    contexts_generate_result = result.get("contexts_generate")
    if contexts_generate_result:
        print(
            "  contexts:  "
            f"count={contexts_generate_result.get('context_count')} "
            f"manifest={contexts_generate_result.get('manifest_file')}"
        )
        print(f"  out_dir:   {contexts_generate_result.get('out_dir')}")
    for block in blocks_list_result[: max(0, blocks_preview)]:
        print(
            "  preview:   "
            f"id={block.get('block_id')} "
            f"kind={block.get('block_kind')} "
            f"root={block.get('root_function_name')} "
            f"functions={block.get('total_functions')} "
            f"lines={block.get('total_lines')}"
        )


def print_failure(case_number: int, total_cases: int, repo_path: str, db_path: str, error: Exception) -> None:
    print(f"[{case_number}/{total_cases}] FAILED")
    print(f"  repo_path: {repo_path}")
    print(f"  db_path:   {db_path}")
    print(f"  error:     {error}")


def main() -> int:
    args = parse_args()
    cases = load_cases(args)
    total_cases = len(cases)
    success_count = 0

    for index, case in enumerate(cases, start=1):
        try:
            result = run_case(
                base_url=args.base_url,
                repo_path=case["repo_path"],
                db_path=case["db_path"],
                persisted_only=args.persisted_only,
                save_blocks_json_enabled=args.save_blocks_json,
                blocks_output_dir=args.blocks_output_dir,
                generate_contexts_enabled=args.generate_contexts,
                contexts_persisted_only=args.contexts_persisted_only,
                contexts_output_dir=args.contexts_output_dir,
                slicing_strategy=args.slicing_strategy,
                max_functions=args.max_functions,
                max_total_lines=args.max_total_lines,
                timeout=args.timeout,
            )
            print_case_result(index, total_cases, result, args.blocks_preview)
            success_count += 1
        except Exception as exc:
            print_failure(index, total_cases, case["repo_path"], case["db_path"], exc)
            if args.stop_on_error:
                print(f"Stopped after first failure. Success: {success_count}/{total_cases}")
                return 1
        if index != total_cases:
            print()

    print()
    print(f"Finished. Success: {success_count}/{total_cases}, Failed: {total_cases - success_count}/{total_cases}")
    return 0 if success_count == total_cases else 1


if __name__ == "__main__":
    raise SystemExit(main())
