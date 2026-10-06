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

from app import config
from app import subagent_files as sf

WATCHER = Path(__file__).resolve().parents[2] / "plugin" / "bin" / ".thimble-watch"
CORPUS = "mini"
MAIN_SID = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
PLUGIN_CALL = "toolu_plugin_105f7e7c43f642eea2b10a326d1a43c4"
AGENT = "abd7be4046c88858c"


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


def test_a_typed_start_claims_its_request_and_a_different_one_is_denied():
    state: dict = {}
    pending_start(state, "req_0000000001", "typed", "req_0000000001\nthe request")
    assert sf.check_call(state, agent_call("req_0000000001\nanother request")) is not None
    assert sf.requests(state)["req_0000000001"]["state"] == "pending"
    assert sf.check_call(state, agent_call("req_0000000001\nthe request")) is None
    r = sf.requests(state)["req_0000000001"]
    assert r["state"] == "claimed" and r["claimed_by"] == "toolu_01main"
    assert sf.check_call(state, agent_call("req_0000000001\nthe request", call="toolu_02")) is not None, \
        "a second identical call finds no pending request"


def test_a_missing_run_in_background_counts_as_background_and_false_is_denied():
    state: dict = {}
    pending_start(state, "req_0000000002", "typed", "p")
    assert sf.check_call(state, agent_call("p", run_in_background=False)) is not None
    assert sf.check_call(state, agent_call("p")) is None


def test_a_plugin_start_matches_only_a_click_or_follow_on_and_main_only_a_typed_one():
    state: dict = {}
    pending_start(state, "req_click00001", "click", "click prompt")
    assert sf.check_call(state, agent_call("click prompt")) is not None, "main's own call cannot claim a click"
    assert sf.check_call(state, agent_call("click prompt", call=PLUGIN_CALL)) is None
    pending_start(state, "req_typed00001", "typed", "typed prompt")
    assert sf.check_call(state, agent_call("typed prompt", call="toolu_plugin_ff")) is not None, \
        "a plugin start cannot claim a typed request"


def test_an_expired_click_is_never_claimed_by_a_late_spawn():
    state: dict = {}
    pending_start(state, "req_click00002", "click", "late")
    sf.requests(state)["req_click00002"]["state"] = "expired"
    assert sf.check_call(state, agent_call("late", call=PLUGIN_CALL)) is not None


def test_plan_mode_and_a_second_orientation_and_a_call_with_no_request_are_denied():
    state: dict = {}
    pending_start(state, "req_0000000003", "typed", "p")
    assert sf.check_call(state, {**agent_call("p"), "permission_mode": "plan"}) is not None
    assert sf.requests(state)["req_0000000003"]["state"] == "pending"
    assert sf.check_call(state, agent_call("nothing asked for this")) is not None
    sf.registry(state)["a1"] = {"role": "orientation", "key": "orient", "status": "running"}
    assert sf.check_call(state, agent_call("p")) is not None, "an orientation already runs"


def test_a_second_writer_of_a_document_is_denied():
    state: dict = {}
    sf.registry(state)["w1"] = {"role": "writer", "key": "writer:report", "status": "running"}
    pending_start(state, "req_0000000004", "typed", "req_0000000004\nwrite", role="writer", key="writer:report")
    assert sf.check_call(state, agent_call("req_0000000004\nwrite", role="writer")) is not None


def test_a_helper_or_any_other_type_goes_from_any_agent_and_a_subagent_s_call_is_a_nested_start():
    state: dict = {}
    sf.registry(state)["orient1"] = {"role": "orientation", "key": "orient", "status": "running"}
    call = {**agent_call("look", call="toolu_n1", caller="orient1"), "tool_input": {
        "subagent_type": "thimble:helper", "description": "survey", "prompt": "look"}}
    assert sf.check_call(state, call) is None
    assert state["nested"][-1]["caller"] == "orient1" and state["nested"][-1]["subagent_type"] == "thimble:helper"
    general = {**call, "tool_input": {"subagent_type": "general-purpose", "description": "d", "prompt": "q"}}
    assert sf.check_call(state, general) is None


