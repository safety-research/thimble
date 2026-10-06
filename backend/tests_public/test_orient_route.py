"""The orientation as a subagent of main (orient_session.py): Start in the browser starts it through thimble's module
(a fake of lane M's bridge); main's start_orientation records the pending start and gives the exact Agent call, with the
run's model and effort from its arguments or Settings; neither starts without the module, in plan mode, or in a session
the launcher did not start. A follow-up goes through the module from the browser and as main's exact SendMessage from
the terminal; one to an orientation of an earlier session or version is refused. The end of a run closes the record,
tells main, and starts the report's writer through the module."""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from app import agents, config, ledger, orient_session, orientation, subagents, tools
from app import subagent_files as sf
from subagent_fakes import HINTS, bridge  # noqa: F401 — a fixture

CORPUS = "mini"


@pytest.fixture()
def models(monkeypatch):
    rows = {"orient": {"model": "claude-opus-5-5[1m]", "effort": "max", "fast": False},
            "subagents": {"model": "claude-sonnet-5", "effort": "medium", "fast": False},
            "critic": {"model": "claude-opus-5-5", "effort": "xhigh", "fast": False},
            "writer": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    monkeypatch.setattr(config, "models_for", lambda c=None: {k: dict(v) for k, v in rows.items()})
    monkeypatch.setattr(orient_session, "ASKED_WAIT_S", 0.0)
    return rows


@pytest.fixture()
def unmeasured(monkeypatch):
    """The first run's end measures no coverage line and tells main nothing."""
    async def measure(c, chat):
        return ""

    monkeypatch.setattr(orient_session, "measure", measure)
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: None)


async def _ended(agent: str) -> None:
    """The orientation's run ends with its hand-back, and the end goes on once its (empty) coverage line is in."""
    import asyncio

    subagents.run_ended(CORPUS, agent, "done", "Done.", source="handback")
    for _ in range(100):
        if CORPUS not in orient_session._closing:
            return
        await asyncio.sleep(0.01)


def _input(res) -> dict:
    assert not res.is_error, res.text
    return json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])


async def test_start_orientation_gives_the_exact_agent_call_with_settings_values(bridge, models, workspaces_tmp):
    res = await tools.call(CORPUS, "start_orientation", {"focus": "the moderators", "report": True})
    inp = _input(res)
    assert set(inp) == {"subagent_type", "description", "prompt"} and inp["subagent_type"] == "thimble:orientation"
    assert inp["description"] == "orientation: the moderators"
    rid = inp["prompt"].split("\n")[0]
    assert sf.REQUEST_RE.fullmatch(rid), "the request id on the prompt's first line"
    assert "REQUEST the moderators" in inp["prompt"] and "OUTPUTS the deck, view proposals, the report" in inp["prompt"]
    assert "CRITIQUE off" in inp["prompt"]
    rec = orientation.read_run(CORPUS)
    assert (rec["status"], rec["route"], rec["started_by"], rec["request"]) == ("starting", "subagent", "typed", rid)
    assert (rec["model"], rec["effort"]) == ("claude-opus-5-5[1m]", "max") and rec["passes"] == ["final", "views", "report"]
    r = subagents.request(CORPUS, rid)
    assert r["values"] == {"model": "claude-opus-5-5[1m]", "effort": "max"} and r["route"] == "typed"
    assert not bridge.calls, "a typed start is main's call"


async def test_the_run_s_own_model_and_effort_and_switches(bridge, models, workspaces_tmp):
    res = await tools.call(CORPUS, "start_orientation", {"brief": "x", "model": "sonnet", "effort": "high",
                                                         "views": False, "critique": True})
    inp = _input(res)
    assert "OFF view proposals, the report" in inp["prompt"] and "CRITIQUE on" in inp["prompt"]
    rec = orientation.read_run(CORPUS)
    assert (rec["model"], rec["effort"], rec["critique"]) == ("claude-sonnet-5[1m]", "high", True)
    assert orientation.part_on(CORPUS, "critique") and not orientation.part_on(CORPUS, "views")


async def test_a_second_start_while_one_starts_or_runs_starts_nothing(bridge, models, workspaces_tmp):
    assert not (await tools.call(CORPUS, "start_orientation", {"brief": ""})).is_error
    second = await tools.call(CORPUS, "start_orientation", {"brief": "again"})
    assert second.is_error and second.text.endswith(tools.hint("start_orientation-running"))


