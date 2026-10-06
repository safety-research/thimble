"""thimble's agents in the analyst's terminal: the orientation, its critic and the writers, which run as `claude -p`
sessions beside main (agent_session.py). Each shows in main's agent tray as a tray entry, the statusline and
/thimble:agents list them, and main's terminal prints a line when each starts and when each run ends.

Names. Each agent is named as `thimble:<role> · <workspace>` (name_of, config.session_name): thimble:orient · <c>,
thimble:writer · <c> (the report's; another document's is thimble:writer-<doc> · <c>) and thimble:critic · <c>. The
name, spaces and `·` included, is the agent's address everywhere: the tray entry's Agent call names it as its
description, and wait_session's `session` names it. ListAgents writes `  ·  ` between a row's fields, so a name copied
from it can lose its workspace; main's instructions give it the whole name. A long name has its workspace shortened
(config.session_name), and by_name also takes the role before any separator a model wrote in place of ` · `. The
workspace's own lines (the statusline, the news) show the role alone (config.session_role).

Entries. agent_session records an entry when it starts a run of one of these sessions (record), tells it of each
prompt it writes on the process's stdin (prompted), and tells it when the run ends (run_ended) or is left for the next
server or for main's return (run_left). A session's process lives for one run: a follow-up or a retry starts it again
with `--resume`, which continues the same session, so it is a new run of the same entry, whose news goes on from where
it was. A run that ends leaves its entry for FINISHED_AFTER_S, so a run that follows at once, such as a queued
follow-up, keeps its tray entry; after that the entry has finished, and its tray entry ends. REGISTRY_FILE keeps the
entries across server restarts.

The tray entry. For each running agent main runs a thin background subagent of the plugin (plugin/agents:
thimble:orient, thimble:writer, thimble:critic), which reads its instructions from proxy_file and loops on the
`wait_session` tool until the agent's run ends: the tool returns the agent's news (below) as one block of lines, which
the entry copies into its reply word for word, one reply per call. A message that reaches the entry, typed in its view
or sent by main with SendMessage, is passed on by the server (pass_on): to the orientation as a follow-up
(orient_session.message, which waits for a run that goes), to a writer the same way (write_session.message), and from
the critic's entry to the orientation, since a critique takes no message while it runs. Two plugin hooks keep it
reliable: when the entry would stop while its agent works (proxy_stop), the hook sends it back to waiting, and main's
Agent call that would start a second entry for an agent is refused (agent_check). Main is asked to start an entry
while a run goes and none runs, unless Claude Code refused its call for that agent (proxy_refused).

The news. What the analyst would see of a subagent, read from the session's transcript in its order (_read_news, which
keeps an offset past the last whole line it read, so no line shows twice): each reply as `<name>: <text>` (NEWS_CHARS, a
longer one keeps its start and says how much was cut), each tool call as `● <tool>: <what it acts on>` (a thimble tool
by its bare name, a card tool by its card's question, an Agent call by its subagent type and description, a Bash call by
its command's first line, a file tool by its path; _call_words, TOOL_CHARS), each failed result as `✗ <tool>: <the
error's first line>` (`✗ tool:` when its call came before a server restart, since the calls' names are not kept), each
interrupted turn as `<name> was interrupted.`, and each message as `✉ <sender> → <recipient>: <text>` (MESSAGE_CHARS):
those it sends with SendMessage, and those it gets (a subagent's hand-back, a finished background task, the prompts
thimble starts and resumes it with). Claude Code's own records (meta prompts, command output, system records) give
none. To this the watcher adds that the agent waits for a permission on its card, and run_ended the end of each run. A
waiting wait_session reads the transcript every NEWS_POLL_S and returns once there is news, so a tool call shows in the
tray within about NEWS_POLL_S + NEWS_GATHER_S and the entry's turn; one answer holds at most NEWS_RETURN_CHARS of news,
the rest coming with the next. The whole session shows in its thread in the browser.

The watcher. One task per server, every POLL_S while an entry has not finished: it reads each agent's transcript for the
news, notes when the agent starts or stops waiting for a permission, and asks main for a tray entry an agent with a run
open lacks.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import textwrap
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from . import agents, calls, cite, config, ledger, session

log = logging.getLogger("thimble.tray")
router = APIRouter()

REGISTRY_FILE = "tray.json"  # in the workspace: the agents' entries, kept across restarts
PROXY_DIR = "bg"  # in the workspace: each tray entry's instructions (proxy_file)
POLL_S = 1.5
# the longest a wait_session call waits for news; a message typed in the tray entry's view reaches it only after that
# call returns, so this bounds how long such a message waits
WAIT_S = 6.0
PROXY_ALIVE_S = 90.0  # a tray entry that has not called wait_session for this long is taken for gone
PROXY_ASK_S = 120.0  # how long main's start of a tray entry is waited for before main is asked again
# how long after its run ended an entry counts as still at its task (finished), so a run that follows at once, such as
# a queued follow-up, keeps its tray entry
FINISHED_AFTER_S = 15.0
NEWS_CHARS = 4_000  # of one reply of the session in its news; a longer one keeps its start and says how much was cut
TOOL_CHARS = 140  # of what a tool call's news line shows of the call, and of a failed call's error
MESSAGE_CHARS = 400  # of a message to or from the session, as its news line shows it
NEWS_POLL_S = 0.4  # how often a waiting wait_session reads the session's transcript for news
NEWS_GATHER_S = 0.3  # how long wait_session waits after the first news for the lines that come with it
CALLS_KEEP = 256  # the session's newest tool calls whose names its news keeps, for their results that come later
NEWS_KEEP = 200  # news lines that wait for a tray entry; older ones are dropped (_news)
HEARD_KEEP = 16  # the session's newest messages its news keeps, so a message in two shapes shows once
PROMPT_KEY = 200  # characters of a prompt thimble gave a session that tell it from another message (_message)
CALL_KEYS = ("question", "name", "title", "doc", "span", "ref", "card", "thread", "label", "query", "url", "path",
             "file_path", "pattern", "description", "command", "prompt", "text", "message")  # _call_words, in order
# main's SendMessage to the session, as its queued command or prompt carries it (origin coordinator)
COORDINATOR_RE = re.compile(r"^[^\n]*sent a message while you were working:\n(.*?)(?:\n\nAddress this.*)?\Z", re.S)
NEWS_RETURN_CHARS = 10_000  # of the news one wait_session returns; the rest waits for the next call
HANDBACK_RE = re.compile(r"\A\[Subagent hand-back\].*?follows:\n", re.S)  # the harness's lead of a hand-back
SUMMARY_RE = re.compile(r"<summary>(.*?)</summary>", re.S)  # of a task notification
ERROR_TAG_RE = re.compile(r"</?tool_use_error>")
BLOCKS_MAX = 12  # stops of a tray entry refused in a row with no wait_session between them, after which it may stop
# the plugin agent that shows each kind of session in the agent tray (plugin/agents)
PROXY_TYPES = {"orient": "orient", "writer": "writer", "critique": "critic"}
ANNOUNCED_FILE = "tray-announced.json"  # in the workspace: the start and finish lines main's terminal has shown
FORK_DEDUPE_S = 600.0  # how long a thread's fork counts as starting, until the mirror sees it finish
STATUS_CHARS = 110  # of one statusline line; more agents go on further lines
WAITING_LINE = "{name} waits for a permission; answer it on its card in the browser."
# the line that ends a run's news, by how the run ended (run_ended)
END_LINES = {"done": "{name} finished its task", "stopped": "{name} was stopped", "failed": "{name} failed"}


def _plugin() -> str:
    from . import orientation  # noqa: PLC0415 — orientation imports this module's callers

    return orientation.PLUGIN


def kind_of(key: str) -> str:
    return key.split(":", 1)[0]


def shown_in_tray(key: str) -> bool:
    """Whether the session `key` shows in the agent tray: the orientation's, a critique's and a writer's."""
    return kind_of(key) in PROXY_TYPES


