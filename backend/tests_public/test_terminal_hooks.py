"""thimble's hooks in terminal mode (plugin/bin/.thimble-watch with THIMBLE_WS naming a workspace whose launch.json says
terminal mode): no hook makes an HTTP request; the waker takes main's events from the workspace's queue and wakes main
with exit 2; the held hook prints what waited; the mode hook records main's permission mode and starts the backend's
call on main's Stop; the file-first hooks start the backend's call (app/local_hooks.py) in place of a post; the
statusline reads the files. A process that lost the launcher's environment finds no workspace and makes nothing."""
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
    """The hooks' environment in a terminal-mode session: the launcher's THIMBLE_HOME, THIMBLE_MODE and THIMBLE_WS, and a
    server.json naming a server, which no hook of terminal mode may ask."""
    home = tmp_path / "hook-home"
    home.mkdir(exist_ok=True)
    (home / "server.json").write_text(json.dumps({"port": 9, "token": "t0ken"}))
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_"))}
    env.update(THIMBLE_HOME=str(home), THIMBLE_MODE="terminal", THIMBLE_WS=str(ws),
               THIMBLE_DATA_DIR=str(config.DATA_DIR), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)),
               CLAUDE_CONFIG_DIR=str(tmp_path / "claude-config"), CLAUDE_PID=str(_CLAUDE[0]))
    env.update(more)
    return env


def run_hook(env: dict, flag: str | None, stdin: dict, timeout: float = 30) -> subprocess.CompletedProcess:
    return subprocess.run([str(WATCHER), *([flag] if flag else [])], input=json.dumps(stdin), capture_output=True,
                          text=True, env=env, timeout=timeout, cwd=str(config.corpus_dir(CORPUS)))


