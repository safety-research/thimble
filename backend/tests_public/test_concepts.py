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

from app import concepts, config, labels_store, refs
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


async def test_a_labels_coverage_counts_every_file_and_lists_a_page_of_each_group(api, workspaces_tmp, monkeypatch):
    """GET /coverage counts the corpus's files, those the label covers and their rows, and lists only a page of the
    covered files and of the others, by path, the others paged by offset; it reads the folder tree, never stats each
    file, and a million-file corpus no longer sends every path."""
    from app import corpus

    k = await _create(api, kind="regex", spec=PATTERN)
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 200, r.text
    every = corpus.search_paths(MINI).paths
    assert len(every) > 6 and "board.jsonl" in every
    others = sorted(p for p in every if p != "board.jsonl")
    walks = []
    real = corpus.list_sources
    monkeypatch.setattr(corpus, "list_sources", lambda *a, **kw: walks.append(a) or real(*a, **kw))
    base = f"/api/ws/{CORPUS}/concepts/{k['id']}/coverage"
    got = (await api.get(base)).json()
    assert got["unit"] == "record" and got["n_files"] == len(every) and got["n_covered"] == 1 and got["rows"] == 8
    assert got["files"] == [{"path": "board.jsonl", "covered": True, "rows": 8}]
    assert got["not_covered"] == others and got["n_not_covered"] == len(others) and got["offset"] == 0
    page = (await api.get(base, params={"limit": 2, "offset": 3})).json()
    assert page["not_covered"] == others[3:5] and page["n_not_covered"] == len(others) and page["n_files"] == len(every)
    assert page["files"] == got["files"] and page["offset"] == 3
    assert (await api.get(base, params={"limit": 2, "offset": len(others)})).json()["not_covered"] == []
    assert (await api.get(base, params={"limit": 10**6})).json()["not_covered"] == others  # held to COVERAGE_PAGE_MAX
    monkeypatch.setattr(concepts, "COVERAGE_PAGE_MAX", 3)
    assert len((await api.get(base, params={"limit": 50})).json()["not_covered"]) == 3
    assert not walks


async def test_one_labels_request_reads_the_rows_of_several_line_ranges(api, workspaces_tmp, monkeypatch):
    k = await _create(api, kind="regex", spec=PATTERN)
    lf = concepts.labels_file(workspaces_tmp / CORPUS, k["id"])
    lf.parent.mkdir(parents=True, exist_ok=True)
    rows = [{"ref": f"big.jsonl#L{n}", "label": "yes", "source": "regex", "ts": "t"} for n in (3, 600, 1200, 5000, 9000)]
    rows += [{"ref": "big.jsonl", "label": "yes", "source": "regex", "ts": "t"},
             {"ref": "other.jsonl#L3", "label": "yes", "source": "regex", "ts": "t"},
             {"ref": "rows.csv#row=2", "line": 4, "label": "yes", "source": "regex", "ts": "t"},
             labels_store.cover_row("big.jsonl", 1000, 1010, "no", "regex", "t")]
    lf.write_text("".join(json.dumps(r) + "\n" for r in rows))

    async def page(lines: str) -> list[dict]:
        r = await api.get(f"/api/ws/{CORPUS}/labels", params={"path": "big.jsonl", "lines": lines})
        assert r.status_code == 200, r.text
        return next((e["rows"] for e in r.json() if e["concept_id"] == k["id"]), [])

    got = await page("1-500,1001-1500,4501-5000")
    refs_got = [row["ref"] for row in got]
    implicit = [f"big.jsonl#L{n}" for n in range(1001, 1011)]
    assert sorted(refs_got) == sorted(["big.jsonl#L3", "big.jsonl#L1200", "big.jsonl#L5000", "big.jsonl", *implicit])
    assert len(refs_got) == len(set(refs_got)), "the whole-file row comes once, not once per range"
    singles = [row["ref"] for lines in ("1-500", "1001-1500", "4501-5000") for row in await page(lines)]
    assert set(singles) == set(refs_got)
    assert {row["ref"]: row["label"] for row in got if row["ref"] in implicit} == dict.fromkeys(implicit, "no")
    # ranges that overlap or touch read as one; the answer while the store is rebuilt is the same rows
    assert sorted(row["ref"] for row in await page("1-700,500-1005")) == sorted(["big.jsonl#L3", "big.jsonl#L600", "big.jsonl",
                                                                               *(f"big.jsonl#L{n}" for n in range(1000, 1006))])
    scanned = labels_store.scan_jsonl(lf, "big.jsonl", [(1, 500), (1001, 1500), (4501, 5000)])
    assert sorted(r["ref"] for r in scanned) == sorted(refs_got)

    # a view asks for its records by ref: a line with no row of its own reads as the row of a record starting there,
    # else as its cover
    r = await api.post(f"/api/ws/{CORPUS}/labels/refs", json={"refs": ["big.jsonl#L600", "big.jsonl#L1005", "big.jsonl#L7",
                                                                       "rows.csv#L4", "rows.csv#L5"]})
    assert r.status_code == 200, r.text
    by_ref = {row["ref"]: row["label"] for e in r.json() if e["concept_id"] == k["id"] for row in e["rows"]}
    assert by_ref == {"big.jsonl#L600": "yes", "big.jsonl#L1005": "no", "rows.csv#row=2": "yes"}
    # while the store is rebuilt, the records a view asks for by ref read the same rows from the labels file
    monkeypatch.setattr(concepts, "_store", lambda ws, concept_id: (None, True))
    r = await api.post(f"/api/ws/{CORPUS}/labels/refs", json={"refs": ["big.jsonl#L600", "big.jsonl#L1005", "big.jsonl#L7",
                                                                       "rows.csv#L4", "rows.csv#L5"]})
    assert r.status_code == 200, r.text
    assert {row["ref"]: row["label"] for e in r.json() if e["concept_id"] == k["id"] for row in e["rows"]} == by_ref
    monkeypatch.undo()

    for bad in ("1-500,x", "1-500,600-500", ",".join(f"{i * 10 + 1}-{i * 10 + 5}" for i in range(concepts.LINE_SPANS_MAX + 1))):
        r = await api.get(f"/api/ws/{CORPUS}/labels", params={"path": "big.jsonl", "lines": bad})
        assert r.status_code == 400, bad


