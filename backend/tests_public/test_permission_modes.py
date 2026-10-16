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
    with pytest.raises(HTTPException) as refused:
        ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"dev": "bypass"}})
    assert refused.value.status_code == 400 and modes.BYPASS_REFUSED in str(refused.value.detail), "D47: no Bypass"
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"checks": "bypass", "writer": "manual", "dev": "auto"}})
    assert (modes.mode_for(CORPUS, "checks"), modes.mode_for(CORPUS, "writer"), modes.mode_for(CORPUS, "dev")) == \
        ("auto", "auto", "auto"), "an earlier build's rows are taken and ignored"
    assert ledger.get_settings(CORPUS)[modes.SETTING] == {"dev": "auto"}
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"views": "manual"}})
    assert modes.mode_for(CORPUS, "dev") == modes.mode_for(CORPUS, "views") == "manual", "view builds' old row is the dev agent's"
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"dev": None}})
    assert modes.mode_for(CORPUS, "dev") == "auto", "a row put back follows main again"

    assert "permissions" not in tools.schema_of("start_orientation")["properties"]
    seen: dict = {}

    async def fake_start(c, brief, **kw):
        seen.update(kw)
        return subagents.refusal(subagents.HOOK, "stand-in")

    monkeypatch.setattr(orient_session, "start", fake_start)
    await tools.call(CORPUS, "start_orientation", {"brief": "", "permissions": "bypass"})
    assert seen, "the start was called"
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


async def test_main_s_terminal_says_once_per_session_that_main_runs_in_manual_mode_and_the_chip_follows_the_mode(
        fake, monkeypatch):
    """Only a mode main's hooks report counts: nothing is said before the first report. The first report of Manual mode
    in a session answers the mode hook with the line main's terminal shows (modes.manual_line: shift+tab, or `thimble
    --permission-mode auto`), and never again in that session; a new session hears it again. Main's meta carries the
    chip's hint (`attached.manual`) while main is in Manual mode only, not in auto, plan or Accept edits mode, nor for a
    mode note_plan only guesses. When the analyst's or the org's settings turn auto mode off, the line and the chip say
    who did, with no way to switch. A relayed permission request carries no such hint any more."""
    cwd = str(config.corpus_dir(CORPUS))
    session.attach(CORPUS, "sid-main", cwd)

    def attached() -> dict:
        return agents.read_meta(CORPUS, agents.MAIN_ID)["attached"]

    async def report(mode: str, sid: str = "sid-main") -> str | None:
        got = await events.mode_route(events.ModeBody(cwd=cwd, session=sid, permission_mode=mode))
        return got.get("terminal")

    switch = modes.MANUAL_LINES["switch"]
    assert "shift+tab" in switch and "`thimble --permission-mode auto`" in switch
    assert "manual" not in attached(), "nothing before main reports its mode"
    assert await report("auto") is None and "manual" not in attached()
    assert await report("acceptEdits") is None and "manual" not in attached(), "Accept edits is not Manual mode"
    assert await report("default") == switch and attached()["manual"] == "switch"
    assert await report("default") is None and await report("manual") is None, "once per session"
    assert attached()["manual"] == "switch"
    assert await report("default", sid="sid-other") is None, "another session's report says nothing"
    assert await report("auto") is None and "manual" not in attached(), "the chip goes with auto mode"
    assert await report("default") is None and attached()["manual"] == "switch"
    session._before_plan.clear()
    session.note_plan(CORPUS, "sid-main", True)
    assert "manual" not in attached(), "plan mode is not Manual mode"
    session.note_plan(CORPUS, "sid-main", False)
    assert attached()["permission_mode"] == "default" and "manual" not in attached(), \
        "the mode before plan mode is only a guess of the mode main left it for (shift+tab may pick auto): no chip"
    session.note_plan(CORPUS, "sid-main", True)
    session._before_plan.clear()
    session.note_plan(CORPUS, "sid-main", False)
    assert attached()["permission_mode"] == "default" and "manual" not in attached(), "a guess shows no chip"
    assert await report("default") is None and attached()["manual"] == "switch", "main's next report brings it back"
    events._hold(CORPUS, "r1", "Bash", "x", "{}", tool_input={"command": "ls"})
    [p] = agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"]
    assert "manual" not in p
    events._drop(CORPUS, {"r1"})

    session.detach(CORPUS, "sid-main", "ended")
    session.attach(CORPUS, "sid-next", cwd)
    user = fake.parent / "claude-config" / "settings.json"
    user.parent.mkdir(parents=True, exist_ok=True)
    user.write_text(json.dumps({"permissions": {"disableAutoMode": "disable"}}))
    assert modes.auto_off() == "settings"
    assert await report("default", sid="sid-next") == modes.MANUAL_LINES["settings"], "a new session hears it again"
    assert attached()["manual"] == "settings" and "shift+tab" not in modes.MANUAL_LINES["settings"]
    managed = fake.parent / "managed"
    managed.mkdir(parents=True)
    monkeypatch.setitem(cc_plugin.MANAGED_DIRS, sys.platform, managed)
    (managed / "managed-settings.json").write_text(json.dumps({"disableAutoMode": "disable"}))
    assert modes.auto_off() == "org" and modes.manual_line("default") == modes.MANUAL_LINES["org"]
    assert await report("default", sid="sid-next") is None and attached()["manual"] == "org"
    assert modes.manual_line("dontAsk") == modes.manual_line("bypassPermissions") == modes.manual_line(None) == ""


