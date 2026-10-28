"""A view whose builder answers a message, stopped and asked again: each run starts from a copy of the view as it is, so
its end tells a change from no change and puts a failed change back (N3)."""
from __future__ import annotations

import asyncio

from test_view_subagents import (  # noqa: F401
    CORPUS, _built_in_two_attempts, _draft, _prop, _propose, _until, board, gates)
from subagent_fakes import bridge, hints  # noqa: F401

from app import agents, dev, subagents, views


def _sent(bridge) -> str:
    return " ".join(str(s.get("text") or "") for s in bridge.ops("send"))


async def _settled(slug: str) -> dict:
    await asyncio.sleep(0.05)
    await _until(lambda: (CORPUS, slug) not in dev._settling and not _prop(slug).get("answering"), "not settled")
    return _prop(slug)


async def test_stop_an_answer_then_ask_again(board, bridge, gates, monkeypatch):
    """Stop the run that answers a question (no change), then ask another: the second is answered by a run of its own,
    no rebuild, no error, the chat not left running, nothing stale in the stop bookkeeping."""
    slug = _propose(asked=True)
    agent = await _built_in_two_attempts(slug, monkeypatch)
    views.message(CORPUS, slug, "Why is run 3 missing?")
    await _until(lambda: bridge.ops("send"), "the first message never reached the builder")
    subagents.run_again(CORPUS, agent, "coordinator")
    p = _prop(slug)
    chat = str(p.get("chat") or "")
    print("WHILE ANSWERING:", {k: p.get(k) for k in ("status", "answering", "chat")},
          "chat status:", (agents.meta_or_none(CORPUS, chat) or {}).get("status"))
    assert p["status"] == "built" and p.get("answering")
    assert (agents.meta_or_none(CORPUS, chat) or {}).get("status") == "running", "the thread's composer needs a running chat"
    assert views.stop_build(CORPUS, slug) == {"ok": True}
    await _until(lambda: bridge.ops("stop"), "no TaskStop through the module")
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    p = await _settled(slug)
    print("AFTER STOP:", {k: p.get(k) for k in ("status", "error", "attempt", "revision", "failed_change", "message",
                                                  "message_sent")},
          "chat status:", (agents.meta_or_none(CORPUS, chat) or {}).get("status"),
          "stopping:", dict(dev._view_stopping))
    assert p["status"] == "built" and not p.get("error") and p["attempt"] == 2 and not p.get("revision")
    assert (agents.meta_or_none(CORPUS, chat) or {}).get("status") != "running"
    assert (CORPUS, agent) not in dev._view_stopping
    views.message(CORPUS, slug, "And where is run 4?")
    await _until(lambda: len(bridge.ops("send")) >= 2, "the second message never reached the builder")
    subagents.run_again(CORPUS, agent, "coordinator")
    p = _prop(slug)
    assert p["status"] == "built" and (p.get("answering") or {}).get("text") == "And where is run 4?"
    subagents.run_ended(CORPUS, agent, "done", "Run 4 was filtered out.", source="handback")
    p = await _settled(slug)
    print("AFTER SECOND ANSWER:", {k: p.get(k) for k in ("status", "error", "attempt", "revision", "change")})
    assert p["status"] == "built" and not p.get("revision") and not p.get("error") and p["attempt"] == 2
    assert _sent(bridge).count("Why is run 3 missing?") == 1 and _sent(bridge).count("And where is run 4?") == 1


async def test_message_written_while_a_stop_is_under_way(board, bridge, gates, monkeypatch):
    """Stop the answering run and write a second message before the stopped run has ended: each message reaches the
    builder once, the second is answered by the next run as a message, and the view is as it was."""
    slug = _propose(asked=True)
    agent = await _built_in_two_attempts(slug, monkeypatch)
    views.message(CORPUS, slug, "Why is run 3 missing?")
    await _until(lambda: bridge.ops("send"), "the first message never reached the builder")
    subagents.run_again(CORPUS, agent, "coordinator")
    assert views.stop_build(CORPUS, slug) == {"ok": True}
    views.message(CORPUS, slug, "And where is run 4?")  # before the stop has ended the run
    await _until(lambda: len(bridge.ops("send")) >= 2 or (CORPUS, slug) in dev._view_runs, "the second went nowhere")
    await asyncio.sleep(0.1)
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await asyncio.sleep(0.1)
    p = _prop(slug)
    print("AFTER STOPPED END:", {k: p.get(k) for k in ("status", "error", "answering", "message", "message_sent",
                                                        "revision")}, "sends:", len(bridge.ops("send")),
          "starts:", len(bridge.ops("start")))
    assert p["status"] == "built" and not p.get("revision") and not p.get("error")
    subagents.run_again(CORPUS, agent, "coordinator")  # the builder runs again with the second message
    p = _prop(slug)
    print("NEXT RUN:", {k: p.get(k) for k in ("status", "answering", "message", "message_sent")})
    assert p["status"] == "built" and (p.get("answering") or {}).get("text") == "And where is run 4?"
    subagents.run_ended(CORPUS, agent, "done", "Run 4 was filtered out.", source="handback")
    p = await _settled(slug)
    assert p["status"] == "built" and not p.get("revision") and p["attempt"] == 2
    assert (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text() == "<p>v1</p>"
    assert _sent(bridge).count("Why is run 3 missing?") == 1 and _sent(bridge).count("And where is run 4?") == 1


async def test_message_after_stop_whose_run_changes_and_fails(board, bridge, gates, monkeypatch):
    """As above, but the run that takes the second message writes a failing page and ends without finish_view: the
    view must be put back as it was (v1), as a failed change is."""
    slug = _propose(asked=True)
    agent = await _built_in_two_attempts(slug, monkeypatch)
    v_before = (views.read_view(CORPUS, slug) or {}).get("version")
    views.message(CORPUS, slug, "Why is run 3 missing?")
    await _until(lambda: bridge.ops("send"), "the first message never reached the builder")
    subagents.run_again(CORPUS, agent, "coordinator")
    assert views.stop_build(CORPUS, slug) == {"ok": True}
    views.message(CORPUS, slug, "Make the lanes taller.")  # before the stop has ended the run
    await _until(lambda: len(bridge.ops("send")) >= 2, "the second went nowhere")
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await asyncio.sleep(0.1)
    print("COPY KEPT BEFORE SECOND RUN:", views._revision_dir(CORPUS, slug).is_dir())
    subagents.run_again(CORPUS, agent, "coordinator")
    _draft(slug, "<p>FAIL v2</p>")
    subagents.run_ended(CORPUS, agent, "done", "Done.", source="handback")
    p = await _settled(slug)
    html = (views.views_dir(CORPUS) / slug / views.VIEW_HTML).read_text()
    print("AFTER FAILING SECOND RUN:", {k: p.get(k) for k in ("status", "error", "failed_change", "revision", "attempt")},
          "folder html:", html, "version:", v_before, "->", (views.read_view(CORPUS, slug) or {}).get("version"))
    assert html == "<p>v1</p>", "the failed change is put back"
