"""The analyst's locks: a locked card or document block stays fixed in every later revision, and no model can overwrite
it. A card locked in the browser (notebook.edit_cell's `locked`) is refused by
edit_card and delete_card (tools.card_locked); a block of a document locked in the editor (report_types.set_block_lock)
is refused by edit_document and put back exactly as it was and where it stood by write_document (keep_locked_blocks),
the writer's first message lists it (context.documents), and every lock, unlock and refusal is a row of the
telemetry export. The tools are called through tools.call as the analyst's session calls them; no model and no kernel.
"""
from __future__ import annotations

import pytest

from app import config, context, investigation, notebook, report_types, telemetry, tools

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
def cells(workspaces_tmp):
    """A printed count (27), a table card and a note in the analyst's group; returns their ids."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    count = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    count["status"], count["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    table = notebook.new_cell("table", "terminal", "Deletions per account", nb["id"], code="df")
    table["status"] = "ok"
    table["outputs"] = [{"text/html": "<table><tr><th></th><th>count</th></tr><tr><th>alice</th><td>27</td></tr>"
                                      "<tr><th>bob</th><td>9</td></tr></table>", "text/plain": "count\nalice 27\nbob 9"}]
    note = notebook.new_cell("note", "terminal", "What the log covers", nb["id"], payload={"text": "One week of audit rows."})
    nb["cells"] += [count, table, note]
    notebook.write_notebook(ws, nb)
    return count["id"], table["id"], note["id"]


async def call(name: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst")


def _rows(kind: str | None = None) -> list[dict]:
    rows = telemetry.build_export(CORPUS)
    return [r for r in rows if kind is None or r["kind"] == kind]


# --------------------------------------------------------------------------- cards


async def test_edit_card_and_delete_card_refuse_a_locked_card(cells):
    cid, tid, nid = cells
    locked = notebook.edit_cell(CORPUS, nid, locked=True)  # the browser's PUT /cells/{id} {locked: true}
    assert locked["locked"] is True
    before = notebook.get_cell(CORPUS, nid)
    line = tools.hint("card-locked", cid=nid)
    assert "The analyst locked" in line and "add a new card" in line
    for args in ({"text": "Two weeks of audit rows."}, {"question": "What does the log cover?"}, {"takeaway": "One week."},
                 {"group": "Elsewhere"}):
        r = await call("edit_card", card=nid, **args)
        assert r.is_error and line in r.text, (args, r.text)
    r = await call("delete_card", card=nid)
    assert r.is_error and line in r.text
    after = notebook.get_cell(CORPUS, nid)
    assert after == before, "a refused call leaves the card exactly as it was"
    assert [g["title"] for g in notebook.list_notebooks(config.workspace_dir(CORPUS))] == ["Your work"]
    # the lock is the only reason: unlocked, the same calls go through
    notebook.edit_cell(CORPUS, nid, locked=False)
    r = await call("edit_card", card=nid, text="Two weeks of audit rows.")
    assert not r.is_error, r.text
    assert notebook.get_cell(CORPUS, nid)["payload"]["text"] == "Two weeks of audit rows."
    assert not (await call("delete_card", card=nid)).is_error
    # a card of code: its takeaway and its run are refused before anything runs
    notebook.edit_cell(CORPUS, cid, locked=True)
    for args in ({"takeaway": "There are [[27|card:x]] deletions."}, {"code": "print(28)"}, {}):
        r = await call("edit_card", card=cid, **args)
        assert r.is_error and tools.hint("card-locked", cid=cid) in r.text
    assert notebook.get_cell(CORPUS, cid)["takeaway"] == "" and notebook.get_cell(CORPUS, cid)["code"] == "print(27)"


async def test_a_model_sees_the_lock_and_the_export_records_it(cells):
    cid, tid, nid = cells
    notebook.edit_cell(CORPUS, tid, locked=True)
    notebook.edit_cell(CORPUS, tid, locked=True)  # no change, no second row
    listed = (await call("list_cards", group="all")).text
    assert f"- card:{tid} [table, ok, locked]" in listed and f"- card:{cid} [code, ok]" in listed
    read = (await call("read_ref", ref=f"card:{tid}")).text
    assert f"card:{tid} (group " in read and "table, status ok, locked)" in read
    assert f"- card:{tid} · table · locked · Deletions per account" in context.canvas(CORPUS)
    await call("delete_card", card=tid)
    notebook.edit_cell(CORPUS, tid, locked=False)
    rows = [(r["kind"], r["actor"], r["target"], r["target_kind"]) for r in _rows() if r["kind"] in ("lock", "unlock", "lock-refused")]
    assert rows == [("lock", "analyst", f"card:{tid}", "cell"), ("lock-refused", "model", f"card:{tid}", "cell"),
                    ("unlock", "analyst", f"card:{tid}", "cell")]
    assert [r["detail"] for r in _rows("lock-refused")] == [{"tool": "delete_card"}]
    anon = telemetry.anonymize(_rows())
    assert [(r["kind"], r["actor"]) for r in anon if r["kind"].startswith(("lock", "unlock"))] == [
        ("lock", "analyst"), ("lock-refused", "model"), ("unlock", "analyst")]


# --------------------------------------------------------------------------- documents


REPORT = ("# One account issued every deletion\n\n"
          "## Who deleted what\n\n"
          "All [[27|card:{cid}]] deletions came from one account.\n\n"
          "![Deletions by account](card:{tid})\n\n"
          "Alice issued [[27|card:{tid}#count/alice]] of them, and Bob issued none.\n\n"
          "## What the log covers\n\n"
          "The log covers one week.\n")


async def _written(cid: str, tid: str) -> dict:
    r = await call("write_document", doc="report", text=REPORT.format(cid=cid, tid=tid))
    assert not r.is_error, r.text
    return report_types.read_doc(CORPUS, MAIN, "report")


def _texts(p: dict) -> list[str]:
    return [x["text"] for x in p["sentences"]]


async def test_edit_document_refuses_a_locked_block(cells):
    cid, tid, _ = cells
    doc = await _written(cid, tid)
    sec, sec2 = doc["sections"]
    p1, p2 = sec["paragraphs"]
    fig = sec["figures"][0]
    for bid in (p1["id"], sec["id"], fig["id"]):
        await report_types.lock_route(CORPUS, MAIN, "report", bid, report_types.LockBody(locked=True))
    for span, held in ((f"report:report#{p1['sentences'][0]['id']}", f"report:report#p{p1['id']}"),
                       (f"report:report#p{p1['id']}", f"report:report#p{p1['id']}"),
                       (f"report:report#{sec['id']}", f"report:report#{sec['id']}"),
                       (f"report:report#{fig['id']}", f"report:report#{fig['id']}")):
        r = await call("edit_document", span=span, text="Someone else did it.")
        assert r.is_error and r.text.endswith(tools.hint("edit_document-locked", ref=held)), (span, r.text)
    after = report_types.read_doc(CORPUS, MAIN, "report")
    assert after["sections"][0] == {**sec, "locked": True, "paragraphs": [{**p1, "locked": True}, p2],
                                    "figures": [{**fig, "locked": True}]}
    # a passage inserted after a locked paragraph leaves it as it is, and an unlocked passage is edited
    r = await call("edit_document", span=f"report:report#p{p1['id']}", text="The log names the account.", insert=True)
    assert not r.is_error, r.text
    r = await call("edit_document", span=f"report:report#p{p2['id']}", text="Alice issued most of them.")
    assert not r.is_error, r.text
    now = report_types.read_doc(CORPUS, MAIN, "report")["sections"][0]["paragraphs"]
    assert [_texts(p) for p in now] == [_texts(p1), ["The log names the account."], ["Alice issued most of them."]]
    assert [r["target"] for r in _rows("lock-refused")] == [f"report:report#p{p1['id']}"] * 2 + [
        f"report:report#{sec['id']}", f"report:report#{fig['id']}"]
    # read_ref marks every locked block for the model that reads the document
    text = (await call("read_ref", ref="report:report")).text
    assert f"## Who deleted what · #{sec['id']} · locked" in text and f"¶ #p{p1['id']} · locked" in text
    assert f"· #{fig['id']} · locked" in text and f"¶ #p{sec2['paragraphs'][0]['id']}\n" in text


async def test_write_document_keeps_every_locked_block_as_it_was_and_where_it_stood(cells):
    cid, tid, _ = cells
    doc = await _written(cid, tid)
    sec, sec2 = doc["sections"]
    p1, p2 = sec["paragraphs"]
    fig = sec["figures"][0]
    assert fig["after_paragraph"] == p1["id"]
    for bid in ("title", sec["id"], p2["sentences"][0]["id"], fig["id"]):  # a sentence's id locks its paragraph
        await report_types.lock_route(CORPUS, MAIN, "report", bid, report_types.LockBody(locked=True))
    locked = report_types.read_doc(CORPUS, MAIN, "report")
    assert locked["title_locked"] is True and locked["sections"][0]["paragraphs"][1]["locked"] is True
    # the writer changes the title, renames the section, rewords the locked paragraph, drops the figure and adds a
    # paragraph at the top of the section
    r = await call("write_document", doc="report", text=(
        "# Bob issued nothing\n\n## The one account\n\nThe audit log has one week of rows.\n\n"
        f"All [[27|card:{cid}]] deletions came from one account.\n\n"
        f"Alice issued [[27|card:{tid}#count/alice]] of them while Bob issued none at all.\n\n"
        "## What the log covers\n\nThe log covers one week.\n"))
    assert not r.is_error, r.text
    new = report_types.read_doc(CORPUS, MAIN, "report")
    assert new["generation"] == 2 and new["title"] == "One account issued every deletion" and new["title_locked"] is True
    s1 = new["sections"][0]
    assert s1["id"] == sec["id"] and s1["heading"] == "Who deleted what" and s1["locked"] is True
    assert [_texts(p) for p in s1["paragraphs"]] == [["The audit log has one week of rows."], _texts(p1), _texts(p2)]
    kept = s1["paragraphs"][2]
    assert kept == {**p2, "locked": True}, "the locked paragraph is the same record, ids, refs and tags"
    moved = [f for f in s1["figures"] if f["cell"] == f"card:{tid}"]
    assert moved == [{**fig, "locked": True, "after_paragraph": s1["paragraphs"][1]["id"]}]
    refs = ["report:report#title", f"report:report#{sec['id']}", f"report:report#p{p2['id']}", f"report:report#{fig['id']}"]
    assert tools.hint("write_document-locked", blocks="4 blocks", refs=", ".join(refs)) in r.text
    refused = [(x["target"], x["actor"], (x["detail"] or {}).get("tool")) for x in _rows("lock-refused")]
    assert refused == [(ref, "model", "write_document") for ref in refs]
    # a later generation that leaves the locked paragraph out entirely, and copies it into another section, still has
    # it where it stood, once
    r = await call("write_document", doc="report", text=(
        "# Anything\n\n## Who deleted what\n\nThe audit log has one week of rows.\n\n"
        f"All [[27|card:{cid}]] deletions came from one account.\n\n![Deletions by account](card:{tid})\n\n"
        f"## What the log covers\n\n{' '.join(_texts(p2))}\n\nThe log covers one week.\n"))
    assert not r.is_error, r.text
    third = report_types.read_doc(CORPUS, MAIN, "report")
    s1, s2 = third["sections"]
    assert third["generation"] == 3 and third["title"] == "One account issued every deletion"
    assert [_texts(p) for p in s1["paragraphs"]] == [["The audit log has one week of rows."], _texts(p1), _texts(p2)]
    assert s1["paragraphs"][2]["id"] == p2["id"] and [_texts(p) for p in s2["paragraphs"]] == [["The log covers one week."]]
    assert [f["id"] for f in s1["figures"] if f["cell"] == f"card:{tid}"] == [fig["id"]]
    assert [x["target"] for x in _rows("lock-refused")][4:] == [refs[0], refs[2]], "the third changed the title and moved the paragraph"
    # the locks stand until the analyst clears one
    assert report_types.locked_refs(third, "report") == refs
    await report_types.lock_route(CORPUS, MAIN, "report", p2["id"], report_types.LockBody(locked=False))
    assert report_types.locked_refs(report_types.read_doc(CORPUS, MAIN, "report"), "report") == [refs[0], refs[1], refs[3]]


def _editor_blocks(doc: dict, edits: dict[str, str] | None = None, after: dict[str, list[dict]] | None = None) -> list:
    """The document as the editor saves it (frontend/src/report/model.ts blocksFromDoc): a heading per section, each
    paragraph as one block with its figures after it; `edits` changes a paragraph's text by id and `after` puts new
    blocks after a paragraph."""
    out = []
    for sec in doc["sections"]:
        out.append({"id": sec["id"], "type": "heading", "text": sec["heading"]})
        for p in sec["paragraphs"]:
            out.append({"id": p["id"], "type": "paragraph", "text": (edits or {}).get(p["id"], " ".join(_texts(p)))})
            out += [{"id": f["id"], "type": "figure", "cell": f["cell"], "caption": f.get("caption") or ""}
                    for f in sec["figures"] if f.get("after_paragraph") == p["id"]]
            out += (after or {}).get(p["id"], [])
    return [report_types.BlockIn(**b) for b in out]


async def test_notes_typed_under_a_locked_paragraph_are_not_locked_and_never_run_into_it(cells):
    """Only what the analyst locks is locked and text they type is not: the analyst edits a paragraph and locks it,
    types two notes as a list under it and presses Revise. The writer acts on the notes and leaves them out, and they
    stay out, since typing them locked nothing; the locked paragraph stays word for word, and the writer's text changed
    no locked block, so its result names none. A writer's text that runs one of its own sentences into the locked
    paragraph gets the paragraph back as it was and keeps its sentence after it."""
    cid, tid, _ = cells
    doc = await _written(cid, tid)
    sec2 = doc["sections"][1]
    p3 = sec2["paragraphs"][0]
    notes = [{"id": "note-1", "type": "bullet", "text": "Add who could read the log."},
             {"id": "note-2", "type": "bullet", "text": "Give the week's dates."}]
    blocks = _editor_blocks(doc, {p3["id"]: "The log covers one week of audit rows."}, {p3["id"]: notes})
    saved = await report_types.blocks_route(CORPUS, MAIN, "report", report_types.BlocksBody(title=doc["title"], blocks=blocks))
    await report_types.lock_route(CORPUS, MAIN, "report", p3["id"], report_types.LockBody(locked=True))
    locked = report_types.read_doc(CORPUS, MAIN, "report")["sections"][1]["paragraphs"][0]
    assert _texts(locked) == ["The log covers one week of audit rows."] and locked["locked"] is True
    assert _texts(saved["sections"][1]["paragraphs"][1]) == ["Add who could read the log.", "Give the week's dates."]
    head = f"# One account issued every deletion\n\n## Who deleted what\n\nAll [[27|card:{cid}]] deletions came from one account.\n\n"
    r = await call("write_document", doc="report", text=head + (
        "## Only the administrators could read the log\n\nThree administrators could read it, from 3 to 9 March.\n\n"
        "## What the log covers\n\nThe log covers one week of audit rows.\n"))
    assert not r.is_error, r.text
    paras = report_types.read_doc(CORPUS, MAIN, "report")["sections"][2]["paragraphs"]
    assert paras == [locked], "the locked paragraph is the same record, word for word, and the notes are gone"
    assert "the analyst locked" not in r.text, "no locked block was changed, so none is named"
    r = await call("write_document", doc="report", text=head + (
        "## What the log covers\n\nThe log covers one week of audit rows. Three administrators could read it.\n"))
    paras = report_types.read_doc(CORPUS, MAIN, "report")["sections"][1]["paragraphs"]
    assert [_texts(p) for p in paras] == [_texts(locked), ["Three administrators could read it."]] and paras[0] == locked
    assert r.text.endswith(tools.hint("write_document-locked", blocks="1 block", refs=f"report:report#p{p3['id']}"))
    # a writer's text that rewords the locked paragraph is told its change is not in the document
    r = await call("write_document", doc="report", text=head + "## What the log covers\n\nThe log covers seven days of audit rows.\n")
    assert r.text.endswith(tools.hint("write_document-locked", blocks="1 block", refs=f"report:report#p{p3['id']}"))
    assert report_types.read_doc(CORPUS, MAIN, "report")["sections"][1]["paragraphs"][0] == locked


async def test_a_locked_heading_the_writer_dropped_comes_back_in_its_place(cells):
    cid, tid, _ = cells
    doc = await _written(cid, tid)
    sec2 = doc["sections"][1]
    await report_types.lock_route(CORPUS, MAIN, "report", sec2["id"], report_types.LockBody(locked=True))
    await report_types.lock_route(CORPUS, MAIN, "report", sec2["paragraphs"][0]["id"], report_types.LockBody(locked=True))
    r = await call("write_document", doc="report", text=f"# T\n\n## Who deleted what\n\nAll [[27|card:{cid}]] deletions came from one account.\n")
    assert not r.is_error, r.text
    new = report_types.read_doc(CORPUS, MAIN, "report")
    assert [s["heading"] for s in new["sections"]] == ["Who deleted what", "What the log covers"]
    back = new["sections"][1]
    assert back["id"] == sec2["id"] and back["locked"] is True and back["paragraphs"] == [{**sec2["paragraphs"][0], "locked": True}]


async def test_a_shortened_rewrite_of_a_locked_paragraph_gives_way_and_a_new_paragraph_stays(cells):
    cid, tid, _ = cells
    long = ("The audit log records every deletion with its account, its time and the page it removed. Alice's account "
            "issued all of the deletions within one afternoon, and no other account deleted anything that week.")
    await call("write_document", doc="report", text=f"# T\n\n## Who deleted what\n\n{long}\n\nThe log covers one week.\n")
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    locked = doc["sections"][0]["paragraphs"][0]
    await report_types.lock_route(CORPUS, MAIN, "report", locked["id"], report_types.LockBody(locked=True))
    r = await call("write_document", doc="report", text=(
        "# T\n\n## Who deleted what\n\nNo other account deleted anything; Alice's account issued every deletion in one afternoon.\n\n"
        "Bob's account only read pages.\n\nThe log covers one week.\n"))
    assert not r.is_error, r.text
    paras = report_types.read_doc(CORPUS, MAIN, "report")["sections"][0]["paragraphs"]
    assert [_texts(p) for p in paras] == [_texts(locked), ["Bob's account only read pages."], ["The log covers one week."]]
    assert paras[0] == {**locked, "locked": True}


async def test_the_citation_check_leaves_a_locked_paragraph_as_it_is(cells):
    cid, tid, _ = cells
    doc = await _written(cid, tid)
    p1 = doc["sections"][0]["paragraphs"][0]
    stored = report_types.read_doc(CORPUS, MAIN, "report")
    stored["sections"][0]["paragraphs"][0]["sentences"][0]["text"] = "All [[99|card:" + cid + "]] deletions came from one account."
    report_types.write_doc(CORPUS, MAIN, "report", stored)
    await report_types.lock_route(CORPUS, MAIN, "report", p1["id"], report_types.LockBody(locked=True))
    r = await call("write_document", doc="report", text=REPORT.format(cid=cid, tid=tid))
    assert not r.is_error, r.text
    kept = report_types.read_doc(CORPUS, MAIN, "report")["sections"][0]["paragraphs"][0]["sentences"][0]
    assert kept["text"] == "All [[99|card:" + cid + "]] deletions came from one account." and kept["tags"] == p1["sentences"][0]["tags"]


async def test_the_lock_route_and_the_editor(cells):
    cid, tid, _ = cells
    # a frame's block is locked too, and the first write keeps it
    sec = report_types.add_section(CORPUS, "report", "Who deleted what")
    para = report_types.add_paragraph(CORPUS, "report", sec["id"], "- Name the account\n- Say how sure")
    item = para["sentences"][1]["id"]
    frame = await report_types.lock_route(CORPUS, MAIN, "report", item, report_types.LockBody(locked=True, client="tab1"))
    assert frame["frame"] is True and frame["sections"][0]["paragraphs"][0]["locked"] is True
    ev = [e for e in investigation._read_jsonl(investigation.inv_dir(CORPUS, MAIN) / "events.jsonl") if e.get("type") == "report"][-1]
    assert ev == {**ev, "slug": "report", "status": "edited", "client": "tab1"}
    lines = context.documents(CORPUS)  # a frame is listed whole, the lock marked on its paragraph
    assert f"{context.INDENT}## Who deleted what · #{sec['id']}" in lines
    assert (f"{context.INDENT}¶ #p{para['id']} · the analyst's · locked\n"
            f"{context.INDENT}  #{para['sentences'][0]['id']} Name the account · the analyst's") in lines
    await call("write_document", doc="report", text=f"# T\n\n## Who deleted what\n\nAll [[27|card:{cid}]] deletions came from one account.\n")
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    ps = doc["sections"][0]["paragraphs"]
    assert [_texts(p) for p in ps] == [["Name the account", "Say how sure"], ["All [[27|card:" + cid + "]] deletions came from one account."]]
    assert ps[0]["id"] == para["id"] and ps[0]["locked"] is True  # first in its section, as in the frame
    # the editor's save keeps the lock of every block it keeps
    body = report_types.BlocksBody(title=doc["title"], blocks=[report_types.BlockIn(**b) for b in (
        {"id": doc["sections"][0]["id"], "type": "heading", "text": "Who deleted what"},
        {"id": para["sentences"][0]["id"], "type": "bullet", "text": "Name the account"},
        {"id": item, "type": "bullet", "text": "Say how sure"},
        {"id": ps[1]["id"], "type": "paragraph", "text": "All deletions came from one account, by my count."})])
    saved = await report_types.blocks_route(CORPUS, MAIN, "report", body)
    assert saved["sections"][0]["paragraphs"][0] == ps[0] and "locked" not in saved["sections"][0]["paragraphs"][1]
    # unlocking takes the field away; a block the document does not have is a 404, a deck's blocks a 409
    out = await report_types.lock_route(CORPUS, MAIN, "report", para["id"], report_types.LockBody(locked=False))
    assert "locked" not in out["sections"][0]["paragraphs"][0]
    with pytest.raises(report_types.HTTPException) as e:
        await report_types.lock_route(CORPUS, MAIN, "report", "nope", report_types.LockBody(locked=True))
    assert e.value.status_code == 404
    await call("write_document", doc="slides", text="# Deck\n\n## One\n\n- A line.\n")
    deck = report_types.read_doc(CORPUS, MAIN, "slides")
    with pytest.raises(report_types.HTTPException) as e:
        await report_types.lock_route(CORPUS, MAIN, "slides", deck["slides"][0]["id"], report_types.LockBody(locked=True))
    assert e.value.status_code == 409
    rows = [(r["kind"], r["target"]) for r in _rows() if r["kind"] in ("lock", "unlock")]
    assert rows == [("lock", f"report:report#p{para['id']}"), ("unlock", f"report:report#p{para['id']}")]


async def test_a_locked_empty_title_does_not_blank_the_writers(cells):
    cid, _, _ = cells
    frame = await report_types.lock_route(CORPUS, MAIN, "report", "title", report_types.LockBody(locked=True))
    assert frame["title_locked"] is True and frame["title"] == ""
    await call("write_document", doc="report", text=f"# One account\n\n## Who\n\nAll [[27|card:{cid}]] deletions came from one account.\n")
    assert report_types.read_doc(CORPUS, MAIN, "report")["title"] == "One account"
