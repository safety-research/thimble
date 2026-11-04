"""B19: a citation of a label's counts is checked against the label as it was when the cited words were written (its
versions), never as it is now; and no false count can be made to verify through the versions. Made-up labels and
cards only. The cases with a name from an earlier round (P…, S…, A…, B…, C…, D…) are the attacks that broke the
earlier designs (r108-labelcite rounds 1 and 2), kept as tests."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from kernel.evidence import card_index, check_all, check_mark, terminal_label_cards  # noqa: E402

VALIDATE = Path(__file__).resolve().parents[1] / "engine" / "validate.py"
T0 = 1_780_000_000.0  # when the trial's version was made; the others follow it


def label(version: int, nav: str, total: str, at: float, made: str, after: str = "", cid: str = "q7r2t5") -> dict:
    """A version of a label card as a host gives it: its table (value, records), whose row `all` totals the values
    (`totals`), when it was made and what made it, and what changed after it."""
    return {"id": cid, "title": "Which theme?", "version": version, "from": at, "made": made, "after": after,
            "outputs": [{"out": 0, "corner": "value", "totals": "all",
                         "cells": [["records", "navigation", nav], ["records", "clutter", "4"], ["records", "all", total]]}]}


# the live case: a trial (v1), the label redefined in main's own turn (v2, its rows gone), then, after the reply, the
# run on every record (v3)
TRIAL = label(1, "13", "40", T0, "run over 40 records", "redefined; run over 423 records")
REDEFINED = label(2, "0", "0", T0 + 60, "redefined", "run over 423 records")
FULL = label(3, "118", "423", T0 + 120, "run over 423 records")
V = [FULL, TRIAL, REDEFINED]  # in no order: the validator orders a card's versions by when they were made
CODE = {"id": "c0de01", "title": "Merged per agent", "outputs": [{"out": 0, "corner": "agent", "cells": [
    ["merged", "agent-07", "12"], ["merged", "all", "40"]]}]}
TOTAL = {"id": "t0ta15", "title": "Records per file", "outputs": [{"out": 0, "corner": "file", "cells": [["records", "all", "423"]]}]}
REPLY = T0 + 90  # the reply's words were written after the redefinition, before the full run
LATER = T0 + 200


def item(ref, status: str = "verified", correction: dict | None = None, reason: str = "the card shows it", **more) -> dict:
    return {"kind": "card", "status": status, "evidence": {"ref": ref}, "correction": correction, "reason": reason, **more}


def check(words: str, it: dict, cards=None, at: float | None = REPLY, sentence: str | None = None) -> dict:
    m = {"n": 1, "words": words, "sentence": sentence or f"In the trial, [{words}] records were about navigation."}
    return check_mark(m, it, [], "/data", cards=V if cards is None else cards, at=at)


def outcome(r: dict) -> tuple:
    return (r["status"], r.get("failedBy"), r.get("reason"))


TRIAL_REFS = ["card:q7r2t5@v1#records/navigation", "card:q7r2t5@v1#records/all"]


def test_a_trial_s_count_holds_against_the_trial_after_the_label_changed():
    """The reply cited the trial's counts after main redefined the label in its own turn: the label then showed 0, and
    later the full run's counts. Checked against the version made by then that shows them, the trial's, it verifies;
    the evidence says which version it is and what changed after it."""
    r = check("13 of the 40", item(TRIAL_REFS))
    assert r["status"] == "verified", r
    ev = r["evidence"]
    assert (ev["version"], ev["at"], ev["made"], ev["after"]) == (1, T0, "run over 40 records", "redefined; run over 423 records")
    assert ev["table"]["rows"][ev["table"]["at"]["r"]] == {"label": "navigation", "values": ["13"]}
    # the label as it was when the words were written is the redefined one, which shows no trial count
    assert outcome(check("13 of the 40", item(["card:q7r2t5#records/navigation", "card:q7r2t5#records/all"]))) == (
        "failed", "evidence", "None of the 2 cited cells of the card shows 13 or 40.")
    # before the redefinition, the label as it was is the trial itself
    assert check("13 of the 40", item(["card:q7r2t5#records/navigation", "card:q7r2t5#records/all"]), at=T0 + 30)["status"] == "verified"


def test_a_version_made_after_the_words_is_no_evidence_of_them():
    """P-later: the full run's counts were made after the reply, which could not have read them; a check that cites
    them, by their version or as the label now, does not confirm words written before."""
    full = ["card:q7r2t5@v3#records/navigation", "card:q7r2t5@v3#records/all"]
    assert outcome(check("118 of the 423", item(full))) == (
        "failed", "evidence", "The card's version 3 was made after these words were written.")
    # a correction of a trial sentence to the full run's numbers rests on the same version: neither holds
    r = check("13 of the 40", item(full, "corrected", {"words": "118 of the 423"}))
    assert (r["status"], r["failedBy"], r["shown"]) == ("failed", "evidence", "13 of the 40"), r
    # read now (no time given), the full run is the label, and the trial an earlier version of it
    assert check("118 of the 423", item(["card:q7r2t5#records/navigation", "card:q7r2t5#records/all"]), at=None)["status"] == "verified"
    assert check("13 of the 40", item(TRIAL_REFS), at=None)["status"] == "verified"
    # a label all of whose versions were made after the words is no evidence of them either
    assert outcome(check("13 of the 40", item(TRIAL_REFS), at=T0 - 5)) == (
        "failed", "evidence", "The card's version 1 was made after these words were written.")
    assert outcome(check("13", item("card:q7r2t5#records/navigation"), at=T0 - 5)) == (
        "failed", "evidence", "The card has no version from before these words were written.")


@pytest.mark.parametrize("name, words, refs, cards, at", [
    # P2: the trial's count beside the full run's total, true of no version
    ("P2 two versions of one label", "13 of the 423", ["card:q7r2t5@v1#records/navigation", "card:q7r2t5@v3#records/all"], None, LATER),
    ("P2 a version beside the label now", "13 of the 423", ["card:q7r2t5@v1#records/navigation", "card:q7r2t5#records/all"], None, LATER),
    # S8 and p9: the trial's count beside another card's total
    ("S8 a version beside another card now", "13 of the 423", ["card:q7r2t5@v1#records/navigation", "card:t0ta15#records/all"], [*V, TOTAL], LATER),
    ("S8 the label as it was beside another card now", "13 of the 423", ["card:q7r2t5#records/navigation", "card:t0ta15#records/all"], [*V, TOTAL], T0 + 30),
    # B5: the same chimera written with `cell:`
    ("B5 cell: and card: of two versions", "13 of the 423", ["cell:q7r2t5@v1#records/navigation", "card:q7r2t5#records/all"], None, LATER),
])
def test_places_that_never_showed_their_values_at_one_time_confirm_nothing(name, words, refs, cards, at):
    r = check(words, item(refs), cards, at)
    assert (r["status"], r["failedBy"]) == ("failed", "evidence"), (name, r)


def test_places_shown_at_one_time_stand_together():
    """Two labels' versions shown together, or a label still shown now beside a card as it is now, stand together: a
    claim that joins them is a claim of one moment."""
    other = label(1, "9", "40", T0 + 10, "run over 40 records", cid="b2c3d4")
    both = [*V, other]
    r = check("13 and 9", item(["card:q7r2t5@v1#records/navigation", "card:b2c3d4#records/navigation"]), both, T0 + 30,
              sentence="In the trial, [13 and 9] records were about navigation.")
    assert r["status"] == "verified", r
    # the label as it is now, unchanged since its version, beside a card as it is now
    both = ["card:q7r2t5#records/navigation", "card:t0ta15#records/all"]
    r = check("118 and 423", item(both), [*V, TOTAL], LATER,
              sentence="Now [118 and 423] records are about navigation and in the files.")
    assert r["status"] == "verified", r
    # B20: places shown at one time are still two rows of two cards, which show no count of one out of the other
    assert outcome(check("118 of the 423", item(both), [*V, TOTAL], LATER)) == (
        "failed", "evidence", "The cited places show 118 and 423 in different rows, not 118 out of 423.")


@pytest.mark.parametrize("name, ref, cards, reason", [
    ("D v9 that never was", "card:q7r2t5@v9#records/navigation", None, "The card has no version 9."),
    ("D v0", "card:q7r2t5@v0#records/navigation", None, "The card has no version 0."),
    ("P8 a version of a card that keeps none", "card:c0de01@v1#merged/agent-07", [CODE], "The card has no version 1."),
    ("D a version number too long to be one", "card:q7r2t5@v99999999999999999999#records/navigation", None,
     "The check named no value or line of a card."),
    ("B7 a version with no place", "card:q7r2t5@v1", None, "The check named no value or line of a card."),
    ("B6 a version's lines a label card has none of", "card:q7r2t5@v1@out0#L1-L3", None, "The card's output has no line 1."),
])
def test_a_version_the_card_does_not_have_names_no_place(name, ref, cards, reason):
    assert outcome(check("13", item(ref), cards, LATER)) == ("failed", "evidence", reason), name


def test_a_checker_s_finding_is_never_hidden_by_a_version():
    """P7, S1-S3, A1-A7: whatever the checker found on a version stands as it would on any card: wrong stays wrong with
    its reason, a correction or a narrowing is judged against the version's values, and an unconfirmed claim keeps the
    checker's reason. No status says only that the label changed."""
    r = check("15 of the 40", item(TRIAL_REFS, "wrong", reason="The trial counted 13, not 15."))
    assert outcome(r) == ("failed", "check", "The trial counted 13, not 15.") and r["evidence"]["version"] == 1
    r = check("15 of the 40", item(TRIAL_REFS, "wrong", {"words": "13 of the 40"}, "The trial counted 13."))
    assert (r["status"], r["shown"], r["was"]) == ("corrected", "13 of the 40", "15 of the 40")
    r = check("15 of the 40", item(TRIAL_REFS, "verified", {"sentence": "In the trial, [13 of the 40] records were about navigation."}))
    assert (r["status"], r["shown"]) == ("corrected", "13 of the 40")
    r = check("15 of the 40", item(TRIAL_REFS, "narrowed", {"words": "13 of the 40"}))
    assert outcome(r) == ("failed", "evidence", "The check cut the citation down to words that are not part of it.")
    r = check("15 of the 40", item(TRIAL_REFS, "unconfirmed", reason="The trial counted 13 of the 40, not 15."))
    assert outcome(r) == ("failed", "evidence", "The trial counted 13 of the 40, not 15.")
    for status in ("Verified", "partly"):
        assert check("15 of the 40", item(TRIAL_REFS, status))["failedBy"] == "none"
    # a correction to words the version does not show is no correction
    r = check("15 of the 40", item(TRIAL_REFS, "corrected", {"words": "14 of the 40"}))
    assert (r["status"], r["failedBy"], r["shown"]) == ("failed", "evidence", "15 of the 40")


