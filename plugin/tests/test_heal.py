"""The citation healing pass (kernel/heal.py): re-point, unwrap, contradicted, and the version guard."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import heal as H  # noqa: E402
from kernel import query as Q  # noqa: E402
from kernel.store import Store  # noqa: E402

DAYS = ["2026-06-01"] * 3 + ["2026-06-02"] * 5 + ["2026-06-03"] * 2


@pytest.fixture()
def st(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Store:
    d = tmp_path / "data"
    d.mkdir()
    with open(d / "saves.jsonl", "w") as f:
        for i, day in enumerate(DAYS):
            f.write(json.dumps({"id": i, "day": day, "user": "wren" if i < 7 else "kestrel"}) + "\n")
    (d / "notes.md").write_text("# Notes\nthe swarm stalled\n")
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "th"))
    monkeypatch.setenv("THIMBLE_SESSION", "s-test")
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    monkeypatch.chdir(d)
    s = Store(d)
    Q.run(s, "saves per day", 'df = load("saves.jsonl")\ndf.groupby("day").size().rename("n")')  # r1: 3, 5, 2
    Q.run(s, "saves per user", 'df = load("saves.jsonl")\ntally(df, "user")')  # r2: wren 7, kestrel 3
    return s


def one(st: Store, text: str, **kw) -> tuple[str, dict]:
    r = H.heal(st, text, **kw)
    assert len(r.changes) == 1
    return r.text, r.changes[0].record()


def test_a_citation_that_holds_is_kept(st: Store) -> None:
    text, c = one(st, "June 2 had [5](r1#day=2026-06-02@n) saves.")
    assert c["state"] == H.LINKED and c["how"] == H.KEPT
    assert text == "June 2 had [5](r1#day=2026-06-02@n) saves."


def test_repoint_inside_the_cited_query(st: Store) -> None:
    # 5 is not on June 1 (3), and only June 2's row holds it in the cited column
    text, c = one(st, "The busiest day had [5](r1#day=2026-06-01@n) saves.")
    assert c["state"] == H.LINKED and c["how"] == H.CELL
    assert c["to"] == "r1#day=2026-06-02@n"
    assert text == "The busiest day had [5](r1#day=2026-06-02@n) saves."


def test_unwrap_when_the_place_is_gone(st: Store) -> None:
    text, c = one(st, "There were [12](r9#day=2026-06-01@n) saves.")
    assert c["state"] == H.QUIET and c["how"] == H.GONE and "to" not in c
    assert text == "There were 12 saves."
    # words that name a place that does not exist: unwrapped too
    text, c = one(st, "As [the notes](notes2.md#L2) say.")
    assert text == "As the notes say." and c["state"] == H.QUIET
    # a source row that exists is kept
    text, c = one(st, "As [the notes](notes.md#L2) say.")
    assert c["how"] == H.KEPT


def test_the_analysts_citation_is_never_unwrapped(st: Store) -> None:
    text, c = one(st, "There were [12](r9#day=2026-06-01@n) saves.", analyst=True)
    assert c["state"] == H.QUIET and text == "There were [12](r9#day=2026-06-01@n) saves."


def test_contradicted_when_the_cited_place_holds_another_number(st: Store) -> None:
    text, c = one(st, "June 1 had [4](r1#day=2026-06-01@n) saves.")
    assert c["state"] == H.CONTRADICTED and c["source"] == "3"
    assert c["why"] == "the cited place shows 3"
    assert text == "June 1 had [4](r1#day=2026-06-01@n) saves."  # the words and the link stay


def test_any_number_in_the_words_and_a_scale(st: Store) -> None:
    # r3: saves by the first two digits of a made-up address, 20 -> 1,170,232 and 21 -> 501,528
    Q.run(st, "saves by first", 'df = load("saves.jsonl")\n'
          '(df.assign(first=(df["id"] >= 7) + 20).groupby("first").size() * 167176).rename("n")')
    for words in ["addresses starting with 20.", "1.17M saves", "1,170,232 of the 1,671,760 saves",
                  "1.2 million", "saves from 20. (1,170k)"]:
        text, c = one(st, f"Most came from [{words}](r3#first=20@n).")
        assert (c["state"], c["how"]) == (H.LINKED, H.KEPT), words
    text, c = one(st, "Then [501.5k](r3#first=21@n).")
    assert c["how"] == H.KEPT
    # a wrong number is still caught, with or without a scale
    for words in ["1.18M saves", "9,000 from 20."]:
        text, c = one(st, f"Most came from [{words}](r3#first=20@n).")
        assert c["state"] == H.CONTRADICTED and c["source"] == "1,170,232", words


def test_a_path_written_from_a_subfolder(st: Store) -> None:
    # a session that ran `cd app` cites src/main.py: the one file under the root whose path ends with it
    for rel in ["app/src/main.py", "a/lib/util.py", "b/lib/util.py"]:
        (st.root / rel).parent.mkdir(parents=True, exist_ok=True)
        (st.root / rel).write_text("import os\nprint(os.sep)\n")
    text, c = one(st, "It [prints the separator](src/main.py#L2).")
    assert (c["state"], c["how"], c["to"]) == (H.LINKED, H.PATH, "app/src/main.py#L2")
    assert text == "It [prints the separator](app/src/main.py#L2)."
    # two files end with the path: the failure line names them
    text, c = one(st, "It [imports os](lib/util.py#L1).", analyst=True)
    assert c["state"] == H.QUIET and c["how"] == H.GONE
    assert "2 files end with /lib/util.py: a/lib/util.py, b/lib/util.py" in c["why"]


def test_versioning(st: Store) -> None:
    text = "The busiest day had [5](r1#day=2026-06-01@n) saves, and [12](r9@n) in all."
    r = H.heal(st, text)
    assert r.of == H.version(st, text) and r.version == H.version(st, r.text) and r.of != r.version
    # the pass's own text heals to itself, so its edits never start it again
    again = H.heal(st, r.text)
    assert again.text == r.text and all(c.how == H.KEPT for c in again.changes)
    # a caller that keeps both versions skips either
    out = H.heal_all(st, [text, r.text], since=[r.of, r.version])
    assert out == [{"skip": True, "of": r.of, "version": r.of}, {"skip": True, "of": r.version, "version": r.version}]
    # a re-run of a cited query is a new version
    q = st.read_json(st.dir / "queries" / "r1.json")
    q["t"] = q["t"] + 1
    st.write_json(st.dir / "queries" / "r1.json", q)
    assert H.version(st, text) != r.of


def test_the_command_reads_texts_and_writes_json(st: Store) -> None:
    env = {"THIMBLE_SESSION": "s-test", "PATH": "/usr/bin:/bin", "HOME": str(st.root.parent), "THIMBLE_HOME": str(st.root.parent / "th")}
    p = subprocess.run([sys.executable, str(ENGINE / "thimble.py"), "heal"], input=json.dumps({"texts": ["[4](r1#day=2026-06-01@n)", "plain"]}),
                       capture_output=True, text=True, cwd=st.root, env=env, timeout=60)
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    assert out[0]["changes"][0]["state"] == "contradicted" and out[1]["changes"] == []
    assert "heal" not in subprocess.run([sys.executable, str(ENGINE / "thimble.py"), "--help"], capture_output=True, text=True, env=env).stdout


def test_a_number_in_a_key_name_or_a_column_name_is_not_the_value(st: Store) -> None:
    # the 20 is part of the column name from_20 (and of the row's name), not the count the row holds
    Q.run(st, "edits from 20.x", 'df = load("saves.jsonl")\ndf["from_20"] = df.id.map(lambda i: "yes" if i < 6 else "no")\ntally(df, "from_20")')
    text, c = one(st, "Most came from [addresses starting with 20.](r3#from_20=yes@n).")
    assert c["state"] == H.LINKED and c["how"] == H.KEPT
    # words that are only a number state the value: a day's part in a key does not hide a wrong count
    text, c = one(st, "June 1 had [1](r1#day=2026-06-01@n) saves.")
    assert c["state"] == H.CONTRADICTED and c["source"] == "3"


def test_a_query_named_in_the_words_is_no_number(st: Store) -> None:
    # r1 holds 2 and 5, r2 holds 7 and 3: the words r1, r2 name the queries, so nothing is re-pointed
    r = H.heal(st, "By day ([r1](r1)) and by user ([r2](r2)).")
    assert [(c.state, c.how, c.to) for c in r.changes] == [(H.LINKED, H.KEPT, "r1"), (H.LINKED, H.KEPT, "r2")]
    assert r.text == "By day ([r1](r1)) and by user ([r2](r2))."


def test_a_mistyped_file_path_is_moved_only_to_a_file(st: Store) -> None:
    d = st.root / "session-data"
    d.mkdir()
    (d / "1a2b3c4d-0fa5-4903-8f38-b8fbbb218913.jsonl").write_text(
        json.dumps({"text": "start"}) + "\n" + json.dumps({"text": "training has been done for 20 minutes"}) + "\n")
    (d / "9f9f9f9f-0000-0000-0000-000000000000.jsonl").write_text(json.dumps({"text": "20 rows"}) + "\n" * 2)
    # a query the text cites holds 20 too: it is never where a file citation goes
    Q.run(st, "twenty", 'import pandas as pd\npd.DataFrame({"run": ["a"], "minutes": [20]})')
    text = ("The run waited [~20 minutes](session-data/1a2b3c4d-0fa5-4903-8f38-b5e0b1d1b55b.jsonl#L2) "
            "after [its last job](r3#run=a@minutes).")
    r = H.heal(st, text)
    c = r.changes[0]
    assert (c.state, c.how, c.to) == (H.LINKED, H.PATH, "session-data/1a2b3c4d-0fa5-4903-8f38-b8fbbb218913.jsonl#L2")
    # no file beside it fits (the line is past its end): it is gone, with its reason, and never moved to the query
    r = H.heal(st, text.replace("#L2", "#L9"))
    c = r.changes[0]
    assert (c.state, c.how, c.to) == (H.QUIET, H.GONE, None)
    assert c.why.startswith("the cited place is gone (no file session-data/1a2b3c4d-0fa5-4903-8f38-b5e0b1d1b55b.jsonl")
    assert str(st.root) not in c.why
    # a line that does not exist in the right file: gone too, never a query cell
    _, c = one(st, "It took [20 minutes](notes.md#L40).")
    assert (c["state"], c["how"]) == (H.QUIET, H.GONE) and "to" not in c
