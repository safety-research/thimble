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

async def test_words_that_show_no_value_name_the_file_place_they_link_and_are_never_tagged(ws, inv):
    """Live check term-fix6: a takeaway's `[[its record|pages.jsonl#L2]]` was marked red, since the check read any words
    at a file line as a value. Words with no number, no quotation marks and no day and month only name the place, so a
    place that resolves holds them, in a document as in a takeaway; a number or quoted words still have to be there, and
    a place that does not resolve still fails."""
    from app import cite, verify

    assert not cite.shows_value("its record") and not cite.shows_value("on dorfwiki")
    assert cite.shows_value("352") and cite.shows_value("“REVIEW WANTED”") and cite.shows_value("23 June")
    assert cite.shows_value("3 deletions") and not cite.shows_value("the agent's record")

    def sentence(sid: str, text: str) -> dict:
        return {"id": sid, "text": text, "refs": [], "tags": [], "tag_notes": {}}

    words = sentence("w1", "The first post [[asks for reviews|board.jsonl#L1]].")
    quoted = sentence("w2", "It says [[“REVIEW WANTED”|board.jsonl#L1]].")
    lost = sentence("w3", "It says [[“a lost phrase”|board.jsonl#L1]].")
    number = sentence("w4", "It came [[999|board.jsonl#L1]] times.")
    gone = sentence("w5", "It is [[on the board|nope.jsonl#L1]].")
    await report.verify_and_tag(CORPUS, [words, quoted, lost, number, gone])
    assert words["tags"] == [] and words["text"] == "The first post [[asks for reviews|board.jsonl#L1]]."
    assert quoted["tags"] == []
    assert "unverified" in lost["tags"] and "unverified" in number["tags"] and "unverified" in gone["tags"]

    nb = notebook.create_notebook(ws, "Exploration", role="exploration", investigation=inv)
    cell = notebook.new_cell("code", "run", "What does the first post ask?", nb["id"], code="print()")
    cell.update(status="ok", outputs=[{"text/plain": "1 post"}],
                takeaway="The first post [[asks for reviews|board.jsonl#L1]] and got [[999|board.jsonl#L1]] votes.")
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    await verify._links_job(CORPUS, cell["id"], verify._links_version(notebook.get_cell(CORPUS, cell["id"])))
    links = notebook.get_cell(CORPUS, cell["id"])["verification"]["links"]
    assert [b["value"] for b in links["broken"]] == ["999"]
    assert "asks for reviews" in {r["value"] for r in links["resolved"]}

