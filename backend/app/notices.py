"""Notices: something an agent of thimble's did failed, told where the analyst is looking, with an easy fix.

A notice is one short line in a warning style, an optional action button, and x to dismiss it. It shows in the
foreground: in the browser in a strip above the composer of whichever chat the analyst has open, until they dismiss it
or the failure is fixed; in terminal mode in the band above the prompt. A notice of an agent with a chat of its own (a
thread, an agent chat; `chat`) is also written into that chat as a row, for its history.

The open notices are the workspace's NOTICES_FILE, oldest first, each {id, key, kind, text, agent, chat, action, ts}:
`text` is one sentence that reads alone (it names the agent and the failure, and a fix that is a command, such as /login
or `thimble server restart`); `agent` names the agent in a few words ("Orientation", "View build: Agent Network");
`chat` is the agent's own chat, which the strip's Open goes to; `action` is the button, one object {label, do, slug?} or
a list of them, `do` one of ACTIONS:

  proposals-retry  POST /api/ws/{c}/views/propose-now (proposer.run_now)
  proposals-off    PUT /api/ws/{c}/settings {propose_views: false}
  settings         open Settings
  view-retry       the failed view's Retry (its slug in `slug`)

A notice with the same `key` replaces the earlier one in place, so a failure that repeats updates one notice. clear
(a later success under the key) and dismiss (the analyst's x) take a notice away. Each change is a `notice` event on
the workspace stream: {id, key, kind, text, agent, chat, action, foreground: true} for a notice, {id, key, cleared:
true} for one taken away. GET /api/ws/{c}/notices gives the open ones, so a page loaded again shows them.

Keys: `agent:<the agent's key>` for an agent of thimble's (agent_key: subagents.py for its runs and starts, dev.py for
view builds and code tickets, checks.py for report checks), `proposals` for the view proposer (proposer.py),
`safeguards:<chat>` for a reply Claude's safeguards switched to another model (session.py), `thread:<chat>` and
`helper:<agent id>` for a side thread's or an orientation helper's API error (session.py), `card-check` (card_check.py)
and `label:<id>` (concepts.py). post and clear never raise: a failure to tell is logged.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from . import agents, config, investigation, ledger, retry

log = logging.getLogger("thimble.notices")


@contextlib.asynccontextmanager
async def _lifespan(app: Any):
    """The server's loop, so a notice posted from a worker thread still reaches the stream (_emit)."""
    global _loop
    _loop = asyncio.get_running_loop()
    yield
    _loop = None


router = APIRouter(lifespan=_lifespan)
_loop: asyncio.AbstractEventLoop | None = None

