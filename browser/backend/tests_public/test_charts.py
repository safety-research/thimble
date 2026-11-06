"""thimble.chart (kernel_thimble.chart, docs/charts.md): a common chart from a DataFrame whose columns come in the kind's
order, drawn as plain Vega-Lite that carries no color, font or size of its own, so thimble's theme styles it. The
kernel's display is caught; no kernel, no browser."""

import pandas as pd

from app import cite, kernel_thimble as kt

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
