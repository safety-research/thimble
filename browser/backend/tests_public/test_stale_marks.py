"""marks.py: a citation whose source changed after its check. A verified mark keeps what its evidence rests on, and the
index of cited files lists the marks that rest on each; when the page reads a chat, the server stats each cited file
and compares only the marks that rest on a file whose stat changed (refresh_sources). Repair checks a stale mark again
against the files as they are now, only its own calls counting as computed evidence, and so each Repair of it until one
of those checks passes; that check takes the other stale marks of its sentence with it. The fork is replaced here; the
marks, the validator and the records are real."""
from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace

import pytest

from app import agents, config, marks, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-0000000000ab"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, data_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    told: list[str] = []
    monkeypatch.setattr(marks, "_tell", lambda c, text: told.append(text))
    monkeypatch.setattr(marks, "_notice", lambda c, text, details=None: told.append("notice: " + text))
    yield told
    session._live.clear()


def _answer(items: list[dict]) -> str:
    return "Checked.\n```json\n" + json.dumps(items) + "\n```"


def _edit(path, text: str) -> None:
    """The file written anew, its mtime a second later, as a later write leaves it."""
    st = path.stat()
    path.write_text(text)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


def _main(monkeypatch, folder) -> None:
    lv = SimpleNamespace(sid=SID, cwd=str(folder), config=None, config_known=False, transcript_path=None, model="",
                         effort="", context_tokens=0, last_cut="cut-1")
    monkeypatch.setattr(session, "current", lambda c: lv if c == CORPUS else None)


def _fresh_calls(monkeypatch) -> list[bool]:
    """Whether each check the validator ran was a fresh one."""
    ev = marks.evidence()
    fresh: list[bool] = []
    check_all = ev.check_all
    monkeypatch.setattr(ev, "check_all", lambda *a, **k: (fresh.append(bool(a[9] if len(a) > 9 else k.get("fresh"))), check_all(*a, **k))[1])
    return fresh


def _check(folder, text: str, fork) -> str:
    turn = marks.new_turn()
    asyncio.run(marks.start_check(CORPUS, {"sid": SID, "cwd": str(folder), "transcript_path": None}, turn, [text], "cut-1", fork=fork))
    return turn


def _repair(turn: str, fork) -> None:
    async def go():
        assert await marks.repair(CORPUS, turn=turn, n=1, fork=fork) == ""
        await asyncio.gather(*(t for t in asyncio.all_tasks() if t is not asyncio.current_task()))

    asyncio.run(go())


