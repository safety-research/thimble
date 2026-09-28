"""The Claude Code sessions thimble starts beside main (agent_session.py, orient_session.py): their launch arguments,
their permissions and their lifetime. The orientation's session gets its agent with --agents and --agent, thimble's own
tools and the plugin's skills in --allowedTools (for a checkout and a release install alike, so they never ask), the
thimble tools it does not keep in --disallowedTools, --permission-mode from the mode Start chose, THIMBLE_SESSION, the
permission hook and the fence in --settings, and nothing that widens the analyst's permissions. Every request reaches
the server through the PermissionRequest hook: Manual waits for the analyst, Bypass grants. One orientation runs at a
time, and stopping it or shutting the server down ends its process group. Its transcript becomes the orientation's chat,
its subagents and workflow agents its steps, and its end tells main in one line what it made.

A stand-in for the CLI (FAKE, run as agent_session.CLAUDE_BIN) records its argv, its environment and what it read on
stdin, and writes what Claude Code writes for such a session: the transcript under the config dir's projects/, a
subagent's transcript with its meta json, a workflow's run directory with its journal.jsonl and agent transcript, and
stream-json on stdout whose last `result` is the summary."""
from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import (agent_session, agents, channel, cli, config, ledger, orient_session, orientation, permission_hook,
                 prompts, session, tools)

CORPUS = "mini"
KEY = orient_session.KEY
MARKETPLACE = "thimble-local"  # scripts/release.sh's default name

SUMMARY = "The corpus is one file, runs.jsonl, with 12 runs [[card:aaaa1111]]."

FAKE = r'''
import json, os, sys, time
from pathlib import Path
argv = sys.argv[1:]
out = Path(os.environ["FAKE_DIR"])
(out / "argv.json").write_text(json.dumps(argv))
(out / "env.json").write_text(json.dumps({k: os.environ.get(k) for k in ("THIMBLE_SESSION", "THIMBLE_CHANNEL", "XDG_CACHE_HOME", "MPLCONFIGDIR",
                                                                        "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "THIMBLE_RENDERED_PROMPTS",
                                                                        "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS")}
                                          | {"PATH0": os.environ.get("PATH", "").split(os.pathsep)[0], "cwd": os.getcwd()}))
with open(out / "argvs.jsonl", "a") as f:
    f.write(json.dumps(argv) + "\n")
resume = "--resume" in argv
sid = argv[argv.index("--resume" if resume else "--session-id") + 1]
brief = sys.stdin.read()
(out / "stdin.txt").write_text(brief)
proj = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "-corpus"
proj.mkdir(parents=True, exist_ok=True)
main = proj / f"{sid}.jsonl"
subs = proj / sid / "subagents"
run_dir = subs / "workflows" / "wf_1"
run_dir.mkdir(parents=True, exist_ok=True)
def put(path, *recs):
    with open(path, "a") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
print(json.dumps({"type": "system", "subtype": "init", "session_id": sid}), flush=True)
calls = sum(1 for _ in open(out / "argvs.jsonl"))
if resume:
    k = calls
    put(main, {"type": "user", "message": {"role": "user", "content": brief}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"b{k}", "name": "Bash", "input": {"command": f"grep -c run{k} runs.jsonl"}}]}})
    time.sleep(float(os.environ.get("FAKE_SLEEP") or 0))
    put(main, {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"b{k}", "content": f"{k}"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": f"done {k}"}]}})
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": f"done {k}"}), flush=True)
    sys.exit(0)
if os.environ.get("FAKE_MODE") == "sleep":
    put(main, {"type": "user", "message": {"role": "user", "content": brief}})
    time.sleep(60)
    sys.exit(0)
put(main, {"type": "user", "message": {"role": "user", "content": brief}},
    {"type": "assistant", "effort": "high", "message": {"content": [{"type": "tool_use", "id": "t_agent", "name": "Agent",
        "input": {"subagent_type": "general-purpose", "description": "Read runs.jsonl", "prompt": "Read runs.jsonl"}}]}})
put(subs / "agent-a1reader.jsonl",
    {"type": "user", "isSidechain": True, "message": {"role": "user", "content": "Read runs.jsonl"}},
    {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "tool_use", "id": "r1", "name": "Read", "input": {"file_path": "runs.jsonl"}}]}},
    {"type": "user", "isSidechain": True, "message": {"content": [{"type": "tool_result", "tool_use_id": "r1", "content": "12 lines"}]}},
    {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "12 runs, 3 tasks."}]}})
(subs / "agent-a1reader.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": "Read runs.jsonl", "toolUseId": "t_agent"}))
put(main, {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t_agent", "content": "12 runs, 3 tasks."}]}},
    {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t_wf", "name": "Workflow", "input": {"script": "export const meta = {name: 'x'}"}}]}},
    {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t_wf", "content": f"Workflow launched in background. Task ID: w1\nTranscript dir: {run_dir}\n"}]}})
put(run_dir / "journal.jsonl", {"type": "launched"}, {"type": "started", "agentId": "wa1", "label": "runs", "phase": "Count"})
put(run_dir / "agent-wa1.jsonl",
    {"type": "user", "isSidechain": True, "message": {"role": "user", "content": "Count the runs by task"}},
    {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "4 each."}]}})
put(run_dir / "journal.jsonl", {"type": "result", "agentId": "wa1", "result": "4 each."})
put(main, {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": "<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>t_wf</tool-use-id>\n<status>completed</status>\n</task-notification>"}},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": SUMMARY}]}})
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": SUMMARY}), flush=True)
'''.replace("SUMMARY", json.dumps(SUMMARY))


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    session._live.clear()
    session._expected.clear()
    channel._subs.clear()
    agent_session._runs.clear()
    yield
    channel._subs.clear()
    agent_session._runs.clear()


