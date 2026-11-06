"""The card on which a code ticket asks thimble's own questions about its code (dev.CODE_TOOL), and the helpers
`thimble fix`'s session uses (dev.py). thimble's own agents, the code tickets' among them, are subagents of main
instead (subagents.py).

Hosted sessions. A code ticket's chat is hosted (host) for thimble's own questions alone, which ask with `force`: ask
shows each on the chat's card with Allow and Deny, by the mode of the dev agent's row (modes.py), and waits for the
analyst. A request nobody answers is denied after the card's wait, `cardWait` in thimble's config
(userconf.card_wait_s), so no request waits for good. A request denied unanswered stays on the card, marked `expired`,
until the analyst dismisses it or the session ends.

The web. A web call's request waits on the same card as a waiting request for the same site or for search (`groups`),
each listed on it whole, up to WEB_ALSO_MAX. The card's answer says how many it listed (`shown`); a later one it did
not list is asked on its own once the answer comes. The card offers "don't ask again" for the site, or for web search,
kept for the workspace in WEB_RULES_FILE in its registry folder, which a kernel cannot write, and which every
session's later request of it meets (web_rules).

Don't ask again. The request's `permission_suggestions` become the card's third choice (offer); chosen, they are sent
as `updatedPermissions` with destination session and kept on the chat's meta (RULES_KEY). Where the org's managed tier
sets allowManagedPermissionRulesOnly, Claude Code ignores the rules a session saves and its own dialog offers no "don't
ask again", so no card offers one, for the session or for the workspace (rules_ignored).

The config. thimble's config (userconf.py) adds its rules to a session's --settings (with_config): the web tools allowed
or taken away, auto memory when it is not inherited, an ask of edits to thimble's config files, and, where the
session's network is off and its Bash runs outside the sandbox, an ask of every Bash command. A command that ask
covers, and an edit of the config's files, goes to the card in every mode, Bypass included (userconf.Session.verdict).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import agents, cc_plugin, cc_settings, config, hook_auth, modes, session, tools, userconf
from .ledger import atomic_write_text
from .permission_updates import EDIT_MODE, WORKSPACE, allowing, offer_text, rule_text

log = logging.getLogger("thimble.agent_session")
router = APIRouter()
STEP_ROLE = agents.STEP_ROLE  # a subagent or workflow agent of the session
# of a request's input the card shows, scrolled; past it the entry's `cut` is the input's length and the card offers
# no "don't ask again"
PERMISSION_INPUT_CHARS = 50_000
# analyst-facing lines, and the deny messages Claude Code passes to the session's model
DENIED_LINE = "Denied from thimble's browser."
CONFIG_DENIED_LINE = "thimble's config refuses this command."  # userconf: `installs` is "deny"
TIMED_OUT_LINE = ("Nobody answered in thimble's browser within {wait}, so the call was denied. Carry on without it, "
                  "or find a way that needs no permission.")
GONE_LINE = "The session ended before it was answered."
NOBODY_WAITS = "none: nothing waits on it any more"  # the permission log's word for a request taken off unanswered
BYPASS = "bypass"
# the answers that allow a request with the "don't ask again" updates Claude Code suggested for it, and a waiting one
# those updates cover (module note, don't ask again)
ALWAYS, COVERED = "always", "covered"
RULES_KEY = "session_rules"  # on the session's chat meta: [{text, update}], the updates the analyst chose
# each Bash command starts in the process's own folder, since a `cd` would carry over and Claude Code's sandbox makes a
# folder of its own in whatever folder a sandboxed command starts in, the corpus folder among them
HOME_SHELL_ENV = "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"
RETRY_BASE_S = 30.0
RETRY_MAX_S = 300.0
RETRY_MIN_S = 1.0  # the shortest base RETRY_BASE_ENV may set, so a long streak never restarts the process at once
RETRY_JITTER = 0.2
RETRY_BASE_ENV = "THIMBLE_SESSION_RETRY_BASE_S"
RETRY_PROMPT = "session-retry"  # prompts/tools.md: the stdin prompt of a session started again after the wait
# A job's session never ends while its own background work runs: the tools that schedule a later turn are taken away,
# since a --print session exits before that turn comes, and --print waits for background agents and workflows however
# long they run (BG_WAIT_ENV).
LATER_TOOLS = ("ScheduleWakeup", "CronCreate", "CronDelete", "CronList")
# The web tools, and the workspace's file of the web rules the analyst kept, {"allow": [rule, ...]}.
WEB_TOOLS = tools.WEB_TOOLS
WEB_RULES_FILE = "web_rules.json"
WEB_ALSO_MAX = 20  # the later requests that join a waiting web request, each listed on its card (`also`)
ALSO_CHARS = 300  # of a joining request's address or search; a longer one is a request of its own
TIMED_OUT = "timed out"  # the answer of a request nobody answered in time
BG_WAIT_ENV = "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"
BG_WAIT_MS = "0"  # no ceiling
RESUMED_PROMPT = "session-resumed"  # prompts/tools.md: the stdin prompt of a session resumed after it ended early
LAUNCHED_AGENT_RE = re.compile(r"\bagentId:\s*(\w+)")  # in a background Agent call's result
LAUNCHED_TASK_RE = re.compile(r"\bTask ID:\s*(\S+)")  # in a Workflow call's result
RESUMED_AGENT_RE = re.compile(r'"resumedAgentId"\s*:\s*"(\w+)"')  # in a SendMessage's result that continued an agent
TASK_ID_RE = re.compile(r"<task-id>\s*(.*?)\s*</task-id>", re.S)  # a notification may name several tasks
# a long call Claude Code let run on, in its own words at the head of the call's result (an MCP tool's), so a result that
# only quotes them (a log, a transcript) is none
MOVED_TASK_RE = re.compile(r'\A\s*MCP tool "[^\n]*?\bmoved to the background as task (\w+)')
STOP_TOOL = "TaskStop"
STOPPED_TASK_RE = re.compile(r'"task_id"\s*:\s*"([^"]+)"')  # in a TaskStop's result, which no notification follows


def _now() -> str:
    return session._now()


@dataclass
class Run:
    """A job's session whose permission requests ask answers (host): its key, chat and mode, and what its requests
    and the analyst's answers left."""

    c: str
    key: str  # its THIMBLE_SESSION: a code ticket's
    chat: str
    sid: str
    cwd: Path
    role: str
    waits: dict[str, asyncio.Future] = field(default_factory=dict)  # permission request id -> the analyst's answer
    config: userconf.Session | None = None  # what thimble's config asks of it (module note, the config)
    mode: str = "manual"  # the mode it runs in, one of modes.MODES (module note, hosted sessions)
    groups: dict[str, str] = field(default_factory=dict)  # web rule -> the id of the request waiting for it (module note, the web)
    shown: dict[str, int] = field(default_factory=dict)  # answered request id -> how many joined calls its card listed
    asking: dict[str, tuple[str | None, str]] = field(default_factory=dict)  # request id -> (agent that asked, tool)
    forced: set[str] = field(default_factory=set)  # ids of the waiting requests thimble's config sends to the analyst
    # the "don't ask again" updates the card offers for each waiting request, by its id, and those the analyst chose
    # (module note, don't ask again)
    offers: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    rules: list[dict[str, Any]] = field(default_factory=list)


