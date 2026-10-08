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


async def test_an_interrupted_turn_whose_result_lists_only_a_helper_model_names_the_model_that_made_the_call(monkeypatch):
    """The interrupt can end the turn before its result counts the model: model_usage then lists only the CLI's helper
    model, and the call is reported on the model named on the recorded call's message, with its cost unknown."""
    install(monkeypatch, [[[
        amsg(tuse({"title": "T"})),
        tres(),
        rmsg(subtype="error_during_execution", is_error=True, total_cost_usd=0.002,
             model_usage={"claude-haiku-4-5-20251001": {"inputTokens": 10152}}),
    ]]])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "T"}
    assert r.model_used == "claude-sonnet-5" and r.fallback_note == "" and r.cost_usd is None


async def test_turn_interrupted_only_once_a_call_is_recorded(monkeypatch):
    made = install(monkeypatch, [[
        [amsg(tuse({"n": 2}, id="t1")), tres("t1", "invalid"), rmsg()],
        [amsg(tuse({"title": "T"}, id="t2")), tres("t2"), rmsg()],
    ]])
    r = await call()
    assert r.status == "ok" and r.output == {"title": "T"} and r.attempts == 2
    assert made[0].interrupts == 1


async def test_a_call_s_system_prompt_is_the_caller_s_own_then_the_output_tool_s_instruction(monkeypatch):
    """The session's system prompt is a plain string: the caller's `system` and then the output tool's instruction, or
    the instruction alone, with no Claude Code preset around it; its settings turn the user's ultracode off."""
    import json

    instruction = "Return the output ONLY via the `report` tool; call it exactly once and write no prose."
    turn = [amsg(tuse({"title": "T"})), tres(), rmsg()]
    made = install(monkeypatch, [[turn], [turn]])
    assert (await call(system="You are a text classifier.")).status == "ok"
    assert (await call()).status == "ok"
    assert [m.opts.system_prompt for m in made] == [f"You are a text classifier.\n\n{instruction}", instruction]
    assert all(json.loads(m.opts.settings)["ultracode"] is False for m in made)


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


async def test_a_refused_call_runs_again_on_the_refusal_row_and_not_at_all_when_it_is_off(monkeypatch):
    """A call its model refused runs once more on the refusal row's model and effort (config.call_settings'
    `refusal`), at standard speed, with `refused_by` naming the model that refused; not at all when the row is off
    (None), or when it names the model that refused."""
    refused = [amsg(TextBlock(text="I can't help with that."), stop_reason="refusal"), rmsg()]
    ok = [amsg(tuse({"title": "T"}), model="claude-opus-4-8"), tres(), rmsg()]
    made = install(monkeypatch, [[refused], [ok]])
    r = await call(model="claude-sonnet-5", effort="low", speed="fast", refusal={"model": "claude-opus-4-8",
                                                                                  "effort": "max"})
    assert r.status == "ok" and r.refused_by == "claude-sonnet-5" and len(made) == 2
    assert (made[1].opts.model, made[1].opts.effort) == ("claude-opus-4-8", "max")
    import json

    assert json.loads(made[1].opts.settings)["fastMode"] is False, "the rerun runs at standard speed"
    made = install(monkeypatch, [[refused]])
    r = await call(refusal=None)
    assert r.status == "refused" and len(made) == 1, "the row is off: no rerun"
    made = install(monkeypatch, [[refused]])
    r = await call(model="claude-opus-4-8", refusal={"model": "claude-opus-4-8", "effort": "high"})
    assert r.status == "refused" and len(made) == 1


def test_every_structured_call_site_passes_its_model_effort_and_refusal_row():
    """Every call of model.structured in the backend passes `model`, `effort`, `speed` and `refusal` by name, none of
    them None, so no call takes a model or an effort from Claude Code's settings (config.call_settings)."""
    import ast
    from pathlib import Path

    app_dir = Path(model.__file__).parent
    sites = []
    for path in sorted(app_dir.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text("utf-8"))):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "structured" \
                    and isinstance(node.func.value, ast.Name) and node.func.value.id in ("model", "model_mod"):
                kw = {k.arg: k.value for k in node.keywords}
                sites.append(f"{path.name}:{node.lineno}")
                for name in ("model", "effort", "speed", "refusal"):
                    assert name in kw, f"{path.name}:{node.lineno} passes no {name}"
                    assert not (isinstance(kw[name], ast.Constant) and kw[name].value is None), \
                        f"{path.name}:{node.lineno} passes {name}=None"
    assert len(sites) >= 6, sites


async def test_a_model_without_an_effort_runs_with_none_and_the_call_says_so(monkeypatch, caplog):
    """Claude Code runs Haiku with no effort, so a call on it passes no --effort and no effort variable, and its log says
    it ran with none; the call still names its role's effort, as every call must."""
    import json
    import logging

    turn = [amsg(tuse({"title": "T"}), model="claude-haiku-4-5-20251001"), tres(), rmsg()]
    made = install(monkeypatch, [[turn]])
    with caplog.at_level(logging.INFO, logger="thimble.model"):
        assert (await call(model="claude-haiku-4-5-20251001", effort="low")).status == "ok"
    opts = made[0].opts
    assert opts.effort is None and "--effort" not in _argv(opts) and "env" not in json.loads(opts.settings)
    assert "at effort none (the model has none)" in caplog.text
