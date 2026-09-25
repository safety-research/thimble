"""orient_checks.py at the scale of a large corpus: hundreds of kinds of JSON Lines file with dozens of fields each, and
megabytes of the orientation's call output. The checks look each field and path up in the words of the text, split once,
so they finish in seconds whether the fields are named or not. The records are sampled one kind of file at a time until
the check has its findings, within a cap on kinds and bytes, and the critique runs the checks in a child process of
their own."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from app import agents, calls, config, corpus, orient_checks

CORPUS = "wide"
KINDS = 700
FIELDS = 45
CALLS_CHARS = 9_000_000


@pytest.fixture()
def wide(tmp_path, monkeypatch, workspaces_tmp) -> list[str]:
    """A corpus of KINDS JSON Lines files, each its own kind (the names differ in letters, not digits alone) with
    FIELDS fields of its own, half of them in folders of their own; returns the files' corpus paths."""
    data = tmp_path / "data"
    root = data / CORPUS
    root.mkdir(parents=True)
    (root / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    rels = []
    for k in range(KINDS):
        name = f"k{k:03d}".translate(str.maketrans("0123456789", "abcdefghij"))
        rel = f"logs/{name}.jsonl" if k % 2 else f"{name}/events.jsonl"
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        records = [{"type": f"{name}ev{i % 4}", **{f"{name}f{j}": i for j in range(FIELDS - 1)}} for i in range(12)]
        (root / rel).write_text("".join(json.dumps(r) + "\n" for r in records))
        rels.append(rel)
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    calls.forget()
    yield rels
    calls.forget()


def _orientation_calls(rels: list[str], print_fields: bool) -> None:
    """Store about CALLS_CHARS of call text in one orientation chat: each call `cat`s a share of the files and prints
    filler words up to CALL_TEXT_CHARS, after the field names and kinds of record of its files when `print_fields`."""
    chat = str(agents.new_agent(CORPUS, "orient", "Orientation", session="s-1")["id"])
    per = orient_checks.CALL_TEXT_CHARS - 20_000
    n = CALLS_CHARS // per + 1
    for i in range(n):
        tid, mine = f"t{i}", rels[i::n]
        printed = []
        for rel in mine if print_fields else []:
            for line in (config.corpus_dir(CORPUS) / rel).read_text().splitlines():
                rec = json.loads(line)
                printed += [*rec, rec["type"]]
        head = " ".join(printed)
        filler = ("reading the records again " * (per // 26 + 1))[: per - len(head)]
        calls.number(CORPUS, chat, tid, "Bash", {"command": " ; ".join(f"cat {r}" for r in mine)}, at=chat)
        calls.result(CORPUS, chat, tid, head + "\n" + filler)


def test_the_checks_of_a_wide_corpus_finish_in_seconds_when_no_field_is_named(wide):
    _orientation_calls(wide, print_fields=False)
    started = time.monotonic()
    found = orient_checks.check(CORPUS)
    took = time.monotonic() - started
    assert took < 5, f"the coverage checks took {took:.1f} s"
    unused = [f for f in found if f.check == "unused"]
    assert len(unused) == orient_checks.UNUSED_LISTED, "the check stops at the findings it names"
    assert [f.check for f in found if f.check == "unread"] == ["unread"], "the manifest alone is unread"
    assert "manifest.json" in found[0].text


def test_the_checks_of_a_wide_corpus_finish_in_seconds_when_every_field_is_named(wide):
    _orientation_calls(wide, print_fields=True)
    started = time.monotonic()
    found = orient_checks.check(CORPUS)
    took = time.monotonic() - started
    assert took < 5, f"the coverage checks took {took:.1f} s, with every field looked up"
    assert not [f for f in found if f.check == "unused"], "every field and value is named in a call"


@pytest.mark.parametrize(("text", "word", "named"), [
    ("counted the tool_use records", "tool_use", True),
    ("counted the tool_uses", "tool_use", False),
    ("a tool-use event", "tool-use", True),
    ("a tool-used event", "tool-use", False),
    ("a tool and a use", "tool-use", False),
    ("Session.Start at noon", "session.start", True),
    ("the cafés", "café", False),
])
def test_a_field_is_named_as_a_whole_word_without_case(text, word, named):
    assert orient_checks._Text(text).names(word) is named


def test_a_file_is_named_by_whole_components_and_a_folder_at_the_start_of_a_path():
    files = {"logs/a.jsonl", "logs/b.jsonl", "notes/a.md", "top.csv"}
    read = orient_checks._read_by_calls
    assert read("wc -l ./logs/a.jsonl.", Path("/c"), files) == {"logs/a.jsonl"}, "a path ending a sentence is named"
    assert read("zcat top.csv.gz", Path("/c"), files) == set(), "a longer file name is another file"
    assert read("cat /c/top.csv /c/notes/", Path("/c"), files) == {"top.csv", "notes/a.md"}
    assert read("ls oldlogs/ backups/logs.tar", Path("/c"), files) == set()


@pytest.mark.parametrize(("one", "other"), [
    ("run-7/log.jsonl", "run-12/log.jsonl"),
    ("a/session-data/8c85a272-ab44-40b4-a770-55c2a33015eb/subagents/agent-a5fed5eb29b604d26.jsonl",
     "a/session-data/1b2e3f40-aeef-4c1e-9a52-6f3d8e2b7c10/subagents/agent-0b1c2d3e4f5a6b7c8.jsonl"),
    ("a/subagents/workflows/wf_d14c34b0-33a/journal.jsonl", "a/subagents/workflows/wf_9e0f1a2b-7f2/journal.jsonl"),
    ("eval/step10_S.jsonl", "eval/step250_S.jsonl"),
])
def test_a_kind_of_file_masks_the_ids_in_its_path(one, other):
    assert orient_checks._kind_key(one) == orient_checks._kind_key(other)


@pytest.mark.parametrize(("one", "other"), [
    ("logs/events.jsonl", "logs/errors.jsonl"),
    ("a/transcript.jsonl", "b/transcript.jsonl"),
])
def test_files_of_other_names_are_other_kinds(one, other):
    assert orient_checks._kind_key(one) != orient_checks._kind_key(other)


def _counting(monkeypatch, root: Path) -> list[str]:
    """The corpus paths of the files the unused-field check samples, in order."""
    sampled: list[str] = []
    real = orient_checks._sample_lines

    def sample(path: Path) -> list[bytes]:
        sampled.append(path.relative_to(root).as_posix())
        return real(path)

    monkeypatch.setattr(orient_checks, "_sample_lines", sample)
    return sampled


def test_the_sampling_stops_once_the_check_has_its_findings(wide, monkeypatch):
    """Each kind of the wide corpus has more unused fields than one kind may name, so the check has its findings after
    UNUSED_LISTED / UNUSED_PER_KIND kinds and reads no further file."""
    _orientation_calls(wide, print_fields=False)
    sampled = _counting(monkeypatch, config.corpus_dir(CORPUS))
    unused = [f for f in orient_checks.check(CORPUS) if f.check == "unused"]
    assert len(unused) == orient_checks.UNUSED_LISTED
    assert len(sampled) == orient_checks.UNUSED_LISTED // orient_checks.UNUSED_PER_KIND


def test_the_sampling_is_capped_and_spread_over_the_corpus_when_every_field_is_named(wide, monkeypatch):
    _orientation_calls(wide, print_fields=True)
    sampled = _counting(monkeypatch, config.corpus_dir(CORPUS))
    monkeypatch.setattr(orient_checks, "KINDS_SAMPLED", 50)
    assert not [f for f in orient_checks.check(CORPUS) if f.check == "unused"]
    assert len(sampled) == 50
    order = [s["path"] for s in corpus.list_sources(config.corpus_dir(CORPUS)) if s["path"] in wide]
    first, last = order.index(sampled[0]), order.index(sampled[-1])
    assert first < len(order) // 10 and last > len(order) * 9 // 10, "the sampled kinds reach both ends of the corpus"


def test_the_sampling_stops_at_its_byte_budget(wide, monkeypatch):
    _orientation_calls(wide, print_fields=True)
    sampled = _counting(monkeypatch, config.corpus_dir(CORPUS))
    size = (config.corpus_dir(CORPUS) / wide[0]).stat().st_size
    monkeypatch.setattr(orient_checks, "SAMPLE_TOTAL_BYTES", size * 10)
    orient_checks.check(CORPUS)
    assert 9 <= len(sampled) <= 12, "files of about the same size, ten of which fill the budget"


async def test_the_checks_run_apart_in_a_child_process_that_reads_the_same_workspace(wide):
    """The critique runs the checks in a child process, so the server's threads never wait on them (module note). The
    child is given the folders of the workspace and the registry the server reads, here the test's own."""
    _orientation_calls(wide, print_fields=False)
    apart = await orient_checks.check_apart(CORPUS)
    assert apart == orient_checks.check(CORPUS) and len(apart) == 1 + orient_checks.UNUSED_LISTED


async def test_a_child_that_runs_too_long_is_stopped_and_says_so(wide):
    with pytest.raises(TimeoutError):
        await orient_checks.check_apart(CORPUS, timeout_s=0.01)


async def test_the_child_names_a_corpus_that_is_gone(workspaces_tmp):
    with pytest.raises(ValueError, match="gone-corpus"):
        await orient_checks.check_apart("gone-corpus")
