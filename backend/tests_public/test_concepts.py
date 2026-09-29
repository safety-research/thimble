"""app.concepts, the labels: a regex apply writes one row per unit, and a classifier apply batches its units through a
scripted model.

The prompt kind's classifier is scripted at concepts.classify_structured (CallResults; no subprocess, no network). The
regex kind runs for real over the synthetic corpus `mini`."""
from __future__ import annotations

import asyncio
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
    async def call(c, concept, items, comment=True, on_retry=None):
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


async def test_a_prompt_apply_slows_down_when_the_api_pushes_back_and_asks_again_what_failed(api, monkeypatch):
    """A 429 or 529 on one call halves the calls in flight; a failed call's items and an item a call left out are asked
    once more, so every unit gets a row."""
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)
    monkeypatch.setattr(concepts, "CONCURRENCY", 4)
    running, seen, asked = 0, [], []

    async def call(c, concept, items, comment=True, on_retry=None):
        nonlocal running
        running += 1
        seen.append(running)
        asked.append(items[0][0])
        n = len(asked)
        if n == 1:
            on_retry(1, 0.0, "overloaded", None)
        await asyncio.sleep(0.05)
        running -= 1
        if n == 2:
            return model_mod.CallResult(status="no_tool_call", detail="the model answered in prose")
        return _ok([] if n == 3 else FakeClassify.rule(items))

    monkeypatch.setattr(concepts, "classify_structured", call)
    k = await _create(api, description="a board post that claims a PR")
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    s = r.json()
    assert s["total"] == 8 and s["labeled"] == 8 and s["failed"] == 0
    assert len(asked) == 10 and asked[1] in asked[4:] and asked[2] in asked[4:]
    assert max(seen[:4]) == 4 and max(seen[4:]) < 4


async def test_a_prompt_apply_asks_a_rate_limited_or_refused_call_no_second_time(api, monkeypatch):
    """A call still rate-limited after its retries, or refused, is not asked again: its units fail after one round."""
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)
    monkeypatch.setattr(concepts, "RETRY_DELAYS", (0.0, 0.0))
    asked: dict[str, int] = {}
    status: dict[str, str] = {}

    async def call(c, concept, items, comment=True, on_retry=None):
        ref = items[0][0]
        asked[ref] = asked.get(ref, 0) + 1
        status.setdefault(ref, ("rate_limited", "refused")[len(status) % 2])
        return model_mod.CallResult(status=status[ref], detail="no")

    monkeypatch.setattr(concepts, "classify_structured", call)
    k = await _create(api, description="a board post that claims a PR")
    s = (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})).json()
    assert s["failed"] == 8 and s["labeled"] == 0
    assert {asked[r] for r, st in status.items() if st == "rate_limited"} == {3}
    assert {asked[r] for r, st in status.items() if st == "refused"} == {1}


async def test_a_prompt_label_answers_once_its_first_rows_are_in(workspaces_tmp, monkeypatch):
    """apply_scoped answers a prompt label with the run so far once APPLY_ENOUGH units are labeled, and the run goes on."""
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)
    monkeypatch.setattr(concepts, "CONCURRENCY", 2)
    monkeypatch.setattr(concepts, "APPLY_ENOUGH", 2)

    async def call(c, concept, items, comment=True, on_retry=None):
        await asyncio.sleep(0.2)
        return _ok(FakeClassify.rule(items))

    monkeypatch.setattr(concepts, "classify_structured", call)
    s = await concepts.apply_scoped(CORPUS, scope="files", name="claims a PR", kind="prompt", text="The post claims a PR.",
                                    values=None, paths=["board.jsonl"], limit=None, comment=False, filter=False,
                                    created_by="test", chat=None, group=None, card=False)
    assert s["partial"] and 2 <= sum(s["counts"].values()) < 8
    done = await concepts.wait_apply(CORPUS, s["concept"], 60)
    assert done["labeled"] == 8


async def test_a_slow_classifier_call_starts_no_call_past_the_limit(api, monkeypatch):
    """While one call runs long, the others go on beside it and never more than CONCURRENCY run at once; each unit is
    asked once."""
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)
    monkeypatch.setattr(concepts, "CONCURRENCY", 3)
    running, seen, asked = 0, [], []

    async def call(c, concept, items, comment=True, on_retry=None):
        nonlocal running
        running += 1
        seen.append(running)
        asked.append(items[0][0])
        await asyncio.sleep(0.5 if len(asked) == 1 else 0.01)
        running -= 1
        return _ok(FakeClassify.rule(items))

    monkeypatch.setattr(concepts, "classify_structured", call)
    k = await _create(api, description="a board post that claims a PR")
    s = (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})).json()
    assert s["labeled"] == 8 and sorted(asked) == sorted(set(asked)) and max(seen) == 3


