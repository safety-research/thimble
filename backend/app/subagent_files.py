"""The files that thimble's hooks and server keep about thimble's agents in a workspace, read and written the same way by
both (subagents.py has the design):

  subagents.json  the pending requests (a start, a message or a stop, by request id), the nested starts a subagent's
                  Agent call left (`nested`), the agent registry (`agents`, by agent id), the per-run efforts the
                  module's step hook applies (`efforts`), the module's last hello (`module`), main's session and its
                  moves (`main`) and main's end (`main_end`)
  callers.jsonl   one line per thimble tool call of a subagent: {tool_use_id, agent_id, agent_type, ts}, trimmed to the
                  last CALLERS_KEEP_S
  launch.json     what the launcher started main with (lane A writes it), with the session's mode (`mode`: browser or
                  terminal), which every process of the session reads here (session_mode)

In terminal mode (no server) two more files are in the folder, and subagents.json holds more:

  roles.json      the roles the module registers ({at, digest, roles: {name: spec}}), as GET /api/module/roles serves
                  them in browser mode (module_bridge.roles_file writes it)
  module.json     what the module writes, and only the module: {session, version, load, beat, plan, plan_at, problem,
                  taken, answers, ended, gone}, its times in milliseconds since the epoch (module_bridge has the
                  design); a reader retries a read that a write cut short (read_module), since the module can only
                  write a file whole in place
  subagents.json  the module's requests, entries of `requests` of kind `module` ({op, args, module: pending | answered
                  | expired, session, asked_at, expires_at}, add_module_request), main's permission mode (`main`:
                  record_mode), the notes for a new main after /clear (`module.notes`: rekey) and the forks of threads
                  that are starting (`forking`)

The files are in the workspace's `trusted` folder (DIR). The server makes the folder and the files when it
registers the workspace, and both kernel wrappers bind the folder read-only (kernel_wrap.TRUSTED_DIR), since a notebook
cell runs model-written code with the workspace writable: a pending request it wrote would let a plugin start claim it,
and a caller line it wrote would credit its call to an agent. The folder is bound, not each file: a write replaces a
file whole, and Linux takes a bind off a file that another mount namespace renames a new file over, so a read-only bind
of the file itself held only until the server's first write, after which the cell could write the file.

A write takes an exclusive flock on subagents.json.lock (LOCK, in the workspace folder itself), the lock module_bridge
takes too before it writes the module's record, then one on subagents.json as it is, checks that the path still names
the file it locked, and replaces the file whole (a temporary file renamed over it), so a reader never sees half a file
and needs no lock. A lock that does not come within LOCK_WAIT_S (a process that holds it and never lets go) is given
up, and the write goes on without it. LOCK is made with the other files and hidden from kernels
(kernel_wrap.LOCK_FILES), so a cell can neither hold it nor replace it with a file of its own and take writers'
exclusion away; nothing renames it, so its bind holds.

Standard library only: the plugin's hooks (plugin/bin/.thimble-watch) import this module under `python -S`.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any, Iterator

DIR = "trusted"  # the workspace's folder of the files the hooks trust, read-only to kernels as a folder (module note)
STATE = "subagents.json"
CALLERS = "callers.jsonl"
LAUNCH = "launch.json"
FILES = (STATE, CALLERS, LAUNCH)  # in DIR
ROLES_FILE = "roles.json"  # in DIR, terminal mode: the roles the module registers (module note)
MODULE_OUT = "module.json"  # in DIR, terminal mode: what the module writes, and only the module (module note)
BROWSER, TERMINAL = "browser", "terminal"  # the session's mode, launch.json's `mode` (session_mode)
MODES = (BROWSER, TERMINAL)
WS_ENV = "THIMBLE_WS"  # the workspace folder, which the launcher exports in terminal mode only
LOCK = f"{STATE}.lock"  # the lock of subagents.json's writers, this module's and module_bridge's, in the workspace folder
LOCK_WAIT_S = 2.0
LOCK_POLL_S = 0.01
CALLERS_KEEP_S = 3600.0
CALLERS_TRIM_BYTES = 256 * 1024  # callers.jsonl is trimmed to CALLERS_KEEP_S once it grows past this
NESTED_KEEP_S = 600.0  # a nested start no SubagentStart took up within this long is dropped
DONE_KEEP_S = 24 * 3600.0  # a request that ended is dropped after this long
REKEYS_KEPT = 16  # the session moves kept under `module.rekeyed`
PLUGIN = "thimble"
PREFIX = f"{PLUGIN}:"
# thimble's seven roles: the agents that have a key, a chat and a run of their own. thimble:orient-helper, and an extension's
# agent registered under the plugin's name, are none of them: any agent may start one (agent_check).
ROLES = ("orientation", "critic", "writer", "view-builder", "view-reviewer", "check", "dev-ticket")
HELPER = "orient-helper"
PLUGIN_CALL = "toolu_plugin_"  # the tool_use_id prefix of a call thimble's module made ($.agent.spawn, $.tool.call)
# the agent type of a thread's fork, which Claude Code tells not to start subagents (its fork boilerplate: "Do NOT spawn
# subagents with the Agent tool"), so a fork's start tool call is refused at once (tools._as_caller)
FORK_TYPE = "fork"
AGENT_TOOLS = ("Agent", "Task")
SEND_TOOL = "SendMessage"
STOP_TOOL = "TaskStop"
REQUEST_PREFIX = "req_"
REQUEST_RE = re.compile(r"\breq_[0-9a-f]{10}\b")
OPEN = ("pending", "claimed")  # the states of a request that may still be claimed or started
TOOLS_MD = ("prompts", "tools.md")  # under the tree: the hint sections the hooks' deny reasons come from
# Claude Code's permission mode in which thimble starts nothing: a subagent inherits it and then asks before each call
PLAN_MODE = "plan"


def now() -> float:
    return time.time()


def iso(t: float | None = None) -> str:
    """`t` (time.time()) as an ISO time in UTC, to the millisecond."""
    from datetime import datetime, timezone  # noqa: PLC0415

    return datetime.fromtimestamp(now() if t is None else t, timezone.utc).isoformat(timespec="milliseconds")


def request_id() -> str:
    """A new request id, `req_` and ten hex digits (REQUEST_RE), which a typed start's prompt carries on its first line."""
    return REQUEST_PREFIX + secrets.token_hex(5)


