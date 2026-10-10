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
        "density": (pd.DataFrame({"minutes": [3, 5, 8, 9, 12, 40, 2], "agent": ["a"] * 6 + ["b"]}),),
        "ecdf": (pd.Series([3, 5, 8, 9, 12, 40, 2], name="minutes"),),
        "range": (pd.DataFrame({"model": ["m1", "m2"], "base": [0.4, 0.6], "tuned": [0.5, 0.55]}),),
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


def test_times_a_week_apart_have_a_tick_at_each_and_times_a_day_apart_keep_vega_s_ticks():
    # seen on collusion-wiki (2026-10-10): weekly bars from Mondays, "week starting" over ticks on May 19, May 27, Jun 3
    weeks = pd.DataFrame({"week starting": pd.to_datetime(["2026-05-18", "2026-05-25", "2026-06-08"]), "saves": [35, 831, 187]})
    ticks = {"values": [{"year": 2026, "month": 5, "date": 18}, {"year": 2026, "month": 5, "date": 25},
                        {"year": 2026, "month": 6, "date": 8}]}
    assert spec_of("bar", weeks)["encoding"]["x"]["axis"] == ticks
    assert spec_of("line", weeks)["encoding"]["x"]["axis"] == ticks
    assert spec_of("area", weeks)["encoding"]["x"]["axis"] == ticks
    assert "axis" not in spec_of("scatter", weeks)["encoding"]["x"]  # points at any time: Vega's ticks
    hours = pd.DataFrame({"t": pd.to_datetime(["2026-05-18 06:00", "2026-05-25 06:00"]), "n": [1, 2]})
    assert spec_of("bar", hours)["encoding"]["x"]["axis"]["values"][0] == {"year": 2026, "month": 5, "date": 18, "hours": 6}
    days = pd.DataFrame({"day": pd.date_range("2026-05-18", periods=10), "saves": range(10)})
    assert "axis" not in spec_of("bar", days)["encoding"]["x"] and "axis" not in spec_of("line", days)["encoding"]["x"]
    many = pd.DataFrame({"week": pd.date_range("2025-01-06", periods=kt.TIME_TICKS_MAX + 1, freq="7D"), "n": 1})
    assert "axis" not in spec_of("bar", many)["encoding"]["x"]


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


def test_a_heatmap_of_days_names_them_as_a_date_axis_does_and_its_rows_keep_the_dates():
    # seen on collusion-wiki (2026-10-10): 11 days as `2026-06-18` on end under a card's heatmap
    hm = pd.DataFrame({"day": ["2026-06-18", "2026-05-24", "2026-06-18"], "account": ["a", "b", "b"], "saves": [3, 1, 2]})
    spec = spec_of("heatmap", hm)
    x = spec["encoding"]["x"]
    assert x["sort"] == ["2026-05-24", "2026-06-18"] and spec["data"]["values"][0]["day"] == "2026-06-18"
    assert x["axis"] == {"labelExpr": "datum.value == null ? '' : utcFormat(utcParse(datum.value, '%Y-%m-%d'), '%b %-d')"}
    assert "axis" not in spec["encoding"]["y"]
    years = pd.DataFrame({"t": pd.to_datetime(["2025-12-31 23:00", "2026-01-01 01:30"]), "y": ["a", "a"], "n": [1, 2]})
    assert "'%Y-%m-%d %H:%M'), '%b %-d, %Y %H:%M')" in spec_of("heatmap", years)["encoding"]["x"]["axis"]["labelExpr"]


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


