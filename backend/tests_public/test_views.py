"""app.views: viewers written for how a corpus arranges its records. The reader resolves lines and keys, view refs
resolve and outlive their view, the frame document blocks every host, the media route serves only the media files a view
claims inside the corpus, the built-in viewers open workbooks and PDFs, and the worked examples a view ticket reads pass
the view checks over their own samples.

A temp DATA_DIR holds the corpus `boards`: `board.jsonl`, one post per line, each {thread, author, time, body}, and
`notes.md`. The `ws` fixture saves the view `threads`, whose reader (THREADS_READER) groups the posts by thread: it
accepts `board.jsonl#L<n>` (the post) and declares `view:threads/<thread>` (a whole thread). Most tests run the reader
in this process (the `inproc` fixture replaces views._runner with an exec of the same snippet the kernel gets).
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from app import config, refs, verify, views

CORPUS = "boards"
POSTS = [  # (thread, author, time, body); line n of board.jsonl is POSTS[n-1]
    ("t1", "ada", "2026-06-01T10:00:00Z", "The release branch is cut at 14:00.\n-- ada"),
    ("t2", "bo", "2026-06-01T10:05:00Z", "Anyone have the build number?"),
    ("t1", "cy", "2026-06-01T10:07:00Z", "Confirmed: 4127 tests pass.\n-- cy"),
    ("t2", "ada", "2026-06-01T10:09:00Z", "The build is 3316."),
    ("t1", "bo", "2026-06-01T10:11:00Z", "Thanks, tagging the release now."),
]

THREADS_READER = '''
import json


def build_index(paths):
    threads, lines = {}, {}
    for path in paths:
        with open(path) as f:
            for n, line in enumerate(f, 1):
                r = json.loads(line)
                threads.setdefault(r["thread"], []).append([path, n, r["author"], r["body"]])
                lines[f"{path}#L{n}"] = r["thread"]
    return {"threads": threads, "lines": lines}


def records(index, query):
    query = query or {}
    if query.get("thread"):
        return [{"ref": f"{p}#L{n}", "author": a, "body": b} for p, n, a, b in index["threads"].get(query["thread"], [])]
    return sorted(index["threads"])


def resolve(index, locator):
    if "key" in locator:
        posts = index["threads"].get(locator["key"])
        if not posts:
            return None
        return {"excerpt": "\\n".join(b for _, _, _, b in posts), "label": f"thread {locator['key']}, which has a name longer than a chip",
                "refs": [f"{p}#L{n}" for p, n, _, _ in posts], "key": locator["key"], "target": {"thread": locator["key"]}}
    ref = f"{locator['path']}#{locator['fragment']}"
    thread = index["lines"].get(ref)
    if thread is None:
        return None
    for p, n, a, b in index["threads"][thread]:
        if f"{p}#L{n}" == ref:
            return {"excerpt": b, "label": a, "refs": [ref], "key": thread, "target": {"thread": thread, "line": n}}
'''

THREADS_HTML = """<!doctype html><html><head><style>body{font:13px sans-serif}</style></head><body><div id="out"></div>
<script>
thimble.onOpen(async (place) => {
  const t = (place && place.target && place.target.thread) || 't1'
  const posts = await thimble.fetch({ thread: t })
  document.getElementById('out').textContent = posts.map((p) => p.author + ': ' + p.body).join('\\n')
})
</script></body></html>"""

VIEW = dict(name="Threads", why="The board's posts grouped by thread.", claims=["board.jsonl"],
            accepts=[{"form": "L<n>", "means": "one post"}], declares=[{"form": "<thread>", "means": "one whole thread"}],
            default=True, libs=[])


@pytest.fixture()
def data(tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"thread": t, "author": a, "time": ts, "body": b}) + "\n" for t, a, ts, b in POSTS))
    (corpus / "notes.md").write_text("# notes\n\nnothing here\n")
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    """The kernel's part run in this process, in the corpus folder, its stdout captured as the kernel's would be."""
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the same snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    views._folder_cache.clear()
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    views._memo.clear()
    views._ready.clear()
    sys.modules.pop("_thimble_views", None)
    yield
    views._memo.clear()
    views._ready.clear()
    sys.modules.pop("_thimble_views", None)


@pytest.fixture()
def inproc(monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc_run)


@pytest.fixture()
async def ws(data, workspaces_tmp) -> Path:
    """The workspace with the view `threads` saved, on the test's loop (the stream's events are the loop's)."""
    views.write_view(CORPUS, "threads", reader=THREADS_READER, html=THREADS_HTML, **VIEW)
    return config.workspace_dir(CORPUS)


@pytest.fixture()
async def bound():
    """The test's loop is the one reader calls run on, as the server's is (views._lifespan)."""
    views._bind_loop()
    yield


def _events(ws: Path) -> list[dict]:
    p = ws / "investigations" / "main" / "events.jsonl"
    return [json.loads(ln) for ln in p.read_text().splitlines() if ln.strip()] if p.is_file() else []


# ----------------------------------------------------------------------------------------------------------- disk


def test_a_saved_view_is_three_files_and_reads_back_normalised(ws):
    d = ws / "views" / "threads"
    assert sorted(p.name for p in d.iterdir()) == ["reader.py", "view.html", "view.json"]
    v = views.read_view(CORPUS, "threads")
    assert v["ok"] and v["claims"] == ["board.jsonl"] and v["default"] is True
    assert v["accepts"] == [{"form": "L<n>", "means": "one post"}]
    assert v["declares"] == [{"form": "<thread>", "means": "one whole thread"}]
    assert v["built"]
    assert [e for e in _events(ws) if e["type"] == "view"][-1]["status"] == "built"


