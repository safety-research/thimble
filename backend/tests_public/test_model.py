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


async def test_ok_even_with_prose_around_the_call(monkeypatch):
    install(monkeypatch, [[[amsg(TextBlock(text="Here is prose."), tuse({"title": "T"})), rmsg()]]])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "T"} and r.text == "Here is prose."


async def test_last_tool_call_wins(monkeypatch):
    install(monkeypatch, [[[
        amsg(tuse({"title": "first"}, id="t1"), tuse({"title": "second"}, id="t2")), rmsg(),
    ]]])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "second"}


async def test_other_tools_are_not_captured(monkeypatch):
    install(monkeypatch, [[[amsg(tuse({"title": "x"}, name="mcp__other__report")), rmsg()],
                           [amsg(tuse({"title": "real"})), rmsg()]]])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "real"} and r.attempts == 2


async def test_truncated_carries_the_output_tools_partial_input(monkeypatch):
    """CallResult.partial: a reply cut off by max_tokens carries the output tool's last
    call as the CLI parsed it — invalid against the schema, so not captured — for continuation.call_continuing to
    continue from; None when no tool call had started (prose only)."""
    install(monkeypatch, [[[amsg(TextBlock(text="writing"), tuse({"title": "T", "n": "cut mid-way"}), stop_reason="max_tokens"), rmsg()]]])
    r = await call()
    assert r.status == "truncated" and r.output is None and r.partial == {"title": "T", "n": "cut mid-way"}
    install(monkeypatch, [[[amsg(TextBlock(text="very long..."), stop_reason="max_tokens"), rmsg()]]])
    r = await call()
    assert r.status == "truncated" and r.partial is None
    # a valid call that ended in max_tokens is ok, so it carries no partial
    install(monkeypatch, [[[amsg(tuse({"title": "T"}), stop_reason="max_tokens"), rmsg()]]])
    r = await call()
    assert r.status == "ok" and r.partial is None


# ----------------------------------------------------------------------------- corrective retries (same session)


async def test_prose_only_gets_one_corrective_turn_in_same_session(monkeypatch):
    made = install(monkeypatch, [[
        [amsg(TextBlock(text="I think the answer is...")), rmsg()],
        [amsg(tuse({"title": "T"})), rmsg()],
    ]])
    r = await call()
    assert r.status == "ok" and r.attempts == 2 and len(made) == 1
    assert made[0].queries[0] == "the prompt"
    assert "Return the output by calling the `report` tool exactly once" in made[0].queries[1]
    assert "Do not answer in prose." in made[0].queries[1]


async def test_schema_violation_named_in_corrective_message(monkeypatch):
    made = install(monkeypatch, [[
        [amsg(tuse({"n": 3})), rmsg()],  # missing required "title"
        [amsg(tuse({"title": "T", "n": 3})), rmsg()],
    ]])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "T", "n": 3} and r.attempts == 2
    assert "correcting:" in made[0].queries[1] and "title" in made[0].queries[1]


async def test_corrective_exhausted_is_no_tool_call(monkeypatch):
    made = install(monkeypatch, [[
        [amsg(TextBlock(text="prose one")), rmsg()],
        [amsg(TextBlock(text="prose two")), rmsg()],
    ]])
    r = await call(corrective_retries=1)
    assert r.status == "no_tool_call" and r.output is None and r.attempts == 2 and len(made) == 1
    assert "report" in r.detail and r.text == "prose two"


async def test_invalid_args_only_is_no_tool_call_with_violation(monkeypatch):
    install(monkeypatch, [[
        [amsg(tuse({"n": "not-an-int"})), rmsg()],
        [amsg(tuse({"n": False})), rmsg()],
    ]])
    r = await call()
    assert r.status == "no_tool_call" and "schema" in r.detail


# ----------------------------------------------------------------------------- terminal failures, never retried here


def _refused_turn():
    return [amsg(TextBlock(text="I can't help with that."), stop_reason="refusal"), rmsg()]


