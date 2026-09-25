"""notebook.migrate_writer_groups: a figures group an older writer made inside the analyst's Your work (before writers
kept their cards in a root group of their own, tools.session_notebook) moves to the canvas root on the canvas's first
read, with its cards and name, stamped with its writer's session, and the move is in the canvas history. A group
holding any card the analyst made, or one the analyst made, stays. The fixture: Orientation (the deck) and Your work
at the root, Report figures inside Your work."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import canvas_history, config, notebook, tools

C = "mini"
WRITER = "3c1e7a90"
ORIENT = "6d4b2f18"


@pytest.fixture(autouse=True)
async def _clean(workspaces_tmp):
    canvas_history.forget()
    yield
    canvas_history.forget()
    await notebook.shutdown_all()


def _ws() -> Path:
    return config.workspace_dir(C)


def _chat(cid: str, role: str, doc: str | None = None) -> None:
    d = _ws() / "chats"
    d.mkdir(parents=True, exist_ok=True)
    meta = {"id": cid, "kind": "agent", "role": role, "title": role, "created_at": "2026-09-25T20:44:56.361+00:00",
            "parent": "main", "status": "done", "anchor": None, "anchor_text": None, "group": None}
    if doc:
        meta["doc"] = doc
    (d / f"{cid}.meta.json").write_text(json.dumps(meta), "utf-8")


def _group(gid: str, title: str, *, role: str = "analyst", parent: str | None = None, created_by: str | None = None,
           makers: tuple[str, ...] = (), kind: str = "sequence") -> None:
    d = notebook.notebooks_dir(_ws())
    d.mkdir(parents=True, exist_ok=True)
    cells = [{"id": f"{gid[:4]}{i:04d}", "notebook": gid, "kind": "note", "title": f"Card {i}", "code": "",
              "payload": {"text": "t"}, "created_by": m, "outputs": []} for i, m in enumerate(makers)]
    data = {"title": title, "ts": f"2026-09-25T20:{len(list(d.glob('*.json'))):02d}:00+00:00", "role": role,
            "kind": kind, "parent": parent, "anchor": None, "chat": None, "investigation": None, "finding": None,
            "pos": None, "order": None, "id": gid, "cells": cells}
    if created_by:
        data["created_by"] = created_by
    (d / f"{gid}.json").write_text(json.dumps(data), "utf-8")
    notebook.clear_cache()


def _old_layout() -> None:
    _chat(WRITER, "writer", "report")
    _chat(ORIENT, "orient")
    _group("0a7c3e21", "Orientation", role="exploration", makers=(f"chat:{ORIENT}",) * 3)
    _group("9b5d1f64", "Your work", created_by="user")
    _group("47e2a0c8", "Report figures", parent="9b5d1f64", makers=(f"chat:{WRITER}",) * 5)


def _history() -> list[dict]:
    p = canvas_history.log_path(C)
    return [json.loads(line) for line in p.read_text("utf-8").splitlines()] if p.is_file() else []


async def test_an_older_writers_figures_move_out_of_your_work_to_the_root():
    _old_layout()
    cards = [c["id"] for c in notebook.read_notebook(_ws(), "47e2a0c8")["cells"]]
    out = await notebook.canvas_route(C)
    nb = notebook.read_notebook(_ws(), "47e2a0c8")
    assert nb["parent"] is None and nb["title"] == "Report figures"
    assert [c["id"] for c in nb["cells"]] == cards
    assert nb[tools.SESSION_GROUP_KEY] == "writer:report"  # the writer keeps adding to it (tools.session_notebook)
    assert next(g for g in out["groups"] if g["id"] == "47e2a0c8")["parent"] is None
    assert notebook.read_notebook(_ws(), "0a7c3e21")["parent"] is None  # the deck is untouched
    [line] = _history()
    assert line["op"] == "group-moved" and line["group"] == "47e2a0c8" and line["from"] == "9b5d1f64"
    assert line["to"] is None and line["cards"] == cards and line["by"] == "migration"


async def test_the_migration_runs_once_and_again_moves_nothing():
    _old_layout()
    assert notebook.migrate_writer_groups(C) == ["47e2a0c8"]
    notebook._writer_groups_migrated.clear()
    assert notebook.migrate_writer_groups(C) == []
    assert len(_history()) == 1


async def test_a_group_holding_a_card_the_analyst_made_stays():
    _old_layout()
    _group("aa11bb22", "Report figures 2", parent="9b5d1f64", makers=(f"chat:{WRITER}", "terminal"))
    _group("cc33dd44", "Mixed below", parent="9b5d1f64", makers=(f"chat:{WRITER}",))
    _group("ee55ff66", "Mine", parent="cc33dd44", makers=("user",))
    assert notebook.migrate_writer_groups(C) == ["47e2a0c8"]
    assert notebook.read_notebook(_ws(), "aa11bb22")["parent"] == "9b5d1f64"
    assert notebook.read_notebook(_ws(), "cc33dd44")["parent"] == "9b5d1f64"


async def test_a_group_the_analyst_made_or_an_empty_one_stays_even_with_only_a_writers_cards():
    _old_layout()
    _group("aa11bb22", "My picks", parent="9b5d1f64", created_by="user", makers=(f"chat:{WRITER}",))
    _group("cc33dd44", "Empty", parent="9b5d1f64")
    _group("dd44ee55", "Orient's", parent="9b5d1f64", makers=(f"chat:{ORIENT}",))
    assert notebook.migrate_writer_groups(C) == ["47e2a0c8"]
    for gid in ("aa11bb22", "cc33dd44", "dd44ee55"):
        assert notebook.read_notebook(_ws(), gid)["parent"] == "9b5d1f64", gid


async def test_a_second_figures_group_moves_without_taking_a_stamp_already_held():
    _old_layout()
    _group("99887766", "Report figures", parent="9b5d1f64", makers=(f"chat:{WRITER}",))
    moved = notebook.migrate_writer_groups(C)
    assert sorted(moved) == ["47e2a0c8", "99887766"]
    stamps = [notebook.read_notebook(_ws(), g).get(tools.SESSION_GROUP_KEY) for g in moved]
    assert stamps.count("writer:report") == 1
