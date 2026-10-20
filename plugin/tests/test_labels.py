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
