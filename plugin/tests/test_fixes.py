"""thimble fix (engine/kernel/fixes.py): a request, the fixer's end, the person's y, undo, off and on, the safe files, and
submitting as files or as a pull request to a made-up remote. Each test has its own THIMBLE_HOME, Claude Code config
folder and made-up release repository; `claude` and `gh` are fakes that log their arguments. All data here is made up."""
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
    # the quick tests run in the sandbox runtime, which these tests do not install (the last test runs it when it can)
    real = FX.sandbox_argv
    monkeypatch.setattr(FX, "sandbox_argv", lambda fid: ["/bin/bash", "-c"])
    return {"real_sandbox": real, "rel": rel, "base": base, "cc": cc, "log": log, "bin": bin_, "tmp": tmp_path}


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


def test_undo_of_an_earlier_fix_keeps_the_later_one(world):
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    FX.apply(a["id"], press(a["id"]))
    b = FX.new("a second change")
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(b["id"], "A note", "")
    FX.apply(b["id"], press(b["id"]))
    FX.undo(a["id"])
    assert FX.get(b["id"])["state"] == "on" and (FX.live_dir() / "plugin" / "notes.md").exists()
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx")


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


def test_a_fix_may_not_touch_what_keeps_the_person_safe(world):
    r = FX.new("let fixes skip the scan")
    (Path(r["work"]) / "plugin" / "engine" / "kernel").mkdir(parents=True)
    (Path(r["work"]) / "plugin" / "engine" / "kernel" / "privacy.py").write_text("def scan(*a): return [], []\n")
    r = FX.done(r["id"], "Skip the scan", "")
    # the refusal names each file with what it is, and why
    assert r["state"] == "failed" and r["error"] == (
        "it changes plugin/engine/kernel/privacy.py (the privacy scan); thimble does not apply changes to its safety files")
    with pytest.raises(FX.FixError):
        FX.apply(r["id"], press(r["id"]))
    b = FX.new("an image")
    (Path(b["work"]) / "plugin" / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00")
    assert FX.done(b["id"], "Logo", "")["state"] == "failed"
    c = FX.new("a new lock file")
    (Path(c["work"]) / "plugin" / "sandbox" / "package-lock.json").write_text("{}\n")
    assert "package-lock.json" in FX.done(c["id"], "Lock", "")["error"]
    assert FX.protected_why(["plugin/fix/line.ts", "plugin/fix/pane.tsx", "scripts/install.sh"]) == (
        "it changes plugin/fix/line.ts and plugin/fix/pane.tsx (the fix flow) and scripts/install.sh (thimble's scripts); "
        "thimble does not apply changes to its safety files")


def test_failed_tests_no_change_and_not_now(world, monkeypatch):
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "false")
    r = made(world)
    assert FX.done(r["id"], "Bar says read", "")["state"] == "failed"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "true")
    q = made(world, "explain the terms of my field", edit=False)
    q = FX.done(q["id"], "Explain terms of my field", "Needs words from the person, not code.", request=False)
    assert q["state"] == "request" and q["work"] is None
    n = made(world)
    FX.done(n["id"], "Bar says read", "")
    n = FX.not_now(n["id"])
    assert n["state"] == "off" and n["note"] == "not now" and n["work"] is None
    assert sh("git", "rev-parse", "mine", cwd=FX.live_dir()) == world["base"]
    lines = FX.list_lines()
    states = [x.split()[1] for x in lines[3:] if x[:5].strip().isdigit()]
    assert sorted(states) == ["failed", "off", "request"]


def test_redo_makes_a_new_copy_with_the_earlier_change(world, monkeypatch):
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "false")
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    r = FX.redo(r["id"], "and keep the percent")
    assert r["state"] == "working" and Path(r["work"]).is_dir() and r["words"][-1] == "and keep the percent"
    assert "read" in (FX.tmp_dir(r["id"]) / "earlier.patch").read_text()


def test_export_saves_files_and_sends_nothing(world, tmp_path):
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    out = FX.export(r["id"], str(tmp_path / "out"))
    assert [Path(p).name for p in out] == ["thimble-fix-1.patch", "thimble-fix-1.md"]
    assert "Subject: [PATCH] Bar says read" in Path(out[0]).read_text() and calls(world) == []


def test_a_github_install_clones_live_from_claude_codes_clone(world, tmp_path):
    # Claude Code's own clone of a GitHub marketplace, at the installed commit
    cc_clone = world["cc"] / "plugins" / "marketplaces" / "thimble"
    sh("git", "clone", "-q", str(world["rel"]), str(cc_clone))
    sh("git", "remote", "set-url", "origin", "https://github.com/made-up/thimble.git", cwd=cc_clone)
    (world["cc"] / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {
        "source": {"source": "github", "repo": "made-up/thimble"}, "installLocation": str(cc_clone)}}))
    FX.new("say read")
    assert sh("git", "remote", "get-url", "origin", cwd=FX.live_dir()) == "https://github.com/made-up/thimble.git"
    assert FX.release()["kind"] == "github" and FX.release()["entry"] == {"source": "github", "repo": "made-up/thimble"}
    assert sh("git", "branch", "--list", "mine", cwd=world["rel"]) == ""


