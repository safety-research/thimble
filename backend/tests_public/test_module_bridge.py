"""module_bridge.py: the server's side of thimble's hooks module (plugin/hooks/thimble.ts). The module says hello only
from main's session as launch.json names it (the launcher's, or /thimble's), or as `--rekey` moved it after /clear, in
either order; it takes the requests made for its session alone from a long poll; a request it does not answer in time
expires, and an agent its late spawn started is stopped; the roles it fetches carry the rules it enforces on file tools;
every route takes the hooks' proof both ways. The module's own side is plugin/hooks/thimble.test.ts."""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass

import httpx
import pytest

from app import cc_plugin, config, hook_auth, module_bridge, session, tools


CORPUS = "mini"
REAL_OPENED = module_bridge._opened  # _fresh stands in for it in every test; the H17 test takes the real one
MAIN = "11111111-1111-4111-8111-111111111111"
CHILD = "33333333-3333-4333-8333-333333333333"
NOTE = "The analyst started {role} {agent} ({what}) in thimble; its report goes to them there."


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, workspaces_tmp):
    for table in (module_bridge._bridges, module_bridge._waiters):
        table.clear()
    module_bridge._ended.clear()
    monkeypatch.setattr(module_bridge, "_loop", None)
    monkeypatch.setattr(session, "_live", {})  # no main another test left behind
    monkeypatch.setattr(module_bridge, "_opened", lambda c, sid: True)  # main's session attached (/thimble ran)
    monkeypatch.setattr(cc_plugin, "managed", lambda environ=None: None)
    monkeypatch.setattr(module_bridge, "HELLO_HOLD_S", 0.6)
    real = tools.hint
    monkeypatch.setattr(tools, "hint", lambda name, **v: NOTE.format(**v) if name == module_bridge.NOTE_HINT
                        else real(name, **v))
    yield
    module_bridge._ended.clear()


def _cwd() -> str:
    return str(config.corpus_dir(CORPUS))


def _launch(session: str = MAIN, **more) -> None:
    (config.workspace_dir(CORPUS) / module_bridge.LAUNCH).write_text(json.dumps({"session": session, **more}))


def _registry() -> dict:
    return json.loads((config.workspace_dir(CORPUS) / module_bridge.REGISTRY).read_text())


@pytest.fixture()
async def client(plugin_headers):
    from app.main import create_app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://127.0.0.1",
                                 timeout=30) as c:
        yield c


@dataclass
class Module:
    """The calls plugin/hooks/thimble.ts makes, each proving the token and checking the server's proof."""
    client: httpx.AsyncClient
    headers: object
    session: str = MAIN

    async def _go(self, method: str, path: str, **kw) -> httpx.Response:
        h = self.headers()
        r = await self.client.request(method, path, headers=h, **kw)
        assert r.headers[hook_auth.PROOF_HEADER] == hook_auth.sign(hook_auth.token(), "server", h[hook_auth.NONCE_HEADER])
        return r

    async def hello(self, **more) -> httpx.Response:
        return await self._go("POST", "/api/module/hello", json={"cwd": _cwd(), "session": self.session,
                                                                 "version": "0.6.0", **more})

    async def next(self, wait: float = 2.0) -> httpx.Response:
        return await self._go("GET", "/api/module/next", params={"cwd": _cwd(), "session": self.session, "wait": wait})

    async def result(self, rid: str, answer: dict) -> httpx.Response:
        return await self._go("POST", "/api/module/result", json={"cwd": _cwd(), "session": self.session, "id": rid,
                                                                  "answer": answer})

    async def get(self, what: str) -> httpx.Response:
        return await self._go("GET", f"/api/module/{what}", params={"cwd": _cwd(), "session": self.session})

    async def serve(self, answer) -> dict:
        """Take one request from the long poll and answer it with answer(request)."""
        r = await self.next()
        assert r.status_code == 200, r.text
        req = r.json()["request"]
        await self.result(req["id"], answer(req))
        return req


async def _live(mod: Module) -> asyncio.Task:
    """The module said hello and holds a long poll: a task that serves nothing until the test reads it."""
    assert (await mod.hello()).status_code == 200
    task = asyncio.create_task(mod.next())
    for _ in range(100):
        if module_bridge.live(CORPUS):
            return task
        await asyncio.sleep(0.01)
    raise AssertionError("the module never held its poll")


# ----------------------------------------------------------------------------------------------- the hooks' proof


