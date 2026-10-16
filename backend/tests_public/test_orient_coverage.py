"""The orientation's coverage line (orient_checks.coverage, orient_session.measure): when its first run finishes,
thimble measures what the orientation and its agents read or searched of the corpus with the Coverage view's engine: the
tracker's facts of their stored calls (call_facts.py), what their cards and labels searched, and coverage.py's rules,
and adds `Coverage: read N% · searched N% of the data` (shares of the corpus by size) to its transcript as the analyst
and the agents see it: a note at the end of its thread, a second line of main's `orient` event and of summary.md, and
the end of the next run's prompt, after its messages. A file a call only names counts as neither read nor searched.
Mid-run the orientation hears nothing of it: its add_card and critique calls get no note. A critique's first message
has the line, then the files neither read nor searched, in place of the unread check. The critique is the
orientation's own choice: its prompt offers it, no switch of a start turns it on or off, and its tool answers whatever
an earlier version's record says."""
from __future__ import annotations

import asyncio

import pytest

from app import (agents, calls, config, corpus as corpus_mod, coverage, critique_session, events, notebook,
                 orient_checks, orient_session, orientation, subagents, tools)
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
NOTE = {"question": "What does the corpus hold?", "kind": "note", "text": "Three agents.", "takeaway": "Three agents."}


@pytest.fixture()
async def chat(workspaces_tmp, monkeypatch):
    """The orientation's chat, its first run going, and the corpus's coverage index built in this process (no detached
    job starts)."""
    calls.forget()
    monkeypatch.setattr(coverage, "start_index", lambda c, force=False: False)
    made = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, announce=False, brief="")["id"]
    orientation.started(CORPUS, made)
    assert coverage.run_job(CORPUS, config.corpus_dir(CORPUS)) == 0
    yield made
    calls.forget()
    orient_session._closing.pop(CORPUS, None)


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
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: out.append({"kind": kind, **payload}))
    return out


def _universe() -> dict[str, int]:
    """The corpus's files coverage counts, with their sizes."""
    root = config.corpus_dir(CORPUS)
    tree = coverage.code_tree(root)
    return {s["path"]: int(s["size_bytes"]) for s in corpus_mod.list_sources(root)
            if not s.get("hidden") and coverage.in_universe(s["path"], tree)}


def _line(read: int, searched: int = 0) -> str:
    """The line when `read` and `searched` bytes of the corpus were read and searched."""
    return "Coverage: " + coverage.line_of({"read": read, "searched": searched, "total": sum(_universe().values())})


def _call(chat: str, n: int, name: str, inp: dict, result: str, at: str | None = None, error: bool = False) -> None:
    calls.number(CORPUS, chat, f"toolu_{n}", name, inp, **({"at": at} if at else {}))
    calls.result(CORPUS, chat, f"toolu_{n}", result, is_error=error)


def _bash(chat: str, n: int, command: str, result: str = "", at: str | None = None) -> None:
    _call(chat, n, "Bash", {"command": command}, result, at)


def _lines(rel: str, a: int = 1, b: int | None = None) -> list[str]:
    """Lines a to b (1-based, b included) of a corpus file."""
    return (config.corpus_dir(CORPUS) / rel).read_text().splitlines()[a - 1:b]


def _numbered(lines: list[str], a: int = 1) -> str:
    return "\n".join(f"{k:>6}\t{line}" for k, line in enumerate(lines, a))


def _read(chat: str, n: int, rel: str, a: int = 1, b: int | None = None, at: str | None = None) -> None:
    """A Read of lines a to b of a corpus file, its output numbered as Read numbers it."""
    _call(chat, n, "Read", {"file_path": str(config.corpus_dir(CORPUS) / rel), "offset": a},
          _numbered(_lines(rel, a, b), a), at)


def _run(chat: str, k: int = 0) -> subagents.Run:
    return subagents.Run(CORPUS, orient_session.KEY, "orientation", chat, "a1", k=k)


async def _closed() -> None:
    for _ in range(400):
        if not orient_session._closing:
            return
        await asyncio.sleep(0.025)
    raise AssertionError("the first run's end was never measured")


def _never(chat: str) -> set[str]:
    detail: dict = {}
    orient_checks.coverage(CORPUS, chat, detail)
    assert detail["total"] == len(_universe())
    return set(detail["never"])


