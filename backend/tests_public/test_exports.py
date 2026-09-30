"""A written document exported: Markdown with footnotes, one self-contained HTML file, the formats a report type's
export.py declares, such as the video extension's video file, and PDF and video offered disabled when there is no
browser. No model call and no browser."""
from __future__ import annotations

import wave
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import runpy

import asyncio

from app import channel, config, exports, extensions, film_export, investigation, notebook, report_types, tools

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
    assert [f["id"] for f in got] == ["markdown", "html", "pdf", "video"]
    assert by["html"]["ok"] and not by["pdf"]["ok"] and "browser is off" in by["pdf"]["why"] and not by["video"]["ok"]
    r = TestClient(app).get(f"{BASE}/report/export/markdown")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert 'filename="One-account-did-it.md"' in r.headers["content-disposition"] and r.text.startswith("# One account")
    assert TestClient(app).get(f"{BASE}/report/export/pdf").status_code == 409
    assert TestClient(app).get(f"{BASE}/report/export/video").status_code == 409
    assert TestClient(app).get(f"{BASE}/story/export/video").status_code == 404


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


async def test_the_video_extension_gives_a_video_its_video_file(report, monkeypatch):
    """The video's Video format is its type's export hook, whose film thimble renders with the encoder there is."""
    extensions.add("video", yes=True, say=lambda _: None)
    await extensions.refresh(CORPUS)
    report_types.create_document_type(CORPUS, "video")
    monkeypatch.setattr(exports, "browser", lambda: ("system", "/usr/bin/chromium"))
    monkeypatch.setattr(film_export, "encoder", lambda: ("webm", "/pw/ffmpeg"))
    got = {f["id"]: f for f in exports.formats(CORPUS, "video", "video")}
    assert list(got) == ["markdown", "html", "pdf", "video"] and got["video"]["hook"] and got["video"]["ext"] == "webm"
    monkeypatch.setattr(film_export, "encoder", lambda: None)
    got = {f["id"]: f for f in exports.formats(CORPUS, "video", "video")}
    assert not got["video"]["ok"] and got["video"]["why"] == "Needs ffmpeg to write the video file"
    hook = runpy.run_path(str(extensions.builtin_dir() / "video" / "reports" / "video" / "export.py"))
    doc = {"film": "<p>", "timing": {"duration": 6.0, "lines": [{"id": "a", "start": 0.5, "end": 5.0}]},
           "lines": [{"id": "a", "sentences": [{"text": "All [[27|card:b2c3d4e5]] came from one account [[card:b2c3d4e5]]."}]}]}
    assert hook["export"](doc, "video", None) == {
        "film": {"html": "<p>", "duration": 6.0, "lines": [{"start": 0.5, "end": 5.0, "text": "All 27 came from one account."}]}}


async def test_the_report_exports_as_a_video_that_its_writer_writes_first(report, monkeypatch):
    """The Report's Video needs the video extension; it asks main for the video's writer with a `write` event, and once
    the video is saved exports it with the video's own format, its share rendered told as it goes."""
    await _write(report)
    monkeypatch.setattr(exports, "browser", lambda: ("system", "/usr/bin/chromium"))
    monkeypatch.setattr(film_export, "encoder", lambda: ("mp4", "/usr/bin/ffmpeg"))
    got = {f["id"]: f for f in exports.formats(CORPUS, "report", "document")}
    assert list(got) == ["markdown", "html", "pdf", "video"] and got["video"]["write"]
    assert not got["video"]["ok"] and got["video"]["why"] == "Needs the video extension, which does not run here"
    extensions.add("video", yes=True, say=lambda _: None)
    await extensions.refresh(CORPUS)
    assert {f["id"]: f for f in exports.formats(CORPUS, "report", "document")}["video"]["ok"]

    posted, told = [], []

    def post(c, kind, payload, **_):
        posted.append((kind, payload))
        report_types.write_requested(c, payload, {"id": "e1"})
        return {"id": "e1"}

    async def run_hook(c, path, doc, fmt, ctx):
        return runpy.run_path(str(path))["export"](doc, fmt, ctx)

    async def render_film(film, *, faces, progress=None):
        told.append(film["lines"][0]["text"])
        progress(0.5)
        return b"MP4", "mp4"

    monkeypatch.setattr(channel, "reachable", lambda c: True)
    monkeypatch.setattr(channel, "post", post)
    monkeypatch.setattr(exports, "run_hook", run_hook)
    monkeypatch.setattr(film_export, "render_film", render_film)
    monkeypatch.setattr(exports, "VIDEO_POLL_S", 0.01)
    assert (await exports.start_report_video(CORPUS))["stage"] == "writing"
    assert posted == [("write", {"doc": "video", "text": exports.VIDEO_REQUEST})]
    film = "<!doctype html><script>window.seek = (t) => {}; window.ready = Promise.resolve()</script>"
    text = f"# One account\n\nAll [[27|card:{report}]] deletions came from one account.\n\n```html\n{film}\n```\n"
    r = await tools.call(CORPUS, "write_document", {"doc": "video", "text": text}, actor="analyst")
    assert not r.is_error, r.text
    for _ in range(200):
        if exports.video_state(CORPUS)["stage"] in ("done", "failed"):
            break
        await asyncio.sleep(0.01)
    assert exports.video_state(CORPUS) == {"stage": "done", "doc": "video", "progress": 1.0, "error": None,
                                           "name": "One-account.mp4"}
    assert told == ["All 27 deletions came from one account."]
    path, name = exports.video_file(CORPUS)
    assert path.read_bytes() == b"MP4" and name == "One-account.mp4"


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
