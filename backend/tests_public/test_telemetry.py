"""telemetry.py: POST /ws/{c}/telemetry (the browser's user actions, validated) and GET /ws/{c}/telemetry/export (the
view log, telemetry.jsonl and the user-action events merged in time order, standard or anonymized, JSONL or CSV). The
workspace is built by hand under a temp WORKSPACES_DIR with the synthetic corpus `mini`."""
from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config, telemetry, viewlog

app = FastAPI()  # telemetry's router alone
app.include_router(telemetry.router, prefix="/api")

C = "mini"
T = [f"2026-03-01T10:{m:02d}:00+00:00" for m in range(0, 60)]
FILE = "agents/agent-03.jsonl"
UNKNOWN = ("no-such-action", "submit", "Card-Run", "card run")
KNOWN = ("start-toggle", "start-run", "agent-row-expand", "chip-teleport", "pointer-open", "pointer-send", "thread-open",
         "thread-switch", "filter-set", "filter-clear", "card-run", "card-code-toggle", "card-fold", "report-drag-cell",
         "report-frame-edit", "rewrite-span", "prompt-cell", "view-build")


def _jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


@pytest.fixture()
def ws(workspaces_tmp, monkeypatch):
    """A workspace with rows in every export source, at known minutes (T[m] = 10:mm). Returns its dir."""
    viewlog._recent.clear()
    viewlog._rows_cache.clear()
    w = workspaces_tmp / C
    _jsonl(w / "investigations" / "main" / "events.jsonl", [
        {"ts": T[0], "seq": 0, "type": "orient", "status": "started", "run": 1},
        {"ts": T[0], "seq": 1, "type": "cell", "notebook": "main", "cell": "c0", "kind": "ran"},
        {"ts": T[4], "seq": 2, "type": "chat", "chat": "main"},
        {"ts": T[6], "seq": 3, "type": "report", "slug": "report", "status": "generating", "by": "analyst"},
        {"ts": T[7], "seq": 4, "type": "report", "slug": "report", "status": "generated"},
        {"ts": T[8], "seq": 5, "type": "ticket", "id": "abcd1234", "n": 1, "status": "queued"},
        {"ts": T[8], "seq": 6, "type": "ticket", "id": "abcd1234", "n": 1, "status": "running"},
        {"ts": T[12], "seq": 7, "type": "filter", "scope": "canvas", "concept": "k1", "value": "yes"},
        {"ts": T[13], "seq": 8, "type": "view", "slug": "graph", "status": "building"},
        {"ts": T[14], "seq": 9, "type": "view", "slug": "graph", "status": "built", "path": "views/graph"},
    ])
    _jsonl(w / viewlog.LOG_NAME, [{"ts": T[2], "actor": "analyst", "by": "browser", "path": FILE, "kind": "file"},
                                  {"ts": T[3], "actor": "analyst", "by": "browser", "path": "agents", "kind": "dir"},
                                  {"ts": T[9], "actor": "model", "by": "main", "path": FILE, "kind": "file", "tool": "Read"}])
    _jsonl(w / telemetry.LOG_NAME, [{"ts": T[11], "actor": "analyst", "session": "sess-A", "kind": "search", "target": "agents",
                                     "target_kind": "dir", "detail": {"text": "alpha 42", "kind": "content", "results": 3},
                                     "duration_ms": 120, "client_ts": T[11]}])
    return w