_hosted: dict[tuple[str, str], Run] = {}  # by (workspace, key): the hosted sessions (module note, hosted sessions)


def settings_json(effort: str, env: dict[str, str] | None = None, **extra: Any) -> str:
    """The session's --settings: the caller's choices, and the effort as CLAUDE_CODE_EFFORT_LEVEL, which a flag
    setting's env gives over one in the folder's local settings (module note), beside the caller's own `env`."""
    return json.dumps({**extra, "env": {**(env or {}), cc_settings.EFFORT_ENV: effort}})


def with_home_shell(settings: dict[str, Any]) -> dict[str, Any]:
    """`settings` with HOME_SHELL_ENV in its `env`."""
    return {**settings, "env": {**(settings.get("env") or {}), HOME_SHELL_ENV: "1"}}


def role_agent(agent: dict[str, Any], conf: dict[str, Any]) -> dict[str, Any]:
    """An agent definition with the model and effort of its role in the settings popover (config.models_for) in place
    of its file's, where the role names them."""
    out = dict(agent)
    for key in ("model", "effort"):
        if conf.get(key):
            out[key] = conf[key]
    return out


thimble_tool = tools.thimble_tool  # a thimble tool's name as a session sees it


def with_config(settings: dict[str, Any], conf: dict[str, Any]) -> dict[str, Any]:
    """`settings` with thimble's config's keys (userconf.Session.settings) added, each permission list joined, and its
    sandbox's read denies joined to the sandbox of `settings` when it has one."""
    perms = dict(settings.get("permissions") or {})
    for key, rules in (conf.get("permissions") or {}).items():
        perms[key] = list(dict.fromkeys([*(perms.get(key) or []), *rules]))
    out = {**settings, **{k: v for k, v in conf.items() if k not in ("permissions", "sandbox")}, "permissions": perms}
    reads = ((conf.get("sandbox") or {}).get("filesystem") or {}).get("denyRead") or []
    if reads and isinstance(settings.get("sandbox"), dict):
        box = dict(settings["sandbox"])
        fs = dict(box.get("filesystem") or {})
        fs["denyRead"] = list(dict.fromkeys([*(fs.get("denyRead") or []), *reads]))
        out["sandbox"] = {**box, "filesystem": fs}
    return out


