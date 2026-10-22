"""The marks' validator (engine/kernel/evidence.py, engine/validate.py) on made-up files and calls."""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from kernel.evidence import check_all, check_mark  # noqa: E402

VALIDATE = Path(__file__).resolve().parents[1] / "engine" / "validate.py"
CODE = 'import json\nprs = [json.loads(l) for l in open("prs.jsonl")]\nprint(f"{sum(p[\'merged\'] for p in prs)} of {len(prs)}")'


def call(code: str, output: str, by: str = "checker") -> dict:
    return {"command": f"cd /data && python3 - <<'PY'\n{code}\nPY", "output": output, "by": by}


def computed(output: str = "of 40", status: str = "verified", correction: dict | None = None) -> dict:
    """The checker's answer for a mark, its evidence the call that printed `output`."""
    return {"kind": "computed", "status": status, "evidence": {"output": output}, "correction": correction, "reason": "counted"}


def quote(file: str, line, sub: str, kind: str = "quote") -> dict:
    return {"kind": kind, "status": "verified", "evidence": {"file": file, "line": line, "substring": sub}, "reason": "the record says so"}


def mark(words: str, n: int = 1) -> dict:
    return {"n": n, "words": words}


def test_computed_evidence_is_the_real_call_that_printed_the_output_the_check_gave():
    ok = check_mark(mark("12 of 40"), computed("12 of 40"), [call(CODE, "12 of 40\n")], "/data")
    assert ok["status"] == "verified" and ok["evidence"]["output"] == "12 of 40\n" and ok["evidence"]["highlight"] == [[0, 8]]
    assert ok["evidence"]["code"] == CODE
    # the checker's own copy of the output does not count: only the call's real output
    assert check_mark(mark("12 of 40"), computed("12 of 40"), [call(CODE, "11 of 40\n")], "/data")["status"] == "failed"
    # the call that printed the cited text must show the words
    other = check_mark(mark("12 of 40"), computed("of 40"), [call(CODE, "11 of 40\n")], "/data")
    assert other["status"] == "failed" and "does not show" in other["reason"]
    # left-out text is "…", and white space is read loosely
    long = "rows: 40\nmerged:   12 of 40\n"
    assert check_mark(mark("12 of 40"), computed("rows: 40 … merged: 12 of 40"), [call(CODE, long)], "/data")["status"] == "verified"


def test_the_highlight_starts_where_the_cited_output_stands():
    out = "open: 12\nmerged: 12 of 40\n"
    r = check_mark(mark("12"), computed("merged: 12 of 40"), [call(CODE, out)], "/data")
    assert r["status"] == "verified" and r["evidence"]["highlight"] == [[17, 19]]


def test_main_calls_count_and_a_call_that_runs_more_than_a_script_shows_whole():
    r = check_mark(mark("12 of 40"), computed("12 of 40"), [call(CODE, "12 of 40", by="main")], "/data")
    assert r["status"] == "verified" and r["evidence"]["by"] == "main"
    piped = {"command": f"python3 - <<'PY' 2>&1 | head -5\n{CODE}\nPY", "output": "12 of 40", "by": "main"}
    r = check_mark(mark("12 of 40"), computed("12 of 40"), [piped], "/data")
    assert r["status"] == "verified" and r["evidence"]["code"] == piped["command"]


def test_a_number_inside_a_longer_number_does_not_show_it():
    r = check_mark(mark("12 of 40"), computed("of 400"), [call(CODE, "112 of 400")], "/data")
    assert r["status"] == "failed"


def test_number_words_read_as_digits():
    r = check_mark(mark("three times"), computed("3 times"), [call(CODE, "3 times")], "/data")
    assert r["status"] == "verified"


def test_a_typed_in_value_is_no_evidence_but_a_bound_is_a_condition():
    typed = 'n = 15\nprint(f"{n} of 40")'
    assert "by hand" in check_mark(mark("15 of 40"), computed("15 of 40"), [call(typed, "15 of 40")], "/data")["reason"]
    bound = 'import json\nrows = [json.loads(l) for l in open("p.jsonl")]\nprint(sum(1 for r in rows if r["age"] < 13))'
    assert check_mark(mark("13 children"), computed("13"), [call(bound, "13")], "/data")["status"] == "verified"
    one_line = {"command": "python3 -c 'print(15)'", "output": "15", "by": "main"}
    assert "by hand" in check_mark(mark("15 of 40"), computed("15"), [one_line], "/data")["reason"]


def test_a_correction_is_checked_on_its_new_words():
    corr = {"words": "12 of 40", "was": "15 of 40"}
    r = check_mark(mark("15 of 40"), computed("12 of 40", status="corrected", correction=corr), [call(CODE, "12 of 40")], "/data")
    assert (r["status"], r["shown"], r["was"]) == ("corrected", "12 of 40", "15 of 40")
    bad = check_mark(mark("15 of 40"), computed("12 of 40", status="corrected", correction={"words": "13 of 40"}), [call(CODE, "12 of 40")], "/data")
    assert bad["status"] == "failed" and bad["shown"] == "15 of 40"


def test_a_correction_is_confirmed_only_when_the_evidence_shows_the_words_it_puts_in(tmp_path: Path):
    out = "15:53:00 git diff main..review/118 --stat -> 3 files changed\n15:54:10 pytest -k weekly -> 9 passed, 69 deselected"
    was = 'reading the diff and running only the "weekly" tests'

    def corrected(words: str) -> dict:
        return check_mark(mark(was), computed(out, status="corrected", correction={"words": words}), [call(CODE, out)], "/data")

    # a free description of what the output means: its quoted part is in the output, the words it puts in are not
    r = corrected('looking only at the file summary (git diff --stat) and running only the "weekly" tests')
    assert (r["status"], r["failedBy"], r["shown"]) == ("failed", "evidence", was) and "was" not in r
    assert r["reason"].startswith("Not confirmed: the check gave other words") and "looking only at" in r["reason"]
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
    assert miss["status"] == "failed" and "does not hold" in miss["reason"] and miss["failedBy"] == "evidence"
    outside = check_mark(mark("x"), quote("../secret.txt", 1, "x"), [], str(tmp_path))
    assert "outside the folder" in outside["reason"]


