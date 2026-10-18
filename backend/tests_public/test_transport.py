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


# ----------------------------------------------------------------------------- the browser's event stream


async def test_another_process_s_event_reaches_the_browser_s_stream_when_one_of_the_server_s_follows_at_once(ws, monkeypatch):
    """A label run in `thimble-run` (another process) writes `concepts applied` to the workspace's log, and the server
    writes its next record a moment later, before the stream's idle tail read the file: the browser's stream sends both,
    in order, rather than skipping the other process's lower seq as already sent (bug hunt C8: the label card on the
    canvas kept 0 per value)."""
    import json  # noqa: PLC0415
    from types import SimpleNamespace  # noqa: PLC0415

    import asyncio  # noqa: PLC0415

    from app import investigation  # noqa: PLC0415

    monkeypatch.setattr(investigation, "EVENTS_POLL_S", 60.0)  # the idle tail does not run within the test
    log = investigation.ensure_main(CORPUS) / "events.jsonl"
    stream = (await investigation._stream(CORPUS, investigation.MAIN, SimpleNamespace(headers={}))).body_iterator

    async def record() -> dict:
        while True:
            rec = await asyncio.wait_for(anext(stream), 2.0)
            if "id" in rec:
                return json.loads(rec["data"])

    try:
        while (await asyncio.wait_for(anext(stream), 2.0)).get("event") != "live":
            pass
        investigation.emit(CORPUS, investigation.MAIN, {"type": "chat", "chat": "main"})
        first = (await record())["seq"]
        with log.open("a", encoding="utf-8") as f:  # the other process's record
            f.write(json.dumps({"type": "concepts", "concept": "lbl-one", "what": "applied", "rows": True,
                                "seq": first + 1}) + "\n")
        investigation.emit(CORPUS, investigation.MAIN, {"type": "chat", "chat": "main"})
        got = [await record(), await record()]
        assert [(r["type"], r["seq"]) for r in got] == [("concepts", first + 1), ("chat", first + 2)]
    finally:
        await stream.aclose()


async def test_an_open_stream_keeps_none_of_the_history_it_replayed(ws):
    """The browser's stream replays the workspace's log from its start, then stays open for the session: once the
    history is sent the stream holds none of it, since the log grows with the session and each tab holds a stream."""
    import contextlib  # noqa: PLC0415
    from types import SimpleNamespace  # noqa: PLC0415

    import asyncio  # noqa: PLC0415

    from app import investigation  # noqa: PLC0415

    for n in range(50):
        investigation.emit(CORPUS, investigation.MAIN, {"type": "chat", "chat": "main", "n": n})
    stream = (await investigation._stream(CORPUS, investigation.MAIN, SimpleNamespace(headers={}))).body_iterator
    try:
        sent = 0
        while (rec := await asyncio.wait_for(anext(stream), 2.0)).get("event") != "live":
            sent += "id" in rec
        assert sent >= 50
        stream_task = asyncio.ensure_future(anext(stream))  # the stream goes on past the history, to its wait
        await asyncio.sleep(0.05)
        assert stream.ag_frame.f_locals["stored"] == [], "the open stream still holds the history it sent"
        stream_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await stream_task
    finally:
        await stream.aclose()


# ----------------------------------------------------------------------------- thimble act


async def test_after_the_press_an_act_whose_state_the_server_holds_goes_to_the_server_s_route(ws, monkeypatch):
    """Comments of a document and of Claude's answers, and the view proposals and notices, after the press: the act
    posts its kind and payload to the server's route for `thimble act` (with the token's proof) instead of changing the
    files here. Before the press, and for a peer, it runs here; an act the server holds nothing of always runs here."""
    sent: list[str] = []

    def post(c, kind, payload):
        sent.append(local.server_route(c, kind, payload))
        return {"ok": True, "status": "dismissed"}

    monkeypatch.setattr(local, "_post_to_server", post)
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


