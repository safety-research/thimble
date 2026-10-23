"""The PreToolUse command hook (hooks/temp_allow.py): Read, Grep, a relative Glob and an agent's Write in thimble's temp
folder are allowed without a dialog; anything else gets no answer. All paths are made up under pytest's tmp_path."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HOOKS = Path(__file__).resolve().parents[1] / "hooks"
sys.path.insert(0, str(HOOKS))

import temp_allow as T  # noqa: E402


def setup(tmp_path):
    tmp = tmp_path / "tmp"
    temp = tmp / "thimble"
    temp.mkdir(parents=True)
    temp.chmod(0o700)
    (temp / "rows.json").write_text("[]")
    (tmp / "rows.json").write_text("[]")
    (tmp_path / "secret").write_text("x")
    (temp / "link.json").symlink_to(tmp_path / "secret")
    env = {"TMPDIR": str(tmp), "HOME": str(tmp_path / "home")}
    return temp, env


def ev(tool, agent=None, **inp):
    return {"tool_name": tool, "tool_input": inp, **({"agent_id": agent} if agent else {})}


def test_reads_in_the_temp_folder_only(tmp_path):
    temp, env = setup(tmp_path)
    assert T.verdict(ev("Read", file_path=f"{temp}/rows.json"), env) == "allow"
    assert T.verdict(ev("Grep", path=str(temp), pattern="x"), env) == "allow"
    assert T.verdict(ev("Read", file_path=f"{temp.parent}/rows.json"), env) is None
    assert T.verdict(ev("Read", file_path=f"{temp}/link.json"), env) is None
    assert T.verdict(ev("Read", file_path=f"{temp}/../rows.json"), env) is None
    assert T.verdict(ev("Read", file_path="rows.json"), env) is None
    assert T.verdict(ev("Bash", command=f"cat {temp}/rows.json"), env) is None


def test_the_session_tmpdir_is_the_temp_folder(tmp_path):
    temp, env = setup(tmp_path)
    env["TMPDIR"] = str(temp)
    assert T.verdict(ev("Read", file_path=f"{temp}/rows.json"), env) == "allow"


def test_a_folder_other_users_can_open_is_not_the_temp_folder(tmp_path):
    temp, env = setup(tmp_path)
    temp.chmod(0o755)
    assert T.verdict(ev("Read", file_path=f"{temp}/rows.json"), env) is None


def test_writes_by_an_agent_and_globs_with_a_relative_pattern(tmp_path):
    temp, env = setup(tmp_path)
    assert T.verdict(ev("Write", file_path=f"{temp}/new.json", content="[]"), env) is None
    assert T.verdict(ev("Write", agent="a1", file_path=f"{temp}/new.json", content="[]"), env) == "allow"
    assert T.verdict(ev("Write", agent="a1", file_path=f"{temp.parent}/new.json", content="[]"), env) is None
    assert T.verdict(ev("Glob", path=str(temp), pattern="*.json"), env) == "allow"
    assert T.verdict(ev("Glob", path=str(temp), pattern="/elsewhere/**"), env) is None
    assert T.verdict(ev("Glob", path=str(temp), pattern="../*"), env) is None


def test_cards_off(tmp_path):
    temp, env = setup(tmp_path)
    env["CLAUDE_PLUGIN_OPTION_CARDS"] = "false"
    assert T.verdict(ev("Read", file_path=f"{temp}/rows.json"), env) is None


def test_the_command_prints_the_allow(tmp_path):
    temp, env = setup(tmp_path)
    run = lambda e: subprocess.run(["sh", str(HOOKS / "temp-allow.sh")], input=json.dumps(e), capture_output=True, text=True,
                                   env={**env, "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "THIMBLE_PYTHON": sys.executable})
    out = run(ev("Read", file_path=f"{temp}/rows.json"))
    assert out.returncode == 0
    assert json.loads(out.stdout)["hookSpecificOutput"]["permissionDecision"] == "allow"
    out = run(ev("Read", file_path=f"{temp.parent}/rows.json"))
    assert (out.returncode, out.stdout) == (0, "")
    assert run("not an event").stdout == ""
