"""A label's revisions and the cards they leave stale (concepts.py, module note Revisions): each change to what a card
reads from a label steps its revision and is kept in words, a card's run notes the revision of each label it read, a
card that read an older revision is stale until Regenerate Card runs it again (first running a label edited since its
last run), apply_label names the cards a change leaves stale, and the orientation's labels get no card of their own,
not even when the analyst runs one again in Files or main redefines one.

The regex kind runs for real over the synthetic corpus `mini` (mini_corpus.py), and so does each card's kernel. No test
pins the wording of a line prompts/tools.md holds.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import FastAPI

from app import agents, channel, concepts, config, notebook, session, tools

CORPUS = "mini"
CLAIM = r"(?i)forge pr claim"  # 3 of the 8 board posts match (L1, L6, L8)
COUNT = "import thimble\nprint(len(thimble.labels('claims a PR')))"


@pytest.fixture(autouse=True)
async def _clean_state(workspaces_tmp, monkeypatch):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    channel._subs.clear()
    session._live.clear()
    agents._busy.clear()
    monkeypatch.setattr(concepts, "_loop", asyncio.get_running_loop())
    tools._last_cell.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()
    channel._subs.clear()
    await notebook.shutdown_all()


@pytest.fixture()
async def api():
    a = FastAPI()
    a.include_router(concepts.router, prefix="/api")
    a.include_router(notebook.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t", timeout=180) as c:
        yield c


def _ws():
    return config.workspace_dir(CORPUS)


async def _label(**kw) -> dict:
    args = dict(scope="files", name="claims a PR", kind="regex", text=CLAIM, values=["claim", "other"], paths=["board.jsonl"],
                limit=None, comment=False, filter=False, created_by="terminal", chat=None, group=None)
    return await concepts.apply_scoped(CORPUS, **{**args, **kw})


def _printed(cell: dict) -> str:
    return "".join(str(b.get("text/plain", "")) for b in cell["outputs"] if "_stream" in b).strip()


def test_changes_are_kept_in_words_and_a_run_of_corrections_is_one_entry():
    k = {"rev": 0, "changes": []}
    concepts.note_change(k, "ran", concepts.ran_text("record", 8))
    concepts.note_change(k, "corrected")
    concepts.note_change(k, "corrected")
    concepts.note_change(k, "corrected")
    concepts.note_change(k, "redefined", concepts.redefined_text(["yes", "no"], ["claim", "other"]))
    assert k["rev"] == 5 and [(e["what"], e["first"], e["rev"]) for e in k["changes"]] == [
        ("ran", 1, 1), ("corrected", 2, 4), ("redefined", 5, 5)]
    assert concepts.changed_since(k, 5) == ""
    assert concepts.changed_since(k, 0) == "run over 8 records; 3 values corrected; redefined, its values now claim, other"
    # a card that ran between two corrections counts only the corrections after it
    assert concepts.changed_since(k, 3) == "1 value corrected; redefined, its values now claim, other"
    assert concepts.redefined_text(["a"], ["a"]) == "redefined" and concepts.ran_text("cell", 1) == "run over 1 card"
    # the kept changes are bounded; a card older than the first kept one is told of earlier changes
    for _ in range(concepts.CHANGES_KEPT):
        concepts.note_change(k, "ran", "run over 2 records")
    assert len(k["changes"]) == concepts.CHANGES_KEPT and concepts.changed_since(k, 1).startswith("earlier changes; ")
    # what is stored reads back, and an entry of an unknown kind is dropped
    stored = concepts._normalize("k1", {"name": "k", "rev": 2, "changes": [*k["changes"][:1], {"what": "other", "rev": 2}]})
    assert stored["rev"] == 2 and len(stored["changes"]) == 1


async def test_each_change_to_what_a_card_reads_steps_the_revision(api, monkeypatch):
    s = await _label()
    ws = _ws()
    k = concepts.read_concept(ws, s["concept"])
    assert k["rev"] == 1 and k["changes"][-1]["text"] == "run over 8 records", "the first run ended"
    # an edit of what it marks in the reader changes nothing a card reads; an edit of its description does
    r = await api.put(f"/api/ws/{CORPUS}/concepts/{s['concept']}", json={"marks": "span"})
    assert r.status_code == 200 and concepts.read_concept(ws, s["concept"])["rev"] == 1
    r = await api.put(f"/api/ws/{CORPUS}/concepts/{s['concept']}", json={"labels": ["claim", "no claim"]})
    k = concepts.read_concept(ws, s["concept"])
    assert k["rev"] == 2 and k["changes"][-1]["text"] == "redefined, its values now claim, no claim"
    # a verdict steps it, and the workspace hears the label changed, so the canvas re-reads the labels
    heard, emit = [], concepts._emit
    monkeypatch.setattr(concepts, "_emit", lambda c, e: (heard.append(e), emit(c, e)))
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{s['concept']}/labels", json={"ref": "board.jsonl#L1", "label": "no claim"})
    assert r.status_code == 200 and concepts.read_concept(ws, s["concept"])["rev"] == 3
    assert {"type": "concepts", "concept": s["concept"], "what": "changed"} in heard
    # a run of the edited label steps it; the same predicate again runs nothing and steps nothing; a redefinition under
    # the same name steps it, and its run once more
    await _label(values=["claim", "no claim"])
    assert concepts.read_concept(ws, s["concept"])["rev"] == 4
    again = await _label(values=["claim", "no claim"])
    assert again["unchanged"] and concepts.read_concept(ws, s["concept"])["rev"] == 4
    await _label(text=r"(?i)claim", values=["claim", "no claim"])
    k = concepts.read_concept(ws, s["concept"])
    assert k["rev"] == 6 and [e["what"] for e in k["changes"][-2:]] == ["redefined", "ran"]


async def test_a_card_is_stale_once_its_label_changes_and_regenerate_brings_it_up_to_date(api):
    pytest.importorskip("pandas")
    s = await _label()
    cell = await notebook.run_code(CORPUS, COUNT, "chat:c1", title="How many posts claim a PR?")
    assert cell["status"] == "ok" and _printed(cell) == "3"
    assert cell["labels"] == [s["concept"]] and cell["label_revs"] == {s["concept"]: 1}
    k = concepts.read_concept(_ws(), s["concept"])
    assert concepts.stale_in(cell, {k["id"]: k}) == {} and concepts.stale_cards(_ws(), k) == []
    # the analyst corrects a value: the card now shows the older count, and says what changed
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{s['concept']}/labels", json={"ref": "board.jsonl#L1", "label": "other"})
    assert r.status_code == 200
    k = concepts.read_concept(_ws(), s["concept"])
    stored = notebook.get_cell(CORPUS, cell["id"])
    assert concepts.stale_in(stored, {k["id"]: k}) == {k["id"]: "1 value corrected"}
    assert [x["id"] for x in concepts.stale_cards(_ws(), k)] == [cell["id"]]
    assert _printed(stored) == "3", "nothing runs again by itself"
    # Regenerate runs it on the label as it is now: the corrected value counts, and the card is current again
    r = await api.post(f"/api/ws/{CORPUS}/cells/{cell['id']}/regenerate")
    assert r.status_code == 200 and _printed(r.json()) == "2" and r.json()["label_revs"] == {s["concept"]: k["rev"]}
    assert concepts.stale_cards(_ws(), k) == []
    # a card from before revisions were noted, and a label card, which draws its label as it is, are never stale
    assert concepts.stale_in({"labels": [k["id"]]}, {k["id"]: k}) == {}
    assert concepts.stale_in({"labels": [k["id"]], "label_revs": {k["id"]: "1"}}, {k["id"]: k}) == {}
    assert (await api.post(f"/api/ws/{CORPUS}/cells/nope/regenerate")).status_code == 404


async def test_apply_label_names_the_cards_a_change_leaves_stale():
    pytest.importorskip("pandas")
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "name": "claims a PR", "paths": ["board.jsonl"],
                                                 "values": ["claim", "other"], "predicate": {"kind": "regex", "text": CLAIM}},
                         actor="analyst", terminal=True)
    assert not r.is_error and "[[card:" in r.text, "main's label has its card"
    cell = await notebook.run_code(CORPUS, COUNT, "chat:c1", title="How many posts claim a PR?")
    assert _printed(cell) == "3"
    # the analyst asks for other categories: the label is redefined, and the result names the card that read it
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "name": "claims a PR", "paths": ["board.jsonl"],
                                                 "values": ["claim", "question", "other"],
                                                 "predicate": {"kind": "regex", "text": r"(?i)forge pr claim"}},
                         actor="analyst", terminal=True)
    assert not r.is_error
    assert tools.hint("apply_label-stale", cards=f"[[card:{cell['id']}]]") in r.text
    # edit_card with only the card runs it again, which leaves nothing stale
    again = await tools.call(CORPUS, "edit_card", {"card": cell["id"]}, actor="analyst", terminal=True)
    assert not again.is_error
    k = concepts.find_concept(_ws(), "claims a PR")
    assert concepts.stale_cards(_ws(), k) == []


async def test_the_orientation_s_labels_get_no_card(monkeypatch):
    from app import orientation

    monkeypatch.setattr(orientation, "ensure_groups", lambda c: pytest.fail("the label made a group for its card"))
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "name": "claims a PR", "paths": ["board.jsonl"],
                                                 "predicate": {"kind": "regex", "text": CLAIM}},
                         actor="analyst", session=tools.ORIENT_SESSION)
    assert not r.is_error and "[[card:" not in r.text and "[[concept:" in r.text
    k = concepts.find_concept(_ws(), "claims a PR")
    assert k is not None and concepts._label_cards(_ws(), k["id"]) == []


async def test_main_hears_which_cards_an_edit_in_the_browser_left_stale(api):
    """The analyst edits the label in Files and runs it again: the `labeled` event names the cards that read it before,
    so a later "run the cards again" in the chat needs no search."""
    pytest.importorskip("pandas")
    k = (await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "claims a PR", "kind": "regex", "spec": CLAIM,
                                                              "glob": "board.jsonl", "labels": ["claim", "other"]})).json()
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})).status_code == 200
    cell = await notebook.run_code(CORPUS, COUNT, "chat:c1", title="How many posts claim a PR?")
    assert _printed(cell) == "3"
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    await api.put(f"/api/ws/{CORPUS}/concepts/{k['id']}", json={"spec": r"(?i)review wanted"})
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})).status_code == 200
    notes = []
    while not q.empty():
        notes.append(q.get_nowait())
    [note] = [n for n in notes if n.get("meta", {}).get("kind") == "labeled"]
    assert note["meta"]["stale"] == f"card:{cell['id']}"


async def test_regenerate_runs_an_edited_label_first_and_then_the_card(api):
    """The analyst edits the label in the popover of its tag on the card and presses Regenerate Card: the edit is saved
    (PUT), and the regenerate route runs the label under its new definition before the card, which then counts by it.
    The label's run makes no second card for it."""
    pytest.importorskip("pandas")
    s = await _label()
    cell = await notebook.run_code(CORPUS, COUNT, "chat:c1", title="How many posts claim a PR?")
    assert _printed(cell) == "3"
    r = await api.put(f"/api/ws/{CORPUS}/concepts/{s['concept']}", json={"spec": r"(?i)review wanted"})
    assert r.status_code == 200
    r = await api.post(f"/api/ws/{CORPUS}/cells/{cell['id']}/regenerate")
    assert r.status_code == 202 and r.json()["waiting"] == [s["concept"]] and r.json()["id"] == cell["id"]
    await asyncio.gather(*list(notebook._regenerating))
    k = concepts.read_concept(_ws(), s["concept"])
    stored = notebook.get_cell(CORPUS, cell["id"])
    assert k["applications"][-1]["version"] == k["version"], "the label ran under its new definition"
    assert stored["label_revs"] == {k["id"]: k["rev"]} and concepts.stale_cards(_ws(), k) == []
    assert _printed(stored) == str(concepts.with_stats(_ws(), k)["counts"].get("claim", 0)) != "3"
    assert len(concepts._label_cards(_ws(), k["id"])) == 1, "the label keeps its one card"
    # once the label's rows answer its definition, Regenerate runs the card at once
    r = await api.post(f"/api/ws/{CORPUS}/cells/{cell['id']}/regenerate")
    assert r.status_code == 200 and "waiting" not in r.json()


