"""The orientation's coverage line (orient_checks.coverage, orient_session.measure): when its first run finishes,
thimble measures which corpus files the orientation, its agents and its deck's cards opened, grouped by glob, with the
share of the files and of their records, and adds the line to its transcript as the analyst and the agents see it: a
note at the end of its thread, a second line of main's `orient` event and of summary.md, and the end of the next run's
prompt, after its messages. Mid-run the orientation hears nothing of it: its add_card and critique calls get no note. A
critique's first message has the line in place of the unread check. The critique itself is off unless Start or the
call turns it on."""
from __future__ import annotations

import asyncio

import pytest

from app import (agent_session, agents, calls, config, corpus as corpus_mod, critique_session, events, orient_checks,
                 orient_session, orientation, records, session, tools)

CORPUS = "mini"
NOTE = {"question": "What does the corpus hold?", "kind": "note", "text": "Three agents.", "takeaway": "Three agents."}


@pytest.fixture()
async def chat(workspaces_tmp):
    """The orientation's chat, its first run going."""
    calls.forget()
    made = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, announce=False, brief="")["id"]
    orientation.started(CORPUS, made, passes=["final"])
    yield made
    calls.forget()
    orient_session._closing.discard(CORPUS)


@pytest.fixture()
def critiques(monkeypatch) -> list[dict]:
    """The critiques that started, each answering `Report.`"""
    started: list[dict] = []

    async def fake(ctx, args):
        started.append(args)
        return tools.ok("Report.")

    monkeypatch.setattr(critique_session, "tool_critique", fake)
    return started


@pytest.fixture()
def told(monkeypatch) -> list[dict]:
    """The events main was told, as tell_main posts them."""
    out: list[dict] = []
    monkeypatch.setattr(agent_session, "tell_main", lambda c, kind, payload: out.append({"kind": kind, **payload}))
    return out


def _sizes() -> dict[str, int]:
    return {s["path"]: int(s["size_bytes"]) for s in corpus_mod.list_sources(config.corpus_dir(CORPUS))
            if not s.get("hidden")}


def _bash(chat: str, n: int, command: str, result: str = "", at: str | None = None) -> None:
    calls.number(CORPUS, chat, f"toolu_{n}", "Bash", {"command": command}, **({"at": at} if at else {}))
    calls.result(CORPUS, chat, f"toolu_{n}", result)


def _read(chat: str, path: str) -> None:
    _, log_path = agents.paths(CORPUS, chat)
    agents.append(log_path, {"type": "tool_use", "id": f"toolu_r{path}", "name": "Read", "input": {"file_path": path}})


def _run(chat: str) -> agent_session.Run:
    return agent_session.Run(CORPUS, orient_session.KEY, chat, "sid-o", config.corpus_dir(CORPUS), orientation.ROLE)


async def _closed() -> None:
    for _ in range(400):
        if not orient_session._closing:
            return
        await asyncio.sleep(0.025)
    raise AssertionError("the first run's end was never measured")


def test_the_line_groups_the_files_by_glob_with_the_share_of_files_and_records_viewed(chat):
    root = config.corpus_dir(CORPUS)
    sizes = _sizes()
    _bash(chat, 1, f"find {root} -type f", "\n".join(f"{root}/{f}" for f in sizes))  # a listing opens nothing
    _bash(chat, 2, f"head -3 {root}/board.jsonl {root}/agents/agent-01.jsonl")
    text = orient_checks.coverage(CORPUS, chat).text
    counts = {f: records.count(root / f, f) for f in sizes}
    share = round(100 * (counts["board.jsonl"] + counts["agents/agent-01.jsonl"]) / sum(counts.values()))
    viewed, unviewed, shares = text.removeprefix("Coverage: viewed ").split(" · ")
    assert viewed == "agents/agent-01.jsonl, board.jsonl", "a few files viewed of a glob are named"
    assert unviewed.startswith("not viewed forge.db, agents/*.jsonl (2 of 3 files), events.jsonl, ")
    assert unviewed.endswith(", prompts/worker.md")
    assert shares == f"{round(100 * 2 / len(sizes))}% of {len(sizes)} files, holding {share}% of the records"
    files_set = set(sizes)
    agents_files = {f for f in files_set if f.startswith("agents/")}
    for command in (f"ls {root}/agents", "ls agents/", f"cat {root}/agents/*.jsonl", "wc -l agent-0?.jsonl"):
        assert orient_checks._read_by_calls(command, root, files_set, whole=True) == agents_files, command
    assert orient_checks._read_by_calls("Three agents posted on the board.", root, files_set, whole=True) == set()


