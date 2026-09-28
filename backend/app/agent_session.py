"""A Claude Code session thimble starts for one of its agents, beside main: the orientation's (orient_session.py), a
writer's (write_session.py), a report check's run (checks.py) and a critique's (critique_session.py). Each gets a
session of its own with its own system prompt rather than a fork of main.

Start. The server runs `claude -p --agents <json> --agent <name> --session-id <uuid> --output-format stream-json …` in
the corpus folder (command) and writes the first message on stdin, since Linux refuses an argument over 128 KiB. The
agent is defined for that session alone with `--agents`. Its file names no tools, so it has every tool of a default
Claude Code session less the session's --disallowedTools: LATER_TOOLS and the thimble tools that are not its own
(not_own). shared.md is appended with --append-system-prompt, since Claude Code applies an agent's `skills` to
subagents only. The session inherits the analyst's settings; thimble layers on the role's model, effort (also as
CLAUDE_CODE_EFFORT_LEVEL) and fast mode. THIMBLE_SESSION names the session for its shim (`orient`, `writer:<doc>`,
`critique:orient`, `check:<id>:<doc>`).

Permissions. A --print session has no terminal, so a PermissionRequest hook (permission_hook.py) hands each request of
the session, its subagents and workflow agents to ask, which shows it on the chat's card with Allow and Deny. A hook is
used rather than --permission-prompt-tool because the prompt tool never hears background or workflow agents' requests.
Each session runs in the mode of its agent's row (modes.py, the caller's `agent`), or in the mode a card switched it to
(set_mode), which its later runs keep while this server runs (`_switched`). In Bypass ask allows at once; a patient
session's request (the orientation's) waits for the analyst, any other is denied after PERMISSION_WAIT_S. A request
denied unanswered stays on the card, marked `expired`, until the analyst dismisses it or the session ends. thimble's
own tools and skills are always allowed (own_rules).

Hosted sessions. The dev agent's background sessions (dev.py) are not followed here, yet ask answers their hook's
requests the same way: host registers one on its chat for the length of its run, with its agent's mode and its wait
before an unanswered request is denied.

The web. WebFetch and WebSearch follow the mode in every session: in manual mode an `ask` rule sends each call to ask
(web_asks), over the analyst's own allow rules and Claude Code's list of documentation sites it fetches unasked, and in
auto mode the classifier judges them. The card offers "don't ask again" for the site, or for web search, kept for the
workspace in WEB_RULES_FILE, which every session's later request of it meets (web_rules). While a request waits, the
session's later requests for the same site or for search wait on the same card (`groups`), each listed on it whole,
up to WEB_ALSO_MAX.

Don't ask again. The request's `permission_suggestions` become the card's third choice (offer); chosen, they are sent
as `updatedPermissions` with destination session, kept on the chat's meta (RULES_KEY), and put in each later process's
argv (with_rules), since Claude Code holds session rules in memory only.

Auto mode. A call auto mode's classifier refuses never reaches the PermissionRequest hook, so the hook also runs on
PermissionDenied: the card asks the analyst, and an allow answers `retry` and is remembered (`grants`, `passes`, for
GRANT_TTL_S) so a PreToolUse hook (before_call) lets the call made again run. The model may reword the call, so an allow
also covers the same agent's next call of that tool within GRANT_TTL_S. A refusal only because the classifier was
unavailable (CLASSIFIER_DOWN) is no verdict: after each of CLASSIFIER_WAITS_S the hook answers `retry` with nothing
remembered, so auto mode judges the call made again, and only then does the card ask; for a patient session that card
denies the call after CLASSIFIER_ASK_S unanswered, so the session never waits on it for good.

Mode switch. Between Manual and Bypass the switch is instant (both run Claude Code's manual mode). Into or out of Auto,
the process's --permission-mode must change, so the follower pauses the process when it is quiet (no call without its
result), answers waiting requests with `## session-mode-switching` (_release), ends the process (_halt) and resumes it
with --resume in the new mode and `## session-mode-changed` on stdin.

The fence. A caller that passes `work` keeps the corpus folder read-only and the session's writes in that work folder.
The process runs in the work folder with the corpus added via `--add-dir`, since Claude Code's Bash sandbox mounts files
over dangerous names in the process's own folder, which a write deny of that folder would break. Its --settings deny
Edit in the corpus and exclude the CLAUDE.md files of the work folder's ancestry (memory_excludes). Where the sandbox
can run it has no network. A SubagentStart hook gives each subagent its own scratch folder, since the sandbox gives all
agents one $TMPDIR. A caller that passes `unasked` (a writer, a critique, a check's run) also auto-allows Bash in the
sandbox and edits in the work folder (sandbox_allow.py).

Calls. A caller that passes `calls` numbers every call in an orientation chat's sequence (calls.py), and the call-ref
hook (call_ref.py) tells the model each call's ref.

Resume. `resume` (a session id) and `chat` continue that session with `--resume <sid>` into the same chat, as a new run;
the follower starts from the offset the chat's meta keeps (`follow`), so nothing is copied twice.

Follow. The session's transcript, its subagents' transcripts and its workflows' journals are copied into its agent chat
and into step chats (role `step`) with the mirror's translator (session.translate_sub).

End. The last `result` line on stdout is the summary; the caller's `on_end` hears status and summary. Stop signals the
process group and also kills the processes below it, since Claude Code runs each Bash command in a group of its own.

Retry. A session that exits because the API is at capacity (CAPACITY) is started again with `--resume` and
`## session-retry` after waits from retry_waits, until RETRY_BUDGET_S is spent.

Background work. --print's wait for background agents is uncapped (BG_WAIT_ENV) and the tools that schedule a later turn
are disallowed (LATER_TOOLS). A process that exits with background work unreported is resumed with
`## session-unfinished`, at most UNFINISHED_RESUMES times.

Auto mode unavailable. When auto mode's classifier gives no verdict too many times, Claude Code ends the turn
(AUTO_OFF_KIND) and a --print session exits; the session is resumed in Auto up to AUTO_RESUMES times, then waits for
the analyst for up to AUTO_HOLD_S before it resumes in Auto again (_hold).

Safeguards. When a safety classifier stopped a response (`stop_reason: refusal`) and the session made no call after
it, the session runs again once on FALLBACK_MODEL with `## session-model-fallback`; the earlier result is kept
(with_earlier).

Background sessions. In terminal-first mode a caller may pass `background`: the session then runs as a Claude Code
background session (bg_session.py), which the analyst can attach to and message. Its process outlives a run, so a run
ends when the session is idle, and a later turn of the session is a new run of its chat (bg_session.on_wake). A resume
reaches a running session in place rather than with `--resume`, and a retry sends its prompt the same way. A permission
prompt answered in the session's own terminal ends the card's wait once the call's result shows in its transcript.

Restart. The server's stop ends every process; a session whose caller can resume it is left running in its chat for
the next server (_suspend), any other fails. A background session is left running, and the next server follows it again
(bg_session.recover). At start, recover ends processes a dead server left, then resumes each run
through its caller (on_resume) with `## session-restarted`, or closes it (on_left). Ends main did not hear are kept
(UNHEARD_FILE) and posted once a session listens (tell_main, deliver_unheard).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import random
import re
import shlex
import signal
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import (agents, bg_session, calls as calls_store, cc_settings, config, modes, orientation, permission_hook,
               procs, retry, sandbox_allow, session, tools)
from .ledger import atomic_write_text

log = logging.getLogger("thimble.agent_session")
router = APIRouter()

CLAUDE_BIN = config.CLAUDE_BIN
PLUGIN_DIR = config.REPO_ROOT / "plugin"
SESSION_ENV = "THIMBLE_SESSION"  # the shim's name for the session it serves (plugin/bin/thimble-mcp)
# What the shared skill renders after the preamble, appended here, since Claude Code preloads no skill for the agent a
# session runs as. The preamble is not appended: the agent's own body includes it.
SHARED_PROMPTS = ("shared",)
STEP_ROLE = agents.STEP_ROLE  # a subagent or workflow agent of the session
STEP_TITLE = "agent"  # a step whose meta names nothing
POLL_S = 0.5
STOP_WAIT_S = 4.0  # after SIGINT, then again after SIGTERM, before the next signal
# an unanswered permission request is denied after this long, unless its session is patient (the orientation's) or
# hosted with a wait of its own (module note, permissions)
PERMISSION_WAIT_S = 60.0
STDERR_TAIL = 800  # chars of the session's stderr kept as a failed run's error
# of a request's input the card shows, scrolled; past it the entry's `cut` is the input's length and the card offers
# no "don't ask again"
PERMISSION_INPUT_CHARS = 50_000
WORKFLOW_DIR_RE = session.WORKFLOW_DIR_RE
ASYNC_RESULT_RE = session.ASYNC_RESULT_RE
AGENT_TOOLS = session.AGENT_TOOLS
# analyst-facing lines, and the deny messages Claude Code passes to the session's model
DENIED_LINE = "Denied from thimble's browser."
TIMED_OUT_LINE = ("Nobody answered in thimble's browser within {wait}, so the call was denied. Carry on without it, "
                  "or find a way that needs no permission.")
GONE_LINE = "The session ended before it was answered."
ALLOWED_LINE = "Allowed in thimble's browser."  # a refused call made again, once allowed (module note, auto mode)
CALL_REF_HOOK = Path(__file__).with_name("call_ref.py")  # module note, calls
CALL_REF_EVENTS = ("PostToolUse", "PostToolUseFailure")
CALL_REF_TIMEOUT_S = 10
SANDBOX_HOOK = Path(__file__).with_name("sandbox_allow.py")  # module note, the fence
SANDBOX_HOOK_TIMEOUT_S = 10
SCRATCH_HOOK = Path(__file__).with_name("scratch_hook.py")  # module note, the fence: a subagent's own scratch folder
SCRATCH_PROMPT = "session-scratch"  # prompts/tools.md: the line that names it
PERMISSION_HOOK = Path(__file__).with_name("permission_hook.py")  # module note, permissions
REQUEST, DENIED, PRE = permission_hook.REQUEST, permission_hook.DENIED, permission_hook.PRE  # its events
# how long the analyst's answer to a call auto mode refused waits for the model to make that call again (module note,
# auto mode)
GRANT_TTL_S = 600.0
# auto mode's reason when its classifier gave no verdict on a call, the waits before each time the call goes back to
# auto mode, and how long the card that then asks waits in a mode of thimble's before it denies the call (module note,
# auto mode). Claude Code reads only `retry` from a PermissionDenied hook, so a deny carries no message to the model.
CLASSIFIER_DOWN = re.compile(r"\bclassifier\b.*\bunavailable\b", re.I)
CLASSIFIER_WAITS_S = (10.0, 30.0, 90.0)
CLASSIFIER_ASK_S = 600.0
BYPASS = "bypass"
# prompts/tools.md: the stdin prompt of a session resumed in a new mode, and its sentence naming the agents that stopped
# with the pause (module note, mode switch)
MODE_PROMPT = "session-mode-changed"
MODE_STOPPED = "session-mode-stopped"
MODE_SWITCHING = "session-mode-switching"  # the deny of a request answered so the session can pause for a switch
SWITCHING = "switching"  # the answer a waiting request gets when a switch pauses the session (_release)
ELSEWHERE = "elsewhere"  # the answer of a background session's request the analyst answered in its terminal
ELSEWHERE_LINE = "Answered in the session's own terminal."
# the alert of a background session's chat whose process stopped (a crash, a kill, `claude stop`), which offers Resume
STOPPED_ALERT = {"kind": "stopped", "text": "The background session stopped. Resume starts it again with its conversation."}
# the answers that allow a request with the "don't ask again" updates Claude Code suggested for it, and a waiting one
# those updates cover (module note, don't ask again)
ALWAYS, COVERED = "always", "covered"
EDIT_MODE = "acceptEdits"  # the one mode a suggestion may switch a session to (offer)
RULES_KEY = "session_rules"  # on the session's chat meta: [{text, update}], the updates the analyst chose
# what Claude Code writes into the transcript around a signal and a resume, which the chat leaves out (bookkeeping)
INTERRUPTED = ("[Request interrupted by user]", "[Request interrupted by user for tool use]")
CUT_OFF = "The user doesn't want to proceed with this tool use."  # Claude Code's result for a call a signal cut off
SYNTHETIC = "<synthetic>"
NO_RESPONSE = "No response requested."
CACHE_DIR = ".cache"  # in the work folder: XDG_CACHE_HOME and MPLCONFIGDIR of a fenced session (module note, the fence)
# The prompts the shared skill's command prints (plugin/skills/shared), rendered for a fenced session into this folder
# of its work folder and named by RENDERED_ENV for plugin/bin/thimble, which prints them from there (module note, the
# fence)
SKILL_PROMPTS = ("preamble", "shared")
RENDERED_DIR = ".thimble-prompts"
RENDERED_ENV = "THIMBLE_RENDERED_PROMPTS"
# Claude Code loads an added directory's CLAUDE.md only with this set: the corpus's own, for a fenced session whose
# process runs in its work folder (module note, the fence)
MEMORY_ENV = "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"
# the files under a folder that Claude Code loads as memory (claudeMdExcludes takes absolute paths and globs)
MEMORY_FILES = ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/rules/**")
ALERT_DIALOG = "This session is waiting on a dialog it cannot show. Stop it, or run it again."
# A session that exited because the API is at capacity is started again (module note, retry): the classes of
# retry.transient_class that mean so, the schedule and its knobs, and the alert's words for each class.
CAPACITY = ("overloaded", "rate_limited")
RETRY_BASE_S = 30.0
RETRY_MAX_S = 300.0
RETRY_BUDGET_S = 1800.0
RETRY_JITTER = 0.2
RETRY_BASE_ENV = "THIMBLE_SESSION_RETRY_BASE_S"
RETRY_BUDGET_ENV = "THIMBLE_SESSION_RETRY_BUDGET_S"
RETRY_PROMPT = "session-retry"  # prompts/tools.md: the stdin prompt of a session started again after the wait
RETRY_REASONS = {"overloaded": "Anthropic's API is overloaded", "rate_limited": "Anthropic's API rate limit was reached"}
FAILURE_CHARS = 400  # of a failure's text in the one line that says why (failure_line)
# A session never ends while its own background work runs: the tools that schedule a later turn are taken away, since a
# --print session exits before that turn comes, --print waits for background agents and workflows however long they run
# (BG_WAIT_ENV), and a session that still exits with some running is resumed with UNFINISHED_PROMPT, at most
# UNFINISHED_RESUMES times in a run.
LATER_TOOLS = ("ScheduleWakeup", "CronCreate", "CronDelete", "CronList")
# The web tools, which ask in a session in manual mode whatever else allows them (module note, the web), the process
# modes they ask in, and the workspace's file of the web rules the analyst kept, {"allow": [rule, ...]}.
WEB_TOOLS = ("WebFetch", "WebSearch")
WEB_ASK_MODES = ("default", "acceptEdits")
WEB_RULES_FILE = "web_rules.json"
WORKSPACE = "workspace"  # the `destination` of a "don't ask again" update kept for the workspace, never sent to Claude Code
WEB_ALSO_MAX = 20  # the later requests that join a waiting web request, each listed on its card (`also`)
ALSO_CHARS = 300  # of a joining request's address or search; a longer one is a request of its own
TIMED_OUT = "timed out"  # the answer of a request nobody answered in time
BG_WAIT_ENV = "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"
BG_WAIT_MS = "0"  # no ceiling
# Claude Code aborts an MCP call that sends neither a result nor progress for this long (30 min by default). The shim
# reports progress every minute (plugin/bin/thimble-mcp), and this longer limit covers a Claude Code that ignores it.
IDLE_TIMEOUT_ENV = "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"
IDLE_TIMEOUT_MS = "14400000"  # 4 h
UNFINISHED_PROMPT = "session-unfinished"  # prompts/tools.md
UNFINISHED_RESUMES = 3
# The `toolDenialKind` of the transcript's tool result when auto mode's classifier gave no verdict too many times in a
# row and Claude Code ended the turn (CLI 2.1.282), which ends a --print session (module note, auto mode unavailable).
AUTO_OFF_KIND = "automode-unavailable"
AUTO_RESUMES = 3  # resumes in Auto in a row, after which the session waits for the analyst to switch its mode
AUTO_HOLD_S = 900.0  # how long it waits for them before it is resumed in Auto again
AUTO_OFF_REASON = "Auto mode's safety check gave no verdict"
RESUMED_PROMPT = "session-resumed"  # prompts/tools.md: the stdin prompt of a session resumed after it ended early
AUTO_OFF_ALERT = ("Auto mode's safety check gave no verdict, so Claude Code ended this session {times}. Switch it to "
                  "Manual or Bypass to carry on with its work kept, or retry Auto, which thimble also does in "
                  f"{round(AUTO_HOLD_S / 60)} minutes.")
# The model a session runs on again, once, when a safety classifier stopped its model's response and the session made
# no call after it (module note, safeguards).
FALLBACK_MODEL = config.FALLBACK_MODEL
FALLBACK_PROMPT = "session-model-fallback"  # prompts/tools.md
FALLBACK_NOTE = "Downgrading {model} to {fallback}"
MODEL_NOTE = "Claude Code switched {who} from {first} to {model}."  # _note_models
SESSION_NOTE = "this session"
STEP_TITLE_NOTE = "the agent “{title}”"
SERVER_STOPPED = "session-server-stopped"  # prompts/tools.md: the summary of a run the server's stop ended (restart)
# prompts/tools.md: the stdin prompt of a session resumed after the server restarted, and what follows SERVER_STOPPED in
# the summary of one that could not resume (module note, restart)
RESTARTED_PROMPT = "session-restarted"
NOT_RESUMED = "session-not-resumed"
RESTARTED_NOTE = "Resumed after thimble's server restarted"  # the line in the resumed session's thread and in main
GONE_TRANSCRIPT = "Claude Code no longer keeps its transcript"
UNHEARD_FILE = "unheard.json"  # in the workspace: the ends main has not heard yet (module note, restart)
UNHEARD_POLL_S = 2.0
ORPHAN_WAIT_S = 3.0  # after SIGTERM to a process a previous server left, before SIGKILL
LAUNCHED_AGENT_RE = re.compile(r"\bagentId:\s*(\w+)")  # in a background Agent call's result
LAUNCHED_TASK_RE = re.compile(r"\bTask ID:\s*(\S+)")  # in a Workflow call's result
RESUMED_AGENT_RE = re.compile(r'"resumedAgentId"\s*:\s*"(\w+)"')  # in a SendMessage's result that continued an agent
TASK_ID_RE = re.compile(r"<task-id>\s*(.*?)\s*</task-id>", re.S)  # a notification may name several tasks
MOVED_TASK_RE = re.compile(r"\bmoved to the background as task (\w+)")  # a long call Claude Code let run on
STOP_TOOL = "TaskStop"
STOPPED_TASK_RE = re.compile(r'"task_id"\s*:\s*"([^"]+)"')  # in a TaskStop's result, which no notification follows


def _now() -> str:
    return session._now()


@dataclass
class Run:
    """One session and the state of its follower."""

    c: str
    key: str  # its THIMBLE_SESSION: `orient`, `writer:<doc>`, `critique:orient` or `check:<id>:<doc>`
    chat: str
    sid: str
    cwd: Path
    role: str
    proc: asyncio.subprocess.Process | None = None
    pid: int | None = None
    prompt: str = ""  # the first message, written on stdin
    lv: session.Live | None = None  # a container for the mirror's Subs; never registered as main
    main: session.Sub | None = None  # the session's own transcript, copied into its chat
    steps: dict[str, session.Sub] = field(default_factory=dict)  # by agent id
    runs: dict[str, int] = field(default_factory=dict)  # workflow run dir -> bytes of its journal read
    result: str | None = None  # the text of the last `result` line on stdout
    result_error: bool = False
    stderr: str = ""
    stopping: bool = False
    task: asyncio.Task | None = None
    waits: dict[str, asyncio.Future] = field(default_factory=dict)  # permission request id -> the analyst's answer
    alerted: bool = False
    on_end: Callable[["Run", str, str], None] | None = None  # (run, status, summary), once its chat has ended
    calls: str | None = None  # the orientation chat whose sequence numbers its calls (module note, calls)
    k: int = 0  # the run's number in its chat: 0 for the session's start, then one per resume
    lead: str = ""  # a resume's stdin prompt, whose copy in the transcript the follower leaves out (module note, resume)
    kept: int = -1  # the transcript offset last kept on the chat's meta
    # (the analyst's excluded commands, their Bash ask rules) of an `unasked` session whose Bash runs in the sandbox,
    # for ask
    sandbox_rule: tuple[list[str], list[str]] | None = None
    mode: str | None = None  # the mode it runs in, one of modes.MODES (module note, permissions)
    patient: bool = False  # a request waits until the analyst answers, else `wait_s` (module note, permissions)
    wait_s: float | None = None  # None for PERMISSION_WAIT_S
    on_expired: Callable[["Run", dict[str, Any]], None] | None = None  # told of each request denied unanswered
    groups: dict[str, str] = field(default_factory=dict)  # web rule -> the id of the request waiting for it (module note, the web)
    asking: dict[str, tuple[str | None, str]] = field(default_factory=dict)  # request id -> (agent that asked, tool)
    # the analyst's answers to calls auto mode refused, by (agent, tool, input): (allowed, time.monotonic() when), which
    # the call made again meets before it runs (module note, auto mode)
    grants: dict[tuple[str | None, str, str], tuple[bool, float]] = field(default_factory=dict)
    # the allows among them by (agent, tool), each by its key in `grants`, which that agent's next call of the tool uses
    # up whatever its input (module note, auto mode)
    passes: dict[tuple[str | None, str], list[tuple[str | None, str, str]]] = field(default_factory=dict)
    # the calls sent back to auto mode after its classifier gave no verdict, by (agent, tool, input): (times, when)
    rechecks: dict[tuple[str | None, str, str], tuple[int, float]] = field(default_factory=dict)
    # the "don't ask again" updates the card offers for each waiting request, by its id, and those the analyst chose,
    # which each process of the run starts with (module note, don't ask again)
    offers: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    rules: list[dict[str, Any]] = field(default_factory=list)
    # a switch into or out of Auto (module note, mode switch): the mode it goes to, whether the process was paused for
    # it, and the calls each transcript has open, by its path: [bytes read, the partial line, {tool_use_id: tool}]
    switching: str | None = None
    releasing: bool = False  # the requests that waited were answered for the switch; new ones are, at once
    paused: bool = False
    paused_steps: list = field(default_factory=list)  # the steps that were running when it paused, which stop with it
    open_calls: dict[str, list] = field(default_factory=dict)
    # what starting the process again takes (module note, retry): its argv, environment and folder
    argv: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    folder: Path | None = None
    api_status: int | None = None  # the `api_error_status` of the last `result` line, when it gave one
    spawned: float = 0.0  # time.monotonic() when the process started
    retries: int = 0  # the retries of the current streak of capacity failures
    wake: asyncio.Event = field(default_factory=asyncio.Event)  # set by Retry now and Stop to end a retry's wait
    nudge: str = ""  # a retry's stdin prompt, whose copy in the transcript the follower leaves out
    on_pid: Callable[["Run"], None] | None = None  # told when the process changes: None during a retry's wait, then the new one
    # the session's background agents and workflows that were launched and have not reported, by task id, and the
    # agents whose steps ended stopped when a process exited under them (module note, background work)
    background: set[str] = field(default_factory=set)
    halted: set[str] = field(default_factory=set)
    resumes: int = 0  # the resumes of this run for background work its process left running
    # the text of the refusal that ended the process's turn because auto mode's classifier gave no verdict, the resumes
    # in Auto since the analyst last acted, and whether the run waits for them (module note, auto mode unavailable)
    auto_off: str = ""
    auto_resumes: int = 0
    held: bool = False
    # the model whose response a safety classifier stopped in this process, while no call has followed, and whether
    # the run has gone to FALLBACK_MODEL already (module note, safeguards)
    refused: str = ""
    fell_back: bool = False
    before_fallback: str = ""  # the result of the process the fallback replaced, when it wrote one
    interrupted: str = ""  # why the server's stop ended it, its summary as a failed run's (module note, restart)
    suspended: bool = False  # the server's stop left it for the next server to resume (module note, restart)
    # by transcript path: [bytes read, the partial line, the models its replies came from, in order] (_note_models)
    models: dict[str, list] = field(default_factory=dict)
    bg: bool = False  # a Claude Code background session (module note, background sessions)
    # request id -> the call it asks about (channel.call_key), which its result in the transcript answers
    ask_keys: dict[str, tuple[str, str]] = field(default_factory=dict)


_runs: dict[tuple[str, str], Run] = {}  # by (workspace, key): the sessions that run
_hosted: dict[tuple[str, str], Run] = {}  # by (workspace, key): the hosted sessions (module note, hosted sessions)
_switched: dict[tuple[str, str], str] = {}  # by (workspace, chat): the mode a card switched the chat's session to
# by (workspace, key): the start arguments of a background session's last run, for a turn it starts on its own
# (bg_session.on_wake, revive)
_launches: dict[tuple[str, str], dict[str, Any]] = {}
# by the kind of a background session's key: its caller's rebuild of those arguments from its chat's meta, for a
# session this server did not start (on_relaunch)
_relaunchers: dict[str, Callable[[str, dict[str, Any]], dict[str, Any]]] = {}


def on_relaunch(kind: str, fn: Callable[[str, dict[str, Any]], dict[str, Any]]) -> None:
    """Have `fn(c, meta)` rebuild the start arguments of a background session of `kind` whose chat's meta is `meta`,
    for a turn it starts after a server restart and for its Resume."""
    _relaunchers[kind] = fn


def _launch_kw(c: str, key: str, meta: dict[str, Any]) -> dict[str, Any] | None:
    kw = _launches.get((c, key))
    fn = _relaunchers.get(bg_session.kind_of(key)) if kw is None else None
    return fn(c, meta) if fn is not None else kw


def current(c: str, key: str | None) -> Run | None:
    run = _runs.get((c, key or ""))
    return run if run is not None and (run.task is None or not run.task.done()) else None


def running(c: str, key: str | None) -> bool:
    return current(c, key) is not None


def by_chat(c: str, chat: str) -> Run | None:
    """The running session whose agent chat is `chat`."""
    return next((r for (cc, _), r in list(_runs.items()) if cc == c and r.chat == chat
                 and (r.task is None or not r.task.done())), None)


# --------------------------------------------------------------------------- start


def settings_json(effort: str, env: dict[str, str] | None = None, **extra: Any) -> str:
    """The session's --settings: the caller's choices, and the effort as CLAUDE_CODE_EFFORT_LEVEL, which a flag
    setting's env gives over one in the folder's local settings (module note), beside the caller's own `env`."""
    return json.dumps({**extra, "env": {**(env or {}), cc_settings.EFFORT_ENV: effort}})