def retry_base(environ_: "dict[str, str] | None" = None) -> float:
    """The first wait of a streak (module note, retry): RETRY_BASE_ENV where it is set, at least RETRY_MIN_S, else
    RETRY_BASE_S; a value that is not a number is the default, with a log line."""
    src = os.environ if environ_ is None else environ_
    raw = str(src.get(RETRY_BASE_ENV, "") or "").strip()
    if not raw:
        return RETRY_BASE_S
    try:
        return max(RETRY_MIN_S, float(raw))
    except ValueError:
        log.warning("%s=%r is not a number; using %g", RETRY_BASE_ENV, raw, RETRY_BASE_S)
        return RETRY_BASE_S


def retry_wait(n: int, base_s: float | None = None, max_s: float = RETRY_MAX_S) -> float:
    """The wait before retry `n` (from 0) of a streak, without jitter: doubling from `base_s` (retry_base when None),
    each at most `max_s`. The schedule has no end."""
    base = retry_base() if base_s is None else base_s
    return min(base * 2 ** min(n, 32), max_s)


def _pending(c: str, chat: str) -> list[dict[str, Any]]:
    meta = agents.meta_or_none(c, chat) or {}
    return [p for p in meta.get("permissions") or [] if isinstance(p, dict)]


def _what(tool_name: str, inp: Any) -> str:
    """What a call would do, for the analyst: its own description when it gave one, else its command, file or pattern."""
    d = inp if isinstance(inp, dict) else {}
    for key in ("description", "command", "file_path", "path", "pattern", "url", "query", "prompt"):
        if isinstance(d.get(key), str) and d[key].strip():
            return " ".join(d[key].split())[:300]
    return tool_name


def asker(c: str, key: str | None) -> Run | None:
    """The hosted session whose requests ask answers for `key`."""
    return _hosted.get((c, key or ""))


def _by_chat(c: str, chat: str) -> Run | None:
    """The hosted session whose chat is `chat`."""
    return next((r for (cc, _), r in list(_hosted.items()) if cc == c and r.chat == chat), None)


def host(c: str, key: str, chat: str, *, agent: str, conf: userconf.Session | None = None) -> Run:
    """Answer the requests of the session `key`, which this module does not follow, on the chat `chat` (module note,
    hosted sessions): by the mode of the row `agent` (modes.AGENTS), each denied after the card's wait unanswered;
    `conf` is what thimble's config asks of it (module note, the config)."""
    run = Run(c, key, chat, "", config.corpus_dir(c), "dev", mode=modes.mode_for(c, agent), config=conf)
    _hosted[(c, key)] = run
    return run


def unhost(c: str, key: str) -> None:
    """The hosted session `key`'s run is over: what still waits is denied, and its chat's card is cleared."""
    run = _hosted.pop((c, key), None)
    if run is None:
        return
    for fut in list(run.waits.values()):
        if not fut.done():
            fut.set_result(None)
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, permissions=[])


