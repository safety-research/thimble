"""thimble fix (engine/kernel/fixes.py): a y whose first pointing of Claude Code's marketplace fails changes nothing, the
way back runs only the release's own code, the notice names every file of the sandbox, and the quick tests run the
copy's launcher. The world is test_fixes.py's made-up thimble 0.10.2; `claude` is a fake. All data here is made up."""
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