def role_agent(agent: dict[str, Any], conf: dict[str, Any]) -> dict[str, Any]:
    """An agent definition with the model and effort of its role in the settings popover (config.models_for) in place
    of its file's, where the role names them."""
    out = dict(agent)
    for key in ("model", "effort"):
        if conf.get(key):
            out[key] = conf[key]
    return out


def shared_prompt(cwd: Path) -> str:
    """shared.md rendered for the corpus folder, as main's append and the shared skill render it."""
    from . import channel  # noqa: PLC0415 — channel imports the views module, which this module does not otherwise need

    return channel.render_prompts(SHARED_PROMPTS, str(cwd))


def own_rules() -> list[str]:
    """The --allowedTools of every session thimble starts (module note, permissions): every tool of the plugin's thimble
    server, by the server's rule main's launcher passes too (cli.MCP_TOOLS_RULE), and each of the plugin's own skills by
    its exact name, for the plugin copy the session loads (cli.skill_rules)."""
    from . import cli  # noqa: PLC0415 — cli is large, and the rules are the launcher's

    return [cli.MCP_TOOLS_RULE, *cli.skill_rules(PLUGIN_DIR)]


def web_asks(process_mode: str) -> list[str]:
    """The `permissions.ask` rules of a session whose process runs in Claude Code's `process_mode`: WEB_TOOLS in manual
    mode, none in auto mode, whose classifier judges them, or in bypassPermissions (module note, the web)."""
    return list(WEB_TOOLS) if process_mode in WEB_ASK_MODES else []


def with_web_asks(settings: dict[str, Any], process_mode: str) -> dict[str, Any]:
    """`settings` with its `permissions.ask` holding web_asks(process_mode) and no other web tool."""
    perms = dict(settings.get("permissions") or {})
    asks = [a for a in perms.get("ask") or [] if a not in WEB_TOOLS] + web_asks(process_mode)
    if asks:
        perms["ask"] = asks
    else:
        perms.pop("ask", None)
    return {**settings, "permissions": perms} if perms or "permissions" in settings else settings


def thimble_tool(name: str) -> str:
    """A thimble tool's name as a session sees it, from the plugin's server."""
    return f"mcp__plugin_{orientation.PLUGIN}_{tools.SERVER_NAME}__{name}"


def not_own(own: "list[str] | tuple[str, ...]") -> list[str]:
    """The thimble tools of the registry not in `own`, as the session sees them: its --disallowedTools, which leave a
    session with its own thimble tools beside Claude Code's."""
    return [thimble_tool(n) for n in tools.REGISTRY if n not in own]


def command(agent_args: list[str], sid: str, effort: str, settings: str, cwd: Path,
            append_shared: bool = True, model: str = "", *, resume: bool = False, permission_mode: str = "",
            disallowed: "list[str] | tuple[str, ...]" = (), add_dirs: "list[Path] | tuple[Path, ...]" = ()) -> list[str]:
    """The session's argv. `permission_mode` is its Claude Code mode (modes.flag). `append_shared` False leaves shared.md
    out. `model` '' passes no --model. `resume` continues the session `sid`;
    `disallowed` are tools the session does not get, beside LATER_TOOLS. `add_dirs` are working directories beside the
    process's folder. `cwd` is the corpus folder, whatever folder the process runs in."""
    append = ["--append-system-prompt", shared_prompt(cwd)] if append_shared else []
    pick = ["--model", model] if model else []
    mode = ["--permission-mode", permission_mode] if permission_mode else []
    deny = ["--disallowedTools", *dict.fromkeys([*disallowed, *LATER_TOOLS])]
    # --add-dir takes every word up to the next flag, so the flag after it is --agents or --resume
    added = [a for d in add_dirs for a in ("--add-dir", str(d))]
    return [CLAUDE_BIN, "-p", "--plugin-dir", str(PLUGIN_DIR), *added, *agent_args, "--resume" if resume else "--session-id", sid,
            "--output-format", "stream-json", "--verbose", *pick, "--effort", effort, "--settings", settings,
            *append, *mode, "--allowedTools", *own_rules(), *deny]


