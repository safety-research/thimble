"""Comments on the canvas (canvas_comments.py, checks.py's run target CANVAS): a check that covers the cards runs at
main's turn end on the cards it has not seen, as a follow-on start through thimble's module, with a task file that
lists the cards and a plan card's steps; its add_comment takes a covered card or step and stores the comment's
statement (`text`) and its `details`; Done hides a comment, and one resolved as known before 0.7.0 reads as resolved; a
run's end supersedes its check's earlier comments on what it covered; main's run_check with `on: cards` gives the exact
Agent call. A workspace that stored Important details under its former id keeps its check and its comments. The
built-ins, Judgment calls, Unverifiable and Important details, each cover the documents and the cards; only Important
details is on until the analyst turns a check on or off, and these tests turn the other two off as the analyst would.
The module is the fake bridge (subagent_fakes); an agent's end is subagents.run_ended. A plan card is the plan kind,
its steps in payload.steps."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import canvas_comments, checks, config, context, investigation, notebook, report_types, subagents, tools
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
IMPORTANT = "important-details"


@pytest.fixture()
def board(workspaces_tmp, monkeypatch):
    """Settings' checks row, with Important details on (it covers the documents and the cards) and the other built-ins
    turned off."""
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    checks.edit(CORPUS, IMPORTANT, shown=True)
    for cid in ("judgment", "unverified"):
        checks.edit(CORPUS, cid, shown=False)


def _card(title: str, *, group: str = notebook.MAIN, takeaway: str = "", steps: list[dict] | None = None) -> str:
    """A note card, or with `steps` a plan card (notebook.PLAN_KIND) holding them."""
    if steps is not None:
        cell = notebook.new_cell(notebook.PLAN_KIND, "model", title, notebook=group, payload={"steps": steps})
    else:
        cell = notebook.new_cell("note", "model", title, notebook=group, payload={"text": title})
    notebook.insert_cell(CORPUS, group, cell)
    if takeaway:
        nb = notebook.load_notebook(CORPUS, group)
        next(c for c in nb["cells"] if c["id"] == cell["id"])["takeaway"] = takeaway
        notebook.save_notebook(CORPUS, nb)
    return cell["id"]


def _steps(*statuses: str) -> list[dict]:
    texts = ["Mirror pandas into a local GitHub", "Build the agent container", "Pilot: 2 agents, one PR each"]
    return [{"id": f"s{i + 1}", "text": texts[i], "makes": [], "status": s} for i, s in enumerate(statuses)]


def _run(cid: str = IMPORTANT) -> dict:
    return ((checks.read(CORPUS, cid) or {}).get("runs") or {}).get(checks.CANVAS) or {}


async def _until(cond, what: str) -> None:
    for _ in range(300):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


async def _turn_ended(since: str | None = "2000-01-01T00:00:00+00:00") -> checks._Active:
    """Main's turn ended; the run of Important details starts on the cards, once its agent has started through the
    module."""
    checks.main_turn_ended(CORPUS, since)
    await _until(lambda: (CORPUS, IMPORTANT, checks.CANVAS) in checks._active, "no run started at main's turn end")
    act = checks._active[(CORPUS, IMPORTANT, checks.CANVAS)]
    await _until(lambda: act.agent or act.ended, "the run's agent never started")
    return act


def _last(res) -> str:
    """A tool's result without the line that echoes its call."""
    return res.text.strip().splitlines()[-1]


async def _comment(act: checks._Active, ref: str, text: str, tid: str, details: str | None = None):
    sf.add_caller(config.workspace_dir(CORPUS), tid, act.agent, "thimble:check")
    args = {"ref": ref, "text": text, **({"details": details} if details is not None else {})}
    return await tools.call(CORPUS, "add_comment", args, session=checks.session_key(IMPORTANT, checks.CANVAS), tool_use_id=tid)


