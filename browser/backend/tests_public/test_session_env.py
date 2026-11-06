"""The environment of the sessions thimble starts. No `claude` thimble runs carries thimble's variables in its own
environment: each session gets its own in its --settings `env`, so a value meant for another session or another
thimble never reaches it.

A stand-in for the CLI (FAKE) records, for each `claude -p` thimble runs, the process's environment and the session's,
which is that one with the session's --settings `env` over it, as Claude Code builds it."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from app import agent_session, config, dev, hook_auth, userconf

CORPUS = "mini"

FAKE = r'''
import json, os, sys, time
from pathlib import Path
argv = sys.argv[1:]
state = Path(os.environ["FAKE_BG"])
state.mkdir(parents=True, exist_ok=True)
settings = json.loads(argv[len(argv) - argv[::-1].index("--settings")]) if "--settings" in argv else {}
with open(state / "calls.jsonl", "a") as f:
    f.write(json.dumps({"argv": argv[:3], "process": dict(os.environ),
                        "env": {**os.environ, **(settings.get("env") or {})}}) + "\n")
sys.stdin.read()
print(json.dumps({"type": "result", "is_error": False, "result": "ok"}), flush=True)
'''


@pytest.fixture()
def service(tmp_path, monkeypatch, workspaces_tmp):
    """The stand-in CLI as every `claude` thimble runs; the folder it records into."""
    script = tmp_path / "claude"
    script.write_text(f"#!{sys.executable}\n{FAKE}")
    script.chmod(0o755)
    state = tmp_path / "bg"
    monkeypatch.setattr(dev, "CLAUDE_BIN", str(script))
    monkeypatch.setenv("FAKE_BG", str(state))
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    yield state


def _stack(monkeypatch, root: Path, port: int) -> dict[str, str]:
    """What a stack's server holds in its environment, as thimble-browser starts it."""
    values = {"THIMBLE_HOME": str(root / "home"), "THIMBLE_PORT": str(port), "THIMBLE_CALLER_CWD": str(root / "corpus"),
              "THIMBLE_PLUGIN_ROOT": str(root / "plugin")}
    for k, v in values.items():
        monkeypatch.setenv(k, v)
    return values


def _calls(state: Path) -> list[dict]:
    return [json.loads(line) for line in (state / "calls.jsonl").read_text().splitlines()]


async def _ticket_session(state: Path, c: str = CORPUS) -> dict:
    """`thimble fix`'s session of the dev agent's (the one `claude -p` job thimble still starts); the stand-in's record
    of it."""
    work = config.workspace_dir(c) / "ticket-7"
    work.mkdir(parents=True, exist_ok=True)
    sessions = dev.Sessions()
    got = await sessions.start(work, "Fix the server.", name="thimble fix", workspace=c)
    await sessions._turns[got["id"]].task
    return _calls(state)[-1]


async def test_each_stack_s_session_sees_its_own_values_and_no_claude_process_carries_thimble_s(
        service, monkeypatch, tmp_path):
    """Stack A's `thimble fix` session and stack B's each see only their own values, in their --settings `env`; the
    `claude` processes themselves carry none of thimble's variables."""
    _stack(monkeypatch, tmp_path / "a", 9721)
    first = (await _ticket_session(service))["env"]
    assert first["THIMBLE_SESSION"] == dev.SESSION_KEY and first["THIMBLE_CALLER_CWD"] == ""

    _stack(monkeypatch, tmp_path / "b", 9722)
    view = (await _ticket_session(service))["env"]
    assert view["THIMBLE_SESSION"] == dev.SESSION_KEY
    assert view["THIMBLE_HOME"] == view["THIMBLE_PORT"] == view["THIMBLE_CALLER_CWD"] == ""
    assert view["XDG_CACHE_HOME"] == os.environ.get("XDG_CACHE_HOME", "")
    assert view[agent_session.BG_WAIT_ENV] == agent_session.BG_WAIT_MS

    for c in _calls(service):
        assert not [k for k in c["process"] if k.startswith("THIMBLE_")], c["argv"]
        assert c["process"].get("XDG_CACHE_HOME") == os.environ.get("XDG_CACHE_HOME"), c["argv"]


