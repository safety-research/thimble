"""A file's records on a time axis, for the File browser's Timeline mode (app/source_events.py): the first page of a file
whose records carry a time names its time key, of JSON lines, a CSV file and a JSON document (an ATIF trajectory's
steps, read from its head when it is large), and a file with no times names none; every record with a time comes back
in time order with its ref, its line, its words and its values of the keys that name a kind or a who, never of its time
or of nested values, the records with no time counted; past EVENTS_MAX the answer says it is partial; a time reads from
an ISO stamp or seconds or milliseconds since 1970; the mode's page is the view kit's, loading no URL; a path outside
the corpus is refused."""
import json
import shutil

import pytest
from fastapi.testclient import TestClient

from app import source_events
from app.main import app

client = TestClient(app)
CORPUS = "/api/corpora/timed"


def events(n: int) -> list[dict]:
    return [{
        "ts": f"2026-06-18T20:{i // 60:02d}:{i % 60:02d}Z" if i % 50 != 49 else None,  # every 50th has no time
        "agent": f"a{i % 3}",  # three agents
        "event": "deploy" if i % 2 else "alert",
        "detail": {"host": f"h{i}"},  # nested
        "note": f"step {i} of the run",
    } for i in reversed(range(n))]  # the file holds them latest first


@pytest.fixture()
def timed(tmp_path, monkeypatch, mini_dir):
    from app import config

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "timed")
    root = data / "timed"
    (root / "events.jsonl").write_text("".join(json.dumps(r) + "\n" for r in events(200)))
    (root / "clicks.csv").write_text("time,user,action\n" + "".join(f"2026-06-18 09:{i:02d}:00,u{i % 4},{'view' if i % 3 else 'edit'}\n" for i in range(40)))
    steps = [{"step_id": i, "timestamp": f"2026-09-10T21:58:{i:02d}.000Z", "source": "agent" if i % 2 else "user", "message": f"turn {i}"} for i in range(12)]
    (root / "trajectory.json").write_text(json.dumps({"schema_version": "ATIF-v1.7", "agent": {"name": "x"}, "steps": steps}, indent=2))
    (root / "people.jsonl").write_text("".join(json.dumps({"name": f"p{i}", "team": "ab"[i % 2]}) + "\n" for i in range(20)))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    monkeypatch.setattr(source_events, "_hints", type(source_events._hints)())
    monkeypatch.setattr(source_events, "_events", type(source_events._events)())
    return root


def test_the_first_page_names_the_time_key_of_records_that_carry_one(timed):
    page = lambda path, start=1: client.get(f"{CORPUS}/source", params={"path": path, "start": start, "count": 5}).json()
    assert page("events.jsonl")["time"] == {"key": "ts"}
    assert page("clicks.csv")["time"] == {"key": "time"}
    assert page("trajectory.json")["time"] == {"key": "timestamp"}
    assert "time" not in page("people.jsonl")
    # only the first page says it, which the reader scores its modes by
    assert "time" not in page("events.jsonl", 6)


def test_every_record_with_a_time_in_time_order_with_its_values(timed):
    got = client.get(f"{CORPUS}/source/events", params={"path": "events.jsonl"}).json()
    assert got["time"] == "ts" and got["untimed"] == 4 and got["total"] == 196 and not got["partial"]
    names = [k["key"] for k in got["keys"]]
    # the kinds and the whos, never the time, the words of each record or a nested value
    assert set(names) == {"agent", "event"}
    evs = got["events"]
    assert len(evs) == 196 and [e["t"] for e in evs] == sorted(e["t"] for e in evs)
    first = evs[0]
    # the earliest record is the file's last line
    assert first["ref"] == "events.jsonl#L200" and first["line"] == 200
    # its words: its values but its time and those of the keys shown beside them, nested ones last
    assert first["text"] == 'note: step 0 of the run · detail: {"host": "h0"}'
    assert dict(zip(names, first["v"])) == {"agent": "a0", "event": "alert"}


def test_a_csv_file_s_rows_and_a_json_document_s_records(timed):
    rows = client.get(f"{CORPUS}/source/events", params={"path": "clicks.csv"}).json()
    assert rows["total"] == 40 and rows["events"][0]["ref"] == "clicks.csv#row=1" and rows["events"][0]["line"] == 2
    # a time with no zone reads in UTC
    assert rows["events"][0]["t"] == source_events.secs("2026-06-18T09:00:00Z")
    assert {k["key"] for k in rows["keys"]} == {"user", "action"}
    steps = client.get(f"{CORPUS}/source/events", params={"path": "trajectory.json"}).json()
    assert steps["total"] == 12 and steps["events"][3]["ref"] == "trajectory.json#/steps/3"
    # a transcript's steps by the fields its turns give, as the Transcript mode colors them: no ids
    assert {k["key"] for k in steps["keys"]} == {"source"}


def test_a_large_json_document_names_its_time_key_from_its_head(timed, monkeypatch):
    monkeypatch.setattr(source_events, "HINT_JSON_BYTES", 100)
    page = client.get(f"{CORPUS}/source", params={"path": "trajectory.json", "start": 1, "count": 5}).json()
    assert page["time"] == {"key": "timestamp"}
    assert client.get(f"{CORPUS}/source/events", params={"path": "trajectory.json"}).json()["total"] == 12


def test_past_events_max_the_answer_is_partial(timed, monkeypatch):
    monkeypatch.setattr(source_events, "EVENTS_MAX", 10)
    got = client.get(f"{CORPUS}/source/events", params={"path": "events.jsonl"}).json()
    assert got["partial"] and got["total"] == 10 and len(got["events"]) == 10


def test_a_file_with_no_times_has_no_events_and_a_path_outside_is_refused(timed):
    got = client.get(f"{CORPUS}/source/events", params={"path": "people.jsonl"}).json()
    assert got["time"] is None and got["events"] == []
    assert client.get(f"{CORPUS}/source/events", params={"path": "../x.jsonl"}).status_code == 400


def test_a_time_reads_from_an_iso_stamp_or_seconds_or_milliseconds():
    t = 1781812800.0  # 2026-06-18T20:00:00Z
    assert source_events.secs("2026-06-18T20:00:00Z") == t
    assert source_events.secs("2026-06-18T22:00:00+02:00") == t
    assert source_events.secs("2026-06-18 20:00:00") == t
    assert source_events.secs(t) == t and source_events.secs(t * 1000) == t and source_events.secs(str(int(t))) == t
    for v in ("soon", "18/06/2026", 42, True, None, {"t": t}):
        assert source_events.secs(v) is None


def test_the_mode_s_page_is_the_view_kit_s_and_loads_no_url(timed):
    res = client.get(f"{CORPUS}/source/timeline")
    assert res.status_code == 200
    doc = res.text
    assert "default-src 'none'" in doc and "thimble.timeline(" in doc and "thimble.timeRange(" in doc
    assert "op: 'events'" in doc
