"""The mirror: the analyst's Claude Code session is the workspace's `main`, and the browser shows its transcript.

A session attaches when its MCP shim subscribes to the channel naming it or when `/thimble` names it
(`POST /api/ws/{c}/session`); its transcript is found under the config dir its shim reported (find_transcript). One
session is main per workspace, kept in `workspaces/<c>/sessions.json` with the tail's cursor and each subagent's place,
so a restarted server reads on where it stopped. The channel subscription is the session's liveness: with no
subscriber for GRACE_S the session detaches. /clear and /resume switch sessions in the same process, and main follows
the new id by pid (_follow).

The tail translates transcript records into main's log (`by: terminal`): the analyst's lines (not /thimble's own turn
or local commands such as /model), channel events, task notifications, peer messages, tool calls and results, text,
and `done` at turn_duration; any record shape it does not cover disables it with one `error` record. Safety stops,
fallbacks, interrupts and long waits (read from `<claude config>/sessions/<pid>.json`) become one note each.

Each subagent transcript becomes an agent chat, except `thread:<id>` subagents, which are that thread's fork
(threads.py). A Workflow call is one agent chat whose members are the run's agent transcripts. Main ends a turn with
nothing for the analyst without text, or with END_TOKEN where Claude Code asks for text (terminal_tools.py); no chat
shows END_TOKEN, nor a line that opens with TERMINAL_ONLY."""
from __future__ import annotations

import asyncio
import contextlib
import html
import json
import logging
import re
import signal
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import agents, cc_channel, cc_settings, cite, config, modes, orientation, terminal_tools, threads
from .ledger import atomic_write_text

log = logging.getLogger("thimble.session")

TERMINAL, BROWSER = agents.TERMINAL, agents.BROWSER
CHIP_KIND = "session"  # the notes the mirror itself writes on main (Stops and waits)
UNREADABLE_TEXT = "intermediate text unavailable"
SUMMARY_LIMIT = agents.SUMMARY_LIMIT
RESULT_LIMIT = 400  # chars of an agent's result kept on its meta
CELL_TOOLS = ("add_card", "edit_card", "add_cell", "edit_cell")  # the card tools, by their names and aliases
# apply_label's result names the label's card, when it has one, as a citation; its record carries that card's id as
# `label_card` (not `cell_id`) so the browser counts the card once. The cards the result names as stale are not it.
LABEL_TOOL = "apply_label"
LABEL_CARD_RE = re.compile(r"The label's card is \[\[card:([A-Za-z0-9_-]+)\]\]")
AGENT_TOOLS = ("Agent", "Task")  # the CLI's subagent tool, by either of its names
WAIT_SESSION = "wait_session"  # the thimble tool of a background session's tray entry
WORKFLOW_TOOL = "Workflow"  # Claude Code's dynamic workflows (module note, workflows)
WORKFLOW_TITLE = "workflow"  # when the script's meta names nothing
WORKFLOW_DIR_RE = re.compile(r"^Transcript dir:[ \t]*(\S.*?)[ \t]*$", re.M)  # in the Workflow call's result
# `export const meta = {name: '…', description: '…'}`, the literal every workflow script opens with
WORKFLOW_META_RE = re.compile(r"\b(name|description)\s*:\s*(['\"`])(.*?)\2", re.S)
SCRIPT_READ_CHARS = 64_000  # of a workflow run by its scriptPath, read for its meta
SEND_TOOL = "SendMessage"
REPLY_TOOL = "reply_in_thread"
# what main ends a turn with when it has nothing for the analyst, which no chat shows (module note, the end token)
END_TOKEN = "(shown in the dashboard)"
TERMINAL_ONLY = "↳"  # opens a line of main's or a fork's that only the terminal shows (prompts/main.md)
# the token at the end of a text, with the variants the model writes: any case, a trailing period, `*` or `_` emphasis
END_RE = re.compile(r"[ \t]*[*_]*" + re.escape(END_TOKEN) + r"\.?[*_]*\.?\s*\Z", re.I)
# Claude Code loading a deferred tool's schema before its first call: nothing the analyst reads, so no row in any chat
PLUMBING_TOOLS = frozenset({"ToolSearch"})
HANDBACK_TOOL = "SubagentHandback"  # a foreground subagent's report to its caller: its message is the agent's result
SUBAGENT_ROLE = "subagent"
SUBAGENT_TITLE = "subagent"  # when neither the Agent call nor the meta json names one
AGENT_DIRS = ("subagents", "")  # under <transcript dir>/<session id>/
AGENT_FILE_RE = re.compile(r"^agent-([A-Za-z0-9_-]+)\.jsonl$")
META_WAIT_SCANS = 4  # scans a subagent file without its meta json waits before it is adopted untitled
SUB_QUIET_S = 1.0  # a foreground subagent whose result is in is finished once its file has been quiet this long
TAIL_BUSY_S, TAIL_IDLE_S = 0.5, 1.0
GRACE_S = 10.0  # a workspace with no channel subscriber for this long has no session
SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CHANNEL_RE = re.compile(r"^\s*<channel\s([^>]*)>\n?(.*?)\n?</channel>\s*$", re.S)
ATTR_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"')
# a browser event inside a task notification (the hook and Monitor routes, module note)
EVENT_TAG_RE = re.compile(r'<channel\s+source="' + re.escape(cc_channel.SOURCE) + r'"[^>]*>.*?</channel>', re.S)
# a Monitor event's output in its task notification, which Claude Code 2.1.281 writes with &, < and > escaped
MONITOR_EVENT_RE = re.compile(r"</summary>\s*<event>(.*?)</event>", re.S)
MONITOR_TOOL = "Monitor"
WATCHER = ".thimble-watch"  # the plugin's hidden watcher (plugin/bin), which main's Monitor runs on the Monitor route
MONITOR_TASK_RE = re.compile(r"\btask\s+([A-Za-z0-9_-]+)")  # "Monitor started (task b0yz9yjck, expires in 30m …"
# a message the analyst typed to a working subagent in Claude Code's agent view, as the subagent's meta prompt carries it
TYPED_RE = re.compile(r"^[^\n]*while you were working:\n(.*?)(?:\n\nThis is how Claude Code surfaces.*)?\Z", re.S)
RELAYED_BY = agents.MAIN_ID  # `by` of a message main sent a thread's fork or a subagent, which its chat shows as from main
# main's SendMessage to a working subagent, as the subagent's meta prompt carries it
COORDINATOR_RE = re.compile(r"^[^\n]*sent a message while you were working:\n(.*?)(?:\n\nAddress this.*)?\Z", re.S)
COMMAND_RE = re.compile(r"<command-name>(.*?)</command-name>", re.S)
COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
LOCAL_CAVEAT = "<local-command-caveat>"  # the meta record before a local command's line (module note, the table)
CONNECT_COMMANDS = ("/thimble", "/thimble:thimble")  # /thimble's command line, whose turn is not mirrored (module note)
TASK_FIELD_RE = re.compile(r"<(task-id|tool-use-id|status|result)>(.*?)</\1>", re.S)
ASYNC_RESULT_RE = re.compile(r"^\s*Async agent launched")
AGENT_ID_RE = re.compile(r"agentId:\s*([A-Za-z0-9_-]+)")
TASK_DONE = ("completed", "done", "success")
TASK_STOPPED = ("killed", "stopped", "cancelled")  # a task stopped with TaskStop, or Esc in the agent view
CALL_WAIT_S = 2.0  # call_session's longest wait for a call's line in a transcript
CALL_POLL_S = 0.02
CALL_TAIL = 262_144  # bytes at a transcript's end that call_session reads first
# Stops and waits (module note): the notes main gets, and how the transcript and the session's state file say so
SAFETY_RE = re.compile(r"safeguards stopped the response")
INTERRUPT_RE = re.compile(r"^\[Request interrupted by user[^\]]*\]$")
SAFETY_TEXT = "Claude's safety check stopped a response, and the session is trying it once more"
SAFETY_STOP_TEXT = "The session stopped: Claude's safety check ended this turn"
INTERRUPTED_TEXT = "The turn was interrupted in the terminal"
WAITING_TEXT = "The session is waiting for you in the terminal"
WAITING_FOR = {"permission prompt": "a permission prompt", "dialog open": "a dialog is open",
               "input needed": "a request for input", "sandbox request": "a sandboxed command asks for network access"}
DIALOG_WAIT = "dialog open"
PERMISSION_WAIT = "permission prompt"
WAIT_NOTE_S = 2.0  # a wait shorter than this (a prompt the analyst answered at once in the terminal) gets no note
# Main's hook-relayed prompt older than this is ended while Claude Code's record says the session waits on none: the
# analyst answered it in the terminal. A subagent's or fork's prompt is never released this way.
ASK_RELEASE_S = 10.0
SAFETY_ALERT = ("Claude Code is waiting in your terminal: Claude's safety check stopped this answer. Choose there whether "
                "to switch to another model and go on, or to stay on this one and stop the answer.")
FALLBACK_SUBTYPE = "model_refusal_fallback"
FALLBACK_TEXT = "Claude's safety check stopped this answer, so {model} answers instead"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Unreadable(ValueError):
    """A transcript line or record the pinned shape does not cover."""


class Sub:
    """One subagent of the attached session: the chat its records go to and the tail of its transcript."""

    def __init__(self, c: str, chat: str, tool_use_id: str | None, agent_id: str | None, *, thread: bool = False,
                 role: str = SUBAGENT_ROLE) -> None:
        self.chat, self.tool_use_id, self.agent_id, self.thread = chat, tool_use_id, agent_id, thread
        self.role = "thread" if thread else role  # the agent chat's role: subagent, or orient for the orientation
        self.rec = agents.Recorder(c, chat)
        self.path: Path | None = None  # its transcript once found
        self.offset = 0
        self.buf = b""
        self.seen: set[str] = set()  # `use:<id>` and `result:<id>` written
        self.names: dict[str, str] = {}  # tool_use id -> name, for the results
        self.finish: tuple[str, str | None] | None = None  # a foreground agent's (status, result) until its file is quiet
        self.report: str | None = None  # the message it handed back, its result
        self.typed: str | None = None  # the last message the analyst typed to it in the agent view (_typed)
        self.prompted = False  # its first prompt was read
        self.of_main = False  # a subagent main started with the Agent tool (_spawn)
        self.relay_by: str | None = None  # who sent the message main passed on last, when not main (relay)
        self.call_keys: dict[str, tuple[str, str]] = {}  # tool_use id -> its channel.call_key (_results)
        self.on_results: Any = None  # told the calls whose results each read found, when set (_results)
        self.proxy = False  # the tray entry of a background session of thimble's, whose transcript no chat shows
        self.quiet_since = time.monotonic()
        self.done = False
        self.workflow = False  # a Workflow call of main's, whose members are its agents (module note, workflows)
        self.workflow_dir: Path | None = None  # the run's transcript directory, from the call's result
        self.owner: Sub | None = None  # the workflow this Sub's transcript is one agent of
        # the call store of an orientation's session (calls.Numbering, set by agent_session): each call this Sub writes
        # is numbered in the orientation's sequence, its record carries `n`, and each result is stored whole
        self.calls: Any = None