CURT = {"id": "curt", "name": "Curt reply", "unit": "record", "kind": "prompt", "spec": "The reply is short and unfriendly.",
        "description": "", "labels": ["curt", "not curt"]}
CURT_ITEMS = [("runs/a.jsonl#L1", "Do it now."), ("runs/a.jsonl#L2", "Thanks so much!")]


async def test_a_prompt_label_s_system_prompt_is_a_plain_classifier_prompt(monkeypatch):
    """A prompt label's call gets labels.md's head as its whole system prompt: a text classifier's prompt that names the
    category, its definition and its values and says nothing of thimble or the analyst, asks for a rationale only with
    `comment` and leaves no blank lines where a slot was empty; the items keep their numbered headings."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    system, user = concepts.build_classify_prompt(concepts.label_input(CURT, CURT_ITEMS))
    assert system.startswith("You are a text classifier.") and system.endswith("Return exactly one entry for each record.")
    assert "Category: Curt reply\n\nDefinition:\nThe reply is short and unfriendly.\n\nAllowed values: curt, not curt" in system
    assert "also give `rationale`" in system and "\n\n\n" not in system
    assert "thimble" not in system.lower() and "analyst" not in system.lower()
    assert user == "### item 1 [runs/a.jsonl#L1]\nDo it now.\n\n### item 2 [runs/a.jsonl#L2]\nThanks so much!"
    bare, _ = concepts.build_classify_prompt(concepts.label_input(CURT, CURT_ITEMS, comment=False))
    assert "rationale" not in bare and "\n\n\n" not in bare
    shown = concepts.label_input({**CURT, "examples": [{"ref": "runs/b.jsonl#L4", "text": "No.", "value": "curt",
                                                        "note": "too short"}]}, CURT_ITEMS)
    with_examples, _ = concepts.build_classify_prompt(shown)
    assert "### example 1 [runs/b.jsonl#L4]\nNo." in with_examples and "\n\n\n" not in with_examples
    assert "too short" in with_examples and "analyst" not in with_examples.lower()
    assert with_examples.index("### example 1") < with_examples.index("Return exactly one entry for each record.")

    seen: dict = {}

    async def structured(prompt, **kw):
        seen.update(kw, prompt=prompt)
        return model_mod.CallResult(status="ok", output={"labels": []})

    monkeypatch.setattr(model_mod, "structured", structured)
    inp = concepts.label_input(CURT, CURT_ITEMS)
    await concepts.labels_task(CORPUS, inp)
    assert (seen["system"], seen["prompt"]) == concepts.build_classify_prompt(inp) and seen["tool"].name == "labels"


def test_a_classifier_call_carries_fifty_records_and_fewer_long_ones():
    """A prompt label asks BATCH_ITEMS (50) units a call, and fewer when their texts pass BATCH_CHARS."""
    def units(n: int, text: str) -> list:
        return [concepts.Unit(f"a.jsonl#L{i}", ["a.jsonl"], lambda: iter([("", text)])) for i in range(1, n + 1)]

    assert concepts.BATCH_ITEMS == 50
    assert [len(b) for b in concepts._batches(iter(units(120, "a short reply")), "record", concepts.BATCH_ITEMS)] == [50, 50, 20]
    long = list(concepts._batches(iter(units(20, "x" * 5_000)), "record", concepts.BATCH_ITEMS))
    assert [len(b) for b in long] == [8, 8, 4] and all(sum(len(it.text) for it in b) <= concepts.BATCH_CHARS for b in long)


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


async def _scoped_prompt_label(monkeypatch, *, in_flight: int, wait_s: float) -> tuple[dict, float]:
    """apply_scoped's answer for a prompt label over the board's 8 posts, one per call and each call 0.3 s, with one
    labeled unit enough; and the seconds from the first call's start to the answer."""
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)
    monkeypatch.setattr(concepts, "CONCURRENCY", in_flight)
    monkeypatch.setattr(concepts, "APPLY_ENOUGH", 1)
    monkeypatch.setattr(concepts, "APPLY_WAIT_S", wait_s)
    loop = asyncio.get_running_loop()
    started: list[float] = []

    async def call(c, concept, items, comment=True, on_retry=None):
        started.append(loop.time())
        await asyncio.sleep(0.3)
        return _ok(FakeClassify.rule(items))

    monkeypatch.setattr(concepts, "classify_structured", call)
    s = await concepts.apply_scoped(CORPUS, scope="files", name="claims a PR", kind="prompt", text="The post claims a PR.",
                                    values=None, paths=["board.jsonl"], limit=None, comment=False, filter=False,
                                    created_by="test", chat=None, group=None, card=False)
    return s, loop.time() - started[0]