def environ(key: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    """The session's environment: the server's, less the Claude Code session identity it may carry (config.passes),
    with main's CLAUDE_CONFIG_DIR (config.claude_env), THIMBLE_SESSION, no ceiling on --print's background wait
    (BG_WAIT_ENV), a 4 h idle limit on a thimble call (IDLE_TIMEOUT_ENV), and `extra` on top."""
    env = config.claude_env(config.passed_environ())
    env.pop("THIMBLE_CHANNEL", None)  # the session hears no browser events; main does
    env[SESSION_ENV] = key
    env[BG_WAIT_ENV] = BG_WAIT_MS
    env[IDLE_TIMEOUT_ENV] = IDLE_TIMEOUT_MS
    env.update(extra or {})
    return env


def _venv() -> Path:
    """The folder of the interpreter this server runs in (the backend's venv), whose bin goes first on a fenced
    session's PATH so Bash finds the same Python and libraries the cards use."""
    return Path(sys.prefix)


def memory_excludes(corpus: Path, work: Path, home: Path | None = None) -> list[str]:
    """claudeMdExcludes for a session whose process runs in `work`: the memory files of the work folder and of each folder
    above it up to the first that is also above the corpus folder. The walk stops below the home folder, whose
    `.claude/CLAUDE.md` is the analyst's own memory."""
    home = home if home is not None else Path.home()
    stop = {corpus, *corpus.parents, home, *home.parents}
    out: list[str] = []
    for folder in (work, *work.parents):
        if folder in stop:
            break
        out.extend(f"{folder}/{name}" for name in MEMORY_FILES)
    return out


def fence(corpus: Path, work: Path, sandbox: bool | None = None, unasked: bool = False) -> dict[str, Any]:
    """The --settings keys that keep the corpus folder read-only to a session whose process runs in its work folder `work`:
    the permissions and memory excludes always, and the sandbox with no network where it can run (`sandbox` None asks
    cc_settings.sandbox_ok). `unasked` adds the allows of the session's work in its own folder: edits in the work folder
    and Bash in the sandbox."""
    perms: dict[str, Any] = {"additionalDirectories": [str(corpus)], "deny": [f"Edit(/{corpus}/**)"]}
    if unasked:
        perms["allow"] = [f"Edit(/{work}/**)"]
    out: dict[str, Any] = {"permissions": perms, "claudeMdExcludes": memory_excludes(corpus, work)}
    if sandbox if sandbox is not None else cc_settings.sandbox_ok():
        out["sandbox"] = cc_settings.offline_sandbox(auto_allow=unasked)
    return out


def fence_env(work: Path) -> dict[str, str]:
    """A fenced session's environment on top of environ's: the venv's bin first on PATH, the caches in the work
    folder, since the home folder is not writable in the sandbox, and MEMORY_ENV, so the corpus's CLAUDE.md is read."""
    cache = work / CACHE_DIR
    with contextlib.suppress(OSError):
        cache.mkdir(parents=True, exist_ok=True)
    path = os.environ.get("PATH", "")
    return {"PATH": os.pathsep.join([str(_venv() / "bin"), *[p for p in path.split(os.pathsep) if p]]),
            "XDG_CACHE_HOME": str(cache), "MPLCONFIGDIR": str(cache / "matplotlib"), MEMORY_ENV: "1"}


def skill_prompts_env(corpus: Path, work: Path) -> dict[str, str]:
    """RENDERED_ENV for a fenced session: each of SKILL_PROMPTS rendered for the corpus folder `corpus` into
    `<work>/RENDERED_DIR/<name>.md`, the text `thimble prompt <name>` prints, which plugin/bin/thimble prints from there
    in that session (module note, the fence)."""
    from . import channel  # noqa: PLC0415 — as in shared_prompt

    folder = work / RENDERED_DIR
    folder.mkdir(parents=True, exist_ok=True)
    for name in SKILL_PROMPTS:
        (folder / f"{name}.md").write_text(channel.render_prompts([name], str(corpus)) + "\n", encoding="utf-8")
    return {RENDERED_ENV: str(folder)}


def sandbox_rule(cwd: Path) -> tuple[list[str], list[str]]:
    """What sandbox_allow leaves to the analyst's mode for a session in `cwd`: the commands their settings run outside
    the sandbox, and the contents of their Bash ask rules."""
    return cc_settings.sandbox_excluded(cwd), cc_settings.bash_ask_rules(cwd)


def sandbox_hooks(rule: tuple[list[str], list[str]]) -> dict[str, Any]:
    """The `hooks` that allow a fenced session's Bash calls where they run in the sandbox (module note, the fence):
    sandbox_allow.py before every Bash call and on every Bash permission request, told `rule` (sandbox_rule)."""
    names, asks = rule
    flags = "".join(f" --exclude {shlex.quote(n)}" for n in names) + "".join(f" --ask {shlex.quote(a)}" for a in asks)
    command = f"{shlex.quote(sys.executable)} -S {shlex.quote(str(SANDBOX_HOOK))}{flags}"
    entry = [{"matcher": "Bash", "hooks": [{"type": "command", "command": command, "timeout": SANDBOX_HOOK_TIMEOUT_S}]}]
    return {event: entry for event in sandbox_allow.EVENTS}


def scratch_hooks(work: Path) -> dict[str, Any]:
    """The `hooks` that give each subagent of a fenced session a scratch folder of its own in the work folder
    (scratch_hook.py, module note, the fence), with `## session-scratch` of prompts/tools.md as the line naming it."""
    text = tools.hint(SCRATCH_PROMPT, folder="{folder}")
    command = (f"{shlex.quote(sys.executable)} -S {shlex.quote(str(SCRATCH_HOOK))} --work {shlex.quote(str(work))} "
               f"--text {shlex.quote(text)}")
    return {"SubagentStart": [{"matcher": "*", "hooks": [{"type": "command", "command": command,
                                                          "timeout": SANDBOX_HOOK_TIMEOUT_S}]}]}


def permission_hooks(c: str, auto: bool = False, session: str = "", home: str = "") -> dict[str, Any]:
    """The `hooks` that hand every permission request of a session, its subagents and its workflow agents to ask, and every
    call auto mode refused: permission_hook.py, run without site-packages, with a day to wait for the analyst. `auto` adds
    it before each call, where the server answers whether the analyst allowed that call after a refusal. `session` and
    `home` name the session and thimble's home (where server.json is) on the hook's command line, for a session whose
    environment does not."""
    command = f"{shlex.quote(sys.executable)} -S {shlex.quote(str(PERMISSION_HOOK))} --ws {shlex.quote(c)}"
    command += f" --session {shlex.quote(session)}" if session else ""
    command += f" --home {shlex.quote(home)}" if home else ""

    def entry(timeout: int) -> list[dict[str, Any]]:
        return [{"matcher": "*", "hooks": [{"type": "command", "command": command, "timeout": timeout}]}]

    out = {REQUEST: entry(permission_hook.TIMEOUT), DENIED: entry(permission_hook.TIMEOUT)}
    if auto:
        out[PRE] = entry(permission_hook.PRE_TIMEOUT)
    return out


def call_hooks(c: str) -> dict[str, Any]:
    """The `hooks` that tell a session's model the ref of each call it made (module note, calls): call_ref.py after
    every call, failed ones included, run by this server's interpreter without site-packages."""
    command = f"{shlex.quote(sys.executable)} -S {shlex.quote(str(CALL_REF_HOOK))} --ws {shlex.quote(c)}"
    hook = [{"matcher": "*", "hooks": [{"type": "command", "command": command, "timeout": CALL_REF_TIMEOUT_S}]}]
    return {event: hook for event in CALL_REF_EVENTS}


async def start(c: str, key: str, *, role: str, title: str, agent_args: list[str], effort: str, settings: str,
                prompt: str, agent_type: str, on_start: Callable[[Run], None] | None = None,
                on_end: Callable[[Run, str, str], None] | None = None, append_shared: bool = True,
                parent: str = agents.MAIN_ID, model: str = "", work: Path | None = None, calls: bool | str = False,
                agent: str, disallowed: "list[str] | tuple[str, ...]" = (), patient: bool = False,
                unasked: bool = False, call: str | None = None,
                resume: str | None = None, chat: str | None = None, run_k: int = 0,
                leads: "list[dict[str, Any]] | None" = None, announce: bool = True,
                on_pid: Callable[[Run], None] | None = None, restarted: bool = False, background: bool = False,
                **fields: Any) -> Run:
    """Start the session `key` for workspace `c` with its first message and follow it into an agent chat of `role` under
    `parent`; RuntimeError when it runs already or claude cannot be started. `on_start`/`on_end` hear the run's start and
    end; `agent` (its row of modes.AGENTS) and `patient` govern permissions; `work` and `unasked` fence it; `calls` numbers its
    calls; `resume`, `chat`, `run_k` and `leads` continue an earlier session; `restarted` marks a resume after a server
    restart; `call` is main's tool call that started it; `announce` False writes no row into the parent chat; `on_pid` hears
    each process change; `background` runs it as a Claude Code background session (module note); `fields` land on the
    chat's meta."""
    if running(c, key):
        raise RuntimeError(f"the session {key} is running")
    if resume and chat and (agents.meta_or_none(c, chat) or {}).get("background"):
        background = True  # a chat that ran as a background session keeps its session
    cwd = config.corpus_dir(c)
    folder = work if work is not None else cwd  # where the process runs (module note, the fence)
    sid = resume or str(uuid.uuid4())
    switched = _switched.get((c, chat or "")) if resume else None
    mode = switched if switched and switched not in modes.disabled() else modes.mode_for(c, agent)
    permission_mode = modes.flag(mode)
    extra_env: dict[str, str] = {}
    given = json.loads(settings)
    hooks: dict[str, Any] = {}
    rule: tuple[list[str], list[str]] | None = None
    if work is not None:
        work.mkdir(parents=True, exist_ok=True)
        fenced = fence(cwd, work, unasked=unasked)
        perms = given.get("permissions") if isinstance(given.get("permissions"), dict) else {}
        given = {**given, **fenced, "permissions": {**perms, **fenced["permissions"]}}
        extra_env.update(fence_env(work))
        extra_env.update(skill_prompts_env(cwd, work))
        hooks.update(scratch_hooks(work))
        if "sandbox" in fenced and unasked:
            rule = sandbox_rule(cwd)
            hooks.update(sandbox_hooks(rule))
    given = with_web_asks(given, permission_mode)
    for event, entries in permission_hooks(c, permission_mode == "auto").items():
        # the permission hook alone answers a request, since ask applies the sandbox rule itself; before a call
        # both hooks run
        hooks[event] = [*hooks.get(event, []), *entries] if event == PRE else entries
    if calls:
        hooks.update(call_hooks(c))
    if hooks:
        given = {**given, "hooks": {**(given.get("hooks") or {}), **hooks}}
    settings = json.dumps(given)
    argv = command(agent_args, sid, effort, settings, cwd, append_shared, model, resume=bool(resume),
                   permission_mode=permission_mode, disallowed=disallowed, add_dirs=[cwd] if work is not None else [])
    rules = kept_rules(c, chat) if resume else []  # module note, don't ask again
    argv = with_rules(argv, rules)
    env = environ(key, extra_env)
    if background:
        _launches[(c, key)] = {"role": role, "title": title, "agent_args": agent_args, "effort": effort,
                               "settings": settings, "agent_type": agent_type, "on_end": on_end, "append_shared": append_shared,
                               "parent": parent, "model": model, "work": work, "calls": calls, "agent": agent,
                               "disallowed": disallowed, "patient": patient, "unasked": unasked, "on_pid": on_pid,
                               "background": True, **fields}
        old = bg_session.entry(c, key)
        if old is not None and bg_session.alive(old) and old.sid != (resume or ""):
            await asyncio.to_thread(bg_session.replace, c, key)  # a new session of the key replaces the old one
        try:
            proc = await bg_session.start(c, key, argv, folder, env, prompt, resume, chat or "", role)
        finally:
            if old is not None and old.replacing and bg_session.entry(c, key) is old:
                old.replacing = False  # no new session took its place
        sid = proc.session_id
    else:
        proc = await _exec(argv, folder, env)
    # `server`: this server's pid, the process's parent while this server follows it (_followed_elsewhere); and the
    # workspace's folder, which a copy of the workspace does not share (module note, restart)
    extra: dict[str, Any] = {"server": os.getpid(), "workspace_dir": str(config.workspace_dir(c).resolve()),
                             **({"model": model} if model else {})}
    if background:
        extra.update(background=True, bg=proc.short, bg_name=bg_session.name_of(key))
    extra.update(permission_mode=mode, mode_switch=None)  # what the card's switcher shows
    if resume and chat and agents.meta_or_none(c, chat) is not None:
        extra["restarted"] = {"run": run_k, "ts": _now()} if restarted else None
        meta = _reopen(c, chat, parent, run_k, pid=proc.pid, effort=effort, leads=leads or [], call=call,
                       announce=announce and not restarted, **({"session": sid} if background else {}), **extra, **fields)
    else:
        meta = agents.new_agent(c, role, title, parent=parent, by=agents.TERMINAL, announce=announce, call=call,
                                session=sid, pid=proc.pid, agent_type=agent_type, effort=effort, **extra, **fields)
    run = Run(c, key, str(meta["id"]), sid, cwd, role, proc=proc, pid=proc.pid, prompt=prompt, on_end=on_end, k=run_k,
              argv=argv, env=env, folder=folder, spawned=time.monotonic(), on_pid=on_pid, bg=background)
    if background:
        proc.busy = lambda: bool(run.background)
        e = bg_session.entry(c, key)
        if e is not None and e.chat != run.chat:
            e.chat = run.chat
            bg_session._save(c)
    run.calls = (run.chat if calls is True else str(calls)) if calls else None
    run.sandbox_rule, run.mode, run.patient = rule, mode, patient
    run.rules = rules
    run.lv = session.Live(c, sid, str(cwd), None, proc.pid)
    run.main = session.Sub(c, run.chat, None, None, role=role)
    if run.calls:
        run.main.calls = calls_store.Numbering(c, run.calls, at=run.chat)
    if resume:
        run.lead = prompt.strip()
        _take_up(run, meta)
    if restarted:
        with contextlib.suppress(Exception):
            run.main.rec.record("chip", kind=session.CHIP_KIND, text=RESTARTED_NOTE, by=agents.TERMINAL)
            agents.chip(c, "thread", RESTARTED_NOTE, chat=run.chat)
    forget_calls(run)
    _runs[(c, key)] = run
    if on_start is not None:
        on_start(run)
    log.info("%s: session %s (%s) %s (pid %s, %s)", c, key, sid, f"resumed as run {run_k}" if resume else "started",
             proc.pid, " ".join(a for a in argv if len(a) < 200))
    run.task = asyncio.get_running_loop().create_task(_follow(run), name=f"session:{c}:{key}:{sid}")
    return run


async def _exec(argv: list[str], folder: Path, env: dict[str, str]) -> asyncio.subprocess.Process:
    """The session's process, in its own process group so Stop reaches its agents; RuntimeError when it cannot start."""
    try:
        return await asyncio.create_subprocess_exec(*argv, cwd=str(folder), env=env, stdin=asyncio.subprocess.PIPE,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                    start_new_session=True, limit=16 * 1024 * 1024)
    except OSError as e:
        raise RuntimeError(f"could not start `{CLAUDE_BIN}`: {e}") from e


def _reopen(c: str, chat: str, parent: str, run_k: int, *, leads: list[dict[str, Any]], call: str | None = None,
            announce: bool = True, **fields: Any) -> dict[str, Any]:
    """A resumed session's chat, running again as run `run_k`: main gets an `agent` record naming the run, and the chat a
    `user` record for each message the run was sent. With `announce` False main gets no new row."""
    meta = agents.update_agent(c, chat, status="running", result=None, ts_end=None, run=run_k, **fields)
    _, log_path = agents.paths(c, chat)
    for lead in leads:
        text = str(lead.get("text") or "").strip()
        if text:
            agents.append(log_path, {"type": "user", "ts": _now(), "text": text, "by": str(lead.get("by") or agents.TERMINAL),
                                     "run": run_k})
    if parent and run_k > 0 and announce:
        _, parent_log = agents.paths(c, parent)
        agents.append(parent_log, {"type": "agent", "ts": _now(), "chat": chat, "role": meta.get("role"),
                                   "title": meta.get("title"), "run": run_k, "by": agents.TERMINAL,
                                   **({"tool_use_id": call} if call else {})})
        agents._notify(c, parent)
    agents._notify(c, chat)
    return meta


def _take_up(run: Run, meta: dict[str, Any]) -> None:
    """A resumed run's follower starts where the chat's last run left off: its own transcript from the offset the meta keeps
    (the file's end when it keeps none), and the steps of earlier runs taken up at their files' ends."""
    assert run.main is not None and run.lv is not None
    found = session.find_transcript(run.sid)
    if found:
        run.main.path = Path(found)
        run.lv.transcript_path = found
        kept = (meta.get("follow") or {}).get("offset") if isinstance(meta.get("follow"), dict) else None
        size = session._size(run.main.path)
        run.main.offset = int(kept) if isinstance(kept, int) and 0 <= kept <= size else size
        run.kept = run.main.offset
        run.models[str(run.main.path)] = [run.main.offset, b"", []]
    for step in agents.list_chats(run.c):
        if step.get("parent") != run.chat or step.get("role") != STEP_ROLE or not step.get("agent_id"):
            continue
        agent_id = str(step["agent_id"])
        path = _step_path(run, step)
        sub = session.Sub(run.c, str(step["id"]), step.get("tool_use_id"), agent_id, role=STEP_ROLE)
        sub.path, sub.done = path, True
        sub.offset = session._size(path) if path is not None else 0
        if path is not None:
            run.models[str(path)] = [sub.offset, b"", []]
        if run.calls:
            sub.calls = calls_store.Numbering(run.c, run.calls, agent_id, at=sub.chat)
        run.steps[agent_id] = sub
        run.lv.subs.append(sub)
        if step.get("workflow_dir"):
            journal = Path(str(step["workflow_dir"])) / "journal.jsonl"
            run.runs[str(step["workflow_dir"])] = session._size(journal)


def _step_path(run: Run, step: dict[str, Any]) -> Path | None:
    """The transcript of an earlier run's step: a workflow agent's in its run directory, a subagent's beside the
    session's transcript."""
    agent_id = str(step.get("agent_id") or "")
    if step.get("workflow_dir"):
        return Path(str(step["workflow_dir"])) / f"agent-{agent_id}.jsonl"
    if run.main is not None and run.main.path is not None:
        return run.main.path.parent / run.sid / "subagents" / f"agent-{agent_id}.jsonl"
    return None


# --------------------------------------------------------------------------- follow


async def _feed(run: Run) -> None:
    """The first message, on stdin, which is then closed so the --print session starts its turn."""
    assert run.proc is not None and run.proc.stdin is not None
    with contextlib.suppress(BrokenPipeError, ConnectionResetError):
        run.proc.stdin.write(run.prompt.encode("utf-8"))
        await run.proc.stdin.drain()
    with contextlib.suppress(Exception):
        run.proc.stdin.close()


async def _read_stdout(run: Run) -> None:
    """The stream-json lines: the last `result` is the summary."""
    assert run.proc is not None and run.proc.stdout is not None
    async for raw in run.proc.stdout:
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("type") == "result":
            run.result = str(rec.get("result") or "").strip() or run.result
            run.result_error = bool(rec.get("is_error"))
            status = rec.get("api_error_status")
            run.api_status = status if isinstance(status, int) else None


async def _read_stderr(run: Run) -> None:
    assert run.proc is not None and run.proc.stderr is not None
    async for raw in run.proc.stderr:
        run.stderr = (run.stderr + raw.decode("utf-8", "replace"))[-STDERR_TAIL * 4:]


async def _follow(run: Run) -> None:
    """Follow the session until it ends, starting it again after a mode-switch pause, after auto mode ended its turn, on the
    fallback model after a refusal, after each capacity exit while the schedule allows, and after a clean exit that left
    background work running."""
    try:
        while True:
            await _watch(run)
            if not (await _switch_mode(run) or await _resume_auto(run) or await _fall_back(run) or await _retry(run)
                    or await _resume_unfinished(run)):
                break
        _end(run)
    except asyncio.CancelledError:
        _kill(run)
        raise


async def _watch(run: Run) -> None:
    """One process of the session, from its start to its exit: stdin fed, stdout and stderr read, and transcripts copied into
    the chats until the last pass after it exited. A switch into or out of Auto pauses it when quiet. A permission request
    still waiting is answered as gone."""
    bg = isinstance(run.proc, bg_session.BgProc)
    readers = [] if bg else [asyncio.ensure_future(_feed(run)), asyncio.ensure_future(_read_stdout(run)),
                             asyncio.ensure_future(_read_stderr(run))]
    try:
        while run.proc is not None and run.proc.returncode is None:
            try:
                follow_once(run)
            except Exception:  # noqa: BLE001 — the follower never takes the session down
                log.exception("%s: the mirror of session %s failed a pass", run.c, run.key)
            if run.switching and not run.paused and not run.stopping and _quiet_now(run):
                if run.waits:
                    _release(run)  # the pause comes once the calls that waited have their results
                else:
                    run.paused = True
                    # read before the signal: the rejection Claude Code writes for a cut-off Agent call ends its step
                    run.paused_steps = _running_steps(run)
                    log.info("%s: session %s (%s) pauses to switch to %s", run.c, run.key, run.sid, run.switching)
                    await _halt(run)
                    _not_run_cut_off(run)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(run.proc.wait()), POLL_S)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.gather(*readers, return_exceptions=True), 5.0)
        if bg and isinstance(run.proc, bg_session.BgProc):
            run.result = run.proc.result or run.result
            run.result_error, run.api_status = run.proc.result_error, run.proc.api_status
        try:
            follow_once(run)
        except Exception:  # noqa: BLE001
            log.exception("%s: the last mirror pass of session %s failed", run.c, run.key)
    finally:
        for r in readers:
            r.cancel()
        for fut in run.waits.values():
            if not fut.done():
                fut.set_result(None)


