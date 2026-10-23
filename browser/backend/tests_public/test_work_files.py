"""app.work_files: when an agent's run ends, its work folder lets go of its subagents' scratch folders and of the large
files nothing uses, and keeps what a card or a document names, the files a named script reads, small files, its
dot-entries and Python environments. While it runs, the agent hears when the folder grows past a budget (the plugin's
watcher, plugin/bin/.thimble-watch). The work folder and the notebook are invented."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import config, work_files

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
