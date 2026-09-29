"""A written document exported: Markdown with footnotes, one self-contained HTML file, the formats a report type's
export.py declares, and PDF and video offered disabled when there is no browser. No model call and no browser."""
from __future__ import annotations

import wave
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config, exports, film_export, investigation, notebook, report_types, tools

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
    await _write(report)
    hook = tmp_path / "export.py"
    hook.write_text('FORMATS = [{"id": "csv", "name": "CSV", "ext": "csv"}, {"id": "html", "name": "Web page", "ext": "html"}]\n')
    monkeypatch.setattr(exports, "_extension_types", lambda c: [{"id": "report", "export": str(hook)}])
    monkeypatch.setattr(exports, "browser", lambda: ("system", "/usr/bin/chromium"))
    got = {f["id"]: f for f in exports.formats(CORPUS, "report", "document")}
    assert got["csv"] == {"id": "csv", "name": "CSV", "ext": "csv", "ok": True, "hook": True}
    assert got["html"]["name"] == "Web page" and got["html"].get("hook") and not got["markdown"].get("hook")


def test_the_narration_lays_each_line_at_its_start(tmp_path):
    def clip(name: str, seconds: float) -> Path:
        p = tmp_path / name
        with wave.open(str(p), "wb") as w:
            w.setnchannels(1), w.setsampwidth(2), w.setframerate(1000)
            w.writeframes(b"\x01\x00" * int(seconds * 1000))
        return p

    out = film_export.mix([(0.5, clip("a.wav", 1.0)), (1.0, clip("b.wav", 1.0))], 4.0, tmp_path / "n.wav")
    with wave.open(str(out), "rb") as w:
        frames = w.readframes(w.getnframes())
        assert w.getnframes() == 4000
    samples = [frames[i:i + 2] for i in range(0, len(frames), 2)]
    # the second line overruns into the first one's end, so it follows it
    assert samples[499] == b"\0\0" and samples[500] == b"\x01\x00" and samples[2499] == b"\x01\x00" and samples[2500] == b"\0\0"


def test_without_the_systems_ffmpeg_the_video_is_a_webm_with_captions(monkeypatch, tmp_path):
    monkeypatch.setattr(film_export, "_system_ffmpeg", lambda: None)
    monkeypatch.setattr(film_export, "_playwright_ffmpeg", lambda: "/pw/ffmpeg")
    assert film_export.encoder() == ("webm", "/pw/ffmpeg")
    argv = film_export.ffmpeg_argv("webm", "/pw/ffmpeg", tmp_path / "f.webm", None)
    assert "pipe:0" in argv and "libvpx" in argv and argv[-1].endswith(".webm")
