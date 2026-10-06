"""The view kit's Colour by (backend/app/viewer_colour.js, thimble.colourBy) on the server's side: every view page loads
it after the bridge; a page that mounts it has label controls, since the control draws them; the reader takes the
page's choice with thimble.colour_value and colour_on."""
import sys

import pytest

from app import views


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    views._folder_cache.clear()
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    views._memo.clear()
    views._ready.clear()
    sys.modules.pop("_thimble_views", None)
    yield
    views._memo.clear()
    views._ready.clear()
    sys.modules.pop("_thimble_views", None)


@pytest.fixture()
async def bound():
    views._bind_loop()
    yield


def test_every_view_page_loads_the_colour_control_after_the_bridge_and_before_the_page(tmp_path):
    d = tmp_path / "view"
    d.mkdir()
    (d / views.VIEW_HTML).write_text("<div id=c></div><script>const mine = thimble.colourBy({ mount: '#c', fields: [] })</script>")
    doc = views.frame_document({"dir": str(d), "slug": "board", "name": "Board"})
    bridge = doc.index("window.__thimbleKit = {")
    control = doc.index("thimble.colourBy = function")
    assert bridge < control < doc.index("const mine = thimble.colourBy("), "the bridge hands the control its part, then the page mounts it"
    assert ".thimble-colour-chip" in doc, "the kit's parts style it"


def test_a_page_that_mounts_colour_by_has_label_controls(tmp_path):
    """The control lists every label with its switch (data-label, thimble.setLabel), so a page that mounts it need not
    draw its own; a page that does neither has none."""
    def page(html: str) -> dict:
        d = tmp_path / str(abs(hash(html)))
        d.mkdir()
        (d / views.VIEW_HTML).write_text(html)
        return {"dir": str(d)}

    assert views.label_controls(page("<script>const c = thimble.colourBy({ mount: '#c', fields: [] })</script>"))
    assert views.label_controls(page('<b data-label="x"></b><script>thimble.setLabel("x", true)</script>'))
    assert not views.label_controls(page('<b data-label="x"></b><script>thimble.onLabels(() => {})</script>'))


def test_the_reader_takes_the_page_s_colour_choice():
    """thimble.colour_value gives a record's value under the page's colour.query(): a field's from the record, a label's
    from its rows (here the test label's); colour_on says whether its chip is on, None standing for no value."""
    from app import kernel_thimble as kt  # noqa: PLC0415

    by_kind = {"field": "kind", "off": ["With links", None]}
    assert kt.colour_value(by_kind, "m#L1", {"kind": "Text only"}) == "Text only"
    assert kt.colour_value(by_kind, "m#L1", {"kind": ""}) is None and kt.colour_value(by_kind, "m#L1", {}) is None
    assert kt.colour_on(by_kind, "Text only") and not kt.colour_on(by_kind, "With links") and not kt.colour_on(by_kind, None)
    assert kt.colour_value(None, "m#L1", {"kind": "x"}) is None and kt.colour_on(None, "x"), "no choice keeps everything"
    kt._view_ctx = views.probe_context()
    try:
        by_label = {"label": kt.PROBE_ID, "name": kt.PROBE_NAME, "off": []}
        assert kt.colour_value(by_label, "messages.jsonl#L14") == kt.PROBE_NAME
        assert kt.colour_value(by_label, "messages.jsonl#L15") is None
        assert kt.colour_value({"label": "another"}, "messages.jsonl#L14") is None, "a label that is not on marks nothing"
    finally:
        kt._view_ctx = None
