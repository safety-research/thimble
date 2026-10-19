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
