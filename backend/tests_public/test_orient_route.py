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
    assert ans["chat"] == rec["chats"]["orient"], "the answer names its thread, which the browser opens (live check L1)"


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
    assert [e.get("run") for e in agents.read_events(log) if e.get("type") == "user" and e.get("text") == "And May?"] \
        == [1], "the message names the run it starts, as the browser cuts the thread into runs by it"


async def test_a_follow_up_run_is_main_s_card_for_that_run_and_keeps_who_sent_its_message(bridge, models,
                                                                                           workspaces_tmp, analyst,
                                                                                           unmeasured):
    """Each follow-up run puts the orientation's card for that run in main's chat (an `agent` record with its `run`,
    the browser's AgentCard `run`), and its record keeps the message that started it with who sent it: the browser
    through the module, or main's message_orientation; a message typed in the agent tray carries no request."""
    agent = await _orientation()
    await _ended(agent)
    await orient_session.message_route(CORPUS, orient_session.MessageBody(text="And May?"), analyst)
    [rid] = [k for k, r in subagents.read(CORPUS)["requests"].items() if r["kind"] == "message"]
    with subagents.update(CORPUS) as state:
        sf.requests(state)[rid].update(state="claimed")
    subagents.run_again(CORPUS, agent, "coordinator")
    subagents.run_ended(CORPUS, agent, "done", "May too.", source="handback")
    assert not (await tools.call(CORPUS, "message_orientation", {"message": "And June?"})).is_error
    rids = [k for k, r in subagents.read(CORPUS)["requests"].items() if r["kind"] == "message"]
    with subagents.update(CORPUS) as state:
        sf.requests(state)[rids[-1]].update(state="claimed")
    subagents.run_again(CORPUS, agent, "coordinator")
    subagents.run_ended(CORPUS, agent, "done", "June too.", source="handback")
    subagents.run_again(CORPUS, agent, "human")
    ups = orientation.read_run(CORPUS)["followups"]
    assert [(u["run"], u["messages"]) for u in ups] == [(1, [{"text": "And May?", "by": "browser"}]),
                                                         (2, [{"text": "And June?", "by": "main"}]), (3, [])]
    _, main_log = agents.paths(CORPUS, agents.MAIN_ID)
    chat = orientation.read_run(CORPUS)["chats"]["orient"]
    assert [(e["chat"], e["run"]) for e in agents.read_events(main_log) if e.get("type") == "agent" and e.get("run")] \
        == [(chat, 1), (chat, 2), (chat, 3)]


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


async def test_an_orientation_stopped_with_esc_takes_no_follow_up_and_says_to_start_a_new_one(bridge, models,
                                                                                            workspaces_tmp, analyst,
                                                                                            unmeasured):
    """Live check L9: after Esc in its agent view Claude Code resumes the orientation no more, and the browser showed its
    refusal with a Send again that could never work. The composer's message now gets thimble's text that it cannot be
    continued (410, as an earlier version's) and main's message_orientation the same, with nothing sent; when only
    Claude Code's answer to the send says so, that answer marks it the same way."""
    agent = await _orientation()
    await _ended(agent)
    bridge.answers.append({"error": f"Agent {agent} was stopped by the user and won't be resumed. Treat its work as "
                                    "cancelled; only launch a new agent if the user explicitly asks."})
    with pytest.raises(HTTPException) as e:
        await orient_session.message_route(CORPUS, orient_session.MessageBody(text="And May?"), analyst)
    assert e.value.status_code == 410 and e.value.detail == tools.hint("orient-continue-stopped-by-user")
    assert "Start a new orientation" in e.value.detail
    assert subagents.cancelled(CORPUS, agent)
    chips = [r for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1]) if r.get("type") == "chip"]
    assert not [r for r in chips if r.get("kind") == orient_session.NOT_PASSED_ON], \
        "no not-passed-on line with a Send again that cannot work (live recheck of L9)"
    sent = len(bridge.ops("send"))
    with pytest.raises(HTTPException) as e:
        await orient_session.message_route(CORPUS, orient_session.MessageBody(text="And June?"), analyst)
    assert e.value.status_code == 410
    res = await tools.call(CORPUS, "message_orientation", {"message": "And June?"})
    assert res.is_error and res.text.endswith(tools.hint("orient-continue-stopped-by-user"))
    assert len(bridge.ops("send")) == sent, "nothing more reaches the module"
    chat = orientation.read_run(CORPUS)["chats"]["orient"]
    assert agents.read_meta(CORPUS, chat)["continue"] == subagents.CANCELLED
    subagents.run_again(CORPUS, agent, "human")  # should Claude Code ever run it again, it takes messages again
    assert not subagents.cancelled(CORPUS, agent) and agents.read_meta(CORPUS, chat).get("continue") is None


MAIN_SID, EARLIER_SID = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"


