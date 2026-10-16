"""The coverage facts of stored tool calls (app/call_facts.py), the twin of the terminal UI's tracker for the calls
thimble stored: a Bash command's reads follow the tracker's case list (plugin/hooks/term/tests/bash-read-cases.ts); a
Read is whole when its output numbered the file's first line through its last, else in part with its lines and the
file's line count; a PDF by its pages, a database searched, an unchanged file nothing; the files a `grep -l` printed
searched; a Grep over a folder one folder fact; a failed call, a file outside the corpus and a code file nothing."""
from __future__ import annotations

import json
import re
from pathlib import Path

from app import call_facts

HERE = Path(__file__).resolve().parent
CASES = HERE.parent.parent / "plugin" / "hooks" / "term" / "tests" / "bash-read-cases.ts"


def _cases() -> list:
    text = CASES.read_text("utf-8")
    body = text.split("// cases-json-start", 1)[1].split("// cases-json-end", 1)[0]
    return json.loads(re.sub(r"^\s*export const CASES: BashCase\[\] = ", "", body.strip()))


def test_bash_reads_follow_the_tracker_s_case_list():
    cases = _cases()
    assert len(cases) >= 60
    wrong = []
    for command, want in cases:
        got = [[r["reader"], r["path"], r["how"], r.get("lines"), bool(r.get("recursive"))]
               for r in call_facts.bash_reads(command)]
        if got != want:
            wrong.append((command, want, got))
    assert not wrong, wrong


def _corpus(tmp_path: Path) -> Path:
    root = tmp_path / "corpus"
    (root / "agents").mkdir(parents=True)
    (root / "events.jsonl").write_text("".join(json.dumps({"e": n}) + "\n" for n in range(30)))
    (root / "board.jsonl").write_text("".join(json.dumps({"b": n}) + "\n" for n in range(5)))
    for i in (1, 2):
        (root / "agents" / f"a{i}.jsonl").write_text(json.dumps({"a": i}) + "\n")
    (root / "paper.pdf").write_bytes(b"%PDF-1.4\n")
    (root / "forge.db").write_bytes(b"SQLite format 3\0")
    (root / "notes.py").write_text("print(1)\n")
    return root


def _read_out(a: int, b: int) -> str:
    return "\n".join(f"{n:>6}\t{{\"e\": {n - 1}}}" for n in range(a, b + 1))


def _facts(root: Path, name: str, inp: dict, result: str = "", **kw) -> list[dict]:
    return [{k: v for k, v in f.items() if k not in ("by", "at")}
            for f in call_facts.facts_of(root, {"name": name, "input": inp, "result": result, **kw})]


def test_a_read_is_whole_from_the_first_line_to_the_last_else_a_part_with_the_file_s_line_count(tmp_path):
    root = _corpus(tmp_path)
    ev = str(root / "events.jsonl")
    assert _facts(root, "Read", {"file_path": ev}, _read_out(1, 30)) == [{"path": "events.jsonl", "how": "whole"}]
    assert _facts(root, "Read", {"file_path": ev, "offset": 11, "limit": 5}, _read_out(11, 15)) == [
        {"path": "events.jsonl", "how": "part", "lines": [11, 15], "total": 30}]
    assert _facts(root, "Read", {"file_path": ev}, _read_out(1, 12)) == [
        {"path": "events.jsonl", "how": "part", "lines": [1, 12], "total": 30}], "cut short by its token cap"
    # an output numbered as Claude Code numbers it, with an arrow
    arrows = "\n".join(f"     {n}→x" for n in range(1, 6))
    assert _facts(root, "Read", {"file_path": "board.jsonl"}, arrows) == [{"path": "board.jsonl", "how": "whole"}]
    assert _facts(root, "Read", {"file_path": str(root / "paper.pdf")}, "") == [{"path": "paper.pdf", "how": "whole"}]
    assert _facts(root, "Read", {"file_path": str(root / "paper.pdf"), "pages": "3-7"}, "") == [
        {"path": "paper.pdf", "how": "part", "pages": [3, 7]}]
    assert _facts(root, "Read", {"file_path": str(root / "forge.db")}, "binary") == [{"path": "forge.db", "how": "searched"}]
    assert _facts(root, "Read", {"file_path": ev}, "File unchanged since last read.") == []
    assert _facts(root, "Read", {"file_path": ev}, _read_out(1, 30), is_error=True) == []
    assert _facts(root, "Read", {"file_path": str(root / "notes.py")}, "     1\tprint(1)") == [], "a code file"
    assert _facts(root, "Read", {"file_path": str(tmp_path / "work" / "dump.jsonl")}, _read_out(1, 3)) == []


def test_bash_reads_become_facts_of_the_corpus_s_data_files(tmp_path):
    root = _corpus(tmp_path)
    got = _facts(root, "Bash", {"command": f"cd {root} && head -n 5 events.jsonl; cat board.jsonl; wc -l agents/a1.jsonl"})
    assert got == [{"path": "events.jsonl", "how": "part", "lines": [1, 5], "total": 30},
                   {"path": "board.jsonl", "how": "whole"}, {"path": "agents/a1.jsonl", "how": "searched"}]
    assert _facts(root, "Bash", {"command": "grep -rn x agents/"}) == [
        {"path": "agents", "how": "searched", "folder": True}]
    assert _facts(root, "Bash", {"command": "python3 dump.py events.jsonl > /tmp/work/diffs.jsonl"}) == [
        {"path": "events.jsonl", "how": "searched"}]
    # what a call only names (an echo, a file outside the corpus) is no fact
    assert _facts(root, "Bash", {"command": "echo 'leave out events.jsonl and board.jsonl'; cat /tmp/work/diffs.jsonl"},
                  '{"e": 1}\n{"b": 2}') == []
    assert _facts(root, "Bash", {"command": "grep -l '\"a\"' agents/*.jsonl"}, "agents/a1.jsonl\nagents/a2.jsonl\n") == [
        {"path": "agents/a1.jsonl", "how": "searched"}, {"path": "agents/a2.jsonl", "how": "searched"}]


def test_a_grep_call_searches_a_file_or_a_folder(tmp_path):
    root = _corpus(tmp_path)
    assert _facts(root, "Grep", {"pattern": "x", "path": str(root / "events.jsonl")}) == [
        {"path": "events.jsonl", "how": "searched"}]
    assert _facts(root, "Grep", {"pattern": "x"}) == [{"path": ".", "how": "searched", "folder": True}]
    assert _facts(root, "Glob", {"pattern": "*.jsonl"}) == []
