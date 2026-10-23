"""Labels (engine/kernel/labels.py, `thimble label`): a category given to every record of a scope by a regex, code, the
model (records that wait for its reads) or Claude's own values; counts per value as plain numbers and as CSV; the
person's checks; a folder thimble may not write in; and what coverage counts of a label. Run: python3 -m pytest
plugin/tests/test_labels.py"""
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
from kernel import store as STORE  # noqa: E402
from kernel.store import Store  # noqa: E402

THIMBLE = Path(__file__).resolve().parents[1] / "bin" / "thimble"

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
    return subprocess.run([str(THIMBLE), *args], input=stdin, capture_output=True, text=True, env=env, cwd=root, timeout=120)


def feed(tmp: Path) -> list[dict]:
    p = Path(os.environ["THIMBLE_HOME"]) / "events" / "s-test.jsonl"
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


def test_coverage_reads_a_label_from_its_summary_and_not_its_records(root: Path, monkeypatch: pytest.MonkeyPatch):
    # a label of millions of records is a file of hundreds of megabytes: the label keeps a summary per file as it
    # writes, and coverage reads the label file again only when it changed in another way
    assert run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog").returncode == 0
    st = Store(root)
    read, read_json = [], Store.read_json
    monkeypatch.setattr(Store, "read_json", staticmethod(lambda p: read.append(p.name) or read_json(p)))
    got = LB.summaries(st)
    assert [(s["name"], s["sessions"], s["files"]) for s in got] == [("sorry", ["s-test"], {"chat/room.jsonl": [0, 6]})]
    assert CV.coverage(st)["total"]["computed_rows"] == 6 and "sorry.json" not in read
    # a label file another tool changed is read again
    p = LB.path(st, "sorry")
    lab = json.loads(p.read_text())
    lab["units"] = {k: {**u, "by": "model"} for k, u in lab["units"].items()}
    p.write_text(json.dumps(lab))
    assert LB.summaries(st)[0]["files"] == {"chat/room.jsonl": [6, 0]}
    p.unlink()
    assert LB.summaries(st) == []


def test_a_regex_label_gives_each_record_a_value_and_prints_its_counts(root: Path):
    r = run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "  sorry: yes 2 · no 4 of 6 records" in r.stdout and "#" not in r.stdout.split("\n", 1)[1]
    st = Store(root)
    # the rule went over every record and none entered a context: the file is computed over, not seen
    cov = CV.coverage(st)
    f = next(x for x in cov["files"] if x["path"] == "chat/room.jsonl")
    assert f["status"] == "computed" and f["computed"] == 6 and not f["seen"] and cov["total"]["seen_rows"] == 0
    assert "Computed over by a program or a rule label, none of it read: 6 of 6 records (100%)." in CV.coverage_text(cov)
    # another session did not apply it, so its coverage holds none of it
    assert CV.coverage(Store(root, session="s-other"))["total"]["touched_files"] == 0
    # the pane's page of a value: its records with their words
    yes = LB.page(st, "sorry", "yes")
    assert [r["ref"] for r in yes["records"]] == ["chat/room.jsonl#L1", "chat/room.jsonl#L3"] and yes["total"] == 2
    assert yes["records"][0]["words"] == "I'm sorry, I broke the build with my last commit."
    # a record with no words in it shows its short values with their keys
    (root / "pages.jsonl").write_text(json.dumps({"page_id": "w/Notes", "wiki": "w", "name": "Notes", "n_revs": 3, "tags": ["a"]}) + "\n")
    run(root, "label", "short", "--in", "pages.jsonl", "--regex", "Notes")
    assert LB.page(st, "short")["records"][0]["words"] == "wiki w · name Notes · n_revs 3"
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


