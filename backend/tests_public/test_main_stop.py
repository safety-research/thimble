"""Stop for main and its side threads in the browser (agents.interrupt_route). Main's Stop ends main's running turn
through thimble's hooks module (subagents.stop_main, the module's `abort`: `$.turn.abort`), as Esc ends it in the
terminal, and the mirror ends the turn with its note (session.turn_stopped), since the abort leaves no record in the
transcript; without the module the browser says to press Esc. A side thread's Stop stops the fork that answers it, as
an agent's Stop does. Both are clicks, which take the analyst's cookie. Every transcript here is written by the test in
Claude Code's record shapes.

Main is told of each Stop that stopped something (live check L4-12: a stopped turn's work, and a stopped thread's,
were taken up again by main's next turn): a line appended to main through the module (`note`), main-stopped-note or
thread-stopped-note, which no chat shows as the analyst's."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import agents, config, events, session
from subagent_fakes import bridge  # noqa: F401 — fixture

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-000000000042"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    for table in (events._subs, events._pending, events._taken):
        table.clear()
    agents._busy.clear()
    yield
    session._live.clear()
    agents._busy.clear()


def _human(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}


def _say(text: str) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": "claude-sonnet-5", "content": [{"type": "text", "text": text}]}}


def _write(p: Path, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))


def _main_log() -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1])


def _notes() -> list[str]:
    return [str(r.get("text") or "") for r in _main_log() if r.get("type") == "chip"]


@pytest.fixture()
def turn(tmp_path) -> tuple[Path, session.Live]:
    """Main attached, in a turn the analyst asked for that has written one line so far."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(p))
    assert lv is not None
    session.tail_once(lv)
    _write(p, [_human("Count the runs per agent."), _say("Counting the runs.")])
    session.tail_once(lv)
    assert lv.turn_open and agents.running(CORPUS, agents.MAIN_ID)
    return p, lv


async def test_main_s_stop_aborts_its_turn_through_the_module_and_the_mirror_ends_the_turn_with_its_note(bridge, turn, analyst):
    p, lv = turn
    # a line of the turn the tail has not read yet, then Stop
    _write(p, [_say("Agent 3 ran most of them.")])
    bridge.answers = [{"ok": True}]
    assert await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst) == {"stopped": True}
    assert [op for op, _ in bridge.calls] == ["abort", "note"]
    assert not lv.turn_open and not agents.running(CORPUS, agents.MAIN_ID)
    said = [r.get("delta") for r in _main_log() if r.get("type") == "text"]
    assert said == ["Counting the runs.", "Agent 3 ran most of them."], "what the transcript held is read before the end"
    assert _notes() == [session.STOPPED_TEXT]
    assert session.STOPPED_TEXT == "The turn was stopped in the browser"
    assert _main_log()[-1]["type"] == "done"
    # the cursor keeps the turn ended, so a restart does not open it again
    cursor = session.sessions(CORPUS)[SID]["cursor"]
    assert cursor["turn_open"] is False and cursor["offset"] == p.stat().st_size
    # a record of the aborted turn written after the stop is not shown, and the next prompt opens a new turn
    _write(p, [_say("late words of the stopped turn")])
    session.tail_once(lv)
    assert "late words of the stopped turn" not in [r.get("delta") for r in _main_log()]
    _write(p, [_human("Now per day.")])
    session.tail_once(lv)
    assert lv.turn_open and agents.running(CORPUS, agents.MAIN_ID)


async def test_main_s_stop_and_a_thread_s_take_the_analyst_s_cookie(bridge, plugin_headers):
    from starlette.requests import Request

    tid = agents.new_thread(CORPUS, "card:abc123", "Runs per agent", "runs-per-agent")["id"]
    agents.update_agent(CORPUS, tid, fork={"agent_id": "afork1"})
    bare = Request({"type": "http", "headers": []})
    for chat in (agents.MAIN_ID, tid):
        with pytest.raises(HTTPException) as no:
            await agents.interrupt_route(CORPUS, chat, bare)
        assert no.value.status_code == 403 and "start, message or stop thimble's agents" in no.value.detail
    assert bridge.calls == [], "the module is never asked"


