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
from conftest import Listener

from app import cardrun, concepts, config, notebook

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
    monkeypatch.setattr(cardrun, "defers", lambda c: False)  # this process stands in for the card runner (R8)
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
    q = Listener(CORPUS)
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
        q.close()
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


async def test_a_label_the_running_orientation_changed_leaves_its_cards_to_it_and_names_who_changed_it(kernel,
                                                                                                    monkeypatch):
    """Bug hunt G10: the running orientation ran its own label again, and main's `rerun` event said neither who changed
    it nor whose cards read it, so main ran the orientation's card again and rewrote it while the orientation still
    worked on it, and told the analyst they had changed the label. The event names who changed the label, and the
    cards of the agent that changed it stay with that agent while it runs, since its own call's result named them."""
    from app import agents, subagents, tools
    from app import subagent_files as sf

    cid = await _label("even", r"value \d*[02468]$")
    await _rerun_ends(cid)
    chat = agents.new_agent(CORPUS, "orient", "Orientation", announce=False)["id"]
    with subagents.update(CORPUS) as state:
        sf.registry(state)["a5e1d0c0ffee0000f"] = {"type": "thimble:orientation", "role": "orientation",
                                                    "key": "orient", "chat": chat, "run": 0, "status": "running",
                                                    "started": sf.now()}
    theirs = (await notebook.run_code(CORPUS, f"count reads {cid}", f"chat:{chat}"))["id"]
    mine = await _card(f"share reads {cid}")
    monkeypatch.setattr(cardrun, "defers", lambda c: True)  # the server: the cards run again through thimble-run
    q = Listener(CORPUS)
    try:
        res = await tools.call(CORPUS, "apply_label", {
            "scope": "files", "name": "even", "paths": ["log.jsonl"], "values": ["yes", "no"],
            "predicate": {"kind": "regex", "text": r"value \d*[02468]"}}, session="orient")
        assert not res.is_error, res.text
        assert f"[[card:{theirs}]]" in res.text, "the orientation's own result names its card"
        await _rerun_ends(cid)
        note = await asyncio.wait_for(q.get(), 10)
    finally:
        q.close()
    assert note["meta"]["kind"] == "rerun" and note["meta"]["by"] == "the orientation", note
    assert note["content"].startswith(f"The orientation changed label even [[concept:{cid}]]."), note["content"]
    assert f"[[card:{mine}]]" in note["content"] and f"[[card:{theirs}]]" not in note["content"], note["content"]
