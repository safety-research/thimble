"""channel.py: the one event path from the browser to the analyst's Claude Code session. The kinds are the bullets of
main.md's events section, main's prompt is main.md with shared.md pasted in, an event is refused while no session listens, `main` and
`thread` log the analyst's line when they post, a thread's first event carries its anchor and a follow-up its fork's
agent id, and the shim's subscription delivers each event as {content, meta}. The shim's side is test_shim_channel.py."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app import agents, channel, config, prompts, session, threads

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    channel._subs.clear()
    session._live.clear()
    session._expected.clear()
    agents._busy.clear()
    yield
    channel._subs.clear()
    session._live.clear()


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _log(chat: str) -> list[dict]:
    _, log_path = agents.paths(CORPUS, chat)
    return agents.read_events(log_path)


# ----------------------------------------------------------------------------- the prompt and the kinds


def test_the_kinds_are_the_bullets_of_main_s_events_section():
    """A kind is a bullet of main.md's `## Events from the browser` that opens with the kind in backticks."""
    section = prompts.section("main", channel.EVENTS_SECTION)
    assert channel.kinds() == ["main", "thread", "start", "orient", "write", "card", "written", "checked", "labeled", "view"]
    for kind in channel.kinds():
        assert f"- `{kind}` " in section, kind


def test_the_session_prompt_is_main_rendered(tmp_path):
    """The launcher's --append-system-prompt: main.md with shared.md pasted in and the corpus folder and the views'
    citation forms filled; no slot left, and whole (Claude Code cuts only MCP instructions at 2 KB). The preamble on what
    thimble is comes under the title, then main's opening and its Chat and Canvas, then shared.md."""
    text = channel.session_prompt(str(config.corpus_dir(CORPUS)))
    main = prompts.render("main", {"workdir": str(config.corpus_dir(CORPUS)), "forms": ""}).strip()
    assert text.startswith("# thimble") and str(config.corpus_dir(CORPUS)) in text and "{{" not in text
    assert text.startswith("# thimble\n\n" + prompts.load("preamble").strip() + "\n\n")
    assert text.index("## Chat and Canvas") < text.index("## Cards") < text.index("## Events from the browser") < text.index("## Threads")
    assert main.splitlines()[0] in text
    other = channel.session_prompt(str(tmp_path))  # a folder that is no workspace yet: no forms, no error
    assert str(tmp_path) in other


# ----------------------------------------------------------------------------- posting


def test_an_event_is_refused_while_no_session_listens_and_for_an_unknown_kind(client):
    r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "hi"}})
    assert r.status_code == 409 and "`thimble`" in r.json()["detail"]
    assert _log(agents.MAIN_ID) == [], "an event nobody hears is never logged as sent"
    _listen()
    r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "nope", "payload": {}})
    assert r.status_code == 400 and "main" in r.json()["detail"] and "thread" in r.json()["detail"]
    assert client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "  "}}).status_code == 400


def test_a_browser_message_is_logged_on_main_and_published_to_the_session(client):
    q = _listen()
    r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "main", "payload": {"text": "which agent stalled?"}})
    assert r.status_code == 200
    out = r.json()
    assert out["kind"] == "main" and out["delivered"] == 1
    note = q.get_nowait()
    assert note == {"content": "which agent stalled?", "meta": {"kind": "main", "event": out["id"]}}
    rec = _log(agents.MAIN_ID)[-1]
    assert rec == {**rec, "type": "user", "by": "browser", "text": "which agent stalled?", "event": out["id"]}
    assert out["id"] in session._expected and agents._running(CORPUS, agents.MAIN_ID)


def test_a_thread_s_first_event_carries_its_anchor_and_a_follow_up_its_fork(client):
    """The first event's body: the question, then what was pointed at (ref, surface, element, selector, text, image and
    what the ref holds); its attributes the thread and the group its cards go in. Once the mirror has found the fork in
    the session that is main, a follow-up carries only the question and the fork's agent id."""
    q = _listen()
    meta = client.post(f"/api/ws/{CORPUS}/chats", json={"anchor": "events.jsonl#L1", "anchor_text": "the first event",
                                                         "surface": "files", "element": "files-row",
                                                         "selector": '[data-anchor="events.jsonl#L1"]'}).json()
    tid = meta["id"]
    r = client.post(f"/api/ws/{CORPUS}/events", json={"kind": "thread", "payload": {"thread": tid, "text": "what is this?"}})
    assert r.status_code == 200 and r.json()["thread"] == tid
    note = q.get_nowait()
    body = note["content"].splitlines()
    assert body[:6] == ["question: what is this?", "ref: events.jsonl#L1", "surface: files", "element: files-row",
                        'selector: [data-anchor="events.jsonl#L1"]', "text: the first event"]
    assert "content:" in body and any(ln.startswith("events.jsonl#L1 (") for ln in body)
    # the group is the thread itself; its canvas group is made with its first card (test_threads.py)
    assert note["meta"] == {"kind": "thread", "event": r.json()["id"], "thread": tid, "group": f"thread:{tid}"}
    assert agents.read_meta(CORPUS, tid)["group"] is None
    assert _log(tid)[-1] == {**_log(tid)[-1], "type": "user", "text": "what is this?", "by": "browser"}
    assert agents._running(CORPUS, tid)
    # the mirror found the fork in the attached session
    lv = session.attach(CORPUS, "s" * 8, str(config.corpus_dir(CORPUS)))
    threads.fork_started(CORPUS, tid, agent_id="a123", tool_use_id="toolu_x", session=lv.sid)
    client.post(f"/api/ws/{CORPUS}/events", json={"kind": "thread", "payload": {"thread": tid, "text": "and the next?"}})
    note = q.get_nowait()
    assert note["content"] == "question: and the next?" and note["meta"]["agent"] == "a123"
    # a fork of another session is gone: the next event forks anew, with the anchor
    session.attach(CORPUS, "t" * 8, str(config.corpus_dir(CORPUS)))
    client.post(f"/api/ws/{CORPUS}/events", json={"kind": "thread", "payload": {"thread": tid, "text": "again?"}})
    note = q.get_nowait()
    assert "agent" not in note["meta"] and "ref: events.jsonl#L1" in note["content"]
    assert client.post(f"/api/ws/{CORPUS}/events", json={"kind": "thread", "payload": {"thread": "main", "text": "x"}}).status_code == 400