async def test_every_module_route_answers_only_a_request_that_proves_the_token(client, plugin_headers):
    _launch()
    calls = [("POST", "/api/module/hello", {"json": {"cwd": _cwd(), "session": MAIN}}),
             ("GET", "/api/module/next", {"params": {"cwd": _cwd(), "session": MAIN, "wait": 0}}),
             ("POST", "/api/module/result", {"json": {"cwd": _cwd(), "id": "x", "answer": {}}}),
             ("POST", "/api/module/ended", {"json": {"cwd": _cwd(), "agentId": "a1"}}),
             ("GET", "/api/module/roles", {"params": {"cwd": _cwd(), "session": MAIN}}),
             ("GET", "/api/module/state", {"params": {"cwd": _cwd(), "session": MAIN}})]
    wrong = hook_auth.headers("another-token", 80)
    for method, path, kw in calls:
        assert (await client.request(method, path, **kw)).status_code == 401, path
        assert (await client.request(method, path, headers=wrong, **kw)).status_code == 401, path
        r = await client.request(method, path, headers=(h := plugin_headers()), **kw)
        assert r.status_code != 401, path
        assert r.headers[hook_auth.PROOF_HEADER] == hook_auth.sign(hook_auth.token(), "server", h[hook_auth.NONCE_HEADER])
    assert hook_auth.guarded("GET", "/api/module/anything") and hook_auth.guarded("POST", "/api/module/hello")
    assert hook_auth.guarded("GET", "/api/module/roles"), "the roles and the rules need the hooks' proof"


# ----------------------------------------------------------------------------------------------- the hello


async def test_a_hello_from_a_session_that_is_not_the_workspace_s_main_is_refused(client, plugin_headers):
    # no main known yet (no launch.json names a session, /thimble made none main): asked again later
    r = await Module(client, plugin_headers).hello()
    assert r.status_code == 409 and r.json()["detail"] == module_bridge.NO_MAIN
    assert module_bridge.why_not(CORPUS) == module_bridge.NO_MAIN
    _launch()
    # another session in the folder (a child `claude` that inherited THIMBLE_LAUNCHED): held, then refused
    t0 = time.monotonic()
    r = await Module(client, plugin_headers, CHILD).hello()
    assert r.status_code == 403 and r.json()["detail"] == module_bridge.NOT_MAIN
    assert time.monotonic() - t0 >= module_bridge.HELLO_HOLD_S * 0.9
    assert _registry()["module"]["idle"] == module_bridge.NOT_MAIN
    # a folder that is no workspace: 404 (a module /thimble turned on stays idle then; a launched one asks again later)
    r = await client.post("/api/module/hello", json={"cwd": "/nowhere", "session": MAIN}, headers=plugin_headers())
    assert r.status_code == 404


async def test_a_live_main_launch_json_names_is_followed_at_its_hello_and_one_on_local_transport_waits(
        client, plugin_headers, monkeypatch):
    """Bug hunt 7, H17 (and H13's loop): the server answered the hello of the main launch.json names with 409 every 2 s
    for as long as that session ran, since the server followed another session or none, so the browser never followed
    it and its agents could not start; and a watcher of a session that had just taken main was told it was gone. The
    live main launch.json names on the server's transport is followed at its hello, or its watcher's pull, and let in
    at once. Main continued after a quit on the local transport (activate.continue_main) waits (LOCAL_NOW, so its
    module goes on through the files) rather than being let in to a long poll no request reaches."""
    from app import activate

    monkeypatch.setattr(module_bridge, "_opened", REAL_OPENED)
    attached: list[tuple[str, int | None]] = []

    def attach(c, sid, cwd, transcript_path=None, pid=None, config_dir=None, **kw):
        attached.append((sid, pid))
        session._live[c] = session.Live(c, sid, cwd, None, pid)
        return session._live[c]

    monkeypatch.setattr(session, "attach", attach)
    monkeypatch.setattr(activate, "main_alive", lambda c, rec=None: str((rec or {}).get("session")) == MAIN)
    _launch(transport="server", pid=4242)
    r = await Module(client, plugin_headers).hello()
    assert r.status_code == 200, r.text
    assert attached == [(MAIN, 4242)] and session.current(CORPUS).sid == MAIN
    # the server follows another session, and main's watcher asks first: followed, not told it is gone
    session._live[CORPUS] = session.Live(CORPUS, CHILD, _cwd(), None, 5151)
    r = await client.get("/api/events/pull", params={"cwd": _cwd(), "session": MAIN, "wait": 0},
                         headers=plugin_headers())
    assert r.status_code == 204, r.text
    assert attached == [(MAIN, 4242)] * 2 and session.current(CORPUS).sid == MAIN
    # a session launch.json does not name is still refused, and nothing follows it
    r = await Module(client, plugin_headers, CHILD).hello()
    assert r.status_code == 403 and attached == [(MAIN, 4242)] * 2
    # main continued after a quit, on the local transport: its hello waits
    session._live.clear()
    _launch(transport="local", pid=4242)
    r = await Module(client, plugin_headers).hello()
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == module_bridge.LOCAL_NOW and attached == [(MAIN, 4242)] * 2


