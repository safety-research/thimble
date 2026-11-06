"""Stand-ins for the tests of thimble's agents (subagents.py): the bridge to the runtime (app.module_bridge), a fixture a
test asks for by name, with the hint sections of prompts/tools.md whose filled-in words a test reads."""
from __future__ import annotations

import sys
import types
from typing import Any

import pytest

# hints the subagent paths name (prompts/tools.md), each with its placeholders, so a test reads what was filled in
HINTS = {
    "writer-context-file": "READ {path} FIRST",
    "main-stopped-note": "MAIN STOPPED",
}


class FakeBridge:
    """app.module_bridge's request (async, answering each op), with no runtime behind it. `answers` are what the next
    requests answer, in order; without one a spawn answers a new agent id and a send or stop {agentId}. Each request is
    kept in `calls` as (op, args)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.answers: list[Any] = []
        self.n = 0

    async def request(self, c: str, op: str, **args: Any) -> Any:
        self.calls.append((op, args))
        if self.answers:
            return self.answers.pop(0)
        self.n += 1
        if op == "spawn":
            return {"agentId": f"a{self.n:016x}"}
        return {"agentId": args.get("agent")}

    def ops(self, op: str) -> list[dict[str, Any]]:
        return [a for o, a in self.calls if o == op]


@pytest.fixture()
def bridge(monkeypatch) -> FakeBridge:
    """A FakeBridge installed as app.module_bridge, with the hints of HINTS."""
    import app
    from app import tools

    fake = FakeBridge()
    mod = types.ModuleType("app.module_bridge")
    mod.request = fake.request
    monkeypatch.setitem(sys.modules, "app.module_bridge", mod)
    # `from . import module_bridge` reads the package's attribute first, which the real bridge sets once any test has
    # imported it, so the fake replaces that too
    monkeypatch.setattr(app, "module_bridge", mod, raising=False)
    real = tools.descriptions
    monkeypatch.setattr(tools, "descriptions", lambda: {**real(), **HINTS})
    return fake
