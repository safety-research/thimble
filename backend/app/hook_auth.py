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

Everything the analyst does in thimble (a message, a click, a permission answer, a change of Settings or of a permission
mode) must come from a signed-in browser (analyst). The dashboard link carries a one-time code after `#p=`, which the
server makes when the link is shown (mint: main's Stop hook, `thimble up`); the page trades it for an HttpOnly,
SameSite=Strict cookie (claim), and the code then stops working, as it does PAIR_TTL_S after it was made or when a newer
code for the same workspace is made. A browser that is signed in already spends a code with no change. The server keeps
only the sha256 of each code and of each browser's cookie (PAIRED_FILE, read at start and then kept in memory), so no
file, transcript or link holds a credential that lasts. The token proves only the routes hooks, the shim, the module and
the CLI use (guarded); with it a process can mint a code, and each new sign-in prints a line in main's terminal and posts
a notice.

Reads are gated too (LocalReadGuard), since another account on a shared computer reaches the loopback port as well:
every GET or HEAD under /api needs the signed-in browser's cookie or a hook proof (the CLI sends one with every
request), except OPEN_READS.
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
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

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
# the routes only thimble's CLI posts to (cli._request, which proves the token), and the pairing routes the Stop hook and
# `thimble up` / `thimble unpair` call
CLI_PATHS = frozenset({
    "/api/corpora/register", "/api/dev/announce", "/api/dev/revert", "/api/extensions/refresh", "/api/subagents/caller",
    "/api/ui/pair", "/api/ui/unpair",
})
CLI_WS_PATHS = re.compile(r"/api/ws/[^/]+/(session|precached/context|archive|restore|rename)")  # POST
CLI_WS_DELETE = re.compile(r"/api/ws/[^/]+")  # DELETE: a workspace removed (`thimble rm`)
NONCE_HEADER = "x-thimble-nonce"
AGENT_HEADER = "x-thimble-agent"  # the id of an agent's token (module note)
AGENT_SCOPE = "thimble_agent"  # where a request proven with an agent's token keeps its id, in the ASGI scope's state
AUTH_HEADER = "x-thimble-auth"
PROOF_HEADER = "x-thimble-proof"
NONCE_MAX = 128  # characters
SESSION_KEY = "session.key"  # in thimble's home: the secret session tokens are signed with (module note)
SESSION_TOKEN_ENV = "THIMBLE_SESSION_TOKEN"
_secret_lock = threading.Lock()
UI_COOKIE = "thimble-ui"  # the cookie's name, with this server's port after it (ui_cookie)
UI_COOKIE_AGE_S = 400 * 24 * 3600  # the longest a browser keeps a cookie
# The cookie the browser holds (claim) and analyst() and LocalWriteGuard check. A cookie is not bound to a port, so the
# path is what keeps it from the browser's requests to other services on 127.0.0.1, except requests to their own /api/
# paths. It covers the whole API, not just /api/ws/, so a browser proves itself to LocalWriteGuard on every write route.
UI_COOKIE_PATH = "/api/"
PAIRED_FILE = "paired.json"  # in thimble's home: [{hash, at}], the sha256 of each signed-in browser's cookie (claim)
PAIR_TTL_S = 300  # a link's sign-in code works this long after it was made (mint), and once
# a click route's 403 without the analyst's cookie: every such click, not only the permission answers (live check L32)
ANALYST_ONLY = ("only the analyst's own thimble page can do this (start, message or stop thimble's agents, build a view,"
                " answer a permission request, change a permission mode): open it from the link shown under /thimble's"
                " reply, or printed by `thimble up` in a shell, and click there")

# A write to the local API (any method but GET/HEAD/OPTIONS) is either a token route (guarded: the plugin, the CLI, a
# program's grant), which needs the hook proof, or an analyst route, which needs a signed-in browser's cookie (analyst).
# A notebook kernel can reach this server on 127.0.0.1 but holds neither.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
WRITE_REFUSED = ("open thimble from the link shown under /thimble's reply, or printed by `thimble up` in a shell, to"
                 " make changes")
CODE_GONE = ("This sign-in link was already used or has expired. Run `thimble up` in a shell for a new one, or type"
             " /thimble in your terminal.")
