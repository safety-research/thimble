"""Coverage (0.9.0 build spec 3.9, contract C7): what this session's tool calls read, searched or never opened of the
corpus's data files, records first, files in brackets, grouped by folder and file type.

    <ws>/coverage/<sid>.jsonl      the session's facts, one JSON object per line: {path, how, lines?, pages?, total?,
                                   folder?, by, at, turn}
    <ws>/coverage/index.sqlite     the data files, their records and the totals per folder and extension (index_main)

SCAFFOLD STUB (features lane): add_facts appends the facts that name a data file inside the corpus (is_data, the
activation rule without its size test); summary counts distinct paths, seen (whole or part) and searched, and says
`saw N files`; rows lists none; index_main does nothing.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

NEVER_SEGMENTS = {"node_modules", ".git", ".venv", "venv", "dist", "build", ".claude", "tests", "test", "fixtures",
                  "testdata", "__snapshots__", "sample", "samples", "examples"}
DATA_SEGMENTS = {"data", "datasets", "runs", "transcripts", "traces", "corpus", "corpora"}
DATA_EXTS = {"csv", "tsv", "jsonl", "ndjson", "parquet", "arrow", "feather", "xlsx", "sqlite", "db", "duckdb", "json",
             "log"}
CODE_TREE_EXTS = {"csv", "tsv", "jsonl", "ndjson", "parquet", "arrow", "feather", "xlsx", "log"}
HOWS = ("whole", "part", "searched")


def is_data(rel: str, code_tree: bool) -> bool:
    """Whether the corpus path `rel` is a data file (the twin of the terminal UI's isDataFile). The stub: no
    never-segment or never-name; outside a code tree an extension of DATA_EXTS; inside one, a data segment and a data
    extension other than `log`, or an extension of CODE_TREE_EXTS."""
    parts = [p for p in str(rel).replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        return False
    name = parts[-1]
    if any(p in NEVER_SEGMENTS for p in parts[:-1]):
        return False
    if (name.startswith("package") and name.endswith(".json")) or (name.startswith("tsconfig") and name.endswith(".json")) \
            or name.endswith(".lock") or name == "composer.json" or name.startswith(".eslintrc"):
        return False
    ext = name.rsplit(".", 1)[-1].lower() if "." in name[1:] else ""
    if not code_tree:
        return ext in DATA_EXTS
    if any(p in DATA_SEGMENTS for p in parts[:-1]) and ext in DATA_EXTS and ext != "log":
        return True
    return ext in CODE_TREE_EXTS


def _facts_file(c: str, sid: str) -> Path:
    from . import config  # noqa: PLC0415

    name = "".join(ch for ch in str(sid or "") if ch.isalnum() or ch in "-_") or "session"
    return config.workspace_dir(c) / "coverage" / f"{name}.jsonl"


def _facts(c: str, sid: str) -> list[dict[str, Any]]:
    try:
        lines = _facts_file(c, sid).read_text("utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            got = json.loads(line)
        except ValueError:
            continue
        if isinstance(got, dict):
            out.append(got)
    return out


def add_facts(c: str, sid: str, turn: str, facts: list[dict[str, Any]]) -> dict[str, Any]:
    """Keep the facts of a turn that name a data file (relative paths, `how` one of HOWS); the session's summary."""
    kept = []
    for f in facts if isinstance(facts, list) else []:
        if not isinstance(f, dict) or f.get("how") not in HOWS:
            continue
        path = str(f.get("path") or "")
        if path.startswith("/") or not is_data(path, False):
            continue
        kept.append({**f, "turn": turn, "at": f.get("at") or time.time()})
    if kept:
        out = _facts_file(c, sid)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("a", encoding="utf-8") as fh:
            for f in kept:
                fh.write(json.dumps(f, ensure_ascii=False) + "\n")
    return summary(c, sid)


def summary(c: str, sid: str) -> dict[str, Any]:
    """C7's Summary from the session's facts alone (no index yet)."""
    seen: set[str] = set()
    searched: set[str] = set()
    for f in _facts(c, sid):
        (seen if f.get("how") in ("whole", "part") else searched).add(str(f.get("path")))
    searched -= seen
    n = len(seen)
    return {"files": {"seen": n, "searched": len(searched), "never": 0, "total": n + len(searched)},
            "records": {"seen": 0, "total": 0, "counted": False},
            "line": f"saw {n:,} file{'' if n == 1 else 's'}"}


def rows(c: str, sid: str, folder: str = "") -> list[dict[str, Any]]:
    """C7's rows of the Coverage view at `folder`. The stub lists none."""
    return []


def index_main(argv: list[str]) -> int:
    """`python -m app.coverage index --cwd DIR`: the background job that walks, indexes and counts. The stub does
    nothing."""
    return 0