def test_a_later_kind_needs_only_its_bullet_and_its_payload_folds_into_attributes_and_body():
    """A kind such as start orientation, write a document or build a view is a bullet of main.md's events section
    and a frontend trigger: the payload's text is the body, a short scalar an attribute (its key folded to an identifier), a
    longer or nested value a line of the body."""
    note = channel.notification("later", "e1", "Orient on the renames.", {"passes": ["analyze"], "focus-area": "renames",
                                                                          "long": "x" * 200, "empty": "", "none": None, "on": True})
    assert note["meta"] == {"kind": "later", "event": "e1", "focus_area": "renames", "on": "true"}
    assert note["content"].splitlines() == ["Orient on the renames.", 'passes: ["analyze"]', "long: " + "x" * 200]
    q = _listen()
    out = channel.post(CORPUS, "later", {"text": "Orient.", "focus": "renames"}, check_kind=False)
    assert q.get_nowait() == {"content": "Orient.", "meta": {"kind": "later", "event": out["id"], "focus": "renames"}}
    with pytest.raises(Exception) as e:
        channel.post(CORPUS, "later", {"text": "Orient."})
    assert getattr(e.value, "status_code", None) == 400, "a kind with no bullet is refused from the browser"


def test_an_event_with_no_text_says_in_its_body_what_the_analyst_did():
    """Claude Code shows the terminal only an event's body, so a Start or a Write with nothing typed carries one line
    saying what the analyst did (channel.describe); typed text stays the body, and the attributes are the same."""
    assert channel.describe("start", {"final_notebook": True, "propose_views": True, "generate_report": True}) == \
        "Start the orientation (final notebook, views, report)"
    assert channel.describe("start", {"final_notebook": False, "propose_views": False}) == "Start the orientation"
    assert channel.describe("write", {"doc": "report"}) == "Write the report"
    q = _listen()
    out = channel.post(CORPUS, "write", {"doc": "report", "text": "  "})
    assert q.get_nowait() == {"content": "Write the report", "meta": {"kind": "write", "event": out["id"], "doc": "report"}}
    out = channel.post(CORPUS, "write", {"doc": "report", "text": "Shorter, please."})
    assert q.get_nowait()["content"] == "Shorter, please."


def test_render_prompts_is_main_s_append_and_the_agents_skill_from_one_renderer():
    """channel.render_prompts renders prompt files with main's slots. session_prompt is it over main, and `thimble
    prompt shared` over the rules the shared skill loads (plugin/skills/shared), which main's append holds word for
    word, so those rules are one text wherever they are read."""
    cwd = str(config.corpus_dir(CORPUS))
    assert channel.session_prompt(cwd) == channel.render_prompts(channel.SESSION_PROMPTS, cwd)
    rules = channel.render_prompts(["shared"], cwd)
    assert rules.startswith("## Communicating") and "{{" not in rules and "card:<id>#<column>/<row>" in rules
    assert rules in channel.session_prompt(cwd), "main's append includes the same text"


# ----------------------------------------------------------------------------- the subscription


def test_the_subscription_waits_for_the_workspace_then_attaches_and_streams_events(client):
    """404 for a folder that is no workspace yet (the shim retries); a subscription names the session, which is then
    main, and gets a `ready` event and then each event as {content, meta}."""
    r = client.get("/api/channel", params={"cwd": "/nowhere/at/all"})
    assert r.status_code == 404
    cwd = str(config.corpus_dir(CORPUS))

    async def go():
        from app import channel as ch

        class Req:
            async def is_disconnected(self):
                return False

        resp = await ch.subscribe(Req(), cwd=cwd, session="s" * 8, pid=42)
        assert ch.listening(CORPUS) and session.current(CORPUS).sid == "s" * 8
        gen = resp.body_iterator
        first = await gen.__anext__()
        ch.post(CORPUS, "main", {"text": "hello"})
        second = await gen.__anext__()
        await gen.aclose()
        return first, second

    first, second = asyncio.run(go())
    assert first["event"] == "ready" and json.loads(first["data"]) == {"workspace": CORPUS}
    assert second["event"] == "channel" and json.loads(second["data"])["content"] == "hello"
    assert not channel.listening(CORPUS), "a closed subscription is no longer counted"
