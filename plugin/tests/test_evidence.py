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


def computed(code: str = CODE, status: str = "verified", correction: dict | None = None) -> dict:
    return {"kind": "computed", "status": status, "evidence": {"code": code, "output": "whatever the checker wrote"}, "correction": correction, "reason": "counted"}


def quote(file: str, line, sub: str, kind: str = "quote") -> dict:
    return {"kind": kind, "status": "verified", "evidence": {"file": file, "line": line, "substring": sub}, "reason": "the record says so"}


def mark(words: str, n: int = 1) -> dict:
    return {"n": n, "words": words}


def test_computed_needs_a_real_call_that_ran_the_code_and_shows_the_words():
    ok = check_mark(mark("12 of 40"), computed(), [call(CODE, "12 of 40\n")], "/data")
    assert ok["status"] == "verified" and ok["evidence"]["output"] == "12 of 40\n" and ok["evidence"]["highlight"] == [[0, 8]]
    # the checker's own output line does not count: only the call's real output
    assert check_mark(mark("12 of 40"), computed(), [call(CODE, "11 of 40\n")], "/data")["status"] == "failed"
    # no call ran this code
    gone = check_mark(mark("12 of 40"), computed(), [call("print('other')", "12 of 40")], "/data")
    assert gone["status"] == "failed" and "no command" in gone["reason"]


def test_main_calls_count_and_white_space_is_loose():
    spaced = CODE.replace("prs = [", "prs   =  [")
    r = check_mark(mark("12 of 40"), computed(), [call(spaced, "12 of 40", by="main")], "/data")
    assert r["status"] == "verified" and r["evidence"]["by"] == "main"


def test_a_number_inside_a_longer_number_does_not_show_it():
    r = check_mark(mark("12 of 40"), computed(), [call(CODE, "112 of 400")], "/data")
    assert r["status"] == "failed"


def test_number_words_read_as_digits():
    r = check_mark(mark("three times"), computed(), [call(CODE, "3 times")], "/data")
    assert r["status"] == "verified"


def test_a_typed_in_value_is_no_evidence_but_a_bound_is_a_condition():
    typed = 'n = 15\nprint(f"{n} of 40")'
    assert "by hand" in check_mark(mark("15 of 40"), computed(typed), [call(typed, "15 of 40")], "/data")["reason"]
    bound = 'import json\nrows = [json.loads(l) for l in open("p.jsonl")]\nprint(sum(1 for r in rows if r["age"] < 13))'
    assert check_mark(mark("13 children"), computed(bound), [call(bound, "13")], "/data")["status"] == "verified"


def test_a_correction_is_checked_on_its_new_words():
    corr = {"words": "12 of 40", "was": "15 of 40"}
    r = check_mark(mark("15 of 40"), computed(status="corrected", correction=corr), [call(CODE, "12 of 40")], "/data")
    assert (r["status"], r["shown"], r["was"]) == ("corrected", "12 of 40", "15 of 40")
    bad = check_mark(mark("15 of 40"), computed(status="corrected", correction={"words": "13 of 40"}), [call(CODE, "12 of 40")], "/data")
    assert bad["status"] == "failed" and bad["shown"] == "15 of 40"


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
    out = check_all([mark("a", 1), mark("b", 2)], '```json\n[{"mark": 1, "status": "failed", "reason": "no record says so"}]\n```', [], "/data")
    assert out["parsed"] is True
    assert [(r["status"], r["reason"]) for r in out["results"]] == [("failed", "no record says so"), ("unchecked", "the check gave no answer for this mark")]
    assert check_all([mark("a")], "I could not check it.", [], "/data")["parsed"] is False


def test_validate_entry_reads_json_on_stdin(tmp_path: Path):
    req = {"cwd": str(tmp_path), "marks": [mark("12 of 40")], "answer": "```json\n" + json.dumps([{"mark": 1, **computed()}]) + "\n```", "calls": [call(CODE, "12 of 40")]}
    r = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps(req), capture_output=True, text=True, check=True)
    assert json.loads(r.stdout)["results"][0]["status"] == "verified"


def test_code_that_leaves_out_lines_of_the_script_that_ran_counts_and_the_pane_shows_the_whole_script():
    script = 'import json\nrows = [json.loads(l) for l in open("p.jsonl")]\nprint(f"9: {len(rows)} rows")\nprint(f"10: {sum(r[\'ok\'] for r in rows)} passed")'
    excerpt = 'import json\nrows = [json.loads(l) for l in open("p.jsonl")]\nprint(f"10: {sum(r[\'ok\'] for r in rows)} passed")'
    r = check_mark(mark("279 passed"), computed(excerpt), [call(script, "9: 280 rows\n10: 279 passed\n")], "/data")
    assert r["status"] == "verified" and r["evidence"]["code"] == script
    # a line that computes something else matches no call
    changed = excerpt.replace("r['ok']", "r['fail']")
    assert "no command" in check_mark(mark("279 passed"), computed(changed), [call(script, "10: 279 passed")], "/data")["reason"]