def test_only_the_orientation_and_the_chats_under_it_count_never_a_critique_or_another_chat(chat):
    root = config.corpus_dir(CORPUS)
    step = agents.new_agent(CORPUS, agent_session.STEP_ROLE, "survey", parent=chat, announce=False)["id"]
    critic = agents.new_agent(CORPUS, agent_session.STEP_ROLE, "critique", parent=chat, announce=False,
                              agent_type=orient_checks.CRITIC)["id"]
    critic_step = agents.new_agent(CORPUS, agent_session.STEP_ROLE, "verify", parent=critic, announce=False)["id"]
    _read(step, str(root / "board.jsonl"))
    _read(critic, str(root / "events.jsonl"))
    _read(critic_step, str(root / "README.md"))
    _read(agents.MAIN_ID, str(root / "forge.db"))
    _bash(chat, 1, f"cat {root}/manifest.json", at=critic_step)
    text = orient_checks.coverage(CORPUS, chat).text
    viewed = text.split(" · ")[0]
    assert viewed == "Coverage: viewed board.jsonl", "its subagent's Read counts"
    for name in ("events.jsonl", "README.md", "forge.db", "manifest.json"):
        assert name not in viewed, name


async def test_a_card_of_its_deck_counts_and_an_earlier_orientation_s_card_only_once_it_is_edited(chat, monkeypatch):
    from app import notebook

    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    made = await tools.call(CORPUS, "add_card", NOTE, session=orient_session.KEY)
    cid = made.text.split("card:", 1)[1].split()[0].strip("`.,)")
    deck = orientation.deck_of(orientation.read_run(CORPUS))
    ws = config.workspace_dir(CORPUS)
    nb = notebook.read_notebook(ws, deck)
    [cell] = [x for x in nb["cells"] if x["id"] == cid]
    cell["reads"] = ["events.jsonl"]
    notebook.write_notebook(ws, nb)
    assert orient_checks.coverage(CORPUS, chat).text.split(" · ")[0] == "Coverage: viewed *.jsonl", "its card's reads"
    orientation.record(CORPUS, started="2999-01-01T00:00:00+00:00")  # the card is an earlier orientation's
    assert orient_checks.coverage(CORPUS, chat).text.split(" · ")[0] == "Coverage: viewed board.jsonl"


def test_with_every_file_viewed_the_line_says_so(chat):
    root = config.corpus_dir(CORPUS)
    sizes = _sizes()
    _bash(chat, 1, "wc -l " + " ".join(f"{root}/{f}" for f in sizes))
    assert orient_checks.coverage(CORPUS, chat).text == (
        f"Coverage: viewed every file · 100% of {len(sizes)} files, holding 100% of the records")


def test_a_glob_viewed_in_part_past_its_named_files_gives_its_count(chat, monkeypatch):
    monkeypatch.setattr(orient_checks, "COVERAGE_NAMED", 1)
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/agents/agent-01.jsonl {root}/agents/agent-02.jsonl")
    assert orient_checks.coverage(CORPUS, chat).text.startswith("Coverage: viewed agents/*.jsonl (2 of 3 files) · ")


def test_past_its_globs_it_groups_by_top_folder_and_counts_the_rest(chat, monkeypatch):
    monkeypatch.setattr(orient_checks, "COVERAGE_GLOBS", 3)
    monkeypatch.setattr(orient_checks, "COVERAGE_LISTED", 2)
    text = orient_checks.coverage(CORPUS, chat).text
    assert text.startswith("Coverage: viewed no file · not viewed agents/** (3 files), forge.db, and ")
    assert text.endswith(" more · 0% of 9 files, holding 0% of the records")


def test_past_its_byte_budget_records_are_estimated_and_marked(chat, monkeypatch):
    monkeypatch.setattr(orient_checks, "COUNT_BYTES", 10_000)
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"sqlite3 {root}/forge.db .tables")
    assert ", holding ~" in orient_checks.coverage(CORPUS, chat).text.split(" · ")[-1]


async def test_mid_run_no_call_hears_of_coverage_and_the_critique_starts_at_once(chat, critiques):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    made = await tools.call(CORPUS, "add_card", NOTE, session=orient_session.KEY)
    assert not made.is_error and "Coverage" not in made.text and "events.jsonl" not in made.text
    ran = await tools.call(CORPUS, "critique", {}, session=orient_session.KEY)
    assert len(critiques) == 1 and ran.text.endswith("Report.")


