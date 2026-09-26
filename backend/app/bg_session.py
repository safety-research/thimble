"""thimble's agents as Claude Code background sessions (`claude --bg`), for a workspace in terminal-first mode: the
writers, the orientation's critique, and the orientation when Settings has it run as a background session. The analyst
sees each in `claude agents`, in the agent view (←) and at the bottom of main's terminal, and can attach to it, answer
its permission prompts there and message it.

Names. Each session is named for Claude Code as `thimble:<role>` (name_of): thimble:orient, thimble:writer (the
report's; another document's is thimble:writer-<doc>) and thimble:critic.

Start. agent_session builds the `claude -p` command as for any session and hands it to start(), which turns it into a
`claude --bg` command: the first message goes on the command line, and the session's own environment goes in the
--settings `env`, since the background service starts the session with its own environment. `claude --bg` refuses a
folder Claude Code does not trust, so a work folder under thimble's workspaces gets that folder trusted first
(trust_workspaces). BgProc stands in for the process agent_session follows: a run ends when the session is idle, its
transcript's last turn has ended and it has no background work, while the session itself goes on for the analyst.

Messages in place. A session that runs is never resumed with `--resume`, which would copy it under a new id: a message
for it (a follow-up from the browser, a retry after a capacity failure) waits in its outbox (deliver) and is sent with
SendMessage by the proxy subagent that shows the session in main's agent tray, or, without a live proxy within
PROXY_WAIT_S, by main. Only a session whose process has gone is started again, with `claude --bg --resume <id>`, which
keeps its id; a copy under a new id is recorded as the session's new id.

The proxy. For each session main runs a thin background subagent of the plugin (plugin/agents: thimble:orient,
thimble:writer, thimble:critic), which reads its instructions from proxy_file and loops on the `wait_session` tool for
the session's life: the tool returns the session's news (its replies, its state, the end) and the outbox's messages as
tokens. Two plugin hooks keep it reliable: before a SendMessage (relay_check) the server swaps a token for its message,
prefixes a message the analyst typed in the proxy's view, and refuses a message sent twice; when the proxy would stop
while its session runs (proxy_stop), the hook sends it back to waiting.

The watcher. One task per server lists `claude agents` every POLL_S for every session known here (REGISTRY_FILE keeps
them across restarts): a session whose process has gone ends stopped; one that starts a turn with no run of thimble's
(a message typed in its terminal or in the proxy's view, or main's SendMessage) is followed again as a new run of its
chat (on_wake); its state and replies become the proxy's news, the statusline's line and the /thimble:agents list
(agents_route).
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
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import APIRouter
from pydantic import BaseModel

from . import agents, config, ledger, session

log = logging.getLogger("thimble.bg_session")
router = APIRouter()

PREFIX = "thimble:"
ORIENT_ROUTE_KEY = "orient_route"  # settings.json: how the orientation runs in terminal-first mode
ROUTE_SUBAGENT, ROUTE_SESSION = "subagent", "session"
REGISTRY_FILE = "bg-sessions.json"  # in the workspace: the background sessions thimble started
PROXY_DIR = "bg"  # in the workspace: each proxy's instructions (proxy_file)
POLL_S = 1.5
WAIT_S = 15.0  # the longest a wait_session call waits for news
PROXY_WAIT_S = 20.0  # how long a message waits for the proxy before main is asked to send it
PROXY_ALIVE_S = 90.0  # a proxy that has not called wait_session for this long is taken for gone
PROXY_ASK_S = 120.0  # how long main's start of a proxy is waited for before main is asked again
IDENTIFY_TRIES = 20
CLI_TIMEOUT_S = 60
MAX_ARG = 100_000  # bytes of a first message kept on the command line; a longer one goes through a file
FIRST_MESSAGE_FILE = ".thimble-first-message.md"
NEWS_CHARS = 1_500  # of one reply of the session, as the proxy shows it
BLOCKS_MAX = 12  # stops of a proxy refused in a row with no wait_session between them, after which it may stop
GONE_AFTER = 3  # listings in a row without its process after which a session counts as ended
START_GRACE_S = 20.0  # a session this young is never taken for ended
DELIVERY_WAIT_S = 300.0  # how long a run attached with a message waits for the session to take it up
TAIL_BYTES = 524_288  # of a transcript's end, read for its last turn (turn_state)
BG_ID_RE = re.compile(r"backgrounded\W+([0-9a-f]{8})\b")
DROP_FLAGS = {"-p", "--print", "--verbose"}
DROP_WITH_VALUE = {"--output-format", "--session-id", "--input-format"}
PASSED_ENV = {"PATH"}  # what the background service takes from the caller's environment
# the plugin agent that shows each kind of session in the agent tray (plugin/agents)
PROXY_TYPES = {"orient": "orient", "writer": "writer", "critique": "critic"}
TYPED_PREFIX = "From the analyst, typed in Claude Code's agent tray:"


def _plugin() -> str:
    from . import orientation  # noqa: PLC0415 — orientation imports this module's callers

    return orientation.PLUGIN


# --------------------------------------------------------------------------- which route


def terminal_first(c: str) -> bool:
    from . import orientation  # noqa: PLC0415

    return orientation.terminal_first(c)


def orient_route(c: str) -> str:
    """How the orientation runs in terminal-first mode: as a subagent of main (the default) or a background session."""
    try:
        value = ledger.stored_settings(c).get(ORIENT_ROUTE_KEY)
    except Exception:  # noqa: BLE001 — a workspace whose settings cannot be read runs the default route
        return ROUTE_SUBAGENT
    return ROUTE_SESSION if value == ROUTE_SESSION else ROUTE_SUBAGENT


def wanted(c: str, kind: str) -> bool:
    """Whether a session of `kind` (orient, writer, critique) runs as a background session in workspace `c`."""
    if not terminal_first(c):
        return False
    if kind == "orient":
        return orient_route(c) == ROUTE_SESSION
    return kind in ("writer", "critique")


def kind_of(key: str) -> str:
    return key.split(":", 1)[0]


def name_of(key: str) -> str:
    """The session's name in Claude Code: thimble:orient, thimble:writer (the report's), thimble:writer-<doc>,
    thimble:critic."""
    kind, _, rest = key.partition(":")
    if kind == "writer":
        return f"{PREFIX}writer" if rest in ("", "report") else f"{PREFIX}writer-{rest}"
    return PREFIX + PROXY_TYPES.get(kind, kind)


def tray_label(key: str) -> str:
    """How the session's tray entry describes it, beside its agent's name: `writing report`, `orientation session`,
    `critique`."""
    kind, _, rest = key.partition(":")
    if kind == "writer":
        return f"writing {rest or 'report'}"
    return "orientation session" if kind == "orient" else "critique" if kind == "critique" else kind


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
    from . import agent_session  # noqa: PLC0415

    return agent_session.environ("")


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


# --------------------------------------------------------------------------- trust


def global_config_path(env: dict[str, str] | None = None) -> Path:
    """Claude Code's global config file, which holds each folder's trust: `$CLAUDE_CONFIG_DIR/.claude.json`, else
    ~/.claude.json."""
    value = (env or os.environ).get(config.CONFIG_DIR_ENV) or config.claude_config_env()
    return Path(value) / ".claude.json" if value else Path.home() / ".claude.json"


def trusted(folder: Path, data: dict[str, Any]) -> bool:
    projects = data.get("projects") if isinstance(data.get("projects"), dict) else {}
    for f in (folder, *folder.parents):
        entry = projects.get(str(f))
        if isinstance(entry, dict) and entry.get("hasTrustDialogAccepted") is True:
            return True
    return False


def trust_workspaces(folder: Path, env: dict[str, str] | None = None) -> bool:
    """Have Claude Code trust `folder`, a work folder under thimble's workspaces, so `claude --bg` starts there: the
    workspaces folder is marked trusted in the global config unless a folder above `folder` is. True when it is
    trusted; False for a folder outside the workspaces, which stays the analyst's to trust."""
    folder = folder.resolve()
    root = config.WORKSPACES_DIR.resolve()
    path = global_config_path(env)
    try:
        data = json.loads(path.read_text("utf-8")) if path.is_file() else {}
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    if trusted(folder, data):
        return True
    if not folder.is_relative_to(root):
        return False
    projects = data.setdefault("projects", {})
    entry = projects.setdefault(str(root), {})
    if not isinstance(entry, dict):
        return False
    entry["hasTrustDialogAccepted"] = True
    try:
        ledger.atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False))
    except OSError:
        log.warning("could not mark %s trusted in %s", root, path, exc_info=True)
        return False
    log.info("marked thimble's workspaces folder %s trusted in %s", root, path)
    return True