def test_dots_put_each_row_s_groups_side_by_side_on_its_line_with_or_without_an_interval():
    ev = pd.DataFrame({"accuracy": [0.6, 0.7, 0.8], "model": ["m1", "m1", "m2"], "condition": ["cot", "plain", "cot"],
                       "lo": [0.5, 0.6, 0.7], "hi": [0.7, 0.8, 0.9]})
    spec = spec_of("dots", ev, interval=("lo", "hi"), marks={"chance": 0.5})
    dots, rule = spec["layer"][0]["layer"]
    assert dots["mark"] == "point" and dots["encoding"]["yOffset"] == {"field": "condition", "type": "nominal",
                                                                       "sort": ["cot", "plain"]}
    assert rule["mark"] == "rule" and rule["encoding"]["x"]["field"] == "lo" and rule["encoding"]["yOffset"]["field"] == "condition"
    assert spec["layer"][1]["data"]["values"] == [{"accuracy": 0.5, "mark": "chance"}]
    # without an interval too (QA 2026-10-10: two groups at one value on a row blended into a dark dot the legend does
    # not show), so every dot keeps its own color; in panels each group has its row's line to itself
    plain = spec_of("dots", ev[["accuracy", "model", "condition"]])["encoding"]
    assert plain["yOffset"] == {"field": "condition", "type": "nominal", "sort": ["cot", "plain"]}
    assert "yOffset" not in spec_of("dots", ev[["accuracy", "model", "condition"]], panels=True)["encoding"]
    # a chart with no group column has no groups to set apart
    assert "yOffset" not in spec_of("dots", ev[["accuracy", "model"]])["encoding"]


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
    """A faint dot, a box, a median, an overlapping area, a fitted line and a range's before end carry no style of their
    own: the theme's `style` config gives each its look (frontend lib/vizTheme vegaConfig)."""
    theme = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "vizTheme.ts").read_text()
    for name in (kt.FAINT_STYLE, kt.BOX_STYLE, kt.MEDIAN_STYLE, kt.OVERLAP_STYLE, kt.FIT_STYLE, kt.START_STYLE):
        assert f"'{name}':" in theme, name


# ---------------------------------------------------------------------------------------------- density, ecdf, range
# Matt (2026-10-10): density curves, a ridgeline when there are many groups; the cumulative share; a dumbbell per item,
# before against after. Each computes its values in Python, so the spec carries plain rows the terminal and a takeaway
# read.

MERGE = pd.DataFrame({"minutes": [12, 15, 18, 20, 22, 30, 41, 55, 9, 14, 16, 25, 28, 33, 60, 75],
                      "agent": ["a"] * 8 + ["b"] * 8})


def _area(xs, ds) -> float:
    return sum((xs[i + 1] - xs[i]) * (ds[i] + ds[i + 1]) / 2 for i in range(len(xs) - 1))


def test_a_density_is_a_smooth_curve_of_area_one_stopping_at_zero_when_no_value_is_below_it():
    spec = spec_of("density", MERGE["minutes"])  # a Series is its values, as for a histogram
    rows = spec["data"]["values"]
    xs, ds = [r["minutes"] for r in rows], [r["density"] for r in rows]
    assert len(rows) == kt.DENSITY_POINTS and set(rows[0]) == {"minutes", "density"}
    assert xs == sorted(xs) and xs[0] == 0 and xs[-1] > 75
    assert abs(_area(xs, ds) - 1) < 0.005, "the smoothing past 0 is folded back inside, so the area stays 1"
    assert spec["mark"] == {"type": "area", "line": True, "interpolate": "monotone", "style": kt.OVERLAP_STYLE}
    # values crowding 0 keep their curve high at 0, rather than sinking toward it as a cut-off kernel would
    crowd = [r["density"] for r in spec_of("density", pd.Series([0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2, 3], name="m"))["data"]["values"]]
    assert crowd[0] == max(crowd)
    # values on both sides of 0 keep the whole curve, its area 1
    both = spec_of("density", pd.Series([-3.0, -1, 0, 1, 2, 4], name="delta"))["data"]["values"]
    assert both[0]["delta"] < -3 and abs(_area([r["delta"] for r in both], [r["density"] for r in both]) - 1) < 0.01
    # a wider bandwidth smooths more: a lower peak
    assert max(r["density"] for r in spec_of("density", MERGE["minutes"], bandwidth=20)["data"]["values"]) < max(ds)
    with pytest.raises(ValueError, match="`bandwidth` is the width of the smoothing in `minutes`'s units"):
        kt.chart("density", MERGE["minutes"], bandwidth=0)


