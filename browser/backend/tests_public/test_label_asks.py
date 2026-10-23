"""The ask before a big prompt label's run (label_asks.py, concepts.ask_first): the page's Run, the sidebar's Run again
and main's apply_label all wait for the person's choice when a prompt label reads more than a sample, as the terminal
does. The classifier is scripted (test_concepts.FakeClassify); the sample is 3 here, so the 8 board posts ask."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app import concepts, label_asks
from tests_public.test_concepts import CORPUS, _create, api, app, fake_classify  # noqa: F401 — fixtures

pytestmark = pytest.mark.usefixtures("workspaces_tmp")


@pytest.fixture(autouse=True)
def _small_sample(monkeypatch):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    label_asks.reset()
    monkeypatch.setattr(label_asks, "SAMPLE", 3)
    yield
    label_asks.reset()


def _items(fake) -> int:
    return sum(len(c["items"]) for c in fake.calls)


async def test_a_big_prompt_label_asks_before_it_reads_and_runs_only_on_the_choice(api, fake_classify):
    k = await _create(api, description="a board post that claims a PR")
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"paths": ["board.jsonl"]})
    assert r.status_code == 202, r.text
    ask = r.json()["asked"]
    assert ask["units"] == 8 and ask["sample"] == 3 and ask["calls"] >= 1
    assert ask["text"].startswith("Read 8 records of board.jsonl with ") and ask["meta"].startswith("about ")
    assert fake_classify.calls == [] and concepts.running_apply(CORPUS, k["id"]) is None  # nothing read yet
    listed = (await api.get(f"/api/ws/{CORPUS}/label-asks")).json()
    assert [a["id"] for a in listed] == [ask["id"]]

    # a sample: 3 records are read, and the next run asks again
    r = await api.post(f"/api/ws/{CORPUS}/label-asks/{ask['id']}", json={"choice": "sample"})
    assert r.status_code == 200, r.text
    await concepts.wait_apply(CORPUS, k["id"], 30)
    assert _items(fake_classify) == 3
    assert (await api.get(f"/api/ws/{CORPUS}/label-asks")).json() == []
    again = await api.post(f"/api/ws/{CORPUS}/label-asks/{ask['id']}", json={"choice": "all"})
    assert again.status_code == 404
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"paths": ["board.jsonl"]})
    assert r.status_code == 202 and "asked" in r.json()

    # all: every record is read, and this scope does not ask again
    r = await api.post(f"/api/ws/{CORPUS}/label-asks/{r.json()['asked']['id']}", json={"choice": "all"})
    assert r.status_code == 200
    await concepts.wait_apply(CORPUS, k["id"], 30)
    assert _items(fake_classify) == 3 + 8
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"paths": ["board.jsonl"], "wait": True})
    assert r.status_code == 200 and "asked" not in r.json()


async def test_cancel_reads_nothing_and_a_small_run_never_asks(api, fake_classify):
    k = await _create(api, description="a board post that claims a PR")
    ask = (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"paths": ["board.jsonl"]})).json()["asked"]
    r = await api.post(f"/api/ws/{CORPUS}/label-asks/{ask['id']}", json={"choice": "cancel"})
    assert r.status_code == 200 and fake_classify.calls == [] and concepts.running_apply(CORPUS, k["id"]) is None
    # a run capped at the sample or under starts at once
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"paths": ["board.jsonl"], "limit": 2, "wait": True})
    assert r.status_code == 200 and "asked" not in r.json() and _items(fake_classify) == 2
    # a regex label never asks
    rx = await _create(api, name="claims rx", kind="regex", spec="(?i)claim")
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{rx['id']}/apply", json={"paths": ["board.jsonl"], "wait": True})
    assert r.status_code == 200 and "asked" not in r.json()


async def test_main_s_apply_label_waits_for_the_choice_and_says_so(monkeypatch, fake_classify):
    from app import tools

    told: list[tuple[str, dict]] = []
    monkeypatch.setattr("app.events.post", lambda c, kind, payload=None, **kw: told.append((kind, payload)) or {})
    res = await tools.call(CORPUS, "apply_label", {"scope": "files", "name": "claims", "paths": ["board.jsonl"],
                                                   "predicate": {"kind": "prompt", "text": "a post that claims a PR"}})
    text = res.text if hasattr(res, "text") else str(res)
    assert "has not run" in text and "label_ask" in text and "8 units" in text, text
    assert fake_classify.calls == []
    (ask,) = label_asks.waiting(CORPUS)
    assert ask["from_main"] is True
    await concepts.answer_ask(CORPUS, ask["id"], "cancel")
    assert [k for k, _p in told] == ["label_ask"] and "chose not to run" in told[0][1]["text"]


def test_the_sample_is_the_terminal_s():
    """The browser asks past the same number of records as the terminal (plugin/engine/kernel/estimate.py)."""
    src = (Path(__file__).resolve().parents[3] / "plugin/engine/kernel/estimate.py").read_text("utf-8")
    text = (Path(label_asks.__file__)).read_text("utf-8")
    want = re.search(r"^SAMPLE = (\d+)", src, re.M)
    have = re.search(r"^SAMPLE = (\d+)", text, re.M)
    assert want and have and want.group(1) == have.group(1)


def test_model_words():
    assert label_asks.model_words("claude-opus-5-5") == "Opus 5.5"
    assert label_asks.model_words("claude-haiku-4-5-20251001") == "Haiku 4.5"
    assert label_asks.model_words("claude-sonnet-5") == "Sonnet 5"
