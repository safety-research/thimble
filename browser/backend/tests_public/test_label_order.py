"""The order new values take the label palette's places (kernel_thimble.LABEL_ORDER, label_order.json) is one list for
the server, the page and the view kit, which reads the same JSON from its frame, so a label's values have the same
colors on the canvas, in Files and in a view."""
import json
from pathlib import Path

from app import concepts, kernel_thimble, views

ORDER = (1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11, 12)


def test_a_label_s_colors_take_one_order_on_the_server_the_page_and_the_view_kit():
    assert kernel_thimble.LABEL_ORDER == ORDER == tuple(json.loads((Path(views.__file__).with_name("label_order.json")).read_text()))
    assert sorted(ORDER) == list(range(1, concepts.PALETTE + 1))
