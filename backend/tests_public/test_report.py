"""report.py: the report's shape from the writer's output, ref validation, the text edits that lock a passage, comments
across generations and the citation check. A report is saved the way the write_document tool saves one (normalize,
finish_generation, store; `write` below), from the output shapes the normalizer reads; cells are written to disk with
handmade outputs, no kernel and no model."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import config, investigation, notebook, report, report_types

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


SUMMARY = ("Agent-03 stopped after an admin action. The incident write-up would need redoing if that were false.\n\n"
           "Three admin actions cluster on day 3; the deletions follow within minutes.\n")


def seed_orient(c: str, inv_id: str, cells: dict[str, str]) -> None:
    """orient/summary.md, what the orientation leaves behind."""
    d = config.workspace_dir(c) / "orient"
    d.mkdir(parents=True, exist_ok=True)
    (d / "summary.md").write_text(SUMMARY)


def tool_output(cells: dict[str, str], *, title: str = "Agent-03 stopped after an admin action") -> dict:
    """A `document` tool output citing the seeded cells, the sections given as paragraphs of sentence objects."""
    return {
        "title": title,
        "sections": [
            {"heading": report.FIXED["data"], "paragraphs": [{"sentences": [
                {"text": "The corpus holds one run of agent logs.", "refs": ["README.md#L1"], "tags": ["fact"],
                 "tag_notes": {"fact": "The README states it."}},
            ]}]},
            {"heading": report.FIXED["takeaways"], "paragraphs": [{"sentences": [
                {"text": "Agent-03 stopped after an admin action.", "refs": [f"card:{cells['chart']}"],
                 "tags": ["crucial"], "tag_notes": {"crucial": "Everything else rests on it."},
                 "section": "The admin action"},
            ]}]},
            {
                "heading": "The admin action",
                "paragraphs": [{"sentences": [
                    {"text": f"There are [[38|card:{cells['table']}#count/alpha]] alpha rows.",
                     "refs": [f"card:{cells['table']}"], "tags": ["fact"]},
                    {"text": "An invented ref is dropped.", "refs": ["card:nope", "claim:deadbeef", "no/such/file.md#L9"],
                     "tags": []},
                ]}],
                "figures": [
                    {"cell": f"card:{cells['chart']}", "caption": "Admin actions per day."},
                    {"cell": f"card:{cells['table']}", "caption": "Counts by kind.", "after_paragraph": 1},
                    {"cell": f"card:{cells['text']}", "caption": "Not chart- or table-bearing; dropped."},
                ],
            },
            {"heading": report.FIXED["uncertainty"], "paragraphs": [{"sentences": [
                {"text": "A kernel crash would look different.", "refs": [], "tags": ["judgment"],
                 "tag_notes": {"judgment": "An interpretation of absence.", "caveat": "note for a tag it lacks"}},
            ]}]},
            {"heading": report.FIXED["unused"], "paragraphs": [{"sentences": [{"text": "One dead-end cell.", "refs": [], "tags": []}]}]},
            {"heading": report.FIXED["caveats"], "paragraphs": [{"sentences": [{"text": "Motive was not checked.", "refs": [], "tags": ["caveat"]}]}]},
        ],
    }


def raw_document(cells: dict[str, str], *, title: str = "Agent-03 stopped after an admin action", finding: str | None = None) -> dict:
    """The same statements as tool_output's, as markdown bodies."""
    return {"title": title, "sections": [
        {"heading": "What this data is and what we analyzed", "body": "The corpus holds one run of agent logs [[README.md#L1]]."},
        {"heading": "Main takeaways", "body": f"Agent-03 stopped after an admin action [[card:{cells['chart']}]]."},
        {"heading": "The admin action",
         "body": finding or (f"There are [[38|card:{cells['table']}#count/alpha]] alpha rows. An invented ref is dropped [[card:nope]]."),
         "figures": [{"cell": f"card:{cells['chart']}", "caption": "Admin actions per day."},
                     {"cell": f"card:{cells['table']}", "caption": "Counts by kind.", "after_paragraph": 1},
                     {"cell": f"card:{cells['text']}", "caption": "Not chart- or table-bearing; dropped."}]},
        {"heading": "Limitations", "body": "Motive was not checked."},
    ]}


def slot(out: dict, role: str) -> dict:
    if role in report.FIXED:
        return next(sec for sec in out["sections"] if sec["heading"] == report.FIXED[role])
    return next(sec for sec in out["sections"] if sec["heading"] not in report.FIXED.values())


def sentences(doc: dict) -> list[dict]:
    return report_types.all_sentences(doc)


