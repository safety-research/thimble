"""The environment of the sessions thimble starts. Claude Code's background service is shared by all of the user's
sessions: the first `claude` that needs it starts it and keeps that process's environment for every background
session it runs later. So no `claude` thimble runs carries thimble's variables in its own environment, each session
gets its own in its --settings `env`, and a session's name (THIMBLE_SESSION) counts only with the token that proves it,
so the user's own sessions are never taken for thimble's agents.

A stand-in for the CLI (FAKE) plays the service: the first `claude --bg` or `claude agents` keeps its environment as
the service's, and each `claude --bg` session's environment is that one with the caller's PATH and the session's
--settings `env` over it, as Claude Code builds it."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import agent_session, bg_session, config, dev, hook_auth, orient_session, tools, userconf, views

CORPUS = "mini"

FAKE = r'''
import json, os, sys
from pathlib import Path
argv = sys.argv[1:]
state = Path(os.environ["FAKE_BG"])
sessions = state / "sessions"
sessions.mkdir(parents=True, exist_ok=True)
with open(state / "calls.jsonl", "a") as f:
    f.write(json.dumps({"argv": argv[:2], "env": dict(os.environ)}) + "\n")
service = state / "service.json"
if ("--bg" in argv or argv[:1] == ["agents"]) and not service.exists():
    service.write_text(json.dumps(dict(os.environ)))
if "--bg" in argv:
    settings = json.loads(argv[len(argv) - argv[::-1].index("--settings")]) if "--settings" in argv else {}
    env = {**json.loads(service.read_text()), "PATH": os.environ.get("PATH", ""), **(settings.get("env") or {})}
    short = f"{len(list(sessions.iterdir())) + 1:08x}"
    name = argv[argv.index("-n") + 1] if "-n" in argv else ""
    (sessions / f"{short}.json").write_text(json.dumps({"id": short, "sessionId": short + "-0000-0000-0000-000000000000",
                                                        "name": name, "cwd": os.getcwd(), "env": env}))
    print(f"backgrounded · {short} · {name}")
elif argv[:1] == ["agents"]:
    rows = [json.loads(p.read_text()) for p in sorted(sessions.iterdir())]
    print(json.dumps([{"kind": "background", "id": r["id"], "sessionId": r["sessionId"], "name": r["name"],
                       "cwd": r["cwd"], "pid": int(os.environ["FAKE_PID"]), "state": "working", "status": "working"}
                      for r in rows]))
'''


@pytest.fixture()
def service(tmp_path, monkeypatch, workspaces_tmp):
    """The stand-in CLI as every `claude` thimble runs; the folder it records into."""
    script = tmp_path / "claude"
    script.write_text(f"#!{sys.executable}\n{FAKE}")
    script.chmod(0o755)
    state = tmp_path / "bg"
    sleeper = subprocess.Popen(["sleep", "600"])
    for module in (agent_session, dev):
        monkeypatch.setattr(module, "CLAUDE_BIN", str(script))
    monkeypatch.setattr(agent_session, "POLL_S", 0.05)
    monkeypatch.setattr(agent_session, "STOP_WAIT_S", 1.0)
    monkeypatch.setattr(bg_session, "POLL_S", 0.05)
    monkeypatch.setattr(bg_session, "IDENTIFY_TRIES", 3)
    monkeypatch.setattr(dev, "IDENTIFY_POLL_S", 0.05)
    monkeypatch.setenv("FAKE_BG", str(state))
    monkeypatch.setenv("FAKE_PID", str(sleeper.pid))
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    agent_session._runs.clear()
    yield state
    sleeper.kill()
    sleeper.wait()
    agent_session._runs.clear()


def _stack(monkeypatch, root: Path, port: int) -> dict[str, str]:
    """What a stack's server holds in its environment, as `thimble server up` starts it."""
    values = {"THIMBLE_HOME": str(root / "home"), "THIMBLE_PORT": str(port), "THIMBLE_CALLER_CWD": str(root / "corpus"),
              "THIMBLE_PLUGIN_ROOT": str(root / "plugin")}
    for k, v in values.items():
        monkeypatch.setenv(k, v)
    return values