# A read of the local API (GET or HEAD) needs a signed-in browser's cookie or a hook proof too (LocalReadGuard), except
# these: the supervisor's, the plugin's and the page's health check, and the page's question whether it is signed in
OPEN_READS = frozenset({"/api/health", "/api/ui/paired"})
READ_METHODS = frozenset({"GET", "HEAD"})
SIGN_IN_NEEDED = ("open thimble from the link shown under /thimble's reply, or printed by `thimble up` in a shell, to"
                  " see it")

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
    """Whether a request needs the proof: a hook's, the shim's or the hooks module's route, a tool call, or a route only
    the CLI calls (CLI_PATHS, CLI_WS_PATHS, CLI_WS_DELETE)."""
    return (path in HOOK_PATHS or path in SHIM_PATHS or path.startswith(MODULE_PREFIX)
            or (method == "POST" and path.startswith(TOOL_PREFIX)) or SESSION_HOOK_PATHS.fullmatch(path) is not None
            or (method == "POST" and (path in CLI_PATHS or CLI_WS_PATHS.fullmatch(path) is not None))
            or (method == "DELETE" and CLI_WS_DELETE.fullmatch(path) is not None))


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


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "surrogateescape")).hexdigest()


def _now() -> float:
    """The clock codes expire by."""
    return time.monotonic()


# a live sign-in code's sha256 -> (when it expires on _now's clock, the workspace it was made for or ""); in memory
# only, so a restart voids every code
_codes: dict[str, tuple[float, str]] = {}
# the signed-in browsers, [{hash, at}], as read from PAIRED_FILE in thimble's home at the first use (the home named
# beside them) and then kept: another process's later edit of the file is not read until the next start
_paired: list[dict[str, str]] | None = None
_paired_home = ""
_pair_lock = threading.Lock()


def mint(ws: str = "") -> str:
    """A new sign-in code for the link of workspace `ws` ("" for the start page): it works once, for PAIR_TTL_S, and a
    newer code for the same workspace voids it. Expired codes go."""
    code = secrets.token_urlsafe(16)
    now = _now()
    with _pair_lock:
        live = {h: v for h, v in _codes.items() if v[0] > now and v[1] != ws}
        _codes.clear()
        _codes.update(live)
        _codes[_sha(code)] = (now + PAIR_TTL_S, ws)
    return code


def _spend(code: object) -> bool:
    """Spend the code `code`: whether it was alive."""
    if not isinstance(code, str) or not code:
        return False
    with _pair_lock:
        got = _codes.pop(_sha(code), None)
    return got is not None and got[0] > _now()


def _paired_file() -> Path:
    return home() / PAIRED_FILE


def _entries() -> list[dict[str, str]]:
    """The signed-in browsers (module note), read from PAIRED_FILE at the first use for this home."""
    global _paired, _paired_home
    where = str(home())
    if _paired is not None and _paired_home == where:
        return _paired
    try:
        raw = json.loads(_paired_file().read_text("utf-8"))
    except (OSError, ValueError):
        raw = []
    got = [{"hash": str(e["hash"]), "at": str(e.get("at") or "")} for e in (raw if isinstance(raw, list) else [])
           if isinstance(e, dict) and isinstance(e.get("hash"), str) and re.fullmatch(r"[0-9a-f]{64}", e["hash"])]
    _paired, _paired_home = got, where
    return _paired


def _save(entries: list[dict[str, str]]) -> None:
    """`entries` as the signed-in browsers, in memory and written through to PAIRED_FILE (whole, readable by its owner
    alone); an empty list deletes the file."""
    global _paired, _paired_home
    _paired, _paired_home = list(entries), str(home())
    path = _paired_file()
    if not _paired:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()
        return
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{PAIRED_FILE}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(_paired, indent=1))
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp)


def _cookie_hash(request: Request) -> str:
    """The sha256 of the browser's cookie, when it is one of a signed-in browser; '' otherwise."""
    value = request.cookies.get(ui_cookie(), "")
    if not value:
        return ""
    want = _sha(value)
    with _pair_lock:
        known = [e["hash"] for e in _entries()]
    return want if any(_same(want, h) for h in known) else ""


def analyst(request: Request) -> bool:
    """Whether `request` comes from a signed-in browser: it carries a cookie claim gave, which no sign_out or unpair
    took back."""
    return bool(_cookie_hash(request))


def browser_id(request: Request) -> str:
    """The id of the signed-in browser `request` comes from, the first 12 hex digits of its cookie's sha256; '' for a
    request from no signed-in browser."""
    return _cookie_hash(request)[:12]


def set_cookie(r: Response, value: str) -> Response:
    """`r` with this server's cookie `value` (ui_cookie, at UI_COOKIE_PATH)."""
    r.set_cookie(ui_cookie(), value, max_age=UI_COOKIE_AGE_S, path=UI_COOKIE_PATH, httponly=True, samesite="strict")
    return r