def test_quote_in_a_decoded_jsonl_line_and_a_range(tmp_path: Path):
    rec = {"role": "agent-03", "text": 'He said "ship it"\nthen left'}
    (tmp_path / "log.jsonl").write_text("{}\n" + json.dumps(rec) + "\n{}\n")
    r = check_mark(mark("\"ship it\" then left"), quote("log.jsonl", 2, 'He said "ship it" then left'), [], str(tmp_path))
    assert r["status"] == "verified" and r["evidence"]["lines"][1].get("decoded") is True
    (tmp_path / "a.py").write_text("def f():\n    return 1\n")
    code = check_mark(mark("returns 1"), quote("a.py", "1-2", "def f(): return 1", kind="code"), [], str(tmp_path))
    assert code["status"] == "verified" and code["evidence"]["kind"] == "code"


def test_a_failed_mark_keeps_its_reason_and_a_missing_one_stays_unchecked():
    out = check_all([mark("a", 1), mark("b", 2)], '```json\n[{"mark": 1, "status": "wrong", "reason": "no record says so"}]\n```', [], "/data")
    assert out["parsed"] is True
    assert [(r["status"], r["reason"]) for r in out["results"]] == [("failed", "no record says so"), ("unchecked", "the check gave no answer for this citation")]
    assert check_all([mark("a")], "I could not check it.", [], "/data")["parsed"] is False


def test_validate_entry_reads_json_on_stdin(tmp_path: Path):
    req = {"cwd": str(tmp_path), "marks": [mark("12 of 40")], "answer": "```json\n" + json.dumps([{"mark": 1, **computed("12 of 40")}]) + "\n```", "calls": [call(CODE, "12 of 40")]}
    r = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps(req), capture_output=True, text=True, check=True)
    assert json.loads(r.stdout)["results"][0]["status"] == "verified"


def test_a_label_that_opens_an_output_line_shows_no_value():
    code = 'k = len(open("a.txt").read().split())\nprint(f"3: {k} times")'
    assert check_mark(mark("3 times"), computed("3: 2 times"), [call(code, "3: 2 times")], "/data")["status"] == "failed"
    assert check_mark(mark("2 times", 3), computed("3: 2 times"), [call(code, "3: 2 times")], "/data")["status"] == "verified"


def test_a_record_id_and_a_compared_value_are_conditions_not_typed_values():
    code = 'import sqlite3\nc = sqlite3.connect("f.db")\nprint(c.execute("select at from claims where pr = 118").fetchone()[0])'
    assert check_mark(mark("claimed #118 at 14:28"), computed("14:28"), [call(code, "14:28")], "/data")["status"] == "verified"
    code2 = 'import csv\nrows = list(csv.DictReader(open("t.csv")))\nprint(sum(1 for r in rows if r["Pclass"] in ("1", "2") and r["g"] == "teen 13-17"))'
    assert check_mark(mark("2 of them"), computed("2"), [call(code2, "2")], "/data")["status"] == "verified"


def test_a_condition_the_code_uses_may_stand_in_its_printed_words():
    code = 'import csv\nrows = list(csv.DictReader(open("t.csv")))\nkids = [r for r in rows if r["Age"] and float(r["Age"]) < 12]\nprint(f"{sum(r[\'Survived\'] == \'1\' for r in kids)} children under 12 survived")'
    assert check_mark(mark("39 children under 12 survived"), computed("39 children under 12 survived"), [call(code, "39 children under 12 survived")], "/data")["status"] == "verified"


def test_a_number_in_a_name_is_no_value_the_line_must_show(tmp_path: Path):
    (tmp_path / "log.jsonl").write_text(json.dumps({"at": "2026-08-30T14:29:00Z", "text": "ran the full suite"}) + "\n")
    r = check_mark(mark("agent-11 at 14:29"), quote("log.jsonl", 1, "14:29"), [], str(tmp_path))
    assert r["status"] == "verified"


def test_json_quoted_with_spaces_and_a_list_of_quoted_values(tmp_path: Path):
    (tmp_path / "p.jsonl").write_text('{"record_id":"pkg:1.0.1:a.yaml","kind":"added"}\n')
    r = check_mark(mark('"pkg:1.0.1:a.yaml"'), quote("p.jsonl", 1, '"record_id": "pkg:1.0.1:a.yaml"'), [], str(tmp_path))
    assert r["status"] == "verified"
    code = 'import json\nkinds = sorted({e["kind"] for l in open("p.jsonl") for e in [json.loads(l)]})\nprint("kinds:", kinds)'
    assert check_mark(mark('"added", "context" or "removed"'), computed("kinds: ['added', 'context', 'removed']"), [call(code, "kinds: ['added', 'context', 'removed']")], "/data")["status"] == "verified"


def test_a_line_number_a_few_lines_off_names_the_line_that_holds_the_words(tmp_path: Path):
    (tmp_path / "cli.py").write_text("".join(f"x{i} = {i}\n" for i in range(1, 20)) + "    return 1\n")
    r = check_mark(mark("exits with code 1"), quote("cli.py", 18, "return 1", kind="code"), [], str(tmp_path))
    assert r["status"] == "verified" and r["evidence"]["line"] == "20"


def test_digit_separators_and_a_scale_are_values():
    (code, out) = ('print(open("labels.py").read().count("x"))', "UNIT_CHARS = 4_000 and 8,225 files")
    assert check_mark(mark("4,000 characters"), computed(out), [call(code, out)], "/data")["status"] == "verified"
    assert check_mark(mark("8k files"), computed(out), [call(code, out)], "/data")["status"] == "verified"
    # 12k is no number of an output that holds 12 only inside a date
    assert check_mark(mark("12k files"), computed("as of 2026-10-12: 9,870 files"), [call(code, "as of 2026-10-12: 9,870 files")], "/data")["status"] == "failed"


