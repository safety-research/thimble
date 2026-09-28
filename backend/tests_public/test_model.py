"""model.py's structured(): a valid tool call comes back as the output, with the model, cost and session it ran on. The
fakes yield real SDK dataclasses through the stream model.structured() drains."""

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

from app import model
from app.model import ToolSpec


def _no_real_cli(opts):
    raise AssertionError("no fake SDK client installed: this test would have spawned a real `claude` session")


@pytest.fixture(autouse=True)
def _fresh_backend_state(monkeypatch):
    """No forced backend, no cached API client, no remembered forced-tool bans between tests, and no real CLI: a
    test that reaches the SDK path without `install()` fails at once instead of running a real session on this
    machine's credentials."""
    monkeypatch.delenv("THIMBLE_MODEL_BACKEND", raising=False)
    monkeypatch.setattr(model, "_api_client", None)
    monkeypatch.setattr(model, "_api_client_cred", None)
    monkeypatch.setattr(model, "_api_sem", None)
    monkeypatch.setattr(model, "_make_client", _no_real_cli)
    monkeypatch.setattr(model.config, "FALLBACK_MODEL", FALLBACK)
    model._API_NO_FORCED_TOOL.clear()
    yield
    model._API_NO_FORCED_TOOL.clear()

FALLBACK = "claude-opus-4-8"

SPEC = ToolSpec(
    name="report",
    description="Return the report.",
    input_schema={
        "type": "object",
        "properties": {"title": {"type": "string"}, "n": {"type": "integer"}},
        "required": ["title"],
        "additionalProperties": False,
    },
)


def tuse(input, name="mcp__out__report", id="t1"):
    return ToolUseBlock(id=id, name=name, input=input)


def amsg(*blocks, **kw):
    kw.setdefault("model", "claude-sonnet-5")
    return AssistantMessage(content=list(blocks), **kw)


def rmsg(**kw):
    base = dict(subtype="success", duration_ms=10, duration_api_ms=8, is_error=False, num_turns=1,
                session_id="sess-1")
    base.update(kw)
    return ResultMessage(**base)


class FakeClient:
    """Scripted SDK client: one list of messages per turn (per query)."""

    def __init__(self, turns, opts=None):
        self.turns = [list(t) for t in turns]
        self.opts = opts
        self.queries: list[str] = []
        self.exited = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.exited = True
        return False

    async def query(self, prompt, session_id="default"):
        self.queries.append(prompt)

    async def receive_response(self):
        for m in self.turns.pop(0):
            yield m


def install(monkeypatch, sessions, cls=FakeClient, **extra):
    """sessions: one entry per client the call may create; each entry is a list of per-turn message lists."""
    made: list[FakeClient] = []

    def make(opts):
        c = cls(sessions[len(made)], opts=opts, **extra) if extra else cls(sessions[len(made)], opts=opts)
        made.append(c)
        return c

    monkeypatch.setattr(model, "_make_client", make)
    return made


async def call(**kw):
    kw.setdefault("tool", SPEC)
    kw.setdefault("model", "claude-sonnet-5")
    kw.setdefault("cwd", "/tmp")
    return await model.structured("the prompt", **kw)


# ----------------------------------------------------------------------------- happy path


async def test_ok_valid_tool_call(monkeypatch):
    made = install(monkeypatch, [[[
        amsg(TextBlock(text="writing it now"), tuse({"title": "T", "n": 2})),
        rmsg(model_usage={"claude-sonnet-5": {"inputTokens": 1}}, total_cost_usd=0.12),
    ]]])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "T", "n": 2}
    assert r.model_requested == "claude-sonnet-5" and r.model_used == "claude-sonnet-5"
    assert r.fallback_note == "" and r.detail == ""
    assert r.attempts == 1 and r.cost_usd == 0.12 and r.session_id == "sess-1"
    assert r.duration_s >= 0 and len(made) == 1 and made[0].exited
