"""The calls of an agent's chat, as `call:<chat>/<n>` refs: call n is the chat's n-th tool call (agent.count_calls), with
its input and its whole result, read from the chat's conversation (`chats/<id>.messages.json`). The orientation and its
critic read each call's ref at the start of its result (AgentDef.call_refs) and cite it; the page opens a call's ref in
the chat's thread and shows its whole output (frontend lib/calls.ts).

Routes: `GET /ws/{c}/calls/{chat}` (each call's number by its tool_use id) and `GET /ws/{c}/calls/{chat}/{n}` (one call).
read_ref reads a `call:` ref too, with `#L<a>` or `#L<a>-L<b>` for lines of its output.
"""
from __future__ import annotations

import json
import re
from typing import Any

from fastapi import HTTPException

from . import home, tools
from .agent import load_messages

REF = re.compile(r"^call:([A-Za-z0-9_-]+)/(\d+)(?:#L(\d+)(?:-L?(\d+))?)?$")
PREFIX = re.compile(r"^\[call:[A-Za-z0-9_-]+/\d+\]\n")


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text") or "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def calls_of(ws: str, chat: str) -> list[dict[str, Any]]:
    """Every call of the chat, in order: {n, id, chat, name, input, result, is_error}; `result` is None while it runs."""
    if not home.NAME_RE.match(chat):
        raise KeyError(chat)
    out: list[dict[str, Any]] = []
    results: dict[str, tuple[str, bool]] = {}
    messages = load_messages(ws, chat)
    for m in messages:
        if m.get("role") == "user" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    results[str(b.get("tool_use_id"))] = (PREFIX.sub("", _text(b.get("content")), count=1),
                                                          bool(b.get("is_error")))
    for m in messages:
        if m.get("role") != "assistant":
            continue
        for b in m.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                got = results.get(str(b.get("id")))
                out.append({"n": len(out) + 1, "id": b.get("id"), "chat": chat, "name": b.get("name"),
                            "input": b.get("input"), "result": got[0] if got else None,
                            "is_error": bool(got and got[1])})
    return out


def one(ws: str, chat: str, n: int) -> dict[str, Any]:
    got = calls_of(ws, chat)
    if not 1 <= n <= len(got):
        raise KeyError(f"call:{chat}/{n}")
    return got[n - 1]


def text_of(ws: str, ref: str) -> str:
    """A call's ref as read_ref reads it: its tool, its input and its output, or the lines of it the ref names."""
    m = REF.match(ref.strip())
    if not m:
        raise KeyError(ref)
    call = one(ws, m.group(1), int(m.group(2)))
    out = call["result"] if call["result"] is not None else "(it has not finished)"
    lines = out.split("\n")
    if m.group(3):
        a = int(m.group(3))
        b = int(m.group(4) or a)
        if not 1 <= a <= len(lines):
            raise KeyError(f"{ref}: its output has {len(lines)} lines")
        body = "\n".join(f"{k}\t{lines[k - 1]}" for k in range(a, min(b, len(lines)) + 1))
    else:
        body = "\n".join(f"{k}\t{t}" for k, t in enumerate(lines, 1))
    head = f"call:{call['chat']}/{call['n']} {call['name']} {json.dumps(call['input'], ensure_ascii=False)[:2000]}"
    return f"{head}\n{'error ' if call['is_error'] else ''}output, numbered by line:\n{body}"


def _read(t: tools.Tools, ref: str) -> tools.Result:
    try:
        return tools.Result(text_of(t.ws, ref))
    except KeyError as e:
        return tools.Result(f"no such call: {e}", True)


def register(ctx: Any) -> None:
    tools.REFS["call:"] = _read
    app = ctx.app

    @app.get("/api/ws/{c}/calls/{chat}")
    def call_index(c: str, chat: str) -> dict[str, Any]:
        ctx.ws_of(c)
        try:
            return {"calls": [{"n": x["n"], "id": x["id"], "name": x["name"]} for x in calls_of(c, chat)]}
        except KeyError:
            raise HTTPException(404, f"no chat {chat!r}") from None

    @app.get("/api/ws/{c}/calls/{chat}/{n}")
    def call_one(c: str, chat: str, n: int) -> dict[str, Any]:
        ctx.ws_of(c)
        try:
            return one(c, chat, n)
        except KeyError as e:
            raise HTTPException(404, str(e)) from None
