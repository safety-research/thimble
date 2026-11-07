"""thimble fix (engine/kernel/fixes.py): a request, the fixer's end, the person's y (never Claude's), undo, off and on,
the files no fix may change, and an update that puts the fixes back. Each test has its own THIMBLE_HOME, Claude Code
config folder and made-up release repository; `claude` and `gh` are fakes that log their arguments. All data here is
made up."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import fixes as FX  # noqa: E402

GIT_ID = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t",
          "GIT_COMMITTER_EMAIL": "t@example.com"}


def sh(*cmd: str, cwd: Path | None = None) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True, env={**os.environ, **GIT_ID}).stdout.strip()


def fake(path: Path, log: Path, body: str = "") -> Path:
    path.write_text(f"#!/bin/sh\necho \"$@\" >> '{log}'\n{body}\nexit 0\n")
    path.chmod(0o755)
    return path


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A clone install of a made-up thimble 0.10.2: the release repository, Claude Code's config with a directory
    marketplace on it, and fakes for claude and gh."""
    rel = tmp_path / "thimble"
    (rel / "plugin" / ".claude-plugin").mkdir(parents=True)
    (rel / "plugin" / "bar").mkdir()
    (rel / "plugin" / "sandbox").mkdir()
    (rel / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "thimble", "version": "0.10.2"}, indent=2) + "\n")
    (rel / "plugin" / "bar" / "bar.tsx").write_text("const words = `coverage ${n}`\n")
    (rel / "plugin" / "sandbox" / "package.json").write_text("{}\n")
    sh("git", "init", "-q", "-b", "main", cwd=rel)
    sh("git", "add", "-A", cwd=rel)
    sh("git", "commit", "-q", "-m", "thimble 0.10.2", cwd=rel)
    base = sh("git", "rev-parse", "HEAD", cwd=rel)
    cc = tmp_path / "cc"
    (cc / "plugins").mkdir(parents=True)
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {
        "source": {"source": "directory", "path": str(rel)}, "installLocation": str(rel)}}))
    (cc / "plugins" / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {"thimble@thimble": [
        {"scope": "user", "installPath": str(cc / "plugins" / "cache" / "x"), "gitCommitSha": base}]}}))
    (cc / "settings.json").write_text(json.dumps({"extraKnownMarketplaces": {"thimble": {"source": {"source": "directory", "path": str(rel)}}},
                                                  "theme": "light"}, indent=2))
    log = tmp_path / "calls.log"
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cc))
    monkeypatch.setenv("THIMBLE_CLAUDE", str(fake(bin_ / "claude", log)))
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "true")
    for k, v in GIT_ID.items():
        monkeypatch.setenv(k, v)
    # the quick tests run in the sandbox runtime, which these tests do not install
    monkeypatch.setattr(FX, "sandbox_argv", lambda fid: ["/bin/bash", "-c"])
    return {"rel": rel, "base": base, "cc": cc, "log": log, "tmp": tmp_path}


def press(fid: int) -> str:
    """The plugin's part of a key press: a secret, its sha256 in asks/<id>.json."""
    secret = os.urandom(16).hex()
    FX.write_json(FX.home() / "asks" / f"{fid}.json", {"key": FX.key_hash(secret)})
    return secret


def calls(w) -> list[str]:
    return w["log"].read_text().splitlines() if w["log"].exists() else []


def live_file(name: str) -> str:
    return (FX.live_dir() / name).read_text()


def made(w, words="say read, not coverage", edit=True) -> dict:
    r = FX.new(words)
    if edit:
        p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
        p.write_text(p.read_text().replace("coverage", "read"))
    return r


