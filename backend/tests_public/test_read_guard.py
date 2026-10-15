"""Reads of the local API need a credential (app/hook_auth.py LocalReadGuard), as writes do: the signed-in browser's
cookie or the token's proof, which the CLI sends with every request. A page screenshot's headless browser holds neither,
so it carries a shot token (hook_auth.mint_shot): random, good for reads alone for a short time, kept in memory as its
sha256, and handed to the screenshot script in its environment, never on its command line. A dev ticket's shot of
another server's page gets that server's token from its POST /api/ui/shot. The health check names no path or pid
without the proof, so the CLI tells another install's server by the home it does not name."""
from __future__ import annotations

import asyncio
import io
import json
import urllib.error
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.datastructures import Headers

from app import cli, dev, hook_auth, main

REFUSED = {"detail": hook_auth.SIGN_IN_NEEDED, "signin": True}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("THIMBLE_PORT", "8300")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    return TestClient(main.create_app(), base_url="http://testserver")


@pytest.mark.real_read_guard
def test_health_names_its_home_and_pid_only_to_the_token_s_holder(client, plugin_headers):
    assert set(client.get("/api/health").json()) == {"ok", "boot", "ui"}
    full = client.get("/api/health", headers=plugin_headers()).json()
    assert full["home"] == str(hook_auth.home().resolve()) and full["leader"] and full["app"]
    wrong = hook_auth.headers("another-install-s-token", 80)
    assert set(client.get("/api/health", headers=wrong).json()) == {"ok", "boot", "ui"}


@pytest.mark.real_read_guard
@pytest.mark.real_write_guard
def test_a_proof_works_once_on_the_port_it_was_sent_to_and_only_for_a_few_minutes(client, plugin_headers, monkeypatch):
    """hook_auth.request_proof binds a request's proof to the server's port and to the time in its nonce, and the server
    takes each nonce once: a proof sent to another port (a process that holds the recorded port while thimble's server
    runs on another), one used before, one older than PROOF_TTL_S, and the unbound proof of earlier builds prove
    nothing, on a read, on a token route, or to the health check."""
    plugin_headers()  # records this server's token
    tok = hook_auth.token()
    pair = {"method": "POST", "url": "/api/ui/pair", "json": {}}
    assert client.get("/api/corpora", headers=hook_auth.headers(tok, 27787)).json() == REFUSED
    assert client.request(**pair, headers=hook_auth.headers(tok, 27787)).status_code == 401
    assert set(client.get("/api/health", headers=hook_auth.headers(tok, 27787)).json()) == {"ok", "boot", "ui"}
    once = hook_auth.headers(tok, 80)
    assert client.get("/api/corpora", headers=once).status_code == 200
    assert client.get("/api/corpora", headers=once).json() == REFUSED, "a nonce is taken once"
    assert client.request(**pair, headers=once).status_code == 401, "on any route"
    nonce = hook_auth.new_nonce()
    unbound = {hook_auth.NONCE_HEADER: nonce, hook_auth.AUTH_HEADER: hook_auth.sign(tok, "hook", nonce)}
    assert client.get("/api/corpora", headers=unbound).json() == REFUSED, "the unbound proof of earlier builds"
    assert client.request(**pair, headers=unbound).status_code == 401
    old = hook_auth.headers(tok, 80)
    later = hook_auth._wall() + hook_auth.PROOF_TTL_S + 1
    monkeypatch.setattr(hook_auth, "_wall", lambda: later)
    assert client.get("/api/corpora", headers=old).json() == REFUSED, "too old"
    early = hook_auth.headers(tok, 80, f"{int(later) + hook_auth.PROOF_TTL_S + 60}.abc")
    assert client.get("/api/corpora", headers=early).json() == REFUSED, "a time ahead of the server's clock"
    fresh = hook_auth.headers(tok, 80, f"{int(later)}.{'f' * 32}")
    assert client.get("/api/corpora", headers=fresh).status_code == 200, "a fresh one still works"
    assert once[hook_auth.NONCE_HEADER] not in hook_auth._seen, "a nonce too old to pass is forgotten"


def test_a_server_whose_socket_names_no_address_checks_a_proof_against_the_port_it_was_started_on(plugin_headers,
                                                                                                 monkeypatch):
    """A ticket box's server serves sockets the host hands it (app/handoff_serve.py); should a scope name no server, the
    proof is checked against THIMBLE_PORT, which the supervisor and the box set, and refused without one."""
    plugin_headers()

    def scope(port: int) -> dict:
        h = hook_auth.headers(hook_auth.token(), port)
        return {"type": "http", "method": "GET", "path": "/api/corpora", "server": None,
                "headers": [(k.encode(), v.encode()) for k, v in h.items()]}

    monkeypatch.setenv("THIMBLE_PORT", "27755")
    assert hook_auth.proven(scope(27755)) and not hook_auth.proven(scope(27756))
    monkeypatch.delenv("THIMBLE_PORT")
    assert not hook_auth.proven(scope(27755))


