"""Lineage gaps closed: outputs whose index the kernel could not read back (a described frame turned on its side),
whole JSON documents and the files a loop opened, groupbys on a number column, and row sets of transcript blocks.
Run: LEAN_PYTHON-or-any-python-with-pandas -m pytest lean/tests"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import lineage as LIN  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel.store import Store  # noqa: E402

# made-up events: 40 actions by four agents, the first of them a lead
EVENTS = [{"agent": f"a{i % 4}", "step": i, "hours": i * 0.5, "act": ["read", "edit", "test"][i % 3]} for i in range(40)]


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    with open(d / "events.jsonl", "w") as f:
        for e in EVENTS:
            f.write(json.dumps(e) + "\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("LEAN_SESSION", "s-gaps")
    monkeypatch.delenv("LEAN_ROOT", raising=False)
    return d


# ------------------------------------------------------------------ an index the kernel reads back


def test_a_described_frame_turned_on_its_side_keeps_its_output(root: Path) -> None:
    st = Store(root)
    # describe().T has an index of two unnamed levels: reset, they are level_0 and level_1, never `index`
    q = Q.run(st, "profile", 'df = load("events.jsonl")\ndf["role"] = np.where(df.agent == "a0", "lead", "worker")\n'
              'df.groupby("role")[["step", "hours"]].describe(percentiles=[.5]).T')
    assert q["error"] is None and q["keys"] == ["level_0", "level_1"]
    assert q["table"][0] == {"level_0": "step", "level_1": "count", "lead": 10.0, "worker": 30.0}
    r = LIN.resolve(st, f"{q['id']}#level_0=step&level_1=count@lead")
    assert r["chain"][0]["value"] == 10.0


def test_an_unnamed_index_beside_a_column_named_index_keeps_its_output(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "per agent", 'df = load("events.jsonl")\nt = df.groupby("agent").size().rename("index").to_frame()\n'
              't.index = ["x" + a for a in t.index]\nt')
    assert q["error"] is None and q["keys"] == ["level_0"]
    assert q["table"][0] == {"level_0": "xa0", "index": 10}


def test_a_lineage_that_fails_keeps_the_output_and_says_why(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    st = Store(root)

    def broken(*a, **k):
        raise KeyError("index")

    monkeypatch.setattr(Q, "output_lineage", broken)
    q = Q.run(st, "per agent", 'df = load("events.jsonl")\ndf.groupby("agent").size()')
    assert q["error"] is None and q["rows"] is None and q["lineage_error"] == "KeyError: 'index'"
    assert q["table"][0] == {"agent": "a0", "value": 10}
    assert q["read"] == ["events.jsonl#L1-40"]
    r = LIN.resolve(st, f"{q['id']}#agent=a1@value")
    assert r["why"] == (f"lean could not find the rows behind {q['id']}'s output (KeyError: 'index'), so its values keep "
                        "no rows: tally() in the query keeps them per row")
    # the query as a whole still opens every row it read
    assert LIN.resolve(st, q["id"])["count"] == 40


# ------------------------------------------------------------------ whole JSON documents

# made-up chat logs, one JSON document per agent: messages keyed by id, as some exports write them
CHATS = {"ep1/u1.json": ("u1", ["ls", "make", "make test"]), "ep1/u2.json": ("u2", ["cat notes"]),
         "ep2/u1.json": ("u1", ["ls", "ls -la"])}


@pytest.fixture()
def docs_root(root: Path) -> Path:
    for rel, (agent, cmds) in CHATS.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        msgs = {f"m{i}": {"role": "assistant", "content": [{"type": "tool_use", "name": "Bash", "input": {"command": c}}]}
                for i, c in enumerate(cmds)}
        p.write_text(json.dumps({"agent": agent, "system": [{"text": "a made-up prompt"}], "messages": msgs}))
    # a .json file with one record per line is no document: its rows stay lines
    (root / "ep1" / "lines.json").write_text('{"a": 1}\n{"a": 2}\n')
    return root


def test_a_whole_json_document_opens_its_root_row(docs_root: Path) -> None:
    st = Store(docs_root)
    whole = LIN.resolve(st, "ep1/u1.json")
    assert whole["rows"] == ["ep1/u1.json#/"] and whole["count"] == 1 and "why" not in whole
    assert whole["records"][0]["ref"] == "ep1/u1.json#/"
    # the same as the document's root pointer, which opened it before
    assert LIN.resolve(st, "ep1/u1.json#/")["records"] == whole["records"]
    # a document on one line: its line 1 is the document
    one = LIN.resolve(st, "ep1/u2.json#L1")
    assert one["count"] == 1 and one["records"][0]["text"].startswith("agent: u2")
    # a file of one record per line stays a whole file, and its lines open as records
    assert LIN.resolve(st, "ep1/lines.json")["rows"] == ["ep1/lines.json"]
    assert LIN.resolve(st, "ep1/lines.json#L2")["records"][0]["text"] == "a: 2"


def test_a_query_whose_rows_are_whole_documents_opens_them(docs_root: Path) -> None:
    st = Store(docs_root)
    q = Q.run(st, "calls per run", 'import glob\nout = []\nfor f in sorted(glob.glob("ep*/u*.json")):\n'
              '    d = json.load(open(f))\n    out.append(dict(_ref=f, run=f.split("/")[0], agent=d["agent"], calls=len(d["messages"])))\n'
              'pd.DataFrame(out)')
    # a whole JSON document is kept as its root row
    assert q["lineage"] == "exact" and q["rows"][0] == ["ep1/u1.json#/"]
    r = LIN.resolve(st, f"{q['id']}#run=ep1&agent=u2@calls")
    assert r["rows"] == ["ep1/u2.json#/"] and r["count"] == 1 and r["records"][0]["ref"] == "ep1/u2.json#/"
    assert LIN.resolve(st, q["id"])["count"] == 3
    # a record an earlier kernel wrote names the whole files: they open the same
    f = docs_root / "thimble" / "queries" / f"{q['id']}.json"
    old = json.loads(f.read_text())
    old["rows"] = [[x[0].removesuffix("#/")] for x in old["rows"]]
    f.write_text(json.dumps(old))
    assert LIN.resolve(st, f"{q['id']}#run=ep1&agent=u2@calls")["rows"] == ["ep1/u2.json#/"]


def test_records_built_from_documents_opened_in_a_loop_rest_on_them(docs_root: Path) -> None:
    st = Store(docs_root)
    code = ('import glob\nout = []\nfor f in sorted(glob.glob("ep*/u*.json")):\n    d = json.load(open(f))\n'
            '    out.append(dict(run=f.split("/")[0], agent=d["agent"], calls=len(d["messages"])))\npd.DataFrame(out)')
    q = Q.run(st, "calls per run", code)
    assert q["lineage"] == "loop" and q["rows"] == [["ep1/u1.json#/"], ["ep1/u2.json#/"], ["ep2/u1.json#/"]]
    r = LIN.resolve(st, f"{q['id']}#run=ep2&agent=u1@calls")
    assert r["rows"] == ["ep2/u1.json#/"] and r["records"]
    assert r["why"] == (f"{q['id']} made this output row in a loop from the files it opened for it (ep2/u1.json), and "
                        "it does not keep which part of them the value used")
    # records of an inner loop rest on the document the outer loop opened
    inner = ('import glob\nout = []\nfor f in sorted(glob.glob("ep*/u*.json")):\n    d = json.load(open(f))\n'
             '    for mid, m in d["messages"].items():\n        out.append(dict(file=f, mid=mid, cmd=m["content"][0]["input"]["command"]))\n'
             'pd.DataFrame(out)')
    i = Q.run(st, "every call", inner)
    assert i["lineage"] == "loop" and i["rows"][3] == ["ep1/u2.json#/"] and i["rows"][5] == ["ep2/u1.json#/"]
    # one document opened before the loop: every record rests on it alike, so nothing per row is known, and each row
    # opens the document the query read
    one = Q.run(st, "calls of one run", 'd = json.load(open("ep1/u1.json"))\nout = []\nfor mid, m in d["messages"].items():\n'
                '    out.append(dict(mid=mid, cmd=m["content"][0]["input"]["command"]))\npd.DataFrame(out)')
    assert one["rows"] is None
    r = LIN.resolve(st, f"{one['id']}#mid=m1@cmd")
    assert r["rows"] == ["ep1/u1.json#/"] and r["count"] == 1
    assert r["why"] == (f"{one['id']} built its output in code from JSON documents it opened (ep1/u1.json), so a value "
                        "opens the whole document: a `_ref` column of JSON pointers (ep1/u1.json#/<key>/<n>) keeps each "
                        "row's own part")


def test_records_built_from_line_files_opened_in_a_loop_rest_on_their_lines(root: Path) -> None:
    st = Store(root)
    (root / "logs").mkdir()
    (root / "logs" / "a.jsonl").write_text('{"x": 1}\n{"x": 2}\n')
    (root / "logs" / "b.jsonl").write_text('{"x": 3}\n')
    code = ('import glob\nout = []\nfor f in sorted(glob.glob("logs/*.jsonl")):\n'
            '    xs = [json.loads(l)["x"] for l in open(f)]\n    out.append({"file": f, "total": sum(xs)})\npd.DataFrame(out)')
    q = Q.run(st, "totals", code)
    assert q["lineage"] == "loop" and q["rows"] == [["logs/a.jsonl#L1-2"], ["logs/b.jsonl#L1"]]
    assert LIN.resolve(st, f"{q['id']}#file=logs/a.jsonl@total")["count"] == 2
    # files read with rows() or load() are not files the code opened: their records keep what the loop held
    r = Q.run(st, "by rows", 'out = []\nfor ref, row in rows("logs/*.jsonl"):\n    out.append({"x": row["x"]})\npd.DataFrame(out)')
    assert r["rows"] is None
