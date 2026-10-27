"""thimble fix on a clone install whose thimble home was deleted, as INSTALL.md's uninstall says: the clone keeps the
branch mine and the refs under refs/thimble/. A new home's first request sets them aside under refs/thimble-old/ when
mine is thimble's own, and else stops with the line that names mine. The world is test_fixes.py's made-up thimble
0.10.2; `claude` is a fake. All data here is made up."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, press, sh, world  # noqa: E402, F401  (world is the fixture)

STOP = "already has a branch named mine"


def refs(repo: Path, *patterns: str) -> dict[str, str]:
    out = sh("git", "for-each-ref", "--format=%(refname) %(objectname)", *patterns, cwd=repo)
    return dict(x.split(" ") for x in out.splitlines())


def left(w, on: bool = True) -> dict[str, str]:
    """Fix 1, ready or on, and a refs/thimble/prev/1 such as a round of it leaves, in a home that is then deleted: the
    clone keeps mine (the release commit, and fix 1's commit, which thimble made, when it was on) and the refs under
    refs/thimble/."""
    r = made(w)
    FX.done(r["id"], "Bar says read", "")
    if on:
        FX.apply(r["id"], press(r["id"]))
    sh("git", "update-ref", "refs/thimble/prev/1", w["base"], cwd=w["rel"])
    old = refs(w["rel"], "refs/heads/mine", "refs/thimble/")
    shutil.rmtree(FX.thimble_home())
    return old


@pytest.mark.parametrize("on", [True, False], ids=["fix-on", "no-commit-of-its-own"])
def test_a_new_home_sets_aside_what_a_deleted_home_left_and_its_fix_1_sees_none_of_it(world, on):
    rel = world["rel"]
    old = left(world, on)
    assert set(old) == {"refs/heads/mine", "refs/thimble/fixes/1", "refs/thimble/prev/1"}
    r = made(world)
    # a new mine at the release commit, in a new live
    assert r["id"] == 1 and sh("git", "rev-parse", "mine", cwd=rel) == world["base"]
    assert sh("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=FX.live_dir()) == "mine"
    # the old mine and refs are kept, under one name aside, deleting nothing
    aside = refs(rel, "refs/thimble-old/")
    names = {x.split("/")[2] for x in aside}
    assert len(names) == 1
    name = names.pop()
    assert {x.replace(f"refs/thimble-old/{name}/", "refs/"): c for x, c in aside.items()} == old
    # the new fix 1 sees none of the old refs: none until it is done, then its own
    assert refs(rel, "refs/thimble/") == {} and not FX._has_ref(1)
    r = FX.done(r["id"], "Bar says read again", "")
    assert refs(rel, "refs/thimble/") == {"refs/thimble/fixes/1": r["commit"]}
    assert r["commit"] != old["refs/thimble/fixes/1"]


def test_a_mine_with_a_commit_someone_else_made_stops_and_nothing_moves(world):
    rel = world["rel"]
    left(world)
    # the person's own commit on top of thimble's (sh commits as the made-up person t)
    mine = sh("git", "commit-tree", sh("git", "rev-parse", "mine^{tree}", cwd=rel), "-p", "mine", "-m", "my change",
              cwd=rel)
    sh("git", "update-ref", "refs/heads/mine", mine, cwd=rel)
    before = refs(rel)
    with pytest.raises(FX.FixError, match=STOP):
        FX.new("say read")
    assert refs(rel) == before


def test_a_mine_that_tracks_an_upstream_is_the_persons_and_stops_and_nothing_moves(world):
    """The person's own branch mine, which tracks the mine of their remote (thimble never sets an upstream): each of
    its commits is on the remote's branch too, and it is still theirs."""
    rel = world["rel"]
    own = sh("git", "commit-tree", sh("git", "rev-parse", "HEAD^{tree}", cwd=rel), "-p", "HEAD", "-m", "my change", cwd=rel)
    sh("git", "update-ref", "refs/remotes/origin/mine", own, cwd=rel)
    sh("git", "branch", "mine", own, cwd=rel)
    sh("git", "config", "branch.mine.remote", "origin", cwd=rel)
    sh("git", "config", "branch.mine.merge", "refs/heads/mine", cwd=rel)
    before = refs(rel)
    with pytest.raises(FX.FixError, match=STOP):
        FX.new("say read")
    assert refs(rel) == before and sh("git", "config", "branch.mine.remote", cwd=rel) == "origin"


def test_a_mine_under_a_paused_rebase_with_a_commit_of_the_persons_stops_and_nothing_moves(world):
    rel = world["rel"]
    left(world)
    # the person's own commit on top of thimble's (sh commits as the made-up person t)
    mine = sh("git", "commit-tree", sh("git", "rev-parse", "mine^{tree}", cwd=rel), "-p", "mine", "-m", "my change",
              cwd=rel)
    sh("git", "update-ref", "refs/heads/mine", mine, cwd=rel)
    # a branch of theirs rebased onto mine, which stops at a conflict: HEAD is detached on top of mine while it lasts
    sh("git", "checkout", "-q", "-b", "topic", cwd=rel)
    (rel / "plugin" / "bar" / "bar.tsx").write_text("const words = `seen ${n}`\n")
    sh("git", "commit", "-q", "-am", "the bar says seen", cwd=rel)
    assert subprocess.run(["git", "rebase", "mine"], cwd=rel, capture_output=True).returncode != 0
    assert sh("git", "rev-parse", "HEAD", cwd=rel) == mine
    before = refs(rel)
    with pytest.raises(FX.FixError, match=STOP):
        FX.new("say read")
    assert refs(rel) == before


def test_a_mine_checked_out_in_another_worktree_stops_and_nothing_moves(world, tmp_path):
    rel = world["rel"]
    left(world)
    sh("git", "worktree", "prune", cwd=rel)
    sh("git", "worktree", "add", "-q", str(tmp_path / "elsewhere"), "mine", cwd=rel)
    before = refs(rel)
    with pytest.raises(FX.FixError, match=STOP):
        FX.new("say read")
    assert refs(rel) == before


def test_a_mine_another_home_uses_with_its_fixes_off_stops_and_nothing_moves(world, tmp_path, monkeypatch):
    rel = world["rel"]
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    FX.apply(r["id"], press(r["id"]))
    FX.all_off()  # that home's live shows the release commit, detached: no worktree has mine checked out
    before = refs(rel)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "another-home"))
    with pytest.raises(FX.FixError, match=STOP):
        FX.new("say read")
    assert refs(rel) == before