def test_a_request_makes_a_copy_and_changes_nothing_the_person_runs(world):
    r = made(world, edit=False)
    assert r["id"] == 1 and r["state"] == "working" and Path(r["work"]).is_dir()
    assert sh("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=FX.live_dir()) == "mine"
    assert sh("git", "rev-parse", "HEAD", cwd=FX.live_dir()) == world["base"]
    # a clone install: live is a worktree of the person's clone, so mine shows there
    assert "mine" in sh("git", "branch", "--list", "mine", cwd=world["rel"])
    assert calls(world) == [] and FX.release()["pointed"] is False
    assert json.loads((world["cc"] / "settings.json").read_text())["extraKnownMarketplaces"]["thimble"]["source"]["path"] == str(world["rel"])


def test_ready_then_y_commits_to_mine_points_the_marketplace_and_copies(world):
    r = made(world)
    r = FX.done(r["id"], "Bar says read", "The bar's coverage item says read.")
    assert r["state"] == "ready" and r["tests"] == "passed"
    assert r["files"] == [{"path": "plugin/bar/bar.tsx", "add": 1, "del": 1}]
    assert sh("git", "rev-parse", f"refs/thimble/fixes/{r['id']}", cwd=FX.live_dir()) == r["commit"]
    # y without the person's key does nothing
    with pytest.raises(FX.FixError):
        FX.apply(r["id"], "a-guess")
    assert FX.get(r["id"])["state"] == "ready"
    out = FX.apply(r["id"], press(r["id"]))
    assert out["reload"] is True
    rec = FX.get(r["id"])
    assert rec["state"] == "on" and rec["work"] is None and not Path(r["work"]).exists()
    assert "read ${n}" in live_file("plugin/bar/bar.tsx")
    log = sh("git", "log", "--format=%s|%an", "mine", cwd=FX.live_dir()).splitlines()
    assert log[0] == "Bar says read|thimble" and len(log) == 2
    # Claude Code's own copy: its version names this state, its settings and marketplace point at live
    v = json.loads(live_file("plugin/.claude-plugin/plugin.json"))["version"]
    assert v.startswith("0.10.2+fix.") and out["version"] == v
    assert f"plugin marketplace add {FX.live_dir()}" in calls(world) and "plugin update thimble@thimble" in calls(world)
    s = json.loads((world["cc"] / "settings.json").read_text())
    assert s["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(FX.live_dir())}
    assert s["theme"] == "light"


def test_apply_typed_in_the_persons_terminal_asks_and_never_runs_for_claude(world, monkeypatch):
    r = made(world)
    r = FX.done(r["id"], "Bar says read", "The bar's coverage item says read.")
    # a command Claude Code runs: CLAUDECODE is set and there is no terminal, so it is refused before any question
    monkeypatch.setattr(FX, "at_person_terminal", lambda: False)
    with pytest.raises(FX.FixError, match="your own terminal"):
        FX.apply_typed(r["id"], answer=lambda q: "y")
    assert FX.get(r["id"])["state"] == "ready"
    # the person's terminal: no keeps it ready, y puts it on
    monkeypatch.setattr(FX, "at_person_terminal", lambda: True)
    asked = []
    assert FX.apply_typed(r["id"], answer=lambda q: asked.append(q) or "n") is None
    assert FX.get(r["id"])["state"] == "ready" and asked == ['Use fix 1 "Bar says read" now? [y/N] ']
    out = FX.apply_typed(r["id"], answer=lambda q: "y")
    assert out["reload"] is True and FX.get(r["id"])["state"] == "on"
    assert "read ${n}" in live_file("plugin/bar/bar.tsx")
    # Claude Code's Bash tool marks its commands
    monkeypatch.undo()
    monkeypatch.setenv("CLAUDECODE", "1")
    assert FX.at_person_terminal() is False


def test_undo_takes_the_commit_out_and_keeps_it_for_on(world):
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    FX.apply(r["id"], press(r["id"]))
    FX.undo(r["id"])
    assert FX.get(r["id"])["state"] == "off"
    assert sh("git", "rev-parse", "mine", cwd=FX.live_dir()) == world["base"]
    assert json.loads(live_file("plugin/.claude-plugin/plugin.json"))["version"] == "0.10.2"
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    # on again from the list (the person's u): the kept commit
    FX.apply(r["id"], press(r["id"]))
    assert FX.get(r["id"])["state"] == "on" and "read ${n}" in live_file("plugin/bar/bar.tsx")


def on_with_a_round(world, path="plugin/bar/bar.tsx", text=None) -> int:
    """A fix that is on, and a round of it that waits for the person's y (on · change ready)."""
    if text is None:
        r = made(world)
    else:
        r = FX.new("a note")
        (Path(r["work"]) / path).write_text(text)
    FX.done(r["id"], "A fix", "")
    FX.apply(r["id"], press(r["id"]))
    x = FX.round_(r["id"], "more of it")
    p = Path(x["work"]) / path
    p.write_text(p.read_text().replace("read", "read read") if text is None else text + "more\n")
    FX.done(r["id"], "A fix", "")
    assert FX.state_word(FX.get(r["id"])) == "on · change ready"
    return r["id"]


def test_off_and_remove_take_out_a_fix_changed_in_place(world):
    fid = on_with_a_round(world)
    # off while a round waits: the version on comes out, and the new version still waits for the person's key
    assert FX.one_off(fid)["said"].startswith(f"Fix {fid} is off")
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx") and FX.state_word(FX.get(fid)) == "ready"
    FX.apply(fid, press(fid))
    assert "read read ${n}" in live_file("plugin/bar/bar.tsx")
    # off after that y is off, not the version before; on brings back the newest version
    FX.one_off(fid)
    assert FX.get(fid)["state"] == "off" and "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    FX.apply(fid, press(fid))
    assert "read read ${n}" in live_file("plugin/bar/bar.tsx")
    FX.remove(fid)
    assert sh("git", "rev-parse", "mine", cwd=FX.live_dir()) == world["base"]
    # remove while a round waits: the fix stays out when mine is made again for another fix
    note = on_with_a_round(world, "plugin/notes.md", "made-up note\n")
    FX.remove(note)
    c = made(world)
    FX.done(c["id"], "Bar says read", "")
    FX.apply(c["id"], press(c["id"]))
    assert sh("git", "log", "--format=%s", "mine", cwd=FX.live_dir()).splitlines() == ["Bar says read", "thimble 0.10.2"]


def test_u_after_y_on_a_fix_changed_in_place_brings_back_the_version_before(world):
    fid = on_with_a_round(world)
    FX.apply(fid, press(fid))
    assert FX.undo(fid)["back"] is True
    assert FX.get(fid)["state"] == "on" and "read ${n}" in live_file("plugin/bar/bar.tsx")


def test_off_and_on_and_off_sh(world):
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    FX.apply(r["id"], press(r["id"]))
    FX.all_off()
    assert sh("git", "rev-parse", "HEAD", cwd=FX.live_dir()) == world["base"] and not FX.is_on()
    assert FX.get(r["id"])["state"] == "on"  # kept for on
    FX.all_on()
    assert FX.is_on() and "read ${n}" in live_file("plugin/bar/bar.tsx")
    # off.sh lives outside live and needs no thimble to run
    out = subprocess.run(["sh", str(FX.home() / "off.sh")], capture_output=True, text=True, check=True).stdout
    assert "plain release" in out and sh("git", "rev-parse", "HEAD", cwd=FX.live_dir()) == world["base"]
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx") and not FX.is_on()


WAY_BACK = "no fix may change the code that turns fixes off and undoes them, or the scan a shared fix goes through"


def test_a_fix_may_not_change_the_way_back_and_its_record_names_the_safety_files_it_changes(world):
    r = FX.new("let fixes skip the scan")
    (Path(r["work"]) / "plugin" / "engine" / "kernel").mkdir(parents=True)
    (Path(r["work"]) / "plugin" / "engine" / "kernel" / "privacy.py").write_text("def scan(*a): return [], []\n")
    r = FX.done(r["id"], "Skip the scan", "")
    # the refusal names each file with what it is, and why; the refused try's title does not rename the fix
    assert r["state"] == "failed" and r["error"] == f"it changes plugin/engine/kernel/privacy.py (the privacy scan); {WAY_BACK}"
    assert r["title"] == "let fixes skip the scan"
    with pytest.raises(FX.FixError):
        FX.apply(r["id"], press(r["id"]))
    b = FX.new("an image")
    (Path(b["work"]) / "plugin" / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00")
    assert FX.done(b["id"], "Logo", "")["state"] == "failed"
    assert FX.protected_why(["plugin/fix/line.ts", "plugin/engine/kernel/privacy.py", "plugin/fix/pane.tsx"]) == (
        "it changes plugin/fix/line.ts and plugin/fix/pane.tsx (the fix flow) and plugin/engine/kernel/privacy.py (the "
        f"privacy scan); {WAY_BACK}")
    # the sandbox, the launcher, thimble's scripts and lock files may change: the record names them by kind, and the
    # person reads the sentence before they press y, and in thimble fix show
    c = FX.new("cards draw on Node 26")
    wt = Path(c["work"])
    for path in ("plugin/cards/argv.mjs", "plugin/sandbox/package-lock.json", "browser/frontend/package-lock.json",
                 "plugin/bin/thimble", "scripts/install.sh"):
        (wt / path).parent.mkdir(parents=True, exist_ok=True)
        (wt / path).write_text("made-up\n")
    c = FX.done(c["id"], "Cards draw on Node 26", "The card runner starts with --allow-net.")
    assert c["state"] == "ready" and c["title"] == "Cards draw on Node 26"
    assert c["notice"] == {"the sandbox": ["plugin/cards/argv.mjs", "plugin/sandbox/package-lock.json"],
                           "the launcher": ["plugin/bin/thimble"], "thimble's scripts": ["scripts/install.sh"],
                           "dependencies": ["browser/frontend/package-lock.json"]}
    said = ("This fix changes the sandbox (plugin/cards/argv.mjs and plugin/sandbox/package-lock.json), the launcher "
            "(plugin/bin/thimble), thimble's scripts (scripts/install.sh), and dependencies "
            "(browser/frontend/package-lock.json).")
    assert FX.notice_said(c) == said
    assert said in " ".join(" ".join(FX.show_lines(c["id"])).split())
    FX.apply(c["id"], press(c["id"]))
    assert FX.get(c["id"])["state"] == "on" and FX.get(c["id"])["notice"] == c["notice"]
    assert (FX.live_dir() / "plugin" / "cards" / "argv.mjs").read_text() == "made-up\n"
    # a fix that changes none of them has no notice
    d = made(world)
    assert "notice" not in FX.done(d["id"], "Bar says read", "") and FX.notice_said(FX.get(d["id"])) == ""


def as_github(w) -> Path:
    """The install as a GitHub one: Claude Code's own clone of the marketplace, at the installed commit. A release
    update is for GitHub installs; a clone install follows the person's checkout (test_dev_install_*)."""
    cc_clone = w["cc"] / "plugins" / "marketplaces" / "thimble"
    if cc_clone.exists():
        sh("git", "fetch", "-q", str(w["rel"]), "+refs/heads/*:refs/heads/*", "--update-head-ok", cwd=cc_clone)
        sh("git", "reset", "-q", "--hard", w["base"], cwd=cc_clone)
    else:
        sh("git", "clone", "-q", str(w["rel"]), str(cc_clone))
    (w["cc"] / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {
        "source": {"source": "github", "repo": "made-up/thimble"}, "installLocation": str(cc_clone)}}))
    return cc_clone


@pytest.fixture
def upstream(world, tmp_path, monkeypatch):
    """thimble's repository as a made-up upstream: a bare repository whose tag v0.10.2 is the installed release, and
    publish(files, tag) adds a release on top of the newest one. The install is a GitHub one."""
    as_github(world)
    bare = tmp_path / "upstream.git"
    sh("git", "clone", "-q", "--bare", str(world["rel"]), str(bare))
    sh("git", "tag", "v0.10.2", world["base"], cwd=bare)
    work = tmp_path / "upstream-work"
    sh("git", "clone", "-q", str(bare), str(work))
    monkeypatch.setenv("THIMBLE_UPDATE_URL", str(bare))

    def publish(files: dict[str, str], tag: str, version: str | None = None) -> str:
        for path, text in files.items():
            p = work / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        if version:
            (work / "plugin" / ".claude-plugin" / "plugin.json").write_text(
                json.dumps({"name": "thimble", "version": version}, indent=2) + "\n")
        sh("git", "add", "-A", cwd=work)
        sh("git", "commit", "-q", "-m", f"thimble {tag}", cwd=work)
        sh("git", "tag", "-a", tag, "-m", tag, cwd=work)
        sh("git", "push", "-q", "origin", "HEAD:refs/heads/main", tag, cwd=work)
        return sh("git", "rev-parse", "HEAD", cwd=work)

    return publish


def three_fixes(world) -> tuple[int, int, int]:
    """Three fixes that are on: the bar's word, a new note, and the legend's count."""
    a = made(world, "the bar should say read, not coverage")
    FX.done(a["id"], "Bar says read", "The bar's coverage item says read.")
    FX.apply(a["id"], press(a["id"]))
    b = FX.new("a note for the people I work with")
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(b["id"], "A note", "")
    FX.apply(b["id"], press(b["id"]))
    c = FX.new("the legend should count the files nobody read\nlike the untouched ones")
    (Path(c["work"]) / "plugin" / "legend.ts").write_text("const legend = `untouched ${n}`\n")
    FX.done(c["id"], "Legend counts untouched", "The coverage legend says how many files are untouched.")
    FX.apply(c["id"], press(c["id"]))
    return a["id"], b["id"], c["id"]


def test_update_puts_back_the_fixes_that_fit_and_reapply_brings_back_the_one_that_does_not(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    assert FX.update()["newer"] is False  # v0.10.2 is what runs
    sh("git", "tag", "v0.10.2", world["base"], cwd=FX.live_dir())  # live has the tags too
    FX.write_json(FX.home() / "release.json", {k: v for k, v in FX.release().items() if k != "tag"})
    assert FX.update(check=True)["from"] == "0.10.2"
    # 0.10.3 has the note as it is, and its own legend on the line fix c changed
    new = upstream({"plugin/notes.md": "made-up note\n", "plugin/legend.ts": "const legend = `quiet ${n} files`\n"},
                   "v0.10.3", version="0.10.3")
    calls_before = len(calls(world))
    out = FX.update()
    assert (out["from"], out["to"], out["back"], out["had"], out["aside"]) == ("0.10.2", "0.10.3", [a], [b], [c])
    # the bar's word is on again, on top of 0.10.3; the note is 0.10.3's own; the legend is 0.10.3's
    live = FX.live_dir()
    assert sh("git", "rev-parse", "mine^", cwd=live) == new and "read ${n}" in live_file("plugin/bar/bar.tsx")
    assert live_file("plugin/legend.ts") == "const legend = `quiet ${n} files`\n"
    assert sh("git", "log", "--format=%s|%an", "-1", "mine", cwd=live) == "Bar says read|thimble"
    assert FX.release()["tag"] == "v0.10.3" and FX.release()["base"] == new and new in (FX.home() / "off.sh").read_text()
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == new  # the way back runs from the new release
    assert FX.get(a)["state"] == "on" and FX.get(a)["commit"] == sh("git", "rev-parse", "mine", cwd=live)
    assert FX.get(a)["commit"] == sh("git", "rev-parse", f"refs/thimble/fixes/{a}", cwd=live)
    assert (FX.get(b)["state"], FX.get(b)["released_in"]) == ("released", "0.10.3")
    # the legend does not fit 0.10.3: it is off, set aside with its old change as a patch, and says why
    r = FX.get(c)
    assert r["state"] == "pending" and r["note"] == "set aside at the update to 0.10.3"
    assert r["error"] == "it does not fit thimble 0.10.3"
    assert Path(r["pending"]["old"]) == FX.home() / "pending" / "0.10.3" / f"fix-{c}.patch"
    assert "Subject: [PATCH] Legend counts untouched" in Path(r["pending"]["old"]).read_text()
    assert r["pending"]["files"] == ["plugin/legend.ts"]
    assert out["lines"] == [
        "Updated thimble 0.10.2 → 0.10.3 (terminal plugin)", "",
        "Your fix is on again, replayed onto 0.10.3: Bar says read.",
        "Already in 0.10.3, so it leaves thimble fixes: A note.", "",
        "1 local fix does not fit 0.10.3, so it is off: Legend counts untouched.", "",
        "Bring it back:  thimble reapply",
        "  Claude opens, checks each fix against 0.10.3, keeps what is still needed, and turns it on.", "",
        "Then  Terminal: /reload-plugins in Claude Code"]
    assert out["reload"] is True and calls(world)[calls_before:].count("plugin update thimble@thimble") == 1
    # the list: the bar's word on, the legend off with why, and thimble reapply first under What next; the person's key
    # cannot put an old change on
    rows = FX.list_lines(120)
    assert rows[0] == "Your thimble fixes · thimble 0.10.3 with 1 on, 1 off"
    assert [x.split()[:2] for x in rows[3:5]] == [[str(a), "on"], [str(c), "off"]]
    assert f"  fix {c} is off: it does not fit thimble 0.10.3" in rows
    nxt = rows[rows.index("What next") + 1]
    assert nxt.split()[:2] == ["thimble", "reapply"] and "the 1 fix thimble update set aside" in nxt
    assert "  Set aside     it does not fit thimble 0.10.3" in FX.show_lines(c, 100)
    with pytest.raises(FX.FixError, match="thimble reapply"):
        FX.apply(c, press(c))
    # thimble reapply: Claude Code in live, with the prompt made from the records of the fix still set aside
    r = FX.reapply_argv()
    assert r["argv"][0] == os.environ["THIMBLE_CLAUDE"] and r["cwd"] == str(live) and r["carried"] is None
    text = r["argv"][1]
    assert text == Path(r["prompt"]).read_text() and Path(r["prompt"]) == FX.home() / "pending" / "0.10.3.md"
    assert ("The person updated thimble from 0.10.2 to 0.10.3. thimble set aside 1 fix of theirs, made with thimble fix; "
            "it is listed below, and this copy of 0.10.3 does not have it.") in text
    assert "(`git log v0.10.2..v0.10.3` and the diff" in text and "{{" not in text
    assert sh("git", "log", "--format=%s", "v0.10.2..v0.10.3", cwd=live) == "thimble v0.10.3"
    made_on = FX._date(FX.get(c)["created"])
    assert (f"1. Legend counts untouched (fix {c}, {made_on}, terminal)\n"
            f"   They asked: \"the legend should count the files nobody read like the untouched ones\"\n"
            f"   It did: The coverage legend says how many files are untouched.\n"
            f"   Old change: {FX.home() / 'pending' / '0.10.3' / f'fix-{c}.patch'} (plugin/legend.ts)") in text
    assert "Bar says read" not in text and "run `thimble update --continue`" in text
    # Claude brings back the legend's count, fitted to 0.10.3's legend
    (live / "plugin" / "legend.ts").write_text("const legend = `quiet ${n} files · untouched ${m}`\n")
    sh("git", "commit", "-q", "-am", "Legend counts untouched", cwd=live)
    done = FX.continue_()
    assert done["recorded"] == [c] and done["left_out"] == [] and done["reload"] is True
    assert done["lines"][0].startswith("Recorded 1 fix on thimble 0.10.3, now on: Legend counts untouched (")
    assert done["lines"][-1] == "In Claude Code, type /reload-plugins to load them."
    assert FX.get(a)["state"] == "on" and FX.get(c)["commit"] == sh("git", "rev-parse", "mine", cwd=live)
    assert FX.get(c)["state"] == "on" and FX.get(c)["error"] is None
    assert not (FX.home() / "pending" / "current.json").exists()
    with pytest.raises(FX.FixError, match="no fixes are set aside"):
        FX.continue_()
    with pytest.raises(FX.FixError, match="no fixes are set aside"):
        FX.reapply_argv()
    # the fix the release has leaves the list; thimble fix show still has it
    rows = FX.list_lines(120)
    assert rows[0] == "Your thimble fixes · thimble 0.10.3 with 2 on" and not any(" A note " in x for x in rows)
    assert any(x.startswith("  In 0.10.3") for x in FX.show_lines(b))
    # the next update finds nothing newer, and changes nothing; an undo keeps the recorded fix, now part of mine
    head = sh("git", "rev-parse", "mine", cwd=live)
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]
    assert sh("git", "rev-parse", "mine", cwd=live) == head
    FX.undo(a)
    assert "untouched ${m}" in live_file("plugin/legend.ts") and "coverage ${n}" in live_file("plugin/bar/bar.tsx")
