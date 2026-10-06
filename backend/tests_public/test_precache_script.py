"""scripts/dev/precache_orientation.py drives an interactive main, since the module does nothing in `claude -p` (V3): the
launcher in a tmux server of its own with the agent view off, the module's hello read from subagents.json, Start sent
with the page's cookie, and the quit's "Exit and stop tasks" reached with the cursor alone."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "dev" / "precache_orientation.py"


def _script():
    spec = importlib.util.spec_from_file_location("precache_orientation", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_it_launches_main_interactively_with_the_agent_view_off_and_the_caller_s_home(tmp_path):
    pc = _script()
    cmd = pc.launch_command(Path("/t"), "auto", {"THIMBLE_HOME": "/s/home", "THIMBLE_PORT": "21141", "HOME": "/h"})
    assert cmd.startswith("env CLAUDE_CODE_DISABLE_AGENT_VIEW=1 DISABLE_AUTOUPDATER=1 THIMBLE_HOME=/s/home")
    assert cmd.endswith("/t/plugin/bin/thimble --permission-mode auto") and " -p" not in cmd and "HOME=/h" not in cmd
    assert "orient_session" not in SCRIPT.read_text() and "-L" in SCRIPT.read_text()


def test_it_waits_for_the_module_s_accepted_hello(tmp_path):
    pc = _script()
    assert pc.hello(tmp_path) is None
    (tmp_path / "trusted").mkdir()
    (tmp_path / "trusted" / "subagents.json").write_text(json.dumps({"module": {"session": "s", "idle": "not main", "at": "x"}}))
    assert pc.hello(tmp_path) is None
    (tmp_path / "trusted" / "subagents.json").write_text(json.dumps({"module": {"session": "s", "version": "0.6.0", "at": "x"}}))
    assert pc.hello(tmp_path)["session"] == "s"


def test_start_is_the_gate_s_defaults_and_the_run_s_values_only_when_named():
    pc = _script()
    body = pc.start_body(pc.options(["t", "c", "l"]))
    assert body == {"text": "", "deck": True, "views": True, "report": True, "critique": False}
    named = pc.start_body(pc.options(["t", "c", "l", "--no-report", "--critique", "--model", "opus", "--effort", "max"]))
    assert named["report"] is False and named["critique"] is True and (named["model"], named["effort"]) == ("opus", "max")


def test_the_quit_reaches_exit_and_stop_tasks_with_the_cursor_alone():
    pc = _script()
    screen = ("Tasks are still running.\n"
              "❯ 1. Keep running\n"
              "  2. Exit and stop tasks\n")
    assert pc.menu_moves(screen, pc.EXIT_CHOICE) == 1
    assert pc.menu_moves("  1. Exit and stop tasks\n❯ 2. Cancel\n", pc.EXIT_CHOICE) == -1
    assert pc.menu_moves("> /exit\n", pc.EXIT_CHOICE) is None