def _rows(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []


# ----------------------------------------------------------------------------- POST /telemetry


def test_post_validates_kinds_sizes_and_batches(ws):
    client = TestClient(app)
    url = f"/api/ws/{C}/telemetry"
    assert client.post(url, json={"kind": "made-up"}).status_code == 400
    assert client.post(url, json={"kind": "search", "detail": {"text": "x" * 3000}}).status_code == 400
    assert client.post(url, json={"kind": "search", "detail": "not an object"}).status_code == 400
    assert client.post(url, json={"kind": "search", "target": "a" * 600}).status_code == 400
    assert client.post(url, json={"kind": "search", "target_kind": "free text"}).status_code == 400
    assert client.post(url, json={"kind": "cell-run", "duration_ms": -5}).status_code == 400
    assert client.post(url, json={"kind": "cell-run", "session": "bad session!"}).status_code == 400
    assert client.post(url, json={"kind": "cell-run", "ts": "yesterday"}).status_code == 400
    assert client.post(url, json=[]).status_code == 400
    assert client.post(url, json=[{"kind": "undo"}] * (telemetry.BATCH_MAX + 1)).status_code == 400
    assert client.post(url, json=[{"kind": "undo"}, {"kind": "nope"}]).status_code == 400
    assert len(_rows(ws / telemetry.LOG_NAME)) == 1, "one bad row rejects the whole batch: nothing written"
    assert client.post("/api/ws/no-such-corpus/telemetry", json={"kind": "undo"}).status_code == 404

    r = client.post(url, json={"kind": "card-run", "target": "card:c1", "duration_ms": 1234.6, "ts": T[20],
                               "detail": {"group": "g1", "status": "ok"}}, headers={"X-Thimble-Session": "sess-B"})
    assert r.status_code == 201 and r.json() == {"recorded": 1}
    r = client.post(url, json=[{"kind": "panel-open", "target": "panel:files", "session": "sess-C"},
                               {"kind": "search", "target": "agents/", "detail": {"text": "alpha"}},
                               {"kind": "chip-teleport", "target": "group:g2"},
                               {"kind": "report-open", "target": "report:slides"}])
    assert r.status_code == 201 and r.json() == {"recorded": 4}
    rows = _rows(ws / telemetry.LOG_NAME)[1:]
    assert [r["kind"] for r in rows] == ["card-run", "panel-open", "search", "chip-teleport", "report-open"]
    first = rows[0]
    assert first["actor"] == "analyst" and first["session"] == "sess-B" and first["client_ts"] == T[20]
    assert first["duration_ms"] == 1235 and first["target_kind"] == "cell" and first["detail"] == {"group": "g1", "status": "ok"}
    assert telemetry.parse_ts(first["ts"]) is not None and first["ts"] != T[20], "the server's clock, not the client's"
    assert rows[1]["session"] == "sess-C" and rows[1]["target_kind"] == "panel"
    assert rows[2]["session"] is None and rows[2]["target_kind"] == "file" and "client_ts" not in rows[2]
    assert rows[3]["target_kind"] == "group" and rows[4]["target_kind"] == "report"


def test_kinds_are_a_closed_vocabulary(ws):
    for k in telemetry.KINDS | telemetry.TARGET_KINDS:
        assert telemetry.VOCAB_RE.match(k), k
    for k in KNOWN:
        assert k in telemetry.KINDS, k
    for k in UNKNOWN:
        assert k not in telemetry.KINDS, k
    assert telemetry.target_kind_of("card:c1") == "cell"
    assert telemetry.target_kind_of("group:g1") == "group"
    assert telemetry.target_kind_of("report:report#s3") == "report"
    assert telemetry.target_kind_of("board.jsonl#L1") == "file"
    assert telemetry.target_kind_of("dir:agents") == "dir"
    assert telemetry.target_kind_of("concept:abc") == "concept"
    assert telemetry.target_kind_of("") is None and telemetry.target_kind_of(None) is None
    assert telemetry.target_kind_of("something") == "other"
    http = TestClient(app)
    url = f"/api/ws/{C}/telemetry"
    r = http.post(url, json=[{"kind": k, "target": "card:c1"} for k in KNOWN])
    assert r.status_code == 201 and r.json() == {"recorded": len(KNOWN)}
    for k in UNKNOWN:
        assert http.post(url, json={"kind": k}).status_code == 400, k


# ----------------------------------------------------------------------------- GET /telemetry/export, standard


def test_a_document_a_model_saved_itself_is_the_models_in_the_export(ws):
    """The write_document tool saves a document the analyst's session wrote: its `generated` event names the session,
    and the export says the model made it, where a Write's generation is the server's (system)."""
    events = ws / "investigations" / "main" / "events.jsonl"
    with events.open("a") as f:
        for seq, slug, by in ((10, "report", "terminal"), (11, "story", "chat:main")):
            f.write(json.dumps({"ts": T[15], "seq": seq, "type": "report", "slug": slug, "status": "generated", "by": by}) + "\n")
    rows = [json.loads(l) for l in TestClient(app).get(f"/api/ws/{C}/telemetry/export").text.splitlines()]
    mine = [(r["target"], r["actor"]) for r in rows if r["kind"] == "report-generated"]
    assert ("report:report", "model") in mine and ("report:story", "model") in mine
    assert ("report:report", "system") in mine, "the fixture's Write is still the server's"


def test_export_merges_the_three_sources_in_time_order(ws):
    client = TestClient(app)
    r = client.get(f"/api/ws/{C}/telemetry/export")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")
    assert r.headers["content-disposition"] == f'attachment; filename="{C}-telemetry.jsonl"'
    rows = [json.loads(l) for l in r.text.splitlines()]
    assert all(tuple(row.keys()) == telemetry.SCHEMA for row in rows)
    got = [(row["ts"][11:16], row["source"], row["kind"], row["actor"]) for row in rows]
    assert got == [
        ("10:00", "event", "orient-start", "analyst"),
        ("10:02", "view", "view", "analyst"),
        ("10:03", "view", "view", "analyst"),
        ("10:06", "event", "report-request", "analyst"),
        ("10:07", "event", "report-generated", "system"),
        ("10:08", "event", "dev-ticket", "analyst"),  # the filing; the running status is the runner's
        ("10:09", "view", "view", "model"),
        ("10:11", "telemetry", "search", "analyst"),
        ("10:12", "event", "filter-set", "analyst"),
        ("10:13", "event", "view-build", "analyst"),  # built is the outcome of the build job, not an action
    ]
    by_kind = {row["kind"]: row for row in rows}
    assert by_kind["orient-start"]["target"] == "orient:1" and by_kind["orient-start"]["detail"] == {"status": "started", "run": 1}
    assert by_kind["report-request"]["target"] == "report:report" and by_kind["report-request"]["detail"]["by"] == "analyst"
    assert by_kind["dev-ticket"]["target"] == "ticket:abcd1234" and by_kind["dev-ticket"]["detail"] == {"id": "abcd1234", "n": 1, "status": "queued"}
    assert by_kind["filter-set"]["target"] == "concept:k1" and by_kind["filter-set"]["detail"]["scope"] == "canvas"
    assert by_kind["view-build"]["target"] == "view:graph" and by_kind["view-build"]["target_kind"] == "view"
    v = rows[1]
    assert v["target"] == FILE and v["target_kind"] == "file" and v["detail"] == {"by": "browser"} and v["session"] is None
    assert rows[6]["detail"] == {"by": "main", "tool": "Read"}
    s = by_kind["search"]
    assert s["target"] == "agents" and s["target_kind"] == "dir" and s["duration_ms"] == 120 and s["session"] == "sess-A"
    assert s["detail"] == {"text": "alpha 42", "kind": "content", "results": 3, "client_ts": T[11]}
    assert _rows(ws / telemetry.LOG_NAME) == _rows(ws / telemetry.LOG_NAME)[:1], "the export writes no row of its own"
    again = [json.loads(l) for l in client.get(f"/api/ws/{C}/telemetry/export").text.splitlines()]
    assert len(again) == len(rows)


def test_export_validates_its_parameters_and_the_corpus(ws):
    client = TestClient(app)
    assert client.get(f"/api/ws/{C}/telemetry/export?form=plain").status_code == 400
    assert client.get(f"/api/ws/{C}/telemetry/export?format=xlsx").status_code == 400
    assert client.get("/api/ws/no-such-corpus/telemetry/export").status_code == 404


def test_empty_workspace_exports_nothing(workspaces_tmp, monkeypatch):
    viewlog._recent.clear()
    viewlog._rows_cache.clear()
    client = TestClient(app)
    assert client.get(f"/api/ws/{C}/telemetry/export?format=csv&form=anonymized").text == ",".join(telemetry.SCHEMA) + "\n"
    assert client.get(f"/api/ws/{C}/telemetry/export").text == ""


# ----------------------------------------------------------------------------- the anonymized form

RAW = [FILE, "agents", "agent-03", "alpha", "abcd1234", "sess-A", "k1", "graph", "2026-03-01", "10:0", "browser",
       "Read", "content", "results", "client_ts", C]
TOKEN = re.compile(r"^h:[0-9a-f]{16}$")


def _assert_clean(text: str) -> None:
    residue = re.sub(r"h:[0-9a-f]{16}", "TOKEN", text)
    for raw in RAW:
        assert raw not in residue, raw
    assert "/" not in text and "#" not in text and ".json" not in text
    assert not re.search(r"\d{4}-\d{2}-\d{2}", text)
    assert not re.search(r"[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}", text)


def test_anonymized_jsonl_has_no_paths_text_ids_or_clock_and_stable_hashes(ws):
    client = TestClient(app)
    r = client.get(f"/api/ws/{C}/telemetry/export?form=anonymized")
    assert r.status_code == 200
    assert r.headers["content-disposition"] == 'attachment; filename="telemetry-anonymized.jsonl"'
    _assert_clean(r.text)
    rows = [json.loads(l) for l in r.text.splitlines()]
    assert len(rows) == 10 and all(tuple(row.keys()) == telemetry.SCHEMA for row in rows)
    ts = [row["ts"] for row in rows]
    assert ts[0] == 0 and all(isinstance(t, int) for t in ts) and ts == sorted(ts) and ts[1] == 120_000
    assert [row["kind"] for row in rows] == ["orient-start", "view", "view", "report-request", "report-generated", "dev-ticket",
                                             "view", "search", "filter-set", "view-build"]
    assert {row["actor"] for row in rows} <= set(telemetry.ACTOR_ROLES)
    assert {row["source"] for row in rows} == {"event", "view", "telemetry"}
    assert rows[1]["target_kind"] == "file" and rows[2]["target_kind"] == "dir"
    targets = [row["target"] for row in rows if row["target"] is not None]
    assert targets and all(TOKEN.match(t) for t in targets)
    assert rows[1]["target"] == rows[6]["target"], "the same file viewed by the analyst and the model is one token"
    assert len({rows[0]["target"], rows[1]["target"], rows[2]["target"], rows[5]["target"]}) == 4
    assert rows[7]["detail"] == {"length": len("alpha 42"), "has_numbers": True}
    assert all(rows[i]["detail"] is None for i in (0, 1, 2, 3, 4, 5, 6, 8, 9)), "events and views carry no free text"
    assert rows[7]["session"] == 0 and rows[0]["session"] is None and rows[7]["duration_ms"] == 120
    rows2 = [json.loads(l) for l in client.get(f"/api/ws/{C}/telemetry/export?form=anonymized").text.splitlines()]
    assert rows2[1]["target"] != rows[1]["target"] and TOKEN.match(rows2[1]["target"])
    assert rows2[1]["target"] == rows2[6]["target"]


def test_anonymize_rule_on_odd_input():
    rows = [{"ts": T[0], "actor": "someone", "kind": "Has Spaces", "target": None, "target_kind": None,
             "detail": {"text": "no digits here"}, "duration_ms": None, "session": None, "source": "telemetry"},
            {"ts": "not a time", "actor": "analyst", "kind": "undo", "target": "x", "target_kind": "other", "detail": None,
             "duration_ms": 1, "session": "s", "source": "telemetry"},
            {"ts": T[1], "actor": "analyst", "kind": "view", "target": "a/b.txt", "target_kind": "file", "detail": {"by": "browser"},
             "duration_ms": None, "session": None, "source": "view"}]
    out = telemetry.anonymize(rows)
    assert len(out) == 2
    assert out[0]["actor"] == "other" and out[0]["kind"] == "other" and out[0]["target"] is None
    assert out[0]["detail"] == {"length": len("no digits here"), "has_numbers": False}
    assert out[1]["detail"] is None and TOKEN.match(out[1]["target"]) and out[1]["ts"] == 60_000


# ----------------------------------------------------------------------------- CSV


def test_csv_header_escaping_and_anonymized_csv(ws):
    client = TestClient(app)
    assert client.post(f"/api/ws/{C}/telemetry", json={"kind": "search", "target": 'odd, "name"', "detail": {"text": 'a, "b"\nc'}}).status_code == 201
    r = client.get(f"/api/ws/{C}/telemetry/export?format=csv")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"] == f'attachment; filename="{C}-telemetry.csv"'
    assert r.text.split("\n")[0] == ",".join(telemetry.SCHEMA)
    parsed = list(csv.DictReader(io.StringIO(r.text)))
    assert len(parsed) == 11 and list(parsed[0].keys()) == list(telemetry.SCHEMA)
    last = parsed[-1]
    assert last["kind"] == "search" and last["target"] == 'odd, "name"' and last["duration_ms"] == ""
    assert json.loads(last["detail"])["text"] == 'a, "b"\nc'
    a = client.get(f"/api/ws/{C}/telemetry/export?format=csv&form=anonymized")
    assert a.headers["content-disposition"] == 'attachment; filename="telemetry-anonymized.csv"'
    _assert_clean(a.text)
    arows = list(csv.DictReader(io.StringIO(a.text)))
    assert list(arows[0].keys()) == list(telemetry.SCHEMA) and len(arows) == len(parsed)
    assert arows[0]["ts"] == "0" and all(TOKEN.match(x["target"]) for x in arows if x["target"])
    assert json.loads(arows[-1]["detail"]) == {"length": len('a, "b"\nc'), "has_numbers": False}


# ----------------------------------------------------------------------------- wiring


def test_router_is_mounted_and_routes_run_off_the_event_loop():
    import inspect

    main_src = (config.REPO_ROOT / "backend" / "app" / "main.py").read_text()
    modules = re.search(r"ROUTER_MODULES = \[(.*?)\]", main_src, re.S).group(1)
    assert '"telemetry"' in modules and '"dev"' in modules
    assert inspect.iscoroutinefunction(telemetry.export_telemetry)
    assert inspect.iscoroutinefunction(telemetry.post_telemetry)
    routes = {r.path: set(r.methods) for r in telemetry.router.routes}
    assert routes == {"/ws/{c}/telemetry": {"POST"}, "/ws/{c}/telemetry/export": {"GET"}}