# --------------------------------------------------------------------------- the command


def bg_argv(argv: list[str], env: dict[str, str], base_env: dict[str, str], name: str, prompt: str,
            folder: Path) -> list[str]:
    """The `claude --bg` argv for the `claude -p` argv `argv`, named `name`, with `prompt` as the first message and the
    variables `env` adds to `base_env` in its --settings `env` (module note, start)."""
    out: list[str] = [argv[0], "--bg", "-n", name]
    extra_env = {k: v for k, v in env.items() if k not in PASSED_ENV | {config.CONFIG_DIR_ENV}
                 and (k.startswith("THIMBLE_") or base_env.get(k) != v)}
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
    outbox: list[dict[str, Any]] = field(default_factory=list)
    proxy_seen: float = 0.0  # time.monotonic() of the proxy's last wait_session call
    proxy_asked: float = 0.0  # time.monotonic() when main was last asked to start the proxy
    proxy_agents: list[str] = field(default_factory=list)  # agent ids of the proxies main started for it
    relayed: list[str] = field(default_factory=list)  # typed messages' uuids already sent, and tokens already sent
    blocks: int = 0  # stops of its proxy refused since its last wait_session
    owner: str | None = None  # the agent id of the proxy that shows it; another one is told to stop (wait)
    replacing: bool = False  # a new session of its key is starting in its place, which its proxy goes on to show
    misses: int = 0  # listings in a row that showed no process for it

    KEEP = ("c", "key", "name", "short", "sid", "chat", "role", "folder", "started", "status", "run_open", "result",
            "ended_at", "proxy_agents", "relayed")

    def saved(self) -> dict[str, Any]:
        d = asdict(self)
        return {k: d[k] for k in self.KEEP}


