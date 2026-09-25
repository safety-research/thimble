"""The story: sections of blocks beside their card. The writer's markdown made into the stored story (headlines, lists,
quotes, callouts, dividers, cards among the text, pictures of cards, where a section's card stands), an older story of
beats read in that shape, the story editor's save (PUT …/story) reconciled into the story or its frame, and the chat's
edits (edit_document: blocks inserted, a section's card moved, a quote rewritten), with the analyst's locks held. No
model call and no kernel; the corpus is invented."""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from app import config, investigation, notebook, report_types, story, tools
from app.story import StoryBlockIn as B, StoryFigureIn as F, StorySectionIn as S

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
def cards(workspaces_tmp):
    """A table of refunds per week, a count, and a note: any card can stand in a story."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    table = notebook.new_cell("table", "terminal", "Refunds per week", nb["id"], code="df")
    table["status"] = "ok"
    table["outputs"] = [{"text/html": "<table><tr><th></th><th>refunds</th></tr><tr><th>week 10</th><td>118</td></tr>"
                                      "<tr><th>week 11</th><td>212</td></tr></table>", "text/plain": "refunds\nweek 10 118\nweek 11 212"}]
    count = notebook.new_cell("code", "terminal", "How many refunds in March?", nb["id"], code="print(212)")
    count["status"], count["outputs"] = "ok", [{"text/plain": "212", "_stream": True}]
    note = notebook.new_cell("note", "terminal", "What the tickets say", nb["id"])
    nb["cells"] += [table, count, note]
    notebook.write_notebook(ws, nb)
    return table["id"], count["id"], note["id"]


async def call(name: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst")


def _stored() -> dict:
    return report_types.read_doc(CORPUS, MAIN, "story")


def _kinds(sec: dict) -> list[str]:
    """A section's blocks in reading order, each as its kind (a list as bullets, a card as card or image)."""
    figs = [f for f in sec["figures"] if f.get("role") != "main"]
    out = ["card" if f.get("role") != "image" else "image" for f in figs if not f.get("after_paragraph")]
    for p in sec["paragraphs"]:
        kind = p.get("kind") or ("bullets" if any(x.get("bullet") for x in p["sentences"]) else "text")
        out.append(kind)
        out += ["card" if f.get("role") != "image" else "image" for f in figs if f.get("after_paragraph") == p["id"]]
    return out


def _story_md(tid: str, cid: str, nid: str) -> str:
    return (f"# One charger drove March's refunds\n\nMarch had [[212|card:{cid}]] refund requests.\n\n"
            f"## Refund requests doubled in March\n\n![Refunds per week](card:{tid} \"week 11\")\n\n"
            f"Refunds rose from 118 to [[212|card:{tid}#refunds/week 11]] in a week.\n\n"
            "### What the tickets name\n\n- The X200 charger.\n- A week of use.\n\n"
            "> It stopped charging after four days.\n> — a customer\n\n"
            "Stakes. A doubling this sudden points at one cause.\n\n---\n\n"
            f"![What the tickets say](card:{nid})\n\n![Refunds per week](card:{tid} \"image\")\n\n"
            "## The count\n\nCard: left\n\n"
            f"![How many](card:{cid})\n\nThe count is [[212|card:{cid}]].\n\n"
            f"## No card here\n\nCard: none\n\nOnly text, citing [[card:{tid}]].\n\n"
            "## Limitations\n\nThe tickets do not say how the chargers were used.\n")


