"""The files that thimble's hooks and server keep about thimble's agents in a workspace, read and written the same way by
both (subagents.py has the design):

  subagents.json  the pending requests (a start, a message or a stop, by request id), the nested starts a subagent's
                  Agent call left (`nested`), the agent registry (`agents`, by agent id), the per-run efforts the
                  module's step hook applies (`efforts`), the module's last hello (`module`), main's session and its
                  moves (`main`) and main's end (`main_end`)
  callers.jsonl   one line per thimble tool call of a subagent: {tool_use_id, agent_id, agent_type, ts}, trimmed to the
                  last CALLERS_KEEP_S
  launch.json     what the launcher started main with (lane A writes it)

The server creates the three files when it registers the workspace, and both kernel wrappers bind them read-only
(kernel_wrap.TRUSTED_FILES), since a notebook cell runs model-written code with the workspace writable: a pending request
it wrote would let a plugin start claim it, and a caller line it wrote would credit its call to an agent.

A write takes an exclusive flock on subagents.json.lock (LOCK), the lock lane M's module_bridge takes before it writes
the module's record, then one on subagents.json as it is, checks that the path still names the file it locked, and
replaces the file whole (a temporary file renamed over it), so a reader never sees half a file and needs no lock. A lock
that does not come within LOCK_WAIT_S (a process that holds it and never lets go) is given up, and the write goes on
without it. LOCK is made with the other files and hidden from kernels (kernel_wrap.LOCK_FILES), so a cell can neither
hold it nor replace it with a file of its own and take writers' exclusion away.

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

STATE = "subagents.json"
CALLERS = "callers.jsonl"
LAUNCH = "launch.json"
LOCK = f"{STATE}.lock"  # the lock of subagents.json's writers, this module's and module_bridge's
FILES = (STATE, CALLERS, LAUNCH, LOCK)
LOCK_WAIT_S = 2.0
LOCK_POLL_S = 0.01
CALLERS_KEEP_S = 3600.0
CALLERS_TRIM_BYTES = 256 * 1024  # callers.jsonl is trimmed to CALLERS_KEEP_S once it grows past this
NESTED_KEEP_S = 600.0  # a nested start no SubagentStart took up within this long is dropped
DONE_KEEP_S = 24 * 3600.0  # a request that ended is dropped after this long
REKEYS_KEPT = 16  # the session moves kept under `module.rekeyed`
PLUGIN = "thimble"
PREFIX = f"{PLUGIN}:"
# thimble's six roles: the agents that have a key, a chat and a run of their own. thimble:helper, and an extension's
# agent registered under the plugin's name, are none of them: any agent may start one (agent_check).
ROLES = ("orientation", "critic", "writer", "view-builder", "view-reviewer", "check")
HELPER = "helper"
PLUGIN_CALL = "toolu_plugin_"  # the tool_use_id prefix of a call thimble's module made ($.agent.spawn, $.tool.call)
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


def state_path(ws: Path) -> Path:
    return Path(ws) / STATE


def ensure(ws: Path) -> None:
    """Each of FILES made, empty, in the workspace folder `ws` when it is missing (module note)."""
    for name in FILES:
        p = Path(ws) / name
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
    path.parent.mkdir(parents=True, exist_ok=True)
    end = time.monotonic() + wait_s
    try:
        outer = os.open(path.with_name(LOCK), os.O_RDONLY | os.O_CREAT, 0o600)
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


def hint(name: str, **values: Any) -> str:
    """A hint section of prompts/tools.md with its {placeholders} filled, as app.tools.hint reads it; '' when absent."""
    try:
        text = tree().joinpath(*TOOLS_MD).read_text("utf-8")
    except OSError:
        return ""
    m = re.search(rf"^## {re.escape(name)}[ \t]*\n(.*?)(?=^## \S|\Z)", text, re.M | re.S)
    body = m.group(1).strip() if m else ""
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


def check_call(state: dict[str, Any], hook: dict[str, Any]) -> str | None:
    """The PreToolUse hook's decision on an Agent, SendMessage or TaskStop call (`hook` is its input), with what it
    records in `state`: the reason to deny it, or None to let it go on. It never allows a call outright (Claude Code then
    asks or judges as usual).

    Agent: a subagent's call is recorded as a nested start of its caller (the parent of the agent it starts). A call
    for one of thimble's roles must match a pending start exactly (type and prompt, whitespace at the prompt's end
    aside, which a model copying the call drops or adds): main's own call a typed one, a plugin start (a
    `toolu_plugin_` id) a click or a follow-on one, and an agent's call (the critic's start) one that names that
    agent's role; the request is then claimed by the call. A second orientation, a second writer of a
    document, `run_in_background: false`, and every start in plan mode are denied. thimble:helper and any type that is
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
            # trailing whitespace aside: a model that copies the call drops or adds blank lines at its end
            if want.get("subagent_type") != kind or str(want.get("prompt") or "").rstrip() != prompt.rstrip():
                return False
            if plugin:
                return route in ("click", "follow-on")
            if caller:
                return route == "typed" and r.get("caller_role") is not None and _role_of_agent(state, caller) == r.get("caller_role")
            return route == "typed" and not r.get("caller_role")

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
            return (r.get("agent") == to and str(want.get("message") or "").rstrip() == text.rstrip()
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
    thimble's roles, the effort recorded for its parent's run (the module's step hook, V7d)."""
    up = registry(state).get(parent) or {}
    entry["root"] = up.get("root") or (parent if up.get("role") in ROLES else None)
    entry["work"] = up.get("work")
    effort = efforts(state).get(parent)
    if effort and role_of(entry.get("type")) is None:
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
    state["module"] = {**module, "rekeyed": dict(list(moves.items())[-REKEYS_KEPT:])}
    return moved


# --------------------------------------------------------------------------- callers.jsonl


def add_caller(ws: Path, tool_use_id: str, agent_id: str, agent_type: str) -> None:
    """One line of callers.jsonl (module note): the thimble call `tool_use_id` is the subagent `agent_id`'s. The file is
    trimmed to CALLERS_KEEP_S once it grows past CALLERS_TRIM_BYTES."""
    if not tool_use_id or not agent_id:
        return
    path = Path(ws) / CALLERS
    line = json.dumps({"tool_use_id": tool_use_id, "agent_id": agent_id, "agent_type": agent_type, "ts": now()}) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
        size = os.fstat(fd).st_size
    finally:
        os.close(fd)
    if size > CALLERS_TRIM_BYTES:
        trim_callers(ws)


def trim_callers(ws: Path) -> None:
    path = Path(ws) / CALLERS
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
        data = (Path(ws) / CALLERS).read_bytes()
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


# --------------------------------------------------------------------------- the workspace of a hook


def _server_env(home: Path) -> dict[str, Any]:
    try:
        data = json.loads((home / "server.json").read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    env = data.get("env") if isinstance(data, dict) else None
    return env if isinstance(env, dict) else {}


def workspace_folder(cwd: str) -> Path | None:
    """The workspace folder of the corpus folder `cwd`, as the server would name it (config.workspace_for_cwd under the
    data and workspaces folders cli.resolve_env picks: THIMBLE_DATA_DIR and THIMBLE_WORKSPACES_DIR, else those the
    last server.json names, else the defaults); None for a folder of no corpus."""
    home = Path(os.environ.get("THIMBLE_HOME") or (Path.home() / ".thimble")).expanduser()
    env = _server_env(home)
    for var, key in (("THIMBLE_DATA_DIR", "data_dir"), ("THIMBLE_WORKSPACES_DIR", "workspaces_dir")):
        if not os.environ.get(var) and env.get(key):
            os.environ[var] = str(env[key])
    import sys  # noqa: PLC0415

    backend = str(tree() / "backend")
    if backend not in sys.path:
        sys.path.insert(0, backend)
    from app import config  # noqa: PLC0415 — standard library only, and fast under -S

    c = config.workspace_for_cwd(cwd) if cwd else None
    return config.WORKSPACES_DIR / c if c else None
