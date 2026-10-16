"""The files thimble's hooks keep about its agents (app/subagent_files.py) and the hooks that write them
(plugin/bin/.thimble-watch): a start of one of thimble's roles goes through only when it matches a pending request
exactly, a plugin start only a click's, a follow-up only a pending message; SubagentStart registers an agent and its
descendants; the hooks write their records without a server. Hook inputs are shaped as the step-0b spikes recorded them
(~/dev/thimble-spikes/sub060/v3/a/evidence/v1/hooks.jsonl), with the spike's plugin name written as thimble's."""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import pytest
from conftest import mark_open

from app import config
from app import subagent_files as sf

WATCHER = Path(__file__).resolve().parents[2] / "plugin" / "bin" / ".thimble-watch"
CORPUS = "mini"
MAIN_SID = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
PLUGIN_CALL = "toolu_plugin_105f7e7c43f642eea2b10a326d1a43c4"
def pending_start(state: dict, rid: str, route: str, prompt: str, role: str = "orientation", key: str = "orient",
                  **extra) -> None:
    sf.requests(state)[rid] = {"kind": "start", "route": route, "role": role, "key": key,
                               "input": {"subagent_type": sf.type_name(role), "description": f"{role}: x",
                                         "prompt": prompt},
                               "values": {"model": "claude-opus-5-5[1m]", "effort": "max"}, "created": time.time(),
                               "claimed_by": None, "state": "pending", **extra}


def agent_call(prompt: str, call: str = "toolu_01main", caller: str | None = None, role: str = "orientation",
               **inp) -> dict:
    return {"hook_event_name": "PreToolUse", "tool_name": "Agent", "session_id": MAIN_SID, "tool_use_id": call,
            "permission_mode": "auto", **({"agent_id": caller} if caller else {}),
            "tool_input": {"description": f"{role}: x", "prompt": prompt, "subagent_type": sf.type_name(role), **inp}}


def test_plan_mode_and_a_second_orientation_and_a_call_with_no_request_are_denied():
    state: dict = {}
    pending_start(state, "req_0000000003", "typed", "p")
    assert sf.check_call(state, {**agent_call("p"), "permission_mode": "plan"}) is not None
    assert sf.requests(state)["req_0000000003"]["state"] == "pending"
    assert sf.check_call(state, agent_call("nothing asked for this")) is not None
    sf.registry(state)["a1"] = {"role": "orientation", "key": "orient", "status": "running"}
    assert sf.check_call(state, agent_call("p")) is not None, "an orientation already runs"


# --------------------------------------------------------------------------- the hooks, run as Claude Code runs them


