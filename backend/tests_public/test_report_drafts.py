"""A document's drafts in History (versions.history) and Restore (report_types.restore_draft): the analyst's own notes
and figures, laid out before the first write, are kept as Draft 1, theirs, when the first save replaces them, and Undo
of that save brings them back. Restore makes any past draft the newest one again, as the analyst's, and Undo reverts
the Restore. Through tools.call and the route functions, as the writer and the browser reach them; no model call."""
from __future__ import annotations

import pytest

from app import config, investigation, notebook, report_types, tools, undo, versions

CORPUS = "mini"
MAIN = investigation.MAIN
WRITER_TEXT = "# One account did it\n\n## Who\n\nOne account issued every deletion.\n"


@pytest.fixture()
def card(workspaces_tmp) -> str:
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    cell = notebook.new_cell("table", "terminal", "Deletions per account", nb["id"], code="df")
    cell["status"] = "ok"
    cell["outputs"] = [{"text/html": "<table><tr><th></th><th>count</th></tr><tr><th>alice</th><td>27</td></tr></table>",
                        "text/plain": "count\nalice 27"}]
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    return cell["id"]


def _frame(cid: str) -> None:
    """The analyst's notes: a section with a point and a figure of the card."""
    sec = report_types.add_section(CORPUS, "report", "My notes")
    report_types.add_paragraph(CORPUS, "report", sec["id"], "Alice did most of it.")
    report_types.add_frame_figure(CORPUS, "report", sec["id"], f"card:{cid}", caption="Per account")


def _texts(doc: dict) -> list[str]:
    return [x["text"] for x in report_types.all_sentences(doc)]


async def _write(text: str = WRITER_TEXT) -> dict:
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert doc is not None
    return doc


async def test_the_first_write_keeps_the_analysts_notes_and_figures_as_draft_1_by_them(card):
    _frame(card)
    doc = await _write()
    assert doc["generation"] == 2 and _texts(doc) == ["One account issued every deletion."]
    assert not report_types.frame_file(CORPUS, MAIN, "report").exists()
    h = versions.history(CORPUS, MAIN, "report", doc)
    assert [(e["n"], e["source"], e["current"], e["available"]) for e in h["versions"]] == [
        (2, "terminal", True, True), (1, "analyst", False, True)]
    first = versions.document_of(CORPUS, MAIN, "report", 1, doc)
    assert "frame" not in first and first["generation"] == 1
    assert [s["heading"] for s in first["sections"]] == ["My notes"] and _texts(first) == ["Alice did most of it."]
    assert [f["cell"] for f in first["sections"][0]["figures"]] == [f"card:{card}"]
    # the writer's draft says what it changed from the analyst's
    assert h["versions"][0]["summary"] and h["versions"][0]["summary_from"] == "diff"


async def test_restore_makes_a_past_draft_the_newest_as_the_analysts_and_undo_reverts_it(card):
    _frame(card)
    await _write()
    doc = await report_types.restore_version_route(CORPUS, MAIN, "report", 1)
    assert doc["generation"] == 3 and _texts(doc) == ["Alice did most of it."] and doc["written_by"] == "analyst"
    assert "writer_run" not in doc
    h = versions.history(CORPUS, MAIN, "report", doc)
    assert [(e["n"], e["source"]) for e in h["versions"]] == [(3, "analyst"), (2, "terminal"), (1, "analyst")]
    assert h["versions"][0]["restored"] == {"n": 1, "rev": None} and h["versions"][1]["restored"] is None
    # the writer's draft it replaced is kept, and opens
    assert _texts(versions.document_of(CORPUS, MAIN, "report", 2, doc)) == ["One account issued every deletion."]
    assert undo.labels(CORPUS)["undo"]
    undo.undo(CORPUS)
    back = report_types.read_doc(CORPUS, MAIN, "report")
    assert back is not None and back["generation"] == 2 and _texts(back) == ["One account issued every deletion."]
