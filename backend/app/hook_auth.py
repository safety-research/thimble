"""The routes only thimble's plugin calls: its hooks' (plugin/bin/.thimble-watch, and bin/thimble-agents for
/api/agents) and its MCP shim's (bin/thimble-mcp: the channel subscription, relayed permission prompts, tool calls).

Any process on the machine can reach a loopback port, and the plugin runs in every Claude Code session that has it,
so each side proves it holds the token the supervisor writes into <home>/server.json (readable by its owner alone,
cli.write_state) without sending it: a request carries a fresh nonce and HMAC-SHA256(token, "hook:" + nonce), and the
answer carries HMAC-SHA256(token, "server:" + nonce). HookAuth answers a request on a guarded route without a valid
proof with 401. A hook or shim that finds no server.json, no token in it, or no valid proof on the answer sends
nothing or believes nothing, so a process that holds the recorded port learns nothing from the plugin and cannot answer
it.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path

from starlette.datastructures import Headers, MutableHeaders

HOOK_PATHS = frozenset({
    "/api/channel/pull", "/api/channel/ack", "/api/channel/held", "/api/channel/permission/hook",
    "/api/agents", "/api/bg/relay", "/api/bg/agent-check", "/api/bg/proxy-stop",
})
SHIM_PATHS = frozenset({"/api/channel", "/api/channel/permission"})
TOOL_PREFIX = "/api/tools/"  # POST /api/tools/<name>; GET /api/tools/holdings is the CLI's and stays open
NONCE_HEADER = "x-thimble-nonce"
AUTH_HEADER = "x-thimble-auth"
PROOF_HEADER = "x-thimble-proof"
NONCE_MAX = 128  # characters

_cache: tuple[tuple[str, int, int], str] | None = None


def sign(token: str, role: str, nonce: str) -> str:
    """The proof `role` ("hook" or "server") gives for `nonce`."""
    return hmac.new(token.encode("utf-8"), f"{role}:{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def headers(token: str, nonce: str) -> dict[str, str]:
    """A hook's request headers for `nonce`."""
    return {NONCE_HEADER: nonce, AUTH_HEADER: sign(token, "hook", nonce)}


def guarded(method: str, path: str) -> bool:
    """Whether a request needs the proof: a hook's or shim route's, or a tool call."""
    return path in HOOK_PATHS or path in SHIM_PATHS or (method == "POST" and path.startswith(TOOL_PREFIX))


def token() -> str:
    """The token in <home>/server.json ('' when there is none), read again whenever the file changes."""
    global _cache
    p = Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser() / "server.json"
    try:
        st = p.stat()
    except OSError:
        return ""
    key = (str(p), st.st_mtime_ns, st.st_size)
    if _cache is not None and _cache[0] == key:
        return _cache[1]
    try:
        data = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return ""
    value = data.get("token") if isinstance(data, dict) else None
    value = value if isinstance(value, str) else ""
    _cache = (key, value)
    return value


class HookAuth:
    """401 for a request on a guarded route without a valid proof; the proof of this server on every answer to one."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not guarded(scope.get("method", ""), scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        h = Headers(scope=scope)
        nonce = h.get(NONCE_HEADER, "")
        tok = token()
        if not tok or not nonce or len(nonce) > NONCE_MAX or not hmac.compare_digest(
                h.get(AUTH_HEADER, ""), sign(tok, "hook", nonce)):
            body = json.dumps({"detail": "only thimble's plugin may call this route"}).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        proof = sign(tok, "server", nonce)

        async def with_proof(message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message).append(PROOF_HEADER, proof)
            await send(message)

        await self.app(scope, receive, with_proof)
