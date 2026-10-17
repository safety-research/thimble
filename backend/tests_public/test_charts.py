"""thimble.chart (kernel_thimble.chart, docs/charts.md): a common chart from a DataFrame whose columns come in the kind's
order, drawn as plain Vega-Lite that carries no color, font or size of its own, so thimble's theme styles it. Matt
(2026-10-09): "for those defaults you just provide data in the right format and not the plotting code by hand every
time". The kernel's display is caught; no kernel, no browser."""
from pathlib import Path

import pandas as pd

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
        "violin": (pd.DataFrame({"minutes": [3, 5, 8, 9, 12, 40, 2], "agent": ["a"] * 6 + ["b"]}),),
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


# ------------------------------------------------------------------------------------- the agent's own marks on a chart
# Matt (2026-10-10): "I just want generic ways for the agents to add custom markup". show=False returns the chart as an
# Altair chart; thimble.theme names the theme's colors, which the card reads (frontend lib/vizTheme withTokens).


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
    # a rule at a value drawn first, which Altair gives one empty row, is no table either
    ruled = cite.chart_table({kt.VEGALITE_MIME: (alt.Chart().mark_rule().encode(y=alt.datum(3000)) + bars).to_dict()})
    assert (ruled.label, ruled.columns) == ("day", ["saves"])
    # a panel of a concatenated chart is read the same way, and a facet by its data
    other = alt.Chart(POSTS).mark_bar().encode(x="agent", y="posts")
    side = cite.chart_table({kt.VEGALITE_MIME: alt.hconcat(layered, other).to_dict()})
    assert (side.label, side.columns) == ("day", ["saves"])
    rows = pd.DataFrame({"day": list(daily["day"]) * 2, "saves": list(daily["saves"]) * 2, "wiki": ["a"] * 6 + ["b"] * 6})
    base = alt.Chart(rows).encode(x="day:T", y="saves:Q")
    panels = (base.mark_bar() + base.mark_text().encode(text="saves:Q")).facet(row="wiki")
    faceted = cite.chart_table({kt.VEGALITE_MIME: panels.to_dict()})
    assert (faceted.columns, faceted.total) == (["day", "saves", "wiki"], 12)


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
