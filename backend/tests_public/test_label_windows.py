"""A prompt label reads a long record whole: a record longer than concepts.WINDOW_TEXT_MAX goes to the classifier in
overlapping windows, and the record takes the value of the window that says the most, so it matches when any window
does. A unit read no further than UNIT_TEXT_MAX (a whole file) is counted, and the run's message says how many.

The corpus is invented: episodes/ep1/log.json is one line of about 100,000 characters whose only mention of the event
sits past the 70,000th, and episodes/ep2/log.json is one short line."""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config
from app import model as model_mod

CORPUS = "windows"
EVENT = "the scheduler stopped the other team's worker"
LONG, SHORT = "episodes/ep1/log.json", "episodes/ep2/log.json"


def _long_text() -> str:
    filler = " ".join(f"step {n}: the build passed and the logs rotated." for n in range(2_000))
    return filler[:70_500] + f" Then {EVENT}. " + filler[:29_000]


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    data = tmp_path / "data"
    root = data / CORPUS
    for rel, text in ((LONG, _long_text()), (SHORT, "step 1: the build passed.")):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(json.dumps({"agent": "u1", "text": text}))
    (root / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks, concepts._building,
                  concepts._building_answers):
        table.clear()
    return root


@pytest.fixture()
async def api(corpus):
    app = FastAPI()
    app.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as c:
        yield c


class Classifier:
    """concepts.classify_structured scripted: an item is `stopped` when its text holds EVENT, with a rationale that
    names where it is, and `no` otherwise."""

    items: list[tuple[str, str]] = []

    @staticmethod
    async def call(c, concept, items, comment=True):
        Classifier.items += items
        return model_mod.CallResult(status="ok", output={"labels": [
            {"i": n, "label": "stopped" if EVENT in t else "no", "confidence": 0.9 if EVENT in t else 0.8,
             "rationale": f"{len(t)} chars; {'names the stop' if EVENT in t else 'nothing stopped'}",
             "quote": EVENT if EVENT in t else ""}
            for n, (_ref, t) in enumerate(items, 1)]})


async def _no_api() -> bool:
    return False


@pytest.fixture()
def classifier(monkeypatch):
    Classifier.items = []
    monkeypatch.setattr(concepts, "classify_structured", Classifier.call)
    monkeypatch.setattr(model_mod, "api_path_ready", _no_api)
    return Classifier


async def _apply(api, unit: str, marks: str = "record") -> dict:
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "stopped a rival", "description": "a rival's process is stopped",
                                                         "labels": ["stopped", "no"], "unit": unit, "marks": marks})
    assert r.status_code == 200, r.text
    k = r.json()
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["episodes/*/log.json"]})
    assert r.status_code == 200, r.text
    return {**k, "summary": r.json()}


async def test_a_long_record_is_read_whole_in_windows_and_matches_where_one_window_does(api, classifier):
    k = await _apply(api, "record", marks="span")
    s = k["summary"]
    assert s["total"] == 2 and s["labeled"] == 2 and s["failed"] == 0 and s["message"] is None
    long_items = [t for ref, t in classifier.items if ref == f"{LONG}#L1"]
    assert len(long_items) == 4  # about 100,000 characters in windows of 30,000 that overlap
    assert all(len(t) <= concepts.WINDOW_TEXT_MAX for t in long_items)
    assert sum(EVENT in t for t in long_items) >= 1
    assert [t for ref, t in classifier.items if ref == f"{SHORT}#L1"] and len([1 for ref, _ in classifier.items if ref == f"{SHORT}#L1"]) == 1
    rows = {r["ref"]: r for r in concepts.read_labels(config.workspace_dir(CORPUS), k["id"])}
    assert rows[f"{LONG}#L1"]["label"] == "stopped" and "names the stop" in rows[f"{LONG}#L1"]["rationale"]
    assert rows[f"{LONG}#L1"]["spans"] == [EVENT]
    assert rows[f"{SHORT}#L1"]["label"] == "no"
    assert s["matches"] == 1


def test_windows_cover_the_whole_text_with_an_overlap():
    text = "".join(f"word{n} " for n in range(20_000))
    u = concepts.Unit("a.json#L1", ["a.json"], lambda: iter([("a.json#L1", text)]))
    parts = u.windows(30_000)
    assert len(parts) > 1 and all(len(p) <= 30_000 for p in parts)
    assert parts[0] == text[:len(parts[0])] and text.endswith(parts[-1])
    at = 0
    for p in parts:
        i = text.find(p, max(0, at - concepts.WINDOW_OVERLAP - 1))
        assert 0 <= i <= at  # each window starts at or before where the one before it ended
        at = i + len(p)
    assert at == len(text)
    assert u.windows(len(text)) == [text]


def test_merge_windows_takes_the_value_that_says_the_most():
    labels = ["stopped", "no"]
    a = lambda v, c: {"label": v, "confidence": c, "rationale": v, "spans": None}  # noqa: E731
    assert concepts.merge_windows(labels, [a("no", 0.9), a("stopped", 0.6), a("no", 0.7)])["label"] == "stopped"
    assert concepts.merge_windows(labels, [a("no", 0.9), a("no", 0.7)]) == a("no", 0.7) | {"rationale": "no"}
    # a window with no answer could have held the match: the unit fails unless another window matched
    assert concepts.merge_windows(labels, [a("no", 0.9), None]) is None
    assert concepts.merge_windows(labels, [None, a("stopped", 0.6)])["label"] == "stopped"
    # an off-list value says more than a quiet one and less than the label's own values
    assert concepts.merge_windows(labels, [a("unclear", 0.5), a("no", 0.9)])["label"] == "unclear"
    assert concepts.merge_windows(["pass", "fail"], [a("fail", 0.9), a("pass", 0.5)])["label"] == "pass"


async def test_a_whole_file_past_the_unit_cap_is_counted_in_the_message(api, classifier):
    k = await _apply(api, "agent", marks="file")
    s = k["summary"]
    assert s["labeled"] == 2
    assert "1 file ran past 30,000 characters" in (s["message"] or "")
    assert all(len(t) <= concepts.UNIT_TEXT_MAX + 20 for _ref, t in classifier.items)
