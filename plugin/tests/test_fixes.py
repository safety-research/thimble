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


def test_update_carries_a_fix_drops_one_the_release_has_and_sets_aside_one_that_conflicts(world, upstream):
    a, b, c = three_fixes(world)
    assert FX.update(tests=False)["newer"] is False  # v0.10.2 is what runs
    sh("git", "tag", "v0.10.2", world["base"], cwd=world["rel"])  # the person's clone has the tags too
    FX.write_json(FX.home() / "release.json", {k: v for k, v in FX.release().items() if k != "tag"})
    assert FX.update(check=True)["from"] == "0.10.2"
    # 0.10.3 takes the note as it is, and writes its own legend on the line fix c changed
    new = upstream({"plugin/notes.md": "made-up note\n", "plugin/legend.ts": "const legend = `quiet ${n} files`\n"},
                   "v0.10.3", version="0.10.3")
    calls_before = len(calls(world))
    out = FX.update()
    assert (out["from"], out["to"]) == ("0.10.2", "0.10.3")
    assert out["carried"] == [a] and out["released"] == [b] and out["pending"] == [c]
    live = FX.live_dir()
    assert sh("git", "rev-parse", "mine~1", cwd=live) == new
    assert sh("git", "log", "-1", "--format=%s", "mine", cwd=live) == "Bar says read"
    assert "read ${n}" in live_file("plugin/bar/bar.tsx") and "quiet" in live_file("plugin/legend.ts")
    assert FX.release()["tag"] == "v0.10.3" and FX.release()["base"] == new and new in (FX.home() / "off.sh").read_text()
    # each outcome in its record and in thimble fix list
    assert FX.get(a)["state"] == "on" and FX.get(a)["commit"] == sh("git", "rev-parse", "mine", cwd=live)
    assert FX.get(b)["state"] == "released" and FX.get(b)["released_in"] == "0.10.3"
    rc = FX.get(c)
    assert rc["state"] == "pending" and rc["error"] == "it conflicts with thimble 0.10.3 in plugin/legend.ts"
    rows = "\n".join(FX.list_lines(120))
    assert "in 0.10.3" in rows and "pending" in rows and "the legend should count the files nobody read" in rows
    assert "like the untouched ones" not in rows  # the first line of the person's words
    # the prompt for Claude: the person's words, title, summary, the old change and what failed
    prompt = Path(out["prompt"])
    assert prompt == FX.home() / "pending" / "0.10.3.md"
    text = prompt.read_text()
    assert "## Fix 3: Legend counts untouched" in text and "like the untouched ones" in text
    assert "The coverage legend says how many files are untouched." in text
    old = FX.home() / "pending" / "0.10.3" / "fix-3.diff"
    assert str(old) in text and "+const legend = `untouched ${n}`" in old.read_text()
    assert "it conflicts with thimble 0.10.3 in plugin/legend.ts" in text and "thimble update --continue" in text
    assert "{{" not in text
    # one command, printed last
    cmd = f'cd {FX.live_dir()} && claude "$(cat {prompt})"'
    assert out["command"] == cmd and out["lines"][-1] == f"  {cmd}"
    assert out["lines"][0] == "thimble 0.10.2 → 0.10.3"
    assert any(x.startswith("  in 0.10.3") and "A note" in x for x in out["lines"])
    # Claude Code loads it from live: pointed once, and copied
    assert out["reload"] is True and "plugin update thimble@thimble" in calls(world)[calls_before:]
    # Claude applies the pending fix on top of the release in live, one commit with its title; --continue records it
    (live / "plugin" / "legend.ts").write_text("const legend = `quiet ${n} files · untouched ${m}`\n")
    sh("git", "add", "plugin/legend.ts", cwd=live)
    sh("git", "commit", "-q", "-m", "Legend counts untouched", cwd=live)
    done = FX.continue_()
    assert done["recorded"] == [c] and done["pending"] == [] and done["reload"] is True
    assert done["said"].startswith("Recorded 1 fix on thimble 0.10.3, now on: Legend counts untouched (")
    rc = FX.get(c)
    assert rc["state"] == "on" and rc["commit"] == sh("git", "rev-parse", "mine", cwd=live) and rc["pending"] is None
    assert sh("git", "rev-parse", f"refs/thimble/fixes/{c}", cwd=live) == rc["commit"]
    assert not (FX.home() / "pending" / "current.json").exists()
    with pytest.raises(FX.FixError, match="no fixes wait"):
        FX.continue_()
    # the next update finds nothing newer; an undo keeps the recorded fix, now part of mine
    assert FX.update()["newer"] is False
    FX.undo(a)
    assert "untouched ${m}" in live_file("plugin/legend.ts") and "coverage ${n}" in live_file("plugin/bar/bar.tsx")