def test_an_ordinal_in_a_label_and_a_date_in_code_are_no_typed_values():
    code = 'import csv\nrows = list(csv.DictReader(open("t.csv")))\ng = [r for r in rows if r["Pclass"] == "3"]\nprint(f"3rd-class women: {sum(r[\'S\'] == \'1\' for r in g)} of {len(g)}")'
    assert check_mark(mark("3 of 26"), computed("3rd-class women: 3 of 26"), [call(code, "3rd-class women: 3 of 26")], "/data")["status"] == "verified"
    dates = 'import json\nn = {}\nfor l in open("chat.jsonl"):\n    m = json.loads(l)["at"][:7]; n[m] = n.get(m, 0) + 1\nprint(f"April 2025: {n.get(\'2025-04\', 0)}", sorted(n))'
    assert check_mark(mark("only in April 2025"), computed("April 2025: 7 ['2025-04']"), [call(dates, "April 2025: 7 ['2025-04']")], "/data")["status"] == "verified"


def test_words_with_no_number_are_shown_by_their_record_names():
    code = 'import json\nprint(", ".join(f"#{p[\'n\']}" for l in open("prs.jsonl") for p in [json.loads(l)] if p["merged_by"] == "agent-02"))'
    assert check_mark(mark("merged #102, #125 and #130"), computed("#102, #125, #130"), [call(code, "#102, #125, #130")], "/data")["status"] == "verified"
    assert check_mark(mark("merged #102, #125 and #131"), computed("#102, #125, #130"), [call(code, "#102, #125, #130")], "/data")["status"] == "failed"


def test_a_correction_whose_output_does_not_show_its_new_words_is_not_confirmed_never_verified():
    # the check printed 126 and a test of the old bound; it corrected to 125, which no line shows. The old words' 250
    # stands in the output only as the label of a test that printed False: no words are confirmed
    out = "fewest prior messages 126; all in first session: True; all after 250 or more: False"
    corr = {"words": "in the first session, after 125 or more of its messages"}
    item = {**computed(out, status="corrected", correction=corr), "reason": "the earliest report came at message 126"}
    r = check_mark(mark("in the first session, after 250 or more of its messages"), item, [call(CODE, out)], "/data")
    assert (r["status"], r["failedBy"], r["shown"]) == ("failed", "evidence", "in the first session, after 250 or more of its messages")
    assert r["reason"].startswith("Not confirmed: the check gave other words") and "125" in r["reason"] and "was" not in r


def test_an_unconfirmed_claim_is_not_confirmed_never_wrong():
    out = "62 of 68 set to /tmp, mktemp -d or the run folder; 6 read from files"
    item = {**computed(out), "status": "unconfirmed", "reason": "6 values come from files the commands do not print"}
    r = check_mark(mark("each one is set to a /tmp path"), item, [call(CODE, out)], "/data")
    assert (r["status"], r["failedBy"], r["reason"]) == ("failed", "evidence", "6 values come from files the commands do not print")
    assert r["evidence"]["output"] == out


def test_a_failed_mark_keeps_the_real_evidence_the_check_gave():
    item = {**computed("602 deletions"), "status": "wrong", "reason": "the sentence says June 18, the deletions began on June 20"}
    r = check_mark(mark("602"), item, [call(CODE, "602 deletions, first on 2026-06-20")], "/data")
    assert r["status"] == "failed" and r["failedBy"] == "check" and r["evidence"]["output"].startswith("602")


def test_a_wrong_verdict_with_the_right_words_is_a_correction_and_one_without_them_fails():
    item = {**computed("12 of 40", status="wrong", correction={"words": "12 of 40"}), "reason": "agent-07 merged 12, not 15"}
    r = check_mark(mark("15 of 40"), item, [call(CODE, "12 of 40")], "/data")
    assert (r["status"], r["shown"], r["was"]) == ("corrected", "12 of 40", "15 of 40")
    bare = check_mark(mark("15 of 40"), {**item, "correction": None}, [call(CODE, "12 of 40")], "/data")
    assert (bare["status"], bare["failedBy"], bare["shown"]) == ("failed", "check", "15 of 40")


def test_an_answer_that_quotes_a_fence_still_parses():
    answer = 'Done.\n```json\n[{"mark": 1, "kind": "code", "status": "wrong", "evidence": {"substring": "re.compile(r\'```(?:json)?\')"}, "reason": "no"}]\n```'
    out = check_all([mark("a")], answer, [], "/data")
    assert out["parsed"] is True and out["results"][0]["status"] == "failed"


def test_a_quote_comes_from_the_records_its_numbers_with_it():
    read = 'import sqlite3\nc = sqlite3.connect("file:f.db?immutable=1", uri=True)\nprint(c.execute("select body from reports").fetchone()[0])'
    out = "Reviewed and merged 6 PRs: #107 (fix) #108 (docs)"
    assert check_mark(mark('"Reviewed and merged 6 PRs: #107 … #108"'), computed(out), [call(read, out)], "/data")["status"] == "verified"
    typed = 'print("Reviewed and merged 6 PRs: #107 and #108")'
    r = check_mark(mark('"Reviewed and merged 6 PRs: #107 … #108"'), computed(out), [call(typed, out)], "/data")
    assert r["status"] == "failed" and "quoted words" in r["reason"]
    found = read.replace('print(c.execute("select body from reports").fetchone()[0])', 'body = c.execute("select body from reports").fetchone()[0]\nif "merged 6 PRs: #107" in body: print("merged 6 PRs: #107")')
    assert check_mark(mark('"merged 6 PRs: #107"'), computed("merged 6 PRs: #107"), [call(found, "merged 6 PRs: #107")], "/data")["status"] == "verified"


def test_a_path_shows_from_the_folder_the_session_started_in(tmp_path: Path):
    (tmp_path / "plugin" / "engine").mkdir(parents=True)
    (tmp_path / "plugin" / "engine" / "labels.py").write_text("UNIT_CHARS = 4_000\n")
    # the shell had moved into plugin/, so the checker named the file from there
    r = check_mark(mark("4,000 characters"), quote("engine/labels.py", 1, "UNIT_CHARS = 4_000", kind="code"), [], str(tmp_path / "plugin"), str(tmp_path))
    assert r["status"] == "verified" and r["evidence"]["file"] == "plugin/engine/labels.py"


