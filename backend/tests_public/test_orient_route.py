"""start_orientation starts the orientation's own session as the background session `thimble:orient · <workspace>`
(orient_session._launch's `background`), with the Start card's critique, Ultracode and effort, and never asks main to
start a subagent. agent_session.start is replaced by a stand-in that records its arguments."""
from __future__ import annotations

import json

import pytest

from app import agent_session, bg_session, cli, config, dev, ledger, orient_session, orientation, tools

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


async def test_settings_of_earlier_builds_load_and_change_nothing(launched):
    """A workspace's settings.json from an earlier build that still holds terminal_first (off: the orientation ran as a
    subagent of main) and hide_chat (on: no chat column) loads as one that never held them, and the orientation still
    starts as the background session."""
    default = ledger.get_settings(CORPUS)
    old = {"terminal_first": False, "hide_chat": True}
    (config.workspace_dir(CORPUS) / "settings.json").write_text(json.dumps(old))
    assert ledger.get_settings(CORPUS) == default
    orientation.start_requested(CORPUS, {"text": "", "final_notebook": True, "propose_views": True}, {"id": "e1"})
    res = await tools.call(CORPUS, "start_orientation", {"brief": ""})
    assert not res.is_error, res
    [call] = launched
    assert call["key"] == orient_session.KEY and call["background"] is True


async def test_without_claude_code_s_trust_the_orientation_does_not_start_and_the_settings_say_how_to_trust(
        workspaces_tmp, claude_global_config, monkeypatch):
    """`claude --bg` refuses a folder Claude Code does not trust. Where the workspaces folder is not trusted (install.sh's
    trust question answered no), start_orientation starts nothing and its error, which main reads, says the analyst
    reruns the installer with --trust-workspaces; the settings give the browser the command itself, except on a code
    ticket's test server, whose workspaces folder is never trusted."""
    started = []

    async def bg_start(*args, **kw):
        started.append(args)

    monkeypatch.setattr(bg_session, "start", bg_start)
    claude_global_config.write_text("{}")
    orientation.start_requested(CORPUS, {"text": "", "final_notebook": True, "propose_views": True}, {"id": "e1"})
    res = await tools.call(CORPUS, "start_orientation", {"brief": ""})
    assert res.is_error and "--trust-workspaces" in res.text and "install.sh" not in res.text
    assert started == [] and not orient_session.running(CORPUS)
    assert ledger.get_settings(CORPUS)["untrusted"] == {"folder": str(config.WORKSPACES_DIR),
                                                        "command": cli.trust_command()}
    claude_global_config.write_text(json.dumps({"projects": {str(config.WORKSPACES_DIR): {"hasTrustDialogAccepted": True}}}))
    assert ledger.get_settings(CORPUS)["untrusted"] is None
    claude_global_config.write_text("{}")
    monkeypatch.setattr(dev, "STACK_ENABLED", False)
    assert ledger.get_settings(CORPUS)["untrusted"] is None


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


async def test_a_second_start_orientation_while_one_starts_or_runs_starts_nothing(workspaces_tmp, monkeypatch):
    """Two start_orientation calls at once, as main can make in one turn, start one orientation: the second is refused
    with a line that tells main the orientation runs and to write nothing unless the analyst asked for a new one. A call
    once it runs is refused the same way."""
    import asyncio

    calls: list[str] = []
    gate = asyncio.Event()

    async def slow_start(c, key, **kw):
        calls.append(key)
        await gate.wait()  # `claude --bg` takes a while

    monkeypatch.setattr(agent_session, "start", slow_start)
    orientation.start_requested(CORPUS, {"text": "", "final_notebook": True, "propose_views": True}, {"id": "e1"})
    first = asyncio.ensure_future(tools.call(CORPUS, "start_orientation", {"brief": ""}))
    while not calls:
        await asyncio.sleep(0.01)
    second = asyncio.ensure_future(tools.call(CORPUS, "start_orientation", {}))
    await asyncio.wait([second], timeout=2)
    gate.set()
    assert not (await first).is_error
    assert calls == [orient_session.KEY], "one orientation starts"
    second = await second
    assert second.is_error and second.text.endswith(tools.hint("start_orientation-running")), second.text
    monkeypatch.setattr(orient_session, "running", lambda c: True)
    third = await tools.call(CORPUS, "start_orientation", {"brief": "again"})
    assert third.is_error and third.text.endswith(tools.hint("start_orientation-running"))
    assert calls == [orient_session.KEY]
