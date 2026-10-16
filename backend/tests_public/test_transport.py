"""The session's transport (0.9.0, no modes): local until the analyst's first press of the browser workbench, the server
after it, one way. launch.json names main, its transport, its peers and the sessions moved from main
(subagent_files.transport, local.transport); events are addressed per session, so two sessions in one workspace do not
hear each other's events (event_files, events.post); after the press the server takes main's events a process of the
session still writes to the queue file (H2, H3), its mirror reads on from the last local pass's cursor (H4), the local
holder finishes the work it started and starts no new pass (H6), and nothing switches back when the server is gone
(H7); `thimble act` takes its JSON on standard input and, after the press, sends the acts whose state the server holds
to the server's route."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from terminal_fakes import CORPUS, MAIN, write_launch

from app import config, event_files, events, local, local_hooks, session
from app import subagent_files as sf

PEER = "7e000000-0000-4000-8000-00000000000b"
OLD = "7e000000-0000-4000-8000-00000000000c"
OTHER = "7e000000-0000-4000-8000-00000000000d"
BACKEND = Path(__file__).resolve().parents[1]


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


def test_main_after_a_rekey_keeps_the_server_and_a_peer_s_rekey_never_makes_it_main(ws):
    write_launch(ws, transport="server", peers=[PEER])
    with sf.update(ws) as state:
        sf.rekey(state, MAIN, OTHER)
    assert sf.transport(ws, OTHER) == sf.SERVER, "/clear in main's process: the new session is main"
    assert sf.transport(ws, MAIN) == sf.LOCAL
    with sf.update(ws) as state:
        sf.rekey(state, PEER, "7e000000-0000-4000-8000-00000000000e", main=False)
        assert state["main"]["session"] == OTHER, "a peer's /clear leaves main as it is"
    assert sf.main_session(ws) == OTHER


def test_a_legacy_record_reads_its_mode_as_its_transport(ws):
    """0.8.0's launch.json named a mode: terminal is local, browser (or a record with neither field) the server's; a
    workspace with no record at all (a demo's) is the server's too, as 0.8.0's browser default was."""
    write_launch(ws, mode="terminal")
    assert sf.transport(ws) == sf.LOCAL
    write_launch(ws, mode="browser")
    assert sf.transport(ws) == sf.SERVER and sf.transport(ws, MAIN) == sf.SERVER
    write_launch(ws, mode="")
    assert sf.transport(ws) == sf.SERVER
    sf.launch_path(ws).unlink()
    assert sf.transport(ws) == sf.SERVER
    assert sf.transport(None) == sf.LOCAL


def test_no_mode_key_is_read_or_written_by_the_backend_or_the_plugin_s_programs():
    """3.17: no process reads or writes a mode; 0.8.0's `mode` is read only as a legacy transport (subagent_files
    LEGACY_MODES). Files other lanes still change are named until their merge."""
    import re

    root = BACKEND.parent
    pattern = re.compile(r"\bTHIMBLE_MODE\b|launch_mode|\{\{if:terminal\}\}|\{\{if:browser\}\}|@terminal|@browser|"
                         r'mode: "terminal"')
    # the lanes that own these files remove their mode code in the same release (SPEC-v2 3.17): core (prompts,
    # tools, the shim, ledger), features (views, term_views, checks), browser (demo)
    others = {"backend/app/prompts.py", "backend/app/tools.py", "backend/app/views.py", "backend/app/term_views.py",
              "backend/app/checks.py", "backend/app/demo.py", "backend/app/ledger.py", "plugin/bin/thimble-mcp"}
    found = []
    for path in [*(root / "backend" / "app").rglob("*.py"), *(root / "plugin" / "bin").iterdir()]:
        rel = path.relative_to(root).as_posix()
        if not path.is_file() or rel in others or "__pycache__" in rel:
            continue
        for n, line in enumerate(path.read_text("utf-8", errors="replace").splitlines(), 1):
            if pattern.search(line):
                found.append(f"{rel}:{n}: {line.strip()}")
    assert found == []


# ----------------------------------------------------------------------------- two sessions in one workspace


def test_a_peer_s_event_reaches_only_the_peer_and_main_s_only_main(ws):
    """Events carry the session they are for (events.post's `session`); event_files.take gives a session only its own,
    and an event that names none is main's."""
    mine = events.post(CORPUS, "label_done", {"text": "refunds: 12 yes", "name": "refunds"}, check_kind=False,
                       session=PEER)
    theirs = events.post(CORPUS, "label_done", {"text": "status: 4 yes", "name": "status"}, check_kind=False)
    assert mine["session"] == PEER and "session" not in theirs
    assert [r["id"] for r in event_files.waiting(ws, PEER)] == [mine["id"]]
    assert [r["id"] for r in event_files.waiting(ws)] == [theirs["id"]]
    assert event_files.take(ws, MAIN)["id"] == theirs["id"]
    assert event_files.take(ws, MAIN) is None, "main never takes the peer's"
    assert event_files.take(ws, PEER)["id"] == mine["id"]
    assert event_files.take(ws, OTHER) is None


def test_an_event_for_main_s_own_session_is_main_s_and_held_notes_ride_with_their_own_session(ws):
    events.post(CORPUS, "labeled", {"text": "peer's label is in", "name": "x"}, check_kind=False, session=PEER)
    events.post(CORPUS, "labeled", {"text": "main's label is in", "name": "y"}, check_kind=False, session=MAIN)
    assert [n["content"] for n in event_files.held(ws)] == ["main's label is in"]
    assert [n["content"] for n in event_files.held(ws, PEER)] == ["peer's label is in"]
    done = events.post(CORPUS, "label_done", {"text": "z", "name": "z"}, check_kind=False, session=PEER)
    [rec] = event_files.waiting(ws, PEER)
    assert rec["id"] == done["id"] and "peer's label is in" in rec["text"] and "main's" not in rec["text"]
    assert [n["content"] for n in event_files.held(ws)] == ["main's label is in"], "main's note waits for main"


def test_a_process_of_a_session_posts_for_its_own_session(ws, monkeypatch):
    """With no `session`, a process of the session (the shim of a peer whose label run ended) addresses the event to its
    own session (local.session_here); the server's own posts are main's."""
    monkeypatch.setattr(events, "SERVING", False)
    monkeypatch.setattr(local, "session_here", lambda: PEER)
    out = events.post(CORPUS, "label_done", {"text": "peer", "name": "p"}, check_kind=False)
    assert out["session"] == PEER and [r["id"] for r in event_files.waiting(ws, PEER)] == [out["id"]]
    monkeypatch.setattr(local, "session_here", lambda: MAIN)
    out = events.post(CORPUS, "label_done", {"text": "main", "name": "m"}, check_kind=False)
    assert "session" not in out and event_files.waiting(ws)[-1]["id"] == out["id"]


def test_an_event_to_a_session_that_moved_by_clear_follows_it(ws):
    out = events.post(CORPUS, "label_done", {"text": "x", "name": "x"}, check_kind=False, session=PEER)
    with sf.update(ws) as state:
        sf.rekey(state, PEER, OTHER, main=False)
    assert event_files.take(ws, OTHER)["id"] == out["id"]


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


def test_h4_the_server_s_attach_waits_for_a_pass_under_way_and_reads_on_from_its_cursor(ws, tmp_path, monkeypatch):
    """The server attaches main after the press while a local pass holds PASS_LOCK: the attach waits for it and takes
    the cursor that pass saved, so the mirror has no gap and no duplicate; catch_up reads nothing once main runs on the
    server."""
    held = threading.Event()
    release = threading.Event()

    def pass_under_way():
        with session._pass_lock(ws):
            held.set()
            release.wait(5)
            recs = session.sessions(CORPUS)
            recs[MAIN] = {**recs.get(MAIN, {}), "cursor": {"transcript": str(transcript), "offset": 11}}
            session.atomic_write_text(session._sessions_path(CORPUS), json.dumps(recs))

    transcript = tmp_path / f"{MAIN}.jsonl"
    transcript.write_text('{"a": 1}\n' * 4)
    recs = session.sessions(CORPUS)
    recs[MAIN] = {"cwd": str(config.corpus_dir(CORPUS)), "transcript_path": str(transcript),
                  "cursor": {"transcript": str(transcript), "offset": 0}}
    session.atomic_write_text(session._sessions_path(CORPUS), json.dumps(recs))
    from app import agents

    meta = agents.ensure_main(CORPUS)
    meta["attached"] = {"session": MAIN, "cwd": str(config.corpus_dir(CORPUS))}
    agents.write_meta(CORPUS, meta)
    t = threading.Thread(target=pass_under_way)
    t.start()
    held.wait(5)
    _press(ws)
    assert session._handing_over(CORPUS)
    threading.Timer(0.3, release.set).start()
    started = time.monotonic()
    lv = session.attach(CORPUS, MAIN, str(config.corpus_dir(CORPUS)), str(transcript), pid=os.getpid())
    t.join()
    assert time.monotonic() - started >= 0.25, "the attach waited for the pass"
    assert lv is not None and lv.offset == 11, "and read on from the cursor that pass saved"
    session._live.clear()
    assert session.catch_up(CORPUS) is None, "no local pass reads main once it runs on the server"


def test_h6_the_local_holder_finishes_what_it_started_and_starts_no_pass_after_the_press(ws, monkeypatch):
    """After the press the holder of the local passes keeps running while work it started goes on (a view build in its
    memory), then exits; a new hook call for the workspace starts nothing."""
    busy = {"n": 3}

    def _busy(c):
        busy["n"] -= 1
        return busy["n"] > 0

    passes: list[str] = []

    async def _pass(c, items):
        passes.append("pass")

    monkeypatch.setattr(local_hooks, "_busy", _busy)
    monkeypatch.setattr(local_hooks, "_pass", _pass)
    monkeypatch.setattr(local_hooks, "TICK_S", 0.01)
    _press(ws)
    n = asyncio.run(local_hooks._hold(CORPUS, ws))
    assert n == 3 and busy["n"] == 0, "it ran until the work it started was done, then went"
    hook = {"cwd": str(config.corpus_dir(CORPUS)), "session_id": MAIN}
    out = subprocess.run([sys.executable, "-m", "app.local_hooks", "stopped"], cwd=BACKEND, input=json.dumps(hook),
                         capture_output=True, text=True, timeout=60,
                         env={**os.environ, "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR)})
    assert out.returncode == 0 and not (ws / local_hooks.TODO).exists(), "a call after the press starts no pass"


def test_h7_the_transport_stays_the_server_when_the_server_is_gone(ws, tmp_path, monkeypatch):
    """Nothing writes local over server: with no server running (no server.json) main's transport is still the server's,
    the module still asks over HTTP, and the hooks' backend calls still start nothing."""
    from app import module_bridge

    _press(ws)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    assert sf.transport(ws, MAIN) == sf.SERVER and module_bridge.transport(CORPUS) == module_bridge.HTTP
    assert local.transport(CORPUS, MAIN) == "server"


# ----------------------------------------------------------------------------- thimble act


def _act(*args: str, stdin: str | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
    code = ("import sys, json; from app import local\n"
            "async def count(c, payload):\n"
            "    return {'paths': len(payload.get('facts') or []), 'session': payload.get('session')}\n"
            "local._ACTS['count-facts'] = count\n"
            "sys.exit(local.main(sys.argv[1:]))\n")
    return subprocess.run([sys.executable, "-c", code, *args], cwd=BACKEND, input=stdin, capture_output=True,
                          text=True, timeout=120, env={**os.environ, **(env or {})})


def test_thimble_act_takes_its_json_on_standard_input_even_with_200_000_paths(ws):
    """A `grep -rl` can name 100,000 paths, past what one argument may hold (128 KiB on Linux): the act's JSON comes on
    standard input with --stdin."""
    facts = [{"path": f"agents/run-{i:06d}/events.jsonl", "how": "searched", "by": "Bash", "at": 1.0}
             for i in range(200_000)]
    payload = json.dumps({"session": MAIN, "turn": "u1", "facts": facts})
    assert len(payload) > 128 * 1024 * 10
    env = {"THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR)}
    started = time.monotonic()
    out = _act("act", "count-facts", "--cwd", str(config.corpus_dir(CORPUS)), "--stdin", stdin=payload, env=env)
    assert out.returncode == 0, out.stdout + out.stderr
    assert json.loads(out.stdout) == {"ok": True, "paths": 200_000, "session": MAIN}
    assert time.monotonic() - started < 30
    out = _act("act", "count-facts", "--cwd", str(config.corpus_dir(CORPUS)), '{"facts": [1, 2]}', env=env)
    assert json.loads(out.stdout) == {"ok": True, "paths": 2, "session": None}, "the argument form stays"


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


def test_a_ticket_s_notice_opens_the_ticket_in_the_browser_from_the_terminal(ws):
    """3.16: a code ticket that passed its checks posts a notice whose act opens it in the browser workbench; the
    terminal gets {act: ticket-open, ref: ticket:<id>}."""
    from app import notices

    notices.post(CORPUS, kind="ticket", key="ticket:t1", text="ticket 1 passed its checks and waits for your Allow",
                 action={"label": "open ›", "do": "ticket-open", "slug": "t1"})
    [n] = [x for x in local._notices(CORPUS) if x["key"] == "ticket:t1"]
    assert n["acts"] == [{"label": "open ›", "act": "ticket-open", "ref": "ticket:t1"}]
