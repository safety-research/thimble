"""thimble fix (engine/kernel/fix.py): a copy of thimble's code, a draft that the privacy scan cleans, the person's
keep and send with the ask id, a report with no code, and saving as a file. gh and the push run through stubs
(THIMBLE_GH, THIMBLE_GIT) that only record their arguments: nothing is filed or pushed. All data is made up."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import cli  # noqa: E402
from kernel import fix as FX  # noqa: E402
from kernel.store import Store  # noqa: E402

GH_STUB = """#!/bin/sh
echo "$*" >> "{log}"
case "$*" in
  "api user") echo '{{"login": "test-user", "id": 4242}}' ;;
  "pr create"*) echo "https://example.invalid/test-user/pull/1" ;;
  "issue create"*) echo "https://example.invalid/test-user/issues/2" ;;
esac
"""


def sh(*args: str, cwd: Path) -> str:
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "thome"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    monkeypatch.setenv("THIMBLE_SESSION", "s1")
    monkeypatch.setenv("HOME", str(tmp_path / "person"))
    (tmp_path / "person").mkdir()
    for name, stub in (("gh", GH_STUB), ("git", '#!/bin/sh\necho "$*" >> "{log}"\n')):
        p = tmp_path / f"{name}-stub"
        p.write_text(stub.format(log=tmp_path / f"{name}.log"))
        p.chmod(0o755)
    monkeypatch.setenv("THIMBLE_GH", str(tmp_path / "gh-stub"))
    monkeypatch.setenv("THIMBLE_GIT", str(tmp_path / "git-stub"))
    monkeypatch.setenv("THIMBLE_CLAUDE", str(tmp_path / "claude-missing"))
    # a small made-up thimble checkout stands in for the installed plugin's own clone
    src = tmp_path / "src"
    (src / "plugin").mkdir(parents=True)
    (src / "plugin" / "rows.py").write_text("def rows(path):\n    return open(path).read().split(',')\n# a label and a card\n")
    for args in (("init", "-q", "-b", "main"), ("add", "plugin/rows.py"),
                 ("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "release")):
        sh("git", *args, cwd=src)
    monkeypatch.setattr(FX, "find_source", lambda: (src, sh("git", "rev-parse", "HEAD", cwd=src), False))
    # the tests run in no Claude Code session of their own: which kind of session it is comes from the paths
    monkeypatch.setattr(FX, "_session_plugin_dir", lambda: None)
    data = tmp_path / "support"
    data.mkdir()
    (data / "tickets.csv").write_text("id,queue_owner,state\nT-1,wren.example@example.org,open\nT-2,moss.example@example.org,closed\n")
    monkeypatch.chdir(data)
    monkeypatch.setenv("THIMBLE_ROOT", str(data))
    return tmp_path


def log(env: Path, name: str) -> list[str]:
    p = env / f"{name}.log"
    return p.read_text().splitlines() if p.exists() else []


def change(fx: dict) -> None:
    wt = Path(fx["worktree"])
    (wt / "plugin" / "rows.py").write_text("import csv\n\ndef rows(path):\n    return next(csv.reader(open(path), csv.Sniffer().sniff(open(path).read())))\n")
    (wt / "plugin" / "test_semicolon.py").write_text("# made-up rows: 4 rows, 3 fields, ; between them\n# seen at " + "/ho" + "me/dana/support/tickets.csv\n")
    sh("git", "add", "plugin/rows.py", cwd=wt)
    sh("git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "detect ; in tickets.csv", cwd=wt)


DRAFT = """# Rows fails on tickets.csv

Rows could not open tickets.csv: the cited row was queue_owner = wren.example@example.org. A token ghp_{tok} was in the log.

Expected: Rows detects the separator.

## Change

