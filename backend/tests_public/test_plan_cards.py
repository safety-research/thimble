"""Plan cards: add_card's `plan` kind stores numbered steps with stable ids and no takeaway; edit_card replaces a plan's
steps at any time, as for any card, and each step it replaces keeps its id, its clock while its text is unchanged and
what the edit leaves out, such as its runs, with a changed status stamped; update_plan is gone. A step's details are
stored, served and read, and an edit that changes the plan marks what it changed until the next such edit or the
analyst's Clear marks. The next phase is a new plan that `follows` the last, and read_ref, list_cards, the canvas
context and refs read the steps. plan_runs matches a step's runs to main's subagent chats. Called through tools.call as
main's browser chat, as the other card tools' tests are."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import pytest

from app import agents, canvas_comments, concepts, config, context, material, notebook, plans, refs, tools

CORPUS = "mini"
STEPS = [
    {"text": "Mirror pandas, its open PRs and issues into a local GitHub", "makes": ["mirror/", "forge/"]},
    {"text": "Build the agent container: PyPI and conda but no web", "makes": ["Dockerfile.agent"]},
    {"text": "Pilot: 2 agents, one PR each", "makes": ["pilot/"]},
]


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    yield
    await notebook.shutdown_all()


@pytest.fixture()
def group() -> str:
    return notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]


async def call(name: str, nb: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", notebook=nb, terminal=False)


def _cid(result) -> str:
    assert not result.is_error, result.text
    hit = next((m.group(1) for line in result.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", line.strip()))), None)
    assert hit, result.text
    return hit


async def _plan(group: str, question: str = "Plan: build the environment and pilot it", **extra) -> str:
    return _cid(await call("add_card", group, kind="plan", question=question, steps=STEPS, **extra))


def _cell(cid: str) -> dict:
    cell = notebook.get_cell(CORPUS, cid)
    assert cell is not None
    return cell


def _with(n: int, **fields) -> list[dict]:
    """STEPS as edit_card passes them back, with step `n` (from 1) given `fields`."""
    return [{**s, **fields} if i == n else dict(s) for i, s in enumerate(STEPS, 1)]


async def test_add_card_stores_a_plans_steps_with_ids_and_no_takeaway(group):
    res = await call("add_card", group, kind="plan", question="Plan: build the environment and pilot it", steps=STEPS)
    cid = _cid(res)
    cell = _cell(cid)
    assert cell["kind"] == "plan" and cell["takeaway"] == ""
    steps = cell["payload"]["steps"]
    assert [s["id"] for s in steps] == ["s1", "s2", "s3"]
    assert [s["text"] for s in steps] == [s["text"] for s in STEPS]
    assert steps[0]["makes"] == ["mirror/", "forge/"]
    assert {s["status"] for s in steps} == {"not started"}
    assert all(s["started"] is None and s["ended"] is None for s in steps)
    assert cell["payload"]["follows"] is None
    # the result is the plan's steps, numbered, and asks for no takeaway
    assert "1. [not started] Mirror pandas" in res.text and "→ mirror/, forge/" in res.text
    assert tools.hint("takeaway-missing-shown", cid=cid) not in res.text
    # the next card's result does not remind the caller of the plan's takeaway
    nxt = await call("add_card", group, kind="note", question="What is next?", text="The pilot.")
    assert tools.hint("takeaway-reminder", cid=cid) not in nxt.text


async def test_add_card_refuses_a_plan_with_a_takeaway_no_steps_or_a_bad_status(group):
    res = await call("add_card", group, kind="plan", question="Plan", steps=STEPS, takeaway="Three steps.")
    assert res.is_error and "takeaway" in res.text
    res = await call("add_card", group, kind="plan", question="Plan")
    assert res.is_error and "`steps`" in res.text
    res = await call("add_card", group, kind="plan", question="Plan", steps=[{"makes": ["x/"]}])
    assert res.is_error and "step 1" in res.text
    res = await call("add_card", group, kind="plan", question="Plan", steps=[{"text": "Run it", "status": "half done"}])
    assert res.is_error and "not started" in res.text
    assert not [c for _, nb in notebook._stored(config.workspace_dir(CORPUS)) for c in nb["cells"]], "nothing was stored"


async def test_edit_card_changes_statuses_and_stamps_their_times(group):
    cid = await _plan(group)
    res = await call("edit_card", group, card=f"card:{cid}", steps=_with(1, status="running", runs=["Mirror pandas"]))
    assert not res.is_error, res.text
    assert res.text.splitlines()[1] == f"card:{cid}"
    s1 = notebook.plan_steps(_cell(cid))[0]
    assert s1["status"] == "running" and s1["started"] and s1["ended"] is None and s1["runs"] == ["Mirror pandas"]
    started = s1["started"]
    assert re.search(r"^1\. \[running · \d+ s\] Mirror pandas", res.text, re.M), res.text
    # the step's runs are left out of this edit, so it keeps them, and its clock, since its text is unchanged
    res = await call("edit_card", group, card=f"card:{cid}", steps=_with(1, status="Done", note="6 repos mirrored"))
    s1 = notebook.plan_steps(_cell(cid))[0]
    assert s1["status"] == "done" and s1["ended"] and s1["started"] == started and s1["note"] == "6 repos mirrored"
    assert s1["runs"] == ["Mirror pandas"]
    assert "note: 6 repos mirrored" in res.text
    # the steps' ids and the others stay as they were
    steps = notebook.plan_steps(_cell(cid))
    assert [s["id"] for s in steps] == ["s1", "s2", "s3"] and steps[1]["status"] == "not started"
    # a step whose status the edit leaves out keeps it, and `time` overrides thimble's count
    res = await call("edit_card", group, card=f"card:{cid}", steps=_with(3, status="needs you", time="22 m"))
    assert not res.is_error, res.text
    steps = notebook.plan_steps(_cell(cid))
    assert steps[2]["status"] == "needs you" and steps[0]["status"] == "done" and steps[0]["started"] == started
    assert "3. [needs you · 22 m] Pilot" in res.text
    # every change is an edit of the card by its caller
    assert len(_cell(cid)["edited"]) == 3


async def test_edit_card_refuses_a_bad_status_a_step_without_text_and_a_locked_plan(group):
    cid = await _plan(group)
    res = await call("edit_card", group, card=f"card:{cid}", steps=_with(1, status="finished"))
    assert res.is_error and "needs you" in res.text
    res = await call("edit_card", group, card=f"card:{cid}", steps=[*STEPS, {"makes": ["x/"]}])
    assert res.is_error and "step 4" in res.text
    notebook.edit_cell(CORPUS, cid, locked=True)
    res = await call("edit_card", group, card=f"card:{cid}", steps=_with(1, status="done"))
    assert res.is_error and res.text.endswith(tools.hint("card-locked", cid=cid))
    assert notebook.plan_steps(_cell(cid))[0]["status"] == "not started"
    assert len(notebook.plan_steps(_cell(cid))) == 3


async def test_update_plan_is_gone_from_the_tools_and_their_descriptions(group):
    assert "update_plan" not in tools.REGISTRY
    from app import prompts

    assert "update_plan" not in prompts.load("tools") and "## plan-started" not in prompts.load("tools")
    assert "update_plan" not in prompts.load("main") and "`edit_card`" in prompts.load("main")
    assert tools.hint("plan-started", cid="x") == ""
    assert "update_plan" not in {t["name"] for t in tools.list()}
    with pytest.raises(KeyError):
        await call("update_plan", group, card="card:nope", step=1, status="done")


async def test_stamps_follow_status_changes():
    step = notebook.plan_step_of({"text": "Run"}, "s1")
    plans.stamp(step, "running", "2026-10-08T10:00:00+00:00")
    assert step["started"] == "2026-10-08T10:00:00+00:00" and step["ended"] is None
    plans.stamp(step, "needs you", "2026-10-08T10:20:00+00:00")
    plans.stamp(step, "running", "2026-10-08T10:30:00+00:00")
    assert step["started"] == "2026-10-08T10:00:00+00:00", "a step that waited for the analyst keeps its clock"
    plans.stamp(step, "done", "2026-10-08T12:00:00+00:00")
    assert notebook.step_time(step) == "2 h"
    step["ended"] = "2026-10-08T11:20:00+00:00"
    assert notebook.step_time(step) == "1 h 20 m"
    plans.stamp(step, "not started", "2026-10-08T13:00:00+00:00")
    assert step["started"] is None and step["ended"] is None and notebook.step_time(step) == ""
    running = {**step, "status": "running", "started": "2026-10-08T10:00:00+00:00"}
    assert notebook.step_time(running, datetime(2026, 10, 8, 10, 40, tzinfo=timezone.utc)) == "40 m"
    assert notebook.duration_words(42) == "42 s" and notebook.duration_words(3600) == "1 h"


async def test_edit_card_replaces_a_plans_steps_at_any_time_but_takes_no_takeaway(group):
    cid = await _plan(group)
    res = await call("edit_card", group, card=f"card:{cid}", steps=[*STEPS, {"text": "Write the prompts", "makes": ["prompts/"]}])
    assert not res.is_error, res.text
    assert len(notebook.plan_steps(_cell(cid))) == 4
    res = await call("edit_card", group, card=f"card:{cid}", takeaway="Four steps.")
    assert res.is_error and "takeaway" in res.text
    assert _cell(cid)["takeaway"] == ""
    await call("edit_card", group, card=f"card:{cid}", steps=_with(1, status="running"))
    # once a step has started, the steps can still change: no refusal, no hint
    res = await call("edit_card", group, card=f"card:{cid}", steps=[{**STEPS[0], "status": "done"}])
    assert not res.is_error, res.text
    assert "plan-started" not in res.text and "update_plan" not in res.text
    steps = notebook.plan_steps(_cell(cid))
    assert [(s["id"], s["status"]) for s in steps] == [("s1", "done")] and steps[0]["started"] and steps[0]["ended"]
    assert _cell(cid)["payload"]["follows"] is None
    # its question can still change
    res = await call("edit_card", group, card=f"card:{cid}", question="Plan: build it")
    assert not res.is_error and _cell(cid)["title"] == "Plan: build it"


async def test_edit_card_after_a_step_started_keeps_the_ids_times_runs_and_comments_of_the_steps_it_keeps(group):
    cid = await _plan(group)
    await call("edit_card", group, card=f"card:{cid}", steps=_with(1, status="running"))
    await call("edit_card", group, card=f"card:{cid}", steps=[{**STEPS[0], "status": "done"},
                                                              {**STEPS[1], "status": "running", "runs": ["Build it"]}, STEPS[2]])
    before = {s["id"]: s for s in notebook.plan_steps(_cell(cid))}
    assert before["s1"]["started"] and before["s1"]["ended"] and before["s2"]["started"]
    on_two, _ = canvas_comments.add(CORPUS, card=cid, step="s2", text="The image has no web.", author="claude")
    on_three, _ = canvas_comments.add(CORPUS, card=cid, step="s3", text="Two agents is few.", author="claude")
    # a new step put in before step 2, step 3 reworded, nothing said of the done step's status or step 2's runs
    res = await call("edit_card", group, card=f"card:{cid}", steps=[
        {"text": STEPS[0]["text"], "makes": STEPS[0]["makes"]},
        {"text": "Write the prompts", "makes": ["prompts/"]},
        {"text": STEPS[1]["text"], "makes": STEPS[1]["makes"], "details": "The image caches the meson subprojects."},
        {"text": "Pilot: 4 agents, one PR each", "makes": ["pilot/"]},
    ])
    assert not res.is_error, res.text
    steps = notebook.plan_steps(_cell(cid))
    assert [s["id"] for s in steps] == ["s1", "s4", "s2", "s3"], "a kept step keeps its id; the new one takes a new id"
    one, new, two, three = steps
    assert (one["status"], one["started"], one["ended"]) == ("done", before["s1"]["started"], before["s1"]["ended"])
    assert (new["status"], new["started"], new["ended"]) == ("not started", None, None)
    assert (two["status"], two["started"], two["ended"]) == ("running", before["s2"]["started"], None)
    assert two["runs"] == ["Build it"] and two["details"] == "The image caches the meson subprojects."
    assert three["text"] == "Pilot: 4 agents, one PR each" and three["started"] is None
    # the comments follow their steps to their new places
    refs_now = {cm["id"]: cm["ref"] for cm in canvas_comments.all_comments(CORPUS)}
    assert refs_now[on_two["id"]] == f"card:{cid}#step-3" and refs_now[on_three["id"]] == f"card:{cid}#step-4"
    # a running step's live row still names it, at its new place
    assert [(r["step"], r["name"]) for r in plans.plan_runs(CORPUS, cid)] == [(3, "Build it")]
    # a step left out is gone with its comment, and no later step takes its id
    await call("edit_card", group, card=f"card:{cid}", steps=[{"text": s["text"]} for s in steps[:3]])
    assert on_three["id"] not in {cm["id"] for cm in canvas_comments.all_comments(CORPUS)}
    await call("edit_card", group, card=f"card:{cid}", steps=[*({"text": s["text"]} for s in steps[:3]), {"text": "Report"}])
    assert [s["id"] for s in notebook.plan_steps(_cell(cid))] == ["s1", "s4", "s2", "s5"]
    assert on_three["id"] not in {cm["id"] for cm in canvas_comments.all_comments(CORPUS)}


def test_steps_match_by_id_then_text_then_place():
    old = notebook.plan_steps_of([{"id": "a", "text": "Mirror"}, {"id": "b", "text": "Build"}, {"id": "c", "text": "Pilot"}])
    assert plans.match_steps(old, [{"text": "Mirror"}, {"text": "Build"}, {"text": "Pilot"}]) == [0, 1, 2]
    assert plans.match_steps(old, [{"text": "Pilot"}, {"text": "Mirror"}]) == [2, 0], "by text, wherever it stands"
    assert plans.match_steps(old, [{"text": "Mirror"}, {"text": "Build it"}, {"text": "Pilot"}]) == [0, 1, 2], "reworded in place"
    assert plans.match_steps(old, [{"text": "Mirror"}, {"text": "New"}, {"text": "Build"}, {"text": "Pilot 2"}]) == [0, None, 1, 2]
    assert plans.match_steps(old, [{"id": "c", "text": "Pilot, reworded"}, {"text": "Mirror"}]) == [2, 0]
    # every step reworded and one put in before the pilot: each reworded step is the old step it reads most like, and
    # the step put in is new rather than the pilot's place (the live check after Matt's feedback, 2026-10-09)
    four = notebook.plan_steps_of([{"text": "Mirror pandas"}, {"text": "Build the agent image with a meson cache"},
                                   {"text": "Pilot: two agents, one PR each"}, {"text": "Run and compare the conditions"}])
    assert plans.match_steps(four, [{"text": "Mirror pandas"}, {"text": "Build the agent image from the existing Dockerfile with a meson cache"},
                                    {"text": "Check that every agent builds pandas offline"}, {"text": "Pilot: 4 agents on 10 PRs"},
                                    {"text": "Compare the conditions: PRs merged and reverted"}]) == [0, 1, None, 2, 3]
    assert plans.likeness("Pilot: two agents, one PR each", "Pilot: 4 agents on 10 PRs") > plans.likeness(
        "Pilot: two agents, one PR each", "Check that every agent builds pandas offline")
    # the second live check: the check put in before the pilot reads more like the old pilot than any step but the new
    # pilot, which takes it; the full runs after them are new
    six = notebook.plan_steps_of([{"text": "Write the two conditions"}, {"text": "Pilot with 2 agents: each builds pandas, picks a PR and gets it merged"}])
    assert plans.match_steps(six, [{"text": "Write the two conditions with the same issues"},
                                   {"text": "Check that every agent can build pandas offline: start each agent's container with no web, build pandas"},
                                   {"text": "Pilot with 4 agents on the same 10 PRs, once per condition, through the local GitHub and the message board"},
                                   {"text": "Full runs of both conditions"}]) == [0, None, 1, None]
    merged = plans.merge_steps(old, [{"id": "c", "text": "Pilot, reworded", "status": "running"}], now="2026-10-09T10:00:00+00:00")
    assert merged[0]["id"] == "c" and merged[0]["started"] == "2026-10-09T10:00:00+00:00"
    made = plans.merge_steps([], [{"text": "Run", "status": "running"}, {"text": "Wait", "status": "needs you"}, {"text": "Next"}],
                             now="2026-10-09T10:00:00+00:00")
    assert [(s["id"], s["status"], s["started"]) for s in made] == [("s1", "running", "2026-10-09T10:00:00+00:00"),
                                                                     ("s2", "needs you", None), ("s3", "not started", None)]


async def test_a_steps_details_are_stored_served_and_read(group):
    details = "The image caches every meson subproject pandas downloads.\nSo the agents build offline."
    cid = _cid(await call("add_card", group, kind="plan", question="Plan: build it",
                          steps=[STEPS[0], {**STEPS[1], "details": details}, STEPS[2]]))
    assert notebook.plan_steps(_cell(cid))[1]["details"] == details
    assert notebook.plan_steps(_cell(cid))[0]["details"] == ""
    served = await notebook.canvas_route(CORPUS)
    cell = next(c for c in served["cells"] if c["id"] == cid)
    assert cell["payload"]["steps"][1]["details"] == details
    read = (await call("read_ref", group, ref=f"card:{cid}")).text
    assert "   details: The image caches every meson subproject pandas downloads." in read
    assert "   details: So the agents build offline." in read
    step = (await call("read_ref", group, ref=f"card:{cid}#step-2")).text
    assert "details: So the agents build offline." in step
    assert "details: The image caches" in context.canvas(CORPUS)
    ps = canvas_comments.passages(CORPUS)
    assert "details: The image caches" in canvas_comments.card_lines(CORPUS, [p["ref"] for p in ps], ps)
    # a check reads a step again once its details change, and a step without details keeps its fingerprint
    fps = {p["ref"]: p["fp"] for p in ps}
    await call("edit_card", group, card=f"card:{cid}", steps=[STEPS[0], {**STEPS[1], "details": "Changed."}, STEPS[2]])
    after = {p["ref"]: p["fp"] for p in canvas_comments.passages(CORPUS)}
    assert after[f"card:{cid}#step-2"] != fps[f"card:{cid}#step-2"]
    assert after[f"card:{cid}#step-1"] == fps[f"card:{cid}#step-1"]


async def test_an_edit_that_changes_the_plan_marks_what_changed_until_the_next_such_edit_or_the_analyst_clears_it(group):
    cid = await _plan(group)
    assert plans.LAST_EDIT not in _cell(cid)["payload"], "a plan as made has nothing marked"
    fp = canvas_comments._card_fp(_cell(cid))
    # the analyst's feedback: a step put in before step 2, step 2 makes more, the pilot dropped
    res = await call("edit_card", group, card=f"card:{cid}", steps=[
        STEPS[0], {"text": "Write the prompts", "makes": ["prompts/"]}, {**STEPS[1], "makes": ["Dockerfile.agent", "wheelhouse/"]}])
    assert not res.is_error, res.text
    marks = _cell(cid)["payload"][plans.LAST_EDIT]
    assert marks["steps"] == {"s4": {"new": True}, "s2": {"was": {"makes": ["Dockerfile.agent"]}}}
    assert marks["removed"] == [{"id": "s3", "text": STEPS[2]["text"], "makes": ["pilot/"]}] and marks["ts"]
    served = await notebook.canvas_route(CORPUS)
    assert next(c for c in served["cells"] if c["id"] == cid)["payload"][plans.LAST_EDIT] == marks
    # an edit of progress alone (a status, a note) keeps the marks of the last change
    steps = [{"text": s["text"]} for s in notebook.plan_steps(_cell(cid))]
    await call("edit_card", group, card=f"card:{cid}", steps=[{**steps[0], "status": "running", "note": "cloning"}, *steps[1:]])
    assert _cell(cid)["payload"][plans.LAST_EDIT] == marks
    # the next edit that changes the plan replaces them with its own: a step reworded keeps its old text
    await call("edit_card", group, card=f"card:{cid}", steps=[steps[0], {"text": "Write the prompts for both conditions"}, steps[2]])
    assert _cell(cid)["payload"][plans.LAST_EDIT]["steps"] == {"s4": {"was": {"text": "Write the prompts"}}}
    assert _cell(cid)["payload"][plans.LAST_EDIT]["removed"] == []
    # the marks are no part of what a check reads of the card
    assert canvas_comments._card_fp(_cell(cid)) == fp
    # Clear marks takes them off with no edit of the card, once
    edits = len(_cell(cid).get("edited") or [])
    assert plans.clear_edit_route(CORPUS, cid) == {"cleared": True}
    assert plans.LAST_EDIT not in _cell(cid)["payload"] and len(_cell(cid).get("edited") or []) == edits
    assert [s["text"] for s in notebook.plan_steps(_cell(cid))][1] == "Write the prompts for both conditions"
    assert plans.clear_edit_route(CORPUS, cid) == {"cleared": False}
    note = _cid(await call("add_card", group, kind="note", question="A note", text="Hello."))
    with pytest.raises(Exception) as e:
        plans.clear_edit_route(CORPUS, note)
    assert getattr(e.value, "status_code", None) == 404


def test_edit_marks_match_steps_by_id_and_mark_nothing_for_progress_alone():
    old = notebook.plan_steps_of([{"id": "s1", "text": "Mirror", "makes": ["mirror/"]}, {"id": "s2", "text": "Build"}])
    assert plans.edit_marks(old, [{**old[0], "status": "done", "note": "6 repos"}, old[1]]) is None
    got = plans.edit_marks(old, [{**old[0], "details": "Every PR head."}, {"id": "s3", "text": "Pilot"}], now="t")
    assert got == {"ts": "t", "steps": {"s1": {"was": {"details": ""}}, "s3": {"new": True}},
                   "removed": [{"id": "s2", "text": "Build", "makes": []}]}


async def test_the_next_phase_is_a_new_plan_that_follows_the_last(group):
    first = await _plan(group)
    for n in (1, 2, 3):
        await call("edit_card", group, card=f"card:{first}", steps=[{**s, "status": "done"} for s in STEPS[:n]] + STEPS[n:])
    assert {s["status"] for s in notebook.plan_steps(_cell(first))} == {"done"}
    before = _cell(first)
    # the caller's own group is another one, where a card that names no group would land
    other = notebook.create_notebook(config.workspace_dir(CORPUS), "Elsewhere", role="analyst")["id"]
    res = await call("add_card", other, kind="plan", question="Plan: run the experiment",
                     steps=[{"text": "Run the emergent condition", "makes": ["runs/emergent/"]}], follows=f"card:{first}")
    second = _cid(res)
    cell = _cell(second)
    assert cell["payload"]["follows"] == first
    assert cell["notebook"] == before["notebook"], "it lands in the group of the plan it follows"
    nb = notebook.read_notebook(config.workspace_dir(CORPUS), before["notebook"])
    assert [c["id"] for c in nb["cells"]][-1] == second, "at the end of that group"
    assert _cell(first)["payload"] == before["payload"], "the finished plan stays as it was"
    read_first = await call("read_ref", group, ref=f"card:{first}")
    assert f"followed by: card:{second}" in read_first.text
    read_second = await call("read_ref", group, ref=f"card:{second}")
    assert f"follows: card:{first}" in read_second.text
    # `follows` must name a plan
    note = _cid(await call("add_card", group, kind="note", question="A note", text="x"))
    res = await call("add_card", group, kind="plan", question="Plan", steps=STEPS, follows=f"card:{note}")
    assert res.is_error and "plan card" in res.text
    res = await call("add_card", group, kind="plan", question="Plan", steps=STEPS, follows="card:nope")
    assert res.is_error and "no card" in res.text


async def test_read_ref_list_cards_the_canvas_context_and_the_writer_read_the_steps(group):
    cid = await _plan(group)
    await call("edit_card", group, card=f"card:{cid}", steps=_with(1, status="done", note="mirrored"))
    read = (await call("read_ref", group, ref=f"card:{cid}")).text
    assert f"card:{cid} (group {group}, plan)" in read
    assert "steps:" in read and "1. [done] Mirror pandas" in read and "2. [not started] Build the agent container" in read
    assert "takeaway:" not in read
    listed = (await call("list_cards", group, group="all")).text
    assert f"card:{cid} [plan]" in listed and "1 of 3 steps done" in listed
    ctx = context.canvas(CORPUS)
    assert f"card:{cid} · plan" in ctx and "  1. [done] Mirror pandas" in ctx and "     note: mirrored" in ctx
    row = next(r for r in material.notebook_cells(CORPUS, ("analyst",)) if r["id"] == cid)
    assert "3. [not started] Pilot" in row["text"]
    assert "2. [not started] Build the agent container" in concepts.cell_text(_cell(cid)), "a label over cards reads the steps"
    step = (await call("read_ref", group, ref=f"card:{cid}#step-2")).text
    assert f"span card:{cid}#step-2: 2. [not started] Build the agent container" in step


def test_a_step_ref_parses_formats_and_resolves(group, mini_dir):
    p = refs.parse_ref("card:abc123#step-2")
    assert p == {"kind": "cell", "cell_id": "abc123", "exec": None, "step": 2}
    assert refs.format_ref(p) == "card:abc123#step-2"
    assert refs.parse_ref("cell:abc123#step-2")["step"] == 2
    ws = config.workspace_dir(CORPUS)
    cell = notebook.insert_cell(CORPUS, group, notebook.new_cell("plan", "chat:x", "Plan", group, payload={"steps": STEPS}))
    res = refs.resolve(config.corpus_dir(CORPUS), f"card:{cell['id']}#step-3")
    assert res["meta"]["span"] == {"step": 3, "id": "s3", "text": "3. [not started] Pilot: 2 agents, one PR each → pilot/"}
    gone = refs.resolve(config.corpus_dir(CORPUS), f"card:{cell['id']}#step-9")
    assert gone["meta"]["span_missing"] is True
    assert ws.is_dir()


def test_the_store_keeps_step_ids_and_fills_missing_ones():
    steps = notebook.plan_steps_of([{"id": "s2", "text": "b"}, {"text": "a"}, "c", {"id": "s2", "text": "d"}, 7])
    assert [s["id"] for s in steps] == ["s2", "s1", "s3", "s4"]
    assert [s["text"] for s in steps] == ["b", "a", "c", "d"]
    assert notebook.plan_status_of("needs_you") == "needs you" and notebook.plan_status_of("Running") == "running"
    assert notebook.plan_status_of("later") is None
    p = notebook._payload_of("plan", {"steps": [{"text": "x", "status": "bogus"}], "follows": "card:abc"})
    assert p["steps"][0]["status"] == "not started" and p["follows"] == "abc"


def test_the_card_route_refuses_a_plans_takeaway(group):
    cell = notebook.insert_cell(CORPUS, group, notebook.new_cell("plan", "chat:x", "Plan", group, payload={"steps": STEPS}))
    with pytest.raises(Exception) as e:
        notebook.edit_cell(CORPUS, cell["id"], takeaway="Done.")
    assert getattr(e.value, "status_code", None) == 400
    assert notebook.append_takeaway(CORPUS, cell["id"], "Done.") is False
    assert _cell(cell["id"])["takeaway"] == ""


def _subagent(title: str, *, created: datetime, status: str = "running", records: list[dict] | None = None,
              ended: datetime | None = None) -> str:
    """A chat of one of main's Agent calls, as session.py's mirror makes it (agents.new_agent, role subagent)."""
    meta = agents.new_agent(CORPUS, plans.SUBAGENT_ROLE, title, announce=False)
    fields = {"created_at": created.isoformat(timespec="milliseconds"), "status": status}
    if ended:
        fields["ts_end"] = ended.isoformat(timespec="milliseconds")
    agents.update_agent(CORPUS, meta["id"], **fields)
    _, log_path = agents.paths(CORPUS, meta["id"])
    for r in records or []:
        agents.append(log_path, r)
    return str(meta["id"])


async def test_plan_runs_match_a_steps_runs_to_mains_subagent_chats(group):
    cid = await _plan(group)
    now = datetime.now(timezone.utc)
    _subagent("Run the emergent condition", created=now - timedelta(hours=3), status="done", ended=now - timedelta(hours=2))
    newest = _subagent("Run the emergent condition", created=now - timedelta(minutes=40), records=[
        {"type": "text", "delta": "Starting 48 agents.\nmore"},
        {"type": "tool_use", "name": "Bash", "input": {"command": "swarmctl status runs/emergent", "description": "Check the run"}},
    ])
    done = _subagent("Run the managed condition", created=now - timedelta(minutes=30), status="done",
                     ended=now - timedelta(minutes=10), records=[{"type": "done", "result": "48 agents ran.\nDetails"}])
    await call("edit_card", group, card=f"card:{cid}", steps=_with(1, status="running",
                                                                   runs=["Run the emergent condition", "run the  managed condition"]))
    await call("edit_card", group, card=f"card:{cid}", steps=_with(2, runs=["Not started yet"]))
    rows = plans.plan_runs(CORPUS, cid)
    assert [(r["step"], r["name"]) for r in rows] == [(1, "Run the emergent condition"), (1, "run the managed condition"),
                                                      (2, "Not started yet")]
    assert rows[0]["chat"] == newest and rows[0]["state"] == "running" and rows[0]["elapsed"] == "40 m"
    assert rows[0]["latest"] == "Bash Check the run"
    assert rows[1]["chat"] == done and rows[1]["state"] == "done" and rows[1]["elapsed"] == "20 m"
    assert rows[1]["latest"] == "48 agents ran."
    assert rows[2]["chat"] is None and rows[2]["state"] == "not started"
    note = _cid(await call("add_card", group, kind="note", question="A note", text="x"))
    with pytest.raises(Exception) as e:
        plans.plan_runs(CORPUS, note)
    assert getattr(e.value, "status_code", None) == 404


def test_latest_event_reads_the_last_call_or_text():
    assert plans.latest_event([{"type": "tool_use", "name": "mcp__plugin_thimble_thimble__add_card", "input": "{\"question\": \"Q?\"}"},
                               {"type": "tool_result"}]) == "add_card"
    assert plans.latest_event([{"type": "tool_use", "name": "Read", "input": {"file_path": "/a/b.py"}}]) == "Read /a/b.py"
    assert plans.latest_event([]) == ""
    long = plans.latest_event([{"type": "text", "delta": "x" * 500}])
    assert len(long) == plans.LATEST_CHARS and long.endswith("…")
