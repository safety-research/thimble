"""The telemetry log's durability: logging stays complete across crashes and restarts. Every stored
row carries `seq` (the log's own counter, resumed from the tail after a restart, never reused) and `boot` (ledger.BOOT_ID, one per server process); the browser's per-page-load `seq` is kept
as `client_seq`. A crash is simulated by dropping the in-memory counter and drawing a new boot id (what a new process
has), plus a torn last line (a write cut mid-record): the next append heals the tail, continues the sequence under the
new boot, and `gaps()` shows the batches the browser could not deliver meanwhile as client_seq gaps — with no server
gap, since nothing stored was lost. The batch is fsync'd before the route answers."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import ledger, telemetry

app = FastAPI()  # telemetry's router alone
app.include_router(telemetry.router, prefix="/api")

C = "mini"


@pytest.fixture()
def ws(workspaces_tmp, monkeypatch) -> Path:
    ledger._seqs.clear()
    d = workspaces_tmp / C
    d.mkdir(parents=True, exist_ok=True)
    yield d
    ledger._seqs.clear()


def _rows(p: Path) -> list[dict]:
    out = []
    for ln in p.read_text().splitlines():
        try:
            out.append(json.loads(ln))
        except ValueError:
            out.append({"_torn": ln})
    return out


def _restart(monkeypatch, boot: str) -> None:
    """What a new server process has: no counter in memory, its own boot id."""
    ledger._seqs.clear()
    monkeypatch.setattr(ledger, "BOOT_ID", boot)


# ----------------------------------------------------------------------------- ledger helpers


def test_heal_tail_last_seq_and_next_seq(tmp_path):
    p = tmp_path / "log.jsonl"
    assert ledger.heal_tail(p) is False and ledger.last_seq(p) == -1 and not p.exists()
    p.write_text("")
    assert ledger.heal_tail(p) is False and ledger.last_seq(p) == -1
    ledger.append_jsonl(p, {"seq": 0, "k": "a"})
    ledger.append_jsonl(p, {"seq": 1, "k": "b"})
    assert ledger.heal_tail(p) is False and ledger.last_seq(p) == 1
    with p.open("a") as f:
        f.write('{"seq": 2, "k": "cut off he')  # the crash: no newline, not JSON
    assert ledger.last_seq(p) == 1, "a torn line is never counted"
    assert ledger.heal_tail(p) is True
    assert p.read_text().endswith('he\n') and ledger.heal_tail(p) is False
    ledger.append_jsonl(p, {"seq": 2, "k": "c"})
    rows = _rows(p)
    assert [r.get("seq") for r in rows] == [0, 1, None, 2] and rows[2]["_torn"].startswith('{"seq": 2, "k": "cut')
    assert ledger.last_seq(p) == 2
    # a bool, a float or a string under `seq` is not a seq
    ledger.append_jsonl(p, {"seq": True})
    ledger.append_jsonl(p, {"seq": "9"})
    assert ledger.last_seq(p) == 2
    # next_seq: after the tail, then counting; another process's rows are never overtaken
    ledger._seqs.clear()
    assert ledger.next_seq(p, 3) == 3 and ledger.next_seq(p) == 6
    ledger.append_jsonl(p, {"seq": 40})  # another writer
    assert ledger.next_seq(p) == 41
    ledger._seqs.clear()


def test_append_jsonl_many_sync_flushes_and_fsyncs(tmp_path, monkeypatch):
    p = tmp_path / "s.jsonl"
    synced: list[int] = []
    real = os.fsync
    monkeypatch.setattr(ledger.os, "fsync", lambda fd: synced.append(fd) or real(fd))
    assert ledger.append_jsonl_many(p, [{"a": 1}, {"a": 2}]) == 2 and synced == [], "the default: no fsync"
    assert ledger.append_jsonl_many(p, [{"a": 3}], sync=True) == 1 and len(synced) == 1
    assert ledger.append_jsonl_many(p, [], sync=True) == 0 and len(synced) == 1, "an empty batch opens nothing"
    assert [json.loads(l)["a"] for l in p.read_text().splitlines()] == [1, 2, 3]


# ----------------------------------------------------------------------------- the stored rows


def test_rows_carry_seq_boot_and_the_clients_seq(ws, monkeypatch):
    monkeypatch.setattr(ledger, "BOOT_ID", "b00t0001")
    synced: list[int] = []
    real = os.fsync
    monkeypatch.setattr(ledger.os, "fsync", lambda fd: synced.append(fd) or real(fd))
    client = TestClient(app)
    url = f"/api/ws/{C}/telemetry"
    r = client.post(url, json=[{"kind": "page-load", "seq": 0}, {"kind": "tab-activate", "target": "panel:files", "seq": 1}],
                    headers={"X-Thimble-Session": "pageA"})
    assert r.status_code == 201 and r.json() == {"recorded": 2}
    assert len(synced) == 1, "one fsync per batch, before the answer"
    assert client.post(url, json={"kind": "undo", "seq": -1}).status_code == 400
    assert client.post(url, json={"kind": "undo", "seq": 1.5}).status_code == 400
    assert client.post(url, json={"kind": "undo", "seq": True}).status_code == 400
    assert client.post(url, json={"kind": "undo", "seq": "3"}).status_code == 400
    r = client.post(url, json={"kind": "undo"})  # a client without a counter (an older page, curl): no client_seq
    assert r.status_code == 201
    rows = _rows(ws / telemetry.LOG_NAME)
    assert [r["seq"] for r in rows] == [0, 1, 2]
    assert {r["boot"] for r in rows} == {"b00t0001"}
    assert list(rows[0])[:3] == ["ts", "seq", "boot"], "the stamps lead the row"
    assert rows[0]["client_seq"] == 0 and rows[1]["client_seq"] == 1 and "client_seq" not in rows[2]
    assert rows[0]["session"] == rows[1]["session"] == "pageA"
    # the new kinds and the `ui` target kind
    r = client.post(url, json=[{"kind": "ui-click", "target": "ui:files-refresh", "detail": {"name": "files-refresh", "tag": "button", "panel": "files"}},
                               {"kind": "ui-select", "target": "ui:report", "detail": {"length": 42, "panel": "report"}}])
    assert r.status_code == 201
    rows = _rows(ws / telemetry.LOG_NAME)
    assert rows[3]["target_kind"] == "ui" and rows[4]["target_kind"] == "ui" and rows[4]["seq"] == 4
    # the export still reads every row (the extra fields ride in nothing but the raw log)
    exp = client.get(f"/api/ws/{C}/telemetry/export?form=standard&format=jsonl")
    kinds = [json.loads(l)["kind"] for l in exp.text.splitlines()]
    assert kinds[:5] == ["page-load", "tab-activate", "undo", "ui-click", "ui-select"]
    anon = client.get(f"/api/ws/{C}/telemetry/export?form=anonymized&format=jsonl").text
    assert "b00t0001" not in anon and "files-refresh" not in anon


def test_a_crash_mid_write_and_a_restart_keep_the_sequence_and_show_the_lost_batches(ws, monkeypatch):
    """The scenario of the module docstring, end to end on the route."""
    _restart(monkeypatch, "boot0001")
    client = TestClient(app)
    url = f"/api/ws/{C}/telemetry"
    hdr = {"X-Thimble-Session": "pageA"}
    for i in range(3):
        assert client.post(url, json={"kind": "undo", "seq": i}, headers=hdr).status_code == 201
    p = ws / telemetry.LOG_NAME
    # the crash: the process dies while writing its next batch — a fragment without a newline is what stays
    with p.open("a", encoding="utf-8") as f:
        f.write('{"ts": "2026-09-11T10:00:09+00:00", "seq": 3, "boot": "boot0001", "kind": "cell-run", "session": "pageA", "client_s')
    # the server is down for a while: the page's batches with client seq 3, 4, 5 never arrive; the page keeps counting
    _restart(monkeypatch, "boot0002")
    r = client.post(url, json=[{"kind": "search", "seq": 6}, {"kind": "undo", "seq": 7}], headers=hdr)
    assert r.status_code == 201
    # a second page load in the same tab, then the server restarts once more with nothing lost
    assert client.post(url, json={"kind": "page-load", "seq": 0}, headers={"X-Thimble-Session": "pageB"}).status_code == 201
    _restart(monkeypatch, "boot0003")
    assert client.post(url, json={"kind": "undo", "seq": 1}, headers={"X-Thimble-Session": "pageB"}).status_code == 201

    rows = _rows(p)
    # the fragment carried seq 3 but was never a stored row (the tail reader counts parseable lines only), so 3 is the
    # next seq handed out: the stored sequence is 0, 1, 2, 3, 4, 5, 6 with the fragment between 2 and 3
    assert [r.get("seq") for r in rows] == [0, 1, 2, None, 3, 4, 5, 6]
    assert rows[3].get("_torn", "").startswith('{"ts"'), "the torn fragment stays as the crash left it, terminated"
    assert [r["boot"] for r in rows if "boot" in r] == ["boot0001"] * 3 + ["boot0002"] * 3 + ["boot0003"]
    assert [r.get("client_seq") for r in rows if "client_seq" in r] == [0, 1, 2, 6, 7, 0, 1]
    assert all(l.endswith("}") or l.endswith("_s") for l in p.read_text().splitlines()), "every stored line is whole; the fragment was terminated, not glued to the next row"

    g = telemetry.gaps(ws)
    assert [b["boot"] for b in g["boots"]] == ["boot0001", "boot0002", "boot0003"]
    assert [(b["first_seq"], b["last_seq"], b["rows"]) for b in g["boots"]] == [(0, 2, 3), (3, 5, 3), (6, 6, 1)]
    assert g["server_gaps"] == [], "a restart loses no stored row: the server sequence is unbroken"
    assert g["client_gaps"] == {"pageA": [[2, 6]]}, "the browser's rows 3, 4 and 5 never arrived while the server was down"
    assert g["unparseable"] == 1, "the one torn fragment"
    # a row that vanished from the file (a lost tail beyond the fragment) is a server gap
    lines = p.read_text().splitlines()
    del lines[5]  # seq 4
    p.write_text("\n".join(lines) + "\n")
    g2 = telemetry.gaps(ws)
    assert g2["server_gaps"] == [[3, 5]]
    # no file: nothing
    assert telemetry.gaps(ws / "nowhere") == {"boots": [], "server_gaps": [], "client_gaps": {}, "unparseable": 0}


def test_record_heals_a_torn_tail_before_it_appends(ws, monkeypatch):
    p = ws / telemetry.LOG_NAME
    p.write_text('{"ts": "t", "seq": 0, "boot": "x", "kind": "undo"}\n{"ts": "t", "seq": 1, "boot": "x", "kind": "un')
    assert telemetry.record(C, [{"actor": "analyst", "session": None, "kind": "undo", "target": None, "target_kind": None,
                                 "detail": None, "duration_ms": None}]) == 1
    lines = p.read_text().splitlines()
    assert len(lines) == 3 and lines[1] == '{"ts": "t", "seq": 1, "boot": "x", "kind": "un', "the fragment, terminated, on its own line"
    assert json.loads(lines[2])["seq"] == 1, "the torn row's seq was never stored, so it is the next one handed out"
    assert telemetry.record(C, []) == 0


def test_concurrent_batches_never_share_a_seq_and_land_in_seq_order(ws, monkeypatch):
    """The route runs `record` in a threadpool, so two batches can be numbered at once (a flush and a retry, two
    tabs): under ledger.seq_lock the heal, the numbering and the append are one step per batch — every seq is issued
    once and the file's order is the seq order. The tail read is slowed so an unlocked counter would interleave."""
    import threading
    import time

    real_last = ledger.last_seq

    def slow_last(path, key="seq"):
        time.sleep(0.005)
        return real_last(path, key)

    monkeypatch.setattr(ledger, "last_seq", slow_last)
    row = {"actor": "analyst", "session": "s", "kind": "undo", "target": None, "target_kind": None, "detail": None, "duration_ms": None}
    n_threads, per = 8, 5
    start = threading.Barrier(n_threads)

    def worker():
        start.wait()
        for _ in range(per):
            telemetry.record(C, [dict(row), dict(row)])

    threads = [threading.Thread(target=worker) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    seqs = [r["seq"] for r in _rows(ws / telemetry.LOG_NAME)]
    assert len(seqs) == n_threads * per * 2
    assert seqs == list(range(len(seqs))), "each seq once, contiguous, in file order"
    assert telemetry.gaps(ws)["server_gaps"] == []
