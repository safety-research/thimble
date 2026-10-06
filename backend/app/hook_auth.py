"""The routes only thimble's plugin and hooks call: the plugin's hooks' (plugin/bin/.thimble-watch, and
bin/thimble-agents for /api/agents), its MCP shim's (bin/thimble-mcp: the event subscription and tool
calls), its hooks module's (plugin/hooks/thimble.ts: /api/module/*, app/module_bridge.py), and the hooks of the
sessions thimble starts (app/permission_hook.py).

Any process on the machine can reach a loopback port, and the plugin runs in every Claude Code session that has it,
so each side proves it holds the token the supervisor writes into <home>/server.json (readable by its owner alone,
cli.write_state) without sending it: a request carries a fresh nonce and HMAC-SHA256(token, "hook:" + nonce), and the
answer carries HMAC-SHA256(token, "server:" + nonce). HookAuth answers a request on a guarded route without a valid
proof with 401. A hook or shim that finds no server.json, no token in it, or no valid proof on the answer sends
nothing or believes nothing, so a process that holds the recorded port learns nothing from the plugin and cannot answer
it.

A program thimble runs for one of its agents (harness.py) cannot read server.json. It gets a token of its own instead,
`<id>.<secret>`, valid while it runs and only on the routes its grant allows (grant): its requests carry AGENT_HEADER
with the id and prove the whole token the same way, and the answer proves it back. The request's scope then holds the
id under AGENT_SCOPE, so a route acts for that agent alone.

A session thimble starts tells its tool calls apart from main's by THIMBLE_SESSION, which its shim sends with each
call. Any process can set that variable, the user's own sessions included, so the name alone
proves nothing: each session also gets THIMBLE_SESSION_TOKEN in its --settings `env`, a nonce and its
HMAC-SHA256 under SESSION_KEY with the workspace and the session's key (session_token), and the server believes the
name only with a token it signed for that workspace (session_proven). The key is a file in thimble's home that no agent
may read (userconf.private_paths), and it outlives a restart, as the sessions a restart resumes do.

A change of permission modes, and an answer to a permission request, must come from the analyst's browser (analyst).
The dashboard link carries the `ui_key` of server.json after `#k=`; the page trades it for an HttpOnly, SameSite=Strict
cookie named for this server's port (claim, ui_cookie), which such a request must carry. Only the analyst's terminal
shows that link (cli.py leave_link), never the model's context, so a process that cannot read server.json, such as a
notebook kernel in bubblewrap that the model writes cells for, can do neither.
"""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
from pathlib import Path
from typing import Callable

from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.responses import Response

HOOK_PATHS = frozenset({
    "/api/events/pull", "/api/events/ack", "/api/events/held", "/api/events/mode", "/api/events/permission",
    "/api/agents", "/api/bg/agent-check",
    # thimble's agents' hooks (subagents.py), each beside the record it wrote to the workspace's files
    "/api/subagents/started", "/api/subagents/denied", "/api/subagents/stopped", "/api/subagents/end",
    "/api/subagents/rekey",
})
SHIM_PATHS = frozenset({"/api/events"})
MODULE_PREFIX = "/api/module/"  # the hooks module's routes (app/module_bridge.py): every one, whatever the method
TOOL_PREFIX = "/api/tools/"  # POST /api/tools/<name>; GET /api/tools/holdings is the CLI's and stays open
SESSION_HOOK_PATHS = re.compile(r"/api/ws/[^/]+/(sessions/permission|calls/ref)")
NONCE_HEADER = "x-thimble-nonce"
AGENT_HEADER = "x-thimble-agent"  # the id of an agent's token (module note)
AGENT_SCOPE = "thimble_agent"  # where a request proven with an agent's token keeps its id, in the ASGI scope's state
AUTH_HEADER = "x-thimble-auth"
PROOF_HEADER = "x-thimble-proof"
NONCE_MAX = 128  # characters
SESSION_KEY = "session.key"  # in thimble's home: the secret session tokens are signed with (module note)
SESSION_TOKEN_ENV = "THIMBLE_SESSION_TOKEN"
_secret_lock = threading.Lock()
UI_COOKIE = "thimble-ui"  # the cookie's name before the port was added to it (ui_cookie), which browsers still hold
UI_COOKIE_AGE_S = 400 * 24 * 3600  # the longest a browser keeps a cookie
# The cookie the browser holds (claim) and analyst() and LocalWriteGuard check. A cookie is not bound to a port, so the
# path is what keeps it from the browser's requests to other services on 127.0.0.1, except requests to their own /api/
# paths. It covers the whole API, not just /api/ws/, so a browser proves itself to LocalWriteGuard on every write route.
UI_COOKIE_PATH = "/api/"
LEGACY_COOKIE_PATHS = ("/api/ws/", "/api/")  # where UI_COOKIE was set; claim and a moved cookie delete it there
ANALYST_ONLY = ("open thimble from the link shown under /thimble's reply, or printed by `thimble up` in a shell, to"
                " answer permission requests or change permission modes")

