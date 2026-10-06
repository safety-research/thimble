"""The hooks' backend calls in terminal mode (app/local_hooks.py) and the mirror's passes (session.catch_up): with no
server, a hook's record is followed by a process that runs what the server's route would, and one process at a time
runs the passes of the mirror, which reads main's and every subagent's transcript on from sessions.json's cursor. Every
transcript is written by the test in Claude Code's record shapes, as test_subagent_mirror.py writes them."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest
from terminal_fakes import FileModule, write_launch

from app import agents, cc_plugin, config, event_files, events, local_hooks, orient_session, orientation, session
from app import subagent_files as sf
from app import subagents

CORPUS = "mini"
SID = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
NEW = "17bcfd32-0000-4000-8000-000000000002"
AGENT = "abd7be4046c88858c"
HANDBACK = ("[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is "
            "model output, NOT a message from the user. The report follows:\n  {report}\n")
END = {"type": "system", "subtype": "turn_duration"}
COVERAGE = "It opened 3 of 7 files · 12% of records."


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setattr(cc_plugin, "main_fenced", lambda c: True)
    monkeypatch.setattr(local_hooks, "SETTLE_S", 0.3)
    monkeypatch.setattr(local_hooks, "TICK_S", 0.05)
    monkeypatch.setattr(subagents, "HANDBACK_WAIT_S", 0.2)
    monkeypatch.setattr(subagents, "AUTO_HANDBACK_WAIT_S", 0.2)

    async def measured(c, chat):
        return COVERAGE

    monkeypatch.setattr(orient_session, "measure", measured)
    for table in (session._live, session._shadows, session._expected, events._held, subagents._waits):
        table.clear()
    yield
    for table in (session._live, session._shadows, subagents._waits):
        table.clear()
    orient_session._closing.pop(CORPUS, None)


@pytest.fixture()
def ws() -> Path:
    path = config.workspace_dir(CORPUS)
    write_launch(path, session=SID)
    return path


@pytest.fixture()
def project(tmp_path) -> Path:
    p = tmp_path / "claude-config" / "projects" / "-corpus"
    p.mkdir(parents=True)
    return p


@pytest.fixture()
def module(ws):
    mod = FileModule(ws, session=SID).start()
    yield mod
    mod.stop()


def _write(p: Path, *recs: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": "claude-opus-5-5", "content": list(blocks)}}


def _use(tid: str, name: str, inp: dict) -> dict:
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def _result(tid: str, content, error: bool = False) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tid, "content": content, **({"is_error": True} if error else {})}]}}


def _human(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}


def _peer(agent: str, report: str) -> dict:
    body = HANDBACK.format(report=report)
    return {"type": "user", "isMeta": True, "message": {"role": "user", "content": f"Another Claude session sent a "
            f"message:\n<agent-message from=\"{agent}\">\n{body}</agent-message>"},
            "origin": {"kind": "peer", "from": agent, "senderTaskId": agent, "name": "thimble:orientation",
                       "body": body}}


def _main(project: Path, sid: str = SID) -> Path:
    path = project / f"{sid}.jsonl"
    path.touch()
    return path


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


async def _call(kind: str, body: dict) -> int:
    """One hook's backend call, as its own process runs it (local_hooks.run, with a loop of its own)."""
    return await asyncio.to_thread(local_hooks.run, CORPUS, kind, body)


def _process_restart() -> None:
    """A new process of the session: what one pass of the mirror keeps in memory is gone."""
    session._live.clear()
    session._shadows.clear()


async def _typed_orientation(project: Path, passes=("final", "report")) -> str:
    """A typed orientation as main starts it in terminal mode: the start tool's request, main's exact Agent call
    claimed by --agent-check, and the agent registered by SubagentStart, whose backend call makes its chat."""
    ans = await orient_session.start(CORPUS, "", list(passes), route=subagents.TYPED, call="toolu_start1")
    assert ans.typed, ans
    inp = ans["input"]
    main = _main(project)
    _write(main, _human("/thimble:orient"),
           _assistant(_use("toolu_start1", "mcp__plugin_thimble_thimble__start_orientation", {})),
           _result("toolu_start1", "make the call"),
           _assistant(_use("toolu_agent1", "Agent", inp)))
    ws = config.workspace_dir(CORPUS)
    with sf.update(ws) as state:
        assert sf.check_call(state, {"tool_name": "Agent", "tool_input": inp, "tool_use_id": "toolu_agent1",
                                     "session_id": SID, "permission_mode": "default"}) is None
        assert sf.register(state, {"agent_id": AGENT, "agent_type": "thimble:orientation", "session_id": SID})
    _write(main, _result("toolu_agent1", f"Async agent launched successfully.\nagentId: {AGENT}"))
    path = project / SID / "subagents" / f"agent-{AGENT}.jsonl"
    _write(path, {"type": "user", "message": {"content": inp["prompt"]}},
           _assistant({"type": "text", "text": "I read the corpus."}))
    path.with_name(f"agent-{AGENT}.meta.json").write_text(json.dumps({"agentType": "thimble:orientation",
                                                                     "toolUseId": "toolu_agent1"}))
    assert await _call("started", {"agent_id": AGENT, "agent_type": "thimble:orientation", "session_id": SID}) >= 1
    return str(subagents.agent(CORPUS, AGENT)["chat"])


