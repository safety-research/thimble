"""The routes only thimble's plugin and hooks call: the plugin's hooks' (plugin/bin/.thimble-watch, and
bin/thimble-agents for /api/agents), its MCP shim's (bin/thimble-mcp: the event subscription and tool
calls), its hooks module's (plugin/hooks/thimble.ts: /api/module/*, app/module_bridge.py), and the hooks of the
sessions thimble starts (app/permission_hook.py).

Any process on the machine can reach a loopback port, and the plugin runs in every Claude Code session that has it,
so each side proves it holds the token the supervisor writes into <home>/server.json (readable by its owner alone,
cli.write_state) without sending it: a request carries a fresh nonce, `<unix time>.<random hex>` (new_nonce), and
HMAC-SHA256(token, "hook@<port>:" + nonce) for the port it was sent to (request_proof), and the answer carries
HMAC-SHA256(token, "server:" + nonce). The server checks the proof against the port it listens on, refuses one whose
time is more than PROOF_TTL_S away from its own clock, and takes each nonce once (proven). So a proof a client sent to
another process, such as another account's program that holds the recorded port while thimble's server runs on
another, proves nothing anywhere: not on this server's port, not later, not twice. HookAuth answers a request on a
guarded route without a valid proof with 401. A hook or shim that finds no server.json, no token in it, or no valid
proof on the answer sends nothing more or believes nothing, so a process that holds the recorded port learns nothing
from the plugin and cannot answer it.

A program thimble runs for one of its agents (harness.py) cannot read server.json. It gets a token of its own instead,
`<id>.<secret>`, valid while it runs and only on the routes its grant allows (grant): its requests carry AGENT_HEADER
with the id and HMAC-SHA256(token, "hook:" + nonce) for any fresh nonce (docs/agents.md documents it for extension
programs, and its WebSocket to the session route proves the token the same way, harness._proven), and the answer proves
it back. That proof is bound to no port or time: the program is handed the address of the server that runs it, so it
sends the token nowhere else, and the token stops working when the run ends. The request's scope then holds the id
under AGENT_SCOPE, so a route acts for that agent alone.

A session thimble starts tells its tool calls apart from main's by THIMBLE_SESSION, which its shim sends with each
call. Any process can set that variable, the user's own sessions included, so the name alone
proves nothing: each session also gets THIMBLE_SESSION_TOKEN in its --settings `env`, a nonce and its
HMAC-SHA256 under SESSION_KEY with the workspace and the session's key (session_token), and the server believes the
name only with a token it signed for that workspace (session_proven). The key is a file in thimble's home that no agent
may read (userconf.private_paths), and it outlives a restart, as the sessions a restart resumes do.

Everything the analyst does in thimble (a message, a click, a change of Settings) must come from a signed-in browser
(analyst). The page opens on a one-time code after `#p=`, which the server makes when the page is opened (mint:
`thimble open`, app/open_cmd.py; main's Stop hook and `thimble up` for a link a person copies); the page trades it for
an HttpOnly, SameSite=Strict cookie and a random key of that browser's own (claim), and the code then stops working, as
it does when its time is over (PRESS_TTL_S for a page `thimble open` opens on this computer, LINK_TTL_S for a link a
person copies) or OVERLAP_S after a newer code for the same workspace is made, so a double press leaves both tabs
signed in. A browser that is signed in already spends a code with no change. The server keeps only the sha256 of each
code, and of each browser's cookie and key (PAIRED_FILE, read at start and then kept in memory), so no file,
transcript or link holds a credential that lasts. The token proves only the routes hooks, the shim, the module and the
CLI use (guarded); with it a process can mint a code, and each new sign-in posts a notice in each workspace it may act
in (main.signed_in).

Same user only. A code is in two places only, the redirect file `thimble open` writes and a remote terminal's link
file (app/opener.py), each readable by the analyst's account alone; it is in no argv, output, log or model context.
On Linux the claim route also asks the kernel which account owns the connection the claim came on (peer_uid, from
/proc/net/tcp and tcp6) and refuses one of another account (same_user); an SSH or VS Code forward connects as the
analyst's own account.

A cookie lasts UI_COOKIE_AGE_S and is sent again with each signed request (SlidingCookie), so a browser in daily use
stays signed in; a signed-in browser not used for PAIRED_IDLE_S signs in again (its entry's `used`, written at most
once in TOUCH_S). A tab whose server went away may later reach another program that holds the old port. Before such a
tab sends its cookie or its key again, it asks HELLO_PATH on the plain path, with no credentials, for an HMAC of a
fresh nonce under the sha256 of its key, bound to the port the server listens on (hello); a program that is not this
server cannot answer it, and the tab stops (frontend lib/stale).

A cookie is bound to a host and a path, never to a port, so a browser sends a cookie of 127.0.0.1 to every server on
127.0.0.1 (and one of localhost to every server on localhost) whose page asks for a path the cookie covers. A cookie
scoped to /api/ would reach any other program on the computer that serves a page the analyst opens (a project's dev
server, another account's server) as soon as that page asks for one of its own /api/ paths. So each browser's cookie is
scoped to a path of its own, /b/<key>/api/ (browser_path), where <key> is the random key the claim gives that browser
alone. The page keeps the key (frontend lib/browserKey) and sends every request to the API under that path, which
BrowserPath takes off again before any check or route sees the request; the cookie counts only on the path of the key
it was given with (_cookie_hash). No other page knows the key, so the browser sends the cookie to no other server, on
any port or host name. A browser that lost its key (cleared site data, a private window, a new browser) shows the
sign-in line, and the link signs it in again with a new cookie and key.

Reads are gated too (LocalReadGuard), since another account on a shared computer reaches the loopback port as well:
every GET or HEAD under /api needs the signed-in browser's cookie or a hook proof (the CLI sends one with every
request), except OPEN_READS. Two narrow credentials stand in where neither can be sent. A screenshot of the page
(tools.py, dev.py) runs a headless browser with no cookie, so it carries a shot token (mint_shot) in SHOT_HEADER: random,
good for SHOT_TTL_S on GET and HEAD alone, kept in memory as its sha256. A view's frame is sandboxed with an opaque
origin, which the browser sends no SameSite=Strict cookie from, so the one URL it loads, the view's media route, carries
a key in its path (media_key: an HMAC under SESSION_KEY of the workspace, the view and who loaded the frame), good for
that view's media alone, and only while the browser that loaded the frame stays signed in (or the shot's token, or
server.json's token, lives). The server log shows such a URL with `<key>` in its place (hide_media_keys). What let a read through is asked again before each later part of its answer goes out, so a browser signed out,
or a shot whose token ended, gets nothing more on an event stream it opened before (read_still_allowed).
"""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

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
    "/api/ui/pair", "/api/ui/unpair", "/api/ui/shot",
})
# POST; `act` is the terminal's change after the press (`thimble act`, app/term_acts.py), which the browser's own routes
# for the same change take only with its cookie
CLI_WS_PATHS = re.compile(r"/api/ws/[^/]+/(session|precached/context|archive|restore|rename|act)")
CLI_WS_DELETE = re.compile(r"/api/ws/[^/]+")  # DELETE: a workspace removed (`thimble rm`)
NONCE_HEADER = "x-thimble-nonce"
AGENT_HEADER = "x-thimble-agent"  # the id of an agent's token (module note)
AGENT_SCOPE = "thimble_agent"  # where a request proven with an agent's token keeps its id, in the ASGI scope's state
AUTH_HEADER = "x-thimble-auth"
PROOF_HEADER = "x-thimble-proof"
NONCE_MAX = 128  # characters
# a request's proof is good while the time in its nonce is this close to the server's clock, and once (module note)
PROOF_TTL_S = 300
PROOF_SCOPE = "thimble_proof"  # where a request's checked proof is kept in the ASGI scope's state (proven_by)
SESSION_KEY = "session.key"  # in thimble's home: the secret session tokens are signed with (module note)
SESSION_TOKEN_ENV = "THIMBLE_SESSION_TOKEN"
_secret_lock = threading.Lock()
UI_COOKIE = "thimble-ui"  # the cookie's name, with this server's port after it (ui_cookie)
UI_COOKIE_AGE_S = 30 * 24 * 3600  # a cookie's life, renewed on each signed request (SlidingCookie)
# The cookie the browser holds (claim) and analyst() and LocalWriteGuard check is scoped to its browser's own path,
# BROWSER_PREFIX + <key> + "/api/" (browser_path, module note), which covers the whole API under that path, so a browser
# proves itself to LocalWriteGuard on every write route.
BROWSER_PREFIX = "/b/"
# a request under a browser's path: (its key, the API path it stands for); a key is secrets.token_urlsafe's alphabet
BROWSER_PATH = re.compile(r"/b/([A-Za-z0-9_-]{16,128})(/api(?:/.*)?)", re.DOTALL)
BROWSER_KEY_SCOPE = "thimble_browser_key"  # where BrowserPath keeps a request's key, in the ASGI scope's state
BROWSER_KEY_BYTES = 24  # a browser's key: secrets.token_urlsafe of this many bytes (32 characters)
# The path earlier builds scoped the cookie to, which every server on 127.0.0.1 received; a claim deletes one there.
OLD_COOKIE_PATH = "/api/"
# in thimble's home: [{hash, key, at, used}], the sha256 of each signed-in browser's cookie and key (claim), when it
# signed in and when it was last used (at most TOUCH_S out of date)
PAIRED_FILE = "paired.json"
PRESS_TTL_S = 60  # the code of a page `thimble open` opens on this computer works this long, and once
LINK_TTL_S = 300  # the code of a link a person copies (a remote terminal, the Stop hook, `thimble up`)
PAIR_TTL_S = LINK_TTL_S  # a code's life when the pair route names none
OVERLAP_S = 10  # an older code of the same workspace keeps working this long after a newer one is made
PAIRED_IDLE_S = 30 * 24 * 3600  # a signed-in browser unused this long is signed out
TOUCH_S = 3600  # a browser's `used` is written to PAIRED_FILE at most this often
HELLO_PATH = "/api/hello"  # the stale-tab challenge (hello): open, answered without credentials
# a click route's 403 without the analyst's cookie: every such click, not only the permission answers (live check L32)
ANALYST_ONLY = ("only the analyst's own thimble page can do this (start, message or stop thimble's agents, build a view,"
                " change Settings): open it with `/thimble browser` in the Claude Code terminal, and click there")

