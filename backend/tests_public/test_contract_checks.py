"""The release test's contract checks against Claude Code (scripts/e2e/contract_print.py and contract_module.py), which
run only with THIMBLE_LIVE_CLAUDE=1: what they read from a run, checked here on records shaped as Claude Code 2.1.291
wrote them, so a check that reads the wrong field fails here rather than passing or failing for the wrong reason live."""
from __future__ import annotations

import importlib.util
import json
import secrets
import sys
import urllib.request
from pathlib import Path

from app import config, hook_auth

E2E = Path(__file__).resolve().parents[2] / "scripts" / "e2e"
LIMIT_TEXT = ("Concurrent subagent limit reached. You can run 1 subagents at once. Do not retry. If the user wants more "
              "concurrent subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.")


def _load(name: str):
    sys.path.insert(0, str(E2E))
    spec = importlib.util.spec_from_file_location(name, E2E / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cp = _load("contract_print")
cm = _load("contract_module")
FMT = cp.formats(config.REPO_ROOT)


def _ev(event: str, **fields) -> dict:
    base = {"session_id": "s", "transcript_path": "/t/s.jsonl", "prompt_id": "p", "permission_mode": "auto",
            "hook_event_name": event}
    return {**base, **fields}


def _events(child_shape=("stop", "handback", "stop*")) -> list[dict]:
    out = [_ev("PreToolUse", tool_name="Agent", tool_use_id="toolu_main", tool_input={"subagent_type": cp.PARENT}),
           _ev("SubagentStart", agent_id="P", agent_type=cp.PARENT),
           _ev("PreToolUse", agent_id="P", agent_type=cp.PARENT, tool_name="mcp__contract__probe", tool_use_id="toolu_mcp",
               tool_input={"text": "parent"}),
           _ev("SubagentStart", agent_id="C", agent_type=cp.CHILD)]
    for step in child_shape:
        if step == "handback":
            out.append(_ev("PreToolUse", agent_id="C", agent_type=cp.CHILD, tool_name=cp.HANDBACK, tool_use_id="toolu_hb",
                           tool_input={"message": cp.CHILD_DONE}))
        else:
            stop = _ev("SubagentStop", agent_id="C", agent_type=cp.CHILD, stop_hook_active=step == "stop*",
                       agent_transcript_path="/t/s/subagents/agent-C.jsonl")
            if step == "stop":
                stop["last_assistant_message"] = cp.CHILD_DONE
            out.append(stop)
    return out


def _child_rows(enforce=True) -> list[dict]:
    rows = [{"type": "assistant", "message": {"content": [{"type": "text", "text": cp.CHILD_DONE}]}}]
    if enforce:
        rows.append({"type": "user", "isMeta": True, "message": {"content": "[handback-send-enforce] Your report has not "
                                                                            "been delivered. Call SubagentHandback now"}})
    rows.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_hb", "name": cp.HANDBACK,
                                                               "input": {"message": cp.CHILD_DONE}}]}})
    return rows


def test_the_matchers_come_from_thimble_s_own_code():
    assert FMT["meta_key"] == "claudecode/toolUseId"
    assert FMT["module_limit"].search(LIMIT_TEXT) and all(w in LIMIT_TEXT.lower() for w in FMT["limit_words"])
    assert FMT["plugin_call"] == "toolu_plugin_" and FMT["handback_lead"] == "[Subagent hand-back]"
    ok, detail = cp.check_limit_text([LIMIT_TEXT], FMT)
    assert ok, detail
    assert not cp.check_limit_text(["Agent type 'x' not found"], FMT)[0]
    assert not cp.check_limit_text([], FMT)[0]


def test_hook_fields_pass_on_claude_code_s_shapes_and_name_a_missing_one():
    ok, detail = cp.check_hook_fields(_events())
    assert ok, detail
    events = _events()
    del events[1]["agent_type"]
    ok, detail = cp.check_hook_fields(events)
    assert not ok and "SubagentStart.agent_type" in detail
    events = _events()
    events[0]["agent_id"] = "P"  # main's own call carrying an agent id
    assert "main's PreToolUse" in cp.check_hook_fields(events)[1]


