"""The environment of the sessions thimble starts. No `claude` thimble runs carries thimble's variables in its own
environment: each session gets its own in its --settings `env`, and a session's name (THIMBLE_SESSION) counts only with
the token that proves it, so the user's own sessions are never taken for thimble's agents.

A stand-in for the CLI (FAKE) records, for each `claude -p` thimble runs, the process's environment and the session's,
which is that one with the session's --settings `env` over it, as Claude Code builds it."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import agent_session, config, dev, hook_auth, orient_session, tools, userconf, views

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
if "--agent" in argv:
    time.sleep(30)  # an orientation runs until the test stops it
'''


@pytest.fixture()
def service(tmp_path, monkeypatch, workspaces_tmp):
    """The stand-in CLI as every `claude` thimble runs; the folder it records into."""
    script = tmp_path / "claude"
    script.write_text(f"#!{sys.executable}\n{FAKE}")
    script.chmod(0o755)
    state = tmp_path / "bg"
    for module in (agent_session, dev):
        monkeypatch.setattr(module, "CLAUDE_BIN", str(script))
    monkeypatch.setattr(agent_session, "POLL_S", 0.05)
    monkeypatch.setattr(agent_session, "STOP_WAIT_S", 1.0)
    monkeypatch.setenv("FAKE_BG", str(state))
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    agent_session._runs.clear()
    yield state
    agent_session._runs.clear()


def _stack(monkeypatch, root: Path, port: int) -> dict[str, str]:
    """What a stack's server holds in its environment, as `thimble server up` starts it."""
    values = {"THIMBLE_HOME": str(root / "home"), "THIMBLE_PORT": str(port), "THIMBLE_CALLER_CWD": str(root / "corpus"),
              "THIMBLE_PLUGIN_ROOT": str(root / "plugin")}
    for k, v in values.items():
        monkeypatch.setenv(k, v)
    return values


def _calls(state: Path) -> list[dict]:
    return [json.loads(line) for line in (state / "calls.jsonl").read_text().splitlines()]


async def _orientation(state: Path, c: str = CORPUS) -> dict:
    """The orientation's session; the stand-in's record of it."""
    await orient_session.start(c, "")
    for _ in range(100):
        if (state / "calls.jsonl").is_file():
            break
        await __import__("asyncio").sleep(0.05)
    await agent_session.stop(c, orient_session.KEY)
    return _calls(state)[-1]


async def _view_build(state: Path, c: str = CORPUS) -> dict:
    """A view build of the dev agent's; the stand-in's record of it."""
    corpus, folder, work = config.corpus_dir(c), views.views_dir(c) / "posts", dev.view_work_dir(c, "posts")
    work.mkdir(parents=True, exist_ok=True)
    conf = dev.dev_config(c, sandbox=True)
    sessions = dev.Sessions()
    got = await sessions.start(work, "Build the view.", name="thimble view: Posts", workspace=c,
                               add_dirs=(folder, corpus), fence=dev.view_fence(c, "posts", corpus, folder, conf),
                               asking=dev.view_asking(c, "posts", folder, conf))
    await sessions._turns[got["id"]].task
    return _calls(state)[-1]


def _proven(monkeypatch, env: dict, home: str, c: str = CORPUS) -> bool:
    """Whether the session's token proves its name to the stack whose home is `home`."""
    with monkeypatch.context() as m:
        m.setenv("THIMBLE_HOME", home)
        return hook_auth.session_proven(c, env.get("THIMBLE_SESSION", ""), env.get("THIMBLE_SESSION_TOKEN", ""))


