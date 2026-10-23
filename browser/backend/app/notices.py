"""Notices: something an agent of thimble's did failed, or the analyst's setup needs a look, told where the analyst is
looking, with an easy fix.

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
  sign-out         POST /api/ui/signout (the browser's id in slug)

A notice with the same `key` replaces the earlier one in place, so a failure that repeats updates one notice. clear
(a later success under the key) and dismiss (the analyst's x) take a notice away. A dismissal of a REMEMBERED key holds
for the workspace: dismiss records the key in DISMISSED_FILE, and post then writes no notice under it. Each change is a `notice` event on
the workspace stream: {id, key, kind, text, agent, chat, action, foreground: true} for a notice, {id, key, cleared:
true} for one taken away. GET /api/ws/{c}/notices gives the open ones, so a page loaded again shows them.

Keys: `agent:<the agent's key>` for an agent of thimble's (agent_key: subagents.py for its runs and starts, dev.py for
view builds and code tickets, checks.py for report checks), `proposals` for the view proposer (proposer.py),
`safeguards:<chat>` for a reply Claude's safeguards switched to another model (session.py), `thread:<chat>` and
`helper:<agent id>` for a side thread's or a helper's API error, `main:api` for main's own (session.py), `card-check`
(card_check.py) and `label:<id>` (concepts.py). post and clear never raise: a failure to tell is logged.

Kinds that tell of the setup rather than a failure:

  manual-mode  key `manual-mode`: main runs in Claude Code's Manual mode (modes.manual_notice; session.note_mode in
               browser mode, local_hooks' mode-notice in terminal mode), shown in red; it goes when main reports
               another mode
  sandbox      key `no-box:<extension>`: an extension's program runs without a sandbox (harness.py); key
               `cc-sandbox`: Claude Code's Bash sandbox could not start in a session of the Claude Code sign-in, so
               its Bash calls were refused (runtime_cc.py), cleared by a later Bash call that ran
  setup        keys `env:<NAME>` and `proxy`: what /thimble found in the shell (events.session_route), in words this
               module writes from the key (setup_text), never words from the request
  sign-in      key `sign-in:<id>`: a browser signed in to thimble (main.signed_in), with Sign it out

A failure of Anthropic's API is told in plain words with its fix, and each fix says where it runs (reason, API_WORDS):
in the browser with its button, or "In your terminal: …" for one only Claude Code's terminal can run, such as /login or
/model.
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

from fastapi import APIRouter, HTTPException, Request

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
API = "api"  # the kind of a notice of main's own request that Anthropic's API failed (session.py), which main's chat
# shows as its API error card: no row, and the foreground strip leaves it out while main is open
ACTIONS = ("proposals-retry", "proposals-off", "settings", "view-retry", "sign-out")
NOTICES_FILE = "notices.json"  # in the workspace folder: the open notices, oldest first
DISMISSED_FILE = "notices-dismissed.json"  # in the workspace folder: the REMEMBERED keys the analyst dismissed
# keys whose dismissal holds for the workspace: a key equal to one, or starting with one that ends in ":"
REMEMBERED = ("manual-mode", "no-box:")
OPEN_MAX = 50  # open notices kept; the oldest go first
TEXT_CHARS = 480  # a notice's text at most, cut at a word (long enough for a fix in the terminal and its words)
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


def remembered(key: Any) -> bool:
    """Whether a dismissal of `key` holds for the workspace (REMEMBERED)."""
    k = str(key or "")
    return bool(k) and any(k == r or (r.endswith(":") and k.startswith(r)) for r in REMEMBERED)


def _dismissed_file(c: str) -> Path:
    return config.workspace_path(c) / DISMISSED_FILE


def _dismissed_keys(c: str) -> list[str]:
    try:
        p = _dismissed_file(c)
        raw = ledger.read_json(p, []) if p.is_file() and not p.is_symlink() else []
    except (OSError, ValueError, HTTPException):
        return []
    return [str(k) for k in raw if isinstance(k, str)] if isinstance(raw, list) else []


def dismissed(c: str, key: str) -> bool:
    """Whether the analyst dismissed the REMEMBERED key `key` in workspace `c`, so no notice shows under it."""
    return remembered(key) and key in _dismissed_keys(c)


def _remember(c: str, keys: list[str]) -> None:
    """Record the REMEMBERED keys among `keys` as dismissed for the workspace."""
    keep = [k for k in keys if remembered(k)]
    if not keep:
        return

    def change(raw: Any) -> list[str] | None:
        held = [str(k) for k in raw if isinstance(k, str)] if isinstance(raw, list) else []
        new = [k for k in dict.fromkeys(keep) if k not in held]
        return [*held, *new] if new else None

    try:
        ledger.update_json(_dismissed_file(c), change, [])
    except (OSError, ValueError, HTTPException):
        log.warning("%s: the dismissal of %s was not kept", c, ", ".join(keep), exc_info=True)


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
         key: str | None = None, row: bool = True) -> dict[str, Any] | None:
    """Tell the analyst in the foreground that something failed (module note): an open notice, replacing the one under
    the same `key`, a row in the agent's chat `chat` when it has one (not with `row` false: the chat shows the failure
    itself, as main's API error card does), and the `notice` event. `kind` names what failed ("agent", "safeguards",
    "view", "proposals", "card-check", "label", API for main's own request, or a setup kind of the module note). The
    notice, or None when it was not written, as for a REMEMBERED key the analyst dismissed (dismissed)."""
    text = _short(text, TEXT_CHARS)
    if not text:
        raise ValueError("a notice says something")
    if key and dismissed(c, str(key)):
        return None
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
    if rec["chat"] and row:
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
    """The analyst's x on the notice `notice_id`: it goes, and a REMEMBERED key of it stays dismissed for the workspace.
    False when no such notice is open."""
    if not notice_id:
        return False
    gone = _take(c, lambda n: n.get("id") == notice_id)
    _remember(c, [str(n.get("key") or "") for n in gone])
    return bool(gone)


# --------------------------------------------------------------------------- the setup /thimble found

# the `setup` notices' words by key (events.session_route): `env:<NAME>` for each NAME the launcher unsets (cli.UNSET_VARS),
# and `proxy`; the request names only the key
SETUP_TEXTS = {
    "env": ("Your shell sets {name}, so thimble's agents may not use the models and efforts in Settings. In your "
            "terminal: quit, unset {name} and start claude again, or start with `thimble`."),
    "proxy": ("Your shell sets a proxy, so thimble's plugin may not reach thimble's server. In your terminal: quit, add "
              "127.0.0.1 and localhost to NO_PROXY, and start claude again."),
}


def setup_text(key: Any) -> str:
    """The words of the `setup` notice under `key` (SETUP_TEXTS), '' for a key that is none of them."""
    from . import cli  # noqa: PLC0415 — cli imports config, procs and cc_plugin only

    k = str(key or "")
    if k == "proxy":
        return SETUP_TEXTS["proxy"]
    kind, _, name = k.partition(":")
    return SETUP_TEXTS["env"].format(name=name) if kind == "env" and name in cli.UNSET_VARS else ""


# --------------------------------------------------------------------------- what failed, in plain words

# the words of an error that says Claude's safeguards refused the request, and of one that says Claude Code has no
# working sign-in (Claude Code 2.1.300: "Not logged in · Please run /login", error authentication_failed)
REFUSED_RE = re.compile(r"safeguards|usage polic|can't help with this", re.I)
AUTH_RE = re.compile(r"not logged in|invalid api key|please run /login|authentication_failed|authentication failed|"
                     r"failed to authenticate|oauth token|\b401\b", re.I)
FORBIDDEN_RE = re.compile(r"\b403\b|forbidden|permission_error", re.I)
NOT_FOUND_RE = re.compile(r"\b404\b|not_found_error|model_not_found|issue with the selected model|"
                          r"model\b[^.]{0,80}(?:not found|does not exist|isn't available)", re.I)
# the HTTP status an error line names ("Please run /login · API Error: 401 …", "API Error: 403 {…}"), which decides
# before the line's other words do
STATUS_RE = re.compile(r"\b(?:API Error|Error code|HTTP|status(?: code)?):?\s*(\d{3})\b", re.I)
# Claude Code's API error record (isApiErrorMessage) names its failure in `apiErrorStatus` and `error`; these decide
# its class before its words, which change between versions (session.api_error_class)
STATUS_CLASS = {401: "auth", 403: "forbidden", 404: "not_found", 429: "rate_limited", 500: "server_error",
                502: "server_error", 503: "server_error", 504: "server_error", 529: "overloaded"}
ERROR_CLASS = {"authentication_failed": "auth", "model_not_found": "not_found", "rate_limit": "rate_limited",
               "overloaded": "overloaded", "server_error": "server_error"}
# Claude Code 2.1.300's words for a request that got no answer from Anthropic's API, which it records with `error`
# server_error and no apiErrorStatus: "API Error: Connection refused — a firewall or proxy may be blocking it
# (ECONNREFUSED)", "Unable to connect to API (…)", "Can't reach the API server — check your internet or DNS (ENOTFOUND)",
# "Couldn't connect through your proxy (…)", "Connection to the API was lost (…)", and the like
CONNECTION_RE = re.compile(r"unable to connect to api|connection refused|connection dropped|can[’']t reach the api server|"
                           r"no internet route|couldn[’']t connect through your proxy|connection to the api was lost|"
                           r"connection lost before|connection closed before|request timed out|"
                           r"\b(?:econnrefused|econnreset|enotfound|eai_again|enetunreach|ehostunreach|etimedout)\b",
                           re.I)

# Where a failure's fix runs (the browser can't run /login or /model): BROWSER, a button or a reply there
# (Retry, Try again, a rephrased request, Settings), or TERMINAL, the Claude Code terminal where thimble runs, whose
# fix the words name after "In your terminal:" and which offers no button.
BROWSER, TERMINAL = "browser", "terminal"
# a failure's class -> (what happened, what the analyst does, where they do it)
API_WORDS: dict[str, tuple[str, str, str]] = {
    "refused": ("Claude's safeguards stopped its request", "rephrase or narrow the request and try again", BROWSER),
    "auth": ("Claude Code isn't signed in", "In your terminal: run /login (or `claude auth login` in a shell)",
             TERMINAL),
    "forbidden": ("your account may not make this request (403)",
                  "In your terminal: check your sign-in (/login) and your account's or organization's settings",
                  TERMINAL),
    "not_found": ("its model isn't available to your account", "pick another model in Settings", BROWSER),
    "overloaded": ("Anthropic's API is overloaded", "try again in a few minutes", BROWSER),
    "rate_limited": ("Anthropic's API rate limit was reached", "try again in a few minutes", BROWSER),
    "server_error": ("Anthropic's API had a server error", "try again", BROWSER),
    "connection": ("the connection to Anthropic's API failed", "check the network and try again", BROWSER),
}
# a model main's session asked for, which only Claude Code's /model changes (a side thread's fork runs on main's)
MAIN_MODEL_FIX = "In your terminal: run /model to pick another model"

# the fix of a sign-in failure of a call thimble's server makes itself (the view proposer, card checks, labels), whose
# environment is the one the server started with
SERVER_AUTH = ("Claude Code isn't signed in for thimble's server",
               "In your terminal: run /login (or `claude auth login` in a shell), or if you changed your sign-in (for "
               "example exported ANTHROPIC_API_KEY), run `thimble server restart`", TERMINAL)


def fix_where(cls: Any) -> str:
    """Where the fix of a failure of class `cls` (API_WORDS' keys) runs: BROWSER or TERMINAL; BROWSER for any other
    failure, whose words say what to do."""
    return API_WORDS.get(str(cls or ""), ("", "", BROWSER))[2]


def failure_class(text: Any, *, status: Any = None, error: Any = None) -> str | None:
    """The class of an API failure (API_WORDS' keys), or None for any other failure: Claude's safeguards by the line's
    words, then the record's HTTP `status` (Claude Code's apiErrorStatus), then a connection failure by its words where
    the line names no status (CONNECTION_RE: Claude Code records one as server_error), then the record's `error` kind,
    then the status the line names, then its other words."""
    t = str(text or "")
    if REFUSED_RE.search(t):
        return "refused"
    if isinstance(status, int) and not isinstance(status, bool) and status in STATUS_CLASS:
        return STATUS_CLASS[status]
    if CONNECTION_RE.search(t) and not STATUS_RE.search(t):
        return "connection"
    if str(error or "") in ERROR_CLASS:
        return ERROR_CLASS[str(error)]
    if (m := STATUS_RE.search(t)) and int(m.group(1)) in STATUS_CLASS:
        return STATUS_CLASS[int(m.group(1))]
    if AUTH_RE.search(t):
        return "auth"
    if FORBIDDEN_RE.search(t):
        return "forbidden"
    if NOT_FOUND_RE.search(t):
        return "not_found"
    return retry.transient_class(None, t)


def reason(text: Any, *, server: bool = False, cls: str | None = None, main_model: bool = False) -> tuple[str, Any]:
    """A failure's words for a notice and the action that fixes it: an API failure (of class `cls` when the caller read
    it from Claude Code's record, else by its words) in plain words with its fix, a fix in the terminal after "In your
    terminal:" (TERMINAL) and one in the browser with its button (Open Settings for a model the account cannot use);
    for a sign-in failure of a call the server made itself (`server`) the server's fix, and for a model main's session
    asked for (`main_model`, a side thread's fork) Claude Code's /model. Any other failure in its own words,
    shortened."""
    cls = cls if cls in API_WORDS else failure_class(text)
    if cls is None:
        return _gist(text, REASON_CHARS).rstrip(".") or "no reason was given", None
    words, fix, where = SERVER_AUTH if server and cls == "auth" else API_WORDS[cls]
    if cls == "not_found" and main_model:
        fix, where = MAIN_MODEL_FIX, TERMINAL
    if where == TERMINAL:
        return f"{words}. {fix}", None
    return f"{words}; {fix}", SETTINGS if cls == "not_found" else None


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
                 action: Any = None, cls: str | None = None) -> dict[str, Any] | None:
    """An agent of thimble's ended failed with `error` (its report or Claude Code's API error line, of class `cls` when
    its record named one): the notice "<agent> failed: <why and fix>." under its key, with Open on its chat. Never
    raises."""
    try:
        name, subject = who(role, title or chat_title(c, chat))
        why, fix = reason(error, cls=cls)
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
async def dismiss_route(c: str, notice_id: str, request: Request) -> dict[str, Any]:
    """The analyst's x: {dismissed: bool}. 403 without the analyst's browser cookie: the server's token, which main's
    shim holds, does not take a notice away from the analyst (subagents.analyst_only)."""
    from . import subagents  # noqa: PLC0415

    subagents.analyst_only(request)
    config.workspace_dir(c)
    return {"dismissed": dismiss(c, notice_id)}
