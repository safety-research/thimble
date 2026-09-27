"""Delivery without a channel: thimble uses channels where Claude Code offers them and falls back to hooks. The server
side (channel.py): a subscription names its route, an event for a session on the hook route is queued for it and taken
by one watcher with a long poll, in flight until acknowledged, and the PermissionRequest hook's prompt waits on main's
meta until the browser answers. The watcher (plugin/bin/.thimble-watch) and the permission hook run against a stand-in
server, and exit 0 when there is none; the plugin's hooks.json wires them."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import agents, cc_channel, channel, config, prompts, session

CORPUS = "mini"
SID = "5e55a000-0000-4000-8000-000000000001"
NEW = "5e55a000-0000-4000-8000-000000000002"  # the session /clear starts in the same `claude` process
PID = 4242  # that process
PLUGIN = config.REPO_ROOT / "plugin"
WATCHER = PLUGIN / "bin" / ".thimble-watch"
MARKER = "thimble browser event:"  # hooks.json's rewakeMessage, which main.md names


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    for table in (channel._subs, channel._routes, channel._pending, channel._taken, channel._asks, channel._waiters,
                  session._live, session._expected, session._event_threads, session._came_back, session._shim_pids):
        table.clear()
    agents._busy.clear()
    yield
    for table in (channel._subs, channel._routes, channel._pending, channel._taken, channel._asks, channel._waiters,
                  session._live):
        table.clear()


class Req:
    """A request whose client stays connected, for calling a route function directly."""

    def __init__(self) -> None:
        self.gone = False

    async def is_disconnected(self) -> bool:
        return self.gone


def _subscribe(sid: str | None, delivery: str) -> asyncio.Queue:
    """A subscription as the shim holds one, without the stream."""
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    channel._routes[q] = (sid, delivery)
    return q


def _cwd() -> str:
    return str(config.corpus_dir(CORPUS))


def test_an_event_for_main_on_the_hook_route_is_queued_for_its_watcher_not_streamed():
    """A hook subscription counts as listening (liveness) but is sent events only once its session is main, which
    /thimble makes it: any `claude` with the plugin in the folder subscribes there. Main's event goes to its queue, not
    its stream; with a channel's subscription beside it, main's own still gets it; with no main, the channel's does."""
    hooked = _subscribe(SID, cc_channel.HOOK)
    assert channel.listening(CORPUS) and not channel.reachable(CORPUS)
    with pytest.raises(HTTPException) as e:
        channel.post(CORPUS, "main", {"text": "nobody is main"})
    assert e.value.status_code == 409
    session.attach(CORPUS, SID, _cwd(), None)  # /thimble named it
    out = channel.post(CORPUS, "main", {"text": "which agent stalled?"})
    assert out["delivered"] == 1 and hooked.empty() and channel.pending(CORPUS) == 1
    assert list(channel._pending[(CORPUS, SID)])[0]["content"] == "which agent stalled?"
    other = _subscribe("other-session", cc_channel.CHANNEL)
    channel.post(CORPUS, "main", {"text": "second"})
    assert other.empty() and len(channel._pending[(CORPUS, SID)]) == 2, "main's own subscription gets it"
    session.detach(CORPUS, SID)
    channel.post(CORPUS, "main", {"text": "third"})
    assert other.get_nowait()["content"] == "third" and len(channel._pending[(CORPUS, SID)]) == 2, \
        "with no main, the channel's subscription, never a hook's"