# --------------------------------------------------------------------------- retry


def retry_waits(base_s: float = RETRY_BASE_S, max_s: float = RETRY_MAX_S, budget_s: float = RETRY_BUDGET_S) -> list[float]:
    """The waits before each retry of a streak, without jitter (module note, retry): doubling from `base_s`, each at
    most `max_s`, for as long as their sum stays within `budget_s`; empty when `base_s` or `budget_s` is 0."""
    out: list[float] = []
    if base_s <= 0 or budget_s <= 0:
        return out
    wait = base_s
    while sum(out) + min(wait, max_s) <= budget_s:
        out.append(min(wait, max_s))
        wait *= 2
    return out


def retry_knobs(environ_: "dict[str, str] | None" = None) -> list[float]:
    """retry_waits with RETRY_BASE_ENV and RETRY_BUDGET_ENV where they are set, read when a retry is due; a value
    that is not a number is the default, with a log line."""
    src = os.environ if environ_ is None else environ_
    knob = {RETRY_BASE_ENV: RETRY_BASE_S, RETRY_BUDGET_ENV: RETRY_BUDGET_S}
    for name in knob:
        raw = str(src.get(name, "") or "").strip()
        if raw:
            try:
                knob[name] = max(0.0, float(raw))
            except ValueError:
                log.warning("%s=%r is not a number; using %g", name, raw, knob[name])
    return retry_waits(knob[RETRY_BASE_ENV], RETRY_MAX_S, knob[RETRY_BUDGET_ENV])


def capacity(run: Run) -> str | None:
    """The class of CAPACITY that made the session's process fail, or None: a process that ended well, was stopped or
    failed for another reason. The `result` line decides when it reported an error; else stderr."""
    code = run.proc.returncode if run.proc is not None else None
    if run.stopping or (code == 0 and run.result and not run.result_error):
        return None
    if run.result_error:
        cls = retry.transient_class(run.api_status, run.result)
    else:
        cls = retry.transient_class(None, run.stderr[-STDERR_TAIL:])
    return cls if cls in CAPACITY else None


def wait_text(seconds: float) -> str:
    """A wait in the alert's words: `45 s` under two minutes, else whole minutes."""
    s = max(0, round(seconds))
    return f"{s} s" if s < 120 else f"{round(s / 60)} min"


def failure_line(summary: str | None) -> str:
    """A failed run's summary as the one line that says why: its words on one line, cut at FAILURE_CHARS."""
    text = " ".join(str(summary or "").split())
    return text if len(text) <= FAILURE_CHARS else text[: FAILURE_CHARS - 1].rstrip() + "…"


def _set_pid(run: Run, pid: int | None) -> None:
    """The run's process changed (module note, retry): its chat's meta and the caller's `on_pid` hear the new pid, or
    None while a retry waits, so nothing takes the run for ended or signals a pid that may have been reused."""
    run.pid = pid
    if run.lv is not None:
        run.lv.pid = pid
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, pid=pid, server=os.getpid())
    if run.on_pid is not None:
        try:
            run.on_pid(run)
        except Exception:  # noqa: BLE001 — a caller's record never stops the retry
            log.exception("%s: session %s: the caller did not record its new process", run.c, run.key)


async def _retry(run: Run) -> bool:
    """After the process exited: when it failed at capacity and the schedule has a wait left, wait with the alert on
    the chat (Retry now and Stop end the wait) and start the process again; True when a new process runs."""
    cls = capacity(run)
    if cls is None:
        return False
    if time.monotonic() - run.spawned > RETRY_MAX_S:
        run.retries = 0  # it worked a while before this failure: a new streak
    waits = retry_knobs()
    if run.retries >= len(waits):
        log.warning("%s: session %s (%s) failed at capacity (%s) after %d retries; it ends failed", run.c, run.key,
                    run.sid, cls, run.retries)
        return False
    wait = waits[run.retries] * (1 + random.uniform(-RETRY_JITTER, RETRY_JITTER))
    run.retries += 1
    for sub in run.steps.values():
        _finish_step(run, sub, "failed")  # its agents ended with the process
    reason = RETRY_REASONS[cls]
    until = datetime.now(timezone.utc) + timedelta(seconds=wait)
    alert = {"kind": "retry", "text": f"{reason}; retrying in {wait_text(wait)}.", "reason": reason,
             "until": until.isoformat(timespec="seconds"), "since": _now(), "attempt": run.retries}
    _set_pid(run, None)
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, alert=alert, permissions=[])
    log.info("%s: session %s (%s) failed at capacity (%s: %s); retry %d/%d in %.0f s", run.c, run.key, run.sid, cls,
             failure_line(run.result or run.stderr)[:200], run.retries, len(waits), wait)
    run.wake.clear()
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(run.wake.wait(), wait)
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, alert=None)
    run.alerted = False
    if run.stopping:
        return False
    try:
        await _respawn(run)
    except RuntimeError as e:
        run.result, run.result_error = str(e), True
        log.warning("%s: session %s could not be started again (%s)", run.c, run.key, e)
        return False
    return True


async def _resume_unfinished(run: Run) -> bool:
    """After the process exited: when it ended well but left background agents or workflows running, which stopped with
    it, the steps still open end stopped and the session is resumed with `## session-unfinished`, so it continues or
    restarts them and uses their results (module note, background work); True when a new process runs."""
    code = run.proc.returncode if run.proc is not None else None
    if run.stopping or code != 0 or not run.result or run.result_error or not run.background:
        return False
    if run.resumes >= UNFINISHED_RESUMES:
        log.warning("%s: session %s (%s) exited with background work running (%s) after %d resumes; it ends", run.c,
                    run.key, run.sid, ", ".join(sorted(run.background)), run.resumes)
        return False
    run.resumes += 1
    left = sorted(run.background)
    run.background.clear()  # the resumed session names again what it continues or starts again
    for sub in run.steps.values():
        if not sub.done:
            _finish_step(run, sub, "stopped")  # its agent stopped with the process
            if sub.agent_id:
                run.halted.add(sub.agent_id)
    log.info("%s: session %s (%s) exited with background work running (%s: %s); resume %d/%d", run.c, run.key, run.sid,
             ", ".join(left), failure_line(run.stderr)[:200], run.resumes, UNFINISHED_RESUMES)
    try:
        await _respawn(run, UNFINISHED_PROMPT)
    except RuntimeError as e:
        run.result, run.result_error = str(e), True
        log.warning("%s: session %s could not be resumed (%s)", run.c, run.key, e)
        return False
    return True


def _stop_steps(run: Run) -> list[dict[str, Any]]:
    """The steps still open end stopped, since their agents stopped with the process, and are kept as halted, so one
    the resumed session continues ends done when it reports; returns their chats' metas, for stopped_text."""
    metas: list[dict[str, Any]] = []
    for sub in run.steps.values():
        if sub.done:
            continue
        metas.append(agents.meta_or_none(run.c, sub.chat) or {"agent_id": sub.agent_id})
        _finish_step(run, sub, "stopped")
        if sub.agent_id:
            run.halted.add(sub.agent_id)
    run.background.clear()  # the resumed session names again what it continues or starts again
    return metas


async def _resume_auto(run: Run) -> bool:
    """After the process exited: when Claude Code ended its turn because auto mode's classifier gave no verdict, resume the
    session in Auto with `## session-resumed`, up to AUTO_RESUMES times in a row; after that wait for the analyst (_hold) or
    fail. True when a new process runs."""
    cause = run.auto_off
    if not cause or run.stopping:
        return False
    run.auto_off = ""
    stopped = _stop_steps(run)
    if run.auto_resumes >= AUTO_RESUMES:
        if run.mode is None:
            run.result, run.result_error = cause, True
            return False
        if not await _hold(run):
            return False
        run.auto_resumes = 0
    else:
        run.auto_resumes += 1
    log.info("%s: session %s (%s) ended by auto mode (%s); resumed in %s (%d in a row)", run.c, run.key, run.sid,
             failure_line(cause)[:200], run.mode, run.auto_resumes)
    text = stopped_text(stopped)
    try:
        await _respawn(run, RESUMED_PROMPT, stopped=f"{text} " if text else "")
    except RuntimeError as e:
        run.result, run.result_error = str(e), True
        log.warning("%s: session %s could not be resumed (%s)", run.c, run.key, e)
        return False
    return True


async def _hold(run: Run) -> bool:
    """Wait, with no process, for the analyst after auto mode ended the session AUTO_RESUMES times in a row: the alert
    on its chat says why and when it retries Auto; a switch of its mode on the card (set_mode), the alert's retry or
    AUTO_HOLD_S passing ends the wait (True), and Stop ends the run (False)."""
    run.held = True
    _set_pid(run, None)
    times = f"{AUTO_RESUMES + 1} times in a row"
    until = datetime.now(timezone.utc) + timedelta(seconds=AUTO_HOLD_S)
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, permissions=[], alert={
            "kind": "retry", "text": AUTO_OFF_ALERT.format(times=times), "reason": AUTO_OFF_REASON,
            "until": until.isoformat(timespec="seconds"), "since": _now(), "cause": AUTO_OFF_KIND})
    log.info("%s: session %s (%s) waits for the analyst after auto mode ended it %s", run.c, run.key, run.sid, times)
    run.wake.clear()
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(run.wake.wait(), AUTO_HOLD_S)
    run.held = False
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, alert=None)
    run.alerted = False
    return not run.stopping


def _set_model(run: Run, model: str) -> None:
    """The process's --model in `run.argv`, in place, for the next time it starts."""
    if "--model" in run.argv:
        run.argv[run.argv.index("--model") + 1] = model
    else:
        at = run.argv.index("--effort") if "--effort" in run.argv else len(run.argv)
        run.argv[at:at] = ["--model", model]


async def _fall_back(run: Run) -> bool:
    """After the process exited: when a safety classifier stopped its model's response and the session made no call after it,
    run the session again, once, on FALLBACK_MODEL with `--resume` and `## session-model-fallback`, and say so in its thread
    and main. True when a new process runs."""
    refused = run.refused
    if not refused or run.stopping or run.fell_back or not FALLBACK_MODEL or refused.startswith(FALLBACK_MODEL) or run.bg:
        return False
    run.refused, run.fell_back = "", True
    run.before_fallback = "" if run.result_error else (run.result or "").strip()
    stopped = _stop_steps(run)
    _set_model(run, FALLBACK_MODEL)
    if run.main is not None and run.main.path is not None:  # this switch is thimble's, which FALLBACK_NOTE tells
        run.models.setdefault(str(run.main.path), [session._size(run.main.path), b"", []])[2].append(FALLBACK_MODEL)
    names = {"model": session.model_label(refused), "fallback": session.model_label(FALLBACK_MODEL)}
    note = FALLBACK_NOTE.format(**names)
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, model=FALLBACK_MODEL)
        if run.main is not None:
            run.main.rec.record("chip", kind=session.CHIP_KIND, text=note, by=agents.TERMINAL)
        agents.chip(run.c, session.CHIP_KIND, note, chat=run.chat)
    log.info("%s: session %s (%s): a safety classifier stopped %s and nothing ran after it; it runs again on %s", run.c,
             run.key, run.sid, refused, FALLBACK_MODEL)
    text = stopped_text(stopped)
    try:
        await _respawn(run, FALLBACK_PROMPT, stopped=f"{text} " if text else "", **names)
    except RuntimeError as e:
        run.result, run.result_error = str(e), True
        log.warning("%s: session %s could not be started again on %s (%s)", run.c, run.key, FALLBACK_MODEL, e)
        return False
    return True


def with_earlier(run: Run, summary: str) -> str:
    """`summary` after the result of the process the fallback replaced, when that process wrote one the summary does
    not already hold (module note, safeguards)."""
    before, summary = run.before_fallback.strip(), (summary or "").strip()
    if not before or before in summary:
        return summary
    return f"{before}\n\n{summary}" if summary else before


async def _respawn(run: Run, hint: str = RETRY_PROMPT, **values: Any) -> None:
    """Start the session's process again: `--resume` with the prompt `hint` of prompts/tools.md on stdin, its slots filled from
    `values`, when its transcript exists, else as it first started. Calls the old process left open are forgotten."""
    argv = list(run.argv)
    prompt = run.prompt
    if session.find_transcript(run.sid) and "--session-id" in argv:
        argv[argv.index("--session-id")] = "--resume"
    if "--resume" in argv:
        prompt = run.nudge = tools.hint(hint, **values)
    assert run.folder is not None
    if run.bg:
        proc = await bg_session.start(run.c, run.key, argv, run.folder, run.env, prompt, run.sid, run.chat, run.role)
        proc.busy = lambda: bool(run.background)
        if proc.session_id != run.sid:  # a copy under a new id
            run.sid = proc.session_id
            with contextlib.suppress(Exception):
                agents.update_agent(run.c, run.chat, session=run.sid, bg=proc.short)
    else:
        proc = await _exec(argv, run.folder, run.env)
    run.argv, run.proc, run.prompt = argv, proc, prompt
    run.result, run.result_error, run.api_status, run.stderr = None, False, None, ""
    run.auto_off = run.refused = ""  # what ended the last process is its own
    run.spawned = time.monotonic()
    forget_calls(run)
    _set_pid(run, proc.pid)
    log.info("%s: session %s (%s) started again (pid %s, retry %d)", run.c, run.key, run.sid, proc.pid, run.retries)


async def retry_now(c: str, chat: str) -> bool:
    """End the retry wait of the session whose chat is `chat` (the alert's Retry now); False when none waits."""
    run = by_chat(c, chat)
    if run is None or run.pid is not None or run.stopping:
        return False
    run.wake.set()
    return True


ACTIVE_POLL_S = 5.0  # how often wait_active counts a session's active time


async def wait_active(run: Run, done: asyncio.Future, limit_s: float, poll_s: float | None = None) -> bool:
    """Wait for `done` while the session has run for at most `limit_s` seconds of active time (process alive and no permission
    request waiting). True once `done` is set; False once past the limit, which the caller then stops."""
    poll = ACTIVE_POLL_S if poll_s is None else poll_s
    active, last = 0.0, time.monotonic()
    while not done.done():
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(done), poll)
        now = time.monotonic()
        if run.pid is not None and not run.waits:
            active += now - last
        last = now
        if not done.done() and active > limit_s:
            log.warning("%s: session %s (%s) ran past %.0f s of active time", run.c, run.key, run.sid, limit_s)
            return False
    return True


def follow_once(run: Run) -> None:
    """Copy what the session's transcript, its subagents' and its workflows' gained into the chats; watch its state."""
    assert run.main is not None and run.lv is not None
    if run.main.path is None:
        found = session.find_transcript(run.sid)
        if found:
            run.main.path = Path(found)
            run.lv.transcript_path = found
    if run.main.path is not None:
        _tail_main(run)
        _scan_subagents(run)
    for run_dir in list(run.runs):
        _scan_workflow(run, Path(run_dir))
    for sub in run.steps.values():
        if sub.path is not None:
            session._tail_sub(run.lv, sub)
    _keep_offset(run)
    _watch_wait(run)
    _note_models(run)


def _note_models(run: Run) -> None:
    """The first time the replies of the session or of one of its steps come from a model other than those it used before,
    the session's thread gets a line saying so (MODEL_NOTE), and a step's chat names the model."""
    if run.main is None:
        return
    for sub in [run.main, *run.steps.values()]:
        if sub.path is None:
            continue
        state = run.models.setdefault(str(sub.path), [0, b"", []])  # a resume's are set where it takes up (_take_up)
        size = session._size(sub.path)
        if size <= state[0]:
            continue
        with contextlib.suppress(OSError), sub.path.open("rb") as f:
            f.seek(state[0])
            data = f.read(size - state[0])
            state[0] = size
            lines = (state[1] + data).split(b"\n")
            state[1] = lines.pop()
            for line in lines:
                if b'"assistant"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                msg = rec.get("message") if isinstance(rec, dict) and rec.get("type") == "assistant" else None
                model = msg.get("model") if isinstance(msg, dict) else None
                if not isinstance(model, str) or not model or model.startswith("<") or model in state[2]:
                    continue
                state[2].append(model)
                if len(state[2]) == 1:
                    continue
                title = (agents.meta_or_none(run.c, sub.chat) or {}).get("title") or STEP_TITLE
                who = SESSION_NOTE if sub is run.main else STEP_TITLE_NOTE.format(title=title)
                run.main.rec.record("chip", kind=session.CHIP_KIND, by=agents.TERMINAL, text=MODEL_NOTE.format(
                    who=who, first=session.model_label(state[2][0]), model=session.model_label(model)))
                if sub is not run.main:
                    with contextlib.suppress(Exception):
                        agents.update_agent(run.c, sub.chat, model=model)


