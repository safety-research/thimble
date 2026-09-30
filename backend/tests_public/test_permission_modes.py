"""Each agent's permission mode (modes.py), the orientation's Auto mode and the hook's route (agent_session,
permissions; permission_hook.py). An agent runs in its row of the settings, else in the mode Claude Code reports to
main's hooks. Auto is Claude Code's own auto mode: a call it refuses never reaches a PermissionRequest hook, so its
PermissionDenied hook brings the call to the card, where it waits for the analyst like any request. The hook's route
answers for the session its shim names.

A stand-in for the CLI (FAKE, run as agent_session.CLAUDE_BIN) records its argv and stdin and writes the transcript
records Claude Code writes in each case; SIGINT ends it as it ends `claude -p`."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from conftest import print_sessions
from fastapi import HTTPException

from app import agent_session, agents, cc_channel, channel, config, ledger, modes, orient_session, session, tools, userconf

CORPUS = "mini"
KEY = orient_session.KEY

FAKE = r'''
import json, os, signal, sys, time
from pathlib import Path
argv = sys.argv[1:]
out = Path(os.environ["FAKE_DIR"])
(out / "argv.json").write_text(json.dumps(argv))
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
subs.mkdir(parents=True, exist_ok=True)
def put(path, *recs):
    with open(path, "a") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
print(json.dumps({"type": "system", "subtype": "init", "session_id": sid}), flush=True)
mode = os.environ.get("FAKE_MODE") or ""
def interrupted(*recs):
    # what `claude -p` writes when SIGINT pauses it: the records, the interruption note, an error result, exit 1
    def handler(*_):
        put(main, *recs, {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}})
        print(json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True}), flush=True)
        sys.exit(1)
    signal.signal(signal.SIGINT, handler)
if mode == "switch" and not resume:
    # busy with a Bash call until the test releases it, then with a second call that asks for permission
    interrupted()
    put(main, {"type": "user", "message": {"role": "user", "content": brief}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t_busy", "name": "Bash", "input": {"command": "python3 count.py"}}]}})
    while not (out / "release").exists():
        time.sleep(0.05)
    put(main, {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t_busy", "content": "12"}]}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t_ask", "name": "Bash", "input": {"command": "touch notes.md"}}]}})
    time.sleep(60)
    sys.exit(0)
if mode == "switch_agent" and not resume:
    # a foreground subagent whose first command waits on a permission request and whose second waits behind it; a pause
    # answers the Agent call with a rejection before the interruption note
    interrupted({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t_ag", "is_error": True,
                                                          "content": "The user doesn't want to proceed with this tool use."}]}})
    put(main, {"type": "user", "message": {"role": "user", "content": brief}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t_ag", "name": "Agent",
            "input": {"subagent_type": "general-purpose", "description": "toucher", "prompt": "Touch two files"}}]}})
    put(subs / "agent-atouch.jsonl", {"type": "user", "isSidechain": True, "message": {"role": "user", "content": "Touch two files"}},
        {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "tool_use", "id": "s1", "name": "Bash", "input": {"command": "touch a"}},
                                                                            {"type": "tool_use", "id": "s2", "name": "Bash", "input": {"command": "touch b"}}]}})
    (subs / "agent-atouch.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": "toucher", "toolUseId": "t_ag"}))
    time.sleep(60)
    sys.exit(0)
if mode == "sleep" and not resume:
    put(main, {"type": "user", "message": {"role": "user", "content": brief}})
    time.sleep(60)
    sys.exit(0)
text = "done"
put(main, {"type": "user", "message": {"role": "user", "content": brief}},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": text}), flush=True)
'''


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
    """The stand-in CLI as agent_session.CLAUDE_BIN, the config dir it writes into, and the folder it records into."""
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
    monkeypatch.setenv("THIMBLE_CHANNEL", "plugin:thimble@inline")
    monkeypatch.delenv("FAKE_MODE", raising=False)
    # the fence without the sandbox, which the config then does not require; the fence's test turns it on
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    print_sessions(monkeypatch)
    return out


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


async def _done(key: str = KEY) -> None:
    run = agent_session._runs.get((CORPUS, key))
    if run is not None and run.task is not None:
        await asyncio.wait_for(run.task, 10)


async def _pending(chat: str, n: int = 1) -> list[dict]:
    """The chat's pending permission requests once it has `n`."""
    for _ in range(200):
        ps = agents.read_meta(CORPUS, chat).get("permissions") or []
        if len(ps) >= n:
            return ps
        await asyncio.sleep(0.02)
    raise AssertionError(f"fewer than {n} requests on the chat")