@pytest.mark.real_write_guard
async def test_after_the_press_the_terminal_s_accept_reaches_the_server_with_the_token_alone(ws, monkeypatch,
                                                                                              plugin_headers):
    """Bug hunt B11: after the press, `accept` on the terminal's view proposal row posted the token's proof to the
    browser's accept route, which takes only a signed-in browser's cookie, and got 403. `thimble act` now posts to the
    server's route of its own (term_acts.py), a token route, which accepts the view proposal as the browser's Accept
    does, and answers {queued: false, reason} when thimble refuses the click; the browser's route still refuses the
    token."""
    from fastapi.testclient import TestClient

    from app import cli, hook_auth, main, views

    monkeypatch.setenv("THIMBLE_PORT", "8300")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    plugin_headers()  # the token in the test's server.json, which cli._request proves
    client = TestClient(main.create_app(), base_url="http://testserver")
    asked: list[tuple[str, str]] = []

    def request(method, url, body=None, timeout=5.0, cookie=None):  # cli._request, through the app
        assert cookie is None, "the terminal holds no browser's cookie"
        path = "/" + url.split("/", 3)[3]
        asked.append((method, path))
        r = client.request(method, path, json=body, headers=hook_auth.headers(hook_auth.token(), 80))
        return r.status_code, r.json()

    monkeypatch.setattr(cli, "_request", request)
    accepted: list[str] = []
    refusal = {"kind": "no-module", "reason": "Claude Code's session is not ready for thimble yet"}
    answers = iter([{"slug": "board", "status": "queued"}, {"slug": "board", "status": "suggested", "refused": refusal}])
    monkeypatch.setattr(views, "accept", lambda c, slug, place=None: accepted.append((slug, place)) or next(answers))
    _press(ws)
    out = await local.act(CORPUS, "view-accept", {"slug": "board"}, session=MAIN)
    assert accepted == [("board", "terminal")] and out == {"ok": True, "queued": True, "via": "server"}
    assert asked == [("POST", f"/api/ws/{CORPUS}/act")] and hook_auth.guarded("POST", asked[0][1])
    out = await local.act(CORPUS, "view-accept", {"slug": "board"}, session=MAIN)
    assert out["queued"] is False and out["reason"] == refusal["reason"], "a refusal comes back with its reason"
    r = client.post(f"/api/ws/{CORPUS}/views/proposals/board/accept", headers=hook_auth.headers(hook_auth.token(), 80))
    assert r.status_code == 403, "the browser's route takes only the browser's cookie"


# ----------------------------------------------------------------------------- a browser signed in before this session


def test_f4_a_signed_in_browser_moves_main_to_the_server_so_main_s_permission_requests_show(ws, monkeypatch,
                                                                                          plugin_headers):
    """Bug hunt F4: a browser still signed in from an earlier session reached main on local transport through the
    queue file, but a permission request on local transport reaches no server, so its question hung with no card. A
    signed-in browser's message (or its page's stream) now makes the server follow main, as a press does: the
    PermissionRequest hook then tells the server, and main's card shows the request. A post with no browser's
    sign-in moves nothing."""
    from conftest import UI_COOKIE_VALUE, UI_KEY_VALUE, _record_paired
    from fastapi.testclient import TestClient

    from app import activate, agents, hook_auth
    from app.main import app

    monkeypatch.setattr(activate, "main_alive", lambda c, rec=None: True)  # the test process stands in for `claude`
    _record_paired(UI_COOKIE_VALUE)
    signed = {"cookie": f"{hook_auth.ui_cookie()}={UI_COOKIE_VALUE}"}
    with TestClient(app, base_url="http://127.0.0.1") as client:
        r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "from a script"}})
        assert r.status_code == 200 and sf.transport(ws) == sf.LOCAL, "no browser's sign-in: main stays local"
        r = client.post(f"/b/{UI_KEY_VALUE}/api/ws/{CORPUS}/events", headers=signed,
                        json={"kind": "main", "payload": {"text": "which pages changed?"}})
        assert r.status_code == 200, r.text
        assert sf.transport(ws) == sf.SERVER and sf.main_session(ws) == MAIN, "the server follows main now"
        assert session._live[CORPUS].sid == MAIN
        asked = client.post("/api/events/permission", headers=plugin_headers("http://127.0.0.1"),
                            json={"cwd": str(config.corpus_dir(CORPUS)), "session": MAIN, "tool_name": "Bash",
                                  "tool_input": {"command": "ls", "description": "Run the new card"}})
        assert asked.status_code == 200, asked.text
        held = agents.meta_or_none(CORPUS, agents.MAIN_ID)["permissions"]
        assert [(p["what"], p.get("terminal")) for p in held] == [("Run the new card", True)]


async def test_main_s_failed_citations_reach_main_as_one_quiet_note_with_its_next_prompt(ws, monkeypatch):
    """Bug hunt L4: thimble marked main's three quotes failed and told main nothing. The terminal's check hands main's
    failed citations to `thimble act cite-failed`, which holds one quiet `cite_failed` event: it starts no turn, prints
    nothing in the terminal, and rides with main's next prompt, with the bullet that says what to do with it."""
    monkeypatch.setattr(local, "session_here", lambda: MAIN)
    cites = [{"shown": '"Error: the gate is locked"', "ref": "logs/run.jsonl#L85", "why": "the value is not at its place",
              "card": "c0ffee01"},
             {"shown": "42", "ref": "card:c0ffee02#n/all", "why": "the place shows 41"}]
    got = await local.act(CORPUS, "cite-failed", {"cites": cites}, session=MAIN)
    assert got["ok"] and got["held"]
    assert event_files.waiting(ws) == [], "it starts no turn"
    notes = event_files.held(ws)
    assert [n["meta"]["kind"] for n in notes] == ["cite_failed"]
    line = events.meanwhile(notes)
    assert ('"Error: the gate is locked" at logs/run.jsonl#L85 (card:c0ffee01): the value is not at its place; '
            '42 at card:c0ffee02#n/all (your answer): the place shows 41') in line, line
    assert "`cite_failed` lists citations of yours" in line, "its bullet comes with the first one"
    riders = event_files.pop_held(ws, None)
    assert len(riders) == 1 and event_files.said(riders) == "" and event_files.held(ws) == []
