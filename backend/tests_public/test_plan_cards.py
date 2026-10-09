"""Plan cards: add_card's `plan` kind stores numbered steps with stable ids and no takeaway, update_plan changes one step
and stamps its times, edit_card keeps a started plan's steps, the next phase is a new plan that `follows` the last, and
read_ref, list_cards, the canvas context and refs read the steps. plan_runs matches a step's runs to main's subagent
chats. Called through tools.call as main's browser chat, as the other card tools' tests are."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import pytest

from app import agents, concepts, config, context, material, notebook, plans, refs, tools

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


async def test_update_plan_changes_one_step_and_stamps_its_times(group):
    cid = await _plan(group)
    res = await call("update_plan", group, card=f"card:{cid}", step=1, status="running", runs=["Mirror pandas"])
    assert not res.is_error, res.text
    assert res.text.splitlines()[1] == f"card:{cid}"
    s1 = notebook.plan_steps(_cell(cid))[0]
    assert s1["status"] == "running" and s1["started"] and s1["ended"] is None and s1["runs"] == ["Mirror pandas"]
    assert re.search(r"^1\. \[running · \d+ s\] Mirror pandas", res.text, re.M), res.text
    res = await call("update_plan", group, card=f"card:{cid}", step="1", status="Done", note="6 repos mirrored")
    s1 = notebook.plan_steps(_cell(cid))[0]
    assert s1["status"] == "done" and s1["ended"] and s1["note"] == "6 repos mirrored"
    assert "note: 6 repos mirrored" in res.text
    # the step's id and the others stay as they were
    steps = notebook.plan_steps(_cell(cid))
    assert [s["id"] for s in steps] == ["s1", "s2", "s3"] and steps[1]["status"] == "not started"
    # a step ref names the step too, and `time` overrides thimble's count
    res = await call("update_plan", group, card=f"card:{cid}#step-3", status="needs you", time="22 m")
    assert not res.is_error, res.text
    assert notebook.plan_steps(_cell(cid))[2]["status"] == "needs you"
    assert "3. [needs you · 22 m] Pilot" in res.text
    # every change is an edit of the card by its caller
    assert len(_cell(cid)["edited"]) == 3


async def test_update_plan_refuses_an_unknown_step_a_bad_status_a_locked_card_and_a_card_that_is_no_plan(group):
    cid = await _plan(group)
    res = await call("update_plan", group, card=f"card:{cid}", step=4, status="done")
    assert res.is_error and res.text.endswith(tools.hint("plan-step-unknown", cid=cid, step=4, count=3))
    res = await call("update_plan", group, card=f"card:{cid}", step=0, status="done")
    assert res.is_error
    res = await call("update_plan", group, card=f"card:{cid}", step=1, status="finished")
    assert res.is_error and "needs you" in res.text
    res = await call("update_plan", group, card=f"card:{cid}", step=1)
    assert res.is_error and "`status`" in res.text
    note = _cid(await call("add_card", group, kind="note", question="A note", text="x"))
    res = await call("update_plan", group, card=f"card:{note}", step=1, status="done")
    assert res.is_error and "not a plan" in res.text
    notebook.edit_cell(CORPUS, cid, locked=True)
    res = await call("update_plan", group, card=f"card:{cid}", step=1, status="done")
    assert res.is_error and res.text.endswith(tools.hint("card-locked", cid=cid))
    assert notebook.plan_steps(_cell(cid))[0]["status"] == "not started"


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


async def test_edit_card_replaces_steps_until_one_starts_then_refuses(group):
    cid = await _plan(group)
    res = await call("edit_card", group, card=f"card:{cid}", steps=[*STEPS, {"text": "Write the prompts", "makes": ["prompts/"]}])
    assert not res.is_error, res.text
    assert len(notebook.plan_steps(_cell(cid))) == 4
    res = await call("edit_card", group, card=f"card:{cid}", takeaway="Four steps.")
    assert res.is_error and "takeaway" in res.text
    assert _cell(cid)["takeaway"] == ""
    await call("update_plan", group, card=f"card:{cid}", step=1, status="running")
    res = await call("edit_card", group, card=f"card:{cid}", steps=STEPS[:1])
    assert res.is_error and res.text.endswith(tools.hint("plan-started", cid=cid))
    assert len(notebook.plan_steps(_cell(cid))) == 4
    # its question can still change
    res = await call("edit_card", group, card=f"card:{cid}", question="Plan: build it")
    assert not res.is_error and _cell(cid)["title"] == "Plan: build it"


async def test_the_next_phase_is_a_new_plan_that_follows_the_last(group):
    first = await _plan(group)
    for n in (1, 2, 3):
        await call("update_plan", group, card=f"card:{first}", step=n, status="done")
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
    await call("update_plan", group, card=f"card:{cid}", step=1, status="done", note="mirrored")
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
    await call("update_plan", group, card=f"card:{cid}", step=1, status="running",
               runs=["Run the emergent condition", "run the  managed condition"])
    await call("update_plan", group, card=f"card:{cid}", step=2, runs=["Not started yet"])
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
