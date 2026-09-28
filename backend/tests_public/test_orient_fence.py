"""The fence and permissions of the sessions thimble starts: the process runs in its work folder, where alone it
writes; Edit, Write and sandboxed Bash refuse the whole corpus folder; nothing limits what it reads; Claude Code's Bash
sandbox runs where it can (no network) and its absence never blocks the session; the fence allows nothing of thimble's
own, so Claude Code's own permission mode decides; and Start's mode switcher becomes the session's mode, defaulting to
the one the analyst's own stands for. install.sh never runs sudo."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from app import agent_session, cc_settings, channel, config, ledger, orient_session

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _config(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    (tmp_path / "cc").mkdir()
    monkeypatch.delenv("THIMBLE_SANDBOX", raising=False)
    cc_settings._sandbox.clear()
    yield
    cc_settings._sandbox.clear()


def test_the_fence_denies_the_whole_corpus_folder_blocks_no_read_and_adds_the_sandbox_where_it_runs():
    cwd, work = config.corpus_dir(CORPUS), orient_session.work_dir(CORPUS)
    plain = agent_session.fence(cwd, work, sandbox=False)
    # the session's process runs in the work folder, so the corpus folder is an added working directory and is denied
    # whole, to the file tools and to the sandbox's Bash alike: no write, append, delete or new file (a deny of
    # each existing entry would leave `touch <corpus>/probe.txt` open)
    assert plain == {"permissions": {"additionalDirectories": [str(cwd)], "deny": [f"Edit(/{cwd}/**)"]},
                     "claudeMdExcludes": agent_session.memory_excludes(cwd, work)}, "no allow of thimble's own"
    boxed = agent_session.fence(cwd, work, sandbox=True)
    # no read block and no Read deny: thimble's own tree is read under the analyst's permission mode like any other
    # folder outside the corpus
    for settings in (plain, boxed):
        assert "blockReadsOutsideWorkingDirectories" not in settings["permissions"]
        assert not [r for r in settings["permissions"]["deny"] if r.startswith(("Read", "Grep", "Glob"))]
    sandbox = boxed["sandbox"]
    assert sandbox["enabled"] and not sandbox["allowUnsandboxedCommands"]
    assert sandbox["autoAllowBashIfSandboxed"] is False, "which Bash calls ask is Claude Code's own asking in the mode"
    unasked = agent_session.fence(cwd, work, sandbox=True, unasked=True)
    assert unasked["permissions"]["allow"] == [f"Edit(/{work}/**)"] and unasked["sandbox"]["autoAllowBashIfSandboxed"], \
        "a check's run, which nobody watches, keeps its own allows"
    assert sandbox["failIfUnavailable"] is False, "the sandbox's absence never blocks the session"
    # Bash stays offline although the session has the web tools, so a script cannot send the corpus anywhere
    assert sandbox["network"] == {"deniedDomains": ["*"]}
    assert "filesystem" not in sandbox, "nothing hides a folder from Bash, so no read needs re-opening"
    env = agent_session.fence_env(work)
    assert env["PATH"].split(":")[0] == str(Path(sys.prefix) / "bin")
    assert env["XDG_CACHE_HOME"] == str(work / agent_session.CACHE_DIR) and (work / agent_session.CACHE_DIR).is_dir()
    assert env[agent_session.MEMORY_ENV] == "1", "the corpus's CLAUDE.md, read as the added folder's"


def test_the_corpus_folder_s_settings_never_choose_the_mode_and_the_settings_route_opens_on_the_user_s(tmp_path):
    """A corpus is other agents' work: a .claude/settings*.json in it must not pre-select Bypass."""
    cwd = config.corpus_dir(CORPUS)
    planted = cwd / ".claude"
    planted.mkdir(exist_ok=True)
    for name in ("settings.json", "settings.local.json"):
        (planted / name).write_text(json.dumps({"permissions": {"defaultMode": "bypassPermissions"}}))
    assert cc_settings.permission_mode(cwd) == "default"
    assert ledger.get_settings(CORPUS)["orient_permissions"] == "manual"
    assert orient_session.mode_of(CORPUS, None) == "manual"
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"permissions": {"defaultMode": "auto"}}))
    assert ledger.get_settings(CORPUS)["orient_permissions"] == "auto"
    ledger.put_settings(CORPUS, {"orient_permissions": "manual"})
    assert ledger.get_settings(CORPUS)["orient_permissions"] == "manual", "a stored choice wins"
    assert orient_session.mode_of(CORPUS, None) == "manual", "and a tool-started orientation takes it"
    assert orient_session.mode_of(CORPUS, "bypass") == "bypass", "Start's choice wins over it"
    assert cc_settings.permission_mode(cwd) == "auto"


def _hook(argv: list[str], event: dict, capsys) -> str:
    import io

    from app import sandbox_allow

    sys_stdin = sys.stdin
    try:
        sys.stdin = io.StringIO(json.dumps(event))
        assert sandbox_allow.main(argv) == 0
    finally:
        sys.stdin = sys_stdin
    return capsys.readouterr().out


def test_the_sandbox_hook_allows_bash_and_leaves_an_excluded_command_and_other_tools_to_the_mode(capsys):
    bash = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": "python3 -c \"rows=[json.loads(l) for l in open('t.jsonl')]\""}}
    out = json.loads(_hook([], bash, capsys))
    assert out["hookSpecificOutput"]["permissionDecision"] == "allow"
    assert out["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    excluded = ["--exclude", "docker"]
    docker = {**bash, "tool_input": {"command": "cd x && /usr/bin/docker run img"}}
    assert _hook(excluded, docker, capsys) == "", "an excluded command runs outside the sandbox: the mode decides"
    assert json.loads(_hook(excluded, bash, capsys))["hookSpecificOutput"]["permissionDecision"] == "allow"
    assert _hook([], {**bash, "tool_name": "Write"}, capsys) == ""
    assert _hook([], {**bash, "hook_event_name": "PostToolUse"}, capsys) == ""
    assert _hook([], {**bash, "tool_input": {}}, capsys) == ""
