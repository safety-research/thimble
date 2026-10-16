"""Reads of the local API need a credential (app/hook_auth.py LocalReadGuard), as writes do: the signed-in browser's
cookie or the token's proof, which the CLI sends with every request. A page screenshot's headless browser holds neither,
so it carries a shot token (hook_auth.mint_shot): random, good for reads alone for a short time, kept in memory as its
sha256, and handed to the screenshot script in its environment, never on its command line. A dev ticket's shot of
another server's page gets that server's token from its POST /api/ui/shot. The health check names no path or pid
without the proof, so the CLI tells another install's server by the home it does not name."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from starlette.datastructures import Headers

from app import dev, hook_auth, main

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
    from conftest import UI_COOKIE_VALUE, UI_KEY_VALUE, _record_paired  # noqa: PLC0415

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
        page = f"{served}/b/{UI_KEY_VALUE}"  # where the browser's page asks (hook_auth.browser_path)
        got: list[str] = []
        ended = threading.Event()

        def read() -> None:
            with httpx.Client(cookies=jar, timeout=30) as c, c.stream("GET", f"{page}/api/ws/mini/events") as r:
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
        assert httpx.get(f"{page}/api/ws/mini/canvas", cookies=jar).status_code == 401
