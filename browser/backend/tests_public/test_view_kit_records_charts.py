"""The view kit's record viewer and charts on the server's side (backend/app/viewer_record.js thimble.record,
viewer_chart.js thimble.chart): every view page loads them with the kit's other parts, the chart part with the canvas's
own chart drawing when the interface is built (views.KIT_CHART_JS); a page's chart asks thimble for its spec with the
kit's own fetch, which thimble answers with the code a card's thimble.chart runs (kernel_thimble.chart_spec), so a
view's chart takes a card's kinds, rows and options, draws the same spec and fails with the same words, and the reader
never sees the fetch; and a page lays the two parts out but does not restyle them (views.own_parts)."""
from __future__ import annotations

import json

import pandas as pd
import pytest

from app import config, kernel_thimble as kt, views

ROWS = [{"agent": "agent-1", "posts": 3, "day": "2026-06-01"}, {"agent": "agent-2", "posts": 9, "day": "2026-06-01"},
        {"agent": "agent-1", "posts": 4, "day": "2026-06-02"}]


def card_spec(kind, df, **options) -> dict:
    """The spec a card's thimble.chart shows for the same frame."""
    shown: list[dict] = []
    real = kt._show
    kt._show = shown.append
    try:
        kt.chart(kind, df, **options)
    finally:
        kt._show = real
    return shown[0][kt.VEGALITE_MIME]


def chart(rows, kind="bar", **options):
    handled, answer = views.kit_answer("kit", {"$thimble": "chart", "kind": kind, "rows": rows, "options": options})
    assert handled, "the kit's own fetch is thimble's to answer"
    return answer


@pytest.fixture()
def kit_ws(workspaces_tmp, tmp_path, monkeypatch):
    (tmp_path / "data" / "kit").mkdir(parents=True)
    (tmp_path / "data" / "kit" / "manifest.json").write_text(json.dumps({"name": "kit", "description": ""}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    ws = config.workspace_dir("kit")
    (ws / "concepts").mkdir(parents=True, exist_ok=True)
    (ws / "concepts" / "k1.json").write_text(json.dumps({"id": "k1", "name": "activity type", "ts": "1",
                                                          "labels": ["captcha", "signup", "money", "other"]}))
    monkeypatch.setattr(kt, "_LABELS_READ", [])
    return ws


@pytest.mark.parametrize(("kind", "options"), [("bar", {}), ("bar", {"stack": "share"}), ("line", {}),
                                                ("dots", {"sort": ["agent-2"]}), ("histogram", {"step": 2})])
def test_a_view_s_chart_is_the_spec_a_card_s_chart_shows_for_the_same_rows(kit_ws, kind, options):
    rows = {"bar": [{k: r[k] for k in ("day", "posts", "agent")} for r in ROWS],
            "line": [{"day": r["day"], "posts": r["posts"], "agent": r["agent"]} for r in ROWS],
            "dots": [{"day": r["day"], "agent": r["agent"]} for r in ROWS],
            "histogram": [{"posts": r["posts"]} for r in ROWS]}[kind]
    got = chart(rows, kind, **options)
    assert got == {"spec": card_spec(kind, pd.DataFrame(rows), **options), "n": len(rows)}


@pytest.mark.parametrize(("kind", "options"), [("density", {}), ("ecdf", {}), ("histogram", {"panels": True}),
                                                ("range", {}), ("scatter", {"fit": "linear"}), ("violin", {}),
                                                ("line", {"interval": ["lo", "hi"]})])
def test_a_view_s_chart_takes_the_density_ecdf_and_range_kinds_panels_and_fit_as_a_card_s_does(kit_ws, kind, options):
    """The kinds and options thimble.chart gained after the view kit's chart came from the same code, so a view draws
    them as a card does: the violin and a line's interval too."""
    values = [{"posts": float(p), "agent": f"agent-{i % 3 + 1}"} for i, p in enumerate((3, 4, 9, 5, 7, 2, 8, 6, 4, 5, 3, 9))]
    rows = {"density": values, "ecdf": values, "histogram": values, "violin": values,
            "range": [{"agent": f"agent-{i}", "before": float(i), "after": float(i * 2 + 1)} for i in range(1, 5)],
            "scatter": [{"day": float(i), "posts": float(i * 2 + i % 3), "agent": f"agent-{i % 2 + 1}"} for i in range(12)],
            "line": [{"day": float(i), "posts": float(i), "lo": i - 0.5, "hi": i + 0.5} for i in range(5)]}[kind]
    got = chart(rows, kind, **options)
    assert got == {"spec": card_spec(kind, pd.DataFrame(rows), **options), "n": len(rows)}


def test_a_wrong_chart_fails_with_the_words_a_card_s_chart_fails_with(kit_ws):
    with pytest.raises(ValueError) as card:
        kt.chart("bar", pd.DataFrame([{"agent": "a"}]))
    assert chart([{"agent": "a"}]) == {"error": str(card.value)}
    assert chart(ROWS, "pie") == {"error": "thimble.chart: no chart kind 'pie'; the kinds are "
                                  + "; ".join(f"{k} {kt._shape(k)}" for k in kt.CHARTS)}
    assert chart(ROWS, step=2)["error"] == "thimble.chart('bar') takes the options sort, stack, label, marks, interval, panels, not 'step'"
    assert "a list of rows" in chart({"agent": "a"})["error"]
    assert "a list of rows" in chart(["agent"])["error"]
    assert "no label named 'nope'" in chart([{"activity": "money", "n": 1}], label="nope")["error"]


def test_a_view_s_chart_of_a_label_takes_its_order_and_its_classes_come_back_for_the_colours(kit_ws):
    """The label is looked up in the view's workspace, as a card looks it up in its kernel's, and its classes come back
    with their colours' places, which the kit draws in the page's own tokens; no card notes it as read."""
    rows = [{"activity": a, "records": n} for a, n in (("other", 50), ("money", 20), ("captcha", 80))]
    got = chart(rows, label="activity type")
    assert got["spec"]["encoding"]["y"]["sort"] == ["captcha", "money", "other"]
    assert got["spec"]["encoding"]["color"]["legend"] is None
    assert got["label"] == kt._find("k1", kit_ws)["classes"]
    assert [v for v, _ in got["label"]] == ["captcha", "signup", "money", "other"] and got["label"][-1][1] == 0, \
        "the label's last class, other, takes the gray"
    assert kt._LABELS_READ == []


def test_the_kit_s_chart_fetch_never_reaches_the_reader(kit_ws, monkeypatch):
    async def no_reader(*a, **k):
        raise AssertionError("the reader was asked")

    monkeypatch.setattr(views, "reader_call", no_reader)
    handled, answer = views.kit_answer("kit", {"$thimble": "chart", "kind": "bar", "rows": ROWS[:2]})
    assert handled and answer["n"] == 2 and "spec" in answer
