"""Notices: one short line in a chat that says something failed and how to fix it.

A notice is a `notice` record in a chat's log, main's or the chat the failure belongs to (a thread, an agent chat):
`{type: notice, ts, id, kind, text, key?, action?}`, written the way the mirror writes its other rows (agents.append),
and announced as a `notice {chat, id, key, kind, text, action}` record on the workspace stream. `text` is one sentence;
a fix that is a command (`/login`, `thimble server restart`) is in it. `action` is the button the row offers, one
object {label, do, slug?} or a list of them, `do` one of ACTIONS:

  proposals-retry  POST /api/ws/{c}/views/propose-now (proposer.run_now)
  proposals-off    PUT /api/ws/{c}/settings {propose_views: false}
  settings         open Settings
  view-retry       the failed view's Retry (its slug in `slug`)

Notices with the same `key` are one row: a later one replaces the earlier in place, so a failure that repeats updates
its row instead of adding rows. `clear` (a fix that worked) and `dismiss` (the row's ×) append a record with
`dismissed: true` under the notice's key or id, which hides the row; the browser reads the log as it is.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException

from . import agents, config, investigation

log = logging.getLogger("thimble.notices")
router = APIRouter()

TYPE = "notice"  # the record's type in a chat's log, and the event's on the workspace stream
ACTIONS = ("proposals-retry", "proposals-off", "settings", "view-retry")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _action(a: Any) -> dict[str, str]:
    if not isinstance(a, dict) or a.get("do") not in ACTIONS or not str(a.get("label") or "").strip():
        raise ValueError(f"a notice's action is {{label, do, slug?}} with `do` one of {', '.join(ACTIONS)}: {a!r}")
    return {k: str(a[k]) for k in ("label", "do", "slug") if a.get(k)}


def _actions(action: Any) -> dict[str, str] | list[dict[str, str]] | None:
    if action is None:
        return None
    if isinstance(action, (list, tuple)):
        got = [_action(a) for a in action]
        return got[0] if len(got) == 1 else got or None
    return _action(action)


def _append(c: str, chat: str, rec: dict[str, Any]) -> bool:
    """Append `rec` to the chat's log and tell the browser to read it again; False when the chat does not exist (a
    thread deleted while its failure was being told)."""
    if chat == agents.MAIN_ID:
        agents.ensure_main(c)
    meta_path, log_path = agents.paths(c, chat)
    if not meta_path.is_file():
        return False
    agents.append(log_path, rec)
    agents.notify(c, chat)
    return True


def _emit(c: str, event: dict[str, Any]) -> None:
    try:
        investigation.emit(c, investigation.MAIN, event)
    except Exception:  # noqa: BLE001 — off the server's loop (terminal mode's passes): the chat record still tells
        log.debug("%s: notice event not emitted", c, exc_info=True)


def post(c: str, *, chat: str = agents.MAIN_ID, kind: str, text: str, action: Any = None,
         key: str | None = None) -> dict[str, Any] | None:
    """Tell the analyst in chat `chat` that something failed: a notice row (module note) and its `notice` event. `kind`
    names what failed ("proposals", "safeguards", "view"); `key` makes a later notice replace this one. The record, or
    None when the chat does not exist. It never raises for a chat or a stream that cannot be written."""
    text = " ".join(str(text or "").split())
    if not text:
        raise ValueError("a notice says something")
    rec: dict[str, Any] = {"type": TYPE, "ts": _now(), "id": secrets.token_hex(6), "kind": str(kind or "warning"),
                           "text": text}
    if key:
        rec["key"] = str(key)
    if (acts := _actions(action)) is not None:
        rec["action"] = acts
    try:
        if not _append(c, chat, rec):
            return None
    except (HTTPException, OSError, ValueError):
        log.warning("%s: a notice for chat %s was not written: %s", c, chat, text, exc_info=True)
        return None
    _emit(c, {"type": TYPE, "chat": chat, "id": rec["id"], "key": rec.get("key"), "kind": rec["kind"],
              "text": text, "action": rec.get("action")})
    log.info("%s: notice in %s: %s", c, chat, text)
    return rec


def _latest(c: str, chat: str, *, key: str | None = None, notice_id: str | None = None) -> dict[str, Any] | None:
    """The chat's latest notice record under `key` or `notice_id` (its key, when it has one, is the row), None for none
    or one already dismissed."""
    try:
        _, log_path = agents.paths(c, chat)
        recs = agents.read_events(log_path) if log_path.is_file() else []
    except (HTTPException, OSError, ValueError):
        return None
    if notice_id and not key:
        hit = next((r for r in reversed(recs) if r.get("type") == TYPE and r.get("id") == notice_id), None)
        if hit is None:
            return None
        key = hit.get("key")
        if not key:
            gone = any(r.get("type") == TYPE and r.get("dismissed") and r.get("id") == notice_id for r in recs)
            return None if gone else hit
    last = next((r for r in reversed(recs) if r.get("type") == TYPE and r.get("key") == key), None)
    return None if last is None or last.get("dismissed") else last


def clear(c: str, key: str, *, chat: str = agents.MAIN_ID) -> bool:
    """The failure the notice under `key` told of is over (a retry that worked): its row goes. False when no row shows
    under the key."""
    if _latest(c, chat, key=key) is None:
        return False
    return _dismissed(c, chat, {"key": key})


def dismiss(c: str, notice_id: str, *, chat: str = agents.MAIN_ID) -> bool:
    """The analyst's × on the notice `notice_id`: its row (every notice under its key) goes. False for no such row."""
    hit = _latest(c, chat, notice_id=notice_id)
    if hit is None:
        return False
    return _dismissed(c, chat, {"key": hit["key"]} if hit.get("key") else {"id": notice_id})


def _dismissed(c: str, chat: str, which: dict[str, str]) -> bool:
    rec = {"type": TYPE, "ts": _now(), "dismissed": True, **which}
    try:
        if not _append(c, chat, rec):
            return False
    except (HTTPException, OSError, ValueError):
        log.warning("%s: a notice in chat %s was not dismissed", c, chat, exc_info=True)
        return False
    _emit(c, {"type": TYPE, "chat": chat, "dismissed": True, **which})
    return True


@router.post("/ws/{c}/chats/{chat}/notices/{notice_id}/dismiss")
async def dismiss_route(c: str, chat: str, notice_id: str) -> dict[str, Any]:
    """The row's ×: {dismissed: bool}."""
    config.workspace_dir(c)
    return {"dismissed": dismiss(c, notice_id, chat=chat)}
