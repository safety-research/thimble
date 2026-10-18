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


def test_a_subagent_s_message_to_its_own_parent_goes_on_and_any_other_message_with_no_request_is_denied():
    """A helper whose hand-back was cut off sends the rest to its orientation with SendMessage (B6). Main's message, and
    one from a subagent of another agent, still need a pending request."""
    state: dict = {}
    sf.registry(state).update({"orient1": {"role": "orientation", "key": "orient", "status": "running"},
                               "helper1": {"role": sf.HELPER, "parent": "orient1", "status": "running"},
                               "helper2": {"role": sf.HELPER, "parent": "other", "status": "running"}})

    def send(caller: str | None) -> dict:
        return {"hook_event_name": "PreToolUse", "tool_name": "SendMessage", "session_id": MAIN_SID,
                "tool_use_id": "toolu_send1", "permission_mode": "auto", **({"agent_id": caller} if caller else {}),
                "tool_input": {"to": "orient1", "message": "the rest of my report"}}

    assert sf.check_call(state, send("helper1")) is None
    assert sf.check_call(state, send(None)) is not None
    assert sf.check_call(state, send("helper2")) is not None
    assert sf.check_call(state, {**send("helper1"), "permission_mode": "plan"}) is not None


def test_a_helper_s_message_to_main_is_denied_with_a_reason_that_names_its_parent():
    """Bug hunt 3, D12: a helper whose hand-back was cut off sent its note with SendMessage to "main", which took a turn
    of main's in the analyst's chat. A message to main from an agent whose parent is one of thimble's agents is denied,
    and the reason names that parent, where the message then goes on; main's direct agents may still message main."""
    state: dict = {}
    sf.registry(state).update({"orientx": {"role": "orientation", "key": "orient", "status": "running"},
                               "helperx": {"role": sf.HELPER, "parent": "orientx", "status": "running"}})

    def send(caller: str, to: str) -> dict:
        return {"hook_event_name": "PreToolUse", "tool_name": "SendMessage", "session_id": MAIN_SID,
                "tool_use_id": "toolu_send2", "permission_mode": "auto", "agent_id": caller,
                "tool_input": {"to": to, "summary": "report cut off", "message": "my report on the relay was cut off"}}

    reason = sf.check_call(state, send("helperx", "main"))
    assert reason and "orientx" in reason
    assert sf.check_call(state, send("helperx", "orientx")) is None
    assert sf.check_call(state, send("orientx", "main")) is None


# --------------------------------------------------------------------------- the hooks, run as Claude Code runs them