async def test_the_writers_markdown_is_sections_of_blocks(cards):
    tid, cid, nid = cards
    r = await call("write_document", doc="story", text=_story_md(tid, cid, nid))
    assert not r.is_error, r.text
    doc = _stored()
    assert doc["renderer"] == "story" and doc["title"] == "One charger drove March's refunds" and "beats" not in doc
    opening, doubled, count, plain, limits = doc["sections"]
    # the text under the title opens the story, with no heading and no card of its own
    assert opening["heading"] == "" and [x["text"] for x in opening["paragraphs"][0]["sentences"]] == [f"March had [[212|card:{cid}]] refund requests."]
    assert story.main_figure(opening) is None
    # a section's first figure line is its card, with its step; the blocks follow in their order
    main = story.main_figure(doubled)
    assert main["cell"] == f"card:{tid}" and main["highlight"] == ["week 11"] and story.side_of(doubled) == "right"
    assert _kinds(doubled) == ["text", "headline", "bullets", "quote", "callout", "divider", "card", "image"]
    quote = next(p for p in doubled["paragraphs"] if p.get("kind") == "quote")
    assert quote["speaker"] == "a customer" and quote["sentences"][0]["text"] == "It stopped charging after four days."
    items = next(p for p in doubled["paragraphs"] if any(x.get("bullet") for x in p["sentences"]))
    assert [x["text"] for x in items["sentences"]] == ["The X200 charger.", "A week of use."]
    assert next(p for p in doubled["paragraphs"] if p.get("kind") == "callout")["sentences"][0]["text"] == "A doubling this sudden points at one cause."
    # `Card:` sets where the card stands, and a section whose card is none shows its figure lines as cards among its text
    assert story.side_of(count) == "left" and story.main_figure(count)["cell"] == f"card:{cid}"
    assert story.side_of(plain) == "none" and story.main_figure(plain) is None
    # Limitations is a section like the others; a headed section with no card named takes the chart its text cites
    assert limits["heading"] == "Limitations" and story.main_figure(limits) is None
    fallback = await call("write_document", doc="story", text=f"# T\n\n## Rose\n\nRefunds rose [[card:{tid}]].\n")
    assert not fallback.is_error and story.main_figure(_stored()["sections"][0])["cell"] == f"card:{tid}"


async def test_read_ref_marks_each_block_so_the_writer_sees_the_story(cards):
    tid, cid, nid = cards
    await call("write_document", doc="story", text=_story_md(tid, cid, nid))
    listed = (await call("read_ref", ref="report:story")).text
    assert "· card left" in listed and "· card none" in listed
    assert "· headline" in listed and "· quote by a customer" in listed and "· callout" in listed and "· divider" in listed
    assert f'(card:{tid} "week 11") · #' in listed and "· the section's card" in listed
    assert f'(card:{tid} "image") · #' in listed and "· image" in listed


def test_an_older_story_of_beats_reads_as_sections_with_the_same_ids_on_every_read(workspaces_tmp):
    old = {"id": "story", "type": "story", "renderer": "story", "title": "Refunds", "generation": 2,
           "answer": {"id": "ans00001", "text": "One charger drove them.", "refs": [], "tags": []},
           "beats": [{"id": "beat0001", "heading": "They doubled", "stakes": "One cause.", "locked": True,
                      "sentences": [{"id": "sen00001", "text": "They doubled in March.", "refs": [], "tags": []}],
                      "figures": [{"id": "fig00001", "cell": "card:t1", "caption": "Per week", "highlight": ["week 11"]}]}],
           "limitations": "The tickets say little.",
           "comments": [{"id": "cm000001", "sentence_id": "ans00001", "text": "Say which charger.", "author": "analyst", "ts": "", "status": "open"}]}
    report_types.write_doc(CORPUS, MAIN, "story", old)
    doc = _stored()
    assert "beats" not in doc and "answer" not in doc and "limitations" not in doc
    lede, beat, limits = doc["sections"]
    assert lede["heading"] == "" and lede["paragraphs"][0]["sentences"][0]["id"] == "ans00001"
    assert beat["id"] == "beat0001" and beat["locked"] is True and beat["heading"] == "They doubled"
    assert [p.get("kind") for p in beat["paragraphs"]] == [None, "callout"] and beat["paragraphs"][0]["sentences"][0]["id"] == "sen00001"
    assert beat["figures"] == [{"id": "fig00001", "cell": "card:t1", "caption": "Per week", "highlight": ["week 11"], "after_paragraph": None, "role": "main"}]
    assert limits["heading"] == "Limitations" and limits["paragraphs"][0]["sentences"][0]["text"] == "The tickets say little."
    # the records the older story lacked take the same ids on every read, so a comment or a thread can anchor on them
    again = _stored()
    assert json.dumps(again["sections"]) == json.dumps(doc["sections"])
    assert report_types.find_target(doc, "ans00001")["kind"] == "sentence" and report_types.anchored_open_comments(doc)[0]["id"] == "cm000001"


