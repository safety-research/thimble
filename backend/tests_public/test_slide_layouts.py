"""slides.py's layouts: the presets the picker, the chat and the writer name, the card slots a layout shows, a layout
changed without losing a slide's cells, and the chat's edit_document(layout) on a written deck and on a deck's frame.
Invented cards on the mini workspace; tools called through tools.call as a session calls them; no model, no kernel."""
from __future__ import annotations

import pytest

from app import config, investigation, notebook, report_types, slides, tools

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
def cards(workspaces_tmp) -> list[str]:
    """Five cards on the canvas, each a table, for figures."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    ids = []
    for i in range(5):
        cell = notebook.new_cell("code", "run", f"Beds in row {i}?", nb["id"], code="df")
        cell["status"] = "ok"
        cell["outputs"] = [{"text/html": f"<table><tr><th>bed</th><td>{i}</td></tr></table>", "text/plain": f"bed {i}"}]
        nb["cells"].append(cell)
        ids.append(cell["id"])
    notebook.write_notebook(ws, nb)
    return ids


def _slide(layout: str | None = None, n_cards: int = 0, lines: tuple[str, ...] = ("The north bed flowered.",), bullet: bool = True,
           fmt: dict | None = None) -> dict:
    s = {"id": "s1", "heading": "Beds", "sentences": [{"id": f"l{i}", "text": t, "refs": [], "tags": [], **({"bullet": "-"} if bullet else {})}
                                                     for i, t in enumerate(lines)],
         "figures": [{"id": f"f{i}", "cell": f"card:c{i}", "caption": ""} for i in range(n_cards)]}
    if layout:
        s["layout"] = layout
    if fmt:
        s["format"] = fmt
    return s


def test_every_preset_names_a_layout_that_reads_back_as_that_preset():
    for name in slides.PRESETS:
        s = _slide("text")
        slides.apply_spec(s, slides.layout_spec(name))
        assert slides.preset_of(s) == name, name
    assert set(slides.PRESETS) >= {"title", "bullets", "paragraph", "bullets + card", "paragraph + card", "card", "two cards",
                                   "three cards", "four cards", "card grid", "quote"}


def test_a_layout_is_named_in_the_words_the_chat_and_an_older_writer_use():
    spec = slides.layout_spec
    assert spec("Two cards side by side") == {"layout": "figures", "slots": 2, "grid": False, "bullets": None}
    assert spec("bullets and card") == spec("Bullets + card") == spec("bullets & card") == spec("bullets+card")
    assert spec("full-bleed")["layout"] == spec("card")["layout"] == "card"
    assert spec("grid") == {"layout": "figures", "slots": 4, "grid": True, "bullets": None}
    assert spec("prose")["bullets"] is False and spec("3 cards")["slots"] == 3
    # the layout ids an older deck stored keep the slide's slots and lines
    assert spec("figure") == {"layout": "figure", "slots": None, "grid": False, "bullets": None}
    assert spec("figures")["layout"] == "figures" and spec("title and text")["layout"] == "text"
    assert spec("a carousel") is None and slides.layout_name("two figures") == "figures"


def test_the_slots_a_layout_shows_and_the_cards_past_them_stay_on_the_slide():
    assert slides.slots_of(_slide("figure", 2)) == 1  # an older deck's figure slide shows its first card
    assert slides.slots_of(_slide("figures", 3)) == 3 and slides.slots_of(_slide("figures", 0)) == 2
    assert slides.slots_of(_slide("figures", 1, fmt={"slots": 9})) == 4 and slides.slots_of(_slide("text", 2)) == 0
    s = _slide("figures", 3, fmt={"slots": 3})
    slides.apply_spec(s, slides.layout_spec("card"))
    assert slides.slots_of(s) == 1 and len(s["figures"]) == 3 and slides.slots_note(s) == " · 2 cards not shown"
    slides.apply_spec(s, slides.layout_spec("three cards"))
    assert [f["id"] for f in s["figures"]] == ["f0", "f1", "f2"] and slides.slots_note(s) == ""
    slides.apply_spec(s, slides.layout_spec("card grid"))
    assert slides.is_grid(s) and slides.slots_note(s) == " · 1 empty slot" and s["format"] == {"slots": 4, "grid": True}


def test_a_preset_makes_the_lines_bullets_or_prose_and_keeps_the_figure_side():
    s = _slide("figure", 1, lines=("One.", "Two."), fmt={"side": "left", "width": 60})
    slides.apply_spec(s, slides.layout_spec("paragraph + card"))
    assert not any(x.get("bullet") for x in s["sentences"]) and s["format"] == {"side": "left", "width": 60, "slots": 1}
    slides.apply_spec(s, slides.layout_spec("bullets"))
    assert all(x.get("bullet") == "-" for x in s["sentences"]) and "format" not in s and len(s["figures"]) == 1


def test_a_card_added_past_the_slots_gets_a_slot_where_the_layout_has_room():
    s = _slide("text", 1)
    slides.grow_slots(s)
    assert (s["layout"], slides.slots_of(s)) == ("figure", 1)
    s["figures"].append({"id": "f9", "cell": "card:c9", "caption": ""})
    slides.grow_slots(s)
    assert (s["layout"], slides.slots_of(s), slides.preset_of(s)) == ("figure", 2, "bullets + two cards")
    s = _slide("card", 4)
    slides.grow_slots(s)
    assert (slides.preset_of(s), slides.slots_note(s)) == ("four cards", "")


async def test_the_writer_names_a_layout_and_its_figures_take_slots(cards):
    text = ("# Beds\n\n## Every row\n\nLayout: three cards\n\n" + "".join(f"![Row {i}](card:{c})\n\n" for i, c in enumerate(cards[:2]))
            + "## One row\n\nLayout: card\n\n" + "".join(f"![Row {i}](card:{c})\n\n" for i, c in enumerate(cards[:2]))
            + "## All four\n\nLayout: card grid\n\n" + "".join(f"![Row {i}](card:{c})\n\n" for i, c in enumerate(cards[:4]))
            + "## Plain\n\nLayout: paragraph\n\n- The north bed flowered.\n- The south bed did not.\n")
    r = await tools.call(CORPUS, "write_document", {"doc": "slides", "text": text}, actor="analyst")
    assert not r.is_error, r.text
    deck = report_types.read_doc(CORPUS, MAIN, "slides")
    assert [slides.preset_of(s) for s in deck["slides"]] == ["three cards", "two cards", "card grid", "paragraph"]
    assert len(deck["slides"][2]["figures"]) == 4 and not any(x.get("bullet") for x in deck["slides"][3]["sentences"])
    assert "layout three cards · 1 empty slot" in report_types.document_lines(deck)


async def test_the_chat_sets_a_slides_layout_in_the_written_deck_and_in_the_frame(cards):
    # the frame before a write, as the deck's editor saved it
    frame = await report_types.deck_route(CORPUS, MAIN, "slides", report_types.DeckBody(slides=[
        report_types.SlideIn(id="a0000001", heading="Rows", layout="figure", format={"side": "right", "width": 50, "slots": 1},
                             lines=[report_types.SlideLineIn(id="b0000001", text="The north bed flowered.")],
                             figures=[report_types.SlideFigureIn(cell=f"card:{cards[0]}"), report_types.SlideFigureIn(cell=f"card:{cards[1]}")])]))
    assert frame["frame"] is True and frame["slides"][0]["format"]["slots"] == 1
    r = await tools.call(CORPUS, "edit_document", {"span": "report:slides#a0000001", "layout": "two cards side by side"}, actor="analyst")
    assert not r.is_error and "to two cards" in r.text, r.text
    s = report_types.read_frame(CORPUS, MAIN, "slides")["slides"][0]
    assert (s["layout"], s["format"], len(s["figures"]), len(s["sentences"])) == ("figures", {"slots": 2}, 2, 1)
    # the written deck
    await tools.call(CORPUS, "write_document", {"doc": "slides", "text": f"# Rows\n\n## Rows\n\n- The north bed flowered.\n\n![Row](card:{cards[0]})\n"}, actor="analyst")
    sid = report_types.read_doc(CORPUS, MAIN, "slides")["slides"][0]["id"]
    r = await tools.call(CORPUS, "edit_document", {"span": f"report:slides#{sid}", "layout": "card"}, actor="analyst")
    assert not r.is_error, r.text
    s = report_types.read_doc(CORPUS, MAIN, "slides")["slides"][0]
    # the frame's second card, which the analyst pinned there, came back with the write and has no slot on a card slide
    assert slides.preset_of(s) == "card" and slides.slots_note(s) == " · 1 card not shown"
    # a card inserted into a full slide gets a slot of its own, and the card past the slots one too
    r = await tools.call(CORPUS, "edit_document", {"span": f"report:slides#{sid}", "insert": True, "text": f"![Row 2](card:{cards[2]})"}, actor="analyst")
    assert not r.is_error, r.text
    s = report_types.read_doc(CORPUS, MAIN, "slides")["slides"][0]
    assert slides.preset_of(s) == "three cards" and len(s["figures"]) == 3 and slides.slots_note(s) == ""
    r = await tools.call(CORPUS, "edit_document", {"span": f"report:slides#{sid}", "layout": "a carousel"}, actor="analyst")
    assert r.is_error and "card grid" in r.text


async def test_the_deck_editor_saves_the_slots_and_the_grid(cards):
    body = report_types.DeckBody(slides=[
        report_types.SlideIn(id="a0000001", heading="Grid", layout="figures", format={"slots": 4, "grid": True},
                             figures=[report_types.SlideFigureIn(cell=f"card:{c}") for c in cards[:5]]),
        report_types.SlideIn(id="a0000002", heading="Alone", layout="card", figures=[report_types.SlideFigureIn(cell=f"card:{cards[0]}")])])
    deck = await report_types.deck_route(CORPUS, MAIN, "slides", body)
    grid, alone = deck["slides"]
    assert grid["format"] == {"slots": 4, "grid": True} and len(grid["figures"]) == slides.MAX_FIGURES == 4
    assert alone["layout"] == "card" and "format" not in alone and slides.preset_of(alone) == "card"
