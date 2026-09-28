"""sdk.build: a structured call runs the user's own `claude` with their user settings only, in safe mode (no CLAUDE.md,
hooks, plugins or MCP servers of theirs), with its own effort, fast mode and permission mode."""
from __future__ import annotations

import json

from app import sdk


def test_a_call_takes_the_users_auth_but_not_their_memory_effort_or_mode(tmp_path):
    opts = sdk.build(cwd=tmp_path, tools=["mcp__out__x"], mcp_servers={}, system_append="", model="claude-opus-5-5",
                     effort="low", env=None, speed="standard", persist=False)
    assert opts.setting_sources == ["user"] and opts.strict_mcp_config
    assert "safe-mode" in opts.extra_args and "no-session-persistence" in opts.extra_args
    assert json.loads(opts.settings) == {"fastMode": False, "env": {"CLAUDE_CODE_EFFORT_LEVEL": "low"}}
    assert opts.permission_mode == "dontAsk" and opts.allowed_tools == ["mcp__out__x"] and opts.tools == []