async def test_a_refusal_runs_again_once_on_the_fallback_model(monkeypatch):
    """A safety classifier's stop is not retried on the model that refused: the whole call runs again, once, in a fresh
    session on the fallback model, and the result names the model that refused it."""
    made = install(monkeypatch, [
        [_refused_turn()],
        [[amsg(tuse({"title": "T"}), model=FALLBACK), rmsg(model_usage={FALLBACK: {"inputTokens": 1}})]],
    ])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "T"}
    assert r.refused_by == "claude-sonnet-5" and r.model_requested == FALLBACK and r.model_used == FALLBACK
    assert [m.opts.model for m in made] == ["claude-sonnet-5", FALLBACK]
    assert len(made[0].queries) == 1 and r.attempts == 2


async def test_a_refusal_on_the_fallback_model_or_with_the_fallback_off_is_terminal(monkeypatch):
    made = install(monkeypatch, [[_refused_turn()]])
    r = await call(model=FALLBACK)
    assert r.status == "refused" and r.attempts == 1 and len(made) == 1 and r.refused_by == ""
    assert r.text == "I can't help with that." and "refus" in r.detail

    monkeypatch.setattr(model.config, "FALLBACK_MODEL", "")
    made = install(monkeypatch, [[_refused_turn()]])
    r = await call()
    assert r.status == "refused" and len(made) == 1 and r.refused_by == ""


async def test_a_fallback_that_refuses_too_ends_refused_and_still_names_the_first_model(monkeypatch):
    made = install(monkeypatch, [[_refused_turn()], [_refused_turn()]])
    r = await call()
    assert r.status == "refused" and len(made) == 2 and r.attempts == 2
    assert r.refused_by == "claude-sonnet-5" and r.model_requested == FALLBACK


@pytest.fixture(autouse=True)
def _no_rate_limit_wait(monkeypatch):
    """The one wait-and-retry on a 429 sleeps RATE_LIMIT_RETRY_S (45 s) in production; tests wait 0."""
    monkeypatch.setattr(model, "RATE_LIMIT_RETRY_S", 0.0)


def _limited_turn():
    return [amsg(TextBlock(text="x")), rmsg(is_error=True, api_error_status=429)]


async def test_rate_limited_by_http_429_is_retried_once_then_terminal(monkeypatch):
    made = install(monkeypatch, [[_limited_turn()], [_limited_turn()]])
    r = await call()
    assert r.status == "rate_limited" and r.attempts == 2 and len(made) == 2  # one wait-and-retry, never a third


async def test_rate_limit_retry_succeeds_in_a_fresh_session(monkeypatch):
    """A 429 is usually over within a minute, so the one retry, in a fresh session, succeeds."""
    made = install(monkeypatch, [[_limited_turn()], [[amsg(tuse({"title": "T"})), rmsg()]]])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "T"} and r.attempts == 2 and len(made) == 2


async def test_rate_limited_by_assistant_error(monkeypatch):
    install(monkeypatch, [[[amsg(TextBlock(text="x"), error="rate_limit"), rmsg(is_error=True)]],
                          [[amsg(TextBlock(text="x"), error="rate_limit"), rmsg(is_error=True)]]])
    r = await call()
    assert r.status == "rate_limited"


async def test_auth_error_never_retried(monkeypatch):
    made = install(monkeypatch, [[[amsg(TextBlock(text="x"), error="authentication_failed"),
                                   rmsg(is_error=True)]]])
    r = await call()
    assert r.status == "error" and "authentication_failed" in r.detail
    assert r.attempts == 1 and len(made) == 1


async def test_no_result_message_is_an_error(monkeypatch):
    install(monkeypatch, [[[amsg(TextBlock(text="x"))]]])
    r = await call()
    assert r.status == "error" and "result" in r.detail


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


async def test_529_gets_a_fresh_session_retry_on_the_backoff_schedule(monkeypatch, waits):
    made = install(monkeypatch, [
        [[amsg(TextBlock(text="boom")), rmsg(is_error=True, api_error_status=529)]],
        [[amsg(tuse({"title": "T"})), rmsg()]],
    ])
    r = await call()
    assert r.status == "ok" and r.attempts == 2 and len(made) == 2
    assert waits == [5.0]  # the schedule's first wait (THIMBLE_MODEL_RETRY_BASE_S), not a fixed 2 s
    assert made[0].queries == ["the prompt"] and made[1].queries == ["the prompt"]  # fresh session, original prompt