async def test_a_prompt_apply_asks_a_batch_cut_off_twice_in_halves_until_only_the_bad_item_fails(api, workspaces_tmp, monkeypatch):
    """A batch whose call is cut off every time one item is in it is asked again in halves, down to single items: the
    other 9 are labeled, and only that item fails, with the reason."""
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 10)
    bad = "events.jsonl#L7"
    sizes: list[int] = []

    async def call(c, concept, items, comment=True, on_retry=None):
        sizes.append(len(items))
        if any(ref == bad for ref, _t in items):
            return model_mod.CallResult(status="truncated", detail="the response hit max_tokens before a valid tool call")
        return _ok(FakeClassify.rule(items))

    monkeypatch.setattr(concepts, "classify_structured", call)
    k = await _create(api, description="a forge event that claims a PR")
    s = (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["events.jsonl"]})).json()
    assert s["total"] == 20 and s["labeled"] == 19 and s["failed"] == 1
    assert s["message"] == "truncated: the response hit max_tokens before a valid tool call"
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert {r["ref"] for r in rows} == {f"events.jsonl#L{i}" for i in range(1, 21)} - {bad}
    # L11-L20 in one call; L1-L10 twice, then 1-5 and 6-10, 6-7 and 8-10, 6 and 7
    assert sorted(sizes) == [1, 1, 2, 3, 5, 5, 10, 10, 10]


async def test_a_prompt_label_that_will_not_end_within_the_wait_answers_with_its_first_rows(workspaces_tmp, monkeypatch):
    """Once APPLY_ENOUGH units are labeled and the run's eta is past the wait left, apply_scoped answers with the run so
    far before the wait ends, and the run goes on."""
    s, took = await _scoped_prompt_label(monkeypatch, in_flight=1, wait_s=2.0)
    assert s["partial"] and 1 <= sum(s["counts"].values()) < 8 and took < 1.0
    done = await concepts.wait_apply(CORPUS, s["concept"], 60)
    assert done["labeled"] == 8


async def test_a_prompt_label_that_will_end_within_the_wait_answers_whole(workspaces_tmp, monkeypatch):
    s, _took = await _scoped_prompt_label(monkeypatch, in_flight=4, wait_s=5.0)
    assert not s["partial"] and sum(s["counts"].values()) == 8


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