def test_a_label_that_opens_an_output_line_shows_no_value():
    code = 'k = len(open("a.txt").read().split())\nprint(f"3: {k} times")'
    assert check_mark(mark("3 times"), computed(code), [call(code, "3: 2 times")], "/data")["status"] == "failed"
    assert check_mark(mark("2 times", 3), computed(code), [call(code, "3: 2 times")], "/data")["status"] == "verified"


def test_a_record_id_and_a_compared_value_are_conditions_not_typed_values():
    code = 'import sqlite3\nc = sqlite3.connect("f.db")\nprint(c.execute("select at from claims where pr = 118").fetchone()[0])'
    assert check_mark(mark("claimed #118 at 14:28"), computed(code), [call(code, "14:28")], "/data")["status"] == "verified"
    code2 = 'import csv\nrows = list(csv.DictReader(open("t.csv")))\nprint(sum(1 for r in rows if r["Pclass"] in ("1", "2") and r["g"] == "teen 13-17"))'
    assert check_mark(mark("2 of them"), computed(code2), [call(code2, "2")], "/data")["status"] == "verified"


def test_a_condition_the_code_uses_may_stand_in_its_printed_words():
    code = 'import csv\nrows = list(csv.DictReader(open("t.csv")))\nkids = [r for r in rows if r["Age"] and float(r["Age"]) < 12]\nprint(f"{sum(r[\'Survived\'] == \'1\' for r in kids)} children under 12 survived")'
    assert check_mark(mark("39 children under 12 survived"), computed(code), [call(code, "39 children under 12 survived")], "/data")["status"] == "verified"


def test_a_copied_line_whose_label_words_differ_still_names_the_call_but_other_code_does_not():
    script = 'import json\nrows = [json.loads(l) for l in open("t.jsonl")]\nhit = [r for r in rows if r["ok"]]\nprint(f"{len(hit)} of the {len(rows)}")'
    assert check_mark(mark("4 of the 703"), computed('print(f"{len(hit)} of {len(rows)}")'), [call(script, "4 of the 703")], "/data")["status"] == "verified"
    assert "no command" in check_mark(mark("4 of the 703"), computed('print(f"{len(rows)} of {len(hit)}")'), [call(script, "4 of the 703")], "/data")["reason"]


def test_a_number_in_a_name_is_no_value_the_line_must_show(tmp_path: Path):
    (tmp_path / "log.jsonl").write_text(json.dumps({"at": "2026-08-30T14:29:00Z", "text": "ran the full suite"}) + "\n")
    r = check_mark(mark("agent-11 at 14:29"), quote("log.jsonl", 1, "14:29"), [], str(tmp_path))
    assert r["status"] == "verified"


def test_json_quoted_with_spaces_and_a_list_of_quoted_values(tmp_path: Path):
    (tmp_path / "p.jsonl").write_text('{"record_id":"pkg:1.0.1:a.yaml","kind":"added"}\n')
    r = check_mark(mark('"pkg:1.0.1:a.yaml"'), quote("p.jsonl", 1, '"record_id": "pkg:1.0.1:a.yaml"'), [], str(tmp_path))
    assert r["status"] == "verified"
    code = 'import json\nkinds = sorted({e["kind"] for l in open("p.jsonl") for e in [json.loads(l)]})\nprint("kinds:", kinds)'
    assert check_mark(mark('"added", "context" or "removed"'), computed(code), [call(code, "kinds: ['added', 'context', 'removed']")], "/data")["status"] == "verified"


def test_a_line_number_a_few_lines_off_names_the_line_that_holds_the_words(tmp_path: Path):
    (tmp_path / "cli.py").write_text("".join(f"x{i} = {i}\n" for i in range(1, 20)) + "    return 1\n")
    r = check_mark(mark("exits with code 1"), quote("cli.py", 18, "return 1", kind="code"), [], str(tmp_path))
    assert r["status"] == "verified" and r["evidence"]["line"] == "20"


def test_digit_separators_and_a_scale_are_values():
    (code, out) = ('print(open("labels.py").read().count("x"))', "UNIT_CHARS = 4_000 and 8,225 files")
    assert check_mark(mark("4,000 characters"), computed(code), [call(code, out)], "/data")["status"] == "verified"
    assert check_mark(mark("8k files"), computed(code), [call(code, out)], "/data")["status"] == "verified"
    # 12k is no number of an output that holds 12 only inside a date
    assert check_mark(mark("12k files"), computed(code), [call(code, "as of 2026-10-12: 9,870 files")], "/data")["status"] == "failed"


