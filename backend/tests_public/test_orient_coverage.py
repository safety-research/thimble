"""The orientation hears which corpus files it never opened (orient_session.coverage): its first run's first add_card
names them after the card is made, its critique call names them in place of the critique, at most twice a run, and a
follow-up hears nothing. A file only a survey's listing named, or only a sibling of which was read, is unopened; one a
command named, by its path, its folder's path or a wildcard pattern, is opened, and a word of prose names no folder."""
from __future__ import annotations

import pytest

from app import agents, calls, config, corpus as corpus_mod, critique_session, orient_checks, orient_session, \
    orientation, records, tools

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


@pytest.fixture()
def critiques(monkeypatch) -> list[dict]:
    """The critiques that started, each answering `Report.`"""
    started: list[dict] = []

    async def fake(ctx, args):
        started.append(args)
        return tools.ok("Report.")

    monkeypatch.setattr(critique_session, "tool_critique", fake)
    return started


def _files() -> list[str]:
    return [s["path"] for s in corpus_mod.list_sources(config.corpus_dir(CORPUS)) if not s.get("hidden")]


def _bash(chat: str, n: int, command: str, result: str = "") -> None:
    calls.number(CORPUS, chat, f"toolu_{n}", "Bash", {"command": command})
    calls.result(CORPUS, chat, f"toolu_{n}", result)


def test_a_listed_file_or_a_sibling_of_a_read_one_is_unopened_and_named_with_its_records_and_share(chat):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"find {root} -type f", "\n".join(f"{root}/{f}" for f in _files()))
    _bash(chat, 2, f"head -3 {root}/board.jsonl {root}/agents/agent-01.jsonl")
    _bash(chat, 3, f"cat {root}/*.md && sqlite3 {root}/forge.db .tables")
    assert not [f for f in orient_checks.check(CORPUS) if f.check == "unread"], "the critic's check counts them as read"
    [found] = orient_checks.unopened(CORPUS)
    text = found.text
    for opened in ("board.jsonl", "agents/agent-01.jsonl", "README.md", "prompts/worker.md", "forge.db"):
        assert f"`{opened}`" not in text
    for unopened in ("agents/agent-02.jsonl", "agents/agent-03.jsonl", "events.jsonl"):
        assert f"`{unopened}`: {records.count(root / unopened, unopened):,} records, " in text
    assert "of the corpus" in text and str(root) in text
    files = set(_files())
    agents_files = {f for f in files if f.startswith("agents/")}
    for command in (f"ls {root}/agents", "ls agents/", f"cat {root}/agents/*.jsonl", "wc -l agent-0?.jsonl"):
        assert orient_checks._read_by_calls(command, root, files, whole=True) == agents_files, command
    assert orient_checks._read_by_calls("Three agents posted on the board.", root, files, whole=True) == set()


def test_past_the_listed_count_files_are_named_by_kind_and_a_kind_of_one_by_its_path(chat, monkeypatch):
    monkeypatch.setattr(orient_checks, "UNREAD_LISTED", 3)
    [found] = orient_checks.unopened(CORPUS)
    rows = [line for line in found.text.splitlines() if line.startswith("- ")]
    assert rows[1].startswith("- `agents/agent-*.jsonl`: 3 files, ")
    assert rows[0].startswith("- `forge.db`: ") and " records, " in rows[0] and " records, " in rows[2]
    assert len(rows) == 4 and rows[-1].endswith("more kinds of file")


async def test_the_first_card_then_the_critique_get_the_note_and_the_next_critique_runs(chat, critiques):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, f"head -3 {root}/board.jsonl")
    first = await tools.call(CORPUS, "add_card", NOTE, session=orient_session.KEY)
    assert not first.is_error, first.text
    assert first.text.index("card:") < first.text.index("`events.jsonl`"), "the card is made, then the note follows"
    assert first.text.endswith(tools.hint("orient-unopened-card"))
    second = await tools.call(CORPUS, "add_card", {**NOTE, "question": "Who posts?"}, session=orient_session.KEY)
    assert "`events.jsonl`" not in second.text
    held = await tools.call(CORPUS, "critique", {}, session=orient_session.KEY)
    assert critiques == [] and "`events.jsonl`" in held.text
    assert held.text.endswith(tools.hint("orient-unopened-critique"))
    ran = await tools.call(CORPUS, "critique", {}, session=orient_session.KEY)
    assert len(critiques) == 1 and ran.text.endswith("Report.")
    assert orientation.read_run(CORPUS)["coverage"] == orient_session.COVERAGE_NOTES


async def test_with_every_file_opened_nothing_is_said_and_the_checks_stop(chat, critiques, monkeypatch):
    root = config.corpus_dir(CORPUS)
    _bash(chat, 1, "wc -l " + " ".join(f"{root}/{f}" for f in _files()))
    made = await tools.call(CORPUS, "add_card", NOTE, session=orient_session.KEY)
    assert not made.is_error and "never opened" not in made.text

    async def no_check(*a, **kw):
        raise AssertionError("the checks ended once every file was opened")

    monkeypatch.setattr(orient_checks, "check_apart", no_check)
    ran = await tools.call(CORPUS, "critique", {}, session=orient_session.KEY)
    assert len(critiques) == 1 and ran.text.endswith("Report.")


async def test_a_follow_up_hears_nothing(chat, critiques, monkeypatch):
    async def no_check(*a, **kw):
        raise AssertionError("a follow-up runs no coverage check")

    monkeypatch.setattr(orient_checks, "check_apart", no_check)
    orientation.record(CORPUS, run=1)
    made = await tools.call(CORPUS, "add_card", NOTE, session=orient_session.KEY)
    assert not made.is_error and "never opened" not in made.text
    await tools.call(CORPUS, "critique", {}, session=orient_session.KEY)
    assert len(critiques) == 1
