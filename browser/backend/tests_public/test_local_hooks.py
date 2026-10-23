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

from app import agents, config, event_files, events, local_hooks, session
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
    monkeypatch.setattr(local_hooks, "SETTLE_S", 0.3)
    monkeypatch.setattr(local_hooks, "TICK_S", 0.05)
    monkeypatch.setattr(subagents, "HANDBACK_WAIT_S", 0.2)
    monkeypatch.setattr(subagents, "AUTO_HANDBACK_WAIT_S", 0.2)

    for table in (session._live, session._shadows, session._expected, events._held, subagents._waits):
        table.clear()
    yield
    for table in (session._live, session._shadows, subagents._waits):
        table.clear()


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


async def _typed_orientation(project: Path) -> str:
    """A typed orientation as main starts it in terminal mode: the start tool's request, main's exact Agent call
    claimed by --agent-check, and the agent registered by SubagentStart, whose backend call makes its chat."""
    ans = await orient_session.start(CORPUS, "", route=subagents.TYPED, call="toolu_start1")
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


def test_a_call_for_a_workspace_in_browser_mode_does_nothing(workspaces_tmp, monkeypatch, capsys):
    write_launch(config.workspace_dir(CORPUS), session=SID, mode="browser")
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps({"cwd": str(config.corpus_dir(CORPUS))})))
    ran: list = []
    monkeypatch.setattr(local_hooks, "run", lambda *a: ran.append(a) or 1)
    assert local_hooks.main(["main-stop"]) == 0
    assert ran == []


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
    listening = {h.rsplit(".", 1)[0] for h in seen["hooks"]}
    assert all(f"app.{n}" in listening for n in local_hooks.END_LISTENERS), "each module named registers a handler"


async def test_the_analyst_s_answers_to_a_view_proposal_reach_the_views_through_the_holder(ws, project, monkeypatch):
    """`thimble act view-accept|view-reject|view-retry` hand their call to the holder (local.py), which makes it: the
    accept (views.accept, whose build it then follows), the reject (views.answer_offer) and the retry (views.retry). A
    press the view no longer takes (a second press: 409) is one line in the log, and the passes go on."""
    from fastapi import HTTPException

    from app import dev, views

    made: list[tuple] = []
    views._save_proposals(CORPUS, [{"slug": "edit-bursts", "name": "Edit Bursts", "description": "d", "task": "t",
                                    "claims": ["board.jsonl"], "status": "suggested", "proposed_by": "proposer",
                                    "offered": {"at": "2026-10-14T10:00:00Z", "after": "main"}}])
    monkeypatch.setattr(views, "click_refused", lambda c, slug: None)
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: made.append(("accept", c, slug)))
    monkeypatch.setattr(views, "answer_offer", lambda c, slug, answer, **kw: made.append((answer, c, slug)) or {})

    def retry(c, slug):
        made.append(("retry", c, slug))
        raise HTTPException(409, "the view 'Edit Bursts' is building, not failed")

    monkeypatch.setattr(views, "retry", retry)
    _main(project)
    for kind in ("view-accept", "view-reject", "view-retry"):
        assert await _call(kind, {"cwd": str(config.corpus_dir(CORPUS)), "slug": "edit-bursts"}) >= 1
    assert made == [("accept", CORPUS, "edit-bursts"), ("rejected", CORPUS, "edit-bursts"),
                    ("retry", CORPUS, "edit-bursts")]
    row = views.read_proposal(CORPUS, "edit-bursts")
    assert (row["status"], row["asked"], row["accepted"]) == ("queued", True, True), "accepted: queued as asked for"


async def test_a_notice_s_try_again_checks_for_a_view_proposal_and_the_holder_waits_for_the_check(ws, project,
                                                                                                    monkeypatch):
    """`view-propose-now` (a notice's Try again) runs proposer.run_now in the holder; a check that runs on its loop keeps
    it busy until it ends, so what the check writes is written before the process exits."""
    from app import proposer

    done: list[str] = []

    async def check(c):
        await asyncio.sleep(0.4)
        done.append(c)

    # proposer.run_now starts its run as a task of the running loop and answers at once
    def run_now(c):
        asyncio.get_running_loop().create_task(check(c))
        return {"started": True}

    monkeypatch.setattr(proposer, "run_now", run_now)
    _main(project)
    assert await _call("view-propose-now", {"cwd": str(config.corpus_dir(CORPUS))}) >= 1
    assert done == [CORPUS], "the holder waited for the run's task"
    assert "view-propose-now" in local_hooks.KINDS and "view-retry" in local_hooks.KINDS


async def test_a_notice_dismissed_in_the_terminal_is_dismissed_by_the_holder(ws, project, monkeypatch):
    """`thimble act notice-dismiss {id}` hands the dismissal to the holder, which calls notices.dismiss; a notice that is
    gone is one line in the log."""
    from app import notices

    calls: list[tuple] = []
    monkeypatch.setattr(notices, "dismiss", lambda c, notice_id: calls.append((c, notice_id)) or notice_id != "gone")
    _main(project)
    cwd = str(config.corpus_dir(CORPUS))
    for notice_id in ("n3", "gone"):
        assert await _call("notice-dismiss", {"cwd": cwd, "id": notice_id}) >= 1
    assert calls == [(CORPUS, "n3"), (CORPUS, "gone")]
    assert "notice-dismiss" in local_hooks.KINDS
    # a notice's Retry: the notice it was pressed on is dismissed before the view is built again
    from app import views

    monkeypatch.setattr(views, "retry", lambda c, slug: calls.append(("retry", c, slug)))
    del calls[:]
    assert await _call("view-retry", {"cwd": cwd, "slug": "edit-bursts", "notice": "n4"}) >= 1
    assert calls == [(CORPUS, "n4"), ("retry", CORPUS, "edit-bursts")]


