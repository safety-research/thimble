"""A code ticket's thimble tools. The ticket's agent (`thimble:dev-ticket`, dev.py) is a subagent of the analyst's Claude
Code session that works in the ticket's git worktree, and the gates the server ran around a `claude -p` session are
tools it calls:

  ticket_checks  the gates over what the worktree changed since the ticket's base (dev.checks_now), in the ticket's box
                 where it has one, as often as the agent wants; nothing is committed
  finish_ticket  the agent's end: the server commits every change in the worktree to the ticket's branch and runs the
                 gates of record over the branch (dev.gates_of_record); a pass records that commit as the change the
                 analyst is asked to apply, a failure answers what failed and the attempt, up to dev.MAX_ATTEMPTS

Each runs only for the agent registered for the key its call runs as (`ticket:<id>`), itself and not a descendant of it,
whose run goes now: never for main (its Spec names no session of main's) or another agent. finish_ticket blocks while
its gates run, is cancelled when its caller drops the call (tools.Spec.drop_stops: Claude Code closes it when the agent
is stopped), registers a pass only for a caller still running, and after the last attempt runs nothing. An agent still
running view_tools.FINISH_GRACE_S after its pass or its last attempt is stopped through the module, and its end settles
the ticket as the tool said (dev.ticket_ended reads the outcome the tool kept on the ticket)."""
from __future__ import annotations

import logging
from typing import Any

from . import subagents, tools, view_tools

log = logging.getLogger("thimble.ticket_tools")

ROLE = "dev-ticket"  # subagents.TYPES
TICKET_TOOLS = ("read_ref", "ticket_checks", "finish_ticket")  # a ticket's agent's thimble tools
# the fixed description main's agent list shows (V5: main keeps the first description it sees)
DESCRIPTION = ("thimble's developer agent for one code ticket, a change to thimble's own code. thimble starts it, or "
               "gives the exact Agent call that starts it.")
NOT_YOURS = "{tool} is the tool of the agent thimble started for this ticket, and this call is not that agent's"


def definition(c: str) -> dict[str, Any]:
    """The registration of `thimble:dev-ticket` for workspace `c` (subagents.roles adds its model, effort and
    `background`): prompts/dev.md with prompts/dev-ticket.md, the fixed part of every code ticket (the dev agent's
    prompt as the config changes it), a fixed description, and the thimble tools that are not a ticket's taken away. The
    ticket a run works on is in its prompt (dev.build_ticket_task)."""
    from . import dev, prompts, userconf  # noqa: PLC0415 — dev imports the view modules, which import this one

    with prompts.custom(userconf.prompt_files(c, "dev")):
        prompt = prompts.render_dev("dev-ticket", {"attempts": str(dev.MAX_ATTEMPTS)})
    return {"description": DESCRIPTION, "prompt": prompt, "disallowedTools": tools.not_own(TICKET_TOOLS)}


class Refused(Exception):
    """A ticket tool's call that may not run: its message is the tool's error result."""


async def _caller(ctx: Any, tool: str) -> tuple[str, str]:
    """(ticket id, agent id) of the ticket and the agent a call of `tool` runs for: the ticket's agent registered for the
    key its call runs as, itself and not a descendant of it, whose run goes now. Refused otherwise."""
    key = str(ctx.session or "")
    tid = key.split(":", 1)[1] if ":" in key else ""
    if tools.session_kind(key) != tools.TICKET_SESSION or not tid:
        raise Refused(NOT_YOURS.format(tool=tool))
    who = await subagents.caller(ctx.c, ctx.tool_use_id) if ctx.tool_use_id else None
    run = subagents.current(ctx.c, key)
    if who is None or run is None or who.agent_id != who.root or who.role != ROLE or who.agent_id != run.agent_id:
        raise Refused(NOT_YOURS.format(tool=tool))
    return tid, who.agent_id


