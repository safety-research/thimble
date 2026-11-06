"""The files that thimble's hooks and server keep about thimble's agents in a workspace, read and written the same way by
both (subagents.py has the design):

  subagents.json  the pending requests (a start, a message or a stop, by request id), the nested starts a subagent's
                  Agent call left (`nested`), the agent registry (`agents`, by agent id), the agents of a role whose
                  own start is not known yet (`unsettled`, by agent id: register), the per-run efforts the module's
                  step hook applies (`efforts`), the module's last hello (`module`), main's session and its moves
                  (`main`) and main's end (`main_end`)
  callers.jsonl   one line per thimble tool call: {tool_use_id, agent_id, agent_type, ts}, agent_id and agent_type
                  empty for main's own call, trimmed to the last CALLERS_KEEP_S

The files are in the workspace's `trusted` folder (DIR). The server makes the folder and the files when it
registers the workspace, and both kernel wrappers bind the folder read-only (kernel_wrap.TRUSTED_DIR), since a notebook
cell runs model-written code with the workspace writable: a pending request it wrote would let a plugin start claim it,
and a caller line it wrote would credit its call to an agent. The folder is bound, not each file: a write replaces a
file whole, and Linux takes a bind off a file that another mount namespace renames a new file over, so a read-only bind
of the file itself held only until the server's first write, after which the cell could write the file.

A write takes an exclusive flock on subagents.json.lock (LOCK, in the workspace's locks folder, LOCKS), and replaces
the file whole (a temporary file renamed over it), so a reader never sees half a file and needs no lock. A lock that does not come within LOCK_WAIT_S (a process
that holds it and never lets go) is given up, and the write goes on without it. The locks folder is made with the
other files and hidden from kernels (kernel_wrap.LOCKS_DIR), so a cell can neither hold LOCK nor replace it with a file
of its own and take writers' exclusion away; a write takes no lock on subagents.json itself, which a kernel may read and
so flock.
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
FILES = (STATE, CALLERS)  # in DIR
LOCKS = "locks"  # kernel_wrap.LOCKS_DIR: the workspace's folder of its lock files, which no kernel sees
LOCK = f"{STATE}.lock"  # the lock of subagents.json's writers, in LOCKS
LOCK_WAIT_S = 2.0
LOCK_POLL_S = 0.01
CALLERS_KEEP_S = 3600.0
CALLERS_TRIM_BYTES = 256 * 1024  # callers.jsonl is trimmed to CALLERS_KEEP_S once it grows past this
NESTED_KEEP_S = 600.0  # a nested start no SubagentStart took up within this long is dropped
UNSETTLED = "unsettled"  # subagents.json: the agents of a role whose own start is not known yet, by agent id (register)
DONE_KEEP_S = 24 * 3600.0  # a request that ended is dropped after this long
PLUGIN = "thimble"
PREFIX = f"{PLUGIN}:"
# thimble's five roles: the agents that have a key, a chat and a run of their own
ROLES = ("writer", "view-builder", "view-reviewer", "check", "dev-ticket")
PLUGIN_CALL = "toolu_plugin_"  # the tool_use_id prefix of a call thimble's module made ($.agent.spawn, $.tool.call)
# the agent type of a thread's fork, which Claude Code tells not to start subagents (its fork boilerplate: "Do NOT spawn
# subagents with the Agent tool"), so the server starts the agent of a fork's propose_view, file_dev_ticket,
# start_writing and run_check (tools._fork_start)
FORK_TYPE = "fork"
REQUEST_PREFIX = "req_"
OPEN = ("pending", "claimed")  # the states of a request that may still be claimed or started
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
    """The role of an agent type when it is one of ROLES (`thimble:writer` is writer); None for any other."""
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


def lock_path(ws: Path) -> Path:
    return Path(ws) / LOCKS / LOCK


def ensure(ws: Path) -> None:
    """The trusted folder (DIR) with each of FILES in it, and the locks folder (LOCKS) with LOCK in it, made, empty, in
    the workspace folder `ws` when missing (module note); a link or a file in a folder's place goes first, since a
    kernel wrapper would bind a link's target."""
    d = trusted_dir(ws)
    for folder in (d, lock_path(ws).parent):
        with contextlib.suppress(OSError):
            if folder.is_symlink() or (folder.exists() and not folder.is_dir()):
                folder.unlink()
        with contextlib.suppress(OSError):
            folder.mkdir(mode=0o700, exist_ok=True)
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
    lock = lock_path(ws)
    with contextlib.suppress(OSError):
        lock.parent.mkdir(mode=0o700, exist_ok=True)
    try:
        fd = os.open(lock, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError:
        fd = -1
    if fd >= 0 and not _flock(fd, wait_s):
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


def _prune(state: dict[str, Any]) -> None:
    """Requests that ended more than DONE_KEEP_S ago, and nested starts and unsettled agents older than NESTED_KEEP_S,
    go."""
    t = now()
    reqs = state.get("requests")
    if isinstance(reqs, dict):
        for rid in [k for k, r in reqs.items() if isinstance(r, dict) and r.get("state") not in OPEN
                    and t - float(r.get("at") or r.get("created") or t) > DONE_KEEP_S]:
            reqs.pop(rid, None)
    nested = state.get("nested")
    if isinstance(nested, list):
        state["nested"] = [n for n in nested if isinstance(n, dict) and t - float(n.get("at") or 0) <= NESTED_KEEP_S]
    table = state.get(UNSETTLED)
    if isinstance(table, dict):
        state[UNSETTLED] = {k: u for k, u in table.items()
                            if isinstance(u, dict) and t - float(u.get("at") or 0) <= NESTED_KEEP_S}


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


def unsettled(state: dict[str, Any], agent_id: str) -> dict[str, Any] | None:
    """The record of `agent_id` when it is an agent of a role whose own start is not known yet (register), else None."""
    got = state.get(UNSETTLED)
    u = got.get(agent_id) if isinstance(got, dict) and agent_id else None
    return u if isinstance(u, dict) else None


# --------------------------------------------------------------------------- what a hook decides and records


def open_claims(state: dict[str, Any], agent_type: Any) -> list[tuple[str, dict[str, Any]]]:
    """The starts of `agent_type` that an Agent call claimed and that no agent took up yet."""
    return [(rid, r) for rid, r in requests(state).items()
            if isinstance(r, dict) and r.get("kind") == "start" and r.get("state") == "claimed" and not r.get("agent")
            and (r.get("input") or {}).get("subagent_type") == agent_type]


def spawn_call(hook: dict[str, Any], agent_id: str) -> str | None:
    """The tool_use id of the Agent call that spawned `agent_id`: the `toolUseId` of the meta.json Claude Code writes
    beside its transcript (<session>/subagents/agent-<id>.meta.json, the session's transcript being the hook's
    `transcript_path`); None when it cannot be read. Claude Code writes the file after the agent's SubagentStart hooks
    end (2.1.295), so the file is there for the agent's later hooks, not for its SubagentStart."""
    path = str(hook.get("transcript_path") or "")
    if not path.endswith(".jsonl") or not re.fullmatch(r"[A-Za-z0-9_-]+", agent_id):
        return None
    meta = Path(path[:-len(".jsonl")]) / "subagents" / f"agent-{agent_id}.meta.json"
    try:
        got = json.loads(meta.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    call = got.get("toolUseId") if isinstance(got, dict) else None
    return str(call) if call else None


def _take(state: dict[str, Any], agent_id: str, rid: str, req: dict[str, Any], session: str) -> dict[str, Any]:
    """The agent `agent_id` of one of thimble's roles takes up the claimed start `rid` (`req`): its entry in the
    registry, which it returns, and the start is `started` by it. It waits no more (UNSETTLED)."""
    t = now()
    agent_type = str((req.get("input") or {}).get("subagent_type") or "")
    entry = {"key": req.get("key"), "type": agent_type, "role": role_of(agent_type), "request": rid,
             "parent": req.get("caller"), "chat": req.get("chat"), "run": 0,
             "values": req.get("values") or {}, "route": req.get("route"),
             "plugin_started": str(req.get("claimed_by") or "").startswith(PLUGIN_CALL),
             "sessions": [session] if session else [], "started": t, "last_start": t, "starts": 1,
             "status": "running", "work": req.get("work"), "handed_back": False}
    registry(state)[agent_id] = entry
    req.update(state="started", agent=agent_id, at=t)
    effort = str((req.get("values") or {}).get("effort") or "")
    if req.get("route") == "typed" and effort:
        efforts(state)[agent_id] = effort  # the module's step hook gives a typed run its effort
    if unsettled(state, agent_id) is not None:
        state[UNSETTLED].pop(agent_id, None)
    return entry


def eliminate(state: dict[str, Any]) -> list[str]:
    """The unsettled agents (UNSETTLED) that have one start left of the claims they could have: each takes it, as its own
    is among them and each other start was taken by its own agent or refused. Two unsettled agents that have the same one
    start left take nothing. The agents that took their start, in order."""
    out: list[str] = []
    while True:
        table = state.get(UNSETTLED)
        if not isinstance(table, dict) or not table:
            return out
        left: dict[str, list[str]] = {}
        for aid, u in table.items():
            if not isinstance(u, dict):
                continue
            open_ = {str(r["claimed_by"]): (rid, r) for rid, r in open_claims(state, u.get("type"))
                     if r.get("claimed_by")}
            left[aid] = [open_[call][0] for call in u.get("claims") or []
                         if call in open_ and not open_[call][1].get("spawned")]
        singles = [(aid, rids[0]) for aid, rids in left.items() if len(rids) == 1]
        pick = next(((aid, rid) for aid, rid in singles if sum(1 for _, r in singles if r == rid) == 1), None)
        if pick is None:
            return out
        aid, rid = pick
        _take(state, aid, rid, requests(state)[rid], str(table[aid].get("session") or ""))
        out.append(aid)


def settle(state: dict[str, Any], agent_id: str, call: str) -> list[str]:
    """The Agent call `call` started the agent `agent_id`, as its result, its PostToolUse hook or the agent's meta.json
    says: the start the call claimed is recorded as that agent's (`spawned`), and an unsettled agent (UNSETTLED) takes it
    up (_take), with any other unsettled agent that then has one start left (eliminate). An agent whose SubagentStart has
    not run yet takes it up there (register). The agents that took their start, in order; none for a start that has its
    agent already or that is no longer claimed."""
    if not agent_id or not call:
        return []
    hit = next(((rid, r) for rid, r in requests(state).items()
                if isinstance(r, dict) and r.get("kind") == "start" and r.get("claimed_by") == call), None)
    if hit is None:
        return []
    rid, req = hit
    if req.get("agent") or req.get("state") != "claimed":
        return []
    req["spawned"] = agent_id
    u = unsettled(state, agent_id)
    if u is None or isinstance(registry(state).get(agent_id), dict):
        return eliminate(state)  # the start is this agent's, so an unsettled agent that could have it has one left
    _take(state, agent_id, rid, req, str(u.get("session") or ""))
    return [agent_id, *eliminate(state)]


# --------------------------------------------------------------------------- callers.jsonl


def add_caller(ws: Path, tool_use_id: str, agent_id: str, agent_type: str) -> None:
    """One line of callers.jsonl (module note): the thimble call `tool_use_id` is the subagent `agent_id`'s, or main's own
    with `agent_id` empty. The file is trimmed to CALLERS_KEEP_S once it grows past CALLERS_TRIM_BYTES."""
    if not tool_use_id:
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
