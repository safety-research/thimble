"""thimble's agents in the analyst's terminal. Each is a subagent of main (subagents.py), so Claude Code's own agent tray
shows every one of them, its row named by its type and description (`thimble:orientation  orientation: <focus>`). What
thimble adds is the statusline and /thimble:agents.

The statusline. The launcher passes main plugin/bin/thimble-agents as its statusline command (statusline_command),
chained to the analyst's own; it shows the orientation's state and its cards, `thimble · orientation working · 7
cards`, and the browser's messages main has not got yet (events.queued_line). The other agents show as their own rows in
Claude Code's tray, so the statusline does not list them.

/thimble:agents lists thimble's running agents from the agent registry (subagent_rows), the code ticket and view builds
the server runs (dev.running_builds), and main's other subagents and threads' forks (session.running_agents; in terminal
mode, where no server follows main's session, the forks from the workspace's files: thread_rows_files).

In terminal mode no server runs. The list_agents tool runs in the MCP shim, where the registry (subagents.json) gives
thimble's subagents as in browser mode, and the statusline command reads the workspace's files itself
(plugin/bin/thimble-agents file_agents), as agents_route would answer.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from . import config, session
from . import subagent_files as files

log = logging.getLogger("thimble.tray")
router = APIRouter()

STATUS_CHARS = 110  # of one statusline line; more go on further lines
ROLE_WORDS = {"orientation": "orientation", "critic": "critique", "writer": "writer",  # how a row names each role
              "dev-ticket": "code ticket"}


def statusline_command(own: str = "") -> str:
    """The statusline command the launcher passes to main: plugin/bin/thimble-agents, which shows thimble's state
    (agents_route), chained to the analyst's statusline command `own`."""
    import shlex  # noqa: PLC0415

    cmd = f"{shlex.quote(str(config.REPO_ROOT / 'plugin' / 'bin' / 'thimble-agents'))} --statusline"
    return f"{cmd} --chain {shlex.quote(own)}" if own else cmd


def subagent_rows(c: str) -> list[dict[str, Any]]:
    """thimble's running agents from the registry (subagents.json), each {name, label, state, kind, chat, role}: the
    role and what it works on, and its state, `waiting` while it waits for its child (the orientation for its critic)
    or for a permission prompt in the terminal."""
    from . import events, subagents  # noqa: PLC0415

    rows: list[dict[str, Any]] = []
    asking = events.asking(c)
    every = subagents.agents_of(c)
    for agent_id, a in every.items():
        if a.get("role") not in subagents.ROLES or a.get("status") not in ("running", "waiting"):
            continue
        role = str(a["role"])
        key = str(a.get("key") or "")
        what = key.split(":", 1)[1] if ":" in key and role != "critic" else ""
        if role == "dev-ticket":  # the ticket by its number and title, not its id
            from . import dev  # noqa: PLC0415 — dev imports the view modules, which import this one's callers

            t = dev._get(what)
            what = f"#{t.get('n')} {t.get('title') or ''}".strip() if t else what
        word = ROLE_WORDS.get(role, role)
        # waiting for a child: its critic, or the subagents it started (helpers), which critique off never names
        kids = [k for k in every.values() if k.get("parent") == agent_id and k.get("status") in ("running", "waiting")]
        waits = "waiting for its critique" if any(k.get("role") == "critic" for k in kids) else "waiting for its subagents"
        state = "waiting for a permission" if agent_id in asking else (
            waits if a.get("status") == "waiting" else "working")
        rows.append({"name": subagents.type_name(role), "label": f"{word}: {what}" if what else word, "state": state,
                     "kind": "subagent", "chat": a.get("chat"), "role": role})
    return rows


def agent_rows(c: str) -> list[dict[str, Any]]:
    """Every agent of thimble's running in the workspace, for /thimble:agents: thimble's subagents (subagent_rows), the
    code ticket and view builds (dev.running_builds), and main's other subagents and threads' forks
    (session.running_agents), each {name, label?, state, kind}."""
    from . import dev  # noqa: PLC0415 — dev imports the views module, which imports this one's callers

    rows = subagent_rows(c)
    try:
        rows.extend(dev.running_builds(c))
    except Exception:  # noqa: BLE001 — the list shows what it can
        log.debug("%s: the builds were not listed", c, exc_info=True)
    known = {r.get("chat") for r in rows if r.get("chat")}
    rows.extend(r for r in session.running_agents(c) if r.get("chat") not in known)
    if files.terminal(config.workspace_path(c)):
        known = {r.get("chat") for r in rows if r.get("chat")}
        rows.extend(r for r in thread_rows_files(c) if r["chat"] not in known)
    return rows


THREAD_WORDS = 60  # of a thread's first question in its row


