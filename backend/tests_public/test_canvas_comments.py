"""Comments on the canvas (canvas_comments.py, checks.py's run target CANVAS): a check that covers the cards runs at
main's turn end on the cards it has not seen, as a follow-on start through thimble's module, with a task file that
lists the cards, a plan card's steps and what the analyst marked Know it; its add_comment takes a covered card or step
and stores the comment's tag, title and body; Done and Know it hide a comment; a run's end supersedes its check's
earlier comments on what it covered; a deleted card's comments are not served; main's run_check with `on: cards` gives
the exact Agent call, and main's own add_comment on a card is Claude's note. "You should know" is a built-in, on, that
covers the documents and the cards. The module is the fake bridge (subagent_fakes); an agent's end is
subagents.run_ended. A plan card is the plan kind, its steps in payload.steps."""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone

import pytest

from app import canvas_comments, checks, config, context, investigation, notebook, report_types, subagents, tools
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
YSK = "you-should-know"


@pytest.fixture()
def board(workspaces_tmp, monkeypatch):
    """Settings' checks row, with You should know as thimble ships it (on, on the documents and the cards)."""
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)


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


def _run(cid: str = YSK) -> dict:
    return ((checks.read(CORPUS, cid) or {}).get("runs") or {}).get(checks.CANVAS) or {}


async def _until(cond, what: str) -> None:
    for _ in range(300):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


async def _turn_ended(since: str | None = "2000-01-01T00:00:00+00:00") -> checks._Active:
    """Main's turn ended; the run You should know starts on the cards, once its agent has started through the module."""
    checks.main_turn_ended(CORPUS, since)
    await _until(lambda: (CORPUS, YSK, checks.CANVAS) in checks._active, "no run started at main's turn end")
    act = checks._active[(CORPUS, YSK, checks.CANVAS)]
    await _until(lambda: act.agent or act.ended, "the run's agent never started")
    return act


def _last(res) -> str:
    """A tool's result without the line that echoes its call."""
    return res.text.strip().splitlines()[-1]


async def _comment(act: checks._Active, ref: str, text: str, tid: str):
    sf.add_caller(config.workspace_dir(CORPUS), tid, act.agent, "thimble:check")
    return await tools.call(CORPUS, "add_comment", {"ref": ref, "text": text},
                            session=checks.session_key(YSK, checks.CANVAS), tool_use_id=tid)


def test_you_should_know_is_a_built_in_that_is_on_and_covers_the_documents_and_the_cards(board):
    ysk = checks.read(CORPUS, YSK)
    assert ysk["name"] == "You should know" and ysk["shown"] is True and ysk["builtin"] is True
    assert ysk["covers"] == ["documents", "cards"]
    want = open(config.REPO_ROOT / "prompts" / "checks" / f"{YSK}.md", encoding="utf-8").read().split("\n---\n", 1)[1]
    assert ysk["prompt"] == want.strip() and ysk["prompt"].startswith("Leave a comment on a passage only when")
    assert [c["id"] for c in checks.list_checks(CORPUS)][:4] == ["unverified", "verified", "judgment", YSK]
    for cid in ("unverified", "verified", "judgment"):
        assert checks.read(CORPUS, cid)["covers"] == ["documents"] and not checks.read(CORPUS, cid)["shown"]


def test_a_comment_s_tag_title_and_body_are_read_from_its_words():
    got = canvas_comments.parse_note("Heads up: blocking the web also blocks GitHub. The build fetches fast_float "
                                     "from GitHub, so the pilot's builds will fail.")
    assert got == {"tag": "Heads up", "title": "Blocking the web also blocks GitHub",
                   "body": "The build fetches fast_float from GitHub, so the pilot's builds will fail."}
    got = canvas_comments.parse_note("You should know: each agent builds pandas from source on 1 CPU. A build takes "
                                     "about 1.5 minutes, e.g. 48 agents at once slow the machine.")
    assert (got["tag"], got["title"]) == ("You should know", "Each agent builds pandas from source on 1 CPU")
    assert got["body"] == "A build takes about 1.5 minutes, e.g. 48 agents at once slow the machine."
    assert canvas_comments.parse_note("No card shows this count.") == {"tag": None, "title": None,
                                                                      "body": "No card shows this count."}