def _sessions(state: Path) -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted((state / "sessions").iterdir())]


async def _orientation(c: str = CORPUS) -> dict:
    """The orientation as a background session; the stand-in's record of it."""
    await orient_session.start(c, "")
    await agent_session.stop(c, orient_session.KEY)
    await bg_session.shutdown()
    bg_session._closing = False
    return _sessions(Path(os.environ["FAKE_BG"]))[-1]


async def _view_build(c: str = CORPUS) -> dict:
    """A view build of the dev agent's, as a background session; the stand-in's record of it."""
    corpus, folder = config.corpus_dir(c), views.views_dir(c) / "posts"
    conf = dev.dev_config(c, sandbox=True)
    await dev.SESSIONS.start(corpus, "Build the view.", name="thimble view: Posts", workspace=c,
                             fence=dev.view_fence(c, "posts", corpus, folder, conf),
                             asking=dev.view_asking(c, "posts", folder, conf))
    return _sessions(Path(os.environ["FAKE_BG"]))[-1]


def _users_own(state: Path, cwd: Path) -> dict:
    """A `claude --bg` the user starts in their own shell; the stand-in's record of it."""
    shell = {k: v for k, v in os.environ.items() if not k.startswith("THIMBLE_")}
    subprocess.run([agent_session.CLAUDE_BIN, "--bg", "-n", "mine", "--", "hello"], env=shell, cwd=cwd, check=True,
                   capture_output=True)
    return _sessions(state)[-1]


def _proven(monkeypatch, env: dict, home: str, c: str = CORPUS) -> bool:
    """Whether the session's token proves its name to the stack whose home is `home`."""
    with monkeypatch.context() as m:
        m.setenv("THIMBLE_HOME", home)
        return hook_auth.session_proven(c, env.get("THIMBLE_SESSION", ""), env.get("THIMBLE_SESSION_TOKEN", ""))


async def test_each_stack_s_session_sees_its_own_values_and_the_user_s_own_session_none_of_thimble_s(
        service, monkeypatch, tmp_path):
    """Stack A's orientation is the first `claude` to need the background service, which so keeps the environment of
    that `claude`. Stack B's view build and the user's own `claude --bg` come after it. Each sees only its own values,
    and the user's session has no session name or token of thimble's."""
    a = _stack(monkeypatch, tmp_path / "a", 9721)
    orient = await _orientation()
    a_home = a["THIMBLE_HOME"]
    work = orient_session.work_dir(CORPUS)
    kept = json.loads((service / "service.json").read_text())
    assert not [k for k in kept if k.startswith("THIMBLE_")], "the service keeps none of thimble's variables"
    for name in ("XDG_CACHE_HOME", "MPLCONFIGDIR", agent_session.MEMORY_ENV, agent_session.BG_WAIT_ENV):
        assert kept.get(name) == os.environ.get(name), name

    env = orient["env"]
    assert env["THIMBLE_SESSION"] == orient_session.KEY and _proven(monkeypatch, env, a_home)
    assert (env["THIMBLE_HOME"], env["THIMBLE_PORT"], env["THIMBLE_PLUGIN_ROOT"]) == \
        (a_home, a["THIMBLE_PORT"], a["THIMBLE_PLUGIN_ROOT"])
    assert env["XDG_CACHE_HOME"] == str(work / agent_session.CACHE_DIR)
    assert env["PATH"].split(os.pathsep)[0] == str(Path(sys.prefix) / "bin")
    assert env["THIMBLE_CALLER_CWD"] == "" and env["THIMBLE_CHANNEL"] == ""

    b = _stack(monkeypatch, tmp_path / "b", 9722)
    view = (await _view_build())["env"]
    assert view["THIMBLE_SESSION"] == "view:posts" and _proven(monkeypatch, view, b["THIMBLE_HOME"])
    assert not _proven(monkeypatch, view, a_home), "a token proves its name to its own stack only"
    assert view["THIMBLE_HOME"] == view["THIMBLE_PORT"] == view["THIMBLE_CALLER_CWD"] == ""
    assert view["XDG_CACHE_HOME"] == os.environ.get("XDG_CACHE_HOME", "") != env["XDG_CACHE_HOME"]
    assert view[agent_session.MEMORY_ENV] == "" and view["THIMBLE_RENDERED_PROMPTS"] == ""

    calls = [json.loads(line) for line in (service / "calls.jsonl").read_text().splitlines()]
    assert {c["argv"][0] for c in calls} >= {"agents", "--bg", "stop"}
    for c in calls:
        assert not [k for k in c["env"] if k.startswith("THIMBLE_")], c["argv"]
        assert c["env"].get("XDG_CACHE_HOME") == os.environ.get("XDG_CACHE_HOME"), c["argv"]

    mine = _users_own(service, tmp_path)["env"]
    assert not [k for k in mine if k.startswith("THIMBLE_")], "the user's own session gets nothing of thimble's"
    assert mine.get("XDG_CACHE_HOME") == os.environ.get("XDG_CACHE_HOME")