def test_the_viewer_marks_what_a_code_label_matched_or_says_why_not(root: Path):
    # the match the code made, placed in the record's own words, though it searched a changed copy; the words around
    # it cut at a word's edge, with … only where cut
    long = "word " * 80 + "a merge conflict in whatsnew, then " + "more " * 80
    (root / "posts.jsonl").write_text("".join(json.dumps({"who": w, "body": b}) + "\n" for w, b in [
        ("a", long), ("b", "Nothing to see here."), ("c", "No claim conflict, a merge conflict.")]))
    code = ("import re\nNOT = re.compile(r'claim conflict', re.I)\nANY = re.compile(r'\\bconflict\\b', re.I)\n"
            "def label(u):\n    rest = NOT.sub(' ', u.get('body') or '').lower()\n    return 'yes' if ANY.search(rest) else 'no'\n")
    assert run(root, "label", "mc", "--in", "posts.jsonl", "--code", stdin=code).returncode == 0
    st = Store(root)
    a, c = LB.page(st, "mc", "yes")["records"]
    assert a["hit"]["match"] == "conflict" and a["hit"]["before"].startswith("…word ") and a["hit"]["after"].endswith("more…")
    assert len(a["hit"]["before"] + a["hit"]["match"] + a["hit"]["after"]) <= LB.HIT_ROOM
    # the second "conflict": the first one is the claim conflict the code took out
    assert c["hit"] == {"before": "No claim conflict, a merge ", "match": "conflict", "after": "."}
    assert LB.page(st, "mc", "no")["records"][0]["unmarked"] == "no pattern of the code matches it"
    # code with no pattern says so, and shows the fields it read
    assert run(root, "label", "n", "--in", "posts.jsonl", "--code", stdin="def label(x):\n    return len(x['who'])\n").returncode == 0
    r = LB.page(st, "n")["records"][0]
    assert r["unmarked"] == "the code uses no pattern, so no words are marked" and r["fields"] == [["who", "a"]]
    # a path outside the folder shows with … in its middle, inside it relative
    assert LB.shown_path("/tmp/x/y/run/thimble/prs.jsonl", root) == "/tmp/…/thimble/prs.jsonl"
    assert LB.shown_path(str(root / "runs" / "a.jsonl"), root) == "runs/a.jsonl"


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


def test_the_model_reads_every_field_of_a_long_record_and_the_named_field_whole(root: Path):
    # a closed ticket whose long body comes before the field the definition asks about: the record is cut field by
    # field, so the late field reaches the model, and whole since the definition names it
    reason = "Closed as a duplicate of ticket 12. " + "x" * 1500
    (root / "tickets.jsonl").write_text(json.dumps({"id": 7, "body": "word " * 2000, "close_reason": reason,
                                                    "state": "closed"}) + "\n")
    assert run(root, "label", "dup", "--in", "tickets.jsonl", "--prompt", "yes if close_reason says it is a duplicate").returncode == 0
    text = LB.waiting(Store(root), "dup")["units"][0]["text"]
    rec = json.loads(text)
    assert rec["close_reason"] == reason and rec["state"] == "closed" and rec["id"] == 7
    assert rec["body"].endswith("characters)") and len(text) < LB.UNIT_CHARS + 200
    # the same record under a definition that names no field: each long value is cut to the same length
    rec = json.loads(LB._fields_cut(json.loads((root / "tickets.jsonl").read_text()), 1000, "is it a duplicate?"))
    assert rec["close_reason"].startswith("Closed as a duplicate") and len(rec["body"]) == len(rec["close_reason"])


