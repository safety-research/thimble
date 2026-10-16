"""app.view_indexes: the indexes view readers pickle stay bounded. Each reader's folder keeps its newest fingerprints,
a deleted view's folder goes, and all of them together stay under the cap, least recently used first."""
from __future__ import annotations

import os
import time
from pathlib import Path


from app import view_indexes


def _pickle(d: Path, fp: str, size: int, age_s: float) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{fp}{view_indexes.PICKLE}"
    p.write_bytes(b"x" * size)
    (d / f"{fp}{view_indexes.READS}").write_text("{}")
    t = time.time() - age_s
    os.utime(p, (t, t))
    return p


def test_the_cap_deletes_the_least_recently_used_but_none_in_use(workspaces_tmp, monkeypatch):
    a = workspaces_tmp / "a" / view_indexes.INDEXES_SUBDIR
    b = workspaces_tmp / "b" / view_indexes.INDEXES_SUBDIR
    oldest = _pickle(a / "v1", "f1", 100, 7200)
    middle = _pickle(b / ".extensions" / "kit" / "views" / "t1", "f2", 100, 5400)
    newest = _pickle(a / "v2", "f3", 100, 3600)
    live = _pickle(b / "v3", "f4", 100, 10)
    freed = view_indexes.enforce_cap(limit=150)
    assert not oldest.exists() and not middle.exists() and not newest.exists()
    assert live.exists(), "an index used within IN_USE_S stays even over the cap"
    assert freed == 3 * (100 + 2)
    assert view_indexes.usage()["indexes"] == 1