def web_rule(tool_name: str, inp: Any) -> str | None:
    """The web rule a call falls under, as Claude Code writes it: `WebFetch(domain:<host>)` for a fetch, `WebSearch` for a
    search; None for any other call, and for a fetch whose address is not a plain http(s) host with an optional port
    (a user part, a backslash or a percent escape make Claude Code read another host than Python), which is then asked
    on its own."""
    if tool_name == "WebSearch":
        return "WebSearch"
    url = inp.get("url") if tool_name == "WebFetch" and isinstance(inp, dict) else None
    try:
        parts = urlsplit(url) if isinstance(url, str) and "\\" not in url else None
    except ValueError:
        parts = None
    if parts is None or parts.scheme not in ("http", "https") or not re.fullmatch(r"[A-Za-z0-9_.-]+(:\d+)?", parts.netloc):
        return None
    return f"WebFetch(domain:{parts.hostname})"


def web_offer(rule: str) -> list[dict[str, Any]]:
    """The card's "don't ask again" for a web rule, kept for the workspace (module note, the web)."""
    tool, _, content = rule.partition("(")
    kept = {"toolName": tool, **({"ruleContent": content[:-1]} if content else {})}
    return [{"type": "addRules", "rules": [kept], "behavior": "allow", "destination": WORKSPACE}]


