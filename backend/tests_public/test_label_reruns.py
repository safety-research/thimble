"""When a run of a label ends, or a moment after the analyst's last verdict on it, thimble runs the cards that read it
again (concepts.rerun_readers, notebook.rerun_on_labels): each card once per label revision, with `regenerating_for`
while it runs, and main hears which of them need a new takeaway. A label edited but not run starts nothing, and an unchanged edit_card made while
thimble reruns the card takes that run's result rather than running it twice.

The kernel is a stand-in: a card's code names the labels it reads as `reads <id>`, and its output is the revision it
read, so a rerun on a changed label changes the output."""
from __future__ import annotations

import asyncio
import json
import re
from types import SimpleNamespace

import pytest

from app import channel, concepts, config, notebook

CORPUS = "relay"


@pytest.fixture()
def kernel(workspaces_tmp, tmp_path, monkeypatch) -> SimpleNamespace:
    """The stand-in kernel: `ran` lists the code of each card run, and a run waits while `gate` is clear."""
    d = tmp_path / "data" / CORPUS
    d.mkdir(parents=True)
    (d / "log.jsonl").write_text("".join(json.dumps({"text": f"value {i}"}) + "\n" for i in range(20)))
    (d / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a relay"}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    ran: list[str] = []

    async def started(k, workspace, kernel=None) -> None:
        return None

    async def run(k, code, kind, timeout_s, extra_exprs=None):
        ran.append(code)
        await gate.wait()
        read = re.findall(r"reads (\w+)", code)
        ws = config.workspace_dir(CORPUS)
        k.last_labels = read
        k.last_label_revs = {cid: concepts._rev_of(ws, cid) for cid in read}
        return [{"text/plain": f"{code}: {k.last_label_revs}"}], len(ran), "ok"

    gate = asyncio.Event()
    gate.set()
    monkeypatch.setattr(notebook, "_ensure_started", started)
    monkeypatch.setattr(notebook, "_run_card_code", run)
    return SimpleNamespace(ran=ran, gate=gate)


async def _label(name: str, pattern: str) -> str:
    s = await concepts.apply_scoped(CORPUS, scope="files", name=name, kind="regex", text=pattern, values=["yes", "no"],
                                    paths=["log.jsonl"], limit=None, comment=False, filter=False, created_by="test",
                                    chat=None, group=None, card=False)
    await concepts.wait_apply(CORPUS, s["concept"], 60)
    return s["concept"]


async def _card(code: str, takeaway: str = "") -> str:
    cell = await notebook.run_code(CORPUS, code, "main")
    if takeaway:
        notebook.append_takeaway(CORPUS, cell["id"], takeaway, overwrite=True)
    return cell["id"]


async def _rerun_ends(cid: str) -> list[dict]:
    return await asyncio.wait_for(concepts._reruns[(CORPUS, cid)], 10)


def _cell(cid: str) -> dict:
    return notebook.get_cell(CORPUS, cid) or {}


async def test_a_label_run_reruns_its_two_cards_once_each_and_main_hears_which_need_a_takeaway(kernel):
    cid = await _label("even", r"value \d*[02468]$")
    await _rerun_ends(cid)
    a = await _card(f"count reads {cid}", "Ten records are even.")
    b = await _card(f"share reads {cid}", "Half are even.")
    other = await _card("no labels here")
    kernel.ran.clear()
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    seen: list[tuple[str, object, object]] = []
    real_emit = notebook._emit

    def emit(workspace, cell, **kw):
        seen.append((str(cell.get("id")), cell.get("status"), cell.get(notebook.REGENERATING_FOR)))
        real_emit(workspace, cell, **kw)

    notebook._emit = emit
    try:
        cid2 = await _label("even", r"value \d*[02468]")  # redefined: it now matches 10 and up as well
        assert cid2 == cid
        told = await _rerun_ends(cid)
        note = await asyncio.wait_for(q.get(), 10)
    finally:
        notebook._emit = real_emit
        channel._subs.pop(CORPUS, None)
    assert sorted(kernel.ran) == sorted([f"count reads {cid}", f"share reads {cid}"]), "each reader ran once, the other card not"
    for card in (a, b):
        assert (card, "running", [cid]) in seen, "while it runs the card says which label it runs again for"
        stored = _cell(card)
        assert stored["status"] == "ok" and notebook.REGENERATING_FOR not in stored
        assert stored["label_revs"][cid] == concepts._rev_of(config.workspace_dir(CORPUS), cid)
        assert stored.get(notebook.TAKEAWAY_STALE), "the new output leaves the old takeaway behind"
    assert not concepts.stale_cards(config.workspace_dir(CORPUS), concepts.read_concept(config.workspace_dir(CORPUS), cid))
    assert sorted(x["id"] for x in told) == sorted([a, b]) and other not in note["content"]
    assert note["meta"]["kind"] == "rerun" and f"card:{a}" in note["content"] and f"card:{b}" in note["content"]
    kernel.ran.clear()
    concepts._start_reruns(CORPUS, cid)
    await _rerun_ends(cid)
    assert kernel.ran == [], "a label revision reruns a card once"


async def test_label_done_carries_the_reruns_and_no_rerun_event_goes(kernel):
    cid = await _label("even", r"value \d*[02468]$")
    await _rerun_ends(cid)
    a = await _card(f"count reads {cid}", "Ten records are even.")
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    try:
        await concepts.start_apply(CORPUS, cid, ["log.jsonl"], None, "test")
        concepts.tell_when_done(CORPUS, cid)
        note = await asyncio.wait_for(q.get(), 10)
        await asyncio.sleep(0.2)
        assert q.empty(), "one event tells of the label and its cards"
    finally:
        channel._subs.pop(CORPUS, None)
    assert note["meta"]["kind"] == "label_done" and f"card:{a}" in note["content"]


async def test_a_label_edited_but_not_run_reruns_nothing(kernel):
    cid = await _label("even", r"value \d*[02468]$")
    await _rerun_ends(cid)
    a = await _card(f"count reads {cid}")
    before = concepts._reruns[(CORPUS, cid)]
    kernel.ran.clear()
    concepts.update_concept_route(CORPUS, cid, concepts.ConceptPatch(spec=r"value \d*[13579]$"))
    await asyncio.sleep(0.2)
    assert kernel.ran == [] and concepts._reruns[(CORPUS, cid)] is before
    assert concepts.stale_in(_cell(a), {cid: concepts.read_concept(config.workspace_dir(CORPUS), cid)}), "it stays stale until the label runs"


async def test_an_unchanged_edit_while_thimble_reruns_the_card_runs_it_once(kernel):
    gate = kernel.gate
    cid = await _label("even", r"value \d*[02468]$")
    await _rerun_ends(cid)
    a = await _card(f"count reads {cid}", "Ten records are even.")
    kernel.ran.clear()
    gate.clear()
    await concepts.start_apply(CORPUS, cid, ["log.jsonl"], None, "test")
    await concepts.wait_apply(CORPUS, cid, 10)
    for _ in range(100):
        if kernel.ran:
            break
        await asyncio.sleep(0.02)
    assert _cell(a)["status"] == "running" and _cell(a)[notebook.REGENERATING_FOR] == [cid]
    edit = asyncio.ensure_future(notebook.edit_and_run(CORPUS, _cell(a)["notebook"], a, _cell(a)["code"], by="main"))
    await asyncio.sleep(0.1)
    gate.set()
    got = await asyncio.wait_for(edit, 10)
    await _rerun_ends(cid)
    assert kernel.ran == [f"count reads {cid}"], "main's edit took thimble's run"
    assert got["status"] == "ok" and got["label_revs"][cid] == concepts._rev_of(config.workspace_dir(CORPUS), cid)


async def test_a_rerun_waits_for_a_run_under_way_and_skips_a_card_it_left_current(kernel):
    gate = kernel.gate
    cid = await _label("even", r"value \d*[02468]$")
    await _rerun_ends(cid)
    a = await _card(f"count reads {cid}")
    kernel.ran.clear()
    await concepts.start_apply(CORPUS, cid, ["log.jsonl"], None, "test")
    gate.clear()
    ended = asyncio.Event()

    async def main_edits() -> dict:
        await concepts.wait_apply(CORPUS, cid, 10)
        ended.set()
        return await notebook.edit_and_run(CORPUS, _cell(a)["notebook"], a, _cell(a)["code"], by="main")

    # main's edit starts as the label's run ends, before thimble's rerun reaches the card
    edit = asyncio.ensure_future(main_edits())
    await ended.wait()
    await asyncio.sleep(0.1)
    gate.set()
    await asyncio.wait_for(edit, 10)
    await _rerun_ends(cid)
    assert len(kernel.ran) == 1, "the card ran once, whichever run reached it first"
    assert not concepts.stale_in(_cell(a), {cid: concepts.read_concept(config.workspace_dir(CORPUS), cid)})


async def test_three_verdicts_in_a_row_rerun_each_card_once_after_the_last(kernel, monkeypatch):
    monkeypatch.setattr(concepts, "VERDICT_RERUN_DELAY_S", 0.3)
    cid = await _label("even", r"value \d*[02468]$")
    await _rerun_ends(cid)
    a = await _card(f"count reads {cid}", "Ten records are even.")
    b = await _card(f"share reads {cid}")
    locked = await _card(f"locked reads {cid}")
    notebook.edit_cell(CORPUS, locked, locked=True)
    before = concepts._reruns[(CORPUS, cid)]
    kernel.ran.clear()
    seen: list[tuple[str, object, object]] = []
    real_emit = notebook._emit

    def emit(workspace, cell, **kw):
        seen.append((str(cell.get("id")), cell.get("status"), cell.get(notebook.REGENERATING_FOR)))
        real_emit(workspace, cell, **kw)

    monkeypatch.setattr(notebook, "_emit", emit)
    for n in (2, 4, 6):
        concepts.verdict_route(CORPUS, cid, concepts.VerdictBody(ref=f"log.jsonl#L{n}", label="no"))
        await asyncio.sleep(0.1)
    assert kernel.ran == [] and concepts._reruns[(CORPUS, cid)] is before, "each verdict restarts the wait"
    for _ in range(100):
        if concepts._reruns[(CORPUS, cid)] is not before:
            break
        await asyncio.sleep(0.02)
    await _rerun_ends(cid)
    await asyncio.sleep(0.5)
    assert sorted(kernel.ran) == sorted([f"count reads {cid}", f"share reads {cid}"]), "each reader ran once, the locked card not"
    rev = concepts._rev_of(config.workspace_dir(CORPUS), cid)
    for card in (a, b):
        assert (card, "running", [cid]) in seen, "while it runs the card says which label it runs again for"
        stored = _cell(card)
        assert stored["status"] == "ok" and notebook.REGENERATING_FOR not in stored and stored["label_revs"][cid] == rev
    assert _cell(locked)["label_revs"][cid] < rev