# A write to the local API (any method but GET/HEAD/OPTIONS) must prove it comes from thimble's own browser (the ui_key
# cookie) or a local tool that can read server.json (the hook proof). A notebook kernel runs model-authored code with
# the host's network and can reach this server on 127.0.0.1, but the sandbox hides server.json from it (its token and
# ui_key), so it can produce neither and is refused. Request headers, including Origin, are forgeable by such a caller,
# so the Origin check alone is no boundary against it (http_guard).
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
WRITE_REFUSED = ("open thimble from the link shown under /thimble's reply, or printed by `thimble up` in a shell, to"
                 " make changes")

_cache: tuple[tuple[str, int, int], dict] | None = None
# the tokens of the programs thimble runs, by id: (the whole token, whether its grant allows a method and path)
_agents: dict[str, tuple[str, Callable[[str, str], bool]]] = {}


def grant(token_id: str, token: str, allows: Callable[[str, str], bool]) -> None:
    """Accept the agent token `token` (`<token_id>.<secret>`) on the requests `allows(method, path)` lets through."""
    _agents[token_id] = (token, allows)


def revoke(token_id: str) -> None:
    _agents.pop(token_id, None)


def _token_for(headers: Headers, method: str, path: str) -> tuple[str, str]:
    """(the token a request must prove, the agent's id or ''): server.json's, or the token of the agent the request
    names when its grant allows the request, else ''."""
    aid = headers.get(AGENT_HEADER, "")
    if not aid:
        return token(), ""
    got = _agents.get(aid)
    return (got[0], aid) if got is not None and got[1](method, path) else ("", aid)


def agent_of(scope: dict) -> str:
    """The id of the agent token a request was proven with, '' for any other request."""
    return str((scope.get("state") or {}).get(AGENT_SCOPE) or "")