_entries: dict[tuple[str, str], Entry] = {}  # (workspace, key) -> the session
_loaded: set[str] = set()
_wake: dict[str, Callable[[str, Entry], Awaitable[Any]]] = {}  # kind -> the caller that follows a woken session
_changed = asyncio.Event()  # set on each news line, state change and outbox message, for wait_session
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


def by_name(c: str, name: str) -> Entry | None:
    want = str(name or "").strip().lower()
    return next((e for e in entries(c) if want in (e.name.lower(), e.key.lower(), e.short)), None)


def alive(e: Entry | None) -> bool:
    return e is not None and (e.status != "stopped" or e.replacing)


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
           status: str = "working") -> Entry:
    """A session thimble started or attached to, followed from now on by the watcher."""
    _load(c)
    old = _entries.get((c, key))
    e = old if old is not None and old.short == short else Entry(c, key, name_of(key), short, sid, chat, role, str(folder))
    if old is not None and old is not e:
        e.proxy_agents, e.proxy_seen, e.outbox = old.proxy_agents, old.proxy_seen, old.outbox
    e.sid, e.chat, e.status, e.run_open = sid, chat, status, True
    e.started, e.misses = time.time(), 0
    path = session.find_transcript(sid)
    if old is None or old.short != short:
        e.offset = session._size(Path(path)) if path else 0
    _entries[(c, key)] = e
    _save(c)
    _ensure_watcher()
    return e


def run_ended(c: str, key: str, summary: str) -> None:
    """The run of thimble's that followed the session ended; the session itself goes on until its process does."""
    e = entry(c, key)
    if e is None:
        return
    e.run_open = False
    e.result = " ".join(str(summary or "").split())[:400]
    e.ended_at = time.time()
    _news(e, f"{e.name} finished its task" + (f": {e.result}" if e.result else "."))
    _save(c)


def forget(c: str, key: str) -> None:
    if _entries.pop((c, key), None) is not None:
        _save(c)


def _news(e: Entry, line: str) -> None:
    e.news.append(line)
    _changed.set()


# --------------------------------------------------------------------------- the watcher


def _ensure_watcher() -> None:
    global _task
    if _task is not None and not _task.done():
        return
    with contextlib.suppress(RuntimeError):
        _task = asyncio.get_running_loop().create_task(_watch(), name="bg-sessions")