def test_a_title_ends_where_its_sentence_ends_when_the_next_starts_with_a_file_name_or_code():
    """Live check plan-cards: 3 of 15 comments lost their title because the next sentence started with a lowercase file
    name or a code span, so the first sentence ran on past TITLE_CHARS."""
    got = canvas_comments.parse_note("Heads up: the prompts promise test checks on merges that no step builds. "
                                     "conditions/shared/environment.md line 20 says a PR merges with green tests.")
    assert (got["title"], got["body"]) == ("The prompts promise test checks on merges that no step builds",
                                           "conditions/shared/environment.md line 20 says a PR merges with green tests.")
    got = canvas_comments.parse_note("Heads up: there is no forge code in this folder. `forge/` holds only a test.")
    assert (got["title"], got["body"]) == ("There is no forge code in this folder", "`forge/` holds only a test.")
    got = canvas_comments.parse_note("You should know: **Blocking the web also blocks GitHub.** The build fails.")
    assert (got["title"], got["body"]) == ("Blocking the web also blocks GitHub", "The build fails.")
    got = canvas_comments.parse_note("Heads up: the U.S. mirror is slow, e.g. at night. Use another one.")
    assert (got["title"], got["body"]) == ("The U.S. mirror is slow, e.g. at night", "Use another one.")


async def test_a_stored_comment_is_served_with_its_title_read_again_from_its_words(board, bridge):
    a = _card("A card")
    act = await _turn_ended()
    await _comment(act, f"card:{a}", "Heads up: the manager's table no longer fits. manager.md asks for one row each.",
                   "toolu_t1")

    def untitled(items):  # as a comment left before parse_note read a lowercase next sentence
        for x in items:
            x.update(title=None, body=x["text"].split(": ", 1)[1])

    canvas_comments._change(CORPUS, untitled)
    [cm] = canvas_comments.open_comments(CORPUS)
    assert (cm["title"], cm["body"]) == ("The manager's table no longer fits", "manager.md asks for one row each.")


async def test_a_check_turned_on_or_off_is_a_checks_record_on_the_stream(board):
    """Live check plan-cards: the Report's switch turned You should know off and the canvas kept showing it on until a
    reload, since only a run's start and end reached the stream."""
    def records() -> list[dict]:
        path = investigation.inv_dir(CORPUS, investigation.MAIN) / "events.jsonl"
        return [e for e in investigation._read_jsonl(path) if e.get("type") == "checks"] if path.exists() else []

    checks.edit(CORPUS, YSK, shown=False)
    assert [e["id"] for e in records()] == [YSK]
    made = checks.create(CORPUS, "Risks", "Mark the risky cards.", created_by="analyst", covers=["cards"])
    assert [e["id"] for e in records()] == [YSK, made["id"]]