def name_of(c: str, key: str) -> str:
    """The name the agent `key` in workspace `c` shows under (module note, names): thimble:orient · <c>,
    thimble:writer · <c> (the report's), thimble:writer-<doc> · <c>, thimble:critic · <c>."""
    kind, _, rest = key.partition(":")
    if kind == "writer":
        role = "writer" if rest in ("", "report") else f"writer-{rest}"
    else:
        role = PROXY_TYPES.get(kind, kind)
    return config.session_name(role, c)


def label_of(key: str) -> str:
    """The agent `key` as /thimble:agents lists it: orientation, critic, writer (the report's), writer: <doc>."""
    kind, _, rest = key.partition(":")
    if kind == "writer":
        return "writer" if rest in ("", "report") else f"writer: {rest}"
    return {"orient": "orientation", "critique": "critic"}.get(kind, kind)


def proxy_type(key: str) -> str:
    """The plugin agent that shows the session in the agent tray, as main's Agent call names it."""
    return f"{_plugin()}:{PROXY_TYPES.get(kind_of(key), 'orient')}"


# --------------------------------------------------------------------------- the registry


@dataclass
class Entry:
    """An agent of thimble's as its tray entry shows it."""

    c: str
    key: str
    name: str
    sid: str
    chat: str
    role: str
    folder: str
    started: float = field(default_factory=time.time)
    status: str = "working"  # working | waiting while a run goes; done | stopped | failed | parked after it
    run_open: bool = True  # a run of the session goes now
    result: str = ""  # the last run's summary
    ended_at: float = 0.0
    offset: int = 0  # of its transcript, read for the tray entry's news
    news: list[str] = field(default_factory=list)
    dropped: int = 0  # news lines dropped since the last wait_session, since no tray entry took them (_news)
    tx_path: str = ""  # its transcript, as _transcript found it for the session id tx_sid
    tx_sid: str = ""
    calls: dict[str, str] = field(default_factory=dict)  # tool_use_id -> tool name of its newest calls (CALLS_KEEP)
    heard: list[tuple[str, str, str]] = field(default_factory=list)  # (uuid, text, shape) of its newest messages
    prompts: list[str] = field(default_factory=list)  # the starts of the prompts thimble gave it on stdin (prompted)
    proxy_seen: float = 0.0  # time.monotonic() of the tray entry's last wait_session call
    proxy_asked: float = 0.0  # time.monotonic() when main was last asked to start the tray entry, 0.0 before it is asked
    proxy_agents: list[str] = field(default_factory=list)  # agent ids of the tray entries main started for it
    relayed: list[str] = field(default_factory=list)  # the uuids of the messages its tray entries passed on already
    blocks: int = 0  # stops of its tray entry refused since its last wait_session
    owner: str | None = None  # the agent id of the tray entry that shows it; another one is told to stop (wait)
    proxy_starting: float = 0.0  # time.monotonic() when main's Agent call that starts its tray entry was let through
    last_said: str = ""  # its last reply as its news gave it, which the news of its run's end does not repeat
    proxy_refused: bool = False  # Claude Code refused main's Agent call that would start its tray entry (proxy_refused)

    KEEP = ("c", "key", "name", "sid", "chat", "role", "folder", "started", "status", "run_open", "result", "ended_at",
            "proxy_agents", "relayed", "proxy_refused")

    @property
    def shown(self) -> str:
        """The agent's name as the workspace's own lines show it: its role alone (module note, names)."""
        return config.session_role(self.name)

    @property
    def short(self) -> str:
        """The start of its session id, which the terminal's start and finish lines are kept by (agents_route)."""
        return self.sid[:8]

    def saved(self) -> dict[str, Any]:
        d = asdict(self)
        return {k: d[k] for k in self.KEEP}


_entries: dict[tuple[str, str], Entry] = {}  # (workspace, key) -> the entry
_loaded: set[str] = set()
_changed = asyncio.Event()  # set on each news line and state change, for wait_session
_task: asyncio.Task | None = None
_closing = False  # the server is going down: waits return at once
_passing: set[asyncio.Task] = set()  # the messages being passed on (pass_on)


def _load(c: str) -> None:
    if c in _loaded:
        return
    _loaded.add(c)
    try:
        rows = json.loads((config.workspace_dir(c) / REGISTRY_FILE).read_text("utf-8"))
    except (OSError, ValueError, Exception):  # noqa: BLE001 — a workspace that is gone or cannot be read keeps none
        rows = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not row.get("key") or not row.get("sid"):
            continue
        with contextlib.suppress(TypeError):
            e = Entry(**{k: row[k] for k in Entry.KEEP if k in row})
            if e.run_open:  # a run is followed again only once agent_session resumes it
                e.run_open, e.status = False, "parked"
                e.proxy_asked = time.monotonic()  # its tray entry, which may still run, gets PROXY_ASK_S to call again
            path = session.find_transcript(e.sid)
            e.offset = session._size(Path(path)) if path else 0  # the tray entry's news starts now
            _entries[(c, e.key)] = e


def _save(c: str) -> None:
    rows = [e.saved() for (cc, _), e in _entries.items() if cc == c]
    try:
        ledger.atomic_write_text(config.workspace_dir(c) / REGISTRY_FILE, json.dumps(rows, indent=1))
    except (OSError, Exception):  # noqa: BLE001 — a workspace deleted under the watcher
        log.debug("%s: the tray entries were not saved", c, exc_info=True)


def entry(c: str, key: str) -> Entry | None:
    _load(c)
    return _entries.get((c, key))


def entries(c: str | None = None) -> list[Entry]:
    if c is not None:
        _load(c)
    return [e for (cc, _), e in list(_entries.items()) if c is None or cc == c]


REF_RE = re.compile(r"\s+\[[0-9A-Za-z]+\]\Z")  # the ` [ref]` a name copied from ListAgents may carry
# where a name's role ends however its separator was written (`thimble:writer - mini`, `thimble:writer·mini`), for by_name
ROLE_END_RE = re.compile(r"\s|[·•]")


def by_name(c: str, name: str, exact: bool = False) -> Entry | None:
    """The agent of workspace `c` that `name` names: its name, without a ` [ref]` after it (REF_RE), ignoring case;
    unless `exact`, also its role (config.session_role, such as `thimble:writer`, which only one agent of the workspace
    has), alone or followed by the workspace after any separator (ROLE_END_RE), its key or the start of its session id."""
    want = REF_RE.sub("", str(name or "").strip()).lower()
    if not want:
        return None
    hit = next((e for e in entries(c) if e.name.lower() == want), None)
    if hit is not None or exact:
        return hit
    role = ROLE_END_RE.split(want, maxsplit=1)[0]
    return next((e for e in entries(c) if want in (e.key.lower(), e.short) or config.session_role(e.name).lower() == role),
                None)