async def test_5xx_past_the_schedule_stays_an_error(monkeypatch, waits):
    monkeypatch.setenv("THIMBLE_MODEL_RETRIES", "1")
    made = install(monkeypatch, [
        [[amsg(TextBlock(text="a")), rmsg(is_error=True, api_error_status=503)]],
        [[amsg(TextBlock(text="b")), rmsg(is_error=True, api_error_status=503)]],
    ])
    r = await call()
    assert r.status == "error" and r.attempts == 2 and len(made) == 2 and "503" in r.detail and waits == [5.0]


async def test_an_overloaded_error_inside_a_200_result_is_retried_on_the_schedule(monkeypatch, waits):
    """The API can stream `overloaded_error` inside a 200, so the CLI's result is `is_error` with no api_error_status
    and the error only in its text; the text decides and the call is retried."""
    made = install(monkeypatch, [
        [[amsg(TextBlock(text="x")), rmsg(is_error=True, result=OVERLOADED_200)]],
        [[amsg(tuse({"title": "T"})), rmsg()]],
    ])
    r = await call()
    assert r.status == "ok" and r.attempts == 2 and len(made) == 2 and waits == [5.0]


async def test_a_non_transient_error_inside_a_200_result_is_not_retried(monkeypatch, waits):
    made = install(monkeypatch, [[[amsg(TextBlock(text="x")), rmsg(is_error=True, result=INVALID_200)]]])
    r = await call()
    assert r.status == "error" and r.attempts == 1 and len(made) == 1 and waits == []
    assert "invalid_request_error" in r.detail  # the result text is in the sentence


async def test_non_retryable_http_error_not_retried(monkeypatch):
    made = install(monkeypatch, [[[amsg(TextBlock(text="a")), rmsg(is_error=True, api_error_status=400)]]])
    r = await call()
    assert r.status == "error" and len(made) == 1 and r.attempts == 1 and "400" in r.detail


# ----------------------------------------------------------------------------- timeout, exceptions, schema sanity


async def test_timeout_is_a_status_not_an_exception(monkeypatch):
    """A session that never produces anything is a stall: killed at the idle window, retried once fresh, and when the
    retry stalls too the call is status 'timeout': never an exception, and never a wall-clock ceiling, since the idle
    window is liveness detection."""
    class HangClient(FakeClient):
        async def receive_response(self):
            await asyncio.sleep(3600)
            yield  # pragma: no cover

    made = install(monkeypatch, [[[None]], [[None]]], cls=HangClient)
    r = await call(idle_timeout_s=0.05)
    assert r.status == "timeout" and "stalled" in r.detail and "no wall-clock ceiling" in r.detail
    assert len(made) == 2  # the one fresh retry


async def test_semaphore_released_after_timeout(monkeypatch):
    """Concurrency 1 so a leaked permit would hang the second call instead of passing unnoticed."""

    class HangClient(FakeClient):
        async def receive_response(self):
            await asyncio.sleep(3600)
            yield  # pragma: no cover

    monkeypatch.setattr(model, "MODEL_CONCURRENCY", 1)
    monkeypatch.setattr(model, "_sem", None)
    install(monkeypatch, [[[None]], [[None]]], cls=HangClient)
    assert (await call(idle_timeout_s=0.05)).status == "timeout"
    install(monkeypatch, [[[amsg(tuse({"title": "T"})), rmsg()]]])
    assert (await asyncio.wait_for(call(), timeout=5)).status == "ok"


async def test_cli_failure_is_a_result_never_a_raise(monkeypatch):
    def make(opts):
        raise ProcessError("the CLI died", exit_code=2, stderr="boom")

    monkeypatch.setattr(model, "_make_client", make)
    r = await call()
    assert r.status == "error" and "ProcessError" in r.detail


async def test_invalid_tool_schema_fails_loudly_without_a_call(monkeypatch):
    made = install(monkeypatch, [[[amsg(tuse({})), rmsg()]]])
    bad = ToolSpec(name="x", description="d", input_schema={"type": "object", "required": "title"})
    r = await call(tool=bad)
    assert r.status == "error" and "schema" in r.detail and r.attempts == 0 and made == []