def test_an_index_a_key_an_operand_and_a_chosen_line_are_no_typed_values():
    median = 'import json\nrates = sorted(json.loads(l)["n"] for l in open("g.jsonl"))\nprint(f"median {rates[len(rates)//2]:.1f} per day")'
    assert check_mark(mark("about 2"), computed("median 2.0 per day"), [call(median, "median 2.0 per day")], "/data")["status"] == "verified"
    key = 'import json\nby = {}\nfor l in open("t.jsonl"):\n    r = json.loads(l); by[r["h"]] = by.get(r["h"], 0) + 1\nprint(f"driver ({by[\'01\']})")'
    assert check_mark(mark("1"), computed("driver (1)"), [call(key, "driver (1)")], "/data")["status"] == "verified"
    chosen = 'import json\ngaps = [json.loads(l)["gap"] for l in open("g.jsonl")]\nprint("no gap exceeds 5 minutes" if max(gaps) <= 300 else "a gap exceeds 5 minutes")'
    assert check_mark(mark("no gap exceeds 5 minutes"), computed("no gap exceeds 5 minutes"), [call(chosen, "no gap exceeds 5 minutes")], "/data")["status"] == "verified"
    # a value typed in a field of an f-string is still typed in
    typed = 'print(f"{15} of 40")'
    assert "by hand" in check_mark(mark("15 of 40"), computed("15 of 40"), [call(typed, "15 of 40")], "/data")["reason"]


def test_a_time_matches_its_fractions_of_a_second_and_about_rounds_to_its_zeros():
    code = 'import json\nprint([json.loads(l)["ts"] for l in open("t.jsonl")][0])'
    assert check_mark(mark("2026-07-18T21:29:27"), computed("2026-07-18T21:29:27.806896Z"), [call(code, "2026-07-18T21:29:27.806896Z")], "/data")["status"] == "verified"
    rng = 'import json\nn = [json.loads(l)["s"] for l in open("s.jsonl")]\nprint(f"{min(n)}-{max(n)}")'
    about = {"n": 1, "words": "250–620", "sentence": "Each agent ran about [250–620] sessions."}
    assert check_mark(about, computed("248-619"), [call(rng, "248-619")], "/data")["status"] == "verified"
    exact = {"n": 1, "words": "250–620", "sentence": "Each agent ran [250–620] sessions."}
    assert check_mark(exact, computed("248-619"), [call(rng, "248-619")], "/data")["status"] == "failed"


def test_a_correction_keeps_only_the_words_that_replace_the_mark():
    m = {"n": 1, "words": "936", "sentence": "Redaction is common ([936] records contain a `[redacted…]` marker, in any field)."}
    corr = {"words": "1405 records contain a `[redacted…]` marker", "was": "936"}
    code = 'import json\nrows = [json.loads(l) for l in open("t.jsonl")]\nprint(f"{sum(\'[redacted\' in json.dumps(r) for r in rows)} records")'
    r = check_mark(m, computed("1405 records", status="corrected", correction=corr), [call(code, "1405 records")], "/data")
    assert (r["status"], r["shown"]) == ("corrected", "1405")


def test_a_quote_worked_into_a_sentence_may_change_its_first_letter(tmp_path: Path):
    (tmp_path / "CHANGELOG.md").write_text("- Allowed whitelisted users to chat while public chat is closed\n")
    r = check_mark(mark('"allowed... to chat while public chat is closed"'), quote("CHANGELOG.md", 1, "to chat while public chat is closed"), [], str(tmp_path))
    assert r["status"] == "verified"


def test_a_claim_that_joins_two_places_cites_both(tmp_path: Path):
    (tmp_path / "shell.tsx").write_text("const shown = load()\n" + "x\n" * 80 + "write(path, shown)\n")
    ev = [{"file": "shell.tsx", "line": 1, "substring": "const shown = load()"}, {"file": "shell.tsx", "line": 82, "substring": "write(path, shown)"}]
    item = {"kind": "code", "status": "verified", "evidence": ev, "reason": "loaded, then written"}
    r = check_mark(mark('written to a "shown" file'), item, [], str(tmp_path))
    assert r["status"] == "verified" and r["evidence"]["line"] == "1" and r["evidence"]["more"][0]["line"] == "82"
    wide = check_mark(mark("x"), quote("shell.tsx", "1-82", "x", kind="code"), [], str(tmp_path))
    assert wide["status"] == "failed" and wide["reason"].startswith("Not confirmed:")


def test_a_note_on_the_rest_of_the_sentence_stays_beside_a_verified_mark():
    item = {**computed("12 of 40"), "note": "per-agent chat also rose, from 21.2 to 31.7"}
    r = check_mark(mark("12 of 40"), item, [call(CODE, "12 of 40")], "/data")
    assert r["status"] == "verified" and r["note"].startswith("per-agent")


def test_a_comma_between_fields_is_no_digit_separator(tmp_path: Path):
    (tmp_path / "people.csv").write_text('id,name,sex,age,sibsp,parch,ticket,fare\n7,"Rowe, Miss. Ada May",female,2,1,2,113781,151.55\n')
    r = check_mark(mark("Ada Rowe, age 2"), quote("people.csv", 2, 'Rowe, Miss. Ada May",female,2'), [], str(tmp_path))
    assert r["status"] == "verified"


