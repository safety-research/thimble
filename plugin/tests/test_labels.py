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
from kernel import query as Q  # noqa: E402
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
    assert "Computed over by a query or a rule label, none of them seen: 6 rows (100%)." in LIN.coverage_text(cov)
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


def test_use_gives_a_label_to_a_later_query_with_its_rows(root: Path):
    run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    st = Store(root)
    q = Q.run(st, "sorry per agent", 'df = load("chat/*.jsonl")\n'
              'df = df.merge(use("sorry")[["_ref", "sorry"]], on="_ref")\n'
              'tally(df[df.sorry == "yes"], "agent")\n')
    assert q["error"] is None, q["stdout"]
    assert q["lineage"] == "exact"
    assert q["uses"] == [{"name": "sorry", "query": "r1", "label": "sorry", "rev": LB.load(st, "sorry")["rev"]}]
    assert q["table"] == [{"agent": "wren", "n": 2}]
    # `thimble rows --label` reads the records with a value, each with its value
    r = run(root, "rows", "chat/*.jsonl", "--label", "sorry=yes")
    assert "chat/room.jsonl#L1  [sorry: yes · regex]" in r.stdout
    assert "2 of 2 matching rows" in r.stdout


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


def test_a_label_named_with_an_underscore_keeps_one_card_through_its_versions(root: Path):
    r = run(root, "label", "says_sorry", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.")
    assert r.returncode == 0, r.stdout + r.stderr
    st = Store(root)
    card = LB.load(st, "says_sorry")["card"]
    w = json.loads(run(root, "label", "says_sorry", "--waiting").stdout)
    payload = {"values": {u["ref"]: {"value": "no"} for u in w["units"]}}
    got = json.loads(run(root, "label", "says_sorry", "--answers", "-", "--json", stdin=json.dumps(payload)).stdout)
    # the card saved again is the same card at its next version, never a second card
    assert got["card"] == {"id": card, "version": 2}
    assert [i for i in O.all_ids(st) if "says-sorry" in i] == [card]


def test_the_same_definition_keeps_its_values_and_labels_only_new_records(root: Path):
    run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.", "--limit", "2")
    st = Store(root)
    lab = LB.load(st, "apology")
    assert lab["trial"] and len(lab["units"]) == 2
    first = list(lab["units"])
    run(root, "label", "apology", "--answers", "-", stdin=json.dumps({"values": {r: {"value": "no"} for r in first}}))
    run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.")
    lab = LB.load(st, "apology")
    assert lab["version"] == 1 and len(lab["units"]) == 6
    assert all(lab["units"][r]["v"] == "no" for r in first)
    assert LB.status(lab)["waiting"] == 4
    # a changed definition is a new version, whose records start again
    run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes to a person.")
    lab = LB.load(st, "apology")
    assert lab["version"] == 2 and LB.status(lab)["waiting"] == 6


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


def test_set_gives_records_values_claude_judged_after_reading(root: Path):
    r = run(root, "label", "blame", "--set", "chat/room.jsonl#L1=self", "chat/room.jsonl#L5.b0=self", "chat/room.jsonl#L2=none")
    assert r.returncode == 0, r.stdout + r.stderr
    st = Store(root)
    lab = LB.load(st, "blame")
    assert lab["kind"] == "set" and lab["values"] == ["self", "none"]
    assert set(lab["units"]) == {"chat/room.jsonl#L1", "chat/room.jsonl#L5", "chat/room.jsonl#L2"}
    assert LB.status(lab)["counts"] == {"self": 2, "none": 1}


def test_wait_says_plainly_when_no_session_makes_the_calls(root: Path, monkeypatch: pytest.MonkeyPatch):
    run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.")
    st = Store(root)
    with LB.locked(st, "apology"):
        lab = LB.load(st, "apology")
        lab["run"]["asked"] -= 600
        LB.write(st, lab, change=False)
    r = run(root, "label", "apology", "--wait", "5")
    assert r.returncode == 1 and "no session has started the model's calls" in r.stdout


def test_wait_waits_once_the_calls_are_picked_up(root: Path):
    run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.")
    run(root, "label", "apology", "--answers", "-", stdin=json.dumps({"run": {"state": "running"}}))
    st = Store(root)
    with LB.locked(st, "apology"):
        lab = LB.load(st, "apology")
        lab["run"]["asked"] -= 600
        LB.write(st, lab, change=False)
    r = run(root, "label", "apology", "--wait", "2")
    assert r.returncode == 0 and "still 6 records waiting after 2s" in r.stdout


def test_waiting_gives_one_wave_of_batches_and_counts_every_waiting_record(root: Path, monkeypatch: pytest.MonkeyPatch):
    run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.")
    st = Store(root)
    w = LB.waiting(st, "apology")
    assert w["waiting"] == 6 and len(w["units"]) == 6 and len(w["batches"]) == 1
    # in batches of two records: the first two batches only, while `waiting` still counts all six
    monkeypatch.setattr(LB, "batches", lambda units: [[u["ref"] for u in units[i:i + 2]] for i in range(0, len(units), 2)])
    first = LB.waiting(st, "apology", first=2)
    assert first["waiting"] == 6 and len(first["batches"]) == 2
    assert [u["ref"] for u in first["units"]] == [r for b in first["batches"] for r in b] == [u["ref"] for u in w["units"][:4]]
    out = json.loads(run(root, "label", "apology", "--waiting", "1").stdout)
    assert out["waiting"] == 6 and len(out["batches"]) == 1 and len(out["units"]) == 6


def test_wait_stops_when_the_reads_stopped_and_says_why(root: Path):
    run(root, "label", "apology", "--in", "chat/*.jsonl", "--prompt", "The message apologizes.")
    run(root, "label", "apology", "--answers", "-", stdin=json.dumps({"run": {"state": "running"}}))
    run(root, "label", "apology", "--answers", "-", stdin=json.dumps({"run": {"state": "failed", "error": "the label apology could not be read"}}))
    r = run(root, "label", "apology", "--wait", "30")
    assert r.returncode == 1 and "the model's calls stopped: the label apology could not be read" in r.stdout and "--again" in r.stdout


def test_the_label_viewer_reads_a_page_of_records_with_their_values_and_the_labels_with_their_definitions(root: Path):
    run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    run(root, "label", "sorry", "--check", "chat/room.jsonl#L2", "yes")
    # the labels list: each with its definition, kind, scope and counts
    labs = json.loads(run(root, "label", "--json").stdout)
    assert labs[0]["name"] == "sorry" and labs[0]["kind"] == "regex" and labs[0]["rule"] == "(?i)sorry|apolog"
    assert labs[0]["in"] == "chat/*.jsonl" and labs[0]["values"] == ["yes", "no"] and labs[0]["counts"] == {"yes": 3, "no": 3}
    # a page of one value's records, in order, each with its value, its source and its words
    got = json.loads(run(root, "label", "sorry", "--records", "yes", "--json").stdout)
    assert got["total"] == 3 and got["label"]["checked"] == 1
    recs = got["records"]
    assert [x["ref"] for x in recs] == ["chat/room.jsonl#L1", "chat/room.jsonl#L2", "chat/room.jsonl#L3"]
    assert [x["by"] for x in recs] == ["regex", "analyst", "regex"]
    assert recs[1]["checked"] and recs[1]["was"] == "no"
    assert "broke the build" in recs[0]["words"]
    # every record, a page at a time
    page = json.loads(run(root, "label", "sorry", "--records", "--at", "4", "--count", "5", "--json").stdout)
    assert page["total"] == 6 and [x["i"] for x in page["records"]] == [4, 5]
    # the viewer's reads are not in --help, which Claude reads
    assert "--records" not in run(root, "label", "--help").stdout


def test_a_card_or_a_citation_names_the_labels_it_rests_on(root: Path):
    run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    run(root, "label", "fixes", "--in", "chat/*.jsonl", "--regex", "(?i)fix|revert")
    st = Store(root)
    # a query that reads a label (use) rests on it, and one built on that query rests on it too
    q1 = Q.run(st, "sorry per agent", 'df = load("chat/*.jsonl")\n'
               'df = df.merge(use("sorry")[["_ref", "sorry"]], on="_ref")\n'
               'tally(df, ["agent", "sorry"])\n')
    assert q1["labels"] == ["sorry"]
    q2 = Q.run(st, "agents who apologized", f'd = use("{q1["id"]}")\nd[d.sorry == "yes"]\n')
    q3 = Q.run(st, "fixes by label_rows", 'tally(label_rows("fixes"), "fixes")\n')
    assert q3["labels"] == ["fixes"]
    plain = Q.run(st, "rows per agent", 'tally(load("chat/*.jsonl"), "agent")\n')
    # a card on the first query, the label's own card, and a card that reads no label
    card = O.save(st, "apologies", {"title": "Apologies", "program": "return k.text('x')", "data": {"rows": q1["id"]}})
    plain_card = O.save(st, "agents", {"title": "Agents", "program": "return k.text('x')", "data": {"rows": plain["id"]}})
    lab = LB.load(st, "sorry")
    by = LB.used_by(st, [card["id"], lab["card"], f"{q2['id']}#agent=wren@n", f"{lab['query']}#sorry=yes@n", q3["id"],
                         plain_card["id"], plain["id"], "chat/room.jsonl#L1", "no-such-card"])
    assert by == {card["id"]: ["sorry"], lab["card"]: ["sorry"], f"{q2['id']}#agent=wren@n": ["sorry"],
                  f"{lab['query']}#sorry=yes@n": ["sorry"], q3["id"]: ["fixes"]}
    # the command answers with each label's head, for the shell to draw its values in their colors
    got = json.loads(run(root, "label", "--used-by", card["id"], q3["id"], "--json").stdout)
    assert got["by"] == {card["id"]: ["sorry"], q3["id"]: ["fixes"]}
    assert [x["name"] for x in got["labels"]] == ["fixes", "sorry"] and got["labels"][1]["values"] == ["yes", "no"]
    assert "--used-by" not in run(root, "label", "--help").stdout