def test_a_run_that_names_three_files_but_reads_one_reads_one(chat):
    """The 0.8.0 report: an orientation asked about board.jsonl alone told its helper, by name, to leave three other
    files out, and its helper read work files a script made from board.jsonl, whose lines also stand in the other
    files. Only board.jsonl counts: naming a file reads none of it, and a file outside the corpus is none of its."""
    root = config.corpus_dir(CORPUS)
    work = config.workspace_dir(CORPUS) / "orient" / "work"
    helper = agents.new_agent(CORPUS, agents.STEP_ROLE, "helper", parent=chat, announce=False)["id"]
    left_out = ("events.jsonl", "agents/agent-01.jsonl", "README.md")
    _read(chat, 1, "board.jsonl")
    _call(chat, 2, "Agent", {"subagent_type": "thimble:orient-helper", "prompt":
                             f"Read {work}/board.txt. Do NOT open {', '.join(left_out)}: the analyst asked to leave "
                             f"them out."}, "Done.")
    _bash(chat, 3, f"cd {root} && python3 - <<'EOF' > {work}/board.txt\nfor line in open('board.jsonl'):\n"
                   f"    print(line)\nEOF", at=helper)
    copied = _lines("events.jsonl", 1, 3) + _lines("agents/agent-01.jsonl", 1, 2) + _lines("README.md", 1, 2)
    _bash(chat, 4, f"cat {work}/board.txt | head -40", "\n".join(copied), at=helper)
    _call(chat, 5, "Read", {"file_path": f"{work}/board.txt"}, _numbered(copied), at=helper)
    _bash(chat, 6, f"echo 'skipped: {' '.join(left_out)}'", " ".join(left_out), at=helper)
    sizes = _universe()
    assert orient_checks.coverage(CORPUS, chat).text == _line(sizes["board.jsonl"])
    assert _never(chat) == set(sizes) - {"board.jsonl"}


def test_reads_and_searches_count_by_the_corpus_s_size(chat):
    """A Read of five lines counts their share of the file's bytes as read; a recursive grep over a folder and a count
    of a file count those files' bytes as searched; a listing counts nothing."""
    root = config.corpus_dir(CORPUS)
    _read(chat, 1, "events.jsonl", 1, 5)
    _bash(chat, 2, f"grep -rc merged {root}/agents", "agent-01.jsonl:2")
    _bash(chat, 3, f"wc -l {root}/board.jsonl", f"8 {root}/board.jsonl")
    _bash(chat, 4, f"ls -la {root} && find {root} -name '*.md'", "README.md")
    sizes = _universe()
    read = round(sizes["events.jsonl"] * 5 / len(_lines("events.jsonl")))
    searched = sum(n for f, n in sizes.items() if f.startswith("agents/")) + sizes["board.jsonl"]
    assert orient_checks.coverage(CORPUS, chat).text == _line(read, searched)
    assert _never(chat) == set(sizes) - {"events.jsonl", "board.jsonl"} - {f for f in sizes if f.startswith("agents/")}


async def test_a_card_s_reads_and_a_label_s_files_count_as_searched(chat):
    """The files a card the orientation made read, and the files a label it ran over files matched, count as searched;
    a label over the canvas searches no file."""
    made = await tools.call(CORPUS, "add_card", NOTE, session=orient_session.KEY)
    cid = made.text.split("card:", 1)[1].split()[0].strip("`.,)")
    ws = config.workspace_dir(CORPUS)
    for _, nb in notebook._stored(ws):
        for cell in nb.get("cells") or []:
            if cell.get("id") == cid:
                cell["reads"] = ["events.jsonl"]
                notebook.write_notebook(ws, nb)
    _call(chat, 1, "mcp__plugin_thimble_thimble__add_card", {"code": "rows = load()", "question": "What happened?"},
          f"card:{cid}\n[out0]\nL1|{_lines('events.jsonl', 3, 3)[0]}")
    _call(chat, 2, "mcp__plugin_thimble_thimble__apply_label", {"name": "kind", "scope": "files",
                                                                "paths": ["agents/*.jsonl"]}, "Labeled 60 records.")
    _call(chat, 3, "mcp__plugin_thimble_thimble__apply_label", {"name": "tone", "scope": "canvas"}, "Labeled 1 card.")
    sizes = _universe()
    searched = sizes["events.jsonl"] + sum(n for f, n in sizes.items() if f.startswith("agents/"))
    assert orient_checks.coverage(CORPUS, chat).text == _line(0, searched)


