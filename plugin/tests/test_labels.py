"""Labels (engine/kernel/labels.py, `thimble label`): a category given to every record of a scope by a regex, code, the
model (records that wait for its reads) or Claude's own values; counts that are a query, so each is a citation;
use(name) and `thimble rows --label` in later work; the person's checks; and the label's card. Run with any Python that
has pandas: python -m pytest plugin/tests/test_labels.py"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import labels as LB  # noqa: E402
from kernel import lineage as LIN  # noqa: E402
from kernel import objects as O  # noqa: E402
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


def test_a_regex_label_gives_each_record_a_value_and_its_counts_are_citations(root: Path):
    r = run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "yes        2  r1#sorry=yes@n" in r.stdout
    assert "no         4  r1#sorry=no@n" in r.stdout
    assert "Cite a count as [2](r1#sorry=yes@n)" in r.stdout
    st = Store(root)
    # the rule went over every record and none entered a context: the file is computed over, not seen
    cov = LIN.coverage(st)
    f = next(x for x in cov["files"] if x["path"] == "chat/room.jsonl")
    assert f["status"] == "computed" and f["computed"] == 6 and not f["seen"] and cov["total"]["seen_rows"] == 0
    assert "Computed over by a query or a rule label, none of it read: 6 of 6 records (100%)." in LIN.coverage_text(cov)
    res = LIN.resolve(st, "r1#sorry=yes@n", n=5)
    assert res["count"] == 2
    assert [x["ref"] for x in res["records"]] == ["chat/room.jsonl#L1", "chat/room.jsonl#L3"]
    # the two rows the resolve showed are seen; the rest stays computed over
    f = next(x for x in LIN.coverage(st)["files"] if x["path"] == "chat/room.jsonl")
    assert f["status"] == "seen" and f["seen_lines"] == 2 and f["computed_rows"] == 4
    # its card: the counts bound to the query, each value's records as examples, saved to the change feed
    lab = LB.load(st, "sorry")
    obj = O.load(st, lab["card"])
    assert obj["label"] == "sorry" and obj["title"] == "sorry: 2 of 6 records are yes"
    assert obj["text"] == "[2](r1#sorry=yes@n) of 6 records are yes."
    assert {s["ref"] for s in obj["data"]["samples"]["yes"]} == {"chat/room.jsonl#L1", "chat/room.jsonl#L3"}
    assert [e["kind"] for e in feed(root)] == ["save"]


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


def test_a_prompt_label_waits_for_the_model_then_takes_its_answers(root: Path):
    r = run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.", "--reason")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "6 records wait for the model" in r.stdout and "1 call of up to 50 records" in r.stdout
    st = Store(root)
    # the reads are asked for in the change feed, on the label's card
    ev = feed(root)[-1]
    assert ev["kind"] == "label" and ev["name"] == "apology" and ev["object"] == LB.load(st, "apology")["card"]
    w = json.loads(run(root, "label", "apology", "--waiting").stdout)
    assert w["definition"] == "The message apologizes." and w["reason"] is True and len(w["units"]) == 6
    assert w["batches"] == [[u["ref"] for u in w["units"]]]
    refs = [u["ref"] for u in w["units"]]
    payload = {"values": {refs[0]: {"value": "yes", "confidence": 0.9, "reason": "says sorry"},
                          refs[1]: {"value": "No"}, refs[2]: {"value": "maybe"}},
               "failed": {refs[3]: "the call failed: api-error 529"}}
    got = json.loads(run(root, "label", "apology", "--answers", "-", "--json", stdin=json.dumps(payload)).stdout)
    assert got["took"] == 2 and got["failed"] == 2 and got["waiting"] == 2 and got["card"] is None
    payload = {"values": {refs[4]: {"value": "yes"}, refs[5]: {"value": "no"}}}
    got = json.loads(run(root, "label", "apology", "--answers", "-", "--json", stdin=json.dumps(payload)).stdout)
    # nothing waits: counted again, and the card saved again
    assert got["waiting"] == 0 and got["counts"] == {"yes": 2, "no": 2} and got["card"]["version"] == 2
    lab = LB.load(st, "apology")
    assert lab["units"][refs[2]]["err"].startswith("the model gave 'maybe'")
    assert lab["units"][refs[0]]["why"] == "says sorry"
    out = run(root, "label", "apology").stdout
    assert "2 records have no value" in out and "--again" in out
    # again: the two without a value wait again, and the reads are asked for again
    out = run(root, "label", "apology", "--again").stdout
    assert "2 records wait for the model (1 call)" in out
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
    assert "yes        3  r2#sorry=yes@n" in out and "the analyst checked 2: 1 agree, 1 disagree" in out
    # each record's labels, as the detail view reads them, the check included
    of = json.loads(run(root, "label", "--of", "chat/room.jsonl#L5", "chat/room.jsonl#L2").stdout)
    assert of["chat/room.jsonl#L5"]["sorry"] == {"value": "yes", "by": "analyst", "values": ["yes", "no"], "checked": True, "was": "no"}
    assert of["chat/room.jsonl#L2"]["sorry"]["value"] == "no"
    # a resolve says how the rows split by the label, and each record's value
    res = json.loads(run(root, "resolve", "chat/room.jsonl#L1-6", "--json", "-n", "6").stdout)
    assert res["labels"]["sorry"]["values"] == {"yes": 3, "no": 3}
    assert res["records"][4]["labels"] == {"sorry": "yes"}


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
    ev = feed(root)[-1]
    assert ev["kind"] == "label_ask" and ev["units"] == 420 and ev["sample"] == 300
    assert ev["text"] == "Read 420 records of chat/big.jsonl with Claude" and ev["meta"] == "9 model calls"
    assert "the analyst's choice" in run(root, "label", "spam").stdout
    # Claude cannot answer for the person: a made-up ask id is refused and the label still waits
    r = run(root, "label", "spam", "--answer", "all", "--ask", "a000")
    assert r.returncode == 1 and LB.load(st, "spam")["run"]["state"] == "ask"
    # the person's key: a sample of 300 of the 420 that wait; the reads are asked for in the feed
    got = json.loads(run(root, "label", "spam", "--answer", "sample", "--ask", ev["ask"]).stdout)
    assert got["reads"] == 300 and got["waiting"] == 300 and got["card"]["id"] == LB.load(st, "spam")["card"]
    out = run(root, "label", "spam").stdout
    assert "a random sample of 300" in out and "the other 120 records have no value" in out
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


def test_a_card_counted_where_pandas_is_missing_shows_the_labels_own_counts_and_no_stale_citation(root: Path, monkeypatch: pytest.MonkeyPatch):
    """The shell's kernel may run in a Python without pandas: after the model's reads it cannot run the count query, so
    the old query (an earlier count) no longer counts the label. Nothing cites it, and the card shows the label's own
    counts."""
    st = Store(root)
    LB.define(st, "apology", "prompt", "The message apologizes.", "chat/*.jsonl")
    refs = [u["ref"] for u in LB.waiting(st, "apology")["units"]]
    LB.answers(st, "apology", {"values": {refs[0]: {"value": "yes"}}})
    old = LB.count_query(st, "apology")
    assert old and LB.load(st, "apology")["query"] == old["id"]
    LB.answers(st, "apology", {"values": {r: {"value": "yes" if i < 3 else "no"} for i, r in enumerate(refs[1:])}})
    monkeypatch.setitem(sys.modules, "pandas", None)  # import pandas fails, as in a Python without it
    assert LB.count_query(st, "apology") is None
    assert LB.load(st, "apology")["query"] is None
    card = LB.save_card(st, "apology")
    assert sorted(card["data"]["counts"], key=lambda r: r["apology"]) == [{"apology": "no", "n": 2}, {"apology": "yes", "n": 4}]
    assert card["title"] == "apology: 4 of 6 records are yes" and old["id"] not in card["text"]


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
