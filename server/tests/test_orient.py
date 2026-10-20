"""The orientation: it drafts its deck, gets the critic's report through `critique`, ends, and continues on a follow-up
(orient.py), with a fake Messages API client."""
import asyncio

import pytest

from thimble_browser import agent, calls, canvas, chats, home, llm, orient
from thimble_browser.app import build

from fakes import ScriptedClient, last_result, system_of, turns


@pytest.fixture(autouse=True)
def features(home):
    """The feature modules add their tools and routes when the server is built."""
    build(21999)

REPORT = "1. The deck counts runs in runs/ only; results.csv was never opened. Count outcomes there too."


def orientation_script(gate: asyncio.Event | None = None):
    def script(req):
        sys = system_of(req)
        n = turns(req)
        if sys.startswith("# Critic"):
            async def critic():
                if gate is not None:
                    await gate.wait()
                return [REPORT]
            return critic() if n == 0 else ["(done)"]
        if sys.startswith("# Orientation"):
            if n == 0:
                return [{"tool": "Read", "input": {"file_path": "runs/a.jsonl"}}]
            if n == 1:
                assert last_result(req).startswith("[call:")
                return [{"tool": "add_card", "input": {"question": "How did the run end?", "kind": "note",
                                                       "text": "It was merged.", "takeaway": "The run was merged.",
                                                       "group": "Somewhere else"}}]
            if n == 2:
                return [{"tool": "critique", "input": {"context": "One run, merged."}}]
            if n == 3:
                return ["Done: one card in Orientation."]
            return ["The follow-up's answer."]
        return ["main's answer"]
    return script


@pytest.fixture
def ws(folder):
    return home.open_folder(folder)


async def wait_idle(sessions, ws):
    for _ in range(200):
        await asyncio.sleep(0.01)
        if not sessions.running(ws):
            return
    raise AssertionError("the agents never stopped")


async def test_the_orientation_drafts_its_deck_gets_a_critique_and_ends(ws, monkeypatch):
    fake = ScriptedClient(orientation_script())
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    got = await orient.start(ws, sessions, "", by="click")
    chat = got["chat"]
    await wait_idle(sessions, ws)

    # its card went to the deck, whatever group the call named, and the deck is the group the canvas opens on
    deck = next(nb for nb in canvas.notebooks(ws) if nb["title"] == "Orientation")
    assert deck["role"] == "exploration" and [c["title"] for c in deck["cells"]] == ["How did the run end?"]
    # the critic ran as a step of the orientation's thread, and its report was the critique call's result
    meta = chats.meta(ws, chat)
    assert meta["status"] == "done" and meta["role"] == "orient" and "paused" not in meta
    steps = [r for r in chats.records(ws, chat) if r["type"] == "agent"]
    assert len(steps) == 1 and steps[0]["role"] == "step"
    critic = chats.meta(ws, steps[0]["chat"])
    assert critic["agent_type"] == "thimble:critic" and critic["status"] == "done" and critic["parent"] == chat
    brief = agent.load_messages(ws, critic["id"])[0]["content"]
    assert "One run, merged." in brief and "How did the run end?" in brief and f"call:{chat}/1 Read" in brief
    assert "results.csv" in brief  # no call named it
    assert REPORT in calls.one(ws, chat, 3)["result"]
    # main's chat opens the thread, and the record says it ended
    assert any(r["type"] == "agent" and r["chat"] == chat for r in chats.records(ws, "main"))
    run = orient.read_run(ws)
    assert run["status"] == "done" and run["chats"]["orient"] == chat
    assert chats.meta(ws, "main")["orientation"] == "done"
    # each call carries its number, which a call: ref reads
    assert [r["n"] for r in chats.records(ws, chat) if r["type"] == "tool_use"] == [1, 2, 3]
    assert "merged" in calls.text_of(ws, f"call:{chat}/1#L2")