def test_the_session_key_is_private_to_thimble_and_outlives_a_restart(monkeypatch, tmp_path):
    """The key thimble signs with is a file in thimble's home, readable by its owner alone, which no agent may read,
    and a restart of the server reads the same key."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    hook_auth.ensure_session_key()
    key = tmp_path / "home" / hook_auth.SESSION_KEY
    assert key.stat().st_mode & 0o777 == 0o600 and str(key) in userconf.private_paths()
    first = key.read_text()
    hook_auth.ensure_session_key()
    assert key.read_text() == first, "a start keeps the key it finds"


def test_starts_together_on_a_new_home_share_one_key(monkeypatch, tmp_path):
    """The first users of a new home's key come at once: they all read one key."""
    import threading

    for i in range(20):
        monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / f"home{i}"))
        barrier, keys = threading.Barrier(8), []

        def start() -> None:
            barrier.wait()
            hook_auth.ensure_session_key()
            keys.append((tmp_path / f"home{i}" / hook_auth.SESSION_KEY).read_text())

        threads = [threading.Thread(target=start) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(keys) == 8 and len(set(keys)) == 1
        assert os.listdir(tmp_path / f"home{i}") == [hook_auth.SESSION_KEY]


def test_the_server_writes_the_session_key_as_it_starts(monkeypatch, tmp_path, workspaces_tmp):
    """The key is in place before any session starts, so the sessions' sandbox hides a file that is there."""
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    with TestClient(app):
        assert (tmp_path / "home" / hook_auth.SESSION_KEY).stat().st_mode & 0o777 == 0o600


def test_launch_and_session_environments(monkeypatch):
    """launch_environ keeps none of thimble's variables; session_env gives a session its own values over every name a
    service could hold from another session."""
    monkeypatch.setenv("THIMBLE_HOME", "/h")
    monkeypatch.setenv("THIMBLE_SESSION", "orient")
    monkeypatch.setenv("THIMBLE_SOMETHING", "x")
    monkeypatch.setenv("XDG_CACHE_HOME", "/mine/.cache")
    assert not [k for k in config.launch_environ() if k.startswith("THIMBLE_")]
    env = config.session_env({"THIMBLE_SESSION": "writer:report"})
    assert env["THIMBLE_SESSION"] == "writer:report" and env["THIMBLE_HOME"] == "/h" and env["THIMBLE_SOMETHING"] == "x"
    assert env["XDG_CACHE_HOME"] == "/mine/.cache" and env["THIMBLE_CALLER_CWD"] == ""
    plain = config.session_env({}, stack=False)
    assert plain["THIMBLE_HOME"] == plain["THIMBLE_SESSION"] == "" and "THIMBLE_SOMETHING" not in plain
    assert set(config.SESSION_VARS) | set(config.STACK_VARS) <= set(plain)


async def test_a_structured_call_runs_no_claude_with_thimble_s_variables(tmp_path, monkeypatch):
    """The Agent SDK checks the version with a `claude -v` that gets this process's whole environment: it runs none, and
    the call's own `claude` gets every THIMBLE_* variable empty."""
    from claude_agent_sdk import query

    from app import sdk

    fake = Path(__file__).parent / "fixtures" / "agents" / "fake_sdk_claude.py"
    exe = tmp_path / "claude"
    exe.write_text(f"#!{sys.executable}\n{fake.read_text()}")
    exe.chmod(0o755)
    log = tmp_path / "starts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv(sdk.SKIP_VERSION_CHECK_ENV, "")
    monkeypatch.delenv(sdk.SKIP_VERSION_CHECK_ENV)
    monkeypatch.setattr(config, "CLI_PATH", str(exe))
    options = sdk.build(cwd=tmp_path, tools=[], mcp_servers={}, system="", model="claude-opus-5-5", effort="low", env=None)
    async for _ in query(prompt="hello", options=options):
        pass
    starts = [json.loads(line) for line in log.read_text().splitlines()]
    assert [s["argv"] for s in starts] == [s["argv"] for s in starts if s["argv"][:1] != ["-v"]] != []
    assert options.env["THIMBLE_HOME"] == ""