def by_text(doc: dict, prefix: str) -> dict:
    return next(x for x in sentences(doc) if x["text"].startswith(prefix))


async def write(inv_id: str, raw: dict) -> dict:
    """The report saved from `raw` as the write_document tool saves a document: normalized, the previous generation's
    locks, comments and pinned figures carried, stored as the new generation."""
    t = report_types.read_type(CORPUS, "report")
    doc = report_types.normalize(t, raw, report._Refs(CORPUS))
    report_types.finish_generation(CORPUS, inv_id, "report", doc)
    doc.update(generated_at="2026-09-23T00:00:00+00:00", words=report_types.doc_words(doc))
    report_types.store(CORPUS, inv_id, "report", doc)
    return report_types.read_doc(CORPUS, inv_id, "report")


def stored(inv_id: str) -> dict:
    return report_types.read_doc(CORPUS, inv_id, "report")


# --------------------------------------------------------------------------- generation and the stored shape


async def test_the_writers_output_normalizes_to_the_stored_report(ws, inv):
    cells = seed_cells(ws, inv)
    seed_orient(CORPUS, inv, cells)

    doc = await write(inv, tool_output(cells))

    assert (investigation.inv_dir(CORPUS, inv) / "report.json").is_file()
    assert doc["generation"] == 1 and "locked" not in doc and doc["type"] == "report" and doc["renderer"] == "document"
    assert [s["role"] for s in doc["sections"]] == ["data", "takeaways", "finding", "uncertainty", "unused", "caveats"]
    assert doc["sections"][0]["heading"] == report.FIXED["data"] and doc["sections"][-1]["heading"] == "Limitations"
    assert doc["title_ok"] is True and doc["words"] > 10
    assert by_text(doc, "There are")["refs"] == [f"card:{cells['table']}", f"card:{cells['table']}#count/alpha"]
    assert by_text(doc, "An invented ref")["refs"] == [] and by_text(doc, "The corpus holds")["refs"] == ["README.md#L1"]
    unc = by_text(doc, "A kernel crash")
    assert unc["tags"] == ["judgment"] and list(unc["tag_notes"]) == ["judgment"]
    finding = next(s for s in doc["sections"] if s["role"] == "finding")
    assert by_text(doc, "Agent-03 stopped")["section"] == finding["id"]
    assert [f["cell"] for f in finding["figures"]] == [f"card:{cells['chart']}", f"card:{cells['table']}"]
    assert finding["figures"][1]["after_paragraph"] == finding["paragraphs"][0]["id"]
    assert set(doc["snapshot"]["cells"]) == set(cells.values())
    assert stored(inv)["title"] == doc["title"]


async def test_a_markdown_body_normalizes_to_sentences_with_roles_and_links(ws, inv):
    cells = seed_cells(ws, inv)
    seed_orient(CORPUS, inv, cells)
    doc = await write(inv, raw_document(cells))
    assert [s["role"] for s in doc["sections"]] == ["data", "takeaways", "finding", "caveats"]
    assert [x["text"] for x in sentences(doc)] == ["The corpus holds one run of agent logs [[README.md#L1]].",
                                                    f"Agent-03 stopped after an admin action [[card:{cells['chart']}]].",
                                                    f"There are [[38|card:{cells['table']}#count/alpha]] alpha rows.",
                                                    "An invented ref is dropped [[card:nope]].", "Motive was not checked."]
    for x in sentences(doc):
        assert report_types.is_sentence(x) and set(x) >= {"id", "text", "refs", "tags", "tag_notes", "section"}
    finding = doc["sections"][2]
    assert doc["sections"][1]["paragraphs"][0]["sentences"][0]["section"] == finding["id"]
    assert finding["paragraphs"][0]["sentences"][0]["refs"] == [f"card:{cells['table']}#count/alpha"]
    assert [f["cell"] for f in finding["figures"]] == [f"card:{cells['chart']}", f"card:{cells['table']}"]


# --------------------------------------------------------------------------- locks, edits and their carry


