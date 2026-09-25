"""Locks enforced after generation: only a block the analyst locks is locked, the writer is told
which blocks are locked and that they stay word for word, and whatever a model's save writes, a new generation
(write_document) or one passage (edit_document), every locked block goes back as it was and where it stood. Each block
a save changed, deleted, split or moved is recorded on the document (`lock_reverts`), which the Report tab shows as a
note and the writer's next turn reads (context.documents, read_ref). Invented documents on the mini workspace; the
tools are called through tools.call as a session calls them; no model and no kernel.
"""
from __future__ import annotations

import copy

import pytest

from app import config, context, investigation, notebook, report_types, telemetry, tools

CORPUS = "mini"
MAIN = investigation.MAIN
HEAD = "# The garden survey\n\n"
BEDS = ("## Which beds flowered\n\n"
        "The north bed flowered in April. The south bed flowered in May.\n\n"
        "Frost reached only the east bed, and its tulips opened two weeks late.\n\n"
        "The west bed had no tulips at all.\n\n")
SOIL = "## What the soil shows\n\nThe soil was damp in every bed.\n"
LOCKED = ["Frost reached only the east bed, and its tulips opened two weeks late."]


@pytest.fixture()
async def locked(workspaces_tmp):
    """A written report with the second paragraph of its first section locked; returns (the document, the locked
    paragraph)."""
    notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")
    r = await call("write_document", doc="report", text=HEAD + BEDS + SOIL)
    assert not r.is_error, r.text
    para = report_types.read_doc(CORPUS, MAIN, "report")["sections"][0]["paragraphs"][1]
    assert [x["text"] for x in para["sentences"]] == LOCKED
    await report_types.lock_route(CORPUS, MAIN, "report", para["id"], report_types.LockBody(locked=True))
    return report_types.read_doc(CORPUS, MAIN, "report"), {**para, "locked": True}