def test_write_view_refuses_what_cannot_run(data, workspaces_tmp):
    ok = dict(reader=THREADS_READER, html=THREADS_HTML, **VIEW)
    for bad, why in (({"claims": []}, "claims"), ({"reader": "def build_index(:\n"}, "does not parse"),
                     ({"reader": "def build_index(paths):\n    return {}\n"}, "records()"),
                     ({"html": "  "}, "view.html is empty"), ({"libs": ["d3"]}, "no library d3")):
        with pytest.raises(HTTPException) as e:
            views.write_view(CORPUS, "threads", **{**ok, **bad})
        assert why in str(e.value.detail), (bad, e.value.detail)
    for slug in ("Bad Slug", "raw", "proposals"):
        with pytest.raises(HTTPException):
            views.write_view(CORPUS, slug, **ok)


def test_forms_match_fragments_and_the_default_view_opens_first(ws):
    assert views.form_regex("L<n>").match("L12") and not views.form_regex("L<n>").match("L12-L14")
    assert views.form_regex("<Sheet>!<A1>").match("Q3!D17") and not views.form_regex("p<n>").match("pX")
    assert views.accepts(views.read_view(CORPUS, "threads"), "L3")
    assert views.views_for(CORPUS, "board.jsonl", "L5-L9") == []
    assert views.views_for(CORPUS, "notes.md") == []
    later = dict(VIEW, default=False, name="Later")
    views.write_view(CORPUS, "later", reader=THREADS_READER, html=THREADS_HTML, **later)
    newest = dict(VIEW, default=False, name="Newest")
    views.write_view(CORPUS, "newest", reader=THREADS_READER, html=THREADS_HTML, **newest)
    order = [v["slug"] for v in views.views_for(CORPUS, "board.jsonl", "L1")]
    assert order[0] == "threads", "the default view first"
    assert set(order[1:]) == {"later", "newest"}


def test_title_case_raises_each_words_first_letter_and_keeps_capitals():
    assert views.title_case("timeline") == "Timeline"
    assert views.title_case("  tool call   timeline ") == "Tool Call Timeline"
    assert views.title_case("API logs by run") == "API Logs By Run"
    assert views.title_case("per-session view") == "Per-Session View"
    assert views.title_case("McCoy's JSONL") == "McCoy's JSONL"
    assert views.title_case("") == ""


async def test_a_lowercase_proposal_is_named_in_title_case_and_keeps_its_slug(data, workspaces_tmp, monkeypatch):
    """main proposed "timeline": its tab reads Timeline, its slug stays timeline, and a revision of it in any case
    replaces it under the same slug."""
    from app import dev

    monkeypatch.setattr(dev, "queue_view", lambda c, slug: None)
    p = views.propose(CORPUS, "timeline", "w", ["board.jsonl"], "by time")
    assert (p["name"], p["slug"]) == ("Timeline", "timeline")
    again = views.propose(CORPUS, "TIMELINE", "w2", ["board.jsonl"], "by time")
    assert again["slug"] == "timeline"
    assert [q["slug"] for q in views.list_proposals(CORPUS)] == ["timeline"]


async def test_a_view_the_analyst_asked_for_is_built_with_asked_on_its_event(data, workspaces_tmp, monkeypatch):
    """A proposal the analyst asked for keeps `asked`, and its `built` event carries it, so the browser opens that view
    once it is ready; a proposal nobody asked for (the orientation's) is built without it."""
    from app import dev

    monkeypatch.setattr(dev, "queue_view", lambda c, slug: None)
    assert views.propose(CORPUS, "Threads", "w", ["board.jsonl"], "by thread", asked=True)["asked"] is True
    assert "asked" not in views.propose(CORPUS, "Later", "w", ["board.jsonl"], "by thread, newest first")
    views.write_view(CORPUS, "threads", reader=THREADS_READER, html=THREADS_HTML, **VIEW)
    views.write_view(CORPUS, "later", reader=THREADS_READER, html=THREADS_HTML, **dict(VIEW, name="Later", default=False))
    built = [e for e in _events(config.workspace_dir(CORPUS)) if e["type"] == "view" and e["status"] == "built"]
    assert [(e["slug"], e.get("asked")) for e in built] == [("threads", True), ("later", None)]


async def test_a_reader_resolves_a_line_and_a_key_and_its_answer_is_kept(ws, inproc):
    post = await views.resolve_locator(CORPUS, "threads", {"path": "board.jsonl", "fragment": "L3"})
    assert post == {"excerpt": "Confirmed: 4127 tests pass.\n-- cy", "label": "cy", "refs": ["board.jsonl#L3"], "key": "t1",
                    "target": {"thread": "t1", "line": 3}}
    thread = await views.resolve_locator(CORPUS, "threads", {"key": "t1"})
    assert thread["refs"] == ["board.jsonl#L1", "board.jsonl#L3", "board.jsonl#L5"]
    assert len(thread["label"]) <= views.LABEL_MAX and thread["label"].endswith("…"), "a long label is cut"
    assert await views.resolve_locator(CORPUS, "threads", {"path": "board.jsonl", "fragment": "L99"}) is None
    kept = views.key_refs(CORPUS)["view:threads/t1"]
    assert kept["refs"] == thread["refs"] and kept["name"] == "Threads"
    assert await views.reader_call(CORPUS, "threads", "records", {"thread": "t2"}) == [
        {"ref": "board.jsonl#L2", "author": "bo", "body": "Anyone have the build number?"},
        {"ref": "board.jsonl#L4", "author": "ada", "body": "The build is 3316."}]
    # the index is cached by the files' fingerprint, beside the view
    assert list((ws / "views" / "threads" / "cache").glob("*.index.pickle"))