async def test_concurrency_is_bounded(monkeypatch):
    counter = {"active": 0, "max": 0}

    class SlowClient(FakeClient):
        async def receive_response(self):
            counter["active"] += 1
            counter["max"] = max(counter["max"], counter["active"])
            await asyncio.sleep(0.02)
            counter["active"] -= 1
            for m in self.turns.pop(0):
                yield m

    sessions = [[[amsg(tuse({"title": "T"})), rmsg()]] for _ in range(6)]
    install(monkeypatch, sessions, cls=SlowClient)
    monkeypatch.setattr(model, "MODEL_CONCURRENCY", 2)
    monkeypatch.setattr(model, "_sem", None)
    results = await asyncio.gather(*(call() for _ in range(6)))
    assert all(r.status == "ok" for r in results)
    assert counter["max"] <= 2


async def test_result_is_dataclass_with_contract_fields():
    r = CallResult(status="ok")
    for f in ("status", "output", "model_requested", "model_used", "fallback_note", "duration_s",
              "cost_usd", "session_id", "attempts", "detail", "text", "refused_by"):
        assert hasattr(r, f), f


# ----------------------------------------------------------------------------- credentials and the backend choice


def _isolate_auth(monkeypatch, tmp_path):
    """Exercise the real resolvers (no THIMBLE_SKIP_KEY) without reading this machine's Claude settings or its
    environment: the shell's own credential is removed first, so no assertion diff can ever print it."""
    monkeypatch.delenv("THIMBLE_SKIP_KEY", raising=False)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.setattr(model.config, "REPO_ROOT", tmp_path / "repo")