@pytest.mark.parametrize("why", ["no-module", "not-launched", "plan"])
async def test_start_orientation_is_refused_without_the_module_in_plan_mode_or_unlaunched(bridge, models,
                                                                                        workspaces_tmp, monkeypatch,
                                                                                        why):
    from app import cc_plugin, session

    if why == "no-module":
        bridge.is_live, bridge.reason = False, "Claude Code did not load thimble's hooks module"
    elif why == "not-launched":
        monkeypatch.setattr(cc_plugin, "main_fenced", lambda c: False, raising=False)
    else:
        monkeypatch.setattr(session, "main_mode", lambda c: "plan")
    res = await tools.call(CORPUS, "start_orientation", {"brief": ""})
    assert res.is_error
    want = {"no-module": "NO MODULE: Claude Code did not load thimble's hooks module", "not-launched": "NOT LAUNCHED",
            "plan": "PLAN MODE"}[why]
    assert res.text.endswith(want), res.text
    assert orientation.read_run(CORPUS) is None, "the analyst typed it and reads main's answer"


async def test_settings_of_earlier_builds_load_and_change_nothing(bridge, models, workspaces_tmp):
    default = ledger.get_settings(CORPUS)
    (config.workspace_dir(CORPUS) / "settings.json").write_text(json.dumps({"terminal_first": False, "hide_chat": True}))
    assert ledger.get_settings(CORPUS) == default
    assert not (await tools.call(CORPUS, "start_orientation", {"brief": ""})).is_error


async def test_once_an_orientation_ended_only_the_analyst_s_message_starts_another(bridge, models, workspaces_tmp):
    from app.ledger import write_json

    orientation.run_file(CORPUS).parent.mkdir(parents=True, exist_ok=True)

    def ended() -> None:
        write_json(orientation.run_file(CORPUS), {"status": "done", "passes": ["final", "views"],
                                                  "started": "2026-10-06T03:30:00+00:00",
                                                  "ended": "2026-10-06T03:36:15+00:00", "chats": {"orient": "o1"}})

    ended()
    agents.mirror(CORPUS, "user", by=agents.TERMINAL, text="Start the orientation.", ts="2026-10-06T03:29:00.000+00:00")
    res = await tools.call(CORPUS, "start_orientation", {})
    assert res.is_error and res.text.endswith(tools.hint("start_orientation-unasked")), res.text
    for by in (agents.TERMINAL, agents.BROWSER):
        ended()
        agents.mirror(CORPUS, "user", by=by, text="Orient again, on the moderators this time.")
        assert not (await tools.call(CORPUS, "start_orientation", {"brief": "the moderators"})).is_error, by


async def test_start_in_the_browser_spawns_through_the_module_with_the_gate_s_values(bridge, models, workspaces_tmp):
    ans = await orient_session.start(CORPUS, "the moderators", ["final", "views"], critique=False,
                                     values={"model": "opus", "effort": "xhigh"}, route=subagents.CLICK)
    assert ans.started
    [spawn] = bridge.ops("spawn")
    assert spawn["role"] == "orientation" and spawn["values"] == {"model": "claude-opus-5-5[1m]", "effort": "xhigh"}
    assert spawn["description"] == "orientation: the moderators"
    rec = orientation.read_run(CORPUS)
    assert rec["status"] == "running" and rec["agent_id"] == ans.agent_id and rec["route"] == "subagent"
    assert rec["started_by"] == "click" and rec["chats"]["orient"]
    meta = agents.read_meta(CORPUS, rec["chats"]["orient"])
    assert meta["route"] == "subagent" and meta["agent_id"] == ans.agent_id and meta["title"] == orientation.TITLE


async def test_a_start_refused_by_the_module_ends_the_record_refused_with_its_kind(bridge, models, workspaces_tmp):
    bridge.answers.append({"deny": "PreToolUse:Agent hook error: An orientation is already running."})
    ans = await orient_session.start(CORPUS, "", ["final"], route=subagents.CLICK)
    assert ans.kind == "hook"
    rec = orientation.read_run(CORPUS)
    assert rec["status"] == "refused" and rec["refused"]["kind"] == "hook" and "already running" in rec["refused"]["reason"]
    bridge.is_live = False
    orientation.run_file(CORPUS).unlink()
    refused = await orient_session.start(CORPUS, "", ["final"], route=subagents.CLICK)
    assert refused.kind == "no-module" and orientation.read_run(CORPUS)["refused"]["kind"] == "no-module"


async def test_start_it_starts_a_refused_typed_start_through_the_module(bridge, models, workspaces_tmp):
    inp = _input(await tools.call(CORPUS, "start_orientation", {"brief": "probe"}))
    rid = inp["prompt"].split("\n")[0]
    subagents.refuse(CORPUS, rid, "[Credential Exploration]", subagents.AUTO_MODE)
    rec = orientation.read_run(CORPUS)
    assert rec["status"] == "refused"
    assert (rec["refused"]["kind"], rec["refused"]["reason"]) == ("auto-mode", "[Credential Exploration]")
    ans = await subagents.start_it(CORPUS, rid)
    assert ans.started and bridge.ops("spawn")[0]["prompt"] == inp["prompt"]


