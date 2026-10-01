"""app.work_files: when an agent's run ends, its work folder lets go of its subagents' scratch folders and of the large
files nothing uses, and keeps what a card or a document names, the files a named script reads, small files, its
dot-entries and Python environments. The work folder and the notebook are invented."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app import config, orient_session, work_files

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