def test_submit_scans_then_saves_or_opens_a_pull_request_on_a_made_up_remote(world, monkeypatch, tmp_path):
    r = FX.new("the bar should say how many failed, like the two in board-7.jsonl")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text() + "// seen in " + "/ho" + "me/dana/data/board-7.jsonl\n")
    FX.done(r["id"], "Bar shows failed citations", "")
    FX.apply(r["id"], press(r["id"]))
    monkeypatch.setattr(FX, "session_terms", lambda st: {"file": ["board-7.jsonl"], "name": ["dana"]})
    d = FX.draft(r["id"], "Bar shows failed citations", "While a reply has failed citations, the bar says how many.", None)
    assert d["removed"] >= 2
    pr = (FX.home() / "drafts" / "1" / "pr.md").read_text()
    patch = (FX.home() / "drafts" / "1" / "fix.patch").read_text()
    assert "board-7.jsonl" not in pr + patch and "/ho" + "me/dana" not in pr + patch
    assert "‹data file›" in pr and "> the bar should say" in pr
    # w: the same text, saved as files, nothing sent
    with pytest.raises(FX.FixError):
        FX.send(r["id"], "file", "a-guess")
    out = FX.send(r["id"], "file", press(r["id"]))
    assert sorted(out["files"]) == ["fix.patch", "pr.md", "title"]
    assert (Path(out["saved"]) / "pr.md").read_text() == pr
    # y: a pull request, here to a made-up fork (a bare repository) with a fake gh
    fork = tmp_path / "fork.git"
    sh("git", "init", "-q", "--bare", str(fork))
    ghlog = tmp_path / "gh.log"
    gh = fake(world["bin"] / "gh", ghlog, 'case "$1" in api) echo \'{"login": "made-up", "id": 42}\';; '
              'pr) echo https://github.com/made-up/thimble/pull/9;; esac')
    monkeypatch.setenv("THIMBLE_GH", str(gh))
    monkeypatch.setenv("THIMBLE_FIX_PUSH_URL", str(fork))
    out = FX.send(r["id"], "pr", press(r["id"]))
    assert out["pr"].endswith("/pull/9") and FX.get(r["id"])["state"] == "sent"
    pushed = sh("git", "for-each-ref", "--format=%(refname)", "refs/heads/", cwd=fork)
    assert pushed.startswith("refs/heads/thimble-fix-1-")
    author = sh("git", "log", "-1", "--format=%an <%ae>|%s", pushed, cwd=fork)
    assert author == "made-up <42+made-up@users.noreply.github.com>|Bar shows failed citations"
    body = sh("git", "show", pushed, cwd=fork)
    assert "board-7.jsonl" not in body and "‹path›" in body
    assert any(x.startswith("pr create") and "--draft" in x for x in ghlog.read_text().splitlines())


def test_the_fixers_sandbox_writes_only_its_copy(world, tmp_path):
    srt = os.environ.get("THIMBLE_TEST_SRT")  # a folder with srt installed (sandbox/setup.mjs); skipped without it
    if not srt:
        pytest.skip("THIMBLE_TEST_SRT is not set")
    r = FX.new("anything")
    pin = FX._srt_dir().name
    (FX.thimble_home() / "srt").mkdir(parents=True, exist_ok=True)
    (FX.thimble_home() / "srt" / pin).symlink_to(srt)
    outside = tmp_path / "outside.txt"
    cmd = (f"echo in > plugin/x.txt; echo out > {outside} 2>/dev/null; "
           "(exec 3<>/dev/tcp/1.1.1.1/80) 2>/dev/null && echo NET || echo NONET")
    p = subprocess.run(world["real_sandbox"](r["id"]) + [cmd], cwd=r["work"], capture_output=True, text=True)
    assert "NONET" in p.stdout
    assert (Path(r["work"]) / "plugin" / "x.txt").read_text() == "in\n" and not outside.exists()


def test_a_request_with_no_code_goes_as_an_issue(world, monkeypatch, tmp_path):
    q = FX.done(FX.new("explain the terms of my field")["id"], "Explain terms of my field", "It needs the person's words.")
    assert q["state"] == "request"
    monkeypatch.setattr(FX, "session_terms", lambda st: {})
    FX.draft(q["id"], "Explain terms of my field", "Explainers could use a glossary the person writes.", None)
    assert not (FX.home() / "drafts" / str(q["id"]) / "fix.patch").exists()
    ghlog = tmp_path / "gh.log"
    gh = fake(world["bin"] / "gh", ghlog, 'case "$1" in api) echo \'{"login": "made-up", "id": 42}\';; '
              'issue) echo https://github.com/made-up/thimble/issues/3;; esac')
    monkeypatch.setenv("THIMBLE_GH", str(gh))
    out = FX.send(q["id"], "pr", press(q["id"]))
    assert out["pr"].endswith("/issues/3") and FX.get(q["id"])["state"] == "sent"
    assert not any(x.startswith(("repo fork", "pr create")) for x in ghlog.read_text().splitlines())


@pytest.fixture
def upstream(world, tmp_path, monkeypatch):
    """thimble's repository as a made-up upstream: a bare repository whose tag v0.10.2 is the installed release, and
    publish(files, tag) adds a release on top of the newest one."""
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