def type_name(role: str) -> str:
    """The agent type thimble's module registers a role as: `thimble:<role>`."""
    return f"{PREFIX}{role}"


def role_of(agent_type: Any) -> str | None:
    """The role of an agent type when it is one of ROLES (`thimble:orientation` is orientation); None for any other."""
    t = str(agent_type or "")
    role = t[len(PREFIX):] if t.startswith(PREFIX) else ""
    return role if role in ROLES else None


# --------------------------------------------------------------------------- the files


def trusted_dir(ws: Path) -> Path:
    """The folder of the files the hooks trust in the workspace folder `ws` (DIR)."""
    return Path(ws) / DIR


def state_path(ws: Path) -> Path:
    return trusted_dir(ws) / STATE


def callers_path(ws: Path) -> Path:
    return trusted_dir(ws) / CALLERS


def launch_path(ws: Path) -> Path:
    return trusted_dir(ws) / LAUNCH


def lock_path(ws: Path) -> Path:
    return Path(ws) / LOCK


def ensure(ws: Path) -> None:
    """The trusted folder (DIR), each of FILES in it and LOCK made, empty, in the workspace folder `ws` when missing
    (module note); a link or a file in the folder's place goes first, since a kernel wrapper would bind a link's
    target."""
    d = trusted_dir(ws)
    with contextlib.suppress(OSError):
        if d.is_symlink() or (d.exists() and not d.is_dir()):
            d.unlink()
    with contextlib.suppress(OSError):
        d.mkdir(mode=0o700, exist_ok=True)
    for p in [*(d / name for name in FILES), lock_path(ws)]:
        if p.is_symlink():
            with contextlib.suppress(OSError):
                p.unlink()
        with contextlib.suppress(FileExistsError, OSError):
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)


def _load(raw: bytes) -> dict[str, Any]:
    try:
        d = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def read(ws: Path) -> dict[str, Any]:
    """subagents.json of the workspace folder `ws`, {} when it is missing, empty or unreadable."""
    try:
        return _load(state_path(ws).read_bytes())
    except OSError:
        return {}


def _flock(fd: int, wait_s: float) -> bool:
    end = time.monotonic() + wait_s
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            if time.monotonic() >= end:
                return False
            time.sleep(LOCK_POLL_S)
        except OSError:
            return False


def _replace(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(3)}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=1, ensure_ascii=False))
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()


@contextlib.contextmanager
def update(ws: Path, wait_s: float = LOCK_WAIT_S) -> Iterator[dict[str, Any]]:
    """subagents.json of `ws` to change in place: the dict the block changes is written back whole when the block ends
    without an exception (module note)."""
    path = state_path(ws)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    end = time.monotonic() + wait_s
    try:
        outer = os.open(lock_path(ws), os.O_RDONLY | os.O_CREAT, 0o600)
    except OSError:
        outer = -1
    if outer >= 0 and not _flock(outer, wait_s):
        os.close(outer)
        outer = -1
    wait_s = max(0.0, end - time.monotonic())
    fd = -1
    for _ in range(8):  # the file a writer locked was replaced meanwhile: lock the new one
        fd = os.open(path, os.O_RDONLY | os.O_CREAT, 0o600)
        locked = _flock(fd, wait_s)
        try:
            same = os.fstat(fd).st_ino == os.stat(path).st_ino
        except OSError:
            same = False
        if same or not locked:
            break
        os.close(fd)
        fd = -1
    try:
        state = read(ws)
        before = json.dumps(state, sort_keys=True)
        yield state
        if json.dumps(state, sort_keys=True) != before:
            _prune(state)
            _replace(path, state)
    finally:
        if fd >= 0:
            os.close(fd)
        if outer >= 0:
            os.close(outer)


def _prune(state: dict[str, Any]) -> None:
    """Requests that ended more than DONE_KEEP_S ago, and nested starts older than NESTED_KEEP_S, go."""
    t = now()
    reqs = state.get("requests")
    if isinstance(reqs, dict):
        for rid in [k for k, r in reqs.items() if isinstance(r, dict) and r.get("state") not in OPEN
                    and t - float(r.get("at") or r.get("created") or t) > DONE_KEEP_S]:
            reqs.pop(rid, None)
    nested = state.get("nested")
    if isinstance(nested, list):
        state["nested"] = [n for n in nested if isinstance(n, dict) and t - float(n.get("at") or 0) <= NESTED_KEEP_S]