def test_a_narrow_curve_beside_a_wide_range_gets_the_points_its_bump_needs():
    """A tight group in a range a spread group stretches is drawn through a point every half of its smoothing width, up
    to DENSITY_POINTS_MAX, and many groups keep DENSITY_ROWS rows in all while each keeps DENSITY_POINTS."""
    rng = __import__("numpy").random.default_rng(1)
    wide = pd.DataFrame({"ms": [*rng.normal(10, 0.5, 50), *range(0, 1000, 20)], "path": ["cache"] * 50 + ["disk"] * 50})
    rows = spec_of("density", wide)["data"]["values"]
    cache = [r for r in rows if r["path"] == "cache"]
    assert len(cache) == kt.DENSITY_POINTS_MAX and len(rows) == 2 * kt.DENSITY_POINTS_MAX
    peak = max(cache, key=lambda r: r["density"])
    assert 9 < peak["ms"] < 11 and peak["density"] > 0.5, "the tight group's peak is drawn, not stepped over"
    many = pd.DataFrame({"ms": rng.normal(0, 1, 6000), "run": [f"r{i % 60}" for i in range(6000)]})
    assert len(spec_of("density", many, panels=True)["data"]["values"]) == 60 * kt.DENSITY_POINTS


def test_a_few_groups_overlap_lightly_and_many_stand_one_over_another_named_on_the_y_axis():
    spec = spec_of("density", MERGE)
    enc = spec["encoding"]
    assert enc["color"]["field"] == "agent" and enc["color"]["sort"] == ["b", "a"], "the largest median first"
    assert enc["y"]["stack"] is None, "the curves overlap rather than stack"
    assert {r["agent"] for r in spec["data"]["values"]} == {"a", "b"}
    agents = [f"agent-{i}" for i in range(kt.RIDGE_FROM)]
    many = pd.DataFrame({"minutes": [v + 10 * i for i in range(len(agents)) for v in (1, 4, 6, 9)],
                         "agent": [a for a in agents for _ in range(4)]})
    ridge = spec_of("density", many)
    enc = ridge["encoding"]
    # the places of the ridges are laid out by the chart; the rows hold the curves alone
    assert set(ridge["data"]["values"][0]) == {"minutes", "density", "agent"}
    assert [t["as"] for t in ridge["transform"]] == [kt.RIDGE_BASE, kt.RIDGE_TOP]
    assert (enc["y"]["field"], enc["y2"]["field"], enc["detail"]["field"]) == (kt.RIDGE_TOP, kt.RIDGE_BASE, "agent")
    assert enc["y"]["title"] == "agent" and enc["y"]["axis"]["values"] == list(range(len(agents)))
    # the largest median on top: the axis names the baselines from the bottom up
    assert enc["y"]["axis"]["labelExpr"] == json.dumps(agents) + "[datum.value]" and "color" not in enc
    assert styles(ridge) == []
    assert "transform" not in spec_of("density", many, panels=True), "panels draw each group in its own panel instead"
    assert spec_of("density", many, sort=None)["transform"][0]["calculate"].startswith(f"{len(agents) - 1} - indexof({json.dumps(agents)}")


def test_an_ecdf_holds_the_share_of_values_at_or_below_each_value():
    bundle = drawn("ecdf", pd.Series([3, 1, 2, 2], name="minutes"))
    spec = bundle[kt.VEGALITE_MIME]
    assert spec["data"]["values"] == [{"minutes": 1, "share": 0.25}, {"minutes": 2, "share": 0.75}, {"minutes": 3, "share": 1}]
    assert spec["mark"] == {"type": "line", "interpolate": "step-after", "point": True}
    assert spec["encoding"]["y"]["axis"] == {"format": "%"}
    table = cite.chart_table(bundle)
    assert table.label == "minutes" and table.cells[table.labels.index("2")] == ["0.75"], "a takeaway cites the share at a value"
    # groups listed by their median, the least first, as their curves stand from the top
    assert spec_of("ecdf", MERGE)["encoding"]["color"]["sort"] == ["a", "b"]
    # many values are kept at ECDF_STEPS_MAX of them, the last share 1; a long curve has no dots
    big = spec_of("ecdf", pd.Series(range(20000), name="tokens"))
    assert len(big["data"]["values"]) == kt.ECDF_STEPS_MAX and big["data"]["values"][-1] == {"tokens": 19999, "share": 1}
    assert big["mark"] == {"type": "line", "interpolate": "step-after"}
    with pytest.raises(ValueError, match="`label` colors the group column, which this frame lacks"):
        kt.chart("ecdf", MERGE["minutes"], label="activity type")


EVAL2 = pd.DataFrame({"model": ["m1", "m2", "m3"], "base": [0.40, 0.55, 0.62], "tuned": [0.48, 0.81, 0.58],
                      "family": ["open", "closed", "open"]})