Rows sniffs the separator. A new test uses 4 made-up rows with ; between fields.
"""


def press(slug: str) -> str:
    """What the plugin's preview does at the person's key press: a new secret held in memory, its sha256 in ask.json."""
    import secrets
    p = FX.fix_dir(slug) / "share" / "ask.json"
    secret = secrets.token_urlsafe(32)
    p.write_text(json.dumps({**json.loads(p.read_text()), "key": FX.key_hash(secret)}))
    return secret


def by_key(monkeypatch, args: list[str], secret: str) -> int:
    """`thimble fix … --ask -` with the key's secret on stdin, as the plugin runs it."""
    import io
    monkeypatch.setattr(sys, "stdin", io.StringIO(secret + "\n"))
    return cli.main(["fix", *args, "--ask", "-"])


def test_new_draft_keep_send(env: Path, capsys, monkeypatch):
    fx = FX.new("Rows for semicolon CSV files")
    wt = Path(fx["worktree"])
    assert fx["branch"] == "fix/rows-for-semicolon-csv-files" and sh("git", "branch", "--show-current", cwd=wt) == fx["branch"]
    assert str(wt).startswith(os.environ["THIMBLE_HOME"])
    change(fx)
    # the session read the file's rows and fields (the hooks module's record of a Read call)
    seen = Path(os.environ["THIMBLE_HOME"]) / "seen"
    seen.mkdir(parents=True, exist_ok=True)
    (seen / "s1.jsonl").write_text(json.dumps({"tool": "Read", "file": str(env / "support" / "tickets.csv"), "from": 1, "to": 3, "cwd": str(env / "support")}) + "\n")
    f = env / "draft.md"
    f.write_text(DRAFT.format(tok="Ab3" * 12))
    assert cli.main(["fix", "draft", fx["slug"], "--from", str(f)]) == 0
    printed = capsys.readouterr().out
    share = FX.fix_dir(fx["slug"]) / "share"
    ask = json.loads((share / "ask.json").read_text())
    # nothing Claude's shell can read sends it: the ask holds no secret until the person's key press
    assert "the person is reviewing the draft" in printed.lower() and set(ask) == {"created"}
    issue, pr, diff = (share / "issue.md").read_text(), (share / "pr.md").read_text(), (share / "diff.patch").read_text()
    for private in ("tickets.csv", "queue_owner", "wren.example@example.org", "ghp_", "/ho" + "me/dana"):
        assert private not in issue + pr + diff, private
    assert "‹data file›" in issue and "‹field›" in issue and "‹secret›" in issue and "test_semicolon.py" in diff
    feed = (Path(os.environ["THIMBLE_HOME"]) / "events" / "s1.jsonl").read_text().splitlines()
    assert json.loads(feed[-1])["kind"] == "fix_ask" and json.loads(feed[-1])["slug"] == fx["slug"]
    hits = json.loads((share / "scan.json").read_text())
    field = next(h for h in hits if h["found"] == "queue_owner" and h["where"] == "issue")
    token = next(h for h in hits if h["kind"] == "token")
    secret = press(fx["slug"])
    assert by_key(monkeypatch, ["keep", fx["slug"], token["id"]], secret) == 1 and "never kept" in capsys.readouterr().out
    assert by_key(monkeypatch, ["keep", fx["slug"], field["id"]], secret) == 0
    assert "queue_owner" in (share / "issue.md").read_text()
    # what Claude's shell can read or write sends nothing: the key's hash, a made-up secret, or an id it writes itself
    on_disk = json.loads((share / "ask.json").read_text())["key"]
    assert by_key(monkeypatch, ["send", fx["slug"], "--answer", "send"], on_disk) == 1
    assert cli.main(["fix", "send", fx["slug"], "--answer", "send", "--ask", "f000000000000"]) == 1
    (share / "ask.json").write_text(json.dumps({**json.loads((share / "ask.json").read_text()), "id": "f1"}))
    assert cli.main(["fix", "send", fx["slug"], "--answer", "send", "--ask", "f1"]) == 1
    assert "only the person's key" in capsys.readouterr().out
    assert log(env, "gh") == [] and log(env, "git") == []
    assert by_key(monkeypatch, ["send", fx["slug"], "--answer", "send"], secret) == 0
    lines = capsys.readouterr().out.strip().splitlines()
    gh = log(env, "gh")
    assert gh[0] == "api user" and gh[1].startswith("repo fork safety-research/thimble")
    assert any(x.startswith("pr create --repo safety-research/thimble --draft --head test-user:fix/") for x in gh)
    assert gh[-1].startswith("issue create --repo safety-research/thimble")
    push = log(env, "git")[0].split()
    assert "push" in push and push[-2] == "https://github.com/test-user/thimble.git"
    sha, ref = push[-1].split(":")
    assert ref.startswith("refs/heads/fix/") and "tickets" not in ref
    noreply = "4242+test-user@users.noreply.github.com"
    assert sh("git", "log", "-1", "--format=%ae %ce", sha, cwd=wt) == f"{noreply} {noreply}"
    pushed = sh("git", "-c", "core.quotePath=false", "diff", "--no-color", fx["base"], sha, cwd=wt)
    assert [x for x in pushed.splitlines() if not x.startswith("index ")] == diff.strip().splitlines()  # what was previewed
    assert "pull/1" in lines[-1] and "issues/2" in lines[-1] and not (share / "ask.json").exists()
    assert FX.load(fx["slug"])["login"] == "test-user" and FX.load(fx["slug"])["repo"] == "safety-research/thimble"
    assert FX.load(fx["slug"])["status"] == "sent"
    assert "pull/1" in (share / "issue-sent.md").read_text()