async def test_a_thread_s_stop_tells_main_the_cards_its_fork_made_and_its_half_made_card_says_it_is_unfinished(
        bridge, analyst):
    """Bug hunt round 9, J5: after Stop on a side thread, main said "it was stopped before it made any card or chart",
    while the thread's half-made chart, with no takeaway, sat on the canvas with no word of it. The note main gets names
    the cards the fork made since the analyst's last message in the thread; one with no takeaway stays, marked
    unfinished, until a takeaway is written."""
    from app import notebook, tools

    tid = agents.new_thread(CORPUS, "card:abc123", "What did the admin revert?", "what-did-the-admin")["id"]
    agents.update_agent(CORPUS, tid, fork={"agent_id": "afork1"})
    nb = notebook.active_notebook_id(CORPUS)

    def card(title: str, takeaway: str = "") -> str:
        cell = notebook.new_cell("note", f"chat:{tid}", title, notebook.MAIN, payload={"text": "x"}, workspace=CORPUS)
        cell["takeaway"] = takeaway
        return str(notebook.insert_cell(CORPUS, nb, cell)["id"])

    earlier = card("Who reverted first?", "The admin, on Jun 18.")  # an answer to the thread's first question
    import time

    time.sleep(1.1)
    agents.Recorder(CORPUS, tid).record("user", text="go through every revert, with a chart", by="browser")
    time.sleep(1.1)
    done = card("How many reverts per page?", "Most pages had one.")
    half = card("What kinds of saves did the reverts undo?")
    bridge.answers = [{"ok": True}, {"ok": True}]
    assert await agents.interrupt_route(CORPUS, tid, analyst) == {"stopped": True}
    assert [op for op, _ in bridge.calls] == ["stop", "note"]
    note = str(bridge.calls[-1][1].get("text") or "")
    stopped = tools.hint("thread-stopped-note", thread=agents.thread_name(agents.read_meta(CORPUS, tid)), agent_id="afork1")
    assert note == " ".join([stopped, tools.hint("thread-stopped-made", cards=f"card:{done} and card:{half}"),
                             tools.hint("thread-stopped-unfinished", cards=f"card:{half}")])
    assert f"card:{earlier}" not in note, "a card of the thread's earlier question is no part of the stopped work"
    cells = {c["id"]: c for c in notebook.load_notebook(CORPUS, nb)["cells"]}
    assert cells[half].get("unfinished") == "stopped" and not cells[done].get("unfinished")
    notebook.append_takeaway(CORPUS, half, "Mostly link lists.")
    assert not {c["id"]: c for c in notebook.load_notebook(CORPUS, nb)["cells"]}[half].get("unfinished")


class _Req:
    async def is_disconnected(self) -> bool:
        return False


def _idle_main(tmp_path, transport: str) -> tuple[Path, session.Live]:
    """Main attached and idle at its prompt (no turn yet), its transport `transport` as launch.json records it, and on
    the server its shim subscribed, as after the `thimble` command."""
    from terminal_fakes import write_launch

    import os

    ws = config.workspace_dir(CORPUS)
    write_launch(ws, session=SID, transport=transport, pid=os.getpid())
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(p))
    assert lv is not None
    session.tail_once(lv)
    events._subs.setdefault(CORPUS, set()).add(events.Sub(SID))
    assert not lv.turn_open
    return ws, lv


async def test_a_stop_of_a_question_idle_main_has_not_got_takes_it_back_so_main_never_runs_it(bridge, tmp_path, analyst):
    """Bug hunt G1: the analyst's first question from the browser waited for main's watcher, and Stop answered "It had
    already ended." with the button spinning on, and the question ran minutes later. Stop takes back a message main has
    not got: main stops running, its chat says so, no watcher gets it, the held event that rode along waits again and
    the later parts of main's guidance it carried go with the next question."""
    ws, lv = _idle_main(tmp_path, "server")
    events.post(CORPUS, "labeled", {"text": "refunds: 12 yes", "name": "refunds"})
    asked = events.post(CORPUS, "main", {"text": "What are these runs?"})
    waiting = events._pending[(CORPUS, SID)][0]
    assert asked["delivered"] == 1 and agents.running(CORPUS, agents.MAIN_ID)
    assert "thimble's events arrive as" in waiting["content"] and "meanwhile:" in waiting["content"]
    assert events.held(CORPUS) == [], "the held event rides along with the question"
    assert await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst) == {"stopped": True, "cancelled": 1}
    assert bridge.calls == [], "no turn of main's runs, so the module is asked nothing"
    assert not agents.running(CORPUS, agents.MAIN_ID)
    assert _notes() == [session.CANCELLED_TEXT]
    assert (await events.pull_route(_Req(), cwd=str(config.corpus_dir(CORPUS)), session=SID, wait=0.2)).status_code == 204
    assert [n["meta"]["kind"] for n in events.held(CORPUS)] == ["labeled"]
    events.post(CORPUS, "main", {"text": "Which setup merged the most PRs?"})
    again = events._pending[(CORPUS, SID)][0]
    assert "Which setup" in again["content"] and "thimble's events arrive as" in again["content"]
    assert [r["meta"]["kind"] for r in again["riders"]] == ["labeled"]


async def test_on_local_transport_stop_takes_the_question_back_from_the_queue_file(bridge, tmp_path, analyst):
    """Before a press the question waits in the workspace's queue file for main's watcher, which must never take it. A
    request server code wrote to main (to stop the analyst's own subagent) is not the analyst's message, and stays."""
    from app import event_files

    ws, lv = _idle_main(tmp_path, "local")
    request = events.post(CORPUS, "main", {"text": "Stop the subagent a1."}, mirror=False, line="› Stop a1")
    asked = events.post(CORPUS, "main", {"text": "What are these runs?"})
    assert [r["id"] for r in event_files.waiting(ws)] == [request["id"], asked["id"]]
    assert await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst) == {"stopped": True, "cancelled": 1}
    assert [r["id"] for r in event_files.waiting(ws)] == [request["id"]]
    assert event_files.take(ws, SID)["id"] == request["id"] and event_files.take(ws, SID) is None
    assert not agents.running(CORPUS, agents.MAIN_ID) and _notes() == [session.CANCELLED_TEXT]


