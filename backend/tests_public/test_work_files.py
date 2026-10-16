"""app.work_files: when an agent's run ends, its work folder lets go of its subagents' scratch folders and of the large
files nothing uses, and keeps what a card or a document names, the files a named script reads, small files, its
dot-entries and Python environments. While it runs, the agent hears when the folder grows past a budget (the plugin's
watcher, plugin/bin/.thimble-watch). The work folder and the notebook are invented."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app import config, orient_session, subagents, work_files

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


def test_a_run_that_goes_on_keeps_its_extracts_and_a_failed_one_keeps_everything(workspaces_tmp, monkeypatch):
    """Only a run that finished loses its large files. One the analyst stopped, or that a waiting message resumes at
    once, goes on with what it made, so only its subagents' scratch folders go; a failed run is resumed as it left
    its folder."""
    import asyncio  # noqa: PLC0415

    from app import orientation  # noqa: PLC0415

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

    monkeypatch.setattr(orientation, "read_run", lambda c: {})
    monkeypatch.setattr(orientation, "record", lambda c, **kw: None)
    monkeypatch.setattr(orientation, "finished", lambda *a, **kw: None)
    monkeypatch.setattr(orient_session, "_tell_main", lambda *a, **kw: None)
    monkeypatch.setattr(orient_session, "_tell_proposer", lambda c: None)

    async def unmeasured(c, chat):
        return ""

    monkeypatch.setattr(orient_session, "measure", unmeasured)

    async def ends(status: str, interrupted: bool = False) -> list[tuple]:
        asked.clear()
        run = subagents.Run(C, orient_session.KEY, "orientation", "chat-o", "a1", interrupted=interrupted)
        orient_session.subagent_ended(C, run, status, "")
        for _ in range(50):  # a finished first run goes on once its coverage is measured
            if C not in orient_session._closing:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0)
        return list(asked)

    assert asyncio.run(ends("done")) == [(work, True)]
    assert asyncio.run(ends("stopped")) == [(work, False)], "the analyst's Stop: a follow-up goes on with them"
    assert asyncio.run(ends("failed")) == []
