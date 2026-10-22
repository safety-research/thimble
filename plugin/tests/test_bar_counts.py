"""The bar's coverage count reads a folder's databases without writing beside them: a WAL database left as its writer
left it gets no -wal or -shm file from the count. Run: python3 -m pytest plugin/tests"""
from __future__ import annotations

import sqlite3
import sys
from contextlib import closing
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import coverage as CV  # noqa: E402
from kernel.store import Store  # noqa: E402


def test_counting_a_wal_database_writes_nothing_beside_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    d = tmp_path / "data"
    d.mkdir()
    with closing(sqlite3.connect(d / "runs.db")) as con:
        con.execute("pragma journal_mode=wal")
        con.execute("create table runs (name text)")
        con.executemany("insert into runs values (?)", [("made-up-a",), ("made-up-b",)])
        con.commit()
    before = sorted(p.name for p in d.iterdir())
    assert before == ["runs.db"]
    cov = CV.coverage(Store(d, session="s1"))
    assert cov["total"]["files"] == 1
    assert sorted(p.name for p in d.iterdir()) == before