async def test_a_stop_while_main_runs_a_turn_ends_it_and_takes_back_the_question_that_waits(bridge, turn, analyst):
    p, lv = turn
    events._subs.setdefault(CORPUS, set()).add(events.Sub(SID))
    events.post(CORPUS, "main", {"text": "And per day?"})
    bridge.answers = [{"ok": True}]
    assert await agents.interrupt_route(CORPUS, agents.MAIN_ID, analyst) == {"stopped": True}
    assert [op for op, _ in bridge.calls] == ["abort", "note"]
    assert not events._pending.get((CORPUS, SID)) and not agents.running(CORPUS, agents.MAIN_ID)
    assert _notes() == [session.CANCELLED_TEXT, session.STOPPED_TEXT]


async def test_a_thread_s_stop_stops_the_label_run_its_fork_started_and_main_hears_what_stopped(bridge, analyst):
    """Bug hunt round 10, K4: Stop on a side thread stopped its fork, but the prompt label the fork had started ran on
    to its end (222 → 726 of 1,189 records), and main said the thread's work had stopped. A run the fork starts is the
    thread's (its run record's `thread`); the thread's Stop stops it wherever it runs (concepts.request_stop, the stop
    file of the process that runs it), and the note main gets names the run and how far it got. A run of main's own
    is left alone."""
    import os
    import time

    from app import concepts, subagent_files, tools

    tid = agents.new_thread(CORPUS, "card:abc123", "Who voted when?", "who-voted-when")["id"]
    agents.update_agent(CORPUS, tid, fork={"agent_id": "afork7"})
    ws = config.workspace_dir(CORPUS)

    async def label(name: str, call: str) -> str:
        res = await tools.call(CORPUS, "apply_label", {"scope": "files", "name": name, "paths": ["**/*.jsonl"],
                                                       "predicate": {"kind": "regex", "text": "(?i)merge"}},
                               actor="analyst", notebook=None, terminal=False, tool_use_id=call)
        assert not res.is_error, res.text
        return str(concepts.find_concept(ws, name)["id"])

    # the fork's call (the caller hook's line names it) makes the thread's run; main's own makes none
    subagent_files.add_caller(ws, "toolu_fork1", "afork7", subagent_files.FORK_TYPE)
    subagent_files.add_caller(ws, "toolu_main1", "", "")
    assert (concepts.current_run(CORPUS, await label("merge talk", "toolu_fork1")) or {}).get("thread") == tid
    mine = await label("merge words", "toolu_main1")
    assert "thread" not in (concepts.current_run(CORPUS, mine) or {})

    # each run going on in another process (the session's shim), as its run file says
    def running(cid: str, thread: str | None) -> None:
        rec = {"concept": cid, "run_id": f"r-{cid}", "status": "running", "done": 222, "total": 1189,
               "pid": os.getpid() + 1, "beat": time.time(), **({"thread": thread} if thread else {})}
        concepts.run_file(ws, cid).write_text(json.dumps(rec))

    k = concepts.find_concept(ws, "merge talk")["id"]
    running(k, tid)
    running(mine, None)
    # an agent the fork asked main to start (tools._ask_main), which main has not started yet
    from app import subagents  # noqa: PLC0415

    rid = subagents.new_request(CORPUS, "start", "writer:summary", {"subagent_type": "thimble:writer"}, None,
                                subagents.TYPED, role="writer", from_thread=tid,
                                ask={"what": "the request to write Summary (report:summary)", "agent": "the writer"})
    bridge.answers = [{"ok": True}, {"ok": True}]
    assert await agents.interrupt_route(CORPUS, tid, analyst) == {"stopped": True}
    assert [op for op, _ in bridge.calls] == ["stop", "note"]
    assert concepts.stop_file(ws, k).exists(), "the thread's run is asked to stop, in the process that runs it"
    assert not concepts.stop_file(ws, mine).exists(), "main's own run goes on"
    note = str(bridge.calls[-1][1].get("text") or "")
    said = tools.hint("thread-stopped-labels", labels=f"merge talk (concept:{k}, stopped at 222 of 1,189 records)")
    assert said and said in note, note
    card = next(cell for _nb, cell in concepts._label_cards(ws, k))
    assert card["created_by"] == f"chat:{tid}", "the label's card is the thread's, as its add_card's cards are"
    assert tools.hint("thread-stopped-made", cards=f"card:{card['id']}") in note, note
    assert tools.hint("thread-stopped-unfinished", cards=f"card:{card['id']}") in note, "it has no takeaway yet"
    assert subagents.request(CORPUS, rid)["state"] == "refused", "the start it asked for does not happen"
    assert tools.hint("thread-stopped-agents", agents="the writer (the request to write Summary (report:summary))") in note
