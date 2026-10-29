"""thimble fix (engine/kernel/fixes.py): a y whose first pointing of Claude Code's marketplace fails changes nothing, a y
that fails after live moved (a fix that does not fit, a git error, Claude Code's copy) leaves live, its refs and the
fixes' on or off as they were, the way back runs only the release's own code, the notice names every file of the sandbox, and the quick tests run the copy's launcher. The world is test_fixes.py's made-up thimble 0.10.2; `claude` is a fake. All data here is made up."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, fake, live_file, made, press, release_with, sh, world  # noqa: E402, F401  (world is the fixture)

PLUGIN = Path(__file__).resolve().parents[1]


def snapshot(w, fid: int) -> dict:
    """What a y may change: mine and live, the fix's refs, Claude Code's settings, the records and the on/off state."""
    live = FX.live_dir()
    refs = sh("git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/thimble", cwd=live)
    state = FX.home() / "state.json"
    return {"mine": sh("git", "rev-parse", "mine", cwd=live), "head": sh("git", "rev-parse", "HEAD", cwd=live),
            "branch": sh("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=live),
            "status": sh("git", "status", "--porcelain", cwd=live), "refs": refs,
            "settings": (w["cc"] / "settings.json").read_text(), "record": FX.get(fid),
            "records": (FX.home() / "fixes.jsonl").read_text(), "release": FX.release(),
            "state": state.read_text() if state.exists() else None}


def failing_claudes(w) -> list[Path]:
    """A claude whose `plugin marketplace add` fails, and no claude at all."""
    bad = w["bin"] / "claude-fails"
    fake(bad, w["log"], 'case "$1 $2" in "plugin marketplace") echo "made-up failure" >&2; exit 3;; esac')
    return [bad, w["tmp"] / "no-such-claude"]


def test_a_y_whose_first_pointing_at_live_fails_changes_nothing_and_the_next_y_applies_the_fix(world, monkeypatch):
    r = made(world)
    r = FX.done(r["id"], "Bar says read", "")
    assert r["state"] == "ready"
    before = snapshot(world, r["id"])
    for claude in failing_claudes(world):
        monkeypatch.setenv("THIMBLE_CLAUDE", str(claude))
        with pytest.raises(FX.FixError):
            FX.apply(r["id"], press(r["id"]))
        assert snapshot(world, r["id"]) == before, claude.name
    # the next y applies the real change: one commit on the release, with the fix's change in it
    monkeypatch.setenv("THIMBLE_CLAUDE", str(world["bin"] / "claude"))
    FX.apply(r["id"], press(r["id"]))
    live = FX.live_dir()
    assert FX.get(r["id"])["state"] == "on" and "read ${n}" in live_file("plugin/bar/bar.tsx")
    assert sh("git", "log", "--format=%s", "mine", cwd=live).splitlines() == ["Bar says read", "thimble 0.10.2"]
    assert sh("git", "diff", "--name-only", "mine^", "mine", cwd=live) == "plugin/bar/bar.tsx"
    assert json.loads((world["cc"] / "settings.json").read_text())["extraKnownMarketplaces"]["thimble"]["source"] == {
        "source": "directory", "path": str(live)}
    # u then y: off, then on again with the same change
    FX.undo(r["id"])
    assert sh("git", "rev-parse", "mine", cwd=live) == world["base"] and "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    FX.apply(r["id"], press(r["id"]))
    assert FX.get(r["id"])["state"] == "on" and "read ${n}" in live_file("plugin/bar/bar.tsx")
    assert sh("git", "log", "--format=%s", "mine", cwd=live).splitlines() == ["Bar says read", "thimble 0.10.2"]


def test_a_y_on_a_fix_already_in_mine_adds_no_empty_commit(world):
    r = made(world)
    r = FX.done(r["id"], "Bar says read", "")
    live = FX.live_dir()
    # mine holds the fix's commit while its record still says ready (what a y that failed half way left before)
    sh("git", "checkout", "-q", "mine", cwd=live)
    sh("git", "merge", "-q", "--ff-only", f"refs/thimble/fixes/{r['id']}", cwd=live)
    FX.apply(r["id"], press(r["id"]))
    assert FX.get(r["id"])["state"] == "on" and FX.get(r["id"])["commit"] == r["commit"]
    assert sh("git", "log", "--format=%s", "mine", cwd=live).splitlines() == ["Bar says read", "thimble 0.10.2"]


def test_a_y_on_a_new_version_whose_first_pointing_at_live_fails_changes_nothing(world, monkeypatch):
    # a fix set aside with n (off, never on, so Claude Code's marketplace is not on live yet), then changed in place
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    FX.not_now(r["id"])
    r = FX.round_(r["id"], "say read with a count")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n ?? 0}"))
    r = FX.done(r["id"], "", "")
    assert r["state"] == "ready" and r["prev"]["state"] == "off" and FX.release()["pointed"] is False
    before = snapshot(world, r["id"])
    for claude in failing_claudes(world):
        monkeypatch.setenv("THIMBLE_CLAUDE", str(claude))
        with pytest.raises(FX.FixError):
            FX.apply(r["id"], press(r["id"]))
        assert snapshot(world, r["id"]) == before, claude.name
    monkeypatch.setenv("THIMBLE_CLAUDE", str(world["bin"] / "claude"))
    out = FX.apply(r["id"], press(r["id"]))
    assert out["changed"] is True and FX.get(r["id"])["state"] == "on"
    assert "read ${n ?? 0}" in live_file("plugin/bar/bar.tsx")
    assert sh("git", "log", "--format=%s", "mine", cwd=FX.live_dir()).splitlines() == ["Bar says read", "thimble 0.10.2"]


def live_now() -> dict:
    """What the person runs and is told runs: where live is, what its files say, and whether the fixes are on."""
    live = FX.live_dir()
    state = FX.home() / "state.json"
    return {"head": sh("git", "rev-parse", "HEAD", cwd=live), "branch": sh("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=live),
            "status": sh("git", "status", "--porcelain", cwd=live), "plugin.json": live_file(FX.PLUGIN_JSON),
            "state": state.read_text() if state.exists() else None}


def test_a_y_that_does_not_fit_while_the_fixes_are_off_leaves_them_off(world):
    # fix 1 and fix 2 change the same line in different ways; fix 1 is on, then the person turns every fix off
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    b = FX.new("say seen")
    (Path(b["work"]) / "plugin" / "bar" / "bar.tsx").write_text("const words = `seen ${n}`\n")
    FX.done(b["id"], "Bar says seen", "")
    FX.apply(a["id"], press(a["id"]))
    FX.all_off()
    before = live_now()
    assert before["branch"] == "HEAD" and before["head"] == world["base"] and not FX.is_on()
    # every fix is off, so the line names the fix it does not fit, never "the fixes you have on"
    with pytest.raises(FX.FixError, match="^fix 2 does not fit fix 1; /thimble-fix 2 tries it again$"):
        FX.apply(b["id"], press(b["id"]))
    # live and state.json as they were: the plain release, with every fix off; fix 2 needs a redo, fix 1 is kept for on
    assert live_now() == before and not FX.is_on()
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    assert FX.get(b["id"])["state"] == "redo" and FX.get(a["id"])["state"] == "on"
    FX.all_on()
    assert FX.is_on() and "read ${n}" in live_file("plugin/bar/bar.tsx")


def test_a_new_version_that_does_not_fit_while_the_fixes_are_off_leaves_them_off(world):
    # fix 1 adds a note and is off; its new version adds plugin/bar/extra.ts, which fix 2 adds too, and fix 2 is on;
    # then the person turns every fix off
    a = FX.new("a note")
    (Path(a["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(a["id"], "A note", "")
    FX.apply(a["id"], press(a["id"]))
    FX.undo(a["id"])
    r = FX.round_(a["id"], "and an extra file")
    (Path(r["work"]) / "plugin" / "bar" / "extra.ts").write_text("export const extra = 1\n")
    r = FX.done(r["id"], None, "Adds an extra file.")
    assert r["state"] == "ready" and r["prev"]["state"] == "off"
    b = FX.new("an extra file of its own")
    (Path(b["work"]) / "plugin" / "bar" / "extra.ts").write_text("export const extra = 2\n")
    FX.done(b["id"], "Extra two", "")
    FX.apply(b["id"], press(b["id"]))
    FX.all_off()
    before = live_now()
    with pytest.raises(FX.FixError, match="^the new version of fix 1 does not fit fix 2; /thimble-fix 1 tries it again$"):
        FX.apply(a["id"], press(a["id"]))
    # live and state.json as they were; fix 2 is kept for on, and fix 1's new version still waits for a y, its record
    # saying why it does not fit
    assert live_now() == before and not FX.is_on()
    assert not (FX.live_dir() / "plugin" / "bar" / "extra.ts").exists()
    assert FX.get(b["id"])["state"] == "on" and FX.get(a["id"])["state"] == "ready"
    assert FX.get(a["id"])["error"] == "its new version does not fit fix 2"
    FX.all_on()
    assert FX.is_on() and live_file("plugin/bar/extra.ts") == "export const extra = 2\n"
    # /thimble-fix 1, as the error says, tries it again: a new copy with the version the person has, the new version's
    # change to start from, and no reason left on the record
    r = FX.redo(a["id"])
    assert r["state"] == "working" and r["error"] is None and r["prev"]["state"] == "off"
    assert (Path(r["work"]) / "plugin" / "notes.md").exists()
    assert "extra = 1" in (FX.tmp_dir(a["id"]) / "earlier.patch").read_text()


def fails_after_the_move(w, monkeypatch, step: str, ref: str) -> None:
    """A failure after live moved: git's update of `ref` (step git), or Claude Code's copy of live (step copy)."""
    if step == "copy":
        bad = w["bin"] / "claude-copy-fails"
        fake(bad, w["log"], 'case "$1 $2" in "plugin update") echo "made-up failure" >&2; exit 3;; esac')
        monkeypatch.setenv("THIMBLE_CLAUDE", str(bad))
        return
    real = FX.git

    def git(*args, **kw):
        if args[:2] == ("update-ref", ref):
            raise FX.FixError(f"git update-ref {ref} failed: made-up failure")
        return real(*args, **kw)

    monkeypatch.setattr(FX, "git", git)


@pytest.mark.parametrize("step", ["git", "copy"])
def test_a_y_that_fails_after_live_moved_leaves_live_its_refs_and_state_as_they_were(world, monkeypatch, step):
    # fix 1 is on; fix 2 adds a note, and its y fails once its commit is in mine
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    FX.apply(a["id"], press(a["id"]))
    b = FX.new("a note")
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(b["id"], "A note", "")
    before = (snapshot(world, b["id"]), live_now())
    real_git = FX.git
    fails_after_the_move(world, monkeypatch, step, f"refs/thimble/fixes/{b['id']}")
    with pytest.raises(FX.FixError, match="made-up failure"):
        FX.apply(b["id"], press(b["id"]))
    # the same error, and live, mine, the fixes' refs, the records and state.json as they were
    assert (snapshot(world, b["id"]), live_now()) == before
    assert not (FX.live_dir() / "plugin" / "notes.md").exists() and FX.get(b["id"])["state"] == "ready"
    # with git and Claude Code working again, the next y applies it
    monkeypatch.setattr(FX, "git", real_git)
    monkeypatch.setenv("THIMBLE_CLAUDE", str(world["bin"] / "claude"))
    FX.apply(b["id"], press(b["id"]))
    assert FX.get(b["id"])["state"] == "on" and live_file("plugin/notes.md") == "made-up note\n"
    assert sh("git", "log", "--format=%s", "mine", cwd=FX.live_dir()).splitlines() == ["A note", "Bar says read", "thimble 0.10.2"]


@pytest.mark.parametrize("step", ["git", "copy"])
def test_a_y_on_a_new_version_that_fails_after_live_moved_leaves_live_its_refs_and_state_as_they_were(world, monkeypatch,
                                                                                                      step):
    # fix 1 is on, and a round made its new version, which waits for a y; the y fails once mine was rebuilt with it
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    FX.apply(a["id"], press(a["id"]))
    r = FX.round_(a["id"], "say read with a count")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n ?? 0}"))
    r = FX.done(r["id"], "", "")
    assert r["state"] == "ready" and r["prev"]["state"] == "on"
    before = (snapshot(world, a["id"]), live_now())
    fails_after_the_move(world, monkeypatch, step, f"refs/thimble/prev/{a['id']}")
    with pytest.raises(FX.FixError, match="made-up failure"):
        FX.apply(a["id"], press(a["id"]))
    # mine holds the version the person has; the fix's ref, its new version (next/) and state.json as they were
    assert (snapshot(world, a["id"]), live_now()) == before
    assert "read ${n}" in live_file("plugin/bar/bar.tsx") and FX.get(a["id"])["state"] == "ready"


def test_the_release_checkout_is_put_back_as_the_release_has_it(world):
    made(world)
    rel = FX.release_dir()
    (rel / "plugin" / "bar" / "bar.tsx").write_text("const words = 'changed by hand'\n")
    (rel / "plugin" / "engine").mkdir(parents=True, exist_ok=True)
    (rel / "plugin" / "engine" / "getpass.py").write_text("WHO = 'planted'\n")
    (rel / "plugin" / "engine" / "__pycache__").mkdir()
    (rel / "plugin" / "engine" / "__pycache__" / "getpass.cpython-312.pyc").write_bytes(b"made-up")
    FX.place_release(world["base"])
    assert sh("git", "rev-parse", "HEAD", cwd=rel) == world["base"]
    assert (rel / "plugin" / "bar" / "bar.tsx").read_text() == "const words = `coverage ${n}`\n"
    assert not (rel / "plugin" / "engine").exists()
    assert sh("git", "status", "--porcelain", "--ignored", cwd=rel) == ""


def test_the_way_back_runs_only_the_releases_code_whatever_was_added_to_its_checkout(world, tmp_path):
    real = PLUGIN / "bin" / "thimble"
    release_with(world, {"plugin/bin/thimble": real.read_text(),
                         "plugin/engine/thimble.py": "import getpass\nimport sys\n"
                                                     "print('made-up kernel', getattr(getpass, 'WHO', 'python'), *sys.argv[1:])\n"})
    made(world)
    rel = FX.release_dir()

    def ran(launcher: Path, *args: str) -> str:
        p = subprocess.run([str(launcher), *args], capture_output=True, text=True, cwd=tmp_path,
                           env={**os.environ, "THIMBLE_PYTHON": sys.executable})
        return p.stdout.strip() or f"exit {p.returncode}: {p.stderr.strip()}"

    # the plugin and the shell's link run the release's launcher; live's hands the way back to it
    for launcher in (rel / "plugin" / "bin" / "thimble", FX.live_dir() / "plugin" / "bin" / "thimble"):
        (rel / "plugin" / "engine" / "getpass.py").write_text("WHO = 'planted'\n")
        (rel / "plugin" / "bar" / "bar.tsx").write_text("const words = 'changed by hand'\n")
        assert ran(launcher, "fix", "list") == "made-up kernel python fix list", launcher
        assert not (rel / "plugin" / "engine" / "getpass.py").exists()
        assert (rel / "plugin" / "bar" / "bar.tsx").read_text() == "const words = `coverage ${n}`\n"
        assert sh("git", "rev-parse", "HEAD", cwd=rel) == world["base"]


def test_a_fix_to_the_card_runner_or_its_ask_gets_the_sandbox_notice_also_when_it_moves_them(world):
    release_with(world, {"plugin/cards/ask.ts": "export const ask = 1\n", "plugin/cards/runner.mjs": "export const run = 1\n"})
    a = FX.new("cards may ask more")
    wt = Path(a["work"])
    (wt / "plugin" / "cards" / "ask.ts").write_text("export const ask = 2\n")
    (wt / "plugin" / "cards" / "runner.mjs").write_text("export const run = 2\n")
    a = FX.done(a["id"], "Cards ask more", "")
    assert a["state"] == "ready" and a["notice"] == {"the sandbox": ["plugin/cards/ask.ts", "plugin/cards/runner.mjs"]}
    assert FX.notice_said(a) == "This fix changes the sandbox (plugin/cards/ask.ts and plugin/cards/runner.mjs)."
    b = FX.new("rename the card runner")
    wt = Path(b["work"])
    (wt / "plugin" / "cards" / "runner.mjs").rename(wt / "plugin" / "cards" / "run.mjs")
    b = FX.done(b["id"], "Card runner renamed", "")
    assert b["state"] == "ready" and b["notice"] == {"the sandbox": ["plugin/cards/runner.mjs"]}


def test_the_quick_tests_fail_a_fix_that_breaks_the_launcher_or_the_kernels_command_without_pytest(world, monkeypatch):
    engine = {str(p.relative_to(PLUGIN.parent)): p.read_text() for p in (PLUGIN / "engine").rglob("*.py")
              if "__pycache__" not in p.parts}
    release_with(world, {"plugin/bin/thimble": (PLUGIN / "bin" / "thimble").read_text(), **engine})
    # the default quick tests on a machine whose Python has no pytest; the hooks tests' claude is the fake
    monkeypatch.delenv("THIMBLE_FIX_TESTS")
    monkeypatch.setattr(FX, "_has_pytest", lambda py: False)
    monkeypatch.setenv("PATH", f"{world['bin']}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("THIMBLE_PYTHON", sys.executable)
    ok = made(world)
    assert FX.done(ok["id"], "Bar says read", "")["state"] == "ready"
    broken = {"plugin/engine/kernel/cli.py": lambda t: t.replace("def main(", "def main(:", 1),
              "plugin/bin/thimble": lambda t: "#!/bin/sh\nexit 9\n"}
    for path, edit in broken.items():
        r = FX.new(f"change {path}")
        p = Path(r["work"]) / path
        p.write_text(edit(p.read_text()))
        r = FX.done(r["id"], "A change", "")
        assert r["state"] == "failed" and r["tests"] == "failed", path
