"""model.py's structured(): a valid tool call comes back as the output, with the model, cost and session it ran on. The
fakes yield real SDK dataclasses through the stream model.structured() drains."""

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from app import model
from app.model import ToolSpec


def _no_real_cli(opts):
    raise AssertionError("no fake SDK client installed: this test would have spawned a real `claude` session")


@pytest.fixture(autouse=True)
def _fresh_backend_state(monkeypatch):
    """No real CLI: a test that reaches the SDK without `install()` fails at once instead of running a real session on
    this machine's login. A `claude` is named, since a call without one fails before it starts."""
    monkeypatch.setattr(model, "_make_client", _no_real_cli)
    monkeypatch.setattr(model.config, "CLI_PATH", "claude")
    monkeypatch.setattr(model.config, "FALLBACK_MODEL", FALLBACK)

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


def tres(id="t1", text="recorded"):
    return UserMessage(content=[ToolResultBlock(tool_use_id=id, content=text)])


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
        self.interrupts = 0

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

    async def interrupt(self):
        self.interrupts += 1


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
    kw.setdefault("effort", "low")
    kw.setdefault("speed", "standard")
    kw.setdefault("refusal", {"model": FALLBACK, "effort": "high"})
    kw.setdefault("cwd", "/tmp")
    return await model.structured("the prompt", **kw)


# ----------------------------------------------------------------------------- happy path


async def test_ok_valid_tool_call(monkeypatch):
    made = install(monkeypatch, [[[
        amsg(TextBlock(text="writing it now"), tuse({"title": "T", "n": 2})),
        tres(),
        rmsg(model_usage={"claude-sonnet-5": {"inputTokens": 1}}, total_cost_usd=0.12),
    ]]])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "T", "n": 2}
    assert r.model_requested == "claude-sonnet-5" and r.model_used == "claude-sonnet-5"
    assert r.fallback_note == "" and r.detail == ""
    assert r.attempts == 1 and r.cost_usd == 0.12 and r.session_id == "sess-1"
    assert r.duration_s >= 0 and len(made) == 1 and made[0].exited
    assert made[0].interrupts == 1


# ----------------------------------------------------------------------------- the model and effort that run


def _argv(opts) -> list[str]:
    """The `claude` command line the SDK starts for `opts`."""
    from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

    return SubprocessCLITransport("x", opts)._build_command()


async def test_every_call_runs_claude_on_its_model_and_effort_with_the_variables_that_would_choose_them_blanked(
        monkeypatch):
    """A structured call starts `claude` with `--model <full id>` and `--effort <level>`, and the environment it gives
    blanks every variable that would choose another model or effort, CLAUDE_CODE_EFFORT_LEVEL among them, even when this
    process has them set; the call's settings pin the effort too. A call without a model or an effort runs nothing."""
    from app import sdk

    for name in sdk.SCRUBBED_ENV:
        monkeypatch.setenv(name, "max" if "EFFORT" in name else "claude-haiku-4-5")
    turn = [amsg(tuse({"title": "T"})), tres(), rmsg()]
    made = install(monkeypatch, [[turn]])
    assert (await call(model="claude-sonnet-5", effort="medium")).status == "ok"
    opts = made[0].opts
    argv = _argv(opts)
    assert argv[argv.index("--model") + 1] == "claude-sonnet-5" and argv[argv.index("--effort") + 1] == "medium"
    assert all(opts.env[name] == "" for name in sdk.SCRUBBED_ENV), opts.env
    import json

    assert json.loads(opts.settings)["env"] == {"CLAUDE_CODE_EFFORT_LEVEL": "medium"}
    assert sdk.call_env({"CLAUDE_CODE_EFFORT_LEVEL": "max", "MINE": "1"})["CLAUDE_CODE_EFFORT_LEVEL"] == ""
    for missing in ({"model": ""}, {"effort": ""}):
        r = await call(**missing)
        assert r.status == "error" and "no model or no effort" in r.detail and len(made) == 1, missing
    with pytest.raises(sdk.CallSettingsError):
        sdk.build(cwd="/tmp", tools=[], mcp_servers={}, system="", model="claude-sonnet-5", effort="", env=None)