def test_a_server_restarted_under_main_keeps_the_chip_and_says_nothing_again(fake):
    """The chip's hint and the session's told mark live on main's meta, so a server restarted under the same session
    neither loses the chip nor shows the line again; a mode note_plan only guessed, which is kept for the restart too,
    shows no chip there either."""
    cwd = str(config.corpus_dir(CORPUS))

    def restart() -> dict:
        session._live.clear()
        session._modes.clear()
        session.attach(CORPUS, "sid-main", cwd)
        return agents.read_meta(CORPUS, agents.MAIN_ID)["attached"]

    session._before_plan.clear()
    session.attach(CORPUS, "sid-main", cwd)
    assert session.note_mode(CORPUS, "sid-main", "default", tell=True) == modes.MANUAL_LINES["switch"]
    held = restart()
    assert held["manual"] == "switch" and held["permission_mode"] == "default"
    assert session.note_mode(CORPUS, "sid-main", "default", tell=True) == ""
    session.note_plan(CORPUS, "sid-main", True)
    session.note_plan(CORPUS, "sid-main", False)
    held = restart()
    assert held["permission_mode"] == "default" and "manual" not in held, "the kept mode is a guess"


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


def test_bypass_is_refused_and_an_earlier_bypass_row_runs_as_manual(fake, analyst):
    """D47 (0.9.0): thimble makes no allow decision, so Bypass is not offered: the settings PUT refuses it, `refused`
    says why, modes.choose records no Bypass row, and a Bypass row an earlier build left (in thimble's config, or in
    Settings' record, bypass.json) runs as Manual. A main that reports Bypass gives the rows that follow it Manual."""
    cwd = str(config.corpus_dir(CORPUS))
    session.attach(CORPUS, "sid-main", cwd)
    session.note_mode(CORPUS, "sid-main", "bypassPermissions")
    assert modes.mode_for(CORPUS, "dev") == "manual", "main in Bypass: the row that follows it runs in Manual"
    session.note_mode(CORPUS, "sid-main", "auto")
    assert modes.mode_for(CORPUS, "dev") == "auto"
    assert modes.refused("bypass") == modes.BYPASS_REFUSED and modes.refused("auto") is None
    userconf.global_file().parent.mkdir(parents=True, exist_ok=True)
    userconf.global_file().write_text(json.dumps({"agents": {"dev": {"permissionMode": "bypass"}}}))
    record = userconf.bypass_file()
    record.write_text(json.dumps({"rows": ["dev"]}))  # Settings' record of an earlier build
    assert userconf.mode_rows(CORPUS) == {"dev": "bypass"} and modes.chosen() == set()
    assert modes.mode_for(CORPUS, "dev") == "manual" and modes.rows(CORPUS) == {"dev": "manual"}
    modes.choose({"dev": "bypass"})
    assert json.loads(record.read_text())["rows"] == [] and record.stat().st_mode & 0o777 == 0o600, \
        "the record refuses the row: none runs in Bypass"
    assert modes.chosen() == set() and modes.mode_for(CORPUS, "dev") == "manual"
    with pytest.raises(HTTPException):
        ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"dev": "bypass"}})
    assert modes.mode_for(CORPUS, "dev") == "manual"


def test_the_manual_mode_notice_says_how_to_switch_or_who_turned_auto_mode_off(fake, monkeypatch):
    """The `manual-mode` notice's words (modes.manual_notice), by who turns auto mode off; none outside Manual mode.
    Each says that thimble's agents wait in the terminal, where Claude Code asks their prompts, so an agent that waits
    there does not look as if it worked on."""
    asks = ("Manual mode: Claude Code asks before most commands, and thimble's agents wait in your terminal until you "
            "answer there.")
    monkeypatch.setattr(modes, "auto_off", lambda: "")
    assert modes.manual_notice("default") == (f"{asks} In your terminal, press shift+tab for auto mode, or start with "
                                              "`thimble --permission-mode auto`.")
    assert modes.manual_notice("auto") == modes.manual_notice("acceptEdits") == modes.manual_notice(None) == ""
    monkeypatch.setattr(modes, "auto_off", lambda: "org")
    assert modes.manual_notice("default") == f"{asks} Your organization turned auto mode off."
    monkeypatch.setattr(modes, "auto_off", lambda: "settings")
    assert modes.manual_notice("manual") == f"{asks} Your Claude Code settings turn auto mode off (disableAutoMode)."