TYPE = "notice"  # the event's type on the workspace stream, and the row's type in a chat's log
ACTIONS = ("proposals-retry", "proposals-off", "settings", "view-retry")
NOTICES_FILE = "notices.json"  # in the workspace folder: the open notices, oldest first
OPEN_MAX = 50  # open notices kept; the oldest go first
TEXT_CHARS = 360  # a notice's text at most, cut at a word
REASON_CHARS = 280  # a failure's own words inside a notice at most
SETTINGS = {"label": "Open Settings", "do": "settings"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _short(text: Any, limit: int) -> str:
    """`text` on one line, at most `limit` characters, cut at a word with an ellipsis."""
    t = " ".join(str(text or "").split())
    if len(t) <= limit:
        return t
    cut = t[: limit - 1].rsplit(" ", 1)[0].rstrip(",;:")
    return (cut or t[: limit - 1]) + "…"


def _gist(text: Any, limit: int) -> str:
    """`text` on one line in at most `limit` characters: whole when it fits, else its first sentence and its last (where
    a fix usually is), else its first sentence cut at a word."""
    t = " ".join(str(text or "").split())
    if len(t) <= limit:
        return t
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z`(])", t)
    if len(parts) > 1 and len(parts[0]) + len(parts[-1]) + 3 <= limit:
        return f"{parts[0]} … {parts[-1]}"
    return _short(parts[0], limit)


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


def _emit(c: str, event: dict[str, Any]) -> None:
    """The event on the workspace stream, from the loop or scheduled onto the server's loop from a worker thread; off
    any loop (terminal mode's passes) the notices file alone tells."""

    def send() -> None:
        try:
            investigation.emit(c, investigation.MAIN, event)
        except Exception:  # noqa: BLE001
            log.debug("%s: notice event not emitted", c, exc_info=True)

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        loop = _loop
        if loop is not None and loop.is_running() and not loop.is_closed():
            loop.call_soon_threadsafe(send)
        return
    send()


def _rows(raw: Any) -> list[dict[str, Any]]:
    return [n for n in raw if isinstance(n, dict) and n.get("id")] if isinstance(raw, list) else []


def _file(c: str) -> Path:
    return config.workspace_path(c) / NOTICES_FILE


def open_notices(c: str) -> list[dict[str, Any]]:
    """The workspace's open notices, oldest first; [] for none or a file that cannot be read."""
    try:
        p = _file(c)
        return _rows(ledger.read_json(p, [])) if p.is_file() and not p.is_symlink() else []
    except (OSError, ValueError, HTTPException):
        return []


def _row(c: str, chat: str, rec: dict[str, Any]) -> None:
    """The notice as a row in its agent's chat, for its history; nothing when the chat is gone."""
    if chat == agents.MAIN_ID:
        agents.ensure_main(c)
    meta_path, log_path = agents.paths(c, chat)
    if not meta_path.is_file():
        return
    agents.append(log_path, {"type": TYPE, "ts": rec["ts"], "id": rec["id"],
                             **{k: rec[k] for k in ("key", "kind", "text", "agent", "action") if rec.get(k)}})
    agents.notify(c, chat)


def post(c: str, *, kind: str, text: str, agent: str | None = None, chat: str | None = None, action: Any = None,
         key: str | None = None) -> dict[str, Any] | None:
    """Tell the analyst in the foreground that something failed (module note): an open notice, replacing the one under
    the same `key`, a row in the agent's chat `chat` when it has one, and the `notice` event. `kind` names what failed
    ("agent", "safeguards", "view", "proposals", "card-check", "label"). The notice, or None when it was not written."""
    text = _short(text, TEXT_CHARS)
    if not text:
        raise ValueError("a notice says something")
    rec: dict[str, Any] = {"id": secrets.token_hex(6), "key": str(key) if key else None, "kind": str(kind or "agent"),
                           "text": text, "agent": str(agent) if agent else None, "chat": str(chat) if chat else None,
                           "action": _actions(action), "ts": _now()}

    def change(raw: Any) -> list[dict[str, Any]]:
        kept = [n for n in _rows(raw) if not (rec["key"] and n.get("key") == rec["key"])]
        return [*kept, rec][-OPEN_MAX:]

    try:
        config.workspace_dir(c)
        ledger.update_json(_file(c), change, [])
    except (OSError, ValueError, HTTPException):
        log.warning("%s: a notice was not written: %s", c, text, exc_info=True)
        return None
    if rec["chat"]:
        try:
            _row(c, rec["chat"], rec)
        except (OSError, ValueError, HTTPException):
            log.debug("%s: the notice's row in %s was not written", c, rec["chat"], exc_info=True)
    _emit(c, {"type": TYPE, **{k: rec[k] for k in ("id", "key", "kind", "text", "agent", "chat", "action")},
              "foreground": True})
    log.info("%s: notice%s: %s", c, f" ({rec['key']})" if rec["key"] else "", text)
    return rec


def _take(c: str, which: Any) -> list[dict[str, Any]]:
    """Take the open notices `which` picks out of the file; the ones taken."""
    gone: list[dict[str, Any]] = []
    try:
        p = _file(c)
        if not p.is_file():
            return []

        def change(raw: Any) -> list[dict[str, Any]] | None:
            rows = _rows(raw)
            gone[:] = [n for n in rows if which(n)]
            return [n for n in rows if not which(n)] if gone else None

        ledger.update_json(p, change, [])
    except (OSError, ValueError, HTTPException):
        log.warning("%s: an open notice was not taken away", c, exc_info=True)
        return []
    for n in gone:
        _emit(c, {"type": TYPE, "id": n["id"], "key": n.get("key"), "cleared": True})
    return gone


def clear(c: str, key: str) -> bool:
    """The failure the notice under `key` told of is fixed (a later success): the notice goes. False when none was
    open."""
    return bool(key) and bool(_take(c, lambda n: n.get("key") == key))


def dismiss(c: str, notice_id: str) -> bool:
    """The analyst's x on the notice `notice_id`: it goes. False when no such notice is open."""
    return bool(notice_id) and bool(_take(c, lambda n: n.get("id") == notice_id))


# --------------------------------------------------------------------------- what failed, in plain words

# the words of an error that says Claude's safeguards refused the request, and of one that says Claude Code has no
# working sign-in (Claude Code 2.1.300: "Not logged in · Please run /login", error authentication_failed)
REFUSED_RE = re.compile(r"safeguards|usage polic|can't help with this", re.I)
AUTH_RE = re.compile(r"not logged in|invalid api key|please run /login|authentication_failed|authentication failed|"
                     r"oauth token|\b401\b", re.I)
FORBIDDEN_RE = re.compile(r"\b403\b|forbidden|permission_error", re.I)
NOT_FOUND_RE = re.compile(r"\b404\b|not_found_error|model\b[^.]{0,80}(?:not found|does not exist|isn't available)",
                          re.I)
API_WORDS: dict[str, tuple[str, str]] = {  # a failure's class -> (what happened, what the analyst does)
    "refused": ("Claude's safeguards stopped its request", "rephrase or narrow the request and try again"),
    "auth": ("Claude Code isn't signed in", "run /login"),
    "forbidden": ("your account may not make this request (403)",
                  "check your sign-in and your organization's settings, or pick another model in Settings"),
    "not_found": ("its model isn't available to your account", "pick another model in Settings"),
    "overloaded": ("Anthropic's API is overloaded", "try again in a few minutes"),
    "rate_limited": ("Anthropic's API rate limit was reached", "try again in a few minutes"),
    "server_error": ("Anthropic's API had a server error", "try again"),
    "connection": ("the connection to Anthropic's API failed", "check the network and try again"),
}


# the fix of a sign-in failure of a call thimble's server makes itself (the view proposer, card checks, labels), whose
# environment is the one the server started with
SERVER_AUTH = ("Claude Code isn't signed in for thimble's server",
               "run /login, or if you changed your sign-in (for example exported ANTHROPIC_API_KEY), run "
               "`thimble server restart`")


def failure_class(text: Any) -> str | None:
    """The class of an API failure from its error line (API_WORDS' keys), or None for any other failure."""
    t = str(text or "")
    if REFUSED_RE.search(t):
        return "refused"
    if AUTH_RE.search(t):
        return "auth"
    if FORBIDDEN_RE.search(t):
        return "forbidden"
    if NOT_FOUND_RE.search(t):
        return "not_found"
    return retry.transient_class(None, t)


def reason(text: Any, *, server: bool = False) -> tuple[str, Any]:
    """A failure's words for a notice and the action that fixes it: an API failure in plain words with its fix (Open
    Settings for a model the account cannot use; for a sign-in failure of a call the server made itself, `server`, the
    server's fix), any other failure in its own words, shortened."""
    cls = failure_class(text)
    if cls is not None:
        words, fix = SERVER_AUTH if server and cls == "auth" else API_WORDS[cls]
        return f"{words}; {fix}", SETTINGS if cls in ("forbidden", "not_found") else None
    return _gist(text, REASON_CHARS).rstrip(".") or "no reason was given", None


# --------------------------------------------------------------------------- thimble's agents

# a role of subagents.TYPES -> (its name on a notice, the subject of a sentence about it); {t} is the run's title
ROLE_NAMES: dict[str, tuple[str, str]] = {
    "orientation": ("Orientation", "The orientation"),
    "critic": ("Critic", "The orientation's critic"),
    "writer": ("Writer: {t}", "The writer of {t}"),
    "view-builder": ("View build: {t}", "The build of the view {t}"),
    "view-reviewer": ("View review: {t}", "The review of the view {t}"),
    "check": ("Report check: {t}", "The report check {t}"),
    "dev-ticket": ("Code ticket: {t}", "The code ticket {t}"),
    "orient-helper": ("Orientation helper", "A helper of the orientation"),
    "thread": ("Side thread: {t}", "The side thread \"{t}\""),
}
# the words a chat's title has before the run's own title (dev.py's "view: …", view_review's "review: …",
# write_session's "Write …"), and the titles that only name the role
TITLE_PREFIXES = ("view: ", "review: ", "write ")
ROLE_TITLES = ("orientation", "critic", "critique", "orientation critic")


def agent_key(key: Any) -> str:
    """The notices' key of an agent of thimble's, by the key it runs under (its session: `orientation`, `view:<slug>`,
    `check:<id>:<doc>`)."""
    return f"agent:{key}"


def who(role: Any, title: Any = "") -> tuple[str, str]:
    """(the agent's name on a notice, the subject of a sentence about it) for a role and its run's title (its chat's
    title, such as "view: Agent Network")."""
    t = " ".join(str(title or "").split())
    for p in TITLE_PREFIXES:
        if t.lower().startswith(p):
            t = t[len(p):].strip()
    if t.lower() in ROLE_TITLES:
        t = ""
    name, subject = ROLE_NAMES.get(str(role or ""), ("Agent: {t}", "The agent \"{t}\""))
    if not t:
        name = name.replace(": {t}", "")
        subject = subject.replace(" \"{t}\"", "").replace(" {t}", "")
    return name.format(t=t), subject.format(t=t)


def chat_title(c: str, chat: Any) -> str:
    """The title of chat `chat`, '' for none."""
    if not chat:
        return ""
    with contextlib.suppress(Exception):
        return str((agents.meta_or_none(c, str(chat)) or {}).get("title") or "")
    return ""


def agent_failed(c: str, *, role: str, key: Any, error: Any, chat: str | None = None, title: str = "",
                 action: Any = None) -> dict[str, Any] | None:
    """An agent of thimble's ended failed with `error` (its report or Claude Code's API error line): the notice
    "<agent> failed: <why>; <fix>." under its key, with Open on its chat. Never raises."""
    try:
        name, subject = who(role, title or chat_title(c, chat))
        why, fix = reason(error)
        return post(c, kind="agent", text=f"{subject} failed: {why}.", agent=name, chat=chat, key=agent_key(key),
                    action=action if action is not None else fix)
    except Exception:  # noqa: BLE001 — a failure not told is no reason to fail what reports it
        log.exception("%s: the failure of %s was not told", c, key)
        return None


def agent_refused(c: str, *, role: str, key: Any, why: Any, chat: str | None = None, title: str = "",
                  message: bool = False, action: Any = None) -> dict[str, Any] | None:
    """A start of an agent of thimble's (or, with `message`, a message to it) did not happen: the notice "<agent>
    didn't start: <why>." under its key. Never raises."""
    try:
        name, subject = who(role, title or chat_title(c, chat))
        words, fix = reason(why)
        did = "didn't get the message" if message else "didn't start"
        return post(c, kind="agent", text=f"{subject} {did}: {words}.", agent=name, chat=chat, key=agent_key(key),
                    action=action if action is not None else fix)
    except Exception:  # noqa: BLE001
        log.exception("%s: the refusal of %s was not told", c, key)
        return None


def cleared(c: str, key: Any) -> None:
    """clear for an agent of thimble's that started or ended well, by the key it runs under. Never raises."""
    try:
        clear(c, agent_key(key))
    except Exception:  # noqa: BLE001
        log.exception("%s: the notice of %s was not cleared", c, key)


# --------------------------------------------------------------------------- routes


@router.get("/ws/{c}/notices")
async def list_route(c: str) -> list[dict[str, Any]]:
    """The open notices, oldest first (module note)."""
    config.workspace_dir(c)
    return open_notices(c)


@router.post("/ws/{c}/notices/{notice_id}/dismiss")
async def dismiss_route(c: str, notice_id: str) -> dict[str, Any]:
    """The analyst's x: {dismissed: bool}."""
    config.workspace_dir(c)
    return {"dismissed": dismiss(c, notice_id)}
