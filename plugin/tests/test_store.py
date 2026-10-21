"""How the kernel keeps its records small: a long row lineage packed in the query's record, result tables that keep a
note of their refs instead of the refs, compressed pickles, and a bounded cache. Every ref must resolve to the same
rows, in the same order, as when the record kept them whole."""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import lineage as LIN  # noqa: E402
from kernel import objects as O  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel import refs as R  # noqa: E402
from kernel import store as STORE  # noqa: E402
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
    monkeypatch.setenv("THIMBLE_SESSION", "s-test")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
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


# ------------------------------------------------------------------ the same refs, the same rows


def test_every_ref_resolves_to_the_same_rows_from_a_packed_record_as_from_a_whole_one(root: Path) -> None:
    """The same queries in two copies of a folder: one keeps its records whole (as before), one packed. Every ref of
    every query, whole, by row and by cell, and every value of an object bound to them, resolves the same; and use()
    gives a later query the same table."""
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
    disk = json.loads((root / "thimble" / "queries" / "r1.json").read_text())
    assert "packed" in disk and "rows" not in disk
    for q in got["whole"]:
        _unpack_on_disk(sts["whole"], q["id"])
    assert "rows" in json.loads((other / "thimble" / "queries" / "r1.json").read_text())

    for name, st in sts.items():
        O.save(st, "per-run", {"title": "Tool calls", "data": {"calls": "r1", "bash": "r1#run=run0&tool=Bash@n"},
                               "text": "Bash leads in [run0](r1#run=run0&tool=Bash@n); [a call](run1/agent-02.jsonl#L5.b1)."})
    refs = [r for q in got["packed"] for r in _every_ref(sts["packed"], q)]
    refs += ["obj:01-per-run", "obj:01-per-run#/calls/0", "obj:01-per-run#/calls/3/n", "obj:01-per-run#/bash"]
    a, b = _resolved(sts["packed"], refs), _resolved(sts["whole"], refs)
    assert a.keys() == b.keys()
    for ref in refs:
        assert a[ref] == b[ref], ref
    assert sum(1 for r in a.values() if r["count"]) > 20
    # use() of each result, and of the kept frame, as a later query reads it
    for q in got["packed"]:
        x = Q.run(sts["packed"], "use it", f'use("{q["id"]}")')
        y = Q.run(sts["whole"], "use it", f'use("{q["id"]}")')
        assert x["stdout"] == y["stdout"] and x["rows"] == y["rows"]


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
    assert "thimble run --rerun" in r["why"]


# ------------------------------------------------------------------ the cache


# ------------------------------------------------------------------ objects


def test_records_stay_in_the_folder_the_session_started_in(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # a session started in data/ whose first command is `cd src`: the records go to data/thimble/, not data/src/thimble/
    data = tmp_path / "data"
    (data / "src").mkdir(parents=True)
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    monkeypatch.setenv("THIMBLE_START", str(data))
    (data / "thimble" / "queries").mkdir(parents=True)
    assert STORE.find_root(data / "src") == data.resolve()
    # a stale record folder below the start folder does not split the session's records
    (data / "src" / "thimble" / "queries").mkdir(parents=True)
    assert STORE.find_root(data / "src") == data.resolve()
    # a folder outside the start folder, and a run outside a session, find their records as before
    other = tmp_path / "other"
    (other / "thimble" / "objects").mkdir(parents=True)
    assert STORE.find_root(other) == other.resolve()
    monkeypatch.delenv("THIMBLE_START")
    assert STORE.find_root(data / "src") == (data / "src").resolve()
