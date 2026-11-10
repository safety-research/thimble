"""thimble fix (engine/kernel/fixes.py): a request, the fixer's end, the person's y (never Claude's), undo, off and on,
the files no fix may change, and an update that puts the fixes back. Each test has its own THIMBLE_HOME, Claude Code
config folder and made-up release repository; `claude` and `gh` are fakes that log their arguments. All data here is
made up."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from kernel import fixes as FX  # noqa: E402
from releases_server import Releases  # noqa: E402

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


def am_on_the_release(world, patch: Path) -> Path:
    """A clean checkout of the release, with `patch` applied by git am, which fails on a patch that does not apply."""
    clean = world["tmp"] / f"clean-{len(list(world['tmp'].glob('clean-*')))}"
    sh("git", "clone", "-q", "--no-checkout", str(world["rel"]), str(clean))
    sh("git", "checkout", "-q", "--detach", world["base"], cwd=clean)
    sh("git", "am", "-q", str(patch), cwd=clean)
    return clean


def test_the_export_of_a_fix_carries_the_fixes_it_builds_on_so_that_git_am_applies_it_to_the_release(world):
    """A fix made while another is on, which changes the line the other changed: its patch alone does not apply to the
    release, so the export carries the other fix first and says so, as it does for a fix whose record says it refines
    the other. A fix that stands alone exports as before."""
    a = made(world)
    FX.done(a["id"], "Bar says read", "The bar's coverage item says read.")
    FX.apply(a["id"], press(a["id"]))
    b = FX.new("say read twice")
    bar = Path(b["work"]) / "plugin" / "bar" / "bar.tsx"
    bar.write_text(bar.read_text().replace("read", "read read"))
    FX.done(b["id"], "Bar says read twice", "")
    c = FX.new("a note for the people I work with")
    (Path(c["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(c["id"], "A note", "")
    out = world["tmp"] / "out"
    assert FX.export(b["id"], str(out)) == [str(out / "thimble-fix-2.patch"), str(out / "thimble-fix-2.md"),
                                            "Fix 2 builds on fix 1 (Bar says read), so the patch carries it first."]
    clean = am_on_the_release(world, out / "thimble-fix-2.patch")
    assert sh("git", "log", "--format=%s", cwd=clean).splitlines() == ["Bar says read twice", "Bar says read",
                                                                     "thimble 0.10.2"]
    assert (clean / "plugin" / "bar" / "bar.tsx").read_text() == "const words = `read read ${n}`\n"
    # fix 3 sits on fix 1 too, and changes none of its lines: its own commit's patch, as before
    assert FX.export(c["id"], str(out)) == [str(out / "thimble-fix-3.patch"), str(out / "thimble-fix-3.md")]
    alone = FX.run(["git", "format-patch", "--stdout", "-1", FX.get(c["id"])["commit"]], cwd=FX.live_dir()).stdout
    assert (out / "thimble-fix-3.patch").read_text() == alone
    clean = am_on_the_release(world, out / "thimble-fix-3.patch")
    assert sh("git", "log", "--format=%s", cwd=clean).splitlines() == ["A note", "thimble 0.10.2"]
    # a follow-up made as a fix of its own (thimble 0.10.1 and before), whose record says it refines fix 1
    FX.put({**FX.get(c["id"]), "refines": a["id"]})
    assert FX.export(c["id"], str(out))[2:] == ["Fix 3 builds on fix 1 (Bar says read), so the patch carries it first."]
    clean = am_on_the_release(world, out / "thimble-fix-3.patch")
    assert sh("git", "log", "--format=%s", cwd=clean).splitlines() == ["A note", "Bar says read", "thimble 0.10.2"]


def test_the_export_of_a_fix_that_is_on_follows_where_mine_holds_it(world):
    """As found live: a fix made on the release goes on after another fix whose change is in the lines around its own.
    As mine holds it, its patch touches the other fix's lines, so the export carries the other fix first. Once the other
    fix is off, mine holds the fix on the release alone, and so does its export."""
    items = "".join(f"const item{i} = {i}\n" for i in range(1, 9))
    (world["rel"] / "plugin" / "bar" / "items.ts").write_text(items)
    sh("git", "add", "plugin/bar/items.ts", cwd=world["rel"])
    sh("git", "commit", "-q", "-m", "thimble 0.10.2 with the bar's items", cwd=world["rel"])
    old, world["base"] = world["base"], sh("git", "rev-parse", "HEAD", cwd=world["rel"])
    installed = world["cc"] / "plugins" / "installed_plugins.json"
    installed.write_text(installed.read_text().replace(old, world["base"]))
    ids = []
    for words, was, now in (("item two is twenty", "item2 = 2\n", "item2 = 20\n"),
                            ("item five is fifty", "item5 = 5\n", "item5 = 50\n")):
        r = FX.new(words)
        p = Path(r["work"]) / "plugin" / "bar" / "items.ts"
        p.write_text(p.read_text().replace(was, now))
        ids.append(FX.done(r["id"], words.capitalize(), "")["id"])
    FX.apply(ids[1], press(ids[1]))
    FX.apply(ids[0], press(ids[0]))
    out = world["tmp"] / "out"
    assert FX.export(ids[0], str(out))[2:] == ["Fix 1 builds on fix 2 (Item five is fifty), so the patch carries it first."]
    clean = am_on_the_release(world, out / "thimble-fix-1.patch")
    both = items.replace("item2 = 2\n", "item2 = 20\n").replace("item5 = 5\n", "item5 = 50\n")
    assert (clean / "plugin" / "bar" / "items.ts").read_text() == both
    FX.one_off(ids[1])
    assert FX.export(ids[0], str(out))[2:] == []
    clean = am_on_the_release(world, out / "thimble-fix-1.patch")
    assert (clean / "plugin" / "bar" / "items.ts").read_text() == items.replace("item2 = 2\n", "item2 = 20\n")


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


def test_a_change_whose_tests_fail_keeps_the_end_of_their_output_and_names_the_log_for_the_next_fixer(world, monkeypatch):
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "for n in $(seq 1 20); do echo made-up line $n; done; exit 1")
    r = made(world)
    r = FX.done(r["id"], "Bar says read", "")
    assert r["state"] == "failed" and r["tests"] == "failed" and r["error"] == "its tests failed in the sandbox"
    # the record keeps the last lines, and the refusal names the file that holds them all, which the next fixer reads
    log = FX.tmp_dir(r["id"]) / "tests.log"
    assert r["tests_tail"].splitlines()[0] == "made-up line 9" and "made-up line 1\n" in log.read_text()
    assert r["refused"] == {"why": "its tests failed in the sandbox", "files": [], "tests": r["tests_tail"], "log": str(log)}
    # another round in the same copy keeps the refusal for its fixer
    assert FX.again(r["id"])["refused"]["log"] == str(log)


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
    publish(files, tag) adds a release on top of the newest one. Each release has its file attached on a stand-in for
    GitHub (releases_server.py, THIMBLE_RELEASES_URL; world["gh"]), as the release's Action attaches it. The install is
    a GitHub one, as an install before release files made it."""
    as_github(world)
    bare = tmp_path / "upstream.git"
    sh("git", "clone", "-q", "--bare", str(world["rel"]), str(bare))
    sh("git", "tag", "v0.10.2", world["base"], cwd=bare)
    work = tmp_path / "upstream-work"
    sh("git", "clone", "-q", str(bare), str(work))
    monkeypatch.setenv("THIMBLE_UPDATE_URL", str(bare))
    gh = world["gh"] = Releases(tmp_path / "releases", bare)
    gh.publish(bare, "v0.10.2")
    monkeypatch.setenv("THIMBLE_RELEASES_URL", gh.url)

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
        gh.publish(bare, tag)
        return sh("git", "rev-parse", "HEAD", cwd=work)

    yield publish
    gh.stop()


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
    # the bar's word is on again, on top of 0.10.3, whose release commit the update made from its file (downloaded once);
    # the note is 0.10.3's own; the legend is 0.10.3's
    live = FX.live_dir()
    made = sh("git", "rev-parse", "refs/thimble/releases/v0.10.3", cwd=live)
    assert world["gh"].files() == ["/releases/download/v0.10.3/thimble-0.10.3.tar.gz"]
    assert sh("git", "rev-parse", f"{made}^{{tree}}", cwd=live) == sh("git", "rev-parse", "v0.10.3^{tree}",
                                                                       cwd=world["tmp"] / "upstream.git")
    assert sh("git", "rev-parse", "mine^", cwd=live) == made and "read ${n}" in live_file("plugin/bar/bar.tsx")
    assert live_file("plugin/legend.ts") == "const legend = `quiet ${n} files`\n"
    assert sh("git", "log", "--format=%s|%an", "-1", "mine", cwd=live) == "Bar says read|thimble"
    rel = FX.release()
    assert (rel["kind"], rel["tag"], rel["base"], rel["commit"]) == ("release", "v0.10.3", made, new)
    assert made in (FX.home() / "off.sh").read_text()
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == made  # the way back runs from the new release
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
    assert ("The person updated thimble from 0.10.2 to 0.10.3. thimble set aside 1 fix that they made with thimble fix. "
            "This copy of 0.10.3 does not have it, and it is listed below.") in text
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