async def test_the_first_run_s_end_adds_the_line_to_its_thread_main_s_event_and_summary(chat, told):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    want = orient_checks.coverage(CORPUS, chat).text
    orient_session._ended(_run(chat), "done", "Done.")
    assert orient_session.running(CORPUS), "while it is measured, the orientation counts as running"
    await _closed()
    _, log_path = agents.paths(CORPUS, chat)
    last = agents.read_events(log_path)[-1]
    assert (last["type"], last["kind"], last["text"]) == ("chip", orient_session.COVERAGE_KIND, want)
    assert orientation.summary(CORPUS) == f"Done.\n\n{want}\n"
    rec = orientation.read_run(CORPUS)
    assert (rec["status"], rec["coverage"], rec["coverage_told"]) == ("done", want, False)
    [event] = told
    assert event["kind"] == orientation.ORIENT_KIND and event["text"].splitlines()[1] == want
    assert len(want) > events.LINE_CHARS and events.terminal_line(event["kind"], event["text"], {}).splitlines()[1] == want


async def test_a_message_sent_while_it_is_measured_waits_and_its_run_starts_with_the_line(chat, told, monkeypatch):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    want = orient_checks.coverage(CORPUS, chat).text
    started: list[dict] = []

    async def start(c, key, **kw):
        run = agent_session.Run(c, key, chat, "sid-o", config.corpus_dir(c), orientation.ROLE, k=kw.get("run_k", 0))
        kw["on_start"](run)
        started.append(kw)
        return run

    monkeypatch.setattr(agent_session, "start", start)
    monkeypatch.setattr(session, "find_transcript", lambda sid, config_dir=None: "/x.jsonl")
    orientation.record(CORPUS, session="sid-o")
    orient_session._ended(_run(chat), "done", "Done.")
    got = await orient_session.message(CORPUS, "And the weekends?", orient_session.BROWSER)
    assert got["status"] == "queued"
    await _closed()
    for _ in range(100):
        if started:
            break
        await asyncio.sleep(0.02)
    [first] = started
    assert first["prompt"].endswith("\n\n" + tools.hint("orient-coverage-lead", coverage=want))
    assert "And the weekends?" in first["prompt"] and first["leads"] == [{"text": "And the weekends?",
                                                                         "by": orient_session.BROWSER}]
    assert orientation.read_run(CORPUS)["coverage_told"] is True
    orientation.record(CORPUS, status="done")
    await orient_session.resume(CORPUS, [{"text": "And Mondays?", "by": orient_session.BROWSER}])
    assert "Coverage:" not in started[-1]["prompt"], "the line ends one run's prompt"


async def test_a_stopped_or_failed_first_run_or_a_follow_up_is_not_measured(chat, told, monkeypatch):
    async def no_measure(*a, **kw):
        raise AssertionError("not measured")

    monkeypatch.setattr(orient_session, "measure", no_measure)
    for status in ("failed", "stopped"):
        orientation.record(CORPUS, status="running")
        orient_session._ended(_run(chat), status, "")
        assert not orient_session.running(CORPUS) and "Coverage" not in told[-1]["text"], status
    follow_up = _run(chat)
    follow_up.k = 1
    orientation.record(CORPUS, run=1, status="running")
    orient_session._ended(follow_up, "done", "Revised card 2.")
    assert not orient_session.running(CORPUS) and "Coverage" not in told[-1]["text"]


async def test_the_critic_s_first_message_has_the_line_in_place_of_the_unread_check(chat):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    text = await critique_session.checks_text(CORPUS, chat)
    assert text.splitlines()[0] == "- " + orient_checks.coverage(CORPUS, chat).text
    assert "were opened by no card" not in text


def test_the_critique_is_off_unless_start_or_the_call_turns_it_on(workspaces_tmp):
    assert orientation.choices(CORPUS)["critique"] is False
    assert "critique" not in orient_session.parts_of({}, ("final", "views"))
    assert "critique" in orient_session.parts_of({"critique": True}, ("final", "views"))
    assert agent_session.thimble_tool("critique") in orient_session.disallowed(orient_session.parts_of({}, ("final",)))
    assert "`critique`" not in orient_session.system_prompt(CORPUS, "", orient_session.parts_of({}, ("final",)))
    orientation.start_requested(CORPUS, {"final_notebook": True}, {"id": "e1"})
    assert orientation.read_run(CORPUS)["critique"] is False and orientation.choices(CORPUS)["critique"] is False
    orientation.run_file(CORPUS).unlink()
    orientation.start_requested(CORPUS, {"final_notebook": True, "critique": "true"}, {"id": "e2"})
    assert orientation.choices(CORPUS)["critique"] is True
    [schema] = [t["input_schema"] for t in tools.list() if t["name"] == "start_orientation"]
    assert schema["properties"]["critique"]["description"].endswith("Default false.")
