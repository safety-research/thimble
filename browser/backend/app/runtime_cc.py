"""One turn of an agent as a headless Claude Code session (runtime.py's `cc` engine), only when the person chose their
Claude Code sign-in and confirmed claude_access.CONSENT.

The session runs through the Agent SDK on the person's own `claude` (config.CLI_PATH), as 0.8's sdk.build ran its
calls: `--safe-mode`, so the person's CLAUDE.md, plugins, hooks and MCP servers stay out while their sign-in applies;
thimble's prompt as the whole system prompt; the role's model and effort. thimble's tools are an in-process MCP server
named so that the tools read as 0.8's plugin named them (tools.thimble_tool); Claude Code's built-in tools are the
same set the Messages API runtime gives (Spec.builtins), Bash in Claude Code's sandbox (no Bash where it cannot run),
Edit and Write allowed only in the agent's write folders, and `dontAsk`, so nothing waits on a prompt nobody sees.

A PreToolUse hook callback (in this process, not a plugin hook) hears each call of thimble's tools with Claude Code's
id for it, which the tool's handler takes up, so a call runs as its caller's (Conv.call_thimble) as in 0.8. The
session's id is kept in <workspace>/runtime/convs/<id>.cc.json and resumed at the next turn; a fork resumes main's
session as a fork of it (fork_session).
"""
from __future__ import annotations

import json
import logging
import secrets
from typing import Any

log = logging.getLogger("thimble.runtime_cc")

SERVER = "plugin_thimble_thimble"  # tools.thimble_tool: mcp__plugin_thimble_thimble__<tool>


def _load(path: Any) -> dict[str, Any]:
    try:
        got = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def _save(path: Any, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _key(name: str, args: Any) -> str:
    return name.rsplit("__", 1)[-1] + "\0" + json.dumps(args, sort_keys=True, default=str)


def settings(spec: Any, bash: bool) -> dict[str, Any]:
    """The session's inline settings: its effort as 0.8's calls pinned it (sdk.cli_settings), the sandbox for Bash,
    edits only in the write folders, and no reads of thimble's private files."""
    from . import cc_settings, sdk  # noqa: PLC0415

    out = json.loads(sdk.cli_settings(spec.model, spec.effort or None))
    out["permissions"] = {
        "allow": [f"Edit(/{w}/**)" for w in spec.write_roots],
        "deny": [f"Edit(/{spec.cwd}/**)", *[r for p in spec.private for r in (f"Read(/{p})", f"Edit(/{p})")]],
        "additionalDirectories": [str(w) for w in spec.write_roots],
    }
    if bash:
        out["sandbox"] = {**cc_settings.offline_sandbox(auto_allow=True, network=True),
                          "filesystem": {"allowWrite": [str(w) for w in spec.write_roots]}}
    return out


def options(conv: Any, spec: Any, pending: dict[str, list[str]]) -> Any:
    from claude_agent_sdk import ClaudeAgentOptions, HookMatcher, SdkMcpTool, create_sdk_mcp_server  # noqa: PLC0415

    from . import cc_settings, config, runtime, sdk, tools  # noqa: PLC0415

    bash = "Bash" in spec.builtins and cc_settings.sandbox_ok()
    builtins = [b for b in spec.builtins if b != "Bash" or bash]
    secs = tools.tool_sections(spec.thimble)

    def handler(name: str) -> Any:
        async def run(args: dict[str, Any]) -> dict[str, Any]:
            ids = pending.get(_key(name, args)) or []
            tid = ids.pop(0) if ids else f"toolu_rt{secrets.token_hex(10)}"
            res = await conv.call_thimble(name, args if isinstance(args, dict) else {}, tid)
            return {"content": [b for b in res.content if isinstance(b, dict)], "is_error": bool(res.is_error)}
        return run

    server = create_sdk_mcp_server(SERVER, tools=[SdkMcpTool(name=n, description=secs[n][0], input_schema=secs[n][1],
                                                             handler=handler(n)) for n in spec.thimble if n in secs])

    async def pre(inp: Any, tool_use_id: str | None, _ctx: Any) -> dict[str, Any]:
        name = str((inp or {}).get("tool_name") or "")
        if tool_use_id and name.startswith(f"mcp__{SERVER}__"):
            pending.setdefault(_key(name, (inp or {}).get("tool_input")), []).append(tool_use_id)
        return {}

    allowed = [b for b in builtins if b not in ("Edit", "Write")]
    allowed += [f"Edit(/{w}/**)" for w in spec.write_roots]
    allowed += [tools.thimble_tool(n) for n in spec.thimble]
    state = _load(conv.state_path("cc"))
    resume, fork = str(state.get("session_id") or "") or None, False
    if resume is None and conv.base:
        base = conv.space.main if conv.base == runtime.MAIN else conv.space.convs.get(conv.base)
        if base is not None and (sid := _load(base.state_path("cc")).get("session_id")):
            resume, fork = str(sid), True
    sent = spec.effort if spec.effort and config.has_effort(spec.model) else None
    return ClaudeAgentOptions(
        cwd=str(spec.cwd),
        tools=builtins,
        allowed_tools=allowed,
        permission_mode="dontAsk",
        mcp_servers={SERVER: server},
        system_prompt=spec.system,
        model=spec.model,
        effort=sent,
        settings=json.dumps(settings(spec, bash)),
        cli_path=config.CLI_PATH,
        max_buffer_size=sdk.MAX_BUFFER_SIZE,
        setting_sources=["user"],
        strict_mcp_config=True,
        add_dirs=[str(w) for w in spec.write_roots],
        env=sdk.call_env({"TMPDIR": str(spec.home)}),
        extra_args={"safe-mode": None},
        hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[pre])]},
        resume=resume,
        fork_session=fork,
    )