class Live:
    """One attached session: the tail's state."""

    def __init__(self, c: str, sid: str, cwd: str, transcript_path: str | None, pid: int | None) -> None:
        self.c, self.sid, self.cwd, self.transcript_path, self.pid = c, sid, cwd, transcript_path, pid
        self.since = _now()
        # the CLAUDE_CONFIG_DIR of the session's `claude` process (None: Claude Code's default), once its shim reported it
        self.config: str | None = None
        self.config_known = False
        self.offset = -1  # bytes of the transcript read; -1 before the first look
        self.buf = b""
        self.saved = -1  # the offset the cursor in sessions.json holds (_save_cursor)
        self.subs_saved: dict[str, tuple] = {}  # each subagent's (offset, done) sessions.json holds (_sub_places)
        self.degraded = False
        self.seen: set[str] = set()  # `use:<id>` and `result:<id>` written to main
        self.tool_names: dict[str, str] = {}  # tool_use id -> name, for the results the tail reads
        self.hidden: set[str] = set()  # tool_use ids that are not rows in main (threads' Agent and SendMessage calls)
        self.turn_open = False
        self.fresh = False  # the turn has had no assistant record yet: another opening record still counts
        self.turn_threads: list[str] = []  # the threads whose events reached the turn (_release_threads)
        self.handed: list[str] = []  # the threads whose events main got in a tool's result (handed)
        self.forked: set[str] = set()  # the threads the turn forked or sent a follow-up to
        self.sends: dict[str, str] = {}  # tool_use id of main's SendMessage to a thread's fork -> the thread
        self.wrote = False  # the turn wrote something to main
        self.last_tool: str | None = None  # the name of main's last tool call (_nudged)
        self.last_failed = False  # that call's result was an error, such as a hook's refusal (_nudged)
        # the promptId of the local command whose caveat was read last ('' when the record has none), whose command
        # line is not the analyst's line to main (module note, the table); None once another line was read
        self.local_prompt: str | None = None
        self.model: str | None = None  # the model of main's last reply (_note_model)
        self.effort: str | None = None  # the effort of main's last reply (_note_model)
        self.fast: bool | None = None  # whether main's last reply ran in fast mode (_note_model)
        self.alerted = False  # main's meta holds the alert for the model-switch dialog (_watch_wait)
        self.flagged = False  # the safety check stopped a response in this turn (module note, stops and waits)
        self.answered = True  # main wrote an assistant record since that stop, so the retry went on
        self.held_by_check = False  # the turn waited on the dialog that follows a stop
        self.stop_noted = False  # the turn's stop or interrupt has its note
        self.wait: tuple[str, float, bool] | None = None  # the wait in progress: what holds it, since when, noted
        self.watch_calls: set[str] = set()  # tool_use ids of main's Monitor calls on thimble's watcher
        self.call_keys: dict[str, tuple[str, str]] = {}  # tool_use id -> channel.call_key of main's own calls (_results_in)
        self.watch_tasks: set[str] = set()  # the task ids those Monitors run as
        self.subs: list[Sub] = []
        self.sub_paths: set[str] = set()
        self.pending_paths: dict[str, int] = {}
        self.task: asyncio.Task | None = None
        self.wake = asyncio.Event()

    @property
    def busy(self) -> bool:
        """Whether the tail should read fast: a turn is open or a subagent still runs."""
        return self.turn_open or any(not s.done for s in self.subs)

    @property
    def config_dir(self) -> Path:
        """Claude Code's config dir for this session, where its transcript and its sessions/<pid>.json are: its own
        process's once known, else the one this server serves (config.claude_config_dir)."""
        return config.config_dir_of(self.config) if self.config_known else config.claude_config_dir()


_live: dict[str, Live] = {}  # by workspace: the one session that is main
_expected: set[str] = set()  # ids of channel events the channel logged when it posted them
_event_threads: dict[str, str] = {}  # a thread event's id -> its thread
_relays: dict[str, list[str]] = {}  # a subagent's chat -> who sent each message main is to pass on (relay)
RELAY_EVENT = "orient-follow-up"  # the `event` of a relayed message's record, which the browser takes as a follow-up's
_grace: dict[str, asyncio.TimerHandle] = {}  # workspace -> the pending detach after its last subscriber left
_sweep_task: asyncio.Task | None = None
_came_back: set[str] = set()  # workspaces where main's own shim subscribed since this server started (sweep skips them)
# ids of calls that did not run and are made again, a call auto mode refused and the analyst then allowed, or one a
# mode switch answered (agent_session, auto mode and mode switch): an error result of one shows as not run, not failed
_not_run: dict[str, None] = {}
NOT_RUN_KEEP = 2_000
_shim_pids: dict[tuple[str, str], int] = {}  # (workspace, session) -> the `claude` pid its shim reported (main_pid)
_shim_configs: dict[tuple[str, str], str] = {}  # (workspace, session) -> the CLAUDE_CONFIG_DIR its shim reported ("": unset)
_modes: dict[str, tuple[str, str]] = {}  # workspace -> (main's session, the permission mode its hooks reported: note_mode)
SHIM_PIDS_KEPT = 256  # _shim_pids and _shim_configs keep the newest this many
STAMP_LINES = 200  # _began_since looks this far into a transcript for its first record with a timestamp
CURSOR_CALLS = 200  # the cursor keeps the names of main's newest this many tool calls, for results that come later
SUBS_KEY = "subs"  # sessions.json: each followed subagent transcript's place, by its path (_sub_places)


# --------------------------------------------------------------------------- sessions.json


def _sessions_path(c: str) -> Path:
    return config.workspace_dir(c) / "sessions.json"


