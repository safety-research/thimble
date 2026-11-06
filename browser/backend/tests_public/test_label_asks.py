"""The ask before a big prompt label's run (label_asks.py, concepts.ask_first): the page's Run, the sidebar's Run again
and main's apply_label all wait for the person's choice when a prompt label reads more than a sample, as the terminal
does. The classifier is scripted (test_concepts.FakeClassify); the sample is 3 here, so the 8 board posts ask."""
from __future__ import annotations

import pytest

from app import concepts, label_asks
from test_concepts import CORPUS, _create, api, app, fake_classify  # noqa: F401 — `api`, `app`, `fake_classify` are fixtures

pytestmark = pytest.mark.usefixtures("claude_code_sign_in", "workspaces_tmp")


@pytest.fixture(autouse=True)
def _small_sample(monkeypatch):
    for table in (concepts._runs, concepts._locks, concepts._cancels, concepts._tasks):
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
    assert ask["units"] == 8 and ask["sample"] == 3
    assert fake_classify.calls == [] and concepts.running_apply(CORPUS, k["id"]) is None  # nothing read yet
    listed = (await api.get(f"/api/ws/{CORPUS}/label-asks")).json()
    assert [a["id"] for a in listed] == [ask["id"]]

    # a sample: 3 records are read, and the next run asks again
    r = await api.post(f"/api/ws/{CORPUS}/label-asks/{ask['id']}", json={"choice": "sample"})
    assert r.status_code == 200, r.text
    await concepts.wait_apply(CORPUS, k["id"], 30)
    assert _items(fake_classify) == 3
    assert (await api.get(f"/api/ws/{CORPUS}/label-asks")).json() == []
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"paths": ["board.jsonl"]})
    assert r.status_code == 202 and "asked" in r.json()

    # all: every record is read, and this scope does not ask again
    r = await api.post(f"/api/ws/{CORPUS}/label-asks/{r.json()['asked']['id']}", json={"choice": "all"})
    assert r.status_code == 200
    await concepts.wait_apply(CORPUS, k["id"], 30)
    assert _items(fake_classify) == 3 + 8
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"paths": ["board.jsonl"], "wait": True})
    assert r.status_code == 200 and "asked" not in r.json()