def _slug(name: str) -> str:
    return re.sub(r"[^0-9a-z]+", "-", name.lower()).strip("-")


def by_origin(c: str, name: str) -> Entry | None:
    """The agent of workspace `c` a peer message's origin `name` names (session._peer): as by_name takes it, else with
    its first `-` read as `:` or compared as a slug (`thimble-writer-mini` for `thimble:writer · mini`)."""
    hit = by_name(c, name) or by_name(c, name.replace("-", ":", 1))
    want = _slug(name)
    return hit or next((e for e in entries(c) if want and want in (_slug(e.name), _slug(config.session_role(e.name)))), None)


def resting(e: Entry | None) -> bool:
    """Whether the agent has no run going."""
    return e is not None and not e.run_open


def finished(e: Entry | None) -> bool:
    """Whether a resting agent has finished its task: its run ended FINISHED_AFTER_S ago and no run followed, so a run
    that follows at once keeps its tray entry. Its tray entry ends."""
    return resting(e) and time.time() - e.ended_at >= FINISHED_AFTER_S  # type: ignore[union-attr]


def alive(e: Entry | None) -> bool:
    """Whether the agent's tray entry still has something to show: a run goes, or one ended a moment ago."""
    return e is not None and not finished(e)


# --------------------------------------------------------------------------- runs (agent_session)


def record(c: str, key: str, *, sid: str, chat: str, role: str, folder: Path, prompt: str = "") -> Entry:
    """A run of the session `key` starts, of the session `sid` in the chat `chat` (module note, entries). A session not
    followed before has its news read from where its transcript ends now (the start for a new session); a later run of
    the same session goes on from where the last one left off. The entry of an earlier session of `key` hands its tray
    entries on."""
    _load(c)
    old = _entries.get((c, key))
    e = old if old is not None and old.sid == sid else Entry(c, key, name_of(c, key), sid, chat, role, str(folder))
    if old is not None and old is not e:
        e.proxy_agents, e.proxy_seen, e.owner, e.relayed = old.proxy_agents, old.proxy_seen, old.owner, old.relayed
        e.proxy_asked, e.proxy_refused = old.proxy_asked, old.proxy_refused
    if e is not old:
        path = session.find_transcript(sid)
        e.offset = session._size(Path(path)) if path else 0
    e.chat, e.role, e.folder, e.status, e.run_open, e.started = chat, role, str(folder), "working", True, time.time()
    _entries[(c, key)] = e
    if prompt.strip():
        prompted(c, key, prompt)
    _save(c)
    _changed.set()
    _ensure_watcher()
    return e


def prompted(c: str, key: str, text: str) -> None:
    """thimble wrote `text` on the stdin of the session `key`: its copy in the transcript shows as thimble's message
    (_message)."""
    e = entry(c, key)
    if e is not None and text.strip():
        e.prompts = [*e.prompts, _norm(text)[:PROMPT_KEY]][-HEARD_KEEP:]


def run_ended(c: str, key: str, status: str, summary: str) -> None:
    """The run of the session `key` ended with `status` (done, stopped or failed): its news ends with a line that says
    so, after the transcript's last lines."""
    e = entry(c, key)
    if e is None:
        return
    with contextlib.suppress(Exception):
        _read_news(e)
    e.run_open = False
    e.status = status if status in END_LINES else "failed"
    e.result = " ".join(str(summary or "").split())[:400]
    e.ended_at = time.time()
    said = cite.to_links(e.result)
    line = END_LINES[e.status].format(name=e.shown)
    _news(e, line + (f": {said}" if said and not e.last_said.startswith(said[:200]) else "."))
    _save(c)


def run_left(c: str, key: str) -> None:
    """The run of the session `key` was left for the next server or for main's return (agent_session, restart): its
    tray entry ends, with no line, and the run's resume starts it again."""
    e = entry(c, key)
    if e is None:
        return
    e.run_open, e.status = False, "parked"
    e.ended_at = time.time() - FINISHED_AFTER_S
    _changed.set()
    _save(c)


def forget(c: str, key: str) -> None:
    if _entries.pop((c, key), None) is not None:
        _save(c)


def _news(e: Entry, line: str) -> None:
    """A news line for the agent's tray entry; while no tray entry takes them, only the newest NEWS_KEEP wait, and the
    next wait_session says how many earlier ones were dropped."""
    e.news.append(line)
    if len(e.news) > NEWS_KEEP:
        e.dropped += len(e.news) - NEWS_KEEP
        del e.news[: len(e.news) - NEWS_KEEP]
    _changed.set()


def _waiting(e: Entry) -> bool:
    """Whether the agent's run waits for the analyst's answer to a permission request on its card."""
    from . import agent_session  # noqa: PLC0415 — agent_session imports this module

    run = agent_session.current(e.c, e.key)
    return run is not None and any(not f.done() for f in run.waits.values())


# --------------------------------------------------------------------------- the watcher


def _ensure_watcher() -> None:
    global _task
    if _task is not None and not _task.done():
        return
    with contextlib.suppress(RuntimeError):
        _task = asyncio.get_running_loop().create_task(_watch(), name="tray")


async def _watch() -> None:
    while not _closing and any(alive(e) for e in entries()):
        try:
            _tick()
        except Exception:  # noqa: BLE001 — the watcher never stops for one bad pass
            log.exception("the tray's watcher failed a pass")
        await asyncio.sleep(POLL_S)


def _tick() -> None:
    unshown: dict[str, list[str]] = {}
    for e in entries():
        if not alive(e):
            continue
        _read_news(e)
        if e.run_open:
            status = "waiting" if _waiting(e) else "working"
            if status != e.status:
                e.status = status
                if status == "waiting":
                    _news(e, WAITING_LINE.format(name=e.shown))
                _changed.set()
            if (not proxy_alive(e) and not e.proxy_refused
                    and (not e.proxy_asked or time.monotonic() - e.proxy_asked > PROXY_ASK_S)):
                unshown.setdefault(e.c, []).append(e.key)
    for c, keys in unshown.items():
        if ask_main_for_proxy(c, *keys):
            log.info("%s: main is asked to show %s in the agent tray", c, ", ".join(name_of(c, k) for k in keys))


# --------------------------------------------------------------------------- the news


def _read_news(e: Entry) -> None:
    """The session's transcript since the last read, as its proxy's news (module note, the news): each whole line
    after `e.offset`, which moves past it, so no line is read twice and a line Claude Code is still writing waits for
    the next read. A line that cannot be read is logged and skipped."""
    p = _transcript(e)
    if p is None:
        return
    size = session._size(p)
    if size <= e.offset:
        return
    try:
        with p.open("rb") as f:
            f.seek(e.offset)
            data = f.read(size - e.offset)
    except OSError:
        return
    cut = data.rfind(b"\n")
    if cut < 0:
        return
    e.offset += cut + 1
    for line in data[:cut].split(b"\n"):
        try:
            lines = _news_lines(e, line)
        except Exception:  # noqa: BLE001 — one odd record never costs the rest of the news, a wait or a watcher pass
            log.exception("%s: a line of %s's transcript could not be read for its news", e.c, e.name)
            continue
        for news in lines:
            _news(e, news)