async def test_a_label_that_ran_without_a_card_gets_none_from_a_run_in_the_browser_or_the_chat(api):
    """The orientation's label, run again from Files or redefined by main, stays without a card; a label new in Files
    gets its card on its first run."""
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "name": "claims a PR", "paths": ["board.jsonl"],
                                                 "predicate": {"kind": "regex", "text": CLAIM}},
                         actor="analyst", session=tools.ORIENT_SESSION)
    assert not r.is_error
    k = concepts.find_concept(_ws(), "claims a PR")
    await api.put(f"/api/ws/{CORPUS}/concepts/{k['id']}", json={"spec": r"(?i)review wanted"})
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})).status_code == 200
    assert concepts._label_cards(_ws(), k["id"]) == []
    # nor when main redefines it from the chat
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "name": "claims a PR", "paths": ["board.jsonl"],
                                                 "values": ["claim", "question", "other"],
                                                 "predicate": {"kind": "regex", "text": CLAIM}},
                         actor="analyst", terminal=True)
    assert not r.is_error and "[[card:" not in r.text and concepts._label_cards(_ws(), k["id"]) == []
    new =(await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "wants review", "kind": "regex", "spec": r"(?i)review",
                                                                "glob": "board.jsonl", "labels": ["review", "other"]})).json()
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{new['id']}/apply", json={"wait": True})).status_code == 200
    assert len(concepts._label_cards(_ws(), new["id"])) == 1