def run_hook(tmp_path: Path, flag: str, stdin: dict) -> subprocess.CompletedProcess:
    """The watcher run with `flag` and the hook input `stdin`, as main's hooks run it: in the corpus folder, with no
    server recorded in its thimble home."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_SESSION"))}
    env.update(THIMBLE_HOME=str(tmp_path / "hook-home"), THIMBLE_WORKSPACES_DIR=str(config.WORKSPACES_DIR),
               THIMBLE_DATA_DIR=str(config.DATA_DIR), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)))
    mark_open(tmp_path / "hook-home", config.corpus_dir(CORPUS))  # /thimble opened the folder
    return subprocess.run([str(WATCHER), flag], input=json.dumps(stdin), capture_output=True, text=True, env=env,
                          timeout=30, cwd=str(config.corpus_dir(CORPUS)))


@pytest.fixture()
def ws() -> Path:
    path = config.workspace_dir(CORPUS)
    sf.ensure(path)
    return path


def test_without_a_server_the_agent_check_decides_from_the_file_alone(tmp_path, ws):
    with sf.update(ws) as state:
        pending_start(state, "req_hook000001", "click", "the click")
    denied = run_hook(tmp_path, "--agent-check", agent_call("not asked", call=PLUGIN_CALL))
    out = json.loads(denied.stdout)
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    allowed = run_hook(tmp_path, "--agent-check", agent_call("the click", call=PLUGIN_CALL))
    assert allowed.returncode == 0 and allowed.stdout.strip() == "", "it never answers allow"
    assert sf.read(ws)["requests"]["req_hook000001"]["claimed_by"] == PLUGIN_CALL


def test_a_check_that_fails_denies_a_start_of_a_role_and_lets_any_other_call_go(tmp_path, ws):
    """A hook that fails lets its call run, so a start of one of thimble's roles is denied when the check itself cannot
    run (here subagents.json cannot be opened), and every other Agent call goes on as Claude Code made it."""
    state = sf.state_path(ws)
    state.unlink()
    state.mkdir()
    try:
        out = run_hook(tmp_path, "--agent-check", agent_call("not asked", call=PLUGIN_CALL))
        assert json.loads(out.stdout)["hookSpecificOutput"]["permissionDecision"] == "deny"
        other = run_hook(tmp_path, "--agent-check", {**agent_call("x", call="toolu_gp1"),
                                                     "tool_input": {"subagent_type": "general-purpose", "prompt": "x"}})
        assert other.returncode == 0 and other.stdout.strip() == ""
    finally:
        state.rmdir()


def test_a_folder_of_no_workspace_writes_nothing(tmp_path):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
    env.update(THIMBLE_HOME=str(tmp_path / "h"), CLAUDE_PROJECT_DIR=str(tmp_path))
    done = subprocess.run([str(WATCHER), "--subagent-start"], input=json.dumps({"agent_id": "a", "agent_type": "x"}),
                          capture_output=True, text=True, env=env, timeout=30)
    assert done.returncode == 0 and done.stdout == ""


def test_the_waker_exits_at_once_under_claude_p(tmp_path):
    """`claude -p` waits for an asyncRewake SessionStart hook and never calls the model, so the waker must not
    long-poll there (U5): with a server recorded that holds every request open, under a `claude -p` it exits at once,
    and under an interactive `claude` it waits on that server."""
    import socket
    import sys

    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)  # takes connections and answers none: a long poll that never returns
    home = tmp_path / "h"
    home.mkdir()
    (home / "server.json").write_text(json.dumps({"port": srv.getsockname()[1], "token": "t"}))
    sleeper = [sys.executable, "-c", "import time; time.sleep(60)"]

    def waker(parent: subprocess.Popen, timeout: float) -> float:
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
        env.update(THIMBLE_HOME=str(home), CLAUDE_PID=str(parent.pid))
        t0 = time.monotonic()
        try:
            subprocess.run([str(WATCHER)], input=json.dumps({"session_id": "s1", "hook_event_name": "SessionStart"}),
                           capture_output=True, text=True, env=env, timeout=timeout)
        except subprocess.TimeoutExpired:
            return 99.0
        return time.monotonic() - t0

    printing = subprocess.Popen([*sleeper, "-p"])  # stands in for `claude -p`: an argv with -p
    interactive = subprocess.Popen(sleeper)
    try:
        assert waker(printing, 3) < 3
        assert waker(interactive, 1.5) == 99.0, "an interactive session's waker waits for the server's event"
    finally:
        printing.kill()
        interactive.kill()
        srv.close()


def test_the_hooks_json_runs_each_new_mode():
    hooks = json.loads((WATCHER.parent.parent / "hooks" / "hooks.json").read_text())["hooks"]

    def commands(event: str) -> list[tuple[str, str]]:
        return [(e.get("matcher", ""), h["command"]) for e in hooks.get(event, []) for h in e["hooks"]]

    assert any(c.endswith("--subagent-start") for _, c in commands("SubagentStart"))
    assert any(c.endswith("--subagent-stop") for _, c in commands("SubagentStop"))
    assert not any("--proxy-stop" in c for _, c in commands("SubagentStop"))
    assert ("Agent|Task|SendMessage", '"${CLAUDE_PLUGIN_ROOT}/bin/.thimble-watch" --agent-check') in commands("PreToolUse")
    assert any(m == "mcp__plugin_thimble_thimble__.*" and c.endswith("--caller") for m, c in commands("PreToolUse"))
    assert any(c.endswith("--denied") for _, c in commands("PermissionDenied"))
    assert any(c.endswith("--end") for _, c in commands("SessionEnd"))
    assert [e["hooks"][0]["timeout"] for e in hooks["SessionEnd"]] == [5]
    # 0.9.0: --rekey runs before the guide is printed again, in one command, since Claude Code runs the hooks of one
    # event at once
    assert any({"clear", "resume"} <= set(m.split("|")) and '.thimble-watch" --rekey;' in c for m, c in commands("SessionStart"))