def test_card_evidence_of_other_shapes_beside_a_version_is_read_as_its_places():
    """B1-B4: a quote's object among a card's evidence names no place; `refs` and lists of evidence objects are read
    as their places, which must stand together."""
    quote = {"file": "notes.md", "line": 1, "substring": "13 of the 40"}
    r = check("15 of the 40", {**item(None), "evidence": [quote, {"ref": "card:q7r2t5@v1#records/navigation"}]}, at=LATER)
    assert (r["status"], r["failedBy"]) == ("failed", "evidence"), r
    r = check("13", {**item(None), "evidence": {"refs": ["card:q7r2t5@v3#records/navigation", "card:q7r2t5@v1#records/navigation"]}}, at=LATER)
    assert r["reason"] == "The check cited places of 2 versions of the card, and no version shows them together.", r
    r = check("13 of the 423", {**item(None), "evidence": [{"ref": "card:q7r2t5@v1#records/navigation"}, {"refs": ["card:t0ta15#records/all"]}]},
              [*V, TOTAL], LATER)
    assert r["reason"] == "The check cited a version of a card that changed after it, beside a card as it is now.", r


def test_versions_a_host_gives_twice_or_out_of_order_are_read_once_in_the_order_they_were_made():
    twice = [*V, {**label(1, "15", "40", T0 + 1, "a copy"), "id": "q7r2t5"}]
    assert check("15", item("card:q7r2t5@v1#records/navigation"), twice, LATER)["status"] == "failed"
    assert check("13", item("card:q7r2t5@v1#records/navigation"), twice, LATER)["status"] == "verified"
    # an entry whose time is no number keeps no versions: it is the card as it is now
    odd = [{**label(1, "13", "40", T0, "x"), "from": float("nan")}]
    assert check("13", item("card:q7r2t5#records/navigation"), odd, LATER)["status"] == "verified"
    assert check("13", item("card:q7r2t5@v2#records/navigation"), odd, LATER)["reason"] == "The card has no version 2."