def test_a_mark_whose_cited_line_changed_is_stale_and_repair_checks_it_against_the_file_now(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    notes = folder / "notes.md"
    notes.write_text("# app\nRun it on port 8000.\nThe tests use pytest.\n")
    _main(monkeypatch, folder)
    fresh = _fresh_calls(monkeypatch)
    prompts: list[str] = []

    async def fork(c, main, cut, prompt):
        prompts.append(prompt)
        port = "9000" if "9000" in notes.read_text() else "8000"
        out = [{"mark": 1, "kind": "quote", "evidence": {"file": "notes.md", "line": 2, "substring": f"port {port}"},
                "status": "verified" if port == "8000" else "corrected", "correction": None if port == "8000" else {"words": f"port {port}"},
                "reason": "line 2 says so"}]
        return {"answer": _answer(out), "calls": [], "error": None}

    turn = _check(folder, "The app runs on [port 8000](#).", fork)
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "verified" and [s["file"] for s in m["sources"]] == ["notes.md"], m
    assert marks.stale_sources(m) == []
    # another line changed: the cited line reads as the check read it
    _edit(notes, "# app, the habit tracker\nRun it on port 8000.\nThe tests use pytest.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    assert marks.stale_sources(marks.stored(CORPUS, turn)["items"][0]) == []
    # the cited line changed: the mark is stale, and the page reads it so from the chat's records
    _edit(notes, "# app, the habit tracker\nRun it on port 9000.\nThe tests use pytest.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert [s["file"] for s in marks.stale_sources(m)] == ["notes.md"], m
    _, log_path = agents.paths(CORPUS, agents.MAIN_ID)
    last = [r for r in agents.read_events(log_path) if r["type"] == "marks" and r["turn"] == turn][-1]
    assert last["items"][0]["sources"][0]["changed"] is True

    _repair(turn, fork)
    assert ("The analyst pressed Repair on citation 1, since notes.md changed after its first check. What this session read or "
            "printed before that change may be out of date. A copy of a file from before the change is no evidence. Say what "
            "changed in `reason`, not in the sentence.") in prompts[-1]
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "corrected" and m["shown"] == "port 9000" and marks.stale_sources(m) == [], m
    assert "fresh" not in m
    # the first check took any call as evidence; the repair of the stale mark only its own
    assert fresh == [False, True]


def test_a_stale_mark_whose_repair_failed_is_repaired_against_the_file_now_until_a_check_passes(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    notes = folder / "notes.md"
    notes.write_text("# app\nRun it on port 8000.\n")
    _main(monkeypatch, folder)
    fresh = _fresh_calls(monkeypatch)
    prompts: list[str] = []
    answers = [
        {"mark": 1, "kind": "quote", "evidence": {"file": "notes.md", "line": 2, "substring": "port 8000"}, "status": "verified", "reason": "line 2"},
        {"mark": 1, "kind": "quote", "evidence": {"file": "notes.md", "line": 2, "substring": "port 9000"}, "status": "wrong", "reason": "Line 2 now says port 9000."},
        {"mark": 1, "kind": "quote", "evidence": {"file": "notes.md", "line": 2, "substring": "port 9000"}, "status": "corrected",
         "correction": {"words": "port 9000"}, "reason": "line 2"},
    ]

    async def fork(c, main, cut, prompt):
        prompts.append(prompt)
        return {"answer": _answer([answers.pop(0)]), "calls": [], "error": None}

    turn = _check(folder, "The app runs on [port 8000](#).", fork)
    _edit(notes, "# app\nRun it on port 9000.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    _repair(turn, fork)
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "failed" and m["fresh"] == ["notes.md"], m
    # a second Repair: the file as it is now again, the session's earlier output no evidence
    _repair(turn, fork)
    assert "since notes.md changed after its first check" in prompts[-1]
    assert fresh == [False, True, True]
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "corrected" and m["shown"] == "port 9000" and "fresh" not in m, m


def test_repair_of_one_of_two_stale_marks_of_a_sentence_repairs_both_with_one_rewrite(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    notes = folder / "notes.md"
    notes.write_text("# app\nuvicorn app:app --port 8000\nOpen http://localhost:8000.\n")
    _main(monkeypatch, folder)
    prompts: list[str] = []
    was = "The app runs on [port 8000]: start it with `uvicorn ... --port 8000`, then open [http://localhost:8000]."
    now = "The app runs on [port 9000]: start it with `uvicorn ... --port 9000`, then open [http://localhost:9000]."

    async def fork(c, main, cut, prompt):
        prompts.append(prompt)
        port = "9000" if "9000" in notes.read_text() else "8000"
        out = [{"mark": n, "kind": "quote", "evidence": {"file": "notes.md", "line": n + 1, "substring": sub}, "reason": "it says so",
                **({"status": "corrected", "correction": {"words": sub, "sentence": now}} if port == "9000" else {"status": "verified"})}
               for n, sub in ((1, f"port {port}"), (2, f"http://localhost:{port}"))]
        return {"answer": _answer(out), "calls": [], "error": None}

    turn = _check(folder, "The app runs on [port 8000](#): start it with `uvicorn ... --port 8000`, then open [http://localhost:8000](#).", fork)
    _edit(notes, "# app\nuvicorn app:app --port 9000\nOpen http://localhost:9000.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    assert [len(marks.stale_sources(m)) for m in marks.stored(CORPUS, turn)["items"]] == [1, 1]
    # Repair on the first: one check of both, its request naming the second
    _repair(turn, fork)
    assert f"1. [port 8000] in: {was}\n2. [http://localhost:8000] in: {was}" in prompts[-1]
    assert "Citation 2 stands in the same sentence, and notes.md changed after its first check too." in prompts[-1]
    items = marks.stored(CORPUS, turn)["items"]
    assert [(m["status"], m["shown"], m.get("rewrite")) for m in items] == [("corrected", "port 9000", now), ("corrected", "http://localhost:9000", now)], items
    assert all(marks.stale_sources(m) == [] and "fresh" not in m for m in items), items


def test_a_pass_reads_only_the_replies_whose_marks_rest_on_a_file_that_changed_and_moved_lines_take_their_numbers(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    notes, other = folder / "notes.md", folder / "other.md"
    notes.write_text("# app\nRun it on port 8000.\nThe tests use pytest.\n")
    other.write_text("# other\nIt needs Python 3.12.\n")
    _main(monkeypatch, folder)

    def fork_for(file: str, sub: str):
        async def fork(c, main, cut, prompt):
            line = next(k for k, t in enumerate((folder / file).read_text().splitlines(), 1) if sub in t)
            return {"answer": _answer([{"mark": 1, "kind": "quote", "evidence": {"file": file, "line": line, "substring": sub},
                                        "status": "verified", "reason": "it says so"}]), "calls": [], "error": None}
        return fork

    a = _check(folder, "The app runs on [port 8000](#).", fork_for("notes.md", "port 8000"))
    b = _check(folder, "It needs [Python 3.12](#).", fork_for("other.md", "Python 3.12"))
    index = json.loads((config.workspace_dir(CORPUS) / "marks" / "cited.json").read_text())
    assert {os.path.basename(p): f["by"] for p, f in index["files"].items()} == {"notes.md": {a: [1]}, "other.md": {b: [1]}}
    read: list[str] = []
    stored = marks.stored
    monkeypatch.setattr(marks, "stored", lambda c, turn: (read.append(turn), stored(c, turn))[1])
    # nothing changed: no reply read
    asyncio.run(marks.refresh_sources(CORPUS))
    assert read == []
    # a line added above the cited one: only that reply is read, and its mark stays verified at the line it moved to
    _edit(notes, "# app\nA habit tracker.\nRun it on port 8000.\nThe tests use pytest.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    assert set(read) == {a}
    (m,) = stored(CORPUS, a)["items"]
    assert m["status"] == "verified" and marks.stale_sources(m) == [], m
    assert m["sources"][0]["line"] == "3" and m["evidence"]["line"] == "3"
    assert [x["n"] for x in m["evidence"]["lines"]] == [3, 4]
    # and the page reads it so from the chat's records
    _, log_path = agents.paths(CORPUS, agents.MAIN_ID)
    last = [r for r in agents.read_events(log_path) if r["type"] == "marks" and r["turn"] == a][-1]
    assert last["items"][0]["evidence"]["line"] == "3"


def _validator():
    """The terminal's validator as a module, for its prelude: the audit hook that notes what a script reads."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("thimble_validate_test", marks.VALIDATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _plain_runner(runs: list):
    """The runner with no sandbox, for the logic alone: the script run by this Python with the validator's prelude, as
    validate.py runs it in the terminal's sandbox. Each run's script goes to `runs`."""
    import subprocess
    import sys

    prelude = _validator().PRELUDE

    def runner(c, folders):
        def run(script, folder, python="python3", flags=(), argv=("-",)):
            runs.append(script)
            reads = os.path.join(os.path.dirname(folder), f"reads-{len(runs)}.txt")
            p = subprocess.run([sys.executable, "-B", *flags, "-c", prelude, *argv[1:]], input=script, capture_output=True,
                               text=True, cwd=folder, env={**os.environ, "THIMBLE_READS": reads, "THIMBLE_ARGV0": argv[0]})
            got = open(reads).read().splitlines() if os.path.exists(reads) else []
            return {"output": p.stdout + p.stderr, "reads": got, "ok": p.returncode == 0}
        return run
    return runner


SEVERITIES = """import json, os
from collections import Counter
for build in sorted(os.listdir(".")):
    path = os.path.join(build, "report", "review-results.json")
    if os.path.isfile(path):
        c = Counter(f["severity"] for f in json.load(open(path))["fixed"])
        print(f"{build}: {c['major']} major, {c['minor']} minor of {sum(c.values())}")"""


def test_a_computed_mark_rests_on_the_files_its_code_read_and_is_stale_only_when_its_value_changed(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    review = folder / "build-a" / "report" / "review-results.json"
    review.parent.mkdir(parents=True)
    review.write_text(json.dumps({"fixed": [{"title": "Streak resets", "severity": "major"}, {"title": "Toast hides undo", "severity": "minor"}]}, indent=1))
    _main(monkeypatch, folder)
    runs: list[str] = []
    monkeypatch.setattr(marks, "runner", _plain_runner(runs))
    run = marks.runner(CORPUS, (str(folder), str(folder)))
    call = {"command": f"cd {folder} && python3 - <<'PY'\n{SEVERITIES}\nPY", "output": run(SEVERITIES, str(folder))["output"], "by": "checker"}
    assert "build-a: 1 major, 1 minor of 2" in call["output"]

    async def fork(c, main, cut, prompt):
        out = [{"mark": 1, "kind": "computed", "evidence": {"output": "build-a: 1 major, 1 minor of 2"}, "status": "verified",
                "reason": "counted", "method": "Counted the findings of each build's review results by severity."}]
        return {"answer": _answer(out), "calls": [call], "error": None}

    runs.clear()
    turn = _check(folder, "Build-a's review has [1 major](#) finding.", fork)
    (m,) = marks.stored(CORPUS, turn)["items"]
    # the file the code opened, through a path it built, is what the mark rests on; the check ran the code once
    assert m["status"] == "verified" and [s["file"] for s in m["sources"]] == ["build-a/report/review-results.json"], m
    assert m["rerun"]["given"] == "build-a: 1 major, 1 minor of 2" and len(runs) == 1
    # an edit that leaves the count as it was: the code runs again, prints the same, and the mark rests on the file now
    _edit(review, review.read_text().replace("Toast hides undo", "The toast hides undo"))
    runs.clear()
    asyncio.run(marks.refresh_sources(CORPUS))
    (m2,) = marks.stored(CORPUS, turn)["items"]
    assert len(runs) == 1 and marks.stale_sources(m2) == [] and m2["sources"][0]["sha256"] != m["sources"][0]["sha256"], m2
    # an edit that changes it: the mark is stale
    _edit(review, review.read_text().replace('"major"', '"minor"'))
    asyncio.run(marks.refresh_sources(CORPUS))
    (m3,) = marks.stored(CORPUS, turn)["items"]
    assert [s["file"] for s in marks.stale_sources(m3)] == ["build-a/report/review-results.json"], m3


def _seed_reading_card(monkeypatch, data, takeaway: str) -> tuple[str, list[int]]:
    """A card whose code read `data` (its reads record), its table as that file makes it, and a takeaway; a run of its
    code, kept (1) or not (0), is replaced by one that reads the file again: (its id, the runs of it)."""
    from app import notebook

    def table() -> dict:
        rows = json.loads(data.read_text())
        body = "".join(f"<tr><th>{a}</th><td>{n}</td></tr>" for a, n in rows.items())
        return {"text/html": f"<table><tr><th>agent</th><th>test runs</th></tr>{body}</table>"}

    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Tests", role="exploration")
    cell = notebook.new_cell("code", "run", "Test runs by agent", nb["id"], code="print()")
    cell.update(status="ok", outputs=[table()], takeaway=takeaway, reads=[str(data.relative_to(config.corpus_dir(CORPUS)))])
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    ran: list[int] = []

    async def trial_run(c, cid, code):
        ran.append(0)
        return {**notebook.get_cell(c, cid), "outputs": [table()], "status": "ok", "trial": "t1", "reads": cell["reads"]}

    async def trial_settle(c, cid, tid, *, keep):
        assert tid == "t1" and keep is False

    async def run_cell(c, nb_id, cid):
        ran.append(1)
        with notebook.editing(ws):
            hit = notebook._locate(ws, cid)
            hit[1].update(outputs=[table()], status="ok")
            notebook.write_notebook(ws, hit[0])

    monkeypatch.setattr(notebook, "trial_run", trial_run)
    monkeypatch.setattr(notebook, "trial_settle", trial_settle)
    monkeypatch.setattr(notebook, "_run_cell", run_cell)
    return cell["id"], ran


def test_a_takeaway_mark_on_a_card_s_value_goes_stale_when_the_card_s_input_changes_that_value_and_repair_runs_the_card(_fresh, monkeypatch):
    from app import notebook

    folder = config.corpus_dir(CORPUS)
    data = folder / "tests.json"
    data.write_text(json.dumps({"agent-01": 71, "agent-02": 40}))
    _main(monkeypatch, folder)
    cid, ran = _seed_reading_card(monkeypatch, data, "agent-01 ran its tests [71](#) times.")

    async def fork(c, main, cut, prompt):
        value = json.loads(data.read_text())["agent-01"]
        out = [{"mark": 1, "kind": "card", "evidence": {"ref": f"card:{cid}#test runs/agent-01"}, "reason": "the table says so",
                **({"status": "verified"} if value == 71 else {"status": "corrected", "correction": {"words": str(value)}})}]
        return {"answer": _answer(out), "calls": [], "error": None}

    turn = marks.new_turn()
    asyncio.run(marks.start_check(CORPUS, {"sid": SID, "cwd": str(folder), "transcript_path": None}, turn, [], "cut-1", fork=fork))
    (m,) = notebook.get_cell(CORPUS, cid)["takeaway_marks"]["items"]
    # the card's value rests on the file the card's code read
    assert m["status"] == "verified" and [s["file"] for s in m["sources"]] == ["tests.json"], m
    assert m["rerun"] == {"card": cid, "values": {f"card:{cid}#test%20runs/agent-01": "71"}}
    index = json.loads((config.workspace_dir(CORPUS) / "marks" / "cited.json").read_text())
    assert [f["by"] for f in index["files"].values()] == [{f"card:{cid}": [0]}]
    # another agent's count changed: the card's code runs again, not kept, and the cited value is as it was
    _edit(data, json.dumps({"agent-01": 71, "agent-02": 41}))
    asyncio.run(marks.refresh_sources(CORPUS))
    (m2,) = notebook.get_cell(CORPUS, cid)["takeaway_marks"]["items"]
    assert ran == [0] and marks.stale_sources(m2) == [], m2
    # the cited value changed: the takeaway's mark is stale, and the card shows its outputs as they were
    _edit(data, json.dumps({"agent-01": 72, "agent-02": 41}))
    asyncio.run(marks.refresh_sources(CORPUS))
    (m3,) = notebook.get_cell(CORPUS, cid)["takeaway_marks"]["items"]
    assert ran == [0, 0] and [s["file"] for s in marks.stale_sources(m3)] == ["tests.json"], m3
    assert ">71<" in notebook.get_cell(CORPUS, cid)["outputs"][0]["text/html"]

    # Repair: the card runs again, then the check reads its new value and corrects the takeaway's words
    async def go():
        assert await marks.repair(CORPUS, card=cid, k=0, fork=fork) == ""
        await asyncio.gather(*(t for t in asyncio.all_tasks() if t is not asyncio.current_task()))

    asyncio.run(go())
    assert ran == [0, 0, 1]
    (m4,) = notebook.get_cell(CORPUS, cid)["takeaway_marks"]["items"]
    assert m4["status"] == "corrected" and m4["shown"] == "72" and marks.stale_sources(m4) == [], m4
    assert m4["rerun"]["values"] == {f"card:{cid}#test%20runs/agent-01": "72"}