def test_a_range_draws_a_dumbbell_per_item_from_its_before_ring_to_its_after_dot():
    bundle = drawn("range", EVAL2[["model", "base", "tuned"]])
    spec = bundle[kt.VEGALITE_MIME]
    rule, start, end = spec["layer"]
    assert rule["mark"] == "rule" and (rule["encoding"]["x"]["field"], rule["encoding"]["x2"]) == ("base", {"field": "tuned"})
    assert start["mark"] == {"type": "point", "style": kt.START_STYLE} and start["encoding"]["x"]["field"] == "base"
    assert end["mark"] == "point" and end["encoding"]["x"]["field"] == "tuned"
    assert all(l["encoding"]["x"]["title"] == "base \u2192 tuned" for l in spec["layer"])
    assert all(l["encoding"]["x"]["scale"] == {"zero": False, "padding": kt.RANGE_PAD} for l in spec["layer"]), \
        "the ends are places, not lengths, and the outermost clear the axis line"
    assert start["encoding"]["y"]["sort"] == ["m2", "m3", "m1"], "the largest after first"
    table = cite.chart_table(bundle)
    assert table.label == "model" and table.cells[table.labels.index("m2")] == ["0.55", "0.81"]
    grouped = spec_of("range", EVAL2)["layer"]
    assert grouped[1]["encoding"]["color"]["field"] == "family" and "color" not in grouped[0]["encoding"]
    # times: a span per item, the earliest first
    spans = pd.DataFrame({"agent": ["a", "b"], "first": pd.to_datetime(["2026-08-02", "2026-08-01"]),
                          "last": pd.to_datetime(["2026-08-09", "2026-08-03"])})
    s = spec_of("range", spans, marks={"freeze": "2026-08-05"})
    assert s["layer"][0]["layer"][1]["encoding"]["y"]["sort"] == ["b", "a"]
    assert s["layer"][0]["layer"][1]["encoding"]["x"]["type"] == "temporal" and s["layer"][1]["mark"] == "rule"
    assert s["layer"][0]["layer"][0]["encoding"]["x"]["scale"] == {"padding": kt.RANGE_PAD}
    # an item in several groups has their dumbbells side by side on its line, not one over another
    per = spec_of("range", pd.DataFrame({"model": ["m1", "m1", "m2"], "base": [0.4, 0.5, 0.6], "tuned": [0.6, 0.55, 0.7],
                                         "bench": ["math", "code", "math"]}))
    assert all(l["encoding"]["yOffset"] == {"field": "bench", "type": "nominal", "sort": ["math", "code"]} for l in per["layer"])
    assert "yOffset" not in grouped[1]["encoding"], "each item once: its line holds its one dumbbell"
    with pytest.raises(ValueError, match="the before and after both numbers or both times; `first` holds times and `n` numbers"):
        kt.chart("range", spans[["agent", "first"]].assign(n=[1, 2]))


def test_a_scatter_fits_a_line_or_a_smooth_curve_per_group_its_fitted_values_a_column_of_its_rows():
    line = pd.DataFrame({"tokens": [1, 2, 3, 4, 5], "cost": [3, 5, 7, 9, 11]})
    bundle = drawn("scatter", line, fit="linear")
    spec = bundle[kt.VEGALITE_MIME]
    points, fitted = spec["layer"]
    assert points["mark"] == "point" and fitted["mark"] == {"type": "line", "style": kt.FIT_STYLE}
    assert fitted["encoding"]["y"] == {"field": "cost fit", "type": "quantitative", "title": "cost"}
    assert [r["cost fit"] for r in spec["data"]["values"]] == [3, 5, 7, 9, 11]
    assert "cost fit" in cite.chart_table(bundle).columns, "a takeaway cites a fitted value"
    # each group its own line, in its color
    two = pd.DataFrame({"x": [1, 2, 3, 1, 2, 3], "y": [1, 2, 3, 10, 8, 6], "model": ["a"] * 3 + ["b"] * 3})
    s = spec_of("scatter", two, fit="linear")
    assert [r["y fit"] for r in s["data"]["values"]] == [1, 2, 3, 10, 8, 6] and s["layer"][1]["encoding"]["color"]["field"] == "model"
    # a smooth fit follows a curve a line cannot, and an outlier barely moves it
    xs = list(range(40))
    curve = pd.DataFrame({"x": xs, "y": [(x - 20) ** 2 / 10 for x in xs]})
    curve.loc[25, "y"] = 500
    got = [r["y fit"] for r in spec_of("scatter", curve, fit="smooth")["data"]["values"]]
    assert max(abs(g - (x - 20) ** 2 / 10) for x, g in zip(xs, got) if x not in (24, 25, 26)) < 4
    with pytest.raises(ValueError, match='`fit` is "linear" or "smooth", not \'loess\''):
        kt.chart("scatter", line, fit="loess")
    with pytest.raises(ValueError, match="a smooth fit needs 3 or more points with distinct x values in a chart"):
        kt.chart("scatter", line.head(2), fit="smooth")