async def test_a_reader_that_raises_is_a_reader_error(ws, inproc):
    views.write_view(CORPUS, "broken", reader="def build_index(paths):\n    raise ValueError('no index')\n\ndef records(i, q):\n    return 1\n\n"
                                               "def resolve(i, l):\n    return None\n", html=THREADS_HTML, **dict(VIEW, default=False))
    with pytest.raises(views.ReaderError) as e:
        await views.reader_call(CORPUS, "broken", "index")
    assert "ValueError: no index" in e.value.message and "Traceback" in e.value.detail


async def test_a_file_ref_the_view_accepts_reads_the_views_excerpt(ws, inproc, bound):
    corpus = config.corpus_dir(CORPUS)
    out = await asyncio.to_thread(refs.resolve, corpus, "board.jsonl#L3")
    assert out["excerpt"] == "Confirmed: 4127 tests pass.\n-- cy"
    assert out["view"] == {"slug": "threads", "name": "Threads", "label": "cy", "key": "t1"} and out["meta"]["view"] == "threads"
    assert out["record"]["author"] == "cy", "the file's own resolution stands under the view's excerpt"
    base = refs.resolve_base(corpus, "board.jsonl#L3")
    assert "view" not in base and "4127" in base["excerpt"]
    rng = await asyncio.to_thread(refs.resolve, corpus, "board.jsonl#L2-L3")
    assert "view" not in rng, "a range is a form the view does not accept"
    whole = await asyncio.to_thread(refs.resolve, corpus, "board.jsonl")
    assert "view" not in whole


async def test_a_view_ref_resolves_and_survives_its_view(ws, inproc, bound):
    corpus = config.corpus_dir(CORPUS)
    out = await asyncio.to_thread(refs.resolve, corpus, "view:threads/t2")
    assert out["kind"] == "view" and out["refs"] == ["board.jsonl#L2", "board.jsonl#L4"]
    assert out["excerpt"] == "Anyone have the build number?\nThe build is 3316."
    me = await asyncio.to_thread(refs.resolve, corpus, "view:threads")
    assert me["label"] == "Threads" and me["excerpt"] == VIEW["why"]
    with pytest.raises(refs.RefError) as e:
        await asyncio.to_thread(refs.resolve, corpus, "view:threads/t9")
    assert e.value.status == 404
    views.delete_view(CORPUS, "threads")
    gone = await asyncio.to_thread(refs.resolve, corpus, "view:threads/t2")
    assert gone["refs"] == ["board.jsonl#L2", "board.jsonl#L4"] and gone["meta"]["deleted"] is True
    after = await asyncio.to_thread(refs.resolve, corpus, "board.jsonl#L3")
    assert "view" not in after, "with the view gone the file ref reads as the file"
    with pytest.raises(refs.RefError):
        await asyncio.to_thread(refs.resolve, corpus, "view:threads/t1")
    with pytest.raises(refs.RefError):
        await asyncio.to_thread(refs.resolve, corpus, "view:nothing")


async def test_a_quote_is_found_in_a_views_unit_and_the_view_ref_is_kept(ws, inproc, bound):
    """A quote cited into `view:<slug>/<key>` is looked up in the excerpt the view's reader gives, and the view ref is
    kept, so the example opens in the view at that unit; a whole file is searched line by line for the span."""
    corpus = config.corpus_dir(CORPUS)
    kept = await asyncio.to_thread(refs.span_of_quote, corpus, "view:threads/t2", "the build is  3316")
    assert kept == "view:threads/t2"
    with pytest.raises(refs.RefError) as e:
        await asyncio.to_thread(refs.span_of_quote, corpus, "view:threads/t2", "4127 tests pass")
    assert e.value.status == 404, "a quote of another thread is not in this one"
    # a view whose excerpt of a thread is its first post alone: a later post is found in the lines the unit stands for
    first_only = THREADS_READER.replace('"\\n".join(b for _, _, _, b in posts)', "posts[0][3]")
    assert first_only != THREADS_READER
    views.write_view(CORPUS, "firsts", reader=first_only, html=THREADS_HTML, **dict(VIEW, name="Firsts", default=False))
    assert (await asyncio.to_thread(refs.resolve, corpus, "view:firsts/t1"))["excerpt"].startswith("The release branch")
    by_line = await asyncio.to_thread(refs.span_of_quote, corpus, "view:firsts/t1", "tagging the release now")
    assert by_line == "view:firsts/t1"
    span =await asyncio.to_thread(refs.span_of_quote, corpus, "board.jsonl", "4127 tests pass")
    assert re.fullmatch(r"board\.jsonl#L3\.b\d+:c\d+-\d+", span), span
    assert refs.resolve_base(corpus, span)["excerpt"] == "4127 tests pass"
    with pytest.raises(refs.RefError):
        await asyncio.to_thread(refs.span_of_quote, corpus, "board.jsonl", "not on the board")


