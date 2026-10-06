"""The orientation's coverage line (orient_checks.coverage, orient_session.measure): when its first run finishes,
thimble measures what the orientation and its agents saw of the corpus, by the lines and records their tool outputs
showed (a Read's numbered lines; the output lines of a command, a card or a thimble tool that are lines of a file the
call names, or pieces of one), and adds `Coverage: viewed only <globs> · N% of files · M% of lines` (records, where a
file is not read by lines) to its transcript as the analyst and the agents see it: a note at the end of its thread, a
second line of main's `orient` event and of summary.md, and the end of the next run's prompt, after its messages. A
command that only counted or listed shows no line and counts nothing. Mid-run the orientation hears nothing of it: its
add_card and critique calls get no note. A critique's first message has the line in place of the unread check. The
critique itself is off unless Start or the call turns it on."""
from __future__ import annotations

import asyncio
import json

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


def _call(chat: str, n: int, name: str, inp: dict, result: str, at: str | None = None, error: bool = False) -> None:
    calls.number(CORPUS, chat, f"toolu_{n}", name, inp, **({"at": at} if at else {}))
    calls.result(CORPUS, chat, f"toolu_{n}", result, is_error=error)


def _bash(chat: str, n: int, command: str, result: str = "", at: str | None = None) -> None:
    _call(chat, n, "Bash", {"command": command}, result, at)


def _lines(rel: str, a: int = 1, b: int | None = None) -> list[str]:
    """Lines a to b (1-based, b included) of a corpus file."""
    return (config.corpus_dir(CORPUS) / rel).read_text().splitlines()[a - 1:b]


def _read(chat: str, n: int, rel: str, a: int = 1, b: int | None = None, at: str | None = None) -> None:
    """A Read of lines a to b of a corpus file, its output numbered as Read numbers it."""
    numbered = "\n".join(f"{k}\t{line}" for k, line in enumerate(_lines(rel, a, b), a))
    _call(chat, n, "Read", {"file_path": str(config.corpus_dir(CORPUS) / rel), "offset": a}, numbered, at)


def _run(chat: str) -> agent_session.Run:
    return agent_session.Run(CORPUS, orient_session.KEY, chat, "sid-o", config.corpus_dir(CORPUS), orientation.ROLE)


async def _closed() -> None:
    for _ in range(400):
        if not orient_session._closing:
            return
        await asyncio.sleep(0.025)
    raise AssertionError("the first run's end was never measured")


def _shares(seen: dict[str, int]) -> str:
    """The end of the line when `seen` {file: lines seen} is what the orientation saw."""
    root = config.corpus_dir(CORPUS)
    counts = {f: records.count(root / f, f) for f in _sizes()}
    part = orient_checks._share(sum(seen.values()), sum(counts.values()))
    return f"{orient_checks._share(len(seen), len(counts))} of files · {part} of records"


def _seen(chat: str) -> dict[str, set[int]]:
    return orient_checks._seen(CORPUS, config.corpus_dir(CORPUS), _sizes(), orient_checks._orientation_chats(CORPUS, chat))


def test_a_read_counts_the_lines_its_output_numbers(chat):
    """A Read shows the lines its output numbers, from an absolute path or one in the corpus; a Read that failed, or of
    a file outside the corpus, shows none."""
    _read(chat, 1, "agents/agent-01.jsonl", 3, 6)
    _call(chat, 2, "Read", {"file_path": "board.jsonl"}, "\n".join(f"{k}\t{x}" for k, x in enumerate(_lines("board.jsonl"), 1)))
    _call(chat, 3, "Read", {"file_path": str(config.corpus_dir(CORPUS) / "events.jsonl")}, "File content too large", error=True)
    _call(chat, 4, "Read", {"file_path": "/etc/hostname"}, "1\thost")
    assert _seen(chat) == {"agents/agent-01.jsonl": {3, 4, 5, 6}, "board.jsonl": set(range(1, 9))}
    assert orient_checks.coverage(CORPUS, chat).text == (
        "Coverage: viewed only agents/agent-01.jsonl, board.jsonl · "
        + _shares({"agents/agent-01.jsonl": 4, "board.jsonl": 8}))


def test_head_sed_and_a_cut_line_count_the_lines_they_printed(chat):
    """`head` and `sed -n` print lines of the files they name, each found whole; a line `head -c` cut short is found by
    a piece of it."""
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"cd {root} && head -3 board.jsonl", "\n".join(_lines("board.jsonl", 1, 3)))
    _bash(chat, 2, f"sed -n '5,6p' {root}/events.jsonl", "\n".join(_lines("events.jsonl", 5, 6)))
    _bash(chat, 3, f"head -c 150 {root}/agents/agent-02.jsonl", _lines("agents/agent-02.jsonl", 1, 1)[0][:150])
    assert _seen(chat) == {"board.jsonl": {1, 2, 3}, "events.jsonl": {5, 6}, "agents/agent-02.jsonl": {1}}


