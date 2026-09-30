"""app.concepts, the labels: a regex apply writes one row per unit, and a classifier apply batches its units through a
scripted model.

The prompt kind's classifier is scripted at concepts.classify_structured (CallResults; no subprocess, no network). The
regex kind runs for real over the synthetic corpus `mini`."""
from __future__ import annotations

import json
import re

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, refs
from app import model as model_mod

CORPUS = "mini"
MINI = config.corpus_dir(CORPUS)
PATTERN = r"(?i)forge pr claim"  # 3 of the 8 board posts match


# ----------------------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def _clean_state(workspaces_tmp):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks, concepts._building,
                  concepts._building_answers):
        table.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks, concepts._building, concepts._building_answers):
        table.clear()


@pytest.fixture()
def app() -> FastAPI:
    a = FastAPI()
    a.include_router(concepts.router, prefix="/api")
    return a


@pytest.fixture()
async def api(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as c:
        yield c


def _board_expected(pattern: str = PATTERN) -> dict[str, str]:
    rx = re.compile(pattern)
    exp = {}
    for i, line in enumerate((MINI / "board.jsonl").read_text("utf-8").splitlines(), 1):
        text = "\n\n".join(b["text"] for b in refs.record_blocks(json.loads(line), "board"))
        exp[f"board.jsonl#L{i}"] = "yes" if rx.search(text) else "no"
    return exp


async def _create(api, **kw) -> dict:
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "claims a PR", **kw})
    assert r.status_code == 200, r.text
    return r.json()


def _ok(labels: list[dict]) -> "model_mod.CallResult":
    return model_mod.CallResult(status="ok", output={"labels": labels})


class FakeClassify:
    """Scripted concepts.classify_structured. `plan` entries are used in order (a CallResult, or a callable given the
    batch's items); when the plan is empty, items are labelled YES when their text mentions 'claim'."""

    calls: list[dict] = []
    plan: list = []

    @staticmethod
    async def call(c, concept, items, comment=True):
        FakeClassify.calls.append({"workspace": c, "concept": dict(concept), "items": list(items), "comment": comment})
        if FakeClassify.plan:
            nxt = FakeClassify.plan.pop(0)
            return nxt(items) if callable(nxt) else nxt
        return _ok(FakeClassify.rule(items))

    @staticmethod
    def rule(items: list[tuple[str, str]]) -> list[dict]:
        return [{"i": n, "label": "YES" if "claim" in t.lower() else "no",
                 "confidence": 0.9 if "claim" in t.lower() else 0.7, "rationale": "because"}
                for n, (_ref, t) in enumerate(items, 1)]


@pytest.fixture()
def fake_classify(monkeypatch):
    """The scripted classifier (batches of BATCH_ITEMS, CONCURRENCY in flight)."""
    FakeClassify.calls = []
    FakeClassify.plan = []
    monkeypatch.setattr(concepts, "classify_structured", FakeClassify.call)
    return FakeClassify


async def test_regex_apply_records_for_real(api, workspaces_tmp):
    k = await _create(api, kind="regex", spec=PATTERN)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 200, r.text
    s = r.json()
    expected = _board_expected()
    assert set(expected.values()) == {"yes", "no"}
    assert s["status"] == "done" and s["total"] == 8 and s["labeled"] == 8 and s["failed"] == 0
    assert s["counts"] == {"yes": sum(v == "yes" for v in expected.values()), "no": sum(v == "no" for v in expected.values())}
    assert s["n_labeled"] == 8 and s["kind"] == "regex" and s["paths"] == ["board.jsonl"]

    # the labels file holds a row for each match alone, and a cover for the file's records (labels_store, covers)
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert {r["ref"]: r["label"] for r in rows} == {ref: v for ref, v in expected.items() if v == "yes"}
    assert all(r["source"] == "regex" and r["confidence"] == 1.0 and r["ts"] and r["rationale"] for r in rows)  # the matched text
    for r in rows:
        assert refs.resolve(MINI, r["ref"])["kind"] == "record"

    r = await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}/labels", params={"path": "board.jsonl"})
    body = r.json()
    assert body["concept"]["id"] == k["id"] and {row["ref"]: row["label"] for row in body["rows"]} == expected
    assert all(row["analyst"] is None and row["source"] == "regex" and row["confidence"] == 1.0 for row in body["rows"])
    assert all(not row["rationale"] for row in body["rows"] if row["label"] == "no")
    assert (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}/labels", params={"path": "events.jsonl"})).json()["rows"] == []

    k2 = (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()
    assert k2["n_labeled"] == 8 and k2["counts"] == s["counts"] and k2["run"]["status"] == "done" and k2["run"]["done"] == 8
    assert k2["applications"][-1]["labeled"] == 8 and k2["applications"][-1]["status"] == "done"

    # a second run appends; the latest row per ref wins (still 8 labeled); a trial's sampled records have a row each
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"], "limit": 2})
    assert r.json()["total"] == 2 and r.json()["labeled"] == 2 and r.json()["n_labeled"] == 8 and r.json()["counts"] == s["counts"]
    assert len(concepts.read_labels(workspaces_tmp / CORPUS, k["id"])) == 3 + 2


async def test_prompt_apply_batches_rows(api, workspaces_tmp, fake_classify, monkeypatch):
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 3)
    k = await _create(api, description="a board post that claims a PR")
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"], "created_by": "chat:ab12"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["total"] == 8 and s["labeled"] == 8 and s["failed"] == 0 and s["message"] is None
    assert len(fake_classify.calls) == 3  # 3 + 3 + 2 items
    call = fake_classify.calls[0]
    assert call["workspace"] == CORPUS and call["concept"]["description"] == "a board post that claims a PR"
    assert [ref for ref, _t in call["items"]] == [f"board.jsonl#L{i}" for i in (1, 2, 3)]
    assert "review someone else's pending request in return" in call["items"][0][1]  # the block text, not raw JSON
    assert '"thread_title"' not in call["items"][0][1]
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert len(rows) == 8 and all(r["source"] == "model" and 0 <= r["confidence"] <= 1 and r["rationale"] == "because" for r in rows)
    expected = _board_expected(r"(?i)claim")
    assert {r["ref"]: r["label"] for r in rows} == expected  # 'YES' is coerced to the concept's 'yes'
    assert s["counts"] == {"yes": sum(v == "yes" for v in expected.values()), "no": sum(v == "no" for v in expected.values())}
    assert (await api.get(f"/api/ws/{CORPUS}/concepts/{k['id']}")).json()["applications"][-1]["created_by"] == "chat:ab12"


async def test_the_server_s_shutdown_ends_the_label_scan_pool_s_workers():
    """A worker still busy with a chunk when the server stops is ended, not left running after the server exits."""
    import os
    import time

    from app import concepts

    life = concepts._lifespan(None)
    await life.__aenter__()
    pool = concepts._pool_get()
    pool.submit(time.sleep, 60)
    for _ in range(200):
        if pool._processes:
            break
        time.sleep(0.05)
    pids = list(pool._processes)
    assert pids
    started = time.monotonic()
    await life.__aexit__(None, None, None)
    assert concepts._pool is None and time.monotonic() - started < 30
    for pid in pids:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        raise AssertionError(f"the pool's worker {pid} still runs")
