"""thimble fix (engine/kernel/fixes.py) and a git repository inside a fix's copy: the fixer's sandbox writes its copy,
so it can leave a repository of its own there (plugin/made-up-lib/.git), whose settings (core.fsmonitor) git would
run outside the sandbox once it reads the copy's files. Before git reads them, thimble walks the copy, and a copy
with a path named .git below its top fails as one git may not run in. The world is test_fixes.py's made-up thimble
0.10.2. All data here is made up."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, sh, world  # noqa: E402, F401  (world is the fixture)


@pytest.fixture(autouse=True)
def own_home(tmp_path, monkeypatch):
    """A home of the test's own, so that no git setting of the person's reaches the made-up repositories."""
    (tmp_path / "home").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.delenv("GIT_CONFIG_GLOBAL", raising=False)


def monitor(ran: Path) -> Path:
    """A script outside the sandbox that writes `ran` when git runs it."""
    p = ran.parent / "made-up-monitor"
    p.write_text(f"#!/bin/sh\ntouch '{ran}'\nexit 1\n")
    p.chmod(0o755)
    return p


def nested(copy: Path, ran: Path | None = None) -> Path:
    """A repository of the fixer's own in the copy, with a commit, and with core.fsmonitor on monitor(ran) when `ran`."""
    sub = copy / "plugin" / "made-up-lib"
    sub.mkdir(parents=True)
    (sub / "lib.mjs").write_text("export const n = 1\n")
    sh("git", "init", "-q", cwd=sub)
    sh("git", "add", "-A", cwd=sub)
    sh("git", "commit", "-q", "-m", "a made-up lib", cwd=sub)
    if ran is not None:
        sh("git", "config", "core.fsmonitor", str(monitor(ran)), cwd=sub)
    return sub


def nothing_recorded(w) -> None:
    """No ref of a fix, and mine as the release has it."""
    assert sh("git", "for-each-ref", "refs/thimble/", cwd=FX.live_dir()) == ""
    assert sh("git", "rev-parse", "mine", cwd=FX.live_dir()) == w["base"]


def test_a_repository_inside_the_copy_fails_the_fix_and_none_of_its_settings_runs(world, tmp_path):
    r = made(world)
    ran = tmp_path / "ran-outside"
    nested(Path(r["work"]), ran)
    out = FX.done(r["id"], "Bar says read", "")
    assert (out["state"], out["error"], out["work"], out["commit"]) == ("failed", FX.COPY_GONE, None, None)
    assert not Path(r["work"]).exists() and not ran.exists()
    nothing_recorded(world)