def requests(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    reqs = state.setdefault("requests", {})
    if not isinstance(reqs, dict):
        reqs = state["requests"] = {}
    return reqs


def registry(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    agents = state.setdefault("agents", {})
    if not isinstance(agents, dict):
        agents = state["agents"] = {}
    return agents


def efforts(state: dict[str, Any]) -> dict[str, str]:
    out = state.setdefault("efforts", {})
    if not isinstance(out, dict):
        out = state["efforts"] = {}
    return out


# --------------------------------------------------------------------------- deny reasons


def tree() -> Path:
    """The thimble tree this module belongs to: THIMBLE_APP_DIR (bin/thimble-python sets it), else the folder above
    backend/."""
    named = os.environ.get("THIMBLE_APP_DIR") or ""
    return Path(named) if named else Path(__file__).resolve().parents[2]


def hint(name: str, *, session_mode: str | None = None, **values: Any) -> str:
    """A hint section of prompts/tools.md with its {placeholders} filled, as app.tools.hint reads it; '' when absent.
    In terminal mode (`session_mode`, else THIMBLE_MODE) the section `## <name>@terminal` comes first when there is one
    (prompts.section's rule)."""
    try:
        text = tree().joinpath(*TOOLS_MD).read_text("utf-8")
    except OSError:
        return ""
    mode = session_mode or os.environ.get("THIMBLE_MODE") or ""
    body = ""
    for heading in ([f"{name}@{mode}"] if mode in MODES else []) + [name]:
        m = re.search(rf"^## {re.escape(heading)}[ \t]*\n(.*?)(?=^## \S|\Z)", text, re.M | re.S)
        if m:
            body = m.group(1).strip()
            break
    try:
        return body.format(**values) if body else ""
    except (KeyError, IndexError, ValueError):
        return body


# --------------------------------------------------------------------------- what a hook decides and records


def running_role(state: dict[str, Any], role: str, key: str | None = None) -> dict[str, Any] | None:
    """A registered agent of `role` (and of `key`, when given) whose run goes; None when none does."""
    for a in registry(state).values():
        if isinstance(a, dict) and a.get("role") == role and a.get("status") == "running" and (key is None or a.get("key") == key):
            return a
    return None


def _pending_for(state: dict[str, Any], kind: str, match: Any) -> list[tuple[str, dict[str, Any]]]:
    return [(rid, r) for rid, r in requests(state).items()
            if isinstance(r, dict) and r.get("kind") == kind and r.get("state") == "pending" and match(r)]


def same_text(want: str, got: str) -> bool:
    """Whether a call's prompt or message is the one its request holds: the same text, but for whitespace at its end,
    which the model's call does not carry (live check L32: a view build's prompt ended in blank lines, and main's
    exact call was denied twice)."""
    return want.rstrip() == got.rstrip()


def check_call(state: dict[str, Any], hook: dict[str, Any]) -> str | None:
    """The PreToolUse hook's decision on an Agent, SendMessage or TaskStop call (`hook` is its input), with what it
    records in `state`: the reason to deny it, or None to let it go on. It never allows a call outright (Claude Code then
    asks or judges as usual).

    Agent: a subagent's call is recorded as a nested start of its caller (the parent of the agent it starts). A call
    for one of thimble's roles must match a pending start exactly (type and prompt, whitespace at the prompt's end
    aside, which a model copying the call drops or adds): main's own call a typed one main's start tool made, a plugin
    start (a `toolu_plugin_` id) a click or a follow-on one, an agent's call (the critic's start) one that names that
    agent's role, and the call of a subagent that is no agent of thimble's (a thread's fork, a subagent of main's own)
    a typed one that same subagent's start tool call made (`caller_agent`), so that the agent becomes its child, as
    Claude Code lets a subagent start subagents; the request is then claimed by the call. A second orientation, a second writer of a
    document, `run_in_background: false`, and every start in plan mode are denied. thimble:orient-helper and any type that is
    not one of thimble's roles go on.

    SendMessage to a registered agent of a role claims the pending message request with the same text; with none it is
    denied. TaskStop claims a pending stop request of its agent and is never denied."""
    name = str(hook.get("tool_name") or "")
    inp = hook.get("tool_input") if isinstance(hook.get("tool_input"), dict) else {}
    caller = str(hook.get("agent_id") or "") or None
    call = str(hook.get("tool_use_id") or "")
    plan = str(hook.get("permission_mode") or "") == PLAN_MODE
    t = now()
    if name in AGENT_TOOLS:
        kind = str(inp.get("subagent_type") or "")
        if caller:
            nested = state.setdefault("nested", [])
            if isinstance(nested, list):
                nested.append({"tool_use_id": call, "caller": caller, "subagent_type": kind, "at": t})
        role = role_of(kind)
        if role is None:
            return None
        if plan:
            return hint("start-plan-mode")
        if inp.get("run_in_background") is False or str(inp.get("run_in_background")).lower() == "false":
            return hint("agent-check-exact")
        plugin = call.startswith(PLUGIN_CALL)
        prompt = str(inp.get("prompt") or "")

        def fits(r: dict[str, Any]) -> bool:
            want = r.get("input") if isinstance(r.get("input"), dict) else {}
            route = r.get("route")
            if want.get("subagent_type") != kind or not same_text(str(want.get("prompt") or ""), prompt):
                return False
            if plugin:
                return route in ("click", "follow-on")
            if caller and r.get("caller_agent"):
                return route == "typed" and r.get("caller_agent") == caller
            if caller:
                return route == "typed" and r.get("caller_role") is not None and _role_of_agent(state, caller) == r.get("caller_role")
            return route == "typed" and not r.get("caller_role") and not r.get("caller_agent")

        found = _pending_for(state, "start", fits)
        if not found:
            if role == "orientation" and running_role(state, "orientation") is not None:
                return hint("start_orientation-running")
            if role == "writer":
                doc = _doc_of(prompt, state)
                if doc and running_role(state, "writer", f"writer:{doc}") is not None:
                    return hint("start_writing-running", doc=doc)
            return hint("agent-check-exact")
        rid, req = found[-1]
        if role == "orientation" and running_role(state, "orientation") is not None:
            return hint("start_orientation-running")
        key = str(req.get("key") or "")
        if role == "writer" and key and running_role(state, "writer", key) is not None:
            return hint("start_writing-running", doc=key.split(":", 1)[-1])
        req.update(state="claimed", claimed_by=call, claimed_at=t, caller=caller)
        return None
    if name == SEND_TOOL:
        to = str(inp.get("to") or inp.get("recipient") or "")
        agent = registry(state).get(to)
        if not isinstance(agent, dict) or agent.get("role") not in ROLES:
            return None
        if plan:
            return hint("start-plan-mode")
        text = str(inp.get("message") if inp.get("message") is not None else inp.get("content") or "")
        plugin = call.startswith(PLUGIN_CALL)

        def same(r: dict[str, Any]) -> bool:
            want = r.get("input") if isinstance(r.get("input"), dict) else {}
            route = r.get("route")
            return (r.get("agent") == to and same_text(str(want.get("message") or ""), text)
                    and (route in ("click", "follow-on") if plugin else route == "typed"))

        found = _pending_for(state, "message", same)
        if not found:
            return hint("agent-check-message")
        found[-1][1].update(state="claimed", claimed_by=call, claimed_at=t)
        return None
    if name == STOP_TOOL:
        to = str(inp.get("task_id") or inp.get("shell_id") or inp.get("id") or "")
        for _, r in _pending_for(state, "stop", lambda r: r.get("agent") == to):
            r.update(state="claimed", claimed_by=call, claimed_at=t)
        return None
    return None


def _role_of_agent(state: dict[str, Any], agent: str) -> str | None:
    a = registry(state).get(agent)
    return str(a.get("role")) if isinstance(a, dict) and a.get("role") else None


def _doc_of(prompt: str, state: dict[str, Any]) -> str:
    """The document a writer's start names, from the pending writer start whose request id its prompt carries."""
    m = REQUEST_RE.search(prompt.split("\n", 1)[0])
    r = requests(state).get(m.group(0)) if m else None
    key = str((r or {}).get("key") or "")
    return key.split(":", 1)[1] if key.startswith("writer:") else ""


def register(state: dict[str, Any], hook: dict[str, Any]) -> dict[str, Any] | None:
    """The SubagentStart hook's record (`hook` its input): the agent's entry in the registry, which it returns; None for
    an agent that is no business of thimble's (the analyst's own subagent, a thread's fork).

    An agent the registry holds starts again (a follow-up, a hand-back of its child): its latest start is recorded. A new
    agent of one of thimble's roles takes up the claimed start of its type that no agent took up yet. Any other new agent
    is a descendant of one of thimble's agents when a nested start of its type names that agent as its caller; when two
    callers' nested starts share its type, its parent waits for its first call (resolve_parent)."""
    agent_id = str(hook.get("agent_id") or "")
    agent_type = str(hook.get("agent_type") or "")
    session = str(hook.get("session_id") or "")
    if not agent_id:
        return None
    t = now()
    agents = registry(state)
    known = agents.get(agent_id)
    if isinstance(known, dict):
        known["last_start"] = t
        known["starts"] = int(known.get("starts") or 0) + 1
        if session and session not in (known.get("sessions") or []):
            known["sessions"] = [*(known.get("sessions") or []), session]
        return known
    role = role_of(agent_type)
    if role is not None:
        claimed = [(rid, r) for rid, r in requests(state).items()
                   if isinstance(r, dict) and r.get("kind") == "start" and r.get("state") == "claimed" and not r.get("agent")
                   and (r.get("input") or {}).get("subagent_type") == agent_type]
        if claimed:
            rid, req = max(claimed, key=lambda x: float(x[1].get("claimed_at") or 0))
            entry = {"key": req.get("key"), "type": agent_type, "role": role, "request": rid,
                     "parent": req.get("caller"), "chat": req.get("chat"), "run": 0,
                     "values": req.get("values") or {}, "route": req.get("route"),
                     "plugin_started": str(req.get("claimed_by") or "").startswith(PLUGIN_CALL),
                     "sessions": [session] if session else [], "started": t, "last_start": t, "starts": 1,
                     "status": "running", "work": req.get("work"), "handed_back": False}
            agents[agent_id] = entry
            req.update(state="started", agent=agent_id, at=t)
            effort = str((req.get("values") or {}).get("effort") or "")
            if req.get("route") == "typed" and effort:
                efforts(state)[agent_id] = effort  # the module's step hook gives a typed run its effort
            return entry
    nested = [n for n in state.get("nested") or [] if isinstance(n, dict) and n.get("subagent_type") == agent_type
              and isinstance(agents.get(str(n.get("caller") or "")), dict)]
    if not nested:
        return None
    callers = list(dict.fromkeys(str(n["caller"]) for n in nested))
    parent = callers[0] if len(callers) == 1 else None
    entry = {"type": agent_type, "role": role or (HELPER if agent_type == type_name(HELPER) else None),
             "parent": parent, "candidates": callers if parent is None else [], "sessions": [session] if session else [],
             "started": t, "last_start": t, "starts": 1, "status": "running", "descendant": True}
    if parent is not None:
        _inherit(state, agent_id, entry, parent)
        state["nested"] = [n for n in state.get("nested") or [] if n is not nested[-1]]
    agents[agent_id] = entry
    return entry


def _inherit(state: dict[str, Any], agent_id: str, entry: dict[str, Any], parent: str) -> None:
    """A descendant takes its thimble ancestor (`root`) and work folder from its parent, and, unless its type is one of
    thimble's (a role, thimble:orient-helper or an extension's agent, each registered with its own model and effort), the
    effort recorded for its parent's run (the module's step hook, V7d), as the module's own agent.spawn hook gives it."""
    up = registry(state).get(parent) or {}
    entry["root"] = up.get("root") or (parent if up.get("role") in ROLES else None)
    entry["work"] = up.get("work")
    effort = efforts(state).get(parent)
    if effort and not str(entry.get("type") or "").startswith(PREFIX):
        efforts(state)[agent_id] = effort


def resolve_parent(state: dict[str, Any], agent_id: str, parent: str) -> None:
    """The parent of a descendant whose nested start was ambiguous, from `parentAgentId` in its meta.json, read at its
    first call (the caller hook)."""
    entry = registry(state).get(agent_id)
    if isinstance(entry, dict) and not entry.get("parent") and parent in (entry.get("candidates") or [parent]):
        entry["parent"] = parent
        entry["candidates"] = []
        _inherit(state, agent_id, entry, parent)


def record_stop(state: dict[str, Any], hook: dict[str, Any]) -> dict[str, Any] | None:
    """The SubagentStop hook's record: a turn of a registered agent ended. One with `stop_hook_active` (the second of the
    two Claude Code fires when it makes an agent hand back) or with an empty `agent_type` (Claude Code's own helpers) is
    ignored; None then, and for an agent the registry does not hold."""
    if hook.get("stop_hook_active") or not str(hook.get("agent_type") or ""):
        return None
    entry = registry(state).get(str(hook.get("agent_id") or ""))
    if not isinstance(entry, dict):
        return None
    entry["last_stop"] = now()
    entry["turns"] = int(entry.get("turns") or 0) + 1
    return entry


NO_CALL = "no-call"  # subagents.NO_CALL: a typed start whose caller's turn ended without its Agent call


def refuse_unclaimed(state: dict[str, Any], hook: dict[str, Any]) -> list[str]:
    """The SubagentStop hook's record for a subagent that is no agent of thimble's (a thread's fork, a subagent of
    main's own): a turn of it ended, so the typed starts its own start tool calls asked for (`caller_agent`) that its
    Agent call never claimed are refused, kind no-call, with its last text (two lines) as the reason, as R3 refuses main's
    at main's turn end. The ids refused; none for one of thimble's agents or for the second SubagentStop of a
    hand-back."""
    agent = str(hook.get("agent_id") or "")
    if not agent or hook.get("stop_hook_active") or isinstance(registry(state).get(agent), dict):
        return []
    said = "\n".join([ln for ln in str(hook.get("last_assistant_message") or "").strip().splitlines() if ln.strip()][:2])
    out = []
    for rid, r in _pending_for(state, "start", lambda r: r.get("route") == "typed" and r.get("caller_agent") == agent):
        r.update(state="refused", reason=said, refused_kind=NO_CALL, at=now())
        out.append(rid)
    return out


def record_denied(state: dict[str, Any], hook: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """The PermissionDenied hook's record: auto mode refused main's Agent call for one of thimble's roles, or a
    SendMessage to a registered agent of one. The request the call claimed (or the pending one it matches) is refused
    with Claude Code's reason as given, kind `auto-mode`. (request id, request), or None when the call was none of
    these."""
    name = str(hook.get("tool_name") or "")
    inp = hook.get("tool_input") if isinstance(hook.get("tool_input"), dict) else {}
    call = str(hook.get("tool_use_id") or "")
    reason = str(hook.get("reason") or hook.get("permission_decision_reason") or hook.get("message") or "").strip()
    if name in AGENT_TOOLS and role_of(inp.get("subagent_type")) is None:
        return None
    if name == SEND_TOOL and not isinstance(registry(state).get(str(inp.get("to") or "")), dict):
        return None
    if name not in (*AGENT_TOOLS, SEND_TOOL):
        return None
    reqs = requests(state)
    hit = next(((rid, r) for rid, r in reqs.items() if isinstance(r, dict) and call and r.get("claimed_by") == call), None)
    if hit is None:
        want = "start" if name in AGENT_TOOLS else "message"
        key = "prompt" if want == "start" else "message"
        hit = next(((rid, r) for rid, r in reversed(list(reqs.items())) if isinstance(r, dict) and r.get("kind") == want
                    and r.get("state") in OPEN and str((r.get("input") or {}).get(key) or "") == str(inp.get(key) or "")),
                   None)
    if hit is None:
        return None
    hit[1].update(state="refused", reason=reason, refused_kind="auto-mode", at=now())
    return hit


def record_end(state: dict[str, Any], hook: dict[str, Any]) -> dict[str, Any]:
    """The SessionEnd hook's record of main's end: {session, reason, at, pid}. On `clear` and `resume` only the record:
    the agents run on in the session that follows (rekey)."""
    end = {"session": str(hook.get("session_id") or ""), "reason": str(hook.get("reason") or ""), "at": now(),
           "pid": hook.get("pid")}
    state["main_end"] = end
    return end


def rekey(state: dict[str, Any], old: str, new: str) -> list[str]:
    """After /clear or an in-session /resume (SessionStart `clear` or `resume`): the running agents of session `old` take
    session `new` (each agent's `sessions`, newest last), and `main` names `new`. The move is also kept where lane M's
    module_bridge reads the moves it accepts a hello from (`module.rekeyed`, old to new), for a server that starts after
    the hook ran. The agents moved."""
    if not old or not new or old == new:
        return []
    moved = []
    for agent_id, a in registry(state).items():
        if not isinstance(a, dict) or a.get("status") != "running":
            continue
        sessions = [str(s) for s in a.get("sessions") or []]
        if sessions and sessions[-1] == old:
            a["sessions"] = [*sessions, new]
            moved.append(agent_id)
    main = state.get("main") if isinstance(state.get("main"), dict) else {}
    state["main"] = {**main, "session": new, "previous": [*(main.get("previous") or []), old][-8:], "moved_at": now()}
    module = state.get("module") if isinstance(state.get("module"), dict) else {}
    moves = {str(k): str(v) for k, v in (module.get("rekeyed") or {}).items()} if isinstance(
        module.get("rekeyed"), dict) else {}
    moves.pop(new, None)  # a move back (/resume to the session before) ends the chain at `new`
    moves[old] = new
    state["module"] = {**module, "rekeyed": dict(list(moves.items())[-REKEYS_KEPT:]),
                       # terminal mode: the lines the module appends to the new main, one per running agent, which has
                       # no record of them (module_bridge.state_route gives the same lines in browser mode)
                       "notes": {"session": new, "lines": started_notes(state), "at": now()}}
    return moved


# --------------------------------------------------------------------------- the note at a start


# module-started-note's {how}, by the route of the agent's start: the analyst's click, the next step of a run they asked
# for (a writer after the orientation, a view build it proposed), or main's own Agent call for a typed request
HOW = {"click": "in the browser", "follow-on": "as the next step of a run they asked for in thimble",
       "typed": "through your own Agent call"}
NOTE_HINT = "module-started-note"  # prompts/tools.md: {role}, {agent}, {what}, {how}
WHAT_CHARS = 120
WHAT_ORIENTATION = "this corpus"  # module-started-note's {what} for an agent whose key has no name (the orientation)
RUNNING = ("running", "waiting")


def note_what(what: Any) -> str:
    """module-started-note's {what}: a server-checked name with no control characters and no markup, cut at WHAT_CHARS;
    WHAT_ORIENTATION for none."""
    return re.sub(r"[\x00-\x1f\x7f<>]+", " ", str(what or "")).strip()[:WHAT_CHARS] or WHAT_ORIENTATION


def key_what(key: Any) -> str:
    """The server-checked name an agent's note gives: the part of its key after the role (a document, a view's slug, a
    check and its document), worded as the note at its start words it (`unverified on report`)."""
    key = str(key or "")
    return key.split(":", 1)[1].replace(":", " on ") if ":" in key else ""


def started_notes(state: dict[str, Any], session_mode: str | None = None) -> list[str]:
    """The note a new main gets for each running agent of thimble's roles (but the orientation's own children, which its
    orientation tells of, and the helper): hint module-started-note, with the agent's id, its role, its key's name and
    how it started."""
    agents = registry(state)
    out = []
    for aid, e in agents.items():
        if not isinstance(e, dict):
            continue
        state_ = str(e.get("status") or "")
        role = role_of(e.get("type")) or (str(e.get("role") or "") if e.get("role") in ROLES else None)
        if not role or (state_ and state_ not in RUNNING) or (not state_ and e.get("ended")):
            continue
        parent = str(e.get("parent") or "")
        if parent and parent in agents:
            continue
        route = str(e.get("route") or ("click" if e.get("plugin_started") else "typed"))
        line = hint(NOTE_HINT, session_mode=session_mode, role=role, agent=aid, what=note_what(key_what(e.get("key"))),
                    how=HOW.get(route) or HOW["click"])
        if line:
            out.append(line)
    return out


# --------------------------------------------------------------------------- callers.jsonl


def add_caller(ws: Path, tool_use_id: str, agent_id: str, agent_type: str) -> None:
    """One line of callers.jsonl (module note): the thimble call `tool_use_id` is the subagent `agent_id`'s. The file is
    trimmed to CALLERS_KEEP_S once it grows past CALLERS_TRIM_BYTES."""
    if not tool_use_id or not agent_id:
        return
    path = callers_path(ws)
    line = json.dumps({"tool_use_id": tool_use_id, "agent_id": agent_id, "agent_type": agent_type, "ts": now()}) + "\n"
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
        size = os.fstat(fd).st_size
    finally:
        os.close(fd)
    if size > CALLERS_TRIM_BYTES:
        trim_callers(ws)


def trim_callers(ws: Path) -> None:
    path = callers_path(ws)
    floor = now() - CALLERS_KEEP_S
    with update(ws):  # one writer at a time
        try:
            lines = path.read_text("utf-8").splitlines()
        except OSError:
            return
        kept = []
        for ln in lines:
            try:
                rec = json.loads(ln)
            except ValueError:
                continue
            if isinstance(rec, dict) and float(rec.get("ts") or 0) >= floor:
                kept.append(ln)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_text("".join(f"{ln}\n" for ln in kept), "utf-8")
        os.replace(tmp, path)


def find_caller(ws: Path, tool_use_id: str) -> dict[str, Any] | None:
    """The callers.jsonl line of the call `tool_use_id`, the newest when there are several; None when there is none."""
    if not tool_use_id:
        return None
    try:
        data = callers_path(ws).read_bytes()
    except OSError:
        return None
    needle = tool_use_id.encode("utf-8")
    for line in reversed(data.splitlines()):
        if needle not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("tool_use_id") == tool_use_id:
            return rec
    return None


# --------------------------------------------------------------------------- terminal mode


def _json_file(path: Path) -> dict[str, Any]:
    try:
        return _load(path.read_bytes())
    except OSError:
        return {}


_launches: dict[str, tuple[tuple, dict[str, Any]]] = {}  # launch.json's path -> (its stat, what it held)


def launch(ws: Path) -> dict[str, Any]:
    """launch.json of the workspace folder `ws`, {} when it is missing or unreadable; read again when its stat
    changed."""
    path = launch_path(ws)
    try:
        st = os.stat(path)
    except OSError:
        return {}
    key = (st.st_mtime_ns, st.st_size, st.st_ino)
    hit = _launches.get(str(path))
    if hit is None or hit[0] != key:
        hit = _launches[str(path)] = (key, _json_file(path))
    return dict(hit[1])


def session_mode(ws: Path | None) -> str:
    """The mode of the session launch.json names (`mode`: browser or terminal), as launch_mode.session_mode reads it;
    browser when it names none, or for no workspace."""
    if ws is None:
        return BROWSER
    mode = launch(ws).get("mode")
    return mode if mode in MODES else BROWSER


def terminal(ws: Path | None) -> bool:
    """Whether the session of the workspace folder `ws` runs in terminal mode (session_mode)."""
    return session_mode(ws) == TERMINAL


def roles_path(ws: Path) -> Path:
    return trusted_dir(ws) / ROLES_FILE


def module_path(ws: Path) -> Path:
    return trusted_dir(ws) / MODULE_OUT


MODULE_READS = 5  # tries at module.json before a read that a write cut short counts as no file
MODULE_READ_GAP_S = 0.01


def read_module(ws: Path) -> dict[str, Any]:
    """module.json of the workspace folder `ws` (module note): what the module wrote, {} when there is none. The module
    can write a file only whole and in place, so a read that finds half a file reads again."""
    path = module_path(ws)
    for i in range(MODULE_READS):
        try:
            raw = path.read_bytes()
        except OSError:
            return {}
        try:
            d = json.loads(raw.decode("utf-8") or "{}")
            return d if isinstance(d, dict) else {}
        except (UnicodeDecodeError, ValueError):
            if i + 1 < MODULE_READS:
                time.sleep(MODULE_READ_GAP_S)
    return {}


def moves(state: dict[str, Any]) -> dict[str, str]:
    """The moves of main's session that --rekey recorded (`module.rekeyed`: old session to new)."""
    module = state.get("module") if isinstance(state.get("module"), dict) else {}
    got = module.get("rekeyed")
    return {str(k): str(v) for k, v in got.items() if isinstance(v, str)} if isinstance(got, dict) else {}


def moved_to(state: dict[str, Any], sid: str) -> str:
    """Session `sid` followed through every move --rekey recorded: the id the same `claude` process runs under now."""
    moved, seen = moves(state), set()
    while sid in moved and sid not in seen:
        seen.add(sid)
        sid = moved[sid]
    return sid


def main_session(ws: Path, state: dict[str, Any] | None = None) -> str:
    """Main's session in the workspace folder `ws`: the one launch.json names, followed through every move --rekey
    recorded in subagents.json (`state`, read when not given); '' when launch.json names none."""
    sid = str(launch(ws).get("session") or "")
    return moved_to(read(ws) if state is None else state, sid) if sid else ""


def main_pid(ws: Path) -> int | None:
    """The pid of main's `claude` process: launch.json's `pid` (the launcher's own, which `exec claude` keeps for the
    session's whole life, /clear and /resume included), when that process runs; None otherwise."""
    pid = launch(ws).get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    return pid


def record_mode(state: dict[str, Any], session: str, mode: str) -> bool:
    """The mode hook's record in terminal mode: the permission mode Claude Code reports for main's session `session`
    (`main.permission_mode`, `main.mode_at`), and the mode before plan mode (`main.before_plan`). True when it changed."""
    if not mode:
        return False
    main = state.get("main") if isinstance(state.get("main"), dict) else {}
    if main.get("permission_mode") == mode and main.get("mode_session") == session:
        return False
    was = str(main.get("permission_mode") or "")
    out = {**main, "permission_mode": mode, "mode_session": session, "mode_at": now()}
    if mode == PLAN_MODE and was and was != PLAN_MODE:
        out["before_plan"] = was
    state["main"] = out
    return True


def main_mode(ws: Path, state: dict[str, Any] | None = None, module: dict[str, Any] | None = None) -> str | None:
    """Main's permission mode in terminal mode: what main's hooks reported last (record_mode), unless the module saw
    plan mode begin or end since (module.json `plan`, `plan_at`), while main was idle; None before any report."""
    state = read(ws) if state is None else state
    module = read_module(ws) if module is None else module
    main = state.get("main") if isinstance(state.get("main"), dict) else {}
    mode = str(main.get("permission_mode") or "") or None
    at = float(main.get("mode_at") or 0)
    plan = module.get("plan")
    if isinstance(plan, bool) and float(module.get("plan_at") or 0) / 1000 > at and not module.get("gone"):
        if plan:
            return PLAN_MODE
        if mode == PLAN_MODE:
            return str(main.get("before_plan") or "") or "default"
    return mode


MODULE_KIND = "module"  # the kind of a request entry that asks the module for an op (terminal mode)


def add_module_request(state: dict[str, Any], op: str, args: dict[str, Any], session: str, wait_s: float | None,
                       of: str | None = None) -> str:
    """A request to the module in terminal mode (module note): an entry of `requests` of kind MODULE_KIND, which the
    module takes while `module` is pending and `expires_at` (time.time()) is ahead, answering it in module.json under
    the entry's id. `of` names the start, message or stop request it stands for. With `wait_s` None nobody waits for
    the answer (a stop of a late spawn, a register): it expires after DONE_KEEP_S. The id."""
    rid = f"mod_{secrets.token_hex(6)}"
    t = now()
    requests(state)[rid] = {"kind": MODULE_KIND, "op": op, "args": args, "module": "pending", "session": session,
                            "asked_at": t, "expires_at": t + (DONE_KEEP_S if wait_s is None else wait_s),
                            "state": "pending", "created": t, **({"of": of} if of else {})}
    return rid


def end_module_request(state: dict[str, Any], rid: str, how: str) -> None:
    """The module request `rid` ended: answered or expired (`how`); it leaves the open states, so _prune drops it."""
    r = requests(state).get(rid)
    if isinstance(r, dict) and r.get("kind") == MODULE_KIND:
        r.update(module=how, state="done" if how == "answered" else "expired", at=now())


FORKING = "forking"  # subagents.json: the forks of threads that are starting, by the Agent call's description
FORK_DEDUPE_S = 600.0  # subagents.FORK_DEDUPE_S


def fork_check(state: dict[str, Any], tool_input: dict[str, Any]) -> str | None:
    """Terminal mode's dedupe of a thread's fork (subagents.fork_check in browser mode): main's Agent call that would
    start a second fork of the thread its description names (`thread:<name>`) while the first starts or runs: why it
    must not run; else None, and the call is recorded."""
    if str(tool_input.get("subagent_type") or "") != FORK_TYPE:
        return None
    desc = str(tool_input.get("description") or "")
    if not desc.startswith("thread:"):
        return None
    table = state.setdefault(FORKING, {})
    if not isinstance(table, dict):
        table = state[FORKING] = {}
    t = now()
    at = table.get(desc)
    if isinstance(at, (int, float)) and t - float(at) < FORK_DEDUPE_S:
        return f"The fork of thread {desc.removeprefix('thread:')} is running already; it answers in the thread."
    table[desc] = t
    for k in [k for k, v in table.items() if not isinstance(v, (int, float)) or t - float(v) >= FORK_DEDUPE_S]:
        table.pop(k, None)
    return None


# --------------------------------------------------------------------------- the workspace of a hook


def _server_env(home: Path) -> dict[str, Any]:
    try:
        data = json.loads((home / "server.json").read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    env = data.get("env") if isinstance(data, dict) else None
    return env if isinstance(env, dict) else {}


def use_env() -> None:
    """The data and workspaces folders a hook's process names, as cli.resolve_env picks them: THIMBLE_DATA_DIR and
    THIMBLE_WORKSPACES_DIR, else in terminal mode the folder above THIMBLE_WS (the workspace folder the launcher
    exports), else those the last server.json names, else the defaults. Set in this process's environment before
    app.config is imported."""
    ws = os.environ.get(WS_ENV) or ""
    if ws and not os.environ.get("THIMBLE_WORKSPACES_DIR"):
        os.environ["THIMBLE_WORKSPACES_DIR"] = str(Path(ws).expanduser().parent)
    home = Path(os.environ.get("THIMBLE_HOME") or (Path.home() / ".thimble")).expanduser()
    env = _server_env(home)
    for var, key in (("THIMBLE_DATA_DIR", "data_dir"), ("THIMBLE_WORKSPACES_DIR", "workspaces_dir")):
        if not os.environ.get(var) and env.get(key):
            os.environ[var] = str(env[key])


def workspace_folder(cwd: str) -> Path | None:
    """The workspace folder of the corpus folder `cwd`, as the server would name it (config.workspace_for_cwd under the
    data and workspaces folders use_env picks); None for a folder of no corpus."""
    use_env()
    import sys  # noqa: PLC0415

    backend = str(tree() / "backend")
    if backend not in sys.path:
        sys.path.insert(0, backend)
    from app import config  # noqa: PLC0415 — standard library only, and fast under -S

    c = config.workspace_for_cwd(cwd) if cwd else None
    return config.WORKSPACES_DIR / c if c else None
