"""thimble fix (engine/kernel/fixes.py) and a git repository inside a fix's copy: the fixer's sandbox writes its copy, so
it can leave a repository of its own there (plugin/made-up-lib/.git), whose settings (core.fsmonitor) git would run
outside the sandbox once it reads the copy's files. Before git reads them (done, settle, diff), thimble walks the copy,
and a copy with a path named .git below its top fails as one git may not run in; a gitlink (a commit of another
repository, which git add records for such a repository) never goes into a fix's commit. The world is test_fixes.py's
made-up thimble 0.10.2. All data here is made up."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, on_fix, sh, world  # noqa: E402, F401  (world is the fixture)


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


def test_a_copy_whose_index_records_a_repository_inside_it_gives_no_diff_and_runs_none_of_its_settings(world, tmp_path):
    # as an earlier round left the copy: git add -A recorded the repository as a gitlink, so every git that reads the
    # copy's files after it would run git inside the repository
    r = made(world)
    wt = Path(r["work"])
    sub = nested(wt)
    sh("git", "add", "-A", cwd=wt)
    assert "160000" in sh("git", "ls-files", "-s", "plugin/made-up-lib", cwd=wt)
    ran = tmp_path / "ran-outside"
    sh("git", "config", "core.fsmonitor", str(monitor(ran)), cwd=sub)
    assert FX.diff_of(FX.get(r["id"])) == ""
    out = FX.done(r["id"], "Bar says read", "")
    assert (out["state"], out["error"], out["work"]) == ("failed", FX.COPY_GONE, None)
    assert not ran.exists()
    nothing_recorded(world)


def test_a_gitlink_never_goes_into_a_fixs_commit(world, monkeypatch):
    # a repository made in the copy after thimble's walk looked: the walk finds none, and git add records it as a gitlink
    monkeypatch.setattr(FX, "_nested_git", lambda work: False, raising=False)
    r = made(world)
    nested(Path(r["work"]))
    out = FX.done(r["id"], "Bar says read", "")
    assert (out["state"], out["error"], out["work"], out["commit"]) == ("failed", FX.COPY_GONE, None, None)
    nothing_recorded(world)


def test_a_round_whose_tests_leave_a_repository_in_the_copy_fails_and_the_version_the_person_has_stays(world, monkeypatch,
                                                                                                         tmp_path):
    a = on_fix(world)
    old = sh("git", "rev-parse", f"refs/thimble/fixes/{a['id']}", cwd=FX.live_dir())
    r = FX.round_(a["id"], "it breaks when I click")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n ?? 0}"))
    # the tests pass, and leave a repository in the copy whose settings would run outside the sandbox
    ran = tmp_path / "ran-outside"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"git init -q plugin/made-up-lib && git -C plugin/made-up-lib config "
                                            f"core.fsmonitor {monitor(ran)}")
    got = FX.done(r["id"], None, "The read item works when clicked.", within=30)
    assert (got["state"], got["error"], got["work"], got["tests"]) == ("failed", FX.COPY_GONE, None, "passed")
    assert got["prev"]["state"] == "on" and not ran.exists()
    assert sh("git", "rev-parse", f"refs/thimble/fixes/{a['id']}", cwd=FX.live_dir()) == old
    assert "read ${n}`" in (FX.live_dir() / "plugin" / "bar" / "bar.tsx").read_text()
