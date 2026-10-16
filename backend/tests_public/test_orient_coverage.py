"""The orientation's coverage line (orient_checks.coverage, orient_session.measure): when its first run finishes,
thimble measures what the orientation and its agents saw of the corpus, by the lines and records their tool outputs
showed (a Read's numbered lines; the output lines of a command, a card or a thimble tool that are lines of a file the
call names, or pieces of one), and adds `Coverage: viewed only <globs> · N% of files · M% of lines` (records, where a
file is not read by lines) to its transcript as the analyst and the agents see it: a note at the end of its thread, a
second line of main's `orient` event and of summary.md, and the end of the next run's prompt, after its messages. A
command that only counted or listed shows no line and counts nothing. Mid-run the orientation hears nothing of it: its
add_card and critique calls get no note. A critique's first message has the line in place of the unread check. The
critique is the orientation's own choice: its prompt offers it, no switch of a start turns it on or off, and its tool
answers whatever an earlier version's record says."""
from __future__ import annotations

import asyncio

import pytest

from app import (agents, calls, config, corpus as corpus_mod, events, orient_checks, orient_session,
                 orientation, records, subagents)
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"


@pytest.fixture()
async def chat(workspaces_tmp):
    """The orientation's chat, its first run going."""
    calls.forget()
    made = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, announce=False, brief="")["id"]
    orientation.started(CORPUS, made)
    yield made
    calls.forget()
    orient_session._closing.pop(CORPUS, None)


@pytest.fixture()
def told(monkeypatch) -> list[dict]:
    """The events main was told, as tell_main posts them."""
    out: list[dict] = []
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: out.append({"kind": kind, **payload}))
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


def _run(chat: str, k: int = 0) -> subagents.Run:
    return subagents.Run(CORPUS, orient_session.KEY, "orientation", chat, "a1", k=k)


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


async def test_the_first_run_s_end_adds_the_line_to_its_thread_main_s_event_and_summary(chat, told, monkeypatch):
    monkeypatch.setattr(events, "LINE_CHARS", 100)  # an event's line is cut at this; the coverage line only past 3x
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
