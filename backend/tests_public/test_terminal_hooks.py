"""thimble's hooks on local transport (plugin/bin/.thimble-watch in a session whose workspace's launch.json names a local
transport, before a press of the browser workbench): no hook makes an HTTP request; the waker takes the session's events
from the workspace's queue and wakes main with exit 2; the held hook prints what waited; the mode hook records main's
permission mode and starts the backend's call on main's Stop; the file-first hooks start the backend's call
(app/local_hooks.py) in place of a post; the statusline reads the files. A process that lost its environment finds no
workspace and makes nothing. Every hook exits in its shell line unless thimble is on in the session (its marker)."""
from __future__ import annotations

import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
from importlib.machinery import SourceFileLoader
from pathlib import Path

import pytest
from terminal_fakes import CORPUS, MAIN, write_launch
from test_delivery import EVENT_TEXT, TOKEN, _Stand

from app import config, event_files, events
from app import subagent_files as sf

BIN = Path(__file__).resolve().parents[2] / "plugin" / "bin"
WATCHER = BIN / ".thimble-watch"
AGENTS = BIN / "thimble-agents"
AGENT = "abd7be4046c88858c"


@pytest.fixture(scope="module")
def claude():
    """A process standing in for main's `claude` (its command line has no -p, so the waker runs: the test runner's has
    `-p no:cacheprovider`)."""
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    yield proc
    proc.kill()
    proc.wait()


@pytest.fixture()
def ws(workspaces_tmp) -> Path:
    path = config.workspace_dir(CORPUS)
    write_launch(path, session=MAIN)
    return path


_CLAUDE: list[int] = []


@pytest.fixture(autouse=True)
def _claude_pid(claude):
    _CLAUDE[:] = [claude.pid]


def env_for(tmp_path: Path, ws: Path, **more: str) -> dict:
    """The hooks' environment in a session thimble is on in, on local transport: THIMBLE_HOME with the session's marker
    (up/<session>.active, which activation writes and the watcher's shell line gates on, CLAUDE_CODE_SESSION_ID), the
    data and workspaces folders, and a server.json naming a server, which no hook on local transport may ask."""
    home = tmp_path / "hook-home"
    (home / "up").mkdir(parents=True, exist_ok=True)
    (home / "server.json").write_text(json.dumps({"port": 9, "token": "t0ken"}))
    session = more.get("CLAUDE_CODE_SESSION_ID", MAIN)
    (home / "up" / f"{session}.active").write_text(json.dumps({"cwd": str(config.corpus_dir(CORPUS)), "ws": CORPUS}))
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_"))}
    env.update(THIMBLE_HOME=str(home), THIMBLE_WORKSPACES_DIR=str(config.WORKSPACES_DIR),
               THIMBLE_DATA_DIR=str(config.DATA_DIR), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)),
               CLAUDE_CONFIG_DIR=str(tmp_path / "claude-config"), CLAUDE_PID=str(_CLAUDE[0]),
               CLAUDE_CODE_SESSION_ID=MAIN)
    env.update(more)
    return env


def run_hook(env: dict, flag: str | None, stdin: dict, timeout: float = 30) -> subprocess.CompletedProcess:
    return subprocess.run([str(WATCHER), *([flag] if flag else [])], input=json.dumps(stdin), capture_output=True,
                          text=True, env=env, timeout=timeout, cwd=str(config.corpus_dir(CORPUS)))


def loaded(monkeypatch, tmp_path: Path, ws: Path):
    """The watcher as a module, in a session on local transport, with spawn_local recording its calls and every socket
    refused."""
    for k, v in env_for(tmp_path, ws).items():
        monkeypatch.setenv(k, v)
    loader = SourceFileLoader(f"thimble_watch_{time.monotonic_ns()}", str(WATCHER))
    watcher = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(watcher)
    spawned: list[tuple[str, dict]] = []
    monkeypatch.setattr(watcher, "spawn_local", lambda kind, inp: spawned.append((kind, inp)))

    def no_socket(*a, **k):
        raise AssertionError("a hook of terminal mode opened a socket")

    monkeypatch.setattr(socket, "socket", no_socket)
    monkeypatch.setattr(socket, "create_connection", no_socket)
    return watcher, spawned


