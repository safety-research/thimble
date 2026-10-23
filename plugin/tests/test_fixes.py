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
    assert any("request" in x and "“explain the terms of my field”" in x for x in lines) and any("failed" in x for x in lines)
    assert lines[3].split() == ["#", "state", "fix", "made", "you", "asked"]


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


def release_commit(w, path: str, text: str, msg: str) -> str:
    """A newer release in the person's clone (a clone install moves when they pull)."""
    p = w["rel"] / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    sh("git", "add", "-A", cwd=w["rel"])
    sh("git", "commit", "-q", "-m", msg, cwd=w["rel"])
    return sh("git", "rev-parse", "HEAD", cwd=w["rel"])


def test_a_new_release_carries_the_fixes_that_fit_and_marks_the_rest(world, monkeypatch):
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    FX.apply(a["id"], press(a["id"]))
    b = FX.new("a note")
    (Path(b["work"]) / "plugin" / "notes.md").write_text("made-up note\n")
    FX.done(b["id"], "A note", "")
    FX.apply(b["id"], press(b["id"]))
    assert FX.update(tests=False)["said"] == ""  # nothing newer yet
    # the release takes the note as it is, and changes something else
    new = release_commit(world, "plugin/notes.md", "made-up note\n", "the note, released")
    new = release_commit(world, "plugin/other.md", "x\n", "another change")
    out = FX.update()
    assert out["said"] == f"thimble {new[:7]} · 1 fix carried · 1 in the release" or out["said"].endswith("1 fix carried · 1 in the release")
    assert FX.get(a["id"])["state"] == "on" and FX.get(b["id"])["state"] == "released"
    assert not any(" released " in x or "A note" in x for x in FX.list_lines())
    assert FX.get(a["id"])["commit"] == sh("git", "rev-parse", "mine", cwd=FX.live_dir())
    assert FX.release()["base"] == new and new in (FX.home() / "off.sh").read_text()
    log = sh("git", "log", "--format=%s", "mine", cwd=FX.live_dir()).splitlines()
    assert log[:2] == ["Bar says read", "another change"]
    assert "read ${n}" in live_file("plugin/bar/bar.tsx") and (FX.live_dir() / "plugin" / "other.md").exists()
    # a release that rewrote the same line: the fix needs a redo, and mine is the release alone
    release_commit(world, "plugin/bar/bar.tsx", "const words = `seen ${n}`\n", "the bar rewritten")
    out = FX.update()
    assert out["redo"] == [a["id"]] and FX.get(a["id"])["state"] == "redo" and "did not fit" in FX.get(a["id"])["error"]
    assert "seen ${n}" in live_file("plugin/bar/bar.tsx")
    # a fix whose tests fail on the new release needs a redo too
    c = FX.new("a second note")
    (Path(c["work"]) / "plugin" / "more.md").write_text("more\n")
    FX.done(c["id"], "More", "")
    FX.apply(c["id"], press(c["id"]))
    release_commit(world, "plugin/third.md", "y\n", "a third change")
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "false")
    assert FX.update()["redo"] == [c["id"]] and not (FX.live_dir() / "plugin" / "more.md").exists()


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
