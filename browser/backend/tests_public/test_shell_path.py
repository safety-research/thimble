"""The shell of main and of every agent finds the Python and libraries the cards use first on its PATH, in both engines:
Bash on the Messages API (runtime_tools._bash) and Bash in a Claude Code session (runtime_cc.settings). Main's prompt
sends its working steps, such as a first look at the files, to the shell. Where that shell's python3 was the person's
own, without the cards' libraries, such a step ran only in a card, which put it on the canvas."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from app import config, runtime, runtime_cc, runtime_tools

CORPUS = "mini"


@pytest.fixture()
def space(monkeypatch, workspaces_tmp, data_tmp):
    monkeypatch.setenv("THIMBLE_RUNTIME", "on")
    config.workspace_dir(CORPUS)
    runtime._spaces.clear()
    yield runtime.ensure(CORPUS)
    runtime._spaces.clear()


def test_the_shell_finds_the_cards_python_first_in_both_engines(space, tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    venv = str(Path(sys.prefix) / "bin")
    convs = {"main": space.main, "fork": runtime.Conv(space, "f1", "fork", agent_id="f1"),
             "writer": runtime.Conv(space, "a1", "agent", agent_id="a1", role="writer")}
    for who, conv in convs.items():
        spec = space.spec_of(conv)
        env = runtime_cc.settings(spec, True, tmp_path).get("env") or {}
        assert env.get("PATH", "").split(os.pathsep) == [venv, "/usr/bin", "/bin"], who
        if spec.effort:
            assert env.get("CLAUDE_CODE_EFFORT_LEVEL") == spec.effort, f"{who}: the effort stays beside it"
    assert runtime_tools.shell_path().split(os.pathsep) == [venv, "/usr/bin", "/bin"], "the Messages API's Bash"