def test_only_the_orientation_and_the_chats_under_it_count_never_a_critique_or_another_chat(chat):
    root = config.corpus_dir(CORPUS)
    step = agents.new_agent(CORPUS, agents.STEP_ROLE, "survey", parent=chat, announce=False)["id"]
    critic = agents.new_agent(CORPUS, agents.STEP_ROLE, "critique", parent=chat, announce=False,
                              agent_type=orient_checks.CRITIC)["id"]
    critic_step = agents.new_agent(CORPUS, agents.STEP_ROLE, "verify", parent=critic, announce=False)["id"]
    _read(chat, 1, "board.jsonl", 1, 2, at=step)
    _read(chat, 2, "events.jsonl", 1, 2, at=critic)
    _read(chat, 3, "README.md", 1, 2, at=critic_step)
    _read(agents.MAIN_ID, 4, "prompts/worker.md", 1, 2)
    _bash(chat, 5, f"cat {root}/manifest.json", "\n".join(_lines("manifest.json")), at=critic_step)
    _call(chat, 6, "Read", {"file_path": str(root / "forge.db")}, "This tool cannot read binary files.", at=step)
    _call(chat, 7, "Read", {"file_path": str(root / "events.jsonl")}, "File content too large", error=True)
    assert set(_universe()) - _never(chat) == {"board.jsonl", "forge.db"}, "its subagent's Read counts"


def test_with_no_index_yet_the_line_counts_files(chat):
    """With no index of the corpus (its job could not start), the line counts the files read and searched."""
    coverage.index_path(CORPUS).unlink()
    _read(chat, 1, "board.jsonl")
    assert orient_checks.coverage(CORPUS, chat).text == "Coverage: read 1 file"
    _bash(chat, 2, f"wc -l {config.corpus_dir(CORPUS)}/events.jsonl", "20")
    assert orient_checks.coverage(CORPUS, chat).text == "Coverage: read 1 · searched 1 files"


def test_with_the_coverage_switch_off_there_is_no_line(chat, monkeypatch):
    """The Coverage switch off: no line, and a critique's first message has the unread check."""
    monkeypatch.setattr(coverage, "feature_on", lambda c: False)
    _read(chat, 1, "board.jsonl")
    assert orient_checks.coverage(CORPUS, chat).text == ""
    assert orient_checks.check(CORPUS, chat)[0].check == "unread"


async def test_mid_run_no_call_hears_of_coverage_and_the_critique_starts_at_once(chat, critiques):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    made = await tools.call(CORPUS, "add_card", NOTE, session=orient_session.KEY)
    assert not made.is_error and "Coverage" not in made.text and "events.jsonl" not in made.text
    ran = await tools.call(CORPUS, "critique", {}, session=orient_session.KEY)
    assert len(critiques) == 1 and ran.text.endswith("Report.")


async def test_the_first_run_s_end_adds_the_line_to_its_thread_main_s_event_and_summary(chat, told, monkeypatch):
    monkeypatch.setattr(events, "LINE_CHARS", 20)  # an event's line is cut at this; the coverage line only past 3x
    for n, f in enumerate(("agents/agent-01.jsonl", "agents/agent-02.jsonl", "events.jsonl", "board.jsonl",
                           "manifest.json", "README.md", "prompts/worker.md"), 1):
        _read(chat, n, f, 1, 2)
    want = orient_checks.coverage(CORPUS, chat).text
    orient_session.subagent_ended(CORPUS, _run(chat), "done", "Done.")
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


async def test_a_message_sent_while_it_is_measured_waits_and_carries_the_line(chat, told, bridge):
    """A follow-up from the browser while the first run's coverage line is measured is held, then sent with the line
    after it (`## orient-coverage-lead`); the next one carries no line."""
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    want = orient_checks.coverage(CORPUS, chat).text
    agents.update_agent(CORPUS, chat, route="subagent", agent_id="a1")
    with subagents.update(CORPUS) as state:
        sf.registry(state)["a1"] = {"role": "orientation", "key": "orient", "chat": chat, "status": "running",
                                    "values": {"model": "m", "effort": "max"}}
    orient_session.subagent_ended(CORPUS, _run(chat), "done", "Done.")
    got = await orient_session.send(CORPUS, "And the weekends?", orient_session.BROWSER)
    assert got == {"status": "held", "chat": chat}
    await _closed()
    for _ in range(100):
        if bridge.ops("send"):
            break
        await asyncio.sleep(0.02)
    [first] = bridge.ops("send")
    assert first["text"] == "And the weekends?\n\n" + tools.hint("orient-coverage-lead", coverage=want)
    assert orientation.read_run(CORPUS)["coverage_told"] is True
    assert (await orient_session.send(CORPUS, "And Mondays?", orient_session.BROWSER))["status"] == "sent"
    assert bridge.ops("send")[-1]["text"] == "And Mondays?", "the line ends one run's prompt"