def test_the_built_ins_are_three_checks_over_the_documents_and_the_cards_and_only_important_details_is_on(
        workspaces_tmp):
    """0.7.0: Judgment calls, Unverifiable and Important details, in that order, each covering the documents and the
    cards, and since 0.9.0 Claude's answers; Verified is no built-in any more, so a new workspace does not list it. Only
    Important details is on until the analyst turns a check on or off (feedback on 0.8.0: "don't expose comments other
    than important details by default")."""
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    listed = checks.list_checks(CORPUS)
    assert [(c["id"], c["name"]) for c in listed] == [("judgment", "Judgment calls"), ("unverified", "Unverifiable"),
                                                      (IMPORTANT, "Important details")]
    assert [(c["id"], c["shown"]) for c in listed] == [("judgment", False), ("unverified", False), (IMPORTANT, True)]
    for c in listed:
        assert c["builtin"] is True and c["covers"] == ["documents", "cards", "answers"], c
        want = open(config.REPO_ROOT / "prompts" / "checks" / f"{c['id']}.md", encoding="utf-8").read()
        assert c["prompt"] == want.split("\n---\n", 1)[1].strip() and c["prompt"].endswith("If you are unsure, leave no comment.")
    assert checks.read(CORPUS, IMPORTANT)["prompt"].startswith("Comment on a passage only when the reader would likely miss")
    assert checks.read(CORPUS, "verified") is None and checks.by_name(CORPUS, "Verified") is None


async def test_a_workspace_s_check_and_comments_stored_under_important_details_former_id_read_as_important_details(
        workspaces_tmp):
    """A workspace from before stored Important details under its former id: the check's file and the comments on a
    document and on the cards that name it. They read as `important-details`, its file renamed when the checks are read,
    and the comments are written so on their store's next write."""
    former = "you-should-know"
    assert checks.FORMER_IDS == {former: IMPORTANT}
    ws = config.workspace_dir(CORPUS)
    ws.mkdir(parents=True, exist_ok=True)
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": "# R\n\n## One\n\nAll the saves came "
                                                    "from one bot.\n"}, actor="analyst")
    assert not r.is_error, r.text
    for p in (ws / checks.DIR).iterdir():  # the save stored the built-ins, on in a new workspace; that one stored none
        p.unlink()
    path = report_types.doc_file(CORPUS, investigation.MAIN, "report")
    raw = json.loads(path.read_text())
    sid = report_types.all_sentences(raw)[0]["id"]
    raw["comments"] = [{"id": "c1", "sentence_id": sid, "check": former, "author": "check", "run": "r1",
                        "text": "The bot is the importer.", "details": "It runs nightly.", "status": "open"}]
    path.write_text(json.dumps(raw))
    card = _card("Who saved the pages?")
    canvas_comments._path(CORPUS).write_text(json.dumps({"comments": [
        {"id": "k1", "card": card, "step": None, "check": former, "run": "r1", "author": "check",
         "text": "Blocking the web also blocks GitHub.", "details": "", "ts": "", "status": "open"}]}))
    run = {"run": "r1", "status": "done", "comments": 1, "seen": ["abc"]}
    (ws / checks.DIR).mkdir(exist_ok=True)
    (ws / checks.DIR / f"{former}.json").write_text(json.dumps({
        "id": former, "name": "You should know", "prompt": checks.builtin(IMPORTANT)["prompt"], "colour": 2,
        "shown": True, "builtin": True, "covers": ["documents", "cards"], "created_by": "thimble", "ts": "",
        "version": 1, "runs": {"report": run}}))

    listed = checks.list_checks(CORPUS)
    assert [x["id"] for x in listed] == ["judgment", "unverified", IMPORTANT]
    got = listed[2]
    assert (got["name"], got["colour"], got["shown"], got["covers"]) == ("Important details", 2, True,
                                                                         ["documents", "cards", "answers"])
    assert got["runs"]["report"] == run, "its runs stay"
    assert sorted(p.name for p in (ws / checks.DIR).iterdir()) == [f"{IMPORTANT}.json"], "its file is renamed"
    assert json.loads((ws / checks.DIR / f"{IMPORTANT}.json").read_text())["id"] == IMPORTANT
    assert checks.read(CORPUS, former)["id"] == IMPORTANT
    assert checks.names(CORPUS) == {"judgment": "Judgment calls", "unverified": "Unverifiable",
                                    IMPORTANT: "Important details"}

    doc = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    assert [cm["check"] for cm in doc["comments"]] == [IMPORTANT]
    report_types.write_doc(CORPUS, investigation.MAIN, "report", doc)
    assert [cm["check"] for cm in json.loads(path.read_text())["comments"]] == [IMPORTANT], "written so on its save"

    (cm,) = canvas_comments.all_comments(CORPUS)
    assert (cm["check"], cm["text"]) == (IMPORTANT, "Blocking the web also blocks GitHub.")
    assert " · Important details · " in canvas_comments.line(CORPUS, cm)
    canvas_comments.resolve(CORPUS, ["k1"])
    stored = json.loads(canvas_comments._path(CORPUS).read_text())["comments"]
    assert [x["check"] for x in stored] == [IMPORTANT], "written so on the store's next write"