async def test_each_stack_s_session_sees_its_own_values_and_no_claude_process_carries_thimble_s(
        service, monkeypatch, tmp_path):
    """Stack A's orientation and stack B's view build each see only their own values, in their --settings `env`; the
    `claude` processes themselves carry none of thimble's variables."""
    a = _stack(monkeypatch, tmp_path / "a", 9721)
    orient = await _orientation(service)
    a_home = a["THIMBLE_HOME"]
    work = orient_session.work_dir(CORPUS)
    assert orient["argv"][:2] == ["-p", "--plugin-dir"] and "--bg" not in orient["argv"]
    env = orient["env"]
    assert env["THIMBLE_SESSION"] == orient_session.KEY and _proven(monkeypatch, env, a_home)
    assert (env["THIMBLE_HOME"], env["THIMBLE_PORT"], env["THIMBLE_PLUGIN_ROOT"]) == \
        (a_home, a["THIMBLE_PORT"], a["THIMBLE_PLUGIN_ROOT"])
    assert env["XDG_CACHE_HOME"] == str(work / agent_session.CACHE_DIR)
    assert env["PATH"].split(os.pathsep)[0] == str(Path(sys.prefix) / "bin")
    assert env["THIMBLE_CALLER_CWD"] == "" and env["THIMBLE_LAUNCHED"] == ""
    assert env[agent_session.BG_WAIT_ENV] == agent_session.BG_WAIT_MS

    b = _stack(monkeypatch, tmp_path / "b", 9722)
    view = (await _view_build(service))["env"]
    assert view["THIMBLE_SESSION"] == "view:posts" and _proven(monkeypatch, view, b["THIMBLE_HOME"])
    assert not _proven(monkeypatch, view, a_home), "a token proves its name to its own stack only"
    assert view["THIMBLE_HOME"] == view["THIMBLE_PORT"] == view["THIMBLE_CALLER_CWD"] == ""
    assert view["XDG_CACHE_HOME"] == os.environ.get("XDG_CACHE_HOME", "") != env["XDG_CACHE_HOME"]
    assert view[agent_session.MEMORY_ENV] == "1" and view["THIMBLE_RENDERED_PROMPTS"] == ""
    assert view[agent_session.BG_WAIT_ENV] == agent_session.BG_WAIT_MS

    for c in _calls(service):
        assert not [k for k in c["process"] if k.startswith("THIMBLE_")], c["argv"]
        assert c["process"].get("XDG_CACHE_HOME") == os.environ.get("XDG_CACHE_HOME"), c["argv"]


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