# A write to the local API (any method but GET/HEAD/OPTIONS) is either a token route (guarded: the plugin, the CLI, a
# program's grant), which needs the hook proof, or an analyst route, which needs a signed-in browser's cookie (analyst).
# A notebook kernel can reach this server on 127.0.0.1 but holds neither.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
WRITE_REFUSED = "open thimble's page with `/thimble browser` in the Claude Code terminal to make changes"
CODE_GONE = ("This sign-in link was already used or has expired. Type `/thimble browser` in your Claude Code terminal for a"
             " new one, or press o in thimble's panel.")
OTHER_USER = "This sign-in belongs to another account on this computer."  # the claim route's 403 (same_user)
# A read of the local API (GET or HEAD) needs a signed-in browser's cookie or a hook proof too (LocalReadGuard), except
# these: the supervisor's, the plugin's and the page's health check, the page's question whether it is signed in, and
# the stale-tab challenge (hello), which needs no credential by design
OPEN_READS = frozenset({"/api/health", "/api/ui/paired", HELLO_PATH})
READ_METHODS = frozenset({"GET", "HEAD"})
SIGN_IN_NEEDED = ("thimble refused this read: thimble's data needs your browser's sign-in or thimble's own token, and"
                  " this request had neither. Use thimble's tools instead.")