async def test_env_credential_reaches_the_cli_and_the_environment_is_never_edited(monkeypatch, tmp_path):
    """An ANTHROPIC_API_KEY in the server's environment is Claude Code's first source, so it passes through to the SDK
    session (sdk.auth_env names it in opts.env; the SDK inherits os.environ as well) and is never popped."""
    _isolate_auth(monkeypatch, tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    monkeypatch.setenv("THIMBLE_MODEL_BACKEND", "sdk")
    seen = {}

    class SpyClient(FakeClient):
        async def __aenter__(self):
            seen["key_at_spawn"] = os.environ.get("ANTHROPIC_API_KEY")
            return self

    made = install(monkeypatch, [[[amsg(tuse({"title": "T"})), rmsg()]]], cls=SpyClient)
    r = await call(config_env={"CLAUDE_CONFIG_DIR": "/tmp/cfg"})
    assert r.status == "ok" and seen["key_at_spawn"] == "sk-env"
    assert made[0].opts.env == {"CLAUDE_CONFIG_DIR": "/tmp/cfg", "ANTHROPIC_API_KEY": "sk-env", **sdk.SHELL_LEVEL_ENV}
    assert os.environ["ANTHROPIC_API_KEY"] == "sk-env"


async def test_no_credential_in_the_environment_means_none_is_invented(monkeypatch, tmp_path):
    """Without an env credential the SDK session gets only the caller's env: the CLI resolves the user's apiKeyHelper
    (mirrored by sdk.build) or its own login, exactly as the interactive session would."""
    _isolate_auth(monkeypatch, tmp_path)
    monkeypatch.setenv("THIMBLE_MODEL_BACKEND", "sdk")
    made = install(monkeypatch, [[[amsg(tuse({"title": "T"})), rmsg()]]])
    assert (await call(config_env={"CLAUDE_CONFIG_DIR": "/tmp/cfg"})).status == "ok"
    assert made[0].opts.env == {"CLAUDE_CONFIG_DIR": "/tmp/cfg", **sdk.SHELL_LEVEL_ENV} and made[0].opts.settings is None


async def test_a_structured_call_keeps_no_transcript(monkeypatch, tmp_path):
    """In the served config dir (agents.call_env, a Keychain login) a transcript would sit among main's sessions, and
    nothing resumes one: the CLI runs with --no-session-persistence."""
    _isolate_auth(monkeypatch, tmp_path)
    monkeypatch.setenv("THIMBLE_MODEL_BACKEND", "sdk")
    made = install(monkeypatch, [[[amsg(tuse({"title": "T"})), rmsg()]]])
    assert (await call(config_env={})).status == "ok"
    assert made[0].opts.extra_args == {"no-session-persistence": None}


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


async def test_api_ok_forced_tool_call(monkeypatch):
    fake = install_api(monkeypatch, [api_msg(api_text("here"), api_tuse({"title": "T", "n": 2}))])
    r = await call(effort="high")
    assert r.status == "ok" and r.output == {"title": "T", "n": 2}
    assert r.model_requested == "claude-sonnet-5" and r.model_used == "claude-sonnet-5"
    assert r.fallback_note == "" and r.detail == "" and r.attempts == 1
    assert r.cost_usd is None and r.session_id is None and r.text == "here"
    req = fake.requests[0]
    assert req["model"] == "claude-sonnet-5" and req["max_tokens"] == model.API_MAX_TOKENS
    assert req["tool_choice"] == {"type": "tool", "name": "report"}
    assert req["output_config"] == {"effort": "high"}
    assert "thinking" not in req
    assert req["tools"][0]["name"] == "report" and req["tools"][0]["input_schema"] == SPEC.input_schema


async def test_api_refusal(monkeypatch):
    install_api(monkeypatch, [api_msg(api_text("I can't help with that."), stop_reason="refusal", model_name=FALLBACK)])
    r = await call(model=FALLBACK)
    assert r.status == "refused" and r.attempts == 1 and "refus" in r.detail and r.refused_by == ""
    assert r.text == "I can't help with that." and r.model_used == FALLBACK


async def test_api_refusal_runs_again_once_on_the_fallback_model_and_the_caller_hears_its_time(monkeypatch):
    fake = install_api(monkeypatch, [
        api_msg(api_text("I can't help with that."), stop_reason="refusal"),
        api_msg(api_tuse({"title": "T"}), model_name=FALLBACK),
    ])
    heard: list[float] = []
    r = await call(effort="high", on_fallback=heard.append)
    assert r.status == "ok" and r.output == {"title": "T"}
    assert r.refused_by == "claude-sonnet-5" and r.model_requested == FALLBACK and r.model_used == FALLBACK
    assert [q["model"] for q in fake.requests] == ["claude-sonnet-5", FALLBACK]
    assert fake.requests[1]["output_config"] == {"effort": "high"} and r.attempts == 2
    assert len(heard) == 1 and heard[0] >= 0 and r.duration_s >= heard[0]


async def test_api_a_429_never_goes_to_the_fallback_model(monkeypatch):
    fake = install_api(monkeypatch, [api_error(anthropic.RateLimitError, 429)])
    r = await call()
    assert r.status == "rate_limited" and r.refused_by == ""
    assert [q["model"] for q in fake.requests] == ["claude-sonnet-5"]


async def test_api_truncated(monkeypatch):
    install_api(monkeypatch, [api_msg(api_text("very long..."), stop_reason="max_tokens")])
    r = await call()
    assert r.status == "truncated" and r.attempts == 1 and "max_tokens" in r.detail


async def test_api_rate_limited_by_429(monkeypatch):
    install_api(monkeypatch, [api_error(anthropic.RateLimitError, 429, headers={"retry-after": "42"})])
    r = await call()
    assert r.status == "rate_limited" and r.attempts == 1 and "42" in r.detail


async def test_api_invalid_args_get_the_corrective_tool_result(monkeypatch):
    """The same corrective retry as the SDK path: the violation text goes back as the tool_use's tool_result."""
    fake = install_api(monkeypatch, [
        api_msg(api_tuse({"n": 3}, id="t9")),  # missing required "title"
        api_msg(api_tuse({"title": "T", "n": 3})),
    ])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "T", "n": 3} and r.attempts == 2
    msgs = fake.requests[1]["messages"]
    assert len(msgs) == 3 and msgs[1]["role"] == "assistant"
    result = msgs[2]["content"][0]
    assert result["type"] == "tool_result" and result["tool_use_id"] == "t9" and result["is_error"]
    assert "title" in result["content"] and "schema" in result["content"]