def test_update_sets_the_fixes_aside_and_reapply_brings_back_what_the_release_still_needs(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    assert FX.update()["newer"] is False  # v0.10.2 is what runs
    sh("git", "tag", "v0.10.2", world["base"], cwd=world["rel"])  # the person's clone has the tags too
    FX.write_json(FX.home() / "release.json", {k: v for k, v in FX.release().items() if k != "tag"})
    assert FX.update(check=True)["from"] == "0.10.2"
    # 0.10.3 has the note as it is, and its own legend on the line fix c changed
    new = upstream({"plugin/notes.md": "made-up note\n", "plugin/legend.ts": "const legend = `quiet ${n} files`\n"},
                   "v0.10.3", version="0.10.3")
    calls_before = len(calls(world))
    out = FX.update()
    assert (out["from"], out["to"], out["aside"]) == ("0.10.2", "0.10.3", [a, b, c])
    # nothing is replayed: thimble is the plain release, and each fix keeps its old change as a patch
    live = FX.live_dir()
    assert sh("git", "rev-parse", "mine", cwd=live) == new and "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    assert FX.release()["tag"] == "v0.10.3" and FX.release()["base"] == new and new in (FX.home() / "off.sh").read_text()
    for fid in (a, b, c):
        r = FX.get(fid)
        assert r["state"] == "pending" and r["note"] == "set aside at the update to 0.10.3"
        assert Path(r["pending"]["old"]) == FX.home() / "pending" / "0.10.3" / f"fix-{fid}.patch"
    assert "Subject: [PATCH] Bar says read" in Path(FX.get(a)["pending"]["old"]).read_text()
    assert FX.get(c)["pending"]["files"] == ["plugin/legend.ts"]
    assert out["lines"] == [
        "Updated thimble 0.10.2 → 0.10.3 (terminal plugin)", "",
        "You have 3 local fixes. They are off for now: 0.10.3 may already fix some of the same",
        "things, and Claude checks each one so nothing is fixed twice.", "",
        "Bring them back:  thimble reapply",
        "  Claude opens, checks each fix against 0.10.3, keeps what is still needed, and turns it on.", "",
        "Then  Terminal: /reload-plugins in Claude Code"]
    assert out["reload"] is True and "plugin update thimble@thimble" in calls(world)[calls_before:]
    # the list: each off, and thimble reapply first under What next; the person's key cannot put an old change on
    rows = FX.list_lines(120)
    assert rows[0] == "Your thimble fixes · thimble 0.10.3 with 3 off"
    assert [x.split()[1] for x in rows[3:6]] == ["off", "off", "off"]
    nxt = rows[rows.index("What next") + 1]
    assert nxt.split()[:2] == ["thimble", "reapply"] and "the 3 fixes thimble update set aside" in nxt
    with pytest.raises(FX.FixError, match="thimble reapply"):
        FX.apply(c, press(c))
    # thimble reapply: Claude Code in live, with the prompt made from the records
    r = FX.reapply_argv()
    assert r["argv"][0] == os.environ["THIMBLE_CLAUDE"] and r["cwd"] == str(live)
    text = r["argv"][1]
    assert text == Path(r["prompt"]).read_text() and Path(r["prompt"]) == FX.home() / "pending" / "0.10.3.md"
    assert "The person updated thimble from 0.10.2 to 0.10.3. Before that, they had 3 fixes of their own" in text
    assert "thimble set them aside, so this copy is plain 0.10.3 now." in text
    assert "(`git log v0.10.2..v0.10.3` and the diff" in text and "{{" not in text
    assert sh("git", "log", "--format=%s", "v0.10.2..v0.10.3", cwd=live) == "thimble v0.10.3"
    made_on = FX._date(FX.get(a)["created"])
    assert (f"1. Bar says read (fix {a}, {made_on}, terminal)\n"
            f"   They asked: \"the bar should say read, not coverage\"\n"
            f"   It did: The bar's coverage item says read.\n"
            f"   Old change: {FX.home() / 'pending' / '0.10.3' / f'fix-{a}.patch'} (plugin/bar/bar.tsx)") in text
    assert "   They asked: \"the legend should count the files nobody read like the untouched ones\"" in text
    assert text.rstrip().endswith("(plugin/legend.ts)") and "run `thimble update --continue`" in text
    # Claude brings back the bar's word and the legend's count, and leaves the note out: 0.10.3 has it
    (live / "plugin" / "bar" / "bar.tsx").write_text("const words = `read ${n}`\n")
    sh("git", "commit", "-q", "-am", "Bar says read", cwd=live)
    (live / "plugin" / "legend.ts").write_text("const legend = `quiet ${n} files · untouched ${m}`\n")
    sh("git", "commit", "-q", "-am", "Legend counts untouched", cwd=live)
    done = FX.continue_()
    assert done["recorded"] == [a, c] and done["left_out"] == [b] and done["reload"] is True
    assert done["lines"][0].startswith("Recorded 2 fixes on thimble 0.10.3, now on: Bar says read (")
    assert done["lines"][1] == (f"Left out: A note. It leaves thimble fixes (0.10.3 does it, or it cannot work there); "
                                f"thimble fix show {b} still shows it.")
    assert done["lines"][-1] == "In Claude Code, type /reload-plugins to load them."
    assert FX.get(a)["state"] == "on" and FX.get(c)["commit"] == sh("git", "rev-parse", "mine", cwd=live)
    assert FX.get(b)["state"] == "released" and FX.get(b)["left_out"] is True
    assert not (FX.home() / "pending" / "current.json").exists()
    with pytest.raises(FX.FixError, match="no fixes are set aside"):
        FX.continue_()
    with pytest.raises(FX.FixError, match="no fixes are set aside"):
        FX.reapply_argv()
    # the fix the release has leaves the list; thimble fix show still has it
    rows = FX.list_lines(120)
    assert rows[0] == "Your thimble fixes · thimble 0.10.3 with 2 on" and not any(" A note " in x for x in rows)
    assert any(x.startswith("  Left out") for x in FX.show_lines(b))
    # the next update finds nothing newer; an undo keeps the recorded fix, now part of mine
    assert FX.update()["newer"] is False
    FX.undo(a)
    assert "untouched ${m}" in live_file("plugin/legend.ts") and "coverage ${n}" in live_file("plugin/bar/bar.tsx")


def test_continue_records_only_commits_that_are_set_aside_fixes_and_safe(world, upstream):
    a, b, c = three_fixes(world)
    upstream({"plugin/legend.ts": "const legend = `quiet`\n", "plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "v0.10.3")
    out = FX.update()
    assert out["aside"] == [a, b, c]
    live = FX.live_dir()
    # not committed yet
    (live / "plugin" / "bar" / "bar.tsx").write_text("const words = `read ${n}`\n")
    with pytest.raises(FX.FixError, match="not committed"):
        FX.continue_()
    sh("git", "commit", "-q", "-am", "Bar says read", cwd=live)
    # a commit that is no set-aside fix's: nothing is recorded
    (live / "plugin" / "extra.md").write_text("x\n")
    sh("git", "add", "plugin/extra.md", cwd=live)
    sh("git", "commit", "-q", "-m", "Tidy up", cwd=live)
    with pytest.raises(FX.FixError, match="is not one set-aside fix"):
        FX.continue_()
    assert FX.get(a)["state"] == "pending"
    sh("git", "reset", "-q", "--hard", "HEAD~1", cwd=live)
    # a commit that changes a safety file: nothing is recorded
    (live / "plugin" / "engine" / "kernel").mkdir(parents=True, exist_ok=True)
    (live / "plugin" / "engine" / "kernel" / "privacy.py").write_text("def scan(*a): return [], []\n")
    (live / "plugin" / "legend.ts").write_text("const legend = `quiet · untouched`\n")
    sh("git", "add", "plugin/legend.ts", "plugin/engine/kernel/privacy.py", cwd=live)
    sh("git", "commit", "-q", "-m", "Legend counts untouched", cwd=live)
    with pytest.raises(FX.FixError, match=r"privacy\.py \(the privacy scan\)"):
        FX.continue_()
    assert FX.get(c)["state"] == "pending"
    sh("git", "reset", "-q", "--hard", "HEAD~1", cwd=live)
    done = FX.continue_()
    assert done["recorded"] == [a] and done["left_out"] == [b, c]
    # a set-aside fix that a later update finds still waiting goes into the next reapply with its first patch
    upstream({"plugin/more.md": "x\n"}, "v0.10.4")
    out = FX.update()
    assert out["aside"] == [a] and FX.get(a)["pending"]["old"].endswith("0.10.4/fix-1.patch")


def test_update_check_skips_release_candidates_and_never_steps_back(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    assert FX.update()["lines"] == ["thimble 0.10.2 is the newest release."]
    assert not FX.live_dir().exists()
    upstream({"plugin/other.md": "x\n"}, "v0.10.3")
    upstream({"plugin/rc.md": "x\n"}, "v0.10.4-rc1")
    check = FX.update(check=True)
    assert (check["newer"], check["to"]) == (True, "0.10.3") and not FX.live_dir().exists()
    # with no fixes, it just updates: Claude Code loads the release from live
    out = FX.update()
    assert out["aside"] == [] and FX.release()["pointed"] is True
    assert "other.md" in sh("git", "ls-files", cwd=FX.live_dir()) and not (FX.live_dir() / "plugin" / "rc.md").exists()
    assert out["lines"] == ["Updated thimble 0.10.2 → 0.10.3 (terminal plugin)", "",
                            "Then  Terminal: /reload-plugins in Claude Code"]
    assert not (FX.home() / "pending" / "current.json").exists()
    # a branch ahead of every release: no step back
    FX.write_json(FX.home() / "release.json", {**FX.release(), "tag": "v0.11.0"})
    upstream({"plugin/more.md": "x\n"}, "v0.10.4")
    assert FX.update()["newer"] is False


def test_update_puts_the_browser_on_live_and_links_packages_while_the_lock_files_match(world, upstream, monkeypatch, tmp_path):
    for part, lock in (("backend", "uv.lock"), ("frontend", "package-lock.json")):
        p = world["rel"] / "browser" / part / lock
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"made-up {lock}\n")
    sh("git", "add", "-A", cwd=world["rel"])
    sh("git", "commit", "-q", "-m", "the browser", cwd=world["rel"])
    world["base"] = sh("git", "rev-parse", "HEAD", cwd=world["rel"])
    installed = json.loads((world["cc"] / "plugins" / "installed_plugins.json").read_text())
    installed["plugins"]["thimble@thimble"][0]["gitCommitSha"] = world["base"]
    (world["cc"] / "plugins" / "installed_plugins.json").write_text(json.dumps(installed))
    # the checkout the install built: its packages, and the workbench's home that names it
    seed = tmp_path / "checkout" / "browser"
    for part, lock, pkgs in FX.BROWSER_LOCKS:
        (seed / part / pkgs).mkdir(parents=True)
        (seed / part / pkgs / "made-up-package.txt").write_text("x\n")
        (seed / part / lock).write_text(f"made-up {lock}\n")
    bh = tmp_path / "browser-home"
    bh.mkdir()
    (bh / "checkout").write_text(f"{seed}\n")
    monkeypatch.setenv("THIMBLE_BROWSER_HOME", str(bh))
    log = tmp_path / "pkg.log"
    for name in ("uv", "npm"):
        fake(world["bin"] / name, log)
    monkeypatch.setenv("PATH", f"{world['bin']}:{os.environ['PATH']}")
    sh("git", "clone", "-q", "--bare", str(world["rel"]), str(tmp_path / "upstream2.git"))
    sh("git", "tag", "v0.10.2", world["base"], cwd=tmp_path / "upstream2.git")
    monkeypatch.setenv("THIMBLE_UPDATE_URL", str(tmp_path / "upstream2.git"))
    work = tmp_path / "w2"
    sh("git", "clone", "-q", str(tmp_path / "upstream2.git"), str(work))
    (work / "plugin" / "other.md").write_text("x\n")
    sh("git", "add", "-A", cwd=work)
    sh("git", "commit", "-q", "-m", "0.10.3", cwd=work)
    sh("git", "tag", "v0.10.3", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:refs/heads/main", "v0.10.3", cwd=work)
    out = FX.update()
    b = FX.live_dir() / "browser"
    assert out["browser"] == "ready" and (FX.home() / "browser-ready").read_text().strip() == str(b)
    assert out["lines"][0] == "Updated thimble 0.10.2 → 0.10.3 (terminal plugin and browser)"
    assert out["lines"][-1] == "Then  Terminal: /reload-plugins in Claude Code · Browser: restart thimble-browser"
    # same lock files: hard links of the install's packages, no download; then the page is built
    venv = b / "backend" / ".venv" / "made-up-package.txt"
    assert venv.exists() and os.stat(venv).st_ino == os.stat(seed / "backend" / ".venv" / "made-up-package.txt").st_ino
    assert log.read_text().splitlines() == [f"--prefix {b / 'frontend'} run build"]
    # a release whose JS lock file changed: npm ci for the page's packages only
    (work / "browser" / "frontend" / "package-lock.json").write_text("made-up package-lock.json, newer\n")
    sh("git", "commit", "-q", "-am", "0.10.4", cwd=work)
    sh("git", "tag", "v0.10.4", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:refs/heads/main", "v0.10.4", cwd=work)
    log.write_text("")
    FX.update()
    assert log.read_text().splitlines() == [f"--prefix {b / 'frontend'} ci --no-audit --no-fund", f"--prefix {b / 'frontend'} run build"]
    # thimble-browser runs from live once it is ready
    fakelive = b / "scripts" / "thimble-browser"
    fakelive.parent.mkdir(parents=True, exist_ok=True)
    fakelive.write_text("#!/bin/sh\necho \"live $*\"\n")
    fakelive.chmod(0o755)
    launcher = Path(__file__).resolve().parents[2] / "browser" / "scripts" / "thimble-browser"
    p = subprocess.run(["bash", str(launcher), "--help"], capture_output=True, text=True, env={**os.environ})
    assert p.stdout == "live --help\n" and "the release thimble update installed" in p.stderr
    (FX.home() / "browser-ready").unlink()
    p = subprocess.run(["bash", str(launcher), "--help"], capture_output=True, text=True, env={**os.environ})
    assert p.stdout.startswith("thimble-browser: starts thimble's browser workbench")


def test_thimble_fixes_fix_show_and_the_shell_commands(world, upstream, capsys, monkeypatch, tmp_path):
    from kernel import cli  # noqa: PLC0415

    monkeypatch.delenv("CLAUDECODE", raising=False)
    monkeypatch.setattr(FX, "can_share", lambda: True)
    a, b, c = three_fixes(world)
    FX.undo(b)
    d = FX.new("the claims pane should open the cluster I had open")
    (Path(d["work"]) / "plugin" / "claims.ts").write_text("const keep = 'last cluster'\n")
    FX.done(d["id"], "Claims pane keeps my last cluster", "The claims pane saves the open cluster and opens it again.")
    assert cli.main(["fixes"]) == 0
    rows = capsys.readouterr().out.splitlines()
    assert "\x1b[" not in "\n".join(rows)  # plain text off a terminal, as Claude's Bash tool reads it
    assert rows[0] == "Your thimble fixes · thimble 0.10.2 with 2 on, 1 ready, 1 off"
    assert rows[2].split() == ["#", "state", "fix", "made", "you", "asked"]
    assert [x.split()[:2] for x in rows[3:7]] == [[str(a), "on"], [str(c), "on"], [str(d["id"]), "ready"], [str(b), "off"]]
    assert rows[3].endswith('"the bar should say read, not coverage"') and "like the untouched" not in "\n".join(rows)
    assert rows[8:] == [
        "What next",
        f"  thimble fix show {a}     what fix {a} does, in a few lines",
        f"  thimble fix share {a}    post fix {a} as a GitHub issue (you check it before it goes)",
        f"  thimble fix off {a}      turn a fix off; thimble fix on {a} turns it back on",
        "  thimble update         get the newest thimble and keep your fixes",
        "  New fix: in Claude Code or the browser, /thimble-fix <what should work differently>"]
    assert "fix diff" not in "\n".join(rows)
    assert cli.main(["fix", "show", str(c)]) == 0
    shown = capsys.readouterr().out.splitlines()
    assert shown[0] == f"Legend counts untouched · fix {c} · on · {FX._date(FX.get(c)['created'])}, terminal"
    assert shown[1] == '  You asked     "the legend should count the files nobody read like the untouched ones"'
    assert shown[2] == "  Claude did    The coverage legend says how many files are untouched."
    assert shown[3] == "  Changed       1 file · tests pass"
    assert shown[5:] == [f"  thimble fix share {c}    post it as a GitHub issue", f"  thimble fix off {c}      turn it off"]
    # off and on one fix in a shell: on needs the person's y in their terminal, never Claude's Bash tool
    assert cli.main(["fix", "off", str(c)]) == 0 and FX.get(c)["state"] == "off"
    assert capsys.readouterr().out.startswith(f"Fix {c} is off: Legend counts untouched.")
    monkeypatch.setenv("CLAUDECODE", "1")
    assert cli.main(["fix", "on", str(c)]) == 1 and FX.get(c)["state"] == "off"
    assert "only your key turns a fix on" in capsys.readouterr().err
    assert cli.main(["update"]) == 1 and "runs in a shell, not inside Claude Code" in capsys.readouterr().err
    assert cli.main(["reapply"]) == 1 and "runs in a shell, not inside Claude Code" in capsys.readouterr().err
    monkeypatch.delenv("CLAUDECODE")
    monkeypatch.setattr(FX, "key_in_terminal", lambda q: "" if "Legend" not in q else os.urandom(8).hex())
    assert cli.main(["fix", "on", str(b)]) == 0 and FX.get(b)["state"] == "off"
    assert cli.main(["fix", "on", str(c)]) == 0 and FX.get(c)["state"] == "on"
    assert f"Fix {c} is on: Legend counts untouched." in capsys.readouterr().out
    # thimble --help: the shell's commands first, then Claude's
    assert cli.main(["--help"]) == 0
    help_ = capsys.readouterr().out
    for line in ("thimble update ", "thimble reapply ", "thimble fixes ", "thimble fix show N", "thimble fix apply N",
                 "thimble fix share N", "thimble fix off [N]", "thimble fix on [N]"):
        assert f"\n    {line}" in help_, line
    assert all(f"thimble {w}" not in help_ for w in ("doctor", "demo", "browser"))
    assert help_.index("thimble fix on [N]") < help_.index("Claude runs these in a session") < help_.index("thimble label [NAME]")
    monkeypatch.setattr(FX, "can_share", lambda: False)
    assert cli.main(["--help"]) == 0 and "thimble fix share" not in capsys.readouterr().out


def test_the_shell_command_is_a_link_that_follows_live(world, tmp_path, monkeypatch):
    """scripts/install.sh links bin/thimble to the plugin's command and names the link in cli-link; once Claude Code
    loads thimble from live, the link runs live's. A link to 0.10's command is no 0.9 left behind."""
    cmd = world["rel"] / "plugin" / "bin" / "thimble"
    cmd.parent.mkdir(parents=True)
    real = Path(__file__).resolve().parents[1] / "bin" / "thimble"
    cmd.write_text(real.read_text())
    cmd.chmod(0o755)
    (world["rel"] / "plugin" / "engine").mkdir()
    (world["rel"] / "plugin" / "engine" / "thimble.py").write_text("import sys\nprint('made-up kernel', *sys.argv[1:])\n")
    sh("git", "add", "-A", cwd=world["rel"])
    sh("git", "commit", "-q", "-m", "the command", cwd=world["rel"])
    installed = json.loads((world["cc"] / "plugins" / "installed_plugins.json").read_text())
    installed["plugins"]["thimble@thimble"][0]["gitCommitSha"] = sh("git", "rev-parse", "HEAD", cwd=world["rel"])
    (world["cc"] / "plugins" / "installed_plugins.json").write_text(json.dumps(installed))
    home = tmp_path / "home"
    link = home / ".local" / "bin" / "thimble"
    link.parent.mkdir(parents=True)
    link.symlink_to(cmd)
    FX.home().mkdir(parents=True, exist_ok=True)
    (FX.home().parent / "cli-link").write_text(f"{link}\n")
    r = made(world)
    FX.done(r["id"], "Bar says read", "")
    FX.apply(r["id"], press(r["id"]))
    assert os.readlink(link) == str(FX.live_dir() / "plugin" / "bin" / "thimble")
    # the link runs the kernel of the plugin it points at, from any folder
    p = subprocess.run([str(link), "--help"], capture_output=True, text=True, cwd=tmp_path,
                       env={**os.environ, "THIMBLE_PYTHON": sys.executable})
    assert p.returncode == 0 and p.stdout == "made-up kernel --help\n"
    script = Path(__file__).resolve().parents[2] / "scripts" / "thimble09.py"
    p = subprocess.run([sys.executable, str(script), "report"], capture_output=True, text=True,
                       env={**os.environ, "HOME": str(home), "CLAUDE_CONFIG_DIR": str(world["cc"])})
    assert p.returncode == 0 and p.stdout.strip() == ""


def test_a_data_file_named_like_one_of_thimbles_goes_from_the_words_and_stays_in_the_diff(world, monkeypatch):
    r = FX.new("after Claude read package.json, the bar should say read")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text() + "// a test reads a made-up package.json\n")
    FX.done(r["id"], "Bar says read", "")
    monkeypatch.setattr(FX, "session_terms", lambda st: {"file": ["package.json"]})
    FX.draft(r["id"], "Bar says read", "The bar says read, as package.json showed.", None)
    pr = (FX.home() / "drafts" / "1" / "pr.md").read_text()
    patch = (FX.home() / "drafts" / "1" / "fix.patch").read_text()
    assert "package.json" not in pr and "after Claude read ‹data file›" in pr
    assert "+// a test reads a made-up package.json" in patch


def on_fix(w) -> dict:
    """Fix 1, on: the bar says read."""
    r = made(w)
    FX.done(r["id"], "Bar says read", "The bar's coverage item says read.")
    FX.apply(r["id"], press(r["id"]))
    return FX.get(r["id"])


def test_a_change_to_an_on_fix_folds_into_it_and_waits_for_y(world):
    a = on_fix(world)
    old = a["commit"]
    b = FX.new("and keep the count", refines=a["id"])
    assert b["refines"] == a["id"] and b["refines_always"] is False
    # the copy is cut from mine, which holds fix 1
    p = Path(b["work"]) / "plugin" / "bar" / "bar.tsx"
    assert "read ${n}" in p.read_text()
    p.write_text(p.read_text().replace("${n}", "${n} files"))
    r = FX.done(b["id"], None, "The bar says read and the file count.", changes=str(a["id"]))
    assert r["id"] == a["id"] and r["folded"] == b["id"] and r["state"] == "ready"
    assert r["words"] == ["say read, not coverage", "and keep the count"] and r["rounds"] == 2
    assert r["summary"] == "The bar says read and the file count." and r["title"] == "Bar says read"
    assert r["files"] == [{"path": "plugin/bar/bar.tsx", "add": 1, "del": 1}] and r["commit"] != old
    # one commit on the release: both rounds' change
    assert sh("git", "rev-parse", f"{r['commit']}^", cwd=FX.live_dir()) == world["base"]
    assert "read ${n} files" in sh("git", "show", f"{r['commit']}:plugin/bar/bar.tsx", cwd=FX.live_dir())
    # the round leaves the list; mine no longer holds the old commit until y
    assert FX.get(b["id"])["state"] == "removed" and not Path(b["work"]).exists()
    assert [x["id"] for x in FX.listing()["fixes"]] == [a["id"]]
    assert sh("git", "rev-parse", "mine", cwd=FX.live_dir()) == world["base"]
    with pytest.raises(FX.FixError):
        FX.apply(a["id"], "a-guess")
    FX.apply(a["id"], press(a["id"]))
    assert FX.get(a["id"])["state"] == "on" and "read ${n} files" in live_file("plugin/bar/bar.tsx")
    assert len(sh("git", "log", "--format=%s", "mine", cwd=FX.live_dir()).splitlines()) == 2
    shown = "\n".join(FX.show_lines(a["id"]))
    assert 'You asked     "say read, not coverage"' in shown and 'Then          "and keep the count"' in shown
    assert "2 rounds" in shown


def test_the_explicit_form_changes_an_off_fix_and_a_new_title_keeps_its_own_fix(world):
    a = on_fix(world)
    FX.undo(a["id"])
    # always: the change goes into fix 1 whatever the end says; its change is put on the copy first
    b = FX.new("say files too", refines=a["id"], always=True)
    p = Path(b["work"]) / "plugin" / "bar" / "bar.tsx"
    assert "read ${n}" in p.read_text()
    p.write_text(p.read_text().replace("${n}", "${n} files"))
    r = FX.done(b["id"], "Bar names files", "The bar says files.")
    assert r["id"] == a["id"] and r["state"] == "ready" and r["rounds"] == 2
    assert sh("git", "rev-parse", "mine", cwd=FX.live_dir()) == world["base"]
    # a fix that refines nothing, or whose end gives a title of its own, stays a fix of its own
    c = FX.new("a note", refines=a["id"])
    (Path(c["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    c = FX.done(c["id"], "A note", "Adds a note.")
    assert c["id"] != a["id"] and c["state"] == "ready" and "folded" not in c
    with pytest.raises(FX.FixError, match="only a fix that is on, off or ready"):
        FX.new("more", refines=FX.new("x")["id"])


def test_a_change_that_does_not_fit_its_fix_becomes_a_new_fix(world):
    a = on_fix(world)
    b = FX.new("say coverage again", refines=a["id"])
    p = Path(b["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text("const words = `covered ${n}`\n")
    # fix 1's commit moves on meanwhile (made up: its ref points at another change of the same line)
    other = FX.new("x")
    q = Path(other["work"]) / "plugin" / "bar" / "bar.tsx"
    q.write_text("const words = `seen ${n}`\n")
    other = FX.done(other["id"], "Seen", "")
    sh("git", "update-ref", f"refs/thimble/fixes/{a['id']}", other["commit"], cwd=FX.live_dir())
    r = FX.done(b["id"], None, "The bar says covered.", changes=a["id"])
    assert r["id"] == b["id"] and r["state"] == "ready" and r["fold_failed"] == a["id"]
    assert FX.get(a["id"])["state"] == "on" and "covered" in sh("git", "show", f"{r['commit']}:plugin/bar/bar.tsx", cwd=FX.live_dir())


def test_merge_makes_one_fix_of_several_with_the_persons_key_and_keeps_the_old_refs(world):
    a = on_fix(world)
    b = FX.new("a note")
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(b["id"], "A note", "Adds a note.")
    FX.apply(b["id"], press(b["id"]))
    c = FX.new("explain the terms of my field")
    c = FX.done(c["id"], "Explain terms", "Needs words only the person knows.", request=True)
    old = {i: sh("git", "rev-parse", f"refs/thimble/fixes/{i}", cwd=FX.live_dir()) for i in (a["id"], b["id"])}
    # only the person's key merges
    with pytest.raises(FX.FixError, match="person's key"):
        FX.merge([a["id"], b["id"], c["id"]], "a-guess")
    out = FX.merge([a["id"], b["id"], c["id"]], press(a["id"]), "Bar says read, with a note", "The bar says read; a note.")
    assert out["merged"] == [b["id"], c["id"]] and out["reload"] is True
    m = FX.get(a["id"])
    assert m["state"] == "on" and m["title"] == "Bar says read, with a note" and m["rounds"] == 3
    assert m["words"] == ["say read, not coverage", "a note", "explain the terms of my field"]
    assert sorted(f["path"] for f in m["files"]) == ["plugin/bar/bar.tsx", "plugin/notes.md"]
    assert FX.get(b["id"])["state"] == "merged" and FX.get(c["id"])["merged_into"] == a["id"]
    assert [r["id"] for r in FX.listing()["fixes"]] == [a["id"]]
    # mine: the release and one commit, which holds both changes
    assert sh("git", "log", "--format=%s", "mine", cwd=FX.live_dir()).splitlines() == ["Bar says read, with a note", "thimble 0.10.2"]
    assert "read ${n}" in live_file("plugin/bar/bar.tsx") and (FX.live_dir() / "plugin" / "notes.md").exists()
    # the old commits stay, for an undo by hand
    assert sh("git", "rev-parse", f"refs/thimble/fixes/{b['id']}", cwd=FX.live_dir()) == old[b["id"]]
    for i, sha in old.items():
        assert sh("git", "rev-parse", f"refs/thimble/merged/{a['id']}/{i}", cwd=FX.live_dir()) == sha
    # undo takes the merged fix off as one
    FX.undo(a["id"])
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx") and not (FX.live_dir() / "plugin" / "notes.md").exists()


def test_merge_in_a_shell_asks_first_and_a_request_alone_does_not_merge(world, monkeypatch):
    a = made(world)
    FX.done(a["id"], "Bar says read", "The bar says read.")
    b = FX.new("a note")
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(b["id"], "A note", "Adds a note.")
    monkeypatch.setattr(FX, "key_in_terminal", lambda q: None)
    with pytest.raises(FX.FixError, match="only your key"):
        FX.merge_typed([a["id"], b["id"]])
    monkeypatch.setattr(FX, "key_in_terminal", lambda q: "")
    assert FX.merge_typed([a["id"], b["id"]])["said"] == "Nothing merged."
    monkeypatch.setattr(FX, "key_in_terminal", lambda q: "s3cret-made-up")
    out = FX.merge_typed([a["id"], b["id"]])
    m = FX.get(a["id"])
    # no title given: the first fix's; both were ready, so the merged fix is ready, for y
    assert m["title"] == "Bar says read" and m["state"] == "ready" and out["said"].startswith("Fixes 1 and 2 are now fix 1")
    assert sh("git", "rev-parse", "mine", cwd=FX.live_dir()) == world["base"]
    q = FX.done(FX.new("x")["id"], "X", "", request=True)
    r = FX.done(FX.new("y")["id"], "Y", "", request=True)
    with pytest.raises(FX.FixError, match="none of these fixes changes code"):
        FX.merge([q["id"], r["id"]], press(q["id"]))


def test_two_sessions_check_only_their_own_fixes_and_a_copy_that_is_no_checkout_fails_for_r(world):
    # session A applies fix 1, then asks for fix 2; session B's look for ended fixers must not end it
    r = made(world)
    FX.done(r["id"], "Bar says read", "x", session="s-made-up-a")
    FX.apply(r["id"], press(r["id"]))
    two = made(world, "make the bar bold", edit=False)
    assert two["state"] == "working"
    two = FX.put({**two, "session": "s-made-up-a"})
    with pytest.raises(FX.FixError, match="another Claude Code session"):
        FX.done(two["id"], session="s-made-up-b")
    assert FX.get(two["id"])["state"] == "working"
    # a check that already ended it (a request, its copy dropped): a second end does not run git anywhere
    FX.done(two["id"], session="s-made-up-a")
    assert FX.get(two["id"])["state"] == "request" and FX.get(two["id"])["work"] is None
    with pytest.raises(FX.FixError, match="nothing to check"):
        FX.done(two["id"], session="s-made-up-a")
    # r: a new copy; something in it removes its git link (the folder stays): a clear line, and r works again
    three = FX.redo(two["id"], session="s-made-up-a")
    assert three["session"] == "s-made-up-a" and Path(three["work"]).is_dir()
    (Path(three["work"]) / ".git").unlink()
    out = FX.done(three["id"], session="s-made-up-a")
    assert out["state"] == "failed" and "no longer a git checkout" in out["error"] and "r starts it again" in out["error"]
    assert out["work"] is None and not Path(three["work"]).exists()
    again = FX.redo(three["id"], session="s-made-up-a")
    p = Path(again["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text() + "// bold\n")
    assert FX.done(again["id"], "Bar bold", "y", session="s-made-up-a")["state"] == "ready"
