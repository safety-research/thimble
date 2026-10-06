"""The Agent SDK options for model.structured: one call on the user's own `claude`, in their config dir with their user
settings, so it authenticates as `claude` does.

A call gets the output tool and nothing else: no built-in tool, `strict_mcp_config`, and `--safe-mode`, which keeps the
user's CLAUDE.md, skills, plugins, hooks and MCP servers out of it while their auth, provider and env settings apply.
Its system prompt is the caller's own, sent whole as `--system-prompt` in place of Claude Code's claude_code preset; the
CLI still opens it with one line of its own and adds its environment context. Every call names its model, a full id,
and its effort (`--model`, `--effort`), and nothing else may choose them: the environment it gives `claude` blanks the
variables that would (SCRUBBED_ENV), since CLAUDE_CODE_EFFORT_LEVEL beats `--effort` (main ran high under `--effort
medium`), and the inline `--settings` pin what the call must not take from the user's settings: its effort, fast mode
and ultracode. Its permission mode is dontAsk, so only the allowed output tool runs whatever the user's default mode is.

claude_agent_sdk is imported on first use to keep `import app.main` fast. A module that uses the SDK's classes lists
them in its _SDK_NAMES, imports them under TYPE_CHECKING and calls `_bind_sdk()` first in every function that uses
one."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # annotations only: the names are bound at first use (_bind_sdk, below)
    from claude_agent_sdk import ClaudeAgentOptions

from . import cc_settings, config

log = logging.getLogger("thimble.sdk")


def bind_sdk(g: dict[str, Any], names: dict[str, str]) -> None:
    """Bind `names` (local name -> claude_agent_sdk attribute) into the module globals `g`, importing the SDK now. A
    name already bound (a test's monkeypatch) is kept."""
    if all(local in g for local in names):
        return
    import claude_agent_sdk

    for local, attr in names.items():
        g.setdefault(local, getattr(claude_agent_sdk, attr))


def sdk_attr(g: dict[str, Any], names: dict[str, str], name: str) -> Any:
    """A module's __getattr__: an SDK name asked for from outside the module binds them all first."""
    if name not in names:
        raise AttributeError(f"module {g.get('__name__')!r} has no attribute {name!r}")
    bind_sdk(g, names)
    return g[name]


_SDK_NAMES = {"ClaudeAgentOptions": "ClaudeAgentOptions"}


def _bind_sdk() -> None:
    bind_sdk(globals(), _SDK_NAMES)


def __getattr__(name: str) -> Any:
    return sdk_attr(globals(), _SDK_NAMES, name)


# The SDK caps a single CLI JSON message at 1 MB by default, which a large tool call can exceed.
MAX_BUFFER_SIZE = int(os.environ.get("THIMBLE_CLI_MAX_BUFFER", str(32 * 1024 * 1024)))

# The server's environment may have no SHLVL, and a CLI whose shells start at level 0 sources the ~/.bashrc it masks,
# which prints "Permission denied" at the top of every Bash result.
SHELL_LEVEL_ENV = {"SHLVL": "1"}
# The SDK runs `claude -v` before each call with this process's whole environment, thimble's variables among them
# (config.launch_environ says why none may reach a `claude`). This variable turns that off. thimble warns about an old
# Claude Code itself (cli.claude_code_warning). Its name does not pass to a `claude` thimble starts (config.passes).
SKIP_VERSION_CHECK_ENV = "CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK"
# The variables that would choose a call's model or effort over its `--model` and `--effort` (module note), each passed
# to the call's `claude` as "" (the SDK starts it with this process's environment under the call's own, so a variable
# can be blanked, not removed; Claude Code reads an empty one as unset).
SCRUBBED_ENV = ("CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
                "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL")


class CallSettingsError(ValueError):
    """A call that names no model or no effort, which it would then take from Claude Code's settings."""


def build(
    *,
    cwd: str | Path,
    tools: list[str] | tuple[str, ...],
    mcp_servers: dict[str, Any],
    system: str,
    model: str,
    effort: str,
    env: dict[str, str] | None,
    speed: str | None = None,
    persist: bool = True,
) -> ClaudeAgentOptions:
    """The one constructor of ClaudeAgentOptions (module note). `tools` are the MCP tool names the call may use; `system`
    is the whole system prompt; `model` (a full id) and `effort` are required, CallSettingsError without either; an
    effort an earlier build stored as ultracode runs at its level, xhigh, since `claude --effort` takes only the levels;
    a model Claude Code runs with no effort (config.has_effort) gets none; `env` is added to the server's environment,
    where every THIMBLE_* variable and every SCRUBBED_ENV one is "" (config.launch_environ says why for the first);
    `speed` switches on fast mode where the model has it; `persist` False writes no transcript."""
    _bind_sdk()
    os.environ.setdefault(SKIP_VERSION_CHECK_ENV, "1")
    if effort == cc_settings.ULTRACODE:
        effort = cc_settings.ULTRACODE_EFFORT
    if not str(model or "").strip() or not str(effort or "").strip():
        raise CallSettingsError(f"a model call names no {'model' if not str(model or '').strip() else 'effort'}, which "
                                "it would take from Claude Code's settings")
    sent = effort if config.has_effort(model) else None  # a model with no effort gets none (config.NO_EFFORT_MODELS)
    return ClaudeAgentOptions(
        cwd=str(cwd),
        tools=[],
        allowed_tools=[str(t) for t in tools],
        permission_mode="dontAsk",
        mcp_servers=dict(mcp_servers),
        system_prompt=system,
        model=model,
        effort=sent,
        settings=cli_settings(model, sent, speed),
        cli_path=config.CLI_PATH,
        max_buffer_size=MAX_BUFFER_SIZE,
        include_partial_messages=True,
        setting_sources=["user"],
        strict_mcp_config=True,
        env=call_env(env),
        extra_args={"safe-mode": None, **({} if persist else {"no-session-persistence": None})},
    )


def call_env(env: dict[str, str] | None) -> dict[str, str]:
    """The environment a call's `claude` gets over this process's (module note): SHELL_LEVEL_ENV, every THIMBLE_*
    variable and every SCRUBBED_ENV one as "", then the caller's `env` less SCRUBBED_ENV."""
    blank = {k: "" for k in os.environ if k.startswith(config.OWN_PREFIX)}
    own = {k: v for k, v in (env or {}).items() if k not in SCRUBBED_ENV}
    return {**SHELL_LEVEL_ENV, **blank, **dict.fromkeys(SCRUBBED_ENV, ""), **own}


def cli_settings(model: str | None, effort: str | None, speed: str | None = None) -> str:
    """The inline settings of a call: `fastMode` always (config.fast_mode_for), `ultracode` off, since the user's
    `ultracode: true` would add its instructions to every call, and the call's effort as CLAUDE_CODE_EFFORT_LEVEL,
    which would otherwise come from the user's settings over `--effort`."""
    obj: dict[str, Any] = {"fastMode": config.fast_mode_for(model, speed), "ultracode": False}
    if effort:
        obj["env"] = {"CLAUDE_CODE_EFFORT_LEVEL": effort}
    return json.dumps(obj)