def sessions(c: str) -> dict[str, dict]:
    try:
        d = json.loads(_sessions_path(c).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def _persist(lv: Live, *, keep_subs: bool = True) -> None:
    """Write the session's record in sessions.json, keeping the tail's cursor and, unless `keep_subs` is false (a new
    attach, whose subagents are followed anew), the subagents' places (SUBS_KEY)."""
    d = sessions(lv.c)
    old = d.get(lv.sid) if isinstance(d.get(lv.sid), dict) else {}
    cursor, subs = old.get("cursor"), old.get(SUBS_KEY) if keep_subs else None
    d[lv.sid] = {"session": lv.sid, "cwd": lv.cwd, "transcript_path": lv.transcript_path, "pid": lv.pid, "since": lv.since,
                 **({"config_dir": lv.config or ""} if lv.config_known else {}),
                 **({"cursor": cursor} if cursor else {}), **({SUBS_KEY: subs} if isinstance(subs, dict) else {})}
    atomic_write_text(_sessions_path(lv.c), json.dumps(d, indent=1))


def _mark_ended(c: str, sid: str, reason: str | None) -> None:
    d = sessions(c)
    if sid in d and not d[sid].get("ended"):
        d[sid].update({"ended": _now(), "reason": reason or "ended"})
        atomic_write_text(_sessions_path(c), json.dumps(d, indent=1))


def _save_cursor(lv: Live) -> None:
    """Keep the tail's place in sessions.json: the offset of the last whole line translated, the open turn's state, and
    each
    subagent's place (_sub_places), written in the same step as the translation."""
    at = lv.offset - len(lv.buf)
    places = _sub_places(lv)
    offsets = {p: (s["offset"], s["done"]) for p, s in places.items()}
    main_moved = at >= 0 and at != lv.saved
    if not main_moved and offsets == lv.subs_saved:
        return
    d = sessions(lv.c)
    rec = d.get(lv.sid)
    if not isinstance(rec, dict):
        return
    if main_moved:
        names = dict(list(lv.tool_names.items())[-CURSOR_CALLS:])
        rec["cursor"] = {"transcript": lv.transcript_path, "offset": at, "turn_open": lv.turn_open, "fresh": lv.fresh,
                         "wrote": lv.wrote, "tool_names": names, "hidden": [i for i in lv.hidden if i in names],
                         "seen": [k for k in lv.seen if k.split(":", 1)[-1] in names],
                         "watch_calls": [i for i in lv.watch_calls if i in names], "sends": lv.sends,
                         "turn_threads": lv.turn_threads, "forked": sorted(lv.forked)}
    # kept even when empty: a record with places says that a file it names no place for was never read (_restore_subs)
    rec[SUBS_KEY] = places
    atomic_write_text(_sessions_path(lv.c), json.dumps(d, indent=1))
    if main_moved:
        lv.saved = at
    lv.subs_saved = offsets


def _sub_places(lv: Live) -> dict[str, dict]:
    """Where the tail stands in each followed subagent transcript, by path: the offset of its last whole line, whether
    its run
    ended, and what a later line still needs. _restore_subs reads each file on from there."""
    out: dict[str, dict] = {}
    for sub in lv.subs:
        at = sub.offset - len(sub.buf)
        if sub.path is None or at <= 0:
            continue
        names = dict(list(sub.names.items())[-CURSOR_CALLS:])
        seen = sorted(k for k in sub.seen if k.startswith("skip:") or k.split(":", 1)[-1] in names)[-2 * CURSOR_CALLS:]
        out[str(sub.path)] = {"offset": at, "done": sub.done, "names": names, "seen": seen,
                              **({"report": sub.report} if sub.report else {})}
    return out


def _restore_cursor(lv: Live, cur: Any) -> None:
    """After a restart under the session: read on from the cursor _save_cursor kept, with the open turn's state, when it
    is for the same transcript and within it; else the tail starts at the transcript's end, as for a new attach."""
    if not isinstance(cur, dict) or not lv.transcript_path or cur.get("transcript") != lv.transcript_path:
        return
    at = cur.get("offset")
    if not isinstance(at, int) or isinstance(at, bool) or at < 0 or at > _size(Path(lv.transcript_path)):
        return
    lv.offset = lv.saved = at
    lv.turn_open, lv.fresh, lv.wrote = bool(cur.get("turn_open")), bool(cur.get("fresh")), bool(cur.get("wrote"))
    lv.tool_names = {str(k): str(v) for k, v in (cur.get("tool_names") or {}).items()}
    lv.hidden = {str(i) for i in cur.get("hidden") or []}
    lv.seen = {str(k) for k in cur.get("seen") or []}
    lv.watch_calls = {str(i) for i in cur.get("watch_calls") or []}
    lv.sends = {str(k): str(v) for k, v in (cur.get("sends") or {}).items()}
    lv.turn_threads = [str(t) for t in cur.get("turn_threads") or []]
    lv.forked = {str(t) for t in cur.get("forked") or []}
    if lv.turn_open:
        agents.set_running(lv.c, agents.MAIN_ID, True)


def find_transcript(sid: str, config_dir: Path | None = None) -> str | None:
    """The session's transcript, `<claude config>/projects/<slug>/<sid>.jsonl`, found by its id; None until the CLI has
    written it. Tries the session's own config dir, then the served one, then this server's CLAUDE_CONFIG_DIR."""
    bases = [config_dir, config.claude_config_dir(), config.config_dir_of(config.own_claude_config())]
    for base in dict.fromkeys(Path(b) / "projects" for b in bases if b is not None):
        try:
            hits = sorted(base.glob(f"*/{sid}.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            continue
        if hits:
            return str(hits[0])
    return None


def _learn_config(lv: Live, reported: str | None) -> bool:
    """Keep the session's config dir, as its shim reported it ("" for unset, None when not reported), on `lv` and serve
    it (config.serve_claude_config); True when it is new for `lv`."""
    value = reported or None
    if reported is None or (lv.config_known and lv.config == value):
        return False
    lv.config, lv.config_known = value, True
    config.serve_claude_config(value, f"{lv.c}'s session {lv.sid}")
    return True


# --------------------------------------------------------------------------- attach and detach


def current(c: str) -> Live | None:
    return _live.get(c)


def attach(c: str, sid: Any, cwd: Any, transcript_path: str | None = None, pid: int | None = None,
           config_dir: str | None = None, *, follow: bool = False, after: str | None = None) -> Live | None:
    """Make the session main; the Live, or None for a malformed id. `config_dir` is the session's CLAUDE_CONFIG_DIR ("" for
    unset, None for what its shim reported); `follow` says the session runs in the process of the one it replaces
    (_follow); `attached.after` names the previous main when it still runs in another process."""
    sid, cwd = str(sid or ""), str(cwd or "")
    if not SID_RE.match(sid):
        return None
    # `/thimble` names neither; the session's shim reported both when it subscribed
    pid = pid or _shim_pids.get((c, sid))
    config_dir = _shim_configs.get((c, sid)) if config_dir is None else config_dir
    cur = _live.get(c)
    if cur is not None and cur.sid == sid:
        if pid:
            cur.pid = pid
        if _learn_config(cur, config_dir):
            if not cur.transcript_path:
                cur.transcript_path = find_transcript(sid, cur.config_dir)
            _persist(cur)
        if transcript_path and not cur.transcript_path:
            cur.transcript_path = transcript_path
        _cancel_grace(c)
        _ensure_tail(cur)
        return cur
    if cur is not None:
        if after is None and not follow and _runs_elsewhere(c, cur, pid):
            after = cur.sid
        detach(c, cur.sid, "replaced")
    meta = agents.ensure_main(c)
    held = meta.get("attached") or {}
    stored = sessions(c).get(sid) or {}
    restored = held.get("session") == sid and not stored.get("ended")  # this server restarted under the session
    lv = Live(c, sid, cwd or str(stored.get("cwd") or ""), transcript_path or stored.get("transcript_path"),
              pid or stored.get("pid"))
    _learn_config(lv, config_dir)
    lv.transcript_path = lv.transcript_path or find_transcript(sid, lv.config_dir)
    if restored:
        lv.since = str(stored.get("since") or lv.since)
        _restore_cursor(lv, stored.get("cursor"))
    # A session followed before comes back under the same id when resumed, so its subagents' and forks' transcripts are
    # picked up where they stand rather than read from their start.
    _restore_subs(lv, stored.get(SUBS_KEY), revive=restored)
    _live[c] = lv
    if not restored:
        own = cc_settings.analyst_effort(Path(lv.cwd)) if lv.cwd else None
        meta["attached"] = {"session": sid, "cwd": lv.cwd, "since": lv.since, **({"settings_effort": own} if own else {}),
                            **({"after": after} if after else {})}
        meta["ended"] = None
        agents.write_meta(c, meta)
        agents.notify(c, agents.MAIN_ID)
    elif "permission_mode" in held and _modes.get(c, ("",))[0] != sid:  # an earlier server's report, no longer in force
        del held["permission_mode"]
        agents.write_meta(c, meta)
    _persist(lv, keep_subs=restored or bool(lv.subs))
    _cancel_grace(c)
    _ensure_tail(lv)
    if not restored:
        with contextlib.suppress(Exception):
            _bg().new_main(c)
    log.info("%s: session %s attached (%s)", c, sid, "restored" if restored else "new")
    return lv


def note_mode(c: str, sid: str | None, mode: str) -> None:
    """Main's hooks report the permission mode Claude Code runs the session `sid` in: when `sid` is main, this server
    keeps it (main_mode), the mode each agent's row follows until the analyst sets it (modes.py), and main's meta shows
    it (`attached.permission_mode`)."""
    lv = _live.get(c)
    if lv is None or not sid or lv.sid != sid or mode not in modes.CLAUDE_MODES:
        return
    _modes[c] = (sid, mode)
    meta = agents.meta_or_none(c, agents.MAIN_ID) or {}
    held = meta.get("attached") or {}
    if held.get("session") == sid and held.get("permission_mode") != mode:
        meta["attached"] = {**held, "permission_mode": mode}
        agents.write_meta(c, meta)
        agents.notify(c, agents.MAIN_ID)


def main_mode(c: str) -> str | None:
    """The permission mode main's hooks last reported to this server (note_mode), by Claude Code's name; None before
    the first report."""
    lv, got = _live.get(c), _modes.get(c)
    return got[1] if lv is not None and got is not None and got[0] == lv.sid else None


def _runs_elsewhere(c: str, cur: Live, pid: int | None) -> bool:
    """Whether session `cur` still runs in a `claude` process other than `pid`'s: its shim is subscribed, and the two
    pids, where both are known, differ."""
    from . import channel  # noqa: PLC0415

    if cur.sid not in channel.subscribed_sessions(c):
        return False
    own = cur.pid or _shim_pids.get((c, cur.sid))
    return not (pid and own and pid == own)


def _restore_subs(lv: Live, places: Any = None, *, revive: bool = True) -> None:
    """After a restart, or when a session followed before is attached again: the session's subagent chats and threads'
    forks
    are picked up where their files are, finished ones as done so _scan_subs matches them to their chats. Each file
    is
    read on from its kept place first, before main's transcript; a file with no kept place starts at its start when
    its
    chat is empty, else at its end."""
    kept = {str(k): v for k, v in places.items() if isinstance(v, dict)} if isinstance(places, dict) else None
    for meta in agents.list_chats(lv.c):
        fork = meta.get("fork") or {}
        if meta.get("kind") == agents.KIND_THREAD and fork.get("agent_id") and fork.get("session") == lv.sid:
            sub = Sub(lv.c, str(meta["id"]), fork.get("tool_use_id"), fork.get("agent_id"), thread=True)
            sub.done = True
            lv.subs.append(sub)
        elif meta.get("role") in (SUBAGENT_ROLE, orientation.ROLE) and meta.get("session") == lv.sid:
            sub = Sub(lv.c, str(meta["id"]), meta.get("tool_use_id"), meta.get("agent_id"), role=str(meta["role"]))
            sub.of_main = True
            sub.done = meta.get("status") != "running"
            if meta.get("workflow_dir"):
                sub.workflow, sub.workflow_dir = True, Path(str(meta["workflow_dir"]))
            lv.subs.append(sub)
    if not lv.subs:
        return
    _scan_subs(lv, replay=False, places=kept)
    for sub in lv.subs:
        place = (kept or {}).get(str(sub.path)) if sub.path is not None else None
        if revive and sub.thread and place and place.get("done") is False:
            sub.done = False  # the fork was still at work when the last server stopped
            agents.set_running(lv.c, sub.chat, True)
    for sub in list(lv.subs):
        if sub.path is not None and sub.offset < _size(sub.path):
            _tail_sub(lv, sub)
            if not revive and sub.thread and not sub.done:
                # lines the previous process's fork wrote while no server ran: they reach the thread, and the fork ended
                # with that
                # process
                sub.done = True
                agents.set_running(lv.c, sub.chat, False)
    lv.subs_saved = {p: (s.get("offset"), s.get("done")) for p, s in (kept or {}).items()}


def _written(c: str, chat: str) -> bool:
    """Whether the chat's log has any line."""
    try:
        return agents.paths(c, chat)[1].stat().st_size > 0
    except (OSError, ValueError):
        return False


def _take_place(sub: Sub, path: Path, place: Any, at_end: bool) -> None:
    """Start following a subagent's transcript at the place kept for it (_sub_places) when that place is within the
    file, with the calls and the report it needs; else at the file's end when `at_end`, else at its start."""
    at = place.get("offset") if isinstance(place, dict) else None
    if isinstance(at, int) and not isinstance(at, bool) and 0 < at <= _size(path):
        sub.offset, sub.prompted = at, True
        sub.names.update({str(k): str(v) for k, v in (place.get("names") or {}).items()})
        sub.seen.update(str(k) for k in place.get("seen") or [])
        if place.get("report") and not sub.report:
            sub.report = str(place["report"])
    elif at_end:
        sub.offset, sub.prompted = _size(path), True


def detach(c: str, sid: str, reason: str | None = None) -> bool:
    """The session is no longer main: the tail stops, a running subagent is stopped, and main's meta drops `attached`
    and
    names the session in `ended` ({session, cwd, at}). True when this session was main."""
    lv = _live.get(c)
    if lv is not None and lv.sid == sid:
        _live.pop(c, None)
        if lv.task is not None:
            lv.task.cancel()
            lv.task = None
        for sub in lv.subs:
            if not sub.done:
                _finish_sub(lv, sub, "stopped", agents.STOPPED_LINE, kind=threads.SESSION_ENDED)
    try:
        threads.session_ended(c, sid)
    except Exception:  # noqa: BLE001 — the threads' bookkeeping never keeps a session attached
        log.exception("%s: the threads of session %s were not released", c, sid)
    _mark_ended(c, sid, reason)
    agents.set_running(c, agents.MAIN_ID, False)
    meta = agents.ensure_main(c)
    held = meta.get("attached")
    if not held or held.get("session") != sid:
        return False
    meta["attached"] = None
    meta["alert"] = None
    meta["ended"] = {"session": sid, "cwd": str(held.get("cwd") or ""), "at": _now()}
    agents.write_meta(c, meta)
    agents.notify(c, agents.MAIN_ID)
    log.info("%s: session %s detached (%s)", c, sid, reason or "ended")
    return True


def connected(c: str, sid: str | None, cwd: str, pid: int | None, config_dir: str | None = None, *,
              claim: bool = True) -> None:
    """A shim subscribed, naming its session's `claude` pid and CLAUDE_CONFIG_DIR. On the channel (`claim`) the session it
    names is main. On the hook and Monitor routes only /thimble makes a session main, so a subscription attaches only the
    current (or last) main, or a new session in main's own `claude` process (`pid`), which main follows (_follow)."""
    for table, value in ((_shim_pids, pid), (_shim_configs, config_dir)):
        if sid and value is not None:
            table.pop((c, sid), None)
            table[(c, sid)] = value
            while len(table) > SHIM_PIDS_KEPT:
                table.pop(next(iter(table)))
    old = None
    if not claim:
        held = ((agents.meta_or_none(c, agents.MAIN_ID) or {}).get("attached") or {}).get("session")
        cur = _live.get(c)
        if not sid:
            return
        if sid not in (held, cur.sid if cur is not None else None):
            if not pid or pid != main_pid(c):
                return
            old = cur.sid if cur is not None else held
    elif sid and pid:
        cur = _live.get(c)
        if cur is not None and cur.sid != sid and pid == main_pid(c):
            old = cur.sid
    _cancel_grace(c)
    _came_back.add(c)
    if old:
        _follow(c, str(old), str(sid), cwd, pid)
    elif sid:
        attach(c, sid, cwd, None, pid)


def main_pid(c: str) -> int | None:
    """The pid of the `claude` process main's session runs in: what its shim reported, else (after a restart, before
    that shim came back) what sessions.json recorded for the session main's meta names."""
    cur = _live.get(c)
    if cur is not None:
        return cur.pid or _shim_pids.get((c, cur.sid))
    held = ((agents.meta_or_none(c, agents.MAIN_ID) or {}).get("attached") or {}).get("session")
    rec = sessions(c).get(str(held)) if held else None
    if not rec or rec.get("ended"):
        return None
    with contextlib.suppress(TypeError, ValueError):
        return int(rec.get("pid") or 0) or None
    return None


def may_follow(c: str, sid: str, pid: int | None) -> bool:
    """Whether a watcher of non-main session `sid` waits rather than stops: it runs in main's process and is a session
    main
    will follow (a new /clear session, or one /resume brought back)."""
    if not pid or pid != main_pid(c):
        return False
    cur = _live.get(c)
    state = _read_state(_sessions_dir(cur.config_dir if cur is not None else None) / f"{pid}.json")
    return sid not in sessions(c) or state.get("sessionId") == sid


def _follow(c: str, old: str, new: str, cwd: str, pid: int | None, config_dir: str | None = None) -> None:
    """Main's `claude` process runs a new session (/clear, /resume): it becomes main in place of `old`, keeps the known
    Monitor tasks, and takes the events queued for `old` (channel.move_events)."""
    from . import channel  # noqa: PLC0415

    cur = _live.get(c)
    tasks = set(cur.watch_tasks) if cur is not None and cur.sid == old else set()
    since = cur.since if cur is not None and cur.sid == old else (sessions(c).get(old) or {}).get("since")
    if config_dir is None and cur is not None and cur.config_known:
        config_dir = cur.config or ""  # the same `claude` process: the same config dir
    lv = attach(c, new, cwd, None, pid, config_dir, follow=True)  # detaches `old` as replaced when it is attached
    if lv is None:
        return
    if cur is None:
        _mark_ended(c, old, "replaced")
    # a transcript /clear started holds only this session, so read it from its start and nothing typed before the shim
    # reported the new id is lost; a session /resume brought back is read from its end
    if _began_since(lv.transcript_path, since):
        lv.offset = 0
    lv.watch_tasks |= tasks
    channel.move_events(c, old, new)
    log.info("%s: session %s follows %s in the same process (pid %s)", c, new, old, pid)


def disconnected(c: str, sid: str | None) -> None:
    """A shim's subscription ended: when none of main's is left after GRACE_S, the session is gone."""
    from . import channel  # noqa: PLC0415

    def mains() -> bool:
        lv = _live.get(c)
        return channel.listening(c, lv.sid if lv is not None else None)

    if mains():
        return
    _cancel_grace(c)

    def check() -> None:
        _grace.pop(c, None)
        if _shutting_down():
            return  # stopping ends every subscription at once; the session's shim comes back to the next server
        lv = _live.get(c)
        if not mains() and lv is not None and (sid is None or lv.sid == sid):
            detach(c, lv.sid, "ended")
            _hand_back(c, lv.sid)

    try:
        _grace[c] = asyncio.get_running_loop().call_later(GRACE_S, check)
    except RuntimeError:
        check()


def may_return(c: str, sid: str) -> bool:
    """Whether session `sid` is main again when main's session ends (_hand_back): another session replaced it and its
    shim is still subscribed."""
    from . import channel  # noqa: PLC0415

    return (sessions(c).get(sid) or {}).get("reason") == "replaced" and sid in channel.subscribed_sessions(c)


def _hand_back(c: str, gone: str) -> None:
    """Main's session `gone` ended while a session it replaced still runs: the most recently replaced one is main again,
    by the pid its shim reported, and its dormant watcher takes the next event."""
    from . import channel  # noqa: PLC0415

    recs = sessions(c)
    live = [s for s in dict.fromkeys(channel.subscribed_sessions(c)) if s and s != gone and may_return(c, s)]
    if not live:
        return
    back = max(live, key=lambda s: str(recs[s].get("ended") or ""))
    rec = recs[back]
    pid = _shim_pids.get((c, back))
    if attach(c, back, str(rec.get("cwd") or ""), rec.get("transcript_path"), pid, after=gone) is not None:
        log.info("%s: session %s ended; main is session %s again, which it had replaced", c, gone, back)


def _cancel_grace(c: str) -> None:
    h = _grace.pop(c, None)
    if h is not None:
        h.cancel()


def expect(c: str, event_id: str, *, thread: str | None = None) -> None:
    """The channel logged event `event_id` as it posted it: the mirror skips its record, and main runs until the turn
    ends. A
    thread's event is remembered with its thread (thread_for)."""
    _expected.add(event_id)
    if thread:
        _event_threads[event_id] = thread
    agents.set_running(c, agents.MAIN_ID, True)
    lv = _live.get(c)
    if lv is not None:
        lv.wake.set()


def handed(c: str, event_id: str, thread: str) -> None:
    """A thread's event main got in a tool's result (channel.hand): main's turn counts it as an event that reached it
    (_channel), and until the turn ends a turn the tail opens late keeps it."""
    _event_threads[event_id] = thread
    lv = _live.get(c)
    if lv is not None:
        lv.turn_threads.append(thread)
        lv.handed.append(thread)


def relay(c: str, chat: str, text: str, by: str) -> None:
    """A message the analyst sent a subagent of main's through main (the orientation in terminal-first mode): its chat
    shows it as theirs now, and main's SendMessage that passes it on is not logged again (_relayed)."""
    agents.Recorder(c, chat).record("user", text=text, by=by, event=RELAY_EVENT)
    _relays.setdefault(chat, []).append(by)


def push_event(c: str, kind: str, text: str, **meta: Any) -> bool:
    """Server code's way to send the session an event (a built view's `view`, dev.run_view): channel.post with `text`
    as the body and `meta` as its attributes; False when no session listens."""
    from fastapi import HTTPException  # noqa: PLC0415

    from . import channel  # noqa: PLC0415

    try:
        channel.post(c, kind, {"text": text, **meta}, check_kind=False)
    except HTTPException as e:
        if e.status_code == 409:
            return False
        raise
    return True


# --------------------------------------------------------------------------- main's records


def _rec(lv: Live, type_: str, **data: Any) -> dict:
    lv.wrote = True
    data.setdefault("by", TERMINAL)
    return agents.mirror(lv.c, type_, **data)


def _short(name: str) -> str:
    return name.rsplit("__", 1)[-1]


def response_text(resp: Any) -> str:
    """The text of a tool result as the transcript carries it: a string or content blocks."""
    if isinstance(resp, list):
        return "\n".join(str(b.get("text", "")) if isinstance(b, dict) and b.get("type") == "text"
                         else "[image]" if isinstance(b, dict) and b.get("type") == "image"
                         else json.dumps(b, ensure_ascii=False) if isinstance(b, dict) else str(b) for b in resp)
    if isinstance(resp, dict):
        return json.dumps(resp, ensure_ascii=False)
    return "" if resp is None else str(resp)


def not_run(tool_use_id: str) -> None:
    """The call `tool_use_id` is made again, so its error result, when it comes, shows as not run (`not_run`)."""
    _not_run[tool_use_id] = None
    while len(_not_run) > NOT_RUN_KEEP:
        _not_run.pop(next(iter(_not_run)))


def _result_data(tool_use_id: str, name: str, response: Any, is_error: bool = False) -> dict[str, Any]:
    full = response_text(response)
    data: dict[str, Any] = {"id": tool_use_id, "summary": full[:SUMMARY_LIMIT]}
    if is_error and tool_use_id in _not_run:
        data["not_run"] = True
    elif is_error:
        data["is_error"] = True
    if _short(name) in CELL_TOOLS:
        cid = agents.cell_id(full)
        if cid:
            data["cell_id"] = cid
    elif _short(name) == LABEL_TOOL and not is_error and (m := LABEL_CARD_RE.search(full)):
        data["label_card"] = m.group(1)
    return data


def _open_turn(lv: Live) -> None:
    """A record that starts main's turn: the analyst's line, an event, a task notification. Several before the first
    assistant record open the same turn."""
    if not lv.turn_open or not lv.fresh:
        lv.turn_open, lv.fresh, lv.wrote, lv.turn_threads, lv.forked = True, True, False, list(lv.handed), set()
        lv.flagged, lv.answered, lv.held_by_check, lv.stop_noted = False, True, False, False
    agents.set_running(lv.c, agents.MAIN_ID, True)


def _release_threads(lv: Live) -> None:
    """A thread's event marks the thread running until its fork stops. A thread whose event reached the turn but was
    neither
    forked nor messaged has no fork to stop it, so it stops here."""
    for tid in dict.fromkeys(lv.turn_threads):
        if tid not in lv.forked:
            threads.released(lv.c, tid)
    lv.turn_threads, lv.forked, lv.handed = [], set(), []


def _end_turn(lv: Live) -> None:
    _release_threads(lv)
    _asked(lv, False)  # a relayed prompt the terminal answered before the tail saw the wait
    if lv.flagged and not lv.answered:
        _stopped(lv, SAFETY_STOP_TEXT)
    if lv.wrote:
        agents.mirror(lv.c, "done", by=TERMINAL, session_id=lv.sid)
    lv.turn_open = lv.fresh = lv.wrote = False
    agents.set_running(lv.c, agents.MAIN_ID, False)


def _note(lv: Live, text: str) -> None:
    """A quiet line in main about the session itself (module note, stops and waits)."""
    lv.wrote = True
    agents.chip(lv.c, CHIP_KIND, text)


def _safety_stop(lv: Live) -> None:
    lv.flagged, lv.answered = True, False
    _note(lv, SAFETY_TEXT)


def _stopped(lv: Live, text: str) -> None:
    """The turn's end, noted once: an interrupt, or the stop of a turn the safety check ended."""
    if not lv.stop_noted:
        lv.stop_noted = True
        _note(lv, text)


def _interrupted(lv: Live) -> None:
    """The analyst pressed Esc in the terminal. After a stop whose retry wrote nothing, or while the dialog that follows
    a stop held the turn, it was the safety check that ended the turn; else the analyst did."""
    if lv.turn_open:
        _stopped(lv, SAFETY_STOP_TEXT if lv.held_by_check or (lv.flagged and not lv.answered) else INTERRUPTED_TEXT)


def _user_line(lv: Live, text: str, by: str = TERMINAL, **extra: Any) -> None:
    _open_turn(lv)
    lv.fresh = True
    _rec(lv, "user", text=text, by=by, **extra)


def _channel(lv: Live, raw: str, *, mid_turn: bool) -> None:
    """A channel event as the session received it (module note)."""
    m = CHANNEL_RE.match(raw or "")
    attrs = {k: html.unescape(v) for k, v in ATTR_RE.findall(m.group(1))} if m else {}
    body = m.group(2) if m else str(raw or "")
    kind, event_id, thread = attrs.get("kind", ""), attrs.get("event", ""), attrs.get("thread")
    if not mid_turn:
        _open_turn(lv)
    if kind == "thread" and thread:
        lv.turn_threads.append(thread)
    if event_id and event_id in _expected:
        _expected.discard(event_id)
        return
    if kind == "main" or not kind:
        lv.wrote = True
        agents.mirror(lv.c, "user", by=BROWSER, text=body.strip(), event=event_id or None)


def _nudged(lv: Live) -> None:
    """Claude Code asked main for a visible reply after a turn with no text: when the turn's last call was a tool the
    session's terminal_tools.ENV names, and it did not fail, Claude Code does not act on it (terminal_tools.nudged)."""
    from . import procs  # noqa: PLC0415

    if lv.last_failed:
        return  # Claude Code asks for a reply after a failed or refused call whatever ENV names
    with contextlib.suppress(Exception):
        if terminal_tools.nudged(procs.environ(lv.pid), lv.last_tool):
            log.warning("%s: session %s was asked for a reply after %s", lv.c, lv.sid, lv.last_tool)


def _command_line(text: str) -> str | None:
    m = COMMAND_RE.search(text)
    if not m:
        return None
    args = COMMAND_ARGS_RE.search(text)
    return " ".join(p for p in (m.group(1).strip(), (args.group(1).strip() if args else "")) if p)


def browser_events(text: str) -> list[str]:
    """The browser events a task notification carries, each as its `<channel …>…</channel>` text; a Monitor event's
    `<event>` block is escaped, so it is unescaped once."""
    blocks = MONITOR_EVENT_RE.findall(text or "")
    if blocks:
        return [tag for block in blocks for tag in EVENT_TAG_RE.findall(html.unescape(block))]
    return EVENT_TAG_RE.findall(text or "")


def _task_notification(lv: Live, text: str) -> None:
    fields = dict(TASK_FIELD_RE.findall(text or ""))
    if fields.get("task-id") in lv.watch_tasks:
        _open_turn(lv)  # thimble's Monitor expired or ended: main arms it again, a call that is no row in main
        return
    sub = _sub_by(lv, agent_id=fields.get("task-id")) or _sub_by(lv, tool_use_id=fields.get("tool-use-id"))
    _open_turn(lv)
    if sub is None:
        return
    _tail_sub(lv, sub)
    _finish_sub(lv, sub, _task_status(fields.get("status")), str(fields.get("result") or "").strip() or None)


def _task_status(status: Any) -> str:
    """A task notification's status as a chat's: done, stopped or failed."""
    status = str(status or "").strip()
    return "done" if status in TASK_DONE else "stopped" if status in TASK_STOPPED else "failed"


def _child_finished(lv: Live, text: str) -> None:
    """A task notification in a subagent's own transcript: a subagent it started (the writer's verifier) has stopped.
    Main never sees that notification, so the child's chat is finished here, and main's turn is left alone."""
    fields = dict(TASK_FIELD_RE.findall(text or ""))
    sub = _sub_by(lv, agent_id=fields.get("task-id")) or _sub_by(lv, tool_use_id=fields.get("tool-use-id"))
    if sub is None or sub.done:
        return
    _tail_sub(lv, sub)
    _finish_sub(lv, sub, _task_status(fields.get("status")), str(fields.get("result") or "").strip() or None)


def _peer(lv: Live, *, mid_turn: bool, origin: Any = None) -> None:
    """A message another session sent main (module note), a subagent's hand-back among them: no row of its own, since
    it is neither the analyst's line nor main's, except one from a background session of thimble's, which main's chat
    shows as a chip naming it. On its own record it opens main's turn."""
    if not mid_turn:
        _open_turn(lv)
    o = origin if isinstance(origin, dict) else {}
    name, body = str(o.get("name") or ""), " ".join(cite.prose(str(o.get("body") or "")).split())
    e = _bg().by_name(lv.c, name) or _bg().by_name(lv.c, name.replace("-", ":", 1)) if name.startswith("thimble") else None
    if e is not None and body:
        with contextlib.suppress(Exception):
            agents.chip(lv.c, CHIP_KIND, f"{e.name} to main: {body[:RESULT_LIMIT]}", chat=e.chat)


def visible(text: str) -> str:
    """A text as a chat shows it (module note, the end token): empty when it is only END_TOKEN, the words before the
    token when it ends with it (END_RE), and any other text as it is, without its lines that open with TERMINAL_ONLY,
    and with the citations written as Markdown links for the terminal in their chat form (cite.from_links)."""
    m = END_RE.search(text)
    text = cite.from_links(text[: m.start()].rstrip() if m else text)
    if TERMINAL_ONLY not in text:
        return text
    return "\n".join(ln for ln in text.split("\n") if not ln.lstrip().startswith(TERMINAL_ONLY)).strip()


def _text(lv: Live, text: str) -> None:
    text = visible(text)
    if not text.strip():
        return
    _rec(lv, "text", delta=text)


def _tool_use(lv: Live, tool_use_id: str, name: str, tool_input: Any) -> None:
    lv.tool_names[tool_use_id] = name
    lv.last_tool, lv.last_failed = name, False
    if f"use:{tool_use_id}" in lv.seen:
        return
    lv.seen.add(f"use:{tool_use_id}")
    if name in PLUMBING_TOOLS:
        lv.hidden.add(tool_use_id)
        return
    inp = tool_input if isinstance(tool_input, dict) else {}
    if name.startswith("mcp__") and _short(name) == WAIT_SESSION:
        lv.hidden.add(tool_use_id)  # a tray entry's tool, which main's call only gets refused (bg_session)
        return
    if name == MONITOR_TOOL and WATCHER in str(inp.get("command") or ""):
        lv.hidden.add(tool_use_id)  # thimble's own plumbing on the Monitor route (module note)
        lv.watch_calls.add(tool_use_id)
        return
    if name in AGENT_TOOLS:
        tid = thread_for(lv.c, inp.get("description"))
        if tid:
            lv.hidden.add(tool_use_id)
            lv.forked.add(tid)
            _spawn(lv, tool_use_id, None, str(inp.get("description") or ""), inp.get("subagent_type"))
            return
        if _bg().is_proxy(lv.c, inp.get("subagent_type"), inp.get("description"), inp.get("prompt")):
            lv.hidden.add(tool_use_id)  # a background session's tray entry, which that session's chat stands for
            _spawn(lv, tool_use_id, None, str(inp.get("description") or ""), inp.get("subagent_type"), inp.get("prompt"))
            return
    if name == SEND_TOOL:
        sub = _sub_by(lv, agent_id=str(inp.get("to") or inp.get("recipient") or ""))
        if sub is not None and sub.thread:
            lv.hidden.add(tool_use_id)
            lv.forked.add(sub.chat)
            lv.sends[tool_use_id] = sub.chat
            sub.done = False
            agents.set_running(lv.c, sub.chat, True)
            if sub.chat not in lv.turn_threads:  # not the relay of a message the browser logged in the thread
                _relayed(sub, inp)
            return
        if sub is not None and sub.owner is None and not sub.proxy:  # a proxy's session's chat logs it (bg_session)
            _relayed(sub, inp)
    _rec(lv, "tool_use", id=tool_use_id, name=name, input=tool_input)
    if name in AGENT_TOOLS:
        _spawn(lv, tool_use_id, None, str(inp.get("description") or ""), inp.get("subagent_type"), inp.get("prompt"))
    elif name == WORKFLOW_TOOL:
        _spawn_workflow(lv, tool_use_id, inp)


def _relayed(sub: Sub, inp: dict) -> None:
    """Main's SendMessage to a thread's fork or a subagent: its chat shows the message as from main, so the browser
    holds the same conversation as the terminal's agent view; a message the analyst sent through main is shown already
    (relay), as theirs."""
    waiting = _relays.get(sub.chat)
    if waiting:
        by = waiting.pop(0)
        sub.relay_by = by if sub.done else None  # the message resumes a finished subagent (_resumed)
        return
    text = str(inp.get("message") or inp.get("content") or "").strip()
    if text:
        sub.rec.record("user", text=text, by=RELAYED_BY)


def _tool_result(lv: Live, tool_use_id: str, content: Any, is_error: bool = False) -> None:
    if f"result:{tool_use_id}" in lv.seen:
        return
    lv.seen.add(f"result:{tool_use_id}")
    name = lv.tool_names.get(tool_use_id, "")
    if is_error and name == lv.last_tool:
        lv.last_failed = True
    if tool_use_id in lv.watch_calls:
        m = MONITOR_TASK_RE.search(response_text(content))
        if m:
            lv.watch_tasks.add(m.group(1))
    if tool_use_id not in lv.hidden:
        _rec(lv, "tool_result", **_result_data(tool_use_id, name, content, is_error))
    tid = lv.sends.pop(tool_use_id, None)
    if tid and is_error:
        # the fork is gone (a session that ended in this process): the turn's end releases the thread unless main
        # forks it anew meanwhile, and its next event forks anew
        for gone in [x for x in lv.subs if x.thread and x.chat == tid]:
            gone.done = True
        lv.forked.discard(tid)
        threads.fork_lost(lv.c, tid)
    sub = _sub_by(lv, tool_use_id=tool_use_id)
    if sub is not None and name in AGENT_TOOLS:
        _agent_result(lv, sub, content, is_error)
    elif sub is not None and sub.workflow:
        _workflow_result(lv, sub, content, is_error)


# --------------------------------------------------------------------------- subagents


def thread_for(c: str, description: Any) -> str | None:
    """The thread an Agent call's description names: `thread:<fork name>` (threads.fork_name), `thread:<thread id>`, or
    the id of a thread's event in its place."""
    tid = threads.thread_of(description)
    if tid and not threads.is_thread(c, tid):
        tid = _event_threads.get(tid) or threads.by_fork_name(c, tid)
    return tid if tid and threads.is_thread(c, tid) else None


def _sub_by(lv: Live, *, tool_use_id: str | None = None, agent_id: str | None = None) -> Sub | None:
    for sub in lv.subs:
        if tool_use_id and sub.tool_use_id == tool_use_id:
            return sub
        if agent_id and sub.agent_id == agent_id:
            return sub
    return None


def _spawn(lv: Live, tool_use_id: str | None, agent_id: str | None, title: str, agent_type: Any,
           prompt: Any = None) -> Sub:
    """The Sub for an Agent call, made on its first sighting (the tool_use, or the file's meta json) and completed by
    the later one. A `thread:<id>` description joins the thread's chat; any other is a new agent chat in main."""
    sub = _sub_by(lv, tool_use_id=tool_use_id) or _sub_by(lv, agent_id=agent_id)
    if sub is None and _bg().is_proxy(lv.c, agent_type, title, prompt):
        sub = Sub(lv.c, agents.MAIN_ID, tool_use_id, agent_id)  # it records nothing (proxy)
        sub.proxy = sub.of_main = True
        sub.report = _bg().proxy_started(lv.c, str(agent_type), str(title), agent_id, prompt)  # the session it shows
        lv.subs.append(sub)
        return sub
    if sub is None:
        tid = thread_for(lv.c, title)
        if tid:
            sub = Sub(lv.c, tid, tool_use_id, agent_id, thread=True)
            lv.subs.append(sub)
            threads.fork_started(lv.c, tid, agent_id=agent_id, tool_use_id=tool_use_id, session=lv.sid)
            return sub
        role = orientation.ROLE if orientation.is_orient(agent_type) else SUBAGENT_ROLE
        title = orientation.TITLE if role == orientation.ROLE else " ".join(title.split()) or SUBAGENT_TITLE
        meta = agents.new_agent(lv.c, role, title, by=TERMINAL, session=lv.sid, tool_use_id=tool_use_id, agent_id=agent_id,
                                agent_type=agent_type if isinstance(agent_type, str) else None)
        sub = Sub(lv.c, str(meta["id"]), tool_use_id, agent_id, role=role)
        sub.of_main = True
        lv.subs.append(sub)
        if role == orientation.ROLE:
            _orientation(orientation.started, lv.c, sub.chat, agent_id=agent_id)
        return sub
    fields: dict[str, Any] = {}
    if tool_use_id and not sub.tool_use_id:
        sub.tool_use_id = fields["tool_use_id"] = tool_use_id
    if agent_id and not sub.agent_id:
        sub.agent_id = fields["agent_id"] = agent_id
    if sub.proxy:
        if fields.get("agent_id") and sub.report:
            _bg().proxy_agent(lv.c, sub.report, sub.agent_id)
        return sub
    if sub.thread:
        if not sub.done:  # a finished fork's file found again (a restart) is not a fork starting; a follow-up wakes it
            threads.fork_started(lv.c, sub.chat, agent_id=sub.agent_id, tool_use_id=sub.tool_use_id, session=lv.sid)
    elif fields:
        agents.update_agent(lv.c, sub.chat, **fields)
        if sub.role == orientation.ROLE and fields.get("agent_id"):
            _orientation(orientation.started, lv.c, sub.chat, agent_id=sub.agent_id)
    return sub


def _orientation(fn: Any, *args: Any, **kwargs: Any) -> None:
    """Call orientation.started or finished for the orientation's chat; its record is bookkeeping the mirror never stops
    for, so a failure is logged."""
    try:
        fn(*args, **kwargs)
    except Exception:  # noqa: BLE001
        log.exception("%s: the orientation's record was not updated by %s", args[0] if args else "?", getattr(fn, "__name__", fn))


def _agent_result(lv: Live, sub: Sub, content: Any, is_error: bool) -> None:
    """The Agent tool's result. A background agent's says it was launched and names its agent id; it stops at its task
    notification. A foreground agent's is its outcome, and its chat ends once its file has been quiet (the CLI writes
    its last text moments later)."""
    text = response_text(content)
    m = AGENT_ID_RE.search(text)
    if m and not sub.agent_id:
        _spawn(lv, sub.tool_use_id, m.group(1), "", None)
    _scan_subs(lv)
    if ASYNC_RESULT_RE.match(text) and not is_error:
        return
    if sub.path is not None:
        _tail_sub(lv, sub)
    sub.finish = ("failed" if is_error else "done", text.strip()[:RESULT_LIMIT] or None)
    sub.quiet_since = time.monotonic()


def _finish_sub(lv: Live, sub: Sub, status: str, result: str | None, *, kind: str | None = None) -> None:
    """End a subagent's chat, or a thread's run; `kind` says why a thread's fork did not finish (threads.STOP_TEXT)."""
    if sub.done:
        return
    if sub.proxy:
        sub.done = True
        _bg().proxy_ended(lv.c, sub.agent_id)
        return
    if sub.agent_id and sub.agent_id in _channel_module().asking(lv.c):
        _channel_module().agent_moved(lv.c, sub.agent_id, float("inf"))  # a stopped agent's prompt is gone
    if sub.owner is not None:  # one agent of a workflow: the chat is the workflow's, which ends with the workflow
        sub.done = True
        return
    if sub.workflow:  # its agents' last lines first, then the chat ends with the workflow's return value
        _scan_subs(lv)
        for member in [m for m in lv.subs if m.owner is sub]:
            _tail_sub(lv, member)
            member.done = True
        result = _workflow_value(result)
    sub.done = True
    sub.finish = None
    try:
        if sub.thread:
            threads.fork_finished(lv.c, sub.chat, status, kind=kind)
        else:
            agents.finish_agent(lv.c, sub.chat, status, (sub.report or result or "")[:RESULT_LIMIT] or None)
    except Exception:  # noqa: BLE001 — a chat deleted under the mirror
        log.debug("%s: subagent chat %s could not be finished", lv.c, sub.chat, exc_info=True)
    if sub.role == orientation.ROLE:
        k = int((orientation.read_run(lv.c) or {}).get("run") or 0)
        if k > 0:  # a follow-up of the orientation's subagent (_revive)
            _orientation(orientation.run_finished, lv.c, sub.chat, k, status, {})
        else:
            _orientation(orientation.finished, lv.c, sub.chat, status, sub.report or result)


def _agent_dir(lv: Live) -> Path | None:
    return Path(lv.transcript_path).parent / lv.sid if lv.transcript_path else None


def _read_meta_json(path: Path) -> dict:
    try:
        d = json.loads(path.with_name(path.name[: -len(".jsonl")] + ".meta.json").read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def _scan_subs(lv: Live, replay: bool = True, places: dict[str, dict] | None = None) -> None:
    """Adopt the subagent transcripts under the session's directory not yet followed, linked to their Agent call by the
    meta
    json's toolUseId (untitled after META_WAIT_SCANS scans without one). `replay` False is a restart: each file
    starts at
    its kept place, or at its end when its chat was followed before."""
    d = _agent_dir(lv)
    if d is None:
        return
    found: list[Path] = []
    for sub_dir in AGENT_DIRS:
        try:
            found.extend(p for p in (d / sub_dir if sub_dir else d).iterdir() if AGENT_FILE_RE.match(p.name))
        except OSError:
            continue
    for path in sorted(found):
        key = str(path)
        if key in lv.sub_paths:
            continue
        agent_id = AGENT_FILE_RE.match(path.name).group(1)  # type: ignore[union-attr]
        meta = _read_meta_json(path)
        if not meta:
            lv.pending_paths[key] = lv.pending_paths.get(key, 0) + 1
            if lv.pending_paths[key] <= META_WAIT_SCANS and _sub_by(lv, agent_id=agent_id) is None:
                continue
        lv.pending_paths.pop(key, None)
        lv.sub_paths.add(key)
        use = str(meta.get("toolUseId") or "") or None
        followed = _sub_by(lv, tool_use_id=use) or _sub_by(lv, agent_id=agent_id)
        sub = _spawn(lv, use, agent_id, str(meta.get("description") or ""), meta.get("agentType"))
        sub.path = path
        if not replay:
            # a chat that has lines and no kept place was read by an earlier attach, so its file is not read again
            read_before = followed is not None and (places is None or _written(lv.c, sub.chat))
            _take_place(sub, path, (places or {}).get(key), at_end=read_before)
    for owner in [s for s in lv.subs if s.workflow and s.workflow_dir is not None]:
        _scan_workflow(lv, owner, replay, places)


def _scan_workflow(lv: Live, owner: Sub, replay: bool, places: dict[str, dict] | None = None) -> None:
    """Adopt the agent transcripts of a workflow's run directory not yet followed, as members of the workflow's chat.
    `replay`
    False is a restart: each file starts at its kept place, else at its end."""
    try:
        paths = sorted(p for p in owner.workflow_dir.iterdir() if AGENT_FILE_RE.match(p.name))  # type: ignore[union-attr]
    except OSError:
        return
    for path in paths:
        key = str(path)
        if key in lv.sub_paths:
            continue
        lv.sub_paths.add(key)
        agent_id = AGENT_FILE_RE.match(path.name).group(1)  # type: ignore[union-attr]
        member = Sub(lv.c, owner.chat, None, agent_id, role=owner.role)
        member.owner, member.path, member.done = owner, path, owner.done
        if not replay:
            _take_place(member, path, (places or {}).get(key), at_end=places is None)
        lv.subs.append(member)


def _spawn_workflow(lv: Live, tool_use_id: str, inp: dict) -> Sub:
    """The agent chat of a Workflow call of main's, titled by its script's meta, running until the workflow's task
    notification."""
    sub = _sub_by(lv, tool_use_id=tool_use_id)
    if sub is not None:
        return sub
    script = str(inp.get("script") or "")
    if not script and inp.get("scriptPath"):
        with contextlib.suppress(OSError, UnicodeDecodeError):
            script = Path(str(inp["scriptPath"])).read_text("utf-8")[:SCRIPT_READ_CHARS]
    meta = {k: v.strip() for k, _, v in WORKFLOW_META_RE.findall(script.split("}", 1)[0])}
    name = meta.get("name") or str(inp.get("name") or "").strip()
    title = " ".join((meta.get("description") or name).split()) or WORKFLOW_TITLE
    chat = agents.new_agent(lv.c, SUBAGENT_ROLE, title, by=TERMINAL, session=lv.sid, tool_use_id=tool_use_id,
                            agent_type=WORKFLOW_TOOL)
    sub = Sub(lv.c, str(chat["id"]), tool_use_id, None)
    sub.workflow = True
    lv.subs.append(sub)
    return sub


def _workflow_result(lv: Live, sub: Sub, content: Any, is_error: bool) -> None:
    """The Workflow call's result: the run went to the background and names its transcript directory, or it failed to
    start and the chat ends with the error."""
    text = response_text(content)
    m = WORKFLOW_DIR_RE.search(text)
    if is_error or not m:
        _finish_sub(lv, sub, "failed", text.strip()[:RESULT_LIMIT] or None)
        return
    sub.workflow_dir = Path(m.group(1))
    agents.update_agent(lv.c, sub.chat, workflow_dir=str(sub.workflow_dir))
    _scan_workflow(lv, sub, True)


def _workflow_value(result: str | None) -> str | None:
    """A workflow's return value as its task notification carries it: JSON, so a script that returned a string reads as
    that string, unquoted."""
    text = str(result or "").strip()
    if text.startswith('"'):
        with contextlib.suppress(ValueError):
            value = json.loads(text)
            if isinstance(value, str):
                return value.strip()
    return text or None


def _tail_sub(lv: Live, sub: Sub) -> int:
    """Translate what a subagent's transcript gained since the last read into its chat. A thread's fork that grows
    after it finished was resumed by a follow-up, so it runs again."""
    if sub.path is None:
        return 0
    size = _size(sub.path)
    if sub.proxy:
        sub.offset = size  # a proxy's lines are the background session's own, which that session's chat shows
        return 0
    if size < sub.offset:
        sub.offset, sub.buf = 0, b""
    if size == sub.offset:
        return 0
    with sub.path.open("rb") as f:
        f.seek(sub.offset)
        data = f.read(size - sub.offset)
    sub.offset = size
    sub.quiet_since = time.monotonic()
    if sub.thread and sub.done:
        sub.done = False
        agents.set_running(lv.c, sub.chat, True)
    lines = (sub.buf + data).split(b"\n")
    sub.buf = lines.pop()
    resumed = _resumed(lines, sub.relay_by) if sub.done and not sub.thread and sub.owner is None and not sub.workflow else None
    if resumed is not None:
        sub.relay_by = None
        _revive(lv, sub, resumed)
    n = 0
    try:
        for line in lines:
            if line.strip():
                n += translate_sub(lv, sub, line)
    except Unreadable as e:
        log.warning("%s: subagent %s transcript unreadable (%s)", lv.c, sub.chat, e)
        sub.rec.error(UNREADABLE_TEXT, detail=str(e)[:200], by=TERMINAL)
        sub.path = None
    done = _results(sub, lines)
    if done and sub.on_results is not None:
        sub.on_results(done)
    if done and sub.agent_id and sub.agent_id in _channel_module().asking(lv.c):
        _channel_module().calls_done(lv.c, sub.agent_id, done)
    return n


def _results(sub: Sub, lines: list[bytes]) -> list[tuple[tuple[str, str], float]]:
    """The calls whose results lines of a subagent's transcript hold (_results_in)."""
    return _results_in(sub.call_keys, lines)


def _results_in(call_keys: dict[str, tuple[str, str]], lines: list[bytes]) -> list[tuple[tuple[str, str], float]]:
    """The calls whose results lines of a transcript hold, each as channel.call_key names it, with the result's time;
    the calls themselves are kept in `call_keys` as they appear, since a result may come in a later read."""
    out: list[tuple[tuple[str, str], float]] = []
    for line in lines:
        if b'"tool_use"' not in line and b'"tool_result"' not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get("message") if isinstance(rec, dict) else None
        content = msg.get("content") if isinstance(msg, dict) else None
        for b in content if isinstance(content, list) else []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and isinstance(b.get("id"), str):
                call_keys[b["id"]] = _channel_module().call_key(str(b.get("name") or ""), b.get("input"))
            elif b.get("type") == "tool_result" and b.get("tool_use_id") in call_keys:
                out.append((call_keys.pop(b["tool_use_id"]), _stamp(line) or time.time()))
    return out


def _resumed(lines: list[bytes], relayed_by: str | None = None) -> list[dict] | None:
    """Whether lines a finished subagent's transcript gained show it working again, a reply of its own or a message
    the analyst or main sent it, which resumes it: the messages ({text, by}), else None when it did not resume. Main's
    message is `relayed_by`'s when main passed it on for them (relay)."""
    resumed, messages = False, []
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        origin = rec.get("origin") if isinstance(rec.get("origin"), dict) else {}
        typed = _typed(rec)
        if typed is not None:
            messages.append({"text": typed, "by": TERMINAL})
        elif origin.get("kind") == "coordinator":
            m = COORDINATOR_RE.match(_user_text(rec) or "")
            messages.append({"text": (m.group(1) if m else _user_text(rec) or "").strip(), "by": relayed_by or RELAYED_BY})
        resumed = resumed or rec.get("type") == "assistant" or typed is not None or origin.get("kind") == "coordinator"
    return messages if resumed else None


def _revive(lv: Live, sub: Sub, messages: list[dict]) -> None:
    """A finished subagent was resumed (a message from the analyst's agent view or from main): its chat runs again,
    and an orientation's record with it, so its next end closes them anew. An orientation whose first run failed runs
    that run again (its drafts stay held); one that had finished takes the messages as a follow-up, run k+1."""
    sub.done = False
    sub.finish = None
    try:
        agents.update_agent(lv.c, sub.chat, status="running", ts_end=None, result=None)
    except Exception:  # noqa: BLE001 — a chat deleted under the mirror
        log.debug("%s: subagent chat %s could not run again", lv.c, sub.chat, exc_info=True)
        return
    log.info("%s: subagent %s (%s) was resumed", lv.c, sub.agent_id, sub.chat)
    if sub.role != orientation.ROLE:
        return
    rec = orientation.read_run(lv.c) or {}
    k = int(rec.get("run") or 0)
    if k == 0 and rec.get("status") == "failed":
        _orientation(orientation.restarted, lv.c, sub.chat)
    else:
        _orientation(orientation.run_started, lv.c, sub.chat, k + 1, messages)


async def call_session(c: str, tool_use_id: str | None) -> str | None:
    """The session a call through main's shim acts for: the orientation's (tools.ORIENT_SESSION) when the call is one
    of the orientation subagent's in terminal-first mode, or of a subagent it started, else None (main's own). Claude
    Code writes a call's line to its transcript on a timer, so the call can arrive before its line does: the session's
    transcripts are read until one holds the call's id, for CALL_WAIT_S at most."""
    from . import tools  # noqa: PLC0415 — tools imports far more than the mirror needs

    lv = _live.get(c)
    if lv is None or not tool_use_id or not any(_orient_working(s) for s in lv.subs if s.role == orientation.ROLE):
        return None
    needle = tool_use_id.encode()
    read: dict[str, int] = {}
    deadline = time.monotonic() + CALL_WAIT_S
    scanned = False
    while True:
        holder = _call_holder(lv, tool_use_id, needle, read)
        if holder is not None:
            return tools.ORIENT_SESSION if holder in _orient_family(lv) else None
        if time.monotonic() >= deadline:
            log.info("%s: call %s is in no transcript after %.1f s; it is main's", c, tool_use_id, CALL_WAIT_S)
            return None
        if not scanned or any(s.path is None for s in lv.subs if s.role == orientation.ROLE):
            _scan_subs(lv)  # the call may come from a subagent whose transcript is not followed yet
            scanned = True
        await asyncio.sleep(CALL_POLL_S)


def agent_paths(c: str, agent_ids: "list[str]") -> "list[Path]":
    """The transcripts of main's subagents `agent_ids` that the tail has found."""
    lv = _live.get(c)
    want = set(agent_ids)
    return [sub.path for sub in (lv.subs if lv is not None else []) if sub.agent_id in want and sub.path is not None]


async def caller_sub(c: str, tool_use_id: str | None) -> "Sub | None":
    """Main's subagent whose transcript holds the call `tool_use_id`, waiting CALL_WAIT_S at most for its line; None for
    main's own call or one found in no transcript."""
    lv = _live.get(c)
    if lv is None or not tool_use_id:
        return None
    needle, read = tool_use_id.encode(), {}
    deadline = time.monotonic() + CALL_WAIT_S
    scanned = False
    while True:
        holder = _call_holder(lv, tool_use_id, needle, read)
        if holder is not None:
            return holder if isinstance(holder, Sub) else None
        if time.monotonic() >= deadline:
            return None
        if not scanned:
            _scan_subs(lv)
            scanned = True
        await asyncio.sleep(CALL_POLL_S)


def _orient_working(sub: Sub) -> bool:
    """Whether an orientation subagent works: its chat runs, or its transcript grew since the tail last read it (a
    resume the tail has not seen yet)."""
    return not sub.done or (sub.path is not None and _size(sub.path) > sub.offset)


def _orient_family(lv: Live) -> set[Sub]:
    """The orientation subagents of the session and the subagents they started, by the Agent calls in their
    transcripts."""
    family = {s for s in lv.subs if s.role == orientation.ROLE}
    while True:
        calls = {u for s in family for u in s.names}
        more = {s for s in lv.subs if s not in family and s.tool_use_id in calls}
        if not more:
            return family
        family |= more


def _call_holder(lv: Live, tool_use_id: str, needle: bytes, read: dict[str, int]) -> Sub | Live | None:
    """The subagent, or main (`lv`), whose transcript holds the call `tool_use_id`, else None. `read` keeps where each
    file was read to, so a later look reads only what was added."""
    for sub in lv.subs:
        if tool_use_id in sub.names:
            return sub
    files: list[tuple[Sub | Live, Path]] = [(s, s.path) for s in lv.subs if s.path is not None]
    if lv.transcript_path:
        files.append((lv, Path(lv.transcript_path)))
    for holder, path in files:
        key = str(path)
        size = _size(path)
        start = read.get(key, max(0, size - CALL_TAIL))
        if size <= start:
            continue
        try:
            with path.open("rb") as f:
                f.seek(start)
                data = f.read(size - start)
        except OSError:
            continue
        read[key] = max(start, size - len(needle))
        if needle in data:
            return holder
    return None


def _bg() -> Any:
    from . import bg_session  # noqa: PLC0415 — bg_session imports this module

    return bg_session


def running_agents(c: str) -> list[dict[str, Any]]:
    """The agents of main's session that run now, for the terminal's list of thimble's agents (bg_session.agent_rows):
    each thread's fork by its fork name, the orientation subagent, and main's other subagents, {name, state, kind}."""
    lv = _live.get(c)
    out: list[dict[str, Any]] = []
    for sub in list(lv.subs) if lv is not None else []:
        if sub.done or sub.proxy or sub.owner is not None:
            continue
        meta = agents.meta_or_none(c, sub.chat) or {}
        if sub.thread:
            name = f"fork {meta.get(threads.FORK_NAME_KEY) or meta.get('title') or sub.chat}"
        elif sub.role == orientation.ROLE:
            name = f"{orientation.PLUGIN}:{orientation.SUBAGENT}"
        elif sub.of_main:
            name = str(meta.get("title") or "subagent")
        else:
            continue
        waiting = sub.agent_id is not None and sub.agent_id in _channel_module().asking(c)
        out.append({"name": name, "state": "waiting for a permission prompt" if waiting else "working", "kind": "subagent"})
    return out


def _channel_module() -> Any:
    from . import channel  # noqa: PLC0415 — as elsewhere here: channel imports session lazily too

    return channel


def _stamp(line: bytes | str) -> float:
    """A transcript record's `timestamp` as time.time() counts it; 0.0 when it has none."""
    try:
        ts = json.loads(line).get("timestamp")
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() if ts else 0.0
    except (ValueError, TypeError, AttributeError):
        return 0.0


def _began_since(path: str | None, since: str | None) -> bool:
    """Whether the transcript at `path` began no earlier than `since` (an ISO time), judged by its first timestamped
    record.
    True when there is no such record, no file, or `since` is unknown."""
    try:
        start = datetime.fromisoformat(str(since).replace("Z", "+00:00")).timestamp() if since else None
    except ValueError:
        start = None
    if start is None or not path:
        return True
    try:
        with open(path, "rb") as f:
            for _, line in zip(range(STAMP_LINES), f):
                stamp = _stamp(line)
                if stamp:
                    return stamp >= start
    except OSError:
        pass
    return True


def _typed(rec: dict) -> str | None:
    """A message the analyst typed to the subagent in Claude Code's agent view: a queued command or a meta prompt whose
    origin is human, the prompt's wrapper taken off (TYPED_RE). None for any other record."""
    if rec.get("type") == "attachment":
        att = rec.get("attachment") if isinstance(rec.get("attachment"), dict) else {}
        origin = att.get("origin") if isinstance(att.get("origin"), dict) else {}
        if att.get("type") == "queued_command" and origin.get("kind") == "human":
            return str(att.get("prompt") or "").strip() or None
        return None
    origin = rec.get("origin") if isinstance(rec.get("origin"), dict) else {}
    if rec.get("type") != "user" or not rec.get("isMeta") or origin.get("kind") != "human":
        return None
    text = _user_text(rec) or ""
    m = TYPED_RE.match(text)
    return (m.group(1) if m else text).strip() or None


def translate_sub(lv: Live, sub: Sub, line: bytes | str) -> int:
    """One line of a subagent's transcript into its chat: tool calls and results, its text (a thread's fork's as its
    reply, without the lines only the terminal shows), the messages the analyst typed to it in the agent view, and for
    an agent chat the prompts it was sent."""
    rec = _load(line)
    n = 0
    att = rec.get("attachment") if rec.get("type") == "attachment" and isinstance(rec.get("attachment"), dict) else None
    if att is not None and "<task-notification>" in str(att.get("prompt") or ""):
        _child_finished(lv, str(att["prompt"]))  # a subagent this one started has stopped
        return 0
    typed = _typed(rec)
    if typed is not None:
        if typed == sub.typed:
            return 0  # the same message in its other shape
        sub.typed = typed
        sub.rec.record("user", text=typed, by=TERMINAL)
        return 1
    origin = rec.get("origin") if isinstance(rec.get("origin"), dict) else {}
    if rec.get("type") == "user" and origin.get("kind") in ("peer", "task-notification"):
        return 0  # a hand-back or a notice from a subagent this one started, which is no line of this chat
    if rec.get("type") == "user" and not sub.thread and not rec.get("isMeta"):
        prompt = _user_text(rec)
        if prompt and prompt.strip() and not prompt.lstrip().startswith("<"):
            if INTERRUPT_RE.match(prompt.strip()):
                return 0  # the stop's own line: the chat's end says it was stopped
            first, sub.prompted = not sub.prompted, True
            if first and sub.of_main and sub.role == orientation.ROLE:
                return 0  # the orientation subagent's prompt names its prompt file, which its card stands for
            sub.rec.record("user", text=prompt.strip(), by=TERMINAL)
            return 1
    if rec.get("type") == "user":
        for b in _content_list(rec):
            if not isinstance(b, dict) or b.get("type") != "tool_result" or not isinstance(b.get("tool_use_id"), str):
                continue
            tid = b["tool_use_id"]
            if tid == sub.tool_use_id or f"result:{tid}" in sub.seen or f"skip:{tid}" in sub.seen:
                continue
            sub.seen.add(f"result:{tid}")
            if sub.calls is not None:
                sub.calls.result(tid, b, rec)
            data = _result_data(tid, sub.names.get(tid, ""), b.get("content"), bool(b.get("is_error")))
            sub.rec.tool_result(tid, data.pop("summary"), is_error=bool(data.pop("is_error", False)), by=TERMINAL,
                                **{k: v for k, v in data.items() if k != "id"})
            if data.get("cell_id"):  # the card is this subagent's or this fork's, not main's
                agents.claim_cell(lv.c, data["cell_id"], sub.chat, edit=_short(sub.names.get(tid, "")) in ("edit_card", "edit_cell"))
            n += 1
        return n
    if rec.get("type") != "assistant":
        return 0
    for b in _blocks(rec):
        if b["type"] == "text":
            if not isinstance(b.get("text"), str):
                raise Unreadable("a text block without text")
            text = visible(b["text"])
            if text.strip():
                sub.rec.text(text, by=TERMINAL, **({"reply": True} if sub.thread else {}))
                n += 1
        elif b["type"] == "tool_use":
            if not isinstance(b.get("id"), str) or not isinstance(b.get("name"), str):
                raise Unreadable("a tool_use block without id or name")
            tid, name = b["id"], b["name"]
            if tid == sub.tool_use_id or f"use:{tid}" in sub.seen:
                continue
            if (sub.thread and _short(name) == REPLY_TOOL) or name in PLUMBING_TOOLS:
                sub.seen.add(f"skip:{tid}")
                continue
            sub.seen.add(f"use:{tid}")
            sub.names[tid] = name
            n_ = sub.calls.use(tid, name, b.get("input")) if sub.calls is not None else None
            sub.rec.tool_use(tid, name, b.get("input"), by=TERMINAL, **({"n": n_} if n_ else {}))
            inp = b.get("input") if isinstance(b.get("input"), dict) else {}
            if name == HANDBACK_TOOL and str(inp.get("message") or "").strip():
                sub.report = str(inp["message"]).strip()
            n += 1
    return n


# --------------------------------------------------------------------------- the tail


def _load(line: bytes | str) -> dict:
    try:
        rec = json.loads(line)
    except ValueError as e:
        raise Unreadable(f"not JSON ({e})") from e
    if not isinstance(rec, dict):
        raise Unreadable("a record that is not an object")
    return rec


def _content_list(rec: dict) -> list:
    msg = rec.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    return content if isinstance(content, list) else []


def _blocks(rec: dict) -> list[dict]:
    msg = rec.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    if not isinstance(content, list):
        raise Unreadable("an assistant record without content blocks")
    for b in content:
        if not isinstance(b, dict) or not isinstance(b.get("type"), str):
            raise Unreadable("a content block without a type")
    return content


def _user_text(rec: dict) -> str | None:
    """The text of a user record that is a prompt (a string, or text blocks and no tool result), else None."""
    msg = rec.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list) and content and all(isinstance(b, dict) and b.get("type") == "text" for b in content):
        return "\n".join(str(b.get("text") or "") for b in content)
    return None


def translate(lv: Live, line: bytes | str) -> None:
    """One line of main's transcript into main's log (module note). Raises Unreadable on a line or a record the pinned
    shapes do not cover."""
    rec = _load(line)
    t = rec.get("type")
    if rec.get("isSidechain"):
        return
    origin = (rec.get("origin") or {}).get("kind") if isinstance(rec.get("origin"), dict) else None
    if t == "user":
        for b in _content_list(rec) if lv.turn_open else ():
            if isinstance(b, dict) and b.get("type") == "tool_result" and isinstance(b.get("tool_use_id"), str):
                _tool_result(lv, b["tool_use_id"], b.get("content"), bool(b.get("is_error")))
        text = _user_text(rec)
        if text is None:
            return
        if origin == "channel":
            _channel(lv, text, mid_turn=False)
        elif origin == "task-notification" and browser_events(text):
            for tag in browser_events(text):
                _channel(lv, tag, mid_turn=False)
        elif origin == "task-notification":
            _task_notification(lv, text)
        elif origin == "peer":
            _peer(lv, mid_turn=False, origin=rec.get("origin"))
        elif rec.get("isMeta"):
            if LOCAL_CAVEAT in text:
                lv.local_prompt = str(rec.get("promptId") or "")
            elif text.startswith(terminal_tools.NUDGE):
                _nudged(lv)
            return
        elif origin == "human" or origin is None:
            command = _command_line(text)
            pid = str(rec.get("promptId") or "")
            # without a promptId only the command's own records count, so a later line is the analyst's again
            local = (lv.local_prompt is not None and pid == lv.local_prompt
                     and (pid != "" or text.lstrip().startswith(("<command-", "<local-command-"))))
            if not local:
                lv.local_prompt = None
            if local:
                pass  # a local command, its line and its output: no turn, no row (module note, the table)
            elif INTERRUPT_RE.match(text.strip()):
                _interrupted(lv)
            elif command is not None and command.split()[0] in CONNECT_COMMANDS:
                if lv.turn_open:
                    _end_turn(lv)  # an earlier turn that never got its turn_duration
                # /thimble's own turn is not mirrored (module note, the table): turn_open stays False, so its reply
                # is skipped too
            elif command is not None:
                _user_line(lv, command)
            elif not text.lstrip().startswith("<"):
                _user_line(lv, text.strip())
        return
    if t == "attachment":
        att = rec.get("attachment") if isinstance(rec.get("attachment"), dict) else {}
        if att.get("type") == "queued_command":
            aorigin = (att.get("origin") or {}).get("kind") if isinstance(att.get("origin"), dict) else None
            prompt = str(att.get("prompt") or "")
            tags = browser_events(prompt) if aorigin in (None, "task-notification") else []
            if aorigin == "channel":
                _channel(lv, prompt, mid_turn=True)
            elif tags:
                for tag in tags:
                    _channel(lv, tag, mid_turn=True)
            elif aorigin == "task-notification" or att.get("commandMode") == "task-notification":
                # a subagent that ended while main's turn went on
                fields = dict(TASK_FIELD_RE.findall(prompt))
                sub = _sub_by(lv, agent_id=fields.get("task-id")) or _sub_by(lv, tool_use_id=fields.get("tool-use-id"))
                if sub is not None:
                    _tail_sub(lv, sub)
                    _finish_sub(lv, sub, _task_status(fields.get("status")), str(fields.get("result") or "").strip() or None)
            elif aorigin == "peer":
                _peer(lv, mid_turn=True, origin=att.get("origin"))
            elif prompt.strip() and not prompt.lstrip().startswith("<"):
                _rec(lv, "user", text=prompt.strip(), by=TERMINAL)
        return
    if t == "system":
        if rec.get("subtype") == "turn_duration":
            _end_turn(lv)
        elif rec.get("subtype") == "informational" and SAFETY_RE.search(str(rec.get("content") or "")):
            _safety_stop(lv)
        elif rec.get("subtype") == FALLBACK_SUBTYPE and rec.get("scope", "session") == "session" and rec.get("direction", "retry") == "retry":
            _note(lv, FALLBACK_TEXT.format(model=model_label(str(rec.get("fallbackModel") or ""))))
        return
    if t != "assistant":
        return
    _note_model(lv, rec)
    if not lv.turn_open:
        return  # /thimble's own turn, or one the tail joined in the middle of: mirroring starts at the next
    lv.fresh = False
    # the retry after a stop, if there was one, is writing; after the dialog, the analyst chose to go on
    lv.answered, lv.held_by_check = True, False
    for b in _blocks(rec):
        if b["type"] == "text":
            if not isinstance(b.get("text"), str):
                raise Unreadable("a text block without text")
            _text(lv, b["text"])
        elif b["type"] == "tool_use":
            if not isinstance(b.get("id"), str) or not isinstance(b.get("name"), str):
                raise Unreadable("a tool_use block without id or name")
            _tool_use(lv, b["id"], b["name"], b.get("input"))


def model_label(model_id: str) -> str:
    """A model's name as the analyst reads it, `claude-opus-4-8` as Opus 4.8 (the frontend's modelLabel)."""
    raw = model_id.strip()
    tag = re.search(r"\[([^\]]+)\]$", raw)
    core = raw[: tag.start()] if tag else raw
    parts = [p for p in re.split(r"[-_]", re.sub(r"^claude[-_]", "", core, flags=re.I)) if p]
    if not parts:
        return raw or "another model"
    version = ".".join(p for p in parts[1:] if re.fullmatch(r"\d{1,3}", p))
    return " ".join(x for x in (parts[0].capitalize(), version, tag.group(1) if tag else "") if x)


def _note_model(lv: Live, rec: dict) -> None:
    """The model, effort and fast mode of main's replies, kept on main's `attached` for the composer's chip."""
    msg = rec.get("message")
    model = msg.get("model") if isinstance(msg, dict) else None
    effort = rec.get("effort") if isinstance(rec.get("effort"), str) else None
    usage = msg.get("usage") if isinstance(msg, dict) and isinstance(msg.get("usage"), dict) else {}
    speed = usage.get("speed")
    fast = speed == "fast" if speed in ("fast", "standard") else None
    if not isinstance(model, str) or not model or model.startswith("<"):
        model = None
    if (model is None or model == lv.model) and (effort is None or effort == lv.effort) and (fast is None or fast == lv.fast):
        return
    lv.model, lv.effort = model or lv.model, effort or lv.effort
    lv.fast = lv.fast if fast is None else fast
    meta = agents.ensure_main(lv.c)
    held = meta.get("attached") or {}
    fresh = {k: v for k, v in (("model", lv.model), ("effort", lv.effort), ("fast", lv.fast)) if v is not None and held.get(k) != v}
    if held.get("session") == lv.sid and fresh:
        meta["attached"] = {**held, **fresh}
        agents.write_meta(lv.c, meta)
        agents.notify(lv.c, agents.MAIN_ID)


def tail_once(lv: Live) -> None:
    """Translate what the transcript and the subagents' transcripts gained since the last read."""
    if not lv.transcript_path:
        lv.transcript_path = find_transcript(lv.sid, lv.config_dir)
        if lv.transcript_path:
            _persist(lv)
    _tail_main(lv)
    if lv.transcript_path and (lv.busy or lv.pending_paths):
        _scan_subs(lv)
    for sub in lv.subs:
        if sub.path is not None and (not sub.done or sub.offset < _size(sub.path)):
            _tail_sub(lv, sub)
        if sub.finish and not sub.done and time.monotonic() - sub.quiet_since >= SUB_QUIET_S:
            _finish_sub(lv, sub, *sub.finish)
    _save_cursor(lv)  # the subagents' places, and the runs that ended
    _watch_wait(lv)


def _sessions_dir(config_dir: Path | None = None) -> Path:
    """Claude Code's records of its running processes, `sessions/<pid>.json`, in `config_dir` (a session's own,
    Live.config_dir), else in the config dir this server serves."""
    return (config_dir or config.claude_config_dir()) / "sessions"


def _read_state(path: Path) -> dict:
    try:
        d = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def session_state(lv: Live) -> dict:
    """Claude Code's own record of the session, `<claude config>/sessions/<pid>.json` (module note): by the pid the shim
    reported, else found by the session id once and its pid kept. {} when there is none for this session."""
    if lv.pid:
        state = _read_state(_sessions_dir(lv.config_dir) / f"{lv.pid}.json")
        return state if state.get("sessionId") == lv.sid else {}
    try:
        paths = sorted(_sessions_dir(lv.config_dir).glob("*.json"))
    except OSError:
        return {}
    for path in paths:
        state = _read_state(path)
        if state.get("sessionId") == lv.sid:
            with contextlib.suppress(TypeError, ValueError):
                lv.pid = int(state.get("pid") or path.stem)
            return state
    return {}


def _watch_wait(lv: Live) -> None:
    """While a turn is open or a subagent runs, a dialog or prompt that holds the session for WAIT_NOTE_S gets one note.
    The
    model-switch dialog after a safety stop sets the alert on main's meta instead, cleared when the session moves on."""
    state = session_state(lv) if lv.busy else {}
    what = str(state.get("waitingFor") or DIALOG_WAIT) if state.get("status") == "waiting" else None
    if what != PERMISSION_WAIT and lv.wait is not None and lv.wait[0] == PERMISSION_WAIT:
        _asked(lv, False)
    if state and what != PERMISSION_WAIT:
        from . import channel  # noqa: PLC0415

        channel.release_asks(lv.c, ASK_RELEASE_S)  # a hook's prompt answered in the terminal before the tail saw it
    if what is None:
        lv.wait = None
        _alert(lv, None)
        return
    if lv.wait is None or lv.wait[0] != what:
        lv.wait = (what, time.monotonic(), False)
        if what != DIALOG_WAIT:
            _alert(lv, None)
    since, noted = lv.wait[1], lv.wait[2]
    if noted or time.monotonic() - since < WAIT_NOTE_S:
        return
    lv.wait = (what, since, True)
    safety = what == DIALOG_WAIT and lv.flagged
    lv.held_by_check = lv.held_by_check or safety
    if safety:
        _alert(lv, SAFETY_ALERT)
        return
    if what == PERMISSION_WAIT and _asked(lv, True):
        return  # the prompt is relayed to the browser, which shows it with Allow and Deny
    detail = WAITING_FOR.get(what)
    _note(lv, f"{WAITING_TEXT}: {detail}" if detail else WAITING_TEXT)


def _asked(lv: Live, waiting: bool) -> bool:
    """While the session waits on a permission prompt: whether the shim relayed it (main's meta holds it). Once the
    session no longer waits on one, a relayed request left on main's meta (answered in the terminal) is dropped."""
    meta = agents.meta_or_none(lv.c, agents.MAIN_ID) or {}
    pending = bool(meta.get("permissions"))
    if not waiting and pending:
        from . import channel  # noqa: PLC0415

        channel.clear_permissions(lv.c)
    return waiting and pending


def _alert(lv: Live, text: str | None) -> None:
    """Set or clear main's alert (module note); a meta write only when it changes."""
    if bool(text) == lv.alerted:
        return
    lv.alerted = bool(text)
    meta = agents.ensure_main(lv.c)
    meta["alert"] = {"kind": "safety", "text": text, "since": _now()} if text else None
    agents.write_meta(lv.c, meta)
    agents.notify(lv.c, agents.MAIN_ID)


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _tail_main(lv: Live) -> None:
    if lv.degraded or not lv.transcript_path:
        return
    p = Path(lv.transcript_path)
    try:
        size = p.stat().st_size
    except OSError:
        if lv.offset < 0:
            lv.offset = 0  # not written yet: everything it will hold is this session's
        return
    if lv.offset < 0:
        lv.offset = size  # already there when the session attached: its history is not replayed
        _save_cursor(lv)  # a cursor an earlier attach of this session left would replay that history after a restart
        return
    if size < lv.offset:  # truncated or rewritten
        lv.offset, lv.buf = 0, b""
    if size == lv.offset:
        return
    with p.open("rb") as f:
        f.seek(lv.offset)
        data = f.read(size - lv.offset)
    lv.offset = size
    lines = (lv.buf + data).split(b"\n")
    lv.buf = lines.pop()  # a partial last line waits for the rest
    try:
        for line in lines:
            if line.strip():
                translate(lv, line)
    except Unreadable as e:
        _degrade(lv, e)
    _save_cursor(lv)
    done = _results_in(lv.call_keys, lines)
    if done:
        _channel_module().calls_done(lv.c, None, done)  # main's own prompts answered in the terminal


def _degrade(lv: Live, err: Exception) -> None:
    if lv.degraded:
        return
    lv.degraded = True
    log.warning("%s: session %s transcript tail disabled (%s)", lv.c, lv.sid, err)
    _rec(lv, "error", message=UNREADABLE_TEXT, detail=str(err)[:200])


async def _tail(lv: Live) -> None:
    while _live.get(lv.c) is lv and not lv.degraded:
        try:
            tail_once(lv)
        except Exception as e:  # noqa: BLE001 — the tail never dies silently
            log.exception("%s: session %s tail failed", lv.c, lv.sid)
            _degrade(lv, e)
            return
        lv.wake.clear()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(lv.wake.wait(), TAIL_BUSY_S if lv.busy else TAIL_IDLE_S)


def _ensure_tail(lv: Live) -> None:
    if lv.degraded or (lv.task is not None and not lv.task.done()):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop (a synchronous test): tail_once drives it
    lv.task = loop.create_task(_tail(lv), name=f"tail:{lv.c}:{lv.sid}")


# --------------------------------------------------------------------------- the startup sweep


def sweep() -> list[str]:
    """Detach every recorded main session in a workspace where no shim is subscribed and main's own has not subscribed
    since
    this server started. Never while the server is stopping, when every workspace looks unsubscribed. Returns the
    session
    ids detached."""
    from . import channel  # noqa: PLC0415

    if _shutting_down():
        return []
    gone: list[str] = []
    for path in sorted(config.WORKSPACES_DIR.glob("*/sessions.json")):
        c = path.parent.name
        if c in _came_back or channel.listening(c):
            continue
        try:
            held = (agents.meta_or_none(c, agents.MAIN_ID) or {}).get("attached") or {}
        except Exception:  # noqa: BLE001 — a workspace whose corpus is gone
            continue
        sid = held.get("session")
        if not sid:
            continue
        try:
            if c in _live:
                detach(c, str(sid), "ended")
            else:
                detach(c, str(sid), "stale")
            gone.append(str(sid))
        except Exception:  # noqa: BLE001
            log.debug("%s: could not detach %s", c, sid, exc_info=True)
    return gone


def _shutting_down() -> bool:
    """Whether the server has begun to stop: uvicorn's `should_exit`, set on SIGTERM before connections close, is the
    same
    flag as sse_starlette's AppStatus.should_exit."""
    server = getattr(signal.getsignal(signal.SIGTERM), "__self__", None)
    if getattr(server, "should_exit", False) is True:
        return True
    try:
        from sse_starlette.sse import AppStatus  # noqa: PLC0415
    except ImportError:
        return False
    return AppStatus.should_exit is True


async def _sweep_later() -> None:
    await asyncio.sleep(GRACE_S * 3)
    try:
        sweep()
    except Exception:  # noqa: BLE001
        log.exception("session sweep failed")


def start_sweep() -> None:
    global _sweep_task
    if _sweep_task is None or _sweep_task.done():
        _sweep_task = asyncio.get_running_loop().create_task(_sweep_later(), name="session-sweep")


async def shutdown() -> None:
    global _sweep_task
    for lv in list(_live.values()):
        if lv.task is not None:
            lv.task.cancel()
    for h in list(_grace.values()):
        h.cancel()
    _grace.clear()
    if _sweep_task is not None:
        _sweep_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _sweep_task
        _sweep_task = None