def test_panels_put_each_group_in_a_panel_of_its_own_sharing_scales_and_marks_repeat_in_each():
    t = pd.date_range("2026-08-01", periods=3, freq="D")
    cases = {
        "bar": pd.DataFrame({"agent": ["a", "b"] * 2, "calls": [1, 2, 3, 4], "run": ["r1", "r1", "r2", "r2"]}),
        "area": pd.DataFrame({"day": list(t) * 2, "posts": [1, 2, 3, 4, 5, 6], "site": ["w"] * 3 + ["f"] * 3}),
        "scatter": pd.DataFrame({"x": [1, 2, 3, 4], "y": [1, 2, 3, 4], "g": ["a", "a", "b", "b"]}),
        "dots": pd.DataFrame({"time": list(t) + list(t), "agent": ["a", "b", "a"] * 2, "outcome": ["ok"] * 3 + ["no"] * 3}),
        "histogram": MERGE,
        "density": MERGE,
    }
    assert {k for k, (_c, _n, opts) in kt.CHARTS.items() if "panels" in opts} == {*cases, "line"}
    for kind, df in cases.items():
        spec = spec_of(kind, df, panels=True)
        grp = df.columns[2] if len(df.columns) > 2 else df.columns[1]
        assert spec["encoding"]["row"] == {"field": grp, "type": "nominal", "sort": spec["encoding"]["row"]["sort"],
                                           "title": None}, kind
        assert "resolve" not in spec and "transform" not in spec and "yOffset" not in spec["encoding"], kind
        assert styles(spec) == [], kind
    # a layered chart goes inside a facet by rows; a mark across the chart, rows of its own, repeats in every panel
    faceted = spec_of("scatter", cases["scatter"], panels=True, fit="linear", marks={"launch": 2})
    assert faceted["facet"] == {"row": {"field": "g", "type": "nominal", "sort": ["a", "b"], "title": None}}
    inner = faceted["spec"]["layer"]
    assert "data" not in inner[0] and inner[1]["data"]["values"] == [{"x": 2, "mark": "launch"}]
    assert faceted["data"]["values"][0]["y fit"] == 1
    # a line chart's panels each keep their own y scale, and now take marks too
    series = pd.DataFrame({"month": ["2025-04", "2025-05"] * 2, "value": [1, 9, 4, 5], "measure": ["turns"] * 2 + ["agents"] * 2})
    lines = spec_of("line", series, panels=True, marks={"v2": "2025-05-01"})
    assert lines["facet"]["row"]["field"] == "measure" and lines["resolve"] == {"scale": {"y": "independent"}}
    with pytest.raises(ValueError, match="`panels` put each group in a panel of its own; leave out `stack`"):
        kt.chart("bar", cases["bar"], panels=True, stack=True)
    with pytest.raises(ValueError, match="`panels` is True or False and needs a group column"):
        kt.chart("histogram", MERGE["minutes"], panels=True)


def test_a_histogram_s_groups_share_its_bins_stacked_in_the_legend_s_order():
    spec = spec_of("histogram", MERGE, step=20)
    rows = spec["data"]["values"]
    assert {(r["minutes"], r["agent"]): r["count"] for r in rows} == {
        (0, "a"): 3, (20, "a"): 3, (40, "a"): 2, (60, "a"): 0, (0, "b"): 3, (20, "b"): 3, (40, "b"): 0, (60, "b"): 2}
    assert spec["encoding"]["color"]["sort"] == ["a", "b"] and spec["encoding"]["order"]["field"] == kt.STACK_FIELD
    # a Series is its values alone, a named index (groupby's) included, as before
    per_agent = MERGE.groupby("minutes").size().rename("PRs")
    assert set(spec_of("histogram", per_agent)["data"]["values"][0]) == {"PRs", "PRs end", "count"}