def test_the_workbench_s_server_packages_are_compiled_once_also_where_an_older_install_left_them_uncompiled(world,
                                                                                                         monkeypatch):
    """The workbench on live (browser_on_live, which thimble update and the install run): the server's packages again
    when uv.lock changed, or when they are not compiled to bytecode, which a kernel never writes. An install or update
    by thimble 0.10.12 or before left them uncompiled under the same uv.lock. Packages linked from a clone that were
    never compiled are compiled in live, and the clone stays as it was."""
    tmp = world["tmp"]
    tools = tmp / "tools.log"
    fake(tmp / "bin" / "uv", tools, 'mkdir -p "$3/.venv"')
    fake(tmp / "bin" / "npm", tools, '[ "$3" = run ] && mkdir -p "$2/dist" && echo page > "$2/dist/index.html"')
    monkeypatch.setenv("PATH", f"{tmp / 'bin'}:{os.environ['PATH']}")
    monkeypatch.setenv("THIMBLE_BROWSER_HOME", str(tmp / "bh"))
    (tmp / "bh").mkdir()
    b = FX.live_dir() / "browser"
    for part, lock, pkgs in FX.BROWSER_LOCKS:
        (b / part / pkgs).mkdir(parents=True)
        (b / part / lock).write_text(f"made-up {lock}\n")
    # as an install by thimble 0.10.12 left them: stamped with their lock files, and not compiled
    FX.write_json(FX.home() / "browser.json", {lock: FX._sha_of(b / part / lock) for part, lock, _ in FX.BROWSER_LOCKS})
    sync = f"sync --project {b / 'backend'} --python >=3.12,<3.15 --frozen --no-dev --no-install-project --extra dev --compile-bytecode"

    def syncs() -> int:
        return tools.read_text().splitlines().count(sync)

    got = FX.browser_on_live()
    assert (got["browser"], got["browser_did"], syncs()) == ("ready", ["backend packages installed"], 1)
    assert FX.browser_compiled(b) and (FX.home() / "browser-ready").is_file()
    assert (FX.browser_on_live()["browser_did"], syncs()) == ([], 1)
    # packages linked from a clone whose install did not compile them: uv compiles them in live
    clone = tmp / "clone" / "browser"
    for part, lock, pkgs in FX.BROWSER_LOCKS:
        (clone / part / pkgs).mkdir(parents=True)
        (clone / part / pkgs / "made-up-package.txt").write_text("x\n")
        (clone / part / lock).write_text(f"made-up {lock}\n")
    (tmp / "bh" / "checkout").write_text(f"{clone}\n")
    shutil.rmtree(b / "backend" / ".venv")
    assert FX.browser_on_live()["browser_did"] == ["backend packages linked", "backend packages compiled"]
    assert syncs() == 2 and FX.browser_compiled(b) and (b / "backend" / ".venv" / "made-up-package.txt").is_file()
    assert not (clone / "backend" / ".venv" / FX.COMPILED).exists()
    # a clone's packages that were compiled come linked with their mark, and uv has nothing to do
    (clone / "backend" / ".venv" / FX.COMPILED).touch()
    shutil.rmtree(b / "backend" / ".venv")
    assert (FX.browser_on_live()["browser_did"], syncs()) == (["backend packages linked"], 2)
    assert FX.browser_compiled(b)


