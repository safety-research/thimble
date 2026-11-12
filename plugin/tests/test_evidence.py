"""The marks' validator (engine/kernel/evidence.py, engine/validate.py) on made-up files and calls."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from kernel.evidence import check_all, check_mark  # noqa: E402

CODE = 'import json\nprs = [json.loads(l) for l in open("prs.jsonl")]\nprint(f"{sum(p[\'merged\'] for p in prs)} of {len(prs)}")'


def call(code: str, output: str) -> dict:
    return {"command": f"cd /data && python3 - <<'PY'\n{code}\nPY", "output": output, "by": "checker"}


def computed(output: str = "of 40", status: str = "verified", correction: dict | None = None) -> dict:
    """The checker's answer for a mark, its evidence the call that printed `output`."""
    return {"kind": "computed", "status": status, "evidence": {"output": output}, "correction": correction, "reason": "counted"}


def quote(file: str, line, sub: str, kind: str = "quote") -> dict:
    return {"kind": kind, "status": "verified", "evidence": {"file": file, "line": line, "substring": sub}, "reason": "the record says so"}


def mark(words: str) -> dict:
    return {"n": 1, "words": words}


def test_computed_evidence_is_the_real_call_that_printed_the_output_the_check_gave():
    ok = check_mark(mark("12 of 40"), computed("12 of 40"), [call(CODE, "12 of 40\n")], "/data")
    assert ok["status"] == "verified" and ok["evidence"]["output"] == "12 of 40\n" and ok["evidence"]["highlight"] == [[0, 8]]
    assert ok["evidence"]["code"] == CODE
    # the checker's own copy of the output does not count: only the call's real output
    assert check_mark(mark("12 of 40"), computed("12 of 40"), [call(CODE, "11 of 40\n")], "/data")["status"] == "failed"
    # the call that printed the cited text must show the words
    other = check_mark(mark("12 of 40"), computed("of 40"), [call(CODE, "11 of 40\n")], "/data")
    assert other["status"] == "failed" and other["reason"] == "The result reads “11 of 40”, not 12."
    # left-out text is "…", and white space is read loosely
    long = "rows: 40\nmerged:   12 of 40\n"
    assert check_mark(mark("12 of 40"), computed("rows: 40 … merged: 12 of 40"), [call(CODE, long)], "/data")["status"] == "verified"


def test_computed_evidence_carries_the_checks_method_and_a_quote_carries_none(tmp_path: Path):
    how = "Counted the lines of prs.jsonl whose merged field is true, out of all its lines, one line per pull request."
    ok = check_mark(mark("12 of 40"), {**computed("12 of 40"), "method": f"  {how}\n"}, [call(CODE, "12 of 40\n")], "/data")
    assert ok["status"] == "verified" and ok["evidence"]["method"] == how
    # a claim the check found wrong keeps its real evidence, and the method with it
    wrong = check_mark(mark("15 of 40"), {**computed("12 of 40", status="wrong"), "method": how}, [call(CODE, "12 of 40\n")], "/data")
    assert wrong["status"] == "failed" and wrong["evidence"]["method"] == how
    # a quote shows no code, so it carries no method
    (tmp_path / "board.md").write_text("agent-07: yes, that was me\n")
    said = check_mark(mark('"yes, that was me"'), {**quote("board.md", 1, "yes, that was me"), "method": how}, [], str(tmp_path))
    assert said["status"] == "verified" and "method" not in said["evidence"]


def test_a_typed_in_value_is_no_evidence_but_a_bound_is_a_condition():
    typed = 'n = 15\nprint(f"{n} of 40")'
    assert "by hand" in check_mark(mark("15 of 40"), computed("15 of 40"), [call(typed, "15 of 40")], "/data")["reason"]
    bound = 'import json\nrows = [json.loads(l) for l in open("p.jsonl")]\nprint(sum(1 for r in rows if r["age"] < 13))'
    assert check_mark(mark("13 children"), computed("13"), [call(bound, "13")], "/data")["status"] == "verified"
    one_line = {"command": "python3 -c 'print(15)'", "output": "15", "by": "main"}
    assert "by hand" in check_mark(mark("15 of 40"), computed("15"), [one_line], "/data")["reason"]