def test_new_kinds_fail_on_a_wrong_frame_with_one_line_that_names_the_columns_they_take():
    cases = [
        (("density", MERGE[["agent", "minutes"]]), "takes (value) or (value, group) columns, the value numbers; `agent` holds text"),
        (("ecdf", MERGE.assign(x=1)), "takes (value) or (value, group) columns, in that order; got 3"),
        (("range", EVAL2[["model", "base"]]), "takes (item, before, after) or (item, before, after, group) columns, in that "
                                              "order; got 2: model, base"),
        (("range", EVAL2[["model", "family", "tuned"]]), "the before numbers or times; `family` holds text"),
        (("density", MERGE["minutes"]), None),
    ]
    for args, words in cases:
        if words is None:
            kt._show, real = (lambda _b: None), kt._show
            try:
                kt.chart(*args)
            finally:
                kt._show = real
            continue
        with pytest.raises((ValueError, TypeError)) as e:
            kt.chart(*args)
        assert words in str(e.value) and "\n" not in str(e.value), str(e.value)
    # a density, an ecdf and a histogram take any number of values
    assert len(spec_of("density", pd.Series(range(kt.CHART_ROWS_MAX + 1), name="n"))["data"]["values"]) == kt.DENSITY_POINTS


def test_values_that_are_missing_or_infinite_are_left_out_and_none_left_fails_in_one_line():
    """A histogram, a density and an ecdf draw the finite values; with none, the call fails with one line rather than
    numpy's error."""
    import numpy as np

    for kind in kt._VALUES:
        for empty in (pd.Series([], name="minutes", dtype=float), pd.Series([np.nan, np.inf, -np.inf], name="minutes")):
            with pytest.raises(ValueError, match=r"^thimble\.chart\('\w+'\): `minutes` holds no numbers to draw$"):
                kt.chart(kind, empty)
    rows = spec_of("ecdf", pd.Series([3, np.inf, 1, np.nan], name="minutes"))["data"]["values"]
    assert rows == [{"minutes": 1, "share": 0.5}, {"minutes": 3, "share": 1}]
    assert sum(r["count"] for r in spec_of("histogram", pd.Series([1, 2, np.inf], name="minutes"))["data"]["values"]) == 2
    # a group left with no values is left out, as a group with no name is
    two = pd.DataFrame({"minutes": [1.0, 2, 3, np.inf], "agent": ["a", "a", "a", "b"]})
    assert {r["agent"] for r in spec_of("density", two)["data"]["values"]} == {"a"}


# ------------------------------------------------------------------------------------- the agent's own marks on a chart
# Matt (2026-10-10): "I just want generic ways for the agents to add custom markup". show=False returns the chart as an
# Altair chart; thimble.theme names the theme's colors, which the card reads (frontend lib/vizTheme withTokens).