def _words(text: str, n: int = THREAD_WORDS) -> str:
    """`text` on one line in `n` characters, cut at the last word that fits, `…` right after it."""
    one = " ".join(text.split())
    if len(one) <= n:
        return one
    head = one[: n - 1]
    cut = head if one[n - 1] == " " else head.rsplit(" ", 1)[0] if " " in head[n // 2:] else head
    return cut.rstrip(" ,;:.!?") + "…"


def thread_rows_files(c: str) -> list[dict[str, Any]]:
    """The side threads whose fork runs now, in terminal mode, from the workspace's files (no server follows main's
    session there, so session.running_agents has none): a thread whose last question has no end yet (no `done` or
    `error` record after it) and whose fork main started (an Agent call the --agent-check hook recorded as starting,
    subagents.json `forking`, which fork_finished clears) or still runs in main's session (its meta's `fork`, not ended).
    Each {name, label, state, kind, chat}, the label the thread's first question."""
    from . import agents, session, threads  # noqa: PLC0415

    ws = config.workspace_path(c)
    state = files.read(ws)
    main = files.main_session(ws, state)
    table = state.get(files.FORKING)
    now = time.time()
    starting = {session.thread_for(c, desc) for desc, at in (table.items() if isinstance(table, dict) else [])
                if isinstance(at, (int, float)) and now - float(at) < files.FORK_DEDUPE_S}
    rows: list[dict[str, Any]] = []
    for meta in agents.list_chats(c):
        if meta.get("kind") != agents.KIND_THREAD:
            continue
        tid = str(meta["id"])
        fork = meta.get("fork") or {}
        live = bool(fork.get("agent_id")) and not fork.get("ended") and (not main or fork.get("session") == main)
        if tid not in starting and not live:
            continue
        records = agents.read_events(agents.paths(c, tid)[1])
        last_user = max((i for i, r in enumerate(records) if r.get("type") == "user"), default=-1)
        if last_user < 0 or any(r.get("type") in ("done", "error") for r in records[last_user + 1:]):
            continue
        question = next((str(r.get("text") or "") for r in records if r.get("type") == "user" and str(r.get("text") or "").strip()), "")
        name = f"fork {meta.get(threads.FORK_NAME_KEY) or meta.get('title') or tid}"
        # a fork that replied to the last question has answered, as the thread's row in main's chat says, though it may
        # still be finishing its turn
        replied = any(r.get("type") == "text" and r.get("reply") for r in records[last_user + 1:])
        rows.append({"name": name, "label": f'thread "{_words(question)}"' if question.strip() else name,
                     "state": "done" if replied else "working", "kind": "subagent", "chat": tid})
    return rows


def _cards(c: str) -> int:
    """The cards of the latest orientation's deck."""
    from . import notebook, orientation  # noqa: PLC0415

    deck = orientation.deck_of(orientation.read_run(c))
    nb = notebook.read_notebook(config.workspace_dir(c), deck) if deck else None
    return len([x for x in (nb or {}).get("cells") or [] if isinstance(x, dict)])


def status_line(c: str, rows: list[dict[str, Any]], chars: int = STATUS_CHARS) -> str:
    """Claude Code's statusline: the orientation's state and its cards, `thimble · orientation working · 7 cards`; ''
    while no orientation runs."""
    orient = next((r for r in rows if r.get("role") == "orientation"), None)
    if orient is None:
        return ""
    n = _cards(c)
    line = f"thimble · orientation {orient['state']} · {n} card{'' if n == 1 else 's'}"
    return line if len(line) <= chars else line[: chars - 1] + "…"


def plain_state(state: str) -> str:
    """A row's state as /thimble:agents lists it: starting, working, waiting for you, waiting, done or restarting."""
    first = state.split()[0].rstrip(",") if state else ""
    if first == "waiting":
        return "waiting for you" if "permission" in state else "waiting"
    return {"done": "done", "idle": "done", "ended": "done", "starting": "starting",
            "restarting": "restarting"}.get(first, "working")


def listing_text(rows: list[dict[str, Any]]) -> str:
    from . import tools  # noqa: PLC0415

    if not rows:
        return tools.hint("agents-none")
    labels = [str(r.get("label") or r["name"]) for r in rows]
    width = max(len(label) for label in labels)
    lines = [f"{label:<{width}}  {plain_state(r['state'])}" for label, r in zip(labels, rows)]
    return "\n".join(lines)


async def tool_list_agents(ctx: Any, args: dict[str, Any]) -> Any:
    """The `list_agents` tool (/thimble:agents): thimble's running agents, answered by this server."""
    from . import tools  # noqa: PLC0415

    return tools.ok(tools.hint("agents-print", text=listing_text(agent_rows(ctx.c))))


class AgentsQuery(BaseModel):
    cwd: str
    session: str | None = None
    announce: bool = False  # an older plugin's hooks ask for lines to print; there are none now


@router.post("/agents")
async def agents_route(body: AgentsQuery) -> dict[str, Any]:
    """thimble's agents for the folder's workspace: `{rows, line, text}` for the statusline and /thimble:agents. The
    statusline's `line` also holds the browser's messages that `session` has not got yet (events.queued_line)."""
    from . import events  # noqa: PLC0415

    c = config.workspace_for_cwd(body.cwd)
    if not c:
        return {"rows": [], "line": "", "text": "", "announce": ""}
    rows = agent_rows(c)
    line = "\n".join(x for x in (status_line(c, rows), events.queued_line(c, body.session, STATUS_CHARS)) if x)
    return {"rows": rows, "line": line, "text": listing_text(rows), "announce": ""}
