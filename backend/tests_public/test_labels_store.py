"""app.labels_store's size: a store keeps no index another one covers, a large rebuild goes into place compacted, and a
store made with that index is read as it is and drops it at its next write. The labels are invented: a code label over
the lines of two files, with a cover over a third."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from app import labels_store


def _labels(path: Path, n: int = 3000) -> Path:
    rows = [{"ref": f"turns.jsonl#L{i}", "label": "shell" if i % 3 else "gui", "source": "code", "confidence": 1.0,
             "ts": "2026-01-01T00:00:00+00:00"} for i in range(1, n + 1)]
    rows += [{"ref": "chat.jsonl#L4", "label": "gui", "source": "code"},
             {"ref": "turns.jsonl#L9", "label": "shell", "source": "analyst", "ts": "t"},
             labels_store.cover_row("other.jsonl", 1, 40, "quiet", "regex", "t")]
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


def _indexes(db: Path) -> set[str]:
    conn = sqlite3.connect(str(db))
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")}
    finally:
        conn.close()


def test_a_rebuilt_store_keeps_no_index_another_covers_and_a_large_one_is_compacted(tmp_path, monkeypatch):
    jsonl = _labels(tmp_path / "k.jsonl")
    st = labels_store.Store(jsonl)
    st.rebuild()
    small = st.db.stat().st_size
    want = st.rows_for_refs(["turns.jsonl#L9", "turns.jsonl#L3", "chat.jsonl#L4", "other.jsonl#L7"])
    assert "current_path" not in _indexes(st.db) and "current_path_line" in _indexes(st.db)
    assert st.state()[0] == "fresh"

    monkeypatch.setattr(labels_store, "COMPACT_BYTES", 1)
    st.rebuild()
    assert st.state()[0] == "fresh" and st.rows_for_refs(["turns.jsonl#L9", "turns.jsonl#L3", "chat.jsonl#L4",
                                                           "other.jsonl#L7"]) == want
    assert st.db.stat().st_size < small, "the compacted copy is smaller than the store grown row by row"
    assert [p.name for p in tmp_path.iterdir() if p.name != jsonl.name] == ["k.sqlite"], "no rebuild files are left"
    assert want[0]["label"] == "gui" and want[0]["analyst"] == "shell" and want[3]["label"] == "quiet"


def test_a_store_made_before_is_read_as_it_is_and_drops_the_covered_index_at_its_next_write(tmp_path):
    """A store made with the index on path alone stays fresh, so an update reads it with no rebuild, and its next write
    drops that index."""
    jsonl = _labels(tmp_path / "k.jsonl", n=50)
    st = labels_store.Store(jsonl)
    st.rebuild()
    conn = sqlite3.connect(str(st.db))
    conn.execute("CREATE INDEX current_path ON current(path)")
    conn.commit()
    conn.close()
    assert st.state()[0] == "fresh", "no rebuild"
    st.connect(write=True).close()
    assert "current_path" not in _indexes(st.db) and st.state()[0] == "fresh"