def test_a_correction_is_confirmed_only_when_the_evidence_shows_the_words_it_puts_in(tmp_path: Path):
    out = "15:53:00 git diff main..review/118 --stat -> 3 files changed\n15:54:10 pytest -k weekly -> 9 passed, 69 deselected"
    was = 'reading the diff and running only the "weekly" tests'

    def corrected(words: str) -> dict:
        return check_mark(mark(was), computed(out, status="corrected", correction={"words": words}), [call(CODE, out)], "/data")

    # a free description of what the output means: its quoted part is in the output, the words it puts in are not
    r = corrected('looking only at the file summary (git diff --stat) and running only the "weekly" tests')
    assert (r["status"], r["failedBy"], r["shown"]) == ("failed", "evidence", was) and "was" not in r
    assert r["reason"].startswith("The check offered other words, but the result does not show “looking only at")
    # words the output holds as words, a changed count, and words only left out are confirmed
    assert corrected('reading the diff --stat and running only the "weekly" tests')["status"] == "corrected"
    assert corrected('running 9 "weekly" tests')["status"] == "corrected"
    assert corrected('running only the "weekly" tests')["status"] == "corrected"
    # a word inside a longer word is not the word
    assert corrected('running only the "weekly" select tests')["status"] == "failed"
    # the same for a quote of a record: the cited line shows the words the correction puts in
    (tmp_path / "board.md").write_text("agent-03: rebase pr/<n> onto current main and force-push\n")
    item = {"kind": "quote", "status": "corrected", "evidence": {"file": "board.md", "line": 1, "substring": "rebase pr/<n>"},
            "reason": "the post says otherwise"}
    ok = check_mark(mark("rebase any old branch"), {**item, "correction": {"words": "rebase pr/<n> onto current main"}}, [], str(tmp_path))
    assert (ok["status"], ok["was"]) == ("corrected", "rebase any old branch")
    gone = check_mark(mark("rebase any old branch"), {**item, "correction": {"words": "rebase a stale branch"}}, [], str(tmp_path))
    assert gone["status"] == "failed" and "a stale" in gone["reason"]


def test_quote_hit_and_miss(tmp_path: Path):
    (tmp_path / "board.md").write_text("intro\nagent-07: yes, that was me\nbye\n")
    hit = check_mark(mark('"yes, that was me"'), quote("board.md", 2, "yes, that was me"), [], str(tmp_path))
    assert hit["status"] == "verified"
    ev = hit["evidence"]
    assert ev["file"] == "board.md" and ev["line"] == "2" and [r["n"] for r in ev["lines"]] == [1, 2, 3]
    assert ev["lines"][1]["highlight"] == [10, 26]
    miss = check_mark(mark('"yes, that was me"'), quote("board.md", 3, "yes, that was not me"), [], str(tmp_path))
    assert miss["status"] == "failed" and miss["reason"] == "Line 3 of board.md reads “bye”, not these words." and miss["failedBy"] == "evidence"
    outside = check_mark(mark("x"), quote("../secret.txt", 1, "x"), [], str(tmp_path))
    assert "outside the folder" in outside["reason"]


def test_what_code_does_may_cite_claudes_own_code_in_the_temp_folder_a_quote_may_not(tmp_path: Path):
    (tmp_path / "data").mkdir()
    (tmp_path / "tmp").mkdir()
    (tmp_path / "tmp" / "rule.py").write_text("def label(r):\n    return len(r['authors']) >= 10\n")
    code = check_mark(mark("at least 10 accounts"), quote(str(tmp_path / "tmp" / "rule.py"), 2, "len(r['authors']) >= 10", kind="code"), [], str(tmp_path / "data"), None, str(tmp_path / "tmp"))
    assert code["status"] == "verified" and code["evidence"]["file"] == str(tmp_path / "tmp" / "rule.py")
    said = check_mark(mark("at least 10 accounts"), quote(str(tmp_path / "tmp" / "rule.py"), 2, "len(r['authors']) >= 10"), [], str(tmp_path / "data"), None, str(tmp_path / "tmp"))
    assert said["status"] == "failed" and "outside the folder" in said["reason"]