def test_the_checker_s_index_lists_a_label_as_it_was_when_the_words_were_written_and_its_earlier_versions():
    index = card_index([*V, CODE], REPLY)
    head = ("# card:q7r2t5 Which theme? (as it was when the cited words were written; made by: redefined; it changed after: "
            "run over 423 records)\n")
    assert head + "card:q7r2t5#records/navigation\t0\n" in index, index
    assert ("# card:q7r2t5@v1 Which theme? (an earlier version; made by: run over 40 records; it changed after: redefined; "
            "run over 423 records)\ncard:q7r2t5@v1#records/navigation\t13\n") in index, index
    assert "@v3" not in index and "\t118" not in index, "a version made after the words is not listed"
    assert "# card:c0de01 Merged per agent\ncard:c0de01#merged/agent-07\t12\n" in index
    # the label now, after its earlier versions; a label with one version and no change since: its plain heading
    assert ("# card:q7r2t5 Which theme? (as it was when the cited words were written; made by: run over 423 records)\n"
            "card:q7r2t5#records/navigation\t118\n") in card_index(V, LATER)
    assert "# card:q7r2t5 Which theme?\ncard:q7r2t5#records/navigation\t13\n" in card_index([{**TRIAL, "after": ""}], T0 + 30)
    # a label made after the words is left out
    assert "q7r2t5" not in card_index(V, T0 - 1)