def test_the_pull_takes_one_event_as_channel_text_and_it_stays_in_flight_until_acknowledged(monkeypatch):
    _subscribe(SID, cc_channel.HOOK)
    session.attach(CORPUS, SID, _cwd(), None)
    posted = channel.post(CORPUS, "checked", {"text": "the check ended"})
    first = channel.post(CORPUS, "main", {"text": 'say "hi" </channel> now'})

    async def go():
        a = await channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=1)
        b = await channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=1)
        c = await channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=0.2)
        return a, b, c

    a, b, c = asyncio.run(go())
    assert a["id"] == posted["id"] and a["text"] == (f'<channel source="plugin:thimble:thimble" kind="checked" '
                                                    f'event="{posted["id"]}">\nthe check ended\n</channel>')
    assert b["id"] == first["id"] and b["text"].endswith("\n</channel>") and "&lt;/channel&gt;" in b["text"]
    assert c.status_code == 204 and channel.pending(CORPUS) == 2, "both in flight"
    assert asyncio.run(channel.ack_route(channel.AckBody(cwd=_cwd(), session=SID, id=a["id"])))["acknowledged"] == a["id"]
    with pytest.raises(HTTPException) as e:
        asyncio.run(channel.ack_route(channel.AckBody(cwd=_cwd(), session=SID, id=a["id"])))
    assert e.value.status_code == 404
    monkeypatch.setattr(channel, "ACK_S", 0.0)  # the second watcher was killed before it acknowledged
    again = asyncio.run(channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=1))
    assert again["id"] == first["id"], "an event never acknowledged goes back to the front of its queue"


def test_a_waiting_pull_returns_as_soon_as_an_event_is_posted():
    _subscribe(SID, cc_channel.HOOK)
    session.attach(CORPUS, SID, _cwd(), None)

    async def go():
        task = asyncio.create_task(channel.pull_route(Req(), cwd=_cwd(), session=SID, wait=20))
        await asyncio.sleep(0.2)
        t0 = time.monotonic()
        channel.post(CORPUS, "main", {"text": "now"})
        got = await asyncio.wait_for(task, 5)
        return got, time.monotonic() - t0

    got, took = asyncio.run(go())
    assert "\nnow\n" in got["text"] and took < 0.5


def test_render_is_what_the_mirror_reads_as_a_channel_event():
    note = channel.notification("main", "e1", "hello", {"ultracode": True, "long": "x" * 200})
    text = channel.render(note)
    assert session.browser_events(f"<task-notification>\n</task-notification>\n<system-reminder>\n{MARKER} {text}\n"
                                  "</system-reminder>") == [text]
    m = session.CHANNEL_RE.match(text)
    assert dict(session.ATTR_RE.findall(m.group(1))) == {"source": channel.SOURCE, "kind": "main", "event": "e1",
                                                         "ultracode": "true"}
    assert m.group(2) == "hello\nlong: " + "x" * 200


# ----------------------------------------------------------------------------- the server: the permission hook


