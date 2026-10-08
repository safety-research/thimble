"""Stand-ins for what other lanes of the subagent change own, for the tests of thimble's agents as subagents
(subagents.py): the plugin module's bridge (app.module_bridge), main's fence check (cc_plugin.main_fenced) and the hint
sections prompts/tools.md gains for them. Each is a fixture a test asks for by name."""
from __future__ import annotations

import sys
import types
from typing import Any

import pytest

# the hints the subagent paths name (prompts/tools.md), each with its placeholders, so a test reads what was filled in
HINTS = {
    "start_orientation-subagent": "AGENT CALL {input}",
    "start_writing-subagent": "AGENT CALL {input}",
    "start_job-subagent": "AGENT CALL {input}",
    "critique-subagent": "AGENT CALL {input}",
    "orient-subagent-prompt": "{request_id}\nREQUEST {request}\nOUTPUTS {outputs}\nOFF {off}\nCRITIQUE {critique}",
    "orient-subagent-message": "SEND TO {agent}\n{text}",
    "agent-check-exact": "MAKE THE CALL EXACTLY",
    "agent-check-message": "ONLY WHEN THE ANALYST ASKS",
    "start-plan-mode": "PLAN MODE",
    "writer-context-file": "READ {path} FIRST",
    "critic-brief-file": "READ {path} FIRST",
    "start-refused-not-launched": "NOT LAUNCHED",
    "start-refused-no-module": "NO MODULE: {reason}",
    "orient-continue-earlier-session": "EARLIER SESSION: {resume}",
    "orient-continue-earlier-version": "EARLIER VERSION",
    "module-started-note": "STARTED {role} {agent} {what}",
    "follow-up-ran-on": "RAN ON {model} {effort}",
    "orient-continuation-prompt": "{request_id}\nSUMMARY {summary}\nCARDS {cards}\nTRANSCRIPTS {transcripts}\n"
                                  "OUTPUTS {outputs}\nOFF {off}\nCRITIQUE {critique}\nMESSAGE {message}",
    "message_orientation-continues": "CONTINUE WITH AGENT CALL {input}",
}


class FakeBridge:
    """app.module_bridge as lane M names it: live, why_not, request (async, answering each op), push_roles, main_session
    (`main`) and moved_to (through `moved`). `answers` are what the next requests answer, in order; without one a spawn
    answers a new agent id and a send or stop {agentId}. Each request is kept in `calls` as (op, args)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.answers: list[Any] = []
        self.is_live = True
        self.reason = ""
        self.n = 0
        self.main = "main-session"
        self.moved: dict[str, str] = {}

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

    def push_roles(self, c: str) -> None:
        self.calls.append(("push_roles", {}))

    def ops(self, op: str) -> list[dict[str, Any]]:
        return [a for o, a in self.calls if o == op]


@pytest.fixture()
def bridge(monkeypatch) -> FakeBridge:
    """A FakeBridge installed as app.module_bridge, with main fenced (cc_plugin.main_fenced) and the hints of HINTS."""
    import app
    from app import cc_plugin, tools

    fake = FakeBridge()
    mod = types.ModuleType("app.module_bridge")
    for name in ("live", "why_not", "request", "push_roles", "main_session", "moved_to"):
        setattr(mod, name, getattr(fake, name))
    monkeypatch.setitem(sys.modules, "app.module_bridge", mod)
    # `from . import module_bridge` reads the package's attribute first, which the real bridge sets once any test has
    # imported it, so the fake replaces that too
    monkeypatch.setattr(app, "module_bridge", mod, raising=False)
    monkeypatch.setattr(cc_plugin, "main_fenced", lambda c: True, raising=False)
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