def test_the_critic_s_start_is_the_orientation_s_own_call():
    state: dict = {}
    sf.registry(state)["orient1"] = {"role": "orientation", "key": "orient", "status": "running"}
    pending_start(state, "req_critic0001", "typed", "critique", role="critic", key="critique:orient",
                  caller_role="orientation")
    assert sf.check_call(state, agent_call("critique", role="critic")) is not None, "main cannot start the critic"
    assert sf.check_call(state, agent_call("critique", call="toolu_c1", caller="orient1", role="critic")) is None
    assert sf.requests(state)["req_critic0001"]["caller"] == "orient1"


def test_a_send_message_needs_its_pending_message_request_and_a_second_copy_is_denied():
    state: dict = {}
    sf.registry(state)[AGENT] = {"role": "orientation", "key": "orient", "status": "done"}
    send = {"hook_event_name": "PreToolUse", "tool_name": "SendMessage", "tool_use_id": "toolu_s1",
            "tool_input": {"to": AGENT, "summary": "follow-up", "message": "and April?"}}
    assert sf.check_call(state, send) is not None, "nobody asked for it (U10)"
    sf.requests(state)["req_msg0000001"] = {"kind": "message", "route": "typed", "agent": AGENT, "state": "pending",
                                            "input": {"to": AGENT, "message": "and April?"}}
    assert sf.check_call(state, send) is None
    assert sf.check_call(state, {**send, "tool_use_id": "toolu_s2"}) is not None, "the same message twice (U5)"
    other = {**send, "tool_input": {"to": "someone-else", "message": "hi"}}
    assert sf.check_call(state, other) is None, "a message to an agent that is not thimble's is no business of it"


def test_the_module_s_send_message_claims_a_click_follow_up():
    state: dict = {}
    sf.registry(state)[AGENT] = {"role": "orientation", "key": "orient", "status": "done"}
    sf.requests(state)["req_msg0000002"] = {"kind": "message", "route": "click", "agent": AGENT, "state": "pending",
                                            "input": {"to": AGENT, "message": "Task F1"}}
    send = {"hook_event_name": "PreToolUse", "tool_name": "SendMessage", "tool_use_id": "toolu_plugin_620ec965e874",
            "tool_input": {"to": AGENT, "summary": "follow-up F1", "message": "Task F1"}}
    assert sf.check_call(state, send) is None
    assert sf.requests(state)["req_msg0000002"]["state"] == "claimed"


def test_subagent_start_takes_up_the_claimed_request_and_marks_a_plugin_start_by_its_id():
    state: dict = {}
    pending_start(state, "req_click00003", "click", "click prompt", work="/w/orient/work")
    sf.check_call(state, agent_call("click prompt", call=PLUGIN_CALL))
    entry = sf.register(state, {"hook_event_name": "SubagentStart", "session_id": MAIN_SID, "agent_id": AGENT,
                                "agent_type": "thimble:orientation"})
    assert entry["key"] == "orient" and entry["plugin_started"] is True and entry["request"] == "req_click00003"
    assert entry["sessions"] == [MAIN_SID] and entry["work"] == "/w/orient/work"
    assert sf.requests(state)["req_click00003"]["state"] == "started"
    assert AGENT not in sf.efforts(state), "a click registers the role; the step hook needs no effort"


def test_a_typed_start_s_agent_gets_its_effort_and_main_s_pluginsteered_never_marks_it():
    state: dict = {}
    pending_start(state, "req_typed00002", "typed", "typed")
    sf.check_call(state, agent_call("typed", call="toolu_01typed"))
    entry = sf.register(state, {"agent_id": "a2", "agent_type": "thimble:orientation", "session_id": MAIN_SID,
                                "pluginSteered": True})
    assert entry["plugin_started"] is False
    assert sf.efforts(state)["a2"] == "max"