@pytest.fixture()
def fake(tmp_path, monkeypatch) -> Path:
    """The stand-in CLI as THIMBLE_CLAUDE_BIN, the config dir it writes into, and the folder it records into."""
    script = tmp_path / "claude"
    script.write_text(f"#!{sys.executable}\n{FAKE}")
    script.chmod(0o755)
    out = tmp_path / "fake"
    out.mkdir()
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(script))
    monkeypatch.setattr(agent_session, "POLL_S", 0.05)
    monkeypatch.setattr(agent_session, "STOP_WAIT_S", 1.0)
    monkeypatch.setenv("FAKE_DIR", str(out))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setenv("THIMBLE_CHANNEL", "plugin:thimble@inline")  # the server's own, inherited from main's session
    monkeypatch.delenv("FAKE_MODE", raising=False)
    monkeypatch.delenv("FAKE_SLEEP", raising=False)
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")  # the fence without the sandbox; test_the_fence turns it on
    return out


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


async def _done(key: str = orient_session.KEY) -> None:
    run = agent_session._runs.get((CORPUS, key))
    if run is not None and run.task is not None:
        await asyncio.wait_for(run.task, 10)


def _brief(fake: Path) -> str:
    """The first message the session read on stdin."""
    return (fake / "stdin.txt").read_text()


def _agent(fake: Path) -> dict:
    """The orientation's agent as the session was given it with --agents, after checking it is the one --agent names."""
    argv = json.loads((fake / "argv.json").read_text())
    defined = json.loads(argv[argv.index("--agents") + 1])
    assert list(defined) == [orientation.AGENT] and argv[argv.index("--agent") + 1] == orientation.AGENT
    return defined[orientation.AGENT]


def _fenced(**settings) -> dict:
    """The orientation's --settings: the caller's choices, the fence without the sandbox (the fixture turns it off), the
    subagents' scratch folders, the permission hook and the call-ref hooks."""
    work = orient_session.work_dir(CORPUS)
    fence = agent_session.fence(config.corpus_dir(CORPUS), work, sandbox=False)
    fence["permissions"]["ask"] = ["WebFetch", "WebSearch"]  # Manual: the web asks (agent_session, the web)
    return {**settings, **fence, "hooks": {**agent_session.scratch_hooks(work), **agent_session.permission_hooks(CORPUS),
                                           **agent_session.call_hooks(CORPUS)}}


def _disallowed(fake: Path) -> list[str]:
    argv = json.loads((fake / "argv.json").read_text())
    i = argv.index("--disallowedTools") + 1
    out = []
    while i < len(argv) and not argv[i].startswith("--"):
        out.append(argv[i])
        i += 1
    return out


