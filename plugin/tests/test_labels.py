"""Labels (engine/kernel/labels.py, `thimble label`): a category given to every record of a scope by a regex or the
model (records that wait for its reads), with counts per value; a big model label asks the person first; labels are
kept under thimble's home, and nothing is written in the folder. Run: python3 -m pytest plugin/tests/test_labels.py"""
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
    # --says: the rule in a plain sentence, which the pane reads; the same definition without it keeps it, a new one drops it
    run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog", "--says", "The writer  apologizes.")
    assert LB.head(LB.load(st, "sorry"))["says"] == "The writer apologizes."
    run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry|apolog")
    assert LB.head(LB.load(st, "sorry"))["says"] == "The writer apologizes."
    run(root, "label", "sorry", "--in", "chat/*.jsonl", "--regex", "(?i)sorry")
    assert LB.head(LB.load(st, "sorry"))["says"] == ""


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
    assert "Not started" in r.stdout and "the analyst chooses first" in r.stdout
    # Claude is told that the analyst is asked when its command ends and to wait for the reads after their choice, and
    # the trial's counts are said as the trial's only
    assert "They are asked when your command ends." in r.stdout
    assert "After their choice, `thimble label spam --wait` waits for the model's reads" in r.stdout
    assert "Answer now" not in r.stdout and "Counts from a trial are not the label's" in r.stdout
    ev = feed(root)[-1]
    assert ev["kind"] == "label_ask" and ev["units"] == 420 and ev["sample"] == 300
    # the records' size, as the batches count it, from which the plugin says about what the run costs
    assert ev["chars"] > 420 * 40
    assert ev["text"] == "Read 420 records of chat/big.jsonl with Claude" and ev["meta"] == "9 model calls"
    assert "the analyst's choice" in run(root, "label", "spam").stdout
    # --wait says at once that nothing runs before they choose: they are asked only once Claude's command ends
    t0 = time.time()
    r = run(root, "label", "spam", "--wait", "60")
    assert r.returncode == 0 and time.time() - t0 < 30
    assert "spam: waits for the analyst's choice, and nothing runs until they choose" in r.stdout
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
    assert "run them or cancel" in r.stdout and "the analyst is asked again" in r.stdout
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


def test_the_labels_pane_applies_a_sample_the_ask_picked_again_over_its_same_records(root: Path):
    with open(root / "chat" / "big.jsonl", "w") as f:
        for i in range(420):
            f.write(json.dumps({"agent": "wren", "text": f"message {i}", "n": i}) + "\n")
    st = Store(root)
    spam = ["label", "spam", "--in", "chat/big.jsonl", "--prompt", "The message is spam."]
    run(root, *spam, "--limit", "25")
    run(root, *spam)
    got = json.loads(run(root, "label", "spam", "--answer", "sample", "--ask", feed(root)[-1]["ask"]).stdout)
    assert got["reads"] == 300
    held = set(LB.held(LB.load(st, "spam")))
    assert len(held) == 300
    # the pane's change of its model: a new version over the same 300 records, still a trial of the 420, so its reads
    # start without an ask
    r = run(root, *spam, "--model", "haiku", "--same-records", "--json")
    assert r.returncode == 0, r.stdout + r.stderr
    lab = LB.load(st, "spam")
    assert lab["model"] == "haiku" and lab["version"] == 2 and lab["trial"] is True and lab["matched"] == 420
    assert set(lab["units"]) == held and all(u.get("wait") for u in lab["units"].values())
    assert lab["run"]["state"] == "asked" and feed(root)[-1]["kind"] == "label"
    # the same change over the whole scope reads all 420, so it asks first, its cost on the label's own model; --json
    # says the run waits for that ask, by its id, so the pane asks the person who ran it (labels/edit.ts)
    got = json.loads(run(root, *spam, "--model", "sonnet", "--json").stdout)
    lab = LB.load(st, "spam")
    assert len(lab["units"]) == 420 and lab["trial"] is False and lab["run"]["state"] == "ask"
    assert feed(root)[-1]["kind"] == "label_ask" and feed(root)[-1]["model"] == "sonnet"
    assert got["run"]["state"] == "ask" and got["run"]["ask"]["id"] == feed(root)[-1]["ask"]


# ------------------------------------------------------------------ a label belongs to its conversation


# ------------------------------------------------------------------ Labels off (hooks/path.ts, cli.labels_off)
