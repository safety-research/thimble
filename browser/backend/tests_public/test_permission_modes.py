"""Each agent's permission mode (modes.py), a job's Auto mode and the hook's route (agent_session, permissions;
permission_hook.py). An agent runs in its row of the settings, else in the mode Claude Code reports to main's hooks.
Auto is Claude Code's own auto mode: a call it refuses never reaches a PermissionRequest hook, so its PermissionDenied
hook brings the call to the card, where it waits for the analyst like any request. The hook's route answers for the
session its shim names. The sessions are hosted ones (agent_session.host), as a code ticket's are."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from conftest import card_wait

from app import agent_session, agents, config, events, ledger, modes, session, userconf

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


def test_bypass_runs_a_job_only_when_the_analyst_chose_it_in_settings(fake, analyst):
    """Bypass for the dev row's jobs only by the analyst's choice in Settings, which bypass.json records (modes.choose,
    from the settings PUT, a write only the analyst's browser makes): "bypass" written into thimble's config alone
    counts as Manual, and a main that reports Bypass gives the rows that follow it Manual."""
    cwd = str(config.corpus_dir(CORPUS))
    session.attach(CORPUS, "sid-main", cwd)
    session.note_mode(CORPUS, "sid-main", "bypassPermissions")
    assert modes.mode_for(CORPUS, "dev") == "manual", "main in Bypass: the row that follows it runs in Manual"
    session.note_mode(CORPUS, "sid-main", "auto")
    assert modes.mode_for(CORPUS, "dev") == "auto"
    userconf.global_file().parent.mkdir(parents=True, exist_ok=True)
    userconf.global_file().write_text(json.dumps({"agents": {"dev": {"permissionMode": "bypass"}}}))
    assert userconf.mode_rows(CORPUS) == {"dev": "bypass"} and modes.chosen() == set()
    assert modes.mode_for(CORPUS, "dev") == "manual" and modes.rows(CORPUS) == {"dev": "manual"}, \
        "written into the config by hand: Manual"
    modes.choose({"dev": "bypass"})
    assert modes.chosen() == {"dev"} and modes.mode_for(CORPUS, "dev") == "bypass"
    record = userconf.bypass_file()
    assert json.loads(record.read_text())["rows"] == ["dev"] and record.stat().st_mode & 0o777 == 0o600
    modes.choose({"dev": "manual"})
    assert modes.chosen() == set() and modes.mode_for(CORPUS, "dev") == "manual"
    modes.choose({"views": "bypass", "writer": "bypass"})
    assert modes.chosen() == {"dev"}, "an earlier build's row is the dev agent's; a row of no job is no choice"
    modes.choose({"dev": None})
    assert modes.chosen() == set()
    record.unlink()
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"dev": "bypass"}})
    assert json.loads(record.read_text())["rows"] == ["dev"], "the analyst's PUT records the choice"
    assert modes.mode_for(CORPUS, "dev") == "bypass"
    ledger.put_settings_route(CORPUS, analyst, {modes.SETTING: {"dev": None}})
    assert json.loads(record.read_text())["rows"] == [] and modes.mode_for(CORPUS, "dev") == "auto"
