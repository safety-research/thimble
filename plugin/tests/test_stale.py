"""What a checked citation rests on (engine/kernel/evidence.py sources, examine; engine/validate.py "cited"), on
made-up files and calls."""
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from kernel import evidence  # noqa: E402
from kernel.evidence import check_mark, examine  # noqa: E402

VALIDATE = Path(__file__).resolve().parents[1] / "engine" / "validate.py"


def quote(file: str, line, sub: str) -> dict:
    return {"kind": "quote", "status": "verified", "evidence": {"file": file, "line": line, "substring": sub}, "reason": "the file says so"}


def touched(p: Path, text: str) -> None:
    """The file written anew, its mtime a second later, as a later write leaves it."""
    st = p.stat()
    p.write_text(text)
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


def now(src: dict) -> dict:
    """One source as it stands now."""
    return examine([{"sources": [src]}])[0]["sources"][0]


def test_a_quote_rests_on_its_cited_lines_and_turns_stale_only_when_they_change(tmp_path: Path):
    readme = tmp_path / "README.md"
    readme.write_text("# app\nThe backend listens on port 8000.\nRun make dev.\n")
    r = check_mark({"n": 1, "words": "port 8000"}, quote("README.md", 2, "port 8000"), [], str(tmp_path))
    assert r["status"] == "verified"
    [src] = r["sources"]
    assert (src["file"], src["line"], src["path"]) == ("README.md", "2", str(readme.resolve()))
    # what it rests on is not shown as evidence
    assert "sources" not in r["evidence"] and "_path" not in r["evidence"]
    assert now(src) == src
    # another line changed: the cited line reads as the check read it
    touched(readme, "# app, the habit tracker\nThe backend listens on port 8000.\nRun make dev.\n")
    other = now(src)
    assert other == src
    # the cited line changed
    touched(readme, "# app\nThe backend listens on port 9000.\nRun make dev.\n")
    changed = now(other)
    assert changed["changed"] is True
    # the file is gone, then back as the check read it
    text = readme.read_text()
    readme.unlink()
    gone = now(changed)
    assert gone["gone"] is True
    readme.write_text(text.replace("9000", "8000"))
    assert "gone" not in now(gone) and "changed" not in now(gone)


def test_computed_evidence_rests_on_the_files_its_code_names(tmp_path: Path):
    (tmp_path / "prs.jsonl").write_text('{"merged": true}\n{"merged": false}\n')
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "runs.jsonl").write_text("{}\n")
    (tmp_path / "notes.txt").write_text("not read\n")
    code = 'import glob, json\nprs = [json.loads(l) for l in open("prs.jsonl")]\nruns = glob.glob("*/runs.jsonl")\nprint("*" * 3)\nprint(f"{sum(p[\'merged\'] for p in prs)} of {len(prs)}")'
    call = {"command": f"cd {tmp_path} && python3 - <<'PY'\n{code}\nPY", "output": "***\n1 of 2\n", "by": "checker"}
    item = {"kind": "computed", "status": "verified", "evidence": {"output": "1 of 2"}, "reason": "counted"}
    r = check_mark({"n": 1, "words": "1 of 2"}, item, [call], str(tmp_path))
    assert r["status"] == "verified"
    # the files it opens and globs, not every file a printed "*" would match
    assert sorted(s["file"] for s in r["sources"]) == ["a/runs.jsonl", "prs.jsonl"]
    assert all("line" not in s for s in r["sources"])
    prs = next(s for s in r["sources"] if s["file"] == "prs.jsonl")
    touched(tmp_path / "prs.jsonl", '{"merged": true}\n{"merged": true}\n')
    assert now(prs)["changed"] is True
    # a mark the check could not confirm rests on nothing
    wrong = check_mark({"n": 1, "words": "7 of 9"}, item, [call], str(tmp_path))
    assert wrong["status"] == "failed" and "sources" not in wrong


def test_a_check_after_a_change_takes_computed_evidence_only_from_its_own_calls(tmp_path: Path):
    main = {"command": "python3 count.py", "output": "12 of 40\n", "by": "main"}
    item = {"kind": "computed", "status": "verified", "evidence": {"output": "12 of 40"}, "reason": "counted"}
    assert check_mark({"n": 1, "words": "12 of 40"}, item, [main], str(tmp_path))["status"] == "verified"
    again = check_mark({"n": 1, "words": "12 of 40"}, item, [main], str(tmp_path), fresh=True)
    assert again["status"] == "failed" and "sources" not in again


