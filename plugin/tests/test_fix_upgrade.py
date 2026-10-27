"""thimble fix after thimble was updated another way than thimble update (scripts/install.sh, claude plugin update,
Claude Code's own update): while no fix is on, the release and its checkout follow the code that runs, and a release
checkout from before the launcher's hand-off runs nothing. The world is test_fixes.py's made-up thimble 0.10.2; `claude`
is a fake. All data here is made up."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, calls, made, press, release_with, sh, upstream, world  # noqa: E402, F401  (fixtures)

PLUGIN = Path(__file__).resolve().parents[1]
# a launcher from before the hand-off to the release checkout, as 0.10.4's: it runs its own kernel
OLD_LAUNCHER = '#!/bin/sh\nexec "${THIMBLE_PYTHON:-python3}" "$(cd "$(dirname "$0")/.." && pwd)/engine/thimble.py" "$@"\n'
# a made-up kernel that says which checkout it runs in, by the checkout's folder
KERNEL = "import pathlib, sys\nprint(pathlib.Path(__file__).resolve().parents[2].name, *sys.argv[1:])\n"


def installed(w, commit: str) -> None:
    """Claude Code runs the plugin at `commit` now (installed_plugins.json), as after claude plugin update."""
    p = w["cc"] / "plugins" / "installed_plugins.json"
    d = json.loads(p.read_text())
    d["plugins"]["thimble@thimble"][0]["gitCommitSha"] = commit
    p.write_text(json.dumps(d))


def reclone(w, source: Path | None = None) -> Path:
    """Claude Code clones its marketplace again, one commit deep, at the newest commit of the made-up upstream (or of
    `source`)."""
    cc_clone = w["cc"] / "plugins" / "marketplaces" / "thimble"
    shutil.rmtree(cc_clone)
    sh("git", "clone", "-q", "--depth", "1", f"file://{source or w['tmp'] / 'upstream.git'}", str(cc_clone))
    return cc_clone


@pytest.mark.parametrize("shallow", [True, False], ids=["shallow-clones", "whole-clones"])
def test_a_home_with_no_fix_on_follows_the_plugin_another_way_updated(world, upstream, monkeypatch, shallow):
    old = world["base"]
    if shallow:
        reclone(world, world["rel"])  # Claude Code's clone is one commit deep, and so is live, a clone of it
    # a fix made on 0.10.2 and never used: live and the release checkout at 0.10.2, Claude Code's marketplace as it was
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == old and FX.release()["pointed"] is False
    assert sh("git", "rev-parse", "--is-shallow-repository", cwd=FX.live_dir()) == str(shallow).lower()
    # 0.10.3 is out (a day later: a shallow live has no history to say which comes first), and scripts/install.sh has
    # Claude Code clone it again and install it
    if shallow:
        monkeypatch.setenv("GIT_COMMITTER_DATE", f"{int(time.time()) + 86400} +0000")
    new = upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    monkeypatch.delenv("GIT_COMMITTER_DATE", raising=False)
    reclone(world)
    installed(world, new)
    # the first fix after it: the release, its checkout and mine are 0.10.3, and the fix's copy is cut from it
    b = FX.new("a longer note")
    live = FX.live_dir()
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == new
    assert (FX.release()["base"], FX.release()["tag"]) == (new, "v0.10.3") and new in (FX.home() / "off.sh").read_text()
    assert b["base"] == new and sh("git", "rev-parse", "mine", cwd=live) == new
    assert sh("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=live) == "mine"
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up note, longer\n")
    assert FX.done(b["id"], "A longer note", "")["state"] == "ready"
    # the second one too; and the fix made on 0.10.2 goes on, on top of 0.10.3
    c = FX.new("a third change")
    assert c["base"] == new and sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == new
    FX.apply(a["id"], press(a["id"]))
    assert FX.get(a["id"])["state"] == "on" and sh("git", "rev-parse", "mine^", cwd=live) == new


def test_a_clone_install_follows_its_plugin_until_a_fix_goes_on(world):
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    # the person's clone moves on, and scripts/install.sh --local installs it
    new = release_with(world, {"plugin/notes.md": "made-up note\n"})
    FX.new("a note")
    assert FX.release()["base"] == new and sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == new
    assert sh("git", "rev-parse", "mine", cwd=FX.live_dir()) == new
    # once a fix is on, Claude Code loads live, and the release moves only with thimble update
    FX.apply(r["id"], press(r["id"]))
    release_with(world, {"plugin/other.md": "made-up\n"})
    FX.new("one more")
    assert FX.release()["base"] == new and sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == new


def test_a_release_checkout_from_before_the_hand_off_runs_nothing(world, tmp_path):
    release_with(world, {"plugin/bin/thimble": OLD_LAUNCHER, "plugin/engine/thimble.py": KERNEL})
    made(world)  # live and the release checkout at that release
    # another way updated the plugin: the clone's launcher, which the shell's link runs, is this one
    release_with(world, {"plugin/bin/thimble": (PLUGIN / "bin" / "thimble").read_text()})
    launcher = world["rel"] / "plugin" / "bin" / "thimble"

    def ran(*args: str) -> str:
        p = subprocess.run([str(launcher), *args], capture_output=True, text=True, cwd=tmp_path,
                           env={**os.environ, "THIMBLE_PYTHON": sys.executable})
        return p.stdout.strip() or f"exit {p.returncode}: {p.stderr.strip()}"

    # the release checkout's launcher has no hand-off: this launcher runs its own kernel (the clone's, "thimble")
    assert ran("fix", "list") == "thimble fix list" and ran("update") == "thimble update"
    # its kernel moves the release checkout forward, and the way back runs from it again
    FX.new("say read")
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == world["base"]
    assert ran("fix", "list") == "release fix list"