async def _watch() -> None:
    while any(alive(e) for e in entries()):
        try:
            rows = await asyncio.to_thread(listing)
            await _tick(rows)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — the watcher never stops for one bad pass
            log.exception("the background sessions' watcher failed a pass")
        await asyncio.sleep(POLL_S)


async def _tick(rows: list[dict[str, Any]]) -> None:
    from . import agent_session  # noqa: PLC0415

    by_id = {str(r.get("id") or ""): r for r in rows if _names_itself(r)}
    for e in entries():
        if not alive(e):
            continue
        hit = by_id.get(e.short)
        before = (e.status, e.waiting_for)
        if e.replacing:
            continue
        if hit is None or not hit.get("pid"):
            e.misses += 1
            if e.misses < GONE_AFTER or time.time() - e.started < START_GRACE_S:
                continue  # a session just started, or restarted, may be listed without its process for a moment
            e.status, e.waiting_for, e.pid = "stopped", "", None
            _news(e, f"{e.name} has ended.")
            _save(e.c)
            if agent_session.current(e.c, e.key) is None:
                _stopped_while_idle(e)
            continue
        e.misses = 0
        e.pid = int(hit["pid"])
        e.status = _status(hit)
        e.waiting_for = str(hit.get("waitingFor") or "") if e.status == "waiting" else ""
        if (e.status, e.waiting_for) != before:
            if e.status == "waiting":
                _news(e, f"{e.name} waits for a {e.waiting_for or 'reply'}; answer it in the browser or with "
                         f"`claude attach {e.short}`.")
            _changed.set()
        _read_news(e)
        if not proxy_alive(e) and time.monotonic() - e.proxy_asked > PROXY_ASK_S:
            if ask_main_for_proxy(e.c, e.key):
                log.info("%s: main is asked to show %s in the agent tray", e.c, e.name)
        if e.status != "idle" and not e.run_open and agent_session.current(e.c, e.key) is None:
            fn = _wake.get(kind_of(e.key))
            if fn is not None:
                e.run_open = True
                log.info("%s: background session %s (%s) started a turn; following it again", e.c, e.name, e.short)
                asyncio.get_running_loop().create_task(_woken(fn, e), name=f"bg-wake:{e.c}:{e.key}")
        _flush_outbox(e)


async def _woken(fn: Callable[[str, Entry], Awaitable[Any]], e: Entry) -> None:
    try:
        await fn(e.c, e)
    except Exception:  # noqa: BLE001
        e.run_open = False
        log.exception("%s: background session %s could not be followed again", e.c, e.name)


def _stopped_while_idle(e: Entry) -> None:
    """The process of a session with no run open went away (claude stop, a crash): its chat says it stopped."""
    from . import agent_session  # noqa: PLC0415

    with contextlib.suppress(Exception):
        meta = agents.meta_or_none(e.c, e.chat)
        if meta is not None and meta.get("status") == "running":
            agents.finish_agent(e.c, e.chat, "stopped", e.result or None)
        if meta is not None:
            agents.update_agent(e.c, e.chat, alert={**agent_session.STOPPED_ALERT, "since": _iso_now()})


def _iso_now() -> str:
    from datetime import datetime, timezone  # noqa: PLC0415

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_news(e: Entry) -> None:
    """The session's replies since the last read, as the proxy's news."""
    path = session.find_transcript(e.sid)
    if not path:
        return
    p = Path(path)
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
        if b'"assistant"' not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get("message") if isinstance(rec, dict) and rec.get("type") == "assistant" else None
        for b in (msg or {}).get("content") or [] if isinstance(msg, dict) else []:
            if isinstance(b, dict) and b.get("type") == "text":
                text = session.visible(str(b.get("text") or "")).strip()
                if text:
                    _news(e, f"{e.name}: {text[:NEWS_CHARS]}{'…' if len(text) > NEWS_CHARS else ''}")


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
    return str(item["text"])