def test_a_range_of_days_matches_the_same_days_written_another_way():
    code = 'import json\nrows = [json.loads(l) for l in open("e.jsonl")]\nprint(sorted({r["day"] for r in rows}))'
    days = call(code, "['2026-06-08', '2026-06-09', '2026-06-12']")
    assert check_mark(mark("8–12 June 2026"), computed("2026-06-08"), [days], "/data")["status"] == "verified"
    assert check_mark(mark("10–11 May"), computed("10 May 2025 (Sat), 11 May 2025 (Sun)"), [call(code, "10 May 2025 (Sat), 11 May 2025 (Sun)")], "/data")["status"] == "verified"
    # a day is a day: the 5 of 5pm is not 5 April
    assert check_mark(mark("5–6 April"), computed("posted at 5pm, 6 in all"), [call(code, "posted at 5pm, 6 in all")], "/data")["status"] == "failed"
    assert check_mark(mark("7–12 June 2026"), computed("2026-06-08"), [days], "/data")["status"] == "failed"


def test_a_number_in_an_f_strings_fixed_text_is_typed_only_when_no_field_printed_it():
    code = 'n = sum(1 for e in ev if e == "ended after 10 minutes")\nprint(f"In {n} of {len(ev)} sessions: ended after 10 minutes")'
    assert check_mark(mark("10"), computed("In 10 of 37 sessions: ended after 10 minutes"), [call(code, "In 10 of 37 sessions: ended after 10 minutes")], "/data")["status"] == "verified"
    typed = 'n = sum(p["merged"] for p in prs)\nprint(f"{n} of 40")'
    assert "40 in by hand" in check_mark(mark("12 of 40"), computed("12 of 40"), [call(typed, "12 of 40")], "/data")["reason"]


def test_a_file_name_in_a_typed_sentence_does_not_excuse_its_numbers():
    code = 'print("cv_detect.py and solve.py (3 touches each)")'
    assert "3 in by hand" in check_mark(mark("cv_detect.py and solve.py (3 touches each)"), computed("cv_detect.py and solve.py (3 touches each)"), [call(code, "cv_detect.py and solve.py (3 touches each)")], "/data")["reason"]


def test_what_code_does_may_cite_claudes_own_code_in_the_temp_folder_a_quote_may_not(tmp_path: Path):
    (tmp_path / "data").mkdir()
    (tmp_path / "tmp").mkdir()
    (tmp_path / "tmp" / "rule.py").write_text("def label(r):\n    return len(r['authors']) >= 10\n")
    code = check_mark(mark("at least 10 accounts"), quote(str(tmp_path / "tmp" / "rule.py"), 2, "len(r['authors']) >= 10", kind="code"), [], str(tmp_path / "data"), None, str(tmp_path / "tmp"))
    assert code["status"] == "verified" and code["evidence"]["file"] == str(tmp_path / "tmp" / "rule.py")
    said = check_mark(mark("at least 10 accounts"), quote(str(tmp_path / "tmp" / "rule.py"), 2, "len(r['authors']) >= 10"), [], str(tmp_path / "data"), None, str(tmp_path / "tmp"))
    assert said["status"] == "failed" and "outside the folder" in said["reason"]


def test_emphasis_in_the_output_is_formatting():
    code = 'import sqlite3\nprint(sqlite3.connect("f").execute("select body from r where id=605").fetchone()[0])'
    r = check_mark(mark('"one token away from an approval"'), computed("It is **one token away from an approval**."), [call(code, "It is **one token away from an approval**.")], "/data")
    assert r["status"] == "verified"


def test_a_value_printed_as_is_or_assigned_alone_is_typed_a_list_of_keys_and_an_argument_are_not():
    for code in ("print(352)", 'print("rows:", 352)', "n = 352\nprint(n)"):
        r = check_mark(mark("352 rows"), computed("352"), [call(code, "352")], "/data")
        assert r["status"] == "failed" and r["failedBy"] == "evidence" and "352 in by hand" in r["reason"], code
    # an index, a slice, a digits argument and a keyword argument stay conditions
    code = 'rows = open("t.csv").read().split("\\n")[:352]\nprint(round(len(rows) / 1, 352), int(x, base=352))'
    assert check_mark(mark("352 rows"), computed("352"), [call(code, "352")], "/data")["status"] == "verified"
    # a list of the keys the code looks up prints them next to computed counts
    keys = 'import json\nfrom collections import Counter\nc = Counter(json.loads(l)["t"] for l in open("t.jsonl"))\nfor v in [175, 60]:\n    print(f"{v} s x{c[v]}")'
    assert check_mark(mark("175 s x3, 60 s x2"), computed("175 s x3\n60 s x2"), [call(keys, "175 s x3\n60 s x2")], "/data")["status"] == "verified"


def test_a_number_in_a_printed_text_is_typed_only_when_the_output_shows_it_nowhere_else():
    code = 'import json\nhits = [l for l in open("t.jsonl") if "timeout" in l]\nprint("n hits:", len(hits))\nprint("all 15 had a timeout:", all(hits))'
    out = "n hits: 15\nall 15 had a timeout: True"
    assert check_mark(mark("15"), computed(out), [call(code, out)], "/data")["status"] == "verified"
    alone = 'print("all 15 had a timeout:", True)'
    assert "15 in by hand" in check_mark(mark("15"), computed("all 15 had a timeout: True"), [call(alone, "all 15 had a timeout: True")], "/data")["reason"]


def test_a_version_or_a_dotted_name_is_no_value_and_a_bound_may_stand_in_printed_words():
    code = 'import collections\nper = collections.Counter()\ns, t = per["site"], sum(per.values())\nprint(f"Claude Sonnet 4.6: {s/t:.0%} to the site")'
    out = "Claude Sonnet 4.6: 44% to the site"
    assert check_mark(mark("Claude Sonnet 4.6: 44% to the site"), computed(out), [call(code, out)], "/data")["status"] == "verified"
    code = 'print(f"{n} point to localhost; {m} to 127.0.0.1")'
    out = "429 point to localhost; 298 to 127.0.0.1"
    assert check_mark(mark("298 to 127.0.0.1"), computed(out), [call(code, out)], "/data")["status"] == "verified"
    out = "models after switch: ['claude-opus-4-8']"
    assert check_mark(mark("retried it on Opus 4.8"), computed(out), [call("print(models)", out)], "/data")["status"] == "verified"
    code = 'under = [a for a in rates if rates[a] < 0.02]\nprint(f"{len(under)} of {len(rates)} agents under 2%")'
    out = "13 of 16 agents under 2%"
    assert check_mark(mark("most agents are under 2%"), computed(out), [call(code, out)], "/data")["status"] == "verified"
    # a value the words state, not a bound or a name, is still typed when only the code's text prints it
    typed = 'print("Median 2.5 hours")'
    assert "2.5 in by hand" in check_mark(mark("Median 2.5 hours"), computed("Median 2.5 hours"), [call(typed, "Median 2.5 hours")], "/data")["reason"]