async def test_a_session_keeps_its_own_values_when_the_service_holds_another_session_s(service, monkeypatch, tmp_path):
    """A background service an older thimble started holds an orientation's variables. thimble's sessions get their own
    values over every one of them; the user's own session still sees them, but its THIMBLE_SESSION comes without a
    token, which the shim and the server do not believe."""
    service.mkdir()
    elsewhere = tmp_path / "elsewhere"
    held = {**os.environ, "THIMBLE_SESSION": "orient", "THIMBLE_HOME": str(elsewhere / "home"), "THIMBLE_PORT": "8771",
            "THIMBLE_CALLER_CWD": str(elsewhere / "corpus"), "THIMBLE_RENDERED_PROMPTS": str(elsewhere / "prompts"),
            "XDG_CACHE_HOME": str(elsewhere / "work" / ".cache"), "MPLCONFIGDIR": str(elsewhere / "mpl"),
            agent_session.MEMORY_ENV: "1", "THIMBLE_DEV_DIR": str(elsewhere / "dev")}
    (service / "service.json").write_text(json.dumps(held))
    a = _stack(monkeypatch, tmp_path / "a", 9721)
    env = (await _orientation())["env"]
    assert env["THIMBLE_HOME"] == a["THIMBLE_HOME"] and env["THIMBLE_PORT"] == "9721"
    assert env["THIMBLE_CALLER_CWD"] == "" and env["THIMBLE_DEV_DIR"] == os.environ.get("THIMBLE_DEV_DIR", "")
    assert env["MPLCONFIGDIR"].startswith(str(orient_session.work_dir(CORPUS)))
    view = (await _view_build())["env"]
    for name in ("THIMBLE_HOME", "THIMBLE_PORT", "THIMBLE_CALLER_CWD", "THIMBLE_DEV_DIR", "THIMBLE_RENDERED_PROMPTS"):
        assert view[name] == "", name
    assert view["XDG_CACHE_HOME"] == os.environ.get("XDG_CACHE_HOME", "")
    assert view["MPLCONFIGDIR"] == os.environ.get("MPLCONFIGDIR", "") and view[agent_session.MEMORY_ENV] == ""

    mine = _users_own(service, tmp_path)["env"]
    assert mine["THIMBLE_SESSION"] == "orient" and "THIMBLE_SESSION_TOKEN" not in mine
    shim = subprocess.run([str(config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"), "--list"], env=mine,
                          capture_output=True, text=True, timeout=60)
    listed = {t["name"] for t in json.loads(shim.stdout)}
    analysts, orientations = ({t["name"] for t in tools.list(tools.ANALYST, session=s)} for s in (None, "orient"))
    assert listed == analysts != orientations, "the analyst's tools, not the orientation's"


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
                                                              "view_check", "hook_auth", "cc_channel", "prompts", "config",
                                                              "tools"))]
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