def test_show_false_returns_an_altair_chart_to_layer_marks_on_and_shows_nothing():
    import altair as alt

    daily = pd.DataFrame({"day": pd.date_range("2026-08-01", periods=4, freq="D"), "merged": [3, 9, 4, 7]})
    events = pd.DataFrame({"day": pd.to_datetime(["2026-08-02"]), "note": ["CI moved"]})
    real, kt._show = kt._show, (lambda _b: pytest.fail("show=False shows nothing"))
    try:
        bars = kt.chart("bar", daily, show=False)
    finally:
        kt._show = real
    assert isinstance(bars, alt.Chart)
    ev = alt.Chart(events)
    layered = (bars + ev.mark_rule(color=kt.theme.pale).encode(x="day:T")
               + ev.mark_text(color=kt.theme.accent).encode(x="day:T", text="note:N")).to_dict()
    assert [l["mark"]["color"] for l in layered["layer"][1:]] == ["var(--viz-ink-4)", "var(--viz-highlight)"]
    # the chart's rows stay its table, which a takeaway cites, by the same row labels
    table = cite.chart_table({kt.VEGALITE_MIME: layered})
    assert table.columns == ["merged", "day end"] and table.cells[1] == ["9", "2026-08-03T00:00:00"]
    # and so wherever the chart stands among the layers: a shaded span drawn first, behind the bars, takes nothing from it
    span = alt.Chart(pd.DataFrame({"a": ["2026-08-02"], "b": ["2026-08-03"]})).mark_rect(color=kt.theme.pale)
    behind = cite.chart_table({kt.VEGALITE_MIME: (span.encode(x="a:T", x2="b:T") + bars + ev.mark_text().encode(x="day:T", text="note:N")).to_dict()})
    assert (behind.columns, behind.labels, behind.cells) == (table.columns, table.labels, table.cells)
    alone = cite.chart_table({kt.VEGALITE_MIME: (span.encode(x="a:T", x2="b:T") + ev.mark_text().encode(x="day:T", text="note:N")).to_dict()})
    assert (alone.label, alone.columns) == ("a", ["b"]), "a chart of the code's own layers alone reads its first part's rows, as before"
    # every kind comes back as an Altair chart that draws what thimble.chart shows, its rows and all
    def inline(node, sets):
        if isinstance(node, dict):
            if set(node) == {"name"} and node["name"] in sets:
                return {"values": sets[node["name"]]}
            return {k: inline(v, sets) for k, v in node.items() if k not in ("$schema", "config", "datasets")}
        return [inline(v, sets) for v in node] if isinstance(node, list) else node

    for kind, df, opts in [("bar", EVALS, {"interval": ("lo", "hi")}), ("dots", EVALS[["accuracy", "model", "lo", "hi"]],
                                                                         {"interval": ("lo", "hi"), "marks": {"x": 0.5}}),
                           ("box", TURNS, {}), ("density", MERGE, {}), ("ecdf", MERGE, {}), ("range", EVAL2, {}),
                           ("histogram", MERGE, {"panels": True}), ("heatmap", LINKS[["site", "posted on", "link posts"]], {}),
                           ("scatter", EVAL2[["base", "tuned", "family"]], {"fit": "linear", "panels": True}),
                           ("line", EVAL2[["base", "tuned"]], {})]:
        got = kt.chart(kind, df, show=False, **opts).to_dict()
        assert got["$schema"].startswith("https://vega.github.io/schema/vega-lite/v6"), kind
        # the chart's own rows stay inline under a name of their own (cite reads them by it), the rest as shown
        assert got["data"].pop("name").startswith(kt.CHART_ROWS_NAME), kind
        shown = spec_of(kind, df, **opts)
        del shown["$schema"]
        assert inline(got, got.get("datasets", {})) == shown, kind
    with pytest.raises(ValueError, match="`show` is True, which shows the chart, or False"):
        kt.chart("bar", POSTS, show="no")


def test_a_chart_layered_in_plain_altair_cites_its_data_not_the_marks_on_it():
    """The live QA of 0.7.0 (2026-10-10): main layered its own Altair, a pale span behind daily bars with notes on them,
    without thimble.chart(show=False), and the card's table was the span's one row. A layered chart's table is its
    layer with the most rows, in a panel of a concatenated chart too, while a ref into another layer's rows still reads
    its value."""
    import altair as alt

    daily = pd.DataFrame({"day": pd.date_range("2026-06-14", periods=6, freq="D"), "saves": [40, 2610, 6543, 312, 97, 5]})
    span = alt.Chart(pd.DataFrame({"start": ["2026-06-16"], "end": ["2026-06-20"]})).mark_rect(color=kt.theme.pale)
    notes = alt.Chart(pd.DataFrame({"day": ["2026-06-16"], "y": [6800], "t": ["Jun 16: 6,543 saves"]}))
    bars = alt.Chart(daily).mark_bar().encode(x="day:T", y="saves:Q")
    layered = (span.encode(x="start:T", x2="end:T") + bars + notes.mark_rule().encode(x="day:T")
               + notes.mark_text(color=kt.theme.accent).encode(x="day:T", y="y:Q", text="t:N"))
    bundle = {kt.VEGALITE_MIME: layered.to_dict()}
    table = cite.chart_table(bundle)
    assert (table.label, table.columns, table.total) == ("day", ["saves"], 6)
    assert table.labels[2] == "2026-06-16T00:00:00" and table.cells[2] == ["6543"]
    assert cite.data_totals([bundle])[:2] == ["6", "9607"], "the totals are the days'"
    # the takeaway's numbers link to the days; a ref the model wrote into the span's row still resolves
    res = cite.resolve("q2", "Saves peaked at 6,543 on June 16; the span ends [[2026-06-20|card:q2#end/2026-06-16]].",
                       [bundle], keep_stale=True)
    assert [(link.token, link.ref) for link in res.links] == [
        ("6,543", "card:q2#saves/2026-06-16T00:00:00"), ("June 16", "card:q2#day/2026-06-16T00:00:00"),
        ("2026-06-20", "card:q2#end/2026-06-16")]
    assert not res.stale and not res.unresolved
    assert cite.find_td([bundle], "end", "2026-06-16")[0] == "2026-06-20"
    # a panel of a concatenated chart is read the same way, the first panel first, and a facet by its data
    other = alt.Chart(POSTS).mark_bar().encode(x="agent", y="posts")
    side = cite.chart_table({kt.VEGALITE_MIME: alt.hconcat(layered, other).to_dict()})
    assert (side.label, side.columns) == ("day", ["saves"])
    rows = pd.DataFrame({"day": list(daily["day"]) * 2, "saves": list(daily["saves"]) * 2, "wiki": ["a"] * 6 + ["b"] * 6})
    base = alt.Chart(rows).encode(x="day:T", y="saves:Q")
    panels = (base.mark_bar() + base.mark_text().encode(text="saves:Q")).facet(row="wiki")
    faceted = cite.chart_table({kt.VEGALITE_MIME: panels.to_dict()})
    assert (faceted.columns, faceted.total) == (["day", "saves", "wiki"], 12)


