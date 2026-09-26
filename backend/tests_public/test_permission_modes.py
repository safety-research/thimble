"""The orientation's permission modes beyond Manual and Bypass (agent_session, permissions and the mode switch;
permission_hook.py). Auto is Claude Code's own auto mode: a call it refuses never reaches a PermissionRequest hook, so
its PermissionDenied hook brings the call to the card, where it waits for the analyst like any request, and the hook
before each call lets the call made again run once. A switch into or out of Auto changes the process's
--permission-mode, so the session is paused when no call runs (a call that waits on the analyst counts as paused) and
resumed with its work in the new mode, told which agents stopped. The orientation's fence allows nothing of its own,
and thimble's own tools never ask in a critique or a check's run, whatever install the plugin came from.

A stand-in for the CLI (FAKE, run as agent_session.CLAUDE_BIN) records its argv and stdin and writes the transcript
records Claude Code writes in each case; SIGINT ends it as it ends `claude -p`."""
from __future__ import annotations

import asyncio
import io
import json
import sys
from pathlib import Path

import pytest

from app import agent_session, agents, channel, checks, config, notebook, orient_session, orientation, permission_hook
from app import session, tools
from test_agent_sessions import assert_own_tools_ask_nothing, install  # noqa: F401 — the fixture, used by name

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
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")  # the fence without the sandbox; the fence's test turns it on
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


def _ask(tool: str, inp: dict, agent_id: str | None = None, key: str = KEY) -> "asyncio.Future":
    return asyncio.ensure_future(agent_session.ask(CORPUS, key, tool, inp, agent_id=agent_id))


def _argvs(fake: Path) -> list[list[str]]:
    return [json.loads(line) for line in (fake / "argvs.jsonl").read_text().splitlines()]


def _flag(argv: list[str]) -> str:
    return argv[argv.index("--permission-mode") + 1]


async def _until(check, what: str, tries: int = 300) -> None:
    for _ in range(tries):
        if check():
            return
        await asyncio.sleep(0.02)
    raise AssertionError(what)


def _put(path: Path, *recs: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")


def _use(tid: str, name: str, inp: dict | None = None) -> dict:
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp or {}}]}}


def _result(tid: str) -> dict:
    return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": "ok"}]}}


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


# ----------------------------------------------------------------------------- Auto


