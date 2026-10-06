"""sdk.build: a structured call runs the user's own `claude` with their user settings only, in safe mode (no CLAUDE.md,
hooks, plugins or MCP servers of theirs), with its own system prompt, effort, fast mode, ultracode and permission
mode."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from app import config, sdk


def test_a_call_takes_the_users_auth_but_not_their_memory_effort_or_mode(tmp_path):
    opts = sdk.build(cwd=tmp_path, tools=["mcp__out__x"], mcp_servers={}, system="You are a text classifier.",
                     model="claude-opus-5-5", effort="low", env=None, speed="standard", persist=False)
    assert opts.setting_sources == ["user"] and opts.strict_mcp_config
    assert "safe-mode" in opts.extra_args and "no-session-persistence" in opts.extra_args
    assert json.loads(opts.settings) == {"fastMode": False, "ultracode": False, "env": {"CLAUDE_CODE_EFFORT_LEVEL": "low"}}
    assert opts.permission_mode == "dontAsk" and opts.allowed_tools == ["mcp__out__x"] and opts.tools == []
    assert opts.system_prompt == "You are a text classifier.", "the caller's system prompt, whole, in place of a preset"


def test_a_call_at_ultracode_runs_at_xhigh_with_ultracode_off(tmp_path):
    """The orientation role's effort, ultracode, reaches a call through harness.ask; the call runs at ultracode's level
    and asks the CLI for no effort it does not take."""
    opts = sdk.build(cwd=tmp_path, tools=[], mcp_servers={}, system="s", model="claude-opus-5-5", effort="ultracode",
                     env=None, speed="standard")
    assert opts.effort == "xhigh"
    assert json.loads(opts.settings) == {"fastMode": False, "ultracode": False, "env": {"CLAUDE_CODE_EFFORT_LEVEL": "xhigh"}}


async def test_the_cli_gets_the_system_prompt_whole_and_ultracode_off(tmp_path, monkeypatch):
    """The `claude` a call starts gets the caller's system prompt as --system-prompt, with no claude_code preset to
    append it to, and --settings that turn the user's ultracode off."""
    from claude_agent_sdk import query

    fake = Path(__file__).parent / "fixtures" / "agents" / "fake_sdk_claude.py"
    exe = tmp_path / "claude"
    exe.write_text(f"#!{sys.executable}\n{fake.read_text()}")
    exe.chmod(0o755)
    log = tmp_path / "starts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    monkeypatch.setattr(config, "CLI_PATH", str(exe))
    system = "You are a text classifier.\n\nCategory: tone"
    options = sdk.build(cwd=tmp_path, tools=[], mcp_servers={}, system=system, model="claude-opus-5-5", effort="low",
                        env=None, persist=False)
    async for _ in query(prompt="hello", options=options):
        pass
    argv = next(s["argv"] for s in map(json.loads, log.read_text().splitlines()) if s["argv"][:1] != ["-v"])
    assert argv[argv.index("--system-prompt") + 1] == system
    assert "--append-system-prompt" not in argv and "--system-prompt-file" not in argv
    assert json.loads(argv[argv.index("--settings") + 1])["ultracode"] is False