def _flag(argv: list[str]) -> str:
    return argv[argv.index("--permission-mode") + 1]


# ----------------------------------------------------------------------------- each agent's mode


async def test_each_agent_runs_in_its_row_else_in_main_s_mode_and_nothing_else_picks_one(fake, monkeypatch, analyst):
    """An agent's mode is the analyst's pick in Settings, else the mode Claude Code reports to main's hooks. No
    settings file, neither the corpus folder's nor the analyst's, chooses one, nor main's meta; start_orientation has no
    mode to give; and a mode the analyst's or the org's Claude Code settings turn off is refused and never used."""
    cwd = config.corpus_dir(CORPUS)
    (cwd / ".claude").mkdir(exist_ok=True)
    (cwd / ".claude" / "settings.json").write_text(json.dumps({"permissions": {"defaultMode": "bypassPermissions"}}))
    user = fake.parent / "claude-config" / "settings.json"
    user.parent.mkdir(parents=True, exist_ok=True)
    user.write_text(json.dumps({"permissions": {"defaultMode": "auto"}}))
    assert modes.mode_for(CORPUS, "orient") == "manual", "before main reports its mode: Manual"
    session._live[CORPUS] = session.Live(CORPUS, "sid-main", str(cwd), None, None)
    agents.write_meta(CORPUS, {**agents.ensure_main(CORPUS), "attached": {"session": "sid-main",
                                                                          "permission_mode": "bypassPermissions"}})
    assert modes.mode_for(CORPUS, "orient") == "manual", "a mode written into main's meta is no report"

    async def report(sid: str, mode: str) -> None:
        await channel.mode_route(channel.ModeBody(cwd=str(cwd), session=sid, permission_mode=mode))

    await report("sid-other", "bypassPermissions")
    assert modes.mode_for(CORPUS, "writer") == "manual", "another session's mode is not main's"
    await report("sid-main", "auto")
    assert [modes.mode_for(CORPUS, a) for a in modes.AGENTS] == ["auto"] * len(modes.AGENTS)
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"checks": "bypass", "writer": "manual"}})
    assert (modes.mode_for(CORPUS, "checks"), modes.mode_for(CORPUS, "writer"), modes.mode_for(CORPUS, "critic")) == \
        ("bypass", "manual", "auto"), "each row apart"
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"views": "manual"}})
    assert modes.mode_for(CORPUS, "dev") == modes.mode_for(CORPUS, "views") == "manual", "view builds are the dev agent's"
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"writer": None}})
    assert modes.mode_for(CORPUS, "writer") == "auto", "a row put back follows main again"

    assert "permissions" not in tools.schema_of("start_orientation")["properties"]
    seen: dict = {}

    async def fake_start(c, brief, passes, call=None, chosen=None, **_):
        seen.update(chosen=chosen)

    monkeypatch.setattr(orient_session, "start", fake_start)
    await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": "bypass"})
    assert seen["chosen"] == {}, "a model's call chooses no mode"

    user.write_text(json.dumps({"permissions": {"disableBypassPermissionsMode": "disable"}}))
    with pytest.raises(HTTPException) as e:
        ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"orient": "bypass"}})
    assert e.value.status_code == 400 and "Bypass" in e.value.detail
    assert modes.mode_for(CORPUS, "checks") == "auto", "a Bypass turned off is not used"
    assert ledger.get_settings(CORPUS)["disabled_modes"] == ["bypass"]
    user.write_text("{}")
    remote = user.parent / "remote-settings.json"
    remote.write_text(json.dumps({"disableAutoMode": "disable", "permissions": {"disableBypassPermissionsMode": "disable"}}))
    assert modes.disabled() == {"auto", "bypass"}, "the org's server-managed settings"
    remote.unlink()
    managed = fake.parent / "managed"
    (managed / "managed-settings.d").mkdir(parents=True)
    monkeypatch.setitem(cc_channel.MANAGED_DIRS, sys.platform, managed)
    (managed / "managed-settings.json").write_text(json.dumps({"permissions": {"disableBypassPermissionsMode": "disable"}}))
    (managed / "managed-settings.d" / "auto.json").write_text(json.dumps({"permissions": {"disableAutoMode": "disable"}}))
    assert modes.disabled() == {"auto", "bypass"}, "the managed file with its drop-ins"


