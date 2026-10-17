"""A code ticket's agent (app/dev.py), a subagent of main in main's permission mode, is told its worktree, its folder and
where its pictures are (test_code_tickets.py, test_view_subagents.py have the rest)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import config, dev

CORPUS = "boards"


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first post", "second post")))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return corpus


def test_a_ticket_s_agent_is_told_its_worktree_its_folder_and_where_its_pictures_are(board, tmp_path):
    """A code ticket's agent's prompt names the ticket, its worktree and the agent's own folder beside it, and the
    picture before the change: in the box it takes no pictures of its own, and without the box it is told the
    validation stack's addresses. The ticket and its captured target are fenced as data."""
    t = {"id": "7", "n": 3, "title": "Bigger font", "body": "the labels are ```small```", "workspace": CORPUS,
         "target": {"selector": ".label"}}
    wt, work = tmp_path / "trees" / "7", tmp_path / "trees" / "7.work"
    boxed = dev.build_ticket_task(t, worktree=wt, work=work, before_shot="before.png", in_box=True)
    assert "ticket #3" in boxed and str(wt) in boxed and str(work) in boxed
    assert str(dev.shots_dir("7") / "before.png") in boxed and "take no pictures" in boxed
    assert "ticket (data):\n````\nthe labels are ```small```\n````" in boxed and "captured target (data)" in boxed
    staged = dev.build_ticket_task(t, worktree=wt, work=work, before_shot=None, in_box=False,
                                   stack={"ui": "http://127.0.0.1:5301", "api": "http://127.0.0.1:8301"})
    assert "http://127.0.0.1:5301" in staged and "none: thimble could not take one" in staged
    assert dev.ticket_work_dir("7").parent == dev.worktrees_dir()