def test_the_terminal_s_labels_are_cards_of_their_kept_versions_and_validate_reads_them_as_of_the_reply(tmp_path):
    labels = tmp_path / "labels"
    labels.mkdir()
    versions = [{"v": 1, "at": T0, "made": "a trial over 40 records", "cols": ["records"],
                 "rows": [["navigation", ["13"]], ["clutter", ["27"]], ["all", ["40"]]]},
                {"v": 2, "at": T0 + 120, "made": "run over 423 records", "cols": ["records"],
                 "rows": [["navigation", ["118"]], ["clutter", ["305"]], ["all", ["423"]]]}]
    (labels / "theme.json").write_text(json.dumps({"name": "theme", "versions": versions}))
    (labels / "old.json").write_text(json.dumps({"name": "old"}))  # a label from before thimble kept versions
    cards = terminal_label_cards(str(labels))
    assert [(c["id"], c["version"], c["after"]) for c in cards] == [("label-theme", 1, "run over 423 records"), ("label-theme", 2, "")]
    assert ["records", "navigation", "13"] in cards[0]["outputs"][0]["cells"]
    words = {"n": 1, "words": "13 of the 40", "sentence": "In the trial, [13 of the 40] records were about navigation."}
    plain = ["card:label-theme#records/navigation", "card:label-theme#records/all"]
    answer = "```json\n" + json.dumps([{"mark": 1, **item(plain)}]) + "\n```"
    req = {"marks": [words], "answer": answer, "calls": [], "cwd": "/data", "labels_dir": str(labels), "at": T0 + 30}
    ran = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps(req), capture_output=True, text=True, check=True)
    assert json.loads(ran.stdout)["results"][0]["status"] == "verified"
    # read later, the label is the full run; the same words cite the trial by its version
    ran = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps({**req, "at": T0 + 200}), capture_output=True, text=True, check=True)
    assert json.loads(ran.stdout)["results"][0]["status"] == "failed"
    answer = "```json\n" + json.dumps([{"mark": 1, **item(["card:label-theme@v1#records/navigation", "card:label-theme@v1#records/all"])}]) + "\n```"
    ran = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps({**req, "answer": answer, "at": T0 + 200}),
                         capture_output=True, text=True, check=True)
    assert json.loads(ran.stdout)["results"][0]["status"] == "verified"
    # the index the checker greps lists the labels as of the reply, each version's counts also as a table a count names
    out = tmp_path / "index.tsv"
    subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps({"index": str(out), "labels_dir": str(labels), "at": T0 + 30}),
                   capture_output=True, text=True, check=True)
    assert ("# card:label-theme label theme (as it was when the cited words were written; made by: a trial over 40 records; it "
            "changed after: run over 423 records)\ncard:label-theme@out0\ta table of 3 rows: value, records\n"
            "card:label-theme#records/navigation\t13\n") in out.read_text()