async def test_the_story_editor_saves_sections_of_blocks_and_keeps_the_ids(cards):
    tid, cid, nid = cards
    # before a write, the editor lays out the frame the writer reads
    frame = await report_types.story_route(CORPUS, MAIN, "story", report_types.StoryBody(title="Refunds", client="tab1", sections=[
        S(id="s1", heading="", blocks=[B(id="b1", type="text", text=f"March had [[212|card:{cid}]] refunds. Most name one charger.")]),
        S(id="s2", heading="They doubled", card="left", main=F(id="f1", cell=f"card:{tid}"), blocks=[
            B(id="b2", type="headline", text="Week 11"), B(id="b3", type="bullets", text="- The X200.\nA week of use."),
            B(id="b4", type="quote", text="It stopped after four days.", speaker="a customer"), B(id="b5", type="divider"),
            B(id="b6", type="card", cell=f"card:{nid}"), B(id="b7", type="image", cell=f"card:{tid}", caption="The same weeks"),
            B(id="b8", type="callout", text="One cause.")]),
    ]))
    assert frame["frame"] is True and frame["title"] == "Refunds"
    s1, s2 = frame["sections"]
    assert s1["id"] == "s1" and s1["card"] == "right" and s1["paragraphs"][0]["id"] == "b1"
    assert [x["refs"] for x in s1["paragraphs"][0]["sentences"]] == [[f"card:{cid}"], []]
    assert s2["card"] == "left" and story.main_figure(s2) == {**story.main_figure(s2), "id": "f1", "caption": "Refunds per week", "after_paragraph": None}
    assert _kinds(s2) == ["headline", "bullets", "quote", "divider", "card", "image", "callout"]
    assert [x["text"] for x in s2["paragraphs"][1]["sentences"]] == ["The X200.", "A week of use."]
    assert s2["paragraphs"][2]["speaker"] == "a customer" and s2["paragraphs"][3]["sentences"] == []
    image = next(f for f in s2["figures"] if f.get("role") == "image")
    assert image["caption"] == "The same weeks" and image["after_paragraph"] == "b5"
    assert report_types.read_frame(CORPUS, MAIN, "story")["sections"][1]["id"] == "s2"
    events = [e for e in investigation._read_jsonl(investigation.inv_dir(CORPUS, MAIN) / "events.jsonl") if e.get("type") == "report"]
    assert events[-1] == {**events[-1], "slug": "story", "status": "edited", "client": "tab1"}

    # a written story: a block moved to another section keeps its sentences' ids; a sentence rewritten in its place keeps
    # its id and its comment settles; a block dropped goes with its comments
    await call("write_document", doc="story", text=f"# Refunds\n\n## They doubled\n\n![Per week](card:{tid})\n\nThey doubled [[card:{tid}]]. The X200 failed.\n\n"
                                                    "## Why\n\nOne charger.\n\nA second paragraph.\n")
    doc = _stored()
    a, b = doc["sections"]
    p_a, p_b1, p_b2 = a["paragraphs"][0], b["paragraphs"][0], b["paragraphs"][1]
    s_first, s_second = p_a["sentences"]
    doc["comments"] = [{"id": "c1", "sentence_id": s_second["id"], "text": "Which one?", "author": "analyst", "ts": "", "status": "open"},
                       {"id": "c2", "sentence_id": p_b2["sentences"][0]["id"], "text": "Cut?", "author": "analyst", "ts": "", "status": "open"},
                       {"id": "c3", "sentence_id": s_second["id"], "text": "No source.", "author": "check", "check": "unverified", "ts": "", "status": "open"}]
    report_types.write_doc(CORPUS, MAIN, "story", doc)
    saved = await report_types.story_route(CORPUS, MAIN, "story", report_types.StoryBody(title="Refunds", sections=[
        S(id=a["id"], heading="They doubled", card="full", main=F(id=story.main_figure(a)["id"], cell=f"card:{tid}"), blocks=[
            B(id=p_a["id"], type="text", text=f"{s_first['text']} The X200 charger failed.")]),
        S(id=b["id"], heading="Why", blocks=[B(id=p_b1["id"], type="text", text="One charger.")]),
        S(id="new00001", heading="Moved", card="none", blocks=[B(id="nb1", type="text", text=s_first["text"])]),
    ]))
    a2, b2, c2 = saved["sections"]
    assert a2["card"] == "full" and [x["id"] for x in a2["paragraphs"][0]["sentences"]] == [s_first["id"], s_second["id"]]
    assert a2["paragraphs"][0]["sentences"][1]["text"] == "The X200 charger failed." and a2["paragraphs"][0]["sentences"][1]["by"] == "analyst"
    # the analyst's comment stays on the rewritten sentence; a check's is superseded, since the check reads the new text
    assert {cm["id"]: cm["status"] for cm in saved["comments"]} == {"c1": "open", "c3": "dismissed"}
    assert len(b2["paragraphs"]) == 1 and c2["card"] == "none" and c2["paragraphs"][0]["sentences"][0]["text"] == s_first["text"]
    assert c2["paragraphs"][0]["sentences"][0]["id"] != s_first["id"], "a sentence is kept once; its copy is new"
    assert saved["generation"] == doc["generation"], "the analyst's save is no new generation"
    with pytest.raises(HTTPException) as e:
        await report_types.story_route(CORPUS, MAIN, "report", report_types.StoryBody(title="x"))
    assert e.value.status_code == 409