def test_the_two_stop_shape_needs_the_nudge_and_the_report_in_the_hand_back():
    assert cp.check_two_stops(_events(), {"C": _child_rows()}, "C")[0]
    assert not cp.check_two_stops(_events(("handback", "stop")), {"C": _child_rows()}, "C")[0]  # it handed back itself
    assert not cp.check_two_stops(_events(), {"C": _child_rows(enforce=False)}, "C")[0]
    assert not cp.check_two_stops(_events(), {"C": _child_rows()}, "")[0]


def test_a_format_run_is_made_again_only_when_the_child_did_not_end_with_text():
    assert cp.plain_ending(_events())
    assert not cp.plain_ending(_events(("handback", "stop")))
    assert not cp.plain_ending(_events(())[:2])


def test_nested_meta_names_the_parent():
    assert cp.check_nested_meta({"C": {"parentAgentId": "P", "agentType": cp.CHILD, "spawnDepth": 2}}, "P", "C")[0]
    assert not cp.check_nested_meta({"C": {"agentType": cp.CHILD}}, "P", "C")[0]


def _main_rows(second_note=True) -> list[dict]:
    lead = FMT["handback_lead"]
    rows = [
        {"type": "user", "origin": {"kind": "peer", "from": "P", "handback": True},
         "message": {"content": f'<agent-message from="P">\n{lead} The report follows:\n  PARENT-DONE CHILD-OK\n</agent-message>'}},
        {"type": "user", "origin": {"kind": "task-notification", "producer": "session-task"},
         "message": {"content": "<task-notification>\n<task-id>P</task-id>\n<tool-use-id>toolu_main</tool-use-id>\n"
                                "<status>completed</status>\n<summary>Agent \"contract parent\" finished</summary>\n"
                                "<result>delivered as a message</result>\n</task-notification>"}},
    ]
    if second_note:  # a later run's notification has no tool-use-id (spike U10)
        rows.append({"type": "user", "origin": {"kind": "task-notification"},
                     "message": {"content": "<task-notification>\n<task-id>P</task-id>\n<status>completed</status>\n"
                                            "<summary>finished</summary>\n<result>r</result>\n</task-notification>"}})
    return rows


def test_the_notification_reads_as_the_mirror_reads_it():
    ok, detail = cp.check_notification(_main_rows(), "P", "toolu_main", FMT)
    assert ok, detail
    assert not cp.check_notification(_main_rows(), "P", "toolu_other", FMT)[0]
    rows = _main_rows()[1:]  # no hand-back row
    assert not cp.check_notification(rows, "P", "toolu_main", FMT)[0]


def test_the_mcp_meta_id_must_be_the_hook_s_tool_use_id():
    mcp = [{"params": {"name": "probe", "_meta": {"claudecode/toolUseId": "toolu_mcp", "progressToken": 2}}}]
    assert cp.check_mcp_meta(mcp, _events(), FMT)[0]
    assert not cp.check_mcp_meta([{"params": {"_meta": {"claudecode/toolUseId": "toolu_x"}}}], _events(), FMT)[0]
    assert not cp.check_mcp_meta([{"params": {"_meta": {}}}], _events(), FMT)[0]


def test_the_result_line_checks_read_the_last_result():
    msgs = [(1.0, {"type": "result", "subagent_stats": {"max_depth": 1}}),
            (2.0, {"type": "result", "modelUsage": {"m[1m]": {"contextWindow": 1_000_000}},
                   "subagent_stats": {"max_depth": 2, "refused": {"concurrency_limit": 0}}})]
    held = [(28.3, {"type": "result", "num_turns": 1}), (51.9, {"type": "result", "num_turns": 0})]  # V3's held run
    assert cp.answer_at(held) == 28.3 and cp.answer_at([(5.0, {"type": "result"})]) == 5.0
    t, last = cp.last_result(msgs)
    assert t == 2.0 and cp.check_context_window(last, "m[1m]")[0]
    assert not cp.check_context_window({"modelUsage": {"m[1m]": {"contextWindow": 200_000}}}, "m[1m]")[0]
    cap = {"subagent_stats": {"refused": {"concurrency_limit": 1}}}
    assert cp.check_subagent_stats(last, cap)[0]
    assert not cp.check_subagent_stats({"subagent_stats": {"max_depth": 1}}, cap)[0]
    refused = [(0.0, {"type": "user", "message": {"content": [{"type": "tool_result", "is_error": True,
                                                               "content": f"Error: {LIMIT_TEXT}"}]}})]
    assert cp.limit_texts(refused) == [f"Error: {LIMIT_TEXT}"]


