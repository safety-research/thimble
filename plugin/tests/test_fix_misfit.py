"""What the line of a fix that does not fit names (_misfit): the release, when it changed the fix's lines since the release
the fix was made on; the one fix on in its way; or the person's other fixes. All data made up."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, on_fix, press, sh, upstream, world, commit_in_checkout  # noqa: E402, F401
from test_fix_upgrade import reclone, installed  # noqa: E402

def said(fid: int) -> str:
    """The line a y on fix `fid` gives, which does not fit."""
    with pytest.raises(FX.FixError) as e:
        FX.apply(fid, press(fid))
    return str(e.value)


def bar(w, fid_rec, text):
    (Path(fid_rec["work"]) / "plugin" / "bar" / "bar.tsx").write_text(text)


# A. only the release changed the file; the fix was made while an unrelated fix was on (set aside at the update)
def test_only_the_release_changed_the_file_of_a_fix_made_while_another_fix_was_on(world, upstream):
    n = FX.new("a note")
    (Path(n["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(n["id"], "A note", "")
    FX.apply(n["id"], press(n["id"]))
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    upstream({"plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "v0.10.3")
    assert FX.update()["aside"] == [n["id"]]
    m = said(a["id"])
    assert m == f"fix {a['id']} does not fit thimble 0.10.3; /thimble-fix {a['id']} tries it again"


# A2. as A, and the unrelated fix is brought back (on, other file) before the y
def test_only_the_release_changed_it_with_the_other_fix_on_again(world, upstream):
    n = FX.new("a note")
    (Path(n["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(n["id"], "A note", "")
    FX.apply(n["id"], press(n["id"]))
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    upstream({"plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "v0.10.3")
    FX.update()
    live = FX.live_dir()
    (live / "plugin" / "notes.md").write_text("made-up note\n")
    sh("git", "add", "plugin/notes.md", cwd=live)
    sh("git", "commit", "-q", "-m", "A note", cwd=live)
    assert FX.continue_()["recorded"] == [n["id"]]
    m = said(a["id"])
    assert m == f"fix {a['id']} does not fit thimble 0.10.3; /thimble-fix {a['id']} tries it again"


# B. only another fix changed it, no release move: names that fix
def test_only_another_fix_changed_it_names_that_fix(world):
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    b = FX.new("say seen")
    bar(world, b, "const words = `seen ${n}`\n")
    FX.done(b["id"], "Bar says seen", "")
    FX.apply(b["id"], press(b["id"]))
    m = said(a["id"])
    assert m == f"fix {a['id']} does not fit fix {b['id']}; /thimble-fix {a['id']} tries it again"


# B2. only another fix changed it, after a release move that left the file alone: names that fix
def test_only_another_fix_changed_it_after_a_release_that_left_the_file_alone(world, upstream):
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    FX.update()
    b = FX.new("say seen")
    bar(world, b, "const words = `seen ${n}`\n")
    FX.done(b["id"], "Bar says seen", "")
    FX.apply(b["id"], press(b["id"]))
    m = said(a["id"])
    assert m == f"fix {a['id']} does not fit fix {b['id']}; /thimble-fix {a['id']} tries it again"


# C. both: the release added a line, one other fix on the new release changed the fix's line
def test_the_release_and_one_fix_changed_it(world, upstream):
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    upstream({"plugin/bar/bar.tsx": "const words = `coverage ${n}`\nconst title = 'bar'\n"}, "v0.10.3")
    FX.update()
    b = FX.new("say seen")
    bar(world, b, "const words = `seen ${n}`\nconst title = 'bar'\n")
    FX.done(b["id"], "Bar says seen", "")
    FX.apply(b["id"], press(b["id"]))
    m = said(a["id"])
    assert m == (f"fix {a['id']} does not fit thimble 0.10.3 and your other fixes; /thimble-fix {a['id']} "
                 "tries it again")


# D. made on another fix's lines, no release change at all; that fix turned off
def test_made_on_another_fix_s_lines_with_no_release_change_says_your_other_fixes(world):
    a = on_fix(world)
    b = FX.new("say read twice")
    bar(world, b, "const words = `read read ${n}`\n")
    FX.done(b["id"], "Bar says read twice", "")
    FX.undo(a["id"])
    assert FX.get(a["id"])["state"] == "off"
    m = said(b["id"])
    assert m == f"fix {b['id']} does not fit your other fixes; /thimble-fix {b['id']} tries it again"


# D3. mixed: made on another fix's lines, that fix set aside, and the release changed the file elsewhere
def test_made_on_a_set_aside_fix_s_lines_while_the_release_changed_the_file_elsewhere(world, upstream):
    a = on_fix(world)
    b = FX.new("say read twice")
    bar(world, b, "const words = `read read ${n}`\n")
    FX.done(b["id"], "Bar says read twice", "")
    upstream({"plugin/bar/bar.tsx": "const words = `coverage ${n}`\nconst title = 'bar'\n"}, "v0.10.3")
    assert FX.update()["aside"] == [a["id"]]
    m = said(b["id"])
    # by the brief's rule (release changed the file since, no other fix on): the release
    assert m == f"fix {b['id']} does not fit thimble 0.10.3; /thimble-fix {b['id']} tries it again"


# E. dev install: the person's checkout moved on and changed the line: "thimble main at abc1234"
def test_a_dev_install_whose_checkout_changed_the_line_names_the_checkout(world, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    new = commit_in_checkout(world, {"plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "made-up work")
    FX.update()
    assert FX.release()["checkout"] == f"main at {new[:7]}"
    m = said(a["id"])
    assert m == f"fix {a['id']} does not fit thimble main at {new[:7]}; /thimble-fix {a['id']} tries it again"


# F. a shallow GitHub install, thimble update: names the release
def test_a_shallow_live_after_thimble_update_names_the_release(world, upstream):
    reclone(world, world["rel"])
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    assert sh("git", "rev-parse", "--is-shallow-repository", cwd=FX.live_dir()) == "true"
    upstream({"plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "v0.10.3")
    FX.update()
    m = said(a["id"])
    assert m == f"fix {a['id']} does not fit thimble 0.10.3; /thimble-fix {a['id']} tries it again"


# F2. shallow GitHub install, claude plugin update (the release follows before the first fix goes on)
def test_a_shallow_live_after_claude_plugin_update_names_the_release(world, upstream, monkeypatch):
    reclone(world, world["rel"])
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    monkeypatch.setenv("GIT_COMMITTER_DATE", f"{int(time.time()) + 86400} +0000")
    new = upstream({"plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "v0.10.3")
    monkeypatch.delenv("GIT_COMMITTER_DATE", raising=False)
    reclone(world)
    installed(world, new)
    m = said(a["id"])
    assert FX.release()["base"] == new
    assert m.startswith(f"fix {a['id']} does not fit thimble ") and "your other fixes" not in m


# G. a fix changed in place (a round of an off fix), then a release that changed its line: the new version's line
def test_a_new_version_of_an_off_fix_names_the_release_that_changed_its_line(world, upstream):
    a = on_fix(world)
    FX.undo(a["id"])
    r = FX.round_(a["id"], "say read twice")
    bar(world, r, "const words = `read twice ${n}`\n")
    FX.done(a["id"], "Bar says read", "")
    assert FX.get(a["id"]).get("prev")
    upstream({"plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "v0.10.3")
    FX.update()
    m = said(a["id"])
    assert m == f"the new version of fix {a['id']} does not fit thimble 0.10.3; /thimble-fix {a['id']} tries it again"


# H. an off fix (was on, undone before the update), the release changed its line
def test_an_off_fix_names_the_release_that_changed_its_line(world, upstream):
    a = on_fix(world)
    FX.undo(a["id"])
    upstream({"plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "v0.10.3")
    assert FX.update()["aside"] == []
    m = said(a["id"])
    assert m == f"fix {a['id']} does not fit thimble 0.10.3; /thimble-fix {a['id']} tries it again"


# R1. the new release holds the lines the fix was made on (the fix under it was released), and one fix on is in its way
def test_a_release_that_holds_the_lines_the_fix_was_made_on_names_the_one_fix_in_its_way(world, upstream):
    a = on_fix(world)
    b = FX.new("a title")
    bar(world, b, "const words = `read ${n}`\nconst title = 'bar'\n")
    FX.done(b["id"], "Bar has a title", "")
    upstream({"plugin/bar/bar.tsx": "const words = `read ${n}`\n"}, "v0.10.3")
    assert FX.update()["aside"] == [a["id"]]
    c = FX.new("another title")
    bar(world, c, "const words = `read ${n}`\nconst title = 'baz'\n")
    FX.done(c["id"], "Bar has another title", "")
    FX.apply(c["id"], press(c["id"]))
    live = FX.live_dir()
    # the release's file is the one fix 2 was made on
    assert sh("git", "diff", "--quiet", f"refs/thimble/fixes/{b['id']}^", FX.release()["base"], "--",
              "plugin/bar/bar.tsx", cwd=live) == ""
    m = said(b["id"])
    assert m == f"fix {b['id']} does not fit fix {c['id']}; /thimble-fix {b['id']} tries it again"


# R1b. the same on a dev install: the person committed fix 1's change to their checkout, and thimble update released it
def test_a_dev_install_that_released_the_fix_under_it_names_the_one_fix_in_its_way(world, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)
    b = FX.new("a title")
    bar(world, b, "const words = `read ${n}`\nconst title = 'bar'\n")
    FX.done(b["id"], "Bar has a title", "")
    commit_in_checkout(world, {"plugin/bar/bar.tsx": "const words = `read ${n}`\n"}, "Bar says read")
    assert FX.update()["had"] == [a["id"]]
    c = FX.new("another title")
    bar(world, c, "const words = `read ${n}`\nconst title = 'baz'\n")
    FX.done(c["id"], "Bar has another title", "")
    FX.apply(c["id"], press(c["id"]))
    m = said(b["id"])
    assert m == f"fix {b['id']} does not fit fix {c['id']}; /thimble-fix {b['id']} tries it again"


# R3. shallow GitHub install: a fix made on another fix's lines, a release that left its file alone
def test_a_shallow_live_made_on_another_fix_s_lines_with_the_file_left_alone_says_your_other_fixes(world, upstream):
    reclone(world, world["rel"])
    a = on_fix(world)
    assert sh("git", "rev-parse", "--is-shallow-repository", cwd=FX.live_dir()) == "true"
    b = FX.new("say read twice")
    bar(world, b, "const words = `read read ${n}`\n")
    FX.done(b["id"], "Bar says read twice", "")
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    assert FX.update()["aside"] == [a["id"]]
    m = said(b["id"])
    assert m == f"fix {b['id']} does not fit your other fixes; /thimble-fix {b['id']} tries it again"
