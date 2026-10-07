"""The order new values take the label palette's places (kernel_thimble.LABEL_ORDER, label_order.json): blue, orange,
green, gold, teal, brown, sky, then navy, grass, cerulean, chestnut and cyan, so a label's first five values are five
hues with no second blue. A stored color is a place, and show_label names each place by its hue, so the order changes
only what new values take: a new label's values in the label store and in thimble.colours, a new report check, and a
view's field values through the kit, which reads the same JSON from its frame."""
import json
import random
from pathlib import Path

from app import checks, concepts, kernel_thimble, views

ORDER = (1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11, 12)


def _label(values: list[str], colours: list[int | None] | None = None) -> dict:
    colours = colours or [None] * len(values)
    return {"classes": [{"name": v, "color": c, "highlight": True} for v, c in zip(values, colours)]}


def test_the_order_is_one_list_for_the_server_the_frontend_and_the_view_kit():
    assert kernel_thimble.LABEL_ORDER == ORDER == tuple(json.loads((Path(views.__file__).with_name("label_order.json")).read_text()))
    assert sorted(ORDER) == list(range(1, concepts.PALETTE + 1))


def test_show_label_s_names_are_the_places_a_stored_color_takes_and_the_first_five_are_five_hues():
    # each name says its place's hue on every paper (frontend tests/public/viz-palette.test.ts); the names never move
    assert concepts.COLOUR_NAMES == {"blue": 1, "orange": 2, "green": 3, "sky blue": 4, "olive": 5, "teal": 6, "brown": 7,
                                     "navy": 8, "grass green": 9, "cerulean": 10, "chestnut": 11, "cyan": 12}
    name = {n: k for k, n in concepts.COLOUR_NAMES.items()}
    assert [name[n] for n in ORDER[:5]] == ["blue", "orange", "green", "olive", "teal"]
    assert [name[n] for n in ORDER].index("sky blue") == 6


def test_a_new_label_s_values_take_the_order_and_a_further_label_the_colors_left():
    ks = [_label(list("abcdefgh")), _label(["x", "y", "no"]), _label(["p", "q", "r"])]
    concepts.fill_colours(ks)
    assert [[c["color"] for c in k["classes"]] for k in ks] == [[1, 2, 3, 5, 6, 7, 4, 8], [9, 10, 0], [11, 12, 1]]
    # a stored color stays where it is, whatever the order; the values without one take the free places in the order
    ks = [_label(["a", "b", "c"], [4, None, None]), _label(["d", "e"], [None, None])]
    concepts.fill_colours(ks)
    assert [[c["color"] for c in k["classes"]] for k in ks] == [[4, 8, 9], [1, 0]]
    assert concepts.free_colour(1, {1, 2, 3, 5}) == 6 and concepts.free_colour(12, {12, 1}) == 2
    assert concepts.free_colour(1, set(ORDER)) is None
    assert concepts.own_colour(3, {3}) == 5 and concepts.own_colour(7, {7, 4}) == 8 and concepts.own_colour(0, {0}) == 0


def test_the_kernel_gives_the_colors_the_label_store_gives():
    rng = random.Random(7)
    for _ in range(200):
        values = [[f"v{i}{j}" for j in range(rng.randint(1, 6))] for i in range(rng.randint(1, 6))]
        stored = [[rng.choice([None, None, 0, *range(1, 13)]) for _ in vs] for vs in values]
        ks = [_label(vs, cs) for vs, cs in zip(values, stored)]
        kk = [{"classes": [[v, c] for v, c in zip(vs, cs)]} for vs, cs in zip(values, stored)]
        concepts.fill_colours(ks)
        kernel_thimble._fill_colours(kk)
        assert [[c["color"] for c in k["classes"]] for k in ks] == [[c[1] for c in k["classes"]] for k in kk]


def test_thimble_colours_draws_a_new_label_s_values_in_the_order(tmp_path, monkeypatch):
    (tmp_path / "concepts").mkdir()
    (tmp_path / "concepts" / "k1.json").write_text(json.dumps({"id": "k1", "name": "kind", "labels": list("abcdef"), "ts": "1"}))
    monkeypatch.setattr(kernel_thimble, "WS", str(tmp_path))
    monkeypatch.setattr(kernel_thimble, "_LABELS_READ", [])
    hexes = kernel_thimble.LABEL_COLOURS
    assert kernel_thimble.colours("kind") == {v: hexes[n] for v, n in zip("abcdef", (1, 2, 3, 5, 6, 7))}


def test_a_new_report_check_takes_the_first_check_color_in_the_order(monkeypatch):
    assert checks.NEW_COLOURS == (1, 2, 3, 5, 6, 7, 4, 8)
    held = [{"colour": 1}, {"colour": 3}, {"colour": 5}]  # the built-in checks: blue, green and gold
    monkeypatch.setattr(checks, "list_checks", lambda c: held)
    assert checks._free_colour("c") == 2
    held += [{"colour": 2}, {"colour": 6}, {"colour": 7}]
    assert checks._free_colour("c") == 4
    held += [{"colour": 4}, {"colour": 8}, {"colour": 1}]
    assert checks._free_colour("c") == 2, "with every color held, the first in the order of those fewest checks have"


def test_a_view_s_frame_hands_the_kit_the_order_before_its_color_by(tmp_path):
    (tmp_path / "view.html").write_text("<!doctype html><body></body>")
    doc = views.frame_document({"dir": str(tmp_path), "slug": "v", "name": "V"})
    order = f"window.__thimbleLabelOrder = {json.dumps(list(ORDER))}</script>"
    assert order in doc and doc.index(order) < doc.index("thimble.colorBy")