def _keep_offset(run: Run) -> None:
    """The transcript offset of the lines copied whole, kept on the chat's meta when it moved, so a resume after a
    restart starts there (module note, resume). Written without a stream record: the lines copied made their own."""
    sub = run.main
    if sub is None or sub.path is None:
        return
    done = sub.offset - len(sub.buf)
    if done == run.kept:
        return
    try:
        meta = agents.read_meta(run.c, run.chat)
        meta["follow"] = {"offset": done, "session": run.sid}
        agents.write_meta(run.c, meta)
        run.kept = done
    except Exception:  # noqa: BLE001 — a chat deleted under the follower
        log.debug("%s: the offset of session %s was not kept", run.c, run.key, exc_info=True)


def _tail_main(run: Run) -> None:
    """The session's own transcript: each line into its chat, and the Agent and Workflow calls and their results read
    for the steps."""
    sub = run.main
    assert sub is not None and sub.path is not None and run.lv is not None
    size = session._size(sub.path)
    if size <= sub.offset:
        return
    with sub.path.open("rb") as f:
        f.seek(sub.offset)
        data = f.read(size - sub.offset)
    sub.offset = size
    lines = (sub.buf + data).split(b"\n")
    sub.buf = lines.pop()
    for line in lines:
        if not line.strip():
            continue
        try:
            rec = session._load(line)
        except session.Unreadable:
            continue
        _steps_of(run, rec)
        _auto_off_of(run, rec)
        _refusal_of(run, rec)
        if rec.get("type") == "user" and (session._user_text(rec) or "").strip() in {run.lead, run.nudge} - {""}:
            continue  # a resume's prompt, whose messages are the `user` records _reopen wrote, or a retry's
        if bookkeeping(rec):
            continue
        try:
            session.translate_sub(run.lv, sub, line)
        except session.Unreadable as e:
            log.warning("%s: a transcript line of session %s was skipped (%s)", run.c, run.key, e)
    if run.bg:
        _answered_in_terminal(run, None, session._results(sub, lines))


def _answered_in_terminal(run: Run, agent_id: str | None, done: "list[tuple[tuple[str, str], float]]") -> None:
    """Calls of a background session, or of its agent `agent_id`, got their results: a permission request that still
    waits on one of them was answered in the session's own terminal, so its card's wait ends (module note, background
    sessions). A call is matched to its request by channel.call_key, else to the one request of its tool open."""
    for key, _at in done:
        mine = [rid for rid, (who, tool) in run.asking.items() if who == agent_id and tool == key[0] and rid in run.waits]
        hit = next((rid for rid in mine if run.ask_keys.get(rid) == key), mine[0] if len(mine) == 1 else None)
        fut = run.waits.get(hit) if hit else None
        if fut is not None and not fut.done():
            log.info("%s: session %s: request %s was answered in its terminal", run.c, run.key, hit)
            fut.set_result(ELSEWHERE)


def _auto_off_of(run: Run, rec: dict) -> None:
    """A line of the session's own transcript: the refusal that ended its turn because auto mode's classifier gave no verdict
    is kept as run.auto_off, cleared by a later reply. The refused call shows as not run rather than failed."""
    if rec.get("type") == "user" and rec.get("toolDenialKind") == AUTO_OFF_KIND and rec.get("toolDenialEndsTurn"):
        for b in session._content_list(rec):
            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id"):
                session.not_run(str(b["tool_use_id"]))
        said = rec.get("toolUseResult")
        if not isinstance(said, str):
            said = " ".join(session.response_text(b.get("content")) for b in session._content_list(rec)
                            if isinstance(b, dict) and b.get("type") == "tool_result")
        run.auto_off = " ".join(said.removeprefix("Error:").split()) or AUTO_OFF_KIND
    elif rec.get("type") == "assistant" and (rec.get("message") or {}).get("model") != SYNTHETIC:
        run.auto_off = ""


def _refusal_of(run: Run, rec: dict) -> None:
    """A line of the session's own transcript: a response a safety classifier stopped (`stop_reason: refusal`) keeps
    its model as run.refused, and a call the session makes after it clears it, since the session then went on (module
    note, safeguards)."""
    if rec.get("type") != "assistant":
        return
    msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
    model = str(msg.get("model") or "")
    if msg.get("stop_reason") == "refusal":
        run.refused = model if model and model != SYNTHETIC else "the session's model"
    elif model != SYNTHETIC and any(isinstance(b, dict) and b.get("type") == "tool_use"
                                    for b in msg.get("content") or []):
        run.refused = ""


def bookkeeping(rec: dict) -> bool:
    """A transcript line Claude Code writes when a signal ends a process and when the session is resumed after it,
    neither the model's words nor the analyst's, so the chat leaves it out (module note, mode switch): the interruption
    note, and the synthetic reply it adds to it on resume."""
    if rec.get("type") == "user":
        return (session._user_text(rec) or "").strip() in INTERRUPTED
    if rec.get("type") != "assistant":
        return False
    msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
    texts = [b.get("text") for b in msg.get("content") or [] if isinstance(b, dict) and b.get("type") == "text"]
    return msg.get("model") == SYNTHETIC and texts == [NO_RESPONSE]


def _steps_of(run: Run, rec: dict) -> None:
    """What a line of the session's own transcript says about its steps: an Agent result ends a foreground step, a Workflow
    result names the run directory whose agents become steps, a task notification ends a background step. Launched
    background agents and workflows, and tool calls moved to the background, are kept in run.background until a
    notification names them or TaskStop stops them. A notification comes as a prompt of its own while the session is
    idle, and as a `queued_command` attachment when it arrives during a turn."""
    if rec.get("type") == "assistant":
        for b in session._content_list(rec):
            if isinstance(b, dict) and b.get("type") == "tool_use" and isinstance(b.get("id"), str):
                run.main.names[b["id"]] = str(b.get("name") or "")  # type: ignore[union-attr]
        return
    if rec.get("type") == "attachment":
        att = rec.get("attachment") if isinstance(rec.get("attachment"), dict) else {}
        att_origin = att.get("origin") if isinstance(att.get("origin"), dict) else {}
        if att.get("type") == "queued_command" and "task-notification" in (att_origin.get("kind"), att.get("commandMode")):
            _task_notice(run, str(att.get("prompt") or ""))
        return
    if rec.get("type") != "user":
        return
    origin = rec.get("origin") if isinstance(rec.get("origin"), dict) else {}
    text = session._user_text(rec)
    if origin.get("kind") == "task-notification" and text:
        _task_notice(run, text)
        return
    for b in session._content_list(rec):
        if not isinstance(b, dict) or b.get("type") != "tool_result" or not isinstance(b.get("tool_use_id"), str):
            continue
        tid = b["tool_use_id"]
        name = run.main.names.get(tid, "")  # type: ignore[union-attr]
        content = session.response_text(b.get("content"))
        launched = None
        if name == session.WORKFLOW_TOOL:
            m = WORKFLOW_DIR_RE.search(content)
            if m and m.group(1) not in run.runs:
                run.runs[m.group(1)] = 0
            launched = LAUNCHED_TASK_RE.search(content) if m else None
        elif name == session.SEND_TOOL:
            launched = RESUMED_AGENT_RE.search(content)
        elif name in AGENT_TOOLS and ASYNC_RESULT_RE.match(content):
            launched = LAUNCHED_AGENT_RE.search(content)
        if launched and not b.get("is_error"):
            run.background.add(launched.group(1))
        moved = MOVED_TASK_RE.search(content) if not launched else None
        if moved and not b.get("is_error"):
            run.background.add(moved.group(1))
        stopped = STOPPED_TASK_RE.search(content) if name == STOP_TOOL and not b.get("is_error") else None
        if stopped:
            run.background.discard(stopped.group(1))
        if name in AGENT_TOOLS and not ASYNC_RESULT_RE.match(content):
            _scan_subagents(run)
            step = _step_by(run, tool_use_id=tid)
            if step is not None:
                _finish_step(run, step, "failed" if b.get("is_error") else "done")


def _step_by(run: Run, *, tool_use_id: str | None = None, agent_id: str | None = None) -> session.Sub | None:
    for sub in run.steps.values():
        if (tool_use_id and sub.tool_use_id == tool_use_id) or (agent_id and sub.agent_id == agent_id):
            return sub
    return None


def _new_step(run: Run, agent_id: str, title: str, path: Path, **fields: Any) -> session.Sub:
    meta = agents.new_agent(run.c, STEP_ROLE, " ".join(title.split()) or STEP_TITLE, parent=run.chat, by=agents.TERMINAL,
                            session=run.sid, agent_id=agent_id, **{k: v for k, v in fields.items() if v is not None})
    sub = session.Sub(run.c, str(meta["id"]), fields.get("tool_use_id"), agent_id, role=STEP_ROLE)
    sub.path = path
    if run.calls:
        sub.calls = calls_store.Numbering(run.c, run.calls, agent_id, at=sub.chat)
    run.steps[agent_id] = sub
    if run.bg:
        sub.on_results = lambda done, a=agent_id: _answered_in_terminal(run, a, done)
    assert run.lv is not None
    run.lv.subs.append(sub)  # so a subagent this step starts finds its caller (session._child_finished)
    return sub


def _task_notice(run: Run, text: str) -> None:
    """A task notification: the tasks it names leave run.background, and the step it names ends."""
    run.background.difference_update(TASK_ID_RE.findall(text))
    fields = dict(session.TASK_FIELD_RE.findall(text))
    step = _step_by(run, tool_use_id=fields.get("tool-use-id"), agent_id=fields.get("task-id"))
    done = str(fields.get("status") or "").strip() in session.TASK_DONE
    if step is not None and step.done and done and step.agent_id in run.halted:
        run.halted.discard(step.agent_id)  # an agent that stopped with a process was continued, and has finished
        with contextlib.suppress(Exception):
            agents.finish_agent(run.c, step.chat, "done")
    elif step is not None:
        _finish_step(run, step, "done" if done else "failed")


def _finish_step(run: Run, sub: session.Sub, status: str) -> None:
    if sub.done:
        return
    assert run.lv is not None
    session._tail_sub(run.lv, sub)
    sub.done = True
    try:
        agents.finish_agent(run.c, sub.chat, status)
    except Exception:  # noqa: BLE001 — a chat deleted under the follower
        log.debug("%s: step %s could not be finished", run.c, sub.chat, exc_info=True)


def _scan_subagents(run: Run) -> None:
    """The session's subagents: each transcript under `<sid>/subagents/` becomes a step once its meta json names it."""
    assert run.main is not None and run.main.path is not None
    d = run.main.path.parent / run.sid / "subagents"
    try:
        paths = sorted(p for p in d.iterdir() if session.AGENT_FILE_RE.match(p.name))
    except OSError:
        return
    for path in paths:
        agent_id = session.AGENT_FILE_RE.match(path.name).group(1)  # type: ignore[union-attr]
        if agent_id in run.steps:
            continue
        meta = session._read_meta_json(path)
        if not meta:
            continue  # written a moment before its meta json; the next pass adopts it
        _new_step(run, agent_id, str(meta.get("description") or meta.get("agentType") or ""), path,
                  tool_use_id=str(meta.get("toolUseId") or "") or None, agent_type=meta.get("agentType"))


def _scan_workflow(run: Run, run_dir: Path) -> None:
    """A workflow's run directory: its journal's `started` lines become steps titled `<phase>: <label>` as Claude Code
    shows them, and its `result` lines end them."""
    journal = run_dir / "journal.jsonl"
    offset = run.runs.get(str(run_dir), 0)
    size = session._size(journal)
    if size <= offset:
        return
    with journal.open("rb") as f:
        f.seek(offset)
        data = f.read(size - offset)
    end = data.rfind(b"\n") + 1
    run.runs[str(run_dir)] = offset + end
    for line in data[:end].splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        agent_id = str(rec.get("agentId") or "") if isinstance(rec, dict) else ""
        if not agent_id:
            continue
        kind = str(rec.get("type") or "")
        if kind == "started" and agent_id not in run.steps:
            label, phase = str(rec.get("label") or ""), str(rec.get("phase") or "")
            _new_step(run, agent_id, f"{phase}: {label}" if phase and label else label or phase, run_dir / f"agent-{agent_id}.jsonl",
                      label=label or None, phase=phase or None, workflow_dir=str(run_dir))
        elif kind == "result" and agent_id in run.steps:
            _finish_step(run, run.steps[agent_id], "done")
        elif kind in ("error", "failed") and agent_id in run.steps:
            _finish_step(run, run.steps[agent_id], "failed")


def _watch_wait(run: Run) -> None:
    """A dialog that holds the session (the model-switch dialog after a safety stop, when the analyst's settings ask
    each time) gets the alert on the session's chat while it lasts."""
    state = session._read_state(session._sessions_dir() / f"{run.pid}.json") if run.pid else {}
    waiting = state.get("status") == "waiting" and str(state.get("waitingFor") or session.DIALOG_WAIT) == session.DIALOG_WAIT
    if waiting != run.alerted:
        run.alerted = waiting
        agents.update_agent(run.c, run.chat, alert={"kind": "dialog", "text": ALERT_DIALOG, "since": _now()} if waiting else None)


# --------------------------------------------------------------------------- end and stop


def _end(run: Run) -> None:
    """The session exited: the steps still open end with it, then its chat, then the caller's on_end hears the status
    and the summary."""
    if _runs.get((run.c, run.key)) is not run:
        return  # ended already (the server's shutdown and the follower can both get here)
    if run.suspended:
        _suspend(run)
        return
    if run.switching and not run.stopping:
        _mode_is(run, run.switching)  # it ended before a pause: its follow-ups run in the new mode
    code = run.proc.returncode if run.proc is not None else None
    if run.interrupted:
        status = "failed"  # the server's stop ended it, not the analyst, so a start resumes it (module note, restart)
    elif run.stopping:
        status = "stopped"
    else:
        status = "done" if code == 0 and run.result and not run.result_error else "failed"
    for sub in run.steps.values():
        _finish_step(run, sub, "stopped" if run.interrupted else "done" if status == "done" else status)
    if run.interrupted:
        summary = run.interrupted
    elif status == "done" or status == "stopped":
        summary = run.result or ""  # a stopped session's partial summary, if it wrote one; its status says the rest
    else:
        summary = run.result or run.stderr.strip()[-STDERR_TAIL:] or f"exit {code}"
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, alert=None, permissions=[])
    _runs.pop((run.c, run.key), None)
    agents.finish_agent(run.c, run.chat, status, (summary or "")[: session.RESULT_LIMIT] or None)
    log.info("%s: session %s (%s) ended %s (exit %s)", run.c, run.key, run.sid, status, code)
    if run.bg:
        bg_session.run_ended(run.c, run.key, summary)
        if code in (-1, -2) and not run.interrupted:
            with contextlib.suppress(Exception):
                agents.update_agent(run.c, run.chat, alert={**STOPPED_ALERT, "since": _now()})
    if run.on_end is not None:
        try:
            run.on_end(run, status, summary)
        except Exception:  # noqa: BLE001
            log.exception("%s: the end of session %s was not recorded", run.c, run.key)


def _suspend(run: Run) -> None:
    """The server's stop ended the process of a session its caller resumes (module note, restart): its chat stays
    running with no process and its steps as they were, for the next server to resume, and its caller hears nothing. A
    switch of its mode that waited applies to the resumed process."""
    if run.switching:
        _mode_is(run, run.switching)
    _runs.pop((run.c, run.key), None)
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, pid=None, alert=None, permissions=[])
    log.info("%s: session %s (%s) left for the next server to resume", run.c, run.key, run.sid)


def _signal(run: Run, sig: int) -> None:
    if run.pid is None or run.bg:
        return  # a background session outlives the follower; Stop uses `claude stop`
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(run.pid, sig)


def _kill(run: Run) -> None:
    _signal(run, signal.SIGKILL)


async def stop_run(run: Run) -> bool:
    """Stop a session: SIGINT to its process group, then SIGTERM, then SIGKILL, each after STOP_WAIT_S, then SIGKILL to
    whatever is left of the processes it started (module note, end); the follower ends the run as stopped, and a run
    the follower has not ended by then is ended here, so the chat never stays running after Stop."""
    if run.proc is None:
        return False
    run.stopping = True
    run.wake.set()  # a retry's wait ends with no new process
    await _halt(run)
    if run.task is not None:
        with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(run.task), STOP_WAIT_S * 2)
    if _runs.get((run.c, run.key)) is run:
        log.warning("%s: session %s (%s) was not ended by its follower after Stop; ending it as stopped", run.c,
                    run.key, run.sid)
        if run.task is not None and not run.task.done():
            run.task.cancel()
        _end(run)
    return True