# --------------------------------------------------------------------------- follow-ups


async def _orientation() -> str:
    ans = await orient_session.start(CORPUS, "", ["final"], route=subagents.CLICK)
    return str(ans.agent_id)


async def test_message_orientation_gives_the_exact_send_message(bridge, models, workspaces_tmp, unmeasured):
    agent = await _orientation()
    await _ended(agent)
    res = await tools.call(CORPUS, "message_orientation", {"message": "And April?"})
    assert not res.is_error and res.text.endswith(f"SEND TO {agent}\nAnd April?")
    [r] = [r for r in subagents.read(CORPUS)["requests"].values() if r["kind"] == "message"]
    assert r["input"] == {"to": agent, "message": "And April?"} and r["route"] == "typed"


async def test_a_browser_follow_up_goes_through_the_module(bridge, models, workspaces_tmp, analyst, unmeasured):
    agent = await _orientation()
    await _ended(agent)
    out = await orient_session.message_route(CORPUS, orient_session.MessageBody(text="And May?"), analyst)
    assert out["status"] == "sent"
    [send] = bridge.ops("send")
    assert send["agent"] == agent and send["text"] == "And May?"
    chat = orientation.read_run(CORPUS)["chats"]["orient"]
    _, log = agents.paths(CORPUS, chat)
    assert any(e.get("type") == "user" and e.get("text") == "And May?" for e in agents.read_events(log))


async def test_a_follow_up_to_an_earlier_version_s_or_session_s_orientation_is_refused(bridge, models, workspaces_tmp,
                                                                                      analyst, unmeasured):
    from app import session

    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, session="s0")["id"]
    orientation.started(CORPUS, chat, passes=["final"])
    with pytest.raises(HTTPException) as e:
        await orient_session.message_route(CORPUS, orient_session.MessageBody(text="hi"), analyst)
    assert e.value.status_code == 410 and e.value.detail == HINTS["orient-continue-earlier-version"]
    res = await tools.call(CORPUS, "message_orientation", {"message": "hi"})
    assert res.is_error and res.text.endswith(HINTS["orient-continue-earlier-version"])
    agents.finish_agent(CORPUS, chat, "done")
    orientation.finished(CORPUS, chat, "done", "Done.", report=False)
    agent = await _orientation()
    with subagents.update(CORPUS) as state:
        sf.registry(state)[agent]["sessions"] = ["11111111-1111-4111-8111-111111111111"]
    await _ended(agent)
    session._live[CORPUS] = session.Live(CORPUS, "22222222-2222-4222-8222-222222222222", "/c", None, None)
    try:
        with pytest.raises(HTTPException) as e:
            await orient_session.message_route(CORPUS, orient_session.MessageBody(text="hi"), analyst)
        assert e.value.status_code == 409
        assert e.value.detail == "EARLIER SESSION: thimble -r 11111111-1111-4111-8111-111111111111", "the full id"
    finally:
        session._live.pop(CORPUS, None)


async def test_a_follow_up_in_plan_mode_is_refused(bridge, models, workspaces_tmp, monkeypatch, unmeasured):
    from app import session

    agent = await _orientation()
    await _ended(agent)
    monkeypatch.setattr(session, "main_mode", lambda c: "plan")
    res = await tools.call(CORPUS, "message_orientation", {"message": "hi"})
    assert res.is_error and res.text.endswith("PLAN MODE")


# --------------------------------------------------------------------------- ends


async def test_the_end_of_the_first_run_tells_main_and_starts_the_report_s_writer(bridge, models, workspaces_tmp,
                                                                                monkeypatch):
    import asyncio

    from app import report_types

    told: list[tuple] = []
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: told.append((kind, payload)))

    async def measured(c, chat):
        return ""

    monkeypatch.setattr(orient_session, "measure", measured)
    assert report_types.read_type(CORPUS, "report") is not None
    ans = await orient_session.start(CORPUS, "", ["final", "report"], route=subagents.CLICK)
    subagents.run_ended(CORPUS, ans.agent_id, "done", "Done.", source="handback")
    for _ in range(100):
        if len(bridge.ops("spawn")) > 1:
            break
        await asyncio.sleep(0.02)
    assert told and told[0][0] == orientation.ORIENT_KIND and told[0][1]["status"] == "done"
    rec = orientation.read_run(CORPUS)
    assert rec["status"] == "done" and rec["report_asked"] is True
    writer = bridge.ops("spawn")[-1]
    assert writer["role"] == "writer" and writer["what"] == "report"
    w = list(subagents.agents_of(CORPUS, "writer").values())[-1]
    assert subagents.request(CORPUS, w["request"])["route"] == "follow-on"
    assert agents.read_meta(CORPUS, w["chat"])["orient"] == rec["chats"]["orient"]