def test_an_update_says_when_the_headless_chromium_the_workbench_checks_cards_in_could_not_be_fetched(world,
                                                                                                     monkeypatch):
    """The workbench on live (browser_on_live, which thimble update and the install run) ends with the headless Chromium
    it draws cards in, where it uses Playwright's: the workbench's own check fetches what is missing (python -m
    app.headless --fetch). When it is still missing, the update's lines say so, with the command that fetches it."""
    tmp = world["tmp"]
    tools = tmp / "tools.log"
    fake(tmp / "bin" / "uv", tools, 'mkdir -p "$3/.venv"')
    fake(tmp / "bin" / "npm", tools, '[ "$3" = run ] && mkdir -p "$2/dist" && echo page > "$2/dist/index.html"')
    monkeypatch.setenv("PATH", f"{tmp / 'bin'}:{os.environ['PATH']}")
    monkeypatch.setenv("THIMBLE_BROWSER_HOME", str(tmp / "bh"))
    (tmp / "bh").mkdir()
    b = FX.live_dir() / "browser"
    for part, lock, pkgs in FX.BROWSER_LOCKS:
        (b / part / pkgs).mkdir(parents=True)
        (b / part / lock).write_text(f"made-up {lock}\n")
    (b / "backend" / ".venv" / "bin").mkdir()
    lacks = {"ok": False, "why": "no headless Chromium, so cards are not checked (its download failed: made-up)",
             "fix": "Fetch it: made-up command"}
    fake(b / "backend" / ".venv" / "bin" / "python", tools, f"echo '{json.dumps(lacks)}'")
    got = FX.browser_on_live()
    assert got["browser"] == "ready" and "-m app.headless --fetch" in tools.read_text().splitlines()
    assert got["chromium"] == [f"has {lacks['why']}", "Fetch it: made-up command"]
    assert (f"The browser workbench has {lacks['why']}. Fetch it: made-up command"
            in FX._summary({"from": "0.10.12", "to": "0.10.13", **got}))
    fake(b / "backend" / ".venv" / "bin" / "python", tools, "echo '{\"ok\": true}'")
    assert "chromium" not in FX.browser_on_live()


