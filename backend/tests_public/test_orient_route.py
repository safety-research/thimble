"""The orientation as a subagent of main (orient_session.py): a start by click (POST /ws/{c}/start) starts it through
thimble's module (a fake of lane M's bridge); main's start_orientation records the pending start and gives the exact
Agent call, with the request and the run's model and effort from its arguments or Settings, and no switch; neither
starts without the module, in plan mode, or in a session the launcher did not start. A follow-up goes through the module
from the browser and as main's exact SendMessage from the terminal; one to an orientation of an earlier session or
version is refused. The end of a run closes the record, tells main and tells thimble's view proposer; no report pass
starts, since a report is written only when the analyst asks."""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from app import agents, config, orient_session, orientation, subagents, tools
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
    res = await tools.call(CORPUS, "start_orientation", {"focus": "the moderators"})
    inp = _input(res)
    assert set(inp) == {"subagent_type", "description", "prompt"} and inp["subagent_type"] == "thimble:orientation"
    assert inp["description"] == "orientation: the moderators"
    rid = inp["prompt"].split("\n")[0]
    assert sf.REQUEST_RE.fullmatch(rid), "the request id on the prompt's first line"
    assert inp["prompt"] == f"{rid}\nREQUEST the moderators", "the run's prompt holds its request and nothing else"
    rec = orientation.read_run(CORPUS)
    assert (rec["status"], rec["route"], rec["started_by"], rec["request"]) == ("starting", "subagent", "typed", rid)
    assert (rec["model"], rec["effort"]) == ("claude-opus-5-5[1m]", "max") and rec["passes"] == ["final"]
    r = subagents.request(CORPUS, rid)
    assert r["values"] == {"model": "claude-opus-5-5[1m]", "effort": "max"} and r["route"] == "typed"
    assert not bridge.calls, "a typed start is main's call"


@pytest.mark.parametrize("why", ["no-module", "plan"])
async def test_start_orientation_is_refused_without_the_module_or_in_plan_mode(bridge, models, workspaces_tmp,
                                                                              monkeypatch, why):
    from app import session

    if why == "no-module":
        bridge.is_live, bridge.reason = False, "Claude Code did not load thimble's hooks module"
    else:
        monkeypatch.setattr(session, "main_mode", lambda c: "plan")
    res = await tools.call(CORPUS, "start_orientation", {"brief": ""})
    assert res.is_error
    want = {"no-module": "NO MODULE: Claude Code did not load thimble's hooks module", "plan": "PLAN MODE"}[why]
    assert res.text.endswith(want), res.text
    assert orientation.read_run(CORPUS) is None, "the analyst typed it and reads main's answer"


async def test_a_subagent_of_main_s_own_is_held_to_the_analyst_s_messages_to_main(bridge, models, workspaces_tmp,
                                                                                 monkeypatch):
    """U5: a subagent of main's own may call start_orientation, but the prompt its own chat holds is main's words, not
    the analyst's, so once an orientation ended it starts another only after the analyst's message to main."""
    from app import session
    from app.ledger import write_json

    monkeypatch.setattr(orient_session, "ASKED_WAIT_S", 0.05)
    orientation.run_file(CORPUS).parent.mkdir(parents=True, exist_ok=True)
    write_json(orientation.run_file(CORPUS), {"status": "done", "passes": ["final", "views"],
                                              "started": "2026-10-06T03:30:00+00:00",
                                              "ended": "2026-10-06T03:36:15+00:00", "chats": {"orient": "o1"}})
    agents.mirror(CORPUS, "user", by=agents.TERMINAL, text="Start the orientation.", ts="2026-10-06T03:29:00.000+00:00")
    gp = agents.new_agent(CORPUS, "agent", "general-purpose", parent=agents.MAIN_ID, by=agents.TERMINAL)
    agents.Recorder(CORPUS, gp["id"]).record("user", text="Orient on the moderators.", by=agents.TERMINAL)
    sf.add_caller(config.workspace_dir(CORPUS), "toolu_gp_start", "agp1", "general-purpose")
    monkeypatch.setattr(session, "chat_of_agent", lambda c, a: gp["id"] if a == "agp1" else None)
    res = await tools.call(CORPUS, "start_orientation", {}, tool_use_id="toolu_gp_start")
    assert res.is_error and res.text.endswith(tools.hint("start_orientation-unasked")), res.text
    agents.mirror(CORPUS, "user", by=agents.BROWSER, text="Orient again, on the moderators this time.")
    assert not (await tools.call(CORPUS, "start_orientation", {}, tool_use_id="toolu_gp_start")).is_error


async def test_a_start_by_click_spawns_through_the_module_with_its_values(bridge, models, workspaces_tmp):
    ans = await orient_session.start(CORPUS, "the moderators", values={"model": "opus", "effort": "xhigh"},
                                     route=subagents.CLICK)
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


# --------------------------------------------------------------------------- follow-ups


async def _orientation() -> str:
    ans = await orient_session.start(CORPUS, "", route=subagents.CLICK)
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


# --------------------------------------------------------------------------- ends


@pytest.fixture()
def proposer(monkeypatch):
    """thimble's view proposer with each trigger recorded (proposer.trigger): [(c, after)]."""
    from app import proposer as proposer_mod

    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(proposer_mod, "trigger", lambda c, after, **kw: calls.append((c, after)))
    return calls


async def test_the_end_of_the_first_run_tells_main_and_the_view_proposer_and_starts_no_report(
        bridge, models, workspaces_tmp, monkeypatch, proposer):
    """The first run ended done: main hears it, thimble's view proposer is told once (proposer.trigger, "orientation"),
    and no writer starts, since a report is written only when the analyst asks for one."""
    import asyncio

    told: list[tuple] = []
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: told.append((kind, payload)))

    async def measured(c, chat):
        return ""

    monkeypatch.setattr(orient_session, "measure", measured)
    ans = await orient_session.start(CORPUS, "", route=subagents.CLICK)
    subagents.run_ended(CORPUS, ans.agent_id, "done", "Done.", source="handback")
    for _ in range(100):
        if CORPUS not in orient_session._closing and told:
            break
        await asyncio.sleep(0.02)
    assert told and told[0][0] == orientation.ORIENT_KIND and told[0][1]["status"] == "done"
    rec = orientation.read_run(CORPUS)
    assert rec["status"] == "done" and "report_asked" not in rec
    assert proposer == [(CORPUS, "orientation")]
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
    ans = await orient_session.start(CORPUS, "", route=subagents.CLICK)
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
    orientation.started(CORPUS, chat)
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
