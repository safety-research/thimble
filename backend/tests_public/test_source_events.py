"""A file's records on a time axis, for the File browser's Timeline mode (app/source_events.py): every record with a
time comes back in time order with its ref, its line, its words and its values of the keys that name a kind or a who,
never of its time or of nested values, the records with no time counted; a file with no times has none; a path outside
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


def test_a_file_with_no_times_has_no_events_and_a_path_outside_is_refused(timed):
    got = client.get(f"{CORPUS}/source/events", params={"path": "people.jsonl"}).json()
    assert got["time"] is None and got["events"] == []
    assert client.get(f"{CORPUS}/source/events", params={"path": "../x.jsonl"}).status_code == 400