# ----------------------------------------------------------------------------------------------- requests


async def test_the_long_poll_hands_requests_to_main_s_session_alone(client, plugin_headers):
    _launch()
    mod = Module(client, plugin_headers)
    child = Module(client, plugin_headers, CHILD)
    assert (await child.next(wait=0)).status_code == 409, "a session whose hello was not accepted gets nothing"
    assert (await mod.next(wait=0)).status_code == 409, "nor main before its hello"
    poll = await _live(mod)
    ask = asyncio.create_task(module_bridge.request(CORPUS, "spawn", role="writer", prompt="Write the report.",
                                                    description="writer: report", what="report\n<b>",
                                                    values={"model": "claude-opus-5-5[1m]", "effort": "xhigh"},
                                                    request="r-1"))
    r = await poll
    assert r.status_code == 200
    req = r.json()["request"]
    assert req["op"] == "spawn" and 0 < req["expires_in"] <= module_bridge.REQUEST_TIMEOUT_S * 1000
    assert req["args"] == {"role": "writer", "prompt": "Write the report.", "description": "writer: report",
                           "values": {"model": "claude-opus-5-5[1m]", "effort": "xhigh"}, "request": "r-1",
                           "note": "The analyst started writer {agent} (report b) in thimble; its report goes to "
                                   "them there."}
    assert (await child.next(wait=0)).status_code == 409
    await mod.result(req["id"], {"agentId": "a7", "model": "claude-opus-5-5[1m]", "junk": 1})
    assert await ask == {"agentId": "a7", "model": "claude-opus-5-5[1m]"}
    # the card check's agent (agent_call.py): its drop line, and no note in main; no fork flag reaches the module
    check = asyncio.create_task(module_bridge.request(CORPUS, "spawn", role="call", prompt="Check.", fork=True,
                                                      description="thimble card check: Q?", values={}, request="r-2",
                                                      drop='thimble checked the card "Q?"'))
    req = (await mod.next()).json()["request"]
    assert req["args"] == {"role": "call", "prompt": "Check.", "description": "thimble card check: Q?", "values": {},
                           "request": "r-2", "note": "", "drop": 'thimble checked the card "Q?"'}
    await mod.result(req["id"], {"agentId": "a8", "model": "claude-opus-5-5"})
    assert (await check)["agentId"] == "a8"


# ----------------------------------------------------------------------------------------------- model calls


ASK = {"model": "claude-opus-5-5", "effort": "low", "system": [{"text": "Judge it.", "cache": True}],
       "prompt": [{"text": "Post 3 by marble-heron."}], "maxTokens": 16000, "timeoutMs": 30000}


async def test_model_calls_run_together_and_answer_their_own_callers_and_a_cancel_reaches_the_module(
        client, plugin_headers):
    """The long poll hands model calls out as they come, each answered on its own, many at once; a spawn waits for none
    of them; a caller cancelled sends the module `cancel` for its request, and its late answer goes nowhere."""
    _launch()
    mod = Module(client, plugin_headers)
    poll = await _live(mod)
    first = asyncio.create_task(module_bridge.model(CORPUS, "complete", ASK, timeout_s=30))
    second = asyncio.create_task(module_bridge.model(CORPUS, "fork", {"prompt": "Propose?"}, timeout_s=30))
    a = (await poll).json()["request"]
    b = (await mod.next()).json()["request"]
    assert (a["op"], a["args"]) == ("complete", ASK) and (b["op"], b["args"]) == ("fork", {"prompt": "Propose?"})
    spawn = asyncio.create_task(module_bridge.request(CORPUS, "stop", agent="a5"))
    s = (await mod.next()).json()["request"]
    await mod.result(s["id"], {"agentId": "a5"})
    assert (await spawn)["agentId"] == "a5", "a request answers while two model calls run"
    await mod.result(b["id"], {"text": '{"show": false}', "usage": {"cache_read_input_tokens": 9}, "junk": 1})
    assert await second == {"text": '{"show": false}', "usage": {"cache_read_input_tokens": 9}}
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    cancel = (await mod.next()).json()["request"]
    assert cancel["op"] == "cancel" and cancel["args"] == {"request": a["id"]}
    late = await mod.result(a["id"], {"text": "too late"})
    assert late.json()["ok"] is False
    assert module_bridge._answer("complete", {"failed": "api-error", "status": 529, "kind": "overloaded",
                                              "usage": {}}) == {"failed": "api-error", "status": 529,
                                                                "kind": "overloaded", "usage": {}}
    assert module_bridge._answer("fork", {"agentId": "x"}) == {"error": "the module gave no answer to a model call"}
    with pytest.raises(ValueError):
        await module_bridge.model(CORPUS, "spawn", {}, timeout_s=1)