def test_the_module_must_stay_idle_and_the_run_end_quickly():
    inits = [{"agents": ["general-purpose", "contract-parent"], "plugins": [{"name": "thimble", "path": "/x"}]}]
    assert cp.check_module_idle(inits, [{"path": "/api/events?cwd=x"}, {"path": "/api/events/mode"}])[0]
    assert not cp.check_module_idle(inits, [{"path": "/api/module/hello"}])[0]
    assert not cp.check_module_idle(inits, [{"path": "/api/events/pull?session=s"}])[0]
    assert not cp.check_module_idle([{**inits[0], "agents": ["thimble:contract-probe"]}], [])[0]
    assert not cp.check_module_idle([{"agents": [], "plugins": []}], [])[0]  # the plugin did not load
    assert cp.check_ends({"a": {"returncode": 0, "t_result": 30.0, "t_exit": 30.6}})[0]
    assert not cp.check_ends({"a": {"returncode": 0, "t_result": 30.0, "t_exit": 51.5}})[0]
    assert not cp.check_ends({"a": {"returncode": 0, "t_result": None, "t_exit": 3.0}})[0]


def test_the_stand_in_server_proves_the_token_as_thimble_s_hooks_expect(tmp_path):
    stub = cp.Stub(tmp_path / "home", _free_port(), tmp_path / "requests.jsonl")
    try:
        st = json.loads((tmp_path / "home" / "server.json").read_text())
        nonce = secrets.token_hex(8)
        req = urllib.request.Request(f"{st['api']}/api/module/hello", data=b"{}", method="POST",
                                     headers=hook_auth.headers(st["token"], nonce))
        with urllib.request.urlopen(req, timeout=5) as r:
            assert r.headers["x-thimble-proof"] == hook_auth.sign(st["token"], "server", nonce)
            assert json.loads(r.read())["ok"] is True
        assert [x["path"] for x in stub.requests] == ["/api/module/hello"]
    finally:
        stub.close()


def _free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_other_thimble_copies_are_turned_off_for_the_runs():
    settings = json.loads(cp.settings("log", ["thimble@thimble-local"]))
    assert settings["ultracode"] is False and settings["enabledPlugins"] == {"thimble@thimble-local": False}
    assert set(settings["hooks"]) == {"PreToolUse", "SubagentStart", "SubagentStop"}
    env = cp.run_env({"CLAUDECODE": "1", "CLAUDE_CODE_EFFORT_LEVEL": "high", "THIMBLE_DEV": "1", "HOME": "/h"},
                     Path("/home"), 21240)
    assert "CLAUDECODE" not in env and "CLAUDE_CODE_EFFORT_LEVEL" not in env and "THIMBLE_DEV" not in env
    assert env["THIMBLE_LAUNCHED"] == "1" and env["THIMBLE_PORT"] == "21240" and env["HOME"] == "/h"


# --------------------------------------------------------------------------------------------- the module check

