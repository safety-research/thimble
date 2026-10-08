"""Each agent's permission mode (modes.py), a job's Auto mode and the hook's route (agent_session, permissions;
permission_hook.py). An agent runs in its row of the settings, else in the mode Claude Code reports to main's hooks.
Auto is Claude Code's own auto mode: a call it refuses never reaches a PermissionRequest hook, so its PermissionDenied
hook brings the call to the card, where it waits for the analyst like any request. The hook's route answers for the
session its shim names. The sessions are hosted ones (agent_session.host), as a code ticket's are."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from conftest import card_wait
from fastapi import HTTPException

from app import (agent_session, agents, cc_plugin, config, events, ledger, modes, orient_session, session, subagents, tools,
                 userconf)

CORPUS = "mini"
KEY = "dev:t1"

@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    session._live.clear()
    session._expected.clear()
    events._subs.clear()
    agent_session._hosted.clear()
    yield
    events._subs.clear()
    for key in [k for (_, k) in list(agent_session._hosted)]:
        agent_session.unhost(CORPUS, key)


@pytest.fixture()
def fake(tmp_path, monkeypatch) -> Path:
    """The Claude Code config dir of the test, with the fence's sandbox not required."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    return tmp_path / "fake"


def _hosted(mode: str) -> agent_session.Run:
    """A job's session hosted on a chat in `mode`, as dev.py hosts a code ticket's (agent_session.host)."""
    chat = str(agents.new_agent(CORPUS, "dev", "Ticket t1")["id"])
    run = agent_session.host(CORPUS, KEY, chat, agent="dev", conf=userconf.session(CORPUS, "dev", sandbox=False))
    run.mode = mode
    return run


async def _pending(chat: str, n: int = 1) -> list[dict]:
    """The chat's pending permission requests once it has `n`."""
    for _ in range(200):
        ps = agents.read_meta(CORPUS, chat).get("permissions") or []
        if len(ps) >= n:
            return ps
        await asyncio.sleep(0.02)
    raise AssertionError(f"fewer than {n} requests on the chat")


# ----------------------------------------------------------------------------- each agent's mode


async def test_each_agent_runs_in_its_row_else_in_main_s_mode_and_nothing_else_picks_one(fake, monkeypatch, analyst):
    """Every agent runs in the mode Claude Code reports to main's hooks, but the code tickets, whose row the analyst may
    set in Settings; the rows earlier builds had for the other agents are taken and ignored. No settings file, neither
    the corpus folder's nor the analyst's, chooses one, nor main's meta; start_orientation has no mode to give; and a
    mode the analyst's or the org's Claude Code settings turn off is refused and never used."""
    cwd = config.corpus_dir(CORPUS)
    (cwd / ".claude").mkdir(exist_ok=True)
    (cwd / ".claude" / "settings.json").write_text(json.dumps({"permissions": {"defaultMode": "bypassPermissions"}}))
    user = fake.parent / "claude-config" / "settings.json"
    user.parent.mkdir(parents=True, exist_ok=True)
    user.write_text(json.dumps({"permissions": {"defaultMode": "auto"}}))
    assert modes.mode_for(CORPUS, "orient") == "manual", "before main reports its mode: Manual"
    session._live[CORPUS] = session.Live(CORPUS, "sid-main", str(cwd), None, None)
    agents.write_meta(CORPUS, {**agents.ensure_main(CORPUS), "attached": {"session": "sid-main",
                                                                          "permission_mode": "bypassPermissions"}})
    assert modes.mode_for(CORPUS, "orient") == "manual", "a mode written into main's meta is no report"

    async def report(sid: str, mode: str) -> None:
        await events.mode_route(events.ModeBody(cwd=str(cwd), session=sid, permission_mode=mode))

    await report("sid-other", "bypassPermissions")
    assert modes.mode_for(CORPUS, "writer") == "manual", "another session's mode is not main's"
    await report("sid-main", "auto")
    assert [modes.mode_for(CORPUS, a) for a in modes.AGENTS] == ["auto"] * len(modes.AGENTS)
    assert modes.AGENTS == ("dev",)
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"checks": "bypass", "writer": "manual", "dev": "bypass"}})
    assert (modes.mode_for(CORPUS, "checks"), modes.mode_for(CORPUS, "writer"), modes.mode_for(CORPUS, "dev")) == \
        ("auto", "auto", "bypass"), "an earlier build's rows are taken and ignored"
    assert ledger.get_settings(CORPUS)[modes.SETTING] == {"dev": "bypass"}
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"views": "manual"}})
    assert modes.mode_for(CORPUS, "dev") == modes.mode_for(CORPUS, "views") == "manual", "view builds' old row is the dev agent's"
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"dev": None}})
    assert modes.mode_for(CORPUS, "dev") == "auto", "a row put back follows main again"

    assert "permissions" not in tools.schema_of("start_orientation")["properties"]
    seen: dict = {}

    async def fake_start(c, brief, passes, **kw):
        seen.update(kw)
        return subagents.refusal(subagents.HOOK, "stand-in")

    monkeypatch.setattr(orient_session, "start", fake_start)
    await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": "bypass"})
    assert "permissions" not in seen and "mode" not in seen, "a model's call chooses no mode"

    user.write_text(json.dumps({"permissions": {"disableBypassPermissionsMode": "disable"}}))
    with pytest.raises(HTTPException) as e:
        ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"dev": "bypass"}})
    assert e.value.status_code == 400 and "Bypass" in e.value.detail
    report_mode = session.note_mode
    report_mode(CORPUS, "sid-main", "bypassPermissions")
    assert modes.mode_for(CORPUS, "checks") == "manual", "a Bypass turned off is not used"
    report_mode(CORPUS, "sid-main", "auto")
    assert ledger.get_settings(CORPUS)["disabled_modes"] == ["bypass"]
    user.write_text("{}")
    remote = user.parent / "remote-settings.json"
    remote.write_text(json.dumps({"disableAutoMode": "disable", "permissions": {"disableBypassPermissionsMode": "disable"}}))
    assert modes.disabled() == {"auto", "bypass"}, "the org's server-managed settings"
    remote.unlink()
    managed = fake.parent / "managed"
    (managed / "managed-settings.d").mkdir(parents=True)
    monkeypatch.setitem(cc_plugin.MANAGED_DIRS, sys.platform, managed)
    (managed / "managed-settings.json").write_text(json.dumps({"permissions": {"disableBypassPermissionsMode": "disable"}}))
    (managed / "managed-settings.d" / "auto.json").write_text(json.dumps({"permissions": {"disableAutoMode": "disable"}}))
    assert modes.disabled() == {"auto", "bypass"}, "the managed file with its drop-ins"


