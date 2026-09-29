"""start_orientation starts the orientation's own session as the background session `thimble:orient · <workspace>`
(orient_session._launch's `background`), with the Start card's critique, Ultracode and effort, and never asks main to
start a subagent. agent_session.start is replaced by a stand-in that records its arguments."""
from __future__ import annotations

import pytest

from app import agent_session, orient_session, orientation, tools

CORPUS = "mini"


@pytest.fixture()
def launched(workspaces_tmp, monkeypatch) -> list[dict]:
    calls: list[dict] = []

    async def fake_start(c, key, **kw):
        calls.append({"c": c, "key": key, **kw})
        return None

    monkeypatch.setattr(agent_session, "start", fake_start)
    monkeypatch.setattr(orient_session, "running", lambda c: False)
    return calls


async def test_start_orientation_runs_the_session_in_the_background(launched):
    orientation.start_requested(CORPUS, {"text": "", "final_notebook": True, "propose_views": True,
                                         "critique": True, "ultracode": True, "effort": "xhigh"}, {"id": "e1"})
    res = await tools.call(CORPUS, "start_orientation", {"brief": ""})
    assert not res.is_error, res
    assert res.text.endswith(tools.hint("start_orientation-started")), "main is never asked to start a subagent"
    [call] = launched
    assert call["key"] == orient_session.KEY and call["background"] is True
    assert call["critique"] is True and call["ultracode"] is True
    assert "route" not in (orientation.read_run(CORPUS) or {})


def test_an_orientation_an_earlier_build_ran_as_main_s_subagent_ends_its_record_with_its_chat(workspaces_tmp):
    """_restore_subs still follows an `orient` chat of main's that an earlier build started; when it ends, now or before
    this server started, its record (`route: subagent`) ends too, and a record of this build's own session is left
    alone."""
    from app import session
    from app.ledger import write_json

    lv = session.Live(CORPUS, "sid-main", "/tmp", None, None)
    sub = session.Sub(CORPUS, "chat-o", "tu1", "ag1", role=orientation.ROLE)
    orientation.run_file(CORPUS).parent.mkdir(parents=True, exist_ok=True)
    write_json(orientation.run_file(CORPUS), {"status": "running", "route": "subagent", "chats": {"orient": "chat-o"}})
    session._old_orientation_ended(lv, sub, "done", "Six findings.", report=False)
    run = orientation.read_run(CORPUS) or {}
    assert run["status"] == "done" and run["ended"] and orientation.summary(CORPUS) == "Six findings.\n"
    write_json(orientation.run_file(CORPUS), {"status": "running", "session": "s1", "chats": {"orient": "chat-o"}})
    session._old_orientation_ended(lv, sub, "stopped", None)
    assert (orientation.read_run(CORPUS) or {})["status"] == "running", "this build's own session ends by its own run"