async def test_an_example_card_takes_a_quote_in_a_views_unit(ws, inproc, bound):
    """add_card runs on the server's loop, and the view's reader answers on the same loop, so the quote in a view ref
    is resolved off the loop first (tools._warm_view_refs) rather than refused as a quote that is not there."""
    from app import notebook, tools

    group = notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]
    r = await tools.call(CORPUS, "add_card", {"kind": "example", "question": "Which build?",
                                              "refs": [{"ref": "view:threads/t2", "quote": "The build is 3316."}]},
                         actor="analyst", notebook=group, terminal=False)
    assert not r.is_error, r.text
    cid = next(m.group(1) for ln in r.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", ln.strip())))
    assert notebook.get_cell(CORPUS, cid)["payload"]["refs"] == ["view:threads/t2"]
    await notebook.shutdown_all()


async def test_a_thread_on_a_units_anchor_reads_it_on_its_first_event(ws, inproc, bound):
    """A thread's first event is built on the server's loop, where a view's reader cannot answer a cold ref; the
    create route resolves the anchor first (threads.warm), so the event carries the unit's text, not `could not
    resolve`."""
    from app import threads

    meta = {"anchor": "view:threads/t2,board.jsonl#L3"}
    cold = threads.content(CORPUS, meta)
    assert "could not resolve" in cold, "on the loop with nothing memoised the view ref goes without an answer"
    views._memo.clear()
    await threads.warm(CORPUS, meta["anchor"])
    warm = threads.content(CORPUS, meta)
    assert "The build is 3316." in warm and "could not resolve" not in warm
    assert "Confirmed: 4127 tests pass." in warm


def test_the_gate_notes_a_page_that_anchors_few_of_the_records_it_fetched():
    """Labels are drawn over the elements whose data-anchor is a record's `<path>#L<n>`: a page that anchors fewer than
    one in ten of the record refs its fetches returned (a chart of 800 dots with 2 anchors) gets a note in the gate's
    lines, and passes."""
    base = {"ok": True, "view": None, "problems": [], "checks": []}
    page = {"ok": True, "errors": [], "fetches": 2, "refs": 3, "records": 2, "fetched_records": 800}
    assert "note: " + views._hint("view-no-record-anchors", fetched=800, records=2) in views.gate_lines({**base, "page": page})
    assert views.first_failure({**base, "page": page}) == ""
    marked = views.gate_lines({**base, "page": {**page, "records": 120}})
    assert not any(ln.startswith("note: ") for ln in marked)
    idle = views.gate_lines({**base, "page": {**page, "records": 0, "fetched_records": 0}})
    assert not any(ln.startswith("note: ") for ln in idle), "a page that fetched no records needs no record anchors"


async def test_a_page_no_label_can_show_in_fails_the_gate_and_unit_anchors_pass_it(ws, inproc, bound, tmp_path):
    """The gate shoots the overview and the first place with the test label on. A page over files with lines that
    anchors no record and no unit fails with view-no-anchors; the same page anchoring its thread as a unit passes, with
    the note that it anchors few of the records it fetched."""
    if why := views.build_problem():
        pytest.skip(why)
    rep = await views.check(CORPUS, "threads", ["view:threads/t1"], shot_dir=tmp_path)
    assert not rep["ok"] and views._hint("view-no-anchors", slug="threads") in rep["problems"]
    assert [s["state"] for s in rep["shots"]] == ["overview", "detail"] and all(Path(s["png"]).is_file() for s in rep["shots"])
    assert views.first_failure(rep).startswith("problem: The page shows no element")
    unit = THREADS_HTML.replace("document.getElementById('out').textContent =",
                                "document.getElementById('out').dataset.anchor = 'view:threads/' + t\n  document.getElementById('out').textContent =")
    views.write_view(CORPUS, "threads", reader=THREADS_READER, html=unit, **VIEW)
    rep = await views.check(CORPUS, "threads", ["view:threads/t1"], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    assert all(s["units"] == 1 and s["records"] == 0 and s["fonts"] for s in rep["shots"])
    lines = views.gate_lines(rep)
    assert "page: overview, 0 records and 1 units anchored, 0 marked by the test label" in lines
    assert sum(ln.startswith("png: ") for ln in lines) == 2 and any(ln.startswith("note: ") for ln in lines)


def test_the_frame_document_blocks_every_host_before_any_script(ws):
    doc = views.frame_document(views.read_view(CORPUS, "threads"))
    assert doc.lower().startswith("<!doctype html>")
    csp = doc.index("Content-Security-Policy")
    assert csp < doc.index("<script") and "default-src 'none'" in doc and "connect-src 'none'" in doc
    assert "window.thimble" in doc and '"slug": "threads"' in doc
    v = dict(views.read_view(CORPUS, "threads"), libs=views._libs(["vega-embed"]))
    with_libs = views.frame_document(v)
    if views.LIBS["vega"].is_file():
        assert with_libs.count("<script>") == 6, "the view's name, the bridge, vega, vega-lite, vega-embed and the view's own"
    assert views._script_text("a</script>b") == "a<\\/script>b"
    assert views._libs(["vega-embed"]) == ["vega", "vega-lite", "vega-embed"]


def test_the_frame_document_gives_the_view_thimble_s_parts_before_its_own_styles(ws):
    doc = views.frame_document(views.read_view(CORPUS, "threads"))
    kit = doc.index(".seg-opt.active")
    assert doc.index("window.thimble") < kit < doc.index("body{font:13px sans-serif}")
    for part in (".chip", ".btn", ".seg", ".field", ".table", ".list-row"):
        assert f"\n{part} {{" in doc, part


needs_browser = pytest.mark.skipif(shutil.which("node") is None or not (config.REPO_ROOT / "frontend" / "node_modules" / "playwright").is_dir(),
                                   reason="the headless page load needs node and frontend/node_modules/playwright")


@pytest.fixture()
def app() -> FastAPI:
    a = FastAPI()
    a.include_router(views.router, prefix="/api")
    return a


@pytest.fixture()
async def client(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=120) as c:
        yield c


async def test_a_message_typed_in_a_view_builds_thread_goes_to_that_build_as_a_change(ws, client, monkeypatch):
    """The composer of a view build's thread sends to that build: the message is the analyst's in the build's thread,
    and a change to the view, asked for, is queued for the same proposal, whose run goes on in that thread. An empty
    message and a view that does not exist are refused."""
    from app import agents, dev

    queued: list[str] = []
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: queued.append(slug))
    monkeypatch.setattr(dev, "stop_view", lambda c, slug, why: False)
    views.propose(CORPUS, "Threads", "w", ["board.jsonl"], "by thread")
    chat = agents.new_agent(CORPUS, "dev", "view: Threads", view="threads", announce=False)["id"]
    views.update_proposal(CORPUS, "threads", chat=chat, status="built")
    queued.clear()
    r = await client.post(f"/api/ws/{CORPUS}/views/proposals/threads/message", json={"text": "  Newest thread first  "})
    assert r.status_code == 200, r.text
    prop = r.json()
    assert (prop["status"], prop["change"], prop["changed"], prop["asked"], prop["chat"]) == ("queued", "Newest thread first", True, True, chat)
    assert queued == ["threads"]
    log = agents.read_events(agents.paths(CORPUS, chat)[1])
    assert [(e["type"], e.get("text"), e.get("by")) for e in log] == [("user", "Newest thread first", "browser")]
    assert (await client.post(f"/api/ws/{CORPUS}/views/proposals/threads/message", json={"text": " "})).status_code == 400
    assert (await client.post(f"/api/ws/{CORPUS}/views/proposals/nope/message", json={"text": "x"})).status_code == 404


CLIP = bytes(range(256)) * 4  # 1,024 bytes, each byte's value its offset mod 256, so a range's bytes name where it is
PATHS_READER = """
def build_index(paths):
    return {"paths": list(paths)}


def records(index, query):
    return index["paths"]


def resolve(index, locator):
    return None
"""


@pytest.fixture()
def clips(ws, data, tmp_path) -> Path:
    """The view `clips` over `clips/*` (a video, a text file and a dot-file under it), beside `secret.mp4`, which it does
    not claim, and `clips/out.mp4`, a symlink to a file outside the corpus."""
    corpus = data / CORPUS
    (corpus / "clips").mkdir()
    (corpus / "clips" / "a.mp4").write_bytes(CLIP)
    (corpus / "clips" / "notes.txt").write_text("not media\n")
    (corpus / "clips" / ".hidden.mp4").write_bytes(CLIP)
    (corpus / "secret.mp4").write_bytes(CLIP)
    (tmp_path / "outside.mp4").write_bytes(CLIP)
    (corpus / "clips" / "out.mp4").symlink_to(tmp_path / "outside.mp4")
    views.write_view(CORPUS, "clips", reader=PATHS_READER, html=THREADS_HTML,
                     **dict(VIEW, name="Clips", claims=["clips/*"], default=False))
    return corpus


async def test_the_media_route_streams_a_claimed_file_with_range_requests(clips, client):
    url = f"/api/ws/{CORPUS}/views/clips/media"
    whole = await client.get(url, params={"path": "clips/a.mp4"})
    assert whole.status_code == 200 and whole.content == CLIP
    assert whole.headers["content-type"] == "video/mp4" and whole.headers["accept-ranges"] == "bytes"
    assert whole.headers["x-content-type-options"] == "nosniff" and "sandbox" in whole.headers["content-security-policy"]
    part = await client.get(url, params={"path": "clips/a.mp4"}, headers={"Range": "bytes=300-309"})
    assert part.status_code == 206 and part.headers["content-range"] == "bytes 300-309/1024"
    assert part.content == bytes(range(44, 54)), "bytes 300 to 309 of the file"
    tail = await client.get(url, params={"path": "clips/a.mp4"}, headers={"Range": "bytes=1000-"})
    assert tail.status_code == 206 and tail.headers["content-range"] == "bytes 1000-1023/1024" and len(tail.content) == 24
    last = await client.get(url, params={"path": "clips/a.mp4"}, headers={"Range": "bytes=-4"})
    assert last.status_code == 206 and last.content == bytes([252, 253, 254, 255])
    past = await client.get(url, params={"path": "clips/a.mp4"}, headers={"Range": "bytes=5000-6000"})
    assert past.status_code == 416 and past.headers["content-range"] == "bytes */1024"


async def test_the_media_route_serves_only_media_files_the_view_claims_inside_the_corpus(clips, client):
    url = f"/api/ws/{CORPUS}/views/clips/media"
    refused = {
        "secret.mp4": 403,  # in the corpus, not claimed
        "clips/../secret.mp4": 400,  # matches the claim's glob by its text, names another file
        "clips/./a.mp4": 400,
        "clips//a.mp4": 400,
        "/etc/passwd": 400,
        "clips\\a.mp4": 400,
        "clips/.hidden.mp4": 400,  # a dot-file, which no claim's glob matches
        "clips/notes.txt": 415,  # claimed, not media
        "clips/out.mp4": 404,  # a symlink out of the corpus
        "clips/missing.mp4": 404,
        "": 400,
    }
    for path, status in refused.items():
        r = await client.get(url, params={"path": path})
        assert r.status_code == status, (path, r.status_code, r.text)
    assert (await client.get(f"/api/ws/{CORPUS}/views/nope/media", params={"path": "clips/a.mp4"})).status_code == 404
    assert (await client.get(f"/api/ws/{CORPUS}/views/threads/media", params={"path": "clips/a.mp4"})).status_code == 403
    with pytest.raises(HTTPException) as e:
        views.media_file(CORPUS, "clips", "secret.mp4")
    assert "does not claim secret.mp4" in e.value.detail


async def test_the_frame_policy_allows_the_views_media_route_at_the_pages_origin(clips, client):
    url = f"/api/ws/{CORPUS}/views/clips/frame"
    doc = (await client.get(url, params={"origin": "http://localhost:5300"})).text
    route = f"http://localhost:5300/api/ws/{CORPUS}/views/clips/media"
    assert f"media-src data: blob: {route};" in doc and f"img-src data: blob: {route};" in doc
    assert "connect-src 'none'" in doc and f'"media": "{route}"' in doc and "mediaUrl" in doc
    assert f"media-src data: blob: http://t/api/ws/{CORPUS}/views/clips/media;" in (await client.get(url)).text, \
        "without an origin, the request's own host"
    for bad in ("javascript:alert(1)", "http://h; script-src *", "http://h/path", "http://h:80\n", "file://x"):
        assert (await client.get(url, params={"origin": bad})).status_code == 400, bad
    assert "media-src data: blob:;" in views.frame_document(views.read_view(CORPUS, "clips")), "no route, no URL"


PLAYER_HTML = """<!doctype html><html><head></head><body><audio id="a" controls></audio><div id="d"></div><script>
const a = document.getElementById('a')
a.addEventListener('loadedmetadata', () => { document.getElementById('d').textContent = 'duration ' + a.duration; thimble.fetch({ duration: a.duration }) })
a.addEventListener('error', () => { throw new Error('the audio did not load') })
a.src = thimble.mediaUrl(SRC)
thimble.onOpen(() => {})
</script></body></html>"""


def _workbook(path: Path) -> None:
    import openpyxl

    wb = openpyxl.Workbook()
    wb.active.title = "Q2"
    wb.active.append(["dept", "travel"])
    q3 = wb.create_sheet("Q3")
    q3.append(["dept", "item", "", "amount"])
    for i in range(2, 20):
        q3.append([f"Dept {i}", "Travel", "", 1000 * i + (200 if i == 17 else 0)])
    wb.save(path)


def _pdf(path: Path, pages: list[list[str]]) -> None:
    """A PDF with one Helvetica text line per string, written by hand (no writer library is installed)."""
    objs: list[bytes] = [b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    pages_id = 1 + 2 * len(pages) + 1
    kids = []
    for lines in pages:
        body = b"BT /F1 12 Tf 72 720 Td 16 TL " + b" ".join(b"(" + ln.encode() + b") '" for ln in lines) + b" ET"
        objs.append(b"<< /Length %d >>\nstream\n" % len(body) + body + b"\nendstream")
        objs.append(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 1 0 R >> >> >>"
                    % (pages_id, len(objs)))
        kids.append(len(objs))
    objs.append(b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % k for k in kids) + b"] /Count %d >>" % len(kids))
    objs.append(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)
    out, offs = bytearray(b"%PDF-1.4\n"), []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, len(objs), xref)
    path.write_bytes(bytes(out))


