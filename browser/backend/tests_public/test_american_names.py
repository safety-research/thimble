"""thimble's API names are spelled the American way (color), and each British name an earlier card, view, check or
extension used (colour) still works as its alias: the `thimble` module's colors, color_value and color_on, the
"color" of a mark and of a label a reader gets, show_label's `colors`, and the `color` of a check's front matter and of
an extension's check.json."""
import json

from app import kernel_thimble, views


def test_the_thimble_module_s_american_names_and_their_british_aliases(tmp_path, monkeypatch):
    (tmp_path / "concepts").mkdir()
    (tmp_path / "concepts" / "k1.json").write_text(json.dumps({"id": "k1", "name": "kind", "labels": ["a", "b"], "ts": "1"}))
    monkeypatch.setattr(kernel_thimble, "WS", str(tmp_path))
    monkeypatch.setattr(kernel_thimble, "_LABELS_READ", [])
    assert kernel_thimble.colors("kind") == kernel_thimble.colours("kind") == {"a": kernel_thimble.LABEL_COLOURS[1],
                                                                               "b": kernel_thimble.LABEL_COLOURS[0]}
    by_kind = {"field": "kind", "off": ["b"]}
    for value, on in ((kernel_thimble.color_value, kernel_thimble.color_on), (kernel_thimble.colour_value, kernel_thimble.colour_on)):
        assert value(by_kind, "m#L1", {"kind": "a"}) == "a" and on(by_kind, "a") and not on(by_kind, "b")
    assert {"colors", "color_value", "color_on", "colours", "colour_value", "colour_on"} <= set(kernel_thimble.__all__)

    monkeypatch.setattr(kernel_thimble, "_view_ctx", views.probe_context(filtered=True))
    [mark] = kernel_thimble.marked("messages.jsonl#L14")
    assert mark["color"] == mark["colour"] == kernel_thimble.PROBE_COLOUR
    on = kernel_thimble.view_labels()
    [label] = on["labels"]
    assert label["color"] == label["colour"] and label["values"][0]["color"] == label["values"][0]["colour"]
    assert on["filter"]["color"] == on["filter"]["colour"] == kernel_thimble.PROBE_COLOUR
    assert kernel_thimble.color_value({"label": kernel_thimble.PROBE_ID}, "messages.jsonl#L14") == kernel_thimble.PROBE_NAME