def test_a_server_restarted_under_main_follows_its_last_reported_mode_until_main_reports_again(fake):
    """Main's reported mode is kept in thimble's home, not in memory alone: a server restarted under the same session
    gives each row that follows main that mode, and main's meta shows it, until main reports again. A new session, or one
    resumed after its end, starts from Manual, whatever it or an earlier session ran in."""
    cwd = str(config.corpus_dir(CORPUS))

    def restart() -> None:
        session._live.clear()
        session._modes.clear()

    session.attach(CORPUS, "sid-main", cwd)
    session.note_mode(CORPUS, "sid-main", "auto")
    assert modes.mode_for(CORPUS, "orient") == "auto"
    restart()
    session.attach(CORPUS, "sid-main", cwd)
    assert [modes.mode_for(CORPUS, a) for a in modes.AGENTS] == ["auto"] * len(modes.AGENTS), "the kept report"
    assert agents.read_meta(CORPUS, agents.MAIN_ID)["attached"]["permission_mode"] == "auto"
    kept = userconf.main_modes_file()
    assert kept.is_file() and f"Edit(/{kept})" in userconf.session(CORPUS, "orientation").settings()["permissions"]["deny"], \
        "no agent edits the mode the rows follow"
    session.note_mode(CORPUS, "sid-main", "default")
    assert modes.mode_for(CORPUS, "orient") == "manual", "main's next report wins"
    restart()
    session.attach(CORPUS, "sid-main", cwd)
    assert modes.mode_for(CORPUS, "orient") == "manual", "the newer report is the one kept"
    session.note_mode(CORPUS, "sid-main", "bypassPermissions")
    session.detach(CORPUS, "sid-main", "ended")
    session.attach(CORPUS, "sid-main", cwd)
    assert modes.mode_for(CORPUS, "orient") == "manual", "a session resumed after its end reports its mode again"
    session.detach(CORPUS, "sid-main", "ended")
    restart()
    session.attach(CORPUS, "sid-next", cwd)
    assert modes.mode_for(CORPUS, "orient") == "manual", "another session's mode is not main's"
    assert "permission_mode" not in agents.read_meta(CORPUS, agents.MAIN_ID)["attached"]


# ----------------------------------------------------------------------------- Auto


