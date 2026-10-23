"""The view kit's Color by (backend/app/viewer_colour.js, thimble.colorBy) and time range selector (viewer_range.js,
thimble.timeRange) on the server's side: every view page loads them after the bridge, Color by first; a page that mounts
Color by, by either of its names, has label controls, since the control draws them; the reader takes the page's choice
with thimble.colour_value and colour_on; and the kit's own fetch of a label's definition is answered by thimble, never
by the reader."""
import json
import sys

import pytest

from app import config, views


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


def test_every_view_page_loads_the_colour_control_after_the_bridge_and_before_the_page(tmp_path):
    d = tmp_path / "view"
    d.mkdir()
    (d / views.VIEW_HTML).write_text("<div id=c></div><script>const mine = thimble.colourBy({ mount: '#c', fields: [] })</script>")
    doc = views.frame_document({"dir": str(d), "slug": "board", "name": "Board"})
    bridge = doc.index("window.__thimbleKit = {")
    control = doc.index("thimble.colorBy = function")
    timerange = doc.index("thimble.timeRange = function")
    assert bridge < control < timerange < doc.index("const mine = thimble.colourBy("), \
        "the bridge hands the kit its part, Color by and then the range selector take it, then the page mounts them"
    assert ".thimble-colour-chips" in doc and ".chip-key" in doc and ".thimble-range-win" in doc, "the kit's parts style it"


def test_a_page_that_mounts_colour_by_has_label_controls(tmp_path):
    """The control lists every label with its switch (data-label, thimble.setLabel), so a page that mounts it need not
    draw its own; a page that does neither has none."""
    def page(html: str) -> dict:
        d = tmp_path / str(abs(hash(html)))
        d.mkdir()
        (d / views.VIEW_HTML).write_text(html)
        return {"dir": str(d)}

    assert views.label_controls(page("<script>const c = thimble.colourBy({ mount: '#c', fields: [] })</script>"))
    assert views.label_controls(page("<script>const c = thimble.colorBy({ mount: '#c', fields: [] })</script>"))
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


def test_the_kit_s_fetch_of_a_label_s_definition_is_thimble_s_to_answer(workspaces_tmp, tmp_path, monkeypatch):
    """Color by's menu asks for a label's definition with thimble.fetch({"$thimble": "label", id}): thimble answers it
    from the label as its panel shows it, with what each value means where the prompt says so, and the reader never sees
    it; an unknown label is None, and any other query is the reader's."""
    from app import concepts  # noqa: PLC0415

    (tmp_path / "data" / "kit").mkdir(parents=True)
    (tmp_path / "data" / "kit" / "manifest.json").write_text(json.dumps({"name": "kit", "description": ""}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    ws = config.workspace_dir("kit")
    k = concepts.new_concept("asks", "Does the message ask another agent for something? yes = it asks for an answer. "
                             "no: it asks for nothing.", "prompt", None, "record", ["yes", "no"], glob="messages.jsonl")
    concepts.write_concept(ws, k)
    handled, d = views.kit_answer("kit", {"$thimble": "label", "id": k["id"]})
    assert handled
    assert {x: d[x] for x in ("id", "name", "kind", "scope", "spec")} == \
        {"id": k["id"], "name": "asks", "kind": "prompt", "scope": "messages.jsonl", "spec": ""}
    assert d["text"].startswith("Does the message ask")
    assert [(v["name"], v["meaning"]) for v in d["values"]] == [("yes", "it asks for an answer"), ("no", "it asks for nothing")]
    assert views.kit_answer("kit", {"$thimble": "label", "id": "nolabel"}) == (True, None)
    assert views.kit_answer("kit", {"op": "board"}) == (False, None)
    assert views.kit_answer("kit", None) == (False, None)