async def test_every_prompt_run_learns_from_the_analysts_values_and_agreement_leaves_those_out(api, fake_classify):
    """A prompt label's run always carries the analyst's latest values as examples, with no switch to ask for it, and
    "% agreed" counts only the values the classifier was not given as examples: a value it was shown is no test of it.
    The calibration says how many it left out."""
    k = await _create(api, description="a board post that claims a PR")
    base = f"/api/ws/{CORPUS}/concepts/{k['id']}"
    s = (await api.post(f"{base}/apply", json={"wait": True, "paths": ["board.jsonl"]})).json()
    assert s["status"] == "done" and s["examples"] == 0 and fake_classify.calls[-1]["concept"]["examples"] == []
    model = {r["ref"]: r["label"] for r in (await api.get(f"{base}/labels", params={"path": "board.jsonl"})).json()["rows"]}
    flip = {"yes": "no", "no": "yes"}
    ordered = sorted(model)
    judged = {ordered[0]: flip[model[ordered[0]]], ordered[1]: flip[model[ordered[1]]], ordered[2]: model[ordered[2]]}
    for ref, value in judged.items():
        cal = (await api.post(f"{base}/labels", json={"ref": ref, "label": value})).json()["calibration"]
    assert (cal["n"], cal["agreed"], cal["taught"]) == (3, 1, 0), cal

    # the next run carries those values as examples, though nothing asked for them, and they leave the agreement
    s = (await api.post(f"{base}/apply", json={"wait": True, "paths": ["board.jsonl"]})).json()
    shown = {ex["ref"]: ex["value"] for ex in fake_classify.calls[-1]["concept"]["examples"]}
    assert shown == judged and s["examples"] == 3
    assert (s["calibration"]["n"], s["calibration"]["taught"]) == (0, 3) and s["calibration"]["est_precision"]["no"] is None
    card = (await api.get(base)).json()
    assert card["est_precision"] is None and card["calibration"]["taught"] == 3 and "taught" not in card

    # a value set after that run was no example of it, so it counts
    cal = (await api.post(f"{base}/labels", json={"ref": ordered[3], "label": model[ordered[3]]})).json()["calibration"]
    assert (cal["n"], cal["agreed"], cal["taught"]) == (1, 1, 3), cal
    assert (await api.get(base)).json()["est_precision"] == 1.0
    excerpt = refs.resolve(MINI, f"concept:{k['id']}")["excerpt"]  # what an agent reads of the label
    assert "not counting the 3 it was given as examples" in excerpt, excerpt


def test_a_value_counts_again_once_a_run_writes_its_row_without_it_as_an_example():
    """held_out and taught_after: a ref is left out while its classifier row is the one a run wrote with it among the
    examples; a later run that writes the row again without it makes it count."""
    rows = [("a.jsonl#L1", "yes", "yes", "t2"), ("a.jsonl#L2", "no", "yes", "t2"), ("a.jsonl#L3", "yes", "yes", None)]
    assert concepts.held_out(rows, {"a.jsonl#L1": "t2", "a.jsonl#L2": "t1"}) == ([("no", "yes"), ("yes", "yes")], 1)

    class Store:
        def __init__(self, ts):
            self.ts = ts

        def model_ts(self, refs_):
            return {r: self.ts[r] for r in refs_ if r in self.ts}

    before = {"a.jsonl#L1": "2026-10-06T04:00:00+00:00", "a.jsonl#L2": "2026-10-06T04:00:00+00:00"}
    st = Store({"a.jsonl#L1": "2026-10-06T04:00:00+00:00", "a.jsonl#L2": "2026-10-06T05:00:01+00:00",
                "a.jsonl#L3": "2026-10-06T05:00:02+00:00", "a.jsonl#L4": "2026-10-06T03:00:00+00:00"})
    after = concepts.taught_after(st, ["a.jsonl#L3", "a.jsonl#L4"], "2026-10-06T05:00:00+00:00", before)
    # L1 was not written again; L2 was, without it as an example; L3 was an example the run labeled; L4 one it did not
    assert after == {"a.jsonl#L1": "2026-10-06T04:00:00+00:00", "a.jsonl#L3": "2026-10-06T05:00:02+00:00"}