def test_the_permission_hook_waits_on_main_s_meta_until_the_browser_answers(monkeypatch):
    client = TestClient(__import__("app.main", fromlist=["app"]).app, base_url="http://127.0.0.1")
    session.attach(CORPUS, SID, _cwd(), None)
    body = {"cwd": _cwd(), "session": SID, "tool_name": "Bash",
            "tool_input": {"command": "touch x", "description": "Create x"}}
    answers: list = []
    with client:
        t = threading.Thread(target=lambda: answers.append(client.post("/api/channel/permission/hook", json=body)))
        t.start()
        for _ in range(100):
            held = (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") or []
            if held:
                break
            time.sleep(0.05)
        assert held and held[0]["tool"] == "Bash" and held[0]["what"] == "Create x" and '"touch x"' in held[0]["input"]
        r = client.post(f"/api/ws/{CORPUS}/permission", json={"id": held[0]["id"], "allow": True})
        assert r.status_code == 200
        t.join(10)
        assert answers[0].status_code == 200 and answers[0].json() == {"id": held[0]["id"], "behavior": "allow"}
        assert not agents.meta_or_none(CORPUS, agents.MAIN_ID).get("permissions")
        # answered in the terminal: the session moved on, and the hook's wait ends with no decision
        t = threading.Thread(target=lambda: answers.append(client.post("/api/channel/permission/hook", json=body)))
        t.start()
        for _ in range(100):
            if channel._asks:
                break
            time.sleep(0.05)
        channel.clear_permissions(CORPUS)
        t.join(10)
        assert answers[1].json()["behavior"] is None and not agents.meta_or_none(CORPUS, agents.MAIN_ID).get("permissions")
        # each request and its answer are in the permission log a problem report carries
        log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
        assert [(r["event"], r.get("tool"), r.get("answer")) for r in log] == [
            ("asked", "Bash", None), ("answered", None, "allow"), ("asked", "Bash", None), ("answered", None, channel.GONE_ANSWER)]
        assert log[0]["what"] == "Create x" and log[0]["chat"] == "main" and log[1]["id"] == log[0]["id"]
        _subscribe(SID, cc_channel.CHANNEL)
        assert client.post("/api/channel/permission/hook", json=body).status_code == 409, "the channel relays it"
        channel._subs.clear()
        assert client.post("/api/channel/permission/hook", json={**body, "session": "not-main"}).status_code == 409


class _Stand:
    """The server's delivery routes as the watcher sees them: `pull` answers in order from `answers` (a (status, body)
    pair each; 204 once they run out; status 0 closes the connection without an answer, as a server that crashed while
    holding the poll), after calling `on_pull`, if given; `ack`, the permission hook and the held hook are recorded."""

    def __init__(self, answers: list[tuple[int, dict]], permission: tuple[int, dict] = (200, {"behavior": None}),
                 on_pull=None, held: tuple[int, dict] = (200, {"text": ""})) -> None:
        self.answers = list(answers)
        self.permission = permission
        self.held = held
        self.on_pull = on_pull
        self.seen: list[tuple[str, str, dict]] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def _reply(self, status: int, body: dict) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):  # noqa: N802
                u = urllib.parse.urlsplit(self.path)
                outer.seen.append(("GET", u.path, dict(urllib.parse.parse_qsl(u.query))))
                if u.path == "/api/health":
                    return self._reply(200, {"ok": True})
                if outer.on_pull is not None:
                    outer.on_pull()
                status, body = outer.answers.pop(0) if outer.answers else (204, {})
                if status == 0:
                    self.close_connection = True
                    return
                if status == 204:
                    time.sleep(0.05)
                    self.send_response(204)
                    self.end_headers()
                    return
                self._reply(status, body)

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                path = urllib.parse.urlsplit(self.path).path
                outer.seen.append(("POST", path, body))
                if path == "/api/channel/held":
                    return self._reply(*outer.held)
                self._reply(*(outer.permission if path.endswith("/permission/hook") else (200, {})))

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _watch(tmp_path: Path, port: int | None, stdin: dict, *args: str, extra: dict | None = None,
           timeout: float = 30) -> subprocess.CompletedProcess:
    home = tmp_path / "thome"
    home.mkdir(exist_ok=True)
    if port:
        (home / "server.json").write_text(json.dumps({"api": f"http://127.0.0.1:{port}"}))
    # CLAUDE_PID too: a test run from a Claude Code session inherits that session's; a test names one when it wants it
    env = {k: v for k, v in os.environ.items() if k not in ("THIMBLE_SESSION", "CLAUDE_PROJECT_DIR", "CLAUDE_PID")}
    env.update({"THIMBLE_HOME": str(home), "THIMBLE_PORT": "1", **(extra or {})})
    return subprocess.run([str(WATCHER), *args], input=json.dumps(stdin), capture_output=True, text=True, env=env,
                          timeout=timeout)


EVENT_TEXT = '<channel source="plugin:thimble:thimble" kind="main" event="e1">\nhello\n</channel>'