async def test_regeneration_keeps_only_what_the_analyst_locked(ws, inv):
    """Only a passage the analyst locks is locked; text they type is not. Their edited sentence and
    title are theirs until the writer's next generation, which may change them; the sentence locked by the route's
    explicit `locked` (its paragraph's lock) and the locked title come back as they were."""
    cells = seed_cells(ws, inv)
    seed_orient(CORPUS, inv, cells)
    doc = await write(inv, tool_output(cells))

    edited = by_text(doc, "There are")
    doc = await report_types.edit_sentence(CORPUS, inv, "report", edited["id"], report_types.SentenceEdit(text="The analyst's own sentence about alpha rows."))
    doc = await report_types.edit_title(CORPUS, inv, "report", report_types.TitleEdit(title="The analyst's title"))
    assert report_types.locked_refs(doc, "report") == [] and "locked" not in doc
    assert by_text(doc, "The analyst's own")["edited_by"] == "analyst" and by_text(doc, "The analyst's own")["history"][0]["text"].startswith("There are")
    out2 = tool_output(cells, title="A different model title")
    doc2 = await write(inv, out2)
    assert doc2["generation"] == 2 and doc2["title"] == "A different model title"
    assert by_text(doc2, "There are") and not any("The analyst's own" in x["text"] for x in sentences(doc2))

    dropped = by_text(doc2, "Motive was not checked.")
    doc2 = await report_types.edit_sentence(CORPUS, inv, "report", dropped["id"], report_types.SentenceEdit(locked=True))
    doc2 = await report_types.edit_title(CORPUS, inv, "report", report_types.TitleEdit(title="The analyst's title", locked=True))
    para = next(p for s in doc2["sections"] for p in s["paragraphs"] if any(x["id"] == dropped["id"] for x in p["sentences"]))
    assert report_types.locked_refs(doc2, "report") == ["report:report#title", f"report:report#p{para['id']}"]
    out3 = tool_output(cells, title="Yet another title")
    slot(out3, "caveats")["paragraphs"] = [{"sentences": [{"text": "A fresh caveat.", "refs": [], "tags": []}]}]
    doc3 = await write(inv, out3)
    assert doc3["generation"] == 3 and doc3["title"] == "The analyst's title"
    caveats = next(s for s in doc3["sections"] if s["role"] == "caveats")
    assert [x["text"] for x in report_types.unit_sentences(caveats)] == ["Motive was not checked.", "A fresh caveat."]
    archived = sorted((investigation.inv_dir(CORPUS, inv) / "report").glob("*.json"))
    assert len(archived) == 2 and json.loads(archived[-1].read_text())["title"] == "The analyst's title"


async def test_a_locked_heading_and_a_missing_locked_sentence_come_back(ws, inv):
    cells = seed_cells(ws, inv)
    seed_orient(CORPUS, inv, cells)
    out = tool_output(cells)
    out["sections"].insert(3, {"heading": "The second finding", "paragraphs": [{"sentences": [{"text": "Second finding, locked.", "refs": [], "tags": []}]}]})
    doc = await write(inv, out)
    second = next(s for s in doc["sections"] if s["heading"] == "The second finding")
    await report_types.edit_heading(CORPUS, inv, "report", second["id"], report_types.UnitEdit(heading="The second finding, renamed", locked=True))
    await report_types.edit_sentence(CORPUS, inv, "report", by_text(doc, "Second finding, locked.")["id"], report_types.SentenceEdit(locked=True))
    out2 = tool_output(cells, title="Second")
    out2["sections"].insert(3, {"heading": "A third finding", "paragraphs": [{"sentences": [{"text": "Something else.", "refs": [], "tags": []}]}]})
    doc2 = await write(inv, out2)
    # the writer's section at its index is one the old document did not have, so it is the locked one renamed
    assert [s["heading"] for s in doc2["sections"]][2:4] == ["The admin action", "The second finding, renamed"]
    back = doc2["sections"][3]
    assert back["id"] == second["id"] and back["locked"] is True
    assert [x["text"] for x in report_types.unit_sentences(back)][0] == "Second finding, locked."


def test_put_text_undo_pops_the_history_entry_and_the_edited_mark():
    node = {"id": "s", "text": "Original.", "refs": ["card:a"]}

    class V:
        def clean(self, raw, text=""):
            return list(raw)

    assert report._put_text(node, "text", "Original.", valid=V()) is False
    assert report._put_text(node, "text", "Edited.", valid=V()) is True
    assert node["text"] == "Edited." and node["edited_by"] == "analyst" and node["history"][0] == {**node["history"][0], "text": "Original.", "by": "analyst", "refs": ["card:a"]}
    assert report._put_text(node, "text", "Original.", undo=True, valid=V()) is True  # the undo pops the entry
    assert node["text"] == "Original." and "history" not in node and "edited_by" not in node and node["refs"] == ["card:a"]


# --------------------------------------------------------------------------- comments across generations