def test_the_persons_check_stands_over_the_value_and_counts_in_its_place(root: Path):
    run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    r = run(root, "label", "sorry", "--check", "chat/room.jsonl#L5", "yes")
    assert r.stdout.strip() == "chat/room.jsonl#L5: the analyst says yes (the label gave no)"
    got = json.loads(run(root, "label", "sorry", "--check", "chat/room.jsonl#L1", "yes", "--json").stdout)
    # what the plugin tells Claude: the label's checks that changed a value, as the label holds them
    assert got["checked"] == 2 and got["agree"] == 1 and got["changed"] == [{"ref": "chat/room.jsonl#L5", "was": "no", "now": "yes"}]
    bad = run(root, "label", "sorry", "--check", "chat/room.jsonl#L1", "maybe")
    assert bad.returncode == 1 and "'maybe' is not a value of sorry" in bad.stdout
    st = Store(root)
    s = LB.status(LB.load(st, "sorry"))
    assert s["counts"] == {"yes": 3, "no": 3} and s["checked"] == 2 and s["agree"] == 1 and s["disagree"] == 1
    out = run(root, "label", "sorry").stdout
    assert "  sorry: yes 3 · no 3 of 6 records" in out and "the analyst checked 2: 1 agree, 1 disagree" in out
    # the pane shows the records the analyst has not checked first
    assert [r["ref"] for r in LB.page(st, "sorry", "yes")["records"]] == ["chat/room.jsonl#L3", "chat/room.jsonl#L1", "chat/room.jsonl#L5"]


def test_csv_gives_every_record_with_the_analysts_check_in_place_of_the_labels_value(root: Path):
    import csv
    import io
    run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    run(root, "label", "sorry", "--check", "chat/room.jsonl#L5", "yes")
    r = run(root, "label", "sorry", "--csv")
    assert r.returncode == 0, r.stdout + r.stderr
    rows = list(csv.DictReader(io.StringIO(r.stdout)))
    assert r.stdout.splitlines()[0] == "ref,value,confidence,by,checked" and len(rows) == 6
    by = {x["ref"]: x for x in rows}
    assert by["chat/room.jsonl#L1"] == {"ref": "chat/room.jsonl#L1", "value": "yes", "confidence": "1.0", "by": "regex", "checked": "false"}
    assert by["chat/room.jsonl#L5"] == {"ref": "chat/room.jsonl#L5", "value": "yes", "confidence": "", "by": "analyst", "checked": "true"}
    assert sum(x["value"] == "yes" for x in rows) == 3
    # a reader that takes only the first lines ends it without a traceback
    many = root / "big" / "many.jsonl"
    many.parent.mkdir()
    many.write_text("".join(json.dumps({"text": f"sorry {i}"}) + "\n" for i in range(20000)))
    run(root, "label", "many", "--in", "big/many.jsonl", "--regex", "sorry")
    env = {**os.environ, "THIMBLE_ROOT": str(root), "THIMBLE_PYTHON": sys.executable}
    head = subprocess.run(f"'{THIMBLE}' label many --csv | head -2", shell=True, capture_output=True, text=True, env=env, cwd=root)
    assert head.stdout.splitlines() == ["ref,value,confidence,by,checked", "big/many.jsonl#L1,yes,1.0,regex,false"]
    assert "Traceback" not in head.stderr
    # a record that waits for the model has no value yet
    run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.")
    waiting = list(csv.DictReader(io.StringIO(run(root, "label", "apology", "--csv").stdout)))
    assert len(waiting) == 6 and {x["value"] for x in waiting} == {""}


def test_labels_are_kept_under_thimble_home_and_nothing_is_written_in_the_folder(root: Path, tmp_path: Path):
    # (THIMBLE_ROOT pins the root, so a folder found by its records would be the same)
    before = sorted(p.name for p in root.rglob("*"))
    r = run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    assert r.returncode == 0, r.stdout + r.stderr
    kept = tmp_path / "th" / "conversations" / "s-test" / "folders" / STORE.folder_name(str(root.resolve()))
    assert kept == STORE.kept_dir(root) and (kept / "labels" / "sorry.json").is_file()
    assert "  sorry: yes 2 · no 4 of 6 records" in r.stdout
    # the label reads back, checks and CSV work there
    assert run(root, "label", "sorry", "--check", "chat/room.jsonl#L5", "yes").returncode == 0
    assert "  sorry: yes 3 · no 3 of 6 records" in run(root, "label", "sorry").stdout
    assert run(root, "label", "sorry", "--csv").stdout.count("\n") == 7
    assert sorted(p.name for p in root.rglob("*")) == before
    # a write takes a lock on the labels folder, and leaves no lock file
    assert sorted(p.name for p in (kept / "labels").iterdir()) == ["sorry.json"]


