"""Each agent's permission mode (modes.py): an agent runs in its row of the settings, else in main's mode. The
sessions are hosted ones (agent_session.host), as a code ticket's are."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import agent_session, agents, events, ledger, modes, session, userconf

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


def test_bypass_runs_a_job_only_when_the_analyst_chose_it_in_settings(fake, analyst):
    """Bypass for the dev row's jobs only by the analyst's choice in Settings, which bypass.json records (modes.choose,
    from the settings PUT, a write only the analyst's browser makes): "bypass" written into thimble's config alone
    counts as Manual."""
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
    assert json.loads(record.read_text())["rows"] == [] and modes.mode_for(CORPUS, "dev") == "manual"