def _parts(prompt: str) -> set[str]:
    """The keys of orient_session.PARTS whose `#### ` part the prompt holds, and of LINES whose line it holds."""
    return ({k for k, h in orient_session.PARTS.items() if f"\n#### {h}\n" in prompt}
            | {k for k, s in orient_session.LINES.items() if s in prompt})


async def _settled() -> None:
    """Every run of the orientation has ended and none waits to start."""
    await asyncio.sleep(0.1)
    for _ in range(200):
        await _done()
        if not orient_session.running(CORPUS) and not (orientation.read_run(CORPUS) or {}).get("queue"):
            await asyncio.sleep(0.1)
            if not orient_session.running(CORPUS):
                return
        await asyncio.sleep(0.05)
    raise AssertionError("the orientation did not settle")


# ----------------------------------------------------------------------------- how a session asks for permission


async def _pending(chat: str, n: int = 1) -> list[dict]:
    """The chat's pending permission requests once it has `n`."""
    for _ in range(200):
        ps = agents.read_meta(CORPUS, chat).get("permissions") or []
        if len(ps) >= n:
            return ps
        await asyncio.sleep(0.02)
    raise AssertionError(f"fewer than {n} requests on the chat")


def _ask(tool: str, inp: dict, agent_id: str | None = None, key: str = KEY) -> "asyncio.Future":
    return asyncio.ensure_future(agent_session.ask(CORPUS, key, tool, inp, agent_id=agent_id))


def _flag(argv: list[str]) -> str:
    return argv[argv.index("--permission-mode") + 1]


async def test_every_session_asks_through_the_permission_hook_and_no_prompt_tool(fake):
    """The settings of every session carry the permission hook for PermissionRequest and PermissionDenied (a
    --permission-prompt-tool never hears a background agent's request), with a day to wait, told the workspace."""
    run = await orient_session.start(CORPUS, "")
    await _done()
    argv = json.loads((fake / "argv.json").read_text())
    assert "--permission-prompt-tool" not in argv
    hooks = json.loads(argv[argv.index("--settings") + 1])["hooks"]["PermissionRequest"]
    [hook] = hooks[0]["hooks"]
    assert hooks[0]["matcher"] == "*" and hook["timeout"] == permission_hook.TIMEOUT == 86_400
    assert "permission_hook.py" in hook["command"] and hook["command"].endswith(f"--ws {CORPUS}")
    settings = json.loads(argv[argv.index("--settings") + 1])
    assert settings["hooks"]["PermissionDenied"] == hooks and "PreToolUse" not in settings["hooks"]
    assert run.mode == "manual" and _flag(argv) == "default", "no Start and no mode of the analyst's: Manual"
    assert "ask_permission" not in tools.REGISTRY