async def test_a_follow_up_continues_it_as_its_next_run(ws, monkeypatch):
    fake = ScriptedClient(orientation_script())
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    chat = (await orient.start(ws, sessions, "Who merged most?"))["chat"]
    await wait_idle(sessions, ws)
    got = await orient.message(ws, sessions, "And the failures?")
    assert got == {"status": "sent", "chat": chat}
    await wait_idle(sessions, ws)
    user = [r for r in chats.records(ws, chat) if r["type"] == "user"]
    assert user[0]["text"] == "Who merged most?"
    assert user[-1]["run"] == 1 and user[-1]["event"] == "orient-follow-up"
    meta = chats.meta(ws, chat)
    assert meta["run"] == 1 and meta["followups"][0]["status"] == "done"
    assert [r.get("run") for r in chats.records(ws, "main") if r["type"] == "agent"] == [None, 1]


async def test_a_message_while_it_runs_waits_and_a_second_start_is_refused(ws, monkeypatch):
    gate = asyncio.Event()
    fake = ScriptedClient(orientation_script(gate))
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    chat = (await orient.start(ws, sessions, ""))["chat"]
    for _ in range(100):
        await asyncio.sleep(0.01)
        if chats.meta(ws, chat).get("paused") == "critique":
            break
    assert chats.meta(ws, chat)["paused"] == "critique"
    assert (await orient.start(ws, sessions, ""))["kind"] == "busy"
    got = await orient.message(ws, sessions, "Look at results.csv too.")
    assert got["queued"]
    gate.set()
    await wait_idle(sessions, ws)
    await asyncio.sleep(0.05)
    await wait_idle(sessions, ws)
    assert any(r.get("run") == 1 for r in chats.records(ws, chat) if r["type"] == "user")


async def test_stopping_the_orientation_stops_its_critic(ws, monkeypatch):
    gate = asyncio.Event()
    fake = ScriptedClient(orientation_script(gate))
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    chat = (await orient.start(ws, sessions, ""))["chat"]
    for _ in range(100):
        await asyncio.sleep(0.01)
        if chats.meta(ws, chat).get("paused") == "critique":
            break
    critic = next(r["chat"] for r in chats.records(ws, chat) if r["type"] == "agent")
    assert await sessions.get(ws, chat).interrupt()
    await wait_idle(sessions, ws)
    assert chats.meta(ws, chat)["status"] == "stopped" and chats.meta(ws, chat)["stopped_by"] == "analyst"
    assert chats.meta(ws, critic)["status"] == "stopped"
    assert orient.read_run(ws)["status"] == "stopped"


async def test_stopping_the_critique_lets_the_orientation_go_on(ws, monkeypatch):
    gate = asyncio.Event()
    fake = ScriptedClient(orientation_script(gate))
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    chat = (await orient.start(ws, sessions, ""))["chat"]
    for _ in range(100):
        await asyncio.sleep(0.01)
        if chats.meta(ws, chat).get("paused") == "critique":
            break
    critic = next(r["chat"] for r in chats.records(ws, chat) if r["type"] == "agent")
    await sessions.get(ws, critic).interrupt()
    await wait_idle(sessions, ws)
    assert chats.meta(ws, chat)["status"] == "done"
    result = calls.one(ws, chat, 3)
    assert result["is_error"] and "could not finish" in result["result"]


async def test_a_server_that_stopped_leaves_the_orientation_stopped_and_a_message_continues_it(ws, monkeypatch):
    gate = asyncio.Event()
    fake = ScriptedClient(orientation_script(gate))
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    chat = (await orient.start(ws, sessions, ""))["chat"]
    for _ in range(100):
        await asyncio.sleep(0.01)
        if chats.meta(ws, chat).get("paused") == "critique":
            break
    # the server stops: its tasks end without their records, and the next server recovers
    for s in list(sessions._s.values()):
        s.task.cancel()
    await asyncio.sleep(0.05)
    for cid in (chat, next(r["chat"] for r in chats.records(ws, chat) if r["type"] == "agent")):
        m = chats.meta(ws, cid)
        m["status"] = "running"
        chats.save_meta(ws, m)
    orient._update_run(ws, status="running")
    orient.recover(ws)
    assert chats.meta(ws, chat)["status"] == "stopped" and orient.read_run(ws)["status"] == "stopped"
    gate.set()
    fresh = agent.Sessions()
    await orient.message(ws, fresh, "Go on.")
    await wait_idle(fresh, ws)
    assert chats.meta(ws, chat)["status"] == "done"