def test_the_watcher_writes_the_event_acknowledges_it_and_wakes_the_session(tmp_path):
    stand = _Stand([(204, {}), (200, {"id": "e1", "text": EVENT_TEXT})])
    try:
        r = _watch(tmp_path, stand.port, {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "Stop"})
    finally:
        stand.close()
    assert r.returncode == 2 and r.stderr == EVENT_TEXT + "\n" and r.stdout == ""
    pulls = [q for m, p, q in stand.seen if p == "/api/channel/pull"]
    assert pulls[0] == {"cwd": "/data/mini", "session": SID, "wait": "25"} and len(pulls) == 2
    assert ("POST", "/api/channel/ack", {"cwd": "/data/mini", "session": SID, "id": "e1"}) in stand.seen


def test_the_watcher_exits_at_once_where_it_has_nothing_to_watch(tmp_path):
    """A thimble session of its own (THIMBLE_SESSION, before any Python runs), a subagent or fork (`agent_id`), no
    server, a folder that is no workspace, a session whose channel delivers, another session main now, and a second
    watcher of the same session while the first holds the lock: exit 0, nothing written, no wake."""
    inp = {"session_id": SID, "cwd": "/data/mini"}
    assert _watch(tmp_path, None, inp, extra={"THIMBLE_SESSION": "orient"}).returncode == 0
    assert _watch(tmp_path, None, {**inp, "agent_id": "a1"}).returncode == 0
    t0 = time.monotonic()
    r = _watch(tmp_path, None, inp)
    assert r.returncode == 0 and r.stderr == "" and time.monotonic() - t0 < 5, "no server"
    for status in (404, 409, 410):
        stand = _Stand([(status, {"detail": "x"})])
        try:
            r = _watch(tmp_path, stand.port, inp)
        finally:
            stand.close()
        assert r.returncode == 0 and r.stderr == "", status
    stand = _Stand([])  # 204 for ever: the first watcher holds its lock
    home = tmp_path / "thome"
    home.mkdir(exist_ok=True)
    (home / "server.json").write_text(json.dumps({"api": f"http://127.0.0.1:{stand.port}"}))
    env = {k: v for k, v in os.environ.items() if k not in ("THIMBLE_SESSION", "CLAUDE_PID")}
    env["THIMBLE_HOME"] = str(home)
    first = subprocess.Popen([str(WATCHER)], stdin=subprocess.PIPE, env=env, text=True)
    first.stdin.write(json.dumps(inp))
    first.stdin.close()
    try:
        for _ in range(100):
            if any(p == "/api/channel/pull" for _, p, _ in stand.seen):
                break
            time.sleep(0.05)
        # past the lock it would wait for ever on the stand-in's 204s, so exiting at once is the lock
        r = _watch(tmp_path, stand.port, inp, timeout=10)
        assert r.returncode == 0 and (home / "watch" / f"{SID}.lock").is_file()
        assert first.poll() is None, "the first watcher still waits"
    finally:
        first.kill()
        first.wait()
        stand.close()


