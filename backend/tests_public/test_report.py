"""report.py's citation check: a value that moved is repaired, and a sentence nothing shows is tagged. Cells are written
to disk with handmade outputs, no kernel and no model."""
from __future__ import annotations

from pathlib import Path

import pytest

from app import config, investigation, notebook, report

CORPUS = "mini"


@pytest.fixture()
def ws(workspaces_tmp) -> Path:
    return config.workspace_dir(CORPUS)


@pytest.fixture()
def inv(ws) -> str:
    return investigation.MAIN


CHART = {"image/png": "iVBORw0KGgo="}
TABLE = {"text/html": "<table><tr><th></th><th>count</th></tr>"
                      "<tr><th>alpha</th><td>38</td></tr><tr><th>beta</th><td>4</td></tr></table>"}


def seed_cells(ws: Path, inv_id: str) -> dict[str, str]:
    """An exploration notebook with a chart cell, a table cell and a text cell; returns {'chart','table','text'} ids."""
    nb = notebook.create_notebook(ws, "Exploration", role="exploration", investigation=inv_id)
    ids: dict[str, str] = {}
    for key, outputs, takeaway in (
        ("chart", [CHART], "Admin actions spike on day 3 [[card:SELF]]."),
        ("table", [TABLE], "There are [[38|card:SELF#count/alpha]] alpha rows."),
        ("text", [{"text/plain": "38 rows of alpha\n4 of beta"}], "Counted [[38|card:SELF@out0#L1]] alpha rows."),
    ):
        cell = notebook.new_cell("code", "run", f"How many {key}?", nb["id"], code="print()")
        cell["status"] = "ok"
        cell["outputs"] = outputs
        cell["takeaway"] = takeaway.replace("SELF", cell["id"])
        nb["cells"].append(cell)
        ids[key] = cell["id"]
    notebook.write_notebook(ws, nb)
    return ids


# --------------------------------------------------------------------------- the citation check


async def test_verify_and_tag_repairs_a_moved_value_and_tags_what_nothing_shows(ws, inv):
    cells = seed_cells(ws, inv)
    ok = {"id": "s1", "text": f"There are [[38|card:{cells['table']}#count/alpha]] alpha rows.", "refs": [f"card:{cells['table']}#count/alpha"], "tags": [], "tag_notes": {}}
    moved = {"id": "s2", "text": f"Beta has [[4|card:{cells['table']}#count/alpha]] rows.", "refs": [f"card:{cells['table']}#count/alpha"], "tags": [], "tag_notes": {}}
    wrong = {"id": "s3", "text": f"There were [[99|card:{cells['text']}]] accounts.", "refs": [f"card:{cells['text']}"], "tags": [], "tag_notes": {}}
    gone = {"id": "s4", "text": "See [[card:nope0000]].", "refs": ["card:nope0000"], "tags": [], "tag_notes": {}}
    stale = {"id": "s5", "text": "Plain.", "refs": [], "tags": ["unverified"], "tag_notes": {"unverified": report.quiet_note(["x"])}}
    out = await report.verify_and_tag(CORPUS, [ok, moved, wrong, gone, stale])
    assert "unverified" not in ok["tags"]
    assert moved["text"] == f"Beta has [[4|card:{cells['table']}#count/beta]] rows." and moved["refs"] == [f"card:{cells['table']}#count/beta"]
    assert "unverified" not in moved["tags"] and out["repaired"] >= 1
    assert "unverified" in wrong["tags"] and wrong["tag_notes"]["unverified"].startswith(report.BROKEN_PREFIX) and report.unverified_kind(wrong) == "broken"
    assert "unverified" in gone["tags"] and "card:nope0000" in gone["tag_notes"]["unverified"] and report.unverified_kind(gone) == "quiet"
    assert stale["tags"] == [] and stale["tag_notes"] == {}  # a tag an earlier pass left on a sentence that now holds is cleared
    assert out["checked"] >= 4 and {f["sentence_id"] for f in out["failed"]} >= {"s3", "s4"}
