"""Any file is labelled and cited by its records (app/records.py): a CSV row whose cell holds a line break, the elements
of a JSON document, a PDF's pages and a database's rows each have a ref, and a code label gets each as its reader
reads it.

The corpus is invented: orders.csv has three orders after its header, the first with a two-line note; runs.json holds
two runs in an array under `runs` beside its metadata; chats.json holds a chat's three messages in an object keyed by
their ids, beside its one system block, as a chat transcript can; report.pdf is a three-page safety review whose second
page is about crew rest; forge.db is the mini corpus's database (prs 7101, 7114, 7123, 7138, 7152)."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, records
from mini_corpus import tiny_pdf, write_forge_db

# model calls go through Claude Code, which the tests fake (conftest claude_code_sign_in)
pytestmark = pytest.mark.usefixtures("claude_code_sign_in")

CORPUS = "records"
PAGES = ["Section 1. Overview of the harbor line", "Section 2. Crew rest. Average rest between shifts: 10.4 hours",
         "Section 3. Fuel and delays"]


CSV = 'id,customer,note\n1,ana,"refund asked\nafter two days"\n2,ben,charger works\n\n3,cy,"refund, again"\n'
RUNS = {"meta": {"n": 2}, "runs": [{"id": "r1", "outcome": "refund given"}, {"id": "r2", "outcome": "no refund"}],
        "tags": ["a", "b"]}
CHATS = {"agent": "u1", "system": [{"type": "text", "text": "You keep the shop app running."}],
         "messages": {"m1": {"id": "m1", "role": "user", "content": [{"type": "text", "text": "Can I get a refund?"}]},
                      "m2": {"id": "m2", "role": "assistant", "content": [{"type": "text", "text": "The order shipped today."}]},
                      "m3": {"id": "m3", "role": "user", "content": [{"type": "text", "text": "Then refund the shipping."}]}},
         "conversations": {"c1": ["m1", "m2", "m3"]}}


def _write(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (root / "orders.csv").write_text(CSV)
    (root / "runs.json").write_text(json.dumps(RUNS, indent=2))
    (root / "chats.json").write_text(json.dumps(CHATS, indent=2))
    (root / "notes.jsonl").write_text(json.dumps({"text": "refund please"}) + "\n" + json.dumps({"text": "thanks"}) + "\n")
    (root / "blob.bin").write_bytes(b"\x00\x01\x02" * 10)
    (root / "report.pdf").write_bytes(tiny_pdf(PAGES))
    write_forge_db(root / "forge.db")
    return root


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    data = tmp_path / "data"
    root = _write(data / CORPUS)
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    for table in (concepts._runs, concepts._locks, concepts._cancels, concepts._tasks, concepts._building,
                  concepts._building_answers):
        table.clear()
    return root.resolve()


@pytest.fixture()
async def api(corpus):
    a = FastAPI()
    a.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t", timeout=120) as c:
        yield c


def _all(root: Path, rel: str, under: str | None = None) -> list[dict]:
    return list(records.iter_records(root / rel, rel, under=under))


# --------------------------------------------------------------------------- readers


def test_each_reader_splits_its_file_into_records_named_by_refs(corpus):
    rows = _all(corpus, "orders.csv")
    assert [(r["ref"], r["line"], r["end_line"]) for r in rows] == [
        ("orders.csv#row=1", 2, 3), ("orders.csv#row=2", 4, 4), ("orders.csv#row=3", 6, 6)]
    assert rows[0]["record"] == {"id": "1", "customer": "ana", "note": "refund asked\nafter two days"}
    runs = _all(corpus, "runs.json")
    assert [r["ref"] for r in runs] == ["runs.json#/runs/0", "runs.json#/runs/1"], "the array of objects, not the tags"
    assert runs[1]["record"] == {"id": "r2", "outcome": "no refund"}
    pages = _all(corpus, "report.pdf")
    assert [r["ref"] for r in pages] == ["report.pdf#p1", "report.pdf#p2", "report.pdf#p3"]
    assert "Crew rest" in pages[1]["text"] and pages[1]["record"]["page"] == 2
    prs = _all(corpus, "forge.db", under="prs")
    assert [r["ref"] for r in prs] == [f"forge.db#prs/{n}" for n in (7101, 7114, 7123, 7138, 7152)]
    assert prs[1]["record"]["state"] == "merged" and "title: Quote the style name" in prs[1]["text"]
    assert [r["ref"] for r in _all(corpus, "notes.jsonl")] == ["notes.jsonl#L1", "notes.jsonl#L2"]
    assert _all(corpus, "blob.bin") == [] and records.reader_of(corpus / "blob.bin", "blob.bin") is None


def test_a_place_that_stores_its_records_by_id_reads_one_record_per_entry(corpus):
    # the document's own records leave the messages out, since they are an object keyed by id and not a list
    assert [r["ref"] for r in _all(corpus, "chats.json")] == ["chats.json#/system/0"]
    path = corpus / "chats.json"
    messages = [("chats.json#/messages/m1", 10, 19), ("chats.json#/messages/m2", 20, 29), ("chats.json#/messages/m3", 30, 39)]
    for under in ("/messages", "/messages/*"):  # the place, or each entry of it as the terminal names them
        rows = _all(corpus, "chats.json", under=under)
        assert [(r["ref"], r["line"], r["end_line"]) for r in rows] == messages, under
        assert rows[1]["record"]["role"] == "assistant" and "shipped today" in rows[1]["text"]
        assert records.count(path, "chats.json", under) == 3
        assert [r["ref"] for r in records.records_at(path, "chats.json", [2, 9], under=under)] == ["chats.json#/messages/m2"]
    assert [(r["ref"], r["line"]) for r in _all(corpus, "chats.json", under="/messages/*/content")] == [
        ("chats.json#/messages/m1/content/0", 14), ("chats.json#/messages/m2/content/0", 24),
        ("chats.json#/messages/m3/content/0", 34)]
    assert [r["ref"] for r in _all(corpus, "chats.json", under="/conversations")] == ["chats.json#/conversations/c1"]
    assert [r["record"] for r in _all(corpus, "chats.json", under="/agent")] == ["u1"]
    assert _all(corpus, "chats.json", under="/nothing") == []
    # a record at such a place opens at its own lines, as a citation of it does, and so does a value inside a record
    one = records.read(path, "chats.json", "/messages/m2")
    assert (one["ref"], one["line"], one["end_line"], one["record"]["id"]) == ("chats.json#/messages/m2", 20, 29, "m2")
    inner = records.read(corpus / "runs.json", "runs.json", "/runs/1/outcome")
    assert (inner["record"], inner["n"], inner["line"], inner["end_line"]) == ("no refund", 2, 12, 12)


# --------------------------------------------------------------------------- labels


async def _label(api, **kw) -> dict:
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"labels": ["refund", "no"], **kw})
    assert r.status_code == 200, r.text
    return r.json()


async def _apply(api, k: dict, paths: list[str], **kw) -> dict:
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": paths, **kw})
    assert r.status_code == 200, r.text
    return r.json()


async def _values(ws: Path, k: dict) -> dict[str, str]:
    rows = await asyncio.to_thread(concepts.rows_for_path, ws, k["id"], None)
    return {r["ref"]: r["label"] for r in rows}


async def _code_inproc(c: str, kernel: str, code: str, timeout_s: float | None = None) -> tuple[list[dict], int, str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {"__name__": "wrapper"})  # noqa: S102 — the code the labels kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], 1, "ok"


async def test_a_code_label_gets_each_record_as_its_reader_reads_it(api, corpus, workspaces_tmp, monkeypatch):
    from app import notebook

    monkeypatch.setattr(notebook, "execute_on", _code_inproc)
    spec = ("def label(unit):\n"
            "    if 'state' in unit:\n"
            "        return 'refund' if unit['state'] == 'merged' else 'no'\n"
            "    if 'page' in unit:\n"
            "        return 'refund' if 'Crew rest' in unit['text'] else 'no'\n"
            "    if 'note' in unit:\n"
            "        return 'refund' if 'refund' in unit['note'] else 'no'\n"
            "    if 'outcome' in unit:\n"
            "        return 'refund' if unit['outcome'] == 'refund given' else 'no'\n"
            "    return 'refund' if 'refund' in unit.get('text', '') else 'no'\n")
    k = await _label(api, name="refund", kind="code", spec=spec)
    s = await _apply(api, k, ["forge.db#prs", "report.pdf", "orders.csv", "runs.json", "notes.jsonl"])
    assert s["status"] == "done" and s["failed"] == 0, s
    got = (await _values(workspaces_tmp / CORPUS, k))
    assert [r for r, v in sorted(got.items()) if v == "refund"] == [
        "forge.db#prs/7114", "forge.db#prs/7123", "forge.db#prs/7152", "notes.jsonl#L1", "orders.csv#row=1", "orders.csv#row=3",
        "report.pdf#p2", "runs.json#/runs/0"]
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert {r["ref"]: r.get("line") for r in rows if r.get("ref", "").startswith("orders.csv")} == {
        "orders.csv#row=1": 2, "orders.csv#row=2": 4, "orders.csv#row=3": 6}


async def test_a_label_over_messages_stored_by_id_labels_each_message(api, corpus, workspaces_tmp):
    k = await _label(api, name="asks for a refund", kind="regex", spec="(?i)refund")
    s = await _apply(api, k, ["chats.json#/messages"])
    assert s["status"] == "done" and s["total"] == 3 and s["failed"] == 0, s
    assert await _values(workspaces_tmp / CORPUS, k) == {
        "chats.json#/messages/m1": "refund", "chats.json#/messages/m2": "no", "chats.json#/messages/m3": "refund"}
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert {r["ref"]: r.get("line") for r in rows} == {
        "chats.json#/messages/m1": 10, "chats.json#/messages/m2": 20, "chats.json#/messages/m3": 30}
