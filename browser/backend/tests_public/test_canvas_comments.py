"""Comments on the canvas (canvas_comments.py, checks.py's run target CANVAS): a check that covers the cards runs at
main's turn end on the cards it has not seen, as a follow-on start through thimble's module, with a task file that
lists the cards and a plan card's steps; its add_comment takes a covered card or step and stores the comment's
statement (`text`) and its `details`, and a comment stored before `details` reads as its first sentence and the rest;
Done hides a comment, and one resolved as known before 0.7.0 reads as resolved; a run's end supersedes its check's
earlier comments on what it covered; a deleted card's comments are not served; main's run_check with `on: cards` gives
the exact Agent call, and main's own add_comment on a card is Claude's note. The built-ins, Judgment calls,
Unverifiable and Heads up, each cover the documents and the cards; only Heads up is on until the
analyst turns a check on or off, and these tests turn the other two off as the analyst would. The module is the fake
bridge (subagent_fakes); an agent's end is subagents.run_ended. A plan card is the plan kind, its steps in
payload.steps."""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone

import pytest

from app import canvas_comments, checks, config, context, investigation, notebook, report_types, subagents, tools
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
IMPORTANT = "heads-up"


@pytest.fixture()
def board(workspaces_tmp, monkeypatch):
    """Settings' checks row, with Heads up on and covering the cards too (by default it covers the documents and Claude's
    answers), and the other built-ins turned off."""
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    checks.edit(CORPUS, IMPORTANT, shown=True, covers=["documents", "cards", "answers"])
    for cid in ("judgment", "explainers"):
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
    """Main's turn ended; the run of Heads up starts on the cards, once its agent has started through the
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


def test_the_built_ins_are_heads_up_and_explainers_on_the_documents_and_the_chat_and_judgment_calls_off(workspaces_tmp):
    """The built-ins are Heads up, Explainers and Judgment calls, in that order. Heads up and Explainers are the terminal's
    heads-up and explainer lenses as checks: on, and covering the documents and Claude's answers in the chat. Judgment
    calls covers the documents and the cards and is off. Unverifiable and Verified are no built-ins any more, so a new
    workspace lists neither."""
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    listed = checks.list_checks(CORPUS)
    assert [(c["id"], c["name"], c["shown"], c["colour"]) for c in listed] == [
        (IMPORTANT, "Heads up", True, 2), ("explainers", "Explainers", True, 6), ("judgment", "Judgment calls", False, 1)]
    for c in listed:
        want_covers = ["documents", "cards"] if c["id"] == "judgment" else ["documents", "answers"]
        assert c["builtin"] is True and c["covers"] == want_covers, c
        want = open(config.REPO_ROOT / "prompts" / "checks" / f"{c['id']}.md", encoding="utf-8").read()
        assert c["prompt"] == want.split("\n---\n", 1)[1].strip()
    assert checks.read(CORPUS, IMPORTANT)["prompt"].startswith("A heads-up marks words of the answer for a detail the analyst should know")
    assert checks.read(CORPUS, "explainers")["prompt"].startswith("An explainer marks a key term")
    for gone in ("verified", "unverified"):
        assert checks.read(CORPUS, gone) is None
    assert checks.by_name(CORPUS, "Verified") is None and checks.by_name(CORPUS, "Unverifiable") is None


def test_a_comment_s_statement_and_details_are_read_from_words_written_as_one_text():
    """A comment stored before `details` is its first sentence, the statement, and the rest, its details; a leading copy
    of its own check's name and a colon goes, since a comment shows its check's name, and no other label does."""
    got = canvas_comments.parse_note("Important details: blocking the web also blocks GitHub. The build fetches "
                                     "fast_float from GitHub, so the pilot's builds will fail.", "Important details")
    assert got == {"statement": "Blocking the web also blocks GitHub.",
                   "details": "The build fetches fast_float from GitHub, so the pilot's builds will fail."}
    got = canvas_comments.parse_note("**Unverifiable:** each agent builds pandas from source on 1 CPU. A build takes "
                                     "about 1.5 minutes, e.g. 48 agents at once slow the machine.", "Unverifiable")
    assert got["statement"] == "Each agent builds pandas from source on 1 CPU."
    assert got["details"] == "A build takes about 1.5 minutes, e.g. 48 agents at once slow the machine."
    assert canvas_comments.parse_note("No card shows this count.") == {"statement": "No card shows this count.",
                                                                      "details": ""}
    for other in ("Heads up: the log covers one week.", "You should know: the log covers one week."):
        assert canvas_comments.parse_note(other, "Important details")["statement"] == other, "another check's label stays"
    assert canvas_comments.parse_note("Judgment calls: the log covers one week.")["statement"].startswith("Judgment")


def test_a_statement_ends_where_its_sentence_ends_when_the_next_starts_with_a_file_name_or_code():
    """Live check plan-cards: 3 of 15 comments lost their title because the next sentence started with a lowercase file
    name or a code span, so the first sentence ran on."""
    got = canvas_comments.parse_note("Important details: the prompts promise test checks on merges that no step builds. "
                                     "conditions/shared/environment.md line 20 says a PR merges with green tests.",
                                     "Important details")
    assert (got["statement"], got["details"]) == ("The prompts promise test checks on merges that no step builds.",
                                                  "conditions/shared/environment.md line 20 says a PR merges with green tests.")
    got = canvas_comments.parse_note("There is no forge code in this folder. `forge/` holds only a test.")
    assert (got["statement"], got["details"]) == ("There is no forge code in this folder.", "`forge/` holds only a test.")
    got = canvas_comments.parse_note("Important details: **Blocking the web also blocks GitHub.** The build fails.",
                                     "Important details")
    assert (got["statement"], got["details"]) == ("Blocking the web also blocks GitHub.", "The build fails.")
    got = canvas_comments.parse_note("The U.S. mirror is slow, e.g. at night. Use another one.")
    assert (got["statement"], got["details"]) == ("The U.S. mirror is slow, e.g. at night.", "Use another one.")


async def test_a_check_turned_on_or_off_is_a_checks_record_on_the_stream(board):
    """Live check plan-cards: the Report's switch turned Heads up off and the canvas kept showing it on until a
    reload, since only a run's start and end reached the stream."""
    def records() -> list[dict]:
        path = investigation.inv_dir(CORPUS, investigation.MAIN) / "events.jsonl"
        return [e for e in investigation._read_jsonl(path) if e.get("type") == "checks"] if path.exists() else []

    checks.edit(CORPUS, IMPORTANT, shown=False)
    assert [e["id"] for e in records()] == [IMPORTANT]
    made = checks.create(CORPUS, "Risks", "Mark the risky cards.", created_by="analyst", covers=["cards"])
    assert [e["id"] for e in records()] == [IMPORTANT, made["id"]]


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
    assert "A heads-up marks words of the answer for a detail the analyst should know before they rely on it." in task
    assert f"- card:{plan} · plan · Plan: build the environment and pilot it" in task
    assert f"card:{plan}#step-2 · running · Build the agent container" in task
    assert "takeaway: Both agents merged their PR." in task
    subagents.run_ended(CORPUS, act.agent, "done", "No comment clears the bar.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    assert len(_run()["seen"]) == len(covered)
    checks.main_turn_ended(CORPUS, "2000-01-01T00:00:00+00:00")
    await asyncio.sleep(0.05)
    assert len(bridge.ops("spawn")) == 1, "nothing unseen: no run"


async def test_in_a_new_workspace_main_s_turn_end_runs_no_check_on_the_cards_until_one_is_turned_on(workspaces_tmp,
                                                                                                    bridge, monkeypatch):
    """Of the built-ins only Judgment calls covers the cards, and it is off in a workspace that stored none of them:
    main's turn end starts no check on them. Judgment calls, turned on by the analyst, runs at the next turn end."""
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    card = _card("What did the pilot show?", takeaway="Both agents merged their PR.")
    checks.main_turn_ended(CORPUS, "2000-01-01T00:00:00+00:00")
    await asyncio.sleep(0.05)
    assert not bridge.ops("spawn") and not _run(IMPORTANT) and not _run("explainers") and not _run("judgment")
    checks.edit(CORPUS, "judgment", shown=True)
    checks.main_turn_ended(CORPUS, "2000-01-01T00:00:00+00:00")
    await _until(lambda: len(bridge.ops("spawn")) == 1, "the check turned on never started at main's turn end")
    assert bridge.ops("spawn")[0]["what"] == f"judgment on {checks.CANVAS}"
    assert _run("judgment")["covered"] == [f"card:{card}"]


async def test_a_turn_end_covers_only_the_cards_changed_since_the_turn_began(board, bridge):
    _card("An old card")
    await asyncio.sleep(1.05)  # a card's times are kept to the second, and a card of the turn's first second counts
    since = datetime.now(timezone.utc).isoformat(timespec="milliseconds")  # session._now, the turn's start
    new = _card("A card of this turn")
    await _turn_ended(since)
    assert _run()["covered"] == [f"card:{new}"]


async def test_add_comment_takes_a_covered_card_or_step_and_stores_its_statement_and_details(board, bridge):
    plan = _card("Plan: build the environment and pilot it", steps=_steps("not started", "not started", "not started"))
    act = await _turn_ended()
    res = await _comment(act, f"card:{plan}#step-2", "Blocking the web also blocks GitHub.", "toolu_k1",
                         details="- The pandas build downloads two of its libraries from GitHub [[card:" + plan + "]].\n"
                                 "- Bake them into the image.   \n\n\n\nOr allow github.com.")
    assert not res.is_error and _last(res) == f"commented on card:{plan}#step-2"
    res = await _comment(act, f"card:{plan}", "Heads up: the pilot only tests the emergent prompt.", "toolu_k2")
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
    assert (f"comment {on_step['id']} on card:{plan}#step-2 · Heads up · Blocking the web also blocks GitHub. — "
            "- The pandas build downloads") in lines
    assert f"comment {on_card['id']} on card:{plan} · Heads up · The pilot only tests" in context.canvas(CORPUS)


def test_add_comment_names_its_statement_and_its_details():
    desc, schema = tools.tool_sections(("add_comment",))["add_comment"]
    assert set(schema["properties"]) == {"ref", "text", "details"} and schema["required"] == ["ref", "text"]
    assert "`text` first" in desc and "`details`" in desc


def test_a_check_is_told_how_to_cite_so_its_details_show_chips():
    """A check over the cards reads no document that cites, so its prompt names the citation's form: without it the
    details named files in backticks, which open nothing (live run 2026-10-09)."""
    from app import prompts  # noqa: PLC0415

    text = prompts.load("check")
    assert "`[[<ref>]]`" in text and "`[[card:<id>]]`" in text and "`[[<path>#L<n>]]`" in text


async def test_add_comment_refuses_a_card_the_run_does_not_cover(board, bridge):
    seen = _card("A card checked before")
    act = await _turn_ended()
    subagents.run_ended(CORPUS, act.agent, "done", "None.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    fresh = _card("A new card")
    act = await _turn_ended()
    assert _run()["covered"] == [f"card:{fresh}"]
    res = await _comment(act, f"card:{seen}", "This needs a look.", "toolu_u1")
    assert res.is_error and "not among the passages this run checks" in res.text
    assert not canvas_comments.open_comments(CORPUS)


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
    assert "Each agent builds pandas on 1 CPU." not in task and not re.search(r"\bknown\b|\bknow it\b", task.lower().split("## ")[-1])
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


async def test_a_deleted_card_s_comments_are_not_served(board, bridge):
    a = _card("A card")
    act = await _turn_ended()
    await _comment(act, f"card:{a}", "This needs a look.", "toolu_g1")
    assert len(canvas_comments.open_comments(CORPUS)) == 1
    notebook.delete_cell(CORPUS, a)
    assert canvas_comments.open_comments(CORPUS) == []
    assert (await canvas_comments.list_route(CORPUS))["comments"] == []


async def test_main_s_add_comment_on_a_card_is_claude_s_note_and_resolve_comment_takes_card_refs(board):
    plan = _card("Plan: run the experiment", steps=_steps("not started", "not started", "not started"))
    res = await tools.call(CORPUS, "add_comment", {"ref": f"card:{plan}#step-3", "text": "The comparison counts "
                                                   "reverts too.", "details": "A revert is a merged PR [[card:"
                                                   + plan + "]]."})
    assert not res.is_error and _last(res).startswith(f"commented on card:{plan}#step-3, comment k")
    res = await tools.call(CORPUS, "add_comment", {"ref": f"card:{plan}#step-9", "text": "X."})
    assert res.is_error and "no step of a plan card" in res.text
    [cm] = canvas_comments.open_comments(CORPUS)
    assert (cm["author"], cm["check"]) == ("claude", None)
    assert (cm["text"], cm["details"], cm["evidence"]) == ("The comparison counts reverts too.",
                                                           f"A revert is a merged PR [[card:{plan}]].", f"card:{plan}")
    res = await tools.call(CORPUS, "resolve_comment", {"comment": f"card:{plan}"})
    assert not res.is_error and f"resolved comment {cm['id']} on card:{plan}#step-3 · claude" in res.text
    assert canvas_comments.open_comments(CORPUS) == []
    assert next(x for x in canvas_comments._read(CORPUS) if x["id"] == cm["id"])["resolution"] == "done"
    assert "how" not in tools.tool_sections(("resolve_comment",))["resolve_comment"][1]["properties"]
    res = await tools.call(CORPUS, "resolve_comment", {"comment": cm["id"], "reopen": True})
    assert not res.is_error and len(canvas_comments.open_comments(CORPUS)) == 1


async def test_done_on_a_document_s_comment_and_one_resolved_as_known_before_read_as_resolved(board, bridge):
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": "# One\n\n## A\n\nAll the deletions came "
                                                    "from one account.\n"}, actor="analyst")
    assert not r.is_error, r.text
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    sid = report_types.all_sentences(d)[0]["id"]
    # a comment stored before `details`, one text: the document reads it as its statement and its details
    d.setdefault("comments", []).append({"id": "c1", "sentence_id": sid, "text": "Heads up: the log covers one "
                                         "week. Older deletions are not in it.", "author": "check", "check": IMPORTANT,
                                         "run": "r0", "ts": "2026-10-08T00:00:00+00:00", "status": "open"})
    d["comments"].append({"id": "c2", "sentence_id": sid, "text": "The account is a bot.", "details": "", "author": "check",
                          "check": IMPORTANT, "run": "r0", "ts": "2026-10-08T00:00:00+00:00", "status": "dismissed",
                          "resolution": "known"})  # as Know it left it before 0.7.0
    report_types.write_doc(CORPUS, investigation.MAIN, "report", d)
    cm, old = report_types.read_doc(CORPUS, investigation.MAIN, "report")["comments"]
    assert (cm["text"], cm["details"]) == ("The log covers one week.", "Older deletions are not in it.")
    await report_types.dismiss(CORPUS, investigation.MAIN, "report", "c1")
    cm, old = report_types.read_doc(CORPUS, investigation.MAIN, "report")["comments"]
    assert (cm["status"], cm["resolution"], cm["text"]) == ("dismissed", "done", "The log covers one week.")
    assert (old["status"], old["resolution"]) == ("dismissed", "known"), "stored as it was, and resolved"
    check = checks.read(CORPUS, IMPORTANT)
    task = checks.task_text(CORPUS, check, "report", checks.passages("report", report_types.read_doc(
        CORPUS, investigation.MAIN, "report")))
    assert "The log covers one week." not in task.split("## ")[-1] and "The account is a bot." not in task


