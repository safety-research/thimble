"""The Claude Code sessions thimble starts beside main (agent_session.py, orient_session.py) and their permissions:
every session asks through the PermissionRequest hook and no prompt tool, and the hook hands each request to the server
and prints its decision. Manual waits for the analyst, while a writer's request is denied after a minute; Bypass grants,
and a card's switch holds for its session's later runs. Main's end parks the orientation for the next main session.

A stand-in for the CLI (FAKE, run as agent_session.CLAUDE_BIN) records its argv, its environment and what it read on
stdin, and writes what Claude Code writes for such a session: the transcript under the config dir's projects/, a
subagent's transcript with its meta json, a workflow's run directory with its journal.jsonl and agent transcript, and
stream-json on stdout whose last `result` is the summary."""
from __future__ import annotations

import asyncio
import io
import json
import sys
import urllib.request
from pathlib import Path

import pytest
from conftest import Listener, card_wait
from fastapi import HTTPException

from app import (agent_session, agents, config, events, hook_auth, ledger, modes, orient_session, permission_hook,
                 session, tools, userconf)

CORPUS = "mini"
KEY = orient_session.KEY

SUMMARY = "The corpus is one file, runs.jsonl, with 12 runs [[card:aaaa1111]]."

FAKE = r'''
import json, os, sys, time
from pathlib import Path
argv = sys.argv[1:]
out = Path(os.environ["FAKE_DIR"])
(out / "argv.json").write_text(json.dumps(argv))
(out / "process_env.json").write_text(json.dumps(dict(os.environ)))
if "--settings" in argv:  # as Claude Code does: the settings' env over the process's
    os.environ.update(json.loads(argv[len(argv) - 1 - argv[::-1].index("--settings") + 1]).get("env") or {})
(out / "env.json").write_text(json.dumps({k: os.environ.get(k) for k in ("THIMBLE_SESSION", "THIMBLE_LAUNCHED", "XDG_CACHE_HOME", "MPLCONFIGDIR",
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
    events._subs.clear()
    agent_session._runs.clear()
    yield
    events._subs.clear()
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
    monkeypatch.setenv("THIMBLE_LAUNCHED", "1")  # the server's own, inherited from main's session
    monkeypatch.delenv("FAKE_MODE", raising=False)
    monkeypatch.delenv("FAKE_SLEEP", raising=False)
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")  # the fence without the sandbox, which the config then does not require
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    return out


def _listen() -> Listener:
    return Listener(CORPUS)


async def _done(key: str = orient_session.KEY) -> None:
    run = agent_session._runs.get((CORPUS, key))
    if run is not None and run.task is not None:
        await asyncio.wait_for(run.task, 10)


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
    assert "permission_hook.py" in hook["command"] and f"--ws {CORPUS} --session {KEY} " in hook["command"]
    settings = json.loads(argv[argv.index("--settings") + 1])
    assert settings["hooks"]["PermissionDenied"] == hooks and "PreToolUse" not in settings["hooks"]
    assert settings["enabledPlugins"] == {f"thimble-cc-mod@{config.marketplace_name()}": False}, "never the mod"
    assert run.mode == "manual" and _flag(argv) == "default", "no row and no mode main reported: Manual"
    assert "ask_permission" not in tools.REGISTRY


async def test_manual_waits_for_the_analyst_and_every_agent_s_card_waits_the_one_card_wait(fake, monkeypatch, analyst):
    """Manual is Claude Code's manual mode: each request it makes waits on the orientation's card, with the agent that
    asked, until the analyst answers or the card's wait passes, ten minutes with no `cardWait` in thimble's config. A
    writer's card waits the same time, not a minute of its own, and once `cardWait` is set, its unanswered request is
    declined after that wait and stays on the card saying so."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "")
    assert agents.read_meta(CORPUS, run.chat)["permission_mode"] == "manual"
    inp = {"command": "touch notes.md", "description": "Create notes.md"}
    call = _ask("Bash", inp, agent_id="a1")
    [p] = await _pending(run.chat)
    assert (p["tool"], p["what"], p["agent_id"]) == ("Bash", "Create notes.md", "a1") and "touch notes.md" in p["input"]
    await asyncio.sleep(0.3)
    assert not call.done() and p["wait_s"] == 600, "the default card wait, ten minutes"
    assert (await agent_session.permission_route(CORPUS, run.chat, agent_session.PermissionAnswer(id=p["id"], allow=True), analyst))["allow"]
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
        call = asyncio.ensure_future(agent_session.ask(CORPUS, run.key, "Bash", inp))
        [p] = await _pending(run.chat)
        assert not call.done() and p["wait_s"] == 600, "a writer's card waits the card wait too, not a minute"
        agent_session.answer(CORPUS, run.chat, p["id"], True)
        assert (await call)["behavior"] == "allow"
        assert card_wait(0.001) == 0.06
        assert await agent_session.ask(CORPUS, run.key, "Bash", inp) == {
            "behavior": "deny", "message": agent_session.timed_out_line(0.06)}
        assert "within 0.06 seconds" in agent_session.timed_out_line(0.06)
        last = json.loads((config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()[-1])
        assert last["answer"] == "deny: nobody answered in time" and last["chat"] == run.chat
        [expired] = agents.read_meta(CORPUS, run.chat)["permissions"]
        assert expired["expired"] and expired["tool"] == "Bash", "it stays on the card, marked denied unanswered"
        assert expired["wait_s"] == 0.06, "the card says how long it waited"
        assert agent_session.answer(CORPUS, run.chat, expired["id"], False), "Dismiss takes it off"
        assert agents.read_meta(CORPUS, run.chat)["permissions"] == []
    finally:
        agent_session._runs.pop((CORPUS, run.key), None)


async def test_bypass_grants_every_request_and_switches_with_manual_while_the_session_runs(fake, monkeypatch, analyst):
    """Bypass never asks and runs in Claude Code's manual mode, so the card switches it with Manual on the same
    process: a switch to Bypass grants what waits, and after a switch back the next request waits again. The session's
    later runs keep the switch, and its row is left alone."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    ledger.put_settings(CORPUS, {modes.SETTING: {"orient": "bypass"}})
    run = await orient_session.start(CORPUS, "")
    pid = run.pid
    assert run.mode == "bypass" and _flag(run.argv) == "default"
    assert agents.read_meta(CORPUS, run.chat)["permission_mode"] == "bypass"
    assert await agent_session.ask(CORPUS, KEY, "Bash", {"command": "rm -r out"}) == {"behavior": "allow",
                                                                                   "updatedInput": {"command": "rm -r out"}}
    assert not agents.read_meta(CORPUS, run.chat).get("permissions"), "nothing reached the card"
    assert agent_session.set_mode(CORPUS, run.chat, "manual") == {"mode": "manual", "switching": None}
    call = _ask("Bash", {"command": "rm -r out"})
    await _pending(run.chat)
    assert agent_session.set_mode(CORPUS, run.chat, "bypass") == {"mode": "bypass", "switching": None}
    assert (await call)["behavior"] == "allow", "what waited is granted"
    assert run.pid == pid and _flag(run.argv) == "default", "the same process"
    agent_session.set_mode(CORPUS, run.chat, "manual")
    with pytest.raises(HTTPException) as e:
        await agent_session.mode_route(CORPUS, run.chat, agent_session.ModeBody(mode="yolo"), analyst)
    assert e.value.status_code == 400
    await orient_session.stop(CORPUS)
    await _done()
    with pytest.raises(HTTPException) as e:
        await agent_session.mode_route(CORPUS, run.chat, agent_session.ModeBody(mode="manual"), analyst)
    assert e.value.status_code == 404
    again = await orient_session.message(CORPUS, "one more look", orient_session.BROWSER)
    assert again["status"] == "resumed" and agent_session.current(CORPUS, KEY).mode == "manual", "its follow-up keeps the switch"
    assert ledger.get_settings(CORPUS)[modes.SETTING] == {"orient": "bypass"}
    await orient_session.stop(CORPUS)
    await _done()


async def test_a_switch_to_bypass_leaves_the_config_s_asks_waiting_for_the_analyst(fake, monkeypatch):
    """A switch to Bypass grants what waits on the card, but not an install command thimble's config sent there: that
    one waits for the analyst's own answer."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    run = await orient_session.start(CORPUS, "")
    assert run.mode == "manual" and run.config is not None
    install = {"command": "bash -c 'pip install requests'"}
    assert run.config.verdict("Bash", install) == "ask"
    held = _ask("Bash", install)
    plain = _ask("Bash", {"command": "rm -r out"})
    pending = await _pending(run.chat, 2)
    agent_session.set_mode(CORPUS, run.chat, "bypass")
    assert (await plain)["behavior"] == "allow"
    await asyncio.sleep(0.1)
    assert not held.done(), "the install still waits"
    rid = next(p["id"] for p in pending if "pip install" in p.get("command", ""))
    assert [p.get("asked_by") for p in pending if p["id"] == rid] == ["installs"]
    assert all(not p.get("asked_by") for p in pending if p["id"] != rid), "a call the mode asks about names no config"
    assert agent_session.answer(CORPUS, run.chat, rid, False)
    assert (await held)["behavior"] == "deny"
    await orient_session.stop(CORPUS)
    await _done()


async def test_main_s_end_parks_the_orientation_and_the_next_main_session_resumes_it(fake, monkeypatch):
    """Main's end (agent_session.wind_down) ends the orientation's process as the server's stop does: its chat stays
    running, marked parked, and no Stop reaches its record. The next session that is main resumes it in the same chat
    with `## session-restarted`."""
    from app import orientation, procs

    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "")
    pid = run.pid
    for _ in range(100):  # the session has begun its transcript
        if session.find_transcript(run.sid):
            break
        await asyncio.sleep(0.05)
    assert len(await agent_session.wind_down(CORPUS)) == 1
    assert not procs.alive(pid) and agent_session.current(CORPUS, KEY) is None
    meta = agents.read_meta(CORPUS, run.chat)
    assert (meta["status"], meta["parked"], meta["pid"]) == ("running", True, None)
    assert orientation.read_run(CORPUS)["status"] == "running"
    monkeypatch.delenv("FAKE_MODE")
    agent_session.resume_parked(CORPUS)
    for _ in range(100):
        if agent_session.current(CORPUS, KEY) is not None:
            break
        await asyncio.sleep(0.05)
    await _done()
    assert tools.hint(agent_session.RESTARTED_PROMPT, stopped="")[:40] in (fake / "stdin.txt").read_text()
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["status"] == "done" and not meta.get("parked")


async def test_a_start_renders_its_prompts_off_the_loop_and_the_session_gets_them_as_rendered(fake, monkeypatch):
    """The orientation's prompt, the skill prompts a fenced session reads and the shared prompt a writer's command line
    appends each read the corpus for their citation forms, so a start renders them in a worker thread and the server
    answers other requests meanwhile. The session gets the text the same functions render on the loop."""
    import threading

    from app import views, write_session

    loop_thread = threading.current_thread()
    on_loop: list[bool] = []
    real = views.forms_text

    def forms_text(c):
        on_loop.append(threading.current_thread() is loop_thread)
        return real(c)

    monkeypatch.setattr(views, "forms_text", forms_text)
    cwd = config.corpus_dir(CORPUS)

    await orient_session.start(CORPUS, "")
    await _done()
    assert on_loop and not any(on_loop), "the orientation's prompt and the skill prompts, each in a worker thread"
    argv = json.loads((fake / "argv.json").read_text())
    defined = json.loads(argv[argv.index("--agents") + 1])[argv[argv.index("--agent") + 1]]
    parts = orient_session.parts_of({}, ("final", "views"))
    assert defined["prompt"] == orient_session.system_prompt(CORPUS, "", parts)
    rendered = Path(json.loads((fake / "env.json").read_text())["THIMBLE_RENDERED_PROMPTS"])
    for name in agent_session.SKILL_PROMPTS:
        assert (rendered / f"{name}.md").read_text("utf-8") == events.render_prompts([name], str(cwd)) + "\n"

    on_loop.clear()
    await write_session.start(CORPUS, "report")
    await _done(write_session.session_key("report"))
    assert on_loop and not any(on_loop), "a writer's skill prompts and its shared prompt, each in a worker thread"
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--append-system-prompt") + 1] == agent_session.shared_prompt(cwd)


RULE = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test *"}], "behavior": "allow",
        "destination": "localSettings"}


def test_the_permission_hook_hands_the_request_to_the_server_and_prints_its_decision(monkeypatch, capsys, tmp_path):
    """The hook signs its request with the token in server.json and believes only an answer that proves the server holds
    it too (app/hook_auth.py)."""
    sent: list[tuple[str, dict]] = []
    (tmp_path / "server.json").write_text(json.dumps({"port": 8311, "token": "tok"}))
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path))
    proof = {"ok": True}

    class Resp(io.BytesIO):
        def __init__(self, data: bytes, nonce: str) -> None:
            super().__init__(data)
            self.headers = {"X-Thimble-Proof": hook_auth.sign("tok", "server", nonce) if proof["ok"] else "forged"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    answer = {"behavior": "deny", "message": "Denied from thimble's browser."}

    def urlopen(req, timeout=None):
        nonce = req.get_header("X-thimble-nonce")
        assert req.get_header("X-thimble-auth") == hook_auth.sign("tok", "hook", nonce)
        sent.append((req.full_url, json.loads(req.data)))
        assert timeout == permission_hook.TIMEOUT
        return Resp(json.dumps(answer).encode(), nonce)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
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
    proof["ok"] = False
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "an answer without the proof"
    proof["ok"] = True
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

    (tmp_path / "server.json").unlink()
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "no server: no decision"
    monkeypatch.delenv("THIMBLE_SESSION")
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "not a session thimble started"