def test_a_command_that_only_counts_or_lists_views_nothing(chat):
    """wc -l, ls, find and grep -c name files and print counts and names but no line of a file."""
    root = config.corpus_dir(CORPUS)
    sizes = _sizes()
    counts = {f: records.count(root / f, f) for f in sizes}
    jsonl = [f for f in sizes if f.endswith(".jsonl")]
    _bash(chat, 1, f"wc -l {root}/*.jsonl {root}/agents/*",
          "\n".join(f"{counts[f]:>8} {root}/{f}" for f in jsonl) + f"\n{sum(counts[f] for f in jsonl):>8} total")
    _bash(chat, 2, "ls -la agents/", "\n".join(f"-rw-rw-r-- 1 a a {sizes[f]:>6} Oct  6 04:08 {f.split('/')[-1]}"
                                                for f in jsonl if f.startswith("agents/")))
    _bash(chat, 3, f"find {root} -type f && ls agents/*.jsonl",
          "\n".join(f"{root}/{f}" for f in sizes) + "\n" + "\n".join(f for f in jsonl if f.startswith("agents/")))
    _bash(chat, 4, f"cd {root} && grep -c agent events.jsonl board.jsonl", "events.jsonl:20\nboard.jsonl:8")
    assert _seen(chat) == {}
    assert orient_checks.coverage(CORPUS, chat).text == "Coverage: viewed no file · 0% of files · 0% of records"


def test_a_script_s_printed_fields_and_table_rows_count_the_records_they_came_from(chat):
    """A script that prints fields of records, cut short, after another field or as the rows of a table, shows the
    records they came from; so do the rows a database query prints."""
    root = config.corpus_dir(CORPUS)
    posts = [json.loads(x) for x in _lines("board.jsonl")]
    script = f"cd {root} && python3 - <<'EOF'\nimport json\nfor line in open('board.jsonl'):\n    r = json.loads(line)\n"
    printed = "\n".join(f"{r['author']} {r['body'].splitlines()[0][:70]}" for r in posts[:2])
    _bash(chat, 1, script + "    print(r['author'], r['body'][:70])\nEOF", printed)
    table = "   id    author                                               body\n" + "\n".join(
        f"{i}  {r['id']:>3}  {r['author']}  {r['body'].splitlines()[0][:47]}..." for i, r in enumerate(posts[3:5]))
    _bash(chat, 2, script + "EOF\npython3 -c 'import pandas as pd; print(pd.read_json(\"board.jsonl\", lines=True))'", table)
    subset = json.dumps({k: posts[6][k] for k in ("id", "author", "created_at")})
    _bash(chat, 3, script + "    print(json.dumps({k: r[k] for k in ('id', 'author', 'created_at')}))\nEOF", subset)
    _bash(chat, 4, f"sqlite3 {root}/forge.db 'select * from prs limit 2'",
          "7101|Document the two line-break modes|Document the two line-break modes.\n"
          "7114|Quote the style name in the configuration example|Quote the style name in the configuration example.")
    got = _seen(chat)
    assert got["board.jsonl"] == {1, 2, 4, 5, 7}
    assert len(got["forge.db"]) == 2 and set(got) == {"board.jsonl", "forge.db"}


def test_a_line_found_in_more_files_than_shared_max_counts_in_none(chat, monkeypatch):
    """Text that many of the named files hold, such as a field's name, identifies no record."""
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"grep -oh cache_read_input_tokens {root}/agents/*.jsonl | sort -u", "cache_read_input_tokens")
    assert set(_seen(chat)) == {f for f in _sizes() if f.startswith("agents/")}
    monkeypatch.setattr(orient_checks, "SHARED_MAX", 2)
    assert _seen(chat) == {}


async def test_a_card_s_output_counts_by_the_files_its_code_read(chat):
    """add_card's result shows the start of the card's outputs: a line of a file the card's code read counts, though
    the code names no file."""
    from app import notebook

    made = await tools.call(CORPUS, "add_card", NOTE, session=orient_session.KEY)
    cid = made.text.split("card:", 1)[1].split()[0].strip("`.,)")
    echo = f"$ add_card question=\"{'What happened first, and then? ' * 10}\" code=\"rows = load()\" takeaway=\"[[3|card:x1]]\""
    result = f"{echo}\ncard:{cid}\n[out0]\nL1|{_lines('events.jsonl', 3, 3)[0]}"
    _call(chat, 1, "mcp__plugin_thimble_thimble__add_card", {"code": "rows = load()", "question": "What happened?"}, result)
    assert _seen(chat) == {}, "its code names no file, and the card read none"
    ws = config.workspace_dir(CORPUS)
    for _, nb in notebook._stored(ws):
        for cell in nb.get("cells") or []:
            if cell.get("id") == cid:
                cell["reads"] = ["events.jsonl"]
                notebook.write_notebook(ws, nb)
    assert _seen(chat) == {"events.jsonl": {3}}