async def test_a_prompt_label_within_another_reads_only_the_records_it_kept(workspaces_tmp, fake_classify):
    """A regex label narrows the board to the posts that claim a PR, quoting the line each matched, and a prompt label
    run `within` it sends the model those posts alone; its rows and counts cover them, its concept keeps the narrowing
    for a run from the browser, and `show` turns it on in Files and the views."""
    kw = dict(scope="files", values=None, paths=["board.jsonl"], limit=None, comment=False, filter=False,
              created_by="test", chat=None, group=None, card=False)
    await concepts.apply_scoped(CORPUS, name="claims a PR", kind="regex", text=PATTERN, **kw)
    await concepts.wait_apply(CORPUS, concepts.find_concept(workspaces_tmp / CORPUS, "claims a PR")["id"], 60)
    kept = {ref for ref, v in _board_expected().items() if v == "yes"}
    quoted = concepts.examples(CORPUS, concepts.find_concept(workspaces_tmp / CORPUS, "claims a PR")["id"], "yes")
    assert {ref for ref, _t in quoted} == kept and all(re.search(PATTERN, t) for _r, t in quoted)  # each its matched line
    s = await concepts.apply_scoped(CORPUS, name="asks for review", kind="prompt", text="The post asks for a review.",
                                    within={"label": "claims a PR"}, show=True, **kw)
    s = await concepts.wait_apply(CORPUS, s["concept"], 60) if s["partial"] else s
    sent = {ref for call in fake_classify.calls for ref, _t in call["items"]}
    assert sent == kept and s["total"] == len(kept)
    rows = concepts.read_labels(workspaces_tmp / CORPUS, s["concept"])
    assert {r["ref"] for r in rows} == kept
    k = concepts.find_concept(workspaces_tmp / CORPUS, "asks for review")
    assert k["within"] == {"label": concepts.find_concept(workspaces_tmp / CORPUS, "claims a PR")["id"], "value": "yes"}
    assert k["shown"] and not concepts.find_concept(workspaces_tmp / CORPUS, "claims a PR")["shown"]

    # a wider narrowing under the same name runs the prompt label again over what it keeps now
    await concepts.apply_scoped(CORPUS, name="claims a PR", kind="regex", text=r"(?i)claim", **kw)
    await concepts.wait_apply(CORPUS, k["within"]["label"], 60)
    fake_classify.calls.clear()
    s = await concepts.apply_scoped(CORPUS, name="asks for review", kind="prompt", text="The post asks for a review.",
                                    within={"label": "claims a PR"}, show=True, **kw)
    s = await concepts.wait_apply(CORPUS, s["concept"], 60) if s["partial"] else s
    wider = {ref for ref, v in _board_expected(r"(?i)claim").items() if v == "yes"}
    assert not s.get("unchanged") and {ref for call in fake_classify.calls for ref, _t in call["items"]} == wider > kept


def test_a_prompt_label_reads_a_save_of_a_whole_page_as_what_it_changed(tmp_path):
    """A record that saves a page again reads as the lines it added and removed from the page's save before it (under a
    line naming the page for a model, without it for a regex), the same
    whether the run reads every record in order or only the records a trial or `within` picked; a page's first save and a
    save that rewrites most of the page read whole. An event log's records, numbered but naming no document, are not
    saves."""
    saves = [{"page_id": "a", "seq": 1, "user": "ann", "body": "Intro\nline one"},
             {"page_id": "b", "seq": 1, "user": "bo", "body": "Other page"},
             {"page_id": "a", "seq": 2, "user": "bo", "body": "Intro\nline one\nline two -- bo"},
             {"page_id": "a", "seq": 3, "user": "cy", "body": "All new\ntext here\nand more"}]
    (tmp_path / "revisions.jsonl").write_text("".join(json.dumps(r) + "\n" for r in saves))
    units = list(concepts.iter_units(tmp_path, [{"path": "revisions.jsonl", "kind": "text"}], "record"))
    every = {u.ref: u.text(10_000) for u in concepts.as_changes(iter(units))}
    picked = {u.ref: u.text(10_000) for u in concepts.picked_as_changes(tmp_path, units[2:])}
    assert every["revisions.jsonl#L3"] == picked["revisions.jsonl#L3"] == "What this save changed on a:\n+ line two -- bo"
    assert [u.text(10_000) for u in concepts.as_changes(iter(units), header=False)][2] == "+ line two -- bo"  # a regex's
    assert every["revisions.jsonl#L1"] == "Intro\nline one"
    assert every["revisions.jsonl#L4"] == picked["revisions.jsonl#L4"] == "All new\ntext here\nand more"
    assert concepts._save_key({"seq": 2, "service": "web-1", "text": "disk full"}) is None
    assert concepts._save_key({"version": "2.1.0", "type": "system", "content": "compacted"}) is None
