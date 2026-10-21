"""thimble fix (engine/kernel/fix.py): a copy of thimble's code, a draft that the privacy scan cleans, the person's
keep and send with the ask id, a report with no code, and saving as a file. gh and the push run through stubs
(THIMBLE_GH, THIMBLE_GIT) that only record their arguments: nothing is filed or pushed. All data is made up."""
from __future__ import annotations

import json
import os
import subprocess
import sys
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


def test_new_draft_keep_send(env: Path, capsys):
    fx = FX.new("Rows for semicolon CSV files")
    wt = Path(fx["worktree"])
    assert fx["branch"] == "fix/rows-for-semicolon-csv-files" and sh("git", "branch", "--show-current", cwd=wt) == fx["branch"]
    assert str(wt).startswith(os.environ["THIMBLE_HOME"])
    change(fx)
    assert cli.main(["rows", "tickets.csv", "-n", "2"]) == 0  # the session read the file's rows and fields
    f = env / "draft.md"
    f.write_text(DRAFT.format(tok="Ab3" * 12))
    assert cli.main(["fix", "draft", fx["slug"], "--from", str(f)]) == 0
    printed = capsys.readouterr().out
    share = FX.fix_dir(fx["slug"]) / "share"
    ask = json.loads((share / "ask.json").read_text())
    assert "the person is reviewing the draft" in printed.lower() and ask["id"] not in printed
    issue, pr, diff = (share / "issue.md").read_text(), (share / "pr.md").read_text(), (share / "diff.patch").read_text()
    for private in ("tickets.csv", "queue_owner", "wren.example@example.org", "ghp_", "/ho" + "me/dana"):
        assert private not in issue + pr + diff, private
    assert "‹data file›" in issue and "‹field›" in issue and "‹secret›" in issue and "test_semicolon.py" in diff
    feed = (Path(os.environ["THIMBLE_HOME"]) / "lean" / "events" / "s1.jsonl").read_text().splitlines()
    assert json.loads(feed[-1])["kind"] == "fix_ask" and json.loads(feed[-1])["slug"] == fx["slug"]
    hits = json.loads((share / "scan.json").read_text())
    field = next(h for h in hits if h["found"] == "queue_owner" and h["where"] == "issue")
    token = next(h for h in hits if h["kind"] == "token")
    with pytest.raises(FX.FixError, match="never kept"):
        FX.keep(fx["slug"], token["id"], ask["id"], Store())
    FX.keep(fx["slug"], field["id"], ask["id"], Store())
    assert "queue_owner" in (share / "issue.md").read_text()
    # a wrong id sends nothing
    with pytest.raises(FX.FixError, match="no draft"):
        FX.send(fx["slug"], "send", "f000000000000")
    assert log(env, "gh") == [] and log(env, "git") == []
    lines = FX.send(fx["slug"], "send", ask["id"])
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
    ask = json.loads((share / "ask.json").read_text())
    FX.send(fx["slug"], "send", ask["id"])
    gh = log(env, "gh")
    assert gh[0] == "api user" and len(gh) == 2 and gh[1].startswith("issue create") and log(env, "git") == []


def test_file_mode_writes_one_markdown_file(env: Path):
    fx = FX.new("Rows for semicolon CSV files")
    change(fx)
    f = env / "d.md"
    f.write_text(DRAFT.format(tok="Cd4" * 12))
    FX.draft(fx["slug"], str(f), Store())
    ask = json.loads((FX.fix_dir(fx["slug"]) / "share" / "ask.json").read_text())
    (env / "person" / "Downloads").mkdir()
    out = FX.send(fx["slug"], "file", ask["id"])
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
    ask = json.loads((share / "ask.json").read_text())["id"]
    assert FX.send(fx["slug"], "send", ask) == ["The person sent the report under their GitHub login: issue https://example.invalid/test-user/issues/2."]
    assert not any(l.startswith(("repo fork", "pr create")) for l in log(env, "gh")) and log(env, "git") == []
