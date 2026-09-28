"""model.py: two backends behind structured(), each faked per failure class. A refusal runs again once on the fallback
model and says which model refused, an auth error is never retried, a 429 is retried once, 5xx and overloaded follow
the backoff schedule, a stall returns a timeout status rather than raising, an invalid schema fails without a call, and
no credential is written into the environment.

SDK path: the fakes yield real SDK dataclasses through the stream model.structured() drains. Key path: a fake
Messages API client returns real anthropic response types or raises real anthropic exceptions.
"""
import asyncio
import os

import anthropic
import httpx
import pytest
from types import SimpleNamespace
from anthropic.types import Message as ApiMessage
from anthropic.types import TextBlock as ApiTextBlock
from anthropic.types import ToolUseBlock as ApiToolUseBlock
from anthropic.types import Usage as ApiUsage
from claude_agent_sdk import (
    AssistantMessage,
    ProcessError,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

from app import model, retry, sdk
from app.model import CallResult, ToolSpec


REAL_API_CREDENTIALS = model.config.api_credentials  # install_api stubs the resolver; tests of the real order restore this


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


# ----------------------------------------------------------------------------- corrective retries (same session)


# ----------------------------------------------------------------------------- terminal failures, never retried here


def _refused_turn():
    return [amsg(TextBlock(text="I can't help with that."), stop_reason="refusal"), rmsg()]


@pytest.fixture(autouse=True)
def _no_rate_limit_wait(monkeypatch):
    """The one wait-and-retry on a 429 sleeps RATE_LIMIT_RETRY_S (45 s) in production; tests wait 0."""
    monkeypatch.setattr(model, "RATE_LIMIT_RETRY_S", 0.0)


def _limited_turn():
    return [amsg(TextBlock(text="x")), rmsg(is_error=True, api_error_status=429)]


# ----------------------------------------------------------------------------- fresh-session retry on 5xx


@pytest.fixture()
def waits(monkeypatch) -> list[float]:
    """retry._sleep records the backoff waits (retry.model_knobs' schedule) instead of sleeping."""
    seen: list[float] = []

    async def fake_sleep(s: float) -> None:
        seen.append(s)

    monkeypatch.setattr(retry, "_sleep", fake_sleep)
    return seen


OVERLOADED_200 = 'API Error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'  # no status
INVALID_200 = 'API Error: {"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}'


# ----------------------------------------------------------------------------- timeout, exceptions, schema sanity


# ----------------------------------------------------------------------------- credentials and the backend choice


def _isolate_auth(monkeypatch, tmp_path):
    """Exercise the real resolvers (no THIMBLE_SKIP_KEY) without reading this machine's Claude settings or its
    environment: the shell's own credential is removed first, so no assertion diff can ever print it."""
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.setattr(model.config, "REPO_ROOT", tmp_path / "repo")


# ----------------------------------------------------------------------------- the API-key path, on a fake client alone,
# so no test reaches the network

API_REQ = httpx.Request("POST", "https://api.anthropic.com/v1/messages")


def api_msg(*blocks, stop_reason="tool_use", model_name="claude-sonnet-5"):
    return ApiMessage(id="m1", type="message", role="assistant", model=model_name, stop_reason=stop_reason,
                      stop_sequence=None, content=list(blocks), usage=ApiUsage(input_tokens=10, output_tokens=5))


def api_tuse(input, name="report", id="t1"):
    return ApiToolUseBlock(type="tool_use", id=id, name=name, input=input)


def api_text(text):
    return ApiTextBlock(type="text", text=text)


def api_error(cls, status, message="boom", headers=None):
    return cls(message, response=httpx.Response(status, request=API_REQ, headers=headers or {}), body=None)


STALL = object()  # a scripted entry that hangs forever where output was expected


class FakeAPIStream:
    """What entering `client.messages.stream(...)` yields: events, then the accumulated final message."""

    def __init__(self, message, n_events, gap):
        self._message = message
        self._n = n_events
        self._gap = gap

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for i in range(self._n):
            if self._gap:
                await asyncio.sleep(self._gap)
            yield {"type": "content_block_delta", "i": i}

    async def get_final_message(self):
        return self._message


class FakeAPIStreamManager:
    """The manager `messages.stream()` returns. Exceptions raise on enter, as the real request does; a STALL
    entry hangs on enter, like a server that never answers."""

    def __init__(self, item, n_events, gap):
        self._item = item
        self._n = n_events
        self._gap = gap

    async def __aenter__(self):
        if self._item is STALL:
            await asyncio.sleep(3600)
        if isinstance(self._item, Exception):
            raise self._item
        return FakeAPIStream(self._item, self._n, self._gap)

    async def __aexit__(self, *exc):
        return False


class FakeAPIMessages:
    def __init__(self, outer, via="messages"):
        self._outer = outer
        self._via = via  # the namespace this one stands for: "messages", or "beta.messages" (fast mode)

    def stream(self, **kwargs):
        self._outer.requests.append(kwargs)
        self._outer.vias.append(self._via)
        return FakeAPIStreamManager(self._outer.script.pop(0), self._outer.n_events, self._outer.gap)


class FakeAPIClient:
    """Scripted Messages API client: one final message, exception, or STALL per stream()."""

    def __init__(self, script, *, n_events=2, gap=0.0):
        self.script = list(script)
        self.requests: list[dict] = []
        self.vias: list[str] = []  # per request, the namespace it went through
        self.n_events = n_events
        self.gap = gap
        self.messages = FakeAPIMessages(self)
        self.beta = SimpleNamespace(messages=FakeAPIMessages(self, via="beta.messages"))


def install_api(monkeypatch, script, *, backend="api", **client_kw):
    fake = FakeAPIClient(script, **client_kw)
    fake.creds = []  # the credential structured() hands to _make_api_client per call

    def make(cred=None):
        fake.creds.append(cred)
        return fake

    monkeypatch.setattr(model, "_make_api_client", make)
    monkeypatch.setattr(model.config, "HAS_API_KEY", True)
    # a credential resolves (the forced api path falls back to the SDK without one); a test of the order overrides it
    monkeypatch.setattr(model.config, "api_credentials", lambda: ("api_key", "sk-test-fake"))
    if backend:
        monkeypatch.setenv("THIMBLE_MODEL_BACKEND", backend)
    return fake


API_BODY_OVERLOADED = "{'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}"
API_BODY_INVALID = "{'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'bad request'}}"


class StallableClient(FakeClient):
    """A STALL entry in a scripted turn hangs forever at that point, like a wedged CLI."""

    async def receive_response(self):
        for m in self.turns.pop(0):
            if m is STALL:
                await asyncio.sleep(3600)
            yield m


CONNECT_STALL = object()  # a session whose first scripted entry is this hangs forever in __aenter__
CONNECT_ERROR = object()  # ... raises the SDK's bounded initialize-timeout shape from __aenter__


# ----------------------------------------------------------------------------- sdk.py and the public names


FAST_SETTINGS = {"fastMode": True}