def test_only_the_orientation_and_the_chats_under_it_count_never_a_critique_or_another_chat(chat):
    root = config.corpus_dir(CORPUS)
    step = agents.new_agent(CORPUS, agent_session.STEP_ROLE, "survey", parent=chat, announce=False)["id"]
    critic = agents.new_agent(CORPUS, agent_session.STEP_ROLE, "critique", parent=chat, announce=False,
                              agent_type=orient_checks.CRITIC)["id"]
    critic_step = agents.new_agent(CORPUS, agent_session.STEP_ROLE, "verify", parent=critic, announce=False)["id"]
    _read(chat, 1, "board.jsonl", 1, 2, at=step)
    _read(chat, 2, "events.jsonl", 1, 2, at=critic)
    _read(chat, 3, "README.md", 1, 2, at=critic_step)
    _read(agents.MAIN_ID, 4, "prompts/worker.md", 1, 2)
    _bash(chat, 5, f"cat {root}/manifest.json", "\n".join(_lines("manifest.json")), at=critic_step)
    assert _seen(chat) == {"board.jsonl": {1, 2}}, "its subagent's Read counts"


def test_with_every_file_viewed_the_line_says_so_and_groups_by_glob_short_of_it(chat, monkeypatch):
    sizes = _sizes()
    n = 0
    for f in sizes:
        if f != "forge.db":
            n += 1
            _read(chat, n, f, 1, 1)
    text = orient_checks.coverage(CORPUS, chat).text
    assert text.startswith("Coverage: viewed only agents/*.jsonl, ") and "forge.db" not in text
    _bash(chat, n + 1, f"sqlite3 {config.corpus_dir(CORPUS)}/forge.db 'select title from prs limit 1'",
          "Document the two line-break modes")
    seen = {f: 1 for f in sizes}
    assert orient_checks.coverage(CORPUS, chat).text == "Coverage: viewed every file · " + _shares(seen)
    monkeypatch.setattr(orient_checks, "LINE_READERS", ("lines", "csv", "sqlite", "json"))
    assert orient_checks.coverage(CORPUS, chat).text.endswith(" of lines"), "lines where every file is read by lines"


def test_a_glob_viewed_in_part_past_its_named_files_gives_its_count(chat, monkeypatch):
    monkeypatch.setattr(orient_checks, "COVERAGE_NAMED", 1)
    _read(chat, 1, "agents/agent-01.jsonl", 1, 1)
    _read(chat, 2, "agents/agent-02.jsonl", 1, 1)
    assert orient_checks.coverage(CORPUS, chat).text.startswith("Coverage: viewed only agents/*.jsonl (2 of 3 files) · ")


def test_past_its_globs_it_groups_by_top_folder_and_counts_the_rest(chat, monkeypatch):
    monkeypatch.setattr(orient_checks, "COVERAGE_GLOBS", 3)
    monkeypatch.setattr(orient_checks, "COVERAGE_LISTED", 2)
    for n, f in enumerate(("agents/agent-01.jsonl", "agents/agent-02.jsonl", "agents/agent-03.jsonl", "board.jsonl",
                           "prompts/worker.md"), 1):
        _read(chat, n, f, 1, 1)
    text = orient_checks.coverage(CORPUS, chat).text
    assert text.startswith("Coverage: viewed only agents/**, board.jsonl, and 1 more · "), text


def test_past_its_byte_budget_records_are_estimated_and_marked(chat, monkeypatch):
    monkeypatch.setattr(orient_checks, "COUNT_BYTES", 10_000)
    _read(chat, 1, "board.jsonl", 1, 3)
    assert " · ~" in orient_checks.coverage(CORPUS, chat).text


async def test_mid_run_no_call_hears_of_coverage_and_the_critique_starts_at_once(chat, critiques):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    made = await tools.call(CORPUS, "add_card", NOTE, session=orient_session.KEY)
    assert not made.is_error and "Coverage" not in made.text and "events.jsonl" not in made.text
    ran = await tools.call(CORPUS, "critique", {}, session=orient_session.KEY)
    assert len(critiques) == 1 and ran.text.endswith("Report.")


async def test_the_first_run_s_end_adds_the_line_to_its_thread_main_s_event_and_summary(chat, told, monkeypatch):
    monkeypatch.setattr(events, "LINE_CHARS", 100)  # an event's line is cut at this; the coverage line only past 3x
    for n, f in enumerate(("agents/agent-01.jsonl", "agents/agent-02.jsonl", "events.jsonl", "board.jsonl",
                           "manifest.json", "README.md", "prompts/worker.md"), 1):
        _read(chat, n, f, 1, 2)
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
