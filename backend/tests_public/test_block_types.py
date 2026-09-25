"""A report block's type: the editor turns a heading, paragraph or list item into another kind of block (the blocks
route reconciles it, report_types.apply_blocks), main does the same with edit_document's `block_type`
(report_types.set_block_type), and a subheading keeps its level through both and through the writer's markdown. Also
the report's card requests: add_card with a `card` event's `request:<id>` group. No model call and no kernel."""
from __future__ import annotations

import re

import pytest
from fastapi import HTTPException

from app import config, investigation, notebook, report_types, tools

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
def doc(workspaces_tmp):
    """A written report: a heading over a two-sentence paragraph, a list, a figure, and a second section."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    card = notebook.new_cell("code", "terminal", "Visits per garden", nb["id"], code="df")
    card["status"], card["outputs"] = "ok", [{"text/plain": "rose 4\ntulip 2"}]
    nb["cells"].append(card)
    notebook.write_notebook(ws, nb)
    written = {"id": "report", "type": "report", "renderer": "document", "title": "The gardens", "generation": 1,
               "sections": [
                   {"id": "h1", "role": "finding", "heading": "Roses lead", "figures": [
                       {"id": "f1", "cell": f"card:{card['id']}", "caption": "Visits", "after_paragraph": "p1"}],
                    "paragraphs": [
                        {"id": "p1", "sentences": [{"id": "s1", "text": "Roses drew four visits.", "refs": [], "tags": [], "tag_notes": {}},
                                                   {"id": "s2", "text": "Tulips drew two.", "refs": [], "tags": [], "tag_notes": {}}]},
                        {"id": "l1", "sentences": [{"id": "i1", "text": "Morning visits.", "bullet": "-", "refs": [], "tags": [], "tag_notes": {}},
                                                   {"id": "i2", "text": "Evening visits.", "bullet": "-", "refs": [], "tags": [], "tag_notes": {}}]}]},
                   {"id": "h2", "role": "caveats", "heading": "Caveats", "figures": [],
                    "paragraphs": [{"id": "p2", "sentences": [{"id": "s3", "text": "One week only.", "refs": [], "tags": [], "tag_notes": {}}]}]}],
               "comments": []}
    report_types.write_doc(CORPUS, MAIN, "report", written)
    return report_types.read_doc(CORPUS, MAIN, "report")


def _comment(cid: str, anchor: str, **extra) -> dict:
    return {"id": cid, "sentence_id": anchor, "text": "note", "author": "analyst", "ts": "t", "status": "open", **extra}


async def _save(blocks: list[dict], title: str = "The gardens") -> dict:
    body = report_types.BlocksBody(title=title, blocks=[report_types.BlockIn(**b) for b in blocks])
    return await report_types.blocks_route(CORPUS, MAIN, "report", body)


def _wire(doc: dict, **changes: dict) -> list[dict]:
    """The document as the editor saves it, with some blocks' fields changed by id."""
    return [{**b.model_dump(exclude_none=True), **changes.get(b.id, {})} for b in report_types.editor_blocks(doc)]


def _sections(doc: dict) -> list[tuple[str, str, int | None]]:
    return [(s["id"], s["heading"], s.get("level")) for s in doc["sections"]]


