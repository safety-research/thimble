"""module_bridge.py: the server's side of thimble's hooks module (plugin/hooks/thimble.ts). The module says hello only
from main's fenced session as launch.json names it, or as `--rekey` moved it after /clear, in either order; it takes the
requests made for its session alone from a long poll; a request it does not answer in time expires, and an agent its
late spawn started is stopped; every route takes the hooks' proof both ways. The module's own side is
plugin/hooks/thimble.test.ts."""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import types
from dataclasses import dataclass

import httpx
import pytest

import app
from app import cc_plugin, config, hook_auth, module_bridge, session, tools

CORPUS = "mini"
MAIN = "11111111-1111-4111-8111-111111111111"
NEW = "22222222-2222-4222-8222-222222222222"
CHILD = "33333333-3333-4333-8333-333333333333"
NOTE = "The analyst started {role} {agent} ({what}) in thimble; its report goes to them there."


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, workspaces_tmp):
    for table in (module_bridge._bridges, module_bridge._waiters):
        table.clear()
    module_bridge._ended.clear()
    monkeypatch.setattr(module_bridge, "_loop", None)
    monkeypatch.setattr(session, "_live", {})  # no main another test left behind
    monkeypatch.setattr(cc_plugin, "main_fenced", lambda c: True, raising=False)
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
    (config.workspace_dir(CORPUS) / module_bridge.LAUNCH).write_text(json.dumps({"session": session, "fenced": True,
                                                                                  **more}))


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
    wrong = hook_auth.headers("another-token", "n0nce")
    for method, path, kw in calls:
        assert (await client.request(method, path, **kw)).status_code == 401, path
        assert (await client.request(method, path, headers=wrong, **kw)).status_code == 401, path
        r = await client.request(method, path, headers=(h := plugin_headers()), **kw)
        assert r.status_code != 401, path
        assert r.headers[hook_auth.PROOF_HEADER] == hook_auth.sign(hook_auth.token(), "server", h[hook_auth.NONCE_HEADER])
    assert hook_auth.guarded("GET", "/api/module/anything") and hook_auth.guarded("POST", "/api/module/hello")


# ----------------------------------------------------------------------------------------------- the hello


async def test_a_hello_is_accepted_from_main_s_fenced_session_and_recorded_for_doctor(client, plugin_headers):
    _launch()
    reg = config.workspace_dir(CORPUS) / module_bridge.REGISTRY
    reg.write_text(json.dumps({"agents": {"a1": {"type": "thimble:writer"}}}))
    assert not module_bridge.live(CORPUS)
    assert module_bridge.why_not(CORPUS) == module_bridge.NOT_LOADED
    assert (await Module(client, plugin_headers).hello()).json() == {"ok": True}
    data = _registry()
    assert data["agents"] == {"a1": {"type": "thimble:writer"}}, "lane B's keys are kept"
    assert data["module"] == {**data["module"], "session": MAIN, "version": "0.6.0"} and "idle" not in data["module"]
    assert (await Module(client, plugin_headers).hello(problem="writer: refused")).status_code == 200
    assert _registry()["module"]["problem"] == "writer: refused"


async def test_a_hello_from_a_session_that_is_not_the_workspace_s_fenced_main_is_refused(client, plugin_headers,
                                                                                         monkeypatch):
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
    # main itself, unfenced
    monkeypatch.setattr(cc_plugin, "main_fenced", lambda c: False, raising=False)
    r = await Module(client, plugin_headers).hello()
    assert r.status_code == 403 and r.json()["detail"] == module_bridge.NOT_FENCED
    assert module_bridge.why_not(CORPUS) == module_bridge.NOT_FENCED
    # a folder that is no workspace: 404, and the module asks again later
    r = await client.post("/api/module/hello", json={"cwd": "/nowhere", "session": MAIN}, headers=plugin_headers())
    assert r.status_code == 404


async def test_without_a_session_in_launch_json_main_is_the_session_thimble_made_main(client, plugin_headers,
                                                                                     monkeypatch):
    _launch(session="")
    monkeypatch.setattr(session, "current", lambda c: types.SimpleNamespace(sid=MAIN) if c == CORPUS else None)
    assert (await Module(client, plugin_headers).hello()).status_code == 200
    assert (await Module(client, plugin_headers, CHILD).hello()).status_code == 403


async def test_a_stray_hello_never_unseats_main_s_module(client, plugin_headers):
    _launch()
    task = await _live(Module(client, plugin_headers))
    assert (await Module(client, plugin_headers, CHILD).hello()).status_code == 403
    assert module_bridge.live(CORPUS) and module_bridge.why_not(CORPUS) == ""
    task.cancel()


