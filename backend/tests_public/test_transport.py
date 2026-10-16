"""The session's transport (0.9.0, no modes): local until the analyst's first press of the browser workbench, the server
after it, one way. launch.json names main, its transport, its peers and the sessions moved from main
(subagent_files.transport, local.transport); events are addressed per session, so two sessions in one workspace do not
hear each other's events (event_files, events.post); after the press the server takes main's events a process of the
session still writes to the queue file (H2, H3), its mirror reads on from the last local pass's cursor (H4), the local
holder finishes the work it started and starts no new pass (H6), and nothing switches back when the server is gone
(H7); `thimble act` takes its JSON on standard input and, after the press, sends the acts whose state the server holds
to the server's route."""
from __future__ import annotations

from pathlib import Path

import pytest
from terminal_fakes import CORPUS, MAIN, write_launch

from app import config, event_files, events, local, session
from app import subagent_files as sf

PEER = "7e000000-0000-4000-8000-00000000000b"
OLD = "7e000000-0000-4000-8000-00000000000c"
OTHER = "7e000000-0000-4000-8000-00000000000d"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    session._live.clear()
    session._shadows.clear()
    session._expected.clear()
    yield
    session._live.clear()
    session._shadows.clear()


@pytest.fixture()
def ws(workspaces_tmp):
    path = config.workspace_dir(CORPUS)
    write_launch(path, transport="local", peers=[PEER], moved=[OLD])
    return path


# ----------------------------------------------------------------------------- the transport table


def test_the_transport_is_the_server_only_for_main_after_the_press(ws):
    """main + server → server; a peer, a session moved from main and any other session → local; before the press every
    session is local."""
    for sid in (None, MAIN, PEER, OLD, OTHER):
        assert sf.transport(ws, sid) == sf.LOCAL, sid
        assert local.transport(CORPUS, sid) == local.LOCAL, sid
    write_launch(ws, transport="server", peers=[PEER], moved=[OLD])
    assert sf.transport(ws) == sf.SERVER and sf.transport(ws, MAIN) == sf.SERVER
    assert local.transport(CORPUS) == "server" and local.transport(CORPUS, MAIN) == "server"
    for sid in (PEER, OLD, OTHER):
        assert sf.transport(ws, sid) == sf.LOCAL, sid
        assert local.transport(CORPUS, sid) == "local", sid
    assert local.terminal(CORPUS) is False and sf.terminal(ws) is False


# ----------------------------------------------------------------------------- the press: H2, H3, H4, H6, H7


def _press(ws: Path) -> None:
    write_launch(ws, transport="server", peers=[PEER], moved=[OLD])


def test_h2_h3_main_s_events_written_to_the_file_after_the_press_reach_main_through_the_server_once_in_order(ws, monkeypatch):
    """A label run the shim started before the press ends after it: its label_done, posted from the shim's process,
    goes into the queue file (no process but the server queues in memory), and the server takes main's waiting events
    and held notes from the file into its own queue, in order, once, at the pull of main's watcher."""
    a = events.post(CORPUS, "label_done", {"text": "before the press", "name": "a"}, check_kind=False)
    events.post(CORPUS, "labeled", {"text": "a quiet one", "name": "q"}, check_kind=False)
    peer = events.post(CORPUS, "label_done", {"text": "the peer's", "name": "p"}, check_kind=False, session=PEER)
    _press(ws)
    monkeypatch.setattr(events, "SERVING", False)  # the shim's process
    monkeypatch.setattr(local, "session_here", lambda: None)
    b = events.post(CORPUS, "label_done", {"text": "after the press", "name": "b"}, check_kind=False)
    assert [r["id"] for r in event_files.waiting(ws)] == [a["id"], b["id"]], "both wait in the file for the server"
    monkeypatch.setattr(events, "SERVING", True)  # the server's process
    events._pending.clear()
    assert events._drain_files(CORPUS) == 2
    assert events._drain_files(CORPUS) == 0, "taken once"
    queued = list(events._pending.get((CORPUS, MAIN), ()))
    assert [n["meta"]["event"] for n in queued] == [a["id"], b["id"]]
    assert events.render(queued[0]).startswith(f'<thimble-event kind="label_done" event="{a["id"]}"')
    assert event_files.waiting(ws) == [] and event_files.take(ws, MAIN) is None, "no local watcher takes them too"
    assert [r["id"] for r in event_files.waiting(ws, PEER)] == [peer["id"]], "a peer's stay local"
    assert "a quiet one" in events.render(queued[1]) and events.held(CORPUS) == [], \
        "main's held note rode along with the next event for main, as it does through the server's queue"
    # a new event on the server goes to its own queue (which needs main's subscription), never to the file
    assert events._queue_ws(CORPUS) is None and events._queue_ws(CORPUS, PEER) == ws
    events._pending.clear()


# ----------------------------------------------------------------------------- thimble act


async def test_after_the_press_an_act_whose_state_the_server_holds_goes_to_the_server_s_route(ws, monkeypatch):
    """Comments of a document and of Claude's answers, and the view proposals and notices, after the press: the act
    posts to the server's route (with the token's proof) instead of changing the files here. Before the press, and for
    a peer, it runs here; an act the server holds nothing of always runs here."""
    sent: list[str] = []
    monkeypatch.setattr(local, "_post_to_server", lambda path: sent.append(path) or {"ok": True, "status": "dismissed"})
    ran: list[str] = []

    async def fake_resolve(c, payload):
        ran.append(payload["comment"])
        return {"comment": payload["comment"]}

    monkeypatch.setitem(local._ACTS, "comment-resolve", fake_resolve)
    out = await local.act(CORPUS, "comment-resolve", {"doc": "report", "comment": "c1"}, session=MAIN)
    assert ran == ["c1"] and sent == [] and out == {"ok": True, "comment": "c1"}, "before the press: here"
    _press(ws)
    out = await local.act(CORPUS, "comment-resolve", {"doc": "report:report", "comment": "c2"}, session=MAIN)
    assert sent == [f"/api/ws/{CORPUS}/investigations/main/types/report/comments/c2/dismiss"]
    assert out["via"] == "server" and ran == ["c1"]
    await local.act(CORPUS, "answer-comment-resolve", {"comment": "a 1", "reopen": True}, session=MAIN)
    await local.act(CORPUS, "view-accept", {"slug": "board"}, session=MAIN)
    await local.act(CORPUS, "notice-dismiss", {"id": "n1"}, session=MAIN)
    assert sent[1:] == [f"/api/ws/{CORPUS}/answer-comments/a%201/reopen", f"/api/ws/{CORPUS}/views/proposals/board/accept",
                        f"/api/ws/{CORPUS}/notices/n1/dismiss"]
    out = await local.act(CORPUS, "comment-resolve", {"doc": "report", "comment": "c3"}, session=PEER)
    assert ran == ["c1", "c3"], "a peer's act runs here"
    with pytest.raises(local.StateError):
        await local.act(CORPUS, "comment-resolve", {"comment": "c4"}, session=MAIN)