def test_a_descendant_registers_under_its_parent_and_takes_its_effort_unless_it_is_a_role():
    state: dict = {}
    sf.registry(state)["o1"] = {"role": "orientation", "key": "orient", "status": "running", "work": "/w/o"}
    sf.efforts(state)["o1"] = "max"
    sf.check_call(state, {**agent_call("x", call="toolu_h1", caller="o1"),
                          "tool_input": {"subagent_type": "general-purpose", "description": "d", "prompt": "x"}})
    child = sf.register(state, {"agent_id": "c1", "agent_type": "general-purpose", "session_id": MAIN_SID})
    assert child["parent"] == "o1" and child["root"] == "o1" and child["work"] == "/w/o"
    assert sf.efforts(state)["c1"] == "max", "a typed run's general-purpose child runs at the run's effort (V7d)"
    grandchild_call = {**agent_call("y", call="toolu_h2", caller="c1"),
                       "tool_input": {"subagent_type": "Explore", "description": "d", "prompt": "y"}}
    sf.check_call(state, grandchild_call)
    grandchild = sf.register(state, {"agent_id": "g1", "agent_type": "Explore", "session_id": MAIN_SID})
    assert grandchild["root"] == "o1", "a descendant at depth 3 is still a step of the orientation"
    unknown = sf.register(state, {"agent_id": "u1", "agent_type": "general-purpose", "session_id": MAIN_SID})
    assert unknown is None, "the analyst's own subagent is no business of thimble's"


def test_two_callers_of_one_type_leave_the_parent_to_the_first_call():
    state: dict = {}
    for a in ("o1", "w1"):
        sf.registry(state)[a] = {"role": "orientation" if a == "o1" else "writer", "key": a, "status": "running"}
        sf.check_call(state, {**agent_call("z", call=f"t-{a}", caller=a),
                              "tool_input": {"subagent_type": "general-purpose", "description": "d", "prompt": "z"}})
    child = sf.register(state, {"agent_id": "c9", "agent_type": "general-purpose", "session_id": MAIN_SID})
    assert child["parent"] is None and sorted(child["candidates"]) == ["o1", "w1"]
    sf.resolve_parent(state, "c9", "w1")
    assert sf.registry(state)["c9"]["parent"] == "w1" and sf.registry(state)["c9"]["root"] == "w1"


def test_a_registered_agent_starting_again_records_its_start():
    state: dict = {}
    sf.registry(state)[AGENT] = {"role": "orientation", "key": "orient", "status": "done", "starts": 1,
                                 "sessions": [MAIN_SID]}
    entry = sf.register(state, {"agent_id": AGENT, "agent_type": "thimble:orientation", "session_id": "new-sid"})
    assert entry["starts"] == 2 and entry["sessions"] == [MAIN_SID, "new-sid"]


def test_subagent_stop_ignores_the_second_stop_and_claude_code_s_helpers():
    state: dict = {}
    sf.registry(state)[AGENT] = {"role": "orientation", "status": "running"}
    assert sf.record_stop(state, {"agent_id": AGENT, "agent_type": "thimble:orientation",
                                  "stop_hook_active": True}) is None
    assert sf.record_stop(state, {"agent_id": "a3a68427221931dfe", "agent_type": ""}) is None
    assert sf.record_stop(state, {"agent_id": AGENT, "agent_type": "thimble:orientation"})["turns"] == 1


def test_permission_denied_refuses_the_request_main_s_call_claimed_with_the_reason_as_given():
    state: dict = {}
    pending_start(state, "req_typed00003", "typed", "probe the sandbox")
    sf.check_call(state, agent_call("probe the sandbox", call="toolu_d1"))
    hit = sf.record_denied(state, {"hook_event_name": "PermissionDenied", "tool_name": "Agent", "tool_use_id": "toolu_d1",
                                   "tool_input": {"subagent_type": "thimble:orientation", "prompt": "probe the sandbox"},
                                   "reason": "[Credential Exploration]"})
    assert hit is not None and hit[0] == "req_typed00003"
    r = sf.requests(state)["req_typed00003"]
    assert r["state"] == "refused" and r["refused_kind"] == "auto-mode" and r["reason"] == "[Credential Exploration]"
    assert sf.record_denied(state, {"tool_name": "Bash", "tool_input": {"command": "ls"}, "reason": "x"}) is None


