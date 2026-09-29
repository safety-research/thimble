"""The Agent SDK options for model.structured: one call on the user's own `claude`, in their config dir with their user
settings, so it authenticates as `claude` does.

A call gets the output tool and nothing else: no built-in tool, `strict_mcp_config`, and `--safe-mode`, which keeps the
user's CLAUDE.md, skills, plugins, hooks and MCP servers out of it while their auth, provider and env settings apply.
The inline `--settings` pin what the call must not take from the user's settings: its effort and fast mode. Its
permission mode is dontAsk, so only the allowed output tool runs whatever the user's default mode is.

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

from . import config

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


def build(
    *,
    cwd: str | Path,
    tools: list[str] | tuple[str, ...],
    mcp_servers: dict[str, Any],
    system_append: str,
    model: str | None,
    effort: str | None,
    env: dict[str, str] | None,
    speed: str | None = None,
    persist: bool = True,
) -> ClaudeAgentOptions:
    """The one constructor of ClaudeAgentOptions (module note). `tools` are the MCP tool names the call may use; `env` is
    added to the server's environment; `speed` switches on fast mode where the model has it; `persist` False writes no
    transcript."""
    _bind_sdk()
    return ClaudeAgentOptions(
        cwd=str(cwd),
        tools=[],
        allowed_tools=[str(t) for t in tools],
        permission_mode="dontAsk",
        mcp_servers=dict(mcp_servers),
        system_prompt={"type": "preset", "preset": "claude_code", "append": system_append},
        model=model,
        effort=effort,
        settings=cli_settings(model, effort, speed),
        cli_path=config.CLI_PATH,
        max_buffer_size=MAX_BUFFER_SIZE,
        include_partial_messages=True,
        setting_sources=["user"],
        strict_mcp_config=True,
        env={**SHELL_LEVEL_ENV, **(env or {})},
        extra_args={"safe-mode": None, **({} if persist else {"no-session-persistence": None})},
    )


def cli_settings(model: str | None, effort: str | None, speed: str | None = None) -> str:
    """The inline settings of a call: `fastMode` always (config.fast_mode_for), and the call's effort as
    CLAUDE_CODE_EFFORT_LEVEL, which would otherwise come from the user's settings over `--effort`."""
    obj: dict[str, Any] = {"fastMode": config.fast_mode_for(model, speed)}
    if effort:
        obj["env"] = {"CLAUDE_CODE_EFFORT_LEVEL": effort}
    return json.dumps(obj)