def test_report_only_opens_an_issue(env: Path):
    fx = FX.new("Percent rounds the wrong way", "report")
    assert fx["worktree"] is None
    f = env / "r.md"
    f.write_text("# Percent rounds down in tickets.csv\n\nA share of 14.5% shows as 14%.\n")
    FX.draft(fx["slug"], str(f), Store())
    share = FX.fix_dir(fx["slug"]) / "share"
    assert not (share / "pr.md").exists() and "tickets.csv" not in (share / "issue.md").read_text()
    FX.send(fx["slug"], "send", press(fx["slug"]))
    gh = log(env, "gh")
    assert gh[0] == "api user" and len(gh) == 2 and gh[1].startswith("issue create") and log(env, "git") == []


def test_file_mode_writes_one_markdown_file(env: Path):
    fx = FX.new("Rows for semicolon CSV files")
    change(fx)
    f = env / "d.md"
    f.write_text(DRAFT.format(tok="Cd4" * 12))
    FX.draft(fx["slug"], str(f), Store())
    (env / "person" / "Downloads").mkdir()
    out = FX.send(fx["slug"], "file", press(fx["slug"]))
    files = list((env / "person" / "Downloads").glob("*.md"))
    assert len(files) == 1 and str(files[0]) in out[0]
    text = files[0].read_text()
    assert "# Pull request" in text and "```diff" in text and "test_semicolon.py" in text and "tickets.csv" not in text
    assert log(env, "gh") == [] and log(env, "git") == []
    assert FX.load(fx["slug"])["status"] == "saved"


def test_use_from_a_plugin_dir_session_says_the_one_command_and_installs_nothing(env: Path, tmp_path: Path, monkeypatch):
    # this checkout's plugin is not in Claude Code's plugins folder: the session was started with --plugin-dir
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    assert FX.from_plugin_dir()
    fx = FX.new("Coverage opens a group")
    said = FX.use(fx["slug"])
    assert f"claude --continue --plugin-dir {fx['worktree']}/plugin" in said
    assert FX.active_slug() is None and FX.load(fx["slug"])["status"] == "ready"
    # a session started again with the copy's folder runs the fix; undo says the command back to the clone
    monkeypatch.setattr(FX, "PLUGIN", Path(fx["worktree"]) / "plugin")
    assert FX.fix_of_plugin() == fx["slug"] and FX.latest() == fx["slug"]
    assert "already runs" in FX.use(fx["slug"]) and FX.load(fx["slug"])["status"] == "applied"
    back = FX.undo()
    assert f"--plugin-dir {fx['source']}/plugin" in back and FX.load(fx["slug"])["status"] == "ready"


