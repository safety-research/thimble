"""A trial the analyst runs on all its units from the browser (bug hunt G3): the takeaway main wrote of the sample on the
label's card is marked stale as the run starts, and main hears in `label_done` that the analyst ran the label on all its
records, with its counts and a line to write that takeaway again; a run of the trial's sample again tells main nothing
and leaves the takeaway as it is.

The trial is made through tools.call as main's apply_label with a limit, over the synthetic corpus `mini`; the browser's
run goes through the apply route; main's events are caught at events.post."""
from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, events, notebook, tools

CORPUS = "mini"
PATTERN = r"(?i)forge pr claim"  # 3 of the 8 board posts match


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    tools._last_cell.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()
    await notebook.shutdown_all()


@pytest.fixture()
def told(monkeypatch) -> list[tuple[str, dict]]:
    """Main's events, as events.post would send them."""
    out: list[tuple[str, dict]] = []

    def post(c, kind, payload=None, **_kw):
        out.append((kind, dict(payload or {})))
        return {"id": "e1", "kind": kind, "delivered": 1}

    monkeypatch.setattr(events, "post", post)
    return out


@pytest.fixture()
async def api():
    app = FastAPI()
    app.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=60) as c:
        yield c


async def _settled() -> None:
    """The label_done watchers and rerun tasks this test started, ended."""
    loop = asyncio.get_running_loop()
    for _ in range(3):
        mine = [t for t in [*concepts._watching, *concepts._reruns.values()] if t.get_loop() is loop]
        await asyncio.gather(*mine, return_exceptions=True)
        await asyncio.sleep(0)


async def test_a_trial_run_on_all_from_the_browser_marks_its_card_stale_and_tells_main(api, told):
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "paths": ["board.jsonl"], "name": "claims a PR",
                                                 "predicate": {"kind": "regex", "text": PATTERN}, "limit": 4},
                         actor="analyst", notebook=None, terminal=False)
    assert not r.is_error, r.text
    ws = config.workspace_dir(CORPUS)
    k = concepts.find_concept(ws, "claims a PR")
    assert k["trial"] is True and k["applications"][-1]["limit"] == 4
    [(_nb, card)] = concepts._label_cards(ws, k["id"])
    cid = str(card["id"])
    r = await tools.call(CORPUS, "edit_card", {"card": cid, "takeaway": "On a trial sample of 4 posts, 1 claims a PR."},
                         actor="analyst", notebook=None, terminal=False)
    assert not r.is_error, r.text
    told.clear()

    # Re-run of the trial runs its sample again: still a trial, nothing for main, the takeaway as it was
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "limit": 4})
    assert r.status_code == 200, r.text
    await _settled()
    assert concepts.read_concept(ws, k["id"])["trial"] is True
    assert not notebook.get_cell(CORPUS, cid).get(notebook.TAKEAWAY_STALE)
    assert [kind for kind, _ in told if kind == concepts.LABEL_DONE_KIND] == []

    # Run on all: a label run on everything, its card's takeaway stale, and main hears it ran on all 8 records
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 8
    await _settled()
    assert concepts.read_concept(ws, k["id"])["trial"] is False
    assert notebook.get_cell(CORPUS, cid).get(notebook.TAKEAWAY_STALE) is True
    done = [p for kind, p in told if kind == concepts.LABEL_DONE_KIND]
    assert len(done) == 1, told
    text = done[0]["text"]
    assert text.startswith(f"The analyst ran label claims a PR [[concept:{k['id']}]] on all its 8 records, after its "
                           "trial on a sample, and it finished: "), text
    assert tools.hint("apply_label-takeaway-stale", cid=cid) in text, text
    assert done[0]["card"] == f"card:{cid}"