def test_theme_names_the_theme_s_roles_as_the_css_variables_the_card_reads():
    theme = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "vizTheme.ts").read_text()
    roles = [kt.theme.accent, kt.theme.ink, kt.theme.muted, kt.theme.pale, *kt.theme.series]
    assert len(kt.theme.series) == 7 and kt.theme.series[0] == "var(--viz-1)"
    for role in roles:
        name = role.removeprefix("var(").removesuffix(")")
        assert name.startswith("--viz-") and f"'{name}':" in theme, role
    assert "theme" in kt.__all__ and "accent" in repr(kt.theme)
    with pytest.raises(AttributeError):
        kt.theme.accent = "#f00"


def test_the_screenshot_page_without_the_theme_draws_theme_colors_in_vega_s_own(monkeypatch):
    """The page a card's chart is shot on when neither the card harness nor the UI is up draws without thimble's theme,
    so a mark colored with thimble.theme takes the matching color of Vega's default look, never black or nothing."""
    from app import tools

    monkeypatch.setattr(tools, "VEGA_BUILDS", ())
    spec = {"layer": [{"mark": {"type": "rule", "color": kt.theme.pale}}, {"mark": {"type": "text", "color": kt.theme.accent}},
                      {"mark": {"type": "point", "color": kt.theme.series[2]}}, {"mark": {"type": "text", "text": "var(--accent)"}}]}
    page = tools.chart_page(spec)
    assert "var(--viz" not in page and all(c in page for c in ("#cccccc", "#4c78a8", "#e45756"))
    assert "var(--accent)" in page, "only the chart tokens thimble.theme names"


def test_the_doc_s_example_of_events_called_out_above_a_daily_bar_chart_runs_as_written(monkeypatch):
    """docs/charts.md's example of an agent's own marks, run as a card runs it."""
    import ast
    import re
    import sys

    doc = (Path(__file__).resolve().parents[2] / "docs" / "charts.md").read_text()
    block = next(b for b in re.findall(r"```python\n(.*?)```", doc, re.S) if "show=False" in b)
    monkeypatch.setitem(sys.modules, "thimble", kt)
    tree = ast.parse(block)
    last = tree.body.pop()
    ns = {"daily": pd.DataFrame({"day": pd.date_range("2026-08-01", periods=10, freq="D"), "merged": range(10)}),
          "events": pd.DataFrame({"day": pd.to_datetime(["2026-08-03", "2026-08-07"]), "note": ["CI moved", "freeze"]})}
    exec(compile(tree, "charts.md", "exec"), ns)
    chart = eval(compile(ast.Expression(last.value), "charts.md", "eval"), ns).to_dict()
    marks = [(l["mark"]["type"], l["mark"].get("color")) for l in chart["layer"][1:]]
    assert marks == [("rule", kt.theme.pale), ("text", kt.theme.accent), ("text", None)]
    assert cite.chart_table({kt.VEGALITE_MIME: chart}).columns == ["merged", "day end"]
