"""Where cards stand on the canvas. A new workspace's canvas has no group: a card stands in a group only when someone put
it there, the analyst (Group, a drag) or a call that names one for a sequence of cards that answer one question
together, which is made at the root. Every other card stands loose, outside every frame (the loose group): a card main
adds without a group, a label's card, a card the analyst adds on the canvas, a card made where the analyst wrote
(`request:<id>`), a thread's card and a writer's card. Main edits and moves loose cards, its own and the analyst's.
Workspaces from before keep the groups they have.

Main's calls go through tools.call as main's shim makes them (runtime.call_thimble): the analyst's caller, no notebook
and no session of thimble's. A thread's fork calls the same way, and the caller hook's line of its call tells it apart
(subagents.fork_call), so what it makes is the thread's from the start."""
from __future__ import annotations

import json
import re

import httpx
import pytest
from conftest import Listener
from fastapi import FastAPI

from app import agents, card_size, concepts, config, investigation, notebook, session, subagents, threads, tools
from app import subagent_files as sf

CORPUS = "mini"
YOUR_WORK = notebook.ANALYST_NOTEBOOK_TITLE


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    tools._last_cell.clear()
    monkeypatch.setattr(tools, "session_chat", lambda c, s: None)
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()
    await notebook.shutdown_all()


def ws():
    return config.workspace_dir(CORPUS)


async def main(tool: str, **args):
    """One call of main's, as its shim makes it."""
    r = await tools.call(CORPUS, tool, args)
    assert not r.is_error, r.text
    return r


