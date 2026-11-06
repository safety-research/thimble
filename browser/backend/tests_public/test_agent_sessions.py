"""The permission requests of a code ticket's session, which the server hosts on the job's chat card
(agent_session.host): Manual waits for the analyst for the card's wait, Bypass grants, and an edit of thimble's config
waits for the analyst in every mode."""
from __future__ import annotations

import asyncio
import json
import sys

import pytest
from conftest import card_wait

from app import agent_session, agents, cc_plugin, config, userconf

CORPUS = "mini"
KEY = "dev:t1"


@pytest.fixture()
def hosted(workspaces_tmp, monkeypatch):
    """A job's session of the dev agent hosted on a chat, as dev.py hosts a code ticket's (agent_session.host), with
    the fence's sandbox not required."""
    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    chat = str(agents.new_agent(CORPUS, "dev", "Ticket t1")["id"])
    run = agent_session.host(CORPUS, KEY, chat, agent="dev", conf=userconf.session(CORPUS, "dev", sandbox=False))
    yield run
    agent_session.unhost(CORPUS, KEY)


async def _pending(chat: str, n: int = 1) -> list[dict]:
    """The chat's pending permission requests once it has `n`."""
    for _ in range(200):
        ps = agents.read_meta(CORPUS, chat).get("permissions") or []
        if len(ps) >= n:
            return ps
        await asyncio.sleep(0.02)
    raise AssertionError(f"fewer than {n} requests on the chat")


def _ask(tool: str, inp: dict, agent_id: str | None = None, key: str = KEY) -> "asyncio.Future":
    return asyncio.ensure_future(agent_session.ask(CORPUS, key, tool, inp, agent_id=agent_id))


async def test_manual_waits_for_the_analyst_for_the_card_s_wait(hosted, analyst):
    """Manual is Claude Code's manual mode: each request waits on the job's card, with the agent that asked, until the
    analyst answers or the card's wait passes, ten minutes with no `cardWait` in thimble's config; once `cardWait` is
    set, an unanswered request is declined after that wait and stays on the card saying so until dismissed."""
    assert hosted.mode == "manual"
    inp = {"command": "touch notes.md", "description": "Create notes.md"}
    call = _ask("Bash", inp, agent_id="a1")
    [p] = await _pending(hosted.chat)
    assert (p["tool"], p["what"], p["agent_id"]) == ("Bash", "Create notes.md", "a1") and "touch notes.md" in p["input"]
    await asyncio.sleep(0.2)
    assert not call.done() and p["wait_s"] == 600, "the default card wait, ten minutes"
    answer = agent_session.PermissionAnswer(id=p["id"], allow=True)
    assert (await agent_session.permission_route(CORPUS, hosted.chat, answer, analyst))["allow"]
    assert await call == {"behavior": "allow", "updatedInput": inp}
    call = _ask("Write", {"file_path": "x"})
    [p] = await _pending(hosted.chat)
    agent_session.answer(CORPUS, hosted.chat, p["id"], False)
    assert await call == {"behavior": "deny", "message": agent_session.DENIED_LINE}
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert [(r["event"], r.get("tool"), r.get("answer")) for r in log] == [
        ("asked", "Bash", None), ("answered", None, "allow"), ("asked", "Write", None), ("answered", None, "deny")]
    assert log[0]["agent_id"] == "a1" and log[0]["chat"] == hosted.chat and log[0]["session"] == KEY
    assert await agent_session.ask(CORPUS, "dev:other", "Bash", inp) == {"behavior": "deny",
                                                                       "message": agent_session.GONE_LINE}
    assert card_wait(0.001) == 0.06
    assert await agent_session.ask(CORPUS, KEY, "Bash", inp) == {
        "behavior": "deny", "message": agent_session.timed_out_line(0.06)}
    [expired] = agents.read_meta(CORPUS, hosted.chat)["permissions"]
    assert expired["expired"] and expired["tool"] == "Bash" and expired["wait_s"] == 0.06
    assert agent_session.answer(CORPUS, hosted.chat, expired["id"], False), "Dismiss takes it off"
    assert agents.read_meta(CORPUS, hosted.chat)["permissions"] == []


async def test_bypass_grants_every_request(hosted):
    hosted.mode = "bypass"
    assert await agent_session.ask(CORPUS, KEY, "Bash", {"command": "rm -r out"}) == {
        "behavior": "allow", "updatedInput": {"command": "rm -r out"}}
    assert not agents.read_meta(CORPUS, hosted.chat).get("permissions"), "nothing reached the card"


async def test_an_edit_of_thimble_s_config_waits_for_the_analyst_in_bypass_and_runs_on_their_allow(hosted):
    """An edit of thimble's config, the file in thimble's home or the workspace's, is asked about in every mode,
    Bypass included: the card names the config as the reason, and the edit runs once the analyst allows it."""
    hosted.mode = "bypass"
    edit = {"file_path": str(userconf.global_file()), "old_string": "a", "new_string": "b"}
    assert hosted.config.verdict("Edit", edit) == "ask" and hosted.config.may_ask()
    held = _ask("Edit", edit)
    pending = await _pending(hosted.chat)
    assert [p.get("asked_by") for p in pending] == ["config"]
    await asyncio.sleep(0.1)
    assert not held.done(), "Bypass does not allow it"
    assert agent_session.answer(CORPUS, hosted.chat, pending[0]["id"], True)
    assert (await held)["behavior"] == "allow"


RULE = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test *"}], "behavior": "allow",
        "destination": "localSettings"}


async def test_no_don_t_ask_again_on_the_card_under_the_managed_rules_only_key(hosted, tmp_path, monkeypatch):
    """Where the org's managed tier sets allowManagedPermissionRulesOnly, Claude Code ignores the rules a session saves
    and its own dialog offers no "don't ask again", so the card offers none, neither Claude Code's suggestions nor a web
    rule for the workspace, as main's card offers none (test_relayed_permissions); its Always then allows once."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setitem(cc_plugin.MANAGED_DIRS, sys.platform, tmp_path / "managed")  # the machine's own is not read
    tier = tmp_path / "managed" / cc_plugin.MANAGED_FILE
    tier.parent.mkdir(parents=True)
    npm = {"command": "npm test", "description": "Run the tests"}
    fetch = {"url": "https://vega.github.io/vega-lite/", "prompt": "What encodings are there?"}

    async def card(tool: str, inp: dict, suggestions: list | None = None) -> tuple[asyncio.Future, dict]:
        call = asyncio.ensure_future(agent_session.ask(CORPUS, KEY, tool, inp, suggestions=suggestions))
        [p] = await _pending(hosted.chat)
        return call, p

    for managed_only in (True, False):
        tier.write_text(json.dumps({"allowManagedPermissionRulesOnly": managed_only}))
        call, p = await card("Bash", npm, [RULE])
        assert ("always" in p) is not managed_only
        assert agent_session.answer(CORPUS, hosted.chat, p["id"], True, always=True)
        assert ("updatedPermissions" in await call) is not managed_only
        call, p = await card("WebFetch", fetch)
        assert ("keep" in p) is not managed_only
        assert agent_session.answer(CORPUS, hosted.chat, p["id"], True)
        assert (await call)["behavior"] == "allow"