def _at(s: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(s, timezone.utc).isoformat()


def test_the_first_listing_must_hold_every_type_and_no_terminal_line():
    rows = [{"type": "attachment", "attachment": {"type": "agent_listing_delta", "isInitial": True,
                                                  "addedTypes": ["Explore", "thimble:writer", "thimble:helper"]}},
            {"type": "attachment", "attachment": {"type": "agent_listing_delta", "isInitial": False,
                                                  "addedTypes": ["thimble:critic"]}}]
    listing = cm.first_listing(rows)
    ok, detail = cm.check_listing(listing, ["thimble:writer", "thimble:helper"], ["writer", "check"], "")
    assert ok and "thimble:check" in detail  # a role subagents.TYPES lacks is named, not required
    assert not cm.check_listing(listing, ["thimble:writer", "thimble:critic"], [], "")[0]
    assert not cm.check_listing(listing, ["thimble:writer"], [], "⎿  4 agent types available")[0]
    assert not cm.check_listing(None, ["thimble:writer"], [], "")[0]


def test_values_are_read_from_each_request_of_the_transcript():
    rows = [{"type": "assistant", "timestamp": _at(100), "effort": "low", "message": {"model": "claude-sonnet-5"}},
            {"type": "assistant", "timestamp": _at(200), "effort": "medium", "message": {"model": "claude-sonnet-5"}}]
    assert not cm.on_values(rows, "claude-sonnet-5", "low")[0]
    assert cm.on_values(rows, "claude-sonnet-5", "low", after=0)[1].startswith("2 requests")
    assert cm.on_values(rows, "claude-sonnet-5", "medium", after=150)[0]
    assert cm.on_values([{"type": "assistant", "timestamp": _at(1), "message": {"model": "claude-haiku-4-5"}}],
                        "claude-haiku-4-5", None)[0]  # a model with no effort
    assert not cm.on_values([], "m", "low")[0]


def test_a_hand_back_counts_once_it_is_the_last_call_and_answered():
    call = {"type": "assistant", "timestamp": _at(50), "message": {"content": [
        {"type": "tool_use", "id": "t1", "name": cm.HANDBACK, "input": {"message": "SPAWN-OK"}}]}}
    result = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1"}]}}
    assert cm.handed_back([call]) is None
    assert cm.handed_back([call, result]) == "SPAWN-OK"
    assert cm.last_handback_at([call, result]) == 50
    later = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t2", "name": "Bash", "input": {}}]}}
    assert cm.handed_back([call, result, later]) is None


def test_what_main_got_for_an_agent():
    rows = [{"type": "user", "timestamp": _at(10), "origin": {"kind": "peer", "from": "a1", "handback": True},
             "message": {"content": "hand-back"}},
            {"type": "user", "timestamp": _at(11), "origin": {"kind": "task-notification"},
             "message": {"content": "<task-notification><task-id>a1</task-id><status>killed</status></task-notification>"}},
            {"type": "user", "timestamp": _at(12), "origin": {"kind": "task-notification"},
             "message": {"content": "<task-notification><task-id>bwatch</task-id><thimble-event/></task-notification>"}},
            {"type": "assistant", "timestamp": _at(13), "message": {"content": [
                {"type": "tool_use", "name": "TaskStop", "input": {"task_id": "a1"}}]}}]
    got = cm.main_rows_from(rows, "a1")
    assert [len(got[k]) for k in ("handbacks", "notifications", "calls")] == [1, 1, 1]
    assert not any(cm.main_rows_from(rows, "a1", after=14).values())
    assert cm.answered_after(rows, 12) and not cm.answered_after(rows, 13)


def test_the_classifier_smoke_reads_the_flags_and_the_blanked_variable():
    want = {"model": "claude-opus-5-5", "effort": "low"}
    calls = [{"argv": ["--model", "claude-opus-5-5", "--effort", "low", "--settings", "{}"], "effort_env": ""}]
    assert cm.check_classifier(calls, want, "ok")[0]
    assert not cm.check_classifier([{**calls[0], "effort_env": "high"}], want, "ok")[0]
    assert not cm.check_classifier([{"argv": ["--model", "claude-opus-5-5"], "effort_env": ""}], want, "ok")[0]
    assert not cm.check_classifier([], want, "error")[0]
    assert cm.flag_value(["--effort=high"], "--effort") == "high"


def test_menus_are_answered_with_the_cursor_nearest_the_choice():
    trust = (" Accessing workspace:\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n")
    assert cm.menu_moves(trust, cm.NO_TRUST) == 0
    exit_dialog = ("❯ /exit\n\n Background tasks are still running.\n ❯ 1. Stay\n   2. Exit and stop tasks\n")
    assert cm.menu_moves(exit_dialog, cm.EXIT_CHOICE) == 1  # not the prompt's ❯ above the menu
    assert cm.menu_moves("❯ hello\n", cm.EXIT_CHOICE) is None
    term = cm.Terminal("never-started", {})
    try:
        term.keys("Left")
    except ValueError:
        pass
    else:
        raise AssertionError("← was sent")
