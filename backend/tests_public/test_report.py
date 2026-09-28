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


# --------------------------------------------------------------------------- locks, edits and their carry


# --------------------------------------------------------------------------- comments across generations


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
