"""Any file is labelled and cited by its records (app/records.py): a CSV row whose cell holds a line break, the elements
of a JSON document, a PDF's pages and a database's rows each have a ref, resolve, take labels from the regex, code and
prompt kinds, and are marked in a view, while `<path>#L<n>` keeps working in the same files.

The corpus is invented: orders.csv has three orders after its header, the first with a two-line note; runs.json holds
two runs in an array under `runs` beside its metadata; report.pdf is the three-page safety review the built-in PDF
viewer ships as its sample; forge.db is the mini corpus's database (prs 7101, 7114, 7123, 7138, 7152)."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import shutil
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, kernel_thimble, labels_store, records, refs, views
from mini_corpus import write_forge_db

CORPUS = "records"
PDF_SAMPLE = config.REPO_ROOT / "plugin" / "viewers" / "pdf" / "sample" / "reports" / "harbor-line-safety-2026.pdf"
CSV = 'id,customer,note\n1,ana,"refund asked\nafter two days"\n2,ben,charger works\n\n3,cy,"refund, again"\n'
RUNS = {"meta": {"n": 2}, "runs": [{"id": "r1", "outcome": "refund given"}, {"id": "r2", "outcome": "no refund"}],
        "tags": ["a", "b"]}


def _write(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (root / "orders.csv").write_text(CSV)
    (root / "runs.json").write_text(json.dumps(RUNS, indent=2))
    (root / "list.json").write_text('[\n  {"id": 1, "text": "a [bracket] } inside"},\n  {"id": 2, "text": "refund"}\n]\n')
    (root / "lines.json").write_text('{"a": 1}\n{"a": 2}\n')
    (root / "notes.jsonl").write_text(json.dumps({"text": "refund please"}) + "\n" + json.dumps({"text": "thanks"}) + "\n")
    (root / "blob.bin").write_bytes(b"\x00\x01\x02" * 10)
    shutil.copy(PDF_SAMPLE, root / "report.pdf")
    write_forge_db(root / "forge.db")
    return root


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    data = tmp_path / "data"
    root = _write(data / CORPUS)
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks, concepts._building,
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
    assert rows[2]["record"]["note"] == "refund, again" and "customer: cy" in rows[2]["text"]

    runs = _all(corpus, "runs.json")
    assert [r["ref"] for r in runs] == ["runs.json#/runs/0", "runs.json#/runs/1"], "the array of objects, not the tags"
    assert runs[1]["record"] == {"id": "r2", "outcome": "no refund"} and runs[1]["line"] == runs[1]["end_line"] - 3
    listed = _all(corpus, "list.json")
    assert [(r["ref"], r["record"]["id"], r["line"]) for r in listed] == [("list.json#/0", 1, 2), ("list.json#/1", 2, 3)]
    assert [r["ref"] for r in _all(corpus, "lines.json")] == ["lines.json#L1", "lines.json#L2"], "JSON Lines named .json"

    pages = _all(corpus, "report.pdf")
    assert [r["ref"] for r in pages] == ["report.pdf#page=1", "report.pdf#page=2", "report.pdf#page=3"]
    assert "Crew rest" in pages[1]["text"] and pages[1]["record"]["page"] == 2 and pages[1]["line"] is None

    prs = _all(corpus, "forge.db", under="prs")
    assert [r["ref"] for r in prs] == [f"forge.db#prs/{n}" for n in (7101, 7114, 7123, 7138, 7152)]
    assert prs[1]["record"]["state"] == "merged" and "title: Quote the style name" in prs[1]["text"]
    every = _all(corpus, "forge.db")
    assert "forge.db#agents/agent-01" in {r["ref"] for r in every} and "forge.db#pr_closes/1" in {r["ref"] for r in every}
    assert records.count(corpus / "forge.db", "forge.db") == len(every)
    assert records.count(corpus / "forge.db", "forge.db", "prs") == 5 and records.count(corpus / "orders.csv", "orders.csv") == 3

    assert _all(corpus, "blob.bin") == [] and records.reader_of(corpus / "blob.bin", "blob.bin") is None
    assert [r["ref"] for r in _all(corpus, "notes.jsonl")] == ["notes.jsonl#L1", "notes.jsonl#L2"]


def test_a_record_is_read_by_its_ref_and_by_its_place(corpus):
    assert records.read(corpus / "orders.csv", "orders.csv", "row=3")["record"]["customer"] == "cy"
    assert records.read(corpus / "orders.csv", "orders.csv", "row=4") is None
    assert records.read(corpus / "report.pdf", "report.pdf", "p2")["ref"] == "report.pdf#page=2"
    assert records.read(corpus / "runs.json", "runs.json", "/runs/1")["line"] is not None
    inner = records.read(corpus / "runs.json", "runs.json", "/runs/1/outcome")
    assert inner["record"] == "no refund" and inner["line"] is not None, "a value inside a record, on its record's lines"
    assert records.read(corpus / "forge.db", "forge.db", "prs/7138")["record"]["title"] == "Clarify the width parameter"
    at = records.records_at(corpus / "forge.db", "forge.db", [2, 99], under="prs")
    assert [r["ref"] for r in at] == ["forge.db#prs/7114"]
    assert [r["ref"] for r in records.records_at(corpus / "orders.csv", "orders.csv", [1, 3])] == ["orders.csv#row=1", "orders.csv#row=3"]
    assert records.canon("report.pdf#p3") == "report.pdf#page=3" and records.canon("a.jsonl#L3") == "a.jsonl#L3"
    assert records.split("report.pdf#p3") == ("report.pdf", "page=3") and records.split("orders.csv") is None
    assert records.is_record_ref("forge.db#prs/7101") and not records.is_record_ref("view:x/k")


# --------------------------------------------------------------------------- refs


@pytest.mark.parametrize("ref,kind", [("report.pdf#page=2", "page"), ("report.pdf#p2", "page"), ("runs.json#/runs/0", "pointer"),
                                      ("orders.csv#row=1", "csvrow"), ("forge.db#prs/7114", "row")])
def test_a_record_ref_parses_formats_and_resolves(corpus, ref, kind):
    p = refs.parse_ref(ref)
    assert p["kind"] == kind and refs.parse_ref(refs.format_ref(p)) == p
    out = refs.resolve(corpus, ref)
    assert out["kind"] == kind and out["excerpt"] and out["path"] == ref.split("#")[0]


def test_records_resolve_with_their_lines_and_line_refs_keep_working(corpus):
    row = refs.resolve(corpus, "orders.csv#row=1")
    assert row["meta"]["line"] == 2 and row["meta"]["end_line"] == 3 and row["record"]["note"].startswith("refund asked")
    assert refs.resolve(corpus, "orders.csv#L4")["kind"] == "record", "a line of the same file"
    page = refs.resolve(corpus, "report.pdf#page=2")
    assert page["meta"]["pages"] == 3 and page["blocks"][0]["text"].startswith("Section 2")
    assert refs.resolve(corpus, "runs.json#/runs/1")["record"]["outcome"] == "no refund"
    assert refs.resolve(corpus, "forge.db#prs/7123")["meta"]["n"] == 3, "its place in the table, for the page it is on"
    with pytest.raises(refs.RefError) as e:
        refs.resolve(corpus, "lines.json#/0")
    assert e.value.status == 400, "JSON Lines named .json: its records are lines"
    with pytest.raises(refs.RefError) as e:
        refs.resolve(corpus, "report.pdf#page=9")
    assert e.value.status == 404
    assert refs.span_of_quote(corpus, "report.pdf#page=2", "Average rest between shifts") == "report.pdf#page=2"
    assert refs.span_of_quote(corpus, "forge.db#prs/7114", "Quote the style name") == "forge.db#prs/7114"
    assert refs.span_of_quote(corpus, "report.pdf", "Average rest between shifts") == "report.pdf#page=2"


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


async def test_a_regex_label_runs_over_the_records_of_every_reader(api, corpus, workspaces_tmp):
    ws = workspaces_tmp / CORPUS
    k = await _label(api, name="refund", kind="regex", spec=r"(?i)refund|state: merged")
    # an earlier run over the CSV's lines left a cover there, which a run over its rows replaces
    lf = concepts.labels_file(ws, k["id"])
    lf.parent.mkdir(parents=True, exist_ok=True)
    lf.write_text(json.dumps(labels_store.cover_row("orders.csv", 1, 6, "no", "regex", "t")) + "\n")
    s = await _apply(api, k, ["orders.csv", "runs.json", "report.pdf", "forge.db#prs", "notes.jsonl"])
    assert s["status"] == "done" and s["failed"] == 0
    assert s["total"] == 3 + 2 + 3 + 5 + 2 and s["labeled"] == s["total"]
    got = (await _values(ws, k))
    assert {r: v for r, v in got.items() if not r.startswith("notes.jsonl")} == {
        "orders.csv#row=1": "refund", "orders.csv#row=2": "no", "orders.csv#row=3": "refund",
        "runs.json#/runs/0": "refund", "runs.json#/runs/1": "refund",
        "report.pdf#page=1": "no", "report.pdf#page=2": "no", "report.pdf#page=3": "no",
        "forge.db#prs/7101": "no", "forge.db#prs/7114": "refund", "forge.db#prs/7123": "refund", "forge.db#prs/7138": "no",
        "forge.db#prs/7152": "refund"}
    assert got["notes.jsonl#L1"] == "refund" and got["notes.jsonl#L2"] == "no", "lines as before, a cover for the rest"
    assert s["n_labeled"] == s["total"], "no record of the CSV's old cover is counted"

    # the reader's page of lines finds a CSV row by the line it starts on; a view asks for other records by ref
    r = await api.get(f"/api/ws/{CORPUS}/labels", params={"path": "orders.csv", "lines": "1-500"})
    rows = {row["ref"]: row for e in r.json() for row in e["rows"]}
    assert {ref: row.get("line") for ref, row in rows.items()} == {"orders.csv#row=1": 2, "orders.csv#row=2": 4, "orders.csv#row=3": 6}
    r = await api.get(f"/api/ws/{CORPUS}/labels", params={"path": "forge.db", "lines": "1-500"})
    assert r.json() == [], "a page of lines carries no database rows"
    r = await api.post(f"/api/ws/{CORPUS}/labels/refs", json={"refs": ["forge.db#prs/7114", "report.pdf#p2", "notes.jsonl#L2",
                                                                       "forge.db#prs/1"]})
    assert r.status_code == 200, r.text
    rows = {row["ref"]: row["label"] for e in r.json() for row in e["rows"]}
    assert rows == {"forge.db#prs/7114": "refund", "report.pdf#page=2": "no", "notes.jsonl#L2": "no"}

    # the presence of the label on each file, for the tree's dots
    r = await api.get(f"/api/ws/{CORPUS}/labels/presence")
    paths = next(e["paths"] for e in r.json() if e["concept_id"] == k["id"])
    assert paths["forge.db"] == {"refund": 3, "no": 2} and paths["report.pdf"] == {"no": 3}

    # a verdict on a CSV row keeps the line it starts on
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/labels", json={"ref": "orders.csv#row=2", "label": "refund"})
    assert r.status_code == 200 and r.json()["row"]["line"] == 4


async def test_a_trial_and_a_label_within_another_pick_records_of_any_reader(api, corpus, workspaces_tmp):
    k = await _label(api, name="refund", kind="regex", spec=r"(?i)refund|state: merged")
    await _apply(api, k, ["forge.db#prs"])
    trial = await _label(api, name="merged", kind="regex", spec=r"state: merged", labels=["merged", "no"])
    s = await _apply(api, trial, ["forge.db#prs"], limit=2)
    assert s["total"] == 2 and (await _values(workspaces_tmp / CORPUS, trial)) == {"forge.db#prs/7114": "merged", "forge.db#prs/7138": "no"}
    ws = workspaces_tmp / CORPUS
    narrowed = concepts.read_concept(ws, trial["id"])
    narrowed["within"] = {"label": k["id"], "value": "refund"}
    concepts.write_concept(ws, narrowed)
    s = await _apply(api, trial, ["forge.db#prs"])
    assert s["total"] == 3, "the rows the label `refund` gave its value"
    assert (await _values(workspaces_tmp / CORPUS, trial)) == {"forge.db#prs/7114": "merged", "forge.db#prs/7138": "no",
                                                              "forge.db#prs/7123": "merged", "forge.db#prs/7152": "merged"}
    quoted = await asyncio.to_thread(concepts.examples, CORPUS, k["id"], "refund")
    assert {ref for ref, _t in quoted} == {"forge.db#prs/7114", "forge.db#prs/7123", "forge.db#prs/7152"}
    assert all("state: merged" in t for _r, t in quoted), "each quoted by the line of its text that matched"


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
        "report.pdf#page=2", "runs.json#/runs/0"]
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert {r["ref"]: r.get("line") for r in rows if r.get("ref", "").startswith("orders.csv")} == {
        "orders.csv#row=1": 2, "orders.csv#row=2": 4, "orders.csv#row=3": 6}


async def test_a_prompt_label_reads_each_record_s_text(api, corpus, workspaces_tmp, monkeypatch):
    seen: list[tuple[str, str]] = []

    async def classify(c, concept, items, comment=True, on_retry=None):
        from app import model

        seen.extend(items)
        return model.CallResult(status="ok", output={"labels": [
            {"i": n, "label": "refund" if "refund" in t.lower() else "no", "confidence": 0.9, "rationale": "r"}
            for n, (_ref, t) in enumerate(items, 1)]})

    monkeypatch.setattr(concepts, "classify_structured", classify)
    k = await _label(api, name="refund", kind="prompt", description="asks for a refund")
    s = await _apply(api, k, ["runs.json", "orders.csv"])
    assert s["status"] == "done" and s["labeled"] == 5
    texts = dict(seen)
    assert "after two days" in texts["orders.csv#row=1"] and '"outcome": "refund given"' in texts["runs.json#/runs/0"]
    rows = concepts.read_labels(workspaces_tmp / CORPUS, k["id"])
    assert {r["ref"]: r.get("line") for r in rows if r["ref"].startswith("runs.json")} == {
        "runs.json#/runs/0": records.read(corpus / "runs.json", "runs.json", "/runs/0")["line"],
        "runs.json#/runs/1": records.read(corpus / "runs.json", "runs.json", "/runs/1")["line"]}


# --------------------------------------------------------------------------- marks in a view


async def test_a_view_marks_records_that_are_no_lines(api, corpus, workspaces_tmp):
    k = await _label(api, name="refund", kind="regex", spec=r"(?i)state: merged|crew rest")
    await _apply(api, k, ["forge.db#prs", "report.pdf"])
    concepts.show_concept(CORPUS, k["id"], True)
    ctx = views.labels_context(CORPUS)
    assert kernel_thimble._marked(ctx, "forge.db#prs/7114")[0]["value"] == "refund"
    assert kernel_thimble._marked(ctx, "report.pdf#p2"), "a page anchored as #p<n> is the record #page=<n>"
    assert kernel_thimble._marked(ctx, "forge.db#prs/7101") == []
    marks = await views.marks_for(CORPUS, "any", ["forge.db#prs/7114", "forge.db#prs/7101", "report.pdf#page=2", "orders.csv"])
    assert set(marks) == {"forge.db#prs/7114", "report.pdf#page=2"}
    # the checks' test label marks records of every reader, by line or by the ref's checksum
    probe = views.probe_context()
    hit = [f"forge.db#prs/{n}" for n in range(1, 200) if kernel_thimble._marked(probe, f"forge.db#prs/{n}")]
    assert 10 <= len(hit) <= 50 and kernel_thimble._marked(probe, "a.jsonl#L7") and not kernel_thimble._marked(probe, "a.jsonl#L8")