async def test_a_model_call_no_module_takes_expires_and_one_whose_module_stops_ends(client, plugin_headers,
                                                                                     monkeypatch):
    _launch()
    monkeypatch.setattr(module_bridge, "REQUEST_TIMEOUT_S", 0.3)
    monkeypatch.setattr(module_bridge, "MODEL_LIVE_S", 0.05)
    mod = Module(client, plugin_headers)
    assert (await mod.hello()).status_code == 200
    assert (await mod.next(wait=0)).status_code == 204  # live for LIVE_GAP_S, and polls no more
    got = await module_bridge.model(CORPUS, "complete", ASK, timeout_s=30)
    assert got == {"no-module": module_bridge.NOT_ANSWERING, "expired": True}
    poll = asyncio.create_task(mod.next())
    call = asyncio.create_task(module_bridge.model(CORPUS, "complete", ASK, timeout_s=30))
    assert (await poll).json()["request"]["op"] == "complete"
    monkeypatch.setattr(module_bridge, "LIVE_GAP_S", 0.05)  # the module took it, then stopped polling
    assert await asyncio.wait_for(call, 5) == {"error": module_bridge.NOT_LIVE}
    assert await module_bridge.model(CORPUS, "complete", ASK, timeout_s=30) == {"no-module": module_bridge.why_not(CORPUS)}


async def test_answers_reach_their_own_callers_in_any_order_and_take_one_shape(client, plugin_headers):
    _launch()
    mod = Module(client, plugin_headers)
    poll = await _live(mod)
    asks = [asyncio.create_task(module_bridge.request(CORPUS, "stop", agent=f"a{i}")) for i in range(3)]
    taken = [(await poll).json()["request"]]
    taken += [(await mod.next()).json()["request"] for _ in range(2)]
    assert [t["args"]["agent"] for t in taken] == ["a0", "a1", "a2"], "in the order they were made"
    answers = [{"error": "Task a2 is not running", "gone": True, "text": "x"},
               {"limit": "Concurrent subagent limit reached. You can run 20 subagents at once."},
               {"deny": "PreToolUse:Agent hook error: An orientation is already running."}]
    for t, a in zip(reversed(taken), answers):
        await mod.result(t["id"], a)
    assert [await a for a in asks] == list(reversed(answers))
    assert module_bridge._answer("note", {"ok": 1}) == {"ok": True}
    assert "error" in module_bridge._answer("send", {"nothing": 1})
    with pytest.raises(ValueError):
        await module_bridge.request(CORPUS, "rm -rf")


async def test_without_a_live_module_a_request_answers_no_module_with_the_reason(client, plugin_headers, monkeypatch):
    assert await module_bridge.request(CORPUS, "spawn", role="writer") == {
        "no-module": module_bridge.NOT_LOADED}
    _launch(switches={"THIMBLE_NO_MODULE": "1"})
    assert (await module_bridge.request(CORPUS, "stop", agent="a1"))["no-module"] == "THIMBLE_NO_MODULE is set"
    _launch()
    monkeypatch.setattr(cc_plugin, "managed", lambda environ=None: {"disableAllHooks": True})
    assert "disableAllHooks" in module_bridge.why_not(CORPUS)
    monkeypatch.setattr(cc_plugin, "managed", lambda environ=None: None)
    # live check L29: what the launcher found, such as its own --settings, is the reason the browser gives
    _launch(modules_off="your --settings set disableAllHooks")
    assert module_bridge.why_not(CORPUS) == "your --settings set disableAllHooks"
    _launch()
    # a module that said hello but holds no poll is not live once LIVE_GAP_S has passed
    monkeypatch.setattr(module_bridge, "LIVE_GAP_S", 0.05)
    mod = Module(client, plugin_headers)
    await mod.hello()
    assert (await mod.next(wait=0)).status_code == 204
    assert module_bridge.live(CORPUS)
    await asyncio.sleep(0.1)
    assert not module_bridge.live(CORPUS) and "stopped polling" in module_bridge.why_not(CORPUS)