def test_main_calls_whose_output_the_answer_cites_are_kept_also_for_a_list_of_lines():
    from kernel.evidence import cited_calls
    calls = [call("print(n)", "merged:  12 of 40\nopen: 3", by="main"), call("ls", "a.txt b.txt", by="main"), call("print(1)", "1")]
    items = [{"mark": 1, "kind": "computed", "evidence": {"output": ["merged: 12 of 40", "open"]}}]
    assert [c["output"] for c in cited_calls(items, calls)] == ["merged:  12 of 40\nopen: 3", "1"]
    answer = "```json\n" + json.dumps([computed(["merged: 12 of 40"]) | {"mark": 1}]) + "\n```"
    assert check_all([mark("12 of 40")], answer, calls[:2], "/data")["results"][0]["status"] == "verified"


def test_one_mark_the_validator_cannot_judge_leaves_the_others_judged(monkeypatch):
    import kernel.evidence as E
    code = "print(len(open('t.txt').read()))"
    big = "9" * 400
    answer = "```json\n" + json.dumps([computed("12") | {"mark": 1}, computed("12") | {"mark": 2}]) + "\n```"
    # a number of more digits than a float holds is its digits
    assert [r["status"] for r in check_all([mark(big, 1), mark("12", 2)], answer, [call(code, f"{big} 12")], "/data")["results"]] == ["verified", "verified"]
    real = E.check_mark
    monkeypatch.setattr(E, "check_mark", lambda m, *a: (_ for _ in ()).throw(ValueError("made up")) if m["n"] == 1 else real(m, *a))
    out = E.check_all([mark(big, 1), mark("12", 2)], answer, [call(code, f"{big} 12")], "/data")["results"]
    assert [r["status"] for r in out] == ["unchecked", "verified"] and "made up" in out[0]["reason"]


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


def test_a_path_from_the_start_folder_holds_after_main_moved_the_shell(tmp_path: Path):
    (tmp_path / "plugin" / "draw").mkdir(parents=True)
    (tmp_path / "plugin" / "draw" / "box.mjs").write_text("const a = 1\nexport function box() {}\n")
    # main ran `cd plugin/draw`; the check named the file from the folder the session started in
    r = check_mark(mark("box"), quote("plugin/draw/box.mjs", 2, "export function box()", kind="code"), [], str(tmp_path / "plugin" / "draw"), str(tmp_path))
    assert r["status"] == "verified" and r["evidence"]["file"] == "plugin/draw/box.mjs"
    gone = check_mark(mark("box"), quote("plugin/draw/nobox.mjs", 2, "box", kind="code"), [], str(tmp_path / "plugin" / "draw"), str(tmp_path))
    assert "there is no file plugin/draw/nobox.mjs" in gone["reason"]


def test_a_quote_inside_a_quote_may_use_the_other_quote_mark(tmp_path: Path):
    (tmp_path / "REPORT.md").write_text('It says "From my phone and computer" implies one shared source of truth.\n')
    words = "\"'From my phone and computer' implies one shared source of tru…\""
    r = check_mark(mark(words), quote("REPORT.md", 1, "'From my phone and computer' implies one shared"), [], str(tmp_path))
    assert r["status"] == "verified" and r["evidence"]["lines"][0]["highlight"] == [8, 55]
    # a correction that changes only the quote marks leaves the words verified
    styled = '""From my phone and computer" implies one shared source of tru…"'
    item = {"kind": "quote", "status": "corrected", "evidence": {"file": "REPORT.md", "line": 1, "substring": "From my phone"},
            "correction": {"words": styled}, "reason": "inner quotes"}
    r = check_mark(mark(words), item, [], str(tmp_path))
    assert r["status"] == "verified" and r["shown"] == words


def test_a_call_is_found_by_lines_of_its_output_the_others_left_out_and_a_percent_may_show_as_a_share():
    out = "step  legal\n500   0.59718\n1000  0.71\n3500  0.93062\n"
    r = check_mark(mark("59.7%"), computed("500   0.59718\n3500  0.93062"), [call(CODE, out, by="main")], "/data")
    assert r["status"] == "verified" and r["evidence"]["highlight"] == [[18, 25]]
    assert check_mark(mark("59.8%"), computed("500   0.59718"), [call(CODE, out)], "/data")["status"] == "failed"
    # words with nothing to compare are the check's reading of the output it cites ("one" as 1 is highlighted)
    r = check_mark(mark("one first-class girl"), computed("1 female"), [call(CODE, "class 1 female 1")], "/data")
    assert r["status"] == "verified" and r["evidence"]["highlight"] == [[6, 7]]
    r = check_mark(mark("passed when run alone"), computed("pr/110 | run alone | passed"), [call(CODE, "pr/110 | run alone | passed")], "/data")
    assert r["status"] == "verified"
    # its numbers, days, quoted words and record names still must show
    assert check_mark(mark('agent-09 said "run it alone"'), computed("pr/110 | run alone"), [call(CODE, "agent-09: pr/110 | run alone")], "/data")["status"] == "failed"
    assert check_mark(mark("agent-09 passed when run alone"), computed("pr/110 | run alone"), [call(CODE, "agent-10: pr/110 | run alone")], "/data")["status"] == "failed"
    # number words count in the output too
    r = check_mark(mark("5 in the first two hours"), computed("first two hours: 5"), [call(CODE, "first two hours: 5")], "/data")
    assert r["status"] == "verified"


