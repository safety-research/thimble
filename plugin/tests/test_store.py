"""Where the kernel keeps its records: the folder under analysis is found from where the session started, so a `cd`
inside it never splits its records."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import store as STORE  # noqa: E402


def test_records_stay_in_the_folder_the_session_started_in(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # a session started in data/ whose first command is `cd src`: the records go to data/thimble/, not data/src/thimble/
    data = tmp_path / "data"
    (data / "src").mkdir(parents=True)
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    monkeypatch.setenv("THIMBLE_START", str(data))
    (data / "thimble" / "labels").mkdir(parents=True)
    assert STORE.find_root(data / "src") == data.resolve()
    # a stale record folder below the start folder does not split the session's records
    (data / "src" / "thimble" / "labels").mkdir(parents=True)
    assert STORE.find_root(data / "src") == data.resolve()
    # a folder outside the start folder, and a run outside a session, find their records as before
    other = tmp_path / "other"
    (other / "thimble" / "labels").mkdir(parents=True)
    assert STORE.find_root(other) == other.resolve()
    monkeypatch.delenv("THIMBLE_START")
    assert STORE.find_root(data / "src") == (data / "src").resolve()
