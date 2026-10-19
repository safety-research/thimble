"""How the kernel keeps its records small: a long row lineage packed in the query's record, result tables that keep a
note of their refs instead of the refs, compressed pickles, and a bounded cache. Every ref must resolve to the same
rows, in the same order, as when the record kept them whole."""
from __future__ import annotations

import json
import os
import random
import sys
import time
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import lineage as LIN  # noqa: E402
from kernel import objects as O  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel import refs as R  # noqa: E402
from kernel import store as STORE  # noqa: E402
from kernel import trace as T  # noqa: E402
from kernel.store import Store  # noqa: E402


def _transcripts(d: Path, runs: int = 3, agents: int = 4, records: int = 120) -> None:
    """Agents' transcripts: each record a few content blocks (words, a tool call), so a query that keeps one ref per
    tool call keeps block refs, which no row set joins."""
    rnd = random.Random(3)
    for r in range(runs):
        (d / f"run{r}").mkdir(parents=True, exist_ok=True)
        for a in range(agents):
            with open(d / f"run{r}" / f"agent-{a:02d}.jsonl", "w") as f:
                f.write(json.dumps({"type": "system", "subtype": "init", "session_id": f"s{r}{a}"}) + "\n")
                for i in range(records):
                    tool = rnd.choice(["Read", "Edit", "Bash", "Grep"])
                    blocks = [{"type": "text", "text": f"step {i}"}, {"type": "tool_use", "name": tool, "input": {"command": f"run {i}"}}]
                    if i % 3 == 0:
                        blocks.append({"type": "tool_use", "name": "Bash", "input": {"command": "pytest"}})
                    f.write(json.dumps({"type": "assistant", "message": {"content": blocks}, "timestamp": f"2026-06-0{1 + i % 3}T10:00:00Z"}) + "\n")


