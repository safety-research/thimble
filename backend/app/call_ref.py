"""PostToolUse hook for the orientation's session: asks the server for the ref of the call just made (calls.py) and
hands it to the model as additionalContext, so the model can cite what it just ran.

Registered on PostToolUse and PostToolUseFailure. Posts {session, tool_use_id, tool_name, tool_input, agent_id} to
POST {server}/api/ws/{ws}/calls/ref; the server's address is found as the MCP shim finds it ($THIMBLE_HOME/server.json,
else THIMBLE_PORT, else 8300). Standard library only, run with `python -S`. Any fault prints nothing: the hook must
never block a call.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_PORT = 8300
TIMEOUT_S = 5
EVENTS = ("PostToolUse", "PostToolUseFailure")
THIMBLE_PREFIXES = ("mcp__plugin_thimble_thimble__", "mcp__thimble__")  # calls.THIMBLE_PREFIXES


def server_url() -> str:
    home = Path(os.environ.get("THIMBLE_HOME") or Path.home() / ".thimble")
    try:
        data = json.loads((home / "server.json").read_text("utf-8"))
        if isinstance(data, dict):
            if data.get("api"):
                return str(data["api"]).rstrip("/")
            if data.get("port"):
                return f"http://127.0.0.1:{int(data['port'])}"
    except (OSError, ValueError, TypeError):
        pass
    port = os.environ.get("THIMBLE_PORT", "").strip()
    return f"http://127.0.0.1:{int(port) if port.isdigit() else DEFAULT_PORT}"


def main(argv: list[str]) -> int:
    ws = argv[argv.index("--ws") + 1] if "--ws" in argv and argv.index("--ws") + 1 < len(argv) else ""
    session = os.environ.get("THIMBLE_SESSION", "").strip()
    try:
        hook = json.load(sys.stdin)
    except (OSError, ValueError):
        return 0
    if not ws or not session or not isinstance(hook, dict):
        return 0
    event = str(hook.get("hook_event_name") or "")
    name = str(hook.get("tool_name") or "")
    if event not in EVENTS or not hook.get("tool_use_id") or name.startswith(THIMBLE_PREFIXES):
        return 0
    body = json.dumps({"session": session, "tool_use_id": hook.get("tool_use_id"), "tool_name": name,
                       "tool_input": hook.get("tool_input"), "agent_id": hook.get("agent_id")}).encode("utf-8")
    url = f"{server_url()}/api/ws/{urllib.parse.quote(ws, safe='')}/calls/ref"
    req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:  # noqa: S310 — loopback, our own server
            reply = json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — module note: a fault prints nothing
        return 0
    context = reply.get("context") if isinstance(reply, dict) else None
    if context:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": str(context)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