@pytest.fixture()
async def docs(data, workspaces_tmp) -> Path:
    corpus = config.corpus_dir(CORPUS)
    _workbook(corpus / "budget.xlsx")
    _pdf(corpus / "policy.pdf", [["Travel policy"], ["Section 2. Claims", "Receipts are filed within a 30-day limit."]])
    return corpus


async def test_the_built_in_viewers_open_workbooks_and_pdfs_in_every_workspace(docs, inproc, bound):
    listed = {v["slug"]: v for v in views.list_views(CORPUS)}
    assert listed["spreadsheet"]["origin"] == listed["pdf"]["origin"] == "builtin"
    assert [v["slug"] for v in views.views_for(CORPUS, "budget.xlsx", "Q3!D17")] == ["spreadsheet"]
    assert [v["slug"] for v in views.views_for(CORPUS, "policy.pdf", "p2")] == ["pdf"]
    cell = await asyncio.to_thread(refs.resolve, docs, "budget.xlsx#Q3!D17")
    assert cell["excerpt"] == "17200" and cell["view"]["label"] == "Q3!D17 = 17200"
    page = await asyncio.to_thread(refs.resolve, docs, "policy.pdf#p2")
    assert "30-day limit" in page["excerpt"] and page["view"]["label"] == "p. 2"
    assert await verify._ref_check(docs, "budget.xlsx#Q3!D17", "17200") is None
    assert await verify._ref_check(docs, "policy.pdf#p2", "30-day") is None
    assert await verify._ref_check(docs, "policy.pdf#p2", "60-day") == verify.WHY_VALUE
    # a built-in viewer's index is cached under the workspace, never in thimble's own folder
    assert list((config.workspace_dir(CORPUS) / "views" / views.BUILTIN_CACHE / "spreadsheet").glob("*.index.pickle"))
    assert not list((views.VIEWERS_DIR / "spreadsheet").glob("cache"))
    # their forms reach the citation prompt only where the corpus holds their files
    forms = views.forms_text(CORPUS)
    assert "<file>#<Sheet>!<A1>" in forms and "<file>#p<n>" in forms