def web_rules(c: str) -> list[str]:
    """The web rules the analyst kept for workspace `c`."""
    try:
        data = json.loads((config.registry_dir(c) / WEB_RULES_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return []
    rules = data.get("allow") if isinstance(data, dict) else None
    return [r for r in rules if isinstance(r, str)] if isinstance(rules, list) else []


def keep_web_rule(c: str, rule: str) -> None:
    """Keep `rule` for workspace `c`, so no session of it asks for it again."""
    rules = web_rules(c)
    if rule not in rules:
        atomic_write_text(config.registry_dir(c) / WEB_RULES_FILE, json.dumps({"allow": [*rules, rule]}, indent=1) + "\n")


def wait_words(seconds: float) -> str:
    """A wait in words: `a minute`, `10 minutes`, or `90 seconds` for one that is no whole number of minutes."""
    if seconds < 60 or seconds % 60:
        return f"{seconds:g} seconds"
    return "a minute" if seconds == 60 else f"{seconds / 60:g} minutes"


def timed_out_line(seconds: float) -> str:
    """TIMED_OUT_LINE for a wait of `seconds`."""
    return TIMED_OUT_LINE.format(wait=wait_words(seconds))


def timed_out(answer: dict[str, Any]) -> bool:
    """Whether `answer`, what ask returned, denies the call because nobody answered in time (TIMED_OUT_LINE)."""
    head = TIMED_OUT_LINE.split("{wait}", 1)[0]
    return answer.get("behavior") == "deny" and str(answer.get("message") or "").startswith(head)


async def ask(c: str, key: str | None, tool_name: str, inp: Any, agent_id: str | None = None,
              agent_type: str | None = None, suggestions: Any = None, force: bool = False,
              why: str = "") -> dict[str, Any]:
    """One permission request of the session `key` or of its subagent or workflow agent `agent_id`; the answer as
    Claude Code reads it. In Bypass it is allowed at once, as is a web call the workspace's kept rules allow; a web call
    joins a waiting request for the same site or for search; otherwise it waits on the chat until the analyst answers
    or the card's wait passes (userconf.card_wait_s). `suggestions` become the card's "don't ask again" choice, and a
    web call's is the site's rule, or web search's, for the workspace. `force` asks the analyst in every mode, as a call
    thimble's config sends to them, with `why` as the card's reason, and nothing noted when it is denied unanswered
    (dev's code-ticket question)."""
    run = asker(c, key)
    if run is None:
        return {"behavior": "deny", "message": GONE_LINE}
    granted = {"behavior": "allow", "updatedInput": inp if isinstance(inp, dict) else {}}
    verdict = "ask" if force else run.config.verdict(tool_name, inp) if run.config is not None else ""
    if verdict == "deny":
        agents.log_permission(c, "answered", chat=run.chat, session=key, tool=tool_name, what=_what(tool_name, inp),
                              agent_id=agent_id, answer="deny: thimble's config")
        return {"behavior": "deny", "message": CONFIG_DENIED_LINE}
    if verdict == "own":
        return granted
    web = web_rule(tool_name, inp)

    def at_once() -> dict[str, Any] | None:
        """granted in Bypass or for a web call the workspace's kept rules allow, else None; never for a call thimble's
        config sends to the analyst."""
        kept = web is not None and web in web_rules(c)
        if verdict == "ask" or not (kept or run.mode == BYPASS):
            return None
        agents.log_permission(c, "answered", chat=run.chat, session=key, tool=tool_name, what=_what(tool_name, inp),
                              agent_id=agent_id, answer="allow: kept for the workspace" if kept else "allow: Bypass")
        return granted

    if (now := at_once()) is not None:
        return now
    also, tried = _also_text(tool_name, inp), set()
    while (also is not None and (first := run.groups.get(web) if web else None) is not None and first not in tried
           and first in run.waits and not run.waits[first].done() and len(_also(run, first)) < WEB_ALSO_MAX):
        tried.add(first)
        if (joined := await _join(run, first, also, tool_name, inp, agent_id, granted)) is not None:
            return joined
    # a joined call asked on its own: the switch to Bypass or the kept rule that allowed its request may cover it
    if tried and (now := at_once()) is not None:
        return now
    rid = uuid.uuid4().hex[:10]
    whole = json.dumps(inp, ensure_ascii=False, default=str) if inp is not None else ""
    command = _command(tool_name, inp)
    cut = _cut(tool_name, inp, whole)
    updates = [] if cut or rules_ignored() else web_offer(web) if web else offer(suggestions)
    limit = userconf.card_wait_s()
    entry = {"id": rid, "tool": tool_name, "what": _what(tool_name, inp), "input": whole[:PERMISSION_INPUT_CHARS],
             "since": _now(), **command, **({"cut": cut} if cut else {}),
             **(_asker(run, agent_id, agent_type) if agent_id else {}),
             **_offered(updates), "wait_s": limit, **({"why": why} if why else {}),
             **({"asked_by": run.config.ask_cause(tool_name, inp)} if verdict == "ask" and not force
                and run.config is not None else {}),
             "mode": run.mode}
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    run.waits[rid] = fut
    run.asking[rid] = (agent_id or None, tool_name)
    if verdict == "ask":
        run.forced.add(rid)
    if web:
        run.groups[web] = rid
    if updates:
        run.offers[rid] = updates
    # logged before the card shows it, so whatever answers it, from any thread, is logged after it
    agents.log_permission(c, "asked", chat=run.chat, session=key, **entry)
    agents.update_agent(c, run.chat, permissions=[*_pending(c, run.chat), entry])
    chosen: list[dict[str, Any]] | None = None
    try:
        try:
            allow = await asyncio.wait_for(asyncio.shield(fut), limit)
        except asyncio.TimeoutError:
            allow = TIMED_OUT
            if not fut.done():
                fut.set_result(TIMED_OUT)
    except asyncio.CancelledError:  # the server stops
        agents.log_permission(c, "answered", id=rid, chat=run.chat, answer=NOBODY_WAITS)
        raise
    finally:
        if not fut.done():
            fut.set_result(None)
        run.waits.pop(rid, None)
        run.asking.pop(rid, None)
        run.forced.discard(rid)
        chosen = run.offers.pop(rid, None)
        if web and run.groups.get(web) == rid:
            run.groups.pop(web, None)
        with contextlib.suppress(Exception):
            _off_card(run, rid, fut.result() == TIMED_OUT)
    message = _deny_message(run, allow, limit)
    if allow == ALWAYS and chosen:
        told = _add_rules(run, chosen)
        agents.log_permission(c, "answered", id=rid, chat=run.chat,
                              answer=f"allow, don't ask again: {offer_text(chosen)}")
        return {**granted, "updatedPermissions": told} if told else granted
    agents.log_permission(c, "answered", id=rid, chat=run.chat, answer=_answer_word(allow))
    return granted if allow in (True, ALWAYS, COVERED) else {"behavior": "deny", "message": message}


def _also_text(tool_name: str, inp: Any) -> str | None:
    """A web call's address, or its search, whole, as the card lists a call that joins a waiting request; None for one
    past ALSO_CHARS."""
    text = (inp if isinstance(inp, dict) else {}).get("url" if tool_name == "WebFetch" else "query")
    return text if isinstance(text, str) and text.strip() and len(text) <= ALSO_CHARS else None


def _also(run: Run, rid: str) -> list[str]:
    """The later calls listed on the card of the waiting request `rid`."""
    return next((p.get("also") or [] for p in _pending(run.c, run.chat) if p.get("id") == rid), [])


async def _join(run: Run, first: str, what: str, tool_name: str, inp: Any, agent_id: str | None,
                granted: dict[str, Any]) -> dict[str, Any] | None:
    """A web call whose site, or search, a waiting request `first` of the same session asks for already: `what` is
    listed on that request's card (`also`) and the call gets its answer. None when it must be asked on its own: it could
    not be listed, or the analyst allowed `first` before the card showed it."""
    fut = run.waits[first]
    at = len(_also(run, first))
    wait = next((p.get("wait_s") for p in _pending(run.c, run.chat) if p.get("id") == first), None)
    try:
        agents.update_agent(run.c, run.chat, permissions=[
            {**p, "also": [*(p.get("also") or []), what]} if p.get("id") == first else p
            for p in _pending(run.c, run.chat)])
    except Exception:  # noqa: BLE001 — unlisted, it is asked on its own
        return None
    agents.log_permission(run.c, "asked", chat=run.chat, session=run.key, tool=tool_name, what=what, agent_id=agent_id,
                          joined=first)
    allow = await asyncio.shield(fut)
    allow = True if allow in (ALWAYS, COVERED) else allow
    if allow is True and at >= run.shown.get(first, 0):
        return None
    return granted if allow is True else {"behavior": "deny",
                                          "message": _deny_message(run, allow, wait or userconf.card_wait_s())}


def _deny_message(run: Run, allow: Any, wait_s: float) -> str:
    """What Claude Code tells the model of a request that ended with `allow` (when it is a deny), one that waited
    `wait_s` when nobody answered it in time."""
    if allow == TIMED_OUT:
        return timed_out_line(wait_s)
    return GONE_LINE if allow is None else DENIED_LINE


def _off_card(run: Run, rid: str, expired: bool) -> None:
    """The request `rid` leaves the chat's card, or stays on it marked `expired` when nobody answered it in time."""
    pending = _pending(run.c, run.chat)
    if expired:
        pending = [{**p, "expired": _now()} if p.get("id") == rid else p for p in pending]
    else:
        pending = [p for p in pending if p.get("id") != rid]
    agents.update_agent(run.c, run.chat, permissions=pending)


def _command(tool_name: str, inp: Any) -> dict[str, str]:
    """A Bash request's command whole, up to PERMISSION_INPUT_CHARS, which the card shows as code rather than the
    input's JSON; {} for any other call."""
    cmd = inp.get("command") if tool_name == "Bash" and isinstance(inp, dict) else None
    return {"command": cmd[:PERMISSION_INPUT_CHARS]} if isinstance(cmd, str) and cmd.strip() else {}


def _cut(tool_name: str, inp: Any, whole: str) -> int:
    """The length of what the card shows of a request when PERMISSION_INPUT_CHARS cuts it (a Bash request's command,
    else the input's JSON `whole`), 0 when it shows all of it."""
    shown = (inp.get("command") if _command(tool_name, inp) else None) or whole
    return len(shown) if len(shown) > PERMISSION_INPUT_CHARS else 0


def _asker(run: Run, agent_id: str, agent_type: str | None) -> dict[str, Any]:
    """Who asks, when a subagent or a workflow agent of the session does: its id and type as the hook gives them."""
    return {"agent_id": agent_id, "agent_type": agent_type}


def rules_ignored() -> bool:
    """Whether the org's managed tier sets allowManagedPermissionRulesOnly (module note, don't ask again), under which
    the card offers no "don't ask again"."""
    return cc_plugin.managed_rules_only({config.CONFIG_DIR_ENV: str(config.claude_config_dir())})


def offer(suggestions: Any) -> list[dict[str, Any]]:
    """The updates of a request's permission_suggestions the card offers as "don't ask again": its allow rules, working
    directories and a switch to acceptEdits, each for the session alone (`destination` session); [] when it suggests none."""
    return allowing(suggestions, keep=False)


def _offered(updates: list[dict[str, Any]]) -> dict[str, str]:
    """The card's words for a request's "don't ask again": `keep`, the site or `web search`, for a web rule kept for the
    workspace, else `always`, what it adds for the session (offer_text); {} for none."""
    if not updates:
        return {}
    if all(u.get("destination") == WORKSPACE for u in updates):
        rule = updates[0]["rules"][0]
        return {"keep": str(rule.get("ruleContent") or "").removeprefix("domain:") or "web search"}
    return {"always": offer_text(updates)}


def with_rules(argv: list[str], rules: list[dict[str, Any]]) -> list[str]:
    """`argv` with the "don't ask again" updates `rules` in it: each allow rule in --settings' `permissions.allow`, each folder in
    `permissions.additionalDirectories`, and acceptEdits as its --permission-mode where that would be manual mode."""
    out = list(argv)
    allow = [rule_text(r) for u in rules if u["type"] == "addRules" for r in u["rules"]]
    dirs = [d for u in rules if u["type"] == "addDirectories" for d in u["directories"]]
    if (allow or dirs) and "--settings" in out:
        at = out.index("--settings") + 1
        given = json.loads(out[at])
        perms = dict(given.get("permissions") or {})
        if allow:
            perms["allow"] = list(dict.fromkeys([*(perms.get("allow") or []), *allow]))
        if dirs:
            perms["additionalDirectories"] = list(dict.fromkeys([*(perms.get("additionalDirectories") or []), *dirs]))
        out[at] = json.dumps({**given, "permissions": perms})
    if any(u["type"] == "setMode" for u in rules) and "--permission-mode" in out:
        at = out.index("--permission-mode") + 1
        out[at] = EDIT_MODE if out[at] == "default" else out[at]
    return out


def dismiss(c: str, chat: str, request_id: str) -> bool:
    """Take a request no session waits on off the card of the chat `chat`: True for one denied unanswered, False for one
    whose wait is gone (module note, permissions), which no answer reaches, and for none by that id."""
    pending = _pending(c, chat)
    hit = next((p for p in pending if p.get("id") == request_id), None)
    if hit is None:
        return False
    agents.update_agent(c, chat, permissions=[p for p in pending if p.get("id") != request_id])
    if not hit.get("expired"):
        agents.log_permission(c, "answered", id=request_id, chat=chat, answer=NOBODY_WAITS)
    return bool(hit.get("expired"))


def _add_rules(run: Run, updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The analyst chose a request's "don't ask again": a web rule is kept for the workspace (keep_web_rule), and each
    other update is the session's from now on (its chat's meta); each other waiting request with the same
    offered updates is allowed, in every session of the workspace for a web rule. Returns the session's updates, which
    Claude Code is told."""
    kept = [u for u in updates if u.get("destination") == WORKSPACE]
    told = [u for u in updates if u.get("destination") != WORKSPACE]
    for rule in (r for u in kept for r in u["rules"]):
        keep_web_rule(run.c, rule_text(rule))
    if told:
        run.rules.extend(u for u in told if u not in run.rules)
        with contextlib.suppress(Exception):
            agents.update_agent(run.c, run.chat, **{RULES_KEY: [{"text": offer_text([u]), "update": u} for u in run.rules]})
    others = [r for (cc, _), r in list(_hosted.items()) if cc == run.c and r is not run] if kept else []
    for r in [run, *others]:
        for rid, offered in list(r.offers.items()):
            fut = r.waits.get(rid)
            if offered == updates and fut is not None and not fut.done():
                fut.set_result(COVERED)
    return told


def kept_rules(c: str, chat: str | None) -> list[dict[str, Any]]:
    """The "don't ask again" updates the analyst chose in the session whose chat is `chat`, for a process that resumes
    it (start)."""
    meta = agents.meta_or_none(c, chat) if chat else None
    kept = (meta or {}).get(RULES_KEY)
    if not isinstance(kept, list):
        return []
    return [r["update"] for r in kept if isinstance(r, dict) and isinstance(r.get("update"), dict)]


def _answer_word(allow: Any) -> str:
    """How a request ended, for the permission log (agents.log_permission)."""
    if allow is True:
        return "allow"
    if allow == COVERED:
        return "allow: covered by a rule added for this session"
    if allow == TIMED_OUT:
        return "deny: nobody answered in time"
    if allow is None:
        return "none: the session ended"
    return "deny"


def answer(c: str, chat: str, request_id: str, allow: bool, always: bool = False, shown: int = 0) -> bool:
    """The analyst's answer to a pending request of the session whose chat is `chat`, `always` for the card's "don't
    ask again", which allows it with the updates offered for it (module note, don't ask again), covering the first
    `shown` calls that joined it (module note, the web); for a request no session waits on, its removal from the card
    (dismiss). False when no session waits on a request by that id."""
    run = _by_chat(c, chat)
    fut = run.waits.get(request_id) if run is not None else None
    if run is None or fut is None or fut.done():
        return dismiss(c, chat, request_id)
    run.shown[request_id] = shown
    fut.set_result(ALWAYS if allow and always and run.offers.get(request_id) else bool(allow))
    return True


class PermissionAnswer(BaseModel):
    id: str
    allow: bool
    always: bool = False  # the card's "don't ask again"
    shown: int = 0  # how many of the calls that joined it the card listed


@router.post("/ws/{c}/chats/{chat}/permission")
async def permission_route(c: str, chat: str, body: PermissionAnswer, request: Request) -> dict[str, Any]:
    """The analyst's answer on a session's card: answer. 403 for a request that is not the analyst's browser's
    (hook_auth.analyst), 404 when no such request waits."""
    if not hook_auth.analyst(request):
        raise HTTPException(403, hook_auth.ANALYST_ONLY)
    if not answer(c, chat, body.id, body.allow, body.always, body.shown):
        raise HTTPException(404, "no such permission request is waiting")
    return {"answered": body.id, "allow": body.allow}


async def shutdown() -> None:
    """The server is going down: what each hosted session waits on ends unanswered."""
    for key in list(_hosted):
        unhost(*key)


def _clear_left(c: str, metas: "list[dict[str, Any]]") -> list[str]:
    """Take the requests a previous server left waiting off the chats `metas` of workspace `c` (module note, hosted
    sessions): their hooks lost the connection, so Claude Code went on without an answer. A request a session of this
    server waits on stays, a request denied unanswered stays until dismissed, and main's stay, which events.py relays
    and drops. Returns their ids."""
    live = {rid for r in _hosted.values() for rid in r.waits}
    gone: list[str] = []
    for meta in metas:
        if meta.get("kind") == agents.KIND_MAIN or meta.get("id") == agents.MAIN_ID:
            continue
        if not any(isinstance(p, dict) and not p.get("expired") for p in meta.get("permissions") or []):
            continue
        chat = str(meta["id"])
        pending = _pending(c, chat)
        left = [p for p in pending if p.get("expired") or p.get("id") in live]
        if len(left) == len(pending):
            continue
        agents.update_agent(c, chat, permissions=left)
        for p in pending:
            if p not in left:
                gone.append(str(p.get("id")))
                agents.log_permission(c, "answered", id=p.get("id"), chat=chat, answer=NOBODY_WAITS)
    return gone


async def recover() -> list[str]:
    """Server start: the requests a previous server left waiting on the chats of every workspace are taken off
    (_clear_left). Returns `<workspace>/<request id>` per request."""
    out: list[str] = []
    root = config.WORKSPACES_DIR
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        try:
            out += [f"{folder.name}/{x}" for x in _clear_left(folder.name, agents.list_chats(folder.name))]
        except Exception:  # noqa: BLE001 — a workspace whose corpus is gone, or one that cannot be read
            log.debug("%s: its chats' requests were not checked at start", folder.name, exc_info=True)
    return out


@contextlib.asynccontextmanager
async def _lifespan(app: Any):
    """The router's lifespan: at start a task takes off the requests a previous server left waiting (recover)."""
    task = asyncio.get_running_loop().create_task(_recover_logged(), name="agent-session-recover")
    try:
        yield
    finally:
        task.cancel()


async def _recover_logged() -> None:
    try:
        gone = await recover()
        if gone:
            log.info("permission requests a previous server left waiting, taken off: %s", ", ".join(gone))
    except Exception:  # noqa: BLE001 — never fails the start
        log.exception("taking off the requests a previous server left waiting failed")


router.lifespan_context = _lifespan
