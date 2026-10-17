"""The environment of the sessions thimble starts. No `claude` thimble runs carries thimble's variables in its own
environment: each session gets its own in its --settings `env`, and a session's name (THIMBLE_SESSION) counts only with
the token that proves it, so the user's own sessions are never taken for thimble's agents.

A stand-in for the CLI (FAKE) records, for each `claude -p` thimble runs, the process's environment and the session's,
which is that one with the session's --settings `env` over it, as Claude Code builds it."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app import agent_session, config, hook_auth, tools, userconf

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
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(script))
    monkeypatch.setenv("FAKE_BG", str(state))
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    yield state


def _stack(monkeypatch, root: Path, port: int) -> dict[str, str]:
    """What a stack's server holds in its environment, as `thimble server up` starts it."""
    values = {"THIMBLE_HOME": str(root / "home"), "THIMBLE_PORT": str(port), "THIMBLE_CALLER_CWD": str(root / "corpus"),
              "THIMBLE_PLUGIN_ROOT": str(root / "plugin")}
    for k, v in values.items():
        monkeypatch.setenv(k, v)
    return values


def _calls(state: Path) -> list[dict]:
    return [json.loads(line) for line in (state / "calls.jsonl").read_text().splitlines()]


def _proven(monkeypatch, env: dict, home: str, c: str = CORPUS) -> bool:
    """Whether the session's token proves its name to the stack whose home is `home`."""
    with monkeypatch.context() as m:
        m.setenv("THIMBLE_HOME", home)
        return hook_auth.session_proven(c, env.get("THIMBLE_SESSION", ""), env.get("THIMBLE_SESSION_TOKEN", ""))


def test_a_call_names_its_session_only_with_the_token_that_proves_it(monkeypatch, workspaces_tmp, plugin_headers):
    """A tool call that names a session runs as that session only with its token. Without one it runs as the analyst's
    (the user's own session, given a session name by Claude Code's background service); with a wrong one it does not
    run."""
    from fastapi.testclient import TestClient

    from app.main import app

    seen: list = []

    async def call(c, name, args, **kw):
        seen.append(kw["session"])
        return tools.ok("done")

    monkeypatch.setattr(tools, "call", call)
    token = hook_auth.session_token(CORPUS, "orient")
    body = {"args": {"group": "all"}, "workspace": CORPUS}
    with TestClient(app) as client:
        def post(**extra) -> dict:
            r = client.post("/api/tools/list_cards", json={**body, **extra}, headers=plugin_headers())
            assert r.status_code == 200, r.text
            return r.json()

        assert not post(session="orient", session_token=token)["is_error"]
        assert not post(session="orient")["is_error"]
        wrong = post(session="orient", session_token=hook_auth.session_token(CORPUS, "writer:report"))
        assert wrong["is_error"] and "did not run" in wrong["content"][0]["text"]
        assert post(session="orient", session_token="0.0")["is_error"]
    assert seen == ["orient", None]


def test_the_session_key_is_private_to_thimble_and_outlives_a_restart(monkeypatch, tmp_path):
    """The key the tokens are signed with is a file in thimble's home, readable by its owner alone, which no agent may
    read, and a token stays good across a restart of the server."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    token = hook_auth.session_token(CORPUS, "orient")
    key = tmp_path / "home" / hook_auth.SESSION_KEY
    assert key.stat().st_mode & 0o777 == 0o600 and str(key) in userconf.private_paths()
    assert hook_auth.session_proven(CORPUS, "orient", token)
    assert not hook_auth.session_proven("other", "orient", token) and not hook_auth.session_proven(CORPUS, "dev", token)
    assert hook_auth.session_token(CORPUS, "orient") != token, "each start gets a token of its own"


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


def test_a_call_takes_the_users_auth_but_not_their_memory_effort_or_mode(tmp_path):
    """sdk.build: a structured call runs the user's own `claude` with their user settings only, in safe mode (no
    CLAUDE.md, hooks, plugins or MCP servers of theirs), with its own system prompt, effort, fast mode, ultracode and
    permission mode."""
    from app import sdk

    opts = sdk.build(cwd=tmp_path, tools=["mcp__out__x"], mcp_servers={}, system="You are a text classifier.",
                     model="claude-opus-5-5", effort="low", env=None, speed="standard", persist=False)
    assert opts.setting_sources == ["user"] and opts.strict_mcp_config
    assert "safe-mode" in opts.extra_args and "no-session-persistence" in opts.extra_args
    assert json.loads(opts.settings) == {"fastMode": False, "ultracode": False, "env": {"CLAUDE_CODE_EFFORT_LEVEL": "low"}}
    assert opts.permission_mode == "dontAsk" and opts.allowed_tools == ["mcp__out__x"] and opts.tools == []
    assert opts.system_prompt == "You are a text classifier.", "the caller's system prompt, whole, in place of a preset"
