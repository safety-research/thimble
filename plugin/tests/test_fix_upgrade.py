"""thimble fix and thimble update after thimble was updated another way than thimble update (scripts/install.sh, claude
plugin update, Claude Code's own update): while no fix is on, the release and its checkout follow the code that runs,
and a release checkout from before the launcher's hand-off runs nothing; a record an earlier thimble stored tells of
the sandbox; thimble update brings Claude Code's plugin to the release its clone has; the reapply prompt names the old
change from the home folder. The world is test_fixes.py's made-up thimble 0.10.2; `claude` is a fake. All data here is
made up."""
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


def on_top_of(new: str, fid: int) -> None:
    """Fix fid is on, on top of the release `new`, which Claude Code copies: the release and its checkout are `new`."""
    live = FX.live_dir()
    assert FX.get(fid)["state"] == "on" and sh("git", "rev-parse", "mine^", cwd=live) == new
    assert FX.release()["base"] == new and sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == new
    assert (live / "plugin" / "notes.md").read_text() == "made-up note\n"


@pytest.mark.parametrize("shallow", [True, False], ids=["shallow-clones", "whole-clones"])
def test_a_y_right_after_claude_plugin_update_puts_the_fix_onto_the_new_release(world, upstream, monkeypatch, shallow):
    if shallow:
        reclone(world, world["rel"])
    # a fix made on 0.10.2 and never used
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    # 0.10.3 is out, and claude plugin update (or a pull and scripts/install.sh) installs it; then, first of all, y
    if shallow:
        monkeypatch.setenv("GIT_COMMITTER_DATE", f"{int(time.time()) + 86400} +0000")
    new = upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    monkeypatch.delenv("GIT_COMMITTER_DATE", raising=False)
    reclone(world)
    installed(world, new)
    FX.apply(a["id"], press(a["id"]))
    on_top_of(new, a["id"])


def test_a_y_right_after_scripts_install_on_a_clone_install_puts_the_fix_onto_the_new_commit(world):
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    # the person's clone moves on, and scripts/install.sh --local installs it; then, first of all, y
    new = release_with(world, {"plugin/notes.md": "made-up note\n"})
    FX.apply(a["id"], press(a["id"]))
    on_top_of(new, a["id"])


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


def test_a_record_an_earlier_thimble_stored_tells_of_the_sandbox(world, capsys):
    from kernel import cli  # noqa: PLC0415

    release_with(world, {"plugin/cards/runner.mjs": "export const run = 1\n", "plugin/cards/ask.ts": "export const ask = 1\n"})
    r = FX.new("the runner says when it starts")
    (Path(r["work"]) / "plugin" / "cards" / "runner.mjs").write_text("export const run = 2\n")
    (Path(r["work"]) / "plugin" / "cards" / "ask.ts").write_text("export const ask = 2\n")
    r = FX.done(r["id"], "Runner says when it starts", "")
    # as 0.10.4 stored it: it neither refused nor named the card runner and its ask, so the record has no notice
    with open(FX.home() / "fixes.jsonl", "a") as f:
        f.write(json.dumps({k: v for k, v in r.items() if k != "notice"}) + "\n")
    notice = {"the sandbox": ["plugin/cards/ask.ts", "plugin/cards/runner.mjs"]}
    said = "This fix changes the sandbox (plugin/cards/ask.ts and plugin/cards/runner.mjs)."
    assert FX.get(r["id"])["notice"] == notice
    assert next(x for x in FX.listing()["fixes"] if x["id"] == r["id"])["notice"] == notice
    assert said in " ".join(" ".join(FX.show_lines(r["id"])).split())
    # the record the plugin's line reads before the person's y
    assert cli.main(["fix", "show", str(r["id"]), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["notice"] == notice
    assert cli.main(["fix", "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["fixes"][0]["notice"] == notice


def test_the_reapply_prompt_names_the_old_change_from_the_home_folder(world, upstream, monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))  # thimble's home (tmp_path/th) is in the home folder
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    FX.apply(r["id"], press(r["id"]))
    upstream({"plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "v0.10.3")
    assert FX.update()["aside"] == [r["id"]]
    text = FX.reapply_prompt().read_text()
    assert f"   Old change: ~/th/fixes/pending/0.10.3/fix-{r['id']}.patch (plugin/bar/bar.tsx)" in text
    assert str(tmp_path) not in text


def test_update_brings_claude_codes_plugin_to_the_release_its_clone_has(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    new = upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    # Claude Code refreshed its clone of the marketplace, at the release, and still runs 0.10.2; no fix was made
    reclone(world)
    before = len(calls(world))
    out = FX.update()
    assert calls(world)[before:] == ["plugin update thimble@thimble"]
    assert (out["newer"], out["to"], out["aside"], out["reload"]) == (True, "0.10.3", [], True)
    assert out["lines"] == [f"Updated thimble {world['base'][:7]} → 0.10.3 (terminal plugin)", "",
                            "Then  Terminal: /reload-plugins in Claude Code"]
    assert not FX.live_dir().exists()
    # once Claude Code runs the release, it is the newest
    installed(world, new)
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]