def test_a_label_over_a_database_leaves_no_file_beside_it(root: Path):
    import sqlite3
    db = root / "app.db"
    con = sqlite3.connect(db)
    con.execute("pragma journal_mode=wal")
    con.execute("create table notes (body text)")
    con.executemany("insert into notes values (?)", [("the parser fails",), ("docs typo",)])
    con.commit()
    con.close()
    assert sorted(p.name for p in root.iterdir() if p.name.startswith("app.db")) == ["app.db"]
    r = run(root, "label", "parser", "--in", "app.db#notes", "--regex", "parser")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "  parser: yes 1 · no 1 of 2 rows" in r.stdout
    assert LB.page(Store(root), "parser", "yes")["records"][0]["ref"] == "app.db#notes/1"
    assert sorted(p.name for p in root.iterdir() if p.name.startswith("app.db")) == ["app.db"]


def test_a_big_prompt_label_asks_the_person_first_and_their_key_answers(root: Path):
    with open(root / "chat" / "big.jsonl", "w") as f:
        for i in range(420):
            f.write(json.dumps({"agent": "wren", "text": f"message {i}", "n": i}) + "\n")
    st = Store(root)
    # a trial never asks
    r = run(root, "label", "spam", "--in", "chat/big.jsonl", "--prompt", "The message is spam.", "--limit", "25")
    assert r.returncode == 0 and "Not started" not in r.stdout and feed(root)[-1]["kind"] == "label"
    # all 420: more than a sample, so it waits for the person's choice, and no session starts the reads
    r = run(root, "label", "spam", "--in", "chat/big.jsonl", "--prompt", "The message is spam.")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Not started" in r.stdout and "asked first" in r.stdout
    # Claude is told to wait for the choice and the reads, and the trial's counts are said as the trial's only
    assert "`thimble label spam --wait` waits for their choice, then for the model's reads" in r.stdout
    assert "Answer now" not in r.stdout and "Counts from a trial are not the label's" in r.stdout
    ev = feed(root)[-1]
    assert ev["kind"] == "label_ask" and ev["units"] == 420 and ev["sample"] == 300
    assert ev["text"] == "Read 420 records of chat/big.jsonl with Claude" and ev["meta"] == "9 model calls"
    assert "the analyst's choice" in run(root, "label", "spam").stdout
    # --wait waits for the analyst's choice up to its time, and then says nothing runs before they choose
    t0 = time.time()
    r = run(root, "label", "spam", "--wait", "2")
    assert r.returncode == 0 and 2 <= time.time() - t0 < 30
    assert "still waiting for the analyst's choice in the bar after 2s; nothing runs until then" in r.stdout
    # Claude cannot answer for the person: a made-up ask id is refused and the label still waits
    r = run(root, "label", "spam", "--answer", "all", "--ask", "a000")
    assert r.returncode == 1 and LB.load(st, "spam")["run"]["state"] == "ask"
    # the person's key: a sample of 300 of the 420 that wait
    got = json.loads(run(root, "label", "spam", "--answer", "sample", "--ask", ev["ask"]).stdout)
    assert got["reads"] == 300 and got["waiting"] == 300 and got["choice"] == "sample"
    out = run(root, "label", "spam").stdout
    assert "the random sample of 300 the analyst chose; 0 read" in out and "the other 120 records have no value" in out
    # the same label again asks again for the rest (a sample is no yes for all): run them or cancel, no second sample;
    # this time the person runs them
    r = run(root, "label", "spam", "--in", "chat/big.jsonl", "--prompt", "The message is spam.")
    assert "run them or cancel" in r.stdout and "do not point them to a key" in r.stdout
    ev = feed(root)[-1]
    assert ev["kind"] == "label_ask" and ev["rest"] is True and ev["sample"] == 0
    assert ev["text"] == "Read the other 420 records of chat/big.jsonl with Claude"
    got = json.loads(run(root, "label", "spam", "--answer", "all", "--ask", ev["ask"]).stdout)
    assert got["choice"] == "all" and got["reads"] == got["waiting"] == 420
    # they said yes to this exact label and scope: asking again starts the reads at once
    r = run(root, "label", "spam", "--in", "chat/big.jsonl", "--prompt", "The message is spam.")
    assert "Not started" not in r.stdout and feed(root)[-1]["kind"] == "label"
    # a changed definition is a new label: it asks again, and cancel reads nothing
    run(root, "label", "spam", "--in", "chat/big.jsonl", "--prompt", "The message is spam or an ad.")
    ev = feed(root)[-1]
    got = json.loads(run(root, "label", "spam", "--answer", "cancel", "--ask", ev["ask"]).stdout)
    assert got["reads"] == 0 and got["waiting"] == 0
    assert "chose not to run it over its 420 records" in run(root, "label", "spam").stdout


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