async def test_main_s_add_comment_on_a_document_keeps_its_details_and_the_analyst_s_own_comment_stays_whole(board):
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": "# One\n\n## A\n\nAll the deletions came "
                                                    "from one account. Most were in March.\n"}, actor="analyst")
    assert not r.is_error, r.text
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    first, second = (x["id"] for x in report_types.all_sentences(d))
    cid = _card("Who deleted pages?")
    res = await tools.call(CORPUS, "add_comment", {"ref": f"report:report#{first}", "text": "Two accounts deleted "
                                                   f"pages, not one [[card:{cid}]].", "details": f"- The table counts "
                                                   f"two accounts [[2|card:{cid}]].\n- The second made 3 of 40."})
    assert not res.is_error, res.text
    await report_types.post_comment(CORPUS, investigation.MAIN, "report",
                                    report_types.CommentBody(sentence_id=second, text="Check this. And March too."))
    mine, yours = report_types.read_doc(CORPUS, investigation.MAIN, "report")["comments"]
    assert (mine["author"], mine["text"]) == ("claude", "Two accounts deleted pages, not one.")
    assert mine["details"] == f"- The table counts two accounts [[2|card:{cid}]].\n- The second made 3 of 40."
    assert mine["evidence"] == f"card:{cid}"
    assert (yours["author"], yours["text"], yours["details"]) == ("analyst", "Check this. And March too.", "")
    lines = report_types.document_text(CORPUS, report_types.read_type(CORPUS, "report"),
                                       report_types.read_doc(CORPUS, investigation.MAIN, "report"), True)
    assert f"#{first} · claude · Two accounts deleted pages, not one. — - The table counts two accounts" in lines


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

    build_steps = [{"text": "Build the agent container", "makes": ["Dockerfile.agent"]},
                   {"text": "Pilot: 2 agents, one PR each", "makes": ["pilot/"]}]
    build = (await call("add_card", kind="plan", question="Plan: build the environment and pilot it", steps=build_steps)).text
    build = re.search(r"^card:([A-Za-z0-9_-]+)$", build, re.M).group(1)
    for n in (1, 2):
        await call("edit_card", card=f"card:{build}",
                   steps=[{**s, "status": "done"} for s in build_steps[:n]] + build_steps[n:])
    run_steps = [{"text": "Run the emergent condition: 48 agents, 2 hours", "makes": ["runs/emergent/"]},
                 {"text": "Run the managed condition: 48 agents and a manager, 2 hours", "makes": ["runs/managed/"]},
                 {"text": "Compare the conditions", "makes": ["results/"]}]
    run = (await call("add_card", kind="plan", question="Plan: run the experiment", follows=f"card:{build}",
                      steps=run_steps)).text
    run = re.search(r"^card:([A-Za-z0-9_-]+)$", run, re.M).group(1)
    assert notebook.get_cell(CORPUS, run)["notebook"] == group, "the next phase lands beside the plan it follows"

    act = await _turn_ended()
    covered = set(_run()["covered"])
    assert {f"card:{run}#step-1", f"card:{run}#step-2", f"card:{run}#step-3", f"card:{build}#step-2"} <= covered
    task = (checks.work_dir(CORPUS, IMPORTANT, checks.CANVAS) / checks.TASK_FILE).read_text()
    assert f"- card:{run} · plan · Plan: run the experiment\n  follows: card:{build}" in task
    assert (f"card:{run}#step-2 · not started · Run the managed condition: 48 agents and a manager, 2 hours "
            "→ runs/managed/") in task
    assert f"card:{build}#step-1 · done · Build the agent container → Dockerfile.agent" in task
    res = await _comment(act, f"card:{run}#step-2", "Only the versions on pandas' main branch are in the image.",
                         "toolu_p1", details="PR branches that pin other versions will still fail to build.")
    assert not res.is_error, res.text
    subagents.run_ended(CORPUS, act.agent, "done", "One comment.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")

    # step 1 starts: the next turn's check covers that step alone, and the comment on step 2 stays beside it
    await call("edit_card", card=f"card:{run}", steps=[{**run_steps[0], "status": "running", "runs": ["emergent"]},
                                                       *run_steps[1:]])
    act = await _turn_ended()
    assert _run()["covered"] == [f"card:{run}#step-1"]
    subagents.run_ended(CORPUS, act.agent, "done", "Nothing new.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    [cm] = (await canvas_comments.list_route(CORPUS))["comments"]
    assert (cm["ref"], cm["step"], cm["text"]) == (f"card:{run}#step-2", "s2",
                                                  "Only the versions on pandas' main branch are in the image.")
    assert cm["details"] == "PR branches that pin other versions will still fail to build."
    assert f"comment {cm['id']} on card:{run}#step-2" in context.canvas(CORPUS)
    got = await canvas_comments.resolve_route(CORPUS, cm["id"])
    assert got["comments"] == [], "a resolved comment does not show"


async def test_a_thread_a_comment_s_field_opens_names_the_comment_on_its_anchor_line(board):
    """Live check plan-cards: a thread a comment opened showed only its step. The thread now keeps the comment
    (`anchor_comment`): its check's id, name and color and its statement, for a check's comment on a step and for a
    check's comment in a document, Claude's note named Claude; an id that names no comment keeps none, and the thread
    still opens."""
    from app import agents

    plan = _card("Plan: build it", steps=_steps("not started", "not started", "not started"))
    cm, _ = canvas_comments.add(CORPUS, card=plan, step="s2", check=IMPORTANT, run="r1", author=canvas_comments.CHECK_AUTHOR,
                                text="Blocking the web also blocks GitHub.", details="The build fetches two libraries.")
    meta = await agents.create_route(CORPUS, agents.NewThread(anchor=f"card:{plan}#step-2", anchor_text="Plan: build it",
                                                               surface="canvas", element="comment", comment=cm["id"]))
    colour = checks.read(CORPUS, IMPORTANT)["colour"]
    want = {"id": cm["id"], "check": IMPORTANT, "name": "Heads up", "colour": colour,
            "text": "Blocking the web also blocks GitHub."}
    assert meta["anchor_comment"] == want
    assert agents.read_meta(CORPUS, meta["id"])["anchor_comment"] == want, "kept with the thread"
    note, _ = canvas_comments.add(CORPUS, card=plan, step=None, author=canvas_comments.CLAUDE, text="A note of mine.")
    got = agents.new_thread(CORPUS, f"card:{plan}", "Plan: build it", element="comment", comment=note["id"])
    assert got["anchor_comment"] == {"id": note["id"], "check": None, "name": "Claude", "colour": None,
                                     "text": "A note of mine."}
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": "# R\n\n## One\n\nAll the saves came from one bot.\n"},
                         actor="analyst")
    assert not r.is_error, r.text
    d = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    sid = report_types.all_sentences(d)[-1]["id"]
    d.setdefault("comments", []).append({"id": "c9", "sentence_id": sid, "check": IMPORTANT, "author": "check",
                                         "text": "The bot is the importer.", "details": "It runs nightly.",
                                         "status": "open"})
    report_types.write_doc(CORPUS, investigation.MAIN, "report", d)
    got = agents.new_thread(CORPUS, f"report:report#{sid}", "All the saves came from one bot.", element="comment",
                            comment="c9")
    assert (got["anchor_comment"]["name"], got["anchor_comment"]["text"]) == ("Heads up", "The bot is the importer.")
    assert agents.new_thread(CORPUS, f"card:{plan}", "x", comment="nope")["anchor_comment"] is None
    assert agents.new_thread(CORPUS, f"card:{plan}", "x")["anchor_comment"] is None