def _transcript(e: Entry) -> Path | None:
    """The session's transcript, found once per session id and then kept, since wait_session reads it every
    NEWS_POLL_S."""
    if e.tx_path and e.tx_sid == e.sid and os.path.isfile(e.tx_path):
        return Path(e.tx_path)
    found = session.find_transcript(e.sid)
    e.tx_path, e.tx_sid = found or "", e.sid
    return Path(found) if found else None


def _news_lines(e: Entry, line: bytes) -> list[str]:
    """One line of the session's transcript as its news lines, in the order the record holds them: its replies, a line
    per tool call and per failed result, a line per message it got or sent (module note, the news), and a line when a
    turn was interrupted, which Claude Code writes as a prompt. Claude Code's own records (meta prompts, command output,
    system records, subagents' sidechains) give none."""
    if not line.strip():
        return []
    try:
        rec = session._load(line)
    except session.Unreadable:
        return []
    if rec.get("isSidechain"):
        return []
    t = rec.get("type")
    if t == "assistant":
        return _said(e, rec)
    if t == "user":
        if session.INTERRUPT_RE.match((session._user_text(rec) or "").strip()):
            return _failed(e, rec) + [f"{e.shown} was interrupted."]
        return _failed(e, rec) + _heard(e, rec)
    if t == "attachment":
        return _heard(e, rec)
    return []


def _said(e: Entry, rec: dict[str, Any]) -> list[str]:
    """An assistant record's news: each reply as `<name>: <text>` (clipped to NEWS_CHARS), each tool call as one line
    (_call_line)."""
    out: list[str] = []
    for b in session._content_list(rec):
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            text = cite.to_links(session.visible(str(b.get("text") or ""))).strip()
            if text:
                e.last_said = " ".join(text.split())
                out.append(f"{e.shown}: {_clip(text, NEWS_CHARS)}")
        elif b.get("type") == "tool_use" and isinstance(b.get("name"), str):
            name = b["name"]
            if isinstance(b.get("id"), str):
                e.calls[b["id"]] = name
                while len(e.calls) > CALLS_KEEP:
                    e.calls.pop(next(iter(e.calls)))
            said = _call_line(e, name, b.get("input") if isinstance(b.get("input"), dict) else {})
            if said:
                out.append(said)
    return out


def _call_line(e: Entry, name: str, inp: dict[str, Any]) -> str | None:
    """A tool call as one news line: `● <tool>: <what it acts on>` (_call_words), or `✉ <session> → <to>: <message>`
    for a SendMessage; None for Claude Code's plumbing (session.PLUMBING_TOOLS)."""
    if name in session.PLUMBING_TOOLS:
        return None
    if name == session.SEND_TOOL:
        to = str(inp.get("to") or inp.get("recipient") or "?")
        said = _one_line(_as_text(inp.get("message") or inp.get("content")), MESSAGE_CHARS)
        return f"✉ {e.shown} → {config.session_role(to)}: {said}"
    words = _one_line(_call_words(name, inp, e.folder, e.c), TOOL_CHARS)
    return f"● {_tool_name(name)}" + (f": {words}" if words else "")


def _tool_name(name: str) -> str:
    """A tool's name as its news line shows it: a thimble tool's bare name (add_card), another MCP server's tool as
    `<server>:<tool>`, a built-in tool's as it is."""
    if calls.is_thimble(name):
        return calls._short(name)
    if name.startswith("mcp__"):
        server, _, tool = name[len("mcp__"):].partition("__")
        return f"{server}:{tool}" if tool else server
    return name


def _call_words(name: str, inp: dict[str, Any], folder: str = "", c: str = "") -> str:
    """What a tool call acts on, as its news line shows it: an Agent call's subagent type and description, the skill
    of a Skill call, a Bash call's command's first line, the path or pattern of a file tool, the question (a card's
    title) of a card tool, a call that names only its card by that card's question as workspace `c` stores it
    (_card_title), and for any other tool the first of CALL_KEYS it has, or else its first short string. Paths in the
    session's folder are written relative to it."""
    short = _tool_name(name)
    s = {k: v.strip() for k, v in inp.items() if isinstance(v, str) and v.strip()}
    if name in session.AGENT_TOOLS:
        kind = s.get("subagent_type") or "subagent"
        return f"{kind} · {s['description']}" if s.get("description") else kind
    if name == "Skill":
        return " ".join(x for x in (s.get("skill"), s.get("args")) if x)
    if name == "Bash":
        return s.get("command", "").split("\n", 1)[0]
    if name == session.WORKFLOW_TOOL:
        meta = {k: v.strip() for k, _, v in session.WORKFLOW_META_RE.findall(s.get("script", "").split("}", 1)[0])}
        return meta.get("description") or meta.get("name") or s.get("name") or s.get("scriptPath") or ""
    if name in ("Read", "Edit", "Write", "MultiEdit", "NotebookEdit"):
        words = _relative(s.get("file_path") or s.get("notebook_path") or "", folder)
    elif name in ("Grep", "Glob"):
        where = _relative(s.get("path") or s.get("glob") or "", folder)
        words = s.get("pattern", "") + (f" in {where}" if where else "")
    elif short in session.CELL_TOOLS:
        card = s.get("card", "")
        words = s.get("question") or (_card_title(c, card) if card else "")
    else:
        key = next((k for k in CALL_KEYS if k in s), None) or \
            next((k for k, v in s.items() if len(v) <= TOOL_CHARS), None)
        words = s.get(key, "") if key else ""
    return words.split("\n", 1)[0]


def _card_title(c: str, card: str) -> str:
    """The question of the card `card` (card:<id> or its bare id) in workspace `c`, else `card` as it is: a card
    another agent deleted, or one that cannot be read."""
    from . import notebook  # noqa: PLC0415

    try:
        hit = notebook.find_cell(config.workspace_dir(c), card.removeprefix("card:")) if c else None
    except Exception:  # noqa: BLE001 — a news line never fails for a card it cannot read
        hit = None
    title = str((hit[1].get("title") if hit else "") or "").strip()
    return title or card


def _relative(path: str, folder: str) -> str:
    base = folder.rstrip("/") + "/" if folder else ""
    return path[len(base):] if base and path.startswith(base) else path


def _failed(e: Entry, rec: dict[str, Any]) -> list[str]:
    """A user record's failed tool results, each as `✗ <tool>: <the error's first line>`."""
    out: list[str] = []
    for b in session._content_list(rec):
        if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
            name = e.calls.get(str(b.get("tool_use_id") or ""), "")
            if name in session.PLUMBING_TOOLS:
                continue
            text = ERROR_TAG_RE.sub("", session.response_text(b.get("content"))).strip()
            first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "failed")
            out.append(f"✗ {_tool_name(name) if name else 'tool'}: {_one_line(first, TOOL_CHARS)}")
    return out