@pytest.mark.real_read_guard
def test_a_proof_the_cli_sent_to_a_process_on_its_port_reads_nothing_here(client, plugin_headers):
    """A process that holds the port the CLI asks (another account's, after a restart, or a stale THIMBLE_PORT) keeps
    the proof headers of the CLI's health check (foreign_home, which `thimble up` runs first); replayed at thimble's
    server on its own port, they read nothing and mint no sign-in code."""
    import socket  # noqa: PLC0415
    import threading  # noqa: PLC0415

    plugin_headers()
    got: dict[str, str] = {}
    with socket.socket() as srv:
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)

        def answer() -> None:
            conn, _ = srv.accept()
            with conn:
                for line in conn.recv(65536).decode("latin-1").split("\r\n")[1:]:
                    k, sep, v = line.partition(":")
                    if sep:
                        got[k.strip().lower()] = v.strip()
                body = b'{"ok": true, "boot": "x", "ui": null}'
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
                             b"Connection: close\r\n\r\n%s" % (len(body), body))

        t = threading.Thread(target=answer, daemon=True)
        t.start()
        cli.foreign_home(f"http://127.0.0.1:{srv.getsockname()[1]}")
        t.join(5)
    kept = {k: got[k] for k in (hook_auth.NONCE_HEADER, hook_auth.AUTH_HEADER)}
    assert client.get("/api/corpora", headers=kept).json() == REFUSED
    assert client.post("/api/ui/pair", json={}, headers=kept).status_code == 401


def test_the_cli_takes_a_server_that_names_no_home_for_another_install_s(monkeypatch):
    """foreign_home: this install's server names its home to this install's proof; one that names none took the proof
    for none (another install's, or another account's), and the CLI does not use it."""
    answers = {"mine": (200, {"ok": True, "boot": "b", "ui": None, "home": str(cli.home().resolve()), "app": "/x",
                              "leader": 7}),
               "theirs": (200, {"ok": True, "boot": "b", "ui": None}),
               "older": (200, {"ok": True, "home": "/home/someone/.thimble"}),
               "down": (0, "ConnectionRefusedError")}
    monkeypatch.setattr(cli, "_request", lambda m, url, b=None, timeout=5.0: answers[url.split("//")[1].split("/")[0]])
    assert cli.foreign_home("http://mine") is None
    assert cli.foreign_home("http://theirs") == cli.FOREIGN_UNNAMED
    assert cli.foreign_home("http://older") == "/home/someone/.thimble"
    assert cli.foreign_home("http://down") is None


# ---- shot tokens


def _shot(tok: str) -> dict[str, str]:
    return {hook_auth.SHOT_HEADER: tok}


