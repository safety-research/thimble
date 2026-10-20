"""A query whose lineage fails keeps its output and says why in one line, rather than failing silently.
Run: THIMBLE_PYTHON-or-any-python-with-pandas -m pytest plugin/tests"""
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
    monkeypatch.setenv("THIMBLE_SESSION", "s-gaps")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    return d


# ------------------------------------------------------------------ an index the kernel reads back


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
    assert r["why"] == (f"thimble could not find the rows behind {q['id']}'s output (KeyError: 'index'), so its values keep "
                        "no rows: tally() in the query keeps them per row")
    # the query as a whole still opens every row it read
    assert LIN.resolve(st, q["id"])["count"] == 40


# ------------------------------------------------------------------ whole JSON documents

# made-up chat logs, one JSON document per agent: messages keyed by id, as some exports write them
# ------------------------------------------------------------------ outputs whose key is a number, or a table of records


# ------------------------------------------------------------------ row sets of transcript blocks