SHOT_HEADER = "x-thimble-shot"  # a page screenshot's read-only token (mint_shot)
SHOT_TTL_S = 120  # a shot token's life: dev.SHOT_TIMEOUT_S (90 s) ends the headless run before it
# the view media route with its key (media_key), as the frame's browser asks for it
MEDIA_PATH = re.compile(r"/api/ws/([^/]+)/views/([^/]+)/media/([0-9a-f]{32})")

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
    """The proof `role` gives for `nonce`: "server" on an answer, "hook" on an agent program's request (module note).
    The request of a tool that read server.json proves request_proof."""
    return hmac.new(token.encode("utf-8"), f"{role}:{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def new_nonce() -> str:
    """A fresh nonce for a request's proof: the Unix time it was made, a dot, and random hex (module note)."""
    return f"{int(time.time())}.{secrets.token_hex(16)}"


def port_of(url: str) -> int:
    """The port a request to `url` goes to: the one it names, else 80 (443 for https)."""
    u = urlsplit(url)
    return u.port or (443 if u.scheme == "https" else 80)


def request_proof(token: str, port: int, nonce: str) -> str:
    """The proof a request to the server listening on `port` gives for `nonce` (module note)."""
    return hmac.new(token.encode("utf-8"), f"hook@{int(port)}:{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def headers(token: str, port: int, nonce: str | None = None) -> dict[str, str]:
    """A request's proof headers for the server on `port` (port_of a URL), with a fresh nonce unless `nonce` is given;
    the answer's proof is sign(token, "server", <the nonce>)."""
    nonce = nonce or new_nonce()
    return {NONCE_HEADER: nonce, AUTH_HEADER: request_proof(token, port, nonce)}


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


# a live sign-in code's sha256 -> (when it expires on _now's clock, the workspace it was made for or "", the open id of
# the redirect file it is in or "": app/opener.py); in memory only, so a restart voids every code
_codes: dict[str, tuple[float, str, str]] = {}
# the signed-in browsers, [{hash, at}], as read from PAIRED_FILE in thimble's home at the first use (the home named
# beside them) and then kept: another process's later edit of the file is not read until the next start
_paired: list[dict[str, str]] | None = None
_paired_home = ""
_pair_lock = threading.Lock()


def ttl_of(value: object) -> int:
    """A code's life from the pair route's `ttl`: PRESS_TTL_S when it asks for that, else LINK_TTL_S."""
    return PRESS_TTL_S if value == PRESS_TTL_S else LINK_TTL_S


def mint(ws: str = "", ttl: int = PAIR_TTL_S, open_id: str = "") -> str:
    """A new sign-in code for the page of workspace `ws` ("" for the start page): it works once, for `ttl` seconds
    (PRESS_TTL_S or LINK_TTL_S), and a newer code for the same workspace leaves it OVERLAP_S more at most. `open_id`
    names the redirect file it is in (app/opener.py), which its claim deletes. Expired codes go."""
    code = secrets.token_urlsafe(16)
    now = _now()
    with _pair_lock:
        live = {h: ((min(v[0], now + OVERLAP_S), *v[1:]) if v[1] == ws else v) for h, v in _codes.items() if v[0] > now}
        _codes.clear()
        _codes.update(live)
        _codes[_sha(code)] = (now + ttl_of(ttl), ws, open_id if isinstance(open_id, str) else "")
    return code


def code_open(code: object) -> str:
    """The open id the live code `code` was made with ('' for none, or for no live code); the code is not spent."""
    if not isinstance(code, str) or not code:
        return ""
    with _pair_lock:
        got = _codes.get(_sha(code))
    return got[2] if got is not None and got[0] > _now() else ""


def _spend(code: object) -> bool:
    """Spend the code `code`: whether it was alive."""
    if not isinstance(code, str) or not code:
        return False
    with _pair_lock:
        got = _codes.pop(_sha(code), None)
    return got is not None and got[0] > _now()


# a live shot token's sha256 -> when it expires on _now's clock; in memory only, so a restart voids every one
_shots: dict[str, float] = {}


def mint_shot() -> str:
    """A new shot token (module note): good on GET and HEAD for SHOT_TTL_S, or until drop_shot. Expired ones go."""
    tok = secrets.token_urlsafe(24)
    now = _now()
    with _pair_lock:
        for h in [h for h, until in _shots.items() if until <= now]:
            del _shots[h]
        _shots[_sha(tok)] = now + SHOT_TTL_S
    return tok


def drop_shot(tok: str) -> None:
    """The shot token `tok` stops working (its shot ended)."""
    with _pair_lock:
        _shots.pop(_sha(tok or ""), None)


def shot_proven(headers: Headers, method: str) -> bool:
    """Whether a read carries a live shot token in SHOT_HEADER; never a write."""
    tok = headers.get(SHOT_HEADER, "")
    if method not in READ_METHODS or not tok:
        return False
    with _pair_lock:
        until = _shots.get(_sha(tok))
    return until is not None and until > _now()


def read_holder(scope: dict) -> str:
    """Who the read `scope` comes from, which a view's media key is bound to (media_key): `browser:<the sha256 of its
    cookie>` for a signed-in browser, `shot:<the sha256 of the token>` for a live shot token, `token:<the sha256 of
    server.json's token>` for a hook proof; '' for none of them."""
    digest = _cookie_hash(Request(scope))
    if digest:
        return f"browser:{digest}"
    got = proven_by(scope)
    if got is not None and not got[1]:
        return f"token:{_sha(got[0])}"
    h = Headers(scope=scope)
    if shot_proven(h, scope.get("method", "")):
        return f"shot:{_sha(h.get(SHOT_HEADER, ''))}"
    return ""


def _holders() -> list[str]:
    """The holders (read_holder) whose media keys work now: each signed-in browser, each live shot token, and
    server.json's token."""
    now = _now()
    with _pair_lock:
        held = [f"browser:{e['hash']}" for e in _live()] + [f"shot:{h}" for h, until in _shots.items() if until > now]
    tok = token()
    return [*held, f"token:{_sha(tok)}"] if tok else held


def _media_mac(secret: bytes, holder: str, c: str, slug: str) -> str:
    return hmac.new(secret, f"view-media\n{holder}\n{c}\n{slug}".encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def media_key(c: str, slug: str, holder: str) -> str:
    """The key in the URL of view `slug`'s media route in workspace `c` for the frame a read of `holder` (read_holder)
    loads (module note): the same for every load by that browser, so the frame's document, and its ETag, stay the
    same, and void once the browser is signed out, the shot's token ends or the server starts with a new token. A
    holder of '' gets a key that never works."""
    return _media_mac(_session_secret(True), holder, c, slug)


def media_key_ok(c: str, slug: str, key: str) -> bool:
    """Whether `key` is media_key's for view `slug` of workspace `c` and a holder whose keys work now (_holders)."""
    secret = _session_secret(False)
    if not secret or not key:
        return False
    return any(_same(key, _media_mac(secret, h, c, slug)) for h in _holders())


# a view's media key where a URL shows it in text, such as a line of the server log (hide_media_keys)
MEDIA_KEY_TEXT = re.compile(r"(/views/[^/?#\s]+/media/)[0-9a-f]{32}")
# a browser's key where a URL under its path shows it in text (hide_media_keys)
BROWSER_KEY_TEXT = re.compile(r"(/b/)[A-Za-z0-9_-]{16,128}(/api\b)")


def hide_media_keys(text: str) -> str:
    """`text` with each view media key in a URL (MEDIA_KEY_TEXT) and each browser's key in a URL under its path
    (BROWSER_KEY_TEXT) shown as `<key>`."""
    return BROWSER_KEY_TEXT.sub(r"\1<key>\2", MEDIA_KEY_TEXT.sub(r"\1<key>", text))


def media_proven(path: str) -> bool:
    """Whether `path` is a view's media route with that view's key (MEDIA_PATH, media_key)."""
    m = MEDIA_PATH.fullmatch(path)
    return m is not None and media_key_ok(m.group(1), m.group(2), m.group(3))


def _paired_file() -> Path:
    return home() / PAIRED_FILE


def _sha_hex(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _stamp(entries: list[dict[str, str]]) -> bool:
    """Give each entry without a `used` time one of now (an entry an earlier version wrote, whose last use is not
    known, so its PAIRED_IDLE_S count from the first time this version read it); whether any had none."""
    now, stamped = _iso_now(), False
    for e in entries:
        if not e.get("used"):
            e["used"] = now
            stamped = True
    return stamped


def _entries() -> list[dict[str, str]]:
    """The signed-in browsers (module note), read from PAIRED_FILE at the first use for this home. An entry without the
    sha256 of a key (an earlier build's, whose cookie was scoped to OLD_COOKIE_PATH) signs no browser in: that browser
    signs in again with the link. An entry without its last use gets one now, written through (_stamp)."""
    global _paired, _paired_home
    where = str(home())
    if _paired is not None and _paired_home == where:
        return _paired
    try:
        raw = json.loads(_paired_file().read_text("utf-8"))
    except (OSError, ValueError):
        raw = []
    got = [{"hash": str(e["hash"]), "key": str(e["key"]), "at": str(e.get("at") or ""), "used": str(e.get("used") or "")}
           for e in (raw if isinstance(raw, list) else [])
           if isinstance(e, dict) and _sha_hex(e.get("hash")) and _sha_hex(e.get("key"))]
    _paired, _paired_home = got, where
    if _stamp(got):
        with contextlib.suppress(OSError):
            _save(got)
    return _paired


def _seconds(iso: str) -> float | None:
    """The Unix time of an ISO time an entry keeps, None for one that does not parse."""
    try:
        got = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return None
    return (got if got.tzinfo else got.replace(tzinfo=timezone.utc)).timestamp()


def _fresh(e: dict[str, str], now: float | None = None) -> bool:
    """Whether the signed-in browser `e` was used in the last PAIRED_IDLE_S (its `used`, else when it signed in)."""
    when = _seconds(e.get("used") or e.get("at") or "")
    return when is not None and (time.time() if now is None else now) - when <= PAIRED_IDLE_S


def _live() -> list[dict[str, str]]:
    """The signed-in browsers that may still sign a request (_fresh). Call with _pair_lock held."""
    now = time.time()
    return [e for e in _entries() if _fresh(e, now)]


def touch(digest: str) -> None:
    """The browser whose cookie's sha256 is `digest` was used now: its `used` is written when it is older than
    TOUCH_S. Never raises."""
    now = time.time()
    with _pair_lock:
        held = _entries()
        for e in held:
            if _same(e["hash"], digest):
                when = _seconds(e.get("used") or "")
                if when is None or now - when > TOUCH_S:
                    e["used"] = _iso_now()
                    with contextlib.suppress(OSError):
                        _save(held)
                return


def _save(entries: list[dict[str, str]]) -> None:
    """`entries` as the signed-in browsers, in memory and written through to PAIRED_FILE (whole, readable by its owner
    alone); an empty list deletes the file. An entry without its last use gets one now (_stamp)."""
    global _paired, _paired_home
    _stamp(entries)
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


def browser_path(key: str) -> str:
    """The path the cookie of the browser whose key is `key` is scoped to, and under which its page sends every request
    to the API (module note): /b/<key>/api/."""
    return f"{BROWSER_PREFIX}{key}/api/"


def path_key(scope: dict) -> str:
    """The key of the browser path a request came under (BrowserPath), '' for a request to the API's own path."""
    return str((scope.get("state") or {}).get(BROWSER_KEY_SCOPE) or "")


def _cookie_hash(request: Request) -> str:
    """The sha256 of the browser's cookie, when it is one of a signed-in browser and the request came under the path of
    the key that browser was given with it (path_key); '' otherwise, a signed-in browser's cookie on the API's own path
    or on another key's path among them."""
    value = request.cookies.get(ui_cookie(), "")
    key = path_key(request.scope)
    if not value or not key:
        return ""
    want, key_hash = _sha(value), _sha(key)
    with _pair_lock:
        known = [(e["hash"], e["key"]) for e in _live()]
    return want if any(_same(want, h) and _same(key_hash, k) for h, k in known) else ""


def analyst(request: Request) -> bool:
    """Whether `request` comes from a signed-in browser: it carries a cookie claim gave, which no sign_out or unpair
    took back, under the path of the key claim gave with it (_cookie_hash)."""
    return bool(_cookie_hash(request))


def browser_id(request: Request) -> str:
    """The id of the signed-in browser `request` comes from, the first 12 hex digits of its cookie's sha256; '' for a
    request from no signed-in browser."""
    return _cookie_hash(request)[:12]


def set_cookie(r: Response, value: str, key: str) -> Response:
    """`r` with this server's cookie `value` (ui_cookie) scoped to the path of the browser key `key` (browser_path), and
    the deletion of a cookie of that name an earlier build scoped to OLD_COOKIE_PATH."""
    r.set_cookie(ui_cookie(), value, max_age=UI_COOKIE_AGE_S, path=browser_path(key), httponly=True, samesite="strict")
    r.delete_cookie(ui_cookie(), path=OLD_COOKIE_PATH, httponly=True, samesite="strict")
    return r


def _gone() -> Response:
    return JSONResponse({"detail": CODE_GONE}, status_code=410)


def claim(body: Any, request: Request) -> tuple[Response, str]:
    """(the answer to a page's POST /api/ui/key with its link's code, the id of the browser it signed in or ''): a
    signed-in browser (which posts under its own path) spends the code and gets 204 and nothing more; any other browser
    with a live code gets 200 {key, port} with a new cookie scoped to that key's path (set_cookie), and the sha256 of
    both join the signed-in browsers; `port` is the one this server listens on, which the page's stale-tab challenge
    binds its answer to (hello); anything else, an old {key} body included, 410 CODE_GONE."""
    code = body.get("code") if isinstance(body, dict) else None
    if analyst(request):
        _spend(code)
        return Response(status_code=204), ""
    if not _spend(code):
        return _gone(), ""
    cookie = secrets.token_urlsafe(32)
    key = secrets.token_urlsafe(BROWSER_KEY_BYTES)
    digest = _sha(cookie)
    at = _iso_now()
    with _pair_lock:
        _save([*[e for e in _entries() if e["hash"] != digest], {"hash": digest, "key": _sha(key), "at": at, "used": at}])
    return set_cookie(JSONResponse({"key": key, "port": _own_port(request.scope)}), cookie, key), digest[:12]


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


# the nonces of the proofs taken in the last PROOF_TTL_S, each -> the time (on _wall's clock) after which its proof is
# refused for its age anyway, oldest first; in memory only (module note)
_seen: OrderedDict[str, float] = OrderedDict()
_seen_lock = threading.Lock()


def _wall() -> float:
    """The clock a nonce's time is read against: the wall clock, which the clients on this computer share."""
    return time.time()


def _nonce_time(nonce: str) -> int | None:
    """The Unix time at the head of a nonce new_nonce made; None for any other nonce."""
    head, dot, rest = nonce.partition(".")
    return int(head) if dot and rest and head.isascii() and head.isdigit() and len(head) <= 12 else None


def _own_port(scope: dict) -> int | None:
    """The port this server took the request on (the ASGI scope's `server`), 80 or 443 when a test transport names
    none; when the scope names no server (a socket whose address could not be read), the port the supervisor or a
    ticket's box started it on (THIMBLE_PORT), else None."""
    server = scope.get("server")
    if not server or len(server) < 2:
        port = os.environ.get("THIMBLE_PORT", "").strip()
        return int(port) if port.isascii() and port.isdigit() else None
    if server[1] is None:
        return 443 if scope.get("scheme") == "https" else 80
    try:
        return int(server[1])
    except (TypeError, ValueError):
        return None


def _check(scope: dict) -> tuple[str, str] | None:
    """(the token, the agent's id or '') a request proves (module note): its nonce's time within PROOF_TTL_S of _wall,
    its proof request_proof's for this server's port, and its nonce not taken before, which it then is; for an agent's
    token, sign's "hook" proof of its nonce. None otherwise."""
    h = Headers(scope=scope)
    nonce = h.get(NONCE_HEADER, "")
    tok, aid = _token_for(h, scope.get("method", ""), scope.get("path", ""))
    if not tok or not nonce or len(nonce) > NONCE_MAX:
        return None
    if aid:  # an agent program's token proves its request as docs/agents.md says (module note): the program is handed
        # the address of the server that runs it, and the token stops working when its run ends
        return (tok, aid) if _same(h.get(AUTH_HEADER, ""), sign(tok, "hook", nonce)) else None
    when = _nonce_time(nonce)
    port = _own_port(scope)
    if when is None or port is None:
        return None
    now = _wall()
    if abs(now - when) > PROOF_TTL_S or not _same(h.get(AUTH_HEADER, ""), request_proof(tok, port, nonce)):
        return None
    with _seen_lock:
        while _seen and next(iter(_seen.values())) < now:
            _seen.popitem(last=False)
        if nonce in _seen:
            return None
        _seen[nonce] = when + PROOF_TTL_S
    return tok, aid


def proven_by(scope: dict) -> tuple[str, str] | None:
    """_check's answer for the request `scope`, worked out once per request and kept in its state (PROOF_SCOPE), since
    a nonce is taken once and both a guard and a route may ask."""
    state = scope.setdefault("state", {})
    if PROOF_SCOPE not in state:
        state[PROOF_SCOPE] = _check(scope) if Headers(scope=scope).get(NONCE_HEADER) else None
    return state[PROOF_SCOPE]


def proven(scope: dict) -> bool:
    """Whether the request `scope` carries a valid hook proof (proven_by): a local tool that read the token (the plugin,
    the CLI), or an agent's token on a request its grant allows."""
    return proven_by(scope) is not None


class HookAuth:
    """401 for a request on a guarded route without a valid proof (proven_by); the proof of this server on every answer
    to one."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not guarded(scope.get("method", ""), scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        got = proven_by(scope)
        if got is None:
            body = json.dumps({"detail": "only thimble's plugin may call this route"}).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        tok, aid = got
        proof = sign(tok, "server", Headers(scope=scope).get(NONCE_HEADER, ""))
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


class BrowserPath:
    """A request under a browser's path, /b/<key>/api/... (BROWSER_PATH, module note), goes on as the API path it stands
    for, /api/..., with <key> kept in the request's state (BROWSER_KEY_SCOPE, path_key), so every check, route and log
    line after this sees the API's own path, and _cookie_hash counts the cookie only with the key it was given with. Any
    other request goes on as it came. Pure ASGI, outermost."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        m = BROWSER_PATH.fullmatch(scope.get("path", "")) if scope["type"] in ("http", "websocket") else None
        if m is not None:
            key, path = m.group(1), m.group(2)
            raw = scope.get("raw_path")
            head = f"{BROWSER_PREFIX}{key}".encode("ascii")
            raw = raw[len(head):] if isinstance(raw, bytes) and raw.startswith(head) else path.encode("utf-8")
            scope = {**scope, "path": path, "raw_path": raw,
                     "state": {**(scope.get("state") or {}), BROWSER_KEY_SCOPE: key}}
        await self.app(scope, receive, send)


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


def read_still_allowed(scope: dict) -> Callable[[], bool] | None:
    """Whether a gated read may go on, as a check that asks again: None when nothing lets it through; otherwise a
    function that answers whether what let it through still does. That is a signed-in browser (analyst) until it is
    signed out (sign_out, unpair), a live shot token (shot_proven) until it expires or its shot ends, a view's media
    route with that view's key (media_proven) while the key holds, and a hook proof (the plugin, the CLI; an agent's
    token proves no read, as its grant allows none) always, since the server's next start ends the request anyway."""
    path, method = scope.get("path", ""), scope.get("method", "")
    h = Headers(scope=scope)
    digest = _cookie_hash(Request(scope))
    if digest:
        return lambda: _signed_in(digest)
    if proven(scope):
        return lambda: True
    if shot_proven(h, method):
        return lambda: shot_proven(h, method)
    if method in READ_METHODS and media_proven(path):
        return lambda: media_proven(path)
    return None


def read_allowed(scope: dict) -> bool:
    """Whether a gated read may go on (read_still_allowed)."""
    return read_still_allowed(scope) is not None


def _signed_in(digest: str) -> bool:
    """Whether the browser whose cookie's sha256 is `digest` is still signed in."""
    with _pair_lock:
        return any(_same(digest, e["hash"]) for e in _live())


def _while(still: Callable[[], bool], receive, send):
    """(receive, send) for a read that may go on while `still()` holds: each part of the answer's body goes out only
    while it does, and once it does not the answer ends there, empty, and the app hears that the client left. So an event
    stream a browser opened sends nothing once that browser is signed out, nor a shot's once its token ends."""
    ended = False

    async def receive_until() -> dict:
        if ended:
            return {"type": "http.disconnect"}
        return await receive()

    async def send_while(message) -> None:
        nonlocal ended
        if ended:
            return
        if message["type"] == "http.response.body" and not still():
            ended = True
            await send({"type": "http.response.body", "body": b"", "more_body": False})
            return
        await send(message)

    return receive_until, send_while


class LocalReadGuard:
    """401 for a read of the local API (read_guarded) that read_allowed refuses, so another account on the computer, or
    a notebook kernel, that reaches 127.0.0.1 reads none of the analyst's chats, cards, reports or files through
    thimble. The body is {detail: SIGN_IN_NEEDED, signin: true}, which tells the page to show its sign-in line; a HEAD
    gets no body. A token route is HookAuth's to answer. A read it lets through stops at the first part of its answer
    sent after what let it through no longer does (read_still_allowed, _while): an event stream, which never ends by
    itself, ends at its next event or ping once its browser is signed out. Pure ASGI."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        path, method = scope.get("path", ""), scope.get("method", "")
        if scope["type"] != "http" or not read_guarded(method, path) or guarded(method, path):
            await self.app(scope, receive, send)
            return
        still = read_still_allowed(scope)
        if still is not None:
            await self.app(scope, *_while(still, receive, send))
            return
        body = b"" if method == "HEAD" else json.dumps({"detail": SIGN_IN_NEEDED, "signin": True}).encode()
        headers = [(b"content-length", str(len(body)).encode())]
        if body:
            headers.insert(0, (b"content-type", b"application/json"))
        await send({"type": "http.response.start", "status": 401, "headers": headers})
        await send({"type": "http.response.body", "body": body})


class SlidingCookie:
    """Each signed request (the cookie of a signed-in browser under its key's path, _cookie_hash) is answered with the
    same cookie again for UI_COOKIE_AGE_S, so a browser in use stays signed in and one left alone signs in again after
    a month; the browser's last use is noted (touch). A response that sets the cookie itself is left as it is. Pure
    ASGI, inside BrowserPath."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not path_key(scope):
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        digest = _cookie_hash(request)
        if not digest:
            await self.app(scope, receive, send)
            return
        touch(digest)
        renew = Response()
        set_cookie(renew, request.cookies.get(ui_cookie(), ""), path_key(scope))
        cookie = next(v for k, v in renew.raw_headers if k == b"set-cookie")

        async def renewing(message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if not any(k.lower() == "set-cookie" for k in headers.keys()):
                    headers.append("set-cookie", cookie.decode("latin-1"))
            await send(message)

        await self.app(scope, receive, renewing)


HELLO_NONCE_MAX = 128  # characters of the challenge's nonce


def key_id(key_hash: str) -> str:
    """The id a page names its key by in the challenge: the first 16 hex digits of the sha256 of the key's sha256 (the
    hex the server keeps), which tells nothing of the key or of the secret the answer is made with."""
    return _sha(key_hash)[:16]


def hello_mac(key_hash: str, port: int, nonce: str) -> str:
    """The challenge's answer: HMAC-SHA256 under the key's sha256 (hex, as UTF-8) of "hello:<port>:<nonce>", `port`
    the one this server listens on, so a program that relays the challenge to a thimble server on another port gets an
    answer the page refuses."""
    return hmac.new(key_hash.encode("utf-8"), f"hello:{int(port)}:{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def hello(nonce: object, kid: object, scope: dict) -> str | None:
    """The answer to a stale tab's challenge (module note) for the signed-in browser whose key's id is `kid`, None when
    no signed-in browser has that id or the nonce is not one."""
    if not isinstance(nonce, str) or not nonce or len(nonce) > HELLO_NONCE_MAX or not isinstance(kid, str):
        return None
    port = _own_port(scope)
    if port is None:
        return None
    with _pair_lock:
        keys = [e["key"] for e in _live()]
    for k in keys:
        if _same(key_id(k), kid):
            return hello_mac(k, port, nonce)
    return None


PROC_NET = Path("/proc/net")  # where peer_uid reads the kernel's table of TCP sockets (Linux)


def _proc_addr(text: str) -> tuple[Any, int] | None:
    """An address of /proc/net/tcp or tcp6 (`0100007F:1F90`) as (ip_address, port), IPv4-mapped IPv6 as IPv4."""
    import ipaddress  # noqa: PLC0415

    ip_hex, _, port_hex = text.partition(":")
    try:
        raw = bytes.fromhex(ip_hex)
        port = int(port_hex, 16)
    except ValueError:
        return None
    words = [raw[i:i + 4] for i in range(0, len(raw), 4)]
    if sys.byteorder == "little":
        words = [w[::-1] for w in words]
    packed = b"".join(words)
    try:
        ip = ipaddress.ip_address(packed)
    except ValueError:
        return None
    if getattr(ip, "ipv4_mapped", None) is not None:
        ip = ip.ipv4_mapped
    return ip, port


def _ip(host: object) -> Any:
    import ipaddress  # noqa: PLC0415

    try:
        ip = ipaddress.ip_address(str(host))
    except ValueError:
        return None
    return ip.ipv4_mapped if getattr(ip, "ipv4_mapped", None) is not None else ip


def peer_uid(scope: dict) -> int | None:
    """The account (uid) that owns the socket a request came from: the line of /proc/net/tcp or tcp6 whose local
    address is the request's client and whose remote address is this server's. None where that cannot be read (not
    Linux, another network namespace, no client in the scope)."""
    client, server = scope.get("client"), scope.get("server")
    if not client or not server or len(client) < 2 or len(server) < 2 or not sys.platform.startswith("linux"):
        return None
    want_local, want_remote = (_ip(client[0]), int(client[1] or 0)), (_ip(server[0]), int(server[1] or 0))
    if want_local[0] is None or want_remote[0] is None:
        return None
    for name in ("tcp", "tcp6"):
        try:
            lines = (PROC_NET / name).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 8:
                continue
            if _proc_addr(parts[1]) == want_local and _proc_addr(parts[2]) == want_remote:
                try:
                    return int(parts[7])
                except ValueError:
                    return None
    return None


def same_user(scope: dict) -> bool:
    """Whether a claim may come from the connection of `scope`: its socket is this server's own account's, or its
    owner cannot be read (peer_uid)."""
    uid = peer_uid(scope)
    return uid is None or uid == os.getuid()