def run_hook(tmp_path: Path, flag: str, stdin: dict) -> subprocess.CompletedProcess:
    """The watcher run with `flag` and the hook input `stdin`, as main's hooks run it: in the corpus folder, with no
    server recorded in its thimble home."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_SESSION"))}
    env.update(THIMBLE_HOME=str(tmp_path / "hook-home"), THIMBLE_WORKSPACES_DIR=str(config.WORKSPACES_DIR),
               THIMBLE_DATA_DIR=str(config.DATA_DIR), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)))
    mark_open(tmp_path / "hook-home", config.corpus_dir(CORPUS))  # /thimble browsered the folder
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


def handback_call(agent: str, agent_type: str, message: str = "Judgment calls: 2 comments.") -> dict:
    return {"hook_event_name": "PreToolUse", "tool_name": "SubagentHandback", "session_id": MAIN_SID,
            "tool_use_id": "toolu_hb1", "permission_mode": "auto", "agent_id": agent, "agent_type": agent_type,
            "tool_input": {"message": message}}


HANDBACK_AGENTS = {  # the module started each but chk-main, which main's run_check started with its own Agent call
    "chk-mod": {"role": "check", "type": "thimble:check", "plugin_started": True},
    "call-mod": {"role": "call", "type": "thimble:call", "plugin_started": True},
    "chk-main": {"role": "check", "type": "thimble:check", "plugin_started": False},
    "orient-mod": {"role": "orientation", "type": "thimble:orientation", "plugin_started": True},
}


def _handback_agents(ws: Path) -> None:
    with sf.update(ws) as state:
        sf.registry(state).update({a: {**e, "status": "running", "run": 0} for a, e in HANDBACK_AGENTS.items()})


def test_the_handback_hook_takes_the_report_of_a_check_or_call_agent_the_module_started(tmp_path, ws):
    """In auto mode an agent reports through SubagentHandback, which puts the report in main's queue. For a check's or
    the card check's agent that thimble's module started, the hook keeps the report on the agent's entry and refuses
    the call, `continue` false, which ends the agent's turn; every other agent's hand-back goes on as Claude Code made
    it."""
    _handback_agents(ws)
    for agent in ("chk-mod", "call-mod"):
        out = run_hook(tmp_path, "--handback", handback_call(agent, HANDBACK_AGENTS[agent]["type"], f"{agent} done"))
        got = json.loads(out.stdout)
        assert got["hookSpecificOutput"]["permissionDecision"] == "deny" and got["continue"] is False, agent
        assert "report" in got["hookSpecificOutput"]["permissionDecisionReason"]
        assert sf.taken_handback(sf.registry(sf.read(ws))[agent]) == f"{agent} done"
    for agent, agent_type in (("chk-main", "thimble:check"), ("orient-mod", "thimble:orientation"),
                              ("gp1", "general-purpose")):
        out = run_hook(tmp_path, "--handback", handback_call(agent, agent_type))
        assert out.returncode == 0 and out.stdout.strip() == "", agent
        assert sf.taken_handback(sf.registry(sf.read(ws)).get(agent)) is None


def test_the_handback_hook_refuses_nothing_when_it_cannot_keep_the_report(tmp_path, ws):
    """A refused hand-back whose report thimble did not keep would be lost, so with subagents.json unreadable the call
    goes on, and the terminal UI drops it as it enters main."""
    _handback_agents(ws)
    state = sf.state_path(ws)
    state.unlink()
    state.mkdir()
    try:
        out = run_hook(tmp_path, "--handback", handback_call("chk-mod", "thimble:check"))
        assert out.returncode == 0 and out.stdout.strip() == ""
    finally:
        state.rmdir()


def test_hooks_json_starts_python_for_a_hand_back_only_of_a_check_or_call_agent(tmp_path, ws):
    """The SubagentHandback hook's command matches the agent's type in the shell, so a hand-back of any other agent
    (the orientation's, a writer's) starts no Python."""
    hooks = json.loads((WATCHER.parent.parent / "hooks" / "hooks.json").read_text())["hooks"]
    [command] = [h["command"] for e in hooks["PreToolUse"] if e.get("matcher") == "SubagentHandback" for h in e["hooks"]]
    _handback_agents(ws)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_SESSION"))}
    env.update(THIMBLE_HOME=str(tmp_path / "hook-home"), THIMBLE_WORKSPACES_DIR=str(config.WORKSPACES_DIR),
               THIMBLE_DATA_DIR=str(config.DATA_DIR), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)),
               CLAUDE_PLUGIN_ROOT=str(WATCHER.parent.parent))
    mark_open(tmp_path / "hook-home", config.corpus_dir(CORPUS))

    def run(inp: dict) -> str:
        done = subprocess.run(["/bin/sh", "-c", command], input=json.dumps(inp), capture_output=True, text=True,
                              env=env, timeout=30, cwd=str(config.corpus_dir(CORPUS)))
        assert done.returncode == 0, done.stderr
        return done.stdout.strip()

    assert json.loads(run(handback_call("chk-mod", "thimble:check")))["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert run(handback_call("orient-mod", "thimble:orientation", 'it said "thimble:check"')) == ""
    assert sf.taken_handback(sf.registry(sf.read(ws))["orient-mod"]) is None


def test_a_check_starts_no_work_in_the_background_so_its_run_ends_with_its_turn(tmp_path, ws):
    """Bug hunt E10: a check that ended its turn with a background shell and a Monitor running ended it before its
    hand-back, and each later end sent main a task notification. hooks.json's PreToolUse hook on Bash, Agent and Task
    refuses a check's start in the background, with a reason that says to run it in the foreground; the same calls in
    the foreground, and any other agent's in the background, go on. The check's registration has no Monitor."""
    from app import checks

    hooks = json.loads((WATCHER.parent.parent / "hooks" / "hooks.json").read_text())["hooks"]
    [(matcher, command)] = [(e["matcher"], h["command"]) for e in hooks["PreToolUse"] for h in e["hooks"]
                            if "--foreground" in h["command"]]
    assert set(matcher.split("|")) == {"Bash", "Agent", "Task"}
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_SESSION"))}
    env.update(THIMBLE_HOME=str(tmp_path / "hook-home"), THIMBLE_WORKSPACES_DIR=str(config.WORKSPACES_DIR),
               THIMBLE_DATA_DIR=str(config.DATA_DIR), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)),
               CLAUDE_PLUGIN_ROOT=str(WATCHER.parent.parent))
    mark_open(tmp_path / "hook-home", config.corpus_dir(CORPUS))

    def run(agent_type: str, tool: str, **tool_input) -> str:
        inp = {"hook_event_name": "PreToolUse", "tool_name": tool, "session_id": MAIN_SID, "tool_use_id": "toolu_fg1",
               "permission_mode": "auto", "agent_id": "a-otter-17", "agent_type": agent_type, "tool_input": tool_input}
        done = subprocess.run(["/bin/sh", "-c", command], input=json.dumps(inp), capture_output=True, text=True,
                              env=env, timeout=30, cwd=str(config.corpus_dir(CORPUS)))
        assert done.returncode == 0, done.stderr
        return done.stdout.strip()

    wait = "until [ -s quarry.log ]; do sleep 5; done"
    for tool, args in (("Bash", {"command": wait, "run_in_background": True}),
                       ("Agent", {"subagent_type": "general-purpose", "prompt": "Count the lines.", "description": "x"}),
                       ("Task", {"subagent_type": "general-purpose", "prompt": "x", "run_in_background": True})):
        out = json.loads(run("thimble:check", tool, **args))["hookSpecificOutput"]
        assert out["permissionDecision"] == "deny", (tool, args)
        assert "run_in_background set to false" in out["permissionDecisionReason"]
    assert run("thimble:check", "Bash", command=wait) == ""
    assert run("thimble:check", "Agent", subagent_type="Explore", prompt="x", run_in_background=False) == ""
    assert run("thimble:orientation", "Bash", command='echo "thimble:check"', run_in_background=True) == ""
    assert "Monitor" in checks.definition(CORPUS)["disallowedTools"]


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
    assert any(m == "mcp__plugin_thimble_thimble__.*|mcp__thimble-[a-z-]+__.*" and c.endswith("--caller")
               for m, c in commands("PreToolUse")), "the caller hook runs on main's shim's tools and an agent's own shim's"
    assert any(c.endswith("--denied") for _, c in commands("PermissionDenied"))
    assert any(c.endswith("--end") for _, c in commands("SessionEnd"))
    assert [e["hooks"][0]["timeout"] for e in hooks["SessionEnd"]] == [5]
    # 0.9.0: --rekey runs before the guide is printed again, in one command, since Claude Code runs the hooks of one
    # event at once
    assert any({"clear", "resume"} <= set(m.split("|")) and '.thimble-watch" --rekey;' in c for m, c in commands("SessionStart"))


def test_no_hook_guards_forks_of_main_any_more():
    """A view proposal is a completion over main's transcript ($.model.fork), not a forked agent, so no PreToolUse hook
    runs on every tool call to guard one."""
    hooks = json.loads((WATCHER.parent.parent / "hooks" / "hooks.json").read_text())["hooks"]
    assert not any("--fork-guard" in h["command"] for e in hooks["PreToolUse"] for h in e["hooks"])
    assert "fork-guard" not in WATCHER.read_text()