def state_of_fixes() -> dict:
    """What an update changes when it moves: mine, release.json, the records, the fixes' refs, the set-aside files, the
    release checkout, and the refs of releases in live."""
    live = FX.live_dir()
    pending = FX.home() / "pending"
    return {"mine": sh("git", "rev-parse", "mine", cwd=live), "release.json": (FX.home() / "release.json").read_text(),
            "fixes.jsonl": (FX.home() / "fixes.jsonl").read_text(),
            "refs": sh("git", "for-each-ref", "refs/thimble/", cwd=live),
            "pending": sorted(str(p.relative_to(pending)) for p in pending.rglob("*")) if pending.exists() else [],
            "release": sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()),
            "scratch": sorted(p.name for p in FX.home().iterdir() if p.name.startswith(("download-", ".live-new-")))}


def test_an_update_that_cannot_download_the_release_changes_nothing_and_says_what_to_do(world, upstream, monkeypatch):
    """A release with no file (its Action has not attached it yet), one whose bytes are not those its SHA256SUMS gives,
    and GitHub out of reach: thimble update says why and what to do, and the fixes, live and the release checkout stay
    as they were."""
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = made(world)
    FX.done(a["id"], "Bar says read", "The bar's coverage item says read.")
    FX.apply(a["id"], press(a["id"]))
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    gh = world["gh"]
    before = state_of_fixes()
    issues = "report it at https://github.com/safety-research/thimble/issues"
    for spoil, said in (
            (gh.spoil, "the downloaded thimble-0.10.3.tar.gz does not have the sha256 its SHA256SUMS gives, so the "
                       "download is broken and nothing changed; run thimble update again"),
            (gh.drop, "thimble 0.10.3 has no release file on GitHub (thimble-0.10.3.tar.gz), so nothing changed. Run "
                      f"thimble update again in a few minutes; if it says this again, {issues}"),
            (lambda tag: gh.stop(), f"thimble could not reach {gh.url} (")):
        spoil("v0.10.3")
        with pytest.raises(FX.FixError) as e:
            FX.update()
        assert str(e.value).startswith(said), str(e.value)
        assert state_of_fixes() == before
        assert FX.get(a["id"])["state"] == "on" and "read ${n}" in live_file("plugin/bar/bar.tsx")


def test_words_an_older_thimble_kept_with_the_fixer_s_closing_fence_show_without_it(world):
    """thimble 0.10.12 and before kept what a fix does as its fixer wrote it, and a fixer may close its end in a code
    fence. The fix's record, which thimble fix show, the reapply prompt, an issue's text, the terminal's line and the
    workbench all read, gives those words without the fence, as a fixer's end gives them now."""
    r = made(world)
    FX.done(r["id"], "Bar says read", "The bar's coverage item says read.")
    FX.put({**FX.get(r["id"]), "summary": "The bar's coverage item says read.\n```"})
    stored = json.loads((FX.home() / "fixes.jsonl").read_text().splitlines()[-1])
    assert stored["summary"].endswith("```")
    assert FX.get(r["id"])["summary"] == FX.records()[r["id"]]["summary"] == "The bar's coverage item says read."
    shown = FX.show_lines(r["id"], 100)
    assert "  Claude did    The bar's coverage item says read." in shown and "```" not in "\n".join(shown), shown