async def test_api_5xx_gets_a_fresh_retry_on_the_backoff_schedule(monkeypatch, waits):
    fake = install_api(monkeypatch, [
        api_error(anthropic.APIStatusError, 529, message="overloaded"),
        api_msg(api_tuse({"title": "T"})),
    ])
    r = await call()
    assert r.status == "ok" and r.attempts == 2 and waits == [5.0]
    assert len(fake.requests[1]["messages"]) == 1  # fresh conversation, original prompt


async def test_api_5xx_past_the_schedule_stays_an_error(monkeypatch, waits):
    monkeypatch.setenv("THIMBLE_MODEL_RETRIES", "1")
    install_api(monkeypatch, [
        api_error(anthropic.APIStatusError, 503),
        api_error(anthropic.APIStatusError, 503),
    ])
    r = await call()
    assert r.status == "error" and r.attempts == 2 and "503" in r.detail and waits == [5.0]


API_BODY_OVERLOADED = "{'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}"
API_BODY_INVALID = "{'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'bad request'}}"


async def test_api_connection_error_gets_one_fresh_retry(monkeypatch):
    async def fake_sleep(d):
        return None

    monkeypatch.setattr(model.asyncio, "sleep", fake_sleep)
    install_api(monkeypatch, [
        anthropic.APIConnectionError(request=API_REQ),
        api_msg(api_tuse({"title": "T"})),
    ])
    assert (await call()).status == "ok"


async def test_api_auth_error_never_retried(monkeypatch):
    fake = install_api(monkeypatch, [api_error(anthropic.AuthenticationError, 401, message="API key is invalid.")])
    r = await call()
    assert r.status == "error" and "401" in r.detail and r.attempts == 1 and len(fake.requests) == 1


async def test_api_request_timeout_is_a_timeout_status(monkeypatch):
    install_api(monkeypatch, [anthropic.APITimeoutError(request=API_REQ)])
    r = await call()
    assert r.status == "timeout" and r.attempts == 1


async def test_api_unexpected_exception_is_an_error_result(monkeypatch):
    install_api(monkeypatch, [ValueError("surprise")])
    r = await call()
    assert r.status == "error" and "ValueError" in r.detail


async def test_auto_uses_the_api_when_a_credential_resolves(monkeypatch):
    """`auto` asks config.api_credentials (Claude Code's order: env, then the apiKeyHelper) and takes the Messages API
    when it answers — install_api's stub stands for either source."""
    fake = install_api(monkeypatch, [api_msg(api_tuse({"title": "T"}))], backend=None)
    sdk_made = install(monkeypatch, [])  # would IndexError if the SDK path were taken
    r = await call()
    assert r.status == "ok" and len(fake.requests) == 1 and sdk_made == []


async def test_auto_uses_the_sdk_when_nothing_resolves(monkeypatch, caplog):
    """No env credential and no helper key: the SDK path, whose CLI has its own login; the path line says why."""
    asked = []

    def nothing():
        asked.append(1)
        return None

    monkeypatch.setattr(model.config, "api_credentials", nothing)

    def no_api(*a, **k):
        raise AssertionError("the api backend must not be touched without a credential")

    monkeypatch.setattr(model, "_make_api_client", no_api)
    install(monkeypatch, [[[amsg(tuse({"title": "T"})), rmsg()]]])
    with caplog.at_level("INFO"):
        assert (await call()).status == "ok"
    assert asked == [1]
    assert "on the sdk path (no credential resolved here; the CLI authenticates on its own)" in caplog.text


async def test_backend_api_resolves_the_credential_in_claude_codes_order(monkeypatch):
    """THIMBLE_MODEL_BACKEND=api: config.api_credentials (env, then the user's apiKeyHelper's stdout) runs off the
    loop and its answer is handed to the anthropic client only — it appears in no result field."""
    monkeypatch.setenv("THIMBLE_MODEL_BACKEND", "api")
    fake = install_api(monkeypatch, [api_msg(api_tuse({"title": "T"}))], backend=None)
    monkeypatch.setattr(model.config, "api_credentials", lambda: ("api_key", "sk-from-helper"))
    r = await call()
    assert r.status == "ok" and fake.creds == [("api_key", "sk-from-helper")]
    assert "sk-from-helper" not in (r.detail + r.text + r.fallback_note + str(r.model_used))