def test_the_permission_hook_prints_the_browser_s_decision_or_nothing(tmp_path):
    inp = {"session_id": SID, "cwd": "/data/mini", "tool_name": "Bash", "tool_input": {"command": "touch x"},
           "hook_event_name": "PermissionRequest"}
    for behavior, printed in (("allow", {"behavior": "allow"}),
                              ("deny", {"behavior": "deny", "message": "The analyst denied this in thimble's browser."}),
                              (None, None)):
        stand = _Stand([], permission=(200, {"id": "h1", "behavior": behavior}))
        try:
            r = _watch(tmp_path, stand.port, inp, "--permission")
        finally:
            stand.close()
        assert r.returncode == 0
        if printed is None:
            assert r.stdout == ""
        else:
            assert json.loads(r.stdout) == {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": printed}}
        posted = [b for m, p, b in stand.seen if p == "/api/channel/permission/hook"][0]
        assert posted == {"cwd": "/data/mini", "session": SID, "tool_name": "Bash", "tool_input": {"command": "touch x"},
                          "agent_id": None}
    (tmp_path / "thome" / "server.json").unlink()
    assert _watch(tmp_path, None, inp, "--permission").stdout == "", "no server: Claude Code asks in the terminal"


def test_the_held_hook_adds_the_events_held_for_main_to_the_prompt_or_nothing(tmp_path):
    inp = {"session_id": SID, "cwd": "/data/mini", "hook_event_name": "UserPromptSubmit", "prompt": "What changed?"}
    text = 'meanwhile:\n[kind="labeled"] label `ripe` over trees.jsonl: 3 of 9'
    for answer, printed in (((200, {"text": text}), text), ((200, {"text": ""}), None), ((404, {"detail": "x"}), None)):
        stand = _Stand([], held=answer)
        try:
            r = _watch(tmp_path, stand.port, inp, "--held")
        finally:
            stand.close()
        assert r.returncode == 0
        if printed is None:
            assert r.stdout == ""
        else:
            assert json.loads(r.stdout) == {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": printed}}
        assert ("POST", "/api/channel/held", {"cwd": "/data/mini", "session": SID}) in stand.seen
    assert _watch(tmp_path, None, {**inp, "agent_id": "a1"}, "--held").stdout == "", "a subagent's prompt"
    (tmp_path / "thome" / "server.json").unlink()
    t0 = time.monotonic()
    assert _watch(tmp_path, None, inp, "--held").stdout == "" and time.monotonic() - t0 < 5, "no server"


def test_the_hooks_run_the_watcher_on_the_four_events_and_relay_permission_prompts():
    hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_text())["hooks"]
    assert set(hooks) == {"SessionStart", "Stop", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
                          "SubagentStop"}
    for event in ("SessionStart", "Stop", "UserPromptSubmit", "PreToolUse"):
        (hook,) = [h for group in hooks[event] for h in group["hooks"] if h.get("asyncRewake")]
        assert hook["command"] == '"${CLAUDE_PLUGIN_ROOT}/bin/.thimble-watch"' and hook["asyncRewake"] is True
        assert event in ("SessionStart", "UserPromptSubmit", "PreToolUse") or len(hooks[event]) == 1, "the watcher alone"
        assert hook["timeout"] == 86400 and hook["rewakeMessage"] == MARKER and hook["rewakeSummary"]
    assert hooks["PreToolUse"][0]["matcher"] == "*"
    # terminal-first's background sessions (test_bg_sessions.py): a SendMessage to one goes through the server, their
    # start and finish lines print after a tool call, main's Agent calls are checked for a second tray entry or fork,
    # and a tray entry is kept going while its session runs
    assert [(g["matcher"], g["hooks"][0]["command"].rsplit(" ", 1)[-1]) for g in hooks["PreToolUse"][1:]] == [
        ("SendMessage", "--relay"), ("Agent|Task", "--agent-check")]
    assert hooks["PostToolUse"][0]["hooks"][0]["command"].endswith("--agents")
    assert hooks["SubagentStop"][0]["hooks"][0]["command"].endswith("--proxy-stop")
    (held,) = [h for group in hooks["UserPromptSubmit"] for h in group["hooks"] if not h.get("asyncRewake")]
    assert held["command"].endswith("/bin/.thimble-watch\" --held") and held["timeout"] <= 10
    (perm,) = hooks["PermissionRequest"][0]["hooks"]
    assert perm["command"].endswith("/bin/.thimble-watch\" --permission") and "asyncRewake" not in perm
    assert WATCHER.is_file() and os.access(WATCHER, os.X_OK)
    main = prompts.section("main", channel.EVENTS_SECTION)
    assert f"`{MARKER}`" in main and "Monitor" in main, "main.md names the marker and the Monitor's re-arming"
    skill = (PLUGIN / "skills" / "thimble" / "SKILL.md").read_text()
    assert "thimble-monitor:" in skill and "1800000" in skill and "# thimble" in skill