async def test_a_hello_after_clear_is_accepted_whether_rekey_names_the_new_id_before_or_after_it(client,
                                                                                               plugin_headers):
    _launch()
    old = Module(client, plugin_headers)
    assert (await old.hello()).status_code == 200
    new = Module(client, plugin_headers, NEW)
    # the hello first: held until --rekey names the new id
    hello = asyncio.create_task(new.hello())
    await asyncio.sleep(0.1)
    assert not hello.done()
    module_bridge.rekey(CORPUS, MAIN, NEW)
    r = await hello
    assert r.status_code == 200 and module_bridge.main_session(CORPUS) == NEW
    assert (await old.next(wait=0)).status_code == 409, "the old id's poll is told to say hello again"
    assert _registry()["module"]["rekeyed"] == {MAIN: NEW}
    # --rekey first (an in-session /resume back to the first session): the hello is accepted at once
    module_bridge.rekey(CORPUS, NEW, MAIN)
    t0 = time.monotonic()
    assert (await old.hello()).status_code == 200
    assert time.monotonic() - t0 < module_bridge.HELLO_HOLD_S / 2
    assert module_bridge.main_session(CORPUS) == MAIN


async def test_a_restarted_server_follows_the_moves_the_last_one_recorded(client, plugin_headers):
    _launch()
    module_bridge.rekey(CORPUS, MAIN, NEW)
    module_bridge._bridges.clear()  # what a restart forgets
    assert module_bridge.main_session(CORPUS) == NEW
    assert (await Module(client, plugin_headers, NEW).hello()).status_code == 200


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
    # a module that said hello but holds no poll is not live once LIVE_GAP_S has passed
    monkeypatch.setattr(module_bridge, "LIVE_GAP_S", 0.05)
    mod = Module(client, plugin_headers)
    await mod.hello()
    assert (await mod.next(wait=0)).status_code == 204
    assert module_bridge.live(CORPUS)
    await asyncio.sleep(0.1)
    assert not module_bridge.live(CORPUS) and "stopped polling" in module_bridge.why_not(CORPUS)


async def test_a_request_the_module_does_not_answer_in_time_expires_and_a_late_spawn_is_stopped(client, plugin_headers,
                                                                                               monkeypatch):
    monkeypatch.setattr(module_bridge, "REQUEST_TIMEOUT_S", 0.4)
    _launch()
    mod = Module(client, plugin_headers)
    poll = await _live(mod)
    ask = asyncio.create_task(module_bridge.request(CORPUS, "spawn", role="check", prompt="p", description="d",
                                                    values={}))
    req = (await poll).json()["request"]
    t0 = time.monotonic()
    assert await ask == {"no-module": module_bridge.NOT_ANSWERING, "expired": True}
    assert time.monotonic() - t0 < 1
    # the module's spawn went through anyway: its answer comes late, and the agent it started is stopped
    r = await mod.result(req["id"], {"agentId": "late1"})
    assert r.json() == {"ok": False, "expired": True}
    stop = (await mod.next()).json()["request"]
    assert (stop["op"], stop["args"], "expires_in" in stop) == ("stop", {"agent": "late1"}, False)
    # a request whose time ran out before the module polled is never handed to it
    ask = asyncio.create_task(module_bridge.request(CORPUS, "spawn", role="check", prompt="p", description="d",
                                                    values={}))
    assert (await ask)["expired"] is True
    assert (await mod.next(wait=0.2)).status_code == 204


async def test_requests_made_for_the_old_session_go_nowhere_once_main_moves(client, plugin_headers, monkeypatch):
    monkeypatch.setattr(module_bridge, "LIVE_GAP_S", 30)
    _launch()
    mod = Module(client, plugin_headers)
    await mod.hello()
    assert (await mod.next(wait=0)).status_code == 204
    ask = asyncio.create_task(module_bridge.request(CORPUS, "stop", agent="a1"))
    await asyncio.sleep(0.05)
    module_bridge.rekey(CORPUS, MAIN, NEW)
    assert (await Module(client, plugin_headers, NEW).hello()).status_code == 200
    assert await ask == {"no-module": module_bridge.NOT_ANSWERING}
    assert (await Module(client, plugin_headers, NEW).next(wait=0)).status_code == 204


async def test_push_roles_asks_a_live_module_to_register_again_once_from_any_thread(client, plugin_headers):
    _launch()
    module_bridge.push_roles(CORPUS)  # no module: nothing
    mod = Module(client, plugin_headers)
    poll = await _live(mod)
    module_bridge.push_roles(CORPUS)
    req = (await poll).json()["request"]
    assert (req["op"], req["args"]) == ("register", {})
    await mod.result(req["id"], {"ok": True})
    done = threading.Event()
    threading.Thread(target=lambda: (module_bridge.push_roles(CORPUS), module_bridge.push_roles(CORPUS),
                                     done.set())).start()
    for _ in range(100):
        if done.is_set():
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    assert [r.op for r in module_bridge._bridge(CORPUS).queue] == ["register"], "one, however often it is pushed"


async def test_request_blocking_asks_from_a_worker_thread_and_refuses_on_the_loop(client, plugin_headers):
    _launch()
    mod = Module(client, plugin_headers)
    poll = await _live(mod)
    with pytest.raises(RuntimeError):
        module_bridge.request_blocking(CORPUS, "note", text="x")
    answer = asyncio.create_task(asyncio.to_thread(module_bridge.request_blocking, CORPUS, "note", text="hello main"))
    req = (await poll).json()["request"]
    assert (req["op"], req["args"]) == ("note", {"text": "hello main"})
    await mod.result(req["id"], {"ok": True})
    assert await answer == {"ok": True}