async def test_unknown_backend_is_an_error(monkeypatch):
    monkeypatch.setenv("THIMBLE_MODEL_BACKEND", "cloud")
    r = await call()
    assert r.status == "error" and "cloud" in r.detail and r.attempts == 0


class StallableClient(FakeClient):
    """A STALL entry in a scripted turn hangs forever at that point, like a wedged CLI."""

    async def receive_response(self):
        for m in self.turns.pop(0):
            if m is STALL:
                await asyncio.sleep(3600)
            yield m


async def test_sdk_stall_twice_is_a_timeout_naming_the_idle_window(monkeypatch):
    made = install(monkeypatch, [[[STALL]], [[STALL]]], cls=StallableClient)
    r = await call(idle_timeout_s=0.1)
    assert r.status == "timeout" and len(made) == 2 and r.attempts == 2  # one retry, never a third session
    assert "stalled: no output for 0.1 s" in r.detail
    assert "idle limit 0.1 s" in r.detail and "no wall-clock ceiling" in r.detail
    assert "retried once in a fresh session and it stalled again" in r.detail


async def test_api_stall_twice_is_a_timeout_naming_the_idle_window(monkeypatch):
    fake = install_api(monkeypatch, [STALL, STALL])
    r = await call(idle_timeout_s=0.1)
    assert r.status == "timeout" and len(fake.requests) == 2  # one retry, never a third request
    assert "stalled: no output for 0.1 s" in r.detail
    assert "idle limit 0.1 s" in r.detail and "no wall-clock ceiling" in r.detail
    assert "retried once in a fresh session and it stalled again" in r.detail


CONNECT_STALL = object()  # a session whose first scripted entry is this hangs forever in __aenter__
CONNECT_ERROR = object()  # ... raises the SDK's bounded initialize-timeout shape from __aenter__


def test_reaper_kills_only_recorded_stale_cli_children(monkeypatch):
    """A classifier CLI can outlive the tool handler that started it. A recorded child older than REAP_AGE_S (6 h: leak hygiene, never a limit on a live call) is killed; a young one and a pid that is not a
    `claude` process are left alone."""
    import subprocess
    import time as _t

    old = subprocess.Popen(["sleep", "300"])
    young = subprocess.Popen(["sleep", "300"])
    try:
        monkeypatch.setattr(model, "_looks_like_cli", lambda pid: pid in (old.pid, young.pid))
        model._STRUCTURED_CHILDREN.clear()
        model._STRUCTURED_CHILDREN[old.pid] = _t.monotonic() - 30_000
        model._STRUCTURED_CHILDREN[young.pid] = _t.monotonic()
        model._STRUCTURED_CHILDREN[99999999] = _t.monotonic() - 30_000  # no such process
        assert model.reap_stale_children() == 1
        assert old.wait(timeout=5) != 0 and young.poll() is None
        assert set(model._STRUCTURED_CHILDREN) == {young.pid}
        # a child that survived its client's close is killed too
        assert model._kill_child(young.pid, why="test") is True
        assert young.wait(timeout=5) != 0 and model._STRUCTURED_CHILDREN == {}
    finally:
        for p in (old, young):
            if p.poll() is None:
                p.kill()


# ----------------------------------------------------------------------------- sdk.py and the public names


def test_model_imports_no_session_module():
    """model.py takes its SDK options from sdk.py and imports none of the server's session modules."""
    import subprocess
    import sys
    from pathlib import Path

    code = ("import sys; import app.model; loaded = sorted(m for m in sys.modules if m.startswith('app.'));"
            " print(' '.join(loaded))")
    out = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1], check=True,
                         capture_output=True, text=True, env={**os.environ, "THIMBLE_SKIP_KEY": "1"})
    loaded = out.stdout.split()
    assert "app.sdk" in loaded and not {"app.agents", "app.session", "app.notebook"} & set(loaded)


FAST_SETTINGS = {"fastMode": True}