async def call(name: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst")


def _texts(sec: dict) -> list[list[str]]:
    return [[x["text"] for x in p["sentences"]] for p in sec["paragraphs"]]


def _stored() -> dict:
    return report_types.read_doc(CORPUS, MAIN, "report")


def _refused() -> list[tuple[str, str]]:
    return [(r["target"], (r["detail"] or {}).get("tool")) for r in telemetry.build_export(CORPUS) if r["kind"] == "lock-refused"]


# --------------------------------------------------------------------------- write_document: the four cases


async def test_a_rewrite_of_a_locked_paragraph_goes_back_word_for_word_and_the_rest_of_the_rewrite_stays(locked):
    doc, para = locked
    ref = f"report:report#p{para['id']}"
    # the writer, asked to rewrite everything, rewrites the locked paragraph too
    r = await call("write_document", doc="report", text=(
        "# A new survey title\n\n## Which beds flowered\n\n"
        "The north bed opened first, in April, and the south bed a month later.\n\n"
        "Frost touched the east bed, so its tulips were late by about a fortnight.\n\n"
        "No tulips grew in the west bed.\n\n## What the soil shows\n\nEvery bed had damp soil.\n"))
    assert not r.is_error, r.text
    new = _stored()
    sec = new["sections"][0]
    assert new["generation"] == 2 and new["title"] == "A new survey title"
    assert _texts(sec) == [["The north bed opened first, in April, and the south bed a month later."], LOCKED,
                           ["No tulips grew in the west bed."]]
    assert sec["paragraphs"][1] == para, "the same record, its id, sentences, refs and lock"
    assert _texts(new["sections"][1]) == [["Every bed had damp soil."]]
    # the save's result, the record on the document, the telemetry
    assert r.text.endswith(tools.hint("write_document-locked", blocks="1 block", refs=ref))
    assert [(e["ref"], e["text"], e["generation"], e["tool"]) for e in new["lock_reverts"]] == [(ref, LOCKED[0], 2, "write_document")]
    assert _refused() == [(ref, "write_document")]
    # the writer's next turn: its first message lists the locked block with its text and names the reverted change, as
    # read_ref does
    listed = context.documents(CORPUS)
    assert f"{context.INDENT}¶ #p{para['id']} · locked\n{context.INDENT}  #{para['sentences'][0]['id']} {LOCKED[0]}" in listed
    assert f"{context.INDENT}{report_types.reverted_line([ref])}" in listed
    assert report_types.reverted_line([ref]) in (await call("read_ref", ref="report:report")).text


async def test_a_locked_paragraph_the_writer_deleted_comes_back_where_it_stood(locked):
    doc, para = locked
    r = await call("write_document", doc="report", text=HEAD + (
        "## Which beds flowered\n\nThe north bed flowered in April. The south bed flowered in May.\n\n"
        "The west bed had no tulips at all.\n\n") + SOIL)
    assert not r.is_error, r.text
    sec = _stored()["sections"][0]
    assert _texts(sec) == [["The north bed flowered in April.", "The south bed flowered in May."], LOCKED,
                           ["The west bed had no tulips at all."]]
    assert sec["paragraphs"][1] == para
    assert [e["ref"] for e in _stored()["lock_reverts"]] == [f"report:report#p{para['id']}"]


async def test_a_locked_paragraph_the_writer_moved_goes_back_to_its_section_and_its_place(locked):
    doc, para = locked
    # into another section, word for word
    r = await call("write_document", doc="report", text=HEAD + (
        "## Which beds flowered\n\nThe north bed flowered in April. The south bed flowered in May.\n\n"
        "The west bed had no tulips at all.\n\n## What the soil shows\n\nThe soil was damp in every bed.\n\n") + LOCKED[0] + "\n")
    assert not r.is_error, r.text
    new = _stored()
    assert _texts(new["sections"][0])[1] == LOCKED and new["sections"][0]["paragraphs"][1] == para
    assert _texts(new["sections"][1]) == [["The soil was damp in every bed."]], "the copy in the other section is gone"
    assert r.text.endswith(tools.hint("write_document-locked", blocks="1 block", refs=f"report:report#p{para['id']}"))
    # within its section, past the paragraph before it, which the writer kept word for word
    r = await call("write_document", doc="report", text=HEAD + (
        f"## Which beds flowered\n\n{LOCKED[0]}\n\nThe north bed flowered in April. The south bed flowered in May.\n\n"
        "The west bed had no tulips at all.\n\n") + SOIL)
    sec = _stored()["sections"][0]
    assert _texts(sec) == [["The north bed flowered in April.", "The south bed flowered in May."], LOCKED,
                           ["The west bed had no tulips at all."]]
    assert [e["ref"] for e in _stored()["lock_reverts"]] == [f"report:report#p{para['id']}"]


async def test_a_locked_paragraph_the_writer_left_alone_records_nothing_and_clears_the_last_note(locked):
    doc, para = locked
    await call("write_document", doc="report", text=HEAD + "## Which beds flowered\n\nFrost came.\n\n" + SOIL)
    assert len(_stored()["lock_reverts"]) == 1
    # the next generation copies the locked paragraph as it stands and rewrites the rest
    r = await call("write_document", doc="report", text=HEAD + (
        "## Which beds flowered\n\nThe north and south beds flowered in spring.\n\n"
        f"{LOCKED[0]}\n\nThe west bed stayed bare.\n\n") + SOIL)
    assert not r.is_error, r.text
    new = _stored()
    assert new["generation"] == 3 and "lock_reverts" not in new, "the note belongs to the generation it happened in"
    assert _texts(new["sections"][0]) == [["The north and south beds flowered in spring."], LOCKED, ["The west bed stayed bare."]]
    assert new["sections"][0]["paragraphs"][1] == para
    assert "the analyst locked" not in r.text
    assert "was reverted" not in context.documents(CORPUS)


async def test_a_locked_paragraph_the_writer_split_or_ran_into_its_own_text_is_whole_again_once(locked):
    doc, para = locked
    two = ("Frost reached only the east bed. Its tulips opened late.")  # not the locked sentence: a rewrite
    r = await call("write_document", doc="report", text=HEAD + (
        "## Which beds flowered\n\nThe north bed flowered in April.\n\n"
        f"Frost reached only the east bed, and its tulips opened two weeks late. The gardener covered it.\n\n"
        "The south bed flowered in May.\n\n") + SOIL)
    assert not r.is_error, r.text
    sec = _stored()["sections"][0]
    assert _texts(sec) == [["The north bed flowered in April."], LOCKED, ["The gardener covered it."],
                           ["The south bed flowered in May."]], "run into the writer's sentence: both kept, apart"
    assert sec["paragraphs"][1] == para
    # a locked paragraph of two sentences split in two paragraphs, one of them moved to the other section
    await report_types.lock_route(CORPUS, MAIN, "report", para["id"], report_types.LockBody(locked=False))
    first = sec["paragraphs"][0]
    stored = _stored()
    stored["sections"][0]["paragraphs"][0]["sentences"].append(
        {"id": "s-extra", "text": "The south bed flowered in May.", "refs": [], "tags": [], "tag_notes": {}})
    stored["sections"][0]["paragraphs"].pop(3)
    report_types.write_doc(CORPUS, MAIN, "report", stored)
    await report_types.lock_route(CORPUS, MAIN, "report", first["id"], report_types.LockBody(locked=True))
    pair = _stored()["sections"][0]["paragraphs"][0]
    assert [x["text"] for x in pair["sentences"]] == ["The north bed flowered in April.", "The south bed flowered in May."]
    r = await call("write_document", doc="report", text=HEAD + (
        "## Which beds flowered\n\nThe north bed flowered in April.\n\n" + two + "\n\n"
        "## What the soil shows\n\nThe south bed flowered in May.\n\nThe soil was damp in every bed.\n"))
    new = _stored()
    assert _texts(new["sections"][0])[0] == ["The north bed flowered in April.", "The south bed flowered in May."]
    assert new["sections"][0]["paragraphs"][0] == pair
    every = [x["text"] for x in report_types.all_sentences(new)]
    assert every.count("The south bed flowered in May.") == 1 and every.count("The north bed flowered in April.") == 1
    assert _texts(new["sections"][1]) == [["The soil was damp in every bed."]]


# --------------------------------------------------------------------------- edit_document, and the note's life


async def test_edit_document_cannot_reach_a_locked_block_and_the_guard_puts_back_what_a_save_did(locked):
    doc, para = locked
    sec = doc["sections"][0]
    ref = f"report:report#p{para['id']}"
    # told: the delete of the section that holds the locked paragraph is refused, as an edit inside it is
    r = await call("edit_document", span=f"report:report#{sec['id']}", delete=True)
    assert r.is_error and r.text.endswith(tools.hint("edit_document-locked", ref=ref))
    r = await call("edit_document", span=f"report:report#{para['sentences'][0]['id']}", text="Frost came.")
    assert r.is_error and _stored()["sections"][0]["paragraphs"][1] == para
    # enforced: a save that reached the locked block anyway (here the delete called past the tool's check) has it back
    # in place, the section under its heading and id, and the note says so
    out = report_types.delete_passage(CORPUS, "report", sec["id"], actor="writer:report")
    assert out["reverted"] == [ref]
    now = _stored()
    back = now["sections"][0]
    assert back["id"] == sec["id"] and back["heading"] == "Which beds flowered" and back["paragraphs"] == [para]
    assert [(e["ref"], e["tool"], e["by"], e["generation"]) for e in now["lock_reverts"]] == [(ref, "edit_document", "writer:report", 1)]
    # an edit around it goes through and leaves it, and the note of this generation stays until the next one
    r = await call("edit_document", span=ref, text="The gardener covered the east bed.", insert=True)
    assert not r.is_error and "was reverted" not in r.text, r.text
    now = _stored()
    assert _texts(now["sections"][0]) == [LOCKED, ["The gardener covered the east bed."]] and now["sections"][0]["paragraphs"][0] == para
    assert [e["ref"] for e in now["lock_reverts"]] == [ref]
    # a new section before it under the same heading takes nothing from it: in place, a section is known by its id
    first = now["sections"][0]
    r = await call("edit_document", span=f"report:report#{now['sections'][1]['id']}", insert=True,
                   text="## Which beds flowered\n\nA second look at the beds.")
    assert not r.is_error, r.text
    now = _stored()
    assert [s["heading"] for s in now["sections"]] == ["Which beds flowered", "What the soil shows", "Which beds flowered"]
    assert now["sections"][0] == first and _texts(now["sections"][2]) == [["A second look at the beds."]]


def test_the_guard_changes_nothing_on_a_document_that_holds_its_locks(locked):
    doc, para = locked
    before = copy.deepcopy(doc)
    fig_doc = copy.deepcopy(doc)
    fig_doc["title_locked"] = True
    fig_doc["sections"][1]["locked"] = True
    fig_doc["sections"][1]["figures"] = [{"id": "fig1", "cell": "card:abc", "caption": "Soil", "after_paragraph": None,
                                          "locked": True}]
    held = copy.deepcopy(fig_doc)
    assert report_types.hold_locks(CORPUS, MAIN, "report", fig_doc, held, tool="edit_document", by="t") == []
    assert fig_doc == held
    assert report_types.hold_locks(CORPUS, MAIN, "report", doc, before, tool="edit_document", by="t") == []
    assert doc == before and "lock_reverts" not in doc


async def test_typed_text_locks_nothing_in_any_form(locked):
    """The editor's save, the frame routes and the deck's editor mark what the analyst typed as theirs, never locked."""
    doc, para = locked
    blocks = [report_types.BlockIn(id=doc["sections"][0]["id"], type="heading", text="Which beds flowered, by month"),
              report_types.BlockIn(id="typed", type="paragraph", text="My own note on the beds."),
              report_types.BlockIn(id=para["id"], type="paragraph", text=LOCKED[0])]
    saved = await report_types.blocks_route(CORPUS, MAIN, "report", report_types.BlocksBody(title="My title", blocks=blocks))
    assert report_types.locked_refs(saved, "report") == [f"report:report#p{para['id']}"] and "locked" not in saved
    typed = saved["sections"][0]["paragraphs"][0]
    assert typed["by"] == "analyst" and "locked" not in typed
    added = report_types.add_paragraph(CORPUS, "report", saved["sections"][0]["id"], "A second note.")
    assert "locked" not in added and report_types.locked_refs(_stored(), "report") == [f"report:report#p{para['id']}"]
    await call("write_document", doc="slides", text="# Deck\n\n## One\n\n- A line.\n")
    deck = report_types.read_doc(CORPUS, MAIN, "slides")
    slide = deck["slides"][0]
    out = report_types.save_deck(CORPUS, MAIN, "slides", "Deck", [report_types.SlideIn(
        id=slide["id"], heading="One, renamed", lines=[report_types.SlideLineIn(id=slide["sentences"][0]["id"], text="A line I typed.")])])
    assert "locked" not in out and "· locked" not in "\n".join(report_types.document_lines(out))
