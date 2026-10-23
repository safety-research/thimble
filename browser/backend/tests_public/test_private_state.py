"""thimble's state is readable by its owner alone: <home> and the workspaces are made 0700 whatever the umask, and an
existing <home> is tightened, so the files in them (server.json with the plugin's token, the logs) are out of other
users' reach."""
from __future__ import annotations

import os
import stat
from pathlib import Path

from app import cli, config


def _mode(p: Path) -> int:
    return stat.S_IMODE(p.stat().st_mode)


def test_home_and_workspaces_are_private_folders(tmp_path, monkeypatch):
    old = os.umask(0o022)
    try:
        home = tmp_path / "home"
        monkeypatch.setenv("THIMBLE_HOME", str(home))
        cli.write_state({"port": 8721})
        assert _mode(home) == 0o700
        os.chmod(home, 0o755)  # an install from before
        cli._log("started")
        assert _mode(home) == 0o700
        assert _mode(config.workspace_dir("mini")) == 0o700 and _mode(config.WORKSPACES_DIR) == 0o700
    finally:
        os.umask(old)