async def _halt(run: Run) -> None:
    """End the session's process (module note, end): SIGINT to its process group, then SIGTERM, then SIGKILL, each after
    STOP_WAIT_S, then SIGKILL to whatever is left of the processes it started. Stop and a pause for a switch (module
    note, mode switch) both end it this way."""
    if run.proc is None:
        return
    if isinstance(run.proc, bg_session.BgProc):
        await run.proc.stop()
        return
    # read before any signal: a process whose parent has died is re-parented and no longer found under the session
    tree = await asyncio.to_thread(procs.descendants, run.pid) if run.pid is not None else []
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
        _signal(run, sig)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(run.proc.wait()), STOP_WAIT_S)
        if run.proc.returncode is not None:
            break
    for pid in tree:
        if procs.alive(pid):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)


async def stop(c: str, key: str) -> bool:
    """Stop the session `key`; False when none runs."""
    run = current(c, key)
    return await stop_run(run) if run is not None else False


async def stop_chat(c: str, chat: str) -> bool:
    """Stop the session whose chat is `chat` (the browser's Stop, through agents.interrupt_route); a chat that says it
    runs with no session of this server behind it is closed as stopped (module note, restart). False when neither."""
    run = by_chat(c, chat)
    if run is not None:
        return await stop_run(run)
    meta = agents.meta_or_none(c, chat)
    if meta is None or not _left_running(c, meta):
        return False
    await asyncio.to_thread(_kill_left, meta)
    _close_left(c, meta, "stopped", "")
    return True


async def resume_chat(c: str, chat: str) -> Run:
    """The Resume of a background session's chat whose process stopped: its session starts again under its id with
    its conversation, as the chat's next run. RuntimeError when the chat is no such chat or runs."""
    from . import orient_session, write_session  # noqa: PLC0415 — both import this module

    meta = agents.meta_or_none(c, chat)
    if meta is None or not meta.get("background"):
        raise RuntimeError("this chat is no background session of thimble's")
    if by_chat(c, chat) is not None:
        raise RuntimeError("it runs")
    agents.update_agent(c, chat, alert=None)
    role, k = str(meta.get("role") or ""), int(meta.get("run") or 0)
    carry_on = tools.hint(RESUMED_PROMPT, stopped="")
    if role == orientation.ROLE:
        return await orient_session.resume(c, [{"text": tools.hint("bg-carry-on"), "by": agents.BROWSER}])
    if role == write_session.ROLE:
        doc = str(meta.get("doc") or "")
        return await _start_writer(c, doc, meta, carry_on, k + 1)
    key = next((e.key for e in bg_session.entries(c) if e.chat == chat), None)
    kw = _launch_kw(c, key, meta) if key else None
    if key is None or kw is None:
        raise RuntimeError("thimble no longer knows how to start this session")
    return await start(c, key, **kw, prompt=carry_on, resume=str(meta.get("session") or ""), chat=chat, run_k=k + 1)


async def _start_writer(c: str, doc: str, meta: dict[str, Any], prompt: str, run_k: int) -> Run:
    from . import write_session  # noqa: PLC0415

    return await start(c, write_session.session_key(doc), prompt=prompt, resume=str(meta.get("session") or ""),
                       chat=str(meta["id"]), run_k=run_k, **write_session._launch(c, doc))


async def revive(c: str, e: "bg_session.Entry") -> Run | None:
    """Follow again a background session that runs with no run of this server's (bg_session.on_wake): as its chat's run
    that was left running, when a server restart cut its follower off (its caller's resumer, with no prompt, attaches to
    the session), else as its chat's next run, a turn the session started on its own. None when its chat is gone."""
    meta = agents.meta_or_none(c, e.chat)
    if meta is None:
        return None
    k = int(meta.get("run") or 0)
    if meta.get("status") == "running":
        fn = _resumers.get(str(meta.get("role") or ""))
        if fn is not None:
            return await fn(c, meta, "")
        kw = _launch_kw(c, e.key, meta)
        if kw is None:
            return None
        return await start(c, e.key, **kw, prompt="", resume=e.sid, chat=e.chat, run_k=k, restarted=True)
    kw = _launch_kw(c, e.key, meta)
    if kw is None:
        fn = _resumers.get(str(meta.get("role") or ""))
        if fn is None:
            return None
        return await fn(c, {**meta, "run": k + 1}, "")
    return await start(c, e.key, **kw, prompt="", resume=e.sid, chat=e.chat, run_k=k + 1, announce=False)


# --------------------------------------------------------------------------- what a previous server left (restart)

# the callers' ends of a run a previous server left running, by its chat's role: told (c, the chat's meta, status,
# summary) as a run's on_end is told its status and summary (on_left)
_left_ends: dict[str, Callable[[str, dict[str, Any], str, str], None]] = {}
# by workspace folder: the ends main has not heard, [{kind, payload}], kept on disk too (UNHEARD_FILE)
_unheard: dict[str, list[dict[str, Any]]] = {}


def on_left(role: str, fn: Callable[[str, dict[str, Any], str, str], None]) -> None:
    """Have `fn(c, meta, status, summary)` told when a run of a chat of `role` that a previous server left running is
    closed, at this server's start or by Stop, in place of the on_end its start passed (module note, restart)."""
    _left_ends[role] = fn


# the callers that resume a run a previous server left running, by its chat's role (on_resume)
_resumers: dict[str, Callable[[str, dict[str, Any], str], Awaitable[Run]]] = {}


class NotResumed(RuntimeError):
    """A caller cannot resume the run a previous server left running; its text says why (module note, restart)."""


def on_resume(role: str, fn: Callable[[str, dict[str, Any], str], Awaitable[Run]]) -> None:
    """Have `fn(c, meta, prompt)` resume a run of a chat of `role` that a previous server left running: start its
    session again with `resume` and `chat` as the same run, `restarted` and `prompt` on stdin, and return the run, or
    raise NotResumed saying why it cannot (module note, restart)."""
    _resumers[role] = fn


def resumable(run: Run) -> bool:
    """Whether the next server resumes `run` when this one stops: its caller resumes its role and it has a session."""
    return run.role in _resumers and bool(run.sid)


def _left_running(c: str, meta: dict[str, Any]) -> bool:
    """Whether an agent chat is a session thimble started (its meta keeps a `pid`, None while a retry waits) that says
    it runs, with no run of this server's behind it, and no other live server's either (_followed_elsewhere)."""
    return (meta.get("status") == "running" and "pid" in meta and bool(meta.get("session")) and not meta.get("background")
            and by_chat(c, str(meta.get("id"))) is None and not _followed_elsewhere(meta))


def _followed_elsewhere(meta: dict[str, Any]) -> bool:
    """Whether the chat's process is still the child of another, still-running server that started it, as when a copy of the
    workspace (such as the dev agent's validation stack) holds the chats of the live one. A chat without the `server` field
    counts a parent that runs uvicorn as that server."""
    pid = meta.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or not procs.alive(pid):
        return False
    parent = procs.ppid(pid)
    if not parent or parent <= 1 or parent == os.getpid() or not procs.alive(parent):
        return False
    owner = meta.get("server")
    if isinstance(owner, int) and not isinstance(owner, bool):
        return parent == owner
    return any("uvicorn" in a or "spawn_main" in a for a in procs.argv(parent))


