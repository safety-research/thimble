"""The permission requests of the `claude -p` sessions thimble still starts itself (agent_session.py): a code ticket's,
`thimble fix`'s and an extension's program's. Their permission hook hands each request to the server, which hosts it on
the job's chat card (agent_session.host): Manual waits for the analyst for the card's wait, Bypass grants, and an edit of
thimble's config waits for the analyst in every mode. The hook signs its request and believes only the server's proof.
thimble's own agents are subagents of main, whose requests the terminal answers (events.py, test_relayed_permissions)."""
from __future__ import annotations

import asyncio
import io
import json
import urllib.request

import pytest
from conftest import card_wait

from app import agent_session, agents, config, hook_auth, permission_hook, userconf

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


def test_a_job_s_session_asks_through_the_permission_hook_with_a_day_to_wait():
    """A job's settings carry the permission hook for PermissionRequest and PermissionDenied (a --permission-prompt-tool
    never hears a background agent's request), with a day to wait, told the workspace and the session's key; in auto
    mode also before each call."""
    hooks = agent_session.permission_hooks(CORPUS, False, session=KEY, home="/h")
    [hook] = hooks[agent_session.REQUEST][0]["hooks"]
    assert hooks[agent_session.REQUEST][0]["matcher"] == "*" and hook["timeout"] == permission_hook.TIMEOUT == 86_400
    assert "permission_hook.py" in hook["command"] and f"--ws {CORPUS} --session {KEY} --home /h" in hook["command"]
    assert hooks[agent_session.DENIED] == hooks[agent_session.REQUEST] and agent_session.PRE not in hooks
    auto = agent_session.permission_hooks(CORPUS, True, session=KEY)
    assert auto[agent_session.PRE][0]["hooks"][0]["timeout"] == permission_hook.PRE_TIMEOUT


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
    Bypass included: the card names the config as the reason, also from the hook before each call (auto mode's), and the
    edit runs once the analyst allows it."""
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
    write = {"file_path": str(userconf.workspace_file(CORPUS)), "content": "{}"}
    pre = asyncio.ensure_future(agent_session.hook_request(CORPUS, agent_session.PermissionRequestBody(
        session=KEY, event="PreToolUse", tool_name="Write", tool_input=write)))
    pending = await _pending(hosted.chat)
    assert [p.get("asked_by") for p in pending] == ["config"] and not pre.done()
    assert agent_session.answer(CORPUS, hosted.chat, pending[0]["id"], False)
    assert (await pre)["behavior"] == "deny"


RULE = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test *"}], "behavior": "allow",
        "destination": "localSettings"}


def test_the_permission_hook_hands_the_request_to_the_server_and_prints_its_decision(monkeypatch, capsys, tmp_path):
    """The hook signs its request with the token in server.json and believes only an answer that proves the server holds
    it too (app/hook_auth.py)."""
    sent: list[tuple[str, dict]] = []
    (tmp_path / "server.json").write_text(json.dumps({"port": 8311, "token": "tok"}))
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path))
    proof = {"ok": True}

    class Resp(io.BytesIO):
        def __init__(self, data: bytes, nonce: str) -> None:
            super().__init__(data)
            self.headers = {"X-Thimble-Proof": hook_auth.sign("tok", "server", nonce) if proof["ok"] else "forged"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    answer = {"behavior": "deny", "message": "Denied from thimble's browser."}

    def urlopen(req, timeout=None):
        nonce = req.get_header("X-thimble-nonce")
        assert req.get_header("X-thimble-auth") == hook_auth.sign("tok", "hook", nonce)
        sent.append((req.full_url, json.loads(req.data)))
        assert timeout == permission_hook.TIMEOUT
        return Resp(json.dumps(answer).encode(), nonce)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    monkeypatch.setenv("THIMBLE_SESSION", KEY)
    hook = {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"},
            "agent_id": "a1", "agent_type": "general-purpose", "session_id": "sid"}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0
    assert sent == [("http://127.0.0.1:8311/api/ws/mini/sessions/permission",
                     {"session": KEY, "event": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"},
                      "agent_id": "a1", "agent_type": "general-purpose"})]
    assert json.loads(capsys.readouterr().out) == {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                                                          "decision": answer}}
    proof["ok"] = False
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "an answer without the proof"
    proof["ok"] = True
    answer = {"behavior": "allow", "updatedInput": {"command": "ls"}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    permission_hook.main(["--ws", CORPUS])
    assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]["decision"] == {"behavior": "allow"}
    # Claude Code's "don't ask again" choices go to the server, and the ones the analyst chose come back in the decision
    updates = [{**RULE, "destination": "session"}]
    answer = {"behavior": "allow", "updatedInput": {"command": "ls"}, "updatedPermissions": updates}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({**hook, "permission_suggestions": [RULE]})))
    permission_hook.main(["--ws", CORPUS])
    assert sent[-1][1]["suggestions"] == [RULE]
    assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]["decision"] == {"behavior": "allow",
                                                                                     "updatedPermissions": updates}

    (tmp_path / "server.json").unlink()
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "no server: no decision"
    monkeypatch.delenv("THIMBLE_SESSION")
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "not a session thimble started"
