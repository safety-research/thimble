"""The workspace stream's `cell` record carries the canvas history's `op`, so the Canvas tab's dot (shell/dots.ts) can
light for a card made or gone and stay dark for an announcement that changed nothing on the board. No kernel."""
from __future__ import annotations

import pytest

from app import canvas_history, config, investigation, notebook

CORPUS = "mini"


@pytest.fixture()
def records(workspaces_tmp, monkeypatch):
    got: list[dict] = []
    monkeypatch.setattr(investigation, "emit", lambda c, inv, ev: got.append(ev))
    canvas_history.forget()
    yield got
    canvas_history.forget()


def test_a_new_card_reads_created_a_repeat_announcement_has_no_op_and_a_delete_reads_deleted(records):
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Orientation", role="exploration")
    card = notebook.new_cell("example", "terminal", "How did runs pass an answer?", nb["id"])
    notebook.insert_cell(CORPUS, nb["id"], card)
    assert [r.get("op") for r in records] == ["created"]
    # the same card announced again (a check's status, the maker credited twice): nothing the board shows changed
    notebook._emit(CORPUS, {**card, "notebook": nb["id"]})
    assert "op" not in records[-1] and records[-1]["kind"] == "note"
    notebook.edit_cell(CORPUS, card["id"], takeaway="One run wrote it; the next read it.")
    assert records[-1]["op"] == "edited"
    notebook.delete_cell(CORPUS, card["id"])
    assert records[-1]["op"] == "deleted"