@pytest.mark.real_read_guard
@pytest.mark.real_write_guard
def test_a_shot_token_reads_for_its_time_and_never_writes(client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(hook_auth, "_now", lambda: now[0])
    tok = hook_auth.mint_shot()
    assert tok not in json.dumps(list(hook_auth._shots)), "kept as its sha256 alone"
    assert client.get("/api/corpora", headers=_shot(tok)).status_code == 200
    assert client.head("/api/corpora", headers=_shot(tok)).status_code != 401
    r = client.put("/api/ws/mini/settings", json={}, headers=_shot(tok))
    assert r.status_code == 403 and r.json()["detail"] == hook_auth.WRITE_REFUSED, "a write is no read"
    assert not hook_auth.shot_proven(Headers(_shot(tok)), "POST")
    assert client.get("/api/corpora", headers=_shot("not-a-token")).json() == REFUSED
    now[0] += hook_auth.SHOT_TTL_S + 1
    assert client.get("/api/corpora", headers=_shot(tok)).json() == REFUSED, "expired"
    other = hook_auth.mint_shot()
    assert hook_auth._sha(tok) not in hook_auth._shots, "an expired token goes"
    hook_auth.drop_shot(other)
    assert client.get("/api/corpora", headers=_shot(other)).json() == REFUSED, "dropped when its shot ended"
    assert hook_auth.SHOT_TTL_S >= dev.SHOT_TIMEOUT_S, "it outlives the run it is for"


@pytest.mark.real_read_guard
def test_the_shot_route_gives_a_token_only_to_the_token_s_holder(client, plugin_headers):
    """POST /api/ui/shot is a token route (hook_auth.CLI_PATHS): a dev ticket's runner proves the stack's or the box's
    token, and the answer proves this server back. A page with the cookie, or anyone else, gets none."""
    from conftest import UI_COOKIE_VALUE, _record_paired

    assert client.post("/api/ui/shot").status_code == 401
    _record_paired(UI_COOKIE_VALUE)
    client.cookies.set(hook_auth.ui_cookie(), UI_COOKIE_VALUE)
    assert client.post("/api/ui/shot").status_code == 401, "the cookie alone gets no token"
    client.cookies.clear()
    r = client.post("/api/ui/shot", headers=plugin_headers())
    assert r.status_code == 200 and r.json()["expires_s"] == hook_auth.SHOT_TTL_S
    assert client.get("/api/ws/mini/canvas", headers=_shot(r.json()["token"])).status_code == 200


async def test_the_screenshot_script_gets_the_shot_token_in_its_environment_never_its_command_line(monkeypatch, tmp_path):
    seen = {}

    class Proc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def spawn(*cmd, **kw):
        seen["cmd"], seen["env"] = cmd, kw["env"]
        return Proc()

    monkeypatch.setattr(dev.headless, "launch", lambda kind: "")
    monkeypatch.setattr(dev.headless, "missing", lambda kind: "")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setenv(dev.SHOT_TOKEN_ENV, "a-token-the-server-inherited")
    assert await dev.run_shot("http://127.0.0.1:8300/", tmp_path / "a.png", read_token="t0k") == 0
    assert seen["env"][dev.SHOT_TOKEN_ENV] == "t0k" and not any("t0k" in str(a) for a in seen["cmd"])
    assert await dev.run_shot("http://127.0.0.1:8300/", tmp_path / "a.png") == 0
    assert dev.SHOT_TOKEN_ENV not in seen["env"], "no token unless the shot has one"


def _opener(c: TestClient, base: str, seen: list):
    """A stand-in for config.LOOPBACK.open that sends each request to the TestClient `c`, as a server at `base`: the
    whole URL, since the request's proof holds its port."""

    class Answer(io.BytesIO):
        status = 200

        def __init__(self, body: bytes, headers) -> None:
            super().__init__(body)
            self.headers = headers

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen(req, timeout=None):
        assert req.full_url.startswith(base), req.full_url
        r = c.request(req.get_method(), req.full_url, content=req.data,
                      headers=dict(req.header_items()))
        seen.append((req.full_url, r.status_code))
        if r.status_code >= 400:
            raise urllib.error.HTTPError(req.full_url, r.status_code, "", {}, io.BytesIO(r.content))
        return Answer(r.content, r.headers)

    return urlopen


@pytest.mark.real_read_guard
def test_a_ticket_s_shot_gets_its_token_from_the_shot_server_s_own_route(client, plugin_headers, monkeypatch, tmp_path):
    """dev.shot_token proves the token in the stack's (or the box's) server.json at that server's POST /api/ui/shot,
    checks the answer's proof, and the token it gets reads there; a server without the route (an older tree), a home
    without a token or an answer that proves nothing back gives ''."""
    seen: list = []
    plugin_headers()  # this server's token, in the test's home
    monkeypatch.setattr(dev.config.LOOPBACK, "open", _opener(client, "http://127.0.0.1:8301", seen))
    tok = dev.shot_token("http://127.0.0.1:8301", hook_auth.home())
    assert tok and seen == [("http://127.0.0.1:8301/api/ui/shot", 200)]
    assert client.get("/api/corpora", headers=_shot(tok)).status_code == 200
    assert dev.shot_token("http://127.0.0.1:8301", tmp_path / "no-home") == ""
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "server.json").write_text(json.dumps({"token": "another-token"}))
    assert dev.shot_token("http://127.0.0.1:8301", tmp_path / "other") == "", "401 there"

    def no_route(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 404, "", {}, io.BytesIO(b'{"detail": "Not Found"}'))

    monkeypatch.setattr(dev.config.LOOPBACK, "open", no_route)
    assert dev.shot_token("http://127.0.0.1:8301", hook_auth.home()) == ""