async def test_auto_is_claude_code_s_auto_mode_and_a_call_it_refuses_waits_for_the_analyst(fake, monkeypatch):
    """Auto pings intermittently: Claude Code's auto mode decides each call, and a call it refuses as risky comes to
    the card through the PermissionDenied hook with the reason and waits like a request. An allow is remembered for the
    call made again, which the hook before each call allows once, and a deny denies that call once. The allowed call
    shows as not run."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    channel.post(CORPUS, "start", {"text": "", "permissions": "auto"})
    run = await orient_session.start(CORPUS, "")
    assert run.mode == "auto" and _flag(run.argv) == "auto"
    settings = json.loads(run.argv[run.argv.index("--settings") + 1])
    assert settings["hooks"]["PreToolUse"] == agent_session.permission_hooks(CORPUS, auto=True)["PreToolUse"]
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


async def test_a_call_auto_mode_gave_no_verdict_on_goes_back_to_it_before_the_card_asks_and_is_denied_unanswered(
        fake, monkeypatch):
    """"Classifier unavailable" is no verdict, so thimble judges nothing itself: after each short wait the hook answers
    `retry` with nothing remembered, the refused call shows as not run, and the call made again is auto mode's to judge.
    Once the waits for that call are spent the card asks, saying so, and in the orientation's mode an unanswered card
    denies the call after CLASSIFIER_ASK_S rather than holding the orientation. A switch of mode during a wait answers
    the call as it answers one on the card."""
    monkeypatch.setattr(agent_session, "CLASSIFIER_WAITS_S", (0.05, 0.05))
    monkeypatch.setattr(agent_session, "CLASSIFIER_ASK_S", 0.4)
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    channel.post(CORPUS, "start", {"text": "", "permissions": "auto"})
    run = await orient_session.start(CORPUS, "")
    inp = {"command": "python3 count.py", "description": "Count"}

    def refused(n: int, i: dict = inp) -> "asyncio.Future":
        body = agent_session.PermissionRequestBody(session=KEY, event="PermissionDenied", tool_name="Bash", tool_input=i,
                                                   agent_id="w1", tool_use_id=f"toolu_c{n}", reason="Classifier unavailable")
        return asyncio.ensure_future(agent_session.permission_request_route(CORPUS, body))

    pre = agent_session.PermissionRequestBody(session=KEY, event="PreToolUse", tool_name="Bash", tool_input=inp, agent_id="w1")
    for n in (1, 2):
        call = refused(n)
        await asyncio.sleep(0.01)
        assert not call.done() and not agents.read_meta(CORPUS, run.chat).get("permissions"), "no card while it waits"
        assert await asyncio.wait_for(call, 2) == {"behavior": "allow"}
        assert permission_hook.decision({"behavior": "allow"}, permission_hook.DENIED) == \
            {"hookSpecificOutput": {"hookEventName": "PermissionDenied", "retry": True}}
        assert f"toolu_c{n}" in session._not_run
        assert await agent_session.permission_request_route(CORPUS, pre) == {}, "the call made again is auto mode's"
    call = refused(3)
    [p] = await _pending(run.chat)
    assert (p["refused"], p["rechecked"], p["deny_after_s"]) == ("Classifier unavailable", 2, 0.4)
    answer = await asyncio.wait_for(call, 2)
    assert answer["behavior"] == "deny" and permission_hook.decision(answer, permission_hook.DENIED) is None
    assert not agents.read_meta(CORPUS, run.chat).get("permissions")
    assert await agent_session.permission_request_route(CORPUS, pre) == {}, "an unanswered call is not remembered"
    log = [json.loads(line) for line in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert [e["event"] for e in log] == ["rechecked", "rechecked", "asked", "answered"]
    assert log[-1]["answer"] == "deny: nobody answered in time"

    monkeypatch.setattr(agent_session, "CLASSIFIER_WAITS_S", (5.0,))
    call = refused(4, {"command": "python3 other.py"})
    await asyncio.sleep(0.01)
    assert agent_session.set_mode(CORPUS, run.chat, "bypass") == {"mode": "auto", "switching": "bypass"}
    assert await asyncio.wait_for(call, 2) == {"behavior": "deny", "message": tools.hint(agent_session.MODE_SWITCHING)}
    await orient_session.stop(CORPUS)
    await _done()


def test_a_session_in_the_analyst_s_own_auto_mode_gets_the_hook_before_each_call(monkeypatch):
    """A writer or a check's run runs in the analyst's own mode; where that is auto, a call auto mode refused reaches
    its card too, so its process gets the hook before each call."""
    monkeypatch.setattr(agent_session.cc_settings, "permission_mode", lambda cwd: "auto")
    assert agent_session.runs_auto("", Path(".")) and not agent_session.runs_auto("default", Path("."))
    monkeypatch.setattr(agent_session.cc_settings, "permission_mode", lambda cwd: "default")
    assert not agent_session.runs_auto("", Path(".")) and agent_session.runs_auto("auto", Path("."))


async def test_the_hook_s_route_answers_for_the_session_its_shim_names(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    channel.post(CORPUS, "start", {"text": "", "permissions": "bypass"})
    await orient_session.start(CORPUS, "")
    body = agent_session.PermissionRequestBody(session=KEY, tool_name="Bash", tool_input={"command": "ls"}, agent_id="a9")
    assert await agent_session.permission_request_route(CORPUS, body) == {"behavior": "allow",
                                                                         "updatedInput": {"command": "ls"}}
    other = agent_session.PermissionRequestBody(session="writer:report", tool_name="Bash", tool_input={"command": "ls"})
    assert (await agent_session.permission_request_route(CORPUS, other))["behavior"] == "deny", \
        "Bypass grants the orientation's requests, never another session's"
    await orient_session.stop(CORPUS)
    await _done()


# ----------------------------------------------------------------------------- the switch into or out of Auto


async def test_a_switch_into_auto_waits_until_no_call_runs_then_resumes_the_session_in_auto_mode(fake, monkeypatch):
    """The switch waits while a call runs, since a call cut off might have done its work and be made again. Once each
    open call waits on a permission request, the requests are answered with the switch's line, so the model reads why
    the call did not run, a request that comes then is answered so at once, and the session pauses once those calls
    have their results. The call shows as not run on the card, and the resumed session, in auto mode with the hook
    before each call, hears why and carries on."""
    monkeypatch.setenv("FAKE_MODE", "switch")
    run = await orient_session.start(CORPUS, "")
    await _until(lambda: run.main is not None and run.main.path is not None and run.main.path.exists(), "no transcript")
    assert agent_session.set_mode(CORPUS, run.chat, "auto") == {"mode": "manual", "switching": "auto"}
    assert agents.read_meta(CORPUS, run.chat)["mode_switch"] == "auto"
    await asyncio.sleep(0.6)
    assert len(_argvs(fake)) == 1, "the Bash call still runs"
    (fake / "release").write_text("")
    await _until(lambda: "t_ask" in run.main.path.read_text(), "the next call never came")
    await asyncio.sleep(0.6)
    assert len(_argvs(fake)) == 1, "the next call runs too, with no request of its own"
    switching = {"behavior": "deny", "message": tools.hint(agent_session.MODE_SWITCHING)}
    asked = _ask("Bash", {"command": "touch notes.md"})
    assert await asyncio.wait_for(asked, 10) == switching, "answered for the switch rather than cut off"
    assert "t_ask" in session._not_run
    await asyncio.sleep(0.4)
    assert len(_argvs(fake)) == 1 and not run.paused, "the call has no result yet"
    assert await asyncio.wait_for(_ask("Write", {"file_path": "notes.md"}), 1) == switching, "a request before the pause"
    assert not agents.read_meta(CORPUS, run.chat).get("permissions")
    _put(run.main.path, {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t_ask", "is_error": True, "content": switching["message"]}]}})
    await _done()
    first, second = _argvs(fake)
    assert _flag(first) == "default" and _flag(second) == "auto"
    assert second[second.index("--resume") + 1] == run.sid
    hooks = json.loads(second[second.index("--settings") + 1])["hooks"]
    assert "PreToolUse" not in json.loads(first[first.index("--settings") + 1])["hooks"]
    assert hooks["PreToolUse"] == agent_session.permission_hooks(CORPUS, auto=True)["PreToolUse"], "the hook before each call"
    assert (fake / "stdin.txt").read_text() == tools.hint(agent_session.MODE_PROMPT, stopped="")
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["status"] == "done" and meta["permission_mode"] == "auto" and meta.get("mode_switch") is None
    assert orientation.read_run(CORPUS)["permissions"] == "auto"
    records = [json.loads(line) for line in agents.paths(CORPUS, run.chat)[1].read_text().splitlines()]
    assert not any(r.get("type") == "user" and agent_session.MODE_PROMPT in str(r.get("text")) for r in records)
    assert not any("Your session" in str(r.get("text")) for r in records if r.get("type") == "user"), \
        "the resume's prompt is left out of the chat, as a retry's"
    assert not any("interrupted" in str(r.get("text")) for r in records), "and so is Claude Code's note of the pause"
    [result] = [r for r in records if r.get("type") == "tool_result" and r.get("id") == "t_ask"]
    assert result.get("not_run") and not result.get("is_error"), "not run, rather than failed"


async def test_a_subagent_waiting_on_the_analyst_is_a_pause_point_and_the_resumed_session_is_told_to_continue_it(fake,
                                                                                                                 monkeypatch):
    """A switch out of Auto while a foreground subagent's command waits on the card pauses at once: the subagent is
    blocked, and its second command waits behind the first. The step ends stopped, although Claude Code answered the
    cut-off Agent call with a rejection, and the resumed session is told its id, to continue it with SendMessage."""
    monkeypatch.setenv("FAKE_MODE", "switch_agent")
    _listen()
    channel.post(CORPUS, "start", {"text": "", "permissions": "auto"})
    run = await orient_session.start(CORPUS, "")
    await _until(lambda: "atouch" in run.steps, "the subagent never became a step")
    assert agent_session.set_mode(CORPUS, run.chat, "manual") == {"mode": "auto", "switching": "manual"}
    await asyncio.sleep(0.6)
    assert run.paused is False, "its commands run as far as anyone can tell"
    asked = _ask("Bash", {"command": "touch a"}, agent_id="atouch")
    switching = {"behavior": "deny", "message": tools.hint(agent_session.MODE_SWITCHING)}
    assert await asyncio.wait_for(asked, 10) == switching
    assert {"s1", "s2"} <= set(session._not_run), "both calls wait behind the request"
    # the second command asks once the first is answered, and is answered for the switch at once
    assert await asyncio.wait_for(_ask("Bash", {"command": "touch b"}, agent_id="atouch"), 1) == switching
    await asyncio.sleep(0.3)
    assert not run.paused, "its calls have no results yet"
    _put(run.steps["atouch"].path, *({"type": "user", "isSidechain": True, "message": {"content": [
        {"type": "tool_result", "tool_use_id": t, "is_error": True, "content": switching["message"]}]}} for t in ("s1", "s2")))
    await _done()
    first, second = _argvs(fake)
    assert _flag(first) == "auto" and _flag(second) == "default"
    stopped = agent_session.stopped_text([{"agent_id": "atouch", "title": "toucher"}])
    assert (fake / "stdin.txt").read_text() == tools.hint(agent_session.MODE_PROMPT, stopped=f"{stopped} ")
    assert "atouch" in stopped
    assert agents.read_meta(CORPUS, run.steps["atouch"].chat)["status"] == "stopped"


def test_a_session_is_quiet_when_no_call_of_it_or_its_agents_runs_or_each_open_one_waits_on_the_analyst(tmp_path):
    """The pause point of a switch (agent_session.quiet): a foreground Agent call does not count, its subagent's own
    calls do; an agent that waits on a permission request runs none of its calls, since Claude Code makes its other
    calls only after the one that asks."""
    main, sub_path = tmp_path / "main.jsonl", tmp_path / "agent-a1.jsonl"
    run = agent_session.Run(CORPUS, KEY, "or1", "sid", tmp_path, "orient", pid=1)
    run.main = session.Sub(CORPUS, "or1", None, None, role="orient")
    run.main.path = main
    _put(main, _use("t1", "Bash"), _result("t1"))
    assert agent_session.quiet(run), "every call has its result"
    _put(main, _use("t2", "Agent"))
    assert not agent_session.quiet(run), "a subagent that has no step yet"
    sub = session.Sub(CORPUS, "st1", "t2", "a1", role=agent_session.STEP_ROLE)
    sub.path = sub_path
    run.steps["a1"] = sub
    _put(sub_path, _use("r1", "Read"), _result("r1"))
    assert agent_session.quiet(run), "its subagent calls nothing now"
    _put(sub_path, _use("r2", "Bash", {"command": "python3 count.py"}))
    assert not agent_session.quiet(run), "its subagent runs a command"
    run.asking["q1"] = (None, "Bash")
    assert not agent_session.quiet(run), "a request of the session itself is not the subagent's"
    run.asking["q2"] = ("a1", "Bash")
    assert agent_session.quiet(run), "the subagent's command waits on the analyst"
    _put(sub_path, _use("r3", "Bash", {"command": "touch b"}))
    assert agent_session.quiet(run), "its next command, in the same message, waits behind the one that asks"
    run.asking.clear()
    _put(sub_path, _result("r2"), _result("r3"))
    sub.done = True
    _put(main, _result("t2"), _use("t3", "mcp__plugin_thimble_thimble__critique"))
    assert not agent_session.quiet(run), "a critique runs"
    agent_session.forget_calls(run)
    assert agent_session.quiet(run), "a call left open by a process that has ended runs no more"


def test_the_prompt_of_a_resumed_session_names_the_agents_that_stopped_with_the_pause(tmp_path):
    """Each stopped subagent by its id and title, which SendMessage continues, and each workflow by its run, which
    `resumeFromRunId` runs again, once for all its agents."""
    steps = [{"agent_id": "a1", "title": "Read the tickets"},
             {"agent_id": "wa9", "title": "Review: denials", "workflow_dir": str(tmp_path / "wf_1")},
             {"agent_id": "wb9", "title": "Review: refunds", "workflow_dir": str(tmp_path / "wf_1")}]
    assert agent_session.stopped_text(steps) + " " == tools.hint(
        agent_session.MODE_STOPPED, agents='a1 ("Read the tickets"), the workflow run wf_1') + " "
    assert agent_session.stopped_text([]) == ""


def test_claude_code_s_bookkeeping_of_a_pause_is_neither_the_model_s_words_nor_the_analyst_s():
    note = lambda t: {"type": "user", "message": {"content": [{"type": "text", "text": t}]}}  # noqa: E731
    said = lambda model, t: {"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": t}]}}  # noqa: E731
    assert agent_session.bookkeeping(note("[Request interrupted by user]"))
    assert agent_session.bookkeeping(note("[Request interrupted by user for tool use]"))
    assert agent_session.bookkeeping(said("<synthetic>", "No response requested."))
    assert not agent_session.bookkeeping(said("<synthetic>", "API Error: Repeated 529 Overloaded errors."))
    assert not agent_session.bookkeeping(said("claude-opus-5-5", "No response requested."))
    assert not agent_session.bookkeeping(note("Stop interrupting me."))


# ----------------------------------------------------------------------------- the hook


def test_the_permission_hook_turns_the_analyst_s_allow_of_a_refused_call_into_a_retry_and_an_allow_before_it_runs():
    """A call auto mode refused (PermissionDenied) is retried when the analyst allows it, and the call made again is
    allowed before it runs (PreToolUse); a deny leaves the refusal as it is and denies the call made again; no answer
    decides nothing."""
    allow, deny = {"behavior": "allow", "message": agent_session.ALLOWED_LINE}, {"behavior": "deny", "message": "Denied."}
    assert permission_hook.decision(allow, "PermissionDenied") == {"hookSpecificOutput": {"hookEventName": "PermissionDenied",
                                                                                         "retry": True}}
    assert permission_hook.decision(deny, "PermissionDenied") is None
    assert permission_hook.decision(allow, "PreToolUse") == {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": agent_session.ALLOWED_LINE}}
    assert permission_hook.decision(deny, "PreToolUse")["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert permission_hook.decision({}, "PreToolUse") is None and permission_hook.decision({}, "PermissionDenied") is None


def test_the_hook_sends_a_refusal_s_reason_and_call_id_and_asks_briefly_before_a_call(monkeypatch, capsys):
    sent: list[tuple[dict, float]] = []

    def urlopen(req, timeout=None):
        sent.append((json.loads(req.data), timeout))
        return _Resp(json.dumps({"behavior": "allow"}).encode())

    monkeypatch.setattr(permission_hook.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(permission_hook, "server_url", lambda: "http://127.0.0.1:8311")
    monkeypatch.setenv("THIMBLE_SESSION", KEY)
    inp = {"command": "python3 -c 'print(6*7)'"}
    refused = {"hook_event_name": "PermissionDenied", "tool_name": "Bash", "tool_input": inp, "tool_use_id": "toolu_1",
               "reason": "Classifier unavailable", "permission_mode": "auto"}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(refused)))
    permission_hook.main(["--ws", CORPUS])
    assert json.loads(capsys.readouterr().out) == {"hookSpecificOutput": {"hookEventName": "PermissionDenied", "retry": True}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({**refused, "hook_event_name": "PreToolUse", "tool_use_id": "toolu_2"})))
    permission_hook.main(["--ws", CORPUS])
    assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]["permissionDecision"] == "allow"
    (first, t1), (second, t2) = sent
    assert first == {"session": KEY, "event": "PermissionDenied", "tool_name": "Bash", "tool_input": inp, "agent_id": None,
                     "agent_type": None, "tool_use_id": "toolu_1", "reason": "Classifier unavailable"}
    assert t1 == permission_hook.TIMEOUT
    assert second["event"] == "PreToolUse" and "reason" not in second and t2 < permission_hook.PRE_TIMEOUT


# ----------------------------------------------------------------------------- what each session is allowed


async def test_the_orientation_s_fence_adds_no_allow_of_thimble_s_own_while_a_check_s_run_keeps_its_own(fake, monkeypatch):
    """Manual is Claude Code's own asking: the orientation's fence keeps the corpus read-only and Bash in the sandbox,
    off the network, and allows nothing itself, neither sandboxed Bash, nor edits in the work folder, nor the web tools.
    A check's run, which nobody watches, keeps those allows."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    run = await orient_session.start(CORPUS, "")
    await _done()
    argv = json.loads((fake / "argv.json").read_text())
    settings = json.loads(argv[argv.index("--settings") + 1])
    assert settings["sandbox"]["enabled"] and settings["sandbox"]["network"] == {"deniedDomains": ["*"]}
    assert settings["sandbox"]["autoAllowBashIfSandboxed"] is False
    assert "allow" not in settings["permissions"]
    assert settings["permissions"]["deny"] == [f"Edit(/{config.corpus_dir(CORPUS)}/**)"]
    assert set(settings["hooks"]) == {"PermissionRequest", "PermissionDenied", "SubagentStart",
                                      *agent_session.CALL_REF_EVENTS}, \
        "no sandbox hook, and none before each call in Manual; each subagent's scratch folder"
    assert run.sandbox_rule is None
    allowed = argv[argv.index("--allowedTools") + 1:argv.index("--disallowedTools")]
    assert "WebFetch" not in allowed and "WebSearch" not in allowed
    checked = agent_session.fence(Path("/c"), Path("/w"), sandbox=True, unasked=True)
    assert checked["sandbox"]["autoAllowBashIfSandboxed"] is True and checked["permissions"]["allow"] == ["Edit(//w/**)"]


