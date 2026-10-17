"""Stand-ins for what other lanes of the subagent change own, for the tests of thimble's agents as subagents
(subagents.py): the plugin module's bridge (app.module_bridge) and the hint sections prompts/tools.md gains for them.
Each is a fixture a test asks for by name."""
from __future__ import annotations

import sys
import types
from typing import Any

import pytest

from app import module_bridge as real_bridge  # the real one, imported before any test puts the fake in its place
from app.call_result import NO_SESSION

# the hints the subagent paths name (prompts/tools.md), each with its placeholders, so a test reads what was filled in
HINTS = {
    "start_orientation-subagent": "AGENT CALL {input}",
    "start_writing-subagent": "AGENT CALL {input}",
    "start_job-subagent": "AGENT CALL {input}",
    "critique-subagent": "AGENT CALL {input}",
    "orient-subagent-prompt": "{request_id}\nREQUEST {request}",
    "orient-subagent-message": "SEND TO {agent}\n{text}",
    "agent-check-exact": "MAKE THE CALL EXACTLY",
    "agent-check-message": "ONLY WHEN THE ANALYST ASKS",
    "start-plan-mode": "PLAN MODE",
    "writer-context-file": "READ {path} FIRST",
    "writer-context-files": "READ {n} FILES {paths} FIRST",
    "critic-brief-file": "READ {path} FIRST",
    "critic-brief-files": "READ {n} FILES {paths} FIRST",
    "check-task-files": "READ {n} FILES {paths} FIRST",
    "start-refused-no-module": "NO MODULE: {reason}",
    "start-refused-waiting": "WAITING: {reason}",
    "orient-continue-earlier-session": "EARLIER SESSION: {session}",
    "orient-continue-earlier-version": "EARLIER VERSION",
    "module-started-note": "STARTED {role} {agent} {what}",
    "main-stopped-note": "MAIN STOPPED",
    "thread-stopped-note": "THREAD STOPPED {thread} {agent_id}",
    "follow-up-ran-on": "RAN ON {model} {effort}",
    "orient-continuation-prompt": "{request_id}\nSUMMARY {summary}\nCARDS {cards}\nTRANSCRIPTS {transcripts}\n"
                                  "MESSAGE {message}",
    "message_orientation-continues": "CONTINUE WITH AGENT CALL {input}",
}


class FakeBridge:
    """app.module_bridge as lane M names it: live, why_not, request (async, answering each op), model (a model call,
    answered by `respond`), push_roles, main_session (`main`) and moved_to (through `moved`), and the words of a missing
    module as module_bridge gives them (session_runs: `runs`, needs_restart, no_session_text). `answers` are what the
    next requests answer, in order; without one a spawn answers a new agent id and a send or stop {agentId}. Each request
    is kept in `calls` as (op, args), a model call as (complete or fork, args)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.answers: list[Any] = []
        self.is_live = True
        self.reason = ""
        self.n = 0
        self.main = "main-session"
        self.moved: dict[str, str] = {}
        # a model call's answer, from its op and args (module_bridge.model): the reply's text, or why there is none
        self.respond: Any = lambda op, args: {"error": "the fake bridge has no answer for this model call"}
        self.running = 0  # model calls that run now
        self.most = 0  # model calls that ran at once, at most
        self.runs = False  # a Claude Code session runs thimble in the folder (module_bridge.session_runs)

    def main_session(self, c: str) -> str:
        return self.main

    def moved_to(self, c: str, sid: str) -> str:
        while sid in self.moved:
            sid = self.moved[sid]
        return sid

    def live(self, c: str) -> bool:
        return self.is_live

    def why_not(self, c: str) -> str:
        return self.reason

    async def request(self, c: str, op: str, **args: Any) -> Any:
        self.calls.append((op, args))
        if self.answers:
            return self.answers.pop(0)
        self.n += 1
        if op == "spawn":
            return {"agentId": f"a{self.n:016x}"}
        return {"agentId": args.get("agent")}

    async def model(self, c: str, op: str, args: dict[str, Any], *, timeout_s: float) -> Any:
        self.calls.append((op, {**args, "timeout_s": timeout_s}))
        if not self.is_live:
            return {"no-module": self.reason or "no module"}
        self.running += 1
        self.most = max(self.most, self.running)
        try:
            got = self.respond(op, args)
            return await got if hasattr(got, "__await__") else got
        finally:
            self.running -= 1

    def push_roles(self, c: str) -> None:
        self.calls.append(("push_roles", {}))

    def session_runs(self, c: str) -> bool:
        return self.runs

    def needs_restart(self, c: str, why: str) -> bool:
        return not self.runs or not (why in real_bridge.FOLLOW_REASONS or why.startswith(real_bridge.NOT_ANSWERING))

    def no_session_text(self, c: str) -> str:
        return f"{real_bridge.NOT_ANSWERING}: {self.reason}" if self.runs else NO_SESSION

    def ops(self, op: str) -> list[dict[str, Any]]:
        return [a for o, a in self.calls if o == op]


@pytest.fixture()
def bridge(monkeypatch) -> FakeBridge:
    """A FakeBridge installed as app.module_bridge, with the hints of HINTS."""
    import app
    from app import tools

    fake = FakeBridge()
    mod = types.ModuleType("app.module_bridge")
    for name in ("live", "why_not", "request", "model", "push_roles", "main_session", "moved_to", "session_runs",
                 "needs_restart", "no_session_text"):
        setattr(mod, name, getattr(fake, name))
    mod.NO_MODULE = "no-module"  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "app.module_bridge", mod)
    # `from . import module_bridge` reads the package's attribute first, which the real bridge sets once any test has
    # imported it, so the fake replaces that too
    monkeypatch.setattr(app, "module_bridge", mod, raising=False)
    real = tools.descriptions
    monkeypatch.setattr(tools, "descriptions", lambda: {**real(), **HINTS})
    return fake


@pytest.fixture()
def hints(monkeypatch) -> dict[str, str]:
    """The hints of HINTS, for prompts/tools.md before lane D adds them."""
    from app import tools

    real = tools.descriptions
    monkeypatch.setattr(tools, "descriptions", lambda: {**real(), **HINTS})
    return HINTS