async def test_a_paragraph_made_a_subheading_keeps_its_lock_and_its_comments(doc):
    doc["sections"][0]["paragraphs"][0]["locked"] = True
    doc["comments"] = [_comment("c1", "s2"), _comment("c2", "s1", paragraph=True), _comment("c3", "s3")]
    report_types.write_doc(CORPUS, MAIN, "report", doc)
    out = await _save(_wire(doc, p1={"type": "heading", "level": 3}))
    assert _sections(out) == [("h1", "Roses lead", None), ("p1", "Roses drew four visits. Tulips drew two.", 3), ("h2", "Caveats", None)]
    assert out["sections"][1]["locked"] is True and report_types.locked_refs(out, "report") == ["report:report#p1"]
    by_id = {cm["id"]: cm for cm in out["comments"]}
    assert by_id["c1"]["sentence_id"] == "p1" and by_id["c2"]["sentence_id"] == "p1" and "paragraph" not in by_id["c2"]
    assert by_id["c3"]["sentence_id"] == "s3"
    # the list and the figure that followed the paragraph now stand under the subheading
    assert [p["id"] for p in out["sections"][1]["paragraphs"]] == ["l1"] and out["sections"][1]["figures"][0]["id"] == "f1"
    # the level comes back to the editor and to every model that reads the document
    assert [b.level for b in report_types.editor_blocks(out) if b.type == "heading"] == [2, 3, 2]
    assert "### Roses drew four visits. Tulips drew two. · #p1 · locked" in report_types.document_lines(out)
    assert "\n### Roses drew four visits. Tulips drew two.\n" in report_types.render_markdown(CORPUS, out)["markdown"]
    # and back to a heading: the level goes
    again = await _save(_wire(out, p1={"level": 2}))
    assert _sections(again)[1] == ("p1", "Roses drew four visits. Tulips drew two.", None)


async def test_a_heading_made_text_takes_its_lock_and_its_comment_to_the_paragraph(doc):
    doc["sections"][1]["locked"] = True
    doc["comments"] = [_comment("c1", "h2")]
    report_types.write_doc(CORPUS, MAIN, "report", doc)
    out = await _save(_wire(doc, h2={"type": "paragraph"}))
    assert _sections(out) == [("h1", "Roses lead", None)]
    paras = out["sections"][0]["paragraphs"]
    assert [p["id"] for p in paras] == ["p1", "l1", "h2", "p2"]
    made = paras[2]
    assert made["locked"] is True and [x["text"] for x in made["sentences"]] == ["Caveats"]
    assert out["comments"][0]["sentence_id"] == made["sentences"][0]["id"] != "h2"
    assert paras[3]["sentences"][0]["id"] == "s3", "the paragraphs under the old heading keep their records"


async def test_a_list_item_made_text_and_a_paragraph_made_a_list_item_keep_their_comments(doc):
    doc["sections"][0]["paragraphs"][1]["locked"] = True
    doc["comments"] = [_comment("c1", "i2"), _comment("c2", "s3")]
    report_types.write_doc(CORPUS, MAIN, "report", doc)
    out = await _save(_wire(doc, i2={"type": "paragraph", "marker": None}, p2={"type": "bullet", "marker": "1."}))
    paras = out["sections"][0]["paragraphs"]
    assert [p["id"] for p in paras] == ["p1", "l1", "i2"]
    item = paras[2]
    assert item["locked"] is True and [x["text"] for x in item["sentences"]] == ["Evening visits."] and "bullet" not in item["sentences"][0]
    assert [x["id"] for x in paras[1]["sentences"]] == ["i1"] and paras[1]["locked"] is True
    numbered = out["sections"][1]["paragraphs"][0]
    assert [(x["id"], x["text"], x["bullet"]) for x in numbered["sentences"]] == [("p2", "One week only.", "1.")]
    by_id = {cm["id"]: cm for cm in out["comments"]}
    assert by_id["c1"]["sentence_id"] == item["sentences"][0]["id"] and by_id["c2"]["sentence_id"] == "p2"
    # a second save of what the editor holds now changes nothing
    blocks = _wire(out)
    assert [(b["id"], b["type"]) for b in blocks if b["type"] != "figure"] == [
        ("h1", "heading"), ("p1", "paragraph"), ("i1", "bullet"), ("i2", "paragraph"), ("h2", "heading"), ("p2", "bullet")]
    assert (await _save(blocks))["sections"] == out["sections"]


