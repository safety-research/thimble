"""A card's chart colours a label's values as the label's tag and card do (app/kernel_thimble.py, thimble.colours): each
value takes the colour the server's list of labels gives its class, a stored colour or the one fill_colours picks for a
label stored without class colours, and a value the label does not define takes a neutral ink none of the label's
classes has. A card that calls it lists the label among the labels it uses.

The labels are invented: "kind of edit" (fix, feature, other) with its colours stored, and two labels whose files
carry values but no classes."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import concepts, kernel_thimble


def _write(ws: Path, concept_id: str, body: dict) -> None:
    d = ws / "concepts"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{concept_id}.json").write_text(json.dumps({"id": concept_id, **body}))


@pytest.fixture()
def ws(tmp_path, monkeypatch) -> Path:
    w = tmp_path / "ws"
    _write(w, "k1", {"name": "flaky test", "labels": ["flaky", "no"], "ts": "2026-01-01T00:00:00+00:00"})
    _write(w, "k2", {"name": "kind of edit", "labels": ["fix", "feature", "other"], "ts": "2026-01-02T00:00:00+00:00",
                     "classes": [{"name": "fix", "color": 3, "highlight": True}, {"name": "feature", "color": 5, "highlight": True},
                                 {"name": "other", "color": 0, "highlight": False}]})
    _write(w, "k3", {"name": "tone", "labels": ["angry", "calm", "unknown"], "ts": "2026-01-03T00:00:00+00:00"})
    monkeypatch.setattr(kernel_thimble, "WS", str(w))
    kernel_thimble._LABELS_READ.clear()
    return w


def test_each_value_takes_the_colour_the_server_gives_its_class(ws):
    listed = concepts.list_concepts(ws)
    assert [k["name"] for k in listed] == ["flaky test", "kind of edit", "tone"]
    for k in listed:
        want = {c["name"]: kernel_thimble.LABEL_COLOURS[c["color"]] for c in k["classes"]}
        assert kernel_thimble.colours(k["name"]) == want, k["name"]
    assert kernel_thimble.colours("kind of edit") == {"fix": "#009e73", "feature": "#d55e00", "other": "#a09c93"}
    # the labels without classes take the first colours no stored label holds, and a negative takes the grey
    assert kernel_thimble.colours("flaky test") == {"flaky": "#0072b2", "no": "#a09c93"}
    assert list(kernel_thimble.colours("tone").values()) == ["#e69f00", "#009e73", "#a09c93"]


def test_a_value_the_label_does_not_define_takes_a_neutral_ink(ws):
    got = kernel_thimble.colours("kind of edit", ["revert", "fix", "other", "fix", None, float("nan"), "merge"])
    assert list(got) == ["fix", "other", "merge", "revert"], "the label's values in its order, then the others sorted"
    assert got["fix"] == "#009e73" and got["other"] == "#a09c93"
    assert got["merge"] == kernel_thimble.NEUTRAL_COLOURS[0] and got["revert"] == kernel_thimble.NEUTRAL_COLOURS[1]
    label_colours = set(kernel_thimble.LABEL_COLOURS)
    assert not label_colours & set(kernel_thimble.NEUTRAL_COLOURS), "a neutral ink is no label's colour"
    with pytest.raises(TypeError, match="list or a column"):
        kernel_thimble.colours("kind of edit", "fix")


def test_a_card_that_colours_by_a_label_uses_it(ws):
    kernel_thimble.colours("Kind of Edit")
    kernel_thimble.colours("kind of edit", ["fix"])
    assert kernel_thimble._LABELS_READ == [{"id": "k2", "rev": 0}]
    with pytest.raises(KeyError, match="no label named"):
        kernel_thimble.colours("mood")


def test_no_two_values_of_a_label_share_a_colour_while_one_is_left(ws):
    """A label stored with a colour repeated (a redefinition that put new values between kept ones) gives each value its
    own colour, in the list and in thimble.colours alike, a ninth value included; past twelve values a colour repeats."""
    kept = [{"name": n, "color": c, "highlight": True} for n, c in (("net", 1), ("root", 2), ("flag", 3), ("guard", 4),
                                                                      ("rc file", 5), ("stand-in", 6), ("pip", 6), ("push", 7))]
    _write(ws, "k4", {"name": "way around", "labels": ["net", "root", "flag", "guard", "rc file", "stand-in", "pip", "push", "none"],
                      "ts": "2026-01-04T00:00:00+00:00", "classes": [*kept, {"name": "none", "color": 0, "highlight": False}]})
    _write(ws, "k5", {"name": "wide", "labels": [f"v{i}" for i in range(14)], "ts": "2026-01-05T00:00:00+00:00"})
    listed = {k["name"]: k for k in concepts.list_concepts(ws)}
    colours = [c["color"] for c in listed["way around"]["classes"]]
    assert colours == [1, 2, 3, 4, 5, 6, 7, 8, 0], colours
    assert list(kernel_thimble.colours("way around").values()) == [kernel_thimble.LABEL_COLOURS[c] for c in colours]
    wide = [c["color"] for c in listed["wide"]["classes"]]
    assert len(set(wide[:12])) == 12 and wide[12] in wide[:12], wide
    assert list(kernel_thimble.colours("wide").values()) == [kernel_thimble.LABEL_COLOURS[c] for c in wide]