def test_a_label_sorts_only_the_folders_own_records(root: Path, tmp_path: Path):
    (tmp_path / "scratch").mkdir()
    (tmp_path / "scratch" / "derived.jsonl").write_text(json.dumps({"text": "sorry"}) + "\n")
    r = run(root, "label", "derived", "--in", str(tmp_path / "scratch" / "derived.jsonl"), "--regex", "sorry")
    assert r.returncode == 1 and "is outside the folder" in r.stdout and "Label the records it came from" in r.stdout
    assert LB.names(Store(root)) == []


def test_a_label_over_a_file_claude_derived_in_the_temp_folder_belongs_to_the_session_root(root: Path, tmp_path: Path):
    """Claude writes a derived table in thimble's temp folder ($TMPDIR, thimble/ in the person's TMPDIR) and labels it:
    the label is the session's root's, so the answer shows its row and the bar counts it, and its records read back."""
    temp = tmp_path / "tmp" / "thimble"
    temp.mkdir(parents=True, mode=0o700)
    with open(temp / "rows.jsonl", "w") as f:
        for who, text in MESSAGES:
            f.write(json.dumps({"agent": who, "text": text}) + "\n")
    env = {**os.environ, "THIMBLE_PYTHON": sys.executable, "THIMBLE_START": str(root), "TMPDIR": str(temp)}
    env.pop("THIMBLE_ROOT", None)

    def here(*args: str, cwd: Path) -> subprocess.CompletedProcess:
        return subprocess.run([str(THIMBLE), *args], capture_output=True, text=True, env=env, cwd=cwd, timeout=120)

    # `cd $TMPDIR && thimble label … --in rows.jsonl`
    r = here("label", "apology", "--in", "rows.jsonl", "--regex", "(?i)sorry|apolog|mistake", "--values", "yes,no", cwd=temp)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "apology: yes 3 · no 3" in r.stdout
    # from the root, with the absolute path
    r = here("label", "merged", "--in", str(temp / "rows.jsonl"), "--regex", "Merged", "--values", "yes,no", cwd=root)
    assert r.returncode == 0, r.stdout + r.stderr
    assert sorted(LB.names(Store(root))) == ["apology", "merged"]
    assert not (STORE.kept_dir(temp.resolve()) / "labels").exists()
    # each label names its root in the feed, and its records read back by their absolute refs
    assert {e["root"] for e in feed(root) if e.get("kind") == "label"} <= {str(root.resolve())}
    got = LB.page(Store(root), "apology", "yes")
    assert got["total"] == 3 and got["records"][0]["ref"].startswith(str(temp.resolve()) + "/rows.jsonl#L")
    assert "sorry" in json.dumps(got["records"][0]).lower()
    # any other folder outside the root stays outside
    (tmp_path / "elsewhere.jsonl").write_text('{"text": "x"}\n')
    r = here("label", "x", "--in", str(tmp_path / "elsewhere.jsonl"), "--regex", "x", cwd=root)
    assert r.returncode == 1 and "outside the folder" in r.stdout


