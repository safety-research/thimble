"""Values a query shows only in what it printed (kernel/shown.py): where resolve finds them, and how the healing pass
checks dates."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import heal as H  # noqa: E402
from kernel import lineage as LIN  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel import shown as SW  # noqa: E402
from kernel.store import Store  # noqa: E402

TIMES = ["2025-04-02T08:12:00", "2025-04-20T10:00:00", "2025-05-03T09:00:00", "2025-05-04T09:00:00", "2026-09-18T21:40:11"]
CODE = ('df = load("chat.jsonl")\nt = df.assign(month=df.created_at.str[:7]).groupby("month").size().rename("n")\n'
        'print(len(df), df.created_at.min(), df.created_at.max())\nprint("characters:", df.created_at.str.len().sum())\nt')


@pytest.fixture()
def st(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Store:
    d = tmp_path / "data"
    d.mkdir()
    with open(d / "chat.jsonl", "w") as f:
        for i, t in enumerate(TIMES):
            f.write(json.dumps({"id": i, "created_at": t, "speaker": "agent" if i < 4 else "human"}) + "\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-test")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    monkeypatch.chdir(d)
    s = Store(d)
    Q.run(s, "messages per month", CODE)  # r1
    return s


def test_dates_in_the_forms_people_write() -> None:
    got = [d for _, _, d in SW.dates("from 2 April 2025 to Sept. 18, 2026, in May 2025, on 2025-04-02 08:12")]
    assert got == [(2025, 4, 2), (2026, 9, 18), (2025, 5, None), (2025, 4, 2)]
    assert "2025" not in SW.without_dates("from 2 April 2025")


def test_resolve_finds_dates_the_query_only_printed(st: Store) -> None:
    r = LIN.resolve(st, "r1", n=0, label="2 April 2025 to 18 September 2026")
    sh = r["shown"]
    assert sh["missing"] == [] and sh["rows"] == []
    assert sh["lines"] and sh["lines"][0]["n"] == 1
    line = sh["lines"][0]
    assert [line["text"][a:b] for a, b in line["at"]] == ["2025-04-02", "2026-09-18"]


def test_resolve_finds_the_rows_that_hold_a_month(st: Store) -> None:
    r = LIN.resolve(st, "r1", n=0, label="September 2026")
    table = Q.get(st, "r1")["table"]
    assert [table[i]["month"] for i in r["shown"]["rows"]] == ["2026-09"]


def test_the_check_keeps_dates_the_query_printed(st: Store) -> None:
    c = H.heal(st, "The data runs from [2 April 2025 to 18 September 2026](r1).").changes[0]
    assert c.state == H.LINKED and c.how == H.KEPT


def test_the_check_finds_dates_the_query_shows_nowhere_wrong(st: Store) -> None:
    c = H.heal(st, "The data runs from [1 March 2025 to 18 September 2026](r1).").changes[0]
    assert c.state == H.CONTRADICTED
    assert c.why == "r1 does not show 1 March 2025"
    # a day the query shows only as its month is not shown
    c = H.heal(st, "The data starts on [3 April 2025](r1).").changes[0]
    assert c.state == H.CONTRADICTED and c.why == "r1 does not show 3 April 2025"


def test_the_check_keeps_a_number_the_query_printed(st: Store) -> None:
    # 95 is in no row of its output and is no total of it: only its printed text holds it
    c = H.heal(st, "The times take [95 characters](r1).").changes[0]
    assert c.state == H.LINKED and c.how == H.KEPT
    sh = LIN.resolve(st, "r1", n=0, label="95 characters")["shown"]
    assert [x["n"] for x in sh["lines"]] == [2]