async def test_main_s_turn_end_runs_important_details_on_the_unseen_cards_with_a_task_file(board, bridge):
    old = _card("What did the pilot show?", takeaway="Both agents merged their PR.")
    orientation = notebook.create_notebook(config.workspace_dir(CORPUS), "Orientation", role="exploration")
    deck = _card("How many messages are there?", group=orientation["id"])
    plan = _card("Plan: build the environment and pilot it", steps=_steps("done", "running", "not started"))
    act = await _turn_ended()
    [spawn] = bridge.ops("spawn")
    assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
    assert spawn["role"] == "check" and spawn["what"] == f"{IMPORTANT} on {checks.CANVAS}"
    covered = set(_run()["covered"])
    assert {f"card:{old}", f"card:{plan}", f"card:{plan}#step-1", f"card:{plan}#step-3"} <= covered
    assert not any(deck in r for r in covered), "the orientation's deck has its own critic"
    task = (checks.work_dir(CORPUS, IMPORTANT, checks.CANVAS) / checks.TASK_FILE).read_text()
    assert "Comment on a passage only when the reader would likely miss" in task
    assert f"- card:{plan} · plan · Plan: build the environment and pilot it" in task
    assert f"card:{plan}#step-2 · running · Build the agent container" in task
    assert "takeaway: Both agents merged their PR." in task
    subagents.run_ended(CORPUS, act.agent, "done", "No comment clears the bar.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    assert len(_run()["seen"]) == len(covered)
    checks.main_turn_ended(CORPUS, "2000-01-01T00:00:00+00:00")
    await asyncio.sleep(0.05)
    assert len(bridge.ops("spawn")) == 1, "nothing unseen: no run"


async def test_add_comment_takes_a_covered_card_or_step_and_stores_its_statement_and_details(board, bridge):
    plan = _card("Plan: build the environment and pilot it", steps=_steps("not started", "not started", "not started"))
    act = await _turn_ended()
    res = await _comment(act, f"card:{plan}#step-2", "Blocking the web also blocks GitHub.", "toolu_k1",
                         details="- The pandas build downloads two of its libraries from GitHub [[card:" + plan + "]].\n"
                                 "- Bake them into the image.   \n\n\n\nOr allow github.com.")
    assert not res.is_error and _last(res) == f"commented on card:{plan}#step-2"
    res = await _comment(act, f"card:{plan}", "Important details: the pilot only tests the emergent prompt.", "toolu_k2")
    assert not res.is_error, res.text
    res = await _comment(act, "card:nosuchcard", "X.", "toolu_k3")
    assert res.is_error and "no card" in res.text
    [on_step, on_card] = canvas_comments.open_comments(CORPUS)
    assert (on_step["step"], on_step["n"], on_step["ref"]) == ("s2", 2, f"card:{plan}#step-2")
    assert on_step["text"] == "Blocking the web also blocks GitHub." and on_step["check"] == IMPORTANT
    # the details keep their lines and their citations, which show as chips; a run of blank lines is one
    assert on_step["details"] == ("- The pandas build downloads two of its libraries from GitHub [[card:" + plan + "]].\n"
                                  "- Bake them into the image.\n\nOr allow github.com.")
    assert on_step["evidence"] == f"card:{plan}"
    assert (on_card["text"], on_card["details"]) == ("The pilot only tests the emergent prompt.", ""), \
        "its check's name shows once, in the head"
    subagents.run_ended(CORPUS, act.agent, "done", "Two comments.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    assert _run()["comments"] == 2
    lines = (await tools.call(CORPUS, "read_ref", {"ref": f"card:{plan}"})).text
    assert (f"comment {on_step['id']} on card:{plan}#step-2 · Important details · Blocking the web also blocks GitHub. — "
            "- The pandas build downloads") in lines
    assert f"comment {on_card['id']} on card:{plan} · Important details · The pilot only tests" in context.canvas(CORPUS)


async def test_done_hides_a_comment_and_one_resolved_as_known_before_reads_as_resolved(board, bridge):
    """Done is the one way the analyst resolves a comment. A comment resolved as `known` (Know it, before 0.7.0) stays
    resolved: it is not served as open, a run's task does not list it, and it opens again as any resolved one does."""
    a = _card("Which condition merged more PRs?")
    b = _card("Did any agent still fail to build?")
    act = await _turn_ended()
    await _comment(act, f"card:{a}", "The merged counts aren't fully comparable.", "toolu_d1",
                   details="Six agents could not build their PR.")
    await _comment(act, f"card:{b}", "Each agent builds pandas on 1 CPU.", "toolu_d2")
    one, two = canvas_comments.open_comments(CORPUS)
    got = await canvas_comments.resolve_route(CORPUS, one["id"])
    assert [c["id"] for c in got["comments"]] == [two["id"]], "a comment marked done does not show"
    assert next(x for x in canvas_comments._read(CORPUS) if x["id"] == one["id"])["resolution"] == "done"
    with pytest.raises(Exception):
        await canvas_comments.resolve_route(CORPUS, one["id"])  # no open comment of that id

    def known(items):  # as Know it left it before 0.7.0
        for x in items:
            if x["id"] == two["id"]:
                x.update(status="dismissed", resolution="known", resolved_by="analyst", resolved_ts="2026-10-01T00:00:00+00:00")

    canvas_comments._change(CORPUS, known)
    assert (await canvas_comments.list_route(CORPUS))["comments"] == []
    subagents.run_ended(CORPUS, act.agent, "done", "Two comments.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    notebook.edit_cell(CORPUS, b, title="Did any agent still fail to build, per condition?", by="model")
    await _turn_ended()
    task = (checks.work_dir(CORPUS, IMPORTANT, checks.CANVAS) / checks.TASK_FILE).read_text()
    assert "Each agent builds pandas on 1 CPU." not in task and "know" not in task.lower().split("## ")[-1]
    canvas_comments.reopen(CORPUS, [two["id"]])
    assert [c["id"] for c in canvas_comments.open_comments(CORPUS)] == [two["id"]]


async def test_a_run_s_end_supersedes_its_check_s_comments_on_the_cards_it_covered(board, bridge):
    a = _card("Which condition merged more PRs?", takeaway="Managed merged more.")
    b = _card("Did any agent still fail to build?")
    first = await _turn_ended()
    await _comment(first, f"card:{a}", "The counts aren't comparable.", "toolu_s1")
    await _comment(first, f"card:{b}", "Six agents could not build.", "toolu_s2")
    subagents.run_ended(CORPUS, first.agent, "done", "Two.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    notebook.edit_cell(CORPUS, a, title="Which condition merged more PRs, per agent?", by="model")
    second = await _turn_ended()
    assert _run()["covered"] == [f"card:{a}"]
    subagents.run_ended(CORPUS, second.agent, "done", "Nothing new.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    [left] = canvas_comments.open_comments(CORPUS)
    assert left["card"] == b, "the changed card's comment is superseded, the other stays"
    gone = next(c for c in canvas_comments._read(CORPUS) if c["card"] == a)
    assert (gone["status"], gone["resolution"], gone["superseded_by"]) == ("dismissed", "superseded", second.run)


async def test_run_check_on_the_cards_gives_the_exact_agent_call(board, bridge):
    _card("A card")
    res = await tools.call(CORPUS, "run_check", {"name": "Risks", "instructions": "Mark the risky cards.", "on": "cards"},
                           tool_use_id="toolu_main1")
    assert not res.is_error, res.text
    assert "check Risks started (new) on the cards, 1 passage" in res.text
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    assert inp["subagent_type"] == "thimble:check" and not bridge.ops("spawn")
    req = subagents.request(CORPUS, sf.REQUEST_RE.search(inp["prompt"].split("\n", 1)[0]).group(0))
    assert (req["route"], req["call"]) == ("typed", "toolu_main1")
    risks = checks.by_name(CORPUS, "Risks")
    assert risks["covers"] == ["cards"] and risks["shown"]
    res = await tools.call(CORPUS, "run_check", {"name": "Risks", "on": "pages"})
    assert res.is_error and "`on` is one of documents, cards" in res.text


def test_main_s_turn_end_in_the_mirror_asks_the_checks_over_the_cards(board, monkeypatch):
    from app import session

    heard = []
    monkeypatch.setattr(checks, "main_turn_ended", lambda c, since=None: heard.append((c, since)))
    lv = session.Live(CORPUS, "sid", str(config.workspace_dir(CORPUS)), None, None)
    session._open_turn(lv)
    since = lv.turn_since
    session._end_turn(lv)
    session._end_turn(lv)
    assert heard == [(CORPUS, since)], "once per turn, from the turn's start"