def loaded(monkeypatch, tmp_path: Path, ws: Path):
    """The watcher as a module, in a terminal-mode environment, with spawn_local recording its calls and every socket
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


def test_a_second_waker_exits_at_once_and_one_for_another_session_does_not_wait(tmp_path, ws):
    env = env_for(tmp_path, ws)
    first = subprocess.Popen([str(WATCHER)], stdin=subprocess.PIPE, text=True, env=env,
                             cwd=str(config.corpus_dir(CORPUS)))
    first.stdin.write(json.dumps({"session_id": MAIN, "hook_event_name": "SessionStart"}))
    first.stdin.close()
    try:
        time.sleep(0.5)
        start = time.monotonic()
        assert run_hook(env, None, {"session_id": MAIN, "hook_event_name": "PreToolUse"}).returncode == 0
        assert time.monotonic() - start < 5
        assert run_hook(env, None, {"session_id": "not-main", "hook_event_name": "Stop"}).returncode == 0
        assert run_hook(env, None, {"session_id": MAIN, "agent_id": AGENT, "hook_event_name": "PreToolUse"}).returncode == 0
    finally:
        first.kill()
        first.wait()


def test_the_held_hook_prints_the_held_events_and_the_lines_of_those_the_waker_wrote_out(tmp_path, ws):
    events.post(CORPUS, "orient", {"text": "The orientation made 7 cards.\nIt opened 3 of 7 files."}, check_kind=False)
    sent = events.post(CORPUS, "label_done", {"text": "x", "name": "refunds"}, check_kind=False)
    event_files.take(ws, MAIN)
    events.post(CORPUS, "written", {"text": "Saved.", "doc": "report"}, check_kind=False)
    out = run_hook(env_for(tmp_path, ws), "--held", {"session_id": MAIN, "hook_event_name": "UserPromptSubmit"})
    got = json.loads(out.stdout)
    assert got["hookSpecificOutput"]["additionalContext"] == 'meanwhile:\n[kind="written" doc="report"] Saved.'
    # the writer's end is left out: its hand-back's row says it, and Claude Code draws a systemMessage under the hook's
    # name (`UserPromptSubmit says: …`), a row no render hook reaches
    assert got["systemMessage"] == "label finished: refunds\nThe orientation made 7 cards.\nIt opened 3 of 7 files.", \
        "the orient event rode along with the next one"
    assert sent["id"] and run_hook(env_for(tmp_path, ws), "--held", {"session_id": MAIN}).stdout == "", "each once"
    assert run_hook(env_for(tmp_path, ws), "--held", {"session_id": "not-main"}).stdout == ""


def test_the_permission_hook_answers_nothing_at_once(tmp_path, ws):
    start = time.monotonic()
    out = run_hook(env_for(tmp_path, ws), "--permission", {"session_id": MAIN, "tool_name": "WebFetch",
                                                          "tool_input": {"url": "https://example.com"}})
    assert (out.returncode, out.stdout) == (0, "") and time.monotonic() - start < 5


def test_the_mode_hook_records_main_s_mode_and_starts_the_backend_s_call_on_main_s_stop(tmp_path, ws, monkeypatch):
    watcher, spawned = loaded(monkeypatch, tmp_path, ws)
    watcher.mode_files({"session_id": MAIN, "hook_event_name": "UserPromptSubmit", "permission_mode": "auto"}, ws)
    assert sf.read(ws)["main"]["permission_mode"] == "auto" and spawned == []
    watcher.mode_files({"session_id": MAIN, "hook_event_name": "Stop", "permission_mode": "auto"}, ws)
    assert [k for k, _ in spawned] == ["main-stop"]
    watcher.mode_files({"session_id": MAIN, "hook_event_name": "UserPromptSubmit", "permission_mode": "plan"}, ws)
    assert [k for k, _ in spawned] == ["main-stop"], "plan mode starts no backend call: it stops no running agent"
    assert sf.read(ws)["main"]["before_plan"] == "auto"
    watcher.mode_files({"session_id": "not-main", "hook_event_name": "Stop", "permission_mode": "default"}, ws)
    watcher.mode_files({"session_id": MAIN, "agent_id": AGENT, "hook_event_name": "Stop", "permission_mode": "default"}, ws)
    assert len(spawned) == 1 and sf.read(ws)["main"]["permission_mode"] == "plan"


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


def test_the_agent_check_refuses_a_second_fork_of_a_thread_from_the_file(tmp_path, ws, monkeypatch, capsys):
    watcher, _ = loaded(monkeypatch, tmp_path, ws)
    fork = {"session_id": MAIN, "tool_use_id": "toolu_f1", "tool_name": "Agent",
            "tool_input": {"subagent_type": "fork", "description": "thread:bots", "prompt": "thread:bots"}}
    watcher.agent_check(fork)
    assert capsys.readouterr().out == ""
    watcher.agent_check({**fork, "tool_use_id": "toolu_f2"})
    out = json.loads(capsys.readouterr().out)["hookSpecificOutput"]
    assert out["permissionDecision"] == "deny" and "thread bots is running already" in out["permissionDecisionReason"]
    watcher.agent_check({**fork, "tool_input": {**fork["tool_input"], "description": "thread:other", "prompt": "thread:other"}})
    assert capsys.readouterr().out == ""


def test_the_agent_check_names_a_refused_fork_s_thread_by_its_question_and_knows_the_fork_by_its_prompt(tmp_path, ws, monkeypatch, capsys):
    """thimble-term gives main's fork call the thread's question as its description, so the check knows the fork by
    the prompt's `thread:<name>`; a refusal names the thread by its first question, never its fork's slug."""
    from app import agents

    meta = agents.new_thread(CORPUS, None, None, "Bots", surface="terminal")
    agents.update_agent(CORPUS, meta["id"], fork_name="which-bots-saved-the")
    agents.append(agents.paths(CORPUS, meta["id"])[1], {"type": "user", "text": "Which bots saved the welcome page on 18 June, and how often?"})
    watcher, _ = loaded(monkeypatch, tmp_path, ws)
    fork = {"session_id": MAIN, "tool_use_id": "toolu_f1", "tool_name": "Agent",
            "tool_input": {"subagent_type": "fork", "description": "thread “Which bots saved the welcome…”",
                           "prompt": "thread:which-bots-saved-the"}}
    watcher.agent_check(fork)
    assert capsys.readouterr().out == ""
    watcher.agent_check({**fork, "tool_use_id": "toolu_f2"})
    reason = json.loads(capsys.readouterr().out)["hookSpecificOutput"]["permissionDecisionReason"]
    assert reason == ("The fork of thread “Which bots saved the welcome page on 18 June, and how often?” is running "
                      "already and answers in the thread, so this turn needs nothing more.")
    assert "which-bots-saved-the" not in reason
    # the call let through is kept by its tool_use id, by which the mirror knows the fork's thread whatever its meta json
    # says (live check term-fix5, new quirk 1); the refused one is not
    state = sf.read(ws)
    assert sf.fork_call_ref(state, "toolu_f1") == "thread:which-bots-saved-the"
    assert sf.fork_call_ref(state, "toolu_f2") is None


def test_the_agents_hook_numbers_an_orientation_s_call_and_tells_it_its_ref(tmp_path, ws, monkeypatch, capsys):
    import types

    watcher, spawned = loaded(monkeypatch, tmp_path, ws)
    numbered: list[tuple] = []
    fake = types.ModuleType("app.calls_file")
    fake.number = lambda ws_, chat, tid, name, inp, agent: numbered.append((chat, tid, name, agent)) or 7
    monkeypatch.setitem(sys.modules, "app.calls_file", fake)
    import app

    monkeypatch.setattr(app, "calls_file", fake, raising=False)
    with sf.update(ws) as state:
        sf.registry(state)[AGENT] = {"role": "orientation", "key": "orient", "chat": "orient-chat", "status": "running"}
    watcher.agents_hook({"session_id": MAIN, "agent_id": AGENT, "tool_use_id": "toolu_r", "tool_name": "Read",
                         "tool_input": {"file_path": "x"}, "permission_mode": "default"})
    ctx = json.loads(capsys.readouterr().out)["hookSpecificOutput"]["additionalContext"]
    assert "call:orient-chat/7" in ctx and numbered == [("orient-chat", "toolu_r", "Read", None)]
    watcher.agents_hook({"session_id": MAIN, "agent_id": AGENT, "tool_use_id": "toolu_p", "tool_name": "Read",
                         "tool_input": {"file_path": "x"}, "permission_mode": "plan"})
    assert spawned == [], "an agent's call in plan mode starts no backend call: plan mode stops no running agent"


def test_the_statusline_reads_the_files_in_terminal_mode(tmp_path, ws):
    with sf.update(ws) as state:
        sf.registry(state)[AGENT] = {"role": "orientation", "key": "orient", "status": "running"}
    (ws / "orient").mkdir(exist_ok=True)
    (ws / "orient" / "run.json").write_text(json.dumps({"passes": ["final"], "groups": {"orientation": "orientation"}}))
    (ws / "notebooks").mkdir(exist_ok=True)
    (ws / "notebooks" / "orientation.json").write_text(json.dumps({"cells": [{"id": "a"}, {"id": "b"}]}))
    event_files.append(ws, {"content": "Which bot?", "meta": {"kind": "thread", "event": "e1"},
                            "terminal": "› thread bots: Which bot?"}, events.render)
    out = subprocess.run([str(AGENTS), "--statusline"], input=json.dumps({"session_id": MAIN}), capture_output=True,
                         text=True, env=env_for(tmp_path, ws), timeout=30)
    assert out.stdout.strip().splitlines() == ["thimble · orientation working · 2 cards",
                                              "thimble · queued: thread bots: Which bot?"]


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


def test_main_s_stop_starts_the_backend_s_call_as_a_process_of_its_own_that_runs_the_mirror(tmp_path, ws):
    """The whole chain with no fake: the mode hook on main's Stop starts `thimble-python … app.local_hooks main-stop`
    detached and returns at once; that process attaches main from launch.json and reads its transcript."""
    project = tmp_path / "claude-config" / "projects" / "-corpus"
    project.mkdir(parents=True)
    (project / f"{MAIN}.jsonl").write_text(json.dumps({"type": "user", "origin": {"kind": "human"},
                                                       "message": {"content": "How many files?"}}) + "\n")
    start = time.monotonic()
    done = run_hook(env_for(tmp_path, ws), "--mode", {"session_id": MAIN, "hook_event_name": "Stop",
                                                      "permission_mode": "default"})
    assert done.returncode == 0 and time.monotonic() - start < 10
    for _ in range(300):
        rec = json.loads((ws / "sessions.json").read_text()).get(MAIN) if (ws / "sessions.json").exists() else None
        if rec and rec.get("cursor"):
            break
        time.sleep(0.1)
    assert rec and rec["cursor"]["offset"] > 0, (ws / "local-hooks.log").read_text() if (ws / "local-hooks.log").exists() else ""
    from app import agents

    said = [r.get("text") for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1]) if r.get("type") == "user"]
    assert said == ["How many files?"]


def test_the_monitor_route_streams_main_s_events_from_the_queue_until_main_exits(tmp_path, ws):
    a = events.post(CORPUS, "label_done", {"text": "first", "name": "a"}, check_kind=False)
    b = events.post(CORPUS, "rerun", {"text": "second", "name": "b"}, check_kind=False)
    short = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(2)"])
    import threading

    threading.Thread(target=short.wait, daemon=True).start()  # reaped as main's shell reaps it, so it is gone
    try:
        out = subprocess.run([str(WATCHER), "--stream", "--cwd", str(config.corpus_dir(CORPUS)), "--session", MAIN],
                             capture_output=True, text=True, env=env_for(tmp_path, ws, CLAUDE_PID=str(short.pid)),
                             timeout=30)
    finally:
        short.wait()
    assert out.returncode == 0
    assert out.stdout.index(f'event="{a["id"]}"') < out.stdout.index(f'event="{b["id"]}"')
    assert event_files.waiting(ws) == []


def test_the_waker_starts_no_backend_call_when_the_module_sees_plan_mode_while_agents_run(tmp_path, ws, monkeypatch):
    """Plan mode stops no running agent, as in browser mode, so the waker starts nothing when the module's plan poll
    sees plan mode begin while one of thimble's agents runs, nor for an agent's tool call in plan mode."""
    from terminal_fakes import FileModule

    watcher, spawned = loaded(monkeypatch, tmp_path, ws)
    assert not hasattr(watcher, "PlanWatch") and not hasattr(watcher, "plan_call")
    with sf.update(ws) as state:
        sf.registry(state)[AGENT] = {"role": "orientation", "key": "orient", "status": "running"}
    FileModule(ws, session=MAIN).plan(True)
    assert watcher.watch_files({"session_id": MAIN, "agent_id": AGENT, "hook_event_name": "PreToolUse",
                                "permission_mode": "plan"}, ws) == 0
    assert spawned == []