async def test_a_block_moved_between_sections_keeps_its_record_and_its_lock(cards):
    tid, cid, nid = cards
    await call("write_document", doc="story", text=f"# T\n\n## One\n\n![c](card:{tid})\n\nFirst point.\n\n## Two\n\nSecond point.\n")
    doc = _stored()
    one, two = doc["sections"]
    para = one["paragraphs"][0]
    report_types.set_block_lock(CORPUS, MAIN, "story", para["id"], True)
    saved = await report_types.story_route(CORPUS, MAIN, "story", report_types.StoryBody(title="T", sections=[
        S(id=one["id"], heading="One", main=F(id=story.main_figure(one)["id"], cell=f"card:{tid}")),
        S(id=two["id"], heading="Two", blocks=[B(id=two["paragraphs"][0]["id"], type="text", text="Second point."),
                                               B(id=para["id"], type="text", text="First point.")]),
    ]))
    moved = saved["sections"][1]["paragraphs"][1]
    assert moved["id"] == para["id"] and moved["locked"] is True and moved["sentences"][0]["id"] == para["sentences"][0]["id"]
    assert report_types.locked_refs(saved, "story") == [f"report:story#p{para['id']}"]
    # a rewrite by the writer keeps the locked block word for word
    r = await call("write_document", doc="story", text="# T\n\n## One\n\nSomething else.\n\n## Two\n\nSecond point, reworded.\n")
    assert not r.is_error and "locked" in r.text
    texts = [x["text"] for x in report_types.all_sentences(_stored())]
    assert "First point." in texts


