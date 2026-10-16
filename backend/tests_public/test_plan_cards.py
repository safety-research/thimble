"""Plan cards: add_card's `plan` kind stores numbered steps with stable ids and no takeaway; edit_card changes a step's
status and stamps its times, and replaces a plan's steps at any time, each step it keeps keeping its id, its clock while
its text is unchanged, its runs and its comments. Called through tools.call as main's browser chat, as the other card
tools' tests are."""
from __future__ import annotations

import re

import pytest

from app import canvas_comments, config, notebook, plans, tools

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
