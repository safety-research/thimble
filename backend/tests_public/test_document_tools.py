"""The document tools: `write_document` saves a whole document the writer agent wrote in markdown as its new generation
and checks it, called through tools.call as the analyst's session and its agents would; report.py's citation check
repairs a value that moved and tags a sentence nothing shows. No model call and no kernel."""
from __future__ import annotations

from pathlib import Path

import pytest

from app import config, investigation, notebook, report, report_types, tools

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
def cells(workspaces_tmp):
    """A printed count (27) and a table-bearing card in the analyst's group."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    count = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    count["status"], count["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    table = notebook.new_cell("table", "terminal", "Deletions per account", nb["id"], code="df")
    table["status"] = "ok"
    table["outputs"] = [{"text/html": "<table><tr><th></th><th>count</th></tr><tr><th>alice</th><td>27</td></tr>"
                                      "<tr><th>bob</th><td>9</td></tr></table>", "text/plain": "count\nalice 27\nbob 9"}]
    nb["cells"] += [count, table]
    notebook.write_notebook(ws, nb)
    return count["id"], table["id"]


async def call(name: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst")


def _body(res) -> str:
    return res.text.partition("\n")[2]


def _events() -> list[dict]:
    return [e for e in investigation._read_jsonl(investigation.inv_dir(CORPUS, MAIN) / "events.jsonl") if e.get("type") == "report"]


async def test_write_document_saves_a_generation_and_checks_it(cells):
    cid, tid = cells
    text = (f"# One account issued every deletion\n\n## One account\n\nAll [[27|card:{cid}]] deletions came from one account. "
            f"Bob issued [[9|card:{tid}#count/bob]].\n\n![Deletions per account](card:{tid})\n![Not a chart](card:{cid})\n\n"
            "## Caveats\n\nThe log covers one week.\n")
    r = await call("write_document", doc="report", text=text)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert doc["title"] == "One account issued every deletion" and doc["generation"] == 1
    assert [s["heading"] for s in doc["sections"]] == ["One account", "Caveats"]
    first = report_types.unit_sentences(doc["sections"][0])
    assert first[0]["text"] == f"All [[27|card:{cid}]] deletions came from one account." and f"card:{cid}" in first[0]["refs"]
    assert [f["cell"] for f in doc["sections"][0]["figures"]] == [f"card:{tid}"]
    assert doc["model"] == "session" and doc["written_by"] == "terminal" and doc["words"] > 0
    assert _body(r).splitlines()[:2] == ["saved [[report:report]] as generation 1, 2 sections, 3 sentences and 1 figure",
                                         "left out 1 figure whose card draws no figure: a figure shows a chart, a "
                                         "table, a timeline, a diagram or a custom card's page"]
    assert tools.hint("write_document-saved", slug="report") in r.text and doc["verified"]["status"] == "done"
    assert _events()[-1] == {**_events()[-1], "slug": "report", "status": "generated", "by": "terminal"}
    # a second save is the next generation, the first kept in the history
    r = await call("write_document", doc="report", text="# Shorter\n\n## One account\n\nOne account did it.\n")
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert not r.is_error and doc["generation"] == 2 and doc["title"] == "Shorter"


@pytest.fixture()
def hours(workspaces_tmp):
    """A card of deletions per hour, its rows named by the hour, and a card that printed the first deletion's time."""
    from app import frames

    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    table = notebook.new_cell("table", "terminal", "Deletions per hour on 23 June", nb["id"], code="df")
    table["status"] = "ok"
    f = frames.normalize({"columns": ["hour (UTC)", "deletions"], "index": "hour (UTC)",
                          "rows": [["20:00", 174], ["21:00", 0], ["22:00", 40], ["23:00", 89]]})
    table["outputs"] = [frames.bundle(f)]
    first = notebook.new_cell("code", "terminal", "When was the first deletion?", nb["id"], code="print(first)")
    first["status"], first["outputs"] = "ok", [{"text/plain": "2026-06-04T10:53:40Z TestFoobaAgent", "_stream": True}]
    nb["cells"] += [table, first]
    notebook.write_notebook(ws, nb)
    return table["id"], first["id"]


async def test_a_value_cited_at_the_row_its_sentence_names_stays_there(hours):
    """Live check term-fix7, new quirk 1: the writer cited `[[89|…#deletions/22:00]]` "in the 22:00 hour", the 22:00 row
    showed 40, and the save moved the citation to 23:00, the one row showing 89, so a wrong hour stood under a blue
    link. A value whose sentence names the row it cites stays at that row, and the sentence is tagged with what the row
    shows; one whose sentence names no row still moves to the one place that shows it."""
    tid, _ = hours
    text = (f"# Hours\n\n## Hours\n\nA last [[89|card:{tid}#deletions/22:00]] came in the 22:00 hour.\n\n"
            f"## Other\n\nThe evening ended with [[89|card:{tid}#deletions/22:00]] deletions.\n")
    r = await call("write_document", doc="report", text=text)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    named, other = report_types.unit_sentences(doc["sections"][0])[0], report_types.unit_sentences(doc["sections"][1])[0]
    assert f"[[89|card:{tid}#deletions/22:00]]" in named["text"] and "unverified" in named["tags"]
    assert "The cited place shows 40." in named["tag_notes"]["unverified"]
    assert f"[[89|card:{tid}#deletions/23:00]]" in other["text"] and "unverified" not in (other.get("tags") or [])
    assert f"“A last 89 came in the 22:00 hour.” Not verified by execution" in r.text


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
