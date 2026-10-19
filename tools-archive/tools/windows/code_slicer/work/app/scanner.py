from __future__ import annotations

import hashlib
import unicodedata
from pathlib import Path

from app.config import SUPPORTED_SUFFIXES


SOURCE_ENCODINGS = ("gb18030", "utf-8")
SKIPPED_REPO_DIRECTORIES = {".git", ".matrix", "node_modules"}
MOJIBAKE_MARKERS = (
    "锟",
    "鈥",
    "娆",
    "鏂",
    "鐨",
    "鍙",
    "璇",
    "缁",
    "闂",
    "銆",
    "夯",
    "€",
)


def iter_source_files(repo_path: str | Path) -> list[Path]:
    root = Path(repo_path).resolve()
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in SUPPORTED_SUFFIXES
        and not _is_generated_or_dependency_source(path, root)
    )


def _is_generated_or_dependency_source(path: Path, root: Path) -> bool:
    relative_parent_parts = path.relative_to(root).parts[:-1]
    return any(part in SKIPPED_REPO_DIRECTORIES for part in relative_parent_parts)


def file_sha1(path: str | Path) -> str:
    content = Path(path).read_bytes()
    return hashlib.sha1(content).hexdigest()


def read_source_text(path: str | Path) -> str:
    content = Path(path).read_bytes()
    decoded: dict[str, str] = {}
    last_error: UnicodeDecodeError | None = None
    for encoding in SOURCE_ENCODINGS:
        try:
            decoded[encoding] = content.decode(encoding)
        except UnicodeDecodeError as exc:
            last_error = exc
    if "gb18030" in decoded and "utf-8" in decoded:
        gb18030_text = decoded["gb18030"]
        utf8_text = decoded["utf-8"]
        return utf8_text if _looks_more_like_mojibake(gb18030_text, utf8_text) else gb18030_text
    for encoding in SOURCE_ENCODINGS:
        if encoding in decoded:
            return decoded[encoding]
    if last_error is not None:
        raise last_error
    raise UnicodeDecodeError("utf-8", b"", 0, 1, "no source encodings configured")


def _looks_more_like_mojibake(primary_text: str, fallback_text: str) -> bool:
    return _text_suspicion_score(primary_text) > _text_suspicion_score(fallback_text)


def _text_suspicion_score(text: str) -> int:
    score = 0
    for marker in MOJIBAKE_MARKERS:
        score += text.count(marker) * 3
    for char in text:
        if char == "\ufffd":
            score += 10
            continue
        if unicodedata.category(char).startswith("C") and char not in "\r\n\t":
            score += 4
            continue
        codepoint = ord(char)
        if 0x3100 <= codepoint <= 0x312F:
            score += 2
        elif 0xE000 <= codepoint <= 0xF8FF:
            score += 2
    return score
