"""Explain marks: after each answer in the chat, one model call reads the answer and marks the one to three terms the
person may not know, each with a short explanation that opens in place. The instructions are the terminal plugin's
explain lens, word for word (prompts/shared.json, part `explain`), inside the browser's own short frame
(prompts/browser/explain.md).

The call has no tools, and uses the person's Claude Code sign-in like the chat. Its result is a `glosses` record in
the chat's log; the page draws each term with a teal fill and opens the explanation on a click.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, TextBlock, query

from . import chats, home, prompts

log = logging.getLogger("thimble_browser.explain")
GLOSSED_KEEP = 100


def glossed_terms(ws: str, chat: str) -> list[str]:
    seen: list[str] = []
    for c in ("main", chat) if chat != "main" else ("main",):
        for r in chats.records(ws, c):
            if r.get("type") == "glosses":
                seen += [str(g.get("term")) for g in r.get("glosses") or [] if isinstance(g, dict)]
    return seen[-GLOSSED_KEEP:]


def last_question(ws: str, chat: str) -> str:
    for r in reversed(chats.records(ws, chat)):
        if r.get("type") == "user":
            return str(r.get("text") or "")
    return ""


def parse(text: str, answer: str) -> list[dict[str, Any]]:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return []
    try:
        got = json.loads(m.group(0))
    except ValueError:
        return []
    out = []
    for g in (got.get("glosses") or [])[:3]:
        if not isinstance(g, dict):
            continue
        term = str(g.get("term") or "").strip()
        if term and term in answer and g.get("body"):
            out.append({"term": term, "body": str(g["body"]), "here": str(g.get("here") or "")})
    return out


async def after_turn(ws: str, chat: str, answer: str, folder: Path) -> None:
    """Run the explain pass on `answer` and add its marks to the chat; nothing when the setting is off."""
    settings = home.read_json(home.root() / "settings.json", {}) or {}
    if settings.get("explain") is False:
        return
    from .agent import claude_path  # noqa: PLC0415 — agent imports this module

    system = prompts.render("browser/explain.md")
    seen = glossed_terms(ws, chat)
    msg = (f"The person asked:\n{last_question(ws, chat)}\n\nClaude answered:\n{answer}\n\n"
           f"Terms the person already saw explained:\n{chr(10).join(seen) if seen else '(none)'}")
    opts = ClaudeAgentOptions(cwd=str(folder), cli_path=claude_path(), tools=[], setting_sources=[],
                              strict_mcp_config=True, system_prompt=system, max_turns=1,
                              extra_args={"safe-mode": None}, permission_mode="default")
    out = []
    try:
        async for m in query(prompt=msg, options=opts):
            if isinstance(m, AssistantMessage):
                out += [b.text for b in m.content if isinstance(b, TextBlock)]
            elif isinstance(m, ResultMessage) and m.is_error:
                log.warning("explain pass failed: %s", m.result)
    except Exception as e:  # noqa: BLE001 — a failed pass leaves the answer as it is
        log.warning("explain pass failed: %s", e)
        return
    glosses = parse("".join(out), answer)
    if glosses:
        chats.append(ws, chat, {"type": "glosses", "glosses": glosses})