async def test_a_ticket_s_shot_hands_the_server_s_token_to_its_run(monkeypatch, tmp_path):
    calls = []

    async def run_shot(url, out, selector=None, **kw):
        calls.append((url, kw))
        Path(out).write_bytes(b"png")
        return 0

    monkeypatch.setattr(dev, "run_shot", run_shot)
    monkeypatch.setattr(dev, "shot_token", lambda api, home: f"token-of-{api}" if api.endswith("8301") else "")
    monkeypatch.setattr(dev, "_update", lambda tid, **kw: None)
    monkeypatch.setattr(dev, "shots_dir", lambda tid: tmp_path / tid)

    class Log:
        def stage(self, *a):
            pass

        def shot(self, *a):
            pass

    t = {"id": "t1", "target": {"url": "/?ws=mini"}}
    assert await dev._take_shot(t, Log(), "before", "http://127.0.0.1:5301", api="http://127.0.0.1:8301",
                                home=tmp_path) == "before.png"
    assert calls[-1] == ("http://127.0.0.1:5301/?ws=mini", {"own_origin": False, "read_token": "token-of-http://127.0.0.1:8301"})
    assert await dev._take_shot(t, Log(), "after", "http://127.0.0.1:5301", api="http://127.0.0.1:9", home=tmp_path)
    assert calls[-1][1]["read_token"] is None, "a server with no token for it: shot without one"


# ---- what a read was let through by, asked again while its answer streams


@pytest.fixture()
def served(monkeypatch):
    """thimble's app on a free port in a thread (a real server, since an event stream never ends); its base URL.
    THIMBLE_PORT names the port, as the supervisor's does, so the cookie's name is that server's."""
    import socket  # noqa: PLC0415
    import threading  # noqa: PLC0415
    import time  # noqa: PLC0415

    import uvicorn  # noqa: PLC0415

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setenv("THIMBLE_PORT", str(port))
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    server = uvicorn.Server(uvicorn.Config(main.create_app(), host="127.0.0.1", port=port, log_level="warning",
                                           lifespan="off"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    end = time.monotonic() + 15
    while not server.started and time.monotonic() < end:
        time.sleep(0.05)
    assert server.started
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(10)


@pytest.mark.real_read_guard
def test_an_event_stream_a_browser_opened_ends_once_that_browser_is_signed_out(served, workspaces_tmp, monkeypatch):
    """A workspace's event stream, opened with a browser's cookie, stops at the first event after that browser is signed
    out (a sign-in notice's "Sign it out") or every browser is (`thimble unpair`), as INSTALL.md tells the analyst to do
    for a sign-in that was not theirs: the event never reaches the stream, which ends, and the cookie reads nothing
    more. Before that, events arrive as they are written."""
    import threading  # noqa: PLC0415
    import time  # noqa: PLC0415

    import httpx  # noqa: PLC0415
    from conftest import UI_COOKIE_VALUE, _record_paired  # noqa: PLC0415

    from app import agents, investigation  # noqa: PLC0415

    monkeypatch.setattr(investigation, "EVENTS_POLL_S", 0.2)  # how often the stream tails the file for new events
    agents.ensure_main("mini")
    log = investigation.inv_dir("mini", investigation.MAIN) / "events.jsonl"
    seq = [100]

    def write(text: str) -> None:  # an event another process wrote, as the stream's tail finds one
        seq[0] += 1
        with log.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"seq": seq[0], "type": "probe", "text": text}) + "\n")

    def until(ok, s: float = 10.0) -> bool:
        end = time.monotonic() + s
        while not ok() and time.monotonic() < end:
            time.sleep(0.05)
        return ok()

    other = "a-second-browser-s-cookie-value-for-the-test"
    for cookie, revoke in ((UI_COOKIE_VALUE, lambda: hook_auth.sign_out(hook_auth._sha(UI_COOKIE_VALUE)[:12])),
                           (other, hook_auth.unpair)):
        _record_paired(cookie)
        jar = {hook_auth.ui_cookie(): cookie}
        got: list[str] = []
        ended = threading.Event()

        def read() -> None:
            with httpx.Client(cookies=jar, timeout=30) as c, c.stream("GET", f"{served}/api/ws/mini/events") as r:
                got.append(str(r.status_code))
                for line in r.iter_lines():
                    got.append(line)
            ended.set()

        threading.Thread(target=read, daemon=True).start()
        assert until(lambda: any("live" in x for x in got)), got
        assert got[0] == "200"
        write(f"before {cookie}")
        assert until(lambda: any(f"before {cookie}" in x for x in got)), "an event reaches the open stream"
        revoke()
        write(f"after {cookie}")
        assert ended.wait(10), "the stream ended"
        assert not any(f"after {cookie}" in x for x in got), "the event written after the sign-out never arrived"
        assert httpx.get(f"{served}/api/ws/mini/canvas", cookies=jar).status_code == 401