def _heard(e: Entry, rec: dict[str, Any]) -> list[str]:
    """A message the session got, as `✉ <sender> → <session>: <message>` (_message), once even when Claude Code writes
    it in two shapes, a queued command and then a prompt: the prompt carries the queued command's source_uuid as its
    uuid, or else the same text right after it (as _typed_messages takes a proxy's messages once). A prompt pairs with
    the queued command right before it only, so the same words sent again later, in either shape, show again."""
    got = _message(e, rec)
    if got is None:
        return []
    by, text = got
    norm = _norm(text)
    att = rec.get("attachment") if rec.get("type") == "attachment" and isinstance(rec.get("attachment"), dict) else {}
    uid, shape = str(att.get("source_uuid") or rec.get("uuid") or ""), "queued" if att else "prompt"
    last = e.heard[-1] if e.heard else ("", "", "")
    if not norm:
        return []
    copy = bool(uid and any(h[0] == uid for h in e.heard)) or (shape == "prompt" and last[2] == "queued"
                                                                    and last[1] == norm)
    e.heard = [*e.heard, (uid, norm, shape)][-HEARD_KEEP:]  # a copy too, so the prompt it closes pairs with no other
    return [] if copy else [f"✉ {by} → {e.shown}: {_one_line(text, MESSAGE_CHARS)}"]


def _message(e: Entry, rec: dict[str, Any]) -> tuple[str, str] | None:
    """(sender, text) of a record that is a message for the session, else None: another session's SendMessage or a
    subagent's hand-back (origin peer), main's message (origin coordinator), a finished background task (a task
    notification), and the prompt thimble started or resumed it with, told apart by e.prompts. A message thimble
    passed on names its first sender (_relayed_by)."""
    att = rec.get("attachment") if rec.get("type") == "attachment" and isinstance(rec.get("attachment"), dict) else None
    if att is not None:
        if att.get("type") != "queued_command":
            return None
        origin, text = att.get("origin"), str(att.get("prompt") or "")
    elif rec.get("type") == "user":
        text = session._user_text(rec)
        if text is None:
            return None
        origin = rec.get("origin")
    else:
        return None
    o = origin if isinstance(origin, dict) else {}
    kind = o.get("kind")
    if kind == "peer":
        body = str(o.get("body") or "")
        if o.get("handback"):
            body = HANDBACK_RE.sub("", body, count=1)
            return f"{config.session_role(str(o.get('name') or 'subagent'))} (hand-back)", textwrap.dedent(body).strip()
        return _relayed_by(body) or (config.session_role(str(o.get("name") or o.get("from") or "another session")),
                                        body.strip())
    if kind == "coordinator":
        return "main", COORDINATOR_RE.sub(r"\1", text).strip()
    if kind == "task-notification" or (att is not None and att.get("commandMode") == "task-notification"):
        m = SUMMARY_RE.search(text)
        said = (m.group(1) if m else dict(session.TASK_FIELD_RE.findall(text)).get("status") or "").strip()
        return ("background task", said) if said else None
    if (rec.get("isMeta") and kind != "human") or rec.get("isCompactSummary") or rec.get("isVisibleInTranscriptOnly"):
        return None
    typed = session._typed(rec) if kind == "human" else None
    text = (typed or text).strip()
    if not text or text.startswith("<") or session.INTERRUPT_RE.match(text):
        return None  # a command's line or output, a system reminder, the harness's note of an interrupt (_news_lines)
    return _relayed_by(text) or ("thimble" if _from_thimble(e, text) else "analyst", text)


def _from_thimble(e: Entry, text: str) -> bool:
    """Whether a prompt is one thimble gave the session on its stdin (prompted)."""
    return _norm(text)[:PROMPT_KEY] in e.prompts


def _relayed_by(text: str) -> tuple[str, str] | None:
    """(sender, message) of a message thimble passed on to a writer in the words of its bg-from-* hints
    (write_session.message): the analyst in the tray, or main."""
    from . import tools  # noqa: PLC0415

    for hint, by in (("bg-from-terminal", "analyst (tray)"), ("bg-from-main", "main")):
        head, _, tail = tools.hint(hint, text="\0").partition("\0")
        if head and text.startswith(head):
            body = text[len(head):]
            if tail.strip() and body.rstrip().endswith(tail.strip()):
                body = body.rstrip()[: -len(tail.strip())]
            return by, body.strip()
    return None


def _as_text(v: Any) -> str:
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str) if v is not None else ""


def _one_line(text: str, limit: int) -> str:
    """`text` on one line, clipped to `limit` characters with an ellipsis."""
    line = " ".join(str(text or "").split())
    return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"


def _clip(text: str, limit: int) -> str:
    """A reply kept whole up to `limit` characters; a longer one keeps its start and says how many were cut and where
    the whole reply shows."""
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}… ({len(text) - limit:,} more characters; its thread in the browser shows them)"


# --------------------------------------------------------------------------- messages


def pass_on(e: Entry, text: str, by: str) -> None:
    """Pass on a message that reached the agent's tray entry, from `by` (agents.TERMINAL for one the analyst typed in its
    view, agents.MAIN_ID for main's), as a task (module note, the tray entry): to a writer through write_session.message,
    else to the orientation through orient_session.message, each of which runs it now when no run goes and keeps it for
    the run's end otherwise. The news says where it went, or why it could not."""
    task = asyncio.get_running_loop().create_task(_pass_on(e, text, by), name=f"tray-pass-on:{e.c}:{e.key}")
    _passing.add(task)
    task.add_done_callback(_passing.discard)


async def _pass_on(e: Entry, text: str, by: str) -> None:
    from . import orient_session, write_session  # noqa: PLC0415 — both import this module

    sender = "main" if by == agents.MAIN_ID else "analyst (tray)"
    try:
        if kind_of(e.key) == "writer":
            to = e.shown
            got = await write_session.message(e.c, e.key.split(":", 1)[-1], text, by, chat=e.chat, sid=e.sid)
        else:
            to = config.session_role(name_of(e.c, "orient"))
            got = await orient_session.message(e.c, text, orient_session.MAIN if by == agents.MAIN_ID
                                               else orient_session.BROWSER)
    except Exception as ex:  # noqa: BLE001 — the news says why
        log.info("%s: a message for %s was not passed on: %s", e.c, e.name, ex)
        _news(e, f"thimble could not pass on the message from {sender}: {_one_line(str(ex), TOOL_CHARS)}")
        return
    later = " (it waits for the run that goes to end)" if got.get("status") == "queued" else ""
    _news(e, f"✉ {sender} → {to}: {_one_line(text, MESSAGE_CHARS)}{later}")


def proxy_alive(e: Entry) -> bool:
    return bool(e.proxy_seen) and time.monotonic() - e.proxy_seen < PROXY_ALIVE_S


# --------------------------------------------------------------------------- the tray entry


def proxy_file(c: str, key: str) -> Path:
    return config.workspace_dir(c) / PROXY_DIR / f"{key.replace(':', '-')}.md"


