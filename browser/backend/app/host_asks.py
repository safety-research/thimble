"""The ask before a request to a host the analyst has not allowed, on Claude Code sign-in (runtime_cc.py), as Claude
Code asks in the terminal in its default mode.

A headless session's Bash runs in Claude Code's sandbox, whose proxy lets a command reach the hosts the analyst's own
Claude Code settings allow (`sandbox.network.allowedDomains`, and allow rules `WebFetch(domain:<host>)`) and asks about
any other host through the session's permission callback, as the tool SandboxNetworkAccess with `{"host": ...}` for its
input. The ask waits on the chat of the agent whose command made the request, whose meta carries it (`hosts`) as the
chat is read (agents.py), and the page shows it under the command: Allow once, Always allow, Deny. While it waits, the
command waits, and so does the agent's turn. Allow once lets the host through for the rest of the turn's session, which
Claude Code cannot take back, so main's session then closes as that turn ends, even while a command it ran in the
background runs (runtime_cc.Held). Always allow keeps the host for the workspace as the web rule
`WebFetch(domain:<host>)`, beside the ones a code ticket's card keeps (agent_session.keep_web_rule), which every later
session's settings allow (runtime_cc.settings), so it does not ask again; it also answers the other asks for that host
that wait. Deny refuses the connection, and the command fails as Claude Code refuses a host ("user denied").

Claude Code's ask names the host alone, so the ask also carries the call whose request it is (`call`: the session's
Bash call that runs, runtime_cc.options), and the page shows what Claude said the command does (its `description`)
over the host and the command.

The asks live in this process, and nothing of them is written: an ask whose session ends (its turn ended or stopped, the
server stopped) leaves its chat, and an answer that comes after it finds none (404).
"""
from __future__ import annotations

import asyncio
import re
import secrets
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

TOOL = "SandboxNetworkAccess"  # Claude Code's tool name for its sandbox's ask about a host (can_use_tool)
KEY = "hosts"  # on the asking chat's meta as it is read: [{id, host, since, call}], the asks that wait (HostAsk.tsx)
CHOICES = ("once", "always", "deny")
HOST_RE = re.compile(r"[A-Za-z0-9_.-]+")  # a host a web rule can name; any other is refused unasked, as before
RULE_HEAD = "WebFetch(domain:"  # a web rule for a site, as Claude Code's own "don't ask again" for a host names it
_waits: dict[str, dict[str, Any]] = {}  # ask id -> {c, chat, host, since, call, answer: the analyst's choice to come}


def rule(host: str) -> str:
    """The web rule that allows `host`."""
    return f"{RULE_HEAD}{host})"


def kept(c: str) -> list[str]:
    """The web rules for a site kept for workspace `c`, which each session's settings allow (runtime_cc.settings)."""
    from . import agent_session  # noqa: PLC0415 — agent_session imports the session modules

    return [r for r in agent_session.web_rules(c) if r.startswith(RULE_HEAD)]


async def ask(c: str, chat: str | None, host: str, call: dict[str, Any] | None = None) -> bool:
    """Whether a session of workspace `c` may reach `host`: at once when the workspace keeps it, else when the analyst
    answers the ask on `chat` (module note), which shows `call`, the call whose request it is ({tool, input}), when it
    is known. False with no chat to ask on (none, or one with no meta) and for a host no web rule can name."""
    if not HOST_RE.fullmatch(host):
        return False
    if rule(host) in kept(c):
        return True
    from . import agents, ledger  # noqa: PLC0415

    if not chat or agents.meta_or_none(c, chat) is None:
        return False
    rid = "h" + secrets.token_hex(6)
    wait = {"c": c, "chat": chat, "host": host, "since": ledger.now_iso(), "call": call,
            "answer": asyncio.get_running_loop().create_future()}
    _waits[rid] = wait
    agents.notify(c, chat)
    try:
        return await wait["answer"] != "deny"
    finally:
        _waits.pop(rid, None)
        agents.notify(c, chat)


def answer(c: str, ask_id: str, choice: str) -> None:
    """The analyst's choice on the ask `ask_id` of workspace `c`: once, always or deny. With always, the host is kept
    for the workspace and every ask for it that waits there is answered too. KeyError when no such ask waits,
    ValueError for another choice."""
    if choice not in CHOICES:
        raise ValueError("the choice is once, always or deny")
    wait = _waits.get(ask_id)
    if wait is None or wait["c"] != c:
        raise KeyError(ask_id)
    same = [wait]
    if choice == "always":
        from . import agent_session  # noqa: PLC0415

        agent_session.keep_web_rule(c, rule(wait["host"]))
        same = [w for w in _waits.values() if w["c"] == c and w["host"] == wait["host"]]
    for w in same:
        if not w["answer"].done():
            w["answer"].set_result(choice)


def waiting(c: str, chat: str) -> list[dict[str, Any]]:
    """The asks that wait on `chat` of workspace `c`, the one asked first first: {id, host, since}, and the call whose
    request it is (`call`) when it is known."""
    return [{"id": rid, "host": w["host"], "since": w["since"], **({"call": w["call"]} if w["call"] else {})}
            for rid, w in _waits.items() if w["c"] == c and w["chat"] == chat]


class Answer(BaseModel):
    choice: str  # once, always or deny


@router.post("/ws/{c}/host-asks/{ask_id}")
async def answer_route(c: str, ask_id: str, body: Answer) -> dict[str, Any]:
    """The analyst's choice on an ask (answer)."""
    try:
        answer(c, ask_id, body.choice)
    except KeyError:
        raise HTTPException(404, "no such ask is waiting") from None
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return {"ok": True}
