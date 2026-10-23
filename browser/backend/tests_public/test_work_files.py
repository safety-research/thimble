"""app.work_files: when an agent's run ends, its work folder lets go of its subagents' scratch folders and of the large
files nothing uses, and keeps what a card or a document names, the files a named script reads, small files, its
dot-entries and Python environments. While it runs, the agent hears when the folder grows past a budget (the plugin's
watcher, plugin/bin/.thimble-watch). The work folder and the notebook are invented."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from app import agent_session, config, subagents, work_files

WATCHER = Path(__file__).resolve().parents[2] / "plugin" / "bin" / ".thimble-watch"
BUDGET_FILE = ".thimble-budget.json"  # the watcher's BUDGET_FILE

C = "board"
MB = 1024 * 1024


@pytest.fixture(autouse=True)
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    data = tmp_path / "data"
    (data / C).mkdir(parents=True)
    (data / C / "manifest.json").write_text(json.dumps({"name": C}))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    return data / C


def _write(p: Path, size: int = 0, text: str = "") -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as f:
        f.write(text.encode())
        if size:
            f.write(b"x" * size)
    return p


def test_a_large_file_a_report_names_is_kept_and_a_name_without_the_work_folder_is_not_enough(workspaces_tmp):
    ws = config.workspace_dir(C)
    work = ws / "critique" / "chat1" / "work"
    cited = _write(work / "res" / "counts.parquet", 2 * MB)
    same_name = _write(work / "summary.csv", 2 * MB)
    (ws / "investigations" / "main").mkdir(parents=True)
    (ws / "investigations" / "main" / "report.json").write_text(json.dumps(
        {"blocks": [{"text": f"The counts are in {work}/res/counts.parquet."}]}))
    (ws / "notebooks").mkdir()
    (ws / "notebooks" / "n1.json").write_text(json.dumps({"cells": [{"code": "pd.read_csv('summary.csv')"}]}))
    work_files.clear(C, work)
    assert cited.is_file()
    assert not same_name.exists(), "a card that names the file but not the work folder reads another summary.csv"


def test_a_session_hears_once_each_time_its_work_folder_grows_past_another_budget(tmp_path):
    """The hook a fenced session's Bash calls run after (agent_session.scratch_hooks) says nothing under the budget,
    once past it, nothing more until the folder grows past the next whole budget, and again after it shrank and grew."""
    work = tmp_path / "work"
    work.mkdir()
    hooks = agent_session.scratch_hooks(work)["PostToolUse"]
    assert hooks[0]["matcher"] == "Bash" and ".thimble-watch --work-budget" in hooks[0]["hooks"][0]["command"]

    def call(text: str = "{folder} holds {size} of {budget}") -> str:
        state = work / BUDGET_FILE
        if state.is_file():  # as if CHECK_S went by
            state.write_text(json.dumps({**json.loads(state.read_text()), "checked": 0}))
        done = subprocess.run([str(WATCHER), "--work-budget", "--work", str(work), "--budget", str(2 * MB), "--text", text],
                              input=json.dumps({"hook_event_name": "PostToolUse"}), capture_output=True, text=True,
                              timeout=60)
        assert done.returncode == 0, done.stderr
        return json.loads(done.stdout)["hookSpecificOutput"]["additionalContext"] if done.stdout.strip() else ""

    _write(work / "tmp_a1" / "small.pkl", MB)
    assert call() == ""
    _write(work / "tmp_a1" / "extract.pkl", 2 * MB)
    assert call() == f"{work} holds 3 MB of 2 MB"
    assert call() == "", "said once"
    _write(work / "copy.jsonl", 2 * MB)
    assert call(), "past the next budget"
    (work / "copy.jsonl").unlink()
    (work / "tmp_a1" / "extract.pkl").unlink()
    assert call() == ""
    _write(work / "copy.jsonl", 2 * MB)
    assert call(), "grown back"
    state = json.loads((work / BUDGET_FILE).read_text())
    (work / BUDGET_FILE).write_text(json.dumps({**state, "warned": 0}))
    assert call(), "the step is kept in the folder"
    (work / BUDGET_FILE).write_text(json.dumps({**state, "warned": 0, "checked": 9e12}))
    done = subprocess.run([str(WATCHER), "--work-budget", "--work", str(work), "--budget", str(2 * MB), "--text", "x"],
                          input="{}", capture_output=True, text=True, timeout=60)
    assert done.stdout == "", "measured at most every CHECK_S"