def proxy_prompt(c: str, key: str) -> str:
    """The tray entry's instructions for the agent `key`, written to proxy_file; its path, which main passes as the
    entry's prompt."""
    from . import tools  # noqa: PLC0415

    e = entry(c, key)
    name = e.name if e is not None else name_of(c, key)
    path = proxy_file(c, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    ledger.atomic_write_text(path, tools.hint("bg-proxy", session=name) + "\n")
    return str(path)


def proxy_start_hint(c: str, key: str) -> str:
    """The lines that ask main to start the agent's tray entry, for a tool's result or an event: its Agent call's
    `description`, which the tray entry shows beside the agent's name, is the agent's name."""
    from . import tools  # noqa: PLC0415

    e = entry(c, key)
    name = e.name if e is not None else name_of(c, key)
    if e is not None:
        e.proxy_asked = time.monotonic()
    return tools.hint("bg-proxy-start", type=proxy_type(key), session=name, prompt=proxy_prompt(c, key))


def ask_main_for_proxy(c: str, *keys: str) -> bool:
    """Ask main, with one `agent` event, to start the proxies of the sessions `keys`; False when no session listens."""
    from . import events  # noqa: PLC0415

    found = [e for e in (entry(c, k) for k in keys) if e is not None and not e.proxy_refused]
    if not found or not events.reachable(c):
        return False
    try:
        events.post(c, "agent", {"text": "\n\n".join(proxy_start_hint(c, e.key) for e in found),
                                  "name": ", ".join(e.name for e in found)})
    except Exception:  # noqa: BLE001
        log.info("%s: main was not asked to start the proxies of %s", c, keys, exc_info=True)
        return False
    return True


def _proxy_key(c: str, prompt_path: str) -> str | None:
    for e in entries(c):
        if str(proxy_file(c, e.key)) in prompt_path:
            return e.key
    return None


def _by_tray(c: str, agent_type: Any, description: Any, prompt: Any = None) -> Entry | None:
    """The session an Agent call of a plugin agent of PROXY_TYPES shows: the one whose proxy_file its prompt names, or
    whose name its description is (by_name), else the one live session of its kind."""
    kind = str(agent_type or "").strip().rsplit(":", 1)[-1]
    if kind not in PROXY_TYPES.values():
        return None
    cands = [e for e in entries(c) if PROXY_TYPES.get(kind_of(e.key)) == kind]
    text = str(prompt or "")
    hit = next((e for e in cands if text and str(proxy_file(c, e.key)) in text), None)
    if hit is None and (named := by_name(c, str(description or ""))) in cands:
        hit = named
    if hit is not None:
        return hit
    live = [e for e in cands if alive(e)]
    return live[0] if len(live) == 1 else None


def is_proxy(c: str, agent_type: Any, description: Any, prompt: Any = None) -> bool:
    """Whether an Agent call starts a proxy (_by_tray)."""
    return _by_tray(c, agent_type, description, prompt) is not None


def proxy_started(c: str, agent_type: str, description: str, agent_id: str | None, prompt: Any = None) -> str | None:
    """Main started (or the mirror found) the proxy of a session (_by_tray): the session's key."""
    e = _by_tray(c, agent_type, description, prompt)
    if e is None:
        return None
    e.proxy_seen = time.monotonic()
    e.proxy_refused = False
    proxy_agent(c, e.key, agent_id)
    return e.key


def proxy_refused(c: str, key: str, tool_use_id: str | None) -> None:
    """Main's Agent call that would start the session's proxy ended in an error: Claude Code refused it (auto mode, a
    permission rule, the analyst) or could not start it. Main is not asked again for this session, since the same call
    would be refused again and each ask costs main a turn and the terminal its lines. A refusal of agent_check's own, of
    a second proxy, changes nothing."""
    if tool_use_id and tool_use_id in _own_refusals:
        _own_refusals.discard(tool_use_id)
        return
    e = entry(c, key)
    if e is None or e.proxy_refused:
        return
    e.proxy_refused = True
    e.proxy_seen, e.proxy_starting = 0.0, 0.0
    log.info("%s: main's call to show %s in the agent tray was refused; main is not asked again", c, e.name)
    _save(c)


def proxy_agent(c: str, key: str, agent_id: str | None) -> None:
    """The agent id of a proxy of the session `key`, once the mirror knows it."""
    e = entry(c, key)
    if e is not None and agent_id and agent_id not in e.proxy_agents:
        e.proxy_agents.append(agent_id)
        _save(c)


def new_main(c: str) -> None:
    """Another session became main: the proxies ran in the one before, so each session is shown anew, and a session
    whose proxy the one before refused is asked for again once."""
    for e in entries(c):
        e.proxy_seen, e.proxy_asked, e.proxy_starting, e.owner = 0.0, 0.0, 0.0, None
        e.proxy_refused = False


def proxy_ended(c: str, agent_id: str | None) -> None:
    """A tray entry's task ended: while its agent's run goes, main is asked for a new one."""
    for e in entries(c):
        if agent_id and agent_id in e.proxy_agents and e.owner in (None, agent_id):
            e.proxy_seen, e.proxy_starting, e.owner = 0.0, 0.0, None
            if e.run_open and not e.proxy_refused:
                log.info("%s: %s's proxy %s ended while its session runs; main is asked for another", c, e.name, agent_id)
                ask_main_for_proxy(c, e.key)


def _head(path: Path | None) -> str:
    try:
        with path.open("rb") as f:  # type: ignore[union-attr]
            return f.read(8_192).decode("utf-8", errors="replace")
    except (OSError, AttributeError):
        return ""


def proxy_of(c: str, agent_id: str | None, path: Path | None) -> Entry | None:
    """The session whose tray entry the subagent `agent_id` is, with its transcript at `path`: one of the session's
    proxies, or a subagent whose first prompt names the session's proxy_file. None for any other agent."""
    if agent_id:
        hit = next((e for e in entries(c) if agent_id in e.proxy_agents), None)
        if hit is not None:
            return hit
    head = _head(path)
    return next((e for e in entries(c) if str(proxy_file(c, e.key)) in head), None) if head else None


def _capture(e: Entry, path: Path | None) -> None:
    """The messages that reached a tray entry of the agent, typed in its view or sent by main, which were not passed on
    yet: each is passed on once (pass_on)."""
    got = False
    for uid, text, by in _typed_messages(path) if path is not None else []:
        if uid in e.relayed:
            continue
        e.relayed.append(uid)
        pass_on(e, text, by)
        got = True
    if got:
        _save(e.c)


def _fresh(e: Entry, path: Path | None) -> bool:
    """Whether a tray entry's transcript holds a message for the session that is neither passed on nor queued."""
    return any(uid not in e.relayed for uid, _t, _b in (_typed_messages(path) if path is not None else []))


async def wait(c: str, name: str, agent_id: str | None = None, path: Path | None = None) -> str:
    """The `wait_session` tool of the tray entry `agent_id` (its transcript at `path`): the agent's news, as one block
    of lines to copy, waiting up to WAIT_S for some. While it waits it reads the agent's transcript every NEWS_POLL_S
    (_read_news) and returns as soon as there is news, NEWS_GATHER_S after the first line so that the lines which come
    together (a call and its result) come in one answer. One answer holds the oldest lines up to NEWS_RETURN_CHARS (at
    least one); the rest wait for the next call, which returns them at once. The messages this entry, or an earlier one
    of the agent that ended, got for the agent are passed on first (_capture). A second entry of an agent whose entry is
    alive is told to stop, and the entry of an agent that finished is told to end once it has all the news."""
    from . import tools  # noqa: PLC0415

    e = by_name(c, name)
    if e is None:
        return tools.hint("wait_session-none", session=name)
    if agent_id:
        proxy_agent(c, e.key, agent_id)
    for p in {path, *session.agent_paths(c, e.proxy_agents)} - {None}:
        _capture(e, p)
    if agent_id and e.owner and e.owner != agent_id and proxy_alive(e):
        log.info("%s: a second tray entry of %s (%s) is told to stop", c, e.name, agent_id)
        return tools.hint("wait_session-duplicate", session=e.name)
    if agent_id:
        e.owner = agent_id
    e.proxy_seen = time.monotonic()
    e.blocks = 0
    carried = bool(e.news)  # lines an earlier answer left, which go out without waiting for more
    deadline = time.monotonic() + WAIT_S
    while not finished(e) and not _closing:
        _read_news(e)
        if e.news:
            break
        left = deadline - time.monotonic()
        if left <= 0:
            break
        _changed.clear()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(_changed.wait(), min(left, NEWS_POLL_S))
        e.proxy_seen = time.monotonic()
    if e.news and not carried and not finished(e) and not _closing:
        await asyncio.sleep(NEWS_GATHER_S)
    _read_news(e)
    e.proxy_seen = time.monotonic()
    n, size = 0, 0
    while n < len(e.news) and (n == 0 or size + len(e.news[n]) + 1 <= NEWS_RETURN_CHARS):
        size += len(e.news[n]) + 1
        n += 1
    news, e.news = e.news[:n], e.news[n:]
    if e.dropped and news:
        news.insert(0, f"… {e.dropped:,} earlier lines are not shown; the agent's thread in the browser shows them")
    e.dropped = 0
    out = ["\n".join(news), tools.hint("wait_session-copy")] if news else []
    if finished(e) and not e.news:
        out.append(tools.hint("wait_session-finished" if e.status == "done" else "wait_session-ended", session=e.name))
        return "\n\n".join(out)
    if not out:
        out.append(tools.hint("wait_session-quiet", session=e.name, state=state_words(e)))
    return "\n\n".join([*out, tools.hint("wait_session-rule", session=e.name)])


def state_words(e: Entry) -> str:
    if e.run_open:
        return "waiting for a permission" if e.status == "waiting" else "working"
    return {"done": "done", "stopped": "stopped", "failed": "failed"}.get(e.status, "ended")


async def tool_wait_session(ctx: Any, args: dict[str, Any]) -> Any:
    from . import tools  # noqa: PLC0415

    sub = await session.caller_sub(ctx.c, ctx.tool_use_id)
    if sub is None:
        return tools.err(tools.hint("wait_session-main"))
    return tools.ok(await wait(ctx.c, str(args.get("session") or ""), sub.agent_id, sub.path))


async def tool_list_agents(ctx: Any, args: dict[str, Any]) -> Any:
    """The `list_agents` tool (/thimble:agents): thimble's running agents, answered by this server."""
    from . import tools  # noqa: PLC0415

    return tools.ok(tools.hint("agents-print", text=listing_text(agent_rows(ctx.c))))


# --------------------------------------------------------------------------- the hooks


COORDINATOR_LEAD = "The coordinator sent a message while you were working:"  # how a meta prompt from main opens


def _typed_messages(path: Path) -> list[tuple[str, str, str]]:
    """(uuid, text, sender) of each message a tray entry got for its agent, from its transcript: those the analyst typed
    in its view (terminal) and those main sent it, since main's SendMessage to the agent's name reaches the entry
    (main). A message Claude Code writes in two shapes, a queued command and a meta prompt, is taken once."""
    out: list[tuple[str, str, str]] = []
    try:
        lines = path.read_bytes().splitlines()
    except OSError:
        return out
    last: tuple[str, str] = ("", "")  # the shape and text of the message before, for the second shape of one message
    for line in lines:
        if b"queued_command" not in line and b'"human"' not in line and b'"coordinator"' not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        att = rec.get("attachment") if isinstance(rec.get("attachment"), dict) else {}
        att_origin = att.get("origin") if isinstance(att.get("origin"), dict) else {}
        origin = rec.get("origin") if isinstance(rec.get("origin"), dict) else {}
        shape = "queued" if att else "prompt"
        if att.get("type") == "queued_command" and att_origin.get("kind") == "coordinator":
            text, by = str(att.get("prompt") or "").strip(), agents.MAIN_ID
        elif rec.get("type") == "user" and rec.get("isMeta") and origin.get("kind") == "coordinator":
            text = (session._user_text(rec) or "").strip().removeprefix(COORDINATOR_LEAD).strip()
            by = agents.MAIN_ID
        else:
            text, by = session._typed(rec) or "", agents.TERMINAL
        if not text:
            continue
        if last[0] and last[0] != shape and last[1] == _norm(text):
            last = ("", "")
            continue
        last = (shape, _norm(text))
        out.append((str(att.get("source_uuid") or rec.get("uuid") or text), text, by))
    return out


def _norm(text: str) -> str:
    return " ".join(str(text or "").split()).lower()


def proxy_stop(c: str, agent_type: str, agent_path: Path | None, active: bool, agent_id: str | None = None) -> str | None:
    """The SubagentStop hook of a tray entry: the reason to keep it going while its agent works or has news left for it,
    or a message it got waits to be passed on, or None to let it stop."""
    from . import tools  # noqa: PLC0415

    if not agent_type.startswith(f"{_plugin()}:") or agent_path is None:
        return None
    e = proxy_of(c, agent_id, agent_path)
    if e is None or (agent_id and e.owner and agent_id != e.owner and proxy_alive(e)):
        return None
    if finished(e) and not e.news and not _fresh(e, agent_path):
        return None
    e.blocks += 1
    if e.blocks > BLOCKS_MAX:
        log.warning("%s: %s's tray entry stopped %d times in a row; it may stop", c, e.name, e.blocks)
        return None
    return tools.hint("bg-proxy-keep", session=e.name)


def agent_check(c: str, tool_input: dict[str, Any], tool_use_id: str | None = None) -> str | None:
    """Main's Agent call `tool_use_id`, before it runs: why it must not start (a second tray entry of an agent whose
    entry runs or is starting, a second fork of a thread whose fork runs or is starting), or None to let it start."""
    agent_type, description = tool_input.get("subagent_type"), tool_input.get("description")
    e = _by_tray(c, agent_type, description, tool_input.get("prompt"))
    if e is not None:
        now = time.monotonic()
        if proxy_alive(e) or (e.proxy_starting and now - e.proxy_starting < PROXY_ASK_S):
            if tool_use_id:
                _own_refusals.add(tool_use_id)
            return f"{e.name} already shows in the agent tray, so this call is not needed. End the turn with no text."
        e.proxy_starting = now
        return None
    if str(agent_type or "") != "fork":
        return None
    tid = session.thread_for(c, description)
    if not tid:
        return None
    started = _forking.get((c, tid))
    if started is not None and time.monotonic() - started < FORK_DEDUPE_S:
        return f"The fork of thread {str(description).removeprefix('thread:')} is running already; it answers in the thread."
    _forking[(c, tid)] = time.monotonic()
    return None


_forking: dict[tuple[str, str], float] = {}  # (workspace, thread) -> time.monotonic() when its fork's Agent call ran
_own_refusals: set[str] = set()  # the tool_use_ids of the second tray entries agent_check refused (proxy_refused)


def fork_ended(c: str, thread_id: str) -> None:
    """A thread's fork stopped, so a new Agent call may fork it again (agent_check)."""
    _forking.pop((c, thread_id), None)


# --------------------------------------------------------------------------- what the terminal lists


def statusline_command(own: str = "") -> str:
    """The statusline command the launcher passes to main: plugin/bin/thimble-agents, which lists thimble's agents
    (agents_route), chained to the analyst's statusline command `own`."""
    import shlex  # noqa: PLC0415

    from . import agent_session  # noqa: PLC0415

    cmd = f"{shlex.quote(str(agent_session.PLUGIN_DIR / 'bin' / 'thimble-agents'))} --statusline"
    return f"{cmd} --chain {shlex.quote(own)}" if own else cmd


def agent_rows(c: str) -> list[dict[str, Any]]:
    """Every thimble agent running in the workspace, for the statusline and /thimble:agents: the orientation, its critic
    and the writers while a run goes, the code ticket and view builds (dev.py), and the subagents and threads of main
    (session.py), each {name, label?, state, kind}: `name` as the terminal names it, `label` as /thimble:agents lists it
    (by `name` without one)."""
    from . import dev  # noqa: PLC0415 — dev imports the views module, which imports this one's callers

    rows: list[dict[str, Any]] = []
    for e in entries(c):
        if not e.run_open:
            continue
        rows.append({"name": e.name, "label": label_of(e.key), "state": state_words(e), "kind": "session"})
    with contextlib.suppress(Exception):
        rows.extend(dev.running_builds(c))
    rows.extend(session.running_agents(c))
    return rows


def status_line(rows: list[dict[str, Any]], chars: int = STATUS_CHARS) -> str:
    """Claude Code's statusline: every agent with its state, `thimble · ● thimble:writer working · ◐ thimble:critic
    waiting for a permission …`, a session by its role alone (config.session_role), going on to a further line once a
    line holds about `chars` characters."""
    if not rows:
        return ""
    mark = {"working": "●", "starting": "●", "waiting": "◐", "restarting": "◐"}
    parts = [f"{mark.get(r['state'].split()[0], '○')} {config.session_role(r['name'])} {r['state']}" for r in rows]
    lead, pad = "thimble · ", " " * len("thimble")  # a further line starts under the first line's first separator
    lines, cur = [], lead + parts[0]
    for part in parts[1:]:
        if len(cur) + 3 + len(part) > chars:
            lines.append(cur)
            cur = pad + " · " + part
        else:
            cur += " · " + part
    return "\n".join([*lines, cur])


def plain_state(state: str) -> str:
    """A row's state as /thimble:agents lists it: starting, working, waiting for you, done or restarting."""
    first = state.split()[0].rstrip(",") if state else ""
    if first == "waiting":
        return "waiting for you"
    return {"done": "done", "idle": "done", "ended": "done", "starting": "starting",
            "restarting": "restarting"}.get(first, "working")


def listing_text(rows: list[dict[str, Any]]) -> str:
    from . import tools  # noqa: PLC0415

    if not rows:
        return tools.hint("agents-none")
    labels = [str(r.get("label") or r["name"]) for r in rows]
    width = max(len(label) for label in labels)
    lines = [f"{label:<{width}}  {plain_state(r['state'])}" for label, r in zip(labels, rows)]
    return "\n".join(lines + ["", tools.hint("agents-help")])


class AgentsQuery(BaseModel):
    cwd: str
    session: str | None = None
    announce: bool = False  # the plugin's hooks ask for the lines to print, which are then taken as shown


# (workspace, main session) -> ({session short ids whose start it was told}, {short id: the run end it was told of}),
# kept in ANNOUNCED_FILE so a server restart prints no line twice
_announced: dict[tuple[str, str], tuple[set[str], dict[str, float]]] = {}
_announced_loaded: set[str] = set()


def _announced_of(c: str, main_sid: str) -> tuple[set[str], dict[str, float]]:
    if c not in _announced_loaded:
        _announced_loaded.add(c)
        try:
            data = json.loads((config.workspace_dir(c) / ANNOUNCED_FILE).read_text("utf-8"))
        except (OSError, ValueError):
            data = {}
        for sid, row in (data.items() if isinstance(data, dict) else []):
            if isinstance(row, dict):
                _announced[(c, sid)] = ({str(x) for x in row.get("started") or []},
                                        {str(k): float(v) for k, v in (row.get("finished") or {}).items()})
    return _announced.setdefault((c, main_sid), (set(), {}))


def _save_announced(c: str) -> None:
    rows = {sid: {"started": sorted(st), "finished": fin} for (cc, sid), (st, fin) in _announced.items() if cc == c}
    with contextlib.suppress(Exception):
        ledger.atomic_write_text(config.workspace_dir(c) / ANNOUNCED_FILE, json.dumps(rows, indent=1))


@router.post("/agents")
async def agents_route(body: AgentsQuery) -> dict[str, Any]:
    """thimble's agents for the folder's workspace: `{rows, line, text}` for the statusline and /thimble:agents, and
    with `announce` the lines main's terminal has not shown yet (the plugin's hooks print them): each session's start
    once and each run's end. The statusline's `line` also holds the browser's messages that
    `session` has not got yet (events.queued_line)."""
    from . import events  # noqa: PLC0415

    c = config.workspace_for_cwd(body.cwd)
    if not c:
        return {"rows": [], "line": "", "text": "", "announce": ""}
    rows = agent_rows(c)
    lines: list[str] = []
    if body.announce:
        started, finished = _announced_of(c, body.session or "")
        for e in entries(c):
            if e.run_open and e.short not in started:
                started.add(e.short)
                finished.setdefault(e.short, 0.0)
                lines.append(f"{label_of(e.key)} started: ↓ to follow it")
            elif (e.short in started and e.ended_at and finished.get(e.short) != e.ended_at and not e.run_open
                    and e.status in END_LINES):
                finished[e.short] = e.ended_at
                said = cite.prose(e.result or "").strip()
                # a result of a word or two, such as "Done.", repeats what the line says
                lines.append(END_LINES[e.status].format(name=label_of(e.key)) +
                             (f": {said[:200]}" if len(said.split()) > 2 else ""))
        if lines:
            _save_announced(c)
    line = "\n".join(x for x in (status_line(rows), events.queued_line(c, body.session, STATUS_CHARS)) if x)
    return {"rows": rows, "line": line, "text": listing_text(rows), "announce": "\n".join(lines)}


class AgentCheckBody(BaseModel):
    cwd: str
    agent_id: str | None = None
    tool_use_id: str | None = None
    tool_input: dict[str, Any] = {}


@router.post("/bg/agent-check")
async def agent_check_route(body: AgentCheckBody) -> dict[str, Any]:
    """The PreToolUse hook before main's Agent call (agent_check): `{deny, reason}`."""
    c = config.workspace_for_cwd(body.cwd)
    reason = agent_check(c, body.tool_input, body.tool_use_id) if c and not body.agent_id else None
    if reason:
        log.info("%s: an Agent call is refused: %s", c, reason)
    return {"deny": bool(reason), "reason": reason or ""}


class StopBody(BaseModel):
    cwd: str
    agent_id: str | None = None
    agent_type: str = ""
    agent_transcript_path: str | None = None
    stop_hook_active: bool = False


@router.post("/bg/proxy-stop")
async def proxy_stop_route(body: StopBody) -> dict[str, Any]:
    c = config.workspace_for_cwd(body.cwd)
    reason = proxy_stop(c, body.agent_type, Path(body.agent_transcript_path) if body.agent_transcript_path else None,
                        body.stop_hook_active, body.agent_id) if c else None
    return {"block": bool(reason), "reason": reason or ""}


async def shutdown() -> None:
    global _task, _closing
    _closing = True
    _changed.set()
    if _task is not None:
        _task.cancel()
        _task = None
    for task in list(_passing):
        task.cancel()
