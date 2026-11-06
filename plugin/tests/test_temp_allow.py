"""The PreToolUse command hook (hooks/temp_allow.py): Read and Grep in thimble's temp folder, which only this user may
open, are allowed without a dialog; a path out of it, a link out of it, a shell command and a folder other users can
open get no answer. All paths are made up under pytest's tmp_path."""
from __future__ import annotations

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


def ev(tool, **inp):
    return {"tool_name": tool, "tool_input": inp}


def test_reads_in_the_temp_folder_only(tmp_path):
    temp, env = setup(tmp_path)
    assert T.verdict(ev("Read", file_path=f"{temp}/rows.json"), env) == "allow"
    assert T.verdict(ev("Grep", path=str(temp), pattern="x"), env) == "allow"
    assert T.verdict(ev("Read", file_path=f"{temp.parent}/rows.json"), env) is None
    assert T.verdict(ev("Read", file_path=f"{temp}/link.json"), env) is None
    assert T.verdict(ev("Read", file_path=f"{temp}/../rows.json"), env) is None
    assert T.verdict(ev("Read", file_path="rows.json"), env) is None
    assert T.verdict(ev("Bash", command=f"cat {temp}/rows.json"), env) is None
    # a folder other users can open is not thimble's temp folder
    temp.chmod(0o755)
    assert T.verdict(ev("Read", file_path=f"{temp}/rows.json"), env) is None
