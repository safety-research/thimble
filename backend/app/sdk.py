"""The Agent SDK options for model.structured's SDK path (the labels classifier's calls when no API credential
resolves).

A session gets the output tool and nothing else: no built-in tool, no settings source, and `strict_mcp_config`. It
authenticates as the launching Claude Code session does: the user's `apiKeyHelper` is mirrored through inline
`--settings`, and the credential and network variables pass through from the server's environment; thimble never runs
the helper or sees a key.

claude_agent_sdk is imported on first use to keep `import app.main` fast. A module that uses the SDK's classes lists
them in its _SDK_NAMES, imports them under TYPE_CHECKING and calls `_bind_sdk()` first in every function that uses
one
(tests_public/test_sdk.py checks this)."""
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

# Both spellings of the proxy variables, since the tools that read them differ on which they honour.
NETWORK_ENV = ("ANTHROPIC_BASE_URL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy")

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
    """The one constructor of ClaudeAgentOptions. `tools` are the MCP tool names the session may call; `env` is added to
    the
    server's environment; `speed` switches on fast mode where the model has it; `persist` False writes no transcript."""
    _bind_sdk()
    return ClaudeAgentOptions(
        cwd=str(cwd),
        tools=[],
        allowed_tools=[str(t) for t in tools],
        permission_mode="bypassPermissions",
        mcp_servers=dict(mcp_servers),
        system_prompt={"type": "preset", "preset": "claude_code", "append": system_append},
        model=model,
        effort=effort,
        settings=cli_settings(model, speed),
        cli_path=config.CLI_PATH,
        max_buffer_size=MAX_BUFFER_SIZE,
        include_partial_messages=True,
        setting_sources=[],
        skills="all",
        strict_mcp_config=True,
        env=worker_env(env),
        extra_args={} if persist else {"no-session-persistence": None},
    )


def cli_settings(model: str | None, speed: str | None = None) -> str | None:
    """The inline CLI settings JSON of a session: `fastMode` when the call runs in fast mode (config.fast_mode_for), and
    the user's `apiKeyHelper` command when their Claude settings name one. None when there is neither."""
    obj: dict[str, Any] = {}
    if config.fast_mode_for(model, speed):
        obj["fastMode"] = True
    helper = config.api_key_helper()
    if helper is not None:
        obj["apiKeyHelper"] = helper
    return json.dumps(obj) if obj else None


def auth_env(env: dict[str, str] | None) -> dict[str, str]:
    """The caller's env plus the credential variables set in the server's environment (config.worker_credential_names).
    The caller's own values win."""
    out = dict(env or {})
    for name in config.worker_credential_names():
        out.setdefault(name, os.environ[name])
    return out


def network_env() -> dict[str, str]:
    """The NETWORK_ENV variables set in this process's environment; nothing under THIMBLE_SKIP_KEY=1, so no test reads
    this machine's setup."""
    if config._skip():
        return {}
    return {name: os.environ[name] for name in NETWORK_ENV if os.environ.get(name)}


def worker_env(env: dict[str, str] | None) -> dict[str, str]:
    """The environment a session gets on top of the server's: the caller's entries, the credential variables
    (auth_env), the network variables (network_env) and SHELL_LEVEL_ENV. The caller's own values win."""
    out = auth_env(env)
    for name, value in (*network_env().items(), *SHELL_LEVEL_ENV.items()):
        out.setdefault(name, value)
    return out
