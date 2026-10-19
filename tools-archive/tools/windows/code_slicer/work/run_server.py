from __future__ import annotations

import os

import uvicorn

from app.main import app


HOST = os.environ.get("CODE_INDEXER_HOST", "127.0.0.1")
PORT = int(os.environ.get("CODE_INDEXER_PORT", "8000"))


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, reload=False)