async def test_manual_waits_for_the_analyst_however_long_while_a_writer_s_request_is_denied_after_a_minute(fake, monkeypatch):
    """Manual is Claude Code's manual mode: each request it makes waits on the orientation's card, with the agent that
    asked, until the analyst answers, with no minute's deny. A writer, which runs in the analyst's own mode, keeps the minute."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    monkeypatch.setattr(agent_session, "PERMISSION_WAIT_S", 0.05)
    run = await orient_session.start(CORPUS, "")
    assert run.patient and agents.read_meta(CORPUS, run.chat)["permission_mode"] == "manual"
    inp = {"command": "touch notes.md", "description": "Create notes.md"}
    call = _ask("Bash", inp, agent_id="a1")
    [p] = await _pending(run.chat)
    assert (p["tool"], p["what"], p["agent_id"]) == ("Bash", "Create notes.md", "a1") and "touch notes.md" in p["input"]
    await asyncio.sleep(0.3)
    assert not call.done(), "no time limit in Manual"
    assert (await agent_session.permission_route(CORPUS, run.chat, agent_session.PermissionAnswer(id=p["id"], allow=True)))["allow"]
    assert await call == {"behavior": "allow", "updatedInput": inp}
    call = _ask("Write", {"file_path": "x"})
    [p] = await _pending(run.chat)
    agent_session.answer(CORPUS, run.chat, p["id"], False)
    assert await call == {"behavior": "deny", "message": agent_session.DENIED_LINE}
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert [(r["event"], r.get("tool"), r.get("answer")) for r in log] == [
        ("asked", "Bash", None), ("answered", None, "allow"), ("asked", "Write", None), ("answered", None, "deny")]
    assert log[0]["agent_id"] == "a1" and log[0]["chat"] == run.chat and log[0]["session"] == KEY and log[0]["mode"] == "manual"
    assert await agent_session.ask(CORPUS, "writer:report", "Bash", inp) == {"behavior": "deny", "message": agent_session.GONE_LINE}
    await orient_session.stop(CORPUS)
    await _done()
    run = agent_session.Run(CORPUS, "writer:report", "w1", "sid-w", Path("."), "writer", pid=1)
    agent_session._runs[(CORPUS, run.key)] = run
    try:
        run.chat = str(agents.new_agent(CORPUS, "writer", "Write report")["id"])
        assert not run.patient
        assert await agent_session.ask(CORPUS, run.key, "Bash", inp) == {
            "behavior": "deny", "message": agent_session.timed_out_line(0.05)}
        last = json.loads((config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()[-1])
        assert last["answer"] == "deny: nobody answered in time" and last["chat"] == run.chat
        [expired] = agents.read_meta(CORPUS, run.chat)["permissions"]
        assert expired["expired"] and expired["tool"] == "Bash", "it stays on the card, marked denied unanswered"
        assert agent_session.answer(CORPUS, run.chat, expired["id"], False), "Dismiss takes it off"
        assert agents.read_meta(CORPUS, run.chat)["permissions"] == []
        assert agent_session.timed_out_line(60).startswith("Nobody answered in thimble's browser within a minute,")
        assert "within 10 minutes," in agent_session.timed_out_line(600)
        assert "within 90 seconds," in agent_session.timed_out_line(90)
    finally:
        agent_session._runs.pop((CORPUS, run.key), None)


async def test_bypass_grants_every_request_and_switches_with_manual_while_the_session_runs(fake, monkeypatch):
    """Bypass never asks and runs in Claude Code's manual mode, so the card switches it with Manual on the same
    process: a switch to Bypass grants what waits, the critique's included, and after a switch back the next request
    waits again. The record keeps the mode for a follow-up."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    channel.post(CORPUS, "start", {"text": "", "permissions": "bypass"})
    run = await orient_session.start(CORPUS, "")
    pid = run.pid
    assert run.mode == "bypass" and _flag(run.argv) == "default"
    assert agents.read_meta(CORPUS, run.chat)["permission_mode"] == "bypass"
    assert await agent_session.ask(CORPUS, KEY, "Bash", {"command": "rm -r out"}) == {"behavior": "allow",
                                                                                   "updatedInput": {"command": "rm -r out"}}
    assert not agents.read_meta(CORPUS, run.chat).get("permissions"), "nothing reached the card"
    assert agent_session.set_mode(CORPUS, run.chat, "manual") == {"mode": "manual", "switching": None}
    assert orientation.read_run(CORPUS)["permissions"] == "manual"
    call = _ask("Bash", {"command": "rm -r out"})
    # the critique follows the orientation's mode at each request
    critic = agent_session.Run(CORPUS, "critique:orient", "", "sid-c", Path("."), "step", pid=1, mode="manual", mode_owner=KEY, patient=True)
    critic.chat = str(agents.new_agent(CORPUS, "step", "critique", parent=run.chat)["id"])
    agent_session._runs[(CORPUS, critic.key)] = critic
    try:
        asked = _ask("Read", {"file_path": "/etc/hosts"}, key=critic.key)
        await _pending(run.chat)
        await _pending(critic.chat)
        assert agent_session.set_mode(CORPUS, run.chat, "bypass") == {"mode": "bypass", "switching": None}
        assert (await call)["behavior"] == "allow" and (await asked)["behavior"] == "allow", "what waited is granted"
        assert run.pid == pid and _flag(run.argv) == "default", "the same process"
        assert agents.read_meta(CORPUS, run.chat)["permission_mode"] == "bypass"
        with pytest.raises(HTTPException) as e:
            await agent_session.mode_route(CORPUS, critic.chat, agent_session.ModeBody(mode="auto"))
        assert e.value.status_code == 409, "the critique has no mode of its own"
    finally:
        agent_session._runs.pop((CORPUS, critic.key), None)
    with pytest.raises(HTTPException) as e:
        await agent_session.mode_route(CORPUS, run.chat, agent_session.ModeBody(mode="yolo"))
    assert e.value.status_code == 400
    await orient_session.stop(CORPUS)
    await _done()
    with pytest.raises(HTTPException) as e:
        await agent_session.mode_route(CORPUS, run.chat, agent_session.ModeBody(mode="manual"))
    assert e.value.status_code == 404


