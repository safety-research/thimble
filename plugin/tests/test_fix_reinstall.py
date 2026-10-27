"""thimble fix on a clone install whose thimble home was deleted, as INSTALL.md's uninstall says: the clone keeps the
branch mine and the refs under refs/thimble/. A new home's first request sets them aside under refs/thimble-old/ when
mine is thimble's own, and else stops with the line that names mine. The world is test_fixes.py's made-up thimble
0.10.2; `claude` is a fake. All data here is made up."""
from __future__ import annotations

import shutil
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