def test_a_continued_background_session_keeps_the_mode_it_runs_in(fake, monkeypatch):
    """A background session resumed or sent a message keeps the flags it was launched with (agent_session.BG_AUTO_LINE),
    so its next run takes the mode its chat's meta records, not the row saved since nor a card's switch; a session of
    thimble's own, whose process starts again with its flags, takes the switch, else the row."""
    ledger.put_settings(CORPUS, {modes.SETTING: {"orient": "auto"}})
    chat = agents.new_agent(CORPUS, "orient", "Orientation", permission_mode="bypass", background=True)["id"]
    monkeypatch.setitem(agent_session._switched, (CORPUS, chat), "manual")
    assert agent_session.start_mode(CORPUS, "orient", chat=chat, background=True) == "bypass"
    assert agent_session.start_mode(CORPUS, "orient", chat=chat) == "manual", "a switch while this server runs"
    assert agent_session.start_mode(CORPUS, "orient") == "auto", "a new session: its row"
    monkeypatch.setattr(modes, "disabled", lambda: {"bypass"})
    assert agent_session.start_mode(CORPUS, "orient", chat=chat, background=True) == "manual", "Bypass turned off"
    old = agents.new_agent(CORPUS, "orient", "Orientation", background=True)["id"]
    assert agent_session.start_mode(CORPUS, "orient", chat=old, background=True) == "auto", "a meta with no mode: the row"


# ----------------------------------------------------------------------------- Auto