async def test_edit_document_turns_a_block_into_another_kind_from_the_chat(doc):
    r = await tools.call(CORPUS, "edit_document", {"span": "report:report#p1", "block_type": "subheading"}, actor="analyst")
    assert not r.is_error, r.text
    after = report_types.read_doc(CORPUS, MAIN, "report")
    assert _sections(after)[1] == ("p1", "Roses drew four visits. Tulips drew two.", 3) and "report:report#p1" in r.text
    events = [e for e in investigation._read_jsonl(investigation.inv_dir(CORPUS, MAIN) / "events.jsonl") if e.get("type") == "report"]
    assert events[-1] == {**events[-1], "status": "rewritten", "span": "report:report#p1"}
    # a list item's sentence turns that item; a list's paragraph turns every item
    assert not (await tools.call(CORPUS, "edit_document", {"span": "report:report#i2", "block_type": "numbers"}, actor="analyst")).is_error
    after = report_types.read_doc(CORPUS, MAIN, "report")
    assert [[x.get("bullet") for x in p["sentences"]] for p in after["sections"][1]["paragraphs"]] == [["-"], ["1."]]
    list_id = after["sections"][1]["paragraphs"][0]["id"]
    assert not (await tools.call(CORPUS, "edit_document", {"span": f"report:report#p{list_id}", "block_type": "text"}, actor="analyst")).is_error
    after = report_types.read_doc(CORPUS, MAIN, "report")
    assert [([x["text"] for x in p["sentences"]], [x.get("bullet") for x in p["sentences"]]) for p in after["sections"][1]["paragraphs"]] == [
        (["Morning visits."], [None]), (["Evening visits."], ["1."])]
    # a locked block is the analyst's, so no model changes its type; the title and a figure have none to change
    report_types.set_block_lock(CORPUS, MAIN, "report", "h2", True)
    r = await tools.call(CORPUS, "edit_document", {"span": "report:report#h2", "block_type": "text"}, actor="analyst")
    assert r.is_error and "locked" in r.text
    for span, kind in (("report:report#title", "text"), ("report:report#f1", "heading"), ("report:report#p2", "quote")):
        assert (await tools.call(CORPUS, "edit_document", {"span": span, "block_type": kind}, actor="analyst")).is_error, span
    with pytest.raises(HTTPException) as e:
        report_types.set_block_type(CORPUS, "report", "nope", "text", "terminal")
    assert e.value.status_code == 404


def test_the_writers_markdown_keeps_a_subheading_and_the_heading_over_it():
    raw = report_types.parse_markdown("# T\n\n## Findings\n\n### Roses lead\n\nRoses drew four visits.\n\n## Empty\n\n## Caveats\n\nOne week.\n", "document")
    assert [(s["heading"], s["level"]) for s in raw["sections"]] == [("Findings", 2), ("Roses lead", 3), ("Caveats", 2)]
    made = report_types.normalize({"slug": "report", "renderer": "document"}, raw, report_types._Refs(CORPUS))
    assert [(s["heading"], s.get("level")) for s in made["sections"]] == [("Findings", None), ("Roses lead", 3), ("Caveats", None)]


async def test_a_card_request_lands_in_the_analysts_group_and_is_announced(workspaces_tmp):
    ws = config.workspace_dir(CORPUS)
    mine = notebook.create_notebook(ws, "Your work", role="analyst")
    other = notebook.create_notebook(ws, "Gardens", role="analyst", parent=mine["id"])
    await tools.active_group_route(CORPUS, tools.ActiveGroupBody(group=other["id"]))
    r = await tools.call(CORPUS, "add_card", {"kind": "note", "question": "Which garden leads?", "text": "Roses.", "group": "request:ab12"}, actor="analyst")
    assert not r.is_error, r.text
    cid = re.search(r"^card:(\w+)$", r.text, re.M).group(1)
    assert notebook.get_cell(CORPUS, cid)["notebook"] == mine["id"], "the analyst's group, not the one active on the canvas"
    events = [e for e in investigation._read_jsonl(investigation.inv_dir(CORPUS, MAIN) / "events.jsonl") if e.get("type") == "card-request"]
    assert events == [{**events[0], "request": "ab12", "card": cid}]
    assert tools.request_of("request:ab12") == "ab12" and tools.request_of("Your work") is None and tools.request_of("request:a b") is None
