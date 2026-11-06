"""How the rest of the server asks for thimble's agents and for main's running turn (subagents.py's clicks, follow-ups
and stops, the jobs of dev.py and checks.py): `request(c, op, **args)` has the runtime do it (runtime.module_op), which
runs main and every agent itself (runtime.py). An Answer is a dict with exactly one of these keys:
    agentId     the agent started, sent to or stopped (`model` the model a spawn resolved; `queued`: a message waits
                for a running agent's next turn rather than starting one)
    error       anything else (`gone`: the agent had ended already, or no turn of main's ran)
    ok          an abort or a note went through
Ops and their arguments:
    spawn  role, prompt, description, values {model, effort}, what, request, route
                                          start an agent of the role with the run's values
    send   agent, text, role, values      a message to an agent, which runs again on it
    stop   agent                          stop an agent's run
    abort                                 stop main's running turn (the analyst's Stop of main)
    note   text                           a note main reads at its next turn
`request` is a coroutine for the server's loop.
"""
from __future__ import annotations

from typing import Any

OPS = ("spawn", "send", "stop", "abort", "note")

Answer = dict  # module note: exactly one of agentId, error and ok, plus the extras named there


async def request(c: str, op: str, **args: Any) -> Answer:
    """Have the runtime do `op` in workspace `c` (module note). Never raises for the agent's sake: a refusal is an
    answer."""
    if op not in OPS:
        raise ValueError(f"unknown op {op!r}")
    from . import runtime  # noqa: PLC0415

    return await runtime.module_op(c, op, dict(args))