async def test_an_extension_s_run_now_needs_an_orientation_main_s_session_reaches_and_goes_through_the_module(
        bridge, models, workspaces_tmp, unmeasured):
    """Settings offers Run now for an extension's orientation instructions only where a follow-up reaches the
    orientation (extensions.orientation_ran): one that ran as a subagent of main's own Claude Code session. One of an
    earlier session, or an earlier version's chat with no agent id, gets no offer. Run now sends the instructions to the
    orientation's agent through thimble's module (orient_session.send), as the analyst's click."""
    from app import extensions, session

    assert not extensions.orientation_ran(CORPUS), "no orientation ran here"
    agent = await _orientation()
    with subagents.update(CORPUS) as state:
        sf.registry(state)[agent]["sessions"] = [MAIN_SID]
    await _ended(agent)
    try:
        session._live[CORPUS] = session.Live(CORPUS, EARLIER_SID, "/c", None, None)
        assert not extensions.orientation_ran(CORPUS), "main is another session than the orientation's"
        session._live[CORPUS] = session.Live(CORPUS, MAIN_SID, "/c", None, None)
        assert extensions.orientation_ran(CORPUS)
        out = await orient_session.send(CORPUS, "Read every tally record.", orient_session.EXTENSION,
                                        extension="ext-min")
        assert out["status"] == "sent"
        [send] = bridge.ops("send")
        assert send["agent"] == agent and send["text"].endswith("Read every tally record.")
    finally:
        session._live.pop(CORPUS, None)
    chat = orientation.read_run(CORPUS)["chats"]["orient"]
    agents.update_agent(CORPUS, chat, route=None)
    assert not extensions.orientation_ran(CORPUS), "an earlier version ran it"


def test_the_release_test_s_stand_in_orientation_is_one_a_follow_up_reaches_only_from_its_own_session(workspaces_tmp):
    """scripts/e2e/release.mjs (ext-orient-offer) plants these two files for an orientation that ran as a subagent of
    main, and expects Settings' offer for main's session alone."""
    from app import extensions, session

    ws = config.workspace_dir(CORPUS)
    agent = "a0e2e5ad1fe0c0de1"

    def plant(sid: str) -> None:
        (ws / "orient").mkdir(exist_ok=True)
        (ws / "orient" / "run.json").write_text(json.dumps({"status": "done", "chats": {"orient": "e2e-standin"},
                                                            "agent_id": agent, "route": "subagent", "session": sid}))
        (ws / "chats").mkdir(exist_ok=True)
        (ws / "chats" / "e2e-standin.meta.json").write_text(json.dumps({
            "id": "e2e-standin", "kind": "agent", "role": "orient", "title": "Orientation", "status": "done",
            "route": "subagent", "agent_id": agent, "session": sid, "sessions": [sid]}))

    session._live[CORPUS] = session.Live(CORPUS, MAIN_SID, "/c", None, None)
    try:
        plant(EARLIER_SID)
        assert not extensions.orientation_ran(CORPUS)
        plant(MAIN_SID)
        assert extensions.orientation_ran(CORPUS)
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


SAFEGUARD = ("API Error: Opus 4.8's safeguards flagged this message. Our intentionally broad safeguards allow us to "
             "deliver more capabilities faster, but can sometimes flag legitimate cybersecurity work.")


async def test_an_orientation_an_api_error_stopped_says_so_and_why_in_its_thread_main_s_event_and_main_s_chat(
        bridge, models, workspaces_tmp, monkeypatch):
    """A refusal by the model's safeguards ends the orientation's first run before it made a card: the module's turn end
    says `refusal`, with Claude Code's error line. The run ends failed, and each place the analyst looks says that it
    stopped and why, in the API's words: its thread ends with a line that says so, the `orient` event main gets says it
    failed with the error, and main's chat gets the orientation's landing (which the browser shows as failed, with the
    API error's card) although there are no cards. No report pass starts."""
    told: list[tuple] = []
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: told.append((kind, payload)))
    ans = await orient_session.start(CORPUS, "", ["final", "report"], route=subagents.CLICK)
    chat = orientation.read_run(CORPUS)["chats"]["orient"]
    assert subagents.ended(CORPUS, ans.agent_id, SAFEGUARD, "refusal")

    rec = orientation.read_run(CORPUS)
    assert rec["status"] == "failed" and rec["error"] == SAFEGUARD[:400]
    [(kind, payload)] = told
    assert kind == orientation.ORIENT_KIND and payload["status"] == "failed"
    assert payload["text"].startswith("The orientation failed:") and payload["text"].endswith(f"Its error: {SAFEGUARD}")

    _, thread = agents.paths(CORPUS, chat)
    lines = agents.read_events(thread)
    assert lines[-2]["type"] == "error" and lines[-2]["kind"] == "failed" and lines[-2]["message"] == SAFEGUARD[:400]
    assert lines[-1] == {**lines[-1], "type": "chip", "kind": orient_session.ERROR_KIND,
                         "text": f"The orientation stopped because of an error: {SAFEGUARD}"}
    meta = agents.read_meta(CORPUS, chat)
    assert meta["status"] == "failed" and meta["result"] == SAFEGUARD[:400]

    _, main_log = agents.paths(CORPUS, agents.MAIN_ID)
    [landing] = [e for e in agents.read_events(main_log) if e.get("type") == "chip" and e.get("kind") == "artifact"]
    assert landing["chat"] == chat and "ref" not in landing, "the landing with no deck: there are no cards"
    assert len(bridge.ops("spawn")) == 1, "no report pass"

    # a follow-up the API error stops: its thread says the follow-up stopped, and why
    subagents.run_again(CORPUS, ans.agent_id, "coordinator")
    assert subagents.ended(CORPUS, ans.agent_id, "API Error: Repeated 529 Overloaded errors", "error")
    assert agents.read_events(thread)[-1]["text"] == ("The orientation's follow-up stopped because of an error: API "
                                                      "Error: Repeated 529 Overloaded errors")
    assert told[-1][1]["status"] == "failed" and told[-1][1]["text"].endswith("Repeated 529 Overloaded errors")


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