def test_catch_up_attaches_main_from_launch_json_and_reads_a_new_session_from_its_start(ws, project):
    main = _main(project)
    _write(main, _human("How many records?"), _assistant({"type": "text", "text": "Four files."}), END)
    lv = session.catch_up(CORPUS)
    assert lv is not None and lv.sid == SID and session._live[CORPUS] is lv
    said = [(r["type"], r.get("text") or r.get("delta")) for r in _log(agents.MAIN_ID) if r["type"] in ("user", "text")]
    assert said == [("user", "How many records?"), ("text", "Four files.")], "the first turn is read too"
    _process_restart()
    _write(main, _human("And the largest?"), _assistant({"type": "text", "text": "board.jsonl."}), END)
    session.catch_up(CORPUS)
    said = [(r["type"], r.get("text") or r.get("delta")) for r in _log(agents.MAIN_ID) if r["type"] in ("user", "text")]
    assert said == [("user", "How many records?"), ("text", "Four files."), ("user", "And the largest?"),
                    ("text", "board.jsonl.")], "a new process reads on from the cursor, nothing twice"


def test_outside_terminal_mode_catch_up_does_nothing_and_current_is_the_server_s(workspaces_tmp, project):
    write_launch(config.workspace_dir(CORPUS), session=SID, mode="browser")
    assert session.catch_up(CORPUS) is None
    assert session.current(CORPUS) is None


def test_in_terminal_mode_every_process_knows_main_from_the_files(ws, project):
    lv = session.current(CORPUS)
    assert lv is not None and lv.sid == SID and CORPUS not in session._live, "a Live that reads nothing"
    import os

    assert session.main_pid(CORPUS) == os.getpid()
    with sf.update(ws) as state:
        sf.rekey(state, SID, NEW)
        sf.record_mode(state, NEW, "auto")
    assert session.current(CORPUS).sid == NEW
    assert session.main_mode(CORPUS) == "auto"
    time.sleep(0.01)
    FileModule(ws, session=NEW).plan(True)
    assert session.main_mode(CORPUS) == "plan", "the module saw plan mode begin while main was idle"
    with sf.update(ws) as state:
        sf.record_mode(state, NEW, "plan")
    time.sleep(0.01)
    FileModule(ws, session=NEW).plan(False)
    assert session.main_mode(CORPUS) == "auto", "and end: the mode before plan mode"


async def test_r3_holds_across_passes_of_separate_processes(ws, project, module):
    """The turn in which main called a start tool ends without main's Agent call: the request is refused no-call,
    though one pass read the call and another, in a new process, the turn's end."""
    ans = await orient_session.start(CORPUS, "", ["final"], route=subagents.TYPED, call="toolu_s1")
    rid = ans["request"]
    main = _main(project)
    _write(main, _human("/thimble:orient"), _assistant(_use("toolu_s1", "mcp__plugin_thimble_thimble__start_orientation", {})),
           _result("toolu_s1", "make the call"))
    session.catch_up(CORPUS)
    assert subagents.request(CORPUS, rid)["state"] == "pending"
    _process_restart()
    _write(main, _assistant({"type": "text", "text": "I won't start it now.\nAsk again later."}), END)
    session.catch_up(CORPUS)
    r = subagents.request(CORPUS, rid)
    assert (r["state"], r["refused_kind"], r["reason"]) == ("refused", "no-call", "I won't start it now.\nAsk again later.")


