"""What a checked citation rests on (engine/kernel/evidence.py sources, examine; engine/validate.py "cited"), on
made-up files and calls."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
import validate  # noqa: E402
from kernel import evidence  # noqa: E402
from kernel.evidence import check_all, check_mark, examine  # noqa: E402

VALIDATE = Path(__file__).resolve().parents[1] / "engine" / "validate.py"


def plain_runner(runs: list | None = None):
    """A runner with no sandbox, for the logic alone: the script run by this Python with the validator's prelude, which
    notes the files it opens to read (validate.py sandboxed runs the same in thimble's sandbox). Each run's script goes
    to `runs`."""
    def run(script: str, folder: str, python: str = "python3", flags=(), argv=("-",)) -> dict:
        if runs is not None:
            runs.append(script)
        p = subprocess.run([sys.executable, "-B", *flags, "-c", validate.PRELUDE, *argv[1:]], input=script, capture_output=True,
                           text=True, cwd=folder, env={**os.environ, "THIMBLE_READS": "made-up-mark", "THIMBLE_ARGV0": argv[0]})
        errors, _, read = p.stderr.rpartition("\nmade-up-mark\n")
        return {"output": p.stdout + errors, "reads": read.splitlines(), "ok": p.returncode == 0}
    return run


# a build's review results, read through a path the code builds, as code that walks the builds does
REVIEW = {"fixed": [{"title": "Streak resets at midnight", "severity": "major"}, {"title": "Toast hides undo", "severity": "minor"},
                    {"title": "Dark theme contrast", "severity": "minor"}]}
SEVERITIES = """import json, os
from collections import Counter
for build in sorted(os.listdir(".")):
    path = os.path.join(build, "report", "review-results.json")
    if os.path.exists(path):
        c = Counter(f["severity"] for f in json.load(open(path))["fixed"])
        print(f"{build}: {c['major']} major, {c['minor']} minor of {sum(c.values())}")"""


def builds(tmp_path: Path) -> tuple[Path, Path]:
    """A folder of two builds, one with review results: (the folder, that file)."""
    data = tmp_path / "data"
    (data / "build-a" / "report").mkdir(parents=True)
    (data / "build-b").mkdir()
    (data / "build-b" / "notes.md").write_text("no review\n")
    review = data / "build-a" / "report" / "review-results.json"
    review.write_text(json.dumps(REVIEW, indent=1))
    return data, review


def severity_call(data: Path, run) -> dict:
    return {"command": f"cd {data} && python3 - <<'PY'\n{SEVERITIES}\nPY", "output": run(SEVERITIES, str(data))["output"], "by": "checker"}


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


def test_computed_evidence_rests_on_the_files_its_code_read_through_a_path_it_builds(tmp_path: Path):
    data, review = builds(tmp_path)
    run = plain_runner()
    item = {"kind": "computed", "status": "verified", "evidence": {"output": "build-a: 1 major, 2 minor of 3"}, "reason": "counted"}
    r = check_mark({"n": 1, "words": "1 major"}, item, [severity_call(data, run)], str(data), str(data), run=run)
    assert r["status"] == "verified"
    # the file it opened, whose path no string of the code names; not the folders it listed, nor a file it never opened
    assert [s["file"] for s in r["sources"]] == ["build-a/report/review-results.json"]
    assert r["sources"][0]["path"] == str(review.resolve())
    # what runs it again: its command, its folders and the output the check gave
    assert r["rerun"]["given"] == "build-a: 1 major, 2 minor of 3" and r["rerun"]["cwd"] == str(data)
    # with no runner it rests on the files its code names, none here, and nothing runs it again
    bare = check_mark({"n": 1, "words": "1 major"}, item, [severity_call(data, run)], str(data), str(data))
    assert "sources" not in bare and "rerun" not in bare


def test_a_computed_citation_whose_file_changed_holds_when_its_code_prints_the_same_and_is_stale_when_not(tmp_path: Path):
    data, review = builds(tmp_path)
    runs: list = []
    run = plain_runner(runs)
    item = {"kind": "computed", "status": "verified", "evidence": {"output": "build-a: 1 major, 2 minor of 3"}, "reason": "counted"}
    r = check_mark({"n": 1, "words": "1 major"}, item, [severity_call(data, run)], str(data), str(data), run=run)
    # an edit that leaves the counts as they were: the code runs again, prints the same, and the citation holds, resting
    # on the file as it is now
    touched(review, review.read_text().replace("Toast hides undo", "The toast hides undo"))
    runs.clear()
    [held] = examine([{"sources": r["sources"], "rerun": r["rerun"]}], run)
    assert len(runs) == 1
    assert "changed" not in held["sources"][0]
    [now_src] = held["rests"]
    assert now_src["file"] == "build-a/report/review-results.json" and now_src["sha256"] != r["sources"][0]["sha256"]
    assert now_src["size"] == review.stat().st_size
    # an edit that changes a count: the code prints otherwise, and the citation is stale
    touched(review, review.read_text().replace('"major"', '"minor"'))
    [stale] = examine([{"sources": held["rests"], "rerun": r["rerun"]}], run)
    assert stale["sources"][0]["changed"] is True and "rests" not in stale
    # with no runner, or one that cannot run it, a change is a change
    touched(review, review.read_text().replace("Dark theme", "The dark theme"))
    assert examine([{"sources": held["rests"], "rerun": r["rerun"]}])[0]["sources"][0]["changed"] is True
    assert examine([{"sources": held["rests"], "rerun": r["rerun"]}], lambda *a: None)[0]["sources"][0]["changed"] is True



def test_a_file_the_code_reads_by_its_arguments_is_a_source_and_its_run_again_takes_them(tmp_path: Path):
    data, review = builds(tmp_path)
    run = plain_runner()
    code = "\nimport json, sys, collections\nc = collections.Counter(f['severity'] for f in json.load(open(sys.argv[1]))['fixed'])\nprint('major:', c['major'])\n"
    command = f'cd {data} && python3 -I -c "{code}" build-a/report/review-results.json'
    out = run(code, str(data), "python3", ("-I",), ("-c", "build-a/report/review-results.json"))
    assert out["output"] == "major: 1\n" and out["ok"]
    item = {"kind": "computed", "status": "verified", "evidence": {"output": "major: 1"}, "reason": "counted"}
    r = check_mark({"n": 1, "words": "1"}, item, [{"command": command, "output": out["output"], "by": "main"}], str(data), str(data), run=run)
    # the file it opened by sys.argv[1], which no string of its code names
    assert [s["file"] for s in r["sources"]] == ["build-a/report/review-results.json"] and r["rerun"]
    touched(review, review.read_text().replace('"major"', '"minor"'))
    [got] = examine([{"sources": r["sources"], "rerun": r["rerun"]}], run)
    assert got["sources"][0]["changed"] is True and "rests" not in got

def test_one_run_of_a_code_serves_every_citation_that_rests_on_it_at_the_check_and_after(tmp_path: Path):
    data, review = builds(tmp_path)
    runs: list = []
    run = plain_runner(runs)
    call = severity_call(data, run)
    runs.clear()
    marks = [{"n": 1, "words": "1 major", "sentence": "Build-a has [1 major](#) finding."},
             {"n": 2, "words": "2 minor", "sentence": "It has [2 minor](#) ones."}]
    answer = "```json\n" + json.dumps([{"mark": n, "kind": "computed", "status": "verified", "evidence": {"output": "build-a: 1 major, 2 minor of 3"},
                                        "reason": "counted"} for n in (1, 2)]) + "\n```"
    out = check_all(marks, answer, [call], str(data), str(data), run=run)
    assert [r["status"] for r in out["results"]] == ["verified", "verified"] and len(runs) == 1
    a, b = out["results"]
    touched(review, review.read_text().replace("Dark theme", "The dark theme"))
    runs.clear()
    got = examine([{"sources": a["sources"], "rerun": a["rerun"]}, {"sources": b["sources"], "rerun": b["rerun"]}], run)
    assert len(runs) == 1 and all("rests" in g for g in got)


def srt_installed() -> bool:
    home = Path(os.environ.get("THIMBLE_HOME") or Path.home() / ".thimble")
    pin = json.loads((VALIDATE.parent.parent / "sandbox" / "package.json").read_text())["dependencies"]["@anthropic-ai/sandbox-runtime"]
    return (home / "srt" / pin / "node_modules").is_dir()


@pytest.mark.skipif(sys.platform != "linux" or not srt_installed(), reason="thimble's sandbox is not installed here")
def test_the_validator_runs_the_code_again_in_thimbles_sandbox_at_the_check_and_when_its_file_changed(tmp_path: Path):
    data, review = builds(tmp_path)
    call = severity_call(data, plain_runner())
    answer = "```json\n" + json.dumps([{"mark": 1, "kind": "computed", "status": "verified", "evidence": {"output": "build-a: 1 major, 2 minor of 3"},
                                        "reason": "counted"}]) + "\n```"
    # the hooks' TMPDIR is the session's temp folder, which the sandbox shows read only
    temp = tmp_path / "session-tmp"
    temp.mkdir()
    env = {**os.environ, "TMPDIR": str(temp)}
    req = {"cwd": str(data), "root": str(data), "tmp": [str(temp)], "answer": answer, "calls": [call],
           "marks": [{"n": 1, "words": "1 major", "sentence": "It has [1 major](#) finding."}]}
    done = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps(req), capture_output=True, text=True, check=True, env=env)
    [r] = json.loads(done.stdout)["results"]
    assert r["status"] == "verified" and [s["file"] for s in r["sources"]] == ["build-a/report/review-results.json"] and r["rerun"]
    touched(review, review.read_text().replace('"major"', '"minor"'))
    cited = {"cited": [{"sources": r["sources"], "rerun": r["rerun"]}], "cwd": str(data), "root": str(data), "tmp": [str(temp)]}
    done = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps(cited), capture_output=True, text=True, check=True, env=env)
    [got] = json.loads(done.stdout)["cited"]
    assert got["sources"][0]["changed"] is True and "rests" not in got
    # its runs wrote nothing in the folder, and left nothing in the temp folder
    assert sorted(p.name for p in data.iterdir()) == ["build-a", "build-b"] and list(temp.iterdir()) == []