def test_an_ordinal_in_a_label_and_a_date_in_code_are_no_typed_values():
    code = 'import csv\nrows = list(csv.DictReader(open("t.csv")))\ng = [r for r in rows if r["Pclass"] == "3"]\nprint(f"3rd-class women: {sum(r[\'S\'] == \'1\' for r in g)} of {len(g)}")'
    assert check_mark(mark("3 of 26"), computed(code), [call(code, "3rd-class women: 3 of 26")], "/data")["status"] == "verified"
    dates = 'import json\nn = {}\nfor l in open("chat.jsonl"):\n    m = json.loads(l)["at"][:7]; n[m] = n.get(m, 0) + 1\nprint(f"April 2025: {n.get(\'2025-04\', 0)}", sorted(n))'
    assert check_mark(mark("only in April 2025"), computed(dates), [call(dates, "April 2025: 7 ['2025-04']")], "/data")["status"] == "verified"


def test_words_with_no_number_are_shown_by_their_record_names():
    code = 'import json\nprint(", ".join(f"#{p[\'n\']}" for l in open("prs.jsonl") for p in [json.loads(l)] if p["merged_by"] == "agent-02"))'
    assert check_mark(mark("merged #102, #125 and #130"), computed(code), [call(code, "#102, #125, #130")], "/data")["status"] == "verified"
    assert check_mark(mark("merged #102, #125 and #131"), computed(code), [call(code, "#102, #125, #130")], "/data")["status"] == "failed"


def test_a_correction_to_a_finer_value_leaves_the_marked_words_verified():
    corr = {"words": "06:39:10", "was": "06:39"}
    r = check_mark(mark("06:39"), computed(status="corrected", correction=corr), [call(CODE, "last event 06:39")], "/data")
    assert (r["status"], r["shown"]) == ("verified", "06:39") and "was" not in r


def test_a_failed_mark_keeps_the_real_evidence_the_check_gave():
    item = {**computed(), "status": "failed", "reason": "the sentence says June 18, the deletions began on June 20"}
    r = check_mark(mark("602"), item, [call(CODE, "602 deletions, first on 2026-06-20")], "/data")
    assert r["status"] == "failed" and r["failedBy"] == "check" and r["evidence"]["output"].startswith("602")


def test_an_answer_that_quotes_a_fence_still_parses():
    answer = 'Done.\n```json\n[{"mark": 1, "kind": "code", "status": "failed", "evidence": {"substring": "re.compile(r\'```(?:json)?\')"}, "reason": "no"}]\n```'
    out = check_all([mark("a")], answer, [], "/data")
    assert out["parsed"] is True and out["results"][0]["status"] == "failed"


def test_a_quote_comes_from_the_records_its_numbers_with_it():
    read = 'import sqlite3\nc = sqlite3.connect("file:f.db?immutable=1", uri=True)\nprint(c.execute("select body from reports").fetchone()[0])'
    out = "Reviewed and merged 6 PRs: #107 (fix) #108 (docs)"
    assert check_mark(mark('"Reviewed and merged 6 PRs: #107 … #108"'), computed(read), [call(read, out)], "/data")["status"] == "verified"
    typed = 'print("Reviewed and merged 6 PRs: #107 and #108")'
    r = check_mark(mark('"Reviewed and merged 6 PRs: #107 … #108"'), computed(typed), [call(typed, out)], "/data")
    assert r["status"] == "failed" and "quoted words" in r["reason"]
    found = read.replace('print(c.execute("select body from reports").fetchone()[0])', 'body = c.execute("select body from reports").fetchone()[0]\nif "merged 6 PRs: #107" in body: print("merged 6 PRs: #107")')
    assert check_mark(mark('"merged 6 PRs: #107"'), computed(found), [call(found, "merged 6 PRs: #107")], "/data")["status"] == "verified"


def test_a_path_shows_from_the_folder_the_session_started_in(tmp_path: Path):
    (tmp_path / "plugin" / "engine").mkdir(parents=True)
    (tmp_path / "plugin" / "engine" / "labels.py").write_text("UNIT_CHARS = 4_000\n")
    # the shell had moved into plugin/, so the checker named the file from there
    r = check_mark(mark("4,000 characters"), quote("engine/labels.py", 1, "UNIT_CHARS = 4_000", kind="code"), [], str(tmp_path / "plugin"), str(tmp_path))
    assert r["status"] == "verified" and r["evidence"]["file"] == "plugin/engine/labels.py"