def test_a_path_named_from_the_folder_a_call_moved_to_holds(tmp_path: Path):
    (tmp_path / "toy").mkdir()
    (tmp_path / "toy" / "board.jsonl").write_text('{"by": "agent-07", "text": "yes, that was me"}\n')
    moved = {"command": "cd toy && python3 - <<'PY'\nprint(1)\nPY", "output": "1", "by": "checker"}
    item = quote("board.jsonl", 1, "yes, that was me")
    assert check_mark(mark('"yes, that was me"'), item, [moved], str(tmp_path))["status"] == "verified"
    assert "there is no file" in check_mark(mark('"yes, that was me"'), item, [], str(tmp_path))["reason"]


def test_a_number_name_shows_as_its_number():
    out = "merged reverts: [(135, 'Revert #118', 'agent-11')]"
    assert check_mark(mark("#135"), computed("merged reverts"), [call(CODE, out)], "/data")["status"] == "verified"
    assert check_mark(mark("#136"), computed("merged reverts"), [call(CODE, out)], "/data")["status"] == "failed"


def test_a_dict_that_names_numbers_in_words_is_a_lookup_not_a_typed_value():
    code = 'n = len(open("t.txt").read().split())\nwords = {10: "ten", 9: "nine"}\nprint(f"asked {words.get(n, n)} times")'
    assert check_mark(mark("ten"), computed("asked ten times"), [call(code, "asked ten times")], "/data")["status"] == "verified"


def test_a_quote_of_what_code_prints_fills_the_templates_fields(tmp_path: Path):
    (tmp_path / "progress.mjs").write_text("const main = `${n(p.done)} of ${n(p.of)} records`\nreturn `${main} · ${n(p.failed)} calls failed`\n")
    r = check_mark(mark('"120 of 412 records · 3 calls failed"'), quote("progress.mjs", "1-2", "records", kind="code"), [], str(tmp_path))
    assert r["status"] == "verified"
    (tmp_path / "why.js").write_text("const AGAIN = 'Sign in again with /login'\nif (s === 401) return `the sign-in failed or expired. ${AGAIN}`\n")
    ev = [{"file": "why.js", "line": 2, "substring": "the sign-in failed or expired."}, {"file": "why.js", "line": 1, "substring": "Sign in again with /login"}]
    item = {"kind": "code", "status": "verified", "evidence": ev, "reason": "joined"}
    assert check_mark(mark('"the sign-in failed or expired. Sign in again with /login"'), item, [], str(tmp_path))["status"] == "verified"
    # words the code does not hold are no quote of it
    r = check_mark(mark('"120 of 412 rows · 3 calls failed"'), quote("progress.mjs", "1-2", "records", kind="code"), [], str(tmp_path))
    assert r["status"] == "failed" and "quoted words" in r["reason"]


def test_a_quote_over_more_lines_than_cited_widens_to_them(tmp_path: Path):
    (tmp_path / "report.md").write_text("intro\nAgreement numbers may be\ninflated relative to human gold,\nshared blind spots.\nend\n")
    r = check_mark(mark('"Agreement numbers may be inflated relative to human gold, shared blind spots."'),
                   quote("report.md", "3-4", "Agreement numbers may be inflated relative to human gold, shared blind spots."), [], str(tmp_path))
    assert r["status"] == "verified" and r["evidence"]["line"] == "2-4"


def test_a_digit_inside_a_name_is_no_number_and_a_decimal_keeps_its_places():
    from kernel.evidence import has_number, shows
    assert not shows("the median was 2.0 min", "sweep2-fable: median 9.9 min")
    assert not has_number("3", "run sweep3 had 9") and not has_number("3", "run_3 had 9")
    # a time after the T of a date is still a time
    assert has_number("14", "2026-08-30T14:29:00Z")
    # 3.0 says one place: 3.1 is not 3.0, and 1 is the same value as 1.0
    assert not shows("17 → 3.0 min", "median 16.9 min, then 3.1 min") and shows("1.0", "p = 1")


def test_record_names_compare_in_either_case_and_cited_lines_in_any_order():
    out = "opus-5: 71.5\nsonnet-5: 20.8\nfable-5: 23.2"
    assert check_mark(mark("Opus-5 is slowest"), computed("opus-5: 71.5"), [call(CODE, out)], "/data")["status"] == "verified"
    assert check_mark(mark("20.8 and 71.5"), computed("sonnet-5: 20.8\nopus-5: 71.5"), [call(CODE, out)], "/data")["status"] == "verified"


def test_the_words_stand_in_the_lines_the_check_copied():
    # a 3 of another row does not show the words' 3.0
    out = "a: median 3.1 min, n=315\nb: median 38.0 min, n=3"
    r = check_mark(mark("3.0 min"), computed("a: median 3.1 min"), [call(CODE, out)], "/data")
    assert r["status"] == "failed" and "does not show" in r["reason"]


def test_a_year_that_opens_a_line_is_its_subject_not_a_label():
    out = "2025: 1–4%\n2026: 3–12% (min 2.9, max 12.4)"
    assert check_mark(mark("3–12% in every month of 2026"), computed("2026: 3–12%"), [call(CODE, out)], "/data")["status"] == "verified"


def test_about_rounds_each_number_it_stands_before_and_these_two_counts_nothing():
    out = "Gmail 4,087 times and every other mail client 114 times"
    assert check_mark(mark("Gmail about 4,000 times and every other mail client about 100 times"), computed(out), [call(CODE, out)], "/data")["status"] == "verified"
    out = "A removed B's text in 82 saves; B removed A's in 82"
    assert check_mark(mark("These two removed each other's text 82 times each"), computed(out), [call(CODE, out)], "/data")["status"] == "verified"


