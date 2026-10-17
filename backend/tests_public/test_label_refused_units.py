"""A prompt label whose run Claude's safeguards refused in part (bug hunt C17): its notice says so without telling the
analyst to rephrase main's request, links the label and offers a run again on those units alone; that run asks the
classifier about them alone and takes its values into the run it ran again for; main hears in `label_done` how many
units still have no value and why, and is asked to say so; a run that labels every unit takes the notice away.

Called through tools.call as a browser chat running as the analyst, over a copy of `mini` with a markdown file added.
The classifier is scripted at concepts.classify_structured, and main's events are caught at events.post."""
from __future__ import annotations

import pytest

from app import concepts, config, events, notebook, notices, tools
from app import call_result as model_mod

CORPUS = "mini"
REFUSAL = "Claude's safeguards refused the request (stop_reason refusal)"


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, data_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    tools._last_cell.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()
    await notebook.shutdown_all()


class Classify:
    """Scripted concepts.classify_structured, one item per call: Claude's safeguards refuse a text in `refuse` (each in
    `once` only the first time it is asked); any other gets `yes` when it says `confused`."""

    def __init__(self):
        self.items: list[tuple[str, str]] = []
        self.refuse = {"tangled one", "tangled two"}
        self.once = {"tangled two"}

    async def __call__(self, c, concept, items, comment=True, on_retry=None):
        self.items += items
        hit = [t for _r, t in items if t.strip() in self.refuse]
        if hit:
            self.refuse -= self.once.intersection(hit)
            return model_mod.CallResult(status="refused", detail=REFUSAL, attempts=1)
        labels = [{"i": n, "label": "yes" if "confused" in t else "no", "confidence": 0.9} for n, (_r, t) in enumerate(items, 1)]
        return model_mod.CallResult(status="ok", output={"labels": labels}, attempts=1)


@pytest.fixture()
def classify(monkeypatch) -> Classify:
    fake = Classify()
    monkeypatch.setattr(concepts, "classify_structured", fake)
    monkeypatch.setattr(concepts, "BATCH_ITEMS", 1)
    return fake


@pytest.fixture()
def told(monkeypatch) -> list[tuple[str, dict]]:
    """Main's events, as events.post would send them."""
    out: list[tuple[str, dict]] = []

    def post(c, kind, payload=None, **_kw):
        out.append((kind, dict(payload or {})))
        return {"id": "e1", "kind": kind, "delivered": 1}

    monkeypatch.setattr(events, "post", post)
    return out


def notice(cid: str) -> dict | None:
    return next((n for n in notices.open_notices(CORPUS) if n.get("key") == f"label:{cid}"), None)


async def run_again(cid: str) -> None:
    await concepts.start_again(CORPUS, cid)
    await concepts.tell_when_done(CORPUS, cid)


async def test_refused_units_are_told_to_main_and_run_again_alone_from_the_notice(data_tmp, classify, told):
    (data_tmp / CORPUS / "talk").mkdir(exist_ok=True)
    (data_tmp / CORPUS / "talk" / "p3.md").write_text("tangled one\nfine but confused\ntangled two\nplain words\n")
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "paths": ["talk/*.md"], "name": "confused",
                                                 "predicate": {"kind": "prompt", "text": "The speaker is confused."}},
                         actor="analyst", notebook=None, terminal=False)
    assert not r.is_error, r.text
    k = concepts.find_concept(config.workspace_dir(CORPUS), "confused")
    cid = k["id"]
    run = k["applications"][-1]
    assert (run["failed"], run["refused"], run["labeled"]) == (2, 2, 2), run

    # the notice: why in plain words, a link to the label and a run again on the 2, never "rephrase the request"
    n = notice(cid)
    assert n is not None
    assert n["text"] == "The label confused couldn't label 2 of 4 records: Claude's safeguards refused them.", n["text"]
    acts = n["action"] if isinstance(n["action"], list) else [n["action"]]
    assert {"label": "Run again on these 2", "do": "label-again", "slug": cid} in acts, acts
    assert {"label": "See the label", "do": "label-open", "slug": cid} in acts, acts

    # main's label_done for a run that refused some: the count, why, and that it says so
    assert concepts.unlabeled_text(k, run).startswith("2 of its 4 records got no value, since Claude's safeguards "
                                                      "refused them, and these counts leave them out. Say so in your answer")

    # the notice's run again asks about the 2 alone; one is refused again
    classify.items.clear()
    await run_again(cid)
    assert sorted(t.strip() for _r, t in classify.items) == ["tangled one", "tangled two"], classify.items
    k = concepts.read_concept(config.workspace_dir(CORPUS), cid)
    run = k["applications"][-1]
    assert (run["labeled"], run["failed"], run["total"], run["again"]["total"]) == (3, 1, 4, 2), run
    kind, payload = told[-1]
    assert kind == concepts.LABEL_DONE_KIND
    assert ("1 of its 4 records got no value, since Claude's safeguards refused them, and these counts leave them out. "
            "Say so in your answer") in payload["text"], payload["text"]
    n = notice(cid)
    assert n is not None and "couldn't label 1 of 4 records" in n["text"], n
    assert {"label": "Run again on these 1", "do": "label-again", "slug": cid} in n["action"], n["action"]

    # once the safeguards let it through, every record has a value and the notice goes
    classify.refuse.clear()
    classify.items.clear()
    await run_again(cid)
    assert [t.strip() for _r, t in classify.items] == ["tangled one"], classify.items
    assert notice(cid) is None
    assert concepts.unlabeled_refs(config.workspace_dir(CORPUS), concepts.read_concept(config.workspace_dir(CORPUS), cid)) == []
    assert "got no value" not in told[-1][1]["text"], told[-1]