def test_the_validator_answers_each_citation_as_it_stands_now(tmp_path: Path):
    f = tmp_path / "board.md"
    f.write_text("agent-07: yes\n")
    src = check_mark({"n": 1, "words": "yes"}, quote("board.md", 1, "yes"), [], str(tmp_path))["sources"][0]
    touched(f, "agent-07: no\n")
    cited = [{"sources": [src]}, {"sources": [{**src, "path": str(tmp_path / "x")}]}]
    out = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps({"cited": cited}), capture_output=True, text=True, check=True)
    a, b = json.loads(out.stdout)["cited"]
    assert a["sources"][0]["changed"] is True and b["sources"][0]["gone"] is True


def test_cited_lines_that_moved_keep_their_words_at_their_new_numbers(tmp_path: Path):
    readme = tmp_path / "README.md"
    readme.write_text("# app\n## Run\nThe backend listens on port 8000.\nRun make dev.\n")
    r = check_mark({"n": 1, "words": "port 8000"}, quote("README.md", 3, "port 8000"), [], str(tmp_path))
    assert [x["n"] for x in r["evidence"]["lines"]] == [2, 3, 4]
    # a line added at the top moves the cited line, and the lines around it, one down
    touched(readme, "# app\nA habit tracker.\n## Run\nThe backend listens on port 8000.\nRun make dev.\n")
    [got] = examine([{"sources": r["sources"], "evidence": r["evidence"]}])
    [src] = got["sources"]
    assert src["line"] == "4" and "changed" not in src and src["sha256"] == r["sources"][0]["sha256"]
    assert got["evidence"]["line"] == "4"
    assert [(x["n"], x["text"]) for x in got["evidence"]["lines"]] == [(3, "## Run"), (4, "The backend listens on port 8000."), (5, "Run make dev.")]
    assert got["evidence"]["lines"][1]["highlight"] == r["evidence"]["lines"][1]["highlight"]
    # a line added right above it: the line around it that reads otherwise now is left out, never shown as it reads
    touched(readme, "# app\nA habit tracker.\n## Run\nTo start:\nThe backend listens on port 8000.\nRun make dev.\n")
    [again] = examine([got])
    assert again["sources"][0]["line"] == "5"
    assert [x["n"] for x in again["evidence"]["lines"]] == [5, 6]
    # a run of lines moves as one, found by its first line
    two = check_mark({"n": 1, "words": "port 8000"}, quote("README.md", "5-6", "port 8000"), [], str(tmp_path))["sources"][0]
    assert two["line"] == "5-6" and two["head"]
    touched(readme, "# app\n\nA habit tracker.\n## Run\nTo start:\nThe backend listens on port 8000.\nRun make dev.\n")
    assert now(two)["line"] == "6-7" and "changed" not in now(two)


def test_a_log_that_grows_at_each_pass_is_never_hashed_whole_nor_searched(tmp_path: Path, monkeypatch):
    log = tmp_path / "run.log"
    log.write_text("".join(f"step {i}: loss {1 / (i + 1):.3f}\n" for i in range(2000)))
    whole = evidence.source(str(log), "run.log")
    lines = evidence.source(str(log), "run.log", "1999")
    hashed, searched = [], []
    monkeypatch.setattr(evidence, "_file_hash", lambda f: hashed.append(1) or "")
    find = evidence._find_lines
    monkeypatch.setattr(evidence, "_find_lines", lambda f, srcs: searched.append(1) or find(f, srcs))
    for i in range(2000, 2003):
        with log.open("a") as f:
            f.write(f"step {i}: loss {1 / (i + 1):.3f}\n")
        # the file cited whole has another size: changed, with no read; its cited lines stand where they were
        w, s = examine([{"sources": [whole, lines]}])[0]["sources"]
        assert w["changed"] is True and "changed" not in s and s["line"] == "1999"
        whole = w
    assert hashed == [] and searched == []
    # cited lines found changed are searched for once, then read at their numbers only
    touched(log, log.read_text().replace("step 1998: loss", "step 1998: LOSS"))
    gone = now(lines)
    assert gone["changed"] is True and searched == [1]
    with log.open("a") as f:
        f.write("step 2003: loss 0.000\n")
    assert now(gone)["changed"] is True and searched == [1]


def test_one_read_of_a_file_serves_every_source_that_rests_on_it(tmp_path: Path, monkeypatch):
    notes = tmp_path / "notes.md"
    notes.write_text("".join(f"line {i}\n" for i in range(1, 30)))
    srcs = [evidence.source(str(notes), "notes.md", line) for line in ("3", "7-9", "20")] + [evidence.source(str(notes), "notes.md")]
    opened: list[str] = []
    real = os.open
    monkeypatch.setattr(os, "open", lambda p, *a, **k: (opened.append(str(p)), real(p, *a, **k))[1])
    got = examine([{"sources": srcs[:2]}, {"sources": srcs[2:]}])
    assert [s for g in got for s in g["sources"]] == srcs
    assert opened == [str(notes.resolve())]
