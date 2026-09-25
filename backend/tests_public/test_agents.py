"""agents.py: the chat store, threads and the anchor they keep, chips and agent chats. No server session runs main or
a thread: they are the analyst's Claude Code session and its forks."""
from __future__ import annotations

import asyncio
import base64

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import agents, config


CORPUS = "mini"


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _events(c: str, chat_id: str) -> list[dict]:
    _, log_path = agents.paths(c, chat_id)
    return agents.read_events(log_path)


# ----------------------------------------------------------------------------- store


def test_main_is_made_on_first_touch_and_listed_first(workspaces_tmp):
    metas = agents.list_chats(CORPUS)
    assert [m["id"] for m in metas] == ["main"] and metas[0]["kind"] == "main"
    t = agents.new_thread(CORPUS, "card:abc", "why does this go negative")
    assert t["kind"] == "thread" and t["parent"] == "main" and t["title"] == "why-does-this-go"
    metas = agents.list_chats(CORPUS)
    assert [m["kind"] for m in metas] == ["main", "thread"] and metas[1]["n_messages"] == 0


def test_a_thread_about_a_view_hangs_under_the_views_dev_chat(workspaces_tmp):
    from app import views

    build = agents.new_agent(CORPUS, "dev", "view: Timeline", view="timeline", announce=False)
    views._save_proposals(CORPUS, [{"slug": "timeline", "name": "Timeline", "status": "built", "chat": build["id"]}])
    framed = agents.new_thread(CORPUS, "view:timeline/2026-06-17", "a bar", element="view:timeline")
    tab = agents.new_thread(CORPUS, "view:timeline", "Timeline")
    asked_in_main = agents.new_thread(CORPUS, "view:timeline", "Timeline", parent="main")
    other = agents.new_thread(CORPUS, "view:board", "Board", element="view:board")
    assert framed["parent"] == tab["parent"] == build["id"]
    assert asked_in_main["parent"] == "main" and other["parent"] == "main"


def test_a_chip_lands_in_main(workspaces_tmp):
    agents.chip(CORPUS, "filter", "rename · 41 records", ref="concept:x1")
    recs = _events(CORPUS, "main")
    assert recs[-1]["type"] == "chip" and recs[-1]["kind"] == "filter" and recs[-1]["ref"] == "concept:x1"
    assert recs[-1]["text"] == "rename · 41 records"


def test_an_agent_chat_runs_records_and_announces_itself_in_main(workspaces_tmp):
    async def go():
        async def run(rec: agents.Recorder) -> str:
            rec.text("looking around\n")
            rec.tool_use("t1", "mcp__thimble__add_card", {"question": "q", "code": "1"})
            rec.tool_result("t1", "card:abc\nok")
            await asyncio.sleep(0)
            return "8 cards"

        meta = agents.start_agent(CORPUS, "labels", "Labelling", run)
        task = agents._agent_tasks[(CORPUS, meta["id"])]
        await task
        return meta

    meta = asyncio.run(go())
    done = agents.read_meta(CORPUS, meta["id"])
    assert done["kind"] == "agent" and done["status"] == "done" and done["result"] == "8 cards"
    types = [r["type"] for r in _events(CORPUS, meta["id"])]
    assert types == ["text", "tool_use", "tool_result", "done"]
    announce = [r for r in _events(CORPUS, "main") if r["type"] == "agent"]
    assert announce and announce[0]["chat"] == meta["id"] and announce[0]["role"] == "labels"


def test_a_failing_agent_ends_failed(workspaces_tmp):
    async def go():
        async def run(rec: agents.Recorder) -> str:
            raise RuntimeError("boom")

        meta = agents.start_agent(CORPUS, "dev", "ticket #1", run)
        await agents._agent_tasks[(CORPUS, meta["id"])]
        return meta

    meta = asyncio.run(go())
    done = agents.read_meta(CORPUS, meta["id"])
    assert done["status"] == "failed" and "boom" in done["result"]
    assert _events(CORPUS, meta["id"])[-1]["type"] == "error"