def _gone() -> Response:
    return JSONResponse({"detail": CODE_GONE}, status_code=410)


def claim(body: Any, request: Request) -> tuple[Response, str]:
    """(the answer to a page's POST /api/ui/key with its link's code, the id of the browser it signed in or ''): a
    signed-in browser spends the code and gets 204 and nothing more; any other browser with a live code gets 204 with a
    new cookie, whose sha256 joins the signed-in browsers; anything else, an old {key} body included, 410 CODE_GONE."""
    code = body.get("code") if isinstance(body, dict) else None
    if analyst(request):
        _spend(code)
        return Response(status_code=204), ""
    if not _spend(code):
        return _gone(), ""
    cookie = secrets.token_urlsafe(32)
    digest = _sha(cookie)
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _pair_lock:
        _save([*[e for e in _entries() if e["hash"] != digest], {"hash": digest, "at": at}])
    return set_cookie(Response(status_code=204), cookie), digest[:12]


def unpair() -> None:
    """Sign every browser out: no cookie proves anything until a browser signs in again."""
    with _pair_lock:
        _save([])


def sign_out(browser: str) -> bool:
    """Sign out the browser whose id (browser_id) is `browser`; whether one was signed in."""
    if not re.fullmatch(r"[0-9a-f]{12}", browser or ""):
        return False
    with _pair_lock:
        held = _entries()
        kept = [e for e in held if not e["hash"].startswith(browser)]
        if len(kept) == len(held):
            return False
        _save(kept)
    return True


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
    where the browser trades its link's code for the cookie before it holds one."""
    return method not in SAFE_METHODS and _api(path) and path != "/api/ui/key"


def read_guarded(method: str, path: str) -> bool:
    """Whether LocalReadGuard gates this request: a read (GET or HEAD) of the local API, but not OPEN_READS."""
    return method in READ_METHODS and _api(path) and path not in OPEN_READS


def _api(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


def hook_proof(headers: Headers, method: str = "", path: str = "") -> bool:
    """Whether `headers` carry a valid hook proof: a local tool that read the token (the plugin, the CLI), or an agent's
    token on a request its grant allows."""
    tok = _token_for(headers, method, path)[0]
    nonce = headers.get(NONCE_HEADER, "")
    return bool(tok and nonce and len(nonce) <= NONCE_MAX
                and _same(headers.get(AUTH_HEADER, ""), sign(tok, "hook", nonce)))


class LocalWriteGuard:
    """403 for a write to the local API that is no token route and comes from no signed-in browser (analyst): the token
    proves only the routes guarded() names, which HookAuth checks, so neither a process that reads server.json nor a
    notebook kernel that reaches 127.0.0.1 changes anything else here. Pure ASGI."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        path, method = scope.get("path", ""), scope.get("method", "")
        if (scope["type"] != "http" or not _api(path) or guarded(method, path) or not write_guarded(method, path)
                or analyst(Request(scope))):
            await self.app(scope, receive, send)
            return
        body = json.dumps({"detail": WRITE_REFUSED}).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


def read_allowed(scope: dict) -> bool:
    """Whether a gated read may go on: it comes from a signed-in browser (analyst) or carries a hook proof (the plugin,
    the CLI; an agent's token proves no read, as its grant allows none)."""
    path, method = scope.get("path", ""), scope.get("method", "")
    return analyst(Request(scope)) or hook_proof(Headers(scope=scope), method, path)


class LocalReadGuard:
    """401 for a read of the local API (read_guarded) that read_allowed refuses, so another account on the computer, or
    a notebook kernel, that reaches 127.0.0.1 reads none of the analyst's chats, cards, reports or files through
    thimble. The body is {detail: SIGN_IN_NEEDED, signin: true}, which tells the page to show its sign-in line; a HEAD
    gets no body. A token route is HookAuth's to answer. Pure ASGI."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        path, method = scope.get("path", ""), scope.get("method", "")
        if (scope["type"] != "http" or not read_guarded(method, path) or guarded(method, path)
                or read_allowed(scope)):
            await self.app(scope, receive, send)
            return
        body = b"" if method == "HEAD" else json.dumps({"detail": SIGN_IN_NEEDED, "signin": True}).encode()
        headers = [(b"content-length", str(len(body)).encode())]
        if body:
            headers.insert(0, (b"content-type", b"application/json"))
        await send({"type": "http.response.start", "status": 401, "headers": headers})
        await send({"type": "http.response.body", "body": body})
