"""thimble fix in the browser (app/fixes.py) and a git repository inside a fix's copy: the fixer's sandbox writes its copy,
so it can leave a repository of its own there, whose settings (core.fsmonitor) git would run outside the sandbox once it
reads the copy's files. changed() walks the copy first and reads none of a copy with a path named .git below its top,
which the kernel's check then fails. All data here is made up."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from app import fixes

IDENT = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t",
         "GIT_COMMITTER_EMAIL": "t@example.com"}


def _git(*args: str, cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                          env={**os.environ, **IDENT}).stdout.strip()


def test_the_files_of_a_copy_with_a_repository_inside_it_are_not_read_and_none_of_its_settings_runs(tmp_path,
                                                                                                    monkeypatch):
    (tmp_path / "own-home").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "own-home"))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.delenv("GIT_CONFIG_GLOBAL", raising=False)
    monkeypatch.setenv(fixes.PLUGIN_HOME_ENV, str(tmp_path / "home"))
    live = tmp_path / "home" / "fixes" / "live"
    live.mkdir(parents=True)
    (live / "bar.txt").write_text("as released\n")
    _git("init", "-q", cwd=live)
    _git("add", "-A", cwd=live)
    _git("commit", "-q", "-m", "made-up release", cwd=live)
    work = tmp_path / "home" / "fixes" / "work" / "1"
    _git("worktree", "add", "-q", "--detach", str(work), "HEAD", cwd=live)
    (work / "bar.txt").write_text("changed\n")
    assert fixes.changed(work, "HEAD") == ["bar.txt"]
    # the fixer's sandbox leaves a repository of its own in the copy
    sub = work / "lib" / "made-up-lib"
    sub.mkdir(parents=True)
    (sub / "lib.mjs").write_text("export const n = 1\n")
    _git("init", "-q", cwd=sub)
    _git("add", "-A", cwd=sub)
    _git("commit", "-q", "-m", "a made-up lib", cwd=sub)
    assert fixes.changed(work, "HEAD") == []
    # as an earlier round left the copy: its index records the repository (a gitlink), so git that reads the copy's files
    # would run git inside the repository, with its settings
    _git("add", "-A", cwd=work)
    ran = tmp_path / "ran-outside"
    (tmp_path / "made-up-monitor").write_text(f"#!/bin/sh\ntouch '{ran}'\nexit 1\n")
    (tmp_path / "made-up-monitor").chmod(0o755)
    _git("config", "core.fsmonitor", str(tmp_path / "made-up-monitor"), cwd=sub)
    assert fixes.changed(work, "HEAD") == []
    assert not ran.exists()
