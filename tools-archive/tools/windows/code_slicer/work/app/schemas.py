from pydantic import BaseModel, Field

from app.config import MAX_FUNCTIONS_PER_BLOCK, MAX_TOTAL_LINES_PER_BLOCK


class IndexRequest(BaseModel):
    repo_path: str = Field(..., description="Repository root to scan")
    db_path: str | None = Field(default=None, description="SQLite database path")


class IndexResponse(BaseModel):
    db_path: str
    files_indexed: int
    functions_indexed: int
    calls_indexed: int
    global_definitions_indexed: int
    macro_definitions_indexed: int
    type_definitions_indexed: int
    global_symbol_refs_indexed: int


class ContextsGenerateRequest(BaseModel):
    repo_path: str = Field(..., description="Repository root used for repo-relative context paths")
    out_dir: str = Field(..., description="Output directory for manifest.json and contexts/")
    db_path: str | None = Field(default=None, description="SQLite database path")
    persisted_only: bool = Field(default=True, description="Read only persisted Step 2 blocks")
    slicing_strategy: str = Field(default="path", description="Step 2 slicing strategy")
    max_functions: int | None = Field(
        default=MAX_FUNCTIONS_PER_BLOCK,
        ge=1,
        description="Live Step 2 max functions per block; null means unlimited",
    )
    max_total_lines: int = Field(
        default=MAX_TOTAL_LINES_PER_BLOCK,
        ge=1,
        description="Live Step 2 source-function expansion line limit; one seed function may exceed it",
    )


class ContextsGenerateResponse(BaseModel):
    project_path: str
    out_dir: str
    manifest_file: str
    context_count: int
