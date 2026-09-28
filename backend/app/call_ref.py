"""PostToolUse hook for the orientation's session: asks the server for the ref of the call just made (calls.py) and
hands it to the model as additionalContext, so the model can cite what it just ran.

Registered on PostToolUse and PostToolUseFailure. Posts {session, tool_use_id, tool_name, tool_input, agent_id} to
POST {server}/api/ws/{ws}/calls/ref with post, which permission_hook.py uses too: the address and token come from
<thimble home>/server.json, each request proves it holds the token and each answer must prove the server does
(app/hook_auth.py). Standard library only, run with `python -S`. Any fault prints nothing: the hook must never block a
call.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sys
import urllib.parse
import urllib.request
from pathlib import Path

TIMEOUT_S = 5
EVENTS = ("PostToolUse", "PostToolUseFailure")
THIMBLE_PREFIXES = ("mcp__plugin_thimble_thimble__", "mcp__thimble__")  # calls.THIMBLE_PREFIXES


def sign(token: str, role: str, nonce: str) -> str:
    """app/hook_auth.py's sign: the proof `role` gives for `nonce`."""
    return hmac.new(token.encode("utf-8"), f"{role}:{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def server(home: str = "") -> tuple[str, str] | None:
    """(the server's address, its token) from server.json in `home`, else THIMBLE_HOME, else ~/.thimble; None without
    the file, an address or a token."""
    folder = Path(home or os.environ.get("THIMBLE_HOME") or Path.home() / ".thimble").expanduser()
    try:
        data = json.loads((folder / "server.json").read_text("utf-8"))
        url = str(data["api"]).rstrip("/") if data.get("api") else f"http://127.0.0.1:{int(data['port'])}"
        token = data.get("token")
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None
    return (url, token) if isinstance(token, str) and token else None


def post(path: str, body: dict, timeout: float, home: str = "") -> object:
    """The server's JSON answer to `body` posted to `path`; OSError when there is no server to ask or the answer does not
    carry the server's proof."""
    found = server(home)
    if found is None:
        raise OSError("no server.json with an address and a token")
    url, token = found
    nonce = secrets.token_hex(16)
    headers = {"Content-Type": "application/json", "X-Thimble-Nonce": nonce, "X-Thimble-Auth": sign(token, "hook", nonce)}
    req = urllib.request.Request(url + path, data=json.dumps(body).encode("utf-8"), method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — loopback, thimble's own server
        raw, proof = resp.read(), resp.headers.get("X-Thimble-Proof") or ""
    if not hmac.compare_digest(proof, sign(token, "server", nonce)):
        raise OSError("the answer does not carry thimble's proof")
    return json.loads(raw.decode("utf-8") or "{}")


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
    body = {"session": session, "tool_use_id": hook.get("tool_use_id"), "tool_name": name,
            "tool_input": hook.get("tool_input"), "agent_id": hook.get("agent_id")}
    try:
        reply = post(f"/api/ws/{urllib.parse.quote(ws, safe='')}/calls/ref", body, TIMEOUT_S)
    except Exception:  # noqa: BLE001 — module note: a fault prints nothing
        return 0
    context = reply.get("context") if isinstance(reply, dict) else None
    if context:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": str(context)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