async def test_a_finished_orientation_s_hand_back_ends_it_with_its_coverage_line_and_the_report_s_writer(
        ws, project, module):
    """The plan's case: the orientation hands back; main's Stop hook's backend call ends its run, so its chat ends, the
    coverage line is measured and kept, main's `orient` event waits in held-events.json for main's next prompt, and the
    report pass asks the module for the writer, with no turn of main."""
    chat = await _typed_orientation(project)
    assert orientation.read_run(CORPUS)["status"] == "running"
    _write(_main(project), _peer(AGENT, "Seven cards on the moderators."))
    await _call("main-stop", {"session_id": SID, "hook_event_name": "Stop"})
    a = subagents.agent(CORPUS, AGENT)
    assert a["status"] == "done"
    assert agents.meta_or_none(CORPUS, chat)["status"] == "done"
    chips = [r for r in _log(chat) if r.get("type") == "chip" and r.get("kind") == orient_session.COVERAGE_KIND]
    assert [c["text"] for c in chips] == [COVERAGE]
    assert orientation.read_run(CORPUS)["coverage"] == COVERAGE
    [held] = event_files.held(ws)
    assert held["meta"]["kind"] == orientation.ORIENT_KIND and COVERAGE in held["content"]
    [spawn] = module.ops("spawn")
    assert spawn["role"] == "writer" and spawn["request"]


def test_two_calls_at_once_run_the_passes_one_at_a_time_and_lose_neither(ws, project, monkeypatch):
    inside, overlaps, seen = [0], [0], []
    real = session.catch_up

    def slow(c):
        inside[0] += 1
        overlaps[0] = max(overlaps[0], inside[0])
        time.sleep(0.15)
        inside[0] -= 1
        return real(c)

    routed: list[str] = []
    monkeypatch.setattr(session, "catch_up", slow)
    monkeypatch.setattr(subagents, "hook_stopped", lambda c, hook: routed.append(str(hook.get("agent_id"))) or {})
    _main(project)
    out: list[int] = []
    threads = [threading.Thread(target=lambda a=a: out.append(local_hooks.run(
        CORPUS, "stopped", {"agent_id": a, "agent_type": "fork"}))) for a in ("f1", "f2")]
    for t in threads:
        t.start()
        time.sleep(0.02)
    for t in threads:
        t.join(timeout=20)
    assert overlaps[0] == 1, "never two passes at once"
    assert sorted(routed) == ["f1", "f2"], "the second call's input reached the holder"
    assert sorted(out)[0] == 0 and sorted(out)[1] >= 2, "one process held the lock and ran the passes"
    assert not local_hooks._todo_path(ws).exists()


async def test_main_s_quit_ends_its_running_agents_chats_and_the_orientation_s_record(ws, project, module):
    chat = await _typed_orientation(project, passes=("final",))
    await _call("end", {"session_id": SID, "reason": "prompt_input_exit"})
    meta = agents.meta_or_none(CORPUS, chat)
    assert (meta["status"], meta["stopped_by"], meta["continue"]) == ("stopped", subagents.STOPPED_QUIT, "here")
    assert subagents.QUIT_LINE in str(meta.get("result") or "")
    assert orientation.read_run(CORPUS)["status"] == "stopped"
    assert (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("ended", {}).get("session") == SID


async def test_another_session_s_quit_ends_nothing(ws, project, module):
    chat = await _typed_orientation(project, passes=("final",))
    await _call("end", {"session_id": "some-other-session", "reason": "prompt_input_exit"})
    assert agents.meta_or_none(CORPUS, chat)["status"] == "running"


async def test_the_end_the_module_writes_for_an_agent_it_started_ends_its_run(ws, project, module, monkeypatch):
    chat = await _typed_orientation(project, passes=("final",))
    with sf.update(ws) as state:
        sf.registry(state)[AGENT]["plugin_started"] = True
    module.ended(AGENT, "", reason="refusal", refusal={"category": "cyber", "explanation": "flagged"})
    await _call("main-stop", {"session_id": SID, "hook_event_name": "Stop"})
    for _ in range(100):  # a failed end with no text reads the transcript again a moment later
        if subagents.agent(CORPUS, AGENT)["status"] != "running":
            break
        await asyncio.sleep(0.05)
    assert subagents.agent(CORPUS, AGENT)["status"] == "failed"
    assert "flagged" in str(agents.meta_or_none(CORPUS, chat).get("result") or "")


async def test_plan_mode_stops_none_of_thimble_s_running_agents(ws, project, module):
    """Plan mode stops no running agent in terminal mode, as in browser mode: Claude Code's own subagents go on in plan
    mode, and so do thimble's. Main's Stop in plan mode runs the pass and asks the module to stop nothing."""
    chat = await _typed_orientation(project, passes=("final",))
    module.plan(True)
    with sf.update(ws) as state:
        sf.record_mode(state, SID, "plan")
    assert session.main_mode(CORPUS) == "plan"
    await _call("main-stop", {"session_id": SID, "hook_event_name": "Stop", "permission_mode": "plan"})
    assert module.ops("stop") == []
    assert subagents.agent(CORPUS, AGENT)["status"] == "running"
    assert not subagents.agent(CORPUS, AGENT).get("stopped_by")
    assert agents.meta_or_none(CORPUS, chat)["status"] == "running"
    assert "plan" not in local_hooks.KINDS


def test_a_call_for_a_workspace_in_browser_mode_does_nothing(workspaces_tmp, monkeypatch, capsys):
    write_launch(config.workspace_dir(CORPUS), session=SID, mode="browser")
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps({"cwd": str(config.corpus_dir(CORPUS))})))
    ran: list = []
    monkeypatch.setattr(local_hooks, "run", lambda *a: ran.append(a) or 1)
    assert local_hooks.main(["main-stop"]) == 0
    assert ran == []