def _ticket(tid: str, agent_id: str, tool: str) -> dict[str, Any]:
    """The ticket the call works on, while it runs with `agent_id` as its agent and its worktree is there."""
    from . import dev  # noqa: PLC0415

    t = dev._get(tid)
    if t is None or t.get("status") != "running" or t.get("agent_id") != agent_id or not t.get("worktree"):
        raise Refused(f"{tool}: the ticket is not running with this agent any more")
    return t


async def tool_ticket_checks(ctx: Any, args: dict[str, Any]) -> Any:
    """`ticket_checks`: the gates over the change in the caller's ticket's worktree, committed or not, in its box where it
    has one (dev.checks_now). Nothing is committed and no attempt is counted."""
    from . import dev  # noqa: PLC0415

    try:
        tid, agent_id = await _caller(ctx, "ticket_checks")
        t = _ticket(tid, agent_id, "ticket_checks")
    except Refused as e:
        return tools.err(str(e))
    try:
        validation = await dev.checks_now(t)
    except dev.GitError as e:
        return tools.err(f"ticket_checks: thimble could not read the worktree's change: {e}")
    if validation is None:
        return tools.ok(tools.hint("ticket-checks-empty"))
    head = "The checks pass." if validation["ok"] else "The checks fail."
    return tools.ok(f"{head}\n{dev._gate_report(validation)}")


async def tool_finish_ticket(ctx: Any, args: dict[str, Any]) -> Any:
    """`finish_ticket`: the agent's end. The server commits the worktree's change and runs the gates of record over the
    branch (dev.gates_of_record); a pass records the commit as the change the analyst is asked to apply, a failure
    answers what failed and the attempt, and the last failure, or a call after it, tells the agent to stop, each of these
    as an error result. A call with no change runs no gates and counts no attempt. The attempts are counted on the
    ticket."""
    from . import dev  # noqa: PLC0415

    try:
        tid, agent_id = await _caller(ctx, "finish_ticket")
        t = _ticket(tid, agent_id, "finish_ticket")
    except Refused as e:
        return tools.err(str(e))
    c, key = ctx.c, dev.ticket_key(tid)
    done = t.get("finish") if isinstance(t.get("finish"), dict) and t["finish"].get("agent") == agent_id else None
    if done is not None and done.get("result") == "pass":
        return tools.ok(tools.hint("finish-ticket-pass"))
    attempt = int(t.get("attempt") or 0)
    if attempt >= dev.MAX_ATTEMPTS:
        return tools.err(tools.hint("finish-ticket-stop"))
    try:
        got = await dev.gates_of_record(t, dev._log_for(t))
    except dev.GitError as e:  # nothing was checked, so no attempt is counted
        return tools.err(f"finish_ticket: thimble could not commit the worktree's change, so nothing was checked: {e}")
    if got is None:
        return tools.err(tools.hint("finish-ticket-empty"))
    attempt += 1
    if not view_tools.still_running(c, key, agent_id):
        log.info("%s: the checks of ticket %s ended after its agent %s stopped, so they register nothing", c, tid, agent_id)
        dev._update(tid, attempt=attempt)
        return tools.err(f"finish_ticket: the ticket {tid} was stopped, so nothing was registered")
    if got["ok"]:
        dev._update(tid, attempt=attempt, finish={"agent": agent_id, "result": "pass", "change": got["change"]},
                    change=got["change"], touched=got["touched"], validation=got["validation"], last_report=None)
        view_tools.stop_after_grace(c, key, agent_id)
        return tools.ok(tools.hint("finish-ticket-pass"))
    report = got["report"]
    if attempt >= dev.MAX_ATTEMPTS:
        dev._update(tid, attempt=attempt, touched=got["touched"], validation=got["validation"],
                    finish={"agent": agent_id, "result": "stop", "report": report[:dev.ERROR_CHARS]})
        view_tools.stop_after_grace(c, key, agent_id)
        return tools.err(tools.hint("finish-ticket-stop"))
    dev._update(tid, attempt=attempt, touched=got["touched"], validation=got["validation"],
                last_report=report[:dev.ERROR_CHARS])
    return tools.err(tools.hint("finish-ticket-fail", report=report, n=str(attempt), of=str(dev.MAX_ATTEMPTS)))