CALLS = '''
out = []
for ref, r in rows("run*/agent-*.jsonl"):
    if r.get("type") != "assistant":
        continue
    for k, b in enumerate(r["message"]["content"]):
        if b.get("type") == "tool_use":
            out.append({"tool": b["name"], "day": r["timestamp"][:10], "run": ref.split("/")[0], "_ref": f"{ref}.b{k}"})
calls = pd.DataFrame(out)
keep("calls", calls)
tally(calls, ["run", "tool"])
'''


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    _transcripts(d)
    with open(d / "events.jsonl", "w") as f:
        for i in range(400):
            f.write(json.dumps({"agent": f"a{i % 7}", "action": ["claim", "push", "review"][i % 3], "n": i}) + "\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("LEAN_SESSION", "s-test")
    monkeypatch.delenv("LEAN_ROOT", raising=False)
    # small enough that these tables' lineage is packed
    monkeypatch.setattr(STORE, "PACK_MIN", 2_000)
    return d


def _every_ref(st: Store, q: dict) -> list[str]:
    refs = [q["id"]]
    for i, r in enumerate(Q.row_refs(q)):
        refs.append(r)
        refs += [f"{r}@{R.ref_value(c)}" for c in (q.get("table") or [])[i]]
    return refs


def _resolved(st: Store, refs: list[str]) -> dict:
    out = {}
    for ref in refs:
        r = LIN.resolve(st, ref, n=6)
        out[ref] = {k: r.get(k) for k in ("chain", "rows", "count", "records", "notes", "why")}
    return out


def _unpack_on_disk(st: Store, qid: str) -> None:
    """The record as an earlier kernel wrote it: its row lineage whole."""
    p = st.dir / "queries" / f"{qid}.json"
    st.write_json(p, STORE.unpack_record(json.loads(p.read_text())))


# ------------------------------------------------------------------ the codec


def test_packed_lists_come_back_the_same_and_in_the_same_order() -> None:
    rnd = random.Random(11)
    files = [f"runs/r{i}/agents/agent-{j:02d}.jsonl" for i in range(4) for j in range(6)]
    blocks = [f"{rnd.choice(files)}#L{rnd.randint(1, 9000)}.b{rnd.randint(0, 4)}" for _ in range(30_000)]
    odd = ["notes.md", "notes.md#Findings and #2", "#only-a-fragment", "budget.xlsx#Q3!B2", "a b/c d.jsonl#L4-9,12",
           "forge.db#prs", "forge.db#prs/1-3", "doc.json#/", "doc.json#/messages/3-7", "naïve/ünïcode.jsonl#L1"]
    whole = blocks[:5000] + odd
    rows = [blocks[i:i + 3000] for i in range(0, 30_000, 3000)] + [whole, whole, [], odd]
    q = {"id": "q7", "table": [{"x": i} for i in range(len(rows))], "rows": rows, "read": whole,
         "cells": [{"n": blocks[:40]} if i % 2 else {} for i in range(len(rows))], "why_rows": None}
    disk = STORE.pack_record(q)
    assert "rows" not in disk and "read" not in disk and "cells" not in disk and disk["packed"]["format"] == STORE.PACK_FORMAT
    assert disk["table"] == q["table"]
    back = STORE.unpack_record(json.loads(json.dumps(disk)))
    assert back["rows"] == rows and back["read"] == whole and back["cells"] == q["cells"]
    # a list the parts share is kept once, and comes back as one list
    assert disk["packed"]["lists"] < len(rows) + 3 and back["rows"][10] is back["rows"][11] is back["read"]
    # a lineage short of PACK_MIN is written as it is, and an old record reads as it is
    small = {"id": "q1", "rows": [["a.jsonl#L1-3"]]}
    assert STORE.pack_record(small) is small and STORE.unpack_record(small) is small


def test_a_packed_record_is_a_fraction_of_the_whole_one() -> None:
    rnd = random.Random(5)
    files = [f"runs/sweep{i}-x/agents/agent-{j:02d}.jsonl" for i in range(8) for j in range(48)]
    rows = [[f"{rnd.choice(files)}#L{rnd.randint(1, 4000)}.b{rnd.randint(0, 2)}" for _ in range(8000)] for _ in range(20)]
    q = {"id": "q3", "rows": rows}
    whole = len(json.dumps(q))
    packed = len(json.dumps(STORE.pack_record(q)))
    # random line numbers are the worst case; a real swarm's packs about 30 to 1
    assert packed * 6 < whole


# ------------------------------------------------------------------ the same refs, the same rows


def test_every_ref_resolves_to_the_same_rows_from_a_packed_record_as_from_a_whole_one(root: Path) -> None:
    """The same queries in two copies of a folder: one keeps its records whole (as before), one packed. Every ref of
    every query, whole, by row and by cell, and every value of an object bound to them, resolves the same; trace finds
    the same uses; and use() gives a later query the same table."""
    import shutil

    other = root.parent / "data-whole"
    shutil.copytree(root, other)
    sts = {"packed": Store(root), "whole": Store(other)}
    codes = [("tool calls per run and tool", CALLS),
             ("calls per day", 'c = use("calls")\ntally(c, "day")'),
             ("share of Bash per run", 'c = use("calls")\n{r: float((g.tool == "Bash").mean()) for r, g in c.groupby("run")}'),
             ("events per agent", 'ev = load("events.jsonl")\nev.groupby("agent").size().reset_index(name="n")')]
    got = {}
    for name, st in sts.items():
        got[name] = [Q.run(st, about, code) for about, code in codes]
        assert all(q["error"] is None for q in got[name]), [q["error"] for q in got[name]]
    # the in-hand records are the same; on disk one is packed
    for a, b in zip(got["packed"], got["whole"]):
        assert a["rows"] == b["rows"] and a.get("cells") == b.get("cells") and a.get("read") == b.get("read")
        assert a["stdout"] == b["stdout"]
    disk = json.loads((root / "thimble" / "queries" / "q1.json").read_text())
    assert "packed" in disk and "rows" not in disk
    for q in got["whole"]:
        _unpack_on_disk(sts["whole"], q["id"])
    assert "rows" in json.loads((other / "thimble" / "queries" / "q1.json").read_text())

    for name, st in sts.items():
        O.save(st, "per-run", {"title": "Tool calls", "data": {"calls": "q1", "bash": "q1#run=run0&tool=Bash@n"},
                               "text": "Bash leads in [run0](q1#run=run0&tool=Bash@n); [a call](run1/agent-02.jsonl#L5.b1)."})
    refs = [r for q in got["packed"] for r in _every_ref(sts["packed"], q)]
    refs += ["obj:01-per-run", "obj:01-per-run#/calls/0", "obj:01-per-run#/calls/3/n", "obj:01-per-run#/bash"]
    a, b = _resolved(sts["packed"], refs), _resolved(sts["whole"], refs)
    assert a.keys() == b.keys()
    for ref in refs:
        assert a[ref] == b[ref], ref
    assert sum(1 for r in a.values() if r["count"]) > 20
    # trace: what uses a block the tally rests on
    one = Q.get(sts["packed"], "q1")["rows"][0][0]
    untimed = lambda u: {k: [{a: b for a, b in e.items() if a != "t"} for e in v] if isinstance(v, list) else v for k, v in u.items()}  # noqa: E731
    used = untimed(T.uses(sts["packed"], one, answers=False))
    assert used == untimed(T.uses(sts["whole"], one, answers=False)) and len(used["queries"]) >= 2
    # use() of each result, and of the kept frame, as a later query reads it
    for q in got["packed"]:
        x = Q.run(sts["packed"], "use it", f'use("{q["id"]}")')
        y = Q.run(sts["whole"], "use it", f'use("{q["id"]}")')
        assert x["stdout"] == y["stdout"] and x["rows"] == y["rows"]


def test_a_result_keeps_a_note_of_its_refs_and_use_expands_them_again(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "events per agent", 'ev = load("events.jsonl")\nev.groupby("agent").size().reset_index(name="n")')
    assert q["lineage"] == "matched"
    f = st.dir / "results" / f"{q['id']}.pkl.gz"
    import pandas as pd

    kept = pd.read_pickle(f)
    assert "_refs" not in kept.columns and kept.attrs.get(Q.REFS_FROM_RECORD)
    info = {"loads": [], "samples": 0, "opened": set(), "external": set(), "kept": [], "uses": [], "frames": []}
    df = Q.make_namespace(st, info)["use"](q["id"])
    assert list(df.columns) == ["agent", "n", "_refs"] and df.attrs == {}
    assert df["_refs"].tolist() == [R.expand(x) for x in q["rows"]]
    assert [len(x) for x in df["_refs"]] == df["n"].tolist()
    # a result an earlier kernel wrote (a plain pickle with the refs in it) still reads
    old = df.copy()
    f.unlink()
    old.to_pickle(st.dir / "results" / f"{q['id']}.pkl")
    again = Q.make_namespace(st, info)["use"](q["id"])
    assert again.equals(old)


def test_kept_values_are_compressed_and_an_old_plain_one_still_reads(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "tool calls", CALLS)
    assert q["error"] is None
    gz = st.dir / "kept" / "calls.pkl.gz"
    assert gz.exists() and not (st.dir / "kept" / "calls.pkl").exists()
    import pandas as pd

    calls = pd.read_pickle(gz)
    assert len(calls) == sum(1 for r in calls["_ref"] if ".b" in r) > 1000
    plain = st.dir / "kept" / "calls.pkl"
    gz.unlink()
    calls.to_pickle(plain)
    used = Q.run(st, "use the old one", 'len(use("calls"))')
    assert used["table"] == [{"value": len(calls)}]
    # keeping it again writes the compressed one and removes the plain one
    Q.run(st, "keep again", 'keep("calls", use("calls"))')
    assert gz.exists() and not plain.exists()
    gone = Q.run(st, "gone", 'import os\nos.remove("thimble/kept/calls.pkl.gz")\nuse("calls")')
    assert gone["error"] and "lean q --rerun" in gone["error"]


def test_a_packed_lineage_that_does_not_read_says_why_and_how_to_fix_it(root: Path) -> None:
    st = Store(root)
    q = Q.run(st, "tool calls", CALLS)
    p = st.dir / "queries" / f"{q['id']}.json"
    disk = json.loads(p.read_text())
    disk["packed"]["zlib"] = disk["packed"]["zlib"][:200]
    p.write_text(json.dumps(disk))
    got = Q.get(st, q["id"])
    assert got["table"] == q["table"] and got.get("rows") is None
    r = LIN.resolve(st, Q.row_refs(q)[0])
    assert "lean q --rerun" in r["why"]


# ------------------------------------------------------------------ the cache


def _frame(d: Path, key: str, size: int, age_days: float, now: float) -> None:
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{key}.cols").write_bytes(b"x" * size)
    (d / f"{key}.json").write_text("{}")
    t = now - age_days * 86400
    for f in (d / f"{key}.cols", d / f"{key}.json"):
        os.utime(f, (t, t))


def test_the_cache_drops_what_this_kernel_cannot_use_and_stays_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "th"
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    base = home / "lean" / "cache"
    now = time.time()
    here = tmp_path / "here"
    here.mkdir()
    a = base / "here"
    (a / "root").parent.mkdir(parents=True)
    (a / "root").write_text(str(here) + "\n")
    (a / "frames").mkdir()
    (a / "frames" / "0123.pkl").write_bytes(b"old" * 1000)  # an earlier kernel's frame
    (a / "counts.json").write_text("{}")
    _frame(a / "frames2", "new", 4000, 0.1, now)
    _frame(a / "frames2", "older", 4000, 3, now)
    _frame(a / "frames2", "stale", 4000, 30, now)  # unread for a month
    (a / "frames2" / "half.cols").write_bytes(b"x" * 100)  # a write that never finished
    os.utime(a / "frames2" / "half.cols", (now - 7200, now - 7200))
    (a / "frames2" / "x.cols.99.tmp").write_bytes(b"x")
    os.utime(a / "frames2" / "x.cols.99.tmp", (now - 7200, now - 7200))
    gone_root = base / "gone"
    gone_root.mkdir()
    (gone_root / "root").write_text(str(tmp_path / "deleted-folder") + "\n")
    _frame(gone_root / "frames2", "g", 4000, 0.1, now)
    # an earlier kernel's folders hold no note of their folder: one with only row counts goes when it is a month old
    for name, age in (("counts-old", 30), ("counts-new", 1)):
        (base / name).mkdir()
        (base / name / "counts.json").write_text("{}")
        os.utime(base / name / "counts.json", (now - age * 86400, now - age * 86400))
    monkeypatch.setattr(STORE, "CACHE_MAX", 9_000)
    got = STORE.prune_cache(force=True, now=now)
    left = sorted(p.name for p in (a / "frames2").iterdir())
    assert left == ["new.cols", "new.json", "older.cols", "older.json"]
    assert not (a / "frames").exists() and (a / "counts.json").exists() and not gone_root.exists()
    assert not (base / "counts-old").exists() and (base / "counts-new" / "counts.json").exists()
    assert got["files"] >= 8 and got["bytes"] > 11_000
    # over the cap, the least recently read go first
    monkeypatch.setattr(STORE, "CACHE_MAX", 5_000)
    STORE.prune_cache(force=True, now=now)
    assert sorted(p.name for p in (a / "frames2").iterdir()) == ["new.cols", "new.json"]
    # looked over at most once a day, unless a query added frames
    _frame(a / "frames2", "older", 4000, 3, now)
    assert STORE.prune_cache(now=now) == {"files": 0, "bytes": 0}
    assert len(list((a / "frames2").iterdir())) == 4


def test_a_load_marks_its_frames_read_and_a_query_that_adds_frames_prunes(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(Q, "CACHE_MIN", 1_000)
    st = Store(root)
    q = Q.run(st, "records per agent", 'df = load("run0/agent-*.jsonl", fields=["type"])\ndf.groupby("_file").size()')
    assert q["error"] is None
    cache = st.cache / "frames2"
    idx = sorted(cache.glob("*.json"))
    assert len(idx) == 4 and (st.cache / "root").read_text().strip() == str(st.root)
    assert (Path(os.environ["THIMBLE_HOME"]) / "lean" / "cache" / ".pruned").exists()
    old = time.time() - 5 * 86400
    for f in idx:
        os.utime(f, (old, old))
    Q.run(st, "again", 'len(load("run0/agent-00.jsonl", fields=["type"]))')
    fresh = [f for f in idx if f.stat().st_mtime > old + 86400]
    assert len(fresh) == 1


# ------------------------------------------------------------------ objects


def _object(st: Store) -> dict:
    Q.run(st, "tool calls per run and tool", CALLS)
    return O.save(st, "per-run", {"title": "Tool calls", "data": {"calls": "q1", "bash": "q1#run=run0&tool=Bash@n"},
                                  "text": "Bash leads in [run0](q1#run=run0&tool=Bash@n), as [this call](run1/agent-02.jsonl#L5.b1) "
                                          "and [the Edit calls of run1](q1#run=run1&tool=Edit) show."})


def test_an_object_keeps_its_lineage_rows_packed_and_reads_back_the_same(root: Path) -> None:
    st = Store(root)
    obj = _object(st)
    path = st.dir / "objects" / f"{obj['id']}.json"
    disk = json.loads(path.read_text())
    lin = disk["lineage"]
    assert lin["packed"]["format"] == STORE.PACK_FORMAT
    assert all("rowsets" not in x and x["count"] > 0 for x in lin["rows"].values())
    assert all("rows" not in c for c in lin["cites"]) and all("rows" not in b for b in lin["bindings"])
    # the data keeps every row's `_rows`: a card's program reads them
    assert disk["data"] == json.loads(json.dumps(obj["data"]))
    back = O.load(st, obj["id"])
    assert json.dumps(back) == json.dumps(json.loads(json.dumps(obj)))
    # what the observer reads of each citation is the same
    for c, w in zip(lin["cites"], obj["lineage"]["cites"]):
        if "rows" in w:
            assert c["rows_files"] == list(dict.fromkeys(x.split("#")[0] for x in w["rows"]))
    # a version keeps the packed file, and reads back whole
    O.save(st, obj["id"], {"title": "Tool calls, again", "data": {"calls": "q1"}})
    v1 = O.read(st, st.dir / "objects" / ".versions" / obj["id"] / "v1.json")
    assert v1["lineage"] == back["lineage"]


def test_the_observer_reads_a_packed_object_as_it_reads_a_whole_one(root: Path) -> None:
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    st = Store(root)
    obj = _object(st)
    disk = json.loads((st.dir / "objects" / f"{obj['id']}.json").read_text())
    evidence = Path(__file__).resolve().parents[1] / "observer" / "evidence.js"
    script = ("import { slim, digest } from %s; let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => {"
              " const [a, b] = JSON.parse(s); process.stdout.write(JSON.stringify([digest(slim(a)), digest(slim(b))])) })") % json.dumps(evidence.as_uri())
    out = subprocess.run([node, "--input-type=module", "-e", script], input=json.dumps([obj, disk]), capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    whole, packed = json.loads(out.stdout)
    assert "rests on" in whole and whole == packed


def test_row_counts_match_the_observers(root: Path) -> None:
    cases = {"f.jsonl#L4-9,12": 7, "f.jsonl#L12.b1": 1, "db#prs/1-12": 12, "f.jsonl#L3-L9": 7, "notes.md": None,
             "notes.md#Findings": 1, "r.json#/messages/3-7": 5, "t.csv#row=2,4-5": 3}
    for rs, n in cases.items():
        assert STORE._rows_in(rs) == n, rs
    assert STORE._rows_n(["a#L1-3", "b#L2.b0"]) == 4 and STORE._rows_n(["a#L1", "whole.md"]) is None
