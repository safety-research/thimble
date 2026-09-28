"""thimble's state is readable by its owner alone: <home> and the workspaces are made 0700 (an existing <home> is
tightened), and the server's state, its log, its lock and a problem report are written 0600, whatever the umask."""
from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from app import cli, config


def _mode(p: Path) -> int:
    return stat.S_IMODE(p.stat().st_mode)


@pytest.fixture()
def open_umask():
    old = os.umask(0o022)
    yield
    os.umask(old)


def test_home_its_state_log_and_lock_are_private(tmp_path, monkeypatch, open_umask):
    home = tmp_path / "home"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    cli.write_state({"port": 8721})
    assert _mode(home) == 0o700 and _mode(home / "server.json") == 0o600
    cli._log("started")
    assert _mode(home / "server.log") == 0o600
    with cli.lock(1.0):
        assert _mode(home / "server.lock") == 0o600
    out = home / "vite.log"
    pid = cli.spawn(["true"], cwd=tmp_path, env=dict(os.environ), log_file=out)
    os.waitpid(pid, 0)
    assert _mode(out) == 0o600

    # an install from before: a readable home and log are tightened
    os.chmod(home, 0o755)
    os.chmod(home / "server.log", 0o644)
    cli._log("again")
    assert _mode(home) == 0o700 and _mode(home / "server.log") == 0o600
    config.private_file(home / "server.json")
    assert _mode(home / "server.json") == 0o600