def _block(b: Any) -> dict[str, Any] | None:
    from claude_agent_sdk import ServerToolUseBlock, TextBlock, ToolUseBlock  # noqa: PLC0415

    if isinstance(b, TextBlock):
        return {"type": "text", "text": b.text}
    if isinstance(b, ToolUseBlock):
        return {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input or {}}
    if isinstance(b, ServerToolUseBlock):
        from . import runtime_tools  # noqa: PLC0415

        return {"type": "tool_use", "id": b.id, "name": runtime_tools.SERVER_NAMES.get(b.name, b.name),
                "input": b.input or {}}
    return None


def _result(b: Any) -> dict[str, Any] | None:
    from claude_agent_sdk import ServerToolResultBlock, ToolResultBlock  # noqa: PLC0415

    if isinstance(b, ToolResultBlock):
        return {"type": "tool_result", "tool_use_id": b.tool_use_id, "content": b.content if b.content is not None else "",
                **({"is_error": True} if b.is_error else {})}
    if isinstance(b, ServerToolResultBlock):
        return {"type": "tool_result", "tool_use_id": b.tool_use_id, "content": json.dumps(b.content)[:2000]}
    return None


async def turn(conv: Any, text: str) -> Any:
    from claude_agent_sdk import AssistantMessage, ClaudeSDKClient, ResultMessage, SystemMessage, UserMessage  # noqa: PLC0415

    from . import runtime  # noqa: PLC0415

    spec = conv.spec()
    pending: dict[str, list[str]] = {}
    opts = options(conv, spec, pending)
    path = conv.state_path("cc")
    reply, failed = "", ""
    async with ClaudeSDKClient(opts) as client:
        await client.query(text)
        async for msg in client.receive_response():
            if isinstance(msg, SystemMessage) and msg.subtype == "init":
                sid = (msg.data or {}).get("session_id")
                if sid:
                    _save(path, {"session_id": sid})
            elif isinstance(msg, AssistantMessage):
                if getattr(msg, "parent_tool_use_id", None):
                    continue
                blocks = [b for b in (_block(x) for x in msg.content) if b is not None]
                results = [r for r in (_result(x) for x in msg.content) if r is not None]
                conv.emit_assistant(blocks, str(msg.model or spec.model), msg.usage or {})
                conv.emit_results(results)
                said = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
                reply = said or reply
                if msg.error:
                    failed = str(msg.error)
            elif isinstance(msg, UserMessage):
                if getattr(msg, "parent_tool_use_id", None) or isinstance(msg.content, str):
                    continue
                conv.emit_results([r for r in (_result(x) for x in msg.content) if r is not None])
            elif isinstance(msg, ResultMessage):
                if msg.session_id:
                    _save(path, {"session_id": msg.session_id})
                if msg.is_error and not failed:
                    failed = str(msg.result or msg.subtype or "the Claude Code session failed")
    if failed:
        if "auth" in failed.lower() or "login" in failed.lower() or "401" in failed:
            raise runtime.AccessProblem({"what": f"Claude Code could not sign in: {failed[:300]}",
                                         "fix": "Run `claude` in a terminal and sign in, or choose another way in "
                                                "Settings, Claude access."})
        raise RuntimeError(failed[:300])
    return runtime.TurnEnd("done", text=reply)