async def test_the_chat_inserts_blocks_moves_a_card_and_rewrites_a_quote(cards):
    tid, cid, nid = cards
    await call("write_document", doc="story", text=f"# T\n\n## One\n\nFirst point [[card:{cid}]].\n\n## Two\n\nSecond point.\n")
    doc = _stored()
    one, two = doc["sections"]
    pid = one["paragraphs"][0]["id"]
    # blocks in the story's markdown after a paragraph, a figure line the section's card when it has none
    r = await call("edit_document", span=f"report:story#p{pid}", insert=True,
                   text=f"### A headline\n\n- one\n- two\n\n> Said once.\n> — someone\n\n---\n\n![The table](card:{tid})\n\n![Its picture](card:{tid} \"image\")")
    assert not r.is_error, r.text
    sec = _stored()["sections"][0]
    assert _kinds(sec) == ["text", "headline", "bullets", "quote", "divider", "image"]
    assert story.main_figure(sec)["cell"] == f"card:{tid}"
    # `### ` opens no new section in a story; `## ` does
    assert len(_stored()["sections"]) == 2
    r = await call("edit_document", span=f"report:story#{two['id']}", insert=True, text="## Three\n\nThird point.")
    assert not r.is_error and [s["heading"] for s in _stored()["sections"]] == ["One", "Two", "Three"]
    # `card` alone moves a section's card
    r = await call("edit_document", span=f"report:story#{one['id']}", card="left")
    assert not r.is_error and story.side_of(_stored()["sections"][0]) == "left"
    assert (await call("edit_document", span=f"report:story#{one['id']}", card="top")).is_error
    # a quote rewritten stays a quote, its speaker kept unless the text names another
    quote = next(p for p in _stored()["sections"][0]["paragraphs"] if p.get("kind") == "quote")
    r = await call("edit_document", span=f"report:story#p{quote['id']}", text="Said twice.")
    assert not r.is_error, r.text
    quote = next(p for p in _stored()["sections"][0]["paragraphs"] if p.get("kind") == "quote")
    assert quote["speaker"] == "someone" and quote["sentences"][0]["text"] == "Said twice."
    # a divider rewritten is text; a block deleted is gone
    divider = next(p for p in _stored()["sections"][0]["paragraphs"] if p.get("kind") == "divider")
    assert not (await call("edit_document", span=f"report:story#p{divider['id']}", text="Now text.")).is_error
    assert "divider" not in _kinds(_stored()["sections"][0])
    assert not (await call("edit_document", span=f"report:story#p{quote['id']}", delete=True)).is_error
    assert "quote" not in _kinds(_stored()["sections"][0])
    # a deck takes no card
    report_types.write_doc(CORPUS, MAIN, "slides", {"id": "slides", "type": "slides", "renderer": "slides", "title": "D", "generation": 1,
                                                    "slides": [{"id": "sl1", "heading": "h", "sentences": []}]})
    assert (await call("edit_document", span="report:slides#sl1", card="left")).is_error


async def test_a_revision_keeps_where_the_analyst_put_each_card(cards):
    tid, cid, nid = cards
    await call("write_document", doc="story", text=f"# T\n\n## Refunds doubled\n\n![c](card:{tid})\n\nThey doubled.\n")
    sec = _stored()["sections"][0]
    await call("edit_document", span=f"report:story#{sec['id']}", card="full")
    await call("write_document", doc="story", text=f"# T\n\n## Refunds doubled\n\n![c](card:{tid})\n\nThey doubled in March.\n\n## New\n\nText.\n")
    first, new = _stored()["sections"]
    assert story.side_of(first) == "full" and story.side_of(new) == "right"
    # a `Card:` line the writer wrote wins
    await call("write_document", doc="story", text=f"# T\n\n## Refunds doubled\n\nCard: left\n\n![c](card:{tid})\n\nThey doubled.\n")
    assert story.side_of(_stored()["sections"][0]) == "left"