def test_claude_waits_through_the_ask_and_the_sample_and_hears_the_labels_counts_not_the_trials(root: Path):
    """The analyst picks a sample while Claude's `--wait` runs: the wait goes on through the model's reads and prints
    the label's counts; meanwhile `thimble label NAME` names the run and says the counts so far are not the label's."""
    with open(root / "chat" / "big.jsonl", "w") as f:
        for i in range(420):
            f.write(json.dumps({"agent": "wren", "text": f"message {i}", "n": i}) + "\n")
    st = Store(root)
    run(root, "label", "spam", "--in", "chat/big.jsonl", "--prompt", "The message is spam.")
    ev = feed(root)[-1]
    assert ev["kind"] == "label_ask"
    # Claude waits while the ask is up; the person's key picks a sample of 300 of the 420 that wait
    env = {**os.environ, "THIMBLE_ROOT": str(root), "THIMBLE_PYTHON": sys.executable}
    waiting = subprocess.Popen([str(THIMBLE), "label", "spam", "--wait", "60"], stdout=subprocess.PIPE, text=True, env=env, cwd=root)
    time.sleep(1.5)
    got = json.loads(run(root, "label", "spam", "--answer", "sample", "--ask", ev["ask"]).stdout)
    assert got["reads"] == 300 and got["waiting"] == 300 and got["choice"] == "sample"
    out = run(root, "label", "spam").stdout
    assert "300 records wait for the model (the random sample of 300 the analyst chose; 0 read)" in out
    refs = [u["ref"] for u in LB.waiting(st, "spam")["units"]]
    half = {"run": {"state": "running"}, "values": {r: {"value": "no"} for r in refs[:100]}}
    run(root, "label", "spam", "--answers", "-", stdin=json.dumps(half))
    out = run(root, "label", "spam").stdout
    assert "(the random sample of 300 the analyst chose; 100 read): the model is reading them" in out
    assert "so far, only of the 100 records with a value: yes 0 · no 100; not the label's counts while 200 wait" in out
    assert waiting.poll() is None
    run(root, "label", "spam", "--answers", "-", stdin=json.dumps({"values": {r: {"value": "no"} for r in refs[100:]}}))
    said = waiting.communicate(timeout=30)[0]
    assert waiting.returncode == 0 and "spam: yes 0 · no 300 of 300 records" in said


# ------------------------------------------------------------------ a label belongs to its conversation


def in_conversation(root: Path, conversation: str, *args: str, stdin: str = "") -> subprocess.CompletedProcess:
    """`thimble …` as Claude's command in the conversation `conversation` (the hooks set both variables to its key)."""
    env = {**os.environ, "THIMBLE_ROOT": str(root), "THIMBLE_PYTHON": sys.executable, "THIMBLE_SESSION": conversation,
           "THIMBLE_CONVERSATION": conversation}
    return subprocess.run([str(THIMBLE), *args], input=stdin, capture_output=True, text=True, env=env, cwd=root, timeout=120)