def cid_of(r) -> str:
    hit = next((m.group(1) for line in r.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", line.strip()))), None)
    assert hit, r.text
    return hit


async def card(question: str, **args) -> str:
    """The id of a note card main adds."""
    return cid_of(await main("add_card", kind="note", question=question, text="x", **args))


async def writer(tool: str, **args):
    """One call of the report's writer, which runs as its own session."""
    r = await tools.call(CORPUS, tool, args, session="writer:report")
    assert not r.is_error, r.text
    return r


def group_of(cid: str) -> dict:
    hit = notebook.find_cell(ws(), cid)
    assert hit is not None, cid
    return notebook.read_notebook(ws(), hit[0])


def titles() -> list[str]:
    return [r["title"] for r in notebook.list_notebooks(ws())]


def frames() -> list[dict]:
    """The groups the canvas draws as frames: every group but the loose one."""
    return [r for r in notebook.list_notebooks(ws(), figures=False) if r["kind"] != notebook.LOOSE_KIND]


def your_work_from_before() -> str:
    """A workspace from before keeps the Your work that the analyst's cards went to."""
    return notebook.create_notebook(ws(), YOUR_WORK, role="analyst", created_by="user")["id"]


async def test_a_card_main_adds_without_a_group_stands_loose_never_in_your_work():
    first = await card("How many runs failed?")
    assert group_of(first)["kind"] == notebook.LOOSE_KIND
    assert YOUR_WORK not in titles(), "no Your work is made for it"
    # after a sequence in a group of its own, the next single card stands loose, not in that group
    for q in ("When did they start?", "Which runner?"):
        await card(q, group="Why did the runs fail?")
    assert group_of(await card("Which runner is slowest?"))["kind"] == notebook.LOOSE_KIND
    # in a workspace that has a Your work with the analyst's cards, the frame they last selected among them
    yours = your_work_from_before()
    notebook.insert_cell(CORPUS, yours, notebook.new_cell("note", "user", "Mine", payload={"text": "x"}))
    (ws() / "settings.json").write_text(json.dumps({"active_notebook": yours, "active_group": yours}))
    later = await card("How long do the runs take?")
    assert group_of(later)["kind"] == notebook.LOOSE_KIND
    assert [c["title"] for c in notebook.read_notebook(ws(), yours)["cells"]] == ["Mine"], "Your work is left as it was"


async def test_main_names_one_group_for_a_sequence_made_at_the_root():
    yours = your_work_from_before()
    asked = "Why did refunds jump in March?"
    cids = [await card(q, group=asked) for q in ("When did they start?", "Which product?", "What do the tickets say?")]
    g = group_of(cids[0])
    assert {group_of(c)["id"] for c in cids} == {g["id"]}
    assert g["title"] == asked and g["parent"] is None and g["kind"] == notebook.DEFAULT_GROUP_KIND
    assert [c["id"] for c in g["cells"]] == cids
    assert g["id"] != yours and not notebook.read_notebook(ws(), yours)["cells"]


async def test_a_new_workspace_s_canvas_gets_a_group_only_for_a_sequence(monkeypatch):
    """Every way a card is made, but a call that names a group, leaves the canvas without a frame: main's single card,
    a label's card, a card asked for where the analyst wrote, a thread's card, a writer's card and code run with no
    group. Then a sequence of cards gets one group, named by its question."""
    monkeypatch.setattr(investigation, "emit", lambda *a, **k: None)
    single = await card("How many runs failed?")
    await main("apply_label", scope="files", paths=["board.jsonl"], name="claims a PR",
               predicate={"kind": "regex", "text": "forge pr claim"})
    await card("Runs per day?", group="request:r1")
    tid = agents.new_thread(CORPUS, f"card:{single}", "How many runs failed?")["id"]
    await card("Which stage stopped each run?", group=f"thread:{tid}")
    await card("Which runs took longest?")  # a fork's card that names no group
    await writer("add_card", kind="note", question="Figure?", text="x")
    await notebook.run_code(CORPUS, "print(1)", "user")
    assert frames() == [], [r["title"] for r in frames()]
    assert not (ws() / "notebooks" / f"{notebook.MAIN}.json").exists(), "no group is made for code run with none named"
    asked = "Why did the runs fail?"
    for q in ("When did they start?", "Which runner?"):
        await card(q, group=asked)
    assert [(r["title"], r["parent"], r["n_cells"]) for r in frames()] == [(asked, None, 2)]


async def test_a_card_made_where_the_analyst_wrote_stands_loose(monkeypatch):
    """A `request:<id>` card stands loose, in a workspace with a Your work from before too, which it leaves as it was,
    and the stream still names it as the card made for the request, so the document puts it where the analyst wrote."""
    said: list[dict] = []
    monkeypatch.setattr(investigation, "emit", lambda c, inv, rec: said.append(rec))
    seq = [await card(q, group="Which runs failed?") for q in ("How many?", "Which ones?")]
    req = await card("Runs per day?", group="request:r1")
    assert group_of(req)["kind"] == notebook.LOOSE_KIND and group_of(req)["id"] != group_of(seq[0])["id"]
    assert {"type": "card-request", "request": "r1", "card": req} in said
    yours = your_work_from_before()
    (ws() / "settings.json").write_text(json.dumps({"active_notebook": yours}))
    again = await card("And per week?", group="request:r2")
    assert group_of(again)["kind"] == notebook.LOOSE_KIND and not notebook.read_notebook(ws(), yours)["cells"]
    assert {"type": "card-request", "request": "r2", "card": again} in said
    assert [r["title"] for r in frames()] == ["Which runs failed?", YOUR_WORK]


async def test_main_edits_and_moves_loose_cards_its_own_and_the_analyst_s():
    mine = await card("Mine?")
    theirs = notebook.insert_cell(CORPUS, notebook.loose_group(ws()),
                                  notebook.new_cell("note", "user", "Theirs?", payload={"text": "b"}))["id"]
    await main("edit_card", card=f"card:{theirs}", question="Theirs, renamed?", text="c")
    assert notebook.get_cell(CORPUS, theirs)["title"] == "Theirs, renamed?"
    await main("edit_card", card=f"card:{mine}", after=f"card:{theirs}")
    loose = notebook.read_notebook(ws(), notebook.loose_group(ws()))
    assert [c["id"] for c in loose["cells"]] == [theirs, mine]
    for cid in (theirs, mine):
        await main("edit_card", card=f"card:{cid}", group="Both, in order?")
    g = group_of(mine)
    assert g["parent"] is None and [c["id"] for c in g["cells"]] == [theirs, mine]
    assert YOUR_WORK not in titles()


async def test_a_label_s_card_stands_loose_unless_its_call_names_a_group():
    await main("apply_label", scope="files", paths=["board.jsonl"], name="claims a PR",
               predicate={"kind": "regex", "text": "forge pr claim"})
    k = concepts.find_concept(ws(), "claims a PR")
    (_, cell), = concepts._label_cards(ws(), k["id"])
    assert group_of(cell["id"])["kind"] == notebook.LOOSE_KIND
    await main("apply_label", scope="files", paths=["board.jsonl"], name="asks for review", group="Who asks whom?",
               predicate={"kind": "regex", "text": "REVIEW WANTED"})
    k = concepts.find_concept(ws(), "asks for review")
    (_, cell), = concepts._label_cards(ws(), k["id"])
    assert group_of(cell["id"])["title"] == "Who asks whom?" and group_of(cell["id"])["parent"] is None
    # the analyst's own label, applied in the browser, gets its card loose too
    mine = concepts.label_card(CORPUS, {"id": "k-analyst", "name": "mine"}, None, "user")
    assert group_of(mine["id"])["kind"] == notebook.LOOSE_KIND
    # and so does a label one of thimble's agents applies, which got a group named after it
    await writer("apply_label", scope="files", paths=["board.jsonl"], name="mentions a merge",
                 predicate={"kind": "regex", "text": "merge"})
    k = concepts.find_concept(ws(), "mentions a merge")
    (_, cell), = concepts._label_cards(ws(), k["id"])
    assert group_of(cell["id"])["kind"] == notebook.LOOSE_KIND
    assert YOUR_WORK not in titles() and "mentions a merge" not in titles()


async def test_a_writer_s_card_stands_loose_as_its_own_on_a_kernel_of_its_own():
    """A writer's figure stands loose, stamped with its session, which the report lists under Figures, and its code
    runs on the session's own kernel, apart from the loose cards of main's. A group the writer names that is the
    analyst's takes none of its cards; a new title it names is a group of its own, at the root."""
    note = cid_of(await writer("add_card", kind="note", question="Figure?", text="x"))
    shown = notebook.get_cell(CORPUS, note)
    assert group_of(note)["kind"] == notebook.LOOSE_KIND and shown[tools.SESSION_KEY] == "writer:report"
    assert "kernel" not in shown
    await main("add_card", kind="code", question="Main's?", code="seen = 'main'")
    r = await writer("add_card", kind="code", question="Runs?", code="print(globals().get('seen', 'apart'))")
    ran = notebook.get_cell(CORPUS, cid_of(r))
    assert ran["kernel"] == tools.session_kernel("writer:report") == "s-writer-report"
    assert ran[tools.SESSION_KEY] == "writer:report" and group_of(ran["id"])["kind"] == notebook.LOOSE_KIND
    assert "apart" in "".join(str(b.get("text/plain") or b.get("text") or "") for b in ran["outputs"]), ran["outputs"]
    seq = await card("When did they start?", group="Why did the runs fail?")
    moved = cid_of(await writer("add_card", kind="note", question="Into main's?", text="x",
                                group="Why did the runs fail?"))
    assert group_of(moved)["kind"] == notebook.LOOSE_KIND and [c["id"] for c in group_of(seq)["cells"]] == [seq]
    own = cid_of(await writer("add_card", kind="note", question="Steps?", text="x", group="How a night runs"))
    g = group_of(own)
    assert g["title"] == "How a night runs" and g["parent"] is None and g.get(tools.SESSION_KEY) == "writer:report"
    assert not tools._analysts(ws(), g["id"])


async def test_a_thread_s_card_stands_loose_and_lists_as_the_thread_s():
    """A thread gets no group: the card its fork adds stands loose whether it names the thread or no group, the thread's
    event names no group, and list_cards finds the cards credited to the thread. A thread that has a group from before
    keeps it, and a card that names the thread goes there."""
    anchor = await card("How many runs failed?")
    tid = agents.new_thread(CORPUS, f"card:{anchor}", "How many runs failed?")["id"]
    agents.append(agents.paths(CORPUS, tid)[1], {"type": "user", "text": "Which stage stopped each?"})
    _, fields, _ = threads.build(CORPUS, tid, ["Which stage stopped each?"])
    assert "group" not in fields and fields["thread"] == tid
    named = await card("Which stage stopped each?", group=f"thread:{tid}")
    bare = await card("Which runs took longest?")
    for cid in (named, bare):
        assert group_of(cid)["kind"] == notebook.LOOSE_KIND
        agents.claim_cell(CORPUS, cid, tid)
    assert frames() == [] and agents.read_meta(CORPUS, tid).get("group") is None
    listed = (await main("list_cards", group=f"thread:{tid}")).text
    assert f"card:{named}" in listed and f"card:{bare}" in listed and f"card:{anchor}" not in listed
    # a thread from before, with the group its cards went to
    old = agents.new_thread(CORPUS, f"card:{anchor}", "How many runs failed?")["id"]
    kept = notebook.create_notebook(ws(), "main/old thread", parent=None, anchor=anchor, chat=old)["id"]
    agents.update_agent(CORPUS, old, group=kept)
    assert group_of(await card("And then?", group=f"thread:{old}"))["id"] == kept
    assert [r["id"] for r in frames()] == [kept]


@pytest.fixture()
def fork():
    """A side thread on a loose card of main's, answered by the fork `fork1`, which main's session (a Listener) follows
    into the thread's chat. (the thread's id, a function that writes the caller hook's line of one of the fork's calls
    and gives its id.)"""
    anchor = notebook.insert_cell(CORPUS, notebook.loose_group(ws()),
                                  notebook.new_cell("note", tools.TERMINAL, "How many runs failed?", payload={"text": "x"}))
    tid = agents.new_thread(CORPUS, f"card:{anchor['id']}", "How many runs failed?")["id"]
    q = Listener(CORPUS)
    session._live[CORPUS].subs.append(session.Sub(CORPUS, tid, "toolu_forked", "fork1", thread=True))
    n = [0]

    def call() -> str:
        n[0] += 1
        sf.add_caller(ws(), f"toolu_fork{n[0]:04d}", "fork1", sf.FORK_TYPE)
        return f"toolu_fork{n[0]:04d}"

    yield tid, call
    q.close()


async def by_fork(call, tool: str, **args):
    """One call of the thread's fork, through main's shim with the caller hook's line."""
    r = await tools.call(CORPUS, tool, args, tool_use_id=call())
    assert not r.is_error, r.text
    return r


async def test_a_thread_s_card_is_the_thread_s_from_the_moment_it_is_made(fork, monkeypatch):
    """A card a thread's fork adds is credited to the thread as it is made, so the page, which puts what a thread made
    beside the card the thread is about, draws it there the first time it shows it, while its code still runs. Its
    code runs on the thread's own kernel, apart from main's loose cards. A sequence the fork names is one group, each
    card of it the thread's from the start. Main's own card stays main's."""
    tid, call = fork
    said: list[dict] = []
    monkeypatch.setattr(investigation, "emit", lambda c, inv, rec: said.append(rec))
    await main("add_card", kind="code", question="Main's?", code="seen = 'main'")
    r = await by_fork(call, "add_card", kind="code", question="Which stage stopped each run?",
                      code="print(globals().get('seen', 'apart'))")
    cell = notebook.get_cell(CORPUS, cid_of(r))
    assert cell["created_by"] == f"chat:{tid}" and group_of(cell["id"])["kind"] == notebook.LOOSE_KIND
    made = next(x for x in said if x.get("cell") == cell["id"] and x.get("op") == "created")
    assert made["by"] == f"chat:{tid}", "the card's first record names the thread, before its code has run"
    assert cell["kernel"] == tools.thread_kernel(tid)
    assert "apart" in "".join(str(b.get("text/plain") or b.get("text") or "") for b in cell["outputs"]), cell["outputs"]
    note = notebook.get_cell(CORPUS, cid_of(await by_fork(call, "add_card", kind="note", question="Why?", text="x")))
    assert note["created_by"] == f"chat:{tid}" and "kernel" not in note
    seq = [cid_of(await by_fork(call, "add_card", kind="note", question=q, text="x",
                                group="Where did the failed runs stop?")) for q in ("Which stage?", "Which runner?")]
    g = group_of(seq[0])
    assert g["parent"] is None and [c["id"] for c in g["cells"]] == seq
    assert {c["created_by"] for c in g["cells"]} == {f"chat:{tid}"}
    mine = notebook.get_cell(CORPUS, cid_of(await main("add_card", kind="note", question="Main's again?", text="x")))
    assert mine["created_by"] == tools.TERMINAL and "kernel" not in mine
    # the page finds the fork's card too tall: the fork is told with its next call, and main is not
    assert card_size.tell(CORPUS, notebook.get_cell(CORPUS, cell["id"]), 1200)
    assert f"card:{cell['id']}'s body draws 1200 px tall" not in (await main("list_cards", group="all")).text
    assert f"card:{cell['id']}'s body draws 1200 px tall" in (await by_fork(call, "list_cards", group="all")).text


async def test_a_thread_s_label_is_the_thread_s_and_an_unknown_fork_s_card_waits_for_the_mirror(fork, monkeypatch):
    """A label a thread's fork applies, and its card, are the thread's from the start. A fork whose thread the mirror
    does not know yet adds a card stamped as main's shim stamps it, which the mirror credits to the thread later."""
    tid, call = fork
    monkeypatch.setattr(investigation, "emit", lambda *a, **k: None)
    await by_fork(call, "apply_label", scope="files", paths=["board.jsonl"], name="claims a PR",
                  predicate={"kind": "regex", "text": "forge pr claim"})
    (_, cell), = concepts._label_cards(ws(), concepts.find_concept(ws(), "claims a PR")["id"])
    assert cell["created_by"] == f"chat:{tid}" and group_of(cell["id"])["kind"] == notebook.LOOSE_KIND
    monkeypatch.setattr(subagents, "CALLER_WAIT_S", 0.05)
    sf.add_caller(ws(), "toolu_stranger", "fork2", sf.FORK_TYPE)
    r = await tools.call(CORPUS, "add_card", {"kind": "note", "question": "Whose?", "text": "x"},
                         tool_use_id="toolu_stranger")
    assert not r.is_error, r.text
    stranger = notebook.get_cell(CORPUS, cid_of(r))
    assert stranger["created_by"] == tools.TERMINAL and "kernel" not in stranger
    agents.claim_cell(CORPUS, stranger["id"], tid)
    assert notebook.get_cell(CORPUS, stranger["id"])["created_by"] == f"chat:{tid}"


async def test_a_path_of_titles_makes_one_group_never_a_chain():
    """A path that names no group makes one group, under the deepest group it names, titled with the rest of the path:
    never a frame inside a frame around one card. The same path finds it again, and a question with ` / ` in it is one
    group's title."""
    r = await main("add_card", kind="note", question="Spike?", text="x", group="Analysis / Spike / Detail")
    assert "made the group 'Analysis / Spike / Detail'" in r.text
    g = group_of(cid_of(r))
    assert (g["title"], g["parent"]) == ("Analysis / Spike / Detail", None)
    assert group_of(await card("Again?", group="analysis / spike / detail"))["id"] == g["id"]
    assert [r["title"] for r in frames()] == ["Analysis / Spike / Detail"]
    # under a group the analyst made, the rest of the path is one group in it
    mine = notebook.create_notebook(ws(), "Stations")["id"]
    r = await main("add_card", kind="note", question="Which?", text="x", group="Stations / Busy / Quiet")
    assert "made the group 'Stations / Busy / Quiet'" in r.text
    inner = group_of(cid_of(r))
    assert (inner["title"], inner["parent"]) == ("Busy / Quiet", mine)
    assert group_of(await card("Which again?", group="Stations / Busy / Quiet"))["id"] == inner["id"]
    asked = "Which stations gain / lose riders?"
    assert group_of(await card("First?", group=asked))["title"] == asked
    assert len(frames()) == 4


async def test_the_model_reads_a_loose_card_as_in_no_group():
    """What a model reads of a loose card says it is in no group, so a thread's fork, which reads the card it is about,
    does not name the loose group to put its card by it: read_ref's head line and list_cards' heading. A card in a
    group keeps its group's id and name."""
    loose = await card("How many runs failed?")
    seq = await card("When did they start?", group="Why did the runs fail?")
    assert f"card:{loose} (no group, note)" in (await main("read_ref", ref=f"card:{loose}")).text
    assert f"card:{seq} (group {group_of(seq)['id']}, note)" in (await main("read_ref", ref=f"card:{seq}")).text
    listed = (await main("list_cards", group="all")).text
    assert "Cards in no group (1 card)" in listed and 'Group "Why did the runs fail?"' in listed
    assert notebook.LOOSE_TITLE not in listed
    missing = await tools.call(CORPUS, "list_cards", {"group": "Nothing"})
    assert missing.is_error and "'Why did the runs fail?'" in missing.text and notebook.LOOSE_TITLE not in missing.text


@pytest.fixture()
async def client():
    a = FastAPI()
    a.include_router(notebook.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t", timeout=60) as c:
        yield c


@pytest.mark.parametrize("dragged", [False, True], ids=["empty-frame", "card-dragged-in"])
async def test_a_card_made_where_the_analyst_wrote_stands_loose_never_in_a_frame_they_made(client, dragged, monkeypatch):
    """With main's single cards loose, the analyst's first frame made with Group may be the canvas's only frame. A
    `request:<id>` card stands loose all the same, never in that frame, empty or holding a card the analyst dragged in,
    and never in a frame settings.active_notebook names."""
    monkeypatch.setattr(investigation, "emit", lambda *a, **k: None)
    single = await card("How many runs failed?")
    r = await client.post(f"/api/ws/{CORPUS}/notebooks", json={"title": "Group 1", "pos": {"x": 1600, "y": 0}})
    assert r.status_code == 200, r.text
    frame = r.json()["id"]
    if dragged:
        r = await client.post(f"/api/ws/{CORPUS}/cells/move", json={"cells": [single], "group": frame})
        assert r.status_code == 200, r.text
    req = await card("Runs per day?", group="request:r1")
    assert group_of(req)["kind"] == notebook.LOOSE_KIND
    held = notebook.read_notebook(ws(), frame)
    assert [c["id"] for c in held["cells"]] == ([single] if dragged else []) and not held.get("created_by")
    (ws() / "settings.json").write_text(json.dumps({"active_notebook": frame}))
    assert group_of(await card("And per week?", group="request:r2"))["kind"] == notebook.LOOSE_KIND
    assert [r["id"] for r in frames()] == [frame]


async def test_the_analyst_s_new_card_on_the_canvas_stands_loose(client):
    """The canvas's Card makes a card outside every frame, where the analyst is looking (`pos`), or below the board."""
    r = await client.post(f"/api/ws/{CORPUS}/cells", json={"kind": "code", "title": "New card", "code": "", "pos": {"x": 120, "y": 340}})
    assert r.status_code == 200, r.text
    cell = r.json()
    assert cell["pos"] == {"x": 120, "y": 340} and cell["created_by"] == "user"
    assert group_of(cell["id"])["kind"] == notebook.LOOSE_KIND
    r = await client.post(f"/api/ws/{CORPUS}/cells", json={"kind": "code", "title": "Another", "code": ""})
    assert r.status_code == 200 and r.json()["pos"] is None and group_of(r.json()["id"])["kind"] == notebook.LOOSE_KIND
    assert (await client.post(f"/api/ws/{CORPUS}/cells", json={"kind": "code", "title": "x", "pos": {"x": "a"}})).status_code == 400
    assert YOUR_WORK not in titles()