async def test_a_corpus_view_over_the_same_files_opens_before_the_built_in_one(docs, inproc):
    views.write_view(CORPUS, "budget", reader=THREADS_READER, html=THREADS_HTML,
                     **dict(VIEW, name="Budget", claims=["budget.xlsx"], accepts=[{"form": "<Sheet>!<A1>", "means": "a cell"}], default=False))
    assert [v["slug"] for v in views.views_for(CORPUS, "budget.xlsx", "Q3!D17")] == ["budget", "spreadsheet"]
    assert "<file>#p<n>" not in views.forms_text(None)


# ------------------------------------------------------------------------------------------------- worked examples
#
# plugin/viewers/linked-sessions, incident-timeline and repository are the worked examples a view ticket's session
# reads (prompts/dev-view.md). Each ships an invented sample of the files it claims under sample/, and passes over it
# the checks a view a session writes must pass. Each sample is copied into the temp DATA_DIR as a corpus named after
# its example.

# the example, the slug it is saved under, and a key of each kind it declares
EXAMPLES = {
    "incident-timeline": ("incident-timeline", ["view:incident-timeline/INC-312",
                                                "view:incident-timeline/2026-05-16T08:00..2026-05-16T09:00"]),
    "repository": ("repository", ["view:repository/r1/pull/11", "view:repository/r3", "view:repository/r2/issues/6",
                                  "view:repository/r3/discussions/2", "view:repository/r4/agents/moss"]),
    "linked-sessions": ("linked-sessions", ["view:linked-sessions/r1", "view:linked-sessions/r1-client-port"]),
}