async def test_comments_carry_by_text_and_the_verifiers_on_rewritten_passages_settle(ws, inv):
    cells = seed_cells(ws, inv)
    seed_orient(CORPUS, inv, cells)
    doc = await write(inv, tool_output(cells))
    there = by_text(doc, "There are")
    motive = by_text(doc, "Motive")
    doc["comments"] = [
        {"id": "a1", "sentence_id": there["id"], "text": "Which table?", "author": "analyst", "ts": "t", "status": "open"},
        {"id": "v1", "sentence_id": motive["id"], "text": "No cell rules motive out.", "author": "verifier", "kind": "caveat", "ts": "t", "status": "open"},
        {"id": "v2", "sentence_id": there["id"], "text": "The cell shows 38.", "author": "verifier", "kind": "verified", "ts": "t", "status": "open"},
    ]
    report_types.write_doc(CORPUS, inv, "report", doc)
    out2 = tool_output(cells, title="Second")
    slot(out2, "caveats")["paragraphs"] = [{"sentences": [{"text": "Motive was checked after all.", "refs": [], "tags": []}]}]
    doc2 = await write(inv, out2)
    by_id = {cm["id"]: cm for cm in doc2["comments"]}
    there2 = by_text(doc2, "There are")
    assert by_id["a1"]["sentence_id"] == there2["id"] and by_id["a1"]["status"] == "open"
    assert by_id["v2"]["sentence_id"] == there2["id"] and by_id["v2"]["status"] == "open"
    assert by_id["v1"]["status"] == "dismissed" and by_id["v1"]["resolution"] == "superseded" and by_id["v1"]["superseded_generation"] == 2
    assert by_id["v1"]["was_on"] == "Motive was not checked." and by_id["v1"]["sentence_id"] == motive["id"]
    assert [cm["id"] for cm in report_types.anchored_open_comments(doc2)] == ["a1", "v2"]
    assert report.reopen_comment(by_id["v1"]) and by_id["v1"]["status"] == "open" and "resolution" not in by_id["v1"]


# --------------------------------------------------------------------------- the citation check


def test_value_matches_compares_whole_number_tokens():
    assert report._value_matches("38", "38 rows of alpha") and not report._value_matches("38", "138 rows")
    assert report._value_matches("1,019", "there were 1019") and not report._value_matches("3", "38 rows")
    assert report._value_matches("alpha", "the alpha, rows") and report._value_matches("0.75", "share 0.75")


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


def test_repair_span_refs_and_demote_gone_spans(ws, inv):
    cells = seed_cells(ws, inv)
    x = {"id": "a", "text": f"Counted [[4|card:{cells['text']}@out0#L1]] beta.", "refs": [f"card:{cells['text']}@out0#L1"], "tags": []}
    assert report.repair_span_refs(ws, [x]) == 1
    assert x["text"] == f"Counted [[4|card:{cells['text']}@out0#L2]] beta." and x["refs"] == [f"card:{cells['text']}@out0#L2"]
    y = {"id": "b", "text": f"See [[card:{cells['text']}@out0#L9]].", "refs": [f"card:{cells['text']}@out0#L9"], "tags": []}
    assert report.demote_gone_spans(ws, [y], [{"sentence_id": "b", "ref": f"card:{cells['text']}@out0#L9", "span_missing": True}]) == 1
    assert y["text"] == f"See [[card:{cells['text']}]]." and y["refs"] == [f"card:{cells['text']}"]
    assert report.broken_note(["card:x"], ["27"], ["29"]).startswith(report.BROKEN_PREFIX) and "shows 27" in report.broken_note(["card:x"], ["27"])
    assert report.plain_text("There are [[38|card:x#a/b]] rows [[card:y]].") == "There are 38 rows."
    # a period that starts a word (a dotfile, a decimal) keeps the space before it, but sentence punctuation collapses
    assert report.plain_text("They left their .yardopts file out .") == "They left their .yardopts file out."
    assert report.plain_text("A drop of .5 , then it ends in .gov.uk .") == "A drop of .5, then it ends in .gov.uk."


def test_refs_validates_against_the_workspace(ws, inv):
    cells = seed_cells(ws, inv)
    v = report._Refs(CORPUS)
    assert v.ok(f"card:{cells['chart']}") and v.ok("README.md#L1") and not v.ok("card:nope") and not v.ok("claim:deadbeef") and not v.ok("no/such.md#L1")
    assert v.clean([f"[[card:{cells['chart']}]]", "card:nope"], f"x [[38|card:{cells['table']}#count/alpha]]") == [f"card:{cells['chart']}", f"card:{cells['table']}#count/alpha"]
    assert v.artifact_id(f"card:{cells['chart']}") == cells["chart"] and v.artifact_id(cells["table"]) == cells["table"] and v.artifact_id(f"card:{cells['text']}") is None
    assert set(v.artifacts) == {cells["chart"], cells["table"]}