def test_a_new_conversation_in_the_same_folder_starts_with_no_labels_and_a_resumed_one_has_its_own(root: Path):
    r = in_conversation(root, "conv-a", "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    assert r.returncode == 0, r.stdout + r.stderr
    # a new conversation in the folder: no label, by any of the commands that show one
    assert in_conversation(root, "conv-b", "label", "--json").stdout.strip() == "[]"
    assert in_conversation(root, "conv-b", "label").stdout.startswith("no labels yet")
    assert "no label 'sorry'" in in_conversation(root, "conv-b", "label", "sorry").stdout
    assert "sorry" not in in_conversation(root, "conv-b", "coverage", "--json").stdout
    # its own label of the same name is its own
    assert in_conversation(root, "conv-b", "label", "sorry", "--in", "chat/*.jsonl", "--regex", "wrong").returncode == 0
    assert "  sorry: yes 1 · no 5 of 6 records" in in_conversation(root, "conv-b", "label", "sorry").stdout
    # the first conversation, resumed (the same key): its label as it left it
    assert "  sorry: yes 2 · no 4 of 6 records" in in_conversation(root, "conv-a", "label", "sorry").stdout
    assert [x["name"] for x in json.loads(in_conversation(root, "conv-a", "label", "--json").stdout)] == ["sorry"]
    # coverage of every session reads every conversation's labels of the folder
    cov = json.loads(in_conversation(root, "conv-b", "coverage", "--all", "--json").stdout)
    assert {f["path"]: f["labels"] for f in cov["files"]}["chat/room.jsonl"] == ["sorry"]


def test_the_folders_labels_of_thimble_0_10_stay_on_disk_and_only_the_conversation_that_applied_one_finds_it(root: Path):
    # thimble 0.10 kept one set of labels per folder, which every session showed
    old = STORE.legacy_dir(root) / "labels"
    old.mkdir(parents=True)
    lab = {"name": "old", "kind": "regex", "rule": "sorry", "in": "chat/*.jsonl", "values": ["yes", "no"], "rev": 1,
           "units": {"chat/room.jsonl#L1": {"v": "yes", "c": 1.0, "by": "regex"}}, "checks": {}, "sessions": ["conv-old"]}
    (old / "old.json").write_text(json.dumps(lab))
    before = (old / "old.json").read_text()
    # a new conversation shows none of it
    assert in_conversation(root, "conv-new", "label", "--json").stdout.strip() == "[]"
    # the conversation that applied it, resumed, finds it again, and a change of it leaves the old file as it was
    assert "  old: yes 1 · no 0 of 1 record" in in_conversation(root, "conv-old", "label", "old").stdout
    assert in_conversation(root, "conv-old", "label", "old", "--check", "chat/room.jsonl#L1", "no").returncode == 0
    assert (old / "old.json").read_text() == before
    assert "the analyst checked 1" in in_conversation(root, "conv-old", "label", "old").stdout
    assert in_conversation(root, "conv-new", "label", "--json").stdout.strip() == "[]"
    # a label an earlier thimble wrote in the folder itself: the same
    own = root / "thimble" / "labels"
    own.mkdir(parents=True)
    (own / "mine.json").write_text(json.dumps({**lab, "name": "mine", "sessions": ["conv-own"]}))
    assert in_conversation(root, "conv-new2", "label", "--json").stdout.strip() == "[]"
    assert [x["name"] for x in json.loads(in_conversation(root, "conv-own", "label", "--json").stdout)] == ["mine"]


def test_the_same_prompt_label_in_another_conversation_reuses_the_models_reads_and_nothing_else(root: Path):
    define = ("label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.")
    assert in_conversation(root, "conv-a", *define).returncode == 0
    waiting = json.loads(in_conversation(root, "conv-a", "label", "apology", "--waiting").stdout)
    refs = [u["ref"] for u in waiting["units"]]
    answers = {"values": {r: {"value": "yes" if i in (0, 2) else "no"} for i, r in enumerate(refs[:5])}}
    in_conversation(root, "conv-a", "label", "apology", "--answers", "-", stdin=json.dumps(answers))
    in_conversation(root, "conv-a", "label", "apology", "--check", refs[0], "no")
    # the same label in a new conversation: the model reads only the record it never read; the analyst's check stays
    # the first conversation's
    out = in_conversation(root, "conv-b", *define).stdout
    assert "1 records wait for the model" in out
    st = Store(root, conversation="conv-b")
    lab = LB.load(st, "apology")
    assert LB.status(lab)["counts"] == {"yes": 2, "no": 3} and not lab["checks"]
    assert [r for r, u in lab["units"].items() if u.get("wait")] == [refs[5]]
    # another definition reads every record again
    other = ("label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message is short.")
    out = in_conversation(root, "conv-c", *other).stdout
    assert "6 records wait for the model" in out