@pytest.fixture()
def samples(workspaces_tmp, tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data"
    for name in EXAMPLES:
        shutil.copytree(views.EXAMPLES_DIR / name / "sample", d / name)
        (d / name / "manifest.json").write_text(json.dumps({"name": name, "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d.resolve()


def _save_example(name: str) -> str:
    """Save the worked example `name` as a view of its sample, as a session writes one; returns its slug."""
    d = views.EXAMPLES_DIR / name
    raw = json.loads((d / "view.json").read_text("utf-8"))
    slug = EXAMPLES[name][0]
    views.write_view(name, slug, reader=(d / "reader.py").read_text("utf-8"), html=(d / "view.html").read_text("utf-8"),
                     **{k: raw[k] for k in ("name", "why", "claims", "accepts", "declares", "default", "libs")})
    return slug


@pytest.mark.parametrize("name", sorted(EXAMPLES))
async def test_every_worked_example_answers_the_checks_over_its_sample(name, samples, inproc, bound, tmp_path, monkeypatch):
    """The reader's half of the checks: the index builds, the sampled lines and the declared keys resolve, each answer
    cites its place back, and every excerpt is literal text of the records it cites. The page's half is a test below."""
    async def no_page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 0, "records": 1} for _ in states]

    monkeypatch.setattr(views, "shoot_states", no_page)
    slug = _save_example(name)
    rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    checked = [r["locator"] for r in rep["checks"]]
    assert set(EXAMPLES[name][1]) <= set(checked)
    assert any(re.search(r"#L\d+$", c) for c in checked), "sampled lines were checked beside the keys"


def test_each_worked_example_describes_its_files():
    """A builder maps an example onto other data by what its files hold: view.json's `data` and the reader's opening
    comment name each claimed file and each field of its records, and the sample holds those files."""
    for name in EXAMPLES:
        d = views.EXAMPLES_DIR / name
        raw = json.loads((d / "view.json").read_text("utf-8"))
        comment = (d / "reader.py").read_text("utf-8").split("\nimport ", 1)[0]
        for claim in raw["claims"]:
            assert (d / "sample" / claim).is_file(), (name, claim)
            fields = set().union(*(json.loads(ln) for ln in (d / "sample" / claim).read_text("utf-8").splitlines()))
            assert claim in raw["data"] and claim in comment, (name, claim)
            for field in fields:
                assert f"`{field}`" in raw["data"] and re.search(rf"^#   {field} ", comment, re.M), (name, claim, field)


async def test_the_incident_timeline_example_puts_every_source_on_one_axis_and_gathers_its_units(samples, inproc,
                                                                                                    bound):
    """The overview sends every record of the five sources in time order, with each field's values named, and while a
    label is on its values with each record's marks; a line opens in its incident, a record's details name the record
    it answers, an incident cites its records in time order, and a window cites the records inside it."""
    name = "incident-timeline"
    slug = _save_example(name)
    rows = [json.loads(ln) for ln in (samples / name / "events.jsonl").read_text("utf-8").splitlines()]
    over = await views.reader_call(name, slug, "records", {"op": "overview"})
    cols, names = over["cols"], over["names"]
    assert len(cols["r"]) == len(rows) and cols["t"] == sorted(cols["t"])
    assert {names["source"][v] for v in cols["source"]} == {r["source"] for r in rows}
    assert over["marks"] == [] and set(cols["m"]) == {-1}
    probed = await views.reader_call(name, slug, "records", {"op": "overview"}, labels=views.probe_context())
    assert len(probed["marks"]) == 1, "the label that is on lists its value, the colour the page draws it in"
    assert set(probed["cols"]["m"]) == {-1, 0} and probed["cols"]["mb"] == [m + 1 for m in probed["cols"]["m"]]
    one = await views.resolve_locator(name, slug, {"path": "events.jsonl", "fragment": "L1"})
    assert one["excerpt"] == rows[0]["text"] and one["key"] == rows[0]["incident"]
    child = next(n for n, r in enumerate(rows, 1) if r.get("re"))
    parent = next(n for n, r in enumerate(rows, 1) if r["id"] == rows[child - 1]["re"])
    rec = await views.reader_call(name, slug, "records", {"op": "record", "r": cols["r"][cols["ln"].index(child)]})
    assert rec["answers"]["ref"] == f"events.jsonl#L{parent}"
    order = sorted(range(1, len(rows) + 1), key=lambda n: (views_time(rows[n - 1]["at"]), n))
    incident = await views.resolve_locator(name, slug, {"key": "INC-312"})
    assert incident["refs"] == [f"events.jsonl#L{n}" for n in order if rows[n - 1].get("incident") == "INC-312"]
    window = await views.resolve_locator(name, slug, {"key": "2026-05-16T08:00..2026-05-16T09:00"})
    a, b = views_time("2026-05-16T08:00:00Z"), views_time("2026-05-16T09:00:00Z")
    assert len(window["refs"]) == sum(a <= views_time(r["at"]) < b for r in rows) > 0


async def test_the_repository_example_compares_any_runs_and_filters_by_who_did_what(samples, inproc, bound):
    """Every run has a row of measures with its setup; choosing runs narrows the list to them and keeps every run's row,
    the compare grid lines the runs up issue by issue, and a record filter keeps the units with a record it picks."""
    name = "repository"
    slug = _save_example(name)
    rows = [json.loads(ln) for ln in (samples / name / "repo.jsonl").read_text("utf-8").splitlines()]
    setups = {r["run"]: (r["team"], r["approvals"]) for r in rows if r["kind"] == "run"}
    pulls = await views.reader_call(name, slug, "records", {"op": "view", "tab": "pulls"})
    assert {r["run"]: (r["team"], r["approvals"]) for r in pulls["runs"]} == setups
    assert pulls["total"] == len({(r["run"], r["number"]) for r in rows if r["kind"] == "pr"})
    two = await views.reader_call(name, slug, "records", {"op": "view", "tab": "pulls", "runs": ["r2", "r4"]})
    assert {i["run"] for i in two["items"]} == {"r2", "r4"}
    assert {r["run"]: r["chosen"] for r in two["runs"]} == {"r1": False, "r2": True, "r3": False, "r4": True}
    grid = (await views.reader_call(name, slug, "records", {"op": "view", "tab": "issues", "compare": True}))["grid"]
    backlog = {r["number"] for r in rows if r["kind"] == "issue" and r["run"] == "r1" and r["at"] == rows[0]["at"]}
    assert backlog and all(set(g["cells"]) == set(setups) for g in grid if g["number"] in backlog)
    query = {"op": "view", "tab": "pulls", "filters": {"actor": "moss", "action": "approved"}}
    approved = await views.reader_call(name, slug, "records", query)
    assert {(i["run"], i["number"]) for i in approved["items"]} == {
        (r["run"], r["number"]) for r in rows if r["kind"] == "review" and r["author"] == "moss"
        and r["verdict"] == "approved"} != set()


async def test_the_linked_sessions_example_lays_each_run_out_as_a_tree_and_compares_sessions(samples, inproc, bound):
    """Each run's sessions come in tree order, a subagent after the session that spawned it, and every call is counted
    once; a field filter's counts hold every other filter; a session's transcript holds its messages, its calls and its
    subagents' returns; and a comparison counts each group's calls, a session's subagents included."""
    slug = _save_example("linked-sessions")
    d = samples / "linked-sessions"
    sessions = [json.loads(ln) for ln in (d / "sessions.jsonl").read_text("utf-8").splitlines()]
    calls = [json.loads(ln) for ln in (d / "calls.jsonl").read_text("utf-8").splitlines()]
    ov = await views.reader_call("linked-sessions", slug, "records", {"op": "overview"})
    assert len(ov["calls"]) == ov["total"] == len(calls) and len(ov["sessions"]) == len(sessions)
    seen = set()
    for s in ov["sessions"]:
        assert s["parent"] is None or s["parent"] in seen, "a subagent comes after the session that spawned it"
        seen.add(s["id"])
    errors = await views.reader_call("linked-sessions", slug, "records", {"op": "overview", "filters": {"outcome": ["ok", "denied"]}})
    assert {c["out"] for c in errors["calls"]} == {"error"}
    assert sum(x["n"] for x in errors["fields"]["outcome"]) == len(calls), "the outcome's own counts leave its filter out"
    assert sum(x["n"] for x in errors["fields"]["tool"]) == len(errors["calls"])
    lead = next(s for s in sessions if s["run"] == "r1" and s["parent"] is None)
    t = await views.reader_call("linked-sessions", slug, "records", {"op": "session", "id": lead["id"]})
    kids = {s["id"] for s in sessions if s["parent"] == lead["id"]}
    assert {i["child"] for i in t["items"] if i["kind"] == "return"} == kids
    assert t["items"][0]["kind"] == "prompt" and sum(i["kind"] == "call" for i in t["items"]) == t["n"]
    port = next(s for s in sessions if s["run"] == "r1" and s["agent"] == "client-port")
    both = await views.reader_call("linked-sessions", slug, "records", {"op": "compare", "ids": [port["id"], "r2"], "subs": True})
    mine = {port["id"]} | {s["id"] for s in sessions if s["parent"] == port["id"]}
    assert both["groups"][0]["n"] == sum(1 for c in calls if c["session"] in mine)
    assert both["groups"][1]["n"] == sum(1 for c in calls if next(s for s in sessions if s["id"] == c["session"])["run"] == "r2")


@pytest.mark.parametrize("name", sorted(EXAMPLES))
async def test_every_worked_example_s_page_loads_headless_at_its_first_place(name, samples, inproc, bound, tmp_path):
    """The whole check a view ticket's session runs, the headless page included, where this machine has Node and the
    frontend's packages with their Chromium (scripts/check.sh install)."""
    if why := views.build_problem():
        pytest.skip(why)
    slug = _save_example(name)
    rep = await views.check(name, slug, EXAMPLES[name][1], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    assert rep["page"]["fetches"] >= 1 and Path(rep["page"]["png"]).is_file()
    assert not views.unmarked(rep["page"]), "the records a worked example shows carry their file refs, for the labels"


def views_time(ts: str) -> float:
    t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()


@pytest.mark.parametrize("name", sorted(EXAMPLES))
async def test_the_review_shoots_four_states_in_thimble_s_fonts_with_the_test_label(name, samples, inproc, bound):
    """The review's pictures of a worked example: no label, the test label on, filtered to it, and the detail, each in
    Hanken Grotesk, the test label marking records in the second and the filter keeping fewer in the third, with no
    label control and no pill the page drew itself."""
    if why := views.build_problem():
        pytest.skip(why)
    from app import view_review

    slug = _save_example(name)
    view = views.read_view(name, slug)
    files = views.claimed_files(name, view)
    shots = await view_review.shoot(name, slug, view, files, {}, True, 0)
    assert [s["state"] for s in shots] == list(view_review.LINED_STATES)
    assert all(s["ok"] and s["fonts"] and Path(s["png"]).is_file() for s in shots), [s.get("errors") for s in shots]
    assert shots[0]["marked"] == 0 and shots[1]["marked"] > 0
    assert shots[2]["records"] < shots[1]["records"] and shots[0]["answers"]
    assert not any(s["controls"] or s["pills"] for s in shots)