async def test_auto_is_claude_code_s_auto_mode_and_a_call_it_refuses_waits_for_the_analyst(fake, monkeypatch):
    """A job's session in Auto runs in Claude Code's auto mode, which decides each call; a call it refuses as risky
    comes to the card through the PermissionDenied hook with the reason and waits like a request. An allow is remembered
    for the call made again, which the hook before each call allows once, and a deny denies that call once. The allowed
    call shows as not run."""
    run = _hosted("auto")
    inp = {"command": "python3 -c 'print(6*7)'", "description": "Multiply"}
    body = dict(session=KEY, event="PermissionDenied", tool_name="Bash", tool_input=inp, agent_id="a2",
                tool_use_id="toolu_r1", reason="Runs code the analyst did not ask for")
    call = asyncio.ensure_future(agent_session.hook_request(CORPUS, agent_session.PermissionRequestBody(**body)))
    [p] = await _pending(run.chat)
    assert p["refused"] == "Runs code the analyst did not ask for" and p["agent_id"] == "a2"
    assert "rechecked" not in p and "deny_after_s" not in p, "a refusal auto mode judged is asked at once"
    assert p["wait_s"] == 600, "a request waits the card wait, ten minutes by default"
    await asyncio.sleep(0.2)
    assert not call.done(), "it waits for the analyst"
    agent_session.answer(CORPUS, run.chat, p["id"], True)
    assert (await call)["behavior"] == "allow"
    assert "toolu_r1" in session._not_run, "the refused call is made again"

    def pre(i: dict, agent: str | None = "a2") -> agent_session.PermissionRequestBody:
        return agent_session.PermissionRequestBody(session=KEY, event="PreToolUse", tool_name="Bash", tool_input=i,
                                                   agent_id=agent)

    assert await agent_session.hook_request(CORPUS, pre({"command": inp["command"]}, agent=None)) == {}, \
        "another agent"
    again = {**inp, "description": "Multiply six by seven"}
    assert await agent_session.hook_request(CORPUS, pre(again)) == {"behavior": "allow",
                                                                               "message": agent_session.ALLOWED_LINE}
    assert await agent_session.hook_request(CORPUS, pre(again)) == {}, "once"
    call = asyncio.ensure_future(agent_session.hook_request(
        CORPUS, agent_session.PermissionRequestBody(**{**body, "tool_use_id": "toolu_r2"})))
    [p] = await _pending(run.chat)
    agent_session.answer(CORPUS, run.chat, p["id"], False)
    assert (await call) == {"behavior": "deny", "message": agent_session.DENIED_LINE}
    assert "toolu_r2" not in session._not_run, "a denied call stays refused"
    assert await agent_session.hook_request(CORPUS, pre(inp)) == {"behavior": "deny",
                                                                             "message": agent_session.DENIED_LINE}


async def test_a_call_auto_mode_gave_no_safety_verdict_on_goes_back_to_it_then_waits_a_while(fake, monkeypatch):
    """Both ways Claude Code says auto mode gave no verdict are no refusal: the call goes back to auto mode, and only
    then does the card ask, denying it unanswered after the card wait rather than waiting for good."""
    monkeypatch.setattr(agent_session, "CLASSIFIER_WAITS_S", (0.01,))
    assert card_wait(0.004) == 0.24
    run = _hosted("auto")
    reasons = ("Classifier unavailable", "Auto mode unavailable — stopped after repeated responses with no safety verdict")
    for i, reason in enumerate(reasons, 1):
        body = agent_session.PermissionRequestBody(session=KEY, event="PermissionDenied", tool_name="Bash",
                                                   tool_input={"command": f"ls {i}"}, agent_id="a3",
                                                   tool_use_id=f"toolu_c{i}", reason=reason)
        assert (await agent_session.hook_request(CORPUS, body))["behavior"] == "allow", "back to auto mode"
        assert f"toolu_c{i}" in session._not_run
        call = asyncio.ensure_future(agent_session.hook_request(CORPUS, body))
        p = (await _pending(run.chat, i))[-1]
        assert p["refused"] == reason and p["deny_after_s"] == 0.24
        assert (await asyncio.wait_for(call, 5))["behavior"] == "deny"


async def test_the_hook_s_route_answers_for_the_session_its_shim_names(fake):
    _hosted("bypass")
    body = agent_session.PermissionRequestBody(session=KEY, tool_name="Bash", tool_input={"command": "ls"}, agent_id="a9")
    assert await agent_session.hook_request(CORPUS, body) == {"behavior": "allow",
                                                                         "updatedInput": {"command": "ls"}}
    other = agent_session.PermissionRequestBody(session="writer:report", tool_name="Bash", tool_input={"command": "ls"})
    assert (await agent_session.hook_request(CORPUS, other))["behavior"] == "deny", \
        "Bypass grants the hosted session's requests, never another session's"