def test_models_for_layers_defaults_environment_and_settings(monkeypatch):
    monkeypatch.setenv("THIMBLE_LABELS_MODEL", "claude-sonnet-5")
    m = config.models_for(None, {"models": {"dev": {"model": "claude-opus-5", "effort": "high", "fast": True}}})
    assert m["labels"]["model"] == "claude-sonnet-5"
    assert m["dev"] == {"model": "claude-opus-5", "effort": "high", "fast": True}
    # every role that runs a model is configurable, but main, whose model is the session's own
    assert set(m) == set(config.MODEL_ROLES) and "main" not in m
    monkeypatch.delenv("THIMBLE_LABELS_MODEL")
    assert config.models_for(None, {})["labels"]["fast"] is False  # the labels' default is fast mode off
    # an alias is kept as the id it stands for, so every role names its model exactly
    monkeypatch.setenv("THIMBLE_DEV_MODEL", "opus[1m]")
    assert config.models_for(None, {})["dev"]["model"] == "claude-opus-5-5[1m]"


# ----------------------------------------------------------------------------- routes


def test_routes_make_list_read_update_and_delete_threads(client):
    r = client.get(f"/api/ws/{CORPUS}/chats/main")
    assert r.status_code == 200 and r.json()["meta"]["kind"] == "main"
    r = client.post(f"/api/ws/{CORPUS}/chats", json={"anchor": "report:report#s12", "anchor_text": "The agents split the backlog."})
    assert r.status_code == 201
    tid = r.json()["id"]
    assert client.get(f"/api/ws/{CORPUS}/chats/{tid}").json()["meta"]["anchor"] == "report:report#s12"
    r = client.put(f"/api/ws/{CORPUS}/chats/{tid}", json={"title": "backlog split", "effort": "high"})
    assert r.json()["title"] == "backlog split" and r.json()["effort"] == "high"
    assert client.put(f"/api/ws/{CORPUS}/chats/{tid}", json={"effort": "loud"}).status_code == 400
    ids = [m["id"] for m in client.get(f"/api/ws/{CORPUS}/chats").json()]
    assert ids == ["main", tid]
    assert client.delete(f"/api/ws/{CORPUS}/chats/main").status_code == 409
    assert client.delete(f"/api/ws/{CORPUS}/chats/{tid}").status_code == 200
    assert [m["id"] for m in client.get(f"/api/ws/{CORPUS}/chats").json()] == ["main"]


async def test_rename_and_delete_from_the_thread_list(workspaces_tmp):
    """The row menu's Rename sends `name`: a thread's title, any other chat's `name`, never main's. Its Delete stops the
    chat's work when it runs, then removes the chat."""
    t = agents.new_thread(CORPUS, "card:abc", "the card")
    assert (await agents.update_route(CORPUS, t["id"], agents.ChatUpdate(name=" backlog  split ")))["title"] == "backlog split"
    writer = agents.new_agent(CORPUS, "writer", "Write report")
    assert (await agents.update_route(CORPUS, writer["id"], agents.ChatUpdate(name="draft")))["name"] == "draft"
    for bad, chat in (("x", "main"), ("  ", t["id"])):
        with pytest.raises(HTTPException) as e:
            await agents.update_route(CORPUS, chat, agents.ChatUpdate(name=bad))
        assert e.value.status_code == 400
    ended = asyncio.Event()

    async def work(rec):
        try:
            await asyncio.sleep(60)
        finally:
            ended.set()

    job = agents.start_agent(CORPUS, "dev", "Ticket #3: slow", work)
    await asyncio.sleep(0)
    assert (await agents.delete_route(CORPUS, job["id"]))["deleted"] == job["id"]
    assert ended.is_set(), "the running task was stopped before its chat went"
    assert agents.meta_or_none(CORPUS, job["id"]) is None and (CORPUS, job["id"]) not in agents._agent_tasks
    with pytest.raises(HTTPException) as e:
        await agents.delete_route(CORPUS, "main")
    assert e.value.status_code == 409


