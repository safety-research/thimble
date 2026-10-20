"""Explain marks: after each answer in the chat, one model call reads the answer and marks the one to three terms the
analyst may not know, each with a short explanation that opens in place. The instructions are the terminal plugin's
explain lens, word for word (prompts/shared.json, part `explain`), inside the browser's own short frame
(prompts/browser/explain.md), and the list of terms already explained is the lens's own digest line.

The call has no tools. Its result is a `glosses` record in the chat's log; the page draws each term with a teal fill and
opens the explanation on a click. Settings turns the pass off.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from . import chats, llm, prompts

log = logging.getLogger("thimble_browser.explain")
GLOSSED_KEEP = 100
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["glosses"], "properties": {
    "glosses": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                           "required": ["term", "body", "here"],
                                           "properties": {"term": {"type": "string"}, "body": {"type": "string"},
                                                          "here": {"type": "string"}}}}}}


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
    try:
        got = json.loads(text)
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
    """Run the explain pass on `answer` and add its marks to the chat."""
    system = prompts.render("browser/explain.md")
    seen = glossed_terms(ws, chat)
    digest = prompts.shared("explain-digest").replace("{{GLOSSED}}", "\n".join(seen) if seen else "(none)")
    msg = f"The analyst asked:\n{last_question(ws, chat)}\n\nClaude answered:\n{answer}\n\n{digest}"
    try:
        text = await llm.complete(system, msg, schema=SCHEMA, effort="low")
    except Exception as e:  # noqa: BLE001 — a failed pass leaves the answer as it is
        log.warning("explain pass failed: %s", llm.failure(e))
        return
    glosses = parse(text, answer)
    if glosses:
        chats.append(ws, chat, {"type": "glosses", "glosses": glosses})