def test_a_home_with_records_stops_at_a_mine_and_nothing_moves(world):
    rel = world["rel"]
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    FX.apply(r["id"], press(r["id"]))
    # the home is gone but for its records
    records = (FX.home() / "fixes.jsonl").read_text()
    shutil.rmtree(FX.thimble_home())
    FX.home().mkdir(parents=True)
    (FX.home() / "fixes.jsonl").write_text(records)
    before = refs(rel)
    with pytest.raises(FX.FixError, match=STOP):
        FX.new("say read")
    assert refs(rel) == before


def test_a_branch_named_under_mine_stays_with_its_commits(world):
    """mine/wip, a branch of the person's own, checked out, is no leftover: it stays as it is, and git makes no mine
    beside it."""
    rel = world["rel"]
    left(world)
    sh("git", "branch", "-m", "mine", "mine-old", cwd=rel)  # as the line that names mine says
    sh("git", "checkout", "-q", "-b", "mine/wip", cwd=rel)
    wip = sh("git", "commit-tree", sh("git", "rev-parse", "HEAD^{tree}", cwd=rel), "-p", "HEAD", "-m", "my work", cwd=rel)
    sh("git", "update-ref", "refs/heads/mine/wip", wip, cwd=rel)
    with pytest.raises(FX.FixError):
        FX.new("say read")
    assert refs(rel, "refs/heads/mine/") == {"refs/heads/mine/wip": wip}
    assert sh("git", "log", "-1", "--format=%s", cwd=rel) == "my work"


def test_a_mine_a_worktree_rebases_stops_and_nothing_moves(world, tmp_path):
    rel = world["rel"]
    left(world)
    sh("git", "worktree", "prune", cwd=rel)
    wt = tmp_path / "rebasing"
    sh("git", "worktree", "add", "-q", str(wt), "mine", cwd=rel)
    # a rebase of mine that stopped: the worktree's HEAD is detached while it lasts
    assert subprocess.run(["git", "rebase", "-x", "false", "HEAD^"], cwd=wt, capture_output=True).returncode != 0
    assert "branch refs/heads/mine" not in sh("git", "worktree", "list", "--porcelain", cwd=rel)
    before = refs(rel)
    with pytest.raises(FX.FixError, match=STOP):
        FX.new("say read")
    assert refs(rel) == before


def test_a_new_home_moves_nothing_while_another_homes_live_is_in_the_clone(world, tmp_path, monkeypatch):
    rel = world["rel"]
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    FX.apply(r["id"], press(r["id"]))
    sh("git", "branch", "-m", "mine", "mine-old", cwd=rel)  # as the line that names mine says
    before = refs(rel, "refs/thimble/")
    assert set(before) == {"refs/thimble/fixes/1"}
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "another-home"))
    FX.new("say read")
    assert refs(rel, "refs/thimble/") == before and refs(rel, "refs/thimble-old/") == {}


def test_a_mine_with_a_fix_continue_recorded_moves_aside_and_one_with_more_of_the_persons_stops(world):
    rel = world["rel"]
    left(world, on=False)
    # on mine: a commit of the person's, then a fix that thimble update --continue recorded, which Claude committed as
    # the person (sh commits as the made-up person t)
    tree = sh("git", "rev-parse", "mine^{tree}", cwd=rel)
    own = sh("git", "commit-tree", tree, "-p", "mine", "-m", "my change", cwd=rel)
    fix = sh("git", "commit-tree", tree, "-p", own, "-m", "Bar says read", cwd=rel)
    sh("git", "update-ref", "refs/heads/mine", fix, cwd=rel)
    sh("git", "update-ref", "refs/thimble/fixes/2", fix, cwd=rel)
    before = refs(rel)
    with pytest.raises(FX.FixError, match=STOP):
        FX.new("say read")
    assert refs(rel) == before
    # the person's commit is on a remote's branch too: mine's own commit is the recorded fix alone, and mine moves aside
    sh("git", "update-ref", "refs/remotes/origin/my-change", own, cwd=rel)
    r = FX.new("say read")
    assert r["id"] == 1 and sh("git", "rev-parse", "mine", cwd=rel) == world["base"]
    aside = refs(rel, "refs/thimble-old/")
    assert [c for x, c in aside.items() if x.endswith("/heads/mine")] == [fix]
    assert refs(rel, "refs/remotes/") == {"refs/remotes/origin/my-change": own}
