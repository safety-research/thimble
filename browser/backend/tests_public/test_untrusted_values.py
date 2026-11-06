"""What the server reads from a file that sandboxed code can write is untrusted input: a card's code writes its whole
workspace but for a few names (kernel_wrap), so a value the server reads from a file there names no file or folder
until it is checked the way a route checks the same kind of value (a slug, an id, a name). Each case below is one where
such a value led the server, which runs in no sandbox, to a file outside the workspace: here, the undo journal."""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import concepts, config, investigation, undo

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh_undo():
    undo.forget()
    yield
    undo.forget()


def _outside(tmp_path_factory) -> Path:
    """A folder outside the workspace that holds a made-up file of the person's."""
    d = tmp_path_factory.mktemp("outside-the-workspace").resolve()
    (d / "made-up-settings.json").write_text('{"made": "up"}\n')
    return d


def _up_to(folder: Path, target: Path) -> str:
    """`target` spelled from `folder` with ../ parts, as a value a card writes into a file of its workspace."""
    return "../" * len(folder.parts) + str(target).lstrip("/")


def test_undo_skips_a_step_a_card_appended_whose_names_lead_outside_the_workspace(tmp_path_factory):
    """undo.jsonl lies in the workspace: a step a card's code appended there named the document to restore or remove
    by its `target`, its investigation by `inv` and a deleted label's files by `trash`, each taken as it was, so the
    next Undo or Redo wrote, removed or moved files wherever their ../ parts led."""
    outside = _outside(tmp_path_factory)
    (outside / "made-up0.json").write_text(json.dumps({"name": "the person's own"}))
    inv = investigation.ensure_main(CORPUS).resolve()
    trash = (config.workspace_dir(CORPUS) / undo.TRASH_NAME).resolve()
    stamp = "2026-11-03T00:00:00.000+00:00"
    doc = {"type": "step", "ts": stamp, "kind": "doc", "op": "edited", "by": "", "label": "edit the report",
           "after": {"title": "x"}}
    steps = [
        {**doc, "id": "made0001", "target": _up_to(inv, outside / "made-up-settings"), "inv": "main", "which": "doc",
         "before": None},
        {**doc, "id": "made0002", "target": _up_to(inv, outside / "made-up-written"), "inv": "main", "which": "doc",
         "before": {"hooks": {"made-up": "chosen by the card"}}},
        {"type": "step", "id": "made0004", "ts": stamp, "kind": "label", "op": "deleted", "target": "made-up0",
         "by": "", "label": "delete label made-up", "trash": _up_to(trash, outside), "cards": [], "filters": {}},
        # a rewritten journal's redo stack, which Redo applies forward: a label deleted again into `trash`
        {"type": "step", "id": "made0006", "ts": stamp, "kind": "label", "op": "deleted", "target": "made-up1",
         "by": "", "label": "delete label made-up", "trash": _up_to(trash, outside), "cards": [], "filters": {},
         "stack": "redo"},
    ]
    ws = config.workspace_dir(CORPUS)
    concepts.write_concept(ws, concepts.new_concept("made-up label") | {"id": "made-up1"})
    with undo.log_path(CORPUS).open("a") as f:  # what a card's code can append to its workspace's journal
        f.writelines(json.dumps(s) + "\n" for s in steps)
    trash.mkdir()  # the trash folder, which a card's code can make in its workspace too
    for press, side in ((undo.redo, "redo"), (undo.undo, "undo")):  # the analyst's Redo, then Undo, until none is left
        for _ in steps:
            if undo.labels(CORPUS)[side] is None:
                break
            with contextlib.suppress(HTTPException):
                press(CORPUS)
        assert sorted(os.listdir(outside)) == ["made-up-settings.json", "made-up0.json"]
        assert (outside / "made-up0.json").read_text() == json.dumps({"name": "the person's own"})
        assert concepts.read_concept(ws, "made-up0") is None and concepts.read_concept(ws, "made-up1") is not None
    assert undo.labels(CORPUS)["undo"] is None and undo.labels(CORPUS)["redo"] is None
