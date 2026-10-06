"""app.work_files: when an agent's run ends, its work folder lets go of its subagents' scratch folders and of the large
files nothing uses, and keeps what a card or a document names, the files a named script reads, small files, its
dot-entries and Python environments. While it runs, the session hears when the folder grows past a budget
(app/work_budget.py). The work folder and the notebook are invented."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import agent_session, config, orient_session, work_budget, work_files

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


def test_a_finished_run_keeps_what_cards_use_and_deletes_the_rest_of_its_large_files(workspaces_tmp):
    ws = config.workspace_dir(C)
    work = orient_session.work_dir(C)
    named = _write(work / "turns_day.csv", 2 * MB)
    script = _write(work / "make_daily.py", text="import pandas as pd\nt = pd.read_pickle('idx/turns_slim.pkl')\n")
    read_by_script = _write(work / "idx" / "turns_slim.pkl", 3 * MB)
    orphan = _write(work / "idx" / "turns.pkl", 5 * MB)
    gone_folder = _write(work / "growth" / "turn_resp.pkl", 2 * MB)
    small = _write(work / "notes.txt", text="what I found so far")
    temp = _write(work / "tmp_a1b2" / "scratch.pkl", 2 * MB)
    venv = _write(work / "env" / "lib" / "big.so", 2 * MB)
    _write(work / "env" / "pyvenv.cfg", text="home = /usr/bin")
    cache = _write(work / ".cache" / "pip" / "wheel.whl", 2 * MB)
    linked = work / "corpus_link.jsonl"
    target = _write(Path(str(workspaces_tmp)) / "elsewhere.jsonl", 2 * MB)
    os.symlink(target, linked)
    code = f'W = "{work}/"\nimport pandas as pd\ndf = pd.read_csv(W + "turns_day.csv")  # from make_daily.py\n'
    (ws / "notebooks").mkdir(exist_ok=True)
    (ws / "notebooks" / "n1.json").write_text(json.dumps({"cells": [{"id": "c1", "code": code}]}))

    freed = work_files.clear(C, work)

    for p in (named, script, read_by_script, small, venv, cache, target):
        assert p.is_file(), p
    assert linked.is_symlink(), "a link is never followed or removed for its target's size"
    for p in (orphan, gone_folder, temp):
        assert not p.exists(), p
    assert not (work / "growth").exists() and not (work / "tmp_a1b2").exists()
    assert freed == {"files": 3, "bytes": 9 * MB}


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


def test_a_run_that_goes_on_keeps_its_extracts_and_a_failed_one_keeps_everything(workspaces_tmp, monkeypatch):
    """Only a run that finished loses its large files. One the analyst stopped, or that a waiting message resumes at
    once, goes on with what it made, so only its subagents' scratch folders go; a failed run is resumed as it left
    its folder."""
    import asyncio  # noqa: PLC0415

    from app import agent_session, orientation  # noqa: PLC0415

    work = orient_session.work_dir(C)
    extract = _write(work / "idx" / "turns.pkl", 2 * MB)
    temp = _write(work / "tmp_x" / "part.pkl", 2 * MB)
    work_files.clear(C, work, extracts=False)
    assert extract.is_file() and not temp.exists()

    asked: list[tuple] = []
    monkeypatch.setattr(work_files, "clear_soon", lambda c, w, extracts=True: asked.append((w, extracts)))
    for status, want in (("done", [(work, True)]), ("stopped", [(work, False)]), ("failed", [])):
        asked.clear()
        work_files.after_run(C, work, status)
        assert asked == want, status

    queue: list = []
    monkeypatch.setattr(orientation, "read_run", lambda c: {"queue": list(queue)})
    monkeypatch.setattr(orientation, "record", lambda c, **kw: None)
    monkeypatch.setattr(orientation, "finished", lambda *a, **kw: None)
    monkeypatch.setattr(orient_session, "_tell_main", lambda *a, **kw: None)
    monkeypatch.setattr(orient_session, "_show_queue", lambda *a: None)
    monkeypatch.setattr(orient_session, "_report", lambda c: None)

    async def unmeasured(c, chat):
        return ""

    monkeypatch.setattr(orient_session, "measure", unmeasured)
    resumed: list = []

    async def resume(c, messages, *a, **kw):
        resumed.append(messages)

    monkeypatch.setattr(orient_session, "resume", resume)

    def run() -> agent_session.Run:
        return agent_session.Run(C, orient_session.KEY, "chat-o", "sid-o", config.corpus_dir(C), orientation.ROLE)

    async def ends(status: str) -> list[tuple]:
        asked.clear()
        ended = run()
        orient_session._ended(ended, status, "")
        if ended.closing is not None:  # a finished first run goes on once its coverage is measured, as the follower waits
            await ended.closing
        await asyncio.sleep(0)
        return list(asked)

    assert asyncio.run(ends("done")) == [(work, True)]
    queue.append({"text": "now the weekends"})
    assert asyncio.run(ends("done")) == [(work, False)] and resumed, "the waiting message resumes the same session"
    assert asyncio.run(ends("stopped")) == [(work, False)]
    assert asyncio.run(ends("failed")) == []


def test_a_file_a_deleted_group_or_a_label_names_is_kept(workspaces_tmp):
    """A card group moved to the trash can be brought back, and a code label's script can read a file the orientation
    made: both count as uses."""
    ws = config.workspace_dir(C)
    work = orient_session.work_dir(C)
    by_trash = _write(work / "turns_day.csv", 2 * MB)
    by_label = _write(work / "staff_ids.json", 2 * MB)
    orphan = _write(work / "turns.pkl", 2 * MB)
    (ws / "notebooks" / "trash").mkdir(parents=True)
    (ws / "notebooks" / "trash" / "n2.json").write_text(json.dumps(
        {"cells": [{"code": f'pd.read_csv("{work}/turns_day.csv")'}]}))
    (ws / "concepts").mkdir(exist_ok=True)
    (ws / "concepts" / "k1.json").write_text(json.dumps(
        {"kind": "code", "spec": f"import json\nSTAFF = set(json.load(open('{work}/staff_ids.json')))\n"}))
    work_files.clear(C, work)
    assert by_trash.is_file() and by_label.is_file() and not orphan.exists()


def test_a_session_hears_once_each_time_its_work_folder_grows_past_another_budget(tmp_path):
    """The hook a fenced session's Bash calls run after (agent_session.scratch_hooks) says nothing under the budget,
    once past it, nothing more until the folder grows past the next whole budget, and again after it shrank and grew."""
    work = tmp_path / "work"
    work.mkdir()
    hooks = agent_session.scratch_hooks(work)["PostToolUse"]
    assert hooks[0]["matcher"] == "Bash" and "work_budget.py" in hooks[0]["hooks"][0]["command"]

    def call() -> str:
        state = work / work_budget.STATE_FILE
        if state.is_file():  # as if CHECK_S went by
            state.write_text(json.dumps({**json.loads(state.read_text()), "checked": 0}))
        done = subprocess.run([sys.executable, "-S", str(Path(work_budget.__file__)), "--work", str(work), "--budget",
                               str(2 * MB), "--text", "{folder} holds {size} of {budget}"],
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
    state = json.loads((work / work_budget.STATE_FILE).read_text())
    (work / work_budget.STATE_FILE).write_text(json.dumps({**state, "warned": 0}))
    assert call(), "the step is kept in the folder"
    (work / work_budget.STATE_FILE).write_text(json.dumps({**state, "warned": 0, "checked": 9e12}))
    done = subprocess.run([sys.executable, "-S", str(Path(work_budget.__file__)), "--work", str(work), "--budget",
                           str(2 * MB), "--text", "x"], input="{}", capture_output=True, text=True, timeout=60)
    assert done.stdout == "", "measured at most every CHECK_S"