CLAUDE_STUB = """#!/bin/sh
echo "$*" >> "{log}"
"""


def test_a_folder_marketplace_install_turns_the_copy_on_and_off_like_a_github_one(env: Path, tmp_path: Path, monkeypatch):
    # scripts/install.sh --local: the marketplace is the clone itself, and Claude Code reads its plugin/ in place
    cc = tmp_path / "cc"
    (cc / "plugins").mkdir(parents=True)
    clone = tmp_path / "src"
    (cc / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {"source": {"source": "directory", "path": str(clone)}}}))
    (cc / "plugins" / "installed_plugins.json").write_text(json.dumps({"plugins": {"thimble@thimble": [{"installPath": str(cc / "x")}]}}))
    # Claude Code keeps the marketplace's source in the user settings too, and refuses another source until it changes
    settings = {"theme": "dark", "extraKnownMarketplaces": {"thimble": {"source": {"source": "directory", "path": str(clone)}}}}
    (cc / "settings.json").write_text(json.dumps(settings))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cc))
    stub = tmp_path / "claude-stub"
    stub.write_text(CLAUDE_STUB.format(log=tmp_path / "claude.log"))
    stub.chmod(0o755)
    monkeypatch.setenv("THIMBLE_CLAUDE", str(stub))
    monkeypatch.setattr(FX, "PLUGIN", clone / "plugin")
    assert not FX.from_plugin_dir()
    fx = FX.new("Claims newest first", "feature")
    assert "/reload-plugins" in FX.use(fx["slug"]) and FX.active_slug() == fx["slug"] and FX.latest() == fx["slug"]
    now = json.loads((cc / "settings.json").read_text())
    assert now["theme"] == "dark" and now["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(Path(fx["worktree"]).resolve())}
    # the session reloaded on the copy, then undid it: it still runs the copy until it reloads, and try turns it on again
    monkeypatch.setattr(FX, "PLUGIN", Path(fx["worktree"]) / "plugin")
    assert not FX.from_plugin_dir()
    assert FX.undo().startswith(f"thimble is back to the release from {clone}")
    assert not FX.from_plugin_dir() and "/reload-plugins" in FX.use(fx["slug"])
    assert FX.undo().startswith(f"thimble is back to the release from {clone}")
    assert json.loads((cc / "settings.json").read_text())["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(clone)}
    back = [f"plugin marketplace add {clone}", "plugin marketplace update thimble", "plugin update thimble@thimble"]
    assert log(env, "claude") == [f"plugin marketplace add {fx['worktree']}", *back, f"plugin marketplace add {fx['worktree']}", *back]
    assert FX.active_slug() is None


def test_a_copy_with_no_change_is_shared_as_a_request_alone(env: Path):
    fx = FX.new("Show the label count per file", "feature")
    draft = env / "d.md"
    draft.write_text("# Show the label count per file\n\nThe person wants each file's label count in Files.\n")
    r = FX.draft(fx["slug"], str(draft), None, terms={})
    share = FX.fix_dir(fx["slug"]) / "share"
    assert not r["change"] and (share / "issue.md").exists() and not (share / "pr.md").exists()
    assert "a request from a tester" in (share / "issue.md").read_text()
    ask = json.loads((share / "ask.json").read_text())["id"]  # a caller with no store (the browser's server) keeps an id
    assert FX.send(fx["slug"], "send", ask) == ["The person sent the report under their GitHub login: issue https://example.invalid/test-user/issues/2."]
    assert not any(l.startswith(("repo fork", "pr create")) for l in log(env, "gh")) and log(env, "git") == []


# ---- a fix follows releases: a made-up release history in the source checkout

def release(src: Path, version: str, files: dict[str, str]) -> str:
    """A new release of the made-up thimble: its files and its version, committed in the source checkout."""
    for rel, text in {**files, "plugin/.claude-plugin/plugin.json": json.dumps({"name": "thimble", "version": version})}.items():
        (src / rel).parent.mkdir(parents=True, exist_ok=True)
        (src / rel).write_text(text)
    sh("git", "add", "-A", cwd=src)
    sh("git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", f"release {version}", cwd=src)
    return sh("git", "rev-parse", "HEAD", cwd=src)


@pytest.fixture()
def on(env: Path, monkeypatch: pytest.MonkeyPatch):
    """A fix that is on (the marketplace points at its copy), whose change is one line of rows.py, left uncommitted."""
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "true")
    undone: list[str] = []
    monkeypatch.setattr(FX, "undo", lambda plugin_dir=None: undone.append("undo") or "back")
    fx = FX.new("Rows reads a semicolon")
    rows = Path(fx["worktree"]) / "plugin" / "rows.py"
    rows.write_text(rows.read_text().replace("split(',')", "split(';')"))
    (FX.fixes_home() / "active").write_text(fx["slug"] + "\n")
    return fx, env / "src", undone


def test_follow_replays_the_fix_on_a_newer_release(on):
    fx, src, undone = on
    new = release(src, "0.11.0", {"plugin/claims.py": "CLAIMS = []\n"})
    assert FX.follow() == "thimble 0.11.0 + your fix 'Rows reads a semicolon' · u undo"
    wt = Path(fx["worktree"])
    after = FX.load(fx["slug"])
    assert after["base"] == new and after["version"] == "0.11.0" and not undone
    assert (wt / "plugin" / "claims.py").exists() and "split(';')" in (wt / "plugin" / "rows.py").read_text()
    # at most once a day the next session start fetches again, and at once when a newer release is known (here the
    # dev install's clone moved on)
    import time
    stamps = json.loads((FX.fixes_home() / "follow.json").read_text())
    assert FX.follow() == "thimble 0.11.0 + your fix 'Rows reads a semicolon' · u undo" and json.loads((FX.fixes_home() / "follow.json").read_text()) == stamps
    release(src, "0.11.1", {"plugin/more.py": "x = 1\n"})
    assert FX.follow() == "thimble 0.11.1 + your fix 'Rows reads a semicolon' · u undo" and time.time() - json.loads((FX.fixes_home() / "follow.json").read_text())[fx["slug"]] < 60


def test_follow_goes_back_to_the_release_when_the_fix_is_in_it(on):
    fx, src, undone = on
    release(src, "0.11.0", {"plugin/rows.py": (src / "plugin" / "rows.py").read_text().replace("split(',')", "split(';')")})
    assert FX.follow() == "Your fix 'Rows reads a semicolon' is in thimble 0.11.0; you are on the release again."
    assert undone == ["undo"] and FX.load(fx["slug"])["status"] == "merged"


def test_follow_goes_back_to_the_release_when_the_fix_no_longer_fits_and_keeps_the_copy(on, monkeypatch):
    fx, src, undone = on
    release(src, "0.11.0", {"plugin/rows.py": "def rows(path):\n    return open(path).read().split('|')\n"})
    assert FX.follow(force=True) == "Your fix 'Rows reads a semicolon' no longer fits thimble 0.11.0; you are on the release · /thimble:fix to redo it"
    assert undone == ["undo"] and FX.load(fx["slug"])["status"] == "stale" and FX.load(fx["slug"])["base"] == fx["base"]
    assert "split(';')" in (Path(fx["worktree"]) / "plugin" / "rows.py").read_text()


def test_follow_goes_back_when_the_quick_tests_fail_after_the_replay(on, monkeypatch):
    fx, src, undone = on
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "false")
    release(src, "0.11.0", {"plugin/claims.py": "CLAIMS = []\n"})
    assert "no longer fits thimble 0.11.0" in FX.follow()
    assert undone == ["undo"] and FX.load(fx["slug"])["base"] == fx["base"]
    assert not (Path(fx["worktree"]) / "plugin" / "claims.py").exists()