RULE = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test *"}], "behavior": "allow",
        "destination": "localSettings"}
EDITS = {"type": "setMode", "mode": "acceptEdits", "destination": "session"}


def test_the_permission_hook_hands_the_request_to_the_server_and_prints_its_decision(monkeypatch, capsys):
    sent: list[tuple[str, dict]] = []

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    answer = {"behavior": "deny", "message": "Denied from thimble's browser."}

    def urlopen(req, timeout=None):
        sent.append((req.full_url, json.loads(req.data)))
        assert timeout == permission_hook.TIMEOUT
        return Resp(json.dumps(answer).encode())

    monkeypatch.setattr(permission_hook.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(permission_hook, "server_url", lambda: "http://127.0.0.1:8311")
    monkeypatch.setenv("THIMBLE_SESSION", KEY)
    hook = {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"},
            "agent_id": "a1", "agent_type": "general-purpose", "session_id": "sid"}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0
    assert sent == [("http://127.0.0.1:8311/api/ws/mini/sessions/permission",
                     {"session": KEY, "event": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"},
                      "agent_id": "a1", "agent_type": "general-purpose"})]
    assert json.loads(capsys.readouterr().out) == {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                                                          "decision": answer}}
    answer = {"behavior": "allow", "updatedInput": {"command": "ls"}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    permission_hook.main(["--ws", CORPUS])
    assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]["decision"] == {"behavior": "allow"}
    # Claude Code's "don't ask again" choices go to the server, and the ones the analyst chose come back in the decision
    updates = [{**RULE, "destination": "session"}]
    answer = {"behavior": "allow", "updatedInput": {"command": "ls"}, "updatedPermissions": updates}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({**hook, "permission_suggestions": [RULE]})))
    permission_hook.main(["--ws", CORPUS])
    assert sent[-1][1]["suggestions"] == [RULE]
    assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]["decision"] == {"behavior": "allow",
                                                                                     "updatedPermissions": updates}

    def down(req, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(permission_hook.urllib.request, "urlopen", down)
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "no server: no decision"
    monkeypatch.delenv("THIMBLE_SESSION")
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "not a session thimble started"


# ----------------------------------------------------------------------------- thimble's own tools never ask, in any install


@pytest.fixture(params=["checkout", "release"])
def install(request, fake, tmp_path, monkeypatch) -> SimpleNamespace:
    """The plugin copy a session thimble starts loads (`session`) and the one main runs from (`main`), for each install
    kind. A release: the plugin in $THIMBLE_HOME/app/plugin beside the marketplace file release.sh writes, registered
    and enabled in Claude Code's settings as thimble@thimble-local, whose installed copy in the plugin cache is main's,
    which its launcher exports as THIMBLE_PLUGIN_ROOT (cli.plugin_root)."""
    if request.param == "checkout":
        monkeypatch.delenv(cli.PLUGIN_ROOT_ENV, raising=False)
        return SimpleNamespace(session=agent_session.PLUGIN_DIR, main=cli.PLUGIN_DIR)
    app = tmp_path / "thimble-home" / "app"
    shutil.copytree(config.REPO_ROOT / "plugin", app / "plugin", ignore=shutil.ignore_patterns("__pycache__"))
    (app / ".claude-plugin").mkdir(parents=True)
    (app / ".claude-plugin" / "marketplace.json").write_text(json.dumps(
        {"name": MARKETPLACE, "plugins": [{"name": "thimble", "source": "./plugin"}]}))
    conf = Path(os.environ["CLAUDE_CONFIG_DIR"])
    version = json.loads((app / "plugin" / ".claude-plugin" / "plugin.json").read_text())["version"]
    cached = conf / "plugins" / "cache" / MARKETPLACE / "thimble" / version
    shutil.copytree(app / "plugin", cached)
    conf.mkdir(parents=True, exist_ok=True)
    (conf / "settings.json").write_text(json.dumps({
        "enabledPlugins": {f"thimble@{MARKETPLACE}": True},
        "extraKnownMarketplaces": {MARKETPLACE: {"source": {"source": "directory", "path": str(app)}}}}))
    monkeypatch.setattr(agent_session, "PLUGIN_DIR", app / "plugin")
    monkeypatch.setenv(cli.PLUGIN_ROOT_ENV, str(cached))
    return SimpleNamespace(session=app / "plugin", main=cached)


def model_names(plugin: Path) -> dict[str, str]:
    """Each tool of the plugin's thimble server by its registry name, as the model of a session that loads `plugin`
    calls it: Claude Code names a plugin's MCP tool from the manifest's name and the server's key in its .mcp.json."""
    name = json.loads((plugin / ".claude-plugin" / "plugin.json").read_text())["name"]
    [server] = json.loads((plugin / ".mcp.json").read_text())["mcpServers"]
    return {t: f"mcp__plugin_{name}_{server}__{t}" for t in tools.REGISTRY}


def skill_names(plugin: Path) -> list[str]:
    """The plugin's own skills as a Skill call names them, `<plugin>:<skill>`, in a permission rule."""
    name = json.loads((plugin / ".claude-plugin" / "plugin.json").read_text())["name"]
    return [f"Skill({name}:{d.name})" for d in sorted((plugin / "skills").iterdir()) if (d / "SKILL.md").is_file()]


def permits(rules: list[str], tool: str) -> bool:
    """Whether an allow rule lets `tool` run without a permission request, as Claude Code matches one: the tool's own
    name, or its MCP server's whole rule (`mcp__<server>`, or `mcp__<server>__*`)."""
    server = tool.rsplit("__", 1)[0] if tool.startswith("mcp__") else None
    return any(r == tool or (server is not None and r in (server, server + "__*")) for r in rules)


def allowed(argv: list[str]) -> list[str]:
    return argv[argv.index("--allowedTools") + 1:argv.index("--disallowedTools")]  # every session has both


def own_tools(argv: list[str], plugin: Path) -> list[str]:
    """The thimble tools a session has: its agent names no tools, so every tool of the plugin copy it loads that its
    --disallowedTools leave, which name them as that copy does."""
    agent = next(iter(json.loads(argv[argv.index("--agents") + 1]).values()))
    assert "tools" not in agent, "the agent inherits every tool of the session"
    i, denied = argv.index("--disallowedTools") + 1, set()
    while i < len(argv) and not argv[i].startswith("--"):
        denied.add(argv[i])
        i += 1
    names = set(model_names(plugin).values())
    assert {t for t in denied if t.startswith("mcp__")} <= names, "the tools taken away are the plugin copy's"
    return sorted(names - denied)


def assert_own_tools_ask_nothing(argv: list[str], plugin: Path) -> None:
    """Every thimble tool the session has, and every skill of the plugin, is allowed."""
    rules = allowed(argv)
    own = own_tools(argv, plugin)
    assert own, "the session keeps thimble tools of its own"
    assert [t for t in own if not permits(rules, t)] == [], "no thimble tool of the session asks"
    assert [s for s in skill_names(plugin) if s not in rules] == [], "no skill of the plugin asks"


def _assert_works_in_its_own_folder(fake: Path, work: Path) -> None:
    """The session's process runs in `work` with the corpus folder added and denied to every file tool, and its edits in
    `work` and its Bash in the sandbox, off the network, ask nothing (agent_session, the fence)."""
    corpus = config.corpus_dir(CORPUS)
    argv = json.loads((fake / "argv.json").read_text())
    settings = json.loads(argv[argv.index("--settings") + 1])
    assert json.loads((fake / "env.json").read_text())["cwd"] == str(work)
    assert argv[argv.index("--add-dir") + 1] == str(corpus)
    assert settings["permissions"]["deny"] == [f"Edit(/{corpus}/**)"]
    assert settings["permissions"]["allow"] == [f"Edit(/{work}/**)"]
    assert settings["sandbox"]["autoAllowBashIfSandboxed"] and settings["sandbox"]["network"] == {"deniedDomains": ["*"]}
    assert [h["matcher"] for h in settings["hooks"]["PreToolUse"]] == ["Bash"], "the sandbox hook allows sandboxed Bash"