async def test_main_s_turn_end_runs_you_should_know_on_the_unseen_cards_with_a_task_file(board, bridge):
    old = _card("What did the pilot show?", takeaway="Both agents merged their PR.")
    orientation = notebook.create_notebook(config.workspace_dir(CORPUS), "Orientation", role="exploration")
    deck = _card("How many messages are there?", group=orientation["id"])
    plan = _card("Plan: build the environment and pilot it", steps=_steps("done", "running", "not started"))
    act = await _turn_ended()
    [spawn] = bridge.ops("spawn")
    assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
    assert spawn["role"] == "check" and spawn["what"] == f"{YSK} on {checks.CANVAS}"
    covered = set(_run()["covered"])
    assert {f"card:{old}", f"card:{plan}", f"card:{plan}#step-1", f"card:{plan}#step-3"} <= covered
    assert not any(deck in r for r in covered), "the orientation's deck has its own critic"
    task = (checks.work_dir(CORPUS, YSK, checks.CANVAS) / checks.TASK_FILE).read_text()
    assert "Leave a comment on a passage only when" in task
    assert f"- card:{plan} · plan · Plan: build the environment and pilot it" in task
    assert f"card:{plan}#step-2 · running · Build the agent container" in task
    assert "takeaway: Both agents merged their PR." in task
    subagents.run_ended(CORPUS, act.agent, "done", "No comment clears the bar.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    assert len(_run()["seen"]) == len(covered)
    checks.main_turn_ended(CORPUS, "2000-01-01T00:00:00+00:00")
    await asyncio.sleep(0.05)
    assert len(bridge.ops("spawn")) == 1, "nothing unseen: no run"


async def test_a_turn_end_covers_only_the_cards_changed_since_the_turn_began(board, bridge):
    _card("An old card")
    await asyncio.sleep(1.05)  # a card's times are kept to the second, and a card of the turn's first second counts
    since = datetime.now(timezone.utc).isoformat(timespec="milliseconds")  # session._now, the turn's start
    new = _card("A card of this turn")
    await _turn_ended(since)
    assert _run()["covered"] == [f"card:{new}"]


async def test_add_comment_takes_a_covered_card_or_step_and_stores_its_tag_and_title(board, bridge):
    plan = _card("Plan: build the environment and pilot it", steps=_steps("not started", "not started", "not started"))
    act = await _turn_ended()
    res = await _comment(act, f"card:{plan}#step-2", "Heads up: blocking the web also blocks GitHub. The pandas build "
                         "downloads two of its libraries from GitHub [[card:" + plan + "]].", "toolu_k1")
    assert not res.is_error and _last(res) == f"commented on card:{plan}#step-2"
    res = await _comment(act, f"card:{plan}", "You should know: the pilot only tests the emergent prompt.", "toolu_k2")
    assert not res.is_error, res.text
    res = await _comment(act, "card:nosuchcard", "Heads up: x.", "toolu_k3")
    assert res.is_error and "no card" in res.text
    [on_step, on_card] = canvas_comments.open_comments(CORPUS)
    assert (on_step["step"], on_step["n"], on_step["ref"]) == ("s2", 2, f"card:{plan}#step-2")
    assert (on_step["tag"], on_step["title"]) == ("Heads up", "Blocking the web also blocks GitHub")
    assert on_step["body"] == "The pandas build downloads two of its libraries from GitHub." and on_step["check"] == YSK
    assert on_step["evidence"] == f"card:{plan}" and on_card["title"] == "The pilot only tests the emergent prompt"
    subagents.run_ended(CORPUS, act.agent, "done", "Two comments.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    assert _run()["comments"] == 2
    lines = (await tools.call(CORPUS, "read_ref", {"ref": f"card:{plan}"})).text
    assert f"comment {on_step['id']} on card:{plan}#step-2 · You should know · Heads up: blocking" in lines
    assert f"comment {on_card['id']} on card:{plan} · You should know" in context.canvas(CORPUS)


async def test_add_comment_refuses_a_card_the_run_does_not_cover(board, bridge):
    seen = _card("A card checked before")
    act = await _turn_ended()
    subagents.run_ended(CORPUS, act.agent, "done", "None.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    fresh = _card("A new card")
    act = await _turn_ended()
    assert _run()["covered"] == [f"card:{fresh}"]
    res = await _comment(act, f"card:{seen}", "Heads up: this.", "toolu_u1")
    assert res.is_error and "not among the passages this run checks" in res.text
    assert not canvas_comments.open_comments(CORPUS)


async def test_done_and_know_it_hide_a_comment_and_know_it_is_never_raised_again(board, bridge):
    a = _card("Which condition merged more PRs?")
    b = _card("Did any agent still fail to build?")
    act = await _turn_ended()
    await _comment(act, f"card:{a}", "Heads up: the merged counts aren't fully comparable. Six agents could not "
                   "build their PR.", "toolu_d1")
    await _comment(act, f"card:{b}", "You should know: each agent builds pandas on 1 CPU.", "toolu_d2")
    one, two = canvas_comments.open_comments(CORPUS)
    got = await canvas_comments.resolve_route(CORPUS, one["id"], canvas_comments.ResolveBody(how="done"))
    assert [c["id"] for c in got["comments"]] == [two["id"]], "a comment marked done does not show"
    got = await canvas_comments.resolve_route(CORPUS, two["id"], canvas_comments.ResolveBody(how="known"))
    assert got["comments"] == [] and (await canvas_comments.list_route(CORPUS))["comments"] == []
    assert checks.known_titles(CORPUS, YSK) == ["Each agent builds pandas on 1 CPU"]
    subagents.run_ended(CORPUS, act.agent, "done", "Two comments.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    _card("A card of the next turn")
    await _turn_ended()
    task = (checks.work_dir(CORPUS, YSK, checks.CANVAS) / checks.TASK_FILE).read_text()
    assert "The analyst said they know these. Do not raise them again." in task
    assert "- Each agent builds pandas on 1 CPU" in task and "fully comparable" not in task.split("know these")[1]
    with pytest.raises(Exception):
        await canvas_comments.resolve_route(CORPUS, two["id"], canvas_comments.ResolveBody(how="later"))


async def test_a_run_s_end_supersedes_its_check_s_comments_on_the_cards_it_covered(board, bridge):
    a = _card("Which condition merged more PRs?", takeaway="Managed merged more.")
    b = _card("Did any agent still fail to build?")
    first = await _turn_ended()
    await _comment(first, f"card:{a}", "Heads up: the counts aren't comparable.", "toolu_s1")
    await _comment(first, f"card:{b}", "Heads up: six agents could not build.", "toolu_s2")
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


async def test_a_deleted_card_s_comments_are_not_served(board, bridge):
    a = _card("A card")
    act = await _turn_ended()
    await _comment(act, f"card:{a}", "Heads up: this.", "toolu_g1")
    assert len(canvas_comments.open_comments(CORPUS)) == 1
    notebook.delete_cell(CORPUS, a)
    assert canvas_comments.open_comments(CORPUS) == []
    assert (await canvas_comments.list_route(CORPUS))["comments"] == []


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


async def test_main_s_add_comment_on_a_card_is_claude_s_note_and_resolve_comment_takes_card_refs(board):
    plan = _card("Plan: run the experiment", steps=_steps("not started", "not started", "not started"))
    res = await tools.call(CORPUS, "add_comment", {"ref": f"card:{plan}#step-3", "text": "You should know: the "
                                                   "comparison counts reverts too."})
    assert not res.is_error and _last(res).startswith(f"commented on card:{plan}#step-3, comment k")
    res = await tools.call(CORPUS, "add_comment", {"ref": f"card:{plan}#step-9", "text": "Heads up: x."})
    assert res.is_error and "no step of a plan card" in res.text
    [cm] = canvas_comments.open_comments(CORPUS)
    assert (cm["author"], cm["check"], cm["tag"]) == ("claude", None, "You should know")
    res = await tools.call(CORPUS, "resolve_comment", {"comment": f"card:{plan}", "how": "known"})
    assert not res.is_error and f"resolved comment {cm['id']} on card:{plan}#step-3 · claude" in res.text
    assert canvas_comments.open_comments(CORPUS) == []
    res = await tools.call(CORPUS, "resolve_comment", {"comment": cm["id"], "reopen": True})
    assert not res.is_error and len(canvas_comments.open_comments(CORPUS)) == 1


async def test_know_it_on_a_document_s_comment_is_kept_and_listed_for_the_check_s_next_run(board, bridge):
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": "# One\n\n## A\n\nAll the deletions came "
                                                    "from one account.\n"}, actor="analyst")
    assert not r.is_error, r.text
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    sid = report_types.all_sentences(d)[0]["id"]
    d.setdefault("comments", []).append({"id": "c1", "sentence_id": sid, "text": "You should know: the log covers one "
                                         "week. Older deletions are not in it.", "author": "check", "check": YSK,
                                         "run": "r0", "ts": "2026-10-08T00:00:00+00:00", "status": "open",
                                         **canvas_comments.parse_note("You should know: the log covers one week. "
                                                                      "Older deletions are not in it.")})
    report_types.write_doc(CORPUS, investigation.MAIN, "report", d)
    await report_types.dismiss(CORPUS, investigation.MAIN, "report", "c1", report_types.DismissBody(how="known"))
    [cm] = report_types.read_doc(CORPUS, investigation.MAIN, "report")["comments"]
    assert (cm["status"], cm["resolution"], cm["title"]) == ("dismissed", "known", "The log covers one week")
    assert checks.known_titles(CORPUS, YSK) == ["The log covers one week"]
    check = checks.read(CORPUS, YSK)
    task = checks.task_text(CORPUS, check, "report", checks.passages("report", report_types.read_doc(
        CORPUS, investigation.MAIN, "report")))
    assert "Do not raise them again.\n\n- The log covers one week" in task


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


async def test_a_check_reads_the_steps_of_a_plan_that_follows_a_finished_one_and_comments_beside_a_step(board, bridge):
    """Plan cards and comments together, through the tools main calls: the build plan finishes, the run plan follows it,
    the turn's check reads the new plan's steps with what each makes and the plan it follows, its comment on step 2
    stays while step 1 starts (the step's own words did not change), and Done hides it."""
    group = notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]

    async def call(name: str, **args):
        res = await tools.call(CORPUS, name, args, actor="analyst", notebook=group, terminal=False)
        assert not res.is_error, res.text
        return res

    build = (await call("add_card", kind="plan", question="Plan: build the environment and pilot it",
                        steps=[{"text": "Build the agent container", "makes": ["Dockerfile.agent"]},
                               {"text": "Pilot: 2 agents, one PR each", "makes": ["pilot/"]}])).text
    build = re.search(r"^card:([A-Za-z0-9_-]+)$", build, re.M).group(1)
    for n in (1, 2):
        await call("update_plan", card=f"card:{build}", step=n, status="done")
    run = (await call("add_card", kind="plan", question="Plan: run the experiment", follows=f"card:{build}",
                      steps=[{"text": "Run the emergent condition: 48 agents, 2 hours", "makes": ["runs/emergent/"]},
                             {"text": "Run the managed condition: 48 agents and a manager, 2 hours",
                              "makes": ["runs/managed/"]},
                             {"text": "Compare the conditions", "makes": ["results/"]}])).text
    run = re.search(r"^card:([A-Za-z0-9_-]+)$", run, re.M).group(1)
    assert notebook.get_cell(CORPUS, run)["notebook"] == group, "the next phase lands beside the plan it follows"

    act = await _turn_ended()
    covered = set(_run()["covered"])
    assert {f"card:{run}#step-1", f"card:{run}#step-2", f"card:{run}#step-3", f"card:{build}#step-2"} <= covered
    task = (checks.work_dir(CORPUS, YSK, checks.CANVAS) / checks.TASK_FILE).read_text()
    assert f"- card:{run} · plan · Plan: run the experiment\n  follows: card:{build}" in task
    assert (f"card:{run}#step-2 · not started · Run the managed condition: 48 agents and a manager, 2 hours "
            "→ runs/managed/") in task
    assert f"card:{build}#step-1 · done · Build the agent container → Dockerfile.agent" in task
    res = await _comment(act, f"card:{run}#step-2", "Heads up: only the versions on pandas' main branch are in the "
                         "image. PR branches that pin other versions will still fail to build.", "toolu_p1")
    assert not res.is_error, res.text
    subagents.run_ended(CORPUS, act.agent, "done", "One comment.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")

    # step 1 starts: the next turn's check covers that step alone, and the comment on step 2 stays beside it
    await call("update_plan", card=f"card:{run}", step=1, status="running", runs=["emergent"])
    act = await _turn_ended()
    assert _run()["covered"] == [f"card:{run}#step-1"]
    subagents.run_ended(CORPUS, act.agent, "done", "Nothing new.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    [cm] = (await canvas_comments.list_route(CORPUS))["comments"]
    assert (cm["ref"], cm["step"], cm["title"]) == (f"card:{run}#step-2", "s2",
                                                   "Only the versions on pandas' main branch are in the image")
    assert f"comment {cm['id']} on card:{run}#step-2" in context.canvas(CORPUS)
    got = await canvas_comments.resolve_route(CORPUS, cm["id"], canvas_comments.ResolveBody(how="done"))
    assert got["comments"] == [], "a resolved comment does not show"
