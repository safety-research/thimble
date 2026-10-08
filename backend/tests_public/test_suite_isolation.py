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


# ----------------------------------------------------------------------------- no live server


class _Counter:
    """A loopback listener on a free port that counts the connections it accepts: a stand-in for a live server, so a
    test can show that a refused connection never reached it, without connecting to the user's port."""

    def __init__(self) -> None:
        import socket

        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.sock.settimeout(0.05)
        self.port = self.sock.getsockname()[1]

    def accepted(self) -> int:
        import socket

        n = 0
        while True:
            try:
                conn, _ = self.sock.accept()
            except (socket.timeout, BlockingIOError, OSError):
                return n
            conn.close()
            n += 1

    def close(self) -> None:
        self.sock.close()


def test_the_live_ports_are_the_default_port_and_the_runs_own():
    from app import cli, feedback

    assert conftest.DEFAULT_PORT == cli.DEFAULT_PORT == feedback.DEFAULT_PORT
    assert cli.DEFAULT_PORT in conftest.LIVE_PORTS


def test_a_connection_to_a_live_port_is_refused_before_it_is_made(monkeypatch):
    import socket
    import urllib.request

    live = _Counter()
    monkeypatch.setattr(conftest, "LIVE_PORTS", conftest.LIVE_PORTS | {live.port})
    before = len(conftest.LIVE_CONNECTS)
    try:
        for host in ("127.0.0.1", "localhost"):
            with pytest.raises(ConnectionRefusedError):
                socket.create_connection((host, live.port), timeout=1).close()
        with pytest.raises(OSError):
            urllib.request.urlopen(f"http://127.0.0.1:{live.port}/api/health", timeout=1)
        assert live.accepted() == 0
        assert conftest.LIVE_CONNECTS[before:] and all(h.endswith(f":{live.port}") for h in conftest.LIVE_CONNECTS[before:])
        # another port is reached as before
        other = _Counter()
        try:
            socket.create_connection(("127.0.0.1", other.port), timeout=1).close()
            assert other.accepted() == 1
        finally:
            other.close()
    finally:
        live.close()
        del conftest.LIVE_CONNECTS[before:]  # refused on purpose: the test's and the run's checks do not count these


def test_the_clis_fallback_to_the_default_port_reaches_no_server(monkeypatch, tmp_path):
    # live check term-fix6: `thimble extension add` in test_extensions fell back to port 8300, found the user's server
    # and posted /api/extensions/refresh to it. Here a stand-in on a free port plays the live server on the default port.
    from app import cli, feedback

    live = _Counter()
    monkeypatch.setattr(conftest, "LIVE_PORTS", conftest.LIVE_PORTS | {live.port})
    monkeypatch.setattr(cli, "DEFAULT_PORT", live.port)
    monkeypatch.delenv("THIMBLE_PORT", raising=False)
    before = len(conftest.LIVE_CONNECTS)
    try:
        assert cli.port() == live.port
        assert cli.healthy() is False and cli.healthy(cli.api_url()) is False
        assert feedback.server_answers(f"http://127.0.0.1:{live.port}") is False
        # `thimble extension off` asks the server to find the extensions again once it answers on the port
        assert cli.main(["extension", "off", "video"]) == 0
        assert live.accepted() == 0
        assert conftest.LIVE_CONNECTS[before:] == []  # the probes answered without connecting
    finally:
        live.close()
        del conftest.LIVE_CONNECTS[before:]
