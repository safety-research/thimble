"""The suite never writes under the user's thimble home: conftest gives the whole run a temporary THIMBLE_HOME, each test
its own, and an audit hook refuses any write, move or removal under ~/.thimble (or the THIMBLE_HOME the run started
with), which fails the session. These tests write nothing there either: what they try is refused, or names a folder that
does not exist."""
import os
import secrets
from array import array
import tempfile
import threading
from pathlib import Path

import conftest
import pytest

from app import corpus


def _real(path: str) -> bool:
    full = os.path.abspath(path)
    return any(full == h or full.startswith(h + os.sep) for h in conftest.REAL_HOMES)


def test_the_run_and_each_test_have_a_temporary_thimble_home(tmp_path):
    assert conftest.SUITE_HOME.is_dir() and str(conftest.SUITE_HOME).startswith(os.path.realpath(tempfile.gettempdir()))
    assert os.environ["THIMBLE_HOME"] == str(tmp_path / "thimble-home")
    assert not _real(os.environ["THIMBLE_HOME"]) and not _real(str(conftest.SUITE_HOME))
    assert not _real(str(corpus._index_home()))


def test_a_test_that_undoes_its_monkeypatch_keeps_the_suites_home(monkeypatch):
    # test_line_index's index test undoes every patch midway, the fixture's THIMBLE_HOME with them: the index it then
    # kept went to ~/.thimble/line-index while the variable was unset
    monkeypatch.undo()
    assert os.environ["THIMBLE_HOME"] == str(conftest.SUITE_HOME)
    assert corpus._index_home() == conftest.SUITE_HOME / corpus.INDEX_DIR


def test_a_thread_that_outlives_its_test_writes_in_the_suites_home(monkeypatch):
    seen: list[str] = []
    monkeypatch.undo()  # as after the test's teardown
    t = threading.Thread(target=lambda: seen.append(str(corpus._index_home())))
    t.start()
    t.join()
    assert seen == [str(conftest.SUITE_HOME / corpus.INDEX_DIR)]


def test_a_write_under_the_users_thimble_home_is_refused(monkeypatch):
    before = len(conftest.REAL_HOME_WRITES)
    # a folder that does not exist: without the hook the open would fail with FileNotFoundError and write nothing
    probe = Path(conftest.REAL_HOMES[0]) / f"thimble-tests-probe-{secrets.token_hex(6)}" / "x"
    try:
        with pytest.raises(conftest.RealHomeWrite):
            open(probe, "w")
        with pytest.raises(conftest.RealHomeWrite):
            os.open(str(probe), os.O_WRONLY | os.O_CREAT)
        with pytest.raises(conftest.RealHomeWrite):
            os.rename(str(probe), str(probe) + ".2")
        # reading stays allowed
        with pytest.raises(FileNotFoundError):
            open(probe)
        # a big file's index kept "in thimble's home" when that home is the user's is refused (here a folder under it
        # that does not exist, so that nothing of the user's could be touched even without the hook)
        monkeypatch.setenv("THIMBLE_HOME", str(probe.parent))
        assert _real(str(corpus._index_home()))
        corpus.save_index(probe.with_name("big.jsonl"), corpus.LineIndex((1, 1), 1, array("q", [1]), array("q", [0])))
        assert not probe.parent.exists()
    finally:
        assert len(conftest.REAL_HOME_WRITES) > before
        del conftest.REAL_HOME_WRITES[before:]  # refused on purpose: the session's check does not count these