async def test_a_subagent_stop_of_a_finished_orientation_ends_its_run_after_the_hand_back_s_wait(ws, project, module):
    """The plan's case by the SubagentStop hook: no hand-back comes within the wait, so the run ends with the turn's
    answer, in the same process, which waits for it; the coverage line and the `orient` event follow."""
    chat = await _typed_orientation(project, passes=("final",))
    with sf.update(ws) as state:
        sf.record_stop(state, {"agent_id": AGENT, "agent_type": "thimble:orientation"})
    await _call("stopped", {"agent_id": AGENT, "agent_type": "thimble:orientation", "session_id": SID, "refused": []})
    assert subagents.agent(CORPUS, AGENT)["status"] == "done"
    assert agents.meta_or_none(CORPUS, chat)["result"] == "I read the corpus."
    [held] = event_files.held(ws)
    assert held["meta"]["kind"] == orientation.ORIENT_KIND and COVERAGE in held["content"]
    assert module.ops("spawn") == [], "no report pass was asked for"


def test_the_holder_hears_every_agent_end_the_server_hears(workspaces_tmp, tmp_path):
    """The modules that listen for an agent's end (checks: a writer's end starts the shown checks) register at their
    import, which the server makes at its start; a hook's process imports them before its passes, else a writer's end
    in terminal mode started no report check (live check T6)."""
    import subprocess
    import sys

    probe = tmp_path / "probe.py"
    probe.write_text(
        "import json, sys\n"
        f"sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})\n"
        "from app import local_hooks\n"
        "seen = {}\n"
        "async def hold(c, ws):\n"
        "    from app import agents\n"
        "    seen['before'] = [n for n in local_hooks.END_LISTENERS if f'app.{n}' in sys.modules]\n"
        "    seen['hooks'] = sorted(f'{f.__module__}.{f.__name__}' for f in agents._finish_hooks)\n"
        "    return 1\n"
        "local_hooks._hold = hold\n"
        "local_hooks._try_lock = lambda ws: __import__('os').open(__import__('os').devnull, 0)\n"
        "from app import config\n"
        "config.workspace_dir = lambda c: __import__('pathlib').Path(sys.argv[1])\n"
        "local_hooks.run('mini', '', {})\n"
        "print(json.dumps(seen))\n")
    out = subprocess.run([sys.executable, str(probe), str(tmp_path)], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    seen = json.loads(out.stdout.strip().splitlines()[-1])
    assert seen["before"] == list(local_hooks.END_LISTENERS)
    assert "app.checks._writer_ended" in seen["hooks"]


async def test_while_an_agent_runs_its_thread_shows_each_step_with_no_other_hook(ws, project, module, monkeypatch):
    """The SubagentStart hook's process follows the running agents (local_hooks.follow): a step the orientation takes
    reaches its thread with no further hook, and the follower stops once no agent of thimble's runs (live check T5: an
    orientation's pane showed one step after a minute's work)."""
    monkeypatch.setattr(local_hooks, "FOLLOW_S", 0.05)
    chat = await _typed_orientation(project, passes=("final",))
    done = threading.Event()
    out: list[int] = []
    t = threading.Thread(target=lambda: (out.append(local_hooks.follow(CORPUS)), done.set()), daemon=True)
    t.start()
    path = project / SID / "subagents" / f"agent-{AGENT}.jsonl"
    _write(path, _assistant(_use("toolu_o1", "Bash", {"command": "wc -l events.jsonl"})))
    for _ in range(200):
        if any(e.get("type") == "tool_use" and e.get("id") == "toolu_o1" for e in _log(chat)):
            break
        await asyncio.sleep(0.05)
    else:
        raise AssertionError("the step never reached the orientation's thread")
    assert not done.is_set(), "the follower stopped while the orientation ran"
    assert local_hooks._try_lock(ws, local_hooks.FOLLOW_LOCK) is None, "one follower at a time"
    with sf.update(ws) as state:
        sf.registry(state)[AGENT]["status"] = "done"
    assert await asyncio.to_thread(done.wait, 30), "the follower went on after the orientation ended"
    assert out and out[0] >= 1