async def test_a_critique_calls_its_thimble_tools_without_a_permission_request(install, fake):
    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE)["id"]
    agent_session._runs[(CORPUS, tools.ORIENT_SESSION)] = agent_session.Run(
        CORPUS, tools.ORIENT_SESSION, chat, "5f0c2a6e-1b7d-4c1e-9a52-6f3d8e2b7c10", Path("/corpus"), orientation.ROLE)
    res = await tools.call(CORPUS, "critique", {"context": "Twelve runs."}, session=tools.ORIENT_SESSION)
    assert not res.is_error, res.text
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--plugin-dir") + 1] == str(install.session)
    assert_own_tools_ask_nothing(argv, install.session)


async def test_a_check_s_run_calls_its_thimble_tools_without_a_permission_request(install, fake):
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    count = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    count["status"], count["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    nb["cells"].append(count)
    notebook.write_notebook(ws, nb)
    text = f"# Deletions\n\nAlice deleted 27 pages [[27|card:{count['id']}]].\n\nBob deleted none.\n"
    wrote = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not wrote.is_error, wrote.text
    checks._active.clear()
    await checks.start_run(CORPUS, "judgment", "report")
    await asyncio.wait_for(checks._active[(CORPUS, "judgment", "report")].task, 20)
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--plugin-dir") + 1] == str(install.session)
    assert_own_tools_ask_nothing(argv, install.session)