def test_a_caller_that_is_no_session_says_so_and_uses_the_marketplace(env: Path, tmp_path: Path, monkeypatch):
    # the browser's server runs from a checkout, which looks like --plugin-dir; it passes plugin_dir=False
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    stub = tmp_path / "claude-stub"
    stub.write_text(CLAUDE_STUB.format(log=tmp_path / "claude.log"))
    stub.chmod(0o755)
    monkeypatch.setenv("THIMBLE_CLAUDE", str(stub))
    assert FX.from_plugin_dir()
    fx = FX.new("Coverage opens a group")
    assert "/reload-plugins" in FX.use(fx["slug"], plugin_dir=False) and FX.active_slug() == fx["slug"]
    assert "back to the release" in FX.undo(plugin_dir=False) and FX.active_slug() is None


def test_in_a_session_that_runs_the_install_the_line_says_the_session_loads_the_switch_itself(env: Path, tmp_path: Path, monkeypatch):
    # the terminal loads the plugins again at each switch (bar/fix.ts refreshFixes): Claude reads that it is loaded,
    # so it has no /reload-plugins to pass on to the person
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    stub = tmp_path / "claude-stub"
    stub.write_text(CLAUDE_STUB.format(log=tmp_path / "claude.log"))
    stub.chmod(0o755)
    monkeypatch.setenv("THIMBLE_CLAUDE", str(stub))
    monkeypatch.setattr(FX, "_session_plugin_dir", lambda: False)
    fx = FX.new("Titles in teal")
    first, second, back = FX.use(fx["slug"]), FX.use(fx["slug"]), FX.undo()
    for said in (first, second, back):
        assert "/reload-plugins" not in said and FX.LOADED in said, said
    # round 2 still asks for a title that says what the fix does now
    assert "thimble fix title" in second and FX.active_slug() is None