def test_main_s_meta_names_the_orientation_s_status_whatever_main_holds(client):
    """The browser's Start gate stays open until an orientation is asked for, so main's meta carries
    orient/run.json's status, null before any."""
    from app import orientation

    agents.ensure_main(CORPUS)
    agents.append(agents.paths(CORPUS, "main")[1], {"type": "user", "text": "How many episode folders are there?", "by": "terminal"})
    meta = client.get(f"/api/ws/{CORPUS}/chats/main").json()["meta"]
    assert meta["orientation"] is None
    orientation.record(CORPUS, status="done")  # no record yet: nothing is written
    assert client.get(f"/api/ws/{CORPUS}/chats/main").json()["meta"]["orientation"] is None
    orientation._write_run(CORPUS, {"status": "requested", "passes": ["final", "views"]})
    assert client.get(f"/api/ws/{CORPUS}/chats/main").json()["meta"]["orientation"] == "requested"
    orientation.record(CORPUS, status="failed")
    assert client.get(f"/api/ws/{CORPUS}/chats/main").json()["meta"]["orientation"] == "failed"
    tid = client.post(f"/api/ws/{CORPUS}/chats", json={"anchor": "card:abc"}).json()["id"]
    assert "orientation" not in client.get(f"/api/ws/{CORPUS}/chats/{tid}").json()["meta"], "a thread's meta has none"


def test_settings_carry_the_effective_models(client):
    r = client.get(f"/api/ws/{CORPUS}/settings")
    assert r.status_code == 200 and r.json()["models"]["dev"]["model"]
    r = client.put(f"/api/ws/{CORPUS}/settings", json={"models": {"labels": {"model": "claude-sonnet-5"}}})
    assert r.json()["models"]["labels"]["model"] == "claude-sonnet-5"
    # a role's fields merge into what it holds: the Start card saves the orientation's effort alone, its bolt the fast
    # mode alone, and the model picked before stays
    client.put(f"/api/ws/{CORPUS}/settings", json={"models": {"orient": {"model": "claude-sonnet-5", "effort": "high"}}})
    client.put(f"/api/ws/{CORPUS}/settings", json={"models": {"orient": {"effort": "max"}}})
    r = client.put(f"/api/ws/{CORPUS}/settings", json={"models": {"orient": {"fast": False}}})
    orient = r.json()["models"]["orient"]
    assert (orient["model"], orient["effort"], orient["fast"]) == ("claude-sonnet-5[1m]", "max", False)
    assert r.json()["models"]["labels"]["model"] == "claude-sonnet-5", "the other roles stay"


def test_archive_moves_the_workspace_aside_whole_and_detaches_its_session(client, workspaces_tmp):
    """`/thimble fresh`'s route (ledger.archive_workspace): workspaces/<c>/ moves to workspaces/.archive/<c>-<time>/
    with everything in it, the attached session is detached (its /thimble names it again, to the empty workspace), and
    the next read under the name finds an empty workspace. A workspace with no folder archives nothing, two archives in
    one second get distinct names, and an unknown workspace is 404."""
    from datetime import datetime
    from pathlib import Path

    from app import ledger, session

    agents.mirror(CORPUS, "user", by=agents.BROWSER, text="what do the agents do?")
    session.attach(CORPUS, "s-1", str(config.corpus_dir(CORPUS)))
    assert client.get("/api/tools/holdings", params={"workspace": CORPUS}).json()["chats"] == 1
    try:
        r = client.post(f"/api/ws/{CORPUS}/archive")
        assert r.status_code == 200
        gone = r.json()["archived"]
        assert gone and gone.startswith(str(workspaces_tmp.resolve() / ledger.ARCHIVE_DIR / f"{CORPUS}-"))
        assert not (workspaces_tmp / CORPUS).exists() and session.current(CORPUS) is None
        log = agents.read_events(Path(gone) / "chats" / "main.jsonl")
        assert [r["text"] for r in log] == ["what do the agents do?"], "the detach writes nothing in main's chat"
        assert client.get("/api/tools/holdings", params={"workspace": CORPUS}).json()["chats"] == 0
        main = client.get(f"/api/ws/{CORPUS}/chats/main").json()
        assert main["events"] == [] and main["meta"]["attached"] is None
    finally:
        session._live.pop(CORPUS, None)
    second = client.post(f"/api/ws/{CORPUS}/archive").json()["archived"]  # the folder the GET above made
    assert second and second != gone and not (workspaces_tmp / CORPUS).exists()
    assert client.post(f"/api/ws/{CORPUS}/archive").json() == {"archived": None}
    assert client.post("/api/ws/no-such-corpus/archive").status_code == 404
    when = datetime(2026, 9, 23, 15, 30, 12)
    first = ledger.archive_path(CORPUS, when)
    assert first.name == f"{CORPUS}-2026-09-23-153012"
    first.mkdir(parents=True)
    assert ledger.archive_path(CORPUS, when).name == f"{CORPUS}-2026-09-23-153012-2"