async def test_a_run_the_analyst_stopped_stops_its_views_and_asks_for_no_report(bridge, models, workspaces_tmp,
                                                                              monkeypatch):
    from app import dev

    stopped: list[str] = []
    monkeypatch.setattr(dev, "stop_orientation_views", lambda c: stopped.append(c) or [])
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: None)
    ans = await orient_session.start(CORPUS, "", ["final", "report"], route=subagents.CLICK)
    subagents.mark_stopped_by(CORPUS, ans.agent_id, subagents.STOPPED_ANALYST)
    subagents.run_ended(CORPUS, ans.agent_id, "stopped", "", source="notification")
    assert stopped == [CORPUS] and orientation.read_run(CORPUS)["status"] == "stopped"
    assert len(bridge.ops("spawn")) == 1, "no report pass"


async def test_a_workspace_0_5_0_left_loads_lists_and_renders_and_its_orientation_takes_no_message(
        bridge, models, workspaces_tmp, analyst, monkeypatch):
    """A workspace thimble 0.5.0 left: its orientation ran as a background session of Claude Code's (`bg` on the meta,
    bg-sessions.json, tray.json). The server's start stops that session once and closes the chat as an earlier
    version's; the chat still lists and renders, and a message to it gets the earlier-version 410."""
    from fastapi.testclient import TestClient

    from app import main

    ws = config.workspace_dir(CORPUS)
    sid = "0a5e0000-0000-4000-8000-000000000050"
    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, session=sid, background=True, bg="b50c2d3",
                            pid=2 ** 22 + 7)["id"]
    _, log = agents.paths(CORPUS, chat)
    agents.append(log, {"type": "assistant", "text": "Surveyed 40 files."})
    orientation.started(CORPUS, chat, passes=["final"])
    (ws / subagents.OLD_BG_FILE).write_text(json.dumps([{"short": "b50c2d3", "chat": chat}]))
    (ws / "tray.json").write_text(json.dumps({"entries": [{"name": "orient", "short": "b50c2d3"}]}))
    stopped: list[str] = []
    monkeypatch.setattr(subagents, "_stop_background", stopped.append)
    assert await subagents.recover_old() == [f"{CORPUS}/{chat}"]
    assert stopped == ["b50c2d3"], "stopped once, its conversation kept"
    assert await subagents.recover_old() == [] and stopped == ["b50c2d3"]
    meta = agents.read_meta(CORPUS, chat)
    assert meta["status"] == "stopped" and meta["continue"] == subagents.EARLIER_VERSION and not meta.get("bg")
    client = TestClient(main.create_app())
    assert chat in [m["id"] for m in client.get(f"/api/ws/{CORPUS}/chats").json()]
    r = client.get(f"/api/ws/{CORPUS}/chats/{chat}")
    assert r.status_code == 200 and "Surveyed 40 files." in r.text
    with pytest.raises(HTTPException) as e:
        await orient_session.message_route(CORPUS, orient_session.MessageBody(text="And May?"), analyst)
    assert e.value.status_code == 410 and e.value.detail == HINTS["orient-continue-earlier-version"]
    res = await tools.call(CORPUS, "message_orientation", {"message": "And May?"})
    assert res.is_error and res.text.endswith(HINTS["orient-continue-earlier-version"])
    assert not bridge.calls


async def test_the_browser_reads_the_orientation_s_record_a_refused_start_with_its_kind(bridge, models, workspaces_tmp):
    """GET /ws/{c}/orientation: {} before any orientation, then the record the Start gate and its card read: a refused
    start with its request, switches, model, effort and {reason, kind}."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.get(f"/api/ws/{CORPUS}/orientation").json() == {}
        orientation.start_requested(CORPUS, {"text": "the moderators", "passes": ["final", "report"], "critique": True,
                                             "model": "claude-sonnet-5", "effort": "high", "request": "r1",
                                             "started_by": "typed"})
        orientation.refuse(CORPUS, "[Auto-Mode Bypass]", subagents.AUTO_MODE, request="r1")
        got = client.get(f"/api/ws/{CORPUS}/orientation").json()
    assert (got["status"], got["query"], got["passes"], got["critique"]) == ("refused", "the moderators", ["final", "report"], True)
    assert (got["model"], got["effort"], got["started_by"], got["request"]) == ("claude-sonnet-5", "high", "typed", "r1")
    assert {k: got["refused"][k] for k in ("reason", "kind", "request")} == {"reason": "[Auto-Mode Bypass]", "kind": "auto-mode", "request": "r1"}
    assert set(got) <= set(orient_session.RUN_FIELDS)