def test_a_session_started_with_plugin_dir_on_thimble_is_told_apart_from_a_folder_marketplace_on_the_same_clone(tmp_path: Path):
    clone = tmp_path / "clone"
    (clone / "plugin" / ".claude-plugin").mkdir(parents=True)
    (clone / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "thimble"}))
    other = tmp_path / "other"
    (other / ".claude-plugin").mkdir(parents=True)
    (other / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "notes"}))
    assert FX.plugin_dir_in(["claude", "--plugin-dir", str(clone / "plugin"), "--permission-mode", "auto"]) is True
    assert FX.plugin_dir_in(["claude", f"--plugin-dir={clone / 'plugin'}"]) is True
    assert FX.plugin_dir_in(["claude", "--plugin-dir", str(other)]) is False
    assert FX.plugin_dir_in(["claude", "--continue"]) is False
    assert FX.plugin_dir_in(None) is None
    assert FX.plugin_dir_in(None, str(clone / "plugin")) is True


def test_a_second_follow_while_one_runs_changes_nothing(on):
    import fcntl
    fx, src, undone = on
    release(src, "0.11.0", {"plugin/claims.py": "CLAIMS = []\n"})
    with open(FX.fixes_home() / "follow.lock", "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        assert FX.follow(force=True) == f"thimble {fx['version']} + your fix 'Rows reads a semicolon' · u undo"
    assert FX.load(fx["slug"])["base"] == fx["base"] and not undone
    assert FX.follow(force=True) == "thimble 0.11.0 + your fix 'Rows reads a semicolon' · u undo"


def test_a_replay_stopped_part_way_replays_only_the_fix(on):
    fx, src, undone = on
    first = release(src, "0.11.0", {"plugin/claims.py": "CLAIMS = []\n"})
    # the copy's branch was moved onto 0.11.0 but its base was never saved (a replay that was stopped)
    wt = Path(fx["worktree"])
    FX._commit_local(wt, fx["slug"])
    sh("git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "rebase", "-q", "--onto", first, fx["base"], fx["branch"], cwd=wt)
    release(src, "0.11.1", {"plugin/rows.py": (src / "plugin" / "rows.py").read_text() + "# a note\n", "plugin/more.py": "x = 1\n"})
    assert FX.follow(force=True) == "thimble 0.11.1 + your fix 'Rows reads a semicolon' · u undo"
    assert "split(';')" in (wt / "plugin" / "rows.py").read_text() and (wt / "plugin" / "more.py").exists() and not undone


# ---- the scan removes only the analyst's details (made-up names and files)

def scan_case(env: Path, issue: str, files: dict[str, str], terms: dict[str, list[str]], pr: str = "") -> dict:
    src = env / "src"
    (src / "scripts").mkdir(exist_ok=True)
    (src / "scripts" / "check.sh").write_text("#!/bin/sh\npython3 -m pytest plugin -q\n")
    sh("git", "add", "scripts/check.sh", cwd=src)
    sh("git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "checks", cwd=src)
    fx = FX.new("Rows for semicolon files")
    for rel, text in files.items():
        (Path(fx["worktree"]) / rel).parent.mkdir(parents=True, exist_ok=True)
        (Path(fx["worktree"]) / rel).write_text(text)
    d = env / "d.md"
    d.write_text(issue + "\n\n## Change\n\n" + (pr or "Rows sniffs the separator.") + "\n")
    FX.draft(fx["slug"], str(d), None, terms=terms)
    return fx


def test_the_scan_never_changes_thimbles_own_paths_or_code(env: Path):
    # the data folder holds a check.sh, as thimble's repository does
    fx = scan_case(env, "# Rows and check.sh\n\nscripts/check.sh fails on plugin/rows.py with the file orbit-ledger.csv.",
                   {"plugin/rows.py": "def rows(path):\n    return open(path).read().split(';')\n# a label and a card\n",
                    "plugin/tests/fixtures/semicolons.csv": "a;b\n1;2\n"},
                   {"file": ["check.sh", "orbit-ledger.csv"], "folder": ["scripts", "plugin"]},
                   pr="Tested with scripts/check.sh and plugin/tests/fixtures/semicolons.csv.")
    share = FX.fix_dir(fx["slug"]) / "share"
    issue, pr, diff = (share / "issue.md").read_text(), (share / "pr.md").read_text(), (share / "diff.patch").read_text()
    assert "scripts/check.sh fails on plugin/rows.py" in issue and "‹data file›" in issue and "orbit-ledger" not in issue
    assert "Tested with scripts/check.sh and plugin/tests/fixtures/semicolons.csv." in pr
    assert "‹" not in diff and "+++ b/plugin/tests/fixtures/semicolons.csv" in diff
    base = FX.load(fx["slug"])["base"]
    sh("git", "checkout", "-q", "--detach", base, cwd=env / "src")
    assert subprocess.run(["git", "apply", "--check", str(share / "diff.patch")], cwd=env / "src").returncode == 0


def test_a_new_file_named_after_the_analysts_data_stops_the_draft_with_the_fix(env: Path):
    with pytest.raises(FX.FixError, match=r"the new file plugin/tests/fixtures/‹data file› is named after the analyst's data.*rename it"):
        scan_case(env, "# Rows\n\nRows fails.", {"plugin/tests/fixtures/orbit-ledger.csv": "a;b\n"}, {"file": ["orbit-ledger.csv"]})


def test_the_scan_finds_a_name_in_any_case_and_its_distinctive_words_alone(env: Path):
    issue = ("# Rows fails\n\nWhile reading odalys merriweather's rows (account QX-4410-ZZ), Rows failed. Odalys saw it "
             "too, and so did Merriweather. The label row failed for Quintessa; qx-4410-zz as well.")
    fx = scan_case(env, issue, {"plugin/tests/fixtures/semicolons.csv": "owner;account\nODALYS MERRIWEATHER;qx-4410-zz\n"},
                   {"value": ["Odalys Merriweather", "QX-4410-ZZ", "label Quintessa"]})
    share = FX.fix_dir(fx["slug"]) / "share"
    text = (share / "issue.md").read_text() + (share / "diff.patch").read_text()
    for private in ("odalys", "Odalys", "ODALYS", "Merriweather", "MERRIWEATHER", "qx-4410-zz", "Quintessa"):
        assert private not in text, private
    # a word thimble's own source holds ("label") is no detail of the analyst's
    assert "The label row failed for ‹value›" in text
    # the person still reads each hit and the exact text before anything is sent
    found = {h["found"] for h in json.loads((share / "scan.json").read_text())}
    assert {"odalys merriweather", "Odalys", "Merriweather", "qx-4410-zz", "ODALYS MERRIWEATHER"} <= found


# ---- try and remove

def test_try_on_a_fix_that_no_longer_fits_says_so_and_keeps_the_release(on):
    fx, src, undone = on
    release(src, "0.11.0", {"plugin/rows.py": "def rows(path):\n    return open(path).read().split('|')\n"})
    FX.follow(force=True)
    (FX.fixes_home() / "active").unlink()  # what the undo (a stand-in here) does
    with pytest.raises(FX.FixError, match=r"no longer fits thimble 0\.11\.0, so it stays off\. To have it again, redo it on the new release: /thimble:fix redo"):
        FX.use(fx["slug"], plugin_dir=False)
    # the marketplace stays on the release: nothing ran claude, and no fix is on
    assert FX.active_slug() is None and FX.load(fx["slug"])["status"] == "stale" and log(src.parent, "claude") == []


def test_remove_turns_the_fix_off_and_deletes_its_copy_branch_and_record(on, capsys):
    fx, src, undone = on
    assert cli.main(["fix", "remove", fx["slug"]]) == 0
    out = capsys.readouterr().out
    assert out.startswith("back Removed the fix 'Rows reads a semicolon': its copy and its record (") and undone == ["undo"]
    assert not FX.fix_dir(fx["slug"]).exists() and FX.all_slugs() == []
    assert fx["worktree"] not in sh("git", "worktree", "list", cwd=src) and fx["branch"] not in sh("git", "branch", cwd=src)
    assert cli.main(["fix", "remove", fx["slug"]]) == 1 and "no fix rows-reads-a-semicolon" in capsys.readouterr().out


def test_each_use_is_a_round_and_a_later_round_can_retitle_the_fix(env: Path, tmp_path: Path, monkeypatch):
    # each `use` stamps the fix, so the plugin loads the copy again for a second round; the title follows the round
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    stub = tmp_path / "claude-stub"
    stub.write_text(CLAUDE_STUB.format(log=tmp_path / "claude.log"))
    stub.chmod(0o755)
    monkeypatch.setenv("THIMBLE_CLAUDE", str(stub))
    fx = FX.new("Draw card titles in violet")
    first = FX.use(fx["slug"], plugin_dir=False)
    stamp = FX.load(fx["slug"])["used"]
    assert "thimble fix title" not in first
    time.sleep(0.01)
    second = FX.use(fx["slug"], plugin_dir=False)
    assert FX.load(fx["slug"])["used"] > stamp
    assert f'thimble fix title {fx["slug"]} "<new title>"' in second and "'Draw card titles in violet'" in second
    assert "now called 'Draw card titles in teal'" in FX.retitle(fx["slug"], "Draw card titles in teal")
    assert FX.load(fx["slug"])["title"] == "Draw card titles in teal" and FX.load(fx["slug"])["slug"] == fx["slug"]
    with pytest.raises(FX.FixError):
        FX.retitle(fx["slug"], "  ")
