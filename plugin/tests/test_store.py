"""Where the kernel keeps its records: the folder under analysis is found from where the session started, so a `cd`
inside it never splits its records."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import store as STORE  # noqa: E402


def test_records_stay_in_the_folder_the_session_started_in(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # a session started in data/ whose first command is `cd src`: the labels stay data/'s, not data/src/'s
    data = tmp_path / "data"
    (data / "src").mkdir(parents=True)
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_CONVERSATION", "c-1")
    monkeypatch.setenv("THIMBLE_START", str(data))
    (STORE.kept_dir(data) / "labels").mkdir(parents=True)
    assert STORE.find_root(data / "src") == data.resolve()
    # a stale record folder below the start folder does not split the session's records
    (STORE.kept_dir(data / "src") / "labels").mkdir(parents=True)
    assert STORE.find_root(data / "src") == data.resolve()
    # a folder outside the start folder, and a run outside a session, find their records as before
    other = tmp_path / "other"
    (other / "deep").mkdir(parents=True)
    (STORE.kept_dir(other) / "labels").mkdir(parents=True)
    assert STORE.find_root(other / "deep") == other.resolve()
    monkeypatch.delenv("THIMBLE_START")
    assert STORE.find_root(data / "src") == (data / "src").resolve()
    # another conversation keeps no labels here: from data/src/ it finds no folder above
    monkeypatch.setenv("THIMBLE_CONVERSATION", "c-2")
    assert STORE.find_root(other / "deep") == (other / "deep").resolve()


def test_a_command_in_thimbles_temp_folder_keeps_the_start_folders_records(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # `cd $TMPDIR && thimble label …` over a file Claude derived there: the start folder is the root, not the temp folder
    data, temp = tmp_path / "data", tmp_path / "tmp" / "thimble"
    data.mkdir()
    temp.mkdir(parents=True)
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("TMPDIR", str(temp))
    monkeypatch.setenv("THIMBLE_START", str(data))
    assert STORE.in_temp(temp / "rows.jsonl") and not STORE.in_temp(data)
    assert STORE.find_root(temp) == data.resolve()
    # thimble/ in the person's TMPDIR counts too; outside a session the temp folder is a folder like any other
    monkeypatch.setenv("TMPDIR", str(temp.parent))
    assert STORE.find_root(temp) == data.resolve()
    monkeypatch.delenv("THIMBLE_START")
    assert STORE.find_root(temp) == temp.resolve()


@pytest.mark.skipif(os.geteuid() == 0, reason="root may write in any folder")
def test_a_folder_thimble_may_not_write_in_is_found_by_the_records_kept_for_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    data = tmp_path / "data"
    (data / "src").mkdir(parents=True)
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_START", str(data))
    data.chmod(0o555)
    try:
        st = STORE.Store(data)
        assert st.dir == STORE.kept_dir(data.resolve()) and str(st.dir).startswith(str(tmp_path / "th" / "conversations"))
        st.sub("labels")
        assert not (data / "thimble").exists()
        # a later command in a subfolder finds the root by its kept records
        assert STORE.find_root(data / "src") == data.resolve()
    finally:
        data.chmod(0o755)
    # once kept there, they stay there, though the folder may be written now
    assert STORE.Store(data).dir == STORE.kept_dir(data.resolve())


def test_folder_names_keep_folders_apart_and_match_the_plugin() -> None:
    # two folders whose paths differ only in characters a name cannot hold get names of their own
    assert len({STORE.folder_name(p) for p in ("/w/run.1", "/w/run-1", "/w-run/1")}) == 3
    # the plugin's core/layout.mjs makes the same names (core/test/layout.test.mjs checks these two values)
    assert STORE.folder_name("/w/run.1") == "w-run-1-b8a5493c96fe"
    assert STORE.short_hash("toolu_01ABC") == "12a499106e46"