async def test_auto_is_claude_code_s_auto_mode_and_a_call_it_refuses_waits_for_the_analyst(fake, monkeypatch):
    """Auto pings intermittently: Claude Code's auto mode decides each call, and a call it refuses as risky comes to
    the card through the PermissionDenied hook with the reason and waits like a request. An allow is remembered for the
    call made again, which the hook before each call allows once, and a deny denies that call once. The allowed call
    shows as not run."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    ledger.put_settings(CORPUS, {modes.SETTING: {"orient": "auto"}})
    run = await orient_session.start(CORPUS, "")
    assert run.mode == "auto" and _flag(run.argv) == "auto"
    settings = json.loads(run.argv[run.argv.index("--settings") + 1])
    assert settings["hooks"]["PreToolUse"] == agent_session.permission_hooks(CORPUS, auto=True, wait=True)["PreToolUse"]
    assert settings["hooks"]["PermissionDenied"] == agent_session.permission_hooks(CORPUS)["PermissionDenied"]
    inp = {"command": "python3 -c 'print(6*7)'", "description": "Multiply"}
    body = dict(session=KEY, event="PermissionDenied", tool_name="Bash", tool_input=inp, agent_id="a2",
                tool_use_id="toolu_r1", reason="Runs code the analyst did not ask for")
    call = asyncio.ensure_future(agent_session.permission_request_route(CORPUS, agent_session.PermissionRequestBody(**body)))
    [p] = await _pending(run.chat)
    assert p["refused"] == "Runs code the analyst did not ask for" and p["agent_id"] == "a2"
    assert "rechecked" not in p and "deny_after_s" not in p, "a refusal waits for the analyst for good"
    await asyncio.sleep(0.2)
    assert not call.done(), "it waits for the analyst"
    agent_session.answer(CORPUS, run.chat, p["id"], True)
    assert (await call)["behavior"] == "allow"
    assert "toolu_r1" in session._not_run, "the refused call is made again"

    def pre(i: dict, agent: str | None = "a2") -> agent_session.PermissionRequestBody:
        return agent_session.PermissionRequestBody(session=KEY, event="PreToolUse", tool_name="Bash", tool_input=i,
                                                   agent_id=agent)

    assert await agent_session.permission_request_route(CORPUS, pre({"command": inp["command"]}, agent=None)) == {}, \
        "another agent"
    again = {**inp, "description": "Multiply six by seven"}
    assert await agent_session.permission_request_route(CORPUS, pre(again)) == {"behavior": "allow",
                                                                               "message": agent_session.ALLOWED_LINE}
    assert await agent_session.permission_request_route(CORPUS, pre(again)) == {}, "once"
    call = asyncio.ensure_future(agent_session.permission_request_route(
        CORPUS, agent_session.PermissionRequestBody(**{**body, "tool_use_id": "toolu_r2"})))
    [p] = await _pending(run.chat)
    agent_session.answer(CORPUS, run.chat, p["id"], False)
    assert (await call) == {"behavior": "deny", "message": agent_session.DENIED_LINE}
    assert "toolu_r2" not in session._not_run, "a denied call stays refused"
    assert await agent_session.permission_request_route(CORPUS, pre(inp)) == {"behavior": "deny",
                                                                             "message": agent_session.DENIED_LINE}
    await orient_session.stop(CORPUS)
    await _done()


async def test_a_call_auto_mode_gave_no_safety_verdict_on_goes_back_to_it_then_waits_a_while(fake, monkeypatch):
    """Both ways Claude Code says auto mode gave no verdict are no refusal: the call goes back to auto mode, and only
    then does the card ask, denying it unanswered after CLASSIFIER_ASK_S rather than waiting for good."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    monkeypatch.setattr(agent_session, "CLASSIFIER_WAITS_S", (0.01,))
    monkeypatch.setattr(agent_session, "CLASSIFIER_ASK_S", 0.2)
    _listen()
    ledger.put_settings(CORPUS, {modes.SETTING: {"orient": "auto"}})
    run = await orient_session.start(CORPUS, "")
    reasons = ("Classifier unavailable", "Auto mode unavailable — stopped after repeated responses with no safety verdict")
    for i, reason in enumerate(reasons, 1):
        body = agent_session.PermissionRequestBody(session=KEY, event="PermissionDenied", tool_name="Bash",
                                                   tool_input={"command": f"ls {i}"}, agent_id="a3",
                                                   tool_use_id=f"toolu_c{i}", reason=reason)
        assert (await agent_session.permission_request_route(CORPUS, body))["behavior"] == "allow", "back to auto mode"
        assert f"toolu_c{i}" in session._not_run
        call = asyncio.ensure_future(agent_session.permission_request_route(CORPUS, body))
        p = (await _pending(run.chat, i))[-1]
        assert p["refused"] == reason and p["deny_after_s"] == 0.2
        assert (await asyncio.wait_for(call, 5))["behavior"] == "deny"
    await orient_session.stop(CORPUS)
    await _done()


async def test_the_hook_s_route_answers_for_the_session_its_shim_names(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    ledger.put_settings(CORPUS, {modes.SETTING: {"orient": "bypass"}})
    await orient_session.start(CORPUS, "")
    body = agent_session.PermissionRequestBody(session=KEY, tool_name="Bash", tool_input={"command": "ls"}, agent_id="a9")
    assert await agent_session.permission_request_route(CORPUS, body) == {"behavior": "allow",
                                                                         "updatedInput": {"command": "ls"}}
    other = agent_session.PermissionRequestBody(session="writer:report", tool_name="Bash", tool_input={"command": "ls"})
    assert (await agent_session.permission_request_route(CORPUS, other))["behavior"] == "deny", \
        "Bypass grants the orientation's requests, never another session's"
    await orient_session.stop(CORPUS)
    await _done()


async def test_a_switch_into_auto_keeps_the_config_s_asks_waiting_for_the_analyst(fake, monkeypatch):
    """A session switched into Auto gets the same waiting hook before each call as one started there, and loses it on
    the way back."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    run = await orient_session.start(CORPUS, "")
    assert run.mode == "manual"

    def pre() -> list | None:
        return json.loads(run.argv[run.argv.index("--settings") + 1])["hooks"].get("PreToolUse")

    agent_session._set_flag(run, "auto")
    assert pre() == agent_session.permission_hooks(CORPUS, auto=True, wait=True)["PreToolUse"]
    agent_session._set_flag(run, "default")
    assert not pre()
    await orient_session.stop(CORPUS)
    await _done()