def test_rekey_moves_the_running_agents_and_names_the_new_session():
    state: dict = {}
    sf.registry(state)["r1"] = {"role": "orientation", "status": "running", "sessions": ["old"]}
    sf.registry(state)["d1"] = {"role": "writer", "status": "done", "sessions": ["old"]}
    assert sf.rekey(state, "old", "new") == ["r1"]
    assert sf.registry(state)["r1"]["sessions"] == ["old", "new"] and state["main"]["session"] == "new"
    assert sf.registry(state)["d1"]["sessions"] == ["old"]
    assert state["module"]["rekeyed"] == {"old": "new"}, "where module_bridge reads the moves it accepts a hello from"
    sf.rekey(state, "new", "old")
    assert state["module"]["rekeyed"] == {"new": "old"}, "a move back ends the chain"


def test_the_state_file_is_replaced_whole_under_its_lock(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    sf.ensure(ws)
    assert sorted(p.name for p in ws.iterdir()) == sorted(sf.FILES)
    with sf.update(ws) as state:
        state["agents"] = {"a": {"status": "running"}}
    inode = (ws / sf.STATE).stat().st_ino
    with sf.update(ws) as state:
        state["agents"]["a"]["status"] = "done"
    assert sf.read(ws)["agents"]["a"]["status"] == "done"
    assert (ws / sf.STATE).stat().st_ino != inode, "a write renames a new file over the old one"
    with sf.update(ws) as state:
        pass
    assert not [p for p in ws.iterdir() if p.name.endswith(".tmp")]


def test_callers_are_found_by_their_call_and_trimmed_to_the_last_hour(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    sf.add_caller(ws, "toolu_x1", "a1", "thimble:orientation")
    assert sf.find_caller(ws, "toolu_x1")["agent_id"] == "a1"
    assert sf.find_caller(ws, "toolu_none") is None
    old = json.dumps({"tool_use_id": "toolu_old", "agent_id": "a0", "agent_type": "t", "ts": time.time() - 7200})
    (ws / sf.CALLERS).write_text(old + "\n" + (ws / sf.CALLERS).read_text())
    sf.trim_callers(ws)
    assert sf.find_caller(ws, "toolu_old") is None and sf.find_caller(ws, "toolu_x1") is not None


# --------------------------------------------------------------------------- the hooks, run as Claude Code runs them


def run_hook(tmp_path: Path, flag: str, stdin: dict) -> subprocess.CompletedProcess:
    """The watcher run with `flag` and the hook input `stdin`, as main's hooks run it: in the corpus folder, with no
    server recorded in its thimble home."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "THIMBLE_SESSION"))}
    env.update(THIMBLE_HOME=str(tmp_path / "hook-home"), THIMBLE_WORKSPACES_DIR=str(config.WORKSPACES_DIR),
               THIMBLE_DATA_DIR=str(config.DATA_DIR), CLAUDE_PROJECT_DIR=str(config.corpus_dir(CORPUS)))
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


def test_without_a_server_each_new_hook_writes_its_record(tmp_path, ws):
    with sf.update(ws) as state:
        pending_start(state, "req_hook000002", "typed", "typed", work=str(ws / "orient" / "work"))
    run_hook(tmp_path, "--agent-check", agent_call("typed", call="toolu_01t"))
    start = run_hook(tmp_path, "--subagent-start", {"hook_event_name": "SubagentStart", "session_id": MAIN_SID,
                                                    "agent_id": AGENT, "agent_type": "thimble:orientation"})
    assert start.returncode == 0
    reg = sf.read(ws)["agents"]
    assert reg[AGENT]["key"] == "orient" and reg[AGENT]["status"] == "running"
    run_hook(tmp_path, "--caller", {"hook_event_name": "PreToolUse", "session_id": MAIN_SID, "agent_id": AGENT,
                                    "agent_type": "thimble:orientation",
                                    "tool_name": "mcp__plugin_thimble_thimble__add_card", "tool_use_id": "toolu_card1"})
    assert sf.find_caller(ws, "toolu_card1")["agent_id"] == AGENT
    run_hook(tmp_path, "--subagent-stop", {"hook_event_name": "SubagentStop", "agent_id": AGENT,
                                           "agent_type": "thimble:orientation"})
    assert sf.read(ws)["agents"][AGENT]["turns"] == 1
    run_hook(tmp_path, "--end", {"hook_event_name": "SessionEnd", "session_id": MAIN_SID, "reason": "clear"})
    assert sf.read(ws)["main_end"]["reason"] == "clear"
    run_hook(tmp_path, "--rekey", {"hook_event_name": "SessionStart", "session_id": "new-sid", "source": "clear"})
    assert sf.read(ws)["agents"][AGENT]["sessions"] == [MAIN_SID, "new-sid"]


def test_a_descendant_gets_its_scratch_folder_in_its_ancestor_s_work_folder(tmp_path, ws):
    work = ws / "orient" / "work"
    with sf.update(ws) as state:
        sf.registry(state)["o1"] = {"role": "orientation", "key": "orient", "status": "running", "work": str(work)}
    run_hook(tmp_path, "--agent-check", {**agent_call("x", call="toolu_h9", caller="o1"),
                                         "tool_input": {"subagent_type": "thimble:helper", "description": "d",
                                                        "prompt": "x"}})
    out = run_hook(tmp_path, "--subagent-start", {"hook_event_name": "SubagentStart", "session_id": MAIN_SID,
                                                  "agent_id": "h1", "agent_type": "thimble:helper"})
    assert (work / "tmp_h1").is_dir()
    if out.stdout.strip():  # the line is prompts/tools.md's `## session-scratch`
        assert str(work / "tmp_h1") in json.loads(out.stdout)["hookSpecificOutput"]["additionalContext"]


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

    def waker(parent: subprocess.Popen) -> float:
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
        env.update(THIMBLE_HOME=str(home), CLAUDE_PID=str(parent.pid))
        t0 = time.monotonic()
        try:
            subprocess.run([str(WATCHER)], input=json.dumps({"session_id": "s1", "hook_event_name": "SessionStart"}),
                           capture_output=True, text=True, env=env, timeout=4)
        except subprocess.TimeoutExpired:
            return 99.0
        return time.monotonic() - t0

    printing = subprocess.Popen([*sleeper, "-p"])  # stands in for `claude -p`: an argv with -p
    interactive = subprocess.Popen(sleeper)
    try:
        assert waker(printing) < 3
        assert waker(interactive) == 99.0, "an interactive session's waker waits for the server's event"
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
    assert any(m == "clear|resume" and c.endswith("--rekey") for m, c in commands("SessionStart"))


def test_a_write_waits_for_the_lock_module_bridge_takes(tmp_path):
    """subagents.json.lock is the lock lane M's module_bridge takes before it writes the module's record, so a hook's
    write and the bridge's never interleave."""
    import fcntl
    import threading

    ws = tmp_path / "ws"
    ws.mkdir()
    sf.ensure(ws)
    assert (ws / sf.LOCK).is_file()
    fd = os.open(ws / sf.LOCK, os.O_RDWR)
    fcntl.flock(fd, fcntl.LOCK_EX)
    threading.Timer(0.3, lambda: os.close(fd)).start()
    t0 = time.monotonic()
    with sf.update(ws) as state:
        state["module"] = {"session": "s"}
    assert time.monotonic() - t0 >= 0.25 and sf.read(ws)["module"] == {"session": "s"}