def test_a_file_cited_through_a_link_to_the_session_folder_shows_by_its_path_in_the_folder(tmp_path: Path):
    """N39: the session folder ~/traces is a link to a folder on another disk. A quote of one of its files holds by any
    path that leads there, and the person sees the file by its path in the folder, never one that climbs out of it."""
    real, home = tmp_path / "disk" / "traces", tmp_path / "home"
    real.mkdir(parents=True)
    home.mkdir()
    (real / "notes.ndjson").write_text(json.dumps({"note": "rolled back at 23:14"}) + "\n")
    (home / "traces").symlink_to(real)
    for file, cwd, root in ((home / "traces" / "notes.ndjson", real, real), ("notes.ndjson", home / "traces", real),
                            (real / "notes.ndjson", home / "traces", home / "traces")):
        r = check_mark(mark("rolled back at 23:14"), quote(str(file), 1, "rolled back at 23:14"), [], str(cwd), str(root))
        assert (r["status"], r["evidence"]["file"]) == ("verified", "notes.ndjson"), (file, r)


def test_a_link_to_a_file_outside_the_folder_and_a_pipe_are_no_evidence(tmp_path: Path):
    import os
    outside = tmp_path / "outside.txt"
    outside.write_text("the secret line\n")
    data = tmp_path / "data"
    data.mkdir()
    (data / "link.txt").symlink_to(outside)
    os.mkfifo(data / "pipe")
    assert "outside the folder" in check_mark(mark('"the secret line"'), quote("link.txt", 1, "the secret line"), [], str(data))["reason"]
    assert check_mark(mark('"x"'), quote("pipe", 1, "x"), [], str(data))["status"] == "failed"


