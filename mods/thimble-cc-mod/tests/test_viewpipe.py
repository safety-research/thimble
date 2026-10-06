"""Tests of the view pipeline's helper (helper/viewpipe.py): proposals, the reader's run and thimble's gates.

    python3 tests/test_viewpipe.py

Each test builds a small folder of two runs' chat logs with a torn last line, and a view of it in
.thimble-cc-mod/views/chats/, then breaks one thing at a time.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "helper")
sys.path.insert(0, HELPER)
import viewpipe  # noqa: E402

READER = '''
import json

def build_index(paths):
    msgs, bad = [], []
    for p in sorted(paths):
        with open(p, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                try:
                    m = json.loads(line)
                except ValueError:
                    bad.append({"ref": f"{p}#L{n}", "why": "not a JSON line"})
                    continue
                msgs.append({"ref": f"{p}#L{n}", "run": p.split("/")[0], "who": m["user"], "said": m["text"],
                             "time": m["ts"]})
    return {"msgs": msgs, "bad": bad}

def records(index, query):
    rows = [dict(m) for m in index["msgs"]]
    SHAPE
    return {"collections": {"messages": rows}}

def problems(index):
    return index["bad"]

def resolve(index, locator):
    ref = f"{locator.get('path')}#{locator.get('fragment')}"
    for m in index["msgs"]:
        if m["ref"] == ref:
            with open(locator["path"], encoding="utf-8") as f:
                line = f.read().splitlines()[int(locator["fragment"][1:]) - 1]
            return {"excerpt": line, "label": m["who"], "refs": [ref]}
    return None
'''

SPEC = {
    "version": 1, "name": "Chats", "slug": "chats", "description": "Each run's chat, a message per row.",
    "scope": ["runs/*/chat.jsonl"],
    "collections": [{
        "name": "messages", "one": "one chat message", "key": "ref", "title": "said",
        "fields": [{"name": "ref", "type": "ref"}, {"name": "run", "type": "category", "derived": "computed",
                                                     "from": "the file's folder", "how": "the folder under runs"},
                   {"name": "who", "type": "category"}, {"name": "said", "type": "text"},
                   {"name": "time", "type": "time"}],
        "detail": {"meta": ["run", "who"], "fields": ["time"], "text": "said"},
    }],
    "stats": [{"label": "messages", "collection": "messages", "agg": "count"}],
    "tabs": [{"name": "Messages", "collection": "messages",
              "overview": {"kind": "histogram", "time": "time", "color": "run"},
              "zoom": "a click on the strip narrows to that time", "filter": {"fields": ["run", "who"]},
              "body": [{"kind": "table", "columns": [{"field": "time"}, {"field": "who"}, {"field": "said"}]}]}],
    "accepts": [{"form": "L<n>", "means": "the message on line <n>"}],
}


def folder(reader: str = READER, spec: dict | None = None, shape: str = "pass") -> str:
    d = tempfile.mkdtemp(prefix="viewpipe-test-")
    users = ["ada", "bo", "cy"]
    for run in ("r1", "r2"):
        os.makedirs(os.path.join(d, "runs", run))
        with open(os.path.join(d, "runs", run, "chat.jsonl"), "w", encoding="utf-8") as f:
            for i in range(30):
                f.write(json.dumps({"user": users[i % 3], "text": f"message {i} of {run} about the build",
                                    "ts": f"2026-05-{10 + i // 10:02d}T0{i % 10}:00:00Z"}) + "\n")
            if run == "r2":
                f.write('{"user": "ada", "text": "cut sh')
    v = os.path.join(d, ".thimble-cc-mod", "views", "chats")
    os.makedirs(v)
    with open(os.path.join(v, "reader.py"), "w", encoding="utf-8") as f:
        f.write(reader.replace("SHAPE", shape))
    with open(os.path.join(v, "view.json"), "w", encoding="utf-8") as f:
        json.dump(spec or SPEC, f)
    return d


def check(d: str) -> dict:
    return viewpipe.check(d, "chats")


def test_a_good_view_passes_and_writes_its_rows() -> None:
    d = folder()
    with open(os.path.join(d, ".thimble-cc-mod", "labels.json"), "w", encoding="utf-8") as f:
        json.dump([{"name": "Bo speaks", "kind": "regex", "spec": '"user": "bo"', "labels": ["bo", "other"],
                    "paths": ["runs/*/chat.jsonl"]}], f)
    rep = check(d)
    assert rep["ok"], rep["lines"]
    assert any(ln.startswith("unread: 1 line") and "runs/r2/chat.jsonl#L31" in ln for ln in rep["lines"]), rep["lines"]
    assert any(ln.startswith("files: 2 of 2 read") for ln in rep["lines"]), rep["lines"]
    assert any(ln.startswith("ok  runs/") for ln in rep["lines"]), rep["lines"]
    rows = json.load(open(os.path.join(d, ".thimble-cc-mod", "views", "chats", "rows.json")))
    assert len(rows["collections"]["messages"]) == 60
    assert rows["problems"][0]["ref"] == "runs/r2/chat.jsonl#L31" and rows["files"] == 2
    label = rows["labels"][0]
    assert label["name"] == "Bo speaks" and label["marks"]["runs/r1/chat.jsonl#L2"] == "bo"
    assert label["marks"]["runs/r1/chat.jsonl#L1"] == "other"


def test_a_file_left_unread_fails_with_its_bytes() -> None:
    reader = READER.replace("for p in sorted(paths):", "for p in sorted(paths)[:1]:")
    rep = check(folder(reader))
    assert not rep["ok"]
    assert any("neither read to the end" in p and "runs/r2/chat.jsonl (read 0 of" in p for p in rep["problems"]), rep["problems"]


def test_a_field_the_reader_made_must_be_declared() -> None:
    rep = check(folder(shape='for r in rows: r["who"] = r["who"].upper() + "!"'))
    assert not rep["ok"]
    assert any(p.startswith("messages.who holds values") for p in rep["problems"]), rep["problems"]


def test_a_reader_that_hides_a_torn_line_fails_on_the_damaged_copy() -> None:
    reader = READER.replace('bad.append({"ref": f"{p}#L{n}", "why": "not a JSON line"})', "pass")
    d = folder(reader)
    # the folder's own torn line, mended, so only the damaged copy's line is unreported
    p = os.path.join(d, "runs", "r2", "chat.jsonl")
    lines = open(p, encoding="utf-8").read().splitlines()[:-1]
    open(p, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    rep = check(d)
    assert not rep["ok"]
    assert any("added a line cut short" in p and "does not report it" in p for p in rep["problems"]), rep["problems"]


def test_a_reader_that_breaks_on_a_missing_file_fails() -> None:
    reader = READER.replace("def build_index(paths):", "def build_index(paths):\n    assert len(paths) == 2, 'two runs'")
    rep = check(folder(reader))
    assert not rep["ok"]
    assert any(p.startswith("With runs/") and "missing" in p and "the reader failed" in p for p in rep["problems"]), rep["problems"]


def test_the_spec_is_validated_and_drawn() -> None:
    spec = json.loads(json.dumps(SPEC))
    spec["tabs"][0]["body"][0]["columns"][1]["field"] = "nope"
    rep = check(folder(spec=spec))
    assert any(p.startswith("view.json tabs[0].body[0].columns[1].field") for p in rep["problems"]), rep["problems"]
    spec = json.loads(json.dumps(SPEC))
    spec["slug"] = "other"
    rep = check(folder(spec=spec))
    assert any("not 'chats', the name of its folder" in p for p in rep["problems"]), rep["problems"]
    spec = json.loads(json.dumps(SPEC))
    spec["labels"] = False
    rep = check(folder(spec=spec))
    assert any("draws no label controls" in p for p in rep["problems"]), rep["problems"]


def test_hex_titles_fail() -> None:
    rep = check(folder(shape='import hashlib\n    for r in rows: r["said"] = hashlib.sha1(r["said"].encode()).hexdigest()'))
    assert any("hex id" in p for p in rep["problems"]), rep["problems"]


def test_names_the_reader_cut_in_the_middle_fail() -> None:
    rep = check(folder(shape='for r in rows: r["said"] = r["said"][:7] + "…" + r["said"][-9:]'))
    assert not rep["ok"]
    assert any(p.startswith("messages.said shortens 60 of 60 names with an ellipsis in the middle, such as 'message…the build'")
               and "give each name whole" in p for p in rep["problems"]), rep["problems"]
    # prose cut at its end is not a name cut short
    rep = check(folder(shape='for r in rows: r["said"] = r["said"][:12] + "…"'))
    assert not any("ellipsis in the middle" in p for p in rep["problems"]), rep["problems"]


def test_a_reader_that_crashes_reports_its_traceback() -> None:
    rep = check(folder(READER.replace('m["user"]', 'm["nobody"]')))
    assert not rep["ok"] and rep["problems"][0].startswith("build_index failed: KeyError")
    assert "Traceback" in "\n".join(rep["lines"])


def test_the_command_line_check_exits_1_on_failure_and_saves_its_lines() -> None:
    d = folder(READER.replace("for p in sorted(paths):", "for p in sorted(paths)[:1]:"))
    p = subprocess.run([sys.executable, os.path.join(HELPER, "viewpipe.py"), "check", "chats", "--root", d],
                       capture_output=True, text=True)
    assert p.returncode == 1 and "checks failed" in p.stdout
    saved = json.load(open(os.path.join(d, ".thimble-cc-mod", "views", "chats", "check.json")))
    assert saved["ok"] is False and saved["lines"][-1] == "checks failed"


def test_large_rows_go_in_parts_the_panel_reads_one_by_one() -> None:
    d = folder()
    old = viewpipe.PART_BYTES
    viewpipe.PART_BYTES = 2000
    try:
        rep = check(d)
    finally:
        viewpipe.PART_BYTES = old
    assert rep["ok"], rep["lines"]
    v = os.path.join(d, ".thimble-cc-mod", "views", "chats")
    head = json.load(open(os.path.join(v, "rows.json")))
    assert head["collections"] == {"messages": []} and len(head["parts"]) > 2 and head["files"] == 2
    assert all(os.path.getsize(os.path.join(v, p)) <= 2000 for p in head["parts"])
    whole = viewpipe.read_rows(v)
    assert [r["ref"] for r in whole["collections"]["messages"]][:2] == ["runs/r1/chat.jsonl#L1", "runs/r1/chat.jsonl#L2"]
    assert len(whole["collections"]["messages"]) == 60 and "parts" not in whole
    assert any(n.startswith("rows.json is in") for n in rep["notes"])
    # kept for the review and put back, parts and all; a smaller run removes the parts it no longer needs
    assert viewpipe.main(["keep", "chats", "--root", d]) == 0
    os.remove(os.path.join(v, head["parts"][0]))
    assert viewpipe.main(["restore", "chats", "--root", d]) == 0
    assert len(viewpipe.read_rows(v)["collections"]["messages"]) == 60
    viewpipe.run(d, "chats")
    assert not [f for f in os.listdir(v) if f.startswith("rows-")]


def test_rows_past_the_limit_fail_and_name_the_largest_fields() -> None:
    d = folder()
    rep = check(d)
    assert rep["ok"] and any(re.fullmatch(r"rows\.json: \d+ KB", ln) for ln in rep["lines"]), rep["lines"]
    old = viewpipe.ROWS_MAX
    viewpipe.ROWS_MAX = 2000
    try:
        rep = check(d)
    finally:
        viewpipe.ROWS_MAX = old
    assert not rep["ok"]
    p = next((p for p in rep["problems"] if p.startswith("the rows take")), "")
    assert "about 33 bytes for each of its 60 rows" in p, rep["problems"]
    assert "The largest fields are messages.said" in p and "the row's ref opens the whole record" in p, rep["problems"]
    assert viewpipe.heaviest({"m": [{"said": "x" * 900, "ref": "a#L1", "n": 1}]}, 2) == "m.said 0.0 MB, m.ref 0.0 MB"
    assert not any(n.startswith("rows.json is in") for n in rep["notes"])


# ------------------------------------------------------------------------------------------------ proposals

PROPOSAL = {"name": "chat by run", "why": "Each run's chat on one page, so the analyst sees who spoke when.",
            "claims": ["runs/*/chat.jsonl"], "unit": "one message, keyed by its line; 60",
            "overview": "a table of messages", "zoom": "a run's messages", "filter": "run and speaker",
            "details": "the message whole"}


def test_a_proposal_is_saved_under_its_slug() -> None:
    d = folder()
    got = viewpipe.propose(d, PROPOSAL, build=True)
    assert got["ok"] and got["slug"] == "chat-by-run"
    saved = json.load(open(os.path.join(d, ".thimble-cc-mod", "views", "chat-by-run", "proposal.json")))
    assert saved["name"] == "Chat By Run" and saved["build"] is True and saved["files"] == 2
    assert saved["unit"].startswith("one message")
    listed = {r["slug"]: r for r in viewpipe.listing(d)}
    assert listed["chat-by-run"]["proposal"]["name"] == "Chat By Run" and not listed["chat-by-run"]["drawable"]


def test_a_proposal_names_every_missing_field_and_claims_that_match_nothing() -> None:
    d = folder()
    got = viewpipe.propose(d, {**PROPOSAL, "zoom": " ", "claims": ["logs/*.txt"]})
    assert not got["ok"]
    assert any(p.startswith("zoom:") for p in got["problems"])
    assert any("logs/*.txt matches no file" in p for p in got["problems"])
    assert not os.path.exists(os.path.join(d, ".thimble-cc-mod", "views", "chat-by-run"))


def test_propose_on_the_command_line() -> None:
    d = folder()
    argv = [sys.executable, os.path.join(HELPER, "viewpipe.py"), "propose", "--root", d, "--name", "Chats per run",
            "--why", PROPOSAL["why"], "--claims", "runs/r1/chat.jsonl", "runs/r2/chat.jsonl"]
    argv += [x for k in viewpipe.FIELDS for x in (f"--{k}", PROPOSAL[k])] + ["--build"]
    p = subprocess.run(argv, capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr
    assert "proposed the view Chats Per Run: 2 files match its claims" in p.stdout
    # main's reply to the analyst names the view and nothing of its layout or counts
    assert "Reply in one sentence that names the view Chats Per Run, with no layout, no clicks and no numbers" in p.stdout
    saved = json.load(open(os.path.join(d, ".thimble-cc-mod", "views", "chats-per-run", "proposal.json")))
    assert saved["claims"] == ["runs/r1/chat.jsonl", "runs/r2/chat.jsonl"] and saved["build"] is True
    p = subprocess.run([sys.executable, os.path.join(HELPER, "viewpipe.py"), "propose", "--root", d,
                        "--json", json.dumps({"name": "x"})], capture_output=True, text=True)
    assert p.returncode == 1 and "- why:" in p.stdout


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} passed")