def test_a_condition_the_code_tests_in_another_form_may_stand_in_its_printed_words():
    days = 'import json\nfirst = json.load(open("first.json"))\nn = sum("2026-06-16" <= d <= "2026-06-17" for d in first.values())\nprint(f"{n} accounts started between 16 and 17 June")'
    out = "6 accounts started between 16 and 17 June"
    assert check_mark(mark("Six accounts started between 16 and 17 June"), computed(out), [call(days, out)], "/data")["status"] == "verified"
    said = 'import json\nrs = [json.loads(l) for l in open("r.jsonl")]\nok = sum(r["result"].startswith(("Wrapping up", "Shift complete")) for r in rs)\nprint(f"{ok} sessions ended with a \\"Wrapping up\\" or \\"Shift complete\\" summary")'
    out = '12 sessions ended with a "Wrapping up" or "Shift complete" summary'
    assert check_mark(mark('ended with a "Wrapping up" or "Shift complete" summary'), computed(out), [call(said, out)], "/data")["status"] == "verified"
    # a number the code holds nowhere but in the printed text is still typed
    typed = 'import json\nfirst = json.load(open("first.json"))\nprint(f"{len(first)} accounts started between 16 and 17 June")'
    assert "16" in check_mark(mark("6 accounts started between 16 and 17 June"), computed(out := "6 accounts started between 16 and 17 June"), [call(typed, out)], "/data")["reason"]


def test_when_no_call_printed_the_cited_output_the_pane_shows_what_the_check_ran():
    r = check_mark(mark("72 min"), computed("opus: 72"), [call(CODE, "opus: 71.5")], "/data")
    assert r["status"] == "failed" and r["evidence"]["output"] == "opus: 71.5"


def test_text_printed_with_repr_shows_its_line_breaks_as_line_breaks():
    code = 'import json\nr = json.loads(open("reports.jsonl").readline())\nprint(repr(r["body"][:60]))'
    out = "'shift report addendum\\n\\nSince my earlier report:\\n- MERGED #62992'"
    r = check_mark(mark('"shift report addendum Since my earlier report: - MERGED #62992 …"'), computed(out), [call(code, out)], "/data")
    assert r["status"] == "verified"
    # the reply may quote the text with its escapes, as repr() printed it
    r = check_mark(mark('"shift report addendum\\n\\nSince my earlier report:"'), computed(out), [call(code, out)], "/data")
    assert r["status"] == "verified"


def test_a_quote_of_python_text_may_join_string_literals_that_stand_next_to_each_other(tmp_path: Path):
    (tmp_path / "nudge.py").write_text('NUDGE = ("Wrap-up: submit the final report "\n    "with `forge report submit`.")\n')
    words = '"Wrap-up: submit the final report with `forge report submit`."'
    r = check_mark(mark(words), quote("nudge.py", "1-2", '"Wrap-up: submit the final report "'), [], str(tmp_path))
    assert r["status"] == "verified"


def test_the_check_may_give_the_output_lines_as_a_list():
    out = "run a: 1.16 h, merged 14\nrun b: 1.04 h, merged 7\n"
    item = {**computed(), "evidence": {"output": ["run a: 1.16 h, merged 14", "run b: 1.04 h, merged 7"]}}
    assert check_mark(mark("14"), item, [call(CODE, out)], "/data")["status"] == "verified"


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


def test_a_card_s_printed_line_is_evidence_and_a_printed_table_reads_as_a_table():
    r = check_mark(mark("12"), card("card:k3f9a1@out1#L3"), [], "/data", cards=CARDS)
    assert r["status"] == "verified"
    t = r["evidence"]["table"]
    assert t["cols"] == ["merged", "total"] and t["rows"][t["at"]["r"]]["label"] == "agent-07" and t["cols"][t["at"]["c"]] == "merged"


def test_computed_output_that_is_a_printed_dataframe_carries_its_table():
    out = "            merged  total\nagent                  \nagent-03         4     10\nagent-07        12     40\n"
    r = check_mark(mark("12"), computed("agent-07        12     40"), [call(CODE, out)], "/data")
    assert r["status"] == "verified"
    t = r["evidence"]["table"]
    assert t["corner"] == "agent" and t["rows"][t["at"]["r"]] == {"label": "agent-07", "values": ["12", "40"]} and t["at"]["c"] == 0
    # lines of a name and a value are no table
    assert "table" not in check_mark(mark("12"), computed("merged: 12"), [call(CODE, "merged: 12\ntotal:  40\n")], "/data")["evidence"]


def test_the_checker_s_index_lists_each_place_with_its_value_and_the_terminal_s_cards_read_from_their_folder(tmp_path):
    from kernel.evidence import card_index, terminal_cards

    index = card_index(CARDS)
    assert "# card:k3f9a1 Merged pull requests by agent\n" in index and "card:k3f9a1#merged/agent-07\t12\n" in index
    assert "card:k3f9a1@out1#L3\tagent-07 12 40\n" in index
    d = tmp_path / "cards" / "cab12cd34"
    (d / "v2").mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps({"id": "cab12cd34", "title": "Runs by day", "version": 2}))
    (d / "v2" / "rows.json").write_text(json.dumps([{"day": "06-23", "runs": 7}, {"day": "06-24", "runs": 9}]))
    cards = terminal_cards(str(tmp_path / "cards"))
    assert cards[0]["title"] == "Runs by day" and ["runs", "06-24", "9"] in cards[0]["outputs"][0]["cells"]
    r = check_mark(mark("9 runs"), card("card:cab12cd34#runs/06-24"), [], "/data", cards=cards)
    assert r["status"] == "verified"
    # the validator writes the index for the checker, and reads the folder's cards for a check
    out = tmp_path / "index.tsv"
    ran = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps({"index": str(out), "cards_dir": str(tmp_path / "cards")}), capture_output=True, text=True, check=True)
    assert json.loads(ran.stdout) == {"cards": 1} and "card:cab12cd34#runs/06-24\t9" in out.read_text()
    answer = "```json\n" + json.dumps([{"mark": 1, **card("card:cab12cd34#runs/06-24")}]) + "\n```"
    ran = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps({"marks": [{"n": 1, "words": "9"}], "answer": answer, "calls": [], "cwd": "/data", "cards_dir": str(tmp_path / "cards")}), capture_output=True, text=True, check=True)
    assert json.loads(ran.stdout)["results"][0]["status"] == "verified"
