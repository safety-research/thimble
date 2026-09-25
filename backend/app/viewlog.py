"""The view log: which file the analyst opened in the browser, for the telemetry export.

`workspaces/<c>/viewed.jsonl`, one row per view: `{ts, actor, by, path, kind}`. corpus.py's source routes record a
row when the browser reads a file or a database (a request that says it is only peeking, such as a screenshot tour, is
not a view). A repeat of the same (actor, by, path) inside DEDUP_S is one view, so paging a long file counts once.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from . import config, ledger

log = logging.getLogger("thimble.viewlog")

LOG_NAME = "viewed.jsonl"
DEDUP_S = 30.0  # a repeat of the same (actor, by, path) inside this window is the same view
ACTORS = ("analyst", "model")
KINDS = ("file", "dir")
BROWSER = "browser"

_recent: dict[tuple[str, str, str, str], float] = {}  # (workspace, actor, by, path) -> monotonic time of the last row
_rows_cache: dict[Path, tuple[tuple[int, int], list[dict]]] = {}  # log path -> ((size, mtime_ns), rows)


def log_path(c: str) -> Path:
    return config.workspace_dir(c) / LOG_NAME


def normalize(rel: str) -> str:
    """A corpus-relative path as the log stores it: no leading `./`, no surrounding slashes; `.` and `/` are the root."""
    s = str(rel or "").strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    s = s.strip("/")
    return "" if s == "." else s


def record(c: str, path: str, actor: str, by: str, kind: str = "file") -> dict | None:
    """Append one view. Returns the row, or None when the view was a repeat inside DEDUP_S or could not be written
    (logged, never raised: a view is bookkeeping)."""
    if actor not in ACTORS:
        raise ValueError(f"actor must be one of {ACTORS}: {actor!r}")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}: {kind!r}")
    rel = normalize(path)
    key = (c, actor, by, rel)
    now = time.monotonic()
    last = _recent.get(key)
    if last is not None and now - last < DEDUP_S:
        return None
    _recent[key] = now
    row: dict[str, Any] = {"ts": ledger.now_iso(), "actor": actor, "by": by, "path": rel, "kind": kind}
    try:
        ledger.append_jsonl(log_path(c), row)
    except (OSError, ValueError) as e:
        log.warning("view log %s: could not record %s: %s", c, rel, e)
        return None
    return row


def rows(c: str) -> list[dict]:
    """Every row of the log, in file order (cached per file version; do not mutate)."""
    p = log_path(c)
    try:
        st = p.stat()
    except OSError:
        _rows_cache.pop(p, None)
        return []
    key = (st.st_size, st.st_mtime_ns)
    hit = _rows_cache.get(p)
    if hit is not None and hit[0] == key:
        return hit[1]
    out = []
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("actor") in ACTORS and isinstance(r.get("path"), str):
                    out.append(r)
    except OSError:
        return []
    _rows_cache[p] = (key, out)
    return out