async def test_a_run_that_fails_after_labeling_its_examples_still_leaves_them_out(api, fake_classify, monkeypatch):
    """A prompt run stores its examples when it starts (`teaching`), so the agreement leaves out the values whose rows it
    wrote also when it fails before its end; the next run that ends folds them in."""
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 3)
    monkeypatch.setattr(concepts, "CONCURRENCY", 1)
    k = await _create(api, description="a board post that claims a PR")
    base = f"/api/ws/{CORPUS}/concepts/{k['id']}"
    await api.post(f"{base}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    model = {r["ref"]: r["label"] for r in (await api.get(f"{base}/labels", params={"path": "board.jsonl"})).json()["rows"]}
    first = [f"board.jsonl#L{i}" for i in (1, 2, 3)]  # the first call's records
    for ref in first:
        await api.post(f"{base}/labels", json={"ref": ref, "label": model[ref]})

    def broken(_items):
        raise RuntimeError("the classifier broke")

    fake_classify.plan = [lambda items: _ok(FakeClassify.rule(items)), broken]
    r = await api.post(f"{base}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code >= 400 or r.json().get("status") == "error", r.text
    assert sorted(ex["ref"] for ex in fake_classify.calls[-2]["concept"]["examples"]) == first
    # a value on a record the failed run never reached counts; the three it labeled with them as examples do not
    cal = (await api.post(f"{base}/labels", json={"ref": "board.jsonl#L6", "label": model["board.jsonl#L6"]})).json()["calibration"]
    assert (cal["n"], cal["taught"]) == (1, 3), cal

    s = (await api.post(f"{base}/apply", json={"wait": True, "paths": ["board.jsonl"]})).json()
    assert s["status"] == "done" and s["examples"] == 4 and (s["calibration"]["n"], s["calibration"]["taught"]) == (0, 4)


def test_a_scan_worker_ends_once_the_process_that_made_its_pool_is_killed(tmp_path):
    """The terminal mode's shim makes the scan pool and is ended by a signal as Claude Code quits, before it can end its
    workers; each worker then ends by itself (concepts._watch_parent; live check T9 found one left)."""
    import os
    import signal
    import subprocess
    import sys
    import time
    from pathlib import Path

    backend = Path(__file__).resolve().parents[1]
    script = tmp_path / "pool.py"
    script.write_text(
        "import sys, time\n"
        f"sys.path.insert(0, {str(backend)!r})\n"
        "from app import concepts\n"
        "if __name__ == '__main__':\n"
        "    pool = concepts._pool_get()\n"
        "    pool.submit(time.sleep, 0.1).result(timeout=60)\n"
        "    print(' '.join(str(p) for p in pool._processes), flush=True)\n"
        "    time.sleep(300)\n")
    proc = subprocess.Popen([sys.executable, str(script)], stdout=subprocess.PIPE, text=True)
    pids = [int(p) for p in proc.stdout.readline().split()]
    assert pids
    os.kill(proc.pid, signal.SIGKILL)
    proc.wait(timeout=30)
    deadline = time.monotonic() + 20
    left = pids
    while left and time.monotonic() < deadline:
        time.sleep(0.2)
        left = [p for p in left if os.path.exists(f"/proc/{p}") and "Z" not in open(f"/proc/{p}/stat").read().split()[2]]
    assert not left, f"the pool's workers {left} still run after the process that made the pool was killed"


def test_a_json_record_s_example_quotes_the_fields_the_label_read_never_the_first_line_of_its_json():
    """The label tool quoted every example of a code label over pages.jsonl as `{` (live check New 13): the first line
    of the record's pretty-printed JSON. It quotes the fields the rule reads, else its words field, else the record on
    one line of JSON."""
    rec = {"page_id": "dse/AgentJune", "name": "AgentJune2026", "wiki": "dse", "n_revs": 19, "tags": ["a"]}
    code = {"kind": "code", "spec": "def label(unit):\n    return ('yes' if 'June' in unit['name'] else 'no', 1.0)"}
    assert concepts.record_words(rec, code) == "name: AgentJune2026"
    both = {"kind": "code", "spec": "w = unit.get('wiki'); n = unit['n_revs']"}
    assert concepts.record_words(rec, both) == "wiki: dse · n_revs: 19"
    prompt = {"kind": "prompt", "spec": "Is the page's name about June? Read the n revs too."}
    assert concepts.record_words(rec, prompt) == "name: AgentJune2026 · n_revs: 19"
    assert concepts.record_words({"text": "a post\nover two lines", "id": 3}, {"kind": "prompt", "spec": "A post?"}) == "text: a post over two lines"
    assert concepts.record_words({"id": 3, "ok": True}, {"kind": "regex", "spec": "x"}) == '{"id": 3, "ok": true}'