def test_a_denied_send_never_stands_for_a_request_another_send_claimed(chat):
    """The mirror reads a denied SendMessage's result in a later pass in terminal mode; by then main's next, identical
    SendMessage may have claimed the request message_orientation made for it. The denied call stands for no request
    (session._request_of), so the sent one is not marked refused (live check T5)."""
    with subagents.update(CORPUS) as state:
        sf.registry(state)["a1"] = {"role": "orientation", "key": "orient", "chat": chat, "status": "done"}
    ans = subagents.message_request(CORPUS, "a1", "And the weekends?", call="toolu_m1")
    with subagents.update(CORPUS) as state:
        assert sf.check_call(state, {"tool_name": "SendMessage", "tool_use_id": "toolu_s2",
                                     "tool_input": ans["input"]}) is None
    from types import SimpleNamespace

    from app import session

    lv = SimpleNamespace(c=CORPUS)  # all _request_of reads of the pass
    assert session._request_of(lv, "toolu_s1", "SendMessage", ans["input"]) is None
    assert session._request_of(lv, "toolu_s2", "SendMessage", ans["input"]) == ans["request"]


async def test_a_stopped_or_failed_first_run_or_a_follow_up_is_not_measured(chat, told, monkeypatch):
    async def no_measure(*a, **kw):
        raise AssertionError("not measured")

    monkeypatch.setattr(orient_session, "measure", no_measure)
    for status in ("failed", "stopped"):
        orientation.record(CORPUS, status="running")
        orient_session.subagent_ended(CORPUS, _run(chat), status, "")
        assert not orient_session.running(CORPUS) and "Coverage" not in told[-1]["text"], status
    orientation.record(CORPUS, run=1, status="running")
    orient_session.subagent_ended(CORPUS, _run(chat, k=1), "done", "Revised card 2.")
    assert not orient_session.running(CORPUS) and "Coverage" not in told[-1]["text"]


async def test_the_critic_s_first_message_has_the_line_then_the_files_neither_read_nor_searched(chat):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    _bash(chat, 2, f"grep -c merged {root}/events.jsonl", "4")
    text = await critique_session.checks_text(CORPUS, chat)
    first, second = text.splitlines()[:2]
    assert first == "- " + orient_checks.coverage(CORPUS, chat).text
    never = sorted(set(_universe()) - {"board.jsonl", "events.jsonl"})
    assert second == "- " + tools.hint("check-unread-coverage", n=str(len(never)), total=str(len(_universe())),
                                       files=", ".join(f"`{f}`" for f in never))
    assert "were opened by no card" not in text


async def test_the_critique_is_the_orientation_s_choice_with_no_switch(workspaces_tmp):
    """The orientation's prompt offers the critique whatever its start said; a start records no critique switch and
    keeps its deck; and tools._as_caller refuses the orientation neither `critique` nor a card tool, also on the record
    of an earlier version whose critique or deck was off."""
    assert "when a review would help, call `critique`" in orient_session.system_prompt(CORPUS, "")
    orientation.start_requested(CORPUS, {"text": "", "passes": ["views"], "critique": False})
    rec = orientation.read_run(CORPUS)
    assert rec["passes"] == ["final"] and "critique" not in rec and orientation.deck_of(rec)
    assert "critique" in orient_session.ORIENT_TOOLS and "propose_view" not in orient_session.ORIENT_TOOLS
    orientation._write_run(CORPUS, {**rec, "passes": ["views"], "critique": False})  # an earlier version's record
    ws = config.workspace_dir(CORPUS)
    with subagents.update(CORPUS) as state:
        sf.registry(state)["orient1"] = {"key": orient_session.KEY, "role": "orientation", "status": "running"}
    sf.add_caller(ws, "toolu_o1", "orient1", "thimble:orientation")
    sf.add_caller(ws, "toolu_o2", "orient1", "thimble:orientation")
    assert await tools._as_caller(CORPUS, "critique", "toolu_o1") == ("", orient_session.KEY)
    assert await tools._as_caller(CORPUS, "add_card", "toolu_o2") == ("", orient_session.KEY)
