"""thimble's agents as Claude Code background sessions (`claude --bg`): the orientation, its critique and the writers.
The analyst sees each in `claude agents`, in the agent view (←) and at the bottom of main's terminal, and can attach to it, answer
its permission prompts there and message it.

Names. Each session is named for Claude Code as `thimble:<role> · <workspace>` (name_of, config.session_name):
thimble:orient · <c>, thimble:writer · <c> (the report's; another document's is thimble:writer-<doc> · <c>) and
thimble:critic · <c>, since `claude agents` and ListAgents list the sessions of every folder and SendMessage's `to`
addresses a session by its name alone (its listed ` [ref]` is not the short id). The name, spaces and `·` included, is
the session's address everywhere: SendMessage's `to` in the proxy's instructions, wait_session's `session`, main's
messages that relay_check follows. Entry.name is the name `claude agents` listed for the session when it was recorded,
so a session an earlier build named `thimble:orient` keeps being addressed as that until it is started again under
its current name. ListAgents writes `  ·  ` between a row's
fields, so a name copied from it can lose its workspace; main's instructions give it the whole name to send to. A long
name has its workspace shortened (config.session_name), and by_name also takes the role before any separator a model
wrote in place of ` · `. The workspace's own lines (the statusline, the news) show the role alone (config.session_role).

Start. agent_session builds the `claude -p` command as for any session and hands it to start(), which turns it into a
`claude --bg` command: the first message goes on the command line, and the session's own environment is in the
--settings `env` already, since the background service starts the session with its own environment, the one of the
`claude` that started the service, and takes only PATH from the `claude --bg` that asks for the session. Every
`claude` command here runs with config.launch_environ, so the service never keeps a value of thimble's. `claude --bg`
refuses a folder Claude Code does not trust; install.sh asks once to trust thimble's workspaces folder
(claude_changes). Without that trust (trusted) none of these sessions starts, and the refusal says how the analyst can
trust the folder (the bg-untrusted hint). BgProc stands in for the process agent_session follows: a run ends when the
session is idle, its transcript's last turn has ended and it has no background work, while the session itself goes on
for the analyst. A session whose turn ended while a background shell of its own runs on counts as idle once its
transcript has been quiet for LINGER_S (_lingering), since Claude Code lists it as busy for as long as the shell runs.

Messages in place. A session that runs is never resumed with `--resume`, which would copy it under a new id: a message
for it (a follow-up from the browser, a retry after a capacity failure) waits in its outbox (deliver) and is sent with
SendMessage by the proxy subagent that shows the session in main's agent tray, or, without a live proxy within
PROXY_WAIT_S, by main. Only a session whose process has gone is started again, with `claude --bg --resume <id>` and
all of its start flags, since Claude Code keeps none of a session's options when its process was ended; the copy this
starts under a new id is recorded as the session's new id.

The proxy. For each session main runs a thin background subagent of the plugin (plugin/agents: thimble:orient,
thimble:writer, thimble:critic), which reads its instructions from proxy_file and loops on the `wait_session` tool
until the session ends or finishes its task (finished): the tool returns the session's news (below) as one block of
lines, which the proxy copies into its reply word for word, one reply per call, and the outbox's messages as tokens.
Two plugin hooks keep it reliable: before a SendMessage (relay_check) the server swaps a token for its message, prefixes
a message the analyst typed in the proxy's view, and refuses a message sent twice; when the proxy would stop while its
session works (proxy_stop), the hook sends it back to waiting. Main is asked to start a proxy again while none runs and
the session has a task (not resting), unless Claude Code refused its call for that session, as auto mode can
(proxy_refused). A resting session shows in the tray again once it starts another turn.

The news. What the analyst would see of a subagent, read from the session's transcript in its order (_read_news, which
keeps an offset past the last whole line it read, so no line shows twice): each reply as `<name>: <text>` (NEWS_CHARS, a
longer one keeps its start and says how much was cut), each tool call as `● <tool>: <what it acts on>` (a thimble tool
by its bare name, a card tool by its card's question, an Agent call by its subagent type and description, a Bash call by
its command's first line, a file tool by its path; _call_words, TOOL_CHARS), each failed result as `✗ <tool>: <the
error's first line>` (`✗ tool:` when its call came before a server restart, since the calls' names are not kept), each
interrupted turn as `<name> was interrupted.`, and each message
as `✉ <sender> → <recipient>: <text>` (MESSAGE_CHARS): those it sends with SendMessage, and those it gets (the
analyst's, relayed from the tray or the browser or typed with `claude attach`, main's, another session's, a subagent's
hand-back, a finished background task, the prompts thimble starts it with, read from the transcript's start for a new
session). Claude Code's own records (meta prompts, command output, system records) give none. To this the watcher adds
the session's state (waiting for a permission, ended) and the end of each run. A waiting wait_session reads the
transcript every NEWS_POLL_S and returns once there is news, so a tool call shows in the tray within about NEWS_POLL_S +
NEWS_GATHER_S and the proxy's turn; one answer holds at most NEWS_RETURN_CHARS of news, the rest coming with the next. The session
itself, as Claude Code draws it, shows with `claude attach <id>`.

The watcher. One task per server lists `claude agents` for every session known here (REGISTRY_FILE keeps them across
restarts), every POLL_S while one needs following (_hot: it works, started lately, has a run of thimble's open, a message
waiting or a missed listing), else at gaps that double up to IDLE_POLL_S, cut short when a session's transcript grows or
one is recorded: a session whose process has gone ends stopped; one that starts a turn with no run of thimble's (a
message typed in its terminal or in the proxy's view, or main's SendMessage) is followed again as a new run of its chat
(on_wake). A turn starts with a line in the transcript (Entry.new_turn): a session listed busy with no such line since
its run ended runs only background shells and rests, after a server restart too (recover). The watcher reads the
session's transcript for the news too, and its state becomes the proxy's news, the statusline's line and the
/thimble:agents list (agents_route).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import textwrap
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import APIRouter
from pydantic import BaseModel

from . import agents, calls, cite, config, ledger, session

log = logging.getLogger("thimble.bg_session")
router = APIRouter()

REGISTRY_FILE = "bg-sessions.json"  # in the workspace: the background sessions thimble started
PROXY_DIR = "bg"  # in the workspace: each proxy's instructions (proxy_file)
POLL_S = 1.5
# the longest wait between two listings while no session needs following (_hot): an idle session's turn begins with a
# line in its transcript, which the watcher looks for every POLL_S without starting a `claude` process
IDLE_POLL_S = 30.0
# the longest a wait_session call waits for news; a message typed in the tray entry's view reaches it only after that
# call returns, so this bounds how long such a message waits
WAIT_S = 6.0
PROXY_WAIT_S = 20.0  # how long a message waits for the proxy before main is asked to send it
PROXY_ALIVE_S = 90.0  # a proxy that has not called wait_session for this long is taken for gone
PROXY_ASK_S = 120.0  # how long main's start of a proxy is waited for before main is asked again
# how long after its run ended an idle session counts as still at its task (finished), so a run that follows at once,
# such as a queued follow-up, keeps its tray entry
FINISHED_AFTER_S = 15.0
IDENTIFY_TRIES = 20
CLI_TIMEOUT_S = 60
MAX_ARG = 100_000  # bytes of a first message kept on the command line; a longer one goes through a file
FIRST_MESSAGE_FILE = ".thimble-first-message.md"
NEWS_CHARS = 4_000  # of one reply of the session in its news; a longer one keeps its start and says how much was cut
TOOL_CHARS = 140  # of what a tool call's news line shows of the call, and of a failed call's error
MESSAGE_CHARS = 400  # of a message to or from the session, as its news line shows it
NEWS_POLL_S = 0.4  # how often a waiting wait_session reads the session's transcript for news
NEWS_GATHER_S = 0.3  # how long wait_session waits after the first news for the lines that come with it
CALLS_KEEP = 256  # the session's newest tool calls whose names its news keeps, for their results that come later
NEWS_KEEP = 200  # news lines that wait for a proxy; older ones are dropped (_news)
HEARD_KEEP = 16  # the session's newest messages its news keeps, so a message in two shapes shows once
PROMPT_KEY = 200  # characters of a prompt start() gave a session that tell it from what the analyst typed (_message)
CALL_KEYS = ("question", "name", "title", "doc", "span", "ref", "card", "thread", "label", "query", "url", "path",
             "file_path", "pattern", "description", "command", "prompt", "text", "message")  # _call_words, in order
# main's SendMessage to the session, as its queued command or prompt carries it (origin coordinator)
COORDINATOR_RE = re.compile(r"^[^\n]*sent a message while you were working:\n(.*?)(?:\n\nAddress this.*)?\Z", re.S)
NEWS_RETURN_CHARS = 10_000  # of the news one wait_session returns; the rest waits for the next call
HANDBACK_RE = re.compile(r"\A\[Subagent hand-back\].*?follows:\n", re.S)  # the harness's lead of a hand-back
SUMMARY_RE = re.compile(r"<summary>(.*?)</summary>", re.S)  # of a task notification
ERROR_TAG_RE = re.compile(r"</?tool_use_error>")
BLOCKS_MAX = 12  # stops of a proxy refused in a row with no wait_session between them, after which it may stop
GONE_AFTER = 3  # listings in a row without its process after which a session counts as ended
START_GRACE_S = 20.0  # a session this young is never taken for ended
# the states `claude agents` lists for a session whose process will not come back; one listed in any other state with
# no process is being restarted by Claude Code under the same id, which may take RESTART_WAIT_S
ENDED_STATES = {"stopped", "done", "failed", "crashed", "error"}
RESTART_WAIT_S = 90.0
DELIVERY_WAIT_S = 300.0  # how long a run attached with a message waits for the session to take it up
# a session Claude Code lists as busy whose last turn ended this long ago, with no transcript line since, runs only
# background shells, which a --print session would end with its process: it counts as idle (_lingering)
LINGER_S = 30.0
TAIL_BYTES = 524_288  # of a transcript's end, read for its last turn (turn_state)
BG_ID_RE = re.compile(r"backgrounded\W+([0-9a-f]{8})\b")
UNTRUSTED_RE = re.compile(r"not trusted", re.IGNORECASE)  # `claude --bg`'s refusal of a folder it does not trust
DROP_FLAGS = {"-p", "--print", "--verbose"}
DROP_WITH_VALUE = {"--output-format", "--session-id", "--input-format"}
# the provider settings a session gets in its --settings `env`, since the background service passes it only PATH; a
# credential is never put on a command line, so a session authenticates as the service's environment and the user's
# settings let it
PROVIDER_ENV = re.compile(r"CLAUDE_CODE_(USE_\w+|SKIP_\w+_AUTH)|ANTHROPIC_BASE_URL")
# a long call of thimble's tools, such as the critique, stays a foreground call, as under `claude -p`, so the session
# never looks idle while one runs
FOREGROUND_ENV = {"CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0"}
# the plugin agent that shows each kind of session in the agent tray (plugin/agents)
PROXY_TYPES = {"orient": "orient", "writer": "writer", "critique": "critic"}
TYPED_PREFIX = "From the analyst, typed in Claude Code's agent tray:"
TOKEN_PREFIX = "thimble-message-"
ANNOUNCED_FILE = "bg-announced.json"  # in the workspace: the start and finish lines main's terminal has shown
FORK_DEDUPE_S = 600.0  # how long a thread's fork counts as starting, until the mirror sees it finish
STATUS_CHARS = 110  # of one statusline line; more agents go on further lines


def _plugin() -> str:
    from . import orientation  # noqa: PLC0415 — orientation imports this module's callers

    return orientation.PLUGIN


# --------------------------------------------------------------------------- trust


def claude_json() -> Path:
    """Claude Code's global config, which keeps the folders it trusts: .claude.json in the config dir of the Claude Code
    thimble serves (config.claude_config_env), else ~/.claude.json."""
    value = config.claude_config_env()
    return Path(value).expanduser() / ".claude.json" if value else Path.home() / ".claude.json"


_trust_read: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}  # claude_json's path -> ((mtime, size), its data)


def trusted(c: str) -> bool:
    """Whether Claude Code trusts workspace `c`'s folder, below which its background sessions run (module note, start),
    by the rule `claude --bg` applies (claude_changes.trusted), as through install.sh's entry for the install or the
    workspaces folder. The file is parsed again only when it changed, since the settings ask on each read."""
    from . import claude_changes  # noqa: PLC0415

    path = claude_json()
    try:
        st = path.stat()
    except OSError:
        return False
    stamp = (st.st_mtime_ns, st.st_size)
    kept = _trust_read.get(str(path))
    if kept is None or kept[0] != stamp:
        kept = _trust_read[str(path)] = (stamp, claude_changes._read(path))
    return claude_changes.trusted(config.WORKSPACES_DIR / c, kept[1])


def kind_of(key: str) -> str:
    return key.split(":", 1)[0]


def name_of(c: str, key: str) -> str:
    """The name a new session of `key` in workspace `c` gets in Claude Code (module note, names): thimble:orient · <c>,
    thimble:writer · <c> (the report's), thimble:writer-<doc> · <c>, thimble:critic · <c>."""
    kind, _, rest = key.partition(":")
    if kind == "writer":
        role = "writer" if rest in ("", "report") else f"writer-{rest}"
    else:
        role = PROXY_TYPES.get(kind, kind)
    return config.session_name(role, c)


def label_of(key: str) -> str:
    """The session of `key` as /thimble:agents lists it: orientation, critic, writer (the report's), writer: <doc>."""
    kind, _, rest = key.partition(":")
    if kind == "writer":
        return "writer" if rest in ("", "report") else f"writer: {rest}"
    return {"orient": "orientation", "critique": "critic"}.get(kind, kind)


def proxy_type(key: str) -> str:
    """The plugin agent that shows the session in the agent tray, as main's Agent call names it."""
    return f"{_plugin()}:{PROXY_TYPES.get(kind_of(key), 'orient')}"


# --------------------------------------------------------------------------- the CLI


def _cli(bin_: str, args: list[str], env: dict[str, str], cwd: Path | None = None,
         timeout: float = CLI_TIMEOUT_S) -> tuple[int, str]:
    try:
        p = subprocess.run([bin_, *args], capture_output=True, text=True, timeout=timeout, env=env,
                           cwd=str(cwd) if cwd else None)
    except (OSError, subprocess.SubprocessError) as e:
        return 1, str(e)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _bin() -> str:
    from . import agent_session  # noqa: PLC0415 — agent_session imports this module

    return agent_session.CLAUDE_BIN


def _env() -> dict[str, str]:
    return config.launch_environ()


def listing(bin_: str | None = None, env: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """`claude agents --json --all`: every background session Claude Code knows, running or not."""
    code, out = _cli(bin_ or _bin(), ["agents", "--json", "--all"], env or _env(), timeout=20)
    if code != 0 or "[" not in out:
        return []
    try:
        data = json.loads(out[out.index("["):])
    except ValueError:
        return []
    return [e for e in data if isinstance(e, dict) and e.get("kind", "background") == "background"]


def _names_itself(e: dict[str, Any]) -> bool:
    short, sid = str(e.get("id") or ""), str(e.get("sessionId") or "")
    return not short or not sid or sid.startswith(short)


def stop_cli(short: str) -> None:
    if short:
        _cli(_bin(), ["stop", short], _env(), timeout=20)


# --------------------------------------------------------------------------- the command


def bg_argv(argv: list[str], env: dict[str, str], name: str, prompt: str, folder: Path) -> list[str]:
    """The `claude --bg` argv for the `claude -p` argv `argv`, named `name`, with `prompt` as the first message and, in
    its --settings `env`, the provider settings (PROVIDER_ENV) of `env`, the environment the command runs with, and
    FOREGROUND_ENV (module note, start)."""
    out: list[str] = [argv[0], "--bg", "-n", name]
    extra_env = {**{k: v for k, v in env.items() if PROVIDER_ENV.fullmatch(k)}, **FOREGROUND_ENV}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in DROP_FLAGS:
            i += 1
            continue
        if a in DROP_WITH_VALUE or a == "--resume":
            i += 2
            continue
        if a == "--settings":
            given = json.loads(argv[i + 1])
            given["env"] = {**extra_env, **(given.get("env") or {})}
            out += [a, json.dumps(given)]
            i += 2
            continue
        out.append(a)
        i += 1
    if len(prompt.encode("utf-8")) > MAX_ARG:
        path = folder / FIRST_MESSAGE_FILE
        path.write_text(prompt, encoding="utf-8")
        from . import tools  # noqa: PLC0415

        prompt = tools.hint("bg-first-message", path=str(path))
    return [*out, "--", prompt]


# --------------------------------------------------------------------------- the registry


@dataclass
class Entry:
    """A background session thimble started, as the watcher follows it."""

    c: str
    key: str
    name: str
    short: str
    sid: str
    chat: str
    role: str
    folder: str
    started: float = field(default_factory=time.time)
    status: str = "working"  # working | waiting | idle | stopped
    waiting_for: str = ""
    pid: int | None = None
    run_open: bool = True  # a run of thimble's follows the session now
    result: str = ""  # the last run's summary
    ended_at: float = 0.0
    offset: int = 0  # of its transcript, read for the proxy's news
    news: list[str] = field(default_factory=list)
    dropped: int = 0  # news lines dropped since the last wait_session, since no proxy took them (_news)
    tx_path: str = ""  # its transcript, as _transcript found it for the session id tx_sid
    tx_sid: str = ""
    calls: dict[str, str] = field(default_factory=dict)  # tool_use_id -> tool name of its newest calls (CALLS_KEEP)
    heard: list[tuple[str, str, str]] = field(default_factory=list)  # (uuid, text, shape) of its newest messages
    prompts: list[str] = field(default_factory=list)  # the starts of the prompts start() gave it on the command line
    outbox: list[dict[str, Any]] = field(default_factory=list)
    proxy_seen: float = 0.0  # time.monotonic() of the proxy's last wait_session call
    proxy_asked: float = 0.0  # time.monotonic() when main was last asked to start the proxy, 0.0 before it is asked
    proxy_agents: list[str] = field(default_factory=list)  # agent ids of the proxies main started for it
    relayed: list[str] = field(default_factory=list)  # typed messages' uuids already sent, and tokens already sent
    blocks: int = 0  # stops of its proxy refused since its last wait_session
    owner: str | None = None  # the agent id of the proxy that shows it; another one is told to stop (wait)
    replacing: bool = False  # a new session of its key is starting in its place, which its proxy goes on to show
    misses: int = 0  # listings in a row that showed no process for it
    missing_since: float = 0.0  # time.monotonic() since when the listings show no process for it
    proxy_starting: float = 0.0  # time.monotonic() when main's Agent call that starts its proxy was let through
    last_said: str = ""  # its last reply as its news gave it, which the news of its run's end does not repeat
    tx_seen: int = -1  # the transcript offset _lingering last saw
    tx_grew: float = 0.0  # time.monotonic() when that offset last changed
    tx_ended: bool | None = None  # whether the transcript's last turn had ended at that offset, once read
    proxy_refused: bool = False  # Claude Code refused main's Agent call that would start its proxy (proxy_refused)
    ended_state: str = ""  # the state `claude agents` listed for it when its process went away (stopped_in_claude)
    # a prompt or a reply was read from its transcript since its last run ended, or since this server loaded it: a turn
    # began
    new_turn: bool = False

    KEEP = ("c", "key", "name", "short", "sid", "chat", "role", "folder", "started", "status", "run_open", "result",
            "ended_at", "proxy_agents", "relayed", "proxy_refused")

    @property
    def shown(self) -> str:
        """The session's name as the workspace's own lines show it: its role alone (module note, names)."""
        return config.session_role(self.name)

    def saved(self) -> dict[str, Any]:
        d = asdict(self)
        return {k: d[k] for k in self.KEEP}


_entries: dict[tuple[str, str], Entry] = {}  # (workspace, key) -> the session
_loaded: set[str] = set()
_wake: dict[str, Callable[[str, Entry], Awaitable[Any]]] = {}  # kind -> the caller that follows a woken session
_changed = asyncio.Event()  # set on each news line, state change and outbox message, for wait_session
_poked = False  # a session was recorded since the watcher's last listing began: it lists again within POLL_S
_task: asyncio.Task | None = None
_closing = False  # the server is going down: waits return at once


def on_wake(kind: str, fn: Callable[[str, Entry], Awaitable[Any]]) -> None:
    """Have `fn(c, entry)` follow a session of `kind` that started a turn with no run of thimble's following it: it
    starts the run (agent_session.start with `resume`, which attaches to the running session)."""
    _wake[kind] = fn


def _load(c: str) -> None:
    if c in _loaded:
        return
    _loaded.add(c)
    try:
        rows = json.loads((config.workspace_dir(c) / REGISTRY_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        rows = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not row.get("key") or not row.get("short"):
            continue
        with contextlib.suppress(TypeError):
            e = Entry(**{k: row[k] for k in Entry.KEEP if k in row})
            e.run_open = False  # a run is followed again only once a server attaches to it
            path = session.find_transcript(e.sid)
            e.offset = session._size(Path(path)) if path else 0  # the proxy's news start now
            e.proxy_asked = time.monotonic()  # a proxy that ran before a restart gets PROXY_ASK_S to call again
            _entries[(c, e.key)] = e


def _save(c: str) -> None:
    rows = [e.saved() for (cc, _), e in _entries.items() if cc == c]
    try:
        ledger.atomic_write_text(config.workspace_dir(c) / REGISTRY_FILE, json.dumps(rows, indent=1))
    except (OSError, Exception):  # noqa: BLE001 — a workspace deleted under the watcher
        log.debug("%s: the background sessions were not saved", c, exc_info=True)


def entry(c: str, key: str) -> Entry | None:
    _load(c)
    return _entries.get((c, key))


def entries(c: str | None = None) -> list[Entry]:
    if c is not None:
        _load(c)
    return [e for (cc, _), e in list(_entries.items()) if c is None or cc == c]


REF_RE = re.compile(r"\s+\[[0-9A-Za-z]+\]\Z")  # the ` [ref]` SendMessage's `to` may carry after a listed name
# where a name's role ends however its separator was written (`thimble:writer - mini`, `thimble:writer·mini`), for by_name
ROLE_END_RE = re.compile(r"\s|[·•]")


def by_name(c: str, name: str, exact: bool = False) -> Entry | None:
    """The session of workspace `c` that `name` names: its name, without a ` [ref]` after it (REF_RE), ignoring case;
    unless `exact` (a SendMessage's `to`, which Claude Code delivers by the name alone), also its role (config.session_role,
    such as `thimble:writer`, which only one session of the workspace has), alone or followed by the workspace after any
    separator (ROLE_END_RE), its key or its short id."""
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
    """The session of workspace `c` a peer message's origin `name` names (session._peer): as by_name takes it, else with
    its first `-` read as `:` or compared as a slug (`thimble-writer-mini` for `thimble:writer · mini`), should Claude Code
    record a sender's name in a slugged form; which form it records for a name with spaces and `·` is not known."""
    hit = by_name(c, name) or by_name(c, name.replace("-", ":", 1))
    want = _slug(name)
    return hit or next((e for e in entries(c) if want and want in (_slug(e.name), _slug(config.session_role(e.name)))), None)


def alive(e: Entry | None) -> bool:
    return e is not None and (e.status != "stopped" or e.replacing)


def resting(e: Entry | None) -> bool:
    """Whether a session that runs has no task now: Claude Code keeps a background session's process after its last
    turn, idle, so a session with no run of thimble's following it and no message waiting for it rests until it starts
    another turn (_tick): one listed idle, or one listed busy whose transcript shows no turn since its run ended, which
    runs only background shells. Main is not asked to show it in the tray."""
    return (alive(e) and not e.replacing and not e.run_open and not _pending_out(e)
            and (e.status == "idle" or not e.new_turn))


def finished(e: Entry | None) -> bool:
    """Whether a resting session has finished its task: it has rested for FINISHED_AFTER_S since its run ended, so a run
    that follows at once keeps its tray entry. Its tray entry ends."""
    return resting(e) and time.time() - e.ended_at >= FINISHED_AFTER_S


def stopped_in_claude(c: str, key: str) -> bool:
    """Whether the session's process went away because Claude Code stopped it, as with `claude stop` or the agent view,
    which the analyst does, rather than a crash."""
    e = entry(c, key)
    return e is not None and e.ended_state == "stopped"


def replace(c: str, key: str) -> None:
    """A new session of `key` starts in place of the one that runs: that one is stopped, and its proxy shows the new
    one once it is recorded (record)."""
    e = entry(c, key)
    if e is None or e.status == "stopped":
        return
    e.replacing = True
    stop_cli(e.short)
    e.status = "stopped"


def _status(row: dict[str, Any]) -> str:
    status = str(row.get("status") or "")
    return "waiting" if status == "waiting" else "idle" if status == "idle" else "working"


def record(c: str, key: str, *, short: str, sid: str, chat: str, role: str, folder: Path,
           status: str = "working", offset: int | None = None, name: str = "") -> Entry:
    """A session thimble started or attached to, followed from now on by the watcher, under `name`, the name `claude
    agents` lists it by (by default name_of's; module note, names). A session not followed before under this short id
    has its news read from `offset` in its transcript: 0 for a new session, whose whole transcript is its own, the
    transcript's size before `claude --bg --resume` for one started again, and by default (a running session attached
    to) its size now."""
    _load(c)
    old = _entries.get((c, key))
    e = old if old is not None and old.short == short else Entry(c, key, name or name_of(c, key), short, sid, chat, role,
                                                                 str(folder))
    if name:
        e.name = name
    if old is not None and old is not e:
        e.proxy_agents, e.proxy_seen, e.outbox = old.proxy_agents, old.proxy_seen, old.outbox
    e.sid, e.chat, e.status, e.run_open = sid, chat, status, True
    e.started, e.misses, e.ended_state = time.time(), 0, ""
    path = session.find_transcript(sid)
    if old is None or old.short != short:
        e.offset = offset if offset is not None else session._size(Path(path)) if path else 0
    _entries[(c, key)] = e
    _save(c)
    _ensure_watcher()
    return e


def run_ended(c: str, key: str, summary: str) -> None:
    """The run of thimble's that followed the session ended; the session itself goes on until its process does."""
    e = entry(c, key)
    if e is None:
        return
    e.run_open, e.new_turn = False, False
    e.result = " ".join(str(summary or "").split())[:400]
    e.ended_at = time.time()
    said = cite.to_links(e.result)
    _news(e, f"{e.shown} finished its task" + (f": {said}" if said and not e.last_said.startswith(said[:200]) else "."))
    _save(c)


def forget(c: str, key: str) -> None:
    if _entries.pop((c, key), None) is not None:
        _save(c)


def _news(e: Entry, line: str) -> None:
    """A news line for the session's proxy; while no proxy takes them, only the newest NEWS_KEEP wait, and the next
    wait_session says how many earlier ones were dropped."""
    e.news.append(line)
    if len(e.news) > NEWS_KEEP:
        e.dropped += len(e.news) - NEWS_KEEP
        del e.news[: len(e.news) - NEWS_KEEP]
    _changed.set()


# --------------------------------------------------------------------------- the watcher


def _ensure_watcher() -> None:
    global _task, _poked
    _poked = True
    if _task is not None and not _task.done():
        return
    with contextlib.suppress(RuntimeError):
        _task = asyncio.get_running_loop().create_task(_watch(), name="bg-sessions")


def _hot() -> bool:
    """Whether a session needs a listing every POLL_S: one listed working that does not rest, started or attached to in
    the last START_GRACE_S, being replaced, missing from the last listing, followed by a run of thimble's, or with a
    message in its outbox that is neither sent nor handed to main."""
    now = time.time()
    return any(alive(e) and ((e.status == "working" and not resting(e)) or e.run_open or e.replacing or e.misses
                             or now - e.started < START_GRACE_S
                             or any(not i["sent"] and not i["main_asked"] for i in e.outbox))
               for e in entries())


def _sizes() -> dict[tuple[str, str], int]:
    """The sizes of the transcripts of the sessions alive, found already: a turn begins with a line there."""
    return {(e.c, e.key): session._size(Path(e.tx_path)) for e in entries() if alive(e) and e.tx_path}


async def _quiet(wait: float, sizes: dict[tuple[str, str], int]) -> None:
    """Wait up to `wait`, looking every POLL_S for a reason to list sooner: a session that needs following, a transcript
    that is no longer of its size in `sizes` (taken before the last listing) or a session recorded since that
    listing began."""
    end = time.monotonic() + wait
    while (left := end - time.monotonic()) > 0:
        await asyncio.sleep(min(left, POLL_S))
        if _poked or _hot() or _sizes() != sizes:
            return


async def _watch() -> None:
    global _poked
    wait = POLL_S
    while any(alive(e) for e in entries()):
        sizes, _poked = _sizes(), False
        try:
            rows = await asyncio.to_thread(listing)
            await _tick(rows)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — the watcher never stops for one bad pass
            log.exception("the background sessions' watcher failed a pass")
        wait = POLL_S if _hot() else min(wait * 2, IDLE_POLL_S)
        await _quiet(wait, sizes)


async def _tick(rows: list[dict[str, Any]]) -> None:
    from . import agent_session  # noqa: PLC0415

    by_id = {str(r.get("id") or ""): r for r in rows if _names_itself(r)}
    unshown: dict[str, list[str]] = {}
    for e in entries():
        if not alive(e):
            continue
        hit = by_id.get(e.short)
        before = (e.status, e.waiting_for)
        if e.replacing:
            continue
        if hit is None or not hit.get("pid"):
            e.misses += 1
            e.missing_since = e.missing_since or time.monotonic()
            if not _gone(e, hit):
                continue
            e.status, e.waiting_for, e.pid, e.missing_since = "stopped", "", None, 0.0
            e.ended_state = str((hit or {}).get("state") or "")
            _news(e, f"{e.shown} has ended.")
            _save(e.c)
            if agent_session.current(e.c, e.key) is None:
                _stopped_while_idle(e)
            continue
        e.misses, e.missing_since = 0, 0.0
        e.pid = int(hit["pid"])
        e.status = _status(hit)
        _read_news(e)
        if e.status == "working" and _lingering(e):
            e.status = "idle"
        e.waiting_for = str(hit.get("waitingFor") or "") if e.status == "waiting" else ""
        if (e.status, e.waiting_for) != before:
            if e.status == "waiting":
                _news(e, f"{e.shown} waits for a {e.waiting_for or 'reply'}; answer it in the browser or with "
                         f"`claude attach {e.short}`.")
            _changed.set()
        if (not proxy_alive(e) and not e.proxy_refused and not resting(e)
                and (not e.proxy_asked or time.monotonic() - e.proxy_asked > PROXY_ASK_S)):
            unshown.setdefault(e.c, []).append(e.key)
        if e.status != "idle" and not e.run_open and e.new_turn and agent_session.current(e.c, e.key) is None:
            fn = _wake.get(kind_of(e.key))
            if fn is not None:
                e.run_open = True
                log.info("%s: background session %s (%s) started a turn; following it again", e.c, e.name, e.short)
                asyncio.get_running_loop().create_task(_woken(fn, e), name=f"bg-wake:{e.c}:{e.key}")
        _flush_outbox(e)
    for c, keys in unshown.items():
        if ask_main_for_proxy(c, *keys):
            log.info("%s: main is asked to show %s in the agent tray", c, ", ".join(name_of(c, k) for k in keys))


def _lingering(e: Entry) -> bool:
    """Whether a session listed as busy has ended its turn with only background shells left running: its transcript's
    last turn has ended and no line was added for LINGER_S. The offset is the one _read_news keeps."""
    now = time.monotonic()
    if e.offset != e.tx_seen:
        e.tx_seen, e.tx_grew, e.tx_ended = e.offset, now, None
        return False
    if now - e.tx_grew < LINGER_S:
        return False
    if e.tx_ended is None:
        e.tx_ended = turn_state(e.sid)[0]
    return e.tx_ended


def _gone(e: Entry, hit: dict[str, Any] | None) -> bool:
    """Whether a session the listing shows with no process has ended: one listed in an ended state (claude stop), or
    missing from the listing, after GONE_AFTER listings; one listed in any other state only after RESTART_WAIT_S, since
    Claude Code restarts a session whose process died."""
    if time.time() - e.started < START_GRACE_S or e.misses < GONE_AFTER:
        return False
    if hit is None or str(hit.get("state") or "") in ENDED_STATES:
        return True
    return time.monotonic() - e.missing_since >= RESTART_WAIT_S


async def _woken(fn: Callable[[str, Entry], Awaitable[Any]], e: Entry) -> bool:
    """Follow the session again with its caller's `fn`; False when no run follows it, which leaves it resting until its
    transcript shows another turn."""
    try:
        run = await fn(e.c, e)
    except Exception:  # noqa: BLE001
        log.exception("%s: background session %s could not be followed again", e.c, e.name)
        run = None
    if run is None:
        e.run_open, e.new_turn = False, False
        log.info("%s: background session %s (%s) is not followed again; it rests until its transcript shows another "
                 "turn", e.c, e.name, e.short)
        return False
    return True


def _stopped_while_idle(e: Entry) -> None:
    """The process of a session with no run open went away (claude stop, a crash, the end of Claude Code's background
    service): its chat says it stopped, with Resume, unless it had finished its task, when it stays done."""
    from . import agent_session  # noqa: PLC0415

    with contextlib.suppress(Exception):
        meta = agents.meta_or_none(e.c, e.chat)
        if meta is None or meta.get("status") == "done":
            return
        if meta.get("status") == "running":
            agents.finish_agent(e.c, e.chat, "stopped", e.result or None)
        agents.update_agent(e.c, e.chat, alert={**agent_session.STOPPED_ALERT, "since": _iso_now()})


def _iso_now() -> str:
    from datetime import datetime, timezone  # noqa: PLC0415

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
    turn was interrupted (Esc with `claude attach`), which Claude Code writes as a prompt. Claude Code's own records
    (meta prompts, command output, system records, subagents' sidechains) give none."""
    if not line.strip():
        return []
    try:
        rec = session._load(line)
    except session.Unreadable:
        return []
    if rec.get("isSidechain"):
        return []
    t = rec.get("type")
    if t in ("user", "assistant"):
        e.new_turn = True
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
                out.append(f"{e.shown}: {_clip(text, NEWS_CHARS, e.short)}")
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
    notification), what the analyst typed with `claude attach` (origin human), and the prompt thimble started or
    resumed it with, which Claude Code also writes as typed (origin human), told apart by e.prompts and the
    bg-first-message hint. A message thimble relayed names its first sender (_relayed_by)."""
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
        if any(not i["by"] and _norm(i["text"]) == _norm(body) for i in e.outbox):
            return "thimble", body.strip()  # thimble's own message, sent in place (deliver with no sender)
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
    return _relayed_by(text) or ("thimble" if _from_thimble(e, text) else "analyst (attached)", text)


def _from_thimble(e: Entry, text: str) -> bool:
    """Whether a prompt is one thimble gave the session on the command line (start): one of e.prompts, or the
    bg-first-message hint that stands for a long one."""
    from . import tools  # noqa: PLC0415

    head = tools.hint("bg-first-message", path="\0").partition("\0")[0]
    return _norm(text)[:PROMPT_KEY] in e.prompts or bool(head and text.startswith(head))


def _relayed_by(text: str) -> tuple[str, str] | None:
    """(sender, message) of a message thimble relayed to the session in the words of its bg-from-* hints (_outgoing):
    the analyst in the browser or in the tray, or main."""
    from . import tools  # noqa: PLC0415

    for hint, by in (("bg-from-browser", "analyst (browser)"), ("bg-from-terminal", "analyst (tray)"),
                     ("bg-from-main", "main")):
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


def _clip(text: str, limit: int, short: str = "") -> str:
    """A reply kept whole up to `limit` characters; a longer one keeps its start and says how many were cut and where
    the whole reply shows."""
    if len(text) <= limit:
        return text
    where = f"; `claude attach {short}` shows them" if short else ""
    return f"{text[:limit].rstrip()}… ({len(text) - limit:,} more characters{where})"


# --------------------------------------------------------------------------- messages in place


def deliver(c: str, key: str, text: str, by: str) -> dict[str, Any]:
    """Queue `text` for the running session `key`, from `by` (browser, terminal, main, or '' for thimble's own
    nudge); its proxy or else main sends it (module note, messages in place). The queued message."""
    e = entry(c, key)
    if e is None:
        raise RuntimeError(f"no background session {key}")
    item = {"token": f"thimble-message-{secrets.token_hex(4)}", "text": text, "by": by, "ts": time.monotonic(),
            "sent": False, "main_asked": False}
    e.outbox.append(item)
    _changed.set()
    log.info("%s: a message for %s waits in its outbox (%s)", c, e.name, item["token"])
    return item


def _outgoing(item: dict[str, Any]) -> str:
    from . import tools  # noqa: PLC0415

    if item["by"] == agents.BROWSER:
        return tools.hint("bg-from-browser", text=item["text"])
    if item["by"] == agents.TERMINAL:
        return tools.hint("bg-from-terminal", text=item["text"])
    if item["by"] == agents.MAIN_ID:
        return tools.hint("bg-from-main", text=item["text"])
    return str(item["text"])


def _flush_outbox(e: Entry) -> None:
    """A message no proxy took within PROXY_WAIT_S goes to main to send, once."""
    from . import events, tools  # noqa: PLC0415

    now = time.monotonic()
    for item in e.outbox:
        if item["sent"] or item["main_asked"] or now - item["ts"] < PROXY_WAIT_S:
            continue
        if not events.reachable(e.c):
            continue
        item["main_asked"] = True
        with contextlib.suppress(Exception):
            events.post(e.c, "agent", {"text": tools.hint("bg-relay", session=e.name, token=item["token"]), "name": e.name})
            log.info("%s: no proxy took %s's message %s; main is asked to send it", e.c, e.name, item["token"])


def _take(e: Entry, token: str) -> dict[str, Any] | None:
    return next((i for i in e.outbox if i["token"] == token.strip()), None)


def proxy_alive(e: Entry) -> bool:
    return bool(e.proxy_seen) and time.monotonic() - e.proxy_seen < PROXY_ALIVE_S


# --------------------------------------------------------------------------- the proxy


def proxy_file(c: str, key: str) -> Path:
    return config.workspace_dir(c) / PROXY_DIR / f"{key.replace(':', '-')}.md"


def proxy_prompt(c: str, key: str) -> str:
    """The proxy's instructions for the session `key`, written to proxy_file; its path, which main passes as the
    proxy's prompt."""
    from . import tools  # noqa: PLC0415

    e = entry(c, key)
    name = e.name if e is not None else name_of(c, key)
    path = proxy_file(c, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    short = e.short if e is not None else ""
    ledger.atomic_write_text(path, tools.hint("bg-proxy", session=name, short=short) + "\n")
    return str(path)


def proxy_start_hint(c: str, key: str) -> str:
    """The lines that ask main to start the session's proxy, for a tool's result or an event: its Agent call's
    `description`, which the tray entry shows beside the agent's name, is the session's name, as `claude agents` lists
    it."""
    from . import tools  # noqa: PLC0415

    e = entry(c, key)
    name = e.name if e is not None else name_of(c, key)
    if e is not None:
        e.proxy_asked = time.monotonic()
    return tools.hint("bg-proxy-start", type=proxy_type(key), session=name, prompt=proxy_prompt(c, key),
                      short=e.short if e is not None else "")


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
    """A proxy's task ended: while its session runs and has a task (not resting), main is asked for a new one."""
    for e in entries(c):
        if agent_id and agent_id in e.proxy_agents and e.owner in (None, agent_id):
            e.proxy_seen, e.proxy_starting, e.owner = 0.0, 0.0, None
            if alive(e) and not resting(e) and not e.proxy_refused:
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
    """The messages that reached a tray entry of the session, typed in its view or sent by main, which no call passed on
    yet: each goes to the outbox once, so the entry's next wait_session hands it the message's token."""
    got = False
    for uid, text, by in _typed_messages(path) if path is not None else []:
        if uid in e.relayed:
            continue
        e.relayed.append(uid)
        deliver(e.c, e.key, text, by)
        got = True
    if got:
        _save(e.c)


def _fresh(e: Entry, path: Path | None) -> bool:
    """Whether a tray entry's transcript holds a message for the session that is neither passed on nor queued."""
    return any(uid not in e.relayed for uid, _t, _b in (_typed_messages(path) if path is not None else []))


async def wait(c: str, name: str, agent_id: str | None = None, path: Path | None = None) -> str:
    """The `wait_session` tool of the proxy `agent_id` (its transcript at `path`): the session's news, as one block of
    lines to copy, and the outbox's messages, waiting up to WAIT_S for some. While it waits it reads the session's
    transcript every NEWS_POLL_S (_read_news) and returns as soon as there is news, NEWS_GATHER_S after the first line
    so that the lines which come together (a call and its result) come in one answer. One answer holds the oldest
    lines up to NEWS_RETURN_CHARS (at least one); the rest wait for the next call, which returns them at once. The
    messages this proxy, or an earlier one of the session that ended, got for the session go to the outbox first
    (_capture). A second proxy of a session whose proxy is alive is told to stop, and the proxy of a session that ended
    or finished its task is told to end once it has all the news."""
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
    while alive(e) and not finished(e) and not _closing:
        _read_news(e)
        if e.news or _pending_out(e):
            break
        left = deadline - time.monotonic()
        if left <= 0:
            break
        _changed.clear()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(_changed.wait(), min(left, NEWS_POLL_S))
        e.proxy_seen = time.monotonic()
    if e.news and not carried and alive(e) and not _closing:
        await asyncio.sleep(NEWS_GATHER_S)
    _read_news(e)
    e.proxy_seen = time.monotonic()
    n, size = 0, 0
    while n < len(e.news) and (n == 0 or size + len(e.news[n]) + 1 <= NEWS_RETURN_CHARS):
        size += len(e.news[n]) + 1
        n += 1
    news, e.news = e.news[:n], e.news[n:]
    if e.dropped and news:
        news.insert(0, f"… {e.dropped:,} earlier lines are not shown; `claude attach {e.short}` shows them")
    e.dropped = 0
    out = ["\n".join(news), tools.hint("wait_session-copy")] if news else []
    for item in _pending_out(e):
        out.append(tools.hint("wait_session-send", session=e.name, token=item["token"]))
    if not alive(e):
        out.append(tools.hint("wait_session-ended", session=e.name))
        return "\n\n".join(out)
    if finished(e) and not e.news:
        out.append(tools.hint("wait_session-finished", session=e.name))
        return "\n\n".join(out)
    if not out:
        out.append(tools.hint("wait_session-quiet", session=e.name, state=state_words(e)))
    return "\n\n".join([*out, tools.hint("wait_session-rule", session=e.name)])


def _pending_out(e: Entry) -> list[dict[str, Any]]:
    return [i for i in e.outbox if not i["sent"]]


def state_words(e: Entry) -> str:
    if e.status == "stopped":
        return "ended"
    if e.missing_since:
        return "restarting"
    if e.status == "waiting":
        return f"waiting for a {e.waiting_for or 'reply'}"
    if e.status == "idle" or resting(e):
        return "done, idle" if not e.run_open else "idle"
    return "working"


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
    """(uuid, text, sender) of each message a proxy got for its session, from its transcript: those the analyst typed
    in its view (terminal) and those main sent it, since main's SendMessage to the session's name reaches the proxy
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


def relay_check(c: str, agent_path: Path | None, to: str, message: str, agent_id: str | None = None) -> dict[str, Any] | None:
    """A SendMessage about to go to a background session of thimble's (module note, the proxy): the hook's answer,
    {allow, message?, reason?}, or None for a message to anything else. A token becomes its queued message, once. A
    message of main's goes as it is, to the proxy, which passes it on, or straight to the session with its sender
    named. A proxy sends only tokens, to its own session; a message it got and passes on in its own words goes once."""
    e = by_name(c, to, exact=True)
    if e is None:
        return None
    item = _take(e, message)
    if item is not None:
        if item["sent"]:
            return {"allow": False, "reason": "sent already"}
        item["sent"] = True
        _chat_line(e, item["text"], item["by"] or None)
        _changed.set()
        return {"allow": True, "message": _outgoing(item)}
    if message.strip().startswith(TOKEN_PREFIX):
        return {"allow": False, "reason": "no such message waits; call wait_session"}
    mine = proxy_of(c, agent_id, agent_path) if agent_id or agent_path is not None else None
    if mine is None:
        if proxy_alive(e):
            return {"allow": True, "message": message}  # the proxy passes it on, and the session's chat logs it then
        _chat_line(e, message, agents.MAIN_ID)
        from . import tools  # noqa: PLC0415

        return {"allow": True, "message": tools.hint("bg-from-main", text=message)}
    if mine is not e:
        return {"allow": False, "reason": f"you show {mine.name}; send only the tokens wait_session gives you"}
    want = _norm(message.removeprefix(TYPED_PREFIX))
    for uid, text, by in _typed_messages(agent_path) if agent_path is not None else []:
        if uid not in e.relayed and want and (_norm(text) == want or _norm(text) in want):
            e.relayed.append(uid)
            _save(c)
            _chat_line(e, text, by)
            return {"allow": True, "message": _outgoing({"text": text, "by": by})}
    return {"allow": False, "reason": "send only the tokens wait_session gives you; call wait_session"}


def _chat_line(e: Entry, text: str, by: str | None) -> None:
    """A message sent to the session, shown in its chat as its sender's."""
    if not by or not text.strip():
        return
    with contextlib.suppress(Exception):
        agents.Recorder(e.c, e.chat).record("user", text=text.strip(), by=by)


def proxy_stop(c: str, agent_type: str, agent_path: Path | None, active: bool, agent_id: str | None = None) -> str | None:
    """The SubagentStop hook of a proxy: the reason to keep it going while its session works or has news left for it,
    or a message it got waits to be passed on, or None to let it stop."""
    from . import tools  # noqa: PLC0415

    if not agent_type.startswith(f"{_plugin()}:") or agent_path is None:
        return None
    e = proxy_of(c, agent_id, agent_path)
    if e is None or (agent_id and e.owner and agent_id != e.owner and proxy_alive(e)):
        return None
    if (not alive(e) or (finished(e) and not e.news)) and not _fresh(e, agent_path):
        return None
    e.blocks += 1
    if e.blocks > BLOCKS_MAX:
        log.warning("%s: %s's proxy stopped %d times in a row; it may stop", c, e.name, e.blocks)
        return None
    return tools.hint("bg-proxy-keep", session=e.name)


def agent_check(c: str, tool_input: dict[str, Any], tool_use_id: str | None = None) -> str | None:
    """Main's Agent call `tool_use_id`, before it runs: why it must not start (a second proxy of a session whose proxy
    runs or is starting, a second fork of a thread whose fork runs or is starting), or None to let it start."""
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
_own_refusals: set[str] = set()  # the tool_use_ids of the second proxies agent_check refused (proxy_refused)


def fork_ended(c: str, thread_id: str) -> None:
    """A thread's fork stopped, so a new Agent call may fork it again (agent_check)."""
    _forking.pop((c, thread_id), None)


# --------------------------------------------------------------------------- start and the process


class _Empty:
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class BgProc:
    """A background session seen as the process agent_session follows (module note, start). `returncode` is set when
    the run ends: 0 when the session is idle with its turn ended and no background work, 1 when that turn ended on an
    API error, -1 when its process went away, -2 when thimble stopped it."""

    stdin = None

    def __init__(self, c: str, key: str, short: str, session_id: str, pid: int | None, expect: bool = False) -> None:
        self.c, self.key, self.short, self.session_id, self.pid = c, key, short, session_id, pid
        # a message was sent in place, so the run ends only after the session has worked on it (DELIVERY_WAIT_S at most)
        self.expect = expect
        self.since = time.monotonic()
        self.seen_busy = False
        self.returncode: int | None = None
        self.result = ""
        self.result_error = False
        self.api_status: int | None = None
        self.busy: Callable[[], bool] = lambda: False
        self.stdout = _Empty()
        self.stderr = _Empty()
        self._settled = 0
        self._task = asyncio.get_running_loop().create_task(self._poll(), name=f"bg:{short}")

    async def _poll(self) -> None:
        while self.returncode is None:
            await asyncio.sleep(POLL_S)
            try:
                await asyncio.to_thread(self._check)
            except Exception:  # noqa: BLE001
                log.exception("background session %s: a check failed", self.short)

    def _check(self) -> None:
        e = entry(self.c, self.key)
        if e is None or e.status == "stopped":
            self._settled += 1
            if self._settled >= 2:
                self._finish(-1)
            return
        if e.pid:
            self.pid = e.pid
        if e.status != "idle":
            self.seen_busy = True
        waiting = self.expect and not self.seen_busy and time.monotonic() - self.since < DELIVERY_WAIT_S
        ended, text, error, status = turn_state(self.session_id)
        if e.status == "idle" and ended and not self.busy() and not waiting:
            self._settled += 1
            if self._settled >= 2:
                self.result, self.result_error, self.api_status = text, error, status
                self._finish(1 if error else 0)
        else:
            self._settled = 0

    def _finish(self, code: int) -> None:
        if self.returncode is None:
            self.returncode = code

    async def wait(self) -> int:
        while self.returncode is None:
            await asyncio.sleep(POLL_S / 3)
        return self.returncode

    async def stop(self) -> None:
        await asyncio.to_thread(stop_cli, self.short)
        e = entry(self.c, self.key)
        if e is not None:
            e.status = "stopped"
            _save(self.c)
        self._finish(-2)


def turn_state(session_id: str) -> tuple[bool, str, bool, int | None]:
    """(the transcript's last turn has ended, its last reply's text, that reply was an API error, its HTTP status)."""
    found = session.find_transcript(session_id)
    if not found:
        return False, "", False, None
    ended, text, error, status = False, "", False, None
    try:
        with Path(found).open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            lines = f.read().splitlines()[1 if size > TAIL_BYTES else 0:]
    except OSError:
        return False, "", False, None
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        t = rec.get("type")
        if t == "system" and rec.get("subtype") == "turn_duration":
            ended = True
        elif t == "user" and not rec.get("isMeta") and not rec.get("toolUseResult"):
            content = (rec.get("message") or {}).get("content") if isinstance(rec.get("message"), dict) else None
            if not (isinstance(content, list) and content and all(isinstance(b, dict) and b.get("type") == "tool_result"
                                                                     for b in content)):
                ended = False
        elif t == "assistant":
            blocks = (rec.get("message") or {}).get("content") or []
            said = " ".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
            if said.strip():
                text, error = said.strip(), bool(rec.get("isApiErrorMessage"))
                code = rec.get("apiErrorStatus") or (rec.get("error") or {}).get("status") if error else None
                status = int(code) if isinstance(code, int) else None
    return ended, text, error, status


async def start(c: str, key: str, argv: list[str], folder: Path, env: dict[str, str], prompt: str,
                resume: str | None, chat: str, role: str) -> BgProc:
    """The background session for the `claude -p` argv `argv` (module note, start): a new one, the running session
    `resume` attached to with `prompt` delivered in place (none when empty), or `resume` started again with its flags
    when its process has gone."""
    bin_ = argv[0]
    if shutil.which(bin_, path=env.get("PATH")) is None:
        raise RuntimeError(f"could not start `{bin_}`")
    rows = await asyncio.to_thread(listing, bin_, env)
    if resume:
        running = next((r for r in rows if str(r.get("sessionId") or "") == resume and r.get("pid")), None)
        if running is not None:
            short = str(running.get("id") or resume[:8])
            e = record(c, key, short=short, sid=resume, chat=chat, role=role, folder=folder, status=_status(running),
                       name=str(running.get("name") or ""))
            if prompt.strip():
                deliver(c, key, prompt, "")
            log.info("%s: attached to background session %s (%s) of %s", c, short, resume, key)
            return BgProc(c, key, short, resume, int(running["pid"]), expect=bool(prompt.strip()))
        known = session.find_transcript(resume)
        before = session._size(Path(known)) if known else 0  # where the news of this start begins (record)
        args = bg_argv(argv, env, name_of(c, key), prompt.strip() or _nudge(), folder)
        args[2:2] = ["--resume", resume]
        code, out = await asyncio.to_thread(_cli, bin_, args[1:], env, folder, CLI_TIMEOUT_S)
    else:
        before = 0
        code, out = await asyncio.to_thread(_cli, bin_, bg_argv(argv, env, name_of(c, key), prompt, folder)[1:], env,
                                            folder, CLI_TIMEOUT_S)
    if code != 0 and UNTRUSTED_RE.search(out):
        from . import tools  # noqa: PLC0415

        raise RuntimeError(tools.hint("bg-untrusted", workspaces=str(config.WORKSPACES_DIR)))
    if code != 0:
        raise RuntimeError(f"`claude --bg` failed (exit {code}): {out.strip()[-400:]}")
    m = BG_ID_RE.search(out)
    short = m.group(1) if m else (resume or "")[:8]
    for _ in range(IDENTIFY_TRIES):
        hit = next((r for r in await asyncio.to_thread(listing, bin_, env) if r.get("id") == short and _names_itself(r)),
                   None)
        if hit and hit.get("sessionId"):
            sid = str(hit["sessionId"])
            copy = bool(resume and sid != resume)
            if copy:
                log.warning("%s: %s was started again as a copy, %s (%s)", c, key, short, sid)
            # a copy's transcript holds the history it copied, whose length is not known here: its news starts now
            e = record(c, key, short=short, sid=sid, chat=chat, role=role, folder=folder,
                       offset=None if copy else before, name=str(hit.get("name") or ""))
            e.prompts = [*e.prompts, _norm(prompt.strip() or _nudge())[:PROMPT_KEY]][-HEARD_KEEP:]  # _message
            log.info("%s: background session %s (%s) %s for %s", c, short, sid, "resumed" if resume else "started", key)
            return BgProc(c, key, short, sid, hit.get("pid"))
        await asyncio.sleep(1)
    raise RuntimeError("the background session did not appear in `claude agents`")


def _nudge() -> str:
    from . import tools  # noqa: PLC0415

    return tools.hint("bg-carry-on")


# --------------------------------------------------------------------------- what the terminal lists


def statusline_command(own: str = "") -> str:
    """The statusline command the launcher passes to main: plugin/bin/thimble-agents, which lists thimble's agents
    (agents_route), chained to the analyst's statusline command `own`."""
    import shlex  # noqa: PLC0415

    from . import agent_session  # noqa: PLC0415

    cmd = f"{shlex.quote(str(agent_session.PLUGIN_DIR / 'bin' / 'thimble-agents'))} --statusline"
    return f"{cmd} --chain {shlex.quote(own)}" if own else cmd


def agent_rows(c: str) -> list[dict[str, Any]]:
    """Every thimble agent running in the workspace, for the statusline and /thimble:agents: background sessions, the
    code ticket and view builds (dev.py), and the subagents and threads of main (session.py), each {name, label?,
    state, kind}: `name` as Claude Code knows it, `label` as /thimble:agents lists it (by `name` without one)."""
    from . import dev  # noqa: PLC0415 — dev imports the views module, which imports this one's callers

    rows: list[dict[str, Any]] = []
    for e in entries(c):
        if not alive(e):
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
    mark = {"working": "●", "waiting": "◐", "restarting": "◐"}
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
    """A row's state as /thimble:agents lists it: working, waiting for you, done or restarting."""
    first = state.split()[0].rstrip(",") if state else ""
    if first == "waiting":
        return "waiting for you"
    return {"done": "done", "idle": "done", "ended": "done", "restarting": "restarting"}.get(first, "working")


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
    """thimble's agents for the folder's workspace: `{rows, line, text}` for the statusline and /thimble:agents, and with `announce` the lines main's terminal has not shown yet (the plugin's hooks print them):
    each session's start once and each run's finish."""
    c = config.workspace_for_cwd(body.cwd)
    if not c:
        return {"rows": [], "line": "", "text": "", "announce": ""}
    rows = agent_rows(c)
    lines: list[str] = []
    if body.announce:
        started, finished = _announced_of(c, body.session or "")
        for e in entries(c):
            if alive(e) and e.short not in started:
                started.add(e.short)
                finished.setdefault(e.short, e.ended_at if not e.run_open else 0.0)
                lines.append(f"{label_of(e.key)} started: ↓ to follow it")
            elif e.short in started and e.ended_at and finished.get(e.short) != e.ended_at and not e.run_open:
                finished[e.short] = e.ended_at
                lines.append(f"{label_of(e.key)} finished" + (f": {cite.prose(e.result)[:200]}" if e.result else "") +
                             ("" if alive(e) else " (it has stopped)"))
        if lines:
            _save_announced(c)
    return {"rows": rows, "line": status_line(rows), "text": listing_text(rows), "announce": "\n".join(lines)}


class RelayBody(BaseModel):
    cwd: str
    agent_id: str | None = None
    agent_type: str | None = None
    transcript_path: str | None = None
    to: str = ""
    message: str = ""


def _agent_file(transcript_path: str | None, agent_id: str | None) -> Path | None:
    if not transcript_path or not agent_id:
        return None
    main = Path(transcript_path)
    path = main.parent / main.stem / "subagents" / f"agent-{agent_id}.jsonl"
    return path if path.is_file() else None


@router.post("/bg/relay")
async def relay_route(body: RelayBody) -> dict[str, Any]:
    """The PreToolUse hook before a SendMessage (relay_check): `{decision}` of allow with the message to send, deny with
    why, or none for a message to anything else."""
    c = config.workspace_for_cwd(body.cwd)
    if not c:
        return {"decision": None}
    got = relay_check(c, _agent_file(body.transcript_path, body.agent_id), body.to, body.message, body.agent_id)
    if got is None:
        return {"decision": None}
    return {"decision": "allow" if got["allow"] else "deny", "message": got.get("message"), "reason": got.get("reason")}


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


async def recover() -> list[str]:
    """Server start: every background session a previous server followed is found again. One whose process runs is
    followed again by its caller (on_wake), so its chat keeps mirroring; one whose process has gone leaves its chat
    stopped, with Resume."""
    from . import agent_session  # noqa: PLC0415

    found: list[str] = []
    root = config.WORKSPACES_DIR
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if not folder.is_dir() or folder.name.startswith(".") or not (folder / REGISTRY_FILE).is_file():
            continue
        c = folder.name
        try:
            _load(c)
        except Exception:  # noqa: BLE001
            continue
    if not entries():
        return found
    rows = await asyncio.to_thread(listing)
    by_id = {str(r.get("id") or ""): r for r in rows if _names_itself(r)}
    for e in entries():
        if e.status == "stopped":
            continue
        hit = by_id.get(e.short)
        if hit is None or (not hit.get("pid") and str(hit.get("state") or "") in ENDED_STATES):
            e.status = "stopped"
            _save(e.c)
            _stopped_while_idle(e)
            continue
        if not hit.get("pid"):
            e.missing_since = time.monotonic()  # being restarted: the watcher follows it once its process is back
            continue
        fn = _wake.get(kind_of(e.key))
        if fn is None or agent_session.current(e.c, e.key) is not None:
            continue
        meta = agents.meta_or_none(e.c, e.chat) or {}
        if meta.get("status") != "running":
            if _status(hit) == "idle" or (await asyncio.to_thread(turn_state, e.sid))[0]:
                # its last run ended, and it is idle or runs only background shells: the watcher follows it again when
                # its transcript shows another turn
                continue
        e.run_open = True
        if await _woken(fn, e):
            found.append(f"{e.c}/{e.name}")
    _ensure_watcher()
    return found


async def shutdown() -> None:
    global _task, _closing
    _closing = True
    _changed.set()
    if _task is not None:
        _task.cancel()
        _task = None