def _code_and_secret(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    """A corpus folder, a temp folder holding a file of Claude's code (tmp/sub/code.py), and outside both a file the
    check must never show a line of."""
    corpus, tmp, outside = (tmp_path.resolve() / n for n in ("corpus", "ws-tmp", "outside"))
    for d in (corpus, tmp / "sub", outside):
        d.mkdir(parents=True)
    (tmp / "sub" / "code.py").write_text("x = 1  # made-up code\n")
    (outside / "secret.txt").write_text("TOPSECRET-LINE-OF-A-FILE-OUTSIDE\n")
    return corpus, tmp, tmp / "sub" / "code.py", outside / "secret.txt"


def test_a_link_put_in_place_of_a_cited_file_after_its_real_path_was_compared_shows_nothing_outside(tmp_path: Path, monkeypatch):
    """The check compared a cited file's real path with the folders, then opened the file by its path, so a link that
    code a card runs put in the temp folder in place of the file, or of a folder on its way, between the two steps had
    the check read the file it points to: its line stood in the reason and in the lines shown, which main reads. Here
    the real path is taken as the comparison saw it (before the link came), and the file is read as it lies inside the
    folder now, never through the link."""
    import os

    import kernel.evidence as E

    corpus, tmp, code, secret = _code_and_secret(tmp_path)
    elsewhere = tmp_path.resolve() / "elsewhere"  # a folder outside that holds a file by the cited file's name
    elsewhere.mkdir()
    (elsewhere / "code.py").write_text(secret.read_text())
    real = os.path.realpath
    for swapped, target in ((code, secret), (code.parent, elsewhere)):
        aside = swapped.with_name(swapped.name + ".real")
        swapped.rename(aside)
        swapped.symlink_to(target, target_is_directory=target.is_dir())
        monkeypatch.setattr(os.path, "realpath", lambda p, *a, **k: os.fspath(p) if os.fspath(p) == str(code) else real(p, *a, **k))
        try:
            problems, shown, hay, _ = E.place({"file": str(code), "line": "1", "substring": "made-up"}, str(corpus), str(corpus), [str(tmp)])
        finally:
            monkeypatch.setattr(os.path, "realpath", real)
            swapped.unlink()
            aside.rename(swapped)
        assert "TOPSECRET" not in repr((problems, shown, hay)), (problems, shown, hay)
        assert problems == ["sub/code.py has no line 1"] and shown is None, problems
    problems, shown, _, _ = E.place({"file": str(code), "line": "1", "substring": "made-up"}, str(corpus), str(corpus), [str(tmp)])
    assert problems == [] and shown["lines"][0]["text"] == "x = 1  # made-up code"


# ------------------------------------------------------------------------------------------------ card evidence

CARDS = [{"id": "k3f9a1", "title": "Merged pull requests by agent", "outputs": [
    {"out": 0, "corner": "agent", "cells": [["merged", "agent-03", "4"], ["total", "agent-03", "10"], ["merged", "agent-07", "12"], ["total", "agent-07", "40"]]},
    {"out": 1, "lines": [[1, "          merged  total"], [2, "agent-03       4     10"], [3, "agent-07      12     40"]]},
]}]


def card(ref: str, status: str = "verified", correction: dict | None = None) -> dict:
    return {"kind": "card", "status": status, "evidence": {"ref": ref}, "correction": correction, "reason": "the card shows it"}


def test_a_card_s_cell_is_evidence_and_shows_as_its_table_with_the_cell_cited():
    r = check_mark(mark("12"), card("card:k3f9a1#merged/agent-07"), [], "/data", cards=CARDS)
    assert r["status"] == "verified" and r["evidence"]["kind"] == "card" and r["evidence"]["title"] == "Merged pull requests by agent"
    t = r["evidence"]["table"]
    assert t["corner"] == "agent" and t["cols"] == ["merged", "total"] and t["rows"][t["at"]["r"]] == {"label": "agent-07", "values": ["12", "40"]} and t["at"]["c"] == 0
    # the place must hold the words, and must be a place of a card of the session
    wrong = check_mark(mark("13"), card("card:k3f9a1#merged/agent-07"), [], "/data", cards=CARDS)
    assert wrong["status"] == "failed" and wrong["failedBy"] == "evidence" and "shows 12" in wrong["reason"]
    assert check_mark(mark("12"), card("card:zzzzzz#merged/agent-07"), [], "/data", cards=CARDS)["status"] == "failed"
    assert check_mark(mark("12"), card("card:k3f9a1#merged/agent-99"), [], "/data", cards=CARDS)["status"] == "failed"
    # a correction's new words stand at the place
    fixed = check_mark(mark("15"), card("card:k3f9a1#merged/agent-07", "corrected", {"words": "12"}), [], "/data", cards=CARDS)
    assert fixed["status"] == "corrected" and fixed["shown"] == "12" and fixed["was"] == "15"


# ------------------------------------------------------------------------------------------------ one path to a correct citation

def test_a_period_in_code_ends_no_sentence_of_a_rewrite_but_a_sentence_put_in_is_one_too_many(tmp_path: Path):
    (tmp_path / "README.md").write_text("cd backend && uv run uvicorn app.main:app --port 9000\n")
    was = {"n": 1, "words": "port 8000", "sentence": "The app runs on [port 8000]: start it with `uvicorn app.main:app --port 8000`."}

    def reworded(sentence: str) -> dict:
        item = {**quote("README.md", 1, "--port 9000"), "status": "corrected", "reason": "",
                "correction": {"words": "port 9000", "sentence": sentence}}
        return check_mark(was, item, [], str(tmp_path))

    ok = reworded("The app runs on [port 9000]: start it with `uvicorn ... --port 9000`.")
    assert (ok["status"], ok["rewrite"]) == ("corrected", "The app runs on [port 9000]: start it with `uvicorn ... --port 9000`.")
    more = reworded("The app runs on [port 9000]. Start it with `uvicorn ... --port 9000`.")
    assert more["status"] == "failed" and more["reason"] == "The check reworded the sentence, but it adds a sentence."


def test_one_check_of_two_citations_of_a_sentence_rewrites_it_once_for_both(tmp_path: Path):
    """Both citations of the sentence went out of date with one edit. A check of one alone could not rewrite the
    sentence: the rewrite changed the other citation's words. One check of both rewrites it once, each citation held
    to its own evidence, and a rewrite that gives a citation other words than its own result cannot stand."""
    (tmp_path / "README.md").write_text("cd backend && uv run uvicorn app.main:app --port 9000\nOpen http://localhost:9000.\n")
    was = "The app runs on [port 8000]: start it with `uvicorn ... --port 8000`, then open [http://localhost:8000]."
    now = "The app runs on [port 9000]: start it with `uvicorn ... --port 9000`, then open [http://localhost:9000]."
    marks = [{"n": 1, "words": "port 8000", "sentence": was}, {"n": 2, "words": "http://localhost:8000", "sentence": was}]

    def item(n: int, line: int, words: str, sentence: str | None = now, status: str = "corrected") -> dict:
        return {"mark": n, **quote("README.md", line, words), "status": status, "reason": "the README says 9000 now",
                "correction": {"words": words, **({"sentence": sentence} if sentence else {})} if status == "corrected" else None}

    def check(*items: dict, of: list[dict] = marks) -> list[dict]:
        return check_all(of, "```json\n" + json.dumps(list(items)) + "\n```", [], str(tmp_path))["results"]

    # the same new sentence for both, or the sentence for one and the words for the other, or each bracketing only
    # its own words: both corrected, the one rewrite on each
    one = now.replace("[http://localhost:9000]", "http://localhost:9000")
    two = now.replace("[port 9000]", "port 9000")
    for answers in ((item(1, 1, "port 9000"), item(2, 2, "http://localhost:9000")),
                    (item(1, 1, "port 9000"), item(2, 2, "http://localhost:9000", None)),
                    (item(1, 1, "port 9000", one), item(2, 2, "http://localhost:9000", two))):
        got = check(*answers)
        assert [(r["status"], r["shown"], r.get("was"), r.get("rewrite")) for r in got] == [
            ("corrected", "port 9000", "port 8000", now), ("corrected", "http://localhost:9000", "http://localhost:8000", now)], got
    # a check of one alone cannot change the other's words
    (alone,) = check(item(1, 1, "port 9000"), of=marks[:1])
    assert alone["status"] == "failed" and "rewrite" not in alone
    # a rewrite that gives the other citation words its own check does not confirm cannot stand
    first, second = check(item(1, 1, "port 9000"), item(2, 2, "http://localhost:8000", status="verified"))
    assert (first["status"], first["reason"]) == ("failed", "The check reworded the sentence, but it changes the other citations of the sentence.")
    assert second["status"] == "failed" and "rewrite" not in first


def test_two_citations_of_a_sentence_with_the_same_words_each_take_the_words_at_their_own_place(tmp_path: Path):
    """"[10] are major and [10] are minor": after one edit the counts read 11 and 9, and the check gives the new sentence
    for both. Each citation is the one at its own place, so the second takes 9 from it, not the first one's 11."""
    (tmp_path / "counts.txt").write_text("major: 11\nminor: 9\n")
    was = "Of the [22] findings, [10] are major and [10] are minor."
    now = "Of the [22] findings, [11] are major and [9] are minor."
    marks = [{"n": 1, "words": "10", "sentence": was}, {"n": 2, "words": "10", "sentence": was}]
    items = [{"mark": n, **quote("counts.txt", n, sub), "status": "corrected", "correction": {"words": words, "sentence": now}}
             for n, sub, words in ((1, "major: 11", "11"), (2, "minor: 9", "9"))]
    got = check_all(marks, "```json\n" + json.dumps(items) + "\n```", [], str(tmp_path))["results"]
    assert [(r["status"], r["shown"], r.get("was")) for r in got] == [("corrected", "11", "10"), ("corrected", "9", "10")], got


def test_a_rewording_may_say_a_value_its_correction_changed_again_but_cuts_none_out_of_the_citation():
    """A re-check after an edit: "3 lines" now reads "0 lines", and the rewording says what the 3 lines read now. The
    3 is a value the correction changed, not one it left out of the citation, so the rewording stands when the evidence
    shows it. A value it does not show, and a value cut out of the citation with none in its place, still fail."""
    out = "0 lines mention port 8000\n3 lines mention port 9000\n"
    code = ("lines = open('README.md').read().splitlines()\nfor port in (8000, 9000):\n"
            "    print(f\"{sum(str(port) in l for l in lines)} lines mention port {port}\")")
    was = {"n": 1, "words": "3 lines", "sentence": "[3 lines] of the README mention port 8000."}

    def reworded(sentence: str, words: str = "0 lines", mark: dict = was, printed: str = out) -> dict:
        item = {**computed(printed.split("\n")[0], "corrected", {"words": words, "sentence": sentence}), "reason": "none of them now"}
        return check_mark(mark, item, [call(code, printed)], "/data", fresh=True)

    ok = reworded("[0 lines] of the README mention port 8000 now, because the 3 lines that did now say 9000.")
    assert (ok["status"], ok["shown"], ok["was"]) == ("corrected", "0 lines", "3 lines"), ok
    unshown = reworded("[0 lines] of the README mention port 8000 now, because the 3 lines that did now say 9000.",
                       printed="0 lines mention port 8000\n")
    assert unshown["status"] == "failed" and unshown["reason"].startswith("The records do not show “now, because the 3 lines"), unshown
    cut = reworded("Of the 40 runs, [12] failed.", "12", {"n": 1, "words": "15 of 40", "sentence": "Of the runs, [15 of 40] failed."},
                   "12 failed\n")
    assert cut["status"] == "failed" and cut["reason"] == "The check reworded the sentence, but it leaves “40” out of the citation, a value of the data.", cut


# ------------------------------------------------------------------------------------------------ why a citation failed


# ------------------------------------------------------------------------------------------------ B19: no path of this machine in a reason
