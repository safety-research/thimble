"""A written document exported: Markdown with footnotes, one self-contained HTML file, and PDF offered disabled when
there is no browser. No model call and no browser."""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config, exports, investigation, notebook, tools

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


async def test_a_written_document_exports_as_markdown_with_footnotes_and_as_one_html_file_that_loads_nothing(
        report, monkeypatch):
    await _write(report)
    monkeypatch.setattr(exports, "browser", lambda: ("off", "the browser is off in thimble's config"))
    client = TestClient(app)
    by = {f["id"]: f for f in client.get(f"{BASE}/report/exports").json()["formats"]}
    assert by["markdown"]["ok"] and by["html"]["ok"] and not by["pdf"]["ok"], "PDF needs the browser"
    r = client.get(f"{BASE}/report/export/markdown")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert 'filename="One-account-did-it.md"' in r.headers["content-disposition"] and r.text.startswith("# One account")
    assert "account.[^1] It posted first and again later.[^2][^1]" in r.text
    assert f"[^1]: card:{report}" in r.text and "[^2]: board.jsonl#L1" in r.text
    r = client.get(f"{BASE}/report/export/html")
    assert r.status_code == 200 and "<strong>one</strong>" in r.text
    assert r.text.count('href="#note-1"') == 2 and 'id="note-2"' in r.text
    assert "<link" not in r.text and 'src="http' not in r.text and "<script src" not in r.text