def _kill_left(meta: dict[str, Any]) -> None:
    """End the process of a run a previous server left, when it still runs and is that session's own (its argv names the
    session id, so a reused pid is left alone): SIGTERM to its process group, SIGKILL after ORPHAN_WAIT_S, then SIGKILL
    to whatever is left of the processes it started. Blocking; run off the event loop."""
    pid, sid = meta.get("pid"), str(meta.get("session") or "")
    if not isinstance(pid, int) or pid <= 0 or not sid or not procs.alive(pid) or sid not in procs.argv(pid):
        return
    tree = procs.descendants(pid)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(pid, sig)
        deadline = time.monotonic() + ORPHAN_WAIT_S
        while procs.alive(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        if not procs.alive(pid):
            break
    for p in tree:
        if procs.alive(p):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(p, signal.SIGKILL)
    log.info("session %s (pid %s), left running by a previous server, was ended", sid, pid)


def _close_left(c: str, meta: dict[str, Any], status: str, summary: str) -> None:
    """Close a run a previous server left running, its process ended (_kill_left): the steps still open end stopped,
    its chat ends with `status` and `summary`, and the caller's end for its role hears it (on_left)."""
    chat = str(meta["id"])
    for step in agents.list_chats(c):
        if step.get("parent") == chat and step.get("status") == "running":
            with contextlib.suppress(Exception):
                agents.finish_agent(c, str(step["id"]), "stopped")
    with contextlib.suppress(Exception):
        agents.update_agent(c, chat, alert=None, permissions=[], pid=None)
    agents.finish_agent(c, chat, status, summary or None)
    log.info("%s: session chat %s (%s), left running by a previous server, ended %s", c, chat, meta.get("session"),
             status)
    fn = _left_ends.get(str(meta.get("role") or ""))
    if fn is not None:
        try:
            fn(c, meta, status, summary)
        except Exception:  # noqa: BLE001 — the chat has ended either way
            log.exception("%s: the end of session chat %s was not recorded", c, chat)


async def recover() -> tuple[list[str], list[str]]:
    """Server start: every run a previous server left running has its process ended when it still runs and is resumed by its
    caller, or closed as failed with the reason; and the ends main did not hear are told once a session listens. Returns
    (closed, resumed), `<workspace>/<chat>` per run."""
    # the callers whose ends a run left running needs register them when imported (on_left, on_resume), and the server
    # imports a writer's module only when the first write starts
    from . import orient_session, write_session  # noqa: F401, PLC0415

    closed: list[str] = []
    resumed: list[str] = []
    root = config.WORKSPACES_DIR
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        c = folder.name
        try:
            _load_unheard(c)
            metas = [m for m in agents.list_chats(c) if _left_running(c, m)]
        except Exception:  # noqa: BLE001 — a workspace whose corpus is gone, or one that cannot be read
            log.debug("%s: its sessions were not checked at start", c, exc_info=True)
            continue
        for meta in metas:
            try:
                await asyncio.to_thread(_kill_left, meta)
                why = await _resume_left(c, meta)
                if why is None:
                    resumed.append(f"{c}/{meta['id']}")
                    continue
                _close_left(c, meta, "failed", why)
                closed.append(f"{c}/{meta['id']}")
            except Exception:  # noqa: BLE001 — never fails the start
                log.exception("%s: session chat %s, left running, was not closed", c, meta.get("id"))
    return closed, resumed


def _stopped_steps(c: str, chat: str) -> list[dict[str, Any]]:
    """The subagent and workflow steps of `chat` still open, whose agents stopped with its process, ended stopped;
    returns their metas. A session under it (a critique) is a run of its own, which recover takes up by itself."""
    steps = [m for m in agents.list_chats(c) if m.get("parent") == chat and m.get("role") == STEP_ROLE
             and m.get("status") == "running" and "pid" not in m]
    for step in steps:
        with contextlib.suppress(Exception):
            agents.finish_agent(c, str(step["id"]), "stopped")
    return steps


async def _resume_left(c: str, meta: dict[str, Any]) -> str | None:
    """Resume a run a previous server left running, its process ended (_kill_left), through its caller's resumer
    (on_resume) with `## session-restarted` naming the agents that stopped; None when it runs again, else the summary
    the run is closed with (module note, restart)."""
    stopped = tools.hint(SERVER_STOPPED)
    fn = _resumers.get(str(meta.get("role") or ""))
    own = meta.get("workspace_dir")
    if fn is None or (own and own != str(config.workspace_dir(c).resolve())):
        return stopped
    sid = str(meta.get("session") or "")
    try:
        if not session.find_transcript(sid):
            raise NotResumed(GONE_TRANSCRIPT)
        steps = _stopped_steps(c, str(meta["id"]))
        text = stopped_text(steps)
        run = await fn(c, meta, tools.hint(RESTARTED_PROMPT, stopped=f"{text} " if text else ""))
    except Exception as e:  # noqa: BLE001 — a resume that cannot run leaves the run to be closed with why
        log.warning("%s: session chat %s (%s), left running by a previous server, was not resumed: %s", c,
                    meta.get("id"), sid, e)
        return f"{stopped} {tools.hint(NOT_RESUMED, why=failure_line(str(e) or type(e).__name__))}"
    run.halted.update(str(s["agent_id"]) for s in steps if s.get("agent_id"))
    log.info("%s: session chat %s (%s), left running by a previous server, resumed as run %s", c, meta.get("id"), sid,
             run.k)
    return None


def _unheard_path(c: str) -> Path:
    return config.workspace_dir(c) / UNHEARD_FILE


def _notes(c: str) -> list[dict[str, Any]]:
    """The workspace's ends main has not heard, read from disk the first time this server asks."""
    key = str(_unheard_path(c))
    if key not in _unheard:
        try:
            saved = json.loads(Path(key).read_text("utf-8")) if Path(key).is_file() else []
        except (OSError, ValueError):
            saved = []
        _unheard[key] = [n for n in saved if isinstance(n, dict) and n.get("kind")] if isinstance(saved, list) else []
    return _unheard[key]


def _load_unheard(c: str) -> None:
    _notes(c)


def _save_unheard(c: str) -> None:
    path = _unheard_path(c)
    notes = _notes(c)
    with contextlib.suppress(OSError):
        if notes:
            path.write_text(json.dumps(notes, ensure_ascii=False), "utf-8")
        else:
            path.unlink(missing_ok=True)


def tell_main(c: str, kind: str, payload: dict[str, Any]) -> bool:
    """Post the channel event that tells main a session ended, after any that waited; when no session listens (409:
    main not attached yet after a restart, or the server going down) it is kept, on disk too, and posted once one
    listens (deliver_unheard). True when it was posted now."""
    notes = _notes(c)
    notes.append({"kind": kind, "payload": payload})
    deliver_unheard(c)
    if notes and notes[-1]["payload"] is payload:
        _save_unheard(c)
        log.info("%s: no session listens; the %s event waits for one", c, kind)
        return False
    return True


def deliver_unheard(c: str) -> int:
    """Post the workspace's ends main has not heard, in order, while a session listens; returns how many were posted.
    One refused for another reason than 409 is dropped, with a log line."""
    from . import channel  # noqa: PLC0415 — channel imports the views module, which this module does not otherwise need

    notes = _notes(c)
    sent = 0
    while notes:
        note = notes[0]
        try:
            channel.post(c, str(note["kind"]), dict(note.get("payload") or {}))
            sent += 1
        except HTTPException as e:
            if e.status_code == 409:
                break
            log.info("%s: main did not hear the %s event (%s %s)", c, note.get("kind"), e.status_code, e.detail)
        notes.pop(0)
    if sent:
        _save_unheard(c)
    return sent


async def _delivering() -> None:
    """The server's task that tells main the ends it did not hear, once a session listens (module note, restart)."""
    while True:
        await asyncio.sleep(UNHEARD_POLL_S)
        for key in [k for k, notes in _unheard.items() if notes]:
            folder = Path(key).parent
            try:
                if folder.parent.resolve() == config.WORKSPACES_DIR.resolve():
                    deliver_unheard(folder.name)
            except Exception:  # noqa: BLE001 — the task goes on for the other workspaces
                log.exception("the waiting events of %s were not delivered", folder.name)


# --------------------------------------------------------------------------- permissions


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
    """The session whose requests ask answers for `key`: a followed one that runs, else a hosted one."""
    return current(c, key) or _hosted.get((c, key or ""))


def _by_chat(c: str, chat: str) -> Run | None:
    """The followed or hosted session whose chat is `chat`."""
    return by_chat(c, chat) or next((r for (cc, _), r in list(_hosted.items()) if cc == c and r.chat == chat), None)


def host(c: str, key: str, chat: str, *, agent: str, wait_s: float,
         on_expired: Callable[[Run, dict[str, Any]], None] | None = None,
         sandbox: "tuple[list[str], list[str]] | None" = None) -> Run:
    """Answer the permission hook's requests of the session `key`, which this module does not follow, on the chat `chat`
    (module note, hosted sessions): by the mode of the row `agent` (modes.AGENTS), each denied after `wait_s`
    unanswered, when `on_expired` hears of it. With `sandbox` (sandbox_rule) a Bash call that runs in the sandbox is
    allowed at once."""
    run = Run(c, key, chat, "", config.corpus_dir(c), "dev", mode=modes.mode_for(c, agent), wait_s=wait_s,
              on_expired=on_expired, sandbox_rule=sandbox)
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


def asking(c: str, key: str | None) -> bool:
    """Whether a permission request of the session `key` waits for the analyst."""
    run = asker(c, key)
    return run is not None and any(not f.done() for f in run.waits.values())


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
        data = json.loads((config.workspace_dir(c) / WEB_RULES_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return []
    rules = data.get("allow") if isinstance(data, dict) else None
    return [r for r in rules if isinstance(r, str)] if isinstance(rules, list) else []


def keep_web_rule(c: str, rule: str) -> None:
    """Keep `rule` for workspace `c`, so no session of it asks for it again."""
    rules = web_rules(c)
    if rule not in rules:
        atomic_write_text(config.workspace_dir(c) / WEB_RULES_FILE, json.dumps({"allow": [*rules, rule]}, indent=1) + "\n")


def wait_words(seconds: float) -> str:
    """A wait in words: `a minute`, `10 minutes`, or `90 seconds` for one that is no whole number of minutes."""
    if seconds < 60 or seconds % 60:
        return f"{seconds:g} seconds"
    return "a minute" if seconds == 60 else f"{seconds / 60:g} minutes"


def timed_out_line(seconds: float) -> str:
    """TIMED_OUT_LINE for a wait of `seconds`."""
    return TIMED_OUT_LINE.format(wait=wait_words(seconds))


async def ask(c: str, key: str | None, tool_name: str, inp: Any, agent_id: str | None = None,
              agent_type: str | None = None, event: str = REQUEST, reason: str = "",
              tool_use_id: str | None = None, suggestions: Any = None) -> dict[str, Any]:
    """One permission request of the session `key` or of its subagent or workflow agent `agent_id`, or with `event` DENIED a
    call auto mode refused for `reason`; the answer as Claude Code reads it. In Bypass it is allowed at once, as is a
    Bash call the sandbox rule allows and a web call the workspace's kept rules allow; during a switch pause it is denied
    at once; a call auto mode gave no verdict on goes back to it first (_recheck); a web call joins a waiting request for
    the same site or for search; otherwise it waits on the chat until the analyst answers (or the session's `wait_s`,
    unless it is patient, and CLASSIFIER_ASK_S for a call auto mode never judged). `suggestions` become the card's "don't
    ask again" choice, and a web call's is the site's rule, or web search's, for the workspace."""
    run = asker(c, key)
    if run is None:
        return {"behavior": "deny", "message": GONE_LINE}
    granted = {"behavior": "allow", "updatedInput": inp if isinstance(inp, dict) else {}}
    if run.sandbox_rule is not None and sandbox_allow.allows(tool_name, inp, *run.sandbox_rule):
        return granted
    web = web_rule(tool_name, inp)
    kept = web is not None and web in web_rules(c)
    if kept or run.mode == BYPASS:
        if event == DENIED:
            _remember(run, agent_id, tool_name, inp, True, tool_use_id)
        agents.log_permission(c, "answered", chat=run.chat, session=key, tool=tool_name, what=_what(tool_name, inp),
                              agent_id=agent_id, answer="allow: kept for the workspace" if kept else "allow: Bypass")
        return granted
    if run.releasing:
        agents.log_permission(c, "answered", chat=run.chat, session=key, tool=tool_name, what=_what(tool_name, inp),
                              agent_id=agent_id, answer="deny: answered for a mode switch")
        return {"behavior": "deny", "message": tools.hint(MODE_SWITCHING)}
    unjudged = event == DENIED and bool(CLASSIFIER_DOWN.search(reason or ""))
    if unjudged and (again := await _recheck(run, agent_id, tool_name, inp, reason, tool_use_id)) is not None:
        return again
    first = run.groups.get(web) if web else None
    also = _also_text(tool_name, inp)
    if (first is not None and first in run.waits and not run.waits[first].done() and also is not None
            and len(next((p.get("also") or [] for p in _pending(c, run.chat) if p.get("id") == first), [])) < WEB_ALSO_MAX):
        return await _join(run, first, also, tool_name, inp, agent_id, event, tool_use_id, granted)
    rid = uuid.uuid4().hex[:10]
    whole = json.dumps(inp, ensure_ascii=False, default=str) if inp is not None else ""
    command = _command(tool_name, inp)
    cut = _cut(tool_name, inp, whole)
    updates = [] if cut else web_offer(web) if web else offer(suggestions) if event == REQUEST else []
    limit = CLASSIFIER_ASK_S if unjudged and run.patient else None if run.patient else run.wait_s or PERMISSION_WAIT_S
    entry = {"id": rid, "tool": tool_name, "what": _what(tool_name, inp), "input": whole[:PERMISSION_INPUT_CHARS],
             "since": _now(), **command, **({"cut": cut} if cut else {}),
             **(_asker(run, agent_id, agent_type) if agent_id else {}),
             **({"refused": " ".join(reason.split())[:200] or "no reason given"} if event == DENIED else {}),
             **({"rechecked": len(CLASSIFIER_WAITS_S)} if unjudged else {}),
             **({"deny_after_s": limit} if unjudged and limit is not None else {}),
             **_offered(updates), **({"wait_s": limit} if limit else {}),
             **({"mode": run.mode} if run.mode else {})}
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    run.waits[rid] = fut
    run.asking[rid] = (agent_id or None, tool_name)
    if run.bg:
        from . import channel  # noqa: PLC0415 — channel imports the views module, which this module does not need

        run.ask_keys[rid] = channel.call_key(tool_name, inp)
    if web:
        run.groups[web] = rid
    if updates:
        run.offers[rid] = updates
    agents.update_agent(c, run.chat, permissions=[*_pending(c, run.chat), entry])
    agents.log_permission(c, "asked", chat=run.chat, session=key, **entry)
    chosen: list[dict[str, Any]] | None = None
    try:
        try:
            allow = await asyncio.wait_for(asyncio.shield(fut), limit)
        except asyncio.TimeoutError:
            allow = TIMED_OUT
            if not fut.done():
                fut.set_result(TIMED_OUT)
    finally:
        if not fut.done():
            fut.set_result(None)
        run.waits.pop(rid, None)
        run.asking.pop(rid, None)
        run.ask_keys.pop(rid, None)
        chosen = run.offers.pop(rid, None)
        if web and run.groups.get(web) == rid:
            run.groups.pop(web, None)
        with contextlib.suppress(Exception):
            _off_card(run, rid, fut.result() == TIMED_OUT)
    message = _deny_message(run, allow, limit)
    if allow == TIMED_OUT and run.on_expired is not None:
        with contextlib.suppress(Exception):
            run.on_expired(run, entry)
    if allow == ALWAYS and chosen:
        told = _add_rules(run, chosen)
        agents.log_permission(c, "answered", id=rid, chat=run.chat,
                              answer=f"allow, don't ask again: {offer_text(chosen)}")
        return {**granted, "updatedPermissions": told} if told else granted
    agents.log_permission(c, "answered", id=rid, chat=run.chat, answer=_answer_word(allow))
    if event == DENIED and isinstance(allow, bool):
        _remember(run, agent_id, tool_name, inp, allow, tool_use_id)
    return granted if allow in (True, ALWAYS, COVERED) else {"behavior": "deny", "message": message}


async def _recheck(run: Run, agent_id: str | None, tool_name: str, inp: Any, reason: str,
                   tool_use_id: str | None) -> dict[str, Any] | None:
    """A call auto mode refused because its classifier gave no verdict, sent back to auto mode: after the next of
    CLASSIFIER_WAITS_S for this call, a `retry` with nothing remembered, so before_call leaves the call made again to auto
    mode's classifier and the refused call shows as not run. None once this call's waits are spent, when the analyst is
    asked. A switch of mode or the session's end during the wait answers it as it answers a request on the card."""
    k = grant_key(agent_id, tool_name, inp)
    now = time.monotonic()
    for old in [x for x, (_, when) in run.rechecks.items() if now - when > GRANT_TTL_S]:
        run.rechecks.pop(old, None)
    n = run.rechecks.get(k, (0, now))[0]
    if n >= len(CLASSIFIER_WAITS_S):
        run.rechecks.pop(k, None)
        return None
    run.rechecks[k] = (n + 1, now)
    what = _what(tool_name, inp)
    agents.log_permission(run.c, "rechecked", chat=run.chat, session=run.key, tool=tool_name, what=what,
                          agent_id=agent_id, refused=" ".join(reason.split())[:200], attempt=n + 1,
                          wait_s=CLASSIFIER_WAITS_S[n])
    rid = uuid.uuid4().hex[:10]
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    run.waits[rid] = fut
    run.asking[rid] = (agent_id or None, tool_name)
    try:
        got = await asyncio.wait_for(fut, CLASSIFIER_WAITS_S[n])
    except asyncio.TimeoutError:
        got = "again"
    finally:
        run.waits.pop(rid, None)
        run.asking.pop(rid, None)
    if got in ("again", ELSEWHERE):  # ELSEWHERE: another call of this tool got its result (_answered_in_terminal)
        if tool_use_id:
            session.not_run(tool_use_id)
        return {"behavior": "allow"}
    if got is True:  # a switch to Bypass allowed what waited
        _remember(run, agent_id, tool_name, inp, True, tool_use_id)
        return {"behavior": "allow", "updatedInput": inp if isinstance(inp, dict) else {}}
    return {"behavior": "deny", "message": tools.hint(MODE_SWITCHING) if got == SWITCHING else GONE_LINE}


def _also_text(tool_name: str, inp: Any) -> str | None:
    """A web call's address, or its search, whole, as the card lists a call that joins a waiting request; None for one
    past ALSO_CHARS."""
    text = (inp if isinstance(inp, dict) else {}).get("url" if tool_name == "WebFetch" else "query")
    return text if isinstance(text, str) and text.strip() and len(text) <= ALSO_CHARS else None


async def _join(run: Run, first: str, what: str, tool_name: str, inp: Any, agent_id: str | None, event: str,
                tool_use_id: str | None, granted: dict[str, Any]) -> dict[str, Any]:
    """A web call whose site, or search, a waiting request `first` of the same session asks for already: `what` is
    listed on that request's card (`also`) and the call gets its answer."""
    fut = run.waits[first]
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, permissions=[
            {**p, "also": [*(p.get("also") or []), what]} if p.get("id") == first else p
            for p in _pending(run.c, run.chat)])
    agents.log_permission(run.c, "asked", chat=run.chat, session=run.key, tool=tool_name, what=what, agent_id=agent_id,
                          joined=first)
    allow = await asyncio.shield(fut)
    allow = True if allow in (ALWAYS, COVERED) else allow
    if event == DENIED and isinstance(allow, bool):
        _remember(run, agent_id, tool_name, inp, allow, tool_use_id)
    return granted if allow is True else {"behavior": "deny", "message": _deny_message(run, allow)}


def _deny_message(run: Run, allow: Any, wait_s: float | None = None) -> str:
    """What Claude Code tells the model of a request that ended with `allow` (when it is a deny), one that waited
    `wait_s` (else the session's wait) when nobody answered it in time."""
    if allow == TIMED_OUT:
        return timed_out_line(wait_s or run.wait_s or PERMISSION_WAIT_S)
    return {None: GONE_LINE, SWITCHING: tools.hint(MODE_SWITCHING), ELSEWHERE: ELSEWHERE_LINE}.get(allow, DENIED_LINE)


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
    """Who asks, when a subagent or a workflow agent of the session does: its id and type as the hook gives them, and
    the title and chat of its step, which the card names (a step is made on the follower's pass, so one that asks
    before that pass is looked for at once)."""
    out: dict[str, Any] = {"agent_id": agent_id, "agent_type": agent_type}
    sub = _step_by(run, agent_id=agent_id)
    if sub is None and run.main is not None and run.main.path is not None:
        with contextlib.suppress(Exception):
            _scan_subagents(run)
        sub = _step_by(run, agent_id=agent_id)
    meta = agents.meta_or_none(run.c, sub.chat) if sub is not None else None
    if meta:
        out.update(agent_title=str(meta.get("title") or ""), agent_chat=sub.chat)  # type: ignore[union-attr]
    return out


def offer(suggestions: Any) -> list[dict[str, Any]]:
    """The updates of a request's permission_suggestions the card offers as "don't ask again": its allow rules, working
    directories and a switch to acceptEdits, each for the session alone (`destination` session); [] when it suggests none."""
    out: list[dict[str, Any]] = []
    for s in suggestions if isinstance(suggestions, list) else []:
        kind = s.get("type") if isinstance(s, dict) else None
        if kind == "addRules" and s.get("behavior") == "allow":
            rules = [{"toolName": r["toolName"], **({"ruleContent": r["ruleContent"]} if r.get("ruleContent") else {})}
                     for r in s.get("rules") or [] if isinstance(r, dict) and isinstance(r.get("toolName"), str)
                     and r["toolName"] and isinstance(r.get("ruleContent", ""), str)]
            if rules:
                out.append({"type": "addRules", "rules": rules, "behavior": "allow", "destination": "session"})
        elif kind == "addDirectories":
            dirs = [d for d in s.get("directories") or [] if isinstance(d, str) and d]
            if dirs:
                out.append({"type": "addDirectories", "directories": dirs, "destination": "session"})
        elif kind == "setMode" and s.get("mode") == EDIT_MODE:
            out.append({"type": "setMode", "mode": EDIT_MODE, "destination": "session"})
    return out


def rule_text(rule: dict[str, Any]) -> str:
    """A permission rule as Claude Code writes it in its settings and in /permissions: `Bash(npm test *)`, or the tool
    alone."""
    return f"{rule['toolName']}({rule['ruleContent']})" if rule.get("ruleContent") else str(rule["toolName"])


def offer_text(updates: list[dict[str, Any]]) -> str:
    """What a "don't ask again" adds, in Claude Code's terms: its rules, `all edits` for acceptEdits (Claude Code's
    "allow all edits during this session") and `files in <folder>/` for a working directory, named by its last part as
    Claude Code's dialog names it; a web rule kept for the workspace by its site, or as web search."""
    parts = [web_text(r) if u.get("destination") == WORKSPACE else rule_text(r)
             for u in updates if u["type"] == "addRules" for r in u["rules"]]
    parts += [f"files in {Path(d).name or d}/"
              for u in updates if u["type"] == "addDirectories" for d in u["directories"]]
    parts += ["all edits" for u in updates if u["type"] == "setMode"]
    return ", ".join(parts)


def _offered(updates: list[dict[str, Any]]) -> dict[str, str]:
    """The card's words for a request's "don't ask again": `keep`, the site or `web search`, for a web rule kept for the
    workspace, else `always`, what it adds for the session (offer_text); {} for none."""
    if not updates:
        return {}
    if all(u.get("destination") == WORKSPACE for u in updates):
        rule = updates[0]["rules"][0]
        return {"keep": str(rule.get("ruleContent") or "").removeprefix("domain:") or "web search"}
    return {"always": offer_text(updates)}


def web_text(rule: dict[str, Any]) -> str:
    """A web rule kept for the workspace, in the card's words: `<site> in this workspace`, `web search in this
    workspace`."""
    site = str(rule.get("ruleContent") or "").removeprefix("domain:")
    return f"{site or 'web search'} in this workspace"


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
    """Take a request that was denied unanswered off the card of the chat `chat`; False when there is none by that id."""
    pending = _pending(c, chat)
    if not any(p.get("id") == request_id and p.get("expired") for p in pending):
        return False
    agents.update_agent(c, chat, permissions=[p for p in pending if p.get("id") != request_id])
    return True


def _add_rules(run: Run, updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The analyst chose a request's "don't ask again": a web rule is kept for the workspace (keep_web_rule), and each
    other update is the session's from now on (chat meta and later argv); each other waiting request with the same
    offered updates is allowed, in every session of the workspace for a web rule. Returns the session's updates, which
    Claude Code is told."""
    kept = [u for u in updates if u.get("destination") == WORKSPACE]
    told = [u for u in updates if u.get("destination") != WORKSPACE]
    for rule in (r for u in kept for r in u["rules"]):
        keep_web_rule(run.c, rule_text(rule))
    if told:
        run.rules.extend(u for u in told if u not in run.rules)
        run.argv[:] = with_rules(run.argv, run.rules)
        with contextlib.suppress(Exception):
            agents.update_agent(run.c, run.chat, **{RULES_KEY: [{"text": offer_text([u]), "update": u} for u in run.rules]})
    others = [r for (cc, _), r in [*_runs.items(), *_hosted.items()] if cc == run.c and r is not run] if kept else []
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
    if allow == ELSEWHERE:
        return "none: answered in the session's own terminal"
    if allow == SWITCHING:
        return "deny: answered for a mode switch"
    return "deny"


def grant_key(agent_id: str | None, tool_name: str, inp: Any) -> tuple[str | None, str, str]:
    """What a call made again must share with the call auto mode refused (module note, auto mode): its agent, its tool
    and its input, less the `description`, which only labels the call and which the model may word anew."""
    d = {k: v for k, v in inp.items() if k != "description"} if isinstance(inp, dict) else inp
    return agent_id or None, tool_name, json.dumps(d, sort_keys=True, ensure_ascii=False, default=str)


def _remember(run: Run, agent_id: str | None, tool_name: str, inp: Any, allow: bool, tool_use_id: str | None) -> None:
    """The analyst's answer to a call auto mode refused, for the call made again (before_call); an allowed call shows
    as not run rather than failed, since it is made again (session.not_run)."""
    now = time.monotonic()
    for k in [k for k, (_, when) in run.grants.items() if now - when > GRANT_TTL_S]:
        run.grants.pop(k, None)
    run.grants[grant_key(agent_id, tool_name, inp)] = (allow, now)
    if allow:
        run.passes.setdefault((agent_id or None, tool_name), []).append(grant_key(agent_id, tool_name, inp))
        if tool_use_id:
            session.not_run(tool_use_id)


def _use_pass(run: Run, agent_id: str | None, tool_name: str, exact: tuple[str | None, str, str] | None = None) -> bool:
    """Use up an allow the agent has left for the tool within GRANT_TTL_S, the one for the call `exact` when it is
    given, else the oldest, whose remembered call it takes with it, so one allow lets one call run; False when none is
    left."""
    key = (agent_id or None, tool_name)
    now = time.monotonic()
    left = [k for k in run.passes.get(key, [])
            if k in run.grants and run.grants[k][0] and now - run.grants[k][1] <= GRANT_TTL_S]
    pick = exact if exact in left else (left[0] if left and exact is None else None)
    if pick is not None:
        left.remove(pick)
        run.grants.pop(pick, None)
    if left:
        run.passes[key] = left
    else:
        run.passes.pop(key, None)
    return pick is not None


def before_call(c: str, key: str | None, tool_name: str, inp: Any, agent_id: str | None = None) -> dict[str, Any]:
    """The permission hook before a call of a session in auto mode: `allow` when the analyst allowed this call (or a reworded
    call of the same tool by the same agent) after auto mode refused it, `deny` when they denied it, each once; {} for any
    other call."""
    run = asker(c, key)
    if run is None:
        return {}
    exact = grant_key(agent_id, tool_name, inp)
    allowed = {"behavior": "allow", "message": ALLOWED_LINE}
    hit = run.grants.get(exact)
    if hit is not None and time.monotonic() - hit[1] <= GRANT_TTL_S:
        if hit[0]:
            _use_pass(run, agent_id, tool_name, exact)
            return allowed
        run.grants.pop(exact, None)
        return {"behavior": "deny", "message": DENIED_LINE}
    run.grants.pop(exact, None)  # expired
    return allowed if _use_pass(run, agent_id, tool_name) else {}


def answer(c: str, chat: str, request_id: str, allow: bool, always: bool = False) -> bool:
    """The analyst's answer to a pending request of the session whose chat is `chat`, `always` for the card's "don't
    ask again", which allows it with the updates offered for it (module note, don't ask again); for a request denied
    unanswered, its dismissal from the card. False when there is none by that id."""
    run = _by_chat(c, chat)
    fut = run.waits.get(request_id) if run is not None else None
    if run is None or fut is None or fut.done():
        return dismiss(c, chat, request_id)
    fut.set_result(ALWAYS if allow and always and run.offers.get(request_id) else bool(allow))
    return True


# --------------------------------------------------------------------------- the mode switch


def _grant_waiting(run: Run) -> None:
    """Allow every request that waits on `run` (a switch to Bypass)."""
    for fut in list(run.waits.values()):
        if not fut.done():
            fut.set_result(True)


def _mode_is(run: Run, mode: str) -> None:
    """`run` runs in `mode` now: its chat's meta says so, no switch waits, and its later runs keep it (`_switched`)."""
    run.mode, run.switching, run.releasing = mode, None, False
    _switched[(run.c, run.chat)] = mode
    with contextlib.suppress(Exception):
        agents.update_agent(run.c, run.chat, permission_mode=mode, mode_switch=None)


def _set_flag(run: Run, flag: str) -> None:
    """The process's --permission-mode in `run.argv`, in place, for the next time it starts (acceptEdits for manual
    mode once the analyst allowed all edits, with_rules), and in its --settings the web's ask rules for that mode
    (web_asks) and the permission hook before each call while that is auto mode (permission_hooks)."""
    argv = run.argv
    if "--permission-mode" in argv:
        argv[argv.index("--permission-mode") + 1] = flag
    else:
        argv.extend(["--permission-mode", flag])
    argv[:] = with_rules(argv, run.rules)
    if "--settings" not in argv:
        return
    at = argv.index("--settings") + 1
    given = with_web_asks(json.loads(argv[at]), argv[argv.index("--permission-mode") + 1])
    hooks = dict(given.get("hooks") or {})
    ours = permission_hooks(run.c, auto=True)[PRE]
    kept = [e for e in hooks.get(PRE) or [] if e not in ours] + (ours if flag == "auto" else [])
    if kept:
        hooks[PRE] = kept
    else:
        hooks.pop(PRE, None)
    argv[at] = json.dumps({**given, "hooks": hooks})


def set_mode(c: str, chat: str, mode: str) -> dict[str, Any]:
    """Switch the running session whose chat is `chat` to `mode`: at once between Manual and Bypass (a switch to Bypass
    granting what waits) or while a retry waits, else once the follower has paused it. Returns {mode, switching}.
    LookupError when no session runs for the chat, ValueError for a mode that cannot be chosen (modes.refused)."""
    run = by_chat(c, chat)
    if run is None:
        raise LookupError("no session runs for this chat")
    if why := modes.refused(mode):
        raise ValueError(why)
    flag = modes.flag(mode)
    if run.paused:
        run.switching = mode  # the process is ending for a switch; it starts again in this mode
        agents.update_agent(c, chat, mode_switch=mode)
    elif flag == modes.flag(run.mode or "") or run.pid is None:
        _set_flag(run, flag)
        _mode_is(run, mode)
        if mode == BYPASS:
            _grant_waiting(run)
        if run.held:
            run.wake.set()  # it waited for this choice after auto mode ended it (module note, auto mode unavailable)
    else:
        run.switching = mode
        agents.update_agent(c, chat, mode_switch=mode)
    log.info("%s: session %s (%s) mode %s%s", c, run.key, run.sid, run.mode,
             f", switching to {run.switching}" if run.switching else "")
    return {"mode": run.mode, "switching": run.switching}


def _release(run: Run) -> None:
    """The session is quiet but for requests waiting on the analyst, and a switch pauses it: each is answered with
    `## session-mode-switching`, so the model reads why the call did not run rather than the rejection a signal would leave.
    Those calls show as not run, since the resumed session makes them again."""
    run.releasing = True
    paths = {None: run.main.path if run.main is not None else None,
             **{sub.agent_id: sub.path for sub in run.steps.values() if sub.agent_id}}
    for who in {who for who, _tool in run.asking.values()}:
        path = paths.get(who)
        with contextlib.suppress(Exception):
            for tid, tool in (_open(run, path).items() if path is not None else ()):
                if tool not in AGENT_TOOLS:
                    session.not_run(tid)
    for fut in list(run.waits.values()):
        if not fut.done():
            fut.set_result(SWITCHING)


def _not_run_cut_off(run: Run) -> None:
    """After a pause's signal: a call the session made between the last quiet look and the signal gets Claude Code's rejection
    (CUT_OFF). It is made again once resumed, so it shows as not run rather than failed."""
    subs = [run.main, *run.steps.values()] if run.main is not None else list(run.steps.values())
    for sub in subs:
        if sub is None or sub.path is None:
            continue
        try:
            with sub.path.open("rb") as f:
                f.seek(max(0, sub.offset - len(sub.buf)))
                data = f.read()
        except OSError:
            continue
        for line in data.split(b"\n"):
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            for b in session._content_list(rec) if isinstance(rec, dict) else []:
                if (isinstance(b, dict) and b.get("type") == "tool_result" and isinstance(b.get("tool_use_id"), str)
                        and session.response_text(b.get("content")).startswith(CUT_OFF)):
                    session.not_run(b["tool_use_id"])


def forget_calls(run: Run) -> None:
    """A new process of the session runs no call an earlier one left open: each transcript is read on from its end
    (module note, mode switch)."""
    paths = [run.main.path] if run.main is not None and run.main.path is not None else []
    paths += [sub.path for sub in run.steps.values() if sub.path is not None]
    for path in paths:
        run.open_calls[str(path)] = [session._size(path), b"", {}]


def _open(run: Run, path: Path) -> dict[str, str]:
    """The calls of one transcript that have no result yet, {tool_use_id: tool}, read on from where the last look
    stopped."""
    state = run.open_calls.setdefault(str(path), [0, b"", {}])
    size = session._size(path)
    if size > state[0]:
        with path.open("rb") as f:
            f.seek(state[0])
            data = f.read(size - state[0])
        state[0] = size
        lines = (state[1] + data).split(b"\n")
        state[1] = lines.pop()
        for line in lines:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            for b in session._content_list(rec) if isinstance(rec, dict) else []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use" and isinstance(b.get("id"), str):
                    state[2][b["id"]] = str(b.get("name") or "")
                elif b.get("type") == "tool_result":
                    state[2].pop(str(b.get("tool_use_id") or ""), None)
    return state[2]


def quiet(run: Run) -> bool:
    """Whether no call of the session runs now: every call of its own, of a subagent or of a running workflow agent has its
    result, except a foreground Agent call (its subagent's calls count instead) and the calls of an agent waiting on a
    permission request."""
    blocked = {who for who, _tool in run.asking.values()}
    agent_calls = {sub.tool_use_id for sub in run.steps.values() if sub.tool_use_id}
    sources = [(None, run.main.path)] if run.main is not None and run.main.path is not None else []
    for agent, path in [*sources, *((sub.agent_id, sub.path) for sub in _running_steps(run))]:
        if agent in blocked:
            continue  # it waits on the analyst, and Claude Code makes its other calls only after the one that asks
        for tid, tool in _open(run, path).items():
            if agent is None and tool in AGENT_TOOLS and tid in agent_calls:
                continue
            return False
    return True


def _running_steps(run: Run) -> list[session.Sub]:
    """The subagents and workflow agents the session runs now: the steps still open, and those a SendMessage
    continued."""
    return [sub for sub in run.steps.values() if sub.path is not None and (not sub.done or sub.agent_id in run.background)]


def _quiet_now(run: Run) -> bool:
    try:
        return quiet(run)
    except Exception:  # noqa: BLE001 — a transcript that cannot be read keeps the session running
        log.exception("%s: session %s: its open calls could not be read", run.c, run.key)
        return False


def stopped_text(steps: "list[dict[str, Any]]") -> str:
    """`## session-mode-stopped` naming the agents that stopped with a pause, each subagent by its id and title, which
    SendMessage continues, each workflow once by its run, which `resumeFromRunId` runs again; '' for none."""
    names: list[str] = []
    for step in steps:
        wf = str(step.get("workflow_dir") or "")
        name = f"the workflow run {Path(wf).name}" if wf else f'{step.get("agent_id")} ("{step.get("title") or STEP_TITLE}")'
        if name not in names:
            names.append(name)
    return tools.hint(MODE_STOPPED, agents=", ".join(names)) if names else ""


async def _switch_mode(run: Run) -> bool:
    """After the process exited: when the follower paused it for a switch, the steps still open end stopped, and the
    session starts again with --resume in its new mode and `## session-mode-changed` on stdin, naming the agents that
    stopped (module note, mode switch); True when a new process runs."""
    if not run.paused:
        return False
    run.paused = False
    mode = run.switching or run.mode or ""
    if run.stopping or not mode:
        return False
    stopped = run.paused_steps or _running_steps(run)
    run.paused_steps = []
    metas = [agents.meta_or_none(run.c, sub.chat) or {"agent_id": sub.agent_id} for sub in stopped]
    for sub in stopped:
        if sub.done:  # ended by the rejection Claude Code wrote for its cut-off Agent call
            with contextlib.suppress(Exception):
                agents.finish_agent(run.c, sub.chat, "stopped")
        _finish_step(run, sub, "stopped")
        if sub.agent_id:
            run.halted.add(sub.agent_id)
    run.background.clear()  # the resumed session names again what it continues or starts again
    _set_flag(run, modes.flag(mode))
    _mode_is(run, mode)
    text = stopped_text(metas)
    try:
        await _respawn(run, MODE_PROMPT, stopped=f"{text} " if text else "")
    except RuntimeError as e:
        run.result, run.result_error = str(e), True
        log.warning("%s: session %s could not be started again in %s (%s)", run.c, run.key, mode, e)
        return False
    return True


@router.get("/sessions/running")
async def running_route() -> list[dict[str, Any]]:
    """What a restart interrupts, for `thimble server restart` (cli.running_work): each session this server runs, by workspace,
    role, title and run, with whether the next server resumes it, less critiques; then each view being built."""
    from . import views  # noqa: PLC0415 — views imports the dev runner, which this module does not otherwise need

    out: list[dict[str, Any]] = []
    for run in list(_runs.values()):
        if run.role == STEP_ROLE or (run.task is not None and run.task.done()):
            continue
        title = (agents.meta_or_none(run.c, run.chat) or {}).get("title") or run.key
        out.append({"workspace": run.c, "kind": run.role, "title": title, "run": run.k, "resumes": resumable(run)})
    root = config.WORKSPACES_DIR
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        try:
            building = [p for p in views.list_proposals(folder.name) if p.get("status") == "building"]
        except Exception:  # noqa: BLE001 — a workspace whose corpus is gone builds nothing
            continue
        out.extend({"workspace": folder.name, "kind": "view", "title": str(p.get("name") or p["slug"]), "resumes": True}
                   for p in building)
    return out


class PermissionAnswer(BaseModel):
    id: str
    allow: bool
    always: bool = False  # the card's "don't ask again"


@router.post("/ws/{c}/chats/{chat}/resume")
async def resume_route(c: str, chat: str) -> dict[str, Any]:
    """A stopped background session's Resume (resume_chat); 409 when it cannot resume."""
    try:
        run = await resume_chat(c, chat)
    except Exception as e:  # noqa: BLE001 — the analyst reads why
        raise HTTPException(409, str(e) or type(e).__name__) from e
    return {"resumed": chat, "run": run.k}


@router.post("/ws/{c}/chats/{chat}/retry")
async def retry_route(c: str, chat: str) -> dict[str, Any]:
    """The retry alert's Retry now: the session starts again at once; 404 when it is not waiting to retry."""
    if not await retry_now(c, chat):
        raise HTTPException(404, "this session is not waiting to retry")
    return {"retrying": chat}


@router.post("/ws/{c}/chats/{chat}/permission")
async def permission_route(c: str, chat: str, body: PermissionAnswer) -> dict[str, Any]:
    if not answer(c, chat, body.id, body.allow, body.always):
        raise HTTPException(404, "no such permission request is waiting")
    return {"answered": body.id, "allow": body.allow}


class PermissionRequestBody(BaseModel):
    session: str
    event: str = REQUEST
    tool_name: str
    tool_input: Any = None
    agent_id: str | None = None
    agent_type: str | None = None
    tool_use_id: str | None = None
    reason: str = ""
    suggestions: Any = None  # a request's permission_suggestions


@router.post("/ws/{c}/sessions/permission")
async def permission_request_route(c: str, body: PermissionRequestBody) -> dict[str, Any]:
    """A session's permission hook (permission_hook.py), for the session its THIMBLE_SESSION names: a request or a call
    auto mode refused, answered by ask however long the analyst takes, or a call about to run, answered by before_call
    at once."""
    if body.event == PRE:
        return before_call(c, body.session, body.tool_name, body.tool_input, body.agent_id)
    return await ask(c, body.session, body.tool_name, body.tool_input, body.agent_id, body.agent_type,
                     event=DENIED if body.event == DENIED else REQUEST, reason=body.reason, tool_use_id=body.tool_use_id,
                     suggestions=body.suggestions)


class ModeBody(BaseModel):
    mode: str


@router.post("/ws/{c}/chats/{chat}/permission-mode")
async def mode_route(c: str, chat: str, body: ModeBody) -> dict[str, Any]:
    """A session card's mode switcher: set_mode. 404 when no session runs for the chat, 400 for a mode that cannot be
    chosen."""
    try:
        return set_mode(c, chat, body.mode)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


async def shutdown() -> None:
    """The server is going down: every session's process goes with it. One its caller resumes is left for the next server
    (_suspend), any other recorded as failed with `## session-server-stopped`. SIGTERM then SIGKILL, with short waits. Ends
    main does not hear now are kept (tell_main)."""
    for run in list(_runs.values()):
        # one the analyst's Stop is ending ends stopped, as they asked; a background session is left to run
        run.suspended = not run.stopping and (resumable(run) or run.bg)
        run.stopping = True
        if not run.suspended:
            run.interrupted = tools.hint(SERVER_STOPPED)
        run.wake.set()
        _signal(run, signal.SIGTERM)
    for run in list(_runs.values()):
        if run.proc is not None:
            with contextlib.suppress(asyncio.TimeoutError, Exception):
                await asyncio.wait_for(asyncio.shield(run.proc.wait()), 1.0)
        _kill(run)
        if run.task is not None and not run.task.done():
            with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError, Exception):
                await asyncio.wait_for(asyncio.shield(run.task), 2.0)
        if _runs.get((run.c, run.key)) is run:
            with contextlib.suppress(Exception):
                _end(run)


@contextlib.asynccontextmanager
async def _lifespan(app: Any):
    """The router's lifespan: at start a task resumes or closes the runs a previous server left running (recover), so the
    server answers meanwhile, and a task tells main the ends it did not hear once a session listens."""
    loop = asyncio.get_running_loop()
    recovering = loop.create_task(_recover_logged(), name="agent-session-recover")
    task = loop.create_task(_delivering(), name="agent-session-unheard")
    try:
        yield
    finally:
        task.cancel()
        recovering.cancel()


async def _recover_logged() -> None:
    try:
        closed, resumed = await recover()
        if closed:
            log.info("sessions left running by the previous server, closed as failed: %s", ", ".join(closed))
        if resumed:
            log.info("sessions left running by the previous server, resumed: %s", ", ".join(resumed))
        found = await bg_session.recover()
        if found:
            log.info("background sessions followed again: %s", ", ".join(found))
    except Exception:  # noqa: BLE001 — never fails the start
        log.exception("resuming or closing the sessions left running by the previous server failed")


router.lifespan_context = _lifespan
bg_session.on_wake(tools.CRITIQUE_SESSION, revive)
