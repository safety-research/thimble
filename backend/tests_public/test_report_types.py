"""report_types.py: the types, the frame, comments and edits over any shape, the export, the editor's blocks and the
page's html. write_document and edit_document are tested in test_document_tools.py. No model call and no kernel."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app import config, investigation, notebook, report, report_types
from app import story as story_mod

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
def ws(workspaces_tmp):
    return config.workspace_dir(CORPUS)


@pytest.fixture()
def inv(ws):
    """An investigation with a report whose one sentence cites a real cell (27), plus a table-bearing cell."""
    made = {"id": investigation.MAIN}
    nb = notebook.create_notebook(ws, "Exploration", role="exploration", investigation=made["id"])
    cell = notebook.new_cell("code", "run", "How many deletions?", nb["id"], code="print(27)")
    cell["status"], cell["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    table = notebook.new_cell("code", "run", "Deletions per account", nb["id"], code="df")
    table["status"] = "ok"
    table["outputs"] = [{"text/html": "<table><tr><th></th><th>count</th><th>share</th></tr>"
                                      "<tr><th>alice</th><td>27</td><td>0.75</td></tr><tr><th>bob</th><td>9</td><td>0.25</td></tr></table>",
                         "text/plain": "count share\nalice 27 0.75\nbob 9 0.25"}]
    nb["cells"] += [cell, table]
    notebook.write_notebook(ws, nb)
    doc = {"id": "report", "type": "report", "renderer": "document", "title": "One account issued every deletion", "generation": 1,
           "sections": [{"id": "sec1", "role": "finding", "heading": "One account", "figures": [],
                         "paragraphs": [{"id": "p1", "sentences": [
                             {"id": "s1", "text": f"All [[27|card:{cell['id']}]] deletions came from one account.",
                              "refs": [f"card:{cell['id']}"], "tags": ["fact"], "tag_notes": {}}]}]}],
           "comments": [], "locked": []}
    report_types.write_doc(CORPUS, made["id"], "report", doc)
    return made["id"], cell["id"], table["id"]


def _main_report(cid: str, tid: str) -> dict:
    """A two-section report in `main`; returns the stored document."""
    doc = {"id": "report", "type": "report", "renderer": "document", "title": "One account issued every deletion", "generation": 1,
           "generated_at": "2026-09-09T00:00:00+00:00",
           "sections": [
               {"id": "sec1", "role": "finding", "heading": "One account", "figures": [],
                "paragraphs": [{"id": "p1", "sentences": [
                    {"id": "s1", "text": f"All [[27|card:{cid}]] deletions came from one account.", "refs": [f"card:{cid}"], "tags": ["fact"], "tag_notes": {}},
                    {"id": "s2", "text": "The operator meant to hide the change.", "refs": [], "tags": ["judgment"], "tag_notes": {"judgment": "a reading"}}]}]},
               {"id": "sec2", "role": "caveats", "heading": "Caveats", "figures": [],
                "paragraphs": [{"id": "p2", "sentences": [
                    {"id": "s3", "text": f"Bob issued [[9|card:{tid}#count/bob]] deletions.", "refs": [f"card:{tid}"], "tags": ["fact"], "tag_notes": {}}]}]}],
           "comments": [], "locked": []}
    report_types.write_doc(CORPUS, MAIN, "report", doc)
    return report_types.read_doc(CORPUS, MAIN, "report")


# --------------------------------------------------------------------------- types


def test_builtins_are_listed_first_and_read_only(ws):
    types = report_types.list_types(CORPUS)
    assert [t["slug"] for t in types] == ["report", "story", "slides"] and all(t["builtin"] for t in types)
    story = types[1]
    # a form says what it is and shows its markdown; how to save it is the writer agent's, said once there
    assert story["renderer"] == "story" and "    # " in story["prompt"] and "`- ` bullets" in story["prompt"] and "schema" not in story
    assert "    # " in types[0]["prompt"] and "{{" not in types[0]["prompt"] and "900 words" in types[0]["prompt"] and "params" not in types[0]


async def test_builtin_edit_and_delete_are_refused(ws):
    with pytest.raises(HTTPException) as e:
        await report_types.update_type_route(CORPUS, "slides", report_types.TypeEdit(name="x"))
    assert e.value.status_code == 409
    with pytest.raises(HTTPException) as e:
        await report_types.delete_type_route(CORPUS, "story")
    assert e.value.status_code == 409


async def test_create_update_delete_custom_type(ws):
    body = report_types.TypeBody(slug="memo", name="Safety memo", description="One page for the safety lead.",
                                 renderer="document", prompt="# Memo\n\nWrite a memo.", rubric="### Rigor\n1. True.")
    t = await report_types.create_type_route(CORPUS, body)
    assert t["slug"] == "memo" and t["builtin"] is False and t["created_by"] == "analyst"
    assert "{{material}}" not in t["prompt"] and t["prompt"].rstrip().endswith("Write a memo.")
    assert [x["slug"] for x in report_types.list_types(CORPUS)] == ["report", "story", "slides", "memo"]
    with pytest.raises(HTTPException) as e:
        await report_types.create_type_route(CORPUS, body)
    assert e.value.status_code == 409
    t2 = await report_types.update_type_route(CORPUS, "memo", report_types.TypeEdit(renderer="slides", rubric="### Rigor\n1. Still true."))
    assert t2["renderer"] == "slides" and "Still true" in t2["rubric"] and t2["name"] == "Safety memo"
    await report_types.delete_type_route(CORPUS, "memo")
    assert report_types.read_type(CORPUS, "memo") is None
    for bad in ("report", "Bad Slug", "a", "versions"):
        with pytest.raises(HTTPException) as e:
            await report_types.create_type_route(CORPUS, report_types.TypeBody(slug=bad, name="x", renderer="document", prompt="p"))
        assert e.value.status_code == 400


# --------------------------------------------------------------------------- shapes


def test_shape_adapters_cover_the_shapes(ws):
    sections = {"renderer": "document", "sections": [{"id": "a", "heading": "H", "paragraphs": [{"id": "p", "sentences": [{"id": "s", "text": "t", "refs": [], "tags": []}]}]}]}
    slides_ = {"renderer": "slides", "slides": [{"id": "a", "heading": "H", "sentences": [{"id": "s", "text": "t", "refs": [], "tags": []}]}]}
    beats = {"renderer": "story", "answer": {"id": "ans", "text": "A", "refs": [], "tags": []},
             "beats": [{"id": "a", "heading": "H", "sentences": [{"id": "s", "text": "t", "refs": [], "tags": []}]}]}
    custom = {"renderer": "custom", "title": "T", "items": [{"id": "a", "heading": "H", "claims": [{"id": "s", "text": "t", "refs": [], "tags": []}]}],
              "lead": {"id": "l", "text": "lead", "refs": [], "tags": []}}
    for doc in (sections, slides_, beats, custom):
        assert [u["id"] for u in report_types.units(doc)] == ["a"] and [x["id"] for x in report_types.unit_sentences(report_types.units(doc)[0])] == ["s"]
        assert report_types.find_target(doc, "s")["kind"] == "sentence" and report_types.find_target(doc, "a")["kind"] == "heading"
    assert [x["id"] for x in report_types.all_sentences(beats)] == ["ans", "s"] and report_types.find_target(beats, "ans")["unit"] is None
    assert {x["id"] for x in report_types.all_sentences(custom)} == {"s", "l"} and report_types._ids(custom) >= {"a", "s", "l"}
    assert report_types.find_paragraph(sections, "p")[1]["id"] == "p" and report_types.find_paragraph(slides_, "p") is None
    with pytest.raises(HTTPException):
        report_types.find_target(sections, "nope")


# --------------------------------------------------------------------------- comments and edits over any type


async def test_the_type_cards_state(inv, monkeypatch):
    inv_id, cid, _ = inv
    state = await report_types.types_state_route(CORPUS, inv_id)
    assert state["report"]["exists"] is True and state["report"]["generation"] == 1 and state["report"]["open_comments"] == 0
    assert state["story"] == {"exists": False, "renderer": "story", "frame": False, "name": "Story"}
    report_types.add_section(CORPUS, "story", "Opening", inv_id=inv_id)
    assert (await report_types.types_state_route(CORPUS, inv_id))["story"]["frame"] is True


# --------------------------------------------------------------------------- the export


def test_export_markdown_renders_every_section_with_citations_and_the_appendix(inv):
    inv_id, cid, tid = inv
    doc = {"id": "report", "type": "report", "renderer": "document", "title": "One account issued every deletion", "generation": 3, "comments": [], "locked": [],
           "sections": [
               {"id": "sec-data", "role": "data", "heading": "Data", "figures": [],
                "paragraphs": [{"id": "para0", "sentences": [{"id": "sent0", "text": "The corpus is a board export and a forge database.", "refs": ["board.jsonl#L1"], "tags": ["fact"], "tag_notes": {}}]}]},
               {"id": "sec-take", "role": "takeaways", "heading": "Main takeaways", "figures": [],
                "paragraphs": [{"id": "para2", "sentences": [{"id": "sent3", "text": f"One account issued all [[27|card:{cid}@out0#L1]] deletions.", "refs": [f"card:{cid}@out0#L1"], "tags": ["fact"], "tag_notes": {}}]}]},
               {"id": "sec-find", "role": "finding", "heading": "One account issued the deletions",
                "figures": [{"id": "figA", "cell": f"card:{tid}", "caption": "Deletions by account.", "after_paragraph": None}],
                "paragraphs": [{"id": "para1", "sentences": [
                    {"id": "sent1", "text": f"At 09:04 the first post went up and [[27|card:{cid}]] deletions followed.", "refs": ["board.jsonl#L1", f"card:{cid}"], "tags": ["fact"], "tag_notes": {}},
                    {"id": "sent4", "text": "Alice's share was 0.75.", "refs": [f"card:{tid}#share/alice", "events.jsonl#L2", "forge.db#prs/1"], "tags": ["fact"], "tag_notes": {}}]}]},
               {"id": "sec-unc", "role": "uncertainty", "heading": "Uncertainty", "figures": [],
                "paragraphs": [{"id": "para3", "sentences": [{"id": "sent2", "text": "Nothing else is dated.", "refs": ["claim:deadbeef", "card:nope0000"], "tags": ["unverified"], "tag_notes": {"unverified": "x"}}]}]},
               {"id": "sec-lim", "role": "caveats", "heading": "Limitations", "figures": [],
                "paragraphs": [{"id": "para4", "sentences": [{"id": "sent6", "text": "The forge database was read for pull requests alone.", "refs": [], "tags": ["caveat"], "tag_notes": {}}]}]}]}
    report_types.write_doc(CORPUS, inv_id, "report", doc)
    out = report_types.export_markdown(CORPUS, inv_id, "report")
    md = out["markdown"]
    assert md.splitlines()[0] == "# One account issued every deletion"
    assert [ln for ln in md.splitlines() if ln.startswith("## ")] == ["## Data", "## Main takeaways", "## One account issued the deletions", "## Uncertainty", "## Limitations"]
    assert out["sections"] == 5 and out["sentences"] == 6 and out["has_tldr"] is False
    assert "The corpus is a board export and a forge database. [board.jsonl#L1 (id 1, 2026-03-12T09:04:27)]" in md
    assert f"One account issued all 27 deletions. [card:{cid}:out0/L1]" in md and "[[" not in md
    assert "Nothing else is dated. [unverified]\n" in md
    assert f"Alice's share was 0.75. [card:{tid}:share×alice; events.jsonl#L2 (id 2, 2026-03-12T09:00:02); forge.db#prs/1]" in md
    assert f"*Figure: Deletions by account.* [card:{tid}]" in md and report_types.CELLS_HEADING not in md
    for ident in ("sec-data", "para0", "sent0", "figA", "deadbeef", "nope0000", "claim:"):
        assert ident not in md, ident
    full = report_types.export_markdown(CORPUS, inv_id, "report", appendix=True)
    body, sep, tail = full["markdown"].partition(f"## {report_types.CELLS_HEADING}")
    assert sep and body == md + "\n" and full["appendix"] is True and f"- card:{cid}: How many deletions?" in tail


async def test_the_export_route_serves_any_written_type_and_404s_before(inv):
    inv_id, cid, _ = inv
    with pytest.raises(HTTPException) as e:
        await report_types.export_route(CORPUS, inv_id, "story")
    assert e.value.status_code == 404
    out = await report_types.export_route(CORPUS, inv_id, "report")
    assert f"All 27 deletions came from one account. [card:{cid}]" in out["markdown"]
    paths = {getattr(r, "path", "") for r in report_types.router.routes}
    for p in ("/ws/{c}/investigations/{inv_id}/types/{slug}/export", "/ws/{c}/investigations/{inv_id}/types/{slug}/frame",
              "/ws/{c}/investigations/{inv_id}/types/{slug}/frame/sections/{sid}/figures", "/ws/{c}/investigations/{inv_id}/types/{slug}/frame/units/{uid}",
              "/ws/{c}/investigations/{inv_id}/types/{slug}/comments", "/ws/{c}/investigations/{inv_id}/types/{slug}/sentences/{sid}"):
        assert p in paths, p
    # the server writes nothing itself: the writer is the session's agent
    for gone in ("/ws/{c}/investigations/{inv_id}/types/{slug}/generate", "/ws/{c}/investigations/{inv_id}/types/{slug}/rewrite",
                 "/ws/{c}/investigations/{inv_id}/types/{slug}/figures", "/ws/{c}/investigations/{inv_id}/types/{slug}/verifier",
                 "/ws/{c}/report-types/draft"):
        assert gone not in paths, gone


def test_readable_ids_in_the_verifiers_prose():
    r = report_types.readable_ids
    assert r("Worth knowing that cell 90114875's own takeaway says so.") == "Worth knowing that card:90114875's own takeaway says so."
    assert r("The cell does exist (notebook e2c3384e) and sentence 8abe4da0 repeats it.") == "The cell does exist (the notebook) and the sentence repeats it."
    cells, doc = {"90114875", "ad694cb0"}, {"8abe4da0", "e2c3384e"}
    assert r("The value on 90114875@out0#L3 is 27.") == "The value on card:90114875@out0#L3 is 27."
    assert r("The takeaway of 90114875 says so; the claim (8abe4da0) repeats it, as does ad694cb0.", cells=cells, doc_ids=doc) == \
        "The takeaway of card:90114875 says so; the claim repeats it, as does card:ad694cb0."
    assert r("8abe4da0", cells=cells, doc_ids=doc) == ""
    assert r("two session ids, c5cd0306 and ca74c1aa", cells=cells, doc_ids=doc) == "two session ids, c5cd0306 and ca74c1aa"


# --------------------------------------------------------------------------- the frame


async def test_the_frame_is_laid_out_and_edited(inv):
    inv_id, cid, tid = inv
    empty = await report_types.frame_route(CORPUS, inv_id, "story")
    assert empty == {"id": "story", "type": "story", "renderer": "story", "title": "", "sections": [], "frame": True, "generation": 0}
    sec = await report_types.frame_section_route(CORPUS, inv_id, "story", report_types.FrameSectionBody(heading="Who deleted what"))
    assert sec["pinned"] is True and sec["by"] == "analyst" and sec["heading"] == "Who deleted what" and len(sec["id"]) == 8
    para = await report_types.frame_paragraph_route(CORPUS, inv_id, "story", sec["id"], report_types.FrameParagraphBody(text=f"Alice did most [[card:{tid}]]. Say why."))
    assert [x["text"] for x in para["sentences"]] == [f"Alice did most [[card:{tid}]].", "Say why."] and para["sentences"][0]["refs"] == [f"card:{tid}"]
    fig = await report_types.frame_figure_route(CORPUS, inv_id, "story", sec["id"], report_types.FrameFigureBody(cell=f"card:{tid}"))
    # a story section's first figure is its card
    assert fig == {"id": fig["id"], "cell": f"card:{tid}", "caption": "Deletions per account", "after_paragraph": None, "pinned": True,
                   "by": "analyst", "role": "main"}
    with pytest.raises(HTTPException) as e:
        await report_types.frame_figure_route(CORPUS, inv_id, "story", sec["id"], report_types.FrameFigureBody(cell="card:nope0000"))
    assert e.value.status_code == 404
    frame = await report_types.frame_route(CORPUS, inv_id, "story")
    assert frame["frame"] is True and len(frame["sections"]) == 1 and frame["sections"][0]["figures"][0]["id"] == fig["id"]
    frame = await report_types.frame_edit_route(CORPUS, inv_id, "story", fig["id"], report_types.FrameUnitEdit(caption="Who deleted what, by account."))
    assert frame["sections"][0]["figures"][0]["caption"] == "Who deleted what, by account."
    frame = await report_types.frame_edit_route(CORPUS, inv_id, "story", para["id"], report_types.FrameUnitEdit(text="One bullet only."))
    assert [x["text"] for x in frame["sections"][0]["paragraphs"][0]["sentences"]] == ["One bullet only."]
    extra = await report_types.frame_section_route(CORPUS, inv_id, "story", report_types.FrameSectionBody(heading="Gone"))
    frame = await report_types.frame_delete_route(CORPUS, inv_id, "story", extra["id"])
    assert [s["heading"] for s in frame["sections"]] == ["Who deleted what"]


async def test_the_frame_routes_add_pinned_units_to_a_written_document(inv):
    inv_id, cid, tid = inv
    doc = report_types.read_doc(CORPUS, inv_id, "report")
    para = report_types.add_paragraph(CORPUS, "report", "sec1", "The analyst's own paragraph.", inv_id=inv_id)
    doc = report_types.read_doc(CORPUS, inv_id, "report")
    assert doc["sections"][0]["paragraphs"][1]["pinned"] is True
    assert "locked" not in doc and report_types.locked_refs(doc, "report") == [], "text the analyst types is not locked"
    fig = report_types.add_frame_figure(CORPUS, "report", "sec1", tid, "Per account.", after=f"report:report#{para['id']}", inv_id=inv_id)
    doc = report_types.read_doc(CORPUS, inv_id, "report")
    assert doc["sections"][0]["figures"][0] == {**fig, "after_paragraph": para["id"]}
    with pytest.raises(HTTPException) as e:
        report_types.delete_unit(CORPUS, "report", "p1", inv_id=inv_id)  # the writer's paragraph is not the frame's to remove
    assert e.value.status_code == 409
    doc = report_types.delete_unit(CORPUS, "report", para["id"], inv_id=inv_id)
    assert len(doc["sections"][0]["paragraphs"]) == 1 and "locked" not in doc
    sec = report_types.add_section(CORPUS, "report", "A new section", inv_id=inv_id)
    assert report_types.read_doc(CORPUS, inv_id, "report")["sections"][1]["id"] == sec["id"] and sec["role"] == "custom"


# --------------------------------------------------------------------------- the editor's blocks


def _blocks(*items: dict) -> list:
    return [report_types.BlockIn(**it) for it in items]


def _report_events(slug: str = "report") -> list[dict]:
    return [e for e in investigation._read_jsonl(investigation.inv_dir(CORPUS, MAIN) / "events.jsonl") if e.get("type") == "report" and e.get("slug") == slug]


async def test_blocks_keep_unchanged_sentences_and_mark_the_analysts_own(inv):
    inv_id, cid, tid = inv
    doc = _main_report(cid, tid)
    doc["comments"] = [{"id": "v1", "sentence_id": "s1", "text": "ok", "author": "verifier", "kind": "verified", "ts": "t", "status": "open"},
                       {"id": "v2", "sentence_id": "s3", "text": "hmm", "author": "verifier", "kind": "caveat", "ts": "t", "status": "open"},
                       {"id": "v3", "sentence_id": "sec2", "text": "the section", "author": "verifier", "kind": "caveat", "ts": "t", "status": "open"}]
    report_types.write_doc(CORPUS, MAIN, "report", doc)
    body = report_types.BlocksBody(title="One account issued every deletion", client="tab1", blocks=_blocks(
        {"id": "sec1", "type": "heading", "text": "One account", "level": 2},
        {"id": "p1", "type": "paragraph", "text": f"All [[27|card:{cid}]] deletions came from one account. The operator hid the change."},
        {"id": "newp", "type": "paragraph", "text": f"My own words [[card:{tid}]]."},
        {"id": "f-new", "type": "figure", "cell": f"card:{tid}", "caption": "Per account"},
        {"id": "sec-new", "type": "heading", "text": "Bullets"},
        {"id": "b1", "type": "bullet", "text": "first point"},
        {"id": "b2", "type": "bullet", "text": "second point", "marker": "1."},
        {"id": "empty", "type": "paragraph", "text": "   "},
    ))
    out = await report_types.blocks_route(CORPUS, MAIN, "report", body)
    secs = out["sections"]
    assert [s["id"] for s in secs] == ["sec1", "sec-new"] and secs[0]["role"] == "finding" and "pinned" not in secs[0]
    assert [cm["id"] for cm in out["comments"]] == ["v1"]  # sec2 and s3 are gone, so are their comments
    p1 = secs[0]["paragraphs"][0]
    s = p1["sentences"]
    assert p1["id"] == "p1" and len(s) == 2
    assert s[0]["id"] == "s1" and s[0]["refs"] == [f"card:{cid}"] and s[0]["tags"] == ["fact"] and "by" not in s[0]
    assert s[1]["id"] != "s2" and s[1]["text"] == "The operator hid the change." and s[1]["by"] == "analyst" and s[1]["pinned"] is True and s[1]["refs"] == []
    newp = secs[0]["paragraphs"][1]
    assert newp["id"] == "newp" and newp["pinned"] is True and newp["by"] == "analyst" and newp["sentences"][0]["refs"] == [f"card:{tid}"]
    fig = secs[0]["figures"][0]
    assert fig == {"id": "f-new", "cell": f"card:{tid}", "caption": "Per account", "after_paragraph": "newp", "pinned": True, "by": "analyst"}
    assert secs[1]["heading"] == "Bullets" and secs[1]["role"] == "custom" and secs[1]["pinned"] is True and secs[1]["by"] == "analyst"
    paras = secs[1]["paragraphs"]
    assert [[x["text"] for x in p["sentences"]] for p in paras] == [["first point"], ["second point"]]
    assert paras[0]["sentences"][0]["bullet"] == "-" and paras[1]["sentences"][0]["bullet"] == "1." and paras[0]["sentences"][0]["id"] == "b1" and paras[1]["sentences"][0]["id"] == "b2"
    assert "locked" not in out and report_types.locked_refs(out, "report") == [], "what the analyst typed is theirs, not locked"
    assert out["title"] == "One account issued every deletion"
    ev = _report_events()[-1]
    assert ev == {**ev, "status": "edited", "by": "analyst", "client": "tab1"}
    stored = report_types.read_doc(CORPUS, MAIN, "report")
    assert stored["sections"][0]["paragraphs"][0]["sentences"][0]["id"] == "s1" and stored["generation"] == 1


async def test_blocks_respell_a_sentence_without_marking_it_and_leave_a_changed_heading_and_title_unlocked(inv):
    inv_id, cid, tid = inv
    _main_report(cid, tid)
    body = report_types.BlocksBody(title="A new title", blocks=_blocks(
        {"id": "sec1", "type": "heading", "text": "One account, renamed"},
        {"id": "p1", "type": "paragraph", "text": f"All [[27|card:{cid}]] deletions came from one account. The operator **meant** to hide the change."},
        {"id": "sec2", "type": "heading", "text": "Caveats"},
        {"id": "p2", "type": "paragraph", "text": f"Bob issued [[9|card:{tid}#count/bob]] deletions."},
    ))
    out = await report_types.blocks_route(CORPUS, MAIN, "report", body)
    assert out["title"] == "A new title" and out["title_history"][0]["text"] == "One account issued every deletion" and out["title_edited_by"] == "analyst"
    sec = out["sections"][0]
    assert sec["heading"] == "One account, renamed" and sec["edited_by"] == "analyst" and sec["history"][0]["text"] == "One account" and sec["role"] == "finding"
    s2 = sec["paragraphs"][0]["sentences"][1]
    assert s2["id"] == "s2" and s2["text"] == "The operator **meant** to hide the change." and s2["tags"] == ["judgment"] and "by" not in s2
    assert out["sections"][1]["paragraphs"][0]["sentences"][0]["id"] == "s3"
    assert "locked" not in out and report_types.locked_refs(out, "report") == []
    assert report_types.sentence_key(f"All [[27|card:{cid}]] deletions") == report_types.sentence_key("all 27  deletions") and report_types.sentence_key("`card:abc`") == report_types.sentence_key("[[card:abc]]")


async def test_blocks_into_a_frame_pin_everything_and_a_second_save_keeps_the_ids(inv):
    inv_id, cid, tid = inv
    await report_types.create_type_route(CORPUS, report_types.TypeBody(slug="memo", name="Memo", renderer="document", prompt="# Memo\n\nA memo.", rubric=""))
    body = report_types.BlocksBody(title="", blocks=_blocks(
        {"id": "x1", "type": "heading", "text": "Who deleted what"},
        {"id": "x2", "type": "bullet", "text": f"Alice did most [[card:{tid}]]."},
        {"id": "x3", "type": "bullet", "text": "Say why."},
        {"id": "x4", "type": "figure", "cell": f"card:{tid}"},
        {"id": "x5", "type": "figure", "cell": "card:nope0000", "caption": "dropped"},
        {"id": "x6", "type": "figure", "caption": "not picked yet"},
    ))
    frame = await report_types.blocks_route(CORPUS, inv_id, "memo", body)
    assert frame["frame"] is True and frame["generation"] == 0 and "locked" not in frame
    assert report_types.read_frame(CORPUS, inv_id, "memo")["sections"][0]["id"] == "x1"
    sec = frame["sections"][0]
    assert sec["pinned"] is True and sec["by"] == "analyst" and sec["role"] == "custom" and len(sec["paragraphs"]) == 1
    para = sec["paragraphs"][0]
    assert para["pinned"] is True and [x["id"] for x in para["sentences"]] == ["x2", "x3"] and all(x["bullet"] == "-" and x["pinned"] for x in para["sentences"])
    assert para["sentences"][0]["refs"] == [f"card:{tid}"]
    assert [f["id"] for f in sec["figures"]] == ["x4"] and sec["figures"][0]["caption"] == "Deletions per account" and sec["figures"][0]["after_paragraph"] == para["id"]
    assert "Who deleted what" in "\n".join(report_types.document_lines(frame)) and (await report_types.frame_route(CORPUS, inv_id, "memo"))["sections"][0]["id"] == "x1"
    assert [e["status"] for e in _report_events("memo")] == ["edited"]
    body2 = report_types.BlocksBody(title="T", blocks=_blocks(
        {"id": "x1", "type": "heading", "text": "Who deleted what"},
        {"id": "x4", "type": "figure", "cell": f"card:{tid}", "caption": "By account"},
        {"id": "x3", "type": "bullet", "text": "Say why."},
        {"id": "x2", "type": "bullet", "text": "Alice did most of it."},
        {"id": "x7", "type": "paragraph", "text": "Prose after the list.", "children": [{"id": "x8", "type": "paragraph", "text": "Nested prose."}]},
    ))
    frame2 = await report_types.blocks_route(CORPUS, inv_id, "memo", body2)
    sec2 = frame2["sections"][0]
    assert frame2["title"] == "T" and sec2["figures"][0] == {**sec2["figures"][0], "caption": "By account", "after_paragraph": None, "lead": True}
    items = sec2["paragraphs"][0]["sentences"]
    assert [x["id"] for x in items] == ["x3", "x2"] and sec2["paragraphs"][0]["id"] == para["id"] and items[1]["text"] == "Alice did most of it."
    assert [[x["text"] for x in p["sentences"]] for p in sec2["paragraphs"][1:]] == [["Prose after the list."], ["Nested prose."]]
    # a deck's frame has slides, which the deck's own editor saves (PUT …/deck), so it takes no blocks
    with pytest.raises(HTTPException) as e:
        await report_types.blocks_route(CORPUS, inv_id, "slides", report_types.BlocksBody(blocks=_blocks({"id": "a", "type": "heading", "text": "h"})))
    assert e.value.status_code == 409
    deck = await report_types.deck_route(CORPUS, inv_id, "slides", report_types.DeckBody(slides=[
        report_types.SlideIn(id="a", heading="h", layout="text", lines=[report_types.SlideLineIn(id="b", text="One point.")])]))
    assert deck["frame"] is True and deck["renderer"] == "slides" and [s["heading"] for s in deck["slides"]] == ["h"]
    assert report_types.read_frame(CORPUS, inv_id, "slides")["slides"][0]["sentences"][0]["id"] == "b"
    # a story's frame is saved by the story's own editor (PUT …/story), so it takes no blocks either
    with pytest.raises(HTTPException) as e:
        await report_types.blocks_route(CORPUS, inv_id, "story", report_types.BlocksBody(title="A title", blocks=_blocks({"id": "c", "type": "paragraph", "text": "The answer."})))
    assert e.value.status_code == 409
    story = await report_types.story_route(CORPUS, inv_id, "story", report_types.StoryBody(title="A title", sections=[
        story_mod.StorySectionIn(id="s0", blocks=[story_mod.StoryBlockIn(id="c", type="text", text="The answer.")])]))
    assert story["title"] == "A title" and story["sections"][0]["heading"] == "" and story["sections"][0]["paragraphs"][0]["id"] == "c"
    report_types.write_doc(CORPUS, inv_id, "slides", {"id": "slides", "type": "slides", "renderer": "slides", "title": "Deck", "slides": [], "generation": 1})
    with pytest.raises(HTTPException) as e:
        await report_types.blocks_route(CORPUS, inv_id, "slides", report_types.BlocksBody(blocks=_blocks({"id": "a", "type": "heading", "text": "h"})))
    assert e.value.status_code == 409
    with pytest.raises(HTTPException) as e:
        report_types.apply_blocks({"sections": []}, "", _blocks({"id": "a", "type": "nope"}), report._Refs(CORPUS), is_doc=False)
    assert e.value.status_code == 400


async def test_blocks_supersede_the_verifiers_comment_on_a_changed_bullet_and_the_route_is_registered(inv):
    inv_id, cid, tid = inv
    doc = _main_report(cid, tid)
    doc["sections"][0]["paragraphs"][0]["sentences"][1]["bullet"] = "-"
    doc["sections"][0]["paragraphs"][0]["sentences"][0]["bullet"] = "-"
    doc["comments"] = [{"id": "v1", "sentence_id": "s2", "text": "read in", "author": "verifier", "kind": "judgment", "ts": "t", "status": "open"},
                       {"id": "a1", "sentence_id": "s2", "text": "mine", "author": "analyst", "ts": "t", "status": "open"}]
    report_types.write_doc(CORPUS, MAIN, "report", doc)
    out = await report_types.blocks_route(CORPUS, MAIN, "report", report_types.BlocksBody(title=doc["title"], blocks=_blocks(
        {"id": "sec1", "type": "heading", "text": "One account"},
        {"id": "s1", "type": "bullet", "text": f"All [[27|card:{cid}]] deletions came from one account."},
        {"id": "s2", "type": "bullet", "text": "The operator logged the change."},
        {"id": "sec2", "type": "heading", "text": "Caveats"},
        {"id": "p2", "type": "paragraph", "text": f"Bob issued [[9|card:{tid}#count/bob]] deletions."},
    )))
    para = out["sections"][0]["paragraphs"][0]
    assert para["id"] == "p1" and [x["id"] for x in para["sentences"]] == ["s1", "s2"] and para["sentences"][1]["by"] == "analyst" and "by" not in para["sentences"][0]
    by_id = {cm["id"]: cm for cm in out["comments"]}
    assert by_id["v1"]["status"] == "dismissed" and by_id["v1"]["resolution"] == "superseded" and by_id["a1"]["status"] == "open"
    assert report_types.locked_refs(out, "report") == []
    # a sentence moved into a new paragraph (a split) keeps its record; the new paragraph is the analyst's
    out = await report_types.blocks_route(CORPUS, MAIN, "report", report_types.BlocksBody(title=doc["title"], blocks=_blocks(
        {"id": "sec1", "type": "heading", "text": "One account"},
        {"id": "p1", "type": "paragraph", "text": f"All [[27|card:{cid}]] deletions came from one account."},
        {"id": "split-uuid", "type": "paragraph", "text": "The operator logged the change."},
        {"id": "sec2", "type": "heading", "text": "Caveats"},
        {"id": "p2", "type": "paragraph", "text": f"Bob issued [[9|card:{tid}#count/bob]] deletions."},
    )))
    paras = out["sections"][0]["paragraphs"]
    assert [p["id"] for p in paras] == ["p1", "split-uuid"] and paras[1]["pinned"] is True
    assert [x["id"] for x in paras[0]["sentences"]] == ["s1"] and "bullet" not in paras[0]["sentences"][0]
    assert paras[1]["sentences"][0]["id"] == "s2" and paras[1]["sentences"][0]["by"] == "analyst" and report_types.locked_refs(out, "report") == []
    paths = {getattr(r, "path", "") for r in report_types.router.routes}
    assert "/ws/{c}/investigations/{inv_id}/types/{slug}/blocks" in paths


# --------------------------------------------------------------------------- pages: a custom type of one html document


async def test_a_page_type_is_custom_without_a_component_and_the_html_route_holds_the_analysts_page(inv):
    inv_id, cid, _ = inv
    t = await report_types.create_type_route(CORPUS, report_types.TypeBody(name="page", renderer="custom", prompt="", page=True))
    assert t["slug"] == "page" and t["page"] is True and t["renderer"] == "custom" and "component" not in t and t["builtin"] is False
    assert set(t["schema"]["properties"]) == {"title", "html", "claims"} and t["schema"]["properties"]["claims"]["items"]["type"] == "string"
    assert t["prompt"].strip() == report_types.PAGE_PROMPT and "{{material}}" not in t["prompt"]
    form = report_types.type_form(t)
    assert "```html" in form and report_types.PAGE_PROMPT in form
    with pytest.raises(HTTPException) as e:
        await report_types.create_type_route(CORPUS, report_types.TypeBody(name="page 2", renderer="slides", prompt="", page=True))
    assert e.value.status_code == 400
    t2 = await report_types.create_type_route(CORPUS, report_types.TypeBody(name="page 2", renderer="custom", prompt="", page=True))
    assert t2["slug"] == "page-2" and [x["slug"] for x in report_types.list_types(CORPUS)] == ["report", "story", "slides", "page", "page-2"]
    state = await report_types.types_state_route(CORPUS, inv_id)
    assert state["page"] == {"exists": False, "renderer": "custom", "frame": False, "name": "page", "page": True}
    assert state["story"]["name"] == "Story" and "page" not in state["report"]
    with pytest.raises(HTTPException) as e:
        await report_types.put_html_route(CORPUS, inv_id, "story", report_types.HtmlBody(html="<p>x</p>"))
    assert e.value.status_code == 409
    doc = await report_types.put_html_route(CORPUS, inv_id, "page", report_types.HtmlBody(html="<h1>Hi</h1>\r\n<p>x</p>"))
    assert doc["html"] == "<h1>Hi</h1>\n<p>x</p>" and doc["generation"] == 0 and doc["html_edited_by"] == "analyst" and doc["claims"] == []
    stored = report_types.read_doc(CORPUS, inv_id, "page")
    assert stored["html"] == doc["html"] and stored["renderer"] == "custom" and stored["title"] == "page" and report_types.all_sentences(stored) == []
    assert (await report_types.types_state_route(CORPUS, inv_id))["page"]["exists"] is True
    doc2 = await report_types.put_html_route(CORPUS, inv_id, "page", report_types.HtmlBody(html="<p>y</p>"))
    assert doc2["html"] == "<p>y</p>" and doc2["title"] == "page" and doc2["generation"] == 0
    t3 = await report_types.update_type_route(CORPUS, "page", report_types.TypeEdit(name="overview"))
    assert t3["page"] is True and t3["name"] == "overview" and "component" not in t3 and t3["schema_source"] == report_types.PAGE_SCHEMA


async def test_a_pages_export_holds_its_html_and_its_claims(inv):
    """A page has no sections, so its export is its html whole (every row of its table) and its claims under the
    title, never the title alone."""
    inv_id, cid, _ = inv
    await report_types.new_document_route(CORPUS, report_types.NewDocBody(kind="comparison", name="Matrix"))
    rows = "".join(f"<tr><td>R{i}</td><td>{i * 3}</td></tr>" for i in range(1, 8))
    html = f"<!doctype html><html><head><style>td{{padding:4px}}</style></head><body><table>{rows}</table></body></html>"
    doc = {"id": "matrix", "type": "matrix", "renderer": "custom", "title": "Seven runs side by side", "generation": 1,
           "html": html, "comments": [], "locked": [],
           "claims": [{"id": "c1", "text": f"R1 issued [[27|card:{cid}]] deletions.", "refs": [f"card:{cid}"], "tags": ["fact"], "tag_notes": {}},
                      {"id": "c2", "text": "R7 wrote the most.", "refs": [], "tags": ["judgment"], "tag_notes": {}}]}
    report_types.write_doc(CORPUS, inv_id, "matrix", doc)
    out = await report_types.export_route(CORPUS, inv_id, "matrix")
    assert out["html"] == html and all(f"<td>R{i}</td>" in out["html"] for i in range(1, 8))
    assert out["markdown"].splitlines()[:4] == ["# Seven runs side by side", "", f"- R1 issued 27 deletions. [card:{cid}]", "- R7 wrote the most."]
    assert out["sentences"] == 2
    assert "html" not in await report_types.export_route(CORPUS, inv_id, "report")


async def test_new_documents_from_presets_and_the_deck_editors_layouts(inv):
    """+ New's documents (a preset's text read from its file, a page preset, one of the analyst's own), and the deck's
    editor: a slide of each layout, a figure on any card, a quote with its speaker, and a second save keeping the ids."""
    inv_id, cid, tid = inv
    assert [p["id"] for p in report_types.presets()] == ["casefile", "comparison", "timeline"]
    case = await report_types.new_document_route(CORPUS, report_types.NewDocBody(kind="casefile"))
    assert case["preset"] == "casefile" and case["renderer"] == "document" and case["prompt"] == report_types.preset("casefile")["prompt"]
    grid = await report_types.new_document_route(CORPUS, report_types.NewDocBody(kind="comparison"))
    assert grid["page"] is True
    with pytest.raises(HTTPException):
        await report_types.new_document_route(CORPUS, report_types.NewDocBody(kind="document", name="No brief"))
    await report_types.delete_type_route(CORPUS, case["slug"])
    assert report_types.read_type(CORPUS, case["slug"]) is None
    slides = [report_types.SlideIn(id="s1", heading="Who did it", layout="title"),
              report_types.SlideIn(id="s2", heading="One account", layout="figure", format={"side": "left", "width": 60},
                                   lines=[report_types.SlideLineIn(id="l1", text=f"Alice issued [[27|card:{cid}]].")],
                                   figures=[report_types.SlideFigureIn(cell=f"card:{tid}", caption="Per account [all]")]),
              report_types.SlideIn(id="s3", heading="Her words", layout="quote", quote=report_types.SlideQuoteIn(id="q1", text="I cleaned up.", speaker="Alice"))]
    deck = await report_types.deck_route(CORPUS, inv_id, "slides", report_types.DeckBody(slides=slides))
    s1, s2, s3 = deck["slides"]
    assert (s1["layout"], s2["layout"], s3["layout"]) == ("title", "figure", "quote") and s2["format"] == {"side": "left", "width": 60}
    assert s2["figures"][0]["caption"] == "Per account [all]" and s2["sentences"][0]["id"] == "l1" and s2["sentences"][0]["pinned"] is True
    assert s3["sentences"][0] == {**s3["sentences"][0], "id": "q1", "quote": True, "speaker": "Alice"}
    slides[1].figures[0].id = s2["figures"][0]["id"]
    again = await report_types.deck_route(CORPUS, inv_id, "slides", report_types.DeckBody(slides=list(reversed(slides))))
    assert [s["id"] for s in again["slides"]] == ["s3", "s2", "s1"] and again["slides"][1]["figures"][0]["id"] == s2["figures"][0]["id"]