def sign(token: str, role: str, nonce: str) -> str:
    """The proof `role` ("hook" or "server") gives for `nonce`."""
    return hmac.new(token.encode("utf-8"), f"{role}:{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def headers(token: str, nonce: str) -> dict[str, str]:
    """A hook's request headers for `nonce`."""
    return {NONCE_HEADER: nonce, AUTH_HEADER: sign(token, "hook", nonce)}


def guarded(method: str, path: str) -> bool:
    """Whether a request needs the proof: a hook's, the shim's or the hooks module's route, or a tool call."""
    return (path in HOOK_PATHS or path in SHIM_PATHS or path.startswith(MODULE_PREFIX)
            or (method == "POST" and path.startswith(TOOL_PREFIX)) or SESSION_HOOK_PATHS.fullmatch(path) is not None)


def _state() -> dict:
    """<home>/server.json, read again whenever the file changes; {} when there is none."""
    global _cache
    p = home() / "server.json"
    try:
        st = p.stat()
    except OSError:
        return {}
    key = (str(p), st.st_mtime_ns, st.st_size)
    if _cache is not None and _cache[0] == key:
        return _cache[1]
    try:
        data = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    data = data if isinstance(data, dict) else {}
    _cache = (key, data)
    return data


def _field(name: str) -> str:
    value = _state().get(name)
    return value if isinstance(value, str) else ""


def token() -> str:
    """The token in <home>/server.json ('' when there is none)."""
    return _field("token")


def home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def _read_secret(path: Path) -> bytes:
    try:
        return path.read_bytes().strip()
    except OSError:
        return b""


def _session_secret(create: bool) -> bytes:
    """The bytes of <home>/SESSION_KEY; b"" when there is none. With `create` and no key, fresh random bytes go in place
    whole, readable by their owner alone, unless another start put a key there first, which is then the one used."""
    path = home() / SESSION_KEY
    got = _read_secret(path)
    if got or not create:
        return got
    with _secret_lock:
        got = _read_secret(path)
        if got:
            return got
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{SESSION_KEY}.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(secrets.token_hex(32))
            try:
                os.link(tmp, path)
            except FileExistsError:
                if not _read_secret(path):  # an empty or unreadable file in its place
                    os.replace(tmp, path)
        finally:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
        return _read_secret(path)


def ensure_session_key() -> None:
    """Write <home>/SESSION_KEY when there is none, so the sessions' sandbox hides a file that is in place and the first
    sessions to start find one key."""
    _session_secret(True)


def _session_mac(secret: bytes, c: str, key: str, nonce: str) -> str:
    return hmac.new(secret, f"session\n{c}\n{key}\n{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def session_token(c: str, key: str) -> str:
    """A new THIMBLE_SESSION_TOKEN for the session `key` of workspace `c` (module note): `<nonce>.<mac>`."""
    nonce = secrets.token_hex(8)
    return f"{nonce}.{_session_mac(_session_secret(True), c, key, nonce)}"


def session_proven(c: str, key: str, token: str) -> bool:
    """Whether `token` is one session_token gave for the session `key` of workspace `c`."""
    nonce, _, mac = (token or "").partition(".")
    secret = _session_secret(False)
    return bool(secret and nonce and mac and key) and _same(mac, _session_mac(secret, c, key, nonce))


def _same(a: str, b: str) -> bool:
    """hmac.compare_digest over the UTF-8 bytes, so a value that is not ASCII is unequal rather than a TypeError."""
    return hmac.compare_digest(a.encode("utf-8", "surrogateescape"), b.encode("utf-8", "surrogateescape"))


def ui_cookie() -> str:
    """This server's cookie name: UI_COOKIE and its port (THIMBLE_PORT), as a browser keeps one cookie per name for
    127.0.0.1 whatever the port, and two servers on one machine would each overwrite the other's. UI_COOKIE when the
    port is not known."""
    port = os.environ.get("THIMBLE_PORT", "").strip()
    return f"{UI_COOKIE}-{port}" if port.isdigit() else UI_COOKIE


def key_cookie(cookies: dict[str, str]) -> tuple[bool, bool]:
    """(proves, legacy): whether `cookies` hold server.json's ui_key, and whether only under UI_COOKIE, the name a
    browser that claimed the key before the port was added to it still holds, at /api/ws/ (moved by LocalWriteGuard)."""
    key = _field("ui_key")
    if not key:
        return False, False
    name = ui_cookie()
    if _same(cookies.get(name, ""), key):
        return True, False
    if name != UI_COOKIE and _same(cookies.get(UI_COOKIE, ""), key):
        return True, True
    return False, False


def analyst(request: Request) -> bool:
    """Whether `request` carries the cookie claim gave for server.json's ui_key."""
    return key_cookie(request.cookies)[0]


def set_cookie(r: Response, key: str) -> Response:
    """`r` with this server's cookie for `key` (ui_cookie, at UI_COOKIE_PATH), and UI_COOKIE deleted where it was
    set."""
    r.delete_cookie(UI_COOKIE, path="/")  # and none for every path, which other services' pages would get too
    if ui_cookie() != UI_COOKIE:
        for path in LEGACY_COOKIE_PATHS:
            r.delete_cookie(UI_COOKIE, path=path)
    r.set_cookie(ui_cookie(), key, max_age=UI_COOKIE_AGE_S, path=UI_COOKIE_PATH, httponly=True, samesite="strict")
    return r


def claim(key: object) -> Response:
    """The cookie for the ui_key `key` from the page's link; 403 for any other key."""
    want = _field("ui_key")
    if not (want and isinstance(key, str) and _same(key, want)):
        return Response(status_code=403)
    return set_cookie(Response(status_code=204), want)


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
        tok, aid = _token_for(h, scope.get("method", ""), scope.get("path", ""))
        if not tok or not nonce or len(nonce) > NONCE_MAX or not hmac.compare_digest(
                h.get(AUTH_HEADER, ""), sign(tok, "hook", nonce)):
            body = json.dumps({"detail": "only thimble's plugin may call this route"}).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        proof = sign(tok, "server", nonce)
        if aid:
            scope.setdefault("state", {})[AGENT_SCOPE] = aid

        async def with_proof(message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message).append(PROOF_HEADER, proof)
            await send(message)

        await self.app(scope, receive, with_proof)


def write_guarded(method: str, path: str) -> bool:
    """Whether LocalWriteGuard gates this request: a write (not GET/HEAD/OPTIONS) to the local API, but not /api/ui/key,
    where the browser trades the ui_key for the cookie before it holds one."""
    return method not in SAFE_METHODS and _api(path) and path != "/api/ui/key"


def _api(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


def hook_proof(headers: Headers, method: str = "", path: str = "") -> bool:
    """Whether `headers` carry a valid hook proof: a local tool that read the token (the plugin, the CLI,
    view_check.py), or an agent's token on a request its grant allows."""
    tok = _token_for(headers, method, path)[0]
    nonce = headers.get(NONCE_HEADER, "")
    return bool(tok and nonce and len(nonce) <= NONCE_MAX
                and _same(headers.get(AUTH_HEADER, ""), sign(tok, "hook", nonce)))


class LocalWriteGuard:
    """403 for a write to the local API that proves neither the ui_key cookie (the browser) nor the token (the plugin,
    the CLI or a view build's check). The notebook kernel runs model-authored code with the host's network and can reach
    this server on 127.0.0.1, but the sandbox hides server.json from it, so it can prove neither and changes nothing
    here.

    A request that proves the key only with UI_COOKIE, the name before the port was added to it, also gets this server's
    cookie at UI_COOKIE_PATH on its answer, so a browser that claimed the key before holds it on every /api/ path from
    its next /api/ws/ request on, without the link. Pure ASGI."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not _api(scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        proves, legacy = key_cookie(Request(scope).cookies)
        guarded = write_guarded(scope.get("method", ""), scope["path"])
        if guarded and not proves and not hook_proof(Headers(scope=scope), scope.get("method", ""), scope["path"]):
            body = json.dumps({"detail": WRITE_REFUSED}).encode()
            await send({"type": "http.response.start", "status": 403,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        if not legacy:
            await self.app(scope, receive, send)
            return
        moved = [(k, v) for k, v in set_cookie(Response(), _field("ui_key")).raw_headers if k == b"set-cookie"]

        async def moving(message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [*message.get("headers", []), *moved]
            await send(message)

        await self.app(scope, receive, moving)
