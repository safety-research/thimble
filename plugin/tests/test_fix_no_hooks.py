"""thimble fix (engine/kernel/fixes.py) in a clone whose post-checkout hook fails, as git-lfs's does when git-lfs is not on
the kernel's PATH: thimble's own git calls that make or move a fix's copy, and the checkouts of live that put a fix on or
take it out, run no hook of the clone's, so the person can make, apply and undo a fix, change it in place, redo it and
merge fixes, and off.sh shows the release. The world is test_fixes.py's made-up thimble 0.10.2. All data here is
made up."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, live_file, made, on_fix, press, sh, world  # noqa: E402, F401  (world is the fixture)


@pytest.fixture(autouse=True)
def own_home(tmp_path, monkeypatch):
    """A home of the test's own, so that no git setting of the person's reaches the made-up repositories."""
    (tmp_path / "home").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.delenv("GIT_CONFIG_GLOBAL", raising=False)


def failing_hook(w, tmp_path: Path) -> Path:
    """The person's clone's post-checkout hook, which every worktree of it runs: it writes where it ran, and fails."""
    hooks = tmp_path / "made-up-hooks"
    hooks.mkdir()
    ran = tmp_path / "hook-ran"
    (hooks / "post-checkout").write_text(f"#!/bin/sh\npwd -P >> '{ran}'\necho 'git-lfs: command not found' >&2\nexit 2\n")
    (hooks / "post-checkout").chmod(0o755)
    sh("git", "config", "core.hooksPath", str(hooks), cwd=w["rel"])
    return ran


def in_no_copy(ran: Path) -> None:
    """The hook ran in no fix's copy (work/<id>, tmp/<id>/merge)."""
    places = ran.read_text().splitlines() if ran.exists() else []
    home = str(FX.home().resolve())
    assert not [p for p in places if p.startswith(home + os.sep + "work") or p.startswith(home + os.sep + "tmp")]


def test_a_clone_with_a_failing_post_checkout_hook_can_make_apply_and_undo_a_fix(world, tmp_path):
    ran = failing_hook(world, tmp_path)
    r = made(world)
    assert r["state"] == "working" and Path(r["work"]).is_dir()
    assert FX.done(r["id"], "Bar says read", "")["state"] == "ready"
    FX.apply(r["id"], press(r["id"]))
    assert FX.get(r["id"])["state"] == "on" and "read ${n}" in live_file("plugin/bar/bar.tsx")
    FX.undo(r["id"])
    assert FX.get(r["id"])["state"] == "off" and "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    assert sh("git", "rev-parse", "HEAD", cwd=FX.live_dir()) == world["base"]
    in_no_copy(ran)


def test_a_clone_with_a_failing_post_checkout_hook_can_change_a_fix_in_place_redo_one_and_merge_fixes(world, tmp_path,
                                                                                                    monkeypatch):
    ran = failing_hook(world, tmp_path)
    a = on_fix(world)
    # a round changes the fix in place: its copy, and the checkouts that make its new version there (settle); y swaps the
    # new version in, and u goes back to the one before
    r = FX.round_(a["id"], "it breaks when I click")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n ?? 0}"))
    assert FX.done(r["id"], None, "The read item works when clicked.")["state"] == "ready"
    FX.apply(a["id"], press(a["id"]))
    assert "read ${n ?? 0}" in live_file("plugin/bar/bar.tsx")
    assert FX.undo(a["id"])["back"] is True and "read ${n}`" in live_file("plugin/bar/bar.tsx")
    # a fix whose tests fail starts again in a new copy
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "false")
    b = FX.new("a note")
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    assert FX.done(b["id"], "A note", "")["state"] == "failed"
    b = FX.redo(b["id"], "a shorter note")
    assert b["state"] == "working" and Path(b["work"]).is_dir()
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "true")
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up\n")
    assert FX.done(b["id"], "A note", "")["state"] == "ready"
    FX.apply(b["id"], press(b["id"]))
    # two fixes that are on become one
    out = FX.merge([a["id"], b["id"]], press(a["id"]))
    assert out["merged"] == [b["id"]] and FX.get(a["id"])["state"] == "on"
    assert sh("git", "log", "--format=%s", "mine", cwd=FX.live_dir()).splitlines() == ["Bar says read", "thimble 0.10.2"]
    assert (FX.live_dir() / "plugin" / "notes.md").read_text() == "made-up\n"
    in_no_copy(ran)


def test_a_clone_with_a_failing_post_checkout_hook_can_undo_and_merge_fixes_while_they_are_off(world, tmp_path):
    ran = failing_hook(world, tmp_path)
    a = on_fix(world)
    r = FX.round_(a["id"], "it breaks when I click")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n ?? 0}"))
    FX.done(r["id"], None, "The read item works when clicked.")
    FX.apply(a["id"], press(a["id"]))
    b = FX.new("a note")
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(b["id"], "A note", "")
    FX.apply(b["id"], press(b["id"]))
    # the person turns their fixes off: live shows the release while they are off
    subprocess.run(["sh", str(FX.home() / "off.sh")], capture_output=True, check=True)
    assert not FX.is_on() and sh("git", "rev-parse", "HEAD", cwd=FX.live_dir()) == world["base"]
    assert FX.undo(a["id"])["back"] is True
    assert sh("git", "rev-parse", "HEAD", cwd=FX.live_dir()) == world["base"]
    assert FX.merge([a["id"], b["id"]], press(a["id"]))["merged"] == [b["id"]]
    assert sh("git", "rev-parse", "HEAD", cwd=FX.live_dir()) == world["base"]
    FX.undo(a["id"])
    assert FX.get(a["id"])["state"] == "off" and sh("git", "rev-parse", "HEAD", cwd=FX.live_dir()) == world["base"]
    in_no_copy(ran)


def test_a_round_that_no_longer_fits_its_fix_fails_with_its_words_in_a_clone_with_a_failing_post_checkout_hook(world,
                                                                                                             tmp_path):
    ran = failing_hook(world, tmp_path)
    a = on_fix(world)
    r = FX.round_(a["id"], "it breaks when I click")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n ?? 0}"))
    # the fix changed since the round's copy was cut: its version now changes the same line in another way
    other = tmp_path / "other"
    sh("git", "-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "--detach", str(other), world["base"],
       cwd=world["rel"])
    (other / "plugin" / "bar" / "bar.tsx").write_text("const words = `read ${count}`\n")
    sh("git", "commit", "-q", "-am", "a made-up other version", cwd=other)
    sh("git", "update-ref", f"refs/thimble/fixes/{a['id']}", sh("git", "rev-parse", "HEAD", cwd=other),
       cwd=FX.live_dir())
    got = FX.done(r["id"], None, "The read item works when clicked.", tests=False)
    assert (got["state"], got["error"]) == ("failed", f"its change does not fit fix {a['id']} as it is now")
    assert sh("git", "rev-parse", "HEAD", cwd=Path(r["work"])) == got["commit"]
    in_no_copy(ran)


def test_off_sh_shows_the_release_in_a_clone_with_a_failing_post_checkout_hook(world, tmp_path):
    on_fix(world)
    ran = failing_hook(world, tmp_path)
    p = subprocess.run(["sh", str(FX.home() / "off.sh")], capture_output=True, text=True)
    assert p.returncode == 0 and "plain release" in p.stdout, p.stdout + p.stderr
    assert sh("git", "rev-parse", "HEAD", cwd=FX.live_dir()) == world["base"] and not FX.is_on()
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx") and not ran.exists()