def test_continue_records_only_commits_that_are_pending_fixes_and_safe(world, upstream):
    a, b, c = three_fixes(world)
    upstream({"plugin/legend.ts": "const legend = `quiet`\n", "plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "v0.10.3")
    out = FX.update(tests=False)
    assert out["pending"] == [a, c] and out["released"] == [] and "These 2 fixes did not fit 0.10.3" in "\n".join(out["lines"])
    live = FX.live_dir()
    tip = sh("git", "rev-parse", "mine", cwd=live)
    # not committed yet
    (live / "plugin" / "bar" / "bar.tsx").write_text("const words = `read ${n}`\n")
    with pytest.raises(FX.FixError, match="not committed"):
        FX.continue_()
    sh("git", "commit", "-q", "-am", "Bar says read", cwd=live)
    # a commit that is no pending fix's: nothing is recorded
    (live / "plugin" / "extra.md").write_text("x\n")
    sh("git", "add", "plugin/extra.md", cwd=live)
    sh("git", "commit", "-q", "-m", "Tidy up", cwd=live)
    with pytest.raises(FX.FixError, match="is not one pending fix"):
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
    sh("git", "reset", "-q", "--hard", "HEAD~1", cwd=live)
    # one fix done, one left: it stays pending, and the prompt's next --continue starts after the recorded one
    done = FX.continue_()
    assert done["recorded"] == [a] and done["pending"] == [c] and "Still pending: Legend counts untouched." in done["said"]
    assert FX.get(a)["state"] == "on" and FX.get(c)["state"] == "pending"
    cur = json.loads((FX.home() / "pending" / "current.json").read_text())
    assert cur["ids"] == [c] and cur["tip"] != tip
    # the person's key cannot turn on a pending fix's old commit
    with pytest.raises(FX.FixError, match="did not fit thimble 0.10.3"):
        FX.apply(c, press(c))


def test_a_fix_whose_tests_fail_on_the_release_waits_with_the_test_output(world, upstream, monkeypatch):
    a = made(world)
    FX.done(a["id"], "Bar says read", "")
    FX.apply(a["id"], press(a["id"]))
    upstream({"plugin/other.md": "x\n"}, "v0.10.3")
    # a release candidate is not a release, and --check only looks
    upstream({"plugin/rc.md": "x\n"}, "v0.10.4-rc1")
    check = FX.update(check=True)
    assert (check["newer"], check["to"]) == (True, "0.10.3") and FX.release()["base"] == world["base"]
    # tests that fail once (a time limit under load) and pass the second time: the fix is carried
    flaky = world["tmp"] / "flaky"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"test -e {flaky} || {{ touch {flaky}; false; }}")
    assert FX.update()["carried"] == [a["id"]] and flaky.exists() and not (FX.live_dir() / "plugin" / "rc.md").exists()
    upstream({"plugin/more.md": "x\n"}, "v0.10.5")
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "echo 'bar.test.ts: 1 failed'; false")
    out = FX.update()
    assert out["pending"] == [a["id"]]
    r = FX.get(a["id"])
    assert r["error"] == "its tests failed on thimble 0.10.5" and "1 failed" in r["pending"]["tests"]
    assert "bar.test.ts: 1 failed" in Path(out["prompt"]).read_text()
    shown = "\n".join(FX.show_lines(a["id"]))
    assert "Why it waits: its tests failed on thimble 0.10.5" in shown and "claude \"$(cat" in shown
    assert "plugin/bar/bar.tsx  +1 −1" in shown


def test_update_with_no_fixes_puts_thimble_on_live_and_never_steps_back(world, upstream, monkeypatch):
    assert FX.update()["lines"] == ["thimble 0.10.2 is the newest release."]
    assert not FX.live_dir().exists()
    upstream({"plugin/other.md": "x\n"}, "v0.10.3")
    out = FX.update()
    assert out["carried"] == [] and out["pending"] == [] and out["command"] is None
    assert FX.release()["pointed"] is True and "other.md" in sh("git", "ls-files", cwd=FX.live_dir())
    assert out["lines"][-1] == f"The terminal plugin runs it from {FX._tilde(str(FX.live_dir()))}."
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
    out = FX.update(tests=False)
    b = FX.live_dir() / "browser"
    assert out["browser"] == "ready" and (FX.home() / "browser-ready").read_text().strip() == str(b)
    assert out["lines"][-1].startswith("The terminal plugin and the browser workbench run it from ")
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
    FX.update(tests=False)
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


def test_thimble_fixes_and_fix_show_print_plain_text(world, upstream, capsys):
    from kernel import cli  # noqa: PLC0415

    a, b, c = three_fixes(world)
    upstream({"plugin/notes.md": "made-up note\n", "plugin/legend.ts": "const legend = `quiet`\n"}, "v0.10.3")
    FX.update(tests=False)
    assert cli.main(["fixes"]) == 0
    rows = capsys.readouterr().out.splitlines()
    assert rows[0].startswith("Your fixes · thimble 0.10.3 + 1 on · ")
    assert rows[2].split() == ["#", "state", "title", "date", "you", "asked"]
    by_id = {int(x.split()[0]): x for x in rows[3:6]}
    assert by_id[a].split()[1] == "on" and " in 0.10.3 " in by_id[b] and by_id[c].split()[1] == "pending"
    assert "\x1b[" not in "\n".join(rows)
    assert any(x.startswith("Pending fixes wait for Claude: cd ") for x in rows)
    assert cli.main(["fix", "show", str(c)]) == 0
    shown = capsys.readouterr().out
    assert shown.startswith("Fix 3: Legend counts untouched\n  state     pending")
    assert "You asked:\n  the legend should count the files nobody read\n  like the untouched ones" in shown
    assert "plugin/legend.ts  +1 −0" in shown and "its change before:" in shown
    assert cli.main(["fix", "diff", str(c)]) == 0 and "+const legend = `untouched ${n}`" in capsys.readouterr().out
    assert cli.main(["--help"]) == 0
    help_ = capsys.readouterr().out
    assert "thimble fixes " in help_ and "thimble update [--continue]" in help_


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