def _flush_outbox(e: Entry) -> None:
    """A message no proxy took within PROXY_WAIT_S goes to main to send, once."""
    from . import channel, tools  # noqa: PLC0415

    now = time.monotonic()
    for item in e.outbox:
        if item["sent"] or item["main_asked"] or now - item["ts"] < PROXY_WAIT_S:
            continue
        if not channel.reachable(e.c):
            continue
        item["main_asked"] = True
        with contextlib.suppress(Exception):
            channel.post(e.c, "agent", {"text": tools.hint("bg-relay", session=e.name, token=item["token"]), "name": e.name})
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
    name = e.name if e is not None else name_of(key)
    path = proxy_file(c, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    short = e.short if e is not None else ""
    ledger.atomic_write_text(path, tools.hint("bg-proxy", session=name, short=short) + "\n")
    return str(path)


def proxy_start_hint(c: str, key: str) -> str:
    """The lines that ask main to start the session's proxy, for a tool's result or an event."""
    from . import tools  # noqa: PLC0415

    e = entry(c, key)
    name = e.name if e is not None else name_of(key)
    if e is not None:
        e.proxy_asked = time.monotonic()
    return tools.hint("bg-proxy-start", type=proxy_type(key), session=name, label=tray_label(key), prompt=proxy_prompt(c, key),
                      short=e.short if e is not None else "")


def ask_main_for_proxy(c: str, key: str) -> bool:
    """Ask main, with an `agent` event, to start the session's proxy; False when no session listens."""
    from . import channel  # noqa: PLC0415

    e = entry(c, key)
    if e is None or not channel.reachable(c):
        return False
    try:
        channel.post(c, "agent", {"text": proxy_start_hint(c, key), "name": e.name})
    except Exception:  # noqa: BLE001
        log.info("%s: main was not asked to start %s's proxy", c, e.name, exc_info=True)
        return False
    return True


def _proxy_key(c: str, prompt_path: str) -> str | None:
    for e in entries(c):
        if str(proxy_file(c, e.key)) in prompt_path:
            return e.key
    return None


def _by_tray(c: str, agent_type: Any, description: Any) -> Entry | None:
    kind = str(agent_type or "").strip().rsplit(":", 1)[-1]
    desc = str(description or "").strip()
    if kind not in PROXY_TYPES.values() or not desc:
        return None
    return next((e for e in entries(c) if PROXY_TYPES.get(kind_of(e.key)) == kind
                 and desc in (tray_label(e.key), e.name)), None)


def is_proxy(c: str, agent_type: Any, description: Any) -> bool:
    """Whether an Agent call starts a proxy: a plugin agent of PROXY_TYPES described as a session's tray entry
    (tray_label)."""
    return _by_tray(c, agent_type, description) is not None


def proxy_started(c: str, agent_type: str, description: str, agent_id: str | None) -> None:
    """Main started (or the mirror found) the proxy described as a session's tray entry."""
    e = _by_tray(c, agent_type, description)
    if e is None:
        return
    e.proxy_seen = time.monotonic()
    if agent_id and agent_id not in e.proxy_agents:
        e.proxy_agents.append(agent_id)
        _save(c)


def proxy_ended(c: str, agent_id: str | None) -> None:
    """A proxy's task ended: while its session runs, main is asked for a new one."""
    for e in entries(c):
        if agent_id and agent_id in e.proxy_agents and e.owner in (None, agent_id):
            e.proxy_seen, e.owner = 0.0, None
            if alive(e):
                log.info("%s: %s's proxy %s ended while its session runs; main is asked for another", c, e.name, agent_id)
                ask_main_for_proxy(c, e.key)


async def wait(c: str, name: str, agent_id: str | None = None) -> str:
    """The `wait_session` tool of the proxy `agent_id`: the session's news and the outbox's messages, waiting up to
    WAIT_S for some. A second proxy of a session whose proxy is alive is told to stop."""
    from . import tools  # noqa: PLC0415

    e = by_name(c, name)
    if e is None:
        return tools.hint("wait_session-none", session=name)
    if agent_id and e.owner and e.owner != agent_id and proxy_alive(e):
        log.info("%s: a second tray entry of %s (%s) is told to stop", c, e.name, agent_id)
        return tools.hint("wait_session-duplicate", session=e.name)
    if agent_id:
        e.owner = agent_id
    e.proxy_seen = time.monotonic()
    e.blocks = 0
    deadline = time.monotonic() + WAIT_S
    while not e.news and not _pending_out(e) and alive(e) and not _closing:
        _changed.clear()
        left = deadline - time.monotonic()
        if left <= 0:
            break
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(_changed.wait(), min(left, POLL_S))
        e.proxy_seen = time.monotonic()
    lines, e.news = list(e.news), []
    out = [ln for ln in lines]
    for item in _pending_out(e):
        out.append(tools.hint("wait_session-send", session=e.name, token=item["token"]))
    if not alive(e):
        out.append(tools.hint("wait_session-ended", session=e.name))
    elif not out:
        out.append(tools.hint("wait_session-quiet", session=e.name, state=state_words(e)))
    return "\n\n".join(out)


def _pending_out(e: Entry) -> list[dict[str, Any]]:
    return [i for i in e.outbox if not i["sent"]]


def state_words(e: Entry) -> str:
    if e.status == "stopped":
        return "ended"
    if e.status == "waiting":
        return f"waiting for a {e.waiting_for or 'reply'}"
    if e.status == "idle":
        return "done, idle" if not e.run_open else "idle"
    return "working"


async def tool_wait_session(ctx: Any, args: dict[str, Any]) -> Any:
    from . import tools  # noqa: PLC0415

    agent_id = await session.caller_agent(ctx.c, ctx.tool_use_id)
    return tools.ok(await wait(ctx.c, str(args.get("session") or ""), agent_id))


async def tool_list_agents(ctx: Any, args: dict[str, Any]) -> Any:
    """The `list_agents` tool (/thimble:agents): thimble's running agents, answered by this server."""
    from . import tools  # noqa: PLC0415

    return tools.ok(tools.hint("agents-print", text=listing_text(agent_rows(ctx.c))))


# --------------------------------------------------------------------------- the hooks


def _typed_messages(path: Path) -> list[tuple[str, str]]:
    """(uuid, text) of each message the analyst typed in a subagent's view, from its transcript."""
    out: list[tuple[str, str]] = []
    try:
        lines = path.read_bytes().splitlines()
    except OSError:
        return out
    for line in lines:
        if b"queued_command" not in line and b'"human"' not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        typed = session._typed(rec) if isinstance(rec, dict) else None
        if typed:
            att = rec.get("attachment") if isinstance(rec.get("attachment"), dict) else {}
            out.append((str(att.get("source_uuid") or rec.get("uuid") or typed), typed))
    return out


def _norm(text: str) -> str:
    return " ".join(str(text or "").split()).lower()


def relay_check(c: str, agent_path: Path | None, to: str, message: str) -> dict[str, Any] | None:
    """A SendMessage about to go to a background session of thimble's (module note, the proxy): the hook's answer,
    {allow, message?, reason?}, or None for a message to anything else. A token becomes the queued message; a message
    the analyst typed in the proxy's view goes once, prefixed; any other message is refused as sent already."""
    e = by_name(c, to)
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
    if message.strip().startswith("thimble-message-"):
        return {"allow": False, "reason": "no such message waits; call wait_session"}
    typed = _typed_messages(agent_path) if agent_path is not None else []
    fresh = [(u, t) for u, t in typed if u not in e.relayed]
    want = _norm(message.removeprefix(TYPED_PREFIX))
    hit = next(((u, t) for u, t in fresh if _norm(t) == want or _norm(t) in want), None)
    if hit is None and fresh and not any(_norm(t) == want for u, t in typed if u in e.relayed):
        hit = fresh[0]
    if hit is None:
        if agent_path is None:  # main's own message
            _chat_line(e, message, agents.MAIN_ID)
            return {"allow": True, "message": message}
        return {"allow": False, "reason": "sent already"}
    e.relayed.append(hit[0])
    _save(c)
    _chat_line(e, hit[1], agents.TERMINAL)
    from . import tools  # noqa: PLC0415

    return {"allow": True, "message": tools.hint("bg-from-terminal", text=hit[1])}


def _chat_line(e: Entry, text: str, by: str | None) -> None:
    """A message sent to the session, shown in its chat as its sender's."""
    if not by or not text.strip():
        return
    with contextlib.suppress(Exception):
        agents.Recorder(e.c, e.chat).record("user", text=text.strip(), by=by)


def proxy_stop(c: str, agent_type: str, agent_path: Path | None, active: bool, agent_id: str | None = None) -> str | None:
    """The SubagentStop hook of a proxy: the reason to keep it going while its session runs, or None to let it stop."""
    from . import tools  # noqa: PLC0415

    if not agent_type.startswith(f"{_plugin()}:") or agent_path is None:
        return None
    try:
        head = agent_path.read_text("utf-8", errors="replace")[:20_000]
    except OSError:
        return None
    key = next((e.key for e in entries(c) if str(proxy_file(c, e.key)) in head), None)
    e = entry(c, key) if key else None
    if e is None or not alive(e) or (agent_id and e.owner and agent_id != e.owner):
        return None
    e.blocks += 1
    if e.blocks > BLOCKS_MAX:
        log.warning("%s: %s's proxy stopped %d times in a row; it may stop", c, e.name, e.blocks)
        return None
    return tools.hint("bg-proxy-keep", session=e.name)


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
    `resume` attached to with `prompt` delivered in place (none when empty), or `resume` started again under its id
    when its process has gone."""
    bin_ = argv[0]
    if shutil.which(bin_, path=env.get("PATH")) is None:
        raise RuntimeError(f"could not start `{bin_}`")
    if not trust_workspaces(folder, env):
        from . import tools  # noqa: PLC0415

        raise RuntimeError(tools.hint("bg-untrusted", folder=str(folder)))
    rows = await asyncio.to_thread(listing, bin_, env)
    if resume:
        running = next((r for r in rows if str(r.get("sessionId") or "") == resume and r.get("pid")), None)
        if running is not None:
            short = str(running.get("id") or resume[:8])
            e = record(c, key, short=short, sid=resume, chat=chat, role=role, folder=folder, status=_status(running))
            if prompt.strip():
                deliver(c, key, prompt, "")
            log.info("%s: attached to background session %s (%s) of %s", c, short, resume, key)
            return BgProc(c, key, short, resume, int(running["pid"]), expect=bool(prompt.strip()))
        args = [bin_, "--bg", "--resume", resume, "--", prompt.strip() or _nudge()]
        code, out = await asyncio.to_thread(_cli, bin_, args[1:], env, folder, CLI_TIMEOUT_S)
    else:
        code, out = await asyncio.to_thread(_cli, bin_, bg_argv(argv, env, dict(os.environ), name_of(key), prompt,
                                                                folder)[1:], env, folder, CLI_TIMEOUT_S)
    if code != 0:
        raise RuntimeError(f"`claude --bg` failed (exit {code}): {out.strip()[-400:]}")
    m = BG_ID_RE.search(out)
    short = m.group(1) if m else (resume or "")[:8]
    for _ in range(IDENTIFY_TRIES):
        hit = next((r for r in await asyncio.to_thread(listing, bin_, env) if r.get("id") == short and _names_itself(r)),
                   None)
        if hit and hit.get("sessionId"):
            sid = str(hit["sessionId"])
            if resume and sid != resume:
                log.warning("%s: %s was started again as a copy, %s (%s)", c, key, short, sid)
            record(c, key, short=short, sid=sid, chat=chat, role=role, folder=folder)
            log.info("%s: background session %s (%s) %s for %s", c, short, sid, "resumed" if resume else "started", key)
            return BgProc(c, key, short, sid, hit.get("pid"))
        await asyncio.sleep(1)
    raise RuntimeError("the background session did not appear in `claude agents`")


def _nudge() -> str:
    from . import tools  # noqa: PLC0415

    return tools.hint("bg-carry-on")


# --------------------------------------------------------------------------- what the terminal lists


def statusline_command(cwd: Path) -> str:
    """The statusline command of a terminal-first workspace: plugin/bin/thimble-agents, chained to the analyst's own
    statusline when their settings name one."""
    import shlex  # noqa: PLC0415

    from . import agent_session, cc_settings  # noqa: PLC0415

    own = cc_settings.own_statusline(cwd)
    cmd = f"{shlex.quote(str(agent_session.PLUGIN_DIR / 'bin' / 'thimble-agents'))} --statusline"
    return f"{cmd} --chain {shlex.quote(own)}" if own else cmd


def sync_statusline(c: str) -> None:
    """The corpus folder's statusline lists thimble's agents while the workspace is in terminal-first mode, and is the
    analyst's own again once it is not (cc_settings.set_statusline)."""
    from . import cc_settings  # noqa: PLC0415

    try:
        cwd = config.corpus_dir(c)
        if terminal_first(c):
            cc_settings.set_statusline(cwd, statusline_command(cwd))
        else:
            cc_settings.clear_statusline(cwd)
    except Exception:  # noqa: BLE001 — the statusline is a convenience; a folder that cannot be written keeps its own
        log.warning("%s: the statusline was not updated", c, exc_info=True)


def agent_rows(c: str) -> list[dict[str, Any]]:
    """Every thimble agent running in the workspace, for the statusline and /thimble:agents: background sessions and
    the subagents and threads of main (session.py), each {name, state, attach?}."""
    rows: list[dict[str, Any]] = []
    for e in entries(c):
        if not alive(e):
            continue
        rows.append({"name": e.name, "state": state_words(e), "attach": f"claude attach {e.short}", "kind": "session"})
    rows.extend(session.running_agents(c))
    return rows


def status_line(rows: list[dict[str, Any]], width: int = 3) -> str:
    """One line for Claude Code's statusline: `thimble · ● thimble:writer working · ◐ thimble:orient waiting …`."""
    if not rows:
        return ""
    mark = {"working": "●", "waiting": "◐"}
    parts = [f"{mark.get(r['state'].split()[0], '○')} {r['name']} {r['state']}" for r in rows[:width]]
    more = f" · +{len(rows) - width}" if len(rows) > width else ""
    return "thimble · " + " · ".join(parts) + more


def listing_text(rows: list[dict[str, Any]]) -> str:
    from . import tools  # noqa: PLC0415

    if not rows:
        return tools.hint("agents-none")
    width = max(len(r["name"]) for r in rows)
    lines = [f"{r['name']:<{width}}  {r['state']:<24}  {r.get('attach') or ''}".rstrip() for r in rows]
    return "\n".join(lines + ["", tools.hint("agents-help")])


class AgentsQuery(BaseModel):
    cwd: str
    session: str | None = None
    announce: bool = False  # the plugin's hooks ask for the lines to print, which are then taken as shown


_announced: dict[str, dict[str, str]] = {}  # main session -> {key: what it was last told: started | ended}


@router.post("/agents")
async def agents_route(body: AgentsQuery) -> dict[str, Any]:
    """thimble's agents for the folder's workspace: `{rows, line, text}` for the statusline and /thimble:agents, and
    `announce`, the start and finish lines main's terminal has not shown yet (the plugin's hook prints them)."""
    c = config.workspace_for_cwd(body.cwd)
    if not c:
        return {"rows": [], "line": "", "text": "", "announce": ""}
    rows = agent_rows(c)
    told = _announced.setdefault(body.session or "", {})
    lines: list[str] = []
    for e in entries(c) if body.announce else []:
        state = "started" if alive(e) and e.run_open else "ended" if e.ended_at or not alive(e) else "started"
        if told.get(e.key) == state or (state == "ended" and e.key not in told and not alive(e)):
            told.setdefault(e.key, state)
            continue
        told[e.key] = state
        if state == "started":
            lines.append(f"{e.name} runs as a background session: `claude attach {e.short}`, ← at the prompt, or ↓ "
                         "for its tray entry")
        else:
            lines.append(f"{e.name} finished" + (f": {e.result[:200]}" if e.result else "") +
                         ("" if alive(e) else " (its session has ended)"))
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
    got = relay_check(c, _agent_file(body.transcript_path, body.agent_id), body.to, body.message)
    if got is None:
        return {"decision": None}
    return {"decision": "allow" if got["allow"] else "deny", "message": got.get("message"), "reason": got.get("reason")}


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
        if hit is None or not hit.get("pid"):
            e.status = "stopped"
            _save(e.c)
            _stopped_while_idle(e)
            continue
        fn = _wake.get(kind_of(e.key))
        if fn is None or agent_session.current(e.c, e.key) is not None:
            continue
        meta = agents.meta_or_none(e.c, e.chat) or {}
        if meta.get("status") != "running" and _status(hit) == "idle":
            continue  # its last run ended: the watcher follows it again when it starts a turn
        e.run_open = True
        try:
            await fn(e.c, e)
            found.append(f"{e.c}/{e.name}")
        except Exception:  # noqa: BLE001
            e.run_open = False
            log.exception("%s: background session %s was not followed again", e.c, e.name)
    _ensure_watcher()
    return found


async def shutdown() -> None:
    global _task, _closing
    _closing = True
    _changed.set()
    if _task is not None:
        _task.cancel()
        _task = None