# ----------------------------------------------------------------------------- threads and running, without a server session

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def test_a_thread_keeps_the_anchor_the_browser_captured(client):
    """The ⌘-click's anchor: the ref, the visible text (cut at ANCHOR_TEXT_CHARS), the surface, the element's kind and
    selector, and the picture, saved as anchors/<thread>.png under the workspace; a data URL that is not a PNG is
    dropped."""
    body = {"anchor": "card:abc", "anchor_text": "x" * 3000, "surface": "canvas", "element": "canvas-card",
            "selector": '[data-anchor="card:abc"]', "image": "data:image/png;base64," + base64.b64encode(PNG).decode()}
    r = client.post(f"/api/ws/{CORPUS}/chats", json=body)
    assert r.status_code == 201
    meta = r.json()
    assert (meta["anchor_surface"], meta["anchor_element"], meta["anchor_selector"]) == ("canvas", "canvas-card", '[data-anchor="card:abc"]')
    assert len(meta["anchor_text"]) == agents.ANCHOR_TEXT_CHARS and meta["fork"] is None
    path = config.workspace_dir(CORPUS) / "anchors" / f"{meta['id']}.png"
    assert meta["anchor_image"] == str(path) and path.read_bytes() == PNG
    bad = client.post(f"/api/ws/{CORPUS}/chats", json={"anchor": "card:abc", "image": "data:image/png;base64,bm90IGEgcG5n"}).json()
    assert bad["anchor_image"] is None


def test_running_is_the_mirror_s_and_the_channel_s_mark_and_the_browser_stops_no_session(client):
    """No server session runs main or a thread, so `running` is what set_running marked (the channel when it posts, the
    mirror when a turn or a fork ends), there is no message route, and interrupting main or a thread stops nothing."""
    tid = client.post(f"/api/ws/{CORPUS}/chats", json={"anchor": "card:abc"}).json()["id"]
    assert client.get(f"/api/ws/{CORPUS}/chats/main").json()["meta"]["running"] is False
    agents.set_running(CORPUS, "main", True)
    agents.set_running(CORPUS, tid, True)
    assert client.get(f"/api/ws/{CORPUS}/chats/main").json()["meta"]["running"] is True
    assert {m["id"]: m["running"] for m in client.get(f"/api/ws/{CORPUS}/chats").json()}[tid] is True
    assert client.post(f"/api/ws/{CORPUS}/chats/main/interrupt").json() == {"stopped": False}
    assert client.post(f"/api/ws/{CORPUS}/chats/{tid}/interrupt").json() == {"stopped": False}
    assert client.post(f"/api/ws/{CORPUS}/chats/main/message", json={"text": "hi"}).status_code in (404, 405)
    assert client.delete(f"/api/ws/{CORPUS}/chats/{tid}").status_code == 200, "a thread whose fork runs in the session can go"
    agents.set_running(CORPUS, "main", False)
    assert not hasattr(agents, "run_turn") and not hasattr(agents, "options") and not hasattr(agents, "transcript")