def test_the_shim_believes_a_session_name_only_with_its_token(tmp_path):
    """A process whose environment names a session of thimble's but has no token, such as the user's own session
    started where THIMBLE_SESSION was set, gets the analyst's tools from the shim, not that session's."""
    elsewhere = tmp_path / "elsewhere"
    env = {**os.environ, "THIMBLE_SESSION": orient_session.KEY, "THIMBLE_HOME": str(elsewhere / "home"),
           "THIMBLE_PORT": "8771"}
    env.pop("THIMBLE_SESSION_TOKEN", None)
    shim = subprocess.run([str(config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"), "--list"], env=env,
                          capture_output=True, text=True, timeout=60)
    listed = {t["name"] for t in json.loads(shim.stdout)}
    analysts, orientations = ({t["name"] for t in tools.list(tools.ANALYST, session=s)} for s in (None, orient_session.KEY))
    assert listed == analysts != orientations, "the analyst's tools, not the orientation's"


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


def test_sessions_that_start_together_on_a_new_home_share_one_key(monkeypatch, tmp_path):
    """The first sessions of a new home start at once, as an orientation and view builds do: each gets a token, and
    every token proves its session."""
    import threading

    for i in range(20):
        monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / f"home{i}"))
        barrier, tokens = threading.Barrier(8), []

        def start() -> None:
            barrier.wait()
            tokens.append(hook_auth.session_token(CORPUS, "orient"))

        threads = [threading.Thread(target=start) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(tokens) == 8 and all(hook_auth.session_proven(CORPUS, "orient", t) for t in tokens)
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
    assert env["XDG_CACHE_HOME"] == "/mine/.cache" and env["THIMBLE_RENDERED_PROMPTS"] == ""
    plain = config.session_env({}, stack=False)
    assert plain["THIMBLE_HOME"] == plain["THIMBLE_SESSION"] == "" and "THIMBLE_SOMETHING" not in plain
    assert set(config.SESSION_VARS) | set(config.STACK_VARS) <= set(plain)


def test_every_variable_a_session_s_own_code_reads_is_set_for_it():
    """The plugin's programs and hooks, and the server modules they import, read only THIMBLE_* names that session_env
    sets for each session, so none can come from another session through the background service."""
    import re

    root = config.REPO_ROOT
    files = [*(root / "plugin" / "bin").iterdir(),
             *(root / "backend" / "app" / f"{m}.py" for m in ("permission_hook", "call_ref", "sandbox_allow", "scratch_hook",
                                                              "work_budget", "view_check", "hook_auth", "cc_plugin",
                                                              "prompts", "config", "tools"))]
    names = {n for f in files if f.is_file() for n in re.findall(r"\bTHIMBLE_[A-Z][A-Z0-9_]*", f.read_text("utf-8"))}
    # a constant's name, and the server's fallback model, which no session's code uses
    names -= {"THIMBLE_PREFIXES", "THIMBLE_FALLBACK_MODEL"}
    assert names <= set(config.SESSION_VARS) | set(config.STACK_VARS), \
        sorted(names - set(config.SESSION_VARS) - set(config.STACK_VARS))


@pytest.mark.parametrize("stack", [True, False])
def test_the_plugin_runs_in_the_environment_a_session_gets(tmp_path, stack):
    """A name the server does not have reaches a session as "", which every reader takes as unset: the shim lists its
    tools and its instructions and the launcher renders a prompt."""
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path),
           **config.session_env({"THIMBLE_SESSION": "orient", "THIMBLE_SESSION_TOKEN": "n.m"}, stack=stack, environ={})}
    bin_ = config.REPO_ROOT / "plugin" / "bin"
    for argv in ([bin_ / "thimble-mcp", "--list"], [bin_ / "thimble-mcp", "--instructions"],
                 [bin_ / "thimble", "prompt", "preamble", "--cwd", str(tmp_path)]):
        done = subprocess.run([str(a) for a in argv], env=env, cwd=tmp_path, capture_output=True, text=True, timeout=120)
        assert done.returncode == 0 and done.stdout.strip(), (argv, done.stderr[-2000:])


def test_a_session_s_call_from_its_workspace_folder_runs_in_that_workspace(monkeypatch, tmp_path, data_tmp,
                                                                           plugin_headers):
    """The orientation runs in its work folder inside the workspace's own folder. Its calls run in that workspace even
    when another corpus's folder holds thimble's workspaces folder, as a corpus opened on the home folder does. A call
    from there that names a session without a token, as a session an earlier thimble started makes, does not run."""
    from fastapi.testclient import TestClient

    from app.main import app

    outer = tmp_path / "outer"
    monkeypatch.setattr(config, "WORKSPACES_DIR", (outer / "workspaces").resolve())
    work = config.workspace_dir(CORPUS) / "orient" / "work"
    work.mkdir(parents=True)
    assert config.register_corpus(outer)["name"] != CORPUS
    seen: list = []

    async def call(c, name, args, **kw):
        seen.append((c, kw["session"]))
        return tools.ok("done")

    monkeypatch.setattr(tools, "call", call)
    body = {"args": {"group": "all"}, "cwd": str(work), "session": "orient"}
    with TestClient(app) as client:
        def post(**extra) -> dict:
            r = client.post("/api/tools/list_cards", json={**body, **extra}, headers=plugin_headers())
            assert r.status_code == 200, r.text
            return r.json()

        assert not post(session_token=hook_auth.session_token(CORPUS, "orient"))["is_error"]
        old = post()
        assert old["is_error"] and "did not run" in old["content"][0]["text"]
    assert seen == [(CORPUS, "orient")]


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
    options = sdk.build(cwd=tmp_path, tools=[], mcp_servers={}, system_append="", model=None, effort=None, env=None)
    async for _ in query(prompt="hello", options=options):
        pass
    starts = [json.loads(line) for line in log.read_text().splitlines()]
    assert [s["argv"] for s in starts] == [s["argv"] for s in starts if s["argv"][:1] != ["-v"]] != []
    assert options.env["THIMBLE_HOME"] == ""
