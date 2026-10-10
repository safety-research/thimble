"""thimble.chart (kernel_thimble.chart, docs/charts.md): a common chart from a DataFrame whose columns come in the kind's
order, drawn as plain Vega-Lite that carries no color, font or size of its own, so thimble's theme styles it. Matt
(2026-10-09): "for those defaults you just provide data in the right format and not the plotting code by hand every
time". The kernel's display is caught; no kernel, no browser."""
import json
from pathlib import Path

import pandas as pd
import pytest

from app import cite, kernel_thimble as kt

POSTS = pd.DataFrame({"agent": ["agent-1", "agent-2", "agent-3"], "posts": [3, 9, 1]})
LINKS = pd.DataFrame({"site": ["SEC", "SEC", "Data USA", "other"], "link posts": [30, 5, 10, 4],
                      "posted on": ["June 18", "other days", "other days", "other days"]})
# a style the chart would carry itself: the theme's to set (frontend lib/vizTheme)
STYLE_KEYS = {"config", "width", "height", "font", "fontSize", "fontWeight", "strokeWidth", "opacity", "fill", "stroke",
              "scheme", "range", "cornerRadius", "size"}


def drawn(*args, **kwargs) -> dict:
    """The bundle thimble.chart shows."""
    shown: list[dict] = []
    real = kt._show
    kt._show = shown.append
    try:
        assert kt.chart(*args, **kwargs) is None
    finally:
        kt._show = real
    assert len(shown) == 1
    return shown[0]


def spec_of(*args, **kwargs) -> dict:
    return drawn(*args, **kwargs)[kt.VEGALITE_MIME]


