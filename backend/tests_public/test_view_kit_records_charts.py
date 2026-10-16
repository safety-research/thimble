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


@pytest.mark.parametrize(("kind", "options"), [("bar", {"stack": "share"}), ("histogram", {"step": 2})])
def test_a_view_s_chart_is_the_spec_a_card_s_chart_shows_for_the_same_rows(kit_ws, kind, options):
    rows = {"bar": [{k: r[k] for k in ("day", "posts", "agent")} for r in ROWS],
            "line": [{"day": r["day"], "posts": r["posts"], "agent": r["agent"]} for r in ROWS],
            "dots": [{"day": r["day"], "agent": r["agent"]} for r in ROWS],
            "histogram": [{"posts": r["posts"]} for r in ROWS]}[kind]
    got = chart(rows, kind, **options)
    assert got == {"spec": card_spec(kind, pd.DataFrame(rows), **options), "n": len(rows)}


def test_the_kit_s_chart_fetch_never_reaches_the_reader(kit_ws, monkeypatch):
    async def no_reader(*a, **k):
        raise AssertionError("the reader was asked")

    monkeypatch.setattr(views, "reader_call", no_reader)
    handled, answer = views.kit_answer("kit", {"$thimble": "chart", "kind": "bar", "rows": ROWS[:2]})
    assert handled and answer["n"] == 2 and "spec" in answer