def test_the_waker_takes_a_queued_event_wakes_main_with_its_text_and_exits_2(tmp_path, ws):
    env = env_for(tmp_path, ws)
    waker = subprocess.Popen([str(WATCHER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=env, cwd=str(config.corpus_dir(CORPUS)))
    waker.stdin.write(json.dumps({"session_id": MAIN, "hook_event_name": "Stop"}))
    waker.stdin.close()
    time.sleep(0.5)
    assert waker.poll() is None, "it waits while nothing is queued"
    out = events.post(CORPUS, "label_done", {"text": "refunds: 12 yes", "name": "refunds"}, check_kind=False)
    try:
        code = waker.wait(timeout=10)
    finally:
        if waker.poll() is None:
            waker.kill()
    err = waker.stderr.read()
    assert code == 2
    assert err.startswith(f'<thimble-event kind="label_done" event="{out["id"]}"') and "refunds: 12 yes" in err
    assert event_files.waiting(ws) == []


def test_a_press_while_main_is_idle_turns_the_waker_to_the_server_and_its_event_wakes_main(tmp_path, ws):
    """The `thimble` command presses the browser workbench at the session's start, after SessionStart's waker began on
    local transport and took the session's lock, and no queue file is there yet. Every later hook's waker exits on that
    lock, and while main is idle none runs, so this waker pulls from the server from the press on: a side thread's
    event the server holds wakes main."""
    stand = _Stand([(200, {"id": "e1", "text": EVENT_TEXT})])
    env = env_for(tmp_path, ws)
    Path(env["THIMBLE_HOME"], "server.json").write_text(json.dumps({"api": f"http://127.0.0.1:{stand.port}",
                                                                    "token": TOKEN}))
    waker = subprocess.Popen([str(WATCHER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=env, cwd=str(config.corpus_dir(CORPUS)))
    waker.stdin.write(json.dumps({"session_id": MAIN, "hook_event_name": "SessionStart", "source": "startup"}))
    waker.stdin.close()
    try:
        time.sleep(0.5)
        assert waker.poll() is None and not event_files.queue_path(ws).exists()
        write_launch(ws, session=MAIN, transport="server")  # the press
        try:
            code = waker.wait(timeout=15)
        except subprocess.TimeoutExpired:
            code = None
    finally:
        if waker.poll() is None:
            waker.kill()
        stand.close()
    assert code == 2 and waker.stderr.read().strip() == EVENT_TEXT
    assert [(m, p) for m, p, _ in stand.seen] == [("GET", "/api/events/pull"), ("POST", "/api/events/ack")]


def test_with_plain_claude_a_side_thread_asked_after_the_press_wakes_idle_main_through_the_server(tmp_path, ws,
                                                                                                   monkeypatch):
    """Bug hunt B4, plain `claude`: main's turn ended on local transport before any event was queued, so its Stop
    hook's waker holds the session's lock with no queue file to look at. The analyst presses `/thimble browser` while
    main is idle, then asks in a side thread from the terminal: `thimble act thread` writes the thread's event to the
    queue file, as every process of the session but the server does, and the server takes it from there at a pull
    (events._drain_files). The waker must be pulling by then: it used to look at the transport only once a queue file
    was there, so it saw the press only when the thread's event made the file, and exited with nothing pulled; no other
    waker runs while main is idle, so the thread waited for the analyst's next prompt."""
    stand = _Stand([])
    env = env_for(tmp_path, ws)
    Path(env["THIMBLE_HOME"], "server.json").write_text(json.dumps({"api": f"http://127.0.0.1:{stand.port}",
                                                                    "token": TOKEN}))
    waker = subprocess.Popen([str(WATCHER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=env, cwd=str(config.corpus_dir(CORPUS)))
    waker.stdin.write(json.dumps({"session_id": MAIN, "hook_event_name": "Stop"}))
    waker.stdin.close()
    try:
        time.sleep(0.5)
        assert waker.poll() is None and not event_files.queue_path(ws).exists()
        write_launch(ws, session=MAIN, transport="server")  # /thimble browser
        until = time.monotonic() + 6
        while time.monotonic() < until and not any(p == "/api/events/pull" for _, p, _ in stand.seen):
            time.sleep(0.1)
        monkeypatch.setattr(events, "SERVING", False)  # posted from the terminal's `thimble act`, not the server
        out = events.post(CORPUS, "label_done", {"text": "the side thread's question", "name": "q"}, check_kind=False,
                          session=MAIN)
        assert [r["id"] for r in event_files.waiting(ws)] == [out["id"]], "the terminal's process writes the file"
        stand.answers.append((200, {"id": out["id"], "text": EVENT_TEXT}))  # the server's pull drained the file
        try:
            code = waker.wait(timeout=15)
        except subprocess.TimeoutExpired:
            code = None
    finally:
        if waker.poll() is None:
            waker.kill()
        stand.close()
    assert code == 2 and waker.stderr.read().strip() == EVENT_TEXT
    assert ("POST", "/api/events/ack") in [(m, p) for m, p, _ in stand.seen]


def _start_waker(env: dict) -> subprocess.Popen:
    """SessionStart's waker as Claude Code runs it: hooks.json's asyncRewake command for the event, in a shell, with the
    hook's input on its stdin."""
    hooks = json.loads((BIN.parent / "hooks" / "hooks.json").read_text())["hooks"]["SessionStart"]
    command = next(h["command"] for e in hooks if "matcher" not in e for h in e["hooks"] if h.get("asyncRewake"))
    proc = subprocess.Popen(["/bin/sh", "-c", command], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env={**env, "CLAUDE_PLUGIN_ROOT": str(BIN.parent)},
                            cwd=str(config.corpus_dir(CORPUS)))
    proc.stdin.write(json.dumps({"session_id": MAIN, "hook_event_name": "SessionStart", "source": "startup"}))
    proc.stdin.close()
    return proc


def test_session_start_s_waker_waits_for_the_marker_activation_writes_so_the_first_browser_question_wakes_idle_main(
        tmp_path, ws):
    """Bug hunt G1: Claude Code runs SessionStart's hooks as the session starts, and the terminal UI's activation writes
    the session's marker a few seconds later. SessionStart's waker left at the gate, and no other hook runs while main is
    idle, so the analyst's first question from the browser waited for a prompt typed in the terminal. In an interactive
    session the waker now waits for the marker; under `claude -p`, which waits for this hook, it still leaves at once."""
    env = env_for(tmp_path, ws, CLAUDE_CODE_ENTRYPOINT="cli")
    marker = Path(env["THIMBLE_HOME"], "up", f"{MAIN}.active")
    body = marker.read_text()
    marker.unlink()
    printing = _start_waker({**env, "CLAUDE_CODE_ENTRYPOINT": "sdk-cli"})
    try:
        assert printing.wait(timeout=1.5) == 0, "under claude -p it waits for no marker"
    finally:
        if printing.poll() is None:
            printing.kill()
    waker = _start_waker(env)
    try:
        time.sleep(1.5)
        assert waker.poll() is None, "it waits for the marker rather than leaving at the gate"
        marker.write_text(body)  # the terminal UI's activation
        time.sleep(1.0)
        out = events.post(CORPUS, "main", {"text": "What are these runs?"})
        try:
            code = waker.wait(timeout=10)
        except subprocess.TimeoutExpired:
            code = None
    finally:
        if waker.poll() is None:
            waker.kill()
    err = waker.stderr.read()
    assert code == 2 and f'event="{out["id"]}"' in err and "What are these runs?" in err
    assert event_files.waiting(ws) == []


def test_no_hook_opens_a_socket_in_terminal_mode_and_each_file_first_hook_starts_the_backend_s_call(
        tmp_path, ws, monkeypatch, capsys):
    watcher, spawned = loaded(monkeypatch, tmp_path, ws)
    with sf.update(ws) as state:
        sf.requests(state)["req_t000000001"] = {
            "kind": "start", "route": "typed", "role": "orientation", "key": "orient", "state": "pending",
            "input": {"subagent_type": "thimble:orientation", "description": "orientation", "prompt": "req_t000000001\nGo."},
            "values": {}, "created": time.time(), "claimed_by": None}
    call = {"session_id": MAIN, "tool_use_id": "toolu_1", "permission_mode": "default", "tool_name": "Agent",
            "tool_input": {"subagent_type": "thimble:orientation", "description": "orientation",
                           "prompt": "req_t000000001\nGo."}}
    for flag, inp in [
        ("--agent-check", call),
        ("--subagent-start", {"session_id": MAIN, "agent_id": AGENT, "agent_type": "thimble:orientation"}),
        ("--caller", {"session_id": MAIN, "agent_id": AGENT, "agent_type": "thimble:orientation",
                      "tool_use_id": "toolu_c", "tool_name": "mcp__plugin_thimble_thimble__add_card"}),
        ("--agents", {"session_id": MAIN, "agent_id": AGENT, "tool_use_id": "toolu_b", "tool_name": "Bash",
                      "tool_input": {"command": "ls"}, "permission_mode": "default"}),
        ("--subagent-stop", {"session_id": MAIN, "agent_id": AGENT, "agent_type": "thimble:orientation"}),
        ("--subagent-stop", {"session_id": MAIN, "agent_id": "afork", "agent_type": "fork"}),
        ("--denied", {"session_id": MAIN, "tool_name": "SendMessage", "tool_use_id": "toolu_d",
                      "tool_input": {"to": AGENT, "message": "hi"}, "reason": "no"}),
        ("--end", {"session_id": MAIN, "reason": "clear"}),
        ("--rekey", {"session_id": "new-sid", "source": "clear"}),
        ("--end", {"session_id": "new-sid", "reason": "prompt_input_exit"}),
    ]:
        monkeypatch.setattr(sys, "argv", [str(WATCHER), flag])
        monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps(inp)))
        assert watcher.main() == 0, flag
    for flag in ("--held", "--mode", "--permission"):
        monkeypatch.setattr(sys, "argv", [str(WATCHER), flag])
        monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps({"session_id": "new-sid"})))
        assert watcher.main() == 0, flag
    assert [k for k, _ in spawned] == ["started", "stopped", "stopped", "rekey", "end"]
    assert spawned[2][1]["agent_type"] == "fork", "the mirror reads a fork's turn too"
    assert spawned[3][1]["old"] == MAIN
    assert sf.read(ws)["module"]["notes"]["session"] == "new-sid"
    assert sf.read(ws)["requests"]["req_t000000001"]["state"] == "started"


def test_a_process_that_lost_the_launcher_s_environment_finds_no_workspace_and_makes_nothing(tmp_path, ws):
    """Live check T12: every THIMBLE_* unset and another HOME. Each hook and the statusline do nothing, and the home
    that environment names is never made."""
    fake = tmp_path / "fakehome"
    fake.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_"))}
    env.update(HOME=str(fake), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)))
    for flag, inp in [(None, {"session_id": MAIN, "hook_event_name": "Stop"}), ("--held", {"session_id": MAIN}),
                      ("--mode", {"session_id": MAIN, "permission_mode": "plan", "hook_event_name": "Stop"}),
                      ("--subagent-start", {"session_id": MAIN, "agent_id": AGENT, "agent_type": "thimble:orientation"}),
                      ("--subagent-stop", {"session_id": MAIN, "agent_id": AGENT, "agent_type": "fork"}),
                      ("--end", {"session_id": MAIN, "reason": "other"})]:
        done = run_hook(env, flag, inp, timeout=20)
        assert (done.returncode, done.stdout) == (0, ""), flag
    out = subprocess.run([str(AGENTS), "--statusline"], input="{}", capture_output=True, text=True, env=env, timeout=30)
    assert out.stdout == ""
    local = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, sys.argv[1]); "
                            "from app.local_hooks import main; sys.exit(main(['main-stop']))",
                            str(Path(__file__).resolve().parents[1])],
                           input=json.dumps({"cwd": str(config.corpus_dir(CORPUS))}), capture_output=True, text=True,
                           env=env, timeout=60)
    assert local.returncode == 0, local.stderr
    assert not (fake / ".thimble").exists()
    assert "events" not in os.listdir(ws) and not (ws / "sessions.json").exists()
