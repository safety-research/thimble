"""A written document exported: Markdown with footnotes, one self-contained HTML file, the formats a report type's
export.py declares, such as the video extension's video file, and PDF and video offered disabled when there is no
browser. No model call and no browser."""
from __future__ import annotations

import wave
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import runpy

from app import config, exports, extensions, investigation, notebook, report_types, tools

CORPUS = "mini"
MAIN = investigation.MAIN
app = FastAPI()
app.include_router(exports.router, prefix="/api")
BASE = f"/api/ws/{CORPUS}/investigations/{MAIN}/types"


@pytest.fixture()
def report(workspaces_tmp):
    """A report whose two sentences cite a card and a board post, the card cited twice."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    cell = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    cell["status"], cell["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    return cell["id"]


async def _write(cid: str) -> None:
    text = (f"# One account did it\n\n## What happened\n\nAll [[27|card:{cid}]] deletions came from **one** account. "
            f"It posted first [[board.jsonl#L1]] and again later [[card:{cid}]].\n")
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text


def _model() -> dict:
    return exports.read_model(CORPUS, report_types.read_doc(CORPUS, MAIN, "report"), "document")


async def test_markdown_numbers_each_citation_once_as_a_footnote(report):
    await _write(report)
    md = exports.to_markdown(_model())
    assert "## What happened" in md
    assert "account.[^1] It posted first and again later.[^2][^1]" in md
    assert f"[^1]: card:{report} “How many deletions?”" in md
    assert "[^2]: board.jsonl#L1" in md and "forge pr claim" in md.split("[^2]:")[1]


async def test_a_card_a_sentence_reads_as_a_noun_is_exported_as_its_title(report):
    """...a whole card right after a word such as "in"; one that words follow, and a line of one, cite."""
    text = (f"# Deletions\n\n## Where\n\nThe count is laid out in [[card:{report}]]. "
            f"Every deletion came from one account [[card:{report}]]. "
            f"The first came on May 24, 2026 [[card:{report}@out0#L1]] and the rest by June.\n")
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text
    md = exports.to_markdown(_model())
    assert "The count is laid out in “How many deletions?”.[^1] Every deletion came from one account.[^1]" in md
    assert "The first came on May 24, 2026 and the rest by June.[^2]" in md


async def test_html_is_one_file_that_loads_nothing_and_links_each_citation(report):
    await _write(report)
    page = exports.to_html(_model(), {report: {"title": "How many deletions?", "text": "27"}}, faces="")
    assert "<strong>one</strong>" in page
    assert page.count('href="#note-1"') == 2 and 'id="note-1"' in page and 'id="note-2"' in page
    assert "<link" not in page and 'src="http' not in page and "<script src" not in page


async def test_routes_offer_the_formats_and_save_markdown_as_a_file(report, monkeypatch):
    await _write(report)
    monkeypatch.setattr(exports, "browser", lambda: ("off", "the browser is off in thimble's config"))
    got = TestClient(app).get(f"{BASE}/report/exports").json()["formats"]
    by = {f["id"]: f for f in got}
    assert [f["id"] for f in got] == ["markdown", "html", "pdf"]
    assert by["html"]["ok"] and not by["pdf"]["ok"] and "browser is off" in by["pdf"]["why"]
    r = TestClient(app).get(f"{BASE}/report/export/markdown")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert 'filename="One-account-did-it.md"' in r.headers["content-disposition"] and r.text.startswith("# One account")
    assert TestClient(app).get(f"{BASE}/report/export/pdf").status_code == 409
    assert TestClient(app).get(f"{BASE}/report/export/video").status_code == 404


def test_a_hooks_formats_are_read_without_running_it(tmp_path):
    hook = tmp_path / "export.py"
    hook.write_text('raise SystemExit("ran")\nFORMATS = [{"id": "csv", "name": "CSV", "ext": "csv"}, {"id": "Bad id"}]\n')
    assert exports.hook_formats(hook) == [{"id": "csv", "name": "CSV", "ext": "csv"}]
    hook.write_text("FORMATS = make()\n")
    assert exports.hook_formats(hook) == []


async def test_an_extension_report_types_formats_join_the_built_in_ones(report, tmp_path, monkeypatch):
    """An extension's type adds formats or replaces one; thimble's own types keep theirs whatever an extension names."""
    await _write(report)
    hook = tmp_path / "export.py"
    hook.write_text('FORMATS = [{"id": "csv", "name": "CSV", "ext": "csv"}, {"id": "html", "name": "Web page", "ext": "html"}]\n')
    types = [{"id": i, "export": str(tmp_path / "copy.py"), "export_src": str(hook)} for i in ("digest", "report")]
    monkeypatch.setattr(exports, "_extension_types", lambda c: types)
    monkeypatch.setattr(exports, "browser", lambda: ("system", "/usr/bin/chromium"))
    got = {f["id"]: f for f in exports.formats(CORPUS, "digest", "document")}
    assert got["csv"] == {"id": "csv", "name": "CSV", "ext": "csv", "ok": True, "hook": True}
    assert got["html"]["name"] == "Web page" and got["html"].get("hook") and not got["markdown"].get("hook")
    assert not any(f.get("hook") for f in exports.formats(CORPUS, "report", "document"))




async def test_a_document_not_written_yet_answers_no_content_and_a_written_one_itself(report):
    """GET …/types/report before a write is a normal answer (204, which the page reads as no document), not a 404."""
    api = FastAPI()
    api.include_router(report_types.router, prefix="/api")
    client = TestClient(api)
    r = client.get(f"{BASE}/report")
    assert r.status_code == 204 and r.content == b""
    assert client.get(f"{BASE}/no-such-type").status_code == 404
    with pytest.raises(HTTPException) as e:  # the terminal's callers (local.py, term_report.py) still hear 404
        report_types.get_doc(CORPUS, MAIN, "report")
    assert e.value.status_code == 404
    await _write(report)
    r = client.get(f"{BASE}/report")
    assert r.status_code == 200 and r.json()["id"] == report_types.read_doc(CORPUS, MAIN, "report")["id"]
