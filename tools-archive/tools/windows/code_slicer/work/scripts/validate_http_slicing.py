from __future__ import annotations

import sys
import shutil
from pathlib import Path

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[2]
WORKDIR = ROOT / "work"
if str(WORKDIR) not in sys.path:
    sys.path.insert(0, str(WORKDIR))

from app.main import generate_blocks_endpoint, index_repo, list_blocks
from app.schemas import IndexRequest
from app.config import MAX_FUNCTIONS_PER_BLOCK, MAX_TOTAL_LINES_PER_BLOCK


REPO_PATH = ROOT / "testcases" / "step1" / "A_supported"


def main() -> None:
    temp_root_path = WORKDIR / "validation_scratch" / "validate_http_slicing"
    if temp_root_path.exists():
        shutil.rmtree(temp_root_path)
    temp_root_path.mkdir(parents=True, exist_ok=True)
    try:
        db_path = temp_root_path / "http_slicing.db"

        index_response = index_repo(IndexRequest(repo_path=str(REPO_PATH), db_path=str(db_path)))
        assert index_response.functions_indexed == 6, index_response
        assert index_response.macro_definitions_indexed == 6, index_response

        default_payload = generate_blocks_endpoint(
            db_path=str(db_path),
            slicing_strategy="path",
            max_functions=MAX_FUNCTIONS_PER_BLOCK,
            max_total_lines=MAX_TOTAL_LINES_PER_BLOCK,
        )
        assert default_payload["slicing_strategy"] == "path", default_payload
        assert default_payload["persisted"] is True, default_payload
        assert default_payload["blocks_generated"] == 3, default_payload

        default_live_blocks = list_blocks(
            db_path=str(db_path),
            persisted_only=False,
            slicing_strategy="path",
            max_functions=MAX_FUNCTIONS_PER_BLOCK,
            max_total_lines=MAX_TOTAL_LINES_PER_BLOCK,
        )
        assert {block["block_kind"] for block in default_live_blocks} == {"path"}, default_live_blocks

        local_payload = generate_blocks_endpoint(
            db_path=str(db_path),
            slicing_strategy="local_subgraph",
            max_functions=MAX_FUNCTIONS_PER_BLOCK,
            max_total_lines=MAX_TOTAL_LINES_PER_BLOCK,
        )
        assert local_payload["slicing_strategy"] == "local_subgraph", local_payload
        assert local_payload["persisted"] is True, local_payload
        assert local_payload["blocks_generated"] == 1, local_payload

        local_persisted_blocks = list_blocks(
            db_path=str(db_path),
            persisted_only=True,
            slicing_strategy="local_subgraph",
            max_functions=MAX_FUNCTIONS_PER_BLOCK,
            max_total_lines=MAX_TOTAL_LINES_PER_BLOCK,
        )
        assert len(local_persisted_blocks) == 1, local_persisted_blocks
        assert local_persisted_blocks[0]["slicing_strategy"] == "local_subgraph", local_persisted_blocks

        local_blocks = list_blocks(
            db_path=str(db_path),
            persisted_only=False,
            slicing_strategy="local_subgraph",
            max_functions=MAX_FUNCTIONS_PER_BLOCK,
            max_total_lines=MAX_TOTAL_LINES_PER_BLOCK,
        )
        assert len(local_blocks) == 1, local_blocks
        assert local_blocks[0]["block_kind"] == "local_subgraph", local_blocks
        assert [function["name"] for function in local_blocks[0]["functions"]] == [
            "boot",
            "compute_limit",
            "update_global_len",
            "dispatch_event",
            "mark_busy",
            "default_worker",
        ], local_blocks

        try:
            list_blocks(
                db_path=str(db_path),
                persisted_only=False,
                slicing_strategy="bad",
                max_functions=MAX_FUNCTIONS_PER_BLOCK,
                max_total_lines=MAX_TOTAL_LINES_PER_BLOCK,
            )
        except HTTPException as exc:
            assert exc.status_code == 400, exc
            assert "unknown slicing_strategy" in str(exc.detail), exc.detail
        else:
            raise AssertionError("bad slicing_strategy should fail")

        path_persisted_blocks = list_blocks(
            db_path=str(db_path),
            persisted_only=True,
            slicing_strategy="path",
            max_functions=MAX_FUNCTIONS_PER_BLOCK,
            max_total_lines=MAX_TOTAL_LINES_PER_BLOCK,
        )
        assert len(path_persisted_blocks) == 3, path_persisted_blocks
        assert {block["slicing_strategy"] for block in path_persisted_blocks} == {"path"}, path_persisted_blocks
    finally:
        shutil.rmtree(temp_root_path, ignore_errors=True)

    print("validation_ok")


if __name__ == "__main__":
    main()