def styles(node, path="") -> list[str]:
    """Every style the spec sets itself: a key the theme owns, or a color given as a value rather than a field."""
    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            if k in STYLE_KEYS or (k == "color" and isinstance(v, (str, dict)) and "field" not in v):
                out.append(f"{path}/{k}")
            out += styles(v, f"{path}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out += styles(v, f"{path}/{i}")
    return out


@pytest.fixture()
def label_ws(tmp_path, monkeypatch):
    (tmp_path / "concepts").mkdir()
    (tmp_path / "concepts" / "k1.json").write_text(json.dumps({"id": "k1", "name": "activity type", "ts": "1",
                                                                "labels": ["captcha", "signup", "money", "other"]}))
    monkeypatch.setattr(kt, "WS", str(tmp_path))
    monkeypatch.setattr(kt, "_LABELS_READ", [])
    return tmp_path


def test_every_kind_draws_its_rows_inline_as_vega_lite_with_no_style_of_its_own():
    t = pd.date_range("2026-06-16T10:00", periods=4, freq="5min")
    charts = {
        "bar": (LINKS,),
        "line": (pd.DataFrame({"time": t, "captures": [1, 3, 6, 9], "site": ["a", "a", "b", "b"]}),),
        "scatter": (pd.DataFrame({"tokens": [1, 5, 9], "cost": [0.1, 0.5, 0.9]}),),
        "dots": (pd.DataFrame({"time": t[:3], "agent": ["a", "b", "a"], "outcome": ["passed", "failed", "passed"]}),),
        "histogram": (pd.Series([1.5, 2.5, 2.6, 9.0], name="days"),),
        "heatmap": (pd.DataFrame({"tactic": ["probe", "trick"], "site": ["Navy", "Navy"], "captures": [5, 30]}),),
        "area": (pd.DataFrame({"time": t, "captures": [1, 3, 6, 9], "site": ["a", "a", "b", "b"]}),),
        "box": (pd.DataFrame({"turns": [3, 5, 8, 9, 12, 40, 2], "agent": ["a"] * 6 + ["b"]}),),
    }
    assert set(charts) == set(kt.CHARTS)
    for kind, args in charts.items():
        bundle = drawn(kind, *args)
        spec = bundle[kt.VEGALITE_MIME]
        assert "vegalite" in kt.VEGALITE_MIME and spec["$schema"].startswith("https://vega.github.io/schema/vega-lite/v6")
        assert styles(spec) == [], kind
        # the rows are inline, so they are the chart's table a takeaway cites (cite.chart_table)
        table = cite.chart_table(bundle)
        assert table is not None and table.total == len(spec["data"]["values"]) > 0, kind


def test_a_bar_chart_of_named_categories_lies_down_largest_first_and_its_values_are_cited_by_category():
    bundle = drawn("bar", POSTS)
    spec = bundle[kt.VEGALITE_MIME]
    assert spec["mark"] == "bar" and spec["data"]["values"][1] == {"agent": "agent-2", "posts": 9}
    assert spec["encoding"]["y"] == {"field": "agent", "type": "nominal", "title": "agent",
                                     "sort": ["agent-2", "agent-1", "agent-3"]}
    assert spec["encoding"]["x"]["field"] == "posts" and "color" not in spec["encoding"]
    table = cite.chart_table(bundle)
    assert table.label == "agent" and table.cells[table.labels.index("agent-2")] == ["9"]
    # sort: a list first, the rest after it largest first; None keeps the frame's order
    assert spec_of("bar", POSTS, sort=["agent-3"])["encoding"]["y"]["sort"] == ["agent-3", "agent-2", "agent-1"]
    assert spec_of("bar", POSTS, sort=None)["encoding"]["y"]["sort"] == ["agent-1", "agent-2", "agent-3"]
    # a Series is its index, then its values: value_counts() is a bar chart as it is
    s = spec_of("bar", pd.Series(["a", "b", "a"], name="agent").value_counts())
    assert (s["encoding"]["y"]["field"], s["encoding"]["x"]["field"]) == ("agent", "count")


def test_a_group_column_stacks_in_the_legend_s_order_sets_side_by_side_or_shares():
    spec = spec_of("bar", LINKS)
    enc = spec["encoding"]
    assert enc["color"]["field"] == "posted on" and enc["color"]["sort"] == ["June 18", "other days"]
    assert "scale" not in enc["color"], "the theme gives the groups their colors"
    # Vega-Lite would stack by the groups' names; the segments are stacked in the legend's order
    assert enc["order"] == {"field": kt.STACK_FIELD, "type": "quantitative"}
    assert spec["transform"] == [{"calculate": 'indexof(["June 18", "other days"], datum["posted on"])', "as": kt.STACK_FIELD}]
    beside = spec_of("bar", LINKS, stack=False)["encoding"]
    assert beside["yOffset"]["field"] == "posted on" and "order" not in beside
    share = spec_of("bar", LINKS, stack="share")["encoding"]["x"]
    assert share["stack"] == "normalize" and share["axis"] == {"format": "%"}


def test_a_bar_chart_over_times_stands_up_each_bar_spanning_its_time_to_the_next():
    weeks = pd.DataFrame({"week": pd.to_datetime(["2026-01-05", "2026-01-12", "2026-01-26"]), "reports": [3, 5, 1]})
    spec = spec_of("bar", weeks, marks={"launch": "2026-01-12"})
    bars, rule, text = spec["layer"]
    assert bars["mark"] == {"type": "bar", "orient": "vertical"} and bars["encoding"]["x"]["type"] == "temporal"
    assert bars["encoding"]["x2"] == {"field": "week end"}
    assert spec["data"]["values"][0] == {"week": "2026-01-05T00:00:00", "reports": 3, "week end": "2026-01-12T00:00:00"}
    assert rule["mark"] == "rule" and rule["data"]["values"] == [{"week": "2026-01-12T00:00:00", "mark": "launch"}]
    assert text["encoding"]["text"]["field"] == "mark"
    with pytest.raises(ValueError, match="`marks` need categories that are times"):
        kt.chart("bar", POSTS, marks={"x": 1})


def test_a_label_s_values_take_its_order_and_the_card_reads_the_label_for_its_colors(label_ws):
    act = pd.DataFrame({"activity": ["other", "money", "captcha", "hmm"], "records": [50, 20, 80, 3]})
    enc = spec_of("bar", act, label="activity type")["encoding"]
    assert enc["y"]["sort"] == ["captcha", "money", "other", "hmm"]
    # the colors are the label's, which the card gives the values it reads (frontend lib/chartDefaults labelColours)
    assert enc["color"] == {"field": "activity", "type": "nominal", "title": "activity", "sort": enc["y"]["sort"],
                            "legend": None}
    assert kt._LABELS_READ == [{"id": "k1", "rev": 0}]
    # with a group column, the label colors the groups
    by = pd.DataFrame({"agent": ["a", "a", "b"], "records": [1, 2, 3], "activity": ["money", "captcha", "money"]})
    assert spec_of("bar", by, label="activity type")["encoding"]["color"]["sort"] == ["captcha", "money"]
    with pytest.raises(ValueError, match="holds none of the label 'activity type'"):
        kt.chart("bar", POSTS, label="activity type")


def test_a_wrong_frame_fails_with_one_line_that_names_the_columns_it_takes():
    cases = [
        (("bar", POSTS[["posts", "agent"]]), "takes (category, value) or (category, value, group) columns, the value numbers; "
                                              "`agent` holds text"),
        (("bar", POSTS.assign(a=1, b=2)), "got 4: agent, posts, a, b"),
        (("line", POSTS), 'the x numbers or times; `agent` holds text; draw categories with "bar"'),
        (("heatmap", POSTS), "takes (x, y, value) columns, in that order; got 2"),
        (("pie", POSTS), "no chart kind 'pie'; the kinds are bar (category, value) or (category, value, group); line"),
        (("bar", [1, 2]), "takes a DataFrame of (category, value) or (category, value, group) columns, not list"),
        (("line", pd.DataFrame({"t": pd.to_timedelta([1, 2], unit="s"), "n": [1, 2]})), "holds durations"),
    ]
    for args, words in cases:
        with pytest.raises((ValueError, TypeError)) as e:
            kt.chart(*args)
        assert words in str(e.value) and "\n" not in str(e.value), str(e.value)
    with pytest.raises(TypeError, match=r"thimble.chart\('line'\) takes the options label, marks, panels, not 'sort'"):
        kt.chart("line", pd.DataFrame({"x": [1, 2], "y": [3, 4]}), sort=None)


def test_times_show_at_their_own_clock_time_and_iso_text_reads_as_times():
    utc = pd.DataFrame({"time": pd.to_datetime(["2026-08-30T16:02:00Z", "2026-08-30T16:30:00Z"]), "runs": [1, 2]})
    spec = spec_of("line", utc)
    assert [r["time"] for r in spec["data"]["values"]] == ["2026-08-30T16:02:00", "2026-08-30T16:30:00"]
    assert spec["encoding"]["tooltip"][0]["format"] == "%Y-%m-%d %H:%M"
    months = spec_of("line", pd.DataFrame({"month": ["2025-04", "2025-05"], "turns": [1, 2]}))
    assert months["encoding"]["x"]["type"] == "temporal" and months["data"]["values"][0]["month"] == "2025-04-01T00:00:00"
    # a short line marks each value with a dot; a long one is a plain line
    assert months["mark"] == {"type": "line", "point": True}
    assert spec_of("line", pd.DataFrame({"x": range(40), "y": range(40)}))["mark"] == "line"


def test_dots_put_each_row_on_its_line_earliest_first_and_panels_give_each_series_its_own_scale():
    ev = pd.DataFrame({"time": pd.to_datetime(["2026-08-30T15:50", "2026-08-30T16:10", "2026-08-30T15:40"]),
                       "agent": ["agent-11", "agent-3", "agent-7"]})
    spec = spec_of("dots", ev)
    assert spec["mark"] == "point" and spec["encoding"]["y"]["sort"] == ["agent-7", "agent-11", "agent-3"]
    series = pd.DataFrame({"month": ["2025-04", "2025-05"] * 2, "value": [1, 9, 4, 5], "measure": ["turns"] * 2 + ["agents"] * 2})
    panels = spec_of("line", series, panels=True)
    assert panels["encoding"]["row"]["field"] == "measure" and panels["resolve"] == {"scale": {"y": "independent"}}
    with pytest.raises(ValueError, match="needs a series column"):
        kt.chart("line", series[["month", "value"]], panels=True)


def test_a_histogram_bins_every_value_in_round_steps():
    rows = spec_of("histogram", pd.Series([0, 1, 1, 2, 5, 3, 3, 3], name="edits"))["data"]["values"]
    assert [r["edits"] for r in rows] == [0, 1, 2, 3, 4, 5] and [r["count"] for r in rows] == [1, 2, 1, 3, 0, 1]
    assert rows[0]["edits end"] == 1, "whole numbers take bins one wide at least"
    days = pd.Series([0.2 * i for i in range(100)], name="days")  # 0 to 19.8
    spec = spec_of("histogram", days, marks={"median": 9.9})
    bins = spec["data"]["values"]
    assert sum(r["count"] for r in bins) == 100 and len(bins) <= kt.BINS
    assert spec["layer"][0]["encoding"]["x"]["bin"] == {"binned": True, "step": 1.0}
    assert spec["layer"][0]["encoding"]["x"]["axis"] == {"format": ",~r"}, "plain numbers, not 1.2e+2"
    assert len(spec_of("histogram", days, step=5)["data"]["values"]) == 4
    with pytest.raises(ValueError, match="makes 19,801 bins"):
        kt.chart("histogram", days, step=0.001)


def test_a_heatmap_orders_its_names_by_total_its_numbers_ascending_and_takes_a_log_scale():
    hm = pd.DataFrame({"hour": [3, 1, 3], "site": ["Navy", "Kansas", "Kansas"], "captures": [5, 30, 20000]})
    spec = spec_of("heatmap", hm, log=True)
    assert spec["mark"] == "rect"
    assert spec["encoding"]["x"]["sort"] == [1, 3] and spec["encoding"]["y"]["sort"] == ["Kansas", "Navy"]
    assert spec["encoding"]["color"] == {"field": "captures", "type": "quantitative", "title": "captures",
                                         "scale": {"type": "symlog"}}


def test_a_column_name_with_a_dot_is_a_field_and_not_a_path():
    spec = spec_of("scatter", pd.DataFrame({"p.value": [0.1, 0.2], "n [runs]": [3, 4]}))
    assert spec["encoding"]["x"] == {"field": "p\\.value", "type": "quantitative", "title": "p.value"}
    assert spec["encoding"]["y"]["field"] == "n \\[runs\\]"
    assert spec["data"]["values"][0] == {"p.value": 0.1, "n [runs]": 3}


EVALS = pd.DataFrame({"model": ["m1", "m2", "m3"], "accuracy": [0.62, 0.81, 0.40], "lo": [0.55, 0.75, 0.31],
                      "hi": [0.69, 0.86, 0.50]})


def test_an_interval_draws_a_rule_in_ink_from_each_value_s_low_end_to_its_high_end_and_its_ends_are_cited():
    bundle = drawn("bar", EVALS, interval=("lo", "hi"))
    spec = bundle[kt.VEGALITE_MIME]
    bars, rule = spec["layer"]
    assert bars["mark"] == "bar" and bars["encoding"]["y"]["sort"] == ["m2", "m1", "m3"]
    # the rule mark, which the theme draws in its annotation ink (frontend lib/vizTheme), with no color of its own
    assert rule["mark"] == "rule" and "color" not in rule["encoding"]
    assert rule["encoding"]["x"] == {"field": "lo", "type": "quantitative", "title": "accuracy"}
    assert rule["encoding"]["x2"] == {"field": "hi"} and rule["encoding"]["y"] == bars["encoding"]["y"]
    assert spec["data"]["values"][0] == {"model": "m1", "accuracy": 0.62, "lo": 0.55, "hi": 0.69}
    table = cite.chart_table(bundle)
    assert table.label == "model" and table.cells[table.labels.index("m2")] == ["0.81", "0.75", "0.86"]
    # the interval's columns may stand anywhere in the frame; the rest keep the kind's order
    moved = spec_of("bar", EVALS[["lo", "model", "hi", "accuracy"]], interval=("lo", "hi"))
    assert moved["layer"][0]["encoding"]["y"]["field"] == "model" and moved["layer"][0]["encoding"]["x"]["field"] == "accuracy"


def test_an_interval_sets_groups_side_by_side_lying_down_or_upright():
    ev = pd.DataFrame({"model": ["m1", "m1", "m2", "m2"], "accuracy": [0.6, 0.7, 0.8, 0.5], "condition": ["cot", "plain"] * 2,
                       "lo": [0.5, 0.6, 0.7, 0.4], "hi": [0.7, 0.8, 0.9, 0.6]})
    bars, rule = spec_of("bar", ev, interval=("lo", "hi"))["layer"]
    assert bars["encoding"]["yOffset"]["field"] == "condition" and "order" not in bars["encoding"]
    assert rule["encoding"]["yOffset"] == bars["encoding"]["yOffset"] and "color" not in rule["encoding"]
    # number categories stand up: the interval runs along y, side by side on x
    steps = ev.assign(model=[1, 1, 2, 2])
    bars, rule = spec_of("bar", steps, interval=("lo", "hi"))["layer"]
    assert bars["encoding"]["x"]["type"] == "ordinal" and bars["encoding"]["xOffset"]["field"] == "condition"
    assert (rule["encoding"]["y"]["field"], rule["encoding"]["y2"]) == ("lo", {"field": "hi"})
    assert rule["encoding"]["xOffset"] == bars["encoding"]["xOffset"]
    with pytest.raises(ValueError, match="`interval` sets the groups side by side; leave out `stack`"):
        kt.chart("bar", ev, interval=("lo", "hi"), stack=True)


def test_dots_with_an_interval_put_each_row_s_groups_side_by_side_on_its_line():
    ev = pd.DataFrame({"accuracy": [0.6, 0.7, 0.8], "model": ["m1", "m1", "m2"], "condition": ["cot", "plain", "cot"],
                       "lo": [0.5, 0.6, 0.7], "hi": [0.7, 0.8, 0.9]})
    spec = spec_of("dots", ev, interval=("lo", "hi"), marks={"chance": 0.5})
    dots, rule = spec["layer"][0]["layer"]
    assert dots["mark"] == "point" and dots["encoding"]["yOffset"] == {"field": "condition", "type": "nominal",
                                                                       "sort": ["cot", "plain"]}
    assert rule["mark"] == "rule" and rule["encoding"]["x"]["field"] == "lo" and rule["encoding"]["yOffset"]["field"] == "condition"
    assert spec["layer"][1]["data"]["values"] == [{"accuracy": 0.5, "mark": "chance"}]
    # without an interval a dots chart's groups share their row's line, as before
    assert "yOffset" not in spec_of("dots", ev[["accuracy", "model", "condition"]])["encoding"]


def test_a_wrong_interval_fails_with_one_line_that_names_what_it_takes():
    t = pd.DataFrame({"week": pd.to_datetime(["2026-01-05", "2026-01-12"]), "n": [3, 5], "lo": [2, 4], "hi": [4, 6]})
    cases = [
        (("bar", EVALS), {"interval": "lo"}, "`interval` is the names of the two columns that hold each value's low and "
                                             "high ends, such as (\"lo\", \"hi\"), not 'lo'"),
        (("bar", EVALS), {"interval": ("lo", "upper")}, "`interval` names `upper`, which the frame lacks; its columns are "
                                                        "model, accuracy, lo, hi"),
        (("bar", EVALS.drop(columns="model")), {"interval": ("lo", "hi")}, "(category, value, group) columns, in that "
                                                                         "order, beside the interval's lo and hi; got 1: accuracy"),
        (("bar", EVALS.assign(hi=["a", "b", "c"])), {"interval": ("lo", "hi")}, "numbers; `hi` holds text"),
        (("bar", EVALS), {"interval": ("hi", "lo")}, "`interval` is (low, high), and `hi` is above `lo` where `model` is 'm1'"),
        (("bar", EVALS.assign(lo=0.05, hi=0.06)), {"interval": ("lo", "hi")},
         "every `accuracy` lies outside its interval; `lo` and `hi` are the interval's low and high ends"),
        (("bar", t), {"interval": ("lo", "hi")}, "`interval` draws around bars of text or number categories; `week` holds times"),
        (("dots", t), {"interval": ("lo", "hi")}, "`interval` draws around an x of numbers; `week` holds times"),
        (("line", EVALS), {"interval": ("lo", "hi")}, "takes the options label, marks, panels, not 'interval'"),
    ]
    for args, opts, words in cases:
        with pytest.raises((ValueError, TypeError)) as e:
            kt.chart(*args, **opts)
        assert words in str(e.value) and "\n" not in str(e.value), str(e.value)
    # a frame of four columns without `interval` is still a wrong bar chart
    with pytest.raises(ValueError, match="got 4: model, accuracy, lo, hi"):
        kt.chart("bar", EVALS)


TURNS = pd.DataFrame({"turns": [1, 2, 3, 4, 100, 10, 20, 30, 40, 50, 7, 9],
                      "agent": ["a"] * 5 + ["b"] * 5 + ["c"] * 2})


def test_a_box_plot_s_rows_are_each_group_s_summary_ordered_by_median_and_cited_by_group():
    bundle = drawn("box", TURNS)
    spec = bundle[kt.VEGALITE_MIME]
    # quartiles as pandas and Vega-Lite take them; whiskers to the farthest values within 1.5 box widths
    assert spec["data"]["values"] == [
        {"agent": "b", "n": 5, "low": 10, "q1": 20, "median": 30, "q3": 40, "high": 50},
        {"agent": "c", "n": 2, "low": 7, "q1": 7.5, "median": 8, "q3": 8.5, "high": 9},
        {"agent": "a", "n": 5, "low": 1, "q1": 2, "median": 3, "q3": 4, "high": 4},
    ]
    table = cite.chart_table(bundle)
    assert table.label == "agent" and table.cells[table.labels.index("b")][table.columns.index("median")] == "30"
    layers = spec["layer"]
    faint, strip, low, high, box, median = layers
    # every value is a faint dot behind its box; a group of fewer than BOX_MIN values is a strip of its dots alone
    assert faint["mark"] == {"type": "point", "style": kt.FAINT_STYLE}
    assert {r["agent"] for r in faint["data"]["values"]} == {"a", "b"} and len(faint["data"]["values"]) == 10
    assert strip["mark"] == "point" and strip["data"]["values"] == [{"turns": 7, "agent": "c"}, {"turns": 9, "agent": "c"}]
    assert all(l["transform"] == [{"filter": f'datum["n"] >= {kt.BOX_MIN}'}] for l in (low, high, box, median))
    assert (low["mark"], low["encoding"]["x"]["field"], low["encoding"]["x2"]) == ("rule", "low", {"field": "q1"})
    assert (high["encoding"]["x"]["field"], high["encoding"]["x2"]) == ("q3", {"field": "high"})
    assert box["mark"] == {"type": "bar", "style": kt.BOX_STYLE} and box["encoding"]["x2"] == {"field": "q3"}
    assert median["mark"] == {"type": "tick", "style": kt.MEDIAN_STYLE} and median["encoding"]["x"]["field"] == "median"
    assert all(l["encoding"]["y"]["sort"] == ["b", "c", "a"] for l in layers)
    assert all(l["encoding"]["x"]["title"] == "turns" for l in layers) and "color" not in box["encoding"]
    assert spec_of("box", TURNS, sort=["a"])["layer"][0]["encoding"]["y"]["sort"] == ["a", "b", "c"]
    # a Series is its values, grouped by its index when that is named
    s = spec_of("box", TURNS.set_index("agent")["turns"])
    assert s["data"]["values"][0]["agent"] == "b"
    with pytest.raises(ValueError, match=r"takes \(value, group\) columns, in that order; got 1: turns"):
        kt.chart("box", TURNS["turns"])
    with pytest.raises(ValueError, match="the value numbers; `agent` holds text"):
        kt.chart("box", TURNS[["agent", "turns"]])


def test_a_box_plot_takes_a_label_s_colors_on_its_boxes_and_dots_and_keeps_its_median_order(label_ws):
    act = pd.DataFrame({"records": [1, 2, 3, 4, 5, 50, 60, 70, 80, 90],
                        "activity": ["money"] * 5 + ["captcha"] * 5})
    spec = spec_of("box", act, label="activity type")
    faint, low, high, box, median = spec["layer"]
    color = {"field": "activity", "type": "nominal", "title": "activity", "sort": ["captcha", "money"], "legend": None}
    assert faint["encoding"]["color"] == color and box["encoding"]["color"] == color
    assert "color" not in median["encoding"], "the median is in ink"
    assert kt._LABELS_READ == [{"id": "k1", "rev": 0}]


def test_an_area_stacks_its_series_in_the_legend_s_order_overlaps_them_lightly_or_shares():
    t = pd.date_range("2026-06-16", periods=3, freq="D")
    posts = pd.DataFrame({"day": list(t) * 2, "posts": [1, 2, 3, 9, 8, 7], "site": ["a"] * 3 + ["b"] * 3})
    spec = spec_of("area", posts)
    enc = spec["encoding"]
    assert spec["mark"] == {"type": "area", "point": True} and enc["x"]["type"] == "temporal"
    assert enc["color"] == {"field": "site", "type": "nominal", "title": "site", "sort": ["b", "a"]}
    assert enc["order"] == {"field": kt.STACK_FIELD, "type": "quantitative"}
    assert spec["transform"] == [{"calculate": 'indexof(["b", "a"], datum["site"])', "as": kt.STACK_FIELD}]
    over = spec_of("area", posts, stack=False)
    assert over["mark"] == {"type": "area", "style": kt.OVERLAP_STYLE, "point": True}
    assert over["encoding"]["y"]["stack"] is None and "order" not in over["encoding"]
    share = spec_of("area", posts, stack="share")["encoding"]["y"]
    assert share["stack"] == "normalize" and share["axis"] == {"format": "%"}
    # a long series is a plain area; marks across it at an x
    long = spec_of("area", pd.DataFrame({"step": range(40), "loss": range(40)}), marks={"warmup": 10})
    assert long["layer"][0]["mark"] == "area" and long["layer"][1]["data"]["values"] == [{"step": 10, "mark": "warmup"}]
    with pytest.raises(ValueError, match='the x numbers or times; `site` holds text; draw categories with "bar"'):
        kt.chart("area", posts[["site", "posts"]])
    with pytest.raises(ValueError, match="`stack` takes the series of a third column, which this frame lacks"):
        kt.chart("area", posts[["day", "posts"]], stack=False)


def test_the_marks_a_chart_names_by_their_job_are_styled_by_the_theme():
    """A faint dot, a box, a median and an overlapping area carry no style of their own: the theme's `style` config gives
    each its look (frontend lib/vizTheme vegaConfig)."""
    theme = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "vizTheme.ts").read_text()
    for name in (kt.FAINT_STYLE, kt.BOX_STYLE, kt.MEDIAN_STYLE, kt.OVERLAP_STYLE):
        assert f"'{name}':" in theme, name
