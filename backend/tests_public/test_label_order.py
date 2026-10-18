"""The order new values take the label palette's places (kernel_thimble.LABEL_ORDER, label_order.json): blue, orange,
green, gold, teal, brown, sky, then navy, grass, cerulean, chestnut and cyan, so a label's first five values are five
hues with no second blue. A stored color is a place, and show_label names each place by its hue, so the order changes
only what new values take: a new label's values in the label store and in thimble.colours, a new report check, and a
view's field values through the kit, which reads the same JSON from its frame."""
import json
from pathlib import Path

from app import concepts, kernel_thimble, views

ORDER = (1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11, 12)


def _label(values: list[str], colours: list[int | None] | None = None) -> dict:
    colours = colours or [None] * len(values)
    return {"classes": [{"name": v, "color": c, "highlight": True} for v, c in zip(values, colours)]}


def test_the_order_is_one_list_for_the_server_the_frontend_and_the_view_kit():
    assert kernel_thimble.LABEL_ORDER == ORDER == tuple(json.loads((Path(views.__file__).with_name("label_order.json")).read_text()))
    assert sorted(ORDER) == list(range(1, concepts.PALETTE + 1))


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