# ----------------------------------------------------------------------------------------------- what the module fetches


@dataclass
class Role:
    prompt: str
    model: str
    effort: str
    description: str = "thimble's role"
    background: bool = True
    skills: tuple = ()
    route: str = "not a spec key"


async def test_the_roles_come_from_subagents_roles_as_agent_register_takes_them(client, plugin_headers, monkeypatch):
    fake = types.ModuleType("app.subagents")
    fake.roles = lambda c: {
        "orientation": {"name": "x", "prompt": "Orient.", "model": "claude-opus-5-5[1m]", "effort": "xhigh",
                        "description": "thimble's orientation of this corpus", "background": True,
                        "disallowedTools": ["mcp__plugin_thimble_thimble__start_orientation"], "extra": 1},
        "thimble:helper": Role("Help.", "claude-sonnet-5", "high", skills=["thimble:shared"])}
    monkeypatch.setitem(sys.modules, "app.subagents", fake)
    monkeypatch.setattr(app, "subagents", fake)  # `from . import subagents` reads the package's attribute first
    _launch()
    mod = Module(client, plugin_headers)
    assert (await mod.get("roles")).status_code == 409, "only after the hello"
    await mod.hello()
    roles = (await mod.get("roles")).json()["roles"]
    assert roles == {
        "orientation": {"name": "orientation", "prompt": "Orient.", "model": "claude-opus-5-5[1m]", "effort": "xhigh",
                        "description": "thimble's orientation of this corpus", "background": True,
                        "disallowedTools": ["mcp__plugin_thimble_thimble__start_orientation"]},
        "helper": {"name": "helper", "prompt": "Help.", "model": "claude-sonnet-5", "effort": "high",
                   "description": "thimble's role", "background": True, "skills": ["thimble:shared"]}}


async def test_the_state_holds_running_agents_their_efforts_the_typed_starts_and_a_note_for_each(client,
                                                                                               plugin_headers):
    _launch()
    (config.workspace_dir(CORPUS) / module_bridge.REGISTRY).write_text(json.dumps({
        "agents": {
            "aTyped": {"type": "thimble:orientation", "key": "orient", "values": {"model": "m", "effort": "max"}},
            "aGp": {"type": "general-purpose", "parent": "aTyped"},
            "aGp2": {"type": "Explore", "parent": "aGp"},
            "aCritic": {"type": "thimble:critic", "parent": "aTyped", "values": {"effort": "low"}},
            "aCriticKid": {"type": "general-purpose", "parent": "aCritic"},
            "aClick": {"type": "thimble:writer", "key": "writer:report", "plugin_started": True,
                       "values": {"effort": "high"}},
            "aDone": {"type": "thimble:check", "key": "check:c1:report", "status": "stopped"}},
        "efforts": {"aOwn": "medium"},
        "pending": {
            "orient": {"id": "req0001orient", "kind": "start", "route": "typed", "role": "orientation",
                       "values": {"model": "claude-opus-5-5[1m]", "effort": "max"}, "state": "pending"},
            "clickid1": {"kind": "start", "route": "click", "role": "writer", "values": {}},
            "writer:x": {"id": "req0002writer", "kind": "start", "route": "typed", "role": "thimble:writer",
                         "values": {}, "state": "expired"}},
    }))
    mod = Module(client, plugin_headers)
    await mod.hello()
    state = (await mod.get("state")).json()
    assert set(state["agents"]) == {"aTyped", "aGp", "aGp2", "aCritic", "aCriticKid", "aClick"}
    assert state["agents"]["aClick"] == {"type": "thimble:writer", "role": "writer", "plugin_started": True}
    assert state["efforts"] == {"aTyped": "max", "aGp": "max", "aGp2": "max", "aCritic": "low",
                                "aCriticKid": "low", "aOwn": "medium"}, \
        "a typed run's effort goes to its children of no thimble type; a click's run needs none"
    assert state["requests"] == {"req0001orient": {"role": "orientation", "key": "",
                                                   "values": {"model": "claude-opus-5-5[1m]", "effort": "max"}}}
    assert sorted(state["notes"]) == sorted([
        "The analyst started orientation aTyped (this corpus) in thimble; its report goes to them there.",
        "The analyst started writer aClick (report) in thimble; its report goes to them there."])


async def test_the_module_s_ended_post_reaches_every_observer(client, plugin_headers):
    _launch()
    seen: list[tuple] = []
    module_bridge.on_ended(lambda *a: seen.append(a))
    module_bridge.on_ended(lambda *a: 1 / 0)  # one that fails does not stop the others
    r = await client.post("/api/module/ended", headers=plugin_headers(),
                          json={"cwd": _cwd(), "session": MAIN, "agentId": "a9", "answer": "Done.", "reason": "answer"})
    assert r.json() == {"ok": True}
    assert seen == [(CORPUS, "a9", "Done.", "answer")]
