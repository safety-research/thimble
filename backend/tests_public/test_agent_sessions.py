"""The permission requests of the `claude -p` sessions thimble still starts itself (agent_session.py): a code ticket's,
`thimble fix`'s and an extension's program's. Their permission hook hands each request to the server, which hosts it on
the job's chat card (agent_session.host): Manual waits for the analyst for the card's wait, Bypass grants, and an edit of
thimble's config waits for the analyst in every mode. The hook signs its request and believes only the server's proof.
thimble's own agents are subagents of main, whose requests the terminal answers (events.py, test_relayed_permissions)."""
from __future__ import annotations

import asyncio
import io
import json
import time

import pytest

from app import agent_session, agents, hook_auth, permission_hook, userconf

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
        assert req.get_header("X-thimble-auth") == hook_auth.request_proof("tok", 8311, nonce), "for its port alone"
        assert abs(int(nonce.split(".")[0]) - time.time()) < 60, "and the time it was made"
        sent.append((req.full_url, json.loads(req.data)))
        assert timeout == permission_hook.TIMEOUT
        return Resp(json.dumps(answer).encode(), nonce)

    monkeypatch.setattr(permission_hook.LOOPBACK, "open", urlopen)  # its opener, which skips a shell's proxy
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