def test_check_all_reads_every_mark_at_the_time_its_words_were_written():
    answer = "```json\n" + json.dumps([{"mark": 1, **item(["card:q7r2t5#records/navigation", "card:q7r2t5#records/all"])}]) + "\n```"
    marks = [{"n": 1, "words": "13 of the 40", "sentence": "[13 of the 40] records"}]
    assert check_all(marks, answer, [], "/data", cards=V, at=T0 + 30)["results"][0]["status"] == "verified"
    assert check_all(marks, answer, [], "/data", cards=V, at=LATER)["results"][0]["status"] == "failed"


def test_a_count_of_a_label_s_values_reads_one_version_as_it_was_when_the_words_were_written(tmp_path):
    """B19 with B20: a label's version is also a table a count of its rows names (`card:<id>@out0`, `@v<n>` an earlier
    one), its row `all` left out as the row that totals the values. The count reads the version the words could have
    read: an earlier one by its `@v<n>`, never one made after them, and one count reads one version."""
    labels = tmp_path / "labels"
    labels.mkdir()
    themes = ("navigation", "clutter", "pricing")
    versions = [{"v": 1, "at": T0, "made": "a trial over 40 records", "cols": ["records"],
                 "rows": [[t, [str(n)]] for t, n in zip(themes, (13, 9, 18))] + [["all", ["40"]]]},
                {"v": 2, "at": T0 + 120, "made": "run over 423 records", "cols": ["records"],
                 "rows": [[t, [str(n)]] for t, n in zip(themes, (118, 205, 100))] + [["all", ["423"]]]}]
    (labels / "theme.json").write_text(json.dumps({"name": "theme", "versions": versions}))
    cards = terminal_label_cards(str(labels))
    ten = {"records": {">=": 10}}

    def count(words: str, ref, at: float) -> dict:
        sentence = f"In the trial, [{words}] themes came up in at least 10 records."
        return check(words, {**item(None), "evidence": {"ref": ref, "count": ten}}, cards, at, sentence)

    # the trial by its version after the full run, and the label as it was when the words were written
    assert count("2 of the 3", "card:label-theme@v1@out0", LATER)["status"] == "verified"
    assert count("2 of the 3", "card:label-theme@out0", T0 + 30)["status"] == "verified"
    assert outcome(count("2 of the 3", "card:label-theme@out0", LATER)) == (
        "failed", "evidence", "The card's table has 3 rows with records at least 10, not 2.")
    # a version made after the words, versions of two times, and the total row as a theme
    assert outcome(count("3 of the 3", "card:label-theme@v2@out0", T0 + 30)) == (
        "failed", "evidence", "The card's version 2 was made after these words were written.")
    assert outcome(count("3 of the 3", ["card:label-theme@v1@out0", "card:label-theme@v2@out0"], LATER)) == (
        "failed", "evidence", "The check named more than one table for one count.")
    assert outcome(count("3 of the 4", "card:label-theme@out0", LATER)) == (
        "failed", "evidence", "The card's table has 3 rows besides the row all that sums them up, not 4.")
    # the index lists each version's table under its heading, and none made after the words
    index = card_index(cards, T0 + 30)
    assert "card:label-theme@out0\ta table of 4 rows: value, records\n" in index and index.count("\ta table of") == 1
    assert "card:label-theme@v1@out0\ta table of 4 rows: value, records\n" in card_index(cards, LATER)
