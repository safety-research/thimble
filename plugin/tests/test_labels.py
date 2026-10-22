"""Labels (engine/kernel/labels.py, `thimble label`): a category given to every record of a scope by a regex, code, the
model (records that wait for its reads) or Claude's own values; counts per value as plain numbers; the person's checks;
and what coverage counts of a label. Run: python3 -m pytest plugin/tests/test_labels.py"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import coverage as CV  # noqa: E402
from kernel import labels as LB  # noqa: E402
from kernel.store import Store  # noqa: E402

LEAN = Path(__file__).resolve().parents[1] / "bin" / "thimble"

MESSAGES = [
    ("wren", "I'm sorry, I broke the build with my last commit."),
    ("moss", "Merged the fix for the parser."),
    ("wren", "Apologies for the noise, wrong channel."),
    ("fern", "Running the test suite now."),
    ("moss", "My mistake: I misread the spec, reverting."),
    ("fern", "Done. All 40 tests pass."),
]


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "data"
    (d / "chat").mkdir(parents=True)
    with open(d / "chat" / "room.jsonl", "w") as f:
        for i, (who, text) in enumerate(MESSAGES):
            f.write(json.dumps({"agent": who, "text": text, "n": i}) + "\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-test")
    monkeypatch.setenv("THIMBLE_ROOT", str(d))
    return d


def run(root: Path, *args: str, stdin: str = "") -> subprocess.CompletedProcess:
    env = {**os.environ, "THIMBLE_ROOT": str(root), "THIMBLE_PYTHON": sys.executable}
    return subprocess.run([str(LEAN), *args], input=stdin, capture_output=True, text=True, env=env, cwd=root, timeout=120)


def feed(tmp: Path) -> list[dict]:
    p = Path(os.environ["THIMBLE_HOME"]) / "lean" / "events" / "s-test.jsonl"
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


def test_a_regex_label_gives_each_record_a_value_and_prints_its_counts(root: Path):
    r = run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "  sorry: yes 2 · no 4 of 6 records" in r.stdout and "#" not in r.stdout.split("\n", 1)[1]
    st = Store(root)
    # the rule went over every record and none entered a context: the file is computed over, not seen
    cov = CV.coverage(st)
    f = next(x for x in cov["files"] if x["path"] == "chat/room.jsonl")
    assert f["status"] == "computed" and f["computed"] == 6 and not f["seen"] and cov["total"]["seen_rows"] == 0
    assert "Computed over by a rule label, none of it read: 6 of 6 records (100%)." in CV.coverage_text(cov)
    # another session did not apply it, so its coverage holds none of it
    assert CV.coverage(Store(root, session="s-other"))["total"]["touched_files"] == 0
    # each value's records as examples, the unchecked first
    assert {s["ref"] for s in LB.samples(st, LB.load(st, "sorry"))["yes"]} == {"chat/room.jsonl#L1", "chat/room.jsonl#L3"}
    # a rule label asks the plugin for nothing
    assert feed(root) == []


def test_the_viewer_marks_the_part_a_label_matched(root: Path):
    # a regex: its match on its line, the words around it; code: the fields it read
    assert run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry").returncode == 0
    st = Store(root)
    yes = LB.page(st, "sorry", "yes")["records"]
    assert yes and all(r["hit"]["match"].lower() == "sorry" for r in yes)
    assert LB.page(st, "sorry", "no")["records"][0].get("hit") is None
    code = "def label(unit):\n    return 'long' if len(unit.get('text', '')) > 30 else 'short'\n"
    assert run(root, "label", "size", "--in", "chat/*.jsonl", "--code", stdin=code).returncode == 0
    r = LB.page(st, "size")["records"][0]
    assert [f[0] for f in r["fields"]] == ["text"]


def test_code_labels_take_a_value_a_confidence_or_none_and_say_what_failed(root: Path):
    code = ("def label(unit):\n"
            "    if unit['n'] == 5:\n"
            "        raise ValueError('no reading')\n"
            "    return ('long' if len(unit['text']) > 30 else 'short', 0.8)\n")
    r = run(root, "label", "length", "--in", "chat/*.jsonl", "--code", "--values", "long,short", stdin=code)
    assert r.returncode == 0, r.stdout + r.stderr
    st = Store(root)
    lab = LB.load(st, "length")
    s = LB.status(lab)
    assert s["counts"] == {"long": 3, "short": 2} and s["failed"] == 1
    assert "error: chat/room.jsonl#L6: ValueError: no reading" in r.stdout


def test_a_code_label_with_no_values_takes_the_values_it_returns_the_most_common_first(root: Path):
    code = "def label(unit):\n    return 'fern' if unit['agent'] == 'fern' else unit['agent'] + '-team'\n"
    r = run(root, "label", "team", "--in", "chat/*.jsonl", "--code", stdin=code)
    assert r.returncode == 0, r.stdout + r.stderr
    st = Store(root)
    lab = LB.load(st, "team")
    # wren, moss and fern each wrote 2: a tie keeps the order the code first returned them; no yes or no
    assert lab["values"] == ["wren-team", "moss-team", "fern"]
    assert "  team: wren-team 2 · moss-team 2 · fern 2 of 6 records" in r.stdout
    # a bool is yes or no, the positive first, whichever is more common
    r = run(root, "label", "long", "--in", "chat/*.jsonl", "--code", stdin="def label(unit):\n    return len(unit['text']) > 45\n")
    assert r.returncode == 0, r.stdout + r.stderr
    lab = LB.load(st, "long")
    assert lab["values"] == ["yes", "no"] and LB.status(lab)["counts"] == {"yes": 1, "no": 5}


def test_a_none_from_code_leaves_the_record_outside_the_label(root: Path):
    code = ("def label(unit):\n"
            "    if unit['agent'] != 'wren':\n"
            "        return None\n"
            "    return ('yes', 1.0) if 'sorry' in unit['text'] else ('no', 1.0)\n")
    r = run(root, "label", "wren-sorry", "--in", "chat/*.jsonl", "--code", stdin=code)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "2 records of chat/*.jsonl; the code returned None for 4 more" in r.stdout
    st = Store(root)
    lab = LB.load(st, "wren-sorry")
    s = LB.status(lab)
    assert s["records"] == s["valued"] == 2 and s["failed"] == 0 and s["out"] == 4
    assert lab["values"] == ["yes", "no"] and s["counts"] == {"yes": 1, "no": 1}
    assert "  wren-sorry: yes 1 · no 1 of 2 records" in r.stdout and "have no value" not in r.stdout
    # the viewer holds only its records
    assert LB.page(st, "wren-sorry")["total"] == 2
    # the same definition again does not count the records outside it as new
    again = run(root, "label", "wren-sorry", "--in", "chat/*.jsonl", "--code", stdin=code)
    assert again.returncode == 0 and LB.status(LB.load(st, "wren-sorry"))["records"] == 2


def test_a_prompt_label_waits_for_the_model_then_takes_its_answers(root: Path):
    r = run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.", "--reason")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "6 records wait for the model" in r.stdout and "1 model call of up to 50 records each" in r.stdout
    st = Store(root)
    # the reads are asked for in the change feed
    ev = feed(root)[-1]
    assert ev["kind"] == "label" and ev["name"] == "apology"
    w = json.loads(run(root, "label", "apology", "--waiting").stdout)
    assert w["definition"] == "The message apologizes." and w["reason"] is True and len(w["units"]) == 6
    assert w["batches"] == [[u["ref"] for u in w["units"]]]
    refs = [u["ref"] for u in w["units"]]
    payload = {"values": {refs[0]: {"value": "yes", "confidence": 0.9, "reason": "says sorry"},
                          refs[1]: {"value": "No"}, refs[2]: {"value": "maybe"}},
               "failed": {refs[3]: "the call failed: api-error 529"}}
    got = json.loads(run(root, "label", "apology", "--answers", "-", "--json", stdin=json.dumps(payload)).stdout)
    assert got["took"] == 2 and got["failed"] == 2 and got["waiting"] == 2
    payload = {"values": {refs[4]: {"value": "yes"}, refs[5]: {"value": "no"}}}
    got = json.loads(run(root, "label", "apology", "--answers", "-", "--json", stdin=json.dumps(payload)).stdout)
    # nothing waits: the counts are whole
    assert got["waiting"] == 0 and got["counts"] == {"yes": 2, "no": 2}
    lab = LB.load(st, "apology")
    assert lab["units"][refs[2]]["err"].startswith("the model gave 'maybe'")
    assert lab["units"][refs[0]]["why"] == "says sorry"
    out = run(root, "label", "apology").stdout
    assert "2 records have no value" in out and "--again" in out
    # again: the two without a value wait again, and the reads are asked for again
    out = run(root, "label", "apology", "--again").stdout
    assert "2 records wait for the model (1 model call)" in out
    assert feed(root)[-1]["kind"] == "label"
    assert LB.status(LB.load(st, "apology"))["waiting"] == 2


def test_the_persons_check_stands_over_the_value_and_counts_in_its_place(root: Path):
    run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    r = run(root, "label", "sorry", "--check", "chat/room.jsonl#L5", "yes")
    assert r.stdout.strip() == "chat/room.jsonl#L5: the analyst says yes (the label gave no)"
    run(root, "label", "sorry", "--check", "chat/room.jsonl#L1", "yes")
    bad = run(root, "label", "sorry", "--check", "chat/room.jsonl#L1", "maybe")
    assert bad.returncode == 1 and "'maybe' is not a value of sorry" in bad.stdout
    st = Store(root)
    s = LB.status(LB.load(st, "sorry"))
    assert s["counts"] == {"yes": 3, "no": 3} and s["checked"] == 2 and s["agree"] == 1 and s["disagree"] == 1
    out = run(root, "label", "sorry").stdout
    assert "  sorry: yes 3 · no 3 of 6 records" in out and "the analyst checked 2: 1 agree, 1 disagree" in out


def test_a_regex_reads_a_json_records_decoded_values_and_a_text_or_csv_row_as_the_file_holds_it(root: Path):
    """A newline in a JSON value is \\n in the file, so `\\bhttps?://` after one would miss on the raw line (n is a word
    character); the regex reads the values a person reads. A line of text and a CSV row keep their raw text."""
    with open(root / "chat" / "edits.jsonl", "w") as f:
        f.write(json.dumps({"id": 1, "text": "See the source:\nhttps://example.org/a"}) + "\n")
        f.write(json.dumps({"id": 2, "text": "no link here"}) + "\n")
        f.write(json.dumps({"id": 3, "text": "inline https://example.org/b"}) + "\n")
    (root / "notes.txt").write_text("literal \\nhttps://example.org/c\nplain https://example.org/d\nnothing\n")
    (root / "rows.csv").write_text('id,body\n1,"line one\nhttps://example.org/e"\n2,"https://example.org/f"\n3,none\n')
    st = Store(root)
    got = LB.define(st, "link", "regex", r"\bhttps?://", "chat/edits.jsonl")["label"]
    assert LB.counts(got) == {"yes": 2, "no": 1}
    # keys and quotes are not the text: a pattern over them no longer matches
    assert LB.counts(LB.define(st, "keyed", "regex", r'"text": "See', "chat/edits.jsonl")["label"]) == {"no": 3}
    # a line of text as the file holds it: the literal backslash-n still blocks \b, as before
    assert LB.counts(LB.define(st, "tlink", "regex", r"\bhttps?://", "notes.txt")["label"]) == {"yes": 1, "no": 2}
    # a CSV row as before: its columns' JSON, where the newline in the first row's cell is \n
    assert LB.counts(LB.define(st, "clink", "regex", r"\bhttps?://", "rows.csv")["label"]) == {"yes": 1, "no": 2}


def test_a_label_counts_records_in_each_files_unit_and_says_when_it_mixes_units(root: Path):
    notes = root / "notes"
    notes.mkdir()
    (notes / "plan.md").write_text("## Plan\n\nWe cite each source.\n")
    (notes / "todo.md").write_text("## Todo\n\nNothing here.\n")
    (notes / "tool.py").write_text("x = 1\n# cite the rows\ny = 2\n")
    st = Store(root)
    # one unit: lines of code are lines
    r = run(root, "label", "cites-code", "--in", "notes/*.py", "--regex", r"\bcite\b")
    assert r.returncode == 0, r.stdout + r.stderr
    assert LB.load(st, "cites-code") and "3 lines of notes/*.py" in r.stdout
    assert "  cites-code: yes 1 · no 2 of 3 lines" in r.stdout
    # whole Markdown files and lines of code together: each counted in its unit, and the mix said plainly
    r = run(root, "label", "cites", "--in", "notes/*", "--regex", r"\bcite\b")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "the records mix units: 3 lines and 2 files" in r.stdout
    assert "    yes: 1 of the 3 lines, 1 of the 2 files" in r.stdout


def test_a_label_in_one_table_of_a_database_labels_only_that_tables_rows(root: Path):
    import sqlite3
    con = sqlite3.connect(root / "forge.db")
    con.execute("create table prs (title text)")
    con.execute("create table issues (title text)")
    con.executemany("insert into prs values (?)", [("fix the parser",), ("add a test",)])
    con.executemany("insert into issues values (?)", [("the parser fails",), ("docs typo",), ("slow build",)])
    con.commit()
    con.close()
    r = run(root, "label", "parser", "--in", "forge.db#prs", "--regex", "parser")
    assert r.returncode == 0, r.stdout + r.stderr
    lab = LB.load(Store(root), "parser")
    assert sorted(lab["units"]) == ["forge.db#prs/1", "forge.db#prs/2"]
    assert LB.status(lab)["counts"] == {"yes": 1, "no": 1}
    # a table the database does not have says which it has
    r = run(root, "label", "nope", "--in", "forge.db#pulls", "--regex", "parser")
    assert r.returncode != 0 and "no table 'pulls'" in r.stdout + r.stderr and "issues, prs" in r.stdout + r.stderr
