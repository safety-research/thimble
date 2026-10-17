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

from app import concepts, config, model_call, refs
from app import call_result as model_mod

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
    """The scripted classifier (batches of BATCH_ITEMS, model_call.parallel() in flight)."""
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


def test_a_trial_counts_as_a_label_wherever_labels_are_listed_or_counted(workspaces_tmp):
    """Bug hunt 2, C3: a trial (a label run on a sample) was in the terminal's Labels list and home's count but not in
    the thimble line's count, which read the workspace's holdings. One rule: every list and count holds it, and it
    keeps its `trial` mark, by which the browser and the terminal say it ran on a sample."""
    from app import tools

    concepts.define_concept(CORPUS, "claims a PR", kind="regex", spec=PATTERN, created_by="test")
    concepts.define_concept(CORPUS, "asks for review", "The post asks for a review.", created_by="test", trial=True)
    listed = {k["name"]: k["trial"] for k in concepts.list_concepts_route(CORPUS)}
    assert listed == {"claims a PR": False, "asks for review": True}
    assert tools.holdings(CORPUS)["labels"] == 2
    assert {x["name"] for x in concepts.unsure_state(CORPUS, counts_only=True)["labels"]} == set(listed)


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


async def test_h3_a_run_the_quit_stopped_part_way_is_kept_as_stopped_told_and_read_as_such(api, workspaces_tmp, monkeypatch):
    """Bug hunt H3: main's quit stopped a prompt label at 8,447 of 14,591 records, and the browser and main's read_ref
    gave the partial counts as final, with no notice. The run is kept on the label as stopped by the quit with how far
    it got, a notice says so, and read_ref of the label and of a value say it."""
    from app import notices

    monkeypatch.setattr(concepts, "BATCH_ITEMS", 3)
    asked: list[int] = []

    async def classify(c, concept, items, comment=True, on_retry=None):
        asked.append(len(items))
        if len(asked) > 1:  # the first batch is answered; the others wait until the quit
            await asyncio.Event().wait()
        return _ok(FakeClassify.rule(items))

    monkeypatch.setattr(concepts, "classify_structured", classify)
    k = await _create(api, description="a board post that claims a PR")
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"paths": ["board.jsonl"]})
    assert r.status_code == 202, r.text
    for _ in range(200):
        if (concepts._runs.get((CORPUS, k["id"])) or {}).get("labeled") == 3:
            break
        await asyncio.sleep(0.02)
    assert concepts.stop_workspace(CORPUS) == 1  # main's session ended (agents.stop_all)
    await asyncio.sleep(0.2)
    last = concepts.read_concept(workspaces_tmp / CORPUS, k["id"])["applications"][-1]
    assert last["stopped"] is True and last["stopped_by"] == "quit" and last["status"] == "done"
    assert (last["labeled"], last["total"]) == (3, 8)
    told = [n for n in notices.open_notices(CORPUS) if n["key"] == f"label:{k['id']}"]
    assert len(told) == 1 and "stopped the label claims a PR at 3 of 8 records" in told[0]["text"]
    assert told[0]["action"] == {"label": "See the label", "do": "label-open", "slug": k["id"]}
    read = refs.resolve(MINI, f"concept:{k['id']}")["excerpt"]
    assert "its last run stopped when Claude Code quit at 3 of 8 records" in read, read
    assert "stopped when Claude Code quit at 3 of 8 records" in refs.resolve(MINI, f"concept:{k['id']}/yes")["excerpt"]
    # the label's next run that ends takes the notice away and reads as whole again
    monkeypatch.setattr(concepts, "classify_structured", FakeClassify.call)
    FakeClassify.plan = []
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["board.jsonl"]})
    assert r.status_code == 200 and r.json()["stopped"] is False
    assert not [n for n in notices.open_notices(CORPUS) if n["key"] == f"label:{k['id']}"]
    assert "stopped" not in refs.resolve(MINI, f"concept:{k['id']}")["excerpt"]


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
    monkeypatch.setattr(model_call, "parallel", lambda: 4)
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


def test_the_scan_pool_ends_once_idle_but_never_while_a_run_holds_it(monkeypatch):
    """The scan pool's workers end SCAN_IDLE_S after the last run let the pool go, and never while a run holds it; the
    next run starts a new pool. A server kept eight idle workers of about 120 MB each after its first label (bug hunt
    round 2, ml-tasks)."""
    import time

    monkeypatch.setattr(concepts, "SCAN_IDLE_S", 0.3)
    monkeypatch.setattr(concepts, "apply_workers", lambda: 1)
    concepts._pool_shutdown(end=True)
    try:
        with concepts._pool_held():
            pool = concepts._pool_get()
            assert pool.submit(abs, -3).result(timeout=60) == 3
            workers = list(pool._processes.values())
            time.sleep(1.0)  # past SCAN_IDLE_S, with the pool held
            assert concepts._pool is pool, "the scan pool ended while a run held it"
        deadline = time.monotonic() + 10
        while concepts._pool is not None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert concepts._pool is None, "the scan pool was kept after it was idle for SCAN_IDLE_S"
        # the pool's own manager thread joins its workers as it ends; a join here would race it for the exit status
        # (os.waitpid answers ECHILD to the loser, whose Process then reads as alive until the winner records it)
        deadline = time.monotonic() + 20
        while any(w.exitcode is None for w in workers) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert all(w.exitcode is not None for w in workers), "a worker of the idle scan pool still runs"
        again = concepts._pool_get()
        assert again is not pool and again.submit(abs, -4).result(timeout=60) == 4
    finally:
        concepts._pool_shutdown(end=True)
